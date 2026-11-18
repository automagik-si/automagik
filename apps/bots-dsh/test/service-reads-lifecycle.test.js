// #1392 (follow-up of #1380): optional sibling reads track Cordis service lifecycles.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as Bots from '../index.js'

const SP = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default
const BOT = 'sample-bot'
const CURRENT = 'sample-current-part'
const PICKED = 'sample-picked-root'
const CHILD = 'sample-unloaded-child'

async function bench(t, { store: storeKind = 'real', agents: agentsKind = 'ready', lastTurn = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sample-service-reads-lifecycle-'))
  const host = new Context()
  const gates = []
  t.after(async () => {
    for (const release of gates) release()
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const gated = (group, name, value) => {
    let release
    const gate = new Promise(r => { release = r })
    gates.push(release)
    let provided
    const ready = new Promise(r => { provided = r })
    const fiber = group.plugin({ name: `sample-half-${name}`, apply: async ctx => {
      ctx.provide(name)
      ctx.set(name, value)
      provided()
      await gate
    } })
    return { fiber, ready, release }
  }
  const team = {
    version: 2, revision: 1, mainBotIds: [BOT],
    bots: { [BOT]: { id: BOT, name: 'Sample Bot', kind: 'dsh', dshAgentId: 'sample-entry', profile: 'sample-preset', sessionId: CURRENT, createdAt: 1 } },
    agents: { 'sample-entry': { id: 'sample-entry', name: 'Sample Bot', kind: 'dsh', profile: 'sample-preset', adoptedBotId: BOT, sessions: [CURRENT], createdAt: 1 } },
    rooms: {}, tasks: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const session = { id: PICKED, header: { version: 4, id: PICKED, createdAt: 1, isSeeded: false } }
  const target = { id: PICKED, session, preset: 'sample-preset' }
  const boundaryReads = []
  const agents = { turnBoundaryOf: value => {
    boundaryReads.push(value)
    assert.equal(value, session)
    return { openTurnStartSeq: null, lastTurn }
  } }
  const liveReads = []
  const statReads = []
  const childHeader = { version: 4, id: CHILD, createdAt: 1, isSeeded: false, origin: 'subagent', parentSession: CURRENT }
  const scheduleTasks = new Map()
  const edits = []
  let catalogCalls = 0
  const schedule = {
    catalog: async () => {
      catalogCalls += 1
      return [...scheduleTasks.values()].map(task => structuredClone(task))
    },
    edit: async request => {
      edits.push(request)
      assert.equal(request.action, 'update')
      if (request.patch.active === false) scheduleTasks.get(request.id).status = 'paused'
      return { id: request.id }
    },
    runtime: { requestDrive() {} },
  }
  const services = {
    llm: { listProviders: () => [], listModels: async () => [] },
    tools: { register: () => () => {}, guard: () => () => {}, schemas: () => [] },
    systemPrompt: { context: () => () => {}, section: () => () => {} },
    sessionController: { resolveAgent: async id => ({ agent: id === PICKED ? target : { id, session: { id } } }), selectModel: async () => {} },
    sessions: { get: id => { liveReads.push(id); return id === PICKED ? session : undefined }, list: () => [session], flush: async () => {} },
    sessionTitle: { rename: async () => {} },
    workspaceRegistry: { get: () => ({ id: 'sample-workspace', path: home }) },
    connection: { fetch: { register: () => () => {} } },
  }
  let rt, store, spFiber
  const half = { agents: undefined, store: undefined }
  await host.plugin({ name: 'sample-profile-group', apply: async group => {
    await group.plugin(Storage)
    await group.plugin(StorageJson, { root: join(home, 'storage') })
    await group.plugin(StorageDomain, { backend: 'json' })
    if (storeKind === 'real') {
      const root = join(home, 'sessions')
      spFiber = await group.plugin(SP, { root })
    } else if (storeKind === 'half') {
      half.store = gated(group, 'sessionPersistence', { stat: async id => {
        statReads.push(id)
        return id === CHILD ? { header: childHeader } : undefined
      } })
    }
    await group.plugin({ name: 'sample-host-services', apply: ctx => {
      for (const name of Bots.inject) { ctx.provide(name); ctx.set(name, services[name]) }
    } })
    await group.plugin({ name: 'sample-preset-provider', apply: ctx => {
      ctx.provide('agentPresets')
      ctx.set('agentPresets', {
        list: async () => [{ id: 'sample-preset' }],
        presetForSession: value => value === session ? target.preset : undefined,
        select: async (live, preset) => { live.preset = preset },
      })
    } })
    if (agentsKind === 'half') {
      half.agents = gated(group, 'agents', agents)
    } else {
      await group.plugin({ name: 'sample-agent-provider', apply: ctx => { ctx.provide('agents'); ctx.set('agents', agents) } })
    }
    await group.plugin({ name: 'sample-schedule-provider', apply: ctx => { ctx.provide('schedule'); ctx.set('schedule', schedule) } })
    if (storeKind === 'real') {
      await group.plugin({ name: 'sample-store-consumer', inject: ['sessionPersistence'], apply: ctx => { store = ctx.sessionPersistence } })
      assert.ok(store, 'the JSONL store sibling applied')
    }
    await group.plugin(Bots, { home, mainName: 'Sample Bot' })
    rt = group.get('omniTeam')
  } })
  for (const provider of Object.values(half)) {
    if (provider !== undefined) await provider.ready
  }
  assert.ok(rt, 'the Bot plugin applied')
  await rt.load()
  return { rt, store, spFiber, half, home, session, boundaryReads, liveReads, statReads, scheduleTasks, edits, get catalogCalls() { return catalogCalls } }
}

const taskOf = id => ({ id, title: 'Sample task', status: 'active', target: { kind: 'new', create: { cwd: '/tmp' } }, involvedSessionIds: [CHILD] })

async function unresolvedSweep(b, task) {
  const { rt, liveReads, edits, scheduleTasks } = b
  rt.state.bots[BOT].denyTools = ['bash']
  liveReads.length = 0
  const callsBefore = b.catalogCalls
  const editsBefore = edits.length
  assert.deepEqual(await rt.revokeNewSchedules(BOT), [])
  assert.ok(liveReads.includes(CHILD))
  assert.ok(rt.botOf(BOT))
  assert.ok(rt.botOf(BOT).denyTools.length > 0)
  assert.equal(rt.readOnly?.(), undefined)
  assert.ok(b.catalogCalls > callsBefore)
  assert.equal(edits.length, editsBefore)
  assert.equal(scheduleTasks.get(task.id).status, 'active')
}

test('#1392 (1): an absent store leaves an unloaded-child task active', { timeout: 30_000 }, async t => {
  const b = await bench(t, { store: 'absent' })
  const { rt, scheduleTasks } = b
  assert.equal(rt.ctx.get('sessionPersistence'), undefined)
  assert.equal(rt.ctx.get('sessionPersistence', false), undefined)
  assert.throws(() => rt.ctx.sessionPersistence, /without inject/)
  const task = taskOf('sample-absent-store-task')
  scheduleTasks.set(task.id, task)
  await unresolvedSweep(b, task)
})

test('#1392 (2): a disposed store stops resolving unloaded-child tasks', { timeout: 30_000 }, async t => {
  const b = await bench(t)
  const { rt, store, spFiber, scheduleTasks, edits } = b
  const handle = await store.create({ version: 4, id: CHILD, createdAt: 1, isSeeded: false, origin: 'subagent', parentSession: CURRENT })
  await handle.flush()
  await handle.close()
  assert.equal((await store.stat(CHILD)).header.parentSession, CURRENT)
  const task1 = taskOf('sample-before-dispose-task')
  scheduleTasks.set(task1.id, task1)
  rt.state.bots[BOT].denyTools = ['bash']
  assert.deepEqual(await rt.revokeNewSchedules(BOT), [task1.id])
  assert.equal(scheduleTasks.get(task1.id).status, 'paused')
  assert.deepEqual(edits, [{ id: task1.id, action: 'update', patch: { active: false } }])

  await spFiber.dispose()
  assert.equal(rt.ctx.get('sessionPersistence'), undefined)
  assert.equal(rt.ctx.get('sessionPersistence', false), undefined)
  assert.throws(() => rt.ctx.sessionPersistence, /without inject/)
  const task2 = taskOf('sample-after-dispose-task')
  scheduleTasks.set(task2.id, task2)
  await unresolvedSweep(b, task2)
})

test('#1392 (3): a half-started agents provider cannot vouch for a blank root', { timeout: 30_000 }, async t => {
  const { rt, half, boundaryReads } = await bench(t, { agents: 'half' })
  assert.equal(rt.ctx.get('agents'), undefined)
  assert.notEqual(rt.ctx.get('agents', false), undefined)
  assert.throws(() => rt.ctx.agents, /without inject/)
  const before = structuredClone(rt.state)
  await assert.rejects(rt.adoptBotSession(BOT, PICKED, CURRENT), { code: 'bot/adopt-not-blank' })
  assert.deepEqual(rt.state, before)
  assert.equal(rt.chatOf(BOT), CURRENT)
  assert.deepEqual(boundaryReads, [])

  half.agents.release()
  await half.agents.fiber
  assert.notEqual(rt.ctx.get('agents'), undefined)
  assert.equal(await rt.adoptBotSession(BOT, PICKED, CURRENT), PICKED)
  assert.equal(rt.chatOf(BOT), PICKED)
  assert.ok(boundaryReads.length > 0)
})

test('#1392 (4): a half-started store cannot resolve an unloaded child', { timeout: 30_000 }, async t => {
  const b = await bench(t, { store: 'half' })
  const { rt, half, statReads, scheduleTasks } = b
  assert.equal(rt.ctx.get('sessionPersistence'), undefined)
  assert.notEqual(rt.ctx.get('sessionPersistence', false), undefined)
  assert.throws(() => rt.ctx.sessionPersistence, /without inject/)
  const task = taskOf('sample-half-store-task')
  scheduleTasks.set(task.id, task)
  await unresolvedSweep(b, task)
  assert.deepEqual(statReads, [])

  half.store.release()
  await half.store.fiber
  assert.notEqual(rt.ctx.get('sessionPersistence'), undefined)
  rt.state.bots[BOT].denyTools = ['bash']
  assert.deepEqual(await rt.revokeNewSchedules(BOT), [task.id])
  assert.equal(scheduleTasks.get(task.id).status, 'paused')
  assert.ok(statReads.includes(CHILD))
})
