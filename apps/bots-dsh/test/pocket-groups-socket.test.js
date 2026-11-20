import assert from 'node:assert/strict'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/host/pocket-attach.js'
import { METHODS, WRITE_METHODS } from '../src/host/pocket-socket.js'
import { host, readState, roomSeed, terminal, tick } from './support/pocket-groups.js'
import { deferred, memoryWire } from './support/pocket-upload-admission.js'

const bot = { terminal: 'dsh:a', title: 'Main' }
const groupHello = { write: 1, groups: 1 }
const by = { channel: 1, phone: 'phone-a', by: 'Pocket A' }
const msg = { ...by, id: 'send-1', text: 'Hello' }

function wire(t, h, overrides = {}) {
  const source = {
    writable: true, groupsOffer: h.source.available(), groups: h.source,
    list: async () => [bot], ...overrides,
  }
  const client = memoryWire(source)
  t.after(() => client.stop())
  return client
}

async function open(client, params = groupHello) {
  assert.equal((await client.request('hello', params)).groups, 1)
  assert.deepEqual(await client.request('subscribe', { terminal, channel: 1 }), { channel: 1 })
  assert.equal(client.events[0]?.event.type, 'snapshot')
}

const gone = (client, reason) => assert.deepEqual(client.events.at(-1), { channel: 1, event: { type: 'gone', reason } })

test('old bridge hello and list bytes are unchanged and reserved terminals never reach Bot routing', async t => {
  const h = await host(t)
  const client = wire(t, h, { watch: () => assert.fail('Bot watch') })
  const methods = [...METHODS, ...WRITE_METHODS]
  await client.request('hello', { write: 1 })
  await client.request('list')
  assert.deepEqual(client.lines, [
    JSON.stringify({ id: 1, result: { protocol: 1, readOnly: false, write: 1, methods, dedupe: 'log' } }),
    JSON.stringify({ id: 2, result: { terminals: [bot] } }),
  ])
  assert.equal((await client.request('subscribe', { terminal, channel: 1 })).kind, 'not-found')
})

test('only a writable, installed group source with a current team grants groups', async t => {
  const h = await host(t, { load: false })
  const cold = wire(t, h)
  assert.equal((await cold.request('hello', { groups: 1 })).groups, undefined)
  assert.equal((await wire(t, h, { writable: false }).request('hello', groupHello)).groups, undefined)
  assert.equal((await wire(t, h, { groupsOffer: false }).request('hello', groupHello)).groups, undefined)
  assert.equal((await cold.request('hello', groupHello)).groups, 1)
  const readOnly = h.rt.readOnly
  h.rt.readOnly = () => 'read-only'
  assert.equal((await wire(t, h).request('hello', groupHello)).groups, undefined)
  h.rt.readOnly = readOnly
  const prepare = h.source.prepare.bind(h.source)
  h.source.prepare = async () => {
    const gen = await prepare()
    h.rt.teamCurrent = () => false
    return gen
  }
  assert.equal((await wire(t, h).request('hello', groupHello)).groups, undefined)
})

test('hello waits for an adopt and a superseding hello leaves its old reply without groups', async t => {
  const h = await host(t)
  const client = wire(t, h)
  const waiting = deferred()
  const entered = deferred()
  const refresh = h.rt.refreshShellChoice
  h.rt.refreshShellChoice = async () => {
    entered.resolve()
    await waiting.promise
    await refresh()
  }
  const hello = client.request('hello', groupHello)
  await entered.promise
  assert.deepEqual(client.lines, [])
  assert.equal((await client.request('hello', { write: 1 })).groups, undefined)
  const state = readState(h.home)
  state.rooms.r1.members.push('c')
  writeFileSync(join(h.home, 'state.json'), JSON.stringify(state))
  unlinkSync(join(h.home, 'state.lock'))
  h.places.set('c', { folder: 'unshown' })
  waiting.resolve()
  assert.equal((await hello).groups, undefined)
  assert.equal((await client.request('hello', groupHello)).groups, 1)
  assert.deepEqual((await client.request('list')).terminals, [bot])
})

test('group watches refuse rich options, uploads and all management, while a Bot watch keeps them', async t => {
  const h = await host(t)
  const calls = []
  const client = wire(t, h, {
    manages: true, listsSchedules: true, managesSettings: true, attachments: true,
    attachmentOffer: () => ({ version: 1, documents: { version: 1 } }),
    memoryAllowed: id => { calls.push(['memory', id]); return 'not-found' },
    schedulesAllowed: id => { calls.push(['schedule', id]); return 'not-found' },
    settingsAllowed: id => { calls.push(['settings', id]); return 'not-found' },
    manageMemory: async (_method, { allowed }) => ({ reason: allowed() }),
    manageSchedules: async () => ({}),
    manageSettings: async () => ({}),
    watch: async (name, _emit, options) => {
      calls.push(['watch', name, options])
      return { ok: true, close() {}, async send(args) { calls.push(['send', args]); return { ok: true } } }
    },
  })
  const hello = { ...groupHello, manage: 1, attachments: 1, documents: 1 }
  assert.equal((await client.request('hello', hello)).groups, 1)
  for (const field of ['attachments', 'documents']) {
    assert.equal((await client.request('subscribe', { terminal, channel: 1, [field]: 1 })).kind, 'unsupported')
  }
  assert.deepEqual(await client.request('subscribe', { terminal, channel: 1 }), { channel: 1 })
  assert.deepEqual(await client.request('subscribe', { terminal: bot.terminal, channel: 2, attachments: 1, documents: 1 }), { channel: 2 })
  assert.deepEqual(calls, [['watch', 'dsh:a', { after: undefined, attachments: true, documents: true }]])
  assert.equal((await client.request('send', { ...msg, uploads: [] })).reason, 'unsupported')
  assert.equal((await client.request('send', { ...msg, channel: 2, retry: true })).ok, true)
  assert.deepEqual(calls.at(-1), ['send', { text: msg.text, id: msg.id, by: by.by }])
  assert.deepEqual(await client.request('manage-open', { grant: 'grant-a', phone: by.phone }), { grant: 'grant-a' })
  const before = calls.length
  for (const method of ['memory-read', 'schedule-list', 'settings-read']) {
    assert.equal((await client.request(method, { terminal, grant: 'grant-a' })).reason, 'invalid')
  }
  assert.equal(calls.length, before)
  for (const method of ['memory-read', 'schedule-list', 'settings-read']) {
    assert.equal((await client.request(method, { terminal: 'dsh:a', grant: 'grant-a' })).reason, 'not-found')
  }
  assert.deepEqual(calls.slice(before), [['memory', 'a'], ['schedule', 'a'], ['settings', 'a']])
})

for (const method of ['list', 'subscribe']) {
  test(`a lost and reclaimed lock closes a group connection on its first ${method}`, async t => {
    const h = await host(t)
    const client = wire(t, h)
    assert.equal((await client.request('hello', groupHello)).groups, 1)
    unlinkSync(join(h.home, 'state.lock'))
    await h.rt.refresh()
    assert.deepEqual(await client.request(method, { terminal, channel: 1 }), { disconnected: true })
    const fresh = wire(t, h)
    await open(fresh)
    assert.equal((await fresh.request('list')).terminals.length, 2)
  })
}

test('reclaim between polls and a read-only team both retire a group watch and close the socket', async t => {
  const h = await host(t)
  const first = wire(t, h)
  await open(first)
  unlinkSync(join(h.home, 'state.lock'))
  await h.rt.refresh()
  await h.source.recheckAll()
  gone(first, 'unavailable')
  const second = wire(t, h)
  await open(second)
  h.rt.readOnly = () => 'read-only'
  assert.deepEqual(await second.request('interrupt', by), { disconnected: true })
  gone(second, 'unavailable')
})

test('a repeated groups hello keeps its watches and in-flight list, while downgrade only retires its own grant', async t => {
  const h = await host(t)
  const blocked = deferred()
  let hold = true
  const first = wire(t, h, { list: async () => { if (hold) await blocked.promise; return [bot] } })
  const second = wire(t, h)
  await open(first)
  await open(second)
  h.rt.sendUser = async () => {}
  assert.equal((await second.request('send', msg)).state, 'sent')
  const ask = h.ask()
  const [{ id }] = h.rt.approvalsView()
  h.rt.answerApproval(id, 'allow')
  await ask
  const list = first.request('list')
  assert.equal((await first.request('hello', groupHello)).groups, 1)
  blocked.resolve()
  assert.equal((await list).terminals.length, 2)
  hold = false
  h.quote({ who: 'User', text: 'still watching' })
  await tick()
  assert.equal(first.events.at(-1).event.type, 'rows')
  const delayed = deferred()
  const eligibleRoomIds = h.source.eligibleRoomIds.bind(h.source)
  h.source.eligibleRoomIds = async (...args) => { await delayed.promise; return eligibleRoomIds(...args) }
  const inFlight = first.request('list')
  await first.request('hello', { write: 1 })
  gone(first, 'unavailable')
  delayed.resolve()
  assert.deepEqual((await inFlight).terminals, [bot])
  assert.deepEqual((await first.request('list')).terminals, [bot])
  assert.equal((await second.request('send', { ...msg, retry: true })).repeat, true)
  assert.equal((await second.request('answer', { ...by, row: id, choice: 'allow' })).receipt.by, 'computer')
})

test('a list releases current membership and drops ineligible rooms after a slower proof', async t => {
  const h = await host(t, { rooms: { r1: roomSeed(), r2: roomSeed('r2', { sessions: {} }) } })
  h.places.set('b', { folder: 'shown' })
  h.shown.add('shown')
  const client = wire(t, h)
  await open(client)
  const proof = h.source.eligible.bind(h.source)
  const delayed = deferred()
  const captured = deferred()
  h.source.eligible = async (room, gen) => {
    const result = await proof(room, gen)
    if (room.id === 'r1') captured.resolve()
    else await delayed.promise
    return result
  }
  const list = client.request('list')
  await captured.promise
  h.room().members = ['a']
  h.shown.clear()
  delayed.resolve()
  const { terminals } = await list
  assert.deepEqual(terminals.map(row => row.terminal), ['dsh:a', terminal])
  assert.deepEqual(terminals[1].members, [{ name: 'Main', registryId: null }])
})

test('withdrawing consent during a backfill drops the page and ends the watch', async t => {
  const h = await host(t)
  h.places.set('b', { folder: 'shown' })
  h.shown.add('shown')
  h.quote({ who: 'User', text: 'secret' })
  const client = wire(t, h)
  await open(client)
  const entered = deferred()
  const resume = deferred()
  const prove = h.source.eligible.bind(h.source)
  h.source.eligible = async (...args) => {
    entered.resolve()
    await resume.promise
    return prove(...args)
  }
  const pending = client.request('backfill', { channel: 1, before: 'dsh:room:r1:2' })
  await entered.promise
  h.shown.clear()
  resume.resolve()
  assert.equal((await pending).kind, 'closed')
  gone(client, 'not-shown')
})

for (const method of ['send', 'answer', 'interrupt']) {
  test(`withdrawn consent refuses ${method} before mutation`, async t => {
    const h = await host(t)
    h.places.set('b', { folder: 'shown' })
    h.shown.add('shown')
    const client = wire(t, h)
    await open(client)
    h.shown.clear()
    h.rt.sendUser = h.rt.answerApproval = h.rt.stopRoomWork = () => assert.fail('mutated')
    const result = await client.request(method, { ...msg, row: 'ask', choice: 'allow' })
    assert.equal(result.reason, 'not-shown')
    gone(client, 'not-shown')
  })
}

test('half-close during preparation stops a send, and a reply cannot cross channel reuse', async t => {
  const h = await host(t)
  const first = wire(t, h)
  await open(first)
  const entered = deferred()
  const release = deferred()
  const prove = h.source.eligible.bind(h.source)
  h.source.eligible = async (...args) => { entered.resolve(); await release.promise; return prove(...args) }
  const pending = first.request('send', msg)
  await entered.promise
  first.halfClose()
  release.resolve()
  assert.equal((await pending).reason, 'not-watching')
  assert.equal(h.prompts.length, 0)

  const second = wire(t, h)
  await open(second)
  const sent = deferred()
  const finish = deferred()
  h.rt.sendUser = async () => { sent.resolve(); await finish.promise }
  const sending = second.request('send', msg)
  await sent.promise
  await second.request('unsubscribe', { channel: 1 })
  await second.request('subscribe', { terminal, channel: 1 })
  finish.resolve()
  assert.equal((await sending).reason, 'not-watching')
})

test('wire retries use the phone key and resolve after a part move and loss of send memory', async t => {
  const h = await host(t)
  const client = wire(t, h)
  await open(client)
  h.rt.ensureCapabilities = async () => {}
  assert.equal((await client.request('send', msg)).state, 'sent')
  assert.equal(h.prompts[0].requestId, `pocket-${sha256(by.phone).slice(0, 12)}-${msg.id}`)
  h.quote({ who: 'User', text: msg.text, requestId: h.prompts[0].requestId })
  h.room().sessionId = 'part-2'
  const fresh = h.newSource()
  fresh.start()
  const next = wire(t, h, { groups: fresh })
  await open(next)
  assert.equal((await next.request('send', { ...msg, retry: true })).repeat, true)
  assert.equal((await next.request('send', { ...msg, retry: true, phone: 'another' })).state, 'unknown')
  assert.equal(h.prompts.length, 1)
})

test('the socket checks consent again after the source has built a backfill page', async t => {
  const h = await host(t)
  h.places.set('b', { folder: 'shown' })
  h.shown.add('shown')
  h.quote({ who: 'User', text: 'withhold this page' })
  const client = wire(t, h)
  const built = deferred()
  const release = deferred()
  const watch = h.source.watch.bind(h.source)
  h.source.watch = async (...args) => {
    const handle = await watch(...args)
    const backfill = handle.backfill
    handle.backfill = async (...args) => {
      const rows = await backfill(...args)
      built.resolve(rows)
      await release.promise
      return rows
    }
    return handle
  }
  await open(client)
  const page = client.request('backfill', { channel: 1, before: 'dsh:room:r1:2' })
  assert.equal((await built.promise)[0].text, 'withhold this page')
  h.shown.clear()
  release.resolve()
  assert.equal((await page).kind, 'closed')
  gone(client, 'not-shown')
})
