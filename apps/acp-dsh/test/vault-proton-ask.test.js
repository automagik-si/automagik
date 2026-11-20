import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENTS } from '../src/host/agents.js'

test('Claude ACP session permissions ask for Proton Pass disclosure and token issuance or renewal', () => {
  const ask = AGENTS['acp-claude'].hardAsk().claudeCode.options.settings.permissions.ask
  const commands = ['item show', 'item totp', 'inject', 'export', 'item attachment', 'pat create', 'pat renew',
    'personal-access-token create', 'personal-access-token renew', 'agent create', 'agent renew', 'item list *--show-secrets']
  const shells = process.platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash']
  for (const shell of shells) {
    for (const command of commands) assert.ok(ask.includes(shell + '(pass-cli ' + command + '*)'), command)
    assert.equal(ask.includes(shell + '(pass-cli item list*)'), false)
  }
})
