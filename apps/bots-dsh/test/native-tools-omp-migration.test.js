import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const OMP = 'acp-omp'
const record = (id, model, extra = {}) => ({ id, sessionId: id, name: 'Bot ' + id, model, createdAt: 1, capabilities: [], ...extra })
const beforeC = {
  version: 2, revision: 0, mainBotIds: ['a'],
  bots: {
    a: record('a', OMP + '/default'),
    b: record('b', undefined, { appliedModel: OMP + '/default' }),
    shell: record('shell', OMP + '/default', { shell: false }),
    deny: record('deny', OMP + '/default', { denyTools: ['bash'] }),
    explicit: record('explicit', OMP + '/default', { nativeTools: false }),
    claude: record('claude', 'acp-claude/default'),
    codex: record('codex', 'acp-codex/default'),
    api: record('api', 'deepseek/chat'),
  },
}
const write = (home, state) => writeFileSync(join(home, 'state.json'), JSON.stringify(state))
const read = home => readFileSync(join(home, 'state.json'), 'utf8')
const fields = bot => [bot.nativeTools, bot.nativeToolsKept]

function workspace(t, state = beforeC) {
  const home = mkdtempSync(join(tmpdir(), 'omp-migration-'))
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
  let identity
  const warnings = []
  const services = {
    acpAgents: {
      botIdentity: read => { identity = read; return () => {} },
      endClaudeSession() {},
      inspect: async () => ({ signedIn: true }),
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessionPersistence: {
      open: async () => { throw Object.assign(new Error('No Session'), { name: 'SessionPersistenceNotFoundError' }) },
    },
  }
  const ctx = fakeContext({ services })
  ctx.registry = new Map()
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  ctx.llm.listProviders = () => [{ id: OMP, name: 'omp' }]
  ctx.llm.listModels = async () => [{ id: 'default' }]
  ctx.llm.resolveModelInfo = async () => ({})
  ctx.workspaceRegistry = {
    get: () => undefined, resolveByPath: async () => undefined,
    create: async path => ({ id: 'team', path }), archiveSession: async () => {},
  }
  ctx.sessionController = {
    create: async () => ({ sessionId: 'new' }),
    resolveAgent: async id => ({ agent: { session: { id }, followup: () => {} } }),
    selectModel: async () => {},
  }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessions = { get: () => undefined, flush: async () => true }
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  const rt = createRuntime(ctx, { home })
  ctx.provide('omniTeam', rt)
  const dispose = () => ctx.dispose()
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  return { rt, dispose, warnings, call, identity: id => identity(id), stored: () => JSON.parse(read(home)) }
}

function assertMigrated(state, codexMarker) {
  assert.equal(state.nativeToolsOmpKept, true)
  assert.equal(state.nativeToolsCodexKept, codexMarker)
  for (const id of ['a', 'b']) assert.deepEqual(fields(state.bots[id]), [true, OMP])
  for (const id of ['shell', 'deny']) assert.deepEqual(fields(state.bots[id]), [undefined, undefined])
  assert.deepEqual(fields(state.bots.explicit), [false, undefined])
  for (const id of ['claude', 'codex', 'api']) assert.deepEqual(state.bots[id], beforeC.bots[id])
}

test('Q6 migrates existing omp model and appliedModel exactly once, preserving restrictions and other providers', async t => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  assertMigrated(h.stored(), undefined)
  assert.deepEqual(h.warnings.filter(line => line.includes('keep native tools off')), [
    'omni-ui: 2 omp Bot(s) keep native tools off: shell access off or denied tools',
  ])
  await h.dispose()
  const bytes = read(home)
  const second = open()
  await second.rt.load()
  assert.equal(read(home), bytes)
  assert.deepEqual(second.warnings.filter(line => line.includes('keep native tools off')), [])
})

for (const codexMarker of [undefined, true]) {
  test(`failed first migration save recovers on normal save and reopen (Codex marker ${codexMarker})`, async t => {
    const { home, open } = workspace(t, { ...beforeC, nativeToolsCodexKept: codexMarker })
    const blocker = join(home, 'state.json.' + process.pid + '.tmp')
    mkdirSync(blocker)
    const bytes = read(home)
    const h = open()
    await h.rt.load()
    assert.equal(read(home), bytes)
    assert.ok(h.warnings.some(line => line.includes('saving the migrated Bot team failed')))
    assertMigrated(h.rt.state, codexMarker)
    rmSync(blocker, { recursive: true })
    await h.rt.save()
    assertMigrated(h.stored(), codexMarker)
    await h.dispose()

    const second = open()
    await second.rt.load()
    assertMigrated(second.rt.state, codexMarker)
    const created = await second.rt.createBot({ name: 'New omp', model: OMP + '/default' })
    assert.equal(created.id, 'new')
    assert.equal(created.model, OMP + '/default')
    assert.deepEqual(fields(created), [undefined, undefined])
    await second.dispose()

    const third = open()
    await third.rt.load()
    assertMigrated(third.rt.state, codexMarker)
    assert.deepEqual(fields(third.rt.botOf('new')), [undefined, undefined])
  })
}

test('a reader migrates in memory, then adopts a saved OFF during takeover without re-enabling', async t => {
  const { home, open } = workspace(t)
  const lock = join(home, 'state.lock')
  const bytes = read(home)
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'fixture-owner' }))
  const reader = open()
  await reader.rt.load()
  assert.ok(reader.rt.readOnly())
  assert.equal(read(home), bytes)
  assertMigrated(reader.rt.state, undefined)

  write(home, { ...beforeC, nativeToolsOmpKept: true })
  rmSync(lock)
  await reader.rt.refresh()
  assert.equal(reader.rt.readOnly(), undefined)
  assert.deepEqual(fields(reader.rt.botOf('a')), [undefined, undefined])
})

test('owner OFF clears both fields across reopen and outside edits; restoring old state migrates again', async t => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  assert.deepEqual(fields(h.rt.botOf('a')), [true, OMP])
  const result = await h.call('update-bot', { id: 'a', nativeTools: false })
  assert.equal(result.ok, true, JSON.stringify(result))
  const saved = h.stored()
  assert.equal(saved.nativeToolsOmpKept, true)
  assert.deepEqual(fields(saved.bots.a), [undefined, undefined])
  await h.dispose()

  const second = open()
  await second.rt.load()
  assert.deepEqual(fields(second.rt.botOf('a')), [undefined, undefined])
  const lock = join(home, 'state.lock')
  write(home, { ...saved, revision: 17, prefs: { marker: 'outside edit' } })
  rmSync(lock)
  await second.rt.refresh()
  assert.equal(second.rt.state.prefs.marker, 'outside edit')
  assert.deepEqual(fields(second.rt.botOf('a')), [undefined, undefined])

  write(home, beforeC)
  rmSync(lock)
  await second.rt.refresh()
  assertMigrated(second.rt.state, undefined)
  await second.rt.save()
  assertMigrated(second.stored(), undefined)
})

test('identity carries the migrated provider, and an explicit ON or OFF clears the tag only on a successful save', async t => {
  const { home, open } = workspace(t)
  const h = open()
  await h.rt.load()
  assert.equal(h.identity('a').nativeTools, true)
  assert.equal(h.identity('a').nativeToolsAgent, OMP)
  const bot = h.rt.botOf('a')
  bot.model = 'acp-claude/default'
  await h.rt.save()
  const blocker = join(home, 'state.json.' + process.pid + '.tmp')
  mkdirSync(blocker)
  for (const nativeTools of [true, false]) {
    const failure = await h.call('update-bot', { id: 'a', nativeTools })
    assert.equal(failure.ok, false)
    assert.deepEqual(fields(bot), [true, OMP])
    assert.deepEqual(fields(h.stored().bots.a), [true, OMP])
  }
  rmSync(blocker, { recursive: true })
  const enabled = await h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(enabled.ok, true, JSON.stringify(enabled))
  assert.deepEqual(fields(bot), [true, undefined])
  assert.deepEqual(fields(h.stored().bots.a), [true, undefined])
  assert.equal(h.identity('a').nativeToolsAgent, undefined)
})
