#!/usr/bin/env node
// The smoke that runs inside the built image: the four commands an operator expects on PATH
// (am, hc, pnpm, node), the shipped CLI store's install path without a download, the
// private core socket and the bundled am briefing. Run by server/smoke.mjs.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dryRunVendorClis } from './cli-store.mjs'
import { FIRST_BOOT_MARKER, installVendorClis } from './first-boot.mjs'
import { profileDirOf } from './lib.mjs'
import {
  HC_RUNTIME, HC_SESSION, HERDR_APP_HOME, HERDR_CORE_VERSION, PNPM_PATH, XDG_RUNTIME_DIR,
  herdrCoreSocket,
} from './toolchain.mjs'

const ROOT = '/opt/automagik'
const HOME = process.env.AUTOMAGIK_HOME || '/data'
const DSH_HOME = process.env.DSH_HOME || '/data/dsh'
const PROFILE = profileDirOf(DSH_HOME)
const VERSIONS = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'))

const say = (message) => console.log(`[in-image] ${message}`)
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const command = (file, args, options = {}) => execFileSync(file, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, ...options,
}).trim()
const versionIn = (text) => /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text)?.[1]

// The admission wrapper is the one path every pnpm call takes. Prove it can run before any
// long vendor wait; a broken wrapper must cost a preflight, not forty minutes.
const admissionVersion = command('/usr/local/bin/pnpm', ['--version'], { timeout: 30_000 })
check(/^\d+\.\d+\.\d+/.test(admissionVersion), `pnpm admission preflight failed: ${admissionVersion}`)
say(`pnpm admission preflight: ${admissionVersion}`)
const checkVersion = (label, output, expected) => {
  const actual = versionIn(output)
  check(actual, `${label} --version printed no version: ${output}`)
  if (expected) check(actual === expected, `${label} is ${actual}, not the image's ${expected}`)
  return actual
}

async function main() {
  // docker exec inherits the container-creation env, not the entrypoint's later mutations.
  // The image itself must name pnpm for ACP's CLI store: the dry run below injects it, so this
  // is the check that the built image still sets it.
  check(process.env.AUTOMAGIK_PNPM === PNPM_PATH, `AUTOMAGIK_PNPM is ${process.env.AUTOMAGIK_PNPM ?? 'unset'}, not ${PNPM_PATH}`)
  const coreSession = process.env.HC_SESSION || HC_SESSION
  const runtimeDir = process.env.XDG_RUNTIME_DIR || XDG_RUNTIME_DIR
  const coreSocket = herdrCoreSocket(coreSession, runtimeDir)
  process.env.HC_SOCKET = coreSocket
  process.env.HC_TERMINAL_SOCKET = coreSocket

  const am = checkVersion('am', command('am', ['--version']), VERSIONS.am?.version)
  const hc = checkVersion('hc', command('hc', ['--version']), VERSIONS.herdrCore?.version || HERDR_CORE_VERSION)
  checkVersion('herdr-core', command('herdr-core', ['--version']), VERSIONS.herdrCore?.version || HERDR_CORE_VERSION)
  const pnpm = checkVersion('pnpm', command('pnpm', ['--version']), String(VERSIONS.pnpm ?? ''))
  const node = command('node', ['--version'])
  check(/^v\d+\.\d+\.\d+/.test(node), `node --version printed ${node}`)
  check(node === process.version, `node on PATH is ${node}, this process is ${process.version}`)
  say(`am ${am}, hc ${hc}, herdr-core ${VERSIONS.herdrCore?.version || HERDR_CORE_VERSION}, pnpm ${pnpm}, node ${node}`)

  check(process.env.HERDR_APP_HOME === HERDR_APP_HOME, `HERDR_APP_HOME is ${process.env.HERDR_APP_HOME ?? 'unset'}, not ${HERDR_APP_HOME}`)
  const briefingLink = join(HERDR_APP_HOME, 'automagik-herdr', 'briefing.mjs')
  check(existsSync(briefingLink), `am self install did not create ${briefingLink}`)
  const marker = JSON.parse(readFileSync(join(HOME, FIRST_BOOT_MARKER), 'utf8'))
  check(marker.version === am, `first boot recorded am ${marker.version}, expected ${am}`)
  check(['installed', 'present'].includes(marker.amSelf), `am self install was ${marker.amSelf}`)
  check(command('/usr/bin/env', ['/bin/sh', '-c', 'printf env-ok']) === 'env-ok', '/usr/bin/env did not run /bin/sh')
  check(command('/usr/bin/printenv', ['PATH']).length > 0, 'printenv printed no PATH')

  // Every shipped pnpm entry reaches the same admission script, lock and owner log.
  const admissionOwner = 'smoke-admission'
  const admissionEnv = { ...process.env, AUTOMAGIK_PNPM_OWNER: admissionOwner }
  const pnpmCjs = '/opt/automagik/runtime/node_modules/pnpm/bin/pnpm.cjs'
  const pnpmCalls = [
    [pnpmCjs, ['--version']],
    ['/usr/local/bin/pnpm', ['--version']],
    ['/nodejs/bin/node', [pnpmCjs, '--version']],
  ]
  const profilePnpm = join(PROFILE, 'node_modules', '.bin', 'pnpm')
  if (existsSync(profilePnpm)) pnpmCalls.push([profilePnpm, ['--version']])
  const pnpmVersions = pnpmCalls.map(([file, args]) => command(file, args, { env: admissionEnv }))
  check(new Set(pnpmVersions).size === 1, `pnpm versions differ across entries: ${JSON.stringify(pnpmVersions)}`)
  const admissions = readFileSync('/data/run/pnpm-admission.log', 'utf8').split('\n').filter((line) => line.startsWith('admit ') && line.includes(`owner=${admissionOwner}`))
  check(admissions.length === pnpmCalls.length, `admission log has ${admissions.length} admits for ${pnpmCalls.length} calls`)
  say(`pnpm admission: ${pnpmCalls.length} entry paths, one owner and version ${pnpmVersions[0]}`)
  const admissionLog = () => readFileSync('/data/run/pnpm-admission.log', 'utf8')
  const countEvents = (event, owner) => admissionLog().split('\n').filter((line) => line.startsWith(event) && line.includes(`owner=${owner}`)).length
  const rowDir = mkdtempSync(join(tmpdir(), 'automagik-pnpm-admission-'))
  for (const code of [23, 137]) {
    const real = join(rowDir, `exit-${code}.mjs`)
    writeFileSync(real, `process.exit(${code})\n`)
    const failed = spawnSync('/bin/sh', ['/usr/local/bin/pnpm-admission', real], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, AUTOMAGIK_PNPM_OWNER: `smoke-exit-${code}` },
    })
    check(failed.status === code, `admission wrapper returned ${failed.status} for exit ${code}`)
    check(new RegExp(`failed .*owner=smoke-exit-${code} .*status=${code}`).test(admissionLog()), `admission failure for ${code} was not recorded`)
  }
  say('pnpm admission exit status: 23 and 137 propagate and are recorded')
  try {
    const outerReal = join(rowDir, 'outer.mjs')
    writeFileSync(outerReal, "import { execFileSync } from 'node:child_process'\nexecFileSync('/usr/local/bin/pnpm', ['--version'], { stdio: 'inherit', env: process.env })\n")
    command('/bin/sh', ['/usr/local/bin/pnpm-admission', outerReal], {
      env: { ...process.env, AUTOMAGIK_PNPM_OWNER: 'smoke-reentry' }, timeout: 30_000,
    })
    check(/reentry .*owner=smoke-reentry/.test(admissionLog()), 'the nested pnpm was serialized instead of re-entering')
    say('pnpm admission re-entry: the nested call finished under the holder token')

    const startHolder = (name, ms) => {
      const real = join(rowDir, `${name}.mjs`)
      writeFileSync(real, `setTimeout(() => {}, ${ms})\n`)
      const holder = spawn('/bin/sh', ['/usr/local/bin/pnpm-admission', real], {
        env: { ...process.env, AUTOMAGIK_PNPM_OWNER: name }, stdio: 'ignore',
      })
      let fields = {}
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const lines = readFileSync('/data/run/pnpm-admission.lock', 'utf8').split('\n')
          fields = Object.fromEntries((lines[0] ?? '').split(' ').filter(Boolean).map((kv) => {
            const at = kv.indexOf('=')
            return [kv.slice(0, at), kv.slice(at + 1)]
          }))
          const realLine = lines.find((line) => line.startsWith('real_pid='))
          if (realLine) fields.real_pid = realLine.split('=')[1]
          if (fields.owner === name && fields.real_pid) break
        } catch { /* lock not written yet */ }
        execFileSync('/nodejs/bin/node', ['-e', 'setTimeout(() => {}, 50)'])
      }
      check(fields.owner === name && fields.real_pid, `holder ${name} never took the lock: ${JSON.stringify(fields)}`)
      return { holder, fields }
    }

    const whole = startHolder('smoke-subtree', 60000)
    process.kill(Number(whole.fields.pid), 'SIGKILL')
    process.kill(Number(whole.fields.real_pid), 'SIGKILL')
    let started = Date.now()
    command('/usr/local/bin/pnpm', ['--version'], { env: admissionEnv, timeout: 15_000 })
    check(Date.now() - started < 5000, `whole-subtree kill did not free the lock in ${Date.now() - started} ms`)
    say(`pnpm admission whole-subtree kill: next waiter ran in ${Date.now() - started} ms`)

    const wrapper = startHolder('smoke-wrapper-held', 3000)
    process.kill(Number(wrapper.fields.pid), 'SIGKILL')
    const beforeWait = countEvents('wait ', admissionOwner)
    const beforeAdmit = countEvents('admit ', admissionOwner)
    started = Date.now()
    command('/usr/local/bin/pnpm', ['--version'], { env: admissionEnv, timeout: 15_000 })
    const waited = Date.now() - started
    check(waited >= 2000, `wrapper-only kill let the next waiter start early (${waited} ms)`)
    check(countEvents('wait ', admissionOwner) === beforeWait + 1, 'the contended call did not log exactly one wait line')
    check(countEvents('admit ', admissionOwner) === beforeAdmit + 1, 'the contended call did not log exactly one admit line')
    check(/wait .*holder_owner=smoke-wrapper-held/.test(admissionLog()), 'the wait was not logged with the lock owner')
    say(`pnpm admission wrapper-only kill: next waiter held for ${waited} ms until the install exited`)

    const refusing = startHolder('smoke-refuse', 60000)
    const refused = spawnSync('/usr/local/bin/pnpm', ['--version'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, AUTOMAGIK_PNPM_OWNER: 'smoke-waiter', AUTOMAGIK_PNPM_LOCK_WAIT: '2' },
    })
    check(refused.status === 1, `the waiter did not refuse in the bound: ${JSON.stringify({ status: refused.status, stderr: refused.stderr })}`)
    const sentence = /failed, lock held by smoke-refuse for \d+s/.exec(refused.stderr ?? '')
    check(sentence, `the refusal did not name the owner and age: ${refused.stderr}`)
    const refusal = JSON.parse(readFileSync('/data/run/pnpm-admission-refusal', 'utf8'))
    check(refusal.owner === 'smoke-refuse' && refusal.message === sentence[0], `the refusal record differs: ${JSON.stringify(refusal)}`)
    const refusalHome = join(rowDir, 'vendor-home')
    mkdirSync(refusalHome, { recursive: true })
    await installVendorClis({ home: refusalHome, profile: PROFILE, timeout: 0, log: () => {}, warn: () => {} })
    const refusalState = JSON.parse(readFileSync(join(refusalHome, 'vendor-clis-state.json'), 'utf8'))
    const recorded = Object.values(refusalState.results)[0]
    check(recorded?.state === 'failed' && recorded.error === sentence[0], `vendor state lacks the refusal: ${JSON.stringify(recorded)}`)
    process.kill(Number(refusing.fields.pid), 'SIGKILL')
    process.kill(Number(refusing.fields.real_pid), 'SIGKILL')
    say('pnpm admission refusal: waiter returned and both records name the owner and age')
  } finally {
    rmSync(rowDir, { recursive: true, force: true })
  }
  check(runtimeDir === XDG_RUNTIME_DIR, `unexpected XDG_RUNTIME_DIR ${runtimeDir}`)
  check(process.env.HC_RUNTIME === HC_RUNTIME, `unexpected HC_RUNTIME ${process.env.HC_RUNTIME}`)
  const runtime = lstatSync(runtimeDir)
  check(runtime.isDirectory() && (runtime.mode & 0o777) === 0o700 && runtime.uid === 1000
    && runtime.gid === 1000, `${runtimeDir} must be a 0700 directory owned by 1000:1000`)
  check(lstatSync(coreSocket).isSocket(), `${coreSocket} is not a Unix socket`)
  check(!realpathSync(coreSocket).startsWith('/data/'), `core socket is on /data: ${coreSocket}`)
  // No socket of this image's toolchain may sit on /data (the gate mounts it read-only, which
  // still allows connect()). The one socket dev already keeps there is bots-dsh's Pocket chat
  // socket (`<team home>/pocket/chat.sock`, owner-only, RFC 0015); any other fails, by path.
  const pocketSocket = join(process.env.AUTOMAGIK_BOTS_HOME || join(HOME, 'bots'), 'pocket', 'chat.sock')
  const dataSockets = command('find', ['/data', '-type', 's', '-print']).split('\n').filter(Boolean)
  say(`sockets on /data: ${dataSockets.length ? dataSockets.join(', ') : 'none'}`)
  const unexpected = dataSockets.filter((path) => path !== pocketSocket)
  check(!unexpected.length, `Unix socket found on /data: ${unexpected.join(', ')}`)

  // Capture the image's own raw shapes first, with its hc/am versions, so a failed
  // assertion shows the daemon's answer rather than our belief about it.
  const rawStatus = command('hc', ['server', 'status', '--json'])
  const rawList = command('hc', ['ls', '--json'])
  const shapesCapture = {
    captured_at: new Date().toISOString(),
    hc: `hc ${hc}`,
    am: `${am}`,
    serverStatus: rawStatus,
    ls: rawList,
  }
  writeFileSync('/tmp/in-image-hc-shapes.json', JSON.stringify(shapesCapture, null, 2))
  say(`hc shapes captured before assertions (hc ${hc}, am ${am}): ${JSON.stringify(shapesCapture)}`)

  check(rawStatus.trim().length > 0, 'hc server status printed nothing')
  const coreStatusJSON = JSON.parse(rawStatus)
  check(coreStatusJSON && typeof coreStatusJSON === 'object' && !Array.isArray(coreStatusJSON), 'hc server status --json did not print the documented object')
  check(coreStatusJSON.core && typeof coreStatusJSON.core === 'object' && !Array.isArray(coreStatusJSON.core), 'hc server status --json has no core object')
  const expectedCoreVersion = VERSIONS.herdrCore?.version || HERDR_CORE_VERSION
  check(coreStatusJSON.version === expectedCoreVersion, `hc server status version ${coreStatusJSON.version} is not the image's ${expectedCoreVersion}`)
  check(coreStatusJSON.live === 0, `hc server status has ${coreStatusJSON.live} live terminals before the test Bot, expected 0`)
  check(coreStatusJSON.finished === 0, `hc server status has ${coreStatusJSON.finished} finished terminals before the test Bot, expected 0`)
  const holder = coreStatusJSON.holder
  if (holder !== undefined && holder !== null) {
    check(typeof holder === 'object' && !Array.isArray(holder), 'hc server status holder is neither absent, null nor an object')
    check(holder.terminals === 0, `hc server status holder has ${holder.terminals} terminals before the test Bot, expected 0`)
  }
  if (coreStatusJSON.holders !== undefined) check(Array.isArray(coreStatusJSON.holders), 'hc server status holders is not a list when present')

  check(rawList.trim().length > 0, 'hc ls printed nothing')
  const listed = JSON.parse(rawList)
  check(listed && typeof listed === 'object' && !Array.isArray(listed), 'hc ls --json did not print the documented object')
  check(Array.isArray(listed.terminals), 'hc ls --json terminals is not a list')
  check(listed.terminals.length === 0, `hc ls --json has ${listed.terminals.length} terminals before the test Bot, expected 0`)

  say(`herdr-core: ${coreSocket} answered server status and ls`)

  // A test Bot through am start, with a harmless fake codex, proves the image carries /usr/bin/env
  // for am's launch and the am self-install briefing hook, without downloading a vendor CLI.
  const startDir = mkdtempSync(join(tmpdir(), 'automagik-am-start-'))
  const startProject = join(startDir, 'project')
  const fakeBin = join(startDir, 'bin')
  mkdirSync(startProject, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })
  const fakeCodex = join(fakeBin, 'codex')
  const invocationMarker = join(startDir, 'fake-codex-invocation')
  writeFileSync(fakeCodex, `#!/bin/sh\n{ printf '%s\\n' "$0"; printf '%s\\n' "$@"; } > ${JSON.stringify(invocationMarker)}\nwhile :; do :; done\n`)
  chmodSync(fakeCodex, 0o755)
  const startEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` }
  try {
    command('am', ['create', '--project', startProject, '--name', 'Proof', '--agent', 'codex', '--kind', 'main', '--json'], { env: startEnv })
    const started = spawnSync('am', ['start', 'Proof', '--project', startProject, '--json'], { encoding: 'utf8', env: startEnv, timeout: 60_000 })
    check(started.status === 0, `am start failed: ${started.stderr || started.stdout}`)
    check(!/gets no per-turn briefing/.test(started.stderr), `am start still warns about the briefing: ${started.stderr}`)
    const startedJSON = JSON.parse(started.stdout)
    check(startedJSON && typeof startedJSON === 'object' && !Array.isArray(startedJSON), 'am start --json did not print the documented object')
    const terminal = startedJSON.terminal
    check(typeof terminal === 'string' && terminal.length > 0, `am start returned no terminal: ${started.stdout}`)
    for (let attempt = 0; attempt < 50 && !existsSync(invocationMarker); attempt += 1) {
      execFileSync('/nodejs/bin/node', ['-e', 'setTimeout(() => {}, 100)'])
    }
    check(existsSync(invocationMarker), 'the fake codex did not record its invocation')
    const invocation = readFileSync(invocationMarker, 'utf8')
    check(invocation.split('\n')[0] === fakeCodex, `the fake codex argv[0] is ${JSON.stringify(invocation.split('\n')[0])}`)
    const hcShapes = {
      hc: `hc ${hc}`, am, raw: shapesCapture,
      parsed: { ls: listed, serverStatus: coreStatusJSON }, amStart: startedJSON,
    }
    writeFileSync('/tmp/in-image-hc-shapes.json', JSON.stringify(hcShapes, null, 2))
    say(`hc shapes captured from the image's hc ${hc} and am ${am}: ${JSON.stringify(hcShapes)}`)
    command('hc', ['kill', terminal])
    say('am start: /usr/bin/env, the briefing hook and the fake codex own invocation all work')
  } finally {
    rmSync(startDir, { recursive: true, force: true })
  }

  // The shipped CLI store, called with a recording runner: no vendor CLI is downloaded and no
  // package manager command runs, but the real install path, pnpm path and registry are proved.
  const acpDsh = join(PROFILE, 'node_modules', '@automagik', 'acp-dsh')
  check(existsSync(acpDsh), `the seeded profile has no @automagik/acp-dsh at ${acpDsh}`)
  const dry = await dryRunVendorClis({ acpDshDir: acpDsh, env: { ...process.env, AUTOMAGIK_PNPM: PNPM_PATH } })
  check(dry.pnpm === PNPM_PATH, `the CLI store used ${dry.pnpm}, not ${PNPM_PATH}`)
  check(dry.registry === 'https://registry.npmjs.org', `the CLI store used ${dry.registry}`)

  console.log(`IN-IMAGE SMOKE OK am=${am} hc=${hc} pnpm=${pnpm} node=${node} cli-store=dry-run`)
}

main().catch((error) => {
  console.error(`[in-image] FAILED: ${error?.stack ?? error}`)
  process.exitCode = 1
})
