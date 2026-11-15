// src/host/browser/script-child.js is generated and committed (scripts/build-script-child.mjs).
// It holds the interpreter a browser_exec script runs in, so two things are checked here:
// the committed file is what the sources and the pinned interpreter build to, and the
// interpreter's files are the pinned ones, byte for byte.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bundleScriptChild, pinDifferences, readPins } from '../scripts/build-script-child.mjs'

const PLUGIN = resolve(import.meta.dirname, '..')
const INTERPRETER = ['@jitl/quickjs-singlefile-mjs-release-sync', 'quickjs-emscripten-core']

test('the committed script-child.js is a fresh build of its sources and the pinned interpreter', async () => {
  const { text, pins } = await bundleScriptChild()
  assert.deepEqual(pinDifferences(readPins(), pins), [])
  assert.equal(readFileSync(join(PLUGIN, 'src', 'host', 'browser', 'script-child.js'), 'utf8'), text, 'run `npm run build` in apps/bots-dsh and commit the result')
  // One file: under the permission model the process may read its entry and nothing else.
  assert.doesNotMatch(text, /^\s*import\s[^;]*from\s*["'](?!node:)/m)
})

test('the interpreter is pinned by exact version and by the sha256 of every file that is built in', () => {
  const pins = readPins()
  const { devDependencies } = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  const lock = readFileSync(join(PLUGIN, 'bun.lock'), 'utf8')
  for (const name of INTERPRETER) {
    assert.match(devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} is not an exact version`)
    assert.equal(pins[name].version, devDependencies[name])
    // The lock carries the package's own hash for that version.
    assert.match(lock, new RegExp(`"${name}@${devDependencies[name].replaceAll('.', '\\.')}", "", [^\\n]*"sha512-[A-Za-z0-9+/=]{80,}"`))
  }
  for (const [name, { files }] of Object.entries(pins)) {
    assert.ok(Object.keys(files).length > 0, name)
    for (const [file, pinned] of Object.entries(files)) {
      assert.match(pinned, /^[0-9a-f]{64}$/)
      assert.equal(createHash('sha256').update(readFileSync(join(PLUGIN, 'node_modules', name, file))).digest('hex'), pinned, `${name}/${file}`)
    }
  }
  // The WebAssembly module itself is inside one of the pinned files, as text that opens
  // with the format's four bytes: no .wasm file is read or fetched when the child starts.
  const [engine] = Object.keys(pins['@jitl/quickjs-singlefile-mjs-release-sync'].files).filter(file => file.includes('emscripten-module'))
  assert.match(readFileSync(join(PLUGIN, 'node_modules', '@jitl/quickjs-singlefile-mjs-release-sync', engine), 'utf8'), /\\0asm/)
})

test('a build that took a file that is not the pinned one is told apart', () => {
  const pinned = { engine: { version: '1.0.0', files: { 'dist/a.mjs': 'a'.repeat(64), 'dist/b.mjs': 'b'.repeat(64) } } }
  const same = structuredClone(pinned)
  assert.deepEqual(pinDifferences(pinned, same), [])
  const changed = structuredClone(pinned)
  changed.engine.files['dist/a.mjs'] = 'c'.repeat(64)
  assert.deepEqual(pinDifferences(pinned, changed), [`engine/dist/a.mjs: ${'c'.repeat(64)}, pinned ${'a'.repeat(64)}`])
  const version = structuredClone(pinned)
  version.engine.version = '1.0.1'
  assert.deepEqual(pinDifferences(pinned, version), ['engine: version 1.0.1, pinned 1.0.0'])
  const added = structuredClone(pinned)
  added.engine.files['dist/c.mjs'] = 'd'.repeat(64)
  assert.deepEqual(pinDifferences(pinned, added), [`engine/dist/c.mjs: ${'d'.repeat(64)}, pinned nothing`])
  assert.deepEqual(pinDifferences(pinned, { ...pinned, other: { version: '2.0.0', files: {} } }), ['other: in the build but not pinned'])
  assert.deepEqual(pinDifferences(pinned, {}), ['engine: pinned but not in the build'])
})
