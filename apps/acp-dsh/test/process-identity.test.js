import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliHomes } from '../src/host/cli-homes.js'
import { processBirth, processState, validBirth } from '../src/host/process-identity.js'

const boot = '12345678-1234-1234-1234-123456789abc'
const linux = { platform: 'linux', boot, start: '987654321' }
const probe = () => {}

test('Linux boot identity requires a primitive UUID string on both sides of comparison', () => {
  for (const malformed of [[boot], [], { toString: () => boot }, new String(boot),
    null, undefined, 123, true, Symbol('boot')]) {
    const birth = { ...linux, boot: malformed }
    assert.equal(validBirth(birth), false)
    assert.equal(processState(42, birth, { probe, identity: () => linux }), 'unknown')
    assert.equal(processState(42, linux, { probe, identity: () => birth }), 'unknown')
  }
  for (const start of [[linux.start], Number(linux.start), null]) {
    const birth = { ...linux, start }
    assert.equal(validBirth(birth), false)
    assert.equal(processState(42, birth, { probe, identity: () => linux }), 'unknown')
    assert.equal(processState(42, linux, { probe, identity: () => birth }), 'unknown')
  }
  assert.equal(processState(42, linux, { probe, identity: () => ({ ...linux }) }), 'live')
  assert.equal(processState(42, linux, { probe, identity: () => ({ ...linux,
    boot: 'aaaaaaaa-1234-1234-1234-123456789abc' }) }), 'dead')
})

test('Linux birth parses stat field 22 after the last comm parenthesis, strictly', () => {
  const fields = ['S', ...Array(18).fill('0'), linux.start, ...Array(30).fill('0')]
  const read = path => path.endsWith('boot_id') ? `${boot}\n` : `42 (odd ) name (still)) ${fields.join(' ')}\n`
  assert.deepEqual(processBirth(42, { platform: 'linux', read }), linux)
  for (const start of ['NaN', '-1', '1.5', '1e4', '']) {
    fields[19] = start
    assert.equal(processBirth(42, { platform: 'linux', read }), null)
  }
  assert.equal(processBirth(42, { platform: 'linux', read: () => { throw new Error('denied') } }), null)
})

test('macOS asks only fixed UTC lstart, preserves coarse collisions and bounds the call', () => {
  let call
  const identity = processBirth(42, { platform: 'darwin', exec: (...args) => {
    call = args
    return '  Fri Nov  6 13:14:15 2026\n'
  } })
  assert.deepEqual(identity, { platform: 'darwin', start: 'Fri Nov 6 13:14:15 2026' })
  assert.equal(call[0], '/bin/ps')
  assert.deepEqual(call[1], ['-p', '42', '-o', 'lstart='])
  assert.deepEqual(call[2].env, { LC_ALL: 'C', TZ: 'UTC' })
  assert.equal(call[2].timeout, 2000)
  assert.equal(call[2].maxBuffer, 1024)
  assert.equal(processState(42, identity, { probe, identity: () => ({ ...identity }) }), 'live')
  for (const output of ['', 'Fri Nov 6 99:14:15 2026', 'error\nFri Nov 6 13:14:15 2026']) {
    assert.equal(processBirth(42, { platform: 'darwin', exec: () => output }), null)
  }
})

test('Windows uses system PowerShell with fixed flags and lossless decimal UTC ticks', () => {
  let call
  const start = '639301724551234567'
  const identity = processBirth(42, { platform: 'win32', systemRoot: 'C:\\Windows', exec: (...args) => {
    call = args
    return `${start}\r\n`
  } })
  assert.deepEqual(identity, { platform: 'win32', start })
  assert.equal(call[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(call[1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.match(call[1][3], /GetProcessById\(42\).*ToUniversalTime\(\).Ticks.ToString/)
  assert.match(call[1][3], /catch \{ exit 1 \}/)
  assert.equal(call[2].timeout, 10_000)
  assert.equal(call[2].maxBuffer, 1024)
  assert.equal(processState(42, identity, { probe, identity: () => ({ platform: 'win32', start: '639301724551234568' }) }), 'dead')
  for (const output of ['', '0', '6.39301724551234567e17', '639301724551234567\nerror']) {
    assert.equal(processBirth(42, { platform: 'win32', systemRoot: 'C:\\Windows', exec: () => output }), null)
  }
})

test('only fresh ESRCH or a strictly comparable birth mismatch is dead; errors and legacy stay unknown', () => {
  for (const code of ['EPERM', 'EACCES', 'ETIMEDOUT']) {
    assert.equal(processState(42, linux, { probe: () => { throw Object.assign(new Error(), { code }) } }), 'unknown')
  }
  assert.equal(processState(42, null, { probe: () => { throw Object.assign(new Error(), { code: 'ESRCH' }) } }), 'dead')
  assert.equal(processState(42, null, { probe }), 'unknown')
  assert.equal(processState(42, linux, { probe, identity: () => null }), 'unknown')
  assert.equal(processState(42, linux, { probe, identity: () => ({ ...linux, start: '987654322' }) }), 'dead')
  assert.equal(processState(42, linux, { probe, identity: () => linux }), 'live')
  assert.equal(processState(42, linux, { probe, identity: () => ({ platform: 'win32', start: '123' }) }), 'unknown')
  for (const pid of [1, 0, -1, 1.5, '42', NaN]) {
    assert.equal(processBirth(pid, { exec: () => { assert.fail('invalid PID queried') } }), null)
    assert.equal(processState(pid, linux, { probe: () => { assert.fail('invalid PID probed') } }), 'unknown')
  }
  assert.equal(processBirth(42, { platform: 'win32', systemRoot: 'C:\\Windows', exec: () => { throw new Error('script timeout') } }), null)
})

test('available platform smoke reads this test process birth natively once across repeats and CliHomes, without auth or process command lines', t => {
  const nativeExec = childProcess.execFileSync
  const nativeRead = fs.readFileSync
  const ownPid = String(process.pid)
  let ownReads = 0
  const exec = (...receivedArgs) => {
    const started = performance.now()
    try {
      const output = nativeExec(...receivedArgs)
      if (receivedArgs[1].some(arg => arg === ownPid
        || String(arg).includes(`GetProcessById(${ownPid})`))) ownReads += 1
      return output
    } catch (error) {
      try {
        const code = error?.code
        const signal = error?.signal
        const killed = error?.killed
        const elapsed = performance.now() - started
        t.diagnostic('native birth exec failure: ' + JSON.stringify({
          code: typeof code === 'string' &&
            ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', 'ENOMEM', 'EINVAL'].includes(code)
            ? code : 'OTHER',
          signal: signal === undefined || signal === null ? null
            : typeof signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal)
              ? signal : 'OTHER',
          killed: typeof killed === 'boolean' ? killed : null,
          durationMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null,
        }))
      } catch {}
      throw error
    }
  }
  const read = (...receivedArgs) => {
    const output = nativeRead(...receivedArgs)
    if (String(receivedArgs[0]) === `/proc/${ownPid}/stat`) ownReads += 1
    return output
  }
  t.after(() => {
    fs.readFileSync = nativeRead
    childProcess.execFileSync = nativeExec
    syncBuiltinESMExports()
  })
  // The default provider must see the wrappers: only uninjected own-PID calls use the cache.
  if (process.platform === 'linux') fs.readFileSync = read
  else childProcess.execFileSync = exec
  syncBuiltinESMExports()
  const identity = pid => processBirth(pid)
  const first = identity(process.pid)
  assert.ok(first, `birth provider works on ${process.platform}`)
  assert.deepEqual(identity(process.pid), first)
  assert.equal(processState(process.pid, first, { identity }), 'live')
  assert.equal(ownReads, 1)
  const root = fs.mkdtempSync(join(tmpdir(), 'acp-dsh-birth-'))
  const homes = new CliHomes(root)
  try {
    for (let round = 0; round < 2; round += 1) {
      assert.ok(homes.environment('claude').HOME)
      homes.begin('claude')
      homes.end('claude')
    }
    assert.equal(ownReads, 1)
    t.diagnostic(`native own-process birth reads after two CLI launch evaluations: ${ownReads}`)
  } finally {
    homes.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
