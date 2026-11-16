import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const shapes = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'hc-shapes.json'), 'utf8'))

test('the recorded hc/am shapes are the documented object forms', () => {
  assert.equal(shapes.imageHcVersion, 'hc 0.1.18')
  assert.equal(shapes.imageAmVersion, '3.149.2')
  assert.ok(shapes.ls && typeof shapes.ls === 'object' && !Array.isArray(shapes.ls))
  assert.ok(Array.isArray(shapes.ls.terminals))
  assert.equal(shapes.ls.terminals.length, 0)
  assert.ok(Array.isArray(shapes.ls.machines))
  assert.equal(typeof shapes.ls.hidden_finished, 'number')
  assert.ok(shapes.serverStatus && typeof shapes.serverStatus === 'object' && !Array.isArray(shapes.serverStatus))
  assert.equal(typeof shapes.serverStatus.core, 'object')
  assert.equal(typeof shapes.serverStatus.live, 'number')
  assert.equal(typeof shapes.serverStatus.holder, 'object')
  assert.ok(Array.isArray(shapes.serverStatus.holders))
  assert.equal(shapes.serverStatus.version, '0.1.18')
  assert.ok(shapes.amLs && typeof shapes.amLs === 'object' && !Array.isArray(shapes.amLs))
  assert.ok(Array.isArray(shapes.amLs.projects))
  assert.ok(Array.isArray(shapes.amLs.projects[0].bots))
  assert.equal(shapes.amLs.projects[0].bots.length, 3)
  assert.ok(shapes.amStart && typeof shapes.amStart === 'object' && !Array.isArray(shapes.amStart))
  assert.equal(typeof shapes.amStart.terminal, 'string')
})
