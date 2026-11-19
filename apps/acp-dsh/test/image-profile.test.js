// Isolation refusals and the 2026-11-11 fallback policy. Only temp folders and the fake agent are used.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { AgentRun } from '../src/host/acp.js'
import { drawImage, imageProfileFor, mcpServerNames, STOPPED, TIMED_OUT, UNAVAILABLE } from '../src/host/image.js'
import { imageWith20261111Policy } from './support/image-policy-2026-11-11.mjs'

const { drawImage: drawWith20261111Policy } = await imageWith20261111Policy()

test('the shipped image policy fails closed', () => {
  const source = readFileSync(new URL('../src/host/image.js', import.meta.url), 'utf8')
  assert.match(source, /^const ALLOW_IMAGE_READ_ONLY_FALLBACK = false$/m)
})


const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-image-agent.mjs')

function fixture(t, profile = 'offer') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'acp-image-review-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileModes = ensureChatProfiles(home, { platform: 'linux' })
  const traceFile = join(home, 'trace.jsonl')
  const dir = join(home, 'scratch')
  const logged = []
  return {
    dir,
    logged,
    trace: () => existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    request: {
      spawn: () => ({ command: process.execPath, args: [FAKE], profileModes, env: { CODEX_HOME: home, FAKE_IMAGE_PROFILE: profile, FAKE_IMAGE_TRACE: traceFile } }),
      prompt: 'a fox',
      scratch: async () => { await fs.mkdir(dir); return dir },
      log: line => logged.push(line),
    },
  }
}

const configError = () => Object.assign(new Error('base config refused'), { kind: 'config', profiled: false })
const CONFIG_TEXT = 'Codex could not load its own configuration, so the image was not started. Fix Codex\'s config file and try again.'

test('the 2026-11-11 policy drops the profile on a config refusal and draws read-only', async (t) => {
  const run = fixture(t)
  const checks = []
  const made = await drawWith20261111Policy({
    ...run.request,
    listServers: async (launch, options) => {
      const profile = checks.length === 0
      checks.push({ cwd: options.cwd, profile })
      if (profile) throw configError()
      return mcpServerNames(launch, options)
    },
  })
  assert.deepEqual(checks, [{ cwd: run.dir, profile: true }, { cwd: run.dir, profile: false }])
  assert.equal(made.mimeType, 'image/png')
  assert.equal(made.isolated, false)
  assert.equal(run.logged.length, 1)
  assert.match(run.logged[0], /not isolated \(profile config refused\); falling back to read-only/)
  const trace = run.trace()
  assert.deepEqual(trace.filter(row => row.event === 'cli').map(row => row.args[0]), ['mcp', 'features', 'debug', 'features', 'debug', 'debug'])
  assert.ok(trace.filter(row => ['cli', 'new-session'].includes(row.event)).every(row => row.config === undefined))
  assert.deepEqual(trace.filter(row => row.event === 'mode').map(row => row.modeId), ['read-only'])
  assert.equal(trace.find(row => row.event === 'prompt').modeId, 'read-only')
  assert.equal(existsSync(run.dir), false)
})

test('the 2026-11-11 policy refuses after exactly two failing config checks', async (t) => {
  const run = fixture(t)
  const profiles = []
  await assert.rejects(drawWith20261111Policy({
    ...run.request,
    listServers: async () => {
      profiles.push(profiles.length === 0)
      throw configError()
    },
  }), error => error.code === UNAVAILABLE && /configuration/.test(error.message))
  assert.deepEqual(profiles, [true, false])
  assert.deepEqual(run.trace(), [])
  assert.equal(run.logged.length, 1)
  assert.doesNotMatch(run.logged[0], /falling back/)
  assert.equal(existsSync(run.dir), false)
})


test('the shipped policy retries a failing base config once and reports its error', async (t) => {
  const run = fixture(t)
  let checks = 0
  await assert.rejects(drawImage({
    ...run.request,
    listServers: async () => { checks += 1; throw configError() },
  }), error => error.code === UNAVAILABLE && error.message === CONFIG_TEXT)
  assert.equal(checks, 2)
  assert.deepEqual(run.trace(), [])
  assert.deepEqual(run.logged, ['the Codex image run was not started (config): base config refused'])
  assert.equal(existsSync(run.dir), false)
})

test('the shipped policy refuses missing and rejected profile modes', async (t) => {
  for (const profile of ['', 'reject']) {
    const run = fixture(t, profile)
    await assert.rejects(drawImage(run.request), error => error.code === UNAVAILABLE && error.message.startsWith('The Codex image run could not be isolated'))
    const trace = run.trace()
    assert.equal(trace.some(row => row.event === 'prompt' || (row.event === 'mode' && row.modeId === 'read-only')), false)
    const reason = profile === 'reject' ? 'profile mode selection rejected' : 'profile mode not offered'
    assert.deepEqual(run.logged, [`the Codex image run is not isolated (${reason}); the image was refused`])
    assert.equal(existsSync(run.dir), false)
  }
})

test('a one-time base config failure retries with the same profile and draws isolated', async t => {
  const run = fixture(t)
  const launch = run.request.spawn()
  const profile = imageProfileFor(launch.profileModes)
  const execFile = childProcess.execFile
  let attempts = 0
  const mock = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (args[0] === FAKE && args[2] === 'features' && ++attempts === 1) {
      options = { ...options, env: { ...options.env, FAKE_INVALID_CONFIG: 'features' } }
    }
    return execFile(command, args, options, callback)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const made = await drawImage(run.request)
  assert.equal(made.isolated, true)
  const trace = run.trace()
  assert.deepEqual(trace.filter(row => row.event === 'cli').map(row => row.args[0]),
    ['mcp', 'features', 'mcp', 'features', 'debug', 'features', 'debug', 'debug'])
  assert.equal(trace.find(row => row.event === 'new-session').profileId, profile.id)
  assert.equal(trace.find(row => row.event === 'prompt').modeId, profile.mode)
  assert.deepEqual(run.logged, [])
  assert.equal(existsSync(run.dir), false)
})

test('a persistent base config failure with a valid profile gives config guidance', async t => {
  const run = fixture(t)
  const launch = run.request.spawn()
  launch.env.FAKE_INVALID_CONFIG = 'mcp'
  await assert.rejects(drawImage({ ...run.request, spawn: () => launch }),
    error => error.code === UNAVAILABLE && error.message === CONFIG_TEXT && error.reason === undefined)
  assert.deepEqual(run.trace().map(row => [row.event, row.args?.[0]]), [['cli', 'mcp'], ['cli', 'mcp']])
  assert.deepEqual(run.logged, ['the Codex image run was not started (config): the MCP server list could not be read: Codex could not load its configuration'])
  assert.equal(existsSync(run.dir), false)
})

test('failure to write the edit input has its own refusal and log', async (t) => {
  const run = fixture(t)
  const original = fs.writeFile
  const mocked = t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (file === join(run.dir, 'input.png')) throw new Error('private path and account')
    return original(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(drawImage({ ...run.request, input: { data: Buffer.from('input'), mimeType: 'image/png' } }), error => error.code === UNAVAILABLE && /scratch folder could not be prepared/.test(error.message) && !/MCP|private/.test(error.message))
  } finally {
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(run.trace(), [])
  assert.deepEqual(run.logged, ['the Codex image run was not started: the scratch folder could not be prepared'])
  assert.equal(existsSync(run.dir), false)
})

test('Stop and a start timeout during profile selection do not warn or retry read-only', async (t) => {
  for (const stop of [true, false]) {
    const run = fixture(t, 'hang')
    const controller = new AbortController()
    let timer
    if (stop) timer = setInterval(() => {
      if (run.trace().some(row => row.event === 'mode')) controller.abort()
    }, 10)
    try {
      await assert.rejects(drawImage({ ...run.request, signal: controller.signal, timeoutMs: 1500 }), error => error.code === (stop ? STOPPED : TIMED_OUT))
    } finally { clearInterval(timer) }
    const trace = run.trace()
    const modes = trace.filter(row => row.event === 'mode')
    assert.equal(modes.length, 1)
    assert.match(modes[0].modeId, /^permission-profile:/)
    assert.equal(trace.some(row => row.event === 'prompt'), false)
    assert.deepEqual(run.logged, [])
    assert.equal(existsSync(run.dir), false)
  }
})

test('a run disposed during profile selection rethrows without a fallback warning', async (t) => {
  const run = fixture(t, 'hang')
  const selected = []
  class DisposedRun extends AgentRun {
    async setMode(mode, options) {
      selected.push(mode)
      const pending = super.setMode(mode, options)
      this.dispose()
      return pending
    }
  }
  await assert.rejects(drawImage({ ...run.request, Run: DisposedRun }), error => error.code === UNAVAILABLE)
  assert.equal(selected.length, 1)
  assert.match(selected[0], /^permission-profile:/)
  assert.deepEqual(run.logged, [])
  assert.equal(existsSync(run.dir), false)
})
