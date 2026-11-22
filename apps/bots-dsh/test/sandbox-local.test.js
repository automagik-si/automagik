import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import AutomagikSandboxProvider from '../src/host/sandbox-local.js'

const TARGET = '/etc/ssh/ssh_config.d'
const BASE = 'automagik-ssh-config-d'
const UID = process.getuid?.()
const OTHER = UID === 4242 ? 4243 : 4242
const TRUE = ['true']
const GRACE = 30_000
const ownerTest = { skip: typeof UID !== 'number' || UID === 0 ? 'requires an unprivileged POSIX user' : false }

function scratch(t, parent = tmpdir()) {
  const path = fs.mkdtempSync(join(parent, 'automagik-2024-'))
  t.after(() => fs.rmSync(path, { recursive: true, force: true }))
  return path
}

async function mount(t, Provider, internals, config = {}) {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(Provider, config)
  Object.assign(root.sandbox.internals, { chain: ['bwrap'], ...internals })
  return { root, provider: root.sandbox }
}

async function fixture(t, configure = () => {}) {
  const dir = scratch(t)
  const source = join(dir, 'ssh_config.d')
  const runtime = join(dir, 'runtime')
  const workspace = join(dir, 'workspace')
  for (const folder of [source, runtime, workspace]) fs.mkdirSync(folder, { mode: 0o700 })
  const config = join(source, 'root.conf')
  fs.writeFileSync(config, 'Host fixture2024\n  ServerAliveInterval 42\n', { mode: 0o644 })
  const owners = new Map([[config, 0]])
  const opened = new Map()
  const settings = {
    source, runtimeDirectory: runtime, fs: {
      ...fs,
      lstatSync(path, options) {
        const stat = fs.lstatSync(path, options)
        if (path === source && stat.isDirectory()) stat.uid = 0n
        return stat
      },
      openSync(path, flags) {
        const target = fs.realpathSync(path)
        const fd = fs.openSync(path, flags)
        opened.set(fd, target)
        return fd
      },
      fstatSync(fd, options) {
        const stat = fs.fstatSync(fd, options)
        stat.uid = BigInt(owners.get(opened.get(fd)) ?? UID)
        return stat
      },
      closeSync(fd) {
        opened.delete(fd)
        fs.closeSync(fd)
      },
    },
  }
  configure(settings)
  const { root, provider } = await mount(t, AutomagikSandboxProvider, { sshConfig: settings })
  const { provider: stock } = await mount(t, LocalSandboxProvider)
  return {
    dir, root, source, runtime, workspace, config, owners, settings, provider, stock,
    policy: { mode: 'workspace-write', workspaceRoot: workspace },
  }
}

function boundPath(confined) {
  const { argv } = confined
  const separator = argv.indexOf('--')
  return argv[separator - 1] === TARGET && argv[separator - 3] === '--ro-bind' ? argv[separator - 2] : null
}

async function confine(f, policy = f.policy) {
  return f.provider.confine(TRUE, policy)
}

async function noBind(f, policy = f.policy) {
  const stock = await f.stock.confine(TRUE, policy)
  assert.deepEqual(await confine(f, policy), stock)
}

test('T0 copies trusted files and link targets with source bytes and mode', ownerTest, async t => {
  const f = await fixture(t)
  fs.symlinkSync('root.conf', join(f.source, 'linked.conf'))
  fs.writeFileSync(join(f.source, 'caller.conf'), 'Host *\n', { mode: 0o644 })
  let reads = 0
  f.settings.fs.readSync = (...args) => { reads += 1; return fs.readSync(...args) }
  const before = await f.stock.confine(TRUE, f.policy)
  const after = await confine(f)
  const generation = boundPath(after)
  assert.ok(generation)
  const index = before.argv.indexOf('--')
  assert.deepEqual(after, {
    ...before,
    argv: [...before.argv.slice(0, index), '--ro-bind', generation, TARGET, ...before.argv.slice(index)],
  })
  assert.equal(fs.statSync(generation).mode & 0o777, 0o700)
  for (const name of fs.readdirSync(f.source)) {
    const from = join(f.source, name)
    const to = join(generation, name)
    assert.deepEqual(fs.readFileSync(to), fs.readFileSync(from))
    assert.equal(fs.statSync(to).mode & 0o777, fs.statSync(from).mode & 0o777)
    assert.ok(fs.lstatSync(to).isFile())
  }
  const afterFirst = reads
  assert.ok(afterFirst > 0)
  assert.deepEqual(await confine(f), after)
  assert.equal(reads, afterFirst)
})

test('T1 third-uid files disable the whole bind', ownerTest, async t => {
  const f = await fixture(t)
  f.owners.set(f.config, OTHER)
  await noBind(f)
})

for (const [id, mode] of [['T2', 0o664], ['T3', 0o646]]) {
  test(`${id} writable mode ${mode.toString(8)} disables the whole bind`, ownerTest, async t => {
    const f = await fixture(t)
    fs.chmodSync(f.config, mode)
    await noBind(f)
  })
}

test('T4 symlinks to third-uid files disable the whole bind', ownerTest, async t => {
  const f = await fixture(t)
  const target = join(f.dir, 'outside.conf')
  fs.writeFileSync(target, 'Host *\n')
  f.owners.set(target, OTHER)
  fs.symlinkSync(target, join(f.source, 'link.conf'))
  await noBind(f)
})

const invalidEntries = {
  dangling: path => fs.symlinkSync('absent', path),
  directory: path => fs.mkdirSync(path),
  fifo: path => execFileSync('mkfifo', [path], { timeout: 3000 }),
  oversize: path => { fs.writeFileSync(path, ''); fs.truncateSync(path, 1024 * 1024 + 1) },
}
for (const [kind, create] of Object.entries(invalidEntries)) {
  test(`T5 ${kind} entries disable the whole bind`, ownerTest, async t => {
    const f = await fixture(t)
    create(join(f.source, 'invalid.conf'))
    await noBind(f)
  })
}

test('T6 group-write, a symlink, or a non-root owner on the source directory prevents a bind', ownerTest, async t => {
  const f = await fixture(t)
  fs.chmodSync(f.source, 0o770)
  await noBind(f)
  fs.chmodSync(f.source, 0o700)
  f.settings.fs.lstatSync = fs.lstatSync
  await noBind(f)
  const alias = join(f.dir, 'alias')
  fs.symlinkSync(f.source, alias)
  f.settings.source = alias
  await noBind(f)
})

test('T7 a file changing during the descriptor read gets no bind until a stable call', ownerTest, async t => {
  const f = await fixture(t)
  f.settings.fs.readSync = (...args) => {
    const read = fs.readSync(...args)
    fs.appendFileSync(f.config, '# changed\n')
    return read
  }
  await noBind(f)
  f.settings.fs.readSync = fs.readSync
  assert.ok(boundPath(await confine(f)))
})

test('T8 a previously trusted link is revalidated after replacement', ownerTest, async t => {
  const f = await fixture(t)
  const link = join(f.source, 'link.conf')
  const foreign = join(f.dir, 'foreign.conf')
  fs.writeFileSync(foreign, 'Host *\n')
  f.owners.set(foreign, OTHER)
  fs.symlinkSync('root.conf', link)
  assert.ok(boundPath(await confine(f)))
  fs.unlinkSync(link)
  fs.symlinkSync(foreign, link)
  await noBind(f)
})

test('T9 chmod-only changes refresh and a subsequent third-owner chown suppresses the bind', ownerTest, async t => {
  const f = await fixture(t)
  const first = boundPath(await confine(f))
  const before = fs.statSync(f.config, { bigint: true })
  fs.chmodSync(f.config, 0o640)
  assert.equal(fs.statSync(f.config, { bigint: true }).mtimeNs, before.mtimeNs)
  const next = boundPath(await confine(f))
  assert.ok(next && next !== first)
  assert.equal(fs.statSync(join(next, 'root.conf')).mode & 0o777, 0o640)
  f.owners.set(f.config, OTHER)
  await noBind(f)
})

test('T10 path overlap and dev/ino aliases block copies under workspace-write only', ownerTest, async t => {
  const f = await fixture(t)
  const base = join(f.runtime, BASE)
  const child = join(base, 'child')
  fs.mkdirSync(child, { recursive: true, mode: 0o700 })
  const workspaceAlias = join(f.dir, 'runtime-alias')
  fs.symlinkSync(f.runtime, workspaceAlias)
  const r = join(f.dir, 'bind-alias')
  fs.mkdirSync(r)
  f.settings.fs.statSync = (path, options) => fs.statSync(path === r ? base : path, options)
  const policies = [
    { workspaceRoot: f.runtime },
    { workspaceRoot: base },
    { workspaceRoot: child },
    { workspaceRoot: workspaceAlias },
    { workspaceRoot: r },
    { additionalWritableRoots: [f.runtime] },
  ]
  for (const extra of policies) {
    const policy = { ...f.policy, ...extra }
    await noBind(f, policy)
    assert.ok(boundPath(await confine(f, { ...policy, mode: 'read-only' })))
  }
})

test('T11 rejects an unset, relative, symlinked, or insecure runtime or copy base', ownerTest, async t => {
  const f = await fixture(t)
  const alias = join(f.dir, 'runtime-alias')
  fs.symlinkSync(f.runtime, alias)
  for (const runtimeDirectory of [undefined, 'relative', alias, `${alias}/`]) {
    f.settings.runtimeDirectory = runtimeDirectory
    await noBind(f)
  }
  f.settings.runtimeDirectory = f.runtime
  fs.chmodSync(f.runtime, 0o740)
  await noBind(f)
  fs.chmodSync(f.runtime, 0o700)
  const lstat = f.settings.fs.lstatSync
  f.settings.fs.lstatSync = (path, options) => {
    const stat = lstat(path, options)
    if (path === f.runtime) stat.uid = BigInt(OTHER)
    return stat
  }
  await noBind(f)
  f.settings.fs.lstatSync = lstat
  fs.symlinkSync(f.workspace, join(f.runtime, BASE))
  await noBind(f)
})

test('T12–T13 a refresh publishes a new complete generation and retains the previous argv', ownerTest, async t => {
  const f = await fixture(t)
  const policy = { ...f.policy, mode: 'read-only' }
  const first = await confine(f, policy)
  const path = boundPath(first)
  const filename = join(path, 'root.conf')
  const before = fs.readFileSync(filename, 'utf8')
  const ino = fs.statSync(filename, { bigint: true }).ino
  fs.appendFileSync(f.config, '# refresh\n')
  const second = await confine(f, policy)
  const next = boundPath(second)
  assert.ok(next && next !== path)
  assert.equal(fs.readFileSync(join(next, 'root.conf'), 'utf8'), before + '# refresh\n')
  assert.equal(fs.readFileSync(filename, 'utf8'), before)
  assert.equal(fs.statSync(filename, { bigint: true }).ino, ino)
  if (canBwrap()) {
    for (const { argv } of [first, second]) assert.equal(spawnSync(argv[0], argv.slice(1)).status, 0)
  } else {
    assert.ok(fs.existsSync(boundPath(first)) && fs.existsSync(boundPath(second)))
    t.diagnostic('real spawn SKIP: bubblewrap cannot create a user namespace')
  }
})

test('T14 refresh prunes only retired generations last used more than 30 seconds ago', ownerTest, async t => {
  let now = 0
  const f = await fixture(t, settings => { settings.now = () => now })
  const first = boundPath(await confine(f))
  now = GRACE
  fs.appendFileSync(f.config, '# second\n')
  const second = boundPath(await confine(f))
  assert.ok(fs.existsSync(first))
  now += 1
  fs.appendFileSync(f.config, '# third\n')
  const third = boundPath(await confine(f))
  assert.ok(!fs.existsSync(first))
  assert.ok(fs.existsSync(second) && fs.existsSync(third))
})

test('T15 disposal keeps outstanding argvs for 30 seconds and sweeps dead provider folders', ownerTest, async t => {
  const pending = []
  const f = await fixture(t, settings => {
    settings.schedule = (cleanup, delay) => {
      assert.equal(delay, GRACE)
      pending.push(cleanup)
      return { unref() {} }
    }
    settings.kill = (pid, signal) => {
      assert.equal(signal, 0)
      if (pid === 2147483647) throw Object.assign(new Error('missing'), { code: 'ESRCH' })
      assert.equal(pid, process.pid)
    }
  })
  const base = join(f.runtime, BASE)
  const dead = join(base, 'p-dead')
  const live = join(base, 'p-live')
  for (const [path, pid] of [[dead, 2147483647], [live, process.pid]]) {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 })
    fs.writeFileSync(join(path, 'owner'), `${pid}\n`)
  }
  const generation = boundPath(await confine(f))
  assert.ok(!fs.existsSync(dead))
  assert.ok(fs.existsSync(live))
  await f.root.fiber.dispose()
  assert.ok(fs.existsSync(generation))
  assert.equal(pending.length, 1)
  pending[0]()
  assert.ok(!fs.existsSync(dirname(generation)))
  assert.ok(fs.existsSync(live))
})

test('T16 generation byte, metadata, and entry-list changes force a fresh copy', ownerTest, async t => {
  const f = await fixture(t)
  let current = boundPath(await confine(f))
  for (const tamper of [
    path => fs.writeFileSync(join(path, 'root.conf'), 'changed\n'),
    path => fs.chmodSync(join(path, 'root.conf'), 0o600),
    path => fs.writeFileSync(join(path, 'unexpected.conf'), 'Host *\n'),
  ]) {
    tamper(current)
    const replacement = boundPath(await confine(f))
    assert.ok(replacement && replacement !== current)
    assert.deepEqual(fs.readdirSync(replacement), ['root.conf'])
    assert.deepEqual(fs.readFileSync(join(replacement, 'root.conf')), fs.readFileSync(f.config))
    current = replacement
  }
})

test('T17 other rungs and custom runners keep the complete stock confine result', async t => {
  const policy = { mode: 'read-only', workspaceRoot: scratch(t) }
  for (const runner of ['landlock', 'seatbelt', 'windows-acl', 'custom']) {
    const hooks = { chain: [runner], landlockLauncher: '/fixture/landlock', windowsAclRunnerArgs: ['/fixture/acl'] }
    const config = runner === 'custom' ? { runnerCommand: ['/fixture/custom'], runnerFailureSignatures: ['custom failure'] } : {}
    const { provider } = await mount(t, AutomagikSandboxProvider, hooks, config)
    const { provider: stock } = await mount(t, LocalSandboxProvider, hooks, config)
    assert.deepEqual(await provider.confine(TRUE, policy), await stock.confine(TRUE, policy))
  }
})

test('T18 an unknown bwrap layout and copy errors preserve the stock confine result', ownerTest, async t => {
  const f = await fixture(t)
  const spy = t.mock.method(f.provider, 'sshConfigBind', () => { throw new Error('fixture copy failure') })
  await noBind(f)
  assert.equal(spy.mock.callCount(), 1)
  t.mock.method(LocalSandboxProvider.prototype, 'runnerArgv', () => ['bwrap', '--bind', '/', '/'])
  await noBind(f)
  assert.equal(spy.mock.callCount(), 1)
})

const canBwrap = () => process.platform === 'linux' && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true',
], { timeout: 5000 }).status === 0

function unavailable() {
  if (!canBwrap()) return 'bubblewrap cannot create a user namespace'
  if (UID === 0 || !fs.existsSync(TARGET) || fs.lstatSync(TARGET).uid !== 0) return 'trusted system SSH drop-ins unavailable'
  if (!fs.readdirSync(TARGET).some(name => name.endsWith('.conf') && fs.statSync(join(TARGET, name)).uid !== UID)) {
    return 'no system SSH drop-in with a non-caller owner'
  }
  return false
}

async function systemFixture(t, mode) {
  // The workspace-write bwrap profile mounts a fresh /tmp, so use disposable
  // sibling folders outside it for the live probe of the host copy path.
  const dir = scratch(t, import.meta.dirname)
  const workspace = join(dir, 'workspace')
  const runtimeDirectory = join(dir, 'runtime')
  for (const path of [workspace, runtimeDirectory]) fs.mkdirSync(path, { mode: 0o700 })
  const policy = { mode, workspaceRoot: workspace }
  const { provider } = await mount(t, AutomagikSandboxProvider, { sshConfig: { runtimeDirectory } })
  const { provider: stock } = await mount(t, LocalSandboxProvider)
  const execute = async (argv, backend = provider) => {
    const confinement = await backend.confine(argv, policy)
    assert.equal(confinement.argv[0], 'bwrap')
    if (backend === provider) assert.ok(boundPath(confinement))
    const result = spawnSync(confinement.argv[0], confinement.argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 8000 })
    assert.ifError(result.error)
    return { ...result, confinement }
  }
  return { dir, workspace, provider, stock, execute }
}

function noPersonalSsh() {
  try {
    fs.lstatSync(join(userInfo().homedir, '.ssh', 'config'))
    return 'OpenSSH would read a personal configuration; use a disposable OS user for the live case'
  } catch (error) {
    return error.code === 'ENOENT' ? false : 'cannot verify that the SSH configuration is disposable'
  }
}

const sshDump = fs.existsSync(join(TARGET, '20-systemd-ssh-proxy.conf')) ? 'vsock/1' : 'fixture2024'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const badOwner = /Bad owner or permissions on \/etc\/ssh\/ssh_config\.d\//
const readOnly = /Read-only file system/i
const liveSkip = unavailable()
const sshSkip = liveSkip || noPersonalSsh()

for (const mode of ['workspace-write', 'read-only']) {
  test(`L1 ${mode}: effective SSH config is byte-identical to the host`, { skip: sshSkip }, async t => {
    const f = await systemFixture(t, mode)
    const argv = ['ssh', '-G', sshDump]
    const host = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', cwd: f.workspace, timeout: 8000 })
    const stock = await f.execute(argv, f.stock)
    const candidate = await f.execute(argv)
    assert.equal(host.status, 0, host.stderr)
    assert.equal(stock.status, 255)
    assert.match(stock.stderr, badOwner)
    assert.equal(candidate.status, 0, candidate.stderr)
    assert.equal(candidate.stdout, host.stdout)
    assert.equal(sha256(candidate.stdout), sha256(host.stdout))
    if (sshDump === 'vsock/1') assert.match(candidate.stdout, /^proxycommand \/usr\/lib\/systemd\/systemd-ssh-proxy %h %p$/m)
  })

  test(`L2–L5 ${mode}: copy and target stay read-only and workspace writes follow policy`, { skip: liveSkip }, async t => {
    const f = await systemFixture(t, mode)
    const copy = boundPath((await f.execute(TRUE)).confinement)
    const probe = `automagik-2024-${basename(f.dir)}`
    for (const folder of [TARGET, copy]) {
      const denied = await f.execute(['touch', join(folder, probe)])
      assert.notEqual(denied.status, 0)
      assert.match(denied.stderr, readOnly)
    }
    if (mode === 'workspace-write') {
      const link = await f.execute(['ln', join(copy, fs.readdirSync(copy)[0]), join(f.workspace, 'linked')])
      assert.notEqual(link.status, 0)
      assert.match(link.stderr, /Invalid cross-device link/)
    }
    const write = await f.execute(['sh', '-c', 'printf ok > "$1"', 'sh', join(f.workspace, 'written')])
    if (mode === 'workspace-write') {
      assert.equal(write.status, 0, write.stderr)
      assert.equal(fs.readFileSync(join(f.workspace, 'written'), 'utf8'), 'ok')
    } else {
      assert.notEqual(write.status, 0)
      assert.match(write.stderr, readOnly)
    }
  })

  test(`L6 ${mode}: SSH reaches only the offline banner endpoint`, { skip: sshSkip }, async t => {
    const f = await systemFixture(t, mode)
    const script = join(f.workspace, 'endpoint.sh')
    const hits = join(f.workspace, 'hits')
    fs.writeFileSync(script, '#!/bin/sh\nprintf "fixture2024 endpoint hit\\n" >&2\nprintf "SSH-2.0-fixture2024\\r\\n"\n', { mode: 0o700 })
    const argv = ['ssh', '-v', '-o', 'BatchMode=yes', '-o', `ProxyCommand=${script}`, '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'IdentityFile=none', 'git@fixture2024', 'true']
    const run = async provider => {
      const result = await f.execute(argv, provider)
      if (/^fixture2024 endpoint hit$/m.test(result.stderr)) fs.appendFileSync(hits, 'hit\n')
      return result.stderr
    }
    assert.match(await run(f.stock), badOwner)
    assert.ok(!fs.existsSync(hits))
    const stderr = await run(f.provider)
    assert.match(stderr, /remote software version fixture2024/)
    assert.doesNotMatch(stderr, badOwner)
    assert.equal(fs.readFileSync(hits, 'utf8'), 'hit\n')
  })

  test(`L7 ${mode}: unsafe disposable Includes stay refused or leave the stock argv in use`, { skip: liveSkip }, async t => {
    const f = await systemFixture(t, mode)
    const entry = join(f.workspace, 'unsafe.conf')
    const config = join(f.workspace, 'ssh_config')
    fs.writeFileSync(config, `Include ${entry}\n`, { mode: 0o600 })
    fs.writeFileSync(entry, 'Host *\n  ServerAliveInterval 42\n')
    const argv = ['ssh', '-F', config, '-G', 'fixture2024']
    fs.chmodSync(entry, 0o646)
    for (const run of [() => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 8000 }), () => f.execute(argv)]) {
      const result = await run()
      assert.equal(result.status, 255)
      assert.match(result.stderr, /Bad owner or permissions/)
    }
    fs.chmodSync(entry, 0o664)
    const verdict = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 8000 })
    t.diagnostic(`OpenSSH's group-write verdict: exit ${verdict.status}`)
    const hermetic = await fixture(t)
    fs.chmodSync(hermetic.config, 0o664)
    await noBind(hermetic, { ...hermetic.policy, mode })
  })

  test(`L8–L9 ${mode}: stock and candidate classify read and write failures the same`, { skip: liveSkip }, async t => {
    const f = await systemFixture(t, mode)
    const secret = join(f.dir, 'unreadable')
    fs.writeFileSync(secret, 'disposable\n', { mode: 0o000 })
    for (const [argv, error, denied] of [
      [['cat', secret], /Permission denied/, false],
      [['touch', join(f.dir, 'outside-workspace')], readOnly, true],
    ]) {
      const classify = async provider => {
        const { status, stderr, confinement } = await f.execute(argv, provider)
        assert.match(stderr, error)
        assert.equal(matchesSignature(status, stderr, confinement.denialSignatures), denied)
        return classifyRunnerFailure(status, stderr, confinement.runnerFailureRules)
      }
      assert.deepEqual(await classify(f.provider), await classify(f.stock))
    }
  })
}
