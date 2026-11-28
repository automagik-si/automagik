import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { DENY_MAX, DENY_NAME_MAX, cleanDenyTools } from '../src/host/tool-deny.js'
import { fakeContext } from './fake-ctx.js'

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const SERVED = ['bash', 'read', 'write', 'edit', 'omni_send', 'omni_messages', 'omni_chats']

// Enough of the host for the roster and the tool-deny module: Sessions resolve to an agent
// whose `ctx.tools.restrict` records the deny list and hands back a lift.
function bench({ served = SERVED, scoped = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tool-deny-'))
  const ctx = fakeContext()
  const restricted = []
  const lifted = []
  const warnings = []
  const agents = new Map()
  // The Session store: a child Session's real header names its parent and subagent origin.
  const sessions = new Map()
  // DSH's restrictions intersect, and the disposer lifts exactly the one that set it.
  const inForce = new Map()
  const hiddenNames = (agent) => {
    const hidden = new Set()
    for (const filter of inForce.get(agent) ?? []) for (const name of filter) hidden.add(name)
    return hidden
  }
  let created = 0
  ctx.logger.warn = (...args) => warnings.push(args.map(value => String(value)).join(' '))
  // `schemas()` is the visible surface: a restriction hides what it denies.
  ctx.tools.schemas = agent => (agent === undefined ? served : served.filter(name => !hiddenNames(agent).has(name)))
    .map(name => ({ name }))
  // `view().restrictableNames` is what `restrict()` accepts: the surface before restrictions.
  // A capability mounted on the agent's own scope is known but not restrictable.
  ctx.tools.view = () => ({ restrictableNames: new Set(served), knownNames: new Set([...served, ...scoped]) })
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
        // ds-bot's own resolveAgent unwraps `{ agent }`, as DSH's controller answers.
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
  // The browser's own path to a change: the POST route, no acting Bot.
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = () => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, stop, restricted, lifted, warnings, agents, sessions, call }
}

const team = (t, options) => {
  const board = bench(options)
  t.after(board.stop)
  return board
}

test('cleanDenyTools trims, deduplicates and drops empty names', () => {
  assert.deepEqual(cleanDenyTools([' bash ', 'bash', '', 'omni_send']), ['bash', 'omni_send'])
  assert.equal(cleanDenyTools([]), null)
  assert.equal(cleanDenyTools(null), null)
  assert.equal(cleanDenyTools(undefined), undefined)
  assert.throws(() => cleanDenyTools('bash'), /list of tool names/)
  assert.throws(() => cleanDenyTools(['bash', 7]), /is a tool name/)
  assert.throws(() => cleanDenyTools(Array.from({ length: DENY_MAX + 1 }, (_, index) => `t${index}`)), /at most/)
  assert.throws(() => cleanDenyTools(['x'.repeat(DENY_NAME_MAX + 1)]), /at most/)
})

test('a Bot created with a deny list keeps it, and the list is enforced on its Session', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['omni_send', 'bash'], pickModel: true, instructions: 'Read only.' })
  assert.deepEqual(bot.denyTools, ['omni_send', 'bash'])
  await flush()
  const applied = restricted.filter(entry => entry.sessionId === bot.id)
  assert.ok(applied.length > 0, 'the deny list reached the Session')
  assert.deepEqual(applied.at(-1).deny.sort(), ['bash', 'omni_send'])
})

test('a create that names a tool this DSH does not serve refuses, and leaves no Bot', async (t) => {
  const { ctx, home } = team(t)
  const rt = ctx.provided.get('omniTeam')
  await assert.rejects(
    () => rt.createBot({ name: 'Typo', denyTools: ['Bash', 'nope'], pickModel: true, instructions: 'Read only.' }),
    /Bash, nope are not tools this DSH serves/,
  )
  assert.equal(rt.findBot('Typo'), undefined)
  const stored = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(Object.values(stored.bots ?? {}).some(bot => bot.name === 'Typo'), false)
})

test('an update that names a tool this DSH does not serve refuses and keeps the old list', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  const before = restricted.filter(entry => entry.sessionId === bot.id).length
  await assert.rejects(() => rt.updateBot(bot.id, { denyTools: ['nope'] }), /nope is not a tool this DSH serves/)
  assert.deepEqual(bot.denyTools, ['bash'])
  assert.equal(restricted.filter(entry => entry.sessionId === bot.id).length, before)
})

test('a Bot without a deny list is unchanged', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Plain', pickModel: true, instructions: 'Free.' })
  assert.equal(bot.denyTools, undefined)
  await rt.applyToolDeny(bot)
  assert.deepEqual(restricted.filter(entry => entry.sessionId === bot.id), [])
})

test('an update adds, replaces and clears the list, lifting what it set before', async (t) => {
  const { ctx, home, restricted, lifted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  const first = restricted.filter(entry => entry.sessionId === bot.id).at(-1)
  assert.deepEqual(first.deny, ['bash'])

  await rt.updateBot(bot.id, { denyTools: ['omni_send', 'write'] })
  assert.deepEqual(bot.denyTools, ['omni_send', 'write'])
  assert.ok(lifted.includes(bot.id), 'the earlier restriction was lifted')
  const second = restricted.filter(entry => entry.sessionId === bot.id).at(-1)
  assert.deepEqual(second.deny.sort(), ['omni_send', 'write'])

  await rt.updateBot(bot.id, { denyTools: [] })
  assert.equal(bot.denyTools, undefined)
  assert.equal(restricted.filter(entry => entry.sessionId === bot.id).length, 2)

  const stored = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(stored.bots[bot.id].denyTools, undefined)
})

test('the user update-bot route, with no acting Bot, persists add, replace and clear', async (t) => {
  const { ctx, home, call } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })

  const added = await call('update-bot', { id: bot.id, denyTools: ['bash', 'omni_send'] })
  assert.equal(added.ok, true)
  assert.deepEqual(added.value.denyTools, ['bash', 'omni_send'])

  // Cleaned like the host cleans it, and the response is the record the client keeps.
  const replaced = await call('update-bot', { id: bot.id, denyTools: [' write ', 'write', '', 'read'] })
  assert.equal(replaced.ok, true)
  assert.deepEqual(replaced.value.denyTools, ['write', 'read'])

  // The roster view spreads each record, so the list reaches the settings form.
  const state = await call('state', {})
  assert.equal(state.ok, true)
  assert.deepEqual(state.value.bots.find(entry => entry.id === bot.id).denyTools, ['write', 'read'])

  const cleared = await call('update-bot', { id: bot.id, denyTools: null })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.denyTools, undefined)
  const stored = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(stored.bots[bot.id].denyTools, undefined)
})

test('a list set on the record reaches a Session that resolves later', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', pickModel: true, instructions: 'Read only.' })
  bot.denyTools = ['omni_send']
  await rt.save()
  const resolve = ctx.sessionController.resolveAgent
  const { agent } = await resolve(bot.id)
  ctx.emit('agent/created', { agent })
  // The listener loads the team before it acts; a turn of the loop is enough here.
  await wait(100)
  const applied = restricted.filter(entry => entry.sessionId === bot.id)
  assert.ok(applied.length > 0)
  assert.deepEqual(applied.at(-1).deny, ['omni_send'])
})

test('a call that reaches the executor for a denied tool is refused', async (t) => {
  const { ctx } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash', 'omni_send'], pickModel: true, instructions: 'Read only.' })
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  assert.equal(typeof guard, 'function')
  await assert.rejects(
    () => guard({ name: 'bash', agent: { id: bot.id } }, async () => 'ran'),
    /does not have the bash tool/,
  )
  assert.equal(rt.stopsView().length, 1)
  assert.equal(rt.stopsView()[0].why, 'tool')
  assert.equal(rt.stopsView()[0].botId, bot.id)
  assert.equal(await guard({ name: 'omni_messages', agent: { id: bot.id } }, async () => 'ran'), 'ran')

  const other = await rt.createBot({ name: 'Free', pickModel: true, instructions: 'Free.' })
  assert.equal(await guard({ name: 'bash', agent: { id: other.id } }, async () => 'ran'), 'ran')
})

test('a restricted Bot loses schedule create and edit, and the guard refuses both', async (t) => {
  const schedule = ['schedule_create', 'schedule_edit']
  const { ctx, restricted } = team(t, { served: [...SERVED, 'schedule_list', ...schedule] })
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({
    name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.',
  })
  bot.kind = 'dsh'
  await rt.applyToolDeny(bot)
  await flush()
  // The profile serves the schedule tools, so the restriction hides them too.
  const applied = restricted.filter(entry => entry.sessionId === bot.id).at(-1)
  assert.deepEqual(applied.deny.sort(), ['bash', ...schedule].sort())
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  for (const name of schedule) {
    await assert.rejects(
      () => guard({ name, agent: { id: bot.id } }, async () => 'ran'),
      new RegExp(`does not have the ${name} tool`),
    )
  }
  // Reading the schedule opens no Session and stays available.
  assert.equal(await guard({ name: 'schedule_list', agent: { id: bot.id } },
    async () => 'ran'), 'ran')
})

test('a restricted Bot loses schedule create and edit when not restrictable', async (t) => {
  const schedule = ['schedule_create', 'schedule_edit']
  // An agent-scope mount: `restrict()` cannot name these, so the executor guard is the layer.
  const { ctx, restricted, warnings } = team(t, { scoped: schedule })
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({
    name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.',
  })
  bot.kind = 'dsh'
  await rt.applyToolDeny(bot)
  await flush()
  const hidden = restricted.filter(entry => entry.sessionId === bot.id
    && entry.deny.some(name => schedule.includes(name)))
  assert.equal(hidden.length, 0)
  // The names are implicit, not the user's typo: no "ignored" warning names them.
  assert.doesNotMatch(warnings.join('\n'), /schedule_create|schedule_edit/)
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  for (const name of schedule) {
    await assert.rejects(
      () => guard({ name, agent: { id: bot.id } }, async () => 'ran'),
      new RegExp(`does not have the ${name} tool`),
    )
  }
})

test('a Bot without a deny list keeps schedule tools and uses the existing Session target', async (t) => {
  const schedule = ['schedule_create', 'schedule_edit']
  const { ctx } = team(t, { served: [...SERVED, ...schedule] })
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Plain', pickModel: true, instructions: 'Free.' })
  await flush()
  const guard = ctx.listeners.get('tools/execute')[0]
  const exec = { name: 'schedule_create', agent: { id: bot.id }, arguments: { target: 'this_session' } }
  assert.equal(await guard(exec, async () => 'ran'), 'ran')
})

test('only the user can change a Bot\'s deny list; the Bot cannot lift its own', async (t) => {
  const { ctx } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({
    name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.',
  })
  // A Bot editing itself, or a Main Bot editing it, cannot clear or narrow the list.
  await assert.rejects(
    () => rt.updateBot(bot.id, { denyTools: [] }, bot.id),
    /Only the user can set what Analista may use/,
  )
  await assert.rejects(
    () => rt.updateBot(bot.id, { name: 'Looser', denyTools: ['omni_send'] }, 'someone-else'),
    /Only the user can set what Analista may use/,
  )
  assert.deepEqual(bot.denyTools, ['bash'])
  assert.equal(bot.name, 'Analista')
  // The user's own settings path (no acting Bot) still clears it.
  await rt.updateBot(bot.id, { denyTools: [] })
  assert.equal(bot.denyTools, undefined)
})

test('a name this DSH stops serving is reported once and left out of the restriction', async (t) => {
  const { ctx, restricted, warnings } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  // A tool the profile served when the list was saved can disappear with its plugin.
  bot.denyTools = ['bash', 'gone-tool']
  await rt.save()
  await rt.applyToolDeny(bot)
  const applied = restricted.filter(entry => entry.sessionId === bot.id).at(-1)
  assert.deepEqual(applied.deny, ['bash'])
  assert.match(warnings.join('\n'), /gone-tool/)
})

test('a task run gets the list, and the executor guard refuses there too', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  // start_task writes its Session into state.tasks only; applyToolDeny is called with it.
  const taskSession = 'task-run-1'
  rt.state.tasks = { ...(rt.state.tasks ?? {}), [taskSession]: { title: 'work', from: bot.id, at: Date.now(), status: 'working' } }
  await rt.save()
  await rt.applyToolDeny(bot, [taskSession])
  const applied = restricted.filter(entry => entry.sessionId === taskSession)
  assert.ok(applied.length > 0, 'the task Session was restricted')
  assert.deepEqual(applied.at(-1).deny, ['bash'])
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  await assert.rejects(
    () => guard({ name: 'bash', agent: { id: taskSession } }, async () => 'ran'),
    /does not have the bash tool/,
  )
})

test('a group keeps its earlier parts under the room, and those are re-applied too', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  rt.state.rooms = {
    ...(rt.state.rooms ?? {}),
    'room-1': { id: 'room-1', name: 'Grupo', members: [bot.id], sessions: { [bot.id]: 'group-session-1' }, segments: { [bot.id]: [{ sessionId: 'group-part-1' }] } },
  }
  await rt.save()
  await rt.applyToolDeny(bot)
  const part = restricted.filter(entry => entry.sessionId === 'group-part-1').at(-1)
  assert.ok(part !== undefined, 'the room part was restricted')
  assert.deepEqual(part.deny, ['bash'])
})

test('an update that adds a name the restriction already hides keeps it', async (t) => {
  const { ctx, restricted } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  // `bash` is hidden from the visible surface now; the validator must still know it is served.
  await rt.updateBot(bot.id, { denyTools: ['bash', 'write'] })
  assert.deepEqual(bot.denyTools, ['bash', 'write'])
  const applied = restricted.filter(entry => entry.sessionId === bot.id).at(-1)
  assert.deepEqual(applied.deny.sort(), ['bash', 'write'])
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  await assert.rejects(
    () => guard({ name: 'bash', agent: { id: bot.id } }, async () => 'ran'),
    /does not have the bash tool/,
  )
})

test('a capability tool the Bot mounts is a valid deny name, and the guard refuses it', async (t) => {
  const { ctx, restricted, warnings } = team(t, { scoped: ['mcp_lookup'] })
  const rt = ctx.provided.get('omniTeam')
  // `restrict()` cannot name a scope-local tool, but the name is served and the list takes it.
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['mcp_lookup'], pickModel: true, instructions: 'Read only.' })
  assert.deepEqual(bot.denyTools, ['mcp_lookup'])
  await flush()
  assert.equal(restricted.filter(entry => entry.sessionId === bot.id && entry.deny.includes('mcp_lookup')).length, 0)
  assert.match(warnings.join('\n'), /cannot restrict/)
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  await assert.rejects(
    () => guard({ name: 'mcp_lookup', agent: { id: bot.id } }, async () => 'ran'),
    /does not have the mcp_lookup tool/,
  )
})

test('a subagent child of a restricted Bot is restricted and refused by the guard', async (t) => {
  const { ctx, restricted, sessions } = team(t)
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({ name: 'Analista', denyTools: ['bash'], pickModel: true, instructions: 'Read only.' })
  // Real child Sessions: DSH records the parent and the subagent origin in the header.
  const childId = 'child-run-1'
  const grandchildId = 'grandchild-run-1'
  sessions.set(childId, Session.create(childId, [], {
    version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(), cwd: '/tmp', parentSession: bot.id, origin: 'subagent', isSeeded: false,
  }))
  sessions.set(grandchildId, Session.create(grandchildId, [], {
    version: SESSION_FORMAT_VERSION, id: grandchildId, createdAt: Date.now(), cwd: '/tmp', parentSession: childId, origin: 'subagent', isSeeded: false,
  }))
  for (const sessionId of [childId, grandchildId]) {
    const { agent } = await ctx.sessionController.resolveAgent(sessionId)
    ctx.emit('agent/created', { agent })
  }
  await wait(100)
  for (const sessionId of [childId, grandchildId]) {
    const applied = restricted.filter(entry => entry.sessionId === sessionId)
    assert.ok(applied.length > 0, `the child Session ${sessionId} was restricted`)
    assert.deepEqual(applied.at(-1).deny, ['bash'])
  }
  const guard = (ctx.listeners.get('tools/execute') ?? [])[0]
  // The guard resolves the child by its header, even when the call carries no header itself.
  await assert.rejects(
    () => guard({ name: 'bash', agent: { id: grandchildId } }, async () => 'ran'),
    /does not have the bash tool/,
  )
  assert.equal(await guard({ name: 'omni_messages', agent: { id: grandchildId } }, async () => 'ran'), 'ran')
})

test('committed lineage replaces the implicit schedule mask and keeps explicit tool denials', async t => {
  const { ctx, restricted } = team(t, { served: [...SERVED, 'schedule_create', 'schedule_edit'] })
  const rt = ctx.provided.get('omniTeam')
  const bot = await rt.createBot({
    name: 'Planner', denyTools: ['bash', 'schedule_edit'], pickModel: true, instructions: 'Plan.',
  })
  await rt.applyToolDeny(bot)
  const applied = restricted.filter(entry => entry.sessionId === bot.id).at(-1)
  assert.deepEqual(applied.deny, ['bash', 'schedule_edit'])

  const guard = ctx.listeners.get('tools/execute')[0]
  const exec = (name, target) => ({ name, agent: { id: bot.id }, arguments: { target } })
  assert.equal(await guard(exec('schedule_create', 'this_session'), async () => 'ran'), 'ran')
  await assert.rejects(guard(exec('schedule_create', 'new_once'), async () => 'ran'), /verified Sessions/)
  await assert.rejects(guard(exec('schedule_edit', 'this_session'), async () => 'ran'), /does not have the schedule_edit tool/)
})
