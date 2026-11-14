// App birth identity is not proof that a detached vendor login tree has exited.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const decimal = /^(0|[1-9][0-9]{0,30})$/
const startDate = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}$/
const pidOf = pid => Number.isSafeInteger(pid) && pid > 1
// ps answers at once. A cold Windows PowerShell 5.1 start alone can pass 2 s (CI killed
// every first call at the old 2 s bound), and a timed-out read leaves no usable birth.
const PS_BOUND_MS = 2000
const POWERSHELL_BOUND_MS = 10_000

export function validBirth(value) {
  if (!value || typeof value !== 'object') return false
  if (value.platform === 'linux') return typeof value.boot === 'string' && uuid.test(value.boot) && typeof value.start === 'string' && decimal.test(value.start)
  if (value.platform === 'darwin') return typeof value.start === 'string' && startDate.test(value.start)
  return value.platform === 'win32' && typeof value.start === 'string' && /^[1-9][0-9]{0,18}$/.test(value.start)
}

export function processBirth(pid, { platform = process.platform, read = readFileSync,
  exec = execFileSync, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT } = {}) {
  if (!pidOf(pid)) return null
  try {
    let value
    if (platform === 'linux') {
      const boot = read('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const stat = read(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      if (!stat.startsWith(`${pid} (`) || end < 0 || stat[end + 1] !== ' ') return null
      const fields = stat.slice(end + 2).trim().split(/\s+/)
      if (fields.length < 50 || !/^[A-Za-z]$/.test(fields[0])) return null
      value = { platform, boot, start: fields[19] }
    } else {
      const options = { encoding: 'utf8', timeout: PS_BOUND_MS, maxBuffer: 1024, windowsHide: true }
      let output
      if (platform === 'darwin') {
        output = exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
          ...options, env: { LC_ALL: 'C', TZ: 'UTC' },
        })
      } else if (platform === 'win32') {
        if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) return null
        const script = `$ErrorActionPreference='Stop'; try { [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture) } catch { exit 1 }`
        output = exec(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command', script], { ...options, timeout: POWERSHELL_BOUND_MS })
      } else return null
      value = { platform, start: output.trim().replace(/\s+/g, ' ') }
    }
    return validBirth(value) ? value : null
  } catch { return null }
}

export function processState(pid, birth, { probe = process.kill, identity = processBirth } = {}) {
  if (!pidOf(pid)) return 'unknown'
  try { probe(pid, 0) } catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'unknown' }
  if (!validBirth(birth)) return 'unknown'
  const current = identity(pid)
  if (!validBirth(current) || current.platform !== birth.platform) return 'unknown'
  return current.start === birth.start && (birth.platform !== 'linux' || current.boot === birth.boot) ? 'live' : 'dead'
}
