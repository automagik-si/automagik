import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { install as imagesInstall, offloadTargets } from '../src/host/images.js'
import { assembleLlmStream } from '../src/host/models.js'

test('offloadTargets selects live images from prior user and tool messages', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'user/message' },
    { type: 'user/message' },
  ]
  const messages = new Map([
    [events[0], { content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ] }],
    [events[1], { content: [{ type: 'image', attachment: { attachmentId: 'ignored' } }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'd' } }] }],
    [events[3], { content: [{ type: 'text', text: 'no image' }] }],
    [events[4], { content: [{ type: 'image', attachment: { attachmentId: 'new' } }] }],
  ])
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
  }

  assert.deepEqual(offloadTargets(session, 4), [
    { seq: 0, imageIndexes: [0, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
})

test('image rewrites preserve only existing agent loop marks on a text-only route', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const attachment = { attachmentId: 'sha256:abcdef1234567890', name: 'shot.png' }
  writeFileSync(join(home, 'ocr.json'), JSON.stringify({
    [attachment.attachmentId]: { text: 'A welcome banner.', model: 'Vision' },
  }))
  const listeners = {}
  const streamed = []
  const ctx = {
    on: (name, listener) => { listeners[name] = listener },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream(options) {
        streamed.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  imagesInstall({
    ctx, home,
    config: { textOnlyModels: ['acp/agent'] },
    ownRequest: () => false,
    load: async () => {},
    roomOf: () => undefined,
  })
  const marked = markAgentLoopRequest({
    provider: 'acp', model: 'agent', sessionId: 'b2',
    system: [{ type: 'text', text: 'Describe the image.' }],
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  })
  const freeze = (node) => {
    if (node === null || typeof node !== 'object') return
    for (const child of Object.values(node)) freeze(child)
    Object.freeze(node)
  }
  const assertFrozen = (node) => {
    if (node === null || typeof node !== 'object') return
    assert.ok(Object.isFrozen(node))
    for (const child of Object.values(node)) assertFrozen(child)
  }
  freeze(marked)
  const unmarked = structuredClone(marked)
  for (const [original, expected] of [[marked, true], [unmarked, false]]) {
    const before = structuredClone(original)
    const events = []
    const next = () => assert.fail('a text-only route must convert the image before dispatch')
    for await (const event of listeners['llm/stream'](original, next)) events.push(event)
    assert.deepEqual(events, [{ type: 'finish', reason: { kind: 'stop' } }])
    const sent = streamed.at(-1)
    assert.notEqual(sent, original)
    assert.equal(isAgentLoopRequest(sent), expected)
    assert.equal(Object.isFrozen(sent), expected)
    if (expected) {
      assertFrozen(sent)
      assert.throws(() => { sent.model = 'changed' }, TypeError)
    }
    assert.deepEqual(sent.messages, [{ role: 'user', content: [{
      type: 'text',
      text: '[Image "shot.png". You cannot see images, so Vision read it for you:]\n'
        + 'A welcome banner.\n[End of image "shot.png"]',
    }] }])
    assert.equal(sent.provider, original.provider)
    assert.equal(sent.model, original.model)
    assert.equal(sent.sessionId, original.sessionId)
    assert.deepEqual(original, before)
  }
  assert.equal(streamed.length, 2)
})

test('image OCR retries transient TRANSPORT failures instead of caching a 2-minute failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let calls = 0
  const ctx = {
    on: () => () => {},
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'Image: Retry banner.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    warn: () => {},
    catalog: async () => [{ ref: 'deepseek-account/deepseek-flash', name: 'DeepSeek-V4.1-Flash', input: ['text', 'image'] }],
    defaultRef: () => 'deepseek-account/deepseek-flash',
    isLocalAgentRef: () => false,
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)
  const [line] = await rt.imagesForGroup([{ attachmentId: 'sha256:abcdef1234567890', name: 'shot.png' }], 'g1')
  assert.equal(calls, 2)
  assert.match(line, /Image: Retry banner\./)
})

test('assembleLlmStream forwards lifetime disposal signal to in-flight streams and stops on disabled retry policies', async () => {
  const lifetime = new AbortController()
  let seenSignal
  const streaming = assembleLlmStream({
    llm: {
      async *stream(options) {
        seenSignal = options.signal
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'disposed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [], signal: AbortSignal.timeout(60_000) }, { signal: lifetime.signal })
  lifetime.abort()
  const aborted = await streaming
  assert.equal(seenSignal.aborted, true)
  assert.equal(aborted.finish.kind, 'aborted')

  let disabledCalls = 0
  const disabled = await assembleLlmStream({
    llm: {
      providerRetryPolicy: () => ({ mode: 'disabled', initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      async *stream() {
        disabledCalls += 1
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [] })
  assert.equal(disabledCalls, 1)
  assert.equal(disabled.finish.kind, 'error')
})
