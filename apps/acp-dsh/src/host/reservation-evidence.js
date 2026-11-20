// Private account evidence from the vendor's own answer (RFC 0024). The owner gets its
// outcome and keyed digests, never these identity fields.
import { createHmac } from 'node:crypto'

export const CODEX_PLAN_CLASSES = Object.freeze({
  personal: Object.freeze(['free', 'go', 'plus', 'pro', 'prolite', 'promax']),
  workspace: Object.freeze([
    'team', 'business', 'self_serve_business_prolite', 'self_serve_business_usage_based',
    'enterprise', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
    'edu', 'edu_plus', 'edu_pro',
  ]),
})

export function codexPlanClass(plan) {
  for (const [group, plans] of Object.entries(CODEX_PLAN_CLASSES)) {
    if (plans.includes(plan)) return group
  }
  return 'unknown'
}

function identity(value, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !value.isWellFormed()) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return false
  }
  return true
}

function emailOf(value) {
  if (!identity(value, 3, 254) || value.trim() !== value) return undefined
  const at = value.indexOf('@')
  return at !== -1 && at === value.lastIndexOf('@') ? value.toLowerCase() : undefined
}

export function claudeReservation(stdout) {
  let seen
  try { seen = JSON.parse(stdout) } catch { return undefined }
  if (typeof seen?.loggedIn !== 'boolean') return undefined
  if (!seen.loggedIn || seen.authMethod !== 'claude.ai' || seen.apiKeySource != null
    || (seen.apiProvider !== undefined && seen.apiProvider !== 'firstParty')) return { person: false }
  const email = emailOf(seen.email)
  return { person: true, vendor: 'claude', ...(email === undefined ? {} : { email }),
    ...(identity(seen.orgId, 1, 200) ? { org: seen.orgId } : {}) }
}

export function codexReservation(result) {
  const account = result?.account
  if (account?.type !== 'chatgpt') return { person: false }
  const email = emailOf(account.email)
  return { person: true, vendor: 'codex', ...(email === undefined ? {} : { email }),
    class: codexPlanClass(account.planType) }
}

// R4 allows a `none` read. A missing or unreadable reservation directory allows with a
// notice. A complete read refuses an exact match owned by another instance, or an existing
// exact file that cannot be read or parsed or has an unknown version. A different exact
// digest with the same loose digest names another account. An ambiguous read refuses any
// loose match owned by another instance, even if this instance also reserved that email.
export function reservationOutcome(evidence) {
  if (evidence == null) return { outcome: 'none', reservable: false, why: 'unknown' }
  if (!evidence.person) return { outcome: 'none', reservable: false, why: 'not-a-subscription' }
  if (evidence.vendor !== 'claude' && evidence.vendor !== 'codex') {
    return { outcome: 'none', reservable: false, why: 'unknown' }
  }
  if (evidence.email === undefined) return { outcome: 'none', reservable: false, why: 'no-email' }
  if (evidence.vendor === 'claude' && evidence.org === undefined) {
    return { outcome: 'ambiguous', reservable: false, why: 'no-organisation' }
  }
  if (evidence.vendor === 'codex' && evidence.class !== 'personal' && evidence.class !== 'workspace') {
    return { outcome: 'ambiguous', reservable: false, why: 'unknown-plan' }
  }
  return { outcome: 'complete', reservable: true }
}

export const validReservationDigest = value => typeof value === 'string'
  && /^[A-Za-z0-9_-]{43}$/.test(value)

export const validReservationKey = key => ArrayBuffer.isView(key) && key instanceof Uint8Array && key.byteLength === 32

export function reservationDigests(evidence, key) {
  if (!validReservationKey(key)) throw new TypeError('A reservation key must be 32 bytes.')
  const { outcome } = reservationOutcome(evidence)
  if (outcome === 'none') return {}
  const { vendor, org, class: planClass, email } = evidence
  const digest = (...fields) => createHmac('sha256', key)
    .update(['automagik-reservation-v1', ...fields].join('\u001f'), 'utf8').digest('base64url')
  return {
    ...(outcome === 'complete' ? { exact: digest('exact', vendor, org ?? planClass, email) } : {}),
    loose: digest('loose', vendor, email),
  }
}
