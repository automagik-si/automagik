import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relaunchArgs } from '../src/relaunch-args.js'

const exe = '/apps/automagik.bin'

test('relaunch keeps launch options and positional arguments verbatim', () => {
  const args = ['--remote-debugging-port=19363', '--user-data-dir=/x', '--enable-features=A,B', '--', '', 'a b']
  assert.deepEqual(relaunchArgs([exe, ...args]), args)
})

test('relaunch drops both app link schemes, including after --', () => {
  assert.deepEqual(relaunchArgs([exe, 'automagik://x', '--', 'omni://y']), ['--'])
})

test('relaunch drops preload flags and consumes only supported split values', () => {
  assert.deepEqual(relaunchArgs([exe, '--preload=genie', '--preload', 'omni', '--preload', ' Genie ', '--preload']), [])
  assert.deepEqual(relaunchArgs([exe, '--preload=other']), [])
  assert.deepEqual(relaunchArgs([exe, '--preload', '--remote-debugging-port=1']), ['--remote-debugging-port=1'])
  assert.deepEqual(relaunchArgs([exe, '--preload', '--']), ['--'])
  assert.deepEqual(relaunchArgs([exe, '--preload', 'other']), ['other'])
})

test('relaunch keeps --no-sandbox once at its first position', () => {
  assert.deepEqual(relaunchArgs([exe, '--no-sandbox', '--no-sandbox', '--foo', '--no-sandbox']), ['--no-sandbox', '--foo'])
  assert.deepEqual(relaunchArgs([exe, '--foo', '--no-sandbox']), ['--foo', '--no-sandbox'])
})

test('relaunch handles missing argv and drops non-string entries', () => {
  for (const argv of [[exe], [], undefined, 'str']) assert.deepEqual(relaunchArgs(argv), [])
  assert.deepEqual(relaunchArgs([exe, null, '--foo', 7, {}, '--preload', false, 'genie']), ['--foo', 'genie'])
})
