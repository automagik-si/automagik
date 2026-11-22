import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { createRuntime, inject } from '../index.js'
import { install as installFallback } from '../src/host/fallback.js'

const own = { provider: 'openai', model: 'gpt-5.4-mini', reasoningEffort: 'high' }
const fallback = { provider: 'deepseek-official', model: 'deepseek-flash' }
const other = { provider: 'openai', model: 'gpt-5.4' }
const savedModel = `${own.provider}/${own.model}`
const config = { fallbackModel: `${fallback.provider}/${fallback.model}` }
const chatId = 'bot-chat'
const timeout = 10_000

const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const routeOf = ({ provider, model }) => ({ provider, model })

async function realLoop(t, duringFallback) {
  const root = new Context()
  const requests = []
  t.after(() => root.fiber.dispose())
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return {
        provider, id, name: id, context: { contextWindow: 100_000 },
        ...(provider === own.provider && {
          reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: 'low' },
        }),
      }
    }
    async listModels(provider) {
      const id = provider === own.provider ? own.model : fallback.model
      return [await this.resolveModel(provider, id)]
    }
    async *stream(options) {
      requests.push(options)
      if (requests.length === 1) throw new LlmError('fixture usage limit', 'SERVER_ERROR')
      if (requests.length === 2 && options.provider === fallback.provider) await duringFallback()
      yield { type: 'text-delta', index: 0, text: `Reply on ${options.provider}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter([own.provider, fallback.provider], new Adapter())
  await mountAgentLoopTestHarness(root)
  return { root, requests }
}

for (const pick of [undefined, other]) {
  test(pick === undefined ? 'L1: queued input returns to the original model and effort'
    : 'L2: queued input keeps the model picked during fallback', { timeout }, async t => {
    let agent
    const { root, requests } = await realLoop(t, () => {
      if (pick !== undefined) agent.model.select(pick)
      agent.followup(user('Queued during the fallback turn'))
    })
    const warnings = []
    installFallback({
      ctx: root, config, isBotSession: id => id === chatId,
      selfOf: () => 'bot', botOf: () => ({ name: 'Ops', model: savedModel }),
      warn: (...args) => warnings.push(format(...args)),
    })
    agent = await root.agentLoop.create(chatId, own)
    agent.model.select(own)
    agent.followup(user('First request'))
    // The failed turn can become idle just before the fallback wake starts the next one.
    while (requests.length < 3) {
      t.signal.throwIfAborted()
      await agent.whenIdle()
      await new Promise(resolve => setImmediate(resolve))
    }
    await agent.whenIdle()

    assert.deepEqual(requests.map(routeOf), [routeOf(own), fallback, routeOf(pick ?? own)])
    if (pick === undefined) assert.equal(requests[2].reasoningEffort, 'high')
    const answer = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    assert.deepEqual(routeOf(answer.data.message.source), fallback)
    assert.equal(warnings.some(warning => warning.includes('not restored')), false)
  })
}

test('L3: a plugin reload waits for the live fallback turn, then restores its Agent', { timeout }, async t => {
  const fallbackStarted = Promise.withResolvers()
  const finishFallback = Promise.withResolvers()
  const { root, requests } = await realLoop(t, () => {
    fallbackStarted.resolve()
    return finishFallback.promise
  })
  const home = mkdtempSync(join(tmpdir(), 'fallback-reload-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    workspaceId: 'fixture-workspace',
    mainBotIds: ['bot'],
    bots: { bot: {
      id: 'bot', name: 'Ops', role: 'Test Bot', sessionId: chatId, model: savedModel, appliedModel: savedModel,
      effort: own.reasoningEffort, appliedEffort: own.reasoningEffort,
    } },
  }))
  root.provide('connection', { fetch: { register: () => () => {} } })
  root.provide('workspaceRegistry', {
    get: id => id === 'fixture-workspace' ? { id, path: home } : undefined,
    resolveByPath: async path => ({ id: 'fixture-workspace', path }),
  })
  root.provide('sessionController', {
    resolveAgent: async id => ({ agent: root.agents.get(id) }),
    page: async () => ({ records: [], hasMore: false }),
  })
  root.provide('sessionTitle', { rename: async () => {} })
  const load = async () => {
    let rt
    const scope = root.plugin({
      name: 'issue-2025-reload', inject,
      apply(ctx) {
        rt = createRuntime(ctx, { ...config, home, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
        ctx.effect(() => () => rt.dispose())
      },
    })
    await scope
    await rt.load()
    return scope
  }
  // Release a paused adapter before disposing the harness, including on assertion failure.
  t.signal.addEventListener('abort', () => finishFallback.resolve(), { once: true })
  try {
    const first = await load()
    const agent = await root.agentLoop.create(chatId, own, { cwd: home })
    agent.model.select(own)
    agent.followup(user('Start the failover'))
    await fallbackStarted.promise
    assert.equal(agent.status, 'running')
    assert.deepEqual(agent.model.current(), fallback)
    await first.dispose()

    const scanWaiting = Promise.withResolvers()
    const whenIdle = agent.whenIdle.bind(agent)
    t.mock.method(agent, 'whenIdle', () => {
      scanWaiting.resolve()
      return whenIdle()
    })
    const restored = Promise.withResolvers()
    const selections = []
    root.on('session/event', (session, event) => {
      if (session.id !== chatId || event.type !== 'model/selection') return
      selections.push({ status: agent.status, route: event.data })
      restored.resolve()
    })
    const second = await load()
    await scanWaiting.promise
    assert.deepEqual(selections, [])
    finishFallback.resolve()
    await restored.promise
    assert.deepEqual(selections, [{ status: 'idle', route: own }])

    agent.followup(user('After the reload'))
    await agent.whenIdle()
    assert.deepEqual(requests.map(routeOf), [routeOf(own), fallback, routeOf(own)])
    assert.equal(requests[2].reasoningEffort, 'high')
    await second.dispose()
  } finally {
    finishFallback.resolve()
  }
})
