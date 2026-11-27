// The start check of one ACP adapter (#958): spawn it, ask `initialize`, and compare the
// protocol version it answers with the one this client speaks. Nothing else is asked: no
// session, so a CLI that is signed out passes, no model request is made and no account is read.
// It is what an adapter must pass before it replaces the one in use (install.js).
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { CLIENT_CAPABILITIES } from './features.js'
import { redactText } from './redact.js'
import { HOME_ENV } from './cli-homes.js'

export const HANDSHAKE_TIMEOUT_MS = 20_000
const STDERR_KEEP = 2000
const EXIT_GRACE_MS = 500

/**
 * @param {{ command: string, args?: string[], env?: Record<string, string>, cwd?: string }} spec
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ protocolVersion: number }>} rejects with why the adapter did not start
 */
export function handshake({ command, args = [], env, cwd }, { timeoutMs = HANDSHAKE_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('the start check was stopped'))
    let child
    try {
      child = spawn(command, args, {
        cwd: env?.[HOME_ENV] ?? cwd,
        env: env?.[HOME_ENV] ? env : { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
    } catch (error) {
      return reject(error)
    }
    let stderr = ''
    let settled = false
    const said = () => {
      const tail = redactText(stderr.trim().split('\n').slice(-3).join(' '))
      return tail === '' ? '' : `: ${tail}`
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try { child.stdin.end() } catch {}
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM') } catch {}
        const hard = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
        hard.unref?.()
        child.once('exit', () => clearTimeout(hard))
      }
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(new Error('the start check was stopped'))
    const timer = setTimeout(() => finish(new Error(`it did not answer initialize within ${Math.round(timeoutMs / 1000)}s${said()}`)), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_KEEP) })
    child.stdin.on('error', () => {})
    child.once('error', error => finish(error))
    child.once('exit', (code, sig) => finish(new Error(`it exited (${sig ?? code}) before it answered initialize${said()}`)))
    let connection
    try {
      connection = client({ name: 'automagik-acp-dsh-check' }).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
    } catch (error) {
      return finish(error)
    }
    connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES }).then(
      (answer) => {
        const version = answer?.protocolVersion
        if (version !== PROTOCOL_VERSION) return finish(new Error(`it speaks ACP protocol version ${version ?? 'unknown'}, and this app speaks version ${PROTOCOL_VERSION}`))
        finish(undefined, { protocolVersion: version })
      },
      (error) => {
        // An adapter that dies closes its output a moment before its exit is reported: the
        // exit (above) says why, so it goes first when it follows at once.
        const failed = () => finish(new Error(`initialize failed: ${error?.message ?? error}${said()}`))
        if (child.exitCode !== null || child.signalCode !== null || !(child.stdout.readableEnded || child.stdout.destroyed)) return failed()
        setTimeout(failed, EXIT_GRACE_MS).unref?.()
      },
    )
  })
}
