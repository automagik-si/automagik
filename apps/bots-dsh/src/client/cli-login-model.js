// Pure pieces of the sign-in row (plan v3, 2.3): which agents sign in, which chats may show the
// row, and the Claude states this page has shown. No React, no requests, no storage.
import { SIGN_IN_TEXT_MAX } from '../shared/cli-login.js'

// The agents a Bot's chat signs in to, by their DSH provider id.
export const CLI_NAMES = Object.freeze({ 'acp-codex': 'Codex', 'acp-claude': 'Claude Code' })

export const cliProviderOf = ref => {
  const provider = typeof ref === 'string' ? ref.split('/')[0] : undefined
  return Object.hasOwn(CLI_NAMES, provider) ? provider : undefined
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

export const knowsStates = () => KNOWN.size > 0

// Spaces, line breaks and invisible characters do not hide a pasted code.
const squeeze = text => text.slice(0, SIGN_IN_TEXT_MAX).replace(/[\s\p{Cf}]+/gu, '')

/** Whether a text carries `#<state>` of a state this page showed. Exact values only, never a pattern. */
export function carriesKnownState(text) {
  if (typeof text !== 'string' || text === '' || KNOWN.size === 0) return false
  const flat = squeeze(text)
  for (const state of KNOWN) if (flat.includes(`#${state}`)) return true
  return false
}

// For tests: forget the states, as a new page would.
export function forgetKnownStates() { KNOWN.clear() }

// When a row that ended on its own goes away (D17).
export const DONE_MS = 3000
export const APPLY_FAILED_MS = 8000
