#!/usr/bin/env node
// Access, Cloud and self-hosted passkey sign-in are exclusive; each keeps DSH behind the gate.
import { accessConfig, AccessConfigurationError, AccessSignIn } from './gate-access.mjs'
import { cloudConfig, CloudConfigurationError, CloudSignIn } from './gate-cloud.mjs'
import { createGate, pinOrigin } from './gate.mjs'
import { writeFileSync } from 'node:fs'
import { callerKeyDirectories, createSigner, instanceOf } from './gate-caller.mjs'
import { multiuserMode } from './profile-multiuser.mjs'
import { controlServer } from './gate-control.mjs'
import { readOwner, SessionStore } from './gate-store.mjs'
import { DshCredentials, DSH_HOST } from './gate-upstream.mjs'

let claimErrors, control, server, bootstrap
try {
  const config = accessConfig(process.env)
  const cloudSettings = cloudConfig(process.env)
  if (config && cloudSettings) throw new CloudConfigurationError('Configure Access or Cloud sign-in, not both')
  if (process.env.AUTOMAGIK_GATE_ENABLED !== '1') throw new Error('Gate disabled')
  let SelfHostedClaim, passkeyOrigin
  const claimMode = !config && !cloudSettings
  if (claimMode) { ({ SelfHostedClaim, passkeyOrigin, ClaimConfigurationError: claimErrors } = await import('./gate-claim.mjs')) }
  const origin = claimMode ? passkeyOrigin(process.env.AUTOMAGIK_GATE_ORIGIN) : pinOrigin(process.env.AUTOMAGIK_GATE_ORIGIN)
  const port = Number(process.env.AUTOMAGIK_GATE_PORT || 3082)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3081) throw new Error('Invalid gate port')
  const dir = process.env.AUTOMAGIK_GATE_HOME || '/data'
  // Cloud sessions live in memory only, each ending with its workspace token: a restart or an
  // expiry sends the person back through the rail. Cloud mode reads no owner record.
  const cloud = cloudSettings ? new CloudSignIn(cloudSettings) : undefined
  const owner = cloud ? undefined : readOwner(dir)
  const sessions = cloud ? new SessionStore(dir, { memory: true, accepts: cloud.accepts }) : new SessionStore(dir)
  // No owner means no session. Unknown owner formats already stopped startup above.
  if (!cloud && !owner) sessions.revokeAll()
  const mode = multiuserMode(process.env.AUTOMAGIK_GATE_MULTIUSER)
  if (mode === 'invalid') throw new Error('Invalid gate multiuser value')
  const multiuser = mode === 'on'
  let caller
  if (multiuser) {
    const paths = callerKeyDirectories(dir, process.env.AUTOMAGIK_GATE_CALLER_PUBLIC)
    caller = createSigner({ ...paths, instance: () => instanceOf({ env: process.env, dir: paths.dir }) })
    caller.publish()
  }
  const credentials = new DshCredentials()
  const access = config ? new AccessSignIn(config, { ownerDir: dir }) : undefined
  const selfHosted = !claimMode ? undefined : new SelfHostedClaim({ dir, origin: origin.origin, sessions, clearOnSignIn: multiuser, claimMode: process.env.AUTOMAGIK_GATE_CLAIM ?? 'local' })
  const published = process.env.AUTOMAGIK_GATE_HOST || DSH_HOST
  if (claimMode && ![DSH_HOST, '0.0.0.0'].includes(published)) throw new claimErrors('AUTOMAGIK_GATE_HOST must be loopback or the IPv4 wildcard bind address')
  server = createGate({ origin: origin.origin, sessions, credentials, access, cloud, selfHosted, multiuser, caller })
  if (selfHosted) {
    if (selfHosted.claimMode === 'local') {
      const bootstrapPort = Number(process.env.AUTOMAGIK_GATE_BOOTSTRAP_PORT || 3083)
      if (!Number.isInteger(bootstrapPort) || bootstrapPort < 1 || bootstrapPort > 65535 || [3081, port].includes(bootstrapPort)) {
        throw new claimErrors('AUTOMAGIK_GATE_BOOTSTRAP_PORT must be a separate valid port, never the DSH or main gate port')
      }
      bootstrap = createGate({ origin: origin.origin, sessions, credentials, selfHosted, multiuser, caller, bootstrap: true })
      await new Promise((resolve, reject) => {
        bootstrap.once('error', reject)
        bootstrap.listen(bootstrapPort, DSH_HOST, resolve)
      })
      bootstrap.on('error', () => { console.error('automagik-gate: bootstrap listener failed'); process.exit(1) })
    }
    control = await controlServer(selfHosted)
    selfHosted.bindingChange = async (claimed, drop) => {
      if (drop) bootstrap?.closeAllConnections()
      try { await server.rebind(port, () => selfHosted.claimed ? published : DSH_HOST, drop) }
      catch { console.error('automagik-gate: listener failed'); process.exit(1) }
    }
    await selfHosted.start({ interactive: process.env.AUTOMAGIK_GATE_IMAGE !== '1' && Boolean(process.stdin.isTTY && process.stdout.isTTY),
      show: code => writeFileSync('/dev/tty', `Automagik claim code: ${code}\n`) })
  }
  server.listen(port, selfHosted?.claimed ? published : DSH_HOST, () => console.log('automagik-gate: listening on loopback or claimed address'))
  server.on('error', () => { console.error('automagik-gate: listener failed'); process.exitCode = 1 })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { control?.close(); bootstrap?.closeGate(); server.closeGate() })
} catch (error) {
  control?.close()
  bootstrap?.closeGate()
  server?.closeGate()
  // Never echo config, credentials, a URL, an owner record or a session into container logs.
  console.error(error instanceof AccessConfigurationError || error instanceof CloudConfigurationError || (claimErrors && error instanceof claimErrors)
    ? `automagik-gate: ${error.message}`
    : 'automagik-gate: disabled or invalid configuration/state; see server/README.md')
  process.exitCode = 1
}
