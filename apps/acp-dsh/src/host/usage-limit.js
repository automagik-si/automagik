export const ACP_USAGE_LIMIT_CODES = Object.freeze({
  'acp-claude': 'ACP_CLAUDE_USAGE_LIMIT',
  'acp-codex': 'ACP_CODEX_USAGE_LIMIT',
})

// USAGE_LIMIT_ERROR_PREFIXES from @anthropic-ai/claude-agent-sdk as shipped with claude-agent-acp 0.109.0.
export const CLAUDE_USAGE_LIMIT_PREFIXES = Object.freeze([
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage · add funds to continue',
  'Your org is out of usage · contact your admin',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
])

export function usageLimitOf(provider, error) {
  try {
    if (provider === 'acp-codex') {
      const info = error?.data?.codexErrorInfo
      if (info === 'usageLimitExceeded') return true
      if (info === null || typeof info !== 'object') return false
      const proto = Object.getPrototypeOf(info)
      return (proto === Object.prototype || proto === null) && Object.hasOwn(info, 'usageLimitExceeded')
    }
    if (provider !== 'acp-claude') return false
    const data = error?.data
    const kind = data?.errorKind
    if (typeof kind === 'string' && kind !== 'rate_limit') return false
    if (kind === 'rate_limit' && data.rateLimit?.status === 'rejected') return true
    const message = error?.message
    if (typeof message !== 'string') return false
    const text = message.replace(/^Internal error: /, '').trim()
    return CLAUDE_USAGE_LIMIT_PREFIXES.some(prefix => text.startsWith(prefix))
  } catch {
    return false
  }
}
