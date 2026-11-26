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

test('each new Claude Code pin requires its exact unique alias or a concrete row', async () => {
  const { pinOf, pinWire } = await import('../src/host/model-identity.js')
  for (const [value, name, id] of [
    ['opus', 'Opus 5.5', 'claude-opus-5-5'],
    ['fable', 'Fable 5.2', 'claude-fable-5-2'],
    ['haiku', 'Haiku 5.5', 'claude-haiku-5-5'],
  ]) {
    const pin = pinOf(value)
    const alias = { value, name }
    const concrete = { value: id, name }
    assert.equal(pinOf(id), pin)
    assert.equal(pinWire([alias], pin), value)
    assert.equal(pinWire([{ value, name: 'Different label' }], pin), undefined)
    assert.equal(pinWire([alias, { value: 'another', name }], pin), undefined)
    assert.equal(pinWire([alias, { ...alias }], pin), undefined)
    assert.equal(pinWire([concrete, { ...concrete }], pin), undefined)
    assert.equal(pinWire([alias, concrete], pin), id)
  }
  assert.equal(pinOf('default'), undefined)
})
