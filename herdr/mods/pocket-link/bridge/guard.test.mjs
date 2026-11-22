// node --test bridge/guard.test.mjs: the handshake deadline, the connection cap, the log throttle
// and rotation. Fake iroh objects only; no network, no npm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, openSync, writeSync, closeSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptOne, slots, throttle, rotateLog, readLine, addressOf, MAX_LINE, routesFor, endRemoved, sessionName, ALPN } from './guard.mjs'

const never = () => new Promise(() => {})
const later = (ms, value) => new Promise(r => setTimeout(() => r(value), ms))

/** A stream that hands out these chunks, then the end; `hang` never answers after them. */
function recv(chunks, { hang = false } = {}) {
  const queue = chunks.map(c => [...Buffer.from(c)])
  return { read: async () => queue.length ? queue.shift() : hang ? never() : [] }
}

/** A fake peer. Each step can be swapped for one that is slow or never answers. */
function peer({ alpn = 'pair', id = 'a'.repeat(64), lines = ['{"code":"x"}\n'], hang = false, connect, acceptBi, from = { kind: 'ip', addr: '198.51.100.7:4433' }, validated = true } = {}) {
  const conn = {
    closedWith: null,
    remoteId: () => ({ toString: () => id }),
    close(code, reason) { this.closedWith = Buffer.from(reason).toString() },
    acceptBi: acceptBi ?? (async () => ({ recv: recv(lines, { hang }), send: {} })),
    closed: async () => 'closed',
  }
  const incoming = {
    refused: false,
    refuse: async () => { incoming.refused = true },
    remoteAddr: async () => from,
    retried: false,
    remoteAddrValidated: async () => validated,
    retry: async () => { if (validated) throw new Error('already validated'); incoming.retried = true },
    accept: async () => ({ alpn: async () => [...Buffer.from(alpn)], connect: connect ? () => connect(conn) : async () => conn }),
  }
  return { conn, incoming }
}

const logged = () => { const lines = []; const f = (...a) => lines.push(a.join(' ')); f.lines = lines; return f }

test('a peer that connects and then says nothing is closed at the deadline, and its slot comes back', async () => {
  const { conn, incoming } = peer({ acceptBi: never })
  const cap = slots({ pending: 1, open: 1 })
  const refused = logged()
  let ran = false
  await acceptOne(incoming, { routes: { pair: { admit: () => true, run: () => { ran = true }, timed: true } }, cap, refused, ms: 30 })
  assert.equal(conn.closedWith, 'too slow')
  assert.equal(ran, false)
  assert.match(refused.lines[0], /^connection nothing within/)
  assert.deepEqual(cap.counts(), { pending: 0, open: 0 })
})

test('a header that never ends a line is cut off at the deadline too', async () => {
  const { conn, incoming } = peer({ lines: ['{"code":'], hang: true })
  await acceptOne(incoming, { routes: { pair: { admit: () => true, run: () => {}, timed: true } }, cap: slots(), refused: logged(), ms: 30 })
  assert.equal(conn.closedWith, 'too slow')
})

test('a header that is not JSON closes the connection at once and gives its slot back', async () => {
  const { conn, incoming } = peer({ lines: ['not json\n'] })
  const cap = slots()
  const refused = logged()
  await acceptOne(incoming, { routes: { pair: { admit: () => true, run: () => {}, timed: true } }, cap, refused, ms: 1000 })
  assert.equal(conn.closedWith, 'bad request')
  assert.match(refused.lines[0], /^connection /)
  assert.deepEqual(cap.counts(), { pending: 0, open: 0 })
})

test('a handshake that finishes after the deadline is closed when it does', async () => {
  const { conn, incoming } = peer({ connect: c => later(60, c) })
  await acceptOne(incoming, { routes: { pair: { admit: () => true, run: () => {}, timed: true } }, cap: slots(), refused: logged(), ms: 20 })
  assert.equal(conn.closedWith, null)
  await later(80)
  assert.equal(conn.closedWith, 'too slow')
})

test('an unpaired key is closed before anything is read from it', async () => {
  let read = false
  const { conn, incoming } = peer({ alpn: 'session', acceptBi: async () => { read = true; return { recv: recv([]) } } })
  const refused = logged()
  await acceptOne(incoming, { routes: { session: { admit: () => false, closing: 'not paired', run: () => {}, timed: false } }, cap: slots(), refused, ms: 1000 })
  assert.equal(conn.closedWith, 'not paired')
  assert.equal(read, false)
  assert.match(refused.lines[0], /^refused not paired: aaaaaaaaaa$/)
})

test('with no live code, a pairing connection is closed with its route\'s reason before anything is read', async () => {
  let read = false
  const { conn, incoming } = peer({ acceptBi: async () => { read = true; return { recv: recv([]) } } })
  const cap = slots()
  await acceptOne(incoming, { routes: { pair: { admit: () => false, closing: 'no pairing code', run: () => {}, timed: true } }, cap, refused: logged(), ms: 1000 })
  assert.equal(conn.closedWith, 'no pairing code')
  assert.equal(read, false)
  assert.deepEqual(cap.counts(), { pending: 0, open: 0 })
})

test('a paired session\'s own error is logged in full, not throttled with the strangers\'', async () => {
  const { conn, incoming } = peer({ alpn: 'session', lines: ['{"session":"main"}\n'] })
  const refused = logged(), log = logged()
  await acceptOne(incoming, { routes: { session: { admit: () => true, run: async () => { throw new Error('hc went away') }, timed: false } }, cap: slots(), refused, log, ms: 1000 })
  assert.deepEqual(log.lines, ['session: hc went away'])
  assert.deepEqual(refused.lines, [])
  assert.equal(conn.closedWith, 'failed')
})

test('a paired session runs past the deadline once its header is in, and holds its slot until it ends', async () => {
  const { conn, incoming } = peer({ alpn: 'session', lines: ['{"session":"main"}\nrest'] })
  const cap = slots({ pending: 4, open: 4 })
  let seen = null, finish
  const done = acceptOne(incoming, {
    routes: { session: { admit: () => true, run: job => { seen = job; return new Promise(r => { finish = r }) }, timed: false } },
    cap, refused: logged(), ms: 20,
  })
  await later(60)
  assert.deepEqual(seen.value, { session: 'main' })
  assert.equal(Buffer.from(seen.rest).toString(), 'rest')
  assert.equal(conn.closedWith, null)
  assert.deepEqual(cap.counts(), { pending: 0, open: 1 })
  finish()
  await done
  assert.deepEqual(cap.counts(), { pending: 0, open: 0 })
})

test('over the cap, a connection is refused before its handshake', async () => {
  const cap = slots({ pending: 2, open: 3 })
  const hung = [peer({ acceptBi: never }), peer({ acceptBi: never })]
  const routes = { pair: { admit: () => true, run: () => {}, timed: true } }
  const waiting = hung.map(p => acceptOne(p.incoming, { routes, cap, refused: logged(), ms: 50 }))
  await later(5)
  assert.deepEqual(cap.counts(), { pending: 2, open: 2 })
  const extra = peer()
  let accepted = false
  extra.incoming.accept = async () => { accepted = true; throw new Error('should not get here') }
  const refused = logged()
  await acceptOne(extra.incoming, { routes, cap, refused, ms: 50 })
  assert.equal(extra.incoming.refused, true)
  assert.equal(accepted, false)
  assert.deepEqual(refused.lines, ['refused too many connections'])
  await Promise.all(waiting)
  assert.deepEqual(cap.counts(), { pending: 0, open: 0 })
})

test('one address can hold only a few pending slots; others, and its trusted sessions, are not held back', async () => {
  const cap = slots({ pending: 16, open: 64, perAddress: 2 })
  const routes = { pair: { admit: () => true, run: () => {}, timed: true } }
  const stranger = { kind: 'ip', addr: '203.0.113.5:1000' }
  const hung = [peer({ acceptBi: never, from: stranger }), peer({ acceptBi: never, from: { ...stranger, addr: '203.0.113.5:2000' } })]
  const waiting = hung.map(p => acceptOne(p.incoming, { routes, cap, refused: logged(), ms: 50 }))
  await later(5)
  const third = peer({ from: { ...stranger, addr: '203.0.113.5:3000' } })
  await acceptOne(third.incoming, { routes, cap, refused: logged(), ms: 50 })
  assert.equal(third.incoming.refused, true) // a third from the same IP, on another port
  const owner = peer({ from: { kind: 'relay', addr: 'https://relay.example/', endpointId: 'b'.repeat(64) } })
  await acceptOne(owner.incoming, { routes, cap, refused: logged(), ms: 50 })
  assert.equal(owner.incoming.refused, false)
  await Promise.all(waiting)
  const a = cap.enter('ip:203.0.113.5'); a.trusted()
  const b = cap.enter('ip:203.0.113.5'); b.trusted()
  assert.ok(cap.enter('ip:203.0.113.5')) // trusted sessions no longer count as pending
})

test('an unvalidated source address gets a retry and takes no slot; a validated one goes on', async () => {
  const cap = slots({ pending: 1, open: 1 })
  const routes = { pair: { admit: () => true, run: () => {}, timed: true } }
  const spoofed = peer({ validated: false })
  let accepted = false
  spoofed.incoming.accept = async () => { accepted = true; throw new Error('should not get here') }
  await acceptOne(spoofed.incoming, { routes, cap, refused: logged(), ms: 50 })
  assert.equal(spoofed.incoming.retried, true)
  assert.equal(accepted, false)
  assert.deepEqual(cap.counts(), { pending: 0, open: 0 })
  const back = peer()
  await acceptOne(back.incoming, { routes, cap, refused: logged(), ms: 50 })
  assert.equal(back.incoming.retried, false)
  assert.equal(back.conn.closedWith, null) // let through: handshake, header, run, done
})

test('the address is the IPv4 address or IPv6 /64 of a direct connection and the claimed key over a relay, never the shared relay', () => {
  assert.equal(addressOf({ kind: 'ip', addr: '198.51.100.7:4433' }), 'ip:198.51.100.7')
  assert.equal(addressOf({ kind: 'ip', addr: '[2001:db8::1]:4433' }), 'ip:2001:db8:0:0::/64')
  assert.equal(addressOf({ kind: 'ip', addr: '[2001:db8:0:0:ffff:1:2:3]:9' }), 'ip:2001:db8:0:0::/64') // same /64
  assert.equal(addressOf({ kind: 'ip', addr: '[2001:db8:0:1::5]:9' }), 'ip:2001:db8:0:1::/64')
  assert.equal(addressOf({ kind: 'ip', addr: '[fe80::1%en0]:9' }), 'ip:fe80:0:0:0::/64')
  assert.equal(addressOf({ kind: 'ip', addr: '[::ffff:198.51.100.7]:9' }), 'ip:198.51.100.7')
  assert.equal(addressOf({ kind: 'relay', addr: 'https://relay.example/', endpointId: 'abc' }), 'relay:abc')
  assert.equal(addressOf(undefined), '?')
})

test('open sessions count toward the total cap, not the pending one', () => {
  const cap = slots({ pending: 1, open: 2 })
  const a = cap.enter(); a.trusted()
  const b = cap.enter()
  assert.ok(b)
  assert.equal(cap.enter(), null) // open is full
  b.done(); b.done() // twice changes nothing
  assert.deepEqual(cap.counts(), { pending: 0, open: 1 })
})

test('the log throttle keeps a few lines of each kind a minute and says how many it left out', () => {
  let t = 0
  const log = logged()
  const say = throttle(log, { burst: 2, per: 60_000, now: () => t })
  for (let i = 0; i < 5; i++) say('refused', 'peer', i)
  say('pair', 'wrong code')
  assert.deepEqual(log.lines, ['refused: peer 0', 'refused: peer 1', 'pair: wrong code'])
  t = 60_000
  say('refused', 'peer', 9)
  assert.deepEqual(log.lines.slice(3), ['refused: 3 more like this in the last minute', 'refused: peer 9'])
})

test('rotation copies a full log to .1 and empties it in place; an appending writer carries on at the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-guard-test-'))
  const path = join(dir, 'bridge.log')
  const fd = openSync(path, 'a', 0o600) // as launchd opens the service's stderr
  writeSync(fd, 'x'.repeat(100))
  assert.equal(rotateLog(path, 200), false)
  writeSync(fd, 'y'.repeat(150))
  assert.equal(rotateLog(path, 200), true)
  assert.equal(readFileSync(`${path}.1`, 'utf8'), 'x'.repeat(100) + 'y'.repeat(150))
  assert.equal(statSync(`${path}.1`).mode & 0o777, 0o600)
  writeSync(fd, 'after\n')
  closeSync(fd)
  assert.equal(readFileSync(path, 'utf8'), 'after\n')
  assert.equal(rotateLog(join(dir, 'missing.log'), 1), false)
})

test('rotation refuses symlinks introduced into either log after startup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-guard-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'bridge.log'), outside = join(dir, 'unrelated')
  writeFileSync(outside, 'unrelated bytes')
  symlinkSync(outside, path)
  assert.throws(() => rotateLog(path, 1), /unsafe/i)
  rmSync(path)
  writeFileSync(path, 'complete log')
  symlinkSync(outside, `${path}.1`)
  assert.throws(() => rotateLog(path, 1), /bridge\.log\.1/)
  assert.equal(readFileSync(path, 'utf8'), 'complete log')
  assert.equal(readFileSync(outside, 'utf8'), 'unrelated bytes')
})

test('a header line longer than the limit is refused', async () => {
  await assert.rejects(readLine(recv(['x'.repeat(MAX_LINE + 10)])), /header too long/)
  await assert.rejects(readLine(recv(['{"a":1}'])), /closed before its header/)
  const { value, rest } = await readLine(recv(['{"a":', '1}\nmore']))
  assert.deepEqual(value, { a: 1 })
  assert.equal(Buffer.from(rest).toString(), 'more')
})

// ---------------------------------------------------------------- the chat route (RFC 0015 delivery 4)

const table = (pairedIds, runs = {}) => routesFor({
  paired: id => pairedIds.includes(id), codeLive: () => false,
  pair: runs.pair ?? (() => {}), session: runs.session ?? (() => {}), chat: runs.chat ?? (() => {}),
})

test('the chat route: an unpaired key is closed before its header is read', async () => {
  let read = false
  const { conn, incoming } = peer({ alpn: ALPN.chat, acceptBi: async () => { read = true; return { recv: recv([]) } } })
  const refused = logged()
  await acceptOne(incoming, { routes: table([]), cap: slots(), refused, ms: 1000 })
  assert.equal(conn.closedWith, 'not paired')
  assert.equal(read, false)
  assert.match(refused.lines[0], /^refused not paired/)
})

test('the chat route admits a paired key by the same check as the terminal session, untimed', async () => {
  const id = 'b'.repeat(64)
  let ran = null
  const { incoming } = peer({ alpn: ALPN.chat, id, lines: ['{"session":"default"}\n'] })
  await acceptOne(incoming, { routes: table([id], { chat: job => { ran = job } }), cap: slots(), refused: logged(), ms: 1000 })
  assert.equal(ran?.peer, id)
  assert.deepEqual(ran?.value, { session: 'default' })
  const routes = table([id])
  assert.equal(routes[ALPN.chat].timed, false)
  for (const who of [id, 'c'.repeat(64)]) assert.equal(routes[ALPN.chat].admit(who), routes[ALPN.session].admit(who))
})

test("a removed phone's chat and terminal sessions are ended; a paired phone's stay", () => {
  const ended = []
  const live = new Set([
    { phone: 'gone', end: () => ended.push('gone chat') },
    { phone: 'gone', end: () => ended.push('gone session') },
    { phone: 'kept', end: () => ended.push('kept') },
  ])
  assert.equal(endRemoved(live, new Set(['kept'])), 2)
  assert.deepEqual(ended.sort(), ['gone chat', 'gone session'])
  assert.deepEqual([...live].map(s => s.phone), ['kept'])
})

test('a session name: hc-safe characters, never only dots, else default (both routes)', () => {
  for (const [given, want] of [['work', 'work'], ['a.b_c-1', 'a.b_c-1'], ['.', 'default'], ['..', 'default'], ['...', 'default'], ['.hidden', '.hidden'],
    ['a/b', 'default'], ['', 'default'], ['x'.repeat(65), 'default'], [7, 'default'], [undefined, 'default']]) {
    assert.equal(sessionName({ session: given }), want, String(given))
  }
  assert.equal(sessionName(null), 'default')
})
