import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentOf } from '../src/host/supervisor/records.js'
import { PLUGINS } from '../src/host/supervisor/release.js'

const pin = `file:vendor/automagik-update/${'a'.repeat(64)}.tgz`
const [acp, bots] = PLUGINS
const record = { version: 1, live: { version: '3.161.2', sequence: 42 }, kept: { version: '3.161.1' }, lastSequence: 42 }

test('current records retain valid pins and base specs and accept the old format', () => {
  const entries = Object.fromEntries(PLUGINS.map(name => [name, pin]))
  const base = Object.fromEntries(PLUGINS.map(name => [name, '^3.161.1']))
  assert.deepEqual(currentOf(record, []), record)
  assert.deepEqual(currentOf({ ...record, entries: null, base: null }, []), record)
  assert.deepEqual(currentOf({ ...record, entries, base }, []), { ...record, entries, base })
})

test('an invalid pin or base invalidates the whole current record', () => {
  const entries = { [bots]: pin }, base = { [bots]: 'image-pin' }
  for (const shape of [
    { entries }, { base }, { entries: {}, base: {} }, { entries: [], base: [] },
    { entries: { [bots]: pin }, base: { [acp]: 'image-pin' } },
    { entries: { [bots]: pin }, base: { [bots]: 'image-pin', [acp]: 'image-pin' } },
    { entries: { '@automagik/multiuser-dsh': pin }, base: { '@automagik/multiuser-dsh': 'image-pin' } },
    { entries: { [bots]: pin.toUpperCase() }, base }, { entries: { [bots]: [pin] }, base },
    { entries: { [bots]: 'file:../../elsewhere.tgz' }, base },
    { entries, base: { [bots]: '' } }, { entries, base: { [bots]: 'x'.repeat(513) } },
    { entries, base: { [bots]: 1 } },
  ]) assert.equal(currentOf({ ...record, ...shape }, []), null, JSON.stringify(shape))
})
