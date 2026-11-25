// #2056 (RFC 0048, delivery 1.5, PLAN-D15 §16): the one-time review guard migration (store adopt).
// Each D1 Solver whose reviewer Bot is on the team gets `reviewGuard: true` once, with its one chat
// line (`reviewGuardNotice`); a Solver with no reviewer Bot stays off; the marker is never read;
// nothing to change writes nothing; a person's later OFF stays off.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import * as pocket from '../src/host/pocket-chat.js'
import { fakeContext } from './fake-ctx.js'

const record = (id, extra = {}) => ({ id, sessionId: 'chat-' + id, name: 'Bot ' + id, model: 'deepseek/chat', createdAt: 1, capabilities: [], ...extra })
const FLAGS = { whaleStored: true, octopusStored: true, genieClayStored: true, claudeCodeMoved: true, nativeToolsOmpKept: true, nativeToolsCodexKept: true }
const team = (bots, extra = {}) => ({ version: 2, revision: 3, mainBotIds: ['rev'], ...FLAGS, capabilities: { items: {} }, bots, ...extra })
const FIXTURE = {
  solver: record('solver', { role: 'Solver', reviewerId: 'rev' }),
  rev: record('rev', { role: 'Reviewer' }),
  fresh: record('fresh', { role: 'Solver' }),
  orphan: record('orphan', { role: 'Solver', reviewerId: 'gone' }),
  renamed: record('renamed', { role: 'Helper', reviewerId: 'rev' }),
  plain: record('plain', { role: 'Helper' }),
}
const write = (home, state) => writeFileSync(join(home, 'state.json'), JSON.stringify(state))
const read = home => readFileSync(join(home, 'state.json'), 'utf8')

function workspace(t, state = team(FIXTURE)) {
  const home = mkdtempSync(join(tmpdir(), 'review-guard-migration-'))
  write(home, state)
  const hosts = []
  t.after(async () => {
    for (const current of hosts) await current.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, open() {
    const current = host(home)
    hosts.push(current)
    return current
  } }
}

function host(home) {
  const warnings = []
  const ctx = fakeContext({ services: {
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessionPersistence: { open: async () => { throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' }) } },
  } })
  ctx.registry = new Map()
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.llm.listProviders = () => [{ id: 'deepseek', name: 'DeepSeek' }]
  ctx.llm.listModels = async () => [{ id: 'chat' }]
  ctx.llm.resolveModelInfo = async () => ({})
  ctx.workspaceRegistry = {
    get: () => undefined, resolveByPath: async () => undefined,
    create: async path => ({ id: 'team', path }), archiveSession: async () => {},
  }
  ctx.sessionController = {
    create: async () => ({ sessionId: 'new' }),
    resolveAgent: async id => ({ agent: { session: { id, deriveMessages: () => [] }, followup: () => {} } }),
    selectModel: async () => {},
  }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { get: () => undefined, flush: async () => true }
  let route
  ctx.connection.fetch.register = (options) => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  const rt = createRuntime(ctx, { home })
  ctx.provide('omniTeam', rt)
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const guard = exec => (ctx.listeners.get('tools/execute') ?? [])[0](exec, async () => 'ran')
  return { rt, ctx, warnings, call, guard, dispose: () => ctx.dispose(), stored: () => JSON.parse(read(home)) }
}

function assertMigrated(state, at) {
  assert.equal(state.reviewGuardMigrated, true)
  for (const id of ['solver', 'renamed']) {
    assert.equal(state.bots[id].reviewGuard, true, id)
    assert.equal(typeof state.bots[id].reviewGuardNotice.at, 'number', id)
    assert.equal(state.bots[id].reviewGuardNotice.sessionId, 'chat-' + id, id)
    if (at !== undefined) assert.equal(state.bots[id].reviewGuardNotice.at, at, id)
  }
  for (const id of ['fresh', 'orphan', 'plain']) assert.deepEqual(state.bots[id], FIXTURE[id], id)
  assert.equal(state.bots.rev.reviewGuard, undefined)
  assert.equal(state.bots.rev.reviewGuardNotice, undefined)
}

test('RG-M1/RG-M11 migrates once: the reviewer-kept Solvers turn on with one notice, nothing else changes, one write', async (t) => {
  const { open } = workspace(t)
  const h = open()
  await h.rt.load()
  assertMigrated(h.stored())
  assertMigrated(h.rt.state)
})

test('RG-M2 a second load changes nothing: same bytes, same notice', async (t) => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  const at = h.stored().bots.solver.reviewGuardNotice.at
  await h.dispose()
  const bytes = read(home)
  const second = open()
  await second.rt.load()
  assert.equal(read(home), bytes)
  assertMigrated(second.rt.state, at)
})

test('RG-M3 nothing to change writes nothing; the flag rides the next real save', async (t) => {
  const { home, open } = workspace(t, team({ fresh: FIXTURE.fresh, orphan: FIXTURE.orphan, plain: FIXTURE.plain }, { mainBotIds: ['plain'] }))
  const bytes = read(home)
  const mtime = statSync(join(home, 'state.json')).mtimeMs
  const h = open()
  await h.rt.load()
  assert.equal(read(home), bytes)
  assert.equal(statSync(join(home, 'state.json')).mtimeMs, mtime)
  assert.equal(h.rt.state.reviewGuardMigrated, true)
  for (const id of ['fresh', 'orphan', 'plain']) assert.equal(h.rt.botOf(id).reviewGuardNotice, undefined, id)
  const color = await h.call('update-bot', { id: 'plain', color: 'blue' })
  assert.equal(color.ok, true, JSON.stringify(color))
  assert.equal(h.stored().reviewGuardMigrated, true)
})

test('RG-M3b a team already flagged is not migrated', async (t) => {
  const { home, open } = workspace(t, team(FIXTURE, { reviewGuardMigrated: true }))
  const bytes = read(home)
  const h = open()
  await h.rt.load()
  assert.equal(read(home), bytes)
  assert.equal(h.rt.botOf('solver').reviewGuard, undefined)
})

test('RG-M4 a person\'s OFF after the upgrade survives a restart', async (t) => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  const off = await h.call('update-bot', { id: 'solver', reviewGuard: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(h.stored().bots.solver.reviewGuard, undefined)
  assert.equal(h.stored().reviewGuardMigrated, true)
  await h.dispose()
  const second = open()
  await second.rt.load()
  assert.equal(second.rt.botOf('solver').reviewGuard, undefined)
  await second.dispose()
  const bytes = read(home)
  const third = open()
  await third.rt.load()
  assert.equal(read(home), bytes)
  assert.equal(third.rt.botOf('solver').reviewGuard, undefined)
})

test('RG-M5 a reviewer not on the team: neither the orphan nor a Solver whose reviewer was deleted is turned on', async (t) => {
  const { rev: _rev, ...withoutReviewer } = FIXTURE
  const { open } = workspace(t, team(withoutReviewer, { mainBotIds: ['plain'] }))
  const h = open()
  await h.rt.load()
  for (const id of ['solver', 'renamed', 'orphan']) assert.equal(h.rt.botOf(id).reviewGuard, undefined, id)
  assert.equal(h.rt.state.reviewGuardMigrated, true)
})

test('RG-M6 the marker is not read: a renamed Solver is migrated, a marker without a reviewer is not, nor a self-reviewer', async (t) => {
  const { open } = workspace(t, team({ ...FIXTURE, self: record('self', { role: 'Solver', reviewerId: 'self' }) }))
  const h = open()
  await h.rt.load()
  assert.equal(h.rt.botOf('renamed').reviewGuard, true)
  assert.equal(h.rt.botOf('fresh').reviewGuard, undefined)
  assert.equal(h.rt.botOf('self').reviewGuard, undefined)
})

test('RG-M7 corrupted records: no throw, the bad ones untouched, a bad flag runs once, a non-true field turns true', async (t) => {
  const bad = {
    seven: record('seven', { reviewerId: 7 }),
    object: record('object', { reviewerId: {} }),
    empty: record('empty', { reviewerId: '' }),
    proto: record('proto', { reviewerId: '__proto__' }),
    ctor: record('ctor', { reviewerId: 'constructor' }),
    toNull: record('toNull', { reviewerId: 'nullRev' }),
    falsy: record('falsy', { role: 'Solver', reviewerId: 'rev', reviewGuard: 'false' }),
  }
  const { open } = workspace(t, team({ ...FIXTURE, ...bad }, { reviewGuardMigrated: 'yes' }))
  const h = open()
  await h.rt.load()
  for (const id of ['seven', 'object', 'empty', 'proto', 'ctor', 'toNull']) {
    assert.equal(h.rt.botOf(id).reviewGuard, undefined, id)
    assert.equal(h.rt.botOf(id).reviewGuardNotice, undefined, id)
  }
  assert.equal(h.rt.botOf('falsy').reviewGuard, true)
  assert.equal(h.stored().reviewGuardMigrated, true)
})

test('RG-M8 Bots made after the upgrade follow their own create', async (t) => {
  const { open } = workspace(t)
  const h = open()
  await h.rt.load()
  assert.equal(h.rt.botOf('solver').reviewGuard, true)
  const made = await h.call('create-bot', { name: 'Later Solver', role: 'Solver', instructions: 'x', reviewerId: 'rev' })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal((await h.call('update-bot', { id: 'solver', reviewGuard: false })).ok, true)
  const copy = await h.call('duplicate-bot', { id: 'solver' })
  assert.equal(copy.ok, true, JSON.stringify(copy))
  await h.dispose()
  const second = open()
  await second.rt.load()
  assert.equal(second.rt.botOf(made.value.id).reviewGuard, undefined)
  assert.equal(second.rt.botOf(copy.value.id).reviewGuard, undefined)
  assert.equal(second.rt.botOf(copy.value.id).reviewGuardNotice, undefined)
})

test('RG-M9 a failed save at load keeps the guard in memory; the next save writes field and flag', async (t) => {
  const { home, open } = workspace(t)
  const statePath = join(home, 'state.json')
  mkdirSync(`${statePath}.${process.pid}.tmp`)
  const h = open()
  await h.rt.load()
  assert.ok(h.warnings.some(line => /saving the migrated Bot team failed/.test(line)))
  assert.equal(h.rt.botOf('solver').reviewGuard, true)
  assert.equal(h.stored().reviewGuardMigrated, undefined)
  await assert.rejects(h.guard({ name: 'write', callId: 'c1', arguments: { file_path: 'a.md' }, agent: { id: 'solver' } }), /review guard/)
  rmSync(`${statePath}.${process.pid}.tmp`, { recursive: true })
  await h.rt.save()
  assertMigrated(h.stored())
})

test('RG-M10 an outside write of an unflagged team adopted at reclaim migrates in memory; the next save writes the flag', async (t) => {
  const { home, open } = workspace(t, team({ plain: FIXTURE.plain }, { mainBotIds: ['plain'], reviewGuardMigrated: true }))
  const h = open()
  await h.rt.load()
  assert.equal(h.rt.readOnly(), undefined)
  write(home, team(FIXTURE, { revision: 17, prefs: { marker: randomUUID() } }))
  rmSync(join(home, 'state.lock'))
  await h.rt.refresh()
  assert.equal(h.rt.botOf('solver').reviewGuard, true)
  await h.rt.save()
  assertMigrated(h.stored())
})

const groupedRoom = (members = ['solver', 'rev']) => ({
  id: 'group', name: 'Planning', named: true, members, admin: 'rev', mode: 'everyone',
  sessions: { rev: 'group-reviewer' }, parts: [{ sessionId: 'older-group' }],
})
const guardTeam = (rooms, solver = FIXTURE.solver) => team(
  { ...FIXTURE, solver }, { rooms, reviewGuardMigrated: true },
)
const joinRefusal = "Bot solver has the review guard on, so it cannot join a group. To add it, turn the review guard off in Bot solver's Details first."

test('K-G1 / PD4C-1 refuses a group whose provisional Session was awaiting an ON switch', async (t) => {
  const h = workspace(t, guardTeam({})).open()
  await h.rt.load()
  const creating = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const archived = []
  t.after(() => resume.resolve())
  h.ctx.sessionController.create = async () => {
    creating.resolve()
    await resume.promise
    return { sessionId: 'provisional-room' }
  }
  h.ctx.workspaceRegistry.archiveSession = async id => { archived.push(id) }
  const create = h.call('create-room', { members: ['solver', 'rev'], section: 'Plans' })
  await Promise.race([creating.promise, create])
  const on = await h.call('update-bot', { id: 'solver', reviewGuard: true })
  resume.resolve()
  const result = await create
  assert.equal(on.ok, true)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/review-guard')
  assert.equal(result.error.message, joinRefusal)
  assert.deepEqual(h.rt.state.rooms, {})
  assert.deepEqual(h.stored().rooms, {})
  assert.deepEqual(h.rt.state.sections, [])
  assert.deepEqual(archived, ['provisional-room'])
})

test('K-G2 refuses ON for a grouped Bot with a valid reviewer', async (t) => {
  const room = groupedRoom()
  const h = workspace(t, guardTeam({ group: room })).open()
  await h.rt.load()
  const result = await h.call('update-bot', { id: 'solver', reviewGuard: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/review-guard')
  assert.equal(result.error.message, 'Bot solver is in a group (Planning), so its review guard cannot be turned on. Remove Bot solver from its groups (for a group of two, delete the group or add another Bot first), then turn the guard on.')
  assert.equal(h.rt.botOf('solver').reviewGuard, undefined)
  assert.equal(h.stored().bots.solver.reviewGuard, undefined)
  assert.deepEqual(h.stored().rooms.group, room)
})

test('K-G1 / PD4C-2 keeps ON effective while an OFF write fails', async (t) => {
  const room = groupedRoom(['plain', 'rev'])
  const h = workspace(t, guardTeam({ group: room }, { ...FIXTURE.solver, reviewGuard: true })).open()
  await h.rt.load()
  const writing = Promise.withResolvers()
  const resume = Promise.withResolvers()
  t.after(() => resume.resolve())
  const delay = async (save, ...args) => {
    writing.resolve()
    await resume.promise
    return save(...args)
  }
  const { save, saveCopy } = h.rt
  h.rt.save = options => options?.required ? delay(save, options) : save(options)
  h.rt.saveCopy = (...args) => delay(saveCopy, ...args)
  const off = h.call('update-bot', { id: 'solver', reviewGuard: false })
  await Promise.race([writing.promise, off])
  const held = h.rt.botOf('solver').reviewGuard
  const join = await h.call('update-room', { id: 'group', add: ['solver'] })
  const temp = `${h.rt.statePath}.${process.pid}.tmp`
  mkdirSync(temp)
  resume.resolve()
  const failed = await off
  rmSync(temp, { recursive: true })
  assert.equal(failed.ok, false)
  assert.equal(held, true)
  assert.equal(join.ok, false)
  assert.equal(join.error.code, 'bot/review-guard')
  assert.equal(join.error.message, joinRefusal)
  assert.equal(h.rt.botOf('solver').reviewGuard, true)
  assert.equal(h.stored().bots.solver.reviewGuard, true)
  assert.deepEqual(h.rt.state.rooms.group.members, room.members)
  assert.deepEqual(h.stored().rooms.group, room)
})

async function desktopGuardOffLine(bots, sessionId) {
  const { outputFiles } = await build({
    stdin: { contents: "export { GuardOffLine } from './src/client/cells.js'", resolveDir: import.meta.dirname + '/..' },
    bundle: true, platform: 'browser', logLevel: 'silent', format: 'cjs', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    require: name => name === 'react' ? {
      createContext: () => ({}),
      createElement: (type, props, ...children) => typeof type === 'function' ? type(props) : { type, props, children },
    } : new Proxy({}, { get: (_, key) => key }),
  })
  return module.exports.GuardOffLine({ sessionId, useRoster: select => select({ bots }) })
}

test('K-G3 / PD4C-5 persists one OFF line for the D1.5 Solver and never rewrites it on reopen', async (t) => {
  const historicalOn = { at: 1, sessionId: 'chat-solver' }
  const room = groupedRoom()
  const { home, open } = workspace(t, guardTeam(
    { group: room }, { ...FIXTURE.solver, reviewGuard: true, reviewGuardNotice: historicalOn },
  ))
  const first = open()
  await first.rt.load()
  const saved = first.stored()
  assert.equal(saved.bots.solver.reviewGuard, undefined)
  const notice = saved.bots.solver.guardOffNotice
  assert.equal(notice.kind, 'review-guard-off')
  assert.equal(notice.id, 'review-guard-off')
  assert.equal(notice.sessionId, 'chat-solver')
  assert.ok(Number.isFinite(notice.at))
  assert.equal(saved.guardGroupMigrated, true)
  assert.deepEqual(saved.bots.solver.reviewGuardNotice, historicalOn)
  assert.deepEqual(saved.rooms.group, room)
  await first.dispose()

  const path = join(home, 'state.json')
  utimesSync(path, 1, 1)
  const bytes = read(home)
  const mtime = statSync(path).mtimeMs
  const reopened = open()
  await reopened.rt.load()
  assert.equal(read(home), bytes)
  assert.equal(statSync(path).mtimeMs, mtime)
  assert.deepEqual(reopened.rt.botOf('solver').guardOffNotice, notice)
  assert.deepEqual(reopened.rt.roomOf('group'), room)

  const text = 'The review guard of Bot solver was turned off because Bot solver is in a group, and a Bot with the guard on cannot be in one. To turn it back on, remove Bot solver from its groups (for a group of two, delete the group or add another Bot first), then turn the guard on in its Details.'
  const desktop = await desktopGuardOffLine(Object.values(reopened.rt.state.bots), notice.sessionId)
  assert.equal(desktop.props['data-review-guard-notice'], notice.kind)
  assert.equal(desktop.children.length, 1)
  assert.equal(desktop.children[0], text)
  assert.equal(pocket.pocketGuardOffOf(reopened.rt, 'solver', 'group-reviewer'), undefined)
  const source = new pocket.DshChatSource({
    guardOffOf: (botId, sessionId) => pocket.pocketGuardOffOf(reopened.rt, botId, sessionId),
  })
  const entry = { botId: 'solver', sessionId: notice.sessionId, rows: [], floorSeq: 0, cursor: -1 }
  const { rows } = await source.snapshotFor(entry)
  assert.deepEqual(rows, [{
    id: 'dsh:chat-solver:0#review-guard-off', at: notice.at, turn: 0,
    source: 'session', kind: 'status', state: 'idle', msg: text,
  }])
  const resumed = await source.snapshotFor(entry, rows[0].id)
  assert.deepEqual(resumed.rows, rows)
})
