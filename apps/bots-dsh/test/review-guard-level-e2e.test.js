// The real ACP adapter, Bots guard and DSH tool executor. Only the model steps and
// the agent at the other end of stdio are driven by the fixture.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { apply as applyAcp } from '../../acp-dsh/index.js'
import { AGENTS } from '../../acp-dsh/src/host/agents.js'
import { apply as applyBots } from '../index.js'
import { WHY_EN, stopLineEn } from '../src/host/stops.js'
import { fakeContext } from './fake-ctx.js'

const PROVIDER = 'acp-claude'
const MODEL = { provider: PROVIDER, model: 'default' }
const FAKE = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).pathname
const FULL = 'danger-full-access'
const cases = { timeout: 18_000 }
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const outputOf = row => row?.data.message.content.map(block => block.text ?? '').join('')
const turnText = text => [{ type: 'text', text }]

// The pinned DSH chat uses GenericToolCard for acp_tool. Run its own JSX and
// disclosure body with the same minimal React seat used by the sidebar tests.
const element = (type, props) => ({ type, props })
const textOf = node => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node === 'boolean' || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props.children)
}
function replayCard(opening, closed) {
  const bundle = readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-tool/client')), 'utf8')
  let client
  const passthrough = props => props.children
  const platform = {
    react: { memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn, Fragment: 'fragment' },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {
      DisclosureRow: passthrough, TextShimmer: passthrough, diffTotals: () => ({}),
    },
  }
  runInNewContext(bundle, {
    TextEncoder, TextDecoder,
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(name => platform[name]) } } },
  })
  let card
  client.apply({
    remote: { $host: {} }, plugin() {},
    slots: { inject: (_slot, install) => install(), register: (_options, view) => { card = view } },
  })
  const call = opening.data
  const result = closed.data
  const args = PartialArguments.fromText(call.arguments)
  const block = { kind: 'tool-result', callId: call.callId, name: call.name, args,
    call: { name: call.name, argsRaw: call.arguments },
    content: result.message.content, meta: result.meta, isError: result.message.isError, subCalls: [] }
  return textOf(element(card, {
    node: { data: { root: block } }, t: key => key, useContextMenu: () => ({ getTriggerProps: () => ({}) }),
    useHostInfo: pick => pick({}), renderSlot: (_name, _props, options) => options.fallback,
    useDisclosure: () => ({ expanded: true, toggle() {} }),
  }))
}

async function world(t, { manual = false, guard = true, attempt, replaceSessionOnRelease = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-guard-2132-'))
  const tracePath = join(dir, 'agent.jsonl')
  const ctx = new Context()
  const sessionId = 'solver-2132'
  const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: 0, isSeeded: false, cwd: dir })
  const agent = { id: sessionId, session, status: 'idle' }
  const approval = {
    effectivePolicy: () => manual ? 'ask' : 'never',
    overrideOf: () => 'ask',
    request: async () => 'rejected',
  }
  const preset = manual ? 'manual' : FULL
  const permissionPresets = {
    current: () => preset,
    resolve: () => ({ sandbox: FULL, approval: approval.effectivePolicy() }),
    catalog: () => ({ defaultPreset: preset }),
  }
  const sandboxPolicy = { defaultMode: FULL, resolve: () => ({ mode: FULL }) }
  let registeredSession = session
  const sessions = { list: () => [registeredSession], get: id => id === sessionId ? registeredSession : undefined }
  for (const [key, service] of Object.entries({
    approval, permissionPresets, sandboxPolicy, sessions,
    systemPrompt: { tools() {}, section() {} },
    workingDirectory: { ensure: async () => dir },
    agentPresets: { presetForSession: () => 'standard' },
    agents: { list: () => [agent], get: id => id === sessionId ? agent : undefined },
  })) ctx.provide(key, service)
  let adapter
  ctx.provide('llm', { registerAdapter(_routes, value) { adapter = value; return () => {} } })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  let scopes
  await ctx.plugin({ name: 'guard-fixture-agents', inject: ['tools'], apply(child) { scopes = child } })
  const scope = createScope(scopes, agent)
  agent.ctx = scope.ctx
  const team = fakeContext({ services: { approval, permissionPresets, sandboxPolicy } })
  team.sessions = sessions
  t.after(async () => {
    adapter?.dispose()
    await scope.dispose()
    await ctx.root.fiber.dispose()
    await team.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  applyAcp(ctx, { fakeAgent: FAKE, claude: false, codex: false, nativeTools: true, dshTools: true }, {
    store: { binOf: () => undefined }, find: () => undefined,
  })
  if (replaceSessionOnRelease) {
    const awaitApprovals = adapter.backchannel.awaitApprovals.bind(adapter.backchannel)
    adapter.backchannel.awaitApprovals = async (...args) => {
      await awaitApprovals(...args)
      registeredSession = Session.create(sessionId, undefined, session.header)
    }
  }
  const fake = adapter.agents.get('acp-fake')
  adapter.agents.set(PROVIDER, {
    ...fake,
    modeFor: AGENTS[PROVIDER].modeFor,
    spawn: () => ({
      command: process.execPath, args: [FAKE], env: {
        PATH: process.env.PATH, HOME: dir, FAKE_ACP_TRACE: tracePath,
        FAKE_ACP_MODES: 'default,auto,bypassPermissions',
      },
    }),
  })
  adapter.registerMirror(agent)
  applyBots(team, { home: join(dir, 'team') })
  const rt = team.provided.get('omniTeam')
  await rt.load()
  rt.state.reviewGuardMigrated = true
  rt.state.nativeToolsLocksRetired = true
  rt.chatOwners.set(sessionId, sessionId)
  rt.state.bots.reviewer = { id: 'reviewer', name: 'Reviewer', role: 'Helper', createdAt: 1 }
  const bot = rt.state.bots[sessionId] = {
    id: sessionId, name: 'Solver', role: 'Solver', reviewerId: 'reviewer', instructions: 'Fake.',
    shell: true, workDir: dir, model: PROVIDER + '/default', nativeTools: true, nativeToolsAgent: PROVIDER,
    createdAt: 1, reviewGuard: guard,
  }
  bot.reviewTrack = { requested: true, requestAt: 1, verdicts: [] }
  if (attempt) {
    const plan = { revision: 0, checks: ['check'], accepted: true, commands: { check: 'touch unasked-1' } }
    const solver = { request: 'req-2132', origin: 'person', attempts: {}, runs: {}, revision: 0, plan }
    if (attempt === 'limit') solver.limit = { kind: 'fix', check: 'check', at: 1 }
    if (attempt === 'solver-progress') solver.pending = { checks: ['check'], run: 'pending', call: 'another-call' }
    bot.reviewTrack = { requested: true, requestAt: 1, planVerdictAt: 2, solver }
  }

  const openOf = callId => session.snapshotEvents().find(row => row.type === 'tool/call' && row.data.callId === callId)
  const closeOf = callId => session.snapshotEvents().find(row => row.type === 'tool/result' && row.data.message.toolCallId === callId)
  const waitFor = async verify => {
    const end = Date.now() + 5_000
    while (!verify()) {
      assert.ok(Date.now() < end, 'the fake agent did not deliver the changed arguments')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const live = () => adapter.live.get(sessionId)
  // The barriers only time fake notifications. The guard and executor still decide the calls.
  const observed = new Map()
  ctx.on('tools/execute', async (exec, next) => {
    const id = exec.arguments?.id
    if (id) {
      assert.equal(live()?.toolIds.get(exec.callId), id)
      observed.set(id, exec.callId)
    }
    if (id === 'guard-parent') writeFileSync(join(dir, '.guard-parent-open'), '')
    if (id === 'guard-mutated') {
      writeFileSync(join(dir, '.guard-child-open'), '')
      await waitFor(() => live()?.run.tools.get(id)?.rawInput?.file_path === 'different.txt')
    }
    if (id === 'guard-terminal') {
      assert.equal(JSON.parse(openOf(exec.callId).data.arguments).input, null)
      writeFileSync(join(dir, '.guard-terminal-open'), '')
    }
    return next()
  }, { prepend: true })
  for (const listener of team.listeners.get('tools/execute')) ctx.on('tools/execute', listener)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const { name, description, parameters } = adapter.tool
  session.append('request/header', { header: { config: MODEL, tools: [{ name, description, parameters }] }, reason: 'initial' })
  const messages = []
  const step = async () => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ ...MODEL, sessionId, messages, signal: t.signal }))) chunks.push(chunk)
    return chunks
  }
  const execute = async prompt => {
    messages.push({ role: 'user', source: { kind: 'user' }, content: turnText(prompt) })
    const chunks = await step()
    const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    const call = blocks.find(block => block.type === 'tool-call')
    assert.ok(call, JSON.stringify(chunks))
    assert.equal(live().native, true)
    assert.equal(live().toolIds.get(call.id), JSON.parse(call.arguments).id)
    const message = createAssistantMessage({ content: blocks, source: MODEL })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message }, { surfaceOp: 'append' })
    messages.push(message)
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: MODEL, signal: t.signal })
    try {
      const batch = await ctx.tools.execute({
        calls: [{ id: call.id, name: call.name, arguments: call.arguments }], agent, signal: t.signal, toolSet, log: { turn: 1, step: 1 },
      })
      const result = batch.results[0].result
      messages.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: result.content })
      return call.id
    } finally { toolSet.dispose() }
  }
  const trace = () => readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const stopOf = callId => rt.stopsView().find(stop => stop.calls.some(call => call.sessionId === sessionId && call.callId === callId))
  return { dir, adapter, session, sessions, bot, observed, live, execute, step, trace, openOf, closeOf, stopOf }
}

for (const [label, manual, why] of [
  ['E1 Full access', false, 'guard'],
  ['E3 Manual', true, 'guard'],
  ['E4a attempt limit', false, 'limit'],
  ['E4b check run required', false, 'solver-run'],
  ['E4c progress pending', false, 'solver-progress'],
]) {
  test('#2132 ' + label + ' records the completed mirror', cases, async t => {
    const attempt = why === 'guard' ? undefined : why
    const w = await world(t, { manual, guard: !attempt, attempt })
    const before = JSON.stringify(w.bot.reviewTrack)
    const progressBefore = JSON.stringify(w.bot.reviewTrack.solver)
    const callId = await w.execute('unasked')
    const ran = w.trace().find(event => event.event === 'own-tool-ran')
    assert.equal(ran.mode, manual ? 'default' : 'bypassPermissions')
    assert.equal(w.live().toolIds.get(callId), ran.toolCallId)
    assert.equal(JSON.parse(w.openOf(callId).data.arguments).input.command, 'touch unasked-1')
    const row = w.closeOf(callId)
    const stop = w.stopOf(callId)
    assert.equal(stop.why, why)
    const { firstWorkAt, lastWorkAt, ...otherTrackFields } = w.bot.reviewTrack
    assert.equal(JSON.stringify(otherTrackFields), before)
    assert.equal(JSON.stringify(w.bot.reviewTrack.solver), progressBefore)
    assert.equal(typeof firstWorkAt, 'number')
    assert.equal(lastWorkAt, firstWorkAt)
    assert.notEqual(row.data.message.isError, true, outputOf(row))
    assert.match(outputOf(row), /ran 1/)
    assert.equal(stop.ran, true)
    assert.equal(stop.mayHaveRun, undefined)
    assert.equal(stop.text, WHY_EN[why])
    assert.match(stopLineEn(stop), /^acp_tool ran unheld:/)
  })
}

test('#2132 E2 a command the guard refused before execution is recorded as did not run', cases, async t => {
  const w = await world(t)
  const callId = await w.execute('hello')
  const [tool] = w.live().run.tools.values()
  assert.equal(w.live().toolIds.get(callId), tool.id)
  assert.match(outputOf(w.closeOf(callId)), /review guard holds work/)
  const reply = textIn(await w.step())
  assert.equal(tool.status, 'failed')
  assert.match(reply, /I was not allowed to run it/)
  assert.doesNotMatch(reply, /It printed hello/)
  const stop = w.stopOf(callId)
  assert.equal(stopLineEn(stop), `acp_tool did not run: ${WHY_EN.guard}`)
  assert.equal(stop.mayHaveRun, undefined)
})

test('#2132 E5 nested held and changed questions are refused and an open sibling runs', cases, async t => {
  const w = await world(t)
  const parent = await w.execute('guard-nested')
  const trace = w.trace()
  assert.equal(w.live().toolIds.get(parent), trace.find(event => event.event === 'own-tool-ran')?.toolCallId)
  assert.ok(existsSync(join(w.dir, 'nested-parent')))
  assert.notEqual(w.closeOf(parent).data.message.isError, true, outputOf(w.closeOf(parent)))
  assert.equal(w.stopOf(parent).ran, true)
  for (const id of ['guard-held', 'guard-mutated']) {
    assert.equal(trace.find(event => event.event === 'native-tool-refused' && event.toolCallId === id)?.answer, 'no')
    assert.ok(!trace.some(event => event.event === 'native-tool-ran' && event.toolCallId === id))
    assert.ok(w.closeOf(w.observed.get(id)))
  }
  assert.ok(!existsSync(join(w.dir, 'held-child')))
  assert.match(stopLineEn(w.stopOf(w.observed.get('guard-held'))), /did not run/)
  assert.equal(trace.find(event => event.event === 'native-tool-ran' && event.toolCallId === 'guard-sibling')?.name, 'Read')
  assert.ok(w.closeOf(w.observed.get('guard-sibling')))
  assert.equal(JSON.parse(w.openOf(w.observed.get('guard-mutated')).data.arguments).parent, 'guard-sibling')
})

for (const [label, prompt, command] of [['E6', 'late-command', 'touch late-2132'], ['E6b', 'no-command', undefined]]) {
  test('#2132 ' + label + ' replays the command only when the same execute call provided it', cases, async t => {
    const w = await world(t, { guard: false })
    const callId = await w.execute(prompt)
    assert.equal(w.live().toolIds.get(callId), w.trace().find(event => event.event === 'own-tool-ran')?.toolCallId)
    const replay = Session.create(w.session.id, JSON.parse(JSON.stringify(w.session.snapshotEvents())), w.session.header)
    const opening = replay.snapshotEvents().find(row => row.type === 'tool/call' && row.data.callId === callId)
    const closed = replay.snapshotEvents().find(row => row.type === 'tool/result' && row.data.message.toolCallId === callId)
    const args = JSON.parse(opening.data.arguments)
    assert.equal(args.input, null)
    assert.equal(closed.data.meta?.command, command)
    const view = w.adapter.tool.presentResult(args, { ...closed.data.message, meta: closed.data.meta })
    assert.equal(view.card, 'terminal')
    assert.equal(view.title, args.title)
    assert.equal(view.output, command ? `$ ${command}\nterminal result` : 'terminal result')
    assert.equal(view.description, undefined)
    const rendered = replayCard(opening, closed)
    assert.ok(rendered.includes('terminal result'))
    assert.equal(rendered.includes('touch late-2132'), command !== undefined)
    t.diagnostic(JSON.stringify({ opening: args.input, command: closed.data.meta?.command ?? null, view, rendered }))
  })
}

for (const guard of [true, false]) {
  test(`#2132 source release preserves result provenance on ${guard ? 'marked' : 'unmarked'} mirrors`, cases, async t => {
    const w = await world(t, { guard, replaceSessionOnRelease: true })
    const callId = await w.execute('late-command')
    const current = w.sessions.get(w.session.id)
    assert.equal(current.id, w.session.id)
    assert.notEqual(current, w.session)
    assert.equal(w.live().dshAgent.session, w.session)
    const opening = w.openOf(callId)
    const closed = w.closeOf(callId)
    assert.equal(JSON.parse(opening.data.arguments).input, null)
    assert.equal(w.live().toolIds.get(callId), w.trace().find(event => event.event === 'own-tool-ran')?.toolCallId)
    assert.equal(closed.data.meta?.text, 'terminal result')
    if (guard) {
      const stop = w.stopOf(callId)
      assert.deepEqual([stop?.ran, stop?.mayHaveRun], [undefined, true])
    }
    assert.equal(closed.data.meta?.command, undefined)
    const rendered = replayCard(opening, closed)
    assert.ok(rendered.includes('terminal result'))
    assert.ok(!rendered.includes('touch late-2132'))
  })
}
