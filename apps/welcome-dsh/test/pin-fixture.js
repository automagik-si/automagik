// The Omni and Genie pins, fixed for a test. bot-types.js and omni-github.js read the pins from
// package.json as they load, and follow-omni.yml moves the real Omni pin with every Omni
// release: a test that decides between a pin and a lane must hold whatever the real pin is.
// Importing this file answers that one read, in those two modules alone, with package.json
// carrying the pins below. A module that is already loaded keeps the real pins, so import this
// first and load the code under test with `await import()`.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

export const OMNI_PIN = Object.freeze({
  repository: 'https://github.com/automagik-si/omni',
  version: '2.261120.2',
  commit: 'c'.repeat(40),
  tree: 'd'.repeat(40),
})
export const GENIE_PIN = Object.freeze({
  repository: 'https://github.com/automagik-si/genie',
  path: 'plugins/genie-dsh',
  version: '0.1.4',
  commit: 'e'.repeat(40),
})

const manifest = new URL('../package.json', import.meta.url)
const readers = ['bot-types.js', 'omni-github.js'].map(file => new URL(`../src/host/${file}`, import.meta.url).href)
const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
const pinned = JSON.stringify({ ...pkg, automagik: { ...pkg.automagik, omni: OMNI_PIN, genie: GENIE_PIN } })

// The readers' node:fs: the real one, except for package.json.
const fs = `data:text/javascript,${encodeURIComponent(`
import { readFileSync as read } from 'node:fs'
export * from 'node:fs'
export const readFileSync = (path, ...rest) => (path instanceof URL && path.href === ${JSON.stringify(manifest.href)}
  ? ${JSON.stringify(pinned)}
  : read(path, ...rest))
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:fs' && readers.includes(context.parentURL)) return { url: fs, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
