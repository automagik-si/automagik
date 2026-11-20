import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hardToUndo } from '../src/host/auto-judge.js'

test('Auto asks for Secret Service access and capture in command text and structured argv', () => {
  const commands = [
    ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.secrets'],
    ['busctl', '--user', 'call', 'org.freedesktop.secrets', '/org/freedesktop/secrets'],
    ['dbus-send', '--session', '--dest=:1.10', '/org/freedesktop/secrets/item', 'org.freedesktop.Secret.Item.GetSecret'],
    ['gdbus', 'call', '--method', 'org.freedesktop.Secret.Item.GetSecret'],
    ['dbus-monitor', '--session'],
    ['busctl', '--user', 'monitor'],
    ['/usr/bin/busctl', 'capture', '--user'],
    ['gdbus', 'monitor', '--session'],
    ['secret-tool', 'search', 'application', 'fixture'],
    ['python3', '-c', 'import secretstorage; print(secretstorage)'],
    ['python3.12', '-m', 'keyring', 'get', 'fixture', 'person'],
    ['keyring', 'get', 'fixture', 'person'],
  ]
  for (const command of commands) {
    assert.equal(hardToUndo({ tool: 'bash', args: { command } }), true, command[0] + ' argv')
    assert.equal(hardToUndo({ tool: 'bash', args: { command: command.map(word => "'" + word + "'").join(' ') } }), true, command[0] + ' text')
  }
  assert.equal(hardToUndo({ tool: 'terminal_send', args: { text: 'gdbus monitor --session' } }), true)
  for (const command of ['busctl --user list', 'gdbus call --dest org.freedesktop.portal.Desktop', 'echo secret-tool search',
    'python3 -c "print(1)"', 'dbus-send --dest=org.example.Other']) {
    assert.equal(hardToUndo({ tool: 'bash', args: { command } }), false)
  }
})
