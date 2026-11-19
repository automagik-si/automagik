import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter, choose } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Catalog } from '../src/host/catalog.js'

const PROVIDER = 'acp-claude'
const SESSION = 's1'
const ALIAS = 'sonnet'
const AGENT = AGENTS[PROVIDER]
const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const LINE = `[${AGENT.name} does not offer sonnet now, so this reply used its own model. Choose a model again for this Bot.]`
const LOG = "acp-dsh: acp-claude: sonnet is not offered; ran on the agent's own model"
const standIns = AGENT.fallback.filter(entry => entry.id !== 'default').map(entry => entry.id)

function recordingRun(models, { startModel = 'first', levels = ['low', 'high'], afterSwitch = levels } = {}) {
  const calls = []
  const options = new Map([['model', models], ['thought_level', levels]])
  return {
    calls, startModel, options,
    option(category) {
      const values = options.get(category)
      return values === undefined ? undefined : { options: values.map(value => ({ value })) }
    },
    async setOption(category, value) {
      const values = options.get(category)
      if (!values.includes(value)) throw new Error(`it offers no ${category} ${value} (it offers ${values.join(', ')})`)
      calls.push([category, value])
      if (category === 'model') options.set('thought_level', afterSwitch)
    },
  }
}

test('a missing stand-in uses an offered start model and its own effort after the switch', async () => {
  const run = recordingRun(['first', 'later'], { levels: ['high'], afterSwitch: ['low', 'high'] })
  const lookedUp = []
  const substitution = await choose(run, ALIAS, 'high', id => { lookedUp.push(id); return 'low' }, { standIns })
  assert.deepEqual(substitution, { model: ALIAS })
  assert.deepEqual(run.calls, [['model', 'first'], ['thought_level', 'low']])
  assert.deepEqual(lookedUp, ['first'])
})

test('an offered default takes priority and its default effort row is used', async () => {
  const run = recordingRun(['first', 'default'], { afterSwitch: ['default', 'high'] })
  assert.deepEqual(await choose(run, ALIAS, 'high', () => assert.fail('the agent has a default effort row'), { standIns }), { model: ALIAS })
  assert.deepEqual(run.calls, [['model', 'default'], ['thought_level', 'default']])
})

test('with one model and no known own effort there is nothing to switch', async () => {
  const run = recordingRun(undefined)
  assert.deepEqual(await choose(run, ALIAS, 'high', id => { assert.equal(id, 'first') }, { standIns }), { model: ALIAS })
  assert.deepEqual(run.calls, [])
})

test('offered stand-ins keep exact effort validation and the requested model lookup', async () => {
  const run = recordingRun(['first', ALIAS])
  assert.equal(await choose(run, ALIAS, 'high', undefined, { standIns }), undefined)
  assert.deepEqual(run.calls, [['model', ALIAS], ['thought_level', 'high']])
  await assert.rejects(choose(run, ALIAS, 'medium', undefined, { standIns }), { message: 'it offers no thought_level medium (it offers low, high)' })
  await choose(run, ALIAS, undefined, id => { assert.equal(id, ALIAS); return 'low' }, { standIns })
  assert.deepEqual(run.calls.at(-1), ['thought_level', 'low'])
})

test('unknown ids and a missing stand-in after the model list changes keep failing', async () => {
  const run = recordingRun([ALIAS], { startModel: ALIAS })
  await assert.rejects(choose(run, 'gone', undefined, undefined, { standIns }), { message: 'it offers no model gone (it offers sonnet)' })
  run.options.set('model', ['later'])
  await assert.rejects(choose(run, ALIAS, 'high', undefined, { standIns }), { message: 'it offers no model sonnet (it offers later)' })
  assert.deepEqual(run.calls, [])
})

async function host(t, { env = {}, hostStopping } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-stand-in-'))
  const ctx = new Context()
  const logs = []
  ctx.logger.exporter({ export: ({ type, args: [message] }) => {
    if (type === 'info' && typeof message === 'string' && message.startsWith(`acp-dsh: ${PROVIDER}: `)) logs.push(message)
  } })
  const session = Session.create(SESSION, undefined, { version: 4, id: SESSION, createdAt: 0, isSeeded: false, cwd })
  const tools = new Map()
  const agent = { session, ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } }
  ctx.provide('agents', { get: id => id === SESSION ? agent : undefined, list: () => [agent] })
  const spawn = () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_NO_DEFAULT_EFFORT: '1', ...env } })
  const probeLogs = []
  const catalog = new Catalog({ name: AGENT.name, defaultName: AGENT.defaultName, fallback: [{ id: 'default', name: AGENT.defaultName }], key: () => 'fake', spawn, log: line => probeLogs.push(line) })
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, { name: AGENT.name, catalog, spawn, imageInput: true }]]), { hostStopping })
  t.after(async () => {
    adapter.dispose()
    catalog.dispose()
    await ctx.root.fiber.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  catalog.kick()
  await catalog.probing
  catalog.spec.fallback = AGENT.fallback
  assert.ok(catalog.current().some(model => model.id === 'fake-large'), probeLogs.join('\n'))
  assert.equal(await catalog.model(ALIAS), undefined)
  return { ctx, adapter, logs, agent, tools, live: () => adapter.live.get(SESSION) }
}

const said = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const blocksIn = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
const linesIn = chunks => blocksIn(chunks).filter(block => block.type === 'text').map(block => block.text)
const finishOf = chunks => chunks.at(-1)?.reason?.kind

async function step(h, messages, { model = ALIAS, effort = 'high', signal, onChunk } = {}) {
  const chunks = []
  const request = markAgentLoopRequest({ provider: PROVIDER, model, reasoningEffort: effort, sessionId: SESSION, messages, signal })
  for await (const chunk of h.ctx.llm.stream(request)) {
    chunks.push(chunk)
    onChunk?.(chunk)
  }
  return chunks
}

async function answerMirror(h, messages, chunks) {
  const content = blocksIn(chunks)
  const call = content.find(block => block.type === 'tool-call')
  assert.ok(call)
  const tool = h.tools.get(call.name)
  const args = JSON.parse(call.arguments)
  const value = await tool.execute(args, { agent: h.agent, callId: call.id, signal: new AbortController().signal })
  assert.equal(value.status, 'completed')
  messages.push(
    { role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: ALIAS }, content },
    { role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: tool.output.render(args, value) },
  )
}

test('the LLM service accepts a missing stand-in at high and the agent answers on its start model', async t => {
  const h = await host(t)
  const entry = AGENT.fallback.find(item => item.id === ALIAS)
  assert.deepEqual(await h.adapter.resolveModel(PROVIDER, ALIAS), { provider: PROVIDER, ...entry, inputModalities: ['text', 'image'] })
  assert.equal(finishOf(await step(h, [said('plain')], { model: 'fake-small' })), 'stop')
  const chunks = await step(h, [said('plain again')])
  assert.equal(finishOf(chunks), 'stop')
  assert.match(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''), /On fake-large at medium effort/)
  assert.deepEqual(linesIn(chunks).slice(-1), [LINE])
  assert.equal(linesIn(chunks).filter(text => text === LINE).length, 1)
  assert.deepEqual(h.logs, [LOG])
})

test('the substitution survives a mirror continuation, follows the stop line and is consumed once', async t => {
  const h = await host(t, { env: { FAKE_ACP_REVIEW_STOP: 'refusal' } })
  const messages = [said('unasked')]
  const first = await step(h, messages)
  assert.equal(finishOf(first), 'tool-calls')
  assert.equal(linesIn(first).includes(LINE), false)
  assert.deepEqual(h.logs, [])
  await answerMirror(h, messages, first)
  const last = await step(h, messages)
  assert.equal(finishOf(last), 'stop')
  assert.equal(linesIn(last).filter(text => text === LINE).length, 1)
  assert.deepEqual(h.logs, [LOG])
  const refused = await step(h, [said('reviewer denies 0')])
  assert.equal(finishOf(refused), 'stop')
  assert.deepEqual(linesIn(refused), [`[${AGENT.name} declined to go on with this request. Ask again in a new message.]`, LINE])
  const next = await step(h, [said('plain')], { model: 'fake-small' })
  assert.equal(finishOf(next), 'stop')
  assert.equal(linesIn(next).includes(LINE), false)
  assert.deepEqual(h.logs, [LOG, LOG])
})

test('vendor cancellation and a host abort leave no substitution notice for the next prompt', async t => {
  const h = await host(t)
  const cancelled = await step(h, [said('reviewer denies 0')])
  assert.equal(finishOf(cancelled), 'aborted')
  assert.equal(linesIn(cancelled).includes(LINE), false)
  const stopped = new AbortController()
  const aborted = await step(h, [said('hang')], { signal: stopped.signal, onChunk: chunk => {
    if (chunk.type === 'text-delta') stopped.abort()
  } })
  assert.equal(finishOf(aborted), 'aborted')
  assert.equal(linesIn(aborted).includes(LINE), false)
  const exact = await step(h, [said('plain')], { model: 'fake-small' })
  assert.equal(finishOf(exact), 'stop')
  assert.equal(linesIn(exact).includes(LINE), false)
  assert.deepEqual(h.logs, [])
  assert.equal(linesIn(await step(h, [said('plain again')])).filter(text => text === LINE).length, 1)
  assert.deepEqual(h.logs, [LOG])
})

test('a continuation already aborted when its end is queued shows no substitution', async t => {
  const h = await host(t)
  const messages = [said('unasked')]
  const first = await step(h, messages)
  assert.equal(finishOf(first), 'tool-calls')
  await answerMirror(h, messages, first)
  const { run } = h.live()
  await run.prompting
  assert.equal(run.queue.some(event => event.type === 'end'), true)
  const last = await step(h, messages, { signal: AbortSignal.abort() })
  assert.equal(finishOf(last), 'stop')
  assert.equal(linesIn([...first, ...last]).includes(LINE), false)
  assert.deepEqual(h.logs, [])
})

test('an errored prompt or a host interruption does not claim the agent answered', async t => {
  const errored = await host(t, { env: { FAKE_ACP_AUTH: 'prompt' } })
  const failed = await step(errored, [said('plain')])
  assert.equal(finishOf(failed), 'error')
  assert.equal(linesIn(failed).includes(LINE), false)
  assert.deepEqual(errored.logs, [])

  const stopping = await host(t, { hostStopping: () => true })
  const interrupted = await step(stopping, [said('reviewer denies 0')])
  assert.equal(finishOf(interrupted), 'error')
  assert.equal(linesIn(interrupted).includes(LINE), false)
  assert.deepEqual(stopping.logs, [])
})
