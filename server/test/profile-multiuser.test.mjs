import assert from 'node:assert/strict'
import test from 'node:test'
import { runStartup } from '../entrypoint.mjs'
import { multiuserMode, startupDecision } from '../profile-multiuser.mjs'

test('mode parsing and startup launch order', async () => {
  for (const [value, mode] of [[undefined, 'off'], ['', 'off'], ['0', 'off'], ['1', 'on'], ['yes', 'invalid']]) {
    assert.equal(multiuserMode(value), mode)
    const events = []
    await runStartup({
      env: { AUTOMAGIK_MULTIUSER: value },
      launchCore: async () => { await Promise.resolve(); events.push('core') },
      launchDsh: () => events.push('dsh'),
      warn: message => events.push(message),
      exit: status => events.push(status),
    })
    assert.deepEqual(events, mode === 'off' ? ['core', 'dsh'] : [startupDecision(mode).reason, 1])
  }
})
