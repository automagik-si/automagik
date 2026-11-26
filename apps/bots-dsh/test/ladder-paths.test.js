import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as readScope from '../src/host/read-scope.js'
import * as scopeFiles from '../src/host/read-scope-files.js'
import * as scopeSearch from '../src/host/read-scope-search.js'
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

// #1295: the owner's per-root-Session folder for read, read_image, glob and grep, through
// the shipped adapters on real DSH tools, the native executor and PTC run_code.
const SCOPED = ['read', 'read_image', 'glob', 'grep']
const scopeArgs = (name, p) => name === 'read' ? { file_path: p.file } : name === 'read_image' ? { file_path: p.image }
  : name === 'glob' ? { pattern: '*.txt', path: p.dir } : { pattern: 'harmless', path: p.dir }
const REFUSED = /read only inside|file-tool folder/
const OUTSIDE = /file tools read only inside/

function scopeFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'read-scope-')))
  const [inside, other, out] = ['in', 'other', 'out'].map(name => join(base, name))
  for (const dir of [inside, other, out]) mkdirSync(dir)
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
  writeFileSync(join(inside, 'note.txt'), 'inside harmless marker\n')
  writeFileSync(join(inside, 'pic.png'), png)
  writeFileSync(join(other, 'note.txt'), 'other harmless marker\n')
  writeFileSync(join(out, 'note.txt'), 'outside harmless marker\n')
  writeFileSync(join(out, 'pic.png'), png)
  symlinkSync(join(out, 'note.txt'), join(inside, 'file-link.txt'))
  symlinkSync(join(out, 'pic.png'), join(inside, 'pic-link.png'))
  symlinkSync(out, join(inside, 'dir-link'))
  symlinkSync(join(out, 'missing.txt'), join(inside, 'dangling.txt'))
  const targets = {
    inside: { file: join(inside, 'note.txt'), image: join(inside, 'pic.png'), dir: inside },
    dotdot: { file: `${inside}/../out/note.txt`, image: `${inside}/../out/pic.png`, dir: `${inside}/../out` },
    absolute: { file: join(out, 'note.txt'), image: join(out, 'pic.png'), dir: out },
    fileLink: { file: join(inside, 'file-link.txt'), image: join(inside, 'pic-link.png'), dir: join(inside, 'file-link.txt') },
    dirLink: { file: join(inside, 'dir-link', 'note.txt'), image: join(inside, 'dir-link', 'pic.png'), dir: join(inside, 'dir-link') },
    dangling: { file: join(inside, 'dangling.txt'), image: join(inside, 'dangling.txt'), dir: join(inside, 'dangling.txt') },
  }
  return { base, inside, other, out, targets }
}

async function scopedHost(t, executor, f) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: ({ session } = {}) => ({ mode: 'danger-full-access', workspaceRoot: f.base, sessionId: session?.id }) })
  ctx.provide('workingDirectory', { ensure: async () => f.base })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) })
  if (executor === 'ptc') { await ctx.plugin(NodePtcRuntime); await ctx.plugin(ptc) } else await ctx.plugin(native)
  // read_image registers only with an attachment store and runs only on an image-capable route.
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  ctx.provide('attachments', {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 20, maxImageDimension: 4096, maxImagePixels: 1 << 24 },
    saveImage: async ({ data, mediaType, name }) => ({ attachmentId: 'fixture', mediaType, bytes: data.length, width: 1, height: 1, name }),
  })
  await ctx.plugin(scopeFiles, { applyPatch: false })
  await ctx.plugin(scopeSearch, { sampleOverCapGlobResults: false })
  const live = new Map()
  ctx.provide('sessions', { get: id => live.get(id) })
  const endpoints = {}
  const stops = []
  let loaded = true
  const rt = { ctx, home: join(f.base, 'state'), load: async () => {}, teamLoaded: () => loaded, state: { tasks: {} },
    own: (records, id) => records?.[id], groupOwners: new Map(), noteStop: (id, stop) => stops.push({ id, ...stop }),
    hooks: { endpoint: (name, handler) => { endpoints[name] = handler; return () => {} } } }
  readScope.install(rt)
  t.after(async () => { await ctx.fiber.dispose() })
  const add = (id, meta) => { const value = session(id, f.base, meta); live.set(id, value); return value }
  let serial = 0
  const call = async (agentSession, name, args) => {
    const agent = { session: agentSession, ctx, options: { provider: 'fixture', model: 'vision' } }
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, signal })
    try {
      const id = `${executor}-${++serial}`
      if (executor === 'native') {
        const result = (await ctx.tools.execute({ calls: [{ id, name, arguments: args }], agent, signal, toolSet })).results[0].result
        return result.isError ? { refused: JSON.stringify(result) } : { value: JSON.stringify(result.value) }
      }
      const code = `try { return { value: JSON.stringify(await tools[${JSON.stringify(name)}](${JSON.stringify(args)})) } }
        catch (error) { return { refused: error.message } }`
      const result = (await ctx.tools.execute({ calls: [{ id, name: 'run_code', arguments: { code, description: 'Read a fixture' } }], agent, signal, toolSet })).results[0].result
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.value.result
    } finally { toolSet.dispose() }
  }
  return { rt, endpoints, stops, add, call, child: (id, parent) => add(id, childSessionMeta({ session: parent, ctx }, 1, false)),
    setLoaded: value => { loaded = value } }
}

test('#1295 a root Session folder confines read, read_image, glob and grep through native and PTC calls', async t => {
  const f = scopeFixture()
  t.after(() => rmSync(f.base, { recursive: true, force: true }))
  for (const executor of ['native', 'ptc']) {
    const h = await scopedHost(t, executor, f)
    const rootA = h.add('root-a')
    const rootB = h.add('root-b')
    const label = text => `${executor}: ${text}`
    if (executor === 'native') {
      // Unset behaves as today; the owner then sets a distinct folder on each root.
      const before = await h.call(rootA, 'read', { file_path: f.targets.absolute.file })
      assert.match(String(before.value), /outside harmless/, label(JSON.stringify(before)))
      assert.deepEqual(await h.endpoints['set-session-read-scope']({ sessionId: 'root-a', folder: f.inside }), { editable: true, folder: f.inside })
      await h.endpoints['set-session-read-scope']({ sessionId: 'root-b', folder: f.other })
    }
    // The PTC host is a fresh install over the same state folder: the setting persisted.
    assert.deepEqual(await h.endpoints['session-read-scope']({ sessionId: 'root-a' }), { editable: true, folder: f.inside }, label('persisted'))
    for (const name of SCOPED) for (const [target, paths] of Object.entries(f.targets)) {
      const result = await h.call(rootA, name, scopeArgs(name, paths))
      if (target === 'inside') {
        assert.equal(result.refused, undefined, label(`${name} inside: ${result.refused}`))
        assert.doesNotMatch(result.value, /outside harmless/, label(`${name} inside`))
      } else {
        assert.match(String(result.refused), OUTSIDE, label(`${name} ${target}: ${JSON.stringify(result)}`))
      }
    }
    // A search rooted at the folder does not return what an inside link reaches outside it.
    const glob = await h.call(rootA, 'glob', { pattern: '**/*', path: f.inside })
    assert.doesNotMatch(String(glob.value), /dir-link[\\/]/, label(`glob through links: ${glob.value}`))
    const grep = await h.call(rootA, 'grep', { pattern: 'harmless', path: f.inside })
    assert.match(String(grep.value), /inside harmless/, label(`grep: ${JSON.stringify(grep)}`))
    assert.doesNotMatch(String(grep.value), /outside harmless/, label(`grep through links: ${grep.value}`))
    // Distinct roots hold distinct folders.
    assert.match(String((await h.call(rootB, 'read', { file_path: join(f.other, 'note.txt') })).value), /other harmless/, label('root-b'))
    assert.match(String((await h.call(rootB, 'read', { file_path: f.targets.inside.file })).refused), OUTSIDE, label('root-b inside A'))
    // A subagent and a task reserved from root A inherit its folder and cannot change it.
    const child = h.child(`child-${executor}`, rootA)
    assert.match(String((await h.call(child, 'grep', { pattern: 'harmless', path: f.out })).refused), OUTSIDE, label('child'))
    assert.match(String((await h.call(child, 'read', { file_path: f.targets.inside.file })).value), /inside harmless/, label('child inside'))
    assert.deepEqual(await h.endpoints['session-read-scope']({ sessionId: child.id }), { editable: false, folder: null })
    await assert.rejects(h.endpoints['set-session-read-scope']({ sessionId: child.id, folder: null }), /root Session/)
    const task = h.add(await h.rt.reserveReadScope('root-a'))
    assert.match(String((await h.call(task, 'read', { file_path: f.targets.absolute.file })).refused), OUTSIDE, label('task'))
    // Failure is a refusal, never unset: a child whose root cannot be resolved, and an unloaded team.
    const orphan = h.child(`orphan-${executor}`, session('gone', f.base))
    assert.match(String((await h.call(orphan, 'read', { file_path: f.targets.inside.file })).refused), REFUSED, label('orphan'))
    h.setLoaded(false)
    assert.match(String((await h.call(rootB, 'read', { file_path: join(f.other, 'note.txt') })).refused), REFUSED, label('unloaded'))
    h.setLoaded(true)
    // A plain Session's refusal is reported to it.
    assert.ok(h.stops.some(stop => stop.id === 'root-a' && stop.why === 'rule'), label(JSON.stringify(h.stops.slice(0, 2))))
  }
  // An unavailable folder refuses everything; clearing restores today's behaviour on the next call.
  const h = await scopedHost(t, 'native', f)
  const rootA = h.add('root-a')
  renameSync(f.inside, `${f.inside}-moved`)
  assert.match(String((await h.call(rootA, 'read', { file_path: join(`${f.inside}-moved`, 'note.txt') })).refused), REFUSED)
  renameSync(`${f.inside}-moved`, f.inside)
  await h.endpoints['set-session-read-scope']({ sessionId: 'root-a', folder: null })
  assert.match(String((await h.call(rootA, 'read', { file_path: f.targets.absolute.file })).value), /outside harmless/)
})
