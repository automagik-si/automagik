import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROLE_PLUGIN_VERSION } from '../src/host/role-catalog.js'
import { fixture, serviceStub } from './caller-fixture.js'

const capabilities = ['task-start', 'route-policy']

test('a new Bot can attach, grant and detach the registered Orchestrator', async t => {
  const f = fixture(t, { service: serviceStub({ multiuser: false }) })
  const { rt } = f
  const provider = rt.roleRegistry.of('orchestrator')
  assert.equal(provider.name, 'Orchestrator')
  assert.equal(provider.version, ROLE_PLUGIN_VERSION)
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
