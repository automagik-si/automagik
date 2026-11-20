import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { renderVaultSettings, text, visit } from './fixtures/vault-settings-render.mjs'

function fixture({ present = true, readOnly, hostname = 'localhost', protocol = 'http:', initial = 'locked' } = {}) {
  let state = initial
  let unlockFails = true
  let unlockCorrect = false
  const password = randomBytes(32).toString('hex')
  const calls = []
  const mapping = []
  const sample = { id: '00000000-0000-0000-0000-000000000001', name: 'Fixture item',
    fields: [{ selector: 'login.password', label: 'Password' }, { selector: 'field:sample', label: 'sample' }] }
  const roster = { byId: {}, bots: [], secretSourcesPresent: present, readOnly }
  const actions = {
    async vaultStatus() { return { present: true, state, connection: 'fixture-label' } },
    async vaultUnlock(value) {
      unlockCorrect = value === password
      if (unlockFails) throw new Error('fixture refused')
      state = 'unlocked'
    },
    async vaultLock() { calls.push('lock'); state = 'locked' },
    async vaultItems(search) { calls.push(search); return { items: [sample] } },
    async secretSourceSet(row) { mapping.push(row) },
  }
  const view = renderVaultSettings({ roster, actions, hostname, protocol,
    run: async promise => { try { await promise; return true } catch { return false } } })
  return { ...view, calls, mapping, sample,
    enterPassword: () => { view.input('Bitwarden master password').props.ref.current.value = password },
    passwordIsGone: () => view.input('Bitwarden master password').props.ref.current.value === '',
    unlockCorrect: () => unlockCorrect, allowUnlock: () => { unlockFails = false } }
}

test('only a present service shows the Vault section, and insecure or read-only pages cannot unlock', async () => {
  assert.equal(text(fixture({ present: false }).render()).includes('Vault'), false)
  const insecure = fixture({ hostname: 'fixture.example.test' })
  await insecure.ready()
  assert.equal(insecure.input('Bitwarden master password'), undefined)
  assert.equal(text(insecure.render()).includes('Unlock the vault in Settings on this computer.'), true)
  // RFC 0034 Q10: an HTTPS page on another host (Pocket, remote) may not unlock either.
  const remote = fixture({ hostname: 'fixture.example.test', protocol: 'https:' })
  await remote.ready()
  assert.equal(remote.input('Bitwarden master password'), undefined)
  assert.equal(text(remote.render()).includes('Unlock the vault in Settings on this computer.'), true)
  const readOnly = fixture({ readOnly: 'fixture' })
  await readOnly.ready()
  assert.equal(readOnly.button('Unlock'), undefined)
  assert.equal(readOnly.button('Add a vault key'), undefined)
  const unsigned = fixture({ initial: 'unauthenticated' })
  await unsigned.ready()
  assert.equal(text(unsigned.render()).includes('Not signed in to Bitwarden CLI'), true)
})

test('unlock clears the uncontrolled password on failure and success, then lock hides the picker', async () => {
  const h = fixture()
  await h.ready()
  assert.equal(h.input('Bitwarden master password').props.value, undefined)
  h.enterPassword()
  await h.button('Unlock').props.onClick()
  await h.ready()
  assert.equal(h.unlockCorrect() && h.passwordIsGone(), true)
  h.enterPassword()
  const field = h.input('Bitwarden master password').props.ref.current
  h.allowUnlock()
  await h.button('Unlock').props.onClick()
  await h.ready()
  assert.equal(h.unlockCorrect() && field.value === '', true)
  assert.equal(text(h.render()).includes('Unlocked'), true)
  assert.ok(h.button('Add a vault key'))
  await h.button('Lock').props.onClick()
  await h.ready()
  assert.deepEqual(h.calls, ['lock'])
  assert.equal(h.button('Add a vault key'), undefined)
})

test('the picker uses the selected item id, exact selector, scope and host connection', async () => {
  const h = fixture({ initial: 'unlocked' })
  await h.ready()
  h.button('Add a vault key').props.onClick()
  h.fill('Key name', 'sample-key')
  h.fill('What it is for', 'Use the sample')
  h.fill('Search the vault', 'sample')
  const form = h.find(node => node.type === 'form')
  await form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(h.calls, ['sample'])
  assert.equal(text(h.render()).includes('Fixture item'), true)
  h.fill('Vault item', h.sample.id)
  h.fill('Vault field', 'field:sample')
  const chosen = visit(h.render(), node => node.type === 'input' && node.props.type === 'radio').at(-1)
  chosen.props.onChange()
  await h.button('Save key').props.onClick()
  assert.equal(JSON.stringify(h.mapping) === JSON.stringify([{
    name: 'SAMPLE_KEY', purpose: 'Use the sample', connection: 'fixture-label',
    item: h.sample.id, field: 'field:sample', scope: [],
  }]), true)
  assert.equal(text(h.render()).includes('Fixture item'), false)
})
