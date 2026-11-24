// #2056 (RFC 0048, delivery 1.5, PLAN-D15 §16): the one-time review guard migration (store adopt).
// Each D1 Solver whose reviewer Bot is on the team gets `reviewGuard: true` once, with its one chat
// line (`reviewGuardNotice`); a Solver with no reviewer Bot stays off; the marker is never read;
// nothing to change writes nothing; a person's later OFF stays off.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
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
