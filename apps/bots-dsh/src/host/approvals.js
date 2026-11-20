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
// The kinds of client that can decide an approval here. A request body's kind is trusted
// only when it is one of these; anything else is the ordinary web client.
const CLIENT_KINDS = new Set(['web', 'desktop', 'im', 'pocket', 'relay', 'sdk', 'dsh', 'system'])

// RFC 0039 delivery 3: the Live rail's "Just finished" window (task-card.js), and the bounds of what is kept.
const ENDED_FOR_MS = 6 * 60 * 60 * 1000
const ENDED_MAX = 50
const UNANSWERED_MAX = 500
const TOLD_MAX = 1000

// The team's own lookups only read the team: who is on it, their models and capabilities, a
// chat's or a group's transcript, a memory. A Claude Code session reaches them through its MCP
// bridge (`mcp__dsh__<name>`), which asks for every call; those asks are answered here, so the
// person is asked only about what changes something.
export const TEAM_LOOKUPS = new Set(['list_bots', 'list_bot_models', 'list_capabilities', 'read_own_chat', 'read_group_chat', 'recall', 'show_settings', 'propose_bot_change'])
export const teamToolOf = name => String(name ?? '').replace(/^mcp__dsh__/, '')

export function answerableOwner(rt, owner) {
  return owner?.child === true && rt.botOf?.(owner.botId) !== undefined
    && (owner.kind === 'chat' || owner.kind === 'group' || (owner.kind === 'task' && rt.state?.tasks?.[owner.taskId]?.status === 'working'))
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {id:string, sessionId:string, botId:string, child?:boolean, ownerSessionId?:string, roomId?:string, taskId?:string, label?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, answer?:(outcome:string, decidedBy?:string, why?:string)=>boolean}>} */
  const pending = new Map()
  const folderIds = new Set()
  // RFC 0039 delivery 3: withdrawals live in memory for the team they happened in. Owners bind each ask
  // to its admission epoch and owner records by identity. A child inherits its parent's owner.
  const withdrawn = []
  const unanswered = new Map()
  const told = new Set()
  const runs = new WeakSet()
  const owners = new WeakMap()
  const teamEpoch = () => rt.teamGeneration?.().epoch
  const ownerRecord = (kind, botId, { roomId, task } = {}) => ({
    epoch: teamEpoch(), kind, bot: rt.botOf?.(botId),
    ...(roomId !== undefined ? { room: rt.roomOf?.(roomId) } : {}),
    ...(task !== undefined ? { task } : {}),
  })
  const current = entry => !runs.has(entry) && owners.has(entry) && owners.get(entry).epoch === teamEpoch()
  const ownedBy = (owner, why, { task } = {}) => owner !== undefined && why === 'task'
    && task !== undefined && owner.kind === 'task' && owner.task === task
  const prune = (now = Date.now()) => {
    const epoch = teamEpoch()
    for (let at = withdrawn.length - 1; at >= 0; at -= 1) if (withdrawn[at].epoch !== epoch) withdrawn.splice(at, 1)
    while (withdrawn.length > 0 && (now - withdrawn[0].at >= ENDED_FOR_MS || withdrawn.length > ENDED_MAX)) withdrawn.shift()
  }
  // Names are stored with the row. The request's reason, detail and arguments stay out of the view.
  const record = (entry, why, botName) => {
    const owner = owners.get(entry)
    const epoch = teamEpoch()
    if (owner === undefined || owner.epoch !== epoch || told.has(entry.id)) return false
    told.add(entry.id)
    while (told.size > TOLD_MAX) told.delete(told.values().next().value)
    withdrawn.push({
      id: entry.id, botId: entry.botId, botName: String(botName ?? owner.bot?.name ?? '').slice(0, 80), sessionId: entry.sessionId,
      ...(entry.ownerSessionId !== undefined ? { ownerSessionId: entry.ownerSessionId } : {}),
      ...(entry.roomId !== undefined ? { roomId: entry.roomId, roomName: String(owner.room?.name ?? '').slice(0, 80) } : {}),
      ...(entry.taskId !== undefined ? { taskId: entry.taskId, label: entry.label ?? '' } : {}),
      ...(entry.child ? { child: true } : {}),
      tool: entry.tool, why, at: Date.now(), epoch,
    })
    prune()
    if (why === 'task' && entry.taskId !== undefined) {
      unanswered.delete(entry.taskId)
      unanswered.set(entry.taskId, epoch)
      while (unanswered.size > UNANSWERED_MAX) unanswered.delete(unanswered.keys().next().value)
    }
    return true
  }
  // A task a Bot of the team started that still runs, by its Session.
  const runningTask = (sessionId) => {
    const task = rt.state?.tasks?.[sessionId]
    return task?.status === 'working' && rt.botOf?.(task.from) !== undefined ? task : undefined
  }
  const approvalListeners = new Set()
  const onApproval = (listener) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  }
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('omni-ui: approval listener failed: %s', error) }
    }
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
    if (rt.isFolderAsk?.(request) === true) folderIds.add(id)
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
    // Hook owners also arrive as run: true (stops.js).
    if (runOwner !== undefined) runs.add(entry)
    owners.set(entry, owner !== undefined ? ownerRecord('group', owner.botId, { roomId: owner.roomId })
      : chat !== undefined ? ownerRecord('chat', chat)
        : task !== undefined ? ownerRecord('task', task.from, { task }) : ownerRecord('run', runOwner?.botId))
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    rt.approvalWaiting?.(entry)
    emit('open', { ...entry, answerable: true })
    const settle = (outcome, decidedBy = 'dsh', why) => {
      if (!pending.has(id)) return false
      pending.delete(id)
      folderIds.delete(id)
      rt.noteApproval?.(sessionId, undefined)
      emit('settled', { id, outcome, decidedBy, at: Date.now(), ...(why !== undefined ? { why } : {}) })
      return true
    }
    if (owner === undefined) {
      // An own-chat approval races DSH's card. The card sees `linked`, our own
      // AbortSignal: answering here resolves the request, then withdraws the card;
      // an answer there settles `next()` first and is adopted. An abort of the
      // original signal cancels either way.
      const original = request.signal
      const linked = new AbortController()
      request.signal = linked.signal
      return new Promise((resolve, reject) => {
        const complete = (outcome, decidedBy = 'dsh', why) => {
          if (!settle(outcome, decidedBy, why)) return false
          resolve(outcome)
          linked.abort()
          if (request.signal === linked.signal) request.signal = original
          return true
        }
        entry.answer = complete
        if (original?.aborted) entry.answer('cancelled')
        else original?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
        Promise.resolve(next()).then(
          (outcome) => {
            if (!pending.has(id)) return
            complete(outcome)
          },
          // DSH's answerer threw: close the entry and give the caller the error
          // the way the pre-race code did, instead of hanging forever.
          (error) => {
            if (!settle('cancelled')) return
            reject(error)
            linked.abort()
            if (request.signal === linked.signal) request.signal = original
          },
        )
      })
    }
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome, decidedBy, why) => {
        if (!settle(outcome, decidedBy, why)) return false
        resolve(outcome)
        return true
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }, { prepend: true })

  ctx.effect(() => () => {
    for (const entry of pending.values()) if (entry.child) entry.answer?.('cancelled', 'system')
    withdrawn.length = 0
    unanswered.clear()
    told.clear()
  }, 'ds-bot: cancel held subagent asks')

  function childAsk(request, sessionId, owner) {
    // Fail closed: nothing here can ask the person, so this is not their answer.
    if (!answerableOwner(rt, owner)) {
      rt.noteStop?.(sessionId, { why: 'unavailable', tool: request.toolName, callId: request.callId }, request.agent)
      rt.warn('ds-bot: subagent approval has no answerable owner: %s', sessionId)
      return 'cancelled'
    }
    const id = randomUUID()
    if (rt.isFolderAsk?.(request) === true) folderIds.add(id)
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
    owners.set(entry, ownerRecord(owner.kind, owner.botId, {
      ...(owner.kind === 'group' ? { roomId: owner.roomId } : {}),
      ...(owner.kind === 'task' ? { task: rt.state?.tasks?.[owner.taskId] } : {}),
    }))
    if (owner.kind === 'group') rt.yieldRoomTurn?.(owner.sessionId)
    return new Promise(resolve => {
      const aborted = () => entry.answer('cancelled')
      entry.answer = outcome => {
        if (!pending.delete(id)) return false
        folderIds.delete(id)
        request.signal?.removeEventListener('abort', aborted)
        resolve(outcome)
        return true
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      else request.signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  function groupAskCurrent(id, room) {
    const entry = pending.get(id)
    if (entry === undefined) return false
    const owner = owners.get(entry)
    return owner?.kind === 'group' && owner.epoch === teamEpoch() && owner.room === room && owner.bot === rt.botOf(entry.botId)
  }
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId || entry.ownerSessionId === sessionId)

  function answerApproval(id, choice, client = 'web') {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    // The record of the decision names the kind of client that made it, and `settle` adds
    // the moment. The harness's own approval/decided event still carries only id and outcome.
    entry.answer(outcome, CLIENT_KINDS.has(client) ? client : 'web')
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId || entry.ownerSessionId === sessionId) entry.answer?.('cancelled', 'system')
    }
  }

  // Check the ending operation before each cancellation and row. Only the call that settled the ask gets a row.
  const endApprovals = async (sessionIds, why, by = {}, valid = () => false) => {
    const ids = new Set([sessionIds].flat().filter(id => typeof id === 'string'))
    let count = 0
    for (const entry of pending.values()) {
      if (!current(entry) || !ownedBy(owners.get(entry), why, by)) continue
      if (!ids.has(entry.sessionId) && !ids.has(entry.ownerSessionId)) continue
      // Yield so DSH answers already given are adopted before cancellation.
      await new Promise(resolve => setImmediate(resolve))
      if (pending.get(entry.id) !== entry) continue
      if (valid() !== true) break
      let won = false
      try { won = entry.answer?.('cancelled', 'system', why) === true } catch (error) { rt.warn('ds-bot: withdrawing an ask failed: %s', error) }
      if (valid() !== true) break
      if (won && record(entry, why, by.botName)) count += 1
    }
    return count
  }
  const withdrawnView = () => { prune(); return withdrawn.map(({ epoch, ...row }) => row) }
  const unansweredView = () => { const epoch = teamEpoch(); return [...unanswered].filter(([, at]) => at === epoch).map(([id]) => id) }

  Object.assign(rt, { approvalsView, groupAskCurrent, isFolderApproval: id => folderIds.has(id), waitsForApproval, answerApproval, cancelApprovals, onApproval, endApprovals, withdrawnView, unansweredView })
}
