import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { activationIds, rosterBytes, scratch } from './fixtures/w1-format-profile.mjs'

const role = { id: 'operator', name: 'Operator', tools: ['operate'], capabilities: ['task-start'], prompt: 'Operate.' }

function fixture(t, format = 2, options = {}) {
  const home = scratch(t)
  const path = join(home, 'state.json')
  const source = rosterBytes(format, { roles: [], ...options })
  const backup = path + '.pre-roles-' + createHash('sha256').update(source).digest('hex')
  writeFileSync(path, source)
  const open = async () => {
    const ctx = fakeContext()
    const rt = createRuntime(ctx, { home, diagnosticsFile: false, github: false, updateCheck: false })
    const close = async () => { rt.dispose(); await ctx.dispose() }
    t.after(close)
    await rt.load()
    return { rt, close }
  }
  return { open, path, source, backup, saved: () => JSON.parse(readFileSync(path)) }
}

for (const format of [2, 3]) {
  test('activation keeps an exact legacy preimage and sticky IDs from format ' + format, async t => {
    const f = fixture(t, format)
    const first = await f.open()
    const { rt } = first
    rt.hooks.role(role)
    assert.deepEqual(await rt.attachRole('a', role.id), [role.id])
    assert.equal(f.saved().version, format + 2)
    assert.deepEqual(f.saved().stateActivations, [activationIds.registry])
    assert.deepEqual(readFileSync(f.backup), f.source)
    assert.deepEqual(f.saved().connectors, JSON.parse(f.source).connectors)
    let pin = f.saved().bots.a.roles[0]
    assert.equal(pin.source, 'registry')
    assert.deepEqual(await rt.grantRole({ id: 'a', role: pin, capability: 'task-start', on: true }), ['task-start'])
    assert.equal(rt.roleRuntime.grantOf('a', 'task-start'), 'granted')
    await first.close()

    const { rt: reload } = await f.open()
    assert.equal(reload.hasRole('a', role.id), false)
    assert.equal(reload.roleRuntime.viewByRole().a.operator.status, 'missing')
    const dispose = reload.hooks.role(role)
    assert.equal(reload.hasRole('a', role.id), true)
    assert.equal(reload.roleRuntime.grantOf('a', 'task-start'), 'granted')
    dispose()
    assert.equal(reload.roleRuntime.grantOf('a', 'task-start'), undefined)
    await reload.detachRole('a', pin.id)
    assert.equal(await reload.save({ required: true, durable: true }), true)
    assert.equal(f.saved().version, format + 2)
    assert.deepEqual(f.saved().stateActivations, [activationIds.registry])
    assert.deepEqual(f.saved().bots.a.roles, [])
  })
}

test('failed backup and unproven supervisor defer activation without publishing role authority', async t => {
  const f = fixture(t)
  const { rt } = await f.open()
  rt.hooks.role(role)
  rt.stateWriteProof = () => 'pending'
  await assert.rejects(rt.attachRole('a', role.id), { code: 'bot/state-activation-deferred' })
  rt.stateWriteProof = () => 'steady'
  mkdirSync(f.backup)
  await assert.rejects(rt.attachRole('a', role.id), /backup/)
  assert.deepEqual(readFileSync(f.path), f.source)
  assert.equal(rt.hasRole('a', role.id), false)
  assert.equal(rt.roleRuntime.grantOf('a', 'task-start'), undefined)
})

test('format 5 retains a usable encrypted credential and an unmatched envelope', async t => {
  for (const matches of [true, false]) await t.test(matches ? 'matching key' : 'unmatched key', async t => {
    const key = randomBytes(32)
    const storedKey = matches ? key : randomBytes(32)
    t.after(() => { key.fill(0); storedKey.fill(0) })
    const value = 'synthetic-test-credential9'
    const aad = Buffer.from(JSON.stringify(['v1', 'service', 'env', 'TOKEN', [null]]))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad)
    const envelope = {
      enc: 'v1', kid: createHash('sha256').update(key).digest('hex').slice(0, 16), parts: [null],
      iv: iv.toString('base64'), data: Buffer.concat([cipher.update(JSON.stringify([value])), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
    const f = fixture(t, 3, {
      connectors: { service: { custom: { command: 'fixture-never-exec', env: { TOKEN: envelope } } } },
    })
    const keyPath = join(dirname(f.path), 'connector-key')
    writeFileSync(keyPath, storedKey, { mode: 0o600 })
    const { rt } = await f.open()
    assert.equal(rt.connectorCredentialsUnavailable(rt.state.connectors.service.custom), !matches)
    rt.hooks.role(role)
    await rt.attachRole('a', role.id)
    const saved = f.saved()
    assert.equal(saved.version, 5)
    assert.ok(readFileSync(keyPath).equals(storedKey), 'activation preserves the original key')
    const output = saved.connectors.service.custom.env.TOKEN
    if (!matches) assert.deepEqual(output, envelope)
    else {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(output.iv, 'base64'))
      decipher.setAAD(aad)
      decipher.setAuthTag(Buffer.from(output.tag, 'base64'))
      const clear = Buffer.concat([decipher.update(Buffer.from(output.data, 'base64')), decipher.final()])
      assert.ok(clear.equals(Buffer.from(JSON.stringify([value]))), 'the retained credential authenticates')
      clear.fill(0)
    }
  })
})
