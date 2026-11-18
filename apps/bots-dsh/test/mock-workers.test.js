// The native-subagents preview (#1564, step 1) in jsdom: the flag keeps it off a normal
// start, the sample data says so on screen, and a worker opens its own steps and result.
// Nothing here is a feature: the test pins that the preview only draws and that its controls
// never leave the surface.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { installWorkersMock, MOCK_WORKERS, mountWorkersMock } from '../src/client/mock-workers.js'

const PLUGIN = join(import.meta.dirname, '..')
const requireHarness = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))
const { JSDOM } = requireHarness('jsdom')

function dom(t) {
  const page = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://example.test/' })
  const previous = globalThis.document
  globalThis.document = page.window.document
  t.after(() => { globalThis.document = previous })
  return page.window.document
}

const button = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent.includes(label))
const thread = (root, id) => root.querySelector(`[data-worker="${id}"]`)

test('the preview mounts only with the flag, and leaves a normal start alone', t => {
  const document = dom(t)
  const off = installWorkersMock({ location: { search: '', hash: '' }, document })
  assert.equal(document.getElementById('ds-bot-mock-workers'), null)
  assert.equal(document.querySelectorAll('style').length, 0)
  off()

  const on = installWorkersMock({ location: { search: '?mock-workers', hash: '' }, document })
  assert.notEqual(document.getElementById('ds-bot-mock-workers'), null)
  assert.match(document.querySelector('.bt-mock-badge').textContent, /SAMPLE DATA/)
  // The preview is the Bot team's own row and threads, not a new surface.
  assert.notEqual(document.querySelector('.bt-mock-workers .bt-row'), null)
  assert.equal(document.querySelectorAll('.bt-mock-workers .bt-thread').length, MOCK_WORKERS.length)
  on()
  assert.equal(document.getElementById('ds-bot-mock-workers'), null)
  assert.equal(document.querySelectorAll('style').length, 0)
})

test('the hash form mounts it too', t => {
  const document = dom(t)
  const off = installWorkersMock({ location: { search: '', hash: '#mock-workers' }, document })
  assert.notEqual(document.querySelector('.bt-mock-workers'), null)
  off()
})

test('the three worker states and their result lines are on the rows', t => {
  const document = dom(t)
  const off = installWorkersMock({ location: { search: '?mock-workers', hash: '' }, document })
  t.after(() => off())
  const running = document.querySelector('.bt-thread[data-state=running]')
  const done = document.querySelector('.bt-thread[data-state=done]')
  const failed = document.querySelector('.bt-thread[data-state=failed]')
  assert.notEqual(running, null)
  assert.notEqual(done, null)
  assert.notEqual(failed, null)
  assert.notEqual(running.querySelector('.bt-thread-spin'), null)
  // A done or failed worker has a result line under its row, as a Bot's own row previews.
  const memory = thread(document, 'memory').closest('.bt-mock-worker')
  assert.match(memory.querySelector('.bt-row-preview').textContent, /2 files changed/)
  const approval = thread(document, 'approval').closest('.bt-mock-worker')
  assert.match(approval.querySelector('.bt-row-preview').textContent, /Bash exited 1/)
  // The sample marking is a sentence, not only a badge.
  assert.match(document.querySelector('.bt-mock-workers').textContent, /Sample data: nothing here is real\./)
})

test('opening a worker shows its steps and its result, and closing it goes back', t => {
  const document = dom(t)
  const off = installWorkersMock({ location: { search: '?mock-workers', hash: '' }, document })
  t.after(() => off())
  thread(document, 'adapter').click()
  const dialog = document.querySelector('.bt-mock-popover')
  assert.notEqual(dialog, null)
  assert.equal(dialog.getAttribute('role'), 'dialog')
  assert.match(dialog.textContent, /Review the adapter bundle/)
  assert.match(dialog.textContent, /Steps/)
  assert.match(dialog.textContent, /find the adapter version/)
  assert.match(dialog.textContent, /read the session update path/)
  assert.equal(dialog.querySelectorAll('.bt-mock-step').length, MOCK_WORKERS[0].steps.length)
  // A step is inert: clicking one keeps the popover where it is.
  dialog.querySelector('.bt-mock-step').click()
  assert.notEqual(document.querySelector('.bt-mock-popover'), null)
  button(dialog, 'Close').click()
  assert.equal(document.querySelector('.bt-mock-popover'), null)

  // A failed worker says who failed and where.
  thread(document, 'approval').click()
  const failed = document.querySelector('.bt-mock-popover')
  assert.match(failed.textContent, /Check the approval path/)
  assert.match(failed.textContent, /Bash exited 1/)
  assert.match(failed.textContent, /Bash · Failed/)
})

test('the preview closes without touching the flag or the page', t => {
  const document = dom(t)
  const root = document.createElement('div')
  document.body.append(root)
  const control = mountWorkersMock(root, { doc: document })
  t.after(() => control.dispose())
  assert.equal(control.screen(), 'workers')
  button(root, 'Close preview').click()
  assert.equal(root.querySelector('.bt-mock-workers').hidden, true)
  // No page outside the preview changed: the root is the only thing it drew.
  assert.equal(document.querySelectorAll('body > div').length, 1)
})
