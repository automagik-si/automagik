import { spawn as spawnProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { addAbortListener } from 'node:events'
import * as files from 'node:fs'
import { join } from 'node:path'
import timers from 'node:timers/promises'
import { omniRoot, pipeRedacted } from './lib.mjs'

const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-z0-9][a-z0-9.+-]*)?$/i
const SHA256 = /^[a-f0-9]{64}$/i
const MAX_BACKOFF_MS = 30_000
const TERM_GRACE_MS = 60_000
const KILL_GRACE_MS = 5_000
const ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'OMNI_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]
const delay = (...args) => timers.setTimeout(...args)

function outcome(child) {
  return new Promise((resolve) => {
    child.on('error', () => resolve({ failed: true }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function beforeStop(done, signal) {
  let listener
  try {
    const stopped = new Promise((resolve) => {
      listener = addAbortListener(signal, () => resolve(null))
    })
    return await Promise.race([done, stopped])
  } finally {
    listener[Symbol.dispose]()
  }
}

async function waitForExit(done, maxMs) {
  const timer = new AbortController()
  try {
    await Promise.race([done, delay(maxMs, undefined, { signal: timer.signal })])
  } finally {
    timer.abort()
  }
}

export function createOmniSupervisor({
  env = process.env, spawn = spawnProcess, fs = files, now = Date.now,
  log = console.log, warn = console.warn, pollMs = 3000, kill = process.kill,
} = {}) {
  const root = omniRoot(env)
  const sandbox = join(root, 'sandbox')
  const build = join(root, 'automagik-build')
  const runDir = join(sandbox, 'run')
  const markerPath = join(sandbox, 'automagik-supervised.json')
  const cliPath = join(sandbox, 'runtime', 'node_modules', '@automagik', 'omni', 'bin', 'omni')
  const childEnv = Object.fromEntries(ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]))
  if (childEnv.OMNI_HOME !== undefined) childEnv.OMNI_HOME = root
  childEnv.DO_NOT_TRACK = '1'

  const controller = new AbortController()
  const { signal } = controller
  let task
  const lastWarning = new Map()
  const warnOccasionally = (kind, message) => {
    const time = now()
    if (time - (lastWarning.get(kind) ?? -Infinity) < 60_000) return
    lastWarning.set(kind, time)
    warn(`[omni] ${message}`)
  }

  function checkDirectory(path) {
    const info = fs.lstatSync(path, { throwIfNoEntry: false })
    if (info && (!info.isDirectory() || info.uid !== process.getuid())) {
      throw new Error('unexpected Omni directory')
    }
    return info
  }

  async function acquireLease() {
    for (const path of [root, build]) {
      if (!checkDirectory(path)) fs.mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    const { O_CREAT, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = files.constants
    const fd = fs.openSync(join(build, 'supervisor.lock'), O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK, 0o600)
    let acquired = false
    try {
      const info = fs.fstatSync(fd)
      if (!info.isFile() || info.uid !== process.getuid()) throw new Error('invalid lease file')
      fs.fchmodSync(fd, 0o600)
      // FD 3 and fd refer to the same open file description. The lease survives
      // the nonblocking helper's exit and is released when this process closes fd.
      const helper = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        signal, env: childEnv, stdio: ['ignore', 'ignore', 'ignore', fd],
      })
      acquired = (await outcome(helper)).code === 0
      return acquired ? fd : null
    } finally {
      if (!acquired) fs.closeSync(fd)
    }
  }

  async function readCommand() {
    if (!checkDirectory(sandbox)) return null
    const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false })
    if (!markerInfo) return null
    if (!markerInfo.isFile()) throw new Error('invalid marker')
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const { version, bun } = marker ?? {}
    if (typeof version !== 'string' || !VERSION.test(version) ||
        typeof bun?.version !== 'string' || !VERSION.test(bun.version) ||
        typeof bun.sha256 !== 'string' || !SHA256.test(bun.sha256)) throw new Error('invalid marker')
    const sha256 = bun.sha256.toLowerCase()
    const bunPath = join(root, 'automagik-bun', `${bun.version}-${sha256.slice(0, 12)}`, 'bun')
    if (!fs.lstatSync(bunPath).isFile() || !fs.statSync(cliPath).isFile()) throw new Error('missing runtime')
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(bunPath, { signal })) hash.update(chunk)
    if (hash.digest('hex') !== sha256) throw new Error('Bun checksum mismatch')
    return { version, bunPath }
  }

  function send(pid, name) {
    try {
      kill(pid, name)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      warnOccasionally('signal', 'Could not signal the Omni process group.')
      return true
    }
  }

  async function reapGroup(pid) {
    if (!pid || !send(-pid, 'SIGKILL')) return
    // The leader's exit does not imply its children have exited. In the image,
    // tini reaps any children that the leader left behind.
    let deadline = Infinity
    while (send(-pid, 0)) {
      if (signal.aborted && deadline === Infinity) deadline = now() + KILL_GRACE_MS
      if (now() >= deadline) return
      await delay(50)
    }
  }

  async function run({ version, bunPath }) {
    let child
    try {
      child = spawn(bunPath, [cliPath, 'sandbox', 'run', '--home', sandbox, '--embedded'], {
        detached: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      return 'spawn failed'
    }
    const done = outcome(child)
    for (const [stream, into] of [[child.stdout, log], [child.stderr, warn]]) {
      if (stream) pipeRedacted(stream, { write: line => into(`[omni] ${line.slice(0, -1)}`) },
        undefined, undefined, 64 * 1024)
    }
    if (child.pid) log(`[omni] starting Omni ${version}`)
    const result = await beforeStop(done, signal)
    if (result === null && child.pid) {
      send(child.pid, 'SIGTERM')
      await waitForExit(done, TERM_GRACE_MS)
    }
    await reapGroup(child.pid)
    if (signal.aborted && result === null) await waitForExit(done, 50)
    return result && (result.failed ? 'spawn failed' : `exited (${result.signal ?? result.code})`)
  }

  async function supervise() {
    let fd = null
    let firstStart = true
    let backoff = 1000
    try {
      while (!signal.aborted) {
        if (fd === null) {
          try { fd = await acquireLease() } catch { /* No lease, including a helper or filesystem failure. */ }
          if (signal.aborted) break
          if (fd === null) {
            warnOccasionally('lease', 'Could not acquire the Omni supervisor lease. Waiting to retry.')
            await delay(pollMs, undefined, { signal })
            continue
          }
        }
        let command
        try {
          command = await readCommand()
          if (command && firstStart && !signal.aborted) {
            // This container owns the lease. A PID persisted from a previous
            // container boot is stale, even if that number now names a process.
            if (checkDirectory(runDir)) {
              try { fs.unlinkSync(join(runDir, 'supervisor.pid')) }
              catch (error) { if (error.code !== 'ENOENT') throw error }
            }
            firstStart = false
          }
        } catch (error) {
          if (signal.aborted) break
          warnOccasionally('runtime', error.message === 'Bun checksum mismatch'
            ? 'Bun checksum mismatch. Waiting for a verified runtime.'
            : 'Could not read the installed Omni runtime. Waiting to retry.')
          command = null
        }
        if (signal.aborted) break
        if (!command) {
          await delay(pollMs, undefined, { signal })
          continue
        }
        const started = now()
        const result = await run(command)
        if (signal.aborted) break
        if (now() - started >= MAX_BACKOFF_MS) backoff = 1000
        warn(`[omni] ${result}; restarting in ${backoff / 1000}s`)
        await delay(backoff, undefined, { signal })
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    } catch (error) {
      if (!signal.aborted || error.code !== 'ABORT_ERR') warn('[omni] Supervisor stopped unexpectedly.')
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
  }

  return {
    start() {
      if (!task && !signal.aborted) task = supervise()
    },
    async stop() {
      controller.abort()
      await task
    },
  }
}
