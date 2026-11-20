#!/usr/bin/env node
// The server image's entry: seed the profile into /data on the first start, name the data
// volume's pnpm store, take the model key from the environment or a private file, start dsh,
// and print its output with the per-launch token redacted.
//
// dsh binds 127.0.0.1:3081 in the container (the production host's layout); publish it with
// --network host or a proxy in the same network namespace, not -p.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { nativeWorkerEnv } from './native-worker-login.mjs'

const ROOT = '/opt/automagik'
const DSH_BIN = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const SEED = join(ROOT, 'profile')
const LAUNCH_FILE = 'launch-url'
const KEY_DEFAULT = '/data/secrets/deepseek-api-key'

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
  const dshHome = env.DSH_HOME || '/data/dsh'
  const botsHome = env.AUTOMAGIK_BOTS_HOME || '/data/bots'
  const workspace = env.AUTOMAGIK_WORKSPACE || '/data/workspace'
  const dirs = [dshHome, botsHome, workspace, join(dshHome, 'pnpm-store'), '/data/secrets']
  try {
    prepareWorkspace(workspace, { uid: 1000 })
    ensureDataDirs(dirs, { uid: 1000 })
  } catch (error) {
    warn(error.message)
    process.exit(1)
  }
  process.chdir(workspace)
  env.DSH_HOME = dshHome
  env.AUTOMAGIK_BOTS_HOME = botsHome
  env.AUTOMAGIK_HOME = env.AUTOMAGIK_HOME || '/data'
  nativeWorkerEnv(env)

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

  const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', String(PORT), ...publicArgs], {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  child.on('error', (error) => {
    warn(`dsh did not start: ${error.message}`)
    process.exit(1)
  })

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

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)))
}

main().catch((error) => {
  warn(`failed to start: ${error?.stack ?? error}`)
  process.exit(1)
})
