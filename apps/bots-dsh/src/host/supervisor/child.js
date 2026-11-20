import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as wait } from 'node:timers/promises'

const CHILD_STOP_MS = 30_000
const LAUNCH_URL = /dsh web: (https?:\/\/\S*token=\S+)/
const HEALTH_MS = 60_000

export function startChild([node, ...args], env, onExit) {
  const processChild = spawn(node, args, { env, stdio: ['inherit', 'pipe', 'pipe'] })
  const child = { launchUrl: null, result: null, expectedExit: false }
  let stopping
  for (const [stream, output] of [[processChild.stdout, process.stdout], [processChild.stderr, process.stderr]]) {
    stream.pipe(output, { end: false })
    createInterface({ input: stream }).on('line', line => {
      child.launchUrl ??= LAUNCH_URL.exec(line)?.[1] ?? null
    })
  }
  child.exited = new Promise(resolve => {
    const finish = (code, signal) => {
      if (child.result) return
      child.result = { code: code ?? (signal ? 0 : 1), signal }
      resolve(child.result)
      onExit(child)
    }
    processChild.once('exit', finish)
    processChild.once('error', () => finish(1, null))
  })
  child.stop = (signal = 'SIGTERM') => {
    if (child.result) return child.exited
    child.expectedExit = true
    processChild.kill(signal)
    if (!stopping) {
      const timer = setTimeout(() => processChild.kill('SIGKILL'), CHILD_STOP_MS)
      stopping = child.exited.finally(() => clearTimeout(timer))
    }
    return stopping
  }
  return child
}

export async function answers(child, { signal, fetch = globalThis.fetch, timeout = HEALTH_MS } = {}) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean))
  while (!deadline.aborted && !child.result) {
    const url = URL.parse(child.launchUrl ?? '')
    if (url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      try {
        // Only the socket's HTTP response is needed in delivery 5a. Keep the token in memory.
        const response = await fetch(url.origin, {
          redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(1000)]),
        })
        void response.body?.cancel().catch(() => {})
        return !child.result && !deadline.aborted
      } catch {}
    }
    await wait(250, undefined, { signal: deadline }).catch(() => {})
  }
  return false
}

export function runCommand(node, args, { cwd, env, signal, timeout = 120_000 } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(node, args, { cwd, env, stdio: 'ignore', detached: true }) } catch (error) {
      reject(error)
      return
    }
    const stop = () => {
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(stop, timeout)
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', reject)
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (code === 0 && !signal?.aborted) resolve()
      else reject(new Error('Supervisor subprocess failed'))
    })
  })
}
