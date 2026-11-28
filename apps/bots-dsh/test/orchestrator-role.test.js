import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { activationIds, pins, rosterBytes, scratch } from './fixtures/w1-format-profile.mjs'
import { fixture, serviceStub } from './caller-fixture.js'

const capabilities = ['task-start', 'route-policy']

test('a new Bot can attach, grant and detach the registered Orchestrator', async t => {
  const f = fixture(t, { service: serviceStub({ multiuser: false }) })
  const { rt } = f
  const provider = rt.roleRegistry.of('orchestrator')
  assert.equal(provider.name, 'Orchestrator')
  assert.equal(provider.version, '1.0.0')
  assert.deepEqual(provider.capabilities, capabilities)
  assert.deepEqual(provider.tools, [])
  await f.start()
  const created = await f.call('create-bot', { name: 'Fresh orchestration fixture' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const { id } = created.value
  assert.deepEqual(rt.botOf(id).roles ?? [], [])
  for (const capability of capabilities) assert.equal(rt.roleRuntime.grantOf(id, capability), undefined)
  const attach = await f.call('role-attach', { id, role: provider.id })
  assert.equal(attach.ok, true, JSON.stringify(attach))
  const [pin] = rt.botOf(id).roles
  assert.equal(pin.source, 'registry')
  assert.deepEqual(pin.grants, [])
  for (const capability of capabilities) {
    assert.equal(rt.roleRuntime.grantOf(id, capability), 'declared')
    const grant = await f.call('role-grant', { id, role: pin, capability, on: true })
    assert.equal(grant.ok, true, JSON.stringify(grant))
    assert.equal(rt.roleRuntime.grantOf(id, capability), 'granted')
    assert.equal(rt.roleRuntime.legacyTaskGrant(id, capability), undefined)
  }
  assert.deepEqual(f.saved().bots[id].roles[0].grants, capabilities)
  const detach = await f.call('role-detach', { id, role: provider.id })
  assert.equal(detach.ok, true, JSON.stringify(detach))
  for (const capability of capabilities) assert.equal(rt.roleRuntime.grantOf(id, capability), undefined)
})

for (const version of ['1.0.0', '2.0.0']) {
  test(`a saved Orchestrator ${version} pin survives restart with exact version matching`, async t => {
    const home = scratch(t)
    const path = join(home, 'state.json')
    const pin = { ...pins.registry, version, grants: capabilities }
    const bytes = rosterBytes(4, { roles: [pin], stateActivations: [activationIds.registry] })
    writeFileSync(path, bytes)
    for (const restarted of [false, true]) {
      const ctx = fakeContext()
      const rt = createRuntime(ctx, { home, diagnosticsFile: false, github: false, updateCheck: false })
      try {
        await rt.load()
        const session = rt.chatOf('a')
        rt.roleRuntime.event(session, { type: 'turn/start', data: { turn: 1 } })
        const prompt = rt.roleRuntime.prompt(session) ?? ''
        if (version === '1.0.0') {
          assert.match(prompt, /use start_task/)
          for (const capability of capabilities) assert.equal(rt.roleRuntime.grantOf('a', capability), 'granted')
          await rt.attachRole('a', 'orchestrator')
          assert.deepEqual(readFileSync(path), bytes)
          if (restarted) {
            rt.hooks.role({ id: 'fixture-helper', name: 'Helper' })
            await rt.attachRole('a', 'fixture-helper')
            const roles = JSON.parse(readFileSync(path)).bots.a.roles
            assert.deepEqual(roles[0], pin)
            assert.equal(roles[1].id, 'fixture-helper')
          }
        } else {
          assert.equal(rt.roleRuntime.viewByRole().a.orchestrator.status, 'missing')
          assert.doesNotMatch(prompt, /use start_task/)
          for (const capability of capabilities) assert.equal(rt.roleRuntime.grantOf('a', capability), undefined)
          await assert.rejects(rt.attachRole('a', 'orchestrator'), /Detach orchestrator first/)
          assert.deepEqual(readFileSync(path), bytes)
        }
      } finally {
        await rt.dispose()
        await ctx.dispose()
      }
    }
  })
}
