import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { VENDOR } from '../src/host/supervisor/stage.js'
import { candidateMatches, completeSwitch, didSwitch, digest, planSwitch, undoSwitch } from '../src/host/supervisor/switch.js'
import { BOTS, fixture, FROM, read, RUN_ID, TO, write } from './fixtures/supervisor.mjs'

function prepared(t) {
  const f = fixture(t)
  const { profileDir, staging } = f
  fs.mkdirSync(join(staging.profileDir, 'node_modules', BOTS), { recursive: true })
  fs.mkdirSync(staging.source)
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']) {
    fs.copyFileSync(join(profileDir, file), join(staging.source, file))
  }
  const manifest = structuredClone(f.manifest)
  manifest.dependencies[BOTS] = `file:${VENDOR}/${f.release[0].sha256}.tgz`
  write(join(staging.profileDir, 'package.json'), manifest)
  write(join(staging.profileDir, 'node_modules', BOTS, 'package.json'), { version: TO })
  fs.writeFileSync(join(staging.profileDir, 'pnpm-lock.yaml'), `candidate: ${manifest.dependencies[BOTS]}\n`)
  const run = { runId: RUN_ID, from: FROM, to: TO, names: [BOTS] }
  return { ...f, run }
}

function assertRestored(f) {
  const live = f.profileDir
  assert.equal(read(join(live, 'node_modules', BOTS, 'package.json')).version, FROM)
  assert.deepEqual(fs.readFileSync(join(live, 'pnpm-lock.yaml')), fs.readFileSync(join(f.staging.source, 'pnpm-lock.yaml')))
  assert.deepEqual(fs.readFileSync(join(live, 'package.json')), fs.readFileSync(join(f.staging.source, 'package.json')))
  assert.ok(fs.existsSync(f.archive))
  assert.equal(fs.readFileSync(join(live, 'vendor/owner.tgz'), 'utf8'), 'owner archive')
}

test('a live change refuses the switch before a version is kept', t => {
  const f = prepared(t)
  fs.appendFileSync(join(f.profileDir, 'pnpm-lock.yaml'), 'owner: changed\n')
  assert.equal(planSwitch(f.config, f.staging, f.run), null)
  assert.ok(fs.existsSync(f.archive))
  assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
})

test('a cut after every rename can be completed or undone from the persisted journal', async t => {
  const prototype = prepared(t)
  const steps = planSwitch(prototype.config, prototype.staging, prototype.run).steps
  assert.equal(steps.length, 6)
  for (const step of steps) {
    for (const action of ['forward', 'undo']) {
      await t.test(`${action} after ${step}`, t => {
        const f = prepared(t)
        let run = f.run
        run.journal = planSwitch(f.config, f.staging, run)
        const path = join(f.store, 'persisted.json')
        const save = () => write(path, run)
        assert.throws(() => completeSwitch(f.config, f.staging, run, save, renamed => {
          if (renamed === step) throw new Error('cut between rename and journal commit')
        }), /cut between/)
        run = read(path)
        assert.equal(run.journal.pending, step)
        assert.equal(didSwitch(f.config, f.staging, run), step === 'install-modules')
        if (action === 'undo') {
          undoSwitch(f.config, f.staging, run, save, 'supervisor-restarted')
          undoSwitch(f.config, f.staging, run, save, 'supervisor-restarted')
          assertRestored(f)
        } else {
          completeSwitch(f.config, f.staging, run, save)
          assert.deepEqual(read(path).journal.done, steps)
          assert.ok(candidateMatches(f.config, f.staging, run))
          const kept = join(f.store, run.journal.keep)
          assert.equal(read(join(kept, 'node_modules', BOTS, 'package.json')).version, FROM)
          assert.ok(fs.existsSync(join(kept, 'vendor', f.archive.split('/').at(-1))))
          assert.equal(fs.readFileSync(join(f.profileDir, 'vendor/owner.tgz'), 'utf8'), 'owner archive')
          assert.deepEqual(read(join(kept, 'data/bots-state.json')), { version: 2, note: 'preserve me' })
          assert.deepEqual(read(join(kept, 'data.json')), {
            version: 1, files: [{ path: join(f.botsHome, 'state.json'), snapshot: 'bots-state.json', format: 2,
              sha256: digest(fs.readFileSync(join(f.botsHome, 'state.json'))) }],
          })
        }
      })
    }
  }
})

for (const { label, document, format, reads, activations, captured, noRunId, reinstall } of [
  { label: 'legacy index without run ID or capabilities', document: {}, format: 0, noRunId: true },
  { label: 'three-argument legacy reads', document: { version: 2 }, format: 2, reads: [0, 1, 2, 3] },
  { label: 'captured legacy contract', document: { version: 3 }, format: 3, captured: { stateFormats: [0, 1, 2, 3] } },
  { label: 'captured empty allowlist', document: { version: 2 }, format: 2, captured: { stateFormats: [0, 1, 2, 3], activations: [] }, activations: [] },
  { label: 'captured protected contract on reinstall', document: { version: 4, stateActivations: ['alpha'] }, format: 4,
    captured: { stateFormats: [0, 1, 2, 3, 4, 5], activations: ['zeta', 'alpha'] }, activations: ['alpha', 'zeta'], reinstall: true },
  { label: 'absent roster', captured: { stateFormats: [0, 1, 2, 3] } },
]) {
  test('the v1 switch index records ' + label, t => {
    const { config, run, staging, botsHome, store } = prepared(t)
    const path = join(botsHome, 'state.json')
    if (document) write(path, document)
    else fs.unlinkSync(path)
    config.stateFormats = reads
    if (noRunId) delete run.runId
    if (reinstall) Object.assign(run, { to: run.from, reinstall: true })
    const journal = captured ? planSwitch(config, staging, run, captured) : planSwitch(config, staging, run)
    const kept = join(store, journal.keep)
    const bytes = document ? fs.readFileSync(path) : undefined
    assert.deepEqual(read(join(kept, 'data.json')), { version: 1, files: document ? [{
      path, snapshot: 'bots-state.json', format, sha256: digest(bytes),
      ...(captured || reads ? { reads: captured?.stateFormats ?? reads } : {}),
      ...(activations === undefined ? {} : { activations }),
    }] : [] })
    if (document) assert.deepEqual(fs.readFileSync(join(kept, 'data/bots-state.json')), bytes)
  })
}

test('candidate inputs allow DSH metadata reconciliation and reject installer changes', t => {
  const { config, staging, run, profileDir } = prepared(t)
  run.journal = planSwitch(config, staging, run)
  completeSwitch(config, staging, run, () => {})
  const changed = join(profileDir, 'package.json')
  const manifest = read(changed)
  manifest.dsh.profile.bundles.push('reconciled')
  write(changed, manifest)
  assert.ok(candidateMatches(config, staging, run))

  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']) {
    const path = join(profileDir, file)
    const original = fs.readFileSync(path)
    fs.appendFileSync(path, '\n')
    assert.equal(candidateMatches(config, staging, run), false, file)
    fs.writeFileSync(path, original)
  }
  manifest.dependencies['custom-plugin'] = '^2.0.0'
  write(changed, manifest)
  assert.equal(candidateMatches(config, staging, run), false)
})

test('an interrupted undo continues in reverse and keeps its original reason', t => {
  const f = prepared(t)
  let run = f.run
  run.journal = planSwitch(f.config, f.staging, run)
  const path = join(f.store, 'persisted.json')
  const save = () => write(path, run)
  completeSwitch(f.config, f.staging, run, save)
  assert.throws(() => undoSwitch(f.config, f.staging, run, () => {
    // Simulate going down after the reverse rename but before committing its new position.
    if (run.journal.done.length === 5) throw new Error('cut in undo')
    save()
  }, 'stage-failed'), /cut in undo/)
  run = read(path)
  assert.equal(didSwitch(f.config, f.staging, run), false)
  undoSwitch(f.config, f.staging, run, save, 'supervisor-restarted')
  assert.equal(run.journal.undoReason, 'stage-failed')
  assertRestored(f)
})


test('prepares recovery inputs before intent and refuses to undo using changed source bytes', t => {
  const f = prepared(t)
  const { run, staging, config } = f
  const synced = new Set()
  const fsync = fs.fsyncSync
  t.mock.method(fs, 'fsyncSync', fd => {
    if (process.platform === 'linux') synced.add(fs.readlinkSync('/proc/self/fd/' + fd))
    fsync(fd)
  })
  const journal = planSwitch(config, staging, run)
  if (process.platform === 'linux') {
    assert.ok(synced.has(join(staging.source, 'package.json')))
    assert.ok(synced.has(join(staging.profileDir, 'pnpm-lock.yaml')))
    assert.ok(synced.has(staging.source))
    assert.ok(synced.has(staging.root))
  }
  assert.match(journal.sourceHash, /^[a-f0-9]{64}$/)
  assert.match(journal.candidateHash, /^[a-f0-9]{64}$/)
  run.journal = journal
  completeSwitch(config, staging, run, () => {})
  const live = join(f.profileDir, 'package.json')
  const installed = fs.readFileSync(live)
  fs.writeFileSync(join(staging.source, 'package.json'), '{}')
  assert.throws(() => undoSwitch(config, staging, run, () => {}, 'stage-failed'), /recovery inputs changed/)
  assert.deepEqual(fs.readFileSync(live), installed)
  assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, TO)
})


for (const mode of ['strict', 'relinking', 'rollback', 'rename conflict']) {
  test('undo preflights the whole reverse switch for ' + mode, t => {
    const f = prepared(t)
    const { config, profileDir, run, staging } = f
    run.journal = planSwitch(config, staging, run)
    completeSwitch(config, staging, run, () => {})
    const kept = join(f.store, run.journal.keep)
    const liveLock = fs.readFileSync(join(profileDir, 'pnpm-lock.yaml'))
    const live = join(profileDir, 'package.json')
    let reason = 'stage-failed'
    let error = /Profile entries changed/
    if (mode === 'rollback') {
      reason = 'health-failed'
      error = /Rollback manifest changed/
      run.journal.rollbackManifestHash = digest(fs.readFileSync(join(staging.source, 'package.json')))
      fs.writeFileSync(join(staging.source, 'rollback.json'), '{}')
    } else if (mode === 'rename conflict') {
      error = /Inconsistent switch rename/
      fs.copyFileSync(join(kept, 'vendor', f.archive.split('/').at(-1)), f.archive)
    } else {
      const changed = read(live)
      changed.dependencies['custom-plugin'] = '^2.0.0'
      write(live, changed)
      if (mode === 'relinking') {
        run.journal.relinking = true
        error = /Unrelated profile entries changed during relink/
      }
    }
    const manifest = fs.readFileSync(live)
    const journal = structuredClone(run.journal)
    assert.throws(() => undoSwitch(config, staging, run, () => assert.fail('undo journal was saved'), reason,
      () => assert.fail('a step was reversed')), error)
    assert.deepEqual(run.journal, journal)
    assert.deepEqual(fs.readFileSync(live), manifest)
    assert.deepEqual(fs.readFileSync(join(profileDir, 'pnpm-lock.yaml')), liveLock)
    assert.equal(read(join(profileDir, 'node_modules', BOTS, 'package.json')).version, TO)
    assert.equal(read(join(kept, 'node_modules', BOTS, 'package.json')).version, FROM)
  })
}
