import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TEXT_MAX } from '../src/host/pocket-chat.js'
import { projectRecord, roomRowIdOf } from '../src/host/pocket-groups.js'
import { sha256 } from '../src/host/pocket-attach.js'
import { deferred } from './support/pocket-upload-admission.js'
import { host, phoneArgs, roomSeed, terminal, tick, watch, writeBook } from './support/pocket-groups.js'
import { until } from './until.js'

const user = (text, seq) => ({ who: 'User', text, seq })
const former = { who: 'Reader', botId: 'c', text: 'Earlier', seq: 1 }
const idle = { state: 'idle', kind: null, msg: '', turn: 0 }
const requestId = (phone, id) => `pocket-${sha256(phone).slice(0, 12)}-${id}`
const approvals = events => events.filter(event => event.type === 'approval').map(event => event.row)
const setProject = (h, id) => h.places.set(id, { folder: 'private-project', machine: 'desk' })
const tell = (handle, id, options = {}) => handle.send({ ...phoneArgs, text: '@Writer hello', id, ...options })
const answer = (handle, row, options = {}) => handle.answer({ ...phoneArgs, row, choice: 'allow', ...options })

test('a group lists only when every member and speaker is global or shown, using registry places', async t => {
  const h = await host(t)
  setProject(h, 'b')
  assert.deepEqual(await h.list(), [])
  h.shown.add('private-project')
  assert.deepEqual(await h.list(), [{
    terminal, machine: null, agent: 'dsh', chat: 'group', title: 'Ops',
    members: [{ name: 'Main', registryId: null }, { name: 'Writer', registryId: 'b-b' }],
    status: idle, approvals: 0, shown: true,
  }])
  assert.ok(h.checked.some(bot => bot.id === 'b' && bot.project === 'private-project' && bot.machine === 'desk'))
  h.places.set('c', { folder: 'other-project' })
  h.quote(former)
  assert.deepEqual(await h.list(), [])
  h.places.delete('c')
  assert.equal((await h.list()).length, 1)
  delete h.rt.state.bots.c
  assert.deepEqual(await h.list(), [])
  h.room().members = []
  assert.deepEqual(await h.list(), [])
})

test('each kind of group scope independently hides the room', async t => {
  const h = await host(t, { rooms: {
    r1: roomSeed('r1', { sessions: {} }),
    folder: roomSeed('folder', { workDir: '/example', sessions: {} }),
    override: roomSeed('override', { memberDirs: { b: '/example' }, sessions: {} }),
    cleared: roomSeed('cleared', { memberDirs: { b: null }, sessions: {} }),
    permission: roomSeed('permission', { permission: 'read-only', sessions: {} }),
    past: roomSeed('past', { sessions: {} }),
    empty: roomSeed('empty', { members: [], sessions: {} }),
  } })
  h.quote({ who: 'Omni', kind: 'notice', reason: 'folder', path: '/example' }, h.rt.roomOf('past'))
  for (const [id, field] of [['folder', 'workDir'], ['override', 'memberDirs'], ['cleared', 'memberDirs'], ['permission', 'permission']]) {
    assert.equal(h.rt.roomOf(id).scoped, true)
    delete h.rt.roomOf(id)[field]
  }
  assert.deepEqual((await h.list()).map(row => row.terminal), [terminal])
})

test('first list numbers an untouched legacy room and reconciles a partly filled book', async t => {
  const h = await host(t, {
    rooms: {
      r1: roomSeed('r1', { log: [former], seq: undefined }),
      partial: roomSeed('partial', { log: [former, user('later', 2)], seq: 2, sessions: {} }),
    },
    beforeLoad: home => writeBook(home, 'partial', [user('later', 2)]),
  })
  h.places.set('c', { folder: 'hidden' })
  assert.deepEqual(await h.list(), [])
  assert.equal(h.rt.ledger.record('group-r1', 1).botId, 'c')
  assert.deepEqual(h.rt.roomOf('partial').legacySpeakers, ['c'])
  assert.equal(h.rt.ledger.record('group-partial', 1), undefined)
})

test('unproven legacy histories stay unavailable through desktop reads, tail turnover and restart', async t => {
  const disagree = { kind: 'notice', reason: 'folder', seq: 1, path: '/example' }
  const h = await host(t, {
    rooms: {
      r1: roomSeed(),
      conflict: roomSeed('conflict', { log: [{ ...disagree, reason: 'paused' }], seq: 1, sessions: {} }),
      unknown: roomSeed('unknown', { log: [{ who: 'Writer', text: 'Earlier' }], seq: undefined, sessions: {} }),
      partial: roomSeed('partial', { log: [former, user('later', 2)], seq: 2, sessions: {} }),
    },
    beforeLoad(home) {
      writeBook(home, 'conflict', [disagree], 'group-logs')
      writeBook(home, 'partial', [user('later', 2)])
    },
  })
  for (const id of ['conflict', 'partial']) {
    h.rt.groupRows(id, 1)
    for (let i = 0; i < 61; i += 1) h.quote(user('turnover'), h.rt.roomOf(id))
  }
  await h.rt.save()
  await h.dispose()
  const next = await host(t, { home: h.home })
  next.places.set('c', { folder: 'hidden' })
  assert.equal(await next.source.eligible(next.rt.roomOf('conflict')), 'unavailable')
  assert.equal(await next.source.eligible(next.rt.roomOf('unknown')), 'unavailable')
  assert.equal(await next.source.eligible(next.rt.roomOf('partial')), 'not-shown')
})

test('reclaim reopens a stale book and advances the room boundary before the next append', async t => {
  const h = await host(t)
  h.quote(user('first'))
  await h.rt.ledger.flush()
  assert.equal((await h.list()).length, 1)
  const original = h.room()
  const book = join(h.home, 'ledger', 'group-r1.jsonl')
  const lock = join(h.home, 'state.lock')
  unlinkSync(lock)
  appendFileSync(book, JSON.stringify({ ...former, seq: 2 }) + '\n')
  await h.rt.refresh()
  h.places.set('c', { folder: 'hidden' })
  assert.deepEqual(await h.list(), [])
  assert.equal(h.room(), original)
  h.shown.add('hidden')
  const { events } = await watch(h)
  assert.deepEqual(events[0].rows.map(row => row.text), ['first', 'Earlier'])
  assert.equal(h.quote(user('third')).seq, 3)
})

test('live preset, work folder and path resolution are checked independently', async t => {
  const h = await host(t)
  assert.equal((await h.list()).length, 1)
  h.levels.set('gb', 'full-access')
  assert.equal(await h.source.eligible(h.room()), 'unavailable')
  h.levels.set('gb', 'read-only')
  assert.equal(await h.source.eligible(h.room()), undefined)
  h.folders.set('gb', join(h.workspace, 'missing'))
  assert.equal(await h.source.eligible(h.room()), 'unavailable')
  h.folders.delete('gb')
  delete h.services.permissionPresets
  assert.equal(await h.source.eligible(h.room()), 'unavailable')
  h.loaded.length = 0
  assert.equal(await h.source.eligible(h.room()), undefined)
})

test('an in-flight or failed apply keeps the group unavailable', async t => {
  const h = await host(t)
  h.rt.botOf('b').permission = 'read-only'
  const resolving = deferred()
  const resolveAgent = h.rt.resolveAgent
  h.rt.resolveAgent = async id => { await resolving.promise; return resolveAgent(id) }
  h.services.permissionPresets.set = () => { throw new Error('apply failed') }
  const apply = h.rt.applyPermission(h.rt.botOf('b'), 'gb', h.room()).catch(() => {})
  try {
    assert.equal(await h.source.eligible(h.room()), 'unavailable')
  } finally {
    resolving.resolve()
    await apply
  }
  assert.equal(await h.source.eligible(h.room()), 'unavailable')
})

for (const field of ['reported folder', 'Bot folder', 'team workspace']) {
  test(`a changed ${field} withholds the next live row before a save or poll`, async t => {
    const h = await host(t)
    const { events } = await watch(h)
    if (field === 'reported folder') h.folders.set('gb', h.home)
    if (field === 'Bot folder') h.rt.botOf('b').workDir = h.home
    if (field === 'team workspace') h.workspaceEntry.path = h.home
    h.quote(user('must not go out'))
    await tick()
    assert.deepEqual(events.slice(1), [{ type: 'gone', reason: 'unavailable' }])
  })
}

test('a send or answer re-proves a symlink before mutating', async t => {
  const h = await host(t)
  const outside = join(h.home, 'outside')
  const reported = join(h.home, 'cwd')
  mkdirSync(outside)
  for (const operation of ['send', 'answer']) {
    symlinkSync(h.workspace, reported)
    h.folders.set('gb', reported)
    const { handle } = await watch(h)
    const pending = h.ask()
    const [{ id }] = h.rt.approvalsView()
    unlinkSync(reported)
    symlinkSync(outside, reported)
    const result = await (operation === 'send' ? tell(handle, 'test') : answer(handle, id))
    assert.equal(result.reason, 'unavailable')
    assert.equal(h.prompts.length, 0)
    assert.equal(h.rt.approvalsView()[0].id, id)
    h.rt.answerApproval(id, 'reject')
    assert.equal(await pending, 'rejected')
    unlinkSync(reported)
  }
})

test('part ids are refused and a rename preserves the terminal and updates the title', async t => {
  const h = await host(t)
  h.room().sessionId = 'part'
  h.rt.roomOwners.set('part', 'r1')
  assert.deepEqual(await h.source.watch('dsh:room:part', () => {}), { ok: false, reason: 'not-found' })
  const { events } = await watch(h)
  h.room().name = 'New name'
  await h.rt.save()
  await until(() => events.at(-1).title === 'New name', { poll: tick })
  assert.equal(events.at(-1).title, 'New name')
  assert.equal((await h.list())[0].terminal, terminal)
  delete h.rt.state.rooms.r1
  await h.rt.save()
  await until(() => events.at(-1).type === 'gone', { poll: tick })
  assert.deepEqual(events.at(-1), { type: 'gone', reason: 'deleted' })
})

test('snapshot, backfill and live rows drop media, readings, paths and request ids', async t => {
  const h = await host(t)
  const image = { who: 'Writer', botId: 'b', text: 'Host read /home/x/.dsh/attachments/ab.png',
    caption: 'My caption', images: ['image'], uploads: ['upload'], requestId: 'pocket-example', session: true }
  h.quote(image)
  h.quote({ ...image, caption: undefined })
  h.quote({ who: 'Writer', botId: 'b', text: 'host file note', caption: 'Excerpt', captionCut: true, files: [{}] })
  h.quote({ who: 'Writer', botId: 'b', kind: 'approval' })
  const { handle, events } = await watch(h)
  const earlier = await handle.backfill(roomRowIdOf('r1', 4))
  h.quote(image)
  await tick()
  const rows = events[0].rows
  assert.deepEqual(rows.map(row => row.text ?? row.msg),
    ['My caption\n(1 image on the computer)', '(1 image on the computer)', 'Excerpt\n(1 file on the computer)', 'Writer waited for approval'])
  assert.equal(rows[2].cut, true)
  assert.equal(rows[3].kind, 'status')
  assert.equal(rows.filter(row => row.id === roomRowIdOf('r1', 1)).length, 1)
  assert.deepEqual(earlier, rows.slice(0, 3))
  for (const row of [...rows, ...earlier, ...events.find(event => event.type === 'rows').rows]) {
    assert.doesNotMatch(JSON.stringify(row), /\/home\/x|"(?:images|files|uploads|requestId|caption|captionCut)"/)
  }
})

test('only the allowed notice fields go out and text is cut on a UTF-8 boundary', () => {
  const who = () => ({ name: 'Writer', registryId: 'b-writer' })
  const failed = projectRecord({ seq: 1, kind: 'notice', reason: 'failed', about: 'b', names: ['Writer'], code: 'model', status: 429, message: '/path', detail: 'provider detail' }, 'r1', who)
  assert.equal(failed.msg, 'Writer stopped: its model call failed (model 429)')
  assert.equal(failed.name, 'Writer')
  const folder = projectRecord({ seq: 2, kind: 'notice', reason: 'folder', path: '/secret' }, 'r1', who)
  assert.equal(folder.msg, "The group's folder is gone; its members work in the team workspace")
  assert.equal(folder.name, undefined)
  const long = projectRecord(user('🍀'.repeat(TEXT_MAX), 3), 'r1', who)
  assert.ok(Buffer.byteLength(long.text) <= TEXT_MAX)
  assert.match(long.text, /^🍀+…$/u)
})

test('lines that arrive after the snapshot boundary are held in order, even when a listener throws', async t => {
  const h = await host(t)
  h.lines.add(() => { throw new Error('bad listener') })
  h.quote(user('before'))
  const { handle, events } = await watch(h, { start: false })
  h.quote(user('second'))
  h.quote(user('third'))
  await tick()
  assert.deepEqual(events, [])
  handle.started()
  assert.deepEqual(events.flatMap(event => event.rows ?? []).map(row => row.text), ['before', 'second', 'third'])
})

test('cursor resets on a bad, missing, foreign or too-old id and backfill is exclusive', async t => {
  const h = await host(t)
  for (let i = 0; i < 300; i += 1) {
    if (i === 290) h.room().seq += 1
    h.quote(user(`line ${i}`))
  }
  for (const after of ['not a row', 'dsh:room:another:2', 'dsh:room:r1:302', 'dsh:room:r1:001', 'dsh:room:r1:1', 'dsh:room:r1:291']) {
    const { handle, events } = await watch(h, { after })
    assert.equal(events[0].reset, true)
    assert.equal(events[0].rows.length, 200)
    handle.close()
  }
  const { handle, events } = await watch(h, { after: 'dsh:room:r1:300' })
  assert.equal(events[0].reset, false)
  assert.deepEqual(events[0].rows.map(row => row.id), ['dsh:room:r1:301'])
  assert.deepEqual((await handle.backfill('dsh:room:r1:299', 2)).map(row => row.id), ['dsh:room:r1:297', 'dsh:room:r1:298'])
  assert.deepEqual(await handle.backfill('dsh:room:other:299'), [])
})

test('a missed page over the byte cap resets even under the row cap', async t => {
  const h = await host(t)
  h.quote(user('first'))
  for (let i = 0; i < 19; i += 1) h.quote(user('x'.repeat(TEXT_MAX)))
  const { events } = await watch(h, { after: 'dsh:room:r1:1' })
  assert.equal(events[0].reset, true)
  assert.ok(events[0].rows.length < 19)
})

test('withdrawn consent ends a silent watch on poll and withholds a constructed snapshot', async t => {
  const h = await host(t)
  setProject(h, 'b')
  h.shown.add('private-project')
  const started = await watch(h)
  const queued = await watch(h, { start: false })
  h.shown.clear()
  queued.handle.started()
  assert.deepEqual(queued.events, [{ type: 'gone', reason: 'not-shown' }])
  await h.poll()
  await until(() => started.events.at(-1).type === 'gone', { poll: tick })
  assert.deepEqual(started.events.at(-1), { type: 'gone', reason: 'not-shown' })
})

test('status reflects a round, remaining work and direct and child asks', async t => {
  const h = await host(t)
  const { events } = await watch(h)
  h.rt.roomActive = () => true
  await h.source.recheckAll()
  assert.equal(events.at(-1).status.state, 'working')
  h.rt.roomActive = () => false
  h.rt.roomWorkView = () => ({ r1: [{}] })
  assert.equal((await h.list())[0].status.state, 'working')
  h.rt.roomWorkView = () => ({})
  h.rt.teamOwnerOf = () => ({ kind: 'group', child: true, botId: 'b', roomId: 'r1', sessionId: 'gb' })
  const child = h.ask({}, 'child')
  await h.source.recheckAll()
  assert.equal(events.at(-1).status.state, 'blocked')
  assert.equal(events.at(-1).approvals, 0)
  const direct = h.ask()
  assert.equal(events.at(-1).approvals, 1)
  const entries = h.rt.approvalsView()
  assert.equal((await h.list())[0].approvals, 1)
  for (const { id } of entries) h.rt.answerApproval(id, 'allow')
  assert.equal(await child, 'allowed-once')
  assert.equal(await direct, 'allowed-once')
  assert.equal(events.at(-1).status.state, 'idle')
})

test('two direct cards race independently and both phones see the same winner', async t => {
  const h = await host(t)
  const first = await watch(h)
  const second = await watch(h)
  const one = h.ask({ reason: 'one' })
  const two = h.ask({ reason: 'two' })
  const [a, b] = h.rt.approvalsView()
  assert.deepEqual(approvals(first.events).map(row => row.id), [a.id, b.id])
  let mark
  const settle = h.rt.answerApproval
  h.rt.answerApproval = (...args) => { mark = h.source.marks.get(a.id); return settle(...args) }
  assert.deepEqual(await answer(first.handle, a.id, { choice: 'deny' }), { ok: true, state: 'sent' })
  assert.equal(await one, 'rejected')
  assert.deepEqual(mark, { name: 'Pocket A', phone: sha256('phone-a').slice(0, 12) })
  const [pending] = h.rt.approvalsView()
  assert.equal(pending.id, b.id)
  const late = await answer(second.handle, a.id, { phone: 'phone-b', by: 'B' })
  assert.deepEqual(late.receipt, approvals(first.events).at(-1).receipt)
  assert.equal(late.receipt.name, 'Pocket A')
  assert.equal(late.receipt.outcome, 'deny')
  settle(b.id, 'allow', 'pocket') // A desktop body can claim this client kind.
  assert.equal(await two, 'allowed-once')
  const computer = await answer(first.handle, b.id)
  assert.equal(computer.reason, 'settled')
  assert.equal(computer.receipt.by, 'computer')
  assert.equal(computer.receipt.outcome, 'allow')
})

test('cancellations withdraw, and evicted or restarted receipts claim no winner', async t => {
  const h = await host(t)
  const first = await watch(h)
  const abort = new AbortController()
  const pending = h.ask({ signal: abort.signal })
  const [{ id }] = h.rt.approvalsView()
  abort.abort()
  assert.equal(await pending, 'cancelled')
  assert.deepEqual(approvals(first.events).at(-1).receipt, { id, by: null, outcome: 'withdrawn', at: approvals(first.events).at(-1).receipt.at })
  const member = h.ask()
  h.rt.groupOwners.delete('gb')
  h.rt.cancelApprovals('gb')
  assert.equal(await member, 'cancelled')
  assert.equal(approvals(first.events).at(-1).receipt.outcome, 'withdrawn')
  h.rt.groupOwners.set('gb', { roomId: 'r1', botId: 'b' })
  for (let i = 0; i < 17; i += 1) {
    const done = h.ask()
    h.rt.answerApproval(h.rt.approvalsView()[0].id, 'allow')
    await done
  }
  const next = await watch(h)
  assert.equal(next.events[0].settled.length, 16)
  assert.deepEqual(await answer(first.handle, id), { ok: false, state: 'refused', reason: 'settled' })
  h.source.close()
  const fresh = h.newSource()
  fresh.start()
  const restarted = await watch(h, { source: fresh })
  assert.deepEqual(restarted.events[0].settled, [])
})

test('seeded asks appear as cards, except folder asks and asks admitted by an older team', async t => {
  const h = await host(t, { start: false })
  const direct = h.ask()
  const folder = h.rt.approveFolder({ name: 'bash', agent: h.agentOf('gb') }, { path: h.home, who: { en: 'Writer', zh: 'Writer' } }).catch(error => error)
  await until(() => h.rt.approvalsView().length === 2, { poll: tick })
  const [one, two] = h.rt.approvalsView()
  assert.equal(h.rt.isFolderApproval(one.id), false)
  assert.equal(h.rt.isFolderApproval(two.id), true)
  h.source.start()
  const { handle, events } = await watch(h)
  assert.deepEqual(events[0].approvals.map(row => row.id), [one.id])
  assert.equal((await answer(handle, two.id)).reason, 'invalid')
  h.rt.answerApproval(two.id, 'reject')
  assert.match((await folder).message, /not allowed/)
  assert.equal(approvals(events).length, 0)
  h.rt.state.rooms.r1 = { ...h.room() }
  assert.equal(h.rt.groupAskCurrent(one.id, h.room()), false)
  const renewed = await watch(h)
  assert.deepEqual(renewed.events[0].approvals, [])
  assert.deepEqual(renewed.events[0].settled, [])
  assert.equal(renewed.events[0].status.state, 'blocked')
  h.rt.answerApproval(one.id, 'allow')
  assert.equal(await direct, 'allowed-once')
})

test('consent withdrawn just before settlement releases gone without a closed card', async t => {
  const h = await host(t)
  setProject(h, 'b')
  h.shown.add('private-project')
  const { events } = await watch(h)
  const pending = h.ask()
  const [{ id }] = h.rt.approvalsView()
  h.shown.clear()
  h.rt.answerApproval(id, 'allow')
  assert.equal(await pending, 'allowed-once')
  assert.deepEqual(events.at(-1), { type: 'gone', reason: 'not-shown' })
  assert.equal(approvals(events).length, 1)
})

test('send keys dedupe within a room and on restart from the book across a part move', async t => {
  const h = await host(t)
  h.rt.ensureCapabilities = async () => {}
  const { handle } = await watch(h)
  assert.deepEqual(await tell(handle, 'same'), { ok: true, state: 'sent', id: 'same' })
  assert.deepEqual(h.prompts[0], { requestId: requestId('phone-a', 'same'), sessionId: 'r1', mode: 'queue',
    content: [{ type: 'text', text: '@Writer hello' }] })
  assert.equal((await tell(handle, 'same', { retry: true })).repeat, true)
  assert.equal((await tell(handle, 'same', { phone: 'phone-b' })).state, 'sent')
  assert.notEqual(h.prompts[0].requestId, h.prompts[1].requestId)
  h.quote({ ...user('admitted'), requestId: h.prompts[0].requestId })
  h.room().sessionId = 'part-2'
  await h.rt.save()
  await h.dispose()
  const restarted = await host(t, { home: h.home })
  const fresh = await watch(restarted)
  assert.equal((await tell(fresh.handle, 'same', { retry: true })).repeat, true)
  assert.equal((await tell(fresh.handle, 'same')).repeat, true)
  assert.deepEqual(await tell(fresh.handle, 'missing', { retry: true }), { ok: false, state: 'unknown', reason: 'no-record', id: 'missing' })
  assert.deepEqual(restarted.prompts, [])
})

test('send validates text and ids, holds pending attempts, and forgets failures', async t => {
  const h = await host(t)
  h.source.carriesSignInCode = text => text === 'secret'
  const { handle } = await watch(h)
  for (const [text, reason] of [[' ', 'empty'], ['dsh-session:ref', 'invalid'], ['secret', 'invalid'], ['ö'.repeat(17_000), 'too-long']]) {
    assert.equal((await tell(handle, 'send', { text })).reason, reason)
  }
  const entered = deferred()
  const fail = deferred()
  h.rt.sendUser = async () => { entered.resolve(); await fail.promise; throw new Error('offline') }
  const first = tell(handle, 'send')
  await entered.promise
  assert.equal((await tell(handle, 'send', { retry: true })).reason, 'busy')
  assert.equal((await tell(handle, 'send')).reason, 'busy')
  fail.resolve()
  assert.equal((await first).reason, 'offline')
  h.rt.sendUser = async () => {}
  assert.equal((await tell(handle, 'send')).state, 'sent')
})

test('Stop parks the goal after errors or a disconnect past its commit point', async t => {
  const h = await host(t)
  const { handle } = await watch(h)
  const entered = deferred()
  const finish = deferred()
  const calls = []
  h.rt.stopRoomWork = async id => {
    calls.push(['stop', id])
    entered.resolve()
    await finish.promise
    throw Object.assign(new Error('/private/path'), { code: 'bot/stop' })
  }
  h.rt.goalUserStopped = id => calls.push(['park', id])
  const stopping = handle.interrupt(phoneArgs)
  await entered.promise
  handle.close()
  finish.resolve()
  assert.deepEqual(await stopping, { ok: false, state: 'failed', reason: 'bot/stop' })
  assert.deepEqual(calls, [['stop', 'r1'], ['park', 'r1']])
})

test('receipts keep the 32 most recently settled rooms and are discarded with a deleted room', async t => {
  const rooms = Object.fromEntries(Array.from({ length: 33 }, (_, index) => {
    const id = `room-${index}`
    return [id, roomSeed(id, { sessions: { b: `member-${index}` } })]
  }))
  const h = await host(t, { rooms })
  assert.equal((await h.list()).length, 33)
  const settled = []
  for (let index = 0; index < 33; index += 1) {
    const ask = h.ask({}, `member-${index}`)
    const [{ id }] = h.rt.approvalsView()
    h.rt.answerApproval(id, 'allow')
    await ask
    settled.push(id)
  }
  for (const [index, expected] of [[0, []], [1, [settled[1]]], [32, [settled[32]]]]) {
    const { events, handle } = await watch(h, { room: `dsh:room:room-${index}` })
    assert.deepEqual(events[0].settled.map(receipt => receipt.id), expected)
    handle.close()
  }
  const original = h.rt.roomOf('room-32')
  delete h.rt.state.rooms['room-32']
  await h.rt.save()
  h.rt.state.rooms['room-32'] = { ...original }
  const fresh = await watch(h, { room: 'dsh:room:room-32' })
  assert.deepEqual(fresh.events[0].settled, [])
})

test('another room’s live card stays pending, and a nameless winner has no receipt name', async t => {
  const h = await host(t, { rooms: { r1: roomSeed(), second: roomSeed('second', { sessions: { b: 'gb2' } }) } })
  const first = await watch(h)
  const second = await watch(h, { room: 'dsh:room:second' })
  const pending = h.ask({}, 'gb2')
  const [{ id }] = h.rt.approvalsView()
  assert.equal((await answer(first.handle, id)).reason, 'invalid')
  assert.equal(h.rt.approvalsView()[0].id, id)
  assert.equal((await answer(second.handle, id, { by: undefined })).state, 'sent')
  assert.equal(await pending, 'allowed-once')
  const receipt = approvals(second.events).at(-1).receipt
  assert.equal(receipt.by, 'phone')
  assert.equal(Object.hasOwn(receipt, 'name'), false)
  assert.equal(approvals(first.events).length, 0)
})

test('a folder ask by itself blocks without a phone card or receipt', async t => {
  const h = await host(t)
  const { events } = await watch(h)
  const folder = h.rt.approveFolder({ name: 'working_directory', agent: h.agentOf('gb') }, { path: h.home, who: { en: 'Writer', zh: 'Writer' } }).catch(error => error)
  await until(() => h.rt.approvalsView().length === 1, { poll: tick })
  const [{ id }] = h.rt.approvalsView()
  assert.equal((await h.list())[0].status.state, 'blocked')
  assert.equal((await h.list())[0].approvals, 0)
  h.rt.answerApproval(id, 'reject')
  await folder
  assert.equal(approvals(events).length, 0)
  assert.deepEqual((await watch(h)).events[0].settled, [])
})

test('approval summaries distinguish calls with one description and different commands', async t => {
  const h = await host(t)
  const { events } = await watch(h)
  h.rt.callDetail = (_session, call) => ({ text: 'Run a command', code: call })
  const asks = ['first', 'second'].map(callId => h.ask({ callId }))
  assert.deepEqual(approvals(events).map(row => row.summary), ['Run a command\nfirst', 'Run a command\nsecond'])
  for (const { id } of h.rt.approvalsView()) h.rt.answerApproval(id, 'reject')
  await Promise.all(asks)
})

test('Stop attempts every member’s subagents and parks an active goal even when nothing runs', async t => {
  const h = await host(t, { rooms: { r1: roomSeed('r1', { sessions: { a: 'ga', b: 'gb' } }) } })
  const { handle } = await watch(h)
  const goal = { status: 'active', idle: false, revision: 3 }
  h.room().goal = goal
  assert.deepEqual(await handle.interrupt(phoneArgs), { ok: true, state: 'sent' })
  assert.deepEqual([goal.idle, goal.revision], [true, 4])
  goal.idle = false
  const calls = []
  h.rt.roomActive = () => true
  h.rt.stopRoomRound = id => { calls.push(id); throw Object.assign(new Error('round failed'), { code: 'round-failed' }) }
  h.rt.hasSubagents = () => true
  h.rt.stopSubagents = async id => { calls.push(id) }
  assert.deepEqual(await handle.interrupt(phoneArgs), { ok: false, state: 'failed', reason: 'round-failed' })
  assert.deepEqual(calls, ['r1', 'ga', 'gb'])
  assert.deepEqual([goal.idle, goal.revision], [true, 5])
})

test('an ask settled while its room was never eligible leaves no receipt', async t => {
  const h = await host(t)
  setProject(h, 'b')
  assert.deepEqual(await h.list(), [])
  const pending = h.ask()
  const [{ id }] = h.rt.approvalsView()
  h.rt.answerApproval(id, 'allow')
  await pending
  h.shown.add('private-project')
  const { handle, events } = await watch(h)
  assert.deepEqual(events[0].settled, [])
  assert.deepEqual(await answer(handle, id), { ok: false, state: 'refused', reason: 'settled' })
})

test('concurrent answers keep one outcome and one receipt', async t => {
  const h = await host(t)
  const one = await watch(h)
  const two = await watch(h)
  const ask = h.ask()
  const [{ id }] = h.rt.approvalsView()
  const candidates = [
    { handle: one.handle, phone: 'phone-a', by: 'Pocket A', choice: 'allow', outcome: 'allowed-once' },
    { handle: two.handle, phone: 'phone-b', by: 'Pocket B', choice: 'deny', outcome: 'rejected' },
  ]
  const results = await Promise.all(candidates.map(({ handle, phone, by, choice }) => answer(handle, id, { phone, by, choice })))
  const winner = results.findIndex(result => result.state === 'sent')
  assert.ok(winner >= 0)
  const lost = results[1 - winner]
  assert.equal(lost.reason, 'settled')
  assert.equal(lost.receipt.by, 'phone')
  assert.equal(lost.receipt.name, candidates[winner].by)
  assert.equal(await ask, candidates[winner].outcome)
  assert.deepEqual(approvals(one.events).at(-1).receipt, lost.receipt)
  assert.deepEqual(approvals(two.events).at(-1).receipt, lost.receipt)
})
