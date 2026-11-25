import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { asideWorld } from './fixtures/aside-world.mjs'

const installed = (world, request = {}) => world.service.answerAside({
  provider: world.provider, model: 'default', timeoutMs: 3000,
  readPrompt: () => ({ system: 'Fixture instructions.', text: 'Fixture prompt.' }), ...request,
})
const noPrompt = world => assert.equal(world.events().filter(row => row.event === 'prompt').length, 0)

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
  assert.equal(start.cwd, session.cwd)
  assert.ok(world.fake.calls.every(call => call.cwd === session.cwd))
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
