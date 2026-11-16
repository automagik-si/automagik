import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { install as uploads } from '../src/host/shared-uploads.js'
import { install as images } from '../src/host/images.js'
import { install as secrets } from '../src/host/secrets.js'

async function fixture(t, { noFolder = false, secret = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'image-paths-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const value = `test-${randomBytes(16).toString('hex')}`
  const folder = join(home, value)
  await mkdir(folder)
  const data = Buffer.from('image bytes')
  const ref = { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, name: 'a\n"`picture.png', bytes: data.length, mediaType: 'image/png', width: 1, height: 1 }
  await writeFile(join(home, 'ocr.json'), JSON.stringify({ [ref.attachmentId]: { text: 'A picture.', model: 'Vision' } }))
  const bot = { id: 'a', name: 'the test Bot' }
  const listeners = new Map(), sent = []
  let restarts = 0, reads = 0
  const ctx = { on: (name, fn) => listeners.set(name, [...listeners.get(name) ?? [], fn]), inject() {}, effect() {},
    get: key => key === 'attachments' ? { readImage: async typed => { reads++; return { ref: typed, data } } } : undefined,
    llm: { resolveModelInfo: async (_provider, model) => ({ inputModalities: model === 'text' ? ['text'] : ['text', 'image'] }) } }
  ctx.llm.stream = options => {
    assert.ok(++restarts < 10, 'listeners must terminate')
    const chain = listeners.get('llm/stream')
    const dispatch = i => i < chain.length ? chain[i](options, () => dispatch(i + 1)) : (async function* () { sent.push(options); yield { type: 'done' } })()
    return dispatch(0)
  }
  const rt = { ctx, home, state: { bots: { a: bot }, rooms: {}, prefs: {} }, config: {}, teamTools: [],
    botOfSession: () => bot, botOf: id => id === 'sender' || id === 'a' ? bot : undefined,
    workDirOf: () => undefined, teamFolder: () => noFolder ? undefined : folder,
    chatOf: id => id, ownRequest: () => false, load: async () => {}, roomOf: () => undefined,
    readOnly: () => undefined, carryUsageTag() {}, warn() {} }
  uploads(rt); images(rt)
  if (secret) {
    await writeFile(join(home, 'secrets.json'), JSON.stringify({ version: 1, secrets: [{ name: 'FOLDER_TOKEN', value, scope: 'all', createdAt: 1, updatedAt: 1 }] }))
    secrets(rt)
    await rt.loadSecrets()
  }
  const rows = (source = { kind: 'user' }, offloaded = false) => [{ role: 'user', source, content: [{ type: 'image', attachment: ref, ...(offloaded ? { offloaded: true } : {}) }] }]
  const run = async (messages, provider = 'native', model = 'vision') => {
    restarts = 0
    const original = markAgentLoopRequest({ messages, provider, model, sessionId: 'a' })
    const before = structuredClone(original.messages)
    await Array.fromAsync(ctx.llm.stream(original))
    assert.deepEqual(original.messages, before)
    assert.ok(isAgentLoopRequest(sent.at(-1)))
    return { original, request: sent.at(-1), restarts }
  }
  return { rt, rows, run, ref, value, listeners, reads: () => reads }
}

for (const offloaded of [false, true]) test(`native vision annotates ${offloaded ? 'offloaded' : 'live'} images once and keeps the same text next turn`, async t => {
  const f = await fixture(t)
  const first = await f.run(f.rows(undefined, offloaded))
  assert.equal(first.restarts, 2)
  const blocks = first.request.messages[0].content
  assert.equal(blocks.length, 2)
  assert.match(blocks[1].text, /^\[Saved picture sha256:[a-f0-9]{12}: your read-only copy/)
  assert.ok(blocks[1].text.includes(JSON.stringify('a"`picture.png')))
  assert.ok(!blocks[1].text.includes('\n'))
  const again = await f.run(first.request.messages)
  assert.equal(again.restarts, 1)
  assert.equal(again.request.messages, first.request.messages)
  const fresh = await f.run(f.rows(undefined, offloaded))
  assert.equal(fresh.request.messages[0].content[1].text, blocks[1].text)
  assert.equal(f.reads(), 1)
})

test('text-only routes keep OCR wrapper and saved path; offloaded-only rows terminate too', async t => {
  const f = await fixture(t)
  const result = await f.run(f.rows(), 'native', 'text')
  assert.equal(result.restarts, 2)
  assert.match(result.request.messages[0].content[0].text, /Vision read it for you.*\nA picture\./)
  assert.match(result.request.messages[0].content[1].text, /^\[Saved picture/)
  assert.equal((await f.run(f.rows(undefined, true), 'native', 'text')).restarts, 2)
})

for (const provider of ['acp-claude', 'acp-codex', 'local-test']) test(`${provider} saves the person's copy without adding path text`, async t => {
  const f = await fixture(t)
  const result = await f.run(f.rows(), provider)
  assert.equal(result.request, result.original)
  assert.equal(f.reads(), 1)
  assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), true)
  const forwarded = f.rows({ kind: 'bot', form: 'relay', role: 'request', senderSessionId: 'sender', forwarded: { v: 1 } })
  const sent = await f.run(forwarded, provider)
  assert.equal(sent.request.messages[0].content.length, provider.startsWith('acp-') ? 2 : 1)
})

test('Remote Hermes makes no copy or annotation', async t => {
  const f = await fixture(t)
  const result = await f.run(f.rows(), 'hermes-remote')
  assert.equal(result.request, result.original)
  assert.equal(f.reads(), 0)
})

test('no folder keeps the existing OCR response exactly', async t => {
  const f = await fixture(t, { noFolder: true })
  const rows = f.rows()
  rows[0].content[0].attachment = { ...f.ref, name: 'shot.png' }
  const result = await f.run(rows, 'native', 'text')
  assert.deepEqual(result.request.messages, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[Image "shot.png". You cannot see images, so Vision read it for you:]\nA picture.\n[End of image "shot.png"]' }] }])
})

test('secrets and images listeners together redact a folder path without an annotation loop', async t => {
  const f = await fixture(t, { secret: true })
  const result = await f.run(f.rows())
  assert.equal(result.restarts, 3)
  assert.doesNotMatch(JSON.stringify(result.request), new RegExp(f.value))
  assert.match(result.request.messages[0].content[1].text, /\[secret:FOLDER_TOKEN\]/)
  assert.equal(result.request.messages[0].content.length, 2)
})

test('copying is awaited before the first model tool call', async t => {
  const f = await fixture(t)
  const save = f.rt.sharedUploads.save
  // withPaths closes over save: stall the underlying attachment read instead.
  const get = f.rt.ctx.get
  let release, reading
  const started = new Promise(resolve => { reading = resolve })
  f.rt.ctx.get = name => name === 'attachments' ? {
    readImage: async (...args) => {
      reading()
      await new Promise(resolve => { release = resolve })
      return get(name).readImage(...args)
    },
  } : get(name)
  let finished = false
  const run = f.run(f.rows()).then(result => { finished = true; return result })
  await started
  assert.equal(finished, false)
  release()
  const result = await run
  const text = result.request.messages[0].content[1].text
  const saved = await save(f.ref, { sessionId: 'a' })
  assert.ok(text.includes(JSON.stringify(saved.path)))
  assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), true)
})

test('a redacted saved-picture prefix stays idempotent without replacing the input array', async t => {
  const f = await fixture(t)
  const rows = f.rows()
  rows[0].content.push({ type: 'text', text: '[Saved picture sha256:[secret:REDACTED]]' })
  const result = await f.run(rows)
  assert.equal(result.request.messages, rows)
  assert.equal(result.restarts, 1)
  assert.equal(f.reads(), 1)
})

for (const provider of ['native', 'acp-claude', 'acp-codex', 'local-test']) {
  test(`${provider} grants retry and group images with only the route’s permitted annotation`, async t => {
    const f = await fixture(t)
    for (const source of [{ kind: 'retry' }, { kind: 'bot', form: 'relay', role: 'room', roomId: 'test-group' }]) {
      const result = await f.run(f.rows(source, true), provider)
      assert.equal(result.request.messages[0].content.length, provider === 'native' ? 2 : 1)
      assert.equal(await f.rt.sharedUploads.holds('a', f.ref.attachmentId.slice(7)), true)
    }
    assert.equal(f.reads(), 1)
  })
}

test('missing session, own requests and text-only messages bypass loading or copying', async t => {
  const f = await fixture(t)
  f.rt.load = () => assert.fail('bypass must not load')
  f.rt.sharedUploads.withPaths = () => assert.fail('bypass must not copy')
  const listener = f.listeners.get('llm/stream')[0]
  for (const options of [{ messages: f.rows() }, { sessionId: 'a', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }]) {
    assert.equal(listener(options, () => 'passed'), 'passed')
  }
  f.rt.ownRequest = () => true
  assert.equal(listener({ sessionId: 'a', messages: f.rows() }, () => 'passed'), 'passed')
  assert.equal(f.reads(), 0)
})

test('an image request with no owning Bot cannot create a grant or file', async t => {
  const f = await fixture(t)
  f.rt.botOfSession = () => undefined
  const result = await f.run(f.rows())
  assert.equal(result.request, result.original)
  assert.equal(f.reads(), 0)
  assert.equal(f.rt.sharedUploads.grantedTo('a'), undefined)
})
