import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CliHomes } from '../src/host/cli-homes.js'
import { processBirth } from '../src/host/process-identity.js'
import { probeWindowsLogin } from '../src/host/windows-job-probe.js'
import { launchWindowsLogin, systemPowerShell, windowsJobName } from '../src/host/windows-login.js'
import { exitedPid } from './support/windows-record.js'
import { assertStaysAbsent, waitForContent, waitForFile } from './support/windows-waits.js'

const windowsOnly = {
  skip: process.platform !== 'win32' && 'requires Windows Job Objects and PowerShell',
  timeout: 240_000,
}
const BOUND = 65_000
const LATE_WRITE_BOUND = 2000
const hostModule = name => JSON.stringify(new URL(`../src/host/${name}.js`, import.meta.url).href)
const holdScript = fileURLToPath(new URL('./fixtures/hold-job.ps1', import.meta.url))
const read = path => readFileSync(path, 'utf8')
const readJson = path => JSON.parse(read(path))

function monitor(child) {
  const run = { child, stdout: '', stderr: '', status: null }
  child.stdout.on('data', chunk => { run.stdout += chunk })
  child.stderr.on('data', chunk => { run.stderr += chunk })
  run.closed = new Promise(resolve => {
    child.once('error', error => { run.stderr += String(error) })
    child.once('close', (code, signal) => {
      run.status = { code, signal }
      resolve(run.status)
    })
  })
  return run
}

async function bounded(promise, diagnostic, timeoutMs = BOUND) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(diagnostic(`timed out after ${timeoutMs} ms`))), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

function gone(pid) {
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
  return false
}

function fixture(t, initialPhase) {
  const scratch = mkdtempSync(join(tmpdir(), 'Windows recovery '))
  const root = join(scratch, 'cli-homes')
  const batch = join(scratch, 'vendor.cmd')
  const home = join(root, 'claude')
  const config = join(home, '.claude')
  const runs = []
  const { powershell, env } = systemPowerShell(process.env)
  const psFlags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  let phase = initialPhase
  let app, recover, direct, probe
  const diagnostic = reason => [
    `phase=${phase}: ${reason}`,
    `app exit=${JSON.stringify(app?.status)} stderr=${app?.stderr.trim() || '(empty)'}`,
    `supervisor stderr=${direct?.stderr.trim() || app?.stderr.trim() || '(empty)'}`,
    `probe JSON=${JSON.stringify(probe ?? null)}`,
    `recover output=${recover?.stdout.trim() || '(empty)'} stderr=${recover?.stderr.trim() || '(empty)'}`,
  ].join('\n')
  const tracked = child => {
    const run = monitor(child)
    runs.push(run)
    return run
  }
  const start = (file, args, options) => tracked(spawn(file, args, { windowsHide: true, ...options }))
  const node = (file, args, options) => start(process.execPath, [join(scratch, file), ...args], options)
  const ps = args => start(powershell, [...psFlags, ...args], { env })
  const wait = (directory, name, run, timeoutMs = BOUND) => waitForFile(directory, name, {
    timeoutMs, child: run?.child, diagnostic,
  })
  const absent = () => assertStaysAbsent(config, 'old-login', { timeoutMs: LATE_WRITE_BOUND, diagnostic })
  const release = () => writeFileSync(join(scratch, 'release'), '')
  const waitGone = async pid => {
    if (gone(pid)) return
    // Termination of a grandchild has no Node exit event. Let Windows wait on its handle.
    const waiter = ps(['-Command', `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`])
    await bounded(waiter.closed, diagnostic, 15_000)
    assert.equal(gone(pid), true, diagnostic(`pid ${pid} still exists (${waiter.stderr.trim()})`))
  }

  t.after(async () => {
    release()
    for (const run of runs) {
      if (!run.status) run.child.stdin?.end()
      if (!run.status && run.child.exitCode === null && run.child.signalCode === null) run.child.kill()
    }
    await bounded(Promise.all(runs.map(run => run.closed)), diagnostic, 15_000)
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  const publish = `
    function publish(file, text) {
      fs.writeFileSync(file + '.tmp', text);
      fs.renameSync(file + '.tmp', file);
    }
    function whenFile(folder, name, action) {
      const file = join(folder, name);
      const check = () => {
        if (!fs.existsSync(file)) return;
        watcher.close();
        clearTimeout(timeout);
        action(file);
      };
      const watcher = fs.watch(folder, check);
      const timeout = setTimeout(() => { check(); watcher.close(); }, 180000);
      check();
    }
  `
  writeFileSync(batch, `@echo off\r\n"${process.execPath}" "%~dp0wrapper.cjs" %*\r\n`)
  writeFileSync(join(scratch, 'wrapper.cjs'), `
    const fs = require('node:fs');
    const { join } = require('node:path');
    const { spawn } = require('node:child_process');
    ${publish}
    if (process.env.AUTOMAGIK_TEST_VENDOR_MODE === 'sign-in') {
      fs.writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'new-login'), 'new');
    } else {
      const writer = spawn(process.execPath, [join(__dirname, 'writer.cjs')], {
        stdio: 'ignore', detached: true,
      });
      writer.unref();
      whenFile(__dirname, 'writer-ready', () => publish(join(__dirname, 'ready'), 'ready'));
    }
  `)
  writeFileSync(join(scratch, 'writer.cjs'), `
    const fs = require('node:fs');
    const { join } = require('node:path');
    ${publish}
    publish(join(__dirname, 'writer-ready'), String(process.pid));
    whenFile(__dirname, 'release', () => {
      fs.writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'old-login'), 'old');
    });
  `)
  writeFileSync(join(scratch, 'late-writer.cjs'), `
    const fs = require('node:fs');
    const { join } = require('node:path');
    ${publish}
    publish(join(__dirname, 'late-writer-ready'), String(process.pid));
    whenFile(__dirname, 'release', () => {
      fs.writeFileSync(join(process.argv[2], 'old-login'), 'old');
    });
  `)
  const imports = `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { CliHomes } from ${hostModule('cli-homes')};
    import { CliLogins } from ${hostModule('login')};
    import { recordLogin } from ${hostModule('login-ownership')};
    const [root, scratch] = process.argv.slice(2);
    const homes = new CliHomes(root);
    const vendor = 'claude', id = 'acp-claude';
    const cli = join(scratch, 'vendor.cmd');
    ${publish}
  `
  writeFileSync(join(scratch, 'app.mjs'), `
    ${imports}
    const env = homes.environment(vendor);
    homes.begin(vendor);
    const logins = new CliLogins({
      resolve: async () => ({ cli, env }),
      signedIn: async () => false,
      startupMs: 120000,
      record(env, options) {
        const record = recordLogin(env, options);
        return { ...record, update(identity) {
          record.update(identity);
          const owned = [...logins.children.get(id)][0];
          owned.child.stderr.on('data', chunk => process.stderr.write(chunk));
          owned.child.once('exit', (code, signal) => {
            process.stderr.write(JSON.stringify({ supervisor: { code, signal } }) + '\\n');
          });
          publish(join(scratch, 'app-record'), record.id);
        } };
      },
    });
    logins.start(id);
  `)
  writeFileSync(join(scratch, 'recover.mjs'), `
    ${imports}
    import { probeWindowsLogin } from ${hostModule('windows-job-probe')};
    homes.probe = async request => {
      const proof = await probeWindowsLogin(request);
      console.log(JSON.stringify({ proof }));
      return proof;
    };
    const home = homes.home(vendor);
    const records = () => fs.existsSync(join(home, 'login-trees'))
      ? fs.readdirSync(join(home, 'login-trees')) : [];
    const reclaimed = await homes.recoverLogins(vendor);
    let begun = false;
    try { homes.begin(vendor); begun = true; } catch {}
    console.log(JSON.stringify({ reclaimed, home, begun, records: records() }));
    if (begun && process.env.AUTOMAGIK_TEST_VENDOR_MODE === 'sign-in') {
      const env = { ...homes.environment(vendor), AUTOMAGIK_TEST_VENDOR_MODE: 'sign-in' };
      const signIn = Promise.withResolvers();
      const logins = new CliLogins({
        resolve: async () => ({ cli, env }),
        signedIn: async () => fs.existsSync(join(env.CLAUDE_CONFIG_DIR, 'new-login')),
        startupMs: 120000,
        onChange() {
          if (!attempt) return;
          const state = logins.status(id, attempt.attemptId);
          if (state.status === 'ready') signIn.resolve(state);
          if (state.status === 'failed') signIn.reject(new Error(JSON.stringify(state)));
        },
        record(env, options) {
          const record = recordLogin(env, options);
          launch = record.id;
          return { ...record, update(identity) {
            record.update(identity);
            const owned = [...logins.children.get(id)][0];
            owned.child.stderr.on('data', chunk => process.stderr.write(chunk));
            owned.child.once('exit', (code, signal) => {
              process.stderr.write(JSON.stringify({ supervisor: { code, signal } }) + '\\n');
            });
          } };
        },
      });
      let attempt, launch;
      attempt = logins.start(id);
      const state = await signIn.promise;
      await logins.stop(id);
      console.log(JSON.stringify({ state: state.status, home: homes.home(vendor),
        records: records(), control: fs.existsSync(join(root, 'login-jobs', launch)) }));
      logins.dispose();
    }
    if (begun) homes.end(vendor);
    homes.dispose();
  `)

  return {
    scratch, root, batch, home, config, diagnostic, waitGone, absent, release,
    async startApp() {
      phase = initialPhase + '/app-start'
      app = node('app.mjs', [root, scratch])
      await wait(scratch, 'app-record', app)
      const id = read(join(scratch, 'app-record'))
      const file = join(home, 'login-trees', id)
      const control = join(root, 'login-jobs', id)
      return { id, file, control, supervisor: readJson(file).supervisor }
    },
    async supervisorReady(record) {
      phase = initialPhase + '/supervisor-identity'
      await wait(record.control, 'supervisor', app)
    },
    async ready(record) {
      phase = initialPhase + '/vendor-ready'
      await wait(scratch, 'ready', app)
      const writer = Number(read(join(scratch, 'writer-ready')))
      assert.ok(Number.isSafeInteger(writer) && writer > 1, diagnostic('invalid writer pid'))
      assert.equal(gone(writer), false, diagnostic('writer exited before app death'))
      await waitForContent(record.control, 'members', value =>
        readMembers(value).some(member => member.pid === writer && member.start !== null),
      { timeoutMs: BOUND, child: app.child, diagnostic })
      return writer
    },
    async killApp(record) {
      phase = initialPhase + '/app-death'
      assert.equal(app.child.kill('SIGKILL'), true, diagnostic('could not kill app'))
      const exit = await bounded(app.closed, diagnostic)
      assert.equal(exit.signal, 'SIGKILL', diagnostic('unexpected app exit'))
      await waitGone(record.supervisor)
    },
    async recover(signIn = false) {
      phase = initialPhase + (signIn ? '/fresh-sign-in' : '/fresh-recovery')
      recover = node('recover.mjs', [root, scratch],
        { env: { ...process.env, AUTOMAGIK_TEST_VENDOR_MODE: signIn ? 'sign-in' : 'login' } })
      const status = await bounded(recover.closed, diagnostic, 195_000)
      const output = recover.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      probe = output.find(row => row.proof)?.proof
      assert.deepEqual(status, { code: 0, signal: null }, diagnostic('fresh process failed'))
      return { proof: probe, result: output.find(row => 'reclaimed' in row),
        signIn: output.find(row => 'state' in row) }
    },
    async hold(mode, id) {
      phase = initialPhase + '/hold-job'
      const holder = ps(['-File', holdScript, mode, id])
      const ready = new Promise((resolve, reject) => {
        const onData = () => {
          if (holder.stdout.split(/\r?\n/).includes('held')) resolve()
        }
        holder.child.stdout.on('data', onData)
        onData()
        void holder.closed.then(() => {
          holder.child.stdout.removeListener('data', onData)
          reject(new Error(diagnostic(`holder exited before held: ${holder.stderr}`)))
        })
      })
      await bounded(ready, diagnostic)
      return async () => {
        holder.child.stdin.end()
        assert.deepEqual(await bounded(holder.closed, diagnostic), { code: 0, signal: null },
          diagnostic('holder failed on close'))
      }
    },
    async lateWriter() {
      const run = node('late-writer.cjs', [config])
      await wait(scratch, 'late-writer-ready', run)
      return run
    },
    direct(owner) { direct = tracked(owner.child); return direct },
    proof(value) { probe = value },
  }
}

function readMembers(value) {
  try { return JSON.parse(value).processes ?? [] } catch { return [] }
}

function nativeTest(name, phase, body) {
  test(name, windowsOnly, async t => {
    const h = fixture(t, phase)
    try { await body(h) } catch (error) {
      throw new Error(h.diagnostic(error.message), { cause: error })
    }
  })
}

for (const phase of ['startup', 'login']) {
  nativeTest(`Windows app death during ${phase} is recovered without Reset once the named Job is gone`, phase, async h => {
    const record = await h.startApp()
    let writer
    if (phase === 'startup') await h.supervisorReady(record)
    else writer = await h.ready(record)
    await h.killApp(record)
    if (phase === 'startup') {
      assert.equal(existsSync(join(record.control, 'members')) || existsSync(join(h.scratch, 'ready')),
        false, h.diagnostic('startup kill landed after admission'))
    }
    const { proof, result } = await h.recover()
    assert.equal(proof?.job, 'absent', h.diagnostic('expected Job absent'))
    assert.deepEqual(result, { reclaimed: true, home: h.home, begun: true, records: [] },
      h.diagnostic('cold restart did not reclaim on the same home'))
    assert.equal(existsSync(record.control), false, h.diagnostic('control folder remains'))
    h.release()
    await h.absent()
    if (writer) {
      await h.waitGone(writer)
      const fresh = await h.recover(true)
      assert.deepEqual(fresh.signIn, { state: 'ready', home: h.home, records: [], control: false },
        h.diagnostic('sign-in did not finish cleanly'))
      assert.equal(read(join(h.config, 'new-login')), 'new', h.diagnostic('new sign-in did not write'))
      assert.equal(existsSync(join(h.config, 'old-login')), false, h.diagnostic('late old write'))
    }
  })
}

nativeTest('a Windows login Job still held open keeps recovery blocked, and its last close ends the tree', 'held', async h => {
  const record = await h.startApp()
  const writer = await h.ready(record)
  const close = await h.hold('open', record.id)
  const before = read(record.file)
  await h.killApp(record)
  const { proof, result } = await h.recover()
  assert.equal(proof?.job, 'present', h.diagnostic('expected Job present'))
  assert.deepEqual(result, { reclaimed: false, home: h.home, begun: false, records: [record.id] },
    h.diagnostic('recovery admitted while the Job was present'))
  assert.equal(read(record.file), before, h.diagnostic('record changed while held'))
  await close()
  await h.waitGone(writer)
  h.release()
  await h.absent()
  assert.equal((await h.recover()).result?.reclaimed, true, h.diagnostic('recovery failed after last close'))
})

nativeTest('Reset while the old Job is held selects a fresh home and confines late writes to the retired home', 'reset', async h => {
  const record = await h.startApp()
  await h.ready(record)
  const close = await h.hold('open', record.id)
  await h.killApp(record)
  const late = await h.lateWriter()
  const homes = new CliHomes(h.root)
  const home = homes.reset('claude')
  homes.dispose()
  assert.notEqual(home, h.home, h.diagnostic('Reset reused the old home'))
  h.release()
  assert.deepEqual(await bounded(late.closed, h.diagnostic), { code: 0, signal: null }, h.diagnostic('late writer failed'))
  assert.equal(read(join(h.config, 'old-login')), 'old', h.diagnostic('old write missing from retired home'))
  assert.equal(existsSync(join(home, '.claude', 'old-login')), false, h.diagnostic('old write reached new home'))
  assert.deepEqual((await h.recover()).result, { reclaimed: false, home, begun: true, records: [] },
    h.diagnostic('new home could not start sign-in'))
  assert.equal(existsSync(record.file), true, h.diagnostic('old record was removed'))
  await close()
})

nativeTest('a pre-existing Job name refuses to start any vendor', 'job-exists', async h => {
  const id = randomUUID()
  const close = await h.hold('create', id)
  const owner = launchWindowsLogin(h.batch, [], {
    launch: id, cwd: h.scratch, control: join(h.root, 'login-jobs'),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const run = h.direct(owner)
  assert.deepEqual(await bounded(run.closed, h.diagnostic), { code: 125, signal: null },
    h.diagnostic('expected a refused launch'))
  assert.match(run.stderr, /job-exists/, h.diagnostic('missing collision phase'))
  assert.equal(existsSync(join(h.scratch, 'ready')), false, h.diagnostic('vendor ran after collision'))
  await close()
})

nativeTest('the probe tells a live, a reused and an exited pid apart', 'pid-birth', async h => {
  const birth = processBirth(process.pid)
  assert.ok(birth?.start, h.diagnostic('app birth could not be read'))
  const proof = await probeWindowsLogin({
    job: windowsJobName(randomUUID()),
    processes: [{ pid: process.pid, start: birth.start }, { pid: process.pid, start: '1' },
      { pid: exitedPid(), start: null }],
  })
  h.proof(proof)
  assert.deepEqual(proof, { job: 'absent', code: 2, processes: ['live', 'dead', 'dead'] },
    h.diagnostic('unexpected process identity result'))
})

nativeTest('a corrupted Windows record stays blocked on a real host', 'corrupt-record', async h => {
  let calls = 0
  const homes = new CliHomes(h.root, { probe: () => { calls++; throw new Error('unexpected probe') } })
  const directory = join(h.home, 'login-trees')
  mkdirSync(directory, { recursive: true })
  const record = join(directory, randomUUID())
  writeFileSync(record, '{')
  assert.equal(await homes.recoverLogins('claude'), false, h.diagnostic('corrupted record was reclaimed'))
  assert.equal(calls, 0, h.diagnostic('corrupted record reached PowerShell'))
  assert.equal(read(record), '{', h.diagnostic('corrupted record changed'))
  assert.throws(() => homes.begin('claude'), { code: 'acp-account/unverified-login' })
})
