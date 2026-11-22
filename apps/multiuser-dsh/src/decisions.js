import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { verifyJws } from './assertion.js'

export const DEFAULT_DECISION_SOCKET = 'automagik-gate-decision'
export function decisionSocketAddress(
  name = process.env.AUTOMAGIK_GATE_DECISION_SOCKET ?? DEFAULT_DECISION_SOCKET,
) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error('Invalid gate decision socket name')
  }
  return '\0' + name
}

const MAX_REPLY = 2048
const DEADLINE_MS = 2000
const allowed = new Set(['owner', 'admin', 'member', 'guest'])
const canonicalHash = value => typeof value === 'string' && value.length === 43 &&
  Buffer.from(value, 'base64url').toString('base64url') === value

function verifyDecision(token, keys, instance, session, challenge, now) {
  const claims = verifyJws(token, {
    keys, instance, type: 'automagik-decision', maxBytes: MAX_REPLY,
  })
  const { version, aud, session: echoed, challenge: answer, active, resolved,
    person, roles, iat, exp } = claims
  const fields = active ? 'active,aud,challenge,exp,iat,person,resolved,roles,session,version' :
    'active,aud,challenge,exp,iat,resolved,session,version'
  if (version !== 1 || typeof aud !== 'string' || !aud || echoed !== session ||
      answer !== challenge || typeof active !== 'boolean' || typeof resolved !== 'boolean' ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp - iat !== 5 ||
      exp <= now || iat > now + 5 || Object.keys(claims).sort().join(',') !== fields) return
  if (!active) return { active: false }
  if (!canonicalHash(person) || !Array.isArray(roles) || new Set(roles).size !== roles.length ||
      roles.some(role => !allowed.has(role))) return
  return { active: true, person, roles, resolved }
}

export function createDecisionClient({ keys, instance, name, disposed, now = Date.now }) {
  const socketPath = decisionSocketAddress(name)
  return async (session, signal) => {
    if (!canonicalHash(session) || signal?.aborted || disposed?.aborted) return
    const deadline = performance.now() + DEADLINE_MS
    try {
      const timeout = AbortSignal.timeout(DEADLINE_MS)
      const abort = AbortSignal.any([timeout, signal, disposed].filter(Boolean))
      const challenge = randomBytes(16).toString('base64url')
      const body = JSON.stringify({ session, challenge })
      return await new Promise(resolve => {
        const headers = { host: 'localhost', 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body) }
        const options = { socketPath, path: '/decision', method: 'POST', agent: false,
          signal: abort, headers }
        let received = false
        const finish = result => {
          abort.removeEventListener('abort', fail)
          resolve(result)
        }
        const fail = () => { finish(undefined); req.destroy() }
        const req = request(options, res => {
          received = true
          res.on('error', fail)
          if (res.statusCode !== 200 || res.headers['content-type'] !== 'application/jose' ||
              Number(res.headers['content-length']) > MAX_REPLY) { fail(); return }
          const chunks = []
          let size = 0
          res.on('data', chunk => {
            size += chunk.length
            if (size > MAX_REPLY || performance.now() >= deadline) { fail(); return }
            chunks.push(chunk)
          })
          res.on('end', () => {
            if (abort.aborted || performance.now() >= deadline) { fail(); return }
            try {
              const result = verifyDecision(Buffer.concat(chunks).toString(), keys, instance,
                session, challenge, Math.floor(now() / 1000))
              finish(performance.now() < deadline && !abort.aborted ? result : undefined)
            } catch { fail() }
          })
        })
        req.once('error', fail)
        req.once('upgrade', (_res, socket) => { socket.destroy(); fail() })
        req.once('close', () => { if (!received) fail() })
        abort.addEventListener('abort', fail, { once: true })
        if (abort.aborted) fail()
        else req.end(body)
      })
    } catch {}
  }
}
