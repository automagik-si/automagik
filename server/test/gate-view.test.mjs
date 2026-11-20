import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs, {
  chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recordLaunch } from '../entrypoint.mjs'
import { DshCredentials } from '../gate-upstream.mjs'
import { prepareGateView, writeProfileState } from '../gate-view.mjs'
import { healthReport } from '../healthcheck.mjs'
import { GATE_VIEW, gateViewDir, profileDirOf } from '../lib.mjs'
import { markSeed, PLUGINS, profileState } from '../profile-state.mjs'

const version = '3.93.0'
const plugins = Object.fromEntries(PLUGINS.map(name => [name, version]))
const build = { automagik: version, plugins, revision: 'a'.repeat(40) }
const gateEnv = { AUTOMAGIK_GATE_ENABLED: '1' }
const tempId = '12345678-abcd-4abc-8abc-123456789abc'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-gate-view-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh')
  const viewDir = join(root, GATE_VIEW)
  const profile = profileDirOf(dshHome)
  mkdirSync(viewDir, { mode: 0o700 })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(root, 'versions.json'), JSON.stringify(build))
  writeFileSync(join(profile, 'package.json'), '{}\n')
  markSeed(profile, version)
  for (const name of PLUGINS) {
    const dir = join(profile, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  }
  return {
    root, dshHome, viewDir, profile, profileFile: join(viewDir, 'profile-state.json'),
    report: (env = {}) => healthReport({ root, dshHome, viewDir, env, probe: async () => 401 }),
    state: () => profileState({ profile, source: join(root, 'profile'), build, dshHome }),
  }
}

function entrypoint(t, extra = {}) {
  const { root, viewDir } = fixture(t)
  const harness = `
    import childProcess from 'node:child_process'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    // A host's own /data is never this test's: the view stays in the fixture's home.
    const exists = fs.existsSync
    fs.existsSync = (path) => path !== '/data' && exists(path)
    const lstat = fs.lstatSync
    fs.lstatSync = (path, options) => {
      const info = lstat(path, options)
      if (path === process.env.TEST_VIEW && info) info.uid = Number(process.env.TEST_UID)
      return info
    }
    const fstat = fs.fstatSync
    fs.fstatSync = (fd, options) => {
      const info = fstat(fd, options)
      if (process.env.TEST_DSH_HOME && fs.readlinkSync('/proc/self/fd/' + fd) === process.env.TEST_DSH_HOME) info.uid++
      return info
    }
    childProcess.spawn = () => {
      console.error('unexpected child process')
      process.exit(97)
    }
    syncBuiltinESMExports()
    await import(${JSON.stringify(new URL('../entrypoint.mjs', import.meta.url).href)})
  `
  const env = {
    PATH: process.env.PATH, HOME: root, AUTOMAGIK_HOME: root, TEST_VIEW: viewDir, TEST_UID: String(process.getuid()),
    XDG_RUNTIME_DIR: join(root, 'run'), HC_SESSION: 'test-gate-view', ...extra,
  }
  const refuse = (reason, overrides = {}) => {
    const stdout = join(root, 'stdout')
    const stderr = join(root, 'stderr')
    const out = openSync(stdout, 'w')
    const err = openSync(stderr, 'w')
    let result
    try {
      result = spawnSync(process.execPath, ['--input-type=module', '--eval', harness], {
        env: { ...env, ...overrides }, stdio: ['ignore', out, err], timeout: 5_000,
      })
    } finally {
      closeSync(out)
      closeSync(err)
    }
    const message = readFileSync(stderr, 'utf8')
    assert.ifError(result.error)
    assert.equal(result.status, 1, message)
    assert.equal(readFileSync(stdout, 'utf8'), '')
    assert.match(message, /^automagik-web: [^\r\n]+\n$/)
    assert.match(message, reason)
  }
  return { root, viewDir, refuse }
}

test('the entrypoint refuses a foreign DSH home with the host fix before writing into it', t => {
  const { root, refuse } = entrypoint(t)
  const home = join(root, 'dsh')
  const before = readdirSync(home).sort()
  chmodSync(home, 0o755)
  for (const mode of ['0', '1']) {
    refuse(/not owned by DSH uid \d+\. Chown the DSH home to \d+ on the host\./,
      { TEST_DSH_HOME: home, AUTOMAGIK_MULTIUSER: mode })
    assert.equal(statSync(home).mode & 0o7777, 0o755)
    assert.deepEqual(readdirSync(home).sort(), before)
  }
})

test('startup refuses a view that is a file, a symlink or owned by another uid', async t => {
  const typeError = /gate-view must be a real directory owned by uid \d+/
  await t.test('file', t => {
    const { viewDir, refuse } = entrypoint(t)
    rmSync(viewDir, { recursive: true })
    writeFileSync(viewDir, '')
    refuse(typeError)
  })
  await t.test('symlink to a directory', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    rmSync(viewDir, { recursive: true })
    symlinkSync(join(root, 'dsh'), viewDir)
    refuse(typeError)
  })
  await t.test('wrong owner', t => {
    entrypoint(t).refuse(typeError, { TEST_UID: String(process.getuid() + 1) })
  })
})

test('startup refuses unexpected names and nonregular entries in the view', async t => {
  for (const [name, plant, reason] of [
    ['.credentials.yaml', file => writeFileSync(file, 'dummy'), /unexpected entry/],
    ['launch-url.' + 'a'.repeat(36) + '.tmp', file => writeFileSync(file, ''), /unexpected entry/],
    ['launch-url', file => mkdirSync(file), /must be a regular file/],
    ['profile-state.json.' + tempId + '.tmp', file => symlinkSync('missing', file),
      /must be a regular file/],
  ]) {
    await t.test(name, t => {
      const { viewDir, refuse } = entrypoint(t)
      plant(join(viewDir, name))
      refuse(reason)
    })
  }
})

test('startup refuses real path overlaps in either direction', async t => {
  for (const name of ['DSH_HOME', 'AUTOMAGIK_BOTS_HOME', 'AUTOMAGIK_WORKSPACE', 'HERDR_APP_HOME']) {
    await t.test(name, t => {
      const { root, viewDir, refuse } = entrypoint(t)
      const alias = join(root, 'alias')
      symlinkSync(viewDir, alias)
      refuse(new RegExp('gate-view overlaps ' + name), { [name]: join(alias, 'missing') })
      assert.deepEqual(readdirSync(viewDir), [])
    })
  }
  await t.test('private ancestor of the view', t => {
    const { root, refuse } = entrypoint(t)
    const alias = join(root, 'alias')
    symlinkSync(join(root, '..'), alias)
    refuse(/gate-view overlaps DSH_HOME/, { DSH_HOME: alias })
  })
  await t.test('secrets symlink to the view', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    symlinkSync(viewDir, join(root, 'secrets'))
    refuse(/gate-view overlaps secrets/)
  })
  await t.test('ACP store symlink to the view', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    symlinkSync(viewDir, join(root, 'acp'))
    refuse(/gate-view overlaps acp/)
  })
  await t.test('ACP sign-in homes symlink to the view', t => {
    const { root, viewDir, refuse } = entrypoint(t)
    mkdirSync(join(root, 'acp'))
    symlinkSync(viewDir, join(root, 'acp', 'cli-homes'))
    refuse(/gate-view overlaps acp cli-homes/)
  })
})

test('the view DSH writes is the volume subpath Compose mounts, whatever AUTOMAGIK_HOME says', () => {
  assert.equal(gateViewDir('/elsewhere', { exists: path => path === '/data' }), '/data/gate-view')
  assert.equal(gateViewDir('/data', { exists: path => path === '/data' }), '/data/gate-view')
  assert.equal(gateViewDir('/tmp/home', { exists: () => false }), join('/tmp/home', GATE_VIEW))
})

test('preparing the view repairs its mode and removes only writer leftovers', t => {
  const { root, viewDir } = fixture(t)
  const dirs = { AUTOMAGIK_HOME: root, DSH_HOME: viewDir + '-sibling' }
  rmSync(viewDir, { recursive: true })
  prepareGateView(viewDir, root, dirs)
  assert.equal(statSync(viewDir).mode & 0o7777, 0o700)
  chmodSync(viewDir, 0o755)
  for (const file of ['launch-url', 'profile-state.json']) {
    writeFileSync(join(viewDir, file), 'published')
    writeFileSync(join(viewDir, file + '.' + tempId + '.tmp'), 'leftover')
  }
  prepareGateView(viewDir, root, dirs)
  assert.equal(statSync(viewDir).mode & 0o7777, 0o700)
  assert.deepEqual(readdirSync(viewDir).sort(), ['launch-url', 'profile-state.json'])
})

test('recordLaunch atomically replaces both private launch files with identical bytes', t => {
  const { dshHome, viewDir } = fixture(t)
  const operatorFile = join(dshHome, 'launch-url')
  const gateFile = join(viewDir, 'launch-url')
  const first = 'http://127.0.0.1:3081/?token=test-first'
  const second = 'http://127.0.0.1:3081/?token=test-second'
  assert.equal(recordLaunch(dshHome, viewDir, first), operatorFile)

  const previous = openSync(gateFile, 'r')
  try {
    recordLaunch(dshHome, viewDir, second)
    assert.equal(readFileSync(previous, 'utf8'), `${first}\n`)
    assert.equal(readFileSync(gateFile, 'utf8'), `${second}\n`)
    assert.deepEqual(readFileSync(operatorFile), readFileSync(gateFile))
    assert.equal(statSync(gateFile).mode & 0o777, 0o600)
    assert.equal(statSync(operatorFile).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(viewDir), ['launch-url'])
  } finally {
    closeSync(previous)
  }
})

test('a failed launch publication removes the old gate token and saves the operator copy', t => {
  const { dshHome, viewDir } = fixture(t)
  const gateFile = join(viewDir, 'launch-url')
  const operatorFile = join(dshHome, 'launch-url')
  const first = 'http://127.0.0.1:3081/?token=test-first'
  const second = 'http://127.0.0.1:3081/?token=test-second'
  recordLaunch(dshHome, viewDir, first)

  const rename = fs.renameSync
  const attempts = []
  t.mock.method(fs, 'renameSync', (from, to) => {
    attempts.push(to)
    if (to === gateFile) throw new Error('test view write failure')
    rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const warning = t.mock.method(process.stderr, 'write', () => true)
  assert.equal(recordLaunch(dshHome, viewDir, second), operatorFile)
  assert.deepEqual(attempts, [gateFile, operatorFile])
  assert.deepEqual(readdirSync(viewDir), [])
  assert.equal(readFileSync(operatorFile, 'utf8'), second + '\n')
  assert.equal(warning.mock.callCount(), 1)
  assert.match(warning.mock.calls[0].arguments[0], /could not publish the gate launch URL/)
  assert.match(warning.mock.calls[0].arguments[0], /test view write failure/)
})

test('the view writer publishes only the profile health fields in a private file', t => {
  const { dshHome, viewDir, profileFile, state } = fixture(t)
  writeProfileState(viewDir, {
    ...state(), plugins: { ...plugins, extra: dshHome }, path: dshHome, token: 'test-only',
  })
  const data = JSON.parse(readFileSync(profileFile, 'utf8'))
  assert.deepEqual(data, {
    schemaVersion: 1, at: new Date(data.at).toISOString(), plugins,
    followsImage: true, ownerManaged: false, reason: 'matching-image',
  })
  assert.equal(statSync(profileFile).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(viewDir), ['profile-state.json'])
})

test('DSH health refreshes the view and gate health uses it without the live profile', async t => {
  const { profile, report } = fixture(t)
  assert.equal((await report()).healthy, true)
  const old = join(profile, 'node_modules', PLUGINS[0], 'package.json')
  writeFileSync(old, JSON.stringify({ version: '3.90.1' }))
  assert.equal((await report(gateEnv)).plugins[PLUGINS[0]], version)
  assert.equal((await report()).reason, 'update-required')
  rmSync(profile, { recursive: true })
  const refreshed = await report(gateEnv)
  assert.equal(refreshed.healthy, false)
  assert.equal(refreshed.reason, 'update-required')
  assert.equal(refreshed.plugins[PLUGINS[0]], '3.90.1')
})

test('gate health fails closed with a missing or malformed view even with a healthy profile',
  async t => {
    const { profileFile, report, viewDir, state } = fixture(t)
    const assertMissing = async () => {
      const result = await report(gateEnv)
      assert.equal(result.healthy, false)
      assert.equal(result.fence.healthy, true)
      assert.equal(result.followsImage, false)
      assert.equal(result.ownerManaged, false)
      assert.equal(result.reason, 'no-profile-state')
      assert.deepEqual(result.plugins, Object.fromEntries(PLUGINS.map(name => [name, null])))
    }
    await assertMissing()
    writeProfileState(viewDir, state())
    const valid = JSON.parse(readFileSync(profileFile, 'utf8'))
    assert.equal((await report(gateEnv)).healthy, true)
    for (const malformed of [
      '{', JSON.stringify({ ...valid, path: '/home/ada' }),
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, at: '2026-02-30T00:00:00.000Z' }),
      JSON.stringify({ ...valid, plugins: { ...plugins, extra: version } }),
      JSON.stringify({ ...valid, plugins: { ...plugins, [PLUGINS[0]]: '/home/ada' } }),
      JSON.stringify({ ...valid, plugins: { [PLUGINS[0]]: version } }),
      JSON.stringify({ ...valid, followsImage: 'true' }),
      JSON.stringify({ ...valid, ownerManaged: true }),
      JSON.stringify({ ...valid, reason: 'missing-plugins' }),
      JSON.stringify({ ...valid, plugins: { ...plugins, [PLUGINS[0]]: null } }),
      JSON.stringify({ ...valid, reason: 'unknown' }),
      // Contradictions with the producer's rules or with this image's own plugin versions.
      JSON.stringify({ ...valid, followsImage: false, ownerManaged: true, reason: 'invalid-profile' }),
      JSON.stringify({ ...valid, plugins: { ...plugins, [PLUGINS[0]]: '3.90.0' } }),
    ]) {
      writeFileSync(profileFile, malformed)
      await assertMissing()
    }
  })

test('gate health expires stale and future snapshots without affecting DSH', async t => {
  const { profileFile, report, viewDir, state } = fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T12:00:00.000Z') })
  writeProfileState(viewDir, state())
  const valid = JSON.parse(readFileSync(profileFile, 'utf8'))
  const snapshotAt = offset => {
    const at = new Date(Date.now() + offset).toISOString()
    writeFileSync(profileFile, JSON.stringify({ ...valid, at }))
  }
  for (const offset of [-300_000, 60_000]) {
    snapshotAt(offset)
    assert.equal((await report(gateEnv)).healthy, true)
  }
  for (const offset of [-300_001, 60_001]) {
    snapshotAt(offset)
    const gate = await report(gateEnv)
    assert.equal(gate.healthy, false)
    assert.equal(gate.fence.healthy, true)
    assert.equal(gate.followsImage, false)
    assert.equal(gate.ownerManaged, false)
    assert.equal(gate.reason, 'stale-profile-state')
    assert.equal((await report()).healthy, true)
    assert.equal((await report(gateEnv)).healthy, true)
  }
})

test('gate upstream defaults to the view and rereads its launch URL on refresh', async t => {
  assert.equal(new DshCredentials().launchFile, '/dsh-view/launch-url')
  const { dshHome, viewDir } = fixture(t)
  const credentials = new DshCredentials({ launchFile: join(viewDir, 'launch-url') })
  const request = t.mock.method(credentials, 'request', async path => {
    const token = new URL(path, 'http://ignored.invalid').searchParams.get('token')
    return { statusCode: 303, headers: { 'set-cookie': [`dsh-session=${token}; HttpOnly`] } }
  })
  recordLaunch(dshHome, viewDir, 'https://ignored.invalid/?token=first')
  assert.equal(await credentials.cookie(), 'dsh-session=first')
  recordLaunch(dshHome, viewDir, 'https://ignored.invalid/?token=second')
  assert.equal(await credentials.cookie(), 'dsh-session=first')
  assert.equal(await credentials.cookie(true), 'dsh-session=second')
  assert.deepEqual(request.mock.calls.map(call => call.arguments), [
    ['/?token=first'], ['/?token=second'],
  ])
})

test('a custom home that does not exist yet does not stop the view from being prepared', t => {
  const root = mkdtempSync(join(tmpdir(), 'automagik-gate-view-home-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'not-yet', 'home')
  const view = join(home, GATE_VIEW)
  prepareGateView(view, home, { AUTOMAGIK_HOME: home, DSH_HOME: join(home, 'dsh'), secrets: join(home, 'secrets') })
  assert.equal(statSync(view).mode & 0o7777, 0o700)
  assert.deepEqual(readdirSync(view), [])
})

test('a stale three-plugin gate report is invalid until four keys are published', async t => {
  const f = fixture(t)
  const pkg = JSON.parse(readFileSync(new URL('../profile/package.json', import.meta.url), 'utf8'))
  for (const name of PLUGINS) pkg.dependencies[name] = `file:vendor/automagik-${name.split('/')[1]}-${version}.tgz`
  writeFileSync(join(f.profile, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  markSeed(f.profile, version)
  const state = f.state()
  const legacy = { ...state.plugins }
  delete legacy['@automagik/multiuser-dsh']
  writeFileSync(f.profileFile, JSON.stringify({ at: new Date().toISOString(), schemaVersion: 1,
    plugins: legacy, followsImage: true, ownerManaged: false, reason: 'matching-image' }))
  assert.equal((await f.report(gateEnv)).reason, 'no-profile-state')
  writeProfileState(f.viewDir, state)
  const actual = await f.report(gateEnv)
  assert.deepEqual(actual.plugins, plugins)
  assert.equal(actual.healthy, true)
})
