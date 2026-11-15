import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/approval-notices.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
})

// One window: the platform's Notification, whether the page shows, and the work source.
function windowWith({ permission = 'granted', visibility = 'visible' } = {}) {
  const shown = []
  const opened = []
  function Notification(title, options) {
    const note = { title, ...options, closed: false, close() { note.closed = true } }
    shown.push(note)
    return note
  }
  Notification.permission = permission
  const listeners = new Set()
  let snapshot = { bots: {}, approvals: [] }
  const work = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next) => { snapshot = next; for (const listener of listeners) listener() },
  }
  const roster = { getSnapshot: () => ({ byId: { b: { id: 'b', name: 'Writer' } }, roomsById: { r1: { id: 'r1', name: 'Ops' } } }) }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, Notification,
    document: { visibilityState: visibility },
    window: { focus() {} },
  })
  return { ...module.exports, shown, opened, work, roster, openSession: id => opened.push(id) }
}

test('an approval that starts waiting while another conversation shows gets one notification', () => {
  const page = windowWith()
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'a', openSession: page.openSession, since: 100 })
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', sessionId: 'gb', tool: 'pwsh', at: 200 }] })
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', sessionId: 'gb', tool: 'pwsh', at: 200 }] })
  assert.deepEqual(page.shown.map(note => [note.title, note.body, note.tag]), [['Writer is waiting for your approval', 'Ops · pwsh', 'omni-ui-approval-x1']])
  page.shown[0].onclick()
  assert.deepEqual([page.opened, page.shown[0].closed], [['r1'], true])
})

test('no notification for the conversation on screen, for approvals older than the window, or without permission', () => {
  const onScreen = windowWith()
  onScreen.noticeApprovals({ work: onScreen.work, roster: onScreen.roster, shownSession: () => 'r1', openSession: onScreen.openSession, since: 100 })
  onScreen.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }, { id: 'x2', botId: 'b', sessionId: 'b', tool: 'pwsh', at: 50 }] })
  assert.equal(onScreen.shown.length, 0)

  const hidden = windowWith({ visibility: 'hidden' })
  hidden.noticeApprovals({ work: hidden.work, roster: hidden.roster, shownSession: () => 'r1', openSession: hidden.openSession, since: 100 })
  hidden.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }] })
  assert.equal(hidden.shown.length, 1)

  const denied = windowWith({ permission: 'default' })
  denied.noticeApprovals({ work: denied.work, roster: denied.roster, shownSession: () => 'a', openSession: denied.openSession, since: 100 })
  denied.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }] })
  assert.equal(denied.shown.length, 0)
})

test('a task\'s approval notification opens the task, where it is answered', () => {
  const page = windowWith()
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'a', openSession: page.openSession, since: 100 })
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', taskId: 't1', sessionId: 't1', tool: 'bash', at: 200 }] })
  assert.equal(page.shown.length, 1)
  page.shown[0].onclick()
  assert.deepEqual(page.opened, ['t1'])
})

const stopEntry = extra => ({ id: 'x', botId: 'b', sessionId: 'x', taskId: 'x', label: 'someone', at: 200, open: true, why: 'tool', tool: 'bash', count: 1, calls: [], ...extra })
test('one notice per stop entry, with its text, tag and place; closed and old entries stay quiet', () => {
  const page = windowWith()
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'elsewhere', openSession: page.openSession, since: 100 })
  page.work.set({ stops: [stopEntry()] })
  page.work.set({ stops: [stopEntry({ count: 2 })] })
  page.work.set({ stops: [stopEntry({ open: false })] })
  page.work.set({ stops: [stopEntry({ count: 3 }), stopEntry({ id: 'old', at: 50 }), stopEntry({ id: 'closed', open: false })] })
  assert.deepEqual(page.shown.map(note => [note.title, note.body, note.tag]), [['Writer stopped on a permission', 'someone · bash did not run: this Bot does not have that tool', 'omni-ui-stop-x']])
  page.shown[0].onclick()
  assert.deepEqual(page.opened, ['x'])
  assert.equal(page.shown[0].closed, true)
})

test('on-screen stops notify only when their place cannot draw them', () => {
  for (const [extra, shown, expected] of [
    [{ roomId: 'r1', inRound: true }, 'r1', 0],
    [{ roomId: 'r1' }, 'r1', 1],
    [{ sessionId: 'b', calls: [{ sessionId: 'b', callId: 'x' }] }, 'b', 0],
    [{ sessionId: 'b', child: true, calls: [{ sessionId: 'child', callId: 'x' }] }, 'b', 1],
    [{ sessionId: 'b', calls: [] }, 'b', 1],
  ]) {
    const page = windowWith()
    page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => shown, openSession: page.openSession, since: 100 })
    page.work.set({ stops: [stopEntry({ taskId: undefined, ...extra })] })
    assert.equal(page.shown.length, expected, JSON.stringify(extra))
    if (expected) {
      page.shown[0].onclick()
      assert.deepEqual(page.opened, [extra.roomId ?? 'b'])
    }
  }
  const page = windowWith({ permission: 'default' })
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'x', openSession: page.openSession, since: 100 })
  page.work.set({ stops: [stopEntry()] })
  assert.equal(page.shown.length, 0)
})

test('child asks notify away from the owner chat, with the subagent in the body', () => {
  for (const [shown, count] of [['ada-chat', 0], ['someone', 1]]) {
    const page = windowWith()
    page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => shown, openSession: page.openSession, since: 100 })
    page.work.set({ approvals: [{ id: 'x', child: true, botId: 'ada', sessionId: 'child', ownerSessionId: 'ada-chat', tool: 'bash', at: 200 }] })
    assert.equal(page.shown.length, count)
    if (count) {
      assert.equal(page.shown[0].body, 'A subagent wants to use bash')
      page.shown[0].onclick()
      assert.deepEqual(page.opened, ['ada'])
    }
  }
})

test('D client: a refusal-ladder notification asks whether to keep working', () => {
  const page = windowWith()
  page.noticeApprovals({ work: page.work, roster: page.roster, shownSession: () => 'ada', openSession: page.openSession, since: 100 })
  page.work.set({ approvals: [{ id: 'x', botId: 'ada', sessionId: 'someone', tool: 'keep_working', at: 200 }] })
  assert.equal(page.shown[0].body, 'Let it keep working?')
})

test('task notifications include the roster title and bounded command detail', () => {
  const page = windowWith()
  const roster = { getSnapshot: () => ({ ...page.roster.getSnapshot(), tasks: { t1: { title: 'Check API' } } }) }
  page.noticeApprovals({ work: page.work, roster, shownSession: () => 'elsewhere', openSession: page.openSession, since: 100 })
  page.work.set({ approvals: [{ id: 'detail', botId: 'b', taskId: 't1', label: 'Old title', sessionId: 't1', tool: 'bash', detail: { code: 'x'.repeat(150) }, at: 200 }] })
  assert.equal(page.shown[0].body, `Check API · bash · ${'x'.repeat(120)}`)
  page.shown[0].onclick()
  assert.deepEqual(page.opened, ['t1'])
})
