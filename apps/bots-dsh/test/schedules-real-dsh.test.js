// The shapes the Bot team's schedule adapter sends, checked against DSH 0.2.2's own
// ScheduleService from the pinned harness, over an in-memory storage domain. The service is
// real: it validates the typed timing, resolves the session target, and owns catalog/edit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { textOf } from '../src/host/text.js'
import * as turns from '../src/host/turns.js'

// The storage-domain face ScheduleService opens: table(name) with entries/get/put/deleteMany.
function memoryDomain() {
  const tables = new Map()
  return {
    close: async () => {},
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map())
      const rows = tables.get(name)
      return {
        entries: () => [...rows.entries()],
        get: id => rows.get(id),
        put: async (id, value) => { rows.set(id, value) },
        delete: async (id) => rows.delete(id),
        deleteMany: async (ids) => {
          let removed = 0
          for (const id of ids) if (rows.delete(id)) removed++
          return removed
        },
      }
    },
  }
}

async function service(agents = { get: () => undefined }) {
  const ctx = new Context()
  ctx.provide('storageDomain', { open: async () => memoryDomain() })
  ctx.provide('logger', { warn() {}, info() {}, error() {}, debug() {} })
  ctx.provide('agents', agents)
  ctx.provide('sessionPersistence', { stat: async () => ({ header: {} }) })
  const schedule = new ScheduleService(ctx, {})
  await schedule.ready
  return schedule
}

test('DSH 0.2.2 takes the adapter\'s typed timing and session target, lists, catalogs and deletes', async () => {
  const schedule = await service()
  const created = await schedule.create({
    title: 'Briefing',
    prompt: 'Sum up the day',
    timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } },
    target: { kind: 'session', sessionId: 's1' },
  })
  assert.equal(created.kind, 'daily')
  assert.equal(created.status, 'active')
  assert.deepEqual(created.target, { kind: 'session', sessionId: 's1' })
  assert.equal(created.time, '09:00:00.000')
  assert.equal(created.timeZone, 'UTC')

  const listed = await schedule.list({})
  assert.equal(listed.total, 1)
  assert.equal(listed.items[0].id, created.id)

  const [catalogued] = await schedule.catalog()
  assert.equal(catalogued.id, created.id)
  assert.deepEqual(catalogued.target, { kind: 'session', sessionId: 's1' })
  assert.equal(catalogued.status, 'active')

  // DSH 0.2.2's own schedule tool creates rrule tasks; the adapter's move must rebuild one.
  const recurring = await schedule.create({
    title: 'Bot task',
    prompt: 'Check the build',
    timing: { kind: 'rrule', rrule: 'DTSTART:20300101T090000Z\nRRULE:FREQ=DAILY' },
    target: { kind: 'session', sessionId: 's1' },
  })
  assert.equal(recurring.kind, 'rrule')
  assert.match(recurring.rrule, /RRULE:FREQ=DAILY/)

  await schedule.edit({ id: created.id, action: 'delete' })
  const left = await schedule.catalog()
  assert.deepEqual(left.map(entry => [entry.id, entry.kind]), [[recurring.id, 'rrule']])
  await schedule.edit({ id: recurring.id, action: 'delete' })
  assert.deepEqual(await schedule.catalog(), [])
})

test('the old session-scoped create shape is refused by DSH 0.2.2', async () => {
  const schedule = await service()
  await assert.rejects(schedule.create('s1', {
    title: 'Old part',
    prompt: 'x',
    every_seconds: 3600,
  }), error => error?.name === 'ScheduleInputError')
})

test("DSH's real schedule-change notice does not open a turn", async () => {
  const seen = []
  const schedule = await service({
    get: id => id === 's1' ? { status: 'running', options: {}, session: { header: {} }, inject: m => seen.push(m) } : undefined,
  })
  const created = await schedule.create({
    title: 'x', prompt: 'p',
    timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } },
    target: { kind: 'session', sessionId: 's1' },
  }, 's1')
  await schedule.notifications
  assert.equal(seen.length, 0)
  const edited = await schedule.edit({ id: created.id, action: 'update', patch: { title: 'y' } }, undefined)
  assert.equal(edited.code, undefined)
  await schedule.notifications
  assert.equal(seen.length, 1)
  assert.equal(seen[0].source.kind, 'schedule')
  assert.equal(textOf(seen[0].content).split('\n')[3], 'change: updated')
  assert.equal(turns.opensTurn(seen[0]), false)
})
