import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentOf, runOf } from '../src/host/supervisor/records.js'
import { PLUGINS } from '../src/host/supervisor/release.js'
import { runOf as runOf5b } from './fixtures/supervisor-5b/supervisor/records.js'
import { runOf as runOf6 } from './fixtures/supervisor-6/supervisor/records.js'

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

test('frozen v1 readers accept rollback keep, restore and blocked records', () => {
  const now = '2026-11-28T09:00:00.000Z'
  for (const [phase, data] of [
    ['rolledBack', { restored: false, why: 'same-format', trialKept: false }],
    ['rolledBack', { restored: true, trialKept: true }],
    ...['unknown', 'team-in-use', 'snapshot-changed', 'superseded'].map(why =>
      ['manualRecovery', { restored: false, why, trialKept: false }]),
  ]) {
    const saved = { version: 1, runId: 'fixture-run', bootId: 'sup_fixture', phase,
      from: record.kept.version, to: record.live.version, reason: phase === 'manualRecovery' ? 'rollback-failed' : 'health-failed',
      startedAt: now, updatedAt: now, rollback: { failed: 'page', step: 'data', trialFrom: now, data } }
    const current = runOf(saved, [saved.bootId])
    assert.equal(current.phase, phase)
    assert.equal(runOf5b(saved, [saved.bootId]).phase, phase)
    assert.deepEqual(runOf6(saved, [saved.bootId]), current)
  }
})
