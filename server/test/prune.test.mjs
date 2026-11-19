import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { PRUNE_EXTRA_FILE, pruneExtras, pruneUnusedPlatformPayloads } from '../assemble.mjs'

const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-prune-test-'))
  temps.push(dir)
  return dir
}
const write = (dir, path, content = 'x\n') => {
  mkdirSync(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, path), content)
}

test('test/spec files are recognized, ordinary names are not', () => {
  for (const name of ['string.test.ts', 'equal.test.js', 'common_test.py', 'foo.spec.js']) {
    assert.ok(PRUNE_EXTRA_FILE.test(name), name)
  }
  for (const name of ['testimony.js', 'latest.js', 'contest.js', 'index.js', 'install-spec.js']) {
    assert.ok(!PRUNE_EXTRA_FILE.test(name), name)
  }
})

test('third-party tests, examples, docs, .yarn and test files go; runtime files stay', () => {
  const modules = temp()
  write(modules, 'a/package.json', '{}\n')
  write(modules, 'a/dist/keep.js')
  write(modules, 'a/src/thing.test.ts')
  write(modules, 'a/test/x.js')
  write(modules, 'a/tests/y.js')
  write(modules, 'a/docs/z.md')
  write(modules, 'a/examples/e.js')
  write(modules, 'a/.yarn/plugin.cjs')
  write(modules, 'a/node_modules/b/dist/keep.js')
  write(modules, 'a/node_modules/b/test/b.js')
  const removed = pruneExtras(modules)
  assert.equal(removed.files, 7)
  for (const gone of ['a/src/thing.test.ts', 'a/test', 'a/tests', 'a/docs', 'a/examples', 'a/.yarn', 'a/node_modules/b/test']) {
    assert.ok(!existsSync(join(modules, gone)), gone)
  }
  for (const kept of ['a/package.json', 'a/dist/keep.js', 'a/node_modules/b/dist/keep.js']) {
    assert.ok(existsSync(join(modules, kept)), kept)
  }
})

test('the Emscripten sharp payload goes, the native build and the wasm loader stay', () => {
  const modules = temp()
  write(modules, 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.js')
  write(modules, 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm', 'wasm\n')
  write(modules, 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm.map', 'map\n')
  write(modules, 'node_modules/@img/sharp-linux-x64/sharp.node')
  const removed = pruneUnusedPlatformPayloads(modules)
  assert.deepEqual(removed.map((entry) => entry.file.split('/').pop()), ['sharp-wasm32-0.35.5.node.wasm'])
  assert.equal(removed[0].bytes, 5)
  assert.ok(!existsSync(join(modules, 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm')))
  for (const kept of [
    'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.js',
    'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm.map',
    'node_modules/@img/sharp-linux-x64/sharp.node',
  ]) assert.ok(existsSync(join(modules, kept)), kept)
})

test('a runtime without the sharp wasm fallback is left alone', () => {
  const modules = temp()
  write(modules, 'node_modules/@img/sharp-linux-x64/sharp.node')
  assert.deepEqual(pruneUnusedPlatformPayloads(modules), [])
})
