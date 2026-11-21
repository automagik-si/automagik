import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEGACY_PLUGINS } from '../../profile-state.mjs'
import { updateStoreOf } from '../../profile-update.mjs'

export function installSignedProfile(profile, version, { commit = true } = {}) {
  const file = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const names = [...LEGACY_PLUGINS, '@automagik/locale-pt-br-dsh', '@automagik/vault-dsh']
    .filter(name => Object.hasOwn(manifest.dependencies, name))
  const base = Object.fromEntries(names.map(name => [name, manifest.dependencies[name]]))
  const entries = {}
  mkdirSync(join(profile, 'vendor/automagik-update'), { recursive: true })
  for (const name of names) {
    const sha = createHash('sha256').update(name + version).digest('hex')
    const archive = `vendor/automagik-update/${sha}.tgz`
    entries[name] = manifest.dependencies[name] = `file:${archive}`
    writeFileSync(join(profile, archive), name + version)
    const dir = join(profile, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  writeFileSync(file, JSON.stringify(manifest))
  const store = updateStoreOf(profile), path = join(store, 'current.json')
  mkdirSync(store, { recursive: true })
  const current = { version: 1, live: { version, sequence: 42 }, kept: null, lastSequence: 42, entries, base }
  if (commit) writeFileSync(path, JSON.stringify(current))
  return { current, manifest, store, path }
}
