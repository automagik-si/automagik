// What the app ships but nothing reads, left out of build/runtime and build/profile
// (prepare-runtime runs this). Every shipped file costs the update: macOS verifies the
// signature of each one before an update relaunches the app. Removed:
//
//   source maps (*.js.map, *.d.ts.map, *.css.map, ...)   Node runs without them; DSH serves
//       a plugin's map to DevTools only when one exists (dsh-client-modules: ENOENT is no map)
//   TypeScript sources under src/ of a package that ships lib/ or dist/   Node does not run
//       TypeScript from node_modules; kept when the package's entry points name src/
//   typings (*.d.ts, *.d.mts, *.d.cts)                     only an editor reads them
//   a package's README, CHANGELOG and HISTORY (.md)         runtime only: plugins in the
//       profile read their own (a plugin's Changelog card reads its CHANGELOG.md)
//
// DSH's own packages and the profile's plugins keep their typings and READMEs: DSH's
// plugin-development skill (dsh-agent-preset, cordis-plugin-development) reads
// `<packageDir>/README.md` and `lib/types/**/*.d.ts` of installed packages. No .md other
// than a package's top-level README/CHANGELOG/HISTORY is touched (skills are .md files).
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'

/** Desktop only: force sharp's wasm fallback, including when reusing an installed tree.
 * Keep this separate from the generic pruner: the server still selects native sharp.
 */
export function prepareSharpWasm(nodeModules) {
  const root = resolve(nodeModules)
  if (!lstatSync(root).isDirectory()) throw new Error(`sharp runtime must be a directory: ${root}`)
  const realRoot = realpathSync(root)
  const inside = file => {
    const path = relative(realRoot, realpathSync(file))
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error(`sharp dependency resolves outside runtime: ${file}`)
    }
    return file
  }
  const sharpDirs = []
  const forbidden = []
  // Walk physical directories only, including nested package-manager stores. Never follow
  // directory links; reject links hiding a sharp tree rather than mutate their targets.
  const scan = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (basename(dir) === '@img' && basename(dirname(dir)) === 'node_modules' &&
          entry.name.startsWith('sharp-') && entry.name !== 'sharp-wasm32') {
        forbidden.push(full)
        continue
      }
      const sharp = basename(dir) === 'node_modules' && entry.name === 'sharp'
      if (entry.isSymbolicLink() && (sharp || entry.name === 'node_modules' ||
          (basename(dir) === 'node_modules' && entry.name === '@img'))) {
        throw new Error(`cannot verify linked sharp tree: ${full}`)
      }
      if (!entry.isDirectory()) continue
      if (sharp) sharpDirs.push(full)
      scan(full)
    }
  }
  scan(root)
  if (!sharpDirs.length) throw new Error(`missing sharp in ${root}`)
  // Validate every sharp copy before removing anything. Resolution must match its loader,
  // not merely find an unrelated wasm package somewhere else in the tree.
  for (const dir of sharpDirs) {
    const manifest = JSON.parse(readFileSync(inside(join(dir, 'package.json')), 'utf8'))
    const require = createRequire(join(dir, 'package.json'))
    const wasmFile = inside(require.resolve('@img/sharp-wasm32/package'))
    const wasm = JSON.parse(readFileSync(wasmFile, 'utf8'))
    if (manifest.name !== 'sharp' || wasm.name !== '@img/sharp-wasm32' ||
        !manifest.version || manifest.version !== wasm.version) {
      throw new Error(`sharp/wasm version mismatch at ${dir}: ${manifest.version} / ${wasm.version}`)
    }
    // A manifest alone cannot satisfy preparation: require the binding and wasm payload.
    inside(require.resolve('@img/sharp-wasm32/sharp.node'))
    inside(join(dirname(wasmFile), 'lib', `sharp-wasm32-${wasm.version}.node.js`))
    inside(join(dirname(wasmFile), 'lib', `sharp-wasm32-${wasm.version}.node.wasm`))
    for (const local of ['build', 'src/build']) {
      // A symlinked src must not let removal escape the runtime.
      if (local.startsWith('src/') && lstatSync(join(dir, 'src'), { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`cannot verify linked sharp source: ${dir}`)
      }
      forbidden.push(join(dir, local))
    }
  }
  for (const path of forbidden) rmSync(path, { recursive: true, force: true })
  for (const path of forbidden) {
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`native sharp remains: ${path}`)
  }
  return { sharp: sharpDirs.length }
}

const MAP = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|css)\.map$/
const TYPINGS = /\.d\.[cm]?ts$/
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/
const DOCS = /^(?:readme|changelog|history)\.md$/i
// package.json fields that name files Node (or a bundler) loads.
const ENTRY_FIELDS = ['main', 'module', 'browser', 'bin', 'exports', 'imports']

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Whether a package's entry points name anything under src/. */
export function entriesNameSrc(manifest) {
  const entries = JSON.stringify(ENTRY_FIELDS.map(field => manifest?.[field] ?? null))
  return /(?:^|["/.])src\//.test(entries)
}

/**
 * What to remove from one package, by its path inside the package ('lib/index.js.map').
 * `keepDocs`: the package keeps its typings and README (DSH's own, a profile plugin).
 * `docs`: top-level README/CHANGELOG/HISTORY may go (the runtime, not the profile).
 */
export function prunable(path, { srcIsSource = false, keepDocs = false, docs = true } = {}) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (MAP.test(name)) return true
  if (TYPINGS.test(name)) return !keepDocs
  if (srcIsSource && path.startsWith('src/') && TS_SOURCE.test(name)) return true
  if (docs && !keepDocs && !path.includes('/') && DOCS.test(name)) return true
  return false
}

// The packages of a node_modules folder, scoped ones as @scope/name; .bin and package
// managers' dot folders are not packages.
function packagesIn(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter(name => !name.startsWith('.')).flatMap((name) => {
    if (!name.startsWith('@')) return [name]
    try {
      return readdirSync(join(dir, name)).filter(inner => !inner.startsWith('.')).map(inner => `${name}/${inner}`)
    } catch {
      return []
    }
  })
}

/**
 * Remove what nothing reads from every package under `nodeModules`, nested node_modules
 * included. Only regular files go; symlinks and folders stay. `keepDocsOf(name)` names the
 * packages that keep their typings and README. Returns { files, bytes } removed.
 */
export function pruneNodeModules(nodeModules, { keepDocsOf = () => false, docs = true } = {}) {
  const removed = { files: 0, bytes: 0 }
  const prunePackage = (dir, name) => {
    let stat
    try {
      stat = lstatSync(dir)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    const manifest = readJson(join(dir, 'package.json'))
    const has = sub => lstatSync(join(dir, sub), { throwIfNoEntry: false })?.isDirectory() === true
    const options = {
      srcIsSource: manifest !== null && (has('lib') || has('dist')) && has('src') && !entriesNameSrc(manifest),
      keepDocs: keepDocsOf(name),
      docs,
    }
    const walk = (folder, prefix) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name)
        const path = `${prefix}${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            for (const inner of packagesIn(full)) prunePackage(join(full, inner), inner)
          } else {
            walk(full, `${path}/`)
          }
        } else if (entry.isFile() && prunable(path, options)) {
          removed.bytes += lstatSync(full).size
          removed.files++
          rmSync(full)
        }
      }
    }
    walk(dir, '')
  }
  for (const name of packagesIn(nodeModules)) prunePackage(join(nodeModules, name), name)
  return removed
}
