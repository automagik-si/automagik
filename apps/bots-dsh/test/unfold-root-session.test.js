// Unfold's own instance (AUTOMAGIK_HOST=unfold) with the three plugins it runs together: the
// Bot team, the Unfold Bot and Unfold's session. The Unfold Bot is made on the session's root
// Session, which works in <DSH_HOME>/unfold-workspace, not in the team workspace. The first
// message the person sends there must reach Unfold's control endpoint once and show in that
// Session: the Bot never moves it to a fresh part, where the session plugin turns every message
// away. A team saved by a version that did move it goes back to the root Session on start.
// The Unfold Bot and Unfold's session live in Unfold's own repository (RFC 0020): here they are
// stand-ins for what each does to the team (fake-unfold-bot.js, and fakeUnfoldSession below).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply as applyTeam } from '../index.js'
import { createUnfold } from './fake-unfold-bot.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

// Unfold's session plugin (@automagik/unfold-session-dsh), as the team meets it: it provides the
// unfoldSession service on the root Session, and its pre-step (prepended) takes every turn of
// that Session: the person's message is shown, sent to Unfold once, and Unfold's reply is shown,
// with no model step (the turn ends on `reject`). Every other root Session's turn is refused.
function fakeUnfoldSession(ctx, { sessionId, reply }) {
  const sent = []
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent } = payload
    if (agent.session?.id !== sessionId && agent.id !== sessionId) {
      return agent.session?.header?.origin === 'subagent' ? next() : { kind: 'reject' }
    }
    for (const message of payload.messages) {
      const s = agent.session
      s.append('step/start', { turn: payload.turn, step: 1 })
      s.append('user/message', message)
      await ctx.sessions.flush?.(s)
      sent.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      s.append('assistant/message', { turn: payload.turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: reply }], source: { provider: 'unfold', model: 'agentd' } }) })
      s.append('step/end', { turn: payload.turn, step: 1 })
    }
    return { kind: 'reject' }
  }, { prepend: true })
  ctx.provide('unfoldSession', { sessionId, ready: Promise.resolve() })
  return { sent }
}

const ROOT = 'unfold-root'
const EMPTY = { version: 1, mainBotIds: [], workspaceId: 'w1', bots: {}, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

// A DSH stand-in for the three plugins. Each Session is a live agent whose turns run every
// agent/pre-step listener in DSH's order (a prepended listener runs before those registered
// earlier) and end at once on `reject`, as the DSH loop does; `enter` would be a model step,
// which is only counted. The session plugin applies first and the team after it, so the
// team's prepended pre-step runs before the session's, the order the bug needs.
async function instance(t, { team = EMPTY, services = {} } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-unfold-root-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const teamFolder = join(home, 'workspace')
  const unfoldFolder = join(dsh, 'unfold-workspace')
  const project = join(root, 'project')
  for (const dir of [teamFolder, unfoldFolder, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const env = { DSH_HOME: process.env.DSH_HOME, AUTOMAGIK_HOST: process.env.AUTOMAGIK_HOST }
  process.env.DSH_HOME = dsh
  process.env.AUTOMAGIK_HOST = 'unfold'

  // DSH's compaction engine: what reaches it, the Bot team lets through.
  const compaction = {
    compactIfNeeded: async () => 'native',
    compactNow: async () => 'native',
    compactRegion: async () => 'native',
  }
  const ctx = fakeContext({ services: { sessionPersistence: { stat: async id => id === ROOT }, compaction, ...services } })
  const steps = {}
  const on = ctx.on
  ctx.on = (name, listener, options) => {
    on(name, listener, options)
    const list = steps[name] ??= []
    if (options?.prepend) list.unshift(listener)
    else list.push(listener)
    return () => {}
  }
  const runStep = (payload, index = 0) => {
    const listener = steps['agent/pre-step']?.[index]
    return listener === undefined ? { kind: 'enter', messages: payload.messages } : listener(payload, () => runStep(payload, index + 1))
  }

  const cwds = new Map([[ROOT, unfoldFolder]])
  const agents = new Map()
  const modelSteps = []
  const agentOf = (id) => {
    if (agents.has(id)) return agents.get(id)
    const events = []
    const nextStep = []
    const nextTurn = []
    let turn = 0
    let busy = false
    let running = Promise.resolve()
    const agent = {
      id,
      events,
      session: {
        id,
        header: { cwd: cwds.get(id) ?? teamFolder },
        get seq() { return events.length },
        append(type, data) {
          const event = { type, data, seq: events.length, time: Date.now() }
          events.push(event)
          return event
        },
        snapshotEvents: () => events,
        requestHeader: () => undefined,
        deriveMessages: () => [],
      },
      get status() { return busy ? 'running' : 'idle' },
      inbox: {
        nextStep,
        nextTurn,
        get hasPending() { return nextStep.length > 0 || nextTurn.length > 0 },
        remove(messageId) {
          for (const list of [nextStep, nextTurn]) {
            const index = list.findIndex(message => message.id === messageId)
            if (index >= 0) return list.splice(index, 1).length > 0
          }
          return false
        },
      },
      send(message, target, wakeup) {
        ;(target === 'next-step' ? nextStep : nextTurn).push(message)
        if (!wakeup || busy) return
        busy = true
        running = (async () => {
          try {
            while (nextStep.length > 0 || nextTurn.length > 0) {
              const messages = [...nextStep.splice(0), ...nextTurn.splice(0, 1)]
              const decision = await runStep({ agent, messages, turn: ++turn, step: 1, signal: AbortSignal.timeout(10_000) })
              if (decision.kind === 'reject') break
              modelSteps.push({ id, messages })
            }
          } finally {
            busy = false
          }
        })()
      },
      followup(message) { agent.send(message, 'next-turn', true) },
      steer(message) { agent.send(message, 'next-step', true) },
      inject(message) { agent.send(message, 'next-step', false) },
      cancel() {},
      whenIdle: () => running,
      async runMaintenance(fn) {
        await running
        return fn(AbortSignal.timeout(10_000))
      },
    }
    agents.set(id, agent)
    return agent
  }

  const registry = new Map([['w1', { id: 'w1', path: teamFolder, title: 'Bots' }]])
  const created = []
  const archived = []
  const unarchived = []
  const disposers = []
  Object.assign(ctx, {
    // Like DSH, a callback waits until every service it names is there.
    // The names come as a list, or as an object's keys (office-skills.js).
    inject: (deps, callback) => { if ((Array.isArray(deps) ? deps : Object.keys(deps)).every(dep => dep in ctx)) callback(ctx) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    agents: { get: id => agents.get(id) },
    events: { dispatch: () => [] },
    serial: async () => {},
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async (path, title) => {
        const workspace = [...registry.values()].find(entry => entry.path === path) ?? { id: `w${registry.size + 1}`, path, title }
        registry.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (id) => { archived.push(id) },
      unarchiveSession: async (id) => { unarchived.push(id) },
    },
    sessionController: {
      create: async (options) => {
        const sessionId = options.sessionId ?? `s${created.length + 1}`
        created.push(sessionId)
        cwds.set(sessionId, options.cwd ?? registry.get(options.workspaceId)?.path)
        return { sessionId }
      },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      // The Session API's prompt, as DSH's composer sends it.
      async prompt({ requestId, sessionId, content }) {
        agentOf(sessionId).followup(createUserMessage({ content, source: { kind: 'user', rpcId: requestId } }))
        return { accepted: true }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  agentOf(ROOT)

  const unfold = fakeUnfoldSession(ctx, { sessionId: ROOT, reply: 'Hi from Unfold.' })

  applyTeam(ctx, { home, browserPlugin: false })
  const rt = ctx.provided.get('omniTeam')
  await createUnfold(ctx, rt).unfoldReady

  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  t.after(async () => {
    for (const agent of agents.values()) await agent.whenIdle().catch(() => {})
    await ctx.dispose()
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { ctx, rt, unfold, agentOf, state, created, archived, unarchived, modelSteps, teamFolder, unfoldFolder, project, compaction, cwds }
}

test('the first message in the Unfold root Session reaches Unfold once and stays in that Session', async (t) => {
  const env = await instance(t)
  const { rt, unfold, agentOf, state, archived, modelSteps } = env
  assert.notEqual(env.teamFolder, env.unfoldFolder)
  const bot = Object.values(state().bots).find(entry => entry.kind === 'unfold')
  assert.equal(bot?.id, ROOT, 'the Unfold Bot is made on the root Session')

  await env.ctx.sessionController.prompt({ requestId: 'composer-1', sessionId: ROOT, mode: 'queue', content: [{ type: 'text', text: 'Hello Unfold' }] })
  const root = agentOf(ROOT)
  await until(() => root.events.some(event => event.type === 'assistant/message') || rt.chatOf(ROOT) !== ROOT)
  await root.whenIdle()
  await settle(50)

  const saved = state().bots[ROOT]
  assert.equal(rt.chatOf(ROOT), ROOT, 'the Bot still speaks in the root Session')
  assert.equal(saved.sessionId ?? saved.id, ROOT)
  assert.equal(saved.segments, undefined, 'no earlier part')
  assert.ok(!archived.includes(ROOT), 'the root Session is not archived')
  assert.deepEqual(env.created, [], 'no fresh Session was made')
  const types = root.events.map(event => event.type)
  for (const type of ['step/start', 'user/message', 'assistant/message']) assert.ok(types.includes(type), `the root journal has ${type}: ${types}`)
  const reply = root.events.find(event => event.type === 'assistant/message')
  assert.equal(reply.data.message.content.map(block => block.text).join(''), 'Hi from Unfold.')
  assert.deepEqual(unfold.sent, ['Hello Unfold'], 'sent to Unfold once')
  assert.deepEqual(modelSteps, [], 'no model step')
  assert.equal(saved.sessionPinned, true, 'an adopted Session is pinned')
})

test('an Unfold Bot an earlier version moved off the root Session goes back to it on start', async (t) => {
  const moved = {
    ...EMPTY,
    mainBotIds: [ROOT],
    bots: {
      [ROOT]: {
        id: ROOT, name: 'Unfold', kind: 'unfold', role: '', instructions: '', createdAt: 1, capabilities: [],
        sessionId: 's9', segments: [{ sessionId: ROOT, endedAt: 2, fallback: 'failed' }],
      },
    },
  }
  const env = await instance(t, { team: moved })
  const saved = env.state().bots[ROOT]
  assert.equal(env.rt.chatOf(ROOT), ROOT)
  assert.equal(saved.sessionId, undefined)
  assert.equal(saved.segments, undefined)
  assert.equal(saved.sessionPinned, true)
  assert.deepEqual(env.unarchived, [ROOT], 'the root Session is back from the archive')
  assert.deepEqual(env.archived, ['s9'], 'the part made by the move is archived')
  assert.deepEqual(env.created, [])

  // From there on the root Session works as for a Bot made today.
  await env.ctx.sessionController.prompt({ requestId: 'composer-2', sessionId: ROOT, mode: 'queue', content: [{ type: 'text', text: 'Still there?' }] })
  const root = env.agentOf(ROOT)
  await until(() => root.events.some(event => event.type === 'assistant/message'))
  await root.whenIdle()
  assert.deepEqual(env.unfold.sent, ['Still there?'])
  assert.equal(env.rt.chatOf(ROOT), ROOT)
})

test('what would move the Unfold root Session is refused with a reason; DSH compaction stays its own', async (t) => {
  const env = await instance(t)
  const { rt, state } = env
  await assert.rejects(rt.startFresh(ROOT), { code: 'bot/refused', message: 'Unfold speaks in the conversation its host runs, so it cannot start a new one here.' })
  await assert.rejects(rt.updateBot(ROOT, { workDir: env.project }), { message: 'Unfold works in the folder its host gave its conversation, so its folder cannot change here' })
  assert.equal(state().bots[ROOT].workDir, undefined)
  // The same folder again, as a whole-profile save sends it, is no change.
  assert.equal((await rt.updateBot(ROOT, { workDir: '', role: 'Unfold, here' })).role, 'Unfold, here')
  await assert.rejects(rt.checkpointBot(ROOT, { sessionId: ROOT }), { code: 'bot/refused', message: 'Unfold speaks in the conversation its host runs; that conversation keeps its own compaction controls.' })
  assert.deepEqual(env.created, [])

  // DSH's own compaction reaches the root Session; a Bot's own conversation still makes room itself.
  const writer = await rt.createBot({ name: 'Writer', pickModel: true })
  await env.ctx.sessionController.prompt({ requestId: 'composer-3', sessionId: ROOT, mode: 'queue', content: [{ type: 'text', text: 'Hi' }] })
  await until(() => env.agentOf(ROOT).events.some(event => event.type === 'assistant/message'))
  await env.agentOf(ROOT).whenIdle()
  assert.equal(await env.compaction.compactNow({ session: { id: ROOT } }), 'native')
  await assert.rejects(env.compaction.compactNow({ session: { id: rt.chatOf(writer.id) } }), /makes room on its own/)
})

test('the Unfold Bot\'s group Session is not pinned: it still moves to a fresh part for its folder', async (t) => {
  const unfold = { id: ROOT, name: 'Unfold', kind: 'unfold', role: '', instructions: '', createdAt: 1, capabilities: [], sessionPinned: true }
  const writer = { id: 'w', name: 'Writer', role: '', instructions: '', createdAt: 2, capabilities: [] }
  const env = await instance(t, {
    team: {
      ...EMPTY,
      mainBotIds: [ROOT],
      bots: { [ROOT]: unfold, w: writer },
      rooms: { r1: { id: 'r1', name: 'Ops', members: [ROOT, 'w'], mode: 'admin', admin: ROOT, named: true, sessions: { [ROOT]: 'gu' } } },
    },
  })
  const { rt } = env
  // The group Session works somewhere other than the team workspace it belongs in.
  env.agentOf('gu').session.header.cwd = env.unfoldFolder
  env.agentOf('gu').followup(createUserMessage({ content: [{ type: 'text', text: 'In the group' }], source: { kind: 'user', rpcId: 'group-1' } }))
  await until(() => rt.roomOf('r1').sessions[ROOT] !== 'gu', { label: 'the group Session moved on' })
  assert.equal(rt.roomOf('r1').segments[ROOT][0].sessionId, 'gu')
  assert.equal(rt.chatOf(ROOT), ROOT, 'the own chat stays')
  assert.deepEqual(env.unarchived, [], 'nothing to put back')
})

test('working_directory in the Unfold root Session is DSH\'s own: no folder approval, no Bot folder', async (t) => {
  const dirs = new Map()
  const workingDirectory = {
    get: session => dirs.get(session.id) ?? session.header.cwd,
    set: async (agent, path) => { dirs.set(agent.session.id, path) },
  }
  const requests = []
  const services = {
    workingDirectory,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async (request) => { requests.push(request); return 'allowed-once' } },
  }
  const env = await instance(t, { services })
  const sub = join(env.project, 'sub')
  mkdirSync(sub)
  // DSH's working_directory, through the team's tools/execute listeners as DSH runs it.
  const agent = env.agentOf(ROOT)
  let ran = false
  const tool = async () => {
    ran = true
    await workingDirectory.set(agent, sub)
    return { isError: false, value: { cwd: sub } }
  }
  const exec = { name: 'working_directory', arguments: { cd: sub }, agent, callId: 'c1', signal: AbortSignal.timeout(10_000) }
  const run = env.ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), tool)
  assert.deepEqual(await run(), { isError: false, value: { cwd: sub } })
  assert.equal(ran, true)
  assert.equal(workingDirectory.get(agent.session), sub)
  assert.deepEqual(requests, [], 'no folder approval was asked for')
  assert.equal(env.state().bots[ROOT].workDir, undefined)
  assert.equal(env.rt.chatOf(ROOT), ROOT)
})
