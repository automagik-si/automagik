import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hardToUndo } from '../src/host/auto-judge.js'

const ask = command => hardToUndo({ tool: 'bash', args: { command } })

test('Auto asks before recognized security reads and ambiguous invocations, including argv', () => {
  for (const command of [
    'security', 'security -qv', 'security --', 'security -i', 'security -qpi fixture help', 'security -lRvi help',
    'security -qv -- find-g -ag', '/usr/bin/security -lR find-internet-password -qw',
    'sudo /usr/bin/security find-generic-password -gsfixture.example',
    'security dump-keychain -adi', 'security du -d', 'security dump-keychain',
    'security ex', 'security export', 'security unknown-command', 'security --unknown find-identity',
    'security list-keychains -s fixture', "bash -c 'security ex'",
    ['/path with spaces/security', '-q', '--', 'find-i', '-w'],
    ['security', '--', 'find-g', '-g'], ['security', '-pl', 'prompt', 'help'],
  ]) assert.equal(ask(command), true, JSON.stringify(command))
  assert.equal(hardToUndo({ tool: 'terminal_send', args: { text: 'security find-g -w' } }), true)
})

test('Auto recognizes known metadata-only security spellings in string and argv forms', () => {
  for (const command of [
    'security find-generic-password -s service', 'security -- find-g -s fixture -a account',
    'security -qvlR find-internet-password -a fixture', 'security list-keychains -d user',
    'security default-keychain -d user', 'security login-keychain', 'security show-keychain-info fixture',
    'security find-certificate', 'security find-identity', 'security verify-cert -c certificate', 'security help',
    ['/path with spaces/security', '--', 'find-generic-password', '-s', 'fixture pair'],
    ['security', '-q', 'find-internet-password', '-a', 'fixture'], 'echo security export',
  ]) assert.equal(ask(command), false, JSON.stringify(command))
})
