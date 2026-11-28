import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/extend.js'

test('role hooks validate definitions, keep ordered immutable registrations and dispose by identity', () => {
  const rt = { state: { prefs: {} } }
  install(rt)
  const role = { id: 'second', name: 'Second', tools: ['work'], order: 2 }
  const dispose = rt.hooks.role(role)
  role.tools.push('unexpected')
  const removeFirst = rt.hooks.role({ id: 'first', name: 'First', order: 1 })
  assert.deepEqual(rt.roleRegistry.all().map(item => item.id), ['first', 'second'])
  assert.deepEqual(rt.roleRegistry.of('second').tools, ['work'])
  assert.throws(() => rt.hooks.role(role), /duplicate/)
  assert.throws(() => rt.hooks.role({ id: 'broken', name: 'Broken', tools: ['x', 'x'] }), /Invalid/)
  dispose()
  const replacement = rt.hooks.role(role)
  dispose()
  assert.equal(rt.roleRegistry.of(role.id).version, '1.0.0')
  replacement()
  removeFirst()
  assert.deepEqual(rt.roleRegistry.all(), [])
})
