import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LONG_HEAD, MESSAGE_INLINE_MAX } from '../src/host/constants.js'
import { sha256 } from '../src/host/pocket-attach.js'
import { fakeAttachments } from './fake-ctx.js'
import { host, phoneArgs, readState, roomSeed, tick, watch, writeBook } from './support/pocket-groups.js'
import { until } from './until.js'

const person = (text, seq) => ({ who: 'User', text, seq })
const waitFor = check => until(check, { poll: tick })

test('group folder and permission changes mark scope for good even during an open ask', async t => {
  const h = await host(t, { rooms: { r1: roomSeed(), r2: roomSeed('r2', { sessions: {} }) } })
  const outside = mkdtempSync(join(tmpdir(), 'pgrp-folder-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const { events } = await watch(h)
  const pending = h.ask()
  const [{ id }] = h.rt.approvalsView()
  h.rt.followFolder = async () => {}
  await h.rt.updateRoom('r1', { workDir: outside })
  await h.rt.updateRoom('r1', { workDir: '' })
  await waitFor(() => events.at(-1).type === 'gone')
  assert.deepEqual(events.at(-1), { type: 'gone', reason: 'not-shown' })
  assert.equal(h.room().workDir, undefined)
  assert.equal(readState(h.home).rooms.r1.scoped, true)
  assert.equal((await h.list()).some(row => row.terminal === 'dsh:room:r1'), false)
  h.rt.answerApproval(id, 'allow')
  await pending

  const other = h.rt.roomOf('r2')
  await h.rt.updateRoom(other.id, { permission: 'full-access' })
  await h.rt.updateRoom(other.id, { permission: null })
  assert.equal(other.permission, undefined)
  assert.equal(readState(h.home).rooms.r2.scoped, true)
})

test('a failed apply after clearing a permission keeps the previous effective level and scope', async t => {
  const h = await host(t)
  await h.rt.setRoomPermission(h.room(), 'full-access')
  assert.equal(h.levels.get('gb'), 'full-access')
  h.services.permissionPresets.set = () => { throw new Error('apply failed') }
  await h.rt.setRoomPermission(h.room(), null).catch(() => {})
  assert.equal(h.room().permission, undefined)
  assert.equal(h.levels.get('gb'), 'full-access')
  assert.equal(h.rt.groupMemberHolds('gb', h.rt.botOf('b')), false)
  assert.deepEqual(await h.list(), [])
})

test('working_directory marks an override to the team workspace before saving', async t => {
  const h = await host(t)
  const outside = join(h.home, 'bot-work')
  mkdirSync(outside)
  h.rt.botOf('b').workDir = outside
  h.folders.set('gb', outside)
  const result = await (h.ctx.listeners.get('tools/execute').find(fn => fn.toString().includes('room.memberDirs')))({
    name: 'working_directory', arguments: { cd: h.workspace }, agent: h.agentOf('gb'),
  }, () => ({ content: [] }))
  assert.equal(result.isError, undefined)
  assert.deepEqual(h.room().memberDirs, { b: null })
  assert.equal(readState(h.home).rooms.r1.scoped, true)
})

test('upgrade saves active scope and desktop room and approval views omit Pocket marks', async t => {
  const h = await host(t, { rooms: {
    r1: roomSeed('r1', { memberDirs: { b: null }, legacySpeakers: ['c'], legacyUnproven: true }),
    folder: roomSeed('folder', { workDir: '/example', sessions: {} }),
    level: roomSeed('level', { permission: 'read-only', sessions: {} }),
  } })
  for (const room of Object.values(readState(h.home).rooms)) assert.equal(room.scoped, true)
  const base = await h.endpoint('state')
  assert.equal(base.ok, true)
  for (const room of base.value.rooms) {
    assert.equal(Object.hasOwn(room, 'scoped'), false)
    assert.equal(Object.hasOwn(room, 'legacySpeakers'), false)
    assert.equal(Object.hasOwn(room, 'legacyUnproven'), false)
  }
  const pending = h.rt.approveFolder({ name: 'bash', agent: h.agentOf('gb') }, { path: h.home, who: { en: 'Writer', zh: 'Writer' } }).catch(error => error)
  await waitFor(() => h.rt.approvalsView().length === 1)
  const [entry] = h.rt.approvalsView()
  assert.equal(h.rt.isFolderApproval(entry.id), true)
  const view = await h.endpoint('state')
  assert.deepEqual(view.value.rooms, base.value.rooms)
  assert.deepEqual(view.value.work.approvals, [entry])
  assert.equal(Object.keys(entry).some(key => /folder/i.test(key)), false)
  h.rt.answerApproval(entry.id, 'reject')
  await pending
  assert.equal(h.rt.isFolderApproval(entry.id), false)
})

test('two overlapping requests for the same tool keep their identities', async t => {
  const h = await host(t)
  let marked
  const request = h.services.approval.request
  h.services.approval.request = (ask) => {
    marked = ask
    return request(ask)
  }
  const folder = h.rt.approveFolder({ name: 'bash', agent: h.agentOf('gb') }, { path: h.home, who: { en: 'Writer', zh: 'Writer' } }).catch(error => error)
  await waitFor(() => marked !== undefined)
  const ordinary = request({ ...marked })
  const [widen, other] = h.rt.approvalsView()
  assert.equal(h.rt.isFolderAsk(marked), true)
  assert.equal(h.rt.isFolderAsk({ ...marked }), false)
  assert.equal(h.rt.isFolderApproval(widen.id), true)
  assert.equal(h.rt.isFolderApproval(other.id), false)
  for (const { id } of [widen, other]) h.rt.answerApproval(id, 'reject')
  assert.equal(await ordinary, 'rejected')
  await folder
})

test('roomHistory includes new lines at the hook and leaves caption and request ids out of desktop reads and state', async t => {
  const h = await host(t)
  const history = await h.rt.roomHistory(h.room())
  const inside = []
  h.lines.add(() => inside.push([history.speakers, history.requests, history.folderNotice]))
  h.quote({ who: 'User', text: 'caption + reading', caption: 'caption', images: [{}], requestId: 'pocket-record' })
  h.quote({ who: 'Reader', botId: 'c', kind: 'notice', reason: 'folder', path: '/old' })
  assert.deepEqual(inside, [[new Set(), new Set(['pocket-record']), false], [new Set(['c']), new Set(['pocket-record']), true]])
  history.requests.clear()
  assert.ok(history.requests.has('pocket-record'))
  const book = h.rt.ledger.record('group-r1', 1)
  assert.equal(book.caption, 'caption')
  assert.equal(book.requestId, 'pocket-record')
  const desktop = await h.rt.groupLine('r1', 1)
  assert.equal(desktop.text, 'caption + reading')
  await h.rt.save()
  for (const line of [desktop, readState(h.home).rooms.r1.log[0]]) {
    assert.equal(Object.hasOwn(line, 'caption'), false)
    assert.equal(Object.hasOwn(line, 'requestId'), false)
  }
})

test('queued and drained messages both keep their request ids, and images keep only the sender words in caption', async t => {
  const h = await host(t)
  const image = { attachmentId: 'sha256:image', mediaType: 'image/png', width: 1, height: 1 }
  const file = { attachmentId: 'sha256:file', name: 'notes.txt', bytes: 4 }
  h.rt.imagesForGroup = async () => ['Read /home/x/.dsh/attachments/image.png']
  const first = { id: 'message', source: { kind: 'user', rpcId: 'pocket-queued' }, content: [
    { type: 'text', text: 'Pictures and notes' }, { type: 'image', attachment: image }, { type: 'file', attachment: file },
  ] }
  h.emit('r1', 'user/message', first)
  await h.tool('group_relay', {}, 'r1', { callId: 'first-round' })
  await waitFor(() => h.rt.ledger.records('group-r1').some(line => line.requestId === 'pocket-queued'))
  const queued = h.rt.ledger.records('group-r1').find(line => line.requestId === 'pocket-queued')
  assert.equal(queued.caption, 'Pictures and notes')
  assert.match(queued.text, /Read \/home\/x.*\n\[File "notes.txt"/)
  assert.equal(queued.session, true)
  const inbox = h.agentOf('r1').inbox
  const drainedId = `pocket-${sha256(phoneArgs.phone).slice(0, 12)}-drained`
  inbox.nextTurn.push({ id: 'next', source: { kind: 'user', rpcId: drainedId }, content: [{ type: 'text', text: 'Drained' }] })
  await waitFor(() => [...h.rt.roomProgress.values()].some(round => round.nudge))
  h.rt.nudgeRoom('r1')
  await waitFor(() => h.rt.ledger.records('group-r1').some(line => line.requestId === drainedId))
  assert.equal(inbox.nextTurn.length, 0)
  await h.rt.stopRoomRound('r1')
  h.room().sessionId = 'part-2'
  await h.rt.save()
  await h.dispose()
  const next = await host(t, { home: h.home })
  const { handle } = await watch(next)
  assert.ok((await next.rt.roomHistory(next.room())).requests.has(drainedId))
  assert.equal((await handle.send({ ...phoneArgs, id: 'drained', text: 'Drained', retry: true })).repeat, true)
  assert.equal((await handle.send({ ...phoneArgs, id: 'unrecorded', text: 'Drained', retry: true })).state, 'unknown')
})

test('post_to_group keeps the long-post excerpt alongside its file', async t => {
  const h = await host(t)
  h.services.attachments = fakeAttachments()
  const body = 'Long post '.repeat(MESSAGE_INLINE_MAX)
  const result = await h.tool('post_to_group', { group: 'Ops', message: body }, 'a')
  assert.match(result, /^Posted in/)
  const post = h.agentOf('r1').calls.at(-1)
  assert.equal(post.source.excerpt, body.slice(0, LONG_HEAD))
  h.emit('r1', 'user/message', post)
  await h.tool('group_relay', {}, 'r1', { callId: 'long-round' })
  await waitFor(() => h.rt.ledger.records('group-r1').some(line => line.captionCut === true))
  const record = h.rt.ledger.records('group-r1').find(line => line.captionCut)
  assert.equal(record.caption, body.slice(0, LONG_HEAD))
  assert.equal(record.files.length, 1)
  assert.equal(Object.hasOwn(h.room().log.find(line => line.seq === record.seq), 'captionCut'), false)
  await h.rt.stopRoomRound('r1')
})

test('refresh waits for queued writes, keeps an equal-size cache and reopens a larger book', async t => {
  const h = await host(t, { beforeLoad: home => writeBook(home, 'r1', [person('first', 1)]) })
  h.rt.ledger.append('group-r1', person('queued', 2))
  const before = h.rt.ledger.open('group-r1')
  assert.equal(await h.rt.ledger.refresh('group-r1'), true)
  assert.equal(h.rt.ledger.open('group-r1'), before)
  appendFileSync(join(h.home, 'ledger', 'group-r1.jsonl'), JSON.stringify(person('outside', 3)) + '\n')
  assert.equal(await h.rt.ledger.refresh('group-r1'), true)
  assert.notEqual(h.rt.ledger.open('group-r1'), before)
  assert.equal(h.rt.ledger.record('group-r1', 3).text, 'outside')
})

test('refresh reopens a cached missing book after numbering and fails closed on a stat error', async t => {
  const h = await host(t, { rooms: { r1: roomSeed('r1', { log: [{ who: 'User', text: 'before' }], seq: undefined }) } })
  assert.equal(h.rt.ledger.open('group-r1').size, -1)
  assert.equal((await h.rt.roomHistory(h.room())).ok, true)
  assert.equal(h.rt.ledger.record('group-r1', 1).text, 'before')
  const ledgerPath = join(h.home, 'ledger')
  unlinkSync(join(ledgerPath, 'group-r1.jsonl'))
  rmdirSync(ledgerPath)
  writeFileSync(ledgerPath, 'a file in place of a folder')
  assert.equal(await h.rt.ledger.refresh('group-r1'), false)
})

test('desktop reads durably reconcile a speaker absent from a partial book', async t => {
  const h = await host(t, {
    rooms: { r1: roomSeed('r1', { log: [{ botId: 'c', who: 'Reader', text: 'Earlier', seq: 1 }, person('later', 2)], seq: 2 }) },
    beforeLoad: home => writeBook(home, 'r1', [person('later', 2)]),
  })
  h.rt.groupRows('r1', 1)
  await h.rt.save()
  assert.deepEqual(readState(h.home).rooms.r1.legacySpeakers, ['c'])
  assert.deepEqual((await h.endpoint('state')).value.rooms.map(room => room.legacySpeakers), [undefined])
})

test('an adopt keeps the old approval on the computer and only new asks are current', async t => {
  const h = await host(t)
  const older = h.ask()
  const [{ id: old }] = h.rt.approvalsView()
  assert.equal(h.rt.groupAskCurrent(old, h.room()), true)
  const state = readState(h.home)
  state.rooms.r1.name = 'Adopted'
  writeFileSync(join(h.home, 'state.json'), JSON.stringify(state))
  unlinkSync(join(h.home, 'state.lock'))
  await h.rt.refresh()
  assert.equal(h.room().name, 'Adopted')
  assert.equal(h.rt.groupAskCurrent(old, h.room()), false)
  const newer = h.ask()
  const [, { id: current }] = h.rt.approvalsView()
  assert.equal(h.rt.groupAskCurrent(current, h.room()), true)
  for (const id of [old, current]) h.rt.answerApproval(id, 'allow')
  assert.deepEqual(await Promise.all([older, newer]), ['allowed-once', 'allowed-once'])
})
