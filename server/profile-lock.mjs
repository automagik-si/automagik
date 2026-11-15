// Preserve workspace-added plugins while replacing only the image's three dependencies.
// No resolution runs here: the combined lock retains exact package resolutions from the
// installed workspace and the verified image. DSH validates/installs it frozen and offline.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { PLUGINS } from './plugin-payload.mjs'

export const readLock = profile => parse(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'))
const manifest = profile => JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))

export function mergeImageProfile({ source, target }) {
  const image = manifest(source), current = manifest(target)
  const imageLock = readLock(source), currentLock = readLock(target)
  for (const lock of [imageLock, currentLock]) {
    if (String(lock.lockfileVersion) !== '9.0' || Object.keys(lock.importers ?? {}).join() !== '.' || !lock.importers['.'].dependencies || !lock.packages || !lock.snapshots) {
      throw new Error('Unsupported image profile lock')
    }
  }
  // Peer contexts encode the image package's file spec in both snapshot keys and
  // dependency values. Rewrite those references as well as the root importer.
  const replacements = PLUGINS.map(name => [current.dependencies[name], image.dependencies[name]])
  const rewrite = value => {
    if (typeof value === 'string') {
      for (const [before, after] of replacements) value = value.replaceAll(before, after)
      return value
    }
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [rewrite(key), rewrite(entry)]))
    return value
  }
  const lock = rewrite(currentLock)
  for (const name of PLUGINS) {
    if (!imageLock.importers['.'].dependencies[name]) throw new Error('Missing image dependency lock')
    lock.importers['.'].dependencies[name] = imageLock.importers['.'].dependencies[name]
  }
  lock.packages = { ...lock.packages, ...imageLock.packages }
  lock.snapshots = { ...lock.snapshots, ...imageLock.snapshots }
  image.dependencies = { ...current.dependencies, ...image.dependencies }
  image.dsh.profile.bundles.push(...current.dsh.profile.bundles.filter(name => !image.dsh.profile.bundles.includes(name)))
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(image, null, 2)}\n`)
  return lock
}
