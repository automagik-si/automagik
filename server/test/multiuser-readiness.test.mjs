import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import * as filesystem from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createKeySource } from '../../apps/multiuser-dsh/src/keys.js'
import { dshArgs, runStartup } from '../entrypoint.mjs'
import { profileDirOf } from '../lib.mjs'
import { multiuserReadiness } from '../profile-multiuser.mjs'
import { ADAPTER, ADAPTER_SINCE, BOTS_GUARD_SINCE, PLUGINS } from '../profile-state.mjs'

const BOTS = '@automagik/bots-dsh'
const fs = filesystem
const write = (path, bytes) => {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, bytes)
}
const connection = (config = { trustedHosts: { __jsExpr: 'ctx.webStartup.trustedHosts' } }) =>
  ({ id: 'connection', name: '@deepseek-ai/dsh-client-connection', config })
const webserver = (overrides = {}) => ({ id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', ...overrides })
const adapter = (overrides = {}) => ({ id: 'multiuser-dsh', name: ADAPTER, ...overrides })
const group = (config, overrides = {}) => ({ name: 'cordis:group', config, ...overrides })

function mountedFs(dir, settings) {
  const paths = new Map()
  const mountinfo = () => `42 41 0:1 / /caller-keys ${settings.rw ? 'rw' : 'ro'},relatime - tmpfs tmpfs rw\n`
  return {
    ...fs,
    openSync(path, flags) {
      const fd = fs.openSync(path, flags)
      paths.set(fd, path)
      return fd
    },
    closeSync(fd) {
      paths.delete(fd)
      fs.closeSync(fd)
    },
    readFileSync(path, ...args) {
      if (path === '/proc/self/mountinfo') return mountinfo()
      const fd = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(path)?.[1]
      if (fd) {
        const file = paths.get(Number(fd))
        const mounted = !settings.sameMount && (file === dir || (dirname(file) === dir && !settings.fileMount))
        return `mnt_id:\t${mounted ? 42 : 41}\n`
      }
      return fs.readFileSync(path, ...args)
    },
  }
}

function setup(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'automagik-readiness-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'data', 'dsh'), cwd = join(root, 'data', 'workspace')
  const profile = profileDirOf(dshHome), imageProfile = join(root, 'image')
  const dir = join(root, 'caller-keys'), file = join(dir, 'caller-keys.json')
  fs.mkdirSync(dir)
  fs.mkdirSync(cwd, { recursive: true })
  const env = { AUTOMAGIK_HOME: dirname(dshHome), AUTOMAGIK_WORKSPACE: cwd, AUTOMAGIK_CALLER_KEYS: file, AUTOMAGIK_INSTANCE_ID: 'fixture' }
  const build = { automagik: ADAPTER_SINCE, plugins: Object.fromEntries(PLUGINS.map(name => [name, ADAPTER_SINCE])) }
  const packages = {}
  for (const target of [profile, imageProfile]) for (const [name, version] of Object.entries(build.plugins)) {
    const manifest = join(target, 'node_modules', name, 'package.json')
    write(manifest, JSON.stringify({ name, version }))
    if (target === profile) packages[name] = manifest
  }
  const mount = {}, rows = [adapter(), connection(), webserver()]
  const appBoot = {
    loadProfile: () => ({ dir: profile, layers: [], patchPath: join(profile, 'cordis.patch.yml') }),
    readProfilePatches: () => rows,
    composeEntries: layers => layers.flat(),
  }
  const io = mountedFs(dir, mount)
  const opts = { env, dshHome, profile, imageProfile, build, appBoot, fs: io }
  return { dir, cwd, dshHome, file, packages, env, rows, mount, profile, opts, io,
    report: (extra = {}) => multiuserReadiness({ ...opts, ...extra }) }
}

const failures = report => report.checks.filter(check => !check.ok).map(check => check.code)
const keySet = () => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const { x } = publicKey.export({ format: 'jwk' })
  const kid = createHash('sha256').update(Buffer.from(x, 'base64url')).digest().subarray(0, 16).toString('base64url')
  return { version: 1, instance: 'fixture', keys: [{ alg: 'EdDSA', crv: 'Ed25519', x, kid }] }
}

test('static readiness accepts the effective defaults and an unpublished read-only key mount', t => {
  const f = setup(t)
  const result = f.report()
  assert.deepEqual(result, { ready: true, warnings: [], checks: [
    { code: 'caller-keys-config', ok: true }, { code: 'instance-config', ok: true },
    { code: 'env-file-override', ok: true },
    { code: 'composition', ok: true }, { code: 'adapter-enabled', ok: true },
    { code: 'body-limit', ok: true }, { code: 'adapter-version', ok: true }, { code: 'bots-guard', ok: true },
    { code: 'caller-keys-mount', ok: true, note: 'keys-not-published-yet' }, { code: 'image-integrity', ok: true },
  ] })
  f.rows.push({ name: BOTS, config: { appManifest: false } })
  assert.deepEqual(f.report().warnings, ['app-manifest'])
  assert.equal(f.report().ready, true)
  assert.ok(!dshArgs(['--public-url', 'https://example.invalid']).includes('--patch'))
})

test('composition refuses disabled or colliding adapter rows and requires literal matched limits', t => {
  const f = setup(t)
  const cases = [
    [[connection()], ['adapter-enabled']],
    [[adapter({ disabled: true }), connection()], ['adapter-enabled']],
    [[adapter({ disabled: { __jsExpr: 'false' } }), connection()], ['adapter-enabled']],
    [[group([adapter()], { disabled: { __jsExpr: 'false' } }), connection()], ['adapter-enabled']],
    [[group([adapter()], { disabled: true }), connection()], ['adapter-enabled']],
    [[adapter({ id: 'wrong' }), connection()], ['adapter-collision', 'adapter-enabled']],
    [[adapter(), adapter({ name: '@example/other' }), connection()], ['adapter-collision']],
    [[adapter(), adapter({ id: 'another' }), connection()], ['adapter-collision']],
    [[adapter()], ['connection-missing']],
    [[adapter(), connection({ maxRequestBodyBytes: 314572801 })], ['body-limit']],
    [[adapter(), connection({ maxRequestBodyBytes: { __jsExpr: '314572800' } })], ['body-limit']],
    [[adapter({ config: { __jsExpr: '{}' } }), connection()], ['body-limit']],
    [[adapter({ config: { maxRequestBodyBytes: 0 } }), connection({ maxRequestBodyBytes: 0 })], ['body-limit']],
    [[adapter({ config: { maxRequestBodyBytes: '10' } }), connection({ maxRequestBodyBytes: '10' })], ['body-limit']],
    [[adapter({ config: { maxRequestBodyBytes: 10 } }), connection({ maxRequestBodyBytes: 10 })], []],
    [[group([adapter()], { disabled: false }), connection()], []],
    [[group([adapter()], { name: '@deepseek-ai/cordis-plugin-group' }), connection()], []],
  ]
  for (const [rows, expected] of cases) {
    f.rows.splice(0, f.rows.length, ...rows, webserver())
    const report = f.report()
    assert.deepEqual(failures(report), expected)
    assert.equal(report.ready, expected.length === 0)
  }
  const invalid = { ...f.opts.appBoot, readProfilePatches() { throw new Error('private-patch-bytes') } }
  const result = f.report({ appBoot: invalid })
  assert.deepEqual(failures(result), ['composition'])
  assert.doesNotMatch(JSON.stringify(result), /private-patch-bytes/)
})

test('required provider IDs and the active webserver module must be unique', t => {
  const f = setup(t)
  const cases = [
    [[connection(), { id: 'connection', name: '@owner/other', disabled: true }, webserver()], 'provider-collision'],
    [[connection(), webserver(), webserver({ name: '@owner/other' })], 'provider-collision'],
    [[connection(), webserver(), group([webserver({ id: 'another-webserver' })])], 'provider-collision'],
    [[{ id: 'connection', name: '@owner/other' }, webserver()], 'connection-missing'],
    [[group([connection()], { disabled: true }), webserver()], 'connection-missing'],
    [[connection(), webserver({ disabled: true })], 'webserver-missing'],
    [[connection(), webserver({ name: '@owner/other' })], 'webserver-missing'],
    [[connection(), webserver({ id: 'another-webserver' })], 'webserver-missing'],
    [[connection(), group([webserver()], { disabled: { __jsExpr: 'false' } })], 'webserver-missing'],
  ]
  for (const [providers, code] of cases) {
    f.rows.splice(0, f.rows.length, adapter(), ...providers)
    const report = f.report()
    assert.equal(report.ready, false)
    assert.deepEqual(failures(report), [code])
  }
})

test('admission-critical rows beneath non-group entries are refused even with valid top-level providers', t => {
  const f = setup(t)
  for (const row of [
    { group: true, config: [adapter()] },
    { name: '@owner/other', group: true, config: [group([connection()])] },
    group([{ name: '@owner/other', config: [webserver({ id: 'other-id' })] }]),
  ]) {
    f.rows.push(row)
    const report = f.report()
    assert.equal(report.ready, false)
    assert.deepEqual(failures(report), ['ambiguous-ancestry'])
    f.rows.pop()
  }
  f.rows.splice(0, 1, { group: true, config: [adapter()] })
  assert.deepEqual(failures(f.report()), ['ambiguous-ancestry', 'adapter-enabled'])
})

test('installed adapter and Bots floors and matching-image payload digests gate mode on', t => {
  const f = setup(t)
  for (const [name, floor, code] of [[ADAPTER, ADAPTER_SINCE, 'adapter-version'], [BOTS, BOTS_GUARD_SINCE, 'bots-guard']]) {
    const file = f.packages[name], original = fs.readFileSync(file)
    write(file, JSON.stringify({ name, version: floor + '-rc.1' }))
    assert.deepEqual(failures(f.report()), [code, 'image-integrity'])
    write(file, original)
    const extra = join(dirname(file), 'custom.js')
    write(extra, 'different owner bytes')
    assert.deepEqual(failures(f.report()), ['image-integrity'])
    fs.rmSync(extra)
  }
  write(f.packages[BOTS], JSON.stringify({ name: BOTS, version: BOTS_GUARD_SINCE }))
  assert.deepEqual(failures(f.report()), ['image-integrity'])
})

test('image integrity requires a complete build inventory and rejects a newer adapter', t => {
  const f = setup(t)
  const build = structuredClone(f.opts.build)
  delete build.plugins[PLUGINS[0]]
  for (const incomplete of [undefined, {}, build]) {
    const report = f.report({ build: incomplete })
    assert.equal(report.ready, false)
    assert.deepEqual(failures(report), ['image-integrity'])
  }
  write(f.packages[ADAPTER], JSON.stringify({ name: ADAPTER, version: '3.160.7', engines: { dsh: '<0.2.2-rc.2' } }))
  assert.deepEqual(failures(f.report()), ['image-integrity'])
})

test('unset caller settings cannot be selected by either DSH .env layer', t => {
  const f = setup(t)
  write(f.file, JSON.stringify(keySet()))
  for (const dir of [f.cwd, f.dshHome]) {
    const file = join(dir, '.env')
    write(file, 'export AUTOMAGIK_INSTANCE_ID="private-other-instance"\n')
    const env = { ...f.env }
    delete env.AUTOMAGIK_INSTANCE_ID
    const report = f.report({ env })
    assert.deepEqual(failures(report), ['env-file-override'])
    assert.doesNotMatch(JSON.stringify(report), /private-other-instance/)
    assert.equal(f.report().ready, true, 'the inherited instance takes precedence')
    write(file, 'AUTOMAGIK_CALLER_KEYS=""\n')
    delete env.AUTOMAGIK_CALLER_KEYS
    assert.deepEqual(failures(f.report({ env })), ['caller-keys-config', 'env-file-override'])
    fs.rmSync(file)
    assert.equal(f.report().ready, true)
  }
})

test('caller key configuration and mount identity reject unsafe locations and directory entries', t => {
  const f = setup(t)
  for (const value of [undefined, 'relative/caller-keys.json', join(f.dir, 'other.json')]) {
    assert.deepEqual(failures(f.report({ env: { ...f.env, AUTOMAGIK_CALLER_KEYS: value } })), ['caller-keys-config'])
  }
  assert.deepEqual(failures(f.report({ env: { ...f.env, AUTOMAGIK_INSTANCE_ID: '' } })), ['instance-config'])
  for (const setting of ['rw', 'sameMount']) {
    f.mount[setting] = true
    assert.deepEqual(failures(f.report()), ['caller-keys-mount'])
    delete f.mount[setting]
  }
  assert.deepEqual(failures(f.report({ cwd: f.dir })), ['caller-keys-mount'])
  const alias = join(dirname(f.dir), 'alias')
  fs.symlinkSync(f.dir, alias)
  assert.deepEqual(failures(f.report({ env: { ...f.env, AUTOMAGIK_CALLER_KEYS: join(alias, 'caller-keys.json') } })), ['caller-keys-mount'])
  write(f.file + '.123.0123456789abcdef.tmp', '')
  assert.equal(f.report().ready, true)
  write(f.file + '.invalid.tmp', '')
  assert.deepEqual(failures(f.report()), ['caller-keys-mount'])
})

test('startup and adapter agree on public key fixtures and startup enforces the directory mount', t => {
  const f = setup(t), valid = keySet(), kid = valid.keys[0].kid
  for (const mutate of [
    undefined, keys => { keys.keys.push(keySet().keys[0]) },
    keys => { keys.version = 2 }, keys => { keys.instance = '' }, keys => { keys.instance = 'other' },
    keys => { keys.keys = [] }, keys => { keys.keys.push(keys.keys[0]) },
    keys => { keys.keys.push(keySet().keys[0], keySet().keys[0]) },
    keys => { keys.keys[0].d = 'private' }, keys => { keys.keys[0].x += '=' },
    keys => { keys.keys[0].kid = 'invalid' }, keys => { keys.keys[0].alg = 'other' },
    keys => { keys.keys[0].crv = 'other' }, keys => { keys.unused = ' '.repeat(16 * 1024) },
  ]) {
    const keys = structuredClone(valid)
    mutate?.(keys)
    write(f.file, JSON.stringify(keys))
    const expected = !mutate || keys.keys.length === 2 && keys.keys[1].kid !== kid
    const runtime = createKeySource({ file: f.file, fs: f.io, expectedInstance: f.env.AUTOMAGIK_INSTANCE_ID })
    assert.equal(Boolean(runtime.get(kid)), expected)
    assert.equal(f.report().ready, expected)
  }
  write(f.file, JSON.stringify({ ...valid, nested: { d: 'private' } }))
  assert.deepEqual(failures(f.report()), ['caller-keys-mount'])
  write(f.file, JSON.stringify(valid))
  f.mount.fileMount = true
  assert.deepEqual(failures(f.report()), ['caller-keys-mount'])
  delete f.mount.fileMount
  fs.renameSync(f.file, join(dirname(f.dir), 'elsewhere'))
  fs.symlinkSync(join(dirname(f.dir), 'elsewhere'), f.file)
  assert.deepEqual(failures(f.report()), ['caller-keys-mount'])
})

const installAnchor = fileURLToPath(new URL('../../apps/bots-dsh/dev/harness/node_modules/@deepseek-ai/dsh/package.json', import.meta.url))
test('caller key mount reopens replaced descriptors and checks each new publication', t => {
  const f = setup(t)
  const replacementPath = join(dirname(f.dir), 'replacement')
  for (const [moveOld, instance] of [[false, 'fixture'], [true, 'wrong-instance']]) {
    write(f.file, JSON.stringify({ ...keySet(), instance: 'old-instance' }))
    write(replacementPath, JSON.stringify({ ...keySet(), instance }))
    let opens = 0
    const io = { ...f.io, openSync(path, flags) {
      const fd = f.io.openSync(path, flags)
      if (path === f.file && ++opens === 1) {
        if (moveOld) fs.renameSync(path, join(dirname(f.dir), 'old-publication'))
        fs.renameSync(replacementPath, path)
      }
      return fd
    } }
    assert.deepEqual(failures(f.report({ fs: io })), moveOld ? ['caller-keys-mount'] : [])
    assert.equal(opens, 2)
  }

  write(f.file, JSON.stringify(keySet()))
  let closes = 0
  const io = { ...f.io,
    readlinkSync(path) {
      const target = fs.readlinkSync(path)
      return target === f.file ? `${target} (deleted)` : target
    },
    closeSync(fd) {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.file) closes++
      f.io.closeSync(fd)
    },
  }
  assert.deepEqual(failures(f.report({ fs: io })), ['caller-keys-mount'])
  assert.equal(closes, 4, 'one original descriptor and three reopens are closed')
})

test('rc.2 composes the shipped adapter with profile and DSH home patches and inherited telemetry',
  { skip: !fs.existsSync(installAnchor) && 'rc.2 DSH test harness is absent' }, async t => {
    const f = setup(t)
    const manifest = JSON.parse(fs.readFileSync(new URL('../profile/package.json', import.meta.url)))
    // Use the real DSH bundles and a minimal Bots bundle for its entry and config.
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name.startsWith('@deepseek-ai/') || name === BOTS)
    write(join(f.profile, 'package.json'), JSON.stringify(manifest))
    const bots = join(f.profile, 'node_modules', BOTS)
    const botsManifest = JSON.stringify({ name: BOTS, version: ADAPTER_SINCE, dsh: { bundle: { patches: ['cordis.patch.yml'] } } })
    for (const parent of [bots, join(f.opts.imageProfile, 'node_modules', BOTS)]) {
      write(join(parent, 'package.json'), botsManifest)
      write(join(parent, 'cordis.patch.yml'), "- insert:\n    - id: omni-ui\n      name: '@automagik/bots-dsh'\n")
    }
    const shipped = fs.readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
    const patch = join(f.profile, 'cordis.patch.yml'), homePatch = join(f.dshHome, 'cordis.patch.yml')
    const boot = await import(pathToFileURL(createRequire(installAnchor).resolve('@deepseek-ai/dsh-app-boot')))
    const appBoot = { ...boot, readProfilePatches(bin, context, loaded) {
      assert.equal(context.cwd, f.cwd)
      assert.equal(context.telemetryDisabledEnv, '1')
      assert.deepEqual(context.overlays, [])
      return boot.readProfilePatches(bin, context, loaded)
    } }
    const report = () => f.report({ installAnchor, appBoot })
    f.env.DSH_TELEMETRY_DISABLED = '1'
    write(patch, shipped)
    assert.deepEqual(failures(report()), [])
    write(patch, shipped + '- id: multiuser-dsh\n  disabled: true\n')
    assert.deepEqual(failures(report()), ['adapter-enabled'])
    write(homePatch, '- id: multiuser-dsh\n  disabled: false\n')
    assert.deepEqual(failures(report()), [])
    fs.appendFileSync(homePatch, '- id: connection\n  config:\n    maxRequestBodyBytes: 1\n')
    assert.deepEqual(failures(report()), ['body-limit'])
    write(homePatch, '- id: multiuser-dsh\n  disabled: !!js false\n')
    assert.deepEqual(failures(report()), ['adapter-enabled'])
    write(patch, shipped)
    write(homePatch, '- id: webserver\n  disabled: true\n')
    assert.deepEqual(failures(report()), ['webserver-missing'])
    write(homePatch, "- insert:\n    - id: connection\n      name: '@owner/other'\n")
    assert.deepEqual(failures(report()), ['provider-collision'])
  })

test('startup gates both launches, pins mode and sanitizes readiness exceptions', async () => {
  for (const [value, readiness, expected] of [
    ['1', () => { throw new Error('private-bytes') }, ['multiuser is on, but startup readiness failed: readiness-error', 1]],
    ['1', { ready: false, checks: [{ code: 'adapter-enabled', ok: false }] },
      ['multiuser is on, but startup readiness failed: adapter-enabled', 1]],
    ['1', { ready: true, checks: [], warnings: ['app-manifest'] }, ['app-manifest', 'core=1', 'dsh=1']],
    [undefined, () => { assert.fail('off imported app boot') }, ['core=0', 'dsh=0']],
  ]) {
    const env = { AUTOMAGIK_MULTIUSER: value }, events = []
    await runStartup({ env, readiness, launchCore: () => events.push('core=' + env.AUTOMAGIK_MULTIUSER),
      launchDsh: () => events.push('dsh=' + env.AUTOMAGIK_MULTIUSER), exit: code => events.push(code), warn: line => events.push(line) })
    assert.deepEqual(events, expected)
  }
})
