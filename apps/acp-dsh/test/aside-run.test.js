import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { asideWorld } from './fixtures/aside-world.mjs'

const installed = (world, request = {}) => world.service.answerAside({
  provider: world.provider, model: 'default', timeoutMs: 3000,
  readPrompt: () => ({ system: 'Fixture instructions.', text: 'Fixture prompt.' }), ...request,
})
const noPrompt = world => assert.equal(world.events().filter(row => row.event === 'prompt').length, 0)

// The aside removes its scratch directory before returning.
// Resolve its surviving parent and keep the full scratch directory name.
const resolved = path => join(realpathSync(dirname(path)), basename(path))

test('E2b registered ACP aside opens and closes a checked scratch Codex session', async t => {
  const world = asideWorld(t, { system: true, reply: { chunks: ['Fixture ', 'response.'] } })
  await world.ready()
  assert.equal(typeof world.service.answerAside, 'function', 'registered answerAside service')
  assert.deepEqual(await installed(world), { text: 'Fixture response.', model: 'gpt-6.2-sol' })
  const [start, session, mode, prompt, close] = world.events()
  assert.deepEqual([start.event, session.event, mode.event, prompt.event, close.event],
    ['start', 'new', 'mode', 'prompt', 'close'])
  assert.equal(world.contexts[0].nativeOff, true)
  assert.equal(world.contexts[0].cwd, session.cwd)
  assert.equal(resolved(start.cwd), resolved(session.cwd))
  assert.ok(world.fake.calls.every(call => resolved(call.cwd) === resolved(session.cwd)))
  assert.deepEqual(session.mcpServers, [])
  assert.equal(session.systemPrompt, undefined)
  assert.equal(mode.modeId, 'read-only')
  assert.deepEqual(prompt.prompt.map(block => block.text), ['Fixture instructions.', 'Fixture prompt.'])
  assert.deepEqual(world.lookups, [])
  assert.equal(existsSync(session.cwd), false)
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(start.pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await delay(10)
  }
  assert.fail('hidden ACP process still alive')
})

test('Codex cwd, resolved default and read-only profile are checked before dispatch', async t => {
  for (const control of [{ transform: launch => ({ ...launch, checkedCwd: '/unmatched' }) },
    { start: 'gpt-5.5' }, { permissionMode: 'workspace-write' }]) {
    const world = asideWorld(t, control)
    await world.ready()
    await assert.rejects(installed(world, { readPrompt: () => assert.fail('opened private text') }),
      { code: 'acp/aside-unavailable' })
    noPrompt(world)
  }
  const world = asideWorld(t, {
    permissionMode: 'permission-profile:automagik-read-fixture',
    transform: launch => ({ ...launch,
      profileModes: { 'read-only': 'permission-profile:automagik-read-fixture' } }),
  })
  await world.ready()
  await installed(world)
  assert.equal(world.events().find(row => row.event === 'mode').modeId,
    'permission-profile:automagik-read-fixture')
})

test('R2-3 conflicting Codex current-model reports block private text', async t => {
  const world = asideWorld(t, { reply: { sessionModel: 'gpt-5.5' } })
  await world.ready()
  let reads = 0
  const result = await installed(world, { readPrompt: () => {
    reads++
    return { system: 'Fixture instructions.', text: 'Fixture prompt.' }
  } }).catch(error => error.code)
  assert.ok(world.events().some(row => row.event === 'new'), 'the fake session reported both models')
  assert.deepEqual({ result, reads, prompts: world.events().filter(row => row.event === 'prompt').length },
    { result: 'acp/aside-unavailable', reads: 0, prompts: 0 })
  world.setReply({ sessionModel: 'gpt-6.2-sol' })
  assert.deepEqual(await installed(world), { text: 'Fixture response.', model: 'gpt-6.2-sol' })
})

test('Stage 6 admits Codex reports that agree after the protocol effort suffix', async t => {
  const world = asideWorld(t, { reply: { sessionModel: 'gpt-6.2-sol[high]' } })
  await world.ready()
  const result = await installed(world).catch(error => error.code)
  const prompts = world.events().filter(row => row.event === 'prompt').length
  assert.deepEqual({ result, prompts }, {
    result: { text: 'Fixture response.', model: 'gpt-6.2-sol' }, prompts: 1,
  })
})

test('R2-3 genuine conflict with an effort suffix stays refused after selecting a model', async t => {
  const world = asideWorld(t, { start: 'gpt-5.5', reply: { sessionModel: 'gpt-6.2-sol[high]' } })
  await world.ready()
  let reads = 0
  await assert.rejects(installed(world, { model: 'gpt-6.2-sol', readPrompt: () => {
    reads++
    return { system: 'Fixture instructions.', text: 'Fixture prompt.' }
  } }), { code: 'acp/aside-unavailable' })
  assert.ok(world.events().some(row => row.event === 'mode'), 'selection and mode setup completed')
  assert.equal(reads, 0)
  noPrompt(world)
})

test('R2-5 Codex accepts legacy read-only with the checked model and scratch cwd', async t => {
  const world = asideWorld(t, {
    transform: launch => ({ ...launch,
      profileModes: { 'read-only': 'permission-profile:automagik-read-fixture' } }),
  })
  await world.ready()
  const result = await installed(world, { model: 'gpt-6.2-sol' }).catch(error => error.code)
  const session = world.events().find(row => row.event === 'new')
  assert.equal(session.cwd, world.contexts[0].cwd)
  assert.ok(world.fake.calls.length > 0 && world.fake.calls.every(call => resolved(call.cwd) === resolved(session.cwd)))
  assert.deepEqual({ result, modes: world.events().filter(row => row.event === 'mode').map(row => row.modeId),
    models: world.events().filter(row => row.event === 'prompt').map(row => row.model) },
  { result: { text: 'Fixture response.', model: 'gpt-6.2-sol' }, modes: ['read-only'], models: ['gpt-6.2-sol'] })
})

test('omp uses native-off arguments and sends negotiated session creation instructions', async t => {
  const world = asideWorld(t, { provider: 'acp-omp', system: true })
  await installed(world)
  await installed(world)
  const events = world.events()
  const starts = events.filter(row => row.event === 'start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].cwd, starts[1].cwd)
  for (const start of starts) {
    assert.deepEqual(start.args.slice(0, 4), ['acp', '--no-tools', '--no-extensions', '--no-lsp'])
    assert.equal(existsSync(start.cwd), false)
  }
  const openings = events.filter(row => row.event === 'new')
  assert.equal(openings.length, 2)
  for (const session of openings) {
    assert.deepEqual(session.mcpServers, [])
    assert.equal(session.systemPrompt.content[0].text, 'Fixture instructions.')
  }
  assert.deepEqual(events.filter(row => row.event === 'prompt').map(row => row.prompt.length), [1, 1])
  assert.equal(events.filter(row => row.event === 'close').length, 2)
})

test('Antigravity uses the checked executable version and OFF launch', async t => {
  const good = asideWorld(t, { provider: 'acp-antigravity' })
  await installed(good)
  const events = good.events()
  assert.deepEqual(events.find(row => row.event === 'start').args.slice(0, 2), ['acp', '--agent'])
  const off = events.find(row => row.event === 'agy-off')
  assert.match(off.agent, /tools: \[\]/)
  assert.match(off.agent, /commandExecutionPolicy: "off"/)
  assert.match(JSON.stringify(off.settings), /mcp\(\*\)/)
  assert.equal(events.filter(row => row.event === 'prompt').length, 1)
  const wrong = asideWorld(t, { provider: 'acp-antigravity', version: '1.5.17' })
  await assert.rejects(installed(wrong, { readPrompt: () => assert.fail('opened private text') }),
    { code: 'acp/aside-unavailable' })
  assert.deepEqual(wrong.events().map(row => row.event), ['start'])
  const refused = asideWorld(t, { provider: 'acp-antigravity', reply: { agySettingsFailed: true } })
  await assert.rejects(installed(refused, { readPrompt: () => assert.fail('opened private text') }),
    { code: 'acp/aside-unavailable' })
  assert.ok(refused.events().some(row => row.event === 'agy-off'))
  noPrompt(refused)
})

test('Claude, Hermes and custom ACP routes refuse before discovery or private text', async t => {
  for (const provider of ['acp-claude', 'acp-hermes', 'acp-custom']) {
    const world = asideWorld(t, { provider })
    await assert.rejects(async () => installed(world, {
      admit: () => assert.fail('admission started'),
      readPrompt: () => assert.fail('opened private text'),
    }), { code: 'acp/aside-unavailable' })
    assert.deepEqual(world.events(), [])
  }
})

test('permissions and unsolicited tools fail closed, with the hidden session closed', async t => {
  for (const reply of [{ ask: true }, { drift: true }]) {
    const world = asideWorld(t, { provider: 'acp-omp', reply })
    await assert.rejects(installed(world), { code: 'acp/aside-tool-refused' })
    const events = world.events()
    if (reply.ask) {
      assert.equal(events.find(row => row.event === 'permission').answer.optionId, 'no')
    }
    assert.ok(events.some(row => row.event === 'close'))
    assert.ok(events.every(row => row.event !== 'tool-ran'))
  }
})

test('structured quota and oversize answers fail with no echoed content', async t => {
  const world = asideWorld(t, { reply: { quota: true } })
  await world.ready()
  await assert.rejects(installed(world), {
    code: 'acp/aside-quota', message: 'The account reached its usage limit.',
  })
  world.setReply({ chunks: ['🫖'.repeat(12_000), '🫖'.repeat(5_000)] })
  await assert.rejects(installed(world), { code: 'acp/aside-cut-off' })
  assert.equal(world.events().filter(row => row.event === 'close').length, 2)
})

test('account consent and account change during setup yield zero hidden prompts', async t => {
  const denied = asideWorld(t, { confirm: false })
  await assert.rejects(installed(denied), { code: 'acp/aside-signed-out' })
  assert.deepEqual(denied.events(), [])
  const world = asideWorld(t)
  await world.ready()
  const preparing = Promise.withResolvers()
  const release = Promise.withResolvers()
  const pending = installed(world, {
    prepare: () => { preparing.resolve(); return release.promise },
    readPrompt: () => assert.fail('opened private text'),
  })
  const result = assert.rejects(pending, { code: 'acp/aside-signed-out' })
  await preparing.promise
  await world.service.accountSignOut(world.provider)
  release.resolve()
  await result
  noPrompt(world)
})

test('setup timeout withholds text and removes its scratch cwd', async t => {
  const world = asideWorld(t)
  await world.ready()
  // AbortSignal.timeout does not otherwise hold open a caller that has no active work.
  const keep = setTimeout(() => {}, 1_000)
  try {
    await assert.rejects(installed(world, {
      timeoutMs: 50, admit: () => new Promise(() => {}),
      readPrompt: () => assert.fail('opened private text'),
    }), { code: 'acp/aside-timeout' })
  } finally { clearTimeout(keep) }
  assert.deepEqual(world.events(), [])
})

const review = (world, request = {}) => world.service.answerReview?.({
  provider: world.provider, model: 'default', timeoutMs: 3000,
  readPrompt: () => ({ system: 'Fixture review instructions.', text: 'Fixture review prompt.' }), ...request,
})
const reviewOutcome = async (world, request) => {
  try { return await review(world, request) } catch (error) { return error.code }
}

test('2160 review purpose admits Claude Code in a fresh tools-off session', async t => {
  const world = asideWorld(t, { provider: 'acp-claude', start: 'claude-sonnet-5-5' })
  await world.service.accountConfirm(world.provider)
  assert.deepEqual(await reviewOutcome(world, { model: 'claude-sonnet-5-5' }),
    { text: 'Fixture response.', model: 'claude-sonnet-5-5' })
  const events = world.events()
  const prompt = events.find(row => row.event === 'prompt'
    && row.prompt.at(-1)?.text === 'Fixture review prompt.')
  assert.ok(prompt, 'the Claude review prompt was dispatched')
  const opened = events.find(row => row.event === 'new' && row.pid === prompt.pid)
  assert.deepEqual(opened.mcpServers, [])
  assert.deepEqual(opened.meta, { disableBuiltInTools: true, claudeCode: { options: { settingSources: [] } } })
})

test('2160 review purpose keeps the crossing chunk UTF-8 prefix without crediting the answer', async t => {
  const prefix = 'a'.repeat(65529)
  const world = asideWorld(t, { provider: 'acp-omp', reply: { chunks: [prefix, 'ok🫖€'] } })
  const seen = []
  assert.equal(await reviewOutcome(world, { onPartial: text => seen.push(text) }), 'acp/aside-cut-off')
  assert.equal(seen.length, 1)
  assert.equal(Buffer.byteLength(seen[0]), 65535)
  assert.ok(seen[0] === prefix + 'ok🫖')
})

test('2160 review purpose keeps received text on abort and waits for partial handling', async t => {
  const run = new AbortController()
  const arrived = Promise.withResolvers()
  const complete = Promise.withResolvers()
  const world = asideWorld(t, { provider: 'acp-omp', reply: { chunks: ['already ', 'received'] } })
  const onUpdate = AgentRun.prototype.onUpdate
  t.mock.method(AgentRun.prototype, 'onUpdate', function (update, sessionId) {
    const handled = onUpdate.call(this, update, sessionId)
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.text === 'received') run.abort()
    return handled
  })
  t.after(complete.resolve)
  let settled = false
  const result = reviewOutcome(world, { signal: run.signal, async onPartial(text) {
    arrived.resolve(text)
    await complete.promise
  } }).then(value => { settled = true; return value })
  assert.equal(await Promise.race([arrived.promise, result]), 'already received')
  assert.equal(settled, false)
  complete.resolve()
  assert.equal(await result, 'acp/aside-stopped')
})

test('2160 review purpose delivers text before tool refusal, and tool-only yields no text', async t => {
  for (const withText of [true, false]) {
    const world = asideWorld(t, { provider: 'acp-omp',
      reply: withText ? { chunks: ['Fixture reply.'], textThenTool: true } : { chunks: [], drift: true } })
    const received = []
    assert.equal(await reviewOutcome(world, { onPartial: text => received.push(text) }), 'acp/aside-tool-refused')
    assert.deepEqual(received, withText ? ['Fixture reply.'] : [])
    assert.ok(world.events().every(row => row.event !== 'tool-ran'))
  }
})

test('2160 review binding refuses account-ID drift with the same generation', async t => {
  const world = asideWorld(t)
  await world.ready()
  const accountGeneration = world.service.asideAccountGeneration(world.provider)
  const binding = {}
  const request = { accountGeneration, binding }
  assert.equal((await reviewOutcome(world, request))?.model, 'gpt-6.2-sol')
  await world.signInAs('different-fixture-account')
  assert.equal(world.service.asideAccountGeneration(world.provider), accountGeneration)
  assert.equal(await reviewOutcome(world, request), 'acp/aside-signed-out')
  assert.equal(world.events().filter(row => row.event === 'prompt').length, 1)
})
