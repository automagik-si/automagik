// node --test chat/question.test.mjs: which questions get options to tap, and the keys a choice
// becomes (Claude Code 2.1.319, as probed). Facts only, no hc; engine.test.mjs presses them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OTHER, QUESTION_TOOL, questionRow, questionShown, questionState, questionSteps } from './question.js'

const blocked = { state: 'blocked', kind: 'question', msg: 'Which?', turn: 4 }
const call = (questions, id = 'c1') => ({ id, tool: QUESTION_TOOL, input: { questions } })
const q = (multiSelect = false, n = 2) => ({ question: 'Which?', multiSelect, options: Array.from({ length: n }, (_, i) => ({ label: `Opt ${i + 1}` })) })
const facts = (over = {}) => ({ agent: 'claude', status: blocked, screen: '', openCalls: [call([q()])], ...over })

test('only Claude gets options: Codex and OpenCode step but were never probed, omp cannot be keyed', () => {
  assert.deepEqual(questionState(facts()), { call: { id: 'c1' }, prompt: 'Which?', options: ['Opt 1', 'Opt 2'], multi: false, why: null })
  assert.equal(questionState(facts({ agent: 'openclaude' })).why, null)
  for (const agent of ['codex', 'opencode', 'omp', 'grok', null, 'zsh']) {
    const s = questionState(facts({ agent }))
    assert.deepEqual([s.call, s.options, s.why], [null, [], 'answer-in-terminal'], String(agent))
    assert.equal(questionRow(s, { turn: 4 }).answerable, false)
  }
})

test('no options unless one open call asks one readable question with 2 to 8 options', () => {
  assert.equal(questionState(facts({ openCalls: [] })).why, 'no-open-call')
  assert.equal(questionState(facts({ openCalls: [call([q()]), call([q()], 'c2')] })).why, 'several-open-calls')
  for (const questions of [[q(), q()], [], [q(false, 1)], [q(false, 9)], [{ question: '', options: [{ label: 'a' }, { label: 'b' }] }], [{ question: 'x', options: [{ label: 'a' }, {}] }]]) {
    assert.equal(questionState(facts({ openCalls: [call(questions)] })).why, 'answer-in-terminal')
  }
  // An approval, a status that is not blocked: no question at all. An auth prompt: answered in the terminal.
  assert.equal(questionState(facts({ status: { ...blocked, kind: 'permission' } })), null)
  assert.equal(questionState(facts({ status: { ...blocked, state: 'working' } })), null)
  assert.equal(questionState(facts({ status: { ...blocked, kind: 'auth' } })).why, 'answer-in-terminal')
})

test('the row: options and multi only when answerable; its id names the call', () => {
  const s = questionState(facts({ openCalls: [call([q(true)])] }))
  assert.deepEqual(questionRow(s, { turn: 4, segment: 1 }), {
    id: 'question:c1', segment: 1, turn: 4, at: null, source: 'status', kind: 'question', prompt: 'Which?',
    options: ['Opt 1', 'Opt 2'], multi: true, answerable: true, call: 'c1', open: true
  })
  const answered = questionRow({ ...s, why: 'answered' }, { turn: 4 })
  assert.deepEqual([answered.options, answered.multi, answered.answerable, answered.why], [[], false, false, 'answered'])
})

test('a choice becomes keys: a digit; N+1 then the text; digits, Right, Enter', () => {
  const single = questionState(facts())
  const multi = questionState(facts({ openCalls: [call([q(true, 3)])] }))
  assert.deepEqual(questionSteps(single, '2'), [{ keys: ['2'], screen: true }])
  assert.deepEqual(questionSteps(single, OTHER, ' MySQL '), [{ keys: ['3'], screen: true }, { text: 'MySQL', screen: true }])
  assert.deepEqual(questionSteps(multi, '3,1'), [{ keys: ['3'], screen: true }, { keys: ['1'], screen: true }, { keys: ['right'], screen: true }, { keys: ['enter'], screen: false }])
  for (const [s, choice, text] of [[single, '3'], [single, '0'], [single, '1,2'], [single, 'allow'], [single, OTHER, ''], [single, OTHER, 'a\nb'],
    [single, OTHER, 'a\u001b[31mb'], [single, OTHER], [multi, '1,1'], [multi, ''], [multi, '4'], [multi, OTHER, 'x'], [single, 1]]) {
    assert.equal(questionSteps(s, choice, text), null, `${choice} ${text}`)
  }
})

test('the question is shown: its text and every label in the bottom rows, wrapped or not', () => {
  const s = questionState(facts())
  assert.equal(questionShown('Which?\n❯ 1. Opt 1\n  2. Opt\n     2\nEsc to cancel\n', s), true)
  assert.equal(questionShown('Which?\n❯ 1. Opt 1\nEsc to cancel\n', s), false)
  assert.equal(questionShown(`Which?\n1. Opt 1\n2. Opt 2\n${'later\n'.repeat(40)}`, s), false)
})
