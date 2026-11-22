import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { DEFAULT_DECISION_SOCKET, decisionSocketName } from './gate-decision-name.mjs'

export { DEFAULT_DECISION_SOCKET, decisionSocketName }
export function decisionSocketAddress(name = process.env.AUTOMAGIK_GATE_DECISION_SOCKET) {
  return '\0' + decisionSocketName(name)
}

const MAX_HEADERS = 16 * 1024
const MAX_BODY = 1024
const MAX_REPLY = 2048
const MAX_CONNECTIONS = 64
const DEADLINE_MS = 2000
const MAX_HOPS = 8
const headerLine = /^([!#$%&'*+.^_`|~0-9a-z-]+):([\t\x20-\x7e\x80-\xff]*)$/i

function bodyLength(raw) {
  const [request, ...lines] = raw.toString('latin1').split('\r\n')
  if (request !== 'POST /decision HTTP/1.1') return
  const headers = new Map()
  for (const line of lines) {
    const match = headerLine.exec(line)
    if (!match) return
    const name = match[1].toLowerCase()
    if (headers.has(name)) return
    headers.set(name, match[2].replace(/^[ \t]+|[ \t]+$/g, ''))
  }
  const length = headers.get('content-length')
  if (!headers.get('host') || headers.has('transfer-encoding') ||
      headers.get('content-type')?.toLowerCase() !== 'application/json' ||
      !/^\d+$/.test(length ?? '') || Number(length) > MAX_BODY) return
  return Number(length)
}

const canonicalBase64url = (value, length) =>
  typeof value === 'string' && value.length === length &&
  Buffer.from(value, 'base64url').toString('base64url') === value

function parseBody(raw) {
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    if (body && Object.keys(body).sort().join(',') === 'challenge,session' &&
        canonicalBase64url(body.session, 43) && canonicalBase64url(body.challenge, 22)) {
      return body
    }
  } catch {}
}

function snapshot(sessions, cloud, successors, origin, session) {
  let ceiling
  for (let hops = 0; hops <= MAX_HOPS; hops++) {
    const family = sessions.familyBySessionHash(session)
    if (family && family.origin !== origin) break
    if (family && sessions.active(family) && !cloud?.drops(family)) {
      const { issuer, subject, roles } = family.principal
      return {
        active: true, resolved: hops > 0,
        person: createHash('sha256').update(issuer + '\n' + subject).digest('base64url'),
        roles: ceiling ? roles.filter(role => ceiling.includes(role)) : roles,
      }
    }
    if (hops === MAX_HOPS) break
    const next = successors.get(session)
    if (!next || next.origin !== origin) break
    session = next.session
    ceiling = ceiling ? ceiling.filter(role => next.roles.includes(role)) : next.roles
  }
  return { active: false, resolved: false }
}

export function createDecisionServer({ origin, sessions, cloud, successors, signer, name }) {
  const address = decisionSocketAddress(name)
  const sockets = new Set()
  const server = createServer(socket => {
    socket.on('error', () => socket.destroy())
    if (sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    sockets.add(socket)
    const deadline = performance.now() + DEADLINE_MS
    const timer = setTimeout(() => socket.destroy(), DEADLINE_MS).unref()
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket) })
    const buffer = Buffer.alloc(MAX_HEADERS + MAX_BODY)
    let size = 0, start, end
    const answer = (status, body = '') => {
      socket.off('data', read)
      socket.off('end', incomplete)
      if (performance.now() >= deadline) { socket.destroy(); return }
      const type = body ? 'Content-Type: application/jose\r\n' : ''
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${type}` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy())
    }
    const incomplete = () => answer('400 Bad Request')
    function read(chunk) {
      if (performance.now() >= deadline) { socket.destroy(); return }
      if (size + chunk.length > buffer.length) { incomplete(); return }
      chunk.copy(buffer, size)
      const previous = size
      size += chunk.length
      if (start === undefined) {
        const boundary = buffer.subarray(0, size).indexOf('\r\n\r\n', Math.max(0, previous - 3))
        if (boundary === -1 && size < MAX_HEADERS) return
        if (boundary === -1 || boundary + 4 > MAX_HEADERS) { incomplete(); return }
        const length = bodyLength(buffer.subarray(0, boundary))
        if (length === undefined) { incomplete(); return }
        start = boundary + 4
        end = start + length
      }
      if (size < end) return
      const body = size === end && parseBody(buffer.subarray(start, end))
      if (!body) { incomplete(); return }
      try {
        const decision = snapshot(sessions, cloud, successors, origin, body.session)
        if (performance.now() >= deadline) { socket.destroy(); return }
        const token = signer.signDecision({ ...body, ...decision })
        if (typeof token === 'string' && token && Buffer.byteLength(token) <= MAX_REPLY) {
          answer('200 OK', token)
          return
        }
      } catch {}
      answer('503 Service Unavailable')
    }
    socket.on('data', read)
    socket.once('end', incomplete)
  })
  server.start = () => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => { server.off('error', reject); resolve() })
  })
  server.closeDecision = () => new Promise(resolve => {
    server.close(resolve)
    for (const socket of sockets) socket.destroy()
  })
  return server
}
