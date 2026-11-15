import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEditInput } from '../src/host/image-input.js'
import { HISTORY_PAGES_MAX } from '../src/host/constants.js'
import { MAX_IMAGE_BYTES } from '../src/host/imagegen.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const HASH = 'abcd1234' + 'a'.repeat(56)
const refOf = (patch = {}) => ({ attachmentId: `sha256:${HASH}`, name: 'picture.png',
  mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1, ...patch })
const row = (ref = refOf(), source = { kind: 'user' }, block = {}) => ({
  type: 'user/message', data: { source, content: [{ type: 'image', attachment: ref, ...block }] },
})
function setup({ logs = { current: [row()] }, parts = ['earlier', 'current'], read, room, owner, store = true } = {}) {
  const reads = [], scans = []
  const rt = {
    botOfSession: () => ({ id: 'test-bot' }), roomOf: () => room, groupOwners: new Map([['current', owner]]),
    partsOf: () => parts.map(sessionId => ({ sessionId })),
    deriveMessages: () => [],
    async *eventsBackwards(id, signal, pages) {
      scans.push(id)
      assert.equal(pages, HISTORY_PAGES_MAX)
      assert.ok(signal instanceof AbortSignal)
      yield* logs[id] ?? []
    },
  }
  const ctx = { get: name => {
    assert.equal(name, 'attachments')
    return store ? { readImage: async (ref, signal) => {
      reads.push(ref)
      assert.ok(Object.isFrozen(ref))
      return read ? read(ref, signal) : { ref: { ...ref }, data: PNG }
    } } : undefined
  } }
  const input = createEditInput({ rt, ctx })
  return { reads, scans, rt, resolve: (selector, signal, agent = { session: { id: 'current' } }) => input.resolve({ agent }, selector, signal) }
}
async function refused(promise, pattern) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'bot/unavailable')
    assert.match(error.message, pattern)
    assert.doesNotMatch(error.message, /another Bot/i)
    return true
  })
}

test('names, sha256 and nonexistent upload/store paths select durable uploads without filesystem access', async () => {
  const input = setup()
  for (const selector of ['picture.png', '  "picture.png"  ', `sha256:${HASH.slice(0, 8)}`,
    `sha256:${HASH.toUpperCase()}`, `.automagik/uploads/${HASH}/x.png`,
    `/nonexistent/dsh/attachments/sha256/${HASH}/image`]) {
    const result = await input.resolve(selector)
    assert.equal(result.ref.attachmentId, `sha256:${HASH}`)
    assert.equal(result.mediaType, 'image/png')
    assert.deepEqual(result.data, PNG)
  }
  assert.deepEqual(input.rt.deriveMessages(), [], 'compacted uploads are absent from the derivation')
  const source = readFileSync(new URL('../src/host/image-input.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:fs|readFile|realpath|\bstat\(/)
})

test('a same-content copy outside the uploads region gets actionable refusal text', async t => {
  const folder = await fsPromises.mkdtemp(join(tmpdir(), 'image-input-copy-'))
  t.after(() => fsPromises.rm(folder, { recursive: true, force: true }))
  const copy = join(folder, 'picture.png')
  await fsPromises.writeFile(copy, PNG)
  const input = setup()
  assert.deepEqual((await input.resolve('picture.png')).data, await fsPromises.readFile(copy))
  await assert.rejects(input.resolve(copy), {
    code: 'bot/unavailable',
    message: "No picture the user attached in this chat matches that. Pass the picture's name as the chat shows it, its sha256, or the path of your own copy under .automagik/bots; a copy you made anywhere else does not count. If the user has not attached it here, ask them to.",
  })
  assert.equal(input.reads.length, 1, 'only the chat name authorizes a store read')
})

test('earlier parts and offloaded uploads count; other chats are never scanned', async () => {
  const input = setup({ logs: { earlier: [row(refOf(), { kind: 'user' }, { offloaded: true })],
    other: [row(refOf({ name: 'other.png' }))] } })
  await input.resolve('picture.png')
  assert.deepEqual(input.scans, ['current', 'earlier'])
  await refused(input.resolve('other.png'), /No picture the user attached in this chat matches that/)
  assert.ok(!input.scans.includes('other'))
  const standalone = setup({ logs: { standalone: [row()], earlier: [row()] } })
  await standalone.resolve('picture.png', undefined, { id: 'standalone' })
  assert.deepEqual(standalone.scans, ['standalone'])
})

test('duplicate ids dedupe, but distinct matching names or prefixes refuse before a store read', async () => {
  await setup({ logs: { current: [row(), row()] } }).resolve('picture.png')
  const second = refOf({ attachmentId: `sha256:abcd1234${'b'.repeat(56)}` })
  for (const selector of ['picture.png', 'sha256:abcd1234']) {
    const input = setup({ logs: { current: [row(), row(second)] } })
    await refused(input.resolve(selector), /sha256:abcd1234aaaa.*picture.png.*sha256:abcd1234bbbb.*which one/)
    assert.equal(input.reads.length, 0)
  }
  const input = setup({ logs: { current: [row(), row(refOf({
    attachmentId: `sha256:${'c'.repeat(64)}`, name: 'sha256:abcd1234',
  }))] } })
  assert.equal((await input.resolve('sha256:abcd1234')).ref.attachmentId, `sha256:${HASH}`)
})

test('only genuine user image rows count, and arbitrary paths never read the store', async () => {
  for (const source of [{ kind: 'bot' }, { kind: 'user', handoff: true }, undefined]) {
    const event = row(); event.data.source = source
    const input = setup({ logs: { current: [event] } })
    await refused(input.resolve('picture.png'), /No picture the user attached in this chat matches that/)
    assert.equal(input.reads.length, 0)
  }
  const retried = row(); retried.data.source = { kind: 'retry' }
  assert.equal((await setup({ logs: { current: [retried] } }).resolve('picture.png')).ref.attachmentId, `sha256:${HASH}`)
  const relay = { type: 'user/message', data: { source: { kind: 'bot' }, content: [
    { type: 'text', text: `message_bot: .automagik/uploads/${HASH}/picture.png` },
  ] } }
  const input = setup({ logs: { current: [relay] } })
  for (const selector of ['picture.png', '~/Pictures/x.png', '/etc/passwd', '../x.png']) {
    await refused(input.resolve(selector), /No picture the user attached in this chat matches that/)
  }
  for (const selector of [null, '', ' ', 'x'.repeat(1025)]) await refused(input.resolve(selector), /Name the uploaded picture/)
  assert.equal(input.reads.length, 0)
})

test('group and group-member Sessions refuse without scanning or reading', async () => {
  for (const options of [{ room: {} }, { owner: 'group' }]) {
    const input = setup(options)
    await refused(input.resolve('picture.png'), /group chat is not available yet.*own chat/)
    assert.deepEqual(input.scans, [])
    assert.deepEqual(input.reads, [])
  }
})

test('invalid media and sizes refuse before reading; missing store explains why', async () => {
  for (const patch of [{ mediaType: 'image/gif' }, { bytes: MAX_IMAGE_BYTES + 1 }, { bytes: 0 }, { bytes: 1.5 }]) {
    const input = setup({ logs: { current: [row(refOf(patch))] } })
    await refused(input.resolve('picture.png'), /convert it to PNG or JPEG first|invalid size/)
    assert.deepEqual(input.reads, [])
  }
  await refused(setup({ store: false }).resolve('picture.png'), /This Automagik cannot read uploaded pictures/)
})

test('store reference, length, byte type and magic must match the frozen snapshot', async () => {
  for (const read of [ref => ({ ref: { ...ref, width: 2 }, data: PNG }),
    ref => ({ ref, data: PNG.subarray(1) }), ref => ({ ref, data: [...PNG] }),
    ref => ({ ref, data: Buffer.alloc(PNG.length) })]) {
    await refused(setup({ read }).resolve('picture.png'), /does not match/)
  }
  const forged = Buffer.from('524946460000000057454250', 'hex').map(byte => byte | 0x80)
  await refused(setup({ logs: { current: [row(refOf({ mediaType: 'image/webp', bytes: forged.length }))] },
    read: ref => ({ ref, data: forged }) }).resolve('picture.png'), /does not match/)
  for (const [mediaType, data] of [['image/jpeg', Buffer.from('ffd8ff00', 'hex')],
    ['image/webp', Buffer.from('524946460000000057454250', 'hex')]]) {
    const input = setup({ logs: { current: [row(refOf({ mediaType, bytes: data.length }))] },
      read: ref => ({ ref, data }) })
    assert.deepEqual((await input.resolve('picture.png')).data, data)
  }
})

test('abort interrupts a store that ignores its signal', async () => {
  const controller = new AbortController()
  const input = setup({ read: (ref, signal) => {
    assert.ok(signal instanceof AbortSignal)
    assert.notEqual(signal, controller.signal, 'the read also carries its deadline')
    controller.abort()
    assert.equal(signal.aborted, true)
    return new Promise(() => {})
  } })
  await refused(input.resolve('picture.png', controller.signal), /stopped/)
})

test('a store that never settles is bounded by ten seconds', async () => {
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await refused(setup({ read: () => new Promise(() => {}) }).resolve('picture.png'), /not read in time/)
  } finally { clearInterval(keepAlive) }
})

test('selectors never invoke filesystem APIs, even for a matching path-shaped display name', async t => {
  const calls = []
  for (const api of [fs, fsPromises]) {
    for (const name of ['open', 'readFile', 'stat', 'lstat', 'realpath', 'access', 'readlink', 'opendir',
      'openSync', 'readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync']) {
      if (typeof api[name] !== 'function') continue
      t.mock.method(api, name, (...args) => {
        calls.push([name, args[0]])
        throw new Error('selectors have no filesystem authority')
      })
    }
  }
  syncBuiltinESMExports()
  try {
    const input = setup({ logs: { current: [row(), row(refOf({ name: '../uploaded.png' }))] } })
    for (const selector of [`/nonexistent/uploads/${HASH}/picture.png`, '../uploaded.png']) {
      assert.equal((await input.resolve(selector)).ref.attachmentId, `sha256:${HASH}`)
    }
    for (const selector of ['/etc/passwd', '~/Pictures/x.png', '../x.png', 'img-invented.png']) {
      await refused(input.resolve(selector), /No picture the user attached in this chat matches that/)
    }
    assert.equal(input.reads.length, 2, 'only durable uploads authorize a store read')
    assert.deepEqual(calls, [])
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('event type, content block type and canonical attachment id are all required', async () => {
  for (const event of [
    { ...row(), type: 'bot/message' },
    row(refOf(), { kind: 'user' }, { type: 'file' }),
    row(refOf(), { kind: 'user' }, { type: 'text', text: `sha256:${HASH}` }),
    ...[undefined, HASH, `sha256:${HASH.toUpperCase()}`, `sha256:${HASH.slice(0, 63)}`,
      `sha256:${HASH}0`, `sha256:${'z'.repeat(64)}`].map(attachmentId => row(refOf({ attachmentId }))),
    { type: 'user/message', data: { source: { kind: 'user' }, content: 'picture.png' } },
  ]) {
    const input = setup({ logs: { current: [event] } })
    await refused(input.resolve('picture.png'), /No picture the user attached in this chat matches that/)
    assert.deepEqual(input.reads, [])
  }
})

test('part switches use the owning conversation and share the bounded history signal', async () => {
  const input = setup({ logs: { current: [row()], earlier: [row()] } })
  const signals = []
  const events = input.rt.eventsBackwards.bind(input.rt)
  input.rt.eventsBackwards = (id, signal, pages) => {
    signals.push(signal)
    return events(id, signal, pages)
  }
  input.rt.deriveMessages = () => assert.fail('compacted history must come from the durable log')
  input.rt.botOfSession = (id, agent) => {
    assert.equal(id, 'earlier', 'Session id takes precedence over agent id')
    assert.equal(agent.id, 'unrelated-agent-id')
    return { id: 'test-bot' }
  }
  await input.resolve('picture.png', undefined, { id: 'unrelated-agent-id', session: { id: 'earlier' } })
  assert.deepEqual(input.scans, ['current', 'earlier'])
  assert.equal(input.reads.length, 1, 'the same attachment across parts is read once')
  assert.equal(signals[0], signals[1])

  const standalone = setup()
  standalone.rt.botOfSession = () => undefined
  standalone.rt.partsOf = () => assert.fail('an unowned Session cannot search Bot parts')
  await standalone.resolve('picture.png')
  assert.deepEqual(standalone.scans, ['current'])
})

test('knowing another conversation upload id or a team image path never authorizes a read', async () => {
  const foreign = 'f'.repeat(64)
  const input = setup({ logs: { other: [row(refOf({ attachmentId: `sha256:${foreign}` }))] } })
  for (const selector of [`sha256:${foreign}`, 'sha256:ffffffff',
    `/nonexistent/dsh/attachments/${foreign}/picture.png`, './images/img-invented.png']) {
    await refused(input.resolve(selector), /No picture the user attached in this chat matches that/)
  }
  assert.equal(input.scans.includes('other'), false)
  assert.deepEqual(input.reads, [])
})

test('full ids override prefixes and display names, while prefix lengths and exact names stay distinct', async () => {
  const input = setup({ logs: { current: [row(), row(refOf({
    attachmentId: `sha256:${'c'.repeat(64)}`, name: `sha256:${HASH}`,
  }))] } })
  for (const selector of [`sha256:cccccccc /${HASH}/picture.png`, `sha256:${HASH.slice(0, 63).toUpperCase()}`]) {
    assert.equal((await input.resolve(selector)).ref.attachmentId, `sha256:${HASH}`)
  }
  for (const selector of ['Picture.png', 'picture', 'sha256:abcd123', `/${HASH}0/picture.png`]) {
    await refused(input.resolve(selector), /No picture the user attached in this chat matches that/)
  }
  const longest = 'x'.repeat(1024)
  assert.equal((await setup({ logs: { current: [row(refOf({ name: longest }))] } })
    .resolve(`  ${longest}  `)).ref.attachmentId, `sha256:${HASH}`)
})

test('every durable reference field is checked against the frozen snapshot', async () => {
  for (const patch of [{ attachmentId: `sha256:${'b'.repeat(64)}` }, { mediaType: 'image/jpeg' },
    { bytes: PNG.length + 1 }, { width: 2 }, { height: 2 }]) {
    await refused(setup({ read: ref => ({ ref: { ...ref, ...patch }, data: PNG }) })
      .resolve('picture.png'), /does not match/)
  }
  for (const stored of [undefined, {}, { ref: refOf(), data: new ArrayBuffer(PNG.length) }]) {
    await refused(setup({ read: () => stored }).resolve('picture.png'), /does not match/)
  }
  const original = refOf()
  const input = setup({ logs: { current: [row(original)] }, read: ref => {
    original.attachmentId = `sha256:${'b'.repeat(64)}`
    original.bytes++
    assert.throws(() => { ref.bytes++ }, TypeError)
    return { ref: { ...ref }, data: new Uint8Array(PNG) }
  } })
  assert.equal((await input.resolve('picture.png')).ref.attachmentId, `sha256:${HASH}`)
})

test('invalid byte counts never read, while the exact decoded-size limit is accepted', async () => {
  for (const bytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '16', undefined]) {
    const input = setup({ logs: { current: [row(refOf({ bytes }))] } })
    await refused(input.resolve('picture.png'), /invalid size/)
    assert.deepEqual(input.reads, [])
  }
  const data = Buffer.alloc(MAX_IMAGE_BYTES)
  PNG.copy(data)
  const input = setup({ logs: { current: [row(refOf({ bytes: data.length }))] },
    read: ref => ({ ref, data }) })
  assert.equal((await input.resolve('picture.png')).data.byteLength, MAX_IMAGE_BYTES)
})

test('pre-cancellation and cancellation during stalled history never reach the store', async () => {
  const controller = new AbortController()
  controller.abort()
  const pre = setup()
  await refused(pre.resolve('picture.png', controller.signal), /stopped/)
  assert.deepEqual(pre.scans, [])
  assert.deepEqual(pre.reads, [])

  const midway = new AbortController()
  const input = setup()
  let entered
  const scanning = new Promise(resolve => { entered = resolve })
  let historySignal
  input.rt.eventsBackwards = async function* (id, signal, pages) {
    historySignal = signal
    assert.equal(pages, HISTORY_PAGES_MAX)
    entered()
    yield await new Promise(() => {})
  }
  const result = input.resolve('picture.png', midway.signal)
  await scanning
  midway.abort()
  await refused(result, /stopped/)
  assert.equal(historySignal.aborted, true)
  assert.deepEqual(input.reads, [])
})

test('the ten-second history deadline also bounds an iterator that ignores cancellation', async t => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 10_000)
    return deadline.signal
  })
  const input = setup()
  input.rt.eventsBackwards = async function* () {
    deadline.abort(new DOMException('history deadline', 'TimeoutError'))
    yield await new Promise(() => {})
  }
  await refused(input.resolve('picture.png'), /not read in time/)
  assert.deepEqual(input.reads, [])
})
