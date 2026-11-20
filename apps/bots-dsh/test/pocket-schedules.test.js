// The owner socket with the real Bot runtime and an in-memory DSH schedule service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs, { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { socketPathOf } from '../src/host/pocket-socket.js'
import { fakeContext } from './fake-ctx.js'

const BOT = 'b-aaaaaaaaaa'
const OTHER = 'b-bbbbbbbbbb'
const GLOBAL = 'b-cccccccccc'
const TERMINAL = `dsh:${BOT}`
const SESSION = 'fixture-session-current'
const PAST = 'fixture-session-past'
const OTHER_SESSION = 'fixture-session-foreign'
const GROUP = 'fixture-group'
const GROUP_SESSION = 'fixture-session-group'
const GROUP_PART = 'fixture-session-group-part'
const PROMPT = 'fixture-prompt-marker'
const FOREIGN_TITLE = 'fixture-foreign-title'
const PRIVATE_MARKERS = [PROMPT, FOREIGN_TITLE, SESSION, PAST, OTHER_SESSION, GROUP_SESSION, GROUP_PART, OTHER]
const PROJECT = '/repo/fixture'
const GRANT = 'grant'
const PHONE = 'fixture-phone'
const FUTURE = '2099-01-01T00:00:00.000Z'
const ELAPSED = '2000-01-01T00:00:00.000Z'
const UPDATED = '2025-01-01T00:00:00.000Z'
const MIB = 1024 * 1024
const HELLO = { write: 1, manage: 1 }
const READ_METHODS = ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill']
const OLD_READ = { protocol: 1, readOnly: true, methods: READ_METHODS }
const OLD_WRITE = { protocol: 1, readOnly: false, write: 1, methods: [...READ_METHODS, 'send', 'interrupt', 'answer'], dedupe: 'log' }
const GRANTS = ['manage-open', 'manage-close']
const MEMORY = ['memory-read', 'memory-edit', 'memory-add']
const SCHEDULES = ['schedule-list', 'schedule-pause', 'schedule-resume', 'schedule-rename']
const SETTINGS = ['settings-read', 'settings-name', 'settings-model']
const READ_ONLY = { kind: 'read-only', message: 'This socket only reads; answer on the computer.' }
const refused = reason => ({ ok: false, state: 'refused', reason })
const unknown = { ok: false, state: 'unknown', reason: 'pending' }
const managed = methods => ({ ...OLD_WRITE, manage: 1, manageMethods: [...GRANTS, ...methods, ...SETTINGS] })
const saved = task => ({ ok: true, state: 'saved', task })
const unchanged = task => ({ ok: true, state: 'unchanged', task })
const read = (tasks, truncated = false) => ({ ok: true, state: 'read', schedules: { terminal: TERMINAL, tasks, truncated } })
const selector = ({ id, rev }) => ({ id, rev })
const idOf = number => `schedule-00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
const alias = id => `x${hash(id)}`
const target = (sessionId = SESSION) => ({ kind: 'session', sessionId })

function row(number = 1, fields = {}) {
  return {
    id: idOf(number), title: 'Fixture task', prompt: PROMPT, kind: 'at', scheduledAt: FUTURE,
    target: target(), status: 'active', updatedAt: UPDATED, ...fields,
  }
}

function inputError(code) {
  return Object.assign(new Error(PRIVATE_MARKERS.join(' ')), { name: 'ScheduleInputError', code })
}

function fakeSchedule({ probe = 'honor' } = {}) {
  let tail = Promise.resolve()
  const enqueue = (step) => {
    const run = tail.then(step)
    tail = run.catch(() => {})
    return run
  }
  const tasks = new Map()
  const edits = []
  const service = {
    tasks, edits, enqueue, ignoreSignal: false,
    runtime: { requestDrive() {} },
    seed(...entries) {
      for (const entry of entries) tasks.set(entry.id, entry)
    },
    catalog: async () => [...tasks.values()].map(entry => structuredClone(entry)),
    edit(request, actor, signal) {
      edits.push({ request, actor, signal })
      return enqueue(async () => {
        const probing = request.id.startsWith('schedule-probe-')
        if (probing && probe === 'other') throw new Error(PRIVATE_MARKERS.join(' '))
        const check = probing ? probe === 'honor' : !service.ignoreSignal
        if (check) signal?.throwIfAborted()
        const { id, action, patch, expectedUpdatedAt } = request
        const current = tasks.get(id)
        if (current === undefined) return { id, code: 'schedule_not_found' }
        if (expectedUpdatedAt !== undefined && (current.updatedAt ?? null) !== expectedUpdatedAt) return { id, code: 'schedule_conflict' }
        if (action === 'delete') { tasks.delete(id); return { id, deleted: true } }
        if (patch.active === true) {
          await service.validateTarget?.(signal)
          if (check) signal?.throwIfAborted()
          if (current.kind === 'at' && Date.parse(current.scheduledAt) <= Date.now()) throw inputError('not_future')
        }
        const { active, ...fields } = patch
        const updated = {
          ...current, ...fields, status: active === undefined ? current.status : active ? 'active' : 'paused',
          updatedAt: new Date(Math.max(Date.now(), current.updatedAt ? Date.parse(current.updatedAt) + 1 : 0)).toISOString(),
        }
        await service.beforePut?.()
        tasks.set(id, updated)
        await service.afterPut?.()
        return structuredClone(updated)
      })
    },
  }
  return service
}

function makeGate(t) {
  let waiting = false
  const held = Promise.withResolvers()
  t.after(held.resolve)
  return {
    get entered() { return until(() => waiting, 'the gate was not reached') },
    release: held.resolve,
    async wait(signal) {
      waiting = true
      if (!signal) return held.promise
      signal.throwIfAborted()
      const abort = () => canceled.reject(signal.reason)
      const canceled = Promise.withResolvers()
      signal.addEventListener('abort', abort, { once: true })
      try { await Promise.race([held.promise, canceled.promise]) }
      finally { signal.removeEventListener('abort', abort) }
    },
  }
}

function controller(writable) {
  return {
    async* follow() {}, async events() {}, async state() {}, async* observeState() {},
    ...(writable ? { prompt() {}, cancel() {} } : {}),
  }
}

function client(path, lines) {
  const socket = createConnection(path)
  const closed = new Promise(resolve => socket.once('close', resolve))
  const pending = new Map()
  let next = 1
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('the socket closed before the answer'))
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end + 1)
      buffer = buffer.slice(end + 1)
      const wire = JSON.parse(line)
      pending.get(wire.id)?.resolve({ wire, line })
    }
  })
  async function exchange(method, params, id = next++) {
    const response = Promise.withResolvers()
    pending.set(id, response)
    const timeout = setTimeout(() => response.reject(new Error(`no reply for ${method}`)), 5000)
    try {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
      const reply = await response.promise
      if (method.startsWith('schedule-')) lines.push(reply.line)
      return reply
    } finally {
      pending.delete(id)
      clearTimeout(timeout)
    }
  }
  const ask = async (method, params) => (await exchange(method, params)).wire
  const call = async (method, fields) => (await ask(method, { grant: GRANT, terminal: TERMINAL, ...fields })).result
  return {
    socket, closed, exchange, ask, call, list: fields => call('schedule-list', fields),
    pause: fields => call('schedule-pause', fields), resume: fields => call('schedule-resume', fields),
    rename: (task, title, extra) => call('schedule-rename', { ...selector(task), title, ...extra }),
  }
}

const takeLock = home => writeFileSync(join(home, 'state.lock'), JSON.stringify({
  pid: process.ppid, host: hostname(), token: 'other-host', since: Date.now(),
}))

async function until(check, message) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return
    await delay(5)
  }
  assert.fail(message)
}

async function setup(t, { schedule = fakeSchedule(), writable = true, memory = true, readOnly = false, brokenLock = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-sched-'))
  const path = socketPathOf(home)
  const registry = join(home, 'bots.json')
  const fixture = (id, sessionId, name, createdAt) => ({ id, sessionId, name, createdAt, model: 'deepseek/v4' })
  const bot = { ...fixture(BOT, SESSION, 'Fixture A', 1), segments: [{ sessionId: PAST, endedAt: 2 }] }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, mainBotIds: [GLOBAL], whaleStored: true,
    bots: { [BOT]: bot, [OTHER]: fixture(OTHER, OTHER_SESSION, 'Fixture B', 3), [GLOBAL]: fixture(GLOBAL, 'fixture-session-global', 'Fixture C', 4) },
    rooms: {
      [GROUP]: { id: GROUP, sessionId: GROUP_SESSION, name: 'Fixture group', named: true, members: [BOT, OTHER], admin: BOT, sessions: {}, segments: { [BOT]: [{ sessionId: GROUP_PART, endedAt: 2 }] } },
    },
  }))
  if (readOnly) takeLock(home)
  if (brokenLock) {
    const mock = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === join(home, 'state.lock')) throw Object.assign(new Error('fixture lock cannot be created'), { code: 'EACCES' })
      return writeFileSyncBeforeMock(file, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  }
  const show = (shown = true) => writeFileSync(registry, JSON.stringify({
    version: 2, projects: [], bots: [{ id: BOT, name: bot.name, folder: PROJECT }], shown: shown ? [{ project: PROJECT, bots: [BOT] }] : [],
  }))
  show()

  const ctx = fakeContext({ services: { sessionController: controller(writable) } })
  const warnings = []
  const lines = []
  const clients = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  let attach
  let detach
  const setSchedule = (service) => {
    detach?.()
    detach = undefined
    if (service) attach({ schedule: service, effect: execute => { detach = execute() } })
  }
  ctx.inject = (names, run) => {
    if (names[0] !== 'schedule') return
    attach = run
    setSchedule(schedule)
  }
  const rt = createRuntime(ctx, { home, memory, memoryReview: false })
  rt.registryPath = registry
  t.after(async () => {
    for (const c of clients) c.socket.destroy()
    setSchedule(null)
    await ctx.dispose()
    rt.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  await until(() => {
    const failed = warnings.find(line => line.includes('Pocket chat is off'))
    if (failed) throw new Error(failed)
    return existsSync(path)
  }, 'Pocket socket did not start')
  const ready = () => until(() => rt.pocketSchedules.writable(), 'schedule probe did not pass')
  const connect = async ({ hello = HELLO, phone = PHONE } = {}) => {
    const c = client(path, lines)
    clients.push(c)
    await once(c.socket, 'connect')
    if (hello) {
      const { result } = await c.ask('hello', hello)
      assert.equal(result.manage, 1)
      assert.deepEqual((await c.ask('manage-open', { grant: GRANT, phone })).result, { grant: GRANT })
    }
    return c
  }
  const protect = () => {
    assert.ok(lines.length > 0)
    for (const line of [...lines, ...warnings]) for (const marker of PRIVATE_MARKERS) {
      assert.equal(line.includes(marker), false, `private marker in reply or warning: ${line}`)
    }
  }
  return { home, registry, rt, schedule, setSchedule, show, ready, connect, warnings, lines, protect }
}

const writeFileSyncBeforeMock = writeFileSync
const open = c => c.ask('manage-open', { grant: GRANT, phone: PHONE })
const taskOf = async (c, id = idOf(1)) => (await c.list({ id })).task
const workEdits = service => service.edits.filter(({ request }) => !request.id.startsWith('schedule-probe-'))

test('hello adds only available method families and keeps the old wire replies', async (t) => {
  for (const [label, options, expected] of [
    ['no service', { schedule: null }, managed(MEMORY)],
    ['Session-scoped service', { schedule: { catalog: async () => [] } }, managed(MEMORY)],
    ['both families', {}, managed([...MEMORY, ...SCHEDULES])],
    ['schedules only', { memory: false }, managed(SCHEDULES)],
    ['read-only controller', { writable: false }, OLD_READ],
  ]) await t.test(label, async (t) => {
    const h = await setup(t, options)
    if (expected.manageMethods?.includes('schedule-pause')) await h.ready()
    const c = await h.connect({ hello: null })
    for (const [params, result] of [[{}, OLD_READ], [{ manage: 1 }, OLD_READ], [{ write: 1 }, options.writable === false ? OLD_READ : OLD_WRITE], [HELLO, expected]]) {
      const { line } = await c.exchange('hello', params, 42)
      assert.equal(line, `${JSON.stringify({ id: 42, result })}\n`)
      for (const method of [...GRANTS, ...MEMORY, ...SCHEDULES, ...SETTINGS]) {
        const { wire } = await c.exchange(method, {}, 42)
        if (method === 'manage-close') assert.deepEqual(wire, { id: 42, result: {} })
        else if (!result.manageMethods?.includes(method)) assert.deepEqual(wire, { id: 42, error: READ_ONLY })
        else assert.equal(wire.error?.kind ?? wire.result?.reason, method === 'manage-open' ? 'invalid_params' : 'revoked')
      }
    }
  })
})

test('a pending probe and services that ignore or reject it offer reads only', async (t) => {
  const first = fakeSchedule()
  const gate = makeGate(t)
  const held = first.enqueue(gate.wait)
  await gate.entered
  const h = await setup(t, { schedule: first })
  const c = await h.connect({ hello: null })
  const listOnly = managed([...MEMORY, 'schedule-list'])
  assert.deepEqual((await c.ask('hello', HELLO)).result, listOnly)
  const probe = first.edits[0]
  assert.match(probe.request.id, /^schedule-probe-[0-9a-f-]{36}$/)
  assert.deepEqual(probe.request, { id: probe.request.id, action: 'update', patch: { title: 'x' }, expectedUpdatedAt: null })
  assert.equal(probe.actor, undefined)
  assert.equal(probe.signal.aborted, true)
  gate.release()
  await held
  await h.ready()
  assert.deepEqual((await c.ask('schedule-pause', {})).error, READ_ONLY)
  assert.deepEqual((await c.ask('hello', HELLO)).result, managed([...MEMORY, ...SCHEDULES]))
  for (const [at, probe] of ['ignore', 'other'].entries()) {
    const replacement = fakeSchedule({ probe })
    h.setSchedule(replacement)
    await until(() => h.warnings.filter(line => line === 'pocket schedules: write checks unavailable').length === at + 1, 'probe did not warn')
    assert.equal(replacement.edits.length, 1)
    assert.deepEqual((await c.ask('hello', HELLO)).result, listOnly)
    await open(c)
    assert.deepEqual(await c.list(), read([]))
    assert.deepEqual((await c.ask('schedule-pause', {})).error, READ_ONLY)
  }
  h.protect()
})

test('lists only own current and past chat tasks and projects each timing kind', async (t) => {
  const h = await setup(t)
  const { schedule } = h
  const timing = [
    ['at', {}, {}],
    ['after', { afterSeconds: 30 }, { afterSeconds: 30 }],
    ['every', { everySeconds: 60 }, { everySeconds: 60 }],
    ['daily', { time: '12:00:00.000', timeZone: 'UTC' }, { time: '12:00:00.000', timeZone: 'UTC' }],
    ['weekly', { time: '12:00:00.000', timeZone: 'UTC', weekdays: [1, 5] }, { time: '12:00:00.000', timeZone: 'UTC', weekdays: [1, 5] }],
    ['cron', { expression: '0 12 * * *', timeZone: 'UTC' }, { expression: '0 12 * * *', timeZone: 'UTC' }],
    ['rrule', { rrule: 'RRULE:FREQ=DAILY' }, { rrule: 'RRULE:FREQ=DAILY' }],
    ['rrule', { rrule: 'é'.repeat(513) }, { rrule: null, ruleTooLong: true }],
    ['cron', { expression: 'x'.repeat(1025), timeZone: 'UTC' }, { expression: null, ruleTooLong: true, timeZone: 'UTC' }],
    ['future-kind', { expression: PROMPT, timeZone: OTHER_SESSION }, {}],
  ]
  const own = timing.map(([kind, fields], index) => row(index + 1, { kind, target: target(index === 1 ? PAST : SESSION), ...fields }))
  schedule.seed(...own, ...[
    target(OTHER_SESSION), target(GROUP_SESSION), target(GROUP_PART),
    { kind: 'new' }, { kind: 'new_once', sessionId: SESSION },
  ].map((target, index) => row(index + 20, { target, title: FOREIGN_TITLE, involvedSessionIds: [SESSION] })))
  const c = await h.connect()
  const projected = own.map((entry, index) => {
    const { id, title, kind, scheduledAt: at, status, updatedAt } = entry
    const spec = { kind, at, ...timing[index][2] }
    return { id, title, rev: hash(JSON.stringify([id, updatedAt, title, status, spec])), state: 'scheduled', timing: spec }
  })
  assert.deepEqual(await c.list(), read(projected))
  assert.deepEqual(await c.list({ id: idOf(2) }), { ...read(projected), task: projected[1] })
  assert.deepEqual(await c.list({ id: idOf(20) }), { ...read(projected), task: null })
  assert.equal(workEdits(schedule).length, 0)
  h.protect()
})

test('pause, resume and rename send only the selected patch and return the committed task', async (t) => {
  const h = await setup(t)
  h.schedule.seed(row())
  const c = await h.connect()
  const first = await taskOf(c)
  const extra = { prompt: PROMPT, timing: { at: ELAPSED }, target: target(OTHER_SESSION), phone: 'another-phone' }
  const paused = await c.pause({ ...extra, ...selector(first), title: {} })
  assert.deepEqual(paused, saved({ ...first, state: 'paused', rev: paused.task.rev }))
  assert.notEqual(paused.task.rev, first.rev)
  assert.equal(paused.task.timing.at, FUTURE)
  const pausedAt = h.schedule.tasks.get(first.id).updatedAt
  assert.deepEqual(await c.pause(selector(paused.task)), unchanged(paused.task))
  const resumed = await c.resume({ ...extra, ...selector(paused.task) })
  assert.deepEqual(resumed, saved({ ...first, rev: resumed.task.rev }))
  const resumedAt = h.schedule.tasks.get(first.id).updatedAt
  assert.ok(resumedAt > pausedAt)
  assert.deepEqual(await c.resume(selector(resumed.task)), unchanged(resumed.task))
  const renamed = await c.rename(resumed.task, '  New fixture title  ', extra)
  assert.deepEqual(renamed, saved({ ...resumed.task, title: 'New fixture title', rev: renamed.task.rev }))
  assert.notEqual(renamed.task.rev, resumed.task.rev)
  assert.deepEqual(await c.rename(renamed.task, ' New fixture title '), unchanged(renamed.task))
  assert.deepEqual(await c.pause(selector(first)), { ...refused('stale'), task: renamed.task })
  assert.deepEqual(workEdits(h.schedule).map(({ request }) => request), [
    { id: first.id, action: 'update', patch: { active: false }, expectedUpdatedAt: UPDATED },
    { id: first.id, action: 'update', patch: { active: true }, expectedUpdatedAt: pausedAt },
    { id: first.id, action: 'update', patch: { title: 'New fixture title' }, expectedUpdatedAt: resumedAt },
  ])
  for (const { actor, signal } of workEdits(h.schedule)) {
    assert.equal(actor, undefined)
    assert.ok(signal instanceof AbortSignal)
    assert.ok(Object.hasOwn(signal, 'throwIfAborted'))
  }
  assert.equal(h.schedule.tasks.get(first.id).prompt, PROMPT)
  assert.deepEqual(h.schedule.tasks.get(first.id).target, target())
  h.protect()
})

test('finished, overdue and paused past tasks have distinct operation rules', async (t) => {
  const h = await setup(t)
  h.schedule.seed(
    row(1, { scheduledAt: ELAPSED, status: 'ended' }),
    row(2, { scheduledAt: ELAPSED }),
    row(3, { scheduledAt: ELAPSED, status: 'paused' }),
  )
  const c = await h.connect()
  const [finished, overdue, paused] = (await c.list()).schedules.tasks
  assert.deepEqual([finished.state, overdue.state, paused.state], ['finished', 'overdue', 'paused'])
  assert.deepEqual(await c.pause(selector(finished)), { ...refused('ended'), task: finished })
  assert.deepEqual(await c.resume(selector(finished)), { ...refused('ended'), task: finished })
  assert.deepEqual(await c.resume(selector(overdue)), unchanged(overdue))
  assert.equal(workEdits(h.schedule).length, 0)
  assert.deepEqual(await c.resume(selector(paused)), { ...refused('invalid'), message: 'This task has no future occurrence.' })
  h.schedule.validateTarget = async () => { throw inputError('invalid_rule') }
  assert.deepEqual(await c.resume(selector(paused)), refused('invalid'))
  assert.deepEqual(await c.rename(finished, '  '), { ...refused('invalid'), message: 'Give the task a name' })
  assert.deepEqual(await c.rename(finished, 'é'.repeat(121)), { ...refused('invalid'), message: 'Keep the name under 120 characters' })
  const renamed = await c.rename(finished, 'Finished fixture')
  assert.deepEqual(renamed, saved({ ...finished, title: 'Finished fixture', rev: renamed.task.rev }))
  assert.equal(workEdits(h.schedule).length, 3)
  h.protect()
})

test('legacy and literal aliases are hashed, collisions are refused, and legacy revisions compare with null', async (t) => {
  const h = await setup(t)
  const stored = SESSION
  const literal = alias(stored)
  h.schedule.seed(row(1, { id: stored, updatedAt: undefined }), row(2, { id: literal }))
  const c = await h.connect()
  const [one, two] = (await c.list()).schedules.tasks
  assert.equal(one.id, literal)
  assert.equal(two.id, alias(literal))
  const renamed = await c.rename(one, 'Renamed legacy fixture')
  assert.deepEqual(renamed, saved({ ...one, rev: renamed.task.rev, title: 'Renamed legacy fixture' }))
  assert.deepEqual(workEdits(h.schedule)[0].request, { id: stored, action: 'update', patch: { title: 'Renamed legacy fixture' }, expectedUpdatedAt: null })
  assert.deepEqual(await c.list({ id: stored }), refused('invalid'))
  const catalog = h.schedule.catalog
  h.schedule.catalog = async () => {
    const entries = await catalog()
    return [...entries, { ...entries[0], target: target(PAST) }]
  }
  assert.deepEqual(await c.list({ id: literal }), refused('ambiguous'))
  assert.deepEqual(await c.pause(selector(renamed.task)), refused('ambiguous'))
  assert.equal(workEdits(h.schedule).length, 1)
  h.protect()
})

test('selected read survives both the task count cap and the UTF-8 line cap', async (t) => {
  const h = await setup(t)
  h.schedule.seed(...Array.from({ length: 501 }, (_, index) => row(index + 1)))
  const c = await h.connect()
  const count = await c.list({ id: idOf(501) })
  assert.equal(count.schedules.tasks.length, 500)
  assert.equal(count.schedules.truncated, true)
  assert.equal(count.task.id, idOf(501))
  h.schedule.seed(...Array.from({ length: 501 }, (_, index) => row(index + 1, {
    title: '\u0001'.repeat(115) + 'é', kind: 'rrule', rrule: '\\'.repeat(1024),
  })))
  const replyId = '"\\é'.repeat(7000)
  const { line, wire } = await c.exchange('schedule-list', { grant: GRANT, terminal: TERMINAL, id: idOf(501) }, replyId)
  const { schedules, task } = wire.result
  assert.equal(wire.id, replyId)
  assert.equal(schedules.truncated, true)
  assert.ok(schedules.tasks.length > 0 && schedules.tasks.length < 500)
  assert.ok(Buffer.byteLength(line) <= MIB)
  assert.ok(Buffer.byteLength(line) + Buffer.byteLength(JSON.stringify(task)) + 1 > MIB, 'the next task would exceed the cap')
  assert.equal(task.id, idOf(501))
  const saved = await c.exchange('schedule-pause', { grant: GRANT, terminal: TERMINAL, ...selector(task) }, replyId)
  assert.equal(saved.wire.result.state, 'saved')
  assert.ok(Buffer.byteLength(saved.line) <= MIB)
  h.protect()
})

test('desktop moves and phone edits keep FIFO order and return the right revision', async (t) => {
  for (const ordering of ['move first', 'phone first']) await t.test(ordering, async (t) => {
    const h = await setup(t)
    h.schedule.seed(row())
    const c = await h.connect()
    const first = await taskOf(c)
    const gate = makeGate(t)
    const held = h.schedule.enqueue(gate.wait)
    await gate.entered
    let move
    let phone
    if (ordering === 'move first') {
      move = h.rt.moveSchedules(SESSION, PAST)
      await until(() => workEdits(h.schedule).length === 1, 'move did not enqueue')
      phone = c.rename(first, 'Phone title')
    } else {
      phone = c.rename(first, 'Phone title')
      await until(() => workEdits(h.schedule).length === 1, 'phone edit did not enqueue')
      move = h.rt.moveSchedules(SESSION, PAST)
    }
    await until(() => workEdits(h.schedule).length === 2, 'second edit did not enqueue')
    gate.release()
    await held
    const [, reply] = await Promise.all([move, phone])
    const current = await taskOf(c)
    assert.notEqual(current.rev, first.rev)
    assert.deepEqual(h.schedule.tasks.get(first.id).target, target(PAST))
    if (ordering === 'move first') {
      assert.deepEqual(reply, { ...refused('stale'), task: current })
      assert.equal(current.title, first.title)
      assert.equal((await c.rename(current, 'Phone title')).state, 'saved')
    } else {
      assert.deepEqual(reply, saved({ ...first, title: 'Phone title', rev: reply.task.rev }))
      assert.equal(current.title, reply.task.title)
      assert.notEqual(current.rev, reply.task.rev)
    }
    h.protect()
  })
})

test('desktop prompt edit is stale and deletion or foreign retarget is gone', async (t) => {
  for (const [label, desktop, expected] of [
    ['prompt edit', { action: 'update', patch: { prompt: `${PROMPT} changed` } }, 'stale'],
    ['deletion', { action: 'delete' }, 'gone'],
    ['foreign retarget', { action: 'update', patch: { target: target(OTHER_SESSION) } }, 'gone'],
  ]) await t.test(label, async (t) => {
    const h = await setup(t)
    h.schedule.seed(row())
    const c = await h.connect()
    const first = await taskOf(c)
    const gate = makeGate(t)
    const held = h.schedule.enqueue(gate.wait)
    const edited = h.schedule.edit({ id: first.id, ...desktop })
    const paused = c.pause(selector(first))
    await until(() => workEdits(h.schedule).length === 2, 'phone edit did not enqueue')
    gate.release()
    await Promise.all([held, edited])
    const reply = await paused
    const current = await taskOf(c)
    if (expected === 'stale') {
      assert.deepEqual(reply, { ...refused('stale'), task: current })
      assert.deepEqual(current, { ...first, rev: current.rev })
      assert.notEqual(first.rev, current.rev)
    } else {
      assert.deepEqual(reply, refused('gone'))
      assert.equal(current, null)
    }
    const stored = h.schedule.tasks.get(first.id)
    if (stored) assert.equal(stored.status, 'active')
    h.protect()
  })
})

test('checks grant and fields before a fresh project binding and permits private project Bots', async (t) => {
  const h = await setup(t)
  h.schedule.seed(row())
  const c = await h.connect()
  assert.deepEqual(await c.list({ grant: 'closed', terminal: false, id: false }), refused('revoked'))
  for (const fields of [{ terminal: '' }, { terminal: 'dsh:' }, { terminal: 3 }, { id: '' }, { id: 'xABCDEF0000000000' }, { id: null }]) {
    assert.deepEqual(await c.list(fields), refused('invalid'))
  }
  const first = await taskOf(c)
  assert.deepEqual(await c.pause({ id: first.id }), refused('invalid'))
  assert.deepEqual(await c.pause({ id: first.id, rev: '1'.repeat(15) }), refused('invalid'))
  assert.deepEqual(await c.pause({ id: first.id, rev: 'A'.repeat(16) }), refused('invalid'))
  assert.deepEqual(await c.rename(first, 1), refused('invalid'))
  assert.deepEqual(await c.rename(first, 'é'.repeat(2049)), refused('invalid'))
  assert.deepEqual(await c.list({ terminal: 'dsh:missing' }), refused('not-found'))
  assert.deepEqual(await c.list({ terminal: `dsh:${GLOBAL}` }), refused('global'))
  h.show(false)
  assert.deepEqual(await c.list(), refused('not-shown'))
  writeFileSync(h.registry, '{ broken')
  assert.deepEqual(await c.list(), refused('not-shown'))
  h.show()
  h.rt.state.bots[BOT].private = true
  assert.deepEqual(await c.call('memory-read'), refused('private'))
  assert.deepEqual(await taskOf(c), first)
  assert.equal((await c.pause(selector(first))).state, 'saved')
  h.rt.state.bots[BOT].sessionId = ''
  assert.deepEqual(await c.list(), refused('not-found'))
  h.protect()
})

test('a read-only host and a host with a broken lock negotiate then refuse unavailable', async (t) => {
  for (const options of [{ readOnly: true }, { brokenLock: true }]) await t.test(Object.keys(options)[0], async (t) => {
    const h = await setup(t, options)
    const c = await h.connect()
    assert.deepEqual(await c.list({ terminal: 'dsh:missing' }), refused('unavailable'))
    assert.deepEqual(await c.pause({ id: idOf(1), rev: '0'.repeat(16) }), refused('unavailable'))
    assert.equal(workEdits(h.schedule).length, 0)
    h.protect()
  })
})

test('a queued edit rechecks the grant, pick, lock, owner and attached service at admission', async (t) => {
  const cases = [
    ['grant close', 'revoked', async (h, c) => { assert.deepEqual((await c.ask('manage-close', { grant: GRANT })).result, {}); await open(c) }],
    ['re-hello', 'revoked', async (h, c) => { await c.ask('hello', HELLO); await open(c) }],
    ['disconnect', 'revoked', async (h, c) => { c.socket.destroy(); await c.closed }],
    ['pick withdrawal', 'not-shown', async h => { h.show(false) }],
    ['lock loss', 'unavailable', async h => { takeLock(h.home) }],
    ['owner loss without an edit', 'gone', async h => { h.rt.chatOwners.delete(SESSION) }],
    ['detach', 'unavailable', async h => { h.setSchedule(null) }],
    ['replacement', 'unavailable', async h => { h.setSchedule(fakeSchedule()); await h.ready() }],
  ]
  for (const [label, reason, change] of cases) await t.test(label, async (t) => {
    const h = await setup(t)
    const original = row()
    h.schedule.seed(original)
    const c = await h.connect()
    const first = await taskOf(c)
    const gate = makeGate(t)
    const held = h.schedule.enqueue(gate.wait)
    const disconnected = label === 'disconnect'
    const request = c.pause(selector(first))
    const reply = disconnected ? assert.rejects(request, /socket closed before the answer/) : request
    await until(() => workEdits(h.schedule).length === 1, 'phone edit did not enqueue')
    const { signal } = workEdits(h.schedule)[0]
    await change(h, c)
    if (disconnected) await until(() => signal.aborted, 'disconnect did not abort the edit')
    gate.release()
    await held
    if (disconnected) await reply
    else assert.deepEqual(await reply, refused(reason))
    await h.schedule.enqueue(() => {})
    assert.equal(signal.aborted, true)
    assert.equal(signal.reason.reason, reason)
    assert.deepEqual(h.schedule.tasks.get(original.id), original)
    h.protect()
  })
})

test('resume can be revoked during target validation and rejects a detached or replaced service', async (t) => {
  for (const [label, reason, change] of [
    ['revoked', 'revoked', async (h, c) => { await c.ask('manage-close', { grant: GRANT }) }],
    ['detached', 'unavailable', async h => { h.setSchedule(null) }],
    ['replaced', 'unavailable', async h => { h.setSchedule(fakeSchedule()); await h.ready() }],
  ]) await t.test(label, async (t) => {
    const h = await setup(t)
    const original = row(1, { status: 'paused' })
    h.schedule.seed(original)
    const c = await h.connect()
    const first = await taskOf(c)
    const gate = makeGate(t)
    h.schedule.validateTarget = gate.wait
    const resume = c.resume(selector(first))
    await gate.entered
    await change(h, c)
    if (label !== 'revoked') gate.release()
    assert.deepEqual(await resume, refused(reason))
    assert.deepEqual(h.schedule.tasks.get(original.id), original)
    assert.equal(workEdits(h.schedule)[0].signal.aborted, true)
    h.protect()
  })
})

test('final recheck drops ownership losses from lists and returns gone for a selected task', async (t) => {
  const h = await setup(t)
  h.schedule.seed(row(), row(2, { target: target(PAST) }))
  const c = await h.connect()
  const [first] = (await c.list()).schedules.tasks
  const list = h.rt.pocketSchedules.list
  t.mock.method(h.rt.pocketSchedules, 'list', async (args) => {
    const reply = await list(args)
    h.rt.pastOwners.set(PAST, { botId: OTHER })
    return reply
  })
  assert.deepEqual(await c.list(), read([first]))
  h.rt.pastOwners.set(PAST, { botId: BOT })
  assert.deepEqual(await c.list({ id: idOf(2) }), refused('gone'))
  h.protect()
})

test('final recheck removes tasks from unchanged, stale and ended replies after owner loss', async (t) => {
  for (const [label, fields, method, request] of [
    ['unchanged', { status: 'paused' }, 'pause', task => selector(task)],
    ['stale', {}, 'pause', task => ({ ...selector(task), rev: '0'.repeat(16) })],
    ['ended', { status: 'ended' }, 'resume', task => selector(task)],
  ]) await t.test(label, async (t) => {
    const h = await setup(t)
    h.schedule.seed(row(1, fields))
    const c = await h.connect()
    const task = await taskOf(c)
    const run = h.rt.pocketSchedules[method]
    t.mock.method(h.rt.pocketSchedules, method, async args => {
      const result = await run(args)
      h.rt.chatOwners.set(SESSION, OTHER)
      return result
    })
    assert.deepEqual(await c[method](request(task)), refused('gone'))
    assert.equal(workEdits(h.schedule).length, 0)
    h.protect()
  })
})

test('a confirmed save drops all data after authority or task ownership is lost', async (t) => {
  for (const [label, reason, change] of [
    ['grant', 'revoked', async (h, c) => { await c.ask('manage-close', { grant: GRANT }) }],
    ['pick', 'not-shown', async h => { h.show(false) }],
    ['owner', 'gone', async h => { h.rt.chatOwners.set(SESSION, OTHER) }],
    ['service', 'unavailable', async h => { h.setSchedule(fakeSchedule()); await h.ready() }],
  ]) await t.test(label, async (t) => {
    const h = await setup(t)
    h.schedule.seed(row())
    const c = await h.connect()
    const first = await taskOf(c)
    const gate = makeGate(t)
    h.schedule.afterPut = gate.wait
    const pending = c.pause(selector(first))
    await gate.entered
    await change(h, c)
    gate.release()
    assert.deepEqual(await pending, { ...refused(reason), applied: true })
    assert.equal(h.schedule.tasks.get(first.id).status, 'paused')
    h.protect()
  })
})

test('job errors and unknown outcomes keep DSH details out of the wire and warnings', async (t) => {
  const h = await setup(t)
  h.schedule.seed(row())
  const c = await h.connect()
  const first = await taskOf(c)
  const catalog = h.schedule.catalog
  h.schedule.catalog = async () => { throw new Error(PRIVATE_MARKERS.join(' ')) }
  assert.deepEqual(await c.list(), refused('unavailable'))
  h.schedule.catalog = catalog
  h.schedule.afterPut = async () => { throw new Error(PRIVATE_MARKERS.join(' ')) }
  assert.deepEqual(await c.pause(selector(first)), unknown)
  const paused = await taskOf(c)
  const gate = makeGate(t)
  h.schedule.afterPut = async () => {
    await gate.wait()
    throw new DOMException(PRIVATE_MARKERS.join(' '), 'AbortError')
  }
  const resume = c.resume(selector(paused))
  await gate.entered
  await c.ask('manage-close', { grant: GRANT })
  gate.release()
  assert.deepEqual(await resume, unknown)
  assert.equal(h.schedule.tasks.get(first.id).status, 'active')
  assert.equal(h.warnings.filter(line => line === 'pocket schedules: unavailable').length, 3)
  h.protect()
})

test('disconnect holds the shared busy key until the in-flight put settles', async (t) => {
  const h = await setup(t)
  h.schedule.seed(row())
  const c = await h.connect()
  const first = await taskOf(c)
  const put = makeGate(t)
  h.schedule.beforePut = put.wait
  const pending = assert.rejects(c.rename(first, 'Committed fixture'), /socket closed before the answer/)
  await put.entered
  c.socket.destroy()
  await pending
  const reconnected = await h.connect()
  assert.deepEqual(await reconnected.list({ id: first.id }), refused('busy'))
  assert.deepEqual(await reconnected.call('memory-read'), refused('busy'))
  assert.deepEqual(await reconnected.list({ id: 'bad' }), refused('invalid'))
  const other = await h.connect({ phone: 'another-phone' })
  assert.deepEqual(await taskOf(other), first)
  put.release()
  await h.schedule.enqueue(() => {})
  const recovered = await taskOf(reconnected)
  assert.deepEqual(recovered, { ...first, title: 'Committed fixture', rev: recovered.rev })
  assert.notEqual(recovered.rev, first.rev)
  h.protect()
})

test('schedule and memory requests share rate counters across connections', async (t) => {
  const h = await setup(t)
  const first = await h.connect()
  const second = await h.connect()
  for (let at = 0; at < 59; at += 1) assert.equal((await first.list()).state, 'read')
  assert.equal((await second.call('memory-read')).state, 'read')
  assert.deepEqual(await second.list(), refused('rate'))
  assert.deepEqual(await first.call('memory-read'), refused('rate'))
  for (let at = 0; at < 19; at += 1) assert.deepEqual(await first.pause({ id: idOf(1), rev: '0'.repeat(16) }), refused('gone'))
  assert.equal((await second.call('memory-add', { text: 'Fixture memory' })).state, 'saved')
  assert.deepEqual(await second.pause({ id: idOf(1), rev: '0'.repeat(16) }), refused('rate'))
  assert.deepEqual(await first.call('memory-add', { text: 'More fixture memory' }), refused('rate'))
  h.protect()
})

test('a service that drops the admission check withdraws writes for the process', async (t) => {
  const h = await setup(t)
  h.schedule.seed(row())
  const c = await h.connect()
  const first = await taskOf(c)
  const another = await h.connect({ phone: 'another-phone' })
  const put = makeGate(t)
  h.schedule.beforePut = put.wait
  h.schedule.ignoreSignal = true
  const pending = c.pause(selector(first))
  await put.entered
  const queued = another.rename(first, 'Queued title')
  await until(() => workEdits(h.schedule).length === 2, 'the second edit did not enqueue')
  h.schedule.ignoreSignal = false
  put.release()
  const saved = await pending
  assert.equal(saved.state, 'saved')
  assert.equal(saved.task.state, 'paused')
  assert.deepEqual(await queued, refused('unavailable'))
  assert.equal(workEdits(h.schedule)[1].signal.aborted, true)
  assert.deepEqual(await c.resume(selector(saved.task)), refused('unavailable'))
  const replacement = fakeSchedule()
  h.setSchedule(replacement)
  await replacement.enqueue(() => {})
  assert.equal(replacement.edits.length, 1)
  assert.deepEqual(await c.resume(selector(saved.task)), refused('unavailable'))
  assert.deepEqual((await c.ask('hello', HELLO)).result, managed([...MEMORY, 'schedule-list']))
  assert.deepEqual((await c.ask('schedule-resume', {})).error, READ_ONLY)
  assert.equal(h.warnings.filter(line => line === 'pocket schedules: write checks unavailable').length, 1)
  h.protect()
})
