import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RETIRED_MAX } from '../src/host/acp.js'
import { savedPathsOf } from '../src/host/agent-image.js'
import { IMAGE_TITLE } from '../src/host/image.js'
import { callArguments, mirrorTool } from '../src/host/tool.js'
import { CANCELLED, OPTIONS, picked, probe, soon } from './support/state-probe.js'

test('1250 prompts bound retired calls and retain paths and permission precedence without payloads', async t => {
  const noted = []
  const asked = []
  const p = probe(t, { dshTools: true, onToolCall: tool => noted.push(tool.id), onAsked: tool => asked.push(tool.id) })
  assert.equal(RETIRED_MAX, 1024)
  const bytes = 'large base64 payload'.repeat(100)
  for (let turn = 0; turn < 1250; turn++) {
    const end = p.begin()
    assert.equal(p.run.turn.size, 0)
    assert.ok(p.run.tools.size <= RETIRED_MAX)
    const image = `image-${turn}`
    const refused = `refused-${turn}`
    const bridge = `bridge-${turn}`
    await p.see(image, {
      title: IMAGE_TITLE,
      rawInput: { prompt: bytes },
      rawOutput: { result: bytes, savedPath: `/tmp/drawn-${turn}.png`, saved_path: `/tmp/alternate-${turn}.png`, nested: { data: bytes } },
      locations: [{ path: '/tmp/source' }],
      content: [
        { type: 'content', content: { type: 'image', uri: `/tmp/wrapped-${turn}.png`, data: bytes, mimeType: 'image/png' } },
        { type: 'image', uri: `/tmp/direct-${turn}.png`, data: bytes },
        { type: 'image', data: bytes },
        { type: 'content', content: { type: 'text', text: bytes } },
      ],
    })
    const question = p.ask(image)
    p.run.tools.get(image).permission.answer(picked('yes'))
    assert.deepEqual(await soon(question), picked('yes'))
    p.run.tools.get(image).listeners.add(() => {})
    await p.see(refused, { name: 'Read', rawInput: { path: bytes } })
    p.run.refuse(refused, false)
    await p.see(bridge, { name: 'mcp__dsh__bash', rawInput: { command: bytes } })
    // A remembered refusal must not outrank the bridge's own allowance.
    p.run.refuse(bridge, false)
    assert.deepEqual(p.run.turn, new Set([image, refused, bridge]))
    assert.ok(p.run.tools.size <= RETIRED_MAX + 3)
    await end()
  }
  assert.equal(p.run.tools.has('image-0'), false, 'oldest retired identities are evicted')
  assert.equal(p.run.tools.size, RETIRED_MAX + 3)
  const old = p.run.tools.get('image-1200')
  assert.equal(old.retired, true)
  assert.deepEqual(old.rawOutput, { savedPath: '/tmp/drawn-1200.png', saved_path: '/tmp/alternate-1200.png' })
  assert.deepEqual(old.content, [
    { type: 'content', content: { type: 'image', uri: '/tmp/wrapped-1200.png' } },
    { type: 'image', uri: '/tmp/direct-1200.png' },
  ])
  for (const tool of p.run.tools.values()) {
    if (!tool.retired) continue
    for (const key of ['rawInput', 'output', 'locations', 'permission', 'ended', 'noted']) assert.equal(key in tool, false, key)
    assert.equal(tool.listeners.size, 0)
    assert.equal(JSON.stringify(tool).includes(bytes), false)
    assert.equal(tool.unanswerable, true)
  }
  const paths = savedPathsOf(p.run.tools.values())
  for (const path of ['/tmp/drawn-1200.png', '/tmp/wrapped-1200.png', '/tmp/direct-1200.png']) assert.ok(paths.includes(path))
  const end = p.begin()
  const snapshot = structuredClone(old)
  const counts = [noted.length, asked.length]
  for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
    for (const toolCallId of ['image-1200', 'refused-1200', 'bridge-1200']) {
      await p.run.onUpdate({ sessionUpdate, toolCallId, name: 'Write', title: 'late title', rawInput: { data: bytes }, rawOutput: { result: bytes } })
    }
  }
  assert.deepEqual(p.run.queue, [])
  assert.deepEqual(p.run.turn, new Set())
  assert.deepEqual(old, snapshot)
  assert.deepEqual(await soon(p.ask('image-1200')), CANCELLED)
  assert.deepEqual(await soon(p.ask('refused-1200')), picked('no'))
  assert.deepEqual(await soon(p.ask('bridge-1200')), picked('yes'))
  assert.deepEqual(await soon(p.ask('bridge-1200', { options: OPTIONS.filter(option => option.kind === 'allow_always') })), picked('always'))
  assert.deepEqual(await soon(p.ask('bridge-1200', { options: [] })), CANCELLED)
  assert.deepEqual([noted.length, asked.length], counts)
  assert.deepEqual(p.run.queue, [])
  p.run.refuse('image-1200', true)
  assert.deepEqual(await soon(p.ask('image-1200')), CANCELLED)
  await p.see('image-0')
  assert.equal(p.run.tools.get('image-0').retired, undefined, 'an evicted id is admitted as new')
  assert.deepEqual(p.run.turn, new Set(['image-0']))
  await end()
})

test('retirement replaces the record without stripping a mirror body still holding it', async t => {
  const p = probe(t)
  await p.see('old', { rawInput: { input: 'kept by body' }, content: [{ type: 'text', text: 'kept by body' }] })
  const old = p.run.tools.get('old')
  const listener = () => {}
  old.listeners.add(listener)
  const question = p.ask('old')
  const end = p.begin()
  assert.deepEqual(await soon(question), CANCELLED)
  const retired = p.run.tools.get('old')
  assert.notEqual(retired, old)
  assert.deepEqual(old.rawInput, { input: 'kept by body' })
  assert.deepEqual(old.content, [{ type: 'text', text: 'kept by body' }])
  assert.ok(old.listeners.has(listener))
  assert.equal(retired.listeners.size, 0)
  assert.deepEqual(retired.content, [])
  assert.equal('rawOutput' in retired, false)
  const mirror = mirrorTool({ runOf: () => ({ run: p.run }) })
  const answer = await soon(mirror.execute(callArguments(retired), { agent: { session: { id: 's1' } }, callId: 'stale' }))
  assert.equal(answer.status, 'failed')
  assert.equal(answer.text, 'The agent is no longer running this call.')
  const changed = t.mock.method(p.run, 'changeTool')
  await p.see('current')
  await end()
  assert.deepEqual(changed.mock.calls.map(call => call.arguments[0].id), ['current'], 'endPrompt only visits the current turn')
  assert.equal(retired.status, 'pending')
})
