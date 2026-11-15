import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { applyAllowlist, LABELS, loadAllowlist, scanTree, sha256Bytes } from '../secrecy.mjs'

const FILE = 'opt/automagik/runtime/node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.js'
const MATCH = ['', 'home', 'web_user'].join('/')
// Verified against the public tarball's locked SHA-512, then the installed file byte for byte.
const FILE_SHA256 = '1904293fc3f6b0d2abfec1fce156e43f2c309ee13f79498d4efdf0a931b52e5f'
const INTEGRITY = 'sha512-Ptsga1su4tQx+LLF1ECS9U6nz5kmrXKo6XVbtR48Ke3ZRxxgaWBu7IDtEe1quo8hiupwm6WFqxVlXaSf7IINGQ=='
const reviewedHit = () => ({ file: FILE, line: 1, rule: 'home-path', raw: MATCH, match: LABELS['home-path'], fileSha256: FILE_SHA256 })
const entry = () => {
  const entries = loadAllowlist().filter(item => item.file.includes('@img/sharp-wasm32/'))
  assert.equal(entries.length, 1, 'one exact vendor exception, with no sibling-file exceptions')
  return entries[0]
}
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-secrecy-sharp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('Sharp exception pins the reviewed match, file and locked release', () => {
  const allowed = entry()
  assert.deepEqual(Object.keys(allowed).sort(), ['file', 'fileSha256', 'match', 'reason', 'rule'])
  assert.equal(allowed.file, FILE)
  assert.equal(allowed.rule, 'home-path')
  assert.equal(allowed.match, MATCH)
  assert.equal(allowed.fileSha256, FILE_SHA256)
  assert.match(allowed.reason, /Emscripten/)
  assert.match(allowed.reason, /not a host account/)
  const lock = JSON.parse(readFileSync(new URL('../../apps/desktop/runtime/package-lock.json', import.meta.url)))
  const pkg = lock.packages['node_modules/@img/sharp-wasm32']
  assert.equal(pkg.version, '0.35.5')
  assert.equal(pkg.resolved, 'https://registry.npmjs.org/@img/sharp-wasm32/-/sharp-wasm32-0.35.5.tgz')
  assert.equal(pkg.integrity, INTEGRITY)
})

test('both reviewed Sharp findings pass, but changing any matching dimension fails closed', () => {
  const allowed = entry()
  const hits = [reviewedHit(), reviewedHit()]
  const result = applyAllowlist(hits, loadAllowlist())
  assert.deepEqual(result.kept, [])
  assert.deepEqual(result.allowed, [{ file: FILE, rule: 'home-path', reason: allowed.reason, count: 2 }])
  assert.equal(applyAllowlist(hits, loadAllowlist().filter(item => item.file !== FILE)).kept.length, 2)
  for (const change of [
    { fileSha256: '0'.repeat(64) },
    { fileSha256: undefined },
    { file: FILE.replace('0.35.5', '0.35.6') },
    { file: FILE.replace('/runtime/', '/profile/') },
    { file: `${FILE}.other` },
    // Keep the public display label unchanged: only the exact raw match counts.
    { raw: ['', 'home', 'other_user'].join('/') },
    { raw: `${MATCH}_other` },
    { raw: undefined },
    { rule: 'private-name' },
    { rule: 'key' },
  ]) {
    const hit = { ...reviewedHit(), ...change }
    assert.deepEqual(applyAllowlist([hit], loadAllowlist()).kept, [hit])
  }
})

test('the scanner computes the whole-file digest and rejects replacement bytes at the exact Sharp path', (t) => {
  const dir = temp(t)
  mkdirSync(dirname(join(dir, FILE)), { recursive: true })
  const bytes = Buffer.from(`FS.mkdir("${MATCH}");\nconst env = { HOME: "${MATCH}" };\n`)
  assert.notEqual(sha256Bytes(bytes), FILE_SHA256)
  writeFileSync(join(dir, FILE), bytes)
  const result = scanTree(dir)
  assert.equal(result.allowed.length, 0)
  assert.deepEqual(result.hits.map(hit => [hit.file, hit.line, hit.rule, hit.raw, hit.fileSha256]), [
    [FILE, 1, 'home-path', MATCH, sha256Bytes(bytes)],
    [FILE, 2, 'home-path', MATCH, sha256Bytes(bytes)],
  ])
})

test('Sharp cannot authorize own-code paths, keys or other prohibited exceptions', (t) => {
  const config = join(temp(t), 'allowlist.json')
  const allowed = entry()
  const forbidden = [
    ...['key', 'private-key', 'data-state', 'launch-url', 'dotenv', 'env-secret', 'archive', 'unreadable', 'stripe-sdk', 'gateway-credential', 'billing-config'].map(rule => ({ ...allowed, rule })),
    ...[
      'opt/automagik/profile/node_modules/@automagik/bots-dsh/src/host/browser/script-child.js',
      'opt/automagik/entrypoint.mjs',
      'opt/automagik/versions.json',
      'opt/automagik/profile/package.json',
      'data/dsh/state.json',
      'etc/example.conf',
    ].map(file => ({ ...allowed, file })),
  ]
  for (const candidate of forbidden) {
    writeFileSync(config, JSON.stringify([candidate]))
    assert.throws(() => loadAllowlist(config), /may not be allowlisted here/)
    const hit = { ...reviewedHit(), file: candidate.file, rule: candidate.rule }
    assert.deepEqual(applyAllowlist([hit], [candidate]).kept, [hit])
  }
})
