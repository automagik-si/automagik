import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agent as acpAgent, client as acpClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { Session } from '@deepseek-ai/dsh-session'
import { fileHandleText, offloadedImageText, projectFilesToText, projectImagesForTextModel,
  projectOffloadedImages, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { SessionFiles } from '../src/host/session-files.js'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter, promptOf } from '../src/host/adapter.js'
import { UPLOAD_PARAMS_BYTES, UPLOAD_READ_MS } from '../src/host/upload-content.js'
import { replayBlocks } from '../src/host/switch.js'
import { admission, receiptPng } from './support/upload-admission.js'

const text = text => ({ type: 'text', text })
const user = (content, kind = 'user') => ({ role: 'user', source: { kind }, content })
const data = receiptPng()
const ref = Object.freeze({ attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, mediaType: 'image/png', bytes: data.length, width: 622, height: 251 })
const picture = (attachment = ref) => ({ type: 'image', attachment })
const native = (bytes = data, mimeType = ref.mediaType) => ({ type: 'image', data: bytes.toString('base64'), mimeType })

// The real adapter and AgentRun dispatch to the ACP connection boundary. The transport
// records session/prompt params and ends the turn; this is not real-app acceptance.
function host(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'acp-upload-'))
  const session = Session.create('upload-test')
  const rows = []
  const dshAgent = {
    id: session.id, session,
    model: { current: () => ({ provider: 'acp-upload', model: 'default' }) },
    ctx: { tools: { register: () => () => {} } },
    followup: row => { rows.push(row); session.append('user/message', row, { surfaceOp: 'append' }) },
  }
  const reads = []
  const store = { readImage: async (ref, signal) => { reads.push({ ref, signal }); return { ref, data } } }
  const services = { attachments: store }
  let currentAgent = dshAgent
  const ctx = { agents: { get: () => currentAgent }, get: key => services[key] }
  const provider = { name: 'Upload test', spawn: () => { throw new Error('No native process in this test') } }
  const adapter = new AcpAdapter(ctx, new Map([['acp-upload', provider]]), overrides)
  const sent = []
  const runs = []
  const install = () => {
    const run = new AgentRun({ name: 'Upload test' })
    run.child = {} // alive, with no actual child process
    run.sessionId = 'native-upload-test'
    run.init = { agentCapabilities: { promptCapabilities: { image: true } } }
    run.gone = new Promise(() => {})
    run.conn = { prompt: async params => { sent.push(structuredClone(params)); return { stopReason: 'end_turn' } } }
    run.dispose = () => { run.disposed = true; run.letGo(true) }
    runs.push(run)
    const live = { run, provider: 'acp-upload', name: provider.name, dshAgent: currentAgent, asks: false, calls: new Set(), open: false }
    adapter.live.set(session.id, live)
    return live
  }
  const live = install()
  t.after(() => { adapter.dispose(); for (const run of runs) run.letGo(true); rmSync(home, { recursive: true, force: true }) })
  const step = async (messages, signal) => Array.fromAsync(adapter.stream({ provider: 'acp-upload', model: 'default', sessionId: session.id, messages, signal }))
  return { home, session, dshAgent, rows, adapter, services, reads, store, provider, sent, live, step, install, replaceAgent: () => { currentAgent = { ...dshAgent }; return currentAgent } }
}

for (const imageOnly of [true, false]) test(`receipt admission preserves ${imageOnly ? 'image-only' : 'mixed image/text'} at AgentRun ACP boundary`, async t => {
  const h = host(t)
  const { store, uploads, controller } = admission(h.home, h.dshAgent)
  const saved = await store.saveImage({ data, mediaType: 'image/png' })
  assert.equal(saved.bytes, 30031)
  assert.equal(saved.width, 622)
  assert.equal(saved.height, 251)
  const receiptId = uploads.stage(h.dshAgent, { type: 'image', attachment: saved, encodedBytes: data.length })
  assert.equal(uploads.resolve({ session: Session.create('foreign') }, receiptId), undefined)
  h.services.attachments = store
  const content = [{ type: 'file', receiptId }, ...imageOnly ? [] : [text('What is in this image?')]]
  assert.deepEqual(await controller.prompt({ sessionId: h.session.id, requestId: randomUUID(), content, mode: 'queue' }, { kind: 'user' }), { accepted: true })
  assert.deepEqual(h.rows[0].content, [picture(saved), ...imageOnly ? [] : [text('What is in this image?')]])
  const chunks = await h.step(h.rows)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0].prompt.map(block => block.type), imageOnly ? ['image'] : ['image', 'text'])
  assert.deepEqual(h.sent[0].prompt, [native(), ...imageOnly ? [] : [text('What is in this image?')]])
})

test('encoded admission and real file receipt keep image and file-handle contracts distinct', async t => {
  const h = host(t)
  const { store, uploads, controller } = admission(h.home, h.dshAgent)
  h.services.attachments = store
  await controller.prompt({ sessionId: h.session.id, requestId: randomUUID(), content: [{ type: 'image', mediaType: 'image/png', data: data.toString('base64') }], mode: 'queue' }, { kind: 'user' })
  await h.step(h.rows)
  assert.deepEqual(h.sent[0].prompt, [native()])
  const file = await store.saveFile({ data: Buffer.from('plain file contents'), mediaType: 'text/plain', name: 'note.txt' })
  const receiptId = uploads.stage(h.dshAgent, { type: 'file', attachment: file })
  await controller.prompt({ sessionId: h.session.id, requestId: randomUUID(), content: [{ type: 'file', receiptId }], mode: 'queue' }, { kind: 'user' })
  assert.equal(h.rows[1].content[0].type, 'file')
  const projected = projectFilesToText([h.rows[1]], ref => store.fileHostPath(ref))
  await h.step(projected)
  assert.deepEqual(h.sent[1].prompt, [text(fileHandleText(file, undefined))])
  assert.match(h.sent[1].prompt[0].text, /note\.txt/)
  assert.equal(h.sent[1].prompt.some(block => block.type === 'image'), false)
})

test('multiple images retain occurrence order, exact text payloads, and input immutability', async t => {
  const h = host(t)
  const messages = [user([text('before\n'), picture(), text(''), { type: 'unknown', data: 'ignored' }, text('middle'), picture(), text('after')])]
  const before = structuredClone(messages)
  await h.step(messages)
  assert.deepEqual(h.sent[0].prompt, [text('before\n'), native(), text(''), text('\n'), text('middle'), native(), text('after')])
  assert.deepEqual(messages, before)
  assert.equal(h.reads.length, 2)
})

test('generic non-Codex route falls back unless image capability is exactly true', async t => {
  const h = host(t)
  for (const capability of [undefined, false, 'true']) {
    h.live.run.init.agentCapabilities.promptCapabilities.image = capability
    const chunks = await h.step([user([picture()])])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(h.reads.length, 0)
    assert.deepEqual(h.sent.at(-1).prompt, [text(textOnlyImageText(ref))])
  }
  h.live.run.init.agentCapabilities.promptCapabilities.image = true
  await h.step([user([picture()])])
  assert.deepEqual(h.sent.at(-1).prompt, [native()])
})

test('invalid refs, MIME and sizes fail before any read, then valid input works', async t => {
  const h = host(t)
  const invalid = [undefined, {}, { ...ref, attachmentId: '/tmp/image.png' }, { ...ref, attachmentId: `${ref.attachmentId}\n` },
    { ...ref, mediaType: 'image/svg+xml' }, { ...ref, mediaType: 'IMAGE/PNG' },
    ...[NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '30031'].map(bytes => ({ ...ref, bytes })),
    { ...ref, width: 0 }, { ...ref, height: Infinity }]
  for (const attachment of invalid) {
    const chunks = await h.step([user([{ type: 'image', attachment }, text('do not partially send')])])
    assert.equal(chunks.at(-1).reason.kind, 'error')
  }
  assert.equal(h.reads.length, 0)
  assert.equal(h.sent.length, 0)
  await h.step([user([picture()])])
  assert.equal(h.sent.length, 1)
})

test('unavailable, rejecting and inconsistent stores fail whole prompt and retain owed replay', async t => {
  const h = host(t)
  const replay = [text('owed prior context')]
  const owed = { renewed: true }
  h.live.replay = replay
  h.live.owed = owed
  const readers = [undefined, {},
    { readImage: () => { throw new Error('integrity check failed') } },
    { readImage: async () => undefined },
    { readImage: async ref => ({ ref, data: data.subarray(1) }) },
    { readImage: async ref => ({ ref: { ...ref, mediaType: 'image/jpeg' }, data }) },
    { readImage: async ref => ({ ref: { ...ref, attachmentId: `sha256:${'b'.repeat(64)}` }, data }) },
    { readImage: async ref => ({ ref, data: data.toString('base64') }) }]
  for (const store of readers) {
    h.services.attachments = store
    const chunks = await h.step([user([picture(), text('not alone')])])
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(h.sent.length, 0)
    assert.equal(h.live.replay, replay)
    assert.equal(h.live.owed, owed)
    assert.equal(h.live.open, false)
  }
  h.services.attachments = h.store
  await h.step([user([picture()])])
  assert.deepEqual(h.sent[0].prompt, [...replay, native()])
  assert.equal(h.live.replay, undefined)
  assert.equal(h.live.owed, undefined)
})

test('real trusted store rejects corrupt object bytes without a partial prompt', async t => {
  const h = host(t)
  const { store } = admission(h.home, h.dshAgent)
  const saved = await store.saveImage({ data, mediaType: 'image/png' })
  h.services.attachments = store
  const path = store.imageHostPath(saved)
  // Only this test's fake home. The production projection never accesses a path.
  chmodSync(path, 0o600)
  writeFileSync(path, Buffer.alloc(data.length))
  const chunks = await h.step([user([text('do not send alone'), picture(saved)])])
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /integrity verification/)
  assert.equal(h.sent.length, 0)
  writeFileSync(path, data)
  await h.step([user([picture(saved)])])
  assert.equal(h.sent.length, 1)
})

test('20 occurrences succeed; 21, aggregate and single oversize are refused before reading', async t => {
  const h = host(t)
  await h.step([user(Array.from({ length: 20 }, () => picture()))])
  assert.equal(h.reads.length, 20)
  assert.equal(h.sent[0].prompt.length, 20)
  const messages = [Array.from({ length: 21 }, () => picture()),
    [picture({ ...ref, bytes: 18 * 1024 * 1024 })],
    [picture({ ...ref, bytes: 10 * 1024 * 1024 }), picture({ ...ref, bytes: 10 * 1024 * 1024 })]]
  for (const content of messages) {
    const chunks = await h.step([user(content)])
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(chunks.at(-1).reason.failure.message, /20 uploaded images|24 MiB/)
    assert.equal(h.reads.length, 20)
    assert.equal(h.sent.length, 1)
  }
  await h.step([user([text('valid later'), picture()])])
  assert.equal(h.sent.length, 2)
})

test('complete params boundary counts escaped unicode text, replay and native session id', async t => {
  const h = host(t)
  h.live.run.sessionId = 'native-"\\雪'
  const replay = [text('replay\n"\\é雪')]
  h.live.replay = replay
  h.live.owed = { renewed: true }
  const suffix = '\n"\\é雪'
  const overhead = Buffer.byteLength(JSON.stringify({ sessionId: h.live.run.sessionId, prompt: [...replay, native(), text(suffix)] }))
  const atLimit = 'x'.repeat(UPLOAD_PARAMS_BYTES - overhead) + suffix
  // One byte above must fail with no IO, even though the image is small.
  const rejected = await h.step([user([picture(), text(atLimit + 'x')])])
  assert.equal(rejected.at(-1).reason.kind, 'error')
  assert.equal(h.reads.length, 0)
  assert.equal(h.sent.length, 0)
  assert.equal(h.live.replay, replay)
  await h.step([user([picture(), text(atLimit)])])
  assert.equal(h.sent.length, 1)
  assert.equal(Buffer.byteLength(JSON.stringify(h.sent[0])), UPLOAD_PARAMS_BYTES)
  assert.equal(h.reads.length, 1)
})

test('exact size is checked again after the final awaited gate before replay is consumed', async t => {
  let asks = 0
  const replay = [text('owed')]
  const h = host(t, { holds: () => [() => { if (++asks === 2) replay[0].text = 'x'.repeat(UPLOAD_PARAMS_BYTES) }] })
  h.live.replay = replay
  const owed = { renewed: true }
  h.live.owed = owed
  const chunks = await h.step([user([picture()])])
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /24 MiB/)
  assert.equal(h.reads.length, 1)
  assert.equal(h.sent.length, 0)
  assert.equal(h.live.replay, replay)
  assert.equal(h.live.owed, owed)
  replay[0].text = 'owed'
  await h.step([user([picture()])])
  assert.equal(h.sent.length, 1)
})

test('user uploads above the bridge-only 5 MiB cap retain their full bytes', async t => {
  const h = host(t)
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 42)
  const big = { ...ref, bytes: bytes.length }
  h.services.attachments = { readImage: async ref => ({ ref, data: bytes }) }
  await h.step([user([picture(big)])])
  assert.equal(h.sent.length, 1)
  assert.equal(Buffer.from(h.sent[0].prompt[0].data, 'base64').equals(bytes), true)
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function delayRead(h) {
  const read = deferred()
  const entered = deferred()
  h.services.attachments = { readImage: (ref, signal) => { entered.resolve({ ref, signal }); return read.promise } }
  return { read, entered }
}

test('one total deadline covers sequential reads, races an uncooperative reader, and recovers', async t => {
  const deadlines = new Map()
  let created = 0
  const timers = {
    setTimeout: (fn, ms) => { assert.equal(ms, UPLOAD_READ_MS); deadlines.set(++created, fn); return created },
    clearTimeout: id => deadlines.delete(id),
  }
  const h = host(t, { timers })
  const slow = deferred()
  const entered = deferred()
  let count = 0
  h.services.attachments = { readImage: (ref, signal) => {
    if (++count === 1) return Promise.resolve({ ref, data })
    entered.resolve(signal)
    return slow.promise
  } }
  const pending = h.step([user([picture(), picture()])])
  const signal = await entered.promise
  assert.equal(created, 1, 'the second image does not renew the deadline')
  deadlines.get(1)()
  const chunks = await pending
  assert.equal(signal.aborted, true)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /not read in time/)
  assert.equal(h.sent.length, 0)
  assert.equal(deadlines.size, 0)
  slow.reject(new Error('late ignored-reader rejection'))
  h.services.attachments = h.store
  await h.step([user([picture()])])
  assert.equal(h.sent.length, 1)
  assert.equal(deadlines.size, 0)
})

for (const change of ['Stop', 'endSession', 'account', 'live replacement', 'run replacement', 'agent replacement', 'entry replacement']) {
  test(`delayed read: ${change} cannot prompt or dispose a replacement; subsequent valid send works`, { timeout: 3000 }, async t => {
    const h = host(t)
    const controller = new AbortController()
    const { read, entered } = delayRead(h)
    const pending = h.step([user([picture()])], controller.signal)
    const reading = await entered.promise
    assert.ok(h.adapter.starting.get(h.session.id), 'starting entry remains tracked')
    let replacement
    if (change === 'Stop') controller.abort()
    if (change === 'endSession') h.adapter.endSession(h.session.id)
    if (change === 'account') h.adapter.endProvider('acp-upload', 'Account changed')
    if (change === 'live replacement') replacement = h.install()
    if (change === 'run replacement') { replacement = h.install(); h.live.run = replacement.run; h.adapter.live.set(h.session.id, h.live) }
    if (change === 'agent replacement') h.replaceAgent()
    if (change === 'entry replacement') h.adapter.starting.set(h.session.id, { held: undefined })
    // Stops/endSession/account must win without waiting for the read to settle.
    if (!['Stop', 'endSession', 'account'].includes(change)) read.resolve({ ref: reading.ref, data })
    const chunks = await pending
    assert.equal(chunks.at(-1).reason.kind, change === 'Stop' ? 'aborted' : 'error')
    assert.equal(h.sent.length, 0)
    if (['Stop', 'endSession', 'account'].includes(change)) assert.equal(reading.signal.aborted, true)
    if (replacement) assert.notEqual(replacement.run.disposed, true)
    read.reject(new Error('late rejection after cancellation'))
    h.services.attachments = h.store
    h.install()
    await h.step([user([picture()])])
    assert.equal(h.sent.length, 1)
  })
}

test('a hold changed during image IO is asked after preparation and blocks dispatch', async t => {
  let held
  const h = host(t, { holds: () => [() => held] })
  const { read, entered } = delayRead(h)
  const pending = h.step([user([picture()])])
  const reading = await entered.promise
  held = 'Permission level changed'
  read.resolve({ ref: reading.ref, data })
  const chunks = await pending
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.sent.length, 0)
  assert.equal(h.live.run.disposed, true)
  held = undefined
  h.services.attachments = h.store
  h.install()
  await h.step([user([picture()])])
  assert.equal(h.sent.length, 1)
})

test('replacement during the final awaited hold gate remains alive and gets no stale prompt', async t => {
  const gate = deferred()
  const entered = deferred()
  let asks = 0
  const h = host(t, { holds: () => [() => ++asks === 1 ? undefined : (entered.resolve(), gate.promise)] })
  const pending = h.step([user([picture()])])
  await entered.promise
  const replacement = h.install()
  gate.resolve('stale hold must not dispose the replacement')
  const chunks = await pending
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(h.sent.length, 0)
  assert.notEqual(replacement.run.disposed, true)
  h.adapter.holds = undefined
  await h.step([user([picture()])])
  assert.equal(h.sent.length, 1)
})

test('unknown blocks and rejected sources keep exact legacy text with zero image reads', async t => {
  const h = host(t, { redactor: text => text.replaceAll('secret', '[redacted]') })
  const sources = [undefined, { kind: 'context' }, { kind: 'bot', form: 'relay' },
    { kind: 'bot', form: 'relay', handoff: true }, { kind: 'acp-session' }, { kind: 'retry' }]
  for (const source of sources) {
    const messages = [{ role: 'user', source, content: [text('secret'), picture(), { type: 'unknown', text: 'not text' }, text('')] }]
    await h.step(messages)
    assert.deepEqual(h.sent.at(-1).prompt, promptOf(messages, h.adapter.redact))
  }
  for (const content of [[], [text('')], [text('one'), text(''), text('two')], [{ type: 'unknown', text: 'hidden' }]]) {
    const messages = [user(content), user([text('last')])]
    await h.step(messages)
    assert.deepEqual(h.sent.at(-1).prompt, promptOf(messages))
  }
  assert.equal(h.reads.length, 0)
})

test('retry/history never resend an accepted image and provided DSH placeholders remain text', async t => {
  const h = host(t)
  const original = user([picture(), text('original')])
  await h.step([original])
  await h.step([original, user([], 'retry'), user([picture(), text('context')], 'context')])
  assert.deepEqual(h.sent[1].prompt, [text('Continue.')])
  const reply = { role: 'assistant', source: { kind: 'model', provider: 'acp-upload' }, content: [text('answer')] }
  await h.step([original, reply, user([text('next')])])
  assert.deepEqual(h.sent[2].prompt, [text('next')])
  const offloaded = projectOffloadedImages([user([{ ...picture(), offloaded: true }])], offloadedImageText)
  const textOnly = projectImagesForTextModel([user([picture()])])
  for (const messages of [offloaded, textOnly]) {
    await h.step(messages)
    assert.deepEqual(h.sent.at(-1).prompt, promptOf(messages))
    assert.ok(h.sent.at(-1).prompt[0].text.length > 0)
  }
  assert.equal(h.reads.length, 1)
})

test('raw DSH offloaded current image remains the existing explicit no-path placeholder', async t => {
  const h = host(t)
  await h.step([user([{ ...picture(), offloaded: true }])])
  assert.deepEqual(h.sent[0].prompt, [text(offloadedImageText(ref))])
  assert.equal(h.reads.length, 0)
  await h.step([user([{ ...picture(), offloaded: true }, picture()])])
  assert.deepEqual(h.sent[1].prompt, [text(offloadedImageText(ref)), native()])
  assert.equal(h.reads.length, 1)
})

test('unresolvable file handles retain explicit unreadable text with no image or path IO', async t => {
  const h = host(t)
  const file = { ...ref, mediaType: 'text/plain', name: 'unreachable.txt' }
  const projected = projectFilesToText([user([{ type: 'file', attachment: file }])], () => undefined)
  await h.step(projected)
  assert.deepEqual(h.sent[0].prompt, promptOf(projected))
  assert.match(h.sent[0].prompt[0].text, /cannot access a readable path/)
  assert.match(h.sent[0].prompt[0].text, /do not claim to have read it/)
  assert.equal(h.reads.length, 0)
})

test('owed renewed replay stays redacted text and current images occur only once after failed read', async t => {
  const redact = text => text.replaceAll('secret', '[redacted]')
  const h = host(t, { redactor: redact })
  const history = [user([picture(), text('old secret')]),
    { role: 'assistant', source: { kind: 'model', provider: 'acp-upload' }, content: [text('old answer')] }]
  h.live.replay = replayBlocks(history, { redact, to: h.provider.name, renewed: true })
  h.live.owed = { renewed: true }
  h.services.attachments = { readImage: async () => { throw new Error('temporary read failure') } }
  await h.step([...history, user([picture(), text('current')])])
  assert.equal(h.sent.length, 0)
  assert.ok(h.live.replay)
  h.services.attachments = h.store
  await h.step([...history, user([picture(), text('current')])])
  assert.equal(h.reads.length, 1)
  assert.equal(h.sent[0].prompt.filter(block => block.type === 'image').length, 1)
  assert.match(h.sent[0].prompt.map(block => block.text ?? '').join('\n'), /old \[redacted\]/)
  assert.equal(h.sent[0].prompt.map(block => block.text ?? '').join('\n').includes('secret'), false)
  assert.deepEqual(h.sent[0].prompt.slice(-2), [native(), text('current')])
})

test('trailing tool-result guard never creates a new prompt or reads historical image input', async t => {
  const h = host(t)
  const chunks = await h.step([user([picture()]), { role: 'tool', toolCallId: 'unknown', content: [text('done')] }])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.sent.length, 0)
  assert.equal(h.reads.length, 0)
})

test('own mode changed during a read is rechecked and strict mode is taken before dispatch', async t => {
  let permitted = true
  const h = host(t, { ownMode: () => () => permitted })
  h.services.approval = { effectivePolicy: () => 'ask' }
  h.services.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }
  h.provider.ownMode = 'agent'
  h.provider.modeFor = () => ['strict']
  h.live.run.modes = { currentModeId: 'strict', availableModes: [{ id: 'strict' }, { id: 'agent' }] }
  const modes = []
  h.live.run.conn.setSessionMode = async ({ modeId }) => { modes.push(modeId); return {} }
  const { read, entered } = delayRead(h)
  const pending = h.step([user([picture()])])
  const reading = await entered.promise
  assert.deepEqual(modes, ['agent'])
  permitted = false
  read.resolve({ ref: reading.ref, data })
  await pending
  assert.deepEqual(modes, ['agent', 'strict'])
  assert.equal(h.live.run.modes.currentModeId, 'strict')
  assert.equal(h.live.own, false)
  assert.equal(h.sent.length, 1)
})

for (const during of ['own answer', 'strict-mode reset', 'SessionFiles activation', 'SessionFiles run replacement']) {
  test(`replacement during final ${during} cannot receive a stale prompt or be disposed`, async t => {
    const h = host(t)
    const gate = deferred()
    const entered = deferred()
    if (!during.startsWith('SessionFiles')) {
      h.services.approval = { effectivePolicy: () => 'ask' }
      h.services.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }
      h.provider.ownMode = 'agent'
      h.provider.modeFor = () => ['strict']
      h.live.run.modes = { currentModeId: 'strict', availableModes: [{ id: 'strict' }, { id: 'agent' }] }
      let asks = 0
      h.adapter.ownMode = () => () => {
        if (++asks === 1) return true
        if (during === 'strict-mode reset') return false
        entered.resolve()
        return gate.promise
      }
      h.live.run.conn.setSessionMode = async ({ modeId }) => {
        if (modeId === 'strict') { entered.resolve(); await gate.promise }
        return {}
      }
    } else {
      // Keep the real stream finalizer; stub only the independent consent service. It must
      // not retire a newer owner's grant when this image turn loses its live identity.
      const owner = { session: h.session, grant: {} }
      h.live.fileOwner = owner
      h.adapter.sessionFiles.activate = async () => {
        h.adapter.starting.get(h.session.id).fileStartup = true
        h.adapter.sessionFiles.owners.set(h.session.id, owner)
        entered.resolve()
        await gate.promise
      }
      h.adapter.sessionFiles.valid = () => true
      h.adapter.sessionFiles.clear = () => h.adapter.sessionFiles.owners.delete(h.session.id)
    }
    const pending = h.step([user([picture()])])
    await entered.promise
    const replacement = h.install()
    const expectedLive = during === 'SessionFiles run replacement' ? h.live : replacement
    if (expectedLive === h.live) {
      h.live.run = replacement.run
      h.adapter.live.set(h.session.id, h.live)
    }
    gate.resolve(false)
    const chunks = await pending
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(h.sent.length, 0)
    assert.equal(h.adapter.live.get(h.session.id), expectedLive)
    assert.notEqual(replacement.run.disposed, true)
    h.adapter.sessionFiles.owners.clear()
    delete h.live.fileOwner
    h.adapter.ownMode = () => undefined
    h.provider.modeFor = undefined
    h.provider.ownMode = undefined
    await h.step([user([picture()])])
    assert.equal(h.sent.length, 1)
  })
}

for (const prior of ['acp-upload', 'other-provider']) test(`fresh session replay from ${prior} carries only text history plus current image`, async t => {
  const redact = text => text.replaceAll('secret', '[redacted]')
  const h = host(t, { dshTools: () => true, redactor: redact })
  // Exercise real new-session replay selection while substituting only process startup.
  h.adapter.live.delete(h.session.id)
  h.provider.spawn = () => ({})
  t.mock.method(AgentRun.prototype, 'start', async function () {
    this.child = {}
    this.sessionId = 'fresh-native-session'
    this.init = { agentCapabilities: { promptCapabilities: { image: true } } }
    this.gone = new Promise(() => {})
    this.conn = { prompt: async params => { h.sent.push(structuredClone(params)); return { stopReason: 'end_turn' } } }
    this.dispose = () => { this.disposed = true; this.letGo(true) }
  })
  const history = [user([picture(), text('old secret')]),
    { role: 'assistant', source: { kind: 'model', provider: prior }, content: [text('past answer')] }]
  await h.step([...history, user([picture(), text('current')])])
  assert.equal(h.reads.length, 1)
  const prompt = h.sent[0].prompt
  assert.equal(prompt.filter(block => block.type === 'image').length, 1)
  assert.deepEqual(prompt.slice(-2), [native(), text('current')])
  assert.match(prompt[0].text, prior === 'acp-upload' ? /before this new/ : /moved from/)
  assert.match(prompt.map(block => block.text ?? '').join('\n'), /old \[redacted\]/)
})

test('receipt-admitted image crosses actual SDK JSON-RPC serialization and default receiver', async t => {
  const h = host(t)
  const { store, uploads, controller } = admission(h.home, h.dshAgent)
  const saved = await store.saveImage({ data, mediaType: 'image/png' })
  const receiptId = uploads.stage(h.dshAgent, { type: 'image', attachment: saved, encodedBytes: data.length })
  await controller.prompt({ sessionId: h.session.id, requestId: randomUUID(), content: [{ type: 'file', receiptId }], mode: 'queue' }, { kind: 'user' })
  h.services.attachments = store
  const toAgent = new TransformStream()
  const toClient = new TransformStream()
  const received = []
  const peer = acpAgent({ name: 'generic-image-peer' })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { promptCapabilities: { image: true } } }))
    .onRequest(methods.agent.session.prompt, ({ params }) => { received.push(params); return { stopReason: 'end_turn' } })
    .connect(ndJsonStream(toClient.writable, toAgent.readable))
  const connection = acpClient({ name: 'upload-source-test' }).connect(ndJsonStream(toAgent.writable, toClient.readable))
  t.after(() => { connection.close(); peer.close() })
  h.live.run.init = await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  h.live.run.conn = { prompt: params => connection.agent.request(methods.agent.session.prompt, params) }
  const chunks = await h.step(h.rows)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { sessionId: h.live.run.sessionId, prompt: [native()] })
})

async function admittedFile(t, bytes = Buffer.from('AUTOMAGIK FILE READ CHECK')) {
  const h = host(t)
  h.session.header = { ...h.session.header, cwd: h.home }
  const { store, uploads, controller } = admission(h.home, h.dshAgent)
  const ref = await store.saveFile({ data: bytes, mediaType: 'text/plain', name: 'x.txt' })
  const receiptId = uploads.stage(h.dshAgent, { type: 'file', attachment: ref })
  await controller.prompt({ sessionId: h.session.id, requestId: randomUUID(),
    content: [{ type: 'file', receiptId }], mode: 'queue' }, { kind: 'user' })
  h.services.attachments = store
  const projected = projectFilesToText(h.rows, () => '/store/x.txt')
  const folder = join(h.home, '.automagik', 'uploads', ref.attachmentId.slice(7))
  return { h, ref, projected, folder, path: join(folder, ref.name), bytes }
}

test('receipt-admitted TXT reaches ACP through an exact read-only workspace copy', async t => {
  const { h, ref, projected, path, bytes } = await admittedFile(t)
  const chunks = await h.step(projected)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.sent[0].prompt, [text(fileHandleText(ref, path))])
  assert.deepEqual(readFileSync(path), bytes)
  assert.equal(statSync(path).mode & 0o777, 0o444)
  assert.equal(readFileSync(join(h.home, '.automagik', 'uploads', '.gitignore'), 'utf8'), '*\n')
  await h.step(projected)
  assert.deepEqual(h.sent[1].prompt, h.sent[0].prompt)
  assert.deepEqual(readdirSync(join(path, '..')), ['x.txt'])
})

for (const fault of ['conflict', '.automagik', 'uploads', 'no cwd', 'relative cwd',
  'missing cwd', 'declared size', 'stream failure']) {
  test(`file ${fault} still sends the unreadable handle`, async t => {
    const { h, ref, projected, folder, path } = await admittedFile(t)
    let reads = 0
    if (fault === 'conflict') {
      mkdirSync(folder, { recursive: true })
      writeFileSync(path, 'xxx')
    }
    const target = join(h.home, 'target')
    if (['.automagik', 'uploads'].includes(fault)) {
      mkdirSync(target)
      const parent = fault === 'uploads' ? join(h.home, '.automagik') : h.home
      if (parent !== h.home) mkdirSync(parent)
      symlinkSync(target, join(parent, fault))
    }
    if (fault === 'no cwd') h.session.header = { ...h.session.header, cwd: undefined }
    if (fault === 'relative cwd') h.session.header = { ...h.session.header, cwd: 'relative' }
    if (fault === 'missing cwd') {
      h.session.header = { ...h.session.header, cwd: join(h.home, 'missing') }
    }
    if (fault === 'declared size') {
      // Keep the binding typed while substituting a store reference too large to copy.
      ref.bytes = 64 * 1024 * 1024 + 1
      h.session.deriveMessages = () => [{ ...h.rows[0],
        content: [{ type: 'file', attachment: ref }] }]
    }
    h.services.attachments = { async *readFileStream() {
      reads++
      yield Buffer.from('a')
      throw new Error('Store read failed')
    } }
    const chunks = await h.step(projected)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(h.sent[0].prompt, [text(fileHandleText(ref, undefined))])
    assert.equal(reads, fault === 'stream failure' ? 1 : 0)
    if (fault === 'conflict') assert.equal(readFileSync(path, 'utf8'), 'xxx')
    if (['.automagik', 'uploads'].includes(fault)) assert.deepEqual(readdirSync(target), [])
    if (fault === 'stream failure') assert.deepEqual(readdirSync(folder), [])
  })
}

for (const imageSupport of [true, false]) {
  test(`image capability ${imageSupport} gets a copy path and sends the turn`, async t => {
    const h = host(t)
    h.session.header = { ...h.session.header, cwd: h.home }
    h.live.run.init.agentCapabilities.promptCapabilities.image = imageSupport
    await h.step([user([picture()])])
    const path = join(h.home, '.automagik', 'uploads', ref.attachmentId.slice(7), 'image.png')
    const line = text(`[Image "image.png" (622x251px, image/png): ` +
      `read-only copy saved at ${JSON.stringify(path)}. ` +
      'Read that path with your file tools when you need the file itself.]')
    assert.equal(h.sent.length, 1)
    assert.deepEqual(h.sent[0].prompt, [...imageSupport ? [native()] : [], line])
    assert.deepEqual(readFileSync(path), data)
    if (imageSupport) {
      assert.deepEqual(readFileSync(path), Buffer.from(h.sent[0].prompt[0].data, 'base64'))
    }
  })
}

test('image copy failure still sends native bytes without a path line', async t => {
  const h = host(t)
  h.session.header = { ...h.session.header, cwd: h.home }
  let reads = 0
  h.services.attachments = { readImage: async ref => {
    if (++reads === 1) throw new Error('Copy read failed')
    return { ref, data }
  } }
  await h.step([user([picture()])])
  assert.deepEqual(h.sent[0].prompt, [native()])
  assert.equal(reads, 2)
})

function copyCleanup(t, folder) {
  const removed = deferred()
  const unlink = fs.unlink
  const mocked = t.mock.method(fs, 'unlink', async path => {
    const result = await unlink(path)
    if (path.startsWith(join(folder, '.upload-'))) removed.resolve()
    return result
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  return removed.promise
}

test('Stop during a file copy removes its temp and never dispatches a prompt', async t => {
  const { h, projected, folder } = await admittedFile(t)
  const removed = copyCleanup(t, folder)
  const entered = deferred()
  const controller = new AbortController()
  h.services.attachments = { async *readFileStream() {
    yield Buffer.from('a')
    entered.resolve()
    await new Promise(() => {})
  } }
  const pending = h.step(projected, controller.signal)
  await entered.promise
  controller.abort()
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
  assert.equal(h.sent.length, 0)
  await removed
  assert.deepEqual(readdirSync(folder), [])
})

for (const mismatch of ['missing id', 'unknown id', 'length', 'source']) {
  test(`durable row ${mismatch} leaves projected text unchanged`, async t => {
    const { h, projected } = await admittedFile(t)
    const messages = structuredClone(projected)
    if (mismatch === 'missing id') delete messages[0].id
    if (mismatch === 'unknown id') messages[0].id = randomUUID()
    if (mismatch === 'length') messages[0].content.push(text('extra'))
    if (mismatch === 'source') {
      h.session.deriveMessages = () => [{ ...h.rows[0], source: { kind: 'context' } }]
    }
    h.services.attachments = { readFileStream: () => { assert.fail('No copy allowed') } }
    await h.step(messages)
    assert.deepEqual(h.sent[0].prompt, promptOf(messages))
    assert.equal(readdirSync(h.home).includes('.automagik'), false)
  })
}

test('retry, handoff, history, replay and offloaded rows make no copies', async t => {
  const { h, projected } = await admittedFile(t)
  h.services.attachments = { readFileStream: () => { assert.fail('No file read') },
    readImage: () => { assert.fail('No image read') } }
  const reply = { role: 'assistant', content: [text('done')] }
  const handoff = { ...projected[0], source: { kind: 'bot', form: 'relay', handoff: true } }
  const cases = [[...projected, user([], 'retry')], [handoff],
    [...projected, reply, user([text('next')])],
    [user([{ ...picture(), offloaded: true }])]]
  for (const messages of cases) {
    await h.step(messages)
    assert.deepEqual(h.sent.at(-1).prompt, promptOf(messages))
  }
  h.live.replay = [text(fileHandleText(ref, '/store/x.txt'))]
  await h.step([user([text('next')])])
  assert.equal(readdirSync(h.home).includes('.automagik'), false)
})

test('session file refusal uses neutral wording for files and keeps image wording', async () => {
  const files = new SessionFiles({})
  for (const [name, expected] of [['x.txt', 'The requested file'], ['x.png', 'The image']]) {
    const path = `/tmp/${name}`
    const call = { id: 'u', structuredName: 'request_permissions',
      rawInput: { permissions: { fileSystem: { read: [path] } } }, locations: [{ path }] }
    assert.equal(await files.ask({}, {}, {}, { call }),
      `${expected} was not approved for this chat session.`)
  }
})

test('unbound typed file input cannot grant a fresh store read', async t => {
  const h = host(t)
  h.session.header = { ...h.session.header, cwd: h.home }
  h.services.attachments = { readFileStream: () => { assert.fail('No durable binding') } }
  const file = { ...ref, name: 'x.txt', mediaType: 'text/plain' }
  const messages = [user([{ type: 'file', attachment: file }, text('next')])]
  await h.step(messages)
  assert.deepEqual(h.sent[0].prompt, promptOf(messages))
  assert.deepEqual(readdirSync(h.home), [])
})

test('one deadline interrupts a file copy and its temp is removed afterward', async t => {
  const { h, projected, folder } = await admittedFile(t)
  const removed = copyCleanup(t, folder)
  let expire, cleared = false
  h.adapter.timers = {
    setTimeout: (fn, ms) => { assert.equal(ms, UPLOAD_READ_MS); expire = fn; return 1 },
    clearTimeout: () => { cleared = true },
  }
  const entered = deferred()
  h.services.attachments = { async *readFileStream() {
    yield Buffer.from('a')
    entered.resolve()
    await new Promise(() => {})
  } }
  const pending = h.step(projected)
  await entered.promise
  expire()
  const chunks = await pending
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /not read in time/)
  assert.equal(h.sent.length, 0)
  await removed
  assert.deepEqual(readdirSync(folder), [])
  assert.equal(cleared, true)
})

test('mixed admitted file and image keep their order and copy both attachments', async t => {
  const { h, ref: file, path } = await admittedFile(t)
  const image = picture()
  const row = { ...h.rows[0], content: [image, text('read both'),
    { type: 'file', attachment: file }] }
  h.session.deriveMessages = () => [row]
  const store = h.services.attachments
  h.services.attachments = {
    readFileStream: (...args) => store.readFileStream(...args),
    readImage: async ref => ({ ref, data }),
  }
  await h.step(projectFilesToText([row], () => '/store/x.txt'))
  const prompt = h.sent[0].prompt
  assert.deepEqual(prompt.map(block => block.type), ['image', 'text', 'text', 'text'])
  assert.deepEqual(prompt[0], native())
  assert.match(prompt[1].text, /read-only copy saved at/)
  assert.deepEqual(prompt.slice(2), [text('read both'), text(fileHandleText(file, path))])
})

test('a matching outside hard link sends unreadable text and retains its mode', async t => {
  const { h, ref, projected, folder, path, bytes } = await admittedFile(t)
  const outside = mkdtempSync(join(tmpdir(), 'acp-upload-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const original = join(outside, 'x.txt')
  writeFileSync(original, bytes, { mode: 0o600 })
  mkdirSync(folder, { recursive: true })
  linkSync(original, path)
  const chunks = await h.step(projected)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.sent[0].prompt, [text(fileHandleText(ref, undefined))])
  assert.deepEqual(readFileSync(original), bytes)
  assert.equal(statSync(original).mode & 0o777, 0o600)
})

for (const reason of ['Stop', 'deadline']) {
  test(`${reason} ends a stalled filesystem copy without a prompt`, { timeout: 2000 }, async t => {
    const { h, projected, folder } = await admittedFile(t)
    const entered = deferred()
    const controller = new AbortController()
    let expire, cleared = false
    h.adapter.timers = {
      setTimeout: (fn, ms) => { assert.equal(ms, UPLOAD_READ_MS); expire = fn; return 1 },
      clearTimeout: () => { cleared = true },
    }
    const open = fs.open
    const mocked = t.mock.method(fs, 'open', (path, ...args) => {
      if (path.startsWith(join(folder, '.upload-'))) {
        entered.resolve()
        return new Promise(() => {})
      }
      return open(path, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
    const pending = h.step(projected, controller.signal)
    await entered.promise
    if (reason === 'Stop') controller.abort()
    else expire()
    const chunks = await pending
    assert.equal(chunks.at(-1).reason.kind, reason === 'Stop' ? 'aborted' : 'error')
    if (reason === 'deadline') {
      assert.match(chunks.at(-1).reason.failure.message, /not read in time/)
    }
    assert.equal(h.sent.length, 0)
    assert.equal(cleared, true)
    assert.deepEqual(readdirSync(folder), [])
  })
}
