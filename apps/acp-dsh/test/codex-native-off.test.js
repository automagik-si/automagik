// #1564 PR B: Codex native tools OFF (codex-native.js, the adapter's Codex row, index.js's
// service). Codex runs only through fakes here: a fake `codex` for the checks, the fake ACP agent
// for the process. Nothing reads a real Codex home.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { CATALOG_DROPS, keptModel, modelPart, NATIVE_OFF_NESTED, NATIVE_OFF_TOOLS, nativeOffLaunch, nativeOffSetup, offCatalog, pruneCatalogs } from '../src/host/codex-native.js'
import { apply } from '../index.js'
import { AGENTS } from '../src/host/agents.js'
import { Session } from '@deepseek-ai/dsh-session'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AgentRun } from '../src/host/acp.js'
import { Catalog } from '../src/host/catalog.js'
import { CHECKED, codexWorld, fakeCodex, finishOf, fixture, KEPT, owner, scheduled, textOf, turnOn, withFunction, withTool } from './fixtures/codex-native-world.js'
import { CLAUDE, CODEX, holdNativeStartup } from './fixtures/managed-native-world.js'

const recorded = JSON.parse(readFileSync(new URL('./fixtures/codex-acp-2.9.0-models.json', import.meta.url), 'utf8'))

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-native-off-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'codex-home')
  const cwd = join(root, 'chat')
  const dir = join(root, 'acp', 'codex-native-off')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, cwd, dir, launch: { command: process.execPath, args: ['codex-acp.js'], env: { CODEX_HOME: home, CODEX_PATH: '/fake/codex', AUTOMAGIK_BOT_CLI_HOME: root } } }
}

const setup = (s, fake, more = {}) => nativeOffSetup(s.launch, { cwd: s.cwd, dir: s.dir, kept: ['gpt-5.5'], run: fake.run, ...more })
const refused = async (promise, pattern) => {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    if (pattern) assert.match(error.message, pattern)
    return true
  })
}

test('the Codex row carries the switch and the kept list (one source of "unverifiable")', () => {
  assert.equal(AGENTS['acp-codex'].nativeSwitch, 'config')
  assert.deepEqual(AGENTS['acp-codex'].nativeKeptModels, ['gpt-5.5'])
  assert.equal(Object.isFrozen(AGENTS['acp-codex'].nativeKeptModels), true)
})

test('modelPart reads codex-acp 2.9.0 model values (bare slugs) and fails closed on any other shape', () => {
  for (const value of recorded.values) assert.equal(modelPart(value), value)
  assert.equal(modelPart(recorded.currentValue), recorded.currentValue)
  for (const value of [undefined, null, 42, '', 'gpt-5.5/high', 'gpt 5.5', '../x', { value: 'gpt-5.5' }]) assert.equal(modelPart(value), undefined)
  const row = AGENTS['acp-codex']
  assert.equal(keptModel(row, modelPart('gpt-5.5')), true)
  assert.equal(keptModel(row, modelPart('gpt-5.6-luna')), false)
  assert.equal(keptModel(row, modelPart('gpt-5.5/high')), false)
  assert.equal(keptModel({}, 'gpt-5.5'), false)
})

test('N1 the FULL capture is accepted: overrides, CODEX_CONFIG, the transport only, a private catalog outside the Codex home', async t => {
  const s = scratch(t)
  const fake = fakeCodex({ answers: { servers: JSON.stringify([{ name: 'personal' }]) } })
  const lines = []
  const launched = await nativeOffLaunch(s.launch, { cwd: s.cwd, dir: s.dir, kept: ['gpt-5.5'], run: fake.run, log: line => lines.push(line) })
  const config = JSON.parse(launched.env.CODEX_CONFIG)
  assert.equal(launched.nativeOff, true)
  assert.equal(launched.checkedCwd, s.cwd)
  assert.deepEqual(launched.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.deepEqual(config.features.multi_agent_v2, { enabled: false, disable_native_tools: true })
  assert.equal(config.features.shell_tool, false)
  assert.equal(config.features.view_image, false)
  for (const name of ['unified_exec', 'image_generation', 'multi_agent', 'code_mode', 'apps', 'plugins', 'goals']) assert.equal(config.features[name], false, name)
  assert.deepEqual(config.tools, { experimental_request_user_input: { enabled: false } })
  assert.equal(config.web_search, 'disabled')
  assert.deepEqual(config.mcp_servers, { personal: { enabled: false } })
  assert.equal(config.skills.bundled.enabled, false)
  const file = config.model_catalog_json
  assert.equal(file, launched.offCatalog.path)
  assert.ok(file.startsWith(s.dir + '/'))
  assert.equal(file.startsWith(s.home), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const catalog = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(catalog.models.map(model => model.slug), ['gpt-6.2-sol', 'gpt-5.6-luna'])
  for (const model of catalog.models) {
    assert.equal(model.apply_patch_tool_type, null)
    for (const name of CATALOG_DROPS) assert.equal(model.experimental_supported_tools.includes(name), false)
  }
  assert.equal(readFileSync(file, 'utf8'), launched.offCatalog.bytes)
  assert.equal(readdirSync(s.home).length, 0)
  assert.match(lines.at(-1), /^acp-dsh: Codex runs with its own tools off; it offers functions\.exec, functions\.wait \(exec reaches list_mcp_resource_templates, list_mcp_resources, read_mcp_resource\); models 2\/3$/)
  const offered = (await setup(scratch(t), fakeCodex())).offered
  assert.deepEqual(offered.tools, [...NATIVE_OFF_TOOLS])
  assert.deepEqual([...offered.nested].sort(), [...NATIVE_OFF_NESTED].sort())
})

// The final read (step 7): the probe slug (the first checked model with `apply_patch_tool_type`,
// gpt-6.2-sol here), read again after every model was checked one by one. Never the home default.
const PROBE = 'gpt-6.2-sol'
const finalRead = ({ undone, model, calls }) => undone === undefined && model === PROBE && calls.some(call => call.model === 'gpt-5.6-luna')
const N2 = [
  ['apply_patch still nested', { prompt: call => finalRead(call) ? fixture('prompt-undo-catalog.json') : undefined }],
  ['a collaboration tool', { prompt: call => finalRead(call) ? fixture('prompt-undo-collaboration.json') : undefined }],
  ['a multi-agent v1 spawn_agent', { prompt: call => finalRead(call) ? withFunction('spawn_agent') : undefined }],
  ['request_user_input', { prompt: call => finalRead(call) ? fixture('prompt-undo-user_input.json') : undefined }],
  ['send_message_to_user_async', { prompt: call => finalRead(call) ? withFunction('send_message_to_user_async') : undefined }],
  ['exec_command', { prompt: call => finalRead(call) ? fixture('prompt-undo-shell_tool.json') : undefined }],
  ['a hosted web_search', { prompt: call => finalRead(call) ? withTool({ type: 'web_search' }) : undefined }],
  ['an image_gen tool', { prompt: call => finalRead(call) ? withTool({ type: 'namespace', name: 'image_gen', description: '', tools: [{ type: 'function', name: 'generate', description: 'x', parameters: {}, strict: false }] }) : undefined }],
  ...['shell_tool', 'view_image', 'catalog', 'collaboration', 'user_input'].map(name => [`the ${name} removal undone gains nothing`, { prompt: ({ undone }) => undone === name ? fixture('prompt-full.json') : undefined }]),
  ['debug models unreadable', { models: 'not json' }],
  ['debug models empty', { models: '{"models":[]}' }],
  ['shell_tool unknown to this Codex', { features: fixture('features.txt').split('\n').filter(line => !line.startsWith('shell_tool ')).join('\n') }],
  ['a home server named dsh', { servers: JSON.stringify([{ name: 'dsh' }]) }],
]
for (const [label, answers] of N2) {
  test(`N2 refuses: ${label}`, async t => {
    const fake = fakeCodex({ answers, homeDefault: KEPT })
    await refused(setup(scratch(t), fake))
    assert.equal(fake.calls.some(call => call.what === 'debug prompt-input' && call.model === undefined), false)
  })
}

test('N2 refuses: the checks out of time', async t => {
  const fake = fakeCodex({ answers: { hang: call => call.what === 'debug models' } })
  await refused(setup(scratch(t), fake, { deadlineMs: 50, timeoutMs: 50 }))
  assert.ok(fake.kills.some(kill => kill.what === 'debug models'))
})

test('N3 no verdict is reused: two homes run two full checks, the same launch twice runs twice', async t => {
  const s = scratch(t)
  const other = join(s.root, 'other-home')
  mkdirSync(other)
  const fake = fakeCodex({ answers: { servers: JSON.stringify([{ name: 'personal' }]) } })
  await setup(s, fake)
  const first = fake.calls.length
  await nativeOffSetup({ ...s.launch, env: { ...s.launch.env, CODEX_HOME: other } }, { cwd: s.cwd, dir: s.dir, kept: ['gpt-5.5'], run: fake.run })
  await setup(s, fake)
  assert.equal(fake.calls.length, first * 3)
  assert.equal(fake.calls.filter(call => call.home === other).length, first)
})

test('N4 per model: a failing model is dropped and logged, a kept model is never probed, one with no tool block is measured kept, all with none are unverifiable (not refused); the home default is never read', async t => {
  const lunaSpawns = { prompt: ({ undone, model }) => undone === undefined && model === 'gpt-5.6-luna'
    ? withTool({ type: 'namespace', name: 'collaboration', description: '', tools: [{ type: 'function', name: 'spawn_agent', description: 'x', parameters: {}, strict: false }] }) : undefined }
  const s = scratch(t)
  const fake = fakeCodex({ answers: lunaSpawns })
  const lines = []
  const result = await setup(s, fake, { log: line => lines.push(line) })
  assert.deepEqual(result.models, ['gpt-6.2-sol'])
  assert.deepEqual(JSON.parse(readFileSync(result.catalog.path, 'utf8')).models.map(model => model.slug), ['gpt-6.2-sol'])
  assert.ok(lines.includes('acp-dsh: Codex model gpt-5.6-luna could not be checked with its own tools off; it is not offered while they are off'))
  assert.equal(fake.calls.some(call => call.model === 'gpt-5.5'), false)
  // Not on the kept list: it answers with no tool block, so it is measured kept (B1-4 (b)): left
  // out of the copy the process gets, returned beside the checked models, with its own line.
  const open = fakeCodex()
  const unkept = []
  const plain = await nativeOffSetup(s.launch, { cwd: s.cwd, dir: s.dir, kept: [], run: open.run, log: line => unkept.push(line) })
  assert.deepEqual(plain.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.deepEqual(plain.unverified, ['gpt-5.5'])
  assert.deepEqual(JSON.parse(readFileSync(plain.catalog.path, 'utf8')).models.map(model => model.slug), ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.ok(open.calls.some(call => call.model === 'gpt-5.5'))
  assert.ok(unkept.includes("acp-dsh: Codex model gpt-5.5 shows no tools to check; it runs with Codex's own tools, as before"), unkept.join('\n'))
  assert.equal(unkept.some(line => line.includes('gpt-5.5 could not be checked')), false)
  // A home whose own default model shows no tool block (gpt-5.5, as the real one): the setup
  // passes on the copy's models and never reads the default (BD-1).
  for (const fake of [fakeCodex({ homeDefault: KEPT }), fakeCodex({ answers: { prompt: ({ undone, model }) => undone === undefined && model === undefined ? '[]' : undefined } })]) {
    const passed = await setup(scratch(t), fake)
    assert.deepEqual(passed.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
    assert.deepEqual(passed.unverified, [])
    assert.equal(fake.calls.some(call => call.what === 'debug prompt-input' && call.model === undefined), false)
    assert.equal(fake.calls.some(call => call.model === KEPT), false)
  }
  // Every model of the copy answers with no tool block (BF-1, B1-4): none can be checked, so none
  // is refused. The setup says so with its own code and the models, never the refusal.
  const none = []
  await assert.rejects(setup(scratch(t), fakeCodex({ answers: { prompt: ({ undone, model }) => undone === undefined && model !== undefined ? '[]' : undefined } }), { log: line => none.push(line) }), error => {
    assert.equal(error.code, 'acp/native-off-unverifiable')
    assert.deepEqual(error.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
    assert.doesNotMatch(error.message, /no model could be checked/)
    return true
  })
  assert.ok(none.includes("acp-dsh: Codex shows no tools to check for gpt-6.2-sol, gpt-5.6-luna; they run with Codex's own tools, as before"), none.join('\n'))
})

// sol answers with no tool block; luna fails for its own reason (N4c, BG-1 (b)).
const solNoBlock = ({ undone, model }) => undone === undefined && model === 'gpt-6.2-sol' ? '[]' : undefined
const lunaAnswers = answer => config => solNoBlock(config) ?? (config.undone === undefined && config.model === 'gpt-5.6-luna' ? answer : undefined)
const N4C = [
  ['a non-zero exit', { prompt: solNoBlock, exit: call => call.what === 'debug prompt-input' && call.model === 'gpt-5.6-luna' ? 1 : undefined }],
  ['an unknown form', { prompt: lunaAnswers(JSON.stringify([{ type: 'mystery' }])) }],
  ['a forbidden tool', { prompt: lunaAnswers(withFunction('apply_patch')) }],
]

test('N4c the safety limit: a model with no tool block beside a non-zero exit, an unknown form or a forbidden tool still refuses (LQ1), carrying the no-block model (BG-1)', async t => {
  for (const [label, answers] of N4C) {
    await assert.rejects(setup(scratch(t), fakeCodex({ answers })), error => {
      assert.equal(error.code, 'acp/native-off-unavailable', label)
      assert.match(error.message, /no model could be checked/, label)
      assert.equal(error.models, undefined, label)
      // The refusal is luna's; sol's own answer is the accepted one, so it travels with it.
      assert.deepEqual(error.unverified, ['gpt-6.2-sol'], label)
      return true
    })
  }
  // Every copy model refused for another reason than a missing tool block: refused, not unverifiable.
  await assert.rejects(setup(scratch(t), fakeCodex({ answers: { exit: call => call.what === 'debug prompt-input' ? 1 : undefined } })), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.match(error.message, /no model could be checked/)
    assert.equal(error.unverified, undefined)
    return true
  })
})

// A read under the shell_tool switch undone (step 8's first effect).
const shellUndone = call => call.config.some(entry => entry.includes('shell_tool = true'))
// Step 7's final read of luna (the only checked model): a luna read after sol's step-5 read
// (sol's second) and after luna's own step-5 read.
const lunaFinal = ({ undone, model, calls }) => {
  if (undone !== undefined || model !== 'gpt-5.6-luna') return false
  const reads = calls.filter(call => call.what === 'debug prompt-input').map(call => call.model)
  const solStep5 = reads.indexOf('gpt-6.2-sol', reads.indexOf('gpt-6.2-sol') + 1)
  return solStep5 !== -1 && reads.indexOf('gpt-5.6-luna', solStep5) !== -1
}
const ignoresShell = config => solNoBlock(config) ?? (config.undone === 'shell_tool' ? fixture('prompt-model-gpt-5.6-luna.json') : undefined)

test('BG-1 a setup that fails after a model was measured with no tool block carries it (step 7, step 8); a deadline, a Stop or an unreadable call never does', async t => {
  // Step 8: Codex ignores the shell_tool switch. The refusal is the switch's, not sol's.
  await assert.rejects(setup(scratch(t), fakeCodex({ answers: { prompt: ignoresShell } })), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.match(error.message, /Codex ignores shell_tool/)
    assert.deepEqual(error.unverified, ['gpt-6.2-sol'])
    return true
  })
  // Step 7: the probe's final read still offers apply_patch (wrapped by nativeOffSetup).
  await assert.rejects(setup(scratch(t), fakeCodex({ answers: { prompt: config => solNoBlock(config) ?? (lunaFinal(config) ? fixture('prompt-undo-catalog.json') : undefined) } })), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.deepEqual(error.unverified, ['gpt-6.2-sol'])
    return true
  })
  // (c) A deadline in step 8, after sol was measured: still the deadline, nothing carried.
  const late = fakeCodex({ answers: { prompt: solNoBlock } })
  await assert.rejects(setup(scratch(t), late, { now: () => late.calls.some(shellUndone) ? 1e12 : 0 }), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.match(error.message, /in time/)
    assert.equal(error.unverified, undefined)
    return true
  })
  // A Stop in step 8: a Stop, nothing carried.
  const controller = new AbortController()
  const stop = fakeCodex({ answers: { prompt: config => { if (config.undone === 'shell_tool') controller.abort(); return solNoBlock(config) } } })
  await assert.rejects(setup(scratch(t), stop, { signal: controller.signal }), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.equal(error.stopped, true)
    assert.equal(error.unverified, undefined)
    return true
  })
  // A step-8 call that never answers (unreadable): refused, nothing carried.
  const hung = fakeCodex({ answers: { prompt: solNoBlock, hang: shellUndone } })
  await assert.rejects(setup(scratch(t), hung, { timeoutMs: 200 }), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.match(error.message, /in time/)
    assert.equal(error.unverified, undefined)
    return true
  })
})

test('BF-2 a deadline during the skills reads or the per-model reads refuses as a deadline, never as "no model could be checked"', async t => {
  const LATE = 1e12
  // Step 4: the clock passes the deadline once the catalog was read.
  const step4 = fakeCodex()
  await refused(setup(scratch(t), step4, { now: () => step4.calls.some(call => call.what === 'debug models') ? LATE : 0 }), /in time/)
  assert.equal(step4.calls.some(call => call.what === 'debug prompt-input'), false)
  // Step 5: sol shows no tool block, luna reads the skills; the clock passes the deadline after
  // sol's per-model read, before luna's.
  const step5 = fakeCodex({ answers: { prompt: ({ undone, model }) => undone === undefined && model === 'gpt-6.2-sol' ? '[]' : undefined } })
  const solReads = () => step5.calls.filter(call => call.what === 'debug prompt-input' && call.model === 'gpt-6.2-sol').length
  await refused(setup(scratch(t), step5, { now: () => solReads() >= 2 ? LATE : 0 }), /in time/)
})

test('N4b the probe: skills read on the first copy model with a tool block, the final read and every effect on a checked model with apply_patch; CODEX_CONFIG names no model', async t => {
  const models = JSON.parse(fixture('models.json'))
  const list = Array.isArray(models) ? models : models.models
  for (const model of list) if (model.slug === 'gpt-6.2-sol') model.apply_patch_tool_type = null
  const s = scratch(t)
  const fake = fakeCodex({ homeDefault: KEPT, answers: { models: JSON.stringify(models) } })
  const launched = await nativeOffLaunch(s.launch, { cwd: s.cwd, dir: s.dir, kept: [KEPT], run: fake.run })
  assert.deepEqual(launched.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.equal('model' in JSON.parse(launched.env.CODEX_CONFIG), false)
  const reads = fake.calls.filter(call => call.what === 'debug prompt-input')
  assert.equal(reads.some(call => call.model === undefined), false)
  assert.equal(reads[0].model, 'gpt-6.2-sol')
  // After the per-model reads (sol, luna): the final read and the five effects, all on luna.
  const lunaAt = reads.findIndex(call => call.model === 'gpt-5.6-luna')
  assert.deepEqual(reads.slice(lunaAt + 1).map(call => call.model), Array(6).fill('gpt-5.6-luna'))
  // The first copy model shows no tool block: the skills reads move on to the next one, and it is dropped.
  const skip = fakeCodex({ homeDefault: KEPT, answers: { prompt: ({ undone, model }) => undone === undefined && model === 'gpt-6.2-sol' ? '[]' : undefined } })
  const result = await setup(scratch(t), skip)
  assert.deepEqual(result.models, ['gpt-5.6-luna'])
  assert.deepEqual(result.unverified, ['gpt-6.2-sol'])
  assert.deepEqual(launched.unverified, [])
  assert.deepEqual(skip.calls.filter(call => call.what === 'debug prompt-input').slice(0, 2).map(call => call.model), ['gpt-6.2-sol', 'gpt-5.6-luna'])
})

test('N5 Stop: aborting mid-check refuses and kills the running CLI call', async t => {
  const controller = new AbortController()
  const fake = fakeCodex({ answers: { hang: call => call.what === 'debug prompt-input' && call.model === 'gpt-5.6-luna' } })
  const pending = setup(scratch(t), fake, { signal: controller.signal })
  while (!fake.calls.some(call => call.model === 'gpt-5.6-luna')) await new Promise(resolve => setTimeout(resolve, 2))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'acp/native-off-unavailable' && error.stopped === true)
  assert.ok(fake.kills.some(kill => kill.what === 'debug prompt-input'))
  const before = fake.calls.length
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fake.calls.length, before)
})

test('N6 prune: copies older than 24 hours go, younger ones and the new file stay, other files are left', async t => {
  const s = scratch(t)
  mkdirSync(s.dir, { recursive: true })
  const now = Date.now()
  const old = join(s.dir, `models-${'a'.repeat(64)}.json`)
  const young = join(s.dir, `models-${'b'.repeat(64)}.json`)
  const keep = join(s.dir, `models-${'c'.repeat(64)}.json`)
  const other = join(s.dir, 'notes.txt')
  for (const file of [old, young, keep, other]) writeFileSync(file, '{}')
  const at = hours => (now - hours * 3600_000) / 1000
  utimesSync(old, at(25), at(25))
  utimesSync(young, at(23), at(23))
  utimesSync(keep, at(30), at(30))
  utimesSync(other, at(48), at(48))
  pruneCatalogs(s.dir, { now: () => now, keepPath: keep })
  assert.deepEqual(readdirSync(s.dir).sort(), [young, keep, other].map(file => file.slice(s.dir.length + 1)).sort())
  const result = await setup(s, fakeCodex())
  assert.ok(readdirSync(s.dir).includes(result.catalog.path.slice(s.dir.length + 1)))
})

test('N7 one CLI call at a time within a setup', async t => {
  const fake = fakeCodex({ delayMs: 3 })
  await setup(scratch(t), fake)
  assert.ok(fake.calls.length >= 13, String(fake.calls.length))
  assert.equal(fake.overlapped(), false)
})

test('N7b two setups started together on one Codex home never overlap their CLI calls', async t => {
  const s = scratch(t)
  const fake = fakeCodex({ delayMs: 3 })
  const [a, b] = await Promise.all([setup(s, fake), setup(s, fake)])
  assert.deepEqual(a.models, b.models)
  assert.equal(fake.overlapped(), false)
})

test('N8 a symlinked folder: the checks run at its real path, the launch answers the path it was given', async t => {
  const s = scratch(t)
  const link = join(s.root, 'linked-chat')
  symlinkSync(s.cwd, link)
  const fake = fakeCodex()
  const launched = await nativeOffLaunch(s.launch, { cwd: link, dir: s.dir, kept: ['gpt-5.5'], run: fake.run })
  assert.equal(launched.checkedCwd, link)
  assert.ok(fake.calls.every(call => call.cwd === s.cwd))
  assert.deepEqual(Object.keys(JSON.parse(launched.env.CODEX_CONFIG).projects), [s.cwd])
})

test('offCatalog clears apply_patch, drops the catalog extras and the kept models, and refuses an empty result', () => {
  const copy = offCatalog(JSON.parse(fixture('models.json')), { drop: ['gpt-5.5'] })
  assert.deepEqual(copy.models.map(model => model.slug), ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.deepEqual(copy.models[0].experimental_supported_tools, ['request_user_input_async', 'literature_search_query', 'multi_agent_v2_in_code_mode'])
  assert.throws(() => offCatalog({ models: [{ slug: 'gpt-5.5' }] }, { drop: ['gpt-5.5'] }), { code: 'acp/native-off-unavailable' })
  assert.throws(() => offCatalog({ models: 'x' }), { code: 'acp/native-off-unavailable' })
})

// ---------------------------------------------------------------------------------------------
// The adapter's Codex row on PR A's managed world (codex-native-world.js). The fake ACP agent
// offers Codex model slugs; a spawn under `nativeOff` answers what a passed check returns.
// ---------------------------------------------------------------------------------------------
const NOTICE = 'The tools setting changed; send again.'
const ON = () => ({ name: 'Ada', nativeTools: true, nativeToolsAgent: CODEX })
const OFF = () => ({ name: 'Ada' })
const MODELS = [...CHECKED, 'gpt-6-astra', KEPT]
const world = (t, options = {}) => codexWorld(t, { models: MODELS, ...options })
const sessions = w => w.events('new-session')
const servers = w => sessions(w).map(row => row.servers)
const pids = w => sessions(w).map(row => row.pid)
const promptPids = w => w.events('prompt').map(row => row.pid)
const offContexts = w => w.contexts.map(context => context?.nativeOff === true)
const lastMode = (w, pid) => w.events('set-mode').filter(row => pid === undefined || row.pid === pid).at(-1)?.modeId
const sourced = (text, source) => ({ ...owner(text), source })
const freshRelay = () => sourced('[Handoff · part 2]\nThe user started a fresh conversation (part 2) in your own chat. This message is not from the user.', { kind: 'bot', form: 'relay', role: 'handoff', handoff: true })

/** DSH tools with an `edit` that really writes its file; counts DSH's approval asks. */
function writingTools(w) {
  const asked = []
  const defs = ['bash', 'read', 'list_bots', 'edit'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
  w.services.tools = {
    definitions: () => defs,
    executable: name => defs.find(tool => tool.name === name),
    execute: async ({ calls: [call] }) => {
      w.executed.push(call.name)
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments ?? {}
      if (call.name === 'edit') writeFileSync(args.path, args.text)
      return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: `ran ${call.name}` }] } }] }
    },
  }
  const request = w.services.approval.request
  w.services.approval.request = async req => { asked.push(req.toolName); return request(req) }
  return asked
}

/** A Session whose header says it is a DSH subagent's child. */
function subagentChat(w, id) {
  const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: tmpdir(), origin: 'subagent' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const get = w.adapter.ctx.agents.get
  w.adapter.ctx.agents.get = sid => sid === id ? agent : get(sid)
  return { session, history: [] }
}

test('A1 OFF launch on a scheduled turn: bridge forced for a Bot without needsDshTools, read-only id, DSH edit writes at Workspace (one DSH ask) and at Full (none)', async t => {
  const w = world(t, { identity: OFF })
  const asked = writingTools(w)
  const chat = w.chat('direct')
  const file = join(chat.session.header.cwd, 'written.txt')
  await turnOn(w, chat, scheduled('scheduled delivery'))
  assert.deepEqual(offContexts(w), [true])
  assert.deepEqual(servers(w), [['dsh']])
  assert.ok(w.events('mcp-list').length > 0, 'the bridge listed its tools')
  const live = w.adapter.live.get('direct')
  assert.equal(live.native, false)
  assert.equal(live.nativeOff, true)
  assert.equal(live.bridgeDefault, true)
  assert.equal(lastMode(w), 'read-only')
  assert.ok(w.events('mcp-list')[0].tools.includes('bash'), 'an OFF Codex gets DSH\'s whole preset')
  const workspace = await turnOn(w, chat, scheduled(`codex-bridge edit ${JSON.stringify({ path: file, text: 'workspace' })}`))
  assert.equal(finishOf(workspace).kind, 'stop')
  assert.equal(readFileSync(file, 'utf8'), 'workspace')
  assert.deepEqual(asked, ['edit'])
  w.services.approval.effectivePolicy = () => 'never'
  chat.session.append('sandbox/mode', { mode: 'danger-full-access' })
  await turnOn(w, chat, scheduled(`codex-bridge edit ${JSON.stringify({ path: file, text: 'full' })}`))
  assert.equal(readFileSync(file, 'utf8'), 'full')
  assert.deepEqual(asked, ['edit'])
  assert.equal(lastMode(w), 'read-only', 'still its read-only id after the fork')
  assert.deepEqual(pids(w).length, 1)
})

for (const [label, identity] of [['A-B8a identity-less Workspace Session', () => undefined], ['A-B1i ON saved for Claude', () => ({ ...ON(), nativeToolsAgent: 'acp-claude' })], ['A-B1i ON with no agent tag', () => ({ name: 'Ada', nativeTools: true })]]) {
  test(`${label}, team: OFF, servers exactly dsh, the bridge listened, read-only id`, async t => {
    const w = world(t, { identity })
    const chat = w.chat('workspace')
    await turnOn(w, chat, owner('owner turn'))
    assert.deepEqual(offContexts(w), [true])
    assert.deepEqual(servers(w), [['dsh']])
    assert.ok(w.events('mcp-list').length > 0)
    assert.equal(lastMode(w), 'read-only')
  })
}

test('A-B8b no Bot team ever registered: today\'s Codex launch, no check', async t => {
  const w = world(t, { managed: false })
  await turnOn(w, w.chat('direct'), owner('owner turn'))
  assert.deepEqual(offContexts(w), [false])
  assert.deepEqual(servers(w), [[]])
  assert.equal(w.adapter.live.get('direct').native, true)
})

for (const [label, message] of [
  ['A-B1c a scheduled turn into the ON Bot\'s direct chat', scheduled('scheduled delivery')],
  ['A-B1d a Bot relay request', sourced('a request', { kind: 'bot', form: 'relay', role: 'request', senderName: 'Other' })],
  ['A-B1e a resumed relay', sourced('resumed handoff', { kind: 'user', handoff: true, resume: true })],
]) {
  test(`${label} opens OFF`, async t => {
    const w = world(t, { identity: ON })
    await turnOn(w, w.chat('direct'), message)
    assert.deepEqual(offContexts(w), [true])
    assert.deepEqual(servers(w), [['dsh']])
  })
}

test('A-B1h a DSH subagent origin opens OFF even with an owner-shaped input', async t => {
  const w = world(t, { identity: ON })
  await turnOn(w, subagentChat(w, 'child'), owner('from the parent'))
  assert.deepEqual(offContexts(w), [true])
})

test('owner turn with the switch ON for Codex: today\'s launch (ON), its own tools', async t => {
  const w = world(t, { identity: ON })
  await turnOn(w, w.chat('direct'), owner('owner turn'))
  assert.deepEqual(offContexts(w), [false])
  const live = w.adapter.live.get('direct')
  assert.equal(live.native, true)
  assert.equal(live.nativeManaged, true)
  assert.deepEqual(servers(w), [[]])
})

test('A-B1g an owner turn with a time-context row opens ON', async t => {
  const w = world(t, { identity: ON })
  const chat = w.chat('direct')
  chat.history.push(sourced('Current time.', { kind: 'time-context', form: 'snapshot' }))
  await turnOn(w, chat, owner('owner turn'))
  assert.deepEqual(offContexts(w), [false])
})

test('A-B1f/B1a a live ON then a scheduled turn remakes it OFF; a relay then the owner remakes OFF to ON', async t => {
  const w = world(t, { identity: ON })
  const chat = w.chat('direct')
  await turnOn(w, chat, owner('owner first'))
  const on = w.adapter.live.get('direct').run
  await turnOn(w, chat, scheduled('scheduled delivery'))
  assert.deepEqual(offContexts(w), [false, true])
  assert.equal(sessions(w).length, 2)
  await on.gone.catch(() => {})
  assert.equal(on.alive, false)
  const relayChat = w.chat('fresh')
  await turnOn(w, relayChat, freshRelay())
  const off = w.adapter.live.get('fresh').run
  await turnOn(w, relayChat, owner('owner after the relay'))
  assert.deepEqual(offContexts(w), [false, true, true, false])
  const [, , offPid, onPid] = pids(w)
  assert.notEqual(offPid, onPid)
  assert.equal(promptPids(w).at(-1), onPid)
  await off.gone.catch(() => {})
  assert.equal(off.alive, false)
})

test('A-S1 team registration during a standalone ON startup stops it before its first prompt; the next turn opens OFF', async t => {
  const w = world(t, { managed: false })
  const chat = w.chat('direct')
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const heldBack = w.adapter.heldBack.bind(w.adapter)
  let calls = 0
  t.mock.method(w.adapter, 'heldBack', async (...args) => {
    calls += 1
    if (calls === 2) { entered.resolve(); await gate.promise }
    return heldBack(...args)
  })
  const pending = turnOn(w, chat, owner('owner before the team'))
  await entered.promise
  w.identityReaders.register(() => undefined)
  gate.resolve()
  const stopped = await pending
  assert.deepEqual(textOf(stopped), [NOTICE])
  assert.deepEqual(promptPids(w), [])
  await turnOn(w, chat, owner('owner after the team'))
  assert.deepEqual(offContexts(w), [false, true])
})

test('A-S4 the switch turned OFF while the ON spawn prepares its bridge: no process, the notice, the next turn OFF', async t => {
  let identity = { ...ON(), needsDshTools: true }
  const w = world(t, { identity: () => identity })
  const listen = w.backchannel.listen.bind(w.backchannel)
  t.mock.method(w.backchannel, 'listen', async () => { identity = { name: 'Ada', needsDshTools: true }; return listen() })
  const chat = w.chat('direct')
  const stopped = await turnOn(w, chat, owner('owner turn'))
  assert.deepEqual(textOf(stopped), [NOTICE])
  assert.equal(sessions(w).length, 0)
  t.mock.restoreAll()
  await turnOn(w, chat, owner('owner again'))
  assert.deepEqual(offContexts(w), [false, true])
})

test('A-S5 Read only during a held ON startup ends it with the notice and no prompt; A-S6 a Stop there is a Stop', async t => {
  const w = world(t, { identity: () => ({ ...ON(), needsDshTools: true }) })
  const chat = w.chat('direct')
  const startup = holdNativeStartup(t, w)
  const pending = turnOn(w, chat, owner('owner turn'))
  const run = await startup.entered
  chat.session.append('sandbox/mode', { mode: 'read-only' })
  w.adapter.noteEvent(chat.session, { type: 'sandbox/mode', data: { mode: 'read-only' } })
  startup.release()
  const stopped = await pending
  assert.deepEqual(textOf(stopped), [NOTICE])
  assert.deepEqual(w.events('prompt').filter(row => row.pid === run.child.pid), [])
  const w2 = world(t, { identity: () => ({ ...ON(), needsDshTools: true }) })
  const chat2 = w2.chat('direct')
  const startup2 = holdNativeStartup(t, w2)
  const controller = new AbortController()
  const pending2 = turnOn(w2, chat2, owner('owner turn'), { signal: controller.signal })
  await startup2.entered
  controller.abort()
  startup2.release()
  assert.equal(finishOf(await pending2).kind, 'aborted')
})

test('A-RO Read only ends a live ON Codex at once; a live OFF and a live kept process keep their PID', async t => {
  const w = world(t, { identity: ON })
  const on = w.chat('on')
  await turnOn(w, on, owner('owner turn'))
  const off = w.chat('off')
  await turnOn(w, off, scheduled('scheduled'))
  const kept = w.chat('kept')
  await turnOn(w, kept, scheduled('scheduled kept'), { model: KEPT })
  for (const chat of [on, off, kept]) {
    chat.session.append('sandbox/mode', { mode: 'read-only' })
    w.adapter.noteEvent(chat.session, { type: 'sandbox/mode', data: { mode: 'read-only' } })
  }
  assert.equal(w.adapter.live.has('on'), false)
  assert.equal(w.adapter.live.has('off'), true)
  assert.equal(w.adapter.live.has('kept'), true)
})

test('A4 refusals before a process: the kill switch with OFF, and a refused check (no rollback, no repair, no prompt)', async t => {
  const w = world(t, { identity: OFF, dshTools: false })
  const chunks = await turnOn(w, w.chat('direct'), scheduled('scheduled'))
  assert.equal(finishOf(chunks).failure.code, 'acp/native-off-no-bridge')
  assert.equal(w.contexts.length, 0)
  assert.equal(sessions(w).length, 0)
  const w2 = world(t, { identity: OFF, offSpawn: () => Promise.reject(Object.assign(new Error('x'), { code: 'acp/native-off-unavailable', reason: 'a test refusal' })) })
  const rollback = t.mock.fn(() => true)
  const repair = t.mock.fn(() => true)
  Object.assign(w2.codex, { rollback, repair })
  const refused = await turnOn(w2, w2.chat('direct'), scheduled('scheduled'))
  assert.equal(finishOf(refused).failure.code, 'acp/native-off-unavailable')
  assert.match(finishOf(refused).failure.message, /Codex could not turn its own tools off \(a test refusal\), so the message was not sent/)
  assert.equal(rollback.mock.callCount(), 0)
  assert.equal(repair.mock.callCount(), 0)
  assert.equal(sessions(w2).length, 0)
  // A check made for another folder, or with no model, is refused the same way.
  const w3 = world(t, { identity: OFF, offSpawn: (context, launch) => Promise.resolve({ ...launch, nativeOff: true, checkedCwd: tmpdir(), models: [...CHECKED] }) })
  assert.equal(finishOf(await turnOn(w3, w3.chat('direct'), scheduled('scheduled'))).failure.code, 'acp/native-off-unavailable')
  const w4 = world(t, { identity: OFF, offSpawn: (context, launch) => Promise.resolve({ ...launch, nativeOff: true, checkedCwd: context.cwd, models: [] }) })
  assert.equal(finishOf(await turnOn(w4, w4.chat('direct'), scheduled('scheduled'))).failure.code, 'acp/native-off-unavailable')
})

// The Details switch is named only where it could turn this Codex ON.
test('A4 refusal texts point to the Details switch only in an eligible owner chat', async t => {
  const refuse = () => Promise.reject(Object.assign(new Error('x'),
    { code: 'acp/native-off-unavailable', reason: 'a test refusal' }))
  const SENT = 'Codex could not turn its own tools off (a test refusal),'
    + ' so the message was not sent.'
  const DETAILS = "Turn native tools on in the Bot's Details"
  const eligible = () => ({ name: 'Ada', nativeToolsBlocked: false })
  // Eligible own chat, switch OFF: the switch would help, so the text names it.
  const own = world(t, { identity: eligible, offSpawn: refuse })
  const ownTurn = await turnOn(own, own.chat('direct'), owner('owner'))
  assert.equal(finishOf(ownTurn).failure.message, `${SENT} ${DETAILS}, or update Automagik.`)
  // BI-1: a scheduled turn in that same direct chat is never ON, whatever the switch says.
  const timed = world(t, { identity: eligible, offSpawn: refuse })
  const timedTurn = await turnOn(timed, timed.chat('direct'), scheduled('scheduled'))
  const SWITCH = `${SENT} Switch its model, or update Automagik.`
  assert.equal(finishOf(timedTurn).failure.message, SWITCH)
  // A group, task or scheduled Session, or a blocked Bot, is never ON: no pointer to the
  // switch, one full stop.
  const blocked = () => ({ name: 'Ada', nativeToolsBlocked: true })
  for (const identity of [OFF, blocked, () => undefined]) {
    const w = world(t, { identity, offSpawn: refuse })
    const turn = await turnOn(w, w.chat('group'), scheduled('scheduled'))
    assert.equal(finishOf(turn).failure.message, `${SENT} Switch its model, or update Automagik.`)
  }
  // The kill switch with OFF: the same split.
  const ownOff = world(t, { identity: eligible, dshTools: false })
  const ownOffTurn = await turnOn(ownOff, ownOff.chat('direct'), owner('owner'))
  const ownText = finishOf(ownOffTurn).failure.message
  assert.ok(ownText.endsWith(`${DETAILS}, or turn Automagik's tools back on.`), ownText)
  const timedOff = world(t, { identity: eligible, dshTools: false })
  const timedOffTurn = await turnOn(timedOff, timedOff.chat('direct'), scheduled('scheduled'))
  const timedText = finishOf(timedOffTurn).failure.message
  assert.equal(timedText.includes(DETAILS), false, timedText)
  assert.ok(timedText.endsWith("Turn Automagik's tools back on, or switch its model."), timedText)
  const group = world(t, { identity: OFF, dshTools: false })
  const groupTurn = await turnOn(group, group.chat('group'), scheduled('scheduled'))
  const text = finishOf(groupTurn).failure.message
  assert.equal(text.includes(DETAILS), false)
  const tail = "so Codex was not started. Turn Automagik's tools back on, or switch its model."
  assert.ok(text.endsWith(tail), text)
})

test('A5/A6 OFF: Codex\'s own patch and sub-agent calls end the session with no card and never run; bridge calls and the MCP readers do not trip the backstop', async t => {
  const w = world(t, { identity: OFF })
  const chat = w.chat('direct')
  for (const [text, label] of [['codex-reader codex list_mcp_resources', 'codex reader'], ['codex-reader dsh read_mcp_resource', 'bridge reader'], ['codex-bridge bash', 'bridge call'], ['mcp-ask-bridge', 'bridge permission']]) {
    const chunks = await turnOn(w, chat, scheduled(text))
    assert.equal(finishOf(chunks).kind, 'stop', label)
    assert.equal(textOf(chunks).some(line => line.includes('Codex used one of its own tools')), false, label)
  }
  assert.ok(textOf(await turnOn(w, chat, scheduled('mcp-ask-bridge'))).join('').includes('MCP permission: yes'))
  const pid = pids(w).at(-1)
  for (const text of ['codex-edit-ask', 'codex-subagent']) {
    // A chat of its own: a fresh process replays the chat, and the fake answers the first trigger it reads.
    const chunks = await turnOn(w, w.chat(text), scheduled(text))
    assert.ok(textOf(chunks).includes('Codex used one of its own tools while they are off, so this answer stopped. Send your message again.'), text)
    assert.equal(chunks.some(chunk => chunk.block?.type === 'tool-call'), false, text)
    assert.equal(w.adapter.live.has(text), false, text)
  }
  assert.equal(w.events('patch-ran').length, 0)
  assert.equal(w.events('subagent-started').length, 1, 'the fake started it; the session ended at its first sight')
  assert.equal(w.adapter.live.get('direct').run.child.pid, pid, 'the bridge chat kept its process')
})

test('A5 permission line: under nativeOff a question for a call that is not the bridge\'s is refused with the agent\'s reject option', async () => {
  const ended = []
  const run = new AgentRun({ command: process.execPath, cwd: tmpdir(), name: 'Codex', nativeOff: true, dshTools: true, refresh: 'fork', onNativeOffCall: tool => ended.push(tool.kind) })
  const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
  const answer = await run.onPermission({ toolCall: { toolCallId: 'patch-1', title: 'Edit files?', kind: 'edit' }, options })
  assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'no' } })
  assert.deepEqual(ended, ['edit'])
  const bridge = await run.onPermission({ toolCall: { toolCallId: 'b-1', title: 'mcp.dsh.bash', kind: 'execute', rawInput: { server: 'dsh', tool: 'bash' }, _meta: { is_mcp_tool_call: true } }, _meta: { is_mcp_tool_approval: true }, options })
  run.seeTool({ toolCallId: 'b-2', title: 'mcp.dsh.bash', kind: 'execute', rawInput: { server: 'dsh', tool: 'bash' }, _meta: { is_mcp_tool_call: true } })
  assert.deepEqual(ended, ['edit'])
  void bridge
})

test('A7 an OFF turn clears a staged image grant and never activates it; A7b ON at the turn start and OFF at the spawn stops with the notice', async t => {
  const w = world(t, { identity: OFF })
  const chat = w.chat('direct')
  const lifetime = new AbortController()
  w.adapter.sessionFiles.owners.set('direct', { session: chat.session, lifetime, grant: { staged: true } })
  const chunks = await turnOn(w, chat, owner('owner turn'))
  assert.equal(w.adapter.sessionFiles.owners.has('direct'), false)
  assert.equal(textOf(chunks).some(line => /Image session permission changed/.test(line)), false)
  assert.deepEqual(offContexts(w), [true])
  let identity = ON()
  const w2 = world(t, { identity: () => identity })
  w2.codex.sessionFiles = true
  w2.codex.ownMode = undefined
  w2.services.sandboxPolicy.resolve = () => ({ mode: 'read-only' })
  w2.adapter.access = async () => { identity = OFF(); return undefined }
  const owners = []
  const make = w2.adapter.sessionFiles.owner.bind(w2.adapter.sessionFiles)
  t.mock.method(w2.adapter.sessionFiles, 'owner', (...args) => { const made = make(...args); owners.push(made); return made })
  const chat2 = w2.chat('direct')
  // Read only would keep ON from starting; ON at the start needs Workspace, so read that for the switch only.
  const read = w2.adapter.readLevel.bind(w2.adapter)
  t.mock.method(w2.adapter, 'readLevel', (session, failClosed) => ({ ...read(session, failClosed), sandbox: 'workspace-write' }))
  const flipped = await turnOn(w2, chat2, owner('owner turn'))
  if (owners.length > 0) {
    assert.deepEqual(textOf(flipped), [NOTICE])
    assert.equal(w2.contexts.length, 0)
    assert.equal(textOf(flipped).some(line => /exact image profile/.test(line)), false)
    assert.equal(w2.adapter.sessionFiles.owners.has('direct'), false)
  } else {
    t.diagnostic('A7b: the session-files block made no owner in this harness')
    assert.fail('A7b needs a staged owner')
  }
})

test('A9 model guard: a live OFF process takes a checked model on the same PID; an unchecked one is refused with zero prompts', async t => {
  const w = world(t, { identity: OFF })
  const chat = w.chat('direct')
  await turnOn(w, chat, scheduled('first'), { model: 'gpt-6.2-sol' })
  const [pid] = pids(w)
  await turnOn(w, chat, scheduled('second on luna'), { model: 'gpt-5.6-luna' })
  assert.deepEqual(pids(w), [pid])
  assert.equal(promptPids(w).filter(p => p === pid).length, 2)
  const refused = await turnOn(w, chat, scheduled('third on astra'), { model: 'gpt-6-astra' })
  assert.equal(finishOf(refused).failure.code, 'acp/native-off-unavailable')
  assert.match(finishOf(refused).failure.message, /this model was not checked/)
  assert.equal(promptPids(w).length, 2)
})

test('A10 Auto under OFF: no own mode is asked or sent, and a bridge edit goes through DSH', async t => {
  const w = world(t, { identity: OFF })
  w.services.permissionPresets = { current: () => 'auto' }
  const asked = t.mock.fn(() => () => 'yes')
  w.adapter.ownMode = asked
  writingTools(w)
  const chat = w.chat('direct')
  const file = join(chat.session.header.cwd, 'auto.txt')
  const chunks = await turnOn(w, chat, scheduled(`codex-bridge edit ${JSON.stringify({ path: file, text: 'auto' })}`))
  assert.equal(asked.mock.callCount(), 0)
  assert.equal(w.events('set-mode').some(row => row.modeId === 'agent'), false)
  assert.equal(lastMode(w), 'read-only')
  assert.equal(w.adapter.live.get('direct').own, false)
  // DSH's Auto path took the call (here its review has no route, so it refused): never a silent allow.
  assert.match(textOf(chunks).join(''), /Auto review cannot see this call/)
  assert.deepEqual(w.executed, [])
  assert.equal(existsSync(file), false)
})

test('A11 an OFF fork finds its checked catalog: a deleted file is written back with the same bytes; an unwritable folder refuses with zero prompts', async t => {
  const w = world(t, { identity: OFF })
  const chat = w.chat('direct')
  await turnOn(w, chat, scheduled('first'))
  const { offCatalog: catalog } = w.adapter.live.get('direct')
  rmSync(catalog.path)
  chat.session.append('sandbox/mode', { mode: 'danger-full-access' })
  w.services.approval.effectivePolicy = () => 'never'
  await turnOn(w, chat, scheduled('after the level change'))
  assert.ok(w.events('fork').length >= 1)
  assert.equal(readFileSync(catalog.path, 'utf8'), catalog.bytes)
  const before = w.events('prompt').length
  rmSync(catalog.path)
  const { chmodSync } = await import('node:fs')
  chmodSync(join(catalog.path, '..'), 0o500)
  t.after(() => { try { chmodSync(join(catalog.path, '..'), 0o700) } catch {} })
  chat.session.append('sandbox/mode', { mode: 'workspace-write' })
  w.services.approval.effectivePolicy = () => 'ask'
  const refused = await turnOn(w, chat, scheduled('after another change'))
  assert.equal(finishOf(refused).failure.code, 'acp/native-off-unavailable')
  assert.equal(w.events('prompt').length, before)
  assert.equal(w.adapter.live.has('direct'), false)
})

test('A-E endNative: a starting ON Codex and a live ON one before its first prompt get the notice; a live ON one after it the OFF text; live OFF and kept processes stay', async t => {
  const w = world(t, { identity: ON })
  const chat = w.chat('starting')
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  w.adapter.access = async () => { entered.resolve(); await gate.promise; return undefined }
  const pending = turnOn(w, chat, owner('owner turn'))
  await entered.promise
  assert.equal(w.adapter.endNative('starting', 'OFF text', NOTICE), true)
  gate.resolve()
  assert.deepEqual(textOf(await pending), [NOTICE])
  w.adapter.access = undefined
  const live = w.chat('live')
  await turnOn(w, live, owner('owner turn'))
  assert.equal(w.adapter.endNative('live', 'OFF text', NOTICE), true)
  assert.equal(w.adapter.live.has('live'), false)
  const off = w.chat('off')
  await turnOn(w, off, scheduled('scheduled'))
  const kept = w.chat('kept')
  await turnOn(w, kept, scheduled('kept'), { model: KEPT })
  assert.equal(w.adapter.endNative('off', 'OFF text', NOTICE), false)
  assert.equal(w.adapter.endNative('kept', 'OFF text', NOTICE), false)
  assert.equal(w.adapter.live.has('off'), true)
  assert.equal(w.adapter.live.has('kept'), true)
  // Claude keeps PR A's path: a held native startup answers the notice.
  const c = world(t, { identity: () => ({ name: 'Ada', nativeTools: true }) })
  const claudeChat = c.chat('claude')
  const startup = holdNativeStartup(t, c)
  const claudeTurn = turnOn(c, claudeChat, owner('owner turn'), { provider: CLAUDE })
  await startup.entered
  assert.equal(c.adapter.endNative('claude', 'OFF text', NOTICE), true)
  startup.release()
  assert.deepEqual(textOf(await claudeTurn), [NOTICE])
})

const keptKinds = [
  ['owner chat, switch ON', ON, () => owner('owner')],
  ['owner chat, switch OFF', OFF, () => owner('owner')],
  ['scheduled', ON, () => scheduled('scheduled')],
  ['relay request', ON, () => sourced('request', { kind: 'bot', form: 'relay', role: 'request', senderName: 'Other' })],
  ['group', () => ({ name: 'Ada' }), () => sourced('group message', { kind: 'user', principal: { kind: 'person', id: 'member' } })],
  ['identity-less', () => undefined, () => owner('owner')],
  ['restricted Bot (shell off)', () => ({ name: 'Ada', nativeToolsBlocked: true }), () => owner('owner')],
  ['Read only', ON, () => owner('owner'), true],
  ['DSH subagent origin', ON, () => owner('owner'), false, true],
]
for (const [label, identity, message, readOnly, sub] of keptKinds) {
  test(`K1 kept model gpt-5.5, ${label}: today's launch, no check`, async t => {
    const w = world(t, { identity })
    const chat = sub ? subagentChat(w, 'child') : w.chat('chat')
    if (readOnly) chat.session.append('sandbox/mode', { mode: 'read-only' })
    await turnOn(w, chat, message(), { model: KEPT })
    assert.deepEqual(offContexts(w), [false])
    assert.deepEqual(servers(w), [[]])
    const live = w.adapter.live.get(chat.session.id)
    assert.equal(live.native, true)
    assert.equal(live.nativeKept, true)
  })
}

test('K2 `default` resolved to the recorded start model gpt-5.5 is kept: today\'s launch', async t => {
  const w = world(t, { identity: OFF, start: KEPT })
  w.codex.catalog.ownModel = () => KEPT
  await turnOn(w, w.chat('direct'), scheduled('scheduled'))
  assert.deepEqual(offContexts(w), [false])
  assert.equal(w.adapter.live.get('direct').nativeKept, true)
})

test('K2b unknown start model: the OFF spawn on gpt-5.5 stops once with zero prompts, the next turn launches as today; an OFF run never records the start model', async t => {
  const w = world(t, { identity: OFF, start: KEPT })
  const chat = w.chat('direct')
  const first = await turnOn(w, chat, scheduled('first'))
  assert.deepEqual(textOf(first), [NOTICE])
  assert.deepEqual(promptPids(w), [])
  assert.equal(w.adapter.live.has('direct'), false)
  await turnOn(w, chat, scheduled('second'))
  assert.deepEqual(offContexts(w), [true, false])
  assert.equal(promptPids(w).length, 1)
  const w2 = world(t, { identity: OFF })
  await turnOn(w2, w2.chat('direct'), scheduled('checked start'))
  assert.equal(w2.adapter.startModels.has(w2.codex), false)
})

// BD-1: a Codex home whose own default model is gpt-5.5 (no tool block, as the real one) and a
// codex-acp that starts on it. The OFF spawn runs the real checks (nativeOffLaunch) on the fake CLI.
function homeDefaultWorld(t) {
  const fake = fakeCodex({ homeDefault: KEPT })
  const w = world(t, {
    identity: OFF, start: KEPT,
    offSpawn: (context, launch) => nativeOffLaunch(launch, { cwd: context.cwd, dir: join(context.cwd, '.codex-native-off'), kept: [KEPT], run: fake.run, signal: context.signal }),
  })
  return { w, fake }
}
const defaultReads = fake => fake.calls.filter(call => call.what === 'debug prompt-input' && call.model === undefined)

test('K2c a home default with no tool block: a checked model opens OFF; `default` with an unknown start stops once then launches as today; a known start launches as today', async t => {
  // A scheduled turn on a checked model opens OFF on the bridge alone, with one prompt.
  const a = homeDefaultWorld(t)
  const first = await turnOn(a.w, a.w.chat('direct'), scheduled('checked'), { model: 'gpt-6.2-sol' })
  assert.equal(finishOf(first)?.kind === 'error', false, JSON.stringify(textOf(first)))
  assert.deepEqual(offContexts(a.w), [true])
  assert.deepEqual(servers(a.w), [['dsh']])
  assert.equal(promptPids(a.w).length, 1)
  assert.ok(a.fake.calls.length > 0)
  assert.deepEqual(defaultReads(a.fake), [])
  // `default` with the start model unknown: the OFF process starts on gpt-5.5, stops once with
  // the notice and no prompt; the next turn is today's launch.
  const b = homeDefaultWorld(t)
  const chat = b.w.chat('direct')
  const stopped = await turnOn(b.w, chat, scheduled('first'))
  assert.deepEqual(textOf(stopped), [NOTICE])
  assert.deepEqual(promptPids(b.w), [])
  await turnOn(b.w, chat, scheduled('second'))
  assert.deepEqual(offContexts(b.w), [true, false])
  assert.equal(promptPids(b.w).length, 1)
  assert.deepEqual(defaultReads(b.fake), [])
  // The start model known (gpt-5.5): today's launch directly, no check.
  const c = homeDefaultWorld(t)
  c.w.codex.catalog.ownModel = () => KEPT
  await turnOn(c.w, c.w.chat('direct'), scheduled('known'))
  assert.deepEqual(offContexts(c.w), [false])
  assert.equal(promptPids(c.w).length, 1)
  assert.equal(c.fake.calls.length, 0)
})

// BF-1 and (b): a Codex whose copy models (`noBlock` picks them) answer with no tool block. The
// OFF spawn runs the real checks; `catalog` (a real Catalog) keeps the measured set on disk.
function noBlockWorld(t, noBlock, { catalog } = {}) {
  const fake = fakeCodex({ homeDefault: KEPT, answers: { prompt: ({ undone, model }) => undone === undefined && model !== undefined && noBlock(model) ? '[]' : undefined } })
  const w = world(t, {
    identity: OFF, start: KEPT,
    offSpawn: (context, launch) => nativeOffLaunch(launch, { cwd: context.cwd, dir: join(context.cwd, '.codex-native-off'), kept: [KEPT], run: fake.run, signal: context.signal }),
  })
  if (catalog !== undefined) w.codex.catalog = catalog
  return { w, fake }
}
function savedCatalog(t, { measured } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'codex-native-catalog-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'acp-codex.json'), `${JSON.stringify({ key: 'codex-test', at: Date.now(), start: null, models: [{ id: 'default', name: 'Codex' }], ...(measured ? { measured } : {}) })}\n`)
  const make = () => new Catalog({ id: 'acp-codex', name: 'Codex', defaultName: 'Codex', fallback: [{ id: 'default', name: 'Codex' }], home, key: () => 'codex-test', spawn: () => { throw new Error('no probe here') } })
  return { home, make }
}

test('K2d every model of the copy shows no tool block (B1-4): the OFF turn runs as today in the same turn, no notice; the models read kept; the next turn makes no check', async t => {
  const { w, fake } = noBlockWorld(t, () => true)
  const first = await turnOn(w, w.chat('direct'), scheduled('scheduled'), { model: 'gpt-6.2-sol' })
  assert.notEqual(finishOf(first)?.kind, 'error', JSON.stringify(textOf(first)))
  assert.equal(textOf(first).includes(NOTICE), false)
  assert.deepEqual(offContexts(w), [true, false])
  assert.deepEqual(servers(w), [[]])
  assert.equal(promptPids(w).length, 1)
  assert.equal(w.adapter.live.get('direct').nativeKept, true)
  assert.equal(w.adapter.live.get('direct').nativeOff, false)
  for (const slug of CHECKED) assert.equal(w.adapter.nativeKeptRoute(`acp-codex/${slug}`), true, slug)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6-astra'), false)
  const calls = fake.calls.length
  await turnOn(w, w.chat('second'), scheduled('again'), { model: 'gpt-6.2-sol' })
  assert.equal(fake.calls.length, calls)
  assert.deepEqual(offContexts(w), [true, false, false])
  assert.equal(promptPids(w).length, 2)
  // `default` with an unknown start model in such a home: today's launch in the same turn too.
  const b = noBlockWorld(t, () => true)
  const fallback = await turnOn(b.w, b.w.chat('direct'), scheduled('default'))
  assert.notEqual(finishOf(fallback)?.kind, 'error', JSON.stringify(textOf(fallback)))
  assert.equal(textOf(fallback).includes(NOTICE), false)
  assert.deepEqual(offContexts(b.w), [true, false])
  assert.equal(promptPids(b.w).length, 1)
  // A Stop during the checks stays a Stop.
  const c = noBlockWorld(t, () => true)
  const controller = new AbortController()
  controller.abort()
  const stopped = await turnOn(c.w, c.w.chat('direct'), scheduled('stopped'), { model: 'gpt-6.2-sol', signal: controller.signal })
  assert.deepEqual(promptPids(c.w), [])
  assert.equal(c.w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), false, JSON.stringify(textOf(stopped)))
})

test('K2e (b) one model with no tool block beside a checkable one: the OFF turn on it runs as today, the checkable one opens OFF, the row locks only the no-block model; the set is kept on disk', async t => {
  const saved = savedCatalog(t)
  const { w } = noBlockWorld(t, model => model === 'gpt-6.2-sol', { catalog: saved.make() })
  const first = await turnOn(w, w.chat('sol'), scheduled('on sol'), { model: 'gpt-6.2-sol' })
  assert.notEqual(finishOf(first)?.kind, 'error', JSON.stringify(textOf(first)))
  assert.equal(textOf(first).includes(NOTICE), false)
  assert.deepEqual(offContexts(w), [true, false])
  assert.deepEqual(servers(w), [[]])
  assert.equal(promptPids(w).length, 1)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), true)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-5.6-luna'), false)
  const luna = await turnOn(w, w.chat('luna'), scheduled('on luna'), { model: 'gpt-5.6-luna' })
  assert.notEqual(finishOf(luna)?.kind, 'error', JSON.stringify(textOf(luna)))
  assert.deepEqual(offContexts(w), [true, false, true])
  assert.deepEqual(servers(w).at(-1), ['dsh'])
  assert.equal(promptPids(w).length, 2)
  assert.equal(w.adapter.live.get('luna').nativeOff, true)
  // luna's check measured sol again (still no tool block): sol stays kept, luna stays checkable.
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), true)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-5.6-luna'), false)
  // After an app restart the row reads the set from the catalog's file at once.
  const after = world(t, { identity: OFF })
  after.codex.catalog = saved.make()
  assert.equal(after.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), true)
  assert.equal(after.adapter.nativeKeptRoute('acp-codex/gpt-5.6-luna'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(saved.home, 'acp-codex.json'), 'utf8')).measured.models, ['gpt-6.2-sol'])
})

// BG-1/BG-2: sol answers with no tool block and the setup's other answers are `answers`. The OFF
// spawn runs the real checks; the connector's rollback and repair are counted.
function measuringWorld(t, answers, { catalog, now } = {}) {
  const fake = fakeCodex({ homeDefault: KEPT, answers })
  const w = world(t, {
    identity: OFF, start: KEPT,
    offSpawn: (context, launch) => nativeOffLaunch(launch, {
      cwd: context.cwd, dir: join(context.cwd, '.codex-native-off'), kept: [KEPT], run: fake.run, signal: context.signal,
      ...(now === undefined ? {} : { now: () => now(fake) }),
    }),
  })
  if (catalog !== undefined) w.codex.catalog = catalog
  const rollback = t.mock.fn(() => false)
  const repair = t.mock.fn(() => false)
  Object.assign(w.codex, { rollback, repair })
  return { w, fake, rollback, repair }
}
const measuredOnDisk = saved => JSON.parse(readFileSync(join(saved.home, 'acp-codex.json'), 'utf8')).measured

test('BG-1 (a) Codex ignores shell_tool after sol showed no tool block: the sol turn runs as today, luna is refused, the record is merged, no rollback', async t => {
  const saved = savedCatalog(t, { measured: { key: 'codex-test', at: Date.now(), models: ['gpt-6-astra'] } })
  const { w, rollback, repair } = measuringWorld(t, { prompt: ignoresShell }, { catalog: saved.make() })
  const sol = await turnOn(w, w.chat('sol'), scheduled('on sol'), { model: 'gpt-6.2-sol' })
  assert.notEqual(finishOf(sol)?.kind, 'error', JSON.stringify(textOf(sol)))
  assert.equal(textOf(sol).includes(NOTICE), false)
  assert.deepEqual(offContexts(w), [true, false])
  assert.deepEqual(servers(w), [[]])
  assert.equal(promptPids(w).length, 1)
  assert.equal(w.adapter.live.get('sol').nativeKept, true)
  // The row locks sol; the earlier record is merged, never replaced.
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), true)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-5.6-luna'), false)
  assert.deepEqual(measuredOnDisk(saved).models, ['gpt-6-astra', 'gpt-6.2-sol'])
  const luna = await turnOn(w, w.chat('luna'), scheduled('on luna'), { model: 'gpt-5.6-luna' })
  assert.equal(finishOf(luna)?.kind, 'error')
  assert.equal(finishOf(luna).failure.code, 'acp/native-off-unavailable')
  assert.match(finishOf(luna).failure.message, /Codex ignores shell_tool/)
  assert.equal(promptPids(w).length, 1)
  assert.equal(rollback.mock.callCount(), 0)
  assert.equal(repair.mock.callCount(), 0)
})

test('BG-1 (b) the N4c refusals with a turn on sol: sol runs as today, luna is still refused', async t => {
  for (const [label, answers] of N4C) {
    const { w } = measuringWorld(t, answers)
    const sol = await turnOn(w, w.chat('sol'), scheduled('on sol'), { model: 'gpt-6.2-sol' })
    assert.notEqual(finishOf(sol)?.kind, 'error', `${label}: ${JSON.stringify(textOf(sol))}`)
    assert.deepEqual(offContexts(w), [true, false], label)
    assert.equal(promptPids(w).length, 1, label)
    assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), true, label)
    const luna = await turnOn(w, w.chat('luna'), scheduled('on luna'), { model: 'gpt-5.6-luna' })
    assert.equal(finishOf(luna)?.failure?.code, 'acp/native-off-unavailable', label)
    assert.match(finishOf(luna).failure.message, /no model could be checked/, label)
    assert.equal(promptPids(w).length, 1, label)
    assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-5.6-luna'), false, label)
  }
})

test('BG-1 (c) a deadline in step 8 after sol was measured: the sol turn is still refused in time, nothing is recorded', async t => {
  const saved = savedCatalog(t)
  const { w } = measuringWorld(t, { prompt: solNoBlock }, { catalog: saved.make(), now: fake => fake.calls.some(shellUndone) ? 1e12 : 0 })
  const sol = await turnOn(w, w.chat('sol'), scheduled('on sol'), { model: 'gpt-6.2-sol' })
  assert.equal(finishOf(sol)?.failure?.code, 'acp/native-off-unavailable')
  assert.match(finishOf(sol).failure.message, /in time/)
  assert.deepEqual(offContexts(w), [true])
  assert.equal(promptPids(w).length, 0)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), false)
  assert.equal(measuredOnDisk(saved), undefined)
})

test('BG-2 an exception inside the same-turn kept relaunch leaves the turn: no connector rollback, no repair', async t => {
  const { w, rollback, repair } = measuringWorld(t, { prompt: solNoBlock })
  const chat = w.chat('sol')
  chat.history.push(scheduled('on sol'))
  const stream = w.adapter.stream(markAgentLoopRequest({ provider: CODEX, model: 'gpt-6.2-sol', sessionId: chat.session.id, messages: [...chat.history] }))
  const first = await stream.next()
  assert.equal(first.done, false)
  // The relaunch is running the kept turn (OFF check, then today's launch).
  assert.deepEqual(offContexts(w), [true, false])
  await assert.rejects(stream.throw(new Error('thrown inside the kept turn')), /thrown inside the kept turn/)
  assert.equal(rollback.mock.callCount(), 0)
  assert.equal(repair.mock.callCount(), 0)
})

test('BG-3 a measured record older than a day with the same key keeps the row locked while its turn measures again; another key unlocks the row', async t => {
  const old = { key: 'codex-test', at: Date.now() - 2 * 24 * 3600_000, models: ['gpt-6.2-sol'] }
  const saved = savedCatalog(t, { measured: old })
  const w = world(t, { identity: OFF })
  w.codex.catalog = saved.make()
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), true)
  assert.equal(w.adapter.nativeKeptRoute('acp-codex/gpt-5.6-luna'), false)
  assert.equal(w.adapter.nativeKept(w.codex, 'gpt-6.2-sol'), false)
  const other = savedCatalog(t, { measured: { ...old, key: 'codex-other' } })
  const w2 = world(t, { identity: OFF })
  w2.codex.catalog = other.make()
  assert.equal(w2.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), false)
  // The turn on sol checks again: sol now shows its tools, so it opens OFF and the row unlocks.
  const again = savedCatalog(t, { measured: old })
  const { w: w3 } = noBlockWorld(t, () => false, { catalog: again.make() })
  const sol = await turnOn(w3, w3.chat('sol'), scheduled('on sol'), { model: 'gpt-6.2-sol' })
  assert.notEqual(finishOf(sol)?.kind, 'error', JSON.stringify(textOf(sol)))
  assert.deepEqual(offContexts(w3), [true])
  assert.equal(w3.adapter.live.get('sol').nativeOff, true)
  assert.equal(w3.adapter.nativeKeptRoute('acp-codex/gpt-6.2-sol'), false)
  assert.deepEqual(measuredOnDisk(again).models, [])
})

test('K3 a live OFF process asked for gpt-5.5 is remade with today\'s launch; the OFF PID gets no prompt', async t => {
  const w = world(t, { identity: OFF })
  const chat = w.chat('direct')
  await turnOn(w, chat, scheduled('off first'))
  const off = w.adapter.live.get('direct').run
  await turnOn(w, chat, scheduled('now kept'), { model: KEPT })
  assert.deepEqual(offContexts(w), [true, false])
  const [offPid, keptPid] = pids(w)
  assert.deepEqual(promptPids(w), [offPid, keptPid])
  await off.gone.catch(() => {})
  assert.equal(off.alive, false)
})

test('K4 a live kept process meeting a checked model is remade: OFF for a non-owner turn, ON for an eligible owner turn', async t => {
  const w = world(t, { identity: ON })
  const chat = w.chat('direct')
  await turnOn(w, chat, scheduled('kept'), { model: KEPT })
  await turnOn(w, chat, scheduled('checked'), { model: 'gpt-6.2-sol' })
  assert.deepEqual(offContexts(w), [false, true])
  assert.deepEqual(servers(w).at(-1), ['dsh'])
  const chat2 = w.chat('direct2')
  await turnOn(w, chat2, scheduled('kept'), { model: KEPT })
  await turnOn(w, chat2, owner('owner on checked'), { model: 'gpt-6.2-sol' })
  assert.deepEqual(offContexts(w), [false, true, false, false])
  assert.equal(sessions(w).length, 4)
  assert.equal(w.adapter.live.get('direct2').nativeManaged, true)
})

test('K5 a kept-launched process whose `default` turned out checked stops once on a non-owner turn; the next turn opens OFF', async t => {
  const w = world(t, { identity: ON, start: 'gpt-6.2-sol' })
  w.codex.catalog.ownModel = () => KEPT
  const chat = w.chat('direct')
  const first = await turnOn(w, chat, scheduled('first'))
  assert.deepEqual(textOf(first), [NOTICE])
  assert.deepEqual(promptPids(w), [])
  assert.equal(w.adapter.startModels.get(w.codex), 'gpt-6.2-sol')
  await turnOn(w, chat, scheduled('second'))
  assert.deepEqual(offContexts(w), [false, true])
})

test('K6 nativeKeptRoute (the service nativeModelKept): the kept list, `default` by its start model, nothing else', async t => {
  const w = world(t, { identity: OFF })
  const kept = route => w.adapter.nativeKeptRoute(route)
  assert.equal(kept('acp-codex/gpt-5.5'), true)
  for (const route of ['acp-codex/gpt-5.6-luna', 'acp-claude/gpt-5.5', 'acp-claude/default', 'garbage', '', '/gpt-5.5', undefined, 42]) assert.equal(kept(route), false, String(route))
  assert.equal(kept('acp-codex/default'), false)
  w.codex.catalog.ownModel = () => KEPT
  assert.equal(kept('acp-codex/default'), true)
  w.codex.catalog.ownModel = () => { throw new Error('broken') }
  assert.equal(kept('acp-codex/default'), false)
})

// ---------------------------------------------------------------------------------------------
// BD-4: index.js's own wiring, through apply(): the two service methods and the Codex agent's OFF
// spawn branch. The adapter is a stand-in codex-acp whose `cli` answers from the captures
// (fixtures/fake-codex-cli.mjs); no real Codex, no real Codex home.
// ---------------------------------------------------------------------------------------------
const FAKE_CLI = join(import.meta.dirname, 'fixtures', 'fake-codex-cli.mjs')

function applied(t, { isolated, platform, profileCheck = () => true }) {
  const root = mkdtempSync(join(tmpdir(), 'codex-native-apply-'))
  const disposers = []
  const logs = []
  const services = {}
  let adapter
  const ctx = {
    logger: { warn: line => logs.push(line), info: line => logs.push(line) },
    llm: { registerAdapter: (_ids, value) => { adapter = value; return Object.assign(() => {}, { replace() {} }) } },
    agents: { list: () => [], get: () => undefined },
    get: name => services[name],
    on() {},
    provide: (name, value) => { services[name] = value },
    effect: setup => disposers.push(setup()),
  }
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    rmSync(root, { recursive: true, force: true })
  })
  const home = join(root, 'acp', 'adapters')
  const store = { binOf: () => ({ path: FAKE_CLI, version: 'test' }), busy: () => false, update: async () => {}, dispose() {}, ...(isolated ? { home } : {}) }
  apply(ctx, { claude: true, codex: true, dshTools: false }, {
    store,
    cliHome: isolated ? join(root, 'homes') : undefined,
    consentFile: join(root, 'consent.json'),
    find: name => ['claude', 'codex'].includes(name) ? process.execPath : undefined,
    signedIn: async () => false,
    account: async () => undefined,
    profileCheck,
    ...(platform === undefined ? {} : { platform }),
  })
  return { root, home, logs, adapter, service: services.acpAgents, codex: adapter.agents.get('acp-codex') }
}

test('BD-4 apply(): nativeModelKept and endNative are wired; the OFF spawn refuses without chat profiles and checks in the ACP folder with the kept list', async t => {
  const a = applied(t, { isolated: true })
  assert.equal(a.service.nativeModelKept('acp-codex/gpt-5.5'), true)
  assert.equal(a.service.nativeModelKept('acp-codex/gpt-6.2-sol'), false)
  assert.equal(typeof a.service.endNative, 'function')
  assert.equal(a.service.endNative('no-such-session', 'off', 'changed'), false)
  // No chat profiles (no isolated homes): refused before any check.
  const b = applied(t, { isolated: false })
  await assert.rejects(b.codex.spawn({ nativeOff: true, cwd: b.root }), error => {
    assert.equal(error.code, 'acp/native-off-unavailable')
    assert.match(error.message, /its permission profiles are unavailable/)
    return true
  })
  // With profiles: the real checks run on the stand-in CLI, in the ACP folder's codex-native-off,
  // with the row's kept list (gpt-5.5 is never probed, so no line drops it).
  if (process.platform === 'win32') return
  const cwd = join(a.root, 'chat')
  mkdirSync(cwd)
  const launched = await a.codex.spawn({ nativeOff: true, cwd })
  const dir = join(dirname(a.home), 'codex-native-off')
  assert.equal(launched.nativeOff, true)
  assert.equal(launched.checkedCwd, cwd)
  assert.deepEqual(launched.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.equal(dirname(launched.offCatalog.path), dir)
  const config = JSON.parse(launched.env.CODEX_CONFIG)
  assert.equal(config.model_catalog_json, launched.offCatalog.path)
  assert.equal('model' in config, false)
  assert.deepEqual(JSON.parse(readFileSync(launched.offCatalog.path, 'utf8')).models.map(model => model.slug), ['gpt-6.2-sol', 'gpt-5.6-luna'])
  assert.ok(launched.profileModes)
  assert.ok(a.logs.some(line => /Codex runs with its own tools off; .*models 2\/3$/.test(line)), a.logs.join('\n'))
  assert.equal(a.logs.some(line => line.includes('gpt-5.5 could not be checked')), false)
  assert.equal(a.logs.some(line => line.includes('gpt-5.5 shows no tools')), false)
  assert.deepEqual(launched.unverified, [])
  // A measured set recorded through the adapter reads kept in the service (BF-1).
  a.adapter.recordMeasured(a.codex, ['gpt-6.2-sol'])
  assert.equal(a.service.nativeModelKept('acp-codex/gpt-6.2-sol'), true)
  assert.equal(a.service.nativeModelKept('acp-codex/gpt-5.6-luna'), false)
})

// ---------------------------------------------------------------------------------------------
// Windows OFF: Codex has no chat permission profiles there, so an OFF Codex takes its legacy
// `read-only` mode as the backstop; its own tools still go through the checked config and the
// bridge is still forced. win32 is simulated through apply()'s `platform` only.
// ---------------------------------------------------------------------------------------------
const configsUnder = root => readdirSync(root, { recursive: true })
  .filter(path => String(path).endsWith('config.toml'))

test('Windows OFF spawn: no chat profiles needed or written, the same checks; Linux still refuses',
  async t => {
    const checks = []
    const w = applied(t, {
      isolated: true, platform: 'win32',
      profileCheck: (...args) => { checks.push(args); return true },
    })
    const cwd = join(w.root, 'chat')
    mkdirSync(cwd)
    const launched = await w.codex.spawn({ nativeOff: true, cwd })
    assert.equal(launched.nativeOff, true)
    assert.equal(launched.profileModes, undefined)
    assert.equal(launched.checkedCwd, cwd)
    assert.deepEqual(launched.models, ['gpt-6.2-sol', 'gpt-5.6-luna'])
    assert.equal(JSON.parse(launched.env.CODEX_CONFIG).model_catalog_json, launched.offCatalog.path)
    assert.deepEqual(checks, [], 'no `codex sandbox -P` check')
    assert.deepEqual(configsUnder(w.root), [], 'no chat profiles written')
    const off = /Codex runs with its own tools off/
    assert.ok(w.logs.some(line => off.test(line)), w.logs.join('\n'))
    // With no ACP folder there is still no OFF check to run: refused for that, not for profiles.
    const bare = applied(t, { isolated: false, platform: 'win32' })
    const noFolder = /it has no settings folder/
    await refused(bare.codex.spawn({ nativeOff: true, cwd: bare.root }), noFolder)
    const PROFILES = /its permission profiles are unavailable/
    const linux = applied(t, { isolated: false, platform: 'linux' })
    await refused(linux.codex.spawn({ nativeOff: true, cwd: linux.root }), PROFILES)
    const unchecked = applied(t, { isolated: true, platform: 'linux', profileCheck: () => false })
    await refused(unchecked.codex.spawn({ nativeOff: true, cwd: unchecked.root }), PROFILES)
  })

test('Windows OFF turn: DSH\'s tools on the legacy read-only mode; missing, refused', async t => {
  // The world's Codex process is the fake ACP agent; its OFF start is index.js's own spawn.
  const through = (platform, isolated = true) => {
    const host = applied(t, { isolated, platform })
    return async (context, launch) => {
      const { command, args, env, ...checked } = await host.codex.spawn(context)
      return { ...launch, env: { ...launch.env, CODEX_CONFIG: env.CODEX_CONFIG }, ...checked }
    }
  }
  const w = world(t, { identity: OFF, offSpawn: through('win32') })
  const chunks = await turnOn(w, w.chat('direct'), scheduled('scheduled delivery'))
  assert.equal(finishOf(chunks).kind, 'stop')
  assert.ok(textOf(chunks).length > 0)
  assert.deepEqual(offContexts(w), [true])
  assert.deepEqual(servers(w), [['dsh']], 'only the DSH bridge')
  const live = w.adapter.live.get('direct')
  assert.equal(live.nativeOff, true)
  assert.equal(live.profileModes, undefined)
  assert.equal(lastMode(w), 'read-only')
  assert.equal(promptPids(w).length, 1)
  // A Codex that does not offer `read-only` fails the turn before any prompt.
  const env = { FAKE_ACP_MODES: 'workspace-write,agent,agent-full-access' }
  const m = world(t, { identity: OFF, offSpawn: through('win32'), env })
  const missing = await turnOn(m, m.chat('direct'), scheduled('scheduled delivery'))
  assert.equal(finishOf(missing).kind, 'error')
  assert.match(finishOf(missing).failure.message,
    /would not take DSH's permission level: it offers none of the modes read-only/)
  assert.deepEqual(m.events('prompt'), [])
  // Linux: the same OFF turn with no chat profiles is refused, as before.
  const l = world(t, { identity: OFF, offSpawn: through('linux', false) })
  const linux = await turnOn(l, l.chat('direct'), scheduled('scheduled delivery'))
  assert.equal(finishOf(linux).failure.code, 'acp/native-off-unavailable')
  assert.match(finishOf(linux).failure.message, /its permission profiles are unavailable/)
  assert.deepEqual(l.events('prompt'), [])
})
