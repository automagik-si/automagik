import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalCount, approvalDetail, approvalPlace, groupApprovals, nativeAsk, answerGroup } from '../src/client/approvals.js'

test('capability groups keep arrival order and requests without keys stay separate', () => {
  const entries = [
    { id: 'late', capabilityKey: 'same', at: 5 }, { id: 'single', at: 2 },
    { id: 'first', capabilityKey: 'same', at: 1 }, { id: 'other', capabilityKey: 'other', at: 2 }, { id: 'last', at: 6 },
  ]
  assert.deepEqual(groupApprovals(entries).map(group => [group.key, group.entries.map(entry => entry.id)]), [
    ['same', ['first', 'late']], ['single', ['single']], ['other', ['other']], ['last', ['last']],
  ])
  assert.equal(entries[0].id, 'late')
  assert.equal(approvalCount({ approvals: entries }, entry => entry.capabilityKey === 'same'), 2)
  assert.equal(approvalCount({}, () => true), 0)
})

test('native asks require the exact call and an answerable approval', () => {
  const entry = { sessionId: 's', callId: 'c', tool: 'bash' }
  const pending = { kind: 'approval', callId: 'c', toolName: 'bash', answer() {} }
  const map = ask => new Map([['s', { pendingInteraction: ask }]])
  assert.equal(nativeAsk(map(pending), entry), pending)
  // The refusal ladder's keep_working ask reuses the tool's call id: the tool must match too.
  for (const change of [{ kind: 'question' }, { callId: 'other' }, { answerable: false }, { answer: undefined }, { toolName: 'keep_working' }, { reason: 'This step is hard to undo' }]) {
    assert.equal(nativeAsk(map({ ...pending, ...change }), entry), undefined)
  }
  assert.equal(nativeAsk(map({ ...pending, callId: undefined }), { sessionId: 's' }), undefined)
  assert.equal(nativeAsk(new Map(), entry), undefined)
})

test('group answers use each original request once, skip unavailable asks and survive failures', async () => {
  for (const choice of ['allow', 'reject']) {
    const calls = []
    const errors = []
    const error = new Error('stale')
    const entries = [
      { id: 'host', sessionId: 's', callId: 'c', answerable: true },
      { id: 'native', sessionId: 's', callId: 'c', tool: 'bash' },
      { id: 'skip', sessionId: 's', callId: 'wrong', tool: 'bash' },
      { id: 'broken', answerable: true }, { id: 'after', answerable: true },
    ]
    const result = await answerGroup(entries, choice, {
      actions: {
        answerApproval(id, value) {
          calls.push([id, value])
          entries.length = 0 // The group keeps the requests present at click time.
          if (id === 'broken') throw error
        },
        reportError: (...args) => errors.push(args),
      },
      statusMap: new Map([['s', { pendingInteraction: { kind: 'approval', callId: 'c', toolName: 'bash', answer: outcome => calls.push(['native', outcome]) } }]]),
    })
    assert.deepEqual(calls, [['host', choice], ['native', choice === 'allow' ? 'allowed-once' : 'rejected'], ['broken', choice], ['after', choice]])
    assert.deepEqual(errors, [[error, 'approval']])
    assert.deepEqual(result, { answered: 3, skipped: 1 })
  }
})

test('approval place prefers room then task title then recorded task label', () => {
  const roster = { roomsById: { r: { name: 'Ops' } }, tasks: { t: { title: 'Build' } } }
  assert.equal(approvalPlace({ roomId: 'r', taskId: 't' }, roster), 'Ops')
  assert.equal(approvalPlace({ roomId: 'missing', taskId: 't', label: 'old' }, roster), 'Build')
  assert.equal(approvalPlace({ taskId: 'gone', label: 'Kept title' }, roster), 'Kept title')
  assert.equal(approvalPlace({}, roster), '')
  assert.equal(approvalDetail({ detail: { code: '  exact\npath  ' } }), '  exact\npath  ')
  assert.equal(approvalDetail({}), '')
})
