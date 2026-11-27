// What this client takes from ACP beyond text, thoughts, tools, modes and config: the agent's
// plan, its usage and the reattachment of a native session after a restart. Each is a pure
// reading of the agent's own message here; AgentRun (acp.js) and the adapter decide what DSH
// does with it. `dev/acp-features.json` is the audit of every SDK feature against this file.
import { createHash } from 'node:crypto'

/**
 * What the client tells an agent at `initialize`. Only what this plugin handles end to end is
 * advertised: `plan` (it takes `plan_update` and `plan_removed`, below), agent notices and
 * compaction (chat rows), and form elicitation (DSH's question dialog). Every other client
 * capability stays off; its reason is its row in `dev/acp-features.json`. handshake.js sends the
 * same value, so a sign-in check meets the agent as a chat does.
 */
export const CLIENT_CAPABILITIES = Object.freeze({
  plan: Object.freeze({}),
  // `notice` and `compaction_update` / `compaction_summary_chunk` become chat rows (SessionRows);
  // so does the current `prompt_suggestions_update` list, of text and resource_link blocks only
  // (the base the capability promises: no image, audio or embedded resource is advertised).
  session: Object.freeze({ notices: Object.freeze({}), compaction: Object.freeze({}), promptSuggestions: Object.freeze({}) }),
  // A form elicitation is asked in DSH's question dialog (elicitationQuestions); a URL one is not.
  elicitation: Object.freeze({ form: Object.freeze({}) }),
})

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
  // SDK 2.12.0's PlanMarkdown: the whole plan as `content`, and an optional absolute `path` of
  // the file holding it. The path is the agent's; it is kept as text and never opened here.
  if (plan.type === 'markdown' && typeof plan.content === 'string') {
    return { planId: plan.planId, type: 'markdown', markdown: shortText(plan.content, PLAN_TEXT_MAX * 4),
      ...(typeof plan.path === 'string' && plan.path !== '' ? { path: shortText(plan.path, 1024) } : {}) }
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
    const body = plan.type === 'markdown' ? { type: 'markdown', markdown: plan.markdown, ...(plan.path === undefined ? {} : { path: plan.path }) } : { type: 'items', entries: plan.entries }
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

const firstHeading = markdown => /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]
const STATUS_MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }

/**
 * The chat row a plan change leaves when DSH's todo panel does not draw it (a markdown plan, or
 * an items plan while the turn's list is DSH's own `todo_write`): `{ summary, text }`, the
 * summary the row shows and the whole plan its body opens to. A removed plan says so.
 */
export function planNoticeOf(plan) {
  if (plan.removed === true) return { summary: 'The agent withdrew its plan', text: '[The agent withdrew its plan.]' }
  if (plan.type === 'markdown') {
    const title = firstHeading(plan.markdown) ?? plan.markdown.trim().split('\n')[0]?.slice(0, 80) ?? ''
    return { summary: title === '' ? "The agent's plan" : `Plan: ${title}`, text: `[The agent's plan${plan.path === undefined ? '' : ` (${plan.path})`}:]\n\n${plan.markdown}` }
  }
  const done = plan.entries.filter(entry => entry.status === 'completed').length
  return {
    summary: `Plan: ${done} of ${plan.entries.length} done`,
    text: `[The agent's plan:]\n\n${plan.entries.map(entry => `- ${STATUS_MARK[entry.status]} ${entry.content}`).join('\n')}`,
  }
}

const number = value => value.toLocaleString('en-US')

/**
 * The chat row of one prompt's usage, as the agent reported it (`promptUsageOf`), or undefined
 * when it reported nothing. Missing counts stay unnamed, never zero; the semantics say whose
 * numbers they are. Never a cost: costs are the meter's (RFC 0018).
 */
export function usageNoticeOf(usage) {
  const tokens = usage?.tokens ?? {}
  const parts = [['inputTokens', 'in'], ['outputTokens', 'out'], ['thoughtTokens', 'thinking'], ['cachedReadTokens', 'cache read'], ['cachedWriteTokens', 'cache write'], ['totalTokens', 'total']]
    .filter(([key]) => tokens[key] !== undefined).map(([key, label]) => `${number(tokens[key])} ${label}`)
  const context = usage?.context === undefined ? undefined : `context ${number(usage.context.used)} of ${number(usage.context.size)}`
  if (parts.length === 0 && context === undefined) return undefined
  const scope = usage.semantics === 'per-prompt' ? 'this prompt' : 'as the agent reported it'
  const line = [parts.length === 0 ? undefined : `${parts.join(' · ')} (${scope}${usage.completeness === 'partial' ? ', partial' : ''})`, context].filter(Boolean).join('; ')
  return { summary: `Tokens: ${line}`, text: `[Tokens: ${line}.]` }
}

// ---- Session updates that become chat rows ---------------------------------------------------
// Each reading answers `{ key, notice, summary, text }` (one chat row, the latest per `key` per
// prompt; acp.js pushes it, the adapter writes it as the prompt settles) or undefined.
const ROW_TEXT_MAX = 8000
const blockText = block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : block?.type === 'resource_link' && typeof block.uri === 'string' ? `<${block.uri}>` : '')
const blocksText = blocks => (Array.isArray(blocks) ? blocks.map(blockText).join('') : blockText(blocks)).slice(0, ROW_TEXT_MAX)
const line = value => shortText(value, 200).replace(/\s+/g, ' ').trim()
const SEVERITY = new Set(['info', 'warning', 'error'])

export class SessionRows {
  constructor() {
    this.summaries = new Map() // compactionId -> text so far
    this.messages = new Map() // messageId -> text so far
    this.commands = undefined
    this.subagents = new Map() // sessionId -> last state
  }

  /** The row an update makes, or undefined (a chunk still accumulating, a repeat, a shape not read). */
  take(update) {
    switch (update?.sessionUpdate) {
      case 'notice': {
        const severity = SEVERITY.has(update.severity) ? update.severity : 'info'
        const title = line(update.title)
        if (title === '') return undefined
        const description = shortText(update.description ?? '', ROW_TEXT_MAX)
        return { key: `notice:${title}`, notice: 'agent-notice', severity, summary: `${severity === 'info' ? '' : `${severity[0].toUpperCase()}${severity.slice(1)}: `}${title}`, text: `[${title}]${description === '' ? '' : `\n\n${description}`}` }
      }
      case 'compaction_summary_chunk': {
        if (typeof update.compactionId !== 'string') return undefined
        this.summaries.set(update.compactionId, `${this.summaries.get(update.compactionId) ?? ''}${blockText(update.content)}`.slice(0, ROW_TEXT_MAX))
        return undefined
      }
      case 'compaction_update': {
        if (typeof update.compactionId !== 'string') return undefined
        const key = `compaction:${update.compactionId}`
        if (update.status === 'in_progress') return { key, notice: 'compaction', summary: 'The agent is compacting its context', text: '[The agent is compacting its context.]' }
        const summary = blocksText(update.summary) || this.summaries.get(update.compactionId) || ''
        this.summaries.delete(update.compactionId)
        if (update.status === 'completed') return { key, notice: 'compaction', summary: 'The agent compacted its context', text: `[The agent compacted its context${summary === '' ? '' : '; its summary:'}]${summary === '' ? '' : `\n\n${summary}`}` }
        const why = line(update.error ?? '')
        return { key, notice: 'compaction', summary: `The agent's compaction ${update.status === 'cancelled' ? 'was cancelled' : 'failed'}`, text: `[The agent's compaction ${update.status === 'cancelled' ? 'was cancelled' : 'failed'}${why === '' ? '' : `: ${why}`}.]` }
      }
      case 'session_message_chunk': {
        if (typeof update.messageId !== 'string') return undefined
        this.messages.set(update.messageId, `${this.messages.get(update.messageId) ?? ''}${blockText(update.content)}`.slice(0, ROW_TEXT_MAX))
        return undefined
      }
      case 'session_message': {
        if (typeof update.messageId !== 'string') return undefined
        const text = blocksText(update.content) || this.messages.get(update.messageId) || ''
        this.messages.delete(update.messageId)
        if (text === '') return undefined
        const from = typeof update.senderSessionId === 'string' ? 'a subagent' : 'the agent'
        return { key: `message:${update.messageId}`, notice: 'session-message', summary: `A message from ${from}`, text: `[A message from ${from}:]\n\n${text}` }
      }
      case 'available_commands_update': {
        if (!Array.isArray(update.availableCommands)) return undefined
        const commands = update.availableCommands.filter(command => typeof command?.name === 'string' && command.name !== '').slice(0, 100)
          .map(command => ({ name: line(command.name), description: line(command.description ?? '') }))
        const same = JSON.stringify(commands) === JSON.stringify(this.commands)
        this.commands = commands
        if (same || commands.length === 0) return undefined
        return { key: 'commands', notice: 'commands', summary: `The agent's commands: ${commands.slice(0, 6).map(command => `/${command.name}`).join(', ')}${commands.length > 6 ? ', …' : ''}`, text: `[The agent's own commands; type one as the first word of a message:]\n\n${commands.map(command => `- /${command.name}${command.description === '' ? '' : ` — ${command.description}`}`).join('\n')}` }
      }
      case 'prompt_suggestions_update': {
        // The list replaces the one before; an empty list (or one with nothing readable) clears it.
        if (!Array.isArray(update.suggestions)) return undefined
        const suggestions = update.suggestions.map(suggestion => line(blocksText(suggestion?.prompt))).filter(Boolean).slice(0, 5)
        if (suggestions.length === 0) return { key: 'suggestions', clear: true }
        return { key: 'suggestions', notice: 'suggestions', summary: `Suggested next: ${suggestions[0]}`, text: `[The agent suggests what to send next:]\n\n${suggestions.map(suggestion => `- ${suggestion}`).join('\n')}` }
      }
      case 'subagent_update': {
        if (typeof update.sessionId !== 'string') return undefined
        const state = typeof update.state?.state === 'string' ? update.state.state : undefined
        const title = line(update.title ?? '') || 'A subagent'
        const held = this.subagents.get(update.sessionId)
        this.subagents.set(update.sessionId, state ?? held)
        if (held !== undefined && (state === undefined || state === held)) return undefined
        const doing = { running: 'is working', idle: 'is idle', requires_action: 'needs an answer' }[state] ?? 'started'
        return { key: `subagent:${update.sessionId}`, notice: 'subagent', summary: `${title} ${doing}`, text: `[${title} ${doing}.]${update.description ? `\n\n${shortText(update.description, ROW_TEXT_MAX)}` : ''}` }
      }
      default:
        return undefined
    }
  }
}

// ---- Elicitation (`elicitation/create`) through DSH's own question dialog -------------------
export const ELICITATION_DECLINE = 'Decline (send nothing)'
const YES = 'Yes'
const NO = 'No'

/**
 * The questions DSH asks the person for one form elicitation, or undefined for one this client
 * does not ask (a URL elicitation: it would open a page; a form with no field it can ask). The
 * first question carries the agent's message and a Decline option: the person's answer is the
 * consent, and nothing is ever answered for them.
 */
export function elicitationQuestions(request, agentName) {
  if (request?.mode !== 'form') return undefined
  const properties = Object.entries(request.requestedSchema?.properties ?? {}).slice(0, 8)
  if (properties.length === 0) return undefined
  const required = new Set(Array.isArray(request.requestedSchema?.required) ? request.requestedSchema.required : [])
  const questions = []
  for (const [name, schema] of properties) {
    const title = line(schema?.title ?? name)
    const detail = shortText(schema?.description ?? '', 500)
    const header = shortText(`${agentName} asks`, 40)
    let options
    let multiSelect
    if (schema?.type === 'boolean') options = [{ label: YES }, { label: NO }]
    else if (schema?.type === 'string' && Array.isArray(schema.enum)) options = schema.enum.slice(0, 20).map(value => ({ label: line(value) }))
    else if (schema?.type === 'string' && Array.isArray(schema.oneOf)) options = schema.oneOf.slice(0, 20).map(choice => ({ label: line(choice?.title ?? choice?.const) }))
    else if (schema?.type === 'array') {
      const choices = schema.items?.enum ?? schema.items?.anyOf?.map(choice => choice?.title ?? choice?.const)
      if (!Array.isArray(choices)) return undefined
      options = choices.slice(0, 20).map(value => ({ label: line(value) }))
      multiSelect = true
    } else if (!['string', 'number', 'integer'].includes(schema?.type)) return undefined
    questions.push({ id: name, header, question: `${title}${required.has(name) ? '' : ' (optional)'}`, ...(detail === '' ? {} : { detail }), ...(options === undefined ? {} : { options }), ...(multiSelect ? { multiSelect } : {}) })
  }
  const first = questions[0]
  first.question = `${line(request.message)}\n\n${first.question}`
  first.options = [...(first.options ?? []), { label: ELICITATION_DECLINE, description: `Tell ${agentName} you would rather not answer` }]
  return questions
}

/** The elicitation answer for the person's answers: accept with typed content, or decline. */
export function elicitationAnswer(request, answer) {
  const properties = request.requestedSchema?.properties ?? {}
  const required = Array.isArray(request.requestedSchema?.required) ? request.requestedSchema.required : []
  const byId = new Map((answer?.answers ?? []).map(item => [item.id, item]))
  if ([...byId.values()].some(item => item.selected?.includes(ELICITATION_DECLINE))) return { action: 'decline' }
  const content = {}
  for (const [name, schema] of Object.entries(properties).slice(0, 8)) {
    const item = byId.get(name)
    const typed = typeof item?.custom === 'string' ? item.custom.trim() : ''
    const picked = item?.selected ?? []
    let value
    if (schema?.type === 'boolean') value = picked[0] === YES ? true : picked[0] === NO ? false : undefined
    else if (schema?.type === 'array') value = picked.length > 0 ? picked : undefined
    else if (schema?.type === 'number' || schema?.type === 'integer') {
      const number = Number(typed || picked[0])
      value = typed === '' && picked.length === 0 ? undefined : Number.isFinite(number) && (schema.type === 'number' || Number.isInteger(number)) ? number : Number.NaN
      if (Number.isNaN(value)) return { action: 'decline' }
    } else if (Array.isArray(schema?.oneOf)) {
      const choice = schema.oneOf.find(option => line(option?.title ?? option?.const) === picked[0])
      value = choice?.const ?? (typed === '' ? undefined : typed)
    } else value = picked[0] ?? (typed === '' ? undefined : typed)
    if (value !== undefined) content[name] = value
  }
  if (required.some(name => content[name] === undefined)) return { action: 'decline' }
  return { action: 'accept', content }
}
