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
import { readFileSync, renameSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_INTERRUPTED, HISTORY_PAGE, HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT, cutByUpdate, switchCutBy } from './constants.js'
import { syncDirectory, syncFile } from './files.js'
import { answerSender, cutOffText, failureLine, handBackRequests, turnFailure } from './turns.js'
import { textOf } from './text.js'
import { startUpdateRecovery } from './self-update-recovery.js'

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
// work is done. An ACP agent whose process took the host's SIGTERM before DSH stopped the turn
// reports `AGENT_INTERRUPTED` instead (acp-dsh): it was cut the same way.
// The web self-update stops running turns at the click with UPDATE_CUT (update-hold.js): the same cut, picked up
// after the supervisor's verdict.
export const cutByRestart = reason => reason?.kind === 'interrupted'
  || (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed')
  || (reason?.kind === 'error' && reason.error?.code === AGENT_INTERRUPTED)
  || cutByUpdate(reason)

export const resumeText = record => [
  record.stoppedBy === 'update'
    ? 'An Automagik update stopped your last turn before it finished; the update is done now.'
    : 'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
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
  // A message that owes no reply still owes none once the turn is picked up.
  ...(info.noReply === true ? { noReply: true } : {}),
  // The requests a handed-back turn answers with its trigger: the batch message is
  // taken up by then, so this note is the only place they are kept.
  ...(Array.isArray(info.joined) && info.joined.length > 0 ? { joined: info.joined } : {}),
})
const recordTrigger = info => info === undefined ? {} : {
  trigger: triggerOf(info),
  ...(info.resumedByUpdate === true ? { resumedByUpdate: true } : info.resumed ? { resumed: true } : {}),
}

function mergeHeld(before, after) {
  const items = new Map()
  for (const item of [...before, ...after]) {
    const id = item?.message?.id
    if (typeof id === 'string' && !items.has(id)) items.set(id, item)
  }
  return [...items.values()]
}

export const readNotes = (file, { strict = false, onRead } = {}) => {
  try {
    const bytes = readFileSync(file, 'utf8')
    onRead?.(bytes)
    const parsed = JSON.parse(bytes)
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const readable = object(parsed?.turns) && object(parsed?.queued) && Object.values(parsed.queued).every(Array.isArray)
      && (parsed.held === undefined || (object(parsed.held) && Object.values(parsed.held).every(Array.isArray)))
      && (parsed.cut === undefined || Array.isArray(parsed.cut))
    if (strict && !readable) throw new Error('Invalid inflight notes')
    return {
      readable,
      turns: object(parsed?.turns) ? parsed.turns : {},
      queued: object(parsed?.queued) ? parsed.queued : {},
      held: object(parsed?.held) ? Object.fromEntries(Object.entries(parsed.held)
        .filter(([, items]) => Array.isArray(items))) : {},
      cut: Array.isArray(parsed?.cut) ? parsed.cut.filter(id => typeof id === 'string' && id !== '') : [],
    }
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error
    if (error?.code === 'ENOENT') onRead?.(undefined)
    return { readable: false, turns: {}, queued: {}, held: {}, cut: [] }
  }
}

// Read a stable log cut without opening an Agent or waking its Session.
export async function* historyBack(controller, sessionId, signal) {
  const read = typeof controller?.events === 'function' ? controller.events : controller?.page
  if (typeof read !== 'function') throw Object.assign(new Error('no history reader'), { code: 'wake/unreadable' })
  let throughSeq, beforeSeq
  for (;;) {
    signal.throwIfAborted()
    const page = await read.call(controller, {
      address: { kind: 'session', sessionId },
      ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: HISTORY_PAGE,
    }, signal)
    const events = page.records.map(record => record.event)
    if (throughSeq === undefined && events.length > 0) throughSeq = events.at(-1).seq
    for (let i = events.length - 1; i >= 0; i -= 1) yield events[i]
    if (!page.hasMore || events.length === 0) return
    if (beforeSeq !== undefined && events[0].seq >= beforeSeq) throw new Error('history did not advance')
    beforeSeq = events[0].seq
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')
  const expectedUpdateRun = process.env.AUTOMAGIK_SUPERVISOR_RUN

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
  let destinationPlan = Promise.withResolvers()
  rt.resumeDestinationsPlanned = destinationPlan.promise
  const destinationWork = new Map()
  rt.resumeDestination = async (sessionId) => {
    await destinationPlan.promise
    await destinationWork.get(sessionId)
  }
  let settle
  let resumingAdopted = false
  rt.resumesDone = new Promise((resolve) => { settle = resolve })
  // Every Session the pass posted a resume to, and every one it sent dropped messages again.
  const resumed = []
  const resent = new Set()
  const finish = (outcome) => {
    destinationPlan.resolve()
    resumingAdopted = false
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
  let pendingTurns = {}
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  // Input a step had already taken from its inbox when the web self-update held it (self-update-hold.js), by
  // Session: DSH's shutdown would drop it, so it is noted until its user/message is written.
  /** @type {Record<string, {at:number, message:any}[]>} */
  let held = interrupted.held
  rt.hasHeldInput = botId => Object.entries(held).some(([sessionId, list]) => list.length > 0 && rt.selfOf(sessionId) === botId)
  // A claim can precede both admission and the click while DSH assembles the step.
  const claims = new Map()
  const localHeld = new Map()
  const heldReceipts = new Set()
  let heldWriteWarned = false
  // Sticky records share the on-disk turns map and take precedence until their deliveries go out.
  const updateTurns = new Map()
  const handingBack = new Map()
  const cutClaims = new Map()
  const cutClaimEnds = new Map()
  const recoveryReports = new Set()
  // The Sessions that are not a Bot's chat or group (tasks, DSH bots, automation runs, registered Sessions) the
  // update cut at the click: healed by id, past the newest-Sessions window and the daily limit.
  /** @type {string[]} */
  let cut = interrupted.cut
  // A turn that starts while the update holds new work waits at its first step: it is noted once it takes one.
  const heldStarts = new Map()
  // Until the start's pass takes them, what the last run left stays in the notes: a boot the update holds
  // (its trial) can note new turns before the pass runs, and must not drop the ones it has to pick up.
  let passTook = false
  let bootDeferred = false
  const controller = new AbortController()
  rt.resumeBootPending = () => !passTook || settle !== undefined || resumingAdopted
  let writing = Promise.resolve()
  rt.holdLockUntil?.(() => writing)
  let stopped = false
  const encodeNotes = ({ turns, queued, held, cut }) => JSON.stringify({ turns, queued, held, cut })
  let latest = encodeNotes(interrupted)
  let flushLatest = false
  let flushPending = false
  let unconfirmedNotes
  let due = false
  let reloading
  let noteTerm
  let needsAdoption = false
  const localNotes = new Map()
  const localTurns = new Map()
  const notesFenced = () => needsAdoption || rt.readOnly() !== undefined || (noteTerm !== undefined && noteTerm !== rt.lockTerm())
  const persist = (durable = rt.updateHoldView?.() === true) => {
    // Only the host that saves the team runs its work again.
    if (stopped || notesFenced()) return Promise.resolve(false)
    const term = rt.lockTerm()
    noteTerm ??= term
    const notedTurns = passTook ? { ...pendingTurns, ...turns } : { ...turns, ...interrupted.turns }
    const snapshot = encodeNotes({
      turns: { ...notedTurns, ...Object.fromEntries(updateTurns) },
      queued, held, cut,
    })
    flushLatest ||= durable || snapshot !== latest
    latest = snapshot
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return writing
    due = true
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      const changes = new Map(localHeld)
      const requested = flushLatest
      flushLatest = false
      // Noted before the stop: it still lands, since the store keeps the lock until this write ends.
      const current = () => !notesFenced() && rt.lockTerm() === term
        && (term === 0 || (rt.ownsLockForPendingWrite?.() ?? rt.holdsLock()))
      if (!current()) return false
      flushPending ||= requested
      const flush = flushPending || unconfirmedNotes !== undefined
      await mkdir(home, { recursive: true })
      if (!current()) return false
      // Windows can refuse to replace the file while another process has it open for reading.
      if (process.platform === 'win32') {
        try {
          await writeFile(file, snapshot, { encoding: 'utf8', flush })
        } catch (error) {
          // A failed open leaves the previous checkpoint intact. A later failure can leave these bytes on disk.
          if (flush && error?.syscall !== 'open') unconfirmedNotes = snapshot
          throw error
        }
        unconfirmedNotes = undefined
      } else {
        const temp = join(home, `.inflight-${randomUUID()}.tmp`)
        let renamed = false
        try {
          await writeFile(temp, snapshot, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          if (flush) await syncFile(temp)
          if (!current()) return false
          renameSync(temp, file)
          renamed = true
          if (flush) {
            flushPending = false
            unconfirmedNotes = snapshot
            await syncDirectory(home)
            unconfirmedNotes = undefined
          }
        } finally {
          if (!renamed) await rm(temp, { force: true }).catch(() => {})
        }
      }
      if (!current()) return false
      flushPending = false
      for (const [id, change] of changes) if (localHeld.get(id) === change) localHeld.delete(id)
      return true
    }).catch(error => {
      rt.warn('omni-ui: noting running turns failed: %s', error)
      return false
    })
    return writing
  }
  let publishedRequest
  rt.flushUpdateNotes = async (publish) => {
    let pending = persist(true)
    while (await pending) {
      // Input can reach the inbox during a write. Publish in the same tick that the latest write is confirmed.
      if (pending === writing) {
        const result = publish === undefined ? true : publish()
        if (result?.started === true) publishedRequest = result.requestId
        return result
      }
      pending = writing
    }
    return false
  }
  rt.reloadDeliveryNotes = (onAdopted) => {
    const term = rt.lockTerm()
    needsAdoption = true
    // Wait out any write already issued. Queued snapshots see the adoption fence and skip.
    const reload = writing.then(() => {
      if (stopped || !rt.holdsLock() || rt.lockTerm() !== term) return
      interrupted = readNotes(file, { strict: true, onRead: bytes => {
        if (unconfirmedNotes !== bytes) unconfirmedNotes = undefined
      } })
      // A queued or pre-rename flush belongs to the previous owner. Only the
      // published checkpoint can carry unconfirmed durability through adoption.
      flushLatest = flushPending = false
      latest = encodeNotes(interrupted)
      pendingTurns = {}
      // Startup can still replay the disk snapshot. Local deliveries already have a sender.
      // Held input from a prior owner is authoritative on disk; only apply edits made here.
      queued = { ...interrupted.queued }
      turns = { ...interrupted.turns }
      held = { ...interrupted.held }
      for (const [messageId, { sessionId, item }] of localHeld) {
        if (item === undefined) removeHeld(sessionId, messageId)
        else held[sessionId] = mergeHeld(held[sessionId] ?? [], [item])
      }
      cut = [...new Set([...interrupted.cut, ...cut])]
      for (const [id, record] of localTurns) {
        delete interrupted.turns[id]
        if (record === undefined) delete turns[id]
        else turns[id] = record
      }
      const adopted = new Set(Object.values(queued).flatMap(list => list.map(item => item?.args?.exchangeId)))
      let merged = localTurns.size > 0
      for (const [id, { sessionId, item }] of localNotes) {
        if (adopted.has(id)) continue
        queued[sessionId] = [...queued[sessionId] ?? [], item]
        merged = true
      }
      localNotes.clear()
      localTurns.clear()
      noteTerm = term
      needsAdoption = false
      if (merged || localHeld.size > 0 || cut.length > 0) persist()
      onAdopted(interrupted)
      if (bootDeferred) {
        bootDeferred = false
        resumingAdopted = true
        destinationPlan = Promise.withResolvers()
        rt.resumeDestinationsPlanned = destinationPlan.promise
        void resumeAll(controller.signal, true).catch(bootFailed)
      }
      return interrupted
    }).catch(error => {
      rt.warn('omni-ui: adopting inflight notes failed: %s', error)
    }).finally(() => {
      if (reloading === reload) reloading = undefined
    })
    reloading = reload
    return reload
  }

  // One strict read per delivery while adoption is fenced. Deliveries arriving
  // together share the read and can still go through if it fails.
  const adoptIfNeeded = () => reloading ?? (needsAdoption && rt.holdsLock() ? rt.wakeLog.retryTakeover() : undefined)

  const update = (id, change, ended = false) => {
    const current = turns[id]
    const next = change(current)
    if ((next !== current || ended) && notesFenced()) localTurns.set(id, next)
    if (next === current) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId) => {
    localNotes.delete(exchangeId)
    let next = queued
    for (const [sessionId, list] of Object.entries(queued)) {
      if (!Array.isArray(list)) continue
      const rest = list.filter(item => item?.args?.exchangeId !== exchangeId)
      if (rest.length === list.length) continue
      if (next === queued) next = { ...queued }
      if (rest.length === 0) delete next[sessionId]
      else next[sessionId] = rest
    }
    if (next === queued) return
    queued = next
    persist()
  }

  const removeHeld = (sessionId, messageId) => {
    const list = held[sessionId]
    const rest = list?.filter(item => item?.message?.id !== messageId)
    if (rest === undefined || rest.length === list.length) return false
    held = { ...held }
    if (rest.length === 0) delete held[sessionId]
    else held[sessionId] = rest
    return true
  }
  rt.forgetHeldInput = (sessionId, messageId) => {
    if (typeof messageId !== 'string') return
    claims.get(sessionId)?.delete(messageId)
    heldReceipts.delete(messageId)
    // The message may have gone to a replacement Session. Its ID still acknowledges the old note.
    const notedAt = held[sessionId]?.some(item => item?.message?.id === messageId) ? sessionId
      : Object.keys(held).find(id => held[id].some(item => item?.message?.id === messageId)) ?? sessionId
    const removed = removeHeld(notedAt, messageId)
    if (!removed && !notesFenced()) return
    localHeld.set(messageId, { sessionId: notedAt })
    persist()
  }

  async function acknowledgeHeld(session, messageId) {
    // Let the other session/event listeners buffer this receipt before asking for its flush.
    await null
    try {
      if (await ctx.sessions.flush(session) === true && !stopped) rt.forgetHeldInput(session.id, messageId)
    } catch (error) {
      rt.warn('omni-ui: flushing held input for %s failed: %s', session.id, error)
    }
  }

  const noteDelivery = (sessionId, args) => {
    const list = queued[sessionId] ?? []
    if (list.some(item => item.args.exchangeId === args.exchangeId)) return
    // Note it before sending: a turn may take it up before the send returns.
    const item = { at: Date.now(), args }
    if (notesFenced()) {
      localNotes.set(args.exchangeId, { sessionId, item })
    }
    queued = { ...queued, [sessionId]: [...list, item] }
    persist()
  }
  const deliver = rt.deliver
  rt.deliver = async (args, options) => {
    const adoption = adoptIfNeeded()
    if (adoption !== undefined) await adoption
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    noteDelivery(sessionId, noted)
    try {
      return await deliver(noted, options)
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
  rt.deliveryNote = (id) => {
    let marked
    for (const [sessionId, list] of Object.entries(queued)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const args = item?.args
        if (args?.exchangeId !== id) continue
        if (args.wake !== true) return { marked: false, sessionId }
        marked ??= { marked: true, sessionId }
      }
    }
    return marked
  }

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while Omni runs: the user stopped the Bot, or Omni moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
    if (stopped || rt.updateShuttingDown?.()) return
    rt.forgetHeldInput(agent?.session?.id ?? agent?.id, message?.id)
    if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId)
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only Omni restarted (the plugin reloaded) and DSH went on.
  let firstTurn = Object.keys(interrupted.turns).length > 0
    || Object.values(interrupted.queued).some(list => Array.isArray(list) && list.some(item => item?.args?.resumed === true))
    ? new Map() : undefined
  let startedTurns = firstTurn === undefined ? undefined : new Set()
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    // DSH closes a cut-off turn as it reopens the Session; that is not the turn finishing.
    const finished = event.type === 'turn/end' && !cutByRestart(event.data?.reason)
    if (event.type === 'user/message' && event.data?.source?.resumed !== true) startedTurns?.add(id)
    if ((event.type === 'turn/start' || finished) && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      taken?.add(event.data.source.exchangeId)
      for (const report of recoveryReports) report.resumed('delivery', event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    if (event.type === 'user/message' && typeof event.data?.id === 'string') {
      const messageId = event.data.id
      claims.get(id)?.delete(messageId)
      for (const report of recoveryReports) report.resumed('input', messageId)
      if (notesFenced() || Object.values(held).some(list => list.some(item => item?.message?.id === messageId))) {
        heldReceipts.add(messageId)
        void acknowledgeHeld(session, messageId)
      }
    }
    if (event.type === 'turn/end') {
      if (cutClaimEnds.has(id)) {
        for (const message of claims.get(id)?.values() ?? []) {
          if (message.source?.kind === SOURCE_KIND) rt.wakeLog?.retireClaim(id, message)
        }
      }
      claims.delete(id)
      cutClaimEnds.get(id)?.resolve()
      cutClaimEnds.delete(id)
      rt.updateTurnEnded?.(id)
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
        const record = { botId, ...(owner ? { roomId: owner.roomId } : {}), since: event.time ?? Date.now(), ...recordTrigger(info) }
        // While the web self-update holds new work, a turn waits at its first step and took nothing yet: a shutdown
        // then cuts nothing worth resuming (its input stays noted in `queued` or `held`).
        if (rt.updateHoldView?.() === true) {
          heldStarts.set(id, record)
          break
        }
        heldStarts.delete(id)
        // A turn the update cut keeps its note until a pass picks it up; a turn that starts meanwhile is not it.
        update(id, () => record)
        break
      }
      case 'step/start': {
        const record = heldStarts.get(id)
        if (record === undefined) break
        heldStarts.delete(id)
        const info = rt.live.get(id)?.info
        const noted = record.trigger === undefined ? { ...record, ...recordTrigger(info) } : record
        update(id, () => noted)
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined
          ? record : { ...record, ...recordTrigger(info) }))
        break
      }
      case 'turn/end': {
        heldStarts.delete(id)
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        if (cutByRestart(event.data?.reason)) break
        update(id, () => undefined, true)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.cutByRestart = cutByRestart
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  // The web self-update's click (self-update-hold.js): every turn running now is about to be cut. Its note says so,
  // so the screens and the pass treat it as stopped by an update, and it is durable before the update is asked for.
  // Synchronous, so the caller cuts in the same tick: no turn ends normally between the mark and its cut.
  rt.markUpdateStop = (cutSessions = []) => {
    for (const id of cutSessions) {
      const claimed = claims.get(id)
      if (claimed?.size > 0 && !cutClaimEnds.has(id)) cutClaimEnds.set(id, Promise.withResolvers())
      for (const message of claimed?.values() ?? []) {
        if (message.source?.kind !== SOURCE_KIND || !message.source.exchangeId) continue
        if (!cutClaims.has(id)) cutClaims.set(id, new Set())
        cutClaims.get(id).add(message.source.exchangeId)
      }
      const record = turns[id]
      if (record === undefined) {
        if (typeof id === 'string' && !cut.includes(id) && !updateTurns.has(id)) cut = [...cut, id]
        continue
      }
      const { info, joined = [], later = [] } = rt.turnCutSnapshot?.(id) ?? {}
      const trigger = info === undefined ? record.trigger : triggerOf(info)
      const requests = new Map([...(record.trigger?.joined ?? []), ...(trigger?.joined ?? []), ...joined]
        .map(item => [item.info.exchangeId, item]))
      updateTurns.set(id, updateTurns.get(id) ?? {
        ...record,
        stoppedBy: 'update',
        trigger: requests.size > 0 ? { ...trigger, joined: [...requests.values()] } : trigger,
        ...(later.length > 0 ? { later } : {}),
      })
      update(id, () => undefined)
    }
    return persist(true)
  }
  // Whether the update may cut a Session's running turn: only work the team picks up again after it.
  rt.updateHealable = (id) => {
    if (typeof id !== 'string') return false
    if (rt.chatOwners.has(id) || rt.groupOwners.has(id)) return true
    const { state } = rt
    if (state?.tasks?.[id] !== undefined) return true
    if (Object.values(state?.agents ?? {}).some(agent => (agent.sessions ?? []).includes(id))) return true
    if ((state?.subscriptionRuns ?? []).some(run => run.task && run.sessionId === id && run.status === 'working')) return true
    return ownersOf().has(id)
  }
  // Turn end and recovery can race to hand the same result back. Keep one send in flight
  // and record the exchange IDs it queued before letting either caller try again.
  async function handBack(id, record, args, ownsTeam) {
    const ids = [args.exchangeId, ...(args.joined ?? []).map(item => item.info.exchangeId)]
    const current = updateTurns.get(id)
    if (current?.since !== record.since || ids.every(exchangeId => current.handedBack?.includes(exchangeId))) return true
    const key = args.exchangeId
    if (handingBack.has(key)) return handingBack.get(key)
    const pending = (async () => {
      try {
        const sent = await rt.deliver(args, { shouldSend: ownsTeam })
        if (sent === undefined) return false
        const current = updateTurns.get(id)
        if (ownsTeam() && current?.since === record.since) {
          updateTurns.set(id, { ...current, handedBack: [...new Set([...(current.handedBack ?? []), ...ids])] })
          persist(true)
        }
        return true
      } catch (error) {
        rt.warn('omni-ui: deferred delivery for %s failed: %s', id, error)
        return false
      }
    })()
    handingBack.set(key, pending)
    try { return await pending } finally { handingBack.delete(key) }
  }

  async function handBackResults(id, record, ownsTeam) {
    const sent = await Promise.all((record.later ?? []).map(({ info, text }) => {
      if (!ownsTeam()) return false
      return handBack(id, record, {
        fromId: info.senderSessionId, toId: record.botId, text, role: info.role, exchangeId: info.exchangeId,
        replyTo: info.replyTo, work: info.work, ...(info.roomId ? { roomId: info.roomId } : {}),
        deferred: true,
      }, ownsTeam)
    }))
    return sent.every(Boolean)
  }
  rt.handBackUpdateResults = id => {
    const record = updateTurns.get(id)
    if (record === undefined) return
    const generation = rt.teamGeneration?.()
    void handBackResults(id, record, () => !stopped && !notesFenced() && (rt.sameTeam?.(generation) ?? rt.holdsLock()))
  }
  // A team delivery is already recoverable when its exchange is in the queue.
  rt.noteHeldInput = async (sessionId, messages) => {
    const fresh = messages.filter(message => typeof message?.id === 'string'
      && !(message.source?.kind === SOURCE_KIND && rt.deliveryNote(message.source.exchangeId) !== undefined))
    if (typeof sessionId !== 'string') return false
    if (fresh.length > 0) {
      const at = Date.now()
      const items = fresh.map(message => ({ at, message }))
      for (const item of items) localHeld.set(item.message.id, { sessionId, item })
      held = { ...held, [sessionId]: mergeHeld(held[sessionId] ?? [], items) }
    }
    const saved = await persist(true)
    if (!saved && fresh.length > 0 && !heldWriteWarned) {
      heldWriteWarned = true
      rt.warn('omni-ui: input held during the web self-update could not be saved')
    }
    return saved
  }
  const trackable = (agent, message) => agent && agent.session?.header?.origin !== 'subagent'
    && typeof message?.id === 'string' && !rt.isLoginCodeInput?.(agent.id, message)
  rt.noteUpdateInbox = ({ agent, message } = {}, claimed = false) => {
    if (!trackable(agent, message)) return
    const id = agent.session?.id ?? agent.id
    if (claimed) {
      if (!claims.has(id)) claims.set(id, new Map())
      claims.get(id).set(message.id, message)
    }
    if (rt.updateHoldView?.() === true) void rt.noteHeldInput(id, [message])
  }
  rt.noteUpdateInboxes = agents => Promise.all(agents.map(agent => {
    const id = agent.session?.id ?? agent.id
    const messages = [...(claims.get(id)?.values() ?? []), ...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
      .filter(message => trackable(agent, message))
    return messages.length === 0 || rt.noteHeldInput(id, messages)
  })).then(results => results.every(result => result === true))

  // A batch names every sender it answers, as the handed-back turn did.
  const joinedFrom = (trigger) => {
    const names = [...new Set([rt.botOf(trigger.senderSessionId)?.name, ...trigger.joined.map(item => item?.info?.senderName)]
      .filter(name => typeof name === 'string' && name !== ''))]
    return names.length > 0 ? { fromName: names.join(', ') } : {}
  }

  async function resumeDelivery(sessionId, record, ownsTeam) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined || rt.shellHoldOf?.(bot.id) !== undefined) return undefined
    const text = resumeText(record)
    const exchangeId = `resume:${sessionId}:${record.since}`
    const updated = record.stoppedBy === 'update'
    const continuation = { resumed: true, ...(updated ? { resumedByUpdate: true } : {}) }
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id) || !ownsTeam()) return undefined
      await rt.postToRoom(room, bot, '', { ...continuation, quiet: true, ...(record.resumed && !updated ? { again: true } : {}) }, [], ownsTeam)
      // A second interruption in the same turn stays stopped; an update's stop is not one.
      if (record.resumed && record.stoppedBy !== 'update') return undefined
      return { toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id,
        note: updated ? 'picking up after an update' : 'picking up after a restart', ...continuation, text, exchangeId,
        ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) }
    }
    if (record.resumed && record.stoppedBy !== 'update') return undefined
    const target = rt.chatOf(bot.id)
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // Preserve the original exchange for a sender still waiting for the answer.
      return { fromId: trigger.senderSessionId, toId: bot.id, sessionId: target, role: trigger.role,
        exchangeId: trigger.exchangeId ?? exchangeId, ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}),
        ...(trigger.noReply === true ? { noReply: true } : {}),
        ...(Array.isArray(trigger.joined) && trigger.joined.length > 0 ? { joined: trigger.joined, ...joinedFrom(trigger) } : {}),
        ...continuation, text }
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    return { toId: bot.id, sessionId: target, role: 'resume', ...continuation, text, exchangeId, ...(trigger?.work ? { work: trigger.work } : {}) }
  }

  const sessionFor = (sessionId, args) => rt.sessionNow(sessionId, args?.toId, args?.roomId)

  const waitingFor = agent => new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
    .map(message => message.source?.exchangeId))

  // Build each message through ordinary delivery (including its ledger and capabilities)
  // before waking the destination. A distinct user/message still acknowledges each item.
  async function resendTo(target, items, ownsTeam, recovery) {
    const warn = error => rt.warn('omni-ui: sending again what %s was sent failed: %s', target, error)
    const started = (item, destination) => startedTurns?.has(item.recordId ?? item.oldId) || startedTurns?.has(destination)
    const received = item => recovery?.resumed(item.recordId === undefined ? 'delivery' : 'turn',
      item.recordId ?? item.args.exchangeId)
    const sendable = (agent, item, destination) => {
      if (!ownsTeam() || (item.recordId === undefined && sessionFor(item.oldId, item.args) !== destination)
        || (item.args.resumedByUpdate !== true && item.args.resumed && started(item, destination))) return false
      const id = item.args.exchangeId
      if (taken?.has(id) === true) {
        received(item)
        return false
      }
      if ((item.liveClaim && rt.deliveryNote(id) === undefined)
        || [...(claims.get(destination)?.values() ?? [])].some(message => message.source?.exchangeId === id)) return false
      if (waitingFor(agent).has(id)) {
        received(item)
        return false
      }
      return true
    }

    // Ordinary delivery joins #1569's reply queue when installed. Submit all replies
    // before waiting, and let the other roles use their own single wake.
    const replies = items.filter(item => item.args.role === 'reply').map(async item => {
      let deliveredTo = target
      const sent = await deliver({ ...item.args, sessionId: target, steer: false, resent: true }, {
        shouldSend(agent, destination) {
          deliveredTo = destination
          return sendable(agent, item, destination)
        },
      })
      if (sent !== undefined) {
        resent.add(deliveredTo)
        received(item)
      }
    }).map(reply => reply.catch(warn))

    const staged = items.filter(item => item.args.role !== 'reply').map(item => {
      const ready = Promise.withResolvers()
      const settled = deliver({ ...item.args, sessionId: target, steer: false, resent: item.recordId === undefined && !item.args.resumed }, {
        enqueue(agent, message) {
          const sent = Promise.withResolvers()
          ready.resolve({ item, agent, message, sent })
          return sent.promise
        },
      }).then(sent => {
        if (sent !== undefined) received(item)
        if (sent !== undefined || (item.record?.stoppedBy !== 'update' && started(item, target))) item.done?.()
        const current = updateTurns.get(item.recordId)
        if (sent === undefined || item.record?.stoppedBy !== 'update' || current?.since !== item.record.since || !ownsTeam()) return
        const joined = (item.args.joined ?? []).map(request => request.info.exchangeId)
        updateTurns.set(item.recordId, { ...current, continuationQueued: true,
          handedBack: [...new Set([...(current.handedBack ?? []), ...joined])] })
        persist(true)
      }).catch(warn).finally(() => ready.resolve())
      return { ready: ready.promise, settled }
    })
    const prepared = (await Promise.all(staged.map(stage => stage.ready))).filter(Boolean)
    const batchAgent = prepared[0]?.agent
    if (prepared.length > 1 && typeof batchAgent.inject === 'function' && batchAgent.status === 'running'
      && !prepared.some(({ item }) => item.args.resumedByUpdate === true)) {
      // A running turn could claim injections before the waking followup starts its turn.
      try { await batchAgent.whenIdle?.() } catch (error) { warn(error) }
    }
    const ids = new Set()
    const batch = prepared.filter(({ agent, item, sent }) => {
      const id = item.args.exchangeId
      if (sendable(agent, item, target) && !ids.has(id)) {
        ids.add(id)
        return true
      }
      sent.resolve(false)
      return false
    })
    if (batch.length > 0) {
      const { agent } = batch[0]
      const inject = agent.status !== 'running' && typeof agent.inject === 'function'
      const resumeItem = batch.find(({ item }) => item.args.resumed === true)
      const send = async () => {
        try {
          for (const [index, { item, message }] of batch.entries()) {
            if (!ownsTeam()) throw new Error('The team changed before the resumed turn could be sent')
            rt.assertShellChoice?.(target, item.args.toId)
            if (item.recordId !== undefined) noteDelivery(target, item.args)
            if (!item.args.resumed && (item.args.role === 'request' || item.args.role === 'stopped')) rt.lateWork?.(item.args.exchangeId)
            // DSH claims next-step injections before the waking next-turn followup.
            if (inject && index < batch.length - 1) agent.inject(message)
            else agent.followup(message)
          }
          if (await ctx.sessions.flush(agent.session) === false) throw new Error('Could not flush the resumed turn')
          if (batch.some(({ item }) => !item.args.resumed)) resent.add(target)
          for (const { sent } of batch) sent.resolve(true)
        } catch (error) {
          for (const { sent } of batch) sent.reject(error)
          throw error
        }
      }
      await (resumeItem === undefined ? send() : resume(resumeItem.item.recordId ?? target, send)).catch(warn)
    }
    await Promise.all([...staged.map(stage => stage.settled), ...replies])
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
  // `updateCut`: the Sessions the web self-update cut at its click (rt.markUpdateStop), healed by id past the
  // newest-Sessions window and the daily limit; `onlyUpdate`: the pass after an update that did not happen, which
  // picks up only those and marks no task stopped.
  async function healCutSessions(skip, { updateCut = [], onlyUpdate = false, ownsTeam = () => true, recovery } = {}) {
    const { state } = rt
    const candidates = new Map()
    const byUpdate = new Set(updateCut)
    // The newest Sessions of each DSH bot and of the tasks only: an old one was not running
    // when DSH went down.
    for (const agent of Object.values(state.agents ?? {})) for (const id of (agent.sessions ?? []).slice(-TASKS_CHECKED)) candidates.set(id, { kind: 'tasks' })
    for (const run of state.subscriptionRuns ?? []) if (run.task && run.sessionId && run.status === 'working') candidates.set(run.sessionId, { kind: run.botId ? 'run' : 'tasks', botId: run.botId })
    // A registered Session the team finds on its own keeps the team's way of resuming it.
    for (const id of owners.keys()) if (!candidates.has(id)) candidates.set(id, { kind: rt.agentOf?.(id) ? 'tasks' : 'plain' })
    for (const id of byUpdate) {
      if (candidates.has(id)) continue
      const run = (state.subscriptionRuns ?? []).find(item => item.sessionId === id)
      candidates.set(id, run?.botId ? { kind: 'run', botId: run.botId } : { kind: rt.agentOf?.(id) || state.tasks?.[id] ? 'tasks' : 'plain' })
    }
    if (onlyUpdate) for (const id of [...candidates.keys()]) if (!byUpdate.has(id)) candidates.delete(id)
    const canHeal = (id, botId = state.tasks?.[id]?.from) => {
      if (!ownsTeam() || rt.shellHoldOf?.(botId) !== undefined) return false
      try {
        rt.assertShellChoice?.(id, botId)
        return true
      } catch (error) {
        if (error?.code === 'bot/shell-off-cli') return false
        throw error
      }
    }
    const resumes = state.restartResumes ??= {}
    for (const [id, entry] of Object.entries(resumes)) if (!byUpdate.has(id) && Date.now() - entry.at > CUT_KEPT_MS) delete resumes[id]
    for (const [id, target] of candidates) {
      const botId = target.botId ?? state.tasks?.[id]?.from
      // An update's stop does not count toward the daily limit (RFC 0041, "Stopping and resuming work").
      const updated = byUpdate.has(id)
      if (skip.has(id) || (!updated && (resumes[id]?.count ?? 0) >= RESUMES_MAX) || !canHeal(id, botId)) continue
      const agent = await rt.resolveAgent(id).catch(() => undefined)
      if (agent === undefined || agent.session?.header?.origin === 'subagent' || !canHeal(id, botId)) continue
      if (agent.status === 'running') {
        if (!updated) continue
      } else {
        const last = lastTurnOf(agent)
        if (last?.type !== 'turn/end' || !cutByRestart(last.data?.reason) || (!updated && Date.now() - (last.time ?? 0) > CUT_KEPT_MS)) continue
      }
      const previous = resumes[id]
      if (!updated) {
        resumes[id] = { count: (previous?.count ?? 0) + 1, at: Date.now() }
        await rt.save()
      }
      if (!canHeal(id, botId)) {
        if (!updated) {
          if (previous === undefined) delete resumes[id]
          else resumes[id] = previous
          await rt.save()
        }
        continue
      }
      const text = resumeText(updated ? { stoppedBy: 'update' } : {})
      const continuation = { resumed: true, ...(updated ? { resumedByUpdate: true } : {}) }
      try {
        await resume(id, async () => {
          if (target.kind === 'run' && rt.botOf(target.botId) !== undefined) {
            const delivered = await rt.deliver({ toId: target.botId, sessionId: id, role: 'resume', ...continuation, text },
              { shouldSend: () => canHeal(id, botId) })
            if (updated && delivered === undefined) throw new Error('Could not deliver the resumed Session')
          } else {
            // A plain DSH Session receives the continuation as a followup, also when it is already working.
            if (!canHeal(id, botId)) throw new Error('The team changed before the resumed Session could be sent')
            agent.followup(createUserMessage({ content: [{ type: 'text', text: `${updated ? '[Automagik updated]' : '[DeepSeek Harness restarted]'}\n${text}` }],
              source: { kind: 'user', ...continuation } }))
            if (await ctx.sessions.flush(agent.session) === false) throw new Error('Could not flush the resumed Session')
          }
        })
      } catch (error) {
        if (!updated) throw error
        rt.warn('omni-ui: picking up update-cut Session %s failed: %s', id, error)
        continue
      }
      if (updated) {
        recovery?.resumed('turn', id)
        cut = cut.filter(value => value !== id)
        persist(true)
      }
      rt.warn('ds-bot: %s %s was cut off by a %s and goes on', target.kind === 'run' ? 'automation run' : target.kind === 'plain' ? 'Session' : 'task', id, updated ? 'web self-update' : 'restart')
    }
    if (onlyUpdate) return
    // A cut task this pass did not set going stays cut: past TASKS_CHECKED, RESUMES_MAX or
    // CUT_KEPT_MS nothing runs it again and no turn/end will come, so it would read Working
    // for ever (#164). It ends as stopped, from when it was cut. Its Bot is not woken for
    // it: at a start that could be many old tasks at once.
    for (const [id, task] of Object.entries(state.tasks ?? {})) {
      if (task.status !== 'working' || byUpdate.has(id) || resumed.includes(id) || !canHeal(id, task.from)) continue
      const agent = await rt.resolveAgent(id).catch(() => undefined)
      // Opening a Session takes time: the task may have really ended meanwhile.
      if (agent === undefined || agent.status === 'running' || agent.session?.header?.origin === 'subagent'
        || state.tasks[id] !== task || task.status !== 'working' || !canHeal(id, task.from)) continue
      const last = lastTurnOf(agent)
      if (last?.type !== 'turn/end' || !cutByRestart(last.data?.reason)) continue
      Object.assign(task, { status: 'stopped', endedAt: last.time ?? Date.now(), summary: CUT_SUMMARY })
      rt.endGrants?.(id, 'task')
      await rt.save()
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Undefined when this DSH cannot read it, or when the Session is gone.
  async function logOf(sessionId) {
    const controller = ctx.sessionController
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    try {
      if (typeof controller?.inspect === 'function') {
        const seen = await controller.inspect(sessionId, signal)
        return Array.isArray(seen?.events) ? seen.events : undefined
      }
      const events = []
      for await (const event of historyBack(controller, sessionId, signal)) events.push(event)
      return events.reverse()
    } catch {
      return undefined
    }
  }

  // A turn that ended while Omni was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, ownsTeam, settled) {
    const trigger = record.trigger
    if (trigger === undefined) return void settled()
    const workId = rt.workOf(trigger)
    if (!rt.ownsWork(record.botId, workId)) return void settled()
    const exchangeId = trigger.exchangeId
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    if (exchangeId === undefined || sender === undefined || rt.botOf(sender) === undefined) return void settled()
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    const events = await logOf(sessionId)
    if (!ownsTeam()) return
    if (events === undefined) {
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      await settled()
      if (!ownsTeam()) return
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
      answerSender(rt, sessionId, asker, text, undefined, ownsTeam)
      return
    }
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) return void settled()
    const said = turn.texts.join('\n\n')
    // The answer went up in another run: the work closes with what it said, and
    // nothing is sent twice.
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    const sent = await logOf(back ?? rt.chatOf(sender))
    if (!ownsTeam()) return
    if (sent !== undefined && answeredIn(sent, workId)) {
      settled()
      rt.closeWork?.(workId, name, rt.answerText(workId, said, name))
      return
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return void settled()
    // A turn cut for an agent switch goes on in the next part, or through the switch marker's
    // resume: the sender gets that turn's answer, never "was stopped before it could answer".
    if (switchCutBy(reason)) return void settled()
    // The turn was cut off before it finished: the work is picked up again, as after
    // a restart that cut it off.
    if (reason === undefined || reason.kind === 'interrupted' || cutByUpdate(reason)) {
      return resumeDelivery(sessionId, record, ownsTeam)
    }
    await settled()
    if (!ownsTeam()) return
    if (reason.kind === 'error') {
      const failure = turnFailure(reason.error)
      answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`, undefined, ownsTeam)
      return
    }
    if (reason.kind === 'aborted') {
      // The turn was stopped before it could answer: the sender is told, as it is told
      // when Omni watches the turn end.
      answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`, undefined, ownsTeam)
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
    if (ownsTeam()) answerSender(rt, sessionId, asker, text, long, ownsTeam)
  }

  // Report the same durable notes the resume pass works from, without exposing their payloads.
  function reportRecovery(run, noted, updateCut, dropped, heldBefore, ownsTeam, { liveClaims, inventoryReadable } = {}) {
    if (!run || !rt.holdsLock()) return null
    const items = []
    const add = (kind, id, sessionId, botId, roomId, title) => {
      const name = title || [botId === undefined ? null : rt.botOf(botId)?.name, roomId === undefined ? null : rt.roomOf(roomId)?.name]
        .filter(Boolean).join(' · ') || rt.state.tasks?.[sessionId]?.title
        || ctx.sessions.get?.(sessionId)?.header?.title || sessionId
      items.push({ kind, id, sessionId, name })
    }
    for (const [id, record] of Object.entries(noted)) {
      if (record.stoppedBy !== 'update') continue
      add('turn', id, id, record.botId, record.roomId)
      for (const item of [...(record.later ?? []), ...(record.trigger?.joined ?? [])]) {
        add('delivery', item?.info?.exchangeId, id, record.botId, record.roomId)
      }
    }
    for (const id of updateCut) add('turn', id, id, rt.selfOf?.(id))
    for (const [id, list] of Object.entries(dropped)) {
      for (const item of Array.isArray(list) ? list : []) {
        const args = item?.args
        if (args && (!liveClaims || liveClaims.has(args.exchangeId))) {
          const title = args.wake === true ? rt.state.tasks?.[args.taskSessionId]?.title : undefined
          add('delivery', args.exchangeId, id, args.toId, args.roomId, title)
        }
      }
    }
    for (const [id, list] of Object.entries(heldBefore)) {
      for (const item of Array.isArray(list) ? list : []) {
        const message = item?.message
        add('input', message?.id, id, rt.selfOf?.(id), rt.groupOwners.get(id)?.roomId)
      }
    }
    const recovery = startUpdateRecovery({
      profileDir: ctx.get?.('profileContext')?.dir, run, items, inventoryReadable,
      ownsTeam: () => rt.holdsLock() && ownsTeam(),
      currentRun: () => rt.selfUpdateStatus?.()?.run,
      warn: (...args) => rt.warn(...args),
    })
    if (recovery) recoveryReports.add(recovery)
    return recovery
  }

  function finishRecovery(recovery) {
    if (recoveryReports.delete(recovery)) recovery.finish()
  }

  async function resumeAll(signal, takeover = false) {
    const defer = outcome => {
      bootDeferred = true
      finish(outcome)
    }
    await rt.load()
    let readOnly = rt.readOnly()
    if (readOnly !== undefined) return defer({ readOnly })
    const adoption = adoptIfNeeded()
    if (adoption !== undefined) await adoption
    // Loading and adoption yield. A click can close admission during either one.
    while (rt.updateHold?.awaitingVerdict) await rt.updateGate(signal)
    signal.throwIfAborted()
    readOnly = rt.readOnly()
    if (readOnly !== undefined) return defer({ readOnly })
    if (needsAdoption) return defer({ failed: 'Could not adopt inflight notes before the restart pass' })
    const term = rt.lockTerm()
    const locked = rt.holdsLock()
    const generation = locked ? rt.teamGeneration?.() : undefined
    const ownsTeam = () => !signal.aborted && !stopped && !notesFenced() && rt.lockTerm() === term
      && (locked ? (rt.sameTeam?.(generation) ?? rt.holdsLock()) : (rt.canWriteTeam?.() ?? term === 0))
    if (!ownsTeam()) return defer({ failed: 'The team changed before the restart pass could take its notes' })
    const { turns: previous, queued: dropped, cut: cutBefore, readable } = interrupted
    const heldBefore = held
    const noted = { ...previous }
    for (const [id, record] of Object.entries(noted)) {
      if (record.stoppedBy === 'update') {
        updateTurns.set(id, record)
        delete previous[id]
        if (turns[id] === record) delete turns[id]
      } else if (takeover) {
        // The prior writer may still have been working when this window opened. A takeover
        // keeps its ordinary notes and resumes only work explicitly held or cut by an update.
        delete noted[id]
        delete previous[id]
      } else if (turns[id] === record) {
        delete turns[id]
      }
    }
    pendingTurns = previous
    interrupted = { turns: {}, queued: {}, held: {}, cut: [] }
    passTook = true
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
    // Keep ordinary notes until a destination takes them or the old turn is accounted for.
    const settleTurn = (id, record) => {
      if (ownsTeam() && previous === pendingTurns && previous[id] === record) {
        delete previous[id]
        return persist()
      }
    }
    const deliveries = takeover ? {} : dropped
    const run = expectedUpdateRun === undefined ? null : rt.selfUpdateStatus?.()?.run
    const recovery = run && run.runId === expectedUpdateRun
      ? reportRecovery(run, noted, cutBefore, deliveries, heldBefore, ownsTeam, { inventoryReadable: readable }) : null
    const works = pass(noted, deliveries, destinationWork, ownsTeam, { settleTurn, recovery })
    destinationPlan.resolve()
    const resending = Promise.allSettled(works.values()).then(async results => {
      firstTurn = undefined
      startedTurns = undefined
      taken = undefined
      await rt.settleRoomBatches?.()
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    })
    try {
      // Healing task Sessions is independent of a reply waiting for a busy Bot.
      const results = await Promise.allSettled([resending, healCutSessions(new Set(Object.keys(noted)), {
        updateCut: cutBefore, onlyUpdate: takeover, ownsTeam, recovery,
      })])
      // Input a held step had taken goes after the cut work is picked up.
      await resendHeld(heldBefore, ownsTeam, recovery)
      if (recovery && !takeover) {
        for (const id of await rt.wakeLog?.bootReplayed ?? []) recovery.resumed('delivery', id)
      }
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    } finally {
      finishRecovery(recovery)
    }
    persist()
    finish({})
  }

  // The resume pass over a set of notes: each noted turn and each dropped delivery, by destination.
  function pass(noted, dropped, works, ownsTeam, { liveClaims, settleTurn, recovery } = {}) {
    // Read once, before any resume, so every post can tell its owners.
    owners = ownersOf()
    // Resolve each durable item on its own; an old Session can now lead to several
    // destinations. Only equal exchange ids represent the same queued delivery.
    const destinations = new Map()
    const add = (target, item) => {
      if (target === undefined) return
      if (!destinations.has(target)) destinations.set(target, [])
      destinations.get(target).push(item)
    }
    for (const [sessionId, record] of Object.entries(noted)) {
      const pickedUp = () => settleTurn?.(sessionId, record)
      if (rt.botOf(record.botId) === undefined) {
        pickedUp()
        continue
      }
      const target = record.roomId === undefined ? rt.chatOf(record.botId)
        : rt.roomOf(record.roomId)?.sessions?.[record.botId] ?? sessionId
      add(target, { record, recordId: sessionId, done: pickedUp })
    }
    const notes = Object.entries(dropped).flatMap(([oldId, list]) => Array.isArray(list)
      ? list.filter(item => item?.args?.exchangeId !== undefined).map(item => ({ ...item, oldId }))
      : []).sort((a, b) => Number(Boolean(b.args.resumed)) - Number(Boolean(a.args.resumed)) || a.at - b.at)
    // The sticky record owns any hand-back that did not finish last time.
    const pendingBack = new Set(Object.values(noted).filter(record => record.stoppedBy === 'update')
      .flatMap(record => [...(record.later ?? []), ...(record.trigger?.joined ?? [])]
        .map(item => item.info.exchangeId).filter(id => !record.handedBack?.includes(id))))
    const seen = new Set()
    for (const item of notes) {
      const { args, oldId } = item
      if (pendingBack.has(args.exchangeId) || (liveClaims && !liveClaims.has(args.exchangeId))) continue
      if (taken?.has(args.exchangeId)) recovery?.resumed('delivery', args.exchangeId)
      if (args.wake === true && rt.wakeLog?.accountsFor(args.exchangeId)) continue
      if (rt.botOf(args.toId) === undefined || taken?.has(args.exchangeId) || seen.has(args.exchangeId)) continue
      const target = sessionFor(oldId, args)
      if (target === undefined) continue
      seen.add(args.exchangeId)
      add(target, liveClaims ? { ...item, liveClaim: true } : item)
    }
    const prepare = async (target, item) => {
      if (!ownsTeam()) return undefined
      if (item.record === undefined) return item
      const { record, recordId } = item
      // A turn the update cut is picked up whatever ran on its Session since: the update stopped it, not the Bot.
      if (record.stoppedBy === 'update') {
        if (rt.shellHoldOf?.(record.botId) !== undefined) return undefined
        if (record.continuationQueued) return item
        const args = await resumeDelivery(recordId, record, ownsTeam)
        return args?.sessionId === target ? { ...item, args } : undefined
      }
      const reconcile = async () => {
        const args = await reconcileEnded(recordId, record, ownsTeam, item.done)
        return args?.sessionId === target ? { ...item, args } : undefined
      }
      if (firstTurn?.get(recordId)?.type === 'turn/end') return reconcile()
      if (rt.shellHoldOf?.(record.botId) !== undefined) return undefined
      if (startedTurns?.has(recordId)) {
        item.done()
        return undefined
      }
      const agent = await rt.resolveAgent(recordId).catch(() => undefined)
      if (!ownsTeam()) return undefined
      if (startedTurns?.has(recordId)) {
        item.done()
        return undefined
      }
      if (firstTurn?.get(recordId)?.type === 'turn/end') return reconcile()
      if (agent?.status === 'running') {
        update(recordId, () => record)
        item.done()
        return undefined
      }
      const args = await resumeDelivery(recordId, record, ownsTeam)
      if (record.resumed) item.done()
      return args?.sessionId === target ? { ...item, args } : undefined
    }
    for (const [target, items] of destinations) {
      const work = (async () => {
        const ready = await Promise.all(items.map(item => prepare(target, item).catch(error => {
          rt.warn('omni-ui: picking up an interrupted turn for %s failed: %s', target, error)
        })))
        const sendable = ready.filter(Boolean)
        await resendTo(target, sendable.filter(item => item.args !== undefined), ownsTeam, recovery)
        for (const { record, recordId } of sendable) {
          if (!ownsTeam() || record?.stoppedBy !== 'update') continue
          const current = updateTurns.get(recordId)
          if (current?.since !== record.since || !current.continuationQueued) continue
          recovery?.resumed('turn', recordId)
          const joined = (current.trigger?.joined ?? []).filter(item => !current.handedBack?.includes(item.info.exchangeId))
          const send = delivery => ownsTeam() && handBack(recordId, current, delivery, ownsTeam)
          const [laterSent, joinedSent] = await Promise.all([
            handBackResults(recordId, current, ownsTeam),
            handBackRequests(rt, target, record.botId, joined, send),
          ])
          if (recovery) {
            for (const id of updateTurns.get(recordId)?.handedBack ?? []) recovery.resumed('delivery', id)
          }
          if (laterSent && joinedSent && ownsTeam() && updateTurns.get(recordId)?.since === record.since) {
            updateTurns.delete(recordId)
            persist(true)
          }
        }
      })()
      works.set(target, work)
    }
    return works
  }

  // The input held steps had taken when the last run stopped (rt.noteHeldInput), sent again once.
  async function resendHeld(notes, ownsTeam, recovery) {
    for (const [sessionId, list] of Object.entries(notes ?? {})) {
      if (!ownsTeam()) return
      if (!Array.isArray(list) || list.length === 0) continue
      try {
        const roomOwner = rt.groupOwners.get(sessionId)
        const past = rt.pastOwners?.get(sessionId)
        const botId = rt.selfOf?.(sessionId) ?? rt.chatOwners.get(sessionId) ?? roomOwner?.botId ?? past?.botId
        const roomId = roomOwner?.roomId ?? past?.roomId
        const room = roomId === undefined ? undefined : rt.roomOf(roomId)
        const target = botId !== undefined ? sessionFor(sessionId, { toId: botId, roomId })
          : past?.roomId === undefined ? sessionId : room && rt.sessionOfRoom?.(room)
        if (target === undefined || (botId !== undefined && rt.shellHoldOf?.(botId) !== undefined)) continue
        const agent = await rt.resolveAgent(target).catch(() => undefined)
        // A subagent belongs to a parent that is gone: it is not opened on its own.
        if (agent === undefined || agent.session?.header?.origin === 'subagent') continue
        const events = await logOf(sessionId)
        const moved = sessionId === target ? [] : await logOf(target)
        if (events === undefined || moved === undefined) continue
        const receipts = events => new Set(events.filter(event => event?.type === 'user/message').map(event => event.data?.id))
        const written = receipts(events)
        const writtenAfterMove = receipts(moved)
        const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.id))
        for (const item of list) {
          if (!ownsTeam()) return
          const message = item?.message
          if (typeof message?.id !== 'string' || !held[sessionId]?.some(item => item?.message?.id === message.id)) continue
          if (written.has(message.id) || writtenAfterMove.has(message.id)) {
            recovery?.resumed('input', message.id)
            const receiptSession = writtenAfterMove.has(message.id) || sessionId === target
              ? agent.session : ctx.sessions.get?.(sessionId)
            if (receiptSession === undefined) rt.forgetHeldInput(sessionId, message.id)
            else await acknowledgeHeld(receiptSession, message.id)
            continue
          }
          if (heldReceipts.has(message.id)) {
            recovery?.resumed('input', message.id)
            continue
          }
          if (claims.get(target)?.has(message.id)) continue
          if (waiting.has(message.id)) {
            recovery?.resumed('input', message.id)
            continue
          }
          // A restart can target the current part instead of the one that took
          // this input. Close that destination to callers before sending it.
          rt.closePart?.(target, 'held input')
          agent.followup(message)
          // A flush can include a claim before its user/message. Keep the note until that event.
          if (await ctx.sessions.flush(agent.session) !== true) break
          recovery?.resumed('input', message.id)
        }
      } catch (error) {
        rt.warn('omni-ui: sending again what %s was holding failed: %s', sessionId, error)
      }
    }
  }

  // After an update that did not happen, reserve the cut work before releasing held steps.
  rt.resumeUpdateStopped = async (sameTeam = () => true) => {
    await destinationPlan.promise
    const ownsTeam = () => !stopped && !notesFenced() && sameTeam()
    if (!ownsTeam()) return
    const noted = Object.fromEntries(updateTurns)
    const updateCut = cut
    const heldBefore = held
    const stoppedClaims = new Map(cutClaims)
    cutClaims.clear()
    const liveClaims = new Set([...stoppedClaims.values()].flatMap(ids => [...ids]))
    const pendingEnds = [...cutClaimEnds]
    const run = rt.selfUpdateStatus?.()?.run
    const recovery = run?.requestId && run.requestId === publishedRequest
      ? reportRecovery(run, noted, updateCut, queued, heldBefore, ownsTeam, { liveClaims })
      : null
    publishedRequest = undefined
    const works = pass(noted, queued, new Map(), ownsTeam, { liveClaims, recovery })
    const healing = healCutSessions(new Set(Object.keys(noted)), { updateCut, onlyUpdate: true, ownsTeam, recovery })
    const warn = error => rt.warn('ds-bot: picking up the work an update stopped failed: %s', error)
    const recovered = Promise.allSettled([...works.values(), healing]).then(async results => {
      for (const result of results) if (result.status === 'rejected') warn(result.reason)
      await resendHeld(heldBefore, ownsTeam, recovery)
    })
    const replayReports = async ids => {
      if (!ownsTeam()) return
      for (const id of await rt.wakeLog?.replayCutReports(ids, ownsTeam) ?? []) recovery?.resumed('delivery', id)
    }
    const endedClaims = new Set([...stoppedClaims].filter(([id]) => !cutClaimEnds.has(id)).flatMap(([, ids]) => [...ids]))
    const replayed = recovered.then(() => replayReports(endedClaims))
    // A slow cancellation can still own a claim when a verdict comes back. Try that input again after turn end.
    const late = pendingEnds.map(async ([id, end]) => {
      await Promise.all([recovered, end.promise])
      if (!ownsTeam()) return
      const work = pass({}, { [id]: queued[id] }, new Map(), ownsTeam, { liveClaims, recovery })
      const results = await Promise.allSettled(work.values())
      for (const result of results) if (result.status === 'rejected') warn(result.reason)
      await resendHeld({ [id]: held[id] }, ownsTeam, recovery)
      await replayReports(stoppedClaims.get(id))
    })
    void Promise.allSettled([replayed, ...late]).then(results => {
      for (const result of results) if (result.status === 'rejected') warn(result.reason)
      finishRecovery(recovery)
    })
  }

  const bootFailed = error => {
    if (controller.signal.aborted) return
    rt.warn('ds-bot: picking up interrupted work failed: %s', error)
    finish({ failed: error?.message ?? String(error) })
  }
  ctx.effect(() => {
    // Every start looks: the Sessions a restart cut need no notes to be found. A start the web self-update holds
    // (its trial, or a give-back) waits for the supervisor's verdict first (self-update-hold.js).
    const { signal } = controller
    void (async () => {
      // Every module installs in the same tick: the update's hold exists after one turn of the queue.
      await null
      await rt.updateGate?.(signal)
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, RESUME_DELAY_MS)
        timer?.unref?.()
        signal.addEventListener('abort', onAbort, { once: true })
      })
      await rt.updateGate?.(signal)
      signal.throwIfAborted()
      await resumeAll(signal)
    })().catch(bootFailed)
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      controller.abort()
      finish({ failed: 'DS Bot stopped before the restart pass ended' })
      return writing
    }
  }, 'omni-ui: resume interrupted turns')
}
