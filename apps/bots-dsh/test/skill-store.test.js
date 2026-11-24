import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  LIMITS, SkillFilesChanged, bodyOf, createSkillStore, fileEntries, folderOf, manifestOf, skillHash, skillPreflight, textSkillMd,
} from '../src/host/skill-store.js'
import { makeSkillFixtureWritable } from './fixtures/skill-home-cleanup.mjs'

export const GOLDEN = Object.freeze({
  bytes: '---\nname: field-guide\ndescription: "Keep notes"\n---\n\nWrite a short note.\n',
  hash: 'b9b358086a46b5258de7d18d14ed7d8e692874155873e351d8abde3fed0c5697',
})

const fake = (path = 'SKILL.md', bytes = GOLDEN.bytes) => ({ path, bytes: Buffer.from(bytes) })
const key = (key, code) => error => error.key === `skill.${key}` && (code === undefined || error.params?.code === code)

function fixture(t, mode = 'write') {
  const home = fs.mkdtempSync(join(tmpdir(), 'dsh-skill-store-'))
  t.after(() => {
    makeSkillFixtureWritable(home)
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, store: createSkillStore(home, { mode }), root: join(home, 'skills') }
}

function publishFixture(store, name, entries) {
  const files = fileEntries(entries)
  const hash = skillHash(files)
  store.writeManifest(name, hash, manifestOf(files))
  assert.equal(store.publish(name, entries), hash)
  return { files, hash }
}

test('skill-store: pins the content hash and orders UTF-8 paths by bytes', () => {
  assert.equal(skillHash([fake()]), GOLDEN.hash)
  const list = [fake(), fake('z.md', 'a'), fake('á.md', 'b')]
  assert.deepEqual(fileEntries(list).map(file => file.path), ['SKILL.md', 'z.md', 'á.md'])
  assert.equal(skillHash(list), skillHash(list.toReversed()))
  assert.notEqual(skillHash(list), skillHash([list[0], fake('y.md', 'a'), list[2]]))
  assert.equal(folderOf('con'), 'con_')
})

test('skill-store: generated text round-trips line endings and quoted descriptions', () => {
  for (const content of ['', 'lines\r\n---\r\n后续\n', 'paragraph\n\n']) {
    const bytes = textSkillMd({ name: 'field-guide', description: 'Unicode\u2028\u2029\ufeff and "\\"', content })
    assert.equal(bodyOf(bytes), content)
    assert.match(bytes.toString(), /\\u2028\\u2029\\ufeff/)
  }
})

test('skill-store: applies every cap to final bytes and limits legacy proof to one matching body', () => {
  for (const [entries, reason] of [
    [[fake('SKILL.md', Buffer.alloc(LIMITS.skillMd + 1))], 'too-large-md'],
    [[fake(), fake('large.txt', Buffer.alloc(LIMITS.file + 1))], 'too-large-file'],
    [[fake(), ...Array.from({ length: 5 }, (_, i) => fake(`part-${i}`, Buffer.alloc(LIMITS.file)))], 'too-large-total'],
    [[fake(), ...Array.from({ length: 256 }, (_, i) => fake(`part-${i}`, 'a'))], 'too-many-files'],
  ]) assert.throws(() => skillPreflight(entries), key(reason))
  const original = [fake('SKILL.md', Buffer.alloc(LIMITS.total + 1))]
  const [proof] = fileEntries(original)
  assert.equal(skillPreflight(original, { legacyBody: proof }).entries[0].bytes.length, proof.size)
  assert.throws(() => skillPreflight([...original, fake('other.md', 'a')], { legacyBody: proof }), key('too-large-md'))
  assert.throws(() => skillPreflight(original, { legacyBody: { ...proof, sha256: '0'.repeat(64) } }), key('too-large-md'))
})

test('skill-store: rejects nonportable names and component collisions', () => {
  for (const path of ['../escape', 'Docs//a', 'a/b/../c', 'a\\b', 'a:b', 'q?', 'x/nul.md', 'con.txt', 'lpt¹.cfg', 'COM³.tar.gz', 'conin$.txt', 'clock$.ext', 'file.']) {
    assert.throws(() => skillPreflight([fake(), fake(path)]), key('path'), path)
  }
  for (const list of [['Docs/a', 'docs/b'], ['a', 'A/b'], ['café/a', 'cafe\u0301/b'], ['SKILL.md']]) {
    assert.throws(() => skillPreflight([fake(), ...list.map(path => fake(path))]), key('path'))
  }
})

test('skill-store: binds a reader without creating an absent store and never follows a linked root', t => {
  const { store, home, root } = fixture(t, 'read')
  assert.deepEqual(store.bound(), { ok: false, code: 'root-absent' })
  assert.equal(fs.existsSync(root), false)
  const target = join(home, 'outside')
  fs.mkdirSync(target)
  fs.symlinkSync(target, root, 'junction')
  const writer = createSkillStore(home, { mode: 'write' })
  assert.deepEqual(writer.bound(), { ok: false, code: 'root-refused' })
  assert.throws(() => writer.publish('field-guide', [fake()]), key('store-failed', 'root-refused'))
  assert.deepEqual(fs.readdirSync(target), [])
})

test('skill-store: resolves only the trusted home and holds directory substitutions', t => {
  const { home, root, store } = fixture(t)
  const target = join(home, 'nested')
  fs.mkdirSync(target)
  fs.symlinkSync(target, join(home, 'linked'), 'junction')
  assert.equal(createSkillStore(join(home, 'linked'), { mode: 'write' }).bound().ok, true)
  const { hash, files } = publishFixture(store, 'field-guide', [fake()])
  const dir = join(root, 'field-guide')
  fs.renameSync(dir, join(root, 'detached'))
  fs.mkdirSync(dir)
  assert.throws(() => store.read('field-guide', hash, files), key('store-failed', 'identity-changed'))
  assert.throws(() => store.publish('field-guide', [fake()]), key('store-failed', 'identity-changed'))
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('skill-store: refuses linked name and generation directories, and linked metadata', t => {
  const { root, home, store } = fixture(t)
  const hash = skillHash([fake()])
  const files = fileEntries([fake()])
  const outside = join(home, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, join(root, 'field-guide'), 'junction')
  assert.throws(() => store.publish('field-guide', [fake()]), key('store-failed', 'identity-changed'))
  assert.throws(() => store.read('field-guide', hash, files), key('store-failed', 'identity-changed'))
  fs.unlinkSync(join(root, 'field-guide'))
  fs.mkdirSync(join(root, 'field-guide'))
  fs.symlinkSync(outside, join(root, 'field-guide', hash), 'junction')
  store.writeManifest('field-guide', hash, manifestOf(files))
  assert.throws(() => store.repair('field-guide', hash, [fake()]), key('store-failed', 'identity-changed'))
  assert.throws(() => store.remove('field-guide', [{ hash }]), key('store-failed', 'identity-changed'))
  const ledger = join(outside, 'ledger')
  fs.writeFileSync(ledger, '{"version":1,"names":{}}')
  fs.symlinkSync(ledger, join(root, '.ledger.json'))
  assert.throws(() => store.writeLedger({ version: 1, names: {} }), key('store-failed', 'ledger-unreadable'))
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{"version":1,"names":{}}')
})

test('skill-store: verifies the manifest before opening files and refuses lying sizes', t => {
  const { store } = fixture(t)
  const { files, hash } = publishFixture(store, 'field-guide', [fake(), fake('data.txt', 'a')])
  const open = t.mock.method(fs, 'openSync')
  assert.throws(() => store.read('../outside', hash, files), key('name-format'))
  assert.throws(() => store.read('field-guide', '../outside', files), key('hash-format'))
  assert.throws(() => store.unstage('../outside'), key('preview-expired'))
  assert.throws(() => store.read('field-guide', hash, Array.from({ length: 257 }, () => files[0])), key('too-many-files'))
  assert.equal(open.mock.callCount(), 0)
  const path = join(store.pathOf('field-guide', hash), 'data.txt')
  fs.chmodSync(path, 0o600)
  fs.writeFileSync(path, Buffer.alloc(2 * 1024 * 1024))
  const read = t.mock.method(fs, 'readSync')
  assert.throws(() => store.read('field-guide', hash, files), SkillFilesChanged)
  assert.ok(read.mock.calls.reduce((bytes, call) => bytes + call.result, 0) <= Buffer.byteLength(GOLDEN.bytes))
})

test('skill-store: removes only manifest-owned files and preserves unknown entries', t => {
  const { store } = fixture(t)
  const list = [fake(), fake('docs/ref.md', 'reference')]
  const { hash } = publishFixture(store, 'field-guide', list)
  const generation = store.pathOf('field-guide', hash)
  fs.chmodSync(generation, 0o755)
  fs.writeFileSync(join(generation, 'extra.md'), 'keep')
  const result = store.remove('field-guide', [{ hash }], { retire: true })
  assert.deepEqual(result, { removed: [], retired: false })
  assert.deepEqual(fs.readdirSync(generation), ['extra.md'])
})

test('skill-store: verifies the claimed staging hash and leaves unknown temporary folders', t => {
  const { root, store } = fixture(t)
  const hash = skillHash([fake()])
  const token = store.stage([fake()])
  assert.throws(() => store.staged(token, '0'.repeat(64)), SkillFilesChanged)
  assert.deepEqual(store.staged(token, hash)[0].bytes, fake().bytes)
  store.unstage(token, hash)
  assert.equal(fs.existsSync(join(root, '.staging', token)), false)
  fs.mkdirSync(join(root, '.tmp', token), { recursive: true, mode: 0o700 })
  fs.writeFileSync(join(root, '.tmp', token, 'unknown'), 'keep')
  store.sweepTemps(0)
  assert.equal(fs.readFileSync(join(root, '.tmp', token, 'unknown'), 'utf8'), 'keep')
})

test('skill-store: serializes versioned ledger metadata and validates before replacing it', t => {
  const { store } = fixture(t)
  const empty = { version: 1, names: {} }
  store.writeLedger(empty)
  assert.deepEqual(store.readLedger(), empty)
  assert.throws(() => store.writeLedger({ version: 2, names: {} }), key('store-failed', 'ledger-unreadable'))
  assert.deepEqual(store.readLedger(), empty)
})

test('skill-store: only the transaction calls the publication primitives and import excludes aliases', () => {
  const host = new URL('../src/host/', import.meta.url)
  const callsites = fs.readdirSync(host).filter(name => name.endsWith('.js'))
    .flatMap(name => [...fs.readFileSync(new URL(name, host), 'utf8').matchAll(/\bstor(?:e|age)\.(publish|repair)\(/g)]
      .map(match => [name, match[1]]))
  assert.deepEqual(callsites, [['skill-records.js', 'repair'], ['skill-records.js', 'publish']])
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /const key = portableKey\(name\)/)
  assert.match(source, /key !== 'skills'/)
  assert.match(source, /key !== '\.skills-import\.json'/)
  assert.equal(createHash('sha256').update(manifestOf(fileEntries([fake()]))).digest('hex'), GOLDEN.hash)
})
