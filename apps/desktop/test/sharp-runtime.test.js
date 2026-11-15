import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { prepareSharpWasm, pruneNodeModules } from '../scripts/prune-runtime.mjs'
import { runSharpChild } from '../scripts/smoke-sharp.mjs'

const VERSION = '0.35.5'
const lock = JSON.parse(readFileSync(new URL('../runtime/package-lock.json', import.meta.url), 'utf8')).packages
const nativeNames = Object.keys(lock).filter(path => path.startsWith('node_modules/@img/sharp-') && path !== 'node_modules/@img/sharp-wasm32').map(path => path.slice('node_modules/'.length))
function write(root, path, value = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === 'object' ? JSON.stringify(value) : value)
}
function sharp(root, version = VERSION) {
  write(root, 'sharp/package.json', { name: 'sharp', version })
  write(root, 'sharp/dist/sharp.cjs', '// loader')
  write(root, 'sharp/src/build/Release/local.node', 'native')
  write(root, 'sharp/build/Release/legacy.node', 'native')
}
function wasm(root, version = VERSION) {
  write(root, '@img/sharp-wasm32/package.json', { name: '@img/sharp-wasm32', version,
    exports: { './package': './package.json', './sharp.node': './index.cjs' } })
  write(root, '@img/sharp-wasm32/index.cjs', '// binding')
  write(root, `@img/sharp-wasm32/lib/sharp-wasm32-${version}.node.js`, '// glue')
  write(root, `@img/sharp-wasm32/lib/sharp-wasm32-${version}.node.wasm`, 'wasm')
  write(root, '@img/sharp-wasm32/versions.json', '{}')
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-sharp-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const nm = join(root, 'node_modules')
  sharp(nm)
  wasm(nm)
  return { root, nm }
}

test('desktop requires unrestricted wasm at exactly every locked sharp version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../runtime/package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies['@img/sharp-wasm32'], VERSION)
  assert.equal(lock[''].dependencies['@img/sharp-wasm32'], VERSION)
  const sharps = Object.entries(lock).filter(([path]) => /(?:^|\/)node_modules\/sharp$/.test(path))
  assert.ok(sharps.length > 0)
  for (const [, entry] of sharps) assert.equal(entry.version, VERSION)
  const entry = lock['node_modules/@img/sharp-wasm32']
  assert.equal(entry.version, VERSION)
  for (const field of ['optional', 'dev', 'os', 'cpu', 'libc']) assert.equal(entry[field], undefined, field)
  assert.equal(lock['node_modules/@emnapi/runtime'].optional, undefined)
  assert.equal(lock['node_modules/tslib'].optional, undefined)
})

test('desktop removes every platform sharp/libvips package and local build recursively, preserving other addons', t => {
  const { nm } = fixture(t)
  const nested = join(nm, '@deepseek-ai/attachment/node_modules')
  sharp(nested)
  // This sharp resolves wasm from the runtime root.
  for (const base of [nm, nested]) {
    for (const name of [...nativeNames, '@img/sharp-future-platform']) write(base, `${name}/lib/native.node`, name)
    write(base, 'other-addon/build/Release/addon.node', 'other native addon')
    write(base, 'other-addon/src/build/Release/addon.node', 'other local build')
  }
  const kept = ['@img/sharp-wasm32/index.cjs', '@img/sharp-wasm32/versions.json',
    `@img/sharp-wasm32/lib/sharp-wasm32-${VERSION}.node.js`, `@img/sharp-wasm32/lib/sharp-wasm32-${VERSION}.node.wasm`,
    'sharp/dist/sharp.cjs', '@emnapi/runtime/index.js', 'tslib/tslib.js', '@img/colour/index.js']
  for (const path of kept.slice(5)) write(nm, path, 'keep')
  const before = kept.map(path => readFileSync(join(nm, path)))
  assert.deepEqual(prepareSharpWasm(nm), { sharp: 2 })
  for (const base of [nm, nested]) {
    for (const name of [...nativeNames, '@img/sharp-future-platform', 'sharp/build', 'sharp/src/build']) {
      assert.equal(existsSync(join(base, name)), false, name)
    }
    assert.equal(readFileSync(join(base, 'other-addon/build/Release/addon.node'), 'utf8'), 'other native addon')
    assert.equal(readFileSync(join(base, 'other-addon/src/build/Release/addon.node'), 'utf8'), 'other local build')
  }
  kept.forEach((path, index) => assert.deepEqual(readFileSync(join(nm, path)), before[index], path))
  assert.deepEqual(prepareSharpWasm(nm), { sharp: 2 }, 'idempotent')
})

test('nested wasm must match the sharp that resolves it before anything is removed', t => {
  const { nm } = fixture(t)
  const nested = join(nm, 'consumer/node_modules')
  sharp(nested)
  wasm(nested, '0.35.4')
  write(nm, '@img/sharp-linux-x64/lib/native.node', 'native')
  assert.throws(() => prepareSharpWasm(nm), /version mismatch/)
  assert.equal(existsSync(join(nm, '@img/sharp-linux-x64/lib/native.node')), true)
  assert.equal(existsSync(join(nm, 'sharp/src/build/Release/local.node')), true)
})

for (const path of ['sharp', '@img/sharp-wasm32', '@img/sharp-wasm32/index.cjs',
  `@img/sharp-wasm32/lib/sharp-wasm32-${VERSION}.node.js`, `@img/sharp-wasm32/lib/sharp-wasm32-${VERSION}.node.wasm`]) {
  test(`preparation rejects missing ${path}`, t => {
    const { nm } = fixture(t)
    rmSync(join(nm, path), { recursive: true })
    assert.throws(() => prepareSharpWasm(nm))
  })
}
for (const path of ['sharp/package.json', '@img/sharp-wasm32/package.json']) {
  test(`preparation rejects unreadable ${path}`, t => {
    const { nm } = fixture(t)
    write(nm, path, '{broken')
    assert.throws(() => prepareSharpWasm(nm))
  })
}

test('preparation never traverses external directory links or native package links', t => {
  const { root, nm } = fixture(t)
  const outside = join(root, 'outside')
  write(outside, 'node_modules/@img/sharp-linux-x64/keep.node', 'outside')
  write(outside, 'keep.node', 'outside')
  symlinkSync(outside, join(nm, 'unrelated-link'), 'junction')
  symlinkSync(outside, join(nm, '@img/sharp-linux-x64'), 'junction')
  symlinkSync(outside, join(nm, 'sharp/build/link'), 'junction')
  prepareSharpWasm(nm)
  assert.equal(lstatSync(join(nm, 'unrelated-link')).isSymbolicLink(), true)
  assert.equal(existsSync(join(nm, '@img/sharp-linux-x64')), false)
  assert.equal(readFileSync(join(outside, 'keep.node'), 'utf8'), 'outside')
  assert.equal(readFileSync(join(outside, 'node_modules/@img/sharp-linux-x64/keep.node'), 'utf8'), 'outside')
})

for (const path of ['sharp', 'sharp/src', '@img', '@img/sharp-wasm32', 'consumer/node_modules']) {
  test(`preparation refuses a linked ${path} without touching its target`, t => {
    const { root, nm } = fixture(t)
    const outside = join(root, 'outside')
    sharp(outside)
    wasm(outside)
    write(outside, 'build/keep.node', 'outside')
    rmSync(join(nm, path), { recursive: true, force: true })
    mkdirSync(dirname(join(nm, path)), { recursive: true })
    symlinkSync(path === '@img/sharp-wasm32' ? join(outside, '@img/sharp-wasm32') : outside, join(nm, path), 'junction')
    assert.throws(() => prepareSharpWasm(nm), /linked|outside runtime/)
    assert.equal(readFileSync(join(outside, 'build/keep.node'), 'utf8'), 'outside')
  })
}

test('generic server pruning retains native sharp selection and local builds', t => {
  const { nm } = fixture(t)
  write(nm, '@img/sharp-linux-x64/lib/native.node', 'native')
  pruneNodeModules(nm)
  assert.equal(existsSync(join(nm, '@img/sharp-linux-x64/lib/native.node')), true)
  assert.equal(existsSync(join(nm, 'sharp/src/build/Release/local.node')), true)
  assert.equal(existsSync(join(nm, 'sharp/build/Release/legacy.node')), true)
})

test('hidden nested dependency stores are prepared while package data named @img stays', t => {
  const { nm } = fixture(t)
  const nested = join(nm, '.store/entry/node_modules')
  sharp(nested)
  wasm(nested)
  write(nested, '@img/sharp-linux-x64/lib/native.node', 'native')
  write(nm, 'other-addon/assets/@img/sharp-example/data', 'package data')
  assert.deepEqual(prepareSharpWasm(nm), { sharp: 2 })
  assert.equal(existsSync(join(nested, '@img/sharp-linux-x64')), false)
  assert.equal(existsSync(join(nested, 'sharp/src/build')), false)
  assert.equal(readFileSync(join(nm, 'other-addon/assets/@img/sharp-example/data'), 'utf8'), 'package data')
})

test('smoke supervisor requires success plus natural exit', async () => {
  await runSharpChild(process.execPath, ['-e', 'console.log("sharp Electron wasm smoke passed")'])
  await assert.rejects(runSharpChild(process.execPath, ['-e', '']), /before completing/)
  await assert.rejects(runSharpChild(process.execPath, ['-e', 'process.exitCode = 7']), /code=7/)
  await assert.rejects(runSharpChild(process.execPath, ['-e', 'console.log("sharp Electron wasm smoke passed"); setInterval(() => {}, 1000)'], { timeout: 200 }), /timed out/)
  await assert.rejects(runSharpChild(join(tmpdir(), 'automagik-nonexistent-electron'), []), /ENOENT/)
})

test('smoke supervisor rejects a signalled child', { skip: process.platform === 'win32' && 'Windows does not report POSIX termination signals' }, async () => {
  await assert.rejects(runSharpChild(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']), /signal=SIGTERM/)
})
