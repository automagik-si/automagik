import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { teamActions } from '../src/client/team-actions.js'
import { MCP_PATH } from '../src/host/agent-access.js'
import { ROUTE } from '../src/host/constants.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import { GENIE_ATTACH_REFUSAL, effectiveRoleIds, genieDetached, storedRoles } from '../src/shared/roles.js'
import { fakeContext } from './fake-ctx.js'

const WISH = 'grant_wish'
const ATTACHMENT = { id: 'genie', version: '1.0.0', attachedAt: '2026-11-19T00:00:00.000Z', grants: [] }
const bot = (id, kind) => ({ id, sessionId: id, name: 'Bot', kind, role: 'Description', instructions: 'Help in chat.', createdAt: 1, capabilities: [] })

async function fixture(t, { wish = true, existingHome } = {}) {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'ds-bot-roles-'))
  const statePath = join(home, 'state.json')
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    if (existingHome === undefined) await rm(home, { recursive: true, force: true })
  })
  if (existingHome === undefined) await writeFile(statePath, JSON.stringify({
    version: 1, revision: 1, workspaceId: 'workspace', mainBotIds: ['ordinary'],
    bots: { ordinary: bot('ordinary'), first: bot('first', 'genie'), second: bot('second', 'genie') },
    rooms: { group: { id: 'group', name: 'Group', named: true, members: ['first', 'second'], admin: 'first', mode: 'everyone', sessions: { first: 'group-first' } } },
  }))
  const routes = new Map()
  ctx.connection.fetch.register = route => { routes.set(route.path, route); return () => {} }
  const agents = new Map()
  const filters = new Map()
  const registrations = new Set(['schedule_create', 'schedule_edit', ...(wish ? [WISH] : [])])
  ctx.tools.view = () => ({ restrictableNames: registrations, knownNames: registrations })
  ctx.tools.schemas = agent => [...registrations].filter(name => ![...(filters.get(agent) ?? [])].some(deny => deny.includes(name))).map(name => ({ name }))
  ctx.workspaceRegistry = { get: () => ({ id: 'workspace', path: home }), archiveSession: async () => {} }
  ctx.sessions = { get: () => undefined, flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  ctx.sessionController = {
    create: async options => ({ sessionId: options.sessionId ?? 'allocated' }),
    selectModel: async () => {},
    resolveAgent: async (id) => {
      if (!agents.has(id)) {
        const active = new Set()
        const agent = { id, session: { id }, ctx: { tools: {
          register: () => () => {},
          restrict: ({ deny }) => {
            active.add(deny)
            ctx.emit('tools/change')
            return () => { active.delete(deny); ctx.emit('tools/change') }
          },
        } } }
        filters.set(agent, active)
        agents.set(id, agent)
      }
      return { agent: agents.get(id) }
    },
  }
  apply(ctx, { home, memory: false, browser: false, updateCheck: false })
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  const post = (path, body, headers) => routes.get(path).fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })).then(response => response.json())
  const call = (endpoint, payload) => post(ROUTE, { endpoint, payload })
  const disk = async () => JSON.parse(await readFile(statePath, 'utf8'))
  const names = agent => ctx.tools.schemas(agent).map(tool => tool.name)
  const assemble = async (agent) => {
    const layer = ctx.listeners.get('system-prompt/assemble').find(fn => fn.name === 'scopeTeamTools')
    await layer({}, { agent }, async () => ({ sections: [] }))
    ctx.emit('tools/change')
    return names(agent)
  }
  const guard = (agent, name) => ctx.guards.map(check => check({ agent, name, arguments: {} })).find(answer => typeof answer === 'string')
  const registerWish = () => { registrations.add(WISH); ctx.emit('tools/change') }
  return { ctx, rt, home, statePath, post, call, disk, names, assemble, guard, registerWish }
}

test('the first valid own attachment is authoritative and the off switch restores the kind view', () => {
  const legacy = { kind: 'genie' }
  assert.equal(storedRoles(legacy), undefined)
  assert.deepEqual(effectiveRoleIds(legacy), ['genie'])
  assert.deepEqual(effectiveRoleIds({}), [])
  assert.deepEqual(effectiveRoleIds(Object.assign(Object.create({ roles: [] }), legacy)), ['genie'])
  for (const roles of [[], undefined, null, {}, 'genie', [null, { id: 'genie' }], [
    { ...ATTACHMENT, id: 'constructor' }, { ...ATTACHMENT, version: '' },
    { ...ATTACHMENT, attachedAt: 1 }, { ...ATTACHMENT, grants: null },
  ]]) {
    const record = { ...legacy, roles }
    assert.deepEqual(effectiveRoleIds(record), [])
    assert.equal(genieDetached(record), true)
    assert.deepEqual(effectiveRoleIds(record, { roles: false }), ['genie'])
    assert.equal(genieDetached(record, { roles: false }), false)
    assert.equal(record.roles, roles)
  }
  const roles = [{ id: 'unknown' }, ATTACHMENT, { ...ATTACHMENT, version: '2.0.0' }]
  assert.deepEqual(storedRoles({ roles }), [ATTACHMENT])
  assert.deepEqual(effectiveRoleIds({ roles }), ['genie'])
  assert.deepEqual(effectiveRoleIds({ roles }, { roles: false }), [])
})

test('owner detach and attach change only the role and its tool in a live chat and group Session', async (t) => {
  const { ctx, rt, home, call, disk, assemble, guard } = await fixture(t)
  const chat = await rt.resolveAgent('first')
  const group = await rt.resolveAgent('group-first')
  const other = await rt.resolveAgent('second')
  const ordinary = await rt.resolveAgent('ordinary')
  const saved = (await disk()).bots
  const text = agent => ctx.sections.get('bot-identity').text({ agent })
  const prompts = [chat, group, other, ordinary].map(text)
  assert.deepEqual(effectiveRoleIds(saved.ordinary), [])
  assert.equal((await call('role-attach', { id: 'ordinary', role: 'genie' })).error.message, GENIE_ATTACH_REFUSAL)
  assert.deepEqual((await disk()).bots.ordinary, saved.ordinary)
  assert.ok((await assemble(chat)).includes(WISH))

  assert.deepEqual(await call('role-detach', { id: 'first' }), { ok: true, value: [] })
  assert.deepEqual((await disk()).bots, { ...saved, first: { ...saved.first, roles: [] } })
  assert.deepEqual((await call('state')).value.bots.find(record => record.id === 'first').roles, [])
  const reload = await fixture(t, { existingHome: home })
  assert.deepEqual(reload.rt.botOf('first').roles, [])
  for (const agent of [chat, group]) {
    assert.deepEqual(await assemble(agent), ['schedule_create', 'schedule_edit'])
    assert.equal(guard(agent, WISH), `Bot does not have the ${WISH} tool: its Genie role is off.`)
  }
  for (const agent of [other, ordinary]) {
    assert.ok((await assemble(agent)).includes(WISH))
    assert.equal(guard(agent, WISH), undefined)
  }
  rt.taskOwners.set('task', { botId: 'first' })
  const task = await rt.resolveAgent('task')
  assert.ok((await assemble(task)).includes(WISH))
  assert.equal(guard(task, WISH), undefined)
  assert.deepEqual([chat, group, other, ordinary].map(text), prompts)
  assert.deepEqual(await call('role-attach', { id: 'first', role: 'genie' }), { ok: true, value: ['genie'] })
  assert.deepEqual((await disk()).bots, saved)
  assert.ok((await assemble(chat)).includes(WISH))
  assert.ok((await assemble(group)).includes(WISH))
  assert.equal(guard(chat, WISH), undefined)
})

test('the same Agent keeps or lifts the mask across tools/change, assemble and role switches', async (t) => {
  const { rt, call, disk, assemble, names, registerWish } = await fixture(t, { wish: false })
  const chat = await rt.resolveAgent('first')
  await assemble(chat)
  assert.equal((await call('role-detach', { id: 'first' })).ok, true)
  registerWish()
  assert.equal(names(chat).includes(WISH), false, 'late registration was masked during tools/change')
  assert.equal((await assemble(chat)).includes(WISH), false)
  await call('role-attach', { id: 'first', role: 'genie' })
  assert.ok(names(chat).includes(WISH), 'the attach lifted the live mask')
  await call('role-detach', { id: 'first' })
  await call('set-prefs', { roles: false })
  assert.equal((await disk()).prefs.roles, false)
  assert.deepEqual((await disk()).bots.first.roles, [])
  assert.ok((await assemble(chat)).includes(WISH))
  assert.equal((await call('role-attach', { id: 'first', role: 'genie' })).error.message, 'Roles are turned off for this team.')
  await call('set-prefs', { roles: 'invalid' })
  assert.equal((await disk()).prefs.roles, false)
  await call('set-prefs', { roles: true })
  assert.equal(Object.hasOwn((await disk()).prefs, 'roles'), false)
  assert.equal((await assemble(chat)).includes(WISH), false)
  await call('set-prefs', { roles: false })
  await call('set-prefs', { roles: null })
  assert.equal(Object.hasOwn((await disk()).prefs, 'roles'), false)
  assert.equal(await rt.resolveAgent('first'), chat)
  assert.equal(names(chat).includes(WISH), false)
})

test('a failed write publishes no role change, and identical edits do not write', async (t) => {
  const { rt, call, disk, statePath, names } = await fixture(t)
  const chat = await rt.resolveAgent('first')
  const before = await disk()
  await call('role-attach', { id: 'first', role: 'genie' })
  assert.deepEqual(await disk(), before)
  const temp = `${statePath}.${process.pid}.tmp`
  await mkdir(temp)
  assert.equal((await call('role-detach', { id: 'first' })).ok, false)
  assert.equal(Object.hasOwn(rt.botOf('first'), 'roles'), false)
  assert.ok(names(chat).includes(WISH))
  assert.deepEqual(await disk(), before)
  await rm(temp, { recursive: true })
  assert.equal((await call('role-detach', { id: 'first' })).ok, true)
  const detached = await disk()
  await call('role-detach', { id: 'first' })
  assert.deepEqual(await disk(), detached)
  await mkdir(temp)
  assert.equal((await call('role-attach', { id: 'first', role: 'genie' })).ok, false)
  assert.deepEqual(rt.botOf('first').roles, [])
  assert.equal(names(chat).includes(WISH), false)
  assert.deepEqual(await disk(), detached)
})

test('role edits publish after the write and queue behind a pending commit', async (t) => {
  const { rt, call, disk, names } = await fixture(t)
  const chat = await rt.resolveAgent('first')
  const saveCopy = rt.saveCopy
  const started = Promise.withResolvers()
  const resume = Promise.withResolvers()
  rt.saveCopy = async (apply, options) => {
    started.resolve()
    await resume.promise
    return saveCopy(apply, options)
  }
  const detach = call('role-detach', { id: 'first' })
  await started.promise
  const attach = call('role-attach', { id: 'first', role: 'genie' })
  assert.equal(Object.hasOwn(rt.botOf('first'), 'roles'), false)
  assert.equal(Object.hasOwn((await disk()).bots.first, 'roles'), false)
  assert.ok(names(chat).includes(WISH))
  resume.resolve()
  assert.deepEqual(await detach, { ok: true, value: [] })
  assert.deepEqual(await attach, { ok: true, value: ['genie'] })
  assert.equal(Object.hasOwn((await disk()).bots.first, 'roles'), false)
  assert.ok(names(chat).includes(WISH))
})

test('a refused role preference commit leaves the live switch and mask in place', async (t) => {
  const { rt, call, disk, names } = await fixture(t)
  const chat = await rt.resolveAgent('first')
  assert.equal((await call('role-detach', { id: 'first' })).ok, true)
  let written
  rt.saveCopy = async (apply) => {
    const copy = structuredClone(rt.state)
    apply(copy)
    written = copy.prefs.roles
    throw new Error('Write refused')
  }
  assert.equal((await call('set-prefs', { roles: false })).ok, false)
  assert.equal(written, false)
  assert.equal(Object.hasOwn(rt.state.prefs, 'roles'), false)
  assert.equal(Object.hasOwn((await disk()).prefs, 'roles'), false)
  assert.equal(names(chat).includes(WISH), false)
})

test('only owner role actions can write a team Bot role', async (t) => {
  const { rt, home, post, call, disk } = await fixture(t)
  const before = await disk()
  const writable = rt.readOnly
  rt.readOnly = () => 'Read only'
  for (const endpoint of ['role-attach', 'role-detach']) {
    assert.equal((await call(endpoint, { id: 'first', role: 'genie' })).error.code, 'bot/read-only')
  }
  rt.readOnly = writable
  const mixed = await call('update-bot', { id: 'first', instructions: 'Changed', roles: [] })
  assert.equal(mixed.error.code, 'bot/invalid')
  assert.match(mixed.error.message, /role-attach and role-detach/)
  for (const id of ['seat:external', 'constructor', ['first']]) {
    for (const endpoint of ['role-attach', 'role-detach']) {
      assert.equal((await call(endpoint, { id, role: 'genie' })).error.message, 'No such Bot')
    }
  }
  for (const role of ['constructor', 0, null]) {
    assert.equal((await call('role-attach', { id: 'first', role })).error.message, 'Unknown role')
  }
  assert.deepEqual(await disk(), before)

  // Wait for the empty token store to load, then seed a credential for in-process POSTs.
  await rt.agentAccess.owner('view')
  const token = 'fixture-token'
  await writeFile(join(home, 'agent-tokens.json'), JSON.stringify([
    { id: 'fixture', name: 'MCP fixture', hash: createHash('sha256').update(token).digest('hex') },
  ]), { mode: 0o600 })
  const rpc = (method, params) => post(MCP_PATH, { jsonrpc: '2.0', id: 1, method, params }, {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
  })
  const listed = (await rpc('tools/list')).result.tools
  assert.equal(listed.some(tool => /^role[_-](attach|detach)$/.test(tool.name)), false)
  assert.equal(Object.hasOwn(listed.find(tool => tool.name === 'update_bot').inputSchema.properties, 'roles'), false)
  for (const name of ['role-attach', 'role-detach']) {
    const result = await rpc('tools/call', { name, arguments: { id: 'first', role: 'genie' } })
    assert.ok(result.error || result.result?.isError)
  }
  await call('role-detach', { id: 'first' })
  const copied = await call('duplicate-bot', { id: 'first' })
  assert.equal(copied.ok, true, copied.error?.message)
  assert.equal(Object.hasOwn((await disk()).bots[copied.value.id], 'roles'), false)
  assert.deepEqual((await disk()).bots.first.roles, [])
})

test('the local-agent bridge still excludes the wish tool', async (t) => {
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  installLocalAgents({ ctx, state: { localAgents: { custom: [{ id: 'fixture' }] } }, teamTools: [{ name: 'list_bots' }] })
  const { adapter } = ctx.adapters[0]
  assert.deepEqual(adapter.deps.toolsFor({ tools: [{ name: WISH }, { name: 'list_bots' }] }), [{ name: 'list_bots' }])
})

test('a seat exposed in the team view is not a target for owner role actions', async (t) => {
  const { rt, call, disk } = await fixture(t)
  const seat = { id: 'seat:external', name: 'External seat' }
  t.after(rt.hooks.view(() => ({ seats: [seat] })))
  const before = await disk()
  assert.deepEqual((await call('state')).value.seats, [seat])
  assert.equal(Object.hasOwn(rt.state.bots, seat.id), false)
  for (const endpoint of ['role-attach', 'role-detach']) {
    const result = await call(endpoint, { id: seat.id, role: 'genie' })
    assert.equal(result.error.message, 'No such Bot')
  }
  assert.deepEqual(await disk(), before)
})

test('picker role actions post through the owner channel and refresh afterward', () => {
  const calls = []
  const result = { ok: true }
  const actions = teamActions({
    call: (endpoint, payload) => { calls.push(['call', endpoint, payload]); return result },
    after: value => { calls.push(['after', value]); return value },
  })
  assert.equal(actions.detachRole('first'), result)
  assert.equal(actions.attachRole('first', 'genie'), result)
  assert.deepEqual(calls, [
    ['call', 'role-detach', { id: 'first' }], ['after', result],
    ['call', 'role-attach', { id: 'first', role: 'genie' }], ['after', result],
  ])
})

test('a mixed roles update is rejected before the ordinary description update runs', async (t) => {
  const { rt, call, disk } = await fixture(t)
  const before = await disk()
  const refused = await call('update-bot', { id: 'ordinary', role: 'Changed', roles: [] })
  assert.equal(refused.error.code, 'bot/invalid')
  assert.deepEqual(await disk(), before)
  assert.equal(rt.botOf('ordinary').role, before.bots.ordinary.role)
  const accepted = await call('update-bot', { id: 'ordinary', role: 'Changed' })
  assert.equal(accepted.ok, true)
  assert.equal((await disk()).bots.ordinary.role, 'Changed')
})
