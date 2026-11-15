#!/usr/bin/env node
// Assemble what the server image carries, in the builder stage:
//
//   out/runtime/   the pinned DeepSeek Harness and the pnpm it installs plugins with
//                  (apps/desktop/runtime/package.json + lock, the desktop's own pins)
//   out/profile/   the automagik-web profile: dsh's base and web app, the Bot team, the
//                  welcome and ACP, installed by dsh's own plugin command from the release
//                  tarballs, with pnpm's store repointed at /data and build-only files gone
//   out/versions.json
//
// The release is pinned by --version (default 3.90.1); every tarball is checked against the
// release's plugins.json and PLUGINS.SHA256SUMS before it is installed. Run it in the image
// builder, where npm and the network exist; the runtime stage carries no package manager but
// the profile's own pnpm.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchPlugins, DEFAULT_PACKAGES } from './fetch-plugins.mjs'
import { readCheckoutPlugins, validateInput, verifyCheckoutDirectory } from './checkout-input.mjs'
import { profileDirOf, PROFILE, pinStore } from './lib.mjs'
import { pruneNodeModules } from '../apps/desktop/scripts/prune-runtime.mjs'
import { patchRuntime } from '../apps/desktop/scripts/runtime-patches.mjs'
import { buildOfflineStore } from './offline-store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
/** Third-party test, example and documentation folders the runtime never reads. */
export const PRUNE_EXTRA_DIR = /^(?:test|tests|__tests__|examples|example|docs|\.yarn)$/
/** A package's test/spec file, wherever it sits (zod's src/v4/classic/tests, node-gyp's *_test.py). */
// A hyphenated "spec" can be runtime code (DSH's install-spec.js), not a test.
export const PRUNE_EXTRA_FILE = /(?:^|[._])(?:test|spec)\.[^.]+$/i
const RUNTIME_SOURCE = join(REPO, 'apps', 'desktop', 'runtime')
const PATCHES_SOURCE = join(RUNTIME_SOURCE, 'patches')
const PROFILE_SOURCE = join(HERE, 'profile')
const ENV = { ...process.env, DO_NOT_TRACK: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' }

const say = (message) => console.log(`[assemble] ${message}`)
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`

function argsOf(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--out', '--version', '--dsh', '--revision', '--repository', '--input-kind', '--event', '--input-manifest'].includes(name)) throw new Error(`unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${name} needs a value`)
    args[name.slice(2)] = value
    index += 1
  }
  return args
}

function run(command, args, options) {
  execFileSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })
}

/**
 * Remove third-party test/example/documentation folders and test files from a node_modules
 * tree. Nothing a runtime imports lives there; it keeps the server image smaller and its
 * secrecy scan about this repository's bytes, not a dependency's fixtures. Nested node_modules
 * are walked as packages, not removed.
 */
export function pruneExtras(nodeModules) {
  const removed = { files: 0, bytes: 0 }
  const count = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) count(full)
      else if (entry.isFile()) {
        removed.files += 1
        removed.bytes += lstatSync(full).size
      }
    }
  }
  const prunePackage = (dir) => {
    let stat
    try { stat = lstatSync(dir) } catch { return }
    if (!stat.isDirectory()) return
    const visit = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            for (const name of readdirSync(full)) {
              if (name.startsWith('.')) continue
              if (name.startsWith('@')) {
                for (const inner of readdirSync(join(full, name))) {
                  if (!inner.startsWith('.')) prunePackage(join(full, name, inner))
                }
              } else prunePackage(join(full, name))
            }
            continue
          }
          if (PRUNE_EXTRA_DIR.test(entry.name)) {
            count(full)
            rmSync(full, { recursive: true, force: true })
            continue
          }
          visit(full)
        } else if (entry.isFile() && PRUNE_EXTRA_FILE.test(entry.name)) {
          removed.files += 1
          removed.bytes += lstatSync(full).size
          rmSync(full)
        }
      }
    }
    visit(dir)
  }
  for (const name of readdirSync(nodeModules)) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      let inner
      try { inner = readdirSync(join(nodeModules, name)) } catch { continue }
      for (const sub of inner) if (!sub.startsWith('.')) prunePackage(join(nodeModules, name, sub))
    } else prunePackage(join(nodeModules, name))
  }
  return removed
}

/**
 * Apply the desktop's carried runtime patches to an installed runtime, logging each file's
 * result. `patchRuntime` checks the dsh version, every package version and every file hash
 * before it writes, and throws on any mismatch, so a patch that no longer fits fails the build.
 * Exported so a test can run it against a temp runtime without assembling the image.
 * @param {string} runtimeDir - the runtime folder whose node_modules is patched
 * @param {string} [patchesDir] - the patches folder; defaults to apps/desktop/runtime/patches
 * @returns {{ name: string, state: 'patched' | 'already patched' }[]}
 */
export function applyRuntimePatches(runtimeDir, patchesDir = PATCHES_SOURCE) {
  const results = patchRuntime(join(runtimeDir, 'node_modules'), patchesDir)
  for (const { name, state } of results) say(`runtime patch: ${name} ${state}`)
  return results
}

export async function assemble({ out, version = '3.90.1', dsh = '0.2.2-rc.2', revision = 'unknown', repository = 'https://github.com/automagik-dev/automagik', kind = 'release', event = '', manifest = '' }) {
  const input = { kind, event, revision, manifest, repository, version }
  const source = validateInput(input)
  if (kind === 'checkout') verifyCheckoutDirectory(join(HERE, 'checkout-input'), input)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a release version: ${version}`)
  const runtimeDir = join(out, 'runtime')
  const dshHome = join(out, 'dsh-home')
  const installDir = profileDirOf(dshHome)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })

  const pinned = readJson(join(RUNTIME_SOURCE, 'package.json')).dependencies?.['@deepseek-ai/dsh']
  if (pinned !== dsh) throw new Error(`apps/desktop/runtime pins dsh ${pinned}, not the image's ${dsh}`)
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(RUNTIME_SOURCE, file), join(runtimeDir, file))
  say(`installing dsh ${dsh} and pnpm`)
  // npm 11.19 gates dependency install scripts behind allowScripts and skips them by default.
  // The runtime needs them: koffi's native module (dsh-subprocess-local, dsh-fs-local) and
  // node-pty's spawn helper. Every package is pinned by the desktop's lock, so the scripts it
  // names are the ones the desktop build runs.
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--dangerously-allow-all-scripts'], { cwd: runtimeDir, env: ENV })
  const installedDsh = readJson(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).version
  if (installedDsh !== dsh) throw new Error(`runtime installed dsh ${installedDsh}, not ${dsh}`)

  // The same carried patches the desktop runtime applies, to the same pinned packages: this
  // image serves the web app, so the index cache policy is the one the desktop's patch sets.
  applyRuntimePatches(runtimeDir)

  say(`fetching ${DEFAULT_PACKAGES.join(', ')} at ${version}`)
  mkdirSync(installDir, { recursive: true })
  const fetched = kind === 'checkout'
    ? readCheckoutPlugins({ ...input, out: join(installDir, 'vendor') })
    : await fetchPlugins({ version, out: join(installDir, 'vendor'), repository })
  const profile = readJson(join(PROFILE_SOURCE, 'package.json'))
  for (const name of DEFAULT_PACKAGES) profile.dependencies[name] = `file:vendor/${fetched.plugins[name].file}`
  writeFileSync(join(installDir, 'package.json'), `${JSON.stringify(profile, null, 2)}\n`)
  for (const file of ['cordis.patch.yml', 'pnpm-workspace.yaml']) cpSync(join(PROFILE_SOURCE, file), join(installDir, file))
  pinStore(installDir, dshHome)

  say('installing the profile with dsh plugin')
  const path = [join(runtimeDir, 'node_modules', '.bin'), ENV.PATH].filter(Boolean).join(':')
  run(process.execPath, [join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'plugin', '--profile', PROFILE, 'install', '--prod', '--ignore-scripts'], {
    cwd: installDir,
    env: { ...ENV, DSH_HOME: dshHome, PATH: path },
  })

  for (const name of DEFAULT_PACKAGES) {
    const installed = readJson(join(installDir, 'node_modules', ...name.split('/'), 'package.json')).version
    if (installed !== version) throw new Error(`${name} installed at ${installed}, not the release's ${version}`)
  }

  // DSH's record of this build's install is not part of what ships; the profile is seeded at
  // the first start, not installed there.
  rmSync(join(installDir, '.plugin-manager'), { recursive: true, force: true })
  pinStore(installDir, '/data/dsh')

  // What the web profile never composes (proved by its --dump-config graph): the office
  // conversion wasm, the voice engine, the inspector, the alternate app bundles' optional
  // extras and the other platforms' native prebuilds. npm installs dsh's whole dependency
  // list; the automagik-web tree names none of these entries.
  const PRUNE = [
    // office-kit is a composed entry (libreoffice-kit-wasm included), so its stack stays
    '@deepseek-ai/dsh-experimental-inspector', '@deepseek-ai/dsh-experimental-inspector-profile',
    '@deepseek-ai/dsh-experimental-session-inspector',
    '@deepseek-ai/dsh-experimental-client-ui-forge', '@deepseek-ai/dsh-experimental-forge',
    '@deepseek-ai/dsh-experimental-forge-bundle', '@deepseek-ai/dsh-experimental-forge-github',
    '@deepseek-ai/dsh-experimental-forge-session',
    '@deepseek-ai/dsh-experimental-liveshare', '@deepseek-ai/dsh-experimental-liveshare-protocol',
    '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-badge-skill-bundle',
    '@deepseek-ai/dsh-experimental-cot-translation-bundle', '@deepseek-ai/dsh-experimental-client-ui-cot-translation',
    '@deepseek-ai/dsh-experimental-translator',
    '@deepseek-ai/dsh-experimental-voice-input-bundle', '@deepseek-ai/dsh-experimental-client-ui-voice-input',
    '@deepseek-ai/dsh-experimental-speech-to-text', '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
    '@deepseek-ai/dsh-experimental-api-speech-to-text', 'sherpa-onnx-linux-x64', 'sherpa-onnx-node',
    '@deepseek-ai/dsh-experimental-plugin-market-bundle', '@deepseek-ai/dsh-experimental-ralph-bundle',
    '@deepseek-ai/dsh-experimental-session-search', '@deepseek-ai/dsh-experimental-session-titles-bundle',
    '@deepseek-ai/dsh-experimental-terminal-bundle', '@deepseek-ai/dsh-experimental-tool-worktree',
    '@deepseek-ai/dsh-experimental-worktree',
    '@img/sharp-libvips-linuxmusl-x64', '@img/sharp-linuxmusl-x64',
    'node-pty/prebuilds/win32-arm64', 'node-pty/prebuilds/win32-x64',
    'node-pty/prebuilds/darwin-arm64', 'node-pty/prebuilds/darwin-x64', 'node-pty/prebuilds/linux-arm64',
    // The server image is glibc Linux: the musl native addon and pnpm's non-Linux reflink
    // binaries are never loaded there.
    'node-addon-require-builtin-linux-x64-musl',
    'pnpm/dist/reflink.darwin-arm64-2HJ4WGO6.node',
    'pnpm/dist/reflink.darwin-x64-3G3H6IW4.node',
    'pnpm/dist/reflink.win32-arm64-msvc-Q6BARPPB.node',
    'pnpm/dist/reflink.win32-x64-msvc-J2TZHRQI.node',
  ]
  for (const name of PRUNE) rmSync(join(runtimeDir, 'node_modules', name), { recursive: true, force: true })

  say('pruning what the runtime and the profile nothing read')
  const runtimePruned = pruneNodeModules(join(runtimeDir, 'node_modules'), { keepDocsOf: (name) => name.startsWith('@deepseek-ai/') })
  const profilePruned = pruneNodeModules(join(installDir, 'node_modules'), {
    keepDocsOf: (name) => name.startsWith('@deepseek-ai/') || DEFAULT_PACKAGES.includes(name),
    docs: false,
  })
  say(`runtime: left out ${runtimePruned.files} files, ${mib(runtimePruned.bytes)}`)
  say(`profile: left out ${profilePruned.files} files, ${mib(profilePruned.bytes)}`)
  const runtimeExtras = pruneExtras(join(runtimeDir, 'node_modules'))
  const profileExtras = pruneExtras(join(installDir, 'node_modules'))
  say(`runtime: left out ${runtimeExtras.files} test/example files, ${mib(runtimeExtras.bytes)}`)
  say(`profile: left out ${profileExtras.files} test/example files, ${mib(profileExtras.bytes)}`)
  const offline = buildOfflineStore({ store: join(dshHome, 'pnpm-store'), profile: installDir,
    out: join(out, 'offline-store'), excludeNames: DEFAULT_PACKAGES })
  say(`offline store: ${offline.packages} inspected dependency packages; plugin inputs materialize from scanned profile files`)
  // The tarballs were verified and installed; the image does not carry them (or an archive the
  // secrecy scan would have to excuse). The profile's node_modules is the installed result.
  rmSync(join(installDir, 'vendor'), { recursive: true, force: true })

  cpSync(installDir, join(out, 'profile'), { recursive: true, verbatimSymlinks: true })
  rmSync(dshHome, { recursive: true, force: true })
  writeFileSync(join(out, 'versions.json'), `${JSON.stringify({
    automagik: version,
    revision,
    source,
    dsh: installedDsh,
    profile: PROFILE,
    plugins: Object.fromEntries(DEFAULT_PACKAGES.map((name) => [name, version])),
  }, null, 2)}\n`)
  return { out, version, dsh: installedDsh, runtime: runtimeDir }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argsOf(process.argv.slice(2))
    if (!args.out) throw new Error('usage: node assemble.mjs --out <dir> [--version 3.90.1] [--dsh 0.2.2-rc.2] [--repository <url>]')
    const result = await assemble({ out: resolve(args.out), version: args.version, dsh: args.dsh, revision: args.revision, repository: args.repository, kind: args['input-kind'], event: args.event, manifest: args['input-manifest'] })
    console.log(`[assemble] ready: dsh ${result.dsh}, automagik ${result.version}`)
  } catch (error) {
    console.error(`assemble: ${error?.stack ?? error}`)
    process.exit(1)
  }
}
