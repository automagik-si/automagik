import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { activationIds, pins, rosterBytes, scratch } from './fixtures/w1-format-profile.mjs'

test('a same-ID provider can serve a committed registry pin and never adopts a catalog pin', async t => {
  const home = scratch(t)
  writeFileSync(join(home, 'state.json'), rosterBytes(4, {
    roles: [pins.registry], catalogControl: true, stateActivations: [activationIds.registry],
  }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, github: false, updateCheck: false })
  t.after(async () => { rt.dispose(); await ctx.dispose() })
  await rt.load()
  const provider = { id: pins.registry.id, name: 'Orchestrator', tools: ['delegate'], capabilities: ['task-start'], prompt: 'Registry provider prompt.' }
  const dispose = rt.hooks.role({ ...provider, version: '2.0.0' })
  assert.equal(rt.roleRuntime.grantOf('a', 'task-start'), undefined)
  assert.deepEqual(rt.roleRegistry.toolsWithheldFrom(rt.botOf('a')), ['delegate'])
  dispose()
  assert.equal(rt.hasRole('c', provider.id), false)
  const remove = rt.hooks.role(provider)
  assert.equal(rt.hasRole('c', provider.id), false)
  assert.equal(rt.roleRuntime.grantOf('a', 'task-start'), 'granted')
  assert.equal(rt.roleRuntime.grantOf('c', 'task-start'), undefined)
  assert.deepEqual(rt.roleRegistry.toolsWithheldFrom(rt.botOf('a')), [])
  assert.deepEqual(rt.roleRegistry.toolsWithheldFrom(rt.botOf('c')), ['delegate'])
  const session = rt.chatOf('a')
  rt.roleRuntime.event(session, { type: 'turn/start', data: { turn: 1 } })
  assert.match(rt.roleRuntime.prompt(session), /Registry provider prompt/)
  remove()
  assert.doesNotMatch(rt.roleRuntime.prompt(session) ?? '', /Registry provider prompt/)
  assert.equal(rt.roleRuntime.grantOf('a', 'task-start'), undefined)
  assert.deepEqual(rt.roleRegistry.toolsWithheldFrom(rt.botOf('a')), ['delegate'])
})
