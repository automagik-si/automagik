import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { PRUNE_EXTRA_FILE, pruneExtras, pruneRuntime } from '../assemble.mjs'

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

test('server runtime pruning keeps the sharp wasm fallback and its dependencies', () => {
  const lock = JSON.parse(readFileSync(new URL('../../apps/desktop/runtime/package-lock.json', import.meta.url), 'utf8'))
  const version = lock.packages['node_modules/@img/sharp-wasm32'].version
  const fallback = '@img/sharp-wasm32'
  const binding = `${fallback}/lib/sharp-wasm32-${version}.node`
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  const modules = temp()
  const kept = [
    [`${fallback}/package.json`, '{}\n'],
    [`${fallback}/index.cjs`],
    [`${fallback}/versions.json`, '{}\n'],
    [`${binding}.js`],
    [`${binding}.wasm`, wasm],
    ['sharp/package.json', '{}\n'],
    ['@emnapi/runtime/package.json', '{}\n'],
    ['tslib/package.json', '{}\n'],
  ]
  for (const [path, content] of kept) write(modules, path, content)
  write(modules, '@img/sharp-linuxmusl-x64/lib/x.node')
  write(modules, 'neutral/x.js.map')
  write(modules, 'neutral/test/x.js')

  pruneRuntime(modules)

  for (const [path] of kept) assert.ok(existsSync(join(modules, path)), path)
  assert.deepEqual(readFileSync(join(modules, `${binding}.wasm`)), wasm)
  for (const path of ['@img/sharp-linuxmusl-x64', 'neutral/x.js.map', 'neutral/test']) {
    assert.ok(!existsSync(join(modules, path)), path)
  }
})
