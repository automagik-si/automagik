import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { currentOf } from '../../apps/bots-dsh/src/host/supervisor/records.js'
import { PROFILE, profileDirOf } from '../lib.mjs'
import { readStoreJson, signedUpdate, updateRecovery, updateStoreOf } from '../profile-update.mjs'
import { installSignedProfile } from './fixtures/signed-profile.mjs'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'profile-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = profileDirOf(home), store = updateStoreOf(profile)
  const state = join(store, 'state.json')
  const writeState = value => writeFileSync(state, JSON.stringify(value))
  assert.equal(store, join(home, 'update', PROFILE))
  return { home, profile, store, state, writeState }
}

const archive = 'keep-archive:' + 'a'.repeat(64) + '.tgz'
const steps = ['keep-modules', archive, 'keep-lockfile', 'install-lockfile', 'install-entries', 'install-modules']
const journal = { op: 'switch', pending: null, steps, done: steps }
const undo = { ...journal, done: [], undo: true }

test('classifies only the fixed launcher terminal phases and valid journal directions as done', t => {
  const { profile, store, writeState } = fixture(t)
  assert.deepEqual(readStoreJson(store, 'state.json'), { absent: true })
  assert.equal(updateRecovery(profile), 'absent')
  mkdirSync(store, { recursive: true })
  assert.equal(updateRecovery(profile), 'absent')
  for (const [phase, j] of [
    ['healthy', undefined], ['healthy', { ...journal, commitCurrent: true }],
    ['rolledBack', undo], ['notUpdated', undo],
  ]) {
    const state = { version: 1, phase, journal: j }
    writeState(state)
    assert.equal(updateRecovery(profile), 'done', phase)
  }
  for (const phase of ['checking', 'downloading', 'verifying', 'staging', 'switching', 'restarting', 'health', 'rollingBack', 'manualRecovery', 'unknown']) {
    writeState({ version: 1, phase })
    assert.equal(updateRecovery(profile), 'recover', phase)
  }
  writeState({ version: 2, phase: 'healthy' })
  assert.equal(updateRecovery(profile), 'recover')
  for (const [field, value] of [
    ['op', 'rollback'], ['pending', 'install-modules'], ['steps', null], ['done', {}],
    ['steps', steps.slice(1)], ['steps', [...steps.slice(0, 2), archive, ...steps.slice(2)]],
    ['steps', steps.map(step => step === archive ? 'keep-archive:../other.tgz' : step)],
    ['steps', steps.toReversed()], ['done', steps.toReversed()], ['done', steps.slice(0, -1)],
    ['undo', false], ['commitCurrent', false],
  ]) {
    writeState({ version: 1, phase: 'healthy', journal: { ...journal, [field]: value } })
    assert.equal(updateRecovery(profile), 'recover', field)
  }
  for (const j of [journal, { ...undo, done: steps }, { ...undo, commitCurrent: true }]) {
    writeState({ version: 1, phase: 'rolledBack', journal: j })
    assert.equal(updateRecovery(profile), 'recover')
  }
})

test('refuses oversized, malformed and non-regular files, including symlinked parents', t => {
  const { home, store, state, profile } = fixture(t)
  mkdirSync(store, { recursive: true })
  for (const bytes of ['{', ' '.repeat(64 * 1024 + 1)]) {
    writeFileSync(state, bytes)
    assert.deepEqual(readStoreJson(store, 'state.json'), { invalid: true })
    assert.equal(updateRecovery(profile), 'recover')
  }
  const outside = join(home, 'outside')
  writeFileSync(outside, '{"version":1,"phase":"healthy"}')
  rmSync(state)
  symlinkSync(outside, state)
  assert.equal(updateRecovery(profile), 'recover')
  rmSync(state)
  mkdirSync(state)
  assert.equal(updateRecovery(profile), 'recover')
  rmSync(state, { recursive: true })
  rmSync(store, { recursive: true })
  symlinkSync(home, store)
  assert.equal(updateRecovery(profile), 'recover')
  unlinkSync(store)
  rmSync(dirname(store), { recursive: true })
  symlinkSync(home, dirname(store))
  assert.equal(updateRecovery(profile), 'recover')
})

test('uses the image profile store even if a plain-host decoy looks terminal', t => {
  const { home, profile, store, writeState } = fixture(t)
  const decoy = join(home, 'update', 'web')
  mkdirSync(decoy, { recursive: true })
  writeFileSync(join(decoy, 'state.json'), '{"version":1,"phase":"healthy"}')
  mkdirSync(store)
  writeState({ version: 1, phase: 'switching', journal: { ...journal, pending: 'install-modules' } })
  assert.equal(updateRecovery(profile), 'recover')
})

const BOTS = '@automagik/bots-dsh', ACP = '@automagik/acp-dsh'
const V = '3.161.2'
for (const [name, mutate, expected] of [
  ['valid', () => {}, V],
  ['owner addition', ({ manifest }) => {
    manifest.dependencies.example = '1.2.3'
    manifest.dsh.profile.bundles.push('example')
  }, V],
  ['edited pin', ({ manifest }) => { manifest.dependencies[BOTS] = `file:vendor/automagik-update/${'f'.repeat(64)}.tgz` }, null],
  ['unrecorded lane plugin', ({ current }) => { delete current.entries[ACP]; delete current.base[ACP] }, null],
  ['wrong installed version', ({ profile }) => writeFileSync(join(profile, 'node_modules', BOTS, 'package.json'), '{"version":"3.161.1"}'), null],
  ['missing archive', ({ profile, current }) => rmSync(join(profile, current.entries[BOTS].slice(5))), null],
  ['pre-update base edit', ({ current }) => { current.base[BOTS] = '^3.160.9' }, null],
  ['unrelated manifest edit', ({ manifest }) => { manifest.description = 'owner-managed' }, null],
  ['old record', ({ current }) => { delete current.entries; delete current.base }, null],
  ['wrong sequence', ({ current }) => { current.lastSequence = 41 }, null],
  ['mismatched keys', ({ current }) => { delete current.base[ACP] }, null],
  ['unrecognized key', ({ current }) => { current.entries.unknown = current.entries[ACP]; current.base.unknown = current.base[ACP] }, null],
]) test(`recognizes signed ownership with ${name} only when the committed inputs match`, t => {
  const { profile, store } = fixture(t)
  const file = join(profile, 'package.json')
  mkdirSync(profile, { recursive: true })
  const baseline = {
    dependencies: { [BOTS]: 'image-bots', [ACP]: 'image-acp' },
    dsh: { profile: { bundles: [BOTS, ACP] } },
  }
  writeFileSync(file, JSON.stringify(baseline))
  assert.equal(signedUpdate(profile, baseline, store), null)
  const { current, manifest, path } = installSignedProfile(profile, V)
  mutate({ profile, current, manifest })
  writeFileSync(file, JSON.stringify(manifest))
  writeFileSync(path, JSON.stringify(current))
  assert.equal(signedUpdate(profile, baseline, store), expected)
  writeFileSync(path, '{')
  assert.equal(signedUpdate(profile, baseline, store), null)
})

test('signed ownership includes lane plugins added to an image-managed workspace', t => {
  const { profile, store } = fixture(t)
  mkdirSync(profile, { recursive: true })
  const baseline = { dependencies: { [BOTS]: 'image-bots' }, dsh: { profile: { bundles: [BOTS] } } }
  const added = ['@automagik/locale-pt-br-dsh', '@automagik/vault-dsh']
  const manifest = structuredClone(baseline)
  for (const name of added) {
    manifest.dependencies[name] = '3.161.1'
    manifest.dsh.profile.bundles.push(name)
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
  const { current, path } = installSignedProfile(profile, V)
  assert.equal(signedUpdate(profile, baseline, store), V)
  delete current.entries[added[1]]
  delete current.base[added[1]]
  writeFileSync(path, JSON.stringify(current))
  assert.equal(signedUpdate(profile, baseline, store), null)
})

test('the supervisor and signed ownership both reject malformed version-1 current records', t => {
  const { profile, store } = fixture(t)
  mkdirSync(profile, { recursive: true })
  const baseline = { dependencies: { [BOTS]: 'image-bots' }, dsh: { profile: { bundles: [BOTS] } } }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(baseline))
  const { current, path } = installSignedProfile(profile, V)
  for (const kept of [null, { version: '3.161.1' }, { version: 'v3.161.1+build' }, { version: '3.161.1-rc-hotfix+image-linux' }]) {
    const value = { ...current, kept }
    writeFileSync(path, JSON.stringify(value))
    assert.deepEqual(currentOf(value, []), value)
    assert.equal(signedUpdate(profile, baseline, store), V)
  }
  for (const [name, fields] of [
    ['schema', { version: 2 }],
    ['missing live', { live: undefined }],
    ['malformed live version', { live: { ...current.live, version: 'not a version' } }],
    ['invalid live sequence', { live: { ...current.live, sequence: -1 } }],
    ['missing kept', { kept: undefined }],
    ['non-record kept', { kept: '3.161.1' }],
    ['missing kept version', { kept: {} }],
    ['non-string kept version', { kept: { version: 3 } }],
    ['malformed kept version', { kept: { version: '3.161.1/path' } }],
    ['untrimmed kept version', { kept: { version: ' 3.161.1 ' } }],
    ['mixed kept version syntax', { kept: { version: '3.161.1-rc_hot-fix' } }],
    ['missing lastSequence', { lastSequence: undefined }],
    ['old sequence', { lastSequence: 41 }],
    ['unsafe sequence', { lastSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing base', { base: undefined }],
    ['invalid entry pin', { entries: { [BOTS]: 'file:vendor/image-bots.tgz' } }],
  ]) {
    const value = JSON.parse(JSON.stringify({ ...current, ...fields }))
    writeFileSync(path, JSON.stringify(value))
    assert.equal(currentOf(value, []), null, name)
    assert.equal(signedUpdate(profile, baseline, store), null, name)
  }
  const noLiveRelease = { ...current, live: null }
  writeFileSync(path, JSON.stringify(noLiveRelease))
  assert.deepEqual(currentOf(noLiveRelease, []), noLiveRelease)
  assert.equal(signedUpdate(profile, baseline, store), null)
})
