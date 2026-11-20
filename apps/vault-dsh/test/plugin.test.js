import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as vault from '../index.js'
import { equalPrivate, fakeVault } from './fixtures/harness.mjs'

test('the pinned harness mounts, disables and re-enables the host service', async t => {
  const h = fakeVault(t)
  const env = Object.fromEntries(Object.entries(h.parent).filter(([name]) =>
    ['PATH', 'HOME', 'TMPDIR', 'BITWARDENCLI_APPDATA_DIR', 'BW_FIXTURE_DIR', 'BW_FIXTURE_SEED'].includes(name)))
  const before = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  const ctx = new Context()
  try {
    const plugin = await ctx.plugin(vault)
    const service = ctx.get('secretSources')
    assert.deepEqual(Object.keys(service).sort(), ['listItems', 'lock', 'prepareQuit', 'read', 'status', 'unlock', 'version'])
    assert.equal(service.version, 1)
    assert.equal(vault.Config({}).idleLockMinutes, 5)
    equalPrivate(await service.unlock({ password: h.password, connection: h.connection }), { ok: true })
    await plugin.dispose()
    assert.equal(h.commands().at(-1), 'lock')
    assert.equal(ctx.get('secretSources', false), undefined)
    const again = await ctx.plugin(vault)
    equalPrivate(await ctx.get('secretSources').status(), { state: 'locked' })
    await again.dispose()
    assert.equal(h.commands().filter(command => command === 'lock').length, 1)
  } finally {
    await ctx.fiber.dispose()
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
