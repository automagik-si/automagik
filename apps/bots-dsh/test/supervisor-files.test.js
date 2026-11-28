import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { activationIds } from '../src/host/state-format.js'
import { SUPERVISOR_FILES } from '../src/host/supervisor/copy.js'
import { IMAGE_HOST, runSupervisor } from '../src/host/supervisor/main.js'
import { HOST, MAIN } from './fixtures/supervisor.mjs'

test('the supervisor copy contains exactly the main import closure and its keys', () => {
  const seen = new Set()
  const pending = [MAIN]
  while (pending.length) {
    const file = pending.pop()
    const name = relative(HOST, file)
    if (seen.has(name)) continue
    seen.add(name)
    if (name.endsWith('.json')) {
      const content = JSON.parse(fs.readFileSync(file))
      if (name === 'supervisor/capabilities.json') assert.deepEqual(content, { version: 1, reinstall: true })
      else assert.ok(Array.isArray(name === 'supervisor/files.json' ? content : content.keys))
      continue
    }
    const content = fs.readFileSync(file, 'utf8')
    for (const [, dep] of content.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+|new URL\()['"]([^'"]+\.(?:js|json)|node:[^'"]+)['"]/gm)) {
      if (dep.startsWith('node:')) continue
      assert.ok(dep.startsWith('.'))
      pending.push(resolve(dirname(file), dep))
    }
    for (const [, dep] of content.matchAll(/(?:^import\b.*?from\s+|^import\s+|\bimport\(\s*)['"]([^'"]+)['"]/gm)) {
      assert.match(dep, /^(?:node:|\.{1,2}\/)/, `${name} imports ${dep}`)
    }
  }
  assert.deepEqual([...seen].sort(), [...SUPERVISOR_FILES].sort())
  assert.deepEqual(SUPERVISOR_FILES.filter(file => file.startsWith('supervisor/') && file.endsWith('.js')).sort(),
    fs.readdirSync(join(HOST, 'supervisor')).filter(file => file.endsWith('.js')).map(file => `supervisor/${file}`).sort())
})

test('the supervisor entrypoint in the inventory exposes the image host capability', () => {
  assert.ok(SUPERVISOR_FILES.includes('supervisor/main.js'))
  assert.equal(IMAGE_HOST, 1)
  assert.equal(typeof runSupervisor, 'function')
})

test('the shared activation parser bounds and canonically orders the copied wire lists', () => {
  const ids = Array.from({ length: 256 }, (_, i) => 'wire-' + i).reverse()
  assert.deepEqual(activationIds(ids, { required: true }), ids.toSorted())
  assert.deepEqual(activationIds([]), [])
  assert.deepEqual(activationIds(['a'.repeat(64)]), ['a'.repeat(64)])
  assert.equal(activationIds([], { required: true }), null)
  for (const invalid of [null, 'wire-id', {}, [...ids, 'extra'], [1], [''], ['a'.repeat(65)],
    ['invalid-é'], ['Uppercase'], ['bad--id'], ['trailing-'], ['a\n'], ['a', 'a']]) {
    assert.equal(activationIds(invalid), null)
  }
})
