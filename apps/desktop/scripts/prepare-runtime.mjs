// Assembles what the packaged app carries next to Electron, in build/:
//
//   build/runtime/node_modules   the pinned DeepSeek Harness (runtime/package.json + lock), with
//                                the patches in runtime/patches applied (scripts/runtime-patches.mjs)
//   build/profile/               the dsh profile the app starts: package.json, cordis.patch.yml,
//                                pnpm-workspace.yaml,
//                                and node_modules holding only the app's plugins
//
// Both leave out what nothing reads at runtime (source maps, typings, TypeScript sources,
// package docs: scripts/prune-runtime.mjs), since every shipped file slows an update.
//
// The plugins are the @automagik packages profile/package.json depends on: Automagik's own
// (this repository's apps/*-dsh, the Bot team and the welcome, at this app's version) and
// Omni's (its channels and canvases, taken from Omni itself at the commit omni.json pins, the
// Omni release this app carries, each at the release of its own last change, never above the
// pinned one). Each is packed with `npm pack`, so the app ships exactly what each package
// publishes. Their @deepseek-ai peers
// are not installed again: dsh supplies them. OMNI_SOURCE points at a local Omni checkout
// instead, for development.
// Native packages are per platform, so run this on the platform you build for.
// Usage: node scripts/prepare-runtime.mjs [--skip-runtime]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scrubBuildPaths } from '../src/dsh.js'
import { prepareSharpWasm, pruneNodeModules } from './prune-runtime.mjs'
import { acceptsHarness } from './follow-dsh.mjs'
import { patchRuntime } from './runtime-patches.mjs'
import { devClientBundles } from './client-bundles.mjs'
import { batchSafe } from './batch-spawn.mjs'
import { compareVersions } from '../src/update.js'
import { DSH_TUI_FILES, DSH_TUI_PACKAGE, dshTuiSourceDir } from '../src/dsh-tui.js'
import { PAGE_CLOSE_SOURCE, pageCloseMismatch } from '../src/pane-close.js'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(APP, '..', '..')
const BUILD = join(APP, 'build')
const VENDOR = 'vendor'
// On Windows npm is a batch file, which Node runs only through cmd.exe (batch-spawn.mjs).
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npm = (args, options) => execFileSync(...batchSafe(NPM, args, options))
// @openuidev/lang-core and others phone home from install scripts unless told not to.
const env = { ...process.env, DO_NOT_TRACK: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' }
const run = (args, cwd) => npm(args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
const git = (args, cwd) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const say = message => console.log(`[prepare-runtime] ${message}`)
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

const OMNI = readJson(join(APP, 'omni.json'))
// The app, and every plugin of this repository, carry Automagik's version.
const VERSION = readJson(join(REPO, 'package.json')).version
if (readJson(join(APP, 'package.json')).version !== VERSION) throw new Error(`apps/desktop is ${readJson(join(APP, 'package.json')).version}, not Automagik's ${VERSION}: run scripts/version.ts`)
// The desktop's dsh-TUI setup imports the shared installer (am/dshTui.mjs) instead of keeping a
// second copy of the pin, profile, shim and release-age rules; ship it beside the app.
const dshTuiSource = dshTuiSourceDir({ appPath: APP })
const dshTuiBuild = join(BUILD, 'dsh-tui')
rmSync(dshTuiBuild, { recursive: true, force: true })
mkdirSync(dshTuiBuild, { recursive: true })
for (const file of DSH_TUI_FILES) {
  if (!existsSync(join(dshTuiSource, file))) {
    throw new Error(`the shared dsh-TUI installer lacks ${join(dshTuiSource, file)}`)
  }
  mkdirSync(dirname(join(dshTuiBuild, file)), { recursive: true })
  cpSync(join(dshTuiSource, file), join(dshTuiBuild, file))
}
// The child runner and its helper stay outside the app's asar so it can run as Node.
const dshTuiRunner = join(APP, 'src', 'dsh-tui-run.mjs')
cpSync(dshTuiRunner, join(dshTuiBuild, 'dsh-tui-run.mjs'))
cpSync(join(APP, 'src', 'close-inherited.cjs'), join(dshTuiBuild, 'close-inherited.cjs'))
writeFileSync(join(dshTuiBuild, 'package.json'), DSH_TUI_PACKAGE)
say(`copied the shared dsh-TUI installer (${DSH_TUI_FILES.join(', ')}) and its runner`)
// The dsh launcher gives dsh's plugin manager the app's own pnpm (src/dsh-launch.cjs). It runs
// as Node, so it stays outside the asar too.
const dshLaunchBuild = join(BUILD, 'dsh-launch')
rmSync(dshLaunchBuild, { recursive: true, force: true })
mkdirSync(dshLaunchBuild, { recursive: true })
cpSync(join(APP, 'src', 'dsh-launch.cjs'), join(dshLaunchBuild, 'dsh-launch.cjs'))
say('copied the dsh launcher')
// Omni at the pinned commit: only its plugin folders and the harness they are tested on.
function omniSource() {
  if (process.env.OMNI_SOURCE) return resolve(process.env.OMNI_SOURCE)
  const dir = join(BUILD, 'omni')
  const head = existsSync(join(dir, '.git')) ? git(['rev-parse', 'HEAD'], dir).trim() : ''
  if (head === OMNI.commit) return dir
  say(`fetching Omni ${OMNI.version} (${OMNI.commit.slice(0, 9)})`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['remote', 'add', 'origin', OMNI.repository], dir)
  git(['sparse-checkout', 'set', '--no-cone', '/apps/*-dsh/'], dir)
  git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', OMNI.commit], dir)
  git(['checkout', '-q', 'FETCH_HEAD'], dir)
  return dir
}
const OMNI_DIR = omniSource()

// Each plugin the profile depends on: Automagik's own (an apps/*-dsh folder here, packed at
// this app's version), Omni's (an apps/*-dsh folder of the pinned Omni, packed at its version),
// an add-on from npm at the exact version the profile names (vetted there), or one from a
// reviewed fork at a pinned commit (`github:owner/repo#<40-hex>`), whose version the profile
// names under omni.addonVersions.
const profileJson = readJson(join(APP, 'profile', 'package.json'))
const profileDeps = profileJson.dependencies
const PINNED_GIT = /^github:[\w.-]+\/[\w.-]+#[0-9a-f]{40}$/
const pluginFolders = apps => Object.fromEntries(readdirSync(apps)
  .filter(name => name.endsWith('-dsh') && existsSync(join(apps, name, 'package.json')))
  .map(name => [readJson(join(apps, name, 'package.json')).name, join(apps, name)]))
const own = pluginFolders(join(REPO, 'apps'))
const apps = join(OMNI_DIR, 'apps')
const omni = pluginFolders(apps)
const PLUGINS = {}
const ADDONS = {}
for (const [name, spec] of Object.entries(profileDeps)) {
  if (own[name]) PLUGINS[name] = { dir: own[name], version: VERSION }
  // Each Omni plugin carries the Omni release of its own last change (omni#1356): at or below
  // the pinned release, never above it.
  else if (omni[name]) PLUGINS[name] = { dir: omni[name], version: OMNI.version, upTo: true }
  else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) ADDONS[name] = spec
  else if (PINNED_GIT.test(spec) && profileJson.omni?.addonVersions?.[name]) ADDONS[name] = profileJson.omni.addonVersions[name]
  else throw new Error(`profile/package.json depends on ${name}@${spec}: neither Automagik's nor Omni's (apps/*-dsh) nor an add-on at an exact version or a pinned commit with its version in omni.addonVersions`)
}

// The DeepSeek Harness the app runs is the one its plugins are tested against: the Bot
// team's here. A carried Omni plugin may have tested an earlier compatible RC; CI boots
// the combined profile on our exact runtime before a release.
const harnessOf = dir => readJson(join(dir, 'dev', 'harness', 'package.json')).dependencies['@deepseek-ai/dsh']
const pinned = readJson(join(APP, 'runtime', 'package.json')).dependencies['@deepseek-ai/dsh']
const tested = harnessOf(join(REPO, 'apps', 'bots-dsh'))
if (tested !== pinned) throw new Error(`runtime/package.json pins dsh ${pinned}, but the Bot team is tested on ${tested}`)
const omniTested = harnessOf(join(apps, 'omni-channels-dsh'))
for (const [name, { dir }] of Object.entries(PLUGINS)) {
  if (!omni[name]) continue
  const range = readJson(join(dir, 'package.json')).engines?.dsh
  if (!acceptsHarness(pinned, omniTested, range)) throw new Error(`runtime/package.json pins dsh ${pinned}, but ${name} from Omni ${OMNI.version} tests on ${omniTested} and declares ${range}`)
}

const runtimeDir = join(BUILD, 'runtime')
if (!process.argv.includes('--skip-runtime') || !existsSync(join(runtimeDir, 'node_modules'))) {
  say('installing the pinned DeepSeek Harness')
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })
  for (const file of ['package.json', 'package-lock.json']) {
    if (existsSync(join(APP, 'runtime', file))) cpSync(join(APP, 'runtime', file), join(runtimeDir, file))
  }
  run(existsSync(join(runtimeDir, 'package-lock.json')) ? ['ci', '--omit=dev'] : ['install', '--omit=dev'], runtimeDir)
  // A fresh lock is the one to commit (runtime/package-lock.json).
  if (!existsSync(join(APP, 'runtime', 'package-lock.json'))) cpSync(join(runtimeDir, 'package-lock.json'), join(APP, 'runtime', 'package-lock.json'))
}
// Also enforce this on --skip-runtime: a reused native binding can crash Electron on Linux.
say(`prepared wasm-only sharp (${prepareSharpWasm(join(runtimeDir, 'node_modules')).sharp} copies)`)
// Until DSH has these changes itself; pinned to the exact files, so another dsh fails here.
for (const { name, state } of patchRuntime(join(runtimeDir, 'node_modules'), join(APP, 'runtime', 'patches'))) say(`runtime patch: ${name} ${state}`)
// Cmd+W reaches the client's `page.close` command by its key (src/pane-close.js). A DSH that
// renames or rebinds it fails here, when it is pinned, instead of shipping a Cmd+W that does nothing.
const closeMismatch = pageCloseMismatch(readFileSync(join(runtimeDir, 'node_modules', ...PAGE_CLOSE_SOURCE.package.split('/'), PAGE_CLOSE_SOURCE.file), 'utf8'))
if (closeMismatch.length > 0) throw new Error(`${PAGE_CLOSE_SOURCE.package} no longer shows the page.close contract Cmd+W sends (src/pane-close.js): ${closeMismatch.join('; ')}`)

// DSH's own packages keep their typings and READMEs: its plugin-development skill reads them.
const ownDocs = name => name.startsWith('@deepseek-ai/')
const mib = bytes => `${(bytes / 1048576).toFixed(1)} MiB`
const runtimePruned = pruneNodeModules(join(runtimeDir, 'node_modules'), { keepDocsOf: ownDocs })
say(`left out of the runtime: ${runtimePruned.files} files, ${mib(runtimePruned.bytes)}`)

say(`packing ${Object.keys(PLUGINS).join(', ')}`)
const packs = join(BUILD, 'packs')
rmSync(packs, { recursive: true, force: true })
mkdirSync(packs, { recursive: true })
const packed = Object.entries(PLUGINS).map(([name, { dir, version, upTo }]) => {
  const [info] = JSON.parse(npm(['pack', '--json', '--pack-destination', packs], { cwd: dir, env, encoding: 'utf8' }))
  if (info.name !== name) throw new Error(`${dir} packs ${info.name}, not ${name}`)
  if (upTo ? !(compareVersions(info.version, version) <= 0) : info.version !== version) {
    throw new Error(`${name} is ${info.version}, not ${upTo ? 'at or below ' : ''}${version}`)
  }
  return { name, version: info.version, tarball: join(packs, info.filename) }
})

// The profile is installed the way DSH installs any plugin: the pinned dsh's own
// `dsh plugin --profile omni install` (pnpm, hoisted, no install scripts) in a scratch DSH
// home, with the runtime's pinned pnpm first on PATH. The result, pnpm's lockfile with it,
// is the profile the app ships, so a plugin added later from the market lands the same way.
const dshHome = join(BUILD, 'dsh-home')
const installDir = join(dshHome, 'profiles', 'omni')
rmSync(dshHome, { recursive: true, force: true })
mkdirSync(join(installDir, VENDOR), { recursive: true })
const profile = JSON.parse(readFileSync(join(APP, 'profile', 'package.json'), 'utf8'))
// The plugins ship as tarballs the package.json names by file: dsh's pnpm, installing a
// market plugin later, resolves them there, offline (they are not on npm).
for (const plugin of packed) {
  cpSync(plugin.tarball, join(installDir, VENDOR, basename(plugin.tarball)))
  profile.dependencies[plugin.name] = `file:${VENDOR}/${basename(plugin.tarball)}`
}
writeFileSync(join(installDir, 'package.json'), `${JSON.stringify(profile, null, 2)}\n`)
for (const file of ['cordis.patch.yml', 'pnpm-workspace.yaml']) cpSync(join(APP, 'profile', file), join(installDir, file))
say(`installing the profile with dsh plugin (${Object.keys(ADDONS).map(name => `${name}@${ADDONS[name]}`).join(', ') || 'no add-ons'})`)
execFileSync(process.execPath, [join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'plugin', '--profile', 'omni', 'install', '--prod', '--ignore-scripts'], {
  cwd: installDir,
  env: { ...env, DSH_HOME: dshHome, PATH: [join(runtimeDir, 'node_modules', '.bin'), env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') },
  stdio: ['ignore', 'inherit', 'inherit'],
})
for (const [name, version] of Object.entries(ADDONS)) {
  const installed = readJson(join(installDir, 'node_modules', ...name.split('/'), 'package.json')).version
  if (installed !== version) throw new Error(`${name} installed at ${installed}, not the vetted ${version}`)
}
// A version names no build: a pinned commit can carry a development client under the vetted
// version (v3.53.0: an add-on's fork at f6e9158), which DSH refuses, and with it the whole web UI.
const devBuilds = devClientBundles(join(installDir, 'node_modules'), Object.keys(profileDeps))
if (devBuilds.length > 0) throw new Error(`development client bundles (react/jsx-dev-runtime, which DSH's module table does not carry): ${devBuilds.join(', ')}`)
// DSH's own record of the build's install (.plugin-manager) is not part of what ships.
rmSync(join(installDir, '.plugin-manager'), { recursive: true, force: true })
// Nor is this machine's pnpm store, or pnpm's cache of this machine's paths: the app records
// its own store at every launch (src/dsh.js pinProfileStore), and pnpm rebuilds the cache.
scrubBuildPaths(installDir)
const profileDir = join(BUILD, 'profile')
rmSync(profileDir, { recursive: true, force: true })
cpSync(installDir, profileDir, { recursive: true, verbatimSymlinks: true })
// The plugins keep their typings and every .md: a plugin may read its own (a Changelog card).
const profilePruned = pruneNodeModules(join(profileDir, 'node_modules'), { keepDocsOf: name => ownDocs(name) || Object.hasOwn(profileDeps, name), docs: false })
say(`left out of the profile: ${profilePruned.files} files, ${mib(profilePruned.bytes)}`)
rmSync(dshHome, { recursive: true, force: true })

// The app copies the profile into its home again whenever this id changes (src/dsh.js).
writeFileSync(join(profileDir, '.build-id'), `${packed.map(plugin => plugin.version).join('+')}+${new Date().toISOString()}\n`)

const versions = {
  dsh: JSON.parse(readFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version,
  automagik: VERSION,
  omni: OMNI.version,
  plugin: VERSION,
  plugins: Object.fromEntries(packed.map(plugin => [plugin.name, plugin.version])),
  addons: ADDONS,
}
writeFileSync(join(BUILD, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`)
say(`ready: dsh ${versions.dsh}, ${packed.map(plugin => `${plugin.name} ${plugin.version}`).join(', ')}`)
