#!/usr/bin/env node
// The smoke that runs inside the built image: the four commands an operator expects on PATH
// (am, hc, pnpm, node), the shipped CLI store's install path without a download, the real
// #1424 seed against the real first-boot team and against a copy of that v1 roster, and the
// skill hashes. Run by server/smoke.mjs with `docker exec`; it writes only under /tmp.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dryRunVendorClis } from './cli-store.mjs'
import { FIRST_BOOT_MARKER, TRIAD, installVendorClis, runFirstBoot, seedRegistry, seedScript, sha256File, SKILL_LINKS, verifySurfaces } from './first-boot.mjs'
import { profileDirOf } from './lib.mjs'
import { HC_RUNTIME, HERDR_APP_HOME, HERDR_CORE_VERSION, PNPM_PATH, REGISTRY_SEED_SHA256, REGISTRY_SEED_VENDOR, SKILL_NAME, SKILL_ROOT, SKILL_SHA256, SMOKE_HC_SESSION, XDG_RUNTIME_DIR, herdrCoreSocket } from './toolchain.mjs'

const ROOT = '/opt/automagik'
const HOME = process.env.AUTOMAGIK_HOME || '/data'
const DSH_HOME = process.env.DSH_HOME || '/data/dsh'
const WORKSPACE = process.env.AUTOMAGIK_WORKSPACE || '/data/workspace'
const PROFILE = profileDirOf(DSH_HOME)
const VENDOR = join(ROOT, 'registry-seed')
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
  // hc resolves the core socket from HC_SOCKET, then the config socket, then
  // $XDG_RUNTIME_DIR/herdr-core/$HC_SESSION.sock; the smoke container sets the last two.
  // Derive that session path here for the socket check and export HC_TERMINAL_SOCKET for the
  // pane/proxy validation paths; it is not hc's destination override.
  const coreSession = process.env.HC_SESSION || SMOKE_HC_SESSION
  const coreRuntime = process.env.HC_RUNTIME || HC_RUNTIME
  const coreSocket = herdrCoreSocket(coreSession, coreRuntime)
  process.env.HC_TERMINAL_SOCKET = coreSocket
  // The commands. am is the release tarball's command through its literal path; hc and
  // herdr-core are the same pinned binary (hc is the link); pnpm is the literal absolute path
  // AUTOMAGIK_PNPM names; node is the distroless runtime.
  check(process.env.AUTOMAGIK_PNPM === PNPM_PATH, `AUTOMAGIK_PNPM is ${process.env.AUTOMAGIK_PNPM ?? 'unset'}, not ${PNPM_PATH}`)
  const am = checkVersion('am', command('am', ['--version']), VERSIONS.am?.version)
  const hc = checkVersion('hc', command('hc', ['--version']), VERSIONS.herdrCore?.version || HERDR_CORE_VERSION)
  checkVersion('herdr-core', command('herdr-core', ['--version']), VERSIONS.herdrCore?.version || HERDR_CORE_VERSION)
  const pnpm = checkVersion('pnpm', command('pnpm', ['--version']), String(VERSIONS.pnpm ?? ''))
  const node = command('node', ['--version'])
  check(/^v\d+\.\d+\.\d+/.test(node), `node --version printed ${node}`)
  check(node === process.version, `node on PATH is ${node}, this process is ${process.version}`)
  say(`am ${am}, hc ${hc}, herdr-core ${VERSIONS.herdrCore?.version || HERDR_CORE_VERSION}, pnpm ${pnpm}, node ${node}`)

  // The Code side's terminals live in the supervised herdr-core on the contract socket. The
  // same env reaches dsh, am and hc; here the core must answer both its status and its list.
  check(process.env.HERDR_APP_HOME === HERDR_APP_HOME, `HERDR_APP_HOME is ${process.env.HERDR_APP_HOME ?? 'unset'}, not ${HERDR_APP_HOME}`)
  const briefingLink = join(HERDR_APP_HOME, 'automagik-herdr', 'briefing.mjs')
  check(existsSync(briefingLink), `am self install did not create ${briefingLink}`)
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
  check(process.env.XDG_RUNTIME_DIR === XDG_RUNTIME_DIR, `XDG_RUNTIME_DIR is ${process.env.XDG_RUNTIME_DIR ?? 'unset'}, not ${XDG_RUNTIME_DIR}`)
  check(coreSession === SMOKE_HC_SESSION, `HC_SESSION is ${coreSession}, not ${SMOKE_HC_SESSION}`)
  check(coreRuntime === HC_RUNTIME, `HC_RUNTIME is ${coreRuntime}, not ${HC_RUNTIME}`)
  const runtime = lstatSync(XDG_RUNTIME_DIR)
  check(runtime.isDirectory() && (runtime.mode & 0o777) === 0o700, `${XDG_RUNTIME_DIR} is not a 0700 directory`)
  check(lstatSync(coreSocket).isSocket(), `${coreSocket} is not a Unix socket`)
  const coreStatus = command('hc', ['server', 'status', '--json'])
  check(coreStatus.trim().length > 0, 'hc server status printed nothing')
  const coreStatusJSON = JSON.parse(coreStatus)
  check(coreStatusJSON && typeof coreStatusJSON === 'object' && !Array.isArray(coreStatusJSON), 'hc server status --json did not print the documented object')
  check(coreStatusJSON.core && typeof coreStatusJSON.core === 'object' && !Array.isArray(coreStatusJSON.core), 'hc server status --json has no core object')
  check(typeof coreStatusJSON.live === 'number', 'hc server status --json has no live count')
  check(coreStatusJSON.live === 0, `hc server status has ${coreStatusJSON.live} live terminals before the test Bot, expected 0`)
  check(coreStatusJSON.finished === 0, `hc server status has ${coreStatusJSON.finished} finished terminals before the test Bot, expected 0`)
  check(coreStatusJSON.holder && typeof coreStatusJSON.holder === 'object' && !Array.isArray(coreStatusJSON.holder), 'hc server status --json has no holder object')
  check(coreStatusJSON.holder.terminals === 0, `hc server status holder has ${coreStatusJSON.holder.terminals} terminals before the test Bot, expected 0`)
  check(Array.isArray(coreStatusJSON.holders), 'hc server status --json holders is not a list')
  const expectedCoreVersion = VERSIONS.herdrCore?.version || HERDR_CORE_VERSION
  check(coreStatusJSON.version === expectedCoreVersion, `hc server status version ${coreStatusJSON.version} is not the image's ${expectedCoreVersion}`)
  const coreList = command('hc', ['ls', '--json'])
  check(coreList.trim().length > 0, 'hc ls printed nothing')
  const listed = JSON.parse(coreList)
  check(listed && typeof listed === 'object' && !Array.isArray(listed), 'hc ls --json did not print the documented object')
  check(Array.isArray(listed.terminals), 'hc ls --json terminals is not a list')
  check(Array.isArray(listed.machines), 'hc ls --json machines is not a list')
  check(typeof listed.hidden_finished === 'number', 'hc ls --json hidden_finished is not a number')
  check(listed.hidden_finished === 0, `hc ls has ${listed.hidden_finished} hidden finished terminals before the test Bot, expected 0`)
  check(listed.terminals.length === 0, `hc ls --json has ${listed.terminals.length} terminals before the test Bot, expected 0`)
  const amList = JSON.parse(command('am', ['ls', '--project', WORKSPACE, '--json']))
  check(amList && typeof amList === 'object' && !Array.isArray(amList), 'am ls --json did not print the documented object')
  check(Array.isArray(amList.projects), 'am ls --json projects is not a list')
  const firstProject = amList.projects[0]
  check(firstProject && typeof firstProject === 'object' && !Array.isArray(firstProject) && Array.isArray(firstProject.bots), 'am ls --json project has no bots list')
  const seenBots = (amList?.projects ?? []).flatMap((project) => project.bots ?? [])
  check(amList?.projects?.[0]?.hcError === undefined, `am ls could not see the core: ${amList?.projects?.[0]?.hcError}`)
  check(seenBots.length === TRIAD.length, `am ls sees ${seenBots.length} bots, not ${TRIAD.length}`)
  say(`herdr-core: ${coreSocket} answered server status and ls; am sees ${seenBots.length} team bots`)

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
    const hcShapes = { hc: `hc ${hc}`, am: `${am}`, ls: listed, serverStatus: coreStatusJSON, amLs: amList, amStart: startedJSON }
    writeFileSync('/tmp/in-image-hc-shapes.json', JSON.stringify(hcShapes, null, 2))
    say(`hc shapes captured from the image's hc ${hc} and am ${am}: ${JSON.stringify(hcShapes)}`)
    command('hc', ['kill', terminal])
    say('am start: /usr/bin/env, the briefing hook and the fake codex own invocation all work')
  } finally {
    rmSync(startDir, { recursive: true, force: true })
  }

  // The reviewed skill is installed read-only in the shared agents folder and linked for both
  // agents on first boot. Both the image payload and the volume copy must match the pins.
  for (const [relative, expected] of Object.entries(SKILL_SHA256)) {
    check(sha256File(join(SKILL_ROOT, SKILL_NAME, relative)) === expected, `image skill payload ${relative} does not match its pin`)
    check(sha256File(join(HOME, '.agents', 'skills', SKILL_NAME, relative)) === expected, `installed skill ${relative} does not match its pin`)
  }
  for (const vendor of SKILL_LINKS) {
    const link = join(HOME, vendor, 'skills', SKILL_NAME)
    check(lstatSync(link).isSymbolicLink(), `${link} is not a symlink`)
    check(readlinkSync(link) === join('..', '..', '.agents', 'skills', SKILL_NAME), `${link} points at ${readlinkSync(link)}`)
  }
  say(`skill ${SKILL_NAME}: pinned payload, shared copy and both agent links match`)

  // The vendored #1424 seed is the published PR head, byte-pinned. The real first boot used it
  // (or an installed plugin carrying it) to create and read back both version 2 surfaces.
  for (const [relative, expected] of Object.entries(REGISTRY_SEED_SHA256)) {
    check(sha256File(join(VENDOR, relative)) === expected, `vendored seed ${relative} does not match its pin`)
  }
  const seed = seedScript({ profile: PROFILE, vendorRoot: VENDOR })
  say(`registry seed: ${seed.source}${seed.commit ? ` @ ${seed.commit}` : ''} at ${seed.path}`)
  const marker = JSON.parse(readFileSync(join(HOME, FIRST_BOOT_MARKER), 'utf8'))
  check(['installed', 'present'].includes(marker.skill), `first boot recorded skill ${marker.skill}`)
  check(marker.team?.state === 'created', `first boot recorded team ${marker.team?.state}`)
  check(marker.registry === 'seeded', `first boot recorded registry ${marker.registry}`)
  const surfaces = verifySurfaces({ home: HOME, workspace: WORKSPACE })
  check(surfaces.v1.bots === TRIAD.length && surfaces.v1.mains === 1, `first boot v1 has ${surfaces.v1.bots} bots, ${surfaces.v1.mains} main`)
  check(surfaces.home.bots === 1 && surfaces.home.projects === 1, `first boot v2 home has ${surfaces.home.bots} bots, ${surfaces.home.projects} projects`)
  check(surfaces.repo.bots === TRIAD.length && surfaces.repo.mains === 1, `first boot v2 repo has ${surfaces.repo.bots} bots, ${surfaces.repo.mains} main`)
  check(new Set(surfaces.bots.map((bot) => bot.id)).size === TRIAD.length, 'first boot reused a Bot id')
  const v1Registry = JSON.parse(readFileSync(join(WORKSPACE, '.herdr', 'bots.json'), 'utf8'))
  const homeRegistry = JSON.parse(readFileSync(join(HOME, 'bots', 'bots.json'), 'utf8'))
  const repoRegistry = JSON.parse(readFileSync(join(WORKSPACE, '.automagik', 'bots', 'bots.json'), 'utf8'))
  const v1Ids = v1Registry.bots.map((bot) => bot.id).sort()
  const repoIds = repoRegistry.bots.map((bot) => bot.id).sort()
  check(JSON.stringify(v1Ids) === JSON.stringify(repoIds), `cross-surface ids differ: v1 [${v1Ids.join(' ')}], repo [${repoIds.join(' ')}]`)
  const v1Main = v1Registry.bots.find((bot) => bot.kind === 'main')
  const homeMain = homeRegistry.bots.find((bot) => bot.main === true && bot.folder === WORKSPACE)
  check(homeMain?.id === v1Main?.id, `home main ${homeMain?.id} is not v1 main ${v1Main?.id}`)
  check(homeRegistry.projects.some((project) => project.folder === WORKSPACE), `home has no project ${WORKSPACE}`)
  for (const bot of v1Registry.bots) {
    const other = repoRegistry.bots.find((candidate) => candidate.id === bot.id)
    check(other, `repo has no Bot ${bot.id}`)
    check(other.name === bot.name && other.role === bot.role && other.agent === bot.agent && other.model === bot.model,
      `repo Bot ${bot.id} identity differs from v1`)
  }
  check(homeMain.name === v1Main.name && homeMain.role === v1Main.role && homeMain.agent === v1Main.agent && homeMain.model === v1Main.model,
    'home main identity differs from the v1 main')
  say(`first boot: team ${surfaces.bots.map((bot) => `${bot.name} ${bot.id}`).join(', ')}`)
  say(`first boot: v1 ${surfaces.v1.file} (${surfaces.v1.bots} bots, ${surfaces.v1.mains} main); v2 home ${surfaces.home.file} (${surfaces.home.bots} bots, ${surfaces.home.projects} project); v2 repo ${surfaces.repo.file} (${surfaces.repo.bots} bots, ${surfaces.repo.mains} main)`)
  say(`first boot: cross-surface ids ${v1Ids.join(' ')} agree; home main ${homeMain.id} matches v1 main`)
  const pinStateFile = join(HOME, 'bots', 'model-pin-state.json')
  const pinState = existsSync(pinStateFile) ? JSON.parse(readFileSync(pinStateFile, 'utf8')) : { state: 'unknown', pins: [] }
  if (pinState.state === 'pending') {
    check(Array.isArray(pinState.pins) && pinState.pins.length === v1Registry.bots.length, `pending state has ${pinState.pins?.length ?? 0} pins for ${v1Registry.bots.length} bots`)
    check(v1Registry.bots.every((bot) => /model pin pending/i.test(bot.instructions)), 'a pending team has a Bot without the model pin pending marker')
    check(repoRegistry.bots.every((bot) => /model pin pending/i.test(bot.instructions)), 'the v2 repo lacks the model pin pending marker')
    check(/model pin pending/i.test(homeMain.instructions), 'the v2 home main lacks the model pin pending marker')
    check(marker.pins === 'pending', `first boot marker says pins ${marker.pins}, not pending`)
    say(`model pins: pending (${pinState.pins.map((pin) => `${pin.name ?? pin.id} ${pin.model}`).join(', ')})`)
  } else if (pinState.state === 'ready') {
    check(v1Registry.bots.every((bot) => !/model pin pending/i.test(bot.instructions)), 'a ready team still says model pin pending')
    check(v1Registry.bots.every((bot) => bot.model), 'a ready team has an unpinned Bot')
    check(pinState.receipt?.verifiedAt, 'ready state has no verified receipt')
    say(`model pins: ready (${v1Registry.bots.map((bot) => `${bot.name} ${bot.model}`).join(', ')})`)
  } else {
    check(false, `model pin state is ${pinState.state}, not pending or ready`)
  }

  // The shipped CLI store, called with a recording runner: no vendor CLI is downloaded and no
  // package manager command runs, but the real install path, pnpm path and registry are proved.
  const acpDsh = join(PROFILE, 'node_modules', '@automagik', 'acp-dsh')
  check(existsSync(acpDsh), `the seeded profile has no @automagik/acp-dsh at ${acpDsh}`)
  const dry = await dryRunVendorClis({ acpDshDir: acpDsh, env: { ...process.env, AUTOMAGIK_PNPM: PNPM_PATH } })
  check(dry.pnpm === PNPM_PATH, `the CLI store used ${dry.pnpm}, not ${PNPM_PATH}`)
  check(dry.registry === 'https://registry.npmjs.org', `the CLI store used ${dry.registry}`)

  // A whole first boot in a temporary home: the real am creates the triad, the real seed writes
  // both files, and the verifier reads them back. The same seed then runs on a copy of the real
  // first-boot v1 roster, so a roster made by am is exercised twice from different homes.
  const temp = mkdtempSync(join(tmpdir(), 'automagik-in-image-'))
  try {
    const user = join(temp, 'user')
    const home = join(temp, 'home')
    const workspace = join(temp, 'workspace')
    const profile = join(temp, 'profile')
    const env = { ...process.env, HOME: user, HERDR_APP_HOME: join(temp, 'herdr-app'), AUTOMAGIK_HOME: home, AUTOMAGIK_WORKSPACE: workspace }
    const first = runFirstBoot({
      home, workspace, profile, env, vendorRoot: VENDOR, version: VERSIONS.automagik,
      source: join(ROOT, 'skills'), log: (message) => say(message), warn: (message) => say(`warning: ${message}`),
    })
    check(first.fresh, 'the temporary home was not first boot')
    check(first.team?.state === 'created', `the temporary team was ${first.team?.state}`)
    check(first.registry?.state === 'seeded', `the temporary seed was ${first.registry?.state}`)
    check(first.surfaces?.v1.bots === TRIAD.length, 'the temporary first boot did not verify the v1 roster')
    check(first.skill?.state === 'installed', `the skill in a temporary home was ${first.skill?.state}`)
    const tempMarker = JSON.parse(readFileSync(join(home, FIRST_BOOT_MARKER), 'utf8'))
    check(tempMarker.team?.bots?.length === TRIAD.length && tempMarker.registry === 'seeded', 'the temporary first-boot marker does not record the team and seed')
    const again = seedRegistry({ home, workspace, profile, env, vendorRoot: VENDOR, log: () => {}, warn: () => {} })
    check(again.stdout.includes('unchanged'), 'an identical re-run did not report both files unchanged')
    say('seed: a real am-created triad seeded both surfaces; an identical re-run reported unchanged')

    const copyProject = join(temp, 'copy-project')
    const copyHome = join(temp, 'copy-home')
    mkdirSync(join(copyProject, '.herdr'), { recursive: true })
    copyFileSync(join(WORKSPACE, '.herdr', 'bots.json'), join(copyProject, '.herdr', 'bots.json'))
    const copied = seedRegistry({ home: copyHome, workspace: copyProject, profile, env, vendorRoot: VENDOR, log: () => {}, warn: () => {} })
    check(copied.state === 'seeded', 'a copy of the real v1 roster did not seed')
    const copySurfaces = verifySurfaces({ home: copyHome, workspace: copyProject })
    check(copySurfaces.v1.bots === TRIAD.length && copySurfaces.repo.bots === TRIAD.length, 'the copied roster did not produce all three Bots')
    say('seed: a copy of the real first-boot v1 roster produced both version 2 surfaces')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  console.log(`IN-IMAGE SMOKE OK am=${am} hc=${hc} pnpm=${pnpm} node=${node} seed=real cli-store=dry-run`)
}

main().catch((error) => {
  console.error(`[in-image] FAILED: ${error?.stack ?? error}`)
  process.exitCode = 1
})
