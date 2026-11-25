import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { Backchannel, offeredTools } from '../../acp-dsh/src/host/backchannel.js'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { install, skillPart, skillTool } from '../src/host/skill-library-call.js'
import { SKILL_NOTICE } from '../src/host/skill-message.js'

const script = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).pathname
const skill = { name: 'marker', description: 'Adds the file marker', content: 'CHECKED-ACP-BODY', hash: 'fixture-revision' }
const user = (value, ...parts) => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text: value }, ...parts],
})
const answer = provider => ({
  role: 'assistant', source: { kind: 'model', provider, model: 'default' },
  content: [{ type: 'text', text: 'Earlier answer remains' }],
})

function fixture(t, provider, { reforks = false, earlierTurns = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-acp-'))
  const trace = join(dir, 'trace.ndjson')
  const session = Session.create('bot-a')
  const agent = { id: session.id, session, ctx: { tools: { register() {} } } }
  const active = new Set()
  const other = { name: 'other_fixture_tool' }
  let mode = 'automatic'
  let afterLoad
  let offered = false
  let nextTurn = earlierTurns
  let preset = 'standard'
  const rt = {
    ctx: { on() {}, get: key => key === 'sessions' ? { get: id => id === agent.id ? agent.session : undefined } : undefined },
    load: async () => {}, selfOf: id => id === agent.id ? 'owner-a' : undefined,
    botOf: id => id === 'owner-a' ? { id } : undefined,
    skillLibrary: { active: id => id === 'owner-a' && active.has(id) ? [{ ...skill, mode }] : [] },
  }
  install(rt)
  const tool = skillTool(rt)
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, turnBoundaryOf: () => ({ lastTurn: nextTurn }) },
    get(key) {
      if (key === 'omniTeam') return rt
      if (key === 'tools') return {
        definitions: () => [tool, other],
        executable: name => [tool, other].find(definition => definition.name === name),
        execute: async ({ calls, agent: actual }) => {
          const { id, name, arguments: input } = calls[0]
          assert.equal(name, tool.name)
          const args = JSON.parse(input)
          offered = true
          const value = await tool.execute(args, { agent: actual })
          afterLoad?.()
          return { results: [{ callId: id, result: { content: tool.output.render(args, value), isError: false } }] }
        },
      }
      if (key === 'approval') return { effectivePolicy: () => 'never' }
      if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) }
      if (key === 'agentPresets') return { presetForSession: () => preset }
    },
  }
  const row = {
    name: 'Fixture agent',
    bridge: !['acp-antigravity', 'acp-omp', 'acp-hermes'].includes(provider),
    ...(reforks ? { refresh: 'fork' } : {}),
    nativeSwitch: ['acp-antigravity', 'acp-omp'].includes(provider) ? 'args' : undefined,
    disableBuiltInTools: provider === 'acp-claude',
    catalog: { models: async () => [{ id: 'default', name: 'Fixture agent' }], dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [script],
      env: { PATH: process.env.PATH, HOME: dir, FAKE_ACP_TRACE: trace } }),
  }
  const bridge = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([[provider, row]]), {
    backchannel: bridge, dshTools: () => undefined,
    teamManaged: () => ['acp-antigravity', 'acp-omp'].includes(provider),
  })
  t.after(() => { adapter.dispose(); bridge.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const run = async (messages, { record = [], reply } = {}) => {
    const session = agent.session
    const turn = ++nextTurn
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 0 })
    if (session.requestHeader() === undefined) session.append('request/header', {
      header: { config: { provider, model: 'default' }, tools: [tool].map(({ name, description, parameters }) => ({ name, description, parameters })) },
      reason: 'initial',
    })
    for (const row of record) session.append('user/message', row, { surfaceOp: 'append' })
    const chunks = []
    const options = markAgentLoopRequest({ provider, model: 'default', sessionId: agent.id, messages, signal: t.signal })
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    if (reply) session.append('assistant/message', { turn, step: 0, message: reply, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 0 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks))
    return chunks
  }
  const events = kind => readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(event => event.event === kind)
  return { active, setMode: value => { mode = value }, setPreset: value => { preset = value },
    onLoad: hook => { afterLoad = hook },
    ctx, rt, agent, run, events, adapter, bridge, called: () => offered }
}

for (const provider of ['acp-claude', 'acp-codex', 'acp-antigravity', 'acp-omp']) {
  test(`${provider} receives only checked Skills data over its ACP prompt and MCP load paths`, { timeout: 15_000 }, async t => {
    const f = fixture(t, provider)
    if (provider === 'acp-codex') {
      await f.run([user('plain before activation')])
      assert.deepEqual(f.events('new-session')[0].servers, [])
    }
    f.active.add('owner-a')
    const called = user('codex-bridge load_skill {"name":"marker"}')
    const loaded = await f.run(provider === 'acp-codex' ? [answer(provider), called] : [called])
    assert.match(loaded.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
      /The bridge said: CHECKED-ACP-BODY/)
    assert.equal(f.called(), true, 'the fake agent executed the DSH skill tool over MCP')
    const live = f.adapter.live.get(f.agent.id)
    assert.ok(live.bridge.listed)
    assert.deepEqual(offeredTools(f.ctx, f.agent, { skillOnly: live.bridge.skillOnly }).map(item => item.name),
      provider === 'acp-claude' ? ['load_skill', 'other_fixture_tool'] : ['load_skill'])
    if (live.bridge.skillOnly) {
      const out = await f.bridge.call(live.bridge, { name: 'other_fixture_tool', arguments: {} })
      assert.equal(out.isError, true)
    }
    assert.match(f.events('prompt').at(-1).text, /marker: Adds the file marker/)
    const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.at(-1)?.data.message.content[0].text, skill.content)
    assert.deepEqual(await skillTool(f.rt).execute({ name: skill.name }, { agent: { id: 'other' } }), {})

    const personCall = user('/marker plain', skillPart('owner-a', skill))
    await f.run([user('Earlier request'), answer(provider), personCall])
    assert.match(f.events('prompt').at(-1).text, /\/marker plain\s+CHECKED-ACP-BODY/)
    f.setMode('manual')
    const denied = await f.run([personCall, answer(provider), called])
    assert.match(denied.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
      /The bridge said: \(no text\)/)
    assert.doesNotMatch(f.events('prompt').at(-1).text, /Adds the file marker|CHECKED-ACP-BODY/)
    await f.run([answer(provider), user('/marker plain', skillPart('owner-a', skill))])
    assert.match(f.events('prompt').at(-1).text, /\/marker plain\s+CHECKED-ACP-BODY/)
    assert.doesNotMatch(f.events('prompt').at(-1).text, /Adds the file marker/)
    f.active.clear()
    const notice = createUserMessage({ source: { kind: SKILL_NOTICE, form: 'notice', summary: 'Private notice' },
      content: [{ type: 'text', text: 'Private notice' }] })
    const continuation = user('/marker plain', skillPart('owner-a', skill))
    await f.run([personCall, answer(provider), continuation, notice])
    assert.equal(f.adapter.live.get(f.agent.id), live, 'Remove keeps the provider session')
    assert.doesNotMatch(f.events('prompt').at(-1).text, /CHECKED-ACP-BODY|Adds the file marker|Private notice/)
    assert.deepEqual(await skillTool(f.rt).execute({ name: skill.name }, { agent: f.agent }), {})

    f.adapter.endSession(f.agent.id)
    await f.run([personCall, answer(provider), notice, createUserMessage({
      source: { kind: 'bot', form: 'relay' }, content: [{ type: 'text', text: 'A plain non-person turn' }],
    })])
    const reopened = f.events('prompt').at(-1).text
    assert.match(reopened, /CHECKED-ACP-BODY/)
    assert.match(reopened, /A plain non-person turn/)
    assert.doesNotMatch(reopened, /Adds the file marker|Private notice/)
  })
}

test('ACP rechecks mode after the tool executes and before sending its result', { timeout: 15_000 }, async t => {
  const f = fixture(t, 'acp-codex')
  f.active.add('owner-a')
  f.onLoad(() => f.setMode('manual'))
  const loaded = await f.run([user('codex-bridge load_skill {"name":"marker"}')])
  assert.equal(f.called(), true)
  assert.match(loaded.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    /The bridge said: \(no text\)/)
  const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  assert.deepEqual(results.at(-1).data.message.content, [])
})

test('Skills row 1: Codex refork preserves the Skills-only bridge', { timeout: 15_000 }, async t => {
  const provider = 'acp-codex'
  const f = fixture(t, provider, { reforks: true })
  f.active.add('owner-a')
  await f.run([user('plain first request')])
  const original = f.adapter.live.get(f.agent.id).bridge
  assert.equal(original.skillOnly, true)
  f.setPreset('different')
  const result = await f.run([answer(provider), user('codex-bridge load_skill {"name":"marker"}')])
  assert.match(result.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), /The bridge said: CHECKED-ACP-BODY/)
  assert.equal(f.events('fork').length, 1)
  const fork = f.events('fork')[0]
  assert.deepEqual(f.events('mcp-list').find(event => event.sessionId === fork.sessionId)?.tools, ['load_skill'])
  const next = f.adapter.live.get(f.agent.id).bridge
  assert.notEqual(next, original)
  assert.equal(original.closed, true)
  assert.deepEqual(offeredTools(f.ctx, f.agent, { skillOnly: next.skillOnly }).map(item => item.name), ['load_skill'])
  const denied = await f.bridge.call(next, { name: 'other_fixture_tool', arguments: {} })
  assert.deepEqual(denied.content, [{ type: 'text', text: 'Unknown tool' }])
})

test('Skills row 3: first delivery excludes withheld history, retry and interrupted rows', { timeout: 15_000 }, async t => {
  const provider = 'acp-codex'
  const f = fixture(t, provider)
  const withheld = { ...skill, name: 'withheld', hash: 'withheld-revision', content: 'WITHHELD-ACP-BODY' }
  const person = user('plain ordinary /marker /withheld', skillPart('owner-a', skill), skillPart('owner-a', withheld))
  f.active.add('owner-a')
  const reply = { ...answer(provider), id: 'first-reply' }
  await f.run([person], { record: [person], reply })
  assert.match(f.events('prompt').at(-1).text, /CHECKED-ACP-BODY/)
  assert.doesNotMatch(f.events('prompt').at(-1).text, /WITHHELD-ACP-BODY/)
  f.active.clear()
  f.adapter.endSession(f.agent.id)
  const saved = f.agent.session
  f.agent.session = Session.create(saved.id, JSON.parse(JSON.stringify(saved.snapshotEvents())), saved.header)
  const retry = createUserMessage({ source: { kind: 'retry' }, content: [{ type: 'text', text: 'Continue plain' }] })
  await f.run([person, reply, retry], { record: [retry] })
  const replay = f.events('prompt').at(-1).text
  assert.match(replay, /ordinary \/marker \/withheld/)
  assert.match(replay, /CHECKED-ACP-BODY/)
  assert.doesNotMatch(replay, /WITHHELD-ACP-BODY/)
  const nativeReplay = f.rt.skillCalls.project({
    sessionId: f.agent.id, messages: f.agent.session.deriveMessages(),
  })
  assert.match(JSON.stringify(nativeReplay.messages), /CHECKED-ACP-BODY/)
  assert.doesNotMatch(JSON.stringify(nativeReplay.messages), /WITHHELD-ACP-BODY/)

  const cut = fixture(t, provider, { earlierTurns: 1 })
  const session = cut.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('user/message', user('interrupted ordinary text', skillPart('owner-a', withheld)), { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 0 })
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  const resumed = createUserMessage({ source: { kind: 'user', resumed: true }, content: [{ type: 'text', text: 'Resume plain' }] })
  const native = cut.rt.skillCalls.project({ sessionId: cut.agent.id, messages: [...session.deriveMessages(), answer(provider), retry] })
  assert.doesNotMatch(JSON.stringify(native.messages), /WITHHELD-ACP-BODY/, 'native history also excludes undelivered parts')
  await cut.run([resumed])
  assert.match(cut.events('prompt').at(-1).text, /interrupted ordinary text/)
  assert.doesNotMatch(cut.events('prompt').at(-1).text, /WITHHELD-ACP-BODY/)
})

test('Skills row 4: demoting the last Automatic skill clears retained discovery context', { timeout: 15_000 }, async t => {
  const provider = 'acp-codex'
  const f = fixture(t, provider)
  f.active.add('owner-a')
  const person = user('plain Earlier durable request', skillPart('owner-a', skill))
  const reply = { ...answer(provider), id: 'earlier-reply' }
  await f.run([person], { record: [person], reply })
  const before = f.events('prompt').at(-1)
  assert.match(before.text, /Adds the file marker/)
  assert.match(before.text, /CHECKED-ACP-BODY/)
  f.setMode('manual')
  await f.run([person, reply, user('plain ordinary next request')])
  const prompts = f.events('prompt')
  const last = prompts.at(-1)
  const context = prompts.filter(event => event.sessionId === last.sessionId).map(event => event.text).join('\n')
  assert.doesNotMatch(context, /Adds the file marker/)
  assert.match(context, /Earlier durable request/)
  assert.match(context, /Earlier answer remains/)
  assert.match(context, /CHECKED-ACP-BODY/)
  assert.match(context, /ordinary next request/)
})

test('Skills row 9: a Hermes chat sends ordinary text with an Automatic assignment', { timeout: 15_000 }, async t => {
  const f = fixture(t, 'acp-hermes')
  f.active.add('owner-a')
  await f.run([user('Hermes ordinary message, plain')])
  assert.deepEqual(f.events('new-session')[0].servers, [])
  assert.match(f.events('prompt').at(-1).text, /Hermes ordinary message/)
  assert.doesNotMatch(f.events('prompt').at(-1).text, /Adds the file marker|CHECKED-ACP-BODY/)
})
