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
import { verifyLane } from '../../src/host/lane-verify.js'
import { ROLE_KEYS } from '../../src/host/supervisor/release.js'
import { VENDOR } from '../../src/host/supervisor/stage.js'
import { prepareStore, writeJsonAtomic } from '../../src/host/supervisor/store.js'
import { BOTS, read, write } from './supervisor.mjs'
import { assertLegacyCell, assertRollbackBytes, legacyCells, prepareRollback, rollbackCells } from './w1-format-predecessor.mjs'
import { LEGACY_CONTRACT, readFormatContract, scratch, sha256 } from './w1-format-profile.mjs'

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const manifest = 'package.json'
const main = 'supervisor/main.js'
const inventory = 'supervisor/files.json'
const harness = join(checkout, 'dev/harness/node_modules')
const deps = join(checkout, 'node_modules')
const dsh = join(harness, '@deepseek-ai/dsh')
const web = '@deepseek-ai/dsh-web-app'
const base = '@deepseek-ai/dsh-base'

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
  return {
    bytes, supervisor: dirname(dirname(supervisor)),
    provenance: { commit, version: release.version, tarballSha256: hash, feedSha256: sha256(feed), signature: 'verified', keyId: release.keyId },
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
  const runtimePins = Object.fromEntries([base, web].map(name => [name, read(join(modules, name, manifest)).version]))
  write(join(profileDir, manifest), {
    name: 'w1-format-fixture', private: true,
    dependencies: { [BOTS]: pin, ...runtimePins },
    dsh: { profile: { bundles: [base, web, BOTS] } },
  })
  fs.writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# Fixture pin: ${pin}\n`)
  assert.deepEqual(readFormatContract(plugin).contract, LEGACY_CONTRACT)
  const store = prepareStore(profileDir)
  const dshVersion = read(join(dsh, manifest)).version
  const expectedDsh = read(join(checkout, 'dev/harness', manifest)).dependencies['@deepseek-ai/dsh']
  assert.equal(dshVersion, expectedDsh)
  const command = [process.execPath, join(dsh, 'lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0']
  const candidateVersion = version.replace(/\d+$/, patch => String(Number(patch) + 1))
  return { home, profile, profileDir, store, botsHome, plugin, env, command, version, candidateVersion, dshVersion, runtimePins }
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

async function replayInstalled(t, artifact, from, to) {
  const f = profileFor(t, artifact)
  const supervisor = installedSupervisor(f, artifact)
  const rollback = await prepareRollback(t, f.plugin, from, to, f)
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
    assert.equal(verdict?.phase, 'rolledBack', 'The restored DSH child must pass the real supervisor health gate')
    assert.equal(verdict.rollback.starts, 1)
    assert.equal(launches, 1)
    assert.equal(read(state).phase, 'rolledBack')
    assert.equal(read(join(f.store, 'supervisor.json')).bootId, verdict.bootId)
    assert.equal(read(join(f.store, 'listener.json')).listener, 'verified')
    const bytes = assertRollbackBytes(rollback, verdict)
    assert.equal(read(join(f.plugin, manifest)).version, f.version)
    t.diagnostic(JSON.stringify({
      ...artifact.provenance, supervisorVersion: f.version, supervisorSha256: supervisor.sha256,
      supervisorClosureSha256: supervisor.closureSha256, node: process.version, dsh: f.dshVersion,
      homeBinding: 'explicit isolated AUTOMAGIK_BOTS_HOME', runtimePins: f.runtimePins, addons: [], loadedPlugin: { name: BOTS, version: f.version },
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
  const [tarball, lane, supervisor, commit, hash, ...extra] = process.argv.slice(2)
  assert.ok(tarball && lane && supervisor && commit && hash && !extra.length,
    'Usage: w1-format-installed.mjs <bots.tgz> <lane.json> <supervisor/main.js> <commit> <sha256>')
  const artifact = verifyArtifact({ tarball: resolve(tarball), lane: resolve(lane), supervisor: resolve(supervisor), commit, hash })
  test('verified installed predecessor store and role writer', async t => {
    const f = profileFor(t, artifact)
    t.diagnostic(JSON.stringify({ ...artifact.provenance, node: process.version, dsh: f.dshVersion, lifecycle: 'direct module calls' }))
    for (const cell of legacyCells) {
      await t.test(cell.shape + ' in roster format ' + cell.format, sub => assertLegacyCell(sub, f.plugin, cell))
    }
  })
  for (const [from, to] of rollbackCells) {
    test('installed predecessor rollback with roster ' + from + ' → ' + to, { timeout: 45_000 },
      t => replayInstalled(t, artifact, from, to))
  }
}
