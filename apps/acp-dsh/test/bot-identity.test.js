import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply } from '../index.js'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'

const FAKE = join(import.meta.dirname, 'fixtures', 'identity-agent.mjs')
const identity = { name: 'Ada', role: 'Reviewer', instructions: 'Check files.' }
const text = "# Your identity\nYou are Ada, a Bot on the user's team."
  + ' Your role: Reviewer.\n\nCheck files.'
const append = value => ({ mode: 'append', content: [{ type: 'text', text: value }] })
const content = value => [{ type: 'text', text: value }]

function fixture(t, capability = true) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-identity-'))
  const trace = join(dir, 'trace.jsonl')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const spec = {
    command: process.execPath, args: [FAKE], cwd: dir, name: 'Identity peer',
    env: {
      ...process.env, HOME: dir, USERPROFILE: dir,
      IDENTITY_TRACE: trace, IDENTITY_CAPABILITY: capability ? '1' : '0',
    },
    startMs: 5000, requestMs: 5000,
  }
  const rows = method => readFileSync(trace, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.method === method).map(row => row.params)
  return { dir, spec, rows }
}

function host(t, { provider = 'acp-claude', capability = true, profiles } = {}) {
  const f = fixture(t, capability)
  const bots = profiles ?? new Map([['ada', { ...identity }]])
  const sessions = new Map(['ada', 'someone', 'unowned'].map(id => [id, {
    session: { id, header: { cwd: f.dir }, append: () => ({ seq: 1 }) },
    status: 'idle', ctx: { tools: { register: () => () => {} } },
  }]))
  const warnings = []
  const reads = []
  const ctx = {
    agents: { get: id => sessions.get(id), list: () => [...sessions.values()] },
    on: () => () => {},
    logger: { warn: message => warnings.push(message), info: message => warnings.push(message) },
    get: name => {
      if (name === 'approval') return { effectivePolicy: () => 'ask' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'read-only' }) }
      return undefined
    },
  }
  const adapter = new AcpAdapter(ctx, new Map([[provider, {
    ...AGENTS[provider], spawn: async () => f.spec,
  }]]), {
    dshTools: () => false,
    botIdentity: id => { reads.push(id); return bots.get(id) },
  })
  t.after(() => adapter.dispose())
  const step = async (id = 'ada', message = 'Hello', history = []) => {
    const messages = [...history, { role: 'user', content: content(message) }]
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      provider, model: 'default', sessionId: id, messages,
    }))) chunks.push(chunk)
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks.at(-1)))
    return adapter.live.get(id).run
  }
  return { ...f, adapter, bots, reads, warnings, step }
}

for (const provider of ['acp-claude', 'acp-codex']) {
  test(`${provider} session/new receives append identity without the tools bridge`, async t => {
    const h = host(t, { provider })
    await h.step('ada', 'Hello', [{ role: 'system', content: 'Native team rules and tools.' }])
    assert.deepEqual(h.rows('new')[0].systemPrompt, append(text))
    assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
    assert.deepEqual(h.reads, ['ada'])
    assert.ok(h.warnings.some(line => line.endsWith('Bot identity: systemPrompt')))
    assert.ok(h.warnings.every(line => !line.includes('Check files.')))
    if (AGENTS[provider].hardAsk) {
      assert.deepEqual(h.rows('new')[0]._meta, AGENTS[provider].hardAsk())
    }
  })
}

test('no identity sends no system prompt or preamble', async t => {
  for (const capability of [true, false]) {
    const h = host(t, { capability })
    await h.step('unowned')
    assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
    assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
    assert.ok(h.warnings.some(line => line.endsWith('Bot identity: none')))
  }
})

test('unsupported capability sends one preamble before replay and user content', async t => {
  const h = fixture(t, false)
  const deliveries = []
  const run = new AgentRun({
    ...h.spec, botIdentity: () => text, onIdentity: value => deliveries.push(value),
  })
  t.after(() => run.dispose())
  await run.start()
  const first = [...content('Replay'), ...content('Hello')]
  await run.prompt(first)
  await run.prompt(content('Again'))
  await run.fork({ cwd: h.dir, mcpServers: [] })
  await run.prompt(content('After fork'))
  assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
  assert.equal(Object.hasOwn(h.rows('fork')[0], 'systemPrompt'), false)
  assert.deepEqual(h.rows('prompt').map(row => row.prompt), [
    [...content(text), ...first], content('Again'), content('After fork'),
  ])
  assert.deepEqual(first, [...content('Replay'), ...content('Hello')])
  assert.deepEqual(deliveries, ['preamble'])
})

test('append preserves existing session metadata and tool-refresh fork identity', async t => {
  const h = fixture(t)
  let current = text
  const meta = { disableBuiltInTools: true, custom: { enabled: true } }
  const run = new AgentRun({
    ...h.spec, refresh: AGENTS['acp-codex'].refresh, sessionMeta: meta,
    botIdentity: () => current,
  })
  t.after(() => run.dispose())
  await run.start()
  await run.prompt(content('Hello'))
  current = 'Edited instructions.'
  await run.fork({ cwd: h.dir, mcpServers: [] })
  await run.prompt(content('After fork'))
  assert.deepEqual(h.rows('new')[0]._meta, meta)
  assert.deepEqual(h.rows('fork')[0].systemPrompt, append(text))
  assert.deepEqual(h.rows('prompt').map(row => row.prompt), [
    content('Hello'), content('After fork'),
  ])
})

test('running session keeps its identity and a fresh session reads edited text', async t => {
  const h = host(t)
  const run = await h.step()
  h.bots.get('ada').instructions = 'Read the diff.'
  assert.equal(await h.step('ada', '[Your instructions changed] Read the diff.'), run)
  assert.deepEqual(h.reads, ['ada'])
  assert.equal(h.rows('new').length, 1)
  h.adapter.endSession('ada')
  await h.step()
  assert.deepEqual(h.reads, ['ada', 'ada'])
  const edited = text.replace('Check files.', 'Read the diff.')
  assert.deepEqual(h.rows('new')[1].systemPrompt, append(edited))
})

test("another Bot's identity and native tool policy never cross", async t => {
  const h = host(t, { profiles: new Map([
    ['ada', { ...identity, system: 'Native policy', capabilities: ['bash'], main: true }],
    ['someone', { name: 'Someone', instructions: 'Write notes.' }],
  ]) })
  await h.step('ada')
  await h.step('someone')
  assert.deepEqual(h.rows('new').map(row => row.systemPrompt), [
    append(text),
    append("# Your identity\nYou are Someone, a Bot on the user's team.\n\nWrite notes."),
  ])
})

test('Hermes receives no identity through this channel', async t => {
  const h = host(t, { provider: 'acp-hermes' })
  await h.step()
  assert.deepEqual(h.reads, [])
  assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
  assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
})


test('identity registrations are scoped, dispose independently and refuse competing owners', t => {
  let adapter
  let service
  const disposers = []
  const warnings = []
  const ctx = {
    llm: { registerAdapter: (_ids, value) => { adapter = value; return () => {} } },
    agents: { get: () => undefined, list: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: execute => disposers.push(execute()),
    provide: (name, value) => { if (name === 'acpAgents') service = value },
    logger: { warn: message => warnings.push(message), info: message => warnings.push(message) },
  }
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: false }, {
    store: {}, find: () => undefined,
  })
  t.after(() => { for (const dispose of disposers) dispose?.() })
  const offAda = service.botIdentity(id => id === 'ada' ? identity : undefined)
  const other = { name: 'Someone', instructions: 'Write notes.' }
  const offOther = service.botIdentity(id => id === 'someone' ? other : undefined)
  assert.equal(adapter.botIdentity('ada'), identity)
  assert.equal(adapter.botIdentity('someone'), other)
  assert.equal(adapter.botIdentity('unowned'), undefined)
  const offConflict = service.botIdentity(id => id === 'ada' ? other : undefined)
  assert.equal(adapter.botIdentity('ada'), undefined)
  assert.ok(warnings.some(line => line.includes('competing Bot identities')))
  offConflict()
  assert.equal(adapter.botIdentity('ada'), identity)
  offAda()
  assert.equal(adapter.botIdentity('ada'), undefined)
  assert.equal(adapter.botIdentity('someone'), other)
  offOther()
  assert.equal(adapter.botIdentity('someone'), undefined)
  service.botIdentity(undefined)()
})
