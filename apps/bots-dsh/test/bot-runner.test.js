import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as FirstPromptTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as todo from '@deepseek-ai/dsh-tool-todo'
import * as workspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import { createRuntime } from '../index.js'
import { callAside } from '../src/host/btw.js'
import { fallbackFor } from '../src/host/fallback.js'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'
import { scopeWith, sessionScope } from '../src/host/member-wall/principals.js'
import * as scopeFiles from '../src/host/read-scope-files.js'
import { createRoleRuntime } from '../src/host/role-runtime.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'
import { until } from './until.js'

const BOT = 'b-aaaaaaaaaa'
const CHAT = 'writer-chat'
const OWNER = 'owner-chat'
const CODE = 'bot/no-runner'
const MESSAGE = 'ds-bot: this workspace has no Bot runner yet, so a Bot runs no commands, terminals, coding CLIs, browsers or extensions in multiuser mode (RFC 0038)'
const refusal = { code: CODE, message: MESSAGE }
const noWall = { code: CODE, message: /no member wall/ }

const team = () => ({
  version: 1,
  revision: 1,
  mainBotIds: [BOT],
  bots: { [BOT]: { id: BOT, sessionId: CHAT, name: 'Writer', createdAt: 1, role: '', instructions: '', shell: true, model: 'acp-claude/default', appliedModel: 'acp-claude/default', previousModel: 'native/current' } },
  rooms: {}, tasks: {}, exchanges: [], exchangeTurns: {}, questions: {},
  capabilities: { items: {} }, prefs: {},
})

function setup(t, mode, { state = team(), recordedSessions, home = mkdtempSync(join(tmpdir(), 'dsb-runner-')), reuse = false, services = {}, config = {} } = {}) {
  const previous = process.env.AUTOMAGIK_MULTIUSER
  if (mode === undefined) delete process.env.AUTOMAGIK_MULTIUSER
  else process.env.AUTOMAGIK_MULTIUSER = mode
  if (!reuse) writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  if (recordedSessions !== undefined) {
    writeFileSync(join(home, 'multiuser-bot-sessions.json'), JSON.stringify({ version: 1, sessions: recordedSessions }), { mode: 0o600 })
  }
  const ctx = fakeContext({ services })
  const on = ctx.on
  // fakeContext records registrations, while Cordis runs the newest prepended hook first.
  ctx.on = (name, listener, options) => {
    on(name, listener, options)
    const listeners = ctx.listeners.get(name)
    if (options?.prepend) listeners.unshift(listeners.pop())
    return () => ctx.listeners.set(name, listeners.filter(candidate => candidate !== listener))
  }
  const agents = new Map()
  ctx.workspaceRegistry = new Map()
  const add = (id, header = { id, origin: 'user', cwd: home }) => {
    const agent = ctx.scopeAgent(id)
    agent.session.header = header
    agents.set(id, agent)
    return agent
  }
  const bot = add(CHAT)
  const owner = add(OWNER)
  ctx.sessions = { get: id => agents.get(id)?.session, list: () => [...agents.values()].map(agent => agent.session) }
  ctx.sessionController = { resolveAgent: async id => ({ agent: agents.get(id) }) }
  ctx.tools.get = name => ctx.registeredTools.get(name)
  const warnings = []
  ctx.logger.warn = (_format, line) => warnings.push(line)
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, ...config })
  ctx.provided.set('omniTeam', rt)
  rt.resolveAgent = async id => agents.get(id)
  const stop = async () => { rt.dispose(); await ctx.dispose() }
  t.after(async () => {
    await stop()
    if (!reuse) rmSync(home, { recursive: true, force: true })
    if (previous === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = previous
  })
  const waterfall = (event, payload, next) => [...ctx.listeners.get(event) ?? []].reverse()
    .reduce((downstream, listener) => () => listener(payload, downstream), next)()
  return { rt, ctx, home, add, bot, owner, waterfall, stop, warnings }
}

for (const mode of [undefined, '', '0']) {
  test(`desktop flag ${String(mode)} leaves Bot tool dispatch available`, async t => {
    const { rt, ctx, bot, waterfall } = setup(t, mode)
    await rt.load()
    assert.equal(rt.botRunnerRequired, undefined)
    assert.ok(!['tools/pre-execute', 'tools/execute'].some(event => ctx.listeners.get(event).some(listener => listener.name === 'admitTool')))
    const next = t.mock.fn(() => 'executed')
    assert.equal(await waterfall('tools/execute', { agent: bot, name: 'bash', arguments: { command: 'fixture' } }, next), 'executed')
    assert.equal(next.mock.callCount(), 1)
  })
}

test('rollback holds a recorded Bot and admits an owner without consulting external ownership', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-runner-'))
  writeFileSync(join(home, 'multiuser-mode.json'), JSON.stringify({ version: 1, mode: 'on' }))
  const recorded = 'recorded-only'
  const { rt, owner, add, waterfall } = setup(t, '0', { home, recordedSessions: { [recorded]: BOT } })
  const bot = add(recorded)
  const external = t.mock.fn(() => { throw new Error('ownership lookup failed') })
  t.after(rt.hooks.sessionOwner(external))
  await rt.load()

  assert.equal(rt.botRunnerRequired, undefined)
  assert.equal(rt.multiuserHold(), true)
  assert.equal(rt.botOfSession(recorded, bot), undefined)
  const next = t.mock.fn(() => 'ran')
  for (const [event, payload] of [
    ['agent/pre-step', { messages: [], signal: new AbortController().signal, modelSelection: { provider: 'native' } }],
    ['tools/execute', { name: 'bash', arguments: { command: 'fixture' } }],
  ]) {
    await assert.rejects(async () => waterfall(event, { ...payload, agent: bot }, next), /Bots are held/)
    assert.equal(await waterfall(event, { ...payload, agent: owner }, next), 'ran')
  }
  assert.equal(next.mock.callCount(), 2)
  assert.equal(external.mock.callCount(), 0)
})

test('the no-runner tool guard precedes approval and dispatch', async t => {
  const { rt, ctx, bot, owner, add, waterfall } = setup(t, 'false')
  await rt.load()
  const child = add('child', { id: 'child', origin: 'subagent', parentSession: CHAT })
  const personChild = add('person-child', { id: 'person-child', origin: 'subagent', parentSession: OWNER })
  const preExecute = 'tools/pre-execute'
  const sentinel = t.mock.fn((_payload, next) => next())
  // An earlier installation would be behind the runner even if it prepended.
  ctx.listeners.get(preExecute).splice(1, 0, sentinel)
  const next = t.mock.fn(() => 'executed')
  const names = [
    'bash', 'pwsh', 'terminal_create', 'user_terminal_write', 'run_code', 'browser_open', 'browser_exec',
    'read_browser', 'cua', 'computer_handoff', 'start_task', 'attach_capability', 'approve_agent_action',
    'mcp__x__y', 'unknown', 'office_render', 'office_convert', 'office_recalculate', 'schedule_create',
    'schedule_edit', 'glob', 'grep', 'read_image',
  ]
  for (const name of names) {
    await assert.rejects(async () => waterfall(preExecute, { name, agent: bot, arguments: {} }, next), refusal, name)
  }
  for (const agent of [child, { id: 'unknown-session' }, undefined]) {
    await assert.rejects(async () => waterfall(preExecute, { name: 'bash', agent, arguments: {} }, next), refusal)
  }
  await assert.rejects(async () => waterfall('tools/execute', { name: 'bash', agent: bot, arguments: {} }, next), refusal)
  assert.equal(sentinel.mock.callCount(), 0)
  assert.equal(next.mock.callCount(), 0)

  for (const agent of [owner, personChild]) {
    for (const name of names) assert.equal(await waterfall(preExecute, { name, agent, arguments: {} }, next), 'executed')
  }
  assert.equal(sentinel.mock.callCount(), names.length * 2)
  assert.equal(next.mock.callCount(), names.length * 2)
})

test('the tool guard admits the shipped in-process definitions and refuses shadows and command arguments', async t => {
  const recorded = 'recorded-only'
  const { rt, ctx, bot, owner, add, home } = setup(t, '1', { recordedSessions: { [recorded]: BOT } })
  const older = add(recorded)
  await rt.load()
  ctx.inject = (_deps, fn) => fn(ctx)
  ctx.systemPrompt.getSectionOrder = () => 0
  const get = ctx.get
  ctx.get = name => name === 'fs' ? ctx.fs : get(name)
  const botsRoot = join(home, 'bot-folders')
  mkdirSync(botsRoot, { mode: 0o700 })
  const principalsFile = join(home, 'wall', 'principals.json')
  // The record's folder must be private to DSH (#1908's reader checks it).
  mkdirSync(join(home, 'wall'), { mode: 0o700 })
  chmodSync(join(home, 'wall'), 0o700)
  writeFileSync(principalsFile, JSON.stringify({
    version: 2, instance: 'fixture', sessions: { [CHAT]: `bot:${BOT}`, [recorded]: 'owner', [OWNER]: 'owner' },
  }), { mode: 0o600 })
  // Restored once, after every wall of this test.
  const instance = process.env.AUTOMAGIK_INSTANCE_ID
  t.after(() => {
    if (instance === undefined) delete process.env.AUTOMAGIK_INSTANCE_ID
    else process.env.AUTOMAGIK_INSTANCE_ID = instance
  })
  const createWall = async config => {
    const root = new Context()
    t.after(() => root.fiber.dispose())
    root.provide('sandboxPolicy', {})
    root.provide('automagikBotSessions', ctx.provided.get('automagikBotSessions'))
    // The wall trusts the record only through the writer it agrees with (multiuser-dsh, #1908).
    if (config.principalsFile !== undefined) {
      const { dev, ino } = statSync(dirname(config.principalsFile), { bigint: true })
      root.provide('automagikPrincipalRecord', Object.freeze({
        version: 1, file: config.principalsFile, instance: 'fixture', folder: `${dev}:${ino}`,
      }))
    }
    process.env.AUTOMAGIK_INSTANCE_ID = 'fixture'
    await root.plugin(MemberWallFileSystem, config)
    return root.fs
  }
  const wall = await createWall({
    cwd: home, members: true, bots: true, botsRoot, membersRoot: join(home, 'members'),
    principalsFile, instanceId: 'fixture',
  })
  ctx.fs = wall
  scopeFiles.apply(ctx, scopeFiles.Config({ applyPatch: true }))
  const guard = ctx.listeners.get('tools/pre-execute')[0]
  const next = t.mock.fn(() => 'executed')
  for (const name of ['read', 'write', 'edit', 'apply_patch', 'list_bots', 'message_bot', 'remember', 'recall']) {
    assert.equal(guard({ name, agent: bot, arguments: {} }, next), 'executed', name)
  }
  assert.throws(() => guard({ name: 'read_image', agent: bot, arguments: {} }, next), refusal)
  assert.throws(() => guard({ name: 'read', arguments: {} }, next), noWall)
  const ownerFile = join(home, 'owner-only.txt')
  writeFileSync(ownerFile, 'owner data')
  assert.equal(rt.botOfSession(recorded, older), undefined)
  assert.equal(ctx.provided.get('automagikBotSessions').botOf(recorded), BOT)
  assert.deepEqual(wall.principals([recorded]), [{ kind: 'bot', id: undefined }])
  for (const name of ['read', 'write']) {
    const options = { write: name === 'write' }
    assert.equal(sessionScope.run(scopeWith(recorded), () => wall.open(ownerFile, '/', options)), false)
    assert.throws(() => guard({ name, agent: older, arguments: { path: ownerFile } }, assert.fail),
      { code: CODE, message: /no effective Bot file principal/ })
    assert.equal(guard({ name, agent: owner, arguments: { path: ownerFile } },
      () => sessionScope.run(scopeWith(OWNER), () => wall.open(ownerFile, '/', options))), true)
  }
  assert.equal(readFileSync(ownerFile, 'utf8'), 'owner data')
  for (const fs of [
    Object.create(LocalFileSystem.prototype),
    await createWall({ cwd: home }),
    await createWall({
      cwd: home, members: true, membersRoot: join(home, 'members'), principalsFile,
    }),
  ]) {
    ctx.fs = fs
    assert.throws(() => guard({ name: 'read', agent: bot, arguments: {} }, next), noWall)
  }
  ctx.fs = wall
  for (const name of ['read', 'remember']) {
    assert.throws(() => guard({ name, agent: bot, arguments: { command: 'fixture' } }, next), refusal)
    ctx.registeredTools.set(name, { name })
    assert.throws(() => guard({ name, agent: bot, arguments: {} }, next), refusal)
  }
  assert.equal(next.mock.callCount(), 8)
})

test('external Bot ownership and its child are restricted while a person keeps tools and providers', async t => {
  const { rt, ctx, owner, add, waterfall } = setup(t, '1')
  const external = add('external')
  const child = add('external-child', { origin: 'subagent', parentSession: external.id })
  const changing = add('changing')
  const unreadable = add('unreadable')
  let alternate = false
  const remove = rt.hooks.sessionOwner(id => {
    if (id === external.id) return { botId: BOT, label: 'External Bot' }
    if (id === changing.id && (alternate = !alternate)) return { botId: BOT }
    if (id === unreadable.id) throw new Error('ownership lookup failed')
    return undefined
  })
  t.after(remove)
  await rt.load()
  const { botOf } = ctx.provided.get('automagikBotSessions')
  assert.deepEqual([external, child, changing, unreadable, owner].map(agent => botOf(agent.id)),
    [BOT, BOT, undefined, undefined, null])
  for (const agent of [external, child, changing, unreadable]) {
    assert.throws(() => waterfall('tools/pre-execute', { name: 'bash', agent, arguments: {} }, assert.fail), refusal)
    assert.throws(() => waterfall('agent/pre-step', { agent, modelSelection: { provider: 'acp-claude' } }, assert.fail), refusal)
  }
  const next = t.mock.fn(() => 'admitted')
  assert.equal(await waterfall('tools/pre-execute', { name: 'bash', agent: owner, arguments: {} }, next), 'admitted')
  assert.equal(ctx.listeners.get('llm/stream')[0]({ sessionId: OWNER, provider: 'acp-claude', model: 'default' }, next), 'admitted')
  assert.equal(next.mock.callCount(), 2)
})

test('the resolved stream route and each step are checked before model inspection or dispatch', async t => {
  const inspect = t.mock.fn(async () => { assert.fail('CLI inspection') })
  const { rt, ctx, bot, owner, waterfall } = setup(t, '1', { services: { acpAgents: { inspect } } })
  await rt.load()
  const stream = ctx.listeners.get('llm/stream')[0]
  const preStep = ctx.listeners.get('agent/pre-step')[0]
  const next = t.mock.fn(() => 'launched')
  const options = { sessionId: CHAT, model: 'default', messages: [] }
  for (const provider of ['acp-claude', 'acp-other', 'local-codex', 'claude-code', 'claude-code-box', 'gemini-cli', 'hermes-remote']) {
    assert.throws(() => stream({ ...options, provider }, next), refusal)
    assert.throws(() => waterfall('agent/pre-step', { agent: bot, modelSelection: { provider } }, next), refusal)
  }
  assert.throws(() => stream({ ...options, provider: 'acp-claude', messages: [{ role: 'tool' }] }, next), refusal)
  assert.throws(() => stream({ ...options, provider: 'acp-claude', sessionId: 'unknown-session' }, next), refusal)
  assert.equal(next.mock.callCount(), 0)
  assert.equal(inspect.mock.callCount(), 0)
  assert.equal(stream({ ...options, provider: 'native' }, next), 'launched')
  assert.equal(stream({ ...options, provider: 'acp-claude', sessionId: OWNER }, next), 'launched')
  assert.equal(preStep({ agent: owner, modelSelection: { provider: 'acp-claude' } }, next), 'launched')
  assert.equal(preStep({ agent: bot, modelSelection: { provider: 'native' } }, next), 'launched')
  assert.equal(next.mock.callCount(), 4)
})

test('Bot group posts cannot start a command provider or a legacy PTC relay', async t => {
  const state = team()
  state.rooms.group = { id: 'group', name: 'Group', named: true, members: [BOT], admin: BOT, sessions: {} }
  const { rt, add, waterfall } = setup(t, '1', { state })
  const agent = add('group')
  await rt.load()
  const botPost = { role: 'user', source: { kind: 'bot', role: 'post', senderSessionId: BOT } }
  const ownerPost = { role: 'user', source: { kind: 'user' } }
  assert.throws(() => waterfall('agent/pre-step', {
    agent, messages: [botPost], modelSelection: { provider: 'acp-claude', model: 'default' },
  }, assert.fail), refusal)
  const relay = async (message, name) => {
    const options = { sessionId: 'group', provider: 'native', model: 'default', messages: [message], tools: [{ name }] }
    return Array.fromAsync(waterfall('llm/stream', options, assert.fail))
  }
  await assert.rejects(relay(botPost, 'run_code'), refusal)
  assert.equal((await relay(botPost, 'group_relay')).find(chunk => chunk.type === 'tool-call-delta').name, 'group_relay')
  assert.equal((await relay(ownerPost, 'run_code')).find(chunk => chunk.type === 'tool-call-delta').name, 'run_code')
})

test('a new group recipient never probes ACP on a cold catalog and an explicit CLI is refused', async t => {
  const state = team()
  state.bots[BOT].model = 'native/default'
  state.bots[BOT].appliedModel = 'native/default'
  for (const id of ['native-room', 'cli-room']) {
    state.rooms[id] = { id, name: id, named: true, members: [BOT], admin: BOT, sessions: {} }
  }
  const { rt, ctx, add } = setup(t, '1', { state })
  const native = add('native-room')
  const cli = add('cli-room')
  await rt.load()
  ctx.llm.listProviders = () => [{ id: 'acp-sentinel' }, { id: 'native' }]
  const probe = t.mock.fn(async () => [{ id: 'default' }])
  const nativeModels = t.mock.fn(async () => [{ id: 'default' }])
  ctx.llm.listModels = provider => provider === 'acp-sentinel' ? probe() : nativeModels()
  const make = t.mock.method(rt, 'createSession', async () => add('native-member').id)
  rt.applyPermission = async () => {}
  const selected = t.mock.method(rt, 'selectSessionModel', async () => {})
  rt.ownChatBrief = async () => undefined
  rt.deliver = async ({ exchangeId }) => { rt.roomWaiters.get(exchangeId).resolve('[PASS]') }
  const relay = rt.teamTools.find(tool => tool.name === 'group_relay')
  const run = async agent => {
    rt.roomInbox.set(agent.id, [{ text: '@Writer check the table' }])
    await relay.execute({}, { agent, callId: agent.id })
    await Promise.all(rt.roomRounds(agent.id))
  }
  await run(native)
  assert.equal(make.mock.callCount(), 1)
  assert.equal(selected.mock.callCount(), 1)
  assert.deepEqual(selected.mock.calls[0].arguments, ['native-member', { provider: 'native', model: 'default' }])
  assert.equal(probe.mock.callCount(), 0)
  const catalogReads = nativeModels.mock.callCount()
  assert.ok(catalogReads > 0)
  rt.botOf(BOT).model = 'acp-sentinel/default'
  await run(cli)
  assert.equal(make.mock.callCount(), 1)
  assert.equal(probe.mock.callCount(), 0)
  assert.equal(nativeModels.mock.callCount(), catalogReads)
  assert.ok(rt.roomOf(cli.id).log.some(line => line.code === CODE))
})

function coldCatalog(t, ctx) {
  const agentRun = t.mock.fn()
  const acpModels = t.mock.fn(async () => { agentRun(); return [{ id: 'default' }] })
  const nativeModels = t.mock.fn(async () => [{ id: 'backup' }, { id: 'current' }])
  ctx.llm.listProviders = () => [{ id: 'acp-sentinel' }, { id: 'native' }]
  ctx.llm.listModels = provider => provider === 'acp-sentinel' ? acpModels() : nativeModels()
  return { agentRun, acpModels, nativeModels }
}

test('fallback skips retained failures and uses a command-free cold catalog for other failures', async t => {
  const { rt, ctx, bot, waterfall } = setup(t, '1')
  await rt.load()
  const { agentRun, acpModels, nativeModels } = coldCatalog(t, ctx)
  const config = { provider: 'native', model: 'current' }
  bot.session.requestHeader = () => ({ config })
  bot.model = { current: () => config, select: t.mock.fn() }
  bot.followup = t.mock.fn()
  const fail = code => waterfall('agent/request-error', { agent: bot, failure: { code }, turn: 1 }, async () => undefined)
  await fail(CODE)
  assert.equal(nativeModels.mock.callCount(), 0)
  rt.config.fallbackModel = 'acp-sentinel/default'
  await fail('SERVER')
  assert.equal(bot.model.select.mock.callCount(), 0)
  assert.equal(bot.followup.mock.callCount(), 0)
  delete rt.config.fallbackModel
  await fail('SERVER')
  assert.equal(acpModels.mock.callCount(), 0)
  assert.equal(agentRun.mock.callCount(), 0)
  assert.equal(nativeModels.mock.callCount(), 1)
  assert.deepEqual(bot.model.select.mock.calls[0].arguments, [{ provider: 'native', model: 'backup' }])
  assert.equal(bot.followup.mock.callCount(), 1)
})

test('overflow admits the fresh route before creation and never probes ACP on a cold catalog', async t => {
  const { rt, ctx, bot, add, waterfall, home } = setup(t, '1')
  await rt.load()
  const { agentRun, acpModels, nativeModels } = coldCatalog(t, ctx)
  const config = { provider: 'native', model: 'current' }
  Object.assign(bot.session, { requestHeader: () => ({ config }), deriveMessages: () => [] })
  Object.assign(bot, {
    inbox: { nextStep: [], nextTurn: [] },
    whenIdle: async () => {},
    runMaintenance: run => run(new AbortController().signal),
    followup: t.mock.fn(),
  })
  ctx.sessionController.page = async () => ({ records: [], hasMore: false })
  ctx.sessions.flush = async () => {}
  ctx.workspaceRegistry.archiveSession = async () => {}
  const fresh = add('fresh-native')
  fresh.model = { current: () => config }
  fresh.followup = t.mock.fn()
  const create = t.mock.method(rt, 'createSession', async () => {
    assert.equal(nativeModels.mock.callCount(), 1, 'choose the route before creating a session')
    return fresh.id
  })
  const select = t.mock.method(rt, 'selectSessionModel', async () => {})
  const stateFile = join(home, 'state.json')
  const before = readFileSync(stateFile)
  const overflow = async () => {
    await waterfall('agent/request-error', {
      agent: bot, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, turn: 1,
    }, async () => undefined)
    await until(() => [...rt.switchJobs()].length === 0)
  }
  await overflow()
  assert.equal(create.mock.callCount(), 0, 'the saved explicit ACP route is refused')
  assert.equal(nativeModels.mock.callCount(), 0)
  assert.equal(bot.followup.mock.callCount(), 0)
  assert.deepEqual(readFileSync(stateFile), before)
  rt.botOf(BOT).model = rt.botOf(BOT).appliedModel = 'native/current'
  const resolvedToAcp = t.mock.method(rt, 'desiredModel', async () => 'acp-sentinel/default')
  await overflow()
  assert.equal(create.mock.callCount(), 0, 'the resolved ACP route is refused')
  assert.equal(select.mock.callCount(), 0)
  assert.deepEqual(readFileSync(stateFile), before)
  resolvedToAcp.mock.restore()
  await overflow()
  assert.equal(create.mock.callCount(), 1)
  assert.deepEqual(select.mock.calls[0].arguments, [fresh.id, config])
  assert.equal(fresh.followup.mock.callCount(), 1)
  assert.equal(acpModels.mock.callCount(), 0)
  assert.equal(agentRun.mock.callCount(), 0)
})

test('group memory review uses the keeper for provider admission and the room for usage', async t => {
  const state = team()
  state.rooms.group = { id: 'group', name: 'Group', named: true, members: [BOT], admin: BOT, sessions: { [BOT]: 'group-member' } }
  state.prefs.backgroundModel = 'claude-code/default'
  const { rt, ctx, add } = setup(t, '1', { state, config: { memoryReviewDelayMs: 0 } })
  const member = add('group-member')
  add('group')
  await rt.load()
  assert.equal(rt.botRunnerRequired('group'), false)
  assert.equal(rt.botRunnerRequired(CHAT), true)
  rt.groupLinesAfter = async () => [{ seq: 1, who: 'User', text: 'Remember my preference for a small table.' }]
  ctx.llm.listProviders = () => [{ id: 'native' }, { id: 'claude-code' }]
  ctx.llm.listModels = t.mock.fn(async () => [{ id: 'default' }])
  ctx.llm.resolveModelInfo = t.mock.fn(async () => ({}))
  const stream = t.mock.method(rt, 'assembleLlm', async () => ({
    finish: { kind: 'stop' }, blocks: () => [{ type: 'text', text: '{"changes":[]}' }],
  }))
  const usage = t.mock.method(rt, 'tagUsage')
  const warnings = t.mock.method(rt, 'warn', () => {})
  const review = async () => {
    ctx.emit('agent/status', { agent: member, status: 'running' })
    ctx.emit('agent/status', { agent: member, status: 'idle' })
    assert.equal(rt.memoryReviews(), 1)
    await until(() => rt.memoryReviews() === 0)
  }
  await review()
  assert.ok(warnings.mock.calls.some(call => call.arguments.includes(CODE)))
  assert.equal(ctx.llm.listModels.mock.callCount(), 0)
  assert.equal(ctx.llm.resolveModelInfo.mock.callCount(), 0)
  assert.equal(stream.mock.callCount(), 0)
  rt.state.prefs.backgroundModel = 'native/default'
  await review()
  assert.equal(stream.mock.calls[0].arguments[0].sessionId, CHAT)
  assert.deepEqual(usage.mock.calls[0].arguments[1], { sessionId: 'group', kind: 'memory' })
})

test('Bot auxiliary calls refuse before the model stream and do not fall back', async t => {
  const { rt, ctx } = setup(t, '1')
  await rt.load()
  ctx.llm.stream = t.mock.fn(() => assert.fail('model stream'))
  ctx.llm.resolveModelInfo = t.mock.fn(() => assert.fail('model metadata'))
  const route = { provider: 'local-codex', model: 'default' }
  await assert.rejects(rt.assembleLlm({ ...route, sessionId: CHAT }), refusal)
  await assert.rejects(callAside(ctx, rt, { sessionId: CHAT, header: { config: route } }, {}), refusal)
  ctx.llm.listProviders = () => [{ id: 'local-codex' }, { id: 'native' }]
  ctx.llm.listModels = t.mock.fn(async provider => {
    assert.equal(provider, 'native')
    return [{ id: 'default' }]
  })
  assert.equal(await rt.backgroundModel(CHAT), 'native/default')
  assert.equal(ctx.llm.listModels.mock.callCount(), 1)
  rt.state.prefs.backgroundModel = 'local-codex/default'
  await assert.rejects(rt.backgroundModel(CHAT), refusal)
  assert.equal(ctx.llm.listModels.mock.callCount(), 1)
  rt.backgroundModel = async () => 'local-codex/default'
  const fallback = t.mock.method(rt, 'desiredModel', () => assert.fail('fallback model'))
  await assert.rejects(rt.botShot(rt.botOf(BOT), 'system', 'text', { sessionId: CHAT }), refusal)
  assert.equal(fallback.mock.callCount(), 0)
  assert.equal(ctx.llm.stream.mock.callCount(), 0)
  assert.equal(ctx.llm.resolveModelInfo.mock.callCount(), 0)
  assert.equal(fallbackFor({ failure: refusal, failed: { provider: 'acp-claude', model: 'default' }, fallback: { provider: 'native', model: 'current' } }), undefined)
})

test('Bot messaging and agent creation skip approved stdio and HTTP MCP, while the owner can mount both', async t => {
  const state = team()
  const entry = { name: 'stdio', kind: 'mcp', transport: 'stdio', command: 'fixture', args: [], env: {}, approved: true, fromSettings: true }
  const http = { name: 'remote', kind: 'mcp', transport: 'streamable-http', url: 'https://fixture.invalid/mcp', approved: true, fromSettings: true }
  const pack = { name: 'kit', kind: 'pack', items: [entry.name, http.name] }
  Object.assign(state.capabilities.items, { [entry.name]: entry, [http.name]: http, [pack.name]: pack })
  state.bots[BOT].capabilities = [pack.name]
  const load = t.mock.fn(async () => ({ default: {} }))
  const { rt, ctx, bot, owner, add, warnings } = setup(t, '1', { state, services: { loader: { import: load } } })
  const mounts = t.mock.fn(() => ({ await: async () => {}, dispose: () => {} }))
  bot.ctx.plugin = mounts
  owner.ctx.plugin = mounts
  const unknown = add('unknown', undefined)
  delete unknown.session.header
  unknown.ctx.plugin = mounts
  await rt.load()
  await ctx.emitAsync('agent/created', { agent: bot })
  bot.followup = t.mock.fn()
  ctx.sessions.flush = async () => {}
  await rt.deliver({ fromId: BOT, toId: BOT, role: 'request', text: 'The new update', recordExchange: false })
  assert.equal(bot.followup.mock.callCount(), 1)
  await rt.reconcileCapabilities()
  assert.equal(mounts.mock.callCount(), 0)
  assert.equal(load.mock.callCount(), 0)
  assert.equal(warnings.filter(line => line.includes('capability stdio skipped')).length, 1)
  assert.deepEqual(rt.state.capabilities.items[entry.name], entry)
  assert.deepEqual(rt.state.capabilities.items[http.name], http)
  assert.deepEqual(rt.botOf(BOT).capabilities, [pack.name])
  await assert.rejects(rt.mountCapability('unknown', entry.name), refusal)
  assert.equal(load.mock.callCount(), 0)
  const mounted = await rt.mountCapability(OWNER, entry.name)
  assert.equal(mounted.state, 'ready')
  assert.equal((await rt.mountCapability(OWNER, http.name)).state, 'ready')
  assert.equal(mounts.mock.callCount(), 2)
  assert.equal(load.mock.callCount(), 1)
  await ctx.emitAsync('agent/created', { agent: owner })
  assert.equal(mounts.mock.callCount(), 2)
})

test('role reconciliation authenticates declarations without evaluating the attached module', async t => {
  const state = team()
  const role = { id: 'runner-fixture', version: '1.0.0', attachedAt: '2026-11-20T00:00:00Z', grants: ['audio-out'] }
  state.bots[BOT].roles = [role]
  const { rt, warnings } = setup(t, '1', { state })
  await rt.load()
  const record = { version: role.version, sha256: 'fixture-no-runner' }
  const manifest = { tools: [], settings: [{ key: 'voice' }], capabilities: role.grants }
  const sentinel = Symbol.for('ds-bot:test:role-module')
  const ran = t.mock.fn()
  globalThis[sentinel] = ran
  t.after(() => { delete globalThis[sentinel] })
  const packages = {
    recordOf: () => record, damaged: () => false, damage: t.mock.fn(),
    authenticate: t.mock.fn(async () => ({
      manifest,
      entryBytes: Buffer.from("globalThis[Symbol.for('ds-bot:test:role-module')](); export function install() {}"),
    })),
  }
  const runtime = createRoleRuntime(rt, packages)
  t.after(() => runtime.dispose())
  runtime.reconcile()
  await runtime.ready()
  runtime.reconcile()
  assert.equal(ran.mock.callCount(), 0)
  assert.equal(packages.authenticate.mock.callCount(), 1)
  assert.equal(packages.damage.mock.callCount(), 0)
  assert.equal(warnings.filter(line => line?.includes('no Bot runner')).length, 1)
  assert.deepEqual(rt.botOf(BOT).roles, [role])
  assert.deepEqual(runtime.view()[BOT].settings, manifest.settings)
  assert.deepEqual(runtime.view()[BOT].tools, [])
})

async function realRuntime(t, home, { schedule, stream, titles = false, git = false } = {}) {
  const root = new Context()
  const originalMode = process.env.AUTOMAGIK_MULTIUSER
  process.env.AUTOMAGIK_MULTIUSER = '1'
  let rt
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    rt?.dispose()
    await root.fiber.dispose()
    if (originalMode === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = originalMode
  }
  t.after(stop)
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  const cwd = join(import.meta.dirname, '../../..')
  const gitLog = join(home, 'git.log')
  if (git) {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(gitLog, '')
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> ' + JSON.stringify(gitLog),
      'case "$1" in',
      '  rev-parse) printf "%s\\n" ' + [cwd, join(home, 'git-dir'), join(home, 'objects')].map(value => JSON.stringify(value)).join(' ') + ' ;;',
      '  write-tree) printf "%s\\n" 0000000000000000000000000000000000000000 ;;',
      'esac',
    ].join('\n'), { mode: 0o700 })
    const originalPath = process.env.PATH
    process.env.PATH = `${bin}:${originalPath}`
    t.after(() => { process.env.PATH = originalPath })
    await root.plugin(LocalSubprocessRuntime)
    await root.plugin(workspaceChanges)
  }
  const resolved = t.mock.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 100000 } }))
  class Adapter extends LlmAdapter {
    resolveModel(provider, id) { return resolved(provider, id) }
    listModels() { return Promise.resolve([]) }
    async *stream(options) {
      if (stream !== undefined && (yield* stream(options))) return
      yield { type: 'text-delta', index: 0, text: 'Fixture reply.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['native', 'acp-claude'], new Adapter())
  await mountAgentLoopTestHarness(root)
  root.provide('connection', { fetch: { register: () => () => {} } })
  root.provide('workspaceRegistry', {
    get: () => undefined,
    resolveByPath: async path => ({ id: 'fixture-workspace', path }),
  })
  root.provide('sessionController', {
    resolveAgent: async id => ({ agent: root.agents.get(id) }),
    page: async () => ({ records: [], hasMore: false }),
  })
  if (titles) await root.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 200, maxTitleBytes: 256 })
  else root.provide('sessionTitle', { rename: async () => {} })
  if (schedule !== undefined) root.provide('schedule', schedule)
  rt = createRuntime(root, { home, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  root.provide('omniTeam', rt)
  await rt.load()
  const create = (id, provider = 'native') => root.agentLoop.create(id, { provider, model: 'default' }, { cwd })
  const run = async (agent, source = { kind: 'user' }) => {
    agent.followup(createUserMessage({ source, content: [{ type: 'text', text: 'Fixture prompt' }] }))
    await agent.whenIdle()
    await new Promise(resolve => setImmediate(resolve))
  }
  return { root, rt, create, run, stop, gitLog, resolved }
}

test('a real Bot turn drops denied activation, concurrency and result callbacks, including scoped replacements', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-runner-turn-'))
  const state = team()
  state.bots[BOT].model = state.bots[BOT].appliedModel = 'native/default'
  state.rooms.relay = { id: 'relay', name: 'Relay', named: true, members: [BOT], admin: BOT, sessions: {} }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const requests = []
  const { root, rt, create, run, stop, gitLog } = await realRuntime(t, home, {
    git: true,
    async *stream(options) {
      requests.push(options)
      if (requests.length !== 1) return false
      yield { type: 'tool-call-delta', index: 0, id: 'blocked-conditional', name: 'extension_conditional', argumentsDelta: '{}' }
      yield { type: 'tool-call-delta', index: 1, id: 'blocked-plain', name: 'extension_plain', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return true
    },
  })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await root.plugin(todo, { allowParallelInProgress: false })
  await root.plugin(PlanMode, { section: 'Fixture planning instructions.' })
  const activating = t.mock.fn(() => true)
  const concurrency = t.mock.fn(() => true)
  const finalize = t.mock.fn(() => [{ type: 'text', text: 'Extension finalized' }])
  const execute = t.mock.fn(async () => '')
  const tool = name => defineTool({
    name, description: 'Fixture', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    isConcurrencySafe: concurrency, finalizeContent: finalize, execute,
  })
  const bot = await create(CHAT)
  const approval = fakeApproval()
  root.provide('approval', approval)
  const reviewer = t.mock.fn(async (exec, next) => exec.agent === bot ? { kind: 'ask', reason: 'late reviewer' } : next())
  root.on('tools/pre-execute', reviewer, { prepend: true })
  root.tools.register(tool('extension_conditional'), { when: activating })
  bot.ctx.tools.register(tool('extension_plain'))
  assert.equal(root.tools.get('todo_write', bot), root.tools.get('todo_write'))
  assert.ok(root.tools.get('todo_write', bot))
  assert.equal(root.tools.get('exit_plan_mode', bot), root.tools.get('exit_plan_mode'))
  assert.ok(root.tools.get('exit_plan_mode', bot))
  const results = []
  root.on('tools/result', (exec, result) => { if (exec.agent === bot) results.push(result) })
  await run(bot)
  assert.deepEqual(bot.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
  assert.ok(requests.length > 0)
  assert.equal(results.length, 2)
  for (const result of results) {
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /no Bot runner/)
  }
  for (const seen of [activating, concurrency, finalize, execute]) assert.equal(seen.mock.callCount(), 0)
  assert.equal(reviewer.mock.callCount(), 0)
  assert.deepEqual(approval.requests, [])
  assert.equal(readFileSync(gitLog, 'utf8'), '')
  assert.equal(rt.botRunnerRequired(CHAT, bot), true)

  const preset = {}
  bindScopeParent(bot, preset)
  let scope
  await root.inject(['tools'], ctx => { scope = createScope(ctx, preset) })
  const stolenActivation = t.mock.fn(() => true)
  const dropShadow = scope.ctx.tools.register(root.tools.get('todo_write'), { when: stolenActivation })
  assert.equal(root.tools.get('todo_write', bot), undefined)
  const admitted = await root.tools.resolve({ agent: bot, signal: new AbortController().signal })
  assert.equal(admitted.view(bot).has('todo_write'), false)
  admitted.dispose()
  assert.equal(stolenActivation.mock.callCount(), 0)
  await dropShadow()
  for (const name of ['todo_write', 'exit_plan_mode']) {
    scope.ctx.tools.register(tool(name), { when: activating })
    assert.equal(root.tools.get(name, preset).name, name)
    assert.equal(root.tools.get(name, bot), undefined)
    const { results: [entry] } = await root.tools.execute({
      agent: bot, signal: new AbortController().signal, calls: [{ id: name, name, arguments: '{}' }],
    })
    assert.equal(entry.result.error.info.code, CODE)
  }
  for (const seen of [activating, concurrency, finalize, execute]) assert.equal(seen.mock.callCount(), 0)
  assert.equal(reviewer.mock.callCount(), 0)
  assert.deepEqual(approval.requests, [])
  // A verified owner's ordinary turn still resolves the extension and records a Git snapshot.
  const owner = await create(OWNER)
  await run(owner)
  assert.deepEqual(owner.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
  assert.equal(activating.mock.callCount(), 1)
  const recorded = readFileSync(gitLog, 'utf8')
  assert.match(recorded, /rev-parse[\s\S]*write-tree/)

  const relay = await create('relay', 'acp-claude')
  assert.equal(rt.botRunnerRequired(relay.id, relay), false)
  await run(relay, { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'fixture-relay', senderName: 'Writer', senderSessionId: CHAT, roomId: relay.id })
  assert.deepEqual(relay.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'error', error: refusal })
  assert.equal(activating.mock.callCount(), 1)
  assert.equal(readFileSync(gitLog, 'utf8'), recorded)
  await stop()
})

test('title refresh checks the logged or overridden route before resolving ACP model metadata', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-runner-title-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const state = team()
  state.bots[BOT].model = state.bots[BOT].appliedModel = 'native/default'
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const { root, rt, create, run, resolved, stop } = await realRuntime(t, home, { titles: true })
  const bot = await create(CHAT)
  const owner = await create(OWNER, 'acp-claude')
  await run(bot)
  await run(owner)
  const refreshOwner = async () => {
    await until(() => !rt.botRunnerRequired(OWNER))
    return root.sessionTitle.refresh(owner.session)
  }
  const config = { targetWords: 5, targetCjkCharacters: 12, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 1000 }
  const override = root.plugin(FirstPromptTitle, { ...config, provider: 'acp-claude', model: 'default' })
  await override
  assert.equal(bot.session.requestHeader().config.provider, 'native')
  resolved.mock.resetCalls()
  await assert.rejects(root.sessionTitle.refresh(bot.session), refusal)
  assert.equal(resolved.mock.callCount(), 0)
  assert.equal((await refreshOwner()).source.kind, 'provider')
  await override.dispose()

  const logged = owner.session.snapshotEvents().findLast(event => event.type === 'request/header').data
  bot.session.append('request/header', { ...logged, reason: 'change' })
  assert.equal(bot.session.requestHeader().config.provider, 'acp-claude')
  await root.plugin(FirstPromptTitle, config)
  resolved.mock.resetCalls()
  await assert.rejects(root.sessionTitle.refresh(bot.session), refusal)
  assert.equal(resolved.mock.callCount(), 0)
  assert.equal((await refreshOwner()).source.kind, 'provider')
  assert.ok(resolved.mock.calls.some(call => call.arguments[0] === 'acp-claude'))
  await stop()
})

test('no-runner refusals leave the saved Bot and schedules byte-identical across restart', async t => {
  const state = team()
  state.bots[BOT].segments = [{ sessionId: 'earlier', endedAt: 2, shellOffCli: true }]
  const home = mkdtempSync(join(tmpdir(), 'dsb-runner-rollback-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const schedules = join(home, 'schedules.json')
  writeFileSync(schedules, JSON.stringify([
    { id: 'active', target: { kind: 'session', sessionId: CHAT }, status: 'active' },
    { id: 'paused', target: { kind: 'session', sessionId: CHAT }, status: 'paused' },
  ]))
  const schedule = {
    catalog: async () => JSON.parse(readFileSync(schedules, 'utf8')),
    edit: t.mock.fn(async () => assert.fail('schedule mutation')),
  }
  const baseline = setup(t, undefined, { state, home, services: { schedule } })
  await baseline.rt.load()
  await baseline.stop()
  const snapshot = () => ['state.json', 'schedules.json'].map(file => readFileSync(join(home, file)))
  const saved = snapshot()
  const stream = t.mock.fn()
  const on = await realRuntime(t, home, { schedule, stream })
  const bot = await on.create(CHAT, 'acp-claude')
  await on.run(bot)
  const end = () => bot.session.snapshotEvents().findLast(event => event.type === 'turn/end').data
  assert.deepEqual(end(), { turn: 1, reason: { kind: 'error', error: refusal } })
  const active = (await schedule.catalog()).find(entry => entry.id === 'active')
  const delivered = await on.root.waterfall('schedule/resolve-agent', active.target.sessionId,
    async () => on.root.agents.get(active.target.sessionId))
  await on.run(delivered, { kind: 'schedule' })
  assert.deepEqual(end(), { turn: 2, reason: { kind: 'error', error: refusal } })
  assert.equal(on.resolved.mock.callCount(), 0)
  assert.equal(stream.mock.callCount(), 0)
  await on.stop()
  assert.deepEqual(snapshot(), saved)
  const off = setup(t, '0', { home, reuse: true, services: { schedule } })
  await off.rt.load()
  assert.equal(off.rt.botRunnerRequired, undefined)
  assert.equal(off.rt.multiuserHold(), true)
  assert.throws(() => off.waterfall('tools/execute', { name: 'bash', agent: off.bot, arguments: {} }, assert.fail), /multiuser mode, which is now off/)
  assert.deepEqual(snapshot(), saved)
  assert.equal(schedule.edit.mock.callCount(), 0)
})
