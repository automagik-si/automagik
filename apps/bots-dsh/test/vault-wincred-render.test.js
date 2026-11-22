import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderVaultSettings, text, visit } from './fixtures/vault-settings-render.mjs'
import { mount, name, provider } from './fixtures/wincred-host.mjs'

const roster = { byId: {}, bots: [], secrets: [], secretSourcesPresent: true, secretSources: { rows: [] } }
const asClient = h => async (endpoint, body) => {
  const answer = await h.call(endpoint, body)
  if (!answer.ok) throw new Error(answer.error.message)
  return answer.value
}
const reason = 'The Windows credential reader could not start here (for example Constrained Language Mode, AppLocker or antivirus).'

test('Settings can retry a blocked probe, Find and Save, then the private card shows only the bound target', async t => {
  const h = await mount(t, { mapping: false })
  const call = asClient(h)
  const errors = []
  const view = renderVaultSettings({ roster, call, run: promise => promise.catch(error => { errors.push(error.message) }) })
  await view.ready()
  view.fill('Vault provider', provider)
  await view.ready()
  h.setProbeExit(14)
  assert.equal(visit(view.render(), node => node.type === 'input' && node.props.type === 'password').length, 0)
  await view.button('Unlock').props.onClick()
  await view.ready()
  assert.ok(text(view.render()).includes(reason))
  assert.deepEqual(errors, [reason])
  for (let i = 0; i < 3; i++) await view.poll()
  assert.deepEqual(h.operations, ['probe'])
  h.setProbeExit(0)
  await view.button('Retry').props.onClick()
  await view.ready()
  view.button('Add a vault key').props.onClick()
  view.fill('Key name', name)
  view.fill('Target', 'abc')
  assert.equal(view.button('Find').props.disabled, true)
  view.fill('Target', h.item)
  assert.equal(view.input('Target').props.value === h.item, true)
  assert.equal(view.button('Save key').props.disabled, true)
  await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(text(view.render()).includes(h.user), true, 'user name is shown during Find')
  await view.button('Save key').props.onClick()
  assert.deepEqual(h.operations, ['probe', 'probe', 'meta'])
  assert.match(await h.ask(), /card asking the user/)
  const request = h.card()
  const card = renderVaultSettings({
    roster, call,
    card: { request, sessionId: request.sessionId, inline: true, bot: { id: request.sessionId, name: 'Fixture' } },
  })
  await card.ready()
  assert.ok(text(card.render()).includes('Provider: Windows Credential Manager'))
  assert.equal(text(card.input('Target')) === h.item, true)
  assert.equal(text(card.render()).includes(h.user), false)
  assert.equal(card.button('Allow').props.disabled, false)
})

test('Linux Settings lists the provider without Unlock, and remote Settings cannot open its gate', async t => {
  const h = await mount(t, { mapping: false, platform: 'linux' })
  const view = renderVaultSettings({ roster, call: asClient(h) })
  await view.ready()
  view.fill('Vault provider', provider)
  await view.ready()
  assert.ok(text(view.render()).includes('Windows Credential Manager needs Windows.'))
  assert.ok(text(view.render()).includes('Unavailable'))
  assert.equal(view.button('Unlock'), undefined)
  assert.equal(view.button('Retry'), undefined)
  assert.deepEqual(h.operations, [])

  const win = await mount(t, { mapping: false })
  const remote = renderVaultSettings({ roster, call: asClient(win), hostname: 'fixture.invalid' })
  await remote.ready()
  remote.fill('Vault provider', provider)
  await remote.ready()
  assert.ok(text(remote.render()).includes('Unlock the vault in Settings on this computer.'))
  assert.equal(remote.button('Unlock'), undefined)
  assert.deepEqual(win.operations, [])
})
