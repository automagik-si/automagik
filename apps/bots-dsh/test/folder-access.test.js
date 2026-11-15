import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { probeFolder } from '../src/host/folder-access.js'
import { install as folders } from '../src/host/folders.js'
import { FOLDER_ACCESS_NOTE, folderAccessNote } from '../src/shared/folder-access.js'
import { DICTIONARY } from '../src/client/i18n.js'

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'folder-access-'))
  const folder = join(home, 'chosen "folder" here'), team = join(home, 'team')
  await fs.mkdir(folder); await fs.mkdir(team)
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const contexts = new Map()
  const rt = { home: join(home, 'data'), config: {}, state: { bots: {}, rooms: {} }, botOf() {}, roomOf() {},
    ctx: { effect: fn => fn(), systemPrompt: { context: spec => contexts.set(spec.name, spec) }, get() {},
      workspaceRegistry: { get: () => ({ path: team }), resolveByPath: async path => ({ id: 'chosen', path }) } },
    privateClash: async () => undefined, save: async () => {} }
  folders(rt)
  return { rt, folder, contexts }
}

function block(t, method, code, matches) {
  const original = fs[method]
  fs[method] = async (...args) => {
    if (matches(args[0])) throw Object.assign(new Error('test OS refusal'), { code })
    return original(...args)
  }
  syncBuiltinESMExports()
  t.after(() => { fs[method] = original; syncBuiltinESMExports() })
}

test('folder probe reads, writes and reads back its own file, then removes it', async t => {
  const { folder, rt } = await fixture(t)
  await fs.writeFile(join(folder, 'keep.txt'), 'untouched')
  assert.equal(await probeFolder(folder), undefined)
  assert.equal(await rt.cleanWorkDir(folder), folder)
  assert.deepEqual(await fs.readdir(folder), ['keep.txt'])
  assert.equal(await fs.readFile(join(folder, 'keep.txt'), 'utf8'), 'untouched')
})

for (const [method, code] of [['open', 'EACCES'], ['access', 'EPERM'], ['open', 'EROFS']]) {
  test(`folder selection keeps the choice and names OS access to allow: ${code}`, async t => {
    const { rt, folder, contexts } = await fixture(t)
    block(t, method, code, path => String(path).startsWith(folder))
    assert.equal(await rt.cleanWorkDir(folder), folder)
    assert.deepEqual(rt.folderWarning(folder), { folder, code })
    assert.equal(await rt.isFolder(folder), true, 'an access warning does not change folder existence')
    assert.deepEqual(await rt.folderEndpoint('folder-probe', { path: folder }), { folder, code })
    const text = contexts.get('ds-bot:folder-access').text({ agent: { session: { header: { cwd: folder } } } })
    assert.equal(text, folderAccessNote(folder))
    assert.ok(text.includes(JSON.stringify(folder)))
    assert.match(text, /Allow Automagik.*Privacy & Security > Files and Folders.*choice has been kept/)
    // Folder selection for working_directory goes through workFolder too.
    assert.equal(await rt.workFolder(folder), folder)
  })
}

test('blocked realpath/stat never substitutes the team folder for the selected folder', async t => {
  const { rt, folder } = await fixture(t)
  block(t, 'realpath', 'EACCES', path => path === folder)
  block(t, 'stat', 'EACCES', path => path === folder)
  block(t, 'access', 'EACCES', path => path === folder)
  assert.equal(await rt.cleanWorkDir(folder), folder)
  assert.equal(await rt.isFolder(folder), false)
  assert.equal(await rt.folderAt('/', folder), folder)
  assert.equal(rt.folderWarning(folder).code, 'EACCES')
})

test('folder note uses existing bt-note and has English, Chinese and Portuguese copy', async () => {
  const pt = JSON.parse(await fs.readFile(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.match(FOLDER_ACCESS_NOTE, /\{folder\}/)
  assert.match(DICTIONARY.zh[FOLDER_ACCESS_NOTE], /\{folder\}.*Automagik/)
  assert.match(pt[FOLDER_ACCESS_NOTE], /\{folder\}.*Automagik.*Arquivos e Pastas/)
  for (const file of ['folder-menu.js', 'create-bot.js']) {
    const source = await fs.readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    assert.match(source, /className: 'bt-note'.*t\(FOLDER_ACCESS_NOTE/)
    assert.match(source, /folderProbe/)
  }
})

test('OS-blocked creation keeps the requested team folder and its warning', async t => {
  const { rt, folder } = await fixture(t)
  const chosen = join(folder, 'new-folder')
  block(t, 'mkdir', 'EACCES', path => path === chosen)
  assert.equal(await rt.setTeamWorkspace(chosen), chosen)
  assert.equal(rt.state.workspaceId, 'chosen')
  assert.deepEqual(rt.folderWarning(chosen), { folder: chosen, code: 'EACCES' })
  // A later probe that cannot yet reach the missing folder keeps the OS guidance.
  assert.deepEqual(await rt.checkFolderAccess(chosen), { folder: chosen, code: 'EACCES' })
})

for (const [method, code] of [['writeFile', 'EROFS'], ['read', 'EACCES']]) {
  test(`a probe ${method} refusal warns and cleans up its opened file`, async t => {
    const { folder } = await fixture(t)
    const original = fs.open
    const mock = t.mock.method(fs, 'open', async (path, flags, mode) => {
      assert.equal(flags, 'wx+')
      assert.equal(mode, 0o600)
      const file = await original(path, flags, mode)
      t.mock.method(file, method, async () => { throw Object.assign(new Error('blocked probe'), { code }) })
      return file
    })
    syncBuiltinESMExports()
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
    assert.deepEqual(await probeFolder(folder), { folder, code })
    assert.deepEqual(await fs.readdir(folder), [])
  })
}

test('a fresh successful probe clears the warning and the Bot’s folder context', async t => {
  const { rt, folder, contexts } = await fixture(t)
  await rt.checkFolderAccess(folder, { code: 'EPERM' })
  const context = contexts.get('ds-bot:folder-access')
  const turn = { agent: { session: { header: { cwd: folder } } } }
  assert.equal(context.text(turn), folderAccessNote(folder))
  assert.match(context.text(turn), /Full Disk Access.*elsewhere, allow your user to read and write/)
  assert.equal(await rt.checkFolderAccess(folder), undefined)
  assert.equal(rt.folderWarning(folder), undefined)
  assert.equal(context.text(turn), '')
  assert.deepEqual(await fs.readdir(folder), [])
})

test('folder-probe probes once, session checks cache each folder and explicit probes refresh it', async t => {
  const { rt, folder } = await fixture(t)
  const original = fs.open
  let probes = 0
  const mock = t.mock.method(fs, 'open', async (...args) => { probes++; return original(...args) })
  const listing = t.mock.method(fs, 'readdir', () => assert.fail('a folder access check must not list the directory'))
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); listing.mock.restore(); syncBuiltinESMExports() })
  assert.equal(await rt.folderEndpoint('folder-probe', { path: folder }), null)
  assert.equal(probes, 1)
  await Promise.all(Array.from({ length: 5 }, () => rt.checkFolderAccess(folder, undefined, { cached: true })))
  assert.equal(probes, 1)
  assert.equal(await rt.folderEndpoint('folder-probe', { path: folder }), null)
  assert.equal(probes, 2)
  await rt.checkFolderAccess(rt.teamFolder(), undefined, { cached: true })
  await rt.checkFolderAccess(rt.teamFolder(), undefined, { cached: true })
  assert.equal(probes, 3)
})

test('a cached warning is re-probed and a successful check clears the fallback session note', async t => {
  const { rt, folder, contexts } = await fixture(t)
  await rt.checkFolderAccess(folder, { code: 'EACCES' })
  rt.sessionFolderWarnings.set('test-fallback', folder)
  const context = { agent: { session: { id: 'test-fallback', header: { cwd: rt.teamFolder() } } } }
  assert.equal(contexts.get('ds-bot:folder-access').text(context), folderAccessNote(folder))
  await rt.checkFolderAccess(folder, undefined, { cached: true })
  assert.equal(rt.folderWarning(folder), undefined)
  assert.equal(contexts.get('ds-bot:folder-access').text(context), '')
})
