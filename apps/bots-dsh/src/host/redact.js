// The credential shapes removed from diagnostics, installer output and failure rows, and before
// text crosses a provider boundary (a Session's transcript replayed into another provider, both
// ways: out to an agent, and back to a native provider). Ingest is not a crossing: an agent's
// own answer is logged as it said it. This is the one edited source;
// apps/acp-dsh/src/host/redact.js, apps/welcome-dsh/src/host/redact.js and
// apps/welcome-dsh/src/client/redact.js are byte-equal copies (each plugin installs on its own),
// checked by scripts/redact-copies.test.ts.
//
// The secret store belongs to the Bot team's runtime (`omniTeam`), which composes only where
// Bots run; acp-dsh reads it when it is there and never requires it. A chat that is not a Bot's
// has no secret store, so only the credential shapes apply.
//
// No imports: the client copy is bundled into the welcome's browser half.
const CREDENTIAL_MARK = '[hidden]'

export const CREDENTIALS = Object.freeze([
  [/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-[hidden]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, CREDENTIAL_MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, CREDENTIAL_MARK],
  [/\bAKIA[0-9A-Z]{16}\b/g, CREDENTIAL_MARK],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, CREDENTIAL_MARK],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, CREDENTIAL_MARK],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, CREDENTIAL_MARK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]{8,}/gi, `$1 ${CREDENTIAL_MARK}`],
  // Provider and code-host keys whose own prefix the rules above do not cover. Each needs a
  // long enough body that ordinary words cannot match it.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/g, CREDENTIAL_MARK],
  [/\bwhsec_[A-Za-z0-9+/=]{12,}/g, CREDENTIAL_MARK],
  [/\bhf_[A-Za-z0-9]{16,}/g, CREDENTIAL_MARK],
  [/\bgl(?:pat|oas|rt)-[A-Za-z0-9_-]{12,}/g, CREDENTIAL_MARK],
  [/\bgsk_[A-Za-z0-9_-]{16,}/g, CREDENTIAL_MARK],
  [/\br8_[A-Za-z0-9]{16,}/g, CREDENTIAL_MARK],
  [/\bdop_v1_[a-f0-9]{24,}/gi, CREDENTIAL_MARK],
  [/\bshp(?:at|ca|pa|ss)_[a-f0-9]{24,}/gi, CREDENTIAL_MARK],
  [/\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, CREDENTIAL_MARK],
  [/\bya29\.[A-Za-z0-9_-]{16,}/g, CREDENTIAL_MARK],
  [/\bnfp_[A-Za-z0-9]{16,}/g, CREDENTIAL_MARK],
  [/\bvercel_[A-Za-z0-9]{16,}/g, CREDENTIAL_MARK],
  [/\bsbp_[a-f0-9]{24,}/gi, CREDENTIAL_MARK],
  [/\bATBB[A-Za-z0-9]{16,}/g, CREDENTIAL_MARK],
  [/([?&#](?:token|access[_-]?token|api[_-]?key|apikey|key|secret|password|passwd|auth|authorization|client[_-]?secret|x-api-key|signature|sig|code|ticket)=)[^&#\s"']+/gi, `$1${CREDENTIAL_MARK}`],
  // npm registry credentials: an access token (8+ chars; shorter is indistinguishable from a
  // package name), the .npmrc keys as JSON (quoted key or value), their npm_config_* env
  // spelling, NPM_TOKEN, and any userinfo in an http(s) URL. The userinfo rule is greedy to
  // the last @ before the path, so a password with an unencoded @ or a token-only userinfo is
  // covered too.
  [/\bnpm_[A-Za-z0-9]{8,}/g, 'npm_[hidden]'],
  [/(\bnpm_config_(?:_?authToken|_?auth|_?password)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/gi, `$1${CREDENTIAL_MARK}`],
  [/(\b_(?:authToken|auth|password)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/gi, `$1${CREDENTIAL_MARK}`],
  // Any env name ending in NPM_TOKEN or AUTH_TOKEN (NPM_TOKEN, MY_NPM_TOKEN, NODE_AUTH_TOKEN),
  // as a key with = or :, JSON-quoted keys included.
  [/(\b[A-Z0-9_]*(?:NPM_TOKEN|AUTH_TOKEN)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/gi, `$1${CREDENTIAL_MARK}`],
  [/(\bhttps?:\/\/)[^/\s]+@/gi, `$1${CREDENTIAL_MARK}@`],
  [/(["']?(?:(?:[a-z0-9]+[-_.])*(?:api[_-]?key|authorization|x-api-key|x-auth-token|x-amz-security-token|proxy-authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret))["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, `$1${CREDENTIAL_MARK}`],
])

/** Remove credential-shaped strings from text before it is stored or shown. */
export function redactText(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement)
  return out
}

/** A string with every credential shape masked; other types pass through untouched. */
export function credentialShapes(text) {
  return typeof text === 'string' ? redactText(text) : text
}

/**
 * The redactor for one Session: the credential shapes first, then the Bot team's saved secrets
 * (when its runtime is composed). The order matters: a saved secret's own label is
 * `[secret:<NAME>]`, and running the shapes over it would mask the label. A store that throws is
 * skipped, never fatal: text that cannot be redacted by it still loses the shapes, and a broken
 * store must not block a turn.
 * @param {{ get?: (name: string) => any } | undefined} ctx the plugin's context
 * @returns {(text: string) => string}
 */
export function redactorFor(ctx) {
  const team = (() => {
    try {
      return ctx?.get?.('omniTeam')
    } catch {
      return undefined
    }
  })()
  const saved = typeof team?.redactSecrets === 'function' ? team.redactSecrets : undefined
  return (text) => {
    if (typeof text !== 'string') return text
    const shaped = credentialShapes(text)
    if (saved === undefined) return shaped
    try {
      return String(saved.call(team, shaped) ?? shaped)
    } catch {
      // The store's values still apply at its own source; the shapes above always land.
      return shaped
    }
  }
}
