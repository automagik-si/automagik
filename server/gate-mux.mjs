// A member's or guest's stream carrier and the adapter readiness probe (RFC 0038 delivery 5b).
import net from 'node:net'

// The one upgrade a member or guest may make: DSH's stream mux, carried by the adapter.
export const MEMBER_UPGRADE_PATH = '/api/remote.mux'
export const READY_PATH = '/_automagik/caller/_ready'
const MAX_PROBE_HEADER_BYTES = 8192
const PROBE_TIMEOUT_MS = 2000
const PASSED = new Set([400, 401, 403, 429, 503])

// The carrier's refusals reach the browser as they are; anything else is the gate's 502.
export const memberStatus = code => PASSED.has(code) ? code : 502

export function memberRole(roles) {
  if (roles.includes('member')) return 'member'
  if (roles.length === 1 && roles[0] === 'guest') return 'guest'
  return undefined
}

// Accept exactly one bodyless 204 that names the adapter and keeps the connection open.
function readyAnswer(block) {
  const [status, ...lines] = block.split('\r\n')
  if (status !== 'HTTP/1.1 204 No Content') return false
  const headers = []
  for (const line of lines) {
    const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):([\t\x20-\x7e\x80-\xff]*)$/.exec(line)
    if (field?.[0] !== line) return false
    headers.push([field[1].toLowerCase(), field[2].replace(/^[ \t]+|[ \t]+$/g, '')])
  }
  const values = name => headers.filter(([key]) => key === name).map(([, value]) => value)
  const ready = values('x-automagik-ready')
  const length = values('content-length')
  return ready.length === 1 && ready[0] === '1' &&
    !values('connection').some(value => value.toLowerCase().split(',').some(token => token.trim() === 'close')) &&
    values('transfer-encoding').length === 0 &&
    (length.length === 0 || (length.length === 1 && length[0] === '0'))
}

/**
 * Open a loopback connection to DSH and ask the adapter on it whether it is ready. The member's
 * request then goes on this same connection, so a DSH restart in between breaks the connection
 * instead of reaching a new process before its adapter is live.
 * @returns the probed socket; rejects (and destroys it) on any other answer.
 */
export function probeDsh({ port, host, authority, signal, timeout = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    let received = Buffer.alloc(0)
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      socket.off('data', data)
      socket.off('end', failed)
      socket.off('close', failed)
      socket.off('error', failed)
    }
    const failed = error => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error instanceof Error ? error : new Error('DSH readiness probe refused'))
    }
    const aborted = () => failed(signal.reason)
    const data = chunk => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\r\n\r\n')
      if (end === -1) {
        if (received.length > MAX_PROBE_HEADER_BYTES) failed()
        return
      }
      if (end + 4 > MAX_PROBE_HEADER_BYTES || received.length !== end + 4 ||
          !readyAnswer(received.subarray(0, end).toString('latin1'))) {
        failed()
        return
      }
      settled = true
      cleanup()
      resolve(socket)
    }
    const timer = setTimeout(() => failed(new Error('DSH readiness probe timed out')), timeout)
    timer.unref()
    socket.on('data', data)
    socket.on('end', failed)
    socket.on('close', failed)
    socket.on('error', failed)
    if (signal?.aborted) { failed(signal.reason); return }
    signal?.addEventListener('abort', aborted, { once: true })
    socket.write(`GET ${READY_PATH} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n`)
  })
}
