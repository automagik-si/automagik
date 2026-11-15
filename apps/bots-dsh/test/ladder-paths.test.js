import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { childSessionMeta } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../index.js'
import { install } from '../src/host/ladder.js'
import { fakeContext } from './fake-ctx.js'

const allow = { kind: 'allow' }
const cases = [['user_terminal_read', /Only Full access/], ['office_render', /Read only/]]
const argsOf = name => name.endsWith('office_render') ? { input: 'document.xlsx' } : {}
const session = (id, cwd, meta = {}) => Session.create(id, [], {
  version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false, ...meta,
})

test("a Read only Bot's sub-agent is refused the user terminal and Office tools, like the Bot itself", async t => {
  const home = mkdtempSync(join(tmpdir(), 'ladder-paths-'))
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const hooks = []
  const on = ctx.on
  // fakeContext records registration order; Cordis puts prepended listeners first.
  ctx.on = (name, listener, options) => {
    if (name === 'tools/pre-execute') hooks[options === true || options?.prepend ? 'unshift' : 'push'](listener)
    return on(name, listener, options)
  }
  const sessions = new Map()
  const agents = new Map()
  let serial = 0
  Object.assign(ctx, {
    sessions: { get: id => sessions.get(id), list: () => [...sessions.values()], flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'workspace', path }) },
    sessionController: {
      create: async () => {
        const sessionId = `bot-${++serial}`
        sessions.set(sessionId, session(sessionId, home))
        return { sessionId }
      },
      resolveAgent: async id => {
        if (!agents.has(id)) agents.set(id, { session: sessions.get(id), ctx })
        return { agent: agents.get(id) }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
  })
  const requests = []
  const levels = new Map()
  const specs = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const presets = {
    catalog: () => ({ options: Object.keys(specs).map(value => ({ value })), defaultPreset: 'read-only' }),
    current: session => levels.get(session.id) ?? 'read-only',
    resolve: name => { assert.ok(specs[name], name); return specs[name] },
    set: (session, level) => { assert.ok(specs[level], level); levels.set(session.id, level) },
  }
  ctx.provide('permissionPresets', presets)
  ctx.provide('approval', { effectivePolicy: session => specs[presets.current(session)].approval,
    request: async request => { requests.push(request); return 'rejected' } })
  // fakeContext has no sandbox policy. Supply it from the preset knobs, keeping rt.sessionWide real.
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: specs[presets.current(session)].sandbox }) })
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Ada', pickModel: true, instructions: 'Read only.' })
  await rt.setPermission(bot, 'read-only')
  const botSession = sessions.get(bot.id)
  const child = (id, parent, depth) => {
    const value = session(id, home, childSessionMeta({ session: parent, ctx }, depth, false))
    sessions.set(id, value)
    return value
  }
  const first = child('child', botSession, 1)
  const grandchild = child('grandchild', first, 2)
  const stranger = session('not-a-bot', home)
  sessions.set(stranger.id, stranger)
  const outsider = child('outside-child', stranger, 1)
  // Only an allow decision would run the tool body.
  let allowed = 0
  const call = async (session, name) => {
    const exec = { name, arguments: argsOf(name), agent: { session }, callId: `call-${++serial}` }
    const step = i => i === hooks.length ? Promise.resolve(allow) : hooks[i](exec, () => step(i + 1))
    const decision = await step(0)
    if (decision.kind === 'allow') allowed++
    return decision
  }
  assert.equal(rt.sessionWide(first.id, first), false)
  for (const [tool, reason] of cases) for (const name of [tool, `mcp__dsh__${tool}`]) {
    const top = await call(botSession, name)
    assert.equal(top.kind, 'deny', name)
    assert.match(top.reason, reason)
    for (const descendant of [first, grandchild]) {
      const result = await call(descendant, name)
      assert.equal(result.kind, 'deny', `${descendant.id}: ${name}`)
      assert.match(result.reason, reason)
      assert.equal(result.reason, top.reason)
      assert.equal(allowed, 0)
      assert.deepEqual(requests, [])
    }
  }
  for (const [tool] of cases) for (const name of [tool, `mcp__dsh__${tool}`]) {
    assert.deepEqual(await call(outsider, name), allow)
  }
  presets.set(first, 'workspace-write')
  assert.deepEqual(await call(first, 'office_render'), allow)
  presets.set(first, 'danger-full-access')
  assert.equal(rt.sessionWide(first.id, first), true)
  assert.deepEqual(await call(first, 'user_terminal_read'), allow)
  assert.equal(allowed, 6)
  assert.deepEqual(requests, [])
})

function world(ctx) {
  const requests = []
  const bot = { id: 'ada', name: 'Ada' }
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async request => { requests.push(request); return 'rejected' } })
  ctx.provide('permissionPresets', {})
  const rt = { ctx, state: { tasks: {} }, chatOwners: new Map([['ada', 'ada']]), groupOwners: new Map(),
    botOfSession: () => bot, botOf: () => bot, sessionWide: () => false, autoCounts: () => false,
    noteStop() {}, warn: (...args) => assert.fail(String(args)) }
  install(rt)
  return { rt, requests }
}

test('a run_code program from a Read only Bot is refused the user terminal and Office tools', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ladder-ptc-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let mode = 'read-only'
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: ({ session } = {}) => ({ mode, workspaceRoot: home, sessionId: session?.id }) })
  ctx.provide('workingDirectory', { ensure: async () => home })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  // The OS sandbox is not what this test checks, and bwrap may not exist or see the Node
  // binary on a test host: the confinement seam hands the argv back unchanged.
  ctx.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) })
  await ctx.plugin(NodePtcRuntime)
  await ctx.plugin(ptc)
  const w = world(ctx)
  const bodies = { user_terminal_read: 0, office_render: 0 }
  const nested = []
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.parent !== undefined) nested.push(exec.name)
    return next()
  }, { prepend: true })
  for (const [name] of cases) ctx.tools.register(defineTool({ name, description: 'Test sentinel',
    parameters: name === 'office_render' ? { input: { type: 'string', required: true } } : {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies[name]++; return `${name} ran` } }))
  const agent = { session: session('ada', home), ctx }
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal })
  // Cleanups run in registration order: the tool set before the context that owns it.
  t.after(() => toolSet.dispose())
  t.after(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  // PTC returns tool values and throws ToolCallError for a denied nested call.
  const code = `
    const results = {};
    try { results.user_terminal_read = { value: await tools.user_terminal_read({}) }; }
    catch (error) { results.user_terminal_read = { isError: true, message: error.message }; }
    try { results.office_render = { value: await tools.office_render({ input: 'document.xlsx' }) }; }
    catch (error) { results.office_render = { isError: true, message: error.message }; }
    return results;
  `
  const run = async id => {
    const batch = await ctx.tools.execute({ calls: [{ id, name: 'run_code', arguments: { code, description: 'Read a terminal and render a document' } }], agent, signal, toolSet })
    const result = batch.results[0].result
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value.result
  }
  const denied = await run('read-only')
  assert.deepEqual(bodies, { user_terminal_read: 0, office_render: 0 })
  for (const [name, reason] of cases) {
    assert.equal(denied[name].isError, true, name)
    assert.match(denied[name].message, reason)
  }
  assert.deepEqual(nested, cases.map(([name]) => name))
  assert.deepEqual(w.requests, [])
  mode = 'workspace-write'
  w.rt.sessionWide = () => true
  nested.length = 0
  const allowed = await run('workspace-write-full')
  assert.deepEqual(allowed, { user_terminal_read: { value: 'user_terminal_read ran' }, office_render: { value: 'office_render ran' } })
  assert.deepEqual(bodies, { user_terminal_read: 1, office_render: 1 })
  assert.deepEqual(nested, cases.map(([name]) => name))
  assert.deepEqual(w.requests, [])
})
