import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { SOURCE_KIND } from '../src/host/constants.js'
import { allowlist, code, fixture, guest, member, owners, stranger } from './caller-fixture.js'

const url = 'http://fixture.invalid/api/omni-ui/feed'
const open = (f, principal = member, request = new Request(url)) => f.ctx.get('automagikCallerRoutes').match('/api/omni-ui/feed', 'GET')(request, principal)
const read = async reader => {
  const { value, done } = await reader.read()
  return done ? null : new TextDecoder().decode(value)
}
const hello = 'event: hello\ndata: {}\n\n'
const revision = 'event: revision\ndata: {}\n\n'
const changed = id => `event: changed\ndata: ${JSON.stringify({ botId: id })}\n\n`
const user = (f, part) => f.event(part, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'private-user' }] })
const bot = (f, part) => f.event(part, 'assistant/message', { message: { content: [{ type: 'text', text: 'private-bot' }] } })
const relay = (f, part, notify = true) => f.event(part, 'user/message', { source: { kind: SOURCE_KIND, role: 'reply' } }, { notify })

async function readerFor(f, principal, request) {
  const response = await open(f, principal, request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const reader = response.body.getReader()
  assert.equal(await read(reader), hello)
  return reader
}

test('CF1 caller frames contain only hello, revision and visible Bot ids, alongside the owner feed', async t => {
  const f = fixture(t)
  await f.start()
  const allowed = await f.open('a', allowlist)
  const hidden = await f.open()
  const caller = await readerFor(f, guest)
  const ownerResponse = await f.routes.get('/api/omni-ui/feed').fetch(new Request(url))
  const owner = ownerResponse.body.getReader()
  assert.match(await read(owner), /^event: hello\ndata: {"revision":\d+/)
  user(f, hidden)
  bot(f, allowed)
  assert.equal(await read(caller), changed('a'))
  f.rt.publishFeed('notice', { text: 'owner-only-notice' })
  let seen = ''
  while (!seen.includes('owner-only-notice')) seen = await read(owner)
  assert.match(seen, /^event: notice/)
  await f.rt.save()
  assert.equal(await read(caller), revision)
  await owner.cancel()
  await caller.cancel()
})

test('CF2 a missed relay permits only a coalesced signal and a history read closes the feed', async t => {
  const f = fixture(t)
  await f.start()
  const part = await f.open()
  const reader = await readerFor(f)
  f.event(part, 'turn/start', { turn: 1 })
  user(f, part)
  assert.equal((await f.rt.callerChat(member, 'b')).items.length, 1)
  relay(f, part, false)
  for (let turn = 2; turn <= 65; turn++) {
    f.event(part, 'turn/start', { turn })
    user(f, part)
    bot(f, part)
  }
  assert.equal(await read(reader), changed('b'))
  let extra
  const waiting = read(reader).then(value => { extra = value; return value })
  await setImmediate()
  assert.equal(extra, undefined)
  await assert.rejects(f.rt.callerChat(member, 'b'), code('not-found'))
  assert.equal(await waiting, null)
})

test('CF3 a queued change is revalidated after the lock or current visibility is lost', async t => {
  const f = fixture(t)
  await f.start()
  const part = await f.open()
  for (const loss of ['lock', 'visibility']) {
    const reader = await readerFor(f)
    user(f, part)
    const spy = loss === 'lock' ? t.mock.method(f.rt, 'readOnly', () => 'lock lost')
      : t.mock.method(f.service, 'visibleBotIds', () => new Set())
    const pending = read(reader)
    // revision can pass while the queued Bot-specific frame is dropped at pull.
    await setImmediate()
    spy.mock.restore()
    f.rt.accessChanged()
    assert.equal(await pending, revision)
    await reader.cancel()
  }
})

test('CF4 narrowing removes queued changes while widening keeps the same feed', async t => {
  const f = fixture(t, { seed: team => {
    team.bots.c = { ...team.bots.b, id: 'c', sessionId: 'c', name: 'Other' }
  } })
  await f.start()
  const first = await f.open('b')
  const chief = await f.open('a', allowlist)
  let reader = await readerFor(f)
  user(f, chief)
  await f.rt.setPeople('a', owners)
  assert.equal(await read(reader), null)
  reader = await readerFor(f)
  await f.open('c')
  assert.equal(await read(reader), revision)
  await reader.cancel()

  assert.equal((await f.call('bot-new-part', { botId: 'b' })).ok, true)
  await f.finishSwitch()
  const current = f.rt.chatOf('b')
  assert.deepEqual(f.readable(), [first, current])
  reader = await readerFor(f)
  user(f, current)
  relay(f, first)
  assert.equal(await read(reader), null)
  assert.ok(f.service.visibleBotIds(member).has('b'))
  assert.deepEqual(f.readable(), [current])

  reader = await readerFor(f)
  user(f, current)
  relay(f, current)
  assert.equal(await read(reader), null)
})

test('CF5 four feeds of one person across families share a cap, with other people independent', async t => {
  const f = fixture(t)
  await f.start()
  const feeds = []
  for (const principal of [member, guest, member, guest]) feeds.push(await readerFor(f, principal))
  const refused = await open(f)
  assert.equal(refused.status, 429)
  assert.equal(await refused.text(), 'Too many open feeds')
  const other = await readerFor(f, stranger)
  await feeds.pop().cancel()
  feeds.push(await readerFor(f))
  for (const reader of [...feeds, other]) await reader.cancel()
})

test('CF6 queued bytes are shared across feeds and keepalive waits for an empty queue', async t => {
  const f = fixture(t)
  await f.start()
  t.mock.timers.enable({ apis: ['setInterval'] })
  const readers = []
  for (let i = 0; i < 4; i++) readers.push((await open(f)).body.getReader())
  t.mock.timers.tick(15_000)
  for (const reader of readers) assert.equal(await read(reader), hello)
  f.rt.accessChanged()
  t.mock.timers.tick(15_000)
  for (const reader of readers) assert.equal(await read(reader), revision)
  t.mock.timers.tick(15_000)
  for (const reader of readers) assert.equal(await read(reader), ': keepalive\n\n')
  // An unread comment contributes its 13 bytes per feed to the same budget as revisions.
  t.mock.timers.tick(15_000)
  const capacity = Math.floor((65_536 - 4 * Buffer.byteLength(': keepalive\n\n')) / Buffer.byteLength(revision))
  for (let i = 0; i <= Math.floor(capacity / 4); i++) f.rt.accessChanged()
  const overflowed = readers.splice(capacity % 4, 1)[0]
  assert.equal(await read(overflowed), null)
  assert.equal(await read(readers[0]), ': keepalive\n\n')
  const replacement = await readerFor(f)
  await replacement.cancel()
  for (const reader of readers) await reader.cancel()
})

test('CF7 an abort, service loss and disposal release the caller feed', async t => {
  const f = fixture(t)
  await f.start()
  const abort = new AbortController()
  const first = await readerFor(f, member, new Request(url, { signal: abort.signal }))
  const second = await readerFor(f)
  abort.abort()
  assert.equal(await read(first), null)
  f.rt.accessChanged()
  assert.equal(await read(second), revision)
  await f.emitService(undefined)
  assert.equal(await read(second), null)
  await f.emitService(f.service)
  const next = await readerFor(f)
  f.rt.dispose()
  assert.equal(await read(next), null)
})
