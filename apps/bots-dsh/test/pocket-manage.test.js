// RFC 0036's owner socket, with the real team store and memory and a fake DSH Session Controller.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { format } from 'node:util'
import { createRuntime } from '../index.js'
import { formatEntry, parseMemory } from '../src/host/memory.js'
import { socketPathOf } from '../src/host/pocket-socket.js'
import { fakeContext } from './fake-ctx.js'

const A = 'b-aaaaaaaaaa'
const B = 'b-bbbbbbbbbb'
const GLOBAL = 'b-cccccccccc'
const ROOM = 'room1'
const TERMINAL = `dsh:${A}`
const GRANT = 'grant'
const PHONE = 'paired-key'
const REPO = '/repo/pocket-memory'
const MIB = 1024 * 1024
const HELLO = { write: 1, manage: 1 }
const READ_METHODS = ['hello', 'list', 'subscribe', 'unsubscribe', 'backfill']
const OLD_READ = { protocol: 1, readOnly: true, methods: READ_METHODS }
const OLD_WRITE = { protocol: 1, readOnly: false, write: 1, methods: [...READ_METHODS, 'send', 'interrupt', 'answer'], dedupe: 'log' }
const SETTINGS = ['settings-read', 'settings-name', 'settings-model']
const MANAGED = { ...OLD_WRITE, manage: 1, manageMethods: ['manage-open', 'manage-close', 'memory-read', 'memory-edit', 'memory-add', ...SETTINGS] }
const READ_ONLY = { kind: 'read-only', message: 'This socket only reads; answer on the computer.' }
const REFUSED = reason => ({ ok: false, state: 'refused', reason })
const UNKNOWN = { ok: false, state: 'unknown', reason: 'pending' }
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
const revOf = (line, file = 'MEMORY.md') => hash(JSON.stringify([file, line]))

function controller(writable) {
  return {
    async* follow({ address }, signal) {
      yield { type: 'snapshot', header: { version: 1, id: address.sessionId, createdAt: 0 }, records: [], cursor: -1, hasMore: false, projections: { asOfSeq: -1, values: {} } }
      if (!signal.aborted) await once(signal, 'abort')
    },
    async events() { return { records: [], hasMore: false, cursor: -1 } },
    async state() { return { cursor: -1, active: true, running: false, queue: [], pendingInput: [] } },
    async* observeState() {},
    ...(writable ? { prompt: async () => ({ accepted: true }), cancel: () => ({ accepted: true }) } : {}),
  }
}

function client(path) {
  const socket = createConnection(path)
  const waiting = new Map()
  const closed = new Promise(resolve => socket.once('close', resolve))
  let next = 1
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('close', () => {
    for (const { reject } of waiting.values()) reject(new Error('the socket closed before the answer'))
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at + 1)
      buffer = buffer.slice(at + 1)
      const wire = JSON.parse(line)
      waiting.get(wire.id)?.resolve({ wire, line })
    }
  })
  async function exchange(method, params, id = next++) {
    const response = Promise.withResolvers()
    waiting.set(id, response)
    const timeout = setTimeout(() => response.reject(new Error(`no reply for ${method}`)), 5000)
    try {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
      return await response.promise
    } finally {
      waiting.delete(id)
      clearTimeout(timeout)
    }
  }
  const ask = async (method, params) => (await exchange(method, params)).wire
  const call = async (method, fields) => (await ask(method, { grant: GRANT, terminal: TERMINAL, ...fields })).result
  return { socket, closed, exchange, ask, call, read: fields => call('memory-read', fields), edit: fields => call('memory-edit', fields), add: (text, fields) => call('memory-add', { text, ...fields }) }
}

function takeLock(home) {
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host', since: Date.now() }))
}

async function setup(t, { config, writable = true, readOnly = false, brokenLock = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-manage-'))
  const path = socketPathOf(home)
  const root = join(home, 'memory')
  const own = join(root, 'bots', A)
  const registry = join(home, 'bots.json')
  const state = {
    version: 2, mainBotIds: [GLOBAL], whaleStored: true,
    bots: Object.fromEntries([A, B, GLOBAL].map((id, at) => [id, { id, name: `PrivateFixtureName${at}`, sessionId: `s-${at}`, model: 'deepseek/v4', createdAt: at + 1 }])),
    rooms: { [ROOM]: { id: ROOM, name: 'Fixture Room', named: true, members: [A, B], admin: A, sessions: {} } },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  if (readOnly) takeLock(home)
  if (brokenLock) {
    intercept(t, fs, 'writeFileSync', (write, ...args) => {
      if (args[0] === join(home, 'state.lock')) throw Object.assign(new Error('fixture lock cannot be created'), { code: 'EACCES' })
      return write(...args)
    })
  }
  const row = { id: A, name: state.bots[A].name, folder: REPO }
  const pick = { project: REPO, bots: [A] }
  const show = (bots = [row], shown = [pick]) => writeFileSync(registry, JSON.stringify({ version: 2, projects: [], bots, shown }))
  show()
  const ctx = fakeContext({ services: { sessionController: controller(writable) } })
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(format(...args))
  const clients = []
  const cleanup = []
  const rt = createRuntime(ctx, { home, memoryReview: false, ...config })
  rt.registryPath = registry
  t.after(async () => {
    for (const release of cleanup) release()
    for (const c of clients) c.socket.destroy()
    await ctx.dispose()
    rt.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  for (let tries = 0; !existsSync(path); tries += 1) {
    const failed = warnings.find(line => line.includes('Pocket chat is off'))
    if (failed || tries === 200) throw new Error(failed ?? 'Pocket socket did not start')
    await delay(10)
  }
  const connect = async ({ phone = PHONE, hello = HELLO, grant = GRANT } = {}) => {
    const c = client(path)
    clients.push(c)
    await once(c.socket, 'connect')
    if (hello !== null) {
      assert.deepEqual((await c.ask('hello', hello)).result, MANAGED)
      assert.deepEqual((await c.ask('manage-open', { grant, phone })).result, { grant })
    }
    return c
  }
  const put = (file, text) => {
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, file), text)
  }
  const journal = () => {
    const file = join(root, 'journal.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  }
  const noPending = () => assert.equal(existsSync(root) && readdirSync(root).some(name => name.includes('pending.json')), false)
  const pause = () => {
    const entered = Promise.withResolvers()
    const held = Promise.withResolvers()
    cleanup.push(held.resolve)
    return {
      entered: entered.promise, release: held.resolve,
      async wait() { entered.resolve(); await held.promise },
    }
  }
  const holdQueue = async () => {
    const gate = pause()
    const task = rt.pocketMemory.read({ botId: A, allowed: () => 'revoked', refresh: gate.wait })
    await gate.entered
    return async () => { gate.release(); await task }
  }
  return { ctx, rt, home, root, own, registry, warnings, row, pick, show, connect, put, journal, noPending, pause, holdQueue }
}

function intercept(t, target, name, run) {
  const original = target[name]
  const mock = t.mock.method(target, name, (...args) => run(original, ...args))
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}

test('hello is additive and old hello replies are byte-equal', async (t) => {
  const h = await setup(t)
  const c = await h.connect({ hello: null })
  for (const [params, result] of [[{}, OLD_READ], [{ manage: 1 }, OLD_READ], [{ write: 1 }, OLD_WRITE], [{ write: 1, manage: true }, OLD_WRITE]]) {
    const { line } = await c.exchange('hello', params, 42)
    assert.equal(line, `${JSON.stringify({ id: 42, result })}\n`)
    for (const method of ['manage-open', 'memory-read', 'memory-edit', 'memory-add']) {
      assert.deepEqual((await c.exchange(method, {}, 42)).wire, { id: 42, error: READ_ONLY })
    }
    assert.deepEqual((await c.exchange('manage-close', {}, 42)).wire, { id: 42, result: {} })
  }
  assert.deepEqual((await c.ask('hello', HELLO)).result, MANAGED)
})

for (const [label, options, hello] of [
  ['memory off', { config: { memory: false } }, { ...OLD_WRITE, manage: 1, manageMethods: ['manage-open', 'manage-close', ...SETTINGS] }],
  ['a read-only Session controller', { writable: false }, OLD_READ],
]) {
  test(`${label} does not negotiate memory management`, async (t) => {
    const h = await setup(t, options)
    const c = await h.connect({ hello: null })
    assert.deepEqual((await c.exchange('hello', HELLO, 42)).wire, { id: 42, result: hello })
    const { wire: opened } = await c.exchange('manage-open', { grant: GRANT, phone: PHONE }, 42)
    assert.deepEqual(opened, label === 'memory off' ? { id: 42, result: { grant: GRANT } } : { id: 42, error: READ_ONLY })
    for (const method of ['memory-read', 'memory-edit', 'memory-add']) {
      assert.deepEqual((await c.exchange(method, { grant: GRANT, terminal: TERMINAL }, 42)).wire, { id: 42, error: READ_ONLY })
    }
    assert.deepEqual((await c.exchange('manage-close', { grant: GRANT }, 42)).wire, { id: 42, result: {} })
    if (label === 'memory off') assert.deepEqual(await h.rt.pocketMemory.read({ botId: A }), REFUSED('unavailable'))
  })
}

test('read, edit and add project only the selected Bot even when foreign scopes share ids', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const selected = 'SelectedFixtureMarker'
  const raw = formatEntry(selected, { id: 'shared', by: 'old', source: 'desktop', added: '2000-01-01', until: '2000-02-01', pinned: 'yes', extra: 'kept' })
  h.put('MEMORY.md', `${raw}\n`)
  const foreign = new Map([
    [join(h.root, 'team', 'MEMORY.md'), 'TeamFixtureMarker'],
    [join(h.root, 'groups', ROOM, 'MEMORY.md'), 'GroupFixtureMarker'],
    [join(h.root, 'bots', B, 'MEMORY.md'), 'OtherBotFixtureMarker'],
  ].map(([path, marker]) => {
    const text = `- ${marker} [id: shared]\n`
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
    return [path, text]
  }))
  const extra = { scope: 'team', roomId: ROOM, botId: B, phone: 'spoofed' }
  const read = await c.read(extra)
  const entry = { id: 'shared', rev: revOf(raw), text: selected, topic: null, added: '2000-01-01', until: '2000-02-01', pinned: true, expired: true }
  assert.deepEqual(read, { ok: true, state: 'read', memory: { terminal: TERMINAL, entries: [entry], size: selected.length, limit: 8000, truncated: false } })
  const same = await c.edit({ ...extra, id: entry.id, rev: entry.rev, text: ` - ${selected} [by: forged] ` })
  assert.deepEqual(same, { ok: true, state: 'unchanged', entry, memory: read.memory })
  assert.deepEqual(h.journal(), [])
  const saved = await c.edit({ ...extra, id: entry.id, rev: entry.rev, text: 'EditedFixtureMarker' })
  const written = parseMemory(readFileSync(join(h.own, 'MEMORY.md'), 'utf8')).entries[0]
  assert.deepEqual(written.meta, { id: 'shared', by: 'user', source: 'pocket', added: '2000-01-01', until: '2000-02-01', pinned: 'yes', extra: 'kept' })
  assert.deepEqual(saved, {
    ok: true, state: 'saved', entry: { ...entry, text: written.text, rev: revOf(formatEntry(written.text, written.meta)) },
    memory: (await c.read()).memory,
  })
  assert.equal(saved.memory.entries[0].rev, saved.entry.rev)
  const replay = await c.edit({ id: entry.id, rev: entry.rev, text: written.text })
  assert.deepEqual(replay, { ...REFUSED('stale'), memory: saved.memory })
  assert.deepEqual(await c.edit({ id: 'absent', rev: entry.rev, text: 'irrelevant' }), { ...REFUSED('gone'), memory: saved.memory })
  const add = await c.add('AddedFixtureMarker', extra)
  assert.equal(add.state, 'saved')
  assert.equal(add.entry.text, 'AddedFixtureMarker')
  assert.deepEqual(add.memory, (await c.read()).memory)
  assert.deepEqual(await c.add('  AddedFixtureMarker  '), { ...add, state: 'unchanged' })
  assert.deepEqual(h.journal().map(({ scope, op, pocket }) => [scope, op, pocket]), [[`bot:${A}`, 'replace', undefined], [`bot:${A}`, 'add', undefined]])
  for (const [path, original] of foreign) {
    assert.equal(readFileSync(path, 'utf8'), original)
    const marker = parseMemory(original).entries[0].text
    assert.equal(JSON.stringify({ read, same, saved, replay, add, logs: h.warnings }).includes(marker), false)
  }
  assert.doesNotMatch(h.warnings.join('\n'), /FixtureMarker|PrivateFixtureName/)
  h.noPending()
})

test('legacy ids use a stable wire id and identical legacy selectors are ambiguous', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const stored = 'legacy   id [Ω'
  const raw = `- Legacy fact [id: ${stored}; added: yesterday]`
  h.put('legacy.md', `${raw}\n`)
  const [entry] = (await c.read()).memory.entries
  assert.equal(entry.id, `x${hash(stored)}`)
  assert.equal(entry.rev, revOf(raw, 'legacy.md'))
  const changed = await c.edit({ id: entry.id, rev: entry.rev, text: 'Updated legacy fact' })
  assert.equal(changed.state, 'saved')
  assert.equal(changed.entry.id, entry.id)
  assert.equal(parseMemory(readFileSync(join(h.own, 'legacy.md'), 'utf8')).entries[0].meta.id, stored)
  const identical = '- Historic fact without an explicit id'
  h.put('legacy.md', `${identical}\n${identical}\n`)
  const memory = (await c.read()).memory
  const [first, second] = memory.entries
  assert.deepEqual(first, second)
  assert.deepEqual(await c.edit({ id: first.id, rev: first.rev, text: 'Ambiguous replacement' }), { ...REFUSED('ambiguous'), memory })
  assert.equal(h.journal().length, 1)
})

test('only the fresh binding and a listed current Session authorize memory', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const visible = async () => (await c.ask('list')).result.terminals.some(row => row.terminal === TERMINAL && row.shown)
  assert.equal(await visible(), true)
  assert.equal((await c.read()).state, 'read')
  assert.deepEqual(await c.read({ terminal: `dsh:${GLOBAL}` }), REFUSED('global'))
  assert.deepEqual(await c.read({ terminal: 'dsh:missing' }), REFUSED('not-found'))
  assert.deepEqual(await c.read({ terminal: 'dsh:s-0' }), REFUSED('not-found'))
  h.rt.state.bots[A].private = true
  assert.deepEqual(await c.read(), REFUSED('private'))
  h.show([h.row], [])
  assert.deepEqual(await c.read(), REFUSED('not-shown'))
  h.rt.state.bots[A].private = false
  h.show()
  assert.equal(await visible(), true)
  writeFileSync(h.registry, '{ broken')
  assert.deepEqual(await c.read(), REFUSED('not-shown'))
  assert.equal(await visible(), true, 'chat still serves its last good read')
  assert.deepEqual(await c.read({ terminal: `dsh:${B}` }), REFUSED('not-shown'), 'unknown place never becomes global')
  h.show([{ ...h.row, machine: 'box-2' }], [{ ...h.pick, machine: 'box-1' }])
  assert.deepEqual(await c.read(), REFUSED('not-shown'))
  h.show([{ ...h.row, machine: 'box-2' }], [{ ...h.pick, machine: 'box-2' }])
  assert.equal((await c.read()).state, 'read')
  for (const machine of ['bad machine', ['box-2'], null]) {
    h.show([{ ...h.row, machine }])
    assert.deepEqual(await c.read(), REFUSED('not-shown'))
  }
  h.show([h.row, h.row])
  assert.deepEqual(await c.read(), REFUSED('not-shown'))
  h.rt.state.bots[A].project = REPO
  h.show([])
  assert.equal((await c.read()).state, 'read')
  h.show([{ id: A, name: h.row.name }])
  assert.deepEqual(await c.read(), REFUSED('global'))
  h.show()
  h.rt.state.bots[A].sessionId = ''
  assert.deepEqual(await c.read(), REFUSED('not-found'))
  assert.equal(await visible(), false)
})

test('authority checks the real state lock after waiting in the memory queue', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  assert.equal(h.rt.holdsLock(), true)
  const release = await h.holdQueue()
  const refresh = t.mock.method(h.rt, 'refreshShellChoice')
  const write = c.add('LostLockFixtureMarker')
  assert.deepEqual((await c.ask('manage-open', { grant: 'barrier', phone: PHONE })).result, { grant: 'barrier' })
  assert.equal(refresh.mock.callCount(), 0)
  takeLock(h.home)
  assert.equal(h.rt.state.bots[A].private, undefined)
  await release()
  assert.deepEqual(await write, REFUSED('unavailable'))
  assert.equal(refresh.mock.callCount(), 1)
  assert.equal(existsSync(h.own), false)
  assert.deepEqual(h.journal(), [])
  h.noPending()
})

test('losing the state lock after the temp write refuses before acceptance', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const gate = h.pause()
  intercept(t, fsPromises, 'writeFile', async (write, ...args) => {
    await write(...args)
    if (String(args[0]).includes('.pending.json.')) await gate.wait()
  })
  const write = c.add('UnacceptedLockFixtureMarker')
  await gate.entered
  assert.equal(existsSync(join(h.root, 'pending.json')), false)
  takeLock(h.home)
  gate.release()
  assert.deepEqual(await write, REFUSED('unavailable'))
  assert.equal(existsSync(h.own), false)
  assert.deepEqual(h.journal(), [])
  h.noPending()
})

test('losing the state lock after acceptance suppresses the memory reply', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const gate = h.pause()
  intercept(t, fsPromises, 'appendFile', async (append, ...args) => {
    if (args[0] === join(h.root, 'journal.jsonl')) await gate.wait()
    await append(...args)
  })
  const write = c.add('AcceptedLockFixtureMarker')
  await gate.entered
  assert.equal(existsSync(join(h.root, 'pending.json')), true)
  takeLock(h.home)
  gate.release()
  assert.deepEqual(await write, { ...REFUSED('unavailable'), applied: true })
  assert.match(readFileSync(join(h.own, 'MEMORY.md'), 'utf8'), /AcceptedLockFixtureMarker/)
  assert.equal(h.journal().length, 1)
  h.noPending()
})

for (const [label, options] of [['a read-only team', { readOnly: true }], ['a broken state lock', { brokenLock: true }]]) {
  test(`${label} refuses memory after negotiating, and close still succeeds`, async (t) => {
    const h = await setup(t, options)
    const c = await h.connect()
    assert.equal(h.rt.holdsLock(), false)
    if (options.brokenLock) assert.equal(h.rt.readOnly(), undefined)
    assert.deepEqual(await c.read(), REFUSED('unavailable'))
    assert.deepEqual(await c.add('No authority fixture'), REFUSED('unavailable'))
    assert.deepEqual((await c.ask('manage-close', { grant: GRANT })).result, {})
    assert.equal(existsSync(h.own), false)
  })
}

test('grants are bounded, close is idempotent and bad fields follow grant precedence', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  assert.deepEqual((await c.ask('manage-open', { grant: GRANT, phone: PHONE })).error, { kind: 'invalid_params', message: 'grant in use' })
  for (const [grant, phone] of [['bad id', PHONE], ['x'.repeat(65), PHONE], ['bad-phone', 'a name'], ['long-phone', 'p'.repeat(257)], [null, PHONE]]) {
    assert.deepEqual((await c.ask('manage-open', { grant, phone })).error, { kind: 'invalid_params', message: 'grant, phone' })
  }
  const max = 'a'.repeat(64)
  assert.deepEqual((await c.ask('manage-open', { grant: max, phone: 'p'.repeat(256) })).result, { grant: max })
  for (let at = 0; at < 14; at += 1) assert.deepEqual((await c.ask('manage-open', { grant: `g${at}`, phone: PHONE })).result, { grant: `g${at}` })
  assert.deepEqual((await c.ask('manage-open', { grant: 'extra', phone: PHONE })).error, { kind: 'too_many', message: 'at most 16 grants' })
  for (let at = 0; at < 2; at += 1) assert.deepEqual((await c.ask('manage-close', { grant: max })).result, {})
  assert.deepEqual((await c.ask('manage-open', { grant: max, phone: PHONE })).result, { grant: max })
  assert.deepEqual(await c.edit({ grant: 'no such grant', terminal: null, id: '', rev: 0, text: false }), REFUSED('revoked'))
  for (const terminal of [null, 'dsh:', 'a/b']) assert.deepEqual(await c.read({ terminal }), REFUSED('invalid'))
  for (const id of [null, '', 'x'.repeat(33), 'a/b']) assert.deepEqual(await c.edit({ id, rev: '0'.repeat(16), text: 'valid' }), REFUSED('invalid'))
  for (const rev of [null, '0'.repeat(15), 'A'.repeat(16)]) assert.deepEqual(await c.edit({ id: 'valid', rev, text: 'valid' }), REFUSED('invalid'))
  for (const text of [null, 'a'.repeat(4097), '😀'.repeat(1025)]) assert.deepEqual(await c.add(text), REFUSED('invalid'))
  const rule = await c.add('é'.repeat(2048))
  assert.equal(rule.reason, 'invalid')
  assert.match(rule.message, /^An entry holds at most 300 characters/)
  assert.equal((await c.add('é😀'.repeat(75))).state, 'saved')
})

test('closing and reusing a grant cannot revive a queued write, and re-hello revokes it again', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const other = await h.connect({ phone: 'second-phone' })
  let release = await h.holdQueue()
  const first = c.add('ClosedGrantFixtureMarker')
  await c.ask('manage-close', { grant: GRANT })
  assert.deepEqual((await c.ask('manage-open', { grant: GRANT, phone: 'replacement-phone' })).result, { grant: GRANT })
  const independent = other.read()
  await release()
  assert.deepEqual(await first, REFUSED('revoked'))
  assert.equal((await independent).state, 'read')
  release = await h.holdQueue()
  const second = c.add('RehelloFixtureMarker')
  assert.deepEqual((await c.ask('hello', HELLO)).result, MANAGED)
  assert.deepEqual(await c.read(), REFUSED('revoked'))
  await release()
  assert.deepEqual(await second, REFUSED('revoked'))
  assert.equal(existsSync(h.own), false)
  h.noPending()
})

test('disconnect and server stop revoke queued writes', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const other = await h.connect({ phone: 'second-phone' })
  const release = await h.holdQueue()
  const results = []
  const add = h.rt.pocketMemory.add
  t.mock.method(h.rt.pocketMemory, 'add', async (args) => {
    const result = await add(args)
    results.push(result)
    return result
  })
  const first = assert.rejects(c.add('DisconnectedFixtureMarker'), /socket closed/)
  await c.ask('manage-open', { grant: 'barrier', phone: PHONE })
  c.socket.end()
  await c.closed
  await first
  const second = assert.rejects(other.add('StoppedFixtureMarker'), /socket closed/)
  await other.ask('manage-open', { grant: 'barrier', phone: PHONE })
  await h.ctx.dispose()
  await second
  await release()
  await h.rt.pocketMemory.read({ botId: A, allowed: () => 'revoked', refresh: async () => {} })
  assert.deepEqual(results, [REFUSED('revoked'), REFUSED('revoked')])
  assert.equal(existsSync(h.own), false)
  h.noPending()
})

test('revocation after writing the temp pending file leaves neither acceptance nor a temp', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const gate = h.pause()
  intercept(t, fsPromises, 'writeFile', async (write, ...args) => {
    await write(...args)
    if (String(args[0]).includes('.pending.json.')) await gate.wait()
  })
  const first = c.add('TempFileFixtureMarker')
  await gate.entered
  assert.ok(readdirSync(h.root).some(name => name.startsWith('.pending.json.')))
  assert.equal(existsSync(join(h.root, 'pending.json')), false)
  await c.ask('manage-close', { grant: GRANT })
  gate.release()
  assert.deepEqual(await first, REFUSED('revoked'))
  assert.equal(existsSync(h.own), false)
  assert.deepEqual(h.journal(), [])
  h.noPending()
})

for (const [reason, withdraw] of [
  ['not-shown', h => h.show([h.row], [])],
  ['private', (h) => { h.rt.state.bots[A].private = true }],
]) {
  test(`a consent change after acceptance suppresses the saved reply (${reason})`, async (t) => {
    const h = await setup(t)
    const c = await h.connect()
    const gate = h.pause()
    intercept(t, fsPromises, 'appendFile', async (append, ...args) => {
      if (args[0] === join(h.root, 'journal.jsonl')) await gate.wait()
      await append(...args)
    })
    const write = c.add('CommittedFixtureMarker')
    await gate.entered
    assert.equal(existsSync(join(h.root, 'pending.json')), true)
    withdraw(h)
    gate.release()
    assert.deepEqual(await write, { ...REFUSED(reason), applied: true })
    assert.match(readFileSync(join(h.own, 'MEMORY.md'), 'utf8'), /CommittedFixtureMarker/)
    assert.equal(h.journal().length, 1)
    h.noPending()
  })
}

test('a completed read checks consent again at delivery', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  h.put('MEMORY.md', '- UndeliveredMemoryFixtureMarker\n')
  const gate = h.pause()
  const read = h.rt.pocketMemory.read
  t.mock.method(h.rt.pocketMemory, 'read', async (args) => {
    const reply = await read(args)
    assert.equal(reply.memory.entries[0].text, 'UndeliveredMemoryFixtureMarker')
    await gate.wait()
    return reply
  })
  const reply = c.read()
  await gate.entered
  await c.ask('manage-close', { grant: GRANT })
  gate.release()
  assert.deepEqual(await reply, REFUSED('revoked'))
})

test('failure after acceptance is unknown and a read recovers exactly one journal row', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  let fail = true
  intercept(t, fsPromises, 'appendFile', async (append, ...args) => {
    if (fail && args[0] === join(h.root, 'journal.jsonl')) {
      fail = false
      throw new Error(`JournalFailureFixtureMarker ${h.home} ${h.row.name}`)
    }
    await append(...args)
  })
  assert.deepEqual(await c.add('PendingFixtureMarker'), UNKNOWN)
  assert.equal(existsSync(join(h.root, 'pending.json')), true)
  assert.deepEqual(h.journal(), [])
  for (let at = 0; at < 2; at += 1) {
    const { memory } = await c.read()
    assert.deepEqual(memory.entries.map(entry => entry.text), ['PendingFixtureMarker'])
  }
  assert.equal(h.journal().length, 1)
  assert.ok(h.warnings.includes('omni-ui: Pocket memory: pending'))
  assert.doesNotMatch(h.warnings.join('\n'), /FixtureMarker|PrivateFixtureName/)
  assert.equal(h.warnings.join('\n').includes(h.home), false)
  h.noPending()
})

test('an unexpected management error is logged and refused by code alone', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  t.mock.method(h.rt.pocketMemory, 'read', () => { throw new Error(`ReadFailureFixtureMarker ${h.home} ${h.row.name}`) })
  assert.deepEqual(await c.read(), REFUSED('unavailable'))
  assert.deepEqual(h.warnings, ['pocket memory: unavailable'])
})

test('a projection failure after a confirmed save returns null entry and memory', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  let fail = false
  intercept(t, fsPromises, 'appendFile', async (append, ...args) => {
    await append(...args)
    if (args[0] === join(h.root, 'journal.jsonl')) fail = true
  })
  intercept(t, fs, 'readdirSync', (read, ...args) => {
    if (fail && args[0] === h.own) throw new Error('ProjectionFailureFixtureMarker')
    return read(...args)
  })
  assert.deepEqual(await c.add('SavedFixtureMarker'), { ok: true, state: 'saved', entry: null, memory: null })
  fail = false
  assert.equal((await c.read()).memory.entries[0].text, 'SavedFixtureMarker')
  assert.equal(h.journal().length, 1)
  h.noPending()
})

test('the bounded loader rejects oversized, extra, linked and non-regular files', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  h.put('big.md', 'é'.repeat(MIB + 1))
  assert.deepEqual(await c.read(), REFUSED('too-large'))
  rmSync(join(h.own, 'big.md'))
  for (let at = 0; at < 65; at += 1) h.put(`${at}.md`, '')
  assert.deepEqual(await c.read(), REFUSED('too-large'))
  rmSync(h.own, { recursive: true })
  const foreign = join(h.root, 'bots', B, 'MEMORY.md')
  mkdirSync(join(foreign, '..'), { recursive: true })
  writeFileSync(foreign, '- LinkedForeignFixtureMarker\n')
  h.put('MEMORY.md', '- Own fixture\n')
  const topic = join(h.own, 'linked.md')
  for (const make of [() => symlinkSync(foreign, topic), () => linkSync(foreign, topic), () => mkdirSync(topic)]) {
    make()
    assert.deepEqual(await c.read(), REFUSED('unavailable'))
    assert.deepEqual(await c.add('No linked writes'), REFUSED('unavailable'))
    rmSync(topic, { recursive: true })
  }
  rmSync(h.own, { recursive: true })
  symlinkSync(join(foreign, '..'), h.own)
  assert.deepEqual(await c.read(), REFUSED('unavailable'))
  assert.doesNotMatch(h.warnings.join('\n'), /LinkedForeignFixtureMarker/)
  assert.deepEqual(h.journal(), [])
  h.noPending()
})

test('the resulting scope is measured before writing the pending file', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const raw = '- Existing fixture [id: current]\n'
  h.put('MEMORY.md', raw)
  h.put('large.md', 'x'.repeat(2 * MIB - Buffer.byteLength(raw)))
  assert.equal((await c.read()).state, 'read')
  assert.deepEqual(await c.add('Over budget fixture'), REFUSED('too-large'))
  assert.deepEqual(await c.edit({ id: 'current', rev: revOf(raw.trimEnd()), text: 'A larger existing fixture' }), REFUSED('too-large'))
  assert.equal(readFileSync(join(h.own, 'MEMORY.md'), 'utf8'), raw)
  assert.deepEqual(h.journal(), [])
  h.noPending()
})

test('the entire reply line fits with escaped multibyte metadata and an affected entry beyond truncation', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  const text = '"\\é😀'.repeat(46)
  h.put('a.md', Array.from({ length: 2600 }, (_, at) => `- Fixture ${at} [added: ${text}]\n`).join(''))
  const last = '- Last fixture [id: last; added: yesterday]'
  h.put('z.md', `${last}\n`)
  const id = '"\\é😀'.repeat(1000)
  const { wire, line } = await c.exchange('memory-edit', { grant: GRANT, terminal: TERMINAL, id: 'last', rev: revOf(last, 'z.md'), text: 'Last changed' }, id)
  assert.equal(wire.id, id)
  assert.equal(wire.result.state, 'saved')
  assert.equal(wire.result.entry.text, 'Last changed')
  assert.equal(wire.result.entry.topic, 'z')
  assert.equal(wire.result.memory.truncated, true)
  assert.equal(wire.result.memory.entries.some(entry => entry.id === 'last'), false)
  assert.equal(wire.result.memory.entries[0].added, text)
  const bytes = Buffer.byteLength(line)
  assert.ok(bytes <= MIB && bytes > MIB - 1024, `reply uses ${bytes} bytes`)
})

test('projection caps entry count and still returns the affected entry separately', async (t) => {
  const h = await setup(t)
  const c = await h.connect()
  h.put('a.md', Array.from({ length: 4001 }, (_, at) => `- Fixture ${at}\n`).join(''))
  const last = '- Last fixture [id: last]'
  h.put('z.md', `${last}\n`)
  const result = await c.edit({ id: 'last', rev: revOf(last, 'z.md'), text: 'Last changed' })
  assert.equal(result.state, 'saved')
  assert.equal(result.entry.text, 'Last changed')
  assert.equal(result.memory.entries.length, 4000)
  assert.equal(result.memory.truncated, true)
  assert.equal(result.memory.entries.some(entry => entry.id === 'last'), false)
})

test('read limits share a phone key across sockets and busy is per phone and Bot', async (t) => {
  const h = await setup(t)
  const a = await h.connect()
  const b = await h.connect()
  const other = await h.connect({ phone: 'second-phone' })
  h.show([h.row, { ...h.row, id: B }], [{ ...h.pick, bots: [A, B] }])
  const release = await h.holdQueue()
  const first = a.read()
  await a.ask('manage-open', { grant: 'barrier', phone: PHONE })
  assert.deepEqual(await b.read(), REFUSED('busy'))
  assert.deepEqual(await b.add(null), REFUSED('invalid'))
  const next = b.read({ terminal: `dsh:${B}` })
  const independent = other.read()
  await Promise.all([b, other].map(c => c.ask('manage-open', { grant: 'barrier', phone: PHONE })))
  await release()
  for (const pending of [first, next, independent]) assert.equal((await pending).state, 'read')
  for (let at = 2; at < 60; at += 1) assert.equal((await (at % 2 ? a : b).read()).state, 'read')
  assert.deepEqual(await a.read(), REFUSED('rate'))
  assert.deepEqual(await b.read({ terminal: 'dsh:missing' }), REFUSED('rate'))
  assert.equal((await other.read()).state, 'read')
})

test('chat writes and management share 20 writes per phone key across sockets', async (t) => {
  const h = await setup(t)
  const a = await h.connect()
  const b = await h.connect()
  const other = await h.connect({ phone: 'second-phone' })
  assert.deepEqual((await a.ask('subscribe', { channel: 1, terminal: TERMINAL })).result, { channel: 1 })
  const send = async at => (await a.ask('send', { channel: 1, phone: PHONE, by: `Name ${at}`, id: `message-${at}`, text: 'Chat fixture' })).result
  for (let at = 0; at < 10; at += 1) {
    const sent = await send(at)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal((await b.add(`Write fixture ${at}`, { phone: 'forged-phone' })).state, 'saved')
  }
  assert.deepEqual(await b.add('Over rate fixture'), REFUSED('rate'))
  assert.deepEqual(await send(10), { ...REFUSED('rate'), id: 'message-10' })
  assert.equal((await other.add('Other phone fixture')).state, 'saved')
  assert.equal(h.journal().length, 11)
})
