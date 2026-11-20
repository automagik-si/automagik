import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { adaptersHome } from '../src/host/install.js'
import { installationCliHome, installationIdentity } from '../src/host/installation.js'

const run = promisify(execFile)
const resolver = new URL('../src/host/installation.js', import.meta.url).href

function scratch(t) {
  const acp = mkdtempSync(join(tmpdir(), 'acp-installation-'))
  t.after(() => rmSync(acp, { recursive: true, force: true }))
  const legacy = join(acp, 'cli-homes')
  return { acp, legacy, claim: join(legacy, 'installation.json'),
    a: join(acp, 'dsh-a'), b: join(acp, 'dsh-b') }
}

function own(acp, home) {
  const id = createHash('sha256').update(installationIdentity(home)).digest('hex').slice(0, 32)
  return { root: join(acp, 'installations', id, 'cli-homes'), owner: false }
}

test('the preload puts the default adapters and sign-in claim under a scratch home', () => {
  const home = process.env.AUTOMAGIK_HOME
  assert.ok(home.startsWith(join(tmpdir(), 'acp-test-home-')))
  assert.equal(adaptersHome(), join(home, 'acp', 'adapters'))
  assert.notEqual(adaptersHome(), join(homedir(), '.automagik', 'acp', 'adapters'))
  assert.equal(lstatSync(home).isDirectory(), true)
})

test('the first claim keeps legacy data, and each identity gets a stable CLI root', t => {
  const { acp, legacy, claim, a, b } = scratch(t)
  const auth = join(legacy, 'claude', 'fake-auth')
  mkdirSync(join(legacy, 'claude'), { recursive: true })
  writeFileSync(auth, 'owner@example.test')
  writeFileSync(`${claim}.interrupted`, '{')
  const warnings = []
  const options = { warn: line => warnings.push(line) }
  assert.deepEqual(installationCliHome(acp, a, options), { root: legacy, owner: true })
  const bytes = readFileSync(claim, 'utf8')
  assert.deepEqual(JSON.parse(bytes), { version: 1, identity: installationIdentity(a) })
  if (process.platform !== 'win32') assert.equal(lstatSync(claim).mode & 0o777, 0o600)
  assert.deepEqual(installationCliHome(acp, b, options), own(acp, b))
  assert.deepEqual(installationCliHome(acp, a, options), { root: legacy, owner: true })
  assert.deepEqual(installationCliHome(acp, b, options), own(acp, b))
  assert.equal(readFileSync(claim, 'utf8'), bytes)
  assert.equal(readFileSync(auth, 'utf8'), 'owner@example.test')
  assert.deepEqual(readdirSync(legacy).sort(), ['claude', 'installation.json', 'installation.json.interrupted'])
  assert.deepEqual(warnings, [])
})

test('a preselected owner keeps the legacy root until the claim is removed', t => {
  const { acp, legacy, claim, a, b } = scratch(t)
  mkdirSync(legacy)
  const preselected = JSON.stringify({ version: 1, identity: b })
  writeFileSync(claim, preselected)
  assert.deepEqual(installationCliHome(acp, a), own(acp, a))
  assert.deepEqual(installationCliHome(acp, b), { root: legacy, owner: true })
  assert.equal(readFileSync(claim, 'utf8'), preselected)
  rmSync(claim)
  assert.deepEqual(installationCliHome(acp, a), { root: legacy, owner: true })
  assert.deepEqual(installationCliHome(acp, b), own(acp, b))
})

test('blank, tilde, trailing slash and symlink aliases resolve consistently', t => {
  const { acp, legacy, a, b } = scratch(t)
  const home = join(acp, 'fake-user')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  Object.assign(process.env, { HOME: home, USERPROFILE: home })
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  assert.equal(installationIdentity(''), installationIdentity('~/.dsh'))
  assert.equal(installationIdentity('  '), installationIdentity(join(home, '.dsh')))
  assert.equal(installationIdentity('~'), installationIdentity(home))
  mkdirSync(a)
  symlinkSync(a, b, 'junction')
  assert.equal(installationIdentity(`${a}${sep}`), installationIdentity(a))
  assert.equal(installationIdentity(b), installationIdentity(a))
  assert.deepEqual(installationCliHome(acp, b), { root: legacy, owner: true })
  assert.deepEqual(installationCliHome(acp, a), { root: legacy, owner: true })
})

test('damaged claims leave both installations isolated and preserve the claim', t => {
  const { acp, legacy, claim, a, b } = scratch(t)
  mkdirSync(legacy)
  const valid = JSON.stringify({ version: 1, identity: a })
  const damaged = ['{', JSON.stringify({ version: 2, identity: a }),
    JSON.stringify({ version: 1, identity: 'relative' }), valid.padEnd(4097)]
  for (const bytes of damaged) {
    writeFileSync(claim, bytes)
    for (const home of [a, b, a]) {
      const warnings = []
      assert.deepEqual(installationCliHome(acp, home, { warn: line => warnings.push(line) }),
        own(acp, home))
      assert.equal(warnings.length, 1)
      assert.equal(readFileSync(claim, 'utf8'), bytes)
    }
  }
})

test('a dangling claim symlink is damaged even when its target later holds a valid claim', t => {
  const { acp, legacy, claim, a } = scratch(t)
  mkdirSync(legacy)
  const target = join(acp, 'missing-claim')
  symlinkSync(target, claim, 'file')
  const warnings = []
  const options = { warn: line => warnings.push(line) }
  assert.deepEqual(installationCliHome(acp, a, options), own(acp, a))
  assert.equal(warnings.length, 1)
  assert.equal(lstatSync(claim).isSymbolicLink(), true)
  assert.equal(existsSync(target), false)
  writeFileSync(target, JSON.stringify({ version: 1, identity: a }))
  assert.deepEqual(installationCliHome(acp, a, options), own(acp, a))
  assert.equal(warnings.length, 2)
  assert.equal(lstatSync(claim).isSymbolicLink(), true)
})

test('a failed claim read retries three times and recovers on the next launch', t => {
  const { acp, legacy, claim, a } = scratch(t)
  mkdirSync(legacy)
  const bytes = JSON.stringify({ version: 1, identity: a })
  writeFileSync(claim, bytes)
  let reads = 0
  const lstat = lstatSync
  const mock = t.mock.method(fs, 'lstatSync', (...args) => {
    if (args[0] === claim && ++reads <= 4) {
      throw Object.assign(new Error('fake read failure'), { code: 'EACCES' })
    }
    return lstat(...args)
  })
  syncBuiltinESMExports()
  try {
    const warnings = []
    const options = { warn: line => warnings.push(line) }
    assert.deepEqual(installationCliHome(acp, a, options), own(acp, a))
    assert.equal(reads, 4)
    assert.equal(warnings.length, 1)
    assert.deepEqual(installationCliHome(acp, a, options), { root: legacy, owner: true })
    assert.equal(reads, 5)
    assert.equal(warnings.length, 1)
    assert.equal(readFileSync(claim, 'utf8'), bytes)
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('a failed claim publication warns, removes its temporary file, and leaves the legacy root unclaimed', t => {
  const { acp, legacy, claim, a, b } = scratch(t)
  const mock = t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('fake publication failure'), { code: 'EACCES' })
  })
  syncBuiltinESMExports()
  const warnings = []
  try {
    assert.deepEqual(installationCliHome(acp, a, { warn: line => warnings.push(line) }), own(acp, a))
    assert.equal(warnings.length, 1)
    assert.deepEqual(readdirSync(legacy), [])
    assert.equal(existsSync(claim), false)
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(installationCliHome(acp, b), { root: legacy, owner: true })
})

test('eight processes racing for the legacy root select one durable winner', { timeout: 15_000 }, async t => {
  const { acp, legacy, claim } = scratch(t)
  const homes = Array.from({ length: 8 }, (_, i) => join(acp, `dsh-${i}`))
  const source = `
    import { installationCliHome } from ${JSON.stringify(resolver)}
    const [acp, home, race] = process.argv.slice(1)
    if (race) {
      const start = new Promise(resolve => process.stdin.once('end', resolve))
      process.stdin.resume()
      console.log('ready')
      await start
    }
    console.log(JSON.stringify(installationCliHome(acp, home)))
  `
  const launch = (home, race) => run(process.execPath,
    ['--input-type=module', '-e', source, acp, home, ...(race ? ['race'] : [])], { timeout: 10_000 })
  const contenders = homes.map(home => {
    const running = launch(home, true)
    t.after(() => running.child.kill())
    const ready = Promise.race([
      new Promise(resolve => running.child.stdout.once('data', resolve)),
      running.then(() => assert.fail('claim contender exited before the race')),
    ])
    return { running, ready }
  })
  const chunks = await Promise.all(contenders.map(({ ready }) => ready))
  for (const chunk of chunks) assert.equal(String(chunk).trim(), 'ready')
  for (const { running } of contenders) running.child.stdin.end()
  const results = await Promise.all(contenders.map(async ({ running }) =>
    JSON.parse((await running).stdout.trim().split('\n').at(-1))))
  const winner = results.findIndex(result => result.owner)
  assert.notEqual(winner, -1)
  assert.deepEqual(results, homes.map((home, i) => i === winner
    ? { root: legacy, owner: true } : own(acp, home)))
  assert.deepEqual(JSON.parse(readFileSync(claim, 'utf8')),
    { version: 1, identity: installationIdentity(homes[winner]) })
  assert.deepEqual(readdirSync(legacy), ['installation.json'])
  const again = await Promise.all(homes.map(async home => JSON.parse((await launch(home, false)).stdout)))
  assert.deepEqual(again, results)
})
