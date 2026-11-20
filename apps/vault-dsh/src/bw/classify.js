import { isIP } from 'node:net'

export const supportedVersion = version => /^2026\.10\.[1-9]\d*$/.test(version)

const networkFailure = /^Syncing failed: FetchError: request to https?:\/\/[^\s]+ failed, reason: (.+)$/
const dnsFailure = /^getaddrinfo (?:ENOTFOUND|EAI_AGAIN|EAI_FAIL) [A-Za-z\d_.-]+$/
const connectFailure = /^connect (?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ECONNRESET) (\S+)$/
const readFailures = new Set([
  'read ETIMEDOUT',
  'read ECONNRESET',
  'write EPIPE',
  'socket hang up',
  'Client network socket disconnected before secure TLS connection was established',
])
const auth = new Set([
  'You are not logged in.',
  'Vault is locked.',
  'Your vault is locked.',
  'Invalid session key.',
  'Session key is invalid.',
  'Session key is expired.',
  'Syncing failed: You are not logged in.',
  'Syncing failed: Invalid session key.',
  'Syncing failed: Unauthorized',
  'Syncing failed: Forbidden',
  'Syncing failed: Response received: 401',
  'Syncing failed: Response received: 403',
  'Syncing failed: HTTP 401',
  'Syncing failed: HTTP 403',
  'Syncing failed: MAC failed.',
  'Syncing failed: Error: MAC failed.',
])

function isNetworkFailure(message) {
  const match = networkFailure.exec(message)
  if (match?.[0] !== message) return false
  const reason = match[1]
  if (readFailures.has(reason) || dnsFailure.test(reason)) return true
  const address = connectFailure.exec(reason)?.[1]
  if (address === undefined) return false
  const host = address.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1')
  return isIP(address) !== 0 || isIP(host) !== 0
}

// BW_RESPONSE writes one JSON envelope to stdout. Any diagnostic on stderr
// makes the outcome ambiguous.
export function envelope(result) {
  if (result === undefined || result.failure !== undefined || result.stderr !== '') return undefined
  try {
    const answer = JSON.parse(result.stdout)
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return undefined
    if (result.code === 0 && answer.success === true && Object.hasOwn(answer, 'data') && !Object.hasOwn(answer, 'message')) return answer
    if (result.code === 1 && answer.success === false && typeof answer.message === 'string' && !Object.hasOwn(answer, 'data')) return answer
  } catch {}
}

export const isAuthFailure = answer => answer?.success === false && auth.has(answer.message)

export function classifySync(version, result) {
  if (!supportedVersion(version)) return 'unknown'
  const answer = envelope(result)
  if (answer?.success === true && answer.data?.object === 'message' && answer.data?.title === 'Syncing complete.') return 'ok'
  if (answer?.success !== false) return 'unknown'
  if (isNetworkFailure(answer.message)) return 'stale-network'
  if (isAuthFailure(answer)) return 'auth'
  return 'unknown'
}
