import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../../acp-dsh/src/host/acp.js'
import { createIdentityReaders } from '../../acp-dsh/src/host/identity.js'
import { nativeWorld } from '../../acp-dsh/test/fixtures/managed-native-world.js'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solver-confine-')))
  const home = join(root, 'team')
  const folder = join(root, 'workspace')
  const work = join(folder, 'project')
  const protectedRoot = join(folder, 'fixture-private')
  const outside = join(root, 'elsewhere')
  for (const path of [home, work, protectedRoot, outside]) mkdirSync(path, { recursive: true })
  const inside = join(work, 'inside.txt')
  const outsideFile = join(outside, 'outside.txt')
  writeFileSync(inside, 'inside fixture')
  writeFileSync(outsideFile, 'independent fixture')
  let cwd = folder
  const identity = createIdentityReaders(() => {})
  const ctx = fakeContext({ services: {
    acpAgents: { signInRoots: () => [protectedRoot], botIdentity: identity.register },
    workingDirectory: { get: () => cwd, ensure: async () => cwd },
  } })
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  t.after(async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  await rt.load()
  const bot = rt.state.bots['fixture-solver'] = { id: 'fixture-solver', name: 'Solver', role: 'Solver', workDir: folder, createdAt: 1 }
  rt.chatOwners.set(bot.id, bot.id)
  const session = { id: bot.id, header: { id: bot.id, cwd: folder } }
  const agent = { id: bot.id, session }
  const guard = ctx.listeners.get('tools/execute')[0]
  const execute = (name, args, body = () => 'fake body entered') => {
    const exec = { name, arguments: args, callId: 'fixture-call', agent }
    return guard(exec, () => body(exec.arguments))
  }
  return { root, home, work, folder, inside, outsideFile, protectedRoot, rt, bot, agent, identity, execute, setCwd: path => { cwd = path } }
}

test('#2134 F5 C1-C4 G6 C7 K5a-b confined reads and traversal refuse before an inert body', async t => {
  const w = await setup(t)
  let entered = 0
  const inert = () => { entered += 1 }
  for (const [name, args] of [
    ['read', { file_path: w.outsideFile }],
    ['read_image', { file_path: join(w.protectedRoot, 'absent-image') }],
    ['grep', { path: w.folder, pattern: 'marker' }],
    ['glob', { path: w.folder, pattern: '**' }],
    ['grep', { pattern: 'marker' }],
  ]) await assert.rejects(w.execute(name, args, inert), /can (read and )?search only inside its folder/)
  assert.equal(entered, 0)
  const positive = await w.execute('read', { file_path: w.inside }, args => readFileSync(args.file_path, 'utf8'))
  assert.equal(positive, 'inside fixture')
  assert.equal(await w.execute('glob', { path: w.work, pattern: '**' }), 'fake body entered')
})

test('#2134 K5c passes the checked canonical filename and omitted search root to the inert body', async t => {
  const w = await setup(t)
  const alias = join(w.work, 'alias.txt')
  symlinkSync(w.inside, alias, 'file')
  assert.equal(await w.execute('read', { file_path: alias }, args => args.file_path), w.inside)
  w.setCwd(w.work)
  assert.equal(await w.execute('grep', { pattern: 'fixture' }, args => args.path), w.work)
})

test('#2134 K5d H5 agent-owned paths require a placed, link-free path', async t => {
  const w = await setup(t)
  const alias = join(w.work, 'alias.txt')
  symlinkSync(w.inside, alias, 'file')
  const call = path => ({ agent: w.agent, provider: 'acp-claude', cwd: w.work, args: {
    kind: 'read', input: { file_path: path }, id: 'fixture-marker',
  } })
  assert.equal(w.rt.solverQuestionDecision?.(call(w.inside))?.decision, 'allow')
  assert.equal(w.rt.solverQuestionDecision(call(alias)).decision, 'refuse')
  assert.equal(w.rt.solverQuestionDecision({ ...call('inside.txt'), cwd: undefined }).decision, 'refuse')
})

test('#2134 K3 AW-R3 missing intermediate ownership cannot dispatch a DSH body', async t => {
  const w = await setup(t)
  const sessions = new Map([['child', { header: { id: 'child', origin: 'subagent', parentSession: 'missing' } }]])
  w.rt.ctx.sessions = { get: id => sessions.get(id) }
  const exec = {
    name: 'read', arguments: { file_path: w.inside },
    agent: { id: 'child', session: { id: 'child', header: sessions.get('child').header } },
  }
  let ran = false
  const guard = w.rt.ctx.listeners.get('tools/execute')[0]
  await assert.rejects(guard(exec, () => { ran = true }), /could not confirm this Session.s rules/)
  assert.equal(ran, false)
  sessions.set('missing', { header: { id: 'missing', origin: 'subagent', parentSession: w.bot.id } })
  assert.equal(w.rt.solverPolicyOf('child', exec.agent).bot, w.bot)
  assert.equal(w.rt.botOfSession('child', exec.agent), w.bot)
})

test('#2134 source 3 exact lineage reaches the ACP policy reader and DSH tool gate', async t => {
  const w = await setup(t)
  const id = 'lineage-fixture'
  const root = { id, cwd: w.work }
  const child = { ...root, origin: 'subagent', parentSession: w.bot.id, delegationDepth: 1 }
  const sessions = new Map()
  w.rt.ctx.sessions = { get: id => sessions.get(id) }
  const guard = w.rt.ctx.listeners.get('tools/execute')[0]
  const run = header => guard({
    name: 'read', arguments: { file_path: w.inside }, agent: { id, session: { id, header } },
  }, () => 'inert body')
  await t.test('confirmed root and child retain their routes', async () => {
    for (const [header, expected] of [[root, 'none'], [child, 'solver']]) {
      sessions.set(id, { id, header })
      assert.equal(w.identity.readState(id).identity?.solverPolicy.state, expected)
      assert.equal(await run(header), 'inert body')
    }
  })
  await t.test('unknown origin and wrong header ID are unavailable', async () => {
    for (const header of [{ ...root, origin: 'unfamiliar' }, { ...child, id: 'another-session' }]) {
      sessions.set(id, { id, header })
      assert.deepEqual(w.identity.readState(id), { ok: false })
      await assert.rejects(run(header), /could not confirm this Session.s rules/)
    }
  })
  await t.test('stored and live lineage disagreement is unavailable', async () => {
    sessions.set(id, { id, header: root })
    await assert.rejects(run(child), /could not confirm this Session.s rules/)
  })
})

test('#2134 exception 3 ACP and DSH reconcile registered lineage at each exact Session', async t => {
  const w = await setup(t)
  const sessions = new Map()
  const agents = new Map()
  w.rt.ctx.sessions = sessions
  w.rt.ctx.provide('agents', agents)
  const id = 'lineage-child'
  const parentId = 'lineage-parent'
  const root = { id, cwd: w.work }
  const parent = { id: parentId, origin: 'subagent', parentSession: w.bot.id, delegationDepth: 1 }
  const child = { ...root, origin: 'subagent', parentSession: parentId, delegationDepth: 2 }
  const holder = header => ({ id: header.id, session: { id: header.id, header } })
  const store = header => sessions.set(header.id, holder(header).session)
  const register = header => agents.set(header.id, holder(header))
  const guard = w.rt.ctx.listeners.get('tools/execute')[0]
  const run = header => guard({
    name: 'read', arguments: { file_path: w.inside }, agent: holder(header),
  }, () => 'inert body')
  const refuse = async header => {
    assert.deepEqual(w.identity.readState(id), { ok: false })
    await assert.rejects(run(header), /could not confirm this Session.s rules/)
  }

  await t.test('matching registered and stored root and descendants retain their routes', async () => {
    for (const [header, expected] of [[root, 'none'], [child, 'solver']]) {
      store(header)
      register(header)
      store(parent)
      register(parent)
      store(w.agent.session.header)
      register(w.agent.session.header)
      assert.equal(w.identity.readState(id).identity.solverPolicy.state, expected)
      assert.equal(await run(header), 'inert body')
    }
  })
  await t.test('ACP sees a registered child and rejects a conflicting stored root', async () => {
    store(root)
    register(child)
    await refuse(child)
  })
  await t.test('a traversed parent disagrees on origin, direct parent or depth', async () => {
    store(child)
    register(child)
    store(parent)
    for (const header of [{ id: parentId }, { ...parent, parentSession: 'other-fixture' }, { ...parent, delegationDepth: 2 }]) {
      register(header)
      await refuse(child)
    }
  })
  await t.test('a registered Agent points at another Session', async () => {
    register(parent)
    agents.set(id, { id, session: holder(parent).session })
    await refuse(child)
  })
  await t.test('DSH also checks its explicitly supplied live header against both sources', async () => {
    register(child)
    assert.equal(w.identity.readState(id).identity.solverPolicy.state, 'solver')
    await assert.rejects(run(root), /could not confirm this Session.s rules/)
  })
})

test('#2134 source 4 the ACP search root is checked independently of locations', async t => {
  const w = await setup(t)
  const search = (cwd, input, location = w.inside) => w.rt.solverQuestionDecision({
    agent: w.agent, provider: 'acp-claude', cwd, args: {
      kind: 'search', id: 'synthetic-search', input, locations: [{ path: location }],
    },
  })
  await t.test('explicit and default in-folder roots are allowed', () => {
    assert.equal(search(w.work, { pattern: 'fixture' }).decision, 'allow')
    assert.equal(search(w.folder, { pattern: 'fixture', path: w.work }).decision, 'allow')
  })
  await t.test('the reported location leaves an unconfined default root refused', () => {
    assert.equal(search(w.folder, { pattern: 'fixture' }).decision, 'refuse')
  })
  await t.test('invalid supplied locations and roots stay refused', () => {
    assert.equal(search(w.work, { pattern: 'fixture' }, w.outsideFile).decision, 'refuse')
    assert.equal(search(w.work, { pattern: 'fixture', path: 0 }).decision, 'refuse')
  })
})

test('#2134 source 6 Claude session rules protect regular files beside the team workspace', async t => {
  const w = await setup(t)
  const workspace = join(w.home, 'workspace')
  const privateFolder = join(w.home, 'other-data')
  const privateFile = join(w.home, 'fixture-state.json')
  mkdirSync(workspace)
  mkdirSync(privateFolder)
  writeFileSync(privateFile, 'fixture data')
  w.rt.teamFolder = () => workspace
  w.bot.workDir = workspace
  const world = nativeWorld(t, {
    managed: true, hidden: true,
    identity: () => ({
      name: 'Solver', solver: true, solverPolicy: { state: 'solver' }, nativeTools: true, nativeToolsAgent: 'acp-claude',
      confineDeny: w.identity.readState(w.bot.id).identity.confineDeny,
    }),
    policyState: id => world.identityReaders.readState(id),
  })
  await world.chat('fixture-claude', { cwd: workspace }).turn('synthetic request')
  const rules = world.events('new-session')[0].meta.claudeCode.options.settings.permissions
  const root = path => `Read(/${path}`
  assert.ok(rules.deny.includes(`${root(privateFolder)}/**)`))
  assert.ok(rules.deny.includes(`${root(w.protectedRoot)}/**)`))
  assert.ok(rules.deny.every(rule => !rule.startsWith(root(workspace))))
  assert.ok(rules.deny.includes(`${root(privateFile)})`), 'the sibling file itself has an exact Read denial')
})

test('#2134 exception 6 Claude encodes ordinary paths and holds literal POSIX names before dispatch', {
  skip: process.platform === 'win32',
}, async t => {
  for (const timing of ['ordinary paths', 'before launch', 'after fake launch']) await t.test(timing, async t => {
    const w = await setup(t)
    const workspace = join(w.home, 'workspace')
    const protectedFile = join(w.home, 'literal\\name.txt')
    const ordinaryFile = join(w.home, 'fixture-state.json')
    mkdirSync(workspace)
    writeFileSync(ordinaryFile, 'synthetic data')
    w.rt.teamFolder = () => workspace
    w.bot.workDir = workspace
    const world = nativeWorld(t, {
      managed: true, hidden: true,
      identity: () => ({
        name: 'Solver', solver: true, solverPolicy: { state: 'solver' }, nativeTools: true, nativeToolsAgent: 'acp-claude',
        confineDeny: w.identity.readState(w.bot.id).identity.confineDeny,
      }),
      policyState: id => world.identityReaders.readState(id),
    })
    world.adapter.dshTools = () => false
    const addProtected = () => {
      writeFileSync(protectedFile, 'synthetic data')
      assert.ok(w.identity.readState(w.bot.id).identity.confineDeny
        .some(entry => entry.path === protectedFile && entry.kind === 'file'))
    }
    const chat = world.chat('fixture-claude', { cwd: workspace })
    if (timing === 'ordinary paths') {
      await chat.turn('synthetic request')
      const rules = world.events('new-session')[0].meta.claudeCode.options.settings.permissions
      assert.ok(rules.deny.includes(`Read(/${ordinaryFile})`))
      assert.ok(rules.deny.includes(`Read(/${w.protectedRoot}/**)`))
      assert.ok(rules.deny.every(rule => !rule.startsWith(`Read(/${workspace}`)))
      assert.equal(world.events('prompt').length, 1)
      return
    }
    if (timing === 'before launch') {
      addProtected()
      await chat.turn('synthetic request')
      assert.equal(world.events('new-session').length, 0)
    } else {
      const start = AgentRun.prototype.start
      let mutations = 0
      t.mock.method(AgentRun.prototype, 'start', async function (...args) {
        const result = await start.apply(this, args)
        assert.equal(world.events('new-session').length, 1, 'the fake session started before the mutation')
        assert.equal(world.events('prompt').length, 0, 'the mutation precedes the first prompt')
        addProtected()
        mutations += 1
        return result
      })
      await chat.turn('synthetic request')
      assert.equal(mutations, 1, 'the protected file was added at the awaited start boundary')
      assert.equal(world.events('new-session').length, 1)
      t.diagnostic(`start-boundary mutations=${mutations}; new-session before mutation=1; prompts after turn=${world.events('prompt').length}`)
    }
    assert.equal(world.events('prompt').length, 0)
  })
})
