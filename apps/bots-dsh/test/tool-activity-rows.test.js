import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, createToolResultMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { Backchannel } from '../../acp-dsh/src/host/backchannel.js'
import { callerItems } from '../src/host/caller-view.js'
import { DshChatSource, rowIdOf, rowsOf } from '../src/host/pocket-chat.js'
import { allowlist, fixture, guest, member } from './caller-fixture.js'
import { host as pocketGroupHost, watch as watchPocketGroup } from './support/pocket-groups.js'

const sharedModule = new URL('../src/shared/tool-activity.js', import.meta.url)
const activity = await import(sharedModule).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === sharedModule.href) return {}
  throw error
})
const syntax = await build({
  stdin: {
    contents: "export * from './src/client/cells.js'; export {installLocale} from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  Fragment: Symbol('fragment'), createElement: h, createContext: value => ({ value }), useContext: ctx => ctx.value,
  useEffect() {}, useLayoutEffect() {}, useMemo: factory => factory(), useRef: current => ({ current }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}], useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, read) => read(),
}
const module = { exports: {} }
runInNewContext(syntax.outputFiles[0].text, {
  module, exports: module.exports, URL, atob,
  require: name => name === 'react' ? react : {},
})
const ui = module.exports
function view(node) {
  if (node == null || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(view)
  if (typeof node !== 'object') return [String(node)]
  return typeof node.type === 'function' ? view(node.type(node.props)) : [node, ...view(node.props.children)]
}
const rowText = node => view(node).filter(child => child.props?.className === 'bt-agent-act-text')
  .map(child => view(child.props.children).filter(part => typeof part === 'string').join(''))
const bot = { id: 'b', name: 'Fixture', color: 'blue' }
const props = (over = {}) => ({
  sessionId: bot.id, actions: {}, useRoster: selector => selector({
    byId: { b: bot }, bots: [bot], rooms: [], roomsById: {}, exchangeTurns: {}, ...over,
  }),
})
const toRoot = ({ data }) => ({ phase: 'start', callId: data.callId, name: data.name, argsRaw: data.arguments, turn: data.turn, subCalls: [] })
const draw = (event, roster, extra = {}) => ui.ToolCell({ ...props(roster), ...extra, node: { key: String(event.seq), data: { root: toRoot(event) } } })
const event = (seq, type, data, extra) => ({ type, seq, time: seq, data, ...extra })
const call = (seq, callId, name, args = {}, turn = 1) => event(seq, 'tool/call', { turn, step: 0, callId, name, arguments: JSON.stringify(args) })
const dispatch = (seq, subCallId, name, args = {}, parentCallId = 'program') =>
  event(seq, 'tool/ptc-dispatch-start', { rootCallId: 'program', parentCallId, subCallId, name, arguments: args })
const receipt = (seq, callId, outcome = 'ran') => event(seq, 'plugin:acp-dsh/bridge-outside-step', { callId, name: 'list_bots', outcome }, { ignorable: true })
const turnStart = (seq, turn = 1) => event(seq, 'turn/start', { turn })
const turnEnd = (seq, turn = 1) => event(seq, 'turn/end', { turn, reason: { kind: 'completed' } })
const skill = (seq, turn = 1) => event(seq, 'plugin:automagik/skill-activity', { id: 'skill', name: 'mint', turn, step: 0 }, { ignorable: true })
const text = text => ({ type: 'text', text })
const user = content => createUserMessage({ source: { kind: 'user' }, content: [text(content)] })
const marker = 'SYNTHETIC-HEADER-2111'
const shellArgs = { command: 'ls -la # Authorization: Bearer ' + marker }
const readArgs = { file_path: '/tmp/fixture/notes.md' }
const safePocket = rows => rows.filter(row => row.kind === 'tool-call').map(({ tool, summary }) => tool + ': ' + summary)
const pocket = (events, hidden) => {
  const scope = { sessionId: 'b', turn: 0, calls: new Map(), hidden }
  return events.flatMap(event => rowsOf(event, scope))
}
const next = () => new Promise(resolve => setImmediate(resolve))

test('AT-2 validates complete operation and target fields before display', () => {
  const format = (name, args) => activity.toolActivityOf?.({ name, arguments: args })
  assert.deepEqual([
    format('bash', shellArgs),
    format('read', readArgs),
    format('read', { path: 'C:\\work\\notes.md' }),
    format('fetch', { url: 'https://fixture-user:fixture-pass@api.example.invalid/v1?key=synthetic' }),
    format('mcp__github__create_issue'),
    format('mcp__dsh__list_bots'),
    format('acp_tool', { kind: 'execute', title: marker, input: shellArgs }),
    format('acp_tool', { kind: 'other', title: 'mcp__linear__get_issue' }),
    format('acp_tool', { kind: 'other', title: marker }),
    format('read', { path: '/tmp/token=ghp_SYNTHETIC/notes.md' }),
    format('read', { path: '/tmp/token=ghp_SYNTHETIC' }),
    format('read', { path: '/tmp/notes.md\u0000' }),
    format('load_skill'), format('run_code'), format('ToolSearch'),
  ], [
    { label: 'tool', name: 'bash' },
    { label: 'tool', name: 'read', target: 'notes.md' },
    { label: 'tool', name: 'read', target: 'notes.md' },
    { label: 'tool', name: 'fetch', target: 'api.example.invalid' },
    { label: 'plugin', name: 'github · create_issue' },
    { label: 'tool', name: 'list_bots' },
    { label: 'tool', name: 'shell' },
    { label: 'plugin', name: 'linear · get_issue' },
    { label: 'tool', name: 'tool' },
    { label: 'tool', name: 'read' },
    { label: 'tool', name: 'read' },
    { label: 'tool', name: 'read' },
    undefined, undefined, undefined,
  ])
})

test('desktop activity reuses the chat row in flat and bubble layouts and localizes it', () => {
  const read = call(2, 'read', 'acp_tool', { kind: 'read', title: marker, locations: [{ path: readArgs.file_path }] })
  for (const layout of ['flat', 'bubble']) {
    assert.deepEqual(rowText(draw(read, { prefs: { layout } })), ['Tool: read · notes.md'])
  }
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const off = ui.installLocale({
    register() {},
    bind: () => (key, params) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (_token, name) => params[name]),
  })
  try { assert.deepEqual(rowText(draw(call(3, 'shell', 'bash', shellArgs))), ['Ferramenta: bash']) } finally { off() }
})

test('AT-6 keeps live cards and hidden stop lines while earlier parts fall back where a card is absent', async t => {
  const f = fixture(t)
  await f.start()
  const filled = call(4, 'memory', 'create_bot', { name: 'Fixture' })
  assert.deepEqual(rowText(draw(filled)), ['Tool: create_bot'])
  const hidden = { exchangeTurns: { b: [1] }, closedCards: { b: { question: { outcome: 'dismissed' } } } }
  const question = draw(call(5, 'question', 'ask_user', { question: 'Synthetic question?' }), hidden)
  assert.match(view(question).filter(value => typeof value === 'string').join(''), /Synthetic question/)
  const stopped = draw(call(6, 'stopped', 'bash'), hidden, {
    useWork: pick => pick({ stops: [{ why: 'guard', tool: 'bash', calls: [{ sessionId: 'b', callId: 'stopped' }] }] }),
  })
  assert.equal(view(stopped).filter(node => node.props?.role === 'status').length, 1)
  assert.deepEqual(rowText(stopped), [])
  assert.deepEqual(rowText(draw(filled, { roomsById: { b: { id: 'b' } } })), [])
  assert.deepEqual(f.rt.displayItems('b', [turnStart(0), filled], undefined, undefined, true)
    .map(({ kind, name }) => [kind, name]), [['tool-activity', 'create_bot']])
})

test('AT-6 dispatch nodes use their own sequence, interleave Skill rows, and deduplicate by call identity', async t => {
  const f = fixture(t)
  await f.start()
  const events = [
    turnStart(0), call(1, 'program', 'run_code'), dispatch(2, 'a', 'bash', shellArgs),
    skill(3), dispatch(4, 'b', 'read', readArgs), dispatch(5, 'a', 'bash'),
    turnEnd(6), receipt(7, 'bridge'), receipt(8, 'bridge'), receipt(9, 'no', 'refused'),
  ]
  const definitions = new Map()
  const ctx = { uiConversation: { events: { register: spec => { definitions.set(spec.kind, spec); return () => {} } } } }
  ui.registerSkillActivity(ctx)
  ui.registerToolActivity?.(ctx)
  const drawn = []
  for (const definition of definitions.values()) {
    const contexts = new Map()
    for (const event of events) {
      const match = definition.match[event.type]?.(event)
      if (!match) continue
      const location = event.seq < 7 ? { kind: 'step', turn: { turn: 1 } } : { kind: 'session' }
      const record = { event, location }
      const previous = () => ({ state: { turn: 1 } })
      const existing = contexts.get(match.id)
      if (existing) existing.state = definition.update(existing, record)
      else if (match.role === 'start') contexts.set(match.id, { key: match.id, id: match.id, start: record, current: new Map(),
        state: definition.start({}, record, { previous }) })
    }
    for (const context of contexts.values()) {
      const node = definition.buildViewNode?.(context)
      if (node?.visibility !== 'visible') continue
      const Component = node.kind === 'skill-activity' ? ui.SkillActivityCell : ui.ToolActivityCell
      for (const line of rowText(Component({ ...props(), node }))) drawn.push([node.anchorSeq, line])
    }
  }
  assert.deepEqual(drawn.sort((a, b) => a[0] - b[0]), [
    [2, 'Tool: bash'], [3, 'Skill: mint'], [4, 'Tool: read · notes.md'], [7, 'Tool: list_bots'],
  ])
  const earlier = f.rt.displayItems('b', events, undefined, undefined, true)
  assert.deepEqual(earlier.map(({ seq, kind, id }) => [seq, kind, id ?? null]), [
    [2, 'tool-activity', 'a'], [3, 'skill-activity', null], [4, 'tool-activity', 'b'], [7, 'tool-activity', 'bridge'],
  ])
  const output = pocket(events)
  assert.deepEqual(safePocket(output), ['Tool: run_code', 'Tool: bash', 'Skill: mint', 'Tool: read · notes.md', 'Tool: list_bots'])
  assert.deepEqual(output.filter(row => [2, 4, 7].some(seq => row.id === rowIdOf('b', seq))).map(row => row.input), ['', '', ''])
  assert.doesNotMatch(JSON.stringify(output.map(({ tool, summary }) => ({ tool, summary }))), new RegExp(marker))
})

test('AT-1 member and guest pages and live feeds stay private, including earlier parts', async t => {
  const f = fixture(t)
  await f.start()
  const id = await f.open('b', allowlist)
  f.event(id, 'turn/start', { turn: 1 })
  f.event(id, 'user/message', { source: { kind: 'user' }, content: [text('A visible request.')] })
  const stops = []
  for (const principal of [member, guest]) {
    const viewer = f.rt.viewerOf(principal)
    const route = f.ctx.get('automagikCallerRoutes').match('/api/omni-ui/feed', 'GET')
    const response = await route(new Request('http://fixture.invalid/api/omni-ui/feed?viewer=' + viewer.id + '.' + viewer.role), principal)
    const reader = response.body.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value), /^event: hello/)
    stops.push({ principal, reader })
  }
  const e = f.event(id, 'tool/call', call(2, 'read', 'read', readArgs).data)
  for (const { principal, reader } of stops) {
    let frame
    const read = reader.read().then(result => { frame = result })
    await next()
    assert.equal(frame, undefined)
    const page = await f.rt.callerChat(principal, 'b')
    assert.match(JSON.stringify(page), /A visible request/)
    assert.doesNotMatch(JSON.stringify(page), /notes\.md|tool-activity/)
    assert.deepEqual(callerItems(id, [turnStart(1), e], undefined, {}), [])
    await reader.cancel()
    await read
  }
  assert.deepEqual(f.rt.displayItems(id, [turnStart(1), e], undefined, undefined, true)
    .map(({ target }) => target), ['notes.md'])
  assert.equal((await f.call('bot-new-part', { botId: 'b' })).ok, true)
  await f.finishSwitch()
  for (const principal of [member, guest]) {
    const latest = await f.rt.callerChat(principal, 'b')
    assert.ok(latest.cursor)
    const earlier = await f.rt.callerChat(principal, 'b', latest.cursor)
    assert.match(JSON.stringify(earlier), /A visible request/)
    assert.doesNotMatch(JSON.stringify(earlier), /notes\.md|tool-activity/)
  }
})

test('AT-3 Pocket cold windows, resume and live delivery drop hidden or unshared calls and results', async () => {
  let shared = true
  let hidden = false
  const calls = [call(1, 'program', 'run_code'), call(2, 'read', 'read', readArgs)]
  const result = event(3, 'tool/result', { turn: 1, message: { toolCallId: 'read', content: [text('synthetic contents')] } })
  const sub = dispatch(4, 'child', 'bash', shellArgs)
  let page = [result, sub]
  const entry = { botId: 'b', sessionId: 'b', rows: [], controller: new AbortController(), cursor: 6, floorSeq: 7, status: {}, scope: undefined }
  const source = new DshChatSource({ adapter: { events: async () => ({ records: page.map(event => ({ event })) }) },
    bots: () => [{ id: 'b', sessionId: 'b' }], shown: () => shared, turnHidden: (_id, turn) => hidden && turn === 1 })
  entry.scope = source.rowScope('b')
  assert.deepEqual(await source.backfill(entry, rowIdOf('b', 6)), [])
  page = [turnStart(0), ...calls, result, sub]
  const visible = await source.backfill(entry, rowIdOf('b', 6))
  assert.deepEqual(visible.filter(row => row.kind === 'tool-result').map(row => [row.call, row.output]), [[rowIdOf('b', 2), 'synthetic contents']])
  assert.equal(visible.at(-1).input, '')
  hidden = true
  assert.deepEqual(await source.backfill(entry, rowIdOf('b', 6)), [])
  assert.deepEqual((await source.snapshotFor(entry, rowIdOf('b', 0))).rows, [])
  hidden = false
  entry.cursor = 0
  entry.listeners = new Set()
  const delivered = []
  entry.listeners.add(frame => delivered.push(frame))
  source.stillServed = async item => {
    shared = false
    return DshChatSource.prototype.stillServed.call(source, item)
  }
  const liveCall = calls[1]
  const live = async function* () {
    yield { type: 'event', event: liveCall }
    yield { type: 'event', event: result }
  }
  await source.pump(entry, live())
  assert.deepEqual(delivered.filter(frame => frame.type === 'rows'), [])
})

const provider = 'deepseek-official'
const model = 'fixture-model'
const fixtureEndpoint = 'https://fixture.invalid'
const connection = resolveAdapterOptions({ baseURL: fixtureEndpoint, models: [{ id: model, name: model }] })
const action = (name, args, id) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const actions = [action('bash', shellArgs, 'shell'), action('read', readArgs, 'read')]
const fakeOutputs = new Map([['bash', 'listed notes.md'], ['read', 'synthetic notes']])

function deepSeek(t, replies) {
  const wire = []
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.equal(url, fixtureEndpoint + '/v1/messages')
    wire.push(body)
    assert.ok(replies.length > 0, 'every model request has a synthetic response')
    const reply = replies.shift()
    const frames = [
      { type: 'message_start', message: { type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1 } } },
      ...reply.flatMap((part, index) => [
        { type: 'content_block_start', index, content_block: part.type === 'tool-call'
          ? { type: 'tool_use', id: part.id, name: part.name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: part.type === 'tool-call'
          ? { type: 'input_json_delta', partial_json: part.arguments } : { type: 'text_delta', text: part.text } },
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: reply.some(part => part.type === 'tool-call') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  })
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'synthetic', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  return { adapter, wire }
}

const acpStdio = String.raw`
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const send = value => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...value}) + '\n')
const tools = JSON.parse(process.env.FIXTURE_TOOLS)
const update = (sessionId, update) => send({method: 'session/update', params: {sessionId, update}})
let prompts = 0
for await (const line of createInterface({input: process.stdin})) {
  const {id, method, params} = JSON.parse(line)
  if (id === undefined) continue
  let result = {}
  if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} }
  if (method === 'session/new') result = { sessionId: 'fake-session' }
  if (method === 'session/prompt') {
    appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(params.prompt) + '\n')
    if (++prompts === 1) {
      for (const {toolCallId, name, kind, title, rawInput, locations} of tools) {
        update(params.sessionId, {sessionUpdate: 'tool_call', toolCallId, name, kind, title, rawInput, locations, status: 'in_progress'})
        update(params.sessionId, {sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
          content: [{type: 'content', content: {type: 'text', text: 'synthetic tool output'}}]})
      }
    }
    update(params.sessionId, {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Synthetic final reply.'}})
    result = { stopReason: 'end_turn' }
  }
  send({id, result})
}
`

function fakeAcp(t, session, route, tools = []) {
  const scratch = mkdtempSync(join(tmpdir(), 'tool-activity-acp-'))
  const trace = join(scratch, 'prompt.ndjson')
  const agent = { id: session.id, session, ctx: { tools: { register: () => () => {} } } }
  const services = {
    approval: { effectivePolicy: () => 'never' },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    tools: { async execute({ calls }) {
      return { results: calls.map(({ id }) => ({ callId: id, result: { content: [text('synthetic bridge output')], isError: false } })) }
    } },
  }
  const ctx = { agents: { get: id => id === session.id ? agent : undefined }, get: key => services[key] }
  const bridge = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([[route, {
    name: 'Synthetic ACP', installed: () => true, bridge: false,
    catalog: { models: async () => [{ id: 'default', name: 'Synthetic ACP' }], dispose() {} },
    spawn: () => ({ command: process.execPath, args: ['--input-type=module', '-e', acpStdio],
      env: { PATH: process.env.PATH, HOME: scratch, FIXTURE_TRACE: trace, FIXTURE_TOOLS: JSON.stringify(tools) } }),
  }]]))
  t.after(() => { adapter.dispose(); bridge.dispose(); rmSync(scratch, { recursive: true, force: true }) })
  const prompts = () => readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
  return { adapter, bridge, agent, prompts }
}

function openTurn(session, turn, prompt) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  session.append('user/message', prompt, { surfaceOp: 'append' })
}

const stream = (t, session, adapter, provider, model) => Array.fromAsync(adapter.stream(markAgentLoopRequest({
  provider, model, sessionId: session.id, messages: session.deriveMessages(), signal: t.signal,
})))

async function playTurn(t, session, adapter, provider, model, turn, execute, onCall = () => {}) {
  for (let step = 0; step < 4; step++) {
    if (step !== 0) session.append('step/start', { turn, step })
    const chunks = await stream(t, session, adapter, provider, model)
    const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    const reason = chunks.at(-1)?.reason
    assert.ok(['tool-calls', 'stop'].includes(reason?.kind), JSON.stringify(reason))
    session.append('assistant/message', { turn, step, message: { role: 'assistant', content,
      source: { kind: 'model', provider, model } }, stream: [] }, { surfaceOp: 'append' })
    for (const args of content.filter(part => part.type === 'tool-call')) {
      const call = session.append('tool/call', { turn, step, callId: args.id, name: args.name, arguments: args.arguments })
      onCall(call)
      const output = await execute(args)
      const message = createToolResultMessage({ callId: args.id, content: [text(output)], isError: false })
      session.append('tool/result', { turn, step, message }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn, step })
    if (reason.kind === 'stop') {
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return content.filter(part => part.type === 'text').map(part => part.text).join('')
    }
  }
  assert.fail('the synthetic turn did not reach its final reply')
}

const acpCalls = [
  { toolCallId: 'shell', name: 'Bash', kind: 'execute', title: 'Run command', rawInput: shellArgs },
  { toolCallId: 'read', name: 'Read', kind: 'read', title: 'Read a file', locations: [{ path: readArgs.file_path }] },
]
const mirror = (t, fake) => async args => {
  const input = JSON.parse(args.arguments)
  const result = await fake.adapter.tool.execute(input, { name: args.name, callId: args.id, agent: fake.agent, signal: t.signal })
  assert.equal(result.status, 'completed')
  return result.text
}
const callEvents = session => session.snapshotEvents().filter(event => event.type === 'tool/call')

test('fake E2E ACP Claude: two mirror calls reach desktop and Pocket in order, then the final reply', { timeout: 20_000 }, async t => {
  const route = 'acp-claude'
  const session = Session.create('fixture-acp')
  const fake = fakeAcp(t, session, route, acpCalls)
  openTurn(session, 1, user('List the synthetic folder, then open the notes.'))
  const outcome = await playTurn(t, session, fake.adapter, route, 'default', 1, mirror(t, fake))
  const before = session.snapshotEvents().length
  const calls = callEvents(session)
  assert.equal(outcome, 'Synthetic final reply.')
  assert.deepEqual(calls.map(call => call.data.name), ['acp_tool', 'acp_tool'])
  assert.match(calls[0].data.arguments, new RegExp(marker))
  const desktop = calls.flatMap(call => rowText(draw(call)))
  const phone = safePocket(pocket(session.snapshotEvents()))
  const nextPrompt = user('What did you find?')
  openTurn(session, 2, nextPrompt)
  assert.equal(await playTurn(t, session, fake.adapter, route, 'default', 2, mirror(t, fake)), 'Synthetic final reply.')
  assert.deepEqual(fake.prompts().at(-1), [text('What did you find?')])
  assert.equal(session.snapshotEvents().filter(event => event.data?.turn === 1).length,
    session.snapshotEvents().slice(0, before).filter(event => event.data?.turn === 1).length)
  assert.deepEqual({ desktop, phone }, {
    desktop: ['Tool: shell', 'Tool: read · notes.md'], phone: ['Tool: shell', 'Tool: read · notes.md'],
  })
})

test('AT-5 mirrors on all other ACP routes, the remote route, and a successful bridge receipt', { timeout: 25_000 }, async t => {
  const observed = []
  for (const route of ['acp-codex', 'acp-antigravity', 'acp-omp', 'acp-hermes']) {
    const session = Session.create(route)
    const fake = fakeAcp(t, session, route, [acpCalls[1]])
    openTurn(session, 1, user('Read the synthetic notes.'))
    assert.equal(await playTurn(t, session, fake.adapter, route, 'default', 1, mirror(t, fake)), 'Synthetic final reply.')
    assert.deepEqual(callEvents(session).map(event => event.data.name), ['acp_tool'])
    observed.push(callEvents(session).flatMap(event => rowText(draw(event))))
    if (route === 'acp-codex') {
      for (let repeat = 0; repeat < 2; repeat++) {
        const outside = await fake.bridge.selfOpenedCall({ agent: fake.agent, controllers: new Set() }, {
          name: 'list_bots', raw: '{}', callId: 'outside', authority: t.signal, ended: () => false,
        })
        assert.equal(outside.isError, false)
      }
      const receipts = session.snapshotEvents().filter(event => event.type === 'plugin:acp-dsh/bridge-outside-step')
      assert.ok(receipts.length >= 1 && receipts.every(event => event.data.outcome === 'ran'))
      observed.push(safePocket(pocket(session.snapshotEvents())).slice(1))
      assert.deepEqual(safePocket(pocket(session.snapshotEvents(), turn => turn === 1)), [])
    }
  }
  const remote = call(1, 'remote', 'remote_hermes_tool', { id: 'remote', title: marker, input: shellArgs })
  observed.push(rowText(draw(remote)))
  observed.push(safePocket(pocket([turnStart(0), remote])))
  assert.deepEqual(observed, [
    ['Tool: read · notes.md'], ['Tool: list_bots'], ['Tool: read · notes.md'],
    ['Tool: read · notes.md'], ['Tool: read · notes.md'], ['Tool: tool'], ['Tool: tool'],
  ])
})

function scopeRoom(h, exchangeId, anchor) {
  h.rt.ledger.append('group-r1', { kind: 'skill-activity', event: 'scope',
    exchangeId, sessionId: 'gb', botId: 'b', after: h.room().seq, ...(anchor && { anchor }) })
}
const roomSource = exchangeId => ({ kind: 'bot', role: 'room', roomId: 'r1', exchangeId })
function startRoomTurn(h, turn, source) {
  h.emit('gb', 'turn/start', { turn })
  h.emit('gb', 'user/message', { source, role: 'user', content: [text('Synthetic request.')] })
}
const onlyActivity = rows => rows.filter(row => row.kind === 'tool-activity')

test('AT-7 exact room, member, exchange and relay anchor survive concurrent relays and replay', async t => {
  const h = await pocketGroupHost(t)
  assert.deepEqual(h.rt.groupOwners.get('gb'), { botId: 'b', roomId: 'r1' })
  h.rt.ledger.append('group-r1', { event: 'anchor', id: 'first', from: 1, time: 1 })
  scopeRoom(h, 'one', 'first')
  h.rt.ledger.append('group-r1', { event: 'anchor', id: 'second', from: 1, time: 2 })
  scopeRoom(h, 'two', 'second')
  scopeRoom(h, 'no-anchor')
  const deliver = (turn, source, id, args = {}) => {
    startRoomTurn(h, turn, source)
    const data = call(1, id, 'read', args, turn).data
    h.emit('gb', 'tool/call', data)
    h.emit('gb', 'tool/call', data)
    h.emit('gb', 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  deliver(1, roomSource('one'), 'same-id', { path: '/tmp/token=ghp_SYNTHETIC' })
  // A private request on the same member Session cannot inherit either relay.
  deliver(2, { kind: 'bot', role: 'request', noReply: true, exchangeId: 'two' }, 'private', readArgs)
  deliver(3, roomSource('two'), 'same-id', readArgs)
  deliver(4, roomSource('no-anchor'), 'missing', readArgs)
  const privateBot = h.rt.isPrivate
  h.rt.isPrivate = id => id === 'b'
  deliver(5, roomSource('two'), 'private-bot', readArgs)
  assert.equal(onlyActivity(h.rt.groupRowsView('r1', 1, undefined, 'second', true, { live: true }).rows).length, 0)
  h.rt.isPrivate = privateBot
  const activityRecords = onlyActivity(h.rt.ledger.records('group-r1'))
  assert.deepEqual(activityRecords.map(({ id, anchor, exchangeId, seq, target }) => [id, anchor, exchangeId, seq, target]), [
    ['same-id', 'first', 'one', undefined, undefined], ['same-id', 'second', 'two', undefined, 'notes.md'],
  ])
  assert.doesNotMatch(JSON.stringify(activityRecords), /SYNTHETIC|token=|\/tmp\//)
  for (const [anchor, target] of [['first', undefined], ['second', 'notes.md']]) {
    const rows = onlyActivity(h.rt.groupRowsView('r1', 1, undefined, anchor, true, { live: true }).rows)
    assert.deepEqual(rows.map(row => [row.botId, row.target]), [['b', target]])
  }
  assert.deepEqual(onlyActivity(h.rt.groupRowsView('r1', 1).rows), [])
  assert.deepEqual(onlyActivity(await h.rt.groupLinesAfter('r1', 0)), [])
})

test('Pocket group watch, resume and backfill serve group messages without member tool activity', async t => {
  const h = await pocketGroupHost(t)
  h.quote({ who: 'User', text: 'First group line.' })
  h.rt.ledger.append('group-r1', { kind: 'tool-activity', event: 'call', botId: 'b', id: 'hidden-group-tool',
    label: 'tool', name: 'read', target: 'notes.md' })
  h.quote({ who: 'User', text: 'Second group line.' })
  const { handle, events } = await watchPocketGroup(h)
  assert.deepEqual(events.find(frame => frame.type === 'snapshot').rows.map(row => row.text), ['First group line.', 'Second group line.'])
  const first = events.find(frame => frame.type === 'snapshot').rows[0].id
  const resumed = await watchPocketGroup(h, { after: first })
  assert.deepEqual(resumed.events.find(frame => frame.type === 'snapshot').rows.map(row => row.text), ['Second group line.'])
  assert.deepEqual((await handle.backfill(events.find(frame => frame.type === 'snapshot').rows[1].id)).map(row => row.text), ['First group line.'])
  resumed.handle.close()
  handle.close()
})

test('fake E2E native and AT-4: recording on versus off preserves wire bytes, ACP prompt, room reads and cursors', { timeout: 25_000 }, async t => {
  const deep = deepSeek(t, [actions, [text('Synthetic final reply.')], [text('Synthetic follow-up.')],
    actions, [text('Synthetic final reply.')], [text('Synthetic follow-up.')]])
  const outcomes = []
  for (const recording of [false, true]) {
    const h = await pocketGroupHost(t)
    if (!recording) h.rt.roomToolActivity = undefined
    h.quote({ who: 'User', text: 'Earlier group line.' })
    h.rt.ledger.append('group-r1', { event: 'anchor', id: 'relay', from: 1, time: 0 })
    scopeRoom(h, 'exchange', 'relay')
    const session = Session.create('gb')
    openTurn(session, 1, user('Use two synthetic tools.'))
    startRoomTurn(h, 1, roomSource('exchange'))
    const onCall = event => h.emit('gb', event.type, event.data)
    const outcome = await playTurn(t, session, deep.adapter, provider, model, 1, args => {
      assert.ok(fakeOutputs.has(args.name))
      return fakeOutputs.get(args.name)
    }, onCall)
    h.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = session.snapshotEvents()
    const shown = {
      desktop: callEvents(session).flatMap(event => rowText(draw(event))),
      pocket: safePocket(pocket(events)),
      group: onlyActivity(h.rt.groupRowsView('r1', 1, undefined, 'relay').rows).map(({ name }) => name),
    }
    assert.equal(session.snapshotEvents().length, events.length)
    const reads = (await h.rt.groupLinesAfter('r1', 0)).map(({ who, seq, text }) => ({ who, seq, text }))
    const report = h.rt.groupRows('r1', 1, undefined, 'relay').map(({ kind, text }) => [kind, text])
    const cursors = { seen: structuredClone(h.room().seen), seq: h.room().seq }
    const nextPrompt = user('Read back from cursor ' + JSON.stringify(cursors) + ': ' + JSON.stringify(reads))
    openTurn(session, 2, nextPrompt)
    const follow = await playTurn(t, session, deep.adapter, provider, model, 2, () => assert.fail('unexpected fake tool'))
    const acp = fakeAcp(t, session, 'acp-claude')
    openTurn(session, 3, user('Compare this group report: ' + JSON.stringify(report)))
    await playTurn(t, session, acp.adapter, 'acp-claude', 'default', 3, mirror(t, acp))
    outcomes.push({ shown, reads, report, cursors, acp: acp.prompts(),
      wire: deep.wire.slice(-3), count: session.snapshotEvents().length, outcome, follow })
    await h.dispose()
  }
  const [{ shown: off, ...withoutActivity }, { shown: on, ...withActivity }] = outcomes
  assert.deepEqual(withActivity, withoutActivity)
  assert.equal(withActivity.outcome, 'Synthetic final reply.')
  assert.equal(withActivity.follow, 'Synthetic follow-up.')
  assert.deepEqual(off.group, [])
  assert.deepEqual(on, {
    desktop: ['Tool: bash', 'Tool: read · notes.md'], pocket: ['Tool: bash', 'Tool: read · notes.md'], group: ['bash', 'read'],
  })
})
