import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyNow, confirmationBudget, CONFIRMATION_MS, stagedIdentity } from '../src/auto-apply.js'
import { readBusy } from '../src/idle.js'
import { runningBots } from '../src/quit-guard.js'

const staged = () => ({ version: '3.1.2', at: new Date().toISOString(),
  lanes: { publisher: { version: '3.1.2', sequence: 1002 } },
  plugins: [{ publisher: 'publisher', name: 'p', version: '3.1.2', integrity: 'sha512-bytes' }] })
function fixture(wake = () => {}) {
  let clock = 0, wall = 1000, id = 0
  const pending = new Map()
  const timers = { setTimeout: (fn, ms) => { pending.set(++id, { fn, at: clock + ms }); return id }, clearTimeout: key => pending.delete(key) }
  const budget = confirmationBudget({ now: () => clock, wall: () => wall, timers, wake })
  const run = { child: { exitCode: null, signalCode: null }, since: 1000, staged: staged() }
  const busy = (extra = {}) => ({ running: 0, logins: 1, confirming: 1, at: 1000, confirmingUntil: 91000, ...extra })
  return { budget, run, busy, pending, shift: ms => { wall += ms }, advance(ms) {
    clock += ms; wall += ms
    for (const [key, job] of [...pending]) if (job.at <= clock) { pending.delete(key); job.fn() }
  } }
}

test('one budget covers replacement attempts, same/new snapshots, malformed/future deadlines and final recheck', () => {
  const h = fixture()
  assert.equal(h.budget.read(h.busy(), h.run).running, 1)
  h.advance(60000)
  h.run.staged = staged()
  assert.equal(h.budget.read(h.busy({ at: 61000, confirmingUntil: 151000, logins: 2 }), h.run).running, 1)
  h.advance(30000)
  for (const value of [h.busy(), h.busy({ confirmingUntil: 999999999 }), h.busy({ confirmingUntil: 'bad' }), h.busy({ confirming: 'unknown' })]) {
    assert.equal(h.budget.read(value, h.run).running, 0)
  }
  assert.equal(h.budget.read(h.busy({ running: 2 }), h.run).running, 2)
  assert.equal(h.budget.read(null, h.run), null)
  assert.equal(h.budget.read(h.busy({ at: 999 }), h.run), null)
  assert.equal(h.budget.read(readBusy('/fake', () => '{"untrusted":true,"running":0}'), h.run), null)
})

test('an earlier writer deadline wins, clock shifts cannot extend a local deadline, and zero confirmations do not renew', () => {
  const h = fixture()
  h.budget.read(h.busy({ confirmingUntil: 11000 }), h.run)
  h.shift(-1000000)
  h.advance(10000)
  assert.equal(h.budget.read(h.busy(), h.run).running, 0)
  assert.equal(h.budget.read(h.busy({ confirming: 0 }), h.run).running, 0)
  assert.equal(h.budget.read(h.busy({ confirmingUntil: 999999999 }), h.run).running, 0)
})

test('only a different physical child/start or staged target resets the budget and cancels its wake', () => {
  const h = fixture()
  h.budget.read(h.busy(), h.run)
  assert.equal(h.pending.size, 1)
  const identical = staged()
  identical.at = 'other publication time'
  assert.equal(stagedIdentity(h.run.staged), stagedIdentity(identical))
  h.budget.sync({ ...h.run, staged: identical })
  assert.equal(h.pending.size, 1)
  h.budget.sync({ ...h.run, staged: null })
  assert.equal(h.pending.size, 0)
  h.budget.read(h.busy(), h.run)
  h.advance(CONFIRMATION_MS)
  h.run.child = { exitCode: null, signalCode: null }
  assert.equal(h.budget.read(h.busy({ confirmingUntil: 999999999 }), h.run).running, 1)
  h.budget.sync({ ...h.run, since: 2000 })
  assert.equal(h.pending.size, 0)
  h.run.staged.plugins[0].integrity = 'different-bytes'
  assert.equal(h.budget.read(h.busy({ confirmingUntil: 999999999 }), h.run).running, 1)
  h.budget.reset()
  assert.equal(h.pending.size, 0)
})

test('deadline wakes once through ordinary eligibility and every existing guard still holds', () => {
  for (const guard of [{ auto: false }, { applying: true }, { appUpdate: true }, { trial: 'trial' },
    { trial: 'applied' }, { fetching: true }, { focused: true, idleMs: 59999 }, { staged: null }]) {
    let wakes = 0, decision
    const h = fixture(() => {
      wakes++
      decision = applyNow({ staged: h.run.staged, auto: true, focused: false,
        busy: h.budget.read(h.busy(), h.run), ...guard })
    })
    h.budget.read(h.busy(), h.run)
    h.advance(CONFIRMATION_MS)
    assert.equal(wakes, 1)
    assert.notEqual(decision, 'apply')
    h.advance(CONFIRMATION_MS)
    assert.equal(wakes, 1)
  }
  let decision
  const h = fixture(() => { decision = applyNow({ staged: h.run.staged, auto: true,
    busy: h.budget.read(h.busy(), h.run), focused: false }) })
  h.budget.read(h.busy(), h.run)
  h.advance(CONFIRMATION_MS)
  assert.equal(decision, 'apply')
  assert.equal(applyNow({ staged: h.run.staged, auto: true, busy: h.budget.read(h.busy({ running: 1 }), h.run) }), 'agents at work')
})

test('waiting-only modern readings are idle and do not count as bots in a manual quit warning', () => {
  const h = fixture()
  const waiting = h.budget.read(h.busy({ confirming: 0, logins: 2 }), h.run)
  assert.equal(applyNow({ staged: h.run.staged, auto: true, busy: waiting, focused: false }), 'apply')
  assert.equal(runningBots(waiting), 0)
  assert.equal(h.pending.size, 0)
  h.run.child.exitCode = 0
  assert.equal(h.budget.read(waiting, h.run), null)
})
