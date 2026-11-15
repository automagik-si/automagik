// Shared presentation/settings contract. The soft check line is configurable; the
// protected hard line is not. Invalid legacy/config values never weaken it.
export const DEFAULT_CHECK_RATIO = 0.8
export const HARD_CONTEXT_RATIO = 0.95
export const DEFAULT_RECENT_TOKENS = 16_384

const ratio = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < HARD_CONTEXT_RATIO
const budget = value => Number.isSafeInteger(value) && value > 0

export function contextPolicy(bot = {}, config = {}) {
  return {
    checkRatio: ratio(bot.contextCheckRatio) ? bot.contextCheckRatio : ratio(config.checkRatio) ? config.checkRatio : DEFAULT_CHECK_RATIO,
    recentTokens: budget(bot.contextRecentTokens) ? bot.contextRecentTokens : budget(config.handoffRecentTokens) ? config.handoffRecentTokens : DEFAULT_RECENT_TOKENS,
  }
}

// Validate before applying any part of a profile patch. Null resets optional
// overrides; advanced is a strict presentation-only boolean, never a permission.
export function contextPatch(patch) {
  const result = {}
  for (const [key, valid, description] of [
    ['advanced', value => typeof value === 'boolean', 'a boolean'],
    ['memoryReview', value => value === null || typeof value === 'boolean', 'a boolean or null'],
    ['memoryTidy', value => value === null || typeof value === 'boolean', 'a boolean or null'],
    ['contextCheckRatio', value => value === null || ratio(value), 'a finite number greater than 0 and less than 0.95, or null'],
    ['contextRecentTokens', value => value === null || budget(value), 'a positive safe integer or null'],
  ]) {
    if (patch[key] === undefined) continue
    if (!valid(patch[key])) throw Object.assign(new Error(`${key} must be ${description}`), { code: 'bot/invalid' })
    result[key] = patch[key]
  }
  return result
}
