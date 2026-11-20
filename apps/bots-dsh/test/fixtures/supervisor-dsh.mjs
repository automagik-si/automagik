import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pnpmLock, verifyOfflineLock } from './supervisor-lock.mjs'

const [action, ...args] = process.argv.slice(2)
const { DSH_HOME: home, SUPERVISOR_FIXTURE: root, SUPERVISOR_MODE: mode } = process.env
assert.ok(root && home.startsWith(root + '/'), 'fixture must use its own DSH home')
const profile = join(home, 'profiles/web')
const record = value => fs.appendFileSync(join(root, 'events.jsonl'), JSON.stringify(value) + '\n')
const read = path => JSON.parse(fs.readFileSync(path))
const write = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

if (action === 'plugin') {
  assert.deepEqual(args.slice(0, 2), ['--profile', 'web'])
  assert.equal(process.cwd(), profile)
  const flags = args.slice(3)
  const live = home === join(root, 'dsh')
  record({ event: args[2], args: flags, live })
  if (!live) {
    assert.equal(fs.existsSync(join(profile, '.npmrc')), false)
    assert.equal(fs.existsSync(join(profile, 'cordis.patch.yml')), false)
    assert.equal(fs.statSync(join(profile, 'compatibility.json')).mode & 0o777, 0o400)
  }
  if (mode === 'offline-lock' && process.env.SUPERVISOR_TEST_PNPM) {
    const result = spawnSync(process.execPath, [process.env.SUPERVISOR_TEST_PNPM, args[2], ...flags, '--offline', '--reporter=silent'], {
      stdio: 'inherit',
    })
    process.exit(result.status ?? 1)
  }
  if (args[2] === 'add') {
    assert.ok(flags.includes('--prefer-offline'))
    assert.ok(flags.includes('--registry=' + (process.env.SUPERVISOR_EXPECT_REGISTRY ?? 'https://registry.example.invalid/npm/')))
    const specs = flags.filter(flag => flag.startsWith('file:'))
    const packages = JSON.parse(process.env.SUPERVISOR_PACKAGES)
    const manifest = read(join(profile, 'package.json'))
    for (const spec of specs) {
      const name = /^file:vendor\/automagik-update\/([a-f0-9]{64})\.tgz$/.exec(spec)[1]
      assert.ok(fs.statSync(join(profile, spec.slice(5))).isFile())
      const pkg = packages[name]
      const dir = join(profile, 'node_modules', pkg.name)
      fs.mkdirSync(dir, { recursive: true })
      write(join(dir, 'package.json'), pkg)
      if (pkg.name === '@automagik/bots-dsh') fs.cpSync(process.env.SUPERVISOR_HOST_SOURCE, join(dir, 'src/host'), { recursive: true })
      manifest.dependencies[pkg.name] = spec
    }
    if (mode === 'manifest-edit') manifest.dsh.profile.bundles.pop()
    write(join(profile, 'package.json'), manifest)
    const lock = specs.map((spec, i) => `pin${i}: ${spec}`)
    if (mode === 'bad-pin') lock.push('bad: file:../../escape.tgz')
    fs.writeFileSync(join(profile, 'pnpm-lock.yaml'), mode === 'offline-lock' ? pnpmLock(profile, manifest) : lock.join('\n') + '\n')
    if (mode === 'workspace-edit') fs.appendFileSync(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: isolated\n')
    if (mode === 'lock-edit-while-staging') fs.appendFileSync(join(root, 'dsh/profiles/web/pnpm-lock.yaml'), 'owner: edited\n')
  } else {
    assert.equal(args[2], 'install')
    for (const flag of ['--offline', '--frozen-lockfile', '--ignore-scripts']) assert.ok(flags.includes(flag))
    if (mode === 'offline-lock') verifyOfflineLock(profile)
    if (live) {
      assert.ok(flags.includes('--prod'))
      assert.equal(fs.existsSync(join(profile, 'package.json.lock')), false)
      if (mode === 'compatibility-repair') {
        // DSH starts this repair after restoring the saved manifests, with fresh pnpm args.
        const repair = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
          env: { ...process.env, SUPERVISOR_PNPM_REPAIR: '1' }, stdio: 'inherit',
        })
        assert.equal(repair.status, 0)
        process.exitCode = 1
      }
      if (mode === 'relink-fails' || mode === 'restored-unhealthy') process.exitCode = 3
      if (mode === 'relink-staged-symlink') {
        const [stage] = fs.readdirSync(join(home, 'update/web')).filter(name => name.startsWith('stage-'))
        fs.symlinkSync(join(home, 'update/web', stage, 'target'), join(profile, 'node_modules/invalid-link'))
      }
      if (mode === 'relink-paused') {
        const resume = join(root, 'resume-relink')
        for (let i = 0; !fs.existsSync(resume) && i < 400; i++) await wait(25)
        assert.ok(fs.existsSync(resume), 'fixture was not released')
      }
    } else if (mode === 'frozen-fails') process.exitCode = 4
  }
} else {
  assert.equal(action, 'web')
  const arg = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
    ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const bootsAlready = fs.existsSync(join(root, 'events.jsonl'))
    ? fs.readFileSync(join(root, 'events.jsonl'), 'utf8').split('\n').filter(line => line.includes('"event":"boot"')).length : 0
  record({ event: 'boot', args, home, boot: process.env.AUTOMAGIK_SUPERVISOR_BOOT, version: process.env.AUTOMAGIK_SUPERVISOR_VERSION,
    listenerUnknown: process.env.AUTOMAGIK_SUPERVISOR_LISTENER_UNKNOWN === '1' ? '1' : undefined })
  const installed = read(join(profile, 'node_modules/@automagik/bots-dsh/package.json')).version
  if (mode === 'trial-exit' && installed === '3.160.3') {
    process.exitCode = 19
  } else if (mode === 'bare-announces') {
    fs.writeSync(1, 'dsh web: https://example.invalid/?to')
    fs.writeSync(2, 'diagnostic token=stderr-')
    setImmediate(() => {
      fs.writeSync(1, 'ken=stdout-secret&next=ok\n')
      fs.writeSync(2, 'secret\n')
    })
    process.exitCode = 23
  } else if (mode === 'exit') {
    process.exitCode = 23
  } else if (mode === 'signal-death') {
    process.kill(process.pid, 'SIGKILL')
  } else if (mode === 'signal-forward') {
    const keepAlive = setInterval(() => {}, 1000)
    process.on('SIGTERM', () => {
      record({ event: 'stop', signal: 'SIGTERM' })
      clearInterval(keepAlive)
      process.exitCode = 55
    })
    record({ event: 'waiting-for-signal' })
  } else if (process.env.SUPERVISOR_ANNOUNCE_ONLY) {
    const keepAlive = setInterval(() => {}, 1000)
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
      record({ event: 'stop', signal })
      clearInterval(keepAlive)
    })
    fs.writeFileSync(join(root, 'dsh-child-pid'), String(process.pid))
    const url = arg('--public-url') ?? 'http://127.0.0.1:' + arg('--port') + '/'
    fs.writeSync(1, 'dsh web: ' + url + '?token=fixture-token\n')
  } else {
    const unhealthy = mode === 'pre-switch-unhealthy' || (mode === 'restored-unhealthy' && bootsAlready > 0)
    const server = createServer((req, res) => {
      record({ event: 'probe', url: req.url, host: req.headers.host, authorization: req.headers.authorization })
      if (unhealthy) req.socket.destroy()
      else res.end('ready')
    })
    const announce = bound => {
      const advertised = arg('--public-url') ?? bound
      // Split keys and values across writes on both streams.
      fs.writeSync(1, 'dsh web: ' + advertised + '?to')
      fs.writeSync(2, 'diagnostic token=stderr-')
      setImmediate(() => {
        fs.writeSync(1, 'ken=stdout-')
        fs.writeSync(2, 'secret https://example.invalid/?api_key=query-')
        setImmediate(() => {
          fs.writeSync(1, 'secret&access_token=access-secret\n')
          fs.writeSync(2, 'secret\n')
        })
      })
    }
    const host = arg('--host') ?? '127.0.0.1'
    server.listen(Number(arg('--port') ?? 3080), host, () => {
      announce('http://' + host + ':' + server.address().port + '/')
    })
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(sig, () => {
        record({ event: 'stop', signal: sig })
        server.close()
      })
    }
  }
}
