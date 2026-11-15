import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { AgentRun, KILL_AFTER_MS } from '../src/host/acp.js'

const groups = { skip: process.platform === 'win32' }
const fail = code => { throw Object.assign(new Error(code), { code }) }
const root = 424242
const toolPid = 424244
const boot = '12345678-1234-1234-1234-123456789abc'
const birth = { platform: 'linux', boot, start: '12345' }
const stat = (pid, ppid, pgid) => `${pid} (test process) ${[
  'S', ppid, pgid, pgid, ...Array(15).fill('0'), birth.start, ...Array(30).fill('0'),
].join(' ')}\n`

function fixture(t, kill) {
  const signals = [], fallbacks = [], waiting = new Set()
  let now = 0
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -root, 'only the fake agent group may be signalled')
    signals.push(signal)
    return kill(signal)
  })
  const timers = {
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms }
      waiting.add(timer)
      return timer
    },
    clearTimeout(timer) { waiting.delete(timer) },
    tick(ms) {
      now += ms
      for (const timer of waiting) {
        if (timer.at <= now) { waiting.delete(timer); timer.fn() }
      }
    },
  }
  const child = Object.assign(new EventEmitter(), {
    pid: root, exitCode: null, signalCode: null,
    stdin: { end() {} },
    kill(signal) { fallbacks.push(signal) },
  })
  const run = new AgentRun({ command: 'fake', name: 'Generic agent', cwd: '/tmp', timers })
  run.child = child
  run.grouped = true
  // dispose() snapshots on current dev. All identities and reads are fake, on any host OS.
  run.treeDeps = {
    platform: 'linux', list: () => [String(root)],
    read: path => {
      if (path === '/proc/sys/kernel/random/boot_id') return boot
      if (path === `/proc/${root}/stat`) return stat(root, 1, root)
      if (path === `/proc/${process.pid}/stat`) return stat(process.pid, 1, 20)
      if (path === `/proc/${toolPid}/stat`) return stat(toolPid, root, toolPid)
      assert.fail(`unexpected identity read: ${path}`)
    },
    kill: () => assert.fail('no detached tool in this fixture'),
  }
  t.after(() => { run.letGo(true); waiting.clear() })
  return { run, child, signals, fallbacks, waiting, timers }
}

test('stop waits through EPERM probes until the group is gone', groups, async t => {
  let probes = 0
  const h = fixture(t, signal => {
    if (signal === 0) fail(++probes <= 2 ? 'EPERM' : 'ESRCH')
  })
  await h.run.stop()
  assert.equal(probes, 3)
  assert.deepEqual(h.run.detached, [])
})

test('stop keeps its deadline when every probe returns EPERM', {
  ...groups, timeout: 10_000,
}, async t => {
  let probes = 0
  const h = fixture(t, signal => {
    if (signal === 0) { probes++; fail('EPERM') }
  })
  const started = Date.now()
  await assert.rejects(h.run.stop(), /has not stopped/)
  assert.ok(Date.now() - started >= 5000)
  assert.ok(probes >= 3)
})

test('stop rejects a probe error other than ESRCH or EPERM', groups, async t => {
  const h = fixture(t, signal => { if (signal === 0) fail('EACCES') })
  await assert.rejects(h.run.stop(), /could not be stopped/)
})

test('endTree still sends SIGKILL to a group whose SIGTERM returns EPERM', groups, t => {
  const h = fixture(t, signal => { if (signal === 'SIGTERM') fail('EPERM') })
  h.run.endTree()
  assert.equal(h.waiting.size, 1)
  h.timers.tick(KILL_AFTER_MS - 1)
  assert.deepEqual(h.signals, ['SIGTERM'])
  h.timers.tick(1)
  assert.deepEqual(h.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(h.fallbacks, [])
})

test('endTree keeps the SIGKILL timer when the exit probe returns EPERM', groups, t => {
  const h = fixture(t, signal => { if (signal === 0) fail('EPERM') })
  h.run.endTree()
  h.child.exitCode = 0
  h.child.emit('exit', 0)
  assert.deepEqual(h.signals, ['SIGTERM', 0])
  assert.equal(h.waiting.size, 1)
  h.timers.tick(KILL_AFTER_MS)
  assert.deepEqual(h.signals, ['SIGTERM', 0, 'SIGKILL'])
})

test('endTree clears the SIGKILL timer when the exit probe returns ESRCH', groups, t => {
  const h = fixture(t, signal => { if (signal === 0) fail('ESRCH') })
  h.run.endTree()
  h.child.exitCode = 0
  h.child.emit('exit', 0)
  assert.deepEqual(h.signals, ['SIGTERM', 0])
  assert.equal(h.waiting.size, 0)
  h.timers.tick(KILL_AFTER_MS)
  assert.deepEqual(h.signals, ['SIGTERM', 0])
})

test('stop waits through group EPERM then ESRCH and detached unknown then live until both are gone', groups, async t => {
  let probes = 0
  let stopped = false
  const checked = []
  const h = fixture(t, signal => {
    if (signal === 0) fail(++probes === 1 ? 'EPERM' : 'ESRCH')
  })
  // An already disposed run retains its snapshot even after the agent itself exits.
  h.run.disposed = true
  h.child.exitCode = 0
  h.run.detached = [{ pid: toolPid, ppid: root, pgid: toolPid, birth }]
  h.run.treeDeps.kill = (pid, signal) => {
    assert.equal(pid, toolPid)
    assert.equal(signal, 0)
    assert.equal(stopped, false)
    checked.push(probes <= 2 ? 'unknown' : probes === 3 ? 'live' : 'dead')
    if (probes <= 2) fail('EPERM')
    if (probes >= 4) fail('ESRCH')
  }
  await h.run.stop().then(() => { stopped = true })
  assert.equal(stopped, true)
  assert.equal(probes, 4, 'ESRCH for the group alone is insufficient')
  assert.deepEqual(checked, ['unknown', 'unknown', 'live', 'dead'])
})

test('endTree signals a detached tool with SIGTERM and SIGKILL when the group returns EPERM', groups, t => {
  const h = fixture(t, signal => { if (signal === 'SIGTERM') fail('EPERM') })
  const detachedSignals = []
  h.run.detached = [{ pid: toolPid, ppid: root, pgid: toolPid, birth }]
  h.run.treeDeps.kill = (pid, signal) => {
    assert.ok(pid === toolPid || pid === -toolPid)
    if (signal !== 0) detachedSignals.push([pid, signal])
  }
  h.run.endTree()
  assert.deepEqual(detachedSignals, [[-toolPid, 'SIGTERM'], [toolPid, 'SIGTERM']])
  assert.equal(h.waiting.size, 2, 'both group and detached escalation timers remain armed')
  h.timers.tick(KILL_AFTER_MS - 1)
  assert.equal(detachedSignals.length, 2)
  h.timers.tick(1)
  assert.deepEqual(detachedSignals, [
    [-toolPid, 'SIGTERM'], [toolPid, 'SIGTERM'],
    [-toolPid, 'SIGKILL'], [toolPid, 'SIGKILL'],
  ])
  assert.deepEqual(h.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(h.fallbacks, [])
})
