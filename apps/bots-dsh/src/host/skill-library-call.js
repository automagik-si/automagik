import { createHash } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import { boundContextSummary, createSystemMessage, createUserMessage, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { AUTOMATIC_SKILL_MODE } from '../shared/skill-mode.js'
import { routeOf } from '../shared/routes.js'
import { reservedCommandOf } from '../shared/reserved-commands.js'
import { SKILL_ACTIVITY_RECORD } from '../shared/skill-activity.js'
import { MAX_SESSION_LINEAGE_DEPTH } from './bot-sessions.js'
import { GROUP_MEMORY_SOURCE, MEMORY_RECALL_SOURCE, MEMORY_UPDATE_SOURCE } from './memory-copy.js'
import { freezeLoopRequest } from './secrets.js'
import { skillName } from './skill-library-rules.js'
import { isTrustedToolRegistration } from './tool-registrations.js'

import { AGY_OFF_SKILLS_NOTICE, personParts, SKILL_SOURCE, SKILL_NOTICE, SKILL_TOOL } from './skill-message.js'
export { SKILL_TOOL } from './skill-message.js'

const GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)|\b(?:use the skill|use a skill)\s+([a-z0-9-]+)\b|使用技能\s*([a-z0-9-]+)/gi
const acp = provider => routeOf(provider).connectedBy === 'acp'
function skillOwner(rt, sessionId, session) {
  const lineage = []
  const seen = new Set()
  const { ctx } = rt
  let id = sessionId
  try {
    while (typeof id === 'string' && lineage.length <= MAX_SESSION_LINEAGE_DEPTH && !seen.has(id)) {
      seen.add(id)
      const task = rt.state?.tasks?.[id]
      if (typeof task?.skillsOwner === 'string' && Array.isArray(task.skills) &&
          typeof task.skillsInstructionsId === 'string' && rt.botOf(task.skillsOwner)) {
        return { botId: task.skillsOwner, task, lineage, root: id, kind: lineage.length ? 'subagent' : 'task' }
      }
      const botId = rt.selfOf(id)
      if (rt.botOf(botId)) {
        if (lineage.length && !keepsGroupMembership(rt, id, botId)) return
        return { botId, lineage, root: id, kind: lineage.length ? 'subagent' : 'own' }
      }
      // ACP can replay a retained Session after DSH detaches it from the registry.
      const header = id === sessionId && session !== undefined ? session.header
        : (ctx.sessions ?? ctx.get?.('sessions'))?.get?.(id)?.header
      if (header?.origin !== 'subagent') return
      lineage.push(id)
      id = header.parentSession
    }
  } catch { /* An unavailable lineage cannot establish ownership. */ }
}

function keepsGroupMembership(rt, sessionId, botId) {
  const group = rt.groupOwners?.get(sessionId)
  return group === undefined || rt.roomOf(group.roomId)?.members?.includes(botId) === true
}

function hasCurrentRoot(rt, owner) {
  return (owner.task !== undefined || rt.isBotSession?.(owner.root) === true) &&
    keepsGroupMembership(rt, owner.root, owner.botId)
}

function nestedDelegationId(session) {
  const { header, inheritedEventCount } = session
  if (header.origin !== 'subagent' || !(header.delegationDepth > 1) ||
      typeof header.parentSession !== 'string' || !Number.isInteger(inheritedEventCount)) return
  // DSH writes the descriptor before it queues the initial delegated prompt.
  // Only that child-owned input is proven when live ancestry is unavailable.
  let described = false
  for (let seq = inheritedEventCount; seq < session.seq; seq++) {
    const event = session.eventAt?.(seq)
    if (!event || session.isOwnSeq?.(seq) !== true) return
    if (event.type === 'subagent/descriptor') described = true
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue
    if (described && event.surfaceOp === 'append') return event.data.id
    return
  }
}

function recordsOf(rt, owner, { worker = false } = {}) {
  if (owner === undefined) return []
  const task = owner.task
  const records = rt.skillLibrary?.active(owner.botId, { worker: worker || task !== undefined }) ?? []
  if (task === undefined) return records
  const pins = new Map(task.skills.map(pin => [pin.name, pin]))
  return records.flatMap(record => {
    const pin = pins.get(record.name)
    if (!pin || pin.hash !== record.hash || pin.assignment !== record.assignment || pin.revision !== record.revision ||
        (pin.mode === AUTOMATIC_SKILL_MODE && record.mode !== AUTOMATIC_SKILL_MODE)) return []
    return [{ ...record, mode: pin.mode }]
  })
}

function permitsWorkerLoad(rt, owner, agent) {
  if (owner.task?.skillsLoadBlocked === true || rt.teamCurrent?.() === false) return false
  const { ctx } = rt
  const agents = ctx.get?.('agents') ?? ctx.agents
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (rt.botOf(owner.botId)?.denyTools?.includes(SKILL_TOOL)) return false
  for (const id of [...owner.lineage, owner.root]) {
    if (rt.levelHeld?.(id)) return false
    const live = (agent?.session?.id ?? agent?.id) === id ? agent : agents?.get?.(id)
    // DSH exempts own-scope tools from restrict(). A worker registration
    // must still respect the intersection of its profile and Session masks.
    if (live && tools?.layers?.chainLayers?.(live).some(layer => !layer.admits(SKILL_TOOL))) return false
  }
  return true
}
const automaticOf = records => records.filter(record => record.mode === AUTOMATIC_SKILL_MODE)
const keyOf = records => records.map(({ name, hash }) => `${name}:${hash}`).join(',')
const catalogOf = records => records.length === 0 ? '' : [
  'Your skills (load with load_skill):',
  ...records.map(({ name, description }) => `${name}: ${description}`),
].join('\n')
const noticeText = name => `The skill ${name} is not active on this Bot. Add it in the Bot's Details, under Skills.`
const skillNotice = text => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: SKILL_NOTICE, form: 'notice', summary: boundContextSummary(text) },
})
const SKILL_UNAVAILABLE = 'No skill with that name is available to this Bot.'
const SKILLS_PROJECTED = Symbol('Skills projected')
const DELIVERY_RECORD = 'plugin:automagik/skill-delivery'
const CONTEXT_SOURCES = new Set(['runtime-context', 'time-context', 'ds-bot-time-context',
  GROUP_MEMORY_SOURCE, MEMORY_RECALL_SOURCE, MEMORY_UPDATE_SOURCE])
const marker = part => part?.automagikSkill?.kind === SKILL_SOURCE ? part.automagikSkill : undefined
const REVIEW_SOURCE_FIELDS = ['automagikSkill', 'automagikSkillParsed', 'automagikSkillParts', 'automagikSkillOriginalText',
  'skillRequests', 'skillRoom', 'skillRoomLines']
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

function pendingSkillProgram(session, entries, pending) {
  const events = session?.snapshotEvents?.()
  if (!events) return
  const keyOfCall = ({ turn, step }, callId) => JSON.stringify([turn, step, callId])
  const nativeCalls = new Map()
  const innerIds = new Set()
  const startsByParent = new Map()
  let openStep
  for (const { type, data } of events) {
    if (type === 'step/start') openStep = data
    else if (['step/end', 'turn/start', 'turn/end'].includes(type)) openStep = undefined
    else if (type === 'tool/call') {
      const key = keyOfCall(data, data.callId)
      nativeCalls.set(key, nativeCalls.has(key) ? null : data)
    } else if (type === 'tool/ptc-dispatch-start' && openStep) {
      const innerId = keyOfCall(openStep, data.subCallId)
      if (innerIds.has(innerId)) return
      innerIds.add(innerId)
      const parentKey = keyOfCall(openStep, data.parentCallId)
      if (!startsByParent.has(parentKey)) startsByParent.set(parentKey, [])
      startsByParent.get(parentKey).push({ data, innerId, step: openStep })
    }
  }
  if (!openStep) return

  // Rebuild the pinned reviewer's call order with the logged identities attached.
  // It emits each started native call and its inner calls in surface order, then
  // moves just the pending inner call to the end when building a PTC review.
  const calls = []
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event?.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-call') continue
      const key = keyOfCall(event.data, block.id)
      const native = nativeCalls.get(key)
      if (native === null) return
      if (!native) continue
      calls.push({ mode: 'native', name: native.name, arguments: native.arguments, key })
      for (const start of startsByParent.get(key) ?? []) {
        calls.push({ mode: 'ptc-inner', name: start.data.name, arguments: JSON.stringify(start.data.arguments, null, 2),
          parentKey: key, ...start })
      }
    }
  }

  const history = entries.filter(entry => entry?.kind === 'tool-call' && entry !== pending)
  if (calls.length !== history.length + 1) return
  const matches = (call, entry) => call.mode === entry.mode && call.name === entry.name && call.arguments === entry.arguments
  // Validate both sides of the one omitted dispatch before using its logged parent key.
  const firstDifference = history.findIndex((entry, index) => !matches(calls[index], entry))
  const index = firstDifference === -1 ? history.length : firstDifference
  const omitted = calls[index]
  // Pre-execute is ordered within each program, so if identical calls occur in
  // that program, its latest recorded start is the one still in review.
  if (!matches(omitted, pending) || omitted.step !== openStep ||
      startsByParent.get(omitted.parentKey)?.at(-1)?.innerId !== omitted.innerId ||
      omitted.data.rootCallId !== omitted.data.parentCallId ||
      nativeCalls.get(omitted.parentKey)?.name !== RUN_CODE_NAME ||
      !history.slice(index).every((entry, offset) => matches(calls[index + offset + 1], entry))) return
  const parentIndex = calls.findIndex(call => call.key === omitted.parentKey)
  return history[parentIndex]
}

function reviewRefusals(entries, session) {
  const refusals = sessionLedger(session)?.refused
  const matches = new Map()
  if (!refusals?.size) return matches
  // The typed reviewer omits message IDs. It emits one entry per person text
  // block, in surface order. Verify that correspondence before using a refusal.
  const personTexts = entries.filter(entry => entry?.kind === 'user-message' &&
    entry.source?.kind === 'user' && entry.content?.[0]?.type === 'text')
  let index = 0
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source?.kind !== 'user') continue
    for (const part of event.data.content) {
      if (part.type !== 'text') continue
      const entry = personTexts[index++]
      if (JSON.stringify(entry?.source) !== JSON.stringify(event.data.source) ||
          JSON.stringify(entry?.content) !== JSON.stringify([part])) {
        throw new Error('Auto review cannot match recorded Skills refusals to its history')
      }
      const refusal = refusals.get(event.data.id)
      if (refusal) matches.set(entry, refusal)
    }
  }
  if (index !== personTexts.length) throw new Error('Auto review cannot match recorded Skills refusals to its history')
  return matches
}

// DSH experimental Auto review serializes typed history entries from the Session.
// Its final entry and matching schema are the pending action. Keep that envelope
// even for a Skills read, with no private arguments; the executor keeps the real call.
function projectReview(options, session) {
  const { messages } = options
  if (!Array.isArray(messages)) return options
  const environment = messages[0]?.content?.[0]?.text
  if (typeof environment !== 'string' || !environment.startsWith('ENVIRONMENT\n')) return options
  const entries = messages.map((message, index) => index === 0 ? undefined : reviewEntry(message))
  const refusals = reviewRefusals(entries, session)
  const pending = entries.at(-1)
  const privatePrograms = skillPrograms(entries)
  if (pending?.kind === 'tool-call' && pending.mode === 'ptc-inner' && skillToolName(pending.name)) {
    const program = pendingSkillProgram(session, entries, pending)
    // The reviewer treats a stream failure as a denial. Without a proven
    // parent, sending the review could expose the program's private argument.
    if (!program) throw new Error('Auto review cannot identify the program for the pending Skills read')
    privatePrograms.add(program)
  }
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
      const refusal = refusals.get(entry)
      const ordinary = entry.source.skillRoomLines?.length
        ? projectRoomContent(entry.content, entry.source.skillRoomLines, emptySet) : projectLegacyContent(entry.content, refusal)
      const content = personParts(ordinary)
      if (refusal && onlyGesture(content)) return drop()
      if (content.length === 0 && entry.content.length > 0) return drop()
      const fields = REVIEW_SOURCE_FIELDS.filter(key => Object.hasOwn(entry.source, key))
      if (fields.length === 0 && ordinary === entry.content && content.length === entry.content.length) return [message]
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

function withoutInactiveGestures(text, inactive, existing) {
  let result = ''
  let offset = 0
  for (const match of text.matchAll(GESTURE)) {
    const name = (match[2] ?? match[3] ?? match[4]).toLowerCase()
    if (!inactive.has(name) || (match[2] !== undefined && (reservedCommandOf(name) || existing.has(name)))) continue
    const start = match.index + (match[1]?.length ?? 0)
    const end = match.index + match[0].length
    result += text.slice(offset, start)
    offset = end
    // Retain line breaks and avoid joining words or leaving doubled separators.
    if (/[ \t]$/.test(result) && (end === text.length || /[\s.?!,;:]/.test(text[end]))) result = result.slice(0, -1)
    if (result === '' && /[ \t]/.test(text[end] ?? '')) offset++
  }
  return result + text.slice(offset)
}

export const emptyAfterSkillCall = text => /^[\s.?!,;:]*$/.test(text)
const onlyGesture = content => content.every(part => part.type === 'text' && emptyAfterSkillCall(part.text))
const emptySet = new Set()

export function groupSkillRequests(line) {
  return line.kind === undefined && line.botId === undefined && line.who === 'User' && Array.isArray(line.skillRequests)
    ? line.skillRequests : []
}

export function projectGroupSkillText(line, text, active = emptySet, refused = emptySet) {
  const inactive = new Set(groupSkillRequests(line).filter(({ name }) => refused.has(name) || !active.has(name)).map(({ name }) => name))
  if (inactive.size === 0 || typeof text !== 'string') return text
  const ordinary = withoutInactiveGestures(text, inactive, emptySet)
  return ordinary !== text && emptyAfterSkillCall(ordinary) ? '' : ordinary
}

// Parent-format refusals were appended in the same step as the inputs, after
// the batch. A slash lookup and a phrase of the same name can have different
// outcomes. Count the phrase inputs first, then match any remaining slash refusals.
function rememberRefusedInputs(state) {
  const { rows, notices } = state.batch
  if (notices.size === 0) return
  const candidates = new Map()
  for (const row of rows) for (const request of requestedSkills(row.content)) {
    if (!notices.has(request.name)) continue
    if (!candidates.has(request.name)) candidates.set(request.name, [])
    candidates.get(request.name).push({ id: row.id, slash: request.slash })
  }
  for (const [name, count] of notices) {
    const inputs = candidates.get(name) ?? []
    const phrases = inputs.filter(input => !input.slash)
    if (count < phrases.length || count > inputs.length) continue
    const slashRefused = count === inputs.length
    for (const { id } of slashRefused ? inputs : phrases) {
      if (!state.refused.has(id)) state.refused.set(id, { names: new Set(), keepSlashes: new Set() })
      const refusal = state.refused.get(id)
      refusal.names.add(name)
      if (!slashRefused) refusal.keepSlashes.add(name)
    }
  }
}

// The Session records injected blocks before dispatch. A permission change in that gap
// must take effect before the current batch leaves the host. Blocks already sent belong
// to the same conversation's history, including when it reopens.
const ledgers = new WeakMap()

function sessionLedger(session) {
  if (!session?.eventAt) return
  let state = ledgers.get(session)
  if (!state) ledgers.set(session, state = { seq: 0, rows: new Map(), delivered: new Set(), refused: new Map(), activity: new Set() })
  for (; state.seq < session.seq; state.seq++) {
    const event = session.eventAt(state.seq)
    if (event === undefined) {
      // Match only the legacy inputs and refusal notices seen together before the gap.
      if (state.batch) rememberRefusedInputs(state)
      // A missing event breaks turn and step continuity. Keep confirmed history,
      // while waiting for a recorded turn start before admitting fresh deliveries.
      state.incompleteTurn = true
      state.turn = undefined
      state.position = undefined
      state.batch = undefined
      state.attempt = undefined
      continue
    }
    if (event.type === 'turn/start') {
      state.incompleteTurn = false
      state.turn = event.data.turn
      state.position = { turn: state.turn, step: 0 }
    } else if (event.type === 'turn/end') {
      state.turn = undefined
      state.position = undefined
    } else if (event.type === 'step/start') {
      state.batch = { rows: [], notices: new Map() }
      state.position = { ...state.position, turn: event.data.turn, step: event.data.step }
    } else if (event.type === 'step/end' && state.batch) {
      rememberRefusedInputs(state)
      state.batch = undefined
    } else if (event.type === 'assistant/attempt') state.attempt = { seq: event.seq, turn: event.data.turn }
    else if (event.type === 'user/message') {
      const row = event.data
      if (state.turn !== undefined && (row.source?.kind === 'user' || row.source?.kind === 'bot' && row.source.form === 'relay')) {
        state.position = { turn: state.turn, step: state.position.step, source: row.source }
      }
      state.rows.set(row.id, { seq: event.seq, turn: state.turn })
      if (state.batch && row.source?.kind === 'user' && !row.source.automagikSkillOriginalText) state.batch.rows.push(row)
      if (state.batch && row.source?.kind === SKILL_NOTICE && row.source.form === 'notice' && row.content?.length === 1) {
        const part = row.content[0]
        const name = part.type === 'text' ? /^The skill ([a-z0-9-]+) is not active/.exec(part.text)?.[1] : undefined
        if (name && skillName(name) && part.text === noticeText(name)) state.batch.notices.set(name, (state.batch.notices.get(name) ?? 0) + 1)
      }
    } else if (event.type === 'tool/result') state.rows.set(event.data.message.id, { seq: event.seq, turn: event.data.turn })
    else if (event.type === DELIVERY_RECORD && Array.isArray(event.data)) {
      if (session.isOwnSeq?.(event.seq) !== false) for (const id of event.data) state.delivered.add(id)
    } else if (event.type === SKILL_ACTIVITY_RECORD && session.isOwnSeq?.(event.seq) !== false) state.activity.add(event.data?.id)
  }
  return state
}

function projectLegacyContent(content, refusal) {
  if (!refusal) return content
  return content.map(part => part.type === 'text' && part.automagikSkill === undefined
    ? { ...part, text: withoutInactiveGestures(part.text, refusal.names, refusal.keepSlashes) } : part)
}

export function legacySkillHistory(session) {
  const refused = sessionLedger(session)?.refused
  if (!refused?.size) return
  return row => {
    const refusal = refused.get(row.id)
    const content = projectLegacyContent(row.content, refusal)
    return refusal && onlyGesture(content) ? [] : content
  }
}

export function projectRoomContent(content, lines, active = emptySet) {
  const blocks = content.slice(0, lines.length)
  if (blocks.length !== lines.length || blocks.some(block => block.type !== 'text')) return content
  // Split at person-line boundaries so request redaction can change text lengths
  // before this projection without shifting which text a refusal applies to.
  const text = blocks.map((block, index) => {
    const inactive = new Set(lines[index].filter(name => !active.has(name)))
    return inactive.size ? withoutInactiveGestures(block.text, inactive, emptySet) : block.text
  }).join('')
  return [{ ...blocks[0], text }, ...content.slice(lines.length)]
}

export function skillPart(botId, skill, use = 'person') {
  return { type: 'text', text: skill.content,
    automagikSkill: { kind: SKILL_SOURCE, botId, name: skill.name, hash: skill.hash, use } }
}

export function loadSkill(rt, sessionId, name) {
  const owner = skillOwner(rt, sessionId)
  if (owner?.kind !== 'own' && rt.canUseWorkerSkillTool?.(sessionId) !== true) return
  const skill = automaticOf(recordsOf(rt, owner)).find(record => record.name === name)
  return skill && skillPart(owner.botId, skill, 'load')
}

function skillBinding(rt, agent) {
  const tools = rt.ctx.get?.('tools') ?? rt.ctx.tools
  const definition = rt.teamTools?.find(tool => tool.name === SKILL_TOOL)
  const registration = tools?.view?.(agent)?.registrations?.get(SKILL_TOOL)
  const service = tools?.[symbols.original] ?? tools
  if (definition !== undefined && registration?.definition === definition &&
      tools?.executable?.(SKILL_TOOL, agent) === definition && isTrustedToolRegistration(registration) &&
      scopeOf(agent.ctx) === agent && service?.layers?.peek?.(agent)?.tools?.get(SKILL_TOOL) === registration) {
    return { definition, registration }
  }
}

function reviewedRecord(rt, sessionId, name, agent, session) {
  const agents = rt.ctx.get?.('agents') ?? rt.ctx.agents
  if (!skillName(name) || typeof sessionId !== 'string' || session?.id !== sessionId ||
      agent?.session !== session || agents?.get?.(sessionId) !== agent || rt.teamCurrent?.() === false) return
  const owner = skillOwner(rt, sessionId, session)
  if (owner === undefined || !hasCurrentRoot(rt, owner)) return
  if (owner.kind !== 'own' && rt.canUseWorkerSkillTool?.(sessionId) !== true) return
  const skill = automaticOf(recordsOf(rt, owner)).find(record => record.name === name)
  if (!skill || skill.held !== undefined || typeof skill.hash !== 'string' || typeof skill.content !== 'string') return
  // The library exposes review only after verifying the seal against the current hash.
  const { review } = skill
  if (review?.status === 'done' && review.hash === skill.hash && Array.isArray(review.findings)) {
    return { botId: owner.botId, name, hash: skill.hash, text: skill.content }
  }
}

export function reviewedSkill(rt, sessionId, name, agent, session) {
  try {
    const record = reviewedRecord(rt, sessionId, name, agent, session)
    const binding = record && skillBinding(rt, agent)
    if (binding === undefined) return
    return Object.freeze({
      ...record,
      definition: binding.definition,
      current() {
        try {
          const now = reviewedRecord(rt, sessionId, name, agent, session)
          const active = now && skillBinding(rt, agent)
          return active?.registration === binding.registration && active.definition === binding.definition &&
            now.botId === record.botId && now.hash === record.hash && now.text === record.text
        } catch {
          return false
        }
      },
    })
  } catch {
    return undefined
  }
}

export function skillTool(rt) {
  return defineTool({
    name: SKILL_TOOL,
    description: 'Load the full instructions of one of your active skills by its exact name from your skills list.',
    parameters: { name: { type: 'string', required: true, description: 'Exact skill name from your skills list.' } },
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

function systemIndexBeforeCall(messages, callIndex) {
  const hasWireContent = row => row.role === 'tool' ||
    (row.role === 'user' || row.role === 'assistant') && row.content.some(part =>
      part.type === 'text' ? part.text !== '' : row.role === 'assistant' || part.type === 'image' || part.type === 'file')
  // The serializer flushes queued system updates before a nonempty assistant
  // reply. Without an earlier reply, only the leading snapshot is effective.
  const assistant = messages.findLastIndex((row, index) =>
    index < callIndex && row.role === 'assistant' && hasWireContent(row))
  const boundary = assistant >= 0 ? assistant : messages.findIndex(hasWireContent)
  return messages.findLastIndex((row, index) => index < boundary && row.role === 'system')
}

export function install(rt) {
  const { ctx } = rt
  const sessionOf = id => (ctx.get?.('sessions') ?? ctx.sessions)?.get?.(id) ?? ctx.get?.('agents')?.get?.(id)?.session
  const auxiliaryRequest = options => options.purpose !== undefined || rt.ownRequest?.(options) === true
  const availableRecords = sessionId => {
    const owner = skillOwner(rt, sessionId)
    if (owner?.kind === 'own' || rt.canUseWorkerSkillTool?.(sessionId) === true) return automaticOf(recordsOf(rt, owner))
    return []
  }

  function project(options, { catalog = true, turnStart, historyOnly = false,
    session: capturedSession, auxiliary = auxiliaryRequest(options),
    personCalls = catalog ? new WeakSet() : undefined } = {}) {
    const messages = options.messages
    if (!Array.isArray(messages)) return options
    const { sessionId } = options
    const matches = typeof sessionId === 'string' && capturedSession?.id === sessionId && capturedSession.header?.id === sessionId
    const session = capturedSession === undefined ? sessionOf(sessionId) : matches ? capturedSession : undefined
    const owner = capturedSession === undefined || matches ? skillOwner(rt, sessionId, capturedSession) : undefined
    const detachedDelegation = historyOnly && matches && owner === undefined ? nestedDelegationId(session) : undefined
    const botId = owner?.botId
    const bot = rt.botOf(botId)
    const worker = owner !== undefined && owner.kind !== 'own'
    const permitted = !worker || rt.canUseWorkerSkillTool?.(options.sessionId) === true
    const records = auxiliary ? [] : recordsOf(rt, owner)
    const automatic = automaticOf(records)
    const current = new Map(records.map(record => [record.name, record]))
    const state = sessionLedger(session)
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
      const { automagikSkillParts, automagikSkillOriginalText, skillRoom, skillRoomLines, skillRequests, ...source } = row.source ?? {}
      const legacyRefusal = state?.refused.get(row.id)
      const logged = state?.rows.get(row.id)
      let ordinary = projectLegacyContent(row.content, legacyRefusal)
      if (skillRoomLines?.length) ordinary = projectRoomContent(ordinary, skillRoomLines, current)
      // DSH gives delegated prompts a user source. Both provider input and
      // ACP replay omit gestures on the child's own Bot-authored rows.
      const delegated = owner?.kind === 'subagent' && (!logged || session?.isOwnSeq?.(logged.seq) !== false) ||
        detachedDelegation !== undefined && row.id === detachedDelegation
      if (delegated && row.source?.kind === 'user') {
        const names = new Set(requestedSkills(ordinary).map(({ name }) => name))
        if (names.size > 0) {
          ordinary = ordinary.map(part => part.type === 'text' && !marker(part)
            ? { ...part, text: withoutInactiveGestures(part.text, names, emptySet) } : part)
          if (onlyGesture(ordinary)) { changed = true; return [] }
        }
      }
      const parts = Array.isArray(automagikSkillParts)
        ? [...ordinary, ...automagikSkillParts.filter(marker)] : ordinary
      const content = parts?.filter(part => {
        const ref = marker(part)
        if (!ref) return !load
        if (auxiliary || ref.catalog === true) return false
        if (bot === undefined || ref.botId !== botId) return false
        if (state?.delivered.has(receipt(row, part, ref))) return true
        if (logged && session?.isOwnSeq?.(logged.seq) === false) return false
        if (ref.use === 'load' && !permitted) return false
        if (state?.incompleteTurn || historyOnly || index < retry || row.source?.resumed === true || row.source?.retried === true) return false
        const fresh = row.role === 'tool' ? index > lastAnswer : index >= start
        if (!fresh || (logged && (state.turn === undefined || logged.turn !== state.turn ||
          (state.attempt?.turn === logged.turn && state.attempt.seq > logged.seq)))) return false
        const skill = current.get(ref.name)
        const checked = skill !== undefined && skill.hash === ref.hash && skill.content === part.text &&
          (ref.use !== 'load' || skill.mode === AUTOMATIC_SKILL_MODE)
        if (checked && ref.use === 'person' && row.role === 'user' && part.type === 'text' && part.text !== '') {
          personCalls?.add(part)
        }
        return checked
      })
      const refused = load && row.isError !== true && content?.length === 0
      const privateSource = automagikSkillParts !== undefined || automagikSkillOriginalText !== undefined ||
        skillRoom !== undefined || skillRoomLines !== undefined || skillRequests !== undefined
      if (!refused && !privateSource && ordinary === row.content && content?.length === row.content?.length) return [row]
      changed = true
      if ((automagikSkillOriginalText || skillRoom === 'only') && !content?.some(part => part.type !== 'text' || part.text.trim() !== '')) return []
      if (legacyRefusal && onlyGesture(content)) return []
      return [{ ...row, content, ...(refused && { isError: true }),
        ...(privateSource ? { source } : {}) }]
    })
    const advertised = !worker || options.tools?.some(tool => tool.name === SKILL_TOOL ||
      (tool.name === RUN_CODE_NAME && rt.workerSkillInStep?.(options.sessionId) === true))
    if (catalog && bot && automatic.length && permitted && advertised) {
      // Add the current section to the request's system prompt without recording a
      // catalog in the conversation.
      const part = {
        type: 'text', text: catalogOf(automatic),
        automagikSkill: { kind: SKILL_SOURCE, catalog: true, botId,
          skills: automatic.map(({ name, hash }) => ({ name, hash })) },
      }
      const callIndex = result.findIndex(row => row.content?.some(part => personCalls.has(part)))
      const request = callIndex >= 0 ? session?.requestContext?.() : undefined
      const inHistoryCall = request?.systemPromptUpdate === 'in-history' &&
        request.provider === options.provider && request.model === options.model
      const first = inHistoryCall ? systemIndexBeforeCall(result, callIndex) : result.findIndex(row => row.role === 'system')
      const last = inHistoryCall ? first : result.findLastIndex(row => row.role === 'system' && row.content.length > 0)
      if (first < 0) result.unshift({ ...createSystemMessage(''), content: [part] })
      else for (const index of new Set([first, Math.max(first, last)])) {
        const row = result[index]
        const section = row.content.length === 0 ? part : { ...part, text: '\n\n' + part.text }
        result[index] = { ...row, content: [...row.content, section] }
      }
      changed = true
    }
    const tools = worker && !permitted && options.tools?.some(tool => tool.name === SKILL_TOOL)
      ? options.tools.filter(tool => tool.name !== SKILL_TOOL) : undefined
    return changed || tools ? { ...options, messages: result, ...(tools && { tools }) } : options
  }

  function recordActivity(session, state, id, ref, position) {
    try {
      if (!position || !skillName(ref.name) || state.activity.has(id) || ref.botId !== skillOwner(rt, session.id)?.botId) return
      const { turn, step, source, eventSeq } = position
      if (eventSeq === undefined && (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step))) return
      const room = rt.skillRoomActivity?.(session.id, ref.botId, source)
      // A private exchange in a group member Session has no visible room relay.
      if (room === undefined && (source?.role === 'room' || rt.groupOwners?.has(session.id))) return
      const seq = appendPluginRecord(session, SKILL_ACTIVITY_RECORD, { id, name: ref.name,
        ...(eventSeq === undefined ? { turn, step } : { eventSeq }),
        ...(room && { roomId: room.roomId }) })
      room?.record(id, ref.name, session.eventAt(seq).time)
    } catch (error) {
      try { rt.warn?.('Skills activity could not be recorded: %s', error) } catch {}
    }
  }

  function admit(options, session = sessionOf(options.sessionId), { activity = true } = {}) {
    const state = sessionLedger(session)
    if (!state || state.incompleteTurn) return
    const delivered = new Set()
    for (const row of options.messages) for (const part of row.content ?? []) {
      const ref = marker(part)
      if (ref && !ref.catalog) {
        const id = receipt(row, part, ref)
        if (state.delivered.has(id) || delivered.has(id)) continue
        delivered.add(id)
        const logged = state.rows.get(row.id)
        if (activity && !options.signal?.aborted && !row.isError && logged && state.turn !== undefined && logged.turn === state.turn) {
          const position = row.source?.role === 'room' ? { ...state.position, source: row.source } : state.position
          recordActivity(session, state, id, ref, position)
        }
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
    snapshot(sessionId, botId, instructionsId) {
      const owner = skillOwner(rt, sessionId)
      if (owner === undefined || owner.botId !== botId || rt.teamCurrent?.() === false ||
          !hasCurrentRoot(rt, owner)) return
      return {
        skillsOwner: owner.botId,
        skillsInstructionsId: instructionsId,
        skills: recordsOf(rt, owner, { worker: true }).map(({ name, mode, hash, assignment, revision }) =>
          ({ name, mode, hash, assignment, revision })),
        ...(!permitsWorkerLoad(rt, owner) && { skillsLoadBlocked: true }),
      }
    },
    workerAvailable(sessionId, agent) {
      const owner = skillOwner(rt, sessionId)
      return owner !== undefined && owner.kind !== 'own' && hasCurrentRoot(rt, owner) && permitsWorkerLoad(rt, owner, agent) &&
        automaticOf(recordsOf(rt, owner)).length > 0
    },
    available: sessionId => availableRecords(sessionId).length > 0,
    noticeAgyUnavailable(session) {
      if (!session) return
      try {
        const seen = session.deriveMessages().some(row => row.source?.kind === SKILL_NOTICE &&
          row.content?.[0]?.text === AGY_OFF_SKILLS_NOTICE)
        if (!seen) session.append('user/message', skillNotice(AGY_OFF_SKILLS_NOTICE), { surfaceOp: 'append' })
      } catch (error) {
        try { rt.warn?.('Skills availability notice could not be recorded: %s', error) } catch {}
      }
    },
    load: (sessionId, name) => loadSkill(rt, sessionId, name),
    reviewed: (sessionId, name, agent, session) => reviewedSkill(rt, sessionId, name, agent, session),
    unavailable: SKILL_UNAVAILABLE,
    catalog(sessionId) {
      const records = availableRecords(sessionId)
      return { key: keyOf(records), text: catalogOf(records) }
    },
    project, admit,
    bridgePosition(session, { turn, step }) {
      const state = sessionLedger(session)
      const position = state?.position
      if (state?.turn === turn && position?.turn === turn && position.step === step) return position
    },
    bridgeActivity(session, position, callId, part, replay) {
      const state = sessionLedger(session)
      const ref = marker(part)
      if (state && position && ref?.use === 'load') {
        const { eventSeq, turn, step } = position
        if (eventSeq === undefined && state.incompleteTurn) return
        if (eventSeq !== undefined) {
          const event = session.eventAt(eventSeq)
          if (event?.type !== 'plugin:acp-dsh/bridge-outside-step' || event.data?.callId !== callId ||
              event.data.name !== SKILL_TOOL || event.data.outcome !== 'ran') return
        }
        const id = replay !== undefined ? ['bridge-request', replay]
          : eventSeq !== undefined ? ['bridge-outside-step', callId] : ['bridge', turn, step, callId]
        recordActivity(session, state, JSON.stringify(id), ref, position)
      }
    },
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (signal.aborted || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    await rt.load()
    const owner = skillOwner(rt, agent.id)
    const botId = owner?.botId
    if (owner === undefined || signal.aborted) return decision
    if (owner.kind === 'subagent') return decision
    const original = new Map(messages.map(row => [row.id, row]))
    const served = new Set(decision.messages.filter(row => row.source?.kind === 'skill-invocation')
      .map(row => row.source.name))
    const notices = []
    const rows = decision.messages.map(row => ({ row, input: original.get(row.id) }))
    const pending = []
    for (const { row, input } of rows) {
      if (!input || input.id === owner.task?.skillsInstructionsId || input.source?.automagikSkillParsed ||
          !['user', 'bot'].includes(input.source?.kind)) continue
      const requests = input.source.kind === 'user' ? requestedSkills(input.content) :
        input.source.role === 'room' && Array.isArray(input.source.skillRequests)
          ? input.source.skillRequests.filter(request => skillName(request?.name)) : []
      if (requests.length > 0) pending.push({ row, requests: [...new Map(requests.map(request => [request.name, request])).values()] })
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

    const records = new Map(recordsOf(rt, skillOwner(rt, agent.id)).map(record => [record.name, record]))
    const modified = new Map()
    const hostOnly = new Set()
    for (const { row, requests } of pending) {
      const parts = []
      const inactive = new Set()
      for (const { name, slash: isSlash, lineSeqs } of requests) {
        if (!skillName(name) || served.has(name) || (isSlash && row.source.kind === 'user' && existing.has(name))) continue
        const record = records.get(name)
        if (record) parts.push(skillPart(botId, record))
        else {
          inactive.add(name)
          notices.push({ name, roomId: row.source.roomId, lineSeqs })
        }
      }
      if (parts.length === 0 && inactive.size === 0) continue
      const originalText = {}
      let content = inactive.size === 0 || row.source.skillRoom !== undefined ? row.content : row.content.map((part, index) => {
        if (part.type !== 'text' || part.automagikSkill !== undefined) return part
        const text = withoutInactiveGestures(part.text, inactive, row.source.kind === 'user' ? existing : served)
        if (text === part.text) return part
        if (row.source.kind === 'user') originalText[index] = part.text
        return { ...part, text }
      })
      if (inactive.size && parts.length === 0 &&
          ((row.source.kind === 'user' && onlyGesture(content)) || row.source.skillRoom === 'only')) {
        hostOnly.add(row.id)
        content = row.source.skillRoom === 'only' ? [] : content.map(part => ({ ...part, text: '' }))
      }
      modified.set(row.id, {
        // DSH titles read logged person content directly. The model projection
        // receives checked parts at dispatch and strips the original wording.
        ...row, content, source: { ...row.source, automagikSkillParsed: true,
          ...(parts.length > 0 && { automagikSkillParts: parts }),
          ...(Object.keys(originalText).length > 0 && { automagikSkillOriginalText: originalText }),
        },
      })
    }
    if (!modified.size && !notices.length) return decision
    const privateRows = []
    for (const { name, roomId, lineSeqs } of notices) {
      const text = noticeText(name)
      if (roomId !== undefined) rt.roomSkillNotice?.(roomId, botId, text, { name, lineSeqs })
      else privateRows.push(skillNotice(text))
    }
    if (hostOnly.size && decision.messages.every(row => hostOnly.has(row.id) ||
          (!original.has(row.id) && CONTEXT_SOURCES.has(row.source?.kind)))) {
      // A memory update has already advanced its seen cursor. Keep that update
      // for the next real request while clocks and snapshots can be rebuilt.
      const kept = decision.messages.flatMap(row => hostOnly.has(row.id) ? [modified.get(row.id)]
        : row.source?.kind === MEMORY_UPDATE_SOURCE ? [row] : [])
      for (const row of [...kept, ...privateRows]) {
        agent.session.append('user/message', row, { surfaceOp: 'append' })
        if (row.source?.skillRoom === 'only') rt.roomSkillHandled?.(row.source.roomId, botId, row.source.exchangeId)
      }
      // An empty first step completes the turn. An existing tool continuation
      // can still finish the work that was already running when the person steered.
      return { kind: 'enter', messages: [] }
    }
    return { ...decision, messages: [...decision.messages.map(row => modified.get(row.id) ?? row), ...privateRows] }
  }, { prepend: true })

  ctx.on('tools/pre-execute', async function refuseSkillPatch(exec, next) {
    if (exec.name === SKILL_TOOL && !loadSkill(rt, exec.agent?.id, exec.arguments?.name)) {
      return { kind: 'deny', reason: SKILL_UNAVAILABLE }
    }
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
    const review = options.purpose === 'auto-review'
    const input = review && !previous?.review ? projectReview(options, sessionOf(options.sessionId)) : options
    const outgoing = project(input, { catalog: !alternate, auxiliary })
    if (outgoing === options) return next()
    const request = { ...outgoing, [SKILLS_PROJECTED]: { provider: options.provider, auxiliary, review } }
    rt.carryUsageTag?.(options.messages, request.messages)
    if (!isAgentLoopRequest(options)) return ctx.llm.stream(request)
    const stream = ctx.llm.stream(markAgentLoopRequest(freezeLoopRequest(request)))
    return alternate ? stream : confirmDelivery(stream, outgoing)
  }, { prepend: true })
}
