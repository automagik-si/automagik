import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { install as installHooks } from '../src/host/extend.js'
import { install } from '../src/host/prompt.js'
import { install as installNative } from '../src/host/native-tools.js'
import { install as installToolDeny } from '../src/host/tool-deny.js'
import { fakeContext } from './fake-ctx.js'
import { fixture, serviceStub } from './caller-fixture.js'

const BOTS = [
  ['main', { name: 'Omni' }],
  ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ['keeper', { name: 'Omni', kind: 'omni' }],
]

test('the Orchestrator prompt follows the live task and result flow only while attached', async t => {
  const { ctx, rt, start } = fixture(t, { service: serviceStub({ multiuser: false }) })
  await start()
  const render = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  const before = render('b')
  await rt.attachRole('b', 'orchestrator')
  const block = render('b').match(/<role-prompt id="orchestrator">([\s\S]+?)<\/role-prompt>/)?.[1]
  assert.match(block, /review guard is off, use start_task/)
  assert.match(block, /self-contained instructions/)
  assert.match(block, /exact provider\/model from list_bot_models/)
  assert.match(block, /result comes back as a message when the task's first turn ends/)
  assert.match(block, /Do not wait or poll/)
  await rt.detachRole('b', 'orchestrator')
  assert.equal(render('b'), before)
})

// The prompt section and the hooks other Omni plugins add the Main Bot's rules through.
function start(config = {}, bots = new Map(BOTS)) {
  const ctx = fakeContext()
  const rt = {
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
    config,
  }
  installHooks(rt)
  install(rt)
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, rt, prompt }
}

// Written by the prompt before its Omni parts moved out of prompt.js, which joined them
// into one list. The hooks must give a Main Bot the very same text, byte for byte, or its
// provider's prompt cache starts over. main-prompt-omni.txt is the same Main Bot with an
// Omni named; the channels and canvas plugins check it with their parts added.
test('a Main Bot\'s prompt is the text it was before the Omni parts moved out', (t) => {
  const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
  const plain = start({}, new Map([['main', { name: 'Omni', role: 'Channel orchestrator', instructions: 'Keep it short.' }]]))
  t.after(() => plain.ctx.dispose())
  assert.equal(plain.prompt('main'), fixture('main-prompt.txt'))
})

test('the parts other Omni plugins add go between the Main Bot\'s rules and the team\'s, for Main Bots and the Omni Bot only', (t) => {
  const { ctx, rt, prompt } = start()
  t.after(() => ctx.dispose())
  const before = prompt('main')
  const off = rt.hooks.mainRules(self => `## Part for ${self}`, { order: 100 })
  const main = prompt('main')
  assert.ok(main.includes('\n\n## Part for main\n\n## How your Bot team works'))
  assert.ok(main.indexOf('## You are the Main Bot') < main.indexOf('## Part for main'))
  assert.ok(!prompt('worker').includes('## Part for'))
  // The Omni Bot operates Omni without being a Main Bot: the parts, not the Main Bot's rules.
  const keeper = prompt('keeper')
  assert.ok(keeper.includes('\n\n## Part for keeper\n\n## How your Bot team works'))
  assert.ok(!keeper.includes('## You are the Main Bot'))
  off()
  assert.equal(prompt('main'), before)
})

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('an Agent with a different Session ID keeps its pre-role identity text', t => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const child = { id: 'child-agent', session: { id: 'worker' } }
  const before = prompt(child.id)
  const now = ctx.sections.get('bot-identity').text({ agent: child })
  assert.equal(now, before)
})

// #1564 follow-up (P-a): a fresh scheduled Session whose task belongs to one Bot follows that
// Bot's switch through a name-less identity: native tool and policy getters, with no Bot identity.
test('a fresh scheduled Session of one Bot gets native and policy getters; others get no identity', (t) => {
  let read
  const sessions = new Map()
  const bots = new Map([
    ['worker', { id: 'worker', name: 'Dev', model: 'acp-claude/default', nativeTools: true, nativeToolsAgent: 'acp-claude' }],
    ['closed', { id: 'closed', name: 'Shy', model: 'acp-claude/default', nativeTools: true, nativeToolsAgent: 'acp-claude', shell: false }],
    ['kept', { id: 'kept', name: 'Old', model: 'acp-codex/gpt-5.5', nativeTools: true, nativeToolsAgent: 'acp-codex' }],
  ])
  const owners = { 'fresh-worker': 'worker', 'fresh-ro': 'worker', 'fresh-closed': 'closed', 'fresh-kept': 'kept' }
  const ctx = fakeContext({ services: {
    acpAgents: {
      botIdentity(reader) { read = reader; return () => { read = undefined } },
      nativeModelKept: route => route === 'acp-codex/gpt-5.5',
    },
    sandboxPolicy: { defaultMode: 'workspace-write', resolve: ({ session }) => ({ mode: session.mode }) },
  } })
  ctx.sessions = { get: id => sessions.get(id) }
  t.after(() => ctx.dispose())
  const rt = {
    ctx,
    state: { nativeToolsLocksRetired: true },
    chatOwners: new Map([['chat-worker', 'worker']]), groupOwners: new Map(), pastOwners: new Map(), taskOwners: new Map(),
    selfOf: id => id === 'chat-worker' ? 'worker' : undefined,
    botOf: id => bots.get(id),
    chatOf: id => 'chat-' + id,
    roomOf: () => undefined,
    isMain: () => false,
    scheduledNativeOwner: id => owners[id],
    warn: () => {},
  }
  installHooks(rt)
  installNative(rt)
  installToolDeny(rt)
  install(rt)
  sessions.set('fresh-worker', { mode: 'workspace-write' })
  sessions.set('fresh-ro', { mode: 'read-only' })
  const fresh = read('fresh-worker')
  assert.deepEqual(Object.keys(fresh), [])
  assert.deepEqual(Object.getOwnPropertyNames(fresh).sort(), [
    'confineDeny', 'guardedSolver', 'nativeTools', 'nativeToolsAgent', 'nativeToolsBlocked',
    'planGate', 'solver', 'solverPolicy', 'solverWorkspace',
  ])
  assert.equal(fresh.planGate, false)
  assert.equal(fresh.solver, false)
  assert.equal(fresh.guardedSolver, false)
  assert.equal(fresh.solverPolicy.state, 'none')
  assert.equal(fresh.confineDeny, undefined)
  assert.equal(fresh.solverWorkspace, undefined)
  for (const key of ['name', 'role', 'instructions', 'rolePrompt', 'needsDshTools']) assert.equal(key in fresh, false, key)
  assert.equal(fresh.nativeTools, true)
  assert.equal(fresh.nativeToolsBlocked, false)
  assert.equal(fresh.nativeToolsAgent, 'acp-claude')
  // No identity text: a fresh scheduled Session is not the Bot's chat.
  assert.equal(ctx.sections.get('bot-identity').text({ agent: { id: 'fresh-worker' } }), '')
  assert.equal(read('chat-worker').name, 'Dev')
  assert.equal(read('fresh-unknown'), undefined)
  // Read only, restricted and kept still block the Bot behind it.
  for (const id of ['fresh-ro', 'fresh-closed', 'fresh-kept']) {
    assert.equal(read(id).nativeToolsBlocked, true, id)
    assert.equal(read(id).nativeTools, false, id)
  }
  bots.delete('worker')
  assert.equal(read('fresh-worker'), undefined)
})
