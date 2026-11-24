import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyExecutor, inject as executorInject } from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../index.js'
import { output } from '../src/host/tools.js'
import { installRoles } from '../src/host/roles.js'
import { fakeContext } from './fake-ctx.js'
import { entryOf, INDEX, manifestOf, packageOf, SIGNATURE, signer, solverCutHistory } from './role-fixture.js'

const WRITE = 'workspace-write'
const READ = 'read-only'
const FULL = 'danger-full-access'
const grants = ['task-start', 'route-policy']
const models = [
  { ref: 'native-a/one' }, { ref: 'acp-codex/two' }, { ref: 'native-b/key', needsKey: true },
  { ref: 'hermes-remote/h' }, { ref: 'native-b/ready-but-signed-out' }, { ref: 'acp-claude/x' },
  { ref: 'native-b/covered', covered: true },
  ...Array.from({ length: 21 }, (_, index) => ({ ref: `native-c/m${String(index).padStart(2, '0')}` })),
]
const task = { title: 'Fixture task', instructions: 'Return fixture output.' }
const guard = /review guard is on.*turn the review guard off in .* Details\./
const none = /\nModels you may name: none; leave out model\.$/
const permission = /permission level could not be proven/
const changed = /start changed while it was being prepared/
const teamBot = (id, home, fields = {}) => ({
  id, sessionId: id, name: id, instructions: '', createdAt: 1, model: 'native-a/one', permission: WRITE, workDir: home, ...fields,
})

async function fixture(t, { routePolicy, fresh = false, catalogSolver = false, runner = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'task-start-'))
  const stateFile = join(home, 'state.json')
  const bots = {
    solver: teamBot('solver', home),
    main: teamBot('main', home, { reviewerId: 'reviewer' }),
    omni: teamBot('omni', home, { kind: 'omni' }),
    reviewer: teamBot('reviewer', home),
  }
  const rooms = { room: { id: 'room', name: 'Room', named: true, members: ['solver', 'main'],
    sessions: { solver: 'solver-room' }, permission: WRITE, seq: 0, log: [] } }
  if (!fresh) await writeFile(stateFile, JSON.stringify({ version: 2, bots, rooms, mainBotIds: ['main'], reviewGuardMigrated: true }))
  const harness = new Context()
  await harness.plugin(SystemPrompt)
  await harness.plugin(ToolRuntime)
  await harness.plugin({ apply: applyExecutor, inject: executorInject })
  let scopeParent
  await harness.inject(['tools'], ctx => { scopeParent = ctx })
  const open = new Map()
  const level = new Map()
  const created = []
  const dispatched = []
  const archived = []
  const stops = []
  const selected = new Map()
  const spec = {
    [WRITE]: { sandbox: WRITE, approval: 'ask' },
    [READ]: { sandbox: READ, approval: 'ask' },
    [FULL]: { sandbox: FULL, approval: 'never' },
  }
  const permissions = {
    catalog: () => ({ options: Object.keys(spec).map(value => ({ value })), defaultPreset: WRITE }),
    resolve: name => spec[name],
    current: session => level.get(session.id),
    set: (session, name) => { level.set(session.id, name) },
  }
  const agentOf = (id, initial = WRITE) => {
    if (open.has(id)) return open.get(id)
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: home })
    const agent = { id, session, followup: () => dispatched.push(id), whenIdle: async () => {}, cancel() {} }
    agent.ctx = createScope(scopeParent, agent).ctx
    open.set(id, agent)
    level.set(id, initial)
    return agent
  }
  for (const id of [...Object.keys(bots), 'solver-room']) agentOf(id)

  const contexts = new Set()
  t.after(async () => {
    for (const ctx of contexts) await ctx.dispose()
    await harness.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })

  const manifest = manifestOf({
    id: catalogSolver ? 'solver' : 'tasker', name: 'Fixture role', capabilities: catalogSolver ? [] : grants,
    ...(runner ? { settings: [{ key: 'voice', kind: 'voice', label: 'Voice' }] } : {}),
  })
  const bytes = packageOf(manifest)
  const record = entryOf(bytes, { id: manifest.id, capabilities: manifest.capabilities })
  const signed = signer()
  const index = signed.index([record])
  const assets = new Map([[INDEX, index.bytes], [SIGNATURE, index.signature], [record.source, bytes]])

  const launchHost = (config, realExecutor = false) => {
    const ctx = fakeContext({ services: { permissionPresets: permissions, agents: { list: () => [...open.values()], get: id => open.get(id) } } })
    Object.assign(ctx, {
      workspaceRegistry: { get: () => ({ id: 'fixture', path: home }),
        resolveByPath: async () => ({ id: 'fixture', path: home }),
        archiveSession: async (id, options) => { archived.push([id, options]) } },
      sessions: { get: id => open.get(id)?.session, list: () => [...open.values()].map(agent => agent.session), flush: async () => {} },
      sessionTitle: { rename: async () => {} },
      sessionController: {
        create: async ({ sessionId = `session-${randomUUID()}` }) => {
          created.push(sessionId)
          agentOf(sessionId, FULL)
          return { sessionId }
        },
        resolveAgent: async id => ({ agent: agentOf(id) }),
        selectModel: async ({ sessionId, provider, model }) => {
          selected.set(sessionId, `${provider}/${model}`)
          return { selected: { provider, model } }
        },
      },
    })
    if (realExecutor) ctx.tools = harness.tools
    apply(ctx, { home, memory: false, browser: false, updateCheck: false, diagnosticsFile: false, ...config })
    contexts.add(ctx)
    const rt = ctx.provided.get('omniTeam')
    if (runner) rt.botRunnerRequired = () => true
    installRoles(rt, { keys: [signed.key], bundledHistory: solverCutHistory(),
      ...(catalogSolver ? { bundledRoot: join(home, 'no-bundle') } : {}),
      fetch: async url => {
        assert.ok(assets.has(url), `Unexpected fixture fetch: ${url}`)
        return new Response(assets.get(url))
      } })
    rt.catalog = async () => models
    rt.modelAccess = async ref => ({ ready: ref !== 'native-b/ready-but-signed-out' })
    rt.desiredModel = async bot => bot.model
    rt.noteStop = (id, stop) => stops.push({ id, ...stop })
    return { ctx, rt }
  }
  const h = launchHost({ routePolicy }, true)
  const { ctx, rt } = h
  await rt.load()
  if (fresh) {
    Object.assign(rt.state, { bots, rooms, mainBotIds: ['main'] })
    await rt.save({ required: true })
  }
  for (const fn of ctx.listeners.get('tools/execute')) harness.on('tools/execute', fn)
  for (const fn of ctx.listeners.get('tools/pre-execute')) harness.on('tools/pre-execute', fn, { prepend: true })

  const execute = async (id, args = task, name = 'start_task', agent = agentOf(id)) => {
    const result = await harness.tools.execute({ agent, signal: new AbortController().signal,
      calls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }] })
    return result.results[0].result.content.map(part => part.text).join('\n')
  }
  const hostTool = (name, execute) => harness.tools.register(defineTool({ name, description: name, parameters: {}, execute, output }))
  const grant = (id, capability, on = true) => rt.grantRole({ id, role: rt.botOf(id).roles[0], capability, on })
  const attach = async (roleId = manifest.id, ids = ['solver']) => {
    await rt.installRole(roleId)
    for (const id of ids) await rt.attachRole(id, roleId)
  }
  return { ...h, agentOf, created, dispatched, archived, stops, selected, level, permissions, spec,
    execute, hostTool, grant, attach, launchHost, stateFile }
}

test('PD3N-5: Tasks APIs retain the guarded executor caller with no attribution or an unguarded from', async t => {
  const h = await fixture(t)
  const { rt } = h
  const independent = await rt.createTaskSession('Independent')
  const tasksAgent = Object.values(rt.state.agents).find(agent => agent.kind === 'tasks')
  h.hostTool('fixture_task_start', () => rt.startTask({ title: 'Fixture', text: 'No work', from: 'reviewer' }))
  h.hostTool('fixture_raw_task', () => rt.createTaskSession('No attribution'))
  h.hostTool('fixture_task_agent', () => rt.createAgentSession(tasksAgent.id))
  rt.botOf('main').reviewGuard = true
  rt.botOf('main').reviewTrack = { planVerdictAt: 20 }
  for (const name of ['fixture_task_start', 'fixture_raw_task', 'fixture_task_agent']) {
    assert.match(await h.execute('main', {}, name), guard, name)
  }
  await assert.rejects(rt.startTask({ title: 'Attributed', text: 'No work', from: 'main' }), guard)
  assert.deepEqual(h.created, [independent])
  assert.deepEqual(h.dispatched, [])
  assert.doesNotMatch(await h.execute('reviewer', {}, 'fixture_raw_task'), guard)
  assert.equal(h.created.length, 2)

  const pause = Promise.withResolvers()
  const folder = rt.isFolder
  rt.isFolder = async dir => {
    await pause.promise
    assert.equal(rt.callerSessionId(), undefined)
    return folder(dir)
  }
  let late
  rt.botOf('main').reviewGuard = false
  h.hostTool('fixture_queue_task', () => {
    late = rt.createTaskSession('Queued', { cwd: rt.botOf('main').workDir }).catch(error => error)
    return 'Queued.'
  })
  assert.equal(await h.execute('main', {}, 'fixture_queue_task'), 'Queued.')
  rt.botOf('main').reviewGuard = true
  pause.resolve()
  assert.match((await late).message, guard)
  assert.equal(h.created.length, 2)
})

test('the guarded start_task result and stop include the remedy before and after verdict, including a bridge ask', async t => {
  const h = await fixture(t)
  const { rt, ctx } = h
  rt.botOf('main').reviewGuard = true
  for (const reviewTrack of [undefined, { planVerdictAt: 20 }]) {
    rt.botOf('main').reviewTrack = reviewTrack
    assert.match(await h.execute('main'), guard)
    assert.equal(h.stops.at(-1).why, 'guard-launch')
  }
  const bridgeCall = {}
  const request = { agent: h.agentOf('main'), toolName: 'mcp__dsh__start_task', bridgeCall, callId: 'bridge' }
  const hooks = [...ctx.listeners.get('approval/request')].reverse()
  const next = i => () => i < hooks.length ? hooks[i](request, next(i + 1)) : 'person'
  assert.equal(await next(0)(), 'rejected')
  assert.match(bridgeCall.refused.reason, guard)
  assert.deepEqual(h.created, [])
  assert.deepEqual(h.dispatched, [])
})

test('a guard turned on during folder preparation refuses before allocation and during create archives before dispatch', async t => {
  const h = await fixture(t)
  const { rt, ctx } = h
  const isFolder = rt.isFolder
  rt.isFolder = async dir => {
    rt.botOf('main').reviewGuard = true
    return isFolder(dir)
  }
  assert.match(await h.execute('main'), guard)
  assert.equal(h.stops.at(-1).why, 'guard-launch')
  assert.deepEqual(h.created, [])

  rt.botOf('main').reviewGuard = false
  rt.isFolder = isFolder
  const create = ctx.sessionController.create
  ctx.sessionController.create = async fields => {
    const result = await create(fields)
    rt.botOf('main').reviewGuard = true
    return result
  }
  assert.match(await h.execute('main'), guard)
  assert.deepEqual(h.archived, [[h.created[0], { stopActivity: true }]])
  assert.deepEqual(h.dispatched, [])
})

test('grant ordering, one awaited retry list and a real named retry, with legacy Main and Omni controls', async t => {
  const h = await fixture(t, { routePolicy: { default: ['native', 'acp'] } })
  await h.attach('tasker', ['solver', 'reviewer'])
  assert.match(await h.execute('solver'), /Starting tasks is not allowed/)
  assert.match(await h.execute('main', { ...task, model: 'nope' }), none)
  assert.match(await h.execute('main', { ...task, model: 'nope' }), /Naming a model for a task is not allowed/)
  await h.grant('solver', 'task-start')
  assert.match(await h.execute('solver', { ...task, model: 42 }), none)
  assert.match(await h.execute('reviewer'), /Starting tasks is not allowed/)
  const own = await h.execute('solver')
  assert.match(own, /^Started task/)
  assert.equal(h.selected.get(h.created.at(-1)), 'native-a/one')
  await h.grant('solver', 'route-policy')
  for (const model of ['nope', '', 42]) {
    const refused = await h.execute('solver', { ...task, model })
    assert.match(refused, /is not in the list of models/)
    assert.match(refused, /Models you may name: acp-claude\/x, acp-codex\/two, native-a\/one, .* and 4 more\.$/)
    assert.doesNotMatch(refused, /native-b|hermes-remote/)
  }
  assert.match(await h.execute('solver', { ...task, model: 'hermes-remote/h' }), /cannot run a task now/)
  assert.match(await h.execute('solver', { ...task, model: 'native-b/covered' }), /only through its coding CLI/)
  const result = await h.execute('solver', { ...task, model: 'acp-codex/two' })
  assert.match(result, /under your row\. It runs on acp-codex\/two\./)
  assert.equal(h.selected.get(h.created.at(-1)), 'acp-codex/two')
  assert.deepEqual(h.dispatched, h.created)
  assert.equal(h.rt.state.tasks[h.created.at(-1)].from, 'solver')

  for (const id of ['main', 'omni']) {
    const legacy = await h.execute(id)
    assert.equal(legacy, `Started task "Fixture task" (${h.created.at(-1)}) under your row. Its result comes back to you as a message; do not wait or poll.`)
    assert.equal(h.rt.state.tasks[h.created.at(-1)].botBound, undefined)
  }
  const external = await h.rt.startTask({ title: 'Fixture', text: 'Do it', from: 'main', model: 'acp-codex/two' })
  assert.equal(h.selected.get(external), 'native-a/one')
})

test('strict policy is persisted once for a fresh team and never reappears after explicit or missing policy', async t => {
  const h = await fixture(t, { fresh: true })
  assert.deepEqual(h.rt.taskRoutePolicy, { default: ['native', 'acp'], dsh: ['native'] })
  await h.attach()
  for (const capability of grants) await h.grant('solver', capability)
  assert.match(await h.execute('solver', { ...task, model: 'acp-codex/two' }), /^Started task/)
  for (const routePolicy of [{}, { default: [] }, { dsh: ['native'] }, null]) {
    h.rt.config.routePolicy = routePolicy
    assert.match(await h.execute('solver', { ...task, model: 'acp-codex/two' }), /cannot use the ACP route.*\nModels you may name: none/)
  }
  delete h.rt.config.routePolicy
  await h.ctx.dispose()
  const explicit = h.launchHost({ routePolicy: {} })
  await explicit.rt.load()
  assert.equal(explicit.rt.taskRoutePolicy, undefined)
  const saved = JSON.parse(await readFile(h.stateFile, 'utf8'))
  assert.equal(Object.hasOwn(saved, 'taskRoutePolicySeed'), false)
  await explicit.ctx.dispose()
  const missing = h.launchHost({})
  await missing.rt.load()
  assert.equal(missing.rt.taskRoutePolicy, undefined)
})

test('catalog awaits invalidate stale grants and opener bounds before producing a retry list or allocating', async t => {
  const h = await fixture(t, { routePolicy: { default: ['native', 'acp'] } })
  await h.attach()
  for (const capability of grants) await h.grant('solver', capability)
  h.rt.modelAccess = async () => {
    h.level.set('solver', READ)
    return { ready: true }
  }
  assert.match(await h.execute('solver', { ...task, model: 'nope' }), changed)
  assert.deepEqual(h.created, [])
  h.rt.modelAccess = async () => {
    await h.grant('solver', 'route-policy', false)
    return { ready: true }
  }
  const result = await h.execute('solver', { ...task, model: 'acp-codex/two' })
  assert.match(result, changed)
  assert.doesNotMatch(result, /Models you may name/)
  assert.deepEqual(h.created, [])
})

test('an unnamed role task uses the captured applied model when its saved model is unavailable', async t => {
  const h = await fixture(t, { routePolicy: {} })
  await h.attach()
  await h.grant('solver', 'task-start')
  const bot = h.rt.botOf('solver')
  bot.model = 'native-a/unavailable'
  bot.appliedModel = 'acp-codex/two'
  let catalogs = 0
  h.rt.catalog = async () => { catalogs += 1; return models }
  assert.match(await h.execute('solver'), /^Started task/)
  assert.equal(h.selected.get(h.created[0]), 'acp-codex/two')
  assert.equal(catalogs, 1)
  h.rt.modelAccess = async () => {
    bot.appliedModel = 'native-a/one'
    return { ready: true }
  }
  assert.match(await h.execute('solver'), changed)
  assert.equal(h.created.length, 1)
})

test('post-selection failures never dispatch and withhold the retry list without naming authority', async t => {
  const h = await fixture(t, { routePolicy: { default: ['native', 'acp'] } })
  await h.attach()
  await h.grant('solver', 'task-start')
  const select = h.ctx.sessionController.selectModel
  h.ctx.sessionController.selectModel = async () => ({ selected: { provider: 'wrong', model: 'wrong' } })
  let result = await h.execute('solver')
  assert.match(result, /native-a\/one could not be selected/)
  assert.match(result, none)
  await h.grant('solver', 'route-policy')
  result = await h.execute('solver', { ...task, model: 'acp-codex/two' })
  assert.match(result, /acp-codex\/two could not be selected/)
  assert.doesNotMatch(result.split('\n')[1], /acp-codex\/two/)
  h.ctx.sessionController.selectModel = async args => {
    await h.grant('solver', 'task-start', false)
    return select(args)
  }
  assert.match(await h.execute('solver', { ...task, model: 'acp-codex/two' }), changed)
  await h.grant('solver', 'task-start')
  h.ctx.sessionController.selectModel = async args => {
    h.rt.botOf('solver').reviewGuard = true
    return select(args)
  }
  assert.match(await h.execute('solver', { ...task, model: 'acp-codex/two' }), guard)
  assert.equal(h.stops.at(-1).why, 'guard-launch')
  assert.deepEqual(h.dispatched, [])
  assert.deepEqual(h.archived.map(([id]) => id), h.created)
  for (const id of h.created) assert.equal(h.rt.state.tasks[id].status, 'failed')
})

test('equal opener cap persists, live room tasks narrow, and unproven or unapplied levels refuse', async t => {
  const h = await fixture(t, { routePolicy: { default: ['native', 'acp'] } })
  await h.attach()
  await h.grant('solver', 'task-start')
  const started = await h.execute('solver-room')
  assert.match(started, /^Started task/)
  const id = h.created[0]
  assert.equal(h.rt.state.tasks[id].botBound, true)
  assert.equal(h.rt.state.tasks[id].permissionCap, WRITE)
  await h.rt.setPermission(h.rt.botOf('solver'), READ)
  assert.equal(h.level.get(id), READ)
  h.level.delete('solver')
  assert.match(await h.execute('solver'), permission)
  assert.deepEqual(h.created, [id])

  h.level.set('solver', WRITE)
  const current = h.permissions.current
  h.permissions.current = session => session.id.startsWith('session-') && session.id !== id ? FULL : current(session)
  assert.match(await h.execute('solver'), permission)
  assert.deepEqual(h.dispatched, [id])
  assert.equal(h.rt.state.tasks[h.created.at(-1)].status, 'failed')
})

test('Full access admits only the same coding CLI and Remote Hermes cannot run an unnamed task', async t => {
  const h = await fixture(t, { routePolicy: { default: ['native', 'acp', 'hermes-remote'] } })
  const bot = h.rt.botOf('solver')
  await h.attach()
  for (const capability of grants) await h.grant('solver', capability)
  bot.model = 'acp-claude/x'
  bot.permission = FULL
  h.level.set('solver', FULL)
  const refused = await h.execute('solver', { ...task, model: 'native-a/one' })
  assert.match(refused, /Full access on its coding CLI/)
  assert.match(refused, /\nModels you may name: acp-claude\/x\.$/)
  bot.model = 'hermes-remote/h'
  assert.match(await h.execute('solver'), /hermes-remote\/h cannot run a task now/)
  await h.grant('solver', 'route-policy', false)
  assert.match(await h.execute('solver'), none)
  assert.deepEqual(h.created, [])
})

test('verified bundled Solver can grant task-start through Details while a catalog-sourced Solver cannot', async t => {
  const bundled = await fixture(t)
  await bundled.attach('solver')
  assert.deepEqual(bundled.rt.roleDetailsView().solver.installed.capabilities, grants)
  await bundled.grant('solver', 'task-start')
  assert.match(await bundled.execute('solver'), /^Started task/)
  const catalog = await fixture(t, { catalogSolver: true })
  await catalog.attach('solver')
  assert.deepEqual(catalog.rt.roleDetailsView().solver.installed.capabilities, [])
  await assert.rejects(catalog.grant('solver', 'task-start'), /This role does not declare that capability/)
  const runner = await fixture(t, { runner: true })
  await runner.attach()
  assert.equal(runner.rt.roleRuntime.heldOf('solver').runtime, undefined)
  assert.deepEqual(runner.rt.roleRuntime.view().solver.capabilities, grants)
  await runner.grant('solver', 'task-start')
})

test('D3 correction: the original opener ceiling survives renamed and widened presets and holds with no safe offer', async t => {
  const h = await fixture(t)
  await h.attach()
  await h.grant('solver', 'task-start')
  const original = { ...h.spec[READ] }
  h.spec.opener = original
  h.level.set('solver', 'opener')
  assert.match(await h.execute('solver'), /^Started task/)
  const [id] = h.created

  // Reopen the saved team with the original name redefined and an equally narrow replacement.
  await h.ctx.dispose()
  h.spec.opener = h.spec[FULL]
  delete h.spec[READ]
  h.spec.renamed = original
  const reopened = h.launchHost({})
  await reopened.rt.load()
  const session = h.agentOf(id).session
  await reopened.rt.applyTaskPermission(id, session)
  assert.equal(h.level.get(id), 'renamed')

  // A removed preset cannot let even the narrowest remaining offer exceed the original cap.
  delete h.spec.opener
  delete h.spec.renamed
  await assert.rejects(reopened.rt.applyTaskPermission(id, session))
  assert.equal(h.level.get(id), 'renamed')
  assert.equal(reopened.rt.levelHeldFor(id), true)
  await assert.rejects(reopened.rt.levelHolds({ agent: h.agentOf(id) }), /no tool runs here/)

  h.spec.renamed = original
  await reopened.rt.applyTaskPermission(id, session)
  assert.equal(h.level.get(id), 'renamed')
  assert.equal(reopened.rt.levelHeldFor(id), false)
})

test('D3 correction: cleanup can revoke retry-list authority or engage the guard before the response', async t => {
  for (const guarded of [false, true]) {
    const h = await fixture(t, { routePolicy: { default: ['native', 'acp'] } })
    await h.attach()
    for (const capability of grants) await h.grant('solver', capability)
    h.ctx.sessionController.selectModel = async () => ({ selected: { provider: 'native-a', model: 'one' } })
    const archive = h.ctx.workspaceRegistry.archiveSession
    h.ctx.workspaceRegistry.archiveSession = async (...args) => {
      await archive(...args)
      await h.grant('solver', guarded ? 'route-policy' : 'task-start', false)
      if (guarded) h.rt.botOf('solver').reviewGuard = true
    }
    const result = await h.execute('solver', { ...task, model: 'acp-codex/two' })
    assert.match(result, guarded ? guard : changed)
    assert.doesNotMatch(result, /Models you may name|acp-codex\/two/)
    if (guarded) assert.equal(h.stops.at(-1).why, 'guard-launch')
    assert.deepEqual(h.dispatched, [])
  }
})

test('D3 correction: a read-only host retires the explicit policy seed durably when it takes over', async t => {
  const h = await fixture(t, { fresh: true })
  const seeded = JSON.parse(await readFile(h.stateFile, 'utf8'))
  assert.ok(seeded.taskRoutePolicySeed)
  await h.ctx.dispose()
  const lock = join(h.rt.home, 'state.lock')
  await writeFile(lock, JSON.stringify({ token: 'fixture-writer', host: 'fixture-remote', pid: 1 }))
  const successor = h.launchHost({ routePolicy: {} })
  await successor.rt.load()
  assert.ok(successor.rt.readOnly())
  assert.deepEqual(JSON.parse(await readFile(h.stateFile, 'utf8')), seeded)

  await unlink(lock)
  await successor.rt.refresh()
  assert.equal(successor.rt.readOnly(), undefined)
  assert.equal(Object.hasOwn(JSON.parse(await readFile(h.stateFile, 'utf8')), 'taskRoutePolicySeed'), false)
  await successor.ctx.dispose()
  const missing = h.launchHost({})
  await missing.rt.load()
  assert.equal(missing.rt.taskRoutePolicy, undefined)
})

test('D3 correction: a changed catalog generation invalidates choices, allocation and first dispatch', async t => {
  const h = await fixture(t, { routePolicy: { default: ['native', 'acp'] } })
  await h.attach()
  for (const capability of grants) await h.grant('solver', capability)
  const invalidate = async () => {
    for (const fn of h.ctx.listeners.get('llm/adapters-updated')) await fn()
  }
  h.rt.catalog = async () => { await invalidate(); return models }
  const result = await h.execute('solver', { ...task, model: 'missing' })
  assert.match(result, changed)
  assert.doesNotMatch(result, /Models you may name/)
  assert.deepEqual(h.created, [])

  h.rt.catalog = async () => models
  const folder = h.rt.isFolder
  h.rt.isFolder = async dir => { await invalidate(); return folder(dir) }
  assert.match(await h.execute('solver'), changed)
  assert.deepEqual(h.created, [])

  h.rt.isFolder = folder
  const select = h.ctx.sessionController.selectModel
  h.ctx.sessionController.selectModel = async args => { await invalidate(); return select(args) }
  assert.match(await h.execute('solver'), changed)
  assert.equal(h.created.length, 1)
  assert.deepEqual(h.archived, [[h.created[0], { stopActivity: true }]])
  assert.deepEqual(h.dispatched, [])
})

test('D3 correction: an allocation failure retains the actual Session for retry, then removes just its Tasks membership and scope', async t => {
  const h = await fixture(t)
  await h.attach()
  await h.grant('solver', 'task-start')
  assert.match(await h.execute('solver'), /^Started task/)
  const [kept] = h.created
  const scopeDir = join(h.rt.home, 'session-read-scopes')
  const scopedIds = async () => (await Promise.all((await readdir(scopeDir)).map(async file =>
    JSON.parse(await readFile(join(scopeDir, file), 'utf8')).id))).sort()
  const baseline = await scopedIds()
  assert.ok(baseline.includes(kept))
  let reserved
  const actual = 'session-allocated-before-attach-failed'
  h.ctx.sessionController.create = async ({ sessionId }) => {
    reserved = sessionId
    h.created.push(actual)
    h.agentOf(actual, FULL)
    throw Object.assign(new Error('workspace attachment failed'), {
      code: 'session/workspace-attach-failed', details: { sessionId: actual },
    })
  }
  const attempts = []
  h.ctx.workspaceRegistry.archiveSession = async (id, options) => {
    attempts.push([id, options])
    throw new Error('archive unavailable')
  }
  assert.match(await h.execute('solver'), /workspace attachment failed/)
  assert.deepEqual(attempts, [[actual, { stopActivity: true }]])
  const members = rt => Object.values(rt.state.agents).find(agent => agent.kind === 'tasks').sessions
  assert.deepEqual(members(h.rt), [kept, actual])
  assert.ok((await scopedIds()).includes(reserved))
  assert.deepEqual(h.dispatched, [kept])

  await h.ctx.dispose()
  const reopened = h.launchHost({})
  await reopened.rt.load()
  assert.deepEqual(h.archived, [[actual, { stopActivity: true }]])
  assert.deepEqual(members(reopened.rt), [kept])
  assert.deepEqual(await scopedIds(), baseline)
  const saved = JSON.parse(await readFile(h.stateFile, 'utf8'))
  assert.deepEqual(members({ state: saved }), [kept])
})

test('D3 correction: either uncertain flush result acknowledges the queued turn and existing Session', async t => {
  const h = await fixture(t)
  await h.attach()
  await h.grant('solver', 'task-start')
  for (const flush of [async () => false, async () => { throw new Error('disk unavailable') }]) {
    h.ctx.sessions.flush = flush
    const result = await h.execute('solver')
    const id = h.created.at(-1)
    assert.ok(result.includes(id), result)
    assert.match(result, /turn was queued.*could not confirm.*saved/i)
    assert.doesNotMatch(result, /did not start|ask again|try again|retry/i)
    assert.equal(h.rt.state.tasks[id].status, 'working')
  }
  assert.equal(h.created.length, 2)
  assert.deepEqual(h.dispatched, h.created)
  assert.deepEqual(h.archived, [])
})
