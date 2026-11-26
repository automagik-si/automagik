// The Herdr Accounts panel's Add and Remove checks, as the plugin host runs them (RFC 0030 delivery 5b).
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { askAuthStatus, folderProblem, nextSlotOf, paneLogin, panesOn, readAuthStatus, signInCommand, signOutCommand } from '../src/host/accounts-guards.js'
import { readLocalArgvs } from '../src/host/accounts.js'

const scratch = t => {
  const root = mkdtempSync(join(tmpdir(), 'omni-guards-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('claude auth status reads as the pack reads it: signed out only on JSON loggedIn false', () => {
  const json = value => JSON.stringify(value)
  assert.deepEqual(readAuthStatus({ late: true }), { state: 'late' })
  assert.deepEqual(readAuthStatus({ code: 127, stdout: '' }), { state: 'nobin' })
  assert.deepEqual(readAuthStatus({ code: 0, stdout: 'signed in' }), { state: 'unread' })
  assert.deepEqual(readAuthStatus({ code: 0, stdout: '[]' }), { state: 'unread' })
  assert.deepEqual(readAuthStatus({ code: 1, stdout: json({ loggedIn: false }) }), { state: 'out', configDirectory: null })
  assert.deepEqual(readAuthStatus({ code: 0, stdout: json({ loggedIn: false, configDirectory: '/h/.claude-2' }) }), { state: 'out', configDirectory: '/h/.claude-2' })
  assert.deepEqual(readAuthStatus({ code: 2, stdout: json({ loggedIn: false }) }), { state: 'unread' })
  assert.deepEqual(readAuthStatus({ code: 1, stdout: json({ loggedIn: true }) }), { state: 'unread' })
  assert.deepEqual(readAuthStatus({ code: 0, stdout: json({}) }), { state: 'in', loggedIn: false, configDirectory: null })
  assert.deepEqual(readAuthStatus({ code: 0, stdout: json({ loggedIn: true, email: 'x@example.test', configDirectory: '/h/.claude-2' }) }),
    { state: 'in', loggedIn: true, configDirectory: '/h/.claude-2' })
})

test('the probe runs claude as a launch on that login would, with nothing of its output kept but the status', async t => {
  const root = scratch(t)
  const log = join(root, 'argv.log')
  const claude = join(root, 'claude')
  writeFileSync(claude, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "$PATH" >> ${JSON.stringify(log)}\n`
    + `case $CLAUDE_CONFIG_DIR in */out) printf '{"loggedIn":false}'; exit 1 ;; */slow) sleep 5 ;; */crash) echo boom >&2; exit 3 ;; esac\n`
    + `printf '{"loggedIn":true,"email":"secret@example.test","configDirectory":"%s"}' "$CLAUDE_CONFIG_DIR"\n`)
  chmodSync(claude, 0o755)
  const where = { program: claude, path: `${root}:/usr/bin:/bin` }
  const env = { HOME: root, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/wrong' }
  assert.deepEqual(await askAuthStatus(join(root, 'in'), where, { env, cwd: root }), { state: 'in', loggedIn: true, configDirectory: join(root, 'in') })
  assert.deepEqual(await askAuthStatus(join(root, 'out'), where, { env, cwd: root }), { state: 'out', configDirectory: null })
  assert.deepEqual(await askAuthStatus(join(root, 'crash'), where, { env, cwd: root }), { state: 'unread' })
  assert.deepEqual(await askAuthStatus(join(root, 'slow'), where, { env, cwd: root, ms: 300 }), { state: 'late' })
  assert.deepEqual(await askAuthStatus(join(root, 'in'), { program: null, path: null }, { env, cwd: root }), { state: 'nobin' })
  assert.deepEqual(await askAuthStatus(join(root, 'in'), { program: join(root, 'missing'), path: '/usr/bin:/bin' }, { env, cwd: root }), { state: 'nobin' })
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.deepEqual(lines[0].split('|'), ['auth status', join(root, 'in'), `${root}:/usr/bin:/bin`])
})

test('the next slot is taken only in the panel form, and the commands quote every folder', () => {
  assert.deepEqual(nextSlotOf('/home/u/.claude-2', '/home/u/'), { id: '2', dir: '/home/u/.claude-2' })
  assert.equal(nextSlotOf('/home/u~x/.claude-2', '/home/u~x'), null)
  for (const value of [null, '/home/u/.claude-1', '/home/u/.claude-02', '/home/u/.claude-2/', '/home/u/x/.claude-2', '/home/v/.claude-2', '/home/u/.claude-2a'])
    assert.equal(nextSlotOf(value, '/home/u'), null, String(value))
  assert.equal(nextSlotOf('/.claude-2', '/'), null)
  assert.equal(signInCommand('12'), 'CLAUDE_CONFIG_DIR="$HOME/.claude-12" claude auth login')
  assert.equal(signOutCommand('/home/u/.claude-3', '/home/u'), `CLAUDE_CONFIG_DIR="$HOME"/'.claude-3' claude auth logout`)
  assert.equal(signOutCommand("/opt/a'b $c", '/home/u'), `CLAUDE_CONFIG_DIR='/opt/a'\\''b $c' claude auth logout`)
})

test('the folder check is the pack FOLDER_SCRIPT: present, not a symlink, a real parent, a directory', async t => {
  const root = scratch(t)
  const dir = join(root, 'slot'), file = join(root, 'file'), link = join(root, 'link'), parentLink = join(root, 'parent-link')
  mkdirSync(dir)
  writeFileSync(file, '')
  symlinkSync(dir, link)
  symlinkSync(root, parentLink)
  assert.equal(await folderProblem(dir), null)
  assert.equal(await folderProblem(join(root, 'missing')), 'no-folder')
  assert.equal(await folderProblem(link), 'bad-folder')
  assert.equal(await folderProblem(file), 'bad-folder')
  assert.equal(await folderProblem(join(parentLink, 'slot')), 'bad-folder')
})

test('a pane login is read from env words only, by value', () => {
  const logins = [{ id: '2', dir: '/h/.claude-2' }]
  assert.deepEqual(paneLogin(['/usr/bin/env', 'PATH=/x', 'CLAUDE_CONFIG_DIR=/h/.claude-2', 'claude'], logins), { id: '2' })
  assert.deepEqual(paneLogin(['env', 'CLAUDE_CONFIG_DIR=/h//.claude-2/', 'claude'], logins), { id: '2' })
  assert.deepEqual(paneLogin(['env', '-u', 'CLAUDE_CONFIG_DIR', 'claude'], logins), { id: 'default' })
  assert.deepEqual(paneLogin(['env', '-u', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR=/h/x', 'claude'], logins), { unknown: '/h/x' })
  assert.deepEqual(paneLogin(['env', 'sh', '-c', 'CLAUDE_CONFIG_DIR=/h/.claude-2 claude'], logins), { why: 'untracked' })
  assert.deepEqual(paneLogin(['claude'], logins), { why: 'untracked' })
  assert.deepEqual(paneLogin([], logins), { why: 'no-argv' })
})

test('panesOn looks at the folder being removed, by value or real path, before any other login', async t => {
  const root = scratch(t)
  const two = join(root, '.claude-2'), three = join(root, '.claude-3')
  mkdirSync(two)
  mkdirSync(three)
  symlinkSync(two, join(root, 'two'))
  const logins = [{ id: '2', dir: two }, { id: '3', dir: three }, { id: 'old', dir: three }]
  const on = dir => ['env', `CLAUDE_CONFIG_DIR=${dir}`, 'claude']
  const target = (id, dir) => ({ id, dir })
  assert.equal(await panesOn([on(join(root, 'two'))], target('3', three), logins, root), null)
  assert.equal(await panesOn([on(join(root, 'two'))], target('2', two), logins, root), 'running')
  assert.equal(await panesOn([on(join(root, 'other'))], target('3', three), logins, root), 'running-unknown')
  assert.equal(await panesOn([on('/elsewhere/x')], target('3', three), logins, root), null)
  assert.equal(await panesOn([on(join(root, 'other')), on(three)], target('3', three), logins, root), 'running')
  // Two ids on one folder: a pane on it holds both, whichever id is first in the record.
  assert.equal(await panesOn([on(three)], target('old', three), logins, root), 'running')
  // A real path that can't be told in time, or a request out of time, scans no further.
  assert.equal(await panesOn([on('/elsewhere/slow')], target('3', three), logins, root, { realpath: () => new Promise(() => {}) }), 'panes-unknown')
  assert.equal(await panesOn([on(three)], target('3', three), logins, root, { late: () => true }), 'panes-unknown')
})

function fakeCore({ id = 'core-test', terminals = [], gets = {} } = {}) {
  const calls = []
  let closed = false
  const core = {
    info: { core: { id, name: 'test' } },
    async call(method, params) {
      calls.push([method, params])
      if (method === 'terminal.list') return typeof terminals === 'function' ? terminals() : { terminals }
      const got = gets[params.terminal]
      if (got instanceof Error) throw got
      return got
    },
    close() { closed = true },
  }
  return { core, calls, closed: () => closed }
}
const notFound = () => Object.assign(new Error('gone'), { kind: 'not_found' })

test('the scan reads every live terminal the named core lists, linked ones too, and fails closed', async t => {
  const root = scratch(t)
  const env = { HOME: root, HERDR_HC: '/fixture/hc', AUTOMAGIK_HOME: join(root, 'automagik') }
  const argv = ['env', 'CLAUDE_CONFIG_DIR=/h/.claude-2', 'claude']
  const run = async (fake, options = {}) => {
    const seen = []
    const result = await readLocalArgvs({ env, core: 'core-test', socket: '/fixture/core.sock',
      connect: async opts => { seen.push(opts); return fake.core }, ...options })
    return { result, seen }
  }
  let fake = fakeCore({ terminals: [{ address: 't1', state: 'live' }, { address: 'lab/t2', state: 'live' }, { address: 't3', state: 'exited' }, { address: 't4', state: 'live' }],
    gets: { t1: { address: 't1', state: 'live', argv }, 'lab/t2': { address: 'lab/t2', state: 'live', argv: ['bash'] }, t4: notFound() } })
  const { result, seen } = await run(fake)
  assert.deepEqual(result, [argv, ['bash']])
  assert.deepEqual(seen.map(o => [o.bin, o.socket]), [['/fixture/hc', '/fixture/core.sock']])
  assert.deepEqual(fake.calls.map(c => c[1]?.terminal ?? c[0]), ['terminal.list', 't1', 'lab/t2', 't4'])
  assert.equal(fake.closed(), true)

  for (const [name, broken] of [
    ['another core', fakeCore({ id: 'core-other', terminals: [] })],
    ['a listed row with no state', fakeCore({ terminals: [{ address: 't1' }] })],
    ['a get with no state', fakeCore({ terminals: [{ address: 't1', state: 'live' }], gets: { t1: { address: 't1', argv: ['bash'] } } })],
    ['no list', fakeCore({ terminals: () => ({}) })],
    ['a row with no address', fakeCore({ terminals: [{ state: 'live' }] })],
    ['a failed get', fakeCore({ terminals: [{ address: 't1', state: 'live' }], gets: { t1: new Error('down') } })],
    ['no argv', fakeCore({ terminals: [{ address: 't1', state: 'live' }], gets: { t1: { address: 't1', state: 'live' } } })],
    ['an empty argv', fakeCore({ terminals: [{ address: 't1', state: 'live' }], gets: { t1: { address: 't1', state: 'live', argv: [] } } })],
    ['a non-string word', fakeCore({ terminals: [{ address: 't1', state: 'live' }], gets: { t1: { address: 't1', state: 'live', argv: ['env', 1] } } })],
    ['a listed state that is not a word', fakeCore({ terminals: [{ address: 't1', state: null }] })],
    ['a get state that is not a word', fakeCore({ terminals: [{ address: 't1', state: 'live' }], gets: { t1: { address: 't1', state: 7, argv: ['bash'] } } })],
    ['too many terminals', fakeCore({ terminals: Array.from({ length: 501 }, (_, i) => ({ address: `t${i}`, state: 'live' })) })],
  ]) {
    assert.equal((await run(broken)).result, null, name)
    assert.equal(broken.closed(), true, name)
  }
  assert.equal((await run(fakeCore(), { core: null })).result, null)
  // Past its deadline the scan starts no further batch: nine terminals, the clock runs out in the first batch of eight.
  let clock = 0
  const nine = Array.from({ length: 9 }, (_, i) => ({ address: `t${i + 1}`, state: 'live' }))
  const slow = fakeCore({ terminals: nine, gets: Object.fromEntries(nine.map(({ address }) => [address, { state: 'live', argv: ['bash'] }])) })
  const call = slow.core.call
  slow.core.call = async (...args) => { if (args[0] === 'terminal.get') clock += 10; return call(...args) }
  assert.equal((await run(slow, { deadline: 50, now: () => clock })).result, null)
  assert.equal(slow.calls.some(([, params]) => params?.terminal === 't9'), false)
  const aborted = new AbortController()
  aborted.abort()
  const quiet = fakeCore({ terminals: [] })
  assert.equal((await run(quiet, { signal: aborted.signal })).result, null)
  assert.deepEqual(quiet.calls, [])
  assert.equal((await readLocalArgvs({ env, core: 'core-test', socket: '/s', connect: async () => { throw new Error('no-core') } })), null)
  assert.equal((await readLocalArgvs({ env: { ...env, HERDR_HC: 'relative-hc' }, core: 'core-test', socket: '/s', connect: async () => fakeCore().core })), null)
})
