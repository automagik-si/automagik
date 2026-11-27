// What this client takes from ACP beyond text, thoughts, tools, modes and config: the agent's
// plan, its usage and the reattachment of a native session after a restart. Each is a pure
// reading of the agent's own message here; AgentRun (acp.js) and the adapter decide what DSH
// does with it. `dev/acp-features.json` is the audit of every SDK feature against this file.
import { createHash } from 'node:crypto'

/**
 * What the client tells an agent at `initialize`. Only what this plugin handles end to end is
 * advertised: `plan` (it takes `plan_update` and `plan_removed`, below). Every other client
 * capability stays off; its reason is its row in `dev/acp-features.json`. handshake.js sends the
 * same value, so a sign-in check meets the agent as a chat does.
 */
export const CLIENT_CAPABILITIES = Object.freeze({ plan: Object.freeze({}) })

// A legacy `plan` update has no id: it is the session's one plan, kept under this id.
export const LEGACY_PLAN_ID = 'plan'
const ENTRY_STATUS = new Set(['pending', 'in_progress', 'completed'])
const PRIORITY = new Set(['high', 'medium', 'low'])
export const PLAN_ENTRIES_MAX = 200
export const PLAN_TEXT_MAX = 4000

const shortText = (value, max = PLAN_TEXT_MAX) => (typeof value === 'string' ? value.slice(0, max) : '')

/**
 * One plan update as DSH keeps it: `{ planId, type: 'items', entries }`,
 * `{ planId, type: 'markdown', markdown }`, `{ planId, removed: true }`, or undefined for a shape
 * this client does not read (the SDK has validated the update; a shape it adds later lands here).
 */
export function planOf(update) {
  if (update?.sessionUpdate === 'plan') {
    return { planId: LEGACY_PLAN_ID, type: 'items', entries: entriesOf(update.entries) }
  }
  if (update?.sessionUpdate === 'plan_removed') {
    return typeof update.planId === 'string' && update.planId !== '' ? { planId: update.planId, removed: true } : undefined
  }
  if (update?.sessionUpdate !== 'plan_update') return undefined
  const plan = update.plan
  if (typeof plan?.planId !== 'string' || plan.planId === '') return undefined
  if (plan.type === 'items') return { planId: plan.planId, type: 'items', entries: entriesOf(plan.entries) }
  if (plan.type === 'markdown' && typeof plan.markdown === 'string') {
    return { planId: plan.planId, type: 'markdown', markdown: shortText(plan.markdown, PLAN_TEXT_MAX * 4) }
  }
  return undefined
}

function entriesOf(entries) {
  if (!Array.isArray(entries)) return []
  return entries.slice(0, PLAN_ENTRIES_MAX).map(entry => ({
    content: shortText(entry?.content),
    status: ENTRY_STATUS.has(entry?.status) ? entry.status : 'pending',
    priority: PRIORITY.has(entry?.priority) ? entry.priority : 'medium',
  }))
}

/**
 * The plans of one agent session, in the order they first appeared. `take` answers the change
 * an update makes, or undefined when it changes nothing (a removal of an unknown id, which
 * ACP says a client MUST ignore, or an update equal to the plan already held).
 */
export class Plans {
  constructor() {
    this.byId = new Map()
    this.next = 0
  }

  take(plan) {
    const held = this.byId.get(plan.planId)
    if (plan.removed === true) {
      if (held === undefined) return undefined
      this.byId.delete(plan.planId)
      return { planId: plan.planId, removed: true, order: held.order, revision: held.revision + 1 }
    }
    const body = plan.type === 'markdown' ? { type: 'markdown', markdown: plan.markdown } : { type: 'items', entries: plan.entries }
    if (held !== undefined && JSON.stringify(held.body) === JSON.stringify(body)) return undefined
    const order = held?.order ?? this.next++
    const revision = (held?.revision ?? -1) + 1
    this.byId.set(plan.planId, { order, revision, body })
    return { planId: plan.planId, order, revision, ...body }
  }

  /** The plans as DSH shows them, first seen first. */
  list() {
    return [...this.byId.entries()].sort(([, a], [, b]) => a.order - b.order).map(([planId, { order, revision, body }]) => ({ planId, order, revision, ...body }))
  }
}

/**
 * The checklist DSH's own todo panel draws (`todo/write`): every items plan's entries, in plan
 * order, and nothing for a markdown plan (it has no statuses). Duplicate or empty entry text is
 * dropped, as `todo_write` refuses it.
 */
export function todosOf(plans) {
  const seen = new Set()
  const todos = []
  for (const plan of plans) {
    if (plan.type !== 'items') continue
    for (const entry of plan.entries) {
      const content = entry.content.trim()
      if (content === '' || seen.has(content)) continue
      seen.add(content)
      todos.push({ content, status: entry.status })
    }
  }
  return todos
}

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined)

/**
 * What a `usage_update` says: the context the session holds now (`used` of `size` tokens) and,
 * when sent, the agent's own cumulative cost. Latest wins: it is occupancy, never added up.
 */
export function contextOf(update) {
  const used = count(update?.used)
  const size = count(update?.size)
  if (used === undefined || size === undefined) return undefined
  const cost = update.cost
  return {
    used, size,
    ...(cost !== null && typeof cost === 'object' && Number.isFinite(cost.amount) && typeof cost.currency === 'string'
      ? { cost: { amount: cost.amount, currency: cost.currency.slice(0, 16) } } : {}),
  }
}

/**
 * Whose numbers a prompt's `usage` (the UNSTABLE `PromptResponse.usage`) holds, per route. The
 * schema calls it "token usage for this turn" while its fields say "across session", so no
 * route is read as per-prompt until its connector's source says so; `unknown` keeps the numbers
 * as the agent sent them and adds nothing up.
 */
export const USAGE_SEMANTICS = Object.freeze({
  // claude-agent-acp 0.113.0 sums the SDK result's usage of this prompt (prompt-scoped).
  'acp-claude': 'per-prompt',
})

/**
 * One prompt's usage, read: `complete` when the three required counts are there, `partial`
 * when some are, `absent` when none are. Optional subsets (thought, cache) stay absent when not
 * sent, never zero. Never a cost: costs are the meter's (RFC 0018).
 */
export function promptUsageOf(usage, provider) {
  const semantics = USAGE_SEMANTICS[provider] ?? 'unknown'
  if (usage === null || typeof usage !== 'object') return { completeness: 'absent', semantics }
  const tokens = {}
  for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens']) {
    const value = count(usage[key])
    if (value !== undefined) tokens[key] = value
  }
  const required = ['totalTokens', 'inputTokens', 'outputTokens'].filter(key => tokens[key] !== undefined).length
  return { completeness: required === 3 ? 'complete' : required === 0 && Object.keys(tokens).length === 0 ? 'absent' : 'partial', semantics, tokens }
}

/**
 * Which way a native session comes back, from what the agent advertised: `resume` (context kept,
 * no history replayed: DSH already shows the chat), else `load` (history replayed, which the
 * run quarantines), else none.
 */
export function reattachMethodOf(agentCapabilities, allowed = ['resume', 'load']) {
  if (allowed.includes('resume') && agentCapabilities?.sessionCapabilities?.resume != null) return 'resume'
  if (allowed.includes('load') && agentCapabilities?.loadSession === true) return 'load'
  return undefined
}

/** A digest of what a native session is bound to; a change in any part makes a new one. */
export function bindingDigest(parts) {
  return createHash('sha256').update(JSON.stringify(Object.keys(parts).sort().map(key => [key, parts[key] ?? null]))).digest('base64url')
}
