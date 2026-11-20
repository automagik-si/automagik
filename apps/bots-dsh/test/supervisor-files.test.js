import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { SUPERVISOR_FILES } from '../src/host/supervisor/copy.js'
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
      assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file)).keys))
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
  assert.deepEqual(SUPERVISOR_FILES.filter(file => file.startsWith('supervisor/')).sort(),
    fs.readdirSync(join(HOST, 'supervisor')).filter(file => file.endsWith('.js')).map(file => `supervisor/${file}`).sort())
})
