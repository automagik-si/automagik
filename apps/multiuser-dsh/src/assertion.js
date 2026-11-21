import { verify } from 'node:crypto'

const b64 = /^[A-Za-z0-9_-]+$/
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const rolesAllowed = new Set(['member', 'guest'])
const ownerRoles = new Set(['owner', 'admin', ...rolesAllowed])
const OWNER_TYPE = 'automagik-owner-caller'
const OWNER_PATH = '/api/omni-ui'
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

function parseJws(value, type, maxBytes = MAX_ASSERTION_BYTES) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
    throw new Error('Invalid assertion size')
  }
  const segments = value.split('.')
  if (segments.length !== 3) throw new Error('Invalid assertion')
  const [h, p, s] = segments
  const { alg, kid, typ } = JSON.parse(decode(h))
  if (alg !== 'EdDSA' || typ !== type || decode(kid).length !== 16 ||
      h !== encode({ alg, kid, typ })) {
    throw new Error('Invalid protected header')
  }
  return { claims: JSON.parse(decode(p)), payload: p, input: `${h}.${p}`, signature: s, kid }
}

function verifySignature({ claims: { aud }, input, signature, kid }, keys, instance) {
  const bytes = decode(signature)
  const entry = keys.get(kid)
  if (!entry || aud !== (instance ?? entry.instance) || aud !== entry.instance ||
      bytes.length !== 64 || !verify(null, Buffer.from(input), entry.key, bytes)) {
    throw new Error('Caller verification failed')
  }
}

export function verifyJws(value, { keys, instance, type, maxBytes }) {
  const parsed = parseJws(value, type, maxBytes)
  verifySignature(parsed, keys, instance)
  return parsed.claims
}

function verifyCaller(value, { keys, instance, method, path, nowSec, startedAtSec }, type) {
  const parsed = parseJws(value, type)
  const { claims, payload, kid } = parsed
  const { version, aud, principal, session, method: signedMethod, path: signedPath,
    iat, exp, nonce } = claims
  const { issuer, subject, roles, workspace } = principal
  const owner = type === OWNER_TYPE
  const allowed = owner ? ownerRoles : rolesAllowed
  if (version !== 1 || aud !== workspace || typeof aud !== 'string' || !aud ||
      !field(issuer) || !field(subject) || !Array.isArray(roles) || !roles.length ||
      new Set(roles).size !== roles.length || roles.some(role => !allowed.has(role)) ||
      (owner && !roles.some(role => role === 'owner' || role === 'admin')) ||
      ((owner || session !== undefined) && decode(session).length !== 32) ||
      signedMethod !== method || !/^[A-Z]{1,16}$/.test(signedMethod) ||
      signedPath !== path || !canonicalPath(signedPath) ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp <= nowSec ||
      exp - iat > 60 || iat > nowSec + 5 || iat <= startedAtSec + 5 || decode(nonce).length !== 16 ||
      payload !== encode({ version, aud, principal: { issuer, subject, roles, workspace },
        session, method, path, iat, exp, nonce })) {
    throw new Error('Invalid caller claims')
  }
  verifySignature(parsed, keys, instance)
  return { principal, session, aud, method, path, iat, exp, nonce, kid }
}

export function verifyAssertion(value, options) {
  return verifyCaller(value, options, 'automagik-caller')
}

export function verifyOwner(request, { keys, instance, nonces, now = Date.now }) {
  try {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== OWNER_PATH || url.search !== '') return
    const value = request.headers.get('x-automagik-owner-assertion')
    // Fetch combines repeated values with a comma, which cannot occur in a compact JWS.
    if (!value || value.includes(',')) return
    const nowSec = nonces.verificationSecond(Math.floor(now() / 1000))
    const { principal, session, nonce, exp } = verifyCaller(value, {
      keys, instance, method: request.method, path: url.pathname,
      nowSec, startedAtSec: nonces.startupSecond,
    }, OWNER_TYPE)
    if (nonces.consume(nonce, exp) === 'ok') return { principal, session }
  } catch {}
}
