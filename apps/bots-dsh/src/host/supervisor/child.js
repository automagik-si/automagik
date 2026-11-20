import { execFile, spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { constants } from 'node:os'
import { createInterface } from 'node:readline'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'

const CHILD_STOP_MS = 30_000
const LAUNCH_URL = /dsh web: (https?:\/\/\S*token=\S+)/
const HEALTH_MS = 60_000

function webOption(args, option) {
  let value
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    if (args[index] === option) value = args[++index]
    else if (args[index].startsWith(option + '=')) value = args[index].slice(option.length + 1)
  }
  return value
}

export function localListener(args) {
  const host = webOption(args, '--host') ?? '127.0.0.1'
  const port = webOption(args, '--port') ?? '3080'
  const protocol = webOption(args, '--tls-cert') ? 'https:' : 'http:'
  const publicUrl = webOption(args, '--public-url')
  const ip = isIP(host)
  if ((!ip && host !== 'localhost') || !/^\d+$/.test(port) || Number(port) > 65535) return () => null
  const address = ip === 6 ? '[' + host + ']' : host
  return announcement => {
    let boundPort = Number(port)
    if (boundPort === 0 && publicUrl === undefined) {
      // With --port 0, only an announcement of the listener itself supplies its port.
      const bound = URL.parse(announcement)
      if (bound?.protocol === protocol) boundPort = Number(bound.port || (protocol === 'https:' ? 443 : 80))
    }
    return boundPort ? protocol + '//' + address + ':' + boundPort + '/' : null
  }
}

function redactCredentials(line) {
  // Query values can carry credentials under arbitrary keys, including encoded keys.
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, url => {
    const query = url.indexOf('?')
    const fragment = url.indexOf('#')
    if (query === -1 || (fragment !== -1 && fragment < query)) return url
    const end = fragment === -1 ? url.length : fragment
    const values = url.slice(query + 1, end).split('&').map(field => {
      const equal = field.indexOf('=')
      return equal === -1 ? (field ? '<redacted>' : '') : field.slice(0, equal + 1) + '<redacted>'
    })
    return url.slice(0, query + 1) + values.join('&') + url.slice(end)
  }).replace(/token=(?!<redacted>)(?:"[^"]*"|'[^']*'|[^\s&"'<>]*)/gi, 'token=<redacted>')
}

export function forwardChildOutput(input, output, onLaunchUrl) {
  createInterface({ input }).on('line', line => {
    const match = LAUNCH_URL.exec(line)
    if (match) onLaunchUrl(match[1])
    output.write(redactCredentials(line) + '\n')
  })
}

export function startChild([node, ...args], env, onExit) {
  const processChild = spawn(node, args, { env, stdio: ['inherit', 'pipe', 'pipe'] })
  const child = { launchUrl: null, listener: localListener(args.slice(1)), result: null, expectedExit: false }
  let stopping
  for (const [stream, output] of [[processChild.stdout, process.stdout], [processChild.stderr, process.stderr]]) {
    forwardChildOutput(stream, output, url => { child.launchUrl ??= url })
  }
  child.exited = new Promise(resolve => {
    const finish = (code, signal) => {
      if (child.result) return
      child.result = { code: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1), signal }
      resolve(child.result)
      onExit(child)
    }
    processChild.once('exit', finish)
    processChild.once('error', () => finish(1, null))
  })
  child.stop = (signal = 'SIGTERM') => {
    if (child.result) return child.exited
    child.expectedExit = true
    if (!stopping) {
      processChild.kill(signal)
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
    const listener = child.launchUrl && child.listener(child.launchUrl)
    if (listener) {
      try {
        // Only the socket's HTTP response is needed in delivery 5a. Keep the token in memory.
        const response = await fetch(listener, {
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

const exec = promisify(execFile)

export async function readCommand(command, args, { cwd, env, signal, timeout = 10_000 } = {}) {
  try {
    const { stdout } = await exec(command, args, { cwd, env, signal, timeout, maxBuffer: 256 * 1024 })
    return stdout.trim()
  } catch {
    throw new Error('Supervisor subprocess failed')
  }
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
