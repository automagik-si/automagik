// Build-only PR inputs. No URL/path override and no release fallback.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PACKAGES, sumOf, verifyTarball } from './fetch-plugins.mjs'

export const CHECKOUT_REPOSITORY = 'https://github.com/automagik-si/automagik'
export const CHECKOUT_PACKAGES = Object.freeze({
  '@automagik/acp-dsh': 'apps/acp-dsh',
  '@automagik/bots-dsh': 'apps/bots-dsh',
  '@automagik/locale-pt-br-dsh': 'apps/locale-pt-br-dsh',
  '@automagik/welcome-dsh': 'apps/welcome-dsh',
})
export const CHILD = 'apps/bots-dsh/src/host/browser/script-child.js'
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const checkoutFile = (name, version) => `${name.slice(1).replace('/', '-')}-${version}.tgz`

export function validateInput({ kind = 'release', event = '', revision = '', manifest = '', repository, version }) {
  if (event && !['pull_request', 'push', 'release', 'workflow_dispatch'].includes(event)) throw new Error('unknown input event')
  if (kind === 'release') {
    if (event === 'pull_request' || manifest) throw new Error('release input contradicts checkout arguments')
  } else if (kind === 'checkout') {
    if (event !== 'pull_request' || !/^[0-9a-f]{40}$/.test(revision) || !/^[0-9a-f]{64}$/.test(manifest)) {
      throw new Error('checkout input requires pull_request, full revision and manifest digest')
    }
    if (repository !== CHECKOUT_REPOSITORY) throw new Error('checkout repository is fixed')
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid checkout version')
  } else throw new Error('unknown input kind')
  return { kind, ...(kind === 'checkout' ? { revision, manifest } : {}) }
}

// Check every ancestor, not just the final entry. The production caller cannot choose a path.
export function regularPath(path, directory = false) {
  const absolute = resolve(path)
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error('input ancestry must be direct directories')
    if (parent === dirname(parent)) break
  }
  const stat = lstatSync(absolute)
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('input must be a direct regular file/directory')
}

// Exported for fixtures; only readCheckoutPlugins selects the production directory.
export function verifyCheckoutDirectory(dir, options) {
  validateInput(options)
  if (options.kind !== 'checkout') throw new Error('local inputs require checkout mode')
  regularPath(dir, true)
  const { version, revision, manifest } = options
  const names = Object.keys(CHECKOUT_PACKAGES)
  const files = names.map((name) => checkoutFile(name, version))
  const expected = ['plugins.json', 'PLUGINS.SHA256SUMS', ...files].sort()
  if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify(expected)) throw new Error('unexpected checkout asset set')
  const assets = new Map(expected.map((file) => {
    const path = join(dir, file)
    regularPath(path)
    return [file, readFileSync(path)]
  }))
  const raw = assets.get('plugins.json')
  if (sha256(raw) !== manifest) throw new Error('independent manifest digest mismatch')
  const sums = assets.get('PLUGINS.SHA256SUMS').toString('utf8')
  const entries = sums.trimEnd().split('\n').map((line) => {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line)
    if (!match) throw new Error('invalid checksum entry')
    return match[2]
  })
  if (JSON.stringify(entries.sort()) !== JSON.stringify(['plugins.json', ...files].sort())) throw new Error('checksum identities must be unique and complete')
  if (sumOf(sums, 'plugins.json') !== manifest) throw new Error('manifest checksum mismatch')
  const plugins = JSON.parse(raw)
  if (raw.toString('utf8') !== `${JSON.stringify(plugins, null, 2)}\n`) throw new Error('manifest must be canonical, without duplicate identities')
  if (plugins.repository !== CHECKOUT_REPOSITORY || plugins.version !== version || plugins.commit !== revision) throw new Error('checkout manifest identity mismatch')
  if (JSON.stringify(Object.keys(plugins.packages ?? {}).sort()) !== JSON.stringify(names)) throw new Error('checkout package identities mismatch')
  const fetched = {}
  for (const name of names) {
    const entry = plugins.packages[name]
    if (entry.version !== version || entry.file !== checkoutFile(name, version) || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('checkout package identity/size mismatch')
    const digest = verifyTarball(assets.get(entry.file), entry, sumOf(sums, entry.file))
    if (DEFAULT_PACKAGES.includes(name)) fetched[name] = { file: entry.file, version, size: entry.size, sha256: digest }
  }
  return { version, plugins: fetched, assets }
}

export function readCheckoutPlugins(options) {
  const result = verifyCheckoutDirectory(fileURLToPath(new URL('./checkout-input/', import.meta.url)), options)
  mkdirSync(options.out, { recursive: true })
  for (const entry of Object.values(result.plugins)) writeFileSync(join(options.out, entry.file), result.assets.get(entry.file), { mode: 0o644 })
  return { version: result.version, plugins: result.plugins }
}
