import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectSessionFileApproval, SessionFileApproval } from '../src/client/session-file-approval.js'
const ALLOW = 'Allow for this chat session'
const question = () => ({ id: 'acp-session-file:01234567-1234-1234-1234-0123456789ab', question: 'Read /outside/image.png for this chat session?', detail: 'Read /outside/image.png for this chat session?', options: [{ label: ALLOW }, { label: 'Reject' }], intent: { kind: 'approval', approve: ALLOW, reject: 'Reject' } })
test('exact nonce namespace and two-option approval shape select the shared card only', () => {
  assert.ok(selectSessionFileApproval({ kind: 'question', questions: [question()] }))
  for (const change of [q => { q.id = 'cua-app-access' }, q => { q.intent.kind = 'plan-review' }, q => { q.intent.always = 'Always' }, q => { q.multiSelect = true }, q => { q.options.push({ label: 'Always' }) }, q => { q.intent.approve = 'Allow once' }]) {
    const q = question(); change(q); assert.equal(selectSessionFileApproval({ kind: 'question', questions: [q] }), null)
  }
})
test('existing factory gets explicit session label, no Always, original pending answer lifetime', async () => {
  const answers = [], item = question()
  let snapshot = { channel: 'local', closed: false }
  const pending = { kind: 'question', key: 'own-session-question', questions: [item], answer: answer => answers.push(answer), snapshot: () => snapshot }
  let seen
  SessionFileApproval({ matched: selectSessionFileApproval(pending), renderFactorySlot: (name, props) => { seen = { name, props } } })
  assert.equal(seen.name, 'conversation.approval.card'); assert.equal(seen.props.allowLabel, ALLOW)
  assert.equal(seen.props.requestKey, pending.key); assert.equal('onAlways' in seen.props, false)
  assert.equal(seen.props.canAnswer(), true); snapshot = { channel: 'none', closed: false }; assert.equal(seen.props.canAnswer(), false)
  snapshot = { channel: 'local', closed: true }; assert.equal(seen.props.canAnswer(), false)
  await seen.props.onAllow(); await seen.props.onReject()
  assert.deepEqual(answers, [{ answers: [{ id: item.id, selected: [ALLOW] }] }, { answers: [{ id: item.id, selected: ['Reject'] }] }])
})
