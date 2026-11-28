import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachedRoles, packageAttachment, packageAttachments, hasRole } from '../src/shared/roles.js'
import { pins } from './fixtures/w1-format-profile.mjs'

test('ordered role readers preserve the legacy first-package projection and catalog preference', () => {
  const bot = { roles: [pins.registry, pins.voice, pins.solver] }
  assert.deepEqual(attachedRoles(bot), bot.roles)
  assert.deepEqual(packageAttachments(bot).map(pin => pin.id), [pins.voice.id, pins.solver.id])
  assert.equal(packageAttachment(bot).id, pins.voice.id)
  assert.equal(packageAttachment(bot, pins.solver.id).id, pins.solver.id)
  assert.equal(hasRole(bot, pins.registry.id, { roles: false }), true)
  assert.equal(hasRole(bot, pins.voice.id, { roles: false }), false)
  assert.equal(packageAttachment({ roles: [{ ...pins.voice, source: 'unknown' }] }), undefined)
})
