// node --test chat/answer.test.mjs: answer keys, the approval envelope (ported from Orca's
// native-chat-approval-envelope.test.ts) and paced question steps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalKeys, nativeChatAskRequiresTerminal, nativeChatQuestionOffsets, nativeChatStopSendsSecondEscape,
  parseNativeChatApprovalEnvelope, scheduleNativeChatAnswer, shouldStepNativeChatAskAnswer
} from './answer.js'

const ESC = String.fromCharCode(27)

test('reads tool and summary with the default TUI answer keys', () => {
  assert.deepEqual(parseNativeChatApprovalEnvelope(JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })),
    { tool: 'Bash', summary: 'rm -rf build', allowSend: '1', denySend: ESC })
})

test('omits a missing, empty or non-string summary', () => {
  for (const approval of [{ tool: 'Edit' }, { tool: 'Edit', summary: '' }, { tool: 'Edit', summary: 42 }]) {
    assert.ok(!('summary' in parseNativeChatApprovalEnvelope(JSON.stringify({ approval }))))
  }
})

test('returns null for anything that is not an approval envelope', () => {
  for (const input of [null, undefined, '', '{bad', '"approval"', 'null', '[]', '{}', JSON.stringify({ questions: [] }),
    JSON.stringify({ approval: 'Bash' }), JSON.stringify({ approval: {} }), JSON.stringify({ approval: { tool: '' } }), JSON.stringify({ approval: { tool: 7 } })]) {
    assert.equal(parseNativeChatApprovalEnvelope(input), null, String(input))
  }
})

test('approval keys as herdr-core names: 1 to allow, esc to deny; none for an unknown agent', () => {
  assert.deepEqual(approvalKeys('claude'), { allow: ['1'], deny: ['esc'] })
  assert.deepEqual(approvalKeys('codex'), { allow: ['1'], deny: ['esc'] })
  assert.deepEqual(approvalKeys('omp'), { allow: ['1'], deny: ['esc'] })
  assert.equal(approvalKeys('gemini'), null)
  assert.equal(approvalKeys(null), null)
})

test('which agents step answers, need the terminal, or take a second esc', () => {
  assert.deepEqual(['claude', 'codex', 'omp'].map(shouldStepNativeChatAskAnswer), [true, true, false])
  assert.deepEqual(['claude', 'codex', 'omp'].map(nativeChatAskRequiresTerminal), [false, false, true])
  assert.deepEqual(['claude', 'codex', 'omp'].map(nativeChatStopSendsSecondEscape), [false, false, false])
})

test('question steps: one body and one Enter per answer, 500 ms apart plus 500 ms to draw the next', () => {
  assert.deepEqual([0, 1, 2].map(nativeChatQuestionOffsets), [{ bodyAt: 0, enterAt: 500 }, { bodyAt: 1000, enterAt: 1500 }, { bodyAt: 2000, enterAt: 2500 }])
  const plan = []
  scheduleNativeChatAnswer(['a', 'b'], (l) => plan.push(['body', l]), () => plan.push(['enter']), { setTimeout: (fn, ms) => { plan.push(['at', ms]); fn() } })
  assert.deepEqual(plan, [['at', 0], ['body', 'a'], ['at', 500], ['enter'], ['at', 1000], ['body', 'b'], ['at', 1500], ['enter']])
})
