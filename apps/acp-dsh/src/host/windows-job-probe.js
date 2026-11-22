import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { systemPowerShell, validWindowsStart, windowsJobName } from './windows-login.js'

const PROBE = fileURLToPath(new URL('./windows-job-probe.ps1', import.meta.url))
const prefix = 'Global\\automagik-login-'
const processStates = new Set(['dead', 'live', 'unknown'])
export const WINDOWS_JOB_PROBE_TIMEOUT_MS = 60_000

export async function probeWindowsLogin(request, {
  exec = execFile, env = process.env, platform = process.platform, timeoutMs = WINDOWS_JOB_PROBE_TIMEOUT_MS,
} = {}) {
  const { job, processes } = request ?? {}
  const unknown = { job: 'unknown', code: null,
    processes: Array.isArray(processes) ? Array.from(processes, () => 'unknown') : [] }
  try {
    if (platform !== 'win32' || typeof job !== 'string' || !job.startsWith(prefix)
      || windowsJobName(job.slice(prefix.length)) !== job
      || !Array.isArray(processes) || processes.length > 66
      || [...processes].some(entry => !Number.isSafeInteger(entry?.pid) || entry.pid <= 1
        || (entry.start !== null && !validWindowsStart(entry.start)))) return unknown
    const system = systemPowerShell(env)
    const output = await new Promise((resolve, reject) => {
      exec(system.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', PROBE], {
        windowsHide: true, timeout: timeoutMs, maxBuffer: 4096,
        env: { ...system.env, AUTOMAGIK_LOGIN_PROBE: JSON.stringify({ job, processes }) },
      }, (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    if (!/^[^\r\n]+(?:\r?\n)?$/.test(output)) return unknown
    const result = JSON.parse(output)
    if (!Array.isArray(result?.processes) || Object.keys(result).length !== 3
      || result.processes.length !== processes.length
      || result.processes.some(state => !processStates.has(state))
      || !Number.isSafeInteger(result.code) || result.code < 0) return unknown
    const expected = result.code === 0 ? 'present' : result.code === 2 ? 'absent' : 'unknown'
    if (result.job !== expected) return unknown
    return result
  } catch { return unknown }
}

export function windowsLoginEnded(result) {
  return result?.job === 'absent' && result.code === 2 && Array.isArray(result.processes)
    && result.processes.length >= 2 && [...result.processes].every(state => state === 'dead')
}
