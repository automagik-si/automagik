// Parity (RFC 0048, #2056 lead decision S-4): the New Solver dialog's native tick and a Bot's
// Details switch read one function, nativeSwitchView, so for the same Bot they always show the
// same thing, in both tick states.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: [
    "export { NativeToolsRow } from './src/client/details-drawer.js'",
    "export { antigravityNativeToolsCopy, nativeSwitchView, nativeToolsCopy, ompNativeToolsCopy } from './src/client/native-tools-copy.js'",
    "export { solverCandidate } from './src/client/solver-draft.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/..' },
  bundle: true, platform: 'browser', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: () => ({ createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children }) }),
})
const bundle = module.exports
const { NativeToolsRow, antigravityNativeToolsCopy, nativeToolsCopy, ompNativeToolsCopy, solverCandidate } = bundle
// The bundle runs in its own realm: its answers are cloned into this one before deep-equal.
const nativeSwitchView = (bot, roster) => structuredClone(bundle.nativeSwitchView(bot, roster))

const KEPT_TEXT = "This model can't turn its native tools off."
const UNKNOWN_TEXT = "Not available: the permission level of this Bot's chat could not be read."
const READ_ONLY_TEXT = 'Not available at the Read only level.'
// [label, ref, block (null: none; undefined: the ref is absent from the host map), roster extra]
const CASES = [
  ['Claude Code', 'acp-claude/default', null],
  ['Codex, a model the switch applies to', 'acp-codex/gpt-5.6', null],
  ['Codex, a kept model', 'acp-codex/gpt-5.6-kept', 'model-kept'],
  ['omp', 'acp-omp/default', null],
  ['omp at Read only', 'acp-omp/default', 'read-only'],
  ['Claude Code at Read only', 'acp-claude/default', 'read-only'],
  ['level unknown', 'acp-claude/default', 'level-unknown'],
  ['multi-user', 'acp-claude/default', 'multiuser'],
  ['multi-user in a team with no Bot', 'acp-claude/default', 'multiuser', { bots: [] }],
  ['Antigravity, an acp-dsh that offers its switch', 'acp-antigravity/default', null],
  ['Antigravity, an older acp-dsh', 'acp-antigravity/default', 'unoffered'],
  ['a DSH model', 'deepseek/deepseek-v4-flash', null],
  ['a read-only window', 'acp-claude/default', null, { readOnly: true }],
  ['a ref absent from the host map', 'acp-claude/opus', undefined],
]

// The host map as it travels: JSON, with null for "no block".
const rosterFor = (ref, block, extra = {}) => {
  const map = { 'acp-claude/other': null }
  if (block !== undefined) map[ref] = block
  return { bots: [{ id: 'x', model: 'acp-claude/default' }], nativeToolsNew: JSON.parse(JSON.stringify(map)), ...extra }
}
// The same Bot once made, in the same tick state; an absent ref reads as the host's level-unknown.
const botFor = (ref, block, ticked) => {
  const read = block === undefined ? 'level-unknown' : block
  return {
    id: 'solver', model: ref,
    ...(read ? { nativeToolsBlock: read } : {}),
    ...(ticked ? { nativeTools: true, nativeToolsAgent: ref.split('/')[0] } : {}),
  }
}
const rowProps = (bot, roster) => {
  const row = NativeToolsRow({ bot, roster, run: () => {}, actions: {} })
  return row === null ? null : { on: row.props.on, disabled: row.props.disabled, hint: row.props.hint }
}
const shown = view => (view === null ? null : { on: view.on, disabled: view.disabled, hint: view.hint.join(' ') })

test('the dialog tick and the Details switch show the same thing for the same Bot, ticked or not', () => {
  for (const [label, ref, block, extra] of CASES) {
    const roster = rosterFor(ref, block, extra)
    for (const ticked of [false, true]) {
      const bot = botFor(ref, block, ticked)
      const dialog = nativeSwitchView(solverCandidate(roster, ref, ticked), roster)
      assert.deepEqual(dialog, nativeSwitchView(bot, roster), `${label}, ticked ${ticked}`)
      assert.deepEqual(shown(dialog), rowProps(bot, roster), `${label}, ticked ${ticked}: rendered row`)
    }
  }
})

test('what the tick shows in each case', () => {
  const view = (ref, block, ticked = false, extra) => nativeSwitchView(solverCandidate(rosterFor(ref, block, extra), ref, ticked), rosterFor(ref, block, extra))
  // Offered, unticked, with the OFF text of its agent.
  assert.deepEqual(view('acp-claude/default', null), { mark: 'acp-claude', on: false, disabled: false, blocked: undefined, hint: [nativeToolsCopy.off] })
  assert.deepEqual(view('acp-claude/default', null, true).hint, [nativeToolsCopy.on])
  assert.deepEqual(view('acp-codex/gpt-5.6', null).hint, [nativeToolsCopy.codexOff])
  // omp unticked is chat only, and says so.
  assert.deepEqual(view('acp-omp/default', null).hint, [ompNativeToolsCopy.off])
  assert.deepEqual(view('acp-omp/default', 'read-only').hint, [READ_ONLY_TEXT, ompNativeToolsCopy.blocked])
  // Locked: a kept Codex model, Read only, a level that cannot be read, an absent ref.
  assert.deepEqual(view('acp-codex/gpt-5.6-kept', 'model-kept'), { mark: 'acp-codex', on: false, disabled: true, blocked: KEPT_TEXT, hint: [KEPT_TEXT] })
  assert.equal(view('acp-codex/gpt-5.6-kept', 'model-kept', true).on, false)
  assert.equal(view('acp-claude/default', 'read-only').disabled, true)
  assert.deepEqual(view('acp-claude/opus', undefined).hint, [UNKNOWN_TEXT])
  assert.equal(view('acp-claude/opus', undefined).disabled, true)
  // No tick at all: multi-user (even with no Bot), DSH models.
  assert.equal(view('acp-claude/default', 'multiuser'), null)
  assert.equal(view('acp-claude/default', 'multiuser', false, { bots: [] }), null)
  assert.equal(view('deepseek/deepseek-v4-flash', null), null)
  assert.equal(view('deepseek/deepseek-v4-flash', undefined), null)
  // With `nativeArgsAgents` lacking acp-antigravity (an older acp-dsh, the host's `unoffered`), no tick.
  assert.equal(view('acp-antigravity/default', 'unoffered'), null)
  // With an acp-dsh that offers it, Antigravity has the tick with its own copy, as omp: unticked
  // is chat only, and a lock says so.
  assert.deepEqual(view('acp-antigravity/default', null).hint, [antigravityNativeToolsCopy.off])
  assert.deepEqual(view('acp-antigravity/default', null, true).hint, [antigravityNativeToolsCopy.on])
  assert.deepEqual(view('acp-antigravity/default', 'read-only').hint, [READ_ONLY_TEXT, antigravityNativeToolsCopy.blocked])
  // A read-only window locks it as Details does.
  assert.equal(view('acp-claude/default', null, false, { readOnly: true }).disabled, true)
})

// #1564: Antigravity's lines under its switch come from the same view. A Bot not made yet has no
// host facts (agy version, hooks, plugins), so the dialog's candidate and the made Bot carry the
// same lines: the first-message line while not ON. The dialog shows the hint; Details shows the
// hint and these lines.
test('Antigravity: the dialog and Details read the same lines from the view, ticked or not', () => {
  const ref = 'acp-antigravity/default'
  for (const block of [null, 'read-only']) {
    const roster = rosterFor(ref, block)
    for (const ticked of [false, true]) {
      const bot = botFor(ref, block, ticked)
      const dialog = nativeSwitchView(solverCandidate(roster, ref, ticked), roster)
      const details = nativeSwitchView(bot, roster)
      const expected = details.on ? undefined : [{ key: antigravityNativeToolsCopy.firstTurn }]
      assert.deepEqual(dialog.notes, expected, `${block}, ticked ${ticked}`)
      assert.deepEqual(details.notes, expected, `${block}, ticked ${ticked}`)
      const row = NativeToolsRow({ bot, roster, run: () => {}, actions: {} })
      assert.deepEqual(row.props.notes === undefined ? undefined : [...row.props.notes], expected?.map(note => note.key))
    }
  }
  // No other agent carries lines.
  for (const ref of ['acp-claude/default', 'acp-codex/gpt-5.6', 'acp-omp/default']) {
    assert.equal(Object.hasOwn(nativeSwitchView(botFor(ref, null, false), rosterFor(ref, null)), 'notes'), false)
  }
})
