// #2056 (RFC 0048, delivery 1.5): the Review guard in Details (the person's switch, sent on its own,
// with how far it holds on the Bot's route) and the one upgrade line in a migrated Solver's chat.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: [
    "export { ReviewGuardRow } from './src/client/details-drawer.js'",
    "export { upgradeNoticeOf, noticeAfterTurn, noticeBeforeTurn } from './src/client/cells.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/..' },
  bundle: true, platform: 'browser', logLevel: 'silent',
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false,
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { querySelector: () => null, documentElement: { addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout, clearTimeout,
  require: name => (name === 'react' ? { createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'fragment' }
    : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: (_, key) => key })),
})
const { ReviewGuardRow, upgradeNoticeOf, noticeAfterTurn, noticeBeforeTurn } = module.exports

const roster = { byId: { rev: { id: 'rev', name: 'Ada reviewer' } }, permissions: { defaultPreset: 'workspace-write' } }
const updates = []
const render = (bot, extra = {}) => ReviewGuardRow({
  bot: { id: 's1', name: 'Sol', role: 'Solver', reviewerId: 'rev', model: 'deepseek/chat', ...bot }, roster: { ...roster, ...extra },
  actions: { updateBot: (id, patch) => { updates.push([id, { ...patch }]) } }, run: value => value,
})
const switchOf = row => row?.children?.[0]?.props

test('the row: shown with a reviewer id, the guard on, or the marker; its line follows the route; toggling sends it alone', () => {
  const on = switchOf(render({ reviewGuard: true }))
  assert.equal(on.label, 'Review guard')
  assert.equal(on.details, true)
  assert.equal(on.on, true)
  assert.equal(on.disabled, false)
  assert.equal(on.hint, "Work waits for Ada reviewer's verdict on the plan: file changes, commands and messages to other Bots are refused until it answers.")
  on.onChange(false)
  assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1))), ['s1', { reviewGuard: false }])
  const off = switchOf(render({}))
  assert.equal(off.on, false)
  off.onChange(true)
  assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1))), ['s1', { reviewGuard: true }])
  // The best-effort route (r1.6 K5), and the routes where it holds nothing (K6, K7).
  const claude = { model: 'acp-claude/default', nativeTools: true, nativeToolsAgent: 'acp-claude', reviewGuard: true }
  assert.equal(switchOf(render(claude)).hint, 'Held only for the steps Claude Code asks about. Its own allow rules, hooks and saved approvals can let a step run before the guard sees it, and that step may still show as refused.')
  assert.equal(switchOf(render({ ...claude, permission: 'danger-full-access' }, { permissions: { defaultPreset: 'workspace-write', options: [] } })).hint.startsWith('Not held at this level'), true)
  assert.equal(switchOf(render({ model: 'acp-codex/x', nativeTools: true, nativeToolsAgent: 'acp-codex', reviewGuard: true })).hint.startsWith('Not held on this agent'), true)
  // A plain Bot has no row.
  assert.equal(render({ role: 'Helper', reviewerId: undefined }), null)
})

test('a Solver with no reviewer Bot shows the row off and disabled with the reason; a gone reviewer with the guard on can be turned off', () => {
  for (const bot of [{ reviewerId: undefined }, { reviewerId: 'gone' }]) {
    const row = switchOf(render(bot))
    assert.equal(row.on, false)
    assert.equal(row.disabled, true)
    assert.equal(row.hint, 'Off: Sol has no reviewer Bot on the team, so there is no verdict to wait for.')
  }
  const gone = switchOf(render({ reviewerId: 'gone', reviewGuard: true }))
  assert.equal(gone.on, true)
  assert.equal(gone.disabled, false)
  assert.equal(gone.hint, 'Its reviewer is no longer on the team: work stays held until you turn this off.')
  // A migrated Solver waiting for its verdict says since when (K13).
  const waiting = switchOf(render({ reviewGuard: true, reviewGuardWaitingSince: Date.now() }))
  assert.match(waiting.hint, /Waiting for Ada reviewer's verdict on the plan since .+\.$/)
})

test('the upgrade line: only in the part it names, after the last turn ended at or before it, once', () => {
  const at = 1_000
  const bots = [{ id: 's1', name: 'Sol', reviewGuardNotice: { at, sessionId: 'chat-s1' } }, { id: 'p', name: 'Plain' }]
  // The bundle runs in its own realm: compare plain values.
  assert.deepEqual(JSON.parse(JSON.stringify(upgradeNoticeOf({ bots }, 'chat-s1'))), { at, name: 'Sol' })
  // A New conversation after the upgrade, another Bot's chat, and a malformed value draw nothing.
  assert.equal(upgradeNoticeOf({ bots }, 'chat-s1-part2'), undefined)
  assert.equal(upgradeNoticeOf({ bots }, 'p'), undefined)
  for (const notice of ['1000', { at: '1000', sessionId: 'chat-s1' }, { at, sessionId: 7 }, { at: Number.NaN, sessionId: 'chat-s1' }, null]) {
    assert.equal(upgradeNoticeOf({ bots: [{ id: 's1', name: 'Sol', reviewGuardNotice: notice }] }, 'chat-s1'), undefined, JSON.stringify(notice))
  }
  // Turns end at 400 and 900, the next starts at 1500: the line goes after the second turn only.
  const turns = [{ end: 400, next: 600 }, { end: 900, next: 1500 }, { end: 1800, next: undefined }]
  assert.deepEqual(turns.map(turn => noticeAfterTurn(at, turn.end, turn.next)), [false, true, false])
  // The last loaded turn ended before it, with nothing after: the line is last.
  assert.equal(noticeAfterTurn(at, 900, undefined), true)
  // Every turn of the part began after it: above the first turn only.
  assert.equal(noticeBeforeTurn(at, true, 1200), true)
  assert.equal(noticeBeforeTurn(at, false, 1200), false)
  assert.equal(noticeBeforeTurn(at, true, 900), false)
})
