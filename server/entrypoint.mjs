#!/usr/bin/env node
// The server image's entry: seed the profile into /data on the first start, name the data
// volume's pnpm store, take the model key from the environment or a private file, start dsh,
// and print its output with the per-launch token redacted.
//
// dsh binds 127.0.0.1:3081 in the container (the production host's layout); publish it with
// --network host or a proxy in the same network namespace, not -p.
import { spawn } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_MODEL_KEY_FILE,
  ensureDataDirs,
  gateViewDir,
  launchUrlOf,
  omniRoot,
  pipeRedacted,
  PORT,
  prepareDshHome,
  prepareWorkspace,
  privateMode,
  PROFILE,
  profileDirOf,
  publicUrlArgs,
  RUN_SECRETS_MODEL_KEY_FILE,
  safeDshLine,
  writeMeasurementMarker,
} from './lib.mjs'
import { LAUNCH_FILE, prepareGateView, realLocation, writePrivateFile, writeProfileState } from './gate-view.mjs'
import { decisionSocketName } from './gate-decision-name.mjs'
import { multiuserConfigChecks, multiuserMode, multiuserReadiness, startupDecision } from './profile-multiuser.mjs'
import { followImage } from './profile-follow.mjs'
import { profileState } from './profile-state.mjs'
import { updateRecovery, updateStoreOf } from './profile-update.mjs'
import { holdVolumeLease, withProfileStateLock } from './volume-lock.mjs'
import { nativeWorkerEnv, panelCliHomes } from './native-worker-login.mjs'
import { installVendorClis, runFirstBoot } from './first-boot.mjs'
import { createOmniSupervisor } from './omni-supervisor.mjs'
import { HC_SESSION, XDG_RUNTIME_DIR, herdrCoreSocket, onSharedVolume, toolchainChildEnv } from './toolchain.mjs'

export { pipeRedacted, safeDshLine } from './lib.mjs'

const ROOT = '/opt/automagik'
const DSH_BIN = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const INSTALL_ANCHOR = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const SEED = join(ROOT, 'profile')
const CORE_BIN = '/usr/local/bin/herdr-core'

const log = (message) => process.stdout.write(`automagik-web: ${message}\n`)
const warn = (message) => process.stderr.write(`automagik-web: ${message}\n`)

function versions() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** The key from DEEPSEEK_API_KEY, else a 0400/0600 file; never log the value. */
function modelKey(env) {
  if (env.DEEPSEEK_API_KEY?.trim()) return { source: 'environment', key: env.DEEPSEEK_API_KEY.trim() }
  const candidates = [env.DEEPSEEK_API_KEY_FILE, DEFAULT_MODEL_KEY_FILE, RUN_SECRETS_MODEL_KEY_FILE].filter(Boolean)
  const file = candidates.find((candidate) => existsSync(candidate))
  if (!file) return { source: 'none' }
  const mode = statSync(file).mode & 0o777
  if (!privateMode(mode)) {
    throw new Error(`${file} is ${mode.toString(8).padStart(4, '0')}; the key file must be 0400 or 0600 (chmod 400 ${file})`)
  }
  const key = readFileSync(file, 'utf8').trim()
  if (!key) throw new Error(`${file} is empty`)
  return { source: file, key }
}

/** Save the owner-only launch URL for operators and the gate. */
export function recordLaunch(dshHome, gateView, url, warning = warn) {
  const target = join(dshHome, LAUNCH_FILE)
  const published = join(gateView, LAUNCH_FILE)
  const bytes = `${url}\n`
  try {
    writePrivateFile(published, bytes)
  } catch (error) {
    warning(`startup: could not publish the gate launch URL: ${error.message}`)
    rmSync(published, { force: true })
  }
  writePrivateFile(target, bytes)
  return target
}

const CORE_STDERR_TAIL = 16 * 1024

function isRunning(child) {
  return !!child?.pid && child.exitCode === null && child.signalCode === null
}

async function stopChild(child, signal) {
  if (!isRunning(child)) return
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    child.kill(signal)
  })
}

export function refuseStartup({ env, readiness, warn, exit }) {
  const { ok, reason } = startupDecision(multiuserMode(env.AUTOMAGIK_MULTIUSER), readiness)
  if (ok) return false
  warn(reason)
  exit(1)
  return true
}

export async function runStartup({ env, readiness, launchCore, launchDsh, exit, warn }) {
  const mode = multiuserMode(env.AUTOMAGIK_MULTIUSER)
  if (mode === 'on') {
    // DSH's workspace and profile .env files can only supply unset variables.
    try {
      env.AUTOMAGIK_GATE_DECISION_SOCKET = decisionSocketName(env.AUTOMAGIK_GATE_DECISION_SOCKET)
    } catch (error) {
      warn(error.message)
      exit(1)
      return
    }
  }
  let result
  if (mode === 'on' && readiness !== undefined) {
    try { result = typeof readiness === 'function' ? await readiness() : readiness }
    catch { result = { ready: false, checks: [{ code: 'readiness-error', ok: false }] } }
  }
  if (refuseStartup({ env, readiness: result, warn, exit })) return
  for (const code of result?.warnings ?? []) warn(code)
  env.AUTOMAGIK_MULTIUSER = mode === 'on' ? '1' : '0'
  await launchCore()
  await launchDsh()
}

export function dshArgs(publicArgs = []) {
  return [DSH_BIN, '--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', String(PORT), ...publicArgs]
}

export async function loadImageSupervisor(seedDir, warning = warn) {
  try {
    const bot = join(seedDir, 'node_modules', '@automagik', 'bots-dsh')
    const supervisor = join(bot, 'src/host/supervisor')
    const { IMAGE_HOST, runSupervisor } = await import(pathToFileURL(join(supervisor, 'main.js')))
    if (IMAGE_HOST === 1 && typeof runSupervisor === 'function') {
      const { usableStore } = await import(pathToFileURL(join(supervisor, 'store.js')))
      const { version } = JSON.parse(readFileSync(join(bot, 'package.json'), 'utf8'))
      if (typeof version === 'string' && version && typeof usableStore === 'function') {
        return { runSupervisor, usableStore, version }
      }
    }
  } catch {}
  warning("in-app update unavailable: this image's Bot team has no supervisor")
  return null
}

export function imageSupervisorHost(env, loaded) {
  return multiuserMode(env.AUTOMAGIK_MULTIUSER) !== 'on' && loaded
}

function clearStaleUpdateLocks(dshHome, profile) {
  const dir = join(dshHome, 'profiles', profile)
  const store = updateStoreOf(dir)
  for (const [path, name] of [[store, 'update.lock'], [dir, 'package.json.lock']]) {
    if ([dirname(path), path].every(parent => lstatSync(parent, { throwIfNoEntry: false })?.isDirectory())) {
      try { unlinkSync(join(path, name)) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
}

/** Two paths name one directory: a bind mount of the same folder at both is not collapsed by realpath. */
export function sameDirectory(left, right) {
  // bigint: two distinct 64-bit inode numbers can round to one JavaScript number.
  const a = statSync(left, { bigint: true, throwIfNoEntry: false })
  const b = statSync(right, { bigint: true, throwIfNoEntry: false })
  return Boolean(a?.isDirectory() && b?.isDirectory() && a.dev === b.dev && a.ino === b.ino)
}

export async function prepareImageVolume({
  dshHome, gateView, privateDirs, hold = holdVolumeLease, same = sameDirectory,
}) {
  const volumeRoot = dirname(gateView)
  prepareGateView(gateView, volumeRoot, privateDirs, { checkOnly: true })
  const volume = realLocation(volumeRoot), home = realLocation(dshHome)
  // The same directory under another path (a second bind mount) is the volume itself, which holds the
  // view: refuse it as the view's own checks refuse that path, before any lease is taken.
  if (home !== volume && same(volume, home)) throw new Error('gate-view overlaps DSH_HOME')
  const releases = []
  const release = () => { while (releases.length) releases.pop()() }
  try {
    const name = '.automagik-image-supervisor.lock'
    // A contender for the shared view waits before creating a lock in its own home.
    releases.push(await hold(volume, name))
    if (home !== volume) releases.push(await hold(home, name))
  } catch (error) {
    release()
    throw new Error(`another server holds this volume or its lease could not be acquired: ${error.message}`)
  }
  try {
    prepareGateView(gateView, volumeRoot, privateDirs)
    // Clear the previous launch before starting a new one.
    rmSync(join(gateView, LAUNCH_FILE), { force: true })
  } catch (error) {
    release()
    throw error
  }
  return release
}

export function refuseUnfinishedUpdate(host, seeded, warning = warn) {
  if (host || seeded.result !== 'self-update-unfinished') return false
  warning('an in-app update is unfinished and this start cannot finish it: multiuser on or no supervisor; see server/README.md')
  return true
}

export function prepareImageLaunch(host, seeded, dshHome, warning = warn) {
  if (!host) return { host: null, code: refuseUnfinishedUpdate(host, seeded, warning) ? 1 : 0 }
  if (host.usableStore(seeded.target)) {
    clearStaleUpdateLocks(dshHome, PROFILE)
    return { host, code: 0 }
  }
  const unavailable = "the update store must be on the profile's filesystem and writable"
  if (updateRecovery(seeded.target) !== 'recover') {
    warning(`in-app update unavailable: ${unavailable}`)
    return { host: null, code: 0 }
  }
  warning(`cannot start with existing in-app update state: ${unavailable}; see server/README.md`)
  return { host: null, code: 1 }
}

/** A DSH started without the image's supervisor must not inherit a supervisor's capability variables. */
export function scrubSupervisorEnv(env) {
  for (const name of Object.keys(env)) if (name.startsWith('AUTOMAGIK_SUPERVISOR_')) delete env[name]
  return env
}

export const bareDshEnv = env => scrubSupervisorEnv({ ...env })

function publishLaunch(dshHome, gateView, url, log, warn) {
  try {
    const file = recordLaunch(dshHome, gateView, url, warn)
    log(`startup: http://127.0.0.1:${PORT}/ (token in ${file})`)
  } catch (error) {
    warn(`startup: dsh is up, but the launch URL could not be written: ${error.message}`)
  }
}

export async function superviseDsh({
  host, dshHome, gateView, publicArgs, env, signal, observeVendors, noteDsh, refreshView, log, warn,
  onChildStart: hostChildStart = () => {}, refreshRetryMs = 1000, refreshDrainMs = 5000,
}) {
  // One worker publishes the gate view's profile state. Each publication computes the state under the
  // lock, so pending requests coalesce into the next one. While the supervisor runs, a lock timeout is
  // retried until the newest state is published: a healthcheck that held the lock past the wait cannot
  // leave an older verdict as the last one. Shutdown gives the worker its own drain deadline.
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  let dirty = false, closing = false, worker = null
  const drain = async () => {
    try {
      while (dirty) {
        dirty = false
        for (let attempt = 1; ; attempt++) {
          try {
            await refreshView()
            break
          } catch {
            if (dirty) break
            if (closing) {
              warn('startup: could not refresh the gate profile state')
              return
            }
            if (attempt === 10) warn('startup: the gate profile state is waiting for its lock')
            await sleep(refreshRetryMs)
            // A newer request publishes the newest state; a shutdown starts no new lock acquisition.
            if (dirty) break
            if (closing) {
              warn('startup: could not refresh the gate profile state')
              return
            }
          }
        }
      }
    } finally {
      worker = null
    }
  }
  const queueRefresh = () => {
    dirty = true
    worker ??= drain()
  }
  let code
  try {
    observeVendors()
    code = await host.runSupervisor({
      home: dshHome, profile: PROFILE, command: [process.execPath, ...dshArgs(publicArgs)],
      version: host.version, env, signal, refreshCopy: false,
      onChildStart() {
        for (const dir of [dshHome, gateView]) {
          try { rmSync(join(dir, LAUNCH_FILE), { force: true }) } catch {
            warn('startup: could not clear the previous launch URL')
          }
        }
        queueRefresh()
        try { hostChildStart() } catch { warn('startup: could not start a service beside DSH') }
      },
      onSave: queueRefresh,
      onLaunchUrl: url => publishLaunch(dshHome, gateView, url, log, warn),
      onLine: line => noteDsh(safeDshLine(line)),
    })
  } catch (error) {
    warn(`dsh supervisor: ${error.message}`)
    code = 1
  }
  closing = true
  const pending = worker
  if (pending) await Promise.race([pending, new Promise(done => setTimeout(done, refreshDrainMs).unref?.())])
  return code
}

export function imageProfilePublisher({ dshHome, gateView, source, build }) {
  const profile = profileDirOf(dshHome)
  return ({ rolledBack = false } = {}) => withProfileStateLock(dshHome, () => {
    writeProfileState(gateView, profileState({ profile, source, build, dshHome, rolledBack }))
  })
}

async function main() {
  const env = process.env
  let publicArgs
  try {
    publicArgs = publicUrlArgs(env.AUTOMAGIK_PUBLIC_URL)
  } catch (error) {
    warn(error.message)
    process.exit(1)
  }
  // Keep the checked paths stable when startup changes into the workspace.
  const home = resolve(env.AUTOMAGIK_HOME || '/data')
  const dshHome = resolve(env.DSH_HOME || join(home, 'dsh'))
  const gateView = gateViewDir(home)
  const botsHome = resolve(env.AUTOMAGIK_BOTS_HOME || join(home, 'bots'))
  const workspace = resolve(env.AUTOMAGIK_WORKSPACE || join(home, 'workspace'))
  const appHome = resolve(env.HERDR_APP_HOME || join(home, 'herdr-app'))
  const omniHome = omniRoot(env)
  const runtimeDir = resolve(env.XDG_RUNTIME_DIR || XDG_RUNTIME_DIR)
  const session = env.HC_SESSION ?? HC_SESSION
  const socketPath = herdrCoreSocket(session, runtimeDir)
  const coreRuntime = dirname(socketPath)
  if (runtimeDir === '/data' || runtimeDir.startsWith('/data/')) {
    throw new Error('XDG_RUNTIME_DIR must be outside the shared /data volume')
  }
  const secrets = join(home, 'secrets')
  const dirs = [botsHome, workspace, secrets, appHome]
  let supervisorWarning
  const availableHost = imageSupervisorHost(env, await loadImageSupervisor(SEED, message => { supervisorWarning = message }))
  const gatePrivateDirs = {
    AUTOMAGIK_HOME: home, DSH_HOME: dshHome, AUTOMAGIK_BOTS_HOME: botsHome,
    AUTOMAGIK_WORKSPACE: workspace, HERDR_APP_HOME: appHome, secrets, omni: omniHome,
    // ACP's store and the agents' sign-in homes (acp-dsh: <AUTOMAGIK_HOME>/acp, cli-homes).
    acp: join(home, 'acp'), 'acp cli-homes': panelCliHomes(join(home, 'acp'), dshHome),
  }
  try {
    // The view's overlap checks first, then the DSH home (0700, no symbolic links) before its lease
    // file is opened.
    prepareGateView(gateView, dirname(gateView), gatePrivateDirs, { checkOnly: true })
    prepareDshHome(dshHome, { prepareStore: true })
    // This process owns the leases until it exits. The view is created and the launch cleared under them.
    await prepareImageVolume({ dshHome, gateView, privateDirs: gatePrivateDirs })
    prepareWorkspace(workspace, { uid: 1000 })
    ensureDataDirs(dirs, { uid: 1000 })
    for (const dir of [runtimeDir, coreRuntime]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // The physical path, after it exists: a symlink into /data is refused before any chmod.
      if (onSharedVolume(dir)) throw new Error(`${dir} resolves into the shared /data volume; XDG_RUNTIME_DIR must be outside it`)
      chmodSync(dir, 0o700)
    }
  } catch (error) {
    warn(error.message)
    process.exit(1)
  }
  process.chdir(workspace)
  env.DSH_HOME = dshHome
  env.AUTOMAGIK_BOTS_HOME = botsHome
  env.AUTOMAGIK_HOME = home
  env.AUTOMAGIK_WORKSPACE = workspace
  env.HERDR_APP_HOME = appHome
  if (env.OMNI_HOME) env.OMNI_HOME = omniHome
  // Use the same session socket for core readiness, hc and pane validation.
  env.HC_SOCKET = socketPath
  env.HC_TERMINAL_SOCKET = socketPath
  env.HC_RUNTIME = coreRuntime
  env.XDG_RUNTIME_DIR = runtimeDir
  env.HC_SESSION = session
  env.AUTOMAGIK_PNPM_OWNER = env.AUTOMAGIK_PNPM_OWNER || 'dsh'
  const installClis = env.AUTOMAGIK_CLI_INSTALL !== 'off'
  if (!installClis) delete env.AUTOMAGIK_PNPM
  nativeWorkerEnv(env)

  const build = versions()
  if (supervisorWarning) warn(supervisorWarning)
  log(`profile ${PROFILE}: automagik ${build.automagik ?? 'unknown'}, dsh ${build.dsh ?? 'unknown'}`)

  // An image upgrade copies the existing profile to staging. Keep a stale DSH lock out
  // of that copy when the volume supports supervision. Check store eligibility again
  // after following, when a first seed or restored profile is available.
  if (availableHost && availableHost.usableStore(profileDirOf(dshHome))) {
    clearStaleUpdateLocks(dshHome, PROFILE)
  }
  const seeded = await followImage({ dshHome, source: SEED, store: join(ROOT, 'offline-store'), build, dshBin: DSH_BIN })
  const refreshView = imageProfilePublisher({ dshHome, gateView, source: SEED, build })
  await refreshView({ rolledBack: seeded.result === 'update-rolled-back' })
  try { writeMeasurementMarker(dirname(gateView), seeded.target) }
  catch (error) { warn(`could not publish the measurement marker: ${error.message}`) }
  log(seeded.seeded ? `seeded ${seeded.target}` : `profile present at ${seeded.target}`)
  log(`image follow: ${seeded.result}; ${seeded.reason}`)
  const { host, code } = prepareImageLaunch(availableHost, seeded, dshHome)
  if (code) process.exit(code)

  const readiness = async () => {
    const checks = multiuserConfigChecks(env, { cwd: workspace, dshHome })
    if (checks.some(check => !check.ok)) return { ready: false, checks, warnings: [] }
    const boot = createRequire(INSTALL_ANCHOR).resolve('@deepseek-ai/dsh-app-boot')
    const appBoot = await import(pathToFileURL(boot))
    return multiuserReadiness({ env, dshHome, profile: seeded.target, imageProfile: SEED, build, installAnchor: INSTALL_ANCHOR, appBoot })
  }

  const supervisor = createOmniSupervisor({ env, log, warn })
  // With the update supervisor hosted, it owns the DSH child: aborting it stops DSH and it returns.
  const supervision = new AbortController()
  let core, child, supervised, stopping = false
  const shutdown = (code, signal = 'SIGTERM') => {
    if (stopping) return
    stopping = true
    // Let Omni drain for up to 60s, then allow force-kill and core cleanup.
    setTimeout(() => {
      for (const proc of [child, core]) if (isRunning(proc)) proc.kill('SIGKILL')
      process.exit(code)
    }, 70_000).unref()
    void (async () => {
      // A hosted update supervisor stops its own DSH child once aborted, beside Omni's drain.
      supervision.abort()
      const drained = await Promise.allSettled([supervisor.stop(), stopChild(child, signal)])
      if (supervised) await supervised
      if (drained.some(result => result.status === 'rejected')) {
        warn('Could not finish shutting down Omni or dsh.')
      }
      await stopChild(core, signal)
      process.exit(code)
    })().catch(() => {
      warn('Could not finish shutting down the image processes.')
    })
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => shutdown(0, signal))
  }
  const launchCore = async () => {
    if (stopping) return
    let key
    try {
      key = modelKey(env)
    } catch (error) {
      warn(error.message)
      process.exit(1)
    }
    if (key.source === 'none') warn(`no model key: set DEEPSEEK_API_KEY or a 0400 file at ${DEFAULT_MODEL_KEY_FILE}`)
    else {
      env.DEEPSEEK_API_KEY = key.key
      log(`model key from ${key.source}`)
    }

    try {
      core = spawn(CORE_BIN, ['serve'], {
        env: toolchainChildEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      warn(`herdr-core did not start: ${error.message}`)
      process.exit(1)
    }
    let coreReady = false
    let exitedBeforeReady = false
    core.on('error', (error) => {
      warn(`herdr-core did not start: ${error.message}`)
      shutdown(1)
    })
    core.on('exit', (code, signal) => {
      if (stopping) return
      if (!coreReady) {
        // Let the readiness path report the socket, directory listing and stderr tail.
        exitedBeforeReady = true
        return
      }
      warn(`herdr-core exited (${signal ?? code}); stopping dsh so the container restart policy applies`)
      shutdown(code ?? 1)
    })
    pipeRedacted(core.stdout, process.stdout)
    let coreStderr = ''
    pipeRedacted(core.stderr, process.stderr, (line) => {
      coreStderr = `${coreStderr}${line}\n`.slice(-CORE_STDERR_TAIL)
    }, undefined, CORE_STDERR_TAIL)
    try {
      const started = Date.now()
      while (true) {
        if (stopping) return
        if (exitedBeforeReady) throw new Error(`herdr-core exited before its socket ${socketPath} appeared`)
        if (lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket()) {
          coreReady = true
          break
        }
        if (Date.now() - started > 15_000) {
          throw new Error(`herdr-core did not create a Unix socket at ${socketPath} within 15s`)
        }
        await new Promise((done) => setTimeout(done, 50))
      }
    } catch (error) {
      warn(error.message)
      // List while the core is still alive: its own socket (if it used a different name) is
      // visible here, and SIGTERM cannot erase it before the diagnostic is printed.
      for (const dir of [coreRuntime, runtimeDir]) {
        try { warn(`${dir}: ${readdirSync(dir).join(', ') || '(empty)'}`) } catch { /* missing */ }
      }
      warn(`herdr-core exitCode=${core.exitCode ?? 'null'} signal=${core.signalCode ?? 'none'}`)
      warn(`herdr-core stderr:\n${coreStderr || '(empty)'}`)
      shutdown(1)
      return
    }
    log(`herdr-core: serving on ${socketPath}`)

    try {
      runFirstBoot({ home, version: build.am?.version, env, log, warn })
    } catch (error) {
      warn(`first boot: ${error?.message ?? error}; the server starts and am retries on restart`)
    }
  }

  const dshVendorFailures = new Map()
  const noteDsh = (line) => {
    if (!/(?:pnpm install failed|install failed \(exit \d+\)|update check failed)/i.test(line)) return
    const vendor = /claude/i.test(line) ? 'claude' : /codex/i.test(line) ? 'codex' : null
    if (!vendor || dshVendorFailures.has(vendor)) return
    dshVendorFailures.set(vendor, line)
    warn(`vendor CLIs: DSH reported (${vendor}): ${line}`)
  }
  const observeVendors = () => {
    if (installClis) {
      log('vendor CLIs: observing the ACP store and refreshing the launch bridge in the background')
      void installVendorClis({
        home, profile: seeded.target, env, log, warn,
        failureFor: (spec) => dshVendorFailures.get(spec.key),
      })
        .then((result) => {
          if (result.state !== 'ready') warn(`vendor CLIs: ${result.state}; the ACP plugin will retry`)
        })
        .catch((error) => warn(`vendor CLIs: ${error?.message ?? error}`))
    }
  }
  const launchDsh = () => {
    if (stopping) return
    if (host) {
      supervised = superviseDsh({
        // Read now: launchCore and runStartup have set the model key and the multiuser mode.
        host, dshHome, gateView, publicArgs, env: { ...env, AUTOMAGIK_OMNI_SUPERVISOR: '1' },
        signal: supervision.signal, observeVendors,
        noteDsh: installClis ? noteDsh : () => {}, refreshView, log, warn,
        // Omni starts with the first DSH child and keeps running across the supervisor's restarts.
        onChildStart: () => { if (!stopping) supervisor.start() },
      })
      void supervised.then(code => shutdown(code))
      return
    }
    scrubSupervisorEnv(env)
    child = spawn(process.execPath, dshArgs(publicArgs), {
      env: { ...env, AUTOMAGIK_OMNI_SUPERVISOR: '1' },
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    child.on('error', (error) => {
      warn(`dsh did not start: ${error.message}`)
      shutdown(1)
    })
    child.once('spawn', () => {
      if (!stopping) supervisor.start()
    })
    observeVendors()

    let announced = false
    const onLaunchLine = (line) => {
      const url = launchUrlOf(line)
      if (!url || announced) return
      announced = true
      publishLaunch(dshHome, gateView, url, log, warn)
    }
    const onSafeLine = installClis ? noteDsh : undefined
    pipeRedacted(child.stdout, process.stdout, onSafeLine, onLaunchLine)
    pipeRedacted(child.stderr, process.stderr, onSafeLine, onLaunchLine)

    child.on('exit', (code, signal) => {
      shutdown(code ?? (signal ? 0 : 1))
    })
  }
  try {
    await runStartup({ env, readiness, launchCore, launchDsh, exit: process.exit, warn })
  } catch (error) {
    warn(`failed to start: ${error?.stack ?? error}`)
    shutdown(1)
  }
}

const launchedFromCli = (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  || process.execArgv.includes('--eval')
if (launchedFromCli) {
  main().catch((error) => {
    warn(`failed to start: ${error?.stack ?? error}`)
    process.exit(1)
  })
}
