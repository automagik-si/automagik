import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { healthReply } from './supervisor-health-wire.mjs'
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
      if (mode === 'pretrial-team-missing') fs.unlinkSync(join(process.env.AUTOMAGIK_BOTS_HOME, 'state.json'))
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
  if (process.env.AUTOMAGIK_SUPERVISOR_BOOT && process.env.SUPERVISOR_EXPECT_ROLLBACK) {
    assert.equal(process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK, process.env.AUTOMAGIK_SUPERVISOR_BOOT)
  }
  const installed = read(join(profile, 'node_modules/@automagik/bots-dsh/package.json')).version
  const candidate = installed === '3.160.3'
  const statePath = join(process.env.AUTOMAGIK_BOTS_HOME, 'state.json')
  const losesTeam = candidate && ['trial-team-missing', 'trial-team-missing-recover'].includes(mode)
  const rosterPresent = fs.existsSync(statePath) && !losesTeam
  if (losesTeam) {
    fs.unlinkSync(statePath)
    write(statePath, { version: 2, revision: 1, bots: {} })
    if (mode === 'trial-team-missing-recover') record({ event: 'team-replaced' })
  }
  if (candidate && mode === 'trial-team-enoent-recover') {
    fs.unlinkSync(statePath)
    const { install } = await import(pathToFileURL(join(process.env.SUPERVISOR_HOST_SOURCE, 'store.js')))
    const rt = { ctx: { effect() {} }, home: process.env.AUTOMAGIK_BOTS_HOME, statePath, warn() {},
      updateHold: { awaitingBootVerdict: true } }
    install(rt)
    await rt.load()
    record({ event: 'team-read', present: rt.teamHealth().present })
  }
  if (['trial-empty-team-exit', 'trial-team-missing-recover', 'trial-team-enoent-recover'].includes(mode)) {
    if (candidate && mode === 'trial-empty-team-exit') write(statePath, { version: 2, revision: 1, bots: {} })
    else if (!candidate) {
      const roster = fs.existsSync(statePath) ? read(statePath) : null
      record({ event: 'roster-at-boot', installed, bots: Object.keys(roster?.bots ?? {}) })
    }
  }
  if (candidate && mode === 'trial-new-format') write(statePath, { version: 3, revision: 8, note: 'edited during trial' })
  if (candidate && mode === 'trial-dsh-edit') {
    const path = join(profile, 'package.json')
    const manifest = read(path)
    manifest.dsh.profile.bundles.push('reconciled')
    write(path, manifest)
  }
  if (candidate && mode === 'trial-dependency-edit') {
    const path = join(profile, 'package.json')
    const manifest = read(path)
    manifest.dependencies['custom-plugin'] = '^2.0.0'
    write(path, manifest)
  }
  if (candidate && mode === 'trial-lane-dependency-edit') {
    const path = join(profile, 'package.json')
    const manifest = read(path)
    manifest.dependencies['@automagik/bots-dsh'] = '^3.160.3'
    write(path, manifest)
  }
  if (candidate && mode === 'trial-compatibility-edit') write(join(profile, 'compatibility.json'), { version: 1, changed: true })
  if ((mode === 'trial-exit' || mode === 'rollback-unhealthy' || mode === 'trial-empty-team-exit') && candidate) {
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
    if (mode === 'retired-announcement' && bootsAlready === 0) {
      // Delivery 6 starts an update only with this child's listener verified, so it announces first.
      fs.writeSync(1, 'dsh web: ' + url + '?token=image-child-1\n')
      // The previous child exits first, while a descendant still holds both output pipes.
      const program = `
        const { existsSync, writeSync } = require('node:fs')
        const interval = setInterval(() => {
          if (!existsSync(process.argv[1])) return
          clearInterval(interval)
          writeSync(1, 'dsh web: http://127.0.0.1:3080/?token=retired-stdout\\n')
          writeSync(2, 'dsh web: http://127.0.0.1:3080/?token=retired-stderr\\n')
        }, 10)
        setTimeout(() => process.exit(), 5000).unref()
      `
      const retired = spawn(process.execPath, ['-e', program, join(root, 'release-retired-output')], { stdio: ['ignore', 1, 2] })
      retired.unref()
    } else if (process.env.SUPERVISOR_IMAGE_HOOKS) {
      fs.writeSync(1, 'dsh web: ' + url + `?token=image-child-${bootsAlready + 1}\n`)
      fs.writeSync(2, 'diagnostic token=image-diagnostic\n')
    } else {
      fs.writeSync(1, 'dsh web: ' + url + '?token=fixture-token\n')
    }
  } else {
    const fault = candidate && mode.startsWith('trial-') ? mode.slice('trial-'.length) : null
    const unhealthy = mode === 'pre-switch-unhealthy' || (mode === 'restored-unhealthy' && bootsAlready > 0)
      || (mode === 'rollback-unhealthy' && bootsAlready > 1) || fault === 'port'
    const unauthorizedBody = process.env.SUPERVISOR_PATCHED_401 === '1'
      ? 'dsh web authentication required; open the launch URL saved in '
        + home.trim().replace(/[\\/]+$/u, '') + '/launch-url.\n'
      : undefined
    let expectedRun = process.env.AUTOMAGIK_SUPERVISOR_RUN
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const chunks = []
      for await (const part of req) chunks.push(part)
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
      record({ event: 'probe', url: url.searchParams.has('token') ? '/?token=<redacted>' : req.url,
        host: req.headers.host, authorization: req.headers.authorization, endpoint: payload?.endpoint,
        health: payload?.payload?.health })
      if (unhealthy) return req.socket.destroy()
      const manifest = read(join(profile, 'package.json'))
      const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('@automagik/'))
        .map(name => ({ name, loaded: true, version: read(join(profile, 'node_modules', name, 'package.json')).version }))
      const statePathOfRun = join(home, 'update/web/state.json')
      const update = fs.existsSync(statePathOfRun) ? read(statePathOfRun) : null
      const live = update?.bootId === process.env.AUTOMAGIK_SUPERVISOR_BOOT ? update : null
      const terminal = ['healthy', 'rolledBack', 'notUpdated'].includes(live?.phase)
      if (terminal && live.runId === expectedRun) expectedRun = undefined
      const run = live && !terminal ? live.runId : expectedRun ?? null
      const result = healthReply({
        url, headers: req.headers, payload, plugins, run, present: rosterPresent, unauthorizedBody,
        legacy: !fs.existsSync(join(profile, 'node_modules/@automagik/bots-dsh/src/host/update-contract.json')),
        bots: fs.existsSync(statePath) && read(statePath).note ? 1 : 0,
        fault: candidate && ['trial-new-format', 'trial-dsh-edit', 'trial-dependency-edit', 'trial-compatibility-edit'].includes(mode) ? 'page' : fault,
      })
      res.writeHead(result.status, result.headers)
      res.end(result.body)
    })
    const announce = bound => {
      const advertised = process.env.SUPERVISOR_ANNOUNCED_URL ?? arg('--public-url') ?? bound
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
      fs.writeFileSync(join(root, 'dsh-child-pid'), String(process.pid))
      const url = 'http://' + host + ':' + server.address().port + '/'
      const delay = Number(process.env.SUPERVISOR_ANNOUNCE_DELAY ?? 0)
      if (delay) setTimeout(() => announce(url), delay).unref()
      else announce(url)
    })
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(sig, () => {
        record({ event: 'stop', signal: sig })
        server.close()
      })
    }
  }
}
