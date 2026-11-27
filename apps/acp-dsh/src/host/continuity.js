// Native cold continuity (docs/research/t3-code-acp-integration.md, recommendation 2): after a
// restart, the same agent in the same chat takes back its own native session instead of a new
// one fed the DSH transcript. The chat's own log holds what that takes, as ignorable plugin
// records (a reader that does not know them skips them, so old and new chats both open):
//
//   plugin:acp-dsh/native-session  { v, provider, nativeSessionId, digest, state, ordinal?, outcome? }
//                                  state 'idle' after a start or a prompt's end, 'sent' while a
//                                  prompt is written and not answered. A 'sent' last record is
//                                  an uncertain dispatch: the agent may have acted on it.
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

/** The parts a native session is bound to, each a string or null. */
export function bindingOf({ provider, dshSessionId, connector, home, account, cwd, identity, policy }) {
  const text = value => (value === undefined || value === null ? null : String(value))
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
  if (record === undefined) return { skip: 'no-binding' }
  if (record.v !== BINDING_VERSION || typeof record.nativeSessionId !== 'string' || record.nativeSessionId === '') return { skip: 'no-binding' }
  if (record.digest !== digest) return { skip: 'binding-changed' }
  return { sessionId: record.nativeSessionId, methods: route.methods, interrupted: record.state === 'sent' }
}

/** Writes one native-session record; never fails the turn (a log that will not take it starts fresh next time). */
export function writeNative(session, data, warn) {
  try {
    appendPluginRecord(session, NATIVE_RECORD, { v: BINDING_VERSION, ...data })
  } catch (error) {
    try { warn?.(`the native session binding was not written: ${error?.message ?? error}`) } catch {}
  }
}

/** The plans this chat shows, folded from its plan records: what a reopened chat draws. */
export function plansFromLog(events) {
  const plans = new Plans()
  for (const event of events) {
    if (event?.type !== PLAN_RECORD || event.ignorable !== true) continue
    const change = event.data?.change
    if (change === undefined) continue
    if (change.removed === true) plans.take({ planId: change.planId, removed: true })
    else plans.take(change)
  }
  return plans.list().map(({ planId, type, entries, markdown, path }) => ({ planId, type, ...(type === 'markdown' ? { markdown, ...(path === undefined ? {} : { path }) } : { entries }) }))
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
