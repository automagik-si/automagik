import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyExecutor, inject as executorInject } from '@deepseek-ai/dsh-tool-executor-native'
import { createIdentityReaders, IDENTITY_PROVIDERS } from '../../acp-dsh/src/host/identity.js'
import { apply } from '../index.js'
import { createSolver } from '../src/client/solver-draft.js'
import { ROUTE } from '../src/host/constants.js'
import { installRoles } from '../src/host/roles.js'
import { fakeContext } from './fake-ctx.js'
import { archive, entryOf, INDEX, SIGNATURE, signer, solverCutHistory, tarMember } from './role-fixture.js'
import { until } from './until.js'
import { mountVoiceWindow, mountRoleSettings } from './role-runtime-client.js'

const ID = 'voice-mouth'
const FIRST = 'fixture-first'
const SECOND = 'fixture-second'
const GROUP = 'fixture-member'
const RELAY = 'fixture-relay'
const PLAIN = 'fixture-plain'
const NOW = Date.UTC(2026, 10, 20)
const source = new URL('../roles/voice-mouth/', import.meta.url)
const manifest = JSON.parse(await fs.readFile(new URL('role.json', source), 'utf8'))
const officialScript = await fs.readFile(new URL(manifest.entry, source), 'utf8')
const officialPrompt = await fs.readFile(new URL(manifest.prompt, source), 'utf8')
const rolePart = prompt => `<role-prompt id="${ID}">\n${prompt.trimEnd()}\n</role-prompt>`
const acpService = registry => ({
  botIdentity: registry.register, rolePromptProviders: IDENTITY_PROVIDERS,
})
const fixtureBot = (id, fields = {}) => ({
  id, sessionId: id, name: id, role: 'Description', instructions: 'Follow the fixture instructions.',
  createdAt: 1, permission: 'workspace-write', ...fields,
})
const speech = (result) => result.content.map(part => part.text).join('\n')
function refused(result, message) {
  assert.equal(result.isError, true, JSON.stringify(result))
  assert.match(speech(result), message)
}

async function fixture(t, {
  script = officialScript, promptText = officialPrompt, role = manifest, readOnly = false, bundle = false,
} = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'ds-bot-role-runtime-'))
  const stateFile = join(home, 'state.json')
  const folder = join(home, 'roles', role.id, role.version)
  const packageBytes = archive([
    tarMember('package/role.json', JSON.stringify(role)),
    tarMember(`package/${role.entry}`, script),
    tarMember(`package/${role.prompt}`, promptText),
  ])
  const entry = entryOf(packageBytes, { id: role.id, version: role.version, name: role.name, capabilities: role.capabilities })
  const signed = signer()
  const index = signed.index([entry])
  const paths = new Map([[INDEX, index.bytes], [SIGNATURE, index.signature], [entry.source, packageBytes]])
  await fs.writeFile(stateFile, JSON.stringify({
    version: 1, revision: 1, workspaceId: 'fixture',
    mainBotIds: [SECOND], bots: {
      [FIRST]: fixtureBot(FIRST, { model: 'test-provider/fixture', workDir: home }),
      [SECOND]: fixtureBot(SECOND),
    },
    rooms: { [RELAY]: { id: RELAY, sessionId: RELAY, name: 'Fixture group', named: true, members: [FIRST, SECOND],
      admin: SECOND, sessions: { [FIRST]: GROUP }, log: [], seq: 0, seen: {} } },
  }))
  const contexts = new Set()
  t.after(async () => {
    for (const context of contexts) await context.close()
    await fs.rm(home, { recursive: true, force: true })
  })
  if (readOnly) {
    await fs.writeFile(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'fixture-lock' }))
  }

  async function start({ acpAgents } = {}) {
    const harness = new Context()
    await harness.plugin(SystemPrompt)
    await harness.plugin(ToolRuntime)
    await harness.plugin({ apply: applyExecutor, inject: executorInject })
    let scopeParent
    await harness.inject(['tools'], ctx => { scopeParent = ctx })
    const agents = new Map()
    const host = fakeContext({ services: {
      agents: { list: () => [...agents.values()], get: id => agents.get(id) }, acpAgents,
    } })
    let disposeIdentity
    const effect = host.effect
    host.effect = (execute, label) => effect(() => {
      const dispose = execute()
      if (label !== 'ds-bot: ACP identity') return dispose
      disposeIdentity = dispose
      return () => { disposeIdentity?.(); disposeIdentity = undefined }
    }, label)
    const agentOf = (id, replace = false) => {
      if (!replace && agents.has(id)) return agents.get(id)
      const header = { version: 4, id, createdAt: 0, isSeeded: false, cwd: home }
      const session = agents.get(id)?.session ?? Session.create(id, undefined, header)
      const agent = { id, session, inbox: { nextStep: [], nextTurn: [], remove: () => false }, cancel() {}, whenIdle: async () => {} }
      agent.ctx = createScope(scopeParent, agent).ctx
      agents.set(id, agent)
      return agent
    }
    for (const id of [FIRST, SECOND, GROUP, RELAY, PLAIN]) agentOf(id)
    const routes = new Map()
    host.connection.fetch.register = route => { routes.set(route.path, route); return () => {} }
    const events = (id, type, data) => {
      for (const fn of host.listeners.get('session/event') ?? []) fn(agentOf(id).session, { type, data })
    }
    Object.assign(host, {
      tools: harness.tools,
      workspaceRegistry: { get: () => ({ id: 'fixture', path: home }), archiveSession: async () => {} },
      sessions: { get: id => agents.get(id)?.session, list: () => [...agents.values()].map(agent => agent.session), flush: async () => {} },
      sessionTitle: { rename: async () => {} },
      sessionController: {
        resolveAgent: async id => ({ agent: agentOf(id) }),
        prompt: async ({ requestId, sessionId }) => {
          events(sessionId, 'turn/start', { turn: 1 })
          events(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId }, text: 'Fixture request' })
          return { accepted: true }
        },
      },
    })
    apply(host, { home, memory: false, browser: false, updateCheck: false, mainName: 'Fixture main' })
    const rt = host.provided.get('omniTeam')
    const warnings = []
    rt.warn = (...args) => warnings.push(args)
    const fetched = []
    installRoles(rt, { keys: [signed.key], now: () => NOW,
      ...(bundle ? { bundledHistory: solverCutHistory() } : { bundledRoot: join(home, 'no-bundle') }), fetch: async url => {
      fetched.push(url)
      assert.ok(paths.has(url), `Unexpected network URL: ${url}`)
      return new Response(paths.get(url))
    } })
    // The real tool pipeline sees the host's policies, with the route and other
    // host services supplied by a disposable stand-in.
    for (const listener of host.listeners.get('tools/execute')) harness.on('tools/execute', listener)
    await rt.load()
    await rt.roleRuntime.ready()
    let closed = false
    const call = async (endpoint, payload, signal) => {
      if (closed) throw new Error('The fixture host has stopped')
      return (await routes.get(ROUTE).fetch(new Request(`http://localhost${ROUTE}`, {
        method: 'POST', signal, body: JSON.stringify({ endpoint, payload }),
      }))).json()
    }
    const ok = async (endpoint, payload, signal) => {
      const answer = await call(endpoint, payload, signal)
      assert.equal(answer.ok, true, JSON.stringify(answer))
      return answer.value
    }
    const pin = (id = FIRST) => {
      const { grants, ...value } = rt.state.bots[id].roles[0]
      return value
    }
    const has = id => Boolean(harness.tools.get('speak', agentOf(id)))
    const prompt = id => host.sections.get('bot-identity').text({ agent: agentOf(id) })
    const execute = async (text, { id = FIRST, callId = randomUUID() } = {}) => {
      const batch = await harness.tools.execute({ agent: agentOf(id), signal: new AbortController().signal,
        calls: [{ id: callId, name: 'speak', arguments: JSON.stringify({ text }) }] })
      return batch.results[0].result
    }
    const context = { rt, host, harness, fetched, warnings, agentOf, events, call, ok, has, pin, prompt, execute,
      disposeIdentity: () => { disposeIdentity?.(); disposeIdentity = undefined },
      async close() { closed = true; contexts.delete(context); await host.dispose(); await harness.fiber.dispose() } }
    contexts.add(context)
    return context
  }
  return { start, folder, packageBytes, index, paths, home, emptyCatalog: () => signed.index([]),
    disk: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')) }
}

test('the reviewed package speaks through DSH to one mounted pane and rolls back through Bot Settings', async t => {
  assert.deepEqual(manifest.capabilities, ['audio-out'])
  assert.deepEqual(manifest.tools.map(({ name, parameters }) => [name, parameters.text]), [
    ['speak', { type: 'string', required: true, maxLength: 2000 }],
  ])
  assert.doesNotMatch(officialScript, /\b(?:import|require)\b/)
  const f = await fixture(t)
  const h = await f.start()
  const asBefore = await f.disk()
  const prompts = Object.fromEntries([FIRST, SECOND, GROUP, RELAY, PLAIN].map(id => [id, h.prompt(id)]))
  assert.deepEqual(await h.ok('role-install', { id: ID }), { id: ID, version: manifest.version, warnings: [] })
  assert.equal(h.has(FIRST), false)
  for (const [suffix, expected] of [['.tgz', f.packageBytes], ['.roles.json', f.index.bytes], ['.roles.json.sig', Buffer.from(f.index.signature)]]) {
    assert.deepEqual(await fs.readFile(f.folder + suffix), expected)
    if (process.platform !== 'win32') assert.equal((await fs.stat(f.folder + suffix)).mode & 0o777, 0o600)
  }
  await h.ok('role-attach', { id: FIRST, role: ID })
  assert.equal(h.has(FIRST), true, JSON.stringify({ records: await h.rt.roleRecordsView(), warnings: h.warnings.map(warning => warning.map(String)) }))
  assert.equal(h.has(GROUP), true)
  assert.equal(h.has(SECOND), false)
  assert.equal(h.has(RELAY), false)
  assert.equal(h.has(PLAIN), false)
  for (const id of [SECOND, RELAY, PLAIN]) assert.equal(h.prompt(id), prompts[id])
  for (const id of [FIRST, GROUP]) {
    const prompt = h.prompt(id)
    assert.equal(prompt.match(/<role-prompt /g).length, 1)
    assert.ok(prompt.indexOf('Follow the fixture instructions.') < prompt.indexOf(officialPrompt.trim()))
    assert.ok(prompt.indexOf(officialPrompt.trim()) < prompt.indexOf('## How your Bot team works'))
    assert.equal(prompt.replace(/\n\n<role-prompt [\s\S]*?<\/role-prompt>/, ''), prompts[id])
  }
  const before = h.pin()
  refused(await h.execute('No grant speech'), /may not speak until you allow it/)
  refused(await h.execute('x'.repeat(2001)), /2000/)
  const card = await mountRoleSettings(t, h, FIRST)
  assert.match(card.text(), /Active tools\s*speak/)
  assert.doesNotMatch(card.text(), /Its tools arrive with the role runtime/)
  await card.click('Allow speech')
  await until(() => h.rt.state.bots[FIRST].roles[0].grants.includes('audio-out'))
  refused(await h.execute('No pane speech'), /Open voice chat/)
  await until(() => card.document.querySelector('select[aria-label="Voice"]'))
  card.change('Voice', 'fixture-voice')
  card.change('Speed', '1.4')
  await card.click('Save')
  await until(() => card.document.querySelector('input[aria-label="Speed"]')?.disabled === false)
  assert.deepEqual(await h.ok('role-settings', { id: FIRST, role: before }), { voice: 'fixture-voice', speed: 1.4 })
  assert.equal(card.window.localStorage.length, 0)
  assert.equal(JSON.stringify((await f.disk()).bots[SECOND]), JSON.stringify(asBefore.bots[SECOND]))

  const first = await mountVoiceWindow(t, h, FIRST)
  const second = await mountVoiceWindow(t, h, FIRST)
  // The second pane is most recent. A voice-originating user turn still selects the first.
  await first.send('Fixture request')
  const sound = 'This is the role speech.'
  const callId = randomUUID()
  const result = await h.execute(sound, { callId })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.match(speech(result), /Spoken in voice chat/)
  assert.deepEqual(first.spoken, [{ text: sound, voice: 'fixture-voice', rate: 1.4 }])
  assert.deepEqual(second.spoken, [])
  assert.equal((await h.execute(sound, { callId })).isError, false)
  assert.equal(first.spoken.length, 1)
  assert.ok(!JSON.stringify(await h.ok('state')).includes(sound))

  first.holdUtterance()
  first.closeReply('This is the closing reply.')
  await until(() => first.spoken.length === 2)
  assert.equal(first.spoken[1].text, 'This is the closing reply.')
  assert.deepEqual(second.spoken, [])

  h.rt.state.bots[FIRST].denyTools = ['speak']
  refused(await h.execute('Denied speech'), /does not have the speak tool/)
  delete h.rt.state.bots[FIRST].denyTools
  assert.equal(first.spoken.length, 2)

  // The role is isolated across two Bots, and the ACP route keeps the tool
  // while the card and the identity renderer withhold its role prompt.
  await h.ok('role-attach', { id: SECOND, role: ID })
  h.rt.state.bots[SECOND].model = 'acp-codex/default'
  assert.equal(h.has(SECOND), true)
  assert.doesNotMatch(h.prompt(SECOND), /role-prompt/)
  const acpCard = await mountRoleSettings(t, h, SECOND)
  assert.match(acpCard.text(), /ACP coding agents do not receive this role’s prompt/)
  assert.deepEqual(await h.ok('role-settings', { id: SECOND, role: h.pin(SECOND) }), { voice: '', speed: 1 })

  const queued = h.execute('Must stay behind the closing reply')
  await until(() => first.offers.length === 2)
  assert.equal(first.spoken.length, 2)
  await first.click('End voice chat')
  refused(await queued, /pane closed/)
  assert.deepEqual(second.spoken, [])
  await second.pause()
  h.events(FIRST, 'turn/end', { turn: 1 })
  h.events(GROUP, 'turn/start', { turn: 1 })
  const pending = h.execute('Cancelled on detach')
  await until(() => second.offers.length === 1)
  await card.click('Detach')
  refused(await pending, /speech was cancelled/)
  assert.equal(h.has(FIRST), false)
  assert.equal(h.has(GROUP), false)
  assert.equal(h.has(SECOND), true)
  assert.equal(h.prompt(FIRST), prompts[FIRST])
  assert.match(h.prompt(GROUP), /role-prompt/, 'the running group turn keeps its starting prompt')
  h.events(GROUP, 'turn/end', { turn: 1 })
  assert.equal(h.prompt(GROUP), prompts[GROUP])
  await card.refresh()
  assert.doesNotMatch(card.text(), /Active tools|Allow speech/)
  assert.deepEqual(second.spoken, [])
  assert.deepEqual(await h.ok('role-detach', { id: SECOND }), [])
  assert.deepEqual((await h.ok('state')).bots.map(bot => [bot.id, bot.roles]), [[FIRST, []], [SECOND, []]])
  card.unmount()
  const rollback = await mountRoleSettings(t, h, FIRST)
  await rollback.click('Uninstall')
  await until(() => !Object.hasOwn(h.rt.state.roles, ID))
  await rollback.refresh()
  await until(() => [...rollback.document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Install' && !button.disabled))
  await rollback.click('Install')
  await until(() => Object.hasOwn(h.rt.state.roles, ID))
  await rollback.refresh()
  await rollback.click('Voice / Mouth')
  await until(() => h.rt.state.bots[FIRST].roles.length === 1)
  assert.notEqual(h.pin().attachedAt, before.attachedAt)
  assert.deepEqual(h.rt.state.bots[FIRST].roles[0].grants, [])
  const stale = await h.call('role-grant', { id: FIRST, role: before, capability: 'audio-out', on: true })
  assert.equal(stale.ok, false)
  assert.match(stale.error.message, /role changed/)
  assert.deepEqual(await h.ok('role-settings', { id: FIRST, role: h.pin() }), { voice: 'fixture-voice', speed: 1.4 })
  delete h.rt.state.bots[SECOND].model
  await h.ok('role-detach', { id: FIRST })
  const after = await f.disk()
  assert.equal(JSON.stringify({ ...after.bots[SECOND], roles: undefined }), JSON.stringify(asBefore.bots[SECOND]))
  for (const key of ['model', 'permission', 'workDir', 'sessionId']) assert.equal(after.bots[FIRST][key], asBefore.bots[FIRST][key])
  assert.ok(!JSON.stringify(after).includes('fixture-voice'))
})

test('the ACP identity reader serves the native part only for eligible Bot Sessions', async t => {
  const registry = createIdentityReaders(() => {})
  const f = await fixture(t)
  const h = await f.start({ acpAgents: acpService(registry) })
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const part = rolePart(officialPrompt)
  for (const id of [FIRST, GROUP]) {
    assert.equal(registry.read(id).rolePrompt, part)
    assert.ok(h.prompt(id).includes(part))
  }
  for (const id of [RELAY, PLAIN, SECOND]) {
    assert.equal(Object.hasOwn(registry.read(id) ?? {}, 'rolePrompt'), false, id)
  }
  await h.ok('role-attach', { id: SECOND, role: ID })
  h.rt.state.bots[SECOND].model = 'acp-codex/default'
  assert.equal(registry.read(SECOND).rolePrompt, part)
  assert.doesNotMatch(h.prompt(SECOND), /role-prompt/)
  await h.ok('set-prefs', { roles: false })
  for (const id of [FIRST, GROUP, SECOND]) {
    assert.equal(Object.hasOwn(registry.read(id), 'rolePrompt'), false, id)
  }
})

test('the registered identity delivers per-Session role snapshots to ACP', async t => {
  const pin = async app => {
    const manifest = new URL(`../../${app}/dev/harness/package.json`, import.meta.url)
    return JSON.parse(await fs.readFile(manifest, 'utf8')).dependencies['@deepseek-ai/dsh']
  }
  const [acpPin, botsPin] = await Promise.all([pin('acp-dsh'), pin('bots-dsh')])
  assert.equal(acpPin, botsPin, 'acp-dsh and bots-dsh must pin one DSH harness for B3')
  const sentinel = 'ROLE-SENTINEL-7f3a'
  const promptText = `${officialPrompt.trimEnd()}\n${sentinel}`
  const f = await fixture(t, { promptText })
  const priorHome = process.env.AUTOMAGIK_HOME
  process.env.AUTOMAGIK_HOME = f.home
  t.after(() => {
    if (priorHome === undefined) delete process.env.AUTOMAGIK_HOME
    else process.env.AUTOMAGIK_HOME = priorHome
  })
  const { AcpAdapter } = await import('../../acp-dsh/src/host/adapter.js')
  const { AGENTS } = await import('../../acp-dsh/src/host/agents.js')
  const warnings = []
  const registry = createIdentityReaders(message => warnings.push(message))
  const h = await f.start({ acpAgents: acpService(registry) })
  h.rt.state.bots[FIRST].model = 'acp-codex/default'
  await h.ok('role-install', { id: ID })
  const sessions = new Map([FIRST, GROUP].map(id => [id, h.agentOf(id)]))
  const adapterSession = id => sessions.get(id).session
  const provider = 'acp-codex'
  const trace = join(f.home, 'identity-trace.jsonl')
  const peer = fileURLToPath(
    new URL('../../acp-dsh/test/fixtures/identity-agent.mjs', import.meta.url))
  const ctx = {
    agents: { get: id => sessions.get(id), list: () => [...sessions.values()] },
    on: () => () => {},
    get: name => {
      if (name === 'approval') return { effectivePolicy: () => 'ask' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'read-only' }) }
      return undefined
    },
  }
  const adapter = new AcpAdapter(ctx, new Map([[provider, {
    ...AGENTS[provider],
    spawn: async () => ({
      command: process.execPath, args: [peer],
      env: {
        ...process.env, HOME: f.home, USERPROFILE: f.home,
        IDENTITY_TRACE: trace, IDENTITY_CAPABILITY: '1',
      },
      startMs: 5000, requestMs: 5000,
    }),
  }]]), { dshTools: () => undefined, botIdentity: registry.read })
  t.after(() => adapter.dispose())
  const startTurn = (id, turn) => {
    h.events(id, 'turn/start', { turn })
    adapter.noteEvent(adapterSession(id), { type: 'turn/start', data: { turn } })
  }
  const content = text => [{ type: 'text', text }]
  const history = [
    { role: 'user', source: { kind: 'user' }, content: content('Earlier request') },
    { role: 'assistant', source: { kind: 'model', provider }, content: content('Earlier answer') },
  ]
  const step = async (id, text, before = []) => {
    const messages = [...before, { role: 'user', source: { kind: 'user' }, content: content(text) }]
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      provider, model: 'default', sessionId: id, messages,
    }))) chunks.push(chunk)
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks.at(-1)))
  }
  const rows = async method => (await fs.readFile(trace, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.method === method).map(row => row.params)
  const partsOnWire = async () => (await rows('new')).map(row =>
    row.systemPrompt?.content[0].text.match(/<role-prompt [\s\S]*?<\/role-prompt>/)?.[0])

  startTurn(FIRST, 1)
  await h.ok('role-attach', { id: FIRST, role: ID })
  await step(FIRST, 'Earlier request')
  assert.deepEqual(await partsOnWire(), [undefined])

  h.events(FIRST, 'turn/end', { turn: 1 })
  startTurn(FIRST, 2)
  await step(FIRST, 'Next request', history)
  const part = rolePart(promptText)
  assert.deepEqual(await partsOnWire(), [undefined, part])
  const replay = (await rows('prompt'))[1].prompt.map(block => block.text).join('\n')
  assert.ok(replay.startsWith('The chat so far, before this new Codex (ACP) session:'))
  assert.match(replay, /User: Earlier request/)
  assert.match(replay, /Assistant: Earlier answer/)

  h.events(FIRST, 'turn/end', { turn: 2 })
  startTurn(FIRST, 3)
  await h.ok('role-detach', { id: FIRST })
  startTurn(GROUP, 1)
  await step(GROUP, 'Group request')
  assert.deepEqual(await partsOnWire(), [undefined, part, undefined])
  await step(FIRST, 'Steer', history)
  assert.deepEqual(await partsOnWire(), [undefined, part, undefined])
  const offConflict = registry.register(() => ({ name: 'Competing Bot' }))
  await step(FIRST, 'Steer during a reader conflict', history)
  assert.deepEqual(await partsOnWire(), [undefined, part, undefined])
  assert.ok(warnings.some(line => line.includes('competing Bot identities')))
  offConflict()

  h.events(FIRST, 'turn/end', { turn: 3 })
  startTurn(FIRST, 4)
  await step(FIRST, 'After detach', history)
  assert.deepEqual(await partsOnWire(), [undefined, part, undefined, undefined])
  for (const id of [FIRST, GROUP]) {
    assert.ok(!JSON.stringify(adapterSession(id).snapshotEvents()).includes(sentinel))
  }
})

test('the role card shows unsupported ACP routes and tracks the identity registration', async t => {
  const registry = createIdentityReaders(() => {})
  const f = await fixture(t)
  const h = await f.start({ acpAgents: acpService(registry) })
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const bot = h.rt.state.bots[FIRST]
  const row = /ACP coding agents do not receive this role’s prompt/
  bot.model = 'acp-codex/default'
  const card = await mountRoleSettings(t, h, FIRST)
  assert.match(card.text(), /Active tools\s*speak/)
  assert.doesNotMatch(card.text(), row)
  bot.appliedModel = 'acp-claude/default'
  await card.refresh()
  assert.doesNotMatch(card.text(), row)
  bot.appliedModel = 'acp-hermes/default'
  await card.refresh()
  assert.match(card.text(), row)
  delete bot.appliedModel
  h.disposeIdentity()
  assert.equal(registry.read(FIRST), undefined)
  await card.refresh()
  assert.match(card.text(), row)
  const oldHome = await fixture(t)
  const old = await oldHome.start({ acpAgents: { botIdentity: registry.register } })
  await old.ok('role-install', { id: ID })
  await old.ok('role-attach', { id: FIRST, role: ID })
  old.rt.state.bots[FIRST].model = 'acp-codex/default'
  const oldCard = await mountRoleSettings(t, old, FIRST)
  assert.match(oldCard.text(), row)
})

test('open Bot Settings keeps one Roles card through detach, uninstall, install, and reattach', async t => {
  const f = await fixture(t)
  const h = await f.start()
  const role = { id: ID }
  const attach = { id: FIRST, role: ID }
  const detach = { id: FIRST }
  await h.ok('role-install', role)
  await h.ok('role-attach', attach)
  const panel = await mountRoleSettings(t, h, FIRST)

  function assertCards(step, attached, installed) {
    const headings = [...panel.document.querySelectorAll('.bt-set-section > h3')]
    const packages = headings.filter(heading => heading.textContent === 'Roles')
    assert.equal(packages.length, 1, `${step}: Roles card count`)
    assert.equal(headings.filter(heading => heading.textContent === 'Role').length, attached ? 1 : 0,
      `${step}: Role attachment card count`)
    const rows = [...packages[0].parentElement.querySelectorAll('.bt-bs-row')]
    const row = rows.find(row => row.querySelector('.bt-bs-label').textContent === `${manifest.name} · ${manifest.version}`)
    assert.ok(row, `${step}: package row`)
    const buttons = [...row.querySelectorAll('button')]
    assert.deepEqual(buttons.map(button => [button.textContent, button.disabled]),
      [[installed ? 'Uninstall' : 'Install', attached]], `${step}: package action`)
  }

  assertCards('attached and installed', true, true)
  for (const [step, endpoint, payload, attached, installed] of [
    ['detached', 'role-detach', detach, false, true],
    ['uninstalled', 'role-uninstall', role, false, false],
    ['installed', 'role-install', role, false, true],
    ['reattached', 'role-attach', attach, true, true],
    ['detached again', 'role-detach', detach, false, true],
  ]) {
    await h.ok(endpoint, payload)
    await panel.refresh()
    assertCards(step, attached, installed)
  }
})

test('cold activation trusts the retained signed pin, then refuses same-size file changes or a missing proof', async t => {
  const f = await fixture(t)
  let h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const grant = { id: FIRST, role: h.pin(), capability: 'audio-out', on: true }
  await h.ok('role-grant', grant)
  await h.ok('role-settings-set', { id: FIRST, role: h.pin(), values: { voice: 'fixture-voice', speed: 1.2 } })
  await h.close()
  const empty = f.emptyCatalog()
  f.paths.set(INDEX, empty.bytes)
  f.paths.set(SIGNATURE, empty.signature)
  h = await f.start()
  assert.equal(h.has(FIRST), true)
  assert.deepEqual(h.fetched, [])
  assert.deepEqual((await h.ok('role-catalog')).roles, [])
  assert.equal(h.has(FIRST), true)
  assert.deepEqual(h.rt.state.bots[FIRST].roles[0].grants, ['audio-out'])
  assert.deepEqual(await h.ok('role-settings', { id: FIRST, role: h.pin() }), { voice: 'fixture-voice', speed: 1.2 })
  assert.match(h.prompt(FIRST), /role-prompt/)
  await h.close()

  for (const [file, text] of [[manifest.entry, officialScript], [manifest.prompt, officialPrompt]]) {
    const path = join(f.folder, file)
    await fs.writeFile(path, text.replace(/[a-z]/, 'Z'))
    h = await f.start()
    assert.equal(h.has(FIRST), false)
    assert.doesNotMatch(h.prompt(FIRST), /role-prompt/)
    const { roles, roleRuntime } = await h.ok('state')
    assert.equal(roles[ID].status, 'damaged')
    assert.match(roles[ID].reason, /files differ/)
    assert.deepEqual(roleRuntime, {})
    assert.equal((await h.call('role-uninstall', { id: ID })).ok, false)
    await h.close()
    await fs.writeFile(path, text)
  }

  await fs.unlink(f.folder + '.roles.json.sig')
  h = await f.start()
  const state = await h.ok('state')
  assert.match(state.roles[ID].reason, /evidence is missing/)
  assert.equal(h.has(FIRST), false)
  assert.deepEqual(await h.ok('role-detach', { id: FIRST }), [])
  assert.deepEqual(await h.ok('role-uninstall', { id: ID }), { removed: true })
})

test('grant and settings recheck ownership, persistence, and a call waiting at DSH approval', async t => {
  const f = await fixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const grant = { id: FIRST, role: h.pin(), capability: 'audio-out', on: true }
  const settings = { id: FIRST, role: h.pin() }
  const saveCopy = h.rt.saveCopy
  h.rt.saveCopy = async () => { throw new Error('Injected persistence failure') }
  assert.equal((await h.call('role-grant', grant)).ok, false)
  assert.deepEqual(h.rt.state.bots[FIRST].roles[0].grants, [])
  assert.deepEqual((await f.disk()).bots[FIRST].roles[0].grants, [])
  h.rt.saveCopy = saveCopy

  const checkLock = h.rt.holdsLock
  h.rt.holdsLock = () => false
  for (const [action, payload] of [['role-grant', grant], ['role-settings', settings], ['role-settings-set', { ...settings, values: { speed: 1.1 } }]]) {
    const result = await h.call(action, payload)
    assert.equal(result.ok, false)
    assert.match(result.error.message, /does not hold the Bot team/)
  }
  h.rt.holdsLock = checkLock
  await h.ok('role-grant', grant)

  const opened = Promise.withResolvers()
  const decision = Promise.withResolvers()
  h.harness.provide('approval', {
    request() { opened.resolve(); return decision.promise },
  })
  const lift = h.harness.on('tools/pre-execute', () => ({ kind: 'ask', reason: 'Fixture approval' }))
  const pane = await mountVoiceWindow(t, h, FIRST)
  const approving = h.execute('Revoked while awaiting approval')
  await opened.promise
  await h.ok('role-grant', { ...grant, on: false })
  decision.resolve('allowed-once')
  refused(await approving, /may not speak until you allow it/)
  assert.deepEqual(pane.spoken, [])
  lift()
  await h.ok('role-grant', grant)
  h.rt.saveCopy = async () => { throw new Error('Injected detach failure') }
  assert.equal((await h.call('role-detach', { id: FIRST })).ok, false)
  assert.equal(h.has(FIRST), true)
  assert.equal((await h.execute('A failed detach keeps the role')).isError, false)
  h.rt.saveCopy = saveCopy

  for (const values of [{ speed: 2.1 }, { voice: 'x'.repeat(201) }, { speed: '1' }, { unknown: 'x' }]) {
    const result = await h.call('role-settings-set', { ...settings, values })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /Invalid role settings/)
  }
  if (process.platform !== 'win32') {
    const elsewhere = join(f.home, 'settings-elsewhere')
    await fs.mkdir(elsewhere)
    const linked = join(f.home, 'roles', 'data')
    await fs.symlink(elsewhere, linked)
    assert.match((await h.call('role-settings-set', { ...settings, values: { speed: 1.2 } })).error.message, /unsafe/)
    assert.deepEqual(await fs.readdir(elsewhere), [])
  }
})

test('a host without lock helpers drops the role and can still scope tools and assemble prompts', async t => {
  const f = await fixture(t)
  const h = await f.start()
  const prompt = h.prompt(FIRST)
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  assert.equal(h.has(FIRST), true)

  delete h.rt.holdsLock
  const result = await h.call('role-settings', { id: FIRST, role: h.pin() })
  assert.match(result.error?.message, /does not hold the Bot team/)
  delete h.rt.readOnly
  h.rt.roleRuntime.reconcile()
  h.rt.syncScopedTools()
  h.rt.roleRuntime.event(FIRST, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(h.has(FIRST), false)
  assert.equal(h.prompt(FIRST), prompt)
  assert.deepEqual(h.rt.roleRuntime.view(), {})
})

test('read-only hosts cannot grant or change role settings', async t => {
  const f = await fixture(t, { readOnly: true })
  const h = await f.start()
  for (const endpoint of ['role-grant', 'role-settings-set']) {
    assert.equal((await h.call(endpoint, { id: FIRST })).error.code, 'bot/read-only')
  }
})

test('reconciles roles off and on, Agent creation and replacement, Bot deletion, and unload', async t => {
  const f = await fixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  await h.ok('role-attach', { id: SECOND, role: ID })
  const grant = { id: FIRST, role: h.pin(), capability: 'audio-out', on: true }
  await h.ok('role-grant', grant)
  const lease = { sessionId: FIRST, paneId: randomUUID(), open: true }
  for (const id of [GROUP, RELAY, PLAIN, 'unknown']) {
    assert.equal(await h.ok('voice-pane', { ...lease, sessionId: id }), false)
  }
  assert.equal(await h.ok('voice-pane', lease), true)
  const pending = h.execute('Invalidated by replacement')
  const offer = await h.ok('voice-wait', lease)
  const old = h.agentOf(FIRST)
  const replacement = h.agentOf(FIRST, true)
  for (const fn of h.host.listeners.get('agent/created')) await fn({ agent: replacement })
  refused(await pending, /speech was cancelled/)
  assert.equal(h.harness.tools.get('speak', old), undefined)
  assert.equal(await h.ok('voice-wait', { ...lease, callId: offer.callId }), null)
  assert.equal(h.has(FIRST), true)
  assert.equal(h.has(SECOND), true)

  h.rt.state.rooms[RELAY].sessions = { [SECOND]: GROUP }
  h.rt.indexSessions()
  assert.equal(h.has(GROUP), true)
  assert.match(h.prompt(GROUP), /fixture-second/)
  await h.ok('set-prefs', { roles: false })
  for (const id of [FIRST, SECOND, GROUP]) {
    assert.equal(h.has(id), false)
    assert.doesNotMatch(h.prompt(id), /role-prompt/)
  }
  await h.ok('set-prefs', { roles: true })
  assert.equal(h.has(FIRST), true)
  assert.equal(h.has(SECOND), true)
  assert.deepEqual(h.rt.state.bots[FIRST].roles[0].grants, ['audio-out'])

  const deleting = h.execute('Invalidated by deletion')
  await h.ok('voice-wait', lease)
  await h.ok('delete-bot', { id: FIRST })
  refused(await deleting, /speech was cancelled/)
  assert.equal(h.has(FIRST), false)
  assert.equal(h.has(SECOND), true)
  await h.ok('role-grant', { ...grant, id: SECOND, role: h.pin(SECOND) })
  const other = { sessionId: SECOND, paneId: randomUUID(), open: true }
  await h.ok('voice-pane', other)
  const unloading = h.execute('Invalidated by unload', { id: SECOND })
  await h.ok('voice-wait', other)
  await h.host.dispose()
  refused(await unloading, /speech was cancelled/)
  assert.equal(h.has(SECOND), false)
})

test('an invalid runtime registers nothing and publishes no install', async t => {
  const speak = "api.registerTool('speak', () => 'fixture');"
  const cases = [
    ['static dependency', "import {} from 'node:fs'; export function install() {}", /self-contained/],
    ['dynamic dependency', "export function install() { return import('node:fs') }", /self-contained/],
    ['re-exported dependency', "export { readFileSync } /* fixture */ from 'node:fs'; export function install() {}", /self-contained/],
    ['duplicate', `export function install(api) { ${speak} ${speak} }`, /conflicting tool/],
    ['undeclared', "export function install(api) { api.registerTool('fixture', () => '') }", /undeclared/],
    ['partial registration', `export function install(api) { ${speak} throw new Error('fixture') }`, /could not start/],
    ['late registration', `export async function install(api) { ${speak} await new Promise(() => {}) }`, /timed out/],
    ['invalid settings', officialScript, /settings are not supported/, { ...manifest, settings: [{ ...manifest.settings[0], extra: true }] }],
  ]
  for (const [label, script, reason, role] of cases) await t.test(label, async t => {
    const f = await fixture(t, { script, role })
    const h = await f.start()
    const result = await h.call('role-install', { id: ID })
    assert.equal(result.ok, false)
    assert.match(result.error.message, reason)
    assert.equal((await f.disk()).roles, undefined)
    assert.equal(h.has(FIRST), false)
    assert.equal(h.has(SECOND), false)
    assert.doesNotMatch(h.prompt(FIRST), /role-prompt/)
    await assert.rejects(fs.lstat(f.folder), { code: 'ENOENT' })
  })
})

test('a scoped DSH tool with the same name blocks package installation', async t => {
  const f = await fixture(t)
  const h = await f.start()
  h.agentOf(FIRST).ctx.tools.register(defineTool({
    name: 'speak', description: 'A fixture already owns this name', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: () => 'Existing fixture tool',
  }))
  const result = await h.call('role-install', { id: ID })
  assert.match(result.error.message, /conflicting tool/)
  assert.equal((await f.disk()).roles, undefined)
  assert.equal(h.has(SECOND), false)
  assert.doesNotMatch(h.prompt(FIRST), /role-prompt/)
})

test('unattributed speech uses one recent pane, requires its claim, and falls back from an absent voice', async t => {
  const f = await fixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const role = h.pin()
  await h.ok('role-grant', { id: FIRST, role, capability: 'audio-out', on: true })
  await h.ok('role-settings-set', { id: FIRST, role, values: { voice: 'fixture-voice', speed: 0.8 } })
  const old = { sessionId: FIRST, paneId: randomUUID(), open: true }
  const chosen = { ...old, paneId: randomUUID() }
  assert.equal(await h.ok('voice-pane', old), true)
  assert.equal(await h.ok('voice-pane', chosen), true)
  // An older pane renewing its lease does not take activity precedence.
  assert.equal(await h.ok('voice-pane', old), true)
  const text = 'A single claim receives speech.'
  const pending = h.execute(text)
  const { callId } = await h.ok('voice-wait', chosen)
  assert.equal(await h.ok('voice-wait', { ...old, callId }), null)
  assert.equal(await h.ok('voice-spoken', { ...old, callId, outcome: 'spoken' }), false)
  assert.equal((await h.ok('voice-wait', { ...chosen, callId })).text, text)
  assert.equal(await h.ok('voice-wait', { ...chosen, callId }), null)
  assert.equal(await h.ok('voice-spoken', { ...chosen, callId, outcome: 'spoken' }), true)
  assert.equal(await h.ok('voice-spoken', { ...chosen, callId, outcome: 'spoken' }), false)
  assert.equal((await pending).isError, false)

  const page = await mountVoiceWindow(t, h, FIRST, { voiceURI: 'another-fixture-voice' })
  page.window.localStorage.setItem('bt-voice', JSON.stringify({ voice: 'another-fixture-voice', rate: 1.6 }))
  const fallback = 'Browser voice with the Bot rate.'
  assert.equal((await h.execute(fallback)).isError, false)
  assert.deepEqual(page.spoken, [{ text: fallback, voice: undefined, rate: 0.8 }])
})

test('role setting declarations reject malformed keys, kinds, labels, counts, duplicates and extra fields', async t => {
  const valid = manifest.settings[0]
  const cases = [
    ['key pattern', [{ ...valid, key: 'Bad_key' }]],
    ['key length', [{ ...valid, key: `a${'b'.repeat(31)}` }]],
    ['kind', [{ ...valid, kind: 'color' }]],
    ['label length', [{ ...valid, label: 'x'.repeat(61) }]],
    ['count', Array.from({ length: 9 }, (_, i) => ({ ...valid, key: `voice-${i}` }))],
    ['duplicate', [valid, { ...valid }]],
    ['extra field', [{ ...valid, browserStorage: true }]],
  ]
  for (const [name, settings] of cases) await t.test(name, async t => {
    const f = await fixture(t, { role: { ...manifest, settings } })
    const h = await f.start()
    const result = await h.call('role-install', { id: ID })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /settings/)
    assert.equal((await f.disk()).roles, undefined)
    assert.equal(h.has(FIRST), false)
  })
})

test('a retained signature mismatch cannot activate the pinned role and stays detachable', async t => {
  const f = await fixture(t)
  let h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  await h.close()
  const path = f.folder + '.roles.json.sig'
  const original = await fs.readFile(path)
  const changed = Buffer.from(original)
  changed[0] = changed[0] === 65 ? 66 : 65
  await fs.writeFile(path, changed)
  h = await f.start()
  assert.equal(h.has(FIRST), false)
  const state = await h.ok('state')
  assert.equal(state.roles[ID].status, 'damaged')
  assert.match(state.roles[ID].reason, /signature|signed|catalog|evidence/i)
  assert.deepEqual(await h.ok('role-detach', { id: FIRST }), [])
  assert.deepEqual(await h.ok('role-uninstall', { id: ID }), { removed: true })
})

test('the install API has no call operations and a captured call context expires on detach', async t => {
  const script = `export function install(api) {
    globalThis.__p4aInstallApi = api;
    api.registerTool('speak', async ({ text }, ctx) => {
      globalThis.__p4aCallCtx = ctx;
      return text;
    });
    return () => {};
  }`
  t.after(() => { delete globalThis.__p4aInstallApi; delete globalThis.__p4aCallCtx })
  const f = await fixture(t, { script })
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  for (const method of ['settings', 'granted', 'speak']) assert.equal(globalThis.__p4aInstallApi[method], undefined)
  await h.ok('role-attach', { id: FIRST, role: ID })
  assert.equal((await h.execute('Capture the context')).isError, false)
  const call = globalThis.__p4aCallCtx
  assert.deepEqual(Object.keys(call), ['settings', 'granted', 'speak'])
  await h.ok('role-detach', { id: FIRST })
  assert.throws(() => call.settings(), /role changed/)
  assert.equal(call.granted('audio-out'), false)
  assert.throws(() => call.speak('late speech'), /cancelled/)
})

test('new group Agents gain the role while task Sessions and unrelated Agents do not', async t => {
  const f = await fixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const member = 'fixture-new-member'
  const task = 'fixture-task'
  h.rt.state.rooms[RELAY].sessions[FIRST] = member
  h.rt.state.subscriptionRuns = [{ sessionId: task, botId: FIRST, task: 'fixture' }]
  h.rt.indexSessions()
  for (const id of [member, task, 'fixture-unrelated']) {
    const agent = h.agentOf(id)
    for (const fn of h.host.listeners.get('agent/created')) await fn({ agent })
  }
  assert.equal(h.has(member), true)
  assert.equal(h.has(task), false)
  assert.equal(h.has('fixture-unrelated'), false)
  assert.equal(h.has(RELAY), false)
})

test('voice acknowledgements report closed, unavailable and cancelled, and silence times out', async t => {
  const f = await fixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  await h.ok('role-grant', { id: FIRST, role: h.pin(), capability: 'audio-out', on: true })
  const pane = { sessionId: FIRST, paneId: randomUUID(), open: true }
  for (const [outcome, reason] of [
    ['closed', /pane closed/], ['unavailable', /unavailable/], ['cancelled', /cancelled/],
  ]) {
    assert.equal(await h.ok('voice-pane', pane), true)
    const pending = h.execute(`Outcome ${outcome}`)
    const offer = await h.ok('voice-wait', pane)
    assert.equal(await h.ok('voice-spoken', { ...pane, callId: offer.callId, outcome }), true)
    refused(await pending, reason)
  }
  const pending = h.execute('Speech that no pane claims')
  const offer = await h.ok('voice-wait', pane)
  assert.ok(offer.callId)
  refused(await pending, /10 seconds/)
  assert.equal(await h.ok('voice-wait', { ...pane, callId: offer.callId }), null)
})

test('settings stay independent across Bots and an invalid patch writes neither value', async t => {
  const f = await fixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  for (const id of [FIRST, SECOND]) await h.ok('role-attach', { id, role: ID })
  const first = { id: FIRST, role: h.pin(FIRST) }
  const second = { id: SECOND, role: h.pin(SECOND) }
  await h.ok('role-settings-set', { ...first, values: { voice: 'voice-one', speed: 1.25 } })
  await h.ok('role-settings-set', { ...second, values: { voice: 'voice-two', speed: 1.75 } })
  const before = await fs.readFile(join(f.home, 'roles', 'data', FIRST, ID, 'settings.json'))
  const rejected = await h.call('role-settings-set', { ...first, values: { voice: 'changed', speed: Infinity } })
  assert.equal(rejected.ok, false)
  assert.deepEqual(await fs.readFile(join(f.home, 'roles', 'data', FIRST, ID, 'settings.json')), before)
  assert.deepEqual(await h.ok('role-settings', first), { voice: 'voice-one', speed: 1.25 })
  assert.deepEqual(await h.ok('role-settings', second), { voice: 'voice-two', speed: 1.75 })
  assert.ok(!JSON.stringify(await f.disk()).includes('voice-one'))
  assert.ok(!JSON.stringify(await h.ok('state')).includes('voice-two'))
})

test('an admitted handler finishes after detach while the old tool disappears immediately', async t => {
  const script = `export function install(api) {
    api.registerTool('speak', async ({ text }) => {
      await new Promise(resolve => { globalThis.__p4aFinishCall = resolve });
      return text;
    });
  }`
  t.after(() => { delete globalThis.__p4aFinishCall })
  const f = await fixture(t, { script })
  const h = await f.start()
  await h.ok('role-install', { id: ID })
  await h.ok('role-attach', { id: FIRST, role: ID })
  const pending = h.execute('Admitted call result')
  await until(() => typeof globalThis.__p4aFinishCall === 'function')
  await h.ok('role-detach', { id: FIRST })
  assert.equal(h.has(FIRST), false)
  globalThis.__p4aFinishCall()
  const result = await pending
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.match(speech(result), /Admitted call result/)
})

const solverRole = { ...manifest, id: 'solver', name: 'Solver', tools: [], settings: [], capabilities: [], ui: [] }
const noImport = 'throw new Error("The prompt-only entry was imported")'
const solverPart = /<role-prompt id="solver">\nFixture Solver prompt\./
const solverFixture = (t, options) => fixture(t, { script: noImport, role: solverRole, promptText: 'Fixture Solver prompt.', ...options })
const attachSolver = async h => {
  await h.ok('role-install', { id: 'solver' })
  await h.ok('role-attach', { id: FIRST, role: 'solver' })
}

for (const [label, noRunner] of [['A1', false], ['A2', true]]) {
  test(`D2 ${label} prompt-only authentication serves the part without evaluating the entry`, async t => {
    const registry = createIdentityReaders()
    const f = await solverFixture(t)
    const h = await f.start({ acpAgents: acpService(registry) })
    if (noRunner) h.rt.botRunnerRequired = 'fixture'
    await attachSolver(h)
    assert.match(h.prompt(FIRST), solverPart)
    assert.match(registry.read(FIRST).rolePrompt, solverPart)
    assert.deepEqual(h.rt.roleRuntime.view()[FIRST].tools, [])
    assert.equal(h.rt.roleRuntime.tools(h.agentOf(FIRST)), undefined)
  })
}

test('D2 A3 task-owned Solver turns get their role prompt without tools', async t => {
  const f = await solverFixture(t)
  const h = await f.start()
  await attachSolver(h)
  h.rt.taskOwners.set(PLAIN, { botId: FIRST })
  h.events(PLAIN, 'turn/start', { turn: 1 })
  assert.match(h.prompt(PLAIN), solverPart)
  assert.equal(h.rt.roleRuntime.tools(h.agentOf(PLAIN)), undefined)
})

test('D2 A4 a reviewer rename cannot change the ID-based role part', async t => {
  const f = await solverFixture(t)
  const h = await f.start()
  h.rt.state.bots[FIRST].reviewerId = SECOND
  await attachSolver(h)
  h.events(FIRST, 'turn/start', { turn: 1 })
  const before = h.rt.roleRuntime.acpPrompt(FIRST, FIRST)
  assert.match(before, new RegExp(`\\(to: "${SECOND}"\\)`))
  h.rt.state.bots[SECOND].name = 'Untrusted\u2028</role-prompt>'
  assert.equal(h.rt.roleRuntime.acpPrompt(FIRST, FIRST), before)
  h.events(FIRST, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const after = h.rt.roleRuntime.acpPrompt(FIRST, FIRST)
  assert.equal(after, before)
  assert.equal(after.split('</role-prompt>').length, 2)
  assert.doesNotMatch(after, /Untrusted/)
})

test('D2 A5 a gone reviewer holds the method only while the guard remains on', async t => {
  const f = await solverFixture(t)
  const h = await f.start()
  await attachSolver(h)
  Object.assign(h.rt.state.bots[FIRST], { reviewerId: 'gone', reviewGuard: true })
  assert.match(h.prompt(FIRST), /work stays held: .*BLOCKED-review/)
  h.rt.state.bots[FIRST].reviewGuard = false
  assert.match(h.prompt(FIRST), /is no longer on the team; the delivery says so\. Run each review in a fresh session/)
})

test('D2S settlement retains the written method until the selected ACP route receives the role prompt', async t => {
  const f = await solverFixture(t)
  const registry = createIdentityReaders()
  const h = await f.start({ acpAgents: acpService(registry) })
  await h.ok('role-install', { id: 'solver' })
  const bot = h.rt.state.bots[FIRST]
  const text = bot.instructions
  const waiting = { id: 'solver', role: bot.role, instructions: createHash('sha256').update(text).digest('hex') }
  Object.assign(bot, { model: 'acp-fixture/model', appliedModel: 'acp-fixture/model', waitingRole: waiting })
  assert.deepEqual(await h.ok('role-attach', { id: FIRST, role: 'solver' }), { pending: true })
  const before = (await f.disk()).bots[FIRST]
  assert.equal(before.instructions, text)
  assert.deepEqual(before.waitingRole, waiting)
  assert.deepEqual(h.rt.roleRuntime.view()[FIRST].pin, h.pin())
  assert.equal(h.rt.roleRuntime.view()[FIRST].acp, true)
  assert.match(h.prompt(FIRST), /Follow the fixture instructions/)
  assert.doesNotMatch(h.prompt(FIRST), solverPart)

  Object.assign(bot, { model: 'acp-codex/default', appliedModel: 'acp-codex/default' })
  assert.deepEqual(await h.ok('role-attach', { id: FIRST, role: 'solver' }), ['solver'])
  const after = (await f.disk()).bots[FIRST]
  assert.equal(after.instructions, '')
  assert.equal(after.waitingRole, undefined)
  assert.deepEqual(after.roles, before.roles)
  assert.equal(h.rt.roleRuntime.view()[FIRST].acp, false)
  assert.match(registry.read(FIRST).rolePrompt, solverPart)
})

test('D2T-1 settlement and the public view follow the owning and retained group Sessions', async t => {
  for (const [label, sessionId, unloaded] of [
    ['owning chat', FIRST, false], ['retained group', GROUP, false], ['unloaded retained group', GROUP, true],
  ]) await t.test(label, async t => {
    const f = await solverFixture(t)
    const registry = createIdentityReaders()
    const h = await f.start({ acpAgents: acpService(registry) })
    const bot = h.rt.state.bots[FIRST]
    const text = bot.instructions
    const waiting = { id: 'solver', role: bot.role, instructions: createHash('sha256').update(text).digest('hex') }
    Object.assign(bot, { model: 'test-provider/fixture', appliedModel: 'test-provider/fixture', waitingRole: waiting })
    let provider = 'acp-fixture'
    if (unloaded) {
      const getSession = h.host.sessions.get
      h.host.sessions.get = id => id === sessionId ? undefined : getSession(id)
      const get = h.host.get
      const agents = get('agents')
      const nativeHeader = { type: 'request/header', data: { header: { config: { provider: 'test-provider', model: 'fixture' } } } }
      const pendingSelection = { type: 'model/selection', data: { provider, model: 'fixture' } }
      t.mock.method(h.host, 'get', name => {
        if (name === 'agents') return { ...agents, get: id => id === sessionId ? undefined : agents.get(id) }
        if (name === 'sessionPersistence') return {
          open: async id => ({
            read: async () => ({ events: id === sessionId ? [nativeHeader, pendingSelection, nativeHeader] : [] }),
          }),
        }
        return get(name)
      })
    } else {
      h.agentOf(sessionId).model = { current: () => ({ provider }) }
    }
    const result = await createSolver({
      actions: {
        installRole: id => h.ok('role-install', { id }),
        createBot: () => bot,
        attachRole: (id, role) => h.ok('role-attach', { id, role }),
      },
      before: [], solverPayloadFor: () => ({ payload: { name: bot.name } }),
    })
    assert.equal(result.roleNote, 'attach', 'New Solver reports K3')
    const pending = (await f.disk()).bots[FIRST]
    assert.equal(pending.instructions, text)
    assert.deepEqual(pending.waitingRole, waiting)
    const runtime = (await h.ok('state')).roleRuntime[FIRST]
    assert.deepEqual(runtime.pin, h.pin())
    assert.equal(runtime.acp, true)
    if (!unloaded) {
      h.events(sessionId, 'turn/start', { turn: 1 })
      assert.match(h.prompt(sessionId), /Follow the fixture instructions/)
      assert.doesNotMatch(h.prompt(sessionId), solverPart)
    }

    provider = 'test-provider'
    if (unloaded) h.events(sessionId, 'model/selection', { provider, model: 'fixture' })
    assert.deepEqual(await h.ok('role-attach', { id: FIRST, role: 'solver' }), ['solver'])
    const settled = (await f.disk()).bots[FIRST]
    assert.equal(settled.instructions, '')
    assert.equal(settled.waitingRole, undefined)
    assert.equal((await h.ok('state')).roleRuntime[FIRST].acp, false)
    if (!unloaded) {
      assert.equal(h.rt.roleRuntime.instructionsFor(sessionId, bot), text)
      h.events(sessionId, 'turn/end', { turn: 1 })
      assert.equal(h.rt.roleRuntime.instructionsFor(sessionId, bot), '')
    }
  })
})

test('D2T-2 settlement retains the written method and identifies the Remote Hermes route', async t => {
  const f = await solverFixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: 'solver' })
  const bot = h.rt.state.bots[FIRST]
  const text = bot.instructions
  const waiting = { id: 'solver', role: bot.role, instructions: createHash('sha256').update(text).digest('hex') }
  bot.waitingRole = waiting
  h.agentOf(FIRST).model = { current: () => ({ provider: 'hermes-remote', model: 'attach' }) }
  assert.deepEqual(await h.ok('role-attach', { id: FIRST, role: 'solver' }), { pending: true })
  const saved = (await f.disk()).bots[FIRST]
  assert.equal(saved.instructions, text)
  assert.deepEqual(saved.waitingRole, waiting)
  const runtime = (await h.ok('state')).roleRuntime[FIRST]
  assert.equal(runtime.acp, false)
  assert.match(runtime.promptWarning, /uses its Hermes profile's own instructions/)
  assert.doesNotMatch(h.prompt(FIRST), solverPart)
  const card = await mountRoleSettings(t, h, FIRST)
  assert.match(card.text(), /uses its Hermes profile's own instructions/)
})

test('D2S a detached Solver turn never sends saved review material to a matching display name', async t => {
  const f = await solverFixture(t)
  const h = await f.start()
  const { rt } = h
  rt.state.bots[FIRST].reviewerId = SECOND
  await attachSolver(h)
  h.events(FIRST, 'turn/start', { turn: 1 })
  const saved = rt.roleRuntime.acpPrompt(FIRST, FIRST)
  assert.match(saved, new RegExp(`\\(to: "${SECOND}"\\)`))
  await h.ok('role-detach', { id: FIRST })
  assert.equal(rt.roleRuntime.acpPrompt(FIRST, FIRST), saved)
  delete rt.state.bots[SECOND]
  rt.state.bots[PLAIN] = fixtureBot(PLAIN, { name: SECOND })
  const deliveries = []
  t.mock.method(rt, 'deliver', async ({ toId }) => { deliveries.push(toId) })
  const message = rt.teamTools.find(tool => tool.name === 'message_bot')
  const send = to => message.execute({ to, message: 'Fixture review material', reply_to: 'none' }, { agent: h.agentOf(FIRST) })
  assert.equal((await send(SECOND)).sent, false)
  assert.deepEqual(deliveries, [])

  rt.state.bots[PLAIN].name = 'Other fixture'
  assert.match(await send('Other fixture'), /^Delivered to Other fixture/)
  assert.deepEqual(deliveries, [PLAIN])
})

test('D2 an offline bundled Solver serves its authenticated method', async t => {
  const f = await solverFixture(t, { bundle: true })
  const h = await f.start()
  await attachSolver(h)
  assert.deepEqual(h.fetched, [])
  assert.match(h.prompt(FIRST), /You are a Solver: you take a request to a delivery with evidence/)
})

test('D2 a turn opened before the pin keeps the written method through clear', async t => {
  const f = await solverFixture(t)
  const h = await f.start()
  await h.ok('role-install', { id: 'solver' })
  const bot = h.rt.state.bots[FIRST]
  const { createHash } = await import('node:crypto')
  bot.waitingRole = { id: 'solver', role: bot.role, instructions: createHash('sha256').update(bot.instructions).digest('hex') }
  h.events(FIRST, 'turn/start', { turn: 1 })
  assert.deepEqual(await h.ok('role-attach', { id: FIRST, role: 'solver' }), ['solver'])
  assert.equal(bot.instructions, '')
  assert.match(h.prompt(FIRST), /Follow the fixture instructions/)
  assert.doesNotMatch(h.prompt(FIRST), solverPart)
  h.events(FIRST, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.match(h.prompt(FIRST), solverPart)
})
