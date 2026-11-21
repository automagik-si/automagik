import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automationFixture, automationHost } from './fixtures/automations-host.mjs'
import { renderDialog, until } from './fixtures/settings-dialog.mjs'

const NAME = 'Morning review'
const SECOND = 'Afternoon review'
const AT = '2099-06-01T09:00:00Z'
const run = { automation: NAME, status: 'skipped', trigger: 'cron', at: AT }
const LIST = 'automations-list'
const RUN = 'automations-run'
const PAUSE = 'automations-pause'
const ENTRY = 'automations-entry'
const PUT = 'automations-put'
const HISTORY = 'automations-history'

function setup(t, { seed = (entry, listing) => ({ ...listing, automations: [entry] }), readOnly, loginTextMatches, afterRequest } = {}) {
  const f = automationFixture(t)
  f.env.FAKE_AUTOMATIONS_SHAPE = 'am2'
  f.env.FAKE_AUTOMATIONS_VERSION = '0.12.1-am.2'
  const entry = {
    name: NAME, cron: '0 9 * * 1-5', repo: f.root, workspace: 'root', agent: 'codex', prompt: 'Summarize this folder.',
    timeout_minutes: 45, agent_args: ['--sandbox', 'read-only'], last: null, next: AT, line: 3, disabled: false,
  }
  f.write(seed(entry, f.read()))
  const host = automationHost(t, f, { readOnly, loginTextMatches })
  const page = renderDialog(t, afterRequest ? { request: async (endpoint, ...args) => {
    const response = await host.request(endpoint, ...args)
    afterRequest(f, endpoint)
    return response
  } } : host)
  page.click('Automations')
  return { f, page, entry }
}

const addReady = page => until(() => page.button('Add automation') && !page.button('Add automation').disabled, 'the automation list')
const clickReady = async (page, label) => {
  await until(() => page.button(label) && !page.button(label).disabled, label)
  page.click(label)
}

test('Run now reports the request separately from the scheduled history row', async t => {
  const { page } = setup(t, { seed: (entry, listing) => ({
    ...listing, automations: [entry], history: [], control: { runAppends: run },
  }) })
  await addReady(page)
  assert.deepEqual(page.calls, [LIST])
  page.click('Run Morning review now')
  await until(() => page.text().includes('Last run: Skipped · On schedule'), 'the re-listed last run')
  const notice = page.document.querySelector('.bt-settings-page [role=status]')
  assert.equal(notice.textContent, 'Run requested for Morning review.')
  assert.equal(notice.previousElementSibling.tagName, 'P')
  assert.doesNotMatch(page.text(), /Manual/)
  assert.deepEqual(page.calls, [LIST, RUN, LIST])
  await clickReady(page, 'History of Morning review')
  await until(() => !page.text().includes('Run requested for'), 'the notice clearing on the next action')
})

test('the run request notice survives a failed re-list', async t => {
  const { page } = setup(t, { afterRequest(f, endpoint) {
    if (endpoint === RUN) f.write({ ...f.read(), control: { ls: { exit: 5 } } })
  } })
  await addReady(page)
  page.click('Run Morning review now')
  await until(() => page.text().includes('The scheduler could not do this.'), 'the reload failure')
  assert.match(page.text(), /Run requested for Morning review\./)
  assert.deepEqual(page.calls, [LIST, RUN, LIST])
})

test('Pause and Resume use the row state returned by a fresh list', async t => {
  const { page } = setup(t)
  await addReady(page)
  page.click('Pause Morning review')
  await until(() => page.button('Resume Morning review'), 'resume button')
  assert.match(page.text(), /Disabled/)
  await clickReady(page, 'Resume Morning review')
  await until(() => page.button('Pause Morning review'), 'pause button')
  assert.doesNotMatch(page.text(), /Disabled/)
  assert.deepEqual(page.calls, [LIST, PAUSE, LIST, PAUSE, LIST])
})

for (const [action, endpoint, update, expected] of [
  ['Run Morning review now', RUN, entry => [{ ...entry, prompt: 'Changed outside the page.' }],
    'This automation changed. Review the list and try again.'],
  ['Pause Morning review', PAUSE, () => [], 'This automation is already gone.'],
]) {
  test(action + ' rejects an obsolete row and refreshes without a write', async t => {
    const { f, page, entry } = setup(t)
    await addReady(page)
    f.write({ ...f.read(), automations: update(entry) })
    page.click(action)
    await until(() => page.text().includes(expected), 'the stale-action message')
    assert.deepEqual(page.calls, [LIST, endpoint, LIST])
    assert.equal(f.calls().some(({ argv }) => ['run', 'pause', 'resume'].includes(argv[0])), false)
  })
}

test('Edit prefills the raw draft, locks the agent, and previews and saves only the changed cron', async t => {
  const prompt = 'Review\n' + 'x'.repeat(7993)
  const { f, page } = setup(t, { seed: (entry, listing) => ({
    ...listing, automations: [{ ...entry, prompt }, { ...entry, name: SECOND }], control: { checkEdit: ['cron', 'name'] },
  }) })
  await clickReady(page, 'Edit Morning review')
  await until(() => page.button('Preview'), 'the edit form')
  assert.equal(page.document.querySelector('form textarea').value === prompt, true)
  assert.equal(page.document.querySelector('form select').disabled, true)
  assert.equal(page.document.querySelector('form input[type=number]').value, '45')
  assert.match(page.text(), /Keeps its own agent arguments\./)
  assert.match(page.text(), /The agent can be changed in the Herdr panel\./)
  assert.equal(page.button('Add automation'), undefined)
  assert.equal(page.button('Edit Afternoon review'), undefined)
  const cron = '30 11 * * *'
  page.fill('Schedule (cron)', cron)
  const before = f.bytes()
  const previous = f.read().automations
  page.click('Preview')
  await until(() => page.text().includes('Next runs:'), 'the preview')
  assert.equal(f.bytes().equals(before), true)
  await clickReady(page, 'Save')
  await addReady(page)
  assert.equal(page.document.querySelector('form'), null)
  assert.equal(f.read().automations[0].cron, cron)
  assert.deepEqual(f.read().automations[0].agent_args, previous[0].agent_args)
  assert.equal(JSON.stringify(f.read().automations) === JSON.stringify([{ ...previous[0], cron }, previous[1]]), true)
  assert.deepEqual(page.calls, [LIST, ENTRY, PUT, PUT, LIST])
})

test('Cancel drops the draft, switching entry uses its own prompt, and unchanged Save closes the form', async t => {
  const { page, f } = setup(t, { seed: (entry, listing) => ({
    ...listing, automations: [entry, { ...entry, name: SECOND, prompt: 'Another prompt.' }],
  }) })
  await clickReady(page, 'Edit Morning review')
  await until(() => page.button('Cancel'), 'first draft')
  page.fill('Prompt', 'Unsaved draft.')
  page.click('Cancel')
  await clickReady(page, 'Edit Afternoon review')
  await until(() => page.button('Save'), 'second draft')
  assert.equal(page.document.querySelector('form textarea').value === 'Another prompt.', true)
  page.click('Save')
  await addReady(page)
  assert.equal(page.document.querySelector('form'), null)
  assert.equal(f.calls().some(({ argv }) => argv[0] === 'put'), false)
  assert.deepEqual(page.calls, [LIST, ENTRY, ENTRY, PUT, LIST])
})

for (const [event, expected] of [
  ['changed', 'This automation changed. Review the list and try again.'],
  ['gone', 'This automation is already gone.'],
  ['not-editable', 'This automation cannot be edited here. Use the Herdr panel.'],
]) {
  test('a ' + event + ' edit drops the draft and reloads the list', async t => {
    let loginTextMatches = false
    const { f, page, entry } = setup(t, { loginTextMatches: prompt => loginTextMatches && prompt === 'Summarize this folder.' })
    await clickReady(page, 'Edit Morning review')
    await until(() => page.button('Save'), 'the draft')
    if (event === 'changed') f.write({ ...f.read(), automations: [{ ...entry, prompt: 'Externally changed.' }] })
    if (event === 'gone') f.write({ ...f.read(), automations: [] })
    if (event === 'not-editable') {
      page.fill('Prompt', 'Use a new prompt.')
      loginTextMatches = true
    }
    page.click('Save')
    await addReady(page)
    assert.ok(page.text().includes(expected))
    assert.equal(page.document.querySelector('form'), null)
    assert.deepEqual(page.calls, [LIST, ENTRY, PUT, LIST])
  })
}

test('History opens on demand, displays summary fields, and fetches again after closing', async t => {
  const stamp = new Date('2099-06-01T08:58:55Z').toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })
  const { f, page } = setup(t, { seed: (entry, listing) => ({
    ...listing, automations: [entry], history: [{
      ...run, status: 'failed', trigger: 'catchup', started: '2099-06-01T08:58:55Z', seconds: 65, exit_code: 2,
    }],
  }) })
  await clickReady(page, 'History of Morning review')
  assert.equal(page.button('History of Morning review').getAttribute('aria-expanded'), 'true')
  assert.match(page.text(), /Loading…/)
  await until(() => page.text().includes('Failed · Catch-up · ' + stamp + ' · 1m 5s · Exit code 2'), 'the history row')
  await clickReady(page, 'History of Morning review')
  assert.equal(page.button('History of Morning review').getAttribute('aria-expanded'), 'false')
  assert.deepEqual(page.calls, [LIST, HISTORY])
  f.write({ ...f.read(), history: [] })
  await clickReady(page, 'History of Morning review')
  await until(() => page.text().includes('No runs yet.'), 'empty history')
  await clickReady(page, 'History of Morning review')
  f.write({ ...f.read(), control: { history: { exit: 5 } } })
  await clickReady(page, 'History of Morning review')
  await until(() => page.text().includes('The scheduler could not do this.'), 'failed history read')
  assert.deepEqual(page.calls, [LIST, HISTORY, HISTORY, HISTORY])
})

for (const unnamed of [false, true]) {
  test('row capabilities respect ' + (unnamed ? 'unnamed diagnostics' : 'unsupported kinds and duplicate names'), async t => {
    const { page } = setup(t, { seed: (entry, listing) => ({
      ...listing, automations: [
        entry, { ...entry, name: 'Template', template: 'sample' }, { ...entry, name: 'Command', command: { argv: ['sample'] } },
        { ...entry, name: 'Target', target: 'worker:sample' }, { ...entry, name: 'Duplicate' },
      ], invalid: unnamed ? [{ name: 'Duplicate' }, { name: '' }] : [{ name: 'Duplicate' }],
    }) })
    await addReady(page)
    for (const label of ['Template', 'Command', 'Target', NAME]) {
      assert.equal(Boolean(page.button('Edit ' + label)), label === NAME && !unnamed)
      assert.equal(Boolean(page.button('Pause ' + label)), !unnamed)
      assert.ok(page.button('Run ' + label + ' now'))
    }
    for (const [before, after] of [['Run ', ' now'], ['Pause ', ''], ['Edit ', ''], ['History of ', '']]) {
      assert.equal(page.button(before + 'Duplicate' + after), undefined)
    }
  })
}

test('read-only mutations report the host gate', async t => {
  const { page } = setup(t, { readOnly: 'read only' })
  await clickReady(page, 'Run Morning review now')
  await until(() => page.text().includes('This host can only read automations.'), 'the read-only notice')
  assert.deepEqual(page.calls, [LIST, RUN])
})
