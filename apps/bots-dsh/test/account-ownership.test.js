// Whose sign-in is whose (#1399): the account card explains the Bot sign-in it holds, and a
// refused change keeps the sentence the host wrote instead of one generic line. The refusal is
// a bot/ sentence meant for the person; anything else (a private diagnostic, a network or an
// internal failure) keeps the card's own line, so no raw failure is ever rendered.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ACCOUNT_SHARING_HINT, accountChangeFailure } from '../src/shared/cli-account.js'

const here = fileURLToPath(new URL('.', import.meta.url))

test('a refused account change shows the host sentence, never a private failure', () => {
  const busy = 'Another Automagik session on this computer is using the Bot account. Close it, then press Sign in again.'
  assert.equal(accountChangeFailure({ code: 'bot/refused', message: busy }), busy)
  for (const error of [
    undefined,
    null,
    { code: 'bot/internal', message: 'private-process-diagnostic' },
    { code: 'NETWORK', message: 'private-network-detail' },
    { code: 'bot/refused', message: '' },
    { code: 'bot/refused', message: '   ' },
    { code: 'bot/refused' },
    { code: 'bot/refused', message: 42 },
  ]) assert.equal(accountChangeFailure(error), undefined, JSON.stringify(error))
})

test('the account card says the Bot sign-in may be shared with another installation', () => {
  assert.match(ACCOUNT_SHARING_HINT, /^Other Automagik installations on this computer may use this same Bot sign-in\. /)
  assert.match(ACCOUNT_SHARING_HINT, /A change here changes it for all of them\.$/)
  // The sentence is a dictionary key, so it is translated rather than shown raw.
  assert.equal(ACCOUNT_SHARING_HINT.includes('\n'), false)
})

test('the account card renders the installation it is in', () => {
  const source = readFileSync(join(here, '..', 'src', 'client', 'cli-accounts.js'), 'utf8')
  assert.match(source, /installation/)
  assert.match(source, /This installation: \{installation\}/)
  assert.match(source, /ACCOUNT_SHARING_HINT/)
  assert.match(source, /accountChangeFailure/)
})

// #2048 (G6-1, guard): the Bot accounts card lists only the agents with an account read; an
// `acp-antigravity` entry never shows, even when the host sends one.
test('the Bot accounts card never lists Antigravity', async () => {
  const { CLI_NAMES, SIGN_IN_NAMES } = await import('../src/client/cli-login-model.js')
  assert.equal(Object.hasOwn(CLI_NAMES, 'acp-antigravity'), false)
  assert.equal(SIGN_IN_NAMES['acp-antigravity'], 'Antigravity')
  const source = readFileSync(join(here, '..', 'src', 'client', 'cli-accounts.js'), 'utf8')
  assert.match(source, /Object\.hasOwn\(CLI_NAMES, id\) && \(entry\.authScope === 'isolated' \|\| consented\(entry\)\)/)
  assert.doesNotMatch(source, /SIGN_IN_NAMES|signInProviderOf/)
})
