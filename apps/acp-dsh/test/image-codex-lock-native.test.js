// Opt-in, credential-free Codex + codex-acp against a local SSE fixture. No hosted model.
// The view_image cases prove this profile's enforcement, not that the hosted image tool
// reads through it. The real-app edit step remains necessary for that separate claim.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { checkProfile, IMAGE_PROFILE_DESCRIPTION, IMAGE_PROFILE_GRANTS, imageOverrides, imageProfileFor, imageSetup, readProfile, toToml } from '../src/host/image.js'

const binary = process.env.AUTOMAGIK_TEST_CODEX
const acp = process.env.AUTOMAGIK_TEST_CODEX_ACP
const skip = !['linux', 'darwin'].includes(process.platform) || !binary || !acp
  ? 'set AUTOMAGIK_TEST_CODEX and AUTOMAGIK_TEST_CODEX_ACP on Linux or macOS' : false
if (process.env.AUTOMAGIK_REQUIRE_IMAGE_LOCK_TEST === '1') assert.equal(skip, false, 'the real image lock tests must run')
const readSkip = skip || (process.platform !== 'linux' || spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status !== 0 ? 'image lock reads require Linux with bwrap' : false)
if (process.env.AUTOMAGIK_REQUIRE_IMAGE_LOCK_READS === '1') assert.equal(readSkip, false, 'the real image lock reads must run')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const proxy = 'http://127.0.0.1:9'
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const table = profile => `[permissions.${profile.id}]\ndescription = ${toToml(IMAGE_PROFILE_DESCRIPTION)}\n[permissions.${profile.id}.filesystem]\n${Object.entries(IMAGE_PROFILE_GRANTS).map(([key, value]) => `${toToml(key)} = ${toToml(value)}`).join('\n')}\n`

async function fixture(t, { managed = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-image-lock-')))
  const runs = []
  let server
  t.after(async () => {
    for (const run of runs) await run.stop().catch(() => {})
    server?.closeAllConnections()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })
  for (const dir of ['home', 'codex', 'tmp', 'outside']) mkdirSync(join(root, dir))
  const scratch = realpathSync(mkdtempSync(join(root, 'scratch-')))
  const sibling = realpathSync(mkdtempSync(join(root, 'scratch-')))
  const codexHome = realpathSync(join(root, 'codex'))
  const configFile = join(codexHome, 'config.toml')
  const profile = managed ? imageProfileFor(ensureChatProfiles(codexHome, { codexPath: binary }))
    : { id: `automagik-image-${'a'.repeat(32)}`, mode: `permission-profile:automagik-image-${'a'.repeat(32)}` }
  assert.ok(profile)
  if (!managed) writeFileSync(configFile, '')
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CODEX_HOME: codexHome, CODEX_PATH: binary,
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'home/config'), XDG_CACHE_HOME: join(root, 'home/cache'), XDG_DATA_HOME: join(root, 'home/data'),
    AUTOMAGIK_BOT_CLI_HOME: root, AUTOMAGIK_BOT_CLI_VERSION: '', NO_COLOR: '1',
    OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '', CODEX_CONFIG: '{}',
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
  }
  const launch = { command: process.execPath, args: [acp], env }
  const peers = new Map()
  let sequence = 0
  server = createServer(async (req, res) => {
    const peer = peers.get(req.url?.split('/')[1])
    if (!peer) { res.writeHead(404).end(); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body
    try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }
    peer.inputs.push(body.input)
    const path = peer.steps.shift(), n = ++sequence, id = `resp_${n}`
    const item = path === undefined
      ? { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] }
      : { type: 'custom_tool_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec', namespace: 'functions', input: `text(await tools.view_image(${JSON.stringify({ path })}));`, status: 'completed' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('response.created', { response: { id, status: 'in_progress', output: [] } })
    emit('response.output_item.added', { output_index: 0, item })
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
    res.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const checked = async (cwd = scratch) => {
    let resolved
    const capture = (command, args, options, callback) => execFile(command, args, options, (error, stdout, stderr) => {
      if (args.includes('prompt-input')) resolved = readProfile(stdout)
      callback(error, stdout, stderr)
    })
    const setup = await imageSetup(launch, { cwd, profile, run: capture })
    assert.ok(checkProfile(resolved, { scratch: cwd, codexHome }))
    return { setup, resolved }
  }
  const start = async (overrides, { cwd = scratch, steps = [], select = true } = {}) => {
    const key = `peer${peers.size}`
    const peer = { inputs: [], steps: [...steps] }
    peers.set(key, peer)
    const provider = { model: 'gpt-6.1-sol', model_provider: 'isolated', model_providers: { isolated: {
      name: 'isolated fixed fixture', base_url: `http://127.0.0.1:${server.address().port}/${key}/v1`, wire_api: 'responses', requires_openai_auth: false,
    } }, shell_environment_policy: { inherit: 'none' }, analytics: { enabled: false }, feedback: { enabled: false } }
    const run = new AgentRun({ ...launch, env: { ...env, CODEX_CONFIG: JSON.stringify({ ...overrides, ...provider }) }, cwd, name: 'Codex', mcpServers: [], startMs: 20000, requestMs: 15000 })
    runs.push(run)
    await run.start()
    if (select) {
      assert.ok(run.modes?.availableModes?.some(mode => mode.id === profile.mode), 'home image mode is offered')
      assert.equal(run.modes.currentModeId, profile.mode)
      await run.setMode(profile.mode, { force: true })
    }
    return { run, peer }
  }
  return { root, scratch, sibling, codexHome, configFile, profile, launch, checked, start }
}

async function turn({ run }) {
  const prompting = run.prompt([{ type: 'text', text: 'Run the fixed fixture.' }])
  prompting.catch(() => {})
  for (;;) {
    const event = await run.next()
    assert.notEqual(event.type, 'error', 'the credential-free fixture turn must finish')
    assert.notEqual(event.type, 'aborted', 'the fixture turn must not be aborted')
    if (event.type === 'end') break
  }
  await prompting
}
const profileOf = state => readProfile(JSON.stringify(state.peer.inputs[0]))
const normalized = resolved => ({ ...resolved, entries: resolved.entries.map(entry => ({ ...entry,
  ...(entry.path?.includes('/tmp/arg0-') ? { path: entry.path.replace(/codex-arg0[A-Za-z0-9]+$/, 'codex-arg0SUFFIX') } : {}),
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })

test('real image lock: the resolved profile is exactly the image grants', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t)
  const before = readFileSync(f.configFile)
  const { setup, resolved } = await f.checked()
  const state = await f.start(setup.overrides)
  assert.equal(lstatSync(join(f.scratch, '.codex'), { throwIfNoEntry: false }), undefined, 'scratch has no .codex entry after mode acknowledgement')
  await turn(state)
  assert.equal(state.peer.inputs.length, 1, 'one prompt and one fixed response')
  const actual = profileOf(state)
  assert.ok(checkProfile(actual, { scratch: f.scratch, codexHome: f.codexHome }))
  assert.deepEqual(normalized(actual), normalized(resolved))
  assert.deepEqual(readFileSync(f.configFile), before)
})

test('real image lock: a wider home table is caught', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside')
  appendFileSync(f.configFile, `${toToml(outside)} = 'read'\n`)
  const before = readFileSync(f.configFile)
  await assert.rejects(imageSetup(f.launch, { cwd: f.scratch, profile: f.profile }), error => error.kind === 'profile')
  const state = await f.start(imageOverrides({ project: f.scratch, profile: f.profile }))
  await turn(state)
  const resolved = profileOf(state)
  assert.ok(resolved?.entries.some(entry => entry.access === 'read' && entry.path === outside))
  assert.equal(checkProfile(resolved, { scratch: f.scratch, codexHome: f.codexHome }), false)
  assert.deepEqual(readFileSync(f.configFile), before)
})

test('real image lock: a project layer that widens it is caught', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside')
  appendFileSync(f.configFile, `\n[projects.${toToml(f.scratch)}]\ntrust_level = 'trusted'\n`)
  mkdirSync(join(f.scratch, '.codex'))
  writeFileSync(join(f.scratch, '.codex/config.toml'), `[permissions.${f.profile.id}.filesystem]\n${toToml(outside)} = 'read'\n`)
  await assert.rejects(imageSetup(f.launch, { cwd: f.scratch, profile: f.profile }), error => error.kind === 'profile')
})

test("real image lock: today's project file is never offered", { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, { managed: false })
  mkdirSync(join(f.scratch, '.codex'))
  writeFileSync(join(f.scratch, '.codex/config.toml'), `default_permissions = ${toToml(f.profile.id)}\n${table(f.profile)}`)
  const state = await f.start(imageOverrides({ project: f.scratch }), { select: false })
  assert.equal(state.run.modes?.availableModes?.some(mode => mode.id === f.profile.mode), false)
  assert.equal(state.peer.inputs.length, 0)
})

function assertReads(state, expectations, homeBytes) {
  const items = state.peer.inputs.flat()
  const calls = new Map(items.filter(row => row.type === 'custom_tool_call').map(row => [row.call_id, row.input]))
  const outputs = new Map(items.filter(row => row.type === 'custom_tool_call_output').map(row => [row.call_id, JSON.stringify(row.output)]))
  for (const [path, allowed] of expectations) {
    const call = [...calls].find(([, input]) => input.includes(JSON.stringify(path).slice(1, -1)))
    assert.ok(call, 'the scripted read was actually called')
    const output = outputs.get(call[0])
    assert.equal(typeof output, 'string', 'the scripted read returned a result')
    if (allowed) assert.ok(output.includes(PNG.toString('base64')), 'own scratch PNG returned byte for byte')
    else {
      assert.match(output, /unable to locate image|ENOENT|not found|No such file|Permission denied/i)
      assert.equal(output.includes(PNG.toString('base64')), false, 'denied PNG returned no bytes')
      assert.equal(output.includes(homeBytes.toString('base64')), false, 'denied config returned no bytes')
      assert.equal(output.includes(xml(homeBytes.toString())), false, 'denied config returned no text')
    }
  }
}
const forReads = overrides => ({ ...overrides, features: { ...overrides.features, view_image: true, shell_tool: false } })

test('real image lock reads: only the scratch PNG is readable', { skip: readSkip, timeout: 90000 }, async t => {
  const f = await fixture(t)
  const own = join(f.scratch, 'inside.png'), sibling = join(f.sibling, 'inside.png'), outside = join(f.root, 'outside/outside.png')
  for (const path of [own, sibling, outside]) writeFileSync(path, PNG)
  const before = readFileSync(f.configFile)
  const { setup } = await f.checked()
  const expectations = [[own, true], [sibling, false], [outside, false], [f.configFile, false]]
  const state = await f.start(forReads(setup.overrides), { steps: expectations.map(([path]) => path) })
  await turn(state)
  assert.ok(checkProfile(profileOf(state), { scratch: f.scratch, codexHome: f.codexHome }))
  assertReads(state, expectations, before)
  assert.deepEqual(readFileSync(f.configFile), before)
})

test("real image lock reads: concurrent sessions cannot read each other's scratch", { skip: readSkip, timeout: 90000 }, async t => {
  const f = await fixture(t)
  const a = join(f.scratch, 'inside.png'), b = join(f.sibling, 'inside.png')
  for (const path of [a, b]) writeFileSync(path, PNG)
  const before = readFileSync(f.configFile)
  const checked = await Promise.all([f.checked(f.scratch), f.checked(f.sibling)])
  // Initialize the shared home's SQLite state before racing two sessions against it.
  const warm = await f.start(forReads(checked[0].setup.overrides))
  await warm.run.stop()
  const states = await Promise.all([
    f.start(forReads(checked[0].setup.overrides), { cwd: f.scratch, steps: [a, b] }),
    f.start(forReads(checked[1].setup.overrides), { cwd: f.sibling, steps: [b, a] }),
  ])
  assert.ok(states.every(state => state.run.alive))
  await Promise.all(states.map(turn))
  assertReads(states[0], [[a, true], [b, false]], before)
  assertReads(states[1], [[b, true], [a, false]], before)
  for (const [index, scratch] of [f.scratch, f.sibling].entries()) assert.ok(checkProfile(profileOf(states[index]), { scratch, codexHome: f.codexHome }))
  assert.deepEqual(readFileSync(f.configFile), before)
})
