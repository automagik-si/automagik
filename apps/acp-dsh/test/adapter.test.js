// The adapter against the fake agent over real stdio, driven the way DSH's agent loop drives a
// model: stream a step, run the tool calls it ends on, stream the next step with the results.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ToolNotFoundError } from '@deepseek-ai/dsh-tools'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { apply } from '../index.js'
import { structuredNameOf } from '../src/host/acp.js'
import { AcpAdapter, aside, choose, NOTICE_KIND, promptOf, SIDE_MODEL } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Backchannel, NATIVE_TWIN_TOOLS, offeredTools, presetOf } from '../src/host/backchannel.js'
import { CliHomes } from '../src/host/cli-homes.js'
import { isAuthRequired, SYNTHETIC_KIND } from '../src/host/names.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'
import { credentialShapes } from '../src/host/redact.js'
import { BOUNDARY_KIND, crossed } from '../src/host/switch.js'
import { mirrorTool, optionFor, TOOL_NAME } from '../src/host/tool.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')

function host({ answer = 'allowed-once' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-dsh-'))
  const registered = {}
  const asked = []
  const disposers = []
  // What the fake scope's tools.register recorded, and which registrations were disposed (#667).
  const registrations = []
  const disposals = []
  const agents = new Map()
  const scopes = new Map()
  const listeners = new Map()
  // What the adapter writes to the Session's log itself: DSH's session.append, recorded. A test
  // that sets `h.log` gets each message there too, where DSH would put it in the chat.
  const appended = []
  const append = (type, data, options) => {
    appended.push({ type, data, options })
    h.log?.push(data)
    return { seq: appended.length }
  }
  // One Session's agent: its own scoped tools, each with the step condition it registered.
  const addAgent = (id, provider = 'acp-fake') => {
    const tools = new Map()
    const names = []
    const conditions = new Map()
    const agent = {
      session: { id, header: { cwd }, append },
      model: { current: () => ({ provider, model: 'default' }) },
      options: { provider },
      // Idle by default; DSH dispatches agent/status on the running -> idle edge.
      status: 'idle',
      ctx: {
        tools: {
          register: (def, options = {}) => {
            // dsh-tools refuses a second registration of one name in one scope: this is the
            // "already registered in this scope" failure a plugin reload used to hit (#667).
            if (tools.has(def.name)) throw new Error(`already registered in this scope: ${def.name}`)
            names.push(def.name)
            tools.set(def.name, def)
            conditions.set(def.name, options.when)
            let live = true
            const dispose = () => {
              if (!live) return
              live = false
              tools.delete(def.name)
              conditions.delete(def.name)
              const at = names.indexOf(def.name)
              if (at !== -1) names.splice(at, 1)
              disposals.push({ id, name: def.name })
            }
            registrations.push({ id, name: def.name, dispose })
            return dispose
          },
        },
      },
    }
    agents.set(id, agent)
    scopes.set(id, { tools, names, conditions })
    return agent
  }
  // What dsh-agent-loop's preStep resolves before the adapter streams a step: the scope's
  // visible tools whose registration condition admits this step's model selection, the way
  // dsh-tools' ToolsService.resolve evaluates `when`.
  const admit = async (id, modelSelection) => {
    const { tools, conditions } = scopes.get(id)
    const admitted = new Map()
    for (const [name, definition] of tools) {
      const when = conditions.get(name)
      const context = { agent: agents.get(id), modelSelection, signal: new AbortController().signal }
      if (when === undefined || await when(context)) admitted.set(name, definition)
    }
    return admitted
  }
  const agent = addAgent('s1')
  const ctx = {
    llm: { registerAdapter: (providers, adapter) => { for (const id of providers) registered[id] = adapter; return () => {} } },
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    get: name => (name === 'approval' ? { request: async (req) => { asked.push(req); return typeof answer === 'function' ? answer(req) : answer } } : undefined),
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} },
    effect: (fn) => { disposers.push(fn()) },
    provide: (name, service) => { provided[name] = service },
  }
  const provided = {}
  // The old path, explicitly: dshTools defaults on, so this host is the kill-switch suite.
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: false })
  const close = () => { for (const fn of disposers) fn(); rmSync(cwd, { recursive: true, force: true }) }
  const h = {
    adapter: registered['acp-fake'],
    agent,
    agents,
    addAgent,
    admit,
    tools: scopes.get('s1').tools,
    toolsOf: id => scopes.get(id).tools,
    namesOf: id => scopes.get(id).names,
    // DSH dispatches agent/created after the agent's scoped setup and before queued input.
    emit: (name, payload) => { for (const listener of listeners.get(name) ?? []) listener(payload) },
    asked,
    appended,
    close,
    registered,
    ctx,
    registrations,
    disposals,
    provided,
    // A plugin reload: the old module and adapter go, DSH keeps the agents and their scoped
    // tools, and the reloaded adapter is constructed over them (its constructor takes over the
    // agents that are idle). Old listeners are not re-emitted here, as DSH disposed them.
    reload: () => new AcpAdapter(ctx, new Map([['acp-fake', {}]]), { dshTools: () => false }),
  }
  return h
}

async function step(adapter, messages, { signal, onChunk, model = 'default', effort, provider = 'acp-fake' } = {}) {
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model, ...(effort ? { reasoningEffort: effort } : {}), sessionId: 's1', messages, signal }))) {
    chunks.push(chunk)
    onChunk?.(chunks)
  }
  return chunks
}

test('isolated chat without a working folder uses its Bot home; explicit project cwd stays',
  async t => {
    for (const explicit of [false, true]) {
      const h = host()
      t.after(h.close)
      const project = h.agent.session.header.cwd
      const homes = new CliHomes(join(project, 'private'))
      t.after(() => homes.dispose())
      const env = homes.environment('claude')
      const agent = h.adapter.agents.get('acp-fake')
      const original = agent.spawn
      agent.spawn = () => ({ ...original(), env })
      if (!explicit) delete h.agent.session.header.cwd
      await step(h.adapter, [{ role: 'user', content: 'hello' }])
      assert.equal(h.adapter.live.get('s1').run.spec.cwd, explicit ? project : env.HOME)
    }
  })

// One DSH turn: steps until the model stops, tool calls run between them like DSH runs them.
async function turn(h, messages, text, choice = {}) {
  messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const steps = []
  for (;;) {
    const chunks = await step(h.adapter, messages, choice)
    steps.push(chunks)
    const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    messages.push({ role: 'assistant', source: { kind: 'model', provider: 'acp-fake', model: choice.model ?? 'default' }, content: blocks })
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    if (finish.reason.kind !== 'tool-calls') return { steps, finish }
    for (const call of blocks.filter(block => block.type === 'tool-call')) {
      const tool = h.tools.get(call.name)
      assert.ok(tool, `${call.name} is registered in the agent's scope before its call`)
      const args = JSON.parse(call.arguments)
      const value = await tool.execute(args, { agent: h.agent, callId: call.id, signal: new AbortController().signal })
      messages.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: tool.output.render(args, value), meta: tool.output.presentationMeta(args, value) })
      steps.at(-1).result = { args, value, call: tool.presentCall(args), view: tool.presentResult(args, { content: tool.output.render(args, value), isError: false, meta: value }) }
    }
  }
}

const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const thoughtIn = chunks => chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')

test('a turn streams text, ends its step at the tool call, asks DSH, and goes on after the result', async () => {
  const h = host()
  try {
    const messages = []
    const { steps, finish } = await turn(h, messages, 'hi')
    assert.equal(finish.reason.kind, 'stop')
    assert.equal(steps.length, 2)
    const [first, second] = steps
    assert.equal(textIn(first), 'Fake agent, turn 1: you said "hi".')
    assert.ok(first.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'Thinking it over.'))
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
    assert.equal(call.name, TOOL_NAME)
    assert.deepEqual(JSON.parse(call.arguments), { id: 'call-1-1', title: 'Run echo hello 1', kind: 'execute', input: { command: 'echo hello 1' } })
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    // The card: a terminal with the command, then its output.
    assert.deepEqual(first.result.call, { card: 'terminal', title: 'Run echo hello 1', description: 'echo hello 1' })
    assert.deepEqual(first.result.view, { card: 'terminal', title: 'Run echo hello 1', output: 'hello 1' })
    assert.equal(first.result.value.status, 'completed')
    // DSH's approval service was asked, about this exact call.
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].toolName, TOOL_NAME)
    assert.equal(h.asked[0].callId, call.id)
    assert.equal(h.asked[0].agent, h.agent)
    assert.match(h.asked[0].reason, /Fake agent: Run echo hello 1/)
    assert.equal(textIn(second), ' It printed hello 1.')
    // A second turn goes to the same agent session.
    const next = await turn(h, messages, 'again')
    assert.match(textIn(next.steps[0]), /turn 2: you said "again"/)
  } finally {
    h.close()
  }
})

test('a rejection reaches the agent, and each of several calls gets its own step and question', async () => {
  let n = 0
  const h = host({ answer: () => (++n === 1 ? 'rejected' : 'allowed-once') })
  try {
    const { steps } = await turn(h, [], 'do it twice')
    assert.equal(steps.length, 3)
    assert.equal(steps[0].result.value.status, 'failed')
    assert.equal(textIn(steps[1]), ' I was not allowed to run it.')
    assert.equal(steps[1].result.value.status, 'completed')
    assert.equal(textIn(steps[2]), ' It printed hello 2.')
    assert.equal(h.asked.length, 2)
  } finally {
    h.close()
  }
})

test('stopping the turn cancels the agent and finishes aborted', async () => {
  const h = host()
  try {
    const controller = new AbortController()
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hang' }] }]
    // Stop once the agent has said its words and is waiting on "hang": a reaction to the
    // stream, not a timer, so a slow start under load cannot abort before the agent speaks.
    const chunks = await step(h.adapter, messages, {
      signal: controller.signal,
      onChunk: seen => { if (!controller.signal.aborted && /you said "hang"/.test(textIn(seen))) controller.abort() },
    })
    assert.ok(controller.signal.aborted, 'the step was still streaming when it was stopped')
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
    assert.match(textIn(chunks), /you said "hang"/)
    // The next turn starts cleanly on the same process.
    const next = await turn(h, [...messages, { role: 'assistant', source: { kind: 'model' }, content: [] }], 'hi')
    assert.equal(next.finish.reason.kind, 'stop')
  } finally {
    h.close()
  }
})

// DSH's side requests on an agent's route: a Session title goes to DSH's default model when
// that is not an agent, else to sideModel (DeepSeek by default), without the agent's effort;
// every other side request (a compaction summary) is refused. The agent never sees them.
const drain = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const codeOf = chunks => chunks.at(-1)?.reason?.failure?.code

test('a Session title or Auto review on an agent\'s chat goes to DSH\'s default model, or to sideModel when the default is an agent', async () => {
  let passed = 0
  const next = () => { passed++; return (async function* () {})() }
  const sent = []
  let selection = { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'max' }
  let side = SIDE_MODEL
  const ctx = {
    llm: { stream: options => { sent.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() } },
    get: name => (name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined),
  }
  const listen = aside(new Map([['acp-fake', {}]]), ctx, () => side, credentialShapes)
  const title = { provider: 'acp-fake', model: 'fake', reasoningEffort: 'high', maxTokens: 4096, sessionId: 's1', purpose: 'session-title', messages: [] }
  const route = async () => { sent.length = 0; const chunks = await drain(listen(title, next)); return sent.length === 1 ? `${sent[0].provider}/${sent[0].model}` : codeOf(chunks) }

  assert.equal(await route(), 'deepseek-official/deepseek-v4')
  assert.deepEqual(sent, [{ provider: 'deepseek-official', model: 'deepseek-v4', maxTokens: 4096, sessionId: 's1', purpose: 'session-title', messages: [] }])
  // The person last picked an agent (DSH's default follows every pick), or there is no default.
  for (const agentDefault of [{ provider: 'acp-fake', model: 'default' }, { provider: 'acp-claude', model: 'default' }, undefined]) {
    selection = agentDefault
    assert.equal(await route(), 'deepseek-official/deepseek-flash')
  }
  side = { provider: 'anthropic', model: 'claude-haiku-5-5' }
  assert.equal(await route(), 'anthropic/claude-haiku-5-5')
  // An agent or malformed sideModel is ignored; the built-in DeepSeek fallback is still tried.
  for (const unusable of [{ provider: 'acp-codex', model: 'default' }, { provider: 'deepseek-official' }, undefined]) {
    side = unusable
    assert.equal(await route(), 'deepseek-official/deepseek-flash')
  }
  // With nothing that can answer beside the chat (the built-in is an agent route here too):
  const blocked = aside(new Map([['acp-fake', {}], ['deepseek-official', {}]]), ctx)
  assert.equal(codeOf(await drain(blocked(title, next))), 'UNSUPPORTED')

  // Auto review on the same route: the same non-agent route, with its own system, messages and
  // temperature kept and the Session text redacted before the reviewer sees it.
  selection = { provider: 'deepseek-official', model: 'deepseek-v4' }
  side = SIDE_MODEL
  const review = {
    ...title,
    purpose: 'auto-review',
    system: 'review policy',
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'echo sk-abcdef123456' }] }],
  }
  sent.length = 0
  await drain(listen(review, next))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].provider, 'deepseek-official')
  assert.equal(sent[0].model, 'deepseek-v4')
  assert.equal(sent[0].purpose, 'auto-review')
  assert.equal(sent[0].system, 'review policy')
  assert.equal(sent[0].temperature, 0)
  assert.equal('reasoningEffort' in sent[0], false)
  assert.doesNotMatch(JSON.stringify(sent[0].messages), /sk-abcdef123456/)
  assert.match(JSON.stringify(sent[0].messages), /sk-\[hidden\]/)
  // No non-agent side model: the built-in fallback answers, never the agent.
  selection = undefined
  side = { provider: 'acp-codex', model: 'default' }
  sent.length = 0
  await drain(listen(review, next))
  assert.deepEqual(sent.map(options => `${options.provider}/${options.model}`),
    ['deepseek-official/deepseek-flash'])

  // Any other side request on an agent's route is refused, whatever the default.
  selection = { provider: 'deepseek-official', model: 'deepseek-v4' }
  side = SIDE_MODEL
  sent.length = 0
  for (const purpose of ['compaction', undefined]) assert.equal(codeOf(await drain(listen({ ...title, purpose }, next))), 'UNSUPPORTED')
  assert.equal(sent.length, 0)

  // The agent loop's own requests, and other providers', go on.
  await drain(listen(markAgentLoopRequest({ provider: 'acp-fake', messages: [] }), next))
  await drain(listen({ provider: 'deepseek-official', purpose: 'compaction', messages: [] }, next))
  assert.deepEqual([passed, sent.length], [2, 0])
})

test('a leaked synthetic bridge block never reaches a native provider', async () => {
  const sent = []
  const ctx = { llm: { stream: options => { sent.push(options); return (async function* () {})() } } }
  const listen = aside(new Map([['acp-fake', {}]]), ctx, () => SIDE_MODEL, credentialShapes)
  const synthetic = {
    role: 'assistant',
    source: { kind: 'model', provider: 'acp-fake', bridge: true, synthetic: SYNTHETIC_KIND },
    content: [{ type: 'tool-call', id: 'bridge-1', name: 'bridge_synthetic', arguments: '{}' }],
  }
  const question = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
  await drain(listen({ provider: 'deepseek-official', model: 'deepseek-v4', messages: [question, synthetic] }, () => {
    throw new Error('the cleaned request should be re-streamed')
  }))
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].messages, [question])
  assert.equal(sent[0].provider, 'deepseek-official')
})

// The same through DSH's own llm service and DSH's own default-model service, saved on an agent
// as it is after the person picks one: the listener's nested call passes through the waterfall
// again, the team's first configured non-agent model answers the title, and the agent's adapter
// sees no side request.
test('through DSH llm services, an agent-chat title runs on the team model', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const { default: AgentDefaultModel } = await import('@deepseek-ai/dsh-agent-default-model')
  const seen = []
  class Route extends LlmAdapter {
    constructor(name) { super(); this.name = name }
    async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 100000, maxOutputTokens: 8000 } }
    async *stream(options) {
      seen.push({ adapter: this.name, provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, agentLoop: isAgentLoopRequest(options) })
      yield { type: 'text-delta', index: 0, text: `from ${this.name}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentDefaultModel, { provider: 'acp-fake', model: 'default' })
  assert.deepEqual(ctx.get('agentDefaultModel').currentSelection(), { provider: 'acp-fake', model: 'default' })
  ctx.llm.registerAdapter(['acp-fake'], new Route('agent'))
  ctx.llm.registerAdapter(['deepseek-official'], new Route('deepseek'))
  ctx.on('llm/stream', aside(new Map([['acp-fake', {}]]), ctx))
  const run = async options => { let text = ''; let last; for await (const chunk of ctx.llm.stream(options)) { if (chunk.type === 'text-delta') text += chunk.text; last = chunk } return text || last?.reason?.failure?.code }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Name this chat' }] }]
  assert.equal(await run({ provider: 'acp-fake', model: 'default', reasoningEffort: 'high', purpose: 'session-title', messages }), 'from deepseek')
  assert.equal(await run({ provider: 'acp-fake', model: 'default', purpose: 'compaction', messages }), 'UNSUPPORTED')
  assert.equal(await run(markAgentLoopRequest({ provider: 'acp-fake', model: 'default', messages })), 'from agent')
  assert.deepEqual(seen, [
    {
      adapter: 'deepseek', provider: 'deepseek-official', model: 'm',
      reasoningEffort: undefined, agentLoop: false,
    },
    { adapter: 'agent', provider: 'acp-fake', model: 'default', reasoningEffort: undefined, agentLoop: true },
  ])
})

test('the plugin sends titles on its agents\' routes to its sideModel setting when DSH\'s default is an agent', async () => {
  const listeners = new Map()
  const sent = []
  const defaults = { currentSelection: () => ({ provider: 'acp-fake', model: 'default' }) }
  const ctx = {
    llm: {
      registerAdapter: () => () => {},
      stream: options => {
        sent.push(options)
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      },
    },
    agents: { get: () => undefined },
    get: name => (name === 'agentDefaultModel' ? defaults : undefined),
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
  }
  let side = { provider: 'deepseek-official', model: 'deepseek-v4' }
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false, sideModel: { get: () => side } })
  // The waterfall: the listeners registered on llm/stream, the last wrapping the next.
  const call = (options) => {
    let next = () => assert.fail('the agent got a side request')
    for (const listener of [...(listeners.get('llm/stream') ?? [])].reverse()) {
      const rest = next
      next = () => listener(options, rest)
    }
    return next()
  }
  const title = () => drain(call({
    provider: 'acp-fake', model: 'default', purpose: 'session-title', messages: [],
  }))
  assert.deepEqual(await title(), [{ type: 'finish', reason: { kind: 'stop' } }])
  // A live setting: the next title reads the new value.
  side = { provider: 'anthropic', model: 'claude-haiku-5-5' }
  await title()
  assert.deepEqual(sent.map(options => `${options.provider}/${options.model}`), ['deepseek-official/deepseek-v4', 'anthropic/claude-haiku-5-5'])
})

test('Auto review uses a Claude route when the team has no DeepSeek key', async () => {
  const listeners = new Map()
  const sent = []
  const routes = {
    'deepseek-official': [{ id: 'deepseek-flash' }],
    anthropic: [{ id: 'claude-sonnet-4-5' }],
  }
  const ctx = {
    llm: {
      registerAdapter: () => () => {},
      listProviders: () => [{ id: 'deepseek-official' }, { id: 'anthropic' }, { id: 'acp-fake' }],
      listModels: async provider => routes[provider] ?? [],
      stream: options => {
        sent.push(`${options.provider}/${options.model}`)
        return (async function* () {
          if (options.provider === 'deepseek-official') {
            yield { type: 'finish', reason: { kind: 'error', failure: {
              message: 'no API key', code: 'MISSING_CREDENTIAL',
            } } }
            return
          }
          yield { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    agents: { get: () => undefined },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'acp-fake', model: 'default' }) }
      : undefined),
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
  }
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false })
  const call = (options) => {
    let next = () => assert.fail('the agent got a side request')
    for (const listener of [...(listeners.get('llm/stream') ?? [])].reverse()) {
      const rest = next
      next = () => listener(options, rest)
    }
    return next()
  }
  const chunks = await drain(call({
    provider: 'acp-fake', model: 'default', purpose: 'auto-review', messages: [],
  }))
  // The hard-coded DeepSeek default is refused by its missing key; the Claude route answers.
  assert.deepEqual(sent, ['deepseek-official/deepseek-flash', 'anthropic/claude-sonnet-4-5'])
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text,
    '{"risk":"low","decision":"allow"}')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('an Auto review with no reachable reviewer surfaces the last failure', async () => {
  const sent = []
  const ctx = {
    llm: {
      registerAdapter: () => () => {},
      listProviders: () => [{ id: 'deepseek-official' }, { id: 'anthropic' }],
      listModels: async provider => (provider === 'anthropic'
        ? [{ id: 'claude' }]
        : [{ id: 'deepseek-flash' }]),
      stream: options => {
        sent.push(`${options.provider}/${options.model}`)
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: {
            message: `${options.provider} has no key`, code: 'MISSING_CREDENTIAL',
          } } }
        })()
      },
    },
    get: () => undefined,
  }
  const listen = aside(new Map([['acp-fake', {}]]), ctx)
  const review = { provider: 'acp-fake', model: 'default', purpose: 'auto-review', messages: [] }
  const chunks = await drain(listen(review, () => {
    throw new Error('the agent got a side request')
  }))
  // Both configured candidates were tried (the built-in DeepSeek Flash dedupes with the first
  // route); the last failure is the answer, and no failure is turned into a decision.
  assert.deepEqual(sent, ['deepseek-official/deepseek-flash', 'anthropic/claude'])
  assert.equal(chunks.at(-1).reason.failure.code, 'MISSING_CREDENTIAL')
  assert.doesNotMatch(JSON.stringify(chunks), /decision/)
})

test('sideModel is a live setting, DeepSeek Flash by default', async () => {
  const { resolveConfig } = await import('@deepseek-ai/cordis')
  const plugin = await import('../index.js')
  const config = resolveConfig(plugin, {})
  assert.deepEqual({ ...(typeof config.sideModel?.get === 'function' ? config.sideModel.get() : config.sideModel) }, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(typeof config.sideModel?.get, 'function', 'a volatile field resolves to a reference')
})

test('an agent that cannot start fails the step with its reason', async () => {
  const registered = {}
  // The Session's agent exists (scope finds it); the agent's process is what cannot start.
  // The old path, explicitly: dshTools defaults on, so the failure is the agent's spawn.
  const agent = { session: { id: 's9' }, ctx: { tools: { register: () => () => {} } } }
  const ctx = { llm: { registerAdapter: (providers, adapter) => { for (const id of providers) registered[id] = adapter } }, agents: { get: id => (id === 's9' ? agent : undefined) }, get: () => undefined }
  const fake = join(import.meta.dirname, 'fixtures', 'no-such-agent.mjs')
  apply(ctx, { fakeAgent: fake, claude: false, codex: false, dshTools: false })
  const chunks = []
  for await (const chunk of registered['acp-fake'].stream(markAgentLoopRequest({ provider: 'acp-fake', model: 'default', sessionId: 's9', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /Fake agent did not start/)
})

// An agent whose CLI is signed out answers ACP's auth_required. The turn fails with its own
// code (the Bot team asks for a sign-in and never falls back on it), whether the refusal comes
// when its session opens or on a prompt. Any other agent error keeps ACP_AGENT.
for (const where of ['session', 'prompt']) {
  test(`a signed-out agent (auth_required on ${where}) fails the step as MODEL_ACCESS_REQUIRED`, async (t) => {
    process.env.FAKE_ACP_AUTH = where
    t.after(() => { delete process.env.FAKE_ACP_AUTH })
    const h = host()
    const signedOut = []
    const told = h.adapter.onSignedOut
    h.adapter.onSignedOut = (id) => { signedOut.push(id); told?.(id) }
    try {
      const chunks = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }])
      const reason = chunks.at(-1).reason
      assert.equal(reason.kind, 'error')
      assert.equal(reason.failure.code, 'MODEL_ACCESS_REQUIRED')
      assert.deepEqual(signedOut, ['acp-fake'], 'the host drops its cached sign-in for that agent')
      assert.match(reason.failure.message, /^Fake agent is not signed in: Authentication required/)
    } finally {
      h.close()
    }
  })
}

test('isAuthRequired reads only ACP\'s auth_required, not every -32000 server error', () => {
  assert.equal(isAuthRequired({ code: -32000, message: 'Authentication required' }), true)
  assert.equal(isAuthRequired({ code: -32000, message: 'Authentication required: run login' }), true)
  assert.equal(isAuthRequired({ code: -32000, message: 'permission failed' }), false)
  assert.equal(isAuthRequired({ code: -32603, message: 'Authentication required' }), false)
  assert.equal(isAuthRequired(undefined), false)
})

// #661: DSH resolves a step's admitted tool set in preStep, before the adapter streams that
// step. A new chat's first step is resolved right after its agent is created, so a registration
// made lazily when the stream starts is too late for it: the mirrored acp_tool call was
// ToolNotFoundError UNKNOWN_TOOL until the next step. The adapter registers it on agent/created.
test('a fresh Session\'s first mirrored call resolves from agent/created, in its own scope only', async () => {
  const h = host()
  try {
    // Another Session on the same route (the event may reach it later), and DSH's own Session
    // on another provider: registration is per agent, and the step condition admits only ACP.
    const second = h.addAgent('s2')
    const native = h.addAgent('native', 'deepseek-official')

    // What DSH does when it creates the agent: announce it, then resolve the first step's tools.
    h.emit('agent/created', { agent: h.agent })
    h.emit('agent/created', { agent: native })

    // The first step's admitted set, as dsh-agent-loop's preStep resolves it before streaming.
    // Pre-fix it has no acp_tool: scope() only registers it once this stream has begun.
    const admitted = await h.admit('s1', { provider: 'acp-fake', model: 'default' })
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
    const first = await step(h.adapter, messages)
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
    assert.equal(call?.name, TOOL_NAME)
    const tool = admitted.get(call.name)
    // Exactly what dsh-tools raises for a call outside the step's admitted set: on the
    // pre-fix behaviour this test fails here with `unknown tool "acp_tool"` (UNKNOWN_TOOL).
    if (tool === undefined) throw new ToolNotFoundError(call.name)

    // It is in this agent's first-step set, and the registration is per agent; the step
    // condition keeps DSH's own steps out (and a step with no model selection sees nothing),
    // while an agent whose event never fired keeps no tool at all.
    assert.ok(h.tools.has(TOOL_NAME))
    assert.deepEqual(h.namesOf('s2'), [])
    assert.deepEqual([...await h.admit('native', { provider: 'deepseek-official', model: 'deepseek-flash' })], [])
    assert.deepEqual([...await h.admit('native', undefined)], [])

    // DSH executes the call from that admitted set: the mirror tool waits for the agent's call
    // and asks DSH's approval service about it (the approval pair for this exact call).
    const args = JSON.parse(call.arguments)
    const value = await tool.execute(args, { agent: h.agent, callId: call.id, signal: new AbortController().signal })
    assert.equal(value.status, 'completed')
    assert.deepEqual(tool.output.render(args, value), [{ type: 'text', text: 'hello 1' }])
    assert.deepEqual(tool.presentCall(args), { card: 'terminal', title: 'Run echo hello 1', description: 'echo hello 1' })
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].toolName, TOOL_NAME)
    assert.equal(h.asked[0].callId, call.id)
    assert.equal(h.asked[0].agent, h.agent)

    // The result goes back as DSH's tool row and the agent goes on: the first step was not an
    // unknown tool, and neither stream carries a UNKNOWN_TOOL failure.
    messages.push(
      { role: 'assistant', source: { kind: 'model', provider: 'acp-fake', model: 'default' }, content: first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) },
      { role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: tool.output.render(args, value), meta: tool.output.presentationMeta(args, value) },
    )
    const next = await step(h.adapter, messages)
    assert.equal(next.at(-1).reason.kind, 'stop')
    assert.equal(textIn(next), ' It printed hello 1.')
    for (const chunk of [...first, ...next]) assert.notEqual(chunk.reason?.failure?.code, 'UNKNOWN_TOOL')

    // scope() is the fallback for an agent the event missed: registered once, then kept
    // idempotent by the scoped WeakSet.
    assert.equal(h.adapter.scope('s2'), second)
    assert.ok(h.toolsOf('s2').has(TOOL_NAME))
    assert.deepEqual(h.namesOf('s2'), [TOOL_NAME])
    h.adapter.scope('s2')
    assert.deepEqual(h.namesOf('s2'), [TOOL_NAME])

    // A Session with no live agent fails the turn clearly, naming the Session, with its code.
    const missing = []
    for await (const chunk of h.adapter.stream(markAgentLoopRequest({ provider: 'acp-fake', model: 'default', sessionId: 'gone', messages: [] }))) missing.push(chunk)
    const end = missing.at(-1)
    assert.equal(end.reason.kind, 'error')
    assert.equal(end.reason.failure.code, 'acp_agent_missing')
    assert.match(end.reason.failure.message, /gone/)
    assert.ok(end.reason.failure.message.length > 0)
  } finally {
    h.close()
  }
})

// #661's coverage gap: `session.create` takes no model, so a new chat starts on DSH's default
// route and `agent/created` sees that provider. The person picks an ACP route (or a live switch
// moves there) before the first prompt; the step's own model selection is what decides admission.
test('a Session created on a DSH route then picked to an ACP route has acp_tool in step 1', async () => {
  const h = host()
  try {
    // `session.create` starts on `agentDefaultModel`: this agent exists on that route when DSH
    // announces it.
    const late = h.addAgent('late', 'deepseek-official')
    h.emit('agent/created', { agent: late })
    // The picker (`agent.model.select`) or a live switch moves it to the ACP route before the
    // first prompt, and DSH records the new selection.
    late.model = { current: () => ({ provider: 'acp-fake', model: 'default' }) }
    late.options = { provider: 'acp-fake' }

    // Step 1's admitted set, as dsh-agent-loop's preStep resolves it before streaming. At
    // 1d2524e8 the listener only registered agents already on an ACP route, so this is empty
    // and the mirrored call below is UNKNOWN_TOOL.
    const admitted = await h.admit('late', { provider: 'acp-fake', model: 'default' })
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
    const request = markAgentLoopRequest({ provider: 'acp-fake', model: 'default', sessionId: 'late', messages })
    const chunks = []
    for await (const chunk of h.adapter.stream(request)) chunks.push(chunk)
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
    assert.equal(call?.name, TOOL_NAME)
    const tool = admitted.get(call.name)
    if (tool === undefined) throw new ToolNotFoundError(call.name)

    // It resolves from step 1's set: the mirrored call runs through DSH's approval, from this
    // Session's own agent scope.
    const args = JSON.parse(call.arguments)
    const value = await tool.execute(args, { agent: late, callId: call.id, signal: new AbortController().signal })
    assert.equal(value.status, 'completed')
    assert.deepEqual(tool.output.render(args, value), [{ type: 'text', text: 'hello 1' }])
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].toolName, TOOL_NAME)
    assert.equal(h.asked[0].callId, call.id)
    assert.equal(h.asked[0].agent, late)
    assert.deepEqual(h.namesOf('late'), [TOOL_NAME], 'registered in its own scope, once')
  } finally {
    h.close()
  }
})

test('without an agent the plugin registers no route', () => {
  let calls = 0
  apply({ llm: { registerAdapter: () => { calls++ } } }, { claude: false, codex: false })
  assert.equal(calls, 0)
})

test('the prompt is what the person said this turn, not DSH context notes', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] },
    { role: 'user', source: { kind: 'context' }, content: [{ type: 'text', text: 'Current DSH file policy: ...' }] },
  ]
  assert.deepEqual(promptOf(messages), [{ type: 'text', text: 'new question' }])
})

// An earlier answer in the chat, from another model or an earlier agent process.
const earlier = () => [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier question' }] },
  { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'earlier answer' }] },
]
const notices = h => h.appended.filter(entry => entry.data?.source?.kind === NOTICE_KIND)

test('a new agent session in a chat with earlier answers says so once in a notice row, never in the reply', async () => {
  const h = host()
  try {
    const messages = earlier()
    h.log = messages
    const first = await turn(h, messages, 'hi')
    // The reply is the agent's own words only: no text block carries the notice.
    for (const chunks of first.steps) assert.doesNotMatch(textIn(chunks), /does not see|new Fake agent session/i)
    assert.equal(textIn(first.steps[0]), 'Fake agent, turn 1: you said "hi".')
    for (const chunks of first.steps) {
      for (const block of chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)) {
        if (block.type === 'text') assert.doesNotMatch(block.text, /does not see/)
      }
    }
    // The notice: one user-role row in the Session's log, of DSH's notice form, outside the reply.
    assert.equal(notices(h).length, 1)
    const [{ type, data, options }] = notices(h)
    assert.equal(type, 'user/message')
    assert.deepEqual(options, { surfaceOp: 'append' })
    assert.equal(data.role, 'user')
    assert.equal(data.source.form, 'notice')
    assert.equal(data.source.summary, "A new Fake agent session: it does not see this chat's earlier messages")
    assert.deepEqual(data.content, [{ type: 'text', text: "[A new Fake agent session: it does not see this chat's earlier messages.]" }])
    // It lands before the reply, never as assistant content.
    const at = messages.indexOf(data)
    assert.equal(messages[at - 1].content[0].text, 'hi')
    assert.equal(messages[at + 1].role, 'assistant')
    assert.ok(messages.filter(message => message.role === 'assistant').every(message => message.content.every(block => !/does not see/.test(block.text ?? ''))))
    // The same session's next turn writes none, and the agent is prompted with the person's words only.
    const second = await turn(h, messages, 'again')
    assert.equal(notices(h).length, 1)
    assert.equal(textIn(second.steps[0]), 'Fake agent, turn 2: you said "again".')
  } finally {
    h.close()
  }
})

test('a new agent session in a chat with no answers yet writes no notice', async () => {
  const h = host()
  try {
    const { steps } = await turn(h, [], 'hi')
    assert.equal(textIn(steps[0]), 'Fake agent, turn 1: you said "hi".')
    assert.equal(h.appended.length, 0)
  } finally {
    h.close()
  }
})

test('the new-session notice never reaches the agent, even in a turn with no message of the person', () => {
  const notice = { role: 'user', source: { kind: NOTICE_KIND, form: 'notice', summary: 'A new Fake agent session' }, content: [{ type: 'text', text: '[A new Fake agent session.]' }] }
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }
  const own = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] }
  const relay = { role: 'user', source: { kind: 'relay-producer', form: 'relay' }, content: [{ type: 'text', text: 'go on' }] }
  assert.deepEqual(promptOf([reply, notice, own]), [{ type: 'text', text: 'new question' }])
  assert.deepEqual(promptOf([reply, notice, relay]), [{ type: 'text', text: 'go on' }])
  assert.deepEqual(promptOf([reply, notice]), [{ type: 'text', text: '' }])
})

test("DSH's answer maps to the option the agent offered", () => {
  const options = [{ optionId: 'a', kind: 'allow_always' }, { optionId: 'o', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }]
  assert.deepEqual(optionFor('allowed-once', options), { outcome: { outcome: 'selected', optionId: 'o' } })
  assert.deepEqual(optionFor('rejected', options), { outcome: { outcome: 'selected', optionId: 'r' } })
  assert.deepEqual(optionFor('unavailable', options), { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(optionFor('cancelled', options), { outcome: { outcome: 'cancelled' } })
})

test('a mirror answer never substitutes a standing permission', () => {
  const allowAlways = { optionId: 'a', kind: 'allow_always' }
  const rejectOnce = { optionId: 'r', kind: 'reject_once' }
  const rejectAlways = { optionId: 'n', kind: 'reject_always' }
  const cancelled = { outcome: { outcome: 'cancelled' } }
  assert.deepEqual(optionFor('allowed-once', [allowAlways, rejectOnce]), cancelled)
  assert.deepEqual(optionFor('lasting-only', [allowAlways, rejectAlways]), cancelled)
  assert.deepEqual(optionFor('lasting-only', [allowAlways, rejectOnce, rejectAlways]), { outcome: { outcome: 'selected', optionId: 'r' } })
})

test("the agent's own models and each one's efforts are DSH's models and efforts", async () => {
  const h = host()
  try {
    assert.deepEqual(await h.adapter.listModels('acp-fake'), [
      { provider: 'acp-fake', id: 'default', name: 'Fake agent', description: 'Its own setting: Fake Large' },
      { provider: 'acp-fake', id: 'fake-large', name: 'Fake Large' },
      { provider: 'acp-fake', id: 'fake-small', name: 'Fake Small', description: 'Quick and cheap' },
      { provider: 'acp-fake', id: 'fake-plain', name: 'Fake Plain' },
    ])
    // Each model's own efforts, least to most; the agent's "default" row is no level, and its
    // current value (the person's own setting) is the default effort.
    await h.adapter.agents.get('acp-fake').catalog.probing
    const efforts = async model => (await h.adapter.resolveModel('acp-fake', model)).reasoning
    assert.deepEqual(await efforts('fake-large'), { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' })
    assert.deepEqual(await efforts('fake-small'), { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' })
    assert.deepEqual(await efforts('default'), await efforts('fake-large'))
    assert.equal(await efforts('fake-plain'), undefined)
    // An id the agent does not offer resolves bare, as DSH's routing allows.
    assert.deepEqual(await h.adapter.resolveModel('acp-fake', 'gone'), { provider: 'acp-fake', id: 'gone', name: 'gone' })
  } finally {
    h.close()
  }
})

test('the chosen model and effort reach the agent before each prompt; default goes back to its own model', async () => {
  const h = host()
  try {
    const messages = []
    let next = await turn(h, messages, 'hi', { model: 'fake-small', effort: 'high' })
    assert.match(thoughtIn(next.steps[0]), /^On fake-small at high effort\. Thinking it over\./)
    next = await turn(h, messages, 'again', { model: 'fake-large', effort: 'low' })
    assert.match(thoughtIn(next.steps[0]), /^On fake-large at low effort\./)
    // DSH's default model: the one the agent started on. A turn with no effort hands it back to
    // the agent's own "default" row, so the low effort of the turn before does not stay.
    await turn(h, messages, 'small', { model: 'fake-small' })
    next = await turn(h, messages, 'back', { model: 'default' })
    assert.match(thoughtIn(next.steps[0]), /^On fake-large at no effort\./)
    // A model or effort the agent does not offer fails the turn, saying what it does offer.
    const plain = await step(h.adapter, [...messages, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }], { model: 'fake-plain', effort: 'high' })
    assert.equal(plain.at(-1).reason.kind, 'error')
    assert.match(plain.at(-1).reason.failure.message, /Fake agent would not take fake-plain at high effort: it has no thought_level setting/)
    const unknown = await step(h.adapter, [...messages, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }], { model: 'fake-huge' })
    assert.match(unknown.at(-1).reason.failure.message, /it offers no model fake-huge \(it offers fake-large, fake-small, fake-plain\)/)
  } finally {
    h.close()
  }
})

test('an agent that offers no models is one model, default, with no efforts', async (t) => {
  process.env.FAKE_ACP_NO_OPTIONS = '1'
  t.after(() => { delete process.env.FAKE_ACP_NO_OPTIONS })
  const h = host()
  try {
    assert.deepEqual(await h.adapter.listModels('acp-fake'), [{ provider: 'acp-fake', id: 'default', name: 'Fake agent' }])
    assert.equal((await h.adapter.resolveModel('acp-fake', 'default')).reasoning, undefined)
    const { finish, steps } = await turn(h, [], 'hi')
    assert.equal(finish.reason.kind, 'stop')
    assert.equal(thoughtIn(steps[0]), 'Thinking it over.')
    const other = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }], { model: 'fake-small' })
    assert.match(other.at(-1).reason.failure.message, /it offers no choice of model, so not fake-small/)
  } finally {
    h.close()
  }
})

test("with no \"default\" effort row (Codex), a turn with no effort goes back to the model's own", async (t) => {
  process.env.FAKE_ACP_NO_DEFAULT_EFFORT = '1'
  t.after(() => { delete process.env.FAKE_ACP_NO_DEFAULT_EFFORT })
  const h = host()
  try {
    // The probe has read every model: each one's own effort is known.
    await h.adapter.listModels('acp-fake')
    await h.adapter.agents.get('acp-fake').catalog.probing
    const messages = []
    let next = await turn(h, messages, 'hi', { model: 'fake-large', effort: 'high' })
    assert.match(thoughtIn(next.steps[0]), /^On fake-large at high effort\./)
    next = await turn(h, messages, 'again', { model: 'fake-large' })
    assert.match(thoughtIn(next.steps[0]), /^On fake-large at medium effort\./)
    next = await turn(h, messages, 'small', { model: 'fake-small', effort: 'high' })
    next = await turn(h, messages, 'small again', { model: 'fake-small' })
    assert.match(thoughtIn(next.steps[0]), /^On fake-small at low effort\./)
  } finally {
    h.close()
  }
})

test("with no effort, the model's own is asked for only without a default row, and an unknown one sets nothing", async () => {
  const set = []
  const runOf = levels => ({
    startModel: 'm',
    option: category => (category === 'model' ? { id: 'model', category, type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] } : { id: 'effort', category, type: 'select', currentValue: 'high', options: levels.map(value => ({ value, name: value })) }),
    setOption: async (category, value) => { set.push([category, value]) },
  })
  let asked = 0
  const own = value => () => { asked++; return value }
  // Claude Code: its default row, never the catalog.
  await choose(runOf(['default', 'low', 'high']), 'm', undefined, own('low'))
  assert.deepEqual([asked, set], [0, [['model', 'm'], ['thought_level', 'default']]])
  // Codex: the model's own, as read.
  set.length = 0
  await choose(runOf(['low', 'high']), 'm', undefined, own('low'))
  assert.deepEqual([asked, set], [1, [['model', 'm'], ['thought_level', 'low']]])
  // Not read yet: no effort is set (the agent keeps its own), and nothing waits.
  set.length = 0
  await choose(runOf(['low', 'high']), 'm', undefined, own(undefined))
  assert.deepEqual([asked, set], [2, [['model', 'm']]])
})

// --- DSH's tools over the bridge (`dshTools` on) -------------------------------------------
// The fake agent connects the `dsh` MCP server itself, as both real adapters do, so these run
// the real bridge and the real back-channel over stdio and loopback.

// The fake agent's trace: the wire order of its session answers, the bridge's lists and re-lists.
const traceEvents = path => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
const waitFor = async (check, ms = 3_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the trace')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const bridgeTools = () => [
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: {} } },
  { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: {} } },
]
// A tool the cordis preset mounts (`@deepseek-ai/dsh-tool-cordis`); the standard preset has none
// of it, so the offered set tells which preset DSH composed for the Session.
const cordisTools = () => [
  { name: 'cordis_inspect_query', description: 'Inspect a cordis composition', parameters: { type: 'object', properties: {} } },
]

// `preset` is the Session's DSH preset (RFC 0003): `standard` normally, `cordis` when the
// Session is in creator mode. DSH records it in the creation header; its `agentPreset`
// projection reads it back, which the fixture models directly.
// `provider`/`base` run the host on another agent row (the real `acp-codex` spec, with the fake
// agent's spawn); `definitions` replaces the preset's tools; `botIdentity` is bots-dsh's reader.
function dshHost({
  env = {}, answer = 'allowed-once', sandbox = 'workspace-write', redactor, spec: extra = {}, trace,
  toolsOn = true, preset = 'standard', provider = 'acp-fake', base = {}, definitions: served,
  botIdentity,
} = {}) {
  const session = Session.create('s1', undefined, preset === 'standard' ? undefined : { version: 4, id: 's1', createdAt: 0, isSeeded: false, agentPreset: preset })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const definitions = served
    ?? (preset === 'cordis' ? [...bridgeTools(), ...cordisTools()] : bridgeTools())
  const asked = []
  const executed = []
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => [...definitions, { name: TOOL_NAME, description: 'mirror', parameters: { type: 'object' } }],
          executable: toolName => definitions.find(definition => definition.name === toolName),
          execute: async ({ calls }) => {
            executed.push(calls[0].name)
            return { results: [{ callId: calls[0].id, result: { content: [{ type: 'text', text: `ran ${calls[0].name}` }], isError: false } }] }
          },
        }
      }
      if (name === 'approval') {
        return {
          effectivePolicy: () => (sandbox === 'danger-full-access' ? 'never' : 'ask'),
          request: async (request) => {
            asked.push(request)
            return typeof answer === 'function' ? answer(request) : answer
          },
        }
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: sandbox }) }
      if (name === 'agentPresets') return { presetForSession: (target) => target?.header?.agentPreset ?? 'standard' }
      return undefined
    },
    logger: { warn: () => {}, info: () => {} },
  }
  const catalog = { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} }
  const spec = {
    name: 'Fake agent',
    ...base,
    catalog,
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { ...(trace === undefined ? {} : { FAKE_ACP_TRACE: trace }), ...env } }),
    ...extra,
  }
  const backchannel = new Backchannel({ ctx })
  // `toolsOn` is true/false, or a getter for a live switch a test flips mid-run.
  const dshTools = typeof toolsOn === 'function' ? toolsOn : () => toolsOn
  const adapter = new AcpAdapter(ctx, new Map([[provider, spec]]),
    { dshTools, backchannel, redactor, ...(botIdentity === undefined ? {} : { botIdentity }) })
  const close = () => { adapter.dispose(); backchannel.dispose() }
  return { adapter, spec, ctx, agent, session, definitions, asked, executed, backchannel, close }
}

test('with dshTools on, DSH approves a DSH tool call and the bridge writes its card, with no mirror call', async () => {
  const h = dshHost()
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    const chunks = await step(h.adapter, messages)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(textIn(chunks), /The bridge said: ran bash/)
    // No mirror tool call: the bridge's rows are the one card.
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].toolName, 'bash')
    assert.deepEqual(h.executed, ['bash'])
    const events = h.session.snapshotEvents()
    assert.ok(events.some(event => event.type === 'tool/call' && event.data.name === 'bash'))
    assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.isError === false))
  } finally {
    h.close()
  }
})

// #1639: a Genie's role tools are DSH tools registered by its plugins (`grant_wish`,
// `message_bot`, `start_task`, ...), and its Bot runs on `acp-codex`, which keeps its own
// built-in tools. With no explicit `dshTools`, this session used to get no bridge at all, so the
// model was never offered any of them (Codex's own `bash`, `read`... were its whole tool set).
// The Bot's identity, which bots-dsh sends, says its role tools live in DSH; the bridge is then
// on and drops only DSH's twins of Codex's built-ins, not the whole set. The names are the
// Genie's real ones plus six twins, sorted so the wire's preset order equals the expected order.
const GENIE_DSH_TOOLS = Object.freeze([
  'bash', 'grant_wish', 'message_bot', 'read', 'send_message',
  'start_task', 'subagent', 'todo_write', 'write',
])
const genieTools = () => GENIE_DSH_TOOLS.map(name => ({
  name, description: `${name} tool`, parameters: { type: 'object', properties: {} },
}))

test('a Genie on acp-codex keeps its whole DSH tool set, without DSH twins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-genie-codex-'))
  const genieTrace = join(dir, 'genie.ndjson')
  const genie = dshHost({
    trace: genieTrace,
    toolsOn: () => undefined,
    provider: 'acp-codex',
    base: AGENTS['acp-codex'],
    env: { FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access' },
    definitions: genieTools(),
    botIdentity: id => (id === 's1' ? {
      name: 'Genie', role: 'Grants your wishes', instructions: 'Grant wishes.', needsDshTools: true,
    } : undefined),
  })
  const plainTrace = join(dir, 'plain.ndjson')
  const plain = dshHost({
    trace: plainTrace,
    toolsOn: () => undefined,
    provider: 'acp-codex',
    base: AGENTS['acp-codex'],
    env: { FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access' },
    definitions: genieTools(),
  })
  try {
    const ask = text => [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }]
    const messages = ask('bridge grant_wish')
    const chunks = await step(genie.adapter, messages, { provider: 'acp-codex' })
    const events = traceEvents(genieTrace)
    const opened = events.find(event => event.event === 'new-session')
    assert.deepEqual(opened.servers, ['dsh'], 'the bridge is offered to the agent')
    // The wire's real tools/list: every DSH tool the Genie's role delivers that Codex has no
    // equivalent for, and none of DSH's twins of Codex's own tools. The expected list is derived
    // from the twin list itself, so the test states the rule rather than a snapshot.
    const listed = events.find(event => event.event === 'mcp-list' && event.server === 'dsh')
    const expected = GENIE_DSH_TOOLS.filter(name => !NATIVE_TWIN_TOOLS.has(name)).sort()
    for (const name of ['grant_wish', 'message_bot', 'start_task']) assert.ok(expected.includes(name), name)
    const twins = GENIE_DSH_TOOLS.filter(name => NATIVE_TWIN_TOOLS.has(name))
    assert.ok(twins.length >= 4, `the fixture carries twins of Codex's own tools: ${twins.join(', ')}`)
    assert.deepEqual(listed.tools, expected)
    for (const name of twins) assert.ok(!listed.tools.includes(name), `${name} is Codex's own tool, not a bridge tool`)
    assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1).reason))
    assert.match(textIn(chunks), /The bridge said: ran grant_wish/)
    assert.deepEqual(genie.executed, ['grant_wish'])
    assert.equal(genie.asked[0].toolName, 'grant_wish')
    // A Codex Session whose Bot needs no DSH tools keeps today's default: no bridge, no list.
    const plainMessages = ask('plain')
    await step(plain.adapter, plainMessages, { provider: 'acp-codex' })
    const plainEvents = traceEvents(plainTrace)
    const plainOpened = plainEvents.find(event => event.event === 'new-session')
    assert.deepEqual(plainOpened.servers, [])
    assert.equal(plainEvents.some(event => event.event === 'mcp-list'), false)
  } finally {
    genie.close()
    plain.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

const TEAM_DSH_TOOLS = ['bash', 'browser_open', 'message_bot', 'read', 'todo_write', 'write']
for (const [setting, toolsOn, expectedTools, why] of [
  ['absent', () => undefined, ['browser_open', 'message_bot'], 'agent-default'],
  ['false', () => false, undefined, 'agent-default'],
  ['true', () => true, TEAM_DSH_TOOLS, 'setting'],
]) test(`a team Bot on acp-codex with dshTools ${setting}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-team-codex-'))
  const trace = join(dir, 'codex.ndjson')
  const h = dshHost({
    trace,
    toolsOn,
    provider: 'acp-codex',
    base: AGENTS['acp-codex'],
    env: { FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access' },
    definitions: TEAM_DSH_TOOLS.map(name => ({
      name, description: `${name} tool`, parameters: { type: 'object', properties: {} },
    })),
    botIdentity: id => (id === 's1' ? { name: 'Bot', needsDshTools: true } : undefined),
  })
  t.after(() => {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const diagnostics = new PermissionDiagnostics()
  h.adapter.diagnostics = diagnostics
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] }]
  const chunks = await step(h.adapter, messages, { provider: 'acp-codex' })
  assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1).reason))
  const events = traceEvents(trace)
  const opened = events.find(event => event.event === 'new-session')
  const bridged = expectedTools !== undefined
  assert.deepEqual(opened.servers, bridged ? ['dsh'] : [])
  const listed = events.find(event => event.event === 'mcp-list')
  assert.deepEqual(listed?.tools, expectedTools)
  if (setting === 'absent') {
    for (const name of NATIVE_TWIN_TOOLS) assert.ok(!listed.tools.includes(name), name)
  }
  // With explicit false, the reason uses Codex's agent default without reading the identity.
  const bridge = diagnostics.read('s1').bridge
  assert.equal(bridge.on, bridged)
  assert.equal(bridge.why, why)
})

// UNPROVEN HERE: a saved always-allow rule for `mcp__*` in a real Claude Code profile can only
// be exercised on a live CLI run, and no live turn was run here. What this test proves is the
// mechanism that makes such a rule unable to skip DSH: acp-dsh answers the ACP permission
// request itself (allow-once, no DSH dialog from it) and the bridge's own DSH approval still
// runs exactly once. The saved-rule case itself is labelled unproven in the PR body.
test('an allow-once rule answers the agent\'s own permission request and still cannot skip DSH\'s one dialog', async () => {
  const h = dshHost()
  try {
    const chunks = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge-permit bash' }] }])
    assert.match(textIn(chunks), /permit yes/)
    // Exactly one DSH dialog for the call: acp-dsh answers the ACP request itself.
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].toolName, 'bash')
    assert.equal(h.executed.length, 1)
  } finally {
    h.close()
  }
})

test('a bridged question offering only allow_always is cancelled and the turn stops before DSH is asked', async () => {
  const h = dshHost({ env: { FAKE_ACP_ALWAYS_ONLY: '1' } })
  try {
    const chunks = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge-permit bash' }] }])
    assert.equal(chunks.at(-1).reason.kind, 'aborted', JSON.stringify(chunks.at(-1).reason))
    assert.doesNotMatch(textIn(chunks), /permit yes/)
    assert.equal(h.asked.length, 0)
    assert.equal(h.executed.length, 0)
  } finally { h.close() }
})

test('a bridge the adapter never starts fails the turn with acp_bridge_missing', async () => {
  const h = dshHost({ env: { FAKE_ACP_SKIP_MCP: '1' }, spec: { bridgeReadyMs: 250 } })
  try {
    const chunks = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }])
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'acp_bridge_missing')
    assert.equal(h.asked.length, 0)
  } finally {
    h.close()
  }
})

test('every drift turn records and cancels on its own trace, with no card on either', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-drift-'))
  const trace = join(dir, 'trace.ndjson')
  const h = dshHost({ spec: { drift: true }, trace })
  try {
    const ask = () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'drift' }] }]
    const first = await step(h.adapter, ask())
    const second = await step(h.adapter, ask())
    for (const chunks of [first, second]) {
      assert.equal(chunks.at(-1).reason.kind, 'aborted')
      assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
    }
    assert.equal(h.asked.length, 0)
    // A latch that survived the first turn would let the second one through unrecorded.
    const records = h.session.snapshotEvents().filter(event => event.type.startsWith('plugin:')).map(event => pluginRecordOf(event))
    assert.equal(records.length, 2)
    assert.ok(records.every(record => record.type === 'plugin:acp-dsh/toolset-drift' && record.data.name === 'Bash'))
    // Observed, not inferred: each turn's built-in call is followed by session/cancel on the
    // same ACP session.
    const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const builtins = events.filter(event => event.event === 'builtin-tool-call')
    const cancels = events.filter(event => event.event === 'cancel')
    assert.equal(builtins.length, 2)
    assert.equal(cancels.length, 2)
    for (const [index, cancel] of cancels.entries()) {
      assert.equal(cancel.sessionId, builtins[index].sessionId, 'each cancel names its own trace')
      assert.ok(events.indexOf(cancel) > events.indexOf(builtins[index]), 'the cancel follows its call')
    }
    t.diagnostic(`builtin ${builtins.map(event => event.toolCallId).join('+')} on ${builtins[0].sessionId}; session/cancel x${cancels.length} on ${cancels[0].sessionId}`)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a queued call found to be drift cancels its cardless questions', async (t) => {
  const cancelled = { outcome: { outcome: 'cancelled' } }
  const answered = async (question) => {
    let answer
    question.then(value => { answer = value })
    await waitFor(() => answer !== undefined, 500)
    return answer
  }
  for (const when of ['before', 'after']) {
    await t.test(`question ${when} the drift update`, async (t) => {
      const h = dshHost({ spec: { drift: true } })
      let end
      let streaming
      try {
        const messages = text => [{
          role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
        }]
        const warmup = await step(h.adapter, messages('plain'))
        assert.equal(warmup.at(-1).reason.kind, 'stop')
        const { run } = h.adapter.live.get('s1')
        const ask = () => run.onPermission({
          toolCall: { toolCallId: 'queued-drift', title: 'Run?' },
          options: [{ optionId: 'yes', kind: 'allow_once' }],
        })
        // Keep the prompt open: its end must not mask a question the skip left unanswered.
        // The real drift detector still records and cancels; only its process reply is held.
        t.mock.method(run, 'cancel', async () => {})
        let question
        t.mock.method(run.conn, 'prompt', () => new Promise((resolve) => {
          end = resolve
          run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'queued-drift' })
          if (when === 'before') question = ask()
          run.onUpdate({
            sessionUpdate: 'tool_call_update', toolCallId: 'queued-drift', name: 'Bash',
          })
          if (when === 'after') question = ask()
        }))
        // Both updates and the question arrive before the adapter consumes the queued call.
        streaming = step(h.adapter, messages('queued drift'))
        await waitFor(() => question !== undefined)
        assert.deepEqual(await answered(question), cancelled)
        const tool = run.tools.get('queued-drift')
        assert.equal(tool.drift, true)
        assert.equal(tool.unanswerable, true)
        assert.equal(tool.permission, undefined)
        assert.deepEqual(await answered(ask()), cancelled, 'a question after the skip too')
        // The built-in call already started and is being cancelled. A mirror would invite
        // approval for that call, so drift keeps its existing policy of making no card.
        end({ stopReason: 'cancelled' })
        const chunks = await streaming
        assert.equal(chunks.at(-1).reason.kind, 'aborted')
        assert.equal(chunks.some(chunk =>
          chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
        assert.equal(h.asked.length, 0)
        const records = h.session.snapshotEvents()
          .filter(event => event.type === 'plugin:acp-dsh/toolset-drift')
        assert.equal(records.length, 1)
        assert.equal(pluginRecordOf(records[0]).data.name, 'Bash')
      } finally {
        end?.({ stopReason: 'cancelled' })
        await streaming
        h.close()
      }
    })
  }
})

test('probe (delivery 6): a fork continues the same conversation, closes the source, and leaves one bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-fork-'))
  const trace = join(dir, 'trace.ndjson')
  const h = dshHost({ trace, spec: { refresh: 'fork' } })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    const first = await step(h.adapter, messages)
    assert.match(textIn(first), /turn 1/)
    const oldRecord = [...h.backchannel.records.values()][0]
    const firstSession = traceEvents(trace).find(event => event.event === 'new-session')
    // The Session's preset now registers one more tool: a new signature.
    h.definitions.push({ name: 'extra', description: 'Extra', parameters: { type: 'object', properties: {} } })
    const second = await step(h.adapter, messages)
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.match(textIn(second), /turn 2/)
    assert.match(textIn(second), /The bridge said: ran bash/)
    // One bridge at a time: the source's credential is gone.
    assert.equal(h.backchannel.records.size, 1)
    assert.equal(h.adapter.live.size, 1)
    assert.equal(h.adapter.live.get('s1').bridge, [...h.backchannel.records.values()][0])
    // The OLD session's own URL, not the bare one: the path matches its Session and only the
    // revoked credential refuses it.
    const old = await fetch(h.backchannel.urlFor(oldRecord), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${oldRecord.credential}` }, body: JSON.stringify({ op: 'list' }) })
    assert.equal(old.status, 401)
    // The ACP side: the fork carries the source's conversation, the source is closed, and the
    // prompt after it goes to the forked session only.
    const events = traceEvents(trace)
    const fork = events.find(event => event.event === 'fork')
    assert.equal(fork.from, firstSession.sessionId)
    assert.notEqual(fork.sessionId, fork.from)
    assert.deepEqual(fork.servers, ['dsh'])
    const closeAt = events.findIndex(event => event.event === 'close' && event.sessionId === fork.from)
    assert.ok(closeAt >= 0, 'the plugin closes the source session')
    const prompts = events.filter(event => event.event === 'prompt')
    const sourcePrompts = prompts.filter(event => event.sessionId === fork.from)
    const forkPrompts = prompts.filter(event => event.sessionId === fork.sessionId)
    // The same conversation: the fake carries its turn count, so the forked session answers
    // turn 2, and the source is never prompted again.
    assert.equal(sourcePrompts.length, 1)
    assert.equal(sourcePrompts[0].turns, 1)
    assert.equal(forkPrompts.length, 1)
    assert.equal(forkPrompts[0].turns, 2)
    assert.ok(closeAt < events.indexOf(forkPrompts[0]), 'the close comes before the forked prompt')
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const systemPrompt of [true, false]) {
  test(`a Codex tool-refresh fork keeps the replaced role (systemPrompt=${systemPrompt})`,
    async t => {
      const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-role-fork-'))
      const trace = join(dir, 'trace.ndjson')
      const oldPart = '<role-prompt id="voice-mouth">\nOld role.\n</role-prompt>'
      const newPart = '<role-prompt id="voice-mouth">\nNew role.\n</role-prompt>'
      let rolePrompt = oldPart
      const h = dshHost({
        provider: 'acp-codex', base: AGENTS['acp-codex'], trace, spec: { refresh: 'fork' },
        botIdentity: () => ({ name: 'Ada', rolePrompt }),
        env: {
          HOME: dir, USERPROFILE: dir, FAKE_ACP_MODES: 'workspace-write',
          ...(systemPrompt ? { FAKE_ACP_SYSTEM_PROMPT: '1' } : {}),
        },
      })
      t.after(() => { h.close(); rmSync(dir, { recursive: true, force: true }) })
      // 'plain' ends the fake agent's turn without a tool call or a permission ask.
      const messages = [{
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }],
      }]
      const next = async () => {
        const chunks = await step(h.adapter, messages, { provider: 'acp-codex' })
        assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1).reason))
      }
      await next()
      rolePrompt = newPart
      await next()
      h.definitions.push({
        name: 'extra', description: 'Extra', parameters: { type: 'object', properties: {} },
      })
      await next()
      const events = traceEvents(trace)
      const starts = events.filter(event => event.event === 'new-session')
      const forks = events.filter(event => event.event === 'fork')
      const prompts = events.filter(event => event.event === 'prompt')
      assert.equal(starts.length, 2)
      assert.equal(forks.length, 1)
      const [fork] = forks
      assert.equal(fork.from, starts[1].sessionId)
      assert.equal(prompts[2].sessionId, fork.sessionId)
      assert.equal(h.backchannel.records.size, 1)
      assert.equal(h.adapter.live.get('s1').bridge, [...h.backchannel.records.values()][0])
      if (systemPrompt) {
        assert.ok(starts[0].systemPrompt.includes(oldPart))
        assert.ok(starts[1].systemPrompt.includes(newPart))
        assert.equal(fork.systemPrompt, starts[1].systemPrompt)
      } else {
        assert.ok(prompts[0].text.includes(oldPart))
        assert.ok(prompts[1].text.includes(newPart))
        assert.equal(Object.hasOwn(fork, 'systemPrompt'), false)
      }
      assert.doesNotMatch(prompts[2].text, /<role-prompt /)
    })
}

test('probe (delivery 6): a fork lists its bridge before the session answer, and a preset change before that answer is held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-fork-order-'))
  const trace = join(dir, 'trace.ndjson')
  // The fork answer is held open, so the change below lands while the session does not exist.
  const h = dshHost({ trace, spec: { refresh: 'fork' }, env: { FAKE_ACP_FORK_DELAY_MS: '2000' } })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    await step(h.adapter, messages)
    const firstSession = traceEvents(trace).find(event => event.event === 'new-session')
    const oldBridge = h.adapter.live.get('s1').bridge
    h.definitions.push({ name: 'extra', description: 'Extra', parameters: { type: 'object', properties: {} } })
    const running = step(h.adapter, messages)
    // The refork mints the fork's bridge, the bridge lists and parks its long poll, and only
    // then does the change land: still before session/fork answers.
    await waitFor(() => (h.adapter.live.get('s1')?.bridge ?? oldBridge) !== oldBridge)
    const next = h.adapter.live.get('s1').bridge
    await waitFor(() => next.waiters.size > 0)
    h.definitions.push({ name: 'late', description: 'Late', parameters: { type: 'object', properties: {} } })
    assert.equal(h.backchannel.refresh(next), true)
    assert.equal(traceEvents(trace).some(event => event.event === 'fork-answer'), false, 'the change landed before the fork answered')
    const second = await running
    assert.equal(second.at(-1).reason.kind, 'stop')
    const forkId = () => traceEvents(trace).find(event => event.event === 'fork')?.sessionId
    await waitFor(() => traceEvents(trace).some(event => event.event === 'relist' && event.sessionId === forkId()))
    const events = traceEvents(trace)
    const fork = events.find(event => event.event === 'fork')
    const answerAt = events.findIndex(event => event.event === 'fork-answer' && event.sessionId === fork.sessionId)
    const listedAt = events.findIndex(event => event.event === 'mcp-list' && event.server === 'dsh' && event.sessionId === fork.sessionId)
    assert.ok(listedAt >= 0, "the fork's bridge listed its tools")
    assert.ok(listedAt < answerAt, 'tools listed before session/fork answered')
    // The first session/new had the same order: listed before its answer.
    const newAt = events.findIndex(event => event.event === 'new-answer' && event.sessionId === firstSession.sessionId)
    const firstListAt = events.findIndex(event => event.event === 'mcp-list' && event.server === 'dsh' && event.sessionId === firstSession.sessionId)
    assert.ok(firstListAt >= 0 && firstListAt < newAt, 'tools listed before session/new answered')
    // The held change is announced only after the answer, and the agent re-lists the new set.
    const relistAt = events.findIndex(event => event.event === 'relist' && event.sessionId === fork.sessionId)
    assert.ok(relistAt > answerAt, 'the announcement landed after the answer')
    assert.deepEqual(events[relistAt].tools, ['bash', 'write', 'extra', 'late'])
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probe (delivery 6): a fork whose bridge never lists fails the turn instead of continuing the chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-fork-nobridge-'))
  const trace = join(dir, 'trace.ndjson')
  const h = dshHost({ trace, spec: { refresh: 'fork', bridgeReadyMs: 250 }, env: { FAKE_ACP_FORK_SKIP_MCP: '1' } })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    await step(h.adapter, messages)
    h.definitions.push({ name: 'extra', description: 'Extra', parameters: { type: 'object', properties: {} } })
    const second = await step(h.adapter, messages)
    assert.equal(second.at(-1).reason.kind, 'error')
    assert.match(second.at(-1).reason.failure.message, /would not refresh its DSH tools/)
    assert.equal(second.at(-1).reason.failure.code, 'acp_bridge_missing')
    // Fail closed: the forked session never ran a turn, and no credential survives either.
    const events = traceEvents(trace)
    const fork = events.find(event => event.event === 'fork')
    assert.equal(events.filter(event => event.event === 'prompt' && event.sessionId === fork.sessionId).length, 0)
    assert.equal(events.filter(event => event.event === 'mcp-list' && event.sessionId === fork.sessionId).length, 0)
    assert.equal(h.adapter.live.size, 0)
    assert.equal(h.backchannel.records.size, 0)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probe (delivery 6): the shell tool runs through the bridge, and a bridge that cannot offer it fails the turn closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-shell-'))
  try {
    // The Session's preset registers a shell tool (`bash`); the agent calls it over the bridge.
    const served = dshHost({ trace: join(dir, 'served.ndjson') })
    try {
      const chunks = await step(served.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }])
      assert.equal(chunks.at(-1).reason.kind, 'stop')
      assert.match(textIn(chunks), /The bridge said: ran bash/)
      const listed = traceEvents(join(dir, 'served.ndjson')).find(event => event.event === 'mcp-list' && event.server === 'dsh')
      assert.ok(listed.tools.includes('bash'), 'the shell tool is in the bridge list')
      assert.deepEqual(served.executed, ['bash'])
      assert.equal(served.asked.length, 1)
      assert.equal(served.asked[0].toolName, 'bash')
    } finally {
      served.close()
    }
    // The adapter skips the bridge (codex-acp does when the person's Codex config defines that
    // name). The turn must fail before the prompt, not run with the agent's own shell and half
    // the Session's set.
    const skipped = dshHost({ trace: join(dir, 'skipped.ndjson'), env: { FAKE_ACP_SKIP_MCP: '1' }, spec: { bridgeReadyMs: 250 } })
    try {
      const chunks = await step(skipped.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }])
      assert.equal(chunks.at(-1).reason.kind, 'error')
      assert.equal(chunks.at(-1).reason.failure.code, 'acp_bridge_missing')
      assert.equal(skipped.asked.length, 0)
      assert.deepEqual(skipped.executed, [])
      const events = traceEvents(join(dir, 'skipped.ndjson'))
      // The bridge was requested in the server list, never listed, and the agent never ran.
      assert.deepEqual(events.find(event => event.event === 'new-session').servers, ['dsh'])
      assert.equal(events.filter(event => event.event === 'mcp-list').length, 0)
      assert.equal(events.filter(event => event.event === 'prompt').length, 0, 'the agent was never prompted')
    } finally {
      skipped.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the bridge offers the Session preset: standard normally, cordis in creator mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-preset-'))
  const standardTrace = join(dir, 'standard.ndjson')
  const creatorTrace = join(dir, 'creator.ndjson')
  const standard = dshHost({ trace: standardTrace })
  const creator = dshHost({ preset: 'cordis', trace: creatorTrace })
  try {
    // The Session's preset decides what DSH mounts, so it decides what the bridge offers:
    // no cordis tool outside creator mode, and the cordis preset's tool inside it.
    assert.equal(presetOf(standard.ctx, standard.agent.session), 'standard')
    assert.equal(presetOf(creator.ctx, creator.agent.session), 'cordis')
    assert.deepEqual(offeredTools(standard.ctx, standard.agent).map(tool => tool.name), ['bash', 'write'])
    assert.deepEqual(offeredTools(creator.ctx, creator.agent).map(tool => tool.name), ['bash', 'write', 'cordis_inspect_query'])
    // The real bridge serves that set, and the creator-only tool runs through DSH.
    await step(standard.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] }])
    const chunks = await step(creator.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge cordis_inspect_query' }] }])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(textIn(chunks), /The bridge said: ran cordis_inspect_query/)
    assert.deepEqual(creator.executed, ['cordis_inspect_query'])
    const listed = path => traceEvents(path).find(event => event.event === 'mcp-list' && event.server === 'dsh').tools
    assert.deepEqual(listed(standardTrace), ['bash', 'write'])
    assert.deepEqual(listed(creatorTrace), ['bash', 'write', 'cordis_inspect_query'])
  } finally {
    standard.close()
    creator.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fork that fails after the session moved revokes both credentials and ends the run', async () => {
  const h = dshHost({ env: { FAKE_ACP_FORK_FAIL: '1' }, spec: { refresh: 'fork' } })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    const first = await step(h.adapter, messages)
    assert.match(textIn(first), /turn 1/)
    // A changed tool set triggers the fork, which the agent refuses.
    h.definitions.push({ name: 'extra', description: 'Extra', parameters: { type: 'object', properties: {} } })
    const second = await step(h.adapter, messages)
    assert.equal(second.at(-1).reason.kind, 'error')
    assert.match(second.at(-1).reason.failure.message, /would not refresh its DSH tools/)
    // No half state: the run is gone, every credential revoked, and the next turn starts clean.
    assert.equal(h.adapter.live.size, 0)
    assert.equal(h.backchannel.records.size, 0)
    const third = await step(h.adapter, messages)
    assert.match(textIn(third), /turn 1/)
    assert.equal(h.backchannel.records.size, 1)
  } finally {
    h.close()
  }
})

test('a Session moving to an agent carries its transcript redacted, and each crossing writes a row', async () => {
  const h = dshHost({ redactor: text => text.replaceAll('hunter2', '[secret:TOKEN]') })
  try {
    // A synthetic bridge review block sits in the history: it is not a turn and must not cross.
    const synthetic = {
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek-official', bridge: true, synthetic: SYNTHETIC_KIND },
      content: [{ type: 'tool-call', id: 'bridge-synthetic', name: 'bridge_synthetic', arguments: '{}' }],
    }
    const messages = [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier question' }] },
      { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official' }, content: [{ type: 'text', text: 'earlier answer hunter2' }] },
      synthetic,
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] },
    ]
    const chunks = await step(h.adapter, messages)
    const said = textIn(chunks)
    assert.match(said, /The chat so far, moved from DSH to Fake agent/)
    assert.match(said, /earlier answer \[secret:TOKEN\]/)
    assert.equal(said.includes('hunter2'), false)
    assert.equal(said.includes('bridge_synthetic'), false)
    // The new-session notice is not written: this session does see the chat before it.
    assert.equal(h.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source?.kind === NOTICE_KIND), false)
    const boundary = () => h.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === BOUNDARY_KIND)
    assert.equal(boundary().length, 1)
    assert.match(boundary()[0].data.source.summary, /Switching to Fake agent \(acp-fake\)/)
    // The row is one the chat draws: a notice, not reply text from the agent.
    assert.equal(boundary()[0].data.role, 'user')
    assert.equal(boundary()[0].data.source.form, 'notice')
    assert.equal(boundary()[0].data.content[0].text, '[Switching to Fake agent (acp-fake).]')
    // Moving back to DSH is the other crossing: a row, and the agent session (and bridge) end.
    h.adapter.noteEvent(h.session, { type: 'model/selection', data: { provider: 'deepseek-official' } })
    assert.equal(boundary().length, 2)
    assert.match(boundary()[1].data.source.summary, /Switching to DSH/)
    assert.equal(boundary()[1].data.source.form, 'notice')
    assert.equal(boundary()[1].data.content[0].text, '[Switching to DSH.]')
    assert.equal(h.adapter.live.size, 0)
    assert.equal(h.backchannel.records.size, 0)
  } finally {
    h.close()
  }
})

// The plugin's own wiring (apply), with DSH's tools service behind the bridge: what a real
// DSH tools call needs, and the one place `dshTools` is read from Config.
function bridgeWiring() {
  const session = Session.create('s1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const asked = []
  const listeners = new Map()
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const definitions = bridgeTools()
  const ctx = {
    llm: { registerAdapter: () => () => {} },
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => definitions,
          executable: toolName => definitions.find(definition => definition.name === toolName),
          execute: async ({ calls }) => ({ results: [{ callId: calls[0].id, result: { content: [{ type: 'text', text: `ran ${calls[0].name}` }], isError: false } }] }),
        }
      }
      if (name === 'approval') return { effectivePolicy: () => 'ask', request: async (request) => { asked.push(request); return 'allowed-once' } }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    emit: (name) => (listeners.get(name) ?? []).forEach(listener => listener()),
    effect: () => {},
    logger: { warn: () => {}, info: () => {} },
  }
  const registered = {}
  ctx.llm.registerAdapter = (providers, adapter) => { for (const id of providers) registered[id] = adapter; return () => {} }
  return { ctx, registered, asked, agent, session, emit: ctx.emit }
}

test('the plugin wiring hands the bridge to a Session by default (dshTools unset)', async () => {
  const w = bridgeWiring()
  apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    const chunks = await step(w.registered['acp-fake'], messages)
    assert.match(textIn(chunks), /The bridge said: ran bash/)
    assert.equal(w.asked.length, 1)
    assert.equal(w.asked[0].toolName, 'bash')
  } finally {
    w.registered['acp-fake'].dispose()
  }
})

test('the kill switch is live: false ends the bridge now, true brings it back', async () => {
  const w = bridgeWiring()
  let on = true
  apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: { get: () => on } })
  const adapter = w.registered['acp-fake']
  try {
    const ask = text => [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }]
    const first = await step(adapter, ask('bridge bash'))
    assert.match(textIn(first), /The bridge said: ran bash/)
    assert.equal(adapter.backchannel.records.size, 1)
    // False is the kill switch: the plugin ends the agent session and revokes its bridge when
    // the live setting changes, so no credential minted while on can keep calling DSH tools.
    on = false
    w.emit('loader/volatile-update')
    assert.equal(adapter.live.size, 0)
    assert.equal(adapter.backchannel.records.size, 0)
    // The next turn is the old path, in a fresh agent session with no bridge.
    const second = await step(adapter, ask('plain'))
    assert.match(textIn(second), /turn 1: you said "plain"/)
    assert.equal(adapter.live.get('s1').bridge, undefined)
    // On again: the next turn gets the bridge back.
    on = true
    w.emit('loader/volatile-update')
    const third = await step(adapter, ask('bridge bash'))
    assert.match(textIn(third), /The bridge said: ran bash/)
    assert.equal(adapter.backchannel.records.size, 1)
  } finally {
    adapter.dispose()
  }
})

test('the plugin wiring carries effort both ways on a model selection', async () => {
  const handlers = []
  const offs = []
  const appended = []
  let previous = { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' }
  const session = {
    requestHeader: () => ({ config: previous }),
    append: (type, data) => { appended.push({ type, data }) },
  }
  const levels = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
  const ctx = {
    llm: {
      registerAdapter: () => () => {},
      resolveModelInfo: async () => ({ reasoning: levels }),
    },
    agents: { get: () => undefined },
    on: (event, handler) => {
      if (event === 'session/event') handlers.push(handler)
      return () => {}
    },
    effect: (execute) => { offs.push(execute()) },
    logger: { warn() {}, info() {} },
    get: () => undefined,
  }
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: true })
  const select = async (data) => {
    for (const handler of handlers) handler(session, { type: 'model/selection', data })
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    await select({ provider: 'acp-fake', model: 'fake-large', reasoningEffort: 'low' })
    assert.deepEqual(appended.at(-1), {
      type: 'model/selection',
      data: { provider: 'acp-fake', model: 'fake-large', reasoningEffort: 'high' },
    })
    previous = { provider: 'acp-fake', model: 'fake-large', reasoningEffort: 'high' }
    appended.length = 0
    await select({ provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'low' })
    assert.deepEqual(appended.at(-1).data, {
      provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high',
    })
  } finally {
    for (const off of offs) off()
  }
})

test('a real config with no dshTools keeps Codex out and bridges Claude', async () => {
  // Through resolveConfig and the plugin's own agent objects, the way DSH builds them.
  const { resolveConfig } = await import('@deepseek-ai/cordis')
  const plugin = await import('../index.js')
  const adapterFor = (data) => {
    const registered = {}
    const ctx = {
      llm: {
        registerAdapter: (providers, adapter) => {
          for (const id of providers) registered[id] = adapter
          return () => {}
        },
      },
      agents: { get: () => undefined },
      get: () => undefined,
      provide: () => {},
      on: () => {},
      effect: () => {},
      logger: { warn: () => {}, info: () => {} },
    }
    plugin.apply(ctx, resolveConfig(plugin, data), {
      find: name => `/bin/${name}`,
      signedIn: async () => true,
      store: {
        binOf: () => ({ path: '/adapter', version: '1' }),
        update: async () => {},
        home: undefined,
      },
    })
    return registered['acp-claude']
  }
  const unset = adapterFor({})
  const claude = unset.agents.get('acp-claude')
  const codex = unset.agents.get('acp-codex')
  // The registered objects carry the capabilities the adapter reads.
  assert.equal(claude.disableBuiltInTools, true)
  assert.equal(claude.drift, true)
  assert.equal(codex.refresh, 'fork')
  // No schema default: absent stays absent, so each agent's own switch decides.
  assert.equal(unset.bridgeOn(claude), true)
  assert.equal(unset.bridgeOn(codex), false)
  // The person's word still wins both ways.
  const forced = adapterFor({ dshTools: true })
  assert.equal(forced.bridgeOn(forced.agents.get('acp-codex')), true)
  const off = adapterFor({ dshTools: false })
  assert.equal(off.bridgeOn(off.agents.get('acp-claude')), false)
})

test('the bridge default is per agent: Claude on, Codex off until explicitly asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-agent-default-'))
  const trace = name => join(dir, `${name}.ndjson`)
  // Claude Code declares the adapter switch that drops its own tools: the default bridges it.
  const claude = dshHost({
    toolsOn: () => undefined, spec: { disableBuiltInTools: true }, trace: trace('claude'),
  })
  // Codex has no such switch: its default is the old path, so it never runs two tool sets.
  const codex = dshHost({
    toolsOn: () => undefined, spec: { refresh: 'fork' }, trace: trace('codex'),
  })
  // An explicit true still bridges Codex (the person asked for two tool sets).
  const forced = dshHost({ toolsOn: () => true, spec: { refresh: 'fork' }, trace: trace('forced') })
  try {
    const ask = [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }],
    }]
    await step(claude.adapter, ask)
    await step(codex.adapter, ask)
    await step(forced.adapter, ask)
    const servers = name => traceEvents(trace(name))
      .find(event => event.event === 'new-session').servers
    assert.deepEqual(servers('claude'), ['dsh'])
    assert.deepEqual(servers('codex'), [])
    assert.deepEqual(servers('forced'), ['dsh'])
  } finally {
    claude.close()
    codex.close()
    forced.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit sideModel that cannot run still leaves the built-in fallback', async () => {
  const sent = []
  const ctx = {
    llm: {
      stream: options => {
        sent.push(`${options.provider}/${options.model}`)
        return (async function* () {
          if (options.provider === 'anthropic') {
            yield { type: 'finish', reason: { kind: 'error', failure: {
              message: 'no key', code: 'MISSING_CREDENTIAL',
            } } }
            return
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const listen = aside(new Map([['acp-fake', {}]]), ctx,
    () => ({ provider: 'anthropic', model: 'side' }))
  const review = { provider: 'acp-fake', model: 'default', purpose: 'auto-review', messages: [] }
  const chunks = await drain(listen(review, () => {
    throw new Error('the agent got a side request')
  }))
  assert.deepEqual(sent, ['anthropic/side', 'deepseek-official/deepseek-flash'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('the reviewer walks the real provider list in order, capped at eight routes', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const seen = []
  class Route extends LlmAdapter {
    constructor(id, answer = false) { super(); this.id = id; this.answer = answer }
    async listModels(provider) { return [{ provider, id: `m-${this.id}`, name: this.id }] }
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      seen.push(options.provider)
      if (this.answer) {
        yield { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: 'no key', code: 'MISSING_CREDENTIAL',
      } } }
    }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['acp-fake'], new Route('acp-fake'))
  for (let i = 1; i <= 10; i += 1) ctx.llm.registerAdapter([`p${i}`], new Route(`p${i}`, i === 3))
  ctx.on('llm/stream', aside(new Map([['acp-fake', {}]]), ctx))
  const run = async () => {
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'acp-fake', model: 'default', purpose: 'auto-review', messages: [],
    })) chunks.push(chunk)
    return chunks
  }
  const chunks = await run()
  assert.deepEqual(seen, ['p1', 'p2', 'p3'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')

  // Past the cap the ninth route is never even examined, whatever its catalog does: one
  // model-less route and one whose listModels throws must not let the chain walk every
  // provider on the machine. The built-in is still asked and, unregistered here, fails as
  // NO_ADAPTER rather than the chain pretending a decision.
  const late = new Context()
  await late.plugin(LlmRuntime)
  late.llm.registerAdapter(['acp-fake'], new Route('acp-fake'))
  const examined = []
  for (let i = 1; i <= 10; i += 1) {
    const route = new Route(`p${i}`, i === 9)
    route.listModels = async (provider) => {
      examined.push(provider)
      if (i === 1) return []
      if (i === 2) throw new Error('the catalog is unavailable')
      return [{ provider, id: `m-${i}`, name: `p${i}` }]
    }
    late.llm.registerAdapter([`p${i}`], route)
  }
  late.on('llm/stream', aside(new Map([['acp-fake', {}]]), late))
  const chunks2 = []
  const lateReview = {
    provider: 'acp-fake', model: 'default', purpose: 'auto-review', messages: [],
  }
  for await (const chunk of late.llm.stream(lateReview)) chunks2.push(chunk)
  assert.deepEqual(examined, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
  assert.equal(chunks2.at(-1).reason.failure.code, 'NO_ADAPTER')
})

test('switching away and back resumes the agent session with dshTools off, and starts clean with it on', async () => {
  const off = dshHost({ toolsOn: false })
  try {
    const first = await step(off.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] }])
    assert.match(textIn(first), /turn 1/)
    off.adapter.noteEvent(off.session, { type: 'model/selection', data: { provider: 'deepseek-official' } })
    // Off: the agent run is kept across a turn on another provider, as on dev, so switching back
    // resumes the same ACP session rather than starting fresh.
    assert.equal(off.adapter.live.size, 1)
    assert.equal(off.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === BOUNDARY_KIND).length, 0)
    const second = await step(off.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain again' }] }])
    assert.match(textIn(second), /turn 2/)
  } finally {
    off.close()
  }
  const on = dshHost()
  try {
    await step(on.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] }])
    on.adapter.noteEvent(on.session, { type: 'model/selection', data: { provider: 'deepseek-official' } })
    // On: the crossing ends the agent session (and its bridge) and writes the row.
    assert.equal(on.adapter.live.size, 0)
    assert.equal(on.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === BOUNDARY_KIND).length, 1)
    const second = await step(on.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain again' }] }])
    assert.match(textIn(second), /turn 1/)
  } finally {
    on.close()
  }
})

test('with dshTools off a turn is the old path: no bridge spawned, no bridge rows, the same card and text', async () => {
  const offDir = mkdtempSync(join(tmpdir(), 'acp-dsh-off-'))
  const onDir = mkdtempSync(join(tmpdir(), 'acp-dsh-on-'))
  const off = dshHost({ toolsOn: false, trace: join(offDir, 'trace.ndjson') })
  const on = dshHost({ toolsOn: true, trace: join(onDir, 'trace.ndjson') })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]
    const chunksOff = await step(off.adapter, messages)
    const chunksOn = await step(on.adapter, messages)
    // The old behaviour runs no bridge at all: the agent got no servers, the plugin minted no
    // credential and wrote no bridge rows.
    const offTrace = readFileSync(join(offDir, 'trace.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(offTrace.find(event => event.event === 'new-session').servers, [])
    assert.equal(off.backchannel.records.size, 0)
    assert.equal(off.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0)
    assert.equal(off.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 0)
    // The on path spawned the bridge for the same turn.
    const onTrace = readFileSync(join(onDir, 'trace.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(onTrace.find(event => event.event === 'new-session').servers, ['dsh'])
    // The turn itself is unchanged: same text, same single card (a tool-call id is random).
    const shape = chunks => ({
      text: textIn(chunks),
      blocks: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk.block.type === 'tool-call'
        ? { type: 'tool-call', name: chunk.block.name, arguments: chunk.block.arguments }
        : chunk.block)),
      finish: chunks.at(-1).reason.kind,
    })
    assert.deepEqual(shape(chunksOff), shape(chunksOn))
    // The ask belongs to the next step, when DSH runs the card; both paths end this one first.
    assert.equal(off.asked.length, 0)
    assert.equal(on.asked.length, 0)
  } finally {
    off.close()
    on.close()
    rmSync(offDir, { recursive: true, force: true })
    rmSync(onDir, { recursive: true, force: true })
  }
})

test('with dshTools off the agent\'s stream is logged as it arrived', async () => {
  // Redaction belongs to live switching: off is the behaviour before it, byte for byte, even
  // with a redactor wired in. The same turn is redacted on the path above.
  const h = dshHost({ toolsOn: false, redactor: credentialShapes })
  try {
    const ask = [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'leak' }],
    }]
    const chunks = await step(h.adapter, ask)
    assert.match(textIn(chunks), /sk-abcdef123456/)
    assert.match(textIn(chunks), /Bearer abcdefgh1234/)
    assert.match(thoughtIn(chunks), /sk-abcdef123456/)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  } finally {
    h.close()
  }
})

test('dshTools false is the kill switch: own tools, no bridge spawned', async () => {
  const session = Session.create('s1')
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const ctx = {
    llm: { registerAdapter: () => () => {} },
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: () => undefined,
    on: () => () => {},
    effect: () => {},
    logger: { warn: () => {}, info: () => {} },
  }
  const registered = {}
  ctx.llm.registerAdapter = (providers, adapter) => { for (const id of providers) registered[id] = adapter; return () => {} }
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: false })
  try {
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'bridge bash' }] }]
    const chunks = await step(registered['acp-fake'], messages)
    // The mirror path, as on 2026-11-03: the agent's own call becomes an acp_tool card.
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.ok(call, 'the step ended at the mirror call')
    assert.equal(call.block.name, TOOL_NAME)
    assert.equal(JSON.parse(call.block.arguments).title, 'mcp__dsh__bash')
  } finally {
    registered['acp-fake'].dispose()
  }
})

test("a person's own MCP server passes the drift check; a built-in tool is drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-mcp-drift-'))
  const trace = join(dir, 'trace.ndjson')
  const h = dshHost({ spec: { drift: true }, trace })
  try {
    const plain = [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }],
    }]
    await step(h.adapter, plain)
    // DSH hands the agent only the bridge. Anything else in its tool list is the person's own
    // server, loaded by their CLI from its own user-scope config, not by this plugin.
    const opened = traceEvents(trace).find(event => event.event === 'new-session')
    assert.deepEqual(opened.servers, ['dsh'])
    // The allowlist is `mcp__*`, by design: a user-scope server's call is not adapter drift.
    const personal = { structuredName: 'mcp__personalmcp__search', title: 'search', mcp: true }
    h.adapter.checkDrift('s1', AGENTS['acp-claude'], personal)
    assert.notEqual(personal.drift, true)
    const drift = () => h.session.snapshotEvents()
      .filter(event => event.type === 'plugin:acp-dsh/toolset-drift')
    assert.equal(drift().length, 0)
    // A built-in tool is drift: recorded on the turn and cancelled.
    const bash = { structuredName: 'Bash', title: 'Bash' }
    h.adapter.checkDrift('s1', AGENTS['acp-claude'], bash)
    assert.equal(bash.drift, true)
    assert.equal(drift().length, 1)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the adapter\'s own deferred-tool loader gets no DSH card and no dialog', async () => {
  const h = dshHost({ spec: { drift: true } })
  try {
    const chunks = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'toolsearch' }] }])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(textIn(chunks), /I found it\./)
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
    assert.equal(h.asked.length, 0)
  } finally {
    h.close()
  }
})

test('an agent answer is logged as said, and redacted at each provider crossing', async () => {
  // Crossing 1: DSH history replayed to an agent. Crossing 2: the transcript handed back to a
  // native provider. Ingest is not a crossing: DSH logs what the agent said.
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-replay-'))
  const trace = join(dir, 'trace.ndjson')
  const h = dshHost({ redactor: credentialShapes, trace })
  const secrets = /sk-abcdef123456|npm_abcdefghijklmnopqrstuvwxyz|Bearer abcdefgh1234/
  try {
    h.adapter.agents.set('acp-fake-b', { ...h.spec, name: 'Fake agent B' })
    const ask = [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'leak' }],
    }]
    const first = await step(h.adapter, ask)
    const streamed = textIn(first)
    // Verifier 1: the agent's answer is stored as the agent said it, reasoning included.
    assert.match(streamed, /sk-abcdef123456/)
    assert.match(streamed, /npm_abcdefghijklmnopqrstuvwxyz/)
    assert.match(streamed, /Bearer abcdefgh1234/)
    assert.match(thoughtIn(first), /sk-abcdef123456/)
    const blocks = first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    assert.match(JSON.stringify(blocks), /sk-abcdef123456/)
    // Verifier 2: crossing back to a native provider, that transcript is redacted.
    const sent = []
    const ctx = { llm: { stream: options => { sent.push(options); return 'stream' } } }
    const listen = crossed(new Map([['acp-fake', {}]]), ctx, credentialShapes)
    const back = {
      provider: 'deepseek-official', sessionId: 's1',
      messages: [
        ...ask,
        {
          role: 'assistant', source: { kind: 'model', provider: 'acp-fake' },
          content: [{ type: 'text', text: streamed }],
        },
        { role: 'tool', content: [{ type: 'text', text: 'read sk-abcdef123456' }] },
      ],
    }
    const refused = () => assert.fail('a native provider received the raw transcript')
    assert.equal(listen(back, refused), 'stream')
    assert.equal(JSON.stringify(sent[0].messages).includes('sk-abcdef123456'), false)
    assert.match(JSON.stringify(sent[0].messages), /sk-\[hidden\]/)
    // Verifier 3: native history replayed to an agent is redacted too.
    const messages = [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier' }] },
      {
        role: 'assistant', source: { kind: 'model', provider: 'deepseek-official' },
        content: [{ type: 'text', text: 'answer ghp_abcdefghijklmnopqrst' }],
      },
      {
        role: 'assistant', source: { kind: 'model', provider: 'acp-fake' },
        content: [{ type: 'text', text: streamed }],
      },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'leak' }] },
    ]
    await step(h.adapter, messages, { provider: 'acp-fake-b' })
    // What the second agent received is the replayed history: read from its own prompt trace,
    // not from its answer (an answer may itself carry whatever the person showed it).
    const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const prompt = events.filter(event => event.event === 'prompt').at(-1).text
    assert.doesNotMatch(prompt, secrets)
    assert.doesNotMatch(prompt, /ghp_abcdefghijklmnopqrst/)
    assert.match(prompt, /sk-\[hidden\]/)
    assert.match(prompt, /moved from Fake agent to Fake agent B/)
    // The crossing is visible, and the agent's answer is what it got.
    const rows = h.session.snapshotEvents()
      .filter(event => event.type === 'user/message' && event.data.source?.kind === BOUNDARY_KIND)
    assert.equal(rows.length, 1)
    assert.match(rows[0].data.source.summary, /Switching to Fake agent B \(acp-fake-b\)/)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probe (delivery 6): codex\'s unstructured MCP calls stay unmatched — no card, no ask, no drift guess', async () => {
  // The wire shapes the spike saw. Claude Code names the call (root or `_meta.claudeCode`);
  // codex-acp sends `name: null` + `_meta.is_mcp_tool_call` and no name anywhere.
  assert.equal(structuredNameOf({ sessionUpdate: 'tool_call', toolCallId: 'x', name: 'mcp__dsh__bash' }), 'mcp__dsh__bash')
  assert.equal(structuredNameOf({ _meta: { claudeCode: { toolName: 'mcp__dsh__bash' } } }), 'mcp__dsh__bash')
  assert.equal(structuredNameOf({ sessionUpdate: 'tool_call', toolCallId: 'x', name: null, _meta: { is_mcp_tool_call: true } }), undefined)
  // The declaration behind that: acp-codex has no built-in-tool switch and no drift detector,
  // because a name it could match is not proven; a refresh there is a fork.
  assert.equal(AGENTS['acp-codex'].disableBuiltInTools, undefined)
  assert.equal(AGENTS['acp-codex'].drift, undefined)
  assert.equal(AGENTS['acp-codex'].refresh, 'fork')
  const h = dshHost({ spec: { refresh: 'fork' } })
  try {
    const chunks = await step(h.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'mcp-call' }] }])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(textIn(chunks), /The MCP tool answered\./)
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
    assert.equal(h.asked.length, 0)
    assert.equal(h.executed.length, 0)
    // Marked as MCP by the update's own flag, never matched by a guessed name from its title.
    const tool = h.adapter.live.get('s1').run.tools.get('mcp-1')
    assert.equal(tool.mcp, true)
    assert.equal(tool.structuredName, undefined)
    assert.notEqual(tool.bridge, true, 'the call is not matched as the bridge either')
    assert.equal(h.session.snapshotEvents().filter(event => event.type.startsWith('plugin:')).length, 0)
  } finally {
    h.close()
  }
  // Even a run that declares the drift detector records nothing here: with no structured name
  // there is nothing to hold the call to, and inventing one would soften the declaration.
  const drift = dshHost({ spec: { refresh: 'fork', drift: true } })
  try {
    const chunks = await step(drift.adapter, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'mcp-call' }] }])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
    assert.equal(drift.session.snapshotEvents().filter(event => event.type.startsWith('plugin:')).length, 0)
    assert.equal(drift.adapter.live.get('s1').drifted, false)
  } finally {
    drift.close()
  }
})

// ---- a plugin reload over live chats (#667)

const MIRROR = Symbol.for('@automagik/acp-dsh/mirror-registration')
const registrationsOf = (h, id) => h.registrations.filter(entry => entry.id === id)
const disposalsOf = (h, id) => h.disposals.filter(entry => entry.id === id)

test('a plugin reload takes over an idle live chat without a double registration (#667)', async () => {
  const h = host()
  try {
    // A chat created after this plugin loaded: only agent/created registers it.
    const live = h.addAgent('live')
    h.emit('agent/created', { agent: live })
    assert.deepEqual(h.namesOf('live'), [TOOL_NAME])
    assert.equal(registrationsOf(h, 'live').length, 1)

    // The reload: a new adapter over the same agent and its scoped tools. The construction
    // takeover finds the old registration through the symbol and replaces it — no
    // "already registered in this scope", and the old exact disposer ran once.
    h.reload()
    assert.equal(h.namesOf('live').length, 1, 'one acp_tool in the scope')
    assert.deepEqual(disposalsOf(h, 'live'), [{ id: 'live', name: TOOL_NAME }])
    assert.equal(registrationsOf(h, 'live').length, 2)
    assert.equal(h.toolsOf('live').size, 1)

    // The next step's pre-step resolution admits it under the per-step rule (#662), and a DSH
    // route or no selection still admits nothing.
    assert.ok((await h.admit('live', { provider: 'acp-fake', model: 'default' })).has(TOOL_NAME), 'the next step resolves acp_tool')
    assert.deepEqual([...(await h.admit('live', { provider: 'deepseek-official', model: 'deepseek-flash' }))], [])
    assert.deepEqual([...(await h.admit('live', undefined))], [])

    // A second reload takes over again, from the adapter that is current now; re-running the
    // registration for the current adapter is a no-op (agent/created and the takeover both call it).
    const again = h.reload()
    assert.equal(disposalsOf(h, 'live').length, 2)
    assert.equal(h.namesOf('live').length, 1)
    const before = registrationsOf(h, 'live').length
    again.registerMirror(live)
    assert.equal(registrationsOf(h, 'live').length, before)
  } finally {
    h.close()
  }
})

test('a running chat keeps its registration for the turn and is replaced on the idle edge (#667)', async () => {
  const h = host()
  try {
    const live = h.addAgent('live')
    h.emit('agent/created', { agent: live })
    assert.deepEqual(h.namesOf('live'), [TOOL_NAME])

    // DSH resolved the running step's tools before the reload: replacing the registration now
    // would close that step's admission and fail its mirrored call as UNKNOWN_TOOL.
    live.status = 'running'
    const reloaded = h.reload()
    assert.deepEqual(disposalsOf(h, 'live'), [], 'the running turn keeps the old registration')
    assert.equal(registrationsOf(h, 'live').length, 1)
    assert.ok((await h.admit('live', { provider: 'acp-fake', model: 'default' })).has(TOOL_NAME), 'the running step keeps acp_tool')

    // The agent/status idle edge is where the reloaded adapter replaces it.
    live.status = 'idle'
    reloaded.registerMirror(live)
    assert.deepEqual(disposalsOf(h, 'live'), [{ id: 'live', name: TOOL_NAME }])
    assert.equal(registrationsOf(h, 'live').length, 2)
    assert.deepEqual(h.namesOf('live'), [TOOL_NAME])
    assert.ok((await h.admit('live', { provider: 'acp-fake', model: 'default' })).has(TOOL_NAME))
  } finally {
    h.close()
  }
})

test('the kept disposer is idempotent, and a fresh or missing Session still behaves (#667)', () => {
  const h = host()
  try {
    const live = h.addAgent('live')
    h.emit('agent/created', { agent: live })
    const stored = live[MIRROR]
    assert.equal(stored.adapter, h.adapter)
    assert.equal(typeof stored.dispose, 'function')

    // The exact disposer: calling it again is a no-op, and the scope loses the tool once.
    stored.dispose()
    stored.dispose()
    assert.deepEqual(disposalsOf(h, 'live'), [{ id: 'live', name: TOOL_NAME }])
    assert.deepEqual(h.namesOf('live'), [])

    // A reloaded adapter takes the scope over even after that external disposal: it calls the
    // already-spent disposer (no second removal, no throw) and registers once.
    h.reload()
    assert.deepEqual(disposalsOf(h, 'live'), [{ id: 'live', name: TOOL_NAME }])
    assert.deepEqual(h.namesOf('live'), [TOOL_NAME])
    assert.equal(registrationsOf(h, 'live').length, 2)

    // A fresh agent registers once, with the same per-step condition.
    const fresh = h.addAgent('fresh')
    h.adapter.registerMirror(fresh)
    assert.deepEqual(h.namesOf('fresh'), [TOOL_NAME])

    // A Session with no live agent still fails clearly, naming the Session.
    assert.throws(
      () => h.adapter.scope('gone'),
      error => error.code === 'acp_agent_missing' && /gone/.test(error.message),
    )
  } finally {
    h.close()
  }
})

// An image the agent makes with its own tool (Codex's "Image generation"): the card shows it from
// the call's first sight, the PNG from the call's own update goes to the chat's image keeper, and
// neither the result nor the stored reply names the path the agent saved it at.
function imageKeeper({ fail = false } = {}) {
  const seen = { started: [], kept: [], failed: [] }
  return {
    seen,
    start: call => seen.started.push(call),
    keep: async (image) => {
      seen.kept.push(image)
      if (fail) throw new Error('the disk is full')
      return { id: 'img-12345678', file: '/team/images/img-12345678.png' }
    },
    fail: call => seen.failed.push(call),
  }
}
const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('an agent\'s image call keeps its PNG through the chat\'s keeper and its reply drops the local path', async () => {
  const h = host()
  const keeper = imageKeeper()
  h.provided.acpAgents.keepImages(keeper)
  try {
    const messages = []
    const { steps } = await turn(h, messages, 'image-call')
    const [first, second] = steps
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
    const args = JSON.parse(call.arguments)
    assert.equal(args.title, 'Image generation')
    assert.equal(args.image, true, 'the card is drawn as an image from the first sight of the call')
    assert.equal(keeper.seen.started.length, 1)
    assert.equal(keeper.seen.started[0].callId, call.id)
    assert.equal(keeper.seen.kept.length, 1)
    assert.equal(keeper.seen.kept[0].base64, ONE_PIXEL)
    assert.equal(keeper.seen.kept[0].callId, call.id)
    assert.equal(keeper.seen.kept[0].mimeType, 'image/png')
    const value = first.result.value
    assert.equal(value.status, 'completed')
    assert.match(value.text, /^Image generated and saved as \/team\/images\/img-12345678\.png\./)
    // Nothing of the agent's own copy reaches the transcript: not its path, not the bytes.
    const stored = JSON.stringify(messages)
    assert.doesNotMatch(stored, /fake-codex-home|generated_images/)
    assert.ok(!stored.includes(ONE_PIXEL))
    assert.equal(textIn(second), ' Here it is:  Also at `the image`.')
  } finally {
    h.close()
  }
})

test('a failed image call, or one with nowhere to keep it, ends the card with a clear reason', async () => {
  const h = host()
  const keeper = imageKeeper()
  const off = h.provided.acpAgents.keepImages(keeper)
  try {
    const messages = []
    const failed = await turn(h, messages, 'image-call-fail')
    assert.equal(failed.steps[0].result.value.status, 'failed')
    assert.match(failed.steps[0].result.value.text, /could not make this image/)
    assert.equal(keeper.seen.failed.length, 1)
    assert.equal(keeper.seen.kept.length, 0)
    off()
    const homeless = await turn(h, messages, 'image-call')
    assert.equal(homeless.steps[0].result.value.status, 'failed')
    assert.match(homeless.steps[0].result.value.text, /no place to keep it/)
    assert.doesNotMatch(JSON.stringify(messages), /fake-codex-home|generated_images/)
    h.provided.acpAgents.keepImages(imageKeeper({ fail: true }))
    const full = await turn(h, messages, 'image-call')
    assert.match(full.steps[0].result.value.text, /could not be kept: the disk is full/)
  } finally {
    h.close()
  }
})

test('a call that answers with an image but makes none (a Read) keeps its own result', async () => {
  const h = host()
  const keeper = imageKeeper()
  h.provided.acpAgents.keepImages(keeper)
  try {
    const { steps } = await turn(h, [], 'image-call-other')
    const call = steps[0].find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
    assert.equal(JSON.parse(call.arguments).image, undefined, 'its title does not say image, so no image card')
    assert.equal(keeper.seen.started.length, 0)
    assert.equal(keeper.seen.kept.length, 0, 'the image it read is not copied into the team')
    assert.equal(keeper.seen.failed.length, 0)
    const value = steps[0].result.value
    assert.equal(value.status, 'completed', 'a JPEG it read does not fail the call')
    assert.equal(value.title, 'Read photo.jpg')
    assert.equal(value.text, 'Read photo.jpg')
    assert.doesNotMatch(value.text, /Image generated/)
  } finally {
    h.close()
  }
})


test('an rc.2 retry continues without forwarding DSH runtime context', () => {
  const retry = { role: 'user', source: { kind: 'retry', rpcId: 'retry-probe' }, content: [] }
  assert.deepEqual(promptOf([
    { role: 'assistant', content: [{ type: 'text', text: 'Previous answer' }] },
    retry,
    { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Internal runtime note' }] },
  ]), [{ type: 'text', text: 'Continue.' }])
})

test('an rc.2 retry after a failed request does not resend the accepted instruction', () => {
  assert.deepEqual(promptOf([
    { role: 'user', source: { kind: 'user', rpcId: 'original' }, content: [{ type: 'text', text: 'Perform the change once.' }] },
    { role: 'user', source: { kind: 'retry', rpcId: 'continue' }, content: [] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Private runtime policy.' }] },
  ]), [{ type: 'text', text: 'Continue.' }])
})

test('rc.2 Continue reaches the same ACP session once with no runtime notes', async t => {
  const h = host()
  t.after(h.close)
  const messages = []
  await turn(h, messages, 'hi')
  const run = h.adapter.live.get('s1').run
  const chunks = await step(h.adapter, [...messages,
    { role: 'user', source: { kind: 'retry', rpcId: 'retry-integration-probe' }, content: [] },
    { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Internal runtime note' }] },
  ])
  assert.equal(h.adapter.live.get('s1').run, run, 'the continuation keeps its ACP connection/session')
  assert.match(textIn(chunks), /turn 2: you said "Continue\."/)
  assert.doesNotMatch(textIn(chunks), /Internal runtime note/)
})

test('a kept Codex model missing from the live session fails before any prompt', async t => {
  const h = host()
  t.after(h.close)
  const trace = join(h.agent.session.header.cwd, 'kept-model-trace.jsonl')
  const agent = h.adapter.agents.get('acp-fake')
  agent.catalog.spec.fallback = AGENTS['acp-codex'].fallback
  agent.catalog.saved = { models: [
    ...AGENTS['acp-codex'].fallback, { id: 'gpt-6.1-sol', name: '6.1 Sol' },
  ] }
  agent.catalog.spec.key = () => undefined
  const spawn = agent.spawn
  agent.spawn = () => {
    const launch = spawn()
    return { ...launch, env: { ...launch.env, FAKE_ACP_TRACE: trace } }
  }
  assert.ok((await h.adapter.listModels('acp-fake')).some(row => row.id === 'gpt-6.1-sol'))
  const events = await step(h.adapter, [{ role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'x' }] }], { model: 'gpt-6.1-sol' })
  assert.equal(events.at(-1).reason.kind, 'error')
  assert.match(events.at(-1).reason.failure.message, /it offers no model gpt-6.1-sol/)
  assert.equal(traceEvents(trace).filter(event => event.event === 'prompt').length, 0)
})

test('#2132 T12 execute presentation exposes the command through completed terminal output', () => {
  const tool = mirrorTool({})
  const open = { id: 't12', title: 'A command', kind: 'execute', input: null }
  const meta = { title: open.title, kind: open.kind, text: 'output' }
  assert.deepEqual(tool.presentCall({ ...open, input: { command: 'echo CMD-MARK-2132' } }),
    { card: 'terminal', title: open.title, description: 'echo CMD-MARK-2132' })
  assert.deepEqual(tool.presentResult(open, { meta }), { card: 'terminal', title: open.title, output: 'output' })
  assert.deepEqual(tool.presentResult(open, { meta: { ...meta, command: 'echo late' } }),
    { card: 'terminal', title: open.title, output: '$ echo late\noutput' })
})
