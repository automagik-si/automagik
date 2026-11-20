import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { apply } from '../index.js'
import { hardToUndo } from '../src/host/auto-judge.js'
import { dropUnlockVariables, isUnlockVariable, UNLOCK_ENV, UNLOCK_PREFIXES } from '../src/host/unlock-env.js'
import { fakeContext } from './fake-ctx.js'

const unlockNames = [
  'BW_SESSION', 'BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD', 'BWS_ACCESS_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_TOKEN', 'OP_SESSION', 'VAULT_TOKEN', 'VAULT_MFA',
  'VAULT_AUTH_GITHUB_TOKEN', 'PROTON_PASS_PERSONAL_ACCESS_TOKEN', 'PROTON_PASS_PASSWORD',
  'PROTON_PASS_TOTP', 'PROTON_PASS_EXTRA_PASSWORD', 'PROTON_PASS_EXTRA_PASSWORD_FILE',
  'PROTON_PASS_ENCRYPTION_KEY',
]
const marker = 'test-only-unlock-marker'

function setUnlockEnv(t, values) {
  const saved = Object.keys(process.env).filter(isUnlockVariable).map(name => [name, process.env[name]])
  t.after(() => {
    dropUnlockVariables()
    for (const [name, value] of saved) process.env[name] = value
  })
  Object.assign(process.env, values)
}

function teamFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-vault-hardening-'))
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (_format, line) => warnings.push(line)
  t.after(async () => {
    await ctx.provided.get('omniTeam')?.load()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, warnings, applyTeam: () => apply(ctx, { home, github: false, diagnosticsFile: false }) }
}

test('the unlock scrub removes only matching own keys, regardless of case', () => {
  assert.deepEqual([...UNLOCK_ENV].sort(), [...unlockNames].sort())
  assert.equal(Object.isFrozen(UNLOCK_ENV), true)
  assert.deepEqual(UNLOCK_PREFIXES, ['OP_SESSION_'])
  const removed = [...unlockNames, 'op_session_my_account', 'bw_session', 'Op_SeSsIoN_WORK']
  const kept = ['PATH', 'GH_TOKEN', 'OP_CONNECT_HOST', 'PROTON_PASS_SESSION_DIR', 'OP_SESSIONOTHER', 'MY_BW_SESSION']
  const env = Object.assign(Object.create({ OP_SESSION_inherited: marker }), Object.fromEntries([...removed, ...kept].map(name => [name, marker])))
  for (const name of removed) assert.equal(isUnlockVariable(name), true, name)
  for (const name of kept) assert.equal(isUnlockVariable(name), false, name)
  assert.equal(dropUnlockVariables(env), removed.length)
  assert.deepEqual(Object.keys(env), kept)
  assert.equal('OP_SESSION_inherited' in env, true)
  assert.equal(dropUnlockVariables(env), 0)
})

test('applying the Bot team scrubs the host and reports only the count', t => {
  const values = Object.fromEntries([...unlockNames, 'op_session_test'].map(name => [name, marker]))
  setUnlockEnv(t, values)
  const count = Object.keys(process.env).filter(isUnlockVariable).length
  const { applyTeam, warnings } = teamFixture(t)
  applyTeam()
  for (const name of Object.keys(values)) assert.equal(Object.hasOwn(process.env, name), false, name)
  assert.deepEqual(warnings.filter(line => line.startsWith('ds-bot: removed')), [
    'ds-bot: removed ' + count + ' password-manager unlock variable(s) from the Bot environment',
  ])
})

test('DSH subprocess and ACP spawn bases omit ambient unlock variables after apply', t => {
  setUnlockEnv(t, { BW_SESSION: marker, OP_SESSION_example: marker, VAULT_AUTH_GITHUB_TOKEN: marker })
  const { applyTeam } = teamFixture(t)
  applyTeam()
  for (const env of [scrubbedParentEnv(), { ...process.env }]) {
    assert.equal(Object.keys(env).some(isUnlockVariable), false)
    assert.equal(env.PATH, process.env.PATH)
  }
})

test('a real DSH bash child loses its inherited Bitwarden session when the team loads', async t => {
  if (process.platform === 'win32') return t.skip('the fake bw executable is a POSIX shell script')
  const { home, applyTeam } = teamFixture(t)
  setUnlockEnv(t, { BW_SESSION: marker })
  writeFileSync(join(home, 'bw'), [
    '#!/bin/sh',
    'session=0',
    '[ "${BW_SESSION+x}" = x ] && session=1',
    'argv_has_marker=0',
    'for arg do',
    '  case "$arg" in *' + marker + '*) argv_has_marker=1 ;; esac',
    'done',
    'printf "session=%s\\nargv-has-marker=%s\\n" "$session" "$argv_has_marker"',
    '',
  ].join('\n'), { mode: 0o700 })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { cwd: home })
  const probe = async () => {
    const spec = ctx.shell.resolve({
      command: 'bw get password item-1',
      env: { PATH: home + delimiter + process.env.PATH, BASH_ENV: '' },
    })
    const result = await (await ctx.shell.execute(spec)).result()
    assert.equal(result.exitCode, 0)
    return result.stdout.text
  }
  assert.equal(await probe() === 'session=1\nargv-has-marker=0\n', true, 'control sees the inherited session without a marker in argv')
  applyTeam()
  assert.equal(await probe() === 'session=0\nargv-has-marker=0\n', true, 'the Bot shell sees no session or argv marker')
})

test('password-manager reads ask through shell wrappers and argv commands', () => {
  for (const command of [
    'bw get password x', 'bw list items', 'bw export', 'bw unlock', 'bw serve',
    'bws secret get id', 'bws secret list', 'bws run -- env',
    'op read op://vault/item/field', 'op run -- env', 'op inject -i a.tpl', 'op item get x',
    'pass-cli item view pass://v/i/f', 'pass-cli item get pass://v/i/f', 'pass-cli item run -- env', 'pass-cli run -- env',
    'keepassxc-cli show db e', 'keepassxc-cli export db', 'secret-tool lookup a b',
    'vault kv get x', 'vault read x',
    '/usr/local/bin/bw get password x', 'C:\\tools\\bw.exe get password x', 'BW.CMD get password x',
    'bw --session x get password y', 'op --account a run -- env', 'bws --output json secret --color never get id',
    'op --unknown a inject -i a.tpl', 'op whoami --account run',
    'sudo bw get password x', "bash -c 'bw get password x'", 'echo $(bw get password x)',
    "pwsh -Command 'bw get password x'", "powershell.EXE -C 'cat .env'",
    ['bw', 'get', 'password', 'x'], ['C:\\Program Files\\Bitwarden CLI\\bw.exe', 'get', 'password', 'x'],
    ['pwsh.exe', '-NoProfile', '-cOmMaNd', 'git push origin main'],
  ]) assert.equal(hardToUndo({ tool: 'bash', args: { command } }), true, JSON.stringify(command))
  assert.equal(hardToUndo({ tool: 'bash', args: { cmd: ['C:\\Program Files\\Bitwarden CLI\\bw.exe', 'get', 'password', 'x'] } }), true)
  for (const command of [
    'bw status', 'bw sync', 'bw --version', 'op whoami', 'bws project list',
    'secret-tool store --label x a b', 'pass-cli item list', 'echo bw get', "pwsh -c 'bw status'",
  ]) assert.equal(hardToUndo({ tool: 'bash', args: { command } }), false, command)
})

test('terminal sends ask about password-manager reads in their text', () => {
  const text = 'bw get password x'
  for (const submit of [true, false]) {
    assert.equal(hardToUndo({ tool: 'mcp__dsh__terminal_send', args: { text, submit } }), true)
  }
  assert.equal(hardToUndo({ tool: 'terminal_send', args: { text: 'bw status' } }), false)
  assert.equal(hardToUndo({ tool: 'terminal_read', args: { text } }), false)
  assert.equal(hardToUndo({ tool: 'write', args: { path: 'README.md', content: text } }), false)
})
