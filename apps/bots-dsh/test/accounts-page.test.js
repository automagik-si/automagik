import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { automationFixture, automationHost } from './fixtures/automations-host.mjs'
import { renderDialog, until } from './fixtures/settings-dialog.mjs'

const ENDPOINT = 'accounts-codex'
const OVERRIDE = 'AUTOMAGIK_ACCOUNTS_CODEX_HOME'
function setup(t, renderOptions, configure) {
  const f = automationFixture(t)
  delete f.env[OVERRIDE]
  const folder = join(f.root, '.codex')
  mkdirSync(folder)
  configure?.(join(folder, 'auth.json'), f)
  const host = automationHost(t, f)
  const page = renderDialog(t, host, renderOptions)
  return { page, f }
}
const noControls = page => assert.equal(page.document.querySelector('.bt-settings-page button'), null)

for (const actions of [{}, { providers() {} }]) {
  const neighbor = actions.providers ? 'Models' : 'General'
  test('Accounts sits just after ' + neighbor + ' without changing the Automations placement', async t => {
    const { page, f } = setup(t, { actions }, file => writeFileSync(file, JSON.stringify({
      tokens: { account_id: 'synthetic-settings-test', access_token: 'sample-token' },
      last_refresh: '2099-06-01T09:00:00Z',
    })))
    assert.equal(page.button(neighbor).nextElementSibling, page.button('Accounts'))
    assert.equal(page.button('Scheduled tasks').nextElementSibling, page.button('Automations'))
    assert.deepEqual(page.calls, [])
    page.click('Accounts')
    assert.equal(page.document.querySelector('h2').textContent, 'Accounts')
    assert.match(page.text(), /Loading…/)
    await until(() => /Account fingerprint: [0-9a-f]{8}/.test(page.text()), 'the Codex account')
    assert.equal(page.text().includes('Switching accounts stays in the Herdr Accounts panel.'), true)
    assert.equal(page.text().includes('Folder: ~/.codex'), true)
    assert.equal(page.text().includes('Last refreshed:'), true)
    assert.equal(page.text().includes('Account proxy: Unknown'), true)
    assert.equal(page.text().includes("The proxy's state needs its management key"), true)
    assert.equal(page.text().includes('synthetic-settings-test') || page.text().includes('sample-token'), false)
    noControls(page)
    assert.deepEqual(page.calls, [ENDPOINT])
    assert.deepEqual(f.calls(), [])
  })
}

for (const [name, configure, expected, extra] of [
  ['unknown account', file => writeFileSync(file, '{"last_refresh":"2099-88-01T09:00Z"}'),
    'Account unknown: the sign-in file names no account.'],
  ['absent file', (_file, f) => { f.env[OVERRIDE] = join(f.root, 'acceptance') },
    'No sign-in file in this folder.', 'Folder: ~/acceptance'],
  ['unreadable file', file => mkdirSync(file), 'Could not read the sign-in file.'],
]) {
  test('Accounts describes the ' + name, async t => {
    const { page } = setup(t, {}, configure)
    page.click('Accounts')
    await until(() => page.text().includes(expected), expected)
    if (extra) assert.ok(page.text().includes(extra))
    if (name === 'absent file') assert.match(page.text(), /system keyring/)
    assert.doesNotMatch(page.text(), /Signed in|Not signed in|Last refreshed:/)
    noControls(page)
    assert.deepEqual(page.calls, [ENDPOINT])
  })
}

test('Accounts shows its desktop-only state in an unmarked window', async t => {
  const { page } = setup(t, { marker: null })
  page.click('Accounts')
  await until(() => page.text().includes('Accounts show in the Automagik desktop app.'), 'desktop-only response')
  noControls(page)
  assert.deepEqual(page.calls, [ENDPOINT])
})

for (const [name, request] of [
  ['a host failure', async () => Response.json({ ok: true, value: { reason: 'failed' } })],
  ['a request failure', async () => { throw new Error('request failed') }],
]) {
  test('Accounts shows one fixed error for ' + name, async t => {
    const page = renderDialog(t, { request })
    page.click('Accounts')
    await until(() => page.text().includes("Could not read this computer's accounts."), 'accounts failure')
    noControls(page)
    assert.deepEqual(page.calls, [ENDPOINT])
  })
}
