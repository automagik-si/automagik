// The image run's lockdown against a real Codex and a real codex-acp (image.js, #870). Opt-in:
// The ordinary plugin CI job installs neither; every test here skips unless both are named:
//   AUTOMAGIK_TEST_CODEX_ACP  codex-acp's dist/index.js
//   AUTOMAGIK_TEST_CODEX      a Codex executable (the native one, or its launcher)
// Codex runs in a throwaway HOME and CODEX_HOME made here: it is never signed in, no model
// request is sent, and nothing of the person's own Codex home is read or written.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CODEX_PATH: CODEX, OPENAI_API_KEY: '', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' }
  return { root, env, launch: { command: process.execPath, args: [ADAPTER], env } }
}
const cli = (launch, args) => new Promise((resolve, reject) => {
  execFile(launch.command, [...launch.args, 'cli', ...args], { env: { ...process.env, ...launch.env, NO_COLOR: '1' }, cwd: tmpdir(), timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
})

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
// A Codex that is not signed in stops at `session/new`, so this proves only that the real
// adapter starts with the run's CODEX_CONFIG and answers; that the per-thread overrides are
// honoured needs a signed-in Codex (the human test in the local app).
test('real codex-acp: starts with the run\'s CODEX_CONFIG and stops at the sign-in', { skip }, async (t) => {
  const { root, launch, env } = home(t)
  const { overrides } = await imageSetup(launch)
  const run = new AgentRun({ ...launch, env: { ...env, CODEX_CONFIG: JSON.stringify(overrides) }, cwd: join(root, 'cwd'), name: 'Codex', mcpServers: [] })
  t.after(() => run.dispose())
  await assert.rejects(run.start(), error => isAuthRequired(error))
  assert.equal(typeof run.init?.protocolVersion, 'number', 'initialize answered')
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
