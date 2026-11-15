import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPayload } from '../src/client/bot-draft.js'

const draft = {
  name: 'Ada', look: { shape: 'round', color: 'cyan' },
  model: 'acp-codex/default', effort: 'high', brief: 'Please check this.',
}
const legacy = {
  name: 'Ada', color: 'cyan', avatar: { shape: 'round' },
  model: 'acp-codex/default', effort: 'high', brief: 'Please check this.',
}

test('non-empty role and instructions are trimmed and included', () => {
  assert.deepEqual(createPayload({
    ...draft, role: '  Reviewer \n', instructions: '\n Check files.  ',
  }), { ...legacy, role: 'Reviewer', instructions: 'Check files.' })
})

test('missing or whitespace identity preserves the legacy payload and brief', () => {
  for (const fields of [{}, { role: '', instructions: '' }, { role: ' \n', instructions: '\t' }]) {
    assert.deepEqual(createPayload({ ...draft, ...fields }), legacy)
  }
})

test('creation payload drops permission, authority and Bot kind fields', () => {
  assert.deepEqual(createPayload({
    ...draft, permission: 'danger-full-access', permissionAuto: true,
    denyTools: ['bash'], browserGrants: ['*'], capabilities: ['*'], main: true, kind: 'omni',
  }), legacy)
})
