import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { afterEach } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHECKOUT_PACKAGES, CHECKOUT_REPOSITORY, checkoutFile, sha256, validateInput, verifyCheckoutDirectory } from '../checkout-input.mjs'
import { assemble } from '../assemble.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const owned = []
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'checkout-reader-test-')); owned.push(dir); return dir }
function fixture() {
  const parent = temp(), dir = join(parent, 'checkout-input'); mkdirSync(dir)
  const options = { kind: 'checkout', event: 'pull_request', revision: 'a'.repeat(40), version: '1.2.3', repository: CHECKOUT_REPOSITORY }
  const manifest = { repository: CHECKOUT_REPOSITORY, version: options.version, commit: options.revision, packages: {} }
  const assets = new Map()
  for (const name of Object.keys(CHECKOUT_PACKAGES)) {
    const bytes = Buffer.from(`fixture ${name}`), file = checkoutFile(name, options.version)
    manifest.packages[name] = { version: options.version, file, size: bytes.length, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
    assets.set(file, bytes)
  }
  function save() {
    const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    assets.set('plugins.json', raw); options.manifest = sha256(raw)
    for (const [file, bytes] of assets) writeFileSync(join(dir, file), bytes)
    writeFileSync(join(dir, 'PLUGINS.SHA256SUMS'), [...assets].map(([file, bytes]) => `${sha256(bytes)}  ${file}\n`).join(''))
  }
  save()
  return { parent, dir, options, manifest, assets, save }
}

test('verifies all four identities and returns only the normal three profile packages', () => {
  const f = fixture(), got = verifyCheckoutDirectory(f.dir, f.options)
  assert.equal(Object.keys(got.plugins).length, 3)
  assert.equal(got.plugins['@automagik/bots-dsh'].sha256, sha256(f.assets.get(checkoutFile('@automagik/bots-dsh', '1.2.3'))))
})

for (const [field, value] of [['kind', 'other'], ['kind', 'release'], ['event', 'push'], ['event', 'unknown'], ['revision', 'b'.repeat(40)], ['revision', 'main'], ['manifest', 'b'.repeat(64)], ['manifest', ''], ['repository', 'https://example.invalid/fork'], ['version', '../1.2.3']]) {
  test(`rejects input ${field}=${value}`, () => {
    const f = fixture(); assert.throws(() => verifyCheckoutDirectory(f.dir, { ...f.options, [field]: value }))
  })
}
for (const change of ['repository', 'commit', 'version', 'package-version', 'package-name', 'extra-package', 'missing-package', 'traversal', 'wrong-filename', 'size', 'sri', 'duplicate-json']) {
  test(`refuses ${change} even with a freshly bound manifest digest`, () => {
    const f = fixture(), entry = f.manifest.packages['@automagik/bots-dsh']
    if (change === 'repository') f.manifest.repository = 'https://example.invalid/fork'
    if (change === 'commit') f.manifest.commit = 'b'.repeat(40)
    if (change === 'version') f.manifest.version = '1.2.4'
    if (change === 'package-version') entry.version = '1.2.4'
    if (change === 'package-name') { f.manifest.packages['@automagik/imposter'] = entry; delete f.manifest.packages['@automagik/bots-dsh'] }
    if (change === 'extra-package') f.manifest.packages['@automagik/extra'] = entry
    if (change === 'missing-package') delete f.manifest.packages['@automagik/acp-dsh']
    if (change === 'traversal') entry.file = '../payload.tgz'
    if (change === 'wrong-filename') entry.file = 'wrong.tgz'
    if (change === 'size') entry.size++
    if (change === 'sri') entry.integrity = 'sha512-bad'
    f.save()
    if (change === 'duplicate-json') {
      const raw = readFileSync(join(f.dir, 'plugins.json'), 'utf8').replace('"commit":', `"commit": "${f.options.revision}",\n  "commit":`)
      writeFileSync(join(f.dir, 'plugins.json'), raw); f.options.manifest = sha256(raw)
      const sums = readFileSync(join(f.dir, 'PLUGINS.SHA256SUMS'), 'utf8').replace(/^[a-f0-9]{64}  plugins.json$/m, `${f.options.manifest}  plugins.json`)
      writeFileSync(join(f.dir, 'PLUGINS.SHA256SUMS'), sums)
    }
    assert.throws(() => verifyCheckoutDirectory(f.dir, f.options))
  })
}
for (const change of ['missing', 'extra', 'file-link', 'directory-link', 'parent-link', 'directory-asset', 'duplicate-sum', 'extra-sum', 'missing-sum', 'malformed-sum', 'sha', 'manifest-sha', 'bytes']) {
  test(`refuses ${change} assets`, () => {
    const f = fixture(), file = checkoutFile('@automagik/bots-dsh', f.options.version), sumsPath = join(f.dir, 'PLUGINS.SHA256SUMS')
    let dir = f.dir
    if (change === 'missing') rmSync(join(dir, file))
    if (change === 'extra') writeFileSync(join(dir, 'extra.tgz'), 'extra')
    if (change === 'file-link') { renameSync(join(dir, file), join(f.parent, 'target')); symlinkSync(join(f.parent, 'target'), join(dir, file)) }
    if (change === 'directory-link') { renameSync(dir, `${dir}-real`); symlinkSync(`${dir}-real`, dir) }
    if (change === 'parent-link') { const alias = join(temp(), 'alias'); symlinkSync(f.parent, alias); dir = join(alias, 'checkout-input') }
    if (change === 'directory-asset') { rmSync(join(dir, file)); mkdirSync(join(dir, file)) }
    const sums = readFileSync(sumsPath, 'utf8')
    if (change === 'duplicate-sum') writeFileSync(sumsPath, sums + sums.split('\n')[0] + '\n')
    if (change === 'extra-sum') writeFileSync(sumsPath, sums + `${'a'.repeat(64)}  other.tgz\n`)
    if (change === 'missing-sum') writeFileSync(sumsPath, sums.split('\n').slice(1).join('\n'))
    if (change === 'malformed-sum') writeFileSync(sumsPath, sums + '../other.tgz\n')
    if (change === 'sha') writeFileSync(sumsPath, sums.replace(/^[a-f0-9]{64}/, 'b'.repeat(64)))
    if (change === 'manifest-sha') writeFileSync(sumsPath, sums.replace(/^[a-f0-9]{64}(  plugins.json)$/m, 'b'.repeat(64) + '$1'))
    if (change === 'bytes') writeFileSync(join(dir, file), 'altered bytes')
    assert.throws(() => verifyCheckoutDirectory(dir, f.options))
  })
}

test('release mode rejects local input arguments and PR events; standalone/companion stays release', () => {
  assert.deepEqual(validateInput({}), { kind: 'release' })
  for (const event of ['push', 'release', 'workflow_dispatch']) assert.deepEqual(validateInput({ kind: 'release', event }), { kind: 'release' })
  for (const input of [{ kind: 'release', manifest: 'a'.repeat(64) }, { kind: 'release', event: 'pull_request' }, { event: 'unknown' }]) assert.throws(() => validateInput(input))
})

test('invalid input is refused by assembly before out deletion or any install/network call', async () => {
  const dir = temp(), marker = join(dir, 'keep'); writeFileSync(marker, 'owned')
  for (const input of [{ kind: 'checkout', event: 'push' }, { kind: 'release', manifest: 'a'.repeat(64) }, { kind: 'other' }]) {
    await assert.rejects(assemble({ out: dir, ...input }))
    assert.equal(readFileSync(marker, 'utf8'), 'owned')
  }
})

test('build rejects contradictory inputs before Docker; default release forwards only release mode', () => {
  const dir = temp(), log = join(dir, 'calls')
  writeFileSync(join(dir, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nif [ "$1 $2" = "image inspect" ]; then echo 123; fi\n')
  chmodSync(join(dir, 'docker'), 0o755)
  const run = (args) => spawnSync(process.execPath, [join(ROOT, 'server/build.mjs'), ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: log }, encoding: 'utf8' })
  for (const args of [['--input-kind', 'unknown'], ['--input-kind', 'checkout', '--event', 'push'], ['--event', 'unknown'], ['--input-manifest', 'a'.repeat(64)], ['--publish', 'true'], ['--event', 'pull_request']]) {
    assert.notEqual(run(args).status, 0); assert.equal(existsSync(log), false)
  }
  assert.equal(run([]).status, 0)
  assert.match(readFileSync(log, 'utf8'), /--build-arg INPUT_KIND=release/)
  const source = readFileSync(join(ROOT, 'server/assemble.mjs'), 'utf8')
  assert.match(source, /kind === 'checkout'\s*\? readCheckoutPlugins[\s\S]*?: await fetchPlugins/)
})

// Copy only build helpers into an owned context: exercise the fixed production path without
// touching this checkout or invoking an actual Docker daemon.
test('checkout build carries all independently supplied bindings; release ignores present malformed local assets', async () => {
  const f = fixture(), root = temp(), server = join(root, 'server'), bin = join(root, 'bin'), log = join(root, 'docker.log')
  mkdirSync(server); mkdirSync(bin)
  for (const file of ['build.mjs', 'fetch-plugins.mjs', 'checkout-input.mjs']) cpSync(join(ROOT, 'server', file), join(server, file))
  cpSync(f.dir, join(server, 'checkout-input'), { recursive: true })
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$*" = "rev-parse HEAD" ] || exit 2\necho ${f.options.revision}\n`)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nif [ "$1 $2" = "image inspect" ]; then echo 123; fi\n')
  chmodSync(join(bin, 'git'), 0o755); chmodSync(join(bin, 'docker'), 0o755)
  const run = (args) => spawnSync(process.execPath, [join(server, 'build.mjs'), ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log }, encoding: 'utf8',
  })
  const args = ['--input-kind', 'checkout', '--event', 'pull_request', '--revision', f.options.revision,
    '--version', f.options.version, '--input-manifest', f.options.manifest]
  const result = run(args); assert.equal(result.status, 0, result.stderr)
  const command = readFileSync(log, 'utf8')
  for (const arg of [`INPUT_KIND=checkout`, `INPUT_EVENT=pull_request`, `INPUT_MANIFEST=${f.options.manifest}`,
    `IMAGE_REVISION=${f.options.revision}`, `IMAGE_VERSION=checkout-${f.options.revision}`, `AUTOMAGIK_REPOSITORY=${CHECKOUT_REPOSITORY}`]) assert.ok(command.includes(`--build-arg ${arg}`), arg)
  const reader = await import(pathToFileURL(join(server, 'checkout-input.mjs')))
  const out = join(root, 'vendor')
  const loaded = reader.readCheckoutPlugins({ ...f.options, out })
  assert.equal(Object.keys(loaded.plugins).length, 3)
  assert.equal(existsSync(join(out, checkoutFile('@automagik/locale-pt-br-dsh', f.options.version))), false)
  rmSync(log)
  assert.notEqual(run([...args, '--image-version', f.options.version]).status, 0)
  assert.notEqual(run([...args, '--revision', 'b'.repeat(40)]).status, 0)
  assert.notEqual(run([...args, '--input-manifest', 'b'.repeat(64)]).status, 0)
  assert.equal(existsSync(log), false)
  writeFileSync(join(server, 'checkout-input/plugins.json'), 'malformed local inputs')
  assert.equal(run(['--event', 'push']).status, 0)
  assert.match(readFileSync(log, 'utf8'), /INPUT_KIND=release/)
})
