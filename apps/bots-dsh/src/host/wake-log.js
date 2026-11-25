import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, readdirSync, fchmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, LATE_ANSWER, SOURCE_KIND } from './constants.js'
import { historyBack, readNotes } from './resume.js'

export const io = { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, readdirSync, fchmodSync, existsSync }

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const REWRITE_BYTES = 1024 * 1024
const KINDS = new Set(['task-report', 'group-report'])
const EVENTS = new Set(['intent', 'prepared', 'attempt', 'sent', 'moved', 'done', 'dropped'])
const TERMINAL = new Set(['done', 'dropped'])
const TEMP = /^wake\.jsonl\.[^/\\]+\.tmp$/
const FOLDER_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EBADF', 'ENOTSUP', 'EACCES'])

function addRecord(reports, record, line) {
  const { id, event, v } = record
  let report = reports.get(id)
  if (report === undefined) {
    report = { id, records: [], raw: [], at: 0, open: false, foreign: false, headless: true }
    reports.set(id, report)
  }
  const compacted = report.records.length === 0 && TERMINAL.has(event) && typeof record.key === 'string'
  report.records.push(record)
  report.raw.push(line)
  report.at = Math.max(report.at, Number.isFinite(record.at) ? record.at : 0)
  if (v > 1 || (v === 1 && (!EVENTS.has(event) || (event === 'intent' && !KINDS.has(record.kind))))) report.foreign = true
  if (v !== 1) return report
  if (event === 'intent' || compacted) {
    report.key = record.key
    report.kind = record.kind
    report.botId = record.botId
    report.headless = false
    if (event === 'intent') {
      report.intent = record
      report.open = report.closedAt === undefined
    }
  }
  if (TERMINAL.has(event) && !report.headless) {
    report.open = false
    report.closedAt = record.at
    report.terminal = record
  }
  return report
}

function parse(body) {
  const reports = new Map()
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (typeof record?.id !== 'string' || typeof record.event !== 'string' || typeof record.v !== 'number') continue
    addRecord(reports, record, line)
  }
  return reports
}

function writeAll(fd, body) {
  for (let offset = 0; offset < body.length;) {
    const bytes = io.writeSync(fd, body, offset, body.length - offset)
    if (bytes <= 0) throw Object.assign(new Error('wake log write made no progress'), { code: 'EIO' })
    offset += bytes
  }
}

const inboxMessages = agent => [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
const idOf = message => message?.source?.kind === SOURCE_KIND ? message.source.exchangeId : undefined
const heldBy = (agent, id) => inboxMessages(agent).some(message => idOf(message) === id)
const sessionOf = agent => agent?.session?.id ?? agent?.id
const claimKey = (sessionId, messageId) => JSON.stringify([sessionId, messageId])
const sessionRecords = report => (report?.records ?? []).filter(record => ['intent', 'attempt', 'moved'].includes(record.event) && record.sessionId)
const recordSessions = report => new Set(sessionRecords(report).map(record => record.sessionId))

// Some controller operations do not take a signal. Bound the wait even if they
// never settle, and also cancel history and projection reads that do take one.
async function bounded(run) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('wake log destination timed out'), { code: 'wake/timeout' })
      controller.abort(error)
      reject(error)
    }, HISTORY_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([timeout, run(controller.signal)])
  } finally {
    clearTimeout(timer)
  }
}

export function install(rt) {
  const { ctx, state, home } = rt
  const file = join(home, 'wake.jsonl')
  const inflight = join(home, 'inflight.json')
  const tempName = `wake.jsonl.${process.pid}.tmp`
  const temp = join(home, tempName)
  let reports = new Map()
  let keys = new Map()
  let diskUnmarked = new Set()
  let torn = false
  let size = 0
  let unreadable = false
  let stopping = false
  let epoch = 0
  let readTerm
  let quietDepth = 0
  let tightened = false
  let rewriteTimer
  let retryRewrite = false
  const claimed = new Map()
  const withdrawals = new Map()
  const firstSends = new Map()

  const loadedHolder = () => !stopping && ctx.fiber?.uid !== null && rt.holdsLock() && rt.teamLoaded()
  const owned = () => loadedHolder() && !unreadable && readTerm !== undefined && rt.lockTerm() === readTerm
  const guard = () => {
    const mine = epoch
    const term = readTerm
    return () => owned() && epoch === mine && readTerm === term
  }
  const known = report => report !== undefined && !report.foreign && !report.headless
  const open = report => known(report) && report.open && reports.get(report.id) === report
  const old = report => Date.now() - report.intent.at > WEEK_MS
  const unmarked = id => diskUnmarked.has(id) || rt.deliveryNote(id)?.marked === false
  const pending = id => firstSends.get(id) === rt.lockTerm()
  const warn = (text, bot) => {
    try { rt.noteFailure?.({ level: 'warn', source: 'wake', text, ...(bot ? { bot } : {}) }) } catch {}
  }
  const errorCode = error => error?.code ?? error?.name ?? 'unknown'
  const reportLabel = report => `wake report ${report.id} (${report.kind}) for ${rt.botOf(report.botId)?.name ?? report.botId}`
  const warnRecord = (report, event, error) => warn(`${reportLabel(report)} could not write ${event} (${errorCode(error)})`, report.botId)

  const indexReports = (next) => {
    reports = next
    keys = new Map()
    for (const report of reports.values()) if (known(report) && report.key !== undefined) keys.set(report.key, report.id)
  }

  function read() {
    if (!loadedHolder() || unreadable) return
    let body
    try {
      body = io.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        unreadable = true
        warn(`wake log could not be read (${errorCode(error)}); nothing in it is replayed`)
        return
      }
      body = ''
    }
    const next = parse(body)
    // A live closure may already be saving a report when the start pass rereads it.
    // Keep its object only when the entire record sequence still agrees.
    for (const [id, report] of next) {
      const prior = reports.get(id)
      if (open(prior) && prior.raw.length === report.raw.length && prior.raw.every((line, i) => line === report.raw[i])) next.set(id, prior)
    }
    indexReports(next)
    torn = body !== '' && !body.endsWith('\n')
    size = Buffer.byteLength(body)
    readTerm = rt.lockTerm()
  }

  function syncHome() {
    try {
      const fd = io.openSync(home, 'r')
      try { io.fsyncSync(fd) } finally { io.closeSync(fd) }
    } catch (error) {
      if (!FOLDER_SYNC_UNSUPPORTED.has(error?.code)) throw error
    }
  }

  function append(record, { sync = true } = {}) {
    const line = JSON.stringify(record)
    const bytes = Buffer.from(`${torn ? '\n' : ''}${line}\n`)
    try {
      const existed = io.existsSync(file)
      const fd = io.openSync(file, 'a', 0o600)
      try {
        if (!tightened && process.platform !== 'win32') {
          io.fchmodSync(fd, 0o600)
          tightened = true
        }
        writeAll(fd, bytes)
        if (sync) io.fsyncSync(fd)
      } finally {
        io.closeSync(fd)
      }
      if (!existed) syncHome()
    } catch (error) {
      torn = true
      throw error
    }
    torn = false
    size += bytes.length
    const report = addRecord(reports, record, line)
    if (known(report) && report.key !== undefined) keys.set(report.key, report.id)
    if (size > REWRITE_BYTES && rewriteTimer === undefined && !retryRewrite) {
      rewriteTimer = setImmediate(rewrite)
      rewriteTimer.unref?.()
    }
  }

  function writeRecord(report, event, fields, options) {
    try {
      append({ v: 1, id: report.id, at: Date.now(), event, ...fields }, options)
      return true
    } catch (error) {
      warnRecord(report, event, error)
      return false
    }
  }

  function rewrite() {
    clearImmediate(rewriteTimer)
    rewriteTimer = undefined
    if (!owned() || (reports.size === 0 && size === 0)) return
    const next = new Map()
    const lines = []
    const since = Date.now() - WEEK_MS
    for (const report of reports.values()) {
      if (report.foreign || report.open || (report.headless && report.at > since)) {
        next.set(report.id, report)
        for (const line of report.raw) lines.push(line)
      } else if (report.closedAt > since) {
        const { key, kind, botId, closedAt, id, terminal } = report
        const { work, replyTo, taskSessionId } = report.intent?.report ?? terminal
        const sub = report.intent?.sub ?? terminal.sub
        const record = { v: 1, id, at: closedAt, event: terminal.event, key, kind, botId,
          ...(terminal.event === 'done' ? { how: terminal.how } : { reason: terminal.reason }),
          ...(work ? { work } : {}), ...(replyTo ? { replyTo } : {}), ...(sub ? { sub } : {}),
          ...(taskSessionId ? { taskSessionId } : {}) }
        const line = JSON.stringify(record)
        lines.push(line)
        addRecord(next, record, line)
      }
    }
    const body = Buffer.from(lines.length > 0 ? lines.join('\n') + '\n' : '')
    try {
      const fd = io.openSync(temp, 'w', 0o600)
      try {
        if (process.platform !== 'win32') io.fchmodSync(fd, 0o600)
        writeAll(fd, body)
        io.fsyncSync(fd)
      } finally {
        io.closeSync(fd)
      }
      if (!owned()) {
        io.unlinkSync(temp)
        return
      }
      io.renameSync(temp, file)
    } catch (error) {
      try { io.unlinkSync(temp) } catch {}
      retryRewrite = true
      warn(`wake log could not be compacted (${errorCode(error)})`)
      return
    }

    retryRewrite = false
    size = body.length
    torn = false
    indexReports(next)
    try { syncHome() } catch (error) { warn(`wake log folder could not be synced (${errorCode(error)})`) }
    try {
      for (const name of io.readdirSync(home)) if (TEMP.test(name) && name !== tempName) io.unlinkSync(join(home, name))
    } catch (error) {
      warn(`wake log temporary files could not be removed (${errorCode(error)})`)
    }
  }

  function repair({ intent }) {
    if (intent.kind === 'task-report') {
      const task = state.tasks?.[intent.report.taskSessionId]
      if (task?.status !== 'working') return false
      Object.assign(task, intent.outcome)
      rt.endGrants?.(intent.report.taskSessionId, 'task')
      return true
    }
    const { sub, report } = intent
    if (!sub) return false
    if (state.works?.[sub]) {
      const text = intent.late && report.text.startsWith(LATE_ANSWER) ? report.text.slice(LATE_ANSWER.length) : report.text
      rt.closeWork(sub, `Group "${report.note}"`, text)
      return true
    }
    if (intent.late && state.abandonedWorks?.[sub]) {
      rt.abandonedWork(sub)
      return true
    }
    return false
  }

  function cleanup(report, how) {
    if (!unmarked(report.id)) rt.forgetDelivery(report.id)
    const { work, replyTo } = report.intent?.report ?? report.terminal
    if (work && replyTo) {
      if (how !== 'taken') rt.answerMissed(replyTo)
      rt.takenWork(work, replyTo)
    }
  }

  async function saveProducer(report, still) {
    if (!still() || !open(report)) return false
    repair(report)
    try { await rt.save({ required: true }) } catch { return false }
    return still() && open(report)
  }

  function finish(report, event, fields, still) {
    if (!still() || !open(report) || unmarked(report.id)) return
    const sync = event === 'dropped' || fields.how === 'discarded'
    if (!writeRecord(report, event, fields, { sync })) return
    if (event === 'dropped') warn(`${reportLabel(report)} was dropped (${fields.reason})`, report.botId)
    claimed.delete(report.id)
    if (still()) cleanup(report, fields.how ?? event)
  }

  const currentTarget = ({ intent, botId }) => {
    const room = intent.returnRoomId ? rt.roomOf(intent.returnRoomId) : undefined
    const groupSession = room?.members?.includes(botId) ? room.sessions?.[botId] : undefined
    return groupSession ?? rt.chatOf(botId)
  }

  function sessionsToCheck(report, target) {
    const sessions = recordSessions(report)
    const { intent, botId } = report
    const bot = rt.botOf(botId)
    const room = intent.returnRoomId ? rt.roomOf(intent.returnRoomId) : undefined
    // A moved record may have failed even when a send fell back to own chat.
    // Explicitly recorded Sessions stay in the search regardless of retirement.
    for (const segment of [...room?.segments?.[botId] ?? [], ...bot?.segments ?? []]) {
      if (!Number.isFinite(segment.endedAt) || segment.endedAt >= intent.at) sessions.add(segment.sessionId)
    }
    const chat = rt.chatOf(botId)
    if (chat) sessions.add(chat)
    if (target) sessions.add(target)
    return sessions
  }

  async function confirmMissing(sessionId, signal) {
    return await ctx.sessionController.projections?.({ sessionId }, signal) === null
  }

  const flush = session => bounded(() => ctx.sessions.flush(session)).catch(() => false)

  async function observe(sessionId, report, still, waitForIdle) {
    let agent
    try {
      agent = await bounded(() => rt.resolveAgent(sessionId))
    } catch (error) {
      if (!still() || error?.code !== 'session/not-found') return { result: 'unreadable' }
      try {
        if (await bounded(signal => confirmMissing(sessionId, signal))) return { result: 'gone' }
      } catch {
        return { result: 'unreadable' }
      }
    }
    if (!still()) return { result: 'unreadable' }
    try {
      if (waitForIdle && agent?.status === 'running') await bounded(() => agent.whenIdle())
      if (!still()) return { result: 'unreadable' }
      const held = heldBy(agent, report.id)
      const result = await bounded(async (signal) => {
        try {
          // An intent has no reliable lower Session sequence, and event clocks can go back.
          for await (const event of historyBack(ctx.sessionController, sessionId, signal)) {
            if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND
              && event.data.source.exchangeId === report.id) return 'found'
          }
          return 'absent'
        } catch (error) {
          if (still() && error?.code === 'session/not-found' && await confirmMissing(sessionId, signal)) return 'gone'
          return 'unreadable'
        }
      })
      if (!still()) return { result: 'unreadable' }
      const live = result === 'found' ? ctx.sessions.get?.(sessionId) : undefined
      if (live && await flush(live) !== true) return { agent, held, result: 'unreadable' }
      return { agent, held, result: !agent && result === 'absent' ? 'unreadable' : result }
    } catch {
      return { result: 'unreadable' }
    }
  }

  function quiet(fn) {
    quietDepth += 1
    try { return fn() } finally { quietDepth -= 1 }
  }

  const currentSession = id => sessionRecords(reports.get(id)).at(-1)?.sessionId

  const isClaimed = id => (claimed.get(id)?.size ?? 0) > 0
  // Steering removes the message, reinserts it, and can claim it before the save returns.
  const cancelWithdrawal = ({ agent, message } = {}) => {
    withdrawals.delete(claimKey(sessionOf(agent), message?.id))
  }
  ctx.on('agent/inbox/inserted', (payload) => {
    cancelWithdrawal(payload)
    rt.noteUpdateInbox?.(payload)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
    cancelWithdrawal({ agent, message })
    rt.noteUpdateInbox?.({ agent, message }, true)
    const id = idOf(message)
    const report = reports.get(id)
    if (!open(report)) return
    if (!claimed.has(id)) claimed.set(id, new Set())
    claimed.get(id).add(claimKey(sessionOf(agent), message.id))
  })

  async function closeTaken(report, session, still) {
    if (!await saveProducer(report, still) || !still()) return
    if (await flush(session) !== true || !still()) return
    finish(report, 'done', { how: 'taken' }, still)
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== SOURCE_KIND) return
    const report = reports.get(event.data.source.exchangeId)
    if (!open(report) || unmarked(report.id)) return
    const still = guard()
    setImmediate(() => { void closeTaken(report, session, still) })
  })

  ctx.on('agent/inbox/discarded', ({ message, agent } = {}) => {
    if (quietDepth > 0 || rt.updateShuttingDown?.() || !owned()) return
    const id = idOf(message)
    const report = reports.get(id)
    if (!open(report) || unmarked(id)) return
    const sessionId = sessionOf(agent)
    const key = claimKey(sessionId, message.id)
    if (claimed.get(id)?.has(key)) return
    if (!recordSessions(report).has(sessionId) && currentTarget(report) !== sessionId) return
    if (heldBy(agent, id)) return
    const still = guard()
    const withdrawal = {}
    withdrawals.set(key, withdrawal)
    void saveProducer(report, still).then((saved) => {
      if (withdrawals.get(key) !== withdrawal) return
      withdrawals.delete(key)
      if (saved && !heldBy(agent, id)) finish(report, 'done', { how: 'discarded' }, still)
    })
  })

  async function nudge(agent, id, still) {
    if (!still() || unmarked(id) || isClaimed(id)) return false
    const step = agent.inbox.nextStep.find(message => idOf(message) === id)
    const message = step ?? agent.inbox.nextTurn.find(message => idOf(message) === id)
    if (message === undefined) return false
    if (agent.status === 'running') return true
    quiet(() => agent.inbox.remove(message.id))
    agent.send(message, step === undefined ? 'next-turn' : 'next-step', true)
    return await flush(agent.session) === true
  }

  async function reconcile(report, target, botsAtStart, kind, still, handedBack, original = target) {
    const { id, botId } = report
    if (!still() || !open(report) || unmarked(id) || pending(id)) return
    if (repair(report)) {
      try { await rt.save({ required: true }) } catch { return }
      if (!still() || !open(report)) return
    }
    if (rt.botOf(botId) === undefined) {
      if (!botsAtStart.has(botId) && await saveProducer(report, still)) finish(report, 'done', { how: 'gone' }, still)
      return
    }
    const sessions = sessionsToCheck(report, target)
    if (kind !== 'hourly') {
      // A past part may still have legacy resume work or input waiting to be moved.
      try {
        await Promise.all([...sessions].map(sessionId => bounded(async () => {
          await rt.resumeDestination(sessionId).catch(() => {})
          if (still()) await rt.heldBackFor?.(sessionId).catch(() => {})
        })))
      } catch { return }
      if (!still() || !open(report) || unmarked(id) || pending(id)) return
    }

    // Give-back runs after the cut's claims retire. A new continuation can already be
    // running; the report can queue behind it once its own receipt and inbox are checked.
    const observations = new Map(await Promise.all([...sessions].map(async sessionId =>
      [sessionId, await observe(sessionId, report, still, kind !== 'update')])))
    if (!still() || !open(report) || unmarked(id) || pending(id)) return
    const results = [...observations.values()]
    if (results.some(({ result }) => result === 'found')) {
      handedBack.add(id)
      if (await saveProducer(report, still)) finish(report, 'done', { how: 'taken' }, still)
      return
    }
    if (isClaimed(id)) return
    const held = results.find(({ agent, held }) => held && heldBy(agent, id))
    if (held !== undefined) {
      if (await nudge(held.agent, id, still) && still()) handedBack.add(id)
      return
    }
    if (results.some(({ result }) => result === 'unreadable')) return
    if (old(report)) {
      if (await saveProducer(report, still)) finish(report, 'dropped', { reason: 'stale' }, still)
      return
    }
    if (kind === 'hourly') return
    if (report.records.filter(record => record.event === 'attempt').length >= 2) {
      if (await saveProducer(report, still)) finish(report, 'dropped', { reason: 'attempts' }, still)
      return
    }
    // A part or membership can change during observation. Leave it for another pass
    // unless the target is still the one whose receipt and inbox were checked.
    if (currentTarget(report) !== original || target === undefined) return
    if (observations.get(target)?.result !== 'gone') return { report, target, original }

    const chat = rt.chatOf(botId)
    if (chat === undefined || chat === target) return
    // The fallback must pass the very same receipt, inbox and resume checks.
    return await reconcile(report, chat, botsAtStart, kind, still, handedBack, target)
  }

  const sendable = ({ report, target, original }, still) => still() && open(report)
    && !pending(report.id) && !unmarked(report.id) && !isClaimed(report.id) && !old(report)
    && rt.botOf(report.botId) !== undefined && rt.isBotSession(target)
    && currentTarget(report) === original && (target === original || target === rt.chatOf(report.botId))

  function stage(item, still, signal) {
    const { report, target } = item
    if (!sendable(item, still)) return
    const { id, botId, intent } = report
    rt.forgetDelivery(id)
    const ready = Promise.withResolvers()
    const sent = Promise.withResolvers()
    const args = { toId: botId, sessionId: target, ...intent.report,
      roomId: intent.roomId, exchangeId: id, resent: true, wake: true }
    void rt.deliver(args, {
      shouldSend: () => !signal.aborted && sendable(item, still),
      enqueue(agent, message) {
        ready.resolve({ item, agent, message, sent })
        return sent.promise
      },
    }).catch(error => warn(`${reportLabel(report)} could not be resent (${errorCode(error)})`, botId))
      .finally(() => ready.resolve())
    return { ready: ready.promise, sent }
  }

  async function resend(items, still, waitForIdle, handedBack) {
    const stages = []
    try {
      const ready = await bounded(async (signal) => {
        for (const item of items) {
          const staged = stage(item, still, signal)
          if (staged !== undefined) stages.push(staged)
        }
        return (await Promise.all(stages.map(staged => staged.ready))).filter(Boolean)
      })
      if (!still() || ready.length === 0) return
      const { agent } = ready[0]
      if (waitForIdle && ready.length > 1 && agent.status === 'running') await bounded(() => agent.whenIdle())
      if (!still()) return
      const reserved = ready.filter(({ item, agent }) => sendable(item, still)
        && !heldBy(agent, item.report.id) && writeRecord(item.report, 'attempt', { sessionId: item.target }))
      for (const [index, { item, agent, message }] of reserved.entries()) {
        if (!still()) return
        if (index < reserved.length - 1 && agent.status !== 'running' && typeof agent.inject === 'function') agent.inject(message)
        else agent.followup(message)
        if (still() && open(item.report)) writeRecord(item.report, 'sent', { messageId: message.id })
      }
      if (reserved.length === 0) return
      const flushed = await flush(agent.session)
      if (still()) {
        for (const { item, sent } of reserved) {
          if (flushed === true) handedBack.add(item.report.id)
          sent.resolve(true)
        }
      }
    } catch (error) {
      if (still() && error?.code !== 'wake/timeout') warn(`wake replay could not send a batch (${errorCode(error)})`)
    } finally {
      for (const { sent } of stages) sent.resolve(false)
    }
  }

  function adoptNotes(notes) {
    diskUnmarked = new Set(Object.values(notes.queued).flatMap(list => Array.isArray(list)
      ? list.filter(item => item?.args?.wake !== true).map(item => item?.args?.exchangeId).filter(Boolean) : []))
    read()
  }

  async function pass(kind, mine, adoption, cut) {
    if (mine !== epoch || stopping) return
    if (kind === 'start') {
      await rt.load()
      if (mine !== epoch || !loadedHolder()) return
      // Capture the startup snapshot once resume has planned its work. Only the
      // destinations this report may have reached wait for that work to finish.
      await rt.resumeDestination()
      if (mine !== epoch || !loadedHolder()) return
      adoptNotes(readNotes(inflight))
    }
    if (kind === 'takeover' && (await adoption === undefined || mine !== epoch)) return
    const owns = guard()
    const still = () => owns() && (cut?.ownsTeam() ?? true)
    if (!still()) return
    const botsAtStart = new Set(Object.keys(state.bots))
    const handedBack = new Set()
    const byDestination = new Map()
    for (const report of reports.values()) {
      if (!open(report) || (kind === 'hourly' && !old(report)) || (cut && !cut.ids.has(report.id))) continue
      const target = currentTarget(report)
      if (!byDestination.has(target)) byDestination.set(target, [])
      byDestination.get(target).push(report)
    }
    const results = await Promise.allSettled([...byDestination].map(async ([target, group]) => {
      const batches = new Map()
      for (const report of group) {
        if (!still()) return
        const candidate = await reconcile(report, target, botsAtStart, kind, still, handedBack)
        if (!still()) return
        if (candidate === undefined) continue
        const key = JSON.stringify([candidate.target, report.intent.report.work ?? ''])
        if (!batches.has(key)) batches.set(key, [])
        batches.get(key).push(candidate)
      }
      for (const items of batches.values()) {
        if (!still()) return
        await resend(items, still, kind !== 'update', handedBack)
      }
    }))
    if (!still()) return
    for (const result of results) {
      if (result.status === 'rejected') warn(`wake replay for a destination failed (${errorCode(result.reason)})`)
    }
    if (kind === 'hourly' || cut) return handedBack
    for (const report of reports.values()) {
      if (!known(report) || report.open || unmarked(report.id)) continue
      const { work, replyTo } = report.intent?.report ?? report.terminal
      if (rt.deliveryNote(report.id)?.marked || state.works?.[work]?.open?.includes(replyTo)) {
        cleanup(report, report.terminal.how ?? report.terminal.event)
      }
    }
    rewrite()
    return handedBack
  }

  read()
  // Load becomes authoritative before the remaining startup modules can emit
  // a report or resume a marked delivery.
  let chain = Promise.resolve().then(async () => {
    const loading = rt.load()
    if (epoch === 0 && readTerm === undefined) read()
    await loading
  }).catch(error => warn(`wake log could not start (${errorCode(error)})`))
  let passing = false
  const queue = (kind, adoption, cut) => {
    const mine = epoch
    chain = chain.then(async () => {
      passing = true
      try { return await pass(kind, mine, adoption, cut) } finally { passing = false }
    }).catch(error => warn(`wake replay failed (${errorCode(error)})`))
    return chain
  }
  const startDone = queue('start')
  const takeOver = () => {
    const mine = epoch
    const adoption = rt.reloadDeliveryNotes(notes => {
      if (mine === epoch && loadedHolder()) adoptNotes(notes)
    })
    void queue('takeover', adoption)
    return adoption
  }
  const offGained = rt.onLockGained(() => {
    epoch += 1
    void takeOver()
  })

  rt.wakeLog = {
    intent(fields) {
      if (unreadable || rt.loginTextMatches?.(fields.report.text)
        || rt.reportHasLoginCode?.({ ...fields.report, roomId: fields.roomId })) return 'off'
      if (!owned()) return 'unowned'
      try {
        append({ v: 1, ...fields, at: Date.now(), event: 'intent' })
        firstSends.set(fields.id, readTerm)
        return 'written'
      } catch (error) {
        warn(`${reportLabel(fields)} goes without the wake log: ${errorCode(error)}`, fields.botId)
        return 'failed'
      }
    },
    byKey(key) {
      if (!owned()) return
      const report = reports.get(keys.get(key))
      if (!known(report)) return
      return { id: report.id, open: report.open,
        ...(report.open && report.kind === 'task-report' ? { outcome: report.intent.outcome } : {}) }
    },
    sent(id, messageId) {
      const report = reports.get(id)
      if (owned() && open(report)) writeRecord(report, 'sent', { messageId })
    },
    moved(id, sessionId) {
      const report = reports.get(id)
      if (owned() && open(report) && sessionId !== currentSession(id)) writeRecord(report, 'moved', { sessionId })
    },
    owns: id => open(reports.get(id)),
    accountsFor(id) {
      const report = reports.get(id)
      return owned() && (known(report) || report?.foreign === true)
    },
    retryTakeover: takeOver,
    currentSession,
    quiet,
    get movingInbox() { return quietDepth > 0 },
    discardLoginCode(agent, message) {
      const report = reports.get(idOf(message))
      if (!owned() || !open(report) || unmarked(report.id)
        || !sessionsToCheck(report, currentTarget(report)).has(sessionOf(agent))) return false
      const still = guard()
      void saveProducer(report, still).then((saved) => {
        if (saved) finish(report, 'done', { how: 'discarded' }, still)
      })
      return true
    },
    retireClaim(sessionId, message) {
      const id = idOf(message)
      const claims = claimed.get(id)
      claims?.delete(claimKey(sessionId, message.id))
      if (claims?.size === 0) claimed.delete(id)
    },
    replayCutReports(ids, ownsTeam) {
      if (ids?.size > 0) return queue('update', undefined, { ids, ownsTeam })
    },
    firstOptions(id) {
      const term = firstSends.get(id)
      return {
        shouldSend: () => owned() && term === rt.lockTerm() && open(reports.get(id)),
        made(message) {
          if (term === rt.lockTerm()) rt.wakeLog.sent(id, message.id)
          firstSends.delete(id)
        },
      }
    },
    firstFinished: id => firstSends.delete(id),
    botGone(botId) {
      if (!owned()) return
      const still = guard()
      for (const report of reports.values()) {
        if (!open(report) || report.botId !== botId || unmarked(report.id)) continue
        void saveProducer(report, still).then((saved) => {
          if (saved && rt.botOf(botId) === undefined) finish(report, 'done', { how: 'gone' }, still)
        })
      }
    },
    get bootReplayed() { return startDone },
    get replayed() { return startDone.then(() => chain) },
  }

  ctx.effect(() => {
    const hourly = setInterval(() => {
      if (!owned()) return
      if (retryRewrite) rewrite()
      if (!passing) void queue('hourly')
    }, HOUR_MS)
    const daily = setInterval(rewrite, DAY_MS)
    hourly.unref?.()
    daily.unref?.()
    return () => {
      stopping = true
      offGained()
      clearInterval(hourly)
      clearInterval(daily)
      clearImmediate(rewriteTimer)
    }
  }, 'omni-ui: durable wake log')
}
