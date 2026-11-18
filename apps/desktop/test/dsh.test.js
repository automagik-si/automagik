import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { test } from 'node:test'
import {
  appHome, backupSettings, backupSettingsOrLog, dshEnv, dshRun, forgetDshLogins, freePort,
  guardContents, installProfile, keepPort, LAUNCH_URL_FILE, launchPort, launchUrlFileOf,
  launchUrlFromFile, launchUrlOf, listenFailed, mergeProfilePackage, mergeProfilePatch,
  migrateRenamed, migrateRetired, navigationOf, pageUrlOf, pinProfileStore, PORT_WAIT_MS,
  PORT_WAIT_STEP_MS, portFileOf, portFree, preloadAsked, preloadOf, RENAMED, renamePatch, resourcesOf, RETIRED, retirePatch, scrubBuildPaths,
  serveDsh, servesOrigin, SHIPPED_STORE, startDsh, startDshOnPort, stopDsh, storedPort,
  storeLayoutOf, toolFileOf, writeTools,
} from '../src/dsh.js'
import { batchSafe } from '../scripts/batch-spawn.mjs'

const posixOnly = { skip: process.platform === 'win32' ? 'the tools are sh scripts here' : false }
const windowsOnly = { skip: process.platform === 'win32' ? false : 'Windows only' }
// A folder mode that forbids removing a file in it: POSIX only, and never for root.
const permissionOnly = { skip: process.platform === 'win32' ? 'Windows has no folder write mode' : process.getuid?.() === 0 ? 'root removes a file from any folder' : false }

// Windows cannot remove a folder a process still runs in, and t.after runs its hooks in the order
// they were added: the folder goes in one hook, after `stop` (set once the test starts its dsh),
// retrying while a stopped process is still on its way out.
function scratch(t, prefix) {
  const scope = { root: mkdtempSync(join(tmpdir(), prefix)), stop: async () => {} }
  t.after(async () => {
    await scope.stop()
    rmSync(scope.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return scope
}

test('the app keeps everything in one folder under ~/.automagik, apart from a dsh you already run', () => {
  assert.equal(appHome({}), join(homedir(), '.automagik', 'desktop'))
  // Paths in the platform's own form: on Windows /srv/automagik is D:\srv\automagik.
  assert.equal(appHome({ AUTOMAGIK_HOME: '/srv/automagik' }), join(resolve('/srv/automagik'), 'desktop'))
  assert.equal(appHome({ AUTOMAGIK_HOME: '~/apps/automagik' }), join(homedir(), 'apps', 'automagik', 'desktop'))
  assert.equal(appHome({ AUTOMAGIK_HOME: ' ', OMNI_HOME: '/srv/omni', OMNI_DESKTOP_HOME: '/srv/old' }), join(homedir(), '.automagik', 'desktop'))
  const env = dshEnv({ base: { PATH: '/bin', DSH_HOME: '/home/me/.dsh' }, home: '/a/desktop', electronAsNode: true })
  assert.equal(env.DSH_HOME, join('/a/desktop', 'dsh'))
  assert.equal(env.AUTOMAGIK_BOTS_HOME, join('/a/desktop', 'bots'))
  // Omni's own folder is Omni's: the app names none, so its sandbox and downloads land in ~/.omni.
  assert.equal(env.OMNI_HOME, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.DO_NOT_TRACK, '1')
  assert.equal(env.OMNI_CLIENT_ID, 'omni-desktop')
  // Nothing is reported: DSH's own opt-out (it does not read DO_NOT_TRACK), and the CLIs it runs.
  for (const name of ['DO_NOT_TRACK', 'DSH_TELEMETRY_DISABLED', 'DISABLE_TELEMETRY', 'OPENUI_TELEMETRY_DISABLED']) assert.equal(env[name], '1', name)
  assert.equal(env.AUTOMAGIK_PRIVACY_FILE, join('/a/desktop', 'privacy.json'))
  // A share the person switched on drops its own opt-out, and only its own.
  const sharing = dshEnv({ base: {}, home: '/a', privacy: { 'deepseek-feedback': true } })
  assert.equal(sharing.DSH_TELEMETRY_DISABLED, undefined)
  assert.equal(sharing.DISABLE_ERROR_REPORTING, '1')
  // Chosen nothing: Claude Code's own error reports work (not training data).
  assert.equal(env.DISABLE_ERROR_REPORTING, undefined)
  // The welcome counts the agents at work there, for an update while the person is away.
  assert.equal(env.AUTOMAGIK_BUSY_FILE, join('/a/desktop', 'busy.json'))
  // The person's PATH comes first; the usual tool folders follow (see toolDirs below).
  assert.ok(env.PATH.startsWith(`/bin${delimiter}`))
  assert.equal(dshEnv({ base: {}, home: '/a' }).ELECTRON_RUN_AS_NODE, undefined)
})

test('settings come back from a copy, once per dsh version, before an upgrade can move them', (t) => {
  const scope = scratch(t, 'omni-desktop-settings-')
  const dshHome = join(scope.root, 'dsh')
  mkdirSync(dshHome, { recursive: true })
  assert.equal(backupSettings({ dshHome, version: '0.2.2-rc.1' }), undefined, 'a fresh home has no settings to keep')
  const settings = join(dshHome, 'settings.yaml')
  writeFileSync(settings, 'ui-theme:\n  mode: dark\n')
  const copy = backupSettings({ dshHome, version: '0.2.2-rc.1' })
  assert.equal(copy, join(dshHome, 'profile-backups', 'settings-0.2.2-rc.1.yaml'))
  assert.equal(readFileSync(copy, 'utf8'), 'ui-theme:\n  mode: dark\n', 'a copy, byte for byte')
  assert.equal(readFileSync(settings, 'utf8'), 'ui-theme:\n  mode: dark\n', 'and a copy, not a move')
  // A second launch under the same runtime does not duplicate it, even after dsh renamed its own file.
  assert.equal(backupSettings({ dshHome, version: '0.2.2-rc.1' }), undefined)
  renameSync(settings, `${settings}.imported`)
  assert.equal(backupSettings({ dshHome, version: '0.2.2-rc.1' }), undefined)
  assert.equal(readdirSync(join(dshHome, 'profile-backups')).length, 1)
  assert.equal(existsSync(`${settings}.imported`), true, "dsh's own copy survives beside ours")
  // The next runtime gets its own copy.
  writeFileSync(settings, 'ui-theme:\n  mode: light\n')
  assert.equal(backupSettings({ dshHome, version: '0.2.3-rc.1' }), join(dshHome, 'profile-backups', 'settings-0.2.3-rc.1.yaml'))
  assert.equal(readdirSync(join(dshHome, 'profile-backups')).length, 2)
})

test('a settings copy that cannot be written is reported and leaves the home as it was', (t) => {
  const scope = scratch(t, 'omni-desktop-settings-fail-')
  const dshHome = join(scope.root, 'dsh')
  mkdirSync(dshHome, { recursive: true })
  const settings = join(dshHome, 'settings.yaml')
  writeFileSync(settings, 'ui-theme:\n  mode: dark\n')
  // Something that is not a folder takes profile-backups' place: the copy cannot be made.
  writeFileSync(join(dshHome, 'profile-backups'), 'not a folder')
  const log = []
  assert.equal(backupSettingsOrLog({ dshHome, version: '0.2.2-rc.1', log: line => log.push(line) }), undefined)
  assert.equal(log.length, 1)
  assert.match(log[0], /^settings backup failed \(/)
  assert.equal(readFileSync(settings, 'utf8'), 'ui-theme:\n  mode: dark\n', 'the file is not moved or changed')
})

test('resources come from the app when packaged and from build/ in a checkout', () => {
  assert.deepEqual(resourcesOf({ packaged: true, resourcesPath: '/opt/Omni/resources', appPath: '/x' }), {
    bin: join('/opt/Omni/resources', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    pnpm: join('/opt/Omni/resources', 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    profile: join('/opt/Omni/resources', 'profile'),
  })
  assert.equal(resourcesOf({ packaged: false, resourcesPath: '/x', appPath: '/src/apps/omni-desktop' }).profile, join('/src/apps/omni-desktop', 'build', 'profile'))
})

test('the shipped profile seeds a new home, and a new build replaces only its packages', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'shipped')
  mkdirSync(join(source, 'node_modules', '@automagik', 'omni-dsh'), { recursive: true })
  writeFileSync(join(source, 'package.json'), '{"dependencies":{"@automagik/omni-dsh":"0.1.7"}}')
  writeFileSync(join(source, 'cordis.patch.yml'), '[]')
  writeFileSync(join(source, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'v1')
  const dshHome = join(root, 'dsh')

  const first = await installProfile({ dshHome, source })
  assert.equal(first.installed, true)
  assert.equal(first.target, join(dshHome, 'profiles', 'omni'))
  assert.equal(readFileSync(join(first.target, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'utf8'), 'v1')

  // dsh writes its own files into the profile; the same build leaves them be.
  writeFileSync(join(first.target, 'cordis.yml'), '[]')
  writeFileSync(join(first.target, 'cordis.patch.yml'), '- id: llm-pi-ai  # the user\'s models')
  mkdirSync(join(first.target, '.plugin-manager'))
  writeFileSync(join(first.target, '.plugin-manager', 'state.json'), '{}')
  assert.equal((await installProfile({ dshHome, source })).installed, false)
  assert.equal(existsSync(join(first.target, 'cordis.yml')), true)

  writeFileSync(join(source, 'package.json'), '{"dependencies":{"@automagik/omni-dsh":"0.1.8"}}')
  writeFileSync(join(source, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'v2')
  // pnpm resolves the plugin manager's installs from the lock: the new build's comes with its packages.
  writeFileSync(join(source, 'pnpm-lock.yaml'), 'omni-dsh 0.1.8')
  writeFileSync(join(first.target, 'pnpm-lock.yaml'), 'omni-dsh 0.1.7')
  assert.equal((await installProfile({ dshHome, source })).installed, true)
  assert.equal(readFileSync(join(first.target, 'pnpm-lock.yaml'), 'utf8'), 'omni-dsh 0.1.8')
  assert.equal(readFileSync(join(first.target, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'utf8'), 'v2')
  assert.deepEqual(JSON.parse(readFileSync(join(first.target, 'package.json'), 'utf8')), { dependencies: { '@automagik/omni-dsh': '0.1.8' } })
  // What dsh and the user put there survives the update.
  assert.equal(readFileSync(join(first.target, 'cordis.yml'), 'utf8'), '[]')

  // A build id, when the build stamped one, decides even with the same package.json.
  writeFileSync(join(source, '.build-id'), '0.1.8+one')
  assert.equal((await installProfile({ dshHome, source })).installed, true)
  assert.equal((await installProfile({ dshHome, source })).installed, false)
  writeFileSync(join(source, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'v3')
  writeFileSync(join(source, '.build-id'), '0.1.8+two')
  assert.equal((await installProfile({ dshHome, source })).installed, true)
  assert.equal(readFileSync(join(first.target, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'utf8'), 'v3')
  assert.equal(readFileSync(join(first.target, 'cordis.patch.yml'), 'utf8'), '- id: llm-pi-ai  # the user\'s models')
  assert.equal(readFileSync(join(first.target, '.plugin-manager', 'state.json'), 'utf8'), '{}')
})

test('a first copy cut short leaves no profile behind, and the next start copies it whole', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'shipped')
  mkdirSync(join(source, 'node_modules', 'a'), { recursive: true })
  writeFileSync(join(source, 'package.json'), '{"dependencies":{"a":"1.0.0"}}')
  writeFileSync(join(source, 'cordis.patch.yml'), '- id: seed\n  config: {}\n')
  writeFileSync(join(source, 'node_modules', 'a', 'index.js'), 'a')
  const dshHome = join(root, 'dsh')
  const target = join(dshHome, 'profiles', 'omni')
  // A quit while the copy ran left half of it: a short root file, no packages.
  mkdirSync(`${target}.installing`, { recursive: true })
  writeFileSync(join(`${target}.installing`, 'cordis.patch.yml'), '- id: se')
  // A copy that fails on the way (an unreadable file stands in for the quit) puts nothing in place.
  // Windows has no unreadable mode (chmod sets read-only there), nor does root.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(join(source, 'node_modules', 'a', 'index.js'), 0o000)
    await assert.rejects(installProfile({ dshHome, source }))
    assert.equal(existsSync(target), false, 'no profile until the copy is whole')
    chmodSync(join(source, 'node_modules', 'a', 'index.js'), 0o644)
  }
  const { installed } = await installProfile({ dshHome, source })
  assert.equal(installed, true)
  assert.equal(readFileSync(join(target, 'cordis.patch.yml'), 'utf8'), '- id: seed\n  config: {}\n')
  assert.equal(readFileSync(join(target, 'node_modules', 'a', 'index.js'), 'utf8'), 'a')
  assert.equal(existsSync(`${target}.installing`), false)
  assert.equal((await installProfile({ dshHome, source })).installed, false)
})

// pnpm refuses to change node_modules linked from another store (ERR_PNPM_UNEXPECTED_STORE),
// so a profile built on CI, or one a person's own pnpm config re-linked, could not take a
// plugin from the market.
const modulesYaml = storeDir => `${JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted', storeDir, virtualStoreDir: '.pnpm' }, null, 2)}\n`
const WORKSPACE = '# What dsh writes\npackages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

test('a shipped profile carries no build machine paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-scrub-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', '.modules.yaml'), modulesYaml('/Users/runner/Library/pnpm/store/v10'))
  writeFileSync(join(root, 'node_modules', '.pnpm-workspace-state-v1.json'), '{"projects":{"/Users/runner/work/omni-desktop/build/dsh-home/profiles/omni":{}}}')
  scrubBuildPaths(root)
  const modules = readFileSync(join(root, 'node_modules', '.modules.yaml'), 'utf8')
  assert.equal(JSON.parse(modules).storeDir, SHIPPED_STORE)
  assert.equal(JSON.parse(modules).nodeLinker, 'hoisted')
  assert.doesNotMatch(modules, /runner/)
  assert.equal(existsSync(join(root, 'node_modules', '.pnpm-workspace-state-v1.json')), false)
})

test('the profile names the app\'s own pnpm store, and a profile linked from another store is repaired', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'desktop')
  const target = join(home, 'dsh', 'profiles', 'omni')
  mkdirSync(join(target, 'node_modules'), { recursive: true })
  writeFileSync(join(target, 'pnpm-workspace.yaml'), WORKSPACE)
  // What a person's own pnpm config left behind on the owner's Mac.
  writeFileSync(join(target, 'node_modules', '.modules.yaml'), modulesYaml('/tmp/khal-pnpm-store-repro/v10'))

  const store = pinProfileStore({ target, home, layout: 'v10' })
  assert.equal(store, join(home, 'pnpm-store'))
  const workspace = readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8')
  assert.ok(workspace.startsWith(WORKSPACE.trimEnd()), 'the shipped settings stay')
  assert.match(workspace, new RegExp(`^storeDir: ${JSON.stringify(store).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'))
  assert.equal(JSON.parse(readFileSync(join(target, 'node_modules', '.modules.yaml'), 'utf8')).storeDir, join(home, 'pnpm-store', 'v10'))

  // Again at the next launch: nothing changes, and there is still one storeDir line.
  const before = [readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8'), readFileSync(join(target, 'node_modules', '.modules.yaml'), 'utf8')]
  pinProfileStore({ target, home, layout: 'v10' })
  assert.deepEqual([readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8'), readFileSync(join(target, 'node_modules', '.modules.yaml'), 'utf8')], before)
  assert.equal(workspace.match(/^storeDir:/gm).length, 1)

  // A moved home (AUTOMAGIK_HOME) moves the store with it.
  const moved = join(root, 'elsewhere')
  pinProfileStore({ target, home: moved, layout: 'v10' })
  assert.equal(readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8').match(/^storeDir:.*$/gm).join(), `storeDir: ${JSON.stringify(join(moved, 'pnpm-store'))}`)
})

test('a profile without node_modules yet still gets the store, and the layout follows the app\'s pnpm', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-layout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = join(root, 'profile')
  mkdirSync(target)
  pinProfileStore({ target, home: root })
  assert.equal(readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8'), `storeDir: ${JSON.stringify(join(root, 'pnpm-store'))}\n`)
  const pnpm = join(root, 'runtime', 'node_modules', 'pnpm')
  mkdirSync(join(pnpm, 'bin'), { recursive: true })
  writeFileSync(join(pnpm, 'package.json'), '{"version":"10.34.6"}')
  assert.equal(storeLayoutOf(join(pnpm, 'bin', 'pnpm.cjs')), 'v10')
  writeFileSync(join(pnpm, 'package.json'), '{"version":"11.0.1"}')
  assert.equal(storeLayoutOf(join(pnpm, 'bin', 'pnpm.cjs')), 'v11')
})

// The app opens on the Omni octopus (@automagik/welcome-dsh), not on DSH's own welcome
// notice and credential step.
test('the shipped profile bundles the Bot team first, Omni\'s plugins, the welcome, ACP agents and the plugin market, and switches DSH\'s own onboarding off', () => {
  const profile = JSON.parse(readFileSync(new URL('../profile/package.json', import.meta.url), 'utf8'))
  // ACP agents (RFC 0003) are on by default here: Claude Code and Codex as models when their CLIs are installed.
  const omni = ['@automagik/bots-dsh', '@automagik/omni-channels-dsh', '@automagik/omni-canvas-dsh', '@automagik/welcome-dsh', '@automagik/acp-dsh']
  // Omni's plugins first, then the add-ons that connect AI subscriptions, each a reviewed fork at
  // a pinned commit (the build checks it holds the version addonVersions names), bundled after.
  const addons = Object.keys(profile.omni.addonVersions)
  assert.deepEqual(Object.keys(profile.dependencies), [...omni, ...addons])
  for (const name of addons) assert.match(profile.dependencies[name], /^github:automagik-genie\/[\w.-]+#[0-9a-f]{40}$/)
  assert.deepEqual(profile.dsh.profile.bundles.filter(name => name.startsWith('@automagik/')), omni)
  assert.deepEqual(profile.dsh.profile.bundles.slice(-addons.length), addons)
  assert.ok(profile.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-plugin-market-bundle'))
  const patch = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
  // DSH compares the notice version exactly, as a string.
  assert.match(patch, /^- id: ui-settings-general\n {2}config:\n {4}welcomeNoticeVersion: '2026-09-28\.1'$/m)
  assert.match(patch, /^- id: ui-settings-models\n {2}config:\n {4}credentialOnboarding: false$/m)
  // Automagik's market, where Genie is; pairing adds the Omni's market beside it
  // (apps/omni-channels-dsh omni-link.js).
  assert.match(patch, /^- id: plugin-market\n {2}config:\n {4}indexes:\n {6}- https:\/\/raw\.githubusercontent\.com\/automagik-si\/dsh-marketplace\/main\/index\.json$/m)
  // Omni's dsh-subscriptions has no local-Ollama fallback to switch off.
  assert.doesNotMatch(patch, /ollamaFallback/)
})

test('the launch URL is read from dsh\'s output, only for the port it was given', () => {
  const line = 'starting…\ndsh web: http://127.0.0.1:41149/?token=abc123\n'
  assert.equal(launchUrlOf(line, 41149), 'http://127.0.0.1:41149/?token=abc123')
  assert.equal(launchUrlOf(line, 5000), null)
  assert.equal(launchUrlOf('dsh web: http://0.0.0.0:41149/?token=x', 41149), null)
  assert.equal(launchUrlOf('no url here'), null)
})

test('the launch URL file is read only for the port it names', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-launch-file-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = launchUrlFileOf(join(root, 'dsh'))
  assert.equal(LAUNCH_URL_FILE, 'launch-url')
  assert.equal(file, join(root, 'dsh', 'launch-url'))
  assert.equal(launchUrlFromFile(file, 41149), null, 'a missing file has no URL')
  mkdirSync(join(root, 'dsh'), { recursive: true })
  writeFileSync(file, 'http://127.0.0.1:41149/?token=abc123\n')
  assert.equal(launchUrlFromFile(file, 41149), 'http://127.0.0.1:41149/?token=abc123')
  assert.equal(launchUrlFromFile(file, 5000), null, 'another port is another dsh')
  writeFileSync(file, 'http://0.0.0.0:41149/?token=abc123\n')
  assert.equal(launchUrlFromFile(file, 41149), null, 'only the loopback address counts')
  writeFileSync(file, 'not a launch URL\n')
  assert.equal(launchUrlFromFile(file, 41149), null, 'garbage is ignored')
})

test('a start falls back to the launch URL file when dsh\'s output is lost', async (t) => {
  const scope = scratch(t, 'omni-desktop-launch-file-start-')
  const { root } = scope
  const urlFile = launchUrlFileOf(join(root, 'dsh'))
  mkdirSync(join(root, 'dsh'), { recursive: true })
  writeFileSync(urlFile, 'http://127.0.0.1:1/?token=stale\n')
  const bin = join(root, 'file-dsh.mjs')
  writeFileSync(bin, `
import { existsSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const port = args[args.indexOf('--port') + 1]
const file = process.env.LAUNCH_FILE
process.stdout.write('dsh is starting without its launch line\\n')
if (existsSync(file)) {
  process.stderr.write('the previous start\\'s launch file is still there\\n')
  process.exit(4)
}
setTimeout(() => writeFileSync(file, 'http://127.0.0.1:' + port + '/?token=file-token\\n'), 100)
setInterval(() => {}, 1000)
`)
  const port = await freePort()
  const { child, url } = await startDsh({
    node: process.execPath,
    bin,
    env: { ...process.env, LAUNCH_FILE: urlFile },
    port,
    cwd: root,
    urlFile,
  })
  scope.stop = () => stopDsh(child)
  assert.equal(url, `http://127.0.0.1:${port}/?token=file-token`)
  await stopDsh(child)
})

// A previous launch-url file the start cannot remove (here a read-only DSH_HOME) is logged with
// its path and the error, and the start goes on to spawn dsh (#739).
test('a start whose previous launch URL cannot be removed logs it and still starts dsh', permissionOnly, async (t) => {
  const scope = scratch(t, 'omni-desktop-launch-url-kept-')
  const { root } = scope
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, `
const args = process.argv.slice(2)
const port = args[args.indexOf('--port') + 1]
setTimeout(() => console.log('dsh web: http://127.0.0.1:' + port + '/?token=kept'), 50)
setInterval(() => {}, 1000)
`)
  const home = join(root, 'dsh')
  mkdirSync(home)
  const urlFile = launchUrlFileOf(home)
  writeFileSync(urlFile, 'http://127.0.0.1:1/?token=stale\n')
  chmodSync(home, 0o500)
  // The log is optional (log?.write): a caller that passes none drops the line silently.
  const written = []
  const log = { write: chunk => written.push(String(chunk)) }
  try {
    const port = await freePort()
    const { child, url } = await startDsh({ node: process.execPath, bin, env: process.env, port, cwd: root, urlFile, log })
    scope.stop = () => stopDsh(child)
    assert.equal(url, `http://127.0.0.1:${port}/?token=kept`, 'the start still resolves')
    const reported = written.filter(line => line.startsWith('automagik:'))
    assert.equal(reported.length, 1)
    assert.ok(reported[0].includes(urlFile), reported[0])
    assert.match(reported[0], /could not remove the previous launch URL/)
    assert.match(reported[0], /EACCES/, reported[0])
  } finally {
    chmodSync(home, 0o700)
  }
})

// The old file can name this very port with a dead token, and dsh's own recordLaunchUrl fails the
// same way, so it is never replaced: the start must take its URL from dsh's output alone (#739).
test('a start whose previous launch URL for the same port cannot be removed waits for dsh\'s own line', permissionOnly, async (t) => {
  const scope = scratch(t, 'omni-desktop-launch-url-same-port-')
  const { root } = scope
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, `
const args = process.argv.slice(2)
const port = args[args.indexOf('--port') + 1]
setTimeout(() => console.log('dsh web: http://127.0.0.1:' + port + '/?token=fresh'), 800)
setInterval(() => {}, 1000)
`)
  const port = await freePort()
  const home = join(root, 'dsh')
  mkdirSync(home)
  const urlFile = launchUrlFileOf(home)
  const stale = `http://127.0.0.1:${port}/?token=stale`
  writeFileSync(urlFile, `${stale}\n`)
  chmodSync(home, 0o500)
  const written = []
  const log = { write: chunk => written.push(String(chunk)) }
  try {
    const started = Date.now()
    const { child, url } = await startDsh({ node: process.execPath, bin, env: process.env, port, cwd: root, urlFile, log })
    scope.stop = () => stopDsh(child)
    const elapsed = Date.now() - started
    assert.equal(url, `http://127.0.0.1:${port}/?token=fresh`, 'the start resolves with the token dsh printed')
    assert.notEqual(url, stale, 'never the dead token the old file names for this port')
    // The file still names only the stale token: this URL could come from nowhere but stdout.
    assert.equal(readFileSync(urlFile, 'utf8').trim(), stale)
    assert.ok(elapsed >= 400, `resolved late, after dsh printed its line (${elapsed} ms)`)
    const reported = written.filter(line => line.startsWith('automagik:'))
    assert.equal(reported.length, 1)
    assert.ok(reported[0].includes(urlFile), reported[0])
    assert.match(reported[0], /could not remove the previous launch URL/)
    assert.match(reported[0], /EACCES/, reported[0])
  } finally {
    chmodSync(home, 0o700)
  }
})

test('a start forgets the dsh logins earlier starts left, and nothing else of the host', async () => {
  // 70 of these came to 15.7 KB and dsh answered the page with 431; cookies ignore the port.
  const kept = [
    ...Array.from({ length: 70 }, (_, n) => ({ name: `dsh-auth-${'x'.repeat(43)}${n}`, domain: '127.0.0.1', path: '/' })),
    { name: 'theme', domain: '127.0.0.1', path: '/' },
  ]
  const asked = []
  const removed = []
  const cookies = {
    get: async (filter) => { asked.push(filter); return kept.filter(cookie => cookie.domain === filter.domain) },
    remove: async (url, name) => { removed.push([url, name]) },
  }
  assert.equal(await forgetDshLogins(cookies, 'http://127.0.0.1:57765'), 70)
  assert.deepEqual(asked, [{ domain: '127.0.0.1' }])
  assert.equal(removed.length, 70)
  assert.ok(removed.every(([url, name]) => url === 'http://127.0.0.1/' && name.startsWith('dsh-auth-')))
  assert.equal(await forgetDshLogins({ get: async () => [], remove: async () => assert.fail('nothing to remove') }, 'http://127.0.0.1:1'), 0)
})

test('the window stays on dsh\'s origin; web links go to the system browser; the rest is refused', () => {
  const origin = 'http://127.0.0.1:41149'
  assert.equal(navigationOf('http://127.0.0.1:41149/session/1', origin), 'allow')
  assert.equal(navigationOf('http://127.0.0.1:9999/', origin), 'external')
  assert.equal(navigationOf('https://wa.me/5511999990000?text=Omni%207KQ4-9XZP', origin), 'external')
  assert.equal(navigationOf('mailto:dev@namastex.ai', origin), 'external')
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'whatsapp://send?text=x', 'not a url']) assert.equal(navigationOf(url, origin), 'deny', url)
})

test('the app\'s pages send web links to the system browser; a Bot view keeps its own pages and tabs', () => {
  const origin = 'http://127.0.0.1:41149'
  const opened = []
  const contentsOf = (session) => {
    const contents = new EventEmitter()
    contents.session = session
    contents.setWindowOpenHandler = (handler) => { contents.openHandler = handler }
    return contents
  }
  const botSession = {}
  const guard = contents => guardContents(contents, { origin, openExternal: url => opened.push(url), isBotView: view => view.session === botSession })
  const navigate = (contents, url) => {
    let refused = false
    contents.emit('will-navigate', { preventDefault: () => { refused = true } }, url)
    return refused
  }

  const page = contentsOf({})
  assert.equal(guard(page), true)
  assert.deepEqual(page.openHandler({ url: 'https://example.com/' }), { action: 'deny' })
  assert.equal(navigate(page, 'https://example.com/next'), true)
  assert.equal(navigate(page, `${origin}/session/1`), false)
  assert.deepEqual(opened, ['https://example.com/', 'https://example.com/next'])

  // A Bot view gets none of it: its links and redirects stay in the view, nothing opens outside.
  const bot = contentsOf(botSession)
  assert.equal(guard(bot), false)
  assert.equal(bot.openHandler, undefined)
  assert.equal(bot.listenerCount('will-navigate') + bot.listenerCount('will-redirect'), 0)
  assert.equal(opened.length, 2)
})

test('dsh starts on the given loopback port, its URL resolves, and stopping ends it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-start-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A stand-in dsh: prints its launch line for the port and the profile it was given, then waits.
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, `
const args = process.argv.slice(2)
const port = args[args.indexOf('--port') + 1]
const profile = args[args.indexOf('--profile') + 1]
const host = args[args.indexOf('--host') + 1]
const patch = args.includes('--patch') ? args[args.indexOf('--patch') + 1] : 'none'
console.log('booting ' + profile + ' on ' + host + ' with ' + patch)
setTimeout(() => console.log('dsh web: http://127.0.0.1:' + port + '/?token=t0k3n'), 50)
setInterval(() => {}, 1000)
`)
  const port = await freePort()
  const lines = []
  const { child, url } = await startDsh({ node: process.execPath, bin, env: process.env, port, cwd: root, privacy: '/app/profile/privacy.patch.yml', log: { write: chunk => lines.push(String(chunk)) } })
  assert.equal(url, `http://127.0.0.1:${port}/?token=t0k3n`)
  // The privacy overlay goes on every launch, after the person's own profile patch.
  assert.match(lines.join(''), /booting omni on 127\.0\.0\.1 with \/app\/profile\/privacy\.patch\.yml/)
  await stopDsh(child)
  assert.notEqual(child.exitCode ?? child.signalCode, null)
})

// Windows: dsh's whole tree ends, so nothing it started keeps files of the app's folder open
// under an update's installer.
test('on Windows stopping dsh ends its whole process tree with taskkill', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kills: [] })
  child.kill = signal => child.kills.push(signal ?? 'default')
  const calls = []
  const run = (file, args, options, done) => { calls.push([file, ...args]); setImmediate(() => { done(null); child.emit('exit', 1, null) }) }
  await stopDsh(child, 8_000, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run })
  assert.deepEqual(calls, [['C:\\Windows\\System32\\taskkill.exe', '/pid', '4242', '/T', '/F']])
  assert.deepEqual(child.kills, [])
  // taskkill failing: dsh alone, as before.
  const lone = Object.assign(new EventEmitter(), { pid: 7, exitCode: null, signalCode: null })
  lone.kill = () => setImmediate(() => lone.emit('exit', 1, null))
  await stopDsh(lone, 8_000, { platform: 'win32', env: {}, run: (file, args, options, done) => done(new Error('denied')) })
  // A dsh that has started nothing yet ends at once, without taskkill.
  const fresh = Object.assign(new EventEmitter(), { pid: 8, exitCode: null, signalCode: null })
  fresh.kill = () => setImmediate(() => fresh.emit('exit', 1, null))
  await stopDsh(fresh, 8_000, { platform: 'win32', env: {}, tree: false, run: () => assert.fail('no taskkill') })
})

test('on Windows a dsh\'s own children are gone once it is stopped', windowsOnly, async (t) => {
  const scope = scratch(t, 'omni-desktop-tree-')
  const parent = join(scope.root, 'parent.cjs')
  writeFileSync(parent, `const { spawn } = require('node:child_process')
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log(String(kid.pid))
setInterval(() => {}, 1000)
`)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [parent], { cwd: scope.root, stdio: ['ignore', 'pipe', 'ignore'] })
  const kid = Number(await new Promise(resolvePid => child.stdout.once('data', chunk => resolvePid(String(chunk).trim()))))
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.equal(alive(kid), true)
  await stopDsh(child)
  // taskkill /T ends the tree before it returns; give Windows a moment to reap.
  for (let i = 0; i < 20 && alive(kid); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(alive(kid), false, 'the grandchild outlived dsh')
})

test('a dsh that exits before it is ready is reported, and one that never says so times out', async (t) => {
  const scope = scratch(t, 'omni-desktop-fail-')
  const { root } = scope
  // startDsh stops a dsh that timed out without waiting for it to go: the test waits for both.
  const children = []
  scope.stop = () => Promise.all(children.map(child => stopDsh(child)))
  const onSpawn = child => children.push(child)
  const dies = join(root, 'dies.mjs')
  writeFileSync(dies, 'process.exit(3)')
  await assert.rejects(startDsh({ node: process.execPath, bin: dies, env: process.env, port: await freePort(), cwd: root, onSpawn }), /exited before it was ready \(3\)/)
  const silent = join(root, 'silent.mjs')
  writeFileSync(silent, 'setInterval(() => {}, 1000)')
  await assert.rejects(startDsh({ node: process.execPath, bin: silent, env: process.env, port: await freePort(), cwd: root, timeoutMs: 300, onSpawn }), /did not start within/)
})


test('dsh gets node and pnpm on its PATH, both on the app\'s own Node', posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = join(root, "it's pnpm.cjs")
  writeFileSync(script, 'console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]))')
  const dir = writeTools({ dir: join(root, 'bin'), node: process.execPath, pnpm: script })
  assert.deepEqual(JSON.parse(execFileSync(join(dir, 'pnpm'), ['add', 'a b'], { encoding: 'utf8' })), ['1', 'add', 'a b'])
  assert.equal(execFileSync(join(dir, 'node'), ['-p', '6*7'], { encoding: 'utf8' }).trim(), '42')
})

test('on Windows node and pnpm are batch files that run on the app\'s own Node', windowsOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni desktop tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = join(root, "it's pnpm.cjs")
  writeFileSync(script, 'console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]))')
  const dir = writeTools({ dir: join(root, 'bin'), node: process.execPath, pnpm: script })
  const run = (name, args) => execFileSync(...batchSafe(join(dir, `${name}.cmd`), args, { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }))
  assert.deepEqual(JSON.parse(run('pnpm', ['add', 'a b'])), ['1', 'add', 'a b'])
  assert.equal(run('node', ['-p', '6*7']).trim(), '42')
  assert.equal(existsSync(join(dir, 'pnpm')), false, 'no sh script beside the batch files')
})

test('dsh\'s PATH ends with the tool folders and then the app\'s own node and pnpm', () => {
  const dir = join('/app', 'bin')
  const tools = [join('/u', '.local', 'bin'), join('/u', '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']
  const path = (...dirs) => dirs.join(delimiter)
  assert.equal(dshEnv({ base: { PATH: '/bin' }, home: '/a', binDir: dir, userHome: '/u' }).PATH, path('/bin', ...tools, dir))
  assert.equal(dshEnv({ base: { PATH: '/bin' }, home: '/a', userHome: '/u' }).PATH, path('/bin', ...tools))
  // acp-dsh installs its adapters with the app's own pnpm, whatever pnpm comes first on PATH.
  assert.equal(dshEnv({ base: { PATH: '/bin' }, home: '/a', binDir: dir, userHome: '/u', platform: 'linux' }).AUTOMAGIK_PNPM, join(dir, 'pnpm'))
  assert.equal(dshEnv({ base: { PATH: '/bin' }, home: '/a', binDir: dir, userHome: '/u', platform: 'win32' }).AUTOMAGIK_PNPM, join(dir, 'pnpm.cmd'))
  assert.equal(dshEnv({ base: { PATH: '/bin' }, home: '/a', userHome: '/u' }).AUTOMAGIK_PNPM, undefined)
  // A folder already on the person's PATH keeps its place and is not repeated.
  assert.equal(dshEnv({ base: { PATH: path('/usr/local/bin', '/bin') }, home: '/a', userHome: '/u' }).PATH, path('/usr/local/bin', '/bin', ...tools.slice(0, 3)))
})

test('a start leaves node and pnpm as they are when they already say the same, and rewrites them when not', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'bin')
  const file = name => toolFileOf(dir, name)
  writeTools({ dir, node: '/app/one/node', pnpm: '/app/one/pnpm.cjs' })
  const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
  for (const name of ['node', 'pnpm']) utimesSync(file(name), old, old)
  const unchanged = name => statSync(file(name)).mtimeMs === old.getTime()
  writeTools({ dir, node: '/app/one/node', pnpm: '/app/one/pnpm.cjs' })
  assert.ok(unchanged('node') && unchanged('pnpm'), 'nothing is written when nothing changed')
  if (process.platform !== 'win32') {
    // A tool that lost its execute bit is written again (Windows keeps no execute bit).
    chmodSync(file('pnpm'), 0o644)
    writeTools({ dir, node: '/app/one/node', pnpm: '/app/one/pnpm.cjs' })
    assert.equal(statSync(file('pnpm')).mode & 0o777, 0o755)
    assert.ok(unchanged('node'))
  }
  // The app moved (a new install): both name the new path.
  writeTools({ dir, node: '/app/two/node', pnpm: '/app/one/pnpm.cjs' })
  assert.ok(!unchanged('node') && readFileSync(file('node'), 'utf8').includes('/app/two/node'))
  assert.ok(readFileSync(file('pnpm'), 'utf8').includes('/app/two/node'))
})

test('a Windows batch tool quotes its paths and doubles a %', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = writeTools({ dir: join(root, 'bin'), node: 'C:\\Users\\Ana 100%\\Automagik.exe', pnpm: 'C:\\A\\pnpm.cjs', platform: 'win32' })
  const text = readFileSync(join(dir, 'pnpm.cmd'), 'utf8')
  assert.match(text, /^@echo off\r\n/)
  assert.match(text, /\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Users\\Ana 100%%\\Automagik\.exe" "C:\\A\\pnpm\.cjs" %\*\r\n$/)
  assert.equal(existsSync(join(dir, 'pnpm')), false)
})

test('an update adds the settings a newer build ships and keeps every one the user has', () => {
  const shipped = `# Omni's own search.
- insert:
    - id: web-search-auto
      name: x
- id: web
  config:
    searchProvider: auto
# The octopus opens the app.
- id: ui-settings-models
  config:
    credentialOnboarding: false
`
  // DSH's empty template takes every shipped entry, comments and all.
  assert.equal(mergeProfilePatch('[]\n', shipped), shipped)
  // An entry the user has, changed or not, stays theirs; only the missing one is added.
  const user = `- id: web\n  config:\n    searchProvider: brave\n- insert:\n    - id: web-search-auto\n      name: x\n`
  assert.equal(
    mergeProfilePatch(user, shipped),
    `${user}# The octopus opens the app.\n- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n`,
  )
  assert.equal(mergeProfilePatch(shipped, shipped), null)
})

test('an existing profile gets pnpm settings and the newer build\'s settings on update', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'shipped')
  mkdirSync(join(source, 'node_modules'), { recursive: true })
  writeFileSync(join(source, 'package.json'), '{}')
  writeFileSync(join(source, '.build-id'), 'one')
  writeFileSync(join(source, 'cordis.patch.yml'), '- id: web\n  config:\n    searchProvider: auto\n')
  const dshHome = join(root, 'dsh')
  const { target } = await installProfile({ dshHome, source })
  // An install from before pnpm-workspace.yaml shipped, with the user's own search.
  rmSync(join(target, 'pnpm-workspace.yaml'), { force: true })
  writeFileSync(join(target, 'cordis.patch.yml'), '- id: web\n  config:\n    searchProvider: brave\n')
  writeFileSync(join(source, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  writeFileSync(join(source, 'cordis.patch.yml'), '- id: web\n  config:\n    searchProvider: auto\n- id: plugin-market\n  config:\n    indexes: []\n')
  writeFileSync(join(source, '.build-id'), 'two')
  await installProfile({ dshHome, source })
  assert.equal(readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8'), 'nodeLinker: hoisted\n')
  assert.equal(
    readFileSync(join(target, 'cordis.patch.yml'), 'utf8'),
    '- id: web\n  config:\n    searchProvider: brave\n- id: plugin-market\n  config:\n    indexes: []\n',
  )
})

test('an update replaces the packages the app ships and keeps the plugins the user installed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-keep-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'shipped')
  const shippedPackage = (version) => ({ dependencies: { '@automagik/omni-dsh': version }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@automagik/omni-dsh'] } } })
  mkdirSync(join(source, 'node_modules', '@automagik', 'omni-dsh'), { recursive: true })
  writeFileSync(join(source, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'v1')
  writeFileSync(join(source, 'package.json'), JSON.stringify(shippedPackage('1')))
  writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(source, '.build-id'), 'one')
  const dshHome = join(root, 'dsh')
  const { target } = await installProfile({ dshHome, source })
  // The user installs a market plugin: dsh's pnpm adds it, and its own dependency, beside Omni's.
  mkdirSync(join(target, 'node_modules', 'dsh-kimi-subscription'), { recursive: true })
  mkdirSync(join(target, 'node_modules', '@automagik', 'their-plugin'), { recursive: true })
  const user = shippedPackage('1')
  user.dependencies['dsh-kimi-subscription'] = '1.3.10'
  user.dependencies['their-plugin'] = 'file:vendor/their-plugin-1.0.0.tgz'
  user.dsh.profile.bundles.push('dsh-kimi-subscription')
  writeFileSync(join(target, 'package.json'), JSON.stringify(user))

  writeFileSync(join(source, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'v2')
  writeFileSync(join(source, 'package.json'), JSON.stringify(shippedPackage('2')))
  // The tarballs package.json names (file:vendor/…) come with the build.
  mkdirSync(join(source, 'vendor'), { recursive: true })
  writeFileSync(join(source, 'vendor', 'omni-dsh-2.tgz'), 'two')
  mkdirSync(join(target, 'vendor'), { recursive: true })
  writeFileSync(join(target, 'vendor', 'omni-dsh-1.tgz'), 'one')
  writeFileSync(join(target, 'vendor', 'their-plugin-1.0.0.tgz'), 'theirs')
  // The shipped lock does not know the user's plugins: pnpm resolves from package.json instead.
  writeFileSync(join(source, 'pnpm-lock.yaml'), 'shipped')
  writeFileSync(join(target, 'pnpm-lock.yaml'), 'stale')
  writeFileSync(join(source, '.build-id'), 'two')
  await installProfile({ dshHome, source })
  assert.deepEqual(readdirSync(join(target, 'vendor')).sort(), ['omni-dsh-2.tgz', 'their-plugin-1.0.0.tgz'])
  assert.equal(existsSync(join(target, 'pnpm-lock.yaml')), false)
  assert.equal(readFileSync(join(target, 'node_modules', '@automagik', 'omni-dsh', 'index.js'), 'utf8'), 'v2')
  assert.equal(existsSync(join(target, 'node_modules', 'dsh-kimi-subscription')), true)
  assert.equal(existsSync(join(target, 'node_modules', '@automagik', 'their-plugin')), true)
  const merged = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.deepEqual(merged.dependencies, { '@automagik/omni-dsh': '2', 'dsh-kimi-subscription': '1.3.10', 'their-plugin': 'file:vendor/their-plugin-1.0.0.tgz' })
  assert.deepEqual(merged.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@automagik/omni-dsh', 'dsh-kimi-subscription'])
  // Nothing added: the shipped package.json as it is.
  assert.deepEqual(JSON.parse(mergeProfilePackage(shippedPackage('2'), shippedPackage('3'))), shippedPackage('3'))
})

// Builds up to 2.261023.x (automagik-dev/omni-desktop) shipped the Bot team and the welcome
// as @automagik/omni-dsh and @automagik/omni-ai-dsh. An update into this app finds such a
// profile: it must end with the new packages only, the user's rows naming them, and the
// team's home untouched.
test('an update moves a profile from the renamed packages to the new ones and keeps everything else', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-rename-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh')
  const target = join(dshHome, 'profiles', 'omni')
  const old = ['@automagik/omni-dsh', '@automagik/omni-channels-dsh', '@automagik/omni-canvas-dsh', '@automagik/omni-ai-dsh']
  for (const name of [...old, 'dsh-kimi-subscription']) {
    mkdirSync(join(target, 'node_modules', ...name.split('/')), { recursive: true })
    writeFileSync(join(target, 'node_modules', ...name.split('/'), 'index.js'), 'old')
  }
  writeFileSync(join(target, 'package.json'), JSON.stringify({
    dependencies: { ...Object.fromEntries(old.map(name => [name, `file:vendor/${name.slice(11)}-2.261023.32.tgz`])), 'dsh-kimi-subscription': '1.3.10' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...old, 'dsh-kimi-subscription'] } },
  }))
  // The user's settings: rows DSH's Settings wrote for the team (by package name), the web
  // search the app inserted, and the user's own model setup.
  writeFileSync(join(target, 'cordis.patch.yml'), [
    '- insert:', '    - id: web-search-auto', "      name: '@automagik/omni-dsh/web-search'",
    '- id: omni-ui', "  name: '@automagik/omni-dsh'", '  config:', '    checkRatio: 0.7', '    memoryReview: false',
    '- id: omni-ai', "  name: '@automagik/omni-ai-dsh'", '  config:', '    welcomeDone: true',
    '- id: llm-pi-ai', '  config:', '    routes: [juice]', '',
  ].join('\n'))
  writeFileSync(join(target, '.omni-desktop-profile'), 'old build')
  writeFileSync(join(dshHome, 'cordis.patch.yml'), "- id: omni-ui\n  name: '@automagik/omni-dsh'\n  config:\n    browser: false\n")
  // The team's home: Bots, chats, memory and the Omni link.
  const team = join(root, 'ui')
  mkdirSync(join(team, 'memory'), { recursive: true })
  writeFileSync(join(team, 'state.json'), '{"version":1,"bots":[{"id":"omni"}]}')
  writeFileSync(join(team, 'omni.json'), '{"url":"https://omni.example"}')

  const source = join(root, 'shipped')
  const fresh = ['@automagik/bots-dsh', '@automagik/omni-channels-dsh', '@automagik/omni-canvas-dsh', '@automagik/welcome-dsh']
  for (const name of fresh) {
    mkdirSync(join(source, 'node_modules', ...name.split('/')), { recursive: true })
    writeFileSync(join(source, 'node_modules', ...name.split('/'), 'index.js'), 'new')
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(fresh.map(name => [name, 'file:vendor/x.tgz'])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...fresh] } } }))
  writeFileSync(join(source, 'cordis.patch.yml'), readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8'))
  writeFileSync(join(source, '.build-id'), 'new build')

  assert.equal((await installProfile({ dshHome, source })).installed, true)
  const merged = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(merged.dependencies), [...fresh, 'dsh-kimi-subscription'])
  assert.deepEqual(merged.dsh.profile.bundles, ['@deepseek-ai/dsh-base', ...fresh, 'dsh-kimi-subscription'])
  assert.equal(existsSync(join(target, 'node_modules', '@automagik', 'omni-dsh')), false)
  assert.equal(existsSync(join(target, 'node_modules', '@automagik', 'omni-ai-dsh')), false)
  for (const name of fresh) assert.equal(readFileSync(join(target, 'node_modules', ...name.split('/'), 'index.js'), 'utf8'), 'new')
  assert.equal(readFileSync(join(target, 'node_modules', 'dsh-kimi-subscription', 'index.js'), 'utf8'), 'old')
  const patch = readFileSync(join(target, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /omni-dsh|omni-ai-dsh/)
  assert.match(patch, /^- id: omni-ui\n {2}name: '@automagik\/bots-dsh'\n {2}config:\n {4}checkRatio: 0\.7\n {4}memoryReview: false$/m)
  assert.match(patch, /name: '@automagik\/bots-dsh\/web-search'/)
  assert.match(patch, /^- id: omni-ai\n {2}name: '@automagik\/welcome-dsh'\n {2}config:\n {4}welcomeDone: true$/m)
  assert.match(patch, /routes: \[juice\]/)
  assert.equal(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8'), "- id: omni-ui\n  name: '@automagik/bots-dsh'\n  config:\n    browser: false\n")
  assert.equal(readFileSync(join(team, 'state.json'), 'utf8'), '{"version":1,"bots":[{"id":"omni"}]}')
  assert.equal(readFileSync(join(team, 'omni.json'), 'utf8'), '{"url":"https://omni.example"}')
  // Run again (the next launch of the same build): nothing left to move.
  assert.deepEqual(migrateRenamed({ target, dshHome, shipped: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) }), [])
})

test('the rename touches only the old names, whole', () => {
  assert.deepEqual(RENAMED, { '@automagik/omni-dsh': '@automagik/bots-dsh', '@automagik/omni-ai-dsh': '@automagik/welcome-dsh' })
  assert.equal(renamePatch("- id: x\n  name: '@automagik/omni-dsh-extra'\n- id: y\n  name: '@automagik/omni-channels-dsh'\n"), null)
  assert.equal(renamePatch('name: @automagik/omni-dsh # the team\n'), 'name: @automagik/bots-dsh # the team\n')
  assert.equal(renamePatch('name: "@automagik/omni-ai-dsh"'), 'name: "@automagik/welcome-dsh"')
  // Comments too, whatever follows the name.
  assert.equal(renamePatch('# opens this app (@automagik/omni-ai-dsh: Welcome)'), '# opens this app (@automagik/welcome-dsh: Welcome)')
  // A build that does not ship the new name leaves the old one alone.
  assert.deepEqual(JSON.parse(mergeProfilePackage({ dependencies: { '@automagik/omni-dsh': '1' } }, { dependencies: {} })).dependencies, { '@automagik/omni-dsh': '1' })
})

// Oh My Claude left the app (Claude comes through DSH's pi-ai route). An update of a profile
// an earlier build installed with it must take it out whole: its folder, its dependency and
// bundle, and its rows in both patch files, leaving every other row as the user has it.
test('an update takes a package the app no longer ships out of the profile and keeps everything else', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-retire-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh')
  const target = join(dshHome, 'profiles', 'omni')
  const shipped = ['@automagik/bots-dsh', '@automagik/welcome-dsh', '@goodandready/dsh-subscriptions']
  for (const name of [...shipped, 'dsh-oh-my-claude', 'dsh-kimi-subscription']) {
    mkdirSync(join(target, 'node_modules', ...name.split('/')), { recursive: true })
    writeFileSync(join(target, 'node_modules', ...name.split('/'), 'index.js'), 'old')
  }
  writeFileSync(join(target, 'package.json'), JSON.stringify({
    dependencies: { ...Object.fromEntries(shipped.map(name => [name, '*'])), 'dsh-oh-my-claude': 'github:automagik-genie/dsh-oh-my-claude#eb9d1cdad58472ebe34abd194309a60fc22c40d1', 'dsh-kimi-subscription': '1.3.10' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...shipped, 'dsh-oh-my-claude', 'dsh-kimi-subscription'] } },
  }))
  writeFileSync(join(target, 'cordis.patch.yml'), [
    '- insert:', '    - id: web-search-auto', "      name: '@automagik/bots-dsh/web-search'",
    '    - id: oh-my-claude-tools', '      name: dsh-oh-my-claude # the Claude Code tools',
    '# Claude Code, as the person set it up',
    '- id: oh-my-claude', '  config:', '    permissionMode: auto', '',
    '- id: omni-ai', "  name: '@automagik/welcome-dsh'", '  config:', '    welcomeDone: true',
    '- id: llm-pi-ai', '  config:', '    providers:', '      anthropic: {}', '',
  ].join('\n'))
  writeFileSync(join(target, '.omni-desktop-profile'), 'old build')
  writeFileSync(join(dshHome, 'cordis.patch.yml'), '- insert:\n    - id: omc\n      name: "dsh-oh-my-claude"\n- id: omc-ui\n  name: dsh-oh-my-claude\n  config:\n    hints: false\n')

  const source = join(root, 'shipped')
  for (const name of shipped) {
    mkdirSync(join(source, 'node_modules', ...name.split('/')), { recursive: true })
    writeFileSync(join(source, 'node_modules', ...name.split('/'), 'index.js'), 'new')
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(shipped.map(name => [name, '*'])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...shipped] } } }))
  writeFileSync(join(source, 'cordis.patch.yml'), readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8'))
  writeFileSync(join(source, '.build-id'), 'new build')

  assert.equal((await installProfile({ dshHome, source })).installed, true)
  const merged = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(merged.dependencies), [...shipped, 'dsh-kimi-subscription'])
  assert.deepEqual(merged.dsh.profile.bundles, ['@deepseek-ai/dsh-base', ...shipped, 'dsh-kimi-subscription'])
  assert.equal(existsSync(join(target, 'node_modules', 'dsh-oh-my-claude')), false)
  assert.equal(readFileSync(join(target, 'node_modules', 'dsh-kimi-subscription', 'index.js'), 'utf8'), 'old')
  const patch = readFileSync(join(target, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /oh-my-claude|Claude Code/)
  assert.match(patch, /^- insert:\n {4}- id: web-search-auto\n {6}name: '@automagik\/bots-dsh\/web-search'\n\n?- id: omni-ai\n/m)
  assert.match(patch, /^- id: omni-ai\n {2}name: '@automagik\/welcome-dsh'\n {2}config:\n {4}welcomeDone: true\n- id: llm-pi-ai\n {2}config:\n {4}providers:\n {6}anthropic: \{\}\n/m)
  // DSH's own patch held nothing else: it is the empty template again.
  assert.equal(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8'), '[]\n')
  // The next launch of the same build: nothing left to take out.
  assert.deepEqual(migrateRetired({ target, dshHome, shipped: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) }), [])
})

test('the retirement takes only the retired package\'s rows, and none while the app still ships it', () => {
  assert.deepEqual(RETIRED, { 'dsh-oh-my-claude': ['oh-my-claude'] })
  // A name that only starts like it, a nested config key and a comment elsewhere stay.
  const others = "- id: x\n  name: dsh-oh-my-claude-extra\n- id: y\n  config:\n    name: dsh-oh-my-claude\n# about dsh-oh-my-claude\n- id: web\n"
  assert.equal(retirePatch(others), null)
  assert.equal(retirePatch("- id: 'oh-my-claude'\n  config:\n    a: 1\n- id: web\n"), '- id: web\n')
  assert.equal(retirePatch('- id: a\n  name: "dsh-oh-my-claude"   # theirs\n'), '[]\n')
  assert.equal(retirePatch('[]\n'), null)
  // Another package's insert item whose nested config names it stays, whole; only the
  // item that is the package goes.
  const nested = "- insert:\n    - id: router\n      name: '@automagik/bots-dsh/router'\n      config:\n        name: dsh-oh-my-claude\n    - id: omc\n      name: dsh-oh-my-claude\n- id: web\n"
  assert.equal(retirePatch(nested), "- insert:\n    - id: router\n      name: '@automagik/bots-dsh/router'\n      config:\n        name: dsh-oh-my-claude\n- id: web\n")
  assert.equal(retirePatch("- insert:\n    - id: router\n      config:\n        name: dsh-oh-my-claude\n"), null)
  // The rows stay, and so does the package, in a build that still ships it.
  const shipping = { dependencies: { 'dsh-oh-my-claude': '1' } }
  assert.deepEqual(JSON.parse(mergeProfilePackage({ dependencies: { 'dsh-oh-my-claude': '1' }, dsh: { profile: { bundles: ['dsh-oh-my-claude'] } } }, { ...shipping, dsh: { profile: { bundles: [] } } })).dsh.profile.bundles, ['dsh-oh-my-claude'])
})

test('a preload comes from the launch and stays in the app\'s home; none is no preference', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'omni-desktop-preload-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assert.equal(preloadAsked(['/opt/Omni/omni-desktop', '--preload=omni']), 'omni')
  assert.equal(preloadAsked(['x', '--preload', 'Genie']), 'genie')
  assert.equal(preloadAsked(['x'], { AUTOMAGIK_PRELOAD: 'omni' }), 'omni')
  assert.equal(preloadAsked(['x', '--preload=other']), null)
  assert.equal(preloadAsked(['x', '--preload']), null)
  assert.equal(preloadOf({ home, argv: ['x'] }), null)
  assert.equal(existsSync(join(home, 'preload')), false)
  assert.equal(preloadOf({ home, argv: ['x', '--preload=genie'] }), 'genie')
  // A later launch from the Dock or a desktop entry passes no flag.
  assert.equal(preloadOf({ home, argv: ['x'] }), 'genie')
  assert.equal(preloadOf({ home, argv: ['x', '--preload=omni'] }), 'omni')
  assert.equal(preloadOf({ home, argv: ['x'] }), 'omni')
  writeFileSync(join(home, 'preload'), 'nonsense\n')
  assert.equal(preloadOf({ home, argv: ['x'] }), null)
  assert.equal(dshEnv({ base: {}, home: '/a', preload: 'omni' }).AUTOMAGIK_PRELOAD, 'omni')
  assert.equal('AUTOMAGIK_PRELOAD' in dshEnv({ base: {}, home: '/a' }), false)
})


// A stand-in dsh that binds its port as dsh's webserver does: it prints its launch line once
// it listens, and exits 1 with the listen error when it cannot (dsh-host-webserver listen).
const LISTENING_DSH = `
import { createServer } from 'node:net'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const server = createServer(socket => socket.end())
server.once('error', (error) => { console.error('Error: listen ' + error.code + ': address already in use 127.0.0.1:' + port); process.exit(1) })
server.listen(port, args[args.indexOf('--host') + 1], () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=' + process.pid))
`
// Something else listening on 127.0.0.1:`port` (or a fresh port), until the test ends.
const squat = async (t, port = 0) => {
  const server = createServer()
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  t.after(() => new Promise(done => server.close(done)))
  return server.address().port
}

test('the port dsh served on is kept in the app home; a missing, garbled or privileged one reads as none', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'omni-desktop-port-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = portFileOf(home)
  assert.equal(file, join(home, 'dsh-port'))
  assert.equal(storedPort(file), null)
  keepPort(file, 41149)
  assert.equal(readFileSync(file, 'utf8'), '41149\n')
  assert.equal(storedPort(file), 41149)
  assert.deepEqual(readdirSync(home), ['dsh-port'], 'no temporary file is left beside it')
  for (const text of ['', 'abc', '41149x', '-5', '80', '1023', '65536', '999999', '4.5', '0x1f90']) {
    writeFileSync(file, text)
    assert.equal(storedPort(file), null, JSON.stringify(text))
  }
  writeFileSync(file, ' 50000 \n')
  assert.equal(storedPort(file), 50000)
})

test('a start takes the stored port while it is free, and a fresh one when it is taken or the file is stale', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'omni-desktop-port-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = portFileOf(home)
  let fresh = 0
  const counted = () => { fresh += 1; return freePort() }

  // No file yet: a fresh port.
  const first = await launchPort(file, counted)
  assert.equal(fresh, 1)
  // The stored port, while nothing listens on it.
  keepPort(file, first)
  assert.equal(await portFree(first), true)
  assert.equal(await launchPort(file, counted), first)
  assert.equal(fresh, 1)
  // Something else took it: a fresh port, never the taken one.
  const taken = await squat(t)
  keepPort(file, taken)
  assert.equal(await portFree(taken), false)
  const instead = await launchPort(file, counted, { waitMs: 0 })
  assert.notEqual(instead, taken)
  assert.equal(fresh, 2)
  // A stale file (garbled by a crash, or hand-edited): a fresh port.
  writeFileSync(file, 'not a port')
  await launchPort(file, counted)
  assert.equal(fresh, 3)
})

// launchPort's wait on a clock of its own: `sleep` only moves the clock, and `free` answers from
// `freeAt` (the time the port's holder lets go, or never).
const waitClock = ({ freeAt = Infinity } = {}) => {
  const clock = { time: 1000, sleeps: [], looks: 0, waited: [] }
  return Object.assign(clock, {
    options: {
      now: () => clock.time,
      sleep: async (ms) => { clock.sleeps.push(ms); clock.time += ms },
      free: async () => { clock.looks += 1; return clock.time - 1000 >= freeAt },
      onWaited: (ms, freed) => clock.waited.push([ms, freed]),
    },
  })
}

test('a stored port that is taken is waited for a short while before a fresh one is taken', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'omni-desktop-port-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = portFileOf(home)
  let fresh = 0
  const other = () => { fresh += 1; return 50001 }
  assert.ok(PORT_WAIT_MS >= 1000 && PORT_WAIT_MS <= 5000, 'a few seconds')
  assert.ok(PORT_WAIT_STEP_MS > 0 && PORT_WAIT_STEP_MS <= 250, 'a short interval')

  // No stored port: straight to a fresh one, no look and no wait.
  const none = waitClock()
  assert.equal(await launchPort(file, other, none.options), 50001)
  assert.deepEqual([fresh, none.looks, none.sleeps, none.waited], [1, 0, [], []])

  keepPort(file, 50000)
  // Free at once: reused after one look, no wait.
  const atOnce = waitClock({ freeAt: 0 })
  assert.equal(await launchPort(file, other, atOnce.options), 50000)
  assert.deepEqual([fresh, atOnce.looks, atOnce.sleeps, atOnce.waited], [1, 1, [], []])

  // Freed during the window (the last dsh finishing its shutdown): reused, and the wait ends there.
  const during = waitClock({ freeAt: 250 })
  assert.equal(await launchPort(file, other, during.options), 50000)
  assert.equal(fresh, 1)
  assert.deepEqual(during.sleeps, [100, 100, 100])
  assert.deepEqual(during.waited, [[300, true]])

  // Still taken when the window ends: a fresh port, after the whole window and no longer.
  const never = waitClock()
  assert.equal(await launchPort(file, other, never.options), 50001)
  assert.equal(fresh, 2)
  assert.equal(never.sleeps.reduce((sum, ms) => sum + ms, 0), PORT_WAIT_MS)
  assert.equal(never.looks, 1 + PORT_WAIT_MS / PORT_WAIT_STEP_MS)
  assert.deepEqual(never.waited, [[PORT_WAIT_MS, false]])

  // A window the step does not divide: the last wait is cut to what is left of it.
  const uneven = waitClock()
  await launchPort(file, other, { ...uneven.options, waitMs: 250, stepMs: 100 })
  assert.deepEqual(uneven.sleeps, [100, 100, 50])

  // Slow looks count against the window too.
  const slow = waitClock()
  const slowFree = async () => { slow.time += 400; return false }
  await launchPort(file, other, { ...slow.options, free: slowFree, waitMs: 1000, stepMs: 100 })
  assert.deepEqual(slow.sleeps, [100, 100])

  // A clock that stands still (or runs back) cannot hold the start: the looks are counted too.
  const stuck = waitClock()
  await launchPort(file, other, { ...stuck.options, now: () => 5, waitMs: 1000, stepMs: 100 })
  assert.equal(stuck.sleeps.length, 10)
  assert.deepEqual(stuck.waited, [[0, false]])

  // No window: the stored port is looked at once, as before.
  const off = waitClock()
  assert.equal(await launchPort(file, other, { ...off.options, waitMs: 0 }), 50001)
  assert.deepEqual([off.looks, off.sleeps, off.waited], [1, [], []])
})

test('a stored port its holder lets go of within the wait is reused, on the real clock', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'omni-desktop-port-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = portFileOf(home)
  const server = createServer()
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const { port } = server.address()
  let open = true
  t.after(() => open && new Promise(done => server.close(done)))
  keepPort(file, port)
  // The holder goes on the first wait, as a dsh that was still shutting down does.
  const sleep = () => new Promise((done) => { open = false; server.close(done) })
  assert.equal(await launchPort(file, () => assert.fail('no fresh port'), { sleep }), port)
})

test('the page\'s origin stays the same from one start to the next, and moves only when its port is taken', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-origin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, LISTENING_DSH)
  const file = portFileOf(root)
  // A start as main.js makes it: the port, dsh on it, the port kept once dsh serves on it.
  const start = async () => {
    const running = await startDshOnPort({ node: process.execPath, bin, env: process.env, port: await launchPort(file, undefined, { waitMs: 0 }), cwd: root })
    keepPort(file, Number(new URL(running.url).port))
    const { origin } = new URL(running.url)
    assert.equal(servesOrigin(running, origin), true)
    await stopDsh(running.child)
    return { origin, token: new URL(running.url).searchParams.get('token') }
  }
  const one = await start()
  const two = await start()
  const three = await start()
  assert.equal(two.origin, one.origin)
  assert.equal(three.origin, one.origin)
  // Each launch still signs in with its own dsh's token.
  assert.notEqual(two.token, one.token)
  // The port taken while the app was closed: this start moves, and the next keeps the new origin.
  await squat(t, Number(new URL(one.origin).port))
  const moved = await start()
  assert.notEqual(moved.origin, one.origin)
  assert.equal((await start()).origin, moved.origin)
})

test('a port taken after the app looked: dsh exits on the listen error and starts once more on a fresh port', async (t) => {
  const scope = scratch(t, 'omni-desktop-race-')
  const { root } = scope
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, LISTENING_DSH)
  const taken = await squat(t)
  // startDsh alone says why it failed.
  await assert.rejects(startDsh({ node: process.execPath, bin, env: process.env, port: taken, cwd: root }), error => error.code === 'EADDRINUSE' && /exited before it was ready \(1\)/.test(error.message))

  const told = []
  const running = await startDshOnPort({ node: process.execPath, bin, env: process.env, port: taken, cwd: root, onPort: next => told.push(next) })
  scope.stop = () => stopDsh(running.child)
  const { port } = new URL(running.url)
  assert.notEqual(Number(port), taken)
  assert.deepEqual(told, [Number(port)], 'the app hears the new port before dsh is ready on it')
  assert.equal(servesOrigin(running, `http://127.0.0.1:${port}`), true)
  assert.equal(servesOrigin(running, `http://127.0.0.1:${taken}`), false, 'never the taken port\'s origin')

  // Any other failure is not retried.
  const dies = join(root, 'dies.mjs')
  writeFileSync(dies, 'process.exit(3)')
  let spawned = 0
  await assert.rejects(startDshOnPort({ node: process.execPath, bin: dies, env: process.env, port: await freePort(), cwd: root, onSpawn: () => { spawned += 1 } }), error => error.code === undefined)
  assert.equal(spawned, 1)
})

test('the page is loaded only from the dsh this start spawned, while it runs, on the guarded origin', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-serves-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, LISTENING_DSH)
  const running = await startDsh({ node: process.execPath, bin, env: process.env, port: await freePort(), cwd: root })
  const { origin } = new URL(running.url)
  assert.equal(servesOrigin(running, origin), true)
  assert.equal(servesOrigin(running, 'http://127.0.0.1:1'), false)
  assert.equal(servesOrigin({ child: running.child, url: 'not a url' }, origin), false)
  assert.equal(servesOrigin(undefined, origin), false)
  await stopDsh(running.child)
  assert.equal(servesOrigin(running, origin), false, 'a dsh that has stopped serves nothing')
})

test('the navigation guard follows dsh\'s origin when dsh moves to another port after the guard is in place', () => {
  let origin = 'http://127.0.0.1:41149'
  const contents = new EventEmitter()
  contents.setWindowOpenHandler = () => {}
  guardContents(contents, { origin: () => origin, openExternal: () => {} })
  const refused = (url) => {
    let refusedIt = false
    contents.emit('will-navigate', { preventDefault: () => { refusedIt = true } }, url)
    return refusedIt
  }
  assert.equal(refused('http://127.0.0.1:41149/'), false)
  origin = 'http://127.0.0.1:50000'
  assert.equal(refused('http://127.0.0.1:50000/'), false)
  assert.equal(refused('http://127.0.0.1:41149/'), true, 'the old origin is off-origin now')
})

test('only dsh\'s own listen error for the port it was given counts as a taken port', async (t) => {
  const line = 'Error: listen EADDRINUSE: address already in use 127.0.0.1:50927'
  assert.equal(listenFailed(`booting\n    ${line}\n        at Server.setupListenHandle\n`, 50927), true, 'as dsh logs it, indented under its logger')
  assert.equal(listenFailed(line, 50928), false, 'another port')
  assert.equal(listenFailed('Error: listen EADDRINUSE: address already in use 0.0.0.0:50927', 50927), false, 'another address')
  assert.equal(listenFailed('mcp: upstream said EADDRINUSE on 127.0.0.1:50927, retrying', 50927), false, 'other log text naming the code')
  assert.equal(listenFailed(`plugin note: ${line}`, 50927), false, 'quoted inside another line')

  // A dsh that dies for another reason after logging such text is not started again.
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-noise-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const noisy = join(root, 'noisy.mjs')
  writeFileSync(noisy, "console.error('mcp: upstream said EADDRINUSE on 127.0.0.1:' + process.argv[process.argv.indexOf('--port') + 1]); process.exit(1)")
  let spawned = 0
  await assert.rejects(startDshOnPort({ node: process.execPath, bin: noisy, env: process.env, port: await freePort(), cwd: root, onSpawn: () => { spawned += 1 } }), error => error.code === undefined)
  assert.equal(spawned, 1)
})

test('a quit between the first dsh\'s exit and the retry spawns no second dsh', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-quit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, LISTENING_DSH)
  const run = dshRun()
  const spawned = []
  // The quit comes while the fresh port is being found, after the first dsh has exited.
  const fresh = async () => { await run.stop(); return freePort() }
  await assert.rejects(serveDsh({ run, portFile: portFileOf(root), node: process.execPath, bin, env: process.env, port: await squat(t), fresh, cwd: root, onSpawn: child => spawned.push(child) }), error => error.code === 'EADDRINUSE')
  assert.equal(spawned.length, 1)
  assert.notEqual(spawned[0].exitCode, null)
  assert.equal(storedPort(portFileOf(root)), null, 'nothing kept')
})

test('a quit after the retry spawned stops the retry\'s dsh, and one spawned after a quit is stopped at once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-desktop-quit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, LISTENING_DSH)
  const exited = child => (child.exitCode !== null || child.signalCode !== null)

  // The retry's dsh is the current one from its spawn: a quit stops it, not the first, dead one.
  const run = dshRun()
  const spawned = []
  const taken = await squat(t)
  const running = await serveDsh({ run, portFile: portFileOf(root), node: process.execPath, bin, env: process.env, port: taken, cwd: root, onSpawn: child => spawned.push(child) })
  assert.equal(spawned.length, 2)
  assert.equal(run.child, spawned[1])
  assert.equal(running.child, spawned[1])
  assert.equal(exited(spawned[0]), true)
  assert.equal(storedPort(portFileOf(root)), Number(new URL(running.url).port), 'the retry\'s port is kept, not the taken one')
  await run.stop()
  assert.equal(exited(spawned[1]), true)

  // A quit before anything spawned: what spawns afterwards is stopped as soon as it is tracked.
  const late = dshRun()
  await late.stop()
  await assert.rejects(startDsh({ node: process.execPath, bin, env: process.env, port: await freePort(), cwd: root, onSpawn: child => late.track(child) }), /exited before it was ready/)
  assert.equal(exited(late.child), true)
})

test("a run's `since` is when its current dsh was spawned, and nothing before a spawn (#882)", () => {
  let clock = 100
  const run = dshRun({ now: () => clock })
  assert.equal(run.since, null)
  const first = { exitCode: null }
  run.track(first)
  assert.equal(run.child, first)
  assert.equal(run.since, 100)
  // A retry's dsh is a new one: a busy file the first wrote is no longer the current dsh's.
  clock = 250
  run.track({ exitCode: null })
  assert.equal(run.since, 250)
})

test('a port that cannot be kept is reported and the start goes on; the page URL is refused off the origin', async (t) => {
  const scope = scratch(t, 'omni-desktop-unkept-')
  const { root } = scope
  const bin = join(root, 'fake-dsh.mjs')
  writeFileSync(bin, LISTENING_DSH)
  const run = dshRun()
  const unkept = []
  const running = await serveDsh({ run, portFile: join(root, 'missing', 'dsh-port'), node: process.execPath, bin, env: process.env, port: await freePort(), cwd: root, onUnkept: error => unkept.push(error.code) })
  scope.stop = () => run.stop()
  assert.deepEqual(unkept, ['ENOENT'])
  const { origin } = new URL(running.url)
  assert.equal(pageUrlOf(running, origin), running.url)
  assert.throws(() => pageUrlOf(running, 'http://127.0.0.1:1'), /not on http:\/\/127\.0\.0\.1:1/)
})

test('main.js guards the origin as it is now, and loads only the URL pageUrlOf hands it', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.match(main, /guard: \(\) => harden\(\(\) => dshOrigin\)/)
  assert.match(main, /const url = pageUrlOf\(running, dshOrigin\)[\s\S]{0,120}loadURL\(url\)/)
  assert.match(main, /serveDsh\(\{\s*run: dshProcess,/)
  assert.match(main, /urlFile/)
  assert.equal(/stopDsh\(|dshChild/.test(main), false, 'every way out stops dshProcess, the current dsh')
})
