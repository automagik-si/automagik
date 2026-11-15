// Chat profiles stay in the app's home; an older adapter still takes the legacy modes.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../index.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { canRunProfile, chatProfileModesFor, chatProfileModes, chatProfilesConfig, codexRuntimeRoot, ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'

const HEX = '0123456789abcdef0123456789abcdef'
const PROFILE_MODES = chatProfileModesFor(HEX)
const READ = PROFILE_MODES['read-only']
const WRITE = PROFILE_MODES['workspace-write']
const label = mode => mode === READ ? 'permission-profile:automagik-read' : mode === WRITE ? 'permission-profile:automagik-workspace' : mode
const FULL = 'danger-full-access'
const MODES = ['agent-full-access', 'read-only', 'workspace-write', 'agent']
const TOP = '# Automagik chat permissions (managed by Automagik)\n'
const BOTTOM = '# Automagik chat permission profiles (managed by Automagik)\n'
const platform = 'linux'

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-chat-profiles-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('chat profile modes precede only their legacy choices', () => {
  assert.deepEqual(PROFILE_MODES, { 'read-only': `permission-profile:automagik-read-${HEX}`, 'workspace-write': `permission-profile:automagik-workspace-${HEX}` })
  assert.equal(AGENTS['acp-codex'].profileModes, undefined)
  assert.equal(Object.isFrozen(PROFILE_MODES), true)
  for (const [input, expected] of [
    [['read-only'], [READ, 'read-only']],
    [['workspace-write'], [WRITE, 'workspace-write']],
    [['agent-full-access', 'workspace-write'], ['agent-full-access', WRITE, 'workspace-write']],
    [['agent', 'workspace-write'], ['agent', WRITE, 'workspace-write']],
  ]) {
    const before = [...input]
    assert.deepEqual(chatProfileModes(input, PROFILE_MODES), expected)
    assert.deepEqual(input, before)
  }
  assert.equal(chatProfileModes(undefined), undefined)
})

test('chat config starts with the default and grants only the named roots', () => {
  const config = chatProfilesConfig('/chat/codex', HEX)
  // Codex's own read-only default: a legacy read-only turn reads through the default profile.
  assert.ok(config.startsWith(`${TOP}default_permissions = ':read-only'\n`))
  assert.ok(config.includes(BOTTOM))
  assert.ok(config.includes(`[permissions.automagik-read-${HEX}]\n`))
  assert.ok(config.includes(`[permissions.automagik-workspace-${HEX}]\n`))
  assert.equal(config.split("':root' = 'deny'").length - 1, 2)
  assert.equal(config.split("':minimal' = 'read'").length - 1, 2)
  assert.equal(config.split("':project_roots' = 'read'").length - 1, 2)
  const [read, write] = config.split(`[permissions.automagik-workspace-${HEX}]`)
  assert.ok(read.includes("':workspace_roots' = 'read'"))
  assert.doesNotMatch(read, /:tmpdir|:slash_tmp/)
  for (const key of [':workspace_roots', ':tmpdir', ':slash_tmp']) assert.ok(write.includes(`'${key}' = 'write'`))
  assert.equal(config.split("'/chat/codex/skills' = 'read'").length - 1, 2)
  assert.doesNotMatch(config, /network|config\.toml/)
  assert.equal(config.includes("'/chat/codex' ="), false)
})

for (const [home, key] of [
  ['/chat/a home', "'/chat/a home/skills'"],
  ["/chat/a'home", '"/chat/a\'home/skills"'],
  ['/chat/a"home', '"/chat/a\\"home/skills"'],
]) test(`chat config quotes the skills key: ${home}`, () => {
  const config = chatProfilesConfig(home, HEX)
  const expected = process.platform !== 'win32' ? key
    : key.startsWith("'") ? `'${join(home, 'skills')}'` : JSON.stringify(join(home, 'skills'))
  assert.equal(config.split(`${expected} = 'read'`).length - 1, 2)
})

test('a missing home gets an owner-only config', t => {
  const home = join(directory(t), 'codex')
  const modes = ensureChatProfiles(home, { platform })
  assert.equal(Object.isFrozen(modes), true)
  assert.match(modes['read-only'], /^permission-profile:automagik-read-[0-9a-f]{32}$/)
  const hex = modes['read-only'].slice(-32)
  assert.equal(modes['workspace-write'], `permission-profile:automagik-workspace-${hex}`)
  const path = join(home, 'config.toml')
  assert.equal(readFileSync(path, 'utf8'), chatProfilesConfig(home, hex))
  assert.notDeepEqual(ensureChatProfiles(join(directory(t), 'other'), { platform }), modes)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('chat config preserves other lines and is idempotent', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  const original = 'model = "x"\nsandbox_mode = "workspace-write"\n\n[projects."/a"]\ntrust_level = "trusted"\n'
  writeFileSync(path, `\n\n${original}`)
  const modes = ensureChatProfiles(home, { platform })
  assert.ok(modes)
  const first = readFileSync(path, 'utf8')
  assert.ok(first.startsWith(TOP))
  assert.ok(first.includes(original))
  assert.ok(first.includes(BOTTOM))
  utimesSync(path, new Date(1000), new Date(1000))
  const before = statSync(path).mtimeMs
  assert.deepEqual(ensureChatProfiles(home, { platform }), modes)
  assert.equal(readFileSync(path, 'utf8'), first)
  assert.equal(statSync(path).mtimeMs, before)
})

test('a Codex rewrite without the comments still leaves only one copy', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  const stripped = chatProfilesConfig(home, HEX).split('\n').filter(line => !line.startsWith('#')).join('\n')
  writeFileSync(path, `${stripped}\n[projects."/a"]\ntrust_level = "trusted"\n`)
  assert.deepEqual(ensureChatProfiles(home, { platform }), PROFILE_MODES)
  const config = readFileSync(path, 'utf8')
  for (const line of ["default_permissions = ':read-only'", `[permissions.automagik-read-${HEX}]`, `[permissions.automagik-workspace-${HEX}]`]) {
    assert.equal(config.split(line).length - 1, 1)
  }
  assert.ok(config.includes('[projects."/a"]\ntrust_level = "trusted"\n'))
  assert.deepEqual(ensureChatProfiles(home, { platform }), PROFILE_MODES)
  assert.equal(readFileSync(path, 'utf8'), config)
})

test('duplicate managed blocks are replaced together', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  writeFileSync(path, chatProfilesConfig(home, HEX).repeat(2))
  assert.deepEqual(ensureChatProfiles(home, { platform }), PROFILE_MODES)
  assert.equal(readFileSync(path, 'utf8'), chatProfilesConfig(home, HEX))
})

for (const original of [
  'default_permissions = "mine"\n',
  '"default_permissions" = "mine"\n',
  '[permissions.automagik-other]\ndescription = "mine"\n',
  '[permissions."automagik-other".filesystem]\n":root" = "read"\n',
  'permissions.automagik-other.description = "mine"\n',
  '[permissions]\nautomagik-other = {}\n',
]) test(`conflicting config is untouched: ${original.split('\n')[0]}`, t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  writeFileSync(path, original)
  const logs = []
  assert.equal(ensureChatProfiles(home, { platform, log: line => logs.push(line) }), undefined)
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.deepEqual(logs, ['Codex chat permission profiles were not written: conflicting config'])
})

test('Windows writes and removes nothing', t => {
  const home = join(directory(t), 'codex')
  assert.equal(ensureChatProfiles(home, { platform: 'win32' }), undefined)
  assert.equal(existsSync(home), false)
  mkdirSync(home)
  const path = join(home, 'config.toml')
  const original = chatProfilesConfig(home, HEX)
  writeFileSync(path, original)
  assert.equal(ensureChatProfiles(home, { platform: 'win32' }), undefined)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('a filesystem failure warns once without throwing', t => {
  const home = join(directory(t), 'not-a-directory')
  writeFileSync(home, '')
  const logs = []
  assert.equal(ensureChatProfiles(home, { platform, log: line => logs.push(line) }), undefined)
  assert.deepEqual(logs, ['Codex chat permission profiles were not written: config unavailable'])
  assert.equal(ensureChatProfiles(home, { platform, log: () => { throw new Error('logger stopped') } }), undefined)
})

test('an unwritable directory does not stop chat startup', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, t => {
  const home = mkdtempSync(join(tmpdir(), 'acp-chat-unwritable-'))
  chmodSync(home, 0o500)
  t.after(() => { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }) })
  const logs = []
  assert.equal(ensureChatProfiles(home, { platform, log: line => logs.push(line) }), undefined)
  assert.equal(logs.length, 1)
  assert.equal(existsSync(join(home, 'config.toml')), false)
})

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const PROVIDER = 'acp-fake'
const within = (promise, ms = 15_000) => {
  let timer
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('the step did not finish')), ms) })]).finally(() => clearTimeout(timer))
}

// own-mode.test.js's world, with only what a plain answer needs: no bridge or tool execution.
async function world(t, { level, modes, ownMode, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-chat-modes-'))
  const tracePath = join(dir, 'trace.jsonl')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  ctx.provide('approval', { effectivePolicy: () => level === FULL ? 'never' : 'ask' })
  ctx.provide('permissionPresets', { current: () => level })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: level }) })
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('workingDirectory', { ensure: async () => dir })
  const agents = new Map()
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()], turnBoundaryOf: () => ({ lastTurn: 1 }) })
  const spec = {
    name: 'Fake agent',
    catalog: { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_TRACE: tracePath, FAKE_ACP_MODES: modes.join(','), ...env }, ...(spec.spawned === undefined ? { profileModes: PROFILE_MODES } : spec.spawned) }),
    modeFor: AGENTS['acp-codex'].modeFor,
    ownMode: 'agent',
  }
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, spec]]), { ownMode: () => ownMode, dshTools: () => false })
  adapter.diagnostics = new PermissionDiagnostics()
  let scopes
  await ctx.plugin({ name: 'test-agents', inject: ['tools'], apply(child) { scopes = child } })
  t.after(async () => {
    for (const live of adapter.live.values()) { try { live.run.child?.kill('SIGKILL') } catch {} }
    adapter.dispose()
    await ctx.root.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const id = 'chat'
  const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
  const agent = { session, status: 'idle' }
  const scope = createScope(scopes, agent)
  t.after(() => scope.dispose())
  agent.ctx = scope.ctx
  agents.set(id, agent)
  adapter.registerMirror(agent)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const { name, description, parameters } = adapter.tool
  session.append('request/header', { header: { config: { provider: PROVIDER, model: 'default' }, tools: [{ name, description, parameters }] } })
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] }]
  const step = () => within((async () => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: PROVIDER, model: 'default', sessionId: id, messages }))) chunks.push(chunk)
    return chunks
  })())
  const events = name => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.event === name) : [])
  return { adapter, id, step, events, spec }
}

for (const profiles of [true, false]) {
  for (const [level, expected] of [
    ['read-only', profiles ? READ : 'read-only'],
    ['workspace-write', profiles ? WRITE : 'workspace-write'],
    [FULL, 'agent-full-access'],
    ['auto', 'agent'],
  ]) test(`chat at ${level} with profiles ${profiles} takes ${expected}`, async t => {
    // Start in a different mode, so even Full access must send set-mode.
    const modes = ['default', ...MODES, ...(profiles ? [READ, WRITE] : [])]
    const w = await world(t, { level, modes })
    const chunks = await w.step()
    assert.notEqual(chunks.at(-1).reason.kind, 'error', JSON.stringify(chunks))
    assert.deepEqual(w.events('set-mode').map(row => row.modeId), [expected])
    const seen = w.adapter.diagnostics.read(w.id).modes
    assert.equal(seen.chosen, label(expected))
    assert.equal(seen.current, label(expected))
    assert.equal(seen.applied, true)
    if (profiles) {
      assert.ok(seen.offered.includes(label(READ)))
      assert.ok(seen.offered.includes(label(WRITE)))
      if (level === 'read-only' || level === 'workspace-write') assert.equal(seen.wanted[0], label(expected))
    }
  })
}

for (const level of ['read-only', 'workspace-write']) test(`a running ${level} chat keeps the profile its process started with`, async t => {
  const w = await world(t, { level, modes: ['default', ...MODES, READ, WRITE] })
  const expected = level === 'read-only' ? READ : WRITE
  assert.notEqual((await w.step()).at(-1).reason.kind, 'error')
  // A later spawn (another chat, a refused config, a replaced agent object) has no modes.
  w.spec.spawned = {}
  assert.notEqual((await w.step()).at(-1).reason.kind, 'error')
  assert.deepEqual(w.events('new-session').length, 1)
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), [expected])
  assert.equal(w.adapter.diagnostics.read(w.id).modes.chosen, label(expected))
})

test('a refused own mode lands on the Workspace profile', async t => {
  const w = await world(t, { level: 'workspace-write', modes: MODES.concat(READ, WRITE), ownMode: () => true, env: { FAKE_ACP_REFUSE_MODES: 'agent' } })
  const chunks = await w.step()
  assert.notEqual(chunks.at(-1).reason.kind, 'error', JSON.stringify(chunks))
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), [WRITE])
  assert.equal(w.adapter.diagnostics.read(w.id).ownMode.answer, 'refused')
})

test('a changed own-mode answer lands on the Workspace profile', async t => {
  let asks = 0
  const w = await world(t, { level: 'workspace-write', modes: MODES.concat(READ, WRITE), ownMode: () => ++asks === 1 })
  const chunks = await w.step()
  assert.notEqual(chunks.at(-1).reason.kind, 'error', JSON.stringify(chunks))
  assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['agent', WRITE])
  assert.equal(w.adapter.diagnostics.read(w.id).ownMode.answer, 'changed')
})

test('diagnostics know both chat profiles in every mode field', () => {
  const diagnostics = new PermissionDiagnostics()
  const adapter = { agents: new Map([['acp-codex', {}]]), live: new Map() }
  const state = { provider: 'acp-codex', run: { alive: true, modes: { currentModeId: READ } } }
  adapter.live.set('chat', state)
  diagnostics.started('chat', adapter, AGENTS['acp-codex'], state)
  for (const mode of [READ, WRITE]) {
    state.run.modes.currentModeId = mode
    diagnostics.mode('chat', state, { wanted: [mode], offered: [READ, WRITE], chosen: mode })
    const seen = diagnostics.read('chat').modes
    assert.deepEqual(seen.wanted, [label(mode)])
    assert.deepEqual(seen.offered, [label(READ), label(WRITE)])
    assert.equal(seen.chosen, label(mode))
    assert.equal(seen.current, label(mode))
  }
})

test('Codex additions after the default and at EOF survive refresh', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  const modes = ensureChatProfiles(home, { platform })
  const hex = modes['read-only'].slice(-32)
  const extra = '[mcp_servers.probe]\ncommand = "probe"\n\n[features]\nexample = true\n'
  const topKey = 'model = "probe-model"\n'
  const first = readFileSync(path, 'utf8').replace(/(default_permissions[^\n]*\n)/, `$1${topKey}`)
  writeFileSync(path, first + extra)
  assert.deepEqual(ensureChatProfiles(home, { platform }), modes)
  const refreshed = readFileSync(path, 'utf8')
  assert.ok(refreshed.includes(extra))
  assert.ok(refreshed.includes(topKey))
  assert.ok(refreshed.indexOf(topKey) < refreshed.indexOf('['))
  assert.equal(refreshed.match(/^default_permissions\s*=/gm).length, 1)
  for (const mode of ['read', 'workspace']) for (const suffix of ['', '.filesystem']) {
    assert.equal(refreshed.split(`[permissions.automagik-${mode}-${hex}${suffix}]`).length - 1, 1)
  }
  assert.deepEqual(ensureChatProfiles(home, { platform }), modes)
  assert.equal(readFileSync(path, 'utf8'), refreshed)
})

test('quoted table keys and a rewritten default keep the home suffix', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  const original = chatProfilesConfig(home, HEX)
    .replace(`default_permissions = 'automagik-read-${HEX}'`, `  default_permissions = "automagik-read-${HEX}" # preserved id`)
    .replace(/\[permissions\.([^\].]+)(\.filesystem)?\]/g, (_, id, sub = '') => `[ "permissions" . '${id}' ${sub ? '. "filesystem"' : ''} ]`)
  writeFileSync(path, original)
  assert.deepEqual(ensureChatProfiles(home, { platform }), PROFILE_MODES)
  assert.equal(readFileSync(path, 'utf8'), chatProfilesConfig(home, HEX))
})

test('a leading BOM is removed and never written back', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  writeFileSync(path, `\uFEFF${chatProfilesConfig(home, HEX)}`)
  assert.deepEqual(ensureChatProfiles(home, { platform }), PROFILE_MODES)
  assert.equal(readFileSync(path, 'utf8'), chatProfilesConfig(home, HEX))
})

for (const original of [
  'description = """\n[permissions.fake]\n"""\n',
  "description = '''\n[permissions.fake]\n'''\n",
  'permissions = { custom = {} }\n',
  'permissions.custom.filesystem = {}\n',
  '"permissions" . "custom" = {}\n',
  '\uFEFFdefault_permissions = "foreign"\n',
  `default_permissions = 'automagik-read-${HEX}'\npermissions = {}\n`,
]) test(`ambiguous config fails closed: ${JSON.stringify(original)}`, t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  writeFileSync(path, original)
  utimesSync(path, new Date(1000), new Date(1000))
  const logs = []
  assert.equal(ensureChatProfiles(home, { platform, log: line => logs.push(line) }), undefined)
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.equal(statSync(path).mtimeMs, 1000)
  assert.deepEqual(logs, ['Codex chat permission profiles were not written: conflicting config'])
})

for (const value of ['foreign', `automagik-read-${HEX}`]) {
  test(`a nested default is preserved and never supplies the home suffix: ${value}`, t => {
    const home = directory(t)
    const path = join(home, 'config.toml')
    const nested = `[profiles.p]\ndefault_permissions = '${value}'\n`
    writeFileSync(path, nested)
    const modes = ensureChatProfiles(home, { platform })
    assert.ok(modes)
    assert.notEqual(modes['read-only'], READ)
    assert.ok(readFileSync(path, 'utf8').includes(nested))
    assert.deepEqual(ensureChatProfiles(home, { platform }), modes)
    assert.ok(readFileSync(path, 'utf8').includes(nested))
  })
}

for (const [wanted, chosen, strict, fallback] of [
  [[READ, 'read-only'], 'read-only', false, true],
  [[READ, 'read-only'], READ, false, undefined],
  [['agent-full-access', WRITE, 'workspace-write'], WRITE, true, undefined],
  [['agent-full-access', WRITE, 'workspace-write'], 'workspace-write', true, true],
  [['agent-full-access', WRITE, 'workspace-write'], 'agent-full-access', false, undefined],
  [['read-only'], 'read-only', false, undefined],
]) test(`diagnostics preserve the original ladder: ${wanted.join(',')} -> ${chosen}`, () => {
  const diagnostics = new PermissionDiagnostics()
  const adapter = { agents: new Map([['acp-codex', {}]]), live: new Map() }
  const unknown = `permission-profile:custom-${HEX}`
  const state = { provider: 'acp-codex', run: { alive: true, modes: { currentModeId: chosen } } }
  adapter.live.set('chat', state)
  diagnostics.started('chat', adapter, AGENTS['acp-codex'], state)
  diagnostics.mode('chat', state, { wanted, offered: [READ, WRITE, unknown], chosen })
  const record = diagnostics.read('chat')
  assert.equal(record.modes.fellToStrict, strict)
  assert.equal(record.modes.profileFallback, fallback)
  assert.equal(Object.hasOwn(record.modes, 'profileFallback'), fallback === true)
  assert.deepEqual(record.modes.offered, [label(READ), label(WRITE), 'other'])
  assert.equal(JSON.stringify(record).includes(HEX), false)
})

for (const isolated of [true, false]) test(`chat spawn returns its isolated home's modes: ${isolated}`, t => {
  const root = directory(t)
  const disposers = []
  const logs = []
  let adapter
  const ctx = {
    logger: { warn: line => logs.push(line), info() {} },
    llm: { registerAdapter: (_ids, value) => { adapter = value; return Object.assign(() => {}, { replace() {} }) } },
    agents: { list: () => [], get: () => undefined },
    get: () => undefined,
    on() {},
    provide() {},
    effect: setup => disposers.push(setup()),
  }
  t.after(() => { for (const dispose of disposers) dispose?.() })
  apply(ctx, { claude: true, codex: true, dshTools: false }, {
    store: { binOf: () => ({ path: FAKE, version: 'test' }), busy: () => false, update: async () => {}, dispose() {} },
    cliHome: isolated ? join(root, 'homes') : undefined,
    consentFile: join(root, 'consent.json'),
    find: name => ['claude', 'codex'].includes(name) ? process.execPath : undefined,
    signedIn: async () => false,
    account: async () => undefined,
    profileCheck: () => true,
  })
  const agent = adapter.agents.get('acp-codex')
  const claude = adapter.agents.get('acp-claude')
  assert.ok(agent)
  assert.equal(agent.profileModes, undefined)
  const catalog = agent.catalog.spec.spawn()
  assert.equal(catalog.profileModes, undefined)
  if (isolated) assert.equal(existsSync(join(catalog.env.CODEX_HOME, 'config.toml')), false)
  assert.equal(claude.spawn().profileModes, undefined)
  const launch = agent.spawn()
  if (!isolated || process.platform === 'win32') {
    assert.equal(launch.profileModes, undefined)
    return
  }
  const path = join(launch.env.CODEX_HOME, 'config.toml')
  const modes = launch.profileModes
  assert.match(modes['read-only'], /^permission-profile:automagik-read-[0-9a-f]{32}$/)
  assert.equal(Object.isFrozen(modes), true)
  assert.deepEqual(agent.spawn().profileModes, modes)
  writeFileSync(path, 'default_permissions = "foreign"\n')
  assert.equal(Object.hasOwn(agent.spawn(), 'profileModes'), false)
  assert.equal(readFileSync(path, 'utf8'), 'default_permissions = "foreign"\n')
  assert.equal(logs.filter(line => line.includes('conflicting config')).length, 1)
  writeFileSync(path, chatProfilesConfig(launch.env.CODEX_HOME, HEX))
  assert.deepEqual(agent.spawn().profileModes, PROFILE_MODES)
  assert.equal(agent.profileModes, undefined)
})

// Linux's sandbox re-executes Codex's own binary for every command (bwrap execvp): a profile
// that cannot read its folder runs no command at all.
test('the Codex executable folder is readable in both profiles', { skip: process.platform === 'win32' }, t => {
  const root = realpathSync(directory(t))
  const bin = join(root, 'release', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'codex'), '')
  const link = join(root, 'codex')
  symlinkSync(join(bin, 'codex'), link)
  assert.equal(codexRuntimeRoot(link), bin)
  // A packaged layout (codex-package.json beside bin/) is granted whole: codex-path holds rg.
  const layout = join(root, 'pkg', 'vendor', 'x86_64-unknown-linux-musl')
  mkdirSync(join(layout, 'bin'), { recursive: true })
  mkdirSync(join(layout, 'codex-path'))
  writeFileSync(join(layout, 'bin', 'codex'), '')
  writeFileSync(join(layout, 'codex-package.json'), '{}')
  assert.equal(codexRuntimeRoot(join(layout, 'bin', 'codex')), layout)
  // npm's launcher: the platform package it would start, never the whole node_modules.
  const modules = join(root, 'lib', 'node_modules')
  const launcher = join(modules, '@openai', 'codex', 'bin')
  mkdirSync(launcher, { recursive: true })
  writeFileSync(join(launcher, 'codex.js'), '')
  const native = join(modules, '@openai', 'codex-linux-x64')
  mkdirSync(join(native, 'vendor', 'x86_64-unknown-linux-musl', 'bin'), { recursive: true })
  writeFileSync(join(native, 'package.json'), '{"name":"@openai/codex-linux-x64","version":"0.0.0"}')
  writeFileSync(join(native, 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'), '')
  writeFileSync(join(native, 'vendor', 'x86_64-unknown-linux-musl', 'codex-package.json'), '{}')
  assert.equal(codexRuntimeRoot(join(launcher, 'codex.js'), { platform: 'linux', arch: 'x64' }), join(native, 'vendor', 'x86_64-unknown-linux-musl'))
  assert.equal(codexRuntimeRoot(join(launcher, 'codex.js'), { platform: 'linux', arch: 'arm64' }), undefined)
  assert.equal(codexRuntimeRoot(join(launcher, 'codex.js'), { platform: 'sunos', arch: 'x64' }), undefined)
  assert.equal(codexRuntimeRoot(join(root, 'missing')), undefined)
  assert.equal(codexRuntimeRoot(undefined), undefined)
  const home = join(root, 'home')
  const modes = ensureChatProfiles(home, { codexPath: link, platform: 'linux' })
  assert.ok(modes)
  const text = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.equal(text.split('\n').filter(line => line === `'${bin}' = 'read'`).length, 2)
})

test('an unresolvable Codex executable keeps the legacy modes and writes nothing', t => {
  const home = join(directory(t), 'home')
  const logs = []
  assert.equal(ensureChatProfiles(home, { codexPath: join(home, 'no-codex'), platform: 'linux', log: line => logs.push(line) }), undefined)
  assert.equal(existsSync(join(home, 'config.toml')), false)
  assert.equal(logs.length, 1)
})

test('a profile Codex cannot run a command under keeps the legacy modes', t => {
  const home = join(directory(t), 'home')
  const logs = []
  const asked = []
  assert.equal(ensureChatProfiles(home, { platform: 'linux', log: line => logs.push(line), verify: id => { asked.push(id); return false } }), undefined)
  assert.match(asked[0], /^automagik-read-[0-9a-f]{32}$/)
  assert.equal(logs.length, 1)
  assert.ok(ensureChatProfiles(home, { platform: 'linux', verify: () => true }))
})

test('the profile check runs codex sandbox once per executable and profile', () => {
  const calls = []
  const run = (command, args, options) => { calls.push([command, args, options.cwd]); if (args.includes('bad')) throw new Error('exit 1') }
  assert.equal(canRunProfile('/x/codex', 'good', { cwd: '/h', env: {}, run }), true)
  assert.equal(canRunProfile('/x/codex', 'good', { cwd: '/h', env: {}, run }), true)
  assert.equal(canRunProfile('/x/codex', 'bad', { cwd: '/h', env: {}, run }), false)
  assert.deepEqual(calls, [['/x/codex', ['sandbox', '-P', 'good', '-C', '/h', '--', 'true'], '/h'], ['/x/codex', ['sandbox', '-P', 'bad', '-C', '/h', '--', 'true'], '/h']])
})

test('a home an earlier build pointed at its own profile goes back to Codex read-only', t => {
  const home = directory(t)
  const path = join(home, 'config.toml')
  const earlier = chatProfilesConfig(home, HEX).replace("default_permissions = ':read-only'", `default_permissions = 'automagik-read-${HEX}'`)
  writeFileSync(path, `${earlier}[projects."/a"]\ntrust_level = "trusted"\n`)
  assert.deepEqual(ensureChatProfiles(home, { platform }), PROFILE_MODES)
  const config = readFileSync(path, 'utf8')
  assert.equal(config.includes(`default_permissions = 'automagik-read-${HEX}'`), false)
  assert.equal(config.split("default_permissions = ':read-only'").length - 1, 1)
  assert.ok(config.includes('[projects."/a"]'))
})
