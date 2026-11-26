import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { verifyAssertion } from '../../apps/multiuser-dsh/src/assertion.js'
import { createKeySource } from '../../apps/multiuser-dsh/src/keys.js'
import { createSigner, instanceOf, loadCallerKeys, rotateCallerKeys } from '../gate-caller.mjs'
import { frontendPath } from '../gate-frontend.mjs'
import { createOwner } from '../gate-store.mjs'

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)))
const wire = fixture('caller-assertion-v1')
const { principal, method, path, iat, nonce } = wire.payload
const inputs = { principal, method, path, familyId: wire.familyId }

function adapterKeys(file) {
  const fd = openSync(file, 'r')
  let mountId
  try { mountId = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))[1] }
  finally { closeSync(fd) }
  return createKeySource({ file, mountinfo: () => `${mountId} 0 0:1 / / ro - tmpfs tmpfs rw` })
}

function setup(t, { fixedNonce = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'caller-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'home')
  const publicDir = join(root, 'public')
  mkdirSync(dir)
  mkdirSync(publicDir)
  const privateFile = join(dir, 'caller', 'keys.json')
  const publicFile = join(publicDir, 'caller-keys.json')
  let now = iat * 1000
  let elapsed = 0
  let id = principal.workspace
  const signer = createSigner({ dir, publicDir, instance: () => id, now: () => now, monotonicNow: () => elapsed,
    random: fixedNonce ? () => Buffer.from(nonce, 'base64url') : undefined })
  return { dir, publicDir, privateFile, publicFile, signer,
    setInstance: value => { id = value }, advance: ms => { now += ms; elapsed += ms },
    moveWall: ms => { now += ms },
    readPublic: () => JSON.parse(readFileSync(publicFile)),
    rotate: (action, emergency = false) => rotateCallerKeys({ dir, publicDir, instance: id, action, emergency, now: () => now }),
  }
}

test('key store creates one private key with restricted modes and preserves corrupt state', t => {
  const f = setup(t)
  const state = loadCallerKeys(f.dir)
  assert.equal(state.keys.length, 1)
  assert.equal(statSync(join(f.dir, 'caller')).mode & 0o777, 0o700)
  assert.equal(statSync(f.privateFile).mode & 0o777, 0o600)
  const key = state.keys[0]
  const kid = createHash('sha256').update(Buffer.from(key.x, 'base64url')).digest().subarray(0, 16).toString('base64url')
  assert.equal(state.signer, kid)
  for (const bytes of ['{broken', JSON.stringify({ ...state, version: 2 }),
    JSON.stringify({ ...state, signer: 'unknown' }), JSON.stringify({ ...state, keys: [key, key, key] })]) {
    writeFileSync(f.privateFile, bytes)
    assert.throws(() => loadCallerKeys(f.dir))
    assert.ok(readFileSync(f.privateFile).equals(Buffer.from(bytes)))
  }
})

test('wire fixture, canonical target and frontend inventories', t => {
  const f = setup(t, { fixedNonce: true })
  const [h, p, s] = f.signer.sign(inputs).split('.')
  const { kid, x } = f.readPublic().keys[0]
  assert.equal(Buffer.from(h, 'base64url').toString(), wire.protectedHeaderTemplate.replace('<kid>', kid))
  assert.equal(p, wire.payloadSegment)
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
  assert.ok(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')))
  for (const [raw, expected] of wire.canonicalTargets) {
    const url = new URL(raw, 'https://gate.invalid')
    assert.equal(url.pathname + url.search, expected)
  }
  const { allowed, refused } = fixture('caller-frontend-paths')
  for (const path of allowed) assert.ok(frontendPath(new URL(path, 'https://gate.invalid')), path)
  for (const path of refused) assert.equal(frontendPath(new URL(path, 'https://gate.invalid')), undefined, path)
})

test('the signer and adapter share the wire fixture bounds', t => {
  const f = setup(t)
  const { targetBytes, headerBytes } = wire.limits
  const target = '/api/' + 'x'.repeat(targetBytes - 5)
  const assertion = f.signer.sign({ ...inputs, path: target })
  assert.ok(Buffer.byteLength(assertion) > 4096)
  const keys = adapterKeys(f.publicFile)
  const opts = { keys, method, path: target, nowSec: iat, startedAtSec: iat - 6 }
  assert.equal(verifyAssertion(assertion, opts).path, target)
  assert.throws(() => f.signer.sign({ ...inputs, path: target + 'x' }), /Invalid caller target/)
  for (const size of [headerBytes - 1, headerBytes]) {
    assert.throws(() => verifyAssertion('x'.repeat(size), opts), /Invalid assertion$/)
  }
  assert.throws(() => verifyAssertion('x'.repeat(headerBytes + 1), opts), /Invalid assertion size/)
  assert.throws(() => f.signer.sign({ ...inputs, path: target, principal: { ...principal, subject: 'x'.repeat(headerBytes) } }), /Invalid caller target/)
})

test('publication follows instance changes, skips a reset of the same instance and contains only public keys', t => {
  const f = setup(t)
  const signer = createSigner({ dir: f.dir, publicDir: f.publicDir, instance: () => instanceOf({ env: {}, dir: f.dir }) })
  signer.publish()
  assert.throws(() => statSync(f.privateFile), { code: 'ENOENT' })
  assert.throws(() => signer.sign(inputs))
  const owner = createOwner(f.dir)
  const signFor = workspace => signer.sign({ ...inputs, principal: { ...principal, workspace } })
  signFor(owner.instance_id)
  const before = statSync(f.publicFile)
  assert.equal(before.mode & 0o777, 0o644)
  assert.deepEqual(Object.keys(f.readPublic().keys[0]), ['kid', 'alg', 'crv', 'x'])
  const ownerFile = join(f.dir, 'owner.json')
  writeFileSync(ownerFile, JSON.stringify({ ...owner, auth: { reset: true } }))
  signFor(owner.instance_id)
  assert.equal(statSync(f.publicFile).ino, before.ino)
  rmSync(ownerFile)
  const next = createOwner(f.dir)
  signFor(next.instance_id)
  assert.notEqual(statSync(f.publicFile).ino, before.ino)
  assert.equal(f.readPublic().instance, next.instance_id)
  assert.throws(() => signFor(owner.instance_id))
  for (const role of ['owner', 'admin']) assert.throws(() =>
    signer.sign({ ...inputs, principal: { ...principal, workspace: next.instance_id, roles: [role] } }))
})

test('the signer picks up the promoted key and both cohorts verify until retirement', t => {
  const f = setup(t)
  const headers = () => f.signer.sign(inputs).split('.')
  assert.throws(() => f.rotate('promote'))
  assert.throws(() => f.rotate('retire'))
  const old = Array.from({ length: 3 }, headers)
  f.rotate('stage')
  assert.throws(() => f.rotate('stage'))
  f.rotate('promote')
  f.advance(1000)
  const next = Array.from({ length: 3 }, headers)
  const kidOf = h => JSON.parse(Buffer.from(h[0], 'base64url')).kid
  const verifyPublished = ([h, p, s]) => {
    const entry = f.readPublic().keys.find(item => item.kid === kidOf([h]))
    if (!entry) return false
    const key = createPublicKey({ key: { kty: 'OKP', crv: entry.crv, x: entry.x }, format: 'jwk' })
    return verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
  }
  assert.notEqual(kidOf(old[0]), kidOf(next[0]))
  assert.equal(new Set([...old, ...next].map(parts => parts.join('.'))).size, 6)
  assert.ok([...old, ...next].every(verifyPublished))
  assert.throws(() => f.rotate('retire'), /120 seconds/)
  f.rotate('retire', true)
  assert.ok(old.every(h => !verifyPublished(h)))
  assert.ok(next.every(verifyPublished))
  f.rotate('stage'); f.rotate('promote'); f.advance(120_000)
  f.rotate('retire')
  assert.equal(f.readPublic().keys.length, 1)
})

test('signer polling uses elapsed time while assertion timestamps follow wall-clock rollback', t => {
  const f = setup(t)
  const sign = () => f.signer.sign(inputs).split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url')))
  const [initial, claims] = sign()
  assert.equal(claims.iat, iat)
  f.rotate('stage')
  f.rotate('promote')
  f.moveWall(-120_000)
  f.advance(999)
  const [before, rolled] = sign()
  assert.equal(before.kid, initial.kid)
  assert.equal(rolled.iat, iat - 120)
  f.advance(1)
  const [after, fresh] = sign()
  assert.notEqual(after.kid, initial.kid)
  assert.equal(fresh.iat, iat - 119)
})

function cli(dir, publicDir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AUTOMAGIK_GATE_')))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../gate-caller.mjs', import.meta.url)), ...args], {
      env: { ...env, AUTOMAGIK_GATE_HOME: dir, AUTOMAGIK_GATE_CALLER_PUBLIC: publicDir }, stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('exit', resolve)
  })
}

test('gate startup and rotation refuse overlapping real key directories before creating keys', async t => {
  const root = mkdtempSync(join(tmpdir(), 'caller-containment-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dsh = join(root, 'dsh-mount')
  mkdirSync(dsh)
  const guard = join(root, 'no-listen.mjs')
  const stderr = join(root, 'stderr.log')
  writeFileSync(guard, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { Server } from 'node:net'
const realpath = fs.realpathSync
fs.realpathSync = (path, ...options) => realpath(path === '/dsh' ? ${JSON.stringify(dsh)} : path, ...options)
syncBuiltinESMExports()
Server.prototype.listen = () => { process.stderr.write('unexpected listener\\n'); throw new Error('unexpected listener') }
`)
  const scenarios = [
    ['public inside home', join(root, 'a'), join(root, 'a', 'public')],
    ['home inside public', join(root, 'b', 'home'), join(root, 'b')],
    ['same directory', join(root, 'c'), join(root, 'c')],
    ['home inside DSH', join(dsh, 'home'), join(root, 'd')],
    ['public inside DSH', join(root, 'e'), join(dsh, 'public')],
  ]
  for (const [index, [label, dir, published]] of scenarios.entries()) {
    mkdirSync(dir, { recursive: true })
    mkdirSync(published, { recursive: true })
    createOwner(dir)
    // The configured strings are siblings even when their real paths overlap.
    const homeAlias = join(root, `home-alias-${index}`)
    const publicAlias = join(root, `public-alias-${index}`)
    symlinkSync(dir, homeAlias)
    symlinkSync(published, publicAlias)
    const env = { PATH: process.env.PATH, AUTOMAGIK_GATE_HOME: homeAlias,
      AUTOMAGIK_GATE_CALLER_PUBLIC: publicAlias, AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_MULTIUSER: '1',
      AUTOMAGIK_GATE_ORIGIN: 'https://workspace.invalid' }
    for (const [file, args, diagnostic] of [
      ['gate-entrypoint.mjs', [], 'disabled or invalid configuration/state'],
      ['gate-caller.mjs', ['stage'], 'caller key rotation refused'],
    ]) {
      const fd = openSync(stderr, 'w')
      let child
      try {
        child = spawn(process.execPath, ['--import', guard, fileURLToPath(new URL(`../${file}`, import.meta.url)), ...args], {
          env, stdio: ['ignore', 'ignore', fd], timeout: 5000,
        })
      } finally { closeSync(fd) }
      const [status] = await once(child, 'exit')
      const what = `${label} via ${file}`
      assert.equal(status, 1, what)
      assert.match(readFileSync(stderr, 'utf8'), new RegExp(`^automagik-gate: ${diagnostic}[^\\n]*\\n$`), what)
      assert.throws(() => statSync(join(dir, 'caller')), { code: 'ENOENT' }, what)
      assert.throws(() => statSync(join(published, 'caller-keys.json')), { code: 'ENOENT' }, what)
    }
  }
})

test('CLI serializes concurrent stage, handles stale locks and enforces retire --now', async t => {
  const f = setup(t)
  const owner = createOwner(f.dir)
  loadCallerKeys(f.dir)
  const lock = join(f.dir, 'caller', '.lock')
  writeFileSync(lock, '')
  chmodSync(lock, 0o600)
  assert.equal(await cli(f.dir, f.publicDir, 'stage'), 1)
  const stale = new Date(Date.now() - 31_000)
  utimesSync(lock, stale, stale)
  const statuses = await Promise.all(Array.from({ length: 2 }, () => cli(f.dir, f.publicDir, 'stage')))
  assert.deepEqual(statuses.sort(), [0, 1])
  assert.equal(loadCallerKeys(f.dir).keys.length, 2)
  assert.equal(f.readPublic().keys.length, 2)
  assert.equal(f.readPublic().instance, owner.instance_id)
  assert.equal(await cli(f.dir, f.publicDir, 'promote'), 0)
  assert.equal(await cli(f.dir, f.publicDir, 'retire'), 1)
  assert.equal(await cli(f.dir, f.publicDir, 'retire', '--now'), 0)
  assert.equal(f.readPublic().keys.length, 1)
  assert.throws(() => statSync(lock), { code: 'ENOENT' })
})

test('failed promote and emergency retire publications resume the original rotation', async t => {
  const f = setup(t)
  const owner = createOwner(f.dir)
  const signer = () => createSigner({ dir: f.dir, publicDir: f.publicDir, instance: () => owner.instance_id, now: () => iat * 1000 })
  const claims = { ...inputs, principal: { ...principal, workspace: owner.instance_id } }
  const active = signer()
  const old = active.sign(claims)
  const original = loadCallerKeys(f.dir).signer
  const run = (...args) => cli(f.dir, f.publicDir, ...args)
  assert.equal(await run('stage'), 0)
  const backup = f.publicDir + '-backup'
  renameSync(f.publicDir, backup)
  assert.equal(await run('promote'), 1)
  const promoted = loadCallerKeys(f.dir).signer
  assert.notEqual(promoted, original)
  assert.equal(loadCallerKeys(f.dir).pending, 'promote')
  renameSync(backup, f.publicDir)
  assert.equal(await run('promote'), 0)
  assert.equal(loadCallerKeys(f.dir).signer, promoted)
  assert.equal(loadCallerKeys(f.dir).pending, undefined)

  const keys = adapterKeys(f.publicFile)
  const check = value => verifyAssertion(value, { keys, method, path, nowSec: iat, startedAtSec: iat - 6 })
  assert.equal(check(old).kid, original)
  renameSync(f.publicDir, backup)
  assert.equal(await run('retire', '--now'), 1)
  assert.equal(loadCallerKeys(f.dir).pending, 'retire')
  assert.equal(loadCallerKeys(f.dir).signer, promoted)
  renameSync(backup, f.publicDir)
  assert.equal(check(old).kid, original)
  assert.equal(await run('retire', '--now'), 0)
  assert.equal(loadCallerKeys(f.dir).pending, undefined)
  assert.throws(() => check(old), /Caller verification failed/)
  assert.equal(check(signer().sign(claims)).kid, promoted)

  assert.equal(await run('stage'), 0)
  renameSync(f.publicDir, backup)
  assert.equal(await run('promote'), 1)
  const pending = loadCallerKeys(f.dir).signer
  renameSync(backup, f.publicDir)
  const restarted = signer()
  restarted.publish()
  assert.equal(loadCallerKeys(f.dir).pending, undefined)
  assert.equal(check(restarted.sign(claims)).kid, pending)
  assert.equal(await run('promote'), 1)
  assert.equal(loadCallerKeys(f.dir).signer, pending)
})

import { linkSync } from 'node:fs'

test('caller rotation creates a missing home and private directory with restricted modes', t => {
  const f = setup(t)
  const dir = join(f.dir, 'new', 'home')
  rotateCallerKeys({ dir, action: 'stage' })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'caller')).mode & 0o777, 0o700)
  assert.equal(loadCallerKeys(dir).keys.length, 2)
})

test('a direct signer can publish in its home while keeping the private store in caller/', t => {
  const f = setup(t)
  const signer = createSigner({ dir: f.dir, publicDir: f.dir, instance: () => principal.workspace, now: () => iat * 1000 })
  assert.ok(signer.sign(inputs))
  const published = JSON.parse(readFileSync(join(f.dir, 'caller-keys.json'), 'utf8'))
  assert.equal(published.keys[0].kid, loadCallerKeys(f.dir).signer)
  assert.equal(Object.hasOwn(published.keys[0], 'd'), false)
})

test('caller private directory symlink into the published directory is refused before touching it', t => {
  const f = setup(t)
  chmodSync(f.publicDir, 0o755)
  symlinkSync(f.publicDir, join(f.dir, 'caller'))
  assert.throws(() => loadCallerKeys(f.dir))
  assert.throws(() => f.signer.publish())
  assert.throws(() => f.rotate('stage'))
  assert.equal(statSync(f.publicDir).mode & 0o777, 0o755)
  assert.throws(() => readFileSync(join(f.publicDir, 'keys.json')), { code: 'ENOENT' })
})

test('private key symlinks, hard links and open permissions are refused on fast, rotation and signer reload paths', t => {
  for (const how of ['symlink', 'hard link', 'mode']) {
    const f = setup(t)
    assert.ok(f.signer.sign(inputs))
    const backing = join(f.dir, 'backing')
    if (how === 'mode') chmodSync(f.privateFile, 0o644)
    else {
      renameSync(f.privateFile, backing)
      if (how === 'symlink') symlinkSync(backing, f.privateFile)
      else linkSync(backing, f.privateFile)
    }
    const bytes = readFileSync(f.privateFile)
    f.advance(1000)
    assert.throws(() => f.signer.sign(inputs))
    assert.throws(() => loadCallerKeys(f.dir))
    assert.throws(() => f.rotate('stage'))
    assert.deepEqual(readFileSync(f.privateFile), bytes)
  }
})
