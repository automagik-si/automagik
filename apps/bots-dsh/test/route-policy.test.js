import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { DEFAULT_ROUTE_POLICY, routeAllowed } from '../src/shared/route-policy.js'
import { fakeContext } from './fake-ctx.js'

const NATIVE = 'deepseek/flash'
const ACP = 'acp-claude/sonnet'
const HERMES = 'hermes-remote/default'
const bot = (id, fields = {}) => ({ id, name: id, role: '', instructions: '', createdAt: 1, ...fields })

async function team(t, { bots = [], routePolicy } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bots-route-policy-'))
  const main = bot('Main', { model: NATIVE, appliedModel: NATIVE })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: [main.id], whaleStored: true,
    bots: Object.fromEntries([main, ...bots].map(record => [record.id, record])),
  }))
  const accessChecks = []
  const ctx = fakeContext({ services: { acpAgents: {
    inspect: async provider => { accessChecks.push(provider); return { on: true, signedIn: true } },
  } } })
  const providers = {
    deepseek: [{ id: 'flash' }, { id: 'pro' }],
    'acp-claude': [{ id: 'sonnet', name: 'Policy Sonnet' }, { id: 'opus' }],
    'acp-codex': [{ id: 'gpt' }],
  }
  Object.assign(ctx.llm, {
    listProviders: () => Object.keys(providers).map(id => ({ id })),
    listModels: async id => providers[id] ?? [],
    resolveModelInfo: async () => ({}),
  })
  const calls = []
  const diagnostics = []
  ctx.sessionController = {
    create: async () => { calls.push(['create']); return { sessionId: `new-${calls.length}` } },
    selectModel: async ({ sessionId, provider, model }) => { calls.push(['select', sessionId, `${provider}/${model}`]) },
    resolveAgent: async id => {
      calls.push(['resolve', id])
      return { agent: { ...ctx.scopeAgent(id), session: { id, deriveMessages: () => [] }, followup() {} } }
    },
  }
  ctx.workspaceRegistry = { archiveSession: async id => { calls.push(['archive', id]) } }
  ctx.sessions = { flush: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  apply(ctx, { home, routePolicy, diagnosticsFile: false })
  const rt = ctx.provided.get('omniTeam')
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await rt.load()
  rt.noteFailure = entry => { diagnostics.push(entry) }
  return { rt, call, calls, diagnostics, accessChecks }
}

function refusalOf(result, name, route) {
  assert.equal(result.ok, false)
  assert.deepEqual(result.error, { code: 'bot/refused', message: `${name} cannot use the ${route} route.`, details: {} })
}

function refusalEntries(diagnostics) {
  return diagnostics.map(({ level, where, text }) => [level, where, text])
}

test('Q13 defaults allow Native and Remote Hermes for every kind, and ACP outside DSH', () => {
  assert.deepEqual(DEFAULT_ROUTE_POLICY, { default: ['native', 'acp', 'hermes-remote'], dsh: ['native', 'hermes-remote'] })
  for (const kind of [undefined, 'automagik', 'omni', 'genie', 'unfold', 'dsh']) {
    const allowed = ref => routeAllowed({ kind }, ref, DEFAULT_ROUTE_POLICY)
    assert.equal(allowed(NATIVE), true, kind)
    assert.equal(allowed(ACP), kind !== 'dsh', kind)
    assert.equal(allowed(HERMES), true, kind)
  }
})

test('an explicit kind list wins over the default and unnamed kinds in partial maps stay unrestricted', () => {
  assert.equal(routeAllowed({}, NATIVE, { automagik: [], default: ['native'] }), false)
  assert.equal(routeAllowed({ kind: 'dsh' }, ACP, { dsh: ['native'] }), false)
  assert.equal(routeAllowed({ kind: 'omni' }, ACP, { dsh: ['native'] }), true)
  assert.equal(routeAllowed({ kind: 'dsh' }, ACP), true)
})

test('the published roster carries the default, a configured map, or no map for an explicit empty object', async t => {
  for (const [routePolicy, published] of [
    [undefined, DEFAULT_ROUTE_POLICY], [{ dsh: ['acp', 'acp'] }, { dsh: ['acp'] }], [{}, undefined],
  ]) {
    const { call } = await team(t, { routePolicy })
    const result = await call('state')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.routePolicy, published)
    assert.equal(Object.hasOwn(result.value, 'routePolicy'), published !== undefined)
  }
})

test('switch-route and crossing update-bot refuse an ACP pick for DSH before touching the Session', async t => {
  const { rt, call, calls, diagnostics, accessChecks } = await team(t, {
    bots: [bot('DSH', { kind: 'dsh', model: NATIVE, appliedModel: NATIVE })],
  })
  const before = structuredClone(rt.botOf('DSH'))
  for (const [endpoint, model] of [['switch-route', ACP], ['update-bot', 'Policy Sonnet']]) {
    refusalOf(await call(endpoint, { id: 'DSH', model }), 'DSH', 'ACP')
  }
  assert.deepEqual(rt.botOf('DSH'), before)
  assert.deepEqual(calls, [])
  assert.deepEqual(accessChecks, [])
  assert.deepEqual(refusalEntries(diagnostics), ['switch-route', 'update-bot'].map(entry => [
    'warn', entry, `Route change ${NATIVE} → ${ACP} refused (route policy)`,
  ]))
})

test('update-bot checks the first pick even without a prior model or applied selection', async t => {
  const { rt, call, calls, diagnostics } = await team(t, { bots: [bot('DSH', { kind: 'dsh' })] })
  const before = structuredClone(rt.botOf('DSH'))
  refusalOf(await call('update-bot', { id: 'DSH', model: 'Policy Sonnet', role: 'Changed' }), 'DSH', 'ACP')
  assert.deepEqual(rt.botOf('DSH'), before)
  assert.deepEqual(calls, [])
  assert.deepEqual(refusalEntries(diagnostics), [
    ['warn', 'update-bot', `Route change (unavailable ref) → ${ACP} refused (route policy)`],
  ])
})

test('a shell-held Bot cannot recover to a Native model when the configured policy excludes it', async t => {
  const { rt, call, calls, diagnostics } = await team(t, {
    routePolicy: { dsh: ['hermes-remote'] },
    bots: [bot('Held', { kind: 'dsh', model: ACP, appliedModel: ACP, shell: false, sessionPinned: true })],
  })
  const before = structuredClone(rt.botOf('Held'))
  assert.equal(before.shellHeld.model, ACP)
  for (const endpoint of ['switch-route', 'update-bot']) {
    refusalOf(await call(endpoint, { id: 'Held', model: 'flash' }), 'Held', 'Native')
  }
  assert.deepEqual(rt.botOf('Held'), before)
  assert.deepEqual(calls, [])
  assert.deepEqual(refusalEntries(diagnostics), ['switch-route', 'update-bot'].map(entry => [
    'warn', entry, `Route change ${ACP} → ${NATIVE} refused (route policy)`,
  ]))
})

test('explicit create-bot picks obey the configured policy before creating a Session', async t => {
  const { rt, call, calls, diagnostics } = await team(t, { routePolicy: { automagik: ['native'] } })
  refusalOf(await call('create-bot', { name: 'New Bot', model: 'Policy Sonnet' }), 'New Bot', 'ACP')
  assert.equal(rt.findBot('New Bot'), undefined)
  assert.deepEqual(calls, [])
  assert.deepEqual(refusalEntries(diagnostics), [
    ['warn', 'create-bot', `Route change (unavailable ref) → ${ACP} refused (route policy)`],
  ])
})

test('an Automagik Bot can switch to ACP under the default policy', async t => {
  const { rt, call, calls } = await team(t)
  const result = await call('switch-route', { id: 'Main', model: ACP })
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(result.value.status, 'switched')
  assert.equal(rt.botOf('Main').appliedModel, ACP)
  assert.ok(calls.some(([operation, id, ref]) => operation === 'select' && id === 'Main' && ref === ACP))
})

test('a DSH Bot on a stored ACP model can edit within the provider, but cannot switch ACP agents', async t => {
  const { rt, call, calls, diagnostics } = await team(t, { bots: [bot('DSH', { kind: 'dsh', model: ACP, appliedModel: ACP })] })
  const updated = await call('update-bot', { id: 'DSH', model: 'acp-claude/opus', effort: null })
  assert.equal(updated.ok, true, updated.error?.message)
  assert.equal(rt.botOf('DSH').appliedModel, 'acp-claude/opus')
  assert.equal(diagnostics.length, 0)
  const before = calls.length
  refusalOf(await call('switch-route', { id: 'DSH', model: 'gpt' }), 'DSH', 'ACP')
  assert.equal(calls.length, before)
  assert.equal(diagnostics.length, 1)
})

test('a same-provider edit is checked as a crossing if the Bot leaves that provider during access validation', async t => {
  const { rt, call, calls, diagnostics } = await team(t, { bots: [bot('DSH', { kind: 'dsh', model: ACP, appliedModel: ACP })] })
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const checkAccess = rt.assertModelAccess
  rt.assertModelAccess = async ref => {
    if (ref === 'acp-claude/opus') {
      entered.resolve()
      await resume.promise
    }
    return checkAccess(ref)
  }
  const edit = call('update-bot', { id: 'DSH', model: 'acp-claude/opus' })
  await entered.promise
  try {
    const switched = await call('switch-route', { id: 'DSH', model: NATIVE })
    assert.equal(switched.ok, true, switched.error?.message)
  } finally { resume.resolve() }
  refusalOf(await edit, 'DSH', 'ACP')
  assert.equal(rt.botOf('DSH').appliedModel, NATIVE)
  assert.deepEqual(calls.filter(([operation]) => operation === 'select'), [['select', 'DSH', NATIVE]])
  assert.deepEqual(refusalEntries(diagnostics).filter(([level]) => level === 'warn'), [
    ['warn', 'update-bot', `Route change ${NATIVE} → acp-claude/opus refused (route policy)`],
  ])
})

test('first pick, shell recovery, and explicit creation refuse before model access', async t => {
  const guardAccess = ({ rt }) => {
    const reached = []
    rt.assertModelAccess = async ref => { reached.push(ref); throw new Error('access reached before policy') }
    return reached
  }
  const first = await team(t, { bots: [bot('First', { kind: 'dsh' })] })
  const firstAccess = guardAccess(first)
  refusalOf(await first.call('update-bot', { id: 'First', model: 'Policy Sonnet' }), 'First', 'ACP')
  assert.deepEqual(firstAccess, [])
  assert.deepEqual(first.accessChecks, [])
  assert.deepEqual(first.calls, [])

  const held = await team(t, {
    routePolicy: { dsh: ['hermes-remote'] },
    bots: [bot('Held', { kind: 'dsh', model: ACP, appliedModel: ACP, shell: false, sessionPinned: true })],
  })
  const heldAccess = guardAccess(held)
  refusalOf(await held.call('switch-route', { id: 'Held', model: 'flash' }), 'Held', 'Native')
  assert.deepEqual(heldAccess, [])
  assert.deepEqual(held.accessChecks, [])
  assert.deepEqual(held.calls, [])

  const created = await team(t, { routePolicy: { automagik: ['native'] } })
  const createdAccess = guardAccess(created)
  refusalOf(await created.call('create-bot', { name: 'New Bot', model: 'Policy Sonnet' }), 'New Bot', 'ACP')
  assert.equal(created.rt.findBot('New Bot'), undefined)
  assert.deepEqual(createdAccess, [])
  assert.deepEqual(created.accessChecks, [])
  assert.deepEqual(created.calls, [])
})

test('changing ACP agents through update-bot is a crossing subject to the DSH policy', async t => {
  const { rt, call, calls, diagnostics, accessChecks } = await team(t, {
    bots: [bot('DSH', { kind: 'dsh', model: ACP, appliedModel: ACP })],
  })
  const before = structuredClone(rt.botOf('DSH'))
  refusalOf(await call('update-bot', { id: 'DSH', model: 'acp-codex/gpt' }), 'DSH', 'ACP')
  assert.deepEqual(rt.botOf('DSH'), before)
  assert.deepEqual(calls, [])
  assert.deepEqual(accessChecks, [])
  assert.deepEqual(refusalEntries(diagnostics), [
    ['warn', 'update-bot', `Route change ${ACP} → acp-codex/gpt refused (route policy)`],
  ])
})

test('a configured kind policy can allow a route excluded by the DSH default', async t => {
  const { rt, call, calls } = await team(t, {
    routePolicy: { default: ['native'], dsh: ['native', 'acp'] },
    bots: [bot('DSH', { kind: 'dsh', model: NATIVE, appliedModel: NATIVE })],
  })
  const result = await call('switch-route', { id: 'DSH', model: ACP })
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(rt.botOf('DSH').appliedModel, ACP)
  assert.ok(calls.some(([operation, id, ref]) => operation === 'select' && id === 'DSH' && ref === ACP))
})
