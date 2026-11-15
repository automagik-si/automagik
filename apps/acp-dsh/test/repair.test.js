// Repairs keep the release and its provenance while replacing only the selected folder.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { AdapterStore, CHECK_EVERY_MS } from '../src/host/install.js'

const PKG = '@test/adapter'
const BIN = 'dist/index.js'
const FOLDER = 'test__adapter'
function setup(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'acp-repair-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const world = { home, version: '1.0.0', now: 1000, asks: 0, installs: [], checks: [] }
  const store = new AdapterStore({
    home, env: { PATH: '' }, now: () => world.now,
    latest: async () => { world.asks++; return world.version },
    install: async (dir, pkg, version) => {
      world.installs.push(version)
      const entry = join(dir, 'node_modules', ...pkg.split('/'), BIN)
      fs.mkdirSync(dirname(entry), { recursive: true })
      fs.writeFileSync(entry, `// ${version}\n`)
    },
    check: async (pkg, staged) => { world.checks.push(staged); assert.ok(fs.existsSync(staged.path)) },
  })
  const folder = join(home, FOLDER)
  const file = join(folder, 'current.json')
  return Object.assign(world, {
    store, folder, file,
    bytes: () => fs.readFileSync(file, 'utf8'),
    record: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    entries: () => fs.readdirSync(folder).sort(),
    update: () => store.update(PKG, BIN, { force: true }),
    repair: () => store.repair(PKG, BIN),
  })
}

test('repair selects the same release in a new folder and preserves every other record field', async (t) => {
  const w = setup(t)
  await w.update()
  w.store.markGood(PKG)
  w.version = '2.0.0'
  await w.update()
  const old = w.store.binOf(PKG, BIN)
  const before = w.record()
  w.version = '3.0.0'
  const asks = w.asks
  const repaired = await w.repair()
  assert.equal(w.asks, asks)
  assert.deepEqual(w.installs, ['1.0.0', '2.0.0', '2.0.0'])
  assert.match(w.record().dir, /^2\.0\.0_r1000/)
  assert.deepEqual(w.record(), { ...before, dir: w.record().dir, retired: [{ dir: '2.0.0', at: 1000 }] })
  assert.deepEqual(repaired, { path: join(w.folder, w.record().dir, 'node_modules', ...PKG.split('/'), BIN), version: '2.0.0' })
  assert.ok(fs.existsSync(old.path))
  assert.match(w.checks.at(-1).path, /\.install-/)
  w.store.markGood(PKG)
  assert.equal(w.record().proven, true)
  assert.equal(w.store.binOf(PKG, BIN).path, repaired.path)
})

test('a missing entry still repairs the version recorded on disk', async (t) => {
  const w = setup(t)
  const old = await w.update()
  fs.rmSync(old.path)
  w.version = '2.0.0'
  assert.equal(w.store.binOf(PKG, BIN), undefined)
  assert.equal((await w.repair()).version, '1.0.0')
  assert.equal(w.asks, 1)
  assert.ok(fs.existsSync(join(w.folder, '1.0.0')))
})

test('a failed repair check keeps the record and folders and records a failure without marking bad', async (t) => {
  const w = setup(t)
  await w.update()
  const before = w.bytes()
  const folders = w.entries()
  w.store.check = async () => { throw new Error('repair check failed') }
  await assert.rejects(w.repair(), /repair check failed/)
  assert.equal(w.bytes(), before)
  assert.deepEqual(w.entries(), folders)
  assert.equal(w.record().bad, undefined)
  assert.equal(w.record().rolledBack, undefined)
  assert.match(w.store.lastError(PKG), /repair check failed/)
  assert.match(fs.readFileSync(w.store.lastFailure(PKG).logPath, 'utf8'), /repair check failed/)
  w.store.check = undefined
  await w.repair()
  assert.equal(w.store.lastFailure(PKG), undefined)
})

test('repair with nothing installed installs latest without adding selectors or archives', async (t) => {
  const w = setup(t)
  assert.equal((await w.repair()).version, '1.0.0')
  assert.deepEqual(w.record(), { version: '1.0.0', checkedAt: 1000, proven: false })
  assert.deepEqual(fs.readdirSync(w.home), [FOLDER])
  assert.deepEqual(w.entries(), ['1.0.0', 'current.json'])
})

test('updates retain repaired folders and rollback follows the repaired previous directory', async (t) => {
  const w = setup(t)
  const damaged = await w.update()
  w.store.markGood(PKG)
  const repaired = await w.repair()
  const dir = w.record().dir
  await w.update()
  assert.equal(w.store.binOf(PKG, BIN).path, repaired.path)
  // A Session started before the repair may still run the folder it moved off: it stays for a
  // check window, as a replaced release does, and goes at the first update after that.
  assert.ok(fs.existsSync(damaged.path))
  w.now += CHECK_EVERY_MS
  await w.update()
  assert.equal(fs.existsSync(damaged.path), false)
  assert.equal(w.record().retired, undefined)
  w.version = '2.0.0'
  await w.update()
  assert.equal(w.record().previousDir, dir)
  assert.equal(w.store.stateOf(PKG).previous, '1.0.0')
  assert.deepEqual(w.store.rollback(PKG, BIN, new Error('broken')), repaired)
  assert.equal(w.record().dir, dir)
  assert.equal(w.store.stateOf(PKG).proven, true)
})

test('every folder a repair moved off stays for a check window, then goes', async (t) => {
  const w = setup(t)
  const old = await w.update()
  const first = await w.repair()
  const firstDir = w.record().dir
  w.now += 1000
  const second = await w.repair()
  assert.notEqual(first.path, second.path)
  assert.ok(fs.existsSync(first.path))
  assert.ok(fs.existsSync(old.path), 'a second repair keeps the folder the first one moved off')
  assert.deepEqual(w.record().retired.map(entry => entry.dir), ['1.0.0', firstDir])
  w.now += CHECK_EVERY_MS
  await w.update()
  assert.equal(fs.existsSync(old.path), false)
  assert.equal(fs.existsSync(first.path), false)
  assert.ok(fs.existsSync(second.path))
})

test('repair rename failure keeps the record and removes staging', async (t) => {
  const w = setup(t)
  await w.update()
  const before = w.bytes()
  const entries = w.entries()
  const rename = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.includes('_r')) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(w.repair(), /could not move its repaired connector into place \(EPERM\)/)
  assert.equal(w.bytes(), before)
  assert.deepEqual(w.entries(), entries)
})

test('repair uses a counter when the chosen name is occupied', async (t) => {
  const w = setup(t)
  await w.update()
  fs.writeFileSync(join(w.folder, '1.0.0_r1000'), 'occupied')
  await w.repair()
  assert.equal(w.record().dir, '1.0.0_r1000_1')
})

test('repair joins other repairs and waits for an update, including a failed update', async (t) => {
  for (const fails of [false, true]) {
    const w = setup(t)
    await w.update()
    let finish
    w.store.latest = () => new Promise((resolve, reject) => { finish = () => fails ? reject(new Error('offline')) : resolve('2.0.0') })
    const update = w.update()
    const outcome = update.catch(() => {})
    const repair = w.repair()
    assert.equal(w.repair(), repair)
    assert.equal(w.store.update(PKG, BIN), repair)
    finish()
    await outcome
    assert.equal((await repair).version, fails ? '1.0.0' : '2.0.0')
    assert.equal(w.store.busy(PKG), false)
    assert.equal(w.store.lastFailure(PKG), undefined)
    assert.deepEqual(w.installs, fails ? ['1.0.0', '1.0.0'] : ['1.0.0', '2.0.0', '2.0.0'])
  }
})

test('repair keeps a concurrent markGood and abandons its candidate after a rollback', async (t) => {
  const w = setup(t)
  await w.update()
  w.store.check = async () => w.store.markGood(PKG)
  await w.repair()
  assert.equal(w.record().proven, true)
  w.version = '2.0.0'
  w.store.check = undefined
  await w.update()
  let back
  w.store.check = async () => { back = w.store.rollback(PKG, BIN, 'broken') }
  const folders = w.entries()
  assert.deepEqual(await w.repair(), back)
  assert.equal(w.record().version, '1.0.0')
  assert.deepEqual(w.entries(), folders)
})

test('invalid directory selectors fall back to version folders', async (t) => {
  const w = setup(t)
  const old = await w.update()
  w.store.markGood(PKG)
  w.version = '2.0.0'
  const current = await w.update()
  const record = w.record()
  for (const dir of ['', '.', '..', '.hidden', '../escape', 'a/b', 'a\\b', '/absolute', 42, 'bad\0name']) {
    fs.writeFileSync(w.file, JSON.stringify({ ...record, dir, previousDir: dir }))
    assert.deepEqual(w.store.binOf(PKG, BIN), current)
    assert.equal(w.store.stateOf(PKG).previous, '1.0.0')
    assert.deepEqual(w.store.rollback(PKG, BIN, 'broken'), old)
    assert.equal(w.record().dir, undefined)
  }
})

test('repair refuses missing package names and quit without creating folders', async (t) => {
  const w = setup(t)
  for (const pkg of [undefined, '', null, 7]) await assert.rejects(w.store.repair(pkg, BIN), /needs a package name/)
  assert.deepEqual(fs.readdirSync(w.home), [])
  w.store.dispose()
  await assert.rejects(w.repair(), /DSH is quitting/)
  assert.deepEqual(fs.readdirSync(w.home), [])
})

test('a concurrent same-version directory change wins over the staged repair', async (t) => {
  const w = setup(t)
  await w.update()
  const repaired = await w.repair()
  const before = w.record()
  const folders = w.entries()
  w.store.check = async () => fs.writeFileSync(w.file, JSON.stringify({ ...before, dir: '1.0.0' }))
  const result = await w.repair()
  assert.notEqual(result.path, repaired.path)
  assert.equal(w.record().dir, '1.0.0')
  assert.deepEqual(w.entries(), folders)
})

test('a pointer write failure removes the new folder and temporary record', async (t) => {
  const w = setup(t)
  await w.update()
  const before = w.bytes()
  const entries = w.entries()
  const rename = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === w.file) throw Object.assign(new Error('pointer busy'), { code: 'EPERM' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(w.repair(), /pointer busy/)
  assert.equal(w.bytes(), before)
  assert.deepEqual(w.entries(), entries)
})

for (const kind of ['missing entry', 'bundled platform CLI', 'quit']) {
  test(`repair refuses ${kind} without changing the selected installation`, async (t) => {
    const w = setup(t)
    await w.update()
    const before = w.bytes()
    const entries = w.entries()
    const install = w.store.install
    w.store.install = async (dir, ...args) => {
      await install(dir, ...args)
      if (kind === 'missing entry') fs.rmSync(join(dir, 'node_modules', ...PKG.split('/'), BIN))
      if (kind === 'bundled platform CLI') fs.mkdirSync(join(dir, 'node_modules', '@openai', 'codex-linux-x64'), { recursive: true })
      if (kind === 'quit') w.store.dispose()
    }
    await assert.rejects(w.repair(), kind === 'missing entry' ? /installed without/ : kind === 'quit' ? /DSH is quitting/ : /installed the CLIs it bundles/)
    assert.equal(w.bytes(), before)
    assert.deepEqual(w.entries(), entries)
    assert.equal(w.record().bad, undefined)
  })
}
