// RFC 0040 serves eligible group chats to Pocket. Watches carry text, the members'
// own approvals and Stop. Folder requests and subagent asks stay on the computer,
// as do attachments, management, grants and Allow for session. A card is a view
// of the group's own approval entry, and only a person can answer it.
import { realpath } from 'node:fs/promises'
import { within } from './folders.js'
import { lineText, noticeText } from './groups.js'
import { sha256 } from './pocket-attach.js'
import { cleanChatText, pageOf, placedBot, refused, PAGE_ROWS, PREVIEW_MAX, REQUEST_PREFIX, SEND_TEXT_MAX, STATE_POLL_MS, TEXT_MAX } from './pocket-chat.js'

export const ROOM_PREFIX = 'dsh:room:'
export const roomTerminalOf = roomId => `${ROOM_PREFIX}${roomId}`
export const roomIdOfTerminal = terminal => {
  if (typeof terminal !== 'string' || !terminal.startsWith(ROOM_PREFIX)) return null
  const id = terminal.slice(ROOM_PREFIX.length)
  return /^[\w-]{1,160}$/.test(id) ? id : null
}
export const roomRowIdOf = (roomId, seq) => `${roomTerminalOf(roomId)}:${seq}`
export function roomCursorOf(id) {
  if (typeof id !== 'string') return null
  const at = id.lastIndexOf(':')
  const roomId = roomIdOfTerminal(id.slice(0, at))
  const number = id.slice(at + 1)
  const seq = Number(number)
  return roomId !== null && /^[1-9]\d*$/.test(number) && Number.isSafeInteger(seq) ? { roomId, seq } : null
}

export const MEMBER_EVENTS = new Set(['working', 'done', 'stopped', 'cut', 'resumed', 'lookup', 'permission-stop'])
export const NOTICE_REASONS = new Set(['failed', 'missed', 'admin-passed', 'paused', 'folder', 'goal'])
export const GROUP_SENDS_KEPT = 64
export const RECEIPTS_KEPT = 16
export const RECEIPT_ROOMS = 32
const realTimers = { setInterval, clearInterval }
const sameGeneration = (a, b) => a?.epoch === b?.epoch && a?.term === b?.term
const bookOf = room => `group-${room.id}`
const writeReason = reason => reason === 'deleted' ? 'not-watching' : reason
const words = text => typeof text === 'string' ? text : ''

export function cutBytes(text, max) {
  text = words(text)
  if (Buffer.byteLength(text) <= max) return text
  let left = max - Buffer.byteLength('…')
  if (left < 0) return ''
  let end = 0
  for (const point of text) {
    left -= Buffer.byteLength(point)
    if (left < 0) break
    end += point.length
  }
  return `${text.slice(0, end)}…`
}

export function mediaCount(record) {
  const units = [
    [record.images?.length ?? 0, 'image'],
    [record.files?.length ?? 0, 'file'],
  ].filter(([count]) => count > 0)
  return units.length === 0 ? '' : `${units.map(([count, name]) => `${count} ${name}${count === 1 ? '' : 's'}`).join(', ')} on the computer`
}

export function projectRecord(record, roomId, who) {
  if (!Number.isInteger(record.seq)) return
  const id = roomRowIdOf(roomId, record.seq)
  const time = record.time
  const notice = record.kind === 'notice'
  const botId = notice ? record.about : record.botId
  const speaker = botId === undefined ? undefined : who(botId)
  const name = speaker?.name ?? (notice ? record.names?.[0] : record.who)
  const registryId = speaker?.registryId ?? null
  if (record.kind === undefined) {
    const count = mediaCount(record)
    const text = cutBytes(count ? [record.caption, `(${count})`].filter(Boolean).join('\n') : record.text, TEXT_MAX)
    const row = record.botId === undefined
      ? { id, kind: 'text', role: 'user', text, time, ...(record.via ? { via: record.via } : {}) }
      : { id, kind: 'text', role: 'assistant', text, time, name, registryId }
    if (count && record.captionCut === true) row.cut = true
    return row
  }
  let msg
  if (record.kind === 'approval') msg = `${name} waited for approval`
  else if (notice && NOTICE_REASONS.has(record.reason)) {
    if (record.reason === 'failed') {
      const names = record.names?.join(' and ') || name
      msg = `${names} stopped: its model call failed (${record.code ?? 'failed'}${record.status ? ` ${record.status}` : ''})`
    } else if (record.reason === 'folder') msg = "The group's folder is gone; its members work in the team workspace"
    else msg = noticeText(record)
  } else if (MEMBER_EVENTS.has(record.kind)) {
    if (record.kind === 'working') msg = `${name} is working on it`
    else if (record.kind === 'permission-stop') msg = `${name} stopped: a permission refused its tool`
    else msg = lineText(record).slice(1, -1)
  } else return
  return {
    id, kind: 'status', msg: cutBytes(words(msg).replace(/[\r\n\u2028\u2029]+/g, ' '), PREVIEW_MAX), time,
    ...(name && (!notice || (record.about !== undefined && record.reason !== 'goal')) ? { name, registryId } : {}),
  }
}

export function approvalCardOf(entry, who) {
  const { name, registryId } = who(entry.botId)
  return {
    id: entry.id, kind: 'approval', open: true, answerable: true, choices: ['allow', 'deny'],
    name, registryId, tool: entry.tool, reason: cutBytes(entry.reason, PREVIEW_MAX),
    summary: cutBytes([entry.detail?.text, entry.detail?.code].filter(text => typeof text === 'string' && text !== '').join('\n'), PREVIEW_MAX),
  }
}

export class GroupSource {
  constructor({ rt, reader, lines, log = () => {}, carriesSignInCode = () => false, timers = realTimers, pollMs = STATE_POLL_MS }) {
    Object.assign(this, { rt, reader, lines, log, carriesSignInCode, timers, pollMs })
    this.watches = new Set()
    this.histories = new Map()
    this.folders = new Map()
    this.pending = new Map()
    this.cards = new Map()
    this.receipts = new Map()
    this.sends = new Map()
    this.marks = new Map()
    this.queued = []
    this.lineAdded = (room, record) => {
      if (this.watches.size === 0) return
      this.queued.push({ room, record })
      if (this.queued.length === 1) queueMicrotask(() => this.flushLines())
    }
  }

  available() {
    const rt = this.rt
    return [
      'teamGeneration', 'sameTeam', 'readOnly', 'load', 'roomOf', 'botOf', 'roomHistory',
      'sessionOfRoom', 'approvalsView', 'onApproval', 'answerApproval', 'groupAskCurrent',
      'stopRoomWork', 'goalUserStopped', 'sendUser', 'roomActive', 'roomWorkView', 'onSaved',
      'groupMemberHolds', 'reportedFolder', 'isFolderApproval', 'teamFolder', 'refreshShellChoice', 'teamCurrent',
    ].every(name => typeof rt[name] === 'function')
      && typeof rt.ctx?.sessions?.list === 'function' && typeof rt.groupOwners?.get === 'function'
      && ['range', 'record'].every(name => typeof rt.ledger?.[name] === 'function')
  }

  start() {
    if (this.offApproval !== undefined) return
    this.closed = false
    this.offApproval = this.rt.onApproval((kind, entry) => this.approvalChanged(kind, entry))
    this.syncGeneration()
    this.seedApprovals()
    this.offSaved = this.rt.onSaved(() => this.checkWatches())
    this.lines.add(this.lineAdded)
  }

  close() {
    this.closed = true
    this.offApproval?.()
    this.offApproval = undefined
    this.offSaved?.()
    this.offSaved = undefined
    this.lines.delete(this.lineAdded)
    for (const watch of this.watches) this.gone(watch, 'unavailable')
    this.clearCaches()
    this.pending.clear()
    this.queued = []
    this.gen = undefined
  }

  clearCaches() {
    this.histories.clear()
    this.folders.clear()
    this.cards.clear()
    this.receipts.clear()
    this.sends.clear()
    this.marks.clear()
  }

  syncGeneration() {
    const gen = this.rt.teamGeneration()
    if (!sameGeneration(gen, this.gen)) {
      this.gen = gen
      this.clearCaches()
      this.seedApprovals()
    }
    return gen
  }

  async prepare() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.rt.refreshShellChoice()
      const gen = this.syncGeneration()
      if (this.current(gen) && this.rt.teamCurrent() === true) return gen
    }
  }

  current(gen) {
    if (this.closed || !sameGeneration(gen, this.syncGeneration())) return false
    if (this.rt.sameTeam(gen) === true && this.rt.readOnly() === undefined) return true
    this.clearCaches()
    return false
  }

  roomFor(terminal) {
    const id = roomIdOfTerminal(terminal)
    const room = id === null ? undefined : this.rt.roomOf(id)
    return room?.id === id ? room : undefined
  }

  who(botId) {
    const bot = this.rt.botOf(botId)
    if (bot === undefined) return { name: undefined, registryId: null }
    return { name: bot.name, registryId: this.reader.registryIdOf(placedBot(this.rt, this.reader.places(), bot)) ?? null }
  }

  consent(room, history) {
    if (!room.members.some(id => this.rt.botOf(id) !== undefined)) return 'not-shown'
    if (!history?.ok || room.legacyUnproven === true) return 'unavailable'
    const places = this.reader.places()
    for (const id of new Set([...room.members, ...history.speakers])) {
      const bot = this.rt.botOf(id)
      if (bot === undefined || this.reader.shown(placedBot(this.rt, places, bot)) !== true) return 'not-shown'
    }
    if (room.scoped === true || room.workDir !== undefined || Object.keys(room.memberDirs ?? {}).length > 0
      || room.permission !== undefined || history.folderNotice) return 'not-shown'
  }

  loadedMembers(room) {
    const loaded = new Map(this.rt.ctx.sessions.list().map(session => [session.id, session]))
    return room.members.flatMap((id) => {
      const sid = room.sessions?.[id]
      const session = loaded.get(sid)
      return session === undefined ? [] : [{ bot: this.rt.botOf(id), sid, session }]
    })
  }

  roomReason(room, gen) {
    if (!this.current(gen)) return 'unavailable'
    if (this.rt.roomOf(room.id) !== room) return 'deleted'
  }

  async eligible(room, gen = this.syncGeneration()) {
    await this.rt.load()
    if (this.rt.roomOf(room.id) !== room) return 'deleted'
    if (!this.current(gen)) return 'unavailable'
    if (!room.members.some(id => this.rt.botOf(id) !== undefined)) return 'not-shown'
    const history = await this.rt.roomHistory(room)
    const changed = this.roomReason(room, gen)
    if (changed !== undefined) return changed
    if (history.gone) return 'deleted'
    this.histories.set(room.id, { room, history })
    const reason = this.consent(room, history)
    if (reason !== undefined) return reason
    let verdicts
    try {
      verdicts = await Promise.all(this.loadedMembers(room).map(async ({ bot, sid, session }) => {
        if (this.rt.groupMemberHolds(sid, bot) !== true) return { sid, ok: false }
        const reported = this.rt.reportedFolder(session)
        const own = bot.workDir ?? this.rt.teamFolder()
        const ok = typeof reported === 'string' && typeof own === 'string' && await Promise.all([realpath(reported), realpath(own)])
          .then(([inner, outer]) => within(inner, outer), () => false)
        return { sid, reported, own, ok }
      }))
    } catch {
      return 'unavailable'
    }
    const stale = this.roomReason(room, gen)
    if (stale !== undefined) return stale
    for (const verdict of verdicts) this.folders.set(verdict.sid, verdict)
    return this.eligibleNow(room, gen)
  }

  eligibleNow(roomOrId, gen = this.syncGeneration()) {
    const room = typeof roomOrId === 'string' ? this.roomFor(roomTerminalOf(roomOrId)) : roomOrId
    if (room === undefined) return 'deleted'
    const entry = this.histories.get(room.id)
    const reason = this.roomReason(room, gen) ?? this.consent(room, entry?.room === room ? entry.history : undefined)
    if (reason !== undefined) return reason
    try {
      for (const { bot, sid, session } of this.loadedMembers(room)) {
        const proven = this.folders.get(sid)
        if (this.rt.groupMemberHolds(sid, bot) !== true || !proven?.ok
          || proven.reported !== this.rt.reportedFolder(session) || proven.own !== (bot.workDir ?? this.rt.teamFolder())) return 'unavailable'
      }
    } catch {
      return 'unavailable'
    }
  }

  async eligibleRoomIds(gen) {
    await this.rt.load()
    if (!this.current(gen)) return []
    const rooms = Object.values(this.rt.state?.rooms ?? {})
    const results = await Promise.all(rooms.map(room => this.eligible(room, gen)))
    return rooms.filter((_room, index) => results[index] === undefined).map(room => room.id)
  }

  rowsNow(ids) {
    const entries = this.rt.approvalsView()
    return ids.flatMap((id) => {
      const room = this.roomFor(roomTerminalOf(id))
      if (this.eligibleNow(room) !== undefined) return []
      return [{
        terminal: roomTerminalOf(id), machine: null, agent: 'dsh', chat: 'group', title: room.name ?? '',
        members: room.members.map(id => this.who(id)), status: this.statusOf(room, entries),
        approvals: this.cardsOf(room, entries).length, shown: true,
      }]
    })
  }

  statusOf(room, entries = this.rt.approvalsView()) {
    if (entries.some(entry => entry.roomId === room.id)) return { state: 'blocked', kind: 'permission', msg: '', turn: 0 }
    const working = this.rt.roomActive(room.id) || (this.rt.roomWorkView()[room.id]?.length ?? 0) > 0
    return { state: working ? 'working' : 'idle', kind: null, msg: '', turn: 0 }
  }

  phoneAnswerable(entry, room) {
    const owner = this.rt.groupOwners.get(entry.sessionId)
    return entry.roomId === room.id && entry.child !== true && this.rt.isFolderApproval(entry.id) !== true
      && entry.answerable === true && room.members.includes(entry.botId) && room.sessions?.[entry.botId] === entry.sessionId
      && owner?.roomId === room.id && owner.botId === entry.botId && this.rt.groupAskCurrent(entry.id, room) === true
      && this.eligibleNow(room) === undefined
  }

  seedApprovals() {
    this.pending.clear()
    for (const entry of this.rt.approvalsView()) if (entry.roomId !== undefined) this.pending.set(entry.id, entry)
  }

  cardsOf(room, entries) {
    const rows = []
    for (const entry of entries) {
      if (!this.phoneAnswerable(entry, room)) continue
      this.pending.set(entry.id, entry)
      if (!this.cards.has(entry.id)) this.cards.set(entry.id, { room, entry, at: Date.now() })
      rows.push(approvalCardOf(entry, id => this.who(id)))
    }
    return rows
  }

  roomReceipts(room) {
    const kept = this.receipts.get(room.id)
    return kept?.room === room ? kept.rows : []
  }

  keepReceipt(room, receipt) {
    const rows = [...this.roomReceipts(room), receipt].slice(-RECEIPTS_KEPT)
    this.receipts.delete(room.id)
    this.receipts.set(room.id, { room, rows })
    if (this.receipts.size > RECEIPT_ROOMS) this.receipts.delete(this.receipts.keys().next().value)
  }

  approvalChanged(kind, data) {
    const gen = this.syncGeneration()
    if (!this.current(gen)) return
    let room
    let closed
    let entries = this.rt.approvalsView()
    if (kind === 'open') {
      if (data.roomId === undefined) return
      this.pending.set(data.id, data)
      room = this.rt.roomOf(data.roomId)
      // The open event carries answerable before the handler assigns entry.answer.
      entries = entries.map(entry => entry.id === data.id ? data : entry)
      if (room !== undefined) this.cardsOf(room, [data])
    } else if (kind === 'settled') {
      const pending = this.pending.get(data.id)
      if (pending === undefined) return
      this.pending.delete(data.id)
      const card = this.cards.get(data.id)
      this.cards.delete(data.id)
      room = card?.room ?? this.rt.roomOf(pending.roomId)
      if (card !== undefined && this.rt.roomOf(room.id) === room) {
        const mark = this.marks.get(data.id)
        const outcome = data.outcome === 'allowed-once' ? 'allow' : 'deny'
        const receipt = data.outcome === 'cancelled' ? { id: data.id, by: null, outcome: 'withdrawn', at: data.at }
          : mark !== undefined ? { id: data.id, by: 'phone', ...(mark.name ? { name: mark.name } : {}), outcome, at: data.at }
            : { id: data.id, by: 'computer', outcome, at: data.at }
        this.keepReceipt(room, receipt)
        closed = { ...approvalCardOf(card.entry, id => this.who(id)), open: false, answerable: false, receipt }
      }
    } else return
    for (const watch of this.watches) {
      if (watch.room !== room) continue
      if (closed !== undefined && watch.cards.delete(closed.id)) this.emitTo(watch, { type: 'approval', row: closed })
      this.updateWatch(watch, entries)
    }
  }

  updateWatch(watch, entries = this.rt.approvalsView()) {
    if (!this.stillEligible(watch)) return
    const { room } = watch
    const cards = this.cardsOf(room, entries)
    for (const row of cards) {
      if (watch.cards.has(row.id)) continue
      watch.cards.add(row.id)
      this.emitTo(watch, { type: 'approval', row })
    }
    const status = this.statusOf(room, entries)
    const title = room.name ?? ''
    const key = JSON.stringify([status, cards.length, title])
    if (key === watch.statusKey) return
    watch.statusKey = key
    this.emitTo(watch, { type: 'status', status, approvals: cards.length, title })
  }

  closeWatch(watch) {
    watch.closed = true
    watch.held = []
    watch.events = []
    this.watches.delete(watch)
    if (this.watches.size !== 0 || this.timer === undefined) return
    this.timers.clearInterval(this.timer)
    this.timer = undefined
  }

  gone(watch, reason) {
    if (watch.closed) return
    watch.reason = reason
    this.closeWatch(watch)
    watch.listener({ type: 'gone', reason })
  }

  stillEligible(watch) {
    if (watch.closed) return false
    const reason = this.eligibleNow(watch.room, watch.gen)
    if (reason !== undefined) this.gone(watch, reason)
    return reason === undefined
  }

  emitTo(watch, event) {
    if (!this.stillEligible(watch)) return false
    if (!watch.started && event.type !== 'snapshot') watch.events.push(event)
    else watch.listener(event)
    return !watch.closed
  }

  async recheckAll() {
    if (this.closed) return
    const gen = this.syncGeneration()
    const entries = this.rt.approvalsView()
    const ids = new Set(entries.map(entry => entry.id))
    for (const id of this.pending.keys()) if (!ids.has(id)) this.pending.delete(id)
    for (const cache of [this.histories, this.receipts, this.sends]) {
      for (const [id, { room }] of cache) if (this.rt.roomOf(id) !== room) cache.delete(id)
    }
    for (const [id, { room }] of this.cards) if (this.rt.roomOf(room.id) !== room) this.cards.delete(id)
    const rooms = new Map()
    await Promise.all([...this.watches].map(async (watch) => {
      if (!this.stillTeam(watch)) return
      if (!rooms.has(watch.room)) rooms.set(watch.room, this.eligible(watch.room, gen).catch(() => 'unavailable'))
      const reason = await rooms.get(watch.room)
      if (reason !== undefined) this.gone(watch, reason)
      else this.updateWatch(watch)
    }))
  }

  checkWatches() {
    void this.recheckAll().catch(() => {
      for (const watch of this.watches) this.gone(watch, 'unavailable')
    })
  }

  stillTeam(watch) {
    if (watch.closed) return false
    if (this.current(watch.gen)) return true
    this.gone(watch, 'unavailable')
    return false
  }

  flushLines() {
    const batch = this.queued
    this.queued = []
    for (const { room, record } of batch) {
      for (const watch of this.watches) {
        if (watch.room !== room) continue
        try {
          if (!this.stillEligible(watch) || record.seq <= watch.boundary) continue
          if (!watch.started) watch.held.push(record)
          else {
            this.emitLine(watch, record)
            this.updateWatch(watch)
          }
        } catch {
          this.gone(watch, 'unavailable')
        }
      }
    }
  }

  emitLine(watch, record) {
    const row = projectRecord(record, watch.room.id, id => this.who(id))
    if (row !== undefined) this.emitTo(watch, { type: 'rows', rows: [row] })
  }

  page(room, records, limit = PAGE_ROWS) {
    const rows = []
    for (let at = records.length - 1; at >= 0 && rows.length < limit; at -= 1) {
      const row = projectRecord(records[at], room.id, id => this.who(id))
      if (row !== undefined) rows.push(row)
    }
    return pageOf(rows.reverse(), limit)
  }

  snapshotRows(room, boundary, after) {
    const records = this.rt.ledger.range(bookOf(room), 1, boundary)
    if (after === undefined) return { rows: this.page(room, records), reset: false }
    const cursor = roomCursorOf(after)
    if (cursor?.roomId === room.id && cursor.seq <= boundary
      && this.rt.ledger.record(bookOf(room), cursor.seq) !== undefined) {
      const missed = records.filter(record => record.seq > cursor.seq)
      const rows = this.page(room, missed)
      if (rows.length === missed.length) return { rows, reset: false }
    }
    return { rows: this.page(room, records), reset: true }
  }

  async watch(terminal, listener, { after, gen = this.syncGeneration() } = {}) {
    const room = this.roomFor(terminal)
    if (room === undefined) return { ok: false, reason: 'not-found' }
    const reason = await this.eligible(room, gen)
    if (reason !== undefined) return { ok: false, reason }
    const watch = { room, gen, listener, held: [], events: [], cards: new Set() }
    this.watches.add(watch)
    try {
      watch.boundary = room.seq
      const { rows, reset } = this.snapshotRows(room, watch.boundary, after)
      const entries = this.rt.approvalsView()
      const approvals = this.cardsOf(room, entries)
      const status = this.statusOf(room, entries)
      const title = room.name ?? ''
      watch.statusKey = JSON.stringify([status, approvals.length, title])
      for (const row of approvals) watch.cards.add(row.id)
      const snapshot = { type: 'snapshot', screen: [], status, title, rows, reset, approval: null, approvals, settled: this.roomReceipts(room), held: [] }
      this.timer ??= this.timers.setInterval(() => this.checkWatches(), this.pollMs)
      this.timer?.unref?.()
      return {
        ok: true, group: true,
        get reason() { return watch.reason },
        started: () => {
          if (watch.started || !this.emitTo(watch, snapshot)) return
          watch.started = true
          for (const record of watch.held.sort((a, b) => a.seq - b.seq)) this.emitLine(watch, record)
          for (const event of watch.events) this.emitTo(watch, event)
          watch.held = []
          watch.events = []
          this.updateWatch(watch)
        },
        close: () => this.closeWatch(watch),
        stillEligible: () => this.stillEligible(watch),
        backfill: (before, limit) => this.backfill(watch, before, limit),
        send: args => this.send(watch, args),
        answer: args => this.answer(watch, args),
        interrupt: args => this.interrupt(watch, args),
      }
    } catch (error) {
      this.closeWatch(watch)
      throw error
    }
  }

  async backfill(watch, before, limit) {
    const { room, gen } = watch
    const reason = await this.eligible(room, gen)
    if (reason !== undefined) this.gone(watch, reason)
    if (!this.stillEligible(watch)) return []
    const cursor = roomCursorOf(before)
    if (cursor?.roomId !== room.id) return []
    const count = Number.isFinite(limit) ? Math.min(PAGE_ROWS, Math.max(1, Math.trunc(limit))) : PAGE_ROWS
    return this.page(room, this.rt.ledger.range(bookOf(room), 1, cursor.seq - 1), count)
  }

  mutationReason(watch, mine, proof) {
    if (watch.closed || !mine()) return 'not-watching'
    const reason = proof ?? this.eligibleNow(watch.room, watch.gen)
    if (reason !== undefined) this.gone(watch, reason)
    return writeReason(reason)
  }

  async answer(watch, { row, choice, text, by, phone, mine }) {
    if (text !== undefined || !['allow', 'deny'].includes(choice) || typeof row !== 'string') return refused('invalid')
    const { room, gen } = watch
    const proof = await this.eligible(room, gen)
    const reason = this.mutationReason(watch, mine, proof)
    if (reason !== undefined) return refused(reason)
    const getReceipt = () => this.roomReceipts(room).find(receipt => receipt.id === row)
    const settled = () => {
      const receipt = getReceipt()
      return refused('settled', receipt === undefined ? {} : { receipt })
    }
    if (getReceipt() !== undefined) return settled()
    const entry = this.rt.approvalsView().find(entry => entry.id === row)
    if (entry === undefined) return settled()
    if (!this.phoneAnswerable(entry, room)) return refused('invalid')
    this.marks.set(row, { name: words(by).slice(0, 120), phone: sha256(phone).slice(0, 12) })
    try {
      this.rt.answerApproval(row, choice === 'deny' ? 'reject' : 'allow', 'pocket')
      return { ok: true, state: 'sent' }
    } catch (error) {
      if (error?.code === 'bot/stale') return settled()
      throw error
    } finally {
      this.marks.delete(row)
    }
  }

  async send(watch, { text, id, phone, retry, mine }) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return refused('invalid', { message: 'id' })
    if (typeof text !== 'string') return refused('invalid', { id, message: 'text' })
    if (Buffer.byteLength(text) > SEND_TEXT_MAX) return refused('too-long', { id })
    const cleaned = cleanChatText(text)
    if (!cleaned.ok) return refused('empty', { id })
    if (this.carriesSignInCode(cleaned.text) === true) {
      this.log('pocket chat: a group send carried a sign-in code and was not sent')
      return refused('invalid', { id, message: 'sign-in-code' })
    }
    if (cleaned.text.includes('dsh-session:')) return refused('invalid', { id, message: 'reference' })

    const { room, gen } = watch
    const proof = await this.eligible(room, gen)
    const reason = this.mutationReason(watch, mine, proof)
    if (reason !== undefined) return refused(reason, { id })
    const requestId = `${REQUEST_PREFIX}${sha256(phone).slice(0, 12)}-${id}`
    const remembered = this.sends.get(room.id)
    const sent = remembered?.room === room ? remembered.sent : new Map()
    const prior = sent.get(requestId)
    if (prior?.state === 'pending') return refused('busy', { id })
    if (prior?.state === 'accepted' || this.histories.get(room.id).history.requests.has(requestId)) {
      return { ok: true, state: 'sent', id, repeat: true }
    }
    if (retry === true) return { ok: false, state: 'unknown', reason: 'no-record', id }

    const attempt = { state: 'pending', requestId, sessionId: this.rt.sessionOfRoom(room) }
    sent.set(requestId, attempt)
    if (sent.size > GROUP_SENDS_KEPT) sent.delete(sent.keys().next().value)
    this.sends.set(room.id, { room, sent })
    try {
      await this.rt.sendUser({ sessionId: room.id, content: [{ type: 'text', text: cleaned.text }], requestId })
      attempt.state = 'accepted'
      return { ok: true, state: 'sent', id }
    } catch {
      if (sent.get(requestId) === attempt) sent.delete(requestId)
      this.log('pocket chat: a group send was not accepted')
      return refused('offline', { id })
    }
  }

  async interrupt(watch, { mine }) {
    const { room, gen } = watch
    const proof = await this.eligible(room, gen)
    const reason = this.mutationReason(watch, mine, proof)
    if (reason !== undefined) return refused(reason)
    try {
      await this.rt.stopRoomWork(room.id)
      return { ok: true, state: 'sent' }
    } catch (error) {
      this.log('pocket chat: a group stop failed')
      return { ok: false, state: 'failed', reason: error?.code ?? 'failed' }
    } finally {
      this.rt.goalUserStopped(room.id)
    }
  }
}
