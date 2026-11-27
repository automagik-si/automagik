import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { fileURLToPath } from 'node:url'
import { apply as applyAcp } from '../../acp-dsh/index.js'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, createAssistantMessage, LlmAdapter, markAgentLoopRequest, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { AgentRun } from '../../acp-dsh/src/host/acp.js'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { callArguments } from '../../acp-dsh/src/host/tool.js'
import { apply } from '../index.js'
import { ROUTE, STEER_CUT } from '../src/host/constants.js'
import { questionReply } from '../src/host/parts.js'
import { socketPathOf } from '../src/host/pocket-socket.js'
import { inspectResult, resultSnapshot } from '../src/host/solver-progress.js'
import { answerSender } from '../src/host/turns.js'
import { DICTIONARY, installLocale } from '../src/client/i18n.js'
import { reviewMarkText, solverAutoView } from '../src/client/solver-draft.js'
import { stopLine, whyText } from '../src/client/stops.js'
import { guardVerdictOf } from '../src/shared/review-guard.js'
import { verdictOf } from '../src/shared/review-mark.js'
import { solverInstructions } from '../src/shared/solver-method.js'
import { fakeContext } from './fake-ctx.js'
import { immediate, until } from './until.js'
import { PT_BR, ptBrLocale } from './fixtures/pt-br-locale.js'
import { NewSolver, mount, all, text } from './fixtures/solver-dialog.mjs'

const solverModel = { provider: 'fake', model: 'solver-model' }
const reviewerModel = { provider: 'fake', model: 'reviewer-model' }
const refOf = ({ provider, model }) => `${provider}/${model}`
const content = text => [{ type: 'text', text }]

function scopedReadMarker(t) {
  // The fixture's app data lives under its own temp directory.
  const folder = mkdtempSync(join(tmpdir(), 'solver-read-'))
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))
  const marker = join(folder, 'fixture.txt')
  writeFileSync(marker, 'synthetic research')
  return marker
}

function fixture(t, home = mkdtempSync(join(tmpdir(), 'solver-limits-')), { liveTurn, configure, agents = new Map() } = {}) {
  const ctx = fakeContext()
  let identity
  ctx.acpAgents = {
    botIdentity: read => { identity = read },
    rolePromptProviders: ['acp-claude', 'acp-codex'],
  }
  const get = ctx.get
  ctx.get = name => name === 'acpAgents' ? ctx.acpAgents : get(name)
  const sessionOf = id => agentOf(id).session
  function agentOf(id) {
    if (!agents.has(id)) {
      const model = id === 'reviewer' ? reviewerModel : solverModel
      agents.set(id, {
        id, model: { current: () => model },
        session: { id, header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
          requestHeader: () => ({ config: model }) },
        ctx: { tools: { restrict: () => () => {} }, effect: run => run() },
        followup(message) { this.message = message },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    workspaceRegistry: { get: () => ({ path: home }) },
    sessionController: {
      create: async options => ({ sessionId: options.sessionId }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { get: sessionOf, flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  if (liveTurn !== undefined) {
    const agent = agentOf('solver')
    agent.status = 'running'
    agent.session.seq = 1
    agent.session.eventAt = seq => seq === 0 ? { type: 'turn/start', data: { turn: liveTurn } } : undefined
    ctx.provided.set('agents', { list: () => [agent] })
  }
  configure?.(ctx, agentOf)
  apply(ctx, { home })
  let disposed = false
  const close = async () => { if (!disposed) { disposed = true; await ctx.dispose() } }
  t.after(close)
  const rt = ctx.provided.get('omniTeam')
  let seq = 0
  const event = (id, type, data, ordinal = ++seq) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      listener(sessionOf(id), { type, data, seq: ordinal, time: 100 })
    }
  }
  const person = (text, id = 'solver') => event(id, 'user/message', { content: content(text), source: { kind: 'user' } })
  const takeInput = (id, message) => {
    ctx.emit('agent/inbox/claimed', { agent: agentOf(id), message })
    event(id, 'user/message', message)
  }
  const botMessage = async () => {
    const agent = agentOf('solver')
    if (ctx.get('agents') === undefined) ctx.provided.set('agents', { get: id => agents.get(id), list: () => [...agents.values()] })
    const message = { id: `bot-message-${++seq}`, content: content('New Bot work.'), source: {
      kind: 'bot', role: 'request', senderSessionId: 'other', exchangeId: `bot-exchange-${seq}`,
    } }
    const admit = ctx.listeners.get('agent/pre-step').find(listener => listener.name === 'admitBotStep')
    assert.equal(await admit({ agent, messages: [message] }, () => true), true)
    takeInput('solver', message)
  }
  const finish = (id, text) => {
    event(id, 'assistant/message', { message: { content: content(text) } })
    event(id, 'turn/end', { reason: { kind: 'completed' } })
  }
  const tool = (name, args, id = 'solver', callId = `call-${++seq}`) => {
    const definition = rt.teamTools.find(entry => entry.name === name)
    assert.ok(definition, `${name} is registered`)
    return definition.execute(args, { agent: agentOf(id), callId })
  }
  const execute = (name, args, id = 'solver', callId = `call-${++seq}`) =>
    ctx.listeners.get('tools/execute')[0]({ name, arguments: args, agent: agentOf(id), callId }, async () => 'ran')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const progress = (action, args = {}, id = 'solver') => tool('solver_progress', { action, ...args }, id)
  return { ctx, rt, home, agents, agentOf, event, person, takeInput, execute, tool, call, progress, botMessage, finish, close,
    identity: id => identity?.(id),
  }
}

async function setup(t, extra = {}, turn, configure) {
  const h = fixture(t, undefined, { configure })
  t.after(() => rmSync(h.home, { recursive: true, force: true, maxRetries: 5 }))
  await h.rt.load()
  h.rt.state.reviewGuardMigrated = true
  const put = (id, fields) => h.rt.state.bots[id] = {
    id, name: id, role: 'Helper', instructions: 'Fake.', shell: true, createdAt: 1, ...fields,
  }
  mkdirSync(join(h.home, 'workspace'))
  put('solver', { role: 'Solver', reviewerId: 'reviewer', workDir: join(h.home, 'workspace'), ...extra })
  put('reviewer', {})
  put('other', {})
  await h.rt.save({ required: true })
  if (turn !== undefined) h.event('solver', 'turn/start', { turn })
  h.person('Do the task.')
  return h
}

const requestOf = async h => /^Request: ([\w-]+)/.exec(await h.progress('status'))?.[1]
const plan = (h, request, checks = ['check-a', 'check-b'], commands = checks.map(check => ({ check, command: `fake ${check}` }))) =>
  h.progress('plan', { request, checks, commands })
async function runCheck(h, request, run, pass, check = 'check-a') {
  await h.progress('start', { request, run, checks: [check] })
  return h.progress('checks', { request, run, results: [{ check, pass }] })
}


const results = (check = 'check-a', pass = true) => [{ check, pass }]
async function checked(h, request, run, { check = 'check-a', command = `fake ${check}`, exitCode = 0, work } = {}) {
  await h.progress('start', { request, run, checks: [check] })
  const cwd = h.rt.botOf('solver').workDir
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command }, agent: h.agentOf('solver'), callId: run,
  }, async () => {
    work?.(cwd)
    return { isError: false, value: { kind: 'foreground', cwd, exitCode, signal: null, timedOut: false, aborted: false } }
  })
  return h.progress('checks', { request, run, results: results(check, exitCode === 0) })
}

async function reviewedPlan(h, checks, commands, { legacyPlan } = {}) {
  const request = await requestOf(h)
  const exchange = (kind, text = 'Verify the evidence.') => h.tool('message_bot', {
    to: 'reviewer', message: text, solver_review: kind, solver_request: request, reply_to: 'me',
  })
  const verdict = (exchangeId, model = refOf(reviewerModel)) => answerSender(h.rt, 'reviewer', {
    exchangeId, senderSessionId: 'solver',
  }, 'SHIP', undefined, undefined, model)
  const delivered = []
  h.rt.deliver = async message => { delivered.push(message); return true }
  assert.match(await plan(h, request, checks, legacyPlan ? undefined : commands), /^Recorded\./)
  if (legacyPlan) {
    // An older plan could already contain this raw command before registration checked its syntax.
    h.rt.botOf('solver').reviewTrack.solver.plan.commands = Object.fromEntries(commands.map(({ check, command }) => [check, command]))
  }
  await exchange('plan')
  verdict(delivered.at(-1).exchangeId)
  return { request, send: exchange, verdict, delivered }
}

const reviewShip = 'Verdict: SHIP\nEvidence verified.'
const noSolverRequest = 'There is no active Solver request in this chat.'

test('#2131 plan accepts mixed-case check IDs and stores them lowercase', async t => {
  const h = await setup(t)
  const command = 'node --test ./C2.test.mjs'
  const args = {
    action: 'plan', request: await requestOf(h), checks: ['C1-arquivos', 'C2'],
    commands: [{ check: 'C1-arquivos', command: 'git diff --check' }, { check: 'C2', command }],
  }
  const original = structuredClone(args)
  assert.match(await h.tool('solver_progress', args), /^Recorded\./)
  const { plan: agreed } = h.rt.botOf('solver').reviewTrack.solver
  assert.deepEqual(agreed.checks, ['c1-arquivos', 'c2'])
  assert.deepEqual(Object.keys(agreed.commands), ['c1-arquivos', 'c2'])
  assert.equal(agreed.commands.c2, command)
  assert.deepEqual(args, original)
})

test('#2131 start, checks and replays compare IDs without case', async t => {
  const h = await setup(t)
  const { request } = await reviewedPlan(h, ['C1'])
  assert.equal(await h.progress('start', { request, run: 'R1', checks: ['c1'] }),
    'Recorded. Run the check and report all its outcomes.')
  assert.equal(await h.progress('start', { request, run: 'r1', checks: ['C1'] }),
    'Recorded. This run is already open.')
  const first = await h.progress('checks', { request, run: 'R1', results: results('C1', false) })
  assert.match(first, /^Recorded\./)
  assert.ok(first.includes('"c1" has 3 fix attempts left in Normal.'))
  assert.equal(await h.progress('checks', { request, run: 'r1', results: results('c1', false) }),
    'Recorded. 2 re-plans left in Normal.')
  const { runs, attempts } = h.rt.botOf('solver').reviewTrack.solver
  assert.deepEqual(Object.keys(runs), ['r1'])
  assert.deepEqual(attempts, { c1: 1 })
})

test('#2131 case-only duplicates and malformed IDs stay refused', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  const format = 'An ID is 1 to 80 characters: letters, digits, "_", ".", ":" or "-", starting with a letter or digit; case does not matter.'
  for (const checks of [['C1', 'c1'], ['C 1'], ['-c1'], ['x'.repeat(81)], ['K1'], ['İd']]) {
    assert.equal(await plan(h, request, checks), `Register 1 to 20 distinct, stable check IDs. ${format}`, JSON.stringify(checks))
  }
  for (const run of ['R 1', 'K1']) {
    assert.equal(await h.progress('start', { request, run, checks: ['c1'] }), `Provide a stable run ID. ${format}`, run)
  }
})

test('#2131 the same plan in another case is the same plan', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  const command = 'fake c1'
  assert.match(await plan(h, request, ['C1'], [{ check: 'C1', command }]), /^Recorded\./)
  assert.match(await plan(h, request, ['c1'], [{ check: 'c1', command }]), /^Recorded\./)
})

test('#2131 verified-pass ownership replays without case', async t => {
  const h = await setup(t)
  const command = 'fake c1'
  const { request } = await reviewedPlan(h, ['C1'], [{ check: 'C1', command }])
  assert.match(await checked(h, request, 'P1', { check: 'C1', command }), /^Recorded\./)
  assert.match(await h.progress('checks', { request, run: 'p1', results: results('c1') }), /^Recorded\./)
})

test('#2131 replan replay counts once without case', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  const track = () => h.rt.botOf('solver').reviewTrack
  const before = track().solver.replans
  assert.equal(await h.progress('replan', { request, run: 'RP1' }), 'Recorded. 2 re-plans left in Normal.')
  assert.equal(await h.progress('replan', { request, run: 'rp1' }), 'Recorded. 1 re-plans left in Normal.')
  assert.equal(track().solver.replans, before + 1)
  assert.deepEqual(Object.keys(track().solver.replanRuns), ['rp1'])
})

const progressName = 'solver_progress'
const mcpNameOf = name => `mcp__dsh__${name}`
const wantedCopy = {
  start: 'the Solver needs to start a check run with solver_progress',
  pending: 'the Solver needs to finish recording its current progress with solver_progress',
}

async function watchSolver(t, home) {
  const path = socketPathOf(home)
  await until(() => existsSync(path), { label: 'the installed Pocket source socket' })
  const socket = createConnection(path)
  t.after(() => socket.destroy())
  const events = []
  createInterface({ input: socket }).on('line', line => events.push(JSON.parse(line)))
  socket.write('{"id":1,"method":"hello","params":{"write":1}}\n')
  await until(() => events.some(line => line.id === 1 && line.result?.write === 1))
  socket.write('{"id":2,"method":"subscribe","params":{"terminal":"dsh:solver","channel":1}}\n')
  await until(() => events.some(line => line.channel === 1 && line.event?.type === 'snapshot'))
  return events
}

async function bridgeFixture(t, { pocket = false, extra = {}, withPolicies = false, withTimeout = false, holdDesktopFor } = {}) {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  root.provide('systemPrompt', { tools() {}, section() {}, context() {}, getContextOrder() { return 0 } })
  root.provide('sessionProjections', {
    register: async () => ({ stateOf: () => ({ turnOpen: true }) }),
  })
  await root.plugin(ToolsService)
  await root.plugin(native)
  await root.plugin(ApprovalService, { policy: 'ask' })
  if (withTimeout) await root.plugin(timeoutPolicy)
  let scopeHost
  await root.plugin({ name: 'solver-bridge-actors', inject: ['tools'], apply(ctx) { scopeHost = ctx } })
  const agents = new Map()
  const policies = new Map()
  const configure = (ctx, agentOf) => {
    agents.set('solver', agentOf('solver'))
    ctx.provided.set('agents', { get: id => agents.get(id), list: () => [...agents.values()] })
    const get = ctx.get
    ctx.get = name => name === 'tools' ? root.get('tools') : get(name)
    ctx.provided.set('approval', root.approval)
    if (withPolicies) {
      const on = ctx.on
      const registrations = []
      policies.set(ctx, registrations)
      ctx.on = (name, listener, options) => {
        if (name === 'tools/pre-execute') registrations.push([listener, options])
        return on(name, listener, options)
      }
    }
    if (pocket) Object.assign(ctx.sessionController, {
      async *follow(_request, signal) {
        yield { type: 'snapshot', header: { id: 'solver', version: 4 }, cursor: 0, records: [],
          hasMore: false, projections: { asOfSeq: 0, values: {} } }
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
      async *observeState(_request, signal) {
        yield { cursor: 0, pendingInput: [], running: true }
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
      async events() { return { records: [] } },
      async state() { return { cursor: 0, pendingInput: [], running: true } },
      prompt() {}, cancel() {},
    })
  }
  const h = await setup(t, { reviewGuard: true, ...extra }, 2, configure)
  let current = h
  const desktop = []
  const team = []
  const audit = []
  const bodies = []
  const dispatchSignals = []
  if (withTimeout) root.on('tools/execute', (exec, next) => {
    dispatchSignals.push(exec.signal)
    return next()
  })
  let n = 0
  const agentFor = (id, header = {}) => {
    const agent = h.agentOf(id)
    if (!agent.ctx.tools.register) {
      const scope = createScope(scopeHost, agent)
      agent.ctx = scope.ctx
      agent.session.header = { ...agent.session.header, ...header }
      const events = [{ type: 'turn/start', data: { turn: 2 }, seq: 0 },
        { type: 'step/start', data: { turn: 2, step: 1 }, seq: 1 }]
      agent.session.snapshotEvents = (from, to) => events.slice(from, to)
      agent.session.append = (type, data) => {
        const event = { type, data, seq: events.length }
        events.push(event)
        current.event(id, type, data, event.seq)
        if (type.startsWith('approval/')) audit.push({ id, type, ...data })
        return event
      }
      agents.set(id, agent)
      h.rt.hideBotUnusedTools(agent)
    }
    return agent
  }
  const solver = agentFor('solver')
  root.on('approval/request', (request) => {
    desktop.push({ id: request.agent.session.id, name: request.toolName, callId: request.callId })
    if (request.toolName !== holdDesktopFor
      && (!request.toolName.endsWith(progressName) || request.reason === 'fixture person')) return 'allowed-once'
    return new Promise(resolve => request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))
  })
  let unmount
  const mountHooks = ({ ctx, rt }) => {
    const listeners = [rt.onApproval((kind, row) => {
      if (kind !== 'open') return
      team.push(row)
      // Group and child asks have no DSH card. The ordinary team answers still settle them.
      if (row.child || row.roomId) queueMicrotask(() => rt.answerApproval(row.id, 'allow'))
    })]
    for (const hook of ctx.listeners.get('approval/request')) listeners.push(root.on('approval/request', hook, { prepend: true }))
    for (const [hook, options] of policies.get(ctx) ?? []) listeners.push(root.on('tools/pre-execute', hook, options))
    for (const hook of ctx.listeners.get('tools/execute')) listeners.push(root.on('tools/execute', hook))
    listeners.push(root.on('tools/execute', (exec, next) => {
      bodies.push([exec.name, exec.callId])
      return next()
    }))
    unmount = () => listeners.forEach(stop => stop())
  }
  mountHooks(current)
  t.after(() => unmount())
  const reinstall = async () => {
    unmount()
    await current.close()
    current = fixture(t, h.home, { configure, agents: h.agents })
    await current.rt.load()
    mountHooks(current)
    return current.rt
  }
  const cwd = h.rt.botOf('solver').workDir
  const commandTool = defineTool({
    name: 'bash', description: 'Fixture foreground check',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => content('fixture exit 0') },
    execute: () => ({ kind: 'foreground', cwd, exitCode: 0, signal: null, timedOut: false, aborted: false }),
  })
  solver.ctx.tools.register(commandTool)

  const openCall = (name, args, options = {}) => {
    const agent = options.agent ?? solver
    const callId = options.callId ?? `bridge-${++n}`
    const abort = new AbortController()
    const raw = JSON.stringify(args)
    const record = options.record ?? name
    const position = { turn: 2, step: options.step ?? 1 }
    if (record) agent.session.append('tool/call', { ...position, callId, name: record, arguments: raw })
    options.beforeAsk?.(agent)
    const dispatch = async () => {
      const batch = await root.tools.execute({ calls: [{ id: callId, name, arguments: raw }], agent, signal: abort.signal })
      return batch.results[0].result
    }
    const execute = async () => {
      const result = await dispatch()
      agent.session.append('tool/result', { ...position, message: { toolCallId: callId, content: result.content } })
      return { result, text: result.content[0]?.text }
    }
    return { agent, callId, abort, dispatch, execute }
  }
  const start = (name, args, options = {}) => {
    const call = openCall(name, args, options)
    const request = {
      agent: call.agent, toolName: name, callId: call.callId, reason: options.reason ?? `Claude Code (fixture): ${name}`,
      bridgeCall: { agentAsked: options.agentAsked ?? false }, signal: call.abort.signal,
    }
    const approval = root.approval.request(request)
    const run = async () => {
      const outcome = await approval
      if (outcome !== 'allowed-once') return { outcome, refused: request.bridgeCall.refused?.reason }
      return { outcome, ...await call.execute() }
    }
    return { ...call, approval, run }
  }
  const attempt = async (name, args, options) => {
    const pending = start(name, args, options)
    await immediate()
    if (desktop.some(row => row.callId === pending.callId) && name.endsWith(progressName)
      && options?.reason !== 'fixture person') {
      pending.abort.abort()
    }
    return pending.run()
  }
  const phone = pocket ? await watchSolver(t, h.home) : []
  const cardCounts = () => {
    const byTool = names => names.reduce((out, name) => ({ ...out, [name]: (out[name] ?? 0) + 1 }), {})
    return {
      desktop: byTool(desktop.map(row => row.name)),
      team: byTool(team.map(row => row.tool)),
      pocket: byTool(phone.filter(line => line.event?.type === 'approval' && line.event.row.open).map(line => line.event.row.tool)),
    }
  }
  const alias = name => {
    const layer = root.tools.layers.peek(solver).tools
    t.after(layer.insert(mcpNameOf(name), layer.get(name)))
  }
  return { ...h, root, agentFor, solver, openCall, start, attempt, desktop, team, audit, bodies,
    dispatchSignals, cardCounts, alias, reinstall }
}

for (const prefixed of [false, true]) test(`T1 Claude Code bridge Solver reaches Done with no ${prefixed ? 'prefixed' : 'bare'} progress card`, async t => {
  const h = await bridgeFixture(t, { pocket: true })
  // ACP exposes the prefix and normally sends the bare name to the host.
  // The literal-prefix fixture only admits an alias to the same registration.
  if (prefixed) for (const name of [progressName, 'message_bot', 'bash']) h.alias(name)
  const nameOf = prefixed ? mcpNameOf : name => name
  t.after(() => t.diagnostic(JSON.stringify(h.cardCounts())))
  const progress = async (action, args) => {
    const call = await h.attempt(nameOf(progressName), { action, ...args })
    assert.equal(call.outcome, 'allowed-once', action)
    assert.equal(call.result.isError, false)
    return call.text
  }
  const request = /^Request: ([\w-]+)/.exec(await progress('status'))?.[1]
  assert.ok(request)
  const commands = ['check-a', 'check-b'].map(check => ({ check, command: `fake ${check}` }))
  assert.match(await progress('plan', { request, checks: commands.map(({ check }) => check), commands }), /^Recorded\./)
  const deliveries = []
  const deliver = h.rt.deliver
  h.rt.deliver = (message, options) => {
    const sent = deliver(message, options)
    deliveries.push({ message, sent })
    return sent
  }
  const track = () => h.rt.botOf('solver').reviewTrack
  const review = async (kind, turn) => {
    const call = await h.attempt(nameOf('message_bot'), {
      to: 'reviewer', message: `Review the ${kind}.`, solver_review: kind, solver_request: request, reply_to: 'me',
    })
    assert.equal(call.outcome, 'allowed-once')
    assert.equal(call.result.isError, false)
    const input = h.agentOf('reviewer').message
    const exchangeId = deliveries.at(-1).message.exchangeId
    assert.equal(input.source.exchangeId, exchangeId)
    h.takeInput('reviewer', input)
    h.finish('solver', `Waiting for ${kind} review.`)
    answerSender(h.rt, 'reviewer', { exchangeId, senderSessionId: 'solver' },
      reviewShip, undefined, undefined, refOf(reviewerModel))
    const reply = deliveries.at(-1)
    assert.equal(await reply.sent, reply.message.exchangeId)
    assert.equal(h.agentOf('solver').message.source.exchangeId, reply.message.exchangeId)
    h.event('solver', 'turn/start', { turn })
    h.takeInput('solver', h.agentOf('solver').message)
    return exchangeId
  }
  await review('plan', 3)
  assert.equal(track().solver.plan.accepted, true)
  assert.equal(track().solver.plan.review.verdict, 'SHIP')
  for (const { check, command } of commands) {
    assert.match(await progress('start', { request, run: check, checks: [check] }), /^Recorded\./)
    const shell = await h.attempt(nameOf('bash'), { command })
    assert.equal(shell.outcome, 'allowed-once', 'the fake person answered the shell card')
    assert.equal(shell.result.value?.kind, 'foreground')
    assert.equal(shell.result.value.exitCode, 0)
    assert.match(await progress('checks', { request, run: check, results: results(check) }), /^Recorded\./)
    assert.deepEqual(JSON.parse(track().solver.runs[check].reported), results(check))
    assert.equal(track().solver.passRuns[check], check)
  }
  const result = await review('result', 4)
  assert.equal(track().solver.review.verdict, 'SHIP')
  h.finish('solver', 'Both checks passed and the reviewer shipped the result.')
  assert.equal(track().last?.resultExchangeId, result)
  assert.equal(track().last?.done, true)
  assert.equal(track().delivered, true)
  assert.deepEqual(h.rt.stopsView(), [])
  const ordinary = { [nameOf('message_bot')]: 2, [nameOf('bash')]: 2 }
  await until(() => h.cardCounts().pocket[nameOf('bash')] === 2)
  assert.deepEqual(h.cardCounts(), { desktop: ordinary, team: ordinary, pocket: ordinary })
  const asked = h.audit.filter(event => event.type === 'approval/asked')
  assert.deepEqual(h.bodies, asked.map(event => [event.toolName, event.callId]))
  assert.equal(h.audit.filter(event => event.type === 'approval/decided' && event.outcome === 'allowed-once').length, asked.length)
})

test('T2 only the direct current Solver gets the exact scoped registration answer', async t => {
  const h = await bridgeFixture(t)
  const args = { action: 'status' }
  const name = mcpNameOf(progressName)
  h.alias(progressName)
  const prefixed = await h.attempt(name, args)
  const bot = h.rt.botOf('solver')
  bot.reviewGuard = false
  const bare = await h.attempt(progressName, args)
  bot.reviewGuard = true
  const track = bot.reviewTrack
  delete bot.reviewTrack
  const guardOnly = await h.attempt(progressName, args)
  bot.reviewTrack = track
  bot.sessionId = 'solver-part-2'
  h.rt.state.tasks = { 'task-run': { status: 'working', title: 'Task', from: bot.id } }
  await h.rt.save({ required: true })
  h.rt.groupOwners.set('group-chat', { botId: bot.id, roomId: 'room' })
  const current = h.agentFor(bot.sessionId)
  const rotated = await h.attempt(progressName, args, { agent: current })
  const rolesOnly = h.rt.botOf('reviewer')
  rolesOnly.role = 'Solver'
  rolesOnly.solverAuto = true
  for (const [agent, expected] of [
    [h.agentFor('child', { origin: 'subagent', parentSession: bot.sessionId }), 'team'],
    [h.solver, 'desktop'],
    [h.agentFor('group-chat'), 'team'],
    [h.agentFor('task-run'), 'team-and-desktop'],
    [h.agentFor('other'), 'team-and-desktop'],
    [h.agentFor(rolesOnly.id), 'team-and-desktop'],
  ]) {
    const call = h.start(progressName, args, { agent })
    await immediate()
    const team = [...h.team, ...h.rt.approvalsView()]
    assert.equal(team.some(row => row.callId === call.callId), expected !== 'desktop', agent.id)
    assert.equal(h.desktop.some(row => row.callId === call.callId), expected !== 'team', agent.id)
    call.abort.abort()
    await call.approval
  }
  t.diagnostic(JSON.stringify(h.cardCounts()))
  for (const call of [bare, prefixed, rotated]) {
    assert.equal(call.outcome, 'allowed-once')
    assert.match(call.text, /^Request: /)
  }
  assert.equal(guardOnly.outcome, 'allowed-once')
  assert.equal(guardOnly.text, noSolverRequest)
})

test('H5 and AC-6 use the ordinary card when the registration or call proof is missing or changes', async t => {
  const h = await bridgeFixture(t)
  const args = { action: 'status' }
  async function ordinary(options) {
    const call = h.start(progressName, args, options)
    await immediate()
    assert.ok(h.desktop.some(row => row.callId === call.callId))
    assert.ok(h.team.some(row => row.callId === call.callId))
    call.abort.abort()
    assert.equal(await call.approval, 'cancelled')
  }
  await ordinary({ record: false })
  await ordinary({ record: 'list_bots' })
  await ordinary({ agent: { ...h.solver, session: { ...h.solver.session } } })
  const botOfSession = h.rt.botOfSession
  h.rt.botOfSession = () => { throw new Error('fixture owner failed') }
  await ordinary()
  h.rt.botOfSession = botOfSession
  const tools = h.root.tools.layers.peek(h.solver).tools
  const actual = tools.get(progressName)
  const entries = tools.data
  try {
    // A second registration of the same definition is still untrusted.
    entries.set(progressName, { ...actual })
    await ordinary()
    entries.set(progressName, actual)
    await ordinary({ beforeAsk: () => entries.set(progressName, { ...actual }) })
    entries.set(progressName, actual)
  } finally {
    entries.set(progressName, actual)
  }
  assert.deepEqual(h.bodies, [])
})

test('AC-6 a replacement after the host answer still needs ordinary approval', async t => {
  const h = await bridgeFixture(t)
  const call = h.start(progressName, { action: 'status' })
  await immediate()
  if (h.desktop.some(row => row.callId === call.callId)) {
    // The parent already awaits the person, so dispatch cannot have started.
    call.abort.abort()
    assert.equal(await call.approval, 'cancelled')
    assert.deepEqual(h.bodies, [])
    return
  }
  assert.equal(await call.approval, 'allowed-once')
  const entries = h.root.tools.layers.peek(h.solver).tools.data
  const actual = entries.get(progressName)
  let executions = 0
  entries.set(progressName, { ...actual, definition: {
    ...actual.definition, execute() { executions += 1; return 'replacement ran' },
  } })
  const run = call.run()
  try {
    await until(() => h.desktop.some(row => row.callId === call.callId))
    assert.equal(executions, 0, 'the old answer cannot release a different registration')
    const row = h.rt.approvalsView().find(row => row.callId === call.callId)
    assert.ok(row)
    h.rt.answerApproval(row.id, 'reject')
    assert.match((await run).text, /did not receive approval/)
    assert.equal(executions, 0)
    assert.equal(h.audit.filter(event => event.type === 'approval/asked' && event.callId === call.callId).length, 2)
  } finally {
    call.abort.abort()
    entries.set(progressName, actual)
    await run
  }
})

test('Round 2 AC-7 a CLI referral leaves the progress decision to the person', async t => {
  const h = await bridgeFixture(t, { pocket: true })
  const routine = await h.attempt(progressName, { action: 'status' })
  assert.equal(routine.outcome, 'allowed-once')
  assert.equal(routine.result.isError, false)
  assert.deepEqual(h.cardCounts(), { desktop: {}, team: {}, pocket: {} })
  const referred = h.start(progressName, { action: 'status' }, { agentAsked: true })
  t.after(() => referred.abort.abort())
  await immediate()
  const row = h.rt.approvalsView().find(row => row.callId === referred.callId)
  assert.ok(row, 'the CLI referral opened a person card')
  await until(() => h.cardCounts().pocket[progressName] === 1)
  assert.equal(h.cardCounts().desktop[progressName], 1)
  h.rt.answerApproval(row.id, 'reject')
  assert.equal((await referred.run()).outcome, 'rejected')
  assert.deepEqual(h.bodies, [[progressName, h.audit[0].callId]])
})

test('Round 2 AC-7 an executor policy referral lets the person decline progress', async t => {
  const h = await bridgeFixture(t)
  const referred = h.openCall(progressName, { action: 'status' })
  t.after(() => referred.abort.abort())
  h.root.on('tools/pre-execute', (exec, next) => exec.callId === referred.callId
    ? { kind: 'ask', reason: 'Auto review denied tool "solver_progress": fixture referral' }
    : next())
  const run = referred.execute()
  await immediate()
  const row = h.rt.approvalsView().find(row => row.callId === referred.callId)
  assert.ok(row, 'the native executor request opened a person card')
  h.rt.answerApproval(row.id, 'reject')
  assert.equal((await run).result.error.info.code, 'APPROVAL_REJECTED')
  assert.deepEqual(h.bodies, [])
})

test('Round 2 AC-7 the routine bridge answer does not satisfy the independent hard-step check', async t => {
  const h = await bridgeFixture(t, { withPolicies: true })
  const call = h.start(progressName, { action: 'status' })
  t.after(() => call.abort.abort())
  assert.equal(await call.approval, 'allowed-once')
  assert.deepEqual(h.team, [])
  // Exercise the ladder's real extension seam after the routine approval.
  t.after(h.rt.stepHooks.sendsOutside(step => step.tool === progressName))
  const run = call.run()
  await immediate()
  const row = h.rt.approvalsView().find(row => row.callId === call.callId)
  assert.match(row?.reason ?? '', /hard to undo/)
  h.rt.answerApproval(row.id, 'reject')
  assert.equal((await run).result.error.info.code, 'APPROVAL_REJECTED')
  assert.deepEqual(h.bodies, [])
})

for (const closesBy of ['result', 'step']) {
  test(`Round 2 AC-6 a ${closesBy} retires the evidence for its progress call`, async t => {
    const h = await bridgeFixture(t)
    const closed = h.start(progressName, { action: 'status' }, {
      callId: 'closed',
      beforeAsk(agent) {
        const position = { turn: 2, step: 1 }
        if (closesBy === 'result') {
          agent.session.append('tool/result', { ...position, message: { toolCallId: 'closed', content: content('complete') } })
        } else {
          agent.session.append('step/end', position)
          agent.session.append('step/start', { turn: 2, step: 2 })
        }
      },
    })
    t.after(() => closed.abort.abort())
    await immediate()
    const row = h.rt.approvalsView().find(row => row.callId === closed.callId)
    assert.ok(row, 'the closed call cannot prove entitlement to a host answer')
    h.rt.answerApproval(row.id, 'reject')
    assert.equal((await closed.run()).outcome, 'rejected')
    const live = await h.attempt(progressName, { action: 'status' }, { step: closesBy === 'result' ? 1 : 2 })
    assert.equal(live.outcome, 'allowed-once')
    assert.match(live.text, /^Request: /)
    assert.equal(h.desktop.length, 1)
    assert.equal(h.bodies.length, 1)
  })

  test(`Round 2 AC-6 a ${closesBy} blocks delayed dispatch without affecting the next live call`, async t => {
    const h = await bridgeFixture(t)
    const args = { action: 'status' }
    const closed = h.start(progressName, args)
    t.after(() => closed.abort.abort())
    assert.equal(await closed.approval, 'allowed-once')
    const position = { turn: 2, step: 1 }
    if (closesBy === 'result') {
      h.solver.session.append('tool/result', { ...position, message: {
        toolCallId: closed.callId, content: content('closed'), isError: true,
      } })
    } else {
      h.solver.session.append('step/end', position)
      h.solver.session.append('step/start', { turn: 2, step: 2 })
    }
    const live = h.start(progressName, args, { step: closesBy === 'result' ? 1 : 2 })
    t.after(() => live.abort.abort())
    assert.equal(await live.approval, 'allowed-once')
    assert.equal((await closed.dispatch()).isError, true)
    assert.deepEqual(h.bodies, [])
    assert.match((await live.run()).text, /^Request: /)
    assert.deepEqual(h.bodies, [[progressName, live.callId]])
    assert.deepEqual(h.desktop, [])
  })
}

test('AC-6 a different tool can run after ordinary Allow with a closed progress call ID', async t => {
  const name = 'read'
  const marker = scopedReadMarker(t)
  const h = await bridgeFixture(t, { holdDesktopFor: name, extra: { workDir: dirname(marker) } })
  let executions = 0
  h.solver.ctx.tools.register(defineTool({
    name, description: 'Fixture read', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => content(value) },
    execute() {
      executions += 1
      return 'fixture read ran'
    },
  }))

  const closed = h.start(progressName, { action: 'status' })
  t.after(() => closed.abort.abort())
  assert.equal(await closed.approval, 'allowed-once')
  assert.deepEqual(h.desktop, [])
  h.solver.session.append('tool/result', { turn: 2, step: 1, message: {
    toolCallId: closed.callId, content: content('closed'), isError: true,
  } })

  const read = h.start(name, { file_path: marker }, { callId: closed.callId })
  t.after(() => read.abort.abort())
  await immediate()
  assert.deepEqual(h.desktop, [{ id: h.solver.id, name, callId: closed.callId }])
  const row = h.rt.approvalsView().find(row => row.callId === closed.callId && row.tool === name)
  assert.ok(row, 'the reused ID opened an ordinary person card for the other tool')
  assert.equal(executions, 0)
  h.rt.answerApproval(row.id, 'allow')
  const result = await read.run()
  assert.equal(result.outcome, 'allowed-once')
  assert.equal(executions, 1, result.text)
  assert.equal(result.result.isError, false)
  assert.equal(result.text, 'fixture read ran')
})

for (const { change, pick } of [
  { change: 'timeout', pick: 'reject' },
  { change: 'reinstall', pick: 'reject' },
  { change: 'reinstall with replacement', pick: 'reject' },
  { change: 'registration', pick: 'allow' },
  { change: 'registration', pick: 'reject' },
]) {
  test(`Round 2 AC-6 ${change} requires a fresh decision and ${pick} controls the replacement body`, async t => {
    const h = await bridgeFixture(t, { withTimeout: change === 'timeout' })
    const call = h.start(progressName, { action: 'status' })
    t.after(() => call.abort.abort())
    assert.equal(await call.approval, 'allowed-once')
    const rt = change.startsWith('reinstall') ? await h.reinstall() : h.rt
    const entries = h.root.tools.layers.peek(h.solver).tools.data
    const actual = entries.get(progressName)
    let executions = 0
    if (change !== 'reinstall') {
      entries.set(progressName, { ...actual, definition: {
        ...actual.definition, ...(change === 'timeout' ? { timeoutMs: 8000 } : {}),
        execute() { executions += 1; return 'replacement ran' },
      } })
      t.after(() => entries.set(progressName, actual))
    }
    const run = call.run()
    await immediate()
    const row = rt.approvalsView().find(row => row.callId === call.callId)
    if (change === 'timeout') {
      assert.equal(h.dispatchSignals.length, 1)
      assert.notEqual(h.dispatchSignals[0], call.abort.signal, 'the pinned timeout policy derived a signal')
    }
    assert.ok(row, 'the old host answer cannot release the replacement')
    assert.equal(executions, 0)
    rt.answerApproval(row.id, pick)
    const result = await run
    assert.equal(executions, pick === 'allow' ? 1 : 0)
    assert.equal(h.bodies.length, pick === 'allow' ? 1 : 0)
    assert.equal(result.result.isError, pick === 'reject')
    assert.equal(h.audit.filter(event => event.type === 'approval/asked' && event.callId === call.callId).length, 2)
  })
}

test('H3 the registered Auto action still requires the exact words from the person', async t => {
  const h = await bridgeFixture(t)
  const request = h.rt.botOf('solver').reviewTrack.solver.request
  const auto = async (request, quote) => (await h.attempt(progressName,
    { action: 'auto', request, quote }, { reason: 'fixture person' })).text
  assert.match(await auto(request, 'Turn Auto on.'), /needs the person's own words/)
  h.person('Work alone until delivered.')
  assert.match(await auto('wrong-request', 'Work alone until delivered.'), /active request ID/)
  assert.match(await auto(request, 'Turn Auto on.'), /needs the person's own words/)
  assert.match(await auto(request, 'Work alone until delivered.'), /Auto is on/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.auto, true)
  h.finish('solver', 'Delivered.')
  await h.botMessage()
  const botRequest = h.rt.botOf('solver').reviewTrack.solver.request
  assert.match(await auto(botRequest, 'Work alone until delivered.'), /Only the person can turn Auto on/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.auto, undefined)
})

test('H2 and H4 accepted plan still refuses an agreed check until start executes', async t => {
  const h = await bridgeFixture(t, { pocket: true })
  const { request } = await reviewedPlan(h, ['check-a'])
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan.accepted, true)
  const start = h.start(progressName, { action: 'start', request, run: 'check-a', checks: ['check-a'] })
  let startOutcome
  void start.approval.then(outcome => { startOutcome = outcome })
  try {
    await immediate()
    const call = await h.attempt('bash', { command: 'fake check-a' })
    assert.equal(call.outcome, 'rejected')
    assert.match(call.refused, /Start a check run with solver_progress/)
    assert.deepEqual(h.bodies, [], 'start and the agreed command have not executed')
    await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /Start a check run/)
    for (const [name, args] of [['write', { file_path: 'out' }], ['bash', { command: 'git status' }]]) {
      const ordinary = await h.attempt(name, args)
      assert.equal(ordinary.outcome, 'allowed-once')
      assert.ok(h.desktop.some(row => row.name === name))
      assert.ok(h.team.some(row => row.tool === name))
    }
    await until(() => h.cardCounts().pocket.bash === 1)
    t.diagnostic(JSON.stringify({ plan: 'SHIP', start: startOutcome ?? 'unanswered',
      agreedCheck: call.outcome, refusal: call.refused, cards: h.cardCounts() }))
  } finally {
    start.abort.abort()
    await start.approval
  }
})

test('T4 the installed Pocket listener opens ordinary cards, with Solver progress ahead of Workspace Auto', async t => {
  const route = { provider: 'acp-claude', model: 'default' }
  const h = await bridgeFixture(t, { pocket: true })
  h.solver.session.requestHeader = () => ({ config: route })
  h.ctx.provided.set('permissionPresets', {
    current: () => 'workspace-write', resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
  })
  h.ctx.acpAgents.ownModeIn = () => true
  h.ctx.acpAgents.ownModeOf = () => ({ mode: 'agent', answerer: true })
  const bot = h.rt.botOf('solver')
  Object.assign(bot, { permission: 'workspace-write', permissionAuto: 'acp-claude', model: 'acp-claude/default' })
  assert.equal(h.rt.autoWhy(bot, { sessionId: h.solver.id, session: h.solver.session, route: bot.model }), undefined)
  assert.equal(h.rt.autoCounts(h.solver.session), true)
  h.rt.backgroundModel = async () => 'fake/judge'
  h.ctx.llm = {
    resolveModelInfo: async () => ({}),
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '{"decision":"ask","reason":"the person should decide"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const decide = t.mock.method(h.rt, 'autoDecide')
  const guard = t.mock.method(h.rt, 'reviewGuardAsk')
  const auto = await h.attempt(progressName, { action: 'auto', request: h.rt.botOf('solver').reviewTrack.solver.request,
    quote: 'Turn Auto on.' })
  const lookup = await h.attempt('list_bots', {})
  assert.equal(lookup.outcome, 'allowed-once')
  await reviewedPlan(h, ['check-a'])
  const shell = await h.attempt('bash', { command: 'git status' })
  assert.equal(shell.outcome, 'allowed-once')
  assert.equal(shell.result.value.exitCode, 0)
  await until(() => h.cardCounts().pocket.bash === 1)
  const attempted = decide.mock.calls.map(call => call.arguments[0].toolName)
  assert.deepEqual(guard.mock.calls.map(call => call.arguments[0].toolName), [progressName, 'list_bots', 'bash'])
  t.diagnostic(JSON.stringify({ cards: h.cardCounts(), judge: attempted }))
  assert.deepEqual(attempted, ['bash'])
  assert.deepEqual(h.rt.autoAuditRows().map(({ tool, decision }) => [tool, decision]), [['bash', 'ask']])
  const ordinary = { bash: 1 }
  assert.deepEqual(h.cardCounts(), { desktop: ordinary, team: ordinary, pocket: ordinary })
  assert.equal(auto.outcome, 'allowed-once')
  assert.match(auto.text, /needs the person's own words/)
})

async function reviewReplyFixture(t, averageCommand = 'node --test average.test.mjs', ids = ['average-test', 'diff-check']) {
  const h = await setup(t, { reviewGuard: true }, 2)
  const request = await requestOf(h)
  assert.ok(request, 'turn 2 has an active request')
  assert.match(await plan(h, request, ids, [
    { check: ids[0], command: averageCommand },
    { check: ids[1], command: 'git diff --check' },
  ]), /^Recorded\./)
  const deliver = h.rt.deliver
  const deliveries = []
  h.rt.deliver = (message, options) => {
    const sent = deliver(message, options)
    deliveries.push({ message, sent })
    return sent
  }
  const review = async (kind, images) => {
    await h.tool('message_bot', { to: 'reviewer', message: `Review the ${kind}.`,
      solver_review: kind, solver_request: request, reply_to: 'me', ...(images ? { images } : {}) })
    return deliveries.at(-1).message.exchangeId
  }
  const answer = (exchangeId, shouldSend, model = refOf(reviewerModel)) => {
    const input = h.agentOf('reviewer').message
    assert.equal(input.source.exchangeId, exchangeId)
    h.takeInput('reviewer', input)
    answerSender(h.rt, 'reviewer', { exchangeId, senderSessionId: 'solver' },
      reviewShip, undefined, shouldSend, model)
    return deliveries.at(-1)
  }
  const track = () => h.rt.botOf('solver').reviewTrack
  const openReply = async (turn, { message, sent }) => {
    assert.equal(await sent, message.exchangeId)
    const input = h.agentOf('solver').message
    assert.equal(input.source.exchangeId, message.exchangeId)
    h.event('solver', 'turn/start', { turn })
    h.takeInput('solver', input)
  }
  return { h, request, review, answer, track, openReply, deliveries }
}

for (const timing of ['before', 'after']) {
  test(`Stage 6 review reply PLAN answers ${timing} the waiting turn ends`, async t => {
    const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
    const exchange = await review('plan')
    let reply
    if (timing === 'before') reply = answer(exchange)
    assert.equal(await requestOf(h), request)
    h.finish('solver', 'The plan is with the designated reviewer. I am waiting for its verdict.')
    const { delivered, last } = track()
    if (timing === 'after') reply = answer(exchange)
    await openReply(3, reply)
    const start = await h.progress('start', { request, run: 'run-1', checks: ['average-test'] })
    const status = await h.progress('status')
    t.diagnostic(`turn 2 delivered=${delivered === true} mark=${JSON.stringify(last ?? null)}; turn 3 start=${start}; status=${status.split('\n')[0]}`)
    assert.match(start, /^Recorded\./, 'the next turn can start a check for the same request')
    assert.equal(status.split('\n')[0], `Request: ${request}`)
    assert.notEqual(delivered, true, 'the waiting turn did not deliver')
  })
}

for (const release of ['consumption', 'abandonment', 'delivery failure', 'discard', 'input failure']) {
  test(`Stage 6 review reply RESULT waits for ${release}`, async t => {
    const native = release === 'consumption'
    const averageCommand = native ? stage6CommandIn(checkDirectory(t)) : 'node --test average.test.mjs'
    const { h, request, review, answer, track, openReply, deliveries } = await reviewReplyFixture(t, averageCommand)
    const planExchange = await review('plan')
    const earlyPlan = release === 'consumption' ? answer(planExchange) : undefined
    h.finish('solver', 'Waiting for plan review.')
    await openReply(3, earlyPlan ?? answer(planExchange))
    const oldReply = h.agentOf('solver').message
    const checks = [
      { run: 'test', check: 'average-test', command: averageCommand },
      { run: 'diff', check: 'diff-check', command: 'git diff --check' },
    ]
    if (native) {
      const { mirror } = await nativeMirror(t, h)
      for (const { run, check, command } of checks) {
        assert.match(await h.progress('start', { request, run, checks: [check] }), /^Recorded\./)
        assert.equal((await mirror(run, { command: `/bin/bash -lc '${command}'` })).isError, false)
        assert.match(await h.progress('checks', { request, run, results: results(check) }), /^Recorded\./)
      }
    } else {
      for (const { run, check, command } of checks) {
        assert.match(await checked(h, request, run, { check, command }), /^Recorded\./)
      }
    }
    const exchange = await review('result')
    const solver = h.agentOf('solver')
    if (release === 'delivery failure') {
      const followup = solver.followup
      let failed = false
      t.mock.method(solver, 'followup', message => {
        if (message.source.replyTo === exchange && !failed) {
          failed = true
          throw new Error('Fixture reply delivery failed')
        }
        followup.call(solver, message)
      })
    }
    const reply = answer(exchange, release === 'abandonment' ? () => false : undefined)
    h.finish('solver', 'Waiting for result review.')
    assert.notEqual(track().delivered, true, 'the waiting turn did not deliver')
    if (release === 'consumption') {
      assert.equal(await reply.sent, reply.message.exchangeId)
      h.event('solver', 'turn/start', { turn: 4 })
      const input = solver.message
      const forged = { ...input, source: { ...input.source, reviewReceipt: 'forged' } }
      h.ctx.emit('agent/inbox/discarded', { agent: solver, message: forged })
      h.rt.wakeLog.quiet(() => h.ctx.emit('agent/inbox/discarded', { agent: solver, message: input }))
      // Even a copied source and message ID require the actual inbox claim.
      h.event('solver', 'user/message', structuredClone(input))
      h.takeInput('solver', forged)
      h.takeInput('solver', oldReply)
      h.finish('solver', 'The genuine reply is still in the inbox.')
      assert.notEqual(track().delivered, true, 'forged inputs, older exchanges and an inbox move keep the hold')
      const unrelated = await h.rt.deliver({ fromId: 'other', toId: 'solver', role: 'reply',
        replyTo: 'other-work', text: 'A reply for different work.' })
      assert.equal(solver.message.source.exchangeId, unrelated)
      h.event('solver', 'turn/start', { turn: 5 })
      h.takeInput('solver', solver.message)
      h.takeInput('solver', input)
    } else if (release === 'delivery failure') {
      await assert.rejects(reply.sent, /Fixture reply delivery failed/)
      const failureNotice = deliveries.at(-1)
      assert.notEqual(failureNotice.message.exchangeId, reply.message.exchangeId)
      await failureNotice.sent
      assert.match(solver.message.content[0].text, /could not send its reply/)
      h.event('solver', 'turn/start', { turn: 4 })
      h.takeInput('solver', solver.message)
    } else {
      if (release === 'abandonment') {
        assert.equal(await reply.sent, undefined)
      } else {
        assert.equal(await reply.sent, reply.message.exchangeId)
        if (release === 'discard') h.ctx.emit('agent/inbox/discarded', { agent: solver, message: solver.message })
        else {
          h.event('solver', 'turn/start', { turn: 4 })
          h.ctx.emit('agent/inbox/claimed', { agent: solver, message: solver.message })
          h.event('solver', 'turn/end', { reason: { kind: 'error', error: { code: 'UNKNOWN' } } })
        }
      }
    }
    assert.equal(await requestOf(h), request)
    if (release === 'consumption' || release === 'delivery failure') {
      h.finish('solver', 'Both reviews approved and both checks passed.')
    } else {
      // Test terminal release on the same request, without a new person message overriding the hold.
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
    }
    const mark = track().last
    assert.equal(track().delivered, true)
    assert.equal(mark.done, true)
    assert.equal(mark.resultExchangeId, exchange)
    assert.equal(mark.reviewer.model, refOf(reviewerModel))
    h.event('solver', 'turn/start', { turn: 6 })
    h.finish('solver', 'Already delivered.')
    assert.deepEqual(track().last, mark)
    assert.equal(await h.progress('status'), noSolverRequest)
  })
}

test('Stage 6 review reply preserves person interruption and request replacement', async t => {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const exchange = await review('plan')
  const time = t.mock.method(Date, 'now', () => h.rt.state.works[exchange].at + 1)
  h.person('Deliver now, please.')
  time.mock.restore()
  const reply = answer(exchange)
  h.finish('solver', 'Delivered at the person’s request.')
  assert.equal(track().delivered, true)

  h.event('solver', 'turn/start', { turn: 3 })
  h.person('This is a new request.')
  await h.rt.live.get('solver')?.solverRequest
  const replacement = await requestOf(h)
  assert.ok(replacement && replacement !== request)
  h.event('solver', 'turn/end', { reason: { kind: 'completed' } })
  await openReply(4, reply)
  h.finish('solver', 'Finished reading the earlier review.')
  assert.equal(await requestOf(h), replacement)
  assert.notEqual(track().delivered, true)
})

test('Rebase R2 preserves a matching verdict and the durable progress write at commit', async t => {
  const { h, request, review, answer, track } = await reviewReplyFixture(t)
  const exchange = await review('plan')
  h.person('Work alone until delivered.')
  const atCommit = Promise.withResolvers()
  const release = Promise.withResolvers()
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = (change, options) => saveCopy(change, {
    ...options, beforeCommit: async () => {
      atCommit.resolve()
      await release.promise
      return options.beforeCommit()
    },
  })
  const write = h.progress('auto', { request, quote: 'Work alone until delivered.' })
  await atCommit.promise
  const reply = answer(exchange)
  release.resolve()
  assert.match(await write, /^Recorded\./)
  h.finish('solver', 'Waiting for plan review.')
  await reply.sent
  await h.rt.save({ required: true, durable: true })
  assert.equal(track().solver.plan.accepted, true)
  assert.equal(track().solver.auto, true)
  const saved = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack
  assert.equal(saved.solver.plan.review.verdict, 'SHIP')
  assert.equal(saved.solver.auto, true)
})

test('Rebase R2 holds delivery during reply note adoption and releases a pre-inbox rejection', async t => {
  for (const accepted of [true, false]) await t.test(accepted ? 'claimed reply' : 'definite rejection', async t => {
    const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
    const exchange = await review('plan')
    let adoptedNotes = false
    const adopted = h.rt.reloadDeliveryNotes(() => { adoptedNotes = true })
    const reply = answer(exchange, () => accepted)
    assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
    h.finish('solver', 'Waiting for plan review.')
    const before = track().last
    assert.equal(adoptedNotes, false)
    await adopted
    assert.equal(adoptedNotes, true)
    assert.equal(before, undefined, 'the waiting turn must not deliver during adoption')
    if (accepted) {
      await openReply(3, reply)
      h.finish('solver', 'Delivered after reading the PLAN.')
    } else {
      assert.equal(await reply.sent, undefined)
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, request })
    }
    const mark = track().last
    assert.ok(mark)
    assert.equal(track().delivered, true)
    h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, request })
    assert.equal(track().last, mark)
  })
})

test('Stage 6 review reply stays pending in the delivery notes across restart', async t => {
  const { h, request, review, answer, track } = await reviewReplyFixture(t)
  const exchange = await review('plan')
  const reply = answer(exchange)
  h.finish('solver', 'Waiting for plan review.')
  assert.notEqual(track().delivered, true)
  assert.equal(await reply.sent, reply.message.exchangeId)
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const boundEnd = () => next.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
  boundEnd()
  assert.equal(await requestOf(next), request)
  // The boot replay timer is unref'ed by the plugin. Keep the fake test alive until it finishes.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual((await next.rt.resumesDone).resent, ['solver'])
  } finally {
    clearInterval(keepAlive)
  }
  const input = next.agentOf('solver').message
  assert.equal(input.source.exchangeId, reply.message.exchangeId)
  next.event('solver', 'turn/start', { turn: 3 })
  next.takeInput('solver', input)
  next.finish('solver', 'Delivered after reading the saved review reply.')
  assert.equal(await next.progress('status'), noSolverRequest)
})

test('Stage 6 round 2 keeps a review reply through an ordinary inbox move and releases a withdrawal', async t => {
  const { h, request, review, answer, track } = await reviewReplyFixture(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const { inbox } = await loop.create('solver')
  const solver = h.agentOf('solver')
  for (const event of ['agent/inbox/inserted', 'agent/inbox/discarded']) {
    ctx.on(event, ({ message }) => h.ctx.emit(event, { agent: solver, message }))
  }
  solver.inbox = inbox
  solver.followup = message => inbox.append('next-turn', message)

  const reply = answer(await review('plan'))
  h.finish('solver', 'Waiting for plan review.')
  await reply.sent
  const [original] = inbox.nextTurn
  assert.equal(original.source.exchangeId, reply.message.exchangeId)
  assert.equal(inbox.remove(original.id), true)
  inbox.append('next-step', original)
  const edited = { ...original, id: `${original.id}-edited` }
  assert.equal(inbox.replace(original.id, edited), true)
  await immediate()
  const closeRequest = () => h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
  closeRequest()
  assert.equal(await requestOf(h), request, 'ordinary move and replacement keep the queued reply unread')

  const other = await h.rt.deliver({ fromId: 'other', toId: 'solver', role: 'reply', text: 'Unrelated reply.' })
  assert.equal(inbox.remove(edited.id), true)
  await immediate()
  assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
  assert.ok(h.rt.deliveryNote(other), 'withdrawing the review reply leaves the unrelated note')
  closeRequest()
  assert.equal(track().delivered, true)
})

test('Rebase R2 keeps a matching receipt while its sibling is withdrawn', async t => {
  const { h, request, review, answer } = await reviewReplyFixture(t)
  const reply = answer(await review('plan'))
  h.finish('solver', 'Waiting for plan review.')
  await reply.sent
  const agent = h.agentOf('solver')
  const original = agent.message
  const pending = { ...original, id: 'pending-sibling' }
  const withdrawn = { ...original, id: 'withdrawn-sibling' }
  agent.inbox = { nextTurn: [pending], nextStep: [] }
  h.ctx.emit('agent/inbox/discarded', { agent, message: withdrawn })
  await immediate()
  assert.ok(h.rt.deliveryNote(reply.message.exchangeId), 'an already pending sibling keeps the receipt')

  agent.inbox.nextTurn.pop()
  h.event('solver', 'turn/start', { turn: 3 })
  h.ctx.emit('agent/inbox/claimed', { agent, message: pending, turn: 3 })
  h.ctx.emit('agent/inbox/discarded', { agent, message: withdrawn })
  await immediate()
  assert.ok(h.rt.deliveryNote(reply.message.exchangeId), 'an outstanding claim keeps the receipt')
  h.event('solver', 'user/message', pending)
  assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
  assert.match(await h.progress('start', { request, run: 'kept-receipt', checks: ['average-test'] }), /^Recorded\./)
})

test('Stage 6 round 2 keeps an accepted reply after a later delivery failure', async t => {
  for (const failure of ['later enqueue', 'Session flush']) {
    await t.test(failure, async t => {
      const { h, request, review, answer, deliveries } = await reviewReplyFixture(t)
      const exchange = await review('plan')
      const solver = h.agentOf('solver')
      const inbox = []
      solver.inbox = { nextTurn: inbox, nextStep: [] }
      solver.followup = message => {
        if (message.source.senderSessionId === 'other') throw new Error('Fixture later enqueue failed')
        inbox.push(message)
        h.ctx.emit('agent/inbox/inserted', { agent: solver, message })
      }
      let failed = false
      if (failure === 'Session flush') {
        h.ctx.sessions.flush = async session => {
          if (!failed && session.id === 'solver' && inbox.length > 0) {
            failed = true
            throw new Error('Fixture Session flush failed')
          }
        }
      }
      const reply = answer(exchange)
      const later = failure === 'later enqueue' ? h.rt.deliver({
        fromId: 'other', toId: 'solver', role: 'reply', text: 'Later batch item.',
      }) : undefined
      const rejected = later && assert.rejects(later, /Fixture later enqueue failed/)
      h.finish('solver', 'Waiting for plan review.')
      await reply.sent.catch(() => {})
      await rejected
      if (failure === 'Session flush') assert.equal(failed, true)
      assert.ok(h.rt.deliveryNote(reply.message.exchangeId), 'the accepted reply still holds the request')
      assert.equal(deliveries.filter(item => item.message.replyTo === exchange).length, 1, 'no actionable fallback')
      assert.equal(inbox.length, 1)
      const [input] = inbox
      h.event('solver', 'turn/start', { turn: 3 })
      h.takeInput('solver', { ...input, source: { ...input.source, reviewReceipt: 'stale' } })
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
      assert.equal(await requestOf(h), request)
      h.takeInput('solver', inbox.shift())
      assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined)
      assert.match(await h.progress('start', { request, run: 'run-after-failure', checks: ['average-test'] }), /^Recorded\./)
    })
  }
})

test('Stage 6 round 2 delivers the original request once after restarting a consumed RESULT turn', async t => {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const resultExchange = await review('result')
  const reply = answer(resultExchange)
  h.finish('solver', 'Waiting for result review.')
  await openReply(4, reply)
  assert.equal(h.rt.deliveryNote(reply.message.exchangeId), undefined, 'RESULT already became turn input')
  assert.notEqual(track().delivered, true)
  h.event('solver', 'turn/end', { reason: { kind: 'interrupted' } })
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual((await next.rt.resumesDone).resumed, ['solver'])
  } finally {
    clearInterval(keepAlive)
  }
  const input = next.agentOf('solver').message
  assert.equal(input.source.role, 'resume')
  assert.equal(await requestOf(next), request)
  next.event('solver', 'turn/start', { turn: 5 })
  next.event('solver', 'user/message', structuredClone(input))
  next.takeInput('solver', { ...input, id: 'different-continuation' })
  next.finish('solver', 'A matching-looking continuation did not authorize delivery.')
  assert.equal(await requestOf(next), request)

  next.event('solver', 'turn/start', { turn: 6 })
  next.takeInput('solver', input)
  next.finish('solver', 'Both reviews approved and both checks passed.')
  const resumedTrack = () => next.rt.botOf('solver').reviewTrack
  const mark = resumedTrack().last
  assert.equal(resumedTrack().solver.request, request)
  assert.equal(resumedTrack().delivered, true)
  assert.equal(mark.done, true)
  assert.equal(mark.resultExchangeId, resultExchange)
  next.event('solver', 'turn/start', { turn: 7 })
  next.takeInput('solver', input)
  next.finish('solver', 'This continuation already delivered.')
  assert.deepEqual(resumedTrack().last, mark)
  assert.equal(await next.progress('status'), noSolverRequest)
  assert.equal(await next.rt.flushUpdateNotes(), true)
  await next.close()
})

test('Rebase R2 recovers a moved RESULT continuation only from its current claim', async t => {
  const { h, request, resultExchange, openReply, reply } = await pendingResultReply(t)
  await openReply(4, reply)
  h.event('solver', 'turn/end', { reason: { kind: 'interrupted' } })
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const keepAlive = setInterval(() => {}, 1000)
  try {
    assert.deepEqual((await next.rt.resumesDone).resumed, ['solver'])
  } finally {
    clearInterval(keepAlive)
  }
  const agent = next.agentOf('solver')
  const original = agent.message
  const moved = { ...original, id: 'forwarded-continuation' }
  agent.inbox = { nextTurn: [moved], nextStep: [] }
  next.ctx.emit('agent/inbox/discarded', { agent, message: original })
  next.ctx.emit('agent/inbox/inserted', { agent, message: moved })
  await immediate()
  assert.ok(next.rt.deliveryNote(original.source.exchangeId), 'the note survives the inbox ID change')
  assert.equal(next.rt.takeReviewContinuation('solver', moved), undefined, 'forwarding alone is not consumption')
  assert.equal(await requestOf(next), request)
  next.event('solver', 'turn/start', { turn: 5 })
  agent.inbox.nextTurn.pop()
  next.ctx.emit('agent/inbox/claimed', { agent, message: moved, turn: 5 })
  assert.equal(next.rt.takeReviewContinuation('solver', original), undefined, 'the old ID was not claimed')
  next.event('solver', 'user/message', moved)
  next.finish('solver', 'Delivered after recovering and reading the moved RESULT.')
  const track = next.rt.botOf('solver').reviewTrack
  assert.equal(track.solver.request, request)
  assert.equal(track.last?.done, true)
  assert.equal(track.last.resultExchangeId, resultExchange)
  assert.equal(next.rt.takeReviewContinuation('solver', moved), undefined)
  assert.equal(await next.rt.flushUpdateNotes(), true)
  await next.rt.save({ required: true, durable: true })
  await next.close()
})

async function pendingResultReply(t) {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const resultExchange = await review('result')
  const reply = answer(resultExchange)
  h.finish('solver', 'Waiting for result review.')
  return { h, request, resultExchange, openReply, reply, track }
}

test('Rebase R2 authenticates new claims and consumed RESULT on the actual adopted turn', async t => {
  for (const consumed of [false, true]) await t.test(consumed ? 'long consumed turn' : 'new numbered claim', async t => {
    const { h, resultExchange, openReply, reply } = await pendingResultReply(t)
    await reply.sent
    const input = h.agentOf('solver').message
    if (consumed) await openReply(4, reply)
    await h.rt.save({ required: true, durable: true })
    assert.equal(await h.rt.flushUpdateNotes(), true)
    await h.close()

    const next = fixture(t, h.home, { liveTurn: 4 })
    const agent = next.agentOf('solver')
    if (consumed) {
      const start = agent.session.eventAt(0)
      agent.session.seq = 450
      agent.session.eventAt = seq => seq === 0 ? start : { type: 'step/start' }
    }
    await next.rt.load()
    await immediate()
    if (!consumed) {
      next.ctx.emit('agent/inbox/claimed', { agent, message: input, turn: 5 })
      next.event('solver', 'user/message', input)
      assert.equal(next.rt.live.get('solver')?.consumedResult, undefined)
      assert.ok(next.rt.deliveryNote(reply.message.exchangeId), 'the wrong-turn claim cannot consume the reply')
      next.ctx.emit('agent/inbox/claimed', { agent, message: input, turn: 4 })
      next.event('solver', 'user/message', input)
    }
    next.finish('solver', 'Delivered on the adopted RESULT turn.')
    assert.equal(next.rt.botOf('solver').reviewTrack.last?.done, true)
    assert.equal(next.rt.botOf('solver').reviewTrack.last.resultExchangeId, resultExchange)
    assert.equal(await next.rt.flushUpdateNotes(), true)
    await next.rt.save({ required: true, durable: true })
    await next.close()
  })
})

test('Stage 6 reload adopts a live turn only when it consumed the current RESULT', async t => {
  const { h, request, review, answer, track, openReply } = await reviewReplyFixture(t)
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const resultExchange = await review('result')
  const reply = answer(resultExchange)
  h.finish('solver', 'Waiting for result review.')
  await openReply(4, reply)
  assert.notEqual(track().delivered, true)
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home, { liveTurn: 4 })
  await next.rt.load()
  await immediate()
  const agent = next.agentOf('solver')
  const trackNow = () => next.rt.botOf('solver').reviewTrack
  assert.equal(next.rt.live.get('solver')?.consumedResult?.request, request)
  const eventAt = agent.session.eventAt
  agent.session.eventAt = () => ({ type: 'turn/start', data: { turn: 5 } })
  assert.equal(next.rt.consumedReviewResultForLiveTurn(agent), undefined)
  agent.session.eventAt = eventAt
  next.finish('solver', 'Both reviews approved and both checks passed.')
  const mark = trackNow().last
  assert.equal(mark.done, true)
  assert.equal(mark.resultExchangeId, resultExchange)
  next.event('solver', 'turn/start', { turn: 5 })
  next.finish('solver', 'This request has already been delivered.')
  assert.deepEqual(trackNow().last, mark)
})

const codexCapture = JSON.parse(readFileSync(new URL(
  '../../acp-dsh/test/fixtures/permission-payloads/codex-acp-2.6.0.json', import.meta.url)))
const codexUpdates = codexCapture.cases.find(item => item.name === 'agent: write outside the workspace').updates
const codexExecute = codexUpdates.find(update => update.kind === 'execute')
const codexExit = codexUpdates.find(update => update._meta?.terminal_exit)

async function nativeMirror(t, h, provider = 'acp-codex') {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  let agents
  await ctx.plugin({ name: 'solver-fixture-agents', inject: ['tools'], apply(child) { agents = child } })
  for (const listener of h.ctx.listeners.get('tools/execute')) ctx.on('tools/execute', listener)
  const agent = h.agentOf('solver')
  const cwd = h.rt.botOf('solver').workDir
  agent.session = Session.create(agent.id)
  agent.session.append('request/header', { header: { config: { provider, model: 'default' } } })
  const codex = provider === 'acp-codex'
  const name = codex ? 'Codex fixture' : 'Claude fixture'
  const scope = createScope(agents, agent)
  agent.ctx = scope.ctx
  const adapter = new AcpAdapter(ctx, new Map([[provider, { name }]]))
  adapter.registerMirror(agent)
  t.after(async () => { adapter.dispose(); await scope.dispose(); await ctx.fiber.dispose() })
  const signal = new AbortController().signal
  const resolve = () => ctx.tools.resolve({ agent, modelSelection: { provider, model: 'default' }, signal })

  async function mirror(runId, { command = "/bin/bash -lc 'fake check-a'", exit = 0, adjust, beforeExit, beforeMirror } = {}) {
    const opened = structuredClone(codexExecute)
    const finished = structuredClone(codexExit)
    opened.rawInput = { command, cwd }
    opened._meta.terminal_info.cwd = cwd
    finished._meta.terminal_exit.exit_code = exit
    if (exit !== 0) finished.status = 'failed'
    const exitSession = adjust?.(opened, finished)
    return mirrorUpdates(runId, opened, finished, { exitSession, beforeExit, beforeMirror })
  }

  async function mirrorUpdates(runId, opened, finished, { exitSession, beforeExit, beforeMirror } = {}) {
    const run = new AgentRun({ name, cwd })
    run.sessionId = 'native-session'
    await run.onUpdate(opened, run.sessionId)
    const tool = run.tools.get(opened.toolCallId)
    const args = callArguments(tool)
    await beforeExit?.()
    await run.onUpdate(finished, exitSession ?? run.sessionId)
    await beforeMirror?.()
    // The adapter's stream advertises this pairing when it ends a step at the mirror.
    assert.deepEqual(await run.next(signal), { type: 'tool', id: tool.id })
    const id = `acp-${runId}`
    adapter.live.set(agent.id, { run, name, native: true, calls: new Set([id]), toolIds: new Map([[id, tool.id]]) })
    const toolSet = await resolve()
    try {
      const batch = await ctx.tools.execute({ calls: [{ id, name: 'acp_tool', arguments: JSON.stringify(args) }], agent, signal, toolSet })
      return batch.results[0].result
    } finally {
      toolSet.dispose()
    }
  }
  return { cwd, mirror, mirrorUpdates }
}

async function nativeCheck(t, agreed = 'fake check-a', { legacyPlan, provider } = {}) {
  const h = await setup(t)
  const { request, send, delivered } = await reviewedPlan(h, ['check-a'], [{ check: 'check-a', command: agreed }], { legacyPlan })
  const { cwd, mirror } = await nativeMirror(t, h, provider)
  const report = (run, pass = true) => h.progress('checks', { request, run, results: results('check-a', pass) })
  const start = run => h.progress('start', { request, run, checks: ['check-a'] })
  const savedPending = () => JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver.pending
  return { cwd, start, report, mirror, send, savedPending, bot: () => h.rt.botOf('solver'), host: h, delivered }
}

// Literal from the 5bb4badb6 investigation. Only the agreed directory is replaced
// in portable cases, because the mirror checks that it exists and never executes the command.
const stage6Directory = '/tmp/automagik-solver-combined-3-t422'
const stage6Agreed = 'cd /tmp/automagik-solver-combined-3-t422 && scripts/capped-run -- /bin/bash /tmp/automagik-2056-limits-auto-5bb4badb-git-scratch/check.sh'
const stage6CommandIn = directory => stage6Agreed.replace(stage6Directory, directory)
const checkDirectory = t => {
  const directory = mkdtempSync(join(tmpdir(), 'solver-agreed-cwd-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const claudeBashInput = JSON.parse(readFileSync(new URL(
  '../src/host/live-chat/fixtures/claude.jsonl', import.meta.url), 'utf8').split('\n')[3])
  .message.content.find(block => block.type === 'tool_use' && block.name === 'Bash').input

async function claudeReviewFixture(t, ids) {
  const fixture = await reviewReplyFixture(t, undefined, ids)
  const { h, review, openReply, deliveries } = fixture
  const { cwd, mirrorUpdates } = await nativeMirror(t, h, 'acp-claude')
  const headers = []
  const answer = async (kind, turn, text) => {
    const exchangeId = await review(kind)
    const input = h.agentOf('reviewer').message
    assert.equal(input.source.exchangeId, exchangeId)
    headers.push([kind.toUpperCase(), input.content.map(part => part.text).join('\n')])
    h.finish('solver', `Waiting for ${kind} review.`)
    h.event('reviewer', 'turn/start', { turn: turn - 1 })
    h.takeInput('reviewer', input)
    h.finish('reviewer', text)
    const reply = deliveries.at(-1)
    assert.equal(reply.message.replyTo, exchangeId)
    assert.ok(reply.message.reviewReceipt)
    await openReply(turn, reply)
    return exchangeId
  }
  return { ...fixture, cwd, mirrorUpdates, headers, answer }
}

async function claudeSolverToDone(t, ids = ['average-test', 'diff-check']) {
  const { h, request, track, cwd, mirrorUpdates, headers, answer } = await claudeReviewFixture(t, ids)
  const bash = id => {
    const toolCallId = `toolu_${id}`
    const command = 'cat average.mjs'
    const _meta = { claudeCode: { toolName: 'Bash' } }
    return mirrorUpdates(id, {
      sessionUpdate: 'tool_call', toolCallId, title: command, kind: 'execute', status: 'in_progress',
      rawInput: { ...claudeBashInput, command }, _meta,
    }, {
      sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'export const average = xs => xs.reduce((a, b) => a + b, 0) / xs.length' } }], _meta,
    })
  }
  writeFileSync(join(cwd, 'average.mjs'), 'export const average = xs => xs.reduce((a, b) => a + b, 0) / xs.length\n')
  const held = await bash('before_plan')
  assert.equal(held.isError, true)
  assert.match(held.content[0].text, /review guard holds work/)

  const fix = await answer('plan', 3, 'PLAN FIX-FIRST\nUse the exact test path.')
  const first = structuredClone(track().solver.plan)
  assert.equal(first.review.exchangeId, fix)
  assert.match(await h.progress('replan', { request, run: 'replan-1' }), /^Recorded\./)
  const checks = [
    { check: ids[0], command: 'node --test ./average.test.mjs' },
    { check: ids[1], command: 'git diff --check' },
  ]
  assert.match(await plan(h, request, checks.map(({ check }) => check), checks), /^Recorded\./)
  const ship = await answer('plan', 4, 'PLAN SHIP\nThe revised plan matches the request.')
  assert.notEqual(fix, ship)
  assert.equal(track().solver.plan.review.exchangeId, ship)
  const work = await bash('after_plan')
  assert.deepEqual({
    firstVerdict: first.review.verdict, firstAccepted: first.accepted,
    revisedVerdict: track().solver.plan.review.verdict, revisedAccepted: track().solver.plan.accepted,
    guardOpened: typeof track().planVerdictAt === 'number', advisory: track().verdicts.map(({ verdict }) => verdict),
    nativeWorkAdmitted: work.isError === false,
  }, {
    firstVerdict: 'FIX-FIRST', firstAccepted: false,
    revisedVerdict: 'SHIP', revisedAccepted: true,
    guardOpened: true, advisory: ['FIX-FIRST', 'SHIP'], nativeWorkAdmitted: true,
  }, 'the two bound PLAN verdicts are recorded and the Claude Bash mirror is admitted')
  assert.ok(track().firstWorkAt)

  // A Claude Bash completion carries text. Verify checks through the foreground tool
  // with an observed exit code, without attributing a terminal exit to the Claude update.
  for (const check of checks) {
    assert.match(await checked(h, request, check.check, check), /^Recorded\./)
  }
  assert.deepEqual(track().solver.passed, checks.map(({ check }) => check.toLowerCase()))
  const result = await answer('result', 5, 'RESULT SHIP\nBoth current checks pass.')
  const recorded = track().solver.review
  assert.equal(recorded.exchangeId, result)
  assert.equal(recorded.revision, track().solver.revision)
  assert.equal(recorded.verdict, 'SHIP')
  assert.equal(recorded.reviewer.id, 'reviewer')
  assert.notEqual(recorded.reviewer.model, recorded.solverModel)
  assert.deepEqual(track().verdicts.map(({ verdict }) => verdict), ['FIX-FIRST', 'SHIP', 'SHIP'])
  h.finish('solver', 'Delivered after independent result review.')
  assert.equal(track().last?.done, true)
  assert.equal(track().last.resultExchangeId, result)
  assert.equal(track().delivered, true)
  for (const [stage, header] of headers) {
    assert.match(header, new RegExp(`First line: exactly one of \`${stage} SHIP\`, \`${stage} FIX-FIRST\`, or \`${stage} BLOCKED\`\\.`))
  }
  return { h, track }
}

test('stage verdicts take a Claude native Solver through replan, admitted work and Done', claudeSolverToDone)

function solverDeliveryText(h) {
  const bot = h.rt.botOf('solver')
  const view = { ...bot, ...h.rt.reviewMarkOf(bot), ...h.rt.solverStatusOf(bot) }
  return reviewMarkText(view, { byId: h.rt.state.bots })
}

test('#2131 mixed-case check IDs take a Claude native Solver to Done', async t => {
  const { h, track } = await claudeSolverToDone(t, ['C1-arquivos', 'C2'])
  assert.deepEqual(track().solver.passed, ['c1-arquivos', 'c2'])
  assert.doesNotMatch(solverDeliveryText(h), /not verified/i)
})

test('#2131 a mixed-case unverified run records no Done and shows not verified', async t => {
  const { h, request, review, track, answer } = await claudeReviewFixture(t, ['C1-arquivos', 'C2'])
  const ship = await answer('plan', 3, 'PLAN SHIP\nThe plan matches the request.')
  assert.equal(track().solver.plan.review.exchangeId, ship)
  assert.equal(track().solver.plan.review.verdict, 'SHIP')
  assert.equal(await h.progress('start', { request, run: 'R1', checks: ['C1-arquivos'] }),
    'Recorded. Run the check and report all its outcomes.')
  const reason = 'No matching completed check was observed.'
  assert.equal(await h.progress('checks', { request, run: 'r1', results: results('c1-ARQUIVOS') }),
    `No verified passing evidence for this run. ${reason} Start a new run on the current result.`)
  assert.equal(track().solver.runs.r1.unverified, true)
  assert.equal(track().solver.runs.r1.reason, reason)
  assert.deepEqual(track().solver.passed, [])
  await assert.rejects(review('result'), /Record current passing runs for every agreed check/)
  h.finish('solver', 'Delivered.')
  assert.equal(track().delivered, true)
  assert.equal(track().solver.review, undefined)
  assert.notEqual(track().last.done, true)
  assert.equal(track().outcome.reason, 'checks')
  assert.match(solverDeliveryText(h), /Result not verified, so not marked done: current passing results are missing for agreed checks\./)
})

test('stage verdict parsers keep legacy forms and refuse wrong or unbound stages', () => {
  const parse = (text, stage) => [verdictOf(text, stage), guardVerdictOf(text, 'reviewer', stage)]
  for (const stage of ['plan', 'result']) {
    assert.deepEqual(parse('SHIP\nEvidence.', stage), ['SHIP', 'SHIP'])
    assert.deepEqual(parse('Verdict: FIX-FIRST\nEvidence.', stage), ['FIX-FIRST', 'FIX-FIRST'])
    assert.deepEqual(parse(`${stage.toUpperCase()} SHIP\nVerdict: BLOCKED`, stage), ['BLOCKED', 'SHIP'])
    for (const verdict of ['SHIP', 'FIX-FIRST', 'BLOCKED']) {
      const line = `${stage.toUpperCase()} ${verdict}`
      const other = stage === 'plan' ? 'result' : 'plan'
      assert.deepEqual(parse(`${line}\r\nVerdict: SHIP`, stage), [verdict, verdict])
      assert.deepEqual(parse(`${line}\nVerdict: SHIP`, other), [undefined, undefined])
      assert.deepEqual(parse(`${line}\nVerdict: SHIP`), [undefined, undefined])
    }
    for (const line of [`${stage.toUpperCase()}: SHIP`, `${stage.toUpperCase()}  SHIP`, `${stage.toUpperCase()} SHIP `, ` ${stage.toUpperCase()} SHIP`,
      `${stage.toUpperCase()} SHIP.`, `**${stage.toUpperCase()} SHIP**`, `${stage} SHIP`, `\n${stage.toUpperCase()} SHIP`]) {
      assert.deepEqual(parse(line, stage), [undefined, undefined], JSON.stringify(line))
    }
  }
})

test('stage verdict replies cannot borrow a later legacy label in the Solver host', async t => {
  const { h, request, review, track, openReply, deliveries } = await reviewReplyFixture(t)
  let turn = 2
  const answer = async (kind, text) => {
    const before = track().verdicts.map(({ verdict }) => verdict)
    const exchangeId = kind ? await review(kind) : undefined
    if (!kind) await h.tool('message_bot', { to: 'reviewer', message: 'Ordinary review.', reply_to: 'me', when: 'queue' })
    const input = h.agentOf('reviewer').message
    assert.equal(input.source.exchangeId, exchangeId ?? deliveries.at(-1).message.exchangeId)
    h.finish('solver', 'Waiting for the reviewer.')
    h.event('reviewer', 'turn/start', { turn })
    h.takeInput('reviewer', input)
    h.finish('reviewer', text)
    const reply = deliveries.at(-1)
    assert.equal(Boolean(reply.message.reviewReceipt), Boolean(kind))
    await openReply(++turn, reply)
    return before
  }
  const rejectStage = async (kind, firstLine) => {
    const before = await answer(kind, `${firstLine}\nVerdict: SHIP`)
    assert.deepEqual(track().verdicts.map(({ verdict }) => verdict), before, firstLine)
  }
  await rejectStage(undefined, 'PLAN SHIP')
  await rejectStage('plan', 'RESULT SHIP')
  assert.equal(track().solver.plan.review.verdict, 'unverified')
  assert.equal(track().planVerdictAt, undefined)
  await answer('plan', ' PLAN SHIP\nThe leading space survives verdict parsing.')
  assert.equal(track().solver.plan.review.verdict, 'unverified')
  await answer('plan', 'PLAN SHIP\nVerdict: FIX-FIRST')
  assert.equal(track().solver.plan.review.verdict, 'FIX-FIRST')
  assert.equal(track().solver.plan.accepted, false)
  await answer('plan', 'SHIP\nLegacy approval.')
  assert.equal(track().solver.plan.accepted, true)
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  await rejectStage(undefined, 'RESULT SHIP')
  await rejectStage('result', 'PLAN SHIP')
  assert.equal(track().solver.review.verdict, 'unverified')
  await answer('result', 'RESULT SHIP ')
  assert.equal(track().solver.review.verdict, 'unverified')
  await answer('result', 'RESULT SHIP\nVerdict: BLOCKED')
  assert.equal(track().solver.review.verdict, 'BLOCKED')
  h.finish('solver', 'The result review is unverified.')
  assert.equal(track().last?.done, undefined)
})

test('stage verdict correction: a stopped joined request receives a notice without approval', async t => {
  const { h, review, track, deliveries } = await reviewReplyFixture(t)
  h.event('reviewer', 'turn/start', { turn: 1 })
  h.person('Unrelated work.', 'reviewer')
  const exchange = await review('plan')
  h.finish('solver', 'Waiting for review.')
  h.takeInput('reviewer', h.agentOf('reviewer').message)
  assert.equal(h.rt.live.get('reviewer').joined[0].info.exchangeId, exchange)
  h.event('reviewer', 'assistant/message', { message: { content: content('PLAN SHIP') } })
  h.event('reviewer', 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const { message, sent } = deliveries.at(-1)
  assert.equal(await sent, message.exchangeId)
  const input = h.agentOf('solver').message
  assert.equal(input.source.replyTo, exchange)
  assert.ok(input.source.reviewReceipt)
  assert.match(input.content[0].text, /reviewer was stopped before it could answer your message\.$/)
  assert.doesNotMatch(input.content[0].text, /PLAN SHIP/)
  assert.equal(h.rt.state.works[exchange], undefined)
  assert.deepEqual({ accepted: track().solver.plan.accepted, review: track().solver.plan.review.verdict,
    strict: track().planVerdictAt, marks: track().verdicts }, {
    accepted: false, review: 'unverified', strict: undefined, marks: [],
  })
})

const reviewSteerCut = { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } }
const heldReviewer = { provider: 'acp-claude', model: 'sonnet' }
const heldReviewerIdentity = 'acp-claude/claude-sonnet-5-5'

async function heldReviewReply(t, heldText, {
  kind = 'plan', missingHeldRoute = false, displayText = heldText.trim(), childText = 'The fixture is present.', writtenRetry = false,
} = {}) {
  const { h, request, review, track, openReply, deliveries } = await reviewReplyFixture(t)
  if (kind === 'result') {
    await review('plan')
    h.finish('solver', 'Waiting for plan review.')
    h.event('reviewer', 'turn/start', { turn: 1 })
    h.takeInput('reviewer', h.agentOf('reviewer').message)
    h.finish('reviewer', 'SHIP')
    await openReply(3, deliveries.at(-1))
    assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
    assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  }
  if (kind === 'result') {
    h.agentOf('reviewer').session.requestHeader = () => missingHeldRoute ? undefined : { config: heldReviewer }
  }
  const exchange = await review(kind)
  h.finish('solver', 'Waiting for review.')
  let turn = 2
  h.event('reviewer', 'turn/start', { turn })
  const reviewInput = h.agentOf('reviewer').message
  h.takeInput('reviewer', reviewInput)
  if (writtenRetry) {
    h.finish('reviewer', '<tool_call><function=read>')
    assert.equal(await deliveries.at(-1).sent, exchange)
    const retry = h.agentOf('reviewer').message
    assert.equal(retry.source.retried, true)
    assert.equal(retry.source.exchangeId, exchange)
    assert.match(retry.content[0].text, /wrote a tool call as plain text/)
    h.event('reviewer', 'turn/start', { turn: ++turn })
    h.takeInput('reviewer', retry)
  }
  await h.tool('message_bot', { to: 'other', message: 'Check the fixture.', reply_to: 'me', when: 'queue' }, 'reviewer')
  assert.equal(h.rt.waitsWork(exchange), true)
  h.finish('reviewer', heldText)
  // The silent turn uses a different route, equal to the Solver's.
  h.agentOf('reviewer').session.requestHeader = () => ({ config: solverModel })
  assert.equal(h.rt.state.works[exchange].held, displayText)
  h.event('other', 'turn/start', { turn: 1 })
  h.takeInput('other', h.agentOf('other').message)
  h.finish('other', childText)
  await deliveries.at(-1).sent
  const child = h.agentOf('reviewer').message
  assert.equal(child.source.work, exchange)
  h.event('reviewer', 'turn/start', { turn: turn + 1 })
  h.takeInput('reviewer', child)
  assert.equal(h.rt.waitsWork(exchange), false)
  return { h, child, exchange, track, deliveries, openReply, request, reviewInput }
}

function assertHeldDelivery(input, exchange, heldText) {
  assert.equal(input.source.replyTo, exchange)
  assert.ok(input.source.reviewReceipt)
  assert.ok(input.content[0].text.includes(`${heldText.trim()}\n\n[Handed back to reviewer for this work]\n\nother:\nThe fixture is present.`))
}

function assertHeldPlanVerdict(track, expected) {
  assert.deepEqual({ accepted: track.solver.plan.accepted, review: track.solver.plan.review.verdict,
    strict: typeof track.planVerdictAt === 'number', marks: track.verdicts.map(({ verdict }) => verdict) }, expected)
}

const heldPlanApproved = { accepted: true, review: 'SHIP', strict: true, marks: ['SHIP'] }
const heldPlanUnverified = { accepted: false, review: 'unverified', strict: false, marks: [] }

test('stage verdict correction: a silent continuation uses the held reviewer first line', async t => {
  for (const [heldText, expected, steer, response = ''] of [
    ['PLAN SHIP', heldPlanApproved],
    ['RESULT SHIP\nVerdict: SHIP', heldPlanUnverified, true],
    [' PLAN SHIP', heldPlanUnverified],
    ['PLAN SHIP\nVerdict: FIX-FIRST', { accepted: false, review: 'FIX-FIRST', strict: true, marks: ['FIX-FIRST'] }],
    ['PLAN SHIP', heldPlanUnverified, false, 'RESULT SHIP\nVerdict: SHIP'],
  ]) {
    const { h, exchange, track, deliveries } = await heldReviewReply(t, heldText)
    if (steer) {
      h.rt.markSteerCut('reviewer')
      h.event('reviewer', 'assistant/message', { message: { content: content('PLAN SHIP') } })
      h.event('reviewer', 'turn/end', { reason: reviewSteerCut })
      h.event('reviewer', 'turn/start', { turn: 4 })
      h.person('Finish the review.', 'reviewer')
    }
    h.finish('reviewer', response)
    const { message, sent } = deliveries.at(-1)
    assert.equal(await sent, message.exchangeId)
    assert.equal(h.rt.state.works[exchange], undefined)
    assertHeldDelivery(h.agentOf('solver').message, exchange, response || heldText)
    assertHeldPlanVerdict(track(), expected)
    await h.close()
  }
  const result = 'RESULT SHIP\nVerdict: SHIP'
  for (const [missingHeldRoute, expected] of [[true, 'unverified'], [false, 'SHIP']]) {
    const { h, exchange, track, deliveries } = await heldReviewReply(t, result, { kind: 'result', missingHeldRoute })
    h.finish('reviewer', '')
    const { message, sent } = deliveries.at(-1)
    assert.equal(await sent, message.exchangeId)
    const input = h.agentOf('solver').message
    assertHeldDelivery(input, exchange, result)
    const review = track().solver.review
    assert.equal(review.verdict, expected, 'RESULT uses the route of the turn that wrote the held reply')
    assert.equal(review.reviewer?.model, expected === 'SHIP' ? heldReviewerIdentity : undefined)
    assert.equal(review.unverified, expected === 'SHIP' ? undefined : 'model')
    assert.equal(modelWarningCount(input), expected === 'SHIP' ? 0 : 1)
    await h.close()
  }
})

test('stage verdict exception: a held RESULT veto beyond the display cap withholds Done', async t => {
  const reply = readFileSync(new URL('./fixtures/held-result-2329.txt', import.meta.url), 'utf8')
  const displayText = reply.slice(0, 2000)
  const { h, exchange, track, deliveries, openReply } = await heldReviewReply(t, reply, {
    kind: 'result', displayText,
  })
  h.finish('reviewer', '')
  await openReply(4, deliveries.at(-1))
  const input = h.agentOf('solver').message
  assertHeldDelivery(input, exchange, displayText)
  assert.ok(!input.content[0].text.includes('Verdict: BLOCKED'))
  assert.equal(track().solver.review.reviewer?.model, heldReviewerIdentity)
  assert.equal(track().solver.review.exchangeId, exchange)
  assert.equal(track().solver.review.revision, track().solver.revision)
  h.finish('solver', 'Finished the agreed checks and received the review.')
  assert.deepEqual({ strict: track().solver.review.verdict, advisory: track().verdicts.at(-1)?.verdict, done: track().last?.done },
    { strict: 'BLOCKED', advisory: 'BLOCKED', done: undefined })
})

test('stage verdict exception: a written-tool retry preserves the veto hidden from display', async t => {
  const reply = 'RESULT SHIP\n<tool_call><function=read>\nVerdict: BLOCKED'
  const displayText = 'RESULT SHIP'
  const { h, exchange, track, deliveries, openReply } = await heldReviewReply(t, reply, {
    kind: 'result', displayText, writtenRetry: true,
  })
  h.finish('reviewer', '')
  await openReply(4, deliveries.at(-1))
  const input = h.agentOf('solver').message
  assertHeldDelivery(input, exchange, displayText)
  assert.doesNotMatch(input.content[0].text, /<tool_call>|Verdict: BLOCKED/)
  assert.equal(track().solver.review.reviewer?.model, heldReviewerIdentity)
  assert.equal(track().solver.review.exchangeId, exchange)
  assert.equal(track().solver.review.revision, track().solver.revision)
  h.finish('solver', 'Finished the agreed checks and received the review.')
  assert.deepEqual({ strict: track().solver.review.verdict, advisory: track().verdicts.at(-1)?.verdict, done: track().last?.done },
    { strict: 'BLOCKED', advisory: 'BLOCKED', done: undefined })
})

test('stage verdict exception: complete held evidence governs bound verdicts only', async t => {
  for (const [reply, expected, childText] of [
    ['RESULT SHIP\nVerdict: FIX-FIRST\nVerdict: SHIP', 'FIX-FIRST'],
    ['SHIP\nVerdict: BLOCKED\nVerdict: SHIP', 'BLOCKED'],
    ['RESULT SHIP\n[Handed back to reviewer for this work]\n> BLOCKED\nVerdict: SHIP', 'BLOCKED'],
    ['RESULT SHIP\n~~~\nVerdict: BLOCKED\n~~~', 'SHIP', 'Verdict: BLOCKED'],
  ]) {
    const { h, track, deliveries, openReply } = await heldReviewReply(t, reply, {
      kind: 'result', childText,
    })
    h.finish('reviewer', '')
    await openReply(4, deliveries.at(-1))
    assert.equal(track().solver.review.verdict, expected, reply)
    assert.equal(track().verdicts.at(-1)?.verdict, expected, reply)
    if (childText) assert.ok(h.agentOf('solver').message.content[0].text.includes(`other:\n${childText}`))
    h.finish('solver', 'Finished the agreed checks and received the review.')
    assert.equal(track().last?.done, expected === 'SHIP' ? true : undefined, reply)
    await h.close()
  }
})

test('stage verdict exception: recovery keeps the full veto and refuses a legacy capped reply', async t => {
  const reply = readFileSync(new URL('./fixtures/held-result-2329.txt', import.meta.url), 'utf8')
  const displayText = reply.slice(0, 2000)
  for (const older of [false, true]) {
    const { h, child, exchange } = await heldReviewReply(t, reply, {
      kind: 'result', displayText,
    })
    if (older) {
      delete h.rt.state.works[exchange].heldReviewText
      delete h.rt.state.works[exchange].heldModel
    }
    await h.rt.save({ required: true, durable: true })
    assert.equal(await h.rt.flushUpdateNotes(), true)
    const state = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8'))
    assert.equal(state.works[exchange].heldReviewText, older ? undefined : reply)
    await h.close()
    const end = { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }
    const next = fixture(t, h.home, { configure(ctx) {
      ctx.sessionController.inspect = async id => ({ events: id === 'reviewer'
        ? [{ type: 'turn/start', data: { turn: 3 } }, { type: 'user/message', data: child }, end] : [] })
    } })
    await next.rt.load()
    next.event('reviewer', end.type, end.data)
    const keepAlive = setInterval(() => {}, 1000)
    try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
    const solver = next.agentOf('solver')
    await until(() => solver.message?.source.replyTo === exchange)
    assertHeldDelivery(solver.message, exchange, displayText)
    const track = next.rt.botOf('solver').reviewTrack
    assert.equal(track.solver.review.verdict, older ? 'unverified' : 'BLOCKED')
    assert.equal(track.verdicts.at(-1)?.verdict, older ? 'SHIP' : 'BLOCKED')
    assert.equal(track.solver.review.reviewer?.model, older ? undefined : heldReviewerIdentity)
    await next.close()
  }
})

test('stage verdict correction: recovery uses the held line for the reply reconciled from the log', async t => {
  for (const [heldText, expected, { steer, older, recorded, legacy, kind = 'plan' } = {}] of [
    ['RESULT SHIP\nVerdict: SHIP', heldPlanUnverified, { steer: true }],
    ['PLAN SHIP', heldPlanApproved],
    ['PLAN SHIP\nVerdict: SHIP', heldPlanUnverified, { older: true }],
    ['Verdict: SHIP', heldPlanApproved, { older: true }],
    ['RESULT SHIP', 'SHIP', { kind: 'result' }],
    ['RESULT SHIP', 'SHIP', { kind: 'result', legacy: true }],
    ['Waiting for evidence.', 'SHIP', { kind: 'result', recorded: true }],
  ]) {
    const { h, child, exchange } = await heldReviewReply(t, heldText, { kind })
    if (older) delete h.rt.state.works[exchange].heldFirstLine
    const progress = h.rt.botOf('solver').reviewTrack.solver
    const workAt = h.rt.state.works[exchange].at
    if (legacy) progress.review.solverModel = solverModel.model
    const context = route => ({ type: 'request/context', data: route })
    const recordedRoute = { provider: 'acp-omp', model: 'default' }
    const solverLog = legacy ? [
      { type: 'turn/start', data: { turn: 3 } },
      context(solverModel),
      { type: 'tool/call', time: workAt, data: { name: 'mcp__dsh__message_bot',
        arguments: JSON.stringify({ solver_review: 'result', solver_request: progress.request }) } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 4 } },
      context({ provider: 'acp-omp', model: 'default' }),
    ] : []
    // Omni closes while the reviewer's continuation is running. Only DSH sees it finish.
    const end = { type: 'turn/end', data: { turn: steer ? 4 : 3, reason: { kind: 'completed' } } }
    const log = [{ type: 'turn/start', data: { turn: 3 } }, { type: 'user/message', data: child },
      context(recorded ? recordedRoute : solverModel)]
    if (recorded) log.push({ type: 'assistant/message', data: { message: { content: content('RESULT SHIP') } } })
    if (steer) log.push({ type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: content('PLAN SHIP') } } },
      { type: 'turn/end', data: { turn: 3, reason: reviewSteerCut } }, { type: 'turn/start', data: { turn: 4 } })
    log.push(end, { type: 'turn/start', data: { turn: 5 } }, context(solverModel))
    await h.rt.save({ required: true, durable: true })
    assert.equal(await h.rt.flushUpdateNotes(), true)
    const state = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8'))
    const notes = JSON.parse(readFileSync(join(h.home, 'inflight.json'), 'utf8'))
    assert.equal(state.works[exchange].held, heldText)
    if (kind === 'result') assert.equal(state.works[exchange].heldModel, heldReviewerIdentity)
    assert.equal(notes.turns.reviewer.trigger.exchangeId, child.source.exchangeId)
    await h.close()
    const inspected = []
    const next = fixture(t, h.home, { configure(ctx) {
      ctx.sessionController.inspect = async id => {
        inspected.push(id)
        return { events: id === 'reviewer' ? log : solverLog }
      }
    } })
    await next.rt.load()
    next.event('reviewer', end.type, end.data)
    const keepAlive = setInterval(() => {}, 1000)
    try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
    assert.ok(inspected.includes('reviewer'))
    const solver = next.agentOf('solver')
    await until(() => solver.message?.source.replyTo === exchange)
    assert.equal(next.rt.state.works[exchange], undefined)
    assertHeldDelivery(solver.message, exchange, recorded ? 'RESULT SHIP' : heldText)
    const track = next.rt.botOf('solver').reviewTrack
    if (kind === 'plan') {
      assertHeldPlanVerdict(track, expected)
    } else {
      assert.equal(track.solver.review.verdict, expected)
      assert.equal(track.solver.review.solverModel, refOf(solverModel))
      assert.equal(track.solver.review.reviewer?.model, recorded ? refOf(recordedRoute) : heldReviewerIdentity)
      assert.equal(track.solver.review.receipt, solver.message.source.reviewReceipt)
      assert.equal(modelWarningCount(solver.message), 0)
      next.event('solver', 'turn/start', { turn: 6 })
      next.takeInput('solver', solver.message)
      next.finish('solver', 'Delivered after recovering RESULT.')
      assert.equal(next.rt.botOf('solver').reviewTrack.last?.done, true)
    }
    await next.close()
  }
})

test('PR B recovers a base-format held RESULT or asks once more after restart', async t => {
  const held = JSON.parse(readFileSync(new URL('./fixtures/legacy-held-result.json', import.meta.url), 'utf8'))
  const start = turn => ({ type: 'turn/start', data: { turn } })
  const end = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  const route = data => ({ type: 'request/context', data })
  const input = data => ({ type: 'user/message', data })
  for (const [name, originalCount, live, unreadable] of [
    ['unique original route', 1, false],
    ['unique original route in a live continuation', 1, true],
    ['missing original route', 0, false],
    ['ambiguous original route', 2, false],
    ['unreadable reviewer log', 0, false, true],
  ]) {
    await t.test(name, async t => {
      const { h, child, exchange, track, request, reviewInput } = await heldReviewReply(t, held.held, { kind: 'result' })
      const workAt = h.rt.state.works[exchange].at
      h.rt.state.works[exchange] = { ...structuredClone(held), at: workAt }
      // The old designation stored only the model, without its provider.
      track().solver.review.solverModel = solverModel.model
      const checkedWork = ({ revision, snapshot, passed, passRuns }) => ({ revision, snapshot, passed, passRuns })
      const evidence = structuredClone(checkedWork(track().solver))
      const history = { review: 'bot', done: true, resultExchangeId: 'earlier-result' }
      const priorVerdicts = structuredClone(track().verdicts)
      track().last = history
      const original = (turn, model) => [start(turn), input(reviewInput), route(model),
        { type: 'assistant/message', data: { message: { content: content(held.heldReviewText) } } }, end(turn)]
      const reviewerLog = [
        ...(originalCount > 0 ? original(1, heldReviewer) : []),
        ...(originalCount > 1 ? original(2, { provider: 'acp-omp', model: 'default' }) : []),
        start(3), input(child), route(solverModel), end(3),
      ]
      const solverLog = [start(3), route(solverModel), { type: 'tool/call', time: workAt,
        data: { name: 'mcp__dsh__message_bot', arguments: JSON.stringify({ solver_review: 'result', solver_request: request }) } },
      end(3)]
      await h.rt.save({ required: true, durable: true })
      assert.equal(await h.rt.flushUpdateNotes(), true)
      const stored = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).works[exchange]
      assert.equal(Object.hasOwn(stored, 'heldModel'), false)
      assert.equal(stored.heldReviewText, held.heldReviewText)
      assert.equal(stored.heldFirstLine, held.heldFirstLine)
      await h.close()

      let failedReviewerRead = false
      const next = fixture(t, h.home, { configure(ctx) {
        ctx.sessionController.inspect = async id => {
          if (id === 'reviewer' && unreadable) {
            failedReviewerRead = true
            throw new Error('Fixture reviewer log read failed')
          }
          return { events: id === 'reviewer' ? reviewerLog : solverLog }
        }
      } })
      const deliveries = []
      const deliver = next.rt.deliver
      next.rt.deliver = (message, options) => {
        deliveries.push(message)
        return deliver(message, options)
      }
      await next.rt.load()
      if (live) {
        // A new turn took over before the recovery pass. Only the live path sees it end.
        next.event('reviewer', 'turn/start', { turn: 3 })
        next.takeInput('reviewer', child)
      }
      next.event('reviewer', end(3).type, end(3).data)
      const keepAlive = setInterval(() => {}, 1000)
      try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
      const solver = next.agentOf('solver')
      const bot = next.rt.botOf('solver')
      await until(() => solver.message?.source.replyTo === exchange)
      if (unreadable) {
        assert.equal(failedReviewerRead, true)
        assert.match(solver.message.content.at(-1).text, /Ask the designated reviewer once more on the same checked work/,
          'an unreadable legacy RESULT prompts a fresh review of the same work')
      }
      assertHeldDelivery(solver.message, exchange, held.held)
      assert.equal(next.rt.state.works[exchange], undefined)
      assert.deepEqual(bot.reviewTrack.last, history)
      assert.deepEqual(checkedWork(bot.reviewTrack.solver), evidence)
      next.event('solver', 'turn/start', { turn: 6 })
      next.takeInput('solver', solver.message)
      if (originalCount === 1) {
        assert.equal(bot.reviewTrack.solver.review.verdict, 'SHIP')
        assert.equal(bot.reviewTrack.solver.review.reviewer.model, heldReviewerIdentity)
        assert.equal(bot.reviewTrack.solver.review.solverModel, refOf(solverModel))
        next.finish('solver', 'Delivered after recovering the original RESULT.')
        assert.equal(bot.reviewTrack.last.resultExchangeId, exchange)
        assert.equal(bot.reviewTrack.last.done, true)
      } else {
        const result = bot.reviewTrack.solver.review
        assert.equal(result.verdict, 'unverified')
        assert.equal(result.reviewer, undefined)
        assert.equal(result.receipt, solver.message.source.reviewReceipt)
        const binding = next.rt.live.get('solver').consumedResult
        assert.equal(binding?.request, request)
        assert.equal(binding?.replyTo, exchange)
        assert.equal(binding?.receipt, result.receipt)
        assert.deepEqual(bot.reviewTrack.verdicts, priorVerdicts)
        assert.notEqual(bot.reviewTrack.delivered, true)
        // The fake Solver acts on the host feedback through the normal review tool.
        assert.match(solver.message.content.at(-1).text, /Ask the designated reviewer once more on the same checked work/)
        const askAgain = () => next.tool('message_bot', { to: 'reviewer', message: 'Review the same checked result.',
          solver_review: 'result', solver_request: request, reply_to: 'me' })
        await askAgain()
        await assert.rejects(askAgain(), /already waiting/)
        assert.deepEqual(checkedWork(bot.reviewTrack.solver), evidence)
        assert.deepEqual(bot.reviewTrack.last, history)
        assert.equal(bot.reviewTrack.solver.review.verdict, undefined)
        assert.notEqual(bot.reviewTrack.solver.review.exchangeId, exchange)
        assert.equal(bot.reviewTrack.solver.review.reviewerId, 'reviewer')
        assert.equal(next.agentOf('reviewer').message.source.exchangeId, bot.reviewTrack.solver.review.exchangeId)
      }
      assert.equal(deliveries.filter(message => message.role === 'request' && message.toId === 'reviewer').length,
        originalCount === 1 ? 0 : 1)
      await next.close()
    })
  }
})

test('Ruling B records the agreed outside check in Codex, Claude and zsh literal forms', async t => {
  const agreed = stage6CommandIn(checkDirectory(t))
  const codex = await nativeCheck(t, agreed)
  const variants = [
    ['codex-bare', agreed],
    ['codex-wrapped', `/bin/bash -lc '${agreed}'`],
    ['zsh-bare', `zsh -lc '${agreed}'`],
    ['zsh-bin', `/bin/zsh -lc "${agreed}"`],
    ['zsh-usr-bin', `/usr/bin/zsh -lc '${agreed}'`],
  ]
  for (const [run, command] of variants) {
    const held = await codex.mirror(`before-${run}`, { command })
    assert.equal(held.isError, true, run)
    assert.match(held.content[0].text, /Start a check run/)
    assert.match(await codex.start(run), /^Recorded\./)
    assert.equal((await codex.mirror(run, { command })).isError, false)
    assert.match(await codex.report(run), /^Recorded\./)
    assert.deepEqual(codex.bot().reviewTrack.solver.passed, ['check-a'])
  }

  const claude = await nativeCheck(t, agreed, { provider: 'acp-claude' })
  const adjust = opened => { opened.rawInput = { ...claudeBashInput, command: agreed } }
  assert.match(await claude.start('claude-bare'), /^Recorded\./)
  assert.equal((await claude.mirror('claude-bare', { adjust })).isError, false)
  assert.match(await claude.report('claude-bare'), /^Recorded\./)
  assert.deepEqual(claude.bot().reviewTrack.solver.passed, ['check-a'])

  const wrappedPlan = `/usr/bin/zsh -lc 'cd .. && fake check-a'`
  const wrapped = await nativeCheck(t, wrappedPlan)
  const absolute = `cd '${dirname(wrapped.cwd)}' && fake check-a`
  assert.equal((await wrapped.mirror('relative-before-start', { command: absolute })).isError, true)
  assert.match(await wrapped.start('relative-agreement'), /^Recorded\./)
  await wrapped.mirror('relative-agreement', { command: absolute })
  assert.match(await wrapped.report('relative-agreement'), /^Recorded\./)

  const request = await requestOf(wrapped.host)
  await assert.rejects(wrapped.host.execute('bash', { command: wrappedPlan }), /Start a check run/)
  assert.match(await checked(wrapped.host, request, 'dsh-exact', { command: wrappedPlan }), /^Recorded\./)
})

test('Ruling B refuses ambiguous plans and native outcomes outside the exact agreement', async t => {
  const directory = checkDirectory(t)
  const agreed = stage6CommandIn(directory)
  const bare = agreed.split(' && ')[1]
  const ambiguous = [
    ['chain', `${agreed} && true`],
    ['pipe', `${agreed} | cat`],
    ['redirect', `${agreed} > result.txt`],
    ['second-cd', `cd ${directory} && cd . && ${bare}`],
    ['nested', `zsh -lc "bash -lc '${agreed}'"`],
    ['wrapper-args', `bash -lc '${agreed}' extra`],
    ['malformed', `zsh -lc '${agreed}`],
    ['cdpath', `cd relative && ${bare}`],
  ]
  const host = await setup(t)
  const request = await requestOf(host)
  for (const [run, command] of ambiguous) {
    assert.match(await plan(host, request, ['check-a'], [{ check: 'check-a', command }]), /ambiguous|CDPATH/i, run)
    assert.equal(host.rt.botOf('solver').reviewTrack.solver.plan, undefined)
  }

  const h = await nativeCheck(t, agreed)
  const wrong = [
    ...ambiguous,
    ['extra-argument', `${agreed} extra`],
    ['different-cd', stage6CommandIn(checkDirectory(t))],
    ['no-cd', bare, opened => {
      opened.rawInput.cwd = directory
      opened._meta.terminal_info.cwd = directory
    }],
    ['missing-cwd', agreed, opened => {
      delete opened.rawInput.cwd
      delete opened._meta.terminal_info.cwd
    }],
    ['conflicting-cwd', agreed, opened => { opened.rawInput.cwd = directory }],
  ]
  for (const [run, command, adjust] of wrong) {
    assert.match(await h.start(run), /^Recorded\./)
    await h.mirror(run, { command, adjust })
    assert.match(await h.report(run), /^No verified passing evidence/, run)
    assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
  }
  rmSync(directory, { recursive: true })
  assert.match(await h.start('missing-directory'), /^Recorded\./)
  await h.mirror('missing-directory', { command: agreed })
  assert.match(await h.report('missing-directory'), /no verified passing evidence.*working directory/i)
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('Ruling B round 2 requires literal shell arguments in plans and native evidence', async t => {
  const invalid = [
    `bash '-c' 'fake check-a'`,
    `zsh -l"c" 'fake check-a'`,
    String.raw`/bin/sh -\c 'fake check-a'`,
    `bash -o pipefail "-c" 'fake check-a'`,
    `fish '--command=fake check-a'`,
    'fake check-a *.mjs',
    'fake check-a file?.mjs src/[ab].mjs',
    'fake check-a {one,two} ~/tests',
    'fake check-a # ignored',
  ]
  const accepted = []
  for (const command of invalid) {
    const host = await setup(t)
    const reply = await plan(host, await requestOf(host), ['check-a'], [{ check: 'check-a', command }])
    if (!/Cannot register check "check-a"\. The command boundaries are ambiguous\./.test(reply)) {
      accepted.push({ stage: 'plan', command, reply })
    }
  }

  for (const command of [invalid[0], invalid[5]]) {
    const legacy = await nativeCheck(t, command, { legacyPlan: true })
    const held = await legacy.mirror('legacy-before-start', { command })
    assert.equal(held.isError, true)
    assert.match(held.content[0].text, /Start a check run/)
    const wrapped = `/bin/bash -lc "${command}"`
    assert.match(await legacy.start('legacy-outcome'), /^Recorded\./)
    assert.equal((await legacy.mirror('legacy-outcome', { command: wrapped })).isError, false)
    const reply = await legacy.report('legacy-outcome')
    if (!/^No verified passing evidence.*command boundaries are ambiguous/.test(reply)) {
      accepted.push({ stage: 'legacy outcome', command, reply })
    }
  }

  const literal = String.raw`fake check-a "*.mjs; ? [ab]" escaped\ space \*`
  const h = await nativeCheck(t, literal)
  const wrapped = `/bin/zsh -lc '${literal}'`
  const held = await h.mirror('quoted-before-start', { command: wrapped })
  assert.equal(held.isError, true)
  assert.match(held.content[0].text, /Start a check run/)
  assert.match(await h.start('changed-quoting'), /^Recorded\./)
  await h.mirror('changed-quoting', { command: literal.replace('"*.mjs; ? [ab]"', "'*.mjs; ? [ab]'") })
  assert.match(await h.report('changed-quoting'), /observed command does not match one agreed check/)
  assert.match(await h.start('quoted'), /^Recorded\./)
  assert.equal((await h.mirror('quoted', { command: wrapped })).isError, false)
  assert.match(await h.report('quoted'), /^Recorded\./)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'])

  assert.deepEqual(accepted, [])
})

test('Done rule preserves a trailing nonbreaking space in the agreed check argument', async t => {
  const command = 'fake check-a\u00a0'
  const h = await nativeCheck(t, command)
  assert.equal(h.bot().reviewTrack.solver.plan.commands['check-a'], command)

  assert.match(await h.start('changed-argument'), /^Recorded\./)
  assert.equal((await h.mirror('changed-argument', { command: 'fake check-a' })).isError, false)
  assert.match(await h.report('changed-argument'), /observed command does not match one agreed check/)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])

  assert.match(await h.start('agreed-argument'), /^Recorded\./)
  assert.equal((await h.mirror('agreed-argument', { command })).isError, false)
  assert.match(await h.report('agreed-argument'), /^Recorded\./)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'])
})

test('Ruling B round 2 requires an initial native directory with an absolute agreed target', async t => {
  const agreed = stage6CommandIn(checkDirectory(t))
  const h = await nativeCheck(t, agreed)
  const file = join(checkDirectory(t), 'starting-cwd')
  writeFileSync(file, 'A file cannot be the shell working directory.\n')
  assert.match(await h.start('file-cwd'), /^Recorded\./)
  const result = await h.mirror('file-cwd', { command: agreed, adjust: opened => {
    opened.rawInput.cwd = file
    opened._meta.terminal_info.cwd = file
  } })
  assert.equal(result.isError, false)
  assert.match(await h.report('file-cwd'), /No verified passing evidence.*working directory could not be verified as the agreed directory/)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
})

test('MISSING_PASS records the Codex ACP check on the original result', async t => {
  const h = await nativeCheck(t)
  assert.match(await h.start('unchanged'), /Recorded/)
  const result = await h.mirror('unchanged', { command: "/bin/bash -lc 'cd . && fake check-a'" })
  assert.equal(result.isError, false)
  assert.match(await h.report('unchanged'), /Recorded/)
  assert.deepEqual(result.value.terminalOutcome, {
    sessionId: 'solver', callId: 'acp-unchanged', toolCallId: codexExecute.toolCallId,
    terminalId: codexExecute._meta.terminal_info.terminal_id, cwd: h.cwd, exitCode: 0,
  })
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'])
  assert.equal(h.bot().reviewTrack.solver.review, undefined)
  await h.send('result')
  const denied = await h.mirror('without-start')
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /Start a check run/)

  assert.match(await h.start('changed'), /Recorded/)
  const { startSnapshot, revision } = h.savedPending()
  assert.match(startSnapshot, /^[a-f0-9]{64}$/)
  const changed = await h.mirror('changed', { beforeMirror: async () => {
    writeFileSync(join(h.cwd, 'result'), 'changed before the mirror')
    assert.match(await h.start('changed'), /already open/)
  } })
  assert.equal(changed.isError, false)
  assert.equal(h.savedPending().startSnapshot, startSnapshot)
  assert.equal(h.savedPending().revision, revision)
  assert.match(await h.report('changed'), /no verified passing evidence.*changed/i)
  await assert.rejects(h.send('result'), /every agreed check/)

  assert.match(await h.start('nonzero'), /Recorded/)
  assert.equal((await h.mirror('nonzero', { exit: 1 })).isError, false)
  assert.match(await h.report('nonzero'), /contradicts.*outcome/i)
  assert.match(await h.report('nonzero', false), /Recorded/)
  await assert.rejects(h.send('result'), /every agreed check/)

  assert.match(await h.start('changed-before-report'), /Recorded/)
  await h.mirror('changed-before-report', { adjust: opened => {
    opened.rawInput = { cmd: 'fake check-a', cwd: h.cwd }
  } })
  writeFileSync(join(h.cwd, 'result'), 'changed after the mirror')
  assert.match(await h.report('changed-before-report'), /changed between the outcome and the report/i)
})

test('MISSING_PASS withholds ACP evidence for an ambiguous shell unwrap', async t => {
  const h = await nativeCheck(t)
  assert.match(await h.start('ambiguous'), /Recorded/)
  const result = await h.mirror('ambiguous', { command: "/bin/bash -lc 'fake check-a' && true" })
  assert.equal(result.isError, false)
  assert.match(await h.report('ambiguous'), /no verified passing evidence.*ambiguous/i)
  assert.match(await h.start('outside'), /Recorded/)
  await h.mirror('outside', { command: 'cd .. && fake check-a' })
  assert.match(await h.report('outside'), /no verified passing evidence.*working directory/i)
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('MISSING_PASS explains why a completed ACP card without trusted exit data cannot pass', async t => {
  const h = await nativeCheck(t)
  assert.match(await h.start('missing-exit'), /Recorded/)
  const result = await h.mirror('missing-exit', { adjust: (_opened, finished) => { delete finished._meta.terminal_exit } })
  assert.equal(result.isError, false)
  assert.equal(result.value.status, 'completed')
  assert.match(await h.report('missing-exit'), /no verified passing evidence.*exit.*missing/i)
  assert.match(await h.report('missing-exit'), /exit.*missing/i)
  for (const [run, adjust, reason] of [
    ['wrong-terminal', (_opened, finished) => { finished._meta.terminal_exit.terminal_id = 'other-terminal' }, /exit does not match/i],
    ['wrong-tool', (_opened, finished) => { finished.toolCallId = 'other-tool' }, /exit.*missing/i],
    ['wrong-session', () => 'other-session', /exit.*missing/i],
    ['interrupted', (_opened, finished) => { finished._meta.terminal_exit.signal = 'SIGTERM' }, /execution was interrupted/i],
  ]) {
    assert.match(await h.start(run), /Recorded/)
    await h.mirror(run, { adjust })
    assert.match(await h.report(run), reason)
  }
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('MISSING_PASS r2 refuses an ACP check started before its Solver run', async t => {
  const h = await nativeCheck(t)
  const resultPath = join(h.cwd, 'result')
  for (const [run, boundary] of [['completed-early', 'beforeMirror'], ['started-early', 'beforeExit']]) {
    writeFileSync(resultPath, 'result at native start')
    const result = await h.mirror(run, { [boundary]: async () => {
      writeFileSync(resultPath, 'different result at Solver start')
      assert.match(await h.start(run), /Recorded/)
      assert.match(await h.start(run), /already open/)
    } })
    assert.equal(result.isError, false)
    assert.match(await h.report(run), /no verified passing evidence.*native execution started before/i)
    assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
  }
  assert.match(await h.start('completion-only'), /Recorded/)
  await h.mirror('completion-only', { adjust: opened => {
    opened.status = 'pending'
    opened.rawInput.startedAt = Date.now()
  } })
  assert.match(await h.report('completion-only'), /no verified passing evidence.*native execution start.*missing/i)
  await assert.rejects(h.send('result'), /every agreed check/)
})

test('MISSING_PASS r2 requires a CDPATH-independent directory with only initial cwd', async t => {
  const h = await nativeCheck(t)
  const child = join(h.cwd, 'check-dir')
  mkdirSync(child)
  assert.match(await h.start('cdpath'), /Recorded/)
  assert.equal((await h.mirror('cdpath', { command: "/bin/bash -lc 'cd check-dir && fake check-a'" })).isError, false)
  assert.match(await h.report('cdpath'), /no verified passing evidence.*CDPATH/i)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
  for (const [run, operand] of [['explicit-relative', './check-dir'], ['absolute', child]]) {
    assert.match(await h.start(run), /Recorded/)
    await h.mirror(run, { command: `cd '${operand}' && fake check-a` })
    assert.match(await h.report(run), /Recorded/)
  }
})

test('MISSING_PASS r2 holds exact ACP commands before start', async t => {
  for (const [kind, command] of [['pipeline', 'fake check-a | cat'], ['wrapper', "/bin/bash -lc 'fake check-a'"]]) {
    await t.test(kind, async sub => {
      const h = await nativeCheck(sub, command, { legacyPlan: kind === 'pipeline' })
      const result = await h.mirror('without-start', { command: `  ${command}  ` })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /Start a check run/)
      if (kind === 'pipeline') {
        assert.match(await h.start('with-start'), /Recorded/)
        await h.mirror('with-start', { command })
        assert.match(await h.report('with-start'), /no verified passing evidence.*ambiguous/i)
      }
    })
  }
})

test('Stage 6 result-changed records a native check after transient root churn', async t => {
  const h = await nativeCheck(t)
  const placeholder = join(h.cwd, 'sandbox-placeholder')
  // Guarantee that the temporary entry advances the root's mtime even on fast runs.
  utimesSync(h.cwd, 1, 1)
  assert.match(await h.start('root-churn'), /Recorded/)
  const result = await h.mirror('root-churn', { beforeExit: () => {
    writeFileSync(placeholder, '')
    rmSync(placeholder)
  } })
  assert.equal(result.isError, false)
  assert.match(await h.report('root-churn'), /Recorded/)
})

test('Stage 6 result-changed refuses a native check after a result file edit', async t => {
  const h = await nativeCheck(t)
  const file = join(h.cwd, 'result')
  writeFileSync(file, 'original result')
  assert.match(await h.start('file-edit'), /Recorded/)
  const result = await h.mirror('file-edit', { beforeExit: () => {
    writeFileSync(file, 'changed result file')
  } })
  assert.equal(result.isError, false)
  assert.match(await h.report('file-edit'), /no verified passing evidence.*result changed between the start and the outcome/i)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, [])
})

test('Stage 6 full chain keeps native check and review evidence through unchanged commands and delivery', async t => {
  const churn = cwd => () => {
    const placeholder = join(cwd, '.codex')
    writeFileSync(placeholder, '')
    rmSync(placeholder)
  }
  const pass = async fixture => {
    writeFileSync(join(fixture.cwd, 'average.mjs'), 'fixed')
    assert.match(await fixture.start('pass-a'), /^Recorded\./)
    assert.equal((await fixture.mirror('pass-a', { beforeExit: churn(fixture.cwd) })).isError, false)
    assert.match(await fixture.report('pass-a'), /^Recorded\./)
    const progress = fixture.bot().reviewTrack.solver
    assert.deepEqual(progress.passed, ['check-a'])
    assert.match(progress.snapshot, /^[a-f0-9]{64}$/)
    return progress.snapshot
  }
  const h = await nativeCheck(t)
  const snapshot = await pass(h)
  const status = await h.mirror('status', { command: "/bin/bash -lc 'git status --short'", beforeExit: churn(h.cwd) })
  assert.equal(status.isError, false)
  assert.deepEqual(h.bot().reviewTrack.solver.passed, ['check-a'], 'accepted pass must survive git status before result handoff')
  assert.equal(h.bot().reviewTrack.solver.snapshot, snapshot)
  assert.match(await h.report('pass-a'), /^Recorded\./)

  await h.send('result')
  const exchangeId = h.delivered.at(-1).exchangeId
  const { host } = h
  host.agentOf('reviewer').session.requestHeader = () => ({ config: { provider: 'acp-claude', model: 'default' } })
  host.event('reviewer', 'user/message', { content: content('Review the result.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId,
  } })
  host.event('reviewer', 'turn/start', { turn: 2 })
  host.finish('reviewer', 'Verdict: SHIP\nEvidence verified.')
  const review = h.bot().reviewTrack.solver.review
  assert.equal(review.verdict, 'SHIP')
  assert.equal(review.solverModel, 'acp-codex/default')
  assert.equal(review.reviewer.model, 'acp-claude/default')

  const diff = await h.mirror('diff', { command: "/bin/bash -lc 'git diff'", beforeExit: churn(h.cwd) })
  assert.equal(diff.isError, false)
  assert.deepEqual(h.bot().reviewTrack.solver.review, review)
  host.event('solver', 'turn/start', { turn: 3 })
  host.finish('solver', 'Delivered: both reviews SHIP, checks passed.')
  assert.equal(h.bot().reviewTrack.last.done, true)
  assert.equal(h.bot().reviewTrack.last.resultExchangeId, exchangeId)
  assert.equal(h.bot().reviewTrack.delivered, true)

  const changed = await nativeCheck(t)
  await pass(changed)
  const edit = await changed.mirror('edit-by-shell', {
    command: "/bin/bash -lc 'echo x >> average.mjs'",
    beforeExit: () => writeFileSync(join(changed.cwd, 'average.mjs'), 'changed'),
  })
  assert.equal(edit.isError, false)
  await assert.rejects(changed.send('result'), /Record current passing runs for every agreed check/)
  assert.match(await changed.report('pass-a'), /stale.*start a new run/i)
  assert.deepEqual(changed.bot().reviewTrack.solver.passed, [])
  const saved = JSON.parse(readFileSync(join(changed.host.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver
  assert.deepEqual(saved.passed, [])
  assert.equal(saved.snapshot, undefined)

  await t.test('a computer-use launch invalidates passes and review at admission', async sub => {
    const launch = await nativeCheck(sub)
    await pass(launch)
    await launch.send('result')
    const { host } = launch
    const execute = host.ctx.listeners.get('tools/execute')[0]
    assert.equal(await execute({
      name: 'cua_driver_native__launch_app', arguments: { app: 'Fixture' },
      agent: host.agentOf('solver'), callId: 'launch-app',
    }, async () => {
      const progress = launch.bot().reviewTrack.solver
      assert.deepEqual(progress.passed, [])
      assert.equal(progress.review, undefined)
      return 'ran'
    }), 'ran')
  })

  await t.test('a legacy run cannot borrow a later pass at the same snapshot', async sub => {
    const legacy = await setup(sub)
    const { request } = await reviewedPlan(legacy, ['check-a'])
    const progress = () => legacy.rt.botOf('solver').reviewTrack.solver
    const replay = run => legacy.progress('checks', { request, run, results: results() })
    assert.match(await checked(legacy, request, 'legacy-a'), /^Recorded\./)
    const snapshot = progress().snapshot
    assert.equal(await legacy.execute('write', { file_path: 'out' }), 'ran')
    // Pre-upgrade invalidation kept the old report without a revision or stale marker.
    delete progress().runs['legacy-a'].revision
    delete progress().legacyRunsStale
    assert.match(await checked(legacy, request, 'current-a'), /^Recorded\./)
    assert.equal(progress().snapshot, snapshot)
    assert.match(await replay('legacy-a'), /stale.*start a new run/i)
    assert.match(await replay('current-a'), /^Recorded\./)
  })

  await t.test('a run cannot borrow a replacement pass in the same revision', async sub => {
    const retry = await setup(sub)
    const { request } = await reviewedPlan(retry)
    const progress = () => retry.rt.botOf('solver').reviewTrack.solver
    const replay = (run, check) => retry.progress('checks', { request, run, results: results(check) })
    assert.match(await checked(retry, request, 'old-a'), /^Recorded\./)
    assert.match(await checked(retry, request, 'current-b', { check: 'check-b' }), /^Recorded\./)
    const { revision, snapshot } = progress()
    assert.match(await runCheck(retry, request, 'unverified-a', true), /no verified passing evidence/i)
    assert.deepEqual(progress().passed, ['check-b'])
    assert.match(await replay('old-a'), /stale.*start a new run/i)
    assert.match(await checked(retry, request, 'current-a'), /^Recorded\./)
    assert.equal(progress().revision, revision)
    assert.equal(progress().snapshot, snapshot)
    assert.match(await replay('old-a'), /stale.*start a new run/i)
    assert.match(await replay('current-a'), /^Recorded\./)
    assert.match(await replay('current-b', 'check-b'), /^Recorded\./)
  })
})

test('LA-1 requires completed passing evidence on the same result', async t => {
  const h = await setup(t)
  const { request, send } = await reviewedPlan(h)
  assert.match(await h.progress('plan', {
    request, checks: ['check-a'], commands: [{ check: 'different', command: 'fake check-a' }],
  }), /one command for each agreed check ID/)
  await h.progress('start', { request, run: 'unexecuted', checks: ['check-a'] })
  const unexecuted = await h.progress('checks', { request, run: 'unexecuted', results: results() })
  assert.match(unexecuted, /no verified passing evidence/i)
  assert.match(await checked(h, request, 'wrong-command', { command: 'unrelated successful command' }), /no verified passing evidence/i)
  await assert.rejects(send('result'), /every agreed check/)
})

test('LA-1 a regenerating check invalidates the earlier pass', async t => {
  const h = await setup(t)
  const { request, send } = await reviewedPlan(h)
  assert.match(await checked(h, request, 'first-a'), /Recorded/)
  await checked(h, request, 'rewrites', { check: 'check-b',
    work: cwd => writeFileSync(join(cwd, 'out'), 'regenerated') })
  await assert.rejects(send('result'), /every agreed check/)
  assert.match(await checked(h, request, 'current-a'), /Recorded/)
  assert.match(await checked(h, request, 'current-b', { check: 'check-b' }), /Recorded/)
  await send('result')
})

test('LA-1 rejects a pass that contradicts the executed check', async t => {
  const h = await setup(t)
  const { request, send } = await reviewedPlan(h, ['check-a'])
  await h.progress('start', { request, run: 'nonzero', checks: ['check-a'] })
  const cwd = h.rt.botOf('solver').workDir
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command: 'fake check-a' }, agent: h.agentOf('solver'), callId: 'nonzero',
  }, async () => ({ isError: false, value: { kind: 'foreground', cwd, exitCode: 1, signal: null, timedOut: false, aborted: false } }))
  assert.match(await h.progress('checks', { request, run: 'nonzero', results: results() }), /contradicts.*outcome/i)
  assert.match(await h.progress('checks', { request, run: 'nonzero', results: results('check-a', false) }), /Recorded/)
  await assert.rejects(send('result'), /every agreed check/)
})

test('LA-2 an undelivered designation can be retried after restart', async t => {
  let h = await setup(t)
  const request = await requestOf(h)
  await plan(h, request)
  const send = () => h.tool('message_bot', { to: 'reviewer', message: 'Review the plan.',
    solver_review: 'plan', solver_request: request, reply_to: 'me' })
  h.rt.attachLong = async () => undefined
  assert.equal((await send()).sent, false)
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  const messages = []
  const deliver = h.rt.deliver
  h.rt.deliver = async message => { messages.push(message); return deliver(message) }
  assert.match(await send(), /Delivered|Queued/)
  assert.equal(messages.length, 1)
  await assert.rejects(send(), /already waiting/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan.review.exchangeId, messages[0].exchangeId)
})

test('LA-3 a reply to another Bot leaves the person budget open', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  await h.progress('replan', { request, run: 'first' })
  await h.botMessage()
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Reply to the other Bot.')
  h.person('Continue my task.')
  assert.equal(await requestOf(h), request)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.replans, 1)
})

test('LA-3 a failed card release leaves the decision retryable', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  await plan(h, request)
  assert.match(await runCheck(h, request, 'failed-once', false), /Recorded/)
  for (const run of ['one', 'two', 'three']) await h.progress('replan', { request, run })
  await h.tool('ask_user', { question: 'Which input?', options: [{ label: 'Use it' }] }, 'solver', 'question')
  const card = h.rt.state.questions.solver
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = async () => { throw new Error('Fixture release save failed') }
  await assert.rejects(h.rt.answerQuestion('solver', card.id, { selected: ['Use it'] }), /release save failed/)
  assert.equal(h.rt.state.questions.solver, card)
  assert.equal(h.agentOf('solver').message, undefined)
  h.rt.saveCopy = saveCopy
  await h.rt.answerQuestion('solver', card.id, { selected: ['Use it'] })
  const progress = h.rt.botOf('solver').reviewTrack.solver
  assert.equal(progress.replans, 0)
  assert.equal(progress.attempts['check-a'], 1)
})

test('LA-5 mediated retries require an open run and ordinary plan work stays available', async t => {
  const h = await setup(t)
  const { request } = await reviewedPlan(h, ['check-a'])
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
  assert.match(await checked(h, request, 'first', { exitCode: 1 }), /Recorded/)
  assert.match(await h.progress('checks', { request, run: 'first', results: results('check-a', false) }), /Recorded/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.attempts['check-a'], 1)
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
})

test('Stage 6 ACP requires an open run for an exact agreed command after trimming', async t => {
  const h = await setup(t, { reviewGuard: true })
  await reviewedPlan(h, ['check-a'])
  await assert.rejects(h.execute('bash', { command: '  fake check-a\n' }), /start.*run/i)
  await assert.rejects(h.execute('acp_tool', { kind: 'execute', title: 'Run tests', input: { command: '  fake check-a\n' } }), /start.*run/i)
  assert.equal(await h.execute('acp_tool', { kind: 'execute', input: { command: 'fake  check-a' } }), 'ran')
})

test('Stage 6 ACP allows ordinary commands after plan SHIP', async t => {
  const h = await setup(t, { reviewGuard: true })
  await reviewedPlan(h, ['check-a'])
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan.accepted, true)
  assert.equal(await h.execute('bash', { command: 'git status' }), 'ran')
  assert.equal(await h.execute('acp_tool', { kind: 'execute', title: 'fake check-a', input: { cmd: 'git status' } }), 'ran')
  assert.equal(await h.execute('acp_tool', { kind: 'execute', title: 'fake check-a', input: null }), 'ran')
})

test('T3 Stage 6 ACP says the native command may already have run and keeps confirmed refusal counts separate', async t => {
  const h = await setup(t, { reviewGuard: true })
  await reviewedPlan(h, ['check-a'])
  h.event('solver', 'turn/start', { turn: 1 })
  const mirror = { kind: 'execute', title: 'Run tests', input: { cmd: 'fake check-a' } }
  await assert.rejects(h.execute('acp_tool', mirror), /start.*run/i)
  const [single] = h.rt.stopsView()
  assert.equal(single.why, 'solver-run')
  assert.equal(single.mayHaveRun, true)
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
  await assert.rejects(h.execute('acp_tool', mirror), /start.*run/i)
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /start.*run/i)
  const stops = h.rt.stopsView()
  assert.deepEqual(stops.map(({ why, count, mayHaveRun }) => [why, count, mayHaveRun === true]), [
    ['solver-run', 2, true], ['solver-run', 2, false],
  ])
  const english = [
    `acp_tool may already have run (${wantedCopy.start})`,
    `2 steps may already have run (${wantedCopy.start})`,
    `2 steps did not run: ${wantedCopy.start}`,
  ]
  assert.equal(h.rt.stopLineOfTurn('solver', 1), english.slice(1).join(' · '))
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  for (const [dictionary, expected] of [[{}, english], [pt, [
    'acp_tool pode já ter sido executada (o Solver precisa iniciar uma rodada de verificação com solver_progress)',
    '2 etapas podem já ter sido executadas (o Solver precisa iniciar uma rodada de verificação com solver_progress)',
    '2 etapas não foram executadas: o Solver precisa iniciar uma rodada de verificação com solver_progress',
  ]], [DICTIONARY.zh, [
    'acp_tool 可能已执行（Solver 需要用 solver_progress 启动检查）',
    '2 个步骤可能已执行（Solver 需要用 solver_progress 启动检查）',
    '2 个步骤未执行：Solver 需要用 solver_progress 启动检查',
  ]]]) {
    const dispose = installLocale({ register: () => () => {}, bind: () => (key, params) =>
      (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match) })
    try {
      assert.deepEqual([single, ...stops].map(stopLine), expected)
    } finally {
      dispose()
    }
  }
})

test('T3 progress-write and pending-run stops tell the Solver to finish recording', async t => {
  const h = await setup(t, { reviewGuard: true }, 2)
  const { request } = await reviewedPlan(h, ['check-a'])
  h.rt.solverProgressBusy = () => true
  await assert.rejects(h.execute('bash', { command: 'fake check-a' }), /Finish recording the current Solver progress/)
  h.rt.solverProgressBusy = () => false
  assert.match(await h.progress('start', { request, run: 'pending', checks: ['check-a'] }), /^Recorded\./)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /Finish recording the current Solver progress/)
  const [stop] = h.rt.stopsView()
  assert.equal(stop.why, 'solver-progress')
  assert.equal(stop.count, 2)
  assert.equal(h.rt.stopLineOfTurn('solver', 2), `2 steps did not run: ${wantedCopy.pending}`)
  for (const [dictionary, expected] of [
    [{}, `2 steps did not run: ${wantedCopy.pending}`],
    [PT_BR, '2 etapas não foram executadas: o Solver precisa terminar de registrar o progresso atual com solver_progress'],
    [DICTIONARY.zh, '2 个步骤未执行：Solver 需要用 solver_progress 完成当前进度记录'],
  ]) {
    const dispose = installLocale({ register: () => () => {}, bind: () => (key, params) =>
      (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match) })
    try { assert.equal(stopLine(stop), expected) } finally { dispose() }
  }
})

test('H6 generic rule stops keep their existing copy', async t => {
  const h = await setup(t, {}, 2)
  h.rt.noteStop('solver', { why: 'rule', tool: 'read' })
  assert.equal(h.rt.stopsView()[0].why, 'rule')
  assert.equal(h.rt.stopLineOfTurn('solver', 2), 'read did not run: a rule here refused it')
  assert.equal(whyText('rule'), 'a rule here refused it')
})

test('LA-5 a person message during durable progress preserves its count', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = (change, options) => saveCopy(change, { ...options, afterPublish: () => h.person('Keep going.') })
  assert.match(await h.progress('replan', { request, run: 'overlap' }), /Recorded/)
  h.rt.saveCopy = saveCopy
  await h.rt.save({ required: true, durable: true })
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.replans, 1)
  assert.equal(JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver.replans, 1)
})

test('Normal holds the fourth failure and deduplicates the run', async t => {
  const marker = scopedReadMarker(t)
  const h = await setup(t, { workDir: dirname(marker) })
  const request = await requestOf(h)
  assert.ok(request)
  await plan(h, request)
  for (const [run, pass] of [['one', false], ['two', false], ['pass', true], ['three', false]]) {
    assert.match(await checked(h, request, run, { exitCode: pass ? 0 : 1 }), /Recorded/)
  }
  assert.match(await h.progress('checks', { request, run: 'three', results: [{ check: 'check-a', pass: false }] }), /Recorded/)
  assert.match(await checked(h, request, 'four', { exitCode: 1 }), /failed after 3 fix attempts/)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /exact decision/)
  assert.equal(await h.execute('read', { file_path: marker }), 'ran')
  h.person('Use the new input.')
  await h.rt.save({ required: true })
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
})

test('Only a current affirmative person instruction enables request Auto', async t => {
  const h = await setup(t)
  const request = await requestOf(h)
  for (const text of ['Do not work alone until delivered.', 'Example: "work alone until delivered".']) {
    h.person(text)
    assert.match(await h.progress('auto', { request, quote: 'work alone until delivered' }), /own words/)
  }
  h.person('Work alone until delivered.')
  assert.match(await h.progress('auto', { request, quote: 'Work alone until delivered.' }), /Recorded/)
  await plan(h, request)
  for (let i = 0; i < 10; i++) assert.match(await runCheck(h, request, `run-${i}`, false), /Recorded/)
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Outcome with unresolved checks.')
  h.event('solver', 'turn/start', { turn: 2 })
  assert.match(h.rt.roleRuntime.prompt('solver', h.agentOf('solver')), /Limits: 3 fix attempts/)
})

test('Skills loads are reads under the Solver attempt hold and preserve check evidence', async t => {
  for (const name of ['load_skill', 'mcp__dsh__load_skill']) {
    await t.test(name, async sub => {
      const h = await setup(sub, { reviewGuard: true })
      const { request, send, verdict, delivered } = await reviewedPlan(h, ['check-a'])
      assert.match(await checked(h, request, 'skill-read-pass'), /^Recorded\./)
      await send('result')
      verdict(delivered.at(-1).exchangeId)
      const bot = h.rt.botOf('solver')
      const progress = () => bot.reviewTrack.solver
      const before = structuredClone(progress())
      assert.deepEqual(before.passed, ['check-a'])
      assert.equal(before.review.verdict, 'SHIP')

      progress().limit = { kind: 'replan', at: bot.reviewTrack.requestAt }
      const reads = { relevant: false, checkCommand: false, compareResult: false }
      for (const read of ['recall', 'solver_progress']) {
        const { relevant, checkCommand, compareResult } = h.rt.solverCall(bot, read, {})
        assert.deepEqual({ relevant, checkCommand, compareResult }, reads, read)
        assert.equal(await h.execute(read, {}), 'ran', read)
      }
      for (const [work, args] of [
        ['remember', {}], ['write', { file_path: 'out' }], ['bash', { command: 'fake work' }],
      ]) {
        assert.equal(h.rt.solverCall(bot, work, args).relevant, true, work)
        await assert.rejects(h.execute(work, args), /attempt limit/, work)
      }

      const args = { name: 'planning-notes' }
      const { relevant, checkCommand, compareResult } = h.rt.solverCall(bot, name, args)
      const underLimit = await h.execute(name, args).catch(error => error.message)
      const afterHeldRead = structuredClone(progress())
      delete afterHeldRead.limit
      delete progress().limit
      assert.equal(await h.execute(name, args), 'ran')
      assert.deepEqual({
        classification: { relevant, checkCommand, compareResult },
        underLimit,
        passed: progress().passed,
        verdict: progress().review?.verdict,
      }, { classification: reads, underLimit: 'ran', passed: ['check-a'], verdict: 'SHIP' })
      assert.deepEqual(afterHeldRead, before)
      assert.deepEqual(progress(), before)
    })
  }
})

test('The attempt hold survives Bot traffic, a role change and a restart until its question is answered', async t => {
  const marker = scopedReadMarker(t)
  let h = await setup(t, { reviewGuard: true, workDir: dirname(marker) })
  const request = await requestOf(h)
  for (const run of ['one', 'two']) assert.match(await h.progress('replan', { request, run }), /Recorded/)
  assert.match(await h.progress('replan', { request, run: 'two' }), /Recorded/)
  assert.match(await h.progress('replan', { request, run: 'three' }), /3rd re-plan/)
  const bot = h.rt.botOf('solver')
  const track = bot.reviewTrack
  h.rt.openWork('review-old', { from: bot.id, to: 'reviewer' })
  answerSender(h.rt, 'reviewer', { exchangeId: 'review-old', senderSessionId: bot.id }, 'SHIP')
  for (const name of ['write', 'edit', 'bash', 'create_bot', 'remember', 'subagent']) {
    await assert.rejects(h.execute(name, { file_path: 'out' }), /attempt limit/)
  }
  for (const [name, args] of [['read', { file_path: marker }], ['ask_user', {}], ['solver_progress', {}],
    ['write', { file_path: '.solver/notes.md' }], ['message_bot', { to: 'reviewer' }]]) {
    assert.equal(await h.execute(name, args), 'ran', name)
  }
  const guard = h.ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'reviewGuardGate')
  const exec = { name: 'mcp__dsh__write', arguments: { file_path: 'out' }, agent: h.agentOf('solver'), callId: 'step' }
  assert.equal((await guard(exec, () => ({ kind: 'allow' }))).kind, 'deny')
  const child = h.agentOf('child')
  child.session.header = { ...child.session.header, origin: 'subagent', parentSession: 'solver', delegationDepth: 1 }
  const ask = request => h.ctx.listeners.get('approval/request').at(-1)(request, () => 'allowed')
  assert.equal(await ask({ toolName: 'acp_tool', callId: 'native', agent: child, mirrorCall: { kind: 'edit', title: 'Write' } }), 'rejected')
  const bridge = { toolName: 'write', callId: 'bridge', agent: child, bridgeCall: {} }
  assert.equal(await ask(bridge), 'rejected')
  assert.match(bridge.bridgeCall.refused.reason, /exact decision/)
  assert.match(await h.progress('status', {}, 'other'), /Only a Solver/)
  h.rt.state.rooms.room = { id: 'room', members: [bot.id], sessions: { [bot.id]: 'group-solver' } }
  h.rt.indexSessions()
  try {
    assert.match(await h.progress('status', {}, 'group-solver'), /Only a Solver/)
  } finally {
    delete h.rt.state.rooms.room
    h.rt.indexSessions()
  }
  await h.tool('ask_user', { question: 'Example: work alone until delivered?', options: [{ label: 'Use the input' }] }, bot.id, 'question')
  await h.botMessage()
  h.event(bot.id, 'user/message', { content: content('Work alone until delivered.'), source: { kind: 'user', resumed: true } })
  h.finish(bot.id, 'I need the decision.')
  assert.equal(bot.reviewTrack.solver.request, track.solver.request)
  assert.equal(bot.reviewTrack.last, undefined)
  assert.equal(bot.reviewTrack.solver.replans, 3)
  bot.role = 'Helper'
  await h.rt.save({ required: true })
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  assert.equal(await requestOf(h), request)
  const saved = h.rt.botOf(bot.id)
  const storedCard = h.rt.state.questions[bot.id]
  assert.ok(storedCard)
  const stale = questionReply({ ...storedCard, callId: 'stale' }, { selected: ['Use the input'] })
  h.event(bot.id, 'user/message', { ...stale, content: content(stale.text) })
  await assert.rejects(h.execute('write', { file_path: 'out' }), /attempt limit/)
  await h.rt.answerQuestion(bot.id, storedCard.id, { selected: ['Use the input'] })
  const answer = h.agentOf(bot.id).message
  h.event(bot.id, 'user/message', answer)
  await h.rt.save({ required: true })
  assert.equal(saved.reviewTrack.solver.replans, 0)
  assert.equal(saved.reviewTrack.solver.limit, undefined)
  assert.match(await h.progress('auto', { request, quote: 'work alone until delivered' }), /own words/)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /review guard holds/)
  assert.equal((await h.call('update-bot', { id: bot.id, solverAuto: true })).ok, true)
  await assert.rejects(h.execute('write', { file_path: 'out' }), /review guard holds/)
})

test('Only current complete checks and an independent designated SHIP mark Done', async t => {
  const h = await setup(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => ++now)
  const request = await requestOf(h)
  const bot = h.rt.botOf('solver')
  bot.reviewTrack.requestAt = Date.now()
  const deliveries = []
  const deliver = h.rt.deliver
  h.rt.deliver = async message => { deliveries.push(message); return deliver(message) }
  const review = async kind => {
    await h.tool('message_bot', { to: 'reviewer', message: 'Please verify this evidence.',
      solver_review: kind, solver_request: request, reply_to: 'me' })
    return deliveries.at(-1).exchangeId
  }
  const verdict = (exchangeId, text, model = refOf(reviewerModel)) => answerSender(h.rt, 'reviewer', {
    exchangeId, senderSessionId: 'solver',
  }, text, undefined, undefined, model)
  await plan(h, request)
  const planExchange = await review('plan')
  assert.match(deliveries.at(-1).text, /Agreed check IDs: check-a, check-b/)
  assert.match(deliveries.at(-1).text, /Agreed check commands: \{"check-a":"fake check-a","check-b":"fake check-b"\}/)
  verdict(planExchange, 'SHIP')
  await h.progress('start', { request, run: 'native', checks: ['check-a'] })
  const mirror = { id: 'child-a', kind: 'execute', title: 'Run check', input: { command: 'fake check' } }
  const agent = h.agentOf('solver')
  const executeHook = h.ctx.listeners.get('tools/execute')[0]
  assert.equal(await executeHook({ name: 'acp_tool', arguments: mirror, agent, callId: 'native' }, async () => {
    assert.equal(await h.rt.reviewGuardAsk({ toolName: 'acp_tool', mirrorCall: mirror, agent, callId: 'parent' }), undefined)
    const otherChild = { ...mirror, id: 'child-b' }
    const held = await h.rt.reviewGuardAsk({ toolName: 'acp_tool', mirrorCall: otherChild, agent, callId: 'parent' })
    assert.match(held.text, /Finish recording/)
    assert.equal(otherChild.refused.reason, held.text)
    assert.match(await h.progress('checks', { request, run: 'native', results: [{ check: 'check-a', pass: true }] }), /finish/)
    return 'ran'
  }), 'ran')
  await h.progress('checks', { request, run: 'native', results: [{ check: 'check-a', pass: true }] })
  await h.progress('start', { request, run: 'incomplete', checks: ['check-a', 'check-b'] })
  assert.match(await h.progress('checks', { request, run: 'incomplete', results: [{ check: 'check-a', pass: false }] }), /every check/)
  assert.equal(Object.keys(bot.reviewTrack.solver.attempts).length, 0)
  assert.match(await h.progress('replan', { request, run: 'too-soon' }), /Record the open run/)
  assert.equal(await h.execute('bash', { command: 'fake check' }), 'ran')
  await assert.rejects(h.execute('bash', { command: 'fake second attempt' }), /Finish recording/)
  await h.progress('checks', { request, run: 'incomplete', results: [{ check: 'check-a', pass: false }, { check: 'check-b', pass: true }] })
  await checked(h, request, 'pass-a')
  await assert.rejects(review('result'), /every agreed check/)
  await checked(h, request, 'pass-b', { check: 'check-b' })
  await checked(h, request, 'new-failure', { exitCode: 1 })
  await assert.rejects(review('result'), /every agreed check/)
  await checked(h, request, 'repass-a')
  await checked(h, request, 'repass-b', { check: 'check-b' })
  let exchange = await review('result')
  h.rt.openWork('late-plan', { from: 'solver', to: 'reviewer' })
  verdict('late-plan', 'SHIP')
  assert.equal(bot.reviewTrack.solver.review.verdict, undefined)
  verdict(exchange, 'SHIP', refOf(solverModel))
  assert.equal(bot.reviewTrack.solver.review.verdict, 'unverified')
  assert.equal(bot.reviewTrack.solver.review.unverified, 'same')
  exchange = await review('result')
  verdict(exchange, '> SHIP')
  assert.equal(bot.reviewTrack.solver.review.verdict, 'unverified')
  exchange = await review('result')
  verdict(exchange, 'FIX-FIRST')
  assert.equal(bot.reviewTrack.solver.review.verdict, 'FIX-FIRST')
  exchange = await review('result')
  verdict(exchange, 'SHIP')
  await h.execute('mcp__dsh__write', { file_path: 'out' })
  assert.equal(bot.reviewTrack.solver.review, undefined)
  await checked(h, request, 'final-a')
  await checked(h, request, 'final-b', { check: 'check-b' })
  exchange = await review('result')
  h.event('reviewer', 'user/message', { content: content('Review the agreed checks.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId: exchange,
  } })
  h.event('reviewer', 'turn/start', { turn: 2 })
  h.finish('reviewer', 'SHIP\nEvidence verified.')
  h.event('solver', 'turn/start', { turn: 3 })
  h.finish('solver', 'Reviewed delivery.')
  const mark = bot.reviewTrack.last
  assert.equal(mark.done, true)
  assert.deepEqual(mark.reviewer, { id: 'reviewer', name: 'reviewer', model: refOf(reviewerModel) })
  h.rt.botOf('reviewer').name = 'Renamed'
  const displayed = reviewMarkText({ ...bot, reviewMark: mark }, { byId: h.rt.state.bots })
  assert.match(displayed, /every check passed and reviewer approved/)
  assert.doesNotMatch(displayed, /result unreviewed/i)
  assert.equal(displayed, 'Plan and result reviewed by reviewer.\nDone: every check passed and reviewer approved.')
})

test('Auto setting permissions, Bot-started requests, and written method delivery', async t => {
  let h = await setup(t, { role: '', instructions: solverInstructions(), permission: 'full' })
  let request = await requestOf(h)
  const normal = h.rt.roleRuntime.prompt('solver', h.agentOf('solver'))
  assert.equal(normal.match(/3 fix attempts/g)?.length, 1)
  assert.equal(h.rt.roleRuntime.instructionsFor('solver', h.rt.botOf('solver')), solverInstructions())
  assert.equal(h.identity('solver').rolePrompt, normal)
  assert.equal(h.identity('solver').solverLimitsPrompt, normal)
  assert.match(solverAutoView({ role: 'Solver', model: 'acp-omp/default', nativeTools: true, nativeToolsAgent: 'acp-omp' }, {}, 'ask').lines.join(' '), /prompt-only/)
  assert.match(solverAutoView({ role: 'Solver' }, {}, 'full').lines.join(' '), /prompt-only/)
  for (const name of ['create_bot', 'update_bot']) {
    await assert.rejects(h.tool(name, { name: 'Other', role: 'Solver', instructions: 'Fake.', solverAuto: true }), /Only the person/)
  }
  assert.equal((await h.call('update-bot', { id: 'solver', solverAuto: true, role: 'Solver' })).ok, false)
  assert.equal((await h.call('update-bot', { id: 'other', solverAuto: true })).ok, false)
  const copySave = h.rt.saveCopy
  h.rt.saveCopy = async () => { throw new Error('Fixture storage refused write') }
  await assert.rejects(plan(h, request), /storage refused/)
  assert.equal(h.rt.botOf('solver').reviewTrack.solver.plan, undefined)
  h.rt.saveCopy = copySave
  h.person('Work alone until delivered.')
  await h.rt.save({ required: true })
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  assert.match(await h.progress('auto', { request, quote: 'Work alone until delivered.' }), /own words/)
  // A delivery with no checks stays unmarked; its next Bot request has no Auto authority.
  h.person('Continue the task.')
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Unable to finish.')
  const solver = h.rt.botOf('solver')
  assert.equal(solver.reviewTrack.last.done, undefined)
  assert.equal(solver.reviewTrack.outcome.reason, 'checks')
  await h.botMessage()
  assert.notEqual(await requestOf(h), request)
  request = await requestOf(h)
  h.person('Work alone until delivered.')
  assert.match(await h.progress('auto', { request, quote: 'Work alone until delivered.' }), /came from a Bot/)
  assert.equal((await h.call('update-bot', { id: 'solver', solverAuto: true })).ok, true)
  assert.match(h.rt.roleRuntime.prompt('solver', h.agentOf('solver')), /Auto is on/)
  await plan(h, request, ['check-a'])
  for (let i = 0; i < 10; i++) assert.match(await runCheck(h, request, `run-${i}`, false), /Recorded/)
  assert.equal(await h.execute('write', { file_path: 'out' }), 'ran')
})

test('Native omp accepts direct person Auto while the host withholds Done without review evidence', async t => {
  const h = await setup(t, { model: 'acp-omp/default', reviewerId: undefined })
  h.person('Work alone until delivered.')
  await h.rt.save({ required: true })
  assert.match(await h.progress('status'), /Mode: Auto/)
  h.event('solver', 'turn/start', { turn: 1 })
  h.finish('solver', 'Outcome with a check the host cannot verify.')
  const track = h.rt.botOf('solver').reviewTrack
  assert.equal(track.last.review, 'fresh')
  assert.equal(track.last.done, undefined)
})

const configuredSolver = 'acp-codex/gpt-6-sol'
const configuredReviewer = 'acp-claude/claude-sonnet-5-5'
const wireFixture = fileURLToPath(new URL('./fixtures/solver-identity-acp.mjs', import.meta.url))

async function pickDialogModel(node, provider, label, withLevel) {
  const component = node.type(node.props)
  const menu = mount(component.type, component.props)
  const find = predicate => {
    // A stand-in DOM anchor lets the actual menu mount its portal.
    const attach = tree => all(tree, child => child.props?.ref && Object.hasOwn(child.props.ref, 'current'))
      .forEach(({ props }) => { props.ref.current ??= { contains: () => false, getBoundingClientRect: () => ({ width: 100, right: 400, top: 150, bottom: 180 }) } })
    attach(menu.render())
    const tree = menu.render()
    const step = all(tree, child => child.type?.name === 'ModelSteps')[0]
    return all(step ? step.type(step.props) : tree, predicate)
  }
  find(child => child.props?.className === 'bt-model-trigger')[0].props.onClick({})
  find(child => child.props?.['data-route'] === 'acp')[0].props.onClick()
  find(child => child.props?.key === provider)[0].props.onClick()
  const rows = find(child => child.props?.role === 'menuitemradio' && text(child) === label)
  assert.equal(rows.length, 1)
  rows[0].props.onClick()
  await immediate()
  if (withLevel) find(child => child.props?.role === 'menuitemradio' && text(child) === 'Default')[0]?.props.onClick()
  return rows[0].props.title
}

function wireHost(t, home = mkdtempSync(join(tmpdir(), 'solver-pin-wire-')), acknowledgement = 'selected', configure, codexAcknowledgement = 'selected') {
  const traces = Object.fromEntries(['acp-claude', 'acp-codex'].map(provider => [provider, join(home, provider + '.jsonl')]))
  for (const path of Object.values(traces)) writeFileSync(path, '')
  const connector = (provider, ack) => {
    const path = join(home, provider + '.mjs')
    writeFileSync(path, `process.argv.splice(2, Infinity, ...${JSON.stringify([traces[provider], provider, ack])}); await import(${JSON.stringify(wireFixture)});\n`)
    return path
  }
  const connectors = {
    '@agentclientprotocol/claude-agent-acp': connector('acp-claude', acknowledgement),
    '@agentclientprotocol/codex-acp': connector('acp-codex', codexAcknowledgement),
  }
  let adapter
  let serial = 0
  const selections = []
  const h = fixture(t, home, { configure(ctx, agentOf) {
    ctx.workspaceRegistry.resolveByPath = () => undefined
    ctx.workspaceRegistry.register = async () => ({ id: 'team' })
    ctx.sessionController.create = async () => ({ sessionId: `wire-bot-${++serial}` })
    ctx.sessionController.selectModel = async ({ sessionId, provider, model }) => {
      selections.push({ sessionId, provider, model })
      agentOf(sessionId).session.requestHeader = () => ({ config: { provider, model } })
    }
    ctx.agents = { get: id => {
      const agent = agentOf(id)
      agent.ctx.tools.register ??= () => () => {}
      return agent
    }, list: () => [] }
    ctx.llm.listProviders = () => ctx.adapters?.at(-1)?.routes.map(id => ({ id, name: id })) ?? []
    ctx.llm.listModels = (provider) => adapter.listModels(provider)
    ctx.llm.resolveModelInfo = (provider, model) => adapter.resolveModel(provider, model)
    applyAcp(ctx, { dshTools: false }, {
      store: { binOf: pkg => connectors[pkg] ? { path: connectors[pkg], version: '1.0.0' } : undefined, update: async () => {} },
      find: name => ['claude', 'codex'].includes(name) ? '/bin/false' : undefined,
      signedIn: async () => true,
    })
    adapter = ctx.adapters?.at(-1)?.adapter
    ctx.acpAgents = ctx.provided.get('acpAgents')
    // The fake adapters run without native tool launch settings.
    ctx.acpAgents.botIdentity = () => () => {}
    configure?.(ctx, agentOf)
  } })
  const wire = provider => readFileSync(traces[provider], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { h, adapter, wire, selections }
}

async function dialogWire(t, acknowledgement, reviewerLabel = 'Sonnet 5.5', {
  solverRef = configuredSolver, solverLabel = 'GPT-6 Sol', existingReviewer,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'solver-dialog-wire-'))
  const cwd = mkdtempSync(join(tmpdir(), 'solver-dialog-project-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const { h, adapter, wire } = wireHost(t, home, acknowledgement)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  await h.rt.load()
  h.rt.state.reviewGuardMigrated = true
  h.rt.state.prefs.roles = false
  // Keep bootstrap from creating an unrelated Main Bot.
  h.rt.state.mainBotIds = ['main']
  h.rt.state.bots.main = { id: 'main', name: 'Main', createdAt: 1 }
  if (existingReviewer) {
    h.rt.state.bots.reviewer = { id: 'reviewer', name: 'Existing reviewer', role: 'Reviewer', model: existingReviewer, createdAt: 1 }
  }
  await h.rt.save({ required: true })
  const rows = await h.rt.catalog({ fresh: true })
  assert.ok(rows.some(row => row.ref === solverRef), JSON.stringify(rows))
  const roster = { bots: Object.values(h.rt.state.bots), mainBotIds: ['main'], models: rows, prefs: { roles: false } }
  const creates = []
  const failures = []
  let solver
  const action = async (endpoint, payload) => {
    const response = await h.call(endpoint, payload)
    if (!response.ok) {
      failures.push(response.error)
      throw response.error
    }
    return response.value
  }
  const actions = {
    pets: async () => [],
    createBot: async payload => {
      creates.push({ payload, bot: await action('create-bot', payload) })
      return creates.at(-1).bot
    },
    deleteBot: id => action('delete-bot', { id }),
    teamState: () => ({ bots: [] }),
    send: async (id, value) => h.person(value, id),
  }
  const dialog = mount(NewSolver, { roster, actions, brief: 'Do the task.', onBack() {}, onCreated: bot => { solver = bot } })
  const find = predicate => all(dialog.render(), predicate)[0]
  const picker = id => find(node => node.props?.bot?.id === id && typeof node.props.onPick === 'function')
  // Keep the project on a real scratch directory so the agreed check can verify its snapshot.
  find(node => node.type?.name === 'FolderMenu').props.onPick(cwd)
  const solverRow = await pickDialogModel(picker('new-bot'), solverRef.split('/')[0], solverLabel, true)
  find(node => node.type === 'select').props.onChange({ target: { value: existingReviewer ? 'bot:reviewer' : 'new' } })
  const reviewerRow = existingReviewer ? undefined : await pickDialogModel(picker('new-reviewer'), 'acp-claude', reviewerLabel, false)
  const create = find(node => node.type === 'button' && node.props.className?.includes('bt-create-go'))
  assert.equal(Boolean(create.props.disabled), false, text(dialog.render()))
  create.props.onClick()
  await until(() => solver || failures.length || find(node => node.props?.role === 'alert') || find(node => node.type === 'button' && text(node) === 'Done'))
  assert.deepEqual(failures, [])
  if (!solver) find(node => node.type === 'button' && text(node) === 'Done')?.props.onClick()
  assert.ok(solver, text(dialog.render()))
  const reviewer = existingReviewer ? h.rt.botOf('reviewer') : creates.find(entry => entry.payload.role === 'Reviewer').bot
  const bot = h.rt.botOf(solver.id)
  const agent = id => h.agentOf(id)
  const progress = (kind, args = {}) => h.progress(kind, args, solver.id)
  const prompt = async (id, input, reasoningEffort) => {
    const ref = h.rt.botOf(id).model
    const slash = ref.indexOf('/')
    const provider = ref.slice(0, slash)
    const model = ref.slice(slash + 1)
    agent(id).session.requestHeader = () => ({ config: { provider, model } })
    const messages = [{ role: 'user', content: input.content, source: input.source }]
    const chunks = []
    for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, reasoningEffort, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
    return { chunks, text: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text ?? '').join('') }
  }
  return { h, bot, solver, reviewer, solverRow, reviewerRow, creates, wire, agent, progress, prompt, adapter, cwd, solverRef }
}

async function dialogResult(f, { beforeReply, takeResult = true, resultEffort } = {}) {
  const { h, bot, solver, reviewer, progress, agent } = f
  h.event(solver.id, 'turn/start', { turn: 2 })
  const opening = await f.prompt(solver.id, { content: content('Do the task.'), source: { kind: 'user' } })
  assert.equal(bot.model, f.solverRef)
  assert.match(opening.text, /SHIP/, JSON.stringify({ model: bot.model, row: f.solverRow, chunks: opening.chunks }))
  const request = /^Request: ([\w-]+)/.exec(await progress('status'))?.[1]
  assert.ok(request)
  const check = 'average-test'
  const command = 'node --test average.test.mjs'
  assert.match(await progress('plan', { request, checks: [check], commands: [{ check, command }] }), /^Recorded\./)
  const deliveries = []
  const deliver = h.rt.deliver
  h.rt.deliver = (message, options) => {
    const sent = deliver(message, options)
    deliveries.push({ message, sent })
    return sent
  }
  const review = async (kind, turn) => {
    await h.tool('message_bot', { to: reviewer.id, message: `Review the ${kind}.`, solver_review: kind, solver_request: request, reply_to: 'me' }, solver.id)
    const original = deliveries.at(-1)
    await original.sent
    const input = agent(reviewer.id).message
    assert.equal(input.source.exchangeId, original.message.exchangeId)
    h.finish(solver.id, `Waiting for ${kind} review.`)
    h.event(reviewer.id, 'turn/start', { turn })
    h.takeInput(reviewer.id, input)
    const answer = await f.prompt(reviewer.id, input, kind === 'result' ? resultEffort : undefined)
    assert.equal(answer.text, reviewShip, JSON.stringify(answer.chunks))
    const release = kind === 'result' ? await beforeReply?.(request) : undefined
    h.finish(reviewer.id, answer.text)
    const reply = deliveries.at(-1)
    await release?.(reply)
    assert.equal(await reply.sent, reply.message.exchangeId)
    const actual = agent(solver.id).message
    assert.equal(actual.source.replyTo, original.message.exchangeId)
    if (kind !== 'result' || takeResult) {
      h.event(solver.id, 'turn/start', { turn: turn + 1 })
      h.takeInput(solver.id, actual)
    }
    return { exchangeId: original.message.exchangeId, actual }
  }
  await review('plan', 2)
  assert.equal(bot.reviewTrack.solver.plan.accepted, true)
  assert.match(await progress('start', { request, run: 'observed', checks: [check] }), /^Recorded\./)
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command }, agent: agent(solver.id), callId: 'observed',
  }, async () => ({ isError: false, value: { kind: 'foreground', cwd: f.cwd, exitCode: 0, signal: null, timedOut: false, aborted: false } }))
  assert.match(await progress('checks', { request, run: 'observed', results: [{ check, pass: true }] }), /^Recorded\./)
  return review('result', 3)
}

test('Owner LA-2 delivers once from the dialog with a raw Solver alias and an existing alias reviewer', async t => {
  const f = await dialogWire(t, 'selected', undefined, {
    solverRef: 'acp-claude/opus', solverLabel: 'Opus', existingReviewer: 'acp-claude/sonnet',
  })
  const { h, bot, solver, reviewer } = f
  assert.deepEqual(f.creates.map(entry => entry.payload.model), ['acp-claude/opus'])
  assert.equal(bot.model, 'acp-claude/opus')
  assert.equal(bot.reviewerId, reviewer.id)
  assert.equal(reviewer.model, 'acp-claude/sonnet')
  const { exchangeId, actual } = await dialogResult(f)
  assert.equal(actual.source.reviewFeedback, undefined)
  assert.ok(actual.source.reviewReceipt)
  const result = bot.reviewTrack.solver.review
  assert.equal(result.receipt, actual.source.reviewReceipt)
  assert.equal(result.verdict, 'SHIP')
  assert.equal(result.solverModel, 'acp-claude/claude-opus-5-5')
  assert.equal(result.reviewer.model, heldReviewerIdentity)
  assert.deepEqual(new Set(f.wire('acp-claude').filter(row => row.method === 'session/prompt').map(row => row.selected)),
    new Set(['opus', 'sonnet']))
  h.finish(solver.id, 'Delivered after the designated RESULT.')
  const mark = bot.reviewTrack.last
  assert.equal(mark?.done, true)
  assert.equal(mark.resultExchangeId, exchangeId)
  assert.equal(bot.reviewTrack.delivered, true)
  h.event(solver.id, 'turn/start', { turn: 5 })
  h.finish(solver.id, 'Already delivered.')
  assert.equal(bot.reviewTrack.last, mark)
})

test('RESULT independence uses the chosen provider and full model ID', async t => {
  for (const [name, solver, reviewer, same = false] of [
    ['Antigravity and omp', ['acp-antigravity', 'default'], ['acp-omp', 'default']],
    ['native DSH', ['anthropic', 'claude-opus-5-5'], ['deepseek', 'deepseek-v4']],
    ['ACP Hermes', ['acp-hermes', 'vendor/remote/model'], ['acp-hermes', 'vendor/local/model']],
    ['same model across agents', ['acp-claude', 'opus'], ['anthropic', 'claude-opus-5-5']],
    ['different dated IDs', ['anthropic', 'model-20261001'], ['anthropic', 'model-20261101']],
    ['identical native refs', ['deepseek', 'deepseek-v4'], ['deepseek', 'deepseek-v4'], true],
    ['context suffix', ['anthropic', 'model-20261001'], ['ANTHROPIC', 'model-20261001[1m]'], true],
    ['an alias and its pin', ['acp-claude', 'sonnet'], ['acp-claude', 'claude-sonnet-5-5'], true],
  ]) {
    await t.test(name, async t => {
      const { h, request, review, answer, track, openReply, deliveries } = await reviewReplyFixture(t)
      const route = ([provider, model]) => () => ({ config: { provider, model } })
      h.agentOf('solver').session.requestHeader = route(solver)
      h.agentOf('reviewer').session.requestHeader = route(reviewer)
      const planExchange = await review('plan')
      h.finish('solver', 'Waiting for the plan.')
      await openReply(3, answer(planExchange))
      assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
      assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
      const exchange = await review('result')
      h.finish('solver', 'Waiting for the result.')
      h.event('reviewer', 'turn/start', { turn: 2 })
      h.takeInput('reviewer', h.agentOf('reviewer').message)
      h.event('reviewer', 'assistant/message', { message: { content: content('RESULT SHIP') } })
      // The answering text is already recorded when the picker changes.
      h.rt.botOf('reviewer').model = 'later/picker'
      h.agentOf('reviewer').session.requestHeader = route(same ? ['later', 'picker'] : solver)
      h.event('reviewer', 'turn/end', { reason: { kind: 'completed' } })
      const reply = deliveries.at(-1)
      await openReply(4, reply)
      const result = track().solver.review
      assert.equal(result.verdict, same ? 'unverified' : 'SHIP')
      assert.equal(result.unverified, same ? 'same' : undefined)
      assert.equal(h.agentOf('solver').message.source.reviewFeedback, same ? 'same' : undefined)
      if (same) assert.match(h.agentOf('solver').message.content.at(-1).text, /same model as the Solver/)
      else assert.equal(result.reviewer.model, reviewer[0] === 'acp-claude' ? 'acp-claude/claude-opus-5-5' : reviewer.join('/'))
      h.finish('solver', 'Reviewed the RESULT.')
      assert.equal(track().last?.done, same ? undefined : true)
      if (!same) assert.equal(track().last.resultExchangeId, exchange)
    })
  }
})

test('New Solver picks the live Claude option and delivers Done once for that RESULT exchange', async t => {
  const f = await dialogWire(t)
  const { h, bot, solver, reviewer } = f
  const { exchangeId } = await dialogResult(f)
  const prompts = f.wire('acp-claude').filter(e => e.method === 'session/prompt')
  const selected = f.wire('acp-claude').find(e => e.method === 'session/set_config_option' && e.sessionId === prompts.at(-1)?.sessionId)
  assert.equal(selected?.value, 'sonnet')
  assert.equal(selected.selected, 'sonnet')
  t.diagnostic(JSON.stringify({ solverRow: f.solverRow, reviewerRow: f.reviewerRow, saved: reviewer.model, selected, recorded: bot.reviewTrack.solver.review }))
  h.finish(solver.id, 'Delivered after the RESULT reply.')
  assert.equal(bot.reviewTrack.last?.done, true, JSON.stringify({ mark: bot.reviewTrack.last, outcome: bot.reviewTrack.outcome }))
  assert.equal(bot.reviewTrack.last.resultExchangeId, exchangeId)
  assert.equal(bot.reviewTrack.delivered, true)
  assert.equal(reviewer.model, configuredReviewer)
  assert.equal(f.creates[0].payload.model, configuredReviewer)
  const mark = bot.reviewTrack.last
  h.event(solver.id, 'turn/start', { turn: 5 })
  h.finish(solver.id, 'Already delivered.')
  assert.equal(bot.reviewTrack.last, mark)
})

test('New Solver requires Claude wire acknowledgement in its answering session', async t => {
  for (const outcome of ['echo-only', 'different', 'already-current']) {
    await t.test(outcome, async t => {
      const f = await dialogWire(t, outcome)
      const answer = await f.prompt(f.reviewer.id, { content: content('Review this.'), source: { kind: 'user' } })
      const wire = f.wire('acp-claude')
      if (outcome === 'already-current') {
        assert.equal(answer.text, reviewShip)
        assert.ok(wire.some(row => row.method === 'session/prompt' && row.selected === 'sonnet'))
        assert.equal(f.adapter.live.get(f.reviewer.id).run.acknowledgedModel(), 'claude-sonnet-5-5')
      } else {
        assert.match(answer.chunks.at(-1).reason.failure.message, /did not acknowledge the pinned Sonnet/)
        assert.equal(wire.filter(row => row.method === 'session/prompt').length, 0)
        assert.equal(f.adapter.live.get(f.reviewer.id).run.acknowledgedModel(), undefined)
        assert.equal(f.adapter.live.get(f.reviewer.id).run.option('model').currentValue, outcome === 'echo-only' ? 'sonnet' : 'default')
      }
    })
  }
})

test('a missing answering route gives the exact RESULT input a durable unverified notice', async t => {
  const f = await dialogWire(t)
  const { h, bot, solver, reviewer } = f
  const result = await dialogResult(f, { takeResult: false, async beforeReply(request) {
    f.agent(reviewer.id).session.requestHeader = () => undefined
    h.person('Work alone until delivered.', solver.id)
    const atCommit = Promise.withResolvers()
    const releaseProgress = Promise.withResolvers()
    const saveCopy = h.rt.saveCopy
    h.rt.saveCopy = (change, options) => saveCopy(change, {
      ...options, beforeCommit: async () => {
        atCommit.resolve()
        await releaseProgress.promise
        options.beforeCommit()
      },
    })
    const write = f.progress('auto', { request, quote: 'Work alone until delivered.' })
    await atCommit.promise
    const saved = h.rt.save
    const gate = Promise.withResolvers()
    let waiting = false
    h.rt.save = async options => {
      if (options?.required && options.durable && bot.reviewTrack.solver.review?.unverified === 'model') {
        waiting = true
        await gate.promise
      }
      return saved(options)
    }
    return async reply => {
      assert.equal(bot.reviewTrack.solver.review.verdict, undefined, 'the verdict waits for the current progress write')
      assert.notEqual(f.agent(solver.id).message?.source.exchangeId, reply.message.exchangeId)
      h.rt.saveCopy = saveCopy
      releaseProgress.resolve()
      assert.match(await write, /^Recorded\./)
      await until(() => waiting)
      assert.notEqual(f.agent(solver.id).message?.source.exchangeId, reply.message.exchangeId)
      assert.equal(bot.reviewTrack.delivered, undefined)
      h.rt.save = saved
      gate.resolve()
    }
  } })
  const { exchangeId, actual } = result
  const feedback = '[Automagik: RESULT review is unverified. The reviewer’s effective model could not be verified. Keep this request unmarked Done.]'
  assert.equal(actual.content.at(-1).text, feedback)
  assert.match(actual.content[0].text, /Verdict: SHIP\nEvidence verified\./)
  assert.equal(actual.source.replyTo, exchangeId)
  assert.ok(actual.source.reviewReceipt)
  const disk = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots[solver.id].reviewTrack.solver.review
  assert.equal(disk.verdict, 'unverified')
  assert.equal(disk.unverified, 'model')
  assert.equal(disk.receipt, actual.source.reviewReceipt)
  const book = h.rt.ledger.records(`pair-${[solver.id, reviewer.id].sort().join('-')}`)
  assert.equal(book.find(entry => entry.id === actual.source.exchangeId && entry.event === undefined).text, reviewShip)
  const statusView = { ...bot, ...h.rt.solverStatusOf(bot) }
  const surfaces = [
    [undefined, /RESULT review unverified\. The reviewer’s effective model could not be verified\./],
    [ptBrLocale(), /Revisão do RESULTADO sem verificação\. Não foi possível verificar o modelo usado pelo revisor\./],
    [{ register() {}, bind: () => (key, params) => (DICTIONARY.zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
      getLocale: () => ({ active: 'zh' }) }, /结果审阅未通过验证。无法验证审阅者实际使用的模型。/],
  ]
  for (const [locale, expected] of surfaces) {
    const restore = installLocale(locale)
    try { assert.match(solverAutoView(statusView, {}, 'ask').lines.join('\n'), expected) } finally { restore() }
  }
  const moved = { ...actual, id: 'moved-review-input' }
  assert.deepEqual(h.rt.withReviewFeedback(moved, solver.id).content, actual.content)
  assert.notEqual(h.rt.withReviewFeedback(moved, reviewer.id).content.at(-1).text, feedback)
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const note = next.rt.unreadReviewReplies(solver.id).find(row => row.exchangeId === actual.source.exchangeId)
  assert.equal(note?.reviewReply?.receipt, actual.source.reviewReceipt)
  // Recover the same receipt through the normal reply queue and wake.
  await until(() => next.agentOf(solver.id).message?.source.exchangeId === actual.source.exchangeId)
  const reconstructed = next.agentOf(solver.id).message
  assert.equal(reconstructed.source.reviewFeedback, 'model')
  assert.equal(reconstructed.content.at(-1).text, feedback)
  const movedAgain = { ...reconstructed, id: 'new-part-input' }
  next.event(solver.id, 'turn/start', { turn: 4 })
  next.takeInput(solver.id, movedAgain)
  const binding = next.rt.live.get(solver.id).consumedResult
  assert.equal(binding.receipt, actual.source.reviewReceipt)
  const continuation = next.rt.notePartReviewContinuation(solver.id, {
    id: 'continuation', content: content('Continue.'), source: { kind: 'bot', role: 'resume', exchangeId: 'resume' },
  }, binding)
  assert.equal(continuation.content.at(-1).text, feedback)
  next.finish(solver.id, 'Kept unmarked Done.')
  const track = next.rt.botOf(solver.id).reviewTrack
  assert.equal(track.last?.done, undefined)
  assert.equal(track.outcome.reason, 'review')
  next.person('Replace the request.', solver.id)
  assert.equal(next.rt.withReviewFeedback(continuation, solver.id, binding).content.at(-1).text, 'Continue.')
  assert.equal(await next.rt.flushUpdateNotes(), true)
  await next.rt.save({ required: true, durable: true })
  await next.close()
})

async function pendingResultReview(t, route = solverModel) {
  const f = await reviewReplyFixture(t)
  const { h, request, review, answer, openReply } = f
  h.agentOf('solver').session.requestHeader = () => ({ config: route })
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  await openReply(3, answer(planExchange))
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  // Give the RESULT a parent work item so a concurrently opened turn defers it.
  h.rt.openWork('solver-work', { from: 'other', to: 'solver' })
  h.rt.live.get('solver').info = { kind: 'bot', role: 'request', exchangeId: 'solver-work', senderSessionId: 'other' }
  const exchange = await review('result')
  assert.equal(h.rt.state.works[exchange].parent, 'solver-work')
  h.finish('solver', 'Waiting for result review.')
  return { ...f, exchange }
}

test('PR B mixed-route RESULT credits the controlling verdict writer', async t => {
  const own = { provider: 'acp-codex', model: 'default' }
  const independent = { provider: 'acp-omp', model: 'default' }
  for (const [name, first, second, verdict, reason] of [
    ['label beats the glued fallback', 'Evidence checked.SHIP', 'Verdict: SHIP', 'unverified', 'same'],
    ['explicit RESULT keeps precedence', 'RESULT SHIP', 'Verdict: SHIP', 'SHIP'],
    ['wrong stage cannot borrow a label', 'PLAN SHIP', 'Verdict: SHIP', 'unverified'],
    ['later veto still wins', 'Evidence checked.SHIP', 'Verdict: BLOCKED', 'BLOCKED'],
    ['handed-back label stays outside the guard', 'Evidence checked.SHIP',
      '[Handed back to reviewer for this work]\nVerdict: SHIP', 'SHIP'],
  ]) {
    await t.test(name, async t => {
      const { h, exchange, track, deliveries, openReply } = await pendingResultReview(t, own)
      const priorVerdicts = structuredClone(track().verdicts)
      const reviewer = h.agentOf('reviewer')
      h.event('reviewer', 'turn/start', { turn: 4 })
      h.takeInput('reviewer', reviewer.message)
      reviewer.session.requestHeader = () => ({ config: independent })
      h.event('reviewer', 'assistant/message', { message: { content: content(first) } })
      reviewer.session.requestHeader = () => ({ config: own })
      h.finish('reviewer', second)
      await openReply(5, deliveries.at(-1))
      const result = track().solver.review
      assert.equal(result.exchangeId, exchange)
      assert.equal(result.receipt, h.agentOf('solver').message.source.reviewReceipt)
      assert.equal(result.verdict, verdict)
      if (reason === 'same') {
        assert.equal(result.unverified, 'same')
        assert.match(h.agentOf('solver').message.content.at(-1).text, /same model as the Solver/)
      }
      if (verdict === 'SHIP') {
        assert.equal(result.reviewer.model, 'acp-omp/default')
        assert.deepEqual(track().verdicts.slice(0, -1), priorVerdicts)
        assert.equal(track().verdicts.at(-1)?.verdict, 'SHIP')
      }
      h.finish('solver', 'Delivered after review.')
      assert.equal(track().last?.done, verdict === 'SHIP' ? true : undefined)
      const mark = h.rt.reviewMarkOf(h.rt.botOf('solver')).reviewMark
      if (reason === 'same') {
        assert.deepEqual({ verdicts: track().verdicts, reviewed: mark?.result }, { verdicts: priorVerdicts, reviewed: false },
          'the controlling same-pair SHIP adds no credited verdict or RESULT review mark')
      }
      if (verdict === 'SHIP') assert.equal(mark?.result, true)
    })
  }
})

test('Owner LA-2 replaces a legacy pending RESULT without discarding passing evidence or delivery history', async t => {
  const { h, request, exchange, track } = await pendingResultReview(t)
  const progress = track().solver
  progress.review.solverModel = solverModel.model
  const evidence = structuredClone({ snapshot: progress.snapshot, passed: progress.passed, passRuns: progress.passRuns })
  const history = { review: 'bot', done: true, resultExchangeId: 'older-result', reviewer: { id: 'reviewer', model: 'old-model' } }
  h.rt.botOf('other').reviewTrack = {
    requested: true, delivered: true, requestAt: 1, last: history,
    solver: { request: 'older-request', origin: 'person', review: { solverModel: 'old-solver', verdict: 'SHIP' } },
  }
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  await next.rt.load()
  const bot = next.rt.botOf('solver')
  assert.equal(bot.reviewTrack.solver.review.exchangeId, exchange)
  assert.equal(bot.reviewTrack.solver.review.solverModel, solverModel.model)
  assert.deepEqual(next.rt.reviewMarkOf(next.rt.botOf('other')).reviewMark, history)
  await next.tool('message_bot', {
    to: 'reviewer', message: 'Review the current result again.', solver_review: 'result', solver_request: request, reply_to: 'me',
  })
  const input = next.agentOf('reviewer').message
  const current = bot.reviewTrack.solver
  assert.notEqual(current.review.exchangeId, exchange)
  assert.equal(input.source.exchangeId, current.review.exchangeId)
  assert.equal(current.review.solverModel, refOf(solverModel))
  assert.deepEqual({ snapshot: current.snapshot, passed: current.passed, passRuns: current.passRuns }, evidence)
  assert.equal(next.rt.state.works[exchange], undefined)
  next.event('reviewer', 'turn/start', { turn: 5 })
  next.takeInput('reviewer', input)
  next.finish('reviewer', 'RESULT SHIP')
  await until(() => next.agentOf('solver').message?.source.replyTo === current.review.exchangeId)
  next.event('solver', 'turn/start', { turn: 6 })
  next.takeInput('solver', next.agentOf('solver').message)
  next.finish('solver', 'Delivered after the fresh RESULT.')
  assert.equal(bot.reviewTrack.last?.done, true)
  assert.equal(bot.reviewTrack.last.resultExchangeId, current.review.exchangeId)
  assert.deepEqual(next.rt.reviewMarkOf(next.rt.botOf('other')).reviewMark, history)
})

const modelWarningCount = message => message?.content.filter(block =>
  block.type === 'text' && block.text.includes('The reviewer’s effective model could not be verified.')).length

test('identity round 2 recovers the original RESULT at the first durable work closure', async t => {
  const { h, exchange, answer } = await pendingResultReview(t)
  const snapshot = mkdtempSync(join(tmpdir(), 'solver-first-closure-'))
  t.after(() => rmSync(snapshot, { recursive: true, force: true, maxRetries: 5 }))
  const decision = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const capabilities = h.rt.ensureCapabilities
  h.rt.ensureCapabilities = async id => {
    if (id === 'solver') await gate.promise
    return capabilities(id)
  }
  const save = h.rt.save
  h.rt.save = async options => {
    if (options?.required && options.durable && h.rt.botOf('solver').reviewTrack.solver.review?.unverified === 'model') {
      await decision.promise
    }
    const written = await save(options)
    if (options?.durable && written) {
      const state = readFileSync(join(h.home, 'state.json'), 'utf8')
      if (!JSON.parse(state).works[exchange]) {
        closed.resolve({ state, notes: readFileSync(join(h.home, 'inflight.json'), 'utf8') })
      }
    }
    return written
  }
  const reply = answer(exchange, undefined, null)
  // Allow a candidate that keeps the work open until the decision is durable to reach closure.
  // On the parent, the earlier closure is allowed to reach disk while the decision is held.
  if (h.rt.state.works[exchange]) decision.resolve()
  const cut = await closed.promise
  assert.notEqual(h.agentOf('solver').message?.source.exchangeId, reply.message.exchangeId)
  decision.resolve()
  gate.resolve()
  assert.equal(await reply.sent, reply.message.exchangeId)
  writeFileSync(join(snapshot, 'state.json'), cut.state)
  writeFileSync(join(snapshot, 'inflight.json'), cut.notes)
  const notes = Object.entries(JSON.parse(cut.notes).queued).flatMap(([destination, items]) =>
    items.filter(({ args }) => args.replyTo === exchange).map(({ args }) => ({ destination, args })))
  assert.equal(notes.length, 1, 'the first durable closure must already have exactly one recoverable RESULT')
  const [{ destination, args }] = notes
  assert.equal(destination, 'solver')
  assert.equal(args.text, reviewShip)
  assert.equal(args.reviewReply.receipt, JSON.parse(cut.state).bots.solver.reviewTrack.solver.review.receipt)

  const next = fixture(t, snapshot)
  const inputs = []
  next.agentOf('solver').followup = message => inputs.push(message)
  await next.rt.load()
  const keepAlive = setInterval(() => {}, 1000)
  try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
  const recovered = inputs.filter(message => message.source.replyTo === exchange)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].source.reviewReceipt, args.reviewReply.receipt)
  assert.match(recovered[0].content[0].text, /Verdict: SHIP\nEvidence verified\./)
  assert.equal(modelWarningCount(recovered[0]), 1)
  await next.close()
})

test('identity round 2 keeps only the current RESULT warning on deferred hand-back', async t => {
  for (const path of ['ordinary', 'update restart', 'replaced request']) {
    await t.test(path, async t => {
      const { h, request, exchange, answer } = await pendingResultReview(t)
      const solver = h.agentOf('solver')
      const reply = answer(exchange, undefined, null)
      assert.equal(await reply.sent, reply.message.exchangeId)
      const input = solver.message
      assert.equal(modelWarningCount(input), 1)
      h.event('solver', 'turn/start', { turn: 4 })
      h.event('solver', 'user/message', { content: content('Other work.'), source: {
        kind: 'bot', role: 'reply', senderSessionId: 'other', exchangeId: 'other-reply', work: 'other-work',
      } })
      h.takeInput('solver', input)
      const deferred = h.rt.live.get('solver').later
      assert.equal(deferred?.length, 1, 'the actual RESULT was deferred during other work')
      assert.equal(deferred[0].text, reviewShip)
      assert.ok(h.rt.live.get('solver').consumedResult)
      const expected = path === 'replaced request' ? 0 : 1
      let inputs = []
      if (path === 'update restart') {
        await h.rt.markUpdateStop(['solver'])
        await h.close()
        const next = fixture(t, h.home)
        next.agentOf('solver').followup = message => inputs.push(message)
        await next.rt.load()
        const keepAlive = setInterval(() => {}, 1000)
        try { await next.rt.resumesDone } finally { clearInterval(keepAlive) }
        await next.close()
      } else {
        solver.followup = message => inputs.push(message)
        if (path === 'replaced request') {
          h.rt.reviewTurnEnd('solver', { request, completed: true, wroteText: true, model: refOf(solverModel) })
          assert.equal(await requestOf(h), undefined)
          h.person('A new task has replaced the review.')
          assert.notEqual(await requestOf(h), request)
        }
        h.event('solver', 'turn/end', { reason: { kind: 'interrupted' } })
        await until(() => inputs.length > 0)
      }
      inputs = inputs.filter(message => message.source.replyTo === exchange)
      assert.equal(inputs.length, 1)
      assert.match(inputs[0].content[0].text, /Verdict: SHIP\nEvidence verified\./)
      assert.equal(modelWarningCount(inputs[0]), expected, 'the hand-back must reconstruct only the current host warning')
      if (path === 'replaced request') {
        h.event('solver', 'turn/start', { turn: 5 })
        h.takeInput('solver', inputs[0])
        assert.equal(h.rt.live.get('solver').consumedResult, undefined)
      }
    })
  }
})

test('Claude Code pins the three live aliases and selects the Opus wire from the answering session', async t => {
  const { h, adapter, wire, selections } = wireHost(t, undefined, 'opus-alias')
  const provider = 'acp-claude'
  await adapter.agents.get(provider).catalog.probeIdentityModels()
  const model = 'claude-opus-5-5'
  const id = 'reviewer'
  await h.ctx.sessionController.selectModel({ sessionId: id, provider, model })
  assert.deepEqual(selections.at(-1), { sessionId: id, provider, model })
  h.event(id, 'turn/start', { turn: 21 })
  const messages = [{ role: 'user', content: content('Review this.') }]
  const chunks = []
  for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
  const reports = wire(provider)
  const prompt = reports.find(row => row.method === 'session/prompt')
  assert.ok(prompt, JSON.stringify(chunks))
  assert.equal(reports.find(row => row.method === 'session/set_config_option' && row.sessionId === prompt.sessionId)?.value, 'opus')
  assert.equal(prompt.selected, 'opus')
  assert.equal(adapter.live.get(id).run.acknowledgedModel(), model)

  const models = await adapter.listModels(provider)
  for (const [alias, pin, name] of [
    ['opus', model, 'Opus 5.5'], ['fable', 'claude-fable-5-2', 'Fable 5.2'], ['haiku', 'claude-haiku-5-5', 'Haiku 5.5'],
  ]) {
    assert.deepEqual(adapter.modelIdentityOf(provider, alias), { status: 'offered', model: pin })
    assert.deepEqual(adapter.modelIdentityOf(provider, pin), { status: 'offered', model: pin })
    assert.deepEqual(models.filter(row => row.id === pin).map(row => row.name), [name])
    assert.equal((await adapter.resolveModel(provider, pin)).name, name)
  }
  assert.deepEqual(adapter.modelIdentityOf(provider, 'default'), { status: 'offered', model: 'default' })
  assert.equal((await h.rt.catalog({ fresh: true })).find(row => row.ref === 'acp-claude/default')?.solverIdentity, 'acp-claude/default')
})

test('the live Claude alias relabel refuses an explicit pin and an offered concrete row does not prove a raw alias', async t => {
  const provider = 'acp-claude'
  const model = 'claude-opus-5-5'
  const id = 'reviewer'
  const messages = [{ role: 'user', content: content('Review this.') }]
  const stream = async (adapter, model) => {
    const chunks = []
    for await (const chunk of adapter.stream({ provider, model, sessionId: id, messages, signal: AbortSignal.timeout(5000) })) chunks.push(chunk)
    return chunks
  }
  const home = mkdtempSync(join(tmpdir(), 'solver-relabel-wire-'))
  const relabel = wireHost(t, home, 'opus-relabelled')
  await relabel.adapter.agents.get(provider).catalog.probeIdentityModels()
  assert.deepEqual(relabel.adapter.modelIdentityOf(provider, model), { status: 'offered', model })
  writeFileSync(join(home, provider + '.jsonl.relabelled'), '')
  const chunks = await stream(relabel.adapter, model)
  assert.match(chunks.at(-1).reason.failure?.message ?? '', /the pinned Opus model is not offered/)
  const answering = relabel.adapter.live.get(id).run
  assert.equal(answering.option('model').options.find(row => row.value === 'opus')?.name, 'Opus 5.6')
  assert.equal(relabel.wire(provider).some(row => row.sessionId === answering.sessionId), false,
    'the answering run sent neither a model selection nor a prompt')

  const concrete = wireHost(t)
  await concrete.adapter.agents.get(provider).catalog.probeIdentityModels()
  assert.deepEqual(concrete.adapter.modelIdentityOf(provider, model), { status: 'offered', model })
  assert.deepEqual(concrete.adapter.modelIdentityOf(provider, 'opus'), { status: 'unresolved' })
  const wrong = wireHost(t, undefined, 'different-concrete')
  const unacknowledged = await stream(wrong.adapter, model)
  assert.match(unacknowledged.at(-1).reason.failure?.message ?? '', /did not acknowledge the pinned Opus model/)
  assert.equal(wrong.wire(provider).some(row => row.method === 'session/prompt'), false)
  assert.equal(wrong.adapter.live.get(id).run.acknowledgedModel(), undefined)

  await stream(concrete.adapter, 'opus')
  assert.equal(concrete.wire(provider).find(row => row.method === 'session/prompt')?.selected, 'opus')
})

const snapshotDigest = /^[a-f0-9]{64}$/

function teamWithSnapshotLink(h) {
  const team = join(h.home, 'team')
  const modules = join(team, 'stt', 'node_modules')
  mkdirSync(join(modules, 'semver', 'bin'), { recursive: true })
  mkdirSync(join(modules, '.bin'))
  writeFileSync(join(modules, 'semver', 'bin', 'semver.js'), 'fake executable')
  symlinkSync('../semver/bin/semver.js', join(modules, '.bin', 'semver'))
  h.ctx.workspaceRegistry.get = () => ({ path: team })
  delete h.rt.botOf('solver').workDir
  return team
}

function snapshotFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'solver-snapshot-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return fs.realpathSync.native(home)
}

function recordSnapshotAccess(t, run, before = () => {}) {
  const calls = []
  const mocks = []
  const linkText = fs.readlinkSync
  const capture = (method, original) => (path, ...args) => {
    if (typeof path === 'string') {
      const physical = path.replace(/^\/proc\/self\/fd\/\d+/, fd => linkText(fd))
      calls.push([method, physical, args[0], path])
      before(method, physical, path)
    }
    return original(path, ...args)
  }
  for (const method of ['lstatSync', 'statSync', 'readlinkSync', 'openSync', 'opendirSync', 'readdirSync', 'readFileSync', 'realpathSync']) {
    const original = fs[method]
    mocks.push(t.mock.method(fs, method, capture(method, original)))
    if (method === 'realpathSync') fs.realpathSync.native = capture(method, original.native)
  }
  syncBuiltinESMExports()
  try { return { value: run(), calls } } finally {
    for (const method of mocks) method.mock.restore()
    syncBuiltinESMExports()
  }
}

function withoutSnapshotProcfs(t, run) {
  const statfs = fs.statfsSync
  const mock = t.mock.method(fs, 'statfsSync', (path, ...args) => {
    if (path === '/proc/self/fd') throw Object.assign(new Error('No procfs in this fixture'), { code: 'ENOENT' })
    return statfs(path, ...args)
  })
  syncBuiltinESMExports()
  try { return run() } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
}

function snapshotProcfsAvailable() {
  if (process.platform !== 'linux') return false
  try { return fs.statfsSync('/proc/self/fd').type === 0x9fa0 } catch { return false }
}

test('Snapshot E option B: a link-free root can be read without procfs', t => {
  const folder = snapshotFixture(t)
  mkdirSync(join(folder, 'nested'))
  writeFileSync(join(folder, 'nested', 'answer.txt'), '42\n')
  const { value, calls } = withoutSnapshotProcfs(t, () => recordSnapshotAccess(t, () => resultSnapshot(folder)))
  assert.match(value ?? '', snapshotDigest)
  assert.ok(calls.some(([method, , , path]) => method === 'opendirSync' && path === join(folder, 'nested')))
  assert.ok(calls.every(([, , , path]) => !path.startsWith('/proc/self/fd/')))
})

test('Snapshot E option B: a directory root under a linked ancestor can be read', t => {
  const folder = snapshotFixture(t)
  const target = join(folder, 'target')
  const root = join(target, 'root')
  const ancestor = join(folder, 'ancestor')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'answer.txt'), '42\n')
  symlinkSync(target, ancestor, 'junction')
  const { value, calls } = recordSnapshotAccess(t, () => resultSnapshot(join(ancestor, 'root')))
  assert.match(value ?? '', snapshotDigest)
  assert.ok(calls.some(([method, path]) => method === 'opendirSync' && path === root))
})

test('Snapshot E option B: Linux with procfs enumerates held descriptors and refuses a strict read error',
  { skip: !snapshotProcfsAvailable() }, t => {
    const folder = snapshotFixture(t)
    const nested = join(folder, 'nested')
    mkdirSync(nested)
    writeFileSync(join(nested, 'answer.txt'), '42\n')
    const take = before => recordSnapshotAccess(t, () => resultSnapshot(folder), before)
    const good = take()
    assert.match(good.value ?? '', snapshotDigest)
    const enumerated = good.calls.filter(([method]) => method === 'opendirSync')
    assert.deepEqual(enumerated.map(([, path]) => path), [folder, nested])
    for (const [, , , path] of enumerated) assert.match(path, /^\/proc\/self\/fd\/\d+$/)

    const refused = take((method, path, raw) => {
      if (method === 'opendirSync' && path === nested && raw.startsWith('/proc/self/fd/')) {
        throw Object.assign(new Error('Strict read refused in this fixture'), { code: 'EACCES' })
      }
    })
    assert.equal(refused.value, undefined)
    assert.ok(refused.calls.every(([method, , , path]) => method !== 'opendirSync' || path.startsWith('/proc/self/fd/')))
  })

test('Snapshot E option B: the portable walk refuses an observed directory identity change', t => {
  const folder = snapshotFixture(t)
  const nested = join(folder, 'nested')
  const replacement = join(folder, 'replacement')
  mkdirSync(nested)
  mkdirSync(replacement)
  writeFileSync(join(replacement, 'answer.txt'), '42\n')
  let replaced = false
  const attempt = withoutSnapshotProcfs(t, () => recordSnapshotAccess(t, () => resultSnapshot(folder), (method, path) => {
    if (replaced || method !== 'opendirSync' || path !== nested) return
    replaced = true
    renameSync(nested, join(folder, 'original'))
    renameSync(replacement, nested)
  }))
  assert.equal(replaced, true)
  assert.equal(attempt.value, undefined)
  assert.ok(attempt.calls.every(([, path]) => path !== join(nested, 'answer.txt')))
})

function assertNoSnapshotTargetAccess(calls, links, outside) {
  for (const [method, path] of calls) {
    assert.ok(path !== outside && !path.startsWith(outside + '/'), `${method} accessed ${path}`)
    for (const link of links) {
      assert.ok(!path.startsWith(link + '/'), `${method} accessed ${path} through a link`)
      if (path === link) assert.ok(['lstatSync', 'readlinkSync'].includes(method), `${method} accessed ${link}`)
    }
  }
}

async function reportSnapshotCheck(h, request, run, cwd, command, check = 'answer') {
  await h.ctx.listeners.get('tools/execute')[0]({
    name: 'bash', arguments: { command }, agent: h.agentOf('solver'), callId: run,
  }, async () => ({ isError: false, value: { kind: 'foreground', cwd, exitCode: 0, signal: null, timedOut: false, aborted: false } }))
  return h.progress('checks', { request, run, results: results(check) })
}

test('Snapshot E T1/E2E: a folder-less Solver verifies a check and delivers Done', async t => {
  const h = await setup(t)
  const team = teamWithSnapshotLink(h)
  const answer = join(team, 'task', 'answer.txt')
  const command = `test -s "${answer}"`
  const { request, send, delivered } = await reviewedPlan(h, ['answer'], [{ check: 'answer', command }])
  mkdirSync(dirname(answer))
  writeFileSync(answer, '42\n')
  assert.match(await h.progress('start', { request, run: 'team-check', checks: ['answer'] }), /^Recorded\./)
  assert.match(await reportSnapshotCheck(h, request, 'team-check', team, command), /^Recorded\./)
  const bot = h.rt.botOf('solver')
  assert.deepEqual(bot.reviewTrack.solver.passed, ['answer'])
  assert.equal(bot.reviewTrack.solver.runs['team-check'].unverified, undefined)
  await send('result')
  h.event('reviewer', 'user/message', { content: content('Review the agreed check.'), source: {
    kind: 'bot', role: 'request', senderSessionId: 'solver', exchangeId: delivered.at(-1).exchangeId,
  } })
  h.event('reviewer', 'turn/start', { turn: 2 })
  h.finish('reviewer', 'SHIP\nEvidence verified.')
  h.event('solver', 'turn/start', { turn: 3 })
  h.finish('solver', 'The answer is 42.')
  const mark = bot.reviewTrack.last
  assert.equal(mark.done, true)
  assert.equal(reviewMarkText({ ...bot, reviewMark: mark }, { byId: h.rt.state.bots }),
    'Plan and result reviewed by reviewer.\nDone: every check passed and reviewer approved.')
})

test('Snapshot E T2: a link retarget and a replacement file produce distinct digests', t => {
  const folder = snapshotFixture(t)
  const link = join(folder, 'link')
  symlinkSync('missing-a', link)
  const before = resultSnapshot(folder)
  assert.match(before ?? '', snapshotDigest)
  symlinkSync('missing-b', link + '.new')
  renameSync(link + '.new', link)
  const retargeted = resultSnapshot(folder)
  assert.match(retargeted ?? '', snapshotDigest)
  assert.notEqual(retargeted, before)
  unlinkSync(link)
  writeFileSync(link, 'missing-b')
  const file = resultSnapshot(folder)
  assert.match(file ?? '', snapshotDigest)
  assert.notEqual(file, retargeted)
})

test('Snapshot E T3: snapshot access and digest exclude link targets', t => {
  const folder = snapshotFixture(t)
  const outside = snapshotFixture(t)
  const target = join(outside, 'secret.txt')
  const targetDir = join(outside, 'dir')
  const fileLink = join(folder, 'out')
  const dirLink = join(folder, 'outdir')
  mkdirSync(targetDir)
  writeFileSync(target, 'disposable fake')
  symlinkSync(target, fileLink)
  symlinkSync(targetDir, dirLink)
  const take = () => recordSnapshotAccess(t, () => resultSnapshot(folder))
  const initial = take()
  assertNoSnapshotTargetAccess(initial.calls, [fileLink, dirLink], outside)
  assert.match(initial.value ?? '', snapshotDigest)
  for (const link of [fileLink, dirLink]) {
    assert.ok(initial.calls.some(([method, path]) => method === 'readlinkSync' && path === link))
  }
  const check = () => {
    const next = take()
    assertNoSnapshotTargetAccess(next.calls, [fileLink, dirLink], outside)
    assert.match(next.value ?? '', snapshotDigest)
    assert.equal(next.value, initial.value)
  }
  writeFileSync(target, 'changed disposable fake')
  utimesSync(target, 1, 1)
  writeFileSync(join(targetDir, 'added'), 'added disposable fake')
  check()
  unlinkSync(target)
  check()
  writeFileSync(target, 'recreated disposable fake')
  check()
})

test('Snapshot E AE-2: a directory replaced before traversal does not redirect the walk', { skip: !snapshotProcfsAvailable() }, t => {
  const folder = snapshotFixture(t)
  const outside = snapshotFixture(t)
  const nested = join(folder, 'nested')
  mkdirSync(nested)
  writeFileSync(join(outside, 'outside-name'), 'disposable fake')
  let replaced = false
  const attempt = recordSnapshotAccess(t, () => resultSnapshot(folder), (method, path) => {
    if (replaced || path !== nested || !['openSync', 'readdirSync', 'opendirSync'].includes(method)) return
    replaced = true
    renameSync(nested, join(folder, 'original'))
    symlinkSync(outside, nested)
  })
  assert.equal(replaced, true)
  assert.equal(attempt.value, undefined)
  for (const [method, path, flags] of attempt.calls) {
    if (method === 'openSync' && path === nested) {
      assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW)
      continue
    }
    assertNoSnapshotTargetAccess([[method, path]], [nested], outside)
  }
})

test('Snapshot E T4: a linked or non-directory root refuses without recording a run', async t => {
  const h = await setup(t)
  const outside = snapshotFixture(t)
  const folder = h.rt.botOf('solver').workDir
  const { request } = await reviewedPlan(h, ['check-a'])
  rmdirSync(folder)
  symlinkSync(outside, folder)
  for (const leading of [folder, folder + '/']) {
    const inspected = recordSnapshotAccess(t, () => resultSnapshot(leading))
    assert.equal(inspected.value, undefined)
    assertNoSnapshotTargetAccess(inspected.calls, [folder], outside)
  }
  const start = () => h.progress('start', { request, run: 'invalid-root', checks: ['check-a'] })
  assert.match(await start(), /^Cannot start this run\. The result folder cannot be verified: .*symbolic link.* No run was recorded\./)
  const assertNoRun = () => {
    const progress = h.rt.botOf('solver').reviewTrack.solver
    assert.deepEqual(progress.runs, {})
    assert.equal(progress.pending, undefined)
  }
  assertNoRun()
  unlinkSync(folder)
  writeFileSync(folder, 'not a directory')
  assert.match(await start(), /^Cannot start this run\. The result folder cannot be verified: .*not a directory.* No run was recorded\./)
  assertNoRun()
})

test('Snapshot E T5: a folder-less Solver refuses a socket with its relative path', async t => {
  const h = await setup(t)
  const folder = teamWithSnapshotLink(h)
  const { request } = await reviewedPlan(h, ['answer'])
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(join(folder, 's.sock'), resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const refusal = await h.progress('start', { request, run: 'socket-run', checks: ['answer'] })
  assert.equal(refusal, 'Cannot start this run. The result folder cannot be verified: It contains a device, pipe or socket at "s.sock".'
    + ' No run was recorded. Ask the person to set a smaller working folder for this Solver, or remove what blocks the check, then start again.')
  const progress = h.rt.botOf('solver').reviewTrack.solver
  assert.deepEqual(progress.runs, {})
  assert.equal(progress.pending, undefined)
  const disk = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')).bots.solver.reviewTrack.solver
  assert.deepEqual(disk.runs, {})
  assert.equal(disk.pending, undefined)
})

test('Snapshot E AE-3: refusal retires prior RESULT evidence across reload and permits retry', async t => {
  let h = await setup(t)
  const folder = h.rt.botOf('solver').workDir
  const sealed = join(h.home, 'original-workspace')
  const { request, send, verdict, delivered } = await reviewedPlan(h, ['check-a'])
  assert.match(await checked(h, request, 'original-run'), /^Recorded\./)
  await send('result')
  verdict(delivered.at(-1).exchangeId)
  const prior = h.rt.botOf('solver').reviewTrack.solver
  assert.deepEqual(prior.passed, ['check-a'])
  assert.deepEqual(prior.passRuns, { 'check-a': 'original-run' })
  assert.match(prior.snapshot ?? '', snapshotDigest)
  assert.equal(prior.review.verdict, 'SHIP')
  renameSync(folder, sealed)
  symlinkSync(sealed, folder)
  const refusal = await h.progress('start', { request, run: 'refused-run', checks: ['check-a'] })
  assert.match(refusal, /^Cannot start this run\./)
  unlinkSync(folder)
  renameSync(sealed, folder)
  await h.close()
  h = fixture(t, h.home)
  await h.rt.load()
  const reloaded = h.rt.botOf('solver').reviewTrack.solver
  assert.equal(reloaded.revision, prior.revision + 1)
  assert.deepEqual(reloaded.runs, prior.runs)
  assert.deepEqual(reloaded.passed, [])
  assert.deepEqual(reloaded.passRuns, {})
  assert.equal(reloaded.snapshot, undefined)
  assert.equal(reloaded.review, undefined)
  assert.equal(reloaded.pending, undefined)
  assert.match(await checked(h, request, 'refused-run'), /^Recorded\./)
  assert.deepEqual(h.rt.botOf('solver').reviewTrack.solver.passRuns, { 'check-a': 'refused-run' })
})

test('Snapshot E AE-4: link retarget after start refuses the observed pass', async t => {
  const h = await setup(t)
  const team = teamWithSnapshotLink(h)
  const command = 'fake answer'
  const { request } = await reviewedPlan(h, ['answer'], [{ check: 'answer', command }])
  const run = 'retargeted'
  assert.match(await h.progress('start', { request, run, checks: ['answer'] }), /^Recorded\./)
  const link = join(team, 'stt', 'node_modules', '.bin', 'semver')
  symlinkSync('../different-target', link + '.new')
  renameSync(link + '.new', link)
  assert.match(await reportSnapshotCheck(h, request, run, team, command), /The result changed between the start and the outcome\./)
  const progress = h.rt.botOf('solver').reviewTrack.solver
  assert.deepEqual(progress.passed, [])
  assert.equal(progress.runs[run].unverified, true)
})

test('Snapshot E AE-4: entry cap counts the root and links but excludes the root .git', t => {
  const folder = snapshotFixture(t)
  mkdirSync(join(folder, '.git'))
  for (let i = 0; i < 19_998; i++) writeFileSync(join(folder, String(i)), '')
  symlinkSync('missing', join(folder, 'last-link'))
  assert.match(resultSnapshot(folder) ?? '', snapshotDigest)
  writeFileSync(join(folder, 'over-cap'), '')
  assert.equal(resultSnapshot(folder), undefined)
})

test('Snapshot E P1: a plain Solver folder still records a verified pass', async t => {
  const h = await setup(t)
  const { request } = await reviewedPlan(h, ['check-a'])
  assert.match(await checked(h, request, 'plain-check'), /^Recorded\./)
  assert.deepEqual(h.rt.botOf('solver').reviewTrack.solver.passed, ['check-a'])
})

const reviewPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4AWOUs4n6b8NwhAEADDUCtSU1IikAAAAASUVORK5CYII=',
  'base64',
)
const reviewDigest = data => createHash('sha256').update(data).digest('hex')
const reviewPath = '.automagik/bots/solver/review/art.png'
const reviewAnswer = 'RESULT SHIP\nThe checked result is ready.'

async function checkedVisualReview(t, { path = reviewPath, bytes = reviewPng, prepareFiles, normalization } = {}) {
  const f = await reviewReplyFixture(t)
  const { h, request, review, answer, openReply } = f
  const planExchange = await review('plan')
  h.finish('solver', 'Waiting for plan review.')
  h.event('reviewer', 'turn/start', { turn: 2 })
  const planReply = answer(planExchange)
  h.event('reviewer', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await openReply(3, planReply)
  const folder = h.rt.botOf('solver').workDir
  if (path) {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), bytes)
    utimesSync(join(folder, path), new Date(1_000), new Date(1_000))
  }
  writeFileSync(join(folder, 'report.md'), 'Verified result')
  prepareFiles?.(folder)
  assert.match(await checked(h, request, 'test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
  assert.match(await checked(h, request, 'diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
  const stored = new Map()
  async function attachStore(host) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(host.home, 'review-attachments'), ...normalization })
    const store = ctx.get('attachments')
    const saveImage = store.saveImage.bind(store)
    store.saveImage = async input => {
      const ref = await saveImage(input)
      stored.set(ref.attachmentId, (await store.readImage(ref)).data)
      return ref
    }
    host.ctx.provided.set('attachments', store)
  }
  await attachStore(h)
  // Return actual exhausted paging for empty fake history.
  h.agentOf('solver').session.seq = 0
  async function send(host, images) {
    const call = inputs => host.tool('message_bot', { to: 'reviewer', message: 'Review the checked result.',
      solver_review: 'result', solver_request: request, ...(inputs ? { images: inputs } : {}) })
    const receipt = await call(images)
    // On the parent the Solve flow can only fall back to a text designation after
    // the selected result file is refused. The same fake still supplies its answer.
    if (receipt?.sent === false) await call()
    const row = host.agentOf('reviewer').message
    assert.equal(row?.source.exchangeId, host.rt.botOf('solver').reviewTrack.solver.review?.exchangeId)
    return { receipt, row }
  }
  return { ...f, folder, stored, attachStore, send }
}

function answeringReviewer(t, h, { native = false, capable = true, shared = false, expectedPicture = reviewPng, loopSession, wireImage } = {}) {
  const wire = wireImage !== undefined
  const route = wire ? { provider: 'acp-codex', model: 'gpt-6.2-astra' }
    : native ? reviewerModel : { provider: 'acp-review-fixture', model: 'default' }
  const { provider } = route
  const agent = h.agentOf('reviewer')
  agent.ctx.tools.register = () => () => {}
  const session = loopSession ?? Session.create(agent.id)
  const folder = shared ? h.rt.botOf('solver').workDir : join(h.home, 'reviewer-folder')
  mkdirSync(folder, { recursive: true })
  if (!loopSession) {
    session.header = { ...session.header, cwd: folder }
    session.requestHeader = () => ({ config: route })
  }
  agent.session = session
  h.ctx.agents = { get: id => h.agentOf(id) }
  h.ctx.llm.resolveModelInfo = async () => capable ? { inputModalities: ['text', 'image'] } : {}
  const projected = []
  const prompts = []
  const consume = async row => {
    const ref = row?.content.find(block => block.type === 'image')?.attachment
    return ref === undefined ? undefined : Buffer.from((await h.ctx.get('attachments').readImage(ref)).data)
  }
  const fakeProvider = {
    name: 'Fake reviewer', spawn: () => assert.fail('no native process'),
  }
  let adapter, readWire
  if (wire) {
    const trace = join(h.home, 'reviewer-wire.jsonl')
    const connector = join(h.home, 'reviewer-connector.mjs')
    const args = [trace, provider, wireImage ? 'result-image' : 'result-text']
    writeFileSync(trace, '')
    writeFileSync(connector, `process.argv.splice(2, Infinity, ...${JSON.stringify(args)}); await import(${JSON.stringify(wireFixture)});\n`)
    applyAcp(h.ctx, { dshTools: false }, {
      store: { binOf: pkg => pkg === '@agentclientprotocol/codex-acp' ? { path: connector, version: '1.0.0' } : undefined, update: async () => {} },
      find: name => name === 'codex' ? '/bin/false' : undefined,
      signedIn: async () => true,
    })
    adapter = h.ctx.adapters.at(-1).adapter
    h.ctx.acpAgents = h.ctx.provided.get('acpAgents')
    h.ctx.llm.resolveModelInfo = (id, model) => id === provider ? adapter.resolveModel(id, model) : { inputModalities: ['text', 'image'] }
    readWire = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } else if (!native) {
    adapter = new AcpAdapter(h.ctx, new Map([[provider, fakeProvider]]))
    h.ctx.acpAgents.promptImageCapability = (...args) => adapter.promptImageCapability?.(...args)
  }
  let nextRun = 0
  const replaceRun = () => {
    if (nextRun > 0) adapter.end(session.id, adapter.live.get(session.id))
    const run = new AgentRun({ name: 'Fake reviewer' })
    run.child = {}
    run.sessionId = `fake-run-${++nextRun}`
    run.init = { agentCapabilities: { promptCapabilities: { image: capable } } }
    run.gone = new Promise(() => {})
    run.conn = { prompt: async params => {
      prompts.push(structuredClone(params))
      const data = params.prompt.find(block => block.type === 'image')?.data
      const suffix = data && Buffer.from(data, 'base64').equals(expectedPicture) ? '\nPicture bytes verified.' : ''
      await run.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reviewAnswer + suffix } }, params.sessionId)
      return { stopReason: 'end_turn' }
    } }
    run.dispose = () => run.letGo(true)
    adapter.live.set(session.id, { run, provider, providerRow: fakeProvider, name: 'Fake reviewer', dshAgent: agent, session, initialized: true,
      asks: false, calls: new Set(), open: false })
  }
  if (adapter && !wire) {
    replaceRun()
    t.after(() => adapter.dispose())
  }
  const imageMiddleware = h.ctx.listeners.get('llm/stream').find(fn => {
    return fn.name === 'resultPictureStream' || fn.toString().includes('imagesAsTextOrPass')
  })
  async function* boundary(options) {
    projected.push(options.messages)
    if (adapter) yield* adapter.stream(options)
    else {
      const bytes = await consume(options.messages.findLast(row => row.source?.resultReview?.v === 1))
      prompts.push({ prompt: bytes ? [{ type: 'image', data: bytes.toString('base64') }] : [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reviewAnswer }
      yield { type: 'block-end', index: 0, block: content(reviewAnswer)[0] }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const dispatch = options => imageMiddleware(options, () => boundary(options))
  h.ctx.llm.stream = dispatch
  let attempt, nextAttempt = 0, revision = 0
  const frame = data => h.ctx.emit('agent/assistant-stream', { agent, frame: { ...data, revision: ++revision } })
  const enter = (row, turn) => {
    h.event('reviewer', 'turn/start', { turn })
    session.append('user/message', row, { surfaceOp: 'append' })
    h.takeInput('reviewer', row)
  }
  const generate = async (turn = h.rt.live.get('reviewer').turn) => {
    const options = markAgentLoopRequest({ ...route, sessionId: session.id, messages: session.deriveMessages() })
    if (attempt && !attempt.ended) frame({ type: 'end', attemptId: attempt.attemptId, outcome: { kind: 'abandoned' } })
    attempt = { attemptId: `reviewer:${++nextAttempt}`, turn, step: 1, stream: new AssistantStreamAccumulator() }
    frame({ type: 'start', attemptId: attempt.attemptId, turn, step: attempt.step })
    const chunks = await Array.fromAsync(dispatch(options))
    assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1)))
    for (const [index, chunk] of chunks.entries()) {
      const timed = attempt.stream.push({ time: index + 1, chunk })
      frame({ type: 'chunk', attemptId: attempt.attemptId, index, ...timed })
    }
    return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  }
  const answer = async (text, turn = 5, model = route, { solver = 'solver', committed = true } = {}) => {
    const prior = h.agentOf(solver).message
    if (model !== route) agent.session.requestHeader = () => ({ config: model })
    const data = { turn, step: 1, message: createAssistantMessage({ source: model, content: content(text) }),
      stream: attempt ? [...attempt.stream.snapshot()] : [] }
    const event = session.append('assistant/message', data, { surfaceOp: 'append' })
    h.event('reviewer', event.type, event.data, event.seq)
    if (attempt) {
      const seq = committed ? event.seq : event.seq + 1
      frame({ type: 'end', attemptId: attempt.attemptId, index: data.stream.length,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq } })
      attempt.ended = true
    }
    h.event('reviewer', 'turn/end', { turn, reason: { kind: 'completed' } })
    await until(() => h.agentOf(solver).message !== prior, { label: 'the reviewer’s answer in the Solver chat' })
    const reply = h.agentOf(solver).message
    h.event(solver, 'turn/start', { turn: turn + 1 })
    h.takeInput(solver, reply)
    h.finish(solver, 'Delivered the checked result.')
    return reply
  }
  return { enter, generate, answer, replaceRun, projected, prompts, session, route, dispatch, adapter, readWire }
}

for (const kind of ['Codex image', 'Codex text', 'pending ACP', 'native']) {
  test(`2133 ACP receipt ${kind}`, async t => {
    const { h, send, track } = await checkedVisualReview(t)
    const native = kind === 'native'
    const pending = kind === 'pending ACP'
    const capable = kind !== 'Codex text'
    const reviewer = answeringReviewer(t, h, native ? { native } : { wireImage: capable })
    const agent = h.agentOf('reviewer')
    if (native) delete agent.model.current
    else agent.model.current = () => reviewer.route
    if (pending) reviewer.session.requestHeader = () => ({ config: reviewerModel })

    if (!native && !pending) {
      const { adapter, route, session } = reviewer
      const warm = await Array.fromAsync(adapter.stream({ ...route, sessionId: session.id,
        messages: [{ role: 'user', content: content('Warm this reviewer session.') }] }))
      assert.equal(warm.at(-1).reason.kind, 'stop', JSON.stringify(warm.at(-1)))
      assert.equal(adapter.live.get(session.id).run.init.agentCapabilities.promptCapabilities.image, capable)
      assert.equal((await h.ctx.llm.resolveModelInfo(route.provider, route.model)).inputModalities, undefined)
    }

    const { receipt, row } = await send(h, [reviewPath])
    if (pending) {
      assert.deepEqual(reviewer.readWire(), [], 'a receipt must not start the selected ACP agent')
      assert.match(receipt, /Pictures count only if the reviewer's answering turn receives them\. Otherwise the RESULT stays unverified\./)
      assert.doesNotMatch(receipt, /cannot see pictures|accepts pictures/)
      return
    }
    h.finish('solver', 'Waiting for RESULT review.')
    reviewer.enter(row, 5)
    const answer = await reviewer.generate()
    const reply = await reviewer.answer(answer)
    const prompt = native ? reviewer.prompts[0].prompt : reviewer.readWire().findLast(entry => entry.method === 'session/prompt').prompt
    const image = prompt.find(block => block.type === 'image')
    if (capable) {
      assert.deepEqual(Buffer.from(image.data, 'base64'), reviewPng)
      assert.equal(track().solver.review.visualOk, true)
      assert.equal(track().last?.done, true)
      if (native) {
        assert.doesNotMatch(receipt, /cannot see pictures|accepts pictures|Pictures count only/)
      } else {
        t.diagnostic(`native ACP image sha256=${reviewDigest(reviewPng)} visualOk=true done=true`)
        assert.match(receipt, /The reviewer's ACP agent accepts pictures on this route\. A RESULT SHIP stays unverified if its answering turn does not receive them\./)
        assert.doesNotMatch(receipt, /cannot see pictures/)
      }
    } else {
      const ref = row.content.find(block => block.type === 'image').attachment
      assert.equal(image, undefined)
      const digest = ref.attachmentId.slice('sha256:'.length)
      const name = JSON.stringify(ref.name ?? 'image.png')
      const handle = prompt.find(block => block.type === 'text' && (block.text === textOnlyImageText(ref)
        || (block.text.startsWith(`[Image ${name} `) && block.text.includes('read-only copy saved at') && block.text.includes(digest))))
      assert.ok(handle, 'the ACP prompt provides a text handle for the intended picture')
      assert.equal(track().solver.review.unverified, 'images')
      assert.equal(track().last?.done, undefined)
      assert.match(reply.content.at(-1).text, /RESULT review is unverified/)
      assert.match(receipt, /The reviewer cannot see pictures on this route\. A RESULT SHIP will stay unverified if its answering turn cannot see the pictures\./)
    }
  })
}

for (const [reason, current] of Object.entries({
  'has no provider': () => ({ model: 'unknown' }),
  throws: () => { throw new Error('model unavailable') },
})) {
  test(`2133 ACP receipt is neutral when the current route ${reason}`, async t => {
    const { h, send } = await checkedVisualReview(t)
    const agent = h.agentOf('reviewer')
    agent.model.current = current
    const { receipt, row } = await send(h, [reviewPath])
    assert.equal(row.content.some(block => block.type === 'image'), true)
    assert.match(receipt, /Pictures count only if the reviewer's answering turn receives them\. Otherwise the RESULT stays unverified\./)
  })
}

for (const committed of [false, true]) {
  test(`2133 source 1 ${committed ? 'matching' : 'different'} committed attempt on the same route controls visual credit`, async t => {
    const f = await checkedVisualReview(t)
    const { h } = f
    const reviewer = answeringReviewer(t, h)
    const { row } = await f.send(h, [reviewPath])
    h.finish('solver', 'Waiting for RESULT review.')
    reviewer.enter(row, 5)
    await reviewer.generate()
    const text = await reviewer.generate()
    if (committed) reviewer.session.requestHeader = () => ({ config: solverModel })
    await reviewer.answer(text, 5, reviewer.route, { committed })
    assert.equal(f.track().solver.review.verdict, committed ? 'SHIP' : 'unverified')
    assert.equal(f.track().solver.review.imagesWhy, committed ? undefined : 'lost')
    assert.equal(f.track().last?.done, committed ? true : undefined)
  })
}

test('2133 source 1 the pinned AgentLoop settles the joined native proof with its committed sequence', async t => {
  const f = await checkedVisualReview(t)
  const { h } = f
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  class ReviewModel extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
    stream() { assert.fail('the reviewer prompt stays inside the fixture') }
  }
  ctx.llm.registerAdapter([reviewerModel.provider], new ReviewModel())
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create('reviewer', reviewerModel)
  const reviewer = answeringReviewer(t, h, { native: true, loopSession: agent.session })
  const frames = []
  ctx.on('llm/stream', options => reviewer.dispatch(options))
  ctx.on('agent/assistant-stream', payload => {
    frames.push(payload.frame)
    h.ctx.emit('agent/assistant-stream', payload)
  })
  ctx.on('agent/inbox/claimed', payload => h.ctx.emit('agent/inbox/claimed', payload))
  ctx.on('session/event', (session, event) => {
    if (session === agent.session) h.event('reviewer', event.type, event.data, event.seq)
  })
  const { row } = await f.send(h, [reviewPath])
  h.finish('solver', 'Waiting for RESULT review.')
  const prior = h.agentOf('solver').message
  agent.followup(row)
  await agent.whenIdle()
  const committed = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
  assert.ok(committed?.data.stream.length)
  const start = frames.find(frame => frame.type === 'start')
  const end = frames.find(frame => frame.type === 'end' && frame.attemptId === start.attemptId)
  assert.equal(start.turn, committed.data.turn)
  assert.equal(start.step, committed.data.step)
  assert.deepEqual(end?.outcome, { kind: 'committed', eventType: 'assistant/message', seq: committed.seq })
  assert.deepEqual(Buffer.from(reviewer.prompts[0].prompt[0].data, 'base64'), reviewPng)
  await until(() => h.agentOf('solver').message !== prior, { label: 'the pinned loop’s reviewer reply' })
  h.event('solver', 'turn/start', { turn: 7 })
  h.takeInput('solver', h.agentOf('solver').message)
  h.finish('solver', 'Delivered the checked result.')
  assert.equal(f.track().last?.done, true)
})

test('2133 source 4 the normalized result ID earns visual credit on the answering attempt', async t => {
  const f = await checkedVisualReview(t, { normalization: { normalizedImageMaxDimension: 1 } })
  const { h } = f
  const { row } = await f.send(h, [reviewPath])
  const ref = row.content.find(block => block.type === 'image')?.attachment
  assert.ok(ref, 'the normalized result is on the real review row')
  const sourceDigest = reviewDigest(reviewPng)
  assert.notEqual(ref.attachmentId, `sha256:${sourceDigest}`)
  const bytes = f.stored.get(ref.attachmentId)
  assert.equal(ref.attachmentId, `sha256:${reviewDigest(bytes)}`)
  const reviewer = answeringReviewer(t, h, { expectedPicture: bytes })
  h.finish('solver', 'Waiting for RESULT review.')
  reviewer.enter(row, 5)
  const text = await reviewer.generate()
  assert.match(text, /Picture bytes verified/)
  await reviewer.answer(text)
  assert.deepEqual(f.track().solver.review.images.required, [{ path: reviewPath, digest: sourceDigest, attachmentId: ref.attachmentId }])
  assert.equal(f.track().last?.done, true)
})

test('2133 source 6 a second Solver queued to the reviewer earns credit on its first dispatch', async t => {
  const f = await checkedVisualReview(t, { path: 'result.png' })
  const { h } = f
  const other = h.rt.botOf('other')
  const { review, ...progress } = f.track().solver
  const request = 'queued-solver-request'
  Object.assign(other, {
    role: 'Solver', reviewerId: 'reviewer', workDir: f.folder,
    reviewTrack: { requested: true, requestAt: 1, verdicts: [], solver: { ...structuredClone(progress), request } },
  })
  const reviewer = answeringReviewer(t, h, { native: true })
  const first = await f.send(h, ['result.png'])
  h.agentOf('other').session.seq = 0
  assert.match(await h.tool('message_bot', { to: 'reviewer', message: 'Review the queued result.',
    solver_review: 'result', solver_request: request, images: ['result.png'] }, 'other'), /with 1 picture/)
  const queued = h.agentOf('reviewer').message
  assert.notEqual(queued.source.exchangeId, first.row.source.exchangeId)
  reviewer.enter(first.row, 5)
  await reviewer.generate()
  assert.equal(reviewer.prompts.length, 1)
  assert.equal(reviewer.projected[0].some(row => row.source?.exchangeId === queued.source.exchangeId), false)
  assert.equal(other.reviewTrack.solver.review.verdict, undefined)
  reviewer.enter(queued, 7)
  await reviewer.answer(await reviewer.generate(), 7, reviewer.route, { solver: 'other' })
  assert.equal(other.reviewTrack.solver.review.verdict, 'SHIP')
  assert.equal(other.reviewTrack.last?.done, true)
  assert.equal(f.track().solver.review.verdict, undefined)
})

for (const [id, options] of Object.entries({
  'E1 Test 5 T2a': { capable: false, why: 'unseen' },
  E2: { capable: true, shared: true },
  E3: { native: true },
  'E4 Test 8': { capable: false, text: true },
  'E5 Test 6': { omit: true, why: 'missing' },
  E6: { replaces: true, why: 'lost' },
  'Test 7': { changesRoute: true, why: 'lost' },
  T2b: { missingRoute: true, why: 'lost' },
  T3a: { omit: true, why: 'missing' },
  T3b: { omit: true, path: 'old.png', why: 'missing' },
})) {
  test(`2133 ${id} follows the received prompt and answer through the delivery mark`, async t => {
    const f = await checkedVisualReview(t, { path: options.text ? null : options.path })
    const { h, track } = f
    const reviewer = answeringReviewer(t, h, { ...options, stored: f.stored })
    if (id.startsWith('E1')) h.agentOf('reviewer').model.current = () => reviewer.route
    const priorVerdicts = structuredClone(track().verdicts)
    const selector = options.text || options.omit ? undefined : [options.path ?? reviewPath]
    const { receipt, row } = await f.send(h, selector)
    h.finish('solver', 'Waiting for RESULT review.')
    reviewer.enter(row, 5)
    let text = await reviewer.generate()
    if (options.replaces) {
      reviewer.replaceRun()
      text = await reviewer.generate()
      assert.notEqual(reviewer.prompts[0].sessionId, reviewer.prompts[1].sessionId)
    }
    const replyingModel = options.missingRoute ? {} : options.changesRoute ? { provider: 'fake', model: 'changed' } : undefined
    const reply = await reviewer.answer(text, 5, replyingModel)
    const result = track().solver.review
    const sentImage = reviewer.prompts[0].prompt.find(block => block.type === 'image')
    if (options.why) {
      assert.equal(result.verdict, 'unverified', 'a visual SHIP must be withheld')
      assert.equal(result.unverified, 'images')
      assert.equal(result.imagesWhy, options.why)
      assert.deepEqual(track().verdicts, priorVerdicts)
      assert.equal(track().last?.done, undefined)
      assert.equal(track().last?.result, false)
      assert.match(reply.content.at(-1).text, /RESULT review is unverified/)
      assert.equal(h.rt.solverStatusOf(h.rt.botOf('solver')).solverStatus.imagesWhy, options.why)
      if (id.startsWith('E1')) {
        assert.match(receipt, /reviewer cannot see pictures/)
        assert.equal(sentImage, undefined)
      }
      if (id.startsWith('E5')) assert.match(receipt, /art\.png/)
      if (id === 'E6') assert.deepEqual(Buffer.from(sentImage.data, 'base64'), reviewPng)
    } else {
      assert.equal(result.verdict, 'SHIP')
      assert.equal(track().last?.done, true)
      assert.equal(track().last?.result, true)
      assert.equal(track().verdicts.length, priorVerdicts.length + 1)
      if (!options.text) {
        assert.deepEqual(Buffer.from(sentImage?.data ?? '', 'base64'), reviewPng, 'the real boundary received result PNG bytes')
        assert.ok(reviewer.projected[0].some(row => row.content.some(block =>
          block.attachment?.attachmentId === `sha256:${reviewDigest(reviewPng)}`)))
      } else assert.equal(sentImage, undefined)
    }
  })
}

test('2133 E7 a real text-only resume loses visual credit and a fresh designation earns it', async t => {
  const f = await checkedVisualReview(t)
  const { h, request } = f
  const reviewer = answeringReviewer(t, h, { stored: f.stored })
  const { row } = await f.send(h, [reviewPath])
  h.finish('solver', 'Waiting for RESULT review.')
  reviewer.session.append('turn/start', { turn: 5 })
  reviewer.enter(row, 5)
  await reviewer.generate()
  reviewer.session.append('turn/end', { turn: 5, reason: { kind: 'interrupted' } })
  await h.rt.save({ required: true, durable: true })
  assert.equal(await h.rt.flushUpdateNotes(), true)
  await h.close()

  const next = fixture(t, h.home)
  next.ctx.sessionController.inspect = async id => ({
    events: id === 'reviewer' ? reviewer.session.snapshotEvents(0, reviewer.session.seq) : [],
  })
  await next.rt.load()
  await f.attachStore(next)
  next.agentOf('solver').session.seq = 0
  const waiting = setInterval(() => {}, 1000)
  try { await next.rt.resumesDone } finally { clearInterval(waiting) }
  const resumed = next.agentOf('reviewer').message
  assert.equal(resumed?.source.exchangeId, row.source.exchangeId, JSON.stringify(resumed?.source))
  assert.equal(resumed.source.resumed, true)
  assert.equal(resumed.content.some(block => block.type === 'image'), false)
  const work = next.rt.state.works[resumed.source.exchangeId]
  assert.equal(next.rt.designatedReplyRequest('solver', 'reviewer', resumed.source.exchangeId, work), request,
    JSON.stringify({ work, track: next.rt.botOf('solver').reviewTrack }))
  const newReviewer = answeringReviewer(t, next, { stored: f.stored })
  newReviewer.enter(resumed, 7)
  const track = () => next.rt.botOf('solver').reviewTrack
  const resumedText = await newReviewer.generate()
  assert.match(resumedText, /^RESULT SHIP/)
  const resumedReply = await newReviewer.answer(resumedText, 7)
  assert.equal(track().solver.review.verdict, 'unverified')
  assert.equal(track().solver.review.imagesWhy, 'lost', JSON.stringify({
    source: resumedReply.source, resultFolder: next.rt.botOf('solver').workDir, expectedFolder: f.folder,
    images: track().solver.review.images, checked: track().solver.snapshot,
    current: inspectResult(f.folder, { manifest: true, botId: 'solver' }),
  }))
  assert.equal(track().last?.result, false)
  assert.equal(track().last?.done, undefined)
  assert.equal(await requestOf(next), request)
  const fresh = await f.send(next, [reviewPath])
  assert.notEqual(fresh.row.source.exchangeId, resumed.source.exchangeId)
  newReviewer.enter(fresh.row, 9)
  await newReviewer.answer(await newReviewer.generate(), 9)
  assert.equal(track().last?.done, true)
  assert.equal(track().last?.resultExchangeId, fresh.row.source.exchangeId)
  await next.close()
})

test('2133 T2c visual FIX-FIRST and BLOCKED remain recorded vetoes', async t => {
  for (const veto of ['FIX-FIRST', 'BLOCKED']) {
    await t.test(veto, async t => {
      const f = await checkedVisualReview(t)
      const reviewer = answeringReviewer(t, f.h, { native: true, stored: f.stored })
      const { row } = await f.send(f.h)
      f.h.finish('solver', 'Waiting for the review.')
      reviewer.enter(row, 5)
      await reviewer.answer(`RESULT ${veto}`)
      assert.equal(f.track().solver.review.verdict, veto)
      assert.equal(f.track().verdicts.at(-1).verdict, veto)
      assert.equal(f.track().last?.done, undefined)
    })
  }
})

test('2133 T2d a pending pre-upgrade visual designation requires a fresh review', async t => {
  const f = await checkedVisualReview(t)
  const reviewer = answeringReviewer(t, f.h, { native: true, stored: f.stored })
  const { row } = await f.send(f.h)
  delete f.track().solver.review.images
  delete f.track().solver.imageBase
  f.h.finish('solver', 'Waiting for the review.')
  reviewer.enter(row, 5)
  const reply = await reviewer.answer(reviewAnswer)
  assert.equal(f.track().solver.review.unverified, 'images')
  assert.equal(f.track().solver.review.imagesWhy, 'missing')
  assert.match(reply.content.at(-1).text, /fresh RESULT review/)
  assert.equal(f.track().last?.result, false)
  const fresh = await f.send(f.h, [reviewPath])
  assert.notEqual(fresh.row.source.exchangeId, row.source.exchangeId)
  reviewer.enter(fresh.row, 7)
  await reviewer.answer(await reviewer.generate(), 7)
  assert.equal(f.track().last?.done, true)
})

test('2133 T2e a complete legacy scan credits only an old text-only SHIP', async t => {
  for (const path of [null, reviewPath]) {
    await t.test(path ?? 'definite text control', async t => {
      const f = await checkedVisualReview(t, { path })
      const { row } = await f.send(f.h)
      const track = f.track()
      const result = track.solver.review
      delete result.images
      delete track.solver.imageBase
      result.verdict = 'SHIP'
      result.reviewer = { id: 'reviewer', name: 'reviewer', model: refOf(reviewerModel) }
      track.verdicts.push({ verdict: 'SHIP', at: Date.now() + 10 })
      f.h.rt.dropWork(row.source.exchangeId)
      f.h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request: f.request })
      assert.equal(f.track().last?.done, path ? undefined : true)
      assert.equal(f.track().last?.result, path ? false : true)
      assert.equal(f.track().delivered === true, !path)
      if (path) {
        const { h, request } = f
        await h.rt.reviewRequest('solver', { text: 'Please clarify the checked result.' })
        h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
        assert.equal(f.track().last?.result, false, 'the legacy SHIP stays out of the next delivery mark')
        assert.notEqual(f.track().delivered, true)
        assert.equal(await requestOf(h), request)
        assert.match(await checked(h, request, 'fresh-test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
        assert.match(await checked(h, request, 'fresh-diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
        const reviewer = answeringReviewer(t, h)
        const fresh = await f.send(h, [path])
        assert.notEqual(fresh.row.source.exchangeId, row.source.exchangeId)
        h.finish('solver', 'Waiting for the fresh RESULT review.')
        reviewer.enter(fresh.row, 7)
        await reviewer.answer(await reviewer.generate(), 7)
        assert.equal(f.track().last?.done, true)
        assert.equal(f.track().last?.resultExchangeId, fresh.row.source.exchangeId)
      }
    })
  }
})

test('2133 T2f an already delivered legacy track stays unchanged', async t => {
  const f = await checkedVisualReview(t)
  const { row } = await f.send(f.h)
  delete f.track().solver.review.images
  const prior = { at: 17, review: 'bot', plan: true, result: true, done: true, resultExchangeId: row.source.exchangeId }
  f.track().last = prior
  f.track().outcome = { done: true, exchangeId: row.source.exchangeId }
  f.track().delivered = true
  const stored = structuredClone(f.track())
  f.h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request: f.request })
  assert.deepEqual(f.track(), stored)
})

test('2133 exception 5 a first follow-up preserves restored visual verification', async t => {
  for (const [legacy, { verdictCount, workOffset, resultCredit } = {}] of [
    ['visual SHIP'],
    ['unverified images'],
    ['definite text SHIP'],
    ['delivered SHIP'],
    ['definite text SHIP with one verdict and no work', { verdictCount: 1, resultCredit: false }],
    ['definite text SHIP with two verdicts and no work', { verdictCount: 2 }],
    ['definite text SHIP after observed work', { verdictCount: 1, workOffset: -1 }],
    ['definite text SHIP at the last observed work time', { verdictCount: 2, workOffset: 0, resultCredit: false }],
  ]) {
    await t.test(legacy, async t => {
      const textOnly = legacy.startsWith('definite text SHIP')
      const delivered = legacy === 'delivered SHIP'
      const f = await checkedVisualReview(t, { path: textOnly ? null : reviewPath })
      const { h, request } = f
      const { row } = await f.send(h)
      const restored = structuredClone(f.track())
      const result = restored.solver.review
      delete result.images
      delete restored.solver.imageBase
      delete restored.solver.visualReviewRequired
      result.verdict = 'SHIP'
      result.reviewer = { id: 'reviewer', name: 'reviewer', model: refOf(reviewerModel) }
      const shipAt = Date.now() + 10
      if (verdictCount !== undefined) {
        restored.verdicts = verdictCount === 2 ? [{ verdict: 'SHIP', at: shipAt - 2 }] : []
        delete restored.firstWorkAt
        delete restored.lastWorkAt
        if (workOffset !== undefined) restored.lastWorkAt = shipAt + workOffset
      }
      restored.verdicts.push({ verdict: 'SHIP', at: shipAt })
      if (legacy === 'unverified images') {
        result.verdict = 'unverified'
        result.unverified = 'images'
        result.imagesWhy = 'missing'
      }
      if (delivered) {
        restored.delivered = true
        restored.last = { at: 17, review: 'bot', plan: true, result: true, done: true, resultExchangeId: row.source.exchangeId }
      }
      h.rt.botOf('solver').reviewTrack = restored
      h.rt.dropWork(row.source.exchangeId)
      await h.rt.reviewRequest('solver', { text: 'Please clarify the checked result.' })
      if (delivered) {
        assert.notEqual(await requestOf(h), request)
        assert.deepEqual(f.track().last, restored.last)
        assert.equal(f.track().solver.visualReviewRequired, undefined)
        return
      }
      assert.equal(f.track().solver.review, undefined)
      h.rt.reviewTurnEnd('solver', { completed: true, wroteText: true, model: refOf(solverModel), request })
      assert.equal(f.track().last?.result, resultCredit ?? textOnly, 'legacy RESULT credit follows the restored verdict history')
      assert.equal(f.track().delivered === true, textOnly)
      assert.equal(f.track().solver.visualReviewRequired === true, !textOnly)
      if (textOnly) return
      assert.equal(await requestOf(h), request)
      assert.match(await checked(h, request, 'fresh-test', { check: 'average-test', command: 'node --test average.test.mjs' }), /^Recorded\./)
      assert.match(await checked(h, request, 'fresh-diff', { check: 'diff-check', command: 'git diff --check' }), /^Recorded\./)
      const reviewer = answeringReviewer(t, h, { stored: f.stored })
      const fresh = await f.send(h, [reviewPath])
      assert.notEqual(fresh.row.source.exchangeId, row.source.exchangeId)
      h.finish('solver', 'Waiting for the fresh RESULT review.')
      reviewer.enter(fresh.row, 7)
      await reviewer.answer(await reviewer.generate(), 7)
      assert.equal(f.track().solver.visualReviewRequired, undefined)
      assert.equal(f.track().last?.done, true)
      assert.equal(f.track().last?.resultExchangeId, fresh.row.source.exchangeId)
      assert.equal(f.track().delivered, true)
    })
  }
})

test('2133 T3c an unrelated forwarded image cannot verify the checked result', async t => {
  const f = await checkedVisualReview(t)
  const { h } = f
  const reviewer = answeringReviewer(t, h, { stored: f.stored })
  const data = Buffer.concat([reviewPng, Buffer.from('unrelated')])
  const ref = await h.ctx.get('attachments').saveImage({ data, mediaType: 'image/png', name: 'unrelated.png' })
  h.rt.eventsBackwards = async function* (_id, _signal, _cap, exhausted) {
    yield { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] } }
    exhausted?.()
  }
  const { row } = await f.send(h, ['unrelated.png'])
  assert.ok(row.content.some(block => block.attachment?.attachmentId === ref.attachmentId))
  h.finish('solver', 'Waiting for the review.')
  reviewer.enter(row, 5)
  await reviewer.answer(await reviewer.generate())
  assert.equal(f.track().solver.review.imagesWhy, 'missing')
  assert.equal(f.track().last?.done, undefined)
  assert.deepEqual(f.track().solver.review.images.carried, [])
})

for (const fault of ['missing baseline', 'indeterminate head', 'five pictures']) {
  test(`2133 T3d ${fault} keeps the visual result unverified`, async t => {
    const f = await checkedVisualReview(t, {
      prepareFiles(folder) {
        if (fault === 'indeterminate head') writeFileSync(join(folder, 'metadata'), 'checked')
        if (fault === 'five pictures') {
          for (let i = 1; i <= 4; i++) writeFileSync(join(folder, `image-${i}.png`), reviewPng)
        }
      },
    })
    const { h } = f
    const reviewer = answeringReviewer(t, h, { native: true, stored: f.stored })
    if (fault === 'missing baseline') delete f.track().solver.imageBase
    let mock
    if (fault === 'indeterminate head') {
      const open = fs.openSync
      mock = t.mock.method(fs, 'openSync', (path, ...args) => {
        if (String(path).endsWith('/metadata')) throw Object.assign(new Error('mocked metadata read error'), { code: 'EIO' })
        return open(path, ...args)
      })
      syncBuiltinESMExports()
    }
    try {
      const { row } = await f.send(h)
      h.finish('solver', 'Waiting for the review.')
      reviewer.enter(row, 5)
      await reviewer.answer(await reviewer.generate())
      assert.equal(f.track().solver.review.imagesWhy, 'missing')
      assert.equal(f.track().last?.result, false)
      assert.equal(f.track().last?.done, undefined)
    } finally {
      mock?.mock.restore()
      syncBuiltinESMExports()
    }
  })
}

test('2133 T3e only a verified host copy preserves the check snapshot in a shared folder', async t => {
  const f = await checkedVisualReview(t)
  f.h.rt.botOf('reviewer').workDir = f.folder
  const reviewer = answeringReviewer(t, f.h, { shared: true, stored: f.stored })
  const userPicture = await f.h.ctx.get('attachments').saveImage({ data: reviewPng, mediaType: 'image/png', name: 'received.png' })
  const copied = await f.h.rt.sharedUploads.withPaths([{
    role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: userPicture }],
  }], 'reviewer', 'fake')
  assert.match(copied[0].content.at(-1).text, /read-only copy/)
  const { row } = await f.send(f.h, [reviewPath])
  f.h.finish('solver', 'Waiting for the review.')
  reviewer.enter(row, 5)
  const text = await reviewer.generate()
  const path = join(f.folder, '.automagik', 'uploads', reviewDigest(reviewPng), 'art.png')
  assert.deepEqual(readFileSync(path), reviewPng)
  fs.chmodSync(path, 0o600)
  writeFileSync(path, Buffer.concat([reviewPng, Buffer.from('tampered')]))
  await reviewer.answer(text)
  assert.equal(f.track().outcome?.reason, 'checks')
  assert.equal(f.track().last?.done, undefined)
})
