// The installed schedule adapter against DSH's ScheduleService and an in-memory domain.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { install } from '../src/host/schedules.js'
import { ScheduleAdmissionRefusal } from '../src/host/pocket-socket.js'
import { fakeContext } from './fake-ctx.js'

const BOT = 'b-aaaaaaaaaa'
const SESSION = 'fixture-session'
const TARGET = { kind: 'session', sessionId: SESSION }

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
      }
    },
  }
}

async function setup(t, stat = async () => ({ header: {} })) {
  const dsh = new Context()
  dsh.provide('storageDomain', { open: async () => memoryDomain() })
  dsh.provide('logger', { warn() {}, info() {}, error() {}, debug() {} })
  dsh.provide('agents', { get: () => undefined })
  dsh.provide('sessionPersistence', { stat })
  const service = new ScheduleService(dsh, {})
  await service.ready
  const controller = { follow() {}, events() {}, state() {}, observeState() {}, prompt() {}, cancel() {} }
  const ctx = fakeContext({ services: { schedule: service, sessionController: controller } })
  t.after(() => ctx.dispose())
  const rt = {
    ctx, home: '/fixture', warn: message => assert.fail(message), load: async () => {}, readOnly: () => undefined,
    chatOwners: new Map([[SESSION, BOT]]), groupOwners: new Map(), pastOwners: new Map(), roomOf: () => undefined,
  }
  const edit = service.edit.bind(service)
  const edits = []
  t.mock.method(service, 'edit', (request, actor, signal) => {
    const result = edit(request, actor, signal)
    edits.push({ request, actor, signal, result })
    return result
  })
  install(rt)
  const [probe] = edits
  assert.match(probe.request.id, /^schedule-probe-/)
  assert.equal(probe.signal.aborted, true)
  await assert.rejects(probe.result, error => error === probe.signal.reason)
  assert.equal(rt.pocketSchedules.writable(), true)
  const call = (method, fields) => rt.pocketSchedules[method]({
    botId: BOT, allowed: available => available === false ? 'unavailable' : undefined, refresh: async () => {},
    overhead: 0, controller: new AbortController(), ...fields,
  })
  const create = () => service.create({
    title: 'Fixture task', prompt: 'Fixture instruction', target: TARGET,
    timing: { kind: 'after', after_seconds: 3600 },
  })
  return { service, edits, call, create }
}

test('the native pre-aborted probe leaves the catalog empty, and a stale expectedUpdatedAt is a conflict', async (t) => {
  const { service, create } = await setup(t)
  assert.deepEqual(await service.catalog(), [])
  const first = await create()
  const renamed = await service.edit({ id: first.id, action: 'update', patch: { title: 'Desktop title' } })
  assert.ok(renamed.updatedAt > first.updatedAt)
  const result = await service.edit({ id: first.id, action: 'update', patch: { active: false }, expectedUpdatedAt: first.updatedAt }, undefined, new AbortController().signal)
  assert.deepEqual(result, { id: first.id, code: 'schedule_conflict' })
  assert.deepEqual(await service.catalog(), [renamed])
})

test('native resume rechecks admission after target validation and leaves the row unchanged on refusal', async (t) => {
  const entered = Promise.withResolvers()
  const hold = Promise.withResolvers()
  t.after(hold.resolve)
  let checking = false
  const { service, edits, call, create } = await setup(t, async () => {
    if (checking) { entered.resolve(); await hold.promise }
    return { header: {} }
  })
  const first = await create()
  const paused = await service.edit({ id: first.id, action: 'update', patch: { active: false } })
  const { task } = await call('list', { id: first.id })
  const controller = new AbortController()
  let picked = true
  checking = true
  const pending = call('resume', {
    id: task.id, rev: task.rev, controller, allowed: () => picked ? undefined : 'not-shown',
  })
  await entered.promise
  picked = false
  hold.resolve()
  assert.deepEqual(await pending, { ok: false, state: 'refused', reason: 'not-shown' })
  const { signal, result } = edits.at(-1)
  assert.ok(Object.hasOwn(signal, 'throwIfAborted'))
  assert.ok(signal.reason instanceof ScheduleAdmissionRefusal)
  await assert.rejects(result, error => error === signal.reason)
  assert.deepEqual(await service.catalog(), [paused])
})

test('native pause retains the stored instant and resume projects the committed at task', async (t) => {
  const { service, call, create } = await setup(t)
  const created = await create()
  const { task: before } = await call('list', { id: created.id })
  assert.deepEqual(before.timing, { kind: 'after', at: created.scheduledAt, afterSeconds: 3600 })
  const paused = await call('pause', { id: before.id, rev: before.rev })
  assert.equal(paused.state, 'saved')
  assert.equal(paused.task.state, 'paused')
  assert.equal(paused.task.timing.at, before.timing.at)
  const resumed = await call('resume', { id: before.id, rev: paused.task.rev })
  assert.equal(resumed.state, 'saved')
  assert.equal(resumed.task.state, 'scheduled')
  assert.notEqual(resumed.task.rev, paused.task.rev)
  const [current] = await service.catalog()
  assert.deepEqual(resumed.task.timing, { kind: 'at', at: current.scheduledAt })
  assert.equal(current.kind, 'at')
})
