import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { systemPowerShell } from './windows-login.js'

const script = fileURLToPath(new URL('./windows-chat-home.ps1', import.meta.url))
const scanBoundMs = 15_000

export function probeWindowsChatHome(home, timeout) {
  const system = systemPowerShell(process.env)
  return new Promise(resolve => {
    execFile(system.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, timeout, maxBuffer: 128,
      env: { ...system.env, AUTOMAGIK_CHAT_HOME_PROBE: home },
    }, (error, stdout) => {
      const state = error ? 'unknown' : stdout.trim()
      resolve(state === 'in-use' || state === 'unused' ? state : 'unknown')
    })
  })
}

export async function waitForWindowsChatHome(home, probe) {
  const deadline = performance.now() + scanBoundMs
  let state = 'unknown'
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) break
    state = await probe(home, remaining)
    if (state === 'unused' || deadline - performance.now() <= 250) break
    await delay(250)
  }
  return state
}
