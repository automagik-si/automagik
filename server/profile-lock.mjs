// Preserve workspace-added plugins while replacing only the image's base dependencies.
// No resolution runs here: the combined lock retains exact package resolutions from the
// installed workspace and the verified image. DSH validates/installs it frozen and offline.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { PLUGINS, vendorRelease } from './profile-state.mjs'

export function readLock(profile) {
  const file = join(profile, 'pnpm-lock.yaml')
  if (!lstatSync(file).isFile()) throw new Error('Unsupported image profile lock file')
  return parse(readFileSync(file, 'utf8'))
}
function manifest(profile) {
  const file = join(profile, 'package.json')
  if (!lstatSync(file).isFile()) throw new Error('Unsupported image profile manifest file')
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function mergeImageProfile({ source, target, base = PLUGINS }) {
  const image = manifest(source), current = manifest(target)
  const imageLock = readLock(source), currentLock = readLock(target)
  for (const lock of [imageLock, currentLock]) {
    if (String(lock.lockfileVersion) !== '9.0' || Object.keys(lock.importers ?? {}).join() !== '.' || !lock.importers['.'].dependencies || !lock.packages || !lock.snapshots) {
      throw new Error('Unsupported image profile lock')
    }
  }
  // Peer contexts encode the image package's file spec in both snapshot keys and
  // dependency values. Rewrite those references as well as the root importer.
  const replacements = new Map(base.filter(name => vendorRelease(name, current.dependencies[name]))
    .map(name => [current.dependencies[name], image.dependencies[name]]))
  const specs = [...replacements.keys()].map(RegExp.escape).join('|')
  const identities = new RegExp(`((?:^|\\()(?:@[\\w.-]+/)?[\\w.-]+@)(${specs})(?=$|[()])`, 'g')
  const rewrite = value => {
    if (typeof value === 'string') return replacements.get(value) ??
      (replacements.size ? value.replace(identities, (_, prefix, spec) => prefix + replacements.get(spec)) : value)
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
  for (const [name, spec] of Object.entries(current.dependencies)) {
    if (!Object.hasOwn(image.dependencies, name)) image.dependencies[name] = spec
  }
  image.dsh.profile.bundles.push(...current.dsh.profile.bundles.filter(name => !image.dsh.profile.bundles.includes(name)))
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(image, null, 2)}\n`)
  return lock
}
