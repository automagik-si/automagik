import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { teamActions } from '../src/client/team-actions.js'
import { MCP_PATH } from '../src/host/agent-access.js'
import { ROUTE } from '../src/host/constants.js'
import { installRoles } from '../src/host/roles.js'
import { fakeContext } from './fake-ctx.js'
import { entryOf, INDEX, manifestOf, packageOf, SHA256, SIGNATURE, signer } from './role-fixture.js'

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

async function fixture(t, { bytes, entry, extra, readOnly, offline = false } = {}) {
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
    const ctx = fakeContext()
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
    ctx.sessionController = { resolveAgent: async () => ({ agent }) }
    apply(ctx, { home, memory: false, browser: false, updateCheck: false, mainName: BOT.name })
    const rt = ctx.provided.get('omniTeam')
    installRoles(rt, {
      keys: [key], now: () => clock, fs: injectedFs,
      fetch: async (url, init) => {
        fetches.push(url)
        assert.equal(init.redirect, 'manual')
        assert.ok(paths.has(url), 'unexpected fixture URL')
        return paths.get(url)()
      },
    })
    await rt.load()
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
