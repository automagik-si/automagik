import { boundContextSummary, createSystemMessage, createUserMessage, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AUTOMATIC_SKILL_MODE } from '../shared/skill-mode.js'
import { routeOf } from '../shared/routes.js'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { freezeLoopRequest } from './secrets.js'
import { skillName } from './skill-library-rules.js'

import { SKILL_SOURCE, SKILL_NOTICE } from './skill-message.js'
export const SKILL_TOOL = 'load_skill'

const GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)|\b(?:use the skill|use a skill)\s+([a-z0-9-]+)\b|使用技能\s*([a-z0-9-]+)/gi
const acp = provider => routeOf(provider).connectedBy === 'acp'
const ownerOf = (rt, id) => rt.selfOf(id)
const activeOf = (rt, id) => rt.skillLibrary?.active(ownerOf(rt, id)) ?? []
const automaticOf = records => records.filter(record => record.mode === AUTOMATIC_SKILL_MODE)
const keyOf = records => records.map(({ name, hash }) => `${name}:${hash}`).join(',')
const catalogOf = records => records.map(({ name, description }) => `${name}: ${description}`).join('\n')
const noticeText = name => `The skill ${name} is not active on this Bot. Add it in the Bot's Details, under Skills.`

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
      return loadSkill(rt, exec.agent?.id, name) ?? {}
    },
  })
}

export function install(rt) {
  const { ctx } = rt
  // The Session records injected blocks before dispatch. A permission change in that gap
  // must take effect before the current batch leaves the host. Blocks already sent belong
  // to the same conversation's history, including when it reopens.
  const admitted = new WeakMap()
  const marker = part => part?.automagikSkill?.kind === SKILL_SOURCE ? part.automagikSkill : undefined
  function project(options, { catalog = true, turnStart } = {}) {
    const messages = options.messages
    if (!Array.isArray(messages)) return options
    const botId = ownerOf(rt, options.sessionId)
    const bot = rt.botOf(botId)
    const auxiliary = options.purpose !== undefined || rt.ownRequest?.(options) === true
    const records = auxiliary ? [] : activeOf(rt, options.sessionId)
    const automatic = automaticOf(records)
    const current = new Map(records.map(record => [record.name, record]))
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
      const content = row.content?.filter(part => {
        const ref = marker(part)
        if (!ref) return !load
        if (auxiliary || ref.catalog === true) return false
        if (bot === undefined || ref.botId !== botId) return false
        const fresh = row.role === 'tool' ? index > lastAnswer : index >= start
        if (!fresh || admitted.get(options.signal)?.has(row.id)) return true
        const skill = current.get(ref.name)
        return skill !== undefined && skill.hash === ref.hash && skill.content === part.text && (ref.use !== 'load' || skill.mode === AUTOMATIC_SKILL_MODE)
      })
      if (content?.length === row.content?.length) return [row]
      changed = true
      return [{ ...row, content }]
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

  function admit(options) {
    const { signal, messages } = options
    if (signal === undefined) return
    let rows = admitted.get(signal)
    if (rows === undefined) admitted.set(signal, rows = new Set())
    for (const row of messages) {
      if (row.content?.some(part => marker(part) && !marker(part).catalog)) rows.add(row.id)
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
        ...row, content: [...row.content, ...parts],
        source: { ...row.source, automagikSkillParsed: true },
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

  const rewritten = new WeakSet()
  ctx.on('llm/stream', (options, next) => {
    if (rewritten.has(options.messages)) return next()
    const alternate = acp(options.provider)
    const outgoing = project(options, { catalog: !alternate })
    if (outgoing === options) return next()
    if (!alternate && isAgentLoopRequest(options)) admit(outgoing)
    rewritten.add(outgoing.messages)
    rt.carryUsageTag?.(options.messages, outgoing.messages)
    if (isAgentLoopRequest(options)) markAgentLoopRequest(freezeLoopRequest(outgoing))
    return ctx.llm.stream(outgoing)
  }, { prepend: true })
}
