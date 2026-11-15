// The member wall's tool list, on a real cordis context with DSH's real tool pipeline and file
// tools: a member session may call only the allowlist; every other family is refused before it
// runs, by DSH's final guard; the owner, and every session while members are off, keep their
// tools. A member never reads DSH's launch token (safeguard 3), and never writes outside its
// own area, the owner's profile (where the list lives) included.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as memberTools from '../src/host/member-wall/tools.js'
import { agentFor, allowed, call, layout, world } from './member-wall-world.js'

const TOKEN = 'launch-token-canary 7f3a'

// One stand-in per denied family. A stand-in's body records that it ran; the shell stand-in
// really runs its command, so the owner's run proves the token is there to be read.
const FAMILIES = {
  shell: ['bash', 'terminal_open', 'terminal_send', 'job_list', 'job_output', 'workflow'],
  web: ['web_fetch', 'web_search'],
  mcp: ['mcp__files__read_file'],
  office: ['office_render', 'office_convert'],
  messages: ['send_message', 'list_agents', 'wait_agent', 'team_task_create', 'message_bot', 'post_to_group', 'group_relay'],
  subagents: ['subagent', 'subagent_fork'],
  'Bot team': ['create_bot', 'update_bot', 'remember', 'list_secrets', 'request_secret', 'browser_open', 'save_capability'],
}

function standIns(ctx, ran) {
  for (const name of Object.values(FAMILIES).flat()) {
    ctx.tools.register(defineTool({
      name,
      description: `stand-in ${name}`,
      parameters: { command: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => {
        ran.push(name)
        if (name !== 'bash' || args.command === undefined) return `${name} ran`
        return execFileSync('sh', ['-c', args.command], { encoding: 'utf8' })
      },
    }))
  }
}

function places() {
  const at = layout()
  writeFileSync(join(at.dshHome, 'launch-token'), `${TOKEN}\n`)
  mkdirSync(join(at.dshHome, 'profile'))
  writeFileSync(join(at.dshHome, 'profile', 'cordis.patch.yml'), 'memberTools: [read]\n')
  return at
}

async function wall(t, at, options = {}) {
  const ctx = await world(t, at, { tools: {}, ...options })
  const ran = []
  standIns(ctx, ran)
  return { ctx, ran }
}

const walled = (out, name, label) => {
  assert.equal(out.error, true, `${label}: refused`)
  assert.match(out.text, new RegExp(`${name} is not available in a member's session`), `${label}: by the tool list (${out.text.slice(0, 200)})`)
}

test('a member is refused every denied family, and its body never runs; the owner keeps them', async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx, ran } = await wall(t, at)
  for (const [family, names] of Object.entries(FAMILIES)) {
    for (const name of names) walled(await call(ctx, 'session-ana', at.ana, name, {}), name, `member ${family}: ${name}`)
  }
  assert.deepEqual(ran, [], 'no denied body ran')
  for (const name of Object.values(FAMILIES).flat()) allowed(await call(ctx, 'session-owner', at.owner, name, {}), `owner ${name}`)
  assert.deepEqual(ran, Object.values(FAMILIES).flat())
})

test("a member keeps the allowlist's tools in its own area", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx } = await wall(t, at)
  const ana = (name, args) => call(ctx, 'session-ana', at.ana, name, args)
  allowed(await ana('read', { file_path: join(at.ana, 'notes.txt') }), 'read', /ana canary/)
  allowed(await ana('grep', { pattern: 'canary' }), 'grep', /ana canary/)
  allowed(await ana('glob', { pattern: '*.txt' }), 'glob', /notes\.txt/)
  allowed(await ana('write', { file_path: join(at.ana, 'new.txt'), content: 'ana wrote this\n' }), 'write')
  allowed(await ana('edit', { file_path: join(at.ana, 'new.txt'), old_string: 'wrote', new_string: 'edited' }), 'edit')
  assert.equal(readFileSync(join(at.ana, 'new.txt'), 'utf8'), 'ana edited this\n')
  allowed(await ana('skill', { name: 'ana-notes' }), 'skill', /ana body/)
})

test('an unrecorded session (a fork) is held to the member list', async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx, ran } = await wall(t, at)
  walled(await call(ctx, 'session-fork', at.owner, 'bash', { command: 'true' }), 'bash', 'an unrecorded session')
  walled(await call(ctx, 'session-fork', at.owner, 'web_fetch', {}), 'web_fetch', 'an unrecorded session')
  assert.deepEqual(ran, [])
})

test('with members off, every session keeps every tool', async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx, ran } = await wall(t, at, { members: false })
  for (const name of Object.values(FAMILIES).flat()) allowed(await call(ctx, 'session-ana', at.ana, name, {}), `off: ${name}`)
  assert.equal(ran.length, Object.values(FAMILIES).flat().length)
})

test("DSH's final guard holds even when an earlier policy listener allows the call", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx, ran } = await wall(t, at)
  // Prepended after the wall's own listener, so it runs first and never calls next().
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  walled(await call(ctx, 'session-ana', at.ana, 'bash', { command: 'true' }), 'bash', 'past an allowing listener')
  assert.deepEqual(ran, [])
})

test("safeguard 3: from a member's turn, DSH's launch token cannot be read by read, grep, glob or bash", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx, ran } = await wall(t, at)
  const token = join(at.dshHome, 'launch-token')
  const ana = (name, args) => call(ctx, 'session-ana', at.ana, name, args)
  const none = (out, label) => {
    assert.equal(out.error, true, `${label}: refused`)
    assert.doesNotMatch(out.text, /launch-token-canary/, `${label}: no token`)
  }
  none(await ana('read', { file_path: token }), 'read')
  none(await ana('grep', { pattern: 'canary', path: at.dshHome }), 'grep')
  none(await ana('glob', { pattern: '*', path: at.dshHome }), 'glob')
  none(await ana('bash', { command: `cat ${token}` }), 'bash')
  assert.deepEqual(ran, [])
  // The owner's own shell reads it: the token is there.
  allowed(await call(ctx, 'session-owner', at.owner, 'bash', { command: `cat ${token}` }), 'owner bash', /launch-token-canary/)
})

test("a member's write and edit stay in its own area: not DSH's data, the owner's files, the list or the record", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx } = await wall(t, at)
  const profile = join(at.dshHome, 'profile', 'cordis.patch.yml')
  const before = {
    profile: readFileSync(profile, 'utf8'),
    principals: readFileSync(at.principals, 'utf8'),
    secret: readFileSync(join(at.owner, 'secret.txt'), 'utf8'),
  }
  const ana = (name, args) => call(ctx, 'session-ana', at.ana, name, args)
  const targets = {
    'the data folder': join(at.dshHome, 'launch-token'),
    'the owner profile holding the list': profile,
    'the principal record': at.principals,
    "the owner's file": join(at.owner, 'secret.txt'),
    'through a link out': join(at.ana, 'link.txt'),
    'a new file in the data folder': join(at.dshHome, 'planted.yml'),
  }
  for (const [label, file_path] of Object.entries(targets)) {
    const wrote = await ana('write', { file_path, content: 'memberTools: [bash]\n' })
    assert.equal(wrote.error, true, `write to ${label}: refused (${wrote.text.slice(0, 200)})`)
    const edited = await ana('edit', { file_path, old_string: 'read', new_string: 'bash' })
    assert.equal(edited.error, true, `edit of ${label}: refused (${edited.text.slice(0, 200)})`)
  }
  assert.equal(readFileSync(profile, 'utf8'), before.profile)
  assert.equal(readFileSync(at.principals, 'utf8'), before.principals)
  assert.equal(readFileSync(join(at.owner, 'secret.txt'), 'utf8'), before.secret)
  assert.throws(() => readFileSync(join(at.dshHome, 'planted.yml')), { code: 'ENOENT' })
})

// Drive the wall's step listener directly: the step decision is what is under test.
const step = (ctx, sessionId, provider = 'deepseek') => ctx.waterfall('agent/pre-step', {
  agent: agentFor(sessionId, '/'), messages: [], signal: new AbortController().signal,
  modelSelection: { provider, model: 'm' },
}, async () => ({ kind: 'enter', messages: [] }))

test("a member's step on an ACP route is rejected, so no ACP run starts for it", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  // The skill tool's own step listeners need a whole agent; the step decision is under test.
  const { ctx } = await wall(t, at, { skillTool: false })
  assert.equal((await step(ctx, 'session-ana', 'acp-codex')).kind, 'reject')
  assert.equal((await step(ctx, 'session-ana', 'acp-claude')).kind, 'reject')
  assert.equal((await step(ctx, 'session-fork', 'acp-codex')).kind, 'reject')
  assert.equal((await step(ctx, 'session-ana', 'deepseek')).kind, 'enter')
  assert.equal((await step(ctx, 'session-owner', 'acp-codex')).kind, 'enter')
})

test("fail closed: without DSH's final guard a member gets no turn; the owner is unchanged", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  for (const tools of [undefined, { register: () => () => {} }, { guard: () => () => {}, checkGuards: () => undefined }]) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    // No tools service; one without guards; one whose guards never answer.
    if (tools !== undefined) ctx.provide('tools', tools)
    await ctx.plugin(memberTools, { members: true, principalsFile: at.principals })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal((await step(ctx, 'session-ana')).kind, 'reject', 'member')
    assert.equal((await step(ctx, 'session-fork')).kind, 'reject', 'unrecorded')
    assert.equal((await step(ctx, 'session-owner')).kind, 'enter', 'owner')
  }
})

test('the list is exact names: a near name, a prefix or a new tool is refused', async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx } = await wall(t, at)
  for (const name of ['read_file', 'reader', 'mcp__read', 'readx']) {
    ctx.tools.register(defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'ran',
    }))
    walled(await call(ctx, 'session-ana', at.ana, name, {}), name, name)
  }
  assert.throws(() => memberTools.Config({ memberTools: ['mcp__*'] }))
})

test("a call outside any session (the owner's own interface) keeps its tools", async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx, ran } = await wall(t, at)
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ signal })
  t.after(() => toolSet.dispose?.())
  const batch = await ctx.tools.execute({ calls: [{ id: 'c1', name: 'web_fetch', arguments: {} }], signal, toolSet })
  assert.equal(batch.results[0].result.isError, false, JSON.stringify(batch.results[0].result).slice(0, 200))
  assert.deepEqual(ran, ['web_fetch'])
})

test('the pre-execute policy refuses the same calls, so the list holds if a DSH skipped its guards', async t => {
  const at = places(); t.after(() => rmSync(at.root, { recursive: true, force: true }))
  const { ctx } = await wall(t, at, { skillTool: false })
  const decide = (sessionId, name) => ctx.waterfall('tools/pre-execute', {
    callId: 'c1', name, arguments: {}, agent: agentFor(sessionId, at.ana), signal: new AbortController().signal,
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(await decide('session-ana', 'bash'), { kind: 'deny', reason: "bash is not available in a member's session" })
  assert.deepEqual(await decide('session-fork', 'web_fetch'), { kind: 'deny', reason: "web_fetch is not available in a member's session" })
  assert.deepEqual(await decide('session-ana', 'read'), { kind: 'allow' })
  assert.deepEqual(await decide('session-owner', 'bash'), { kind: 'allow' })
})
