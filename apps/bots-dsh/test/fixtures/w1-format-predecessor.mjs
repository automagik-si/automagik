import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BOTS, fixture, FROM, read, RUN_ID, TO, write } from './supervisor.mjs'
import { activationIds, CONTRACT_PATH, LEGACY_CONTRACT, pins, rosterBytes, scratch, sha256 } from './w1-format-profile.mjs'

const load = (plugin, file) => import(pathToFileURL(join(plugin, file)).href)

async function withHost(plugin, home, work) {
  const [{ install: installStore }, { install: installRoster }, { installRoles }, roles] = await Promise.all([
    load(plugin, 'src/host/store.js'), load(plugin, 'src/host/roster.js'),
    load(plugin, 'src/host/roles.js'), load(plugin, 'src/shared/roles.js'),
  ])
  const disposers = []
  const ctx = { effect(fn) { disposers.unshift(fn()) } }
  const rt = { ctx, home, statePath: join(home, 'state.json'), warn() {} }
  try {
    installStore(rt)
    installRoster(rt)
    installRoles(rt, { fetch: () => assert.fail('Unexpected role feed request') })
    await rt.load()
    rt.roleRuntime.reconcile()
    await work(rt, roles)
  } finally {
    for (const dispose of disposers) await dispose()
  }
}

export const legacyCells = Object.freeze([
  ...[0, 1, 2, 3, 4, 5].map(format => ({ format, shape: 'catalog stack' })),
  ...[2, 3, 4, 5].map(format => ({ format, shape: 'registry pin' })),
])

export async function assertLegacyCell(t, plugin, { format, shape }) {
  const home = scratch(t)
  const path = join(home, 'state.json')
  const registry = shape === 'registry pin'
  const roles = registry ? [pins.registry] : [pins.solver, pins.voice]
  const stateActivations = format >= 4 ? [registry ? activationIds.registry : activationIds.stack] : undefined
  const before = rosterBytes(format, { roles, stateActivations, catalogControl: registry })
  fs.writeFileSync(path, before, { mode: 0o600 })
  await withHost(plugin, home, async (rt, { attachedRoleIds, effectiveRoleIds, packageAttachment }) => {
    if (format >= 4) {
      assert.equal(rt.teamLoaded(), false)
      assert.equal(rt.teamHealth(), null)
      assert.match(rt.readOnly(), /saved by a newer Omni/i)
      assert.equal(rt.botOf('a'), undefined)
      await assert.rejects(rt.save({ required: true, durable: true }), /saved by a newer Omni/i)
      await rt.save()
      assert.deepEqual(fs.readFileSync(path), before)
      return
    }

    assert.equal(rt.teamLoaded(), true)
    assert.equal(rt.holdsLock(), true)
    const bot = rt.botOf('a')
    assert.deepEqual(attachedRoleIds(bot), roles.map(pin => pin.id))
    assert.equal(packageAttachment(bot)?.id, roles.length === 1 ? roles[0].id : undefined)
    assert.equal(rt.roleRuntime.heldOf('a'), undefined)
    assert.equal(rt.roleRuntime.grantOf('a', 'task-start'), undefined)
    assert.equal(rt.roleRuntime.grantOf('a', 'audio-out'), undefined)
    if (registry) {
      assert.deepEqual(rt.botOf('c').roles, [pins.catalogOrchestrator])
      assert.equal(rt.roleRuntime.heldOf('c'), undefined)
      assert.equal(rt.roleRuntime.grantOf('c', 'task-start'), undefined)
    }
    const loaded = fs.readFileSync(path)
    if (format >= 2) assert.deepEqual(loaded, before)
    if (roles.length > 1) {
      await assert.rejects(rt.attachRole('a', 'voice-mouth'), /Detach solver first/i)
      assert.deepEqual(fs.readFileSync(path), loaded)
    }
    assert.equal(await rt.save({ required: true, durable: true }), true)
    const saved = read(path)
    assert.deepEqual(saved.bots.a.roles, roles)
    assert.equal(saved.version, format === 3 ? 3 : 2)
    assert.equal(saved.revision, JSON.parse(loaded).revision + 1)
    if (format === 3) {
      assert.equal(rt.connectorCredentialsUnavailable(rt.state.connectors.service.custom), true)
      assert.deepEqual(saved.connectors, JSON.parse(before).connectors)
    }

    assert.equal(Object.hasOwn(rt.botOf('b'), 'roles'), false)
    assert.deepEqual(effectiveRoleIds(rt.botOf('b'), rt.state.prefs), ['genie'])
    await rt.detachRole('b')
    assert.deepEqual(read(path).bots.b.roles, [])
    assert.deepEqual(effectiveRoleIds(rt.botOf('b'), rt.state.prefs), [])
    // Demonstrate the old lossy write on a synthetic 0–3 fixture. Format 4/5 must prevent it.
    await rt.detachRole('a')
    assert.deepEqual(read(path).bots.a.roles, [])
    if (registry) assert.deepEqual(read(path).bots.c.roles, [pins.catalogOrchestrator])
    assert.equal(read(path).bots.a.reviewGuard, true)
  })
  assert.deepEqual(fs.readdirSync(home), ['state.json'])
}

export const rollbackCells = Object.freeze([[2, 2], [3, 3], [2, 3], [2, 4], [3, 5]])

// By default this prepares a disposable profile with synthetic package and lock inputs.
// An installed runner can supply its own profile and real predecessor module tree.
export async function prepareRollback(t, plugin, from, to, installed) {
  const [{ planSwitch, completeSwitch }, { PROFILE_INPUTS, stagePaths }, { teamSnapshot, updateContract }] = await Promise.all([
    load(plugin, 'src/host/supervisor/switch.js'), load(plugin, 'src/host/supervisor/stage.js'),
    load(plugin, 'src/host/supervisor/rollback.js'),
  ])
  const f = installed ?? fixture(t)
  const { profileDir, store, env, profile } = f
  const path = join(f.botsHome, 'state.json')
  const predecessor = installed?.version ?? FROM
  const candidate = installed?.candidateVersion ?? TO
  const staging = stagePaths(store, RUN_ID, profile)
  const oldContract = join(profileDir, 'node_modules', BOTS, CONTRACT_PATH)
  if (!installed) write(oldContract, LEGACY_CONTRACT)
  const captured = updateContract(profileDir)
  assert.deepEqual(captured, LEGACY_CONTRACT)
  const config = { ...f.config, profileDir, store, env, stateFormats: captured.stateFormats }
  const original = rosterBytes(from)
  const trial = rosterBytes(to, {
    revision: 8, roles: to >= 4 ? [pins.solver, pins.registry] : [pins.solver, pins.voice],
    stateActivations: to >= 4 ? [activationIds.registry, activationIds.stack] : undefined,
    connectors: JSON.parse(original).connectors,
  })
  fs.writeFileSync(path, original)
  const candidatePackage = join(staging.profileDir, 'node_modules', BOTS)
  fs.mkdirSync(candidatePackage, { recursive: true })
  fs.mkdirSync(staging.source)
  for (const file of PROFILE_INPUTS) {
    const source = join(profileDir, file)
    if (fs.existsSync(source)) fs.copyFileSync(source, join(staging.source, file))
  }
  write(join(candidatePackage, 'package.json'), { name: BOTS, version: candidate })
  // Switch performs byte/identity checks on these files. The synthetic candidate never starts.
  fs.copyFileSync(join(profileDir, 'package.json'), join(staging.profileDir, 'package.json'))
  fs.copyFileSync(join(profileDir, 'pnpm-lock.yaml'), join(staging.profileDir, 'pnpm-lock.yaml'))

  const now = new Date().toISOString()
  const run = {
    version: 1, phase: 'switching', reason: null, runId: RUN_ID, bootId: 'sup_fixture',
    from: predecessor, to: candidate, sequence: 42, names: [BOTS], startedAt: now, updatedAt: now,
    fromVersions: { [BOTS]: predecessor },
  }
  run.journal = planSwitch(config, staging, run)
  assert.ok(run.journal)
  const save = changes => Object.assign(run, changes)
  completeSwitch(config, staging, run, save)
  const snapshot = teamSnapshot(config, run)
  assert.deepEqual(snapshot.reads, LEGACY_CONTRACT.stateFormats)
  assert.equal(snapshot.format, from)
  assert.deepEqual(fs.readFileSync(snapshot.saved), original)
  const index = fs.readFileSync(join(store, run.journal.keep, 'data.json'))
  fs.writeFileSync(path, trial)
  Object.assign(run, {
    phase: 'rollingBack', reason: 'health-failed',
    rollback: { failed: 'page', step: 'stop', trialFrom: now, tried: [], restoreCurrent: false },
    journal: { ...run.journal, undo: true, undoReason: 'health-failed' },
  })
  return { config, staging, run, save, original, trial, index, path }
}

export function assertRollbackBytes(f, run) {
  const incompatible = JSON.parse(f.trial).version >= 4
  const archive = join(f.config.store, 'rollback-data', run.runId)
  const live = fs.readFileSync(f.path)
  const snapshot = fs.readFileSync(join(archive, 'bots-state.json'))
  const index = fs.readFileSync(join(archive, 'data.json'))
  const trialPath = join(archive, 'trial-bots-state.json')
  const { why } = run.rollback.data
  assert.equal(why, incompatible ? undefined : 'same-format')
  assert.equal(run.rollback.data.restored, incompatible)
  assert.equal(run.rollback.data.trialKept, incompatible)
  assert.deepEqual(live, incompatible ? f.original : f.trial)
  assert.deepEqual(snapshot, f.original)
  assert.deepEqual(index, f.index)
  assert.equal(fs.existsSync(trialPath), incompatible)
  const displaced = incompatible ? fs.readFileSync(trialPath) : null
  if (displaced) assert.deepEqual(displaced, f.trial)
  return {
    why: why ?? null, before: sha256(f.original), trial: sha256(f.trial), live: sha256(live), snapshot: sha256(snapshot),
    index: sha256(index), displaced: displaced ? sha256(displaced) : null,
  }
}

export async function assertSourceRollback(t, plugin, from, to) {
  const f = await prepareRollback(t, plugin, from, to)
  const { runRollback } = await load(plugin, 'src/host/supervisor/rollback.js')
  await runRollback({
    ...f, signal: new AbortController().signal,
    stop: async () => {},
    restoreCurrent: () => assert.fail('No current record was published'),
    start: () => ({}), health: async () => ({ ok: true }),
    manualRecovery: (_code, reason) => assert.fail('Unexpected recovery outcome: ' + reason),
    retry: () => assert.fail('Unexpected rollback retry'),
  })
  return assertRollbackBytes(f, f.run)
}
