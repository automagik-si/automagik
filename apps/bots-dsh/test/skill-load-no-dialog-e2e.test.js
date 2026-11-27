import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context, symbols } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { Backchannel } from '../../acp-dsh/src/host/backchannel.js'
import { apply } from '../index.js'
import { isTrustedToolRegistration, registerTrustedTool } from '../src/host/tool-registrations.js'
import { CLEAN_REVIEW } from './fixtures/skill-review-model.js'

const botId = 'b-aaaaaaaaaa'
const sessionId = 'fixture-skill-chat'
const callId = 'fixture-load'
const toolName = 'load_skill'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const skill = { name: 'mint-notes', description: 'A short mint fixture note.', content: 'Write a note with marker MINT-BODY-42.' }
const revised = { ...skill, content: 'Write a note with marker MINT-BODY-43.' }
const refusal = { content: [{ type: 'text', text: 'No skill with that name is available to this Bot.' }], isError: true }
const delivery = 'plugin:automagik/skill-delivery'
const activity = 'plugin:automagik/skill-activity'
const outside = 'plugin:acp-dsh/bridge-outside-step'

async function fixture(t, { assigned = true, selfOpened = false, allow = false, level = 'workspace-write', skillOnly = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), '2164-skills-'))
  mkdirSync(join(home, 'pocket'))
  writeFileSync(join(home, 'pocket', 'chat.sock'), '')
  const root = new Context()
  const bridge = new Backchannel({ ctx: root })
  t.after(async () => {
    try { bridge.dispose(); await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const originalFetch = globalThis.fetch
  let loopback
  let foreignFetches = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (new URL(url).origin === loopback) return originalFetch(url, options)
    foreignFetches++
    throw new Error('Unexpected foreign fetch in the Skills fixture')
  })
  t.after(() => assert.equal(foreignFetches, 0))

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [botId],
    bots: { [botId]: { id: botId, sessionId, name: 'Fixture Bot', createdAt: 1, role: 'Helper',
      model: `${route.provider}/${route.model}`, appliedModel: `${route.provider}/${route.model}` } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} },
    prefs: { backgroundModel: `${route.provider}/${route.model}` },
  }))
  class ReviewModel extends LlmAdapter {
    async listModels(provider) {
      return [await this.resolveModel(provider, route.model)]
    }

    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }
    async *stream({ tools, system }) {
      assert.equal(tools.length, 0)
      assert.ok(system?.startsWith('Review the supplied skill'))
      yield { type: 'text-delta', index: 0, text: CLEAN_REVIEW }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.llm.registerAdapter([route.provider], new ReviewModel())
  const harness = await mountAgentLoopTestHarness(root)
  const requests = []
  const controls = { beforeDispatch: async () => {}, duringBody: async () => {} }
  root.provide('approval', {
    effectivePolicy: () => level === 'full' ? 'never' : 'ask',
    async request(request) { requests.push(request); return allow ? 'allowed-once' : 'rejected' },
  })
  root.provide('permissionPresets', { current: () => level })
  root.provide('sandboxPolicy', { resolve: () => ({ mode: level === 'full' ? 'danger-full-access' : 'workspace-write' }) })
  const routes = new Map()
  root.provide('connection', { fetch: { register: route => {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'fixture-workspace', path }) })
  root.provide('sessionTitle', { rename: async () => {} })
  apply(root, { home, github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  const rt = root.get('omniTeam')
  const owner = async (endpoint, payload) => {
    const response = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    assert.equal(response.status, 200, endpoint)
    const result = await response.json()
    assert.equal(result.ok, true, endpoint)
    return result.value
  }
  assert.deepEqual(await owner('skill-library-save', skill), { saved: true })
  const assignment = { id: botId, name: skill.name }
  if (assigned) {
    assert.deepEqual(await owner('bot-skill-add', assignment), { saved: true })
    assert.deepEqual(await owner('bot-skill-mode', { ...assignment, mode: 'automatic' }), { saved: true })
  }

  const tools = root.tools[symbols.original] ?? root.tools
  const registry = Object.getPrototypeOf(tools)
  const register = registry.register
  let disposeSkill
  t.mock.method(registry, 'register', function (definition, ...options) {
    const dispose = register.call(this, definition, ...options)
    if (definition.name === toolName && scopeOf(this.ctx)?.session?.id === sessionId) disposeSkill = dispose
    return dispose
  })
  const agent = await harness.create(sessionId, route, { cwd: home })
  const session = agent.session
  const registration = () => tools.view(agent).registrations.get(toolName)
  const shipped = registration()?.definition
  assert.ok(isTrustedToolRegistration(registration()))
  assert.equal(typeof disposeSkill, 'function')
  const count = { wrapper: 0, rejected: 0, shipped: 0, alternate: 0 }
  const execute = shipped.execute
  t.mock.method(shipped, 'execute', async function (args, exec) {
    count.shipped++
    const result = await execute.call(this, args, exec)
    await controls.duringBody()
    return result
  })
  const alternate = { ...shipped, execute: () => {
    count.alternate++
    return { type: 'text', text: 'ALTERNATE-FIXTURE' }
  } }
  const replace = (definition, trusted = false) => {
    const before = registration()
    disposeSkill()
    if (trusted) registerTrustedTool(agent.ctx.tools, definition)
    else agent.ctx.tools.register(definition)
    assert.notEqual(registration(), before)
    assert.equal(registration().definition, definition)
    assert.equal(isTrustedToolRegistration(registration()), trusted)
  }
  agent.ctx.tools.register({ ...alternate, name: 'fixture_note' })
  root.on('tools/execute', async (exec, next) => {
    if (exec.callId !== callId) return next()
    assert.equal(exec.agent, agent)
    await controls.beforeDispatch()
    if (exec.toolSet !== undefined) {
      const view = exec.toolSet.view
      exec.toolSet.view = scope => {
        const defs = view(scope)
        const wrapped = defs.get(toolName)
        if (wrapped === undefined) return defs
        return new Map([[toolName, { ...wrapped, execute(args, execution) {
          count.wrapper++
          assert.equal(execution.callId, callId)
          assert.equal(execution.name, toolName)
          assert.equal(execution.agent, agent)
          try { return wrapped.execute(args, execution) }
          catch (error) { count.rejected++; throw error }
        } }]])
      }
    }
    return next()
  }, { prepend: true })

  if (!selfOpened) {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    if (level === 'auto') {
      session.append('request/header', {
        header: { config: route, tools: [shipped].map(({ name, description, parameters }) => ({ name, description, parameters })) },
        reason: 'initial',
      })
      root.on('tools/pre-execute', (exec, next) => exec.callId === callId
        ? { kind: 'ask', reason: 'Fixture Auto reviewer escalated' } : next())
    }
  }
  await bridge.listen()
  const name = selfOpened ? 'Claude Code' : skillOnly ? 'omp' : 'Codex'
  const record = bridge.mint({ sessionId, agent, name, skillOnly })
  const url = bridge.urlFor(record)
  loopback = new URL(url).origin
  const post = async (op, fields) => {
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${record.credential}`, 'x-dsh-bridge-attachment': 'a'.repeat(32) },
      body: JSON.stringify({ op, ...fields }),
    })
    assert.equal(response.status, 200)
    const value = await response.json()
    await setImmediate()
    return value
  }
  await post('hello')
  const rows = type => session.snapshotEvents().filter(event => event.type === type)
  const saved = () => rows('tool/result').find(row => row.data.message.toolCallId === callId)?.data.message
  const call = (args = { name: skill.name }, name = toolName) => post('call', { name, arguments: args, callId })
  const isCandidate = typeof rt.skillCalls.reviewed === 'function'
  const trace = label => t.diagnostic(`${label}: approval=${requests.length} wrapper=${count.wrapper} rejected=${count.rejected} shipped=${count.shipped} alternate=${count.alternate} receipts=${rows(delivery).length} activity=${rows(activity).length}`)
  return { rt, owner, home, agent, session, requests, controls, count, shipped, alternate, replace, rows, saved, call, isCandidate, trace }
}

function noDelivery(f) {
  assert.equal(f.rows(delivery).length, 0)
  assert.equal(f.rows(activity).length, 0)
  assert.equal(f.count.alternate, 0)
}

function refused(f, answer, { selfOpened = false } = {}) {
  assert.deepEqual(answer, refusal)
  noDelivery(f)
  if (selfOpened) {
    assert.equal(f.rows(outside).find(row => row.data.callId === callId)?.data.outcome, 'refused')
    assert.equal(f.saved(), undefined)
  } else {
    assert.deepEqual(f.saved()?.content, [])
    assert.equal(f.saved()?.isError, true)
  }
}

test('#2164 E1 real mount delivers the exact reviewed body and correlates settlement to wire finish', async t => {
  const f = await fixture(t)
  const answer = await f.call()
  f.trace('E1')
  assert.equal(f.requests.length, 0, 'the bridge skipped its own request')
  assert.equal(f.count.shipped, 1)
  assert.equal(f.count.wrapper, 1)
  assert.equal(f.count.rejected, 0)
  assert.equal(f.rows('approval/asked').length, 0)
  const call = f.rows('tool/call').find(row => row.data.callId === callId)
  assert.equal(call?.data.name, toolName)
  const message = f.saved()
  const [part] = message.content
  const ref = part.automagikSkill
  assert.equal(ref.use, 'load')
  assert.equal(ref.botId, botId)
  assert.equal(ref.name, skill.name)
  assert.equal(ref.hash, f.rt.skillLibrary.active(botId)[0].review.hash)
  assert.equal(part.text, skill.content)
  const digest = createHash('sha256').update(JSON.stringify([message.id, ref.botId, ref.name, ref.hash, ref.use, part.text])).digest('hex')
  const receipt = f.rows(delivery).find(row => row.data.includes(digest))
  assert.ok(receipt, 'receipt derives from the saved result message')
  assert.deepEqual(answer, { content: [{ type: 'text', text: part.text }], isError: false })
  const [credited] = f.rows(activity)
  assert.deepEqual(JSON.parse(credited.data.id), ['bridge', call.data.turn, call.data.step, callId])
  assert.equal(credited.data.name, skill.name)
  assert.ok(credited.seq > receipt.seq)
  assert.equal(f.rows(activity).length, 1)
})

test('#2164 E2 an unassigned reviewed skill stays unavailable', async t => {
  const f = await fixture(t, { assigned: false })
  assert.deepEqual(await f.call(), refusal)
  assert.equal(f.requests.length, 0)
  assert.equal(f.count.shipped, 0)
  noDelivery(f)
})

for (const [label, hold, edit] of [
  ['E3', /has not reviewed/, record => { delete record.review; delete record.reviewSeal }],
  ['E4', /missing or changed/, record => { record.content = revised.content }],
]) {
  test(`#2164 ${label} a held Automatic assignment stays unavailable`, async t => {
    const f = await fixture(t)
    assert.equal(f.rt.skillLibrary.active(botId)[0].review.status, 'done')
    const path = join(f.home, 'skill-library', 'library.json')
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    edit(stored.skills[skill.name])
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 })
    assert.match((await f.owner('skill-library-get', { name: skill.name })).held, hold)
    assert.deepEqual(f.rt.skillLibrary.active(botId), [])
    assert.deepEqual(await f.call(), refusal)
    assert.equal(f.requests.length, 0)
    assert.equal(f.count.shipped, 0)
    noDelivery(f)
  })
}

for (const [label, name, args] of [
  ['E5', 'fixture_note', { name: skill.name }],
  ['E6', toolName, { name: skill.name, extra: 1 }],
  ['E8', toolName, { name: skill.name }],
]) {
  test(`#2164 ${label} a non-qualifying call keeps its bridge approval`, async t => {
    const f = await fixture(t)
    if (label === 'E8') f.replace(f.alternate)
    assert.equal((await f.call(args, name)).isError, true)
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].toolName, name)
    assert.equal(f.count.shipped, 0)
    assert.equal(f.count.wrapper, 0)
    noDelivery(f)
  })
}

test('#2164 E7 a new reviewed hash before dispatch refuses the original call', async t => {
  const f = await fixture(t, { allow: true })
  const original = f.rt.skillLibrary.active(botId)[0]
  f.controls.beforeDispatch = async () => {
    assert.deepEqual(await f.owner('skill-library-save', { ...revised, edit: true }), { saved: true })
    await f.rt.skillLibrary.settled()
    const [current] = f.rt.skillLibrary.active(botId)
    assert.notEqual(current.hash, original.hash)
    assert.equal(current.review.hash, current.hash)
    assert.equal(original.review.hash, original.hash)
    t.diagnostic(`old_hash=${original.hash} new_hash=${current.hash}`)
  }
  const answer = await f.call()
  f.trace('E7')
  refused(f, answer)
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.count, { wrapper: 1, rejected: 1, shipped: 0, alternate: 0 })
})

for (const selfOpened of [false, true]) {
  const path = selfOpened ? 'self-opened' : 'in-step'
  for (const [label, replace] of [
    ['E9', f => f.replace(f.alternate)],
    ['note 1 Session', f => { f.agent.session = Session.create(f.session.id) }],
  ]) {
    test(`#2164 ${label} ${path} substitution before dispatch runs neither body`, async t => {
      const f = await fixture(t, { selfOpened })
      let replaced = 0
      f.controls.beforeDispatch = () => { replace(f); replaced++ }
      const answer = await f.call()
      f.trace(`${label} ${path} swap=${replaced}`)
      assert.equal(answer.isError, true)
      assert.equal(replaced, f.isCandidate ? 1 : 0)
      assert.equal(f.requests.length, f.isCandidate ? 0 : 1)
      assert.deepEqual(f.count, { wrapper: replaced, rejected: replaced, shipped: 0, alternate: 0 })
      noDelivery(f)
      if (f.isCandidate) refused(f, answer, { selfOpened })
    })
  }
  test(`#2164 note 1 registration ${path} trusted re-registration during execution withholds the result`, async t => {
    const f = await fixture(t, { selfOpened, allow: true })
    let replaced = 0
    f.controls.duringBody = () => { f.replace(f.shipped, true); replaced++ }
    const answer = await f.call()
    f.trace(`note 1 registration ${path} swap=${replaced}`)
    assert.equal(replaced, 1)
    assert.equal(f.count.shipped, 1)
    refused(f, answer, { selfOpened })
    assert.equal(f.requests.length, 0)
    assert.deepEqual(f.count, { wrapper: 1, rejected: 0, shipped: 1, alternate: 0 })
  })
}

test('#2164 native Auto escalation still reaches approval through the real dispatcher', async t => {
  const f = await fixture(t, { level: 'auto' })
  const response = await f.call()
  f.trace('Auto escalation')
  assert.equal(response.isError, true)
  assert.deepEqual(f.requests.map(request => [request.callId, request.reason, request.bridgeCall]),
    [[callId, 'Fixture Auto reviewer escalated', undefined]])
  assert.deepEqual(f.count, { wrapper: 0, rejected: 0, shipped: 0, alternate: 0 })
  noDelivery(f)
})

for (const [path, options] of [
  ['Claude Code self-opened', { selfOpened: true }],
  ['omp skill-only', { skillOnly: true }],
]) {
  test(`#2164 ${path} asking-level load delivers without a bridge request`, async t => {
    const f = await fixture(t, options)
    const answer = await f.call()
    f.trace(path)
    assert.equal(f.requests.length, 0)
    assert.equal(f.count.shipped, 1)
    assert.deepEqual(answer, { content: [{ type: 'text', text: skill.content }], isError: false })
    if (options.selfOpened) {
      const [outcome] = f.rows(outside)
      assert.equal(outcome.data.callId, callId)
      assert.equal(outcome.data.outcome, 'ran')
      const [credited] = f.rows(activity)
      assert.deepEqual(JSON.parse(credited.data.id), ['bridge-outside-step', callId])
      assert.equal(credited.data.eventSeq, outcome.seq)
      assert.equal(f.rows(delivery).length, 0)
    }
  })
}
