import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hardToUndo } from '../src/host/auto-judge.js'

test('Auto asks before Vault reads, listing and token commands under executable paths and wrappers', () => {
  for (const command of [
    'vault token lookup', 'vault token create', 'vault kv list', 'vault list', 'vault print token',
    '/usr/bin/vault read', '/opt/vault/bin/vault kv get', 'sudo /usr/bin/vault token lookup',
    '"/opt/Command Line Tools/vault" kv list', '"C:\\Tools\\vault.exe" print token',
    ['C:\\Program Files\\HashiCorp\\vault.exe', 'token', 'create'], "bash -c 'vault list'",
  ]) assert.equal(hardToUndo({ tool: 'bash', args: { command } }), true, JSON.stringify(command))
  assert.equal(hardToUndo({ tool: 'terminal_send', args: { text: 'vault token lookup', submit: true } }), true)
  for (const command of ['vault version', '/usr/bin/vault status', 'vault token help', 'echo vault list']) {
    assert.equal(hardToUndo({ tool: 'bash', args: { command } }), false, command)
  }
})

test('Auto recognizes Vault token-file reads in commands and file tools', () => {
  for (const args of [{ command: 'cat ~/.vault-token' }, { command: 'Get-Content $HOME\\.vault-token' }]) {
    assert.equal(hardToUndo({ tool: 'bash', args }), true)
  }
  assert.equal(hardToUndo({ tool: 'read', args: { path: '/home/fixture/.vault-token' } }), true)
  assert.equal(hardToUndo({ tool: 'read', args: { path: '.vault-token.example' } }), false)
})
