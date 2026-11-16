// node --test chat/approve.test.mjs: approval rows get buttons only when every guard holds, and
// an answer presses nothing unless the question is still the same. Fake hc only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { answerApproval, approvalRow, approvalState } from './approve.js'
import { createFakeHc, fakeTerminal } from './fake-hc.mjs'

const dialog = readFileSync(new URL('./fixtures/screens/claude-dialog.txt', import.meta.url), 'utf8')
const idle = readFileSync(new URL('./fixtures/screens/claude-idle.txt', import.meta.url), 'utf8')
const blocked = { state: 'blocked', kind: 'permission', msg: 'approve Bash: ls -la /home/u/proj', turn: 3 }
const call = { id: '1:4.1', tool: 'Bash', input: { command: 'ls -la /home/u/proj', description: 'From the transcript' } }
const facts = (over = {}) => ({ agent: 'claude', status: blocked, screen: dialog, openCalls: [call], ...over })

test('every guard holds: allow and deny, and the row shows the transcript input, not the screen', () => {
  const s = approvalState(facts())
  assert.deepEqual(s, { tool: 'Bash', call: { id: '1:4.1', input: call.input }, choices: ['allow', 'deny'], why: null })
  const row = approvalRow(s, { turn: 3, segment: 1 })
  assert.equal(row.id, 'approval:1:4.1')
  assert.equal(row.call, '1:4.1')
  assert.deepEqual(row.choices, ['allow', 'deny'])
  assert.match(row.input, /From the transcript/)
  assert.ok(!row.input.includes('tip line') && !row.summary.includes('List the project folder'), 'nothing from the screen')
  assert.equal(row.summary, 'ls -la /home/u/proj')
})

test('1. not blocked, or blocked for something else: no approval at all', () => {
  for (const status of [{ ...blocked, state: 'working' }, { ...blocked, state: 'idle' }, { ...blocked, kind: 'question' }, { ...blocked, kind: null }]) {
    assert.equal(approvalState(facts({ status })), null, JSON.stringify(status))
  }
})

test('2. a dialog printed mid-screen, or none recognized, gets no buttons', () => {
  const fake = `${dialog}⏺ Output printed after a fake dialog\n`
  assert.deepEqual(approvalState(facts({ screen: fake })).choices, [])
  assert.equal(approvalState(facts({ screen: fake })).why, 'answer-in-terminal')
  assert.deepEqual(approvalState(facts({ screen: idle })).choices, [])
})

test('2. Codex and omp, which asked for nothing when recorded, get no buttons even blocked', () => {
  for (const agent of ['codex', 'omp', 'gemini', null]) {
    const s = approvalState(facts({ agent }))
    assert.deepEqual([s.choices, s.why], [[], 'answer-in-terminal'], String(agent))
  }
})

test('3. no open call, or two with the dialog tool, get no buttons', () => {
  assert.equal(approvalState(facts({ openCalls: [] })).why, 'no-open-call')
  assert.equal(approvalState(facts({ openCalls: [{ ...call, tool: 'Read' }] })).why, 'no-open-call')
  assert.equal(approvalState(facts({ openCalls: [call, { ...call, id: '1:5.0' }] })).why, 'several-open-calls')
  for (const why of ['no-open-call', 'several-open-calls']) {
    const s = approvalState(facts({ openCalls: why === 'no-open-call' ? [] : [call, { ...call, id: 'x' }] }))
    assert.deepEqual(approvalRow(s, { turn: 3 }).choices, [])
    assert.equal(approvalRow(s, { turn: 3 }).input, '', 'no input without the one call')
  }
})

test('3. the open call names another command than the dialog: no buttons', () => {
  const other = { ...call, input: { command: 'rm -rf /home/u/proj' } }
  assert.equal(approvalState(facts({ openCalls: [other] })).why, 'command-mismatch')
  // A call with no command field (another tool's input) is matched by tool alone.
  assert.equal(approvalState(facts({ openCalls: [{ ...call, input: { path: 'x' } }] })).why, null)
})

test('3. the status names another tool than the dialog: no buttons', () => {
  assert.equal(approvalState(facts({ status: { ...blocked, msg: 'approve Edit: x' } })).why, 'tool-mismatch')
})

function answering({ afterKeys = 'idle' } = {}) {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1', { state: 'blocked', kind: 'permission' })], screens: { t1: dialog } })
  hc.set('t1', { status: { app: 'claude-code', ...blocked }, turn: blocked.turn })
  hc.onWrite((m) => { if (m === 'terminal.keys' && afterKeys) hc.set('t1', { status: { app: 'claude-code', state: afterKeys } }) })
  let current = facts()
  const read = async () => current
  const keys = () => hc.calls.filter((c) => c.method === 'terminal.keys')
  return { hc, read, keys, change: (over) => { current = facts(over) } }
}

test('allow presses 1 and deny presses esc, with no caller; the dialog going is seen', async () => {
  for (const [choice, want] of [['allow', ['1']], ['deny', ['esc']]]) {
    const a = answering()
    assert.deepEqual(await answerApproval({ hc: a.hc, address: 't1', rowId: 'approval:1:4.1', choice, read: a.read }), { ok: true, pressed: 'done', sent: true })
    assert.deepEqual(a.keys().map((c) => c.params), [{ terminal: 't1', keys: want, caller: null }])
  }
})

test('a stale approval presses nothing: dialog changed, another call, closed, or a choice not offered', async () => {
  const cases = [
    ['changed', { screen: dialog.replaceAll('ls -la /home/u/proj', 'cat /home/u/.ssh/id_ed25519') }],
    ['changed', { openCalls: [{ ...call, id: '1:9.0' }] }],
    ['changed', { screen: `${dialog}⏺ printed after\n` }],
    ['closed', { status: { ...blocked, state: 'working' } }]
  ]
  for (const [reason, over] of cases) {
    const a = answering()
    a.change(over)
    assert.deepEqual(await answerApproval({ hc: a.hc, address: 't1', rowId: 'approval:1:4.1', choice: 'allow', read: a.read }), { ok: false, reason }, JSON.stringify(over).slice(0, 60))
    assert.equal(a.keys().length, 0, 'nothing pressed')
  }
  const a = answering()
  assert.deepEqual(await answerApproval({ hc: a.hc, address: 't1', rowId: 'approval:1:4.1', choice: 'allow-always', read: a.read }), { ok: false, reason: 'choice' })
  assert.equal(a.keys().length, 0)
})

test('a key herdr-core has not typed yet is reported as uncertain, not as done', async () => {
  const a = answering({ afterKeys: null })
  const fast = { setTimeout: (fn) => setImmediate(fn) }
  assert.deepEqual(await answerApproval({ hc: a.hc, address: 't1', rowId: 'approval:1:4.1', choice: 'deny', read: a.read, timers: fast, verifyMs: 30 }), { ok: true, pressed: 'uncertain', sent: true })
  assert.equal(a.keys().length, 1, 'pressed once, never again')
})

test('herdr-core typed the key at another status or turn: uncertain, never done', async () => {
  for (const at of [{ status: { app: 'claude-code', state: 'working' }, turn: blocked.turn }, { status: { app: 'claude-code', ...blocked }, turn: blocked.turn + 1 }]) {
    const a = answering()
    a.hc.set('t1', at) // what herdr-core saw when it typed; our read was before
    assert.deepEqual(await answerApproval({ hc: a.hc, address: 't1', rowId: 'approval:1:4.1', choice: 'allow', read: a.read }), { ok: true, pressed: 'uncertain', sent: true })
    assert.equal(a.keys().length, 1)
  }
})
