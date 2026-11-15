import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { reminderText } from '../src/host/schedules.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Omni', role: 'Channel orchestrator', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: { g1: { id: 'g1', name: 'Launch', named: true, members: ['m1', 'w1'], admin: 'm1', mode: 'admin', notice: '', createdAt: 4 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// An in-memory stand-in for DSH 0.2.2's schedule service: typed timing, target-based
// create, and edit({ action: 'delete' }) — the API apps/bots-dsh/src/host/schedules.js uses.
function scheduleService() {
  const tasks = new Map()
  let next = 1
  return {
    tasks,
    async create(request, actorSessionId) {
      const id = `schedule-${next++}`
      const timing = request.timing
      const entry = {
        id,
        kind: timing.kind,
        title: request.title,
        prompt: request.prompt,
        scheduledAt: timing.kind === 'at' ? timing.at : '2030-01-01T01:00:00.000Z',
        everySeconds: timing.every_seconds,
        time: timing.daily?.time ?? timing.weekly?.time,
        timeZone: timing.daily?.time_zone ?? timing.weekly?.time_zone ?? timing.cron?.time_zone,
        weekdays: timing.weekly?.weekdays,
        expression: timing.cron?.expression,
        rrule: timing.rrule,
        request,
        target: request.target,
        // DSH records the acting Session and the named target as involved.
        involvedSessionIds: [...new Set([
          ...(actorSessionId === undefined ? [] : [actorSessionId]),
          ...(request.target?.kind === 'new' ? [] : [request.target?.sessionId]),
        ])],
        status: 'active',
      }
      tasks.set(id, entry)
      return entry
    },
    // As DSH lists them: by the next firing, then by id.
    async catalog() {
      return [...tasks.values()].map(entry => ({ ...entry }))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
    },
    async edit({ id, action, patch }) {
      if (!tasks.has(id)) return { id, deleted: false, code: 'schedule_not_found' }
      if (action === 'delete') {
        tasks.delete(id)
        return { id, deleted: true }
      }
      if (action !== 'update') throw new Error(`unexpected edit ${action}`)
      const entry = tasks.get(id)
      if (patch?.target !== undefined) entry.target = patch.target
      if (patch?.active === false) entry.status = 'paused'
      else if (patch?.active === true) entry.status = 'active'
      return entry
    },
  }
}

// The Host-wide service of DSH 0.2.2: each task has a delivery target and changes through edit().
function hostSchedule() {
  const tasks = new Map()
  let next = 1
  const edits = []
  return {
    tasks,
    edits,
    async create({ title, prompt, timing, target }) {
      const id = `schedule-${next++}`
      const [selector] = Object.keys(timing).filter(key => key !== 'kind')
      tasks.set(id, { record: { id, kind: timing.kind, title, prompt, scheduledAt: timing.at ?? '2030-01-01T01:00:00.000Z' }, timing: timing[selector], target, status: 'active' })
      return { id }
    },
    async catalog() {
      return [...tasks.values()].map(task => ({ ...task.record, target: task.target, status: task.status }))
    },
    async edit(request) {
      edits.push(request)
      if (request.action === 'delete') tasks.delete(request.id)
      else Object.assign(tasks.get(request.id), request.patch)
      return { id: request.id }
    },
  }
}

function setup(services = {}, team = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, call, rt }
}

// DSH 0.2.2 runs a due delivery inside the schedule service's one serialization queue:
// an edit made from the delivery waterfall waits for the drive to end, and a delivery the
// drive refused is re-attempted only when `runtime.requestDrive` asks for a drive. This
// stand-in holds that queue open, records each requested drive, and lets a row model the
// delivery DSH re-attempts.
function serializedDrive() {
  const schedule = scheduleService()
  const drives = []
  const state = { failPause: false }
  let inDrive = false
  let held = Promise.resolve()
  let releaseDrive
  const baseEdit = schedule.edit
  schedule.edit = async request => {
    if (inDrive) await held
    if (request.action === 'update' && state.failPause) throw new Error('schedule store is busy')
    return baseEdit(request)
  }
  schedule.runtime = {
    requestDrive() {
      drives.push(1)
      schedule.onDrive?.()
    },
  }
  return {
    schedule,
    drives,
    state,
    // Edits wait until release(), as one made during a drive waits for it to end.
    hold() {
      inDrive = true
      held = new Promise(resolve => { releaseDrive = resolve })
    },
    release() {
      inDrive = false
      releaseDrive?.()
    },
  }
}

// Runs `until` between turns of the event loop, up to 100 of them.
const settle = async (until) => {
  for (let index = 0; index < 100 && !until(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// L1: `requestDrive` is private in dsh-schedule; a bump that drops it must not be silent.
// This runs first, because the warning is once per process.
test('a schedule service without the drive hook warns once per process', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.map(value => String(value)).join(' '))
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  // Count the drive requests: the service exposes no hook to call.
  let requests = 0
  Object.defineProperty(schedule, 'runtime', {
    configurable: true,
    get() { requests += 1; return undefined },
  })
  const noDrive = () => warnings.filter(line => /no requestDrive hook/.test(line))
  // The load-backed sweep opens the guard and needs a drive.
  await rt.load()
  await settle(() => requests > 0)
  assert.equal(requests, 1)
  assert.equal(noDrive().length, 1, warnings.join('\n'))
  // A pause that recovers needs another drive; the warning is not repeated.
  const armed = await freshTask(schedule, 'w2')
  const edit = schedule.edit
  schedule.edit = async request => {
    if (request.action === 'update') throw new Error('schedule store is busy')
    return edit(request)
  }
  await rt.updateBot('w1', { denyTools: ['bash'] })
  schedule.edit = edit
  await rt.revokeNewSchedules()
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
  assert.equal(requests, 2)
  assert.equal(noDrive().length, 1, warnings.join('\n'))
  // The warning is the visible signal; without the hook the re-drive is simply absent.
  assert.match(warnings.join('\n'), /a refused delivery waits for DSH's own next tick/)
})

test('without the schedule service the page says so and creating is refused', async (t) => {
  const { ctx, home, call } = setup()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  assert.deepEqual((await call('schedules', {})).value, { available: false, tasks: [] })
  const refused = await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Automation tasks are off/)
})

test('tasks are created on the Bot’s current part, listed by Bot, and deleted', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const daily = await call('schedule-create', { target: 'w1', title: ' Briefing ', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(daily.ok, true, JSON.stringify(daily))
  const [created] = [...schedule.tasks.values()]
  assert.equal(created.target.sessionId, 'w2')
  assert.deepEqual(created.request.timing, { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } })
  assert.equal(created.title, 'Briefing')

  await schedule.create({ title: 'Old part', prompt: 'x', timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId: 'w1' } })
  await schedule.create({ title: 'Not ours', prompt: 'x', timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId: 'outside' } })
  // A task past its firing reads overdue; an inactive one is finished.
  schedule.tasks.set('schedule-late', { id: 'schedule-late', kind: 'at', title: 'Late', prompt: 'x', scheduledAt: '2020-01-01T00:00:00.000Z', target: { kind: 'session', sessionId: 'w2' }, involvedSessionIds: ['w2'], status: 'active' })
  schedule.tasks.set('schedule-done', { id: 'schedule-done', kind: 'at', title: 'Done', prompt: 'x', scheduledAt: '2020-01-01T00:00:00.000Z', target: { kind: 'session', sessionId: 'w2' }, involvedSessionIds: ['w2'], status: 'inactive' })
  const listed = (await call('schedules', {})).value
  assert.equal(listed.available, true)
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId]), [['Done', 'w1'], ['Late', 'w1'], ['Briefing', 'w1'], ['Old part', 'w1']])
  assert.deepEqual(listed.tasks.map(task => task.state), ['finished', 'overdue', 'scheduled', 'scheduled'])

  const weekly = await call('schedule-create', { target: 'm1', title: 'Week', prompt: 'Plan', when: { kind: 'weekly', time: '18:30', timeZone: 'UTC', weekdays: [5, 1, 1, 9] } })
  assert.equal(weekly.ok, true)
  assert.deepEqual([...schedule.tasks.values()].at(-1).request.timing, { kind: 'weekly', weekly: { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] } })
  const every = await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.deepEqual([...schedule.tasks.values()].at(-1).request.timing, { kind: 'every', every_seconds: 1800 }, JSON.stringify(every))

  for (const [when, message] of [
    [{ kind: 'at', at: '2000-01-01T00:00:00Z' }, /future/],
    [{ kind: 'weekly', time: '09:00', weekdays: [] }, /at least one day/],
    [{ kind: 'daily', time: '9am' }, /time of day/],
    [{ kind: 'every', minutes: 0 }, /1 minute to 7 days/],
  ]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'x', prompt: 'y', when })
    assert.match(refused.error.message, message)
  }
  assert.match((await call('schedule-create', { target: 'm1', title: '', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /name/)

  const removed = await call('schedule-delete', { sessionId: 'w2', id: created.id })
  assert.deepEqual(removed.value.tasks.map(task => task.title), ['Done', 'Late', 'Old part', 'Week', 'Ping'])
  assert.match((await call('schedule-delete', { sessionId: 'outside', id: 'schedule-3' })).error.message, /No such task/)
})

test('a group chat task lives on the group Session and lists under the group', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const made = await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()][0].target.sessionId, 'g1')
  assert.deepEqual(made.value.tasks.map(task => [task.title, task.roomId, task.botId]), [['Standup', 'g1', undefined]])
  assert.match((await call('schedule-create', { target: 'nobody', title: 'x', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /No such Bot or group chat/)
})

test('a due reminder reaches a group as its prompts', () => {
  const one = ['[SCHEDULE REMINDER]', 'framing', 'schedule_id_json: "s1"', 'occurrence_at: 2030-01-01T00:00:00Z', 'reminder_prompt_json: "Where are we?"'].join('\n')
  assert.equal(reminderText(one), '[Scheduled task] Where are we?')
  const batch = ['[SCHEDULE REMINDER BATCH]', 'framing', `reminders_json: ${JSON.stringify([{ schedule_id: 'a', reminder_prompt: 'One' }, { schedule_id: 'b', reminder_prompt: 'Two' }])}`].join('\n')
  assert.equal(reminderText(batch), '[Scheduled task] One\n[Scheduled task] Two')
  assert.equal(reminderText('plain text'), 'plain text')
})

// Fei2411/DS-Bot#814: DSH 0.2.2 keeps tasks Host-wide with a delivery target.
test('on DSH 0.2.2 tasks target the Bot’s current part, list by target, delete by id and move in place', async (t) => {
  const schedule = hostSchedule()
  const { ctx, home, call, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'w1', title: 'Briefing', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  const [created] = [...schedule.tasks.values()]
  assert.deepEqual(created.target, { kind: 'session', sessionId: 'w2' })
  assert.equal(created.record.kind, 'daily')
  assert.deepEqual(created.timing, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.deepEqual([...schedule.tasks.values()].at(-1).timing, 1800)

  schedule.tasks.set('schedule-paused', { record: { id: 'schedule-paused', kind: 'rrule', title: 'Held', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w2' }, status: 'paused' })
  schedule.tasks.set('schedule-ended', { record: { id: 'schedule-ended', kind: 'at', title: 'Done', prompt: 'x', scheduledAt: '2020-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w2' }, status: 'ended' })
  schedule.tasks.set('schedule-new', { record: { id: 'schedule-new', kind: 'at', title: 'Elsewhere', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'new_once' }, status: 'active' })
  const listed = (await call('schedules', {})).value
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId, task.sessionId, task.state]), [
    ['Briefing', 'w1', 'w2', 'scheduled'], ['Ping', 'm1', 'm1', 'scheduled'], ['Held', 'w1', 'w2', 'paused'], ['Done', 'w1', 'w2', 'finished'],
  ])

  await rt.moveSchedules('w2', 's9')
  assert.deepEqual(schedule.edits.map(edit => [edit.id, edit.patch?.target?.sessionId]), [['schedule-1', 's9'], ['schedule-paused', 's9']])
  assert.deepEqual(schedule.tasks.get('schedule-ended').target, { kind: 'session', sessionId: 'w2' })

  assert.match((await call('schedule-delete', { sessionId: 'w2', id: 'schedule-1' })).error.message, /No such task/)
  assert.match((await call('schedule-delete', { sessionId: 'm1', id: 'schedule-new' })).error.message, /No such task/)
  const removed = await call('schedule-delete', { sessionId: 'm1', id: 'schedule-2' })
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.equal(schedule.tasks.has('schedule-2'), false)
  assert.deepEqual(schedule.edits.at(-1), { id: 'schedule-2', action: 'delete' })
})

// DSH 0.2.2's task ids are Host-wide, so schedule_edit could reach another Bot's task.
test('on DSH 0.2.2 a Bot reads and changes only the tasks of its own chat', async (t) => {
  const schedule = hostSchedule()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  schedule.tasks.set('own', { record: { id: 'own', kind: 'at', title: 'Mine', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w1' }, status: 'active' })
  schedule.tasks.set('chief', { record: { id: 'chief', kind: 'at', title: 'Chief', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'm1' }, status: 'active' })
  schedule.tasks.set('elsewhere', { record: { id: 'elsewhere', kind: 'at', title: 'New', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'new_once' }, status: 'active' })
  const gate = ctx.listeners.get('tools/pre-execute').find(listener => listener.name === 'ownTasksGate')
  const check = (name, id, sessionId) => gate({ name, arguments: { id, action: 'delete' }, agent: { id: sessionId } }, async () => ({ kind: 'allow' }))
  assert.deepEqual(await check('schedule_edit', 'own', 'w2'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_view', 'own', 'w2'), { kind: 'allow' })
  for (const id of ['chief', 'elsewhere']) {
    for (const name of ['schedule_edit', 'schedule_view']) assert.equal((await check(name, id, 'w2')).kind, 'deny')
  }
  assert.deepEqual(await check('schedule_edit', 'chief', 'm1'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_edit', 'missing', 'w2'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_list', 'chief', 'w2'), { kind: 'allow' })
  assert.deepEqual(await check('schedule_edit', 'chief', 'outside'), { kind: 'allow' })

  // schedule_list asks the tool for the Host range that holds the caller's page and
  // keeps the caller's own tasks. Other modules wrap tools/execute too.
  schedule.tasks.set('own2', { record: { id: 'own2', kind: 'at', title: 'Mine too', prompt: 'x', scheduledAt: '2030-01-01T00:00:00.000Z' }, target: { kind: 'session', sessionId: 'w2' }, status: 'active' })
  const list = ctx.listeners.get('tools/execute').find(listener => listener.name === 'listOwnSchedules')
  const asked = []
  // The tool's own page: the catalog order, cut at offset and limit.
  const run = (sessionId, args) => {
    const exec = { name: 'schedule_list', arguments: args, agent: { id: sessionId } }
    return list(exec, async () => {
      asked.push(exec.arguments)
      const { limit = 100, offset = 0 } = exec.arguments
      const all = (await schedule.catalog()).map(entry => ({ id: entry.id, title: entry.title, target: entry.target }))
      const items = all.slice(offset, offset + limit)
      return { isError: false, value: { items, shown: items.length, total: all.length, limit, offset } }
    }).then(result => ({ result, args: exec.arguments }))
  }
  const second = await run('w2', { active: true, limit: 1, offset: 1 })
  assert.deepEqual(asked.at(-1), { active: true, limit: 1, offset: 3 })
  assert.deepEqual(second.args, { active: true, limit: 1, offset: 1 })
  assert.deepEqual(second.result.value, { items: [{ id: 'own2', title: 'Mine too', target: { kind: 'session', sessionId: 'w2' } }], shown: 1, total: 2, limit: 1, offset: 1 })
  const both = await run('w2', {})
  assert.deepEqual(asked.at(-1), { limit: 4, offset: 0 })
  assert.deepEqual(both.result.value.items.map(task => task.id), ['own', 'own2'])
  assert.deepEqual((await run('w2', { offset: 5 })).result.value, { items: [], shown: 0, total: 2, limit: 100, offset: 5 })
  // A page out of DSH's range goes to DSH as asked, and what comes back is still narrowed.
  const wide = await run('w2', { limit: 501 })
  assert.deepEqual(asked.at(-1), { limit: 501 })
  assert.deepEqual(wide.result.value.items.map(task => task.id), ['own', 'own2'])
  assert.equal(wide.result.value.total, 2)
  assert.deepEqual((await run('m1', {})).result.value.items.map(task => task.id), ['chief'])
  assert.equal((await run('outside', {})).result.value.items.length, 4)
})

test('a failed task move can resume without losing identical remaining tasks', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const seed = { title: 'Ping', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId: 'w2' } }
  await schedule.create(seed)
  await schedule.create(seed)
  // The Bot's own schedule tool makes rrule tasks on 0.2.2; a rotation must carry them too.
  await schedule.create({ title: 'Bot task', prompt: 'Check the build', timing: { kind: 'rrule', rrule: 'DTSTART:20300101T090000Z\nRRULE:FREQ=DAILY' }, target: { kind: 'session', sessionId: 'w2' } })

  // A task moves in place (its target changes), so a failure leaves the rest where they were.
  const edit = schedule.edit
  let attempts = 0
  schedule.edit = async (...args) => {
    if (++attempts === 2) throw new Error('down')
    return edit(...args)
  }
  await assert.rejects(rt.moveSchedules('w2', 's9'), /down/)
  const on = id => [...schedule.tasks.values()].filter(task => task.target.sessionId === id)
  assert.equal(on('s9').length, 1)
  assert.equal(on('w2').length, 2)

  schedule.edit = edit
  await rt.moveSchedules('w2', 's9')
  assert.equal(on('s9').length, 3)
  assert.equal(on('w2').length, 0)
  const movedRrule = on('s9').find(task => task.request.timing.kind === 'rrule')
  assert.equal(movedRrule?.request.timing.rrule, 'DTSTART:20300101T090000Z\nRRULE:FREQ=DAILY')
})

// #584, L5: a fresh-Session target (`new`/`new_once`) opens a Session no deny layer binds.
// A restricted Bot's already-armed tasks are paused; the record stays so the user can see it.
const freshTask = (schedule, actor, title = 'Nightly') => schedule.create({
  title, prompt: 'Check the build', timing: { kind: 'every', every_seconds: 3600 },
  target: { kind: 'new', create: { cwd: '/tmp' } },
}, actor)

test('restricting a Bot pauses the fresh-Session tasks its Sessions armed', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  // Armed by w1's own chat (`w2`) before it had a deny list.
  const fresh = await freshTask(schedule, 'w2')
  const bound = await schedule.create({
    title: 'Reminder', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 },
    target: { kind: 'session', sessionId: 'w2' },
  }, 'w2')
  const outside = await freshTask(schedule, 'outside', 'Elsewhere')
  // A `new_once` task is rewritten to its fresh Session after the first delivery; that
  // Session has no lineage, so the task is still unbound.
  const delivered = await schedule.create({
    title: 'Once', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 },
    target: { kind: 'session', sessionId: 'fresh-1' },
  }, 'w2')
  // An unrestricted Bot keeps its fresh-Session task, whatever the sweep sees.
  await rt.revokeNewSchedules()
  assert.equal(schedule.tasks.get(fresh.id).status, 'active')
  // The user's settings restrict it: its fresh-Session tasks pause, the bound one stays.
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(schedule.tasks.get(fresh.id).status, 'paused')
  assert.equal(schedule.tasks.get(delivered.id).status, 'paused')
  assert.equal(schedule.tasks.get(bound.id).status, 'active')
  assert.equal(schedule.tasks.get(outside.id).status, 'active')
})

// DSH's live registry holds loaded Sessions only; the durable copy keeps a child's
// parent and subagent origin after it ends or before it reopens on a restart.
const durableChild = async id => (id === 'child-1'
  ? { header: { origin: 'subagent', parentSession: 'w2' } }
  : undefined)

test('a subagent child that is no longer live resolves through its durable header', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  ctx.sessions = undefined
  ctx.sessionPersistence = { stat: durableChild }
  await rt.load()
  const armed = await freshTask(schedule, 'child-1', 'Child')
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
})

test('a restart with a restricted Bot pauses a child-armed task that is not live', async (t) => {
  const schedule = scheduleService()
  const armed = await freshTask(schedule, 'child-1', 'Child')
  const team = JSON.parse(JSON.stringify(TEAM))
  team.bots.w1.denyTools = ['bash']
  const { ctx, home, rt } = setup({ schedule }, team)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  ctx.sessionPersistence = { stat: durableChild }
  await rt.load()
  for (let index = 0; index < 100 && schedule.tasks.get(armed.id).status === 'active'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
})

test('a pause that the schedule service refuses blocks unlineaged deliveries', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  const armed = await freshTask(schedule, 'w2')
  const edit = schedule.edit
  schedule.edit = async request => {
    if (request.action === 'update') throw new Error('schedule store is busy')
    return edit(request)
  }
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(schedule.tasks.get(armed.id).status, 'active')
  // Fail closed: an unlineaged Session is not activated while the pause is stuck...
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  assert.equal(typeof guard, 'function')
  let nexted = 0
  await assert.rejects(
    () => guard('fresh-1', async () => { nexted += 1 }),
    /blocked until its task can be paused/,
  )
  // ...and the next sweep that can pause it clears the block.
  schedule.edit = edit
  await rt.revokeNewSchedules()
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
  assert.equal(await guard('fresh-1', async () => { nexted += 1; return 'live' }), 'live')
  assert.equal(nexted, 1)
})

test('a restart with the deny list already set pauses the armed fresh-Session task', async (t) => {
  const schedule = scheduleService()
  const armed = await freshTask(schedule, 'w2')
  assert.equal(armed.status, 'active')
  const team = JSON.parse(JSON.stringify(TEAM))
  team.bots.w1.denyTools = ['bash']
  const { ctx, home, rt } = setup({ schedule }, team)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  // The check runs after the boot load; give it the turns it needs.
  for (let index = 0; index < 100 && schedule.tasks.get(armed.id).status === 'active'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
})

test('deleting a Bot pauses the fresh-Session task its Session armed', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  await rt.load()
  const armed = await freshTask(schedule, 'w2')
  await rt.deleteBot('w1')
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
})

test('a read-only host neither pauses nor vouches for unlineaged deliveries', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  const team = JSON.parse(JSON.stringify(TEAM))
  team.bots.w1.denyTools = ['bash']
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  // Another live process holds the team lock: this host only follows the file.
  writeFileSync(join(home, 'state.lock'),
    JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other', since: Date.now() }))
  const schedule = scheduleService()
  const armed = await freshTask(schedule, 'w2')
  const ctx = fakeContext({ services: { schedule } })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  // The other host owns the team: this one writes nothing and cannot vouch for the state.
  await rt.revokeNewSchedules()
  assert.equal(schedule.tasks.get(armed.id).status, 'active')
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  await assert.rejects(
    () => guard('fresh-1', async () => 'ran'),
    /blocked until its task can be paused/,
  )
  // It takes the team over; the next delivery checks, pauses the task and refuses it.
  rmSync(join(home, 'state.lock'))
  await rt.refresh()
  await assert.rejects(
    () => guard('fresh-1', async () => 'ran'),
    /blocked until its task can be paused/,
  )
  // The refusal kicks the check off the delivery path; it pauses the task right after.
  for (let index = 0; index < 100 && schedule.tasks.get(armed.id).status === 'active'; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(schedule.tasks.get(armed.id).status, 'paused')
  // The guard opens once the check that pause kicked off has finished.
  let ran
  for (let index = 0; index < 100 && ran === undefined; index += 1) {
    try {
      ran = await guard('fresh-2', async () => 'ran')
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  assert.equal(ran, 'ran')
})

test('the attach-time check runs before the team loads without an error', async (t) => {
  const schedule = scheduleService()
  const ctx = fakeContext({ services: { schedule } })
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.map(value => String(value)).join(' '))
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  // The service is present before the team is read, so the attach-time check runs first.
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.doesNotMatch(warnings.join('\n'), /before initialization/)
  assert.doesNotMatch(warnings.join('\n'), /fresh-Session tasks were not checked/)
})

test('the delivery guard refuses without waiting on a serialized schedule write', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  const armed = await freshTask(schedule, 'w2')
  // The real service serializes management writes behind the delivery drive: an edit made
  // from the waterfall waits for that drive to end. A guard that awaited it would hang.
  const baseEdit = schedule.edit
  let inDrive = false
  let failPause = true
  let releaseDrive
  let driveHeld = Promise.resolve()
  schedule.edit = async request => {
    if (inDrive) await driveHeld
    if (request.action === 'update' && failPause) throw new Error('store busy')
    return baseEdit(request)
  }
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(schedule.tasks.get(armed.id).status, 'active')
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  inDrive = true
  driveHeld = new Promise(resolve => { releaseDrive = resolve })
  const outcome = await Promise.race([
    guard('fresh-1', async () => 'ran').then(() => 'next', () => 'refused'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 250)),
  ])
  inDrive = false
  failPause = false
  releaseDrive()
  assert.equal(outcome, 'refused')
})

test('a stuck pause does not block a reminder on the user\'s own Session', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await freshTask(schedule, 'w2')
  // The user's own reminder on a Session outside the team, armed without an acting Bot.
  const own = await schedule.create({
    title: 'Mine', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 },
    target: { kind: 'session', sessionId: 'outside' },
  })
  assert.deepEqual(own.involvedSessionIds, ['outside'])
  const edit = schedule.edit
  schedule.edit = async request => {
    if (request.action === 'update') throw new Error('store busy')
    return edit(request)
  }
  await rt.updateBot('w1', { denyTools: ['bash'] })
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  // The restricted Bot's fresh task is refused; the user's own reminder is not.
  await assert.rejects(
    () => guard('fresh-1', async () => 'ran'),
    /blocked until its task can be paused/,
  )
  assert.equal(await guard('outside', async () => 'ran'), 'ran')
})

test('clearing the deny list releases a stuck pause and asks DSH to drive again', async (t) => {
  const schedule = scheduleService()
  const drives = []
  schedule.runtime = { requestDrive: () => drives.push(1) }
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  const armed = await freshTask(schedule, 'w2')
  const edit = schedule.edit
  schedule.edit = async request => {
    if (request.action === 'update') throw new Error('store busy')
    return edit(request)
  }
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(schedule.tasks.get(armed.id).status, 'active')
  const before = drives.length
  // The user clears the list: there is no restriction left to bypass, so the task is
  // released, the guard opens and DSH is asked to re-drive what it refused.
  schedule.edit = edit
  await rt.updateBot('w1', { denyTools: [] })
  assert.equal(schedule.tasks.get(armed.id).status, 'active')
  assert.ok(drives.length > before)
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  assert.equal(await guard('fresh-1', async () => 'ran'), 'ran')
})

// L2: the retry tick is what recovers a pause the store refused. Without it the task stays
// active and every delivery to a fresh Session stays refused.
test('the 15 s retry tick pauses a stuck task and releases its deliveries', async (t) => {
  const drive = serializedDrive()
  const { ctx, home, rt } = setup({ schedule: drive.schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  // The load-backed sweep already asked for one drive when it opened the guard.
  const before = drive.drives.length
  const armed = await freshTask(drive.schedule, 'w2')
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  drive.state.failPause = true
  t.mock.timers.enable({ apis: ['setInterval'] })
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(drive.schedule.tasks.get(armed.id).status, 'active')
  // A refusal made while the edit waits behind a held drive does not hang the delivery.
  drive.hold()
  const outcome = await Promise.race([
    guard('fresh-1', async () => 'ran').then(() => 'next', () => 'refused'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 250)),
  ])
  drive.release()
  assert.equal(outcome, 'refused')
  // The sweep that refusal kicked off found the store still refusing: nothing moved yet.
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(drive.schedule.tasks.get(armed.id).status, 'active')
  assert.equal(drive.drives.length, before)
  // The store answers: the next tick pauses the task and asks DSH to drive again.
  drive.state.failPause = false
  t.mock.timers.tick(15_000)
  await settle(() => drive.schedule.tasks.get(armed.id).status === 'paused')
  assert.equal(drive.schedule.tasks.get(armed.id).status, 'paused')
  assert.equal(drive.drives.length, before + 1)
  assert.equal(await guard('fresh-1', async () => 'ran'), 'ran')
  // The tick that saw the queue clear stops the timer: no further drives.
  t.mock.timers.tick(15_000)
  t.mock.timers.tick(15_000)
  assert.equal(drive.drives.length, before + 1)
})

// L3: a reminder due during the boot window is refused until the team loads; the
// load-backed sweep then asks DSH to drive again, and the held delivery lands.
test('a boot-window reminder lands after load through the re-drive', async (t) => {
  const drive = serializedDrive()
  const { ctx, home, rt } = setup({ schedule: drive.schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await drive.schedule.create({
    title: 'Mine', prompt: 'Check', timing: { kind: 'every', every_seconds: 3600 },
    target: { kind: 'session', sessionId: 'user-chat' },
  })
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  let landed
  await assert.rejects(
    () => guard('user-chat', async () => { landed = 'ran' }),
    /blocked until its task can be paused/,
  )
  assert.equal(landed, undefined)
  assert.equal(drive.drives.length, 0)
  // DSH re-attempts the delivery it refused when a drive is requested.
  drive.schedule.onDrive = () => {
    void guard('user-chat', async () => { landed = 'ran' }).catch(() => {})
  }
  await rt.load()
  await settle(() => landed === 'ran')
  assert.equal(landed, 'ran')
  assert.equal(drive.drives.length, 1)
})

// DSH hides a `new` target's reserved Session id. A stuck pause must refuse that id and
// still let the user's ordinary reminder on another Session run.
test('an ordinary reminder is not wedged by a reserved fresh id', async (t) => {
  const drive = serializedDrive()
  const { ctx, home, rt } = setup({ schedule: drive.schedule })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  const reserved = await drive.schedule.create({
    title: 'Nightly', prompt: 'Check the build', timing: { kind: 'every', every_seconds: 3600 },
    target: { kind: 'new_once', sessionId: 'reserved-7' },
  }, 'w2')
  drive.state.failPause = true
  await rt.updateBot('w1', { denyTools: ['bash'] })
  assert.equal(drive.schedule.tasks.get(reserved.id).status, 'active')
  const guard = (ctx.listeners.get('schedule/resolve-agent') ?? [])[0]
  // The reserved id is refused while its task cannot be paused...
  drive.hold()
  await assert.rejects(
    () => guard('reserved-7', async () => 'ran'),
    /blocked until its task can be paused/,
  )
  // ...and the user's own reminder runs, even with the delivery drive held open: the
  // guard reads the catalog, which the drive does not serialize.
  assert.equal(await guard('user-chat', async () => 'ran'), 'ran')
  drive.release()
})
