import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SONNET_PIN, sonnetWire } from '../src/host/model-identity.js'

test('the built-in Sonnet affiliation requires the exact offered row and prefers the concrete wire value', () => {
  const alias = { value: 'sonnet', name: 'Sonnet 5.5' }
  const concrete = { value: SONNET_PIN, name: 'Sonnet 5.5' }
  assert.equal(sonnetWire([alias]), 'sonnet')
  assert.equal(sonnetWire([alias, concrete]), SONNET_PIN)
  assert.equal(sonnetWire([concrete]), SONNET_PIN)
  assert.equal(sonnetWire([{ value: 'sonnet', name: 'Sonnet' }]), undefined)
  assert.equal(sonnetWire([{ value: 'default', name: alias.name }]), undefined)
  assert.equal(sonnetWire([alias, { value: 'another', name: alias.name }]), undefined)
  assert.equal(sonnetWire([alias, { ...alias }]), undefined)
  assert.equal(sonnetWire([concrete, { ...concrete }]), undefined)
})
