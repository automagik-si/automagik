import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { FILE_TOOLS, filesDenyMirror, switchesOf, switchPatch } from '../src/shared/computer-settings.js'

test('ordinary Bot switch defaults and legacy computer settings', () => {
  assert.deepEqual(switchesOf({}), { terminal: true, files: true, computerUse: 'off' })
  assert.deepEqual(switchesOf({ shell: false, ...filesDenyMirror({}, false, undefined, 64), computer: { level: 'view' } }),
    { terminal: false, files: false, computerUse: 'view' })
  const apps = { editor: { name: 'Editor', grantedAt: 1 } }
  assert.deepEqual(switchPatch({ shell: false, computer: { level: 'background', apps } }),
    { shell: false, level: 'background', apps })
})

test('switch patch refuses ambiguous or invalid values', () => {
  for (const input of [
    { switches: null },
    { switches: { files: 'false' } },
    { switches: { unexpected: true } },
    { switches: { computerUse: true } },
    { switches: { terminal: true }, shell: false },
    { apps: [], computer: { apps: {} } },
  ]) assert.throws(() => switchPatch(input), { code: 'bot/invalid' })
})

test('Files mirror preserves explicit denies through repeated off and on writes', () => {
  const explicit = ['read_image', 'schedule_edit']
  const off = filesDenyMirror({ denyTools: explicit }, false, undefined, 24)
  assert.deepEqual(off.denyTools, [...explicit, ...FILE_TOOLS.filter(name => name !== 'read_image')])
  assert.ok(!off.filesMirror.added.includes('read_image'))
  assert.deepEqual(filesDenyMirror(off, false, undefined, 24), off)
  assert.deepEqual(filesDenyMirror(off, true, undefined, 24), { denyTools: explicit, filesMirror: undefined })
  const replaced = filesDenyMirror(off, false, ['read', 'schedule_create'], 24)
  assert.deepEqual(filesDenyMirror(replaced, true, undefined, 24),
    { denyTools: ['read', 'schedule_create'], filesMirror: undefined })
})

test('Files mirror refuses a denial list it cannot represent', () => {
  assert.throws(() => filesDenyMirror({}, false, ['schedule_edit'], FILE_TOOLS.length),
    /needs 1 more denied-tool slots/)
})

test('a replacement app grants object is copied and must carry a valid grant record', () => {
  const apps = { editor: { name: 'Editor', grantedAt: 1 } }
  const patch = switchPatch({ apps })
  assert.deepEqual(patch.apps, apps)
  assert.notEqual(patch.apps.editor, apps.editor)
  assert.throws(() => switchPatch({ apps: { editor: true } }), /valid app grants/)
})

test('owner switch writes persist provenance before acknowledgment and refuse Bot actors', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-switches-'))
  const path = join(home, 'state.json')
  writeFileSync(path, JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['b'],
    bots: { b: { id: 'b', name: 'Test Bot', sessionId: 'b', denyTools: ['read_image'] } },
  }))
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const patch = { switches: { files: false } }
  const before = readFileSync(path)
  await assert.rejects(rt.updateBot('b', patch, 'b'), /Only the owner/)
  assert.deepEqual(readFileSync(path), before)

  const save = rt.saveCopy
  rt.saveCopy = async () => { throw new Error('write refused') }
  await assert.rejects(rt.updateBot('b', patch), /write refused/)
  assert.equal(switchesOf(rt.botOf('b')).files, true)
  assert.deepEqual(readFileSync(path), before)

  rt.saveCopy = save
  await rt.updateBot('b', patch)
  let saved = JSON.parse(readFileSync(path, 'utf8')).bots.b
  assert.equal(switchesOf(saved).files, false)
  assert.ok(saved.denyTools.includes('read_image'))
  assert.ok(!saved.filesMirror.added.includes('read_image'))

  await rt.updateBot('b', { switches: { files: true } })
  saved = JSON.parse(readFileSync(path, 'utf8')).bots.b
  assert.equal(switchesOf(saved).files, true)
  assert.deepEqual(saved.denyTools, ['read_image'])
  assert.equal(saved.filesMirror, undefined)
})

test('a saved Omni link reports its legacy switch limits before provider registration', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-legacy-switches-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['b'],
    bots: { b: { id: 'b', name: 'Operator', sessionId: 'b' } },
  }))
  writeFileSync(join(home, 'omni.json'), '{}')
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  assert.equal(rt.omniLinked(), false)
  assert.equal(rt.omniRolePolicyReady('b'), false)
  assert.deepEqual(rt.effectiveBotSwitches(rt.botOf('b')),
    { terminal: false, files: 'partial', computerUse: 'off', filesHeldByOmni: ['read', 'write', 'edit', 'glob', 'grep'] })
  await assert.rejects(rt.updateBot('b', { shell: true }), /keeps Terminal off/)
  await assert.rejects(rt.updateBot('b', { switches: { files: true } }), /holds read, write, edit, glob and grep/)
  assert.equal(rt.botOf('b').filesMirror, undefined)
  await rt.updateBot('b', { switches: { files: false } })
  assert.equal(rt.effectiveBotSwitches(rt.botOf('b')).files, false)
  ctx.provide('omniChannels', { omniNamed() { throw new Error('link is unavailable') } })
  assert.equal(rt.effectiveBotSwitches(rt.botOf('b')).files, 'unknown')
  await assert.rejects(rt.updateBot('b', { switches: { files: true } }), /could not confirm Omni linkage/)
})

test('computer persistence failures roll back widening and retain safe local narrowing', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-computer-settings-'))
  const path = join(home, 'state.json')
  writeFileSync(path, JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['b'],
    bots: { b: { id: 'b', name: 'Test Bot', sessionId: 'b',
      computer: { level: 'background', apps: { Editor: { name: 'Editor', grantedAt: 1 } } } } },
  }))
  const revoked = []
  const ctx = fakeContext({ services: { cuaAccess: {
    applications: async () => ({ allowedApps: [{ id: 'fake-editor', name: 'Editor' }] }),
    revoke: async id => { revoked.push(id) },
  } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const before = readFileSync(path)
  const save = rt.save
  rt.save = async options => {
    assert.deepEqual(options, { required: true, durable: true })
    throw new Error('write refused')
  }
  const setLevel = level => rt.computerEndpoint('set-level', { botId: 'b', level })
  const revoke = () => rt.computerEndpoint('revoke-app', { botId: 'b', appKey: 'Editor' })
  await assert.rejects(setLevel('foreground'), /setting was not saved/)
  assert.equal(rt.computerLevelOf(rt.botOf('b')), 'background')
  await assert.rejects(setLevel('off'), /setting was not saved/)
  assert.equal(rt.computerLevelOf(rt.botOf('b')), 'off')
  await assert.rejects(revoke(), /revocation was not saved/)
  assert.equal(rt.botOf('b').computer.apps, undefined)
  assert.deepEqual(revoked, ['fake-editor'])
  assert.deepEqual(readFileSync(path), before)
  rt.save = save
  assert.equal(await revoke(), true)
  const saved = JSON.parse(readFileSync(path, 'utf8')).bots.b.computer
  assert.deepEqual(saved, {})
  assert.deepEqual(revoked, ['fake-editor', 'fake-editor'])
})

test('a predecessor denial edit makes advisory Files provenance stale', () => {
  const off = filesDenyMirror({ denyTools: ['read_image'] }, false, undefined, 64)
  const edited = { ...off, denyTools: ['read_image', 'schedule_edit'] }
  assert.equal(switchesOf(edited).files, false)
  assert.throws(() => filesDenyMirror(edited, true, undefined, 64), /denial provenance is stale/)
  assert.deepEqual(edited.denyTools, ['read_image', 'schedule_edit'])
})

test('Omni readiness requires a live provider and committed positions', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-omni-readiness-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['b'],
    bots: { b: { id: 'b', name: 'Test Bot', sessionId: 'b' } },
  }))
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const rt = createRuntime(ctx, { home })
  assert.equal(rt.omniRolePolicyReady('b'), false)
  await rt.load()
  const dispose = rt.hooks.role({ id: 'omni', name: 'Omni' })
  rt.state.positions = 1
  assert.equal(rt.omniRolePolicyReady('b'), false)
  rt.state.stateActivations = ['w1-positions-v1']
  assert.equal(rt.omniRolePolicyReady('b'), true)
  const proof = rt.stateWriteProof
  rt.stateWriteProof = () => 'held'
  assert.equal(rt.omniRolePolicyReady('b'), false)
  rt.stateWriteProof = proof
  dispose()
  assert.equal(rt.omniRolePolicyReady('b'), false)
})
