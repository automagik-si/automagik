import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { machine as osMachine } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import { isFile, tracing } from '../bw/run.js'
import { maxResponse, requestOf } from './parse.js'
import { readerArgs } from './script.js'

export const root = 'C:\\Windows'
export const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
export const taskkill = win32.join(root, 'System32', 'taskkill.exe')
const cleanupMs = 5000
// Node initializes native diagnostics at startup, independently of util.debuglog.
const nativeDebugAtLoad = Boolean(process.env.NODE_DEBUG_NATIVE)
const tracesPipes = () => tracing() || nativeDebugAtLoad || Boolean(process.env.NODE_DEBUG_NATIVE)
  || (process.env.NODE_DEBUG ?? '').split(/[\s,]+/).some(category => category.toLowerCase() === 'stream')
const windowsRoot = value => typeof value === 'string' && value.toLowerCase() === root.toLowerCase()

export function availability({
  platform = process.platform, arch = process.arch, machine = osMachine(), parent = process.env,
  exists = isFile, systemDirectory, isCloud = () => Boolean(parent.AUTOMAGIK_GATE_CLOUD_WORKSPACE?.trim()),
} = {}) {
  if (platform !== 'win32') return 'platform'
  if (isCloud()) return 'cloud'
  if (arch !== 'x64' || !/^(x64|x86_64|amd64)$/i.test(machine)) return 'arch'
  for (const key of ['systemroot', 'windir']) {
    const values = Object.entries(parent).filter(([name]) => name.toLowerCase() === key)
    if (!values.length || values.some(([, value]) => !windowsRoot(value))) return 'root'
  }
  if ((systemDirectory !== undefined && !windowsRoot(systemDirectory))
    || !exists(powershell) || !exists(taskkill)) return 'root'
}

export const environment = cwd => ({
  SystemRoot: root, windir: root, PATH: win32.join(root, 'System32') + ';' + root, TEMP: cwd, TMP: cwd,
})

function scratch(profile) {
  if (typeof profile !== 'string' || !isAbsolute(profile)) throw new Error('No vault data folder')
  const home = realpathSync(profile)
  const folder = join(home, 'vault-dsh')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder) throw new Error('Invalid vault data folder')
  return mkdtempSync(join(folder, 'wincred-'))
}

export function createRunner({
  profileDir, spawnChild = spawn, removeScratch = rm, timers = globalThis, ...host
} = {}) {
  const cleanups = new Set()
  const available = () => availability(host)
  let unconfirmed = 0

  function trackCleanup(work, expire) {
    let clock
    const deadline = new Promise(resolve => {
      clock = timers.setTimeout(() => {
        expire?.()
        resolve('unconfirmed')
      }, cleanupMs)
    })
    const cleanup = Promise.race([deadline, work()]).then(status => {
      timers.clearTimeout(clock)
      cleanups.delete(cleanup)
      if (status === 'unconfirmed') unconfirmed++
      return status
    })
    cleanups.add(cleanup)
    return cleanup
  }

  const remove = cwd => Promise.resolve().then(() => removeScratch(cwd, { recursive: true, force: true }))
    .then(() => 'confirmed', () => 'unconfirmed')

  function run(op, target, { timeout, signal, onTimeout } = {}) {
    const stdin = requestOf(op, target)
    if (!stdin || tracesPipes() || available() !== undefined || signal?.aborted) {
      return Promise.resolve({ failure: 'refused' })
    }
    let cwd, child
    try {
      cwd = scratch(profileDir?.())
      child = spawnChild(powershell, readerArgs, {
        cwd, env: environment(cwd), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      return Promise.resolve({ failure: 'refused', ...(cwd ? { cleanup: trackCleanup(() => remove(cwd)) } : {}) })
    }
    return new Promise(resolve => {
      let done = false
      let exited = false
      let length = 0
      let deadline
      const chunks = []
      const complete = result => {
        done = true
        timers.clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        resolve(result)
      }
      const terminate = (failure) => {
        if (done) return
        chunks.length = 0
        // Keep the operation deadline independent of the cleanup and the pipe-close event.
        let killer
        let expired = false
        const cleanup = trackCleanup(() => new Promise(settled => {
          const pid = child.pid
          if (exited || child.exitCode != null || child.signalCode != null || !Number.isInteger(pid) || pid <= 0) {
            settled(pid === undefined ? 'confirmed' : 'unconfirmed')
            return
          }
          try {
            killer = spawnChild(taskkill, ['/T', '/F', '/PID', String(pid)], {
              cwd, env: environment(cwd), shell: false, windowsHide: true, stdio: 'ignore',
            })
          } catch { settled('unconfirmed'); return }
          killer.once('error', () => settled('unconfirmed'))
          killer.once('exit', (code, sig) => settled(code === 0 && !sig ? 'confirmed' : 'unconfirmed'))
        }).then(status => status === 'confirmed' && !expired ? remove(cwd) : 'unconfirmed'), () => {
          expired = true
          try {
            if (killer && killer.exitCode == null && killer.signalCode == null) killer.kill()
          } catch {}
        })
        complete({ failure, cleanup })
        if (failure === 'timeout') onTimeout?.()
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref?.()
      }
      const abort = () => terminate('canceled')
      deadline = timers.setTimeout(() => terminate('timeout'), timeout)
      child.once('exit', () => { exited = true })
      child.once('error', () => terminate('refused'))
      child.stdin?.on('error', () => terminate('refused'))
      child.stdout?.on('error', () => terminate('refused'))
      child.stderr?.on('error', () => terminate('refused'))
      child.stdout?.on('data', bytes => {
        if (done) return
        length += bytes.length
        if (length > maxResponse) terminate('refused')
        else chunks.push(bytes)
      })
      child.stderr?.on('data', bytes => { if (bytes.length) terminate('refused') })
      child.once('close', (code, sig) => {
        if (done) return
        const cleanup = trackCleanup(() => remove(cwd))
        complete({ code, signal: sig, stdout: Buffer.concat(chunks, length), stderr: Buffer.alloc(0), cleanup })
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else {
        try { child.stdin.end(stdin) } catch { terminate('refused') }
      }
    })
  }

  return {
    availability: available, run,
    async prepareQuit() {
      await Promise.all(cleanups)
      return { ok: unconfirmed === 0, unconfirmed }
    },
  }
}
