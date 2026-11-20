import { verify } from 'node:crypto'

const b64 = /^[A-Za-z0-9_-]+$/
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const rolesAllowed = new Set(['member', 'guest'])
const MAX_TARGET_BYTES = 4096
const MAX_ASSERTION_BYTES = 8192

function decode(value) {
  if (typeof value !== 'string' || !b64.test(value)) throw new Error('Invalid segment')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('Noncanonical segment')
  return bytes
}

const field = value => typeof value === 'string' && value.length > 0 && value.length <= 512
function canonicalPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || Buffer.byteLength(path) > MAX_TARGET_BYTES) return false
  const url = new URL('http://dsh.internal' + path)
  return path === url.pathname + url.search
}

export function verifyAssertion(value, { keys, instance, method, path, nowSec, startedAtSec }) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_ASSERTION_BYTES) throw new Error('Invalid assertion size')
  const segments = value.split('.')
  if (segments.length !== 3) throw new Error('Invalid assertion')
  const [h, p, s] = segments
  const { alg, kid, typ } = JSON.parse(decode(h))
  if (alg !== 'EdDSA' || typ !== 'automagik-caller' || decode(kid).length !== 16 || h !== encode({ alg, kid, typ })) {
    throw new Error('Invalid protected header')
  }
  const { version, aud, principal, session, method: signedMethod, path: signedPath, iat, exp, nonce } = JSON.parse(decode(p))
  const { issuer, subject, roles, workspace } = principal
  if (version !== 1 || aud !== workspace || typeof aud !== 'string' || !aud ||
      !field(issuer) || !field(subject) || !Array.isArray(roles) || !roles.length ||
      new Set(roles).size !== roles.length || roles.some(role => !rolesAllowed.has(role)) ||
      (session !== undefined && decode(session).length !== 32) ||
      signedMethod !== method || !/^[A-Z]{1,16}$/.test(signedMethod) ||
      signedPath !== path || !canonicalPath(signedPath) ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp <= nowSec ||
      exp - iat > 60 || iat > nowSec + 5 || iat <= startedAtSec + 5 || decode(nonce).length !== 16 ||
      p !== encode({ version, aud, principal: { issuer, subject, roles, workspace }, session, method, path, iat, exp, nonce })) {
    throw new Error('Invalid caller claims')
  }
  const signature = decode(s)
  const entry = keys.get(kid)
  if (!entry || aud !== (instance ?? entry.instance) || aud !== entry.instance || signature.length !== 64 ||
      !verify(null, Buffer.from(`${h}.${p}`), entry.key, signature)) throw new Error('Caller verification failed')
  return { principal, session, aud, method, path, iat, exp, nonce, kid }
}
