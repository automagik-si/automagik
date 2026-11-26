import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { reconcileSandboxRow } from '../src/dsh.js'
import { hasSandboxAdapter } from '../src/profile-patch.mjs'

const yaml = createRequire(import.meta.url)('yaml')
const shipped = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
const bot = '@automagik/bots-dsh'
const adapter = `${bot}/sandbox-local`
const stock = '@deepseek-ai/dsh-sandbox-local'
const sandbox = '@deepseek-ai/dsh-sandbox'

function fixture(t, text = shipped) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-sandbox-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  const file = join(profile, 'cordis.patch.yml')
  const messages = []
  const packageAt = (dir, name, exports = { '.': './index.js' }) => {
    const folder = join(dir, 'node_modules', name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'index.js'), 'export default {}\n')
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, exports, type: 'module' }))
    return folder
  }
  const setExport = available => packageAt(profile, bot, available ? { './sandbox-local': './index.js' } : {})
  setExport(true)
  packageAt(runtime, stock)
  packageAt(runtime, sandbox)
  writeFileSync(file, text, { mode: 0o640 })
  return {
    profile, runtime, file, messages, setExport,
    read: () => readFileSync(file, 'utf8'),
    launch: () => reconcileSandboxRow({ profile, runtime, log: message => messages.push(message) }),
  }
}

function active(text) {
  const rows = yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }).toJS() ?? []
  const providers = new Map([['sandbox', true]])
  for (const row of rows) {
    for (const plugin of row.insert ?? []) {
      if (plugin.name === adapter) providers.set(plugin.id, plugin.disabled !== true)
    }
    if (providers.has(row.id) && typeof row.disabled === 'boolean') providers.set(row.id, !row.disabled)
  }
  return [...providers].filter(([, enabled]) => enabled).map(([id]) => id)
}

test('D1 fresh desktop patch gains one sandbox provider and keeps its prior bytes and mode', t => {
  const f = fixture(t)
  const mode = statSync(f.file).mode
  const changed = f.launch()
  assert.ok(changed.startsWith(shipped))
  assert.match(changed.slice(shipped.length), /^# Automagik \(#2024\):/)
  assert.equal(f.read(), changed)
  assert.deepEqual(active(changed), ['automagik-sandbox'])
  assert.equal(statSync(f.file).mode, mode)
})

test('D2 upgrade from v3.169.0 retains comments, model rows, and line endings', t => {
  const tag = spawnSync('git', ['show', 'v3.169.0:apps/desktop/profile/cordis.patch.yml'], { encoding: 'utf8' })
  const legacyDigest = 'c9df291e73d39d2e75b99c7f3a2941cbb2e5b94fecf19700246f88ee8275b52f'
  const old = tag.status === 0 ? tag.stdout : shipped
  // Desktop CI checks out one commit. The shipped file is usable there if it still has the tag's bytes.
  if (createHash('sha256').update(old).digest('hex') !== legacyDigest && tag.status !== 0) {
    return t.skip('the v3.169.0 profile is unavailable in this shallow checkout')
  }
  const original = (old + "# owner's model\n- id: provider\n  config: { model: 'my-model' } # keep\n").replaceAll('\n', '\r\n')
  const f = fixture(t, original)
  const changed = f.launch()
  assert.ok(changed.startsWith(original))
  assert.doesNotMatch(changed.slice(original.length), /(?<!\r)\n/)
  assert.deepEqual(active(changed), ['automagik-sandbox'])
})

test('D3 same-build rollback enables stock Bash and removes only the managed rows', t => {
  const f = fixture(t)
  f.launch()
  f.setExport(false)
  assert.equal(f.launch(), shipped)
  assert.equal(f.read(), shipped)
  assert.match(f.messages.at(-2), /stock sandbox/)
  assert.deepEqual(active(f.read()), ['sandbox'])
})

test('D4 an export returning after rollback restores the swap', t => {
  const f = fixture(t)
  const first = f.launch()
  f.setExport(false)
  f.launch()
  f.setExport(true)
  assert.equal(f.launch(), first)
  assert.deepEqual(active(f.read()), ['automagik-sandbox'])
})

test('D5 an unchanged launch keeps the patch inode and modification time', t => {
  const f = fixture(t)
  f.launch()
  const before = statSync(f.file, { bigint: true })
  assert.equal(f.launch(), null)
  const after = statSync(f.file, { bigint: true })
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.deepEqual(active(f.read()), ['automagik-sandbox'])
})

test('D6 an owner sandbox configuration wins before and after a managed swap', t => {
  const owner = '- id: sandbox # keep this spelling\n  config: { runnerCommand: [my-runner] }\n'
  const f = fixture(t, shipped + owner)
  assert.equal(f.launch(), null)
  assert.equal(f.read(), shipped + owner)
  assert.match(f.messages.at(-1), /the profile configures DSH's sandbox row/)
  writeFileSync(f.file, shipped)
  const swapped = f.launch()
  writeFileSync(f.file, swapped + owner)
  assert.equal(f.launch(), shipped + owner)
  assert.deepEqual(active(f.read()), ['sandbox'])
})

test('D7 an explicit pre-swap stock disablement is the owner’s decision', t => {
  const original = shipped + `- id: sandbox\n  name: '${stock}'\n  disabled: true\n`
  const f = fixture(t, original)
  assert.equal(f.launch(), null)
  assert.equal(f.read(), original)
  assert.deepEqual(active(f.read()), [])
})

test('D8 an owner can disable the adapter on its insert or in a separate override', t => {
  for (const onInsert of [true, false]) {
    const f = fixture(t)
    const swapped = f.launch()
    const changed = onInsert
      ? swapped.replace(new RegExp(`(name: .*?${adapter}.*?\\n)`), '$1      disabled: true\n')
      : swapped + '- id: automagik-sandbox\n  disabled: true # owner choice\n'
    assert.notEqual(changed, swapped)
    writeFileSync(f.file, changed)
    assert.ok(f.launch())
    const kept = f.read()
    assert.match(kept, /id: automagik-sandbox[\s\S]*disabled: true/)
    assert.deepEqual(active(kept), ['sandbox'])
    assert.equal(f.launch(), null)
    f.setExport(false)
    assert.equal(f.launch(), null)
    assert.equal(f.read(), kept)
  }
})

test('D9/P2 peer absent or missing its entry keeps stock available, including after a swap', t => {
  const f = fixture(t)
  const peer = join(f.runtime, 'node_modules', stock)
  rmSync(join(peer, 'index.js'))
  assert.equal(hasSandboxAdapter(f.profile, f.runtime), false)
  assert.equal(f.launch(), null)
  assert.deepEqual(active(f.read()), ['sandbox'])
  writeFileSync(join(peer, 'index.js'), 'export default {}\n')
  assert.ok(f.launch())
  rmSync(peer, { recursive: true })
  assert.equal(f.launch(), shipped)
  assert.deepEqual(active(f.read()), ['sandbox'])
})

test('D10 opaque and invalid YAML keep their original bytes', t => {
  for (const original of ['an opaque patch\n', '- broken: [ { ]\n']) {
    const f = fixture(t, original)
    assert.equal(f.launch(), null)
    assert.equal(f.read(), original)
    assert.deepEqual(active(shipped), ['sandbox'])
  }
})

test('D11 the common DSH spawn reconciles before serving', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(main, /function spawnDsh\(port, steps\) \{[^]*?reconcileSandboxRow\(\{[^]*?return serveDsh\(\{/)
})

test('rolling back a flow patch or a shared insert keeps the owner rows', t => {
  const flow = "[{ id: owner, config: { note: 'keep' } }]\n"
  const f = fixture(t, flow)
  assert.ok(f.launch())
  assert.deepEqual(active(f.read()), ['automagik-sandbox'])
  f.setExport(false)
  assert.equal(f.launch(), flow)
  const shared = `- insert:\n    - id: automagik-sandbox\n      name: '${adapter}'\n    # shared insertion\n    - id: owner\n      name: owner-plugin\n- id: sandbox\n  name: '${stock}'\n  disabled: true\n`
  const g = fixture(t, shared)
  g.setExport(false)
  assert.equal(g.launch(), '- insert:\n    # shared insertion\n    - id: owner\n      name: owner-plugin\n')
  assert.deepEqual(active(g.read()), ['sandbox'])
})

test('P1 loads and registers the packaged provider with the pinned DSH runtime', async t => {
  const build = fileURLToPath(new URL('../build/', import.meta.url))
  const runtime = join(build, 'runtime')
  // prepare-runtime moves the finished profile out of its temporary dsh-home.
  const profile = join(build, 'profile')
  if (!existsSync(join(build, 'versions.json'))) return t.skip('prepare-runtime output is unavailable')
  assert.equal(hasSandboxAdapter(profile, runtime), true)

  const scratch = mkdtempSync(join(tmpdir(), 'desktop-packed-sandbox-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const installAnchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const requireRuntime = createRequire(installAnchor)
  const load = specifier => import(pathToFileURL(requireRuntime.resolve(specifier)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await load('@deepseek-ai/dsh-app-boot')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const resolution = await createRuntimeResolution({
    installAnchor, home: scratch, profile: loadProfileDirectory('dsh', profile, installAnchor),
  })
  await ctx.plugin(PluginPackages, { resolution })
  const providerURL = pathToFileURL(createRequire(join(profile, 'package.json')).resolve(adapter)).href
  const { default: Provider } = await import(providerURL)
  await ctx.plugin(Provider, {})
  const source = '/etc/ssh/ssh_config.d'
  if (process.platform !== 'linux' || process.getuid() === 0 || !existsSync(source) || lstatSync(source).uid !== 0) {
    return t.skip('a trusted non-caller-owned system SSH drop-in directory is unavailable')
  }
  if (!readdirSync(source).some(name => name.endsWith('.conf') && statSync(join(source, name)).uid === 0)) {
    return t.skip('a root-owned system SSH drop-in is unavailable')
  }
  const runtimeDirectory = join(scratch, 'runtime')
  mkdirSync(runtimeDirectory, { mode: 0o700 })
  Object.assign(ctx.sandbox.internals, { chain: ['bwrap'], sshConfig: { runtimeDirectory } })
  const { argv } = await ctx.sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: scratch })
  const [bind, generation, target, separator, program] = argv.slice(-5)
  assert.deepEqual([bind, target, separator, program], ['--ro-bind', source, '--', 'true'])
  assert.match(generation, /automagik-ssh-config-d[/\\]p-[^/\\]+[/\\]g-/)
})
