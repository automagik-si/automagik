// Windows login ownership: a Job Object outlives a .cmd wrapper and owns its descendants.
// The supervisor starts the vendor suspended inside a named Job using JOB_LIST. Raw stdio
// remains the vendor's protocol. No process exit authorizes an auth change without Job proof.
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchSafe } from './batch-spawn.js'

const SUPERVISOR = fileURLToPath(new URL('./windows-login.ps1', import.meta.url))
export const WINDOWS_LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const validWindowsStart = start => typeof start === 'string' && /^[1-9][0-9]{0,18}$/.test(start)
const failed = () => new Error('The complete sign-in process tree could not be stopped.')
const read = (env, key) => Object.entries(env).find(([name]) => (
  name.toLowerCase() === key.toLowerCase()
))?.[1]

// The Windows CRT argument rule, for a native CreateProcess call (not shell escaping).
const nativeArg = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"')
  .replace(/(\\+)$/, '$1$1')}"`

export function windowsLoginCommand(file, args, env) {
  if (/\.(cmd|bat)$/i.test(file)) {
    const [command, quoted] = batchSafe(file, args, {}, 'win32')
    const shell = read(env, 'ComSpec') ?? 'cmd.exe'
    return { executable: shell,
      line: `${nativeArg(shell)} /d /s /c "${[command, ...quoted].join(' ')}"` }
  }
  return { executable: file, line: [file, ...args].map(nativeArg).join(' ') }
}

export function windowsJobName(id) {
  if (typeof id !== 'string' || !WINDOWS_LOGIN_ID.test(id)) throw new Error('Invalid sign-in launch id.')
  return `Global\\automagik-login-${id}`
}

export function loginControlRoot(env) {
  if (!env.AUTOMAGIK_BOT_CLI_HOME) return join(tmpdir(), 'automagik-login-jobs')
  const pointer = env.AUTOMAGIK_BOT_CLI_POINTER
  if (!pointer) throw new Error('The Bot sign-in folder is incomplete.')
  return join(dirname(dirname(pointer)), 'login-jobs')
}

export function systemPowerShell(env) {
  const system = read(env, 'SystemRoot') ?? 'C:\\Windows'
  const powershell = win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0',
    'powershell.exe')
  // The isolated Bot env masks PSModulePath. Pin the supervisor's built-in commands to
  // Windows' own modules, without copying any terminal profile or restoring its credentials.
  // The script restores the vendor's original value after loading its supervisor code.
  const supervisorEnv = Object.fromEntries(Object.entries(env).filter(([name]) => (
    name.toLowerCase() !== 'psmodulepath'
  )))
  supervisorEnv.PSModulePath = win32.join(win32.dirname(powershell), 'Modules')
  return { powershell, env: supervisorEnv }
}

export function launchWindowsLogin(file, args, options = {}, {
  spawn = spawnProcess, taskkill = execFile, stopMs = 5000,
} = {}) {
  const id = options.launch
  const job = windowsJobName(id)
  const appStart = options.appStart ?? null
  if (appStart !== null && !validWindowsStart(appStart)) throw new Error('Invalid sign-in app birth.')
  const env = options.env ?? process.env
  const root = options.control ?? loginControlRoot(env)
  const directory = join(root, id)
  const stopFile = join(directory, 'stop')
  const doneFile = join(directory, 'done')
  const nonce = randomUUID()
  const request = { ...windowsLoginCommand(file, args, env), cwd: options.cwd,
    stop: stopFile, done: doneFile, nonce, modulePath: read(env, 'PSModulePath') ?? null,
    launch: id, job, app: process.pid, appStart,
    identity: join(directory, 'supervisor'), members: join(directory, 'members') }
  const system = systemPowerShell(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(directory, { mode: 0o700 })
  let child
  try {
    child = spawn(system.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', SUPERVISOR], {
      // Keep libuv's app-lifetime Job in addition to the supervisor's parent watch.
      ...options, detached: false, shell: false, windowsHide: true,
      env: { ...system.env, AUTOMAGIK_LOGIN_JOB: JSON.stringify(request) },
    })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  let verified = false
  let closed = false
  let spawnFailed = false
  let stopping
  const dispose = () => {
    if (verified) try { rmSync(directory, { recursive: true, force: true }) } catch {}
  }
  const done = new Promise((resolve, reject) => {
    child.once('error', () => {
      // spawn failed: no supervisor or vendor process exists.
      if (child.pid === undefined) {
        spawnFailed = verified = true
        dispose()
        resolve()
        return
      }
      reject(failed())
    })
    child.once('close', () => {
      closed = true
      if (spawnFailed) return
      try { verified = readFileSync(doneFile, 'utf8') === nonce } catch {}
      if (!verified) { reject(failed()); return }
      resolve()
    })
  })
  done.catch(() => {})
  const stop = () => {
    if (verified) return Promise.resolve()
    if (stopping) return stopping
    stopping = (async () => {
      writeFileSync(stopFile, '', { mode: 0o600 })
      let timer
      try {
        await Promise.race([done, new Promise((_, reject) => {
          timer = setTimeout(() => reject(failed()), stopMs)
        })])
      } catch {
        // This also closes the kill-on-close Job handle. Without a proof, remain paused.
        if (!closed && child.exitCode === null && child.signalCode === null
          && Number.isInteger(child.pid) && child.pid > 1) {
          await new Promise(resolve => {
            try {
              taskkill('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true, timeout: 3000,
              }, () => resolve())
            } catch { resolve() }
          })
        }
        if (!verified) throw failed()
      } finally { clearTimeout(timer) }
    })().finally(() => { stopping = undefined })
    return stopping
  }
  return { child, done, stop, dispose,
    identity: { kind: 'windows', supervisor: child.pid, job } }
}
