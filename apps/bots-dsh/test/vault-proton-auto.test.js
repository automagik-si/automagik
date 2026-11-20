import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hardToUndo } from '../src/host/auto-judge.js'

test('Auto asks before Proton Pass disclosure commands and token issuance or renewal', () => {
  const asks = [
    'item view', 'item show', 'item totp', 'inject', 'export', 'item attachment', 'pat create', 'pat renew',
    'personal-access-token create', 'personal-access-token renew', 'agent create', 'agent renew',
    'item list --output json --show-secrets', 'vault list --show-secrets',
  ]
  for (const verb of asks) {
    const command = '/usr/bin/pass-cli ' + verb
    assert.equal(hardToUndo({ tool: 'bash', args: { command } }), true, command)
  }
  assert.equal(hardToUndo({ tool: 'pwsh', args: { command: ['C:\\Program Files\\Proton\\pass-cli.exe', 'pat', 'create'] } }), true)
  assert.equal(hardToUndo({ tool: 'terminal_send', args: { text: 'pass-cli agent renew', submit: true } }), true)
  for (const command of ['pass-cli item list', 'pass-cli item list --output json', 'pass-cli pat list', 'echo pass-cli export']) {
    assert.equal(hardToUndo({ tool: 'bash', args: { command } }), false, command)
  }
})
