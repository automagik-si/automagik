// Builds client.js, the browser half, from the modules in src/client.
//
//   node scripts/build-client.mjs           writes client.js
//   node scripts/build-client.mjs --check   exits 1 when client.js differs from a fresh build
//
// client.js is committed, so `link:` and git installs need no build step. dsh loads it as
// a classic script; the wrapper mirrors packages/client/tsdown.client.ts in
// deepseek-harness: `require` resolves the shell-seeded platform modules (react,
// react-dom, ui-primitives, ...), which therefore stay external.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// DSH's client loader matches a bundle's id to the npm package that ships it.
const PACKAGE_NAME = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')).name
const OUTPUT = join(PLUGIN, 'client.js')
// The name this package had before it moved to Automagik. Plugins built before the rename
// (Omni's channels and canvases up to 2.261023.x) import the team's client as
// `@automagik/omni-dsh/client`, and DSH's module table is keyed by package name, so this
// bundle also registers under that name a factory that hands over this very module: one
// dictionary, one roster, one set of registries, whichever name a plugin imports.
export const FORMER_NAME = '@automagik/omni-dsh'
export const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

export async function bundleClient() {
  const result = await build({
    // Region comments name sources relative to the plugin, wherever the script runs from.
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/index.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    // Every source declaration ships, used or not, as in the hand-written bundle.
    treeShaking: false,
    // Readable for debugging in the browser: no minification, and Chinese text stays text.
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return [
    '// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    `  id: '${PACKAGE_NAME}',`,
    '  factory: (require) => {',
    // The renderer's chunk is fetched only when the Code face first renders (code-side.js).
    'globalThis.__dshChunk = (name) => require.async(name)',
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    // The loader gets a plain exports object tagged as a module, as the tsdown preset
    // emits, rather than esbuild's getter-based `__esModule` object.
    'return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: \'Module\' })',
    '  },',
    '})',
    // A second registration of the same name (the bundle run again, a reload) is DSH's to
    // refuse; the first one stays and keeps answering.
    `try { window.__ModuleLoader__.load({ id: '${FORMER_NAME}', factory: (require) => require('${PACKAGE_NAME}/client') }) } catch {}`,
    '',
  ].join('\n')
}

const PANE_OUTPUT = join(PLUGIN, 'client.pane.js')
const PANE_NAME = 'client.pane.js'
const GATED_NAME = 'client.gated.js'
const GATED_OUTPUT = join(PLUGIN, GATED_NAME)

// The gated surfaces use the main bundle's UI and viewer guard in the same document.
export async function bundleGated() {
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/gated-client.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    plugins: [{
      name: 'gated-shared',
      setup(build) {
        build.onResolve({ filter: /^\.\/gated-shared\.js$/ }, ({ path }) => ({ path, external: true }))
      },
    }],
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return [
    '// Generated from src/client/gated-client.js by scripts/build-client.mjs. Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    `  id: '${PACKAGE_NAME}',`,
    `  chunk: '${GATED_NAME}',`,
    '  factory: (platformRequire) => ({',
    '    initialize: (shared) => {',
    "const require = (name) => name === './gated-shared.js' ? shared : platformRequire(name)",
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    'return module.exports',
    '    },',
    '  }),',
    '})',
    '',
  ].join('\n')
}

/**
 * The Code side's renderer as its own package-local chunk: the DSH module loader keeps it out
 * of client.js and fetches it the first time the view's Terminal face renders. The chunk
 * registers under the same package id with `chunk`, as DSH's own sidebar terminal does.
 */
export async function bundlePane() {
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/code-side-pane.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    // xterm's stylesheet joins the chunk as text, so it loads with the renderer, not before.
    loader: { '.css': 'text' },
    treeShaking: false,
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return [
    '// Generated from src/client/code-side-pane.js by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    `  id: '${PACKAGE_NAME}',`,
    `  chunk: '${PANE_NAME}',`,
    '  factory: (require) => {',
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    'return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: \'Module\' })',
    '  },',
    '})',
    '',
  ].join('\n')
}

const OFFICE_OUTPUT = join(PLUGIN, 'office.js')

export async function bundleOffice() {
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/office/cli.js'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
    banner: {
      js: '#!/usr/bin/env node\n// Generated from src/office by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    },
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return result.outputFiles[0].text
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleClient()
  const pane = await bundlePane()
  const gated = await bundleGated()
  const office = await bundleOffice()
  if (process.argv.includes('--check')) {
    let current = null, currentPane = null, currentOffice = null, currentGated = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    try { currentPane = readFileSync(PANE_OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    try { currentGated = readFileSync(GATED_OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    try { currentOffice = readFileSync(OFFICE_OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== next || currentPane !== pane || currentGated !== gated || currentOffice !== office) {
      console.error('client.js, client.pane.js, client.gated.js or office.js is stale: run `bun run build` in apps/bots-dsh and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
    writeFileSync(PANE_OUTPUT, pane)
    writeFileSync(GATED_OUTPUT, gated)
    writeFileSync(OFFICE_OUTPUT, office)
  }
}
