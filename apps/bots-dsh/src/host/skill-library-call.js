import { createHash } from 'node:crypto'
import { boundContextSummary, createSystemMessage, createUserMessage, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { AUTOMATIC_SKILL_MODE } from '../shared/skill-mode.js'
import { routeOf } from '../shared/routes.js'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { freezeLoopRequest } from './secrets.js'
import { skillName } from './skill-library-rules.js'

import { personParts, SKILL_SOURCE, SKILL_NOTICE, SKILL_TOOL } from './skill-message.js'
export { SKILL_TOOL } from './skill-message.js'

const GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)|\b(?:use the skill|use a skill)\s+([a-z0-9-]+)\b|使用技能\s*([a-z0-9-]+)/gi
const acp = provider => routeOf(provider).connectedBy === 'acp'
const ownerOf = (rt, id) => rt.selfOf(id)
const activeOf = (rt, id) => rt.skillLibrary?.active(ownerOf(rt, id)) ?? []
const automaticOf = records => records.filter(record => record.mode === AUTOMATIC_SKILL_MODE)
const keyOf = records => records.map(({ name, hash }) => `${name}:${hash}`).join(',')
const catalogOf = records => records.map(({ name, description }) => `${name}: ${description}`).join('\n')
const noticeText = name => `The skill ${name} is not active on this Bot. Add it in the Bot's Details, under Skills.`
const SKILLS_PROJECTED = Symbol('Skills projected')
const DELIVERY_RECORD = 'plugin:automagik/skill-delivery'
const marker = part => part?.automagikSkill?.kind === SKILL_SOURCE ? part.automagikSkill : undefined
const REVIEW_SOURCE_FIELDS = ['automagikSkill', 'automagikSkillParsed', 'automagikSkillParts', 'skillRequests']
const skillToolName = name => name === SKILL_TOOL || name === `mcp__dsh__${SKILL_TOOL}`

function reviewEntry(message) {
  const part = message?.content?.[0]
  if (message?.role !== 'user' || message.content?.length !== 1 || part?.type !== 'text') return
  try { return JSON.parse(part.text) } catch { return undefined }
}

// A PTC wrapper can include the same private arguments in its program. The
// reviewer history lists completed inner dispatches after their native wrapper.
function skillPrograms(entries) {
  const privatePrograms = new Set()
  let program
  for (const entry of entries) {
    if (entry?.kind === 'user-message') program = undefined
    if (entry?.kind !== 'tool-call') continue
    if (entry.mode === 'native') {
      program = entry.name === RUN_CODE_NAME ? entry : undefined
      if (program) {
        let code
        try { code = JSON.parse(program.arguments)?.code } catch {}
        if (typeof code === 'string' && /\btools\s*(?:\.\s*load_skill\b|\[\s*(['"`])load_skill\1\s*\])/.test(code)) {
          privatePrograms.add(program)
        }
      }
    } else if (entry.mode === 'ptc-inner' && entry !== entries.at(-1) && program && skillToolName(entry.name)) {
      privatePrograms.add(program)
    }
  }
  return privatePrograms
}

// DSH experimental Auto review serializes one typed history entry per user message.
// Its final entry and matching schema are the pending action. Keep that envelope
// even for a Skills read, with no private arguments; the executor keeps the real call.
function projectReview(options) {
  const { messages } = options
  if (!Array.isArray(messages)) return options
  const environment = messages[0]?.content?.[0]?.text
  if (typeof environment !== 'string' || !environment.startsWith('ENVIRONMENT\n')) return options
  const entries = messages.map((message, index) => index === 0 ? undefined : reviewEntry(message))
  const pending = entries.at(-1)
  const privatePrograms = skillPrograms(entries)
  let changed = false
  const projected = messages.flatMap((message, index) => {
    if (index === 0) return [message]
    const entry = entries[index]
    const replace = value => {
      changed = true
      return [{ ...message, content: [{ ...message.content[0], text: JSON.stringify(value, null, 2) }] }]
    }
    const drop = () => { changed = true; return [] }
    if (entry?.kind === 'user-message' && entry.source && Array.isArray(entry.content)) {
      if ([SKILL_SOURCE, SKILL_NOTICE].includes(entry.source.kind)) return drop()
      const content = personParts(entry.content)
      if (content.length === 0 && entry.content.length > 0) return drop()
      const fields = REVIEW_SOURCE_FIELDS.filter(key => Object.hasOwn(entry.source, key))
      if (fields.length === 0 && content.length === entry.content.length) return [message]
      const source = { ...entry.source }
      for (const key of fields) delete source[key]
      return replace({ ...entry, source, content })
    }
    if (privatePrograms.has(entry) && entry.arguments !== '{}') return replace({ ...entry, arguments: '{}' })
    if (!skillToolName(entry?.name)) return [message]
    if (entry.kind === 'tool-call') {
      if (index < messages.length - 1) return drop()
      if (entry.arguments !== '{}') return replace({ ...entry, arguments: '{}' })
    }
    // A pending load's schema can first appear earlier, if DSH deduplicated it.
    if (entry.kind === 'tool-schema' && (pending?.kind !== 'tool-call' || pending.name !== entry.name || pending.mode !== entry.mode)) return drop()
    return [message]
  })
  return changed ? { ...options, messages: projected } : options
}

function receipt(row, part, ref) {
  return createHash('sha256').update(JSON.stringify([row.id, ref.botId, ref.name, ref.hash, ref.use, part.text])).digest('hex')
}

export function requestedSkills(parts) {
  const requests = new Map()
  for (const part of parts ?? []) {
    if (part?.type !== 'text' || typeof part.text !== 'string' || part.automagikSkill !== undefined) continue
    for (const match of part.text.matchAll(GESTURE)) {
      const name = (match[2] ?? match[3] ?? match[4]).toLowerCase()
      if (!skillName(name) || (match[2] !== undefined && reservedCommandOf(name))) continue
      const previous = requests.get(name)
      requests.set(name, { name, slash: match[2] !== undefined && previous?.slash !== false })
    }
  }
  return [...requests.values()]
}

export function skillPart(botId, skill, use = 'person') {
  return { type: 'text', text: skill.content,
    automagikSkill: { kind: SKILL_SOURCE, botId, name: skill.name, hash: skill.hash, use } }
}

export function loadSkill(rt, sessionId, name) {
  const skill = automaticOf(activeOf(rt, sessionId)).find(record => record.name === name)
  return skill && skillPart(ownerOf(rt, sessionId), skill, 'load')
}

export function skillTool(rt) {
  return defineTool({
    name: SKILL_TOOL,
    description: '',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.type === 'text' ? [value] : [],
    },
    async execute({ name }, exec) {
      await rt.load()
      if (exec.signal?.aborted) return {}
      const part = loadSkill(rt, exec.agent?.id, name)
      if (part && exec.parent !== undefined) {
        // PTC carries deferred context to the next model step separately from
        // the program's return value. Only dispatch can admit this body.
        exec.deferContext(createUserMessage({
          content: [], source: { kind: SKILL_SOURCE, automagikSkillParts: [part] },
        }))
        return {}
      }
      return part ?? {}
    },
  })
}

export function install(rt) {
  const { ctx } = rt
  // The Session records injected blocks before dispatch. A permission change in that gap
  // must take effect before the current batch leaves the host. Blocks already sent belong
  // to the same conversation's history, including when it reopens.
  const ledgers = new WeakMap()
  const sessionOf = id => ctx.get?.('sessions')?.get?.(id) ?? ctx.get?.('agents')?.get?.(id)?.session
  const auxiliaryRequest = options => options.purpose !== undefined || rt.ownRequest?.(options) === true

  function ledger(session) {
    if (!session?.eventAt) return
    let state = ledgers.get(session)
    if (!state) ledgers.set(session, state = { seq: 0, rows: new Map(), delivered: new Set() })
    for (; state.seq < session.seq; state.seq++) {
      const event = session.eventAt(state.seq)
      if (event.type === 'turn/start') state.turn = event.data.turn
      else if (event.type === 'turn/end') state.turn = undefined
      else if (event.type === 'assistant/attempt') state.attempt = { seq: event.seq, turn: event.data.turn }
      else if (event.type === 'user/message') state.rows.set(event.data.id, { seq: event.seq, turn: state.turn })
      else if (event.type === 'tool/result') state.rows.set(event.data.message.id, { seq: event.seq, turn: event.data.turn })
      else if (event.type === DELIVERY_RECORD && Array.isArray(event.data)) {
        for (const id of event.data) state.delivered.add(id)
      }
    }
    return state
  }

  function project(options, { catalog = true, turnStart, historyOnly = false,
    session = sessionOf(options.sessionId), auxiliary = auxiliaryRequest(options) } = {}) {
    const messages = options.messages
    if (!Array.isArray(messages)) return options
    const botId = ownerOf(rt, options.sessionId)
    const bot = rt.botOf(botId)
    const records = auxiliary ? [] : activeOf(rt, options.sessionId)
    const automatic = automaticOf(records)
    const current = new Map(records.map(record => [record.name, record]))
    const state = auxiliary ? undefined : ledger(session)
    const retry = messages.findLastIndex(row => row.source?.kind === 'retry' || row.source?.resumed === true)
    const start = turnStart ?? messages.findLastIndex(row => row.role === 'assistant' || row.role === 'tool') + 1
    const lastAnswer = messages.findLastIndex(row => row.role === 'assistant' && row.source?.synthetic !== 'acp-bridge')
    const skillCalls = new Set(messages.flatMap(row => row.role !== 'assistant' ? [] :
      (row.content ?? []).filter(part => part.type === 'tool-call' && part.name === SKILL_TOOL).map(part => part.id)))
    let changed = false
    const result = messages.flatMap((row, index) => {
      if (row.source?.kind === SKILL_NOTICE) {
        changed = true
        return []
      }
      const load = row.role === 'tool' && skillCalls.has(row.toolCallId)
      const { automagikSkillParts, ...source } = row.source ?? {}
      const parts = Array.isArray(automagikSkillParts)
        ? [...row.content, ...automagikSkillParts.filter(marker)] : row.content
      const content = parts?.filter(part => {
        const ref = marker(part)
        if (!ref) return !load
        if (auxiliary || ref.catalog === true) return false
        if (bot === undefined || ref.botId !== botId) return false
        if (state?.delivered.has(receipt(row, part, ref))) return true
        if (historyOnly || index < retry || row.source?.resumed === true || row.source?.retried === true) return false
        const fresh = row.role === 'tool' ? index > lastAnswer : index >= start
        const logged = state?.rows.get(row.id)
        if (!fresh || (logged && (state.turn === undefined || logged.turn !== state.turn ||
          (state.attempt?.turn === logged.turn && state.attempt.seq > logged.seq)))) return false
        const skill = current.get(ref.name)
        return skill !== undefined && skill.hash === ref.hash && skill.content === part.text && (ref.use !== 'load' || skill.mode === AUTOMATIC_SKILL_MODE)
      })
      if (automagikSkillParts === undefined && content?.length === row.content?.length) return [row]
      changed = true
      return [{ ...row, content, ...(automagikSkillParts === undefined ? {} : { source }) }]
    })
    if (catalog && bot && automatic.length) {
      // Add the current section to the request's system prompt without recording a
      // catalog in the conversation. The first and latest system snapshots serve
      // leading-only and in-history providers, respectively.
      const part = {
        type: 'text', text: catalogOf(automatic),
        automagikSkill: { kind: SKILL_SOURCE, catalog: true, botId,
          skills: automatic.map(({ name, hash }) => ({ name, hash })) },
      }
      const first = result.findIndex(row => row.role === 'system')
      const last = result.findLastIndex(row => row.role === 'system' && row.content.length > 0)
      if (first < 0) result.unshift({ ...createSystemMessage(''), content: [part] })
      else for (const index of new Set([first, Math.max(first, last)])) {
        const row = result[index]
        const section = row.content.length === 0 ? part : { ...part, text: '\n\n' + part.text }
        result[index] = { ...row, content: [...row.content, section] }
      }
      changed = true
    }
    return changed ? { ...options, messages: result } : options
  }

  function admit(options, session = sessionOf(options.sessionId)) {
    const state = ledger(session)
    if (!state) return
    const delivered = new Set()
    for (const row of options.messages) for (const part of row.content ?? []) {
      const ref = marker(part)
      if (ref && !ref.catalog) {
        const id = receipt(row, part, ref)
        if (!state.delivered.has(id)) delivered.add(id)
      }
    }
    if (delivered.size) {
      try { appendPluginRecord(session, DELIVERY_RECORD, [...delivered]) } catch (error) {
        rt.warn?.('Skills delivery could not be recorded: %s', error)
      }
    }
  }

  async function* confirmDelivery(stream, options) {
    let confirmed = false
    for await (const chunk of stream) {
      if (!confirmed && (['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type) ||
          (chunk.type === 'finish' && !['error', 'aborted'].includes(chunk.reason?.kind)))) {
        confirmed = true
        admit(options)
      }
      yield chunk
    }
  }

  rt.skillCalls = {
    available: sessionId => automaticOf(activeOf(rt, sessionId)).length > 0,
    load: (sessionId, name) => loadSkill(rt, sessionId, name),
    catalog(sessionId) {
      const records = automaticOf(activeOf(rt, sessionId))
      return { key: keyOf(records), text: catalogOf(records) }
    },
    project, admit,
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    await rt.load()
    const botId = ownerOf(rt, agent.id)
    if (!rt.botOf(botId) || signal.aborted) return decision
    const original = new Map(messages.map(row => [row.id, row]))
    const served = new Set(decision.messages.filter(row => row.source?.kind === 'skill-invocation')
      .map(row => row.source.name))
    const notices = []
    const rows = decision.messages.map(row => ({ row, input: original.get(row.id) }))
    const pending = []
    for (const { row, input } of rows) {
      if (!input || input.source?.automagikSkillParsed ||
          !['user', 'bot'].includes(input.source?.kind)) continue
      const requests = input.source.kind === 'user' ? requestedSkills(input.content) :
        input.source.role === 'room' && Array.isArray(input.source.skillRequests)
          ? input.source.skillRequests.filter(request => skillName(request?.name)) : []
      if (requests.length > 0) pending.push({ row, requests })
    }

    const existing = new Set(served)
    const registry = agent.ctx?.get?.('skills') ?? ctx.get?.('skills')
    const slash = new Set(pending.flatMap(({ requests }) => requests.filter(request => request.slash).map(request => request.name)))
    if (slash.size && registry?.get !== undefined) {
      const cwd = await (ctx.get?.('workingDirectory') ?? ctx.workingDirectory)?.ensure?.(agent, signal)
      for (const name of slash) {
        if (existing.has(name)) continue
        if (await registry.get(name, { cwd, signal, scope: agent }) !== undefined) existing.add(name)
      }
    }
    if (signal.aborted) return decision

    const records = new Map(activeOf(rt, agent.id).map(record => [record.name, record]))
    const modified = new Map()
    for (const { row, requests } of pending) {
      const parts = []
      for (const { name, slash: isSlash } of requests) {
        if (!skillName(name) || served.has(name) || (isSlash && row.source.kind === 'user' && existing.has(name))) continue
        const record = records.get(name)
        if (record) parts.push(skillPart(botId, record))
        else notices.push({ name, roomId: row.source.roomId })
      }
      if (parts.length > 0) modified.set(row.id, {
        // DSH title providers flatten person content directly from the event log.
        // Keep the checked parts with the source until provider dispatch.
        ...row, source: { ...row.source, automagikSkillParsed: true, automagikSkillParts: parts },
      })
    }
    if (!modified.size && !notices.length) return decision
    const privateRows = []
    for (const { name, roomId } of notices) {
      const text = noticeText(name)
      if (roomId !== undefined) rt.roomSkillNotice?.(roomId, botId, text)
      else privateRows.push(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SKILL_NOTICE, form: 'notice', summary: boundContextSummary(text) },
      }))
    }
    return { ...decision, messages: [...decision.messages.map(row => modified.get(row.id) ?? row), ...privateRows] }
  }, { prepend: true })

  ctx.on('tools/pre-execute', async function refuseSkillPatch(exec, next) {
    if (exec.name !== 'update_bot' || !Object.hasOwn(exec.arguments ?? {}, 'skills')) return next()
    await rt.skillLibrary?.refuse('update_bot', {}, 'bot')
    return { kind: 'deny', reason: 'Invalid arguments.' }
  }, { prepend: true })

  ctx.on('llm/stream', (options, next) => {
    const previous = options[SKILLS_PROJECTED]
    const auxiliary = previous?.auxiliary === true || auxiliaryRequest(options)
    if (previous?.provider === options.provider && previous?.auxiliary === auxiliary) return next()
    const alternate = acp(options.provider)
    if (alternate && isAgentLoopRequest(options) && !auxiliary) return next()
    const input = options.purpose === 'auto-review' ? projectReview(options) : options
    const outgoing = project(input, { catalog: !alternate, auxiliary })
    if (outgoing === options) return next()
    const request = { ...outgoing, [SKILLS_PROJECTED]: { provider: options.provider, auxiliary } }
    rt.carryUsageTag?.(options.messages, request.messages)
    if (!isAgentLoopRequest(options)) return ctx.llm.stream(request)
    const stream = ctx.llm.stream(markAgentLoopRequest(freezeLoopRequest(request)))
    return alternate ? stream : confirmDelivery(stream, outgoing)
  }, { prepend: true })
}
