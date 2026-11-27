// Native cold continuity (docs/research/t3-code-acp-integration.md, recommendation 2): after a
// restart, the same agent in the same chat takes back its own native session instead of a new
// one fed the DSH transcript. The chat's own log holds what that takes, as ignorable plugin
// records (a reader that does not know them skips them, so old and new chats both open):
//
//   plugin:acp-dsh/native-session  { v, provider, nativeSessionId, digest, state, ordinal?, rows? }
//                                  state 'idle' after a start or a prompt's end, 'sent' while a
//                                  prompt is written and not answered. A 'sent' last record is
//                                  an uncertain dispatch: the agent may have acted on it. `rows`
//                                  names the chat rows (their ids) that prompt carried, so a
//                                  restart sends none of them again. 'sent' is on disk before
//                                  the prompt goes out (writeSent), or the prompt does not go.
//   plugin:acp-dsh/plan            one plan change (features.js Plans), for a reopened chat
//   plugin:acp-dsh/usage           one prompt's usage as the agent reported it, once per prompt
//
// The digest binds the native session to everything it was opened under: the DSH session id
// (a copied chat never takes the original's session), the route, the connector build, the CLI
// home and account, the workspace, the Bot's identity and the tool policy. A change in any of
// them, a record without one (a chat from before this), or a route not qualified (`route`) is a
// fresh session, the way it was before: DSH's transcript replay.
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { bindingDigest, Plans } from './features.js'

export const NATIVE_RECORD = 'plugin:acp-dsh/native-session'
export const PLAN_RECORD = 'plugin:acp-dsh/plan'
export const USAGE_RECORD = 'plugin:acp-dsh/usage'
export const BINDING_VERSION = 1
// How far back the log is read for the binding: it is written at every prompt, so the last one
// is near the end; a chat whose last one is further back starts fresh.
const LOOKBACK = 4000

/**
 * The digest of the parts a native session is bound to, or undefined when any part it needs is
 * unknown (fails closed: an unknown account, CLI home, connector build or workspace is never
 * "the same" as another unknown one, so such a start takes no native session and keeps none).
 */
export function bindingOf({ provider, dshSessionId, connector, home, account, cwd, identity, policy }) {
  const text = value => (value === undefined || value === null ? null : String(value))
  for (const part of [provider, dshSessionId, connector, home, account, cwd, identity]) {
    if (typeof part !== 'string' || part === '') return undefined
  }
  return bindingDigest({
    v: String(BINDING_VERSION), provider: text(provider), dshSessionId: text(dshSessionId), connector: text(connector),
    home: text(home), account: text(account), cwd: text(cwd), identity: text(identity),
    policy: policy === undefined ? null : JSON.stringify(policy),
  })
}

function* backwards(session) {
  const last = (session?.seq ?? 0) - 1
  for (let seq = last; seq >= 0 && last - seq < LOOKBACK; seq -= 1) {
    const event = session.eventAt?.(seq)
    if (event === undefined) return
    yield event
  }
}

/** The last native-session record of `provider` in this chat, or undefined. */
export function latestNative(session, provider) {
  for (const event of backwards(session)) {
    if (event.type === NATIVE_RECORD && event.ignorable === true && event.data?.provider === provider) return event.data
  }
  return undefined
}

/**
 * Whether this start takes back a native session: `{ sessionId, methods, interrupted }`, or
 * `{ skip }` with the reason it does not (for the log and the measurement).
 * @param {{ route?: { methods: string[] }, record?: any, digest: string }} input
 */
export function decide({ route, record, digest }) {
  if (route === undefined || !Array.isArray(route.methods) || route.methods.length === 0) return { skip: 'route-not-qualified' }
  if (digest === undefined) return { skip: 'binding-unknown' }
  if (record === undefined) return { skip: 'no-binding' }
  if (record.v !== BINDING_VERSION || typeof record.nativeSessionId !== 'string' || record.nativeSessionId === '') return { skip: 'no-binding' }
  if (record.digest !== digest) return { skip: 'binding-changed' }
  if (record.state !== 'sent') return { sessionId: record.nativeSessionId, methods: route.methods, interrupted: false }
  // An uncertain dispatch that does not say which rows it carried cannot be told apart from the
  // rows after it: the session is not taken back (the chat is replayed to a new one instead).
  if (!Array.isArray(record.rows) || !record.rows.every(id => typeof id === 'string' && id !== '')) return { skip: 'uncertain-rows-unknown' }
  return { sessionId: record.nativeSessionId, methods: route.methods, interrupted: true, rows: [...record.rows] }
}

/** Writes one native-session record; never fails the turn (a log that will not take it starts fresh next time). */
export function writeNative(session, data, warn) {
  try {
    appendPluginRecord(session, NATIVE_RECORD, { v: BINDING_VERSION, ...data })
    return true
  } catch (error) {
    try { warn?.(`the native session binding was not written: ${error?.message ?? error}`) } catch {}
    return false
  }
}

/**
 * Writes the 'sent' record and waits until it is durable (`flush`, DSH's session/flush), before
 * the prompt goes out. Throws when either fails: the caller then sends nothing, so a restart never
 * reads an older 'idle' record as the truth about a prompt the agent may have acted on.
 */
export async function writeSent(session, data, flush) {
  appendPluginRecord(session, NATIVE_RECORD, { v: BINDING_VERSION, ...data, state: 'sent' })
  if (typeof flush === 'function') await flush()
}

const sameScope = (data, scope) => data?.provider === scope.provider && data?.nativeSessionId === scope.nativeSessionId

/**
 * The native session a chat's plans belong to: the last native-session record's, else (a route
 * that keeps no binding) the last plan record's. Undefined when there is neither.
 */
export function planScopeOf(events) {
  let native
  let plan
  for (const event of events) {
    if (event?.ignorable !== true) continue
    if (event.type === NATIVE_RECORD) native = event
    else if (event.type === PLAN_RECORD) plan = event
  }
  const last = native ?? plan
  return last === undefined ? undefined : { provider: last.data?.provider, nativeSessionId: last.data?.nativeSessionId }
}

/**
 * The plans of one native session (`scope`: { provider, nativeSessionId }, by default the chat's
 * current one, planScopeOf), folded from its plan records in order: what a reopened chat draws and
 * what a session taken back starts from. Another native session's plans never come back.
 */
export function plansFromLog(events, scope = planScopeOf(events)) {
  const plans = new Plans()
  if (scope === undefined) return []
  for (const event of events) {
    if (event?.type !== PLAN_RECORD || event.ignorable !== true || !sameScope(event.data, scope)) continue
    const change = event.data?.change
    if (change === undefined) continue
    if (change.removed === true) plans.take({ planId: change.planId, removed: true })
    else plans.take(change)
  }
  return plans.list().map(({ planId, type, entries, markdown, path }) => ({ planId, type, ...(type === 'markdown' ? { markdown, ...(path === undefined ? {} : { path }) } : { entries }) }))
}

/** The plan records of one native session in `session`'s log (bounded, as latestNative), oldest first. */
export function planEventsOf(session, scope) {
  const out = []
  for (const event of backwards(session)) {
    if (event.type === PLAN_RECORD && event.ignorable === true && sameScope(event.data, scope)) out.push(event)
  }
  return out.reverse()
}

/** The usage records of this chat, one per prompt (`runId`, `ordinal`), however often it was read. */
export function usageFromLog(events) {
  const seen = new Map()
  for (const event of events) {
    if (event?.type !== USAGE_RECORD || event.ignorable !== true) continue
    const key = `${event.data?.runId}#${event.data?.ordinal}`
    if (!seen.has(key)) seen.set(key, event.data)
  }
  return [...seen.values()]
}
