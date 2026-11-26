import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { Backchannel, offeredTools } from '../../acp-dsh/src/host/backchannel.js'
import { AGY_TOOLS_OFF_TEXT } from '../../acp-dsh/src/host/agy-off.js'
import { AGY_OFF_ARGS, agyWorld, unixOnly } from '../../acp-dsh/test/fixtures/agy-world.js'
import { createSystemMessage, createToolResultMessage, createUserMessage, markAgentLoopRequest, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { Session } from '@deepseek-ai/dsh-session'
import { install, skillPart, skillTool } from '../src/host/skill-library-call.js'
import { AGY_OFF_SKILLS_NOTICE, SKILL_NOTICE } from '../src/host/skill-message.js'
import { callerItems } from '../src/host/caller-view.js'
import { rowsOf } from '../src/host/pocket-chat.js'

const script = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).pathname
const bridgeScript = new URL('../../acp-dsh/src/host/bridge.js', import.meta.url).pathname
const activities = session => session.snapshotEvents().filter(event => event.type === 'plugin:automagik/skill-activity')
const skill = { name: 'marker', description: 'Adds the file marker', content: 'CHECKED-ACP-BODY', hash: 'fixture-revision' }
const manual = { name: 'mint-notes', description: 'Write a mint note.', content: 'Write exactly MINT-OK.', hash: 'mint', mode: 'manual' }
const automatic = { ...skill, mode: 'automatic' }
const catalogHeading = 'Your skills (load with load_skill):'
const catalog = `${catalogHeading}\nmarker: Adds the file marker`
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

test('Skills row 8: Antigravity OFF with exact eager proof admits only the Session skill read', { ...unixOnly, timeout: 15_000 }, async t => {
  const agySkillsVersions = []
  const version = '9.8.7'
  const h = agyWorld(t, { registry: 'eager', version, deps: { agySkillsVersions } })
  agySkillsVersions.push({ version, sha256: createHash('sha256').update(readFileSync(h.agy)).digest('hex') })
  assert.equal(h.service.nativeOffNotes('acp-antigravity').skillsUnavailable, undefined)
  const assigned = new Set(['eligible', 'other-eligible'])
  const rt = {
    ctx: { on() {} }, load: async () => {}, selfOf: id => id,
    botOf: id => ['eligible', 'other-eligible', 'ordinary'].includes(id) ? { id } : undefined,
    skillLibrary: { active: id => assigned.has(id) ? [{ ...skill, mode: 'automatic' }] : [] },
  }
  install(rt)
  h.services.omniTeam = rt
  let nativeTools = false
  h.service.botIdentity(id => rt.botOf(id) && { name: id, nativeTools, nativeToolsAgent: 'acp-antigravity' })
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
  assert.deepEqual(child.find(event => event.event === 'registry').registry, ['mcp_dsh_load_skill'])
  assert.ok(prompt.includes(catalog))
  assert.doesNotMatch(prompt.replace(catalogHeading, ''), /CHECKED-ACP-BODY|load_skill/)

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

  assigned.add(b.session.id)
  await b.turn('plain before executable replacement')
  const priorBridge = h.adapter.live.get(b.session.id).bridge
  const priorPid = h.events('prompt').at(-1).pid
  // Keep the reported version identical while replacing the selected executable's bytes.
  appendFileSync(h.agy, '\n# replacement\n')
  assert.equal(h.service.nativeOffNotes('acp-antigravity').skillsUnavailable, true)
  const fallback = await b.turn('plain after executable replacement')
  assert.equal(fallback.at(-1).reason.kind, 'stop')
  const replacement = h.events('prompt').at(-1)
  assert.notEqual(replacement.pid, priorPid)
  assert.deepEqual(h.events('start').find(event => event.pid === replacement.pid).args, AGY_OFF_ARGS)
  assert.deepEqual(h.events('new-session').find(event => event.pid === replacement.pid).servers, [])
  assert.doesNotMatch(replacement.text, /Your skills|load_skill/)
  assert.equal((await call(priorBridge, priorBridge, 'load_skill')).status, 401)
  const unproven = await b.turn('agy-bridge load_skill {"name":"marker"}')
  assert.ok(unproven.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('').endsWith(AGY_TOOLS_OFF_TEXT))
  assert.deepEqual(executions, ['eligible'])

  nativeTools = true
  await b.turn('plain Native tools ON warmup')
  const on = await b.turn('agy-bridge load_skill {"name":"marker"}')
  assert.match(on.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), /The bridge said: CHECKED-ACP-BODY/)
  const onPid = h.events('prompt').at(-1).pid
  assert.deepEqual(h.events('start').find(event => event.pid === onPid).args, ['acp'])
  assert.deepEqual(executions, ['eligible', 'other-eligible'])
})

function fixture(t, provider, { reforks = false, earlierTurns = 0, probeTurns, addedSkills = [], worker } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-acp-'))
  const trace = join(dir, 'trace.ndjson')
  const session = worker === 'subagent' ? Session.create('bot-a', undefined, {
    version: 4, id: 'bot-a', createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: 'fixture-parent',
  }) : Session.create('bot-a')
  const agent = { id: session.id, session, ctx: { tools: { register() {} } } }
  const active = new Set()
  const other = { name: 'other_fixture_tool' }
  let mode = 'automatic'
  let afterLoad
  let offered = false
  let nextTurn = earlierTurns
  let preset = 'standard'
  let admitted = true
  const handlers = new Map()
  const rt = {
    ctx: { on: (key, handler) => handlers.set(key, handler),
      get: key => key === 'sessions' ? { get: id => id === agent.id ? agent.session : undefined } : undefined },
    load: async () => {}, selfOf: id => id === (worker ? 'fixture-parent' : agent.id) ? 'owner-a' : undefined,
    botOf: id => id === 'owner-a' ? { id } : undefined,
    skillLibrary: { active: id => id === 'owner-a' && active.has(id) ? [{ ...skill, mode }, ...addedSkills] : [] },
    ...(worker && { canUseWorkerSkillTool: () => admitted }),
    ...(worker === 'task' && { state: { tasks: { [session.id]: { skillsOwner: 'owner-a',
      skillsInstructionsId: 'fixture-task-instructions', skills: [{ ...automatic }] } } } }),
  }
  install(rt)
  const tool = skillTool(rt)
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, turnBoundaryOf: () => ({ lastTurn: nextTurn }) },
    get(key) {
      if (key === 'omniTeam') return rt
      if (key === 'tools') return {
        definitions: () => admitted ? [tool, other] : [other],
        executable: name => (admitted ? [tool, other] : [other]).find(definition => definition.name === name),
        execute: async ({ calls, agent: actual }) => {
          const { id, name, arguments: input } = calls[0]
          assert.equal(name, tool.name)
          const args = JSON.parse(input)
          offered = true
          const value = await tool.execute(args, { agent: actual })
          afterLoad?.(id)
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
    ...(provider === 'acp-antigravity' ? { agySkillsVersion: () => '9.8.7' } : {}),
    ...(reforks ? { refresh: 'fork' } : {}),
    nativeSwitch: ['acp-antigravity', 'acp-omp'].includes(provider) ? 'args' : undefined,
    disableBuiltInTools: provider === 'acp-claude',
    catalog: { models: async () => [{ id: 'default', name: 'Fixture agent' }], dispose() {} },
    installed: () => true,
    spawn: ({ skillBridge } = {}) => ({ command: process.execPath, args: [script],
      ...(provider === 'acp-antigravity' && skillBridge ? { agySkillsVersion: '9.8.7' } : {}),
      env: { PATH: process.env.PATH, HOME: dir, FAKE_ACP_TRACE: trace,
        ...(probeTurns && { FAKE_ACP_SKILLS_PROBE: JSON.stringify({ turns: probeTurns }) }) } }),
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
    excludeSkill: () => { admitted = false },
    onLoad: hook => { afterLoad = hook },
    ctx, rt, agent, run, events, preStep, stream: handlers.get('llm/stream'), adapter, bridge, called: () => offered }
}

test('2083 a Codex task gets the same checked catalog and load as its Bot through ACP', { timeout: 15_000 }, async t => {
  const prompt = 'Choose a skill for the worker.'
  const restricted = 'A later restricted request.'
  const f = fixture(t, 'acp-codex', { worker: 'task',
    probeTurns: [{ text: prompt, loads: [skill.name] }, { text: restricted, loads: [] }] })
  f.active.add('owner-a')
  await f.run([user(prompt)])
  const sent = f.events('prompt').at(-1)
  assert.deepEqual(sent.prompt, [text(prompt), text(catalog)])
  const listed = f.events('mcp-list').find(event => event.sessionId === sent.sessionId && event.server === 'dsh')
  assert.ok(listed.definitions.some(definition => definition.name === 'load_skill'))
  assert.deepEqual(f.events('skills-load').at(-1).answer, { content: [text(skill.content)], isError: false })
  f.excludeSkill()
  assert.equal(f.rt.skillCalls.load(f.agent.id, skill.name), undefined)
  assert.deepEqual(offeredTools(f.ctx, f.agent, { skillOnly: true }), [])
  await f.run([user(restricted)])
  assert.doesNotMatch(f.events('prompt').at(-1).text, /Adds the file marker/)
})

test('2083 ACP replay strips delegated skill gestures while keeping ordinary child instructions', { timeout: 15_000 }, async t => {
  const f = fixture(t, 'acp-codex', { worker: 'subagent', addedSkills: [manual],
    probeTurns: [{ text: 'Keep these delegated instructions', loads: [] }, { text: 'Check the result again.', loads: [] }] })
  f.active.add('owner-a')
  const delegated = user('Keep these delegated instructions and use the skill mint-notes.')
  const reply = answer('acp-codex')
  await f.run([delegated], { record: [delegated], reply })
  assert.match(f.events('prompt').at(-1).text, /Keep these delegated instructions/)
  assert.doesNotMatch(f.events('prompt').at(-1).text, /mint-notes|MINT-OK/)
  f.adapter.end(f.agent.id)
  await f.run([delegated, reply, user('Check the result again.')])
  const replay = f.events('prompt').at(-1).text
  assert.match(replay, /Keep these delegated instructions/)
  assert.doesNotMatch(replay, /mint-notes|MINT-OK/)
})

test('2083 the Antigravity task uses its own OFF route and gives the existing availability sentence', { ...unixOnly, timeout: 15_000 }, async t => {
  const h = agyWorld(t)
  const chat = h.chat('fixture-task')
  const initial = user('Antigravity worker route check.')
  const rt = {
    ctx: { on() {} }, load: async () => {}, selfOf: () => undefined,
    botOf: id => id === 'owner-a' ? { id } : undefined,
    skillLibrary: { active: () => [automatic] },
    canUseWorkerSkillTool: id => id === chat.session.id,
    state: { tasks: { [chat.session.id]: { skillsOwner: 'owner-a',
      skillsInstructionsId: initial.id, skills: [{ ...automatic }] } } },
  }
  install(rt)
  h.services.omniTeam = rt
  const identity = []
  h.service.botIdentity(id => {
    identity.push(id)
    return id === 'owner-a' ? { nativeTools: true, nativeToolsAgent: 'acp-antigravity' } : undefined
  })
  h.services.tools = { definitions: () => [skillTool(rt)] }
  const result = await chat.turn(initial)
  assert.equal(result.at(-1).reason.kind, 'stop')
  const run = h.conversation('Antigravity worker route check')
  assert.ok(identity.includes(chat.session.id))
  assert.deepEqual(run.args, AGY_OFF_ARGS)
  assert.equal(run.prompt, initial.content[0].text)
  assert.deepEqual(chat.session.deriveMessages().filter(row => row.source?.kind === SKILL_NOTICE)
    .map(row => row.content[0].text), [AGY_OFF_SKILLS_NOTICE])
})

test('Codex Automatic self-load receives the exact skill tool and catalog', { timeout: 15_000 }, async t => {
  const prompt = 'Choose a workflow for this task.'
  const second = { ...automatic, name: 'labels', description: 'Formats labels', hash: 'labels' }
  const f = fixture(t, 'acp-codex', {
    addedSkills: [manual, second], probeTurns: [{ text: prompt, loads: [skill.name] }],
  })
  f.active.add('owner-a')
  await f.run([user(prompt)])

  const sent = f.events('prompt').at(-1)
  const listed = f.events('mcp-list').find(event => event.sessionId === sent.sessionId && event.server === 'dsh')
  assert.deepEqual(f.events('skills-load').map(({ sessionId, name, retry, answer }) => ({ sessionId, name, retry, answer })), [{
    sessionId: sent.sessionId, name: skill.name, retry: false,
    answer: { content: [text(skill.content)], isError: false },
  }])
  assert.deepEqual({ definitions: listed?.definitions, prompt: sent.prompt }, {
    definitions: [{
      name: 'load_skill',
      description: 'Load the full instructions of one of your active skills by its exact name from your skills list.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact skill name from your skills list.' } },
        required: ['name'],
      },
    }],
    prompt: [text(prompt), text(`${catalog}\nlabels: Formats labels`)],
  })
})

test('round 2 activity: ACP waits for a finished write and places a background load on its own event', { timeout: 15_000 }, async t => {
  const f = fixture(t, 'acp-claude')
  f.active.add('owner-a')
  const { session } = f.agent
  const finishTurn = (turn, row) => {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 0 })
    session.append('user/message', row, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 0 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const initial = user('Earlier ordinary chat.')
  finishTurn(1, initial)
  const previous = createUserMessage({ source: { kind: 'bot', form: 'relay', role: 'room', roomId: 'past-room', exchangeId: 'past-exchange' },
    content: [text('An unrelated room exchange.')] })
  const record = f.bridge.mint({ sessionId: session.id, agent: f.agent })
  const send = async (callId, abandon) => {
    const request = {
      method: 'POST', url: record.path, headers: { authorization: `Bearer ${record.credential}` },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ op: 'call', name: 'load_skill', arguments: { name: skill.name }, callId }))
      },
    }
    const response = Object.assign(new EventEmitter(), {
      writeHead(status) { this.status = status },
      end(body) {
        this.body = body
        this.writableEnded = true
        if (abandon) {
          this.destroyed = true
          this.emit('close')
        }
      },
    })
    await f.bridge.handle(request, response)
    assert.equal(response.status, 200)
    return response
  }
  await send('abandoned', true)
  const afterAbandon = activities(session).length
  finishTurn(2, previous)
  const reply = await send('delivered', false)
  const beforeFinish = activities(session).length
  reply.writableFinished = true
  reply.emit('finish')
  assert.equal(reply.body, JSON.stringify({ content: [text(skill.content)], isError: false }))
  const expectedEvent = session.snapshotEvents().find(event => event.type === 'plugin:acp-dsh/bridge-outside-step' && event.data.callId === 'delivered')
  const placement = activities(session).map(({ data }) => ({ name: data.name, eventSeq: data.eventSeq,
    turn: data.turn, step: data.step, roomId: data.roomId }))
  const shared = callerItems(session.id, session.snapshotEvents(), undefined, { [session.id]: [2] })
  assert.deepEqual({ afterAbandon, beforeFinish, placement, visible: shared.filter(row => row.kind === 'skill-activity').map(row => row.name) }, {
    afterAbandon: 0, beforeFinish: 0,
    placement: [{ name: skill.name, eventSeq: expectedEvent.seq, turn: undefined, step: undefined, roomId: undefined }],
    visible: [skill.name],
  })
})

test('round 2 activity: MCP replays without callId use the typed request ID', { timeout: 15_000 }, async t => {
  const f = fixture(t, 'acp-codex')
  f.active.add('owner-a')
  await f.bridge.listen()
  const { session } = f.agent
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('user/message', user('Earlier ordinary chat.'), { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 0 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const record = f.bridge.mint({ sessionId: session.id, agent: f.agent })
  const child = spawn(process.execPath, [bridgeScript], { env: { ...process.env,
    DSH_BRIDGE_CREDENTIAL: record.credential, DSH_BRIDGE_URL: f.bridge.urlFor(record),
  }, stdio: ['pipe', 'pipe', 'inherit'] })
  const replies = createInterface({ input: child.stdout })
  t.after(() => { replies.close(); child.kill() })
  const receive = replies[Symbol.asyncIterator]()
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const message = JSON.parse((await receive.next()).value)
    assert.equal(message.id, id)
    return message.result
  }
  assert.ok((await request(0, 'tools/list')).tools.some(tool => tool.name === 'load_skill'))
  const executionIds = []
  f.onLoad(id => executionIds.push(id))
  const counts = []
  for (const id of [7, 7, '7', '7']) {
    const result = await request(id, 'tools/call', { name: 'load_skill', arguments: { name: skill.name } })
    assert.equal(JSON.stringify(result), JSON.stringify({ content: [text(skill.content)], isError: false }))
    counts.push(activities(session).length)
  }
  assert.equal(new Set(executionIds).size, 4)
  assert.deepEqual(counts, [1, 1, 2, 2])
})

test('confirmed Skills deliveries reach chat activity without changing provider bytes', { timeout: 30_000 }, async t => {
  const observed = []
  function checkChat(session, expected) {
    const events = session.snapshotEvents()
    const records = activities(session)
    const scope = { sessionId: session.id, turn: 0, calls: new Map() }
    const pocket = events.flatMap(event => rowsOf(event, scope)).filter(row => row.tool === 'Skill')
    const shared = callerItems(session.id, events, undefined, {}).filter(row => row.kind === 'skill-activity')
    const hidden = callerItems(session.id, events, undefined, { [session.id]: [1, 2] })
    assert.equal(hidden.some(row => row.kind === 'skill-activity' && row.turn !== undefined), false)
    assert.equal(callerItems(session.id, events, undefined, undefined).length, 0)
    assert.equal(JSON.stringify(records).includes('CHECKED-ACP-BODY'), false)
    assert.equal(JSON.stringify(records).includes('Write exactly MINT-OK.'), false)
    observed.push({ records: records.map(event => event.data.name),
      pocket: pocket.map(({ summary, input, output }) => [summary, input, output]),
      shared: shared.map(row => row.name), expected })
  }

  for (const provider of ['acp-claude', 'acp-codex']) {
    const prompt = 'Pick a workflow.'
    const probeTurns = [{ text: textCall, loads: [] }, { text: prompt, loads: [skill.name] }]
    const f = fixture(t, provider, { addedSkills: [manual], probeTurns })
    f.active.add('owner-a')
    const called = await f.preStep(user(manualPrompt))
    const earlier = answer(provider)
    await f.run([called], { record: [called], reply: earlier })
    await f.run([called, earlier, user(prompt)])
    const sent = f.events('prompt')
    const promptBlock = value => ({ text: value, type: 'text' })
    assert.equal(JSON.stringify(sent.map(event => event.prompt)), JSON.stringify([
      [promptBlock(catalog), promptBlock(textCall)], [promptBlock(prompt)],
    ]))
    const expectedResult = { content: [text(skill.content)], isError: false }
    assert.equal(JSON.stringify(f.events('skills-load')[0]?.answer), JSON.stringify(expectedResult))
    const bridge = f.adapter.live.get(f.agent.id).bridge
    const load = (callId, name = skill.name) => fetch(f.bridge.urlFor(bridge), { method: 'POST',
      headers: { authorization: `Bearer ${bridge.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'call', name: 'load_skill', arguments: { name }, callId }),
    }).then(response => response.json())
    assert.equal(JSON.stringify(await load('background-1')), JSON.stringify(expectedResult))
    assert.equal(JSON.stringify(await load('background-1')), JSON.stringify(expectedResult))
    assert.equal(JSON.stringify(await load('background-2')), JSON.stringify(expectedResult))
    assert.equal((await load('inactive', 'missing')).isError, true)
    checkChat(f.agent.session, [manual.name, skill.name, skill.name, skill.name])
  }

  const provider = 'deepseek-official'
  const model = 'fixture-model'
  const f = fixture(t, provider, { addedSkills: [manual] })
  f.active.add('owner-a')
  const session = f.agent.session
  const connection = resolveAdapterOptions({ baseURL: 'https://fixture.invalid', models: [{ id: model, name: model }] })
  const adapter = new DeepSeekAdapter({ options: () => connection,
    resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'fixture',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  const wire = []
  let fail = false
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.equal(url, 'https://fixture.invalid/v1/messages')
    wire.push(body)
    if (fail) return new Response('{}', { status: 400 })
    const events = [
      { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: text('') },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  })
  f.rt.ctx.llm = { stream: options => f.stream(options, () => adapter.stream(options)) }
  const send = messages => Array.fromAsync(f.rt.ctx.llm.stream(markAgentLoopRequest({
    provider, model, sessionId: session.id, messages, signal: t.signal,
  })))
  const called = await f.preStep(user(manualPrompt))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('user/message', called, { surfaceOp: 'append' })
  await send([called])
  await send([called])
  assert.equal(wire[0], wire[1], 'prior activity leaves the serialized manual prompt identical')
  assert.deepEqual(JSON.parse(wire[0]).messages, [{ role: 'user', content: [text(manualPrompt), text(manual.content)] }])
  const callId = 'automatic'
  const args = JSON.stringify({ name: skill.name })
  const call = { ...answer(provider), content: [{ type: 'tool-call', id: callId, name: 'load_skill', arguments: args }] }
  session.append('assistant/message', { turn: 1, step: 0, message: call, stream: [] }, { surfaceOp: 'append' })
  const callSeq = session.append('tool/call', { turn: 1, step: 0, callId, name: 'load_skill', arguments: args }).seq
  const loaded = createToolResultMessage({ callId, content: [f.rt.skillCalls.load(session.id, skill.name)], isError: false })
  session.append('tool/result', { turn: 1, step: 0, message: loaded }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  session.append('step/end', { turn: 1, step: 0 })
  session.append('step/start', { turn: 1, step: 1 })
  await send([called, call, loaded])
  await send([called, call, loaded])
  assert.equal(wire[2], wire[3], 'prior activity leaves the serialized Automatic result identical')
  assert.equal(JSON.stringify(JSON.parse(wire[2]).messages.at(-1).content[0].content), JSON.stringify([text(skill.content)]))
  const failed = await f.preStep(user(manualPrompt))
  session.append('user/message', failed, { surfaceOp: 'append' })
  fail = true
  await assert.rejects(send([called, call, loaded, failed]), /400/)
  checkChat(session, [manual.name, skill.name])

  assert.deepEqual(observed, observed.map(({ expected }) => ({ expected, records: expected, shared: expected,
    pocket: expected.map(name => [name, '', '']),
  })))
})

for (const provider of ['acp-claude', 'acp-codex']) {
  for (const uploaded of [false, true]) {
    test(`person-call order at the ${provider} ${uploaded ? 'prepared upload' : 'text'} prompt`, { timeout: 15_000 }, async t => {
      const probeTurns = [manualPrompt, textCall].map(text => ({ text, loads: [] }))
      const f = fixture(t, provider, { probeTurns, addedSkills: [manual] })
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

async function captureNativeRequest(t, history) {
  const provider = 'deepseek-official'
  const model = 'fixture-model'
  const f = fixture(t, provider, { addedSkills: [manual] })
  f.active.add('owner-a')
  const called = await f.preStep(user(manualPrompt))
  const session = f.agent.session
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
  const messages = history(provider, called)
  const options = markAgentLoopRequest({ provider, model, sessionId: session.id, messages, signal: t.signal })
  await assert.rejects(async () => Array.fromAsync(f.rt.ctx.llm.stream(options)), /400/)
  assert.equal(wire.length, 1)
  assert.equal(wire[0].model, model)
  return { system: wire[0].system, messages: wire[0].messages }
}

test('person-call order in the serialized native request with a late system snapshot', async t => {
  const leading = 'The effective leading system snapshot.'
  const late = 'A system snapshot sent after the person input.'
  const earlier = 'An earlier person message.'
  const wire = await captureNativeRequest(t, (_provider, called) => [
    createSystemMessage('Superseded leading snapshot.'), createSystemMessage(leading),
    user(earlier), createSystemMessage(late), called,
  ])
  assert.deepEqual(wire, {
    system: leading + '\n\n' + catalog,
    messages: [
      { role: 'user', content: [text(earlier), text(manualPrompt), text(manual.content)] },
      { role: 'system', content: [text(late)] },
    ],
  })
})

test('person-call order in the serialized native request after an earlier assistant flush', async t => {
  const leading = 'The initial system snapshot.'
  const earlier = 'An earlier person message.'
  const updated = 'A newer system snapshot.\n  Keep these spaces. '
  const late = 'A system snapshot pending at the person call.'
  const wire = await captureNativeRequest(t, (provider, called) => [
    createSystemMessage(leading), user(earlier), createSystemMessage(updated), answer(provider),
    createSystemMessage(late), called,
  ])
  assert.deepEqual(wire, {
    system: leading,
    messages: [
      { role: 'user', content: [text(earlier)] },
      { role: 'system', content: [text(updated + '\n\n' + catalog)] },
      { role: 'assistant', content: [text('Earlier answer remains')] },
      { role: 'user', content: [text(manualPrompt), text(manual.content)] },
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
