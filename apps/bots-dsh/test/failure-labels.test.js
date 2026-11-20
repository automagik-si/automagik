import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { failureLabel, knownFailure } from '../src/client/diagnostics.js'

test('credential and account failures have short words, in both languages', () => {
  const labels = {
    MISSING_CREDENTIAL: 'The model has no API key',
    INVALID_CREDENTIAL: 'The API key is not in the right format',
    ACCOUNT_SIGN_IN_REQUIRED: 'The DeepSeek account needs a sign-in',
    ACCOUNT_SIGNED_OUT: 'The DeepSeek account is signed out',
    ACCOUNT_TOKEN_INVALID: 'The DeepSeek account sign-in has expired',
  }
  for (const [code, label] of Object.entries(labels)) {
    assert.equal(failureLabel(code, 'llm-deepseek: no API key for provider route'), label)
    assert.ok(Object.hasOwn(DICTIONARY.zh, label), label)
  }
})

test('an unknown code has no short words, and its label falls back to the message', () => {
  assert.equal(knownFailure('SOMETHING_NEW'), undefined)
  assert.equal(knownFailure(undefined), undefined)
  assert.equal(knownFailure('toString'), undefined)
  assert.equal(failureLabel('SOMETHING_NEW', 'raw text'), 'raw text')
  assert.equal(failureLabel('SOMETHING_NEW', ''), 'SOMETHING_NEW')
})

test('both ACP usage limit codes have a short label and Chinese copy', () => {
  const label = 'The coding agent reached its usage limit'
  for (const code of ['ACP_CLAUDE_USAGE_LIMIT', 'ACP_CODEX_USAGE_LIMIT']) {
    assert.equal(knownFailure(code), label)
  }
  assert.equal(DICTIONARY.zh[label], '编程助手已达到使用限额')
  assert.equal(DICTIONARY.zh['{provider} reached its usage limit.'], '{provider} 已达到使用限额。')
})
