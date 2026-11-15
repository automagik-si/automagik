import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliHomes } from '../src/host/cli-homes.js'
import { recordLogin } from '../src/host/login-ownership.js'
import { launchWindowsLogin, windowsLoginCommand } from '../src/host/windows-login.js'

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
// The app writes its own identity record before PowerShell is even involved, so its
// event-driven bound is shorter; every wait checks the disk once more when a bound expires.
const APP_IDENTITY_BOUND_MS = 15_000

// Await the supervisor's file event instead of polling it into existence. The wrapper renames
// its ready signal into place, so any observed ready file already carries the full content.
function waitForContent(directory, name, expected, { timeoutMs, child, diagnostic }) {
  const target = join(directory, name)
  return new Promise((resolve, reject) => {
    let watcher
    let timer
    let settled = false
    let observed = 'missing'
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      child?.removeListener('close', exited)
      if (error) reject(error)
      else resolve(observed)
    }
    const check = () => {
      try {
        observed = readFileSync(target, 'utf8')
        if (observed === expected) finish()
      } catch (error) {
        observed = error.code === 'ENOENT' ? 'missing' : `${error.code}: ${error.message}`
      }
    }
    const exited = () => {
      check()
      if (!settled) finish(new Error(diagnostic(
        `the supervisor exited before ${name} was ready (last content: ${JSON.stringify(observed)})`)))
    }
    timer = setTimeout(() => {
      // The bound is the last chance to look: a dropped watch event must not fail the wait
      // while a complete ready file is already on disk.
      check()
      finish(new Error(diagnostic(
        `${name} was not ready within ${timeoutMs}ms `
        + `(last content: ${JSON.stringify(observed)})`)))
    }, timeoutMs)
    try {
      watcher = watch(directory, { persistent: true }, check)
      watcher.on('error', error => finish(new Error(diagnostic(
        `watching ${name} failed: ${error.message}`))))
    } catch (error) {
      finish(new Error(diagnostic(`watching ${name} failed: ${error.message}`)))
      return
    }
    child?.once('close', exited)
    check()
    if (child && (child.pid === undefined || child.exitCode !== null
      || child.signalCode !== null)) exited()
  })
}

// Await a file the app writes for the test. The app renames it into place, so an observed
// record is complete; the bound only caps a hang and still looks once before failing.
function waitForFile(directory, name, { timeoutMs, child, diagnostic }) {
  const target = join(directory, name)
  return new Promise((resolve, reject) => {
    let watcher
    let timer
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      child?.removeListener('close', exited)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (existsSync(target)) finish()
    }
    const exited = () => {
      check()
      if (!settled) finish(new Error(diagnostic(
        `the app exited before ${name} was written`)))
    }
    timer = setTimeout(() => {
      // The bound is the last chance to look: a dropped watch event must not fail the wait
      // while the app's complete record is already on disk.
      check()
      finish(new Error(diagnostic(`${name} was not written within ${timeoutMs}ms`)))
    }, timeoutMs)
    try {
      watcher = watch(directory, { persistent: true }, check)
      watcher.on('error', error => finish(new Error(diagnostic(
        `watching ${name} failed: ${error.message}`))))
    } catch (error) {
      finish(new Error(diagnostic(`watching ${name} failed: ${error.message}`)))
      return
    }
    child?.once('close', exited)
    check()
    if (child && (child.pid === undefined || child.exitCode !== null
      || child.signalCode !== null)) exited()
  })
}

// A successful stop empties the Job, so the delayed writer can never produce its file. Watch
// for the bound instead of sleeping: a defect that leaks the writer fails at its first write.
function assertStaysAbsent(directory, name, { timeoutMs, diagnostic }) {
  const target = join(directory, name)
  return new Promise((resolve, reject) => {
    let watcher
    let timer
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (existsSync(target)) finish(new Error(diagnostic(
        `${name} appeared after login stop`)))
    }
    timer = setTimeout(() => {
      // The bound is the last chance to look: a dropped watch event must not let the watch
      // pass while the credential file is already on disk.
      check()
      finish()
    }, timeoutMs)
    try {
      watcher = watch(directory, { persistent: true }, check)
      watcher.on('error', error => finish(new Error(diagnostic(
        `watching ${name} failed: ${error.message}`))))
    } catch (error) {
      finish(new Error(diagnostic(`watching ${name} failed: ${error.message}`)))
      return
    }
    check()
  })
}

function fake(t, extra = {}, env = {}) {
  const root = scratch(t)
  const child = new EventEmitter()
  child.pid = 8123
  child.exitCode = null
  child.signalCode = null
  let request
  let supervisorEnv
  const kills = []
  const owner = launchWindowsLogin('C:\\tools\\codex.cmd', ['app-server'], {
    cwd: root, detached: true,
    env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', ...env },
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

test('Windows launch exposes durable ownership without an automatic app-death handshake',
  async t => {
    const h = fake(t)
    for (const key of ['parent', 'challenge', 'acknowledge']) {
      assert.equal(Object.hasOwn(h.request, key), false)
    }
    assert.deepEqual(h.owner.identity, { kind: 'windows', supervisor: h.child.pid,
      directory: h.request.done.split(/[\\/]/).at(-2), nonce: h.request.nonce })
    assert.match(h.owner.identity.directory, /^\.login-job-[A-Za-z0-9]+$/)
    h.acknowledge()
    await h.owner.done
    h.owner.dispose()
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

// This test starts two PowerShell Job-object wrappers (the killed app's and the fresh
// owner's), so its cap covers two generous ready bounds.
for (const duringStartup of [true, false]) {
  const phase = duringStartup ? 'during startup' : 'during login'
  test(`Windows app death ${phase} requires an owner Reset to a fresh home`, {
    skip: process.platform !== 'win32' && 'requires Windows Job Objects and PowerShell',
    timeout: 2 * READY_BOUND_MS + 60_000,
  }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'windows-login-parent-test-'))
    const appFile = join(root, 'app.mjs')
    const identityFile = join(root, 'identity')
    const errorsFile = join(root, 'supervisor-errors')
    const ready = join(root, 'ready')
    const wrote = join(root, 'claude', '.claude', 'invented-credentials')
    const module = new URL('../src/host/windows-login.js', import.meta.url).href
    const homesModule = new URL('../src/host/cli-homes.js', import.meta.url).href
    const recordsModule = new URL('../src/host/login-ownership.js', import.meta.url).href
    const recovered = new CliHomes(root)
    let app, identity, freshOwner
    const errors = []
    const diagnostic = reason => {
      let supervisor = ''
      try { supervisor = readFileSync(errorsFile, 'utf8') } catch {}
      const detail = [...errors, supervisor].join('') || 'no supervisor diagnostics'
      return reason ? `${reason}; ${detail}` : detail
    }
    t.after(async () => {
      if (app?.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
      if (identity) {
        try { writeFileSync(join(identity.home, identity.directory, 'stop'), '') } catch {}
      }
      await freshOwner?.stop().catch(() => {})
      freshOwner?.dispose()
      await new Promise(resolve => setTimeout(resolve, 100))
      recovered.end('claude')
      recovered.dispose()
      t.diagnostic(diagnostic())
      rmSync(root, { recursive: true, force: true })
    })
    const writer = "const fs=require('node:fs');"
      + "if(process.env.PSModulePath)throw new Error('Supervisor module path leaked');"
      + "const ready=process.argv[1];"
      + "fs.writeFileSync(ready+'.tmp','ready');fs.renameSync(ready+'.tmp',ready);"
      + "setTimeout(()=>fs.writeFileSync(process.argv[2],'old-login'),2000);"
      + 'setInterval(()=>{},1000)'
    writeFileSync(appFile, `import {closeSync,openSync,renameSync,writeFileSync} from 'node:fs';
      import {launchWindowsLogin} from ${JSON.stringify(module)};
      import {CliHomes} from ${JSON.stringify(homesModule)};
      import {recordLogin} from ${JSON.stringify(recordsModule)};
      const homes=new CliHomes(${JSON.stringify(root)});
      const env=homes.environment('claude');homes.begin('claude');
      const record=recordLogin(env);
      const errors=openSync(${JSON.stringify(errorsFile)},'a');
      const owned=launchWindowsLogin(process.execPath,
        ['-e',${JSON.stringify(writer)},${JSON.stringify(ready)},${JSON.stringify(wrote)}],
        {cwd:env.HOME,env,stdio:['pipe','pipe',errors]});
      closeSync(errors);
      record.update(owned.identity);
      owned.child.stdout.resume();
      owned.child.on('error',error=>console.error('Supervisor spawn error:',error.code));
      owned.done.then(()=>{record.clear();owned.dispose()})
        .catch(()=>console.error('Supervisor exited without full-job proof'));
      const identity=${JSON.stringify(identityFile)};
      writeFileSync(identity+'.tmp',JSON.stringify({
        ...owned.identity,app:process.pid,home:env.HOME}));
      renameSync(identity+'.tmp',identity);
      ${duringStartup ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);' : ''}
      setInterval(()=>{},1000);`)
    app = spawn(process.execPath, [appFile], { stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env, windowsHide: true })
    app.stdout.resume()
    app.stderr.on('data', chunk => errors.push(String(chunk)))
    if (!duringStartup) {
      assert.equal(await waitForContent(root, 'ready', 'ready', {
        timeoutMs: READY_BOUND_MS, child: app, diagnostic,
      }), 'ready')
    }
    await waitForFile(root, 'identity', {
      timeoutMs: APP_IDENTITY_BOUND_MS, child: app, diagnostic,
    })
    assert.ok(existsSync(identityFile), diagnostic())
    identity = JSON.parse(readFileSync(identityFile, 'utf8'))
    assert.equal(identity.app, app.pid, 'the recorded app is the process being killed')
    assert.throws(() => recovered.begin('claude'), { code: 'acp-account/unverified-login' })
    const records = join(identity.home, 'login-trees')
    const record = join(records, readdirSync(records)[0])
    const original = readFileSync(record, 'utf8')
    // Kill only the app. Windows orphan ownership never permits automatic recovery.
    const exited = new Promise(resolve => app.once('exit', (code, signal) => (
      resolve({ code, signal })
    )))
    assert.equal(app.kill('SIGKILL'), true)
    const exit = await exited
    assert.ok(exit.code !== null || exit.signal !== null, 'app termination was observed')
    t.diagnostic(`app exit: ${JSON.stringify(exit)}`)
    assert.throws(() => recovered.begin('claude'), { code: 'acp-account/unverified-login' })
    const markers = join(identity.home, identity.directory)
    mkdirSync(markers, { recursive: true })
    writeFileSync(join(markers, 'done'), identity.nonce)
    assert.throws(() => recovered.begin('claude'), { code: 'acp-account/unverified-login' })

    const freshHome = recovered.reset('claude')
    assert.notEqual(freshHome, identity.home)
    assert.equal(readFileSync(record, 'utf8'), original, 'Reset retains orphan evidence')
    assert.equal(existsSync(identity.home), true, 'Reset retains the old physical path')
    recovered.begin('claude')
    const env = recovered.environment('claude')
    assert.equal(env.HOME, freshHome)
    const freshWrote = join(env.CLAUDE_CONFIG_DIR, 'invented-credentials')
    const freshReady = join(freshHome, 'ready')
    const freshWriter = "const fs=require('node:fs');"
      + "fs.writeFileSync(process.argv[1],'new-login');"
      + "const ready=process.argv[2];"
      + "fs.writeFileSync(ready+'.tmp','ready');fs.renameSync(ready+'.tmp',ready);"
      + 'setInterval(()=>{},1000)'
    const freshRecord = recordLogin(env)
    freshOwner = launchWindowsLogin(process.execPath, ['-e', freshWriter,
      freshWrote, freshReady], { cwd: freshHome, env, stdio: ['pipe', 'pipe', 'pipe'] },
    { stopMs: 10_000 })
    freshRecord.update(freshOwner.identity)
    freshOwner.child.stdout.resume()
    freshOwner.child.stderr.on('data', chunk => errors.push(String(chunk)))
    // A second PowerShell wrapper compiles the same Job-object code from scratch, so this
    // event-driven wait gets the wrapper's generous bound rather than a short poll.
    assert.equal(await waitForContent(freshHome, 'ready', 'ready', {
      timeoutMs: READY_BOUND_MS, child: freshOwner.child, diagnostic,
    }), 'ready')
    await freshOwner.stop()
    await freshOwner.done
    assert.equal(readFileSync(join(freshHome, freshOwner.identity.directory, 'done'), 'utf8'),
      freshOwner.identity.nonce, 'the current app still requires complete normal-stop proof')
    freshRecord.clear()
    freshOwner.dispose()
    writeFileSync(wrote, 'late-old-login')
    assert.equal(readFileSync(freshWrote, 'utf8'), 'new-login')
    assert.equal(readFileSync(record, 'utf8'), original)
  })
}
