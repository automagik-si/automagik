// The image run's lockdown against a real Codex and a real codex-acp (image.js, #870). Opt-in:
// The ordinary plugin CI job installs neither; every test here skips unless both are named:
//   AUTOMAGIK_TEST_CODEX_ACP  codex-acp's dist/index.js
//   AUTOMAGIK_TEST_CODEX      a Codex executable (the native one, or its launcher)
// Codex runs in a throwaway HOME and CODEX_HOME made here: it is never signed in, no model
// request is sent, and nothing of the person's own Codex home is read or written.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createInterface } from 'node:readline'
import { AgentRun } from '../src/host/acp.js'
import { checkFeatures, checkOffered, configArgs, IMAGE_FEATURES_ALSO_OFF, IMAGE_FEATURES_OFF, imageProfileFor, imageSetup, readFeatures, readOffered } from '../src/host/image.js'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { isAuthRequired } from '../src/host/names.js'

const ADAPTER = process.env.AUTOMAGIK_TEST_CODEX_ACP
const CODEX = process.env.AUTOMAGIK_TEST_CODEX
const skip = ADAPTER && CODEX ? false : 'set AUTOMAGIK_TEST_CODEX_ACP and AUTOMAGIK_TEST_CODEX to run against a real Codex'

function home(t, config = '') {
  // The root stays as mkdtemp names it: the macOS temp folder is reached through a symlink,
  // and the product must resolve the run's folder before it trusts or starts in it.
  const root = mkdtempSync(join(tmpdir(), 'acp-image-codex-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['home', 'codex', 'cwd']) mkdirSync(join(root, dir))
  if (config !== '') writeFileSync(join(root, 'codex', 'config.toml'), config)
  // No key of the person's own reaches Codex: it must stay signed out.
  const env = {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CODEX_PATH: CODEX,
    OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '', NO_COLOR: '1',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
  return { root, env, launch: { command: process.execPath, args: [ADAPTER], env } }
}
const cli = (launch, args) => new Promise((resolve, reject) => {
  execFile(launch.command, [...launch.args, 'cli', ...args], { env: { ...process.env, ...launch.env, NO_COLOR: '1' }, cwd: tmpdir(), timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
})

// A fixed loopback Responses peer, so a real codex-acp session can run signed out. One ordinary
// answer is returned; nothing leaves this computer and no model is asked.
async function fixedPeer(t) {
  const inputs = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body
    try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }
    inputs.push(body.input)
    const n = inputs.length
    const id = `resp_${n}`
    const item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('response.created', { response: { id, status: 'in_progress', output: [] } })
    emit('response.output_item.added', { output_index: 0, item })
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
    res.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); if (server.listening) server.close() })
  return { port: server.address().port, inputs }
}
const provider = port => ({
  model: 'gpt-6.1-sol',
  model_provider: 'automagik-image-test',
  model_providers: {
    'automagik-image-test': {
      name: 'fixed loopback test peer', base_url: `http://127.0.0.1:${port}/v1`,
      wire_api: 'responses', requires_openai_auth: false,
    },
  },
  shell_environment_policy: { inherit: 'none' },
  analytics: { enabled: false },
  feedback: { enabled: false },
})
const execDescription = input => (input ?? [])
  .flatMap(item => (item.type === 'additional_tools' ? item.tools ?? [] : []))
  .find(tool => tool.name === 'functions')?.tools?.find(tool => tool.name === 'exec')?.description ?? ''

// The session's own path: CODEX_CONFIG goes to codex-acp, which hands it to Codex per thread.
// A signed-out Codex stops at `session/new` without a provider, so this starts a real session
// with the fixed loopback peer and reads the model-visible tools Codex itself built.
async function session(t, launch, env, cwd, overrides, peer) {
  const run = new AgentRun({
    ...launch, env: { ...env, CODEX_CONFIG: JSON.stringify(overrides) }, cwd, name: 'Codex',
    mcpServers: [], startMs: 20000, requestMs: 15000,
  })
  t.after(() => run.dispose())
  await run.start()
  const prompting = run.prompt([{ type: 'text', text: 'Say done.' }])
  prompting.catch(() => {})
  for (;;) {
    const event = await run.next()
    assert.notEqual(event.type, 'error', 'the fixed peer turn must finish')
    assert.notEqual(event.type, 'aborted', 'the fixed peer turn must not be aborted')
    if (event.type === 'end') break
  }
  await prompting
  await run.stop().catch(() => {})
  return execDescription(peer.inputs.at(-1))
}

test('real Codex: the shipped lists pass, and the tools left are the allowed ones', { skip }, async (t) => {
  const { root, launch } = home(t)
  const made = await imageSetup(launch, { cwd: join(root, 'cwd') })
  assert.deepEqual(made.overrides.projects, { [realpathSync(join(root, 'cwd'))]: { trust_level: 'trusted' } })
  assert.deepEqual(made.servers, [])
  for (const name of made.extras) assert.ok(IMAGE_FEATURES_ALSO_OFF.includes(name))
  const offered = readOffered(await cli(launch, ['debug', 'prompt-input', ...configArgs(made.overrides)]))
  checkOffered(offered)
  for (const name of ['exec_command', 'write_stdin', 'view_image']) assert.equal(offered.nested.includes(name) || offered.tools.some(tool => tool.endsWith(name)), false, `${name} is not offered`)
  assert.deepEqual(offered.skills, [], 'no skill is advertised')
  // Without the overrides the same Codex offers what the check refuses: the check can fail.
  const plain = await cli(launch, ['debug', 'prompt-input'])
  assert.throws(() => checkOffered(readOffered(plain)), error => error.kind === 'unsupported')
})

test('real Codex: each required switch takes effect, and an invented or unhonoured one stops the check', { skip }, async (t) => {
  const { launch } = home(t)
  const rows = readFeatures(await cli(launch, ['features', 'list', ...configArgs({ features: { image_generation: true, shell_tool: false, view_image: false } })]))
  checkFeatures(rows)
  for (const name of IMAGE_FEATURES_OFF) assert.deepEqual(rows.get(name), { stage: 'stable', on: false })
  // Codex takes a feature name it does not know without a word: nothing but the list says so.
  const silent = await cli(launch, ['features', 'list', '-c', 'features={ zz_not_a_feature = false }'])
  assert.equal(readFeatures(silent).has('zz_not_a_feature'), false)
  await assert.rejects(imageSetup(launch, { required: [...IMAGE_FEATURES_OFF, 'zz_not_a_feature'] }), error => error.kind === 'unsupported' && /zz_not_a_feature/.test(error.message))
  const defaults = await cli(launch, ['features', 'list'])
  assert.throws(() => checkFeatures(readFeatures(defaults)), error => error.kind === 'unsupported', 'the defaults do not pass')
})

test('real Codex: the person\'s own MCP servers and skills are turned off by the same overrides', { skip }, async (t) => {
  const { root, launch } = home(t, '[mcp_servers."docs.search"]\ncommand = "true"\n[mcp_servers.plain]\ncommand = "true"\n')
  mkdirSync(join(root, 'codex', 'skills', 'mine'), { recursive: true })
  writeFileSync(join(root, 'codex', 'skills', 'mine', 'SKILL.md'), '---\nname: my-notes\ndescription: Read my notes when asked.\n---\nRead the notes.\n')
  const made = await imageSetup(launch)
  assert.deepEqual(made.servers.toSorted(), ['docs.search', 'plain'])
  assert.deepEqual(made.skills, ['my-notes'])
  const listed = JSON.parse(await cli(launch, ['mcp', 'list', '--json', ...configArgs(made.overrides)]))
  assert.deepEqual(listed.map(server => [server.name, server.enabled]).toSorted(), [['docs.search', false], ['plain', false]])
  assert.deepEqual(readOffered(await cli(launch, ['debug', 'prompt-input', ...configArgs(made.overrides)])).skills, [])
  // The run's folder is trusted in the session, so a server its own config adds counts too:
  // the checks, made in that folder with that trust, list it and turn it off by name.
  mkdirSync(join(root, 'cwd', '.codex'))
  writeFileSync(join(root, 'cwd', '.codex', 'config.toml'), '[mcp_servers.of_the_folder]\ncommand = "true"\n')
  const inside = await imageSetup(launch, { cwd: join(root, 'cwd') })
  assert.deepEqual(inside.overrides.projects, { [realpathSync(join(root, 'cwd'))]: { trust_level: 'trusted' } })
  assert.deepEqual(inside.servers.toSorted(), ['docs.search', 'of_the_folder', 'plain'])
  assert.deepEqual(inside.overrides.mcp_servers.of_the_folder, { enabled: false })
})

test('real Codex: a config it cannot load is told apart', { skip }, async (t) => {
  const { launch } = home(t, 'this is = = broken\n')
  await assert.rejects(imageSetup(launch), error => error.kind === 'config')
})

// The session's own path: CODEX_CONFIG goes to codex-acp, which hands it to Codex per thread.
// Without a provider a signed-out Codex stops at `session/new`; with the fixed loopback peer
// the next test reads the model-visible tools Codex built from that per-thread config.
test('real codex-acp: starts with the run\'s CODEX_CONFIG and stops at the sign-in', { skip }, async (t) => {
  const { root, launch, env } = home(t)
  const { overrides } = await imageSetup(launch)
  const run = new AgentRun({ ...launch, env: { ...env, CODEX_CONFIG: JSON.stringify(overrides) }, cwd: join(root, 'cwd'), name: 'Codex', mcpServers: [] })
  t.after(() => run.dispose())
  await assert.rejects(run.start(), error => isAuthRequired(error))
  assert.equal(typeof run.init?.protocolVersion, 'number', 'initialize answered')
})

test('real codex-acp: the per-thread CODEX_CONFIG is honoured for view_image', { skip, timeout: 90_000 }, async (t) => {
  const { root, launch, env } = home(t)
  const cwd = realpathSync(join(root, 'cwd'))
  const { overrides } = await imageSetup(launch, { cwd })
  const peer = await fixedPeer(t)
  const fixed = { ...overrides, ...provider(peer.port) }
  assert.equal(fixed.features.view_image, false)
  const off = await session(t, launch, env, cwd, fixed, peer)
  assert.match(off, /declare const tools: \{ apply_patch\(/)
  assert.doesNotMatch(off, /view_image/)
  const on = await session(t, launch, env, cwd, { ...fixed, features: { ...fixed.features, view_image: true } }, peer)
  assert.match(on, /declare const tools: \{ view_image\(/, 'the same config with the switch on offers it')
})


test('real Codex: the scratch permission profile is listed and allowed without config warnings', { skip, timeout: 30_000 }, async (t) => {
  const { root, env } = home(t)
  const cwd = realpathSync(join(root, 'cwd'))
  const profile = imageProfileFor(ensureChatProfiles(env.CODEX_HOME, { codexPath: CODEX }))
  assert.match(profile.id, /^automagik-image-[a-f0-9]{32}$/)
  const child = spawn(CODEX, ['app-server'], {
    cwd, env: { PATH: process.env.PATH, ...env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let stderr = ''
  let nextId = 0
  child.stderr.on('data', chunk => { stderr += chunk })
  const fail = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear() }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Codex app-server exited before answering')))
  lines.on('line', line => {
    const answer = JSON.parse(line)
    const waiter = pending.get(answer.id)
    if (!waiter) return
    pending.delete(answer.id)
    if (answer.error) waiter.reject(new Error(JSON.stringify(answer.error)))
    else waiter.resolve(answer.result)
  })
  const timer = setTimeout(() => { fail(new Error('Codex app-server did not answer in time')); child.kill('SIGKILL') }, 25_000)
  t.after(async () => {
    clearTimeout(timer)
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  await request('initialize', { clientInfo: { name: 'automagik-image-test', version: '1' }, capabilities: { experimentalApi: true } })
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  const listed = await request('permissionProfile/list', { cwd })
  const found = listed.data.find(entry => entry.id === profile.id)
  assert.ok(found, 'the home profile is listed')
  assert.equal(found.allowed, true)
  assert.doesNotMatch(stderr, /Invalid configuration/i)
})
