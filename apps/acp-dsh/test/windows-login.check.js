import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWindowsLogin, windowsJobName, windowsLoginCommand } from '../src/host/windows-login.js'
import { assertStaysAbsent, waitForContent } from './support/windows-waits.js'

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'windows-login-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

// PowerShell compiles the Job-object C# on first use, so a slow Windows runner can take tens
// of seconds to even start the wrapper. The delayed credential write is 1500 ms after the
// wrapper starts; both waits stay generous enough for a slow runner.
const READY_BOUND_MS = 60_000
const STOP_BOUND_MS = 10_000
const LATE_WRITER_BOUND_MS = 5_000
function fake(t, extra = {}, env = {}, options = {}) {
  const root = scratch(t)
  const child = new EventEmitter()
  child.pid = 8123
  child.exitCode = null
  child.signalCode = null
  let request
  let supervisorEnv
  const kills = []
  const owner = launchWindowsLogin('C:\\tools\\codex.cmd', ['app-server'], {
    cwd: root, detached: true, launch: randomUUID(), appStart: null,
    control: join(root, 'login-jobs'),
    env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', ...env },
    ...options,
  }, {
    spawn(command, args, options) {
      assert.match(command, /powershell\.exe$/)
      assert.ok(args.includes('-NoProfile'))
      assert.equal(options.shell, false)
      assert.equal(options.detached, false, 'caller cannot detach the supervisor from the app')
      request = JSON.parse(options.env.AUTOMAGIK_LOGIN_JOB)
      supervisorEnv = options.env
      return child
    },
    taskkill(command, args, options, done) { kills.push({ command, args }); done() },
    ...extra,
  })
  return { root, child, request, owner, kills, supervisorEnv,
    acknowledge() {
      writeFileSync(request.done, request.nonce)
      child.exitCode = 0
      child.emit('close', 0)
    } }
}

test('Windows login commands preserve argv and batch quoting without shell interpolation', () => {
  const native = windowsLoginCommand('C:\\tools\\codex.exe', ['path with spaces', 'a"b'], {})
  assert.equal(native.executable, 'C:\\tools\\codex.exe')
  assert.equal(native.line, '"C:\\tools\\codex.exe" "path with spaces" "a\\"b"')
  const batch = windowsLoginCommand('C:\\tools here\\codex.cmd', ['app-server'], {
    ComSpec: 'C:\\Windows\\cmd.exe',
  })
  assert.equal(batch.executable, 'C:\\Windows\\cmd.exe')
  assert.equal(batch.line, '"C:\\Windows\\cmd.exe" /d /s /c '
    + '""C:\\tools here\\codex.cmd" "app-server""')
  assert.throws(() => windowsLoginCommand('codex.cmd', ['%UNSAFE%'], {}), /refusing/)
})

test('Windows stop waits for full-job proof, then removes its private markers', async t => {
  const h = fake(t)
  let done = false
  h.owner.done.then(() => { done = true })
  const stopped = h.owner.stop()
  assert.equal(existsSync(h.request.stop), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  h.acknowledge()
  await stopped
  await h.owner.done
  assert.equal(readFileSync(h.request.done, 'utf8'), h.request.nonce,
    'stop proof survives until the persisted ownership record is cleared')
  h.owner.dispose()
  assert.equal(existsSync(h.request.done), false)
  assert.deepEqual(h.kills, [])
  await h.owner.stop()
})

test('Windows launch binds the record and control markers to the named Job', async t => {
  const h = fake(t)
  const { launch, job } = h.request
  const control = join(h.root, 'login-jobs', launch)
  assert.deepEqual(h.owner.identity, { kind: 'windows', supervisor: h.child.pid, job })
  assert.equal(job, windowsJobName(launch))
  assert.equal(h.request.app, process.pid)
  assert.equal(h.request.appStart, null)
  assert.equal(h.request.identity, join(control, 'supervisor'))
  assert.equal(h.request.members, join(control, 'members'))
  h.acknowledge()
  await h.owner.done
  h.owner.dispose()
})

test('the login control folder is app-owned under the CLI root, never the working folder', t => {
  const root = scratch(t)
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const cliRoot = join(root, 'cli')
  const h = fake(t, {}, {
    AUTOMAGIK_BOT_CLI_HOME: join(cliRoot, 'claude'),
    AUTOMAGIK_BOT_CLI_POINTER: join(cliRoot, 'current', 'claude'),
  }, { cwd, control: undefined })
  assert.equal(h.request.cwd, cwd)
  assert.equal(h.request.identity, join(cliRoot, 'login-jobs', h.request.launch, 'supervisor'))
})

test('a launch without a valid launch id is refused before any folder or spawn', t => {
  const root = join(scratch(t), 'control')
  const spawn = () => assert.fail('spawned PowerShell')
  for (const launch of [undefined, 'untrusted', randomUUID().toUpperCase()]) {
    assert.throws(() => launchWindowsLogin('vendor.exe', [], { launch, control: root }, { spawn }),
      /Invalid sign-in launch id/)
  }
  assert.equal(existsSync(root), false)
})

test('a Bot home without its pointer refuses the launch', t => {
  const cwd = scratch(t)
  const spawn = () => assert.fail('spawned PowerShell')
  assert.throws(() => launchWindowsLogin('vendor.exe', [], {
    launch: randomUUID(), cwd, env: { AUTOMAGIK_BOT_CLI_HOME: cwd },
  }, { spawn }), /The Bot sign-in folder is incomplete/)
})

test('Windows supervisor pins system modules while preserving the vendor module-path mask',
  async t => {
    for (const modulePath of [undefined, 'terminal-user-modules']) {
      const h = fake(t, {}, { PSMODULEPATH: modulePath })
      assert.equal(h.supervisorEnv.PSModulePath,
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
      assert.equal(Object.hasOwn(h.supervisorEnv, 'PSMODULEPATH'), false)
      assert.equal(h.request.modulePath, modulePath ?? null)
      h.acknowledge()
      await h.owner.done
      h.owner.dispose()
    }
  })

test('a raw Windows wrapper close without job proof cannot authorize an auth change', async t => {
  const h = fake(t)
  h.child.exitCode = 0
  h.child.emit('close', 0)
  await assert.rejects(h.owner.done, /complete sign-in process tree/)
  await assert.rejects(h.owner.stop(), /complete sign-in process tree/)
  assert.equal(existsSync(h.request.stop), true, 'unproved ownership is not discarded')
})

test('an unresponsive Windows supervisor gets taskkill /T but no unproved success', async t => {
  const h = fake(t, { stopMs: 10 })
  await assert.rejects(h.owner.stop(), /complete sign-in process tree/)
  assert.deepEqual(h.kills, [{ command: 'taskkill.exe',
    args: ['/PID', '8123', '/T', '/F'] }])
  h.acknowledge()
  await h.owner.stop()
})

test('a known-exited supervisor is never taskkilled while its pipes are still open', async t => {
  const h = fake(t, { stopMs: 10 })
  h.child.exitCode = 0
  h.child.emit('exit', 0)
  await assert.rejects(h.owner.stop(), /could not be stopped/)
  assert.deepEqual(h.kills, [])
  h.acknowledge()
  await h.owner.done
})

test('a .cmd wrapper cannot leave a delayed credential writer after login stop', {
  skip: process.platform !== 'win32' && 'requires Windows Job Objects and PowerShell',
  timeout: 120_000,
}, async t => {
  const root = scratch(t)
  const ready = join(root, 'ready')
  const wrote = join(root, 'invented-credentials')
  const script = join(root, 'wrapper.cjs')
  const batch = join(root, 'vendor.cmd')
  // The intermediate Node process exits while its detached child remains in the owned Job.
  writeFileSync(script, `const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    const code="setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],"
      +"'invented-login'),1500)";
    spawn(process.execPath,['-e',code,process.argv[2]],
      {stdio:'ignore',detached:true}).unref();
    fs.writeFileSync(process.argv[3]+'.tmp','wrapper-exited');
    fs.renameSync(process.argv[3]+'.tmp',process.argv[3]);`)
  writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  const owner = launchWindowsLogin(batch, [wrote, ready], {
    cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    launch: randomUUID(), appStart: null, control: join(root, 'login-jobs'),
  }, { stopMs: STOP_BOUND_MS })
  t.after(() => owner.stop().catch(() => {}))
  const errors = []
  owner.child.stderr.on('data', chunk => errors.push(String(chunk)))
  const diagnostic = reason => (
    `${reason}; wrapper stderr: ${errors.join('').trim() || '(empty)'}`
  )
  assert.equal(await waitForContent(root, 'ready', 'wrapper-exited', {
    timeoutMs: READY_BOUND_MS, child: owner.child, diagnostic,
  }), 'wrapper-exited')
  await owner.stop()
  assert.equal(existsSync(wrote), false,
    diagnostic('a delayed credential writer survived login stop'))
  await assertStaysAbsent(root, 'invented-credentials', {
    timeoutMs: LATE_WRITER_BOUND_MS, diagnostic,
  })
  await owner.done
})
