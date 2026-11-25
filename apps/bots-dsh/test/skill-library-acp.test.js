import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { Backchannel, offeredTools } from '../../acp-dsh/src/host/backchannel.js'
import { AGY_TOOLS_OFF_TEXT } from '../../acp-dsh/src/host/agy-off.js'
import { AGY_OFF_ARGS, agyWorld, unixOnly } from '../../acp-dsh/test/fixtures/agy-world.js'
import { createSystemMessage, createUserMessage, markAgentLoopRequest, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { Session } from '@deepseek-ai/dsh-session'
import { install, skillPart, skillTool } from '../src/host/skill-library-call.js'
import { SKILL_NOTICE } from '../src/host/skill-message.js'

const script = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).pathname
const skill = { name: 'marker', description: 'Adds the file marker', content: 'CHECKED-ACP-BODY', hash: 'fixture-revision' }
const manual = { name: 'mint-notes', description: 'Write a mint note.', content: 'Write exactly MINT-OK.', hash: 'mint', mode: 'manual' }
const automatic = { ...skill, mode: 'automatic' }
const catalog = 'marker: Adds the file marker'
const manualPrompt = 'Use the skill mint-notes.\n  Keep these spaces. '
const textCall = manualPrompt + '\n' + manual.content
const text = text => ({ type: 'text', text })
const user = (value, ...parts) => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text: value }, ...parts],
})
const answer = provider => ({
  role: 'assistant', source: { kind: 'model', provider, model: 'default' },
  content: [{ type: 'text', text: 'Earlier answer remains' }],
})

test('Skills row 8: production Antigravity OFF admits only the Session skill read', { ...unixOnly, timeout: 15_000 }, async t => {
  const h = agyWorld(t)
  const assigned = new Set(['eligible', 'other-eligible'])
  const rt = {
    ctx: { on() {} }, load: async () => {}, selfOf: id => id,
    botOf: id => ['eligible', 'other-eligible', 'ordinary'].includes(id) ? { id } : undefined,
    skillLibrary: { active: id => assigned.has(id) ? [{ ...skill, mode: 'automatic' }] : [] },
  }
  install(rt)
  h.services.omniTeam = rt
  h.service.botIdentity(id => rt.botOf(id) && { name: id })
  const tool = skillTool(rt)
  const unrelated = { name: 'other_fixture_tool' }
  const executions = []
  h.services.tools = {
    definitions: () => [tool, unrelated],
    async execute({ calls, agent }) {
      const [{ id, name, arguments: input }] = calls
      assert.equal(name, tool.name)
      executions.push(agent.session.id)
      const args = JSON.parse(input)
      const value = await tool.execute(args, { agent: { id: agent.session.id } })
      return { results: [{ callId: id, result: { content: tool.output.render(args, value), isError: false } }] }
    },
  }
  const a = h.chat('eligible')
  await a.turn('plain eligible launch')
  const profile = 'automagik-native-off-skills'
  const { args, pid, prompt } = h.conversation('eligible launch')
  assert.deepEqual(args, ['acp', '--agent', profile, '--cli_dir_name', profile])
  const child = h.events().filter(event => event.pid === pid)
  const agent = readFileSync(join(h.home(), '.gemini', 'config', 'agents', `${profile}.md`), 'utf8')
  assert.match(agent, /^tools: \["mcp_dsh_load_skill"\]$/m)
  assert.match(agent, /^excludeDefaultComponents: true$/m)
  assert.match(agent, /^commandExecutionPolicy: "off"$/m)
  assert.equal(agent.split('---').at(-1).trim(), '')
  const policy = JSON.parse(readFileSync(join(h.home(), '.gemini', 'antigravity-cli', profile, 'settings.json'), 'utf8'))
  assert.deepEqual(policy.permissions, {
    deny: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'command(*)'],
    allow: ['mcp(dsh/load_skill)'],
  })
  const launch = child.find(event => event.event === 'new-session')
  assert.deepEqual(launch.servers, ['dsh'])
  assert.deepEqual(launch.meta?.antigravity?.eagerMcpServers, ['dsh'])
  assert.equal(launch.systemPrompt, undefined)
  assert.deepEqual(child.find(event => event.event === 'mcp-list').tools, ['load_skill'])
  assert.match(prompt, /marker: Adds the file marker/)
  assert.doesNotMatch(prompt, /CHECKED-ACP-BODY|load_skill/)

  const loaded = await a.turn('agy-bridge load_skill {"name":"marker"}')
  assert.match(loaded.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), /The bridge said: CHECKED-ACP-BODY/)
  assert.deepEqual(h.events('permission-answer').at(-1).answer, { outcome: 'selected', optionId: 'agy-allow' })

  const b = h.chat('other-eligible')
  const previous = user('plain second eligible launch', skillPart(b.session.id, skill))
  b.session.append('user/message', previous, { surfaceOp: 'append' })
  await b.turn(previous)
  assert.match(h.conversation('second eligible launch').prompt, /CHECKED-ACP-BODY/)
  const ordinary = h.chat('ordinary')
  const plain = await ordinary.turn('plain ordinary launch')
  assert.equal(plain.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.conversation('ordinary launch').args, AGY_OFF_ARGS)
  assert.deepEqual(h.events('new-session').find(event => event.pid === h.conversation('ordinary launch').pid).servers, [])

  const bridge = h.adapter.backchannel
  const first = h.adapter.live.get(a.session.id).bridge
  const second = h.adapter.live.get(b.session.id).bridge
  const call = (record, path, name) => fetch(bridge.urlFor(path), { method: 'POST',
    headers: { authorization: `Bearer ${record.credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'call', name, arguments: { name: skill.name } }),
  })
  const cross = await call(first, second, 'load_skill')
  assert.equal(cross.status, 401)
  assert.deepEqual(await cross.json(), { error: 'refused' })
  const unrelatedCall = await call(first, first, unrelated.name)
  assert.equal((await unrelatedCall.json()).isError, true)
  assigned.delete(b.session.id)
  const afterRemoval = await b.turn('plain after last Automatic assignment')
  assert.equal(afterRemoval.at(-1).reason.kind, 'stop')
  const replaced = h.conversation('after last Automatic assignment')
  assert.deepEqual(replaced.args, AGY_OFF_ARGS)
  assert.match(replaced.prompt, /second eligible launch\nCHECKED-ACP-BODY/)
  assert.doesNotMatch(replaced.prompt, /Adds the file marker/)
  assert.equal(h.adapter.live.get(b.session.id).bridge, undefined)
  assert.equal((await call(second, second, 'load_skill')).status, 401)
  const blocked = await a.turn('omp-first-tool_call')
  assert.equal(blocked.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), AGY_TOOLS_OFF_TEXT)
  assert.equal(h.adapter.live.has(a.session.id), false)
  assert.deepEqual(executions, ['eligible'])
  assert.deepEqual(h.approvals.map(request => request.toolName), ['load_skill'])
})

function fixture(t, provider, { reforks = false, earlierTurns = 0, capturePrompt = false, addedSkills = [] } = {}) {
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
  const handlers = new Map()
  const rt = {
    ctx: { on: (key, handler) => handlers.set(key, handler),
      get: key => key === 'sessions' ? { get: id => id === agent.id ? agent.session : undefined } : undefined },
    load: async () => {}, selfOf: id => id === agent.id ? 'owner-a' : undefined,
    botOf: id => id === 'owner-a' ? { id } : undefined,
    skillLibrary: { active: id => id === 'owner-a' && active.has(id) ? [{ ...skill, mode }, ...addedSkills] : [] },
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
      env: { PATH: process.env.PATH, HOME: dir, FAKE_ACP_TRACE: trace,
        ...(capturePrompt && { FAKE_ACP_SKILLS_PROBE: JSON.stringify({
          turns: [manualPrompt, textCall].map(text => ({ text, loads: [] })),
        }) }) } }),
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
  const preStep = async row => {
    const decision = await handlers.get('agent/pre-step')(
      { agent, messages: [row], signal: t.signal }, async () => ({ kind: 'enter', messages: [row] }))
    return decision.messages[0]
  }
  return { active, setMode: value => { mode = value }, setPreset: value => { preset = value },
    onLoad: hook => { afterLoad = hook },
    ctx, rt, agent, run, events, preStep, stream: handlers.get('llm/stream'), adapter, bridge, called: () => offered }
}

for (const provider of ['acp-claude', 'acp-codex']) {
  for (const uploaded of [false, true]) {
    test(`person-call order at the ${provider} ${uploaded ? 'prepared upload' : 'text'} prompt`, { timeout: 15_000 }, async t => {
      const f = fixture(t, provider, { capturePrompt: true, addedSkills: [manual] })
      f.active.add('owner-a')
      const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 30, width: 1, height: 1 }
      const input = user(manualPrompt, ...uploaded ? [{ type: 'image', attachment: ref }] : [])
      const called = await f.preStep(input)
      const previous = answer(provider)
      await f.run([called], { record: [called], reply: previous })
      const first = f.events('prompt').at(-1)
      const current = uploaded ? [text(manualPrompt), text(textOnlyImageText(ref)), text(manual.content)]
        : [text(textCall)]
      assert.equal(f.agent.session.snapshotEvents().filter(e => e.type === 'plugin:automagik/skill-delivery').length, 1)
      assert.deepEqual(first.prompt, [text(catalog), ...current])

      const next = await f.preStep(user(manualPrompt))
      await f.run([called, previous, next], { record: [next] })
      const cached = f.events('prompt').at(-1)
      assert.equal(cached.sessionId, first.sessionId)
      assert.deepEqual(cached.prompt, [text(textCall)])
    })
  }
}

test('person-call order in the serialized native request with a late system snapshot', async t => {
  const provider = 'deepseek-official'
  const model = 'fixture-model'
  const f = fixture(t, provider, { addedSkills: [manual] })
  f.active.add('owner-a')
  const called = await f.preStep(user(manualPrompt))
  const session = f.agent.session
  const leading = 'The effective leading system snapshot.'
  const late = 'A system snapshot sent after the person input.'
  const earlier = 'An earlier person message.'
  const connection = resolveAdapterOptions({ baseURL: 'https://fixture.invalid',
    models: [{ id: model, name: model, systemPromptUpdate: 'in-history' }] })
  const adapter = new DeepSeekAdapter({ options: () => connection,
    resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'fixture',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  const wire = []
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.equal(url, 'https://fixture.invalid/v1/messages')
    wire.push(JSON.parse(body))
    return new Response('{}', { status: 400 })
  })
  f.rt.ctx.llm = { stream: options => f.stream(options, () => adapter.stream(options)) }
  session.append('request/context', { provider, model, systemPromptUpdate: 'in-history' })
  const messages = [createSystemMessage('Superseded leading snapshot.'), createSystemMessage(leading),
    user(earlier), createSystemMessage(late), called]
  const options = markAgentLoopRequest({ provider, model, sessionId: session.id, messages, signal: t.signal })
  await assert.rejects(async () => Array.fromAsync(f.rt.ctx.llm.stream(options)), /400/)
  assert.equal(wire.length, 1)
  assert.equal(wire[0].model, model)
  assert.deepEqual({ system: wire[0].system, messages: wire[0].messages }, {
    system: leading + '\n\n' + catalog,
    messages: [
      { role: 'user', content: [text(earlier), text(manualPrompt), text(manual.content)] },
      { role: 'system', content: [text(late)] },
    ],
  })
})

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
    const deniedText = denied.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    if (provider === 'acp-antigravity') {
      assert.ok(deniedText.endsWith(AGY_TOOLS_OFF_TEXT))
      assert.equal(live.bridge.closed, true)
    } else {
      assert.match(deniedText, /The bridge said: No skill with that name is available to this Bot\./)
    }
    assert.doesNotMatch(f.events('prompt').at(-1).text, /Adds the file marker|CHECKED-ACP-BODY/)
    await f.run([answer(provider), user('/marker plain', skillPart('owner-a', skill))])
    assert.match(f.events('prompt').at(-1).text, /\/marker plain\s+CHECKED-ACP-BODY/)
    assert.doesNotMatch(f.events('prompt').at(-1).text, /Adds the file marker/)
    const manual = f.adapter.live.get(f.agent.id)
    if (provider === 'acp-antigravity') assert.equal(manual.bridge, undefined)
    f.active.clear()
    const notice = createUserMessage({ source: { kind: SKILL_NOTICE, form: 'notice', summary: 'Private notice' },
      content: [{ type: 'text', text: 'Private notice' }] })
    const continuation = user('/marker plain', skillPart('owner-a', skill))
    await f.run([personCall, answer(provider), continuation, notice])
    assert.equal(f.adapter.live.get(f.agent.id), provider === 'acp-antigravity' ? manual : live, 'Remove keeps the call-only provider session')
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
    /The bridge said: No skill with that name is available to this Bot\./)
  const results = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  assert.deepEqual(results.at(-1).data.message.content, [])
  assert.equal(results.at(-1).data.message.isError, true)
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
