// Pure pieces of the sign-in row (plan v3, 2.3): which agents sign in, which chats may show the
// row, and the Claude and Antigravity states this page has shown. No React, no requests, no
// storage.
import { SIGN_IN_TEXT_MAX } from '../shared/cli-login.js'

// The agents a Bot's chat signs in to, by their DSH provider id.
export const CLI_NAMES = Object.freeze({ 'acp-codex': 'Codex', 'acp-claude': 'Claude Code' })

export const cliProviderOf = ref => {
  const provider = typeof ref === 'string' ? ref.split('/')[0] : undefined
  return Object.hasOwn(CLI_NAMES, provider) ? provider : undefined
}

// The agents a Bot's chat can sign in to (#2048): Claude Code and Codex, plus Antigravity's app sign-in.
// Only the sign-in gates read this; permission, account and usage-limit code keep CLI_NAMES.
export const SIGN_IN_NAMES = Object.freeze({ ...CLI_NAMES, 'acp-antigravity': 'Antigravity' })
export const signInProviderOf = ref => {
  const provider = typeof ref === 'string' ? ref.split('/')[0] : undefined
  return Object.hasOwn(SIGN_IN_NAMES, provider) ? provider : undefined
}

// Only a Bot's chat (rule 10), the Omni Bot included: a group, a task or a plain Session never.
export const cliLoginBotOf = (roster, id) => (typeof id === 'string' ? roster?.byId?.[id] : undefined)

// The Claude states this page has shown, for the whole life of the page (rule 3). Memory only:
// never storage, a draft, a request or a log. Module-level, so a remounted surface keeps them.
const KNOWN = new Set()
const STATE = /^[A-Za-z0-9_-]{8,512}$/

/** Keeps the `state` of a Claude sign-in link this page showed. Returns whether one was kept. */
export function rememberLinkState(url) {
  let state
  try { state = new URL(url).searchParams.get('state') } catch { return false }
  if (typeof state !== 'string' || !STATE.test(state)) return false
  KNOWN.add(state)
  return true
}

// The states of the Antigravity sign-in links this page has shown (#2048, paste-back): a message
// carrying the address the browser ends on (`…state=<s>…`) is refused like a Claude code. Any
// printable state of 8-512 characters: agy's charset is not known.
const KNOWN_CALLBACK = new Set()
const CALLBACK_STATE = /^[^\p{Cc}\s]{8,512}$/u

/** Keeps the `state` of an Antigravity sign-in link this page showed. Returns whether one was kept. */
export function rememberCallbackState(url) {
  let states
  try { states = new URL(url).searchParams.getAll('state') } catch { return false }
  if (states.length !== 1 || !CALLBACK_STATE.test(states[0])) return false
  KNOWN_CALLBACK.add(states[0])
  return true
}

export const knowsStates = () => KNOWN.size > 0 || KNOWN_CALLBACK.size > 0

// Spaces, line breaks and invisible characters do not hide a pasted code.
const squeeze = text => text.slice(0, SIGN_IN_TEXT_MAX).replace(/[\s\p{Cf}]+/gu, '')

// The Antigravity guard, the same words as acp-dsh's host copy (login.js callbackTokens): at most
// 64 `state=` / `state%3d` occurrences per reading, any case; each skipped when the authority
// after the last literal `://` before it (up to the first `/`, `?`, `#`, `\`, whitespace or the
// end, lowercased) is `accounts.google.com`; the text after it, cut at 3 x 512 characters, tested
// raw and decoded once, run by run (a malformed escape stays as it is). No URL is parsed.
const CALLBACK_OCCURRENCES = 64
const CALLBACK_TOKEN = 3 * 512
function authorityBefore(reading, at) {
  const scheme = reading.lastIndexOf('://', at - 3)
  if (scheme < 0) return undefined
  const rest = reading.slice(scheme + 3, scheme + 3 + 64)
  const end = rest.search(/[/?#\\\s]/u)
  return (end < 0 ? rest : rest.slice(0, end)).toLowerCase()
}
const decodeRuns = token => token.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
  try { return decodeURIComponent(run) } catch { return run }
})
function carriesCallbackState(reading) {
  let count = 0
  for (const match of reading.matchAll(/state(?:=|%3d)/giu)) {
    if (++count > CALLBACK_OCCURRENCES) break
    if (authorityBefore(reading, match.index) === 'accounts.google.com') continue
    const start = match.index + match[0].length
    const token = reading.slice(start, start + CALLBACK_TOKEN)
    for (const form of [token, decodeRuns(token)]) {
      for (const state of KNOWN_CALLBACK) if (form.startsWith(state)) return true
    }
  }
  return false
}

/**
 * Whether a text carries `#<state>` of a Claude state, or `state=<state>` of an Antigravity state,
 * this page showed. Exact values only, never a pattern.
 */
export function carriesKnownState(text) {
  if (typeof text !== 'string' || text === '' || (KNOWN.size === 0 && KNOWN_CALLBACK.size === 0)) return false
  const flat = squeeze(text)
  for (const state of KNOWN) if (flat.includes(`#${state}`)) return true
  return KNOWN_CALLBACK.size > 0 && carriesCallbackState(flat)
}

// For tests: forget the states, as a new page would.
export function forgetKnownStates() { KNOWN.clear(); KNOWN_CALLBACK.clear() }

// When a row that ended on its own goes away (D17).
export const DONE_MS = 3000
export const APPLY_FAILED_MS = 8000
