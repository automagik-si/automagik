// The profile fallback's failure paths. Only temp folders and the fake agent are used.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { AgentRun } from '../src/host/acp.js'
import { drawImage, mcpServerNames, STOPPED, TIMED_OUT, UNAVAILABLE } from '../src/host/image.js'

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

const configError = () => Object.assign(new Error('profile config refused'), { kind: 'config' })

test('a config refusal only with the profile retries all checks without it and draws read-only', async (t) => {
  const run = fixture(t)
  const checks = []
  const made = await drawImage({
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

test('a config refusal with and without the profile refuses after exactly two checks', async (t) => {
  const run = fixture(t)
  const profiles = []
  await assert.rejects(drawImage({
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

// Flip the policy only in this test's module instance, without editing the source on disk.
async function withoutFallback() {
  const suffix = '?image-review-no-fallback'
  const hook = registerHooks({
    load(url, context, next) {
      const result = next(url, context)
      if (!url.endsWith(suffix)) return result
      const source = String(result.source)
      const policy = 'const ALLOW_IMAGE_READ_ONLY_FALLBACK = true'
      assert.ok(source.includes(policy))
      return { ...result, source: source.replace(policy, 'const ALLOW_IMAGE_READ_ONLY_FALLBACK = false') }
    },
  })
  try { return await import(`../src/host/image.js${suffix}`) } finally { hook.deregister() }
}

test('with fallback disabled a profile config refusal does not retry or start a session', async (t) => {
  const strict = await withoutFallback()
  const run = fixture(t)
  let checks = 0
  await assert.rejects(strict.drawImage({
    ...run.request,
    listServers: async () => { checks += 1; throw configError() },
  }), error => error.code === UNAVAILABLE && error.message.startsWith('The Codex image run could not be isolated'))
  assert.equal(checks, 1)
  assert.deepEqual(run.trace(), [])
  assert.deepEqual(run.logged, [])
  assert.equal(existsSync(run.dir), false)
})

test('with fallback disabled missing and rejected profile modes give a clear isolation refusal', async (t) => {
  const strict = await withoutFallback()
  for (const profile of ['', 'reject']) {
    const run = fixture(t, profile)
    await assert.rejects(strict.drawImage(run.request), error => error.code === UNAVAILABLE && error.message.startsWith('The Codex image run could not be isolated'))
    const trace = run.trace()
    assert.equal(trace.some(row => row.event === 'prompt' || (row.event === 'mode' && row.modeId === 'read-only')), false)
    assert.deepEqual(run.logged, [])
    assert.equal(existsSync(run.dir), false)
  }
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
