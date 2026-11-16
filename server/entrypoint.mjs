#!/usr/bin/env node
// The server image's entry: seed the profile into /data on the first start, name the data
// volume's pnpm store, take the model key from the environment or a private file, start dsh,
// and print its output with the per-launch token redacted.
//
// dsh binds 127.0.0.1:3081 in the container (the production host's layout); publish it with
// --network host or a proxy in the same network namespace, not -p.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ensureDataDirs,
  launchUrlOf,
  PORT,
  prepareWorkspace,
  privateMode,
  PROFILE,
  publicUrlArgs,
  redactTokens,
} from './lib.mjs'
import { followImage } from './profile-follow.mjs'
import { installVendorClis, runFirstBoot } from './first-boot.mjs'

const ROOT = '/opt/automagik'
const DSH_BIN = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const SEED = join(ROOT, 'profile')
const LAUNCH_FILE = 'launch-url'
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

/** Write the launch URL (the only place the token survives) beside the data, readable only by its owner. */
function recordLaunch(dshHome, url) {
  const target = join(dshHome, LAUNCH_FILE)
  const fresh = `${target}.${process.pid}`
  writeFileSync(fresh, `${url}\n`, { mode: 0o600 })
  chmodSync(fresh, 0o600)
  renameSync(fresh, target)
  return target
}

function pipeRedacted(stream, into, onLine) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    let end = pending.indexOf('\n')
    while (end !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      onLine(line)
      into.write(`${redactTokens(line)}\n`)
      end = pending.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (pending) {
      onLine(pending)
      into.write(redactTokens(pending))
    }
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
  const home = env.AUTOMAGIK_HOME || '/data'
  const dshHome = env.DSH_HOME || join(home, 'dsh')
  const botsHome = env.AUTOMAGIK_BOTS_HOME || join(home, 'bots')
  const workspace = env.AUTOMAGIK_WORKSPACE || join(home, 'workspace')
  const appHome = env.HERDR_APP_HOME || join(home, 'herdr-app')
  const socketPath = env.HC_TERMINAL_SOCKET || join(home, 'run', 'herdr-core', 'default.sock')
  const coreDir = dirname(socketPath)
  const dirs = [dshHome, botsHome, workspace, join(dshHome, 'pnpm-store'), join(home, 'secrets'), appHome, coreDir]
  try {
    prepareWorkspace(workspace, { uid: 1000 })
    ensureDataDirs(dirs, { uid: 1000 })
    mkdirSync(appHome, { recursive: true, mode: 0o755 })
    mkdirSync(coreDir, { recursive: true, mode: 0o700 })
    chmodSync(coreDir, 0o700)
  } catch (error) {
    warn(error.message)
    process.exit(1)
  }
  process.chdir(workspace)
  env.DSH_HOME = dshHome
  env.AUTOMAGIK_BOTS_HOME = botsHome
  env.AUTOMAGIK_HOME = home
  env.HERDR_APP_HOME = appHome
  env.HC_TERMINAL_SOCKET = socketPath

  const build = versions()
  log(`profile ${PROFILE}: automagik ${build.automagik ?? 'unknown'}, dsh ${build.dsh ?? 'unknown'}`)

  const seeded = await followImage({ dshHome, source: SEED, store: join(ROOT, 'offline-store'), build, dshBin: DSH_BIN })
  log(seeded.seeded ? `seeded ${seeded.target}` : `profile present at ${seeded.target}`)
  log(`image follow: ${seeded.result}; ${seeded.reason}`)

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

  // The Code side's terminals live in herdr-core. It is a supervised child of this entrypoint,
  // on the contract socket inside the data volume; the same env reaches dsh and hc. If either
  // child ends, the container stops so its own restart policy applies to both.
  let core
  try {
    core = spawn(CORE_BIN, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    warn(`herdr-core did not start: ${error.message}`)
    process.exit(1)
  }
  let stopping = false
  let coreExit = null
  let child = null
  const stopCore = (signal = 'SIGTERM') => {
    if (core.exitCode === null && core.signalCode === null) core.kill(signal)
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
  pipeRedacted(core.stdout, process.stdout, () => {})
  pipeRedacted(core.stderr, process.stderr, () => {})
  log(`herdr-core: serving on ${socketPath}`)
  try {
    const started = Date.now()
    while (!existsSync(socketPath)) {
      if (coreExit !== null) throw new Error(`herdr-core exited before its socket ${socketPath} appeared`)
      if (Date.now() - started > 15_000) throw new Error(`herdr-core did not create ${socketPath} within 15s`)
      await new Promise((done) => setTimeout(done, 50))
    }
  } catch (error) {
    stopping = true
    stopCore()
    warn(error.message)
    process.exit(1)
  }

  // First boot puts the reviewed skills and the v2 registry seed in the team home. The vendor
  // CLIs follow in the background after dsh is up: they are hundreds of MB from npm and must
  // never hold the auth fence closed, nor be baked into the image.
  let firstBoot
  try {
    firstBoot = runFirstBoot({ home: env.AUTOMAGIK_HOME, workspace, profile: seeded.target, version: build.automagik, log, warn })
  } catch (error) {
    stopping = true
    stopCore()
    throw error
  }
  if (coreExit !== null) {
    stopping = true
    throw new Error('herdr-core exited during the first boot')
  }

  child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', String(PORT), ...publicArgs], {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  child.on('error', (error) => {
    warn(`dsh did not start: ${error.message}`)
    stopCore()
    process.exit(1)
  })
  if (firstBoot.fresh && env.AUTOMAGIK_CLI_INSTALL !== 'off') {
    log('vendor CLIs: installing Claude Code and Codex into the data volume in the background')
    void installVendorClis({ home: env.AUTOMAGIK_HOME, profile: seeded.target, env, log, warn })
      .then((result) => { if (result.state !== 'ready') warn(`vendor CLIs: ${result.state}; the ACP plugin will retry`) })
      .catch((error) => warn(`vendor CLIs: ${error?.message ?? error}`))
  }

  let announced = false
  const onLine = (line) => {
    const url = launchUrlOf(line)
    if (!url || announced) return
    announced = true
    try {
      const file = recordLaunch(dshHome, url)
      log(`startup: http://127.0.0.1:${PORT}/ (token in ${file})`)
    } catch (error) {
      warn(`startup: dsh is up, but the launch URL could not be written: ${error.message}`)
    }
  }
  pipeRedacted(child.stdout, process.stdout, onLine)
  pipeRedacted(child.stderr, process.stderr, onLine)

  child.on('exit', (code, signal) => {
    const exitCode = coreExit ?? code ?? (signal ? 0 : 1)
    if (core.exitCode !== null || core.signalCode !== null) process.exit(exitCode)
    core.once('exit', () => process.exit(exitCode))
    stopCore()
    setTimeout(() => { core.kill('SIGKILL'); process.exit(exitCode) }, 10_000).unref?.()
  })
}

main().catch((error) => {
  warn(`failed to start: ${error?.stack ?? error}`)
  process.exit(1)
})
