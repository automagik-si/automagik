import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as Outline from '@deepseek-ai/dsh-session-turn-outline'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import { formatSessionMarkdown, readSessionLogText } from '@deepseek-ai/dsh-session-log-export'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Workspace from '@deepseek-ai/dsh-workspace'
import { createRuntime, inject } from '../index.js'

const main = 'session-fixture-main'
const writer = 'session-fixture-writer'
const editor = 'session-fixture-editor'
const members = [main, writer]
const signal = () => AbortSignal.timeout(10_000)
const turnStart = turn => ({ type: 'turn/start', data: { turn } })
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const control = { provider: 'fixture', model: 'fake' }
const hosts = new Map()

export async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check()
    if (result) return result
    await wait(10)
  }
  assert.fail(message)
}

export async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), '2135-room-'))
  hosts.set(home, [])
  t.after(async () => {
    for (const stop of hosts.get(home).reverse()) await stop()
    hosts.delete(home)
    await rm(home, { recursive: true, force: true })
  })
  const teamDir = join(home, 'team')
  await mkdir(teamDir)
  const bots = Object.fromEntries([[main, 'Chief'], [writer, 'Writer'], [editor, 'Editor']].map(([id, name]) => [id, {
    id, name, createdAt: 1, role: '', instructions: '', shell: false,
    model: 'fixture/fake', appliedModel: 'fixture/fake',
  }]))
  await writeFile(join(teamDir, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [main], bots, rooms: {}, tasks: {}, exchanges: [],
    exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: {},
  }))
  return home
}

export async function mountHost(t, home, { beforeTeam, afterTeam, noSelection = false, failPrepare = false, noSeed = false } = {}) {
  const root = new Context()
  const routes = new Map()
  const prepared = []
  const sent = []
  const streams = []
  const events = []
  const statuses = []
  const errors = []
  const warnings = []
  let rt
  let stopped
  const stop = () => (stopped ??= (async () => {
    rt?.dispose()
    await root.fiber.dispose()
  })())
  t.after(stop)
  hosts.get(home).push(stop)
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  await root.plugin(Jsonl, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Storage)
  await root.plugin(StorageJson, { root: join(home, 'storage') })
  await root.plugin(StorageDomain, { backend: 'json' })
  await root.plugin(Workspace)
  await root.plugin(SessionQuery)
  await root.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 1000 })
  await root.plugin(Outline)
  await root.plugin(Typert)
  let selection = noSelection ? { provider: undefined, model: undefined } : control
  root.provide('agentDefaultModel', { currentSelection: () => selection, saveSelection: async () => {} })
  await root.plugin(Attachments, { dshHome: join(home, 'dsh') })
  root.provide('remoteAccess', { allows: () => true })
  root.provide('typertGateway', { getPendingRemoteEvents: () => [] })
  root.provide('connection', {
    fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
  })
  root.provide('commands', { registerFileReceiptResolver: () => () => {} })
  await root.plugin(FileUploads)
  root.provide('fileReferences', {})
  root.on('session/event', (session, event) => events.push({ sessionId: session.id, event }))
  root.on('agent/status', value => { statuses.push(value) })
  root.on('agent/error', value => { errors.push(value) })
  root.on('llm/stream', (options, next) => { streams.push(options); return next() }, { prepend: true })
  class FakeMember extends LlmAdapter {
    async prepareCall(provider, model, abort) {
      prepared.push({ provider, model })
      if (failPrepare) throw new Error('the opening must never prepare a provider call')
      return super.prepareCall(provider, model, abort)
    }
    async *stream(options) {
      sent.push(options)
      yield { type: 'text-delta', index: 0, text: 'Fixture reply.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['fixture'], new FakeMember())
  const harness = await mountAgentLoopTestHarness(root)
  await root.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 200, maxTitleBytes: 256 })
  await root.plugin(SessionController, { nativeOpen: false })
  const persistence = root.get('sessionPersistence')
  const controller = root.get('sessionController')
  const teamDir = join(home, 'team')
  for (const id of [main, writer, editor]) {
    if (await readSessionLogText(persistence, id) === undefined) await harness.create(id, control, { cwd: teamDir })
  }
  await beforeTeam?.({ root, persistence, controller })
  // All host behavior runs in a real Cordis scope. Its one socket-starting
  // effect is held so the Pocket watch can be driven in-process.
  await root.plugin({ name: 'fixture-bot-team', inject, apply(ctx) {
    const teamCtx = new Proxy(ctx, {
      get(target, key, receiver) {
        if (key === 'effect') return (effect, label) => label === 'ds-bot: pocket chat' ? () => {} : target.effect(effect, label)
        if (key === 'sessionController' && noSeed) return compatibilityController
        return Reflect.get(target, key, receiver)
      },
    })
    const compatibilityController = new Proxy(controller, {
      get(target, key) {
        if (key === 'agents') return undefined
        const field = Reflect.get(target, key)
        return typeof field === 'function' ? field.bind(target) : field
      },
    })
    rt = createRuntime(teamCtx, { home: teamDir, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
    ctx.provide('omniTeam', rt)
    const warn = rt.warn
    rt.warn = (...args) => { warnings.push(args.map(String).join(' ')); warn(...args) }
    afterTeam?.(rt)
  } })
  await rt.load()
  const request = async (endpoint, payload) => {
    const route = routes.get('/omni-ui') ?? routes.get('/api/omni-ui')
    assert.ok(route, 'the Bots endpoint is registered in memory')
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const call = async (endpoint, payload) => {
    const result = await request(endpoint, payload)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const createRoom = (name, extra) => call('create-room', { members, name, ...extra })
  const resolve = async id => {
    const result = await controller.resolveAgent(id)
    assert.ok(!result.error, result.error?.message)
    return result.agent
  }
  const prompt = (id, text, requestId = randomUUID()) => controller.prompt({
    sessionId: id, requestId, mode: 'queue', content: [{ type: 'text', text }],
  }, signal())
  const raw = async id => (await readSessionLogText(persistence, id)).trimEnd().split('\n').map(line => JSON.parse(line)).slice(1)
  const list = async id => (await controller.list({})).items.find(row => row.sessionId === id)
  return {
    root, rt, home, controller, persistence, prepared, sent, streams, events, statuses, errors, warnings,
    stop, request, call, createRoom, resolve, prompt, raw, list,
    selectDefault: () => { selection = control },
  }
}

const boundary = events => events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').map(({ type, data }) => ({ type, data }))
const starts = events => events.filter(event => event.type === 'turn/start').map(({ data }) => data.turn)
const opening = events => events.slice(0, 3).map(({ type, data }) => ({ type, data }))
const exactOpening = [turnStart(1), turnEnd(1), { type: 'session/end-seed', data: {} }]
const pair = (turn = 1) => [turnStart(turn), turnEnd(turn)]

export async function makeColdRoom(t, { tail, members: group = members, setParts } = {}) {
  const home = await makeHome(t)
  const host = await mountHost(t, home)
  const workspaceId = await host.rt.ensureWorkspace()
  const create = async () => (await host.controller.create({ workspaceId })).sessionId
  const id = await create()
  const room = { id, name: 'Legacy room', named: true, members: group, admin: main, mode: 'admin', createdAt: 1 }
  host.rt.state.rooms[id] = room
  const other = await setParts?.(room, create)
  await host.rt.save()
  await host.stop()
  if (tail !== undefined) await editLog(home, id, tail)
  return { home, id, other }
}

async function editLog(home, id, events) {
  const { readdir } = await import('node:fs/promises')
  const logs = await readdir(join(home, 'sessions'), { recursive: true })
  const path = logs.find(name => name.endsWith(`${id}/session.v4.jsonl`))
  assert.ok(path, `no persisted JSONL for ${id}: ${logs}`)
  const filename = join(home, 'sessions', path)
  const header = (await readFile(filename, 'utf8')).split('\n')[0]
  const body = events.map((event, seq) => JSON.stringify({ ...event, seq, time: 1 })).join('\n')
  await writeFile(filename, `${header}\n${body}\n`)
}

export async function settleTurn(host, id) {
  const agent = await host.resolve(id)
  await agent.whenIdle()
  await host.root.sessions.flush(agent.session)
  await waitFor(() => !host.rt.roomActive(id), 'the room round did not finish')
  return agent
}

export async function tornAdmission(t, { checkMarker = true } = {}) {
  const { home, id } = await makeColdRoom(t, { tail: [turnStart(1)] })
  const scanned = []
  const host = await mountHost(t, home, { beforeTeam({ persistence }) {
    const open = persistence.open.bind(persistence)
    t.mock.method(persistence, 'open', async (...args) => {
      const handle = await open(...args)
      if (args[0] === id) {
        const close = handle.close.bind(handle)
        t.mock.method(handle, 'close', (...opts) => { scanned.push(args[1]); return close(...opts) })
      }
      return handle
    })
  } })
  // The controller's cold list is also the base's control when no repair effect exists.
  await host.list(id)
  await wait(30)
  const startupRead = scanned.length > 0
  assert.equal(host.rt.roomOf(id).opened, undefined, 'startup found only the lone start')
  assert.deepEqual(boundary(await host.raw(id)), [turnStart(1)])
  const agent = await host.resolve(id)
  assert.deepEqual(boundary(agent.session.snapshotEvents()), [turnStart(1), turnEnd(1, 'interrupted')])
  if (checkMarker) {
    assert.deepEqual(host.rt.roomOf(id).opened, { part: id, turn: 1 }, 'resume returned before publishing the display marker')
    assert.ok(startupRead, 'the startup pass inspected the torn room before resume')
    assert.deepEqual(JSON.parse(await readFile(host.rt.statePath, 'utf8')).rooms[id].opened, { part: id, turn: 1 })
  }
  return { ...host, id, agent, startupRead }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('T1 creates a durable text-free opening without calling a model, and cold opens post turn 2', async t => {
    const home = await makeHome(t)
    const host = await mountHost(t, home, { noSelection: true, failPrepare: true })
    const room = await host.createRoom('T1 room')
    const raw = await host.raw(room.id)
    assert.deepEqual(opening(raw), exactOpening, 'raw export is missing the text-free opening')
    assert.ok(raw.slice(3).every(event => event.type === 'session/title'), 'only the ordinary rename may follow the three opening events')
    assert.equal(formatSessionMarkdown(raw), formatSessionMarkdown(raw.slice(3)))
    assert.deepEqual(room.opened, { part: room.id, turn: 1 })
    assert.equal((await host.list(room.id)).blank, false)
    assert.deepEqual([host.prepared, host.streams, host.sent, host.statuses, host.errors], [[], [], [], [], []])
    assert.deepEqual(host.events.filter(({ event }) => event.type.startsWith('turn/')), [], 'seed events were published live')
    await host.stop()
    const reopened = await mountHost(t, home)
    await reopened.resolve(room.id)
    await reopened.prompt(room.id, 'cold first post')
    await settleTurn(reopened, room.id)
    assert.deepEqual(starts(await reopened.raw(room.id)), [1, 2])
    await reopened.stop()
    const again = await mountHost(t, home)
    assert.deepEqual(starts((await again.resolve(room.id)).session.snapshotEvents()), [1, 2])
    assert.equal((await again.list(room.id)).blank, false)
  })

  test('T1 opens even when the selected adapter would reject every preparation', async t => {
    const host = await mountHost(t, await makeHome(t), { failPrepare: true })
    const room = await host.createRoom('Selected but unavailable model')
    assert.deepEqual(opening(await host.raw(room.id)), exactOpening)
    assert.equal((await host.list(room.id)).blank, false)
    assert.deepEqual([host.prepared, host.streams, host.statuses, host.errors], [[], [], [], []])
  })

  test('T1b startup scans a lone start, then resume repairs and marks it before the first post', async t => {
    const host = await tornAdmission(t)
    await host.prompt(host.id, 'after the tear')
    await settleTurn(host, host.id)
    assert.deepEqual(starts(await host.raw(host.id)), [1, 2])
    await host.stop()
    const cold = await mountHost(t, host.home)
    assert.deepEqual(starts((await cold.resolve(host.id)).session.snapshotEvents()), [1, 2])
    assert.deepEqual(cold.rt.roomOf(host.id).opened, { part: host.id, turn: 1 })
  })

  test('T1c control rejects a turn-0 pair on cold reopen', async t => {
    const { home, id } = await makeColdRoom(t, { tail: pair(0) })
    const host = await mountHost(t, home)
    const result = await host.controller.resolveAgent(id)
    assert.match(result.error?.message ?? '', /turn|corrupt|invalid/i)
  })

  test('T1c control rejects a pair appended to an already live agent before its first turn', async t => {
    const home = await makeHome(t)
    const host = await mountHost(t, home)
    const id = (await host.controller.create({ cwd: home })).sessionId
    const agent = await host.resolve(id)
    for (const { type, data } of pair()) agent.session.append(type, data)
    await host.prompt(id, 'ordinary first turn on a live counter')
    await agent.whenIdle()
    await host.stop()
    const cold = await mountHost(t, home)
    const result = await cold.controller.resolveAgent(id)
    assert.match(result.error?.message ?? '', /turn|corrupt|invalid/i)
  })

  test('T1d compatibility creates blank rooms and warns once without the seeded API', async t => {
    const home = await makeHome(t)
    const host = await mountHost(t, home, { noSeed: true })
    for (const name of ['First fallback', 'Second fallback']) {
      const room = await host.createRoom(name)
      assert.equal(room.opened, undefined)
      assert.equal((await host.list(room.id)).blank, true)
      assert.deepEqual(boundary(await host.raw(room.id)), [])
    }
    assert.equal(host.warnings.filter(line => line.includes('rooms open blank')).length, 1)
  })

  test('T2 no greeting, greeting, rejected greeting, no admin, and create_group share one opening', async t => {
    const host = await mountHost(t, await makeHome(t))
    const normal = await host.createRoom('Plain room')
    const greet = await host.createRoom('Greeting room', { greet: true })
    await settleTurn(host, greet.id)
    const original = host.rt.greetRoom
    const undo = t.mock.method(host.rt, 'greetRoom', async id => {
      const agent = await host.resolve(id)
      const fail = t.mock.method(agent, 'followup', () => { throw new Error('fixture greet failure') })
      try { return await original(id) } finally { fail.mock.restore() }
    })
    const failed = await host.createRoom('Failed greeting', { greet: true })
    undo.mock.restore()
    const adminless = await host.createRoom('Adminless room', { members: [writer, editor] })
    assert.equal(adminless.admin, null)
    const tool = host.rt.teamTools.find(entry => entry.name === 'create_group')
    assert.match(await tool.execute({ members: ['Writer'], name: 'Tool room' }, { agent: { id: main } }), /^Created group/)
    const tooled = Object.values(host.rt.state.rooms).find(room => room.name === 'Tool room')
    for (const room of [normal, greet, failed, adminless, tooled]) {
      assert.deepEqual(opening(await host.raw(room.id)), exactOpening, room.name)
      assert.deepEqual(room.opened, { part: room.id, turn: 1 })
    }
    assert.deepEqual(starts(await host.raw(greet.id)), [1, 2])
  })

  test('T2/T5 control the explicit greeting already starts a visible turn', async t => {
    const host = await mountHost(t, await makeHome(t))
    const room = await host.createRoom('Greeting control', { greet: true })
    await settleTurn(host, room.id)
    assert.equal((await host.list(room.id)).blank, false)
    assert.equal((await host.raw(room.id)).filter(event => event.type === 'user/message'
      && event.data.source.role === 'kickoff').length, 1)
  })

  test('T3 attachment rejection after seed persistence archives the exact ID, releases it and publishes no room', async t => {
    const host = await mountHost(t, await makeHome(t))
    const workspaceId = await host.rt.ensureWorkspace()
    const workspace = host.root.workspaceRegistry.get(workspaceId)
    let minted
    let beforeAttach
    t.mock.method(workspace, 'attachSession', async id => {
      minted = id
      beforeAttach = await host.raw(id)
      throw new Error('fixture attach refused after persistence')
    })
    await assert.rejects(host.rt.createRoom({ members, name: 'Reject attachment' }), /fixture attach refused/)
    assert.ok(minted)
    assert.ok(host.root.workspaceRegistry.archivedSessionIds.includes(minted), 'the exact minted ID was not archived')
    assert.equal(host.root.agents.get(minted), undefined, 'the creator retained the failed agent')
    assert.equal(host.root.sessions.get(minted), undefined, 'the creator retained the failed Session')
    assert.deepEqual(opening(beforeAttach), exactOpening, 'the seed had not persisted before attachment')
    assert.deepEqual((await host.call('state', {})).rooms, [])
  })

  test('T3 a seed append failure rejects creation and archives the persisted ID', async t => {
    const host = await mountHost(t, await makeHome(t))
    const create = host.persistence.create.bind(host.persistence)
    let minted
    t.mock.method(host.persistence, 'create', async (...args) => {
      const handle = await create(...args)
      minted = args[0].id
      const append = handle.append.bind(handle)
      t.mock.method(handle, 'append', async (events, ...opts) => {
        await append(events, ...opts)
        throw new Error('fixture failure after storing the opening')
      })
      return handle
    })
    const result = await host.request('create-room', { name: 'Failed storage', members })
    assert.equal(result.ok, false, 'creation ignored the seed store failure')
    assert.ok(host.root.workspaceRegistry.archivedSessionIds.includes(minted))
    assert.equal(host.root.agents.get(minted), undefined)
    assert.deepEqual((await host.call('state', {})).rooms, [])
  })

  for (const changed of ['part', 'team']) {
    test(`T3 a ${changed} change during persistence admission prevents a cold write`, async t => {
      const { home, id } = await makeColdRoom(t)
      const entered = Promise.withResolvers()
      const proceed = Promise.withResolvers()
      const closed = Promise.withResolvers()
      const host = await mountHost(t, home, { beforeTeam({ persistence }) {
        const open = persistence.open.bind(persistence)
        t.mock.method(persistence, 'open', async (...args) => {
          const handle = await open(...args)
          if (args[0] !== id || args[1] !== 'write') return handle
          const close = handle.close.bind(handle)
          t.mock.method(handle, 'close', async (...opts) => {
            try { return await close(...opts) } finally { closed.resolve() }
          })
          if (changed === 'part') {
            entered.resolve()
            await proceed.promise
          } else {
            const read = handle.read.bind(handle)
            t.mock.method(handle, 'read', async (...opts) => {
              entered.resolve()
              await proceed.promise
              return read(...opts)
            })
          }
          return handle
        })
      } })
      assert.equal(await Promise.race([entered.promise.then(() => true), wait(500).then(() => false)]), true,
        'cold repair did not request a write lease')
      if (changed === 'part') host.rt.roomOf(id).sessionId = 'session-newer-part'
      else t.mock.method(host.rt, 'sameTeam', () => false)
      proceed.resolve()
      await closed.promise
      assert.deepEqual(boundary(await host.raw(id)), [])
      assert.equal(host.rt.state.rooms[id].opened, undefined)
    })
  }

  test('T3 a failed cold append is retried once on the next startup and survives another reopen', async t => {
    const { home, id } = await makeColdRoom(t)
    const appended = Promise.withResolvers()
    const first = await mountHost(t, home, { beforeTeam({ persistence }) {
      const open = persistence.open.bind(persistence)
      t.mock.method(persistence, 'open', async (...args) => {
        const handle = await open(...args)
        if (args[0] === id && args[1] === 'write') t.mock.method(handle, 'append', async () => {
          appended.resolve(true)
          throw new Error('transient fixture append failure')
        })
        return handle
      })
    } })
    assert.equal(await Promise.race([appended.promise, wait(500).then(() => false)]), true, 'cold append was never attempted')
    assert.deepEqual(boundary(await first.raw(id)), [])
    assert.equal(first.rt.roomOf(id).opened, undefined)
    await first.stop()
    const next = await mountHost(t, home)
    await waitFor(() => next.rt.roomOf(id).opened, 'the next startup did not store the opening')
    assert.deepEqual(boundary(await next.raw(id)), pair())
    await next.stop()
    const cold = await mountHost(t, home)
    assert.deepEqual(boundary((await cold.resolve(id)).session.snapshotEvents()), pair())
  })

  for (const winner of ['startup repair', 'resume']) {
    test(`T3 a cold repair and resolve exclude each other when ${winner} owns the writer`, async t => {
      const { home, id } = await makeColdRoom(t)
      const entered = Promise.withResolvers()
      const proceed = Promise.withResolvers()
      const repairWon = winner === 'startup repair'
      const requestId = randomUUID()
      const post = 'first post while recovery holds the writer'
      const host = await mountHost(t, home, { beforeTeam({ persistence }) {
        const open = persistence.open.bind(persistence)
        let first = true
        t.mock.method(persistence, 'open', async (...args) => {
          if (args[0] !== id || args[1] !== 'write' || !first) return open(...args)
          first = false
          const handle = repairWon ? await open(...args) : undefined
          entered.resolve(true)
          await proceed.promise
          return handle ?? open(...args)
        })
      } })
      const didEnter = await Promise.race([entered.promise, wait(500).then(() => false)])
      assert.equal(didEnter, true, 'the startup repair never tried to claim the room')
      try {
        const result = await host.controller.resolveAgent(id)
        if (repairWon) {
          assert.match(result.error?.code ?? '', /writer-held/)
          await assert.rejects(host.prompt(id, post, requestId), { code: 'session/writer-held' })
        } else assert.ok(result.agent)
      } finally { proceed.resolve() }
      if (repairWon) {
        await waitFor(() => host.rt.roomOf(id).opened, 'the writer did not publish the marker')
        assert.deepEqual(boundary((await host.resolve(id)).session.snapshotEvents()), pair())
        await host.prompt(id, post, requestId)
        await settleTurn(host, id)
        assert.deepEqual(starts(await host.raw(id)), [1, 2])
        assert.equal(host.rt.ledger.range(`group-${id}`, 1, host.rt.roomOf(id).seq).filter(line => line.text === post).length, 1)
      } else {
        // A live blank agent must stay blank until the next startup.
        assert.deepEqual(boundary((await host.resolve(id)).session.snapshotEvents()), [])
        assert.equal(host.rt.roomOf(id).opened, undefined)
        await host.stop()
        const cold = await mountHost(t, home)
        await waitFor(() => cold.rt.roomOf(id).opened, 'the next startup did not repair the cold room')
        assert.deepEqual(boundary(await cold.raw(id)), pair())
      }
    })
  }

  test('T3 control leaves old parts, member Sessions and a queued pre-turn splice untouched', async t => {
    const splice = { type: 'agent/inbox/spliced', data: {
      target: 'next-turn', start: 0,
      inserted: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'waiting' }] })],
    } }
    const { home, id, other } = await makeColdRoom(t, { async setParts(room, create) {
      const current = await create()
      const member = await create()
      room.sessionId = current
      room.parts = [{ sessionId: room.id }]
      room.sessions = { [main]: member }
      return { current, member }
    } })
    await editLog(home, other.current, [splice])
    const host = await mountHost(t, home)
    await host.list(other.current)
    await wait(30)
    assert.deepEqual(boundary(await host.raw(id)), [])
    assert.deepEqual(boundary(await host.raw(other.member)), [])
    assert.deepEqual((await host.raw(other.current)).map(event => event.type), ['agent/inbox/spliced'])
    assert.equal(host.rt.state.rooms[id].opened, undefined)
  })

  test('T3 control makes no repair while a different writer holds the team', async t => {
    const { home, id } = await makeColdRoom(t)
    const reader = await mountHost(t, home, { afterTeam: rt => {
      t.mock.method(rt, 'readOnly', () => 'fixture read-only team')
    } })
    assert.ok(reader.rt.readOnly())
    await reader.list(id)
    await wait(30)
    assert.deepEqual(boundary(await reader.raw(id)), [])
    assert.equal(reader.rt.roomOf(id).opened, undefined)
  })

  test('T4 opening is absent from the relay and provider prompts, room ledger and seen state', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_795_734_000_000 })
    const compare = async noSeed => {
      const host = await mountHost(t, await makeHome(t), { noSeed })
      const relay = []
      const room = await host.createRoom('Parity room')
      const lines = []
      host.rt.roomLineAdded = (_room, line) => { lines.push(line) }
      host.root.on('llm/stream', (options, next) => {
        if (options.sessionId === room.id) relay.push(options)
        return next()
      }, { prepend: true })
      assert.equal((await host.list(room.id)).projections?.values?.sessionListMetadata?.lastPromptAt, null)
      assert.deepEqual([lines.length, host.sent.length, host.prepared.length, relay.length], [0, 0, 0, 0])
      await host.prompt(room.id, 'parity first post')
      await settleTurn(host, room.id)
      await waitFor(() => host.sent.some(entry => host.rt.groupOwners.has(entry.sessionId)), 'the fake member was not called')
      const at = host.rt.roomOf(room.id)
      const records = host.rt.ledger.range(`group-${room.id}`, 1, at.seq)
      const history = await host.rt.roomHistory(at)
      const canonical = value => JSON.stringify(value, (key, field) => {
        if (['id', 'time', 'timestamp', 'rpcId', 'exchangeId', 'callId', 'turn', 'requestId'].includes(key)) return undefined
        return typeof field === 'string' ? field.replaceAll(host.home, '<fixture>')
          .replace(/session-[\da-f-]{36}/g, '<session>').replace(/toolu_relay_[\da-f]{32}/g, '<relay>')
          .replace(/\b\d{13}\b/g, '<time>').replace(/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}/g, '<id>') : field
      })
      const request = options => ({
        provider: options.provider, model: options.model, tools: options.tools?.map(tool => tool.name),
        messages: options.messages.map(({ role, content }) => ({ role, content })),
      })
      return JSON.parse(canonical({
        relay: relay.map(request), member: host.sent.filter(entry => host.rt.groupOwners.has(entry.sessionId)).map(request),
        ledger: records.map(({ who, text, kind, seq }) => ({ who, text, kind, seq })),
        roomLog: at.log,
        rows: host.rt.groupRows(room.id, 1, at.seq),
        history: { ok: history.ok, speakers: [...history.speakers] },
        inbox: host.rt.roomInbox.get(room.id),
        lines: lines.map(({ who, text, kind, seq }) => ({ who, text, kind, seq })),
        seen: at.seen, seq: at.seq, exchangeTurns: host.rt.state.exchangeTurns,
      }))
    }
    const withOpening = await compare(false)
    const withoutOpening = await compare(true)
    for (const [key, actual] of Object.entries(withOpening)) {
      assert.deepEqual(actual, withoutOpening[key], key)
    }
  })
}
