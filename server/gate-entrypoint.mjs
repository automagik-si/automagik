#!/usr/bin/env node
// Access, Cloud and self-hosted passkey sign-in are exclusive; each keeps DSH behind the gate.
import { accessConfig, AccessConfigurationError, AccessSignIn } from './gate-access.mjs'
import { cloudConfig, CloudConfigurationError, CloudSignIn } from './gate-cloud.mjs'
import { createGate, pinOrigin } from './gate.mjs'
import { writeFileSync } from 'node:fs'
import { callerKeyDirectories, createSigner, instanceOf } from './gate-caller.mjs'
import { createDecisionServer } from './gate-decisions.mjs'
import { multiuserMode } from './profile-multiuser.mjs'
import { controlServer } from './gate-control.mjs'
import { readOwner, SessionStore } from './gate-store.mjs'
import { DshCredentials, DSH_HOST } from './gate-upstream.mjs'

let claimErrors, control, server, bootstrap, decisions, stopping
const shutdown = () => stopping ??= Promise.all([
  control?.close(), bootstrap?.closeGate(), server?.closeGate(), decisions?.closeDecision(),
])
const listenerFailed = () => {
  if (stopping) return stopping
  console.error('automagik-gate: listener failed')
  process.exitCode = 1
  return shutdown()
}
const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, () => { server.off('error', reject); resolve() })
})
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
  const successors = new Map()
  let caller
  if (multiuser) {
    const paths = callerKeyDirectories(dir, process.env.AUTOMAGIK_GATE_CALLER_PUBLIC)
    caller = createSigner({ ...paths, instance: () => instanceOf({ env: process.env, dir: paths.dir }) })
    caller.publish()
    decisions = createDecisionServer({ origin: origin.origin, sessions, cloud, successors,
      signer: caller })
  }
  const credentials = new DshCredentials()
  const access = config ? new AccessSignIn(config, { ownerDir: dir }) : undefined
  const selfHosted = !claimMode ? undefined : new SelfHostedClaim({ dir, origin: origin.origin, sessions, clearOnSignIn: multiuser, claimMode: process.env.AUTOMAGIK_GATE_CLAIM ?? 'local' })
  const published = process.env.AUTOMAGIK_GATE_HOST || DSH_HOST
  if (claimMode && ![DSH_HOST, '0.0.0.0'].includes(published)) throw new claimErrors('AUTOMAGIK_GATE_HOST must be loopback or the IPv4 wildcard bind address')
  server = createGate({ origin: origin.origin, sessions, credentials, access, cloud, selfHosted,
    multiuser, caller, successors })
  if (selfHosted) {
    if (selfHosted.claimMode === 'local') {
      const bootstrapPort = Number(process.env.AUTOMAGIK_GATE_BOOTSTRAP_PORT || 3083)
      if (!Number.isInteger(bootstrapPort) || bootstrapPort < 1 || bootstrapPort > 65535 || [3081, port].includes(bootstrapPort)) {
        throw new claimErrors('AUTOMAGIK_GATE_BOOTSTRAP_PORT must be a separate valid port, never the DSH or main gate port')
      }
      bootstrap = createGate({ origin: origin.origin, sessions, credentials, selfHosted, multiuser, caller, bootstrap: true })
      await listen(bootstrap, bootstrapPort, DSH_HOST)
      bootstrap.on('error', listenerFailed)
    }
    control = await controlServer(selfHosted)
    selfHosted.bindingChange = async (claimed, drop) => {
      if (stopping) return
      if (drop) bootstrap?.closeAllConnections()
      try { await server.rebind(port, () => selfHosted.claimed ? published : DSH_HOST, drop) }
      catch { await listenerFailed() }
    }
    await selfHosted.start({ interactive: process.env.AUTOMAGIK_GATE_IMAGE !== '1' && Boolean(process.stdin.isTTY && process.stdout.isTTY),
      show: code => writeFileSync('/dev/tty', `Automagik claim code: ${code}\n`) })
  }
  // Claim startup revokes persisted families when the configured origin changes.
  if (decisions && !stopping) {
    await decisions.start()
    decisions.on('error', listenerFailed)
  }
  // Handlers go in before the ready line: a signal right after it must not take the default action.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown)
  await listen(server, port, selfHosted?.claimed ? published : DSH_HOST)
  if (stopping) await server.closeGate()
  else {
    console.log('automagik-gate: listening on loopback or claimed address')
    server.on('error', listenerFailed)
  }
} catch (error) {
  await shutdown()
  // Never echo config, credentials, a URL, an owner record or a session into container logs.
  console.error(error instanceof AccessConfigurationError || error instanceof CloudConfigurationError || (claimErrors && error instanceof claimErrors)
    ? `automagik-gate: ${error.message}`
    : 'automagik-gate: disabled or invalid configuration/state; see server/README.md')
  process.exitCode = 1
}
