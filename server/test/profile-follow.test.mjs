import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { followImage, installOffline } from '../profile-follow.mjs'
import { profileDirOf } from '../lib.mjs'
import { compareRelease, FOLLOW_STATUS, installedPlugins, markSeed, ownership, packageHash, profileState, SEED_MARKER } from '../profile-state.mjs'
import { materializePlugins, packPlugin, PLUGINS } from '../plugin-payload.mjs'
import { buildOfflineStore } from '../offline-store.mjs'
import { healthReport } from '../healthcheck.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { VOLUME_LOCK, withVolumeLock } from '../volume-lock.mjs'
import { parse, stringify } from 'yaml'

const original = JSON.parse(readFileSync(new URL('../profile/package.json', import.meta.url), 'utf8'))
const write = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
function image(root, release) {
  const source = join(root, 'profile'), build = { automagik: release, revision: 'a'.repeat(40), plugins: Object.fromEntries(PLUGINS.map(name => [name, release])) }
  const pkg = structuredClone(original)
  const lock = { lockfileVersion: '9.0', importers: { '.': { dependencies: {} } }, packages: {}, snapshots: {} }
  for (const name of PLUGINS) {
    const file = `automagik-${name.split('/')[1]}-${release}.tgz`
    pkg.dependencies[name] = `file:vendor/${file}`
    const dir = join(source, 'node_modules', ...name.split('/'))
    write(join(dir, 'package.json'), JSON.stringify({ name, version: release }))
    write(join(dir, 'main.js'), `export default ${JSON.stringify(release)}\n`)
    lock.importers['.'].dependencies[name] = { specifier: `file:vendor/${file}`, version: `file:vendor/${file}` }
    lock.packages[`${name}@file:vendor/${file}`] = { resolution: { integrity: 'sha512-AAAA', tarball: `file:vendor/${file}` }, version: release }
    lock.snapshots[`${name}@file:vendor/${file}`] = {}
  }
  write(join(source, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  write(join(source, 'pnpm-lock.yaml'), stringify(lock))
  write(join(source, 'cordis.patch.yml'), '[]\n')
  write(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  write(join(root, 'versions.json'), JSON.stringify(build))
  const store = join(root, 'offline-store'); mkdirSync(store, { recursive: true })
  return { source, build, store }
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-follow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dshHome = join(dir, 'data', 'dsh'), old = image(join(dir, 'old'), '3.90.1'), next = image(join(dir, 'image'), '3.93.0')
  mkdirSync(dshHome, { recursive: true })
  return { dir, dshHome, old, next, target: profileDirOf(dshHome) }
}
const successful = source => ({ profile }) => cpSync(join(source, 'node_modules'), join(profile, 'node_modules'), { recursive: true })
const prepare = async (f, img = f.old, install = successful(img.source)) => followImage({ dshHome: f.dshHome, ...img, install })

// Each child imports the real implementation. File barriers hold the first mutation
// open so the second process attempts the same volume while its peer is still active.
const childProgram = `
import fs from 'node:fs/promises';
import { existsSync, writeFileSync, appendFileSync, cpSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const c = JSON.parse(process.argv[1]);
const wait = async () => { while (!existsSync(c.release)) await delay(10); };
if (c.holdSeed) {
  const cp = fs.cp;
  fs.cp = async (source, target, options) => {
    if (String(target).includes('.installing')) {
      writeFileSync(c.entered, String(target));
      await wait();
    }
    return cp(source, target, options);
  };
  syncBuiltinESMExports();
}
writeFileSync(c.called, 'called');
let result;
if (c.directSeed) {
  const { seedProfile } = await import(c.lib);
  result = await seedProfile(c.options);
} else {
  const { followImage } = await import(c.follow);
  result = await followImage({ ...c.options, install: async ({ profile }) => {
    appendFileSync(c.installs, 'install\\n');
    writeFileSync(c.entered, 'installing');
    await wait();
    cpSync(c.options.source + '/node_modules', profile + '/node_modules', { recursive: true });
  }});
}
console.log(JSON.stringify(result));
`
function startFollower(t, f, img, name, extra = {}) {
  const c = { follow: new URL('../profile-follow.mjs', import.meta.url).href, lib: new URL('../lib.mjs', import.meta.url).href,
    options: { dshHome: f.dshHome, ...img, release: img.build.automagik }, called: join(f.dir, `${name}-called`),
    entered: join(f.dir, `${name}-entered`), release: join(f.dir, 'release'), installs: join(f.dir, 'installs'), ...extra }
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram, JSON.stringify(c)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done })
  return { ...c, child, done, result: async () => { const out = await done; assert.equal(out.code, 0, out.stderr); return JSON.parse(out.stdout) } }
}
async function waitFile(file) {
  const deadline = Date.now() + 5000
  while (!existsSync(file)) { assert.ok(Date.now() < deadline, `child did not reach ${file}`); await delay(10) }
}
const lockProbe = f => spawnSync('/usr/bin/flock', ['--nonblock', join(f.dshHome, VOLUME_LOCK), process.execPath, '-e', '']).status

// VOLUME_NO_LOCK: a second follower must wait and re-read the first follower's completed seed/update.
for (const fresh of [true, false]) test(`two processes serialize ${fresh ? 'fresh seeding' : 'an existing-volume upgrade'} and reuse the winner`, { timeout: 15000 }, async t => {
  const f = fixture(t)
  if (!fresh) await prepare(f)
  const first = startFollower(t, f, f.next, 'first', { holdSeed: fresh })
  await waitFile(first.entered)
  assert.equal(lockProbe(f), 1, 'the parent retains the kernel lease after its flock helper exits')
  const second = startFollower(t, f, f.next, 'second')
  await waitFile(second.called)
  await delay(100)
  assert.equal(second.child.exitCode, null, 'the competing follower waits for the entire mutation')
  writeFileSync(first.release, '')
  const a = await first.result(), b = await second.result()
  assert.equal(a.result, fresh ? 'seeded' : 'updated'); assert.equal(b.result, 'matching-image')
  assert.equal(a.seeded, fresh); assert.equal(b.seeded, false)
  assert.equal(packageHash(f.target), JSON.parse(readFileSync(join(f.target, SEED_MARKER))).packageSha256)
  assert.ok(Object.values(installedPlugins(f.target)).every(v => v === f.next.build.automagik))
  assert.equal(lockProbe(f), 0)
  if (!fresh) {
    assert.equal(readFileSync(first.installs, 'utf8'), 'install\n', 'only one offline install runs')
    assert.equal(readdirSync(join(f.dshHome, 'backups')).length, 1)
  }
})

// SEED_SHARED_STAGE: independent seed callers may never delete each other's temporary copy.
test('two independent seed processes use distinct stages and preserve a completed competing seed', { timeout: 15000 }, async t => {
  const f = fixture(t)
  const a = startFollower(t, f, f.next, 'a', { directSeed: true, holdSeed: true })
  await waitFile(a.entered)
  const b = startFollower(t, f, f.next, 'b', { directSeed: true, holdSeed: true })
  await waitFile(b.entered)
  assert.notEqual(readFileSync(a.entered, 'utf8'), readFileSync(b.entered, 'utf8'))
  writeFileSync(a.release, '')
  const results = await Promise.all([a.result(), b.result()])
  assert.equal(results.filter(r => r.seeded).length, 1)
  assert.equal(ownership(f.target, f.next.source).managed, true)
  assert.ok(Object.values(installedPlugins(f.target)).every(v => v === f.next.build.automagik))
  assert.deepEqual(readdirSync(join(f.dshHome, 'profiles')), ['automagik-web'])
})

test('a killed follower releases its kernel lease so another process can seed the volume', { timeout: 15000 }, async t => {
  const f = fixture(t), first = startFollower(t, f, f.next, 'killed', { holdSeed: true })
  await waitFile(first.entered); assert.equal(lockProbe(f), 1)
  first.child.kill('SIGKILL'); assert.equal((await first.done).signal, 'SIGKILL')
  assert.equal(lockProbe(f), 0)
  const next = startFollower(t, f, f.next, 'survivor')
  assert.equal((await next.result()).result, 'seeded')
  assert.equal(ownership(f.target, f.next.source).managed, true)
})

test('a failed mutation releases the lease without replacing its private lock inode', async t => {
  const f = fixture(t), file = join(f.dshHome, VOLUME_LOCK)
  let inode
  await assert.rejects(withVolumeLock(f.dshHome, () => {
    const info = statSync(file); inode = info.ino
    assert.equal(info.mode & 0o777, 0o600); assert.equal(lockProbe(f), 1)
    throw new Error('failed mutation')
  }), /failed mutation/)
  assert.equal(lockProbe(f), 0)
  await withVolumeLock(f.dshHome, () => assert.equal(statSync(file).ino, inode))
})

// FOLLOW_NO_BACKUP: starting installation without preserving the old package/lock loses recovery.
test('fresh seed records its package hash; a newer image installs in staging after a full backup', async t => {
  const f = fixture(t)
  assert.equal((await prepare(f)).seeded, true)
  const marker = JSON.parse(readFileSync(join(f.target, SEED_MARKER), 'utf8'))
  assert.equal(marker.packageSha256, packageHash(f.target)); assert.equal(marker.release, '3.90.1')
  write(join(f.target, 'cordis.patch.yml'), 'owner settings\n')
  write(join(f.target, 'vendor', 'owner-plugin.tgz'), 'owner archive\n')
  let backupPresent = false, calls = 0
  const beforePackage = readFileSync(join(f.target, 'package.json'), 'utf8'), beforeLock = readFileSync(join(f.target, 'pnpm-lock.yaml'), 'utf8')
  const upgraded = await prepare(f, f.next, async args => {
    calls++; assert.notEqual(args.profile, f.target)
    const backups = join(f.dshHome, 'backups'), stamps = readdirSync(backups)
    assert.equal(stamps.length, 1); assert.match(stamps[0], /^\d{4}-\d\d-\d\dT/)
    const backup = join(backups, stamps[0], 'automagik-web')
    backupPresent = existsSync(join(backup, 'package.json')) && existsSync(join(backup, 'pnpm-lock.yaml'))
    assert.equal(readFileSync(join(backup, 'package.json'), 'utf8'), beforePackage)
    assert.equal(readFileSync(join(backup, 'pnpm-lock.yaml'), 'utf8'), beforeLock)
    assert.equal(installedPlugins(backup)[PLUGINS[0]], '3.90.1')
    assert.equal(installedPlugins(f.target)[PLUGINS[0]], '3.90.1', 'live profile stays old during installation')
    successful(f.next.source)(args)
  })
  assert.ok(backupPresent); assert.equal(calls, 1); assert.equal(upgraded.result, 'updated')
  assert.equal(upgraded.followsImage, true)
  assert.ok(Object.values(installedPlugins(f.target)).every(v => v === '3.93.0'))
  assert.equal(readFileSync(join(f.target, 'cordis.patch.yml'), 'utf8'), 'owner settings\n')
  assert.equal(JSON.parse(readFileSync(join(f.target, SEED_MARKER), 'utf8')).packageSha256, packageHash(f.target))
  assertInstallInputs(f.target)
  // VENDOR_ACCUMULATES: every update would leave the previous release's archives (~10 MB).
  const archives = PLUGINS.map(name => `automagik-${name.split('/')[1]}-3.93.0.tgz`)
  assert.deepEqual(readdirSync(join(f.target, 'vendor')).sort(), [...archives, 'owner-plugin.tgz'].sort())
  const backupVendor = join(f.dshHome, 'backups', readdirSync(join(f.dshHome, 'backups'))[0], 'automagik-web', 'vendor')
  assert.ok(readdirSync(backupVendor).includes('automagik-bots-dsh-3.90.1.tgz'), 'the backup keeps the old archives')
})

function assertInstallInputs(profile) {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  const lock = parse(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'))
  for (const name of PLUGINS) {
    const bytes = readFileSync(join(profile, manifest.dependencies[name].slice(5)))
    assert.ok(gunzipSync(bytes).includes(Buffer.from('package/package.json')))
    assert.deepEqual(lock.packages[`${name}@${manifest.dependencies[name]}`].resolution, {
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, tarball: manifest.dependencies[name],
    })
  }
}

test('fresh and legacy matching seeds retain valid inputs for subsequent plugin installs', async t => {
  const f = fixture(t)
  await prepare(f)
  assertInstallInputs(f.target)
  assert.equal(existsSync(join(f.old.source, 'vendor')), false, 'the scanned image stays archive-free')
  rmSync(join(f.target, 'vendor'), { recursive: true })
  cpSync(join(f.old.source, 'pnpm-lock.yaml'), join(f.target, 'pnpm-lock.yaml'))
  assert.equal((await prepare(f)).result, 'matching-image')
  assertInstallInputs(f.target)
  // Simulate interruption after archive writes, before the lock receives their integrity.
  cpSync(join(f.old.source, 'pnpm-lock.yaml'), join(f.target, 'pnpm-lock.yaml'))
  assert.equal((await prepare(f)).result, 'matching-image')
  assertInstallInputs(f.target)
})

test('a missing or legacy marker is adopted only for the complete canonical image seed shape', async t => {
  for (const legacy of [undefined, 'unknown\n']) {
    const f = fixture(t)
    cpSync(f.old.source, f.target, { recursive: true })
    if (legacy) write(join(f.target, SEED_MARKER), legacy)
    assert.equal((await prepare(f, f.next)).result, 'updated')
    assert.equal(ownership(f.target, f.next.source).managed, true)
  }
  const f = fixture(t)
  cpSync(f.old.source, f.target, { recursive: true })
  const pkg = JSON.parse(readFileSync(join(f.target, 'package.json'), 'utf8')); pkg.extra = 'owner setting'
  const raw = `${JSON.stringify(pkg, null, 2)}\n`; write(join(f.target, 'package.json'), raw)
  let called = false
  const result = await prepare(f, f.next, () => { called = true })
  assert.equal(result.ownerManaged, true); assert.equal(called, false)
  assert.equal(readFileSync(join(f.target, 'package.json'), 'utf8'), raw)
  assert.equal(existsSync(join(f.target, SEED_MARKER)), false)
})

// FOLLOW_IGNORE_OWNER: ignoring a changed package hash silently replaces the owner's manifest.
test('an owner-edited package remains byte-for-byte unchanged and is reported as owner-managed', async t => {
  const f = fixture(t); await prepare(f)
  const pkg = JSON.parse(readFileSync(join(f.target, 'package.json'), 'utf8')); pkg.description = 'owner-managed profile'
  const raw = `${JSON.stringify(pkg, null, 2)}\n`; write(join(f.target, 'package.json'), raw)
  let called = false
  const result = await prepare(f, f.next, () => { called = true })
  assert.equal(result.ownerManaged, true); assert.equal(result.reason, 'owner-managed'); assert.equal(called, false)
  assert.equal(readFileSync(join(f.target, 'package.json'), 'utf8'), raw)
  assert.equal(installedPlugins(f.target)[PLUGINS[0]], '3.90.1')
})

function addPlugin(profile, name = '@example/channels') {
  const path = join(profile, 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8'))
  const spec = `https://example.invalid/${name.split('/')[1]}-1.2.3.tgz`
  const peer = `(@automagik/bots-dsh@${pkg.dependencies['@automagik/bots-dsh']})`
  pkg.dependencies[name] = spec; pkg.dsh.profile.bundles.push(name)
  write(path, `${JSON.stringify(pkg, null, 2)}\n`)
  write(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.2.3' }))
  const lockPath = join(profile, 'pnpm-lock.yaml'), lock = parse(readFileSync(lockPath, 'utf8'))
  lock.importers['.'].dependencies[name] = { specifier: spec, version: `${spec}${peer}` }
  lock.packages[`${name}@${spec}`] = { resolution: { integrity: 'sha512-EXTRA', tarball: spec }, version: '1.2.3' }
  lock.snapshots[`${name}@${spec}${peer}`] = { optionalDependencies: { '@automagik/bots-dsh': pkg.dependencies['@automagik/bots-dsh'] } }
  write(lockPath, stringify(lock, { lineWidth: 0 }))
  return { name, spec }
}

// FOLLOW_ADDITIONS_OPT_OUT / FOLLOW_DROP_ADDITIONS / FOLLOW_STALE_PEERS.
for (const legacy of [false, true]) test(`welcome-added plugins follow newer images and retain their locks (${legacy ? 'old' : 'new'} marker)`, async t => {
  const f = fixture(t); await prepare(f)
  if (legacy) {
    const markerPath = join(f.target, SEED_MARKER), marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    delete marker.imagePackage; write(markerPath, JSON.stringify(marker))
  }
  const added = [addPlugin(f.target), addPlugin(f.target, '@example/canvas')]
  const beforePackage = readFileSync(join(f.target, 'package.json'), 'utf8')
  assert.equal(ownership(f.target, f.next.source).managed, true)
  // A same-image restart must not replace the workspace's augmented lock with the seed lock.
  assert.equal((await prepare(f)).result, 'matching-image')
  assert.equal(readFileSync(join(f.target, 'package.json'), 'utf8'), beforePackage)
  const oldLock = parse(readFileSync(join(f.target, 'pnpm-lock.yaml'), 'utf8'))
  for (const { name } of added) assert.ok(oldLock.importers['.'].dependencies[name])
  const result = await prepare(f, f.next, ({ profile }) => {
    const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    const lock = parse(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'))
    for (const { name, spec } of added) {
      assert.equal(pkg.dependencies[name], spec)
      assert.ok(pkg.dsh.profile.bundles.includes(name))
      assert.deepEqual(lock.packages[`${name}@${spec}`], oldLock.packages[`${name}@${spec}`])
      const version = lock.importers['.'].dependencies[name].version
      assert.ok(version.includes('automagik-bots-dsh-3.93.0.tgz'))
      assert.ok(lock.snapshots[`${name}@${version}`])
      cpSync(join(f.target, 'node_modules', name), join(profile, 'node_modules', name), { recursive: true })
    }
    assert.ok(!JSON.stringify(lock).includes('automagik-bots-dsh-3.90.1.tgz'))
    successful(f.next.source)({ profile })
  })
  assert.equal(result.result, 'updated'); assert.equal(result.followsImage, true)
  assertInstallInputs(f.target)
  for (const { name, spec } of added) {
    assert.equal(JSON.parse(readFileSync(join(f.target, 'package.json'))).dependencies[name], spec)
    assert.equal(JSON.parse(readFileSync(join(f.target, 'node_modules', name, 'package.json'))).version, '1.2.3')
  }
  const backup = join(f.dshHome, 'backups', readdirSync(join(f.dshHome, 'backups'))[0], 'automagik-web')
  assert.equal(readFileSync(join(backup, 'package.json'), 'utf8'), beforePackage)
  addPlugin(f.target, '@example/genie')
  assert.equal(ownership(f.target, f.next.source).managed, true, 'a later addition still follows')
})

// FOLLOW_DROP_ADDITION_UNCHECKED: even a zero-exit partial install must roll back.
test('an update that loses an added plugin rolls back the entire augmented profile', async t => {
  const f = fixture(t); await prepare(f); const { name } = addPlugin(f.target)
  const before = ['package.json', 'pnpm-lock.yaml', SEED_MARKER].map(file => readFileSync(join(f.target, file), 'utf8'))
  const result = await prepare(f, f.next)
  assert.equal(result.result, 'update-rolled-back')
  assert.deepEqual(['package.json', 'pnpm-lock.yaml', SEED_MARKER].map(file => readFileSync(join(f.target, file), 'utf8')), before)
  assert.equal(JSON.parse(readFileSync(join(f.target, 'node_modules', name, 'package.json'))).version, '1.2.3')
  assert.equal(result.ownerManaged, false)
})

// FOLLOW_GIT_INDEX_UNSHARED: DSH installs a git-hosted plugin (Omni's) with scripts allowed;
// the update's --ignore-scripts install must still find it offline, or every update rolls back.
test('a git-hosted addition reinstalls offline from the index DSH recorded at its install', async t => {
  const f = fixture(t); await prepare(f); const { name } = addPlugin(f.target)
  const store = join(f.dshHome, 'pnpm-store', 'v10'), entry = join(store, 'https+++codeload.github.com+example+channels')
  const index = JSON.stringify({ name, version: '1.2.3', files: {} })
  write(join(entry, 'integrity.json'), index)
  const kept = join(store, 'https+++codeload.github.com+example+kept')
  write(join(kept, 'integrity.json'), '{"built":true}\n'); write(join(kept, 'integrity-not-built.json'), '{"built":false}\n')
  const result = await prepare(f, f.next, ({ profile }) => {
    // The index pnpm reads for a git-hosted package under --ignore-scripts.
    if (readFileSync(join(entry, 'integrity-not-built.json'), 'utf8') !== index) throw new Error('ERR_PNPM_NO_OFFLINE_TARBALL')
    successful(f.next.source)({ profile })
    cpSync(join(f.target, 'node_modules', name), join(profile, 'node_modules', name), { recursive: true })
  })
  assert.equal(result.result, 'updated')
  assert.equal(readFileSync(join(kept, 'integrity-not-built.json'), 'utf8'), '{"built":false}\n', 'an index pnpm wrote stays')
  assert.equal(JSON.parse(readFileSync(join(f.target, 'node_modules', name, 'package.json'))).version, '1.2.3')
})

// MATCHING_LOCK_CRASH: a workspace lock that cannot be read must not stop the server at start.
test('a matching image restores its inputs from its own lock when the workspace lock is unreadable', async t => {
  const f = fixture(t); await prepare(f)
  rmSync(join(f.target, 'vendor'), { recursive: true })
  write(join(f.target, 'pnpm-lock.yaml'), 'packages: [\n')
  assert.equal((await prepare(f)).result, 'matching-image')
  assertInstallInputs(f.target)
})

// S10 MARKER_RECORDS_MERGED: the marker's base must stay the image's own manifest, or a plugin
// the person later removes reads as an edit to the image's part and the profile stops following.
test('after an update the marker records the image manifest, so removing an added plugin still follows', async t => {
  const f = fixture(t); await prepare(f); const { name } = addPlugin(f.target)
  const result = await prepare(f, f.next, ({ profile }) => {
    successful(f.next.source)({ profile })
    cpSync(join(f.target, 'node_modules', name), join(profile, 'node_modules', name), { recursive: true })
  })
  assert.equal(result.result, 'updated')
  const marker = JSON.parse(readFileSync(join(f.target, SEED_MARKER), 'utf8'))
  assert.deepEqual(marker.imagePackage, JSON.parse(readFileSync(join(f.next.source, 'package.json'), 'utf8')))
  assert.equal(marker.packageSha256, packageHash(f.target))
  const path = join(f.target, 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8'))
  delete pkg.dependencies[name]; pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(bundle => bundle !== name)
  write(path, `${JSON.stringify(pkg, null, 2)}\n`)
  assert.equal(ownership(f.target, f.next.source).managed, true, 'removing an added plugin keeps the profile following')
})

// S7 ADDED_PLUGIN_NOT_INSTALLED: an added plugin missing before the update cannot be shown to
// survive it, so nothing is staged and the live profile stays as it is.
test('an added plugin that is not installed stops the update before anything is staged', async t => {
  const f = fixture(t); await prepare(f); const { name } = addPlugin(f.target)
  rmSync(join(f.target, 'node_modules', name), { recursive: true })
  const files = ['package.json', 'pnpm-lock.yaml', SEED_MARKER], before = files.map(file => readFileSync(join(f.target, file), 'utf8'))
  let called = false
  const result = await prepare(f, f.next, args => { called = true; successful(f.next.source)(args) })
  assert.equal(result.result, 'update-rolled-back'); assert.equal(called, false)
  assert.equal(existsSync(join(f.dshHome, 'backups')), false)
  assert.deepEqual(files.map(file => readFileSync(join(f.target, file), 'utf8')), before)
  assert.equal(installedPlugins(f.target)[PLUGINS[0]], '3.90.1')
})

// S3 BUNDLE_WITHOUT_DEPENDENCY, N5 DUPLICATE_ADDED_BUNDLE: neither is what the welcome or DSH writes.
test('changes to the image-owned dependencies, bundles or metadata still opt out', async t => {
  for (const change of [
    pkg => { pkg.dependencies[PLUGINS[0]] = '1.0.0' },
    pkg => { delete pkg.dependencies[PLUGINS[0]] },
    pkg => { pkg.dsh.profile.bundles.shift() },
    pkg => { pkg.dsh.profile.bundles.reverse() },
    pkg => { pkg.scripts = { start: 'custom' } },
    pkg => { pkg.dsh.profile.bundles.push('@example/not-a-dependency') },
    pkg => { pkg.dsh.profile.bundles.push(pkg.dsh.profile.bundles.at(-1)) },
  ]) {
    const f = fixture(t); await prepare(f); addPlugin(f.target)
    const path = join(f.target, 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8')); change(pkg)
    const raw = JSON.stringify(pkg); write(path, raw)
    const result = await prepare(f, f.next, () => assert.fail('owner profile must not install'))
    assert.equal(result.ownerManaged, true); assert.equal(readFileSync(path, 'utf8'), raw)
  }
})

// FOLLOW_OWNER_CHANGED_DURING_INSTALL: a late owner edit must still win over the staged image.
test('an owner package edit during staging cancels cutover and preserves the live profile', async t => {
  const f = fixture(t); await prepare(f)
  const pkg = JSON.parse(readFileSync(join(f.target, 'package.json'), 'utf8')); pkg.description = 'owner edit during update'
  const raw = `${JSON.stringify(pkg, null, 2)}\n`
  const result = await prepare(f, f.next, args => {
    successful(f.next.source)(args)
    write(join(f.target, 'package.json'), raw)
  })
  assert.equal(result.ownerManaged, true); assert.equal(result.result, 'owner-managed')
  assert.equal(readFileSync(join(f.target, 'package.json'), 'utf8'), raw)
  assert.ok(Object.values(installedPlugins(f.target)).every(v => v === '3.90.1'))
})

// FOLLOW_INSTALL_LIVE: directing a partial install at the live profile corrupts rollback.
test('a partial install failure preserves the old package, lock and all installed plugins and reports rollback', async t => {
  const f = fixture(t); await prepare(f)
  const before = [readFileSync(join(f.target, 'package.json'), 'utf8'), readFileSync(join(f.target, 'pnpm-lock.yaml'), 'utf8'), readFileSync(join(f.target, SEED_MARKER), 'utf8')]
  let calls = 0
  const result = await prepare(f, f.next, ({ profile }) => {
    calls++; write(join(profile, 'node_modules', ...PLUGINS[0].split('/'), 'package.json'), JSON.stringify({ name: PLUGINS[0], version: '3.93.0' }))
    write(join(profile, 'pnpm-lock.yaml'), 'partial install\n'); throw new Error('private installer diagnostics must not escape')
  })
  assert.equal(calls, 1); assert.equal(result.result, 'update-rolled-back'); assert.equal(result.reason, 'update-rolled-back')
  assert.deepEqual([readFileSync(join(f.target, 'package.json'), 'utf8'), readFileSync(join(f.target, 'pnpm-lock.yaml'), 'utf8'), readFileSync(join(f.target, SEED_MARKER), 'utf8')], before)
  assert.ok(Object.values(installedPlugins(f.target)).every(v => v === '3.90.1'))
  assert.equal(JSON.parse(readFileSync(join(f.dshHome, FOLLOW_STATUS), 'utf8')).result, 'update-rolled-back')
  const report = await healthReport({ root: dirname(f.next.source), dshHome: f.dshHome, env: {}, probe: async () => 401 })
  assert.equal(report.reason, 'update-rolled-back'); assert.equal(report.healthy, false)
  assert.equal((await prepare(f, f.next)).result, 'updated', 'a later restart can retry the failed image update')
})

// FOLLOW_DOWNGRADE: disabling both ordering guards overwrites newer plugins with an older image.
test('equal and older images never install or downgrade plugins', async t => {
  const f = fixture(t); await prepare(f, f.next)
  let called = false
  assert.equal((await prepare(f, f.next, () => { called = true })).result, 'matching-image')
  assert.equal((await prepare(f, f.old, args => { called = true; successful(f.old.source)(args) })).reason, 'newer-than-image')
  assert.equal(called, false); assert.ok(Object.values(installedPlugins(f.target)).every(v => v === '3.93.0'))
  for (const [a,b,expected] of [['3.90.1','3.93.0',-1],['3.93.0','3.93.0-rc.1',1],['3.93.0-rc.2','3.93.0-rc.10',-1]]) assert.equal(compareRelease(a,b), expected)
})

// FOLLOW_SKIP_RECOVERY: seeding over an interrupted swap loses the old profile's settings.
test('an interrupted directory swap restores the previous owned profile before first-seed logic', async t => {
  const f = fixture(t); await prepare(f)
  renameSync(f.target, `${f.target}.image-previous`)
  const result = await prepare(f, f.next)
  assert.equal(result.seeded, false); assert.equal(result.result, 'update-rolled-back')
  assert.equal(installedPlugins(f.target)[PLUGINS[0]], '3.90.1')
  assert.equal(existsSync(`${f.target}.image-previous`), false)
})

// FOLLOW_SKIP_VERSION_VERIFY: a successful installer exit is not proof all three plugins moved.
test('a zero-exit partial install rolls back unless all three installed plugin versions match', async t => {
  const f = fixture(t); await prepare(f)
  const result = await prepare(f, f.next, ({ profile }) => {
    const dir = join(profile, 'node_modules', ...PLUGINS[0].split('/'))
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PLUGINS[0], version: '3.93.0' }))
  })
  assert.equal(result.result, 'update-rolled-back')
  assert.ok(Object.values(installedPlugins(f.target)).every(v => v === '3.90.1'))
})

test('unsupported seed records are preserved and cannot turn into a new seed or owner-managed exception', async t => {
  const f = fixture(t); await prepare(f)
  const raw = JSON.stringify({ version: 2, packageSha256: packageHash(f.target) }); write(join(f.target, SEED_MARKER), raw)
  const result = await prepare(f, f.next)
  assert.equal(result.ownerManaged, false); assert.equal(result.followsImage, false); assert.equal(result.reason, 'unsupported-seed-marker')
  assert.equal(readFileSync(join(f.target, SEED_MARKER), 'utf8'), raw)
})

// FOLLOW_ONLINE_INSTALL: omitting offline/frozen flags lets runtime resolution reach the network.
test('the real installer invokes DSH with offline, frozen, production and no-script arguments', t => {
  const f = fixture(t), bin = join(f.dir, 'fake-dsh.mjs')
  write(bin, `import {writeFileSync} from 'node:fs';writeFileSync(process.env.DSH_HOME+'/argv.json',JSON.stringify(process.argv.slice(2)))`)
  installOffline({ dshBin: bin, profile: f.dshHome, dshHome: f.dshHome })
  assert.deepEqual(JSON.parse(readFileSync(join(f.dshHome, 'argv.json'), 'utf8')), ['plugin','--profile','automagik-web','install','--offline','--frozen-lockfile','--prod','--ignore-scripts'])
})

test('local tarballs contain the inspected plugin files and their exact integrity reaches the lock', t => {
  const f = fixture(t), target = join(f.dir, 'materialized')
  materializePlugins({ source: f.next.source, target })
  const lock = readFileSync(join(target, 'pnpm-lock.yaml'), 'utf8')
  for (const name of PLUGINS) {
    const dir = join(f.next.source, 'node_modules', ...name.split('/')), bytes = packPlugin(dir)
    assert.ok(gunzipSync(bytes).includes(Buffer.from('package/package.json')))
    assert.ok(lock.includes(`sha512-${createHash('sha512').update(bytes).digest('base64')}`))
  }
})

// STORE_INCLUDE_UNUSED: copying the raw cache also ships files the inspected profile pruned.
test('the offline cache retains only inspected files and validates each content hash', t => {
  const f = fixture(t), store = join(f.dir, 'cache'), profile = join(f.dir, 'pruned'), out = join(f.dir, 'offline')
  const kept = Buffer.from('runtime file'), removed = Buffer.from('uninspected fixture'), digest = b => createHash('sha512').update(b).digest('hex')
  const records = {}, add = (name,bytes) => {
    const hex = digest(bytes); write(join(store,'v10','files',hex.slice(0,2),hex.slice(2)),bytes)
    records[name] = { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, mode: 0o644, size: bytes.length }
  }
  const pkg = Buffer.from(JSON.stringify({name:'fixture',version:'1.0.0'}))
  add('package.json',pkg); add('index.js',kept); add('tests/private.txt',removed)
  write(join(store,'v10','index','aa','fixture.json'),JSON.stringify({name:'fixture',version:'1.0.0',files:records}))
  write(join(profile,'node_modules','fixture','package.json'),pkg); write(join(profile,'node_modules','fixture','index.js'),kept)
  assert.equal(buildOfflineStore({store,profile,out}).packages,1)
  const index = JSON.parse(readFileSync(join(out,'v10','index','aa','fixture.json'),'utf8'))
  assert.deepEqual(Object.keys(index.files).sort(),['index.js','package.json'])
  const hash = digest(removed)
  assert.equal(existsSync(join(out,'v10','files',hash.slice(0,2),hash.slice(2))),false)
  write(join(profile,'node_modules','fixture','index.js'),'changed')
  assert.throws(()=>buildOfflineStore({store,profile,out}),/differs from inspected/)
})
