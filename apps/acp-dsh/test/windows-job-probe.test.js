import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { probeWindowsLogin } from '../src/host/windows-job-probe.js'
import { windowsJobName } from '../src/host/windows-login.js'

const request = { job: windowsJobName(randomUUID()), processes: [{ pid: 27, start: '123' }, { pid: 81, start: null }] }
const ended = { job: 'absent', code: 2, processes: ['dead', 'dead'] }
const unknown = { job: 'unknown', code: null, processes: ['unknown', 'unknown'] }
const run = (exec, input = request, options) => probeWindowsLogin(input, { platform: 'win32', exec, ...options })
const reply = (stdout, error = null) => (...args) => args.at(-1)(error, stdout)

test('the probe runs system PowerShell with fixed flags, the request in env, and a pinned module path', async () => {
  let calls = 0
  const env = { SYSTEMROOT: 'D:\\Windows', psmodulepath: 'untrusted', Path: 'first' }
  assert.deepEqual(await run((command, args, options, done) => {
    calls++
    assert.equal(command, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    assert.match(args.at(-1), /[\\/]windows-job-probe\.ps1$/)
    assert.deepEqual(options, { windowsHide: true, timeout: 60_000, maxBuffer: 4096,
      env: { SYSTEMROOT: env.SYSTEMROOT, Path: env.Path,
        PSModulePath: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        AUTOMAGIK_LOGIN_PROBE: JSON.stringify(request) } })
    done(null, JSON.stringify(ended) + '\r\n')
  }, request, { env }), ended)
  assert.equal(calls, 1)
})

test('an invalid Job name, pid or start is refused without starting PowerShell', async t => {
  const never = t.mock.fn(reply(JSON.stringify(ended)))
  for (const job of ['invalid', request.job.replace('Global', 'Local'), request.job + ' ']) {
    assert.deepEqual(await run(never, { ...request, job }), unknown)
  }
  for (const entry of [{ pid: 1, start: null }, { pid: '80', start: null }, { pid: 80, start: 123 },
    { pid: 80, start: '123 ' }, { pid: 80, start: '0' }, { pid: 80 }]) {
    assert.deepEqual(await run(never, { ...request, processes: [entry, request.processes[1]] }), unknown)
  }
  const oversized = Array(67).fill(request.processes[0])
  assert.deepEqual((await run(never, { ...request, processes: oversized })).processes, Array(67).fill('unknown'))
  assert.equal(never.mock.callCount(), 0)
})

test('a non-Windows platform reads unknown without starting PowerShell', async t => {
  const never = t.mock.fn(reply(JSON.stringify(ended)))
  assert.deepEqual(await run(never, request, { platform: 'linux' }), unknown)
  assert.equal(never.mock.callCount(), 0)
})

test('timeout, non-zero exit, extra output, a wrong length or an unknown token all read as unknown', async () => {
  for (const error of [{ code: 125 }, { killed: true, signal: 'SIGTERM' }]) {
    assert.deepEqual(await run(reply(JSON.stringify(ended), error)), unknown)
  }
  for (const stdout of [JSON.stringify(ended) + '\nextra', JSON.stringify(ended) + '\n\n',
    JSON.stringify({ ...ended, processes: ['dead'] }), JSON.stringify({ ...ended, processes: ['dead', 'gone'] }),
    JSON.stringify({ ...ended, job: 'gone' })]) {
    assert.deepEqual(await run(reply(stdout)), unknown)
  }
})

test('only error 2 reads as absent', async () => {
  for (const code of [3, 5, 6]) {
    assert.deepEqual(await run(reply(JSON.stringify({ ...ended, code }))), unknown)
    const blocked = { ...ended, code, job: 'unknown' }
    assert.deepEqual(await run(reply(JSON.stringify(blocked))), blocked)
  }
  const present = { ...ended, code: 0, job: 'present' }
  assert.deepEqual(await run(reply(JSON.stringify(present))), present)
})
