// Native-tools mode (`nativeTools`, #1564): Claude Code keeps its own tools and the dsh bridge
// serves only Automagik's extras. With the setting absent or false nothing changes: the agent's
// built-in tools are off, the bridge serves the whole preset and a built-in call is drift. With
// it on for a Session: the built-ins stay (`disableBuiltInTools: false`) with the hard ask
// rules, the bridge drops DSH's twin of every built-in, a built-in call is no drift, and each
// one still gets its mirror card and DSH's approval at the Session's level.
//
// The config matrix is read straight off the functions; the rest runs the adapter over the fake
// agent on real stdio and DSH's real tool pipeline (its ToolsService, native executor and, for
// Auto, the real Auto review plugin), as own-tools-level-gate.test.js does.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { createAssistantMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { Config } from '../index.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Backchannel, NATIVE_TWIN_TOOLS, offeredTools } from '../src/host/backchannel.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const PROVIDER = 'acp-fake'
const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const AUTO = 'auto'
const CLAUDE = AGENTS['acp-claude']
const MODES = ['default', 'auto', 'bypassPermissions']
const ALLOW = '{"risk":"low","decision":"allow"}'
const DENY = '{"risk":"high","decision":"deny","reason":"no"}'
const flag = value => (typeof value?.get === 'function' ? value.get() : value)

const within = (promise, what, ms = 15_000) => {
  let timer
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} did not finish in ${ms} ms`)), ms) })]).finally(() => clearTimeout(timer))
}
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const callsIn = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map(chunk => chunk.block)
const said = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const resultText = result => (result.content ?? []).map(block => block.text ?? '').join('\n')

// --- the config matrix --------------------------------------------------------------------

// The tools a standard Bot's bridge offers, cut to one of each family: DSH twins of Claude
// Code's built-ins, the DSH subagent family, and the extras.
const PRESET = ['bash', 'job_output', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'skill', 'todo_write', 'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent', 'list_subagent_models', 'working_directory', 'workflow', 'create_goal', 'message_bot', 'ask_user', 'show_view', 'remember', 'recall', 'list_bots', TOOL_NAME]
const EXTRAS = ['working_directory', 'workflow', 'create_goal', 'message_bot', 'ask_user', 'show_view', 'remember', 'recall', 'list_bots']
const toolsCtx = (names = PRESET, sandbox = WRITE) => ({
  get: name => ({
    tools: { definitions: () => names.map(n => ({ name: n, description: n, parameters: { type: 'object', properties: {} } })), executable: () => ({}) },
    sandboxPolicy: { resolve: () => ({ mode: sandbox }) },
    approval: { effectivePolicy: () => 'ask' },
  })[name],
})

test('config: the setting is absent by default, and takes a boolean or Bot names to booleans only', () => {
  assert.equal(flag(Config({}).nativeTools), undefined, 'no schema default: absent is today for everyone')
  assert.equal(flag(Config({ nativeTools: true }).nativeTools), true)
  assert.equal(flag(Config({ nativeTools: false }).nativeTools), false)
  assert.deepEqual(flag(Config({ nativeTools: { Automagik: true } }).nativeTools), { Automagik: true })
  assert.throws(() => Config({ nativeTools: 'yes' }))
  assert.throws(() => Config({ nativeTools: { Automagik: 'yes' } }))
  assert.match(Config.dict.nativeTools.meta.description, /Native commands and edits run in Claude Code, outside DSH's file sandbox\./)
})

test('config: absent or false offers the whole preset; on offers only the extras', () => {
  const agent = { session: {} }
  const all = PRESET.filter(name => name !== TOOL_NAME)
  assert.deepEqual(offeredTools(toolsCtx(), agent).map(tool => tool.name), all)
  assert.deepEqual(offeredTools(toolsCtx(), agent, { native: false }).map(tool => tool.name), all)
  assert.deepEqual(offeredTools(toolsCtx(), agent, { native: true }).map(tool => tool.name), EXTRAS)
  // The step-1 report's DUPLICATE set, plus the DSH subagent family's other two.
  for (const name of ['bash', 'job_output', 'job_list', 'job_kill', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'skill', 'list_agents', 'send_message', 'interrupt_agent', 'subagent', 'subagent_fork', 'todo_write', 'wait_agent', 'list_subagent_models']) {
    assert.ok(NATIVE_TWIN_TOOLS.has(name), name)
  }
  for (const name of EXTRAS) assert.equal(NATIVE_TWIN_TOOLS.has(name), false, name)
})

test('config: which Sessions are in native-tools mode', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const claude = { name: 'Claude', disableBuiltInTools: true }
  const codex = { name: 'Codex' }
  const names = { s1: 'Automagik', s2: 'Sofia' }
  let setting
  let bridge
  const adapter = new AcpAdapter(ctx, new Map([['acp-claude', claude], ['acp-codex', codex]]), {
    dshTools: () => bridge, nativeTools: () => setting, backchannel: {}, botIdentity: id => (names[id] ? { name: names[id] } : undefined),
  })
  t.after(() => adapter.dispose())
  const on = (agent = claude, id = 's1') => adapter.nativeOn(agent, id)
  setting = undefined
  assert.equal(on(), false, 'absent: today')
  setting = false
  assert.equal(on(), false)
  setting = true
  assert.equal(on(), true)
  assert.equal(on(claude, 'plain-chat'), true, 'true is every Claude Code Session')
  assert.equal(on(codex), false, 'an agent whose built-ins the bridge never turns off stays as it is')
  bridge = false
  assert.equal(on(), false, 'the kill switch: no bridge, the agent already has only its own tools')
  bridge = undefined
  setting = { Automagik: true }
  assert.equal(on(claude, 's1'), true, 'one Bot, by its name')
  assert.equal(on(claude, 's2'), false, 'another Bot is untouched')
  assert.equal(on(claude, 'plain-chat'), false)
  setting = { s2: true }
  assert.equal(on(claude, 's2'), true, 'or by its Session id')
  setting = { Automagik: true, s1: false }
  assert.equal(on(claude, 's1'), false, 'a key that says false wins')
  setting = { Automagik: false }
  assert.equal(on(claude, 's1'), false)
  setting = ['Automagik']
  assert.equal(on(claude, 's1'), false, 'not a valid shape: off')
  adapter.nativeTools = () => { throw new Error('unreadable') }
  assert.equal(on(), false, 'an unreadable setting is off')
})

// --- the adapter over the fake agent ------------------------------------------------------

/**
 * One DSH host with the fake agent standing in for Claude Code: its hard asks, drift, modes and
 * built-in switch. `level` is the Session's level (WRITE is Manual, FULL is Full access, AUTO
 * is Auto with the real reviewer, answering `decision`); `answer` is the person's answer to a
 * DSH dialog; `nativeTools` the raw setting; `identity` the Bot name of a Session id.
 */
async function world(t, { level = WRITE, nativeTools, dshTools, answer = 'allowed-once', decision = ALLOW, identity = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-native-tools-'))
  const tracePath = join(dir, 'trace.jsonl')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  const executed = []
  for (const name of ['bash', 'read', 'list_bots']) {
    ctx.tools.register({
      name,
      description: `DSH ${name}`,
      parameters: { type: 'object', properties: {} },
      output: { schema: {}, render: () => [{ type: 'text', text: `ran ${name}` }] },
      async execute() { executed.push(name); return {} },
    })
  }
  const asked = []
  const reviews = []
  let autoLive = false
  const preset = () => (level === AUTO ? (autoLive ? AUTO : 'custom') : level)
  ctx.provide('approval', {
    effectivePolicy: () => (level === FULL ? 'never' : 'ask'),
    overrideOf: () => 'ask',
    request: async (request) => { asked.push(request); return typeof answer === 'function' ? answer(request) : answer },
  })
  ctx.provide('permissionPresets', {
    current: preset,
    set() {},
    registerAuto: () => { autoLive = true; return () => { autoLive = false } },
  })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: level === WRITE ? WRITE : FULL }) })
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('workingDirectory', { ensure: async () => dir })
  ctx.provide('agentPresets', { presetForSession: () => 'standard' })
  ctx.provide('llm', { stream: options => (async function* () {
    reviews.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: decision } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() })
  if (level === AUTO) applyAutoReview(ctx)
  const agents = new Map()
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()], turnBoundaryOf: () => ({ lastTurn: 1 }) })
  const spec = {
    name: 'Fake Claude',
    catalog: { models: async () => [{ id: 'default', name: 'Fake Claude' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_TRACE: tracePath, FAKE_ACP_MODES: MODES.join(',') } }),
    hardAsk: CLAUDE.hardAsk,
    modeFor: CLAUDE.modeFor,
    disableBuiltInTools: true,
    drift: true,
  }
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, spec]]), {
    dshTools: () => dshTools, nativeTools: () => nativeTools, backchannel,
    botIdentity: id => (identity[id] ? { name: identity[id] } : undefined),
  })
  let scopes
  await ctx.plugin({ name: 'test-agents', inject: ['tools'], apply(child) { scopes = child } })
  const pids = () => { try { return new Set(readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid)) } catch { return new Set() } }
  t.after(async () => {
    for (const pid of pids()) { try { process.kill(pid, 'SIGKILL') } catch {} }
    adapter.dispose()
    backchannel.dispose()
    await ctx.root.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const chat = (id) => {
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
    const agent = { session, status: 'idle' }
    const scope = createScope(scopes, agent)
    t.after(() => scope.dispose())
    agent.ctx = scope.ctx
    agents.set(id, agent)
    adapter.registerMirror(agent)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const { name, description, parameters } = adapter.tool
    session.append('request/header', { header: { config: { provider: PROVIDER, model: 'default' }, tools: [{ name, description, parameters }] } })
    const messages = []
    const step = () => within((async () => {
      const chunks = []
      for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: PROVIDER, model: 'default', sessionId: id, messages }))) chunks.push(chunk)
      messages.push({ role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: 'default' }, content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) })
      return chunks
    })(), 'the step')
    const run = block => within((async () => {
      session.append('assistant/message', {
        turn: 1, step: 1, stream: [],
        message: createAssistantMessage({ content: [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }], source: { provider: PROVIDER, model: 'default' } }),
      }, { surfaceOp: 'append' })
      const signal = new AbortController().signal
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: PROVIDER, model: 'default' }, signal })
      try {
        const batch = await ctx.tools.execute({ calls: [{ id: block.id, name: block.name, arguments: block.arguments }], agent, signal, log: { turn: 1, step: 1 }, toolSet, maxParallelToolCalls: 1 })
        const result = batch.results[0].result
        messages.push({ role: 'tool', toolCallId: block.id, source: { kind: 'tool', callId: block.id }, content: result.content })
        return result
      } finally {
        toolSet.dispose()
      }
    })(), 'the tool call')
    const say = text => messages.push(said(text))
    const drifts = () => session.snapshotEvents().filter(event => event.type === 'plugin:acp-dsh/toolset-drift')
    // Every mirror call of the turn run in order until the agent's answer ends it.
    const turn = async (text) => {
      say(text)
      const mirrors = []
      for (let i = 0; i < 8; i++) {
        const chunks = await step()
        const calls = callsIn(chunks)
        if (calls.length === 0) return { chunks, mirrors }
        for (const call of calls) mirrors.push({ call, result: await run(call) })
      }
      throw new Error('the turn did not end')
    }
    return { id, session, step, run, say, turn, drifts }
  }
  const trace = () => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  const events = name => trace().filter(entry => entry.event === name)
  return { adapter, chat, asked, reviews, executed, events }
}

const hardAskMeta = () => CLAUDE.hardAsk()

for (const [label, setting] of [['absent', undefined], ['false', false]]) {
  test(`${label}: built-ins off, the whole preset on the bridge, and a built-in call is drift (today)`, async (t) => {
    const w = await world(t, { nativeTools: setting })
    const c = w.chat('s1')
    // "hold": the fake turn ends only when it is cancelled, and it traces the cancel before it
    // ends, so the cancel below is observed, not raced against the end of the turn.
    const { chunks, mirrors } = await c.turn('native-read hold')
    assert.deepEqual(w.events('new-session')[0].meta, { disableBuiltInTools: true })
    assert.deepEqual(w.events('mcp-list')[0].tools.sort(), ['bash', 'list_bots', 'read'])
    assert.deepEqual(mirrors, [], 'a drifted call gets no card')
    assert.equal(c.drifts().length, 1, 'recorded as toolset drift')
    assert.equal(chunks.at(-1).reason.kind, 'aborted', 'and the turn is cancelled')
    assert.ok(w.events('cancel').length >= 1, 'by session/cancel to the agent')
  })
}

test('on: built-ins on with the hard asks, only the extras on the bridge, a native Read is a card and no drift', async (t) => {
  const w = await world(t, { nativeTools: true })
  const c = w.chat('s1')
  const { chunks, mirrors } = await c.turn('native-read')
  assert.deepEqual(w.events('new-session')[0].meta, { ...hardAskMeta(), disableBuiltInTools: false })
  assert.deepEqual(w.events('mcp-list')[0].tools, ['list_bots'], 'DSH twins of the built-ins are not offered')
  assert.equal(c.drifts().length, 0)
  assert.equal(w.events('cancel').length, 0)
  assert.equal(mirrors.length, 1)
  assert.equal(mirrors[0].call.name, TOOL_NAME, 'the native call shows as its mirror card')
  assert.equal(JSON.parse(mirrors[0].call.arguments).title, 'Read notes.txt')
  assert.match(resultText(mirrors[0].result), /the notes/)
  assert.equal(w.asked.length, 0, 'a Read Claude Code did not ask about asks nobody')
  assert.match(textIn(chunks), /I read the notes\./)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('on: an Automagik extra still runs over the bridge, and a twin is refused there', async (t) => {
  const w = await world(t, { nativeTools: true })
  const c = w.chat('s1')
  const extra = await c.turn('bridge list_bots')
  assert.match(textIn(extra.chunks), /The bridge said: ran list_bots/)
  assert.deepEqual(extra.mirrors, [], 'a bridge call has no mirror card')
  const twin = await c.turn('bridge bash')
  assert.match(textIn(twin.chunks), /not offered to this Session/)
  assert.deepEqual(w.executed, ['list_bots'], "DSH's bash never ran")
})

test('on for one Bot: that Bot gets native tools, another Bot keeps today', async (t) => {
  const w = await world(t, { nativeTools: { Automagik: true }, identity: { s1: 'Automagik', s2: 'Sofia' } })
  await w.chat('s1').turn('plain')
  await w.chat('s2').turn('plain')
  const metas = w.events('new-session').map(entry => entry.meta)
  assert.equal(metas.length, 2)
  assert.ok(metas.some(meta => meta.disableBuiltInTools === false), 'the named Bot')
  assert.ok(metas.some(meta => meta.disableBuiltInTools === true), 'the other Bot')
  const lists = w.events('mcp-list').map(entry => [...entry.tools].sort().join(','))
  assert.deepEqual(lists.sort(), ['bash,list_bots,read', 'list_bots'])
})

test('on: turning it on takes effect on the next turn, in a new agent session', async (t) => {
  let setting
  const w = await world(t)
  w.adapter.nativeTools = () => setting
  const c = w.chat('s1')
  await c.turn('plain')
  setting = true
  await c.turn('plain')
  assert.deepEqual(w.events('new-session').map(entry => entry.meta.disableBuiltInTools), [true, false])
})

// --- approvals at each level ----------------------------------------------------------------

test('Manual: a native Bash asks DSH first, with Claude Code in its default mode', async (t) => {
  const w = await world(t, { nativeTools: true, level: WRITE })
  const c = w.chat('s1')
  const { chunks, mirrors } = await c.turn('native-bash')
  // The fake starts in `default`, so Manual never switches it.
  assert.deepEqual(w.events('set-mode').map(entry => entry.modeId), [])
  assert.equal(w.asked.length, 1, 'DSH asked the person')
  assert.equal(w.asked[0].toolName, TOOL_NAME)
  assert.match(w.asked[0].reason, /echo native/)
  assert.equal(mirrors.length, 1)
  assert.equal(w.events('native-tool-ran').length, 1)
  assert.match(textIn(chunks), /It printed native\./)
})

test('Manual: a native call the person rejects never runs', async (t) => {
  const w = await world(t, { nativeTools: true, level: WRITE, answer: 'rejected' })
  const c = w.chat('s1')
  const { chunks } = await c.turn('native-bash')
  assert.equal(w.asked.length, 1)
  assert.equal(w.events('native-tool-ran').length, 0, 'the call never ran')
  assert.equal(w.events('native-tool-refused')[0].answer, 'no', "the agent got its own reject option")
  assert.match(textIn(chunks), /I was not allowed to run it\./)
})

test('Auto: Claude Code is in its auto mode, and DSH Auto review answers what it asks', async (t) => {
  const w = await world(t, { nativeTools: true, level: AUTO, decision: ALLOW })
  const c = w.chat('s1')
  const { chunks } = await c.turn('native-bash')
  assert.deepEqual(w.events('set-mode').map(entry => entry.modeId), ['auto'])
  assert.equal(w.reviews.length, 1, 'the reviewer read the call')
  assert.equal(w.asked.length, 0, 'its allow answered the question, the person was not asked')
  assert.equal(w.events('native-tool-ran').length, 1)
  assert.match(textIn(chunks), /It printed native\./)
})

test('Auto: a call the reviewer denies goes to the person, and their no means it never runs', async (t) => {
  const w = await world(t, { nativeTools: true, level: AUTO, decision: DENY, answer: 'rejected' })
  const c = w.chat('s1')
  const { mirrors } = await c.turn('native-bash')
  assert.equal(w.reviews.length, 1)
  assert.equal(w.asked.length, 1)
  assert.match(w.asked[0].reason, /^Auto review denied tool "acp_tool"/)
  assert.equal(mirrors[0].result.isError, true)
  assert.equal(w.events('native-tool-ran').length, 0)
})

test('Full: bypassPermissions, no hard asks injected, and nothing is asked', async (t) => {
  const w = await world(t, { nativeTools: true, level: FULL })
  const c = w.chat('s1')
  const { chunks } = await c.turn('native-bash')
  assert.deepEqual(w.events('new-session')[0].meta, { disableBuiltInTools: false })
  assert.deepEqual(w.events('set-mode').map(entry => entry.modeId), ['bypassPermissions'])
  assert.equal(w.asked.length, 0)
  assert.equal(w.events('native-tool-ran').length, 1)
  assert.match(textIn(chunks), /It printed native\./)
})

// --- a native subagent ------------------------------------------------------------------------

test("a subagent's nested call asks DSH while its Agent card waits, and runs once allowed", async (t) => {
  const w = await world(t, { nativeTools: true, level: WRITE })
  const c = w.chat('s1')
  const { chunks, mirrors } = await c.turn('native-agent')
  assert.equal(w.asked.length, 1, 'the nested question reached DSH')
  assert.match(w.asked[0].reason, /echo native/)
  assert.equal(w.events('native-tool-ran').length, 1)
  assert.deepEqual(mirrors.map(m => JSON.parse(m.call.arguments).title), ['Look around', 'echo native'], 'the Agent card, then its step')
  assert.match(resultText(mirrors[0].result), /subagent report \(yes\)/)
  assert.match(textIn(chunks), /The subagent reported \(yes\)\./)
})

test("a subagent's nested call the person rejects never runs", async (t) => {
  const w = await world(t, { nativeTools: true, level: WRITE, answer: 'rejected' })
  const c = w.chat('s1')
  const { chunks } = await c.turn('native-agent')
  assert.equal(w.asked.length, 1)
  assert.equal(w.events('native-tool-ran').length, 0)
  assert.equal(w.events('native-tool-refused')[0].answer, 'no')
  assert.match(textIn(chunks), /The subagent reported \(no\)\./)
})
