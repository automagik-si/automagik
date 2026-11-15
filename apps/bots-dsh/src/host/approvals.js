// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card; its requests are only noted, so
// the team view can say who is waiting. So does a running task a Bot started
// (start_task, agents.js): its approval is noted under that Bot with the task's id
// (`taskId`) and title (`label`), so the Bot shows it needs the user, the parent's chat
// can say which task waits, and the task's thread waits in amber. A subagent child's
// ask is held under its Bot, where the person can answer it.
import { createHash, randomUUID } from 'node:crypto'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }

// The team's own lookups only read the team: who is on it, their models and capabilities, a
// chat's or a group's transcript, a memory. A Claude Code session reaches them through its MCP
// bridge (`mcp__dsh__<name>`), which asks for every call; those asks are answered here, so the
// person is asked only about what changes something.
export const TEAM_LOOKUPS = new Set(['list_bots', 'list_bot_models', 'list_capabilities', 'read_own_chat', 'read_group_chat', 'recall'])
export const teamToolOf = name => String(name ?? '').replace(/^mcp__dsh__/, '')

export function answerableOwner(rt, owner) {
  return owner?.child === true && rt.botOf?.(owner.botId) !== undefined
    && (owner.kind === 'chat' || owner.kind === 'group' || (owner.kind === 'task' && rt.state?.tasks?.[owner.taskId]?.status === 'working'))
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {id:string, sessionId:string, botId:string, child?:boolean, ownerSessionId?:string, roomId?:string, taskId?:string, label?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, answer?:(outcome:string)=>void}>} */
  const pending = new Map()
  // A task a Bot of the team started that still runs, by its Session.
  const runningTask = (sessionId) => {
    const task = rt.state?.tasks?.[sessionId]
    return task?.status === 'working' && rt.botOf?.(task.from) !== undefined ? task : undefined
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    if (TEAM_LOOKUPS.has(teamToolOf(request.toolName))) return 'allowed-once'
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const task = sessionId === undefined ? undefined : runningTask(sessionId)
    const chat = sessionId === undefined ? undefined : rt.chatOwners.get(sessionId)
    const run = owner === undefined && chat === undefined && task === undefined ? rt.teamOwnerOf?.(sessionId, request.agent) : undefined
    if (run?.child === true || rt.asksThroughBot?.(sessionId) === true) return childAsk(request, sessionId, run)
    const runOwner = run?.run === true && run.child !== true ? run : undefined
    const botId = owner?.botId ?? chat ?? task?.from ?? runOwner?.botId
    if (botId === undefined) return next()
    const id = randomUUID()
    const entry = {
      id,
      sessionId,
      botId,
      ...(owner ? { roomId: owner.roomId } : {}),
      ...(owner === undefined && task !== undefined ? { taskId: sessionId, label: String(task.title ?? '').trim() } : {}),
      ...(runOwner ? { taskId: sessionId, label: runOwner.label ?? '' } : {}),
      ...(request.callId !== undefined ? { callId: request.callId } : {}),
      tool: String(request.toolName ?? ''),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at: Date.now(),
    }
    // Asks that do the same thing share one card (live-rail.js): the same Bot, working folder,
    // tool, reason and fully shown target. Each one is still answered on its own.
    // A reason past what the entry keeps could differ unseen: such an ask stays on its own.
    const whole = String(request.reason ?? '').length <= 500 && !/[\u0000-\u001f\u007f]/.test(String(request.reason ?? ''))
    const target = entry.tool === 'keep_working' || !whole ? undefined : rt.callCapability?.(sessionId, request.callId, entry.tool)
    const folder = target === undefined ? undefined : rt.sessionFolder?.(request.agent?.session ?? request.agent)
    if (typeof folder === 'string' && folder !== '') {
      entry.capabilityKey = createHash('sha256').update(JSON.stringify(['v1', entry.botId, folder, entry.tool, entry.reason, target])).digest('hex')
    }
    pending.set(id, entry)
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    const settled = () => {
      pending.delete(id)
      rt.noteApproval?.(sessionId, undefined)
    }
    if (owner === undefined) return Promise.resolve(next()).finally(settled)
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!pending.has(id)) return
        settled()
        resolve(outcome)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }, { prepend: true })

  ctx.effect(() => () => {
    for (const entry of pending.values()) if (entry.child) entry.answer?.('cancelled')
  }, 'ds-bot: cancel held subagent asks')

  function childAsk(request, sessionId, owner) {
    // Fail closed: nothing here can ask the person, so this is not their answer.
    if (!answerableOwner(rt, owner)) {
      rt.noteStop?.(sessionId, { why: 'unavailable', tool: request.toolName, callId: request.callId }, request.agent)
      rt.warn('ds-bot: subagent approval has no answerable owner: %s', sessionId)
      return 'cancelled'
    }
    const id = randomUUID()
    const entry = {
      id, sessionId, botId: owner.botId, child: true, ownerSessionId: owner.sessionId,
      ...(owner.kind === 'group' ? { roomId: owner.roomId } : {}),
      ...(owner.kind === 'task' ? { taskId: owner.taskId, label: String(owner.label ?? '').trim() } : {}),
      ...(request.callId !== undefined ? { callId: request.callId } : {}),
      tool: String(request.toolName ?? ''),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at: Date.now(),
    }
    pending.set(id, entry)
    if (owner.kind === 'group') rt.yieldRoomTurn?.(owner.sessionId)
    return new Promise(resolve => {
      const aborted = () => entry.answer('cancelled')
      entry.answer = outcome => {
        if (!pending.delete(id)) return
        request.signal?.removeEventListener('abort', aborted)
        resolve(outcome)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      else request.signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId || entry.ownerSessionId === sessionId)

  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    entry.answer(outcome)
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId || entry.ownerSessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals })
}
