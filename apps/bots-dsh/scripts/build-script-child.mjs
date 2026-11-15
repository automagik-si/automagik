// Builds src/host/browser/script-child.js, the process a browser_exec script runs in, from
// src/script-child and the QuickJS interpreter (WebAssembly, inside its package's module).
//
//   node scripts/build-script-child.mjs           writes script-child.js
//   node scripts/build-script-child.mjs --check   exits 1 when it differs from a fresh build
//   node scripts/build-script-child.mjs --pin     rewrites src/script-child/pins.json
//
// The result is committed, and it is one file: the process runs under Node's permission
// model with nothing granted, so its entry is the only file it may read.
//
// The interpreter is pinned twice. package.json names exact versions and bun.lock holds
// their package hashes; src/script-child/pins.json holds the sha256 of every file of
// those packages that goes into the build. A build with a file that is not pinned, or
// whose bytes differ, fails: taking a new version is `--pin`, a reviewed change.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'src', 'host', 'browser', 'script-child.js')
const PINS = join(PLUGIN, 'src', 'script-child', 'pins.json')
const MODULES = 'node_modules/'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const ENGINE = join(PLUGIN, MODULES, '@jitl/quickjs-singlefile-mjs-release-sync', 'dist/emscripten-module-Q67P5WYC.mjs')
const ENGINE_SHA256 = '931aa7ba3694b7a0469c8e6df620e25692302c13b87d758d427203a2ebdad192'
const HOME_DEFAULT = `HOME:"${['', 'home', 'web_user'].join('/')}"`
const HOME_CONTEXT = `USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",${HOME_DEFAULT},LANG:`

// Change only Emscripten's virtual default, never its override loop or embedded WASM.
// Check structure as well as original bytes; a package update needs a fresh review.
export function prepareQuickjsSource(bytes) {
  const source = bytes.toString('utf8')
  if (source.split(HOME_CONTEXT).length !== 2 || source.split(HOME_DEFAULT).length !== 2) {
    throw new Error('QuickJS must contain exactly one expected virtual HOME default context')
  }
  if (sha256(bytes) !== ENGINE_SHA256) throw new Error('QuickJS original source SHA-256 differs from the reviewed engine')
  return source.replace(HOME_CONTEXT, HOME_CONTEXT.replace(HOME_DEFAULT, 'HOME:"/"'))
}

export function quickjsVirtualHomePlugin() {
  let loads = 0
  return {
    name: 'quickjs-virtual-home',
    setup(builder) {
      builder.onLoad({ filter: /emscripten-module-.*\.mjs$/, namespace: 'file' }, ({ path }) => {
        if (path !== ENGINE) throw new Error('Unexpected QuickJS engine hook target')
        if (++loads !== 1) throw new Error('QuickJS engine hook must run exactly once')
        return { contents: prepareQuickjsSource(readFileSync(path)), loader: 'js', resolveDir: dirname(path) }
      })
      builder.onEnd(() => {
        if (loads !== 1) return { errors: [{ text: 'QuickJS engine hook must run exactly once' }] }
      })
    },
  }
}

// { text, pins }: the file's text, and what it took from node_modules as { package: {
// version, files: { path: sha256 } } }.
export async function bundleScriptChild() {
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/script-child/main.js'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    charset: 'ascii',
    plugins: [quickjsVirtualHomePlugin()],
    metafile: true,
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  const pins = {}
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    if (!input.startsWith(MODULES)) continue
    const parts = input.slice(MODULES.length).split('/')
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
    const { version } = JSON.parse(readFileSync(join(PLUGIN, MODULES, name, 'package.json'), 'utf8'))
    pins[name] ??= { version, files: {} }
    pins[name].files[input.slice(MODULES.length + name.length + 1)] = sha256(readFileSync(join(PLUGIN, input)))
  }
  const text = [
    '// Generated from src/script-child by `npm run build` (scripts/build-script-child.mjs). Do not edit by hand.',
    '// Holds QuickJS and quickjs-emscripten, both under the MIT License: see NOTICE.',
    result.outputFiles[0].text.trimEnd(),
    '',
  ].join('\n')
  return { text, pins }
}

export const readPins = () => JSON.parse(readFileSync(PINS, 'utf8'))

// What differs between the pinned files and the ones a build took, one line each.
export function pinDifferences(pinned, built) {
  const lines = []
  for (const name of new Set([...Object.keys(pinned), ...Object.keys(built)])) {
    const was = pinned[name]
    const now = built[name]
    if (!was || !now) {
      lines.push(`${name}: ${was ? 'pinned but not in the build' : 'in the build but not pinned'}`)
      continue
    }
    if (was.version !== now.version) lines.push(`${name}: version ${now.version}, pinned ${was.version}`)
    for (const file of new Set([...Object.keys(was.files), ...Object.keys(now.files)])) {
      if (was.files[file] !== now.files[file]) lines.push(`${name}/${file}: ${now.files[file] ?? 'not in the build'}, pinned ${was.files[file] ?? 'nothing'}`)
    }
  }
  return lines
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { text, pins } = await bundleScriptChild()
  if (process.argv.includes('--pin')) {
    writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`)
    console.log(`pinned ${Object.keys(pins).length} packages in src/script-child/pins.json`)
  }
  const differences = pinDifferences(readPins(), pins)
  if (differences.length > 0) {
    console.error(`the interpreter's files are not the pinned ones (src/script-child/pins.json):\n${differences.join('\n')}`)
    process.exit(1)
  }
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== text) {
      console.error('src/host/browser/script-child.js is stale: run `npm run build` in apps/bots-dsh and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, text)
    console.log(`wrote src/host/browser/script-child.js (${text.length} characters)`)
  }
}
