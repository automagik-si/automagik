import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { solverInstructions } from '../src/shared/solver-method.js'
import { immediate, until } from './until.js'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { teamActions } from '../src/client/team-actions.js'
import { MCP_PATH } from '../src/host/agent-access.js'
import { ROUTE } from '../src/host/constants.js'
import { installRoles } from '../src/host/roles.js'
import { fakeContext } from './fake-ctx.js'
import { entryOf, INDEX, manifestOf, packageOf, SHA256, SIGNATURE, VERSION as PLUGIN_VERSION, signer, solverCutHistory } from './role-fixture.js'

const ID = 'sample-role'
const VERSION = '1.0.0'
const BOT = { id: 'test-bot', name: 'Fixture', sessionId: 'test-bot', createdAt: 1, role: 'Description', instructions: 'Help in chat.', capabilities: [] }
const openRole = { id: ID }
const stateOf = extra => ({
  version: 1, revision: 1, workspaceId: 'fixture', mainBotIds: [BOT.id],
  bots: { [BOT.id]: BOT }, rooms: {}, ...extra,
})
const missing = async path => assert.rejects(fs.lstat(path), { code: 'ENOENT' })
const clock = Date.UTC(2026, 10, 20)

async function fixture(t, { bytes, entry, extra, readOnly, offline = false, roleDeps } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'ds-bot-role-package-'))
  const statePath = join(home, 'state.json')
  const rolesDir = join(home, 'roles')
  const marker = join(home, 'package-ran')
  const script = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`
  const manifest = manifestOf({ futureField: true })
  bytes ??= packageOf(manifest, script)
  entry ??= entryOf(bytes)
  const pkgDir = join(rolesDir, entry.id)
  const verDir = join(pkgDir, entry.version)
  const { key, index } = signer()
  const signed = index([entry])
  const paths = new Map([
    [INDEX, () => offline ? new Response(null, { status: 404 }) : new Response(signed.bytes)],
    [SIGNATURE, () => new Response(signed.signature)],
    [entry.source, () => new Response(bytes)],
  ])
  const fetches = []
  const fsCalls = []
  const hooks = {}
  const injectedFs = new Proxy(fs, { get(target, property) {
    if (!['mkdir', 'mkdtemp', 'rename', 'open', 'rm', 'rmdir', 'lstat'].includes(property)) return target[property]
    return (...args) => {
      fsCalls.push([property, ...args])
      return (hooks[property] ?? target[property])(...args)
    }
  } })
  const contexts = new Set()
  t.after(async () => {
    for (const ctx of contexts) await ctx.dispose()
    await fs.rm(home, { recursive: true, force: true })
  })
  await fs.writeFile(statePath, JSON.stringify(stateOf(extra)))
  if (readOnly) {
    await fs.writeFile(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'fixture-holder' }))
  }

  async function start() {
    const ctx = fakeContext({ services: {
      sessionPersistence: { open: async () => ({ read: async () => ({ events: [{
        type: 'request/header', data: { header: { config: { provider: 'test-provider', model: 'fixture' } } },
      }] }) }) },
    } })
    contexts.add(ctx)
    const routes = new Map()
    const registrations = new Set(['schedule_create', 'schedule_edit'])
    ctx.connection.fetch.register = route => { routes.set(route.path, route); return () => {} }
    ctx.tools.view = () => ({ restrictableNames: registrations, knownNames: registrations })
    ctx.tools.schemas = () => [...registrations].map(name => ({ name }))
    ctx.workspaceRegistry = { get: () => ({ id: 'fixture', path: home }), archiveSession: async () => {} }
    ctx.sessions = { get: () => undefined, flush: async () => {} }
    ctx.sessionTitle = { rename: async () => {} }
    const agent = { id: BOT.id, session: { id: BOT.id }, ctx: { tools: { register: () => () => {}, restrict: () => () => {} } } }
    let created = 0
    ctx.sessionController = {
      resolveAgent: async id => ({ agent: !roleDeps || id === BOT.id ? agent
        : { ...agent, id, session: { id }, followup() {}, inject() {}, steer() {} } }),
      ...(roleDeps ? { create: async () => ({ sessionId: `created-${++created}` }), selectModel: async () => {} } : {}),
    }
    apply(ctx, { home, memory: false, browser: false, updateCheck: false, mainName: BOT.name })
    const rt = ctx.provided.get('omniTeam')
    installRoles(rt, {
      ...roleDeps, keys: [key], now: () => clock, fs: injectedFs,
      fetch: async (url, init) => {
        fetches.push(url)
        assert.equal(init.redirect, 'manual')
        assert.ok(paths.has(url), 'unexpected fixture URL')
        return paths.get(url)()
      },
    })
    await rt.load()
    if (roleDeps) rt.solverSettle?.adopted()
    const post = (path, body, headers) => routes.get(path).fetch(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })).then(response => response.json())
    const call = (endpoint, payload) => post(ROUTE, { endpoint, payload })
    const close = async () => { contexts.delete(ctx); await ctx.dispose() }
    const botBehavior = async () => {
      const layer = ctx.listeners.get('system-prompt/assemble').find(fn => fn.name === 'scopeTeamTools')
      const prompt = await layer({}, { agent }, async () => ({ sections: [] }))
      const identity = ctx.sections.get('bot-identity').text({ agent })
      const state = (await call('state')).value
      const bots = state.bots.map(bot => ({ ...bot, lastAt: bot.lastAt ?? 0, preview: bot.preview ?? '' }))
      return { prompt, identity, tools: ctx.tools.schemas(agent), bots, defaultRole: state.prefs.roles }
    }
    return { ctx, rt, call, post, close, botBehavior }
  }

  const host = await start()
  const disk = async () => JSON.parse(await fs.readFile(statePath, 'utf8'))
  const install = (payload = openRole) => host.call('role-install', payload)
  const uninstall = (payload = openRole) => host.call('role-uninstall', payload)
  const record = overrides => ({
    id: entry.id, version: entry.version, publisher: entry.publisher, sha256: entry.sha256,
    installedAt: new Date(clock).toISOString(), source: entry.source, ...overrides,
  })
  const materialize = async (scriptOnDisk = script) => {
    await fs.mkdir(join(verDir, 'lib'), { recursive: true })
    await fs.writeFile(join(verDir, 'role.json'), JSON.stringify(manifest))
    await fs.writeFile(join(verDir, 'lib', 'main.mjs'), scriptOnDisk)
    await fs.writeFile(join(verDir, 'prompt.md'), 'Fixture prompt.')
  }
  return { ...host, home, statePath, rolesDir, pkgDir, verDir, marker, manifest, start, disk, install, uninstall, record,
    materialize, paths, fetches, fsCalls, hooks, entry, script }
}

const refused = (reply, message) => {
  assert.equal(reply.ok, false)
  assert.match(reply.error.message, message)
}
const mutations = f => f.fsCalls.filter(([method, , flags]) => ['mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir'].includes(method) || (method === 'open' && flags === 'wx'))

test('owner POST installs the signed selection, is idempotent, and leaves Bots and the package entry dormant', async t => {
  const f = await fixture(t)
  const before = await f.botBehavior()
  const firstView = (await f.call('state')).value
  assert.deepEqual(firstView.roleCatalog, { available: false, roles: [] })
  assert.deepEqual(f.fetches, [])
  const catalog = await f.call('role-catalog')
  assert.equal(catalog.value.available, true)
  const poll = { since: firstView.revision, live: firstView.liveKey }
  const catalogPoll = (await f.call('state', poll)).value
  assert.equal(catalogPoll.unchanged, true)
  assert.notEqual(catalogPoll.liveKey, firstView.liveKey)
  assert.deepEqual(catalogPoll.roleCatalog, catalog.value)
  assert.deepEqual((await f.call('state', { ...poll, live: catalogPoll.liveKey })).value,
    { revision: firstView.revision, unchanged: true, liveKey: catalogPoll.liveKey })
  const result = await f.install({ ...openRole, version: '2.0.0', sha256: 'untrusted', source: 'https://example.test', url: 'https://example.test' })
  assert.deepEqual(result, { ok: true, value: { id: ID, version: VERSION, warnings: ['futureField'] } })
  assert.deepEqual(f.fetches, [INDEX, SIGNATURE, f.entry.source])
  const record = (await f.disk()).roles[ID]
  assert.deepEqual(record, f.record())
  for (const [file, contents] of [['role.json', JSON.stringify(f.manifest)], ['lib/main.mjs', f.script], ['prompt.md', 'Fixture prompt.']]) {
    assert.equal(await fs.readFile(join(f.verDir, file), 'utf8'), contents)
    if (process.platform !== 'win32') assert.equal((await fs.stat(join(f.verDir, file))).mode & 0o777, 0o600)
  }
  if (process.platform !== 'win32') {
    for (const dir of [f.rolesDir, f.pkgDir, f.verDir, join(f.verDir, 'lib')]) {
      assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
    }
  }
  const view = (await f.call('state')).value
  assert.deepEqual(view.roles, { [ID]: { id: ID, version: VERSION, publisher: 'automagik', installedAt: record.installedAt, status: 'ok' } })
  const revision = (await f.disk()).revision
  const mutationCount = mutations(f).length
  assert.deepEqual(await f.install(), result)
  assert.equal((await f.disk()).revision, revision)
  assert.equal(mutations(f).length, mutationCount)
  assert.deepEqual(await f.botBehavior(), before)
  await missing(f.marker)

  await f.close()
  const reload = await f.start()
  assert.deepEqual((await reload.call('state')).value.roles, view.roles)
  assert.deepEqual(await reload.botBehavior(), before)
  await missing(f.marker)
  const fetchCount = f.fetches.length
  assert.deepEqual(await reload.call('role-uninstall', openRole), { ok: true, value: { removed: true } })
  assert.equal(f.fetches.length, fetchCount)
  await missing(f.marker)
})

test('refuses invalid downloads and manifests before the first package filesystem mutation', async t => {
  const cases = [
    ['sha256', manifestOf(), { sha256: 'aa'.repeat(32) }, /checksum/],
    ['size', manifestOf(), { size: packageOf().length + 1 }, /size/],
    ['manifest version', manifestOf({ version: '1.0.1' }), {}, /version/],
    ['manifest id', manifestOf({ id: 'different' }), {}, /id/],
    ['manifest publisher', manifestOf({ publisher: 'Elsewhere' }), {}, /publisher/],
    ['capability unknown', manifestOf({ capabilities: ['unknown'] }), {}, /capabilities/],
    ['capability mismatch', manifestOf({ capabilities: ['history-read'] }), {}, /capabilities/],
    ['capability duplicate', manifestOf({ capabilities: ['audio-out', 'audio-out'] }), {}, /capabilities/],
    ['required feature', manifestOf({ requires: ['future'] }), {}, /not supported yet/],
    ['settings', manifestOf({ settings: [{ kind: 'test' }] }), {}, /not supported yet/],
    ['ui', manifestOf({ ui: [{ kind: 'test' }] }), {}, /not supported yet/],
    ['required field', manifestOf({ tools: undefined }), {}, /tools/],
    ['unsafe entry', manifestOf({ entry: 'lib/../main.mjs' }), {}, /entry file/],
    ['unsafe prompt', manifestOf({ prompt: 'AUX.md' }), {}, /prompt file/],
    ['invalid tool', manifestOf({ tools: [{ name: 'fixture', description: 'Example', parameters: [] }] }), {}, /tools/],
  ]
  for (const [name, manifest, fields, error] of cases) await t.test(name, async t => {
    const bytes = packageOf(manifest)
    const f = await fixture(t, { bytes, entry: entryOf(bytes, fields) })
    refused(await f.install(), error)
    await missing(f.rolesDir)
    assert.deepEqual(f.fsCalls, [])
    assert.equal((await f.disk()).roles, undefined)
  })
})

test('refuses role IDs outside the index, community entries, and direct install with roles off', async t => {
  const f = await fixture(t)
  refused(await f.install({ id: 'data' }), /Unknown role/)
  refused(await f.install({ id: 'con' }), /Unknown role/)
  refused(await f.install({ id: ['sample-role'] }), /Unknown role/)
  refused(await f.install({ id: 'constructor' }), /not in the catalog/)
  refused(await f.install({ id: 'absent' }), /not in the catalog/)
  assert.deepEqual(f.fetches, [INDEX, SIGNATURE])
  assert.deepEqual(f.fsCalls, [])
  const community = await fixture(t, { entry: entryOf(undefined, { official: false }) })
  refused(await community.install(), /Community roles/)
  assert.deepEqual(community.fetches, [INDEX, SIGNATURE])
  assert.deepEqual(community.fsCalls, [])
  const off = await fixture(t, { extra: { prefs: { roles: false } } })
  refused(await off.install(), /turned off/)
  assert.deepEqual(off.fetches, [])
  assert.deepEqual(off.fsCalls, [])
})

test('supports constructor as an own install record and reports a missing version folder after restart', async t => {
  const bytes = packageOf(manifestOf({ id: 'constructor' }))
  const f = await fixture(t, { bytes, entry: entryOf(bytes, { id: 'constructor' }) })
  assert.equal((await f.install({ id: 'constructor' })).ok, true)
  assert.equal((await f.disk()).roles.constructor.id, 'constructor')
  await fs.rm(f.verDir, { recursive: true })
  await f.close()
  const reload = await f.start()
  assert.equal((await reload.call('state')).value.roles.constructor.status, 'broken')
  assert.equal((await reload.call('role-uninstall', { id: 'constructor' })).value.removed, true)
  assert.deepEqual((await f.disk()).roles, {})
})

test('explicit reinstall checks exact bytes and marks damage without rewriting the package', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  const before = (await f.call('state')).value
  await fs.unlink(join(f.verDir, 'prompt.md'))
  const count = mutations(f).length
  refused(await f.install(), /damaged. Uninstall it first/)
  await missing(join(f.verDir, 'prompt.md'))
  const poll = (await f.call('state', { since: before.revision, live: before.liveKey })).value
  assert.equal(poll.revision, before.revision)
  assert.equal(poll.unchanged, true)
  assert.equal(poll.roles[ID].status, 'damaged')
  assert.equal(mutations(f).length, count)
  assert.equal((await f.uninstall()).value.removed, true)
  assert.equal((await f.install()).ok, true)
})

test('the first view detects edits of the same size using the just-installed archive', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  await fs.writeFile(join(f.verDir, 'prompt.md'), 'Changed prompt.')
  assert.equal((await f.call('state')).value.roles[ID].status, 'damaged')
  assert.deepEqual(f.fetches, [INDEX, SIGNATURE, f.entry.source])
})

test('refuses conflicting records for the same or another version before downloading a package', async t => {
  const bytes = packageOf()
  const entry = entryOf(bytes)
  for (const [fields, error] of [[{ sha256: 'aa'.repeat(32) }, /conflicts/], [{ version: '2.0.0' }, /Another version/]]) {
    const f = await fixture(t, { bytes, entry, extra: { roles: { [ID]: { ...entry, ...fields } } } })
    refused(await f.install(), error)
    assert.deepEqual(f.fetches, [INDEX, SIGNATURE])
    assert.deepEqual(f.fsCalls, [])
  }
})

test('adopts an exact orphan online and leaves mismatching and foreign folders in place', async t => {
  const f = await fixture(t)
  await f.materialize('edited')
  const foreign = join(f.rolesDir, '.staging-foreign')
  await fs.mkdir(foreign)
  await fs.utimes(foreign, new Date(0), new Date(0))
  refused(await f.install(), /A folder is in the way/)
  assert.equal(await fs.readFile(join(f.verDir, 'lib/main.mjs'), 'utf8'), 'edited')
  assert.equal((await f.disk()).roles, undefined)
  assert.deepEqual(mutations(f), [])
  await f.materialize()
  await fs.mkdir(join(f.verDir, 'extra'))
  refused(await f.install(), /A folder is in the way/)
  await fs.rmdir(join(f.verDir, 'extra'))
  assert.equal((await f.install()).ok, true)
  assert.deepEqual((await f.disk()).roles[ID], f.record())
  assert.equal((await fs.stat(foreign)).isDirectory(), true)
  assert.deepEqual(mutations(f), [])
  assert.ok(f.fsCalls.some(([method, , flags]) => method === 'open' && flags === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))))
})

test('refuses linked parents and leaves a version containing a linked file as a reported leftover', { skip: process.platform === 'win32' && 'requires POSIX symlinks' }, async t => {
  const f = await fixture(t)
  const alternate = join(f.home, 'alternate')
  await fs.mkdir(alternate)
  await fs.symlink(alternate, f.rolesDir)
  refused(await f.install(), /A folder is in the way/)
  assert.deepEqual(await fs.readdir(alternate), [])
  assert.deepEqual(mutations(f), [])
  await fs.unlink(f.rolesDir)
  assert.equal((await f.install()).ok, true)
  await fs.unlink(join(f.verDir, 'prompt.md'))
  await fs.symlink(alternate, join(f.verDir, 'prompt.md'))
  assert.deepEqual((await f.uninstall()).value, { removed: false, leftover: f.verDir })
  assert.equal((await fs.lstat(join(f.verDir, 'prompt.md'))).isSymbolicLink(), true)
  assert.equal((await fs.stat(alternate)).isDirectory(), true)
})

test('read-only and lockless hosts cannot fetch or mutate, including a lock lost during download', async t => {
  const reader = await fixture(t, { readOnly: true })
  assert.match((await reader.call('state')).value.readOnly, /open in another dsh/)
  assert.deepEqual((await reader.call('role-catalog')).value, { available: false, reason: 'read-only', roles: [] })
  assert.equal((await reader.install()).error.code, 'bot/read-only')
  assert.equal((await reader.uninstall()).error.code, 'bot/read-only')
  assert.deepEqual(reader.fetches, [])
  assert.deepEqual(reader.fsCalls, [])

  const lockless = await fixture(t)
  lockless.rt.holdsLock = () => false
  refused(await lockless.install(), /does not hold the Bot team/)
  refused(await lockless.uninstall(), /does not hold the Bot team/)
  assert.equal((await lockless.call('role-catalog')).value.reason, 'read-only')
  assert.deepEqual(lockless.fetches, [])
  assert.deepEqual(lockless.fsCalls, [])

  const f = await fixture(t)
  const download = f.paths.get(f.entry.source)
  f.paths.set(f.entry.source, () => {
    f.rt.holdsLock = () => false
    return download()
  })
  refused(await f.install(), /does not hold the Bot team/)
  assert.deepEqual(f.fetches, [INDEX, SIGNATURE, f.entry.source])
  assert.deepEqual(f.fsCalls, [])
  await missing(f.rolesDir)
})

test('only a known pre-commit refusal rolls back a folder created by this install', async t => {
  const f = await fixture(t)
  const save = f.rt.saveCopy
  const holds = f.rt.holdsLock
  f.rt.saveCopy = (change, options) => save(change, {
    ...options,
    beforeCommit() {
      f.rt.holdsLock = () => false
      try { options.beforeCommit() } finally { f.rt.holdsLock = holds }
    },
  })
  refused(await f.install(), /does not hold the Bot team/)
  await missing(f.verDir)
  await missing(f.pkgDir)
  assert.equal((await f.disk()).roles, undefined)
})

test('a publication failure cleans its own staging directory and writes no record', async t => {
  const f = await fixture(t)
  f.hooks.rename = () => { throw new Error('injected publication failure') }
  assert.equal((await f.install()).ok, false)
  assert.deepEqual(await fs.readdir(f.rolesDir), [])
  assert.equal((await f.disk()).roles, undefined)
})

test('an ambiguous save failure leaves a verified orphan and a failure after write preserves the recorded package', async t => {
  for (const committed of [false, true]) {
    const f = await fixture(t)
    const save = f.rt.saveCopy
    f.rt.saveCopy = async (...args) => {
      if (committed) await save(...args)
      throw new Error('injected save failure')
    }
    assert.deepEqual(await f.install(), { ok: true, value: { installed: false, leftover: f.verDir } })
    assert.equal((await fs.stat(f.verDir)).isDirectory(), true)
    assert.deepEqual((await f.disk()).roles?.[ID], committed ? f.record() : undefined)
    if (committed) assert.deepEqual(f.rt.state.roles[ID], f.record())
    f.rt.saveCopy = save
    const count = mutations(f).length
    assert.equal((await f.install()).ok, true)
    assert.equal(mutations(f).length, count)
    assert.deepEqual((await f.disk()).roles[ID], f.record())
  }
})

test('serializes concurrent installs and install versus uninstall', async t => {
  const f = await fixture(t)
  await f.call('state')
  const revision = (await f.disk()).revision
  const installed = await Promise.all([f.install(), f.install()])
  assert.ok(installed.every(result => result.ok))
  assert.equal((await f.disk()).revision, revision + 1)
  assert.equal(f.fsCalls.filter(([method]) => method === 'rename').length, 1)
  assert.equal((await f.uninstall()).ok, true)
  const response = f.paths.get(f.entry.source)
  let release
  let arrived
  const downloading = new Promise(resolve => { arrived = resolve })
  f.paths.set(f.entry.source, () => new Promise(resolve => {
    release = () => resolve(response())
    arrived()
  }))
  const install = f.install()
  await downloading
  const uninstall = f.uninstall()
  release()
  assert.equal((await install).ok, true)
  assert.deepEqual((await uninstall).value, { removed: true })
  assert.deepEqual((await f.disk()).roles, {})
  await missing(f.verDir)
})

test('uninstall works offline and with roles off, respects persisted raw attachments, and keeps per-Bot data and other versions', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  const data = ['one', 'two'].map(bot => join(f.rolesDir, 'data', bot, ID))
  const unrelatedVersion = join(f.pkgDir, '9.0.0')
  for (const dir of [...data, unrelatedVersion]) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'sentinel'), 'keep')
  }
  await f.close()
  const disk = await f.disk()
  disk.prefs = { ...disk.prefs, roles: false }
  disk.bots[BOT.id].roles = [{ id: ID }]
  await fs.writeFile(f.statePath, JSON.stringify(disk))
  const reload = await f.start()
  f.paths.clear()
  const fetchCount = f.fetches.length
  refused(await reload.call('role-uninstall', openRole), /Detach this role/)
  assert.equal((await fs.stat(f.verDir)).isDirectory(), true)
  await reload.close()
  disk.bots[BOT.id].roles = []
  await fs.writeFile(f.statePath, JSON.stringify(disk))
  const detached = await f.start()
  assert.deepEqual((await detached.call('role-uninstall', openRole)).value, { removed: true })
  assert.equal(f.fetches.length, fetchCount)
  assert.deepEqual((await f.disk()).roles, {})
  await missing(f.verDir)
  for (const dir of [...data, unrelatedVersion]) assert.equal(await fs.readFile(join(dir, 'sentinel'), 'utf8'), 'keep')
})

test('a package removal failure reports a leftover after deleting the record', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  f.hooks.rm = () => { throw Object.assign(new Error('injected failure'), { code: 'EACCES' }) }
  assert.deepEqual(await f.uninstall(), { ok: true, value: { removed: false, leftover: f.verDir } })
  assert.equal((await fs.stat(f.verDir)).isDirectory(), true)
  assert.deepEqual((await f.disk()).roles, {})
  assert.deepEqual((await f.call('state')).value.roles, {})
})

test('damaged records are projected safely and uninstall never derives a path from them', async t => {
  const record = { id: ID, version: VERSION, publisher: 'automagik', sha256: 'ab'.repeat(32), source: 'private' }
  const f = await fixture(t, { extra: { roles: {
    [ID]: { ...record, version: '../data' },
    data: { ...record, id: 'data' },
    other: record,
    baddigest: { ...record, id: 'baddigest', sha256: 'bad' },
  } } })
  const view = (await f.call('state')).value.roles
  assert.ok(Object.values(view).every(role => role.status === 'damaged'))
  assert.equal(Object.hasOwn(view[ID], 'source'), false)
  assert.equal(Object.hasOwn(view[ID], 'sha256'), false)
  for (const id of Object.keys(view)) assert.equal((await f.uninstall({ id })).value.removed, true)
  assert.deepEqual((await f.disk()).roles, {})
  assert.deepEqual(f.fsCalls, [])
  const array = await fixture(t, { extra: { roles: [{ ...record, id: '0' }] } })
  assert.equal((await array.call('state')).value.roles[0].status, 'damaged')
  assert.equal((await array.uninstall({ id: '0' })).value.removed, true)
  assert.deepEqual((await array.call('state')).value.roles, {})
  assert.deepEqual(array.fsCalls, [])
})

test('MCP neither lists nor calls package actions', async t => {
  const f = await fixture(t)
  await f.rt.agentAccess.owner('view')
  const token = 'role-mcp-fixture'
  await fs.writeFile(join(f.home, 'agent-tokens.json'), JSON.stringify([
    { id: 'fixture', name: 'MCP fixture', hash: SHA256(token) },
  ]), { mode: 0o600 })
  const rpc = (method, params) => f.post(MCP_PATH, { jsonrpc: '2.0', id: 1, method, params }, {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
  })
  const listed = (await rpc('tools/list')).result.tools
  for (const endpoint of ['role-install', 'role-uninstall']) {
    assert.equal(listed.some(tool => [endpoint, endpoint.replace('-', '_')].includes(tool.name)), false)
    for (const name of [endpoint, endpoint.replace('-', '_')]) {
      const reply = await rpc('tools/call', { name, arguments: openRole })
      assert.ok(reply.error || reply.result?.isError)
    }
  }
  assert.deepEqual(f.fetches, [])
  assert.deepEqual(f.fsCalls, [])
})

test('MCP and agent tools cannot grant a role or write its settings', async t => {
  const f = await fixture(t)
  await f.rt.agentAccess.owner('view')
  const token = 'role-runtime-mcp-fixture'
  await fs.writeFile(join(f.home, 'agent-tokens.json'), JSON.stringify([
    { id: 'fixture', name: 'MCP fixture', hash: SHA256(token) },
  ]), { mode: 0o600 })
  const rpc = (method, params) => f.post(MCP_PATH, { jsonrpc: '2.0', id: 1, method, params }, {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
  })
  const listed = (await rpc('tools/list')).result.tools
  for (const endpoint of ['role-grant', 'role-settings', 'role-settings-set']) {
    for (const name of [endpoint, endpoint.replaceAll('-', '_')]) {
      assert.equal(listed.some(tool => tool.name === name), false)
      assert.equal(f.ctx.registeredTools.has(name), false)
      const reply = await rpc('tools/call', { name, arguments: { id: BOT.id } })
      assert.ok(reply.error || reply.result?.isError)
    }
  }
  const update = listed.find(tool => tool.name === 'update_bot')
  assert.equal(Object.hasOwn(update.inputSchema.properties, 'grants'), false)
  assert.equal(Object.hasOwn(update.inputSchema.properties, 'roles'), false)
  const proposal = f.ctx.registeredTools.get('propose_bot_change')
  assert.equal(Object.hasOwn(proposal.parameters.properties, 'grants'), false)
  assert.equal(Object.hasOwn(proposal.parameters.properties, 'roles'), false)
})

async function loadSettings() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/bot-settings.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  let hooks
  const effect = (callback, deps) => {
    const i = hooks.index++
    const previous = hooks.slots[i]
    if (!previous || deps.some((dep, index) => dep !== previous[index])) hooks.effects.push(callback)
    hooks.slots[i] = deps
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState: initial => {
      const { slots, index } = hooks
      hooks.index++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = value }]
    },
    useEffect: effect, useLayoutEffect: effect, useMemo: make => make(), useCallback: fn => fn,
    useRef: current => hooks.slots[hooks.index++] ??= { current }, useId: () => 'id', Fragment: Symbol('Fragment'),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  })
  const trees = new Map()
  return (roster, actions, run) => {
    const render = (key, element) => {
      if (!trees.has(key)) trees.set(key, { slots: [] })
      hooks = trees.get(key)
      hooks.index = 0
      hooks.effects = []
      const node = element()
      for (const callback of hooks.effects) callback()
      return node
    }
    const tree = render('form', () => module.exports.BotSettingsForm({ bot: BOT, roster, actions, run }))
    const packages = findNode(tree, node => node.type?.name === 'RolePackagesCard')
    const card = packages && render('roles', () => packages.type(packages.props))
    const picker = findNode(tree, node => node.type?.name === 'Segmented' && node.props.label === 'Role')
    return { card, picker }
  }
}

function findNode(tree, test) {
  if (Array.isArray(tree)) {
    for (const branch of tree) {
      const node = findNode(branch, test)
      if (node) return node
    }
  } else if (tree && typeof tree === 'object') {
    return test(tree) ? tree : findNode(tree.props?.children, test)
  }
  return undefined
}

test('mounted settings discover a missing catalog once, preserve the picker, and leave the team revision alone', async t => {
  const f = await fixture(t, { offline: true })
  let roster = (await f.call('state')).value
  const revision = roster.revision
  const ownerCalls = []
  const pending = []
  const actions = teamActions({
    call: async (endpoint, payload) => {
      ownerCalls.push(endpoint)
      return (await f.call(endpoint, payload)).value
    },
    after: async work => {
      const value = await work
      roster = (await f.call('state')).value
      return value
    },
  })
  const settings = await loadSettings()
  actions.refreshModels = undefined
  const run = work => { pending.push(work); return work }
  const first = settings(roster, actions, run)
  assert.equal(first.card, null)
  await Promise.all(pending)
  assert.deepEqual(roster.roleCatalog, { available: false, reason: 'none', roles: [] })
  assert.equal(roster.revision, revision)
  assert.equal((await f.disk()).revision, revision)
  const settled = settings(roster, actions, run)
  assert.equal(settled.card, null)
  const picker = value => Array.from(value.props.children, button => [button.props.children[0], button.props['aria-pressed'], button.props.disabled])
  assert.deepEqual(picker(settled.picker), picker(first.picker))
  assert.deepEqual(ownerCalls, ['role-catalog'])
  assert.deepEqual(f.fetches, [INDEX])
})

test('the settings card posts owner actions and renders warnings, attachment and removal status', async t => {
  const f = await fixture(t)
  let roster = (await f.call('state')).value
  const posted = []
  const pending = []
  const actions = teamActions({
    call: async (endpoint, payload) => {
      posted.push([endpoint, payload])
      const res = await f.call(endpoint, payload)
      assert.equal(res.ok, true, res.error?.message)
      return res.value
    },
    after: async work => {
      const value = await work
      roster = (await f.call('state')).value
      return value
    },
  })
  const settings = await loadSettings()
  actions.refreshModels = undefined
  const run = work => { pending.push(work); return work }
  const button = (card, label) => findNode(card, node => node.type === 'button' && node.props.children.includes(label))
  const note = (card, message) => findNode(card, node => node.props?.children.includes(message))
  assert.equal(settings(roster, actions, run).card, null)
  await Promise.all(pending)
  const { card } = settings(roster, actions, run)
  assert.equal(card.props.title, 'Roles')
  await button(card, 'Install').props.onClick()
  assert.deepEqual(posted, [['role-catalog', undefined], ['role-install', openRole]])
  assert.equal((await f.disk()).roles[ID].id, ID)
  const installed = settings(roster, actions, run).card
  assert.ok(note(installed, 'Ignored role manifest field: futureField'))
  const attached = { ...roster, bots: [{ ...BOT, roles: [{ id: ID }] }] }
  const locked = settings(attached, actions, run).card
  assert.equal(button(locked, 'Uninstall').props.disabled, true)
  assert.match(findNode(locked, node => typeof node.props?.hint === 'string' && node.props.hint).props.hint, /Detach this role/)
  const recordOnly = { ...roster, roleCatalog: { available: false, roles: [] }, roles: { [ID]: { ...roster.roles[ID], status: 'broken' } } }
  const broken = settings(recordOnly, actions, run).card
  assert.ok(button(broken, 'Uninstall'))
  assert.ok(findNode(broken, node => node.props?.hint === 'Broken'))
  const community = { ...roster, roles: {}, roleCatalog: { ...roster.roleCatalog,
    roles: roster.roleCatalog.roles.map(role => ({ ...role, installable: false, reason: 'community' })),
  } }
  assert.ok(findNode(settings(community, actions, run).card, node => node.props?.hint === 'Community: not installable yet'))
  f.hooks.rm = () => { throw new Error('fixture cannot remove package') }
  await button(installed, 'Uninstall').props.onClick()
  assert.deepEqual(posted.at(-1), ['role-uninstall', openRole])
  assert.ok(note(settings(roster, actions, run).card, `Role package folder left at ${f.verDir}.`))
})

// After a restart the host no longer holds the verified file digests, so a same-size edit is
// caught by the next explicit reinstall against the signed archive, not by the status poll.
test('a restarted host catches a same-size package file edit on reinstall', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  await f.close()
  await fs.writeFile(join(f.verDir, 'prompt.md'), 'Changed prompt.')
  const reload = await f.start()
  refused(await reload.call('role-install', { id: ID }), /damaged. Uninstall it first/)
  assert.equal((await reload.call('state')).value.roles[ID].status, 'damaged')
})

const attachTo = (f, id = BOT.id, role = ID) => f.call('role-attach', { id, role })
const detachFrom = (f, id = BOT.id) => f.call('role-detach', { id })
const pinOf = (id = ID, version = VERSION) => ({ id, version, attachedAt: new Date(clock).toISOString(), grants: [] })
const fixtureBot = (id, extra = {}) => ({ ...BOT, id, sessionId: id, ...extra })

test('attaches an inert, pinned role to the ordinary Main Bot and preserves the unrelated disk record', async t => {
  const other = fixtureBot('other-fixture', { instructions: 'Unrelated fixture.' })
  const f = await fixture(t, { extra: { bots: { [BOT.id]: BOT, [other.id]: other } } })
  const otherBytes = async () => JSON.stringify((await f.disk()).bots[other.id])
  const before = await otherBytes()
  refused(await attachTo(f), /^Unknown role$/)
  assert.equal((await f.install()).ok, true)
  const behavior = await f.botBehavior()
  assert.deepEqual(await attachTo(f), { ok: true, value: [ID] })
  assert.equal(await otherBytes(), before)
  const disk = await f.disk()
  assert.deepEqual(disk.bots[BOT.id].roles, [pinOf()])
  assert.deepEqual(f.rt.state.bots[BOT.id].roles, disk.bots[BOT.id].roles)
  const attached = await f.botBehavior()
  assert.deepEqual(attached.prompt, behavior.prompt)
  const rolePrompt = '\n\n<role-prompt id="sample-role">\nFixture prompt.\n</role-prompt>'
  assert.ok(attached.identity.includes(rolePrompt))
  assert.deepEqual(attached.identity.replace(rolePrompt, ''), behavior.identity)
  assert.deepEqual(attached.tools, behavior.tools)
  await missing(f.marker)
  f.rt.state.bots[BOT.id].roles[0].grants.push('fixture-existing-grant')
  await f.rt.save()
  const prior = await fs.readFile(f.statePath, 'utf8')
  assert.deepEqual(await attachTo(f), { ok: true, value: [ID] })
  assert.equal(await fs.readFile(f.statePath, 'utf8'), prior)
  assert.equal(f.rt.state.bots[BOT.id].roles[0].attachedAt, pinOf().attachedAt)
  assert.deepEqual(f.rt.state.bots[BOT.id].roles[0].grants, ['fixture-existing-grant'])
  refused(await f.uninstall(), /Detach this role/)
  assert.deepEqual(await detachFrom(f), { ok: true, value: [] })
  assert.deepEqual((await f.uninstall()).value, { removed: true })
})

test('checks authority, raw slot and write success in the serialized attach edit', async t => {
  const genie = fixtureBot('genie-fixture', { kind: 'genie' })
  const occupied = fixtureBot('occupied-fixture', { roles: [{ id: 'other-role' }] })
  const f = await fixture(t, { extra: { bots: { [BOT.id]: BOT, [genie.id]: genie, [occupied.id]: occupied } } })
  assert.equal((await f.install()).ok, true)
  refused(await attachTo(f, genie.id), /Choose None first/)
  refused(await attachTo(f, occupied.id), /Detach other-role first/)
  refused(await attachTo(f, 'seat:fixture'), /No such Bot/)
  refused(await detachFrom(f, 'seat:fixture'), /No such Bot/)
  const readOnly = f.rt.readOnly
  f.rt.readOnly = () => 'fixture read-only'
  assert.equal((await attachTo(f)).error.code, 'bot/read-only')
  f.rt.readOnly = readOnly
  const holdsLock = f.rt.holdsLock
  f.rt.holdsLock = () => false
  refused(await attachTo(f), /does not hold the Bot team/)
  f.rt.holdsLock = holdsLock
  const before = await fs.readFile(f.statePath, 'utf8')
  const temp = `${f.statePath}.${process.pid}.tmp`
  await fs.mkdir(temp)
  assert.equal((await attachTo(f)).ok, false)
  assert.equal(Object.hasOwn(f.rt.state.bots[BOT.id], 'roles'), false)
  assert.equal(await fs.readFile(f.statePath, 'utf8'), before)
  await fs.rm(temp, { recursive: true })
  await detachFrom(f, genie.id)
  assert.equal((await attachTo(f, genie.id)).ok, true)
  refused(await attachTo(f, genie.id, 'genie'), /Detach Sample role first/)
  refused(await attachTo(f, genie.id, 'another'), /Detach Sample role first/)
  assert.equal((await f.call('set-prefs', { roles: false })).ok, true)
  refused(await attachTo(f), /turned off/)
  assert.deepEqual((await f.disk()).bots[genie.id].roles, [pinOf()])
  assert.equal((await f.call('set-prefs', { roles: true })).ok, true)
  assert.deepEqual((await f.disk()).bots[genie.id].roles, [pinOf()])
})

test('rechecks record identity, writer ownership and the Bot slot at commit', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  const original = f.rt.saveCopy
  for (const [mutate, reason] of [
    [() => {
      const record = f.rt.state.roles[ID]
      f.rt.state.roles[ID] = { ...record }
      return () => { f.rt.state.roles[ID] = record }
    }, /record changed/],
    [() => {
      const original = f.rt.holdsLock
      f.rt.holdsLock = () => false
      return () => { f.rt.holdsLock = original }
    }, /does not hold the Bot team/],
    [() => {
      f.rt.state.bots[BOT.id].roles = [{ id: 'other-role' }]
      return () => { delete f.rt.state.bots[BOT.id].roles }
    }, /Bot's role changed/],
  ]) {
    const before = await fs.readFile(f.statePath, 'utf8')
    f.rt.saveCopy = (apply, { beforeCommit, afterWrite }) => original(apply, {
      beforeCommit: () => {
        const restore = mutate()
        try { beforeCommit() } finally { restore() }
      },
      afterWrite,
    })
    refused(await attachTo(f), reason)
    assert.equal(await fs.readFile(f.statePath, 'utf8'), before)
    assert.equal(Object.hasOwn(f.rt.state.bots[BOT.id], 'roles'), false)
  }
})

test('serializes attach and uninstall in both admission orders', async t => {
  for (const first of ['attach', 'uninstall']) await t.test(first, async t => {
    const f = await fixture(t)
    assert.equal((await f.install()).ok, true)
    const saving = Promise.withResolvers()
    const release = Promise.withResolvers()
    const save = f.rt.saveCopy
    f.rt.saveCopy = async (...args) => {
      saving.resolve()
      await release.promise
      return save(...args)
    }
    const attach = () => attachTo(f)
    const remove = () => f.uninstall()
    const [one, two] = first === 'attach' ? [attach, remove] : [remove, attach]
    const leading = one()
    await saving.promise
    const following = two()
    release.resolve()
    assert.equal((await leading).ok, true)
    refused(await following, first === 'attach' ? /Detach this role/ : /Unknown role/)
    const disk = await f.disk()
    assert.equal(Object.hasOwn(disk.roles, ID), first === 'attach')
    assert.equal(disk.bots[BOT.id].roles?.[0]?.id, first === 'attach' ? ID : undefined)
  })
})

test('clears missing, mismatched, damaged and ID-only attachments without depending on package health', async t => {
  const cases = [
    ['missing', pinOf(), false, false],
    ['version-mismatch', pinOf(ID, '2.0.0'), true, false],
    ['damaged', pinOf(), true, true],
    ['off and ID-only', { id: ID }, false, false],
  ]
  for (const [name, pin, install, damage] of cases) await t.test(name, async t => {
    const f = await fixture(t, { extra: { bots: { [BOT.id]: { ...BOT, roles: [pin] } } } })
    if (install) assert.equal((await f.install()).ok, true)
    if (damage) await fs.unlink(join(f.verDir, 'prompt.md'))
    if (!pin.version) await f.call('set-prefs', { roles: false })
    assert.deepEqual(await detachFrom(f), { ok: true, value: [] })
    assert.deepEqual((await f.disk()).bots[BOT.id].roles, [])
    if (install) assert.equal((await f.uninstall()).ok, true)
  })
  const genie = fixtureBot('genie-fixture', { kind: 'genie' })
  const mixed = fixtureBot('mixed-fixture', { roles: [{ id: ID }, { id: 'genie' }] })
  const f = await fixture(t, { extra: { prefs: { roles: false }, bots: {
    [BOT.id]: BOT, [genie.id]: genie, [mixed.id]: mixed,
  } } })
  for (const id of [BOT.id, genie.id, mixed.id]) refused(await detachFrom(f, id), /turned off/)
})

test('rejects broken and damaged installs at new attachment admission', async t => {
  for (const status of ['broken', 'damaged']) await t.test(status, async t => {
    const f = await fixture(t)
    assert.equal((await f.install()).ok, true)
    if (status === 'broken') await fs.rm(f.verDir, { recursive: true })
    else await fs.unlink(join(f.verDir, 'prompt.md'))
    refused(await attachTo(f), new RegExp(`is ${status}`))
    assert.equal(Object.hasOwn((await f.disk()).bots[BOT.id], 'roles'), false)
  })
})

test('new admission refuses the Genie package and legacy uninstall still removes its files', async t => {
  const entry = entryOf(undefined, { id: 'genie' })
  const f = await fixture(t, { entry })
  await f.materialize()
  await fs.writeFile(join(f.verDir, 'role.json'), JSON.stringify(manifestOf({ id: 'genie' })))
  await f.close()
  await fs.writeFile(f.statePath, JSON.stringify({ ...await f.disk(), roles: { genie: f.record() } }))
  const reload = await f.start()
  assert.deepEqual((await reload.call('role-catalog')).value.roles, [])
  refused(await reload.call('role-install', { id: 'genie' }), /Unknown role/)
  refused(await attachTo(reload, BOT.id, 'genie'), /Genie can be given/)
  const roster = (await reload.call('state')).value
  assert.equal(roster.roles.genie.status, 'ok')
  assert.equal(roster.roleDetails.genie.installed.attachable, false)
  assert.deepEqual((await reload.call('role-uninstall', { id: 'genie' })).value, { removed: true })
  await missing(f.verDir)
})

test('uses exact signed eligibility after restart and never credits the publisher alone', async t => {
  for (const official of [true, false]) await t.test(`official=${official}`, async t => {
    const f = await fixture(t, { entry: entryOf(undefined, { official, description: 'Signed description', tools: ['signed_tool'] }) })
    await f.materialize()
    await f.close()
    await fs.writeFile(f.statePath, JSON.stringify({ ...await f.disk(), roles: { [ID]: f.record() } }))
    const reload = await f.start()
    refused(await attachTo(reload), /source cannot be confirmed/)
    const initial = (await reload.call('state')).value
    assert.equal(initial.roles[ID].status, 'ok')
    assert.equal(initial.roleDetails[ID].installed.verified, undefined)
    assert.equal(initial.roleDetails[ID].installed.attachable, false)
    const io = f.fsCalls.length
    await reload.call('role-catalog')
    const changed = (await reload.call('state', { since: initial.revision, live: initial.liveKey })).value
    assert.equal(changed.unchanged, true)
    assert.notEqual(changed.liveKey, initial.liveKey)
    assert.equal(changed.roleDetails[ID].installed.attachable, official)
    assert.deepEqual(changed.roleDetails[ID].catalog, {
      version: VERSION, sha256: f.entry.sha256, description: 'Signed description', tools: ['signed_tool'],
    })
    assert.deepEqual((await reload.call('state', { since: initial.revision, live: changed.liveKey })).value, {
      revision: initial.revision, unchanged: true, liveKey: changed.liveKey,
    })
    assert.equal(f.fsCalls.length, io)
    assert.deepEqual(f.fetches, [INDEX, SIGNATURE])
    if (official) assert.equal((await attachTo(reload)).ok, true)
    else refused(await attachTo(reload), /source cannot be confirmed/)
    assert.deepEqual(f.fetches, [INDEX, SIGNATURE])
  })
})

test('a verified install of constructor supplies bounded details for that exact record only', async t => {
  const id = 'constructor'
  const declarations = {
    id, name: 'Fixture role', description: 'x'.repeat(201),
    tools: [{ name: 'fixture_tool', description: 'An inert declaration.', parameters: {} }],
  }
  const bytes = packageOf(manifestOf(declarations))
  const f = await fixture(t, { bytes, entry: entryOf(bytes, { id }) })
  assert.equal((await f.install({ id })).ok, true)
  assert.deepEqual(await attachTo(f, BOT.id, id), { ok: true, value: [id] })
  const first = (await f.call('state')).value
  assert.deepEqual(first.roleDetails[id].installed, {
    version: VERSION, sha256: f.entry.sha256, attachable: true, name: declarations.name,
    tools: ['fixture_tool'], capabilities: ['audio-out'], verified: true,
  })
  f.rt.state.roles[id] = { ...f.rt.state.roles[id], sha256: 'b'.repeat(64) }
  const changed = (await f.call('state', { since: first.revision, live: first.liveKey })).value
  assert.notEqual(changed.liveKey, first.liveKey)
  assert.deepEqual(changed.roleDetails[id].installed, { version: VERSION, sha256: 'b'.repeat(64), attachable: false })
  assert.deepEqual((await f.call('state', { since: first.revision, live: changed.liveKey })).value, {
    revision: first.revision, unchanged: true, liveKey: changed.liveKey,
  })
  await detachFrom(f)
  refused(await attachTo(f, BOT.id, id), /source cannot be confirmed/)
})

async function mountRoleSurfaces() {
  const { outputFiles } = await build({
    stdin: {
      contents: `export { ConnectorsPage } from './connectors-page.js'
        export { BotSettingsForm } from './bot-settings.js'`,
      resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  let slots
  let index
  let effects
  const appSlots = []
  const settingsSlots = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    createContext: value => ({ value }), useContext: ctx => ctx.value,
    useState: initial => {
      const list = slots
      const i = index++
      if (!(i in list)) list[i] = typeof initial === 'function' ? initial() : initial
      return [list[i], value => { list[i] = value }]
    },
    useRef: current => slots[index++] ??= { current },
    useEffect: (fn, deps) => {
      const prior = slots[index]
      slots[index++] = deps
      if (!prior || deps.some((dep, i) => dep !== prior[i])) effects.push(fn)
    },
    useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn, useId: () => 'id',
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, window: { location: { search: '' } },
    require: name => (name === 'react' ? react : {}),
  })
  const render = (node, persistentSlots = []) => {
    slots = persistentSlots
    index = 0
    effects = []
    const view = node.type(node.props)
    for (const effect of effects) effect()
    return view
  }
  const expand = node => {
    if (Array.isArray(node)) return node.map(expand)
    if (node && typeof node === 'object') {
      if (typeof node.type === 'function') return expand(render(node))
      return { ...node, props: { ...node.props, children: expand(node.props.children) } }
    }
    return node
  }
  return {
    app(props) {
      const page = render({ type: module.exports.ConnectorsPage, props })
      const app = render(page, appSlots)
      const roleTree = findNode(app, node => node.type?.name === 'RoleShopSection' || node.type?.name === 'RoleShopCard')
      return { page: app, roles: expand(roleTree) }
    },
    settings(props) {
      const form = render({ type: module.exports.BotSettingsForm, props }, settingsSlots)
      const card = findNode(form, node => node.type?.name === 'PackageAttachmentCard')
      return { form, card: expand(card) }
    },
  }
}

const surfaceText = node => Array.isArray(node) ? node.map(surfaceText).join(' ')
  : typeof node === 'object' && node !== null ? surfaceText(node.props?.children)
    : typeof node === 'string' ? node : ''
const surfaceButton = (tree, label) => findNode(tree, node => node.type === 'button' && surfaceText(node).trim() === label)

test('the real Apps and Bot settings surfaces complete the package flow through owner POSTs', async t => {
  const f = await fixture(t)
  const { key, index } = signer()
  const bytes = packageOf(f.manifest, f.script)
  const catalog = index([
    entryOf(bytes, { id: 'community-fixture', name: 'Community fixture', official: false, description: 'A sample role' }),
    entryOf(bytes, { description: '<Catalog fixture>' }),
  ])
  installRoles(f.rt, {
    keys: [key], now: () => clock,
    fetch: async url => {
      f.fetches.push(url)
      if (url === INDEX) return new Response(catalog.bytes)
      if (url === SIGNATURE) return new Response(catalog.signature)
      assert.equal(url, f.entry.source)
      return new Response(bytes)
    },
  })
  let roster = (await f.call('state')).value
  const posted = []
  const pending = []
  const actions = teamActions({
    call: async (endpoint, payload) => {
      posted.push([endpoint, payload])
      const reply = await f.call(endpoint, payload)
      assert.equal(reply.ok, true, reply.error?.message)
      return reply.value
    },
    after: async work => {
      const value = await work
      roster = (await f.call('state')).value
      return value
    },
  })
  const catalogAction = actions.roleCatalog
  actions.refreshModels = undefined
  actions.roleCatalog = () => {
    const request = catalogAction()
    pending.push(request)
    return request
  }
  const surfaces = await mountRoleSurfaces()
  const app = () => surfaces.app({ roster, actions })
  const settings = () => surfaces.settings({ roster, bot: roster.bots.find(bot => bot.id === BOT.id), actions,
    run: work => { pending.push(work); return work } })
  const first = app()
  assert.equal(first.roles, undefined, 'discovery starts before the Roles section has rows')
  await Promise.all(pending.splice(0))
  assert.deepEqual(posted, [['role-catalog', undefined]])
  const open = name => findNode(app().roles, node => node.props?.className === 'bt-app-main'
    && surfaceText(node).trim().startsWith(name)).props.onClick()
  const back = () => app().page.props.onBack()
  const install = () => {
    const button = findNode(app().roles, node => node.type === 'button' && surfaceText(node).trim() === 'Install' && !node.props.disabled)
    assert.ok(button)
    return button.props.onClick()
  }

  const community = findNode(app().roles, node => node.type === 'button' && node.props.disabled && surfaceText(node).trim() === 'Install')
  assert.match(community.props.title, /isolated runtime ships/)
  assert.match(surfaceText(app().roles), /Community roles can be installed once their isolated runtime ships/)
  open('Community fixture')
  assert.equal(surfaceButton(app().roles, 'Install').props.disabled, true)
  assert.match(surfaceText(app().roles), /Waits for the isolated runtime/)
  back()

  await install()
  assert.equal(posted.at(-1)[0], 'role-install')
  assert.ok(findNode(app().page, node => node.props?.role === 'status' && surfaceText(node).includes('futureField')))
  const picker = findNode(settings().form, node => node.props?.role === 'group' && node.props['aria-label'] === 'Role')
  surfaceButton(picker, 'Sample role').props.onClick()
  await Promise.all(pending.splice(0))
  assert.deepEqual(posted.at(-1), ['role-attach', { id: BOT.id, role: ID }])
  const attached = settings()
  assert.ok(findNode(attached.form, node => node.props?.className === 'bt-tag' && surfaceText(node).trim() === 'Sample role'))
  assert.match(surfaceText(attached.card), /sample-role@1\.0\.0/)
  assert.match(surfaceText(attached.card), /Active tools/)
  assert.match(surfaceText(attached.card), /None/)
  assert.doesNotMatch(surfaceText(attached.card), /Its tools arrive with the role runtime/)
  await Promise.all(pending.splice(0))
  const locked = surfaceButton(app().roles, 'Uninstall')
  assert.equal(locked.props.disabled, true)
  assert.match(locked.props.title, /Detach this role/)
  open('Sample role')
  assert.equal(surfaceButton(app().roles, 'Uninstall').props.disabled, true)
  surfaceButton(attached.card, 'Detach').props.onClick()
  await Promise.all(pending.splice(0))
  assert.deepEqual(posted.at(-1), ['role-detach', { id: BOT.id }])
  assert.equal(settings().card, undefined)
  await surfaceButton(app().roles, 'Uninstall').props.onClick()
  assert.equal(posted.at(-1)[0], 'role-uninstall')
  assert.deepEqual((await f.disk()).roles, {})

  await install()
  assert.equal(posted.at(-1)[0], 'role-install', 'the package card installs the same signed role')
  assert.match(surfaceText(app().roles), /Installed SHA-256/)
  assert.match(surfaceText(app().roles), /Catalog SHA-256/)
  await surfaceButton(app().roles, 'Uninstall').props.onClick()
  assert.deepEqual((await f.disk()).roles, {})
  assert.equal(posted.filter(([endpoint]) => endpoint === 'role-catalog').length, 2, 'Apps and settings each discover once')
  assert.deepEqual(f.fetches, [INDEX, SIGNATURE, f.entry.source, f.entry.source])
  await missing(f.marker)
})

test('an installed package makes no role writer available to agent MCP or Bot tools', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  await f.rt.agentAccess.owner('view')
  const token = 'pinned-role-agent-fixture'
  await fs.writeFile(join(f.home, 'agent-tokens.json'), JSON.stringify([
    { id: 'fixture', name: 'MCP fixture', hash: SHA256(token), createdAt: 1 },
  ]), { mode: 0o600 })
  const rpc = (method, params) => f.post(MCP_PATH, { jsonrpc: '2.0', id: 1, method, params }, {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
  })
  const original = await fs.readFile(f.statePath, 'utf8')
  const listed = (await rpc('tools/list')).result.tools
  for (const name of ['role-attach', 'role_attach', 'role-detach', 'role_detach']) {
    assert.equal(listed.some(tool => tool.name === name), false)
    assert.equal(f.ctx.registeredTools.has(name), false)
    const reply = await rpc('tools/call', { name, arguments: { id: BOT.id, role: ID } })
    assert.ok(reply.error || reply.result?.isError)
  }
  const update = listed.find(tool => tool.name === 'update_bot')
  assert.deepEqual(Object.keys(update.inputSchema.properties).sort(),
    ['color', 'effort', 'id', 'instructions', 'model', 'name', 'permission', 'role'])
  const proposal = f.ctx.registeredTools.get('propose_bot_change')
  assert.deepEqual(Object.keys(proposal.parameters.properties).sort(),
    ['bot', 'effort', 'instructions', 'model', 'name', 'note', 'role', 'work_dir'])
  assert.equal(await fs.readFile(f.statePath, 'utf8'), original)
})

test('concurrent readers share the first health check for the same install record', async t => {
  const f = await fixture(t)
  assert.equal((await f.install()).ok, true)
  const scanning = Promise.withResolvers()
  const release = Promise.withResolvers()
  let reads = 0
  f.hooks.lstat = async path => {
    if (path === f.verDir) {
      reads += 1
      scanning.resolve()
      await release.promise
    }
    return fs.lstat(path)
  }
  const first = f.rt.roleRecordsView()
  await scanning.promise
  const second = f.rt.roleRecordsView()
  release.resolve()
  const answers = await Promise.all([first, second])
  assert.deepEqual(answers[0], answers[1])
  assert.equal(answers[0][ID].status, 'ok')
  assert.equal(reads, 1)
  await f.rt.roleRecordsView()
  assert.equal(reads, 1)
})

const BUNDLED_DIGEST = '27b4087c9725cc225d6b574d2c5a5d2129e17943cdf8d8cfbd410d2ac7d560e8'
const BUNDLE_NAMES = ['prompt.md', 'role.json', 'role.mjs']
const bundleSource = new URL('../roles/solver/', import.meta.url)
const installedSolverDir = (f, version = PLUGIN_VERSION) => join(f.rolesDir, 'solver', version)
const waitFor = (instructions, role = 'Solver') => ({ id: 'solver', instructions: SHA256(instructions), role })
const fixtureSolver = (id, extra = {}) => {
  const instructions = solverInstructions()
  return fixtureBot(id, { name: id, role: 'Solver', instructions, waitingRole: waitFor(instructions), ...extra })
}
const installSolver = f => f.install({ id: 'solver' })
const officialSolver = async f => {
  const result = await installSolver(f)
  assert.equal(result.ok, true, JSON.stringify(result))
  await immediate()
  return result.value
}
async function catalogSolverFixture(t, options = {}) {
  const bytes = packageOf(manifestOf({ id: 'solver', version: PLUGIN_VERSION, capabilities: [] }))
  const entry = entryOf(bytes, { id: 'solver', version: PLUGIN_VERSION, capabilities: [] })
  return fixture(t, { bytes, entry, ...options, roleDeps: { bundledRoot: '/fixture-bundle-unavailable', ...options.roleDeps } })
}

function fixtureBundleDigest(files) {
  const manifest = JSON.parse(files.get('role.json'))
  const source = new Map(files).set('role.json', Buffer.from(JSON.stringify({ ...manifest, version: '0.0.0' }, null, 2) + '\n'))
  return SHA256(Buffer.concat(BUNDLE_NAMES.flatMap(name => {
    const contents = source.get(name)
    return [Buffer.from(`${name}\0${contents.length}\0`), contents]
  })))
}

async function copyBundle(folder, { version, prompt, manifest } = {}) {
  await fs.mkdir(folder, { recursive: true })
  const files = new Map()
  for (const name of BUNDLE_NAMES) files.set(name, await fs.readFile(new URL(name, bundleSource)))
  if (version || manifest) {
    const base = JSON.parse(files.get('role.json'))
    files.set('role.json', Buffer.from(JSON.stringify({ ...base, ...manifest, version: version ?? base.version }, null, 2) + '\n'))
  }
  if (prompt !== undefined) files.set('prompt.md', Buffer.from(prompt))
  for (const [name, bytes] of files) await fs.writeFile(join(folder, name), bytes)
  return files
}

test('D2 B1 installs the shipped Solver offline and a cold host verifies it', async t => {
  const f = await fixture(t, { offline: true, roleDeps: { bundledHistory: solverCutHistory() } })
  const result = await officialSolver(f)
  assert.deepEqual(result, { id: 'solver', version: PLUGIN_VERSION, warnings: [] })
  assert.deepEqual(f.fetches, [])
  const record = (await f.disk()).roles.solver
  assert.equal(record.source, 'bundled')
  assert.equal(record.publisher, 'automagik')
  assert.equal(record.sha256, BUNDLED_DIGEST)
  assert.deepEqual((await fs.readdir(join(f.rolesDir, 'solver'))).sort(), [PLUGIN_VERSION])
  assert.deepEqual((await fs.readdir(installedSolverDir(f))).sort(), BUNDLE_NAMES)
  assert.equal(JSON.parse(await fs.readFile(join(installedSolverDir(f), 'role.json'), 'utf8')).version, PLUGIN_VERSION)
  await f.close()
  const h = await f.start()
  await until(() => h.rt.roleDetailsView().solver?.installed?.attachable === true, { t })
  assert.deepEqual(await attachTo(h, BOT.id, 'solver'), { ok: true, value: ['solver'] })
  assert.deepEqual(f.fetches, [])
})

test('D2S the Solver card keeps recovery usable pending verification and shows the authenticated digest', async t => {
  const f = await fixture(t, { offline: true, roleDeps: { bundledHistory: solverCutHistory() } })
  await copyBundle(installedSolverDir(f), { version: PLUGIN_VERSION })
  const claimed = 'a'.repeat(64)
  f.rt.state.roles = { solver: f.record({ id: 'solver', version: PLUGIN_VERSION, source: 'bundled', sha256: claimed }) }
  await f.rt.save()
  const surfaces = await mountRoleSurfaces()
  const actions = teamActions({
    call: async (endpoint, payload) => (await f.call(endpoint, payload)).value,
    after: work => work,
  })
  const app = roster => surfaces.app({ roster, actions })
  const before = (await f.call('state')).value
  assert.equal(before.roleDetails.solver.installed.sha256, undefined)
  findNode(app(before).roles, node => node.props?.className === 'bt-app-main').props.onClick()
  let recovery
  assert.doesNotThrow(() => { recovery = app(before).roles })
  assert.match(surfaceText(recovery), /Installed SHA-256\s+Details unavailable/)
  assert.equal(surfaceButton(recovery, 'Uninstall').props.disabled, false)

  await officialSolver(f)
  const verified = (await f.call('state')).value
  assert.equal((await f.disk()).roles.solver.sha256, claimed)
  assert.equal(verified.roleDetails.solver.installed.sha256, BUNDLED_DIGEST)
  const checksum = findNode(app(verified).roles, node => node.type === 'code')
  assert.equal(surfaceText(checksum).replace(/\s/g, ''), BUNDLED_DIGEST)
  assert.equal(verified.roles.solver.status, 'ok')

  await fs.writeFile(join(installedSolverDir(f), 'prompt.md'), 'Damaged after verification.')
  refused(await installSolver(f), /files differ from the signed package/)
  const damaged = (await f.call('state')).value
  assert.equal(damaged.roleDetails.solver.installed.sha256, undefined)
  assert.equal(damaged.roleDetails.solver.installed.attachable, false)
  assert.equal(damaged.roles.solver.status, 'damaged')
  let damagedCard
  assert.doesNotThrow(() => { damagedCard = app(damaged).roles })
  assert.match(surfaceText(damagedCard), /Installed SHA-256\s+Details unavailable/)
  const uninstall = surfaceButton(damagedCard, 'Uninstall')
  assert.equal(uninstall.props.disabled, false)
  await uninstall.props.onClick()
  assert.deepEqual((await f.disk()).roles, {})
})

test('D2S final bundled verification refuses the install and preserves the recovery record', async t => {
  for (const rolesOff of [false, true]) await t.test(rolesOff ? 'roles turned off after the save' : 'payload changed after the save', async t => {
    const f = await fixture(t, { offline: true, roleDeps: { bundledHistory: solverCutHistory() } })
    const saveCopy = f.rt.saveCopy
    const path = join(installedSolverDir(f), 'prompt.md')
    f.rt.saveCopy = async (change, options) => {
      await saveCopy(change, options)
      if (rolesOff) f.rt.state.prefs.roles = false
      else await fs.writeFile(path, 'Damaged after the install record was saved.')
    }
    const result = await installSolver(f)
    refused(result, rolesOff ? /Roles are turned off/ : /files differ from the signed package/)
    if (rolesOff) assert.equal(result.error.reason, 'roles-off')
    assert.equal((await f.disk()).roles.solver.source, 'bundled')
    assert.ok(await fs.readFile(path, 'utf8'))
    assert.equal(f.rt.roleDetailsView().solver.installed.sha256, undefined)
  })
})

test('D2 B2 local content and a matching team receipt cannot authenticate a forged prompt', async t => {
  const f = await fixture(t, { offline: true, roleDeps: { bundledHistory: solverCutHistory() } })
  const files = await copyBundle(installedSolverDir(f), { version: PLUGIN_VERSION, prompt: 'Untrusted fixture.' })
  f.rt.state.roles = { solver: f.record({
    id: 'solver', version: PLUGIN_VERSION, source: 'bundled', sha256: fixtureBundleDigest(files),
  }) }
  await f.rt.save()
  await f.close()
  const h = await f.start()
  refused(await attachTo(h, BOT.id, 'solver'), /files differ from the signed package/)
  const bot = h.rt.state.bots[BOT.id]
  bot.roles = [pinOf('solver', PLUGIN_VERSION)]
  h.rt.roleRuntime.reconcile()
  await h.rt.roleRuntime.ready(BOT.id)
  assert.equal(h.rt.roleRuntime.view()[BOT.id], undefined)
  assert.equal((await h.call('state')).value.roles.solver.status, 'damaged')
})

test('D2 B3 authenticates old bytes under their released stamp only', async t => {
  const older = '3.1.2'
  const oldPrompt = 'Previous authenticated Solver prompt.'
  const roleDeps = {}
  const f = await fixture(t, { offline: true, roleDeps })
  const oldSource = await copyBundle(join(f.home, 'old-source'), { prompt: oldPrompt })
  const oldDigest = fixtureBundleDigest(oldSource)
  roleDeps.bundledHistory = { solver: { [older]: oldDigest, [PLUGIN_VERSION]: BUNDLED_DIGEST } }
  await copyBundle(installedSolverDir(f, older), { version: older, prompt: oldPrompt })
  await copyBundle(installedSolverDir(f), { version: PLUGIN_VERSION, prompt: oldPrompt })
  f.rt.state.roles = { solver: f.record({ id: 'solver', version: older, sha256: oldDigest, source: 'bundled' }) }
  await f.rt.save()
  await f.close()
  const h = await f.start()
  assert.deepEqual(await attachTo(h, BOT.id, 'solver'), { ok: true, value: ['solver'] })
  assert.match((await h.botBehavior()).identity, /Previous authenticated Solver prompt\./)
  assert.deepEqual(await detachFrom(h), { ok: true, value: [] })
  h.rt.state.roles.solver = { ...h.rt.state.roles.solver, version: PLUGIN_VERSION }
  refused(await attachTo(h, BOT.id, 'solver'), /files differ from the signed package/)
})

test('D2 B4 checks all bundle leaves before opening any payload', async t => {
  for (const invalid of ['symlink', 'extra', 'oversize']) {
    const roleDeps = {}
    const f = await fixture(t, { offline: true, roleDeps })
    roleDeps.bundledRoot = join(f.home, 'publisher')
    const folder = join(roleDeps.bundledRoot, 'roles', 'solver')
    await copyBundle(folder)
    if (invalid === 'symlink') {
      await fs.unlink(join(folder, 'prompt.md'))
      await fs.symlink('role.mjs', join(folder, 'prompt.md'))
    } else if (invalid === 'extra') await fs.writeFile(join(folder, 'extra'), 'unexpected')
    else await fs.writeFile(join(folder, 'role.mjs'), 'x'.repeat(4097))
    await f.close()
    const h = await f.start()
    f.fsCalls.length = 0
    refused(await h.call('role-install', { id: 'solver' }), /catalog is unavailable/)
    assert.deepEqual(f.fetches, [INDEX])
    const payloadOpens = f.fsCalls.filter(([method, path, flags]) => method === 'open'
      && !(flags & constants.O_DIRECTORY) && BUNDLE_NAMES.some(name => String(path).endsWith('/' + name)))
    assert.deepEqual(payloadOpens, [], invalid)
  }
})

test('D2 accepts neither bundled tool declarations nor bundled IDs outside the allowlist', async t => {
  const roleDeps = {}
  const f = await fixture(t, { offline: true, roleDeps })
  const tools = [{ name: 'fixture_tool', description: 'Fixture tool', parameters: {} }]
  const manifest = { tools }
  const content = await copyBundle(join(f.home, 'tool-source'), { manifest })
  const sha256 = fixtureBundleDigest(content)
  roleDeps.bundledHistory = { solver: { [PLUGIN_VERSION]: sha256 } }
  await copyBundle(installedSolverDir(f), { version: PLUGIN_VERSION, manifest })
  f.rt.state.roles = { solver: f.record({ id: 'solver', version: PLUGIN_VERSION, sha256, source: 'bundled' }) }
  await f.rt.save()
  await f.close()
  const h = await f.start()
  refused(await attachTo(h, BOT.id, 'solver'), /files differ from the signed package/)
  h.rt.state.roles[ID] = f.record({ source: 'bundled' })
  refused(await attachTo(h), /broken|damaged|source cannot be confirmed/)
})

test('D2 B5 catalog Solver attaches after a cold start from retained evidence', async t => {
  const bytes = packageOf(manifestOf({ id: 'solver', capabilities: [] }))
  const entry = entryOf(bytes, { id: 'solver', capabilities: [] })
  const roleDeps = {}
  const f = await fixture(t, { bytes, entry, roleDeps })
  roleDeps.bundledRoot = join(f.home, 'no-bundle')
  await f.close()
  const first = await f.start()
  assert.equal((await first.call('role-install', { id: 'solver' })).ok, true)
  await first.close()
  f.fetches.length = 0
  f.paths.set(INDEX, () => { throw new Error('Offline') })
  const h = await f.start()
  assert.deepEqual(await attachTo(h, BOT.id, 'solver'), { ok: true, value: ['solver'] })
  assert.deepEqual(f.fetches, [])
})

test('D2 B6 an existing damaged Solver is preserved and install refuses offline', async t => {
  const f = await fixture(t, { offline: true, roleDeps: { bundledHistory: solverCutHistory() } })
  const files = await copyBundle(installedSolverDir(f), { version: PLUGIN_VERSION })
  f.rt.state.roles = { solver: f.record({
    id: 'solver', version: PLUGIN_VERSION, source: 'bundled', sha256: fixtureBundleDigest(files),
  }) }
  await f.rt.save()
  const altered = 'Different bytes.'
  const path = join(installedSolverDir(f), 'prompt.md')
  await fs.writeFile(path, altered)
  const record = (await f.disk()).roles.solver
  f.fsCalls.length = 0
  refused(await installSolver(f), /files differ from the signed package/)
  assert.deepEqual((await f.disk()).roles.solver, record)
  assert.equal(await fs.readFile(path, 'utf8'), altered)
  assert.deepEqual(mutations(f), [])
  assert.deepEqual(f.fetches, [])
})

test('D2 B7 runtime failure after the pin returns pending and retains the method', async t => {
  const f = await catalogSolverFixture(t)
  await officialSolver(f)
  const bot = f.rt.state.bots[BOT.id]
  bot.waitingRole = waitFor(bot.instructions, bot.role)
  const saveCopy = f.rt.saveCopy
  f.rt.saveCopy = (change, options) => saveCopy(change, {
    ...options, afterWrite() {
      f.hooks.open = (path, flags, ...rest) => {
        if (String(path).endsWith('/prompt.md')) throw new Error('Fixture runtime read failure')
        return fs.open(path, flags, ...rest)
      }
      options.afterWrite()
    },
  })
  assert.deepEqual(await attachTo(f, bot.id, 'solver'), { ok: true, value: { pending: true } })
  const disk = (await f.disk()).bots[bot.id]
  assert.deepEqual(disk.roles, [pinOf('solver', PLUGIN_VERSION)])
  assert.equal(disk.instructions, BOT.instructions)
  assert.deepEqual(disk.waitingRole, waitFor(BOT.instructions, BOT.role))
})

test('D2 B8 an already pinned damaged waiter reports pending without a write', async t => {
  const f = await catalogSolverFixture(t)
  await officialSolver(f)
  const bot = f.rt.state.bots[BOT.id]
  Object.assign(bot, { roles: [pinOf('solver', PLUGIN_VERSION)], waitingRole: waitFor(bot.instructions, bot.role) })
  await fs.writeFile(join(installedSolverDir(f), 'prompt.md'), 'Damaged fixture.')
  await f.rt.save()
  await f.rt.roleRuntime.ready(bot.id)
  const prior = await fs.readFile(f.statePath, 'utf8')
  assert.deepEqual(await attachTo(f, bot.id, 'solver'), { ok: true, value: { pending: true } })
  assert.equal(await fs.readFile(f.statePath, 'utf8'), prior)
})

test('D2 B9 a live instructions edit during Phase B publication survives its queued save', async t => {
  const f = await catalogSolverFixture(t)
  await officialSolver(f)
  const bot = f.rt.state.bots[BOT.id]
  bot.waitingRole = waitFor(bot.instructions, bot.role)
  const saveCopy = f.rt.saveCopy
  let writes = 0
  let edit
  f.rt.saveCopy = (change, options) => {
    if (++writes !== 2) return saveCopy(change, options)
    return saveCopy(change, {
      ...options,
      async beforeCommit() {
        await options.beforeCommit()
        edit ??= f.rt.updateBot(bot.id, { instructions: 'Person edited the method.' })
      },
    })
  }
  assert.deepEqual(await attachTo(f, bot.id, 'solver'), { ok: true, value: ['solver'] })
  await edit
  const disk = (await f.disk()).bots[bot.id]
  assert.equal(disk.instructions, 'Person edited the method.')
  assert.deepEqual(disk.roles, [pinOf('solver', PLUGIN_VERSION)])
  assert.equal(Object.hasOwn(disk, 'waitingRole'), false)
})

test('D2 B10 automatic attach cannot pin a Bot whose description changed before commit', async t => {
  const f = await catalogSolverFixture(t)
  await officialSolver(f)
  const bot = f.rt.state.bots[BOT.id]
  bot.waitingRole = waitFor(bot.instructions, bot.role)
  const oldSave = f.rt.saveCopy
  let checked = false
  f.rt.saveCopy = (change, options) => oldSave(change, {
    ...options, beforeCommit() {
      bot.role = 'Changed description'
      checked = true
      options.beforeCommit()
    },
  })
  f.rt.solverSettle?.schedule()
  await until(() => checked, { t })
  assert.equal(bot.roles, undefined)
  assert.equal(bot.instructions, BOT.instructions)
  assert.ok(bot.waitingRole)
})

function fakeSolverClock() {
  const pending = new Map()
  const cleared = []
  let next = 0
  return {
    pending, cleared,
    setTimeout(callback, delay) { assert.equal(delay, 600_000); pending.set(++next, callback); return next },
    clearTimeout(handle) { cleared.push(handle); pending.delete(handle) },
    tick() {
      const [handle, callback] = pending.entries().next().value
      pending.delete(handle)
      callback()
    },
  }
}

test('D2 B11 the first created waiter arms one timer and a pass tries one install for two waiters', async t => {
  const timers = fakeSolverClock()
  const f = await fixture(t, { offline: true, roleDeps: { timers } })
  assert.equal(timers.pending.size, 0)
  let installs = 0
  f.rt.installRole = async () => { ++installs; return { installed: false } }
  for (const name of ['Wait one', 'Wait two']) {
    const result = await f.call('create-bot', { name, role: 'Solver', instructions: solverInstructions(), waitingRole: 'solver' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual([...timers.pending.keys()], [1])
  }
  timers.tick()
  await until(() => timers.pending.size === 1, { t })
  assert.equal(installs, 1)
})

test('D2 a failed deletion saves the restored Solver and re-arms its timer without a save warning', async t => {
  const timers = fakeSolverClock()
  const f = await fixture(t, { offline: true, roleDeps: { timers } })
  const created = await f.call('create-bot', {
    name: 'Waiting Solver', role: 'Solver', instructions: solverInstructions(), waitingRole: 'solver',
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const { id } = created.value
  const members = [BOT.id, id]
  const room = await f.call('create-room', { name: 'Solver team', members, admin: id })
  assert.equal(room.ok, true, JSON.stringify(room))
  const roomId = room.value.id
  assert.deepEqual([...timers.pending.keys()], [1])

  const failure = new Error('Fixture session release failed')
  t.mock.method(f.rt, 'releaseBot', async () => {
    await f.rt.save()
    const { rooms } = await f.disk()
    assert.deepEqual(rooms[roomId].members, [BOT.id])
    assert.equal(rooms[roomId].admin, null)
    f.rt.solverSettle.cancel()
    throw failure
  })
  const warn = t.mock.method(f.rt, 'warn', () => {})
  await assert.rejects(f.rt.deleteBot(id), error => error === failure)

  const { bots, rooms } = await f.disk()
  assert.deepEqual(bots[id].waitingRole, waitFor(bots[id].instructions))
  assert.deepEqual(rooms[roomId].members, members)
  assert.equal(rooms[roomId].admin, id)
  const saveWarnings = warn.mock.calls.map(({ arguments: [message] }) => message).filter(message => message.includes('not saved'))
  assert.deepEqual({ pending: [...timers.pending.keys()], saveWarnings }, { pending: [2], saveWarnings: [] })
})

test('D2 B12 deletion, roles off, lock loss, and disposal each release the timer', async t => {
  const timers = fakeSolverClock()
  const f = await fixture(t, { offline: true, roleDeps: { timers } })
  const make = async name => {
    const result = await f.call('create-bot', { name, role: 'Solver', instructions: solverInstructions(), waitingRole: 'solver' })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value.id
  }
  const first = await make('First waiter')
  assert.equal(timers.pending.size, 1)
  assert.equal((await f.call('delete-bot', { id: first })).ok, true)
  await until(() => timers.cleared.length > 0, { t, poll: immediate })
  assert.deepEqual(timers.cleared, [1])
  await make('Second waiter')
  assert.equal(timers.pending.size, 1)
  assert.equal((await f.call('set-prefs', { roles: false })).ok, true)
  assert.deepEqual(timers.cleared, [1, 2])
  await make('Roles off waiter')
  assert.equal(timers.pending.size, 0)
  f.rt.state.prefs.roles = true
  f.rt.solverSettle?.armTimer()
  assert.equal(timers.pending.size, 1)
  const holdsLock = f.rt.holdsLock
  f.rt.holdsLock = () => false
  f.rt.solverSettle.armTimer()
  assert.deepEqual(timers.cleared, [1, 2, 3])
  f.rt.holdsLock = holdsLock
  f.rt.solverSettle.armTimer()
  await f.close()
  assert.deepEqual(timers.cleared, [1, 2, 3, 4])
})

test('D2 B13 waiting copies regenerate queued reviews and refuse edited text with roles off', async t => {
  const instructions = solverInstructions({ reviewer: BOT.name, dedicated: true })
  const waiting = fixtureSolver('waiting-solver', { instructions, waitingRole: waitFor(instructions), reviewerId: BOT.id, reviewerMade: true })
  const { dedicated: d1 } = JSON.parse(await fs.readFile(new URL('./fixtures/solver-method-d1.json', import.meta.url), 'utf8'))
  const d1Waiting = fixtureSolver('d1-waiting-solver', { instructions: d1, waitingRole: waitFor(d1), reviewerId: BOT.id, reviewerMade: true })
  const edited = fixtureSolver('edited-solver', { instructions: 'Person changed these instructions.' })
  const f = await fixture(t, {
    roleDeps: {}, extra: { prefs: { roles: false }, bots: { [BOT.id]: BOT, [waiting.id]: waiting, [d1Waiting.id]: d1Waiting, [edited.id]: edited } },
  })
  for (const source of [waiting, d1Waiting]) {
    const copy = await f.call('duplicate-bot', { id: source.id })
    assert.equal(copy.ok, true, JSON.stringify(copy))
    const stored = (await f.disk()).bots[copy.value.id]
    assert.equal(Object.hasOwn(copy.value, 'waitingRole'), false)
    assert.equal(Object.hasOwn(stored, 'reviewerMade'), false)
    assert.equal(stored.reviewerId, BOT.id)
    assert.equal(stored.instructions, solverInstructions({ reviewer: BOT.name, dedicated: false }))
    assert.deepEqual(stored.waitingRole, waitFor(stored.instructions))
  }

  const before = await fs.readFile(f.statePath, 'utf8')
  refused(await f.call('duplicate-bot', { id: edited.id }), /Roles are turned off/)
  assert.equal(await fs.readFile(f.statePath, 'utf8'), before)
})

test('D2S an edited or empty unpinned waiter needs a verified Solver role before it can be copied', async t => {
  const f = await catalogSolverFixture(t)
  const source = f.rt.state.bots[BOT.id]
  source.waitingRole = waitFor(source.instructions, source.role)
  source.instructions = 'Person changed these instructions.'
  await f.rt.save()
  const before = await fs.readFile(f.statePath, 'utf8')
  refused(await f.call('duplicate-bot', { id: source.id }), /role changed/)
  assert.equal(await fs.readFile(f.statePath, 'utf8'), before)

  // Keep the two edited waiters pending so Duplicate must make its own decision.
  await f.rt.installRole('solver', { settling: true })
  for (const instructions of ['Person changed these instructions.', '']) {
    source.instructions = instructions
    const copy = await f.call('duplicate-bot', { id: source.id })
    assert.equal(copy.ok, true, JSON.stringify(copy))
    const stored = (await f.disk()).bots[copy.value.id]
    assert.equal(stored.instructions, instructions)
    assert.deepEqual(stored.roles, [pinOf('solver', PLUGIN_VERSION)])
    assert.equal(stored.waitingRole, undefined)
  }
})

test('D2T-2 Duplicate refuses an edited waiter whose copy would use Remote Hermes', async t => {
  const f = await catalogSolverFixture(t)
  await f.rt.installRole('solver', { settling: true })
  const source = f.rt.state.bots[BOT.id]
  Object.assign(source, {
    model: 'hermes-remote/attach', waitingRole: waitFor(source.instructions, source.role),
    instructions: 'Person changed these instructions.',
  })
  await f.rt.save()
  t.mock.method(f.rt, 'catalog', async () => [{ ref: source.model }])
  t.mock.method(f.rt, 'resolveModel', async ref => ref)
  t.mock.method(f.rt, 'assertModelAccess', async () => {})
  const before = await fs.readFile(f.statePath, 'utf8')
  const copy = await f.call('duplicate-bot', { id: source.id })
  refused(copy, /uses its Hermes profile's own instructions/)
  assert.equal(await fs.readFile(f.statePath, 'utf8'), before)
  assert.deepEqual(Object.keys(f.rt.state.bots), [source.id])
})

test('D2 B14 a pin-only Researcher copy has a method before and after attach', async t => {
  const source = fixtureBot('researcher', { name: 'Researcher', role: 'Researcher', instructions: '' })
  const f = await catalogSolverFixture(t, { extra: { bots: { [BOT.id]: BOT, [source.id]: source } } })
  await officialSolver(f)
  f.rt.state.bots[source.id].roles = [pinOf('solver', PLUGIN_VERSION)]
  await f.rt.save()
  const attach = f.rt.attachRole
  let fallback
  f.rt.attachRole = async (...args) => {
    fallback = (await f.disk()).bots[args[0]]
    return attach(...args)
  }
  const copy = await f.call('duplicate-bot', { id: source.id })
  assert.equal(copy.ok, true, JSON.stringify(copy))
  assert.ok(fallback, 'the copy stores its fallback before attempting attachment')
  assert.equal(fallback.instructions, solverInstructions())
  assert.deepEqual(fallback.waitingRole, waitFor(fallback.instructions, 'Researcher'))
  const stored = (await f.disk()).bots[copy.value.id]
  assert.equal(stored.instructions, '')
  assert.equal(stored.waitingRole, undefined)
  assert.deepEqual(stored.roles, [pinOf('solver', PLUGIN_VERSION)])
})

test('D2 B15 a copy needs authenticated role content or a proven written method before publication', async t => {
  const bots = { [BOT.id]: BOT }
  for (const [id, role, instructions] of [
    ['custom-researcher', 'Researcher', 'Custom Researcher text.'],
    ['custom-solver', 'Solver', 'Custom Solver text.'],
    ['written-solver', 'Solver', solverInstructions()],
  ]) {
    bots[id] = fixtureBot(id, { name: id, role, instructions, roles: [pinOf('solver', PLUGIN_VERSION)] })
  }
  const f = await fixture(t, { roleDeps: {}, extra: { prefs: { roles: false }, bots } })
  const original = await fs.readFile(f.statePath, 'utf8')
  for (const id of ['custom-researcher', 'custom-solver']) {
    refused(await f.call('duplicate-bot', { id }), /Roles are turned off/)
    assert.equal(await fs.readFile(f.statePath, 'utf8'), original)
  }
  const result = await f.call('duplicate-bot', { id: 'written-solver' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal((await f.disk()).bots[result.value.id].instructions, solverInstructions())
})

test('D2 B16 the current source matches its pinned digest and the version mapping', async () => {
  const { bundleDigest, BUNDLED_ROLE_HISTORY, expectedBundleDigest } = await import('../src/host/bundled-roles.js')
  const mapping = BUNDLED_ROLE_HISTORY.solver
  for (const [version, digest] of Object.entries(mapping)) {
    assert.match(version, /^\d+\.\d+\.\d+$/)
    assert.match(digest, /^[a-f0-9]{64}$/)
  }
  const files = new Map()
  for (const name of BUNDLE_NAMES) files.set(name, await fs.readFile(new URL(name, bundleSource)))
  assert.equal(bundleDigest(files), BUNDLED_DIGEST, 'retain the previous mapping and append the new release digest')
  const { candidate } = JSON.parse(await fs.readFile(new URL('../src/host/bundled-roles.json', import.meta.url), 'utf8'))
  assert.equal(candidate, bundleDigest(files))
  for (const earlier of ['3.173.8', '3.173.9']) {
    assert.equal(expectedBundleDigest(BUNDLED_ROLE_HISTORY, 'solver', earlier), undefined)
  }
  const stamped = '3.174.0'
  const cut = { solver: { [stamped]: candidate } }
  assert.equal(expectedBundleDigest(cut, 'solver', '3.173.9'), undefined)
  assert.equal(expectedBundleDigest(cut, 'solver', stamped), BUNDLED_DIGEST)
})

test('D2S Details sends None for an unpinned waiter, including with roles turned off', async t => {
  for (const roles of [true, false]) await t.test(`roles=${roles}`, async t => {
    const f = await fixture(t, { offline: true, roleDeps: {}, extra: { prefs: { roles } } })
    const bot = f.rt.state.bots[BOT.id]
    bot.waitingRole = waitFor(bot.instructions, bot.role)
    await f.rt.save()
    const roster = (await f.call('state')).value
    const shown = roster.bots.find(bot => bot.id === BOT.id)
    assert.equal(Object.hasOwn(shown, 'waitingRole'), false)
    const surfaces = await mountRoleSurfaces()
    const posted = []
    const operations = []
    const actions = teamActions({
      call: async (endpoint, payload) => {
        posted.push([endpoint, payload])
        const reply = await f.call(endpoint, payload)
        assert.equal(reply.ok, true, reply.error?.message)
        return reply.value
      },
      after: work => work,
    })
    actions.roleCatalog = undefined
    actions.refreshModels = undefined
    const { form } = surfaces.settings({ roster, bot: shown, actions, run: work => operations.push(work) })
    surfaceButton(form, 'None').props.onClick()
    await Promise.all(operations)
    assert.deepEqual(posted, [['role-detach', { id: BOT.id }]])
    const stored = (await f.disk()).bots[BOT.id]
    assert.equal(stored.waitingRole, undefined)
    assert.equal(stored.instructions, BOT.instructions)
    assert.deepEqual(stored.roles, [])
    if (roles) assert.deepEqual(await detachFrom(f), { ok: true, value: [] })
  })
})

test('D2 manual attachment preserves an edit already present at Phase B', async t => {
  const f = await catalogSolverFixture(t)
  await officialSolver(f)
  const bot = f.rt.state.bots[BOT.id]
  bot.waitingRole = waitFor(bot.instructions, bot.role)
  bot.instructions = 'Person edited before attachment.'
  assert.deepEqual(await attachTo(f, bot.id, 'solver'), { ok: true, value: ['solver'] })
  const stored = (await f.disk()).bots[bot.id]
  assert.equal(stored.instructions, 'Person edited before attachment.')
  assert.equal(stored.waitingRole, undefined)
})

test('D2 the settler finishes a waiting Solver in one pass and rechecks a stale marker after detach', async t => {
  const f = await catalogSolverFixture(t)
  await officialSolver(f)
  const bot = f.rt.state.bots[BOT.id]
  bot.waitingRole = waitFor(bot.instructions, bot.role)
  const attach = f.rt.attachRole
  let attempts = 0
  f.rt.attachRole = (...args) => { ++attempts; return attach(...args) }
  f.rt.solverSettle?.schedule()
  await until(() => !bot.waitingRole, { t })
  assert.equal(attempts, 1)
  assert.equal(bot.instructions, '')
  const prior = await fs.readFile(f.statePath, 'utf8')
  f.rt.solverSettle.schedule()
  await immediate()
  assert.equal(await fs.readFile(f.statePath, 'utf8'), prior)
  bot.instructions = BOT.instructions
  bot.waitingRole = waitFor(bot.instructions, bot.role)
  const expect = { bot, role: bot.role, slot: JSON.stringify(bot.roles), marker: JSON.stringify(bot.waitingRole), instructions: bot.instructions }
  assert.deepEqual(await detachFrom(f, bot.id), { ok: true, value: [] })
  await assert.rejects(attach(bot.id, 'solver', { expect }), /role changed/)
  assert.equal(bot.waitingRole, undefined)
  assert.equal(bot.instructions, BOT.instructions)
  assert.deepEqual(bot.roles, [])
})
