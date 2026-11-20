import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runCommand } from '../src/host/supervisor/child.js'
import { lockPins, relink, stageInstall, takeProfileLock, VENDOR } from '../src/host/supervisor/stage.js'
import { completeSwitch, planSwitch } from '../src/host/supervisor/switch.js'
import { pnpmLock, verifyOfflineLock } from './fixtures/supervisor-lock.mjs'
import { BOTS, digest, eventsOf, fixture, FROM, putDownloads, read, TO, WELCOME, write } from './fixtures/supervisor.mjs'

test('stages the whole set in one DSH add and requests a frozen offline install', async t => {
  const f = fixture(t, { plugins: [BOTS, WELCOME] })
  const inputs = putDownloads(f)
  fs.writeFileSync(join(f.profileDir, 'package.json.lock'), '2147483647\n')
  const release = await takeProfileLock(f.profileDir)
  try {
    assert.equal(fs.readFileSync(join(f.profileDir, 'package.json.lock'), 'utf8'), `${process.pid}\n`)
    await stageInstall(f.config, f.staging, inputs, f.versions)
    assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
    assert.deepEqual(read(join(f.staging.source, 'package.json')), f.manifest)
    assert.deepEqual(fs.readFileSync(join(f.profileDir, 'pnpm-workspace.yaml')),
      fs.readFileSync(join(f.staging.profileDir, 'pnpm-workspace.yaml')))
    for (const plugin of f.release) {
      const spec = read(join(f.staging.profileDir, 'package.json')).dependencies[plugin.name]
      const path = `${VENDOR}/${plugin.sha256}.tgz`
      assert.equal(spec, `file:${path}`)
      assert.equal(read(join(f.staging.profileDir, 'node_modules', plugin.name, 'package.json')).version, TO)
      const live = fs.statSync(join(f.profileDir, path))
      const staged = fs.statSync(join(f.staging.profileDir, path))
      assert.equal(live.ino, staged.ino)
      assert.equal(live.mode & 0o777, 0o600)
      assert.deepEqual(fs.readFileSync(join(f.profileDir, path)), f.tarballs.get(plugin.url))
    }
    assert.deepEqual(eventsOf(f).map(event => event.event), ['add', 'install'])
    assert.equal(eventsOf(f)[0].args.filter(arg => arg.startsWith('file:')).length, 2)
  } finally {
    release()
  }
  assert.equal(fs.existsSync(join(f.profileDir, 'package.json.lock')), false)
})

for (const mode of ['manifest-edit', 'workspace-edit', 'frozen-fails', 'bad-pin']) {
  test(`refuses staging when the fake install produces ${mode}`, async t => {
    const f = fixture(t, { mode })
    const release = await takeProfileLock(f.profileDir)
    try {
      await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions))
      assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
      assert.deepEqual(fs.readdirSync(join(f.profileDir, VENDOR)), [f.archive.split('/').at(-1)])
      assert.ok(fs.existsSync(join(f.profileDir, 'vendor/owner.tgz')))
    } finally {
      release()
    }
  })
}

test('refuses to replace an archive whose existing bytes do not match its name', async t => {
  const f = fixture(t)
  const path = join(f.profileDir, VENDOR, `${f.release[0].sha256}.tgz`)
  fs.writeFileSync(path, 'archive collision')
  const release = await takeProfileLock(f.profileDir)
  try {
    await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions), /content address/)
    assert.equal(fs.readFileSync(path, 'utf8'), 'archive collision')
    assert.deepEqual(eventsOf(f), [])
  } finally {
    release()
  }
})


test('DSH compatibility repair inherits all offline relink restrictions', async t => {
  const f = fixture(t, { mode: 'compatibility-repair' })
  Object.assign(f.env, { NPM_CONFIG_IGNORE_SCRIPTS: 'false', NPM_CONFIG_IGNORE_PNPMFILE: 'false', NPM_CONFIG_OFFLINE: 'false' })
  await assert.rejects(relink(f.config), /Supervisor subprocess failed/)
  assert.equal(fs.readFileSync(join(f.root, 'repair-inherited-restrictions'), 'utf8'), 'yes')
  assert.deepEqual(eventsOf(f), [{ event: 'install', live: true,
    args: ['--offline', '--frozen-lockfile', '--prod', '--ignore-scripts', '--ignore-pnpmfile'],
  }])
})

test('reclaims only old empty or proven dead PID locks and publishes complete PID records', async t => {
  const f = fixture(t)
  const path = join(f.profileDir, 'package.json.lock')
  for (const record of ['', '2147483647\n']) {
    fs.writeFileSync(path, record)
    fs.utimesSync(path, new Date(0), new Date(0))
    const release = await takeProfileLock(f.profileDir, AbortSignal.timeout(1500))
    try {
      assert.equal(fs.readFileSync(path, 'utf8'), process.pid + '\n')
      await assert.rejects(takeProfileLock(f.profileDir, AbortSignal.timeout(150)), { name: 'AbortError' })
    } finally {
      release()
    }
    assert.equal(fs.existsSync(path), false)
  }
})

test('preserves an incomplete DSH lock and explains ambiguous ownership on timeout', async t => {
  const f = fixture(t)
  const path = join(f.profileDir, 'package.json.lock')
  for (const record of ['', '2147483647', String(process.pid)]) {
    fs.writeFileSync(path, record)
    const age = Date.now() - (record ? 180_000 : 5000)
    fs.utimesSync(path, new Date(age), new Date(age))
    await assert.rejects(takeProfileLock(f.profileDir, AbortSignal.timeout(150)), { name: 'AbortError' })
    assert.equal(fs.readFileSync(path, 'utf8'), record)
  }
  const now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now + 120_001)
  clock.mock.mockImplementationOnce(() => now, 0)
  await assert.rejects(takeProfileLock(f.profileDir), /package.json.lock.*confirm its writer has exited/)
  assert.equal(fs.readFileSync(path, 'utf8'), String(process.pid))
})

for (const [name, file, text] of [
  ['workspace configuration dependencies', 'pnpm-workspace.yaml', '"configDependencies": { example: 1 }\n'],
  ['workspace pnpmfile', 'pnpm-workspace.yaml', 'pnpmfile: ./hooks.cjs\n'],
  ['workspace hooks', 'pnpm-workspace.yaml', 'hooks: {}\n'],
  ['workspace string-valued global virtual store', 'pnpm-workspace.yaml', 'enableGlobalVirtualStore: "false"\n'],
  ['workspace global virtual store', 'pnpm-workspace.yaml', 'enableGlobalVirtualStore: true\n'],
  ['profile npmrc configuration dependencies', '.npmrc', 'config-dependencies=example\n'],
]) {
  test('rejects ' + name + ' before calling pnpm', async t => {
    const f = fixture(t)
    fs.appendFileSync(join(f.profileDir, file), text)
    await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions), /Unsafe pnpm setting|Only registry=/)
    assert.equal(fs.existsSync(join(f.root, 'pnpm-probes')), false)
    assert.deepEqual(eventsOf(f), [])
  })
}

test('refuses conflicting spellings of a pnpm write setting before calling pnpm', async t => {
  const f = fixture(t)
  fs.appendFileSync(join(f.profileDir, 'pnpm-workspace.yaml'),
    'enableGlobalVirtualStore: true\nenable-global-virtual-store: false\n')
  await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions), /Ambiguous pnpm setting: enableglobalvirtualstore/)
  assert.equal(fs.existsSync(join(f.root, 'pnpm-probes')), false)
})

test('rejects array pnpmfile settings in the user npmrc before calling pnpm', async t => {
  const f = fixture(t)
  fs.writeFileSync(f.env.NPM_CONFIG_USERCONFIG, 'pnpmfile[]=./hooks.cjs\n')
  await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions), /Unsafe pnpm setting: pnpmfile/)
  assert.equal(fs.existsSync(join(f.root, 'pnpm-probes')), false)
})

for (const [label, configure] of [
  ['workspace lockfileDir in the live profile', f => fs.appendFileSync(join(f.profileDir, 'pnpm-workspace.yaml'), 'lockfileDir: ' + f.profileDir + '\n')],
  ['workspace modulesDir outside staging', f => fs.appendFileSync(join(f.profileDir, 'pnpm-workspace.yaml'), 'modulesDir: ../../../../external-modules\n')],
  ['workspace relative storeDir outside staging', f => {
    const path = join(f.profileDir, 'pnpm-workspace.yaml')
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace('/shared/pnpm-store', '../../../../external-store'))
  }],
  ['workspace storeDir in the live profile', f => {
    const path = join(f.profileDir, 'pnpm-workspace.yaml')
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace('/shared/pnpm-store', join(f.profileDir, 'store')))
  }],
  ['npmrc virtual-store-dir outside staging', f => {
    f.env.NPM_CONFIG_USERCONFIG = join(f.root, 'user.npmrc')
    fs.writeFileSync(f.env.NPM_CONFIG_USERCONFIG, 'virtual-store-dir=' + join(f.root, 'external-modules') + '\n')
  }],
  ['environment lockfile-dir in the live profile', f => { f.env.npm_config_lockfile_dir = f.profileDir }],
  ['workspace override in the live profile', f => { f.env.NPM_CONFIG_WORKSPACE_DIR = f.profileDir }],
  ['workspace virtual store through a staged symlink', f => {
    f.manifest.dependencies['custom-plugin'] = 'file:vendor/owner.tgz'
    write(join(f.profileDir, 'package.json'), f.manifest)
    fs.appendFileSync(join(f.profileDir, 'pnpm-workspace.yaml'), 'virtualStoreDir: vendor/owner.tgz\n')
  }],
  ['workspace modulesDir through a staged symlink', f => {
    f.manifest.dependencies['custom-plugin'] = 'file:vendor/owner.tgz'
    write(join(f.profileDir, 'package.json'), f.manifest)
    fs.appendFileSync(join(f.profileDir, 'pnpm-workspace.yaml'), 'modulesDir: vendor/owner.tgz\n')
  }],
]) {
  test('refuses ' + label + ' before DSH can write', async t => {
    const f = fixture(t)
    configure(f)
    f.env.SUPERVISOR_CONFIG_REAL = '1'
    const lock = join(f.profileDir, 'pnpm-lock.yaml')
    const bytes = fs.readFileSync(lock)
    await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions), /Unsafe staged pnpm write destination/)
    assert.deepEqual(eventsOf(f), [])
    assert.deepEqual(fs.readFileSync(lock), bytes)
    assert.equal(fs.existsSync(join(f.root, 'pnpm-probes')), false)
    assert.deepEqual(fs.readdirSync(join(f.profileDir, VENDOR)), [f.archive.split('/').at(-1)])
  })
}

test('retains a local dependency through staging and a frozen offline install after staging is removed', async t => {
  const f = fixture(t, { mode: 'offline-lock' })
  const local = join(f.profileDir, 'vendor/owner.tgz')
  f.manifest.dependencies['custom-plugin'] = 'file:vendor/owner.tgz'
  write(join(f.profileDir, 'package.json'), f.manifest)
  fs.writeFileSync(join(f.profileDir, 'pnpm-workspace.yaml'),
    'packages: [.]\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ' + join(f.root, 'offline-store') + '\n')
  const pack = async (name, version, output) => {
    const dir = fs.mkdtempSync(join(f.root, 'pack-'))
    fs.mkdirSync(join(dir, 'package'))
    write(join(dir, 'package/package.json'), { name, version })
    await runCommand('tar', ['-C', dir, '-czf', output, 'package'])
  }
  await pack('custom-plugin', '1.0.0', local)
  await pack(BOTS, FROM, f.archive)
  const latest = join(f.root, 'latest.tgz')
  await pack(BOTS, TO, latest)
  const tarball = fs.readFileSync(latest)
  const [plugin] = f.release
  Object.assign(plugin, {
    size: tarball.length, sha256: digest('sha256', tarball),
    integrity: 'sha512-' + digest('sha512', tarball, 'base64'),
  })
  f.tarballs.set(plugin.url, tarball)
  f.env.SUPERVISOR_PACKAGES = JSON.stringify({ [plugin.sha256]: { name: BOTS, version: TO } })
  f.env.COREPACK_ENABLE_NETWORK = '0'
  f.env.SUPERVISOR_CONFIG_REAL = '1'
  f.env.NPM_CONFIG_USERCONFIG = join(f.root, 'user.npmrc')
  f.env.XDG_CONFIG_HOME = join(f.root, 'config')
  const lock = join(f.profileDir, 'pnpm-lock.yaml')
  fs.writeFileSync(lock, pnpmLock(f.profileDir, f.manifest))
  const ownerBytes = fs.readFileSync(local)
  await stageInstall(f.config, f.staging, putDownloads(f), f.versions)
  const run = { from: FROM, to: TO, names: [BOTS] }
  run.journal = planSwitch(f.config, f.staging, run)
  completeSwitch(f.config, f.staging, run, () => {})
  fs.rmSync(f.staging.root, { recursive: true })
  const pins = lockPins(fs.readFileSync(lock, 'utf8'))
  assert.deepEqual(pins, new Set(['vendor/owner.tgz', VENDOR + '/' + plugin.sha256 + '.tgz']))
  for (const pin of pins) assert.equal(fs.statSync(resolve(f.profileDir, pin)).isFile(), true)
  assert.deepEqual(fs.readFileSync(local), ownerBytes)
  if (f.env.SUPERVISOR_TEST_PNPM) fs.rmSync(join(f.profileDir, 'node_modules'), { recursive: true })
  else verifyOfflineLock(f.profileDir)
  await relink(f.config)
  if (f.env.SUPERVISOR_TEST_PNPM) {
    assert.equal(read(join(f.profileDir, 'node_modules/custom-plugin/package.json')).version, '1.0.0')
  }
  assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, TO)
  assert.equal(fs.existsSync(f.staging.root), false)
})
