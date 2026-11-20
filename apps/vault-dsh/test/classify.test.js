import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifySync } from '../src/bw/classify.js'

const url = 'https://vault.example.test/api/sync'
const prefix = `Syncing failed: FetchError: request to ${url} failed, reason: `
const complete = (body, code = 1) => ({ code, stdout: JSON.stringify(body), stderr: '' })
const failure = message => complete({ success: false, message })
const success = complete({ success: true, data: { object: 'message', title: 'Syncing complete.' } }, 0)

test('all 14 exact messages on the supported line are stale', () => {
  const reasons = [
    'getaddrinfo ENOTFOUND vault.example.test',
    'getaddrinfo EAI_AGAIN vault.example.test',
    'getaddrinfo EAI_FAIL vault.example.test',
    'connect ECONNREFUSED 127.0.0.1:8443',
    'connect ETIMEDOUT 2001:db8::42:8443',
    'connect EHOSTUNREACH 127.0.0.1:8443',
    'connect ENETUNREACH 127.0.0.1:8443',
    'connect ENETDOWN 127.0.0.1:8443',
    'connect ECONNRESET 127.0.0.1:8443',
    'read ETIMEDOUT',
    'read ECONNRESET',
    'write EPIPE',
    'socket hang up',
    'Client network socket disconnected before secure TLS connection was established',
  ]
  for (const reason of reasons) {
    assert.equal(classifySync('2026.10.1', failure(prefix + reason)), 'stale-network')
    assert.equal(classifySync('2026.10.9', failure(prefix + reason + ' trailing text')), 'unknown')
  }
})

test('only the exact sync success and response-mode failures are classified', () => {
  assert.equal(classifySync('2026.10.1', success), 'ok')
  for (const message of ['You are not logged in.', 'Invalid session key.', 'Syncing failed: HTTP 401',
    'Syncing failed: HTTP 403', 'Syncing failed: Error: MAC failed.']) {
    assert.equal(classifySync('2026.10.1', failure(message)), 'auth')
  }
  for (const message of ['ENOTFOUND', 'Syncing failed: socket hang up', 'Syncing failed: HTTP 503',
    prefix + 'proxy authentication required', prefix + 'self signed certificate',
    prefix + 'socket hang up\n', prefix + 'Socket hang up', prefix + 'getaddrinfo ENOTFOUND',
    prefix + 'getaddrinfo ENOTFOUND vault.example.test/extra']) {
    assert.equal(classifySync('2026.10.1', failure(message)), 'unknown')
  }
  const stale = failure(prefix + 'socket hang up')
  for (const result of [{ ...stale, failure: 'timeout' }, { ...stale, failure: 'output' },
    { ...stale, code: 0 }, { ...stale, code: null }, { ...stale, stdout: stale.stdout.slice(0, -1) },
    { ...stale, stdout: '', stderr: stale.stdout }, { ...stale, stderr: 'diagnostic' },
    complete({ success: true, data: { object: 'item', title: 'Syncing complete.' } }, 0),
    complete({ success: true, data: { object: 'message', title: 'Sync complete.' } }, 0),
    complete({ success: false, message: prefix + 'socket hang up', data: null })]) {
    assert.equal(classifySync('2026.10.1', result), 'unknown')
  }
  for (const version of ['2026.10.0', '2026.11.0', 'garbage']) {
    assert.equal(classifySync(version, stale), 'unknown')
    assert.equal(classifySync(version, success), 'unknown')
  }
})
