// Saved resolutions live outside package folders and are reused only by the same manager.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { AdapterStore, BAD_TTL_MS, defaultInstall } from '../src/host/install.js'

const PKG = '@test/adapter'
const BIN = 'dist/index.js'
const FOLDER = 'test__adapter'
function tool(dir, name, script = '#!/bin/sh\n') {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, script, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-lockfiles-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'adapters')
  const manager = tool(join(root, 'bin'), 'pnpm')
  const env = { PATH: '', AUTOMAGIK_PNPM: manager }
  const w = { root, home, env, version: '1.0.0', now: 1000, calls: [], logs: [], lock: 'lockfileVersion: 9.0\n# original\n' }
  const install = async (dir, pkg, version, gotEnv, options) => {
    assert.equal(gotEnv, env)
    assert.equal(pkg, PKG)
    const name = gotEnv.AUTOMAGIK_PNPM ? 'pnpm-lock.yaml' : 'package-lock.json'
    const lock = join(dir, name)
    w.calls.push({ dir, version, options, lock: existsSync(lock) ? readFileSync(lock, 'utf8') : undefined })
    await w.before?.(dir, options)
    const entry = join(dir, 'node_modules', ...pkg.split('/'), BIN)
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// installed\n')
    writeFileSync(lock, w.lock)
  }
  w.store = new AdapterStore({ home, env, install, latest: async () => w.version, now: () => w.now, log: line => w.logs.push(line) })
  w.archive = version => join(home, '.locks', FOLDER, version)
  w.saved = (version, name = 'pnpm-lock.yaml') => readFileSync(join(w.archive(version), name), 'utf8')
  w.update = () => w.store.update(PKG, BIN, { force: true })
  w.repair = () => w.store.repair(PKG, BIN)
  return w
}

test('successful installs save a lockfile, repairs freeze it, and new releases resolve independently', async (t) => {
  const w = setup(t)
  await w.update()
  assert.deepEqual(readdirSync(w.archive('1.0.0')), ['pnpm-lock.yaml'])
  assert.equal(w.saved('1.0.0'), w.lock)
  assert.equal(w.calls[0].options.frozen, undefined)
  assert.deepEqual(readdirSync(join(w.home, FOLDER)).sort(), ['1.0.0', 'current.json'])
  // A new store reads the saved lock too; it is not just an in-memory cache.
  w.store = new AdapterStore({ home: w.home, env: w.env, install: w.store.install, latest: async () => w.version })
  await w.repair()
  assert.equal(w.calls[1].options.frozen, true)
  assert.equal(w.calls[1].lock, w.lock)
  w.store.markGood(PKG)
  w.version = '2.0.0'
  w.lock = 'lockfileVersion: 9.0\n# second\n'
  await w.update()
  assert.equal(w.calls[2].options.frozen, undefined)
  assert.equal(w.calls[2].lock, undefined)
  assert.equal(w.saved('2.0.0'), w.lock)
  assert.ok(existsSync(w.archive('1.0.0')), 'the previous version keeps its lock')
  w.store.markGood(PKG)
  w.version = '3.0.0'
  await w.update()
  assert.equal(existsSync(w.archive('1.0.0')), false)
  assert.deepEqual(readdirSync(join(w.home, '.locks', FOLDER)).sort(), ['2.0.0', '3.0.0'])
})

test('a frozen failure retries once in empty staging and replaces its saved resolution', async (t) => {
  const w = setup(t)
  await w.update()
  const old = w.lock
  w.lock = 'lockfileVersion: 9.0\n# resolved afresh\n'
  w.before = async (dir, { frozen }) => {
    if (frozen) {
      writeFileSync(join(dir, 'partial'), 'leftovers')
      throw new Error('unsupported lock format\nprivate details')
    }
    assert.equal(existsSync(join(dir, 'partial')), false)
    assert.equal(existsSync(join(dir, 'pnpm-lock.yaml')), false)
    assert.deepEqual(readdirSync(dir), ['package.json'])
  }
  await w.repair()
  assert.equal(w.calls.length, 3)
  assert.equal(w.calls[1].lock, old)
  assert.equal(w.calls[1].options.frozen, true)
  assert.equal(w.calls[2].options.frozen, undefined)
  assert.notEqual(w.calls[1].dir, w.calls[2].dir)
  assert.equal(existsSync(w.calls[1].dir), false)
  assert.equal(w.saved('1.0.0'), w.lock)
  assert.ok(w.logs.includes(`${PKG}@1.0.0: its recorded lockfile could not be installed (unsupported lock format); resolving afresh`))
  assert.equal(w.store.lastError(PKG), undefined)
})

test('a failed fresh fallback is final and keeps the prior lock and selected installation', async (t) => {
  const w = setup(t)
  const original = await w.update()
  w.before = async (dir) => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'partial lock')
    throw new Error('unavailable')
  }
  await assert.rejects(w.repair(), /unavailable/)
  assert.equal(w.calls.length, 3)
  assert.equal(w.saved('1.0.0'), w.lock)
  assert.deepEqual(w.store.binOf(PKG, BIN), original)
  assert.deepEqual(readdirSync(join(w.home, FOLDER)).sort(), ['1.0.0', 'current.json'])
})

for (const why of ['quit', 'timeout']) {
  test(`a frozen install stopped by ${why} never retries fresh`, async (t) => {
    const w = setup(t)
    const original = await w.update()
    w.before = async () => {
      if (why === 'quit') w.store.dispose()
      throw new Error(why === 'quit' ? 'install stopped: DSH is quitting' : 'install timed out after 600s')
    }
    await assert.rejects(w.repair(), /install (stopped|timed out)/)
    assert.equal(w.calls.length, 2)
    assert.equal(w.calls[1].options.frozen, true)
    assert.equal(w.saved('1.0.0'), w.lock)
    assert.deepEqual(w.store.binOf(PKG, BIN), original)
    assert.equal(w.logs.length, 1)
  })
}

test('a failed start check retains its lock for a frozen retry after the bad-version hold', async (t) => {
  const w = setup(t)
  await w.update()
  w.version = '2.0.0'
  w.store.check = async () => { throw new Error('bad start') }
  await w.update()
  assert.equal(w.saved('2.0.0'), w.lock)
  assert.equal(w.store.stateOf(PKG).bad.version, '2.0.0')
  await w.update()
  assert.equal(w.calls.length, 2)
  assert.ok(existsSync(w.archive('2.0.0')))
  w.now += BAD_TTL_MS + 1
  w.store.check = undefined
  await w.update()
  assert.equal(w.calls[2].options.frozen, true)
  assert.equal(w.calls[2].lock, w.lock)
})

test('a different manager resolves fresh and leaves exactly its own lockfile', async (t) => {
  const w = setup(t)
  await w.update()
  delete w.env.AUTOMAGIK_PNPM
  const npm = tool(join(w.root, 'bin'), 'npm')
  w.env.PATH = dirname(npm)
  w.lock = '{"lockfileVersion": 3}\n'
  await w.repair()
  assert.equal(w.calls[1].options.frozen, undefined)
  assert.equal(w.calls[1].lock, undefined)
  assert.deepEqual(readdirSync(w.archive('1.0.0')), ['package-lock.json'])
  assert.equal(w.saved('1.0.0', 'package-lock.json'), w.lock)
  await w.repair()
  assert.equal(w.calls[2].options.frozen, true)
  assert.equal(w.calls[2].lock, w.lock)
})

test('defaultInstall chooses the exact fresh and frozen flags for pnpm and npm', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'acp-lock-argv-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/argv"\n'
  const pnpm = tool(join(root, 'bin'), 'pnpm', script)
  tool(join(root, 'bin'), 'npm', script)
  const pnpmBase = ['install', '--prod', '--ignore-scripts', '--config.node-linker=hoisted', '--config.ignore-workspace=true', '--reporter=silent']
  const npmBase = ['--omit=optional', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']
  for (const kind of ['pnpm', 'npm']) {
    for (const frozen of [false, true]) {
      const dir = join(root, `${kind}-${frozen}`)
      mkdirSync(dir)
      const env = { PATH: join(root, 'bin'), CI: 'true', ...(kind === 'pnpm' ? { AUTOMAGIK_PNPM: pnpm } : {}) }
      await defaultInstall(dir, PKG, '1.0.0', env, { frozen })
      const argv = readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n')
      assert.deepEqual(argv, kind === 'pnpm'
        ? [...pnpmBase, ...(frozen ? ['--frozen-lockfile', '--prefer-offline'] : ['--no-frozen-lockfile'])]
        : [frozen ? 'ci' : 'install', ...npmBase, ...(frozen ? ['--prefer-offline'] : [])])
    }
  }
})

test('a release held back after a failed start keeps its lock, and its retry after the hold freezes it', async (t) => {
  const w = setup(t)
  await w.update()
  w.store.markGood(PKG)
  w.version = '2.0.0'
  w.lock = 'lockfileVersion: 9.0\n# held release\n'
  w.store.check = async () => { throw new Error('bad start') }
  await w.update()
  assert.equal(w.store.stateOf(PKG).bad.version, '2.0.0')
  assert.equal(w.saved('2.0.0'), w.lock, 'recorded before its start check failed')
  // Within the hold: npm is asked again, nothing is installed, and the lock stays.
  w.now += 24 * 60 * 60 * 1000
  await w.update()
  assert.equal(w.calls.length, 2)
  assert.ok(existsSync(w.archive('2.0.0')))
  // Once the hold is over the same release is tried again, on the same resolution.
  w.store.check = undefined
  w.now += BAD_TTL_MS
  await w.update()
  assert.equal(w.calls[2].version, '2.0.0')
  assert.equal(w.calls[2].options.frozen, true)
  assert.equal(w.calls[2].lock, 'lockfileVersion: 9.0\n# held release\n')
  assert.equal(w.store.binOf(PKG, BIN).version, '2.0.0')
})

test('a repair of an install made before lockfiles were recorded freezes the one in its folder', async (t) => {
  const w = setup(t)
  // An adapter installed by an earlier version: its folder holds the package manager's own
  // lockfile, and nothing was recorded outside it.
  const installed = join(w.home, FOLDER, '1.0.0')
  const entry = join(installed, 'node_modules', ...PKG.split('/'), BIN)
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, '// installed\n')
  writeFileSync(join(installed, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# left by the first install\n')
  writeFileSync(join(w.home, FOLDER, 'current.json'), `${JSON.stringify({ version: '1.0.0', checkedAt: w.now })}\n`)
  w.version = '9.9.9'
  await w.repair()
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0].version, '1.0.0')
  assert.equal(w.calls[0].options.frozen, true)
  assert.equal(w.calls[0].lock, 'lockfileVersion: 9.0\n# left by the first install\n')
  assert.equal(w.saved('1.0.0'), w.lock, 'the repair records the lockfile it installed with')
})

test('a new release never freezes on the lockfile of the version it replaces', async (t) => {
  const w = setup(t)
  await w.update()
  w.store.markGood(PKG)
  w.version = '2.0.0'
  await w.update()
  assert.equal(w.calls[1].version, '2.0.0')
  assert.equal(w.calls[1].options.frozen, undefined)
  assert.equal(w.calls[1].lock, undefined)
})
