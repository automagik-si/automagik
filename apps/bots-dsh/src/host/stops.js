// Permission stops are a memory-only view for the person, never Session events.
import { randomUUID } from 'node:crypto'
import { approvalPolicyOf } from './approval-policy.js'

export const STOP_WHYS = ['never', 'unavailable', 'tool', 'level', 'address', 'review', 'sandbox', 'rule', 'guard', 'guard-request', 'guard-launch', 'limit', 'solver-run', 'solver-progress']
export const STOP_KEEP_MS = 6 * 60 * 60 * 1000
export const STOPS_MAX = 50
export const CALLS_MAX = 20
export const WHY_EN = {
  never: 'approvals are off here, so you were not asked',
  unavailable: 'it needed your approval, but nothing here could ask you',
  tool: 'this Bot does not have that tool',
  level: 'its permission level could not be set here',
  address: 'the address list blocks that site',
  review: 'Auto review refused it',
  sandbox: 'the sandbox blocked it',
  rule: 'a rule here refused it',
  // The Solver's review guard (review-guard.js); `guard-request` when a Bot's new request opened
  // the plan it waits for.
  guard: 'the review guard waits for the reviewer\'s verdict on the plan; you can turn it off in Details',
  'guard-request': 'the review guard waits for the reviewer\'s verdict on a new plan, because another Bot sent a new request; you can turn it off in Details',
  'guard-launch': 'the review guard is on and prevents starting tasks; you can turn it off in Details',
  limit: 'the Solver reached an attempt limit and is waiting for your answer',
  'solver-run': 'the Solver needs to start a check run with solver_progress',
  'solver-progress': 'the Solver needs to finish recording its current progress with solver_progress',
}

export function stopLineEn(entry) {
  const why = WHY_EN[entry.why] ?? WHY_EN.rule
  if (entry.ran === true) {
    return entry.count > 1 ? `${entry.count} steps ran unheld: nothing asked before they ran (${why})`
      : `${entry.tool} ran unheld: nothing asked before it ran (${why})`
  }
  if (entry.mayHaveRun === true) {
    return entry.count > 1 ? `${entry.count} steps may already have run (${why})` : `${entry.tool} may already have run (${why})`
  }
  return entry.count > 1 ? `${entry.count} steps did not run: ${why}`
    : entry.child ? `A subagent step did not run: ${why}`
      : entry.tool ? `${entry.tool} did not run: ${why}` : `A step did not run: ${why}`
}

const line = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const put = (map, key, value, max) => {
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
  return value
}
const pairKey = (sessionId, id) => JSON.stringify([sessionId, id])
const copy = entry => ({ ...entry, calls: entry.calls.map(call => ({ ...call })) })

// Free-text descriptions do not identify an operation. Sort nested file arguments too.
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
function operationOf(exec) {
  const args = exec.arguments ?? {}
  const operation = ['bash', 'pwsh'].includes(exec.name)
    ? { command: args.command, workdir: args.workdir }
    : Object.fromEntries(Object.entries(args).filter(([key]) => !['sandbox_permissions', 'justification', 'description'].includes(key)))
  return pairKey(exec.name, JSON.stringify(sorted(operation)).slice(0, 2000))
}

export function install(rt) {
  const { ctx } = rt
  const sessions = new Map()
  const asks = new Map()
  const decided = new Map()
  const unasked = new Map()
  const entries = new Map()
  const stateOf = id => sessions.get(id) ?? put(sessions, id, { turn: 0, pending: new Map() }, 500)

  // The automation's name comes from Omni's state; ask runs have none, and taskOwners keeps only { botId } because Omni reads it.
  const runLabel = sessionId => {
    const runs = rt.state?.subscriptionRuns
    const record = Array.isArray(runs) ? runs.findLast(item => item?.sessionId === sessionId && item.botId && item.task) : undefined
    return String(rt.state?.subscriptions?.[record?.subId]?.name ?? '').trim().slice(0, 80)
  }

  function teamOwnerOf(sessionId, agent) {
    try {
      let cur = sessionId
      for (let depth = 0; typeof cur === 'string' && depth < 32; depth += 1) {
        const group = rt.groupOwners?.get(cur)
        const chat = rt.chatOwners?.get(cur)
        const task = rt.state?.tasks?.[cur]
        const run = rt.taskOwners?.get(cur)
        const part = rt.pastOwners?.get(cur)
        const candidates = [
          group && { kind: 'group', botId: group.botId, roomId: group.roomId },
          chat !== undefined && { kind: 'chat', botId: chat },
          task && { kind: 'task', botId: task.from, taskId: cur, label: task.title },
          run && { kind: 'run', botId: run.botId, taskId: cur, label: runLabel(cur), run: true },
          part && { kind: 'part', ...part },
        ]
        let owner = candidates.find(candidate => candidate && rt.botOf?.(candidate.botId) !== undefined)
        if (!owner) {
          const hook = rt.extended?.sessionOwner?.(cur)
          if (hook && rt.botOf?.(hook.botId) !== undefined) owner = { kind: 'hook', botId: hook.botId, taskId: cur, label: hook.label, run: true }
        }
        if (owner) return { ...owner, sessionId: cur, ...(depth > 0 ? { child: true } : {}) }
        const header = (depth === 0 ? agent?.session?.header : undefined) ?? ctx.sessions?.get?.(cur)?.header
        if (header?.origin !== 'subagent') return undefined
        cur = header.parentSession
      }
    } catch {}
    return undefined
  }

  function noteUnasked(sessionId, { tool, why, callId, reason }, agent) {
    if (teamOwnerOf(sessionId, agent)?.child !== true) return
    const record = unasked.get(sessionId) ?? put(unasked, sessionId, { items: [], more: 0, seen: new Set() }, 200)
    if (callId !== undefined) {
      if (record.seen.has(callId)) return
      record.seen.add(callId)
      if (record.seen.size > 200) record.seen.delete(record.seen.values().next().value)
    }
    if (record.items.length < CALLS_MAX) record.items.push({ tool: line(tool, 64), why, callId, reason: line(reason, 200) })
    else record.more += 1
  }

  const prune = () => {
    const cutoff = Date.now() - (rt.stopKeepMs ?? STOP_KEEP_MS)
    for (const [key, record] of entries) if (record.entry.last < cutoff) entries.delete(key)
    while (entries.size > STOPS_MAX) entries.delete(entries.keys().next().value)
  }
  const inRound = owner => owner.roomId !== undefined && [...(rt.roomWaiters?.values() ?? [])].some(waiter => waiter.sessionId === owner.sessionId
    || (waiter.botId === owner.botId && waiter.roomId === owner.roomId))
  const resolved = (sessionId, detail, agent) => {
    if (!STOP_WHYS.includes(detail.why)) return undefined
    const owner = teamOwnerOf(sessionId, agent)
    if (!owner) return undefined
    const turn = sessions.get(owner.sessionId)?.turn ?? 0
    return { owner, turn, key: `${owner.sessionId}:${turn}:${detail.why}:${detail.mayHaveRun === true}:${detail.ran === true}`, sessionId, detail }
  }
  function noteResolved({ owner, turn, key, sessionId, detail }) {
    prune()
    let record = entries.get(key)
    const callKey = detail.callId === undefined ? undefined : pairKey(sessionId, detail.callId)
    if (callKey !== undefined && record?.seen.has(callKey)) return
    const now = Date.now()
    const first = record === undefined
    if (first) {
      const { kind: _kind, ...place } = owner
      // A step refused at its approval question (a native subagent's, review-guard.js) is a child's.
      if (detail.child === true) place.child = true
      const entry = { id: randomUUID(), ...place, why: detail.why, tool: line(detail.tool, 64), count: 0, calls: [], text: line(detail.text, 200), at: now, last: now, open: true }
      if (detail.ran === true) entry.ran = true
      if (detail.mayHaveRun === true) entry.mayHaveRun = true
      if (inRound(owner)) entry.inRound = true
      record = { entry, turn, seen: new Set() }
      entries.set(key, record)
    }
    const { entry, seen } = record
    entry.count += 1
    entry.last = now
    entry.open = true
    if (callKey !== undefined) {
      seen.add(callKey)
      if (entry.calls.length < CALLS_MAX) entry.calls.push({ sessionId, callId: detail.callId })
    }
    prune()
    const summary = entry.ran === true ? 'A step ran unheld: ' : 'A step stopped on a permission: '
    if (first) rt.noteFailure?.({ level: 'warn', source: 'host', text: summary + stopLineEn(entry), code: 'stop/' + entry.why,
      bot: rt.botOf?.(owner.botId)?.name, where: owner.roomId ?? owner.taskId ?? owner.botId, sessionId: owner.sessionId })
  }
  function noteStop(sessionId, detail, agent) {
    try {
      const stop = resolved(sessionId, detail, agent)
      if (stop) noteResolved(stop)
      // A subagent's step the review guard held: its parent is told so (who-refused.js), and never
      // to run that step itself.
      if (stop && detail.ran !== true && ['guard', 'guard-request', 'limit'].includes(detail.why)) noteUnasked(sessionId, detail, agent)
    } catch {}
  }
  const stopsView = () => { prune(); return [...entries.values()].filter(({ entry }) => entry.count > 0).map(({ entry }) => copy(entry)) }
  const stopsIn = (sessionId, since) => {
    prune()
    return [...entries.values()].filter(({ entry }) => entry.sessionId === sessionId && entry.last >= since).map(({ entry }) => {
      if (entry.roomId !== undefined) entry.inRound = true
      return copy(entry)
    })
  }
  const stopLineOfTurn = (sessionId, turn) => {
    prune()
    return [...entries.values()].filter(record => record.entry.sessionId === sessionId && record.turn === turn).map(({ entry }) => stopLineEn(entry)).join(' · ') || undefined
  }

  ctx.on('session/event', (session, event) => {
    try {
      const id = session.id
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start': stateOf(id).turn = data.turn; break
        case 'turn/end': {
          const pending = sessions.get(id)?.pending
          if (pending) {
            for (const stop of pending.values()) {
              noteResolved(stop)
              if (approvalPolicyOf(ctx.get('approval'), session) === 'never') noteUnasked(id, { ...stop.detail, why: 'sandbox' }, { session })
            }
            pending.clear()
          }
          break
        }
        case 'approval/asked': {
          let policy
          try {
            const approval = ctx.get('approval')
            policy = approval.overrideOf(session) ?? approval.config?.policy ?? 'ask'
          } catch {}
          put(asks, pairKey(id, data.id), { toolName: data.toolName, callId: data.callId, policy }, 200)
          break
        }
        case 'approval/decided': {
          const key = pairKey(id, data.id)
          const ask = asks.get(key)
          asks.delete(key)
          if (!ask) break
          if (ask.callId !== undefined) put(decided, pairKey(id, ask.callId), { outcome: data.outcome, policy: ask.policy }, 200)
          const why = data.outcome === 'unavailable' ? 'unavailable' : data.outcome === 'rejected' && ask.policy === 'never' ? 'never' : undefined
          if (why) noteStop(id, { why, tool: ask.toolName, callId: ask.callId }, { session })
          if (why) noteUnasked(id, { tool: ask.toolName, why, callId: ask.callId }, { session })
          break
        }
        case 'tool/result':
          if (data.error?.name === 'ApprovalDeniedError' && data.error.code === 'UNAVAILABLE' && !decided.has(pairKey(id, data.message?.toolCallId))) {
            noteStop(id, { why: 'unavailable', callId: data.message?.toolCallId }, { session })
            noteUnasked(id, { why: 'unavailable', callId: data.message?.toolCallId }, { session })
          }
          break
        case 'user/message':
          // A group stop closes when the person writes in that group; any other stop closes in its own Session or its Bot's chat, since a finished task or automation run never gets the person's message.
          if (data.source?.kind === 'user') {
            for (const { entry } of entries.values()) {
              if (entry.open && (entry.roomId === id || entry.taskId === id || (entry.roomId === undefined && entry.botId === rt.chatOwners?.get(id)))) entry.open = false
            }
          }
          break
      }
    } catch {}
  })
  ctx.on('tools/result', (exec, result) => {
    try {
      const sessionId = exec.agent?.id ?? exec.agent?.session?.id
      const operation = operationOf(exec)
      if (exec.arguments?.sandbox_permissions !== undefined && decided.has(pairKey(sessionId, exec.callId))) sessions.get(sessionId)?.pending.delete(operation)
      const info = result.error?.info
      if (result.isError && ['AUTO_REVIEW_DENIED', 'AUTO_REVIEW_FAILED'].includes(info?.code)) {
        noteStop(sessionId, { why: 'review', tool: exec.name, callId: exec.callId, text: info.reason }, exec.agent)
        if (info.code === 'AUTO_REVIEW_DENIED') noteUnasked(sessionId, { why: 'review', tool: exec.name, callId: exec.callId, reason: info.reason }, exec.agent)
      } else if ((result.isError && info?.code === 'FS_SANDBOX_DENIED') || (!result.isError && result.value?.sandbox?.denied === true)) {
        const stop = resolved(sessionId, { why: 'sandbox', tool: exec.name, callId: exec.callId }, exec.agent)
        if (stop) put(stateOf(sessionId).pending, operation, stop, 200)
      }
    } catch {}
  })
  const decidedOf = (sessionId, callId) => {
    const record = decided.get(pairKey(sessionId, callId))
    return record === undefined ? undefined : { ...record }
  }
  const takeUnasked = sessionId => {
    const record = unasked.get(sessionId)
    if (record === undefined) return undefined
    unasked.delete(sessionId)
    return { items: record.items.map(item => ({ ...item })), more: record.more }
  }
  Object.assign(rt, { teamOwnerOf, noteStop, stopsView, stopsIn, stopLineOfTurn, decidedOf, takeUnasked })
}
