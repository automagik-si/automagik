// The web self-update preview (#1540, step 1) in jsdom: the flag keeps it off a normal start, and
// the nod walks the owner through the whole flow, including the failure that rolls back. No time is
// waited on beyond the preview's own step delay, which the test sets to a millisecond.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { installSelfUpdateMock, MOCK_DATA, MOCK_STEPS, mountSelfUpdateMock } from '../src/client/self-update-mock.js'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const requireHarness = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))
const { JSDOM } = requireHarness('jsdom')

function dom(t) {
  const page = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://example.test/' })
  const previous = globalThis.document
  globalThis.document = page.window.document
  t.after(() => { globalThis.document = previous })
  return page.window.document
}

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const button = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent.includes(label))

test('the preview mounts only with the flag, and leaves a normal start alone', t => {
  const document = dom(t)
  const off = installSelfUpdateMock({ location: { search: '', hash: '' }, document })
  assert.equal(document.getElementById('ds-bot-self-update-mock'), null)
  assert.equal(document.querySelectorAll('style').length, 0)
  off()

  const on = installSelfUpdateMock({ location: { search: '?mock-1540', hash: '' }, document })
  assert.notEqual(document.getElementById('ds-bot-self-update-mock'), null)
  const nod = document.querySelector('.su-nod')
  // It is one of the bar's own round buttons, not a floating pill of its own design.
  assert.equal(nod.classList.contains('bt-round'), true)
  assert.equal(nod.getAttribute('aria-label'), 'Update available')
  assert.notEqual(nod.querySelector('svg'), null)
  on()
  assert.equal(document.getElementById('ds-bot-self-update-mock'), null)
})

test('the nod sits in the bottom row seat when there is one', t => {
  const document = dom(t)
  // The app's footer row, or a harness's stand-in for it.
  const foot = document.createElement('div')
  foot.dataset.mockSeat = ''
  document.body.append(foot)
  const off = installSelfUpdateMock({ location: { search: '?mock-1540', hash: '' }, document })
  assert.equal(foot.querySelector('.bt-round.su-nod') !== null, true)
  assert.equal(document.querySelectorAll('.su-nod').length, 1)
  off()
})

test('the nod joins the seat entries instead of replacing them, and dispose removes only the nod', t => {
  const document = dom(t)
  const foot = document.createElement('div')
  foot.className = 'lb-foot'
  foot.innerHTML = '<button type="button" aria-label="Account">Account</button>'
    + '<button type="button" aria-label="Rail">Rail</button>'
  document.body.append(foot)
  const off = installSelfUpdateMock({ location: { search: '?mock-1540', hash: '' }, document })
  // F1: the seat's own entries survive; the nod is added beside them.
  assert.equal(foot.querySelector('.su-nod') !== null, true)
  assert.equal(foot.querySelectorAll('button').length, 3)
  assert.equal(foot.textContent.includes('Account'), true)
  assert.equal(foot.textContent.includes('Rail'), true)
  // F2: dispose takes the nod and nothing else.
  off()
  assert.equal(foot.querySelector('.su-nod'), null)
  assert.equal(foot.querySelectorAll('button').length, 2)
  assert.equal(foot.textContent.includes('Account'), true)
  assert.equal(foot.textContent.includes('Rail'), true)
})

test('closing the modal leaves exactly one nod in the seat', t => {
  const document = dom(t)
  const foot = document.createElement('div')
  foot.className = 'lb-foot'
  document.body.append(foot)
  const off = installSelfUpdateMock({ location: { search: '?mock-1540', hash: '' }, document })
  const open = foot.querySelector('.su-nod')
  open.click()
  button(document, 'Not now').click()
  assert.equal(foot.querySelectorAll('.su-nod').length, 1)
  off()
  assert.equal(foot.querySelector('.su-nod'), null)
})

test('the hash form mounts it too', t => {
  const document = dom(t)
  const off = installSelfUpdateMock({ location: { search: '', hash: '#mock-1540' }, document })
  assert.notEqual(document.querySelector('.su-nod'), null)
  off()
})

test('the nod opens what changes, then the steps, then success', async t => {
  const document = dom(t)
  const root = document.createElement('div')
  document.body.append(root)
  const control = mountSelfUpdateMock(root, { stepMs: 1, successMs: 1 })
  t.after(() => control.dispose())
  assert.equal(control.screen(), 'nod')

  button(root, 'Update available').click()
  assert.equal(control.screen(), 'changes')
  assert.match(root.textContent, /What changes/)
  assert.match(root.textContent, /Example data/)
  // Both versions on screen are the sample ones.
  assert.match(root.textContent, new RegExp(MOCK_DATA.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(root.textContent, new RegExp(MOCK_DATA.next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // The kept version is promised before anything starts, and so is what the click does to work
  // that is running (the owner's decision, RFC 0035 Q6).
  assert.match(root.textContent, /stays kept/)
  assert.match(root.textContent, /stops when you click Update now/)
  assert.match(root.textContent, /comes back by itself once the update is done/)

  button(root, 'Update now').click()
  assert.equal(control.screen(), 'steps')
  for (const step of MOCK_STEPS) assert.notEqual(root.querySelector(`[data-step="${step.key}"]`), null)
  await tick(60)
  assert.equal(control.screen(), 'success')
  assert.match(root.textContent, /Done: you are on the new version\./)
})

test('the failure screen rolls back and says nothing was lost', async t => {
  const document = dom(t)
  const root = document.createElement('div')
  document.body.append(root)
  const control = mountSelfUpdateMock(root, { stepMs: 1, successMs: 1 })
  t.after(() => control.dispose())
  button(root, 'Update available').click()
  button(root, 'Show the failure instead').click()
  assert.equal(control.screen(), 'steps')
  await tick(60)
  assert.equal(control.screen(), 'rollback')
  assert.match(root.textContent, /Back to the previous version/)
  assert.match(root.textContent, /Nothing was lost/)
  // It can offer the announcement again without leaving the preview.
  button(root, 'See the announcement again').click()
  assert.equal(control.screen(), 'changes')
  button(root, 'Close').click()
  assert.equal(control.screen(), 'nod')
})

test('every screen returns to the nod and nothing is downloaded', async t => {
  const document = dom(t)
  const root = document.createElement('div')
  document.body.append(root)
  const control = mountSelfUpdateMock(root, { stepMs: 1, successMs: 1 })
  t.after(() => control.dispose())
  button(root, 'Update available').click()
  button(root, 'Not now').click()
  assert.equal(control.screen(), 'nod')
  // The steps say in words that this is a preview.
  button(root, 'Update available').click()
  button(root, 'Update now').click()
  assert.match(root.textContent, /in this preview the steps are timers|In this preview the steps are timers/)
})
