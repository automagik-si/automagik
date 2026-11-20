#!/usr/bin/env node
// The server image's entry: seed the profile into /data on the first start, name the data
// volume's pnpm store, take the model key from the environment or a private file, start dsh,
// and print its output with the per-launch token redacted.
//
// dsh binds 127.0.0.1:3081 in the container (the production host's layout); publish it with
// --network host or a proxy in the same network namespace, not -p.
import { spawn } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ensureDataDirs,
  gateViewDir,
  launchUrlOf,
  PORT,
  prepareWorkspace,
  privateMode,
  PROFILE,
  publicUrlArgs,
  redactTokens,
} from './lib.mjs'
import { LAUNCH_FILE, prepareGateView, writePrivateFile, writeProfileState } from './gate-view.mjs'
import { multiuserConfigChecks, multiuserMode, multiuserReadiness, startupDecision } from './profile-multiuser.mjs'
import { followImage } from './profile-follow.mjs'
import { nativeWorkerEnv, panelCliHomes } from './native-worker-login.mjs'
import { installVendorClis, runFirstBoot } from './first-boot.mjs'
import { HC_SESSION, XDG_RUNTIME_DIR, herdrCoreSocket, onSharedVolume, toolchainChildEnv } from './toolchain.mjs'

const ROOT = '/opt/automagik'
const DSH_BIN = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const INSTALL_ANCHOR = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const SEED = join(ROOT, 'profile')
const KEY_DEFAULT = '/data/secrets/deepseek-api-key'
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
  const candidates = [env.DEEPSEEK_API_KEY_FILE, KEY_DEFAULT, '/run/secrets/deepseek_api_key'].filter(Boolean)
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
export function recordLaunch(dshHome, gateView, url) {
  const target = join(dshHome, LAUNCH_FILE)
  const published = join(gateView, LAUNCH_FILE)
  const bytes = `${url}\n`
  try {
    writePrivateFile(published, bytes)
  } catch (error) {
    warn(`startup: could not publish the gate launch URL: ${error.message}`)
    rmSync(published, { force: true })
  }
  writePrivateFile(target, bytes)
  return target
}

const SAFE_LINE_MAX = 4096
const CORE_STDERR_TAIL = 16 * 1024
export const safeDshLine = (line) => {
  const redacted = redactTokens(line)
  return redacted.length > SAFE_LINE_MAX ? `${redacted.slice(0, SAFE_LINE_MAX)}…` : redacted
}
export function pipeRedacted(stream, into, onLine, onRawLine, maxPending = Infinity) {
  let pending = ''
  let overlong = false
  stream.setEncoding('utf8')
  const emit = (line) => {
    const complete = !overlong && line.length <= maxPending
    const safe = complete ? safeDshLine(line) : '[overlong line omitted]'
    overlong = false
    onLine?.(safe)
    if (complete) onRawLine?.(line)
    into.write(`${safe}\n`)
  }
  stream.on('data', (chunk) => {
    pending += chunk
    let end = pending.indexOf('\n')
    while (end !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      emit(line)
      end = pending.indexOf('\n')
    }
    if (pending.length > maxPending) {
      pending = ''
      overlong = true
    }
  })
  stream.on('end', () => {
    if (pending || overlong) emit(pending)
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
  const runtimeDir = resolve(env.XDG_RUNTIME_DIR || XDG_RUNTIME_DIR)
  const session = env.HC_SESSION ?? HC_SESSION
  const socketPath = herdrCoreSocket(session, runtimeDir)
  const coreRuntime = dirname(socketPath)
  if (runtimeDir === '/data' || runtimeDir.startsWith('/data/')) {
    throw new Error('XDG_RUNTIME_DIR must be outside the shared /data volume')
  }
  const secrets = join(home, 'secrets')
  const dirs = [dshHome, botsHome, workspace, join(dshHome, 'pnpm-store'), secrets]
  try {
    prepareGateView(gateView, dirname(gateView), {
      AUTOMAGIK_HOME: home, DSH_HOME: dshHome, AUTOMAGIK_BOTS_HOME: botsHome,
      AUTOMAGIK_WORKSPACE: workspace, HERDR_APP_HOME: appHome, secrets,
      // ACP's store and the agents' sign-in homes (acp-dsh: <AUTOMAGIK_HOME>/acp, cli-homes).
      acp: join(home, 'acp'), 'acp cli-homes': panelCliHomes(join(home, 'acp'), dshHome),
    })
    prepareWorkspace(workspace, { uid: 1000 })
    ensureDataDirs([...dirs, appHome], { uid: 1000 })
    // Clear the previous launch before starting a new one.
    rmSync(join(gateView, LAUNCH_FILE), { force: true })
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
  log(`profile ${PROFILE}: automagik ${build.automagik ?? 'unknown'}, dsh ${build.dsh ?? 'unknown'}`)

  const seeded = await followImage({ dshHome, source: SEED, store: join(ROOT, 'offline-store'), build, dshBin: DSH_BIN })
  writeProfileState(gateView, seeded)
  log(seeded.seeded ? `seeded ${seeded.target}` : `profile present at ${seeded.target}`)
  log(`image follow: ${seeded.result}; ${seeded.reason}`)

  const readiness = async () => {
    const checks = multiuserConfigChecks(env, { cwd: workspace, dshHome })
    if (checks.some(check => !check.ok)) return { ready: false, checks, warnings: [] }
    const boot = createRequire(INSTALL_ANCHOR).resolve('@deepseek-ai/dsh-app-boot')
    const appBoot = await import(pathToFileURL(boot))
    return multiuserReadiness({ env, dshHome, profile: seeded.target, imageProfile: SEED, build, installAnchor: INSTALL_ANCHOR, appBoot })
  }

  // If either supervised child exits, stop the other.
  let core, child = null, coreExit = null, stopping = false
  const stopCore = (signal = 'SIGTERM') => {
    if (core.exitCode === null && core.signalCode === null) core.kill(signal)
  }
  const launchCore = async () => {
    let key
    try {
      key = modelKey(env)
    } catch (error) {
      warn(error.message)
      process.exit(1)
    }
    if (key.source === 'none') warn(`no model key: set DEEPSEEK_API_KEY or a 0400 file at ${KEY_DEFAULT}`)
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
    core.on('error', (error) => {
      warn(`herdr-core did not start: ${error.message}`)
      stopping = true
      child?.kill('SIGTERM')
      process.exit(1)
    })
    core.on('exit', (code, signal) => {
      if (stopping) return
      stopping = true
      coreExit = code ?? 1
      warn(`herdr-core exited (${signal ?? code}); stopping dsh so the container restart policy applies`)
      child?.kill('SIGTERM')
      setTimeout(() => process.exit(coreExit ?? 1), 10_000).unref?.()
    })
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(signal, () => {
        stopping = true
        stopCore(signal)
        child?.kill(signal)
      })
    }
    pipeRedacted(core.stdout, process.stdout)
    let coreStderr = ''
    pipeRedacted(core.stderr, process.stderr, (line) => {
      coreStderr = `${coreStderr}${line}\n`.slice(-CORE_STDERR_TAIL)
    }, undefined, CORE_STDERR_TAIL)
    try {
      const started = Date.now()
      while (true) {
        if (coreExit !== null) {
          throw new Error(`herdr-core exited before its socket ${socketPath} appeared`)
        }
        if (lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket()) break
        if (Date.now() - started > 15_000) {
          throw new Error(`herdr-core did not create a Unix socket at ${socketPath} within 15s`)
        }
        await new Promise((done) => setTimeout(done, 50))
      }
    } catch (error) {
      stopping = true
      warn(error.message)
      // List while the core is still alive: its own socket (if it used a different name) is
      // visible here, and SIGTERM cannot erase it before the diagnostic is printed.
      for (const dir of [coreRuntime, runtimeDir]) {
        try { warn(`${dir}: ${readdirSync(dir).join(', ') || '(empty)'}`) } catch { /* missing */ }
      }
      warn(`herdr-core exitCode=${core.exitCode ?? 'null'} signal=${core.signalCode ?? 'none'}`)
      warn(`herdr-core stderr:\n${coreStderr || '(empty)'}`)
      stopCore()
      process.exit(1)
    }
    log(`herdr-core: serving on ${socketPath}`)

    try {
      runFirstBoot({ home, version: build.am?.version, env, log, warn })
    } catch (error) {
      warn(`first boot: ${error?.message ?? error}; the server starts and am retries on restart`)
    }
    if (coreExit !== null) {
      stopping = true
      throw new Error('herdr-core exited during the first boot')
    }
  }

  const launchDsh = () => {
    const dshVendorFailures = new Map()
    const noteDsh = (line) => {
      if (!/(?:pnpm install failed|install failed \(exit \d+\)|update check failed)/i.test(line)) return
      const vendor = /claude/i.test(line) ? 'claude' : /codex/i.test(line) ? 'codex' : null
      if (!vendor || dshVendorFailures.has(vendor)) return
      dshVendorFailures.set(vendor, line)
      warn(`vendor CLIs: DSH reported (${vendor}): ${line}`)
    }
    child = spawn(process.execPath, dshArgs(publicArgs), {
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    child.on('error', (error) => {
      warn(`dsh did not start: ${error.message}`)
      stopCore()
      process.exit(1)
    })
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

    let announced = false
    const onLaunchLine = (line) => {
      const url = launchUrlOf(line)
      if (!url || announced) return
      announced = true
      try {
        const file = recordLaunch(dshHome, gateView, url)
        log(`startup: http://127.0.0.1:${PORT}/ (token in ${file})`)
      } catch (error) {
        warn(`startup: dsh is up, but the launch URL could not be written: ${error.message}`)
      }
    }
    const onSafeLine = installClis ? noteDsh : undefined
    pipeRedacted(child.stdout, process.stdout, onSafeLine, onLaunchLine)
    pipeRedacted(child.stderr, process.stderr, onSafeLine, onLaunchLine)

    child.on('exit', (code, signal) => {
      const exitCode = coreExit ?? code ?? (signal ? 0 : 1)
      if (core.exitCode !== null || core.signalCode !== null) process.exit(exitCode)
      core.once('exit', () => process.exit(exitCode))
      stopCore()
      setTimeout(() => {
        core.kill('SIGKILL')
        process.exit(exitCode)
      }, 10_000).unref?.()
    })
  }
  await runStartup({ env, readiness, launchCore, launchDsh, exit: process.exit, warn })
}

const launchedFromCli = (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  || process.execArgv.includes('--eval')
if (launchedFromCli) {
  main().catch((error) => {
    warn(`failed to start: ${error?.stack ?? error}`)
    process.exit(1)
  })
}
