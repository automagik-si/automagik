import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as bash from '@deepseek-ai/dsh-tool-bash'
import * as persistent from '@deepseek-ai/dsh-tool-bash-persistent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as bots from '../index.js'
import { botRunnerReady } from '../src/host/bot-runner.js'
import { BOT_SHELL } from '../src/host/bot-shell.js'
import { inspect } from '../src/host/runner-client.js'
import { sessionScope, scopeWith } from '../src/host/member-wall/principals.js'
import { isTrustedToolRegistration, registerTrustedTool } from '../src/host/tool-registrations.js'
import { BOT, OTHER, exit, fakeRunner, frames, linuxRunner, output, setEnv, start } from './runner-fixture.mjs'

const OWNER = 'shell-owner'
const CHAT = 'shell-bot'
const OTHER_CHAT = 'shell-other-bot'
const OUTER = 'shell-outer'
const PINNED = 'session-00000000-0000-0000-0000-000000000001'
const INSTANCE = 'runner-client-test'
const WRITE = { command: "printf 'fixture' > written" }
const CODE = 'bot/no-runner'

async function world(t, { mode = '1', ptcRuntime } = {}) {
  setEnv(t, { AUTOMAGIK_MULTIUSER: mode, AUTOMAGIK_INSTANCE_ID: INSTANCE, DSH_TOKEN: 'never-forward-this' })
  const home = fs.mkdtempSync(join(tmpdir(), 'bot-shell-'))
  const recordDir = join(home, 'principals')
  fs.mkdirSync(recordDir, { mode: 0o700 })
  const file = join(recordDir, 'record.json')
  const info = fs.lstatSync(recordDir, { bigint: true })
  const sessions = { [CHAT]: `bot:${BOT}`, [OTHER_CHAT]: `bot:${OTHER}`, [PINNED]: `bot:${PINNED}`, [OWNER]: 'owner' }
  const record = () => fs.writeFileSync(file, JSON.stringify({ version: 2, instance: INSTANCE, sessions }), { mode: 0o600 })
  record()
  const bot = (id, sessionId) => ({ id, sessionId, name: id, createdAt: 1, role: '', instructions: '', shell: true })
  fs.writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [BOT], rooms: {}, tasks: {},
    bots: { [BOT]: bot(BOT, CHAT), [OTHER]: bot(OTHER, OTHER_CHAT), [PINNED]: { ...bot(PINNED, PINNED), sessionPinned: true } },
  }))
  const root = new Context()
  let rt
  t.after(async () => {
    rt?.dispose()
    await root.fiber.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  })
  if (ptcRuntime !== undefined) root.provide('ptcRuntime', ptcRuntime)
  await mountAgentLoopTestDependencies(root, { workingDirectory: true, tools: { mode: ptcRuntime === undefined ? 'native' : 'ptc' } })
  await mountAgentLoopTestHarness(root)
  root.provide('connection', { fetch: { register: () => () => {} } })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'fixture-workspace', path }) })
  root.provide('sessionController', { resolveAgent: async id => ({ agent: root.agents.get(id) }), page: async () => ({ records: [], hasMore: false }) })
  root.provide('sessionTitle', { rename: async () => {} })
  root.provide('automagikPrincipalRecord', { version: 1, file, instance: INSTANCE, folder: `${info.dev}:${info.ino}` })
  const policy = { mode: 'workspace-write', workspaceRoot: home, additionalWritableRoots: [] }
  const sessionPolicies = new Map()
  root.provide('sandboxPolicy', { resolve: ({ session } = {}) => sessionPolicies.has(session?.id) ? sessionPolicies.get(session.id) : policy })
  const ownerExecute = t.mock.fn(async () => ({
    result: async () => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
      stdout: { text: 'owner path', truncated: false }, stderr: { text: '', truncated: false },
    }),
  }))
  root.provide('shell', { sandboxMode: 'workspace-write', resolve: request => request, execute: ownerExecute })
  root.provide('shellEnv', { collect: () => ({}) })
  const bashPlugin = root.plugin(bash, { enableRunInBackground: false })
  await bashPlugin
  await root.plugin(bots, { home, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  rt = root.get('omniTeam')
  await rt.load()
  const create = id => root.agentLoop.create(id, { provider: 'native', model: 'default' }, { cwd: home })
  const agents = { bot: await create(CHAT), owner: await create(OWNER), other: await create(OTHER_CHAT), pinned: await create(PINNED) }
  rt.syncScopedTools()
  const invoke = async (agent, args = WRITE, name = BOT_SHELL) => {
    const { results: [result] } = await root.tools.execute({
      agent, signal: new AbortController().signal, calls: [{ id: 'shell-call', name, arguments: JSON.stringify(args) }],
    })
    return result.result
  }
  return { root, rt, ...agents, policy, sessionPolicies, ownerExecute, invoke, bashPlugin, home, sessions, record }
}

function spawnSentinel(t) {
  const entries = ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync'].map(name => (
    t.mock.method(childProcess, name, () => assert.fail(`local ${name}`))
  ))
  syncBuiltinESMExports()
  t.after(() => {
    for (const entry of entries) entry.mock.restore()
    syncBuiltinESMExports()
  })
  return () => assert.ok(entries.every(entry => entry.mock.callCount() === 0))
}

function refused(result, message = /no Bot runner/) {
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, CODE)
  assert.match(result.error.message, message)
}

test('the shipped tool entry sends one Bot command and keeps the owner on ordinary bash', linuxRunner, async t => {
  const runner = await fakeRunner(t, {
    reply(conn, request) {
      const { id } = request.identity
      assert.equal(request.argv[2], WRITE.command)
      fs.writeFileSync(join(request.cwd, 'written'), 'fixture')
      conn.end(frames(start(id), output('out', 'runner stdout'), output('err', 'runner stderr'), exit(3)))
    },
  })
  const { root, bot, other, owner, invoke, ownerExecute, home } = await world(t)
  const noSpawn = spawnSentinel(t)
  const area = join(runner.workRoot, '.bots', BOT)
  const subdir = join(runner.workRoot, '.bots', OTHER, 'nested')
  fs.mkdirSync(area, { recursive: true })
  fs.mkdirSync(subdir, { recursive: true })
  assert.ok(root.tools.get(BOT_SHELL, bot))
  assert.equal(root.tools.get(BOT_SHELL, owner), undefined)
  const [one, two] = await Promise.all([
    invoke(bot), invoke(other, { ...WRITE, cwd: 'nested', timeoutMs: 999_999 }),
  ])
  for (const result of [one, two]) {
    assert.equal(result.isError, false)
    assert.match(result.content[0].text, /exit code: 3.*stdout:\nrunner stdout.*stderr:\nrunner stderr/s)
  }
  assert.deepEqual(runner.requests.map(request => request.identity.id).sort(), [BOT, OTHER])
  const requests = new Map(runner.requests.map(request => [request.identity.id, request]))
  assert.deepEqual(requests.get(BOT).wire, {
    v: 2, identity: { kind: 'bot', id: BOT }, argv: ['/bin/sh', '-c', WRITE.command], cwd: area, env: {}, timeoutMs: 120_000,
  })
  assert.equal(requests.get(OTHER).cwd, subdir)
  assert.equal(requests.get(OTHER).timeoutMs, 600_000)
  assert.equal(fs.readFileSync(join(area, 'written'), 'utf8'), 'fixture')
  assert.equal(fs.existsSync(join(home, 'written')), false)
  const ordinary = await invoke(owner, { command: 'fixture', description: 'Owner fixture command' }, 'bash')
  assert.equal(ordinary.isError, false)
  assert.match(ordinary.content[0].text, /owner path/)
  assert.equal(ownerExecute.mock.callCount(), 1)
  noSpawn()
})

test('ready stays restricted before approval, including both bash registrations and an open terminal', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  const { root, rt, bot, owner, pinned, other, policy, bashPlugin, invoke, sessions, record } = await world(t)
  assert.equal(botRunnerReady(), true)
  const noSpawn = spawnSentinel(t)
  const laterPolicy = t.mock.fn((_exec, next) => next())
  root.on('tools/pre-execute', laterPolicy, { prepend: true })
  const alreadyOpen = new Map([['open', t.mock.fn(() => assert.fail('open terminal received data'))]])
  const sentinelTool = (name, execute) => defineTool({
    name, description: 'Denied tool fixture', parameters: { sessionId: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute,
  })
  root.tools.register(sentinelTool('terminal_send', async ({ sessionId }) => alreadyOpen.get(sessionId)()))
  const denied = ['user_terminal_write', 'browser_open', 'cua', 'mcp__x__y', 'office_render', 'unknown']
  const execute = t.mock.fn(async () => assert.fail('denied tool executed'))
  for (const name of denied) root.tools.register(sentinelTool(name, execute))
  assert.ok(root.tools.executable('bash', owner))
  refused(await invoke(bot, { command: 'fixture', description: 'Denied Bash fixture' }, 'bash'))
  for (const name of ['terminal_send', ...denied]) {
    assert.equal(root.tools.executable(name, owner)?.name, name)
    refused(await invoke(bot, { sessionId: 'open' }, name))
  }
  await bashPlugin.dispose()
  root.provide('terminals', { spawn: () => assert.fail('persistent terminal spawn') })
  await root.plugin(persistent)
  assert.ok(root.tools.get('bash', owner))
  refused(await invoke(bot, WRITE, 'bash'))
  assert.throws(() => rt.assertBotRunnerProvider('acp-claude', CHAT, bot), { code: CODE })
  refused(await invoke(pinned))
  const dropOwner = rt.hooks.sessionOwner(id => id === OTHER_CHAT ? { botId: BOT } : undefined)
  refused(await invoke(other))
  dropOwner()
  const teamCurrent = rt.teamCurrent
  rt.teamCurrent = () => false
  refused(await invoke(bot))
  rt.teamCurrent = teamCurrent
  refused(await sessionScope.run(scopeWith(CHAT), () => invoke(owner)))
  refused(await sessionScope.run(scopeWith(OTHER_CHAT), () => invoke(bot)))
  sessions[CHAT] = 'owner'
  record()
  refused(await invoke(bot))
  sessions[CHAT] = `bot:${BOT}`
  record()
  refused(await invoke(bot, { ...WRITE, cwd: '../b-bbbbbbbbbb' }), /cwd must stay inside/)
  refused(await invoke(bot, { ...WRITE, cwd: '/outside' }), /cwd must stay inside/)
  refused(await invoke(bot, { ...WRITE, run_in_background: true }), /expected a foreground command/)
  refused(await invoke(bot, { ...WRITE, botId: OTHER }), /expected a foreground command/)
  refused(await invoke(bot, { ...WRITE, sandbox_permissions: 'danger-full-access', justification: 'fixture' }), /escalation/)
  policy.mode = 'read-only'
  refused(await invoke(bot), /the runner does not enforce read-only yet/)
  policy.mode = 'danger-full-access'
  refused(await invoke(bot), /require workspace-write/)
  policy.mode = 'workspace-write'
  rt.botOf(BOT).shell = false
  refused(await invoke(bot))
  rt.botOf(BOT).shell = true
  rt.botOf(BOT).denyTools = ['bash']
  refused(await invoke(bot))
  rt.botOf(BOT).denyTools = [BOT_SHELL]
  refused(await invoke(bot))
  rt.botOf(BOT).denyTools = []
  assert.equal(laterPolicy.mock.callCount(), 0)
  const permissionHold = new Error('fixture permission hold')
  const hold = t.mock.method(rt, 'levelHolds', async () => { throw permissionHold })
  const held = await invoke(bot)
  assert.equal(held.isError, true)
  assert.match(held.error.message, /fixture permission hold/)
  hold.mock.restore()
  assert.equal(alreadyOpen.get('open').mock.callCount(), 0)
  assert.equal(execute.mock.callCount(), 0)
  assert.equal(runner.connections, 0)
  noSpawn()
})

test('a ready runner refuses run_code through the PTC executor', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  const resolve = t.mock.fn(request => request)
  const run = t.mock.fn(async () => assert.fail('PTC runtime ran a program'))
  const { root, bot, invoke } = await world(t, {
    ptcRuntime: { language: 'typescript', programFormat: 'function-body', retainsState: false, resolve, run },
  })
  assert.equal(botRunnerReady(), true)
  assert.equal(root.tools.selectExecutor(bot).describe([]).schemas[0].name, 'run_code')
  refused(await invoke(bot, { code: 'return 1', description: 'PTC fixture program' }, 'run_code'))
  assert.equal(resolve.mock.callCount(), 0)
  assert.equal(run.mock.callCount(), 0)
  assert.equal(runner.connections, 0)
})

test('an agentless Bot call cannot reach a denied classifier on an attested registration', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  const { root, invoke } = await world(t)
  const classify = t.mock.fn(() => true)
  const execute = t.mock.fn(async () => 'fixture')
  const tool = defineTool({
    name: 'read_image', description: 'Image fixture', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    isConcurrencySafe: classify, execute,
  })
  registerTrustedTool(root.tools, tool)
  assert.equal(root.tools.get(tool.name), tool)
  assert.ok(isTrustedToolRegistration(root.tools.view().registrations.get(tool.name)))
  refused(await sessionScope.run(scopeWith(CHAT), () => invoke(undefined, {}, tool.name)))
  assert.equal(classify.mock.callCount(), 0)
  assert.equal(execute.mock.callCount(), 0)
  assert.equal(runner.connections, 0)
})

test('an admitted call is refused if principal evidence, session pinning or scopes change before dispatch', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  const { root, rt, bot, invoke, sessions, record } = await world(t)
  const noSpawn = spawnSentinel(t)
  const change = root.on('tools/pre-execute', async (_exec, next) => {
    sessions[CHAT] = `bot:${OTHER}`
    record()
    return next()
  }, { prepend: true })
  refused(await invoke(bot))
  change()
  sessions[CHAT] = `bot:${BOT}`
  record()
  const pin = root.on('tools/pre-execute', (_exec, next) => {
    rt.botOf(BOT).sessionPinned = true
    return next()
  }, { prepend: true })
  refused(await invoke(bot))
  pin()
  delete rt.botOf(BOT).sessionPinned
  const widen = root.on('tools/execute', (_exec, next) => sessionScope.run(scopeWith(OWNER), next), { prepend: true })
  refused(await invoke(bot))
  widen()
  const revoke = t.mock.method(rt, 'levelHolds', async () => {
    sessions[CHAT] = `bot:${OTHER}`
    record()
  })
  refused(await invoke(bot))
  assert.equal(revoke.mock.callCount(), 1)
  revoke.mock.restore()
  assert.equal(runner.connections, 0)
  noSpawn()
})

test('the client sends no request if the shell grant, pinning or mode changes during proof', linuxRunner, async t => {
  let change
  const runner = await fakeRunner(t, { beforeVerdict: () => change() })
  const { rt, bot, invoke, policy } = await world(t)
  const noSpawn = spawnSentinel(t)
  const entry = rt.botOf(BOT)
  for (const [revoke, restore] of [
    [() => { entry.shell = false }, () => { entry.shell = true }],
    [() => { entry.sessionPinned = true }, () => { delete entry.sessionPinned }],
    [() => { policy.mode = 'read-only' }, () => { policy.mode = 'workspace-write' }],
  ]) {
    change = revoke
    const result = await invoke(bot)
    assert.match(result.content[0].text, /exit code: 125.*REFUSED: Bot command admission is no longer valid/s)
    assert.equal(runner.requests.length, 0)
    restore()
  }
  assert.equal(runner.acknowledgements, 3)
  noSpawn()
})

test('every session in a Bot binding must resolve to workspace-write through the request write', linuxRunner, async t => {
  let beforeVerdict
  const runner = await fakeRunner(t, { beforeVerdict: () => beforeVerdict?.() })
  const { root, rt, bot, home, invoke, sessions, record, sessionPolicies } = await world(t)
  await root.agentLoop.create(OUTER, { provider: 'native', model: 'default' }, { cwd: home })
  const dropOwner = rt.hooks.sessionOwner(id => id === OUTER ? { botId: BOT } : undefined)
  t.after(dropOwner)
  sessions[OUTER] = `bot:${BOT}`
  record()
  const nested = () => sessionScope.run(scopeWith(OUTER), () => invoke(bot))
  assert.match((await nested()).content[0].text, /exit code: 0/)
  sessionPolicies.set(OUTER, { mode: 'read-only' })
  refused(await nested(), /the runner does not enforce read-only yet/)
  sessionPolicies.set(OUTER, undefined)
  refused(await nested(), /require workspace-write/)
  sessionPolicies.delete(OUTER)
  assert.equal(runner.connections, 1)
  beforeVerdict = () => sessionPolicies.set(OUTER, { mode: 'read-only' })
  assert.match((await nested()).content[0].text, /exit code: 125.*REFUSED/s)
  assert.equal(runner.acknowledgements, 2)
  assert.equal(runner.requests.length, 1)
})

for (const [label, depth, missingHeader = false] of [
  ['calling session', 0],
  ['parent', 1],
  ['ancestor at depth 32', 32],
  ['ancestor beyond a missing intermediate header', 2, true],
]) {
  test(`a failed permission downgrade during proof holds the Bot command for the ${label}`, linuxRunner, async t => {
    let downgrade
    const runner = await fakeRunner(t, { beforeVerdict: () => downgrade() })
    const { root, rt, bot, home, invoke, sessions, record } = await world(t)
    const target = depth === 0 ? bot.session : root.sessions.create('shell-parent', { meta: { cwd: home } })
    let outer = target
    let intermediate
    for (let step = 1; step <= depth; step += 1) {
      const id = step === depth ? OUTER : `shell-ancestor-${step}`
      outer = root.sessions.create(id, { meta: { cwd: home, origin: 'subagent', parentSession: outer.id } })
      if (step === 1 && missingHeader) intermediate = outer
    }
    if (depth > 0) {
      const ownerId = (intermediate ?? target).id
      t.after(rt.hooks.sessionOwner(id => id === ownerId ? { botId: BOT } : undefined))
      sessions[OUTER] = `bot:${BOT}`
      record()
    }
    const failed = new Error('fixture cannot apply read-only')
    root.provide('permissionPresets', {
      catalog: () => ({ options: [{ value: 'read-only' }], defaultPreset: 'workspace-write' }),
      set: () => { throw failed },
    })
    const noSpawn = spawnSentinel(t)
    downgrade = async () => {
      assert.equal(rt.levelHeld(target.id), false)
      await assert.rejects(rt.applyPermission({ ...rt.botOf(BOT), permission: 'read-only' }, target.id, undefined, target), failed)
      assert.equal(rt.levelHeld(target.id), true)
      if (depth > 0) assert.equal(rt.levelHeld(outer.id), false)
      assert.equal(root.get('sandboxPolicy').resolve({ session: outer }).mode, 'workspace-write')
      assert.equal(root.get('sandboxPolicy').resolve({ session: bot.session }).mode, 'workspace-write')
      if (intermediate !== undefined) {
        intermediate.header = undefined
        assert.equal(root.get('automagikBotSessions').botOf(outer.id), BOT)
      }
    }
    const header = intermediate?.header
    const result = await (depth === 0 ? invoke(bot) : sessionScope.run(scopeWith(OUTER), () => invoke(bot)))
      .finally(() => { if (intermediate !== undefined) intermediate.header = header })
    assert.match(result.content[0].text, /exit code: 125.*REFUSED: Bot command admission is no longer valid/s)
    assert.equal(runner.requests.length, 0)
    assert.equal(runner.acknowledgements, 1)
    noSpawn()
  })
}

test('a ready runner does not attest a same-name replacement or its activation', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  const { root, rt, bot, invoke } = await world(t)
  const definition = root.tools.get(BOT_SHELL, bot)
  assert.ok(definition)
  const activate = t.mock.fn(() => true)
  const execute = t.mock.fn((_exec, next) => next())
  root.on('tools/execute', execute, { prepend: true })
  const swap = root.on('tools/pre-execute', (_exec, next) => {
    rt.removeTeamTool(BOT_SHELL)
    bot.ctx.tools.register(definition, { when: activate })
    return next()
  }, { prepend: true })
  refused(await invoke(bot))
  swap()
  assert.equal(root.tools.get(BOT_SHELL, bot), undefined)
  const toolSet = await root.tools.resolve({ agent: bot, signal: new AbortController().signal })
  assert.equal(toolSet.view(bot).has(BOT_SHELL), false)
  toolSet.dispose()
  refused(await invoke(bot))
  assert.equal(activate.mock.callCount(), 0)
  assert.equal(execute.mock.callCount(), 0)
  assert.equal(runner.connections, 0)
})

test('runner loss after readiness fails closed', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  const { root, bot, invoke } = await world(t)
  const noSpawn = spawnSentinel(t)
  assert.ok(root.tools.get(BOT_SHELL, bot))
  const loss = root.on('tools/pre-execute', async (_exec, next) => {
    await runner.stop()
    return next()
  }, { prepend: true })
  const result = await invoke(bot)
  if (result.isError) refused(result)
  else assert.match(result.content[0].text, /exit code: 125/)
  loss()
  assert.equal(inspect().ok, false)
  assert.equal(root.tools.get(BOT_SHELL, bot), undefined)
  refused(await invoke(bot))
  assert.equal(runner.connections, 0)
  noSpawn()
})

test('desktop mode with runner variables does not register the Bot shell', async t => {
  const runnerRoot = join(tmpdir(), 'desktop-runner-fixture')
  setEnv(t, {
    AUTOMAGIK_BOT_RUNNER_SOCKET: join(runnerRoot, 'runner.sock'),
    AUTOMAGIK_BOT_RUNNER_PROOFS: join(runnerRoot, 'proofs'),
    AUTOMAGIK_BOT_RUNNER_WORK_ROOT: join(runnerRoot, 'work'),
    AUTOMAGIK_BOT_RUNNER_UID: '40001',
    AUTOMAGIK_BOT_RUNNER_GID: '40002',
  })
  const { root, rt, bot, invoke, ownerExecute } = await world(t, { mode: '0' })
  assert.equal(rt.teamTools.some(tool => tool.name === BOT_SHELL), false)
  assert.equal(root.tools.get(BOT_SHELL, bot), undefined)
  const ordinary = await invoke(bot, { command: 'fixture', description: 'Desktop fixture command' }, 'bash')
  assert.equal(ordinary.isError, false)
  assert.match(ordinary.content[0].text, /owner path/)
  assert.equal(ownerExecute.mock.callCount(), 1)
})
