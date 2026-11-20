import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { url as inspectorUrl } from 'node:inspector'
import { delimiter, isAbsolute, join, win32 } from 'node:path'
import { debuglog } from 'node:util'
import { isUnlockVariable } from './unlock-env.js'

const debugChild = debuglog('child_process')
const stripped = new Set(['BW_RESPONSE', 'BW_CLEANEXIT', 'BW_NOINTERACTION', 'BW_RAW', 'BW_PRETTY', 'BW_QUIET', 'NODE_DEBUG', 'NODE_OPTIONS'])
const rustDiagnostics = /^(?:RUST_(?:LOG|(?:LIB_)?BACKTRACE|SPANTRACE)(?:_|$)|COLORBT_)/
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_INPUT = 4096
const decode = chunks => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
export const tracing = () => debugChild.enabled || inspectorUrl() !== undefined

export function childEnv(parent = process.env) {
  return { ...sensitiveEnv(parent), BW_NOINTERACTION: 'true' }
}

function sensitiveEnv(parent) {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => {
    const upper = name.toUpperCase()
    return !isUnlockVariable(upper) && !stripped.has(upper) && !upper.startsWith('BWS_')
      && !rustDiagnostics.test(upper)
  }))
}

export function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

export function resolveExecutable(name, env) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return file
    } catch {}
  }
}

export function windowsPath(env) {
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  return path.split(';').map(directory => directory.replace(/^"(.*)"$/, '$1')).filter(dir => win32.isAbsolute(dir))
}

export function resolveBw({ platform = process.platform, env = process.env, exists = isFile, execPath = process.execPath } = {}) {
  if (platform !== 'win32') return { file: 'bw', prefix: [] }
  for (const dir of windowsPath(env)) {
    const standalone = win32.join(dir, 'bw.exe')
    if (exists(standalone)) return { file: standalone, prefix: [] }
    const script = win32.join(dir, 'node_modules', '@bitwarden', 'cli', 'build', 'bw.js')
    if (exists(script)) return { file: execPath, prefix: [script], node: true }
  }
}

export function runBw(args, { password, session, response = true, ...limits } = {}, options) {
  return runChild(args, limits, options, childEnv, resolveBw, {
    ...(password === undefined ? {} : { BW_PASSWORD: password }),
    ...(session === undefined ? {} : { BW_SESSION: session }),
  }, (env, launch) => {
    if (response) env.BW_RESPONSE = 'true'
    if (launch.node) env.ELECTRON_RUN_AS_NODE = '1'
  })
}

function opEnv(parent) {
  return Object.fromEntries(Object.entries(childEnv(parent)).filter(([name]) => !name.toUpperCase().startsWith('OP_')))
}

function resolveOp({ platform, env, exists }) {
  if (platform !== 'win32') return { file: 'op', prefix: [] }
  const file = windowsPath(env).map(dir => win32.join(dir, 'op.exe')).find(exists)
  if (file !== undefined) return { file, prefix: [] }
}

export function runOp(args, { token, ...limits } = {}, options) {
  const version = args.length === 1 && args[0] === '--version'
  if (!version && token === undefined) return Promise.resolve({ failure: 'refused' })
  const command = version ? args : args[0] === 'read'
    ? [...args.slice(0, -1), '--cache=false', args.at(-1)] : [...args, '--cache=false']
  return runChild(command, limits, options, opEnv, resolveOp,
    version ? {} : { OP_SERVICE_ACCOUNT_TOKEN: token })
}

// Only trusted CLI wrappers supply executable resolution, credentials and pipe contents.
export function runSensitive(args, { stdin, credentials = {}, sensitive = true, ...limits }, resolveCli, options) {
  return runChild(args, { ...limits, stdin, sensitive }, options, sensitiveEnv, resolveCli, credentials)
}

export function resolveBws({ platform, env, exists }) {
  const file = platform === 'win32' ? windowsPath(env).map(dir => win32.join(dir, 'bws.exe')).find(exists)
    : resolveExecutable('bws', env)
  if (file !== undefined) return { file, prefix: [] }
}

export function runChild(args, { timeout, signal, stdin, sensitive, onDispatch, maxOutput = MAX_OUTPUT, stdoutPresence = false },
  { platform = process.platform, parent = process.env, spawnChild = spawn, exists = isFile, execPath = process.execPath } = {},
  cleanEnv, resolveCli, credentials, configureEnv) {
  if (signal?.aborted) return Promise.resolve({ failure: 'cancelled' })
  if ((sensitive || stdin !== undefined || Object.keys(credentials).length > 0) && tracing()) {
    return Promise.resolve({ failure: 'refused' })
  }
  if (stdin !== undefined && Buffer.byteLength(stdin) > MAX_INPUT) return Promise.resolve({ failure: 'refused' })
  const env = cleanEnv(parent)
  const launch = resolveCli({ platform, env, exists, execPath })
  if (launch === undefined) return Promise.resolve({ failure: 'unavailable' })
  configureEnv?.(env, launch)
  Object.assign(env, credentials)
  return new Promise(resolve => {
    let child
    try {
      child = spawnChild(launch.file, [...launch.prefix, ...args], {
        env, shell: false, windowsHide: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ failure: 'unavailable' })
      return
    }
    const stdout = [], stderr = []
    let bytes = 0
    let discardedStdout = 0
    let failure
    const killChild = () => { try { child.kill('SIGKILL') } catch {} }
    const stop = (reason) => {
      if (failure !== undefined) return
      failure = reason
      stdout.length = 0
      stderr.length = 0
      if (platform !== 'win32' || child.pid === undefined) { killChild(); return }
      const root = Object.entries(parent).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1]
      const command = root ? win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe'
      try {
        const killer = spawnChild(command, ['/PID', String(child.pid), '/T', '/F'], {
          env: cleanEnv(parent), shell: false, windowsHide: true, stdio: 'ignore',
        })
        killer.on('error', killChild)
        killer.once('close', code => { if (code !== 0) killChild() })
      } catch { killChild() }
    }
    const abort = () => stop('cancelled')
    // A presence probe keeps only whether stdout had bytes and still bounds both streams.
    const collect = target => chunk => {
      if (failure !== undefined) return
      if (stdoutPresence && target === stdout) {
        discardedStdout += chunk.length
        if (discardedStdout > maxOutput) stop('stdout-limit')
        return
      }
      bytes += chunk.length
      if (bytes > maxOutput) stop('output')
      else target.push(chunk)
    }
    const timer = setTimeout(() => stop('timeout'), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.stdout.on('error', () => stop('unavailable'))
    child.stderr.on('error', () => stop('unavailable'))
    child.on('error', () => stop('unavailable'))
    child.once('close', (code, endedBySignal) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure !== undefined || endedBySignal != null || !Number.isInteger(code)) {
        resolve({ failure: failure ?? 'unavailable' })
      } else {
        try {
          resolve({ code, stdout: decode(stdout), stderr: decode(stderr),
            ...(stdoutPresence ? { hasStdout: discardedStdout > 0 } : {}) })
        } catch {
          resolve(stdoutPresence && code === 0 ? { code } : { failure: 'unavailable' })
        }
      }
    })
    if (child.pid !== undefined) onDispatch?.()
    if (stdin !== undefined) {
      child.stdin.on('error', () => stop('unavailable'))
      try { child.stdin.end(stdin) } catch { stop('unavailable') }
    }
    if (signal?.aborted) abort()
  })
}
