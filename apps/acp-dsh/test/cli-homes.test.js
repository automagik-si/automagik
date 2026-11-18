import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { AGENTS, launchOf } from '../src/host/agents.js'
import { CliHomes, HOME_ENV, stopRuns, trackRun } from '../src/host/cli-homes.js'
import { installationOf } from '../index.js'
import { recordLogin } from '../src/host/login-ownership.js'

function place(t) {
  const root = mkdtempSync(join(tmpdir(), 'bot-cli-homes-'))
  const homes = new CliHomes(join(root, 'bots'))
  t.after(() => { homes.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { root, homes }
}

test('vendor homes exclude terminal credentials and all inherited auth/config overrides', t => {
  const { homes, root } = place(t)
  const terminal = join(root, 'terminal-auth')
  writeFileSync(terminal, 'invented-terminal-login')
  const source = {
    HOME: root, USERPROFILE: root, PATH: '/tools', CODEX_HOME: root,
    CLAUDE_CONFIG_DIR: root, CLAUDE_SECURESTORAGE_CONFIG_DIR: root,
    CODEX_CONFIG: 'terminal-config', CLAUDE_CODE_OAUTH_TOKEN: 'invented-token',
    ANTHROPIC_API_KEY: 'invented-key', OPENAI_API_KEY: 'invented-key',
    AWS_PROFILE: 'terminal-profile', NEW_VENDOR_AUTH: 'future-override',
    NODE_OPTIONS: '--require=terminal-hook', HTTPS_PROXY: 'http://proxy.example',
  }
  const claude = homes.environment('claude', source)
  const codex = homes.environment('codex', source)
  for (const env of [claude, codex]) {
    assert.notEqual(env.HOME, source.HOME)
    assert.equal(env.USERPROFILE, env.HOME)
    assert.ok(env.APPDATA.startsWith(`${env.HOME}/`) || env.APPDATA.startsWith(`${env.HOME}\\`))
    assert.ok(env.LOCALAPPDATA.startsWith(env.HOME))
    assert.equal(env.CLAUDE_CONFIG_DIR, join(env.HOME, '.claude'))
    assert.equal(env.CODEX_HOME, join(env.HOME, '.codex'))
    for (const name of ['CODEX_CONFIG', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY', 'AWS_PROFILE', 'NEW_VENDOR_AUTH', 'NODE_OPTIONS']) {
      assert.equal({ ...source, ...env }[name], undefined, name)
    }
    assert.equal(env.PATH, source.PATH)
    assert.equal(env.HTTPS_PROXY, source.HTTPS_PROXY)
    assert.equal(env[HOME_ENV], env.HOME)
  }
  assert.notEqual(claude.HOME, codex.HOME)
  assert.equal(readFileSync(terminal, 'utf8'), 'invented-terminal-login')
  assert.equal(homes.environment('claude').HOME, claude.HOME)
  const other = new CliHomes(join(root, 'other-installation'))
  t.after(() => other.dispose())
  assert.notEqual(other.environment('claude').HOME, claude.HOME)
})

// Two Automagik installations on one machine (two DSH profiles) share the Bot CLI root: the path
// is public and moving it would orphan the accounts people already signed in. Only the same
// installation's live app may refuse an account change, so the record says which one wrote it.
test('another installation on the same root does not refuse this one\'s account change', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-cli-scope-'))
  const shared = join(root, 'acp', 'cli-homes')
  const alpha = new CliHomes(shared, { installId: 'profile-alpha' })
  const beta = new CliHomes(shared, { installId: 'profile-beta' })
  t.after(() => { alpha.dispose(); beta.dispose(); rmSync(root, { recursive: true, force: true }) })
  alpha.environment('claude')
  beta.environment('claude')
  // The reported case: the other profile's app is live, and signing in here used to be refused.
  beta.begin('claude')
  beta.end('claude')
  alpha.begin('claude')
  alpha.end('claude')
  // The record on disk names the installation, so an app can tell a peer from a stranger.
  const directory = join(shared, 'instances', 'claude')
  const labels = readdirSync(directory)
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')).install)
    .sort()
  assert.deepEqual(labels, ['profile-alpha', 'profile-beta'])
})

test('the same installation still fences, and an unlabelled older record still counts', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-cli-scope-same-'))
  const shared = join(root, 'acp', 'cli-homes')
  const first = new CliHomes(shared, { installId: 'profile-alpha' })
  const second = new CliHomes(shared, { installId: 'profile-alpha' })
  t.after(() => { first.dispose(); second.dispose(); rmSync(root, { recursive: true, force: true }) })
  first.environment('codex')
  second.environment('codex')
  assert.throws(() => first.begin('codex'), /Close other Automagik sessions/)
  second.dispose()
  // An app from before the label existed is this installation as far as anyone can tell: it
  // fences, because it may be the very process changing the account.
  const older = new CliHomes(shared)
  t.after(() => older.dispose())
  older.environment('codex')
  assert.throws(() => first.begin('codex'), /Close other Automagik sessions/)
  // The other way round too: an app that does not know its installation cannot tell a peer from
  // itself, so any live app, labelled or not, refuses its account change.
  older.dispose()
  assert.throws(() => older.begin('codex'), /Close other Automagik sessions/)
})

// The skip is the live-app fence's only. The claim is the one mutex over the shared pointer and
// homes: another installation's live claim still excludes a second claim, and still keeps a run
// from selecting a home in the middle of a reset.
test('two installations on one root never hold the account claim at the same time', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-cli-scope-claim-'))
  const shared = join(root, 'acp', 'cli-homes')
  const alpha = new CliHomes(shared, { installId: 'profile-alpha' })
  const beta = new CliHomes(shared, { installId: 'profile-beta' })
  t.after(() => { alpha.dispose(); beta.dispose(); rmSync(root, { recursive: true, force: true }) })
  for (const [holder, other] of [[alpha, beta], [beta, alpha]]) {
    const reset = holder.reserveReset('codex')
    try {
      assert.throws(() => other.reserveReset('codex'), { code: 'acp-account/busy' })
      assert.throws(() => other.environment('codex'), { code: 'acp-account/busy' })
      assert.throws(() => other.begin('codex'), { code: 'acp-account/busy' })
      assert.throws(() => other.generations.exclusive('codex', () => {}), { code: 'acp-account/busy' })
    } finally { reset.release() }
    // Once the claim is released the other installation selects a home again.
    assert.equal(other.environment('codex')[HOME_ENV], holder.home('codex'))
  }
})

test('a host that does not name its installation writes an unlabelled record as before', t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-cli-scope-old-'))
  const shared = join(root, 'acp', 'cli-homes')
  const homes = new CliHomes(shared)
  t.after(() => { homes.dispose(); rmSync(root, { recursive: true, force: true }) })
  homes.environment('claude')
  const directory = join(shared, 'instances', 'claude')
  for (const name of readdirSync(directory)) {
    const record = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    assert.equal(Object.hasOwn(record, 'install'), false)
  }
})

test('installationOf reads the DSH profile and nothing else', () => {
  assert.equal(installationOf({ get: name => name === 'profileContext' ? { name: 'profile-alpha' } : undefined }), 'profile-alpha')
  assert.equal(installationOf({ get: () => undefined }), undefined)
  assert.equal(installationOf({ get: () => ({ name: '   ' }) }), undefined)
  assert.equal(installationOf({ get: () => { throw new Error('not injected') } }), undefined)
  assert.equal(installationOf(undefined), undefined)
})

test('account mutation excludes other app instances, blocks new work and survives failure', t => {
  const { homes } = place(t)
  const env = homes.environment('codex')
  const second = new CliHomes(homes.root)
  second.environment('codex')
  assert.throws(() => homes.begin('codex'), /Close other Automagik sessions/)
  second.dispose()
  homes.begin('codex')
  assert.throws(() => trackRun({ spec: { env } }), /account is changing/)
  homes.end('codex')
  assert.equal(homes.paused('codex'), true, 'failed logout remains paused')
  assert.throws(() => trackRun({ spec: { env } }), /account is changing/)
  homes.begin('codex')
  homes.resume('codex')
  homes.end('codex')
  assert.equal(homes.paused('codex'), false)
})

test('an interrupted launch with no persisted tree identity keeps recovery blocked', t => {
  const { homes } = place(t)
  const first = new CliHomes(homes.root)
  const env = first.environment('claude')
  const ownership = recordLogin(env)
  first.dispose()
  assert.throws(() => homes.begin('claude'), /previous Bot sign-in stopped/)
  ownership.clear()
  homes.begin('claude')
  homes.end('claude')
})

test('a damaged login record cannot be ignored during account recovery', t => {
  const { homes } = place(t)
  const env = homes.environment('codex')
  const directory = join(env.HOME, 'login-trees')
  mkdirSync(directory)
  writeFileSync(join(directory, 'interrupted'), '{')
  assert.throws(() => homes.begin('codex'), /previous Bot sign-in stopped/)
  assert.equal(existsSync(join(directory, 'interrupted')), true)
})

test('abandoned Windows ownership needs Reset even with an old nonce', t => {
  const { homes } = place(t)
  const previous = new CliHomes(homes.root)
  const old = previous.environment('claude')
  const record = recordLogin(old)
  const directory = '.login-job-invented'
  mkdirSync(join(old.HOME, directory))
  writeFileSync(join(old.HOME, directory, 'done'), 'invented-proof')
  record.update({ kind: 'windows', supervisor: 2, directory, nonce: 'invented-proof' })
  previous.dispose()
  assert.throws(() => homes.begin('claude'), /previous Bot sign-in stopped/)
  assert.equal(homes.recovery('claude'), true)
  const fresh = homes.reset('claude')
  assert.notEqual(fresh, old.HOME)
  homes.collect('claude')
  assert.equal(existsSync(old.HOME), true, 'Windows crash evidence is never auto-cleared')
  assert.equal(readFileSync(join(old.HOME, directory, 'done'), 'utf8'), 'invented-proof')
})

test('legacy dead sessions without login ownership evidence cannot be reclaimed', t => {
  const { homes } = place(t)
  const pid = Number(spawnSync(process.execPath, ['-p', 'process.pid'], {
    encoding: 'utf8',
  }).stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 1)
  const home = homes.environment('codex').HOME
  const stale = join(home, 'instances', `${pid}-old-session`)
  writeFileSync(stale, '')
  assert.throws(() => homes.begin('codex'), /previous Bot sign-in stopped/)
  assert.throws(() => homes.environment('codex'), /previous Bot sign-in stopped/)
  assert.equal(existsSync(stale), true)
  rmSync(stale)
  const lock = join(home, 'changing')
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(pid))
  assert.throws(() => homes.begin('codex'), /previous Bot sign-in stopped/)
  assert.equal(existsSync(lock), true)
})

for (const evidence of ['pending', 'damaged', 'legacy']) {
  test(`owner reset abandons ${evidence} evidence without deleting or reusing its home`, t => {
    const { homes } = place(t)
    const previous = new CliHomes(homes.root)
    const oldEnv = previous.environment('codex')
    if (evidence === 'pending') recordLogin(oldEnv)
    if (evidence === 'damaged') {
      mkdirSync(join(oldEnv.HOME, 'login-trees'))
      writeFileSync(join(oldEnv.HOME, 'login-trees', 'unknown'), '{')
    }
    previous.dispose()
    if (evidence === 'legacy') {
      const pid = Number(spawnSync(process.execPath, ['-p', 'process.pid'], {
        encoding: 'utf8',
      }).stdout.trim())
      writeFileSync(join(oldEnv.HOME, 'instances', `${pid}-old`), '')
    }
    assert.equal(homes.recovery('codex'), true)
    const home = homes.reset('codex')
    assert.notEqual(home, oldEnv.HOME)
    const fresh = homes.environment('codex')
    assert.equal(fresh.HOME, home)
    assert.equal(homes.paused('codex'), true)
    assert.equal(homes.recovery('codex'), false)
    assert.equal(existsSync(oldEnv.HOME), true)
    writeFileSync(join(oldEnv.CODEX_HOME, 'invented-auth'), 'old-late-write')
    assert.equal(existsSync(join(fresh.CODEX_HOME, 'invented-auth')), false)
    assert.throws(() => trackRun({ spec: { env: oldEnv } }), /account changed/)
    homes.collect('codex')
    assert.equal(existsSync(oldEnv.HOME), true, 'unproved old evidence remains retained')
    const restarted = new CliHomes(homes.root)
    t.after(() => restarted.dispose())
    assert.equal(restarted.home('codex'), home)
  })
}

test('reset keeps captured work invalid even if old generation files change', t => {
  const { homes } = place(t)
  const old = homes.environment('claude')
  const reset = homes.reserveReset('claude')
  assert.throws(() => trackRun({ spec: { env: old } }), /account is changing|account changed/)
  const other = new CliHomes(homes.root)
  t.after(() => other.dispose())
  assert.throws(() => other.environment('claude'), /Close other Automagik sessions/)
  const fresh = reset.complete()
  reset.release()
  // A late vendor can remove its old pause/version files; installation-level selection wins.
  rmSync(join(old.HOME, 'paused'))
  assert.throws(() => trackRun({ spec: { env: old } }), /account changed/)
  assert.notEqual(fresh, old.HOME)
})

test('collection retains an abandoned legacy change lock with no owner proof', t => {
  const { homes } = place(t)
  const old = homes.environment('codex')
  const pid = Number(spawnSync(process.execPath, ['-p', 'process.pid'], {
    encoding: 'utf8',
  }).stdout.trim())
  const lock = join(old.HOME, 'changing')
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(pid))
  homes.reset('codex')
  homes.collect('codex')
  assert.equal(existsSync(old.HOME), true)
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(pid))
})

test('a missing selection after reset never revives an abandoned home on cold restart', t => {
  const { homes } = place(t)
  const legacy = homes.environment('codex').HOME
  const first = homes.reset('codex')
  homes.dispose()
  rmSync(join(homes.root, 'current', 'codex'))
  const cold = new CliHomes(homes.root)
  t.after(() => cold.dispose())
  assert.equal(cold.recovery('codex'), true)
  assert.throws(() => cold.home('codex'), /previous Bot sign-in stopped/)
  assert.throws(() => cold.environment('codex'), /previous Bot sign-in stopped/)
  const second = cold.reset('codex')
  assert.notEqual(second, first)
  assert.notEqual(second, legacy)
  assert.equal(cold.environment('codex').HOME, second)
})

test('a failed stop can be verified again after its process finally exits', async t => {
  const { homes } = place(t)
  const env = homes.environment('claude')
  let calls = 0
  const run = { spec: { env }, stop: async () => {
    if (++calls === 1) throw new Error('not stopped yet')
  } }
  trackRun(run)
  await assert.rejects(stopRuns(env.HOME), /not stopped yet/)
  await stopRuns(env.HOME)
  assert.equal(calls, 2)
})

test('stopping isolated work waits for the real ACP process to exit', async t => {
  const { homes } = place(t)
  const env = homes.environment('claude')
  const run = new AgentRun({ env, name: 'isolated fake' })
  run.child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env, cwd: env.HOME, detached: process.platform !== 'win32', stdio: 'ignore',
  })
  run.grouped = process.platform !== 'win32'
  trackRun(run)
  t.after(() => run.dispose())
  await new Promise(resolve => run.child.once('spawn', resolve))
  const pid = run.child.pid
  homes.begin('claude')
  await stopRuns(env.HOME)
  assert.equal(run.disposed, true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  homes.resume('claude')
  homes.end('claude')
})

test('work admitted before an account change cannot start after its lock is released', t => {
  const { homes } = place(t)
  const old = homes.environment('codex')
  homes.begin('codex')
  homes.resume('codex')
  homes.end('codex')
  assert.throws(() => trackRun({ spec: { env: old } }), /account changed/)
})

test('desktop adapters retain trusted Electron-as-Node after sanitizing inherited options', t => {
  const { homes } = place(t)
  const cliEnv = homes.environment('claude', {
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=terminal-hook',
  })
  const launch = launchOf(AGENTS['acp-claude'], '/fake/claude', {
    store: { binOf: () => ({ path: '/fake/adapter', version: '1' }) }, cliEnv,
    node: { command: '/fake/electron', env: { ELECTRON_RUN_AS_NODE: '1' } },
  })
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(launch.env.NODE_OPTIONS, undefined)
})

test('delayed agent launches cannot inherit auth added after the isolated env was captured',
  async t => {
    const { homes, root } = place(t)
    const env = homes.environment('codex')
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'invented-terminal-key'
    t.after(() => {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    })
    const output = join(root, 'environment')
    const run = new AgentRun({ command: process.execPath, name: 'env fake', cwd: env.HOME,
      env, args: ['-e', "require('node:fs').writeFileSync(process.argv[1],"
        + "process.env.OPENAI_API_KEY || 'unset');setInterval(() => {},1000)", output] })
    const started = run.start()
    started.catch(() => {})
    t.after(() => run.dispose())
    let found
    for (let i = 0; i < 100; i++) {
      try { found = readFileSync(output, 'utf8'); break } catch {}
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(found, 'unset')
    await stopRuns(env.HOME)
    await assert.rejects(started)
  })
