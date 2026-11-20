import assert from 'node:assert/strict'
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { HISTORY_TIMEOUT_MS } from '../src/host/constants.js'
import { RESUME_DELAY_MS } from '../src/host/resume.js'
import { io } from '../src/host/wake-log.js'
import { immediate, until } from './until.js'
import { crashCopy, durableDsh, userMessages } from './wake-dsh.js'

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR
const outcome = { status: 'done', endedAt: 1000, summary: 'Saved outcome' }
const task = from => ({ from, title: 'Check the draft', status: 'working', startedAt: 1 })
const group = (id, name, sessions) => ({ id, name, members: ['a', 'b'], admin: 'a', mode: 'admin', named: true, sessions, log: [], seq: 0, seen: {} })
const seed = () => ({
  version: 1, mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: group('r1', 'Ops', { a: 'ga', b: 'gb' }), r2: group('r2', 'Design', { a: 'da', b: 'db' }) },
  tasks: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})
const newDsh = () => {
  const dsh = durableDsh({ pageSize: 4 })
  for (const id of ['a', 'b', 'ga', 'gb', 'da', 'db', 'r1', 'r2', 't1', 't2']) dsh.add(id)
  return dsh
}
const taskFields = (id = 'report', taskSessionId = 't1', botId = 'a', sessionId = botId) => ({
  id, kind: 'task-report', botId, key: `task:${taskSessionId}`, sessionId,
  report: { role: 'task-done', note: 'Check the draft', text: 'Report body', taskSessionId }, outcome,
})
const groupFields = (id = 'group-report') => ({
  id, kind: 'group-report', botId: 'a', key: `group:r2:${id}`,
  sessionId: 'ga', roomId: 'r2', returnRoomId: 'r1',
  report: { role: 'report', note: 'Design', text: 'Report body' },
})
const record = (id, event, fields, at = Date.now()) => ({ v: 1, id, at, event, ...fields })
const intent = (fields = taskFields(), at = Date.now()) => record(fields.id, 'intent', fields, at)
const json = (home, name) => JSON.parse(readFileSync(join(home, name), 'utf8'))
const notesOnDisk = (home) => {
  try { return json(home, 'inflight.json') } catch { return { queued: {}, turns: {} } }
}
const saveJson = (home, name, value) => writeFileSync(join(home, name), JSON.stringify(value))
const fileOf = home => join(home, 'wake.jsonl')
const bodyOf = home => existsSync(fileOf(home)) ? readFileSync(fileOf(home), 'utf8') : ''
const lines = home => bodyOf(home).split('\n').flatMap(line => {
  try { return [JSON.parse(line)] } catch { return [] }
})
const writeLines = (home, records) => writeFileSync(fileOf(home), records.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') + '\n')
const reportLines = (host, id = 'report') => lines(host.home).filter(item => item.id === id)
const events = (host, id) => reportLines(host, id).map(item => item.event)
const terminal = (host, id = 'report') => reportLines(host, id).find(item => item.event === 'done' || item.event === 'dropped')
const settle = check => until(check, { poll: immediate, ms: 5000 })
const textOf = delivery => delivery.message.content[0].text
const diagnostic = host => host.notes.filter(note => note.source === 'wake')
const error = code => Object.assign(new Error(code), { code })
const startup = (t, extra = []) => t.mock.timers.enable({ apis: ['setTimeout', ...extra] })
const note = (id, { wake = true, toId = 'a', role = 'task-done' } = {}) => ({
  at: Date.now(), args: { toId, role, note: 'Check the draft', text: 'Legacy report', exchangeId: id, ...(wake ? { wake } : {}) },
})
const writeNotes = (home, queued, turns = {}) => saveJson(home, 'inflight.json', { queued, turns })

const hosts = new Map()
function homeFor(t, state = seed()) {
  const home = mkdtempSync(join(tmpdir(), 'wake-test-'))
  saveJson(home, 'state.json', state)
  t.after(async () => {
    await hosts.get(home)?.stop()
    rmSync(home, { recursive: true, force: true })
  })
  return home
}
async function start(t, { home = homeFor(t), dsh = newDsh() } = {}) {
  apply(dsh.ctx, { home, diagnosticsFile: false, github: false })
  const rt = dsh.ctx.provided.get('omniTeam')
  const notes = []
  const original = rt.noteFailure
  rt.noteFailure = (entry) => { notes.push(entry); original(entry) }
  const stop = () => dsh.ctx.dispose()
  const host = { home, dsh, rt, notes, stop }
  hosts.set(home, host)
  t.after(() => hosts.delete(home))
  await rt.load()
  return host
}
async function restart(t, host) {
  const home = crashCopy(host.home)
  t.after(async () => {
    await hosts.get(home)?.stop()
    rmSync(home, { recursive: true, force: true })
  })
  const next = await start(t, { home, dsh: host.dsh.crash() })
  await host.stop()
  return next
}
const runReplay = async (t, host) => {
  t.mock.timers.tick(RESUME_DELAY_MS)
  await host.rt.resumesDone
  await host.rt.wakeLog.replayed
}
const endTask = (host, id = 't1', text = 'Finished checking') => {
  if (text) host.dsh.emit(id, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
  host.dsh.emit(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
}
const endTaken = async (host, id, session = 'a') => {
  host.dsh.take(session)
  await settle(() => terminal(host, id)?.how === 'taken')
}
function taskHome(t, ids = ['t1']) {
  const state = seed()
  for (const id of ids) state.tasks[id] = task('a')
  return homeFor(t, state)
}

test('1a: a task saved after the intent but before dispatch is recovered once', async (t) => {
  startup(t)
  const first = await start(t, { home: taskHome(t) })
  first.dsh.hang('a')
  endTask(first)
  const [entry] = lines(first.home)
  assert.equal(entry.event, 'intent')
  if (process.platform !== 'win32') assert.equal(statSync(fileOf(first.home)).mode & 0o777, 0o600)
  await settle(() => json(first.home, 'state.json').tasks.t1.status === 'done')

  const second = await restart(t, first)
  await runReplay(t, second)
  assert.deepEqual(second.dsh.sends.map(({ sessionId, exchangeId }) => [sessionId, exchangeId]), [['a', entry.id]])
  assert.match(textOf(second.dsh.sends[0]), /^\[Task "Check the draft" finished · DeepSeek Harness restarted before this report could reach you/)
  assert.deepEqual(events(second, entry.id), ['intent', 'attempt', 'sent'])
  await endTaken(second, entry.id)

  const third = await restart(t, second)
  await runReplay(t, third)
  assert.deepEqual(third.dsh.sends, [])
  third.dsh.drain()
  assert.equal(userMessages(third.dsh, entry.id), 1)
})

for (const byLiveListener of [false, true]) {
  test(`1${byLiveListener ? 'c' : 'b'}: repair reaches state.json before the taken record`, async (t) => {
    startup(t)
    const home = taskHome(t)
    writeLines(home, [intent()])
    const dsh = newDsh()
    if (byLiveListener) {
      dsh.queue('a', 'report')
      dsh.persist('a')
    }
    const write = io.writeSync
    let atDone
    t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
      if (bytes.toString().includes('"event":"done"')) atDone = json(home, 'state.json').tasks.t1
      return write(fd, bytes, ...args)
    })
    const host = await start(t, { home, dsh })
    if (byLiveListener) dsh.take('a')
    await runReplay(t, host)
    if (!byLiveListener) await endTaken(host, 'report')
    else assert.deepEqual(dsh.sends, [])
    assert.equal(terminal(host).how, 'taken')
    for (const key of Object.keys(outcome)) assert.equal(atDone[key], outcome[key])
  })
}

test('2: a retained inbox message wakes in place and preserves unrelated messages and notes', async (t) => {
  startup(t)
  const first = await start(t, { home: taskHome(t) })
  endTask(first)
  await settle(() => first.dsh.sends.length === 1)
  const delivered = first.dsh.sends[0]
  first.dsh.queue('a', 'related-step', { target: 'next-step', role: 'request' })
  first.dsh.queue('a', 'legacy-reply', { role: 'reply' })
  first.dsh.persist('a')
  const pending = first.rt.unreadOf('a')
  assert.equal(pending[0].wake, true)
  await settle(() => existsSync(join(first.home, 'inflight.json')))
  await first.stop()
  writeNotes(first.home, { a: [...pending.map(args => ({ at: Date.now(), args })),
    note('related-step', { wake: false, role: 'request' }), note('legacy-reply', { wake: false, role: 'reply' })] })
  const second = await restart(t, first)
  await runReplay(t, second)
  assert.deepEqual(events(second, delivered.exchangeId), ['intent', 'sent'])
  assert.deepEqual(second.dsh.sends.map(({ id, target, wake }) => [id, target, wake]), [[delivered.id, 'next-turn', true]])
  const { nextStep, nextTurn } = second.dsh.agentOf('a').inbox
  assert.deepEqual(nextStep.map(m => m.source.exchangeId), ['related-step'])
  assert.deepEqual(nextTurn.map(m => m.source.exchangeId), ['legacy-reply', delivered.exchangeId])
  assert.equal(second.rt.deliveryNote('legacy-reply').marked, false)
  assert.equal(second.rt.deliveryNote('related-step').marked, false)
  const persisted = (notesOnDisk(second.home).queued.a ?? []).map(({ args }) => args.exchangeId)
  assert.ok(persisted.includes('legacy-reply') && persisted.includes('related-step'))
  second.dsh.drain()
  await settle(() => terminal(second, delivered.exchangeId)?.how === 'taken')
  assert.equal(userMessages(second.dsh, delivered.exchangeId), 1)
})

test('3: a crash before the batch is durable retries each report once, with one wake', async (t) => {
  startup(t)
  const first = await start(t, { home: taskHome(t, ['t1', 't2']) })
  first.dsh.hang('a')
  endTask(first, 't1')
  endTask(first, 't2')
  const ids = lines(first.home).map(entry => entry.id)
  const second = await restart(t, first)
  second.dsh.flushMode('a', 'false')
  await runReplay(t, second)
  assert.deepEqual(second.dsh.sends.map(({ exchangeId, target, wake }) => [exchangeId, target, wake]),
    [[ids[0], 'next-step', false], [ids[1], 'next-turn', true]])
  for (const id of ids) assert.equal(events(second, id).filter(event => event === 'attempt').length, 1)
  const third = await restart(t, second)
  await runReplay(t, third)
  assert.deepEqual(third.dsh.sends.map(({ exchangeId }) => exchangeId), ids)
  for (const id of ids) assert.equal(events(third, id).filter(event => event === 'attempt').length, 2)
  third.dsh.drain()
  for (const id of ids) {
    await settle(() => terminal(third, id)?.how === 'taken')
    assert.equal(userMessages(third.dsh, id), 1)
  }
})

function waitingWork(state) {
  state.works = {
    parent: { id: 'parent', from: 'b', to: 'a', open: ['child'], results: [{ id: 'child', name: 'Design', text: 'Saved reply' }] },
  }
  const fields = groupFields('report')
  return { ...fields, sub: 'child', report: { ...fields.report, work: 'parent', replyTo: 'child' } }
}

test('3b: two attempts drop the report, clear its marked note and settle the work', async (t) => {
  startup(t)
  const state = seed()
  const fields = waitingWork(state)
  const home = homeFor(t, state)
  writeLines(home, [intent(fields), record('report', 'attempt', { sessionId: 'ga' }), record('report', 'attempt', { sessionId: 'ga' })])
  writeNotes(home, { ga: [note('report')] })
  const host = await start(t, { home })
  await runReplay(t, host)
  assert.equal(terminal(host).reason, 'attempts')
  assert.equal(host.rt.deliveryNote('report'), undefined)
  assert.equal(host.rt.state.works.parent.results[0].failed, true)
  assert.deepEqual(host.rt.state.works.parent.open, [])
  assert.equal(diagnostic(host).length, 1)
  assert.match(diagnostic(host)[0].text, /was dropped \(attempts\)/)
  assert.doesNotMatch(diagnostic(host)[0].text, /Report body/)
})

test('3c: the last successful attempt reservation wakes the destination', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent(), intent(taskFields('second', 't2'))])
  const sync = io.fsyncSync
  const write = io.writeSync
  let failFd
  t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
    if (bytes.toString().includes('"id":"second"') && bytes.toString().includes('"event":"attempt"')) failFd = fd
    return write(fd, bytes, ...args)
  })
  t.mock.method(io, 'fsyncSync', (fd) => {
    if (failFd === fd) { failFd = undefined; throw error('ENOSPC') }
    return sync(fd)
  })
  const host = await start(t, { home })
  await runReplay(t, host)
  assert.deepEqual(host.dsh.sends.map(({ exchangeId, wake }) => [exchangeId, wake]), [['report', true]])
  assert.equal(terminal(host, 'second'), undefined)
})

for (const mode of ['false', 'reject']) {
  test(`4a: a durable receipt beyond page one closes on restart after a ${mode} flush`, async (t) => {
    startup(t)
    const first = await start(t, { home: taskHome(t) })
    endTask(first)
    await settle(() => first.dsh.sends.length === 1)
    const [{ exchangeId }] = first.dsh.sends
    first.dsh.flushMode('a', mode)
    const attempted = Promise.withResolvers()
    const flush = first.dsh.ctx.sessions.flush
    t.mock.method(first.dsh.ctx.sessions, 'flush', async (session) => {
      try { return await flush(session) } finally { attempted.resolve() }
    })
    first.dsh.take('a')
    for (let i = 0; i < 12; i += 1) first.dsh.emit('a', 'assistant/message', {})
    first.dsh.persist('a')
    await attempted.promise
    await immediate()
    assert.equal(terminal(first, exchangeId), undefined)
    const second = await restart(t, first)
    await runReplay(t, second)
    assert.deepEqual(second.dsh.sends, [])
    assert.equal(terminal(second, exchangeId).how, 'taken')
    second.dsh.drain()
    assert.equal(userMessages(second.dsh, exchangeId), 1)
  })
}

test('4a: live uptake closes once and a restart sends nothing', async (t) => {
  startup(t)
  const first = await start(t, { home: taskHome(t) })
  endTask(first)
  await settle(() => first.dsh.sends.length === 1)
  const [{ exchangeId }] = first.dsh.sends
  await endTaken(first, exchangeId)
  const second = await restart(t, first)
  await runReplay(t, second)
  assert.deepEqual(second.dsh.sends, [])
  second.dsh.drain()
  assert.equal(userMessages(second.dsh, exchangeId), 1)
})

test('4a: a claim during the inbox-to-history gap prevents resend or nudge', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent()])
  const dsh = newDsh()
  dsh.queue('a', 'report')
  dsh.persist('a')
  dsh.onFirstRead('a', () => dsh.claim('a'))
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.deepEqual(dsh.sends, [])
  assert.deepEqual(events(host), ['intent'])
  dsh.receive('a')
  await settle(() => terminal(host)?.how === 'taken')
  dsh.drain()
  assert.equal(userMessages(dsh, 'report'), 1)
})

test('4a: replay does not close a receipt observed only in a live Session', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent()])
  const dsh = newDsh()
  dsh.queue('a', 'report')
  dsh.flushMode('a', 'false')
  const host = await start(t, { home, dsh })
  dsh.take('a')
  await runReplay(t, host)
  assert.equal(terminal(host), undefined)
  assert.equal(userMessages(dsh, 'report'), 0)
  assert.deepEqual(dsh.sends, [])
})

for (const taken of [false, true]) {
  test(`4${taken ? 'c' : 'b'}: resume leaves an accounted-for marked note to wake replay`, async (t) => {
    startup(t)
    const home = homeFor(t)
    writeLines(home, [intent()])
    writeNotes(home, { a: [note('report')] })
    const dsh = newDsh()
    if (taken) {
      dsh.queue('a', 'report')
      dsh.take('a')
      dsh.persist('a')
    }
    const host = await start(t, { home, dsh })
    await runReplay(t, host)
    assert.deepEqual((await host.rt.resumesDone).resent, [])
    assert.equal(dsh.sends.length, taken ? 0 : 1)
    if (taken) assert.equal(terminal(host).how, 'taken')
    else assert.deepEqual(events(host), ['intent', 'attempt', 'sent'])
  })
}

test('astra-code2 #6: a marked note for a future wake record is reserved while legacy fallback remains available', async (t) => {
  startup(t)
  const home = homeFor(t)
  const dsh = newDsh()
  dsh.queue('a', 'future')
  dsh.take('a')
  dsh.persist('a')
  const future = record('future', 'intent', { v: 2 })
  writeLines(home, [future])
  writeNotes(home, { a: [note('future')], b: [note('missing', { toId: 'b' })] })
  const host = await start(t, { home, dsh: dsh.crash() })
  await runReplay(t, host)
  assert.deepEqual(host.dsh.sends.map(send => send.exchangeId), ['missing'])
  assert.deepEqual(reportLines(host, 'future'), [future])
  host.dsh.drain()
  assert.equal(userMessages(host.dsh, 'future'), 1)
})

for (const scenario of ['both groups', 'subject gone', 'return gone', 'member Session unset', 'member Session absent']) {
  test(`5: cross-group replay keeps the subject and routes correctly with ${scenario}`, async (t) => {
    startup(t)
    const state = seed()
    const dsh = newDsh()
    if (scenario === 'subject gone') delete state.rooms.r2
    if (scenario === 'return gone') delete state.rooms.r1
    if (scenario === 'member Session unset') delete state.rooms.r1.sessions.a
    if (scenario === 'member Session absent') dsh.state('ga').resolveMissing = dsh.state('ga').historyMissing = true
    if (scenario === 'member Session absent') {
      const projections = dsh.ctx.sessionController.projections
      dsh.ctx.sessionController.projections = (request, signal) => request.sessionId === 'ga' ? null : projections(request, signal)
    }
    const home = homeFor(t, state)
    writeLines(home, [intent(groupFields())])
    const host = await start(t, { home, dsh })
    await runReplay(t, host)
    assert.deepEqual(dsh.sends.map(send => send.sessionId), [scenario === 'both groups' || scenario === 'subject gone' ? 'ga' : 'a'])
    assert.match(textOf(dsh.sends[0]), /^\[Group chat "Design" · replies to your post · DeepSeek Harness restarted before this report could reach you\]/)
  })
}

for (const fault of ['write', 'fsync']) {
  for (const durableReceipt of fault === 'fsync' ? [false, true] : [false]) {
    test(`6: failed intent ${fault} still delivers via the same unmarked id, receipt=${durableReceipt}`, async (t) => {
      startup(t)
      const first = await start(t, { home: taskHome(t) })
      first.dsh.flushMode('a', 'false')
      const write = io.writeSync
      const sync = io.fsyncSync
      let tried
      let failFd
      t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
        const line = bytes.toString().trim()
        if (line.includes('"event":"intent"') && tried === undefined) {
          tried = JSON.parse(line).id
          if (fault === 'write') throw error('ENOSPC')
          failFd = fd
        }
        return write(fd, bytes, ...args)
      })
      t.mock.method(io, 'fsyncSync', (fd) => {
        if (fd === failFd) { failFd = undefined; throw error('ENOSPC') }
        return sync(fd)
      })
      endTask(first)
      await settle(() => first.dsh.sends.length === 1)
      assert.equal(first.dsh.sends[0].exchangeId, tried)
      assert.equal(first.rt.deliveryNote(tried).marked, false)
      assert.equal(diagnostic(first).length, 1)
      await settle(() => notesOnDisk(first.home).queued.a?.[0]?.args.exchangeId === tried)
      if (durableReceipt) {
        first.dsh.take('a')
        first.dsh.persist('a')
        await settle(() => notesOnDisk(first.home).queued.a === undefined && first.rt.deliveryNote(tried) === undefined)
        // Keep the fake's durable receipt but model the coalesced note being gone.
        await first.stop()
        writeNotes(first.home, {})
      }
      const second = await restart(t, first)
      await runReplay(t, second)
      if (durableReceipt) {
        assert.equal(terminal(second, tried)?.how, 'taken')
        assert.deepEqual(second.dsh.sends, [])
      } else {
        assert.deepEqual(second.dsh.sends.map(send => send.exchangeId), [tried])
        assert.deepEqual((await second.rt.resumesDone).resent, ['a'])
        assert.ok(!events(second, tried).includes('attempt'))
      }
      second.dsh.drain()
      assert.equal(userMessages(second.dsh, tried), 1)
    })
  }
}

test('6c: an unreadable path is diagnosed once and the ordinary first send still runs', async (t) => {
  startup(t)
  const home = taskHome(t)
  mkdirSync(fileOf(home))
  const host = await start(t, { home })
  endTask(host)
  await runReplay(t, host)
  assert.equal(host.dsh.sends.length, 1)
  assert.equal(host.rt.deliveryNote(host.dsh.sends[0].exchangeId).marked, false)
  assert.equal(diagnostic(host).length, 1)
  assert.match(diagnostic(host)[0].text, /could not be read/)
  assert.ok(statSync(fileOf(home)).isDirectory())
})

test('an empty team creates no wake log', async (t) => {
  startup(t)
  const host = await start(t)
  await runReplay(t, host)
  assert.equal(existsSync(fileOf(host.home)), false)
})

test('a torn line is delimited before append and malformed lines disappear on rewrite', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeFileSync(fileOf(home), 'not json\n{"v":1,"id":')
  const host = await start(t, { home })
  assert.equal(host.rt.wakeLog.intent(taskFields()), 'written')
  assert.match(bodyOf(home), /\{"v":1,"id":\n\{"v":1,"id":"report"/)
  await runReplay(t, host)
  assert.deepEqual(events(host), ['intent'])
  assert.doesNotMatch(bodyOf(home), /not json|"id":\n/)
})

test('rewrite retains foreign lines verbatim forever and headless lines for seven days', async (t) => {
  startup(t)
  const home = homeFor(t)
  const at = Date.now() - WEEK - HOUR
  const old = intent(taskFields('foreign'), at)
  const future = ` { "v": 2, "id": "foreign", "event": "future", "at": ${at} }  `
  const worker = record('worker', 'intent', { kind: 'worker-report', key: 'future:1' }, at)
  const unknown = record('unknown', 'future', {}, at)
  const recent = record('headless', 'sent', { messageId: 'cut' })
  writeLines(home, [old, future, worker, unknown, recent, record('old-headless', 'sent', {}, at)])
  const host = await start(t, { home })
  await runReplay(t, host)
  assert.equal(bodyOf(home), [old, future, worker, unknown, recent].map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
  assert.deepEqual(host.dsh.sends, [])
})

test('rewrite keeps open records and compacts recent closures to IDs while expiring old ones', async (t) => {
  startup(t)
  const state = seed()
  const fields = waitingWork(state)
  const home = homeFor(t, state)
  const now = Date.now()
  const openRecords = [intent(taskFields('open'), now), record('open', 'sent', { messageId: 'open-message' }, now)]
  const prior = now - WEEK - HOUR
  writeLines(home, [...openRecords, intent(fields), record('report', 'done', { how: 'discarded' }, now),
    intent(taskFields('expired'), prior), record('expired', 'done', { how: 'taken' }, prior)])
  writeNotes(home, { ga: [note('report')] })
  const dsh = newDsh()
  dsh.state('a').historyError = error('EIO')
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.deepEqual(reportLines(host, 'open'), openRecords)
  assert.deepEqual(reportLines(host, 'expired'), [])
  assert.deepEqual(terminal(host), {
    v: 1, id: 'report', at: now, event: 'done', how: 'discarded', key: fields.key, kind: 'group-report',
    botId: 'a', work: 'parent', replyTo: 'child', sub: 'child',
  })
  assert.equal(host.rt.wakeLog.byKey(fields.key).open, false)
  assert.equal(host.rt.deliveryNote('report'), undefined)
  assert.equal(host.rt.state.works.parent.results[0].failed, true)
})

test('short writes are completed before first append returns', async (t) => {
  startup(t)
  const host = await start(t)
  const write = io.writeSync
  let writes = 0
  t.mock.method(io, 'writeSync', (fd, bytes, offset, length) => {
    writes += 1
    return write(fd, bytes, offset, Math.min(7, length))
  })
  assert.equal(host.rt.wakeLog.intent(taskFields()), 'written')
  assert.ok(writes > 1)
  assert.equal(lines(host.home)[0].id, 'report')
})

test('size rewrite includes same-tick appends and removes stale temp files', async (t) => {
  startup(t)
  const host = await start(t)
  await runReplay(t, host)
  const write = io.renameSync
  let renames = 0
  t.mock.method(io, 'renameSync', (...args) => { renames += 1; return write(...args) })
  const large = taskFields('large')
  large.report.text = 'x'.repeat(1024 * 1024)
  writeFileSync(join(host.home, 'wake.jsonl.stale.tmp'), 'stale')
  assert.equal(host.rt.wakeLog.intent(large), 'written')
  assert.equal(host.rt.wakeLog.intent(taskFields('same-tick', 't2')), 'written')
  await settle(() => renames === 1)
  assert.deepEqual(lines(host.home).map(line => line.id), ['large', 'same-tick'])
  assert.ok(!existsSync(join(host.home, 'wake.jsonl.stale.tmp')))
})

test('rename failure removes the temp and appends to the old file until hourly retry', async (t) => {
  startup(t, ['setInterval'])
  const home = homeFor(t)
  writeLines(home, [intent(), 'bad record'])
  const dsh = newDsh()
  dsh.state('a').historyError = error('EIO')
  const rename = io.renameSync
  let attempts = 0
  t.mock.method(io, 'renameSync', (...args) => {
    if (++attempts === 1) throw error('EIO')
    return rename(...args)
  })
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.match(bodyOf(home), /bad record/)
  assert.ok(!readdirSync(home).some(name => /^wake\.jsonl\..*\.tmp$/.test(name)))
  assert.equal(host.rt.wakeLog.intent(taskFields('after-error', 't2')), 'written')
  assert.deepEqual(lines(home).map(line => line.id), ['report', 'after-error'])
  assert.equal(attempts, 1)
  t.mock.timers.tick(HOUR)
  await host.rt.wakeLog.replayed
  assert.equal(attempts, 2)
  assert.doesNotMatch(bodyOf(home), /bad record/)
})

test('folder sync after the rename reports failure without rolling back or retrying', async (t) => {
  startup(t, ['setInterval'])
  const home = homeFor(t)
  writeLines(home, ['invalid', intent()])
  const dsh = newDsh()
  dsh.state('a').historyError = error('EIO')
  const sync = io.fsyncSync
  const rename = io.renameSync
  let renames = 0
  t.mock.method(io, 'renameSync', (...args) => { renames += 1; return rename(...args) })
  t.mock.method(io, 'fsyncSync', fd => {
    if (fstatSync(fd).isDirectory()) throw error('EIO')
    return sync(fd)
  })
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.equal(host.rt.wakeLog.intent(taskFields('after-rename', 't2')), 'written')
  t.mock.timers.tick(HOUR)
  await host.rt.wakeLog.replayed
  assert.equal(renames, 1)
  assert.doesNotMatch(bodyOf(home), /invalid/)
  assert.deepEqual(lines(home).map(line => line.id), ['report', 'after-rename'])
  assert.match(diagnostic(host)[0].text, /folder could not be synced/)
})

test('replace keeps a report open, while withdrawing the last copy closes and settles it', async (t) => {
  startup(t)
  const state = seed()
  const fields = waitingWork(state)
  const home = homeFor(t, state)
  writeLines(home, [intent(fields)])
  writeNotes(home, { ga: [note('report')] })
  const dsh = newDsh()
  const original = dsh.queue('ga', 'report')
  const replacement = { ...original, id: 'replacement' }
  const host = await start(t, { home, dsh })
  const { inbox } = dsh.agentOf('ga')
  const save = host.rt.save
  let requiredSaves = 0
  t.mock.method(host.rt, 'save', (options) => {
    if (options?.required === true) requiredSaves += 1
    return save(options)
  })
  inbox.replace(original.id, replacement)
  await immediate()
  assert.equal(terminal(host), undefined)
  assert.equal(requiredSaves, 0)
  inbox.remove(replacement.id)
  await settle(() => terminal(host)?.how === 'discarded')
  assert.equal(host.rt.deliveryNote('report'), undefined)
  assert.equal(host.rt.state.works.parent.results[0].failed, true)
  assert.deepEqual(host.rt.state.works.parent.open, [])
})

test('astra-code #1: steering and claiming a report during a withdrawal save leaves it recoverable', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent()])
  const dsh = newDsh()
  const message = dsh.queue('a', 'report')
  const first = await start(t, { home, dsh })
  const saved = Promise.withResolvers()
  const save = first.rt.save
  first.rt.save = options => options?.required ? saved.promise : save(options)

  const agent = dsh.agentOf('a')
  assert.equal(agent.inbox.remove(message.id), true)
  agent.steer(message)
  dsh.claim('a')
  dsh.persist('a')
  saved.resolve()
  await immediate()
  assert.deepEqual(events(first), ['intent'])

  const second = await restart(t, first)
  await runReplay(t, second)
  assert.deepEqual(second.dsh.sends.map(send => send.exchangeId), ['report'])
})

for (const location of ['current own chat', 'retained own-chat part']) {
  test(`astra-code #2: replay finds a fallback receipt in the ${location} after a failed moved append`, async (t) => {
    startup(t)
    const state = seed()
    const dsh = newDsh()
    const fields = groupFields('report')
    const began = Date.now() - 100
    if (location === 'retained own-chat part') {
      state.bots.a.sessionId = 'a-next'
      state.bots.a.segments = [{ sessionId: 'a', endedAt: began + 1 }]
      dsh.add('a-next')
    }
    const home = homeFor(t, state) // The return group has a member Session again.
    const message = dsh.queue('a', 'report', { role: 'report' })
    dsh.take('a')
    dsh.persist('a')
    writeLines(home, [intent(fields, began), record('report', 'sent', { messageId: message.id })])
    const host = await start(t, { home, dsh })
    await runReplay(t, host)
    assert.equal(terminal(host)?.how, 'taken')
    assert.deepEqual(dsh.sends, [])
  })
}

test('archiving a return group Session that discards its inbox closes the report as discarded', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent(groupFields('report'))])
  const dsh = newDsh()
  const message = dsh.queue('ga', 'report')
  const { inbox } = dsh.agentOf('ga')
  const host = await start(t, { home, dsh })
  host.rt.dropGroupSession(host.rt.roomOf('r1'), 'a')
  dsh.ctx.workspaceRegistry.archiveSession = async id => { if (id === 'ga') inbox.remove(message.id) }
  await dsh.ctx.workspaceRegistry.archiveSession('ga', { stopActivity: true })
  await settle(() => terminal(host)?.how === 'discarded')
})

test('Bot deletion closes its reports only after the deletion is saved', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent(taskFields('report', 't1', 'b'))])
  const write = io.writeSync
  let rosterAtDone
  t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
    if (bytes.toString().includes('"how":"gone"')) rosterAtDone = json(home, 'state.json').bots
    return write(fd, bytes, ...args)
  })
  const host = await start(t, { home })
  await host.rt.deleteBot('b')
  await settle(() => terminal(host)?.how === 'gone')
  assert.equal(rosterAtDone.b, undefined)
})

test('a Bot removed during the pass stays open while its deletion is in flight', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent(taskFields('first', 't1', 'b')), intent(taskFields('report', 't2', 'b'))])
  const dsh = newDsh()
  dsh.onFirstRead('b', () => { delete host.rt.state.bots.b })
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.equal(terminal(host), undefined)
  assert.equal(terminal(host, 'first'), undefined)
  assert.deepEqual(dsh.sends, [])
})

test('duplicate task completion uses the open intent outcome and writes no second intent', async (t) => {
  startup(t)
  const home = taskHome(t)
  writeLines(home, [intent()])
  const host = await start(t, { home })
  endTask(host, 't1', '')
  assert.equal(host.rt.state.tasks.t1.summary, outcome.summary)
  await settle(() => json(home, 'state.json').tasks.t1.status === 'done')
  assert.equal(json(home, 'state.json').tasks.t1.summary, outcome.summary)
  assert.deepEqual(host.dsh.sends, [])
  assert.deepEqual(events(host), ['intent'])
})

const readerLock = home => saveJson(home, 'state.lock', { pid: process.ppid, host: hostname(), token: 'writer' })
const unlock = home => rmSync(join(home, 'state.lock'))
test('reading host sends unmarked, acquires the log on takeover, and respects the term window', async (t) => {
  startup(t)
  const home = taskHome(t)
  readerLock(home)
  const host = await start(t, { home })
  endTask(host)
  await settle(() => host.dsh.sends.length === 1)
  assert.equal(existsSync(fileOf(home)), false)
  assert.equal(host.rt.deliveryNote(host.dsh.sends[0].exchangeId).marked, false)
  assert.equal(host.rt.wakeLog.intent(taskFields()), 'unowned')
  await runReplay(t, host)
  writeLines(home, [intent(taskFields('takeover', 't2', 'b'))])
  unlock(home)
  await host.rt.refresh()
  await host.rt.wakeLog.replayed
  assert.deepEqual(events(host, 'takeover'), ['intent', 'attempt', 'sent'])
  const term = host.rt.lockTerm
  host.rt.lockTerm = () => term() + 1
  assert.equal(host.rt.wakeLog.intent(taskFields('in-window', 't1')), 'unowned')
  assert.deepEqual(events(host, 'in-window'), [])
  host.rt.lockTerm = term
  await host.rt.refresh()
  assert.equal(host.rt.wakeLog.intent(taskFields('after-window', 't1')), 'written')
})

test('a set-aside team cannot replay or close an open report as gone', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeFileSync(join(home, 'state.json'), '{')
  writeLines(home, [intent()])
  const host = await start(t, { home })
  await runReplay(t, host)
  assert.equal(host.rt.teamLoaded(), false)
  assert.deepEqual(events(host), ['intent'])
  assert.deepEqual(host.dsh.sends, [])
})

test('discard after shutdown writes nothing', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent()])
  const dsh = newDsh()
  const message = dsh.queue('a', 'report')
  const host = await start(t, { home, dsh })
  await host.stop()
  dsh.agentOf('a').inbox.remove(message.id)
  await immediate()
  assert.deepEqual(events(host), ['intent'])
})

test('hourly replay wakes held stale input and leaves unmarked and unreadable reports open', async (t) => {
  startup(t, ['setInterval', 'Date'])
  t.mock.timers.setTime(Date.now())
  const home = homeFor(t)
  const at = Date.now() - WEEK + HOUR / 2
  writeLines(home, [intent(taskFields('held'), at), intent(taskFields('legacy', 't2'), at),
    intent(taskFields('unknown', 't3', 'b'), at)])
  writeNotes(home, { a: [note('legacy', { wake: false })] })
  const dsh = newDsh()
  dsh.queue('a', 'legacy')
  const held = dsh.queue('a', 'held')
  dsh.state('b').historyError = error('EIO')
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  dsh.sends.length = 0
  t.mock.timers.tick(HOUR)
  await host.rt.wakeLog.replayed
  assert.deepEqual(dsh.sends.map(send => send.id), [held.id])
  assert.equal(terminal(host, 'held'), undefined)
  assert.equal(terminal(host, 'legacy'), undefined)
  assert.equal(terminal(host, 'unknown'), undefined)
})

test('Addendum 1: startup skips a pending first send and dispatch rejects a replaced term', async (t) => {
  startup(t)
  const host = await start(t, { home: taskHome(t, ['t1', 't2']) })
  const slow = Promise.withResolvers()
  const capabilities = host.rt.ensureCapabilities
  let pending = true
  host.rt.ensureCapabilities = (id) => {
    if (id !== 'a' || !pending) return capabilities(id)
    pending = false
    return slow.promise
  }
  endTask(host)
  const [entry] = lines(host.home)
  await runReplay(t, host)
  assert.deepEqual(events(host, entry.id), ['intent'])
  assert.deepEqual(host.dsh.sends, [])
  slow.resolve()
  await settle(() => host.dsh.sends.length === 1)
  assert.deepEqual(events(host, entry.id), ['intent', 'sent'])

  const next = Promise.withResolvers()
  host.rt.ensureCapabilities = () => next.promise
  endTask(host, 't2')
  const second = lines(host.home).find(line => line.key === 'task:t2')
  const term = host.rt.lockTerm
  host.rt.lockTerm = () => term() + 1
  next.resolve()
  await immediate()
  assert.equal(host.dsh.sends.length, 1)
  assert.deepEqual(events(host, second.id), ['intent'])
  host.rt.lockTerm = term
})

test('Addendum 2: takeover adopts newer queued and turn notes before writing its resend', async (t) => {
  startup(t)
  const home = homeFor(t)
  readerLock(home)
  writeNotes(home, { b: [note('old', { toId: 'b', wake: false })] })
  const host = await start(t, { home })
  await runReplay(t, host)
  writeLines(home, [intent()])
  const newer = note('newer', { toId: 'b', wake: false, role: 'reply' })
  const newerTurn = { botId: 'b', since: Date.now(), trigger: { kind: 'user' } }
  writeNotes(home, { b: [newer] }, { b: newerTurn })
  unlock(home)
  await host.rt.refresh()
  await host.rt.wakeLog.replayed
  await settle(() => notesOnDisk(home).queued.a?.[0]?.args.exchangeId === 'report')
  const notes = notesOnDisk(home)
  assert.deepEqual(notes.queued.b, [newer])
  assert.deepEqual(notes.turns, { b: newerTurn })
  assert.equal(host.rt.deliveryNote('old'), undefined)
  assert.equal(host.rt.deliveryNote('newer').marked, false)
})

test('astra-code #4: takeover adopts an unmarked task note still waiting on the reading host', async (t) => {
  startup(t)
  const home = taskHome(t)
  readerLock(home)
  const host = await start(t, { home })
  await runReplay(t, host)
  const ready = Promise.withResolvers()
  const ensure = host.rt.ensureCapabilities
  host.rt.ensureCapabilities = id => id === 'a' ? ready.promise : ensure(id)
  try {
    endTask(host)
    const [local] = host.rt.unreadOf('a')
    assert.equal(local.role, 'task-done')
    assert.equal(local.wake, undefined)
    assert.deepEqual(host.dsh.sends, [])
    const newer = note('newer', { toId: 'b', wake: false })
    writeNotes(home, { b: [newer] })
    unlock(home)
    await host.rt.refresh()
    await host.rt.wakeLog.replayed
    assert.deepEqual(host.rt.unreadOf('a'), [local])
    await settle(() => notesOnDisk(home).queued.a?.[0]?.args.exchangeId === local.exchangeId)
    assert.deepEqual(notesOnDisk(home).queued.b, [newer])
    assert.deepEqual(host.dsh.sends, [])
  } finally {
    ready.resolve()
    await settle(() => host.dsh.sends.length === 1)
  }
})

test('astra-code2 #3: early takeover keeps an in-progress reader delivery out of legacy resend', async (t) => {
  startup(t)
  const home = taskHome(t)
  readerLock(home)
  const host = await start(t, { home })
  const ready = Promise.withResolvers()
  const ensure = host.rt.ensureCapabilities
  let pending = true
  host.rt.ensureCapabilities = id => {
    if (id !== 'a' || !pending) return ensure(id)
    pending = false
    return ready.promise
  }
  endTask(host)
  const [local] = host.rt.unreadOf('a')
  assert.equal(local.wake, undefined)
  unlock(home)
  await host.rt.refresh()
  try {
    await runReplay(t, host)
    assert.deepEqual(host.dsh.sends, [])
    await settle(() => notesOnDisk(home).queued.a?.[0]?.args.exchangeId === local.exchangeId)
  } finally {
    ready.resolve()
    await settle(() => host.dsh.sends.some(send => send.exchangeId === local.exchangeId))
  }
  assert.deepEqual(host.dsh.sends.map(send => send.exchangeId), [local.exchangeId])
})

for (const failure of ['unreadable', 'malformed']) {
  test(`astra-code #5: takeover fences replay and note writes when inflight.json is ${failure}`, async (t) => {
    startup(t)
    const home = homeFor(t)
    readerLock(home)
    const host = await start(t, { home })
    await runReplay(t, host)
    const path = join(home, 'inflight.json')
    if (failure === 'unreadable') mkdirSync(path)
    else writeFileSync(path, '{incomplete')
    writeLines(home, [intent()])
    unlock(home)
    await host.rt.refresh()
    await host.rt.wakeLog.replayed
    assert.deepEqual(events(host), ['intent'])
    assert.deepEqual(host.dsh.sends, [])

    await host.rt.deliver(note('new', { wake: false }).args)
    await host.rt.wakeLog.replayed
    if (failure === 'unreadable') {
      assert.ok(statSync(path).isDirectory())
      rmSync(path, { recursive: true })
    } else assert.equal(readFileSync(path, 'utf8'), '{incomplete')
    const unrelated = note('unrelated', { toId: 'b', wake: false })
    const turn = { botId: 'b', since: Date.now() }
    writeNotes(home, { b: [unrelated] }, { b: turn })
    await host.rt.deliver(note('retry', { wake: false }).args)
    await host.rt.wakeLog.replayed
    await settle(() => notesOnDisk(home).queued.a?.[0]?.args.exchangeId === 'new')
    assert.deepEqual(notesOnDisk(home).queued.b, [unrelated])
    assert.deepEqual(notesOnDisk(home).turns, { b: turn })
  })
}

test('astra-code2 #4: the next delivery retries strict adoption and runs the skipped takeover replay', async (t) => {
  startup(t)
  const home = homeFor(t)
  readerLock(home)
  const host = await start(t, { home })
  await runReplay(t, host)
  const path = join(home, 'inflight.json')
  writeFileSync(path, '{incomplete')
  writeLines(home, [intent()])
  unlock(home)
  await host.rt.refresh()
  await host.rt.wakeLog.replayed
  assert.deepEqual(host.dsh.sends, [])
  assert.deepEqual(events(host), ['intent'])
  assert.equal(readFileSync(path, 'utf8'), '{incomplete')

  const previous = note('previous', { toId: 'b', wake: false })
  writeNotes(home, { b: [previous] })
  await host.rt.deliver(note('next', { toId: 'b', wake: false }).args)
  await host.rt.wakeLog.replayed
  assert.deepEqual(events(host), ['intent', 'attempt', 'sent'])
  assert.deepEqual(host.dsh.sends.map(send => send.exchangeId).sort(), ['next', 'report'])
  await settle(() => notesOnDisk(home).queued.b?.some(({ args }) => args.exchangeId === 'next'))
  assert.deepEqual(notesOnDisk(home).queued.b[0], previous)
})

test('astra-code2 #5: takeover applies reader turn starts and ends to the writer’s notes', async (t) => {
  startup(t)
  const home = homeFor(t)
  readerLock(home)
  const host = await start(t, { home })
  await runReplay(t, host)
  const old = { botId: 'a', since: 1 }
  const unrelated = { botId: 'a', roomId: 'r1', since: 2 }
  writeNotes(home, {}, { a: old, ga: unrelated })
  host.dsh.claim('b')
  host.dsh.emit('b', 'turn/start', { turn: 1 })
  host.dsh.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(notesOnDisk(home).turns, { a: old, ga: unrelated })
  unlock(home)
  await host.rt.refresh()
  await host.rt.wakeLog.replayed
  await host.rt.deliver(note('after-takeover', { wake: false }).args)
  await settle(() => notesOnDisk(home).queued.a?.[0]?.args.exchangeId === 'after-takeover')
  const turns = notesOnDisk(home).turns
  assert.equal(turns.b?.botId, 'b')
  assert.equal(turns.b.since, host.dsh.state('b').events.find(event => event.type === 'turn/start').time)
  assert.equal(turns.a, undefined)
  assert.deepEqual(turns.ga, unrelated)
})

for (const recorded of [false, true]) {
  test(`astra-code #6: an old shell-disabled part is checked only if ${recorded ? 'recorded' : 'it could have received the report'}`, async (t) => {
    startup(t)
    const state = seed()
    state.bots.a.shell = false
    state.bots.a.segments = [{ sessionId: 'a-cli', endedAt: 1, shellOffCli: true }]
    const home = homeFor(t, state)
    const records = [intent()]
    if (recorded) records.push(record('report', 'moved', { sessionId: 'a-cli' }))
    writeLines(home, records)
    const dsh = newDsh()
    dsh.add('a-cli')
    const host = await start(t, { home, dsh })
    await runReplay(t, host)
    assert.deepEqual(dsh.sends.map(send => send.exchangeId), recorded ? [] : ['report'])
    assert.equal(terminal(host), undefined)
  })
}

async function pauseGroupReport(t, host) {
  const { rt, dsh } = host
  const waiting = Promise.withResolvers()
  const goalEntered = Promise.withResolvers()
  rt.goalDrive = async () => {
    goalEntered.resolve()
    await waiting.promise
  }
  await rt.postToRoom(rt.roomOf('r2'), rt.botOf('a'), '@Writer Check the draft', { reportBack: true, fromRoomId: 'r1' })
  dsh.take('r2')
  const stop = new AbortController()
  t.after(() => stop.abort())
  const relay = rt.teamTools.find(tool => tool.name === 'group_relay')
  const running = relay.execute({}, { agent: dsh.agentOf('r2'), callId: 'round', signal: stop.signal })
  await settle(() => dsh.agentOf('db').inbox.nextTurn.length > 0)
  dsh.claim('db')
  const { claimed, turn } = dsh.state('db')
  dsh.emit('db', 'turn/start', { turn })
  for (const message of claimed) dsh.emit('db', 'user/message', { content: message.content, source: message.source, turn })
  dsh.emit('db', 'assistant/message', { message: { content: [{ type: 'text', text: 'Draft checked' }] } })
  dsh.emit('db', 'turn/end', { turn, reason: { kind: 'completed' } })
  await goalEntered.promise
  return { waiting, running }
}

test('Addendum 3: group first send rechecks its return Session after the round save', async (t) => {
  startup(t)
  const host = await start(t)
  const { rt, dsh } = host
  const { waiting, running } = await pauseGroupReport(t, host)
  const [{ id, sessionId }] = lines(host.home)
  assert.equal(sessionId, 'ga')
  rt.dropGroupSession(rt.roomOf('r1'), 'a')
  waiting.resolve()
  await running
  await settle(() => events(host, id).includes('sent'))
  assert.deepEqual(reportLines(host, id).filter(line => line.sessionId).map(line => [line.event, line.sessionId]),
    [['intent', 'ga'], ['moved', 'a']])
  assert.deepEqual(dsh.sends.filter(send => send.exchangeId === id).map(send => send.sessionId), ['a'])
})

test('astra-code2 #2: replay finds the receipt in a return group that gained its member Session before first send', async (t) => {
  startup(t)
  const state = seed()
  delete state.rooms.r1.sessions.a
  const first = await start(t, { home: homeFor(t, state) })
  const { rt, dsh } = first
  const write = io.writeSync
  t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
    if (bytes.toString().includes('"event":"moved"')) throw error('ENOSPC')
    return write(fd, bytes, ...args)
  })
  const { waiting, running } = await pauseGroupReport(t, first)
  const [entry] = lines(first.home)
  assert.equal(entry.sessionId, 'a')
  rt.roomOf('r1').sessions.a = 'ga'
  rt.indexSessions()
  waiting.resolve()
  await running
  await settle(() => events(first, entry.id).includes('sent'))
  assert.deepEqual(dsh.sends.filter(send => send.exchangeId === entry.id).map(send => send.sessionId), ['ga'])
  assert.deepEqual(events(first, entry.id), ['intent', 'sent'])

  dsh.flushMode('ga', 'false')
  dsh.take('ga')
  dsh.persist('ga')
  const second = await restart(t, first)
  await runReplay(t, second)
  assert.deepEqual(second.dsh.sends, [])
  assert.equal(terminal(second, entry.id)?.how, 'taken')
  assert.equal(entry.returnRoomId, 'r1')
})

for (const isGroup of [false, true]) {
  test(`Addendum 4: receipt in a retained intermediate ${isGroup ? 'group' : 'own-chat'} part prevents resend after a failed moved record`, async (t) => {
    startup(t)
    const state = seed()
    const fields = isGroup ? groupFields('report') : taskFields()
    const current = isGroup ? 'gc-next' : 'a-next'
    const middle = isGroup ? 'ga-middle' : 'a-middle'
    const dsh = newDsh()
    dsh.add(current)
    dsh.add(middle)
    if (isGroup) {
      state.rooms.r1.sessions.a = current
      state.rooms.r1.segments = { a: [{ sessionId: 'ga', number: 1 }, { sessionId: middle, number: 2 }] }
    } else {
      state.bots.a.sessionId = current
      state.bots.a.segments = [{ sessionId: 'a', number: 1 }, { sessionId: middle, number: 2 }]
    }
    const home = homeFor(t, state)
    writeLines(home, [intent(fields)])
    dsh.queue(middle, 'report')
    dsh.take(middle)
    dsh.persist(middle)
    const host = await start(t, { home, dsh })
    await runReplay(t, host)
    assert.equal(terminal(host)?.how, 'taken')
    assert.deepEqual(dsh.sends, [])
  })
}

for (const source of ['resolveAgent', 'events']) {
  test(`Addendum 5: ${source} not-found needs a null projection to prove absence`, async (t) => {
    startup(t)
    const home = homeFor(t)
    writeLines(home, [intent(groupFields('report'))])
    const dsh = newDsh()
    const s = dsh.state('ga')
    if (source === 'resolveAgent') s.resolveMissing = true
    else s.historyMissing = true
    const host = await start(t, { home, dsh })
    await runReplay(t, host)
    assert.deepEqual(events(host), ['intent'])
    assert.deepEqual(dsh.sends, [])
  })
}

for (const scenario of ['missing intent', 'unreadable log']) {
  test(`Addendum 6: a marked legacy note is recovered with a ${scenario}`, async (t) => {
    startup(t)
    const home = homeFor(t)
    if (scenario === 'unreadable log') mkdirSync(fileOf(home))
    writeNotes(home, { a: [note('report')] })
    const host = await start(t, { home })
    await runReplay(t, host)
    assert.deepEqual((await host.rt.resumesDone).resent, ['a'])
    assert.deepEqual(host.dsh.sends.map(send => send.exchangeId), ['report'])
  })
}

test('Addendum 7: a forwarded claim does not suppress withdrawal of its new copy', async (t) => {
  startup(t)
  const state = seed()
  state.bots.a.sessionId = 'a-next'
  state.bots.a.segments = [{ sessionId: 'a', number: 1 }]
  const home = homeFor(t, state)
  writeLines(home, [intent()])
  const dsh = newDsh()
  dsh.add('a-next')
  dsh.queue('a', 'report')
  const host = await start(t, { home, dsh })
  dsh.claim('a')
  const payload = { agent: dsh.agentOf('a'), messages: dsh.state('a').claimed, turn: 1 }
  const handOn = dsh.ctx.listeners.get('agent/pre-step').find(listener => listener.toString().includes('await forward(past,'))
  await handOn(payload, async () => 'next')
  dsh.release('a')
  const copy = dsh.agentOf('a-next').inbox.nextTurn.find(message => message.source?.exchangeId === 'report')
  assert.ok(copy)
  assert.equal(reportLines(host).find(line => line.event === 'moved').sessionId, 'a-next')
  await runReplay(t, host)
  assert.equal(dsh.sends.filter(send => send.id === copy.id).length, 2, 'the forwarded copy can be nudged')
  assert.ok(dsh.agentOf('a-next').inbox.remove(copy.id))
  await settle(() => terminal(host)?.how === 'discarded')
})

for (const scenario of ['resume', 'resolve', 'idle', 'flush']) {
  test(`Addendum 8: a hung ${scenario} for one destination cannot block another`, async (t) => {
    startup(t)
    const home = homeFor(t)
    const dsh = newDsh()
    writeLines(home, [intent(), intent(taskFields('independent', 't2', 'b'))])
    if (scenario === 'resume') {
      writeNotes(home, { a: [note('legacy', { wake: false })] })
      dsh.hang('a')
    } else if (scenario === 'resolve') {
      dsh.hang('a')
    } else if (scenario === 'idle') {
      dsh.claim('a')
    } else {
      dsh.queue('a', 'report')
      dsh.take('a')
      dsh.flushMode('a', 'hang')
    }
    const host = await start(t, { home, dsh })
    t.mock.timers.tick(RESUME_DELAY_MS)
    await settle(() => dsh.sends.some(send => send.exchangeId === 'independent'))
    assert.deepEqual(dsh.sends.map(send => send.exchangeId), ['independent'])
    t.mock.timers.tick(HISTORY_TIMEOUT_MS)
    await host.rt.wakeLog.replayed
    assert.deepEqual(events(host), ['intent'])
    assert.deepEqual(events(host, 'independent'), ['intent', 'attempt', 'sent'])
  })
}

test('a failed moved append still forwards and replay finds the receipt in the current part', async (t) => {
  startup(t)
  const state = seed()
  state.bots.a.sessionId = 'a-next'
  state.bots.a.segments = [{ sessionId: 'a', number: 1 }]
  state.switching = { a: { botId: 'a' } }
  const dsh = newDsh()
  dsh.add('a-next')
  dsh.queue('a', 'report')
  const home = homeFor(t, state)
  writeLines(home, [intent()])
  const write = io.writeSync
  t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
    if (bytes.toString().includes('"event":"moved"')) throw error('ENOSPC')
    return write(fd, bytes, ...args)
  })
  const first = await start(t, { home, dsh })
  await first.rt.heldBack()
  assert.deepEqual(events(first), ['intent'])
  assert.deepEqual(dsh.sends.map(send => send.sessionId), ['a-next'])
  assert.equal(diagnostic(first).filter(entry => entry.text.includes('could not write moved')).length, 1)
  dsh.flushMode('a-next', 'false')
  dsh.take('a-next')
  dsh.persist('a-next')
  assert.equal(terminal(first), undefined)
  const second = await restart(t, first)
  await runReplay(t, second)
  assert.equal(terminal(second)?.how, 'taken')
  assert.deepEqual(second.dsh.sends, [])
})

test('Addendum 2: a coalesced write queued in the previous term cannot overwrite adopted notes', async (t) => {
  startup(t)
  const host = await start(t)
  await runReplay(t, host)
  const { rt, home } = host
  const slow = Promise.withResolvers()
  rt.ensureCapabilities = () => slow.promise
  const delivered = rt.deliver({ ...note('stale', { wake: false }).args })
  assert.equal(rt.deliveryNote('stale').marked, false)
  // The write is queued on a Promise and has not reached the filesystem yet.
  unlock(home)
  const newer = note('fresh', { toId: 'b', wake: false })
  writeNotes(home, { b: [newer] })
  writeLines(home, [intent(taskFields('takeover', 't2', 'b'))])
  const saving = rt.save()
  slow.resolve()
  await delivered
  await saving
  await rt.wakeLog.replayed
  await settle(() => notesOnDisk(home).queued.b?.some(({ args }) => args.exchangeId === 'takeover'))
  const queue = notesOnDisk(home).queued
  assert.equal(queue.a, undefined)
  assert.ok(queue.b.some(item => item.args.exchangeId === 'fresh'))
  assert.equal(rt.deliveryNote('stale'), undefined)
})

test('a report carrying an active sign-in code is refused before either recovery log records it', async (t) => {
  startup(t)
  const host = await start(t, { home: taskHome(t) })
  host.rt.loginTextMatches = text => text.includes('test sign-in code')
  // The delivery wrapper also checks the active codes it manages. This stub models
  // that refusal so the test can observe the pre-delivery wake intent boundary.
  host.rt.deliver = async () => { throw error('bot/refused') }
  endTask(host, 't1', 'test sign-in code')
  await runReplay(t, host)
  assert.equal(existsSync(fileOf(host.home)), false)
  assert.deepEqual(host.dsh.sends, [])
})

const LOGIN_CODE = '#test_sign_in_state_0123456789'
function loginCodeIn(dsh) {
  const get = dsh.ctx.get
  dsh.ctx.get = name => name === 'acpAgents' ? { loginTextMatches: text => text.includes(LOGIN_CODE) } : get(name)
}

test('astra-code #8: a task title and the rendered group header are checked before an intent', async (t) => {
  startup(t)
  const state = seed()
  state.tasks.t1 = { ...task('a'), title: `Check the draft ${LOGIN_CODE}` }
  state.rooms.r2.name = `Design ${LOGIN_CODE}`
  const dsh = newDsh()
  loginCodeIn(dsh)
  const host = await start(t, { home: homeFor(t, state), dsh })
  endTask(host)
  assert.equal(host.rt.wakeLog.intent(groupFields()), 'off')
  await runReplay(t, host)
  assert.equal(existsSync(fileOf(host.home)), false)
  assert.deepEqual(host.rt.unreadOf('a'), [])
  assert.deepEqual(dsh.sends, [])
})

test('astra-code #8: the pre-step sign-in guard retires only its rejected wake report', async (t) => {
  startup(t)
  const home = homeFor(t)
  writeLines(home, [intent()])
  const unrelated = note('unrelated', { wake: false })
  writeNotes(home, { a: [note('report'), unrelated] })
  const dsh = newDsh()
  loginCodeIn(dsh)
  dsh.queue('a', 'report', { target: 'next-step', text: LOGIN_CODE })
  dsh.queue('a', 'unrelated')
  dsh.persist('a')
  const first = await start(t, { home, dsh })
  dsh.claim('a')
  const messages = dsh.state('a').claimed
  first.rt.dropLoginCodes({ agent: dsh.agentOf('a'), messages })
  assert.deepEqual(messages.map(message => message.source.exchangeId), ['unrelated'])
  await settle(() => terminal(first)?.how === 'discarded')
  assert.equal(terminal(first)?.how, 'discarded')
  assert.deepEqual(first.rt.unreadOf('a'), [unrelated.args])
  dsh.persist('a') // The rejected input left the inbox without a user message.
  const second = await restart(t, first)
  await runReplay(t, second)
  assert.equal(second.dsh.sends.some(send => send.exchangeId === 'report'), false)
})

test('astra-code #10: sequence-paged history finds a receipt after the clock moved back', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const at = Date.now()
  const dsh = newDsh()
  const home = homeFor(t)
  writeLines(home, [intent(taskFields(), at)])
  t.mock.timers.setTime(at - 5 * 60_000)
  dsh.queue('a', 'report')
  dsh.take('a')
  for (let index = 0; index < 10; index += 1) dsh.emit('a', 'assistant/message', {})
  dsh.persist('a')
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.equal(terminal(host)?.how, 'taken')
  assert.deepEqual(dsh.sends, [])
})

test('group replay closes the producer work before recording a taken receipt', async (t) => {
  startup(t)
  const state = seed()
  const fields = waitingWork(state)
  state.works.parent.results = []
  state.works.child = { id: 'child', parent: 'parent', from: 'a', to: 'b', open: [], results: [] }
  const home = homeFor(t, state)
  writeLines(home, [intent(fields)])
  const dsh = newDsh()
  dsh.queue('ga', 'report')
  dsh.take('ga')
  dsh.persist('ga')
  const write = io.writeSync
  let atDone
  t.mock.method(io, 'writeSync', (fd, bytes, ...args) => {
    if (bytes.toString().includes('"event":"done"')) atDone ??= json(home, 'state.json').works
    return write(fd, bytes, ...args)
  })
  const host = await start(t, { home, dsh })
  await runReplay(t, host)
  assert.equal(terminal(host)?.how, 'taken')
  assert.equal(atDone.child, undefined)
  assert.equal(atDone.parent.results[0].text, fields.report.text)
  assert.equal(host.rt.state.works.parent.results[0].failed, undefined)
  assert.deepEqual(host.rt.state.works.parent.open, [])
})
