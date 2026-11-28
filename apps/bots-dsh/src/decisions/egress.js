import { createHash } from 'node:crypto'

const STATE_LIMIT = 16_000
function prefix(text, length) {
  const splitPair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(length - 1, length + 1))
  return text.slice(0, splitPair ? length - 1 : length)
}

function clipJson(value, budget) {
  const serialized = JSON.stringify(value)
  if (serialized.length <= budget) return value
  if (budget < 2) return undefined
  if (typeof value === 'string') {
    // JSON escaping can expand a prefix. Find the longest one that still fits.
    let low = 0
    let high = budget - 2
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (JSON.stringify(prefix(value, mid)).length <= budget) low = mid
      else high = mid - 1
    }
    return prefix(value, low)
  }
  if (value === null || typeof value !== 'object') return undefined
  const array = Array.isArray(value)
  const entries = []
  let remaining = budget - 2
  for (const [key, child] of Object.entries(value)) {
    const overhead = Number(entries.length > 0) + (array ? 0 : JSON.stringify(key).length + 1)
    const clipped = clipJson(child, remaining - overhead)
    if (clipped === undefined) break
    entries.push([key, clipped])
    if (clipped !== child) break
    remaining -= overhead + JSON.stringify(clipped).length
  }
  return array ? entries.map(([, child]) => child) : Object.fromEntries(entries)
}

export function capState(state) {
  const capped = typeof state === 'string' ? prefix(state, STATE_LIMIT) : clipJson(state, STATE_LIMIT)
  return { state: capped, chars: typeof capped === 'string' ? capped.length : JSON.stringify(capped).length }
}

export function canonicalDigest(input) {
  const canonical = JSON.stringify(input, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value)
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

// Estimate only. Provider tokenizers can differ.
export const estimateTokens = call => Math.ceil(JSON.stringify(call).length / 3.5)
