// The per-Bot shell capability, enforced at the host where tools are granted. Every route
// a Bot can reach a shell through is a row here: its own chat, a group Session, a worker
// it starts, a task, a renamed or aliased command tool, and a skill. The capability is
// stored as `shell: false` (absent means a shell), so an existing Bot keeps what it had.
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const flush = async () => { for (let index = 0; index < 16; index += 1) await Promise.resolve() }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const schema = (name, properties, required = []) => ({
  name,
  description: name,
  parameters: { type: 'object', properties, required },
})

// One tool body one definition registers more than once: the definition is the capability,
// not the name on it.
const sharedExecute = async () => 'ran'

// The tools a DSH profile offers a Bot Session. `bash`, `pwsh`, the terminal tools and the
// computer-use tools are what the capability takes away; `read` and `write` stay.
function definitionsOf() {
  return new Map([
    ['bash', { ...schema('bash', { command: { type: 'string' } }, ['command']), execute: sharedExecute }],
    ['pwsh', schema('pwsh', { command: { type: 'string' } }, ['command'])],
    ['terminal_open', schema('terminal_open', { type: { type: 'string' } }, ['type'])],
    ['terminal_send', schema('terminal_send', { sessionId: { type: 'string' }, text: { type: 'string' } }, ['sessionId', 'text'])],
    // A command-taking tool whose name says nothing about a shell: the schema is enough.
    ['housekeeping', schema('housekeeping', { command: { type: 'string' } }, ['command'])],
    ['cua', schema('cua', { method: { type: 'string' }, params: { type: 'object' } }, ['method'])],
    ['cua_driver_native__launch_app', schema('cua_driver_native__launch_app', { app: { type: 'string' } }, ['app'])],
    ['read', schema('read', { file_path: { type: 'string' } }, ['file_path'])],
    ['write', schema('write', { file_path: { type: 'string' } }, ['file_path'])],
    ['edit', schema('edit', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['file_path', 'old_string', 'new_string'])],
    ['grep', schema('grep', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern'])],
    ['glob', schema('glob', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern'])],
    ['read_image', schema('read_image', { file_path: { type: 'string' } }, ['file_path'])],
    ['str_replace_editor', schema('str_replace_editor', { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, ['path'])],
    ['working_directory', schema('working_directory', { cd: { type: 'string' } }, ['cd'])],
    ['session_search', schema('session_search', { query: { type: 'string' } }, ['query'])],
    ['message_bot', schema('message_bot', { to: { type: 'string' }, message: { type: 'string' } }, ['to', 'message'])],
    ['schedule_create', schema('schedule_create', { title: { type: 'string' }, prompt: { type: 'string' } }, ['title', 'prompt'])],
    ['schedule_edit', schema('schedule_edit', { id: { type: 'string' } }, ['id'])],
  ])
}

// Tools registered in a Bot Session's own scope by this plugin or its neighbours. They are
// visible and known, but `tools.restrict` cannot name them: the executor guard is the layer
// that refuses them (tool-deny.js).
const SCOPED = [
  'start_task',
  'save_capability',
  'attach_capability',
  'approve_agent_action',
  'acp_tool',
  'subagent',
  'mcp__toolbox__run',
]

function scopedDefinitionsOf() {
  return new Map([
    ['start_task', schema('start_task', { title: { type: 'string' }, instructions: { type: 'string' } }, ['title', 'instructions'])],
    // `command` is optional in the product's schema; a shell-less Bot must not save an MCP
    // server that starts one, so the property's presence is enough.
    ['save_capability', schema('save_capability', { name: { type: 'string' }, kind: { type: 'string' }, command: { type: 'string' }, args: { type: 'array' } })],
    ['attach_capability', schema('attach_capability', { name: { type: 'string' } }, ['name'])],
    ['approve_agent_action', schema('approve_agent_action', { action: { type: 'string' }, detail: { type: 'string' } }, ['action'])],
    ['acp_tool', schema('acp_tool', { id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' }, input: { type: 'object' } }, ['title', 'kind', 'input'])],
    ['subagent', schema('subagent', { prompt: { type: 'string' }, description: { type: 'string' } }, ['prompt'])],
    // An MCP server mounted before the switch: a command tool under its own prefix.
    ['mcp__toolbox__run', schema('mcp__toolbox__run', { command: { type: 'string' } }, ['command'])],
  ])
}

// Enough of the host for roster and tool-deny: a temporary team home, Sessions that resolve
// to agents whose `ctx.tools.restrict` records each deny set and hands back a lift, and the
// workspace/session services a Bot creation needs.
function bench({ storedTeam } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-shell-capability-'))
  if (storedTeam !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(storedTeam))
  const ctx = fakeContext()
  const restricted = []
  const lifted = []
  const warnings = []
  const agents = new Map()
  const sessions = new Map()
  const definitions = definitionsOf()
  const scopedDefinitions = scopedDefinitionsOf()
  const scoped = new Set(SCOPED)
  // The restrictions in force per agent: each carries the names it hides.
  const inForce = new WeakMap()
  const hiddenNames = (agent) => {
    const hidden = new Set()
    for (const names of inForce.get(agent) ?? []) for (const name of names) hidden.add(name)
    return hidden
  }
  const allDefinitions = () => new Map([...definitions, ...scopedDefinitions])
  const globalNames = () => new Set([...definitions.keys()].filter(name => !scoped.has(name)))
  const knownNames = () => new Set([...allDefinitions().keys()])
  // `schemas()` is the visible surface: a restriction hides what it denies.
  ctx.tools.schemas = (agent) => {
    const hidden = agent === undefined ? new Set() : hiddenNames(agent)
    return [...allDefinitions()].filter(([name]) => !hidden.has(name))
      .map(([name, definition]) => ({ name, parameters: definition.parameters }))
  }
  // `view().visible` is the surface (own-scope tools included); `restrictableNames` is what
  // `restrict()` accepts, and `knownNames` also holds a capability mounted on the agent.
  ctx.tools.view = (agent) => {
    const hidden = agent === undefined ? new Set() : hiddenNames(agent)
    return {
      visible: new Map([...allDefinitions()].filter(([name]) => !hidden.has(name))),
      restrictableNames: globalNames(),
      knownNames: knownNames(),
    }
  }
  ctx.tools.get = (name, agent) => (agent === undefined ? allDefinitions().get(name)
    : hiddenNames(agent).has(name) ? undefined : allDefinitions().get(name))
  let created = 0
  ctx.logger.warn = (...args) => warnings.push(args.map(value => String(value)).join(' '))
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: `w${created}`, path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async options => ({ sessionId: options.sessionId ?? `s${++created}` }),
      resolveAgent: async (sessionId) => {
        if (!agents.has(sessionId)) {
          const live = {
            session: sessions.get(sessionId) ?? { id: sessionId },
            ctx: {
              tools: {
                restrict: (filter) => {
                  restricted.push({ sessionId, deny: [...filter.deny] })
                  const stack = inForce.get(live) ?? []
                  const denied = new Set(filter.deny ?? [])
                  stack.push(denied)
                  inForce.set(live, stack)
                  return () => {
                    const at = stack.indexOf(denied)
                    if (at !== -1) stack.splice(at, 1)
                    lifted.push(sessionId)
                  }
                },
              },
              // Other modules' agent/created listeners (capabilities) mount effects.
              effect: execute => execute(),
            },
          }
          agents.set(sessionId, live)
        }
        return { agent: agents.get(sessionId) }
      },
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { get: sessionId => sessions.get(sessionId), flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const create = (options = {}) => rt.createBot({
    name: `Bot ${++created}`, pickModel: true, instructions: 'Work.',
    ...options,
  })
  const folders = []
  const folder = () => {
    const path = mkdtempSync(join(tmpdir(), 'ds-bot-shell-folder-'))
    folders.push(path)
    return path
  }
  const guard = () => {
    const found = (ctx.listeners.get('tools/execute') ?? [])[0]
    assert.equal(typeof found, 'function', 'tool-deny registers an executor guard')
    return found
  }
  const restrictionFor = sessionId => restricted.filter(entry => entry.sessionId === sessionId).at(-1)
  const stop = async () => {
    // Let every module's cleanup (and the writes it awaits) settle before the temp home goes.
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    for (const path of folders) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  return {
    ctx, rt, home, call, create, folder, guard, restrictionFor, restricted, lifted, warnings,
    agents, sessions, definitions,
    addDefinition: (name, definition) => definitions.set(name, definition),
    addScopedDefinition: (name, definition) => scopedDefinitions.set(name, definition),
    stop,
  }
}

const team = (t, options) => {
  const board = bench(options)
  t.after(board.stop)
  return board
}

const storedBefore = () => ({
  version: 2,
  mainBotIds: [],
  bots: {
    old: { id: 'old', name: 'Old', role: '', instructions: '', createdAt: 1, capabilities: [] },
  },
  privateArchives: [],
  rooms: {},
  agents: {},
  sections: [],
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  requests: {},
  questions: {},
  views: {},
  closedCards: {},
  prefs: {},
  switching: {},
  revision: 1,
})

const refused = async (guard, name, agent, args = {}) => {
  let ran = false
  await assert.rejects(
    () => guard({ name, agent, arguments: args }, async () => { ran = true; return 'ran' }),
    /has no shell|does not have/,
  )
  assert.equal(ran, false, `${name} never reached the tool body`)
}

const allowed = async (guard, name, agent, args = {}) => {
  assert.equal(await guard({ name, agent, arguments: args }, async () => 'ran'), 'ran')
}

test('a new private Bot gets no shell on its own chat', async (t) => {
  const { home: benchHome, create, folder, guard, restrictionFor } = team(t)
  const bot = await create({ private: true, workDir: folder() })
  assert.equal(bot.private, true)
  // The stored capability: a new private-folder Bot starts without a shell.
  assert.equal(bot.shell, false)
  await flush()
  const stored = JSON.parse(readFileSync(join(benchHome, 'state.json'), 'utf8'))
  assert.equal(stored.bots[bot.id].private, true)
  assert.equal(stored.bots[bot.id].shell, false)
  const applied = restrictionFor(bot.id)
  assert.ok(applied !== undefined, 'the capability reached the Bot Session')
  const deny = new Set(applied.deny)
  for (const name of ['bash', 'pwsh', 'terminal_open', 'terminal_send', 'cua', 'cua_driver_native__launch_app', 'housekeeping', 'schedule_create', 'schedule_edit']) {
    assert.ok(deny.has(name), `${name} is not granted`)
  }
  assert.equal(deny.has('read'), false)
  await refused(guard(), 'bash', { id: bot.id }, { command: 'cat ~/.ssh/id_ed25519' })
  await refused(guard(), 'pwsh', { id: bot.id }, { command: 'Get-Content notes.txt' })
  await refused(guard(), 'terminal_send', { id: bot.id }, { sessionId: 't1', text: 'id' })
  await refused(guard(), 'cua', { id: bot.id }, { method: 'launchApp', params: { app: 'Terminal' } })
  await allowed(guard(), 'read', { id: bot.id }, { file_path: '/tmp/notes.txt' })
})

test('a shell-less Bot keeps its file, search and path tools', async (t) => {
  const { create, guard, restrictionFor } = team(t)
  const bot = await create({ shell: false })
  await flush()
  const deny = new Set(restrictionFor(bot.id).deny)
  const kept = [
    ['read', { file_path: '/tmp/a' }],
    ['write', { file_path: '/tmp/a' }],
    ['edit', { file_path: '/tmp/a', old_string: 'a', new_string: 'b' }],
    ['grep', { pattern: 'x' }],
    ['glob', { pattern: '*.md' }],
    ['read_image', { file_path: '/tmp/a.png' }],
    ['str_replace_editor', { path: '/tmp/a', old_str: 'a', new_str: 'b' }],
    ['working_directory', { cd: '/tmp' }],
    ['session_search', { query: 'notes' }],
  ]
  // Only command-taking surfaces disappear; the file, search and path tools stay.
  for (const [name, args] of kept) {
    assert.equal(deny.has(name), false, `${name} stays available`)
    await allowed(guard(), name, { id: bot.id }, args)
  }
})

test('a group Session of a shell-less Bot has no shell', async (t) => {
  const { rt, create, guard, restrictionFor } = team(t)
  const bot = await create({ shell: false })
  rt.state.rooms = {
    r1: {
      id: 'r1', name: 'Group', members: [bot.id], admin: bot.id, mode: 'everyone',
      sessions: { [bot.id]: 'group-run-1' }, seq: 0, log: [],
    },
  }
  await rt.save()
  await rt.applyToolDeny(bot)
  const applied = restrictionFor('group-run-1')
  assert.ok(applied !== undefined, 'the group Session was restricted')
  assert.ok(applied.deny.includes('bash'))
  await refused(guard(), 'bash', { id: 'group-run-1' }, { command: 'id' })
})

test('a worker task of a shell-less Bot has no shell', async (t) => {
  const { rt, create, guard, restrictionFor } = team(t)
  const bot = await create({ shell: false })
  rt.state.tasks = { 'task-run-1': { title: 'work', from: bot.id, status: 'working', at: Date.now() } }
  await rt.save()
  await rt.applyToolDeny(bot, ['task-run-1'])
  const applied = restrictionFor('task-run-1')
  assert.ok(applied !== undefined, 'the task Session was restricted')
  assert.ok(applied.deny.includes('bash'))
  await refused(guard(), 'bash', { id: 'task-run-1' }, { command: 'id' })
})

test('a shell-less Bot cannot reach a shell by delegating to a subagent', async (t) => {
  const { ctx, create, guard, restrictionFor, sessions } = team(t)
  const bot = await create({ shell: false })
  // Delegation itself stays; the child is bound to the parent's fence by its header lineage.
  await allowed(guard(), 'subagent', { id: bot.id }, { prompt: 'inspect the folder' })
  const childId = 'child-run-1'
  sessions.set(childId, Session.create(childId, [], {
    version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(), cwd: '/tmp',
    parentSession: bot.id, origin: 'subagent', isSeeded: false,
  }))
  const { agent } = await ctx.sessionController.resolveAgent(childId)
  ctx.emit('agent/created', { agent })
  await wait(100)
  const applied = restrictionFor(childId)
  assert.ok(applied !== undefined, 'the subagent Session was restricted')
  assert.ok(applied.deny.includes('bash'))
  await refused(guard(), 'bash', { id: childId }, { command: 'id' })
})

test('a shell-less Bot cannot start a worker, an agent CLI or a terminal route', async (t) => {
  const { create, guard } = team(t)
  const bot = await create({ shell: false })
  const exec = guard()
  // A DSH worker: the launch is refused, and a worker Session is restricted too (above).
  await refused(exec, 'start_task', { id: bot.id }, { title: 'work', instructions: 'do it' })
  // A coding CLI over ACP: the mirror's execute and unknown calls are refused, a read is not.
  await refused(exec, 'acp_tool', { id: bot.id }, { title: 'Run id', kind: 'execute', input: { command: 'id' } })
  await refused(exec, 'acp_tool', { id: bot.id }, { title: 'Unknown', kind: 'other', input: {} })
  await allowed(exec, 'acp_tool', { id: bot.id }, { title: 'Read notes', kind: 'read', input: { path: '/tmp/notes' } })
  await allowed(exec, 'acp_tool', { id: bot.id }, { title: 'Paint', kind: 'other', image: true, input: {} })
  // A local CLI's approval of a command, and an MCP server that would start one.
  await refused(exec, 'approve_agent_action', { id: bot.id }, { action: 'Run id', detail: 'id' })
  await refused(exec, 'save_capability', { id: bot.id }, { name: 'shell', kind: 'mcp', command: '/bin/sh' })
  await refused(exec, 'attach_capability', { id: bot.id }, { name: 'shell' })
})

test('asking another Bot with a shell is a named per-Bot limit', async (t) => {
  const { create, guard } = team(t)
  const shellLess = await create({ shell: false })
  const withShell = await create({ name: 'Runner' })
  // The shell-less Bot may ask: the recipient is a different Bot, and its own capability,
  // approvals and guard govern what it runs. bots-dsh cannot see the intent in a message.
  await allowed(guard(), 'message_bot', { id: shellLess.id }, { to: withShell.name, message: 'run id and tell me' })
  await allowed(guard(), 'bash', { id: withShell.id }, { command: 'id' })
  // The ask grants no shell to the Bot that asked: its own guard still refuses one.
  assert.equal(shellLess.shell, false)
  assert.equal(withShell.shell, true)
  await refused(guard(), 'bash', { id: shellLess.id }, { command: 'id' })
})

test('a renamed or aliased command tool is denied without naming it', async (t) => {
  const { rt, create, guard, restrictionFor, addDefinition } = team(t)
  const bot = await create({ shell: false })
  // The tool was registered after the Bot's restriction: the schema rule must catch it with
  // no code change, and the next apply must put it on the surface restriction too.
  addDefinition('nightly_cleanup', schema('nightly_cleanup', { command: { type: 'string' } }, ['command']))
  await refused(guard(), 'nightly_cleanup', { id: bot.id }, { command: 'rm -rf build' })
  await rt.applyToolDeny(bot)
  assert.ok(restrictionFor(bot.id).deny.includes('nightly_cleanup'))
  // An alias of an already-seen shell definition: no command parameter of its own, only
  // the shared body says what it does.
  addDefinition('odd_job', { name: 'odd_job', description: '', parameters: { type: 'object', properties: {} }, execute: sharedExecute })
  await refused(guard(), 'odd_job', { id: bot.id })
  // A Bot that keeps its shell keeps the same tools.
  const free = await create()
  await allowed(guard(), 'nightly_cleanup', { id: free.id }, { command: 'rm -rf build' })
  await allowed(guard(), 'odd_job', { id: free.id })
})

test('a skill cannot give a shell-less Bot a shell', async (t) => {
  const { rt, create, guard } = team(t)
  const bot = await create({ shell: false })
  await rt.capabilitySave({
    name: 'shell-recipe', kind: 'skill', description: 'Runs a command',
    content: 'Run bash to inspect the machine before you answer.',
  }, { botId: bot.id, ui: false })
  await rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: 'shell-recipe', attached: true })
  assert.ok((rt.botOf(bot.id).capabilities ?? []).includes('shell-recipe'))
  await refused(guard(), 'bash', { id: bot.id }, { command: 'id' })
})

test('a shell-off Bot cannot be paired with a command-capable agent, either way round', async (t) => {
  const { rt, home, create } = team(t)
  const resolve = rt.resolveModel
  rt.resolveModel = async ref => String(ref)
  try {
    // The agent set on a shell-less Bot, at creation, at update and on a direct route switch.
    await assert.rejects(() => create({ shell: false, model: 'acp-codex/gpt-6.1-sol' }),
      /has no shell, so it cannot run on acp-codex, whose own tools can run commands/)
    const native = await create({ shell: false })
    await assert.rejects(() => rt.updateBot(native.id, { model: 'acp-codex/gpt-6.1-sol' }),
      /has no shell, so it cannot run on acp-codex/)
    await assert.rejects(() => rt.switchRoute(native.id, 'acp-claude/opus'), /has no shell/)
    // The shell switched off under an agent already set: refused, with the way out, and the
    // record keeps both the shell and the CLI where they were. The route is written on the
    // record directly so the test never starts an agent that is not stubbed.
    const agent = await create()
    agent.model = 'acp-claude/opus'
    agent.appliedModel = 'acp-claude/opus'
    await rt.save()
    await assert.rejects(() => rt.updateBot(agent.id, { shell: false }), (error) => {
      assert.match(error.message, /runs on acp-claude, whose own tools can run commands, so its shell cannot be turned off/)
      assert.match(error.message, /Pick a model that uses DeepSeek Harness's tools first/)
      return true
    })
    assert.equal(agent.shell, true)
    assert.equal(agent.model, 'acp-claude/opus')
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.bots[agent.id].shell, true)
    assert.equal(saved.bots[agent.id].model, 'acp-claude/opus')
    // Clearing the model does not dodge the boundary: the Bot keeps running on what it
    // applied, so that is the model the shell-off decision is tested against.
    for (const model of [null, '']) {
      await assert.rejects(() => rt.updateBot(agent.id, { model, shell: false }),
        /runs on acp-claude, whose own tools can run commands, so its shell cannot be turned off/)
    }
    assert.equal(agent.shell, true)
    assert.equal(agent.model, 'acp-claude/opus')
    // A native model with the shell off, and an agent with the shell on, both still work.
    assert.equal(native.shell, false)
    assert.equal(agent.shell, true)
  } finally {
    rt.resolveModel = resolve
  }
})

test('a shell-off Bot cannot be paired with Remote Hermes', async (t) => {
  const { rt, create, call } = team(t)
  const bot = await create()
  // The pairing boundary refuses even a stored Bot that was put on Hermes before its shell
  // went off (a state the update path now refuses).
  bot.model = 'hermes-remote/default'
  bot.shell = false
  rt.state.prefs = { ...(rt.state.prefs ?? {}), hermesRemote: { enabled: true, profile: 'p', models: [] } }
  await rt.save()
  const refused = await call('hermes-remote-pair', { botId: bot.id })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /has no shell, so it cannot be paired with Remote Hermes/)
  // Turning the model on a shell-less Bot is refused earlier, at the model boundary.
  const other = await create({ shell: false })
  const resolve = rt.resolveModel
  rt.resolveModel = async ref => String(ref)
  try {
    await assert.rejects(() => rt.updateBot(other.id, { model: 'hermes-remote/default' }),
      /has no shell, so it cannot run on hermes-remote/)
  } finally {
    rt.resolveModel = resolve
  }
})

test('an MCP command tool is refused before and after the switch', async (t) => {
  const { create, guard, addScopedDefinition } = team(t)
  const bot = await create({ shell: false })
  // A server mounted before the shell went off: its command tool never reaches the body.
  await refused(guard(), 'mcp__toolbox__run', { id: bot.id }, { command: 'id' })
  // A server mounted after the switch registers a command tool: still refused, fail closed,
  // without another apply or any code that knows the tool's name.
  addScopedDefinition('mcp__late__run', schema('mcp__late__run', { command: { type: 'string' } }, ['command']))
  await refused(guard(), 'mcp__late__run', { id: bot.id }, { command: 'id' })
  // A Bot that keeps its shell can call the same late tool.
  const free = await create()
  await allowed(guard(), 'mcp__late__run', { id: free.id }, { command: 'id' })
})

test('a stored Bot with no field reads shell on', async (t) => {
  const { rt, home, guard } = team(t, { storedTeam: storedBefore() })
  await rt.load()
  const stored = rt.botOf('old')
  assert.equal(stored.shell, undefined)
  await allowed(guard(), 'bash', { id: 'old' }, { command: 'id' })
  // Loading and saving a team written before the capability does not add the field itself.
  await rt.save()
  const untouched = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(untouched.bots.old.shell, undefined)
  // Absent reads as a shell: the capability can be taken away, then stated back, through the
  // same boundary a new Bot uses.
  await rt.updateBot('old', { shell: false })
  await refused(guard(), 'bash', { id: 'old' }, { command: 'id' })
  await rt.updateBot('old', { shell: true })
  assert.equal(rt.botOf('old').shell, true)
  await allowed(guard(), 'bash', { id: 'old' }, { command: 'id' })
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.bots.old.shell, true)
})

test('a new non-private Bot states shell on and is otherwise unchanged', async (t) => {
  const { rt, create, guard } = team(t)
  const bot = await create()
  assert.equal(bot.shell, true)
  await allowed(guard(), 'bash', { id: bot.id }, { command: 'id' })
  const saved = JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8'))
  assert.equal(saved.bots[bot.id].shell, true)
})

test('only the user changes a shell, and a change applies at once', async (t) => {
  const { rt, create, guard, restrictionFor } = team(t)
  const bot = await create()
  await assert.rejects(() => rt.updateBot(bot.id, { shell: false }, bot.id), /Only the user/)
  await assert.rejects(() => rt.updateBot(bot.id, { shell: 'off' }), /shell is true or false/)
  assert.equal(bot.shell, true)
  await rt.updateBot(bot.id, { shell: false })
  assert.equal(bot.shell, false)
  assert.ok(restrictionFor(bot.id).deny.includes('bash'))
  await refused(guard(), 'bash', { id: bot.id }, { command: 'id' })
  await rt.updateBot(bot.id, { shell: true })
  assert.equal(bot.shell, true)
  await allowed(guard(), 'bash', { id: bot.id }, { command: 'id' })
})

test('turning a Bot private never changes its stored shell', async (t) => {
  const { rt, create, guard, folder } = team(t)
  const bot = await create({ workDir: folder() })
  assert.equal(bot.shell, true)
  await rt.updateBot(bot.id, { private: true })
  assert.equal(bot.private, true)
  assert.equal(bot.shell, true)
  await allowed(guard(), 'bash', { id: bot.id }, { command: 'id' })
  // The same Bot made private and then given a shell keeps it when it is opened again.
  await rt.updateBot(bot.id, { shell: false })
  await refused(guard(), 'bash', { id: bot.id }, { command: 'id' })
  await rt.updateBot(bot.id, { private: false })
  assert.equal(bot.shell, false)
  await refused(guard(), 'bash', { id: bot.id }, { command: 'id' })
})

test('a private Bot created with an explicit shell keeps it', async (t) => {
  const { create, guard, folder } = team(t)
  const bot = await create({ private: true, workDir: folder(), shell: true })
  assert.equal(bot.private, true)
  assert.equal(bot.shell, true)
  await allowed(guard(), 'bash', { id: bot.id }, { command: 'id' })
})
