// The agent's plan and usage in a live chat and in the same chat read back from its log
// (docs/research/t3-code-acp-integration.md recommendation 3). A plan is one record per change,
// folded the same way live and reopened; DSH's own todo panel draws its checklist. Usage is
// recorded once per prompt as the agent reported it, never as a DSH usage chunk (the meter owns
// it, RFC 0018), and a quarantined replay adds nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLAN_RECORD, USAGE_RECORD, plansFromLog, usageFromLog } from '../src/host/continuity.js'
import { CLIENT_CAPABILITIES, Plans, contextOf, planOf, promptUsageOf, todosOf } from '../src/host/features.js'
import { of, turn, withFixture } from './fixtures/continuity-world.js'

// The log as a reopened chat reads it: written out and parsed back.
const reopened = session => JSON.parse(JSON.stringify(session.snapshotEvents()))

test('a multi-update plan stays in place live and reopens to the same state; later text and the final answer arrive', async () => {
  await withFixture('plan', {}, async (h) => {
    const live = await turn(h, 'plan-demo')
    assert.equal(live.finish.reason.kind, 'stop')
    assert.match(live.said, /Planning\. Done\./)
    // The client told the agent it takes plan_update and plan_removed.
    assert.deepEqual(of(h, 'initialize')[0].clientCapabilities.plan, {})
    const events = h.session.snapshotEvents()
    const records = events.filter(event => event.type === PLAN_RECORD)
    assert.ok(records.every(event => event.ignorable === true))
    // p1 in progress, p2 markdown, p1 completed: the repeat of an equal plan and the removal of an
    // id never sent change nothing and write nothing.
    assert.deepEqual(records.map(event => [event.data.change.planId, event.data.change.order, event.data.change.revision]), [['p1', 0, 0], ['p2', 1, 0], ['p1', 0, 1]])
    const expected = [
      { planId: 'p1', type: 'items', entries: [{ content: 'read the code', priority: 'high', status: 'completed' }, { content: 'write the fix', priority: 'medium', status: 'completed' }] },
      { planId: 'p2', type: 'markdown', markdown: '# Notes\nkeep it small' },
    ]
    assert.deepEqual(plansFromLog(events), expected)
    assert.deepEqual(plansFromLog(reopened(h.session)), expected)
    const todos = events.filter(event => event.type === 'todo/write').at(-1).data.todos
    assert.deepEqual(todos, [{ content: 'read the code', status: 'completed' }, { content: 'write the fix', status: 'completed' }])
  })
})

test('a removed plan is gone live and after reopening', async () => {
  await withFixture('plan-remove', {}, async (h) => {
    await turn(h, 'plan-demo-remove')
    assert.deepEqual(plansFromLog(reopened(h.session)).map(plan => plan.planId), ['p1'])
  })
})

test('plan shapes: legacy plan, items, markdown, removal, and shapes this client does not read', () => {
  assert.deepEqual(planOf({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'low', status: 'pending' }] }),
    { planId: 'plan', type: 'items', entries: [{ content: 'a', priority: 'low', status: 'pending' }] })
  assert.equal(planOf({ sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'x', uri: 'file:///p' } }), undefined)
  assert.equal(planOf({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: '' , entries: [] } }), undefined)
  assert.equal(planOf({ sessionUpdate: 'plan_removed', planId: '' }), undefined)
  const plans = new Plans()
  assert.equal(plans.take({ planId: 'gone', removed: true }), undefined, 'ACP: a removal of an unknown id is ignored')
  plans.take({ planId: 'a', type: 'items', entries: [{ content: 'one', status: 'pending', priority: 'medium' }] })
  plans.take({ planId: 'b', type: 'markdown', markdown: 'm' })
  assert.deepEqual(todosOf(plans.list()), [{ content: 'one', status: 'pending' }])
  assert.deepEqual(CLIENT_CAPABILITIES, { plan: {} })
})

test('usage: context occupancy is the latest report, a prompt\'s usage is recorded once with its completeness, and no DSH usage chunk is made', async () => {
  await withFixture('usage', {}, async (h) => {
    const full = await turn(h, 'usage-demo')
    const partial = await turn(h, 'usage-demo-partial')
    const none = await turn(h, 'usage-demo-none')
    for (const step of [full, partial, none]) assert.equal(step.chunks.some(chunk => chunk.type === 'usage'), false)
    const records = h.session.snapshotEvents().filter(event => event.type === USAGE_RECORD)
    assert.equal(records.length, 3)
    assert.ok(records.every(event => event.ignorable === true))
    const [a, b, c] = records.map(event => event.data)
    assert.deepEqual(a.context, { used: 1500, size: 200000 })
    assert.equal(a.completeness, 'complete')
    assert.equal(a.semantics, 'unknown', 'a route with no declared semantics adds nothing up')
    assert.deepEqual(a.tokens, { totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: 5 })
    assert.equal(b.completeness, 'partial')
    assert.equal(c.completeness, 'absent')
    assert.deepEqual([a.ordinal, b.ordinal, c.ordinal], [1, 2, 3])
    // Read twice, or with a record duplicated, a prompt counts once.
    const events = reopened(h.session)
    assert.equal(usageFromLog([...events, ...events]).length, 3)
  })
})

test('usage readings', () => {
  assert.equal(contextOf({ used: -1, size: 10 }), undefined)
  assert.deepEqual(contextOf({ used: 1, size: 10, cost: { amount: 1.5, currency: 'USD' } }), { used: 1, size: 10, cost: { amount: 1.5, currency: 'USD' } })
  assert.deepEqual(promptUsageOf(undefined, 'acp-claude'), { completeness: 'absent', semantics: 'per-prompt' })
  assert.equal(promptUsageOf({ totalTokens: 1, inputTokens: 1, outputTokens: 0 }, 'acp-codex').semantics, 'unknown')
  assert.deepEqual(promptUsageOf({ inputTokens: 1.5 }, 'x'), { completeness: 'absent', semantics: 'unknown', tokens: {} })
})
