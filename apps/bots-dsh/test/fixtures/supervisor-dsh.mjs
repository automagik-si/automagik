import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

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
  if (args[2] === 'add') {
    assert.ok(flags.includes('--prefer-offline'))
    assert.ok(flags.includes('--registry=https://registry.example.invalid/npm/'))
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
    fs.writeFileSync(join(profile, 'pnpm-lock.yaml'), lock.join('\n') + '\n')
    if (mode === 'workspace-edit') fs.appendFileSync(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: isolated\n')
    if (mode === 'lock-edit-while-staging') fs.appendFileSync(join(root, 'dsh/profiles/web/pnpm-lock.yaml'), 'owner: edited\n')
  } else {
    assert.equal(args[2], 'install')
    for (const flag of ['--offline', '--frozen-lockfile', '--ignore-scripts']) assert.ok(flags.includes(flag))
    if (live) {
      assert.ok(flags.includes('--prod'))
      assert.equal(fs.existsSync(join(profile, 'package.json.lock')), false)
      if (mode === 'relink-fails') process.exitCode = 3
    } else if (mode === 'frozen-fails') process.exitCode = 4
  }
} else {
  assert.equal(action, 'web')
  record({ event: 'boot', args, home, boot: process.env.AUTOMAGIK_SUPERVISOR_BOOT, version: process.env.AUTOMAGIK_SUPERVISOR_VERSION })
  const installed = read(join(profile, 'node_modules/@automagik/bots-dsh/package.json')).version
  if (mode === 'trial-exit' && installed === '3.160.3') {
    process.exitCode = 19
  } else if (mode === 'exit') {
    process.exitCode = 23
  } else {
    const server = createServer((_req, res) => res.end('ready'))
    server.listen(0, '127.0.0.1', () => {
      // Split the announcement across writes so the supervisor must assemble the line.
      process.stdout.write('dsh web: http://127.0.0.1:')
      setImmediate(() => console.log(`${server.address().port}/?token=x`))
    })
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(sig, () => {
        record({ event: 'stop', signal: sig })
        server.close()
      })
    }
  }
}
