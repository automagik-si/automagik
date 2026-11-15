import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextPolicy, contextPatch, HARD_CONTEXT_RATIO } from '../src/shared/context-policy.js'

test('per-Bot context overrides fall back to validated plugin defaults', () => {
  assert.deepEqual(contextPolicy(), { checkRatio: .8, recentTokens: 16384 })
  assert.deepEqual(contextPolicy({}, { checkRatio: .6, handoffRecentTokens: 9000 }), { checkRatio: .6, recentTokens: 9000 })
  assert.deepEqual(contextPolicy({ contextCheckRatio: .7, contextRecentTokens: 1200 }, { checkRatio: .6 }), { checkRatio: .7, recentTokens: 1200 })
  assert.deepEqual(contextPolicy({ contextCheckRatio: .95, contextRecentTokens: '5' }, { checkRatio: Infinity, handoffRecentTokens: 0 }), { checkRatio: .8, recentTokens: 16384 })
  assert.equal(HARD_CONTEXT_RATIO, .95)
})

test('context patches are strict, optional, and support override reset', () => {
  assert.deepEqual(contextPatch({ advanced: false, memoryReview: true, contextCheckRatio: .9, contextRecentTokens: 1 }), { advanced: false, memoryReview: true, contextCheckRatio: .9, contextRecentTokens: 1 })
  assert.deepEqual(contextPatch({ memoryReview: null, contextCheckRatio: null, contextRecentTokens: null }), { memoryReview: null, contextCheckRatio: null, contextRecentTokens: null })
  assert.deepEqual(contextPatch({ instructions: 'ignore' }), {})
  for (const advanced of [null, 0, 1, '', 'false', [], {}]) assert.throws(() => contextPatch({ advanced }), { code: 'bot/invalid' })
  for (const memoryReview of [0, 'true', [], {}]) assert.throws(() => contextPatch({ memoryReview }), { code: 'bot/invalid' })
  // The daily tidy switch is the same kind of override: a boolean, or null to reset.
  assert.deepEqual(contextPatch({ memoryTidy: true }), { memoryTidy: true })
  assert.deepEqual(contextPatch({ memoryTidy: null }), { memoryTidy: null })
  for (const memoryTidy of [0, 'true', [], {}]) assert.throws(() => contextPatch({ memoryTidy }), { code: 'bot/invalid' })
  for (const contextCheckRatio of [0, -.1, .95, 1, NaN, Infinity, '0.8']) assert.throws(() => contextPatch({ contextCheckRatio }), { code: 'bot/invalid' })
  for (const contextRecentTokens of [0, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5']) assert.throws(() => contextPatch({ contextRecentTokens }), { code: 'bot/invalid' })
})
