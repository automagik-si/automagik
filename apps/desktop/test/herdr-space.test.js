import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATE_MAX_BYTES, botPlace, folderKey, oneLine, openRequest, pickSpace, planSpace, spacesIn } from '../src/herdr-space.js'

const BOT = 'session-0b6f2c1e-5d4a-4c3b-9a2f-1e0d9c8b7a65'
const OTHER = 'session-1c7a3d2f-6e5b-4d4c-8b3a-2f1e0d9c8b76'
const space = (id, folder, { machine = null, active = false } = {}) => ({ id, folder, machine, active })

test('a match: the space on the Bot\'s folder on this computer is selected', () => {
  const spaces = [space('sp1', '/home/ana/site', { active: true }), space('sp2', '/home/ana/api')]
  assert.deepEqual(planSpace({ spaces, folder: '/home/ana/api', platform: 'linux' }),
    { action: 'select', argv: ['do', 'space.select', '--id', 'sp2'], id: 'sp2' })
})

const made = (args) => ['do', 'space.new', JSON.stringify(args)]

test('no match: space.new on that folder, named after it, on this computer (no machine)', () => {
  const spaces = [space('sp1', '/home/ana/site')]
  assert.deepEqual(planSpace({ spaces, folder: '/home/ana/api', platform: 'linux' }),
    { action: 'new', argv: made({ name: 'api', folder: '/home/ana/api' }) })
  assert.deepEqual(planSpace({ spaces: [], folder: '/home/ana/api/', platform: 'darwin' }).argv,
    made({ name: 'api', folder: '/home/ana/api/' }))
})

test('space.new is one JSON object: a folder named like a flag, a number or a bool stays a string', () => {
  for (const name of ['-x', '--folder', 'true', '2026', 'null', '{"a":1}', 'a b']) {
    const { argv } = planSpace({ spaces: [], folder: `/w/${name}`, platform: 'linux' })
    assert.equal(argv.length, 3, name)
    assert.deepEqual(JSON.parse(argv[2]), { name, folder: `/w/${name}` })
  }
})

test('two matches: the active one, else the first ls lists, with a note for the log', () => {
  const both = [space('sp1', '/w/api'), space('sp2', '/w/api/', { active: true }), space('sp3', '/w/api')]
  const active = planSpace({ spaces: both, folder: '/w/api', platform: 'linux' })
  assert.deepEqual(active.argv, ['do', 'space.select', '--id', 'sp2'])
  assert.match(active.note, /^3 spaces on \/w\/api: sp1, sp2, sp3; picked sp2 \(active\)$/)
  const idle = planSpace({ spaces: [space('sp4', '/w/api'), space('sp5', '/w/api')], folder: '/w/api', platform: 'linux' })
  assert.deepEqual(idle.argv, ['do', 'space.select', '--id', 'sp4'])
  assert.match(idle.note, /picked sp4 \(first\)$/)
  // The same answer every time for the same ls.
  assert.deepEqual(planSpace({ spaces: both, folder: '/w/api', platform: 'linux' }), active)
})

test('a remote machine: only that machine\'s space matches; else space.new on that machine', () => {
  const spaces = [space('local', '/srv/api'), space('other', '/srv/api', { machine: 'box' }), space('vps', '/srv/api/', { machine: 'vps' })]
  assert.deepEqual(planSpace({ spaces, folder: '/srv/api', machine: 'vps', platform: 'darwin' }).argv, ['do', 'space.select', '--id', 'vps'])
  assert.deepEqual(planSpace({ spaces, folder: '/srv/api', platform: 'darwin' }).argv, ['do', 'space.select', '--id', 'local'])
  assert.deepEqual(planSpace({ spaces: spaces.slice(0, 2), folder: '/srv/api', machine: 'vps', platform: 'win32' }),
    { action: 'new', argv: made({ name: 'api', folder: '/srv/api', machine: 'vps' }) })
  // A remote folder is never resolved on this computer.
  const resolve = () => { throw new Error('resolved a remote folder') }
  assert.equal(planSpace({ spaces, folder: '/srv/api', machine: 'vps', platform: 'linux', resolve }).id, 'vps')
})

test('no folder: code mode with no space picked (D27)', () => {
  const spaces = [space('sp1', '/w/api', { active: true })]
  for (const folder of [null, undefined, '']) {
    assert.deepEqual(planSpace({ spaces, folder, platform: 'linux' }), { action: 'none', argv: null })
  }
})

test('Windows: ls\'s backslash folders match whatever their case or separators', () => {
  const spaces = [space('sp1', 'C:\\Users\\Ana\\Site\\')]
  assert.equal(planSpace({ spaces, folder: 'c:/users/ana/site', platform: 'win32' }).id, 'sp1')
  assert.deepEqual(planSpace({ spaces, folder: 'C:\\Users\\Ana\\Api', platform: 'win32' }).argv,
    made({ name: 'Api', folder: 'C:\\Users\\Ana\\Api' }))
  // macOS and Linux keep case.
  assert.equal(planSpace({ spaces: [space('sp1', '/w/Site')], folder: '/w/site', platform: 'linux' }).action, 'new')
  assert.equal(folderKey('C:\\', 'win32'), 'c:\\')
  assert.equal(folderKey('/', 'linux'), '/')
})

test('a space on the machine\'s home (empty folder) or with none matches no Bot; a link matches its folder', () => {
  const spaces = [space('home', ''), space('none', null)]
  assert.equal(planSpace({ spaces, folder: '/Users/ana', platform: 'darwin' }).action, 'new')
  const resolve = dir => (dir === '/var/w/api' ? '/private/var/w/api' : dir)
  assert.equal(planSpace({ spaces: [space('sp1', '/var/w/api')], folder: '/private/var/w/api', platform: 'darwin', resolve }).id, 'sp1')
})

test('ls JSON: the spaces it lists, and null for anything else', () => {
  const ls = JSON.stringify({ spaces: [{ id: 'sp1', name: 'x', folder: '/w', machine: null, active: true, tabs: [] }, { id: 7 }, null, { id: 'sp2', machine: '' }], recent: [] })
  assert.deepEqual(spacesIn(ls), [{ id: 'sp1', folder: '/w', machine: null, active: true }, { id: 'sp2', folder: null, machine: null, active: false }])
  for (const bad of ['', 'not json', '{}', '{"spaces":{}}', 'null']) assert.equal(spacesIn(bad), null)
})

// The Bot team's state.json under a fake app home.
const APP = '/home/ana/.automagik/desktop'
const stateOf = bots => ({ [`${APP}/bots/state.json`]: JSON.stringify({ version: 1, bots }) })
const reader = files => async file => {
  if (!(file in files)) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' })
  return files[file]
}
const folders = list => dir => list.includes(dir)

test('the lookup reads the Bot\'s folder from the Bot team\'s state; every Bot is on this computer today', async () => {
  const read = reader(stateOf({ [BOT]: { name: 'Site', workDir: '/w/site', machine: 'vps' }, [OTHER]: { name: 'Global' } }))
  const isFolder = folders(['/w/site'])
  assert.deepEqual(await botPlace(BOT, { appHome: APP, platform: 'linux', read, isFolder }), { folder: '/w/site', machine: null })
  assert.deepEqual(await botPlace(OTHER, { appHome: APP, platform: 'linux', read, isFolder }), { folder: null, machine: null })
})

test('the lookup refuses unknown and invalid Bot ids, and reads no file for a bad one', async () => {
  const files = stateOf({ [BOT]: { workDir: '/w/site' }, b1: { workDir: '/w/b1' } })
  let reads = 0
  const read = async file => { reads++; return reader(files)(file) }
  const isFolder = folders(['/w/site', '/w/b1'])
  for (const bad of ['b1', '__proto__', 'constructor', '', null, undefined, 42, { id: BOT }, `${BOT} `, `../${BOT}`, BOT.toUpperCase().replace('SESSION', 'x')]) {
    assert.equal(await botPlace(bad, { appHome: APP, platform: 'linux', read, isFolder }), null, String(bad))
  }
  assert.equal(reads, 0)
  assert.equal(await botPlace(OTHER, { appHome: APP, platform: 'linux', read, isFolder }), null)
  assert.equal(await botPlace(BOT, { appHome: undefined, platform: 'linux', read, isFolder }), null)
})

test('the lookup: a torn or missing state is unknown; a relative, missing or odd folder is none', async () => {
  const isFolder = folders(['/w/site', 'w/rel'])
  for (const text of ['{"version":1,"bots":{', '', 'null', '[]', JSON.stringify({ bots: null }), JSON.stringify({ bots: { [BOT]: 'x' } })]) {
    assert.equal(await botPlace(BOT, { appHome: APP, platform: 'linux', read: async () => text, isFolder }), null, text)
  }
  assert.equal(await botPlace(BOT, { appHome: APP, platform: 'linux', read: reader({}), isFolder }), null)
  for (const workDir of ['w/rel', '/w/gone', 42, '', ['/w/site']]) {
    const read = reader(stateOf({ [BOT]: { workDir } }))
    assert.deepEqual(await botPlace(BOT, { appHome: APP, platform: 'linux', read, isFolder }), { folder: null, machine: null }, String(workDir))
  }
  // Inherited names are not Bots.
  const read = reader({ [`${APP}/bots/state.json`]: '{"bots":{}}' })
  assert.equal(await botPlace('session-00000000-0000-4000-8000-000000000000', { appHome: APP, platform: 'linux', read, isFolder }), null)
})

test('the lookup reads no state over its cap: its Bots are unknown', async () => {
  const isFolder = folders(['/w/site'])
  const small = JSON.stringify({ bots: { [BOT]: { workDir: '/w/site' } } })
  const big = `${small.slice(0, -1)},"pad":"${'x'.repeat(STATE_MAX_BYTES)}"}`
  assert.deepEqual(await botPlace(BOT, { appHome: APP, platform: 'linux', read: async () => small, isFolder }), { folder: '/w/site', machine: null })
  assert.equal(await botPlace(BOT, { appHome: APP, platform: 'linux', read: async () => big, isFolder }), null)
})

test('the real reader: a state over the cap is not read at all', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, truncateSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const appHome = mkdtempSync(join(tmpdir(), 'herdr-space-'))
  mkdirSync(join(appHome, 'bots'))
  const file = join(appHome, 'bots', 'state.json')
  writeFileSync(file, JSON.stringify({ bots: { [BOT]: { workDir: appHome } } }))
  assert.deepEqual(await botPlace(BOT, { appHome }), { folder: appHome, machine: null })
  truncateSync(file, STATE_MAX_BYTES + 1)
  assert.equal(await botPlace(BOT, { appHome }), null)
})

test('a log line stays one line: control characters in a folder or a message become spaces', async () => {
  assert.equal(oneLine('a\nb\r\tc\u0000d\u2028e'), 'a b  c d e')
  const folder = '/w/two\nspace select forged'
  const herdr = fakeHerdr({ ls: { stdout: JSON.stringify({ spaces: [space('a', folder), space('b', folder)] }) }, 'space.select': { stdout: '{}' } })
  const read = reader(stateOf({ [BOT]: { workDir: folder } }))
  const lines = []
  await pickSpace({ botId: BOT, found: FOUND, platform: 'linux', env: {}, appHome: APP, execFile: herdr.execFile, read, isFolder: folders([folder]), resolve: dir => dir, log: line => lines.push(line) })
  assert.equal(lines.length, 2)
  for (const line of lines) assert.doesNotMatch(line, /[\n\r]/)
})

test('main takes only a Bot id and a yes or no from the page: a folder or machine is dropped', () => {
  assert.deepEqual(openRequest({ botId: BOT, folder: '/etc', machine: 'vps', update: true }), { botId: BOT, update: true })
  assert.deepEqual(openRequest({ botId: '/etc/passwd', update: 'yes' }), { botId: null, update: undefined })
  assert.deepEqual(openRequest(null), { botId: null, update: undefined })
  assert.deepEqual(openRequest({ folder: '/w/site' }), { botId: null, update: undefined })
})

const ROW = 'b-abcdefghij'
const GLOBAL = 'b-abcdefghik'
const ROOT = '/home/ana/.automagik'

test('main accepts registry ids only for Code requests and drops unrecognized sources and paths', () => {
  const registrySession = `session-${'a'.repeat(36)}`
  for (const botId of [ROW, registrySession]) {
    assert.deepEqual(openRequest({ botId, source: 'code', update: false, folder: '/etc', machine: 'vps' }),
      { botId, source: 'code', update: false })
    assert.deepEqual(openRequest({ botId, source: 'Code' }), { botId: null, update: undefined })
  }
  assert.deepEqual(openRequest({ botId: BOT, source: true }), { botId: BOT, update: undefined })
  assert.deepEqual(openRequest({ botId: BOT.toUpperCase(), source: 'code' }), { botId: null, source: 'code', update: undefined })
  assert.deepEqual(openRequest({ botId: BOT.toUpperCase() }), { botId: BOT.toUpperCase(), update: undefined })
})

// A fake herdr-app for pickSpace: records each argv and answers from `answers` by command.
function fakeHerdr(answers) {
  const calls = []
  const execFile = (file, args, options, done) => {
    calls.push(args)
    const key = args[0] === 'do' ? args[1] : args[0]
    const { code = 0, stdout = '', stderr = '' } = answers[key] ?? { code: 1, stderr: `no answer for ${key}` }
    const error = code === 0 ? null : Object.assign(new Error(stderr), { code })
    queueMicrotask(() => done(error, stdout, stderr))
  }
  return { calls, execFile }
}
const FOUND = { bin: '/home/ana/.local/share/herdr-app/herdr-app', app: null, source: 'install' }
const LS = JSON.stringify({ spaces: [{ id: 'sp1', folder: '/w/site', machine: null, active: false }, { id: 'sp9', folder: '/etc', machine: null, active: true }] })

test('pickSpace: the folder comes from the state, never from the page', async () => {
  const herdr = fakeHerdr({ ls: { stdout: LS }, 'space.select': { stdout: '{}' } })
  const read = reader(stateOf({ [BOT]: { workDir: '/w/site' } }))
  const lines = []
  const marks = []
  const { botId } = openRequest({ botId: BOT, folder: '/etc', machine: 'vps' })
  const result = await pickSpace({ botId, found: FOUND, platform: 'linux', env: {}, appHome: APP, execFile: herdr.execFile, read, isFolder: folders(['/w/site']), resolve: dir => dir, mark: step => marks.push(step), log: line => lines.push(line) })
  assert.deepEqual(result, { action: 'select', id: 'sp1' })
  assert.deepEqual(herdr.calls, [['ls'], ['do', 'space.select', '--id', 'sp1']])
  assert.deepEqual(marks, ['space'])
  assert.deepEqual(lines, ['space select sp1'])
})

test('pickSpace: a registry-only Code Bot selects or creates its project space', async () => {
  const read = reader({
    [`${ROOT}/bots/bots.json`]: JSON.stringify({ version: 2, bots: [], projects: [{ folder: '/w/site' }], shown: [{ project: '/w/site', bots: [] }] }),
    '/w/site/.automagik/bots/bots.json': JSON.stringify({ version: 2, bots: [{ id: ROW, name: 'Site', folder: '/etc' }] }),
  })
  const opts = { ...openRequest({ botId: ROW, source: 'code', folder: '/etc' }), found: FOUND, platform: 'linux', env: {}, appHome: APP, registryRoot: ROOT, read, isFolder: folders(['/w/site']), resolve: dir => dir }
  const selected = fakeHerdr({ ls: { stdout: LS }, 'space.select': { stdout: '{}' } })
  assert.deepEqual(await pickSpace({ ...opts, execFile: selected.execFile }), { action: 'select', id: 'sp1' })
  assert.deepEqual(selected.calls, [['ls'], ['do', 'space.select', '--id', 'sp1']])
  const created = fakeHerdr({ ls: { stdout: '{"spaces":[]}' }, 'space.new': { stdout: '{"space":"new"}' } })
  assert.deepEqual(await pickSpace({ ...opts, execFile: created.execFile }), { action: 'new', id: 'new' })
  assert.deepEqual(created.calls, [['ls'], made({ name: 'site', folder: '/w/site' })])
})

test('pickSpace: an unknown Code Bot never falls back to state, and a global Code Bot has no folder', async () => {
  const read = reader({
    ...stateOf({ [BOT]: { workDir: '/w/site' } }),
    [`${APP}/bots/bots.json`]: JSON.stringify({ version: 2, bots: [{ id: BOT, name: 'Desktop-only decoy' }] }),
    [`${ROOT}/bots/bots.json`]: JSON.stringify({ version: 2, bots: [{ id: GLOBAL, name: 'Global' }] }),
  })
  const herdr = fakeHerdr({})
  for (const [botId, why] of [[BOT, 'unknown Bot'], [GLOBAL, 'no folder']]) {
    const lines = []
    assert.deepEqual(await pickSpace({ botId, source: 'code', found: FOUND, platform: 'linux', env: {}, appHome: APP, registryRoot: ROOT, execFile: herdr.execFile, read, log: line => lines.push(line) }), { action: 'none' })
    assert.deepEqual(lines, [`no-space ${why}`])
  }
  assert.deepEqual(herdr.calls, [])
})

test('pickSpace: no match makes the space and reports its id; two matches log the pick', async () => {
  const made = fakeHerdr({ ls: { stdout: '{"spaces":[]}' }, 'space.new': { stdout: '{"space":"spN","tab":"tb1","terminal":"t1"}' } })
  const read = reader(stateOf({ [BOT]: { workDir: '/w/api' } }))
  const opts = { botId: BOT, found: FOUND, platform: 'linux', env: {}, appHome: APP, read, isFolder: folders(['/w/api']), resolve: dir => dir }
  assert.deepEqual(await pickSpace({ ...opts, execFile: made.execFile }), { action: 'new', id: 'spN' })
  assert.deepEqual(made.calls[1], ['do', 'space.new', '{"name":"api","folder":"/w/api"}'])
  const twice = fakeHerdr({ ls: { stdout: JSON.stringify({ spaces: [space('a', '/w/api'), space('b', '/w/api')] }) }, 'space.select': { stdout: '{}' } })
  const lines = []
  assert.deepEqual(await pickSpace({ ...opts, execFile: twice.execFile, log: line => lines.push(line) }), { action: 'select', id: 'a' })
  assert.deepEqual(lines, ['space 2 spaces on /w/api: a, b; picked a (first)', 'space select a'])
})

test('pickSpace: an unknown Bot, a bad id, or a Bot with no folder runs nothing and logs no-space', async () => {
  const herdr = fakeHerdr({})
  const read = reader(stateOf({ [BOT]: {} }))
  for (const [botId, why] of [[OTHER, 'unknown Bot'], [null, 'no Bot'], [BOT, 'no folder']]) {
    const lines = []
    assert.deepEqual(await pickSpace({ botId, found: FOUND, platform: 'linux', env: {}, appHome: APP, execFile: herdr.execFile, read, log: line => lines.push(line) }), { action: 'none' })
    assert.deepEqual(lines, [`no-space ${why}`])
  }
  assert.deepEqual(herdr.calls, [])
})

test('pickSpace: herdr-app\'s refusal or a broken ls is reported, never thrown', async () => {
  const read = reader(stateOf({ [BOT]: { workDir: '/w/api' } }))
  const opts = { botId: BOT, found: FOUND, platform: 'linux', env: {}, appHome: APP, read, isFolder: folders(['/w/api']), resolve: dir => dir }
  const refused = fakeHerdr({ ls: { stdout: '{"spaces":[]}' }, 'space.new': { code: 1, stdout: '{"error":"no folder /w/api"}' } })
  const lines = []
  assert.deepEqual(await pickSpace({ ...opts, execFile: refused.execFile, log: line => lines.push(line) }), { action: 'new', error: 'no folder /w/api' })
  assert.deepEqual(lines, ['do-error space.new: no folder /w/api'])
  const broken = fakeHerdr({ ls: { code: 2, stderr: 'no Herdr window' } })
  assert.deepEqual(await pickSpace({ ...opts, execFile: broken.execFile }), { action: 'none', error: 'no Herdr window' })
  const garbled = fakeHerdr({ ls: { stdout: 'oops' } })
  assert.deepEqual(await pickSpace({ ...opts, execFile: garbled.execFile }), { action: 'none', error: 'ls gave no spaces' })
})
