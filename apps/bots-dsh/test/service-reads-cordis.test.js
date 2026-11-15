// #1365, #1366: optional sibling services in real Cordis preserve Bot joins and
// pause fresh-Session schedules through an unloaded child's real JSONL header.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const CURRENT = 'current-part'
const PICKED = 'picked-root'
const CHILD = 'unloaded-child'

async function bench(t, { lastTurn = 0, agentsAvailable = true, fork = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'service-reads-cordis-'))
  const host = new Context()
  t.after(async () => {
    await host.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const team = {
    version: 2, revision: 1, mainBotIds: [BOT],
    bots: { [BOT]: { id: BOT, name: 'Sample Bot', kind: 'dsh', dshAgentId: 'sample-entry', profile: 'sample-preset', sessionId: CURRENT, createdAt: 1 } },
    agents: { 'sample-entry': { id: 'sample-entry', name: 'Sample Bot', kind: 'dsh', profile: 'sample-preset', adoptedBotId: BOT, sessions: [CURRENT], createdAt: 1 } },
    rooms: {}, tasks: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const session = { id: PICKED, header: { version: 4, id: PICKED, createdAt: 1, isSeeded: fork, ...(fork ? { parentSession: CURRENT } : {}) } }
  const target = { id: PICKED, session, preset: 'sample-preset' }
  const boundaryReads = []
  const agents = { turnBoundaryOf: value => {
    boundaryReads.push(value)
    assert.equal(value, session)
    return { openTurnStartSeq: null, lastTurn }
  } }
  const scheduleTasks = new Map()
  const edits = []
  const schedule = {
    catalog: async () => [...scheduleTasks.values()].map(task => structuredClone(task)),
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
    sessions: { get: id => id === PICKED ? session : undefined, list: () => [session], flush: async () => {} },
    sessionTitle: { rename: async () => {} },
    workspaceRegistry: { get: () => ({ id: 'sample-workspace', path: home }) },
    connection: { fetch: { register: () => () => {} } },
  }
  let rt, store
  await host.plugin({ name: 'sample-profile-group', apply: async group => {
    await group.plugin(Storage)
    await group.plugin(StorageJson, { root: join(home, 'storage') })
    await group.plugin(StorageDomain, { backend: 'json' })
    await group.plugin(SP, { root: join(home, 'sessions') })
    await group.plugin({ name: 'sample-host-services', apply: ctx => {
      for (const name of Bots.inject) { ctx.provide(name); ctx.set(name, services[name]) }
    } })
    await group.plugin({ name: 'sample-agent-provider', apply: ctx => {
      if (agentsAvailable) { ctx.provide('agents'); ctx.set('agents', agents) }
      ctx.provide('agentPresets')
      ctx.set('agentPresets', {
        list: async () => [{ id: 'sample-preset' }],
        presetForSession: value => value === session ? target.preset : undefined,
        select: async (live, preset) => { live.preset = preset },
      })
    } })
    await group.plugin({ name: 'sample-schedule-provider', apply: ctx => { ctx.provide('schedule'); ctx.set('schedule', schedule) } })
    await group.plugin({ name: 'sample-store-consumer', inject: ['sessionPersistence'], apply: ctx => { store = ctx.sessionPersistence } })
    await group.plugin(Bots, { home, mainName: 'Sample Bot' })
    rt = group.get('omniTeam')
  } })
  assert.ok(store, 'the JSONL store sibling applied')
  assert.ok(rt, 'the Bot plugin applied')
  await rt.load()
  return { rt, store, home, session, boundaryReads, scheduleTasks, edits }
}

test('#1365 (a): a blank root joins using the sibling agents service', async t => {
  const { rt, home, session, boundaryReads } = await bench(t)
  assert.equal(await rt.adoptBotSession(BOT, PICKED, CURRENT), PICKED)
  assert.ok(boundaryReads.length > 0)
  assert.equal(boundaryReads[0], session)
  assert.equal(rt.chatOf(BOT), PICKED)
  assert.equal(rt.selfOf(PICKED), BOT)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots[BOT].sessionId, PICKED)
})

test('#1365 (b): a nonblank non-fork receives bot/adopt-not-blank', async t => {
  const { rt, boundaryReads } = await bench(t, { lastTurn: 1 })
  const before = structuredClone(rt.state)
  await assert.rejects(rt.adoptBotSession(BOT, PICKED, CURRENT), { code: 'bot/adopt-not-blank' })
  assert.ok(boundaryReads.length > 0)
  assert.deepEqual(rt.state, before)
  assert.equal(rt.chatOf(BOT), CURRENT)
})

test('#1365 (c): unavailable agents refuses a non-fork with bot/adopt-not-blank', async t => {
  const { rt, boundaryReads } = await bench(t, { agentsAvailable: false, lastTurn: 1 })
  assert.equal(rt.ctx.get('agents'), undefined)
  const before = structuredClone(rt.state)
  await assert.rejects(rt.adoptBotSession(BOT, PICKED, CURRENT), { code: 'bot/adopt-not-blank' })
  assert.deepEqual(rt.state, before)
  assert.equal(rt.chatOf(BOT), CURRENT)
  assert.deepEqual(boundaryReads, [])
})

test('#1365 (c): unavailable agents still accepts a current-part fork', async t => {
  const { rt, home, boundaryReads } = await bench(t, { agentsAvailable: false, lastTurn: 1, fork: true })
  assert.equal(rt.ctx.get('agents'), undefined)
  assert.equal(await rt.adoptBotSession(BOT, PICKED, CURRENT), PICKED)
  assert.equal(rt.chatOf(BOT), PICKED)
  assert.equal(rt.selfOf(PICKED), BOT)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots[BOT].sessionId, PICKED)
  assert.deepEqual(boundaryReads, [])
})

test('#1366 (d): a fresh-Session task armed only by an unloaded child is paused', async t => {
  const { rt, store, scheduleTasks, edits } = await bench(t)
  const handle = await store.create({ version: 4, id: CHILD, createdAt: 1, isSeeded: false, origin: 'subagent', parentSession: CURRENT })
  await handle.flush()
  await handle.close()
  assert.equal((await store.stat(CHILD)).header.parentSession, CURRENT)
  assert.equal(rt.ctx.sessions.get(CHILD), undefined)
  assert.equal(rt.botOf(CHILD), undefined)
  assert.equal(rt.selfOf(CHILD), undefined)
  assert.equal(rt.agentOf(CHILD), undefined)
  assert.equal(rt.chatOwners.has(CHILD), false)
  assert.equal(rt.groupOwners.has(CHILD), false)
  assert.equal(rt.pastOwners.has(CHILD), false)
  assert.equal(rt.state.tasks[CHILD], undefined)
  const task = { id: 'child-schedule', title: 'Sample task', status: 'active', target: { kind: 'new', create: { cwd: '/tmp' } }, involvedSessionIds: [CHILD] }
  scheduleTasks.set(task.id, task)
  rt.state.bots[BOT].denyTools = ['bash']
  const paused = await rt.revokeNewSchedules(BOT)
  assert.deepEqual(paused, [task.id])
  assert.equal(scheduleTasks.get(task.id).status, 'paused')
  assert.deepEqual(edits, [{ id: task.id, action: 'update', patch: { active: false } }])
})
