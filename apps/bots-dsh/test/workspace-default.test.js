import assert from 'node:assert/strict'
import fs, { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function fixture(t, defaultPreset = 'read-only') {
  const home = await mkdtemp(join(tmpdir(), 'workspace-default-'))
  const folder = join(home, 'workspace')
  await mkdir(folder)
  const parent = { id: 'test-parent', name: 'the test Bot parent', permission: 'read-only', createdAt: 1 }
  await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1, bots: { [parent.id]: parent }, rooms: {}, mainBotIds: [parent.id] }))
  const specs = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const levels = new Map(), places = []
  const presets = { catalog: () => ({ options: Object.keys(specs).map(value => ({ value, name: value })), defaultPreset }),
    resolve: name => specs[name], current: session => levels.get(session.id) ?? defaultPreset,
    set: (session, name) => levels.set(session.id, name) }
  const ctx = fakeContext({ services: { permissionPresets: presets } })
  Object.assign(ctx, {
    workspaceRegistry: { get: () => ({ id: 'workspace', path: folder }), resolveByPath: async path => path === folder ? { id: 'workspace', path: folder } : undefined, create: async () => ({ id: 'workspace', path: folder }) },
    sessionController: { create: async place => { places.push(place); return { sessionId: `test-created-${places.length}` } },
      resolveAgent: async id => ({ agent: { id, session: { id, header: { cwd: folder } }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {}, list: () => [] },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  return { rt, levels, folder, places }
}

test('a person-created Bot starts at Workspace even with a read-only profile and creator Bot', async t => {
  const { rt, levels } = await fixture(t)
  assert.equal(rt.newBotPermission(), 'workspace-write')
  const made = await rt.createBot({ name: 'the test Bot created by a person', pickModel: true })
  assert.equal(made.permission, 'workspace-write')
  assert.equal(levels.get(made.id), 'workspace-write')
  assert.equal(rt.botOf('test-parent').permission, 'read-only')
  const child = await rt.createBot({ name: 'the test Bot created by a Bot', createdBy: 'test-parent', pickModel: true })
  assert.equal(child.permission, 'read-only')
  assert.equal(levels.get(child.id), 'read-only')
})

test('the person’s explicit Read-only or Full access choice wins over Workspace', async t => {
  const { rt, levels } = await fixture(t)
  for (const permission of ['read-only', 'danger-full-access']) {
    rt.state.prefs.permission = permission
    assert.equal(rt.newBotPermission(), permission)
    const made = await rt.createBot({ name: `the test Bot ${permission}`, pickModel: true })
    assert.equal(made.permission, permission)
    assert.equal(levels.get(made.id), permission)
  }
})

test('an already-Workspace profile retains the unset default representation', async t => {
  const { rt } = await fixture(t, 'workspace-write')
  const made = await rt.createBot({ name: 'the test Bot default', pickModel: true })
  assert.equal(made.permission, undefined)
  assert.equal(rt.newBotPermission(), 'workspace-write')
})

test('create form and Settings show the same person-create default as the host', async () => {
  const create = await readFile(new URL('../src/client/create-bot.js', import.meta.url), 'utf8')
  const settings = await readFile(new URL('../src/client/settings.js', import.meta.url), 'utf8')
  const channel = await readFile(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  assert.match(create, /roster\.newBotPermission/)
  assert.match(settings, /saved: saved \?\? roster\.newBotPermission/)
  assert.match(channel, /newBotPermission: rt\.newBotPermission/)
})

test('Bot creation uses a readable non-writable chosen folder and keeps the access warning', async t => {
  const { rt, folder, places } = await fixture(t)
  const chosen = join(folder, 'chosen')
  await mkdir(chosen)
  const original = fs.open
  fs.open = async (path, ...args) => {
    if (String(path).startsWith(join(chosen, '.automagik-probe-'))) throw Object.assign(new Error('blocked'), { code: 'EROFS' })
    return original(path, ...args)
  }
  syncBuiltinESMExports()
  t.after(() => { fs.open = original; syncBuiltinESMExports() })
  const made = await rt.createBot({ name: 'the test Bot with a blocked folder', pickModel: true, workDir: chosen })
  assert.equal(made.workDir, chosen)
  assert.equal(made.permission, 'workspace-write')
  assert.deepEqual(places.at(-1), { cwd: chosen })
  assert.equal(rt.sessionFolderWarnings.get(made.id), undefined)
  assert.deepEqual(rt.folderWarning(chosen), { folder: chosen, code: 'EROFS' })
})

for (const permission of ['read-only', 'workspace-write', 'danger-full-access', 'removed-preset']) {
  test(`Bot descendants inherit ${permission} without widening to the person’s default`, async t => {
    const { rt, levels } = await fixture(t)
    rt.botOf('test-parent').permission = permission
    rt.state.prefs.permission = 'danger-full-access'
    const inherited = permission === 'removed-preset' ? 'read-only' : permission
    let parent = 'test-parent'
    for (let generation = 1; generation <= 3; generation++) {
      const child = await rt.createBot({ name: `the test Bot generation ${generation}`, createdBy: parent, main: generation < 3, pickModel: true })
      assert.equal(child.permission, inherited)
      assert.equal(levels.get(child.id), inherited)
      parent = child.id
    }
    assert.equal(rt.botOf('test-parent').permission, permission)
  })
}

test('an unrankable creator inherits the narrowest offered level', async t => {
  const { rt, levels } = await fixture(t)
  const service = rt.ctx.get('permissionPresets')
  const resolve = service.resolve
  service.resolve = name => name === 'test-unrankable' ? { sandbox: 'container', approval: 'ask' } : resolve(name)
  rt.botOf('test-parent').permission = 'test-unrankable'
  rt.state.prefs.permission = 'danger-full-access'
  const child = await rt.createBot({ name: 'the test Bot with an unrankable creator', createdBy: 'test-parent', pickModel: true })
  assert.equal(child.permission, 'read-only')
  assert.equal(levels.get(child.id), 'read-only')
})

for (const code of ['EACCES', 'EPERM']) test(`a missing OS-blocked choice is saved but never used as session cwd: ${code}`, async t => {
  const { rt, folder, places } = await fixture(t)
  const chosen = join(folder, 'inaccessible', 'missing')
  const mocks = ['realpath', 'stat', 'access', 'open'].map(method => {
    const original = fs[method]
    return t.mock.method(fs, method, async (path, ...args) => {
      if (String(path).startsWith(chosen)) throw Object.assign(new Error('OS blocked'), { code })
      return original(path, ...args)
    })
  })
  syncBuiltinESMExports()
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports() })
  const made = await rt.createBot({ name: 'the test Bot blocked by the OS', pickModel: true, workDir: chosen })
  assert.equal(made.workDir, chosen)
  assert.equal(await rt.isFolder(chosen), false)
  assert.deepEqual(rt.folderWarning(chosen), { folder: chosen, code })
  assert.equal(places.at(-1).cwd, undefined)
  assert.equal(places.at(-1).workspaceId, rt.state.workspaceId)
  assert.equal(rt.sessionFolderWarnings.get(made.id), chosen)
})

test('session creation reuses each folder probe and registers no unnamed effects', async t => {
  const { rt, folder } = await fixture(t)
  const chosen = join(folder, 'chosen')
  await mkdir(chosen)
  const original = fs.open
  let probes = 0
  const mock = t.mock.method(fs, 'open', async (path, ...args) => {
    if (String(path).includes('.automagik-probe-')) probes++
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  await rt.cleanWorkDir(chosen)
  assert.equal(probes, 1)
  await rt.createSession('the test session one', { dir: chosen })
  await rt.createSession('the test session two', { dir: chosen })
  assert.equal(probes, 1)
  assert.ok(rt.ctx.calls.includes('effect ds-bot: folder access context'))
  assert.ok(!rt.ctx.calls.includes('effect undefined'))
})

test('a blocked selected team workspace stays saved while a session uses the default workspace', async t => {
  const { rt, folder, places } = await fixture(t)
  const chosen = join(folder, 'blocked-team')
  rt.state.workspaceId = 'selected-team'
  rt.ctx.workspaceRegistry.get = id => id === 'selected-team' ? { id, path: chosen } : undefined
  await rt.checkFolderAccess(chosen, { code: 'EACCES' })
  const original = fs.mkdir
  const mock = t.mock.method(fs, 'mkdir', async (path, ...args) => {
    if (path === chosen) throw Object.assign(new Error('blocked'), { code: 'EACCES' })
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const id = await rt.createSession('the test session with a blocked team folder')
  assert.equal(places.at(-1).cwd, rt.defaultTeamFolder())
  assert.equal(rt.state.workspaceId, 'selected-team')
  assert.equal(rt.teamFolder(), chosen)
  assert.equal(rt.sessionFolderWarnings.get(id), chosen)
  assert.deepEqual(rt.folderWarning(chosen), { folder: chosen, code: 'EACCES' })
})

for (const place of ['chosen', 'team']) {
  for (const denied of ['read', 'enter', 'write']) {
    test(`${place} folder denied ${denied}: only read/enter failures move the session`, async t => {
      const { rt, folder, places } = await fixture(t)
      const chosen = join(folder, `test-${place}`)
      await mkdir(chosen)
      if (place === 'team') {
        rt.state.workspaceId = 'test-selected-team'
        rt.ctx.workspaceRegistry.get = () => ({ id: rt.state.workspaceId, path: chosen })
      } else {
        rt.ctx.workspaceRegistry.resolveByPath = async path => path === chosen ? { id: 'test-chosen', path } : undefined
      }
      const masks = { read: 4, enter: 1, write: 2 }
      const original = fs.access
      const modes = []
      let blocked = true
      const mock = t.mock.method(fs, 'access', async (path, mode) => {
        if (path === chosen) {
          modes.push(mode)
          if (blocked && (mode & masks[denied])) throw Object.assign(new Error('test access refusal'), { code: 'EACCES' })
        }
        return original(path, mode)
      })
      syncBuiltinESMExports()
      t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
      const options = place === 'chosen' ? { dir: chosen } : {}
      const id = await rt.createSession('the test session with restricted access', options)
      assert.ok(modes.includes(5), 'session creation checks R_OK | X_OK separately from write access')
      assert.equal(await rt.isFolder(chosen), true)
      assert.deepEqual(rt.folderWarning(chosen), { folder: chosen, code: 'EACCES' })
      const expected = { workspaceId: place === 'chosen' ? 'test-chosen' : 'test-selected-team' }
      assert.deepEqual(places.at(-1), denied === 'write' ? expected
        : place === 'chosen' ? { workspaceId: rt.state.workspaceId } : { cwd: rt.defaultTeamFolder() })
      assert.equal(rt.sessionFolderWarnings.get(id), denied === 'write' ? undefined : chosen)
      blocked = false
      const recovered = await rt.createSession('the test session after access is allowed', options)
      assert.deepEqual(places.at(-1), expected)
      assert.equal(rt.folderWarning(chosen), undefined)
      assert.equal(rt.sessionFolderWarnings.get(recovered), undefined)
    })
  }
}

test('a registered team workspace without a reported path still creates sessions by workspaceId', async t => {
  const { rt, places } = await fixture(t)
  rt.state.workspaceId = 'test-pathless-workspace'
  rt.ctx.workspaceRegistry.get = id => ({ id })
  await rt.createSession('the test session in a registered workspace')
  assert.deepEqual(places.at(-1), { workspaceId: 'test-pathless-workspace' })
})

for (const guard of ['workFolder', 'group', 'read-only', 'private', 'approveFolder']) {
  test(`a folder with a write warning still runs the working_directory ${guard} check`, async t => {
    const { rt, folder } = await fixture(t)
    const target = await mkdtemp(join(tmpdir(), 'test-warned-work-dir-'))
    t.after(() => rm(target, { recursive: true, force: true }))
    const original = fs.open
    const mock = t.mock.method(fs, 'open', async (path, ...args) => {
      if (String(path).startsWith(join(target, '.automagik-probe-'))) throw Object.assign(new Error('test write refusal'), { code: 'EROFS' })
      return original(path, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
    await rt.checkFolderAccess(target)
    assert.deepEqual(rt.folderWarning(target), { folder: target, code: 'EROFS' })
    const id = 'test-parent'
    if (guard === 'group' || guard === 'private') {
      rt.state.rooms['test-room'] = { id: 'test-room', members: [id], sessions: { [id]: id }, ...(guard === 'group' ? { workDir: folder } : {}) }
      rt.groupOwners.set(id, { roomId: 'test-room', botId: id })
    }
    if (guard === 'workFolder') rt.workFolder = async () => { throw new Error('test workFolder refusal') }
    if (guard === 'read-only') rt.readOnly = () => 'test read-only refusal'
    if (guard === 'private') rt.checkPrivacyChange = async () => { throw new Error('test private refusal') }
    if (guard === 'approveFolder') rt.approveFolder = async () => { throw new Error('test approveFolder refusal') }
    const exec = { name: 'working_directory', arguments: { cd: target }, agent: { id, session: { id, header: { id, cwd: folder } } }, callId: 'test-working-directory' }
    const run = rt.ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), () => assert.fail('the guarded folder change must not reach the tool'))
    await assert.rejects(run, guard === 'group' ? /Every member.*works in/ : new RegExp(`test ${guard} refusal`))
  })
}
