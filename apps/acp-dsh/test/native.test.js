// The native-ACP agents (#959): Hermes, Antigravity and omp, whose CLI is itself the ACP server.
// Each runs here as a fake CLI (a script named like the real one that starts the fake agent
// with whatever arguments it got) through the plugin's real wiring and real stdio. No real CLI
// runs, nothing is installed and no model is called.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, Config, flagOf, SERVICE } from '../index.js'
import { MODEL_STATE, withModels } from '../src/host/acp.js'
import { AcpAdapter, NOTICE_KIND, promptOf } from '../src/host/adapter.js'
import { AGENTS, cliIdOf, isNative, launchOf } from '../src/host/agents.js'
import { Catalog } from '../src/host/catalog.js'
import { MODEL_ACCESS_REQUIRED } from '../src/host/names.js'
import { assertLoadable, eventsOf } from './support/bridge-host.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const unixOnly = { skip: process.platform === 'win32' ? 'the fake CLIs use a POSIX shebang' : false }
const NATIVE = Object.keys(AGENTS).filter(id => isNative(AGENTS[id]))
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

// A fake CLI named `name` in `dir`: started with any arguments, it is the fake agent with `env`.
function fakeCli(dir, name, env = {}) {
  const path = join(dir, name)
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')
  writeFileSync(path, `#!/bin/sh\n${exports}\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

const traceOf = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])

// The plugin as DSH runs it, with one Session (`s1`) whose scoped tools and appended rows are kept.
function host(t, { config = {}, clis = {}, cliStore, session } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-native-'))
  const registered = {}
  const routes = { now: [] }
  const services = {}
  const disposers = []
  const appended = []
  const installs = []
  const storeCalls = []
  const logins = []
  const tools = new Map()
  const agent = {
    // `session`: a real DSH Session, for the tests that load its stored log with DSH's reader.
    session: session ?? { id: 's1', header: { cwd: dir }, append: (type, data, options) => { appended.push({ type, data, options }); return { seq: appended.length } } },
    model: { current: () => ({ provider: 'acp-hermes', model: 'default' }) },
    options: { provider: 'acp-hermes' },
    status: 'idle',
    ctx: { tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } } },
  }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.adapter = adapter
        routes.now = [...providers]
        const handle = () => { routes.now = [] }
        handle.replace = (next) => { routes.now = [...next] }
        return handle
      },
      listProviders: () => routes.now.map(id => ({ id, name: id })),
    },
    agents: { get: id => (id === 's1' ? agent : undefined), list: () => [agent] },
    get: name => (name === 'approval' ? { request: async () => 'allowed-once' } : undefined),
    on: () => () => {},
    effect: (fn) => { disposers.push(fn()) },
    provide: (name, service) => { services[name] = service },
    emit: () => {},
  }
  // An adapter store that fails the test if a native agent ever reaches it.
  const store = {
    binOf: (pkg) => { assert.notEqual(pkg, undefined, 'a native agent has no adapter package to look up'); return undefined },
    busy: () => false,
    lastError: () => undefined,
    lastFailure: () => undefined,
    update: async (pkg) => { installs.push(pkg) },
    // The connector's last-known-good and rollback (install.js): recorded, never thrown, because
    // the Session start swallows what these throw.
    stateOf: (pkg) => { storeCalls.push(['stateOf', pkg]); return undefined },
    markGood: (pkg) => { storeCalls.push(['markGood', pkg]) },
    rollback: (pkg) => { storeCalls.push(['rollback', pkg]); return { version: '0.0.1' } },
    dispose: () => {},
  }
  apply(ctx, { claude: false, codex: false, ...config }, {
    store,
    ...(cliStore === undefined ? {} : { cliStore }),
    find: name => clis[name],
    signedIn: async (spec) => { logins.push(spec.key); return undefined },
    catalogHome: join(dir, 'catalog'),
  })
  t.after(() => { for (const fn of disposers) fn(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, ctx, agent, appended, installs, storeCalls, logins, routes, tools, service: services[SERVICE], get adapter() { return registered.adapter } }
}

async function step(adapter, provider, text, { model = 'default', messages = [] } = {}) {
  messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model, sessionId: 's1', messages }))) chunks.push(chunk)
  return chunks
}
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const thoughtIn = chunks => chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
const row = async (h, id) => (await h.service.status()).agents.find(agent => agent.id === id)

test('the table holds Hermes, Antigravity and omp as native rows: a CLI and its ACP arguments, no adapter', () => {
  assert.deepEqual(NATIVE, ['acp-hermes', 'acp-antigravity', 'acp-omp'])
  assert.deepEqual(NATIVE.map(id => [AGENTS[id].key, AGENTS[id].cli, [...AGENTS[id].launch.args]]), [['hermes', 'hermes', ['acp']], ['antigravity', 'agy', ['acp']], ['omp', 'omp', ['acp']]])
  for (const id of NATIVE) {
    const spec = AGENTS[id]
    assert.equal(spec.adapter, undefined)
    assert.equal(spec.cliPackage, undefined)
    assert.match(spec.installUrl, /^https:\/\//)
    assert.match(spec.signInHint, new RegExp(`^${spec.cli} `))
    assert.ok(spec.fallback.some(model => model.id === 'default'))
    // The strict mode, whatever the level: DSH's approval answers what the agent asks.
    for (const level of [{}, { auto: true }, { full: true }, { sandbox: 'read-only' }]) assert.deepEqual(spec.modeFor(level), ['default'])
  }
  assert.equal(isNative(AGENTS['acp-claude']), false)
  assert.equal(isNative(AGENTS['acp-codex']), false)
})

test('launchOf starts a native agent as its CLI with its ACP arguments, and an adapter as node on its bin', () => {
  const native = launchOf(AGENTS['acp-hermes'], '/opt/tools/hermes', { env: { PATH: '/usr/bin' }, stamp: cli => `${cli}@1` })
  assert.deepEqual(native, { command: '/opt/tools/hermes', args: ['acp'], env: { PATH: ['/opt/tools', '/usr/bin'].join(delimiter) }, ready: true, key: 'native /opt/tools/hermes@1' })
  // No store is read for a native agent.
  launchOf(AGENTS['acp-omp'], '/opt/tools/omp', { store: { binOf: () => assert.fail('no adapter store for a native agent') } })
  const store = { binOf: (pkg, bin) => ({ path: `/adapters/${pkg}/${bin}`, version: '1.2.3' }) }
  const adapter = launchOf(AGENTS['acp-claude'], '/bin/claude', { store, node: { command: '/bin/node', env: { ELECTRON_RUN_AS_NODE: '1' } }, cliEnv: { DISABLE_UPDATES: '1' } })
  assert.deepEqual(adapter, {
    command: '/bin/node', args: ['/adapters/@agentclientprotocol/claude-agent-acp/dist/index.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_EXECUTABLE: '/bin/claude' },
    ready: true, version: '1.2.3', key: '/adapters/@agentclientprotocol/claude-agent-acp/dist/index.js /bin/claude',
  })
  assert.deepEqual(launchOf(AGENTS['acp-codex'], '/bin/codex', { store: { binOf: () => undefined } }), { ready: false })
})

test('each native agent has its own live switch, off by default', () => {
  const parsed = new Config({})
  for (const id of NATIVE) assert.equal(flagOf(parsed[AGENTS[id].key]), false, `${id} is off until the person turns it on`)
  assert.equal(flagOf(parsed.claude), true)
  assert.equal(flagOf(new Config({ hermes: true }).hermes), true)
})

test('a native agent that is not installed is listed with its install page, never hidden, and nothing is installed for it', async (t) => {
  // A desktop CLI store: it must never be asked about a CLI Automagik does not install.
  const mine = (what, pkg) => assert.notEqual(pkg, undefined, `the CLI store was asked to ${what} a CLI Automagik does not install`)
  const cliStore = {
    find: (spec) => { mine('find', cliIdOf(spec)); return undefined },
    ensure: (spec) => { mine('install', cliIdOf(spec)); return Promise.resolve() },
    busy: (pkg) => { mine('watch', pkg); return false },
    lastFailure: (pkg) => { mine('report', pkg); return undefined },
    lastError: () => undefined,
    dispose: () => {},
  }
  const h = host(t, { config: { hermes: true }, cliStore })
  const status = await h.service.status()
  assert.deepEqual(status.agents.map(agent => agent.id), Object.keys(AGENTS))
  const hermes = status.agents.find(agent => agent.id === 'acp-hermes')
  assert.deepEqual(hermes.cli, { found: false, installUrl: AGENTS['acp-hermes'].installUrl, signInHint: 'hermes acp --setup', state: 'missing', managed: false })
  assert.deepEqual(hermes.connector, { state: 'no-cli', native: true })
  assert.equal(hermes.on, true)
  assert.equal(hermes.model.listed, false)
  const omp = status.agents.find(agent => agent.id === 'acp-omp')
  assert.equal(omp.on, false)
  assert.deepEqual(omp.connector, { state: 'off', native: true })
  assert.equal(omp.cli.state, 'missing')
  assert.deepEqual(h.routes.now, [])
  await h.service.retry('acp-hermes')
  assert.deepEqual(h.installs, [])
})

test('turned on with its CLI here, a native agent is offered at once: no connector, no install, no CLI status command', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  // Not here yet: on, with no route.
  const clis = {}
  const g = host(t, { config: { antigravity: true }, clis })
  assert.deepEqual(g.routes.now, [])
  assert.equal((await row(g, 'acp-antigravity')).connector.state, 'no-cli')
  // Installed after DSH started: the next look offers it without a restart.
  clis.agy = fakeCli(scratch, 'agy', { FAKE_ACP_MODES: 'default,accept-edits,plan' })
  const seen = await g.service.inspect('acp-antigravity')
  assert.deepEqual(seen.connector, { state: 'ready', native: true })
  assert.equal(seen.cli.found, true)
  assert.equal(seen.model.listed, true)
  assert.equal(seen.restartNeeded, false)
  // Its sign-in is what its own ACP session said: the session opened.
  assert.equal(seen.signedIn, true)
  // No account is read for it and none waits for a confirmation: its switch was the person's word.
  assert.equal(seen.consent, undefined)
  assert.deepEqual(g.installs, [])
  assert.deepEqual(g.routes.now, ['acp-antigravity'])
  assert.deepEqual(g.logins, [], 'no CLI status command is run for a native agent')
})

for (const id of NATIVE) {
  test(`${id}: a turn runs through its CLI started with "acp", in its default mode, with no bridge even with dshTools on`, unixOnly, async (t) => {
    const spec = AGENTS[id]
    const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
    t.after(() => rmSync(scratch, { recursive: true, force: true }))
    const trace = join(scratch, 'trace.ndjson')
    const cli = fakeCli(scratch, spec.cli, { FAKE_ACP_TRACE: trace, FAKE_ACP_MODES: 'plan,default' })
    const h = host(t, { config: { [spec.key]: true, dshTools: true }, clis: { [spec.cli]: cli } })
    assert.deepEqual(h.routes.now, [id])
    const chunks = await step(h.adapter, id, 'plain')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.match(textIn(chunks), /you said "plain"/)
    const events = traceOf(trace)
    // The turn's own process (the model catalog reads the agent in another one).
    const pid = events.find(event => event.event === 'prompt').pid
    const mine = events.filter(event => event.pid === pid)
    assert.deepEqual(mine.find(event => event.event === 'start').args, ['acp'])
    // No DSH tool bridge for a native agent, whatever `dshTools` says.
    assert.deepEqual(mine.find(event => event.event === 'new-session').servers, [])
    // The fake started in `plan`: the turn put it in `default`, the mode that asks.
    assert.deepEqual(mine.filter(event => event.event === 'set-mode').map(event => event.modeId), ['default'])
    // It has a mode for DSH's level, so no notice says the level is not applied.
    assert.deepEqual(h.appended, [])
    // A tool call still asks through DSH's mirror tool.
    const asked = await step(h.adapter, id, 'run it')
    assert.equal(asked.at(-1).reason.kind, 'tool-calls')
    assert.ok(h.tools.has('acp_tool'))
  })
}

// #1000's start-before-replace and rollback are the connector store's: a native agent has no
// connector, so a start that works marks nothing good, and one that fails is reported and
// never sent back to "the release before it" (the fake store here would grant one).
test('a native agent never reaches the connector store: nothing is marked good, and a failed start is not rolled back or retried', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const starts = join(scratch, 'starts')
  const broken = join(scratch, 'omp')
  writeFileSync(broken, `#!/bin/sh\necho start >> ${quote(starts)}\nexit 3\n`)
  chmodSync(broken, 0o755)
  const h = host(t, { config: { hermes: true, omp: true }, clis: { hermes: fakeCli(scratch, 'hermes', { FAKE_ACP_MODES: 'default' }), omp: broken } })
  const agents = (await h.service.status()).agents
  for (const id of NATIVE) {
    const connector = agents.find(agent => agent.id === id).connector
    assert.equal(connector.previous, undefined)
    assert.equal(connector.rolledBack, undefined)
  }
  const ok = await step(h.adapter, 'acp-hermes', 'plain')
  assert.equal(ok.at(-1).reason.kind, 'stop')
  const failed = await step(h.adapter, 'acp-omp', 'plain')
  assert.equal(failed.at(-1).reason.kind, 'error')
  assert.match(failed.at(-1).reason.failure.message, /did not start: .*exited \(3\)/)
  assert.ok(existsSync(starts), 'the broken CLI was started')
  // The status read the two connectors' state (Claude Code's and Codex's rows), and only theirs.
  assert.deepEqual(h.storeCalls.filter(([name, pkg]) => name !== 'stateOf' || pkg === undefined), [])
  assert.deepEqual(h.installs, [])
})

test('a native agent with no "default" mode fails the turn rather than run in whatever mode it started in', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const h = host(t, { config: { omp: true }, clis: { omp: fakeCli(scratch, 'omp', { FAKE_ACP_MODES: 'yolo' }) } })
  const chunks = await step(h.adapter, 'acp-omp', 'plain')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /would not take DSH's permission level: it offers none of the modes default \(it offers yolo\)/)
})

test("Hermes's models come from its session's own list, and the chosen one reaches it with session/set_model", unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const trace = join(scratch, 'trace.ndjson')
  const cli = fakeCli(scratch, 'hermes', { FAKE_ACP_TRACE: trace, FAKE_ACP_MODES: 'default', FAKE_ACP_SESSION_MODELS: '1' })
  const h = host(t, { config: { hermes: true }, clis: { hermes: cli } })
  const models = await h.adapter.listModels('acp-hermes')
  assert.deepEqual(models.map(model => model.id), ['default', 'fake-large', 'fake-small', 'fake-plain'])
  assert.equal(models.find(model => model.id === 'fake-small').description, 'Quick and cheap')
  assert.match(models.find(model => model.id === 'default').description, /Its own setting: Fake Large/)
  // No efforts: Hermes offers no thought level.
  assert.equal((await h.adapter.resolveModel('acp-hermes', 'fake-small')).reasoning, undefined)
  const messages = []
  const chosen = await step(h.adapter, 'acp-hermes', 'plain', { model: 'fake-small', messages })
  assert.match(thoughtIn(chosen), /On fake-small /)
  // `default` goes back to the model the agent started on.
  messages.push({ role: 'assistant', source: { kind: 'model', provider: 'acp-hermes', model: 'fake-small' }, content: [] })
  const back = await step(h.adapter, 'acp-hermes', 'plain', { messages })
  assert.match(thoughtIn(back), /On fake-large /)
  const pid = traceOf(trace).find(event => event.event === 'prompt').pid
  assert.deepEqual(traceOf(trace).filter(event => event.pid === pid && event.event === 'set-model').map(event => event.modelId), ['fake-small', 'fake-large'])
  // A model it does not list fails the turn, naming those it does.
  const unknown = await step(h.adapter, 'acp-hermes', 'plain', { model: 'nope', messages })
  assert.match(unknown.at(-1).reason.failure.message, /would not take nope.*it offers fake-large, fake-small, fake-plain/)
})

test('a model the agent lists and cannot resolve fails the turn with the model and the agent\'s reason', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const cli = fakeCli(scratch, 'hermes', { FAKE_ACP_MODES: 'default', FAKE_ACP_SESSION_MODELS: '1', FAKE_ACP_SET_MODEL_FAIL: 'fake-plain' })
  const h = host(t, { config: { hermes: true }, clis: { hermes: cli } })
  const chunks = await step(h.adapter, 'acp-hermes', 'plain', { model: 'fake-plain' })
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /^Hermes \(ACP\) would not take fake-plain: it could not switch to fake-plain: Internal error \(model_resolution_failed\)$/)
})

test('withModels makes the model option from the session list only when the agent has none of its own', () => {
  const models = { currentModelId: 'b', availableModels: [{ modelId: 'a', name: 'A' }, { modelId: 'b', description: 'second' }, { modelId: '' }, {}] }
  const made = withModels([], models)
  assert.deepEqual(made, [{ id: MODEL_STATE, name: 'Model', category: 'model', type: 'select', currentValue: 'b', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'b', description: 'second' }] }])
  // Antigravity offers both: its own option stays the only one.
  const own = [{ id: 'model', category: 'model', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }] }]
  assert.equal(withModels(own, models), own)
  // omp offers neither: nothing is made up.
  const none = [{ id: 'thinking', category: 'thought_level', type: 'select', currentValue: 'off', options: [] }]
  assert.equal(withModels(none, undefined), none)
  assert.equal(withModels(none, { availableModels: [] }), none)
})

test('a signed-out native agent fails the turn as a sign-in and names its terminal command; the next check asks it again', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const cli = fakeCli(scratch, 'hermes', { FAKE_ACP_MODES: 'default', FAKE_ACP_AUTH: 'session' })
  const h = host(t, { config: { hermes: true }, clis: { hermes: cli } })
  const chunks = await step(h.adapter, 'acp-hermes', 'plain')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'error', failure: { message: 'Hermes (ACP) is not signed in. Run `hermes acp --setup` in a terminal, then send again.', code: MODEL_ACCESS_REQUIRED } })
  assert.equal((await row(h, 'acp-hermes')).signedIn, false)
  // The person signed in in a terminal: the agent's own refusal dropped the answer, so the
  // next read-only check (a Bot about to use it) asks the agent again.
  fakeCli(scratch, 'hermes', { FAKE_ACP_MODES: 'default' })
  assert.equal((await h.service.inspect('acp-hermes')).signedIn, true)
  assert.equal((await step(h.adapter, 'acp-hermes', 'plain')).at(-1).reason.kind, 'stop')
})

test('the sign-in of a native agent is its own session\'s word: read once, and asked again only when the person checks', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const trace = join(scratch, 'trace.ndjson')
  const cli = fakeCli(scratch, 'hermes', { FAKE_ACP_TRACE: trace, FAKE_ACP_MODES: 'default', FAKE_ACP_AUTH: 'session' })
  const h = host(t, { config: { hermes: true }, clis: { hermes: cli } })
  const starts = () => traceOf(trace).filter(event => event.event === 'start').length
  // A start would show within this pause; when none is made there is nothing to wait for.
  const settled = () => new Promise(resolve => setTimeout(resolve, 400))
  assert.equal((await h.service.inspect('acp-hermes')).signedIn, false)
  assert.equal(starts(), 1)
  // The person signed in in a terminal. Read-only checks do not start the agent again...
  fakeCli(scratch, 'hermes', { FAKE_ACP_TRACE: trace, FAKE_ACP_MODES: 'default' })
  assert.equal((await h.service.inspect('acp-hermes')).signedIn, false)
  await settled()
  assert.equal(starts(), 1)
  // ...but "check again" (refresh) does, and the agent's own session answers.
  const status = await h.service.refresh()
  assert.equal(status.agents.find(agent => agent.id === 'acp-hermes').signedIn, true)
  assert.equal(starts(), 2)
  // Signed in: no later check opens another session in the agent's history (the model read
  // behind the first answer has ended by now).
  await settled()
  await h.service.refresh()
  await h.service.inspect('acp-hermes')
  await settled()
  assert.equal(starts(), 2)
  assert.equal(traceOf(trace).filter(event => event.event === 'new-session').length, 1)
})

test('a native agent that says auth_required in a turn reads as signed out at once', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const h = host(t, { config: { omp: true }, clis: { omp: fakeCli(scratch, 'omp', { FAKE_ACP_MODES: 'default', FAKE_ACP_AUTH: 'prompt' }) } })
  // Its session opens, so it reads as signed in until a prompt says otherwise.
  assert.equal((await h.service.inspect('acp-omp')).signedIn, true)
  const chunks = await step(h.adapter, 'acp-omp', 'plain')
  assert.equal(chunks.at(-1).reason.failure.code, MODEL_ACCESS_REQUIRED)
  assert.match(chunks.at(-1).reason.failure.message, /Run `omp login` in a terminal, then send again\./)
  assert.equal((await row(h, 'acp-omp')).signedIn, false)
})

test('no sign-in attempt runs in the app for a native agent: the answer is its terminal command', (t) => {
  const h = host(t)
  assert.throws(() => h.service.loginStart('acp-hermes'), error => error.code === 'acp-login/terminal' && error.message === 'Sign in to Hermes in a terminal: run hermes acp --setup, then check again.')
  assert.throws(() => h.service.loginStart('acp-antigravity'), error => error.code === 'acp-login/terminal' && /agy acp --login/.test(error.message))
  assert.throws(() => h.service.loginStart('acp-omp'), error => error.code === 'acp-login/terminal' && /omp login/.test(error.message))
  // The agents that do sign in here are named from the table.
  assert.throws(() => h.service.loginStart('acp-nope'), error => error.code === 'acp-login/invalid' && error.message === 'Choose Claude Code or Codex.')
  assert.throws(() => h.service.loginCurrent('acp-hermes'), error => error.code === 'acp-login/invalid')
})

test('no account is confirmed for a native agent: the consent record is for Claude Code and Codex', async (t) => {
  const h = host(t)
  await assert.rejects(h.service.accountConfirm('acp-hermes'), error => error.code === 'acp-account/invalid' && error.message === 'Choose Claude Code or Codex.')
})

test('a table agent with no mode for DSH\'s level says so once in the chat, and the agent never reads that row', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const h = host(t)
  const spawn = () => ({ command: fakeCli(scratch, 'later', {}), args: ['acp'] })
  const catalog = new Catalog({ id: 'acp-later', name: 'Later', defaultName: 'Later', fallback: [{ id: 'default', name: 'Later' }], key: () => undefined, spawn })
  const adapter = new AcpAdapter(h.ctx, new Map([['acp-later', { name: 'Later (ACP)', levelNotice: true, bridge: false, catalog, spawn }]]), { dshTools: () => true })
  t.after(() => adapter.dispose())
  const messages = []
  await step(adapter, 'acp-later', 'plain', { messages })
  const notices = () => h.appended.filter(entry => entry.data.source?.kind === NOTICE_KIND)
  assert.equal(notices().length, 1)
  assert.equal(notices()[0].data.content[0].text, "[Later (ACP) runs under its own permission settings: this chat's level is not applied to it.]")
  // Once per agent session, not per turn.
  messages.push({ role: 'assistant', source: { kind: 'model', provider: 'acp-later', model: 'default' }, content: [] })
  await step(adapter, 'acp-later', 'plain', { messages })
  assert.equal(notices().length, 1)
  assert.deepEqual(promptOf([notices()[0].data, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }]), [{ type: 'text', text: 'hi' }])
})

// --- The write-time guard (#958) -----------------------------------------------------------------
// The guard stands in front of a Session a bridge serves, because the bridge writes its rows out
// of band. A native agent has no bridge, so the plugin writes nothing out of band for it: the
// rows of its turns are DSH's own loop's. These run a turn on a real Session, between the rows
// DSH's loop writes, and load the stored log with the pinned reader.
const GUARD = Symbol.for('@automagik/acp-dsh/write-guard')
const WROTE = new Set(['turn/start', 'step/start', 'request/header', 'step/end', 'turn/end'])
function loop(session, provider) {
  let turn = 0
  return {
    async turn(run) {
      turn += 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('request/header', { header: { config: { provider, model: 'default' } }, reason: 'initial' })
      const chunks = await run()
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: 'stop' })
      return chunks
    },
  }
}

for (const id of NATIVE) {
  test(`${id}: with dshTools on, its turns put no bridge row and no guard on the Session, and the stored log loads`, unixOnly, async (t) => {
    const spec = AGENTS[id]
    const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
    t.after(() => rmSync(scratch, { recursive: true, force: true }))
    const session = Session.create(`native-${spec.key}`)
    const h = host(t, { session, config: { [spec.key]: true, dshTools: true }, clis: { [spec.cli]: fakeCli(scratch, spec.cli, { FAKE_ACP_MODES: 'default' }) } })
    const dsh = loop(session, id)
    const messages = []
    const first = await dsh.turn(() => step(h.adapter, id, 'plain', { messages }))
    assert.equal(first.at(-1).reason.kind, 'stop')
    assertLoadable(session, ` after ${id}'s first turn`)
    messages.push({ role: 'assistant', source: { kind: 'model', provider: id, model: 'default' }, content: [] })
    await dsh.turn(() => step(h.adapter, id, 'plain', { messages }))
    assertLoadable(session, ` after ${id}'s second turn`)
    // Nothing but the loop's own rows: the plugin wrote none for this agent.
    assert.deepEqual(session.snapshotEvents().map(event => event.type).filter(type => !WROTE.has(type)), [])
    // No bridge was minted for it, so no guard was put on the Session either.
    assert.equal(session[GUARD], undefined)
    assert.deepEqual(eventsOf(session, 'plugin:acp-dsh/write-guard'), [])
  })
}

test('the one row the plugin writes for a table agent with no mode, its level notice, is one the reader loads', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-native-cli-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const session = Session.create('native-later')
  const h = host(t, { session })
  const spawn = () => ({ command: fakeCli(scratch, 'later', {}), args: ['acp'] })
  const catalog = new Catalog({ id: 'acp-later', name: 'Later', defaultName: 'Later', fallback: [{ id: 'default', name: 'Later' }], key: () => undefined, spawn })
  const adapter = new AcpAdapter(h.ctx, new Map([['acp-later', { name: 'Later (ACP)', levelNotice: true, bridge: false, catalog, spawn }]]), { dshTools: () => true })
  t.after(() => adapter.dispose())
  await loop(session, 'acp-later').turn(() => step(adapter, 'acp-later', 'plain'))
  assert.equal(eventsOf(session, 'user/message').filter(event => (event.data.message ?? event.data).source?.kind === NOTICE_KIND).length, 1)
  assertLoadable(session, ' with the level notice')
  assert.equal(session[GUARD], undefined)
})
