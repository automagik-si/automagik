import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { connection, local, locked, mount, name, provider } from './fixtures/wincred-host.mjs'

test('local-only Unlock and typed Find, Save, reload and approval preserve the caller’s spelling', async t => {
  const h = await mount(t, { mapping: false })
  assert.equal((await h.call('vault-status', { provider })).value.providers.includes(provider), true)
  assert.equal((await h.unlock({ origin: 'https://remote.invalid' })).body.ok, false)
  assert.equal((await h.unlock({ ...local, 'x-automagik-principal': 'fixture' })).body.ok, false)
  assert.equal((await h.unlock(local, { connection: 'other' })).body.ok, false)
  assert.equal((await h.unlock(local, { password: randomUUID() })).body.ok, false)
  assert.deepEqual(h.operations, [])
  assert.equal((await h.unlock()).body.ok, true)
  assert.equal((await h.call('vault-status', { provider })).value.connection, connection)
  assert.deepEqual(h.operations, ['probe'])
  const picked = await h.pick()
  const [row] = picked.body.value.items
  assert.equal(picked.cache, 'no-store')
  assert.equal(row.id === h.item && row.target === h.item && row.userName === h.user, true)
  assert.deepEqual(Object.keys(row), ['id', 'target', 'userName', 'fields'])
  assert.deepEqual(h.operations, ['probe', 'meta'])

  h.setPicker(({ target }) => ({ ok: true, items: [{
    id: target.toUpperCase(), target: target.toUpperCase(), userName: h.user, fields: ['password'],
  }] }))
  assert.equal((await h.pick()).body.ok, false, 'a consistently wrong case-variant row is refused')
  const reserved = 'AuToMaGiK-VaUlT:v1:' + randomUUID()
  for (const invalid of ['abc', reserved, h.item + '*', h.item + '\u2067']) {
    assert.equal((await h.pick(invalid)).body.ok, false)
    assert.equal((await h.call('secret-source-set', { ...h.reference, name, item: invalid })).ok, false)
  }
  assert.deepEqual(h.operations, ['probe', 'meta'])
  assert.equal((await h.call('secret-source-set', { ...h.reference, item: row.id, field: row.fields[0].selector, name })).ok, true)
  const stored = JSON.parse(await readFile(h.path, 'utf8')).sources[name]
  assert.equal(stored.item === h.item && stored.provider === provider && stored.connection === connection && stored.field === 'password', true)
  await h.writeMappings({ ...stored, item: reserved })
  await h.rt.loadSecrets()
  assert.equal(h.rt.secretSourcesView().broken, true)
  await h.writeMappings(stored)
  await h.rt.loadSecrets()
  assert.equal(h.rt.secretSourcesView().broken, false)
  for (const args of [{ command: 'fixture-command ' + h.item.toUpperCase() }, { purpose: h.item.toUpperCase() }]) {
    assert.match(await h.ask(undefined, args), /without secret material/)
  }
  assert.match(await h.ask(), /card asking the user/)
  const detail = await h.detail()
  assert.equal(detail.cache, 'no-store')
  assert.equal(detail.body.value.item === h.item && !Object.hasOwn(detail.body.value, 'userName'), true)
  assert.equal((await h.allow(detail.body.value)).ok, true)
  assert.deepEqual(h.operations, ['probe', 'meta'], 'status and approval do not read native records')
})

test('permanent exclusions show a Settings reason without spawning and a failed probe can be retried', async t => {
  for (const [opts, reason] of [
    [{ platform: 'linux' }, 'Windows Credential Manager needs Windows.'],
    [{ cloud: true }, 'Windows Credential Manager is unavailable in Automagik Cloud.'],
  ]) {
    await t.test(reason, async sub => {
      const h = await mount(sub, { mapping: false, ...opts })
      const before = (await h.call('vault-status', { provider: 'bitwarden' })).value
      const status = (await h.call('vault-status', { provider })).value
      assert.equal(status.state, 'unavailable')
      assert.equal(status.reason, reason)
      assert.equal(status.retry, undefined)
      assert.equal((await h.unlock()).body.error.message, reason)
      assert.deepEqual((await h.call('vault-status', { provider: 'bitwarden' })).value, before)
      assert.deepEqual(h.operations, [])
    })
  }
  const h = await mount(t, { mapping: false })
  h.setProbeExit(14)
  assert.equal((await h.unlock()).body.ok, false)
  for (let i = 0; i < 3; i++) {
    const status = (await h.call('vault-status', { provider })).value
    assert.equal(status.state, 'unavailable')
    assert.equal(status.retry, true)
  }
  assert.deepEqual(h.operations, ['probe'])
  h.setProbeExit(0)
  assert.equal((await h.unlock()).body.ok, true)
  assert.equal((await h.call('vault-status', { provider })).value.state, 'unlocked')
})

test('idle during Find, targeted lock and gate replacement fence cards, approval and grants', async t => {
  const h = await mount(t)
  await h.unlock()
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  h.setPicker(async options => {
    const result = await h.adapter.listItems(options)
    started.resolve()
    await release.promise
    return result
  })
  const pending = h.pick()
  await started.promise
  h.timers.tick(60_000)
  release.resolve()
  assert.equal((await pending).body.error.message, locked)
  await h.unlock()
  await h.ask()
  const old = (await h.detail()).body.value
  assert.equal((await h.lock('hashicorp-vault')).ok, true)
  assert.equal((await h.detail()).body.ok, true)
  assert.equal((await h.allow(old)).ok, true)
  await h.lock()
  await h.unlock()
  assert.equal((await h.execute()).error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')
  await h.ask()
  const prior = (await h.detail()).body.value
  h.replace({ ...h.service })
  assert.equal((await h.detail()).body.error.message, locked)
  assert.equal((await h.allow(prior)).error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')
})

test('lock across approval persistence records no grant and lock/reopen before detail refuses', async t => {
  const h = await mount(t)
  await h.unlock()
  await h.ask()
  const stale = (await h.detail()).body.value
  await h.lock()
  await h.unlock()
  assert.equal((await h.detail()).body.error.message, locked)
  assert.equal((await h.allow(stale)).error.message, locked)
  await h.ask()
  const current = (await h.detail()).body.value
  const started = Promise.withResolvers(), resume = Promise.withResolvers()
  const original = h.rt.save
  t.mock.method(h.rt, 'save', async options => {
    if (h.card().status === 'allowed') { started.resolve(); await resume.promise }
    return original(options)
  })
  const pending = h.allow(current)
  await started.promise
  await h.lock()
  h.adapter.unlock()
  resume.resolve()
  assert.equal((await pending).error.message, locked)
  assert.equal(h.card().status, 'canceled')
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal((await h.audit()).some(row => row.decision === 'allowed'), false)
})

test('wrong Bot, group, deny, plugin-off and audit failure refuse with private audit rotation', async t => {
  const h = await mount(t)
  await writeFile(h.auditPath, 'x'.repeat(1024 * 1024))
  assert.match(await h.ask(h.main), /the user did not let you/)
  assert.match(await h.ask(h.room), /only work in your own chat/)
  assert.equal(await h.ask(), locked)
  assert.equal((await stat(h.auditPath + '.1')).isFile(), true)
  await h.unlock()
  await h.ask()
  const denied = h.card()
  const snapshot = (await h.detail()).body.value
  assert.equal((await h.call('secret-cancel', { requestId: denied.id })).ok, true)
  assert.equal((await h.allow(snapshot, denied)).ok, false)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal((await h.audit()).some(row => row.decision === 'denied' && row.result === 'refused'), true)
  await h.ask()
  const pending = (await h.detail()).body.value
  await h.breakAudit()
  assert.match((await h.allow(pending)).error.message, /approval could not be recorded/)
  assert.equal(h.card().status, 'canceled')
  assert.equal(await h.execute(), 'fixture shell')
  h.stop()
  assert.match(await h.ask(), /vault plugin is off/)
  assert.equal(h.rt.secretValue(name), undefined)
})

test('a gate change during a mapping save refuses before creating the reference', async t => {
  const h = await mount(t, { mapping: false })
  await h.unlock()
  const status = h.service.status
  const started = Promise.withResolvers(), resume = Promise.withResolvers()
  t.mock.method(h.service, 'status', async options => {
    const answer = status(options)
    if (options.provider === provider) { started.resolve(); await resume.promise }
    return answer
  })
  const pending = h.call('secret-source-set', { ...h.reference, name })
  await started.promise
  await h.lock()
  resume.resolve()
  assert.equal((await pending).error.message, locked)
  await assert.rejects(stat(h.path), { code: 'ENOENT' })
})

test('a late result from an unlock cannot override a targeted lock', async t => {
  const h = await mount(t, { mapping: false })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const preflight = h.adapter.preflight
  t.mock.method(h.adapter, 'preflight', async (...args) => {
    const result = await preflight(...args)
    entered.resolve()
    await release.promise
    return result
  })
  const opening = h.unlock()
  await entered.promise
  assert.equal((await h.lock()).ok, true)
  release.resolve()
  assert.equal((await opening).body.error.message, locked)
  assert.equal((await h.call('vault-status', { provider })).value.state, 'locked')
})

test('Windows mapping names and purposes cannot publish case variants of the private target', async t => {
  const target = 'fixture_' + randomUUID().replaceAll('-', '')
  const h = await mount(t, { target })
  await h.unlock()
  const variant = target.toUpperCase()
  assert.equal((await h.call('secret-source-set', { ...h.reference, name, purpose: 'Use ' + variant })).ok, false)
  assert.equal((await h.call('secret-source-set', { ...h.reference, name: variant, purpose: 'Use the fixture' })).ok, false)
  const publicList = await h.list()
  assert.equal(publicList.includes(name) && !publicList.includes(variant), true)
  assert.match(await h.ask(), /card asking the user/)
  assert.equal((await h.audit()).some(row => row.name === name), true)
  for (const [key, purpose] of [[name, 'Use ' + variant], [variant, 'Use the fixture']]) {
    const before = await h.audit()
    await h.writeMappings({ ...h.reference, purpose }, key)
    assert.equal((await h.list()).includes('mapping file could not be read'), true)
    assert.equal((await h.ask(undefined, { name: key })).includes('mapping file could not be read'), true)
    assert.equal(JSON.stringify(await h.audit()) === JSON.stringify(before), true, 'invalid mapping adds no audit row')
  }
})

test('locking after mapping rename leaves the save successful and revokes its old approval', async t => {
  const h = await mount(t)
  await h.unlock()
  await h.ask()
  const previous = (await h.detail()).body.value
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const save = h.rt.save
  t.mock.method(h.rt, 'save', async options => {
    if (options?.required && h.card().status === 'canceled') {
      started.resolve()
      await release.promise
    }
    return save(options)
  })
  const purpose = 'Use the updated mapping'
  const pending = h.call('secret-source-set', { ...h.reference, name, purpose })
  await started.promise
  assert.equal(JSON.parse(await readFile(h.path, 'utf8')).sources[name].purpose, purpose)
  assert.equal((await h.lock()).ok, true)
  release.resolve()
  const answer = await pending
  assert.equal(answer.ok && answer.value.purpose === purpose, true)
  assert.equal(h.rt.secretSourcesView().rows[0].purpose, purpose)
  assert.equal((await h.allow(previous)).ok, false)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal((await h.audit()).some(row => row.decision === 'canceled' && row.result === 'revoked'), true)
})

test('candidate mappings cannot publish each other’s private Windows targets', async t => {
  const target = 'fixture_' + randomUUID().replaceAll('-', '')
  const h = await mount(t, { target })
  const variant = target.toUpperCase()
  const other = { ...h.reference, item: randomUUID() }
  const next = 'SECOND_FIXTURE'
  assert.equal((await h.unlock()).body.ok, true)
  const original = await readFile(h.path, 'utf8')
  for (const candidate of [{ ...other, name: next, purpose: 'Use ' + variant }, { ...other, name: variant }]) {
    assert.equal((await h.call('secret-source-set', candidate)).ok, false)
  }
  assert.equal(await readFile(h.path, 'utf8') === original, true)
  assert.equal((await h.call('secret-source-set', { ...other, name: next })).ok, true)
  // A new target can also invalidate metadata already present in another row.
  assert.equal((await h.call('secret-source-set', { ...h.reference, item: next, name })).ok, false)
  assert.equal((await h.list()).includes(next), true)
  assert.match(await h.ask(), /card asking the user/)

  for (const [sources, anonymousRefusal] of [
    [{ [name]: h.reference, [next]: { ...other, purpose: 'Use ' + variant } }, false],
    [{ [name]: h.reference, [variant]: other }, false],
    [{ INVALID_FIRST: { ...other, scope: {} }, [variant]: other, [name]: h.reference }, true],
    [{ [name]: { ...h.reference, scope: {} }, [variant]: other }, true],
  ]) {
    const before = (await h.audit()).length
    await writeFile(h.path, JSON.stringify({ version: 1, sources }))
    assert.equal((await h.list()).includes('mapping file could not be read'), true)
    assert.equal((await h.ask(undefined, { name: variant })).includes('mapping file could not be read'), true)
    assert.deepEqual(h.rt.secretSourcesView(), { broken: true, rows: [] })
    const rows = (await h.audit()).slice(before)
    assert.deepEqual(rows.map(row => [row.name, row.decision]), anonymousRefusal ? [[undefined, 'refused']] : [])
    assert.equal(JSON.stringify(rows).includes(variant), false, 'broken load audits no supplied name')
  }
})

test('requests keep other mappings’ Windows targets out of commands, purposes and working folders', async t => {
  const h = await mount(t)
  await h.unlock()
  const target = randomUUID(), variant = target.toUpperCase()
  assert.equal((await h.call('secret-source-set', { ...h.reference, name: 'SECOND_FIXTURE', item: target })).ok, true)
  const status = t.mock.method(h.service, 'status')
  for (const [args, cwd] of [
    [{ command: 'fixture-command ' + variant }],
    [{ purpose: 'Use ' + variant }],
    [{}, join(h.home, variant)],
  ]) {
    assert.match(await h.ask(undefined, args, cwd), /without secret material/)
  }
  assert.equal(status.mock.callCount(), 0, 'the existing target set is checked before status')
  assert.equal(h.card(), undefined)
  assert.equal((await h.audit()).filter(row => row.decision === 'refused').length, 3)
})

test('a Windows target introduced during status is checked before a request is saved', async t => {
  const h = await mount(t)
  await h.unlock()
  const target = randomUUID()
  const started = Promise.withResolvers(), resume = Promise.withResolvers()
  const status = h.service.status
  t.mock.method(h.service, 'status', async options => {
    started.resolve()
    await resume.promise
    return status(options)
  })
  const pending = h.ask(undefined, { command: 'fixture-command ' + target.toUpperCase() })
  await started.promise
  try {
    await writeFile(h.path, JSON.stringify({ version: 1, sources: {
      [name]: h.reference, SECOND_FIXTURE: { ...h.reference, item: target },
    } }))
  } finally { resume.resolve() }
  assert.match(await pending, /without secret material/)
  assert.equal(h.card(), undefined)
  const row = (await h.audit()).at(-1)
  assert.equal(row.decision, 'refused')
  assert.equal(row.commandDigest, undefined)
  const bytes = await readFile(join(h.home, 'state.json'), 'utf8')
  assert.equal(bytes.toLowerCase().includes(target), false)
})
