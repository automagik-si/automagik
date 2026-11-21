import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createRuntime } from '../index.js'
import { classifySession } from '../src/host/bot-sessions.js'
import { fakeContext } from './fake-ctx.js'

const BOT = 'b-aaaaaaaaaa'
const BOT_CHAT = 'bot-chat'
const TEAM = {
  version: 1,
  mainBotIds: [BOT],
  revision: 1,
  bots: {
    [BOT]: {
      id: BOT, sessionId: BOT_CHAT, name: 'Writer', role: '', instructions: '', createdAt: 1,
      segments: [{ sessionId: 'old-chat', endedAt: 3 }],
    },
  },
  rooms: {
    room: {
      id: 'room', name: 'Launch', named: true, members: [BOT], admin: BOT, mode: 'admin', createdAt: 4,
      sessions: { [BOT]: 'group-chat' }, segments: { [BOT]: [{ sessionId: 'old-group', endedAt: 5 }] },
    },
  },
  tasks: { 'task-run': { from: BOT, title: 'Writing', at: 6, status: 'working' } },
}

const sessionEvents = ['agent/pre-step', 'tools/execute']
const listener = (ctx, event, name) => ctx.listeners.get(event).find(handler => handler.name === name)
const recordOf = sessions => ({ version: 1, sessions })

function withDeniedOpen(t, denied, message, run) {
  const open = fs.openSync
  const mock = t.mock.method(fs, 'openSync', (path, flags, ...args) => {
    if (typeof path === 'string' && denied(basename(path), flags)) {
      throw Object.assign(new Error(message), { code: 'EACCES' })
    }
    return open(path, flags, ...args)
  })
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
}

function setup(t, { on, existingStamp, existingList, blockedHome = false, team = true, bot = {}, services } = {}) {
  const prior = process.env.AUTOMAGIK_MULTIUSER
  if (on === undefined) delete process.env.AUTOMAGIK_MULTIUSER
  else process.env.AUTOMAGIK_MULTIUSER = on
  const root = mkdtempSync(join(tmpdir(), 'bot-sessions-'))
  const home = join(root, 'team')
  const stamp = join(home, 'multiuser-mode.json')
  const list = join(home, 'multiuser-bot-sessions.json')
  if (blockedHome) writeFileSync(home, 'a file in place of the team home')
  if (team || existingStamp !== undefined) mkdirSync(home)
  if (team) writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, bots: { [BOT]: { ...TEAM.bots[BOT], ...bot } } }))
  if (existingStamp === 'file') writeFileSync(stamp, '{"version":1,"mode":"on"}', { mode: 0o600 })
  if (existingStamp === 'directory') mkdirSync(stamp)
  if (existingList === 'directory') mkdirSync(list)
  else if (existingList === 'symlink') symlinkSync(join(home, 'missing-record'), list)
  else if (existingList !== undefined) writeFileSync(list, existingList, { mode: 0o600 })
  const sessions = new Map()
  const ctx = fakeContext({ services })
  const warnings = []
  ctx.logger.warn = (_format, message) => warnings.push(message)
  ctx.sessions = sessions
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    rt.dispose()
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
    if (prior === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = prior
  })
  const put = (id, parentSession) => {
    const header = {
      version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: home, isSeeded: false,
      ...(parentSession === undefined ? {} : { origin: 'subagent', parentSession }),
    }
    const session = Session.create(id, [], header)
    sessions.set(id, session)
    return session
  }
  return { rt, ctx, sessions, put, stamp, list, warnings }
}

test('desktop mode with no stamp adds no provision, hold or stamp', t => {
  const { ctx, rt, stamp, list } = setup(t, { team: false })
  assert.equal(rt.multiuserHold(), false)
  assert.equal(ctx.get('automagikBotSessions'), undefined)
  for (const event of sessionEvents) {
    assert.equal(ctx.listeners.get(event)?.some(handler => ['hold', 'recordBot'].includes(handler.name)) ?? false, false)
  }
  assert.equal(existsSync(stamp), false)
  assert.equal(existsSync(list), false)
})

test('multiuser mode provides the resolver and atomically stamps a new team home', t => {
  const { ctx, rt, stamp } = setup(t, { on: '1', team: false })
  const service = ctx.get('automagikBotSessions')
  assert.equal(rt.multiuserHold(), false)
  assert.equal(service.version, 1)
  assert.equal(Object.isFrozen(service), true)
  assert.deepEqual(service.protectedRoots(), [rt.home, rt.dshHome])
  assert.equal(service.botOf('unknown'), undefined)
  assert.equal(statSync(stamp).mode & 0o777, 0o600)
  const record = JSON.parse(readFileSync(stamp, 'utf8'))
  assert.deepEqual(record, { version: 1, mode: 'on', since: new Date(record.since).toISOString() })
})

test('a failed stamp rename withholds the resolver and removes the temporary file', t => {
  const { ctx, stamp } = setup(t, { on: '1', existingStamp: 'directory', team: false })
  assert.equal(ctx.get('automagikBotSessions'), undefined)
  assert.equal(statSync(stamp).isDirectory(), true)
  assert.equal(readdirSync(dirname(stamp)).some(name => name.endsWith('.tmp')), false)
})

test('a blocked team home cannot provide the resolver without a stamp', t => {
  const { ctx, rt, stamp, warnings } = setup(t, { on: '1', blockedHome: true, team: false })
  assert.equal(existsSync(stamp), false)
  assert.equal(ctx.get('automagikBotSessions'), undefined)
  assert.equal(rt.multiuserHold(), true)
  assert.ok(warnings.some(message => message.includes(`the multiuser mode stamp ${stamp} could not be written`)))
})

test('a denied first stamp write holds Bot work and leaves verified person work running', async t => {
  const { ctx, rt, put, stamp, warnings } = withDeniedOpen(t,
    (name, flags) => name.startsWith('multiuser-mode.json.') && flags === 'wx',
    'team home blocked the stamp write', () => setup(t, { on: '1' }))
  assert.equal(existsSync(stamp), false)
  assert.equal(ctx.get('automagikBotSessions'), undefined)
  assert.equal(rt.multiuserHold(), true)
  await rt.load()
  const person = { session: put('person') }
  const hold = listener(ctx, 'agent/pre-step', 'hold')
  const reason = `ds-bot: Bots are held: the multiuser mode stamp ${stamp} could not be written (team home blocked the stamp write); fix the team home and restart`
  assert.ok(warnings.includes(reason))
  assert.throws(() => hold({ agent: { id: BOT_CHAT } }, assert.fail), { message: reason })
  assert.throws(() => hold({ agent: { id: 'unknown' } }, assert.fail), { message: reason })
  assert.equal(hold({ agent: person }, () => 'ran'), 'ran')
})

test('multiuser Bot steps and tools durably record each session once', async t => {
  const { ctx, rt, put, list } = setup(t, { on: '1' })
  await rt.load()
  const step = listener(ctx, 'agent/pre-step', 'recordBot')
  const execute = listener(ctx, 'tools/execute', 'recordBot')
  assert.equal(step({ agent: { session: put('person') } }, () => 'ran'), 'ran')
  assert.equal(existsSync(list), false)
  const bot = { id: BOT_CHAT }
  assert.equal(step({ agent: bot }, () => 'ran'), 'ran')
  const info = statSync(list)
  assert.equal(info.mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ [BOT_CHAT]: BOT }))
  assert.equal(rt.recordedBotOf(BOT_CHAT), BOT)
  assert.equal(step({ agent: bot }, () => 'ran'), 'ran')
  assert.equal(execute({ agent: bot }, () => 'ran'), 'ran')
  assert.equal(statSync(list).ino, info.ino)
  assert.equal(execute({ agent: { id: 'task-run' } }, () => 'ran'), 'ran')
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ [BOT_CHAT]: BOT, 'task-run': BOT }))
})

test('multiuser recording retains durable sessions from a prior runtime', async t => {
  const { ctx, rt, list } = setup(t, { on: '1', existingList: JSON.stringify(recordOf({ [BOT_CHAT]: BOT, evicted: BOT })) })
  await rt.load()
  const step = listener(ctx, 'agent/pre-step', 'recordBot')
  const { ino } = statSync(list)
  assert.equal(step({ agent: { id: BOT_CHAT } }, () => 'ran'), 'ran')
  assert.equal(statSync(list).ino, ino)
  assert.equal(step({ agent: { id: 'task-run' } }, () => 'ran'), 'ran')
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ [BOT_CHAT]: BOT, evicted: BOT, 'task-run': BOT }))
})

test('a blocked session record fails Bot steps and tools closed and can be retried', async t => {
  const { ctx, rt, put, list } = setup(t, { on: '1', existingList: 'directory' })
  await rt.load()
  const bot = { id: BOT_CHAT }
  const person = { session: put('person') }
  for (const event of sessionEvents) {
    const record = listener(ctx, event, 'recordBot')
    assert.throws(() => record({ agent: bot }, assert.fail), error =>
      error.message.startsWith(`ds-bot: could not record Bot session ${BOT_CHAT}`) && error.message.includes(list))
    assert.equal(record({ agent: person }, () => 'ran'), 'ran')
  }
  rmSync(list, { recursive: true })
  assert.equal(listener(ctx, 'agent/pre-step', 'recordBot')({ agent: bot }, () => 'ran'), 'ran')
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ [BOT_CHAT]: BOT }))
})

test('a host with a stale or read-only team lock adds no new Bot session', async t => {
  const { ctx, rt, list } = setup(t, { on: '1', existingList: JSON.stringify(recordOf({ [BOT_CHAT]: BOT })) })
  await rt.load()
  assert.equal(rt.holdsLock(), true)
  const step = listener(ctx, 'agent/pre-step', 'recordBot')
  const lockPath = join(rt.home, 'state.lock')
  const otherLock = JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host' })
  writeFileSync(lockPath, otherLock)
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.holdsLock(), false)
  assert.equal(step({ agent: { id: BOT_CHAT } }, () => 'ran'), 'ran')
  const agent = { id: 'task-run' }
  assert.throws(() => step({ agent }, assert.fail), /could not record Bot session task-run.*this host does not hold the team/)
  assert.equal(readFileSync(lockPath, 'utf8'), otherLock)
  assert.equal(rt.readOnly(), undefined)
  await rt.refresh()
  assert.match(rt.readOnly(), /open in another dsh/)
  assert.throws(() => step({ agent }, assert.fail), /could not record Bot session task-run.*open in another dsh/)
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ [BOT_CHAT]: BOT }))
})

test('an unusable team lock still lets a host record a Bot session', async t => {
  const write = fs.writeFileSync
  const mock = t.mock.method(fs, 'writeFileSync', (path, data, options) => {
    if (typeof path === 'string' && basename(path) === 'state.lock' && options?.flag === 'wx') {
      throw Object.assign(new Error('synthetic lock failure'), { code: 'EACCES' })
    }
    return write(path, data, options)
  })
  syncBuiltinESMExports()
  const { ctx, rt, list, warnings } = setup(t, { on: '1' })
  try {
    await rt.load()
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.ok(warnings.some(message => message.includes('cannot lock') && message.includes('synthetic lock failure')))
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.holdsLock(), false)
  const step = listener(ctx, 'agent/pre-step', 'recordBot')
  assert.equal(step({ agent: { id: 'task-run' } }, () => 'ran'), 'ran')
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ 'task-run': BOT }))
})

const scheduleOf = tasks => ({
  catalog: async () => tasks,
  async edit({ id, patch }) { tasks.find(task => task.id === id).status = patch.active ? 'active' : 'paused' },
  runtime: { requestDrive() {} },
})

const FULL = 'danger-full-access'
const READ = 'read-only'

async function scheduledBotTask(t, target, permission) {
  const task = { id: 'bot-task', involvedSessionIds: [BOT_CHAT], target, status: 'active' }
  const levels = new Map()
  const presets = {
    [FULL]: { sandbox: FULL, approval: 'never' },
    [READ]: { sandbox: READ, approval: 'ask' },
  }
  const permissionPresets = {
    catalog: () => ({ options: Object.keys(presets).map(value => ({ value })), defaultPreset: FULL }),
    resolve: name => presets[name],
    current: session => levels.get(session.id),
    set: (session, name) => levels.set(session.id, name),
  }
  const { ctx, rt, put } = setup(t, { on: '1', bot: { permission }, services: { schedule: scheduleOf([task]), permissionPresets } })
  await rt.load()
  await rt.revokeNewSchedules()
  const [guard] = ctx.listeners.get('schedule/resolve-agent')
  const deliver = async id => {
    const agent = { session: put(id) }
    permissionPresets.set(agent.session, FULL)
    assert.equal(await guard(id, async () => agent), agent)
    return permissionPresets.current(agent.session)
  }
  return { rt, task, deliver }
}

for (const kind of ['new_once', 'new']) {
  test(`multiuser lowers and records a read-only Bot's ${kind} destination`, async t => {
    const target = kind === 'new_once' ? { kind, sessionId: 'X' } : { kind }
    const { rt, deliver } = await scheduledBotTask(t, target, READ)
    assert.equal(await deliver('X'), READ)
    assert.equal(rt.recordedBotOf('X'), BOT)
  })
}

for (const deleting of [false, true]) {
  test(`multiuser pauses a recurring task with a recorded destination on Bot ${deleting ? 'deletion' : 'restriction'}`, async t => {
    const { rt, task, deliver } = await scheduledBotTask(t, { kind: 'new_once', sessionId: 'X' }, FULL)
    assert.equal(await deliver('X'), FULL)
    assert.equal(rt.recordedBotOf('X'), BOT)
    assert.equal(task.status, 'active')
    // After its first delivery, DSH pins a new_once task to the Session it opened.
    task.target = { kind: 'session', sessionId: 'X' }
    task.involvedSessionIds.push('X')
    task.lastDelivery = { targetSessionId: 'X' }
    if (!deleting) rt.botOf(BOT).denyTools = ['bash']
    assert.deepEqual(await rt.revokeNewSchedules(BOT, [], { any: deleting }), [task.id])
    assert.equal(task.status, 'paused')
  })
}

test('multiuser mode records the fresh Session a Bot task opens before its prompt runs', async t => {
  const tasks = [
    { id: 'bot-daily', involvedSessionIds: [BOT_CHAT], target: { kind: 'new' }, status: 'active' },
    { id: 'person-daily', involvedSessionIds: ['person'], target: { kind: 'new' }, status: 'active', lastDelivery: { targetSessionId: 'P0' } },
    { id: 'person-once', involvedSessionIds: ['person'], target: { kind: 'new_once', sessionId: 'P1' }, status: 'active' },
    { id: 'bot-once', involvedSessionIds: [BOT_CHAT], target: { kind: 'new_once', sessionId: 'X' }, status: 'active' },
  ]
  const { ctx, rt, put, list } = setup(t, { on: '1', services: { schedule: scheduleOf(tasks) } })
  await rt.load()
  put('person')
  await rt.revokeNewSchedules()
  const [guard] = ctx.listeners.get('schedule/resolve-agent')
  // The record exists before the delivery's prompt runs.
  const promptOf = id => async () => { assert.equal(rt.recordedBotOf(id), BOT); return 'ran' }
  assert.equal(await guard('S1', promptOf('S1')), 'ran')
  assert.equal(await guard('X', promptOf('X')), 'ran')
  assert.equal(await guard('P0', async () => 'ran'), 'ran')
  assert.equal(await guard('P1', async () => 'ran'), 'ran')
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), recordOf({ S1: BOT, X: BOT }))
  // S1, now the Bot's, arms its own fresh task: that destination is the Bot's too.
  tasks.push({ id: 's1-new', involvedSessionIds: ['S1'], target: { kind: 'new' }, status: 'active' })
  tasks.splice(0, 1)
  assert.equal(await guard('S3', async () => 'ran'), 'ran')
  assert.equal(rt.recordedBotOf('S3'), BOT)
  // Only person tasks left: an anonymous fresh delivery stays a person's.
  tasks.splice(0, tasks.length, tasks.find(task => task.id === 'person-once'),
    { id: 'person-new', involvedSessionIds: ['person'], target: { kind: 'new' }, status: 'active' })
  assert.equal(await guard('P2', async () => 'ran'), 'ran')
  assert.equal(rt.recordedBotOf('P2'), undefined)
  assert.equal(rt.recordedBotOf('P1'), undefined)
})

test('multiuser leaves a person Session unrecorded when a Bot task moves to it', async t => {
  const task = { id: 'bot-task', involvedSessionIds: [BOT_CHAT, 'P'], target: { kind: 'session', sessionId: 'P' }, status: 'active' }
  const { ctx, rt, put, list } = setup(t, { on: '1', services: { schedule: scheduleOf([task]) } })
  await rt.load()
  await rt.revokeNewSchedules()
  const [guard] = ctx.listeners.get('schedule/resolve-agent')
  const agent = { session: put('P') }
  assert.equal(await guard('P', async () => agent), agent)
  assert.equal(rt.recordedBotOf('P'), undefined)
  assert.equal(existsSync(list), false)
})

test('a fresh Bot destination that cannot be recorded is not delivered', async t => {
  const tasks = [{ id: 'bot-daily', involvedSessionIds: [BOT_CHAT], target: { kind: 'new' }, status: 'active' }]
  const { ctx, rt } = setup(t, { on: '1', existingList: 'directory', services: { schedule: scheduleOf(tasks) } })
  await rt.load()
  await rt.revokeNewSchedules()
  const [guard] = ctx.listeners.get('schedule/resolve-agent')
  await assert.rejects(() => guard('S1', assert.fail), /could not record Bot session S1/)
})

test('rollback holds what a recorded fresh Bot Session armed, after the Bot task moved on or was deleted', async t => {
  const tasks = [
    { id: 'bot-daily', involvedSessionIds: [BOT_CHAT], target: { kind: 'new' }, status: 'active', lastDelivery: { targetSessionId: 'S2' } },
    { id: 's1-self', involvedSessionIds: ['S1'], target: { kind: 'session', sessionId: 'S1' }, status: 'active' },
  ]
  const { ctx, rt, put } = setup(t, {
    existingStamp: 'file', existingList: JSON.stringify(recordOf({ [BOT_CHAT]: BOT, S1: BOT, S2: BOT })),
    services: { schedule: scheduleOf(tasks) },
  })
  await rt.load()
  const s1 = put('S1')
  await rt.revokeNewSchedules()
  const [guard] = ctx.listeners.get('schedule/resolve-agent')
  await assert.rejects(() => guard('S1', assert.fail), /blocked by the multiuser Bot hold/)
  tasks.splice(0, 1)
  await assert.rejects(() => guard('S1', assert.fail), /blocked by the multiuser Bot hold/)
  for (const event of sessionEvents) {
    assert.throws(() => listener(ctx, event, 'hold')({ agent: { session: s1 } }, assert.fail), /Bots are held/)
  }
})

test('the resolver uses the real team index and the live Session lineage', async t => {
  const { ctx, rt, sessions, put } = setup(t, { on: '1' })
  const { botOf } = ctx.get('automagikBotSessions')
  put('person')
  const loaded = t.mock.method(rt, 'teamLoaded', () => false)
  assert.equal(botOf('person'), undefined)
  loaded.mock.restore()
  await rt.load()
  assert.equal(rt.teamLoaded(), true)
  assert.equal(rt.teamCurrent(), true)
  for (const id of [BOT, BOT_CHAT, 'group-chat', 'old-chat', 'old-group', 'task-run']) {
    assert.equal(botOf(id), BOT, id)
  }
  assert.equal(botOf('person'), null)
  const live = put('live-child', 'task-run')
  sessions.delete(live.id)
  assert.equal(botOf(live.id, { id: live.id, session: live }), BOT)
  const cold = put('cold-child', 'evicted-parent')
  assert.equal(botOf(cold.id), undefined)
  assert.equal(botOf(live.id), undefined)
  put('child-of-person', 'person')
  assert.equal(botOf('child-of-person'), null)
  put('cycle-a', 'cycle-b')
  put('cycle-b', 'cycle-a')
  assert.equal(botOf('cycle-a'), undefined)
  let previous = BOT_CHAT
  for (let depth = 1; depth <= 33; depth += 1) {
    const id = `descendant-${depth}`
    put(id, previous)
    previous = id
  }
  assert.equal(botOf('descendant-32'), BOT)
  assert.equal(botOf('descendant-33'), undefined)
  let checks = 0
  assert.equal(classifySession({ ...rt, teamCurrent: () => ++checks === 1 }, 'descendant-1'), undefined)
  assert.equal(checks, 2)
  assert.equal(classifySession({ ...rt, teamCurrent: () => false }, 'person'), undefined)
  assert.equal(classifySession({ ...rt, botOfSession: () => ({ id: 'legacy' }) }, 'person'), 'legacy')
  assert.equal(classifySession({ ...rt, botOfSession: () => { throw new Error('unknown') } }, 'person'), undefined)
})

for (const existingStamp of ['file', 'directory']) {
  test(`rollback holds Bot and unknown work with a ${existingStamp} at the stamp path`, async t => {
    const { ctx, rt, put, stamp } = setup(t, { on: '0', existingStamp })
    assert.equal(rt.multiuserHold(), true)
    for (const name of sessionEvents) {
      assert.ok(ctx.calls.includes(`on ${name} (prepend)`))
      const hold = ctx.listeners.get(name).find(listener => listener.name === 'hold')
      assert.ok(hold, `${name} hold registered at install`)
      assert.throws(() => hold({ agent: { id: 'person' } }, assert.fail), /Bots are held/)
    }
    assert.equal(ctx.get('automagikBotSessions'), undefined)
    await rt.load()
    const person = put('person')
    const child = put('child', BOT_CHAT)
    for (const name of sessionEvents) {
      const hold = ctx.listeners.get(name).find(listener => listener.name === 'hold')
      for (const agent of [{ id: BOT_CHAT }, { session: child }, { id: 'unknown' }, undefined]) {
        assert.throws(() => hold({ agent }, assert.fail), error => {
          assert.match(error.message, /Bots are held/)
          assert.ok(error.message.includes(stamp))
          return true
        })
      }
      assert.equal(hold({ agent: { session: person } }, () => 'ran'), 'ran')
    }
    rt.dispose()
    assert.equal(rt.multiuserHold(), false)
  })
}

test('rollback remembers an evicted Bot session and its subagent children', async t => {
  const { ctx, rt, put, list } = setup(t, { existingStamp: 'file', existingList: JSON.stringify(recordOf({ evicted: BOT })) })
  await rt.load()
  const evicted = put('evicted')
  const child = put('child', evicted.id)
  const person = put('person')
  assert.equal(classifySession(rt, evicted.id), null, 'team index and plain header alone see a person')
  assert.equal(rt.recordedBotOf(evicted.id), BOT)
  assert.equal(rt.recordedBotOf(person.id), undefined)
  rmSync(list)
  for (const event of sessionEvents) {
    const hold = listener(ctx, event, 'hold')
    assert.throws(() => hold({ agent: { session: evicted } }, assert.fail), /Bots are held/)
    assert.throws(() => hold({ agent: { session: child } }, assert.fail), /Bots are held/)
    assert.equal(hold({ agent: { session: person } }, () => 'ran'), 'ran')
  }
})

for (const [kind, existingList] of [
  ['a directory', 'directory'],
  ['a dangling symlink', 'symlink'],
  ['unparseable', '{'],
  ['a different version', '{"version":2,"sessions":{}}'],
  ['an array of sessions', '{"version":1,"sessions":[]}'],
  ['a non-string Bot id', '{"version":1,"sessions":{"person":null}}'],
]) {
  test(`rollback refuses every session when the Bot session record is ${kind}`, async t => {
    const { ctx, rt, put, list } = setup(t, { existingStamp: 'file', existingList })
    await rt.load()
    const person = put('person')
    assert.equal(classifySession(rt, person.id), null)
    for (const event of sessionEvents) {
      const hold = listener(ctx, event, 'hold')
      assert.throws(() => hold({ agent: { session: person } }, assert.fail), error => error.message.includes(list))
    }
  })
}

test('rollback refuses verified people when the session record cannot be read', async t => {
  const { ctx, rt, put, list } = withDeniedOpen(t,
    (name, flags) => name === 'multiuser-bot-sessions.json' && typeof flags === 'number',
    'permission denied', () => setup(t, { existingStamp: 'file', existingList: JSON.stringify(recordOf({})) }))
  await rt.load()
  const person = put('person')
  assert.equal(classifySession(rt, person.id), null)
  for (const event of sessionEvents) {
    const hold = listener(ctx, event, 'hold')
    assert.throws(() => hold({ agent: { session: person } }, assert.fail),
      error => error.message.includes(list) && error.message.includes('permission denied'))
  }
})

test('the prepended pre-step waterfall holds an earlier Bot part before parts.js runs', async t => {
  const { ctx, rt } = setup(t, { existingStamp: 'file' })
  await rt.load()
  const partsEntered = t.mock.method(rt, 'dropLoginCodes', () => {})
  const event = 'agent/pre-step'
  const listeners = ctx.listeners.get(event)
  const ordered = []
  // fakeContext records registration order. Match Cordis's newest-first prepend order.
  const registrations = ctx.calls.filter(call => call === `on ${event}` || call === `on ${event} (prepend)`)
  for (const [index, call] of registrations.entries()) {
    if (call.endsWith(' (prepend)')) ordered.unshift(listeners[index])
    else ordered.push(listeners[index])
  }
  const step = { agent: { id: 'old-chat' }, step: 1, messages: [] }
  const run = ordered.reduceRight((next, listener) => () => listener(step, next), assert.fail)
  await assert.rejects(async () => run(), /Bots are held/)
  assert.equal(partsEntered.mock.callCount(), 0)
})

for (const held of [true, false]) {
  test(`an unrestricted Bot's fresh task ${held ? 'is held on rollback' : 'runs without a hold'}`, async t => {
    const tasks = [
      { id: 'bot-task', involvedSessionIds: [BOT_CHAT], target: { kind: 'new' }, status: 'active' },
      { id: 'person-task', involvedSessionIds: ['person'], target: { kind: 'new' }, status: 'active' },
    ]
    const edits = []
    let canPause = false
    const schedule = {
      catalog: async () => tasks,
      async edit({ id, patch }) {
        if (!canPause) throw new Error('schedule store is busy')
        edits.push(id)
        tasks.find(task => task.id === id).status = patch.active ? 'active' : 'paused'
      },
      runtime: { requestDrive() {} },
    }
    const { ctx, rt } = setup(t, { existingStamp: held ? 'file' : undefined, services: { schedule } })
    await rt.load()
    assert.notEqual(rt.botOf(BOT).shell, false)
    assert.deepEqual(rt.botOf(BOT).denyTools ?? [], [])
    await rt.revokeNewSchedules()
    const [guard] = ctx.listeners.get('schedule/resolve-agent')
    if (held) await assert.rejects(() => guard('fresh-bot-session', assert.fail), /blocked by the multiuser Bot hold/)
    else assert.equal(await guard('fresh-bot-session', async () => 'ran'), 'ran')
    canPause = true
    await rt.revokeNewSchedules()
    assert.deepEqual([...new Set(edits)], held ? ['bot-task'] : [])
    assert.deepEqual(tasks.map(task => task.status), [held ? 'paused' : 'active', 'active'])
    if (held) {
      await assert.rejects(() => guard('fresh-bot-session', assert.fail), /blocked by the multiuser Bot hold/)
      await assert.rejects(() => guard('fresh-person-session', assert.fail), /blocked by the multiuser Bot hold/)
      tasks.splice(0, 1)
    }
    assert.equal(await guard('fresh-person-session', async () => 'ran'), 'ran')
  })
}

test('rollback refuses session reminders targeting a recorded Bot and recovers only safe deliveries', async t => {
  const tasks = [
    { id: 'evicted-reminder', involvedSessionIds: ['evicted'], target: { kind: 'session', sessionId: 'evicted' }, status: 'paused' },
    { id: 'person-reminder', involvedSessionIds: ['person'], target: { kind: 'session', sessionId: 'person' }, status: 'active' },
    {
      id: 'fresh-bot-reminder', involvedSessionIds: ['evicted'], target: { kind: 'new' }, status: 'active',
      lastDelivery: { targetSessionId: 'recovery' },
    },
    { id: 'recovery-reminder', involvedSessionIds: ['recovery'], target: { kind: 'session', sessionId: 'recovery' }, status: 'active' },
  ]
  const schedule = {
    catalog: async () => tasks,
    async edit({ id, patch }) {
      tasks.find(task => task.id === id).status = patch.active ? 'active' : 'paused'
    },
    runtime: { requestDrive() {} },
  }
  const { ctx, rt, put } = setup(t, {
    existingStamp: 'file', existingList: JSON.stringify(recordOf({ evicted: BOT })), services: { schedule },
  })
  await rt.load()
  for (const id of ['evicted', 'person', 'recovery']) put(id)
  await rt.revokeNewSchedules()
  assert.deepEqual(tasks.map(task => task.status), ['paused', 'active', 'paused', 'active'])
  const [guard] = ctx.listeners.get('schedule/resolve-agent')
  await assert.rejects(() => guard('evicted', assert.fail), /a scheduled delivery is blocked/)
  await assert.rejects(() => guard('recovery', assert.fail), /a scheduled delivery is blocked/)
  assert.equal(await guard('person', async () => 'ran'), 'ran')
})
