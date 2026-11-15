import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliGenerations, ownershipAt, ownershipState, removeDeadOwnership } from '../src/host/cli-generations.js'
import { CliHomes, trackRun } from '../src/host/cli-homes.js'
import { LOGIN_RECORD_VERSION, recordLogin } from '../src/host/login-ownership.js'

function place(t) {
  const root = mkdtempSync(join(tmpdir(), 'birth-recovery-'))
  const homes = new CliHomes(root)
  t.after(() => { homes.dispose(); rmSync(root, { recursive: true, force: true }) })
  return homes
}
const exitedPid = () => Number(spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).stdout.trim())
function abandoned(home, pid = exitedPid()) {
  const lock = join(home, 'changing')
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(pid))
  writeFileSync(join(lock, 'owner'), `${pid}-abcdef`)
  return lock
}

test('complete private metadata is published before admission; failed publication never initializes', t => {
  const homes = place(t)
  const original = fs.linkSync
  let barrier = 0
  fs.linkSync = (from, to) => {
    barrier++
    assert.match(from, /\.ownership-staging/)
    assert.equal(existsSync(to), false)
    const record = JSON.parse(readFileSync(from, 'utf8'))
    assert.equal(record.format, 'app-birth-v1')
    assert.equal(record.pid, process.pid)
    assert.equal(record.nonce, to.split(/[\\/]/).at(-1))
    assert.equal(existsSync(join(homes.root, 'codex')), false)
    throw new Error('publication crash barrier')
  }
  syncBuiltinESMExports()
  try { assert.throws(() => homes.environment('codex'), /publication crash barrier/) }
  finally { fs.linkSync = original; syncBuiltinESMExports() }
  assert.equal(barrier, 1)
  assert.deepEqual(readdirSync(homes.generations.instances('codex')), [])
  assert.equal(existsSync(join(homes.root, 'codex')), false)
  homes.environment('codex')
  const snapshot = ownershipAt(join(homes.generations.instances('codex'), homes.instance), { legacy: 'root' })
  assert.equal(ownershipState(snapshot), 'live')
})

test('claim publication is complete and exclusive; contention releases only the exact caller claim', t => {
  const homes = place(t)
  const a = homes.generations
  const b = new CliGenerations(homes.root, `${process.pid}-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`)
  const release = a.acquire('codex')
  const file = join(a.claims('codex'), a.held.get('codex'))
  const original = readFileSync(file, 'utf8')
  assert.equal(JSON.parse(original).marker, 'claim')
  assert.throws(() => b.acquire('codex'), /Close other/)
  assert.deepEqual(readdirSync(a.claims('codex')), [a.held.get('codex')])
  // Replacement at the same name survives the previous caller's release.
  rmSync(file)
  writeFileSync(file, 'replacement')
  release()
  assert.equal(readFileSync(file, 'utf8'), 'replacement')
  assert.throws(() => b.acquire('codex'), /Close other/)
})

test('fresh dead claims are removed before acquisition; malformed and live legacy claims block', t => {
  const homes = place(t)
  const directory = homes.generations.claims('codex')
  mkdirSync(directory, { recursive: true })
  const dead = join(directory, `${exitedPid()}-old-claim`)
  mkdirSync(dead)
  homes.generations.acquire('codex')()
  assert.equal(existsSync(dead), false)
  const bad = join(directory, `${exitedPid()}-damaged`)
  writeFileSync(bad, '{')
  assert.throws(() => homes.generations.acquire('codex'), /Close other/)
  rmSync(bad)
  const live = join(directory, `${process.pid}-legacy`)
  mkdirSync(live)
  assert.throws(() => homes.generations.acquire('codex'), /Close other/)
  assert.equal(existsSync(live), true)
})

test('birth mismatch reclaims reused app PID but exact bytes and inode changes prevent removal', t => {
  const homes = place(t)
  homes.environment('codex')
  const directory = homes.generations.instances('codex')
  const path = join(directory, `${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`)
  const birth = { ...homes.generations.birth, start: homes.generations.birth.platform === 'darwin'
    ? 'Fri Nov 6 13:14:15 1900' : '1' }
  const record = { format: 'app-birth-v1', pid: process.pid, nonce: path.split(/[\\/]/).at(-1), birth, marker: 'root' }
  writeFileSync(path, JSON.stringify(record))
  const before = ownershipAt(path, { legacy: 'root' })
  assert.equal(ownershipState(before), 'dead')
  writeFileSync(path, JSON.stringify({ ...record, birth: homes.generations.birth }))
  assert.equal(removeDeadOwnership(before), false)
  assert.equal(existsSync(path), true)
  writeFileSync(path, JSON.stringify(record))
  homes.begin('codex')
  homes.end('codex')
  assert.equal(existsSync(path), false)
})

test('a live PID claim with an array boot is retained and blocks the actual mutation mutex', t => {
  const homes = place(t)
  const directory = homes.generations.claims('codex')
  mkdirSync(directory, { recursive: true })
  const nonce = `${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
  const path = join(directory, nonce)
  const own = homes.generations.birth
  // On Linux these are the live process's actual boot and start; other platforms still
  // exercise malformed Linux metadata against a genuinely live PID.
  const birth = own.platform === 'linux' ? { ...own, boot: [own.boot] }
    : { platform: 'linux', boot: ['12345678-1234-1234-1234-123456789abc'], start: '1' }
  const bytes = JSON.stringify({ format: 'app-birth-v1', pid: process.pid, nonce, birth, marker: 'claim' })
  writeFileSync(path, bytes)
  process.kill(process.pid, 0)
  const snapshot = ownershipAt(path, { legacy: 'claim' })
  assert.equal(ownershipState(snapshot), 'unknown')
  assert.equal(removeDeadOwnership(snapshot), false)
  assert.throws(() => homes.generations.acquire('codex'), /Close other/)
  assert.equal(readFileSync(path, 'utf8'), bytes)
  assert.deepEqual(readdirSync(directory), [nonce], 'only the rejected caller releases its own claim')
})

test('startup recovers a proved dead changing owner even before its pause write; generation/version stay', t => {
  const homes = place(t)
  const env = homes.environment('codex')
  writeFileSync(join(env.HOME, 'version'), 'original-version')
  const lock = abandoned(env.HOME)
  assert.equal(existsSync(join(env.HOME, 'paused')), false)
  homes.startup('codex')
  assert.equal(existsSync(lock), false)
  assert.equal(homes.home('codex'), env.HOME)
  assert.equal(readFileSync(join(env.HOME, 'version'), 'utf8'), 'original-version')
  assert.equal(homes.paused('codex'), true)
  assert.throws(() => trackRun({ spec: { env } }), /account is changing/)
})

for (const evidence of ['starting', 'windows', 'damaged', 'legacy', 'live', 'claim']) {
  test(`startup retains ${evidence} evidence and never resumes or selects another home`, t => {
    const homes = place(t)
    const previous = new CliHomes(homes.root)
    const env = previous.environment('claude')
    if (['starting', 'windows', 'damaged'].includes(evidence)) {
      const record = recordLogin(env)
      if (evidence === 'windows') record.update({ kind: 'windows', supervisor: 42, nonce: 'old' })
      if (evidence === 'damaged') {
        const file = readdirSync(join(env.HOME, 'login-trees'))[0]
        writeFileSync(join(env.HOME, 'login-trees', file), '{')
      }
    }
    previous.dispose()
    const lock = abandoned(env.HOME, evidence === 'live' ? process.pid : exitedPid())
    if (evidence === 'legacy') writeFileSync(join(env.HOME, 'instances', `${exitedPid()}-legacy`), '')
    if (evidence === 'claim') writeFileSync(join(lock, 'recovering'), `${process.pid}-abcdef`)
    assert.throws(() => homes.startup('claude'), /previous Bot sign-in stopped/)
    assert.equal(existsSync(lock), true)
    assert.equal(homes.home('claude'), env.HOME)
  })
}

test('startup revalidates the exact lock owner after the final login-tree proof', t => {
  const homes = place(t)
  const env = homes.environment('codex')
  const lock = abandoned(env.HOME)
  const verify = homes.verify.bind(homes)
  let calls = 0
  homes.verify = home => {
    verify(home)
    if (++calls === 3) writeFileSync(join(lock, 'owner'), `${process.pid}-abcdef`)
  }
  assert.throws(() => homes.startup('codex'), /previous Bot sign-in stopped/)
  assert.equal(existsSync(lock), true)
  assert.equal(homes.paused('codex'), true)
  assert.equal(LOGIN_RECORD_VERSION, 'login-trees-v1')
})
