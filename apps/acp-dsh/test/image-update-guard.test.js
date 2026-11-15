import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { drawImage, IMAGE_TITLE, REFUSED } from '../src/host/image.js'
import { CANCELLED, OPTIONS, soon } from './support/state-probe.js'

test('the image run reports each rejection without creating tools and ignores retired calls', async t => {
  let run
  // Capture the default ImageRun after the fake's config checks, before any agent starts.
  t.mock.method(AgentRun.prototype, 'start', async function () {
    run = this
    throw new Error('captured the image run')
  })
  const warnings = []
  await assert.rejects(drawImage({
    spawn: () => ({ command: process.execPath, args: [join(import.meta.dirname, '../dev/fake-image-agent.mjs')], env: { FAKE_IMAGE_MODE: 'ok', CODEX_PATH: '/fake/codex' } }),
    prompt: 'a synthetic image',
    log: message => warnings.push(message),
  }), /captured the image run/)
  assert.ok(run)
  t.after(() => run.letGo(true))
  const observed = []
  const rejected = []
  const onRejected = run.spec.onRejected
  run.spec.onRejected = what => { rejected.push(what); onRejected(what) }
  let asked = 0
  run.spec.onTool = tool => { assert.ok(tool); observed.push(tool.id) }
  run.spec.onAsked = () => { asked++ }
  run.sessionId = 'image-session'
  for (const toolCallId of [undefined, 1, '']) {
    const before = rejected.length
    assert.equal(run.seeTool({ toolCallId }), undefined)
    for (const sessionUpdate of ['tool_call', 'tool_call_update']) await run.onUpdate({ sessionUpdate, toolCallId })
    assert.deepEqual(await soon(run.onPermission({ toolCall: { toolCallId }, options: OPTIONS })), CANCELLED)
    assert.equal(rejected.length, before + 4)
  }
  assert.deepEqual(await soon(run.onPermission({ sessionId: 'foreign', toolCall: { toolCallId: 'valid' }, options: OPTIONS })), CANCELLED)
  assert.equal(rejected.length, 13)
  assert.equal(run.tools.size, 0)
  assert.deepEqual(observed, [])
  assert.equal(asked, 0)
  assert.equal(warnings.length, 1, 'the image log receives the same once-per-run warning')
  await run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'image', title: IMAGE_TITLE }, 'image-session')
  assert.deepEqual(observed, ['image'])
  assert.deepEqual(await soon(run.onPermission({ toolCall: { toolCallId: 'image' }, options: OPTIONS })), CANCELLED)
  assert.equal(asked, 0)
  assert.deepEqual(await soon(run.onPermission({ toolCall: { toolCallId: 'other' }, options: OPTIONS })), CANCELLED)
  assert.equal(asked, 1, 'a valid non-image question still refuses the draw')
  run.gone = new Promise(() => {})
  run.conn = { prompt: async () => ({ stopReason: 'end_turn' }) }
  await soon(run.prompt([{ type: 'text', text: 'next' }]))
  assert.equal(run.tools.get('image').retired, true)
  run.seeTool({ toolCallId: 'image', title: 'late', rawOutput: { result: 'bytes' } })
  await run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'image', title: 'late' })
  assert.deepEqual(observed, ['image'])
  assert.equal(run.tools.get('image').title, IMAGE_TITLE)
  assert.equal(run.tools.get('image').rawOutput, undefined)
  assert.equal(rejected.length, 13, 'retired image calls are ignored without a new refusal')
})

for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
  for (const [label, payload, sessionId] of [
    ['empty id', { toolCallId: '' }],
    ['missing id', {}],
    ['numeric id', { toolCallId: 1 }],
    ['foreign session', { toolCallId: 'foreign-call' }, 'foreign'],
  ]) {
    test(`draw refuses a ${sessionUpdate} with ${label}`, async t => {
      await refusedDraw(t, run => run.onUpdate({ sessionUpdate, ...payload }, sessionId))
    })
  }
}

for (const [label, params] of [
  ['missing id', { toolCall: {} }],
  ['foreign session', { sessionId: 'foreign', toolCall: { toolCallId: 'foreign-call' } }],
]) {
  test(`draw refuses a permission with ${label} and cancels its answer`, async t => {
    await refusedDraw(t, async run => {
      assert.deepEqual(await run.onPermission({ ...params, options: OPTIONS }), CANCELLED)
    })
  })
}

async function refusedDraw(t, rejectTraffic) {
  const prompt = AgentRun.prototype.prompt
  // Inject malformed traffic at the run boundary; the fake still supplies a valid image.
  t.mock.method(AgentRun.prototype, 'prompt', async function (...args) {
    const prompting = prompt.apply(this, args)
    await rejectTraffic(this)
    return prompting
  })
  await assert.rejects(drawImage({
    spawn: () => ({ command: process.execPath, args: [join(import.meta.dirname, '../dev/fake-image-agent.mjs')], env: { FAKE_IMAGE_MODE: 'ok', CODEX_PATH: '/fake/codex' } }),
    prompt: 'a synthetic image',
  }), error => error.code === REFUSED && /Codex tried to do something other than draw/.test(error.message))
}
