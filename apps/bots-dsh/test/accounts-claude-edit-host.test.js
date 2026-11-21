// Settings → Accounts, Add and Remove login (RFC 0030 delivery 5b; Decisions (2026-11-21), 1): the
// host's edit offers, the panel's checks it runs again at the press, and the one writer it calls.
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { accountsFixture, accountsHost, CANARY, LIST, SNAPSHOT } from './fixtures/accounts-host.mjs'
import { WINDOW } from './fixtures/automations-host.mjs'

const ADD = 'accounts-claude-add'
const REMOVE = 'accounts-claude-remove'
const CORE = 'core-test'
const SOCKET = '/fixture/core.sock'
const WHERE = { program: '/fixture/bin/claude', path: '/fixture/bin:/usr/bin:/bin' }

const value = async (host, endpoint = LIST, payload, options) => {
  const response = await host.request(endpoint, payload, options)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const reply = await response.json()
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.value
}

/**
 * The 5b fixture with real login folders: default selected, login 2 and login 3 listed under a
 * scratch home, `nextSlot` login 4, and the CLI's core id. `probe` and `argvs` stand in for claude
 * and the core; their calls are recorded.
 */
function editFixture(t, { status = { state: 'in', loggedIn: true }, seen = [], where = WHERE, socket = SOCKET, ...options } = {}) {
  const f = accountsFixture(t)
  const home = f.root
  const two = join(home, '.claude-2'), three = join(home, '.claude-3'), four = join(home, '.claude-4')
  for (const dir of [two, three]) mkdirSync(dir)
  f.answer.core = CORE
  f.answer.claude.slots = [
    { id: 'default', email: 'A@example.test', state: 'eligible', dir: null },
    { id: '2', email: 'B@example.test', state: 'eligible', dir: two },
    { id: '3', email: null, state: 'not-signed-in', dir: three },
  ]
  f.answer.claude.nextSlot = four
  const state = { where: { reply: where } }
  const respond = (control = {}) => f.respond({ ...state, ...control })
  respond()
  const probes = [], scans = [], cores = []
  const answers = { status, seen }
  const host = accountsHost(t, f, {
    probe: async (dir, at) => { probes.push({ dir, where: at }); return typeof answers.status === 'function' ? answers.status(dir) : answers.status },
    argvs: async (at) => {
      scans.push({ core: at.core, socket: at.socket })
      assert.equal(typeof at.deadline, 'number')
      return typeof answers.seen === 'function' ? answers.seen() : answers.seen
    },
    findCore: async () => { cores.push(true); return socket },
    ...options,
  })
  const writes = () => f.calls().filter(call => call.argv[0] === 'set-login')
  return { ...f, home, two, three, four, host, probes, scans, cores, answers, respond, writes }
}

test('the read offers Remove for listed logins the record does not select, and Add for the next slot only', async t => {
  const e = editFixture(t)
  const view = await value(e.host)
  assert.match(view.editToken, /^[a-f0-9]{32}$/)
  assert.deepEqual(view.rows.map(row => [row.id, row.remove === true]), [['default', false], ['2', true], ['3', true]])
  assert.deepEqual(view.add, { id: '4', folder: '~/.claude-4', signIn: 'CLAUDE_CONFIG_DIR="$HOME/.claude-4" claude auth login' })
  // No folder of this computer reaches the page: only the fixed `~/.claude-<n>` text.
  assert.doesNotMatch(JSON.stringify(view), new RegExp(e.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(JSON.stringify(view), new RegExp(CANARY))
  assert.deepEqual(e.probes, [])
})

test('the selected login is never removable, and an edit needs a record the CLI follows as written', async t => {
  const e = editFixture(t)
  e.answer.claude.selected = '2'
  e.answer.claude.effective = '2'
  e.respond()
  let view = await value(e.host)
  assert.deepEqual(view.rows.filter(row => row.remove).map(row => row.id), ['3'])

  for (const change of [
    claude => { claude.effective = 'default' }, // fallback: the selected login's folder is refused
    claude => { claude.record = 'bad'; claude.snapshot = SNAPSHOT },
    claude => { claude.slots[1].state = 'bad-folder' },
  ]) {
    e.answer.claude.selected = '2'
    e.answer.claude.effective = '2'
    e.answer.claude.record = 'ok'
    e.answer.claude.slots[1].state = 'eligible'
    change(e.answer.claude)
    e.respond()
    view = await value(e.host)
    assert.equal(Object.hasOwn(view, 'editToken'), false)
    assert.equal(Object.hasOwn(view, 'add'), false)
    assert.equal(view.rows.some(row => row.remove), false)
  }
})

test('a selected login that timed out stays editable only while its folder still passes the check', async t => {
  const e = editFixture(t)
  Object.assign(e.answer.claude, { selected: '2', effective: '2' })
  e.answer.claude.slots[1].state = 'timeout'
  e.respond()
  assert.match((await value(e.host)).editToken, /^[a-f0-9]{32}$/)
  writeFileSync(join(e.home, 'plain'), '')
  e.answer.claude.slots[1].dir = join(e.home, 'plain')
  e.respond()
  assert.equal(Object.hasOwn(await value(e.host), 'editToken'), false)
  // The default login has no folder check: its timeout is claude's own and does not block.
  Object.assign(e.answer.claude, { selected: 'default', effective: 'default' })
  e.answer.claude.slots[0].state = 'timeout'
  e.respond()
  assert.match((await value(e.host)).editToken, /^[a-f0-9]{32}$/)
})

test('a malformed next slot hides Add only, and an older panel or read-only host offers nothing', async t => {
  const e = editFixture(t)
  for (const nextSlot of [null, join(e.home, 'elsewhere'), join(e.home, '.claude-1'), join(e.home, '.claude-x'), '/other/.claude-4']) {
    e.answer.claude.nextSlot = nextSlot
    e.respond()
    const view = await value(e.host)
    assert.equal(Object.hasOwn(view, 'add'), false, String(nextSlot))
    assert.deepEqual(view.rows.filter(row => row.remove).map(row => row.id), ['2', '3'])
  }
  e.answer.claude.nextSlot = e.four
  e.answer.writer = { setLogin: true, panel: 'on', panelWrites: false, sidebarWrites: true, confirmed: false }
  e.respond()
  const old = await value(e.host)
  assert.equal(old.why, 'panel-old')
  assert.equal(Object.hasOwn(old, 'editToken'), false)
  e.answer.writer.panel = 'absent'
  e.respond()
  e.host.rt.canWriteTeam = () => false
  const readOnly = await value(e.host)
  assert.equal(readOnly.readOnly, true)
  assert.equal(Object.hasOwn(readOnly, 'editToken'), false)
})

test('Add probes the folder it shows, then writes through set-login with the snapshot it showed', async t => {
  const e = editFixture(t)
  const { editToken } = await value(e.host)
  mkdirSync(e.four)
  e.answers.status = { state: 'in', loggedIn: true, configDirectory: `${e.four}/` }
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: editToken }), { added: true })
  assert.deepEqual(e.probes, [{ dir: e.four, where: WHERE }])
  assert.deepEqual(e.cores, [])
  const calls = e.calls()
  assert.deepEqual(calls.map(call => call.argv), [
    ['here', '--within', '15', '--json'],
    ['here', '--within', '15', '--json'],
    ['launch-path', 'claude'],
    ['set-login', '--add', '4', '--dir', e.four, '--snapshot', SNAPSHOT, '--expect-home', e.appHome, '--json'],
  ])
  // The launch-path answer comes from the CLI's own module, imported by the plugin's adapter, not its program.
  assert.equal(calls[2].dir, e.pack)
  // The token was single use.
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: editToken }), { reason: 'changed' })
})

test('Add refuses before claude runs when the folder is missing, a symlink, or under a symlinked parent', async t => {
  const e = editFixture(t)
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: (await value(e.host)).editToken }), { reason: 'no-folder' })
  symlinkSync(e.two, e.four)
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: (await value(e.host)).editToken }), { reason: 'bad-folder' })
  assert.deepEqual(e.probes, [])
  assert.deepEqual(e.writes(), [])
})

test('Add needs claude signed in there, in that folder', async t => {
  const e = editFixture(t)
  mkdirSync(e.four)
  for (const [status, reason] of [
    [{ state: 'out' }, 'not-signed-in'],
    [{ state: 'in', loggedIn: false }, 'probe-failed'],
    [{ state: 'unread' }, 'probe-failed'],
    [{ state: 'late' }, 'probe-failed'],
    [{ state: 'nobin' }, 'no-claude'],
    [{ state: 'in', loggedIn: true, configDirectory: e.two }, 'moved'],
  ]) {
    e.answers.status = status
    assert.deepEqual(await value(e.host, ADD, { id: '4', token: (await value(e.host)).editToken }), { reason }, JSON.stringify(status))
  }
  e.respond({ where: { reply: { program: null, path: null } } })
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: (await value(e.host)).editToken }), { reason: 'no-claude' })
  e.respond({ where: { text: 'not json' } })
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: (await value(e.host)).editToken }), { reason: 'probe-failed' })
  assert.deepEqual(e.writes(), [])
})

test('an edit offer binds the slot, the snapshot, the selection, the CLI and the team it was shown with', async t => {
  const e = editFixture(t)
  mkdirSync(e.four)
  const stale = async (change, payload = { id: '4' }, endpoint = ADD) => {
    e.answer.claude.snapshot = SNAPSHOT
    e.answer.claude.nextSlot = e.four
    e.answer.claude.selected = 'default'
    e.respond()
    const { editToken } = await value(e.host)
    await change()
    return value(e.host, endpoint, { token: editToken, ...payload })
  }
  assert.deepEqual(await stale(() => { e.answer.claude.nextSlot = join(e.home, '.claude-5'); e.respond() }), { reason: 'changed' })
  assert.deepEqual(await stale(() => { e.answer.claude.snapshot = 'c'.repeat(64); e.respond() }), { reason: 'changed' })
  assert.deepEqual(await stale(() => { e.answer.claude.selected = '3'; e.respond() }), { reason: 'changed' })
  assert.deepEqual(await stale(() => {}, { id: '5' }), { reason: 'changed' })
  assert.deepEqual(await stale(() => {}, { id: '4' }, REMOVE), { reason: 'changed' })
  assert.deepEqual(await stale(() => { e.host.ownership.generation += 1 }), { reason: 'read-only' })
  assert.deepEqual(await stale(() => { e.answer.claude.slots[2].dir = join(e.home, '.claude-9'); e.respond() }, { id: '3' }, REMOVE), { reason: 'changed' })
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: 'f'.repeat(32) }), { reason: 'changed' })
  assert.deepEqual(e.writes(), [])
  assert.deepEqual(e.probes, [])
})

test('an edit offer lapses after fifteen minutes', async t => {
  let clock = 1_000
  const e = editFixture(t, { now: () => clock })
  mkdirSync(e.four)
  const { editToken } = await value(e.host)
  clock += 15 * 60_000
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: editToken }), { reason: 'changed' })
  const again = await value(e.host)
  clock += 15 * 60_000 - 1
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: again.editToken }), { added: true })
})

test('Remove needs claude signed out there and no terminal on it, on the core the CLI names', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  const { editToken } = await value(e.host)
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: editToken }), { removed: true })
  assert.deepEqual(e.probes, [{ dir: e.three, where: WHERE }])
  assert.deepEqual(e.scans, [{ core: CORE, socket: SOCKET }])
  const calls = e.calls()
  assert.deepEqual(calls.at(-1).argv, ['set-login', '--remove', '3', '--snapshot', SNAPSHOT, '--expect-home', e.appHome, '--json'])
  // The fresh read and the scan share one pinned socket; the page's read ran with none.
  assert.equal(e.cores.length, 1)
  assert.deepEqual(calls.filter(call => call.argv[0] === 'here').map(call => call.hcSocket ?? null), [null, SOCKET])
})

test('an explicit core socket is honoured as it is: it must answer, and nothing else is pinned', async t => {
  const checked = []
  let answers = true
  const e = editFixture(t, { status: { state: 'out' }, checkSocket: async (path) => { checked.push(path); return answers } })
  e.env.AUTOMAGIK_HERDR_CORE_SOCKET = '/fixture/explicit.sock'
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { removed: true })
  assert.deepEqual(checked, ['/fixture/explicit.sock'])
  assert.deepEqual(e.cores, [])
  assert.deepEqual(e.scans, [{ core: CORE, socket: '/fixture/explicit.sock' }])
  assert.deepEqual(e.calls().filter(call => call.argv[0] === 'here').map(call => call.hcSocket ?? null), [null, null])
  answers = false
  assert.deepEqual(await value(e.host, REMOVE, { id: '2', token: (await value(e.host)).editToken }), { reason: 'panes-unknown' })
  assert.equal(e.writes().length, 1)
})

test('the writer starts only with its whole time left, and the scan gets the deadline before it', async t => {
  let clock = 1_000
  const e = editFixture(t, { now: () => clock, status: { state: 'out' } })
  e.answers.seen = () => { clock += 61_000; return [] }
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'changed' })
  assert.deepEqual(e.writes(), [])
})

test('Remove refuses a signed-in login with the logout command for its own folder', async t => {
  const e = editFixture(t)
  const odd = join(e.home, `it's $(x) \`y\``)
  mkdirSync(odd)
  e.answer.claude.slots[2].dir = odd
  e.respond()
  const { editToken } = await value(e.host)
  const reply = await value(e.host, REMOVE, { id: '3', token: editToken })
  assert.deepEqual(reply, {
    reason: 'signed-in', signOut: `CLAUDE_CONFIG_DIR="$HOME"/'it'\\''s $(x) \`y\`' claude auth logout`, key: reply.key,
  })
  // The key names that login as read, and the next read's row carries the same one.
  assert.match(reply.key, /^[a-f0-9]{32}$/)
  assert.equal((await value(e.host)).rows.find(row => row.id === '3').key, reply.key)
  for (const [status, reason] of [[{ state: 'unread' }, 'probe-failed'], [{ state: 'late' }, 'probe-failed'], [{ state: 'nobin' }, 'no-claude']]) {
    e.answers.status = status
    assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason })
  }
  assert.deepEqual(e.scans, [])
  assert.deepEqual(e.writes(), [])
})

test('Remove refuses, with no command, when claude settings send the login to another folder', async t => {
  const e = editFixture(t)
  for (const state of ['in', 'out']) {
    e.answers.status = { state, loggedIn: state === 'in', configDirectory: join(e.home, '.claude') }
    assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'moved' })
  }
  assert.deepEqual(e.scans, [])
  assert.deepEqual(e.writes(), [])
})

test('Remove of a login whose folder is gone still asks claude, and goes on when it says signed out', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  e.answer.claude.slots[2].dir = join(e.home, '.claude-gone')
  e.respond()
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { removed: true })
  assert.deepEqual(e.probes.map(p => p.dir), [join(e.home, '.claude-gone')])
})

test('Remove refuses while a terminal runs on the login, by value, by real path or on an unknown folder', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  const alias = join(e.home, 'alias-3')
  symlinkSync(e.three, alias)
  const env = dir => ['/usr/bin/env', `PATH=/usr/bin`, `CLAUDE_CONFIG_DIR=${dir}`, 'claude']
  for (const [seen, reason] of [
    [[env(e.three)], 'running'],
    [[env(`${e.three}/`)], 'running'],
    [[env(alias)], 'running'],
    [[env(join(e.home, '.claude-elsewhere'))], 'running-unknown'],
    [null, 'panes-unknown'],
  ]) {
    e.answers.seen = seen
    assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason }, JSON.stringify(seen))
  }
  // A terminal on another listed login, on the default login, or outside home does not hold this one.
  e.answers.seen = [env(e.two), ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', 'claude'], env('/opt/elsewhere'), ['bash']]
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { removed: true })
  assert.equal(e.writes().length, 1)
})

test('two different explicit core sockets may be two cores: nothing is scanned or removed', async t => {
  const e = editFixture(t, { status: { state: 'out' }, checkSocket: async () => true })
  e.env.HC_SOCKET = '/fixture/a.sock'
  e.env.HC_TERMINAL_SOCKET = '/fixture/b.sock'
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'panes-unknown' })
  e.env.HC_TERMINAL_SOCKET = '/fixture/a.sock'
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { removed: true })
  assert.deepEqual(e.scans.map(scan => scan.socket), ['/fixture/a.sock'])
})

test('a login listed twice on the selected folder is never removable', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  Object.assign(e.answer.claude, { selected: '2', effective: '2' })
  e.answer.claude.slots.push({ id: 'old', email: null, state: 'eligible', dir: e.two })
  e.respond()
  const view = await value(e.host)
  assert.deepEqual(view.rows.filter(row => row.remove).map(row => row.id), ['3'])
  assert.deepEqual(await value(e.host, REMOVE, { id: 'old', token: view.editToken }), { reason: 'changed' })
  // Nor the default login's own folder under another id.
  Object.assign(e.answer.claude, { selected: 'default', effective: 'default' })
  e.answer.claude.slots[3].dir = join(e.home, '.claude')
  e.respond()
  assert.equal((await value(e.host)).rows.find(row => row.id === 'old').remove, undefined)
  assert.deepEqual(e.writes(), [])
  assert.deepEqual(e.probes, [])
})

test('am alone with no Herdr home yet says why and offers no edit', async t => {
  const f = accountsFixture(t, { install: false })
  f.add(f.am)
  f.answer.claude.nextSlot = join(f.root, '.claude-4')
  f.respond()
  const host = accountsHost(t, f)
  const view = await value(host)
  assert.equal(view.editWhy, 'no-home')
  assert.equal(Object.hasOwn(view, 'editToken'), false)
  assert.equal(Object.hasOwn(view, 'add'), false)
})

test('a relative program from launch-path runs from the home folder it was resolved in', async t => {
  const e = editFixture(t, { where: { program: 'bin/claude', path: 'bin:/usr/bin' } })
  mkdirSync(e.four)
  assert.deepEqual(await value(e.host, ADD, { id: '4', token: (await value(e.host)).editToken }), { added: true })
  assert.deepEqual(e.probes.map(p => p.where), [{ program: join(e.home, 'bin/claude'), path: 'bin:/usr/bin' }])
})

test('Remove with no answering core scans nothing and writes nothing', async t => {
  const e = editFixture(t, { status: { state: 'out' }, socket: null })
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'panes-unknown' })
  assert.deepEqual(e.scans, [])
  assert.deepEqual(e.writes(), [])
})

test('the selected login and the default one are refused even with a forged offer id', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  for (const id of ['default', '2x', '', 7, null]) {
    assert.deepEqual(await value(e.host, REMOVE, { id, token: (await value(e.host)).editToken }), { reason: 'changed' })
  }
  assert.deepEqual(e.writes(), [])
})

test('writer refusals map to fixed reasons, one writer call each; a lost outcome clears every offer', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  for (const [error, reason] of [['conflict', 'conflict'], ['busy', 'busy'], ['in-use', 'in-use'], ['no-slot', 'changed'],
    ['home', 'home-mismatch'], ['update-first', 'panel-old'], ['bad-record', 'failed'], ['private-text', 'failed']]) {
    e.respond({ write: { exit: 1, reply: { error } } })
    const before = e.writes().length
    assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason })
    assert.equal(e.writes().length, before + 1)
  }
  e.respond({ write: { text: '{"ok":true,"snapshot":"nope"}' } })
  const view = await value(e.host)
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: view.editToken }), { reason: 'unknown' })
  // Offers made before the lost outcome are gone; the Use offer of the same read too.
  assert.deepEqual(await value(e.host, 'accounts-claude-use', { id: '2', token: view.token }), { reason: 'changed' })
  e.respond({ write: { reply: { ok: true, snapshot: 'b'.repeat(64), use: '3' } } })
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'unknown' })
})

test('a request past its deadline or whose page went away starts nothing more', async t => {
  let clock = 1_000
  const e = editFixture(t, { now: () => clock, status: { state: 'out' } })
  e.answers.seen = () => { clock += 90_000; return [] }
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'changed' })
  assert.deepEqual(e.writes(), [])
  const entry = e.host.rt.extended.endpointOf(REMOVE)
  const controller = new AbortController()
  controller.abort()
  const { editToken } = await value(e.host)
  e.answers.seen = []
  const { windowProof } = await import('../src/host/desktop-window.js')
  const proof = windowProof(new Request('http://localhost', { headers: { 'x-automagik-window': WINDOW } }))
  assert.deepEqual(await entry.fn({ id: '3', token: editToken }, controller.signal, proof), { reason: 'changed' })
  assert.deepEqual(e.writes(), [])
})

test('ownership lost while the checks run stops the write', async t => {
  const e = editFixture(t, { status: { state: 'out' } })
  e.answers.seen = () => { e.host.ownership.generation += 1; return [] }
  assert.deepEqual(await value(e.host, REMOVE, { id: '3', token: (await value(e.host)).editToken }), { reason: 'read-only' })
  assert.deepEqual(e.writes(), [])
})

test('Add and Remove refuse callers that are not the desktop window, and a read-only host, before any CLI run', async t => {
  const e = editFixture(t)
  for (const endpoint of [ADD, REMOVE]) {
    const principal = { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' }
    assert.equal((await e.host.request(endpoint, {}, { peer: { principal } })).status, 403)
    assert.deepEqual(await value(e.host, endpoint, { id: '3' }, { marker: null }), { reason: 'desktop-only' })
  }
  assert.deepEqual(e.calls(), [])
  e.host.ownership.readOnly = `Read only at ${join(e.root, CANARY)}`
  for (const endpoint of [ADD, REMOVE]) {
    const response = await e.host.request(endpoint, { id: '3', token: 'a'.repeat(32) })
    const body = await response.text()
    assert.doesNotMatch(body, new RegExp(CANARY))
    assert.deepEqual(JSON.parse(body), { ok: false, error: { code: 'bot/read-only', message: 'This host can only read accounts.', details: {} } })
  }
  assert.deepEqual(e.calls(), [])
})
