// Resume: work that DeepSeek Harness dropped when it closed or restarted (Bot turns from
// the notes below; tasks, DSH bots, automation runs and the Sessions other plugins register
// from their Sessions, healCutSessions). DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. Omni notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; what is still noted at the next start is picked up once.
//
// A turn that ends while Omni is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000
// A Session edited longer ago than this was not cut off by the last restart.
const CUT_KEPT_MS = 24 * 60 * 60 * 1000
// A Session picked up this often in a day stays stopped: a restart loop must not run it forever.
const RESUMES_MAX = 2
const EVENTS_SCANNED = 400
const TASKS_CHECKED = 12
// What a task says when a restart cut it and nothing will pick it up.
const CUT_SUMMARY = 'A restart cut this task off and it was not picked up again.'

// How DSH ends a turn a restart cut off: `interrupted` when it repairs the log of a process
// that died, `aborted`/`disposed` when it stops the turn as it shuts down. Neither means the
// work is done.
export const cutByRestart = reason => reason?.kind === 'interrupted' || (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed')

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
  // The end of a reply written while DSH shut down can be lost on the way (issue #62).
  'If you had already finished and replied, give that reply again in full: it may not have reached the chat.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], texts: [], reason: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) current.took.push(source)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') current.reason = event.data?.reason
  }
  return turns
}

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  const steerCut = turn => turn?.reason?.kind === 'aborted'
    && turn.reason.reason?.kind === 'hook'
    && turn.reason.reason?.reason === STEER_CUT
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    let found = turns[at]
    let next = at + 1
    // A steer cut lands inside a step's model call, so the cut turn's last step left
    // an interrupted draft: texts before the last step/start stay, the rest is a
    // fragment the continuation replaces.
    const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
    while (steerCut(found) && next < turns.length) {
      const follow = turns[next]
      const kept = finished(found)
      found = { ...follow, took: [...found.took, ...follow.took], texts: [...kept, ...follow.texts], stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length) }
      next += 1
    }
    return steerCut(found) ? { ...found, texts: finished(found), reason: undefined } : found
  }
  return undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued) }
  } catch {
    return { turns: {}, queued: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file)

  // Other plugins hand their plain Sessions to this one pass (rt.resumable.register) and
  // learn when it is over (rt.resumesDone), so no Session has two resumers. `sessions()`
  // names the Sessions the plugin owns when the pass runs; `onResume({ sessionId })` runs
  // right before the team posts a resume to one of them, whoever found it.
  /** @type {Map<string, {sessions:() => string[], onResume?:(info:{sessionId:string}) => void}>} */
  const resumables = new Map()
  rt.resumable = {
    register({ id, sessions, onResume } = {}) {
      if (typeof id !== 'string' || id === '' || typeof sessions !== 'function') throw new Error('ds-bot: a resumable needs an id and sessions()')
      if (resumables.has(id)) throw new Error(`ds-bot: resumable ${id} is already registered`)
      const entry = { sessions, onResume }
      resumables.set(id, entry)
      return () => { if (resumables.get(id) === entry) resumables.delete(id) }
    },
  }
  // One per start, and it never rejects: { resumed, resent } after the pass,
  // { readOnly, resumed: [], resent: [] } when this host only reads the team, and
  // { failed, resumed, resent } with what was done before the pass threw or stopped.
  let settle
  rt.resumesDone = new Promise((resolve) => { settle = resolve })
  // Every Session the pass posted a resume to, and every one it sent dropped messages again.
  const resumed = []
  const resent = new Set()
  const finish = (outcome) => {
    settle?.({ ...outcome, resumed: [...resumed], resent: [...resent] })
    settle = undefined
  }
  // Each registered Session id with the registrations that own it.
  const ownersOf = () => {
    const owners = new Map()
    for (const [id, entry] of resumables) {
      let ids
      try {
        ids = entry.sessions()
      } catch (error) {
        rt.warn('ds-bot: the Sessions of resumable %s could not be read: %s', id, error?.message ?? error)
        continue
      }
      for (const sessionId of Array.isArray(ids) ? ids : []) {
        if (typeof sessionId !== 'string' || sessionId === '') continue
        owners.set(sessionId, [...(owners.get(sessionId) ?? []), [id, entry]])
      }
    }
    return owners
  }
  // Called right before each resume post, so the owners bind the turn first; `post` is
  // that post, and the Session counts as resumed once it is sent.
  let owners = new Map()
  const resume = async (sessionId, post) => {
    for (const [id, entry] of owners.get(sessionId) ?? []) {
      try {
        entry.onResume?.({ sessionId })
      } catch (error) {
        rt.warn('ds-bot: resumable %s failed on the resume of %s: %s', id, sessionId, error?.message ?? error)
      }
    }
    await post()
    resumed.push(sessionId)
  }

  /** @type {Record<string, {botId:string, roomId?:string, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean}>} */
  let turns = {}
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns, queued })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Written in place: a rename over the file fails on Windows while anything reads
    // it, and a torn write only loses what one restart would pick up.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await mkdir(home, { recursive: true })
      await writeFile(file, snapshot, 'utf8')
    }).catch(error => rt.warn('omni-ui: noting running turns failed: %s', error))
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId) => {
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }

  const deliver = rt.deliver
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    // Noted before it is sent: a turn may take it up before the send returns. Notes
    // are kept whole; nothing waits out a delivery silently.
    queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: noted }] }
    persist()
    try {
      return await deliver(noted)
    } catch (error) {
      // A delivery that never reached the inbox stays noted: the next start sends
      // it again. One whose Bot is gone is dropped, since it can never be sent.
      if (rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while Omni runs: the user stopped the Bot, or Omni moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ message } = {}) => {
    if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId)
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only Omni restarted (the plugin reloaded) and DSH went on.
  let firstTurn = Object.keys(interrupted.turns).length > 0 ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    // DSH closes a cut-off turn as it reopens the Session; that is not the turn finishing.
    const finished = event.type === 'turn/end' && !cutByRestart(event.data?.reason)
    if ((event.type === 'turn/start' || finished) && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    // Only a Bot's chat and group Sessions are noted. An automation's run Session is
    // read back from the Session itself (healCutSessions), which posts its resume there.
    if (!rt.chatOwners.has(id) && !rt.groupOwners.has(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        // turns.js runs first and has already claimed or restored the trigger.
        const info = rt.live.get(id)?.info
        update(id, () => ({ botId, ...(owner ? { roomId: owner.roomId } : {}), since: event.time ?? Date.now(), ...(info !== undefined ? { trigger: triggerOf(info) } : {}) }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined ? record
          : { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) }))
        break
      }
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        if (cutByRestart(event.data?.reason)) break
        update(id, () => undefined)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.cutByRestart = cutByRestart
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  async function resumeTurn(sessionId, record) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const text = resumeText(record)
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id)) return
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(record.resumed ? { again: true } : {}) })
      // A turn already picked up once and cut off again stays stopped: a restart loop
      // must not run it forever.
      if (record.resumed) return
      await resume(sessionId, () => rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) }))
      return
    }
    if (record.resumed) return
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await resume(sessionId, () => rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text }))
      return
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await resume(sessionId, () => rt.deliver({ toId: bot.id, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}) }))
  }

  // Where a queued note goes now: its Session if it still is one, else the
  // current Session of its Bot, or of its group when the message went to one.
  // One no Bot owns any more (a run whose record is gone) has nowhere to go: it is dropped,
  // not sent to the Bot's chat.
  const sessionFor = (sessionId, args) => (rt.isBotSession(sessionId) ? sessionId
    : !rt.pastOwners.has(sessionId) ? undefined
      : args?.roomId === undefined ? rt.chatOf(args?.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId])

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. The notes stay queued until a turn takes the messages
  // up, so a send that fails here, or a Session that cannot be opened, leaves them
  // for the next start instead of losing them.
  async function resendQueued(sessionId, list) {
    const fresh = list.filter(item => rt.botOf(item.args?.toId) !== undefined
      && sessionFor(sessionId, item.args) !== undefined && taken?.has(item.args.exchangeId) !== true)
    if (fresh.length === 0) return
    const target = sessionFor(sessionId, fresh[0].args)
    const agent = await rt.resolveAgent(target)
    const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.source?.exchangeId))
    for (const { args } of fresh) {
      if (waiting.has(args.exchangeId)) continue
      if (taken?.has(args.exchangeId) === true) {
        forgetQueued(args.exchangeId)
        continue
      }
      // A request that waited through a restart reaches its target late: the work
      // it is for is marked, so the answer that comes back says so.
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      await deliver({ ...args, sessionId: sessionFor(sessionId, args), steer: false, resent: true })
        .catch(error => rt.warn('omni-ui: sending again what %s was sent failed: %s', sessionId, error))
      resent.add(sessionFor(sessionId, args))
    }
  }

  // Tasks, DSH bot Sessions, the single-run Sessions of automations and the Sessions other
  // plugins register are not noted like Bot turns: a restart's cut is read from the Session
  // itself. Its last turn ended as DSH ends a cut turn and nothing ran since, so it goes on,
  // with DSH's own repair telling the model which tool calls have unknown outcomes. `skip`:
  // Sessions already picked up from the notes.
  function lastTurnOf(agent) {
    const latest = (agent.session?.seq ?? 0) - 1
    for (let seq = latest; seq >= Math.max(0, latest - EVENTS_SCANNED); seq -= 1) {
      const event = agent.session.eventAt?.(seq)
      if (event?.type === 'turn/end' || event?.type === 'turn/start') return event
    }
    return undefined
  }
  async function healCutSessions(skip) {
    const { state } = rt
    const candidates = new Map()
    // The newest Sessions of each DSH bot and of the tasks only: an old one was not running
    // when DSH went down.
    for (const agent of Object.values(state.agents ?? {})) for (const id of (agent.sessions ?? []).slice(-TASKS_CHECKED)) candidates.set(id, { kind: 'tasks' })
    for (const run of state.subscriptionRuns ?? []) if (run.task && run.sessionId && run.status === 'working') candidates.set(run.sessionId, { kind: run.botId ? 'run' : 'tasks', botId: run.botId })
    // A registered Session the team finds on its own keeps the team's way of resuming it.
    for (const id of owners.keys()) if (!candidates.has(id)) candidates.set(id, { kind: rt.agentOf?.(id) ? 'tasks' : 'plain' })
    const resumes = state.restartResumes ??= {}
    for (const [id, entry] of Object.entries(resumes)) if (Date.now() - entry.at > CUT_KEPT_MS) delete resumes[id]
    for (const [id, target] of candidates) {
      if (skip.has(id) || (resumes[id]?.count ?? 0) >= RESUMES_MAX) continue
      const agent = await rt.resolveAgent(id).catch(() => undefined)
      if (agent === undefined || agent.status === 'running') continue
      const last = lastTurnOf(agent)
      if (last?.type !== 'turn/end' || !cutByRestart(last.data?.reason) || Date.now() - (last.time ?? 0) > CUT_KEPT_MS) continue
      resumes[id] = { count: (resumes[id]?.count ?? 0) + 1, at: Date.now() }
      await rt.save()
      const text = resumeText({})
      if (target.kind === 'run' && rt.botOf(target.botId) !== undefined) {
        await resume(id, () => rt.deliver({ toId: target.botId, sessionId: id, role: 'resume', resumed: true, text }))
      } else {
        // A plain DSH Session: the note arrives as the user's, marked as the resume.
        await resume(id, () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: `[DeepSeek Harness restarted]\n${text}` }], source: { kind: 'user', resumed: true } }))
          return ctx.sessions.flush(agent.session)
        })
      }
      rt.warn('ds-bot: %s %s was cut off by a restart and goes on', target.kind === 'run' ? 'automation run' : target.kind === 'plain' ? 'Session' : 'task', id)
    }
    // A cut task this pass did not set going stays cut: past TASKS_CHECKED, RESUMES_MAX or
    // CUT_KEPT_MS nothing runs it again and no turn/end will come, so it would read Working
    // for ever (#164). It ends as stopped, from when it was cut. Its Bot is not woken for
    // it: at a start that could be many old tasks at once.
    for (const [id, task] of Object.entries(state.tasks ?? {})) {
      if (task.status !== 'working' || resumed.includes(id)) continue
      const agent = await rt.resolveAgent(id).catch(() => undefined)
      // Opening a Session takes time: the task may have really ended meanwhile.
      if (agent === undefined || agent.status === 'running' || task.status !== 'working') continue
      const last = lastTurnOf(agent)
      if (last?.type !== 'turn/end' || !cutByRestart(last.data?.reason)) continue
      Object.assign(task, { status: 'stopped', endedAt: last.time ?? Date.now(), summary: CUT_SUMMARY })
      await rt.save()
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Undefined when this DSH cannot read it, or when the Session is gone.
  async function logOf(sessionId) {
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect !== 'function') return undefined
    const seen = await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
    return Array.isArray(seen?.events) ? seen.events : undefined
  }

  // A turn that ended while Omni was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record) {
    const trigger = record.trigger
    if (trigger === undefined) return
    const workId = rt.workOf(trigger)
    if (!rt.ownsWork(record.botId, workId)) return
    const exchangeId = trigger.exchangeId
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    if (exchangeId === undefined || sender === undefined || rt.botOf(sender) === undefined) return
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    const events = await logOf(sessionId)
    if (events === undefined) {
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      answerSender(rt, sessionId, asker, text)
      return
    }
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) return
    const said = turn.texts.join('\n\n')
    // The answer went up in another run: the work closes with what it said, and
    // nothing is sent twice.
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    const sent = await logOf(back ?? rt.chatOf(sender))
    if (sent !== undefined && answeredIn(sent, workId)) {
      rt.closeWork?.(workId, name, rt.answerText(workId, said, name))
      return
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return
    // The turn was cut off before it finished: the work is picked up again, as after
    // a restart that cut it off.
    if (reason === undefined || reason.kind === 'interrupted') {
      await resumeTurn(sessionId, record)
      return
    }
    if (reason.kind === 'error') {
      const failure = turnFailure(reason.error)
      answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
      return
    }
    if (reason.kind === 'aborted') {
      // The turn was stopped before it could answer: the sender is told, as it is told
      // when Omni watches the turn end.
      answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`)
      return
    }
    // A turn cut off at the output limit is not a finish: the answer says so, and the
    // diagnostics record it, with the route the Session's log holds for it.
    const cutOff = reason?.kind === 'max-tokens'
    const withoutText = cutOff && turn.texts.length === 0
    if (cutOff) {
      rt.noteCutOffTurn?.(sessionId, { withoutText })
      const context = events.findLast(event => event?.type === 'request/context')?.data
      const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        code: 'MAX_TOKENS',
        text: `${withoutText
          ? 'the turn was cut off at the output limit before it wrote anything'
          : 'the turn was cut off at the output limit, so its answer is not complete'}${ref ? ` (${ref})` : ''}`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
    }
    const answer = cutOff ? cutOffText(said) : said
    // The turn ended with what it said: the answer goes up the way a finished turn's
    // does, with the results that came back for it and the text it held. A work that
    // still waits for what it handed on keeps its part until that comes back.
    if (rt.waitsWork(workId)) {
      rt.holdWork(workId, answer)
      return
    }
    const text = rt.answerText(workId, answer, name)
    const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
    answerSender(rt, sessionId, asker, text, long)
  }

  async function resumeAll() {
    await rt.load()
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) {
      finish({ readOnly })
      return
    }
    const { turns: noted, queued: dropped } = interrupted
    interrupted = { turns: {}, queued: {} }
    // What the last run still had on the way is noted again first, under the
    // Session it would go to now: nothing is cleared before it is handed over.
    // A Bot that is gone takes its notes with it; what a turn already read here
    // is done with.
    const pending = queued
    queued = {}
    for (const [oldId, list] of Object.entries(pending)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item?.args?.exchangeId === undefined || taken?.has(item.args.exchangeId) === true || rt.botOf(item.args.toId) === undefined) continue
        const key = sessionFor(oldId, item.args) ?? oldId
        queued = { ...queued, [key]: [...(queued[key] ?? []), item] }
      }
    }
    persist()
    // Read once, before any resume, so every post can tell its owners.
    owners = ownersOf()
    // Agents and inboxes are read before anything wakes their Sessions.
    const cut = []
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn.get(sessionId)
      if (first?.type === 'turn/end') {
        // The turn ended while Omni was not watching it: what it did is settled from
        // the Session's durable log.
        await reconcileEnded(sessionId, record).catch(error => rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error))
        continue
      }
      // Still running: noted again, as if it had started here.
      if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') update(sessionId, () => record)
      else cut.push([sessionId, record])
    }
    firstTurn = undefined
    for (const [sessionId, list] of Object.entries(dropped)) {
      if (!Array.isArray(list)) continue
      await resendQueued(sessionId, list).catch(error => rt.warn('omni-ui: sending again what %s was sent failed: %s', sessionId, error))
    }
    taken = undefined
    for (const [sessionId, record] of cut) {
      await resumeTurn(sessionId, record).catch(error => rt.warn('omni-ui: picking up the turn of %s failed: %s', sessionId, error))
    }
    // What a group's members were asked for and will not pick up is settled now.
    await rt.settleRoomBatches?.()
    await healCutSessions(new Set(Object.keys(noted)))
    finish({})
  }

  ctx.effect(() => {
    // Every start looks: the Sessions a restart cut need no notes to be found.
    const timer = setTimeout(() => void resumeAll().catch((error) => {
      rt.warn('ds-bot: picking up interrupted work failed: %s', error)
      finish({ failed: error?.message ?? String(error) })
    }), RESUME_DELAY_MS)
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      finish({ failed: 'DS Bot stopped before the restart pass ended' })
      return writing
    }
  }, 'omni-ui: resume interrupted turns')
}
