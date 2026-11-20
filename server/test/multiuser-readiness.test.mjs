import assert from 'node:assert/strict'
import { constants as bufferLimits } from 'node:buffer'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as wallPaths from '../../apps/bots-dsh/src/host/member-wall/paths.js'
import { createKeySource } from '../../apps/multiuser-dsh/src/keys.js'
import { dshArgs, runStartup } from '../entrypoint.mjs'
import { gateViewDir, profileDirOf, RUN_SECRETS_DIR, RUN_SECRETS_MODEL_KEY_FILE } from '../lib.mjs'
import { multiuserReadiness } from '../profile-multiuser.mjs'
import { ADAPTER, ADAPTER_SINCE, BOTS_GUARD_SINCE, PLUGINS } from '../profile-state.mjs'

const BOTS = '@automagik/bots-dsh'
const write = (path, bytes) => {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, bytes)
}
const connection = (config = { trustedHosts: { __jsExpr: 'ctx.webStartup.trustedHosts' } }) =>
  ({ id: 'connection', name: '@deepseek-ai/dsh-client-connection', config })
const webserver = (overrides = {}) => ({ id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', ...overrides })
const adapter = (overrides = {}) => ({ id: 'multiuser-dsh', name: ADAPTER, ...overrides })
const group = (config, overrides = {}) => ({ name: 'cordis:group', config, ...overrides })
const stockFs = (overrides = {}) => ({ id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox', ...overrides })
const sandboxPolicy = { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' }
const sessionProjection = { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' }

function mountedFs(dir, settings) {
  const paths = new Map()
  const mountinfo = () => `41 1 0:2 / / rw - tmpfs tmpfs rw\n42 41 0:1 / /caller-keys ${settings.rw ? 'rw' : 'ro'},relatime - tmpfs tmpfs rw\n` +
    (settings.binds ?? '')
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
  const runnerDir = join(root, 'runner'), socketDir = join(runnerDir, 'socket'), proofs = join(runnerDir, 'proofs')
  const socket = join(socketDir, 'runner.sock'), work = join(root, 'command-mount', 'work')
  const runnerUid = process.geteuid() + 1, runnerGid = process.getegid() + 1
  fs.mkdirSync(runnerDir, { mode: 0o755 })
  fs.mkdirSync(proofs, { mode: 0o1730 })
  fs.mkdirSync(dirname(work), { mode: 0o755 })
  fs.mkdirSync(work, { mode: 0o711 })
  fs.chmodSync(work, 0o711)
  write(socket, '')
  fs.chmodSync(socketDir, 0o750)
  fs.chmodSync(socket, 0o660)
  fs.chmodSync(proofs, 0o1730)
  const env = {
    AUTOMAGIK_HOME: dirname(dshHome), AUTOMAGIK_WORKSPACE: cwd, AUTOMAGIK_CALLER_KEYS: file, AUTOMAGIK_INSTANCE_ID: 'fixture',
    AUTOMAGIK_BOT_RUNNER_SOCKET: socket, AUTOMAGIK_BOT_RUNNER_PROOFS: proofs, AUTOMAGIK_BOT_RUNNER_WORK_ROOT: work,
    AUTOMAGIK_BOT_RUNNER_UID: String(runnerUid), AUTOMAGIK_BOT_RUNNER_GID: String(runnerGid),
  }
  const botsRoot = join(root, 'bot-files')
  fs.mkdirSync(botsRoot, { mode: 0o700 })
  const view = gateViewDir(env.AUTOMAGIK_HOME)
  const denyReadRoots = [dshHome, '/data/secrets', join(env.AUTOMAGIK_HOME, 'secrets'), view, RUN_SECRETS_DIR]
  for (const path of denyReadRoots.filter(path => path.startsWith(root + '/'))) fs.mkdirSync(path, { recursive: true })
  const wall = { id: 'member-wall-fs', name: '@automagik/bots-dsh/member-wall/fs', config: {
    members: true, bots: true, membersRoot: join(root, 'members'), botsRoot,
    principalsFile: join(dshHome, 'multiuser-dsh', 'principals.json'), denyReadRoots,
  } }
  write(join(profile, 'package.json'), '{}')
  const build = { automagik: BOTS_GUARD_SINCE, plugins: Object.fromEntries(PLUGINS.map(name => [name, BOTS_GUARD_SINCE])) }
  const packages = {}
  for (const target of [profile, imageProfile]) for (const [name, version] of Object.entries(build.plugins)) {
    const manifest = join(target, 'node_modules', name, 'package.json')
    write(manifest, JSON.stringify({ name, version }))
    if (target === profile) packages[name] = manifest
  }
  const mount = {}, runner = {}, rows = [adapter(), connection(), webserver(), sandboxPolicy, sessionProjection,
    stockFs({ disabled: true }), wall]
  const appBoot = {
    loadProfile: () => ({ dir: profile, layers: [], patchPath: join(profile, 'cordis.patch.yml') }),
    readProfilePatches: () => rows,
    composeEntries: layers => layers.flat(),
  }
  const io = {
    ...mountedFs(dir, mount),
    lstatSync(path, options) {
      const info = fs.lstatSync(path, options)
      if (!info) return info
      // The test scratch is under /tmp; the template has a strictly locked ancestry.
      for (let at = dirname(root); ; at = dirname(at)) {
        if (path === at) info.mode &= ~0o022
        if (at === dirname(at)) break
      }
      if ([socketDir, proofs, work].includes(path) || (path === socket && !info.isSymbolicLink())) {
        info.uid = runnerUid
        info.gid = runnerGid
        if (path === socket) info.isSocket = () => true
      }
      const { mode, ...overrides } = runner[path] ?? {}
      if (mode !== undefined) info.mode = (info.mode & ~0o7777) | mode
      return Object.assign(info, overrides)
    },
    accessSync(path, mode) {
      if (runner[path]?.accessError) throw Object.assign(new Error('fixture access'), { code: runner[path].accessError })
      // Real DSH uses the socket group here; the fixture process owns the proof directory.
      if (path === proofs) return
      return fs.accessSync(path, mode)
    },
  }
  const opts = { env, dshHome, profile, imageProfile, build, appBoot, fs: io, wallPaths, groups: [runnerGid] }
  return { root, dir, cwd, dshHome, file, packages, env, rows, mount, profile, opts, io, runner,
    runnerDir, socketDir, proofs, socket, work, wall, view,
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
    { code: 'env-file-override', ok: true }, { code: 'bot-runner-config', ok: true },
    { code: 'composition', ok: true }, { code: 'adapter-enabled', ok: true },
    { code: 'body-limit', ok: true }, { code: 'member-wall-row', ok: true }, { code: 'bot-trees-disjoint', ok: true },
    { code: 'adapter-version', ok: true }, { code: 'bots-guard', ok: true },
    { code: 'caller-keys-mount', ok: true, note: 'keys-not-published-yet' }, { code: 'bot-runner-socket', ok: true },
    { code: 'image-integrity', ok: true },
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
    f.rows.splice(0, f.rows.length, ...rows, webserver(), sandboxPolicy, sessionProjection, f.wall)
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
    f.rows.splice(0, f.rows.length, adapter(), ...providers, sandboxPolicy, sessionProjection, f.wall)
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

test('runner configuration uses normalized external paths and a separate numeric identity', t => {
  const f = setup(t)
  for (const [name, values] of Object.entries({
    AUTOMAGIK_BOT_RUNNER_SOCKET: [undefined, 'runner.sock', `${f.socketDir}/./runner.sock`, '/data/runner.sock',
      join(f.dshHome, 'runner.sock'), join(f.cwd, 'runner.sock'), '/dsh-view/runner.sock'],
    AUTOMAGIK_BOT_RUNNER_PROOFS: [undefined, 'proofs', `${f.proofs}/`, join(f.env.AUTOMAGIK_HOME, 'gate-view', 'proofs')],
    AUTOMAGIK_BOT_RUNNER_UID: [undefined, 'dsh', '0', String(process.geteuid()), '4294967295'],
    AUTOMAGIK_BOT_RUNNER_GID: [undefined, '1.1', String(process.getegid())],
  })) {
    for (const value of values) {
      assert.deepEqual(failures(f.report({ env: { ...f.env, [name]: value } })), ['bot-runner-config'], `${name}=${value}`)
    }
  }
  const alias = join(f.root, 'private-alias')
  fs.symlinkSync(f.cwd, alias)
  assert.deepEqual(failures(f.report({ env: { ...f.env, AUTOMAGIK_BOT_RUNNER_PROOFS: join(alias, 'proofs') } })), ['bot-runner-config'])
  for (const value of [undefined, '', ' \t']) {
    assert.deepEqual(failures(f.report({ env: { ...f.env, AUTOMAGIK_INSTANCE_ID: value } })), ['instance-config'])
  }
})

test('runner inspection requires the socket locks and effective proof access', t => {
  const f = setup(t)
  for (const [path, replacement] of [
    [f.socket, { uid: process.geteuid() }], [f.socket, { gid: process.getegid() }], [f.socket, { mode: 0o666 }],
    [f.socket, { isSocket: () => false }], [f.socketDir, { uid: process.geteuid() }], [f.socketDir, { mode: 0o755 }],
    [f.runnerDir, { mode: 0o775 }], [f.proofs, { mode: 0o730 }], [f.proofs, { uid: process.geteuid() }],
    [f.proofs, { accessError: 'EROFS' }], [f.proofs, { accessError: 'EACCES' }],
  ]) {
    f.runner[path] = replacement
    assert.deepEqual(failures(f.report()), ['bot-runner-socket'])
    delete f.runner[path]
  }
  assert.deepEqual(failures(f.report({ groups: [] })), ['bot-runner-socket'])
  fs.rmSync(f.proofs, { recursive: true })
  assert.deepEqual(failures(f.report()), ['bot-runner-socket'])
  fs.mkdirSync(f.proofs, { mode: 0o1730 })
  fs.chmodSync(f.proofs, 0o1730)
  fs.rmSync(f.socket)
  assert.deepEqual(failures(f.report()), ['bot-runner-socket'])
  fs.symlinkSync(f.socket + '.absent', f.socket)
  assert.deepEqual(failures(f.report()), ['bot-runner-socket'])
  fs.rmSync(f.socket)
  write(f.socket, 'kept')
  fs.chmodSync(f.socket, 0o660)
  const realSocketDir = `${f.socketDir}-real`
  fs.renameSync(f.socketDir, realSocketDir)
  fs.symlinkSync(realSocketDir, f.socketDir)
  assert.deepEqual(failures(f.report()), ['bot-runner-socket'])
  assert.equal(fs.readFileSync(f.socket, 'utf8'), 'kept')
  assert.deepEqual(fs.readdirSync(f.proofs), [])
})

test('runner socket destinations fit the Unix address limit in UTF-8 bytes', t => {
  const f = setup(t)
  const base = join(f.root, 'bind-'), socketName = '/runner.sock'
  const room = 107 - Buffer.byteLength(base + socketName)
  const path = name => ({ ...f.env, AUTOMAGIK_BOT_RUNNER_SOCKET: base + name + socketName })
  assert.ok(room > 0)
  assert.deepEqual(failures(f.report({ env: path('x'.repeat(room)) })), ['bot-runner-socket'])
  assert.deepEqual(failures(f.report({ env: path('x'.repeat(room + 1)) })), ['bot-runner-config'])
  const multibyte = 'é'.repeat(Math.floor(room / 2) + 1)
  assert.ok(path(multibyte).AUTOMAGIK_BOT_RUNNER_SOCKET.length <= 107)
  assert.deepEqual(failures(f.report({ env: path(multibyte) })), ['bot-runner-config'])
})

test('only the active member-wall fs provider can serve file tools', t => {
  const f = setup(t)
  const base = f.rows.slice(0, -1)
  for (const [rows, codes] of [
    [[], ['member-wall-row']],
    [[{ ...f.wall, disabled: true }], ['member-wall-row']],
    [[group([f.wall], { disabled: true })], ['member-wall-row']],
    [[f.wall, group([f.wall])], ['member-wall-row']],
    [[f.wall, stockFs()], ['member-wall-row']],
    [[f.wall, stockFs({ id: 'other-fs' })], ['member-wall-row']],
    [[f.wall, { name: '@deepseek-ai/dsh-fs-local' }], ['member-wall-row']],
    [[f.wall, group([stockFs()], { disabled: { __jsExpr: 'false' } })], ['member-wall-row']],
    [[f.wall, { name: '@owner/other', config: [f.wall] }], ['ambiguous-ancestry', 'member-wall-row']],
    [[f.wall, { name: '@owner/other', config: [stockFs()] }], ['ambiguous-ancestry', 'member-wall-row']],
    [[group([f.wall]), group([stockFs()], { disabled: true })], []],
    [[{ ...f.wall, isolate: { fs: true } }], ['member-wall-row']],
    [[group([group([f.wall])], { isolate: { fs: 'private' } })], ['member-wall-row']],
    [[f.wall, { name: '@deepseek-ai/dsh-tool-fs', isolate: { fs: true } }], ['member-wall-row']],
    [[{ ...f.wall, inject: ['missing'] }], ['member-wall-row']],
    [[group([group([f.wall])], { inject: { missing: null } })], ['member-wall-row']],
    [[group([f.wall], { inject: ['sandboxPolicy'] })], []],
  ]) {
    f.rows.splice(0, f.rows.length, ...base, ...rows)
    assert.deepEqual(failures(f.report()), codes)
  }
  f.rows.splice(0, f.rows.length, ...base, f.wall)
  for (const provider of [sandboxPolicy, sessionProjection]) {
    const at = f.rows.indexOf(provider)
    f.rows[at] = { ...provider, disabled: true }
    assert.deepEqual(failures(f.report()), ['member-wall-row'])
    f.rows[at] = { ...provider, isolate: { [provider === sandboxPolicy ? 'sandboxPolicy' : 'sessionProjections']: true } }
    assert.deepEqual(failures(f.report()), ['member-wall-row'])
    f.rows[at] = provider
  }
})

test('wall settings match the principal writer and obey the plugin root and grant rules', t => {
  const f = setup(t)
  const { config } = f.wall
  const missing = join(f.root, 'absent')
  const alias = join(f.root, 'files-link')
  fs.symlinkSync(config.botsRoot, alias)
  for (const overrides of [
    { members: false }, { bots: false }, { membersRoot: undefined }, { membersRoot: 'relative' },
    { principalsFile: join(f.dshHome, 'principals.json') }, { instanceId: 'other' }, { instanceId: ' ' },
    { botsRoot: missing }, { botsRoot: alias + '/' }, { botsRoot: f.dshHome }, { botsRoot: '/data' },
    { denyReadRoots: [f.root] }, { botDenyRoots: [config.botsRoot] }, { membersRoot: config.botsRoot },
    { sharedReadRoots: ['relative'] }, { botDenyRoots: false }, { botReadRoots: [] },
    { botReadRoots: { invalid: [missing] } }, { botReadRoots: { 'b-abcdefghij': ['relative'] } },
    { botReadRoots: { 'b-abcdefghij': [f.cwd] } }, { botReadRoots: { 'b-abcdefghij': [alias] } },
    { cwd: false }, { diffBasisMaxBytes: 0 }, { diffBasisMaxBytes: -1 }, { diffBasisMaxBytes: 1.5 },
    { diffBasisMaxBytes: '1024' }, { diffBasisMaxBytes: bufferLimits.MAX_STRING_LENGTH + 1 },
  ]) {
    f.rows[f.rows.length - 1] = { ...f.wall, config: { ...config, ...overrides } }
    assert.deepEqual(failures(f.report()), ['member-wall-row'], JSON.stringify(overrides))
  }
  for (const instanceId of ['', f.env.AUTOMAGIK_INSTANCE_ID]) {
    f.rows[f.rows.length - 1] = { ...f.wall, config: { ...config, instanceId, diffBasisMaxBytes: 1024, botReadRoots: { 'b-abcdefghij': [missing] } } }
    assert.equal(f.report().ready, true)
  }
  fs.chmodSync(config.botsRoot, 0o770)
  assert.deepEqual(failures(f.report()), ['member-wall-row'])
})

test('the member fence denies the two launch URLs and model keys even with a broad read grant', t => {
  const f = setup(t)
  const { config } = f.wall
  const files = [join(f.dshHome, 'launch-url'), join(f.view, 'launch-url'), join(f.env.AUTOMAGIK_HOME, 'secrets', 'model-key')]
  for (const file of files) write(file, 'private')
  config.sharedReadRoots = [f.env.AUTOMAGIK_HOME]
  const principal = [{ kind: 'member', name: 'fixture' }]
  assert.equal(f.report().ready, true)
  for (const file of files) {
    assert.equal(wallPaths.mayUse(config, principal, file, '/'), false)
    const denyReadRoots = config.denyReadRoots.filter(root => root !== dirname(file))
    f.rows[f.rows.length - 1] = { ...f.wall, config: { ...config, denyReadRoots } }
    assert.equal(wallPaths.mayUse({ ...config, denyReadRoots }, principal, file, '/'), true)
    assert.deepEqual(failures(f.report()), ['member-wall-row'])
  }
})

test('the member fence requires the Docker secrets tree and the configured key target', t => {
  const f = setup(t)
  const { config } = f.wall
  const target = join(f.root, 'operator-keys', 'model-key')
  const link = join(f.cwd, 'model-key-link')
  write(target, 'private')
  fs.symlinkSync(target, link)
  f.env.DEEPSEEK_API_KEY_FILE = 'model-key-link'
  config.sharedReadRoots = [f.root]
  assert.deepEqual(failures(f.report()), ['member-wall-row'])
  config.denyReadRoots.push(target)
  const io = { ...f.io, readFileSync(path, ...args) {
    assert.ok(path !== target && path !== link, 'readiness must leave the key contents unread')
    return f.io.readFileSync(path, ...args)
  } }
  assert.equal(f.report({ fs: io }).ready, true)
  for (const path of [target, link]) assert.equal(wallPaths.mayUse(config, [{ kind: 'member', name: 'fixture' }], path, '/'), false)
  // Model a Docker secret symlink without creating anything under /run on the test host.
  delete f.env.DEEPSEEK_API_KEY_FILE
  config.denyReadRoots.pop()
  const dockerPaths = { ...wallPaths, physical: path => path === RUN_SECRETS_MODEL_KEY_FILE ? target : wallPaths.physical(path) }
  assert.deepEqual(failures(f.report({ wallPaths: dockerPaths })), ['member-wall-row'])
  config.denyReadRoots.push(target)
  assert.equal(f.report({ wallPaths: dockerPaths }).ready, true)
  config.denyReadRoots = config.denyReadRoots.filter(root => root !== RUN_SECRETS_DIR)
  assert.deepEqual(failures(f.report()), ['member-wall-row'])
})

test('the member fence refuses read grants that expose a protected bind mount', t => {
  const f = setup(t)
  const { config } = f.wall
  const shared = join(f.root, 'shared'), alias = join(shared, 'alias')
  const key = join(f.root, 'key'), keyAlias = join(shared, 'key')
  fs.mkdirSync(alias, { recursive: true })
  for (const file of [key, keyAlias]) write(file, 'fixture')
  f.env.DEEPSEEK_API_KEY_FILE = key
  config.denyReadRoots.push(key)
  const bind = (root, at) => `43 41 0:2 ${root} ${at} rw - tmpfs tmpfs rw\n`
  for (const [root, at] of [[join(f.dshHome, 'private'), alias], [f.view, alias],
    [join(f.env.AUTOMAGIK_HOME, 'secrets'), alias], [join(RUN_SECRETS_DIR, 'deepseek_api_key'), keyAlias], [key, keyAlias]]) {
    f.mount.binds = bind(root, at)
    config.sharedReadRoots = [shared]
    assert.deepEqual(failures(f.report()), ['member-wall-row'], root)
    config.sharedReadRoots = []
    assert.equal(f.report().ready, true, 'the same mount outside a grant is allowed')
  }
  f.mount.binds = bind(join(f.root, 'other'), alias)
  config.sharedReadRoots = [shared]
  assert.equal(f.report().ready, true)
})

test('the Bot file and command trees must be disjoint even through an alias', t => {
  const f = setup(t)
  const { botsRoot } = f.wall.config
  const alias = join(f.root, 'alias')
  fs.symlinkSync(botsRoot, alias)
  for (const work of [undefined, 'relative', botsRoot, f.root, join(botsRoot, 'child'), alias, join(alias, 'missing')]) {
    assert.deepEqual(failures(f.report({ env: { ...f.env, AUTOMAGIK_BOT_RUNNER_WORK_ROOT: work } })), ['bot-trees-disjoint'])
  }
  for (const info of [{ uid: process.geteuid() }, { mode: 0o700 }, { mode: 0o733 }]) {
    f.runner[f.work] = info
    assert.deepEqual(failures(f.report()), ['bot-trees-disjoint'])
  }
  delete f.runner[f.work]
  const sibling = botsRoot + '-sibling'
  const env = { ...f.env, AUTOMAGIK_BOT_RUNNER_WORK_ROOT: sibling }
  assert.deepEqual(failures(f.report({ env })), ['bot-trees-disjoint'])
  write(sibling, 'not a directory')
  assert.deepEqual(failures(f.report({ env })), ['bot-trees-disjoint'])
  fs.rmSync(sibling)
  fs.mkdirSync(sibling, { mode: 0o711 })
  f.runner[sibling] = { uid: Number(env.AUTOMAGIK_BOT_RUNNER_UID) }
  assert.equal(f.report({ env }).ready, true)
})

test('mountinfo rejects nested bind aliases and allows distinct backing roots', t => {
  const f = setup(t)
  const { botsRoot } = f.wall.config
  const nested = join(f.work, 'nested')
  fs.mkdirSync(nested)
  const binds = (root, device = '8:1', at = botsRoot) =>
    `43 41 8:1 /work\\040volume ${dirname(f.work)} rw - ext4 /dev/root rw\n` +
    `44 41 ${device} ${root} ${at} rw - ext4 /dev/root rw\n`
  f.mount.binds = binds('/work\\040volume/work/child')
  assert.deepEqual(failures(f.report()), ['bot-trees-disjoint'])
  f.mount.binds = binds('/work\\040volume')
  assert.deepEqual(failures(f.report()), ['bot-trees-disjoint'])
  f.mount.binds = binds('/work\\040volume/work/child', '8:2')
  assert.equal(f.report().ready, true)
  f.mount.binds = binds('/work\\040volume/work-sibling')
  assert.equal(f.report().ready, true)
  f.mount.binds += `45 43 8:1 /work\\040volume/work-sibling/child ${nested} rw - ext4 /dev/root rw\n`
  assert.deepEqual(failures(f.report()), ['bot-trees-disjoint'])
})

test('Bot read grants cannot overlap the runner work tree through paths or bind mounts', t => {
  const f = setup(t)
  const alias = join(f.root, 'grant')
  fs.mkdirSync(alias)
  const grant = path => { f.wall.config.botReadRoots = { 'b-abcdefghij': [path] } }
  for (const path of [f.work, dirname(f.work), join(f.work, 'future-output')]) {
    grant(path)
    assert.deepEqual(failures(f.report()), ['bot-trees-disjoint'], path)
  }
  grant(alias)
  for (const root of [f.work, dirname(f.work), join(f.work, 'output')]) {
    f.mount.binds = `43 41 0:2 ${root} ${alias} rw - tmpfs tmpfs rw\n`
    assert.deepEqual(failures(f.report()), ['bot-trees-disjoint'], root)
  }
  delete f.mount.binds
  assert.equal(f.report().ready, true)
})

test('startup loads only the wall path validator from the image profile', t => {
  const missing = setup(t)
  assert.deepEqual(failures(missing.report({ wallPaths: undefined })), ['member-wall-row'])
  const f = setup(t)
  for (const profile of [f.profile, f.opts.imageProfile]) {
    const pkg = join(profile, 'node_modules', BOTS)
    write(join(pkg, 'package.json'), JSON.stringify({ name: BOTS, version: BOTS_GUARD_SINCE, type: 'module',
      exports: { './member-wall/fs': './fs.js' } }))
    write(join(pkg, 'fs.js'), 'throw new Error("the wall provider ran at preflight")\n')
    write(join(pkg, 'paths.js'), `export * from ${JSON.stringify(new URL('../../apps/bots-dsh/src/host/member-wall/paths.js', import.meta.url).href)}\n`)
  }
  assert.equal(f.report({ wallPaths: undefined }).ready, true)
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
  write(f.packages[BOTS], JSON.stringify({ name: BOTS, version: '3.161.4' }))
  assert.deepEqual(failures(f.report()), ['image-integrity'])
})

test('mode on requires the first stable image content with the no-runner guard', t => {
  const f = setup(t)
  for (const [version, expected] of [['3.160.8', ['bots-guard']], ['3.161.2', ['bots-guard']],
    ['3.161.3-rc.1', ['bots-guard']], ['3.161.3', []]]) {
    const build = { automagik: version, plugins: Object.fromEntries(PLUGINS.map(name => [name, version])) }
    for (const profile of [f.profile, f.opts.imageProfile]) for (const name of PLUGINS) {
      write(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
    }
    assert.deepEqual(failures(f.report({ build })), expected, version)
  }
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
  write(f.packages[ADAPTER], JSON.stringify({ name: ADAPTER, version: '3.161.4', engines: { dsh: '<0.2.2-rc.2' } }))
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
    assert.deepEqual(failures(report), ['instance-config', 'env-file-override'])
    assert.doesNotMatch(JSON.stringify(report), /private-other-instance/)
    assert.equal(f.report().ready, true, 'the inherited instance takes precedence')
    write(file, 'AUTOMAGIK_CALLER_KEYS=""\n')
    delete env.AUTOMAGIK_CALLER_KEYS
    assert.deepEqual(failures(f.report({ env })), ['caller-keys-config', 'instance-config', 'env-file-override'])
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

const installAnchor = process.env.DSH_READINESS_TEST_ANCHOR ? resolve(process.env.DSH_READINESS_TEST_ANCHOR) :
  fileURLToPath(new URL('../../apps/bots-dsh/dev/harness/node_modules/@deepseek-ai/dsh/package.json', import.meta.url))

function legacyProfile(f, manifest) {
  const manifestPath = join(f.profile, 'package.json')
  const projection = join(f.profile, '.dsh-module-fallback', 'node_modules', 'old-bundle')
  const projectedLink = join(f.profile, 'node_modules', 'old-bundle')
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n\n')
  write(manifestPath, bytes)
  write(join(projection, 'package.json'), '{"name":"old-bundle"}')
  fs.symlinkSync(projection, projectedLink)
  return {
    check() {
      assert.deepEqual(fs.readFileSync(manifestPath), bytes)
      assert.equal(fs.readFileSync(join(projection, 'package.json'), 'utf8'), '{"name":"old-bundle"}')
      assert.equal(fs.readlinkSync(projectedLink), projection)
    },
  }
}

test('a refused readiness check leaves the legacy projection and profile manifest byte-equal', t => {
  const f = setup(t)
  const original = legacyProfile(f, {})
  f.rows.pop()
  let scratch
  const appBoot = { ...f.opts.appBoot, loadProfile(bin, name, anchor, home) {
    assert.notEqual(home, f.dshHome)
    scratch = profileDirOf(home)
    const privateDir = scratch.match(/^\/tmp\/automagik-composition-[^/]+/)?.[0]
    assert.ok(privateDir)
    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700)
    assert.equal(fs.lstatSync(join(scratch, 'node_modules')).isDirectory(), true)
    fs.writeFileSync(join(scratch, 'package.json'), '{"migrated":true}')
    fs.unlinkSync(join(scratch, 'node_modules', 'old-bundle'))
    fs.rmSync(join(scratch, '.dsh-module-fallback'), { recursive: true })
    return { dir: scratch, layers: [], patchPath: join(scratch, 'cordis.patch.yml') }
  } }
  assert.deepEqual(failures(f.report({ appBoot })), ['member-wall-row'])
  original.check()
  assert.equal(fs.existsSync(scratch), false)
})

test('readiness refuses protected TMPDIRs before writing any composition inputs', t => {
  const f = setup(t)
  const alias = join(f.root, 'proofs-link')
  fs.symlinkSync(f.proofs, alias)
  const bind = join(f.root, 'proofs-bind')
  fs.mkdirSync(bind)
  f.mount.binds = `43 41 0:2 ${f.proofs} ${bind} rw - tmpfs tmpfs rw\n`
  const names = ['mkdtempSync', 'mkdirSync', 'copyFileSync', 'symlinkSync', 'rmSync', 'writeFileSync', 'unlinkSync']
  const original = names.map(name => [name, fs[name]])
  const mutations = []
  for (const [name, method] of original) fs[name] = (...args) => {
    mutations.push([name, ...args])
    return method(...args)
  }
  syncBuiltinESMExports()
  try {
    for (const path of [f.proofs, join(f.proofs, 'subdir'), alias, bind, f.runnerDir, f.socketDir, f.work, f.dshHome, f.view]) {
      assert.deepEqual(failures(f.report({ env: { ...f.env, TMPDIR: path } })), ['composition'], path)
    }
    assert.deepEqual(mutations, [])
    assert.deepEqual(fs.readdirSync(f.proofs), [])
  } finally {
    for (const [name, method] of original) fs[name] = method
    syncBuiltinESMExports()
  }
})

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
    const botsImage = join(f.opts.imageProfile, 'node_modules', BOTS)
    const botsManifest = JSON.stringify({ name: BOTS, version: BOTS_GUARD_SINCE, dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    const botsPatch = "- insert:\n    - id: omni-ui\n      name: '@automagik/bots-dsh'\n"
    for (const parent of [bots, botsImage]) {
      write(join(parent, 'package.json'), botsManifest)
      write(join(parent, 'cordis.patch.yml'), botsPatch)
    }
    const shipped = fs.readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8') +
      `\n- id: fs-sandbox\n  disabled: true\n- insert:\n    - ${JSON.stringify(f.wall)}\n`
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
    write(homePatch, `- insert:\n    - ${JSON.stringify({ ...f.wall, disabled: true })}\n`)
    assert.deepEqual(failures(report()), ['member-wall-row'], 'the last sibling with the wall id wins')
    write(homePatch, `- insert:\n    - ${JSON.stringify({ ...f.wall, disabled: true, group: true })}\n`)
    assert.deepEqual(failures(report()), [], 'the loader enables a row marked as a group')
    write(patch, fs.readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8') + '\n- id: fs-sandbox\n  disabled: true\n')
    for (const groupMarker of [false, true]) {
      const nested = group([{ ...f.wall, group: groupMarker }], { id: 'wall-group', disabled: true, group: true })
      write(homePatch, `- insert:\n    - ${JSON.stringify(nested)}\n`)
      assert.deepEqual(failures(report()), groupMarker ? [] : ['member-wall-row'], 'an ordinary child inherits the raw disabled flag')
    }
    write(patch, shipped)
    fs.rmSync(homePatch)
    f.env.DSH_PERMISSION_MODE = 'invalid'
    assert.deepEqual(failures(report()), ['member-wall-row'])
    delete f.env.DSH_PERMISSION_MODE
    const dotenv = join(f.dshHome, '.env')
    write(dotenv, 'DSH_PERMISSION_MODE=invalid\n')
    assert.deepEqual(failures(report()), ['member-wall-row'])
    f.env.DSH_PERMISSION_MODE = 'read-only'
    assert.deepEqual(failures(report()), [])
    delete f.env.DSH_PERMISSION_MODE
    fs.rmSync(dotenv)
    for (const config of [{ workspaceRoot: 'relative' }, { mode: 'unknown' }, { additionalWritableRoots: ['relative'] }]) {
      write(homePatch, `- id: sandbox-policy\n  config: ${JSON.stringify(config)}\n`)
      assert.deepEqual(failures(report()), ['member-wall-row'])
    }
    write(homePatch, '- id: sandbox-policy\n  config: { mode: workspace-write, workspaceRoot: /workspace, additionalWritableRoots: [/extra] }\n')
    assert.deepEqual(failures(report()), [])
    fs.rmSync(homePatch)
    write(patch, shipped + '- id: multiuser-dsh\n  disabled: true\n')
    assert.deepEqual(failures(report()), ['adapter-enabled'])
    write(homePatch, '- id: multiuser-dsh\n  disabled: false\n')
    assert.deepEqual(failures(report()), [])
    fs.appendFileSync(homePatch, '- id: connection\n  config:\n    maxRequestBodyBytes: 1\n')
    assert.deepEqual(failures(report()), ['body-limit'])
    write(homePatch, '- id: multiuser-dsh\n  disabled: !!js false\n')
    assert.deepEqual(failures(report()), ['adapter-enabled'])
    write(patch, shipped)
    write(homePatch, '- id: fs-sandbox\n  disabled: false\n')
    assert.deepEqual(failures(report()), ['member-wall-row'])
    write(homePatch, '- id: webserver\n  disabled: true\n')
    assert.deepEqual(failures(report()), ['webserver-missing'])
    write(homePatch, "- insert:\n    - id: connection\n      name: '@owner/other'\n")
    assert.deepEqual(failures(report()), ['provider-collision'])
    const rollback = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
      .match(/\x60\x60\x60yaml\n(- id: member-wall-fs\n  disabled: true\n- id: fs-sandbox\n  disabled: false\n)\x60\x60\x60/)?.[1]
    assert.ok(rollback, 'README carries the mode-off patch')
    write(homePatch, rollback)
    const directory = boot.loadProfileDirectory('dsh', f.profile, installAnchor)
    const patches = boot.readProfilePatches('dsh', {
      dir: f.profile, home: f.dshHome, patchPath: patch, overlays: [],
    }, directory)
    const composed = boot.composeEntries([patches])
    assert.equal(composed.find(row => row.id === 'fs-sandbox').disabled, false)
    assert.equal(composed.find(row => row.id === 'member-wall-fs').disabled, true)

    // Install a later bundle only on the real profile's parent Node lookup paths.
    const shared = '@fixture/shared-fs'
    const withShared = structuredClone(manifest)
    withShared.dsh.profile.bundles.push(shared)
    write(join(f.profile, 'package.json'), JSON.stringify(withShared))
    for (const parent of [bots, botsImage]) {
      write(join(parent, 'cordis.patch.yml'), `- id: fs-sandbox\n  disabled: true\n- insert:\n    - ${JSON.stringify(f.wall)}\n`)
    }
    write(patch, fs.readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url)))
    fs.rmSync(homePatch)
    assert.deepEqual(failures(report()), [])
    for (const lookup of [dirname(f.profile), f.dshHome, dirname(f.dshHome)]) {
      const pkg = join(lookup, 'node_modules', shared)
      write(join(pkg, 'package.json'), JSON.stringify({ name: shared, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      write(join(pkg, 'cordis.patch.yml'), '- id: fs-sandbox\n  disabled: false\n')
      const actual = boot.loadProfileDirectory('dsh', f.profile, installAnchor)
      assert.equal(actual.layers.find(layer => layer.packageName === shared)?.packageDir, pkg)
      assert.deepEqual(failures(report()), ['member-wall-row'], lookup)
      fs.rmSync(pkg, { recursive: true })
    }
    for (const parent of [bots, botsImage]) write(join(parent, 'cordis.patch.yml'), botsPatch)
    write(patch, shipped)
    write(homePatch, rollback)
    const original = legacyProfile(f, {
      ...manifest, dsh: { profile: { bundles: [...manifest.dsh.profile.bundles, '@deepseek-ai/dsh-experimental-schedule-bundle'] } },
    })
    const checkBoot = { ...appBoot, loadProfile(...args) {
      const loaded = boot.loadProfile(...args)
      assert.equal(fs.existsSync(join(loaded.dir, '.dsh-module-fallback')), false)
      assert.equal(fs.existsSync(join(loaded.dir, 'node_modules', 'old-bundle')), false)
      assert.doesNotMatch(fs.readFileSync(join(loaded.dir, 'package.json'), 'utf8'), /dsh-experimental-schedule-bundle/)
      return loaded
    } }
    assert.deepEqual(failures(f.report({ installAnchor, appBoot: checkBoot })), ['member-wall-row'])
    original.check()
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

test('each failed image prerequisite refuses mode on before either launcher runs', async t => {
  const f = setup(t)
  const blocked = [
    ['bot-runner-config', f.report({ env: { ...f.env, AUTOMAGIK_BOT_RUNNER_SOCKET: undefined } })],
    ['bot-runner-socket', f.report({ groups: [] })],
    ['bot-trees-disjoint', f.report({ env: { ...f.env, AUTOMAGIK_BOT_RUNNER_WORK_ROOT: f.wall.config.botsRoot } })],
    ['instance-config', f.report({ env: { ...f.env, AUTOMAGIK_INSTANCE_ID: ' ' } })],
  ]
  f.rows.pop()
  blocked.push(['member-wall-row', f.report()])
  for (const [code, readiness] of blocked) {
    const events = []
    await runStartup({ env: { AUTOMAGIK_MULTIUSER: '1' }, readiness, warn: line => events.push(line),
      exit: status => events.push(status), launchCore: () => assert.fail('core launched'), launchDsh: () => assert.fail('DSH launched') })
    assert.deepEqual(events, [`multiuser is on, but startup readiness failed: ${code}`, 1])
  }
})
