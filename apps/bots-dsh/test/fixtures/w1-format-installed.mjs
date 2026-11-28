// Opt-in. From apps/bots-dsh, under scripts/capped-run:
// node --import ./test/harness-resolve.mjs test/fixtures/w1-format-installed.mjs <bots.tgz> <lane.json> <supervisor/main.js> <commit> <sha256>
// lane.json.sig is read beside lane.json. Use the supervisor entry from the selected release.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeContext } from '../fake-ctx.js'
import { activationIds } from './w1-format-profile.mjs'
import { verifyLane } from '../../src/host/lane-verify.js'
import { ROLE_KEYS } from '../../src/host/supervisor/release.js'
import { VENDOR } from '../../src/host/supervisor/stage.js'
import { prepareStore, writeJsonAtomic } from '../../src/host/supervisor/store.js'
import { BOTS, read, write } from './supervisor.mjs'
import { assertCleanCell, assertRefusedCell, assertLegacyCell, assertRollbackBytes, legacyCells, prepareRollback, rollbackCells } from './w1-format-predecessor.mjs'
import { LEGACY_CONTRACT, pins, readFormatContract, rosterBytes, scratch, sha256 } from './w1-format-profile.mjs'

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const manifest = 'package.json'
const main = 'supervisor/main.js'
const inventory = 'supervisor/files.json'
const harness = join(checkout, 'dev/harness/node_modules')
const deps = join(checkout, 'node_modules')
const dsh = join(harness, '@deepseek-ai/dsh')
const web = '@deepseek-ai/dsh-web-app'
const base = '@deepseek-ai/dsh-base'

const guardedF = {
  version: '3.178.9',
  commit: 'ba2883ab1d4ab15f23bf3821567d854d529e98d8',
  hash: 'd275d5c364662ec56c66a6847ff0890277d1f41f61e363a303271e39dace1ae5',
}
const historical = new Map([
  ['3.178.5', 'bf4337a2426da90f29be9ce6361477213641a284'],
])

function verifyArtifact({ tarball, lane, supervisor, commit, hash }) {
  assert.match(commit, /^[a-f0-9]{40}$/)
  assert.match(hash, /^[a-f0-9]{64}$/)
  const feed = fs.readFileSync(lane)
  const signature = fs.readFileSync(lane + '.sig', 'utf8')
  const release = verifyLane(feed, signature, ROLE_KEYS)
  assert.equal(release.commit, commit)
  const rows = release.plugins.filter(row => row.name === BOTS)
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row.version, release.version)
  assert.equal(row.sha256, hash)
  const bytes = fs.readFileSync(tarball)
  assert.equal(bytes.length, row.size)
  assert.equal(sha256(bytes), hash)
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), row.integrity)
  assert.equal(supervisor.endsWith('/' + main), true, 'Expected the supplied supervisor/main.js')
  const classification = release.version === guardedF.version && commit === guardedF.commit && hash === guardedF.hash
    ? 'guarded-f' : historical.get(release.version) === commit ? 'historical-pre-f' : undefined
  assert.ok(classification, 'No approved predecessor class for this signed version and commit')
  return {
    bytes, supervisor: dirname(dirname(supervisor)),
    provenance: { classification, commit, version: release.version, tarballSha256: hash, feedSha256: sha256(feed), signature: 'verified', keyId: release.keyId,
      checkoutInputs: ['prepareStore', 'writeJsonAtomic', 'VENDOR', 'lane verifier and public keys', 'plugin runtime dependencies', 'DSH harness and expected DSH pin'],
    },
  }
}

function linkDependency(modules, available, name) {
  const dest = join(modules, name)
  fs.mkdirSync(dirname(dest), { recursive: true })
  fs.symlinkSync(fs.realpathSync(join(available, name)), dest, 'dir')
}

function profileFor(t, artifact) {
  const root = scratch(t)
  const home = join(root, 'dsh')
  const profile = 'web'
  const profileDir = join(home, 'profiles', profile)
  const botsHome = join(root, 'bots')
  const modules = join(profileDir, 'node_modules')
  const plugin = join(modules, BOTS)
  const pin = `file:${VENDOR}/${artifact.provenance.tarballSha256}.tgz`
  const tar = join(profileDir, pin.slice('file:'.length))
  const guard = join(root, 'offline.mjs')
  const env = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: join(root, 'tmp'),
    AUTOMAGIK_HOME: join(root, 'automagik'), AUTOMAGIK_BOTS_HOME: botsHome, DSH_HOME: home,
    AUTOMAGIK_RESERVATIONS_DIR: join(root, 'reservations'),
    HC_SESSION: basename(root), NPM_CONFIG_OFFLINE: 'true',
    NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
  }
  for (const dir of [env.HOME, env.XDG_RUNTIME_DIR, env.TMPDIR, plugin, dirname(tar), botsHome]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(guard, `
    import { Socket } from 'node:net'
    // Deny outbound sockets in the DSH child. Its inbound loopback listener stays available.
    Socket.prototype.connect = () => { throw new Error('Unexpected outbound connection in W1 fixture') }
    globalThis.fetch = async () => { throw new Error('Unexpected fetch in W1 fixture') }
  `)
  fs.writeFileSync(tar, artifact.bytes, { mode: 0o600 })
  execFileSync('/usr/bin/tar', ['-xzf', tar, '--strip-components=1', '-C', plugin], { env, timeout: 10_000 })
  const { name, version, dependencies } = read(join(plugin, manifest))
  assert.equal(name, BOTS)
  assert.equal(version, artifact.provenance.version)
  for (const dependency of Object.keys(dependencies)) linkDependency(modules, deps, dependency)
  for (const leaf of fs.readdirSync(join(harness, '@deepseek-ai'))) {
    linkDependency(modules, harness, '@deepseek-ai/' + leaf)
  }
  const dependencyPins = Object.fromEntries(Object.entries(dependencies).map(([name, expected]) => {
    const version = read(join(modules, name, manifest)).version
    assert.equal(version, expected, 'Locked production dependency ' + name)
    return [name, version]
  }))
  const runtimePins = Object.fromEntries([base, web].map(name => [name, read(join(modules, name, manifest)).version]))
  write(join(profileDir, manifest), {
    name: 'w1-format-fixture', private: true,
    dependencies: { [BOTS]: pin, ...runtimePins },
    dsh: { profile: { bundles: [base, web, BOTS] } },
  })
  fs.writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# Fixture pin: ${pin}\n`)
  const contract = readFormatContract(plugin)
  if (artifact.candidate) assert.equal(contract.legacy, false)
  else assert.deepEqual(contract.contract, LEGACY_CONTRACT)
  const store = prepareStore(profileDir)
  const dshVersion = read(join(dsh, manifest)).version
  const expectedDsh = read(join(checkout, 'dev/harness', manifest)).dependencies['@deepseek-ai/dsh']
  assert.equal(dshVersion, expectedDsh)
  const command = [process.execPath, join(dsh, 'lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0']
  const candidateVersion = version.replace(/\d+$/, patch => String(Number(patch) + 1))
  return { home, profile, profileDir, store, botsHome, plugin, env, command, version, candidateVersion, dshVersion, runtimePins, dependencyPins }
}

function installedSupervisor(f, artifact) {
  const host = join(f.plugin, 'src/host')
  const files = read(join(host, inventory))
  const hashes = {}
  for (const file of files) {
    const bytes = fs.readFileSync(join(artifact.supervisor, file))
    assert.deepEqual(bytes, fs.readFileSync(join(host, file)), 'Supervisor artifact mismatch for ' + file)
    hashes[file] = sha256(bytes)
  }
  const opts = ['--dsh-home', f.home, '--profile', f.profile]
  execFileSync(process.execPath, [join(host, main), 'install-copy', ...opts], { env: f.env, timeout: 10_000 })
  const copy = join(f.store, 'supervisor/current')
  assert.equal(read(join(copy, 'version.json')).version, f.version)
  for (const file of files) assert.equal(sha256(fs.readFileSync(join(copy, file))), hashes[file])
  const selfCheck = execFileSync(process.execPath, [join(copy, main), '--self-check'], { env: f.env, timeout: 10_000 })
  assert.equal(selfCheck.toString().trim(), 'automagik-supervisor-ok')
  return { entry: join(copy, main), sha256: hashes[main], closureSha256: sha256(JSON.stringify(hashes)) }
}

async function writeCandidateTrial(t, candidate, f, rollback, from, to) {
  const trial = profileFor(t, candidate)
  const path = join(trial.botsHome, 'state.json')
  const original = JSON.parse(rollback.original)
  const source = rosterBytes(from, { roles: [], revision: original.revision, connectors: original.connectors })
  fs.writeFileSync(path, source)
  const { createRuntime } = await import(pathToFileURL(join(trial.plugin, 'index.js')).href)
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home: trial.botsHome, diagnosticsFile: false, github: false, updateCheck: false })
  try {
    await rt.load()
    // Use two registry attachments so neither collision proof is stubbed.
    for (const id of ['operator', 'guide']) {
      rt.hooks.role({ id, name: id, tools: [], capabilities: [] })
      await rt.attachRole('a', id)
    }
    const saved = fs.readFileSync(path)
    const state = JSON.parse(saved)
    assert.equal(state.version, to)
    assert.deepEqual(state.stateActivations, [activationIds.registry, activationIds.stack])
    assert.deepEqual(state.bots.a.roles.map(pin => pin.id), ['operator', 'guide'])
    assert.deepEqual(state.connectors, original.connectors)
    assert.deepEqual(fs.readFileSync(path + '.pre-roles-' + sha256(source)), source)
    assert.deepEqual(trial.dependencyPins, f.dependencyPins)
    assert.deepEqual(trial.runtimePins, f.runtimePins)
    rollback.trial = saved
    fs.writeFileSync(rollback.path, saved)
    t.diagnostic(JSON.stringify({ candidate: candidate.provenance, writer: 'packed host runtime in disposable context',
      dependencies: trial.dependencyPins, dsh: trial.dshVersion, trial: sha256(saved) }))
  } finally {
    rt.dispose()
    await ctx.dispose()
  }
}

async function replayInstalled(t, artifact, from, to, { guarded = false, held = false, candidate } = {}) {
  const f = profileFor(t, artifact)
  const supervisor = installedSupervisor(f, artifact)
  const rollback = await prepareRollback(t, f.plugin, from, to, f, guarded ? {
    switchTimeBytes: rosterBytes(from, { roles: held ? [pins.solver, pins.voice] : [pins.solver], revision: 42 }),
    trialRoles: to >= 4 ? [pins.solver, pins.registry] : [pins.solver],
  } : undefined)
  if (candidate && to >= 4) await writeCandidateTrial(t, candidate, f, rollback, from, to)
  const state = join(f.store, 'state.json')
  writeJsonAtomic(state, rollback.run, { profileDir: f.profileDir, durable: true })
  const { runSupervisor } = await import(pathToFileURL(supervisor.entry).href)
  const stop = new AbortController()
  let launches = 0
  let verdict
  const done = Promise.withResolvers()
  const running = runSupervisor({
    home: f.home, profile: f.profile, command: f.command, version: f.version, env: f.env,
    fetch: () => assert.fail('Unexpected release request during offline rollback'),
    signal: AbortSignal.any([stop.signal, t.signal]), healthTimeout: 15_000,
    onLaunchUrl() { launches++ },
    onSave(run) {
      if (run.phase === 'rolledBack' || run.phase === 'manualRecovery') {
        verdict = structuredClone(run)
        done.resolve()
      }
    },
  })
  try {
    await Promise.race([done.promise, running])
    assert.equal(verdict?.phase, held ? 'manualRecovery' : 'rolledBack')
    assert.equal(verdict.reason, 'health-failed')
    assert.equal(verdict.rollback.starts, 1)
    assert.equal(launches, 1)
    assert.equal(read(state).phase, verdict.phase)
    assert.equal(read(join(f.store, 'supervisor.json')).bootId, verdict.bootId)
    if (!held) assert.equal(read(join(f.store, 'listener.json')).listener, 'verified')
    const bytes = assertRollbackBytes(rollback, verdict)
    assert.equal(read(join(f.plugin, manifest)).version, f.version)
    t.diagnostic(JSON.stringify({
      ...artifact.provenance, supervisorVersion: f.version, supervisorSha256: supervisor.sha256,
      supervisorClosureSha256: supervisor.closureSha256, node: process.version, dsh: f.dshVersion,
      homeBinding: 'explicit isolated AUTOMAGIK_BOTS_HOME', runtimePins: f.runtimePins, dependencyPins: f.dependencyPins, entry: supervisor.entry, addons: [], loadedPlugin: { name: BOTS, version: f.version },
      health: verdict.phase, bootId: verdict.bootId, runId: verdict.runId, bytes,
      input: 'synthetic failed trial and journal; real copied supervisor, restored plugin and DSH HTTP health',
    }))
  } finally {
    stop.abort()
    await running
  }
  assert.equal(fs.existsSync(join(f.store, 'update.lock')), false)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tarball, lane, supervisor, commit, hash, candidatePath, candidateCommit, ...extra] = process.argv.slice(2)
  assert.ok(tarball && lane && supervisor && commit && hash && !extra.length
    && Boolean(candidatePath) === Boolean(candidateCommit),
    'Usage: w1-format-installed.mjs <bots.tgz> <lane.json> <supervisor/main.js> <commit> <sha256> [candidate.tgz candidate-commit]')
  const artifact = verifyArtifact({ tarball: resolve(tarball), lane: resolve(lane), supervisor: resolve(supervisor), commit, hash })
  const guarded = artifact.provenance.classification === 'guarded-f'
  let candidate
  if (candidatePath) {
    assert.ok(guarded)
    assert.match(candidateCommit, /^[a-f0-9]{40}$/)
    const bytes = fs.readFileSync(candidatePath)
    candidate = { candidate: true, bytes, provenance: { version: artifact.provenance.version,
      commit: candidateCommit, tarballSha256: sha256(bytes) } }
  }
  test('verified installed predecessor store and role writer', async t => {
    const f = profileFor(t, artifact)
    t.diagnostic(JSON.stringify({ ...artifact.provenance, node: process.version, dsh: f.dshVersion, lifecycle: 'direct module calls' }))
    for (const cell of legacyCells) {
      await t.test(cell.shape + ' in roster format ' + cell.format,
        sub => (guarded ? assertRefusedCell : assertLegacyCell)(sub, f.plugin, cell))
    }
    if (guarded) for (const format of [0, 1, 2, 3]) {
      await t.test('clean control ' + format, sub => assertCleanCell(sub, f.plugin, format))
    }
  })
  for (const [from, to] of rollbackCells) {
    test('installed predecessor rollback with roster ' + from + ' → ' + to, { timeout: 45_000 },
      t => replayInstalled(t, artifact, from, to, { guarded, candidate }))
    if (guarded && to >= 4) test('guarded F restores held roster ' + from + ' → ' + to, { timeout: 45_000 },
      t => replayInstalled(t, artifact, from, to, { guarded, held: true, candidate }))
  }
}
