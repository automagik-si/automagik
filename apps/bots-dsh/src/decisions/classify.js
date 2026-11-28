const HTTP = new Map([
  [400, 'invalid-request'], [401, 'auth'], [402, 'quota'], [403, 'auth'],
  [404, 'invalid-request'], [413, 'too-large'], [415, 'invalid-request'],
  [422, 'invalid-request'], [429, 'rate-limited'], [500, 'server'],
  [502, 'server'], [503, 'server'], [524, 'timeout'], [529, 'overloaded'],
])
const SAFETY = new Set(['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked'])
const NETWORK = /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|CERT_.*|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_.*|ERR_(?:TLS|SSL)_.*|UND_ERR_.*)$/
export const COUNTED = new Set(['timeout', 'rate-limited', 'overloaded', 'server', 'unreachable', 'invalid-response'])
const REASONS = new Set([
  ...HTTP.values(), ...COUNTED, 'busy', 'cancelled', 'refused', 'provider-gone',
  'no-key', 'no-model', 'no-provider', 'breaker-open',
])

export class DecisionProviderError extends Error {
  constructor(reason, { httpStatus, retryAfterMs, cause } = {}) {
    super(reason, { cause })
    this.name = 'DecisionProviderError'
    this.reason = reason
    this.httpStatus = httpStatus
    this.retryAfterMs = retryAfterMs
  }
}

export function classify(error, signal, callerSignal) {
  // The combined signal records which event won even if more sources abort before settlement.
  if (signal?.aborted && (error?.reason !== 'busy' || error === signal.reason)) {
    if (callerSignal?.aborted && signal.reason === callerSignal.reason) return { reason: 'cancelled' }
    const reason = signal.reason
    if (reason instanceof DecisionProviderError) return { reason: reason.reason }
    return { reason: reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' }
  }
  if (callerSignal?.aborted && !signal?.aborted) return { reason: 'cancelled' }

  const status = error?.httpStatus ?? error?.status
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  const retryAfterMs = Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0
    ? error.retryAfterMs : undefined
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : undefined
  let reason = HTTP.get(httpStatus)
  if (httpStatus === 400 && code === 'max_tokens_exceeded') reason = 'too-large'
  if (httpStatus === 400 && (SAFETY.has(code) || ['too-large', 'refused'].includes(error?.reason))) {
    reason = SAFETY.has(code) ? 'refused' : error.reason
  }
  reason ??= REASONS.has(error?.reason) ? error.reason : undefined
  if (!reason && httpStatus >= 500) reason = 'server'
  if (!reason && [error?.code, error?.cause?.code].some(value => typeof value === 'string' && NETWORK.test(value))) {
    reason = 'unreachable'
  }
  reason ??= error?.name === 'TimeoutError' ? 'timeout' : 'invalid-response'
  return { reason, ...(httpStatus !== undefined && { httpStatus }), ...(retryAfterMs !== undefined && { retryAfterMs }) }
}
