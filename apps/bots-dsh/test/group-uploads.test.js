import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { immediate, until } from './until.js'

const file = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'x.txt',
  mediaType: 'text/plain', bytes: 12 }
const image = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'x.png',
  mediaType: 'image/png', bytes: 24, width: 1, height: 1 }
const content = [{ type: 'text', text: 'Read the markers' },
  { type: 'file', attachment: file }, { type: 'image', attachment: image }]
const settle = check => until(check, { poll: immediate })

// The group-work host pattern, using its fake context and event-driven member replies.
async function start(t, provider) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-upload-'))
  const state = {
    version: 1, mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1,
        model: `${provider}/default` },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin',
      admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  writeFileSync(join(home, 'ocr.json'), JSON.stringify({
    [image.attachmentId]: { text: 'PNG OCR marker', model: 'Vision' },
  }))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) {
      const calls = []
      const nextTurn = []
      agents.set(id, { id, session: { id }, calls, inbox: { nextTurn, nextStep: [] },
        model: { current: () => ({ provider, model: 'default' }) },
        ctx: { tools: { restrict: () => () => {} } },
        followup: row => { calls.push(row); nextTurn.push(row) },
        steer: row => calls.push(row), cancel() {},
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [],
      resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }),
      resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
  })
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, exec = {}) => ctx.registeredTools.get(name).execute({}, exec)
  await tool('list_bots', { agent: { id: 'a' } })
  const relay = async message => {
    emit('r1', 'user/message', message)
    const stop = new AbortController()
    t.after(() => stop.abort())
    const round = tool('group_relay', { agent: { id: 'r1' }, callId: 'c1', signal: stop.signal })
    await settle(() => agentOf('ga').calls.length === 1)
    const delivered = agentOf('ga').calls[0]
    emit('ga', 'turn/start', { turn: 1 })
    emit('ga', 'user/message', delivered)
    emit('ga', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
    emit('ga', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await round
    return delivered
  }
  return { relay, rt: ctx.get('omniTeam'), agentOf, emit, tool }
}

test('group TXT and PNG pointers reach an ACP-route member in block order', async t => {
  const h = await start(t, 'acp-codex')
  const message = await h.relay({ id: 'person-row', source: { kind: 'user' }, content })
  const items = [file, image].map((ref, i) => ({ messageId: 'person-row',
    blockIndex: i + 1, attachmentId: ref.attachmentId, kind: i === 0 ? 'file' : 'image' }))
  assert.deepEqual(message.source.uploads, { v: 1, roomId: 'r1', items })
  assert.deepEqual(h.rt.roomOf('r1').log[0].uploads, items)
  assert.equal(h.agentOf('ga').model.current().provider, 'acp-codex')
  // A member's relay also holds the picture itself (v0.3.6 sends it beside its reading); the
  // ACP adapter keeps the text and takes the pointers.
  assert.deepEqual(message.content.map(block => block.type), ['text', 'image', 'file'])
  assert.match(message.content[0].text, /PNG OCR marker/)
})

test('native group content stays byte-equal to the relay without provenance', async t => {
  const h = await start(t, 'deepseek-official')
  const baseline = await start(t, 'deepseek-official')
  const message = await h.relay({ id: 'person-row', source: { kind: 'user' }, content })
  const before = await baseline.relay({ source: { kind: 'user' }, content })
  assert.equal(JSON.stringify(message.content), JSON.stringify(before.content))
  assert.deepEqual(message.content.map(block => block.type), ['text', 'image', 'file'])
  assert.equal(before.source.uploads, undefined)
})

test('identical file hashes retain their original block indices', async t => {
  const h = await start(t, 'acp-codex')
  const message = await h.relay({ id: 'person-row', source: { kind: 'user' }, content: [
    content[0], { type: 'file', attachment: { ...file, name: 'a.txt' } },
    { type: 'image', attachment: image, offloaded: true },
    { type: 'file', attachment: { ...file, name: 'b.txt' } },
  ] })
  assert.deepEqual(message.source.uploads.items, [1, 3].map(blockIndex => ({
    messageId: 'person-row', blockIndex, attachmentId: file.attachmentId, kind: 'file',
  })))
  assert.deepEqual(message.content.filter(block => block.type === 'file')
    .map(block => block.attachment.name), ['a.txt', 'b.txt'])
})

test('a Bot post with a file carries no upload pointers', async t => {
  const h = await start(t, 'acp-codex')
  const message = await h.relay({ id: 'bot-row', source: { kind: 'bot', role: 'post',
    senderSessionId: 'b', senderName: 'Writer' }, content: content.slice(0, 2) })
  assert.equal(message.source.uploads, undefined)
  assert.deepEqual(message.content.map(block => block.type), ['text', 'file'])
})

test('an offloaded group image is not listed or read', async t => {
  const h = await start(t, 'acp-codex')
  const message = await h.relay({ id: 'person-row', source: { kind: 'user' },
    content: content.map(block => block.type === 'image' ? { ...block, offloaded: true } : block) })
  assert.deepEqual(message.source.uploads, { v: 1, roomId: 'r1', items: [
    { messageId: 'person-row', blockIndex: 1, attachmentId: file.attachmentId, kind: 'file' },
  ] })
  assert.doesNotMatch(message.content[0].text, /PNG OCR marker/)
})

// A message that comes in while a round runs joins that round (groups.js joinRound) and is
// written by another line of code than the round's first message.
test('a file sent while a round runs keeps its pointer and reaches the member', async t => {
  const h = await start(t, 'acp-codex')
  const stop = new AbortController()
  t.after(() => stop.abort())
  const member = h.agentOf('ga')
  h.emit('r1', 'user/message', { id: 'first-row', source: { kind: 'user' }, content: [content[0]] })
  const round = h.tool('group_relay', { agent: { id: 'r1' }, callId: 'c1', signal: stop.signal })
  await settle(() => member.calls.length === 1)
  h.emit('ga', 'turn/start', { turn: 1 })
  h.emit('ga', 'user/message', member.calls[0])
  // The person writes again before the member has answered.
  h.emit('r1', 'user/message', { id: 'second-row', source: { kind: 'user' },
    content: [{ type: 'text', text: 'And this file' }, { type: 'file', attachment: file }] })
  const joined = h.tool('group_relay', { agent: { id: 'r1' }, callId: 'c2', signal: stop.signal })
  const items = [{ messageId: 'second-row', blockIndex: 1, attachmentId: file.attachmentId, kind: 'file' }]
  await settle(() => h.rt.roomOf('r1').log.some(line => line.text?.includes('And this file')))
  assert.deepEqual(h.rt.roomOf('r1').log.find(line => line.text?.includes('And this file')).uploads, items)
  h.emit('ga', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
  h.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => member.calls.length === 2)
  assert.deepEqual(member.calls[1].source.uploads, { v: 1, roomId: 'r1', items })
  h.emit('ga', 'turn/start', { turn: 2 })
  h.emit('ga', 'user/message', member.calls[1])
  h.emit('ga', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
  h.emit('ga', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await Promise.all([round, joined])
})
