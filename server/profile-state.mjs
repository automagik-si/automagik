import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const ADAPTER = '@automagik/multiuser-dsh'
export const ADAPTER_SINCE = '3.160.6'
export const BOTS_GUARD_SINCE = '3.161.3'
export const LEGACY_PLUGINS = ['@automagik/acp-dsh', '@automagik/bots-dsh', '@automagik/welcome-dsh']

export const PLUGINS = [...LEGACY_PLUGINS, ADAPTER].sort()

export const SEED_MARKER = 'automagik-server-profile'
export const FOLLOW_STATUS = 'automagik-server-status.json'
export const releaseVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) && value.length <= 128 && !/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/.test(value)
export const packageHash = dir => createHash('sha256').update(readFileSync(join(dir, 'package.json'))).digest('hex')
export function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
export function writeJson(path, value) {
  const fresh = `${path}.${process.pid}.tmp`
  writeFileSync(fresh, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(fresh, path)
}
export function installedPlugins(profile) {
  return Object.fromEntries(PLUGINS.map(name => {
    const version = readJson(join(profile, 'node_modules', ...name.split('/'), 'package.json'))?.version
    return [name, releaseVersion(version) ? version : null]
  }))
}
export function validBuild(build) {
  return releaseVersion(build?.automagik) && PLUGINS.every(name => build.plugins?.[name] === build.automagik)
}
export function compareRelease(left, right) {
  if (!releaseVersion(left) || !releaseVersion(right)) throw new Error('Invalid release version')
  const [a, ap] = left.split(/-(.*)/s), [b, bp] = right.split(/-(.*)/s)
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1
  if (ap === bp) return 0
  if (ap === undefined || bp === undefined) return ap === undefined ? 1 : -1
  const pa = ap.split('.'), pb = bp.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue
    if (pa[i] === undefined || pb[i] === undefined) return pa[i] === undefined ? -1 : 1
    const an = /^\d+$/.test(pa[i]), bn = /^\d+$/.test(pb[i])
    if (an && bn) return BigInt(pa[i]) > BigInt(pb[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}
export function markSeed(profile, release, observedHash = packageHash(profile), imagePackage = readJson(join(profile, 'package.json'))) {
  if (!releaseVersion(release)) throw new Error('Invalid seed release')
  if (!/^[a-f0-9]{64}$/.test(observedHash)) throw new Error('Invalid seed hash')
  writeJson(join(profile, SEED_MARKER), { version: 1, release, packageSha256: observedHash, imagePackage })
}

/** Added dependencies/bundles belong to the workspace; the image still owns its base. */
export function extendsImage(pkg, baseline) {
  if (!baseline?.dependencies || !Array.isArray(baseline.dsh?.profile?.bundles) || !pkg?.dependencies || !Array.isArray(pkg.dsh?.profile?.bundles)) return false
  const copy = structuredClone(pkg)
  for (const [name, spec] of Object.entries(copy.dependencies)) {
    if (Object.hasOwn(baseline.dependencies, name)) continue
    if (typeof spec !== 'string' || !spec) return false
    delete copy.dependencies[name]
  }
  const bundles = copy.dsh.profile.bundles
  if (new Set(bundles).size !== bundles.length) return false
  if (bundles.some(name => !baseline.dsh.profile.bundles.includes(name) && !Object.hasOwn(pkg.dependencies, name))) return false
  copy.dsh.profile.bundles = bundles.filter(name => baseline.dsh.profile.bundles.includes(name))
  return isDeepStrictEqual(copy, baseline)
}

export function legacyManifest(manifest) {
  if (!manifest) return undefined
  const legacy = structuredClone(manifest)
  if (legacy.dependencies) delete legacy.dependencies[ADAPTER]
  return legacy
}

export function basePlugins(marker) {
  if (marker?.imagePackage === undefined) return LEGACY_PLUGINS
  const dependencies = marker.imagePackage?.dependencies
  if (!dependencies || typeof dependencies !== 'object') return PLUGINS
  const base = PLUGINS.filter(name => Object.hasOwn(dependencies, name))
  return base.length ? base : PLUGINS
}

function vendorPrefix(name) {
  return `file:vendor/automagik-${name.split('/')[1]}-`
}

export function vendorRelease(name, spec) {
  const prefix = vendorPrefix(name)
  if (typeof spec !== 'string' || !spec.startsWith(prefix) || !spec.endsWith('.tgz')) return undefined
  const version = spec.slice(prefix.length, -4)
  return releaseVersion(version) ? version : undefined
}

function manifestAt(manifest, names, release) {
  if (!manifest?.dependencies) return undefined
  const baseline = structuredClone(manifest)
  for (const name of names) baseline.dependencies[name] = `${vendorPrefix(name)}${release}.tgz`
  return baseline
}

const ownerManaged = () => ({ managed: false, ownerManaged: true, reason: 'owner-managed' })

/** Legacy adoption is deliberately stricter than a subset or dependency-name check. */
export function ownership(profile, source) {
  const path = join(profile, 'package.json')
  if (!lstatSync(profile, { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(path, { throwIfNoEntry: false })?.isFile()) return { managed: false, ownerManaged: false, reason: 'invalid-profile' }
  const raw = readFileSync(path, 'utf8'), pkg = readJson(path)
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { managed: false, ownerManaged: false, reason: 'invalid-profile' }
  const expected = readJson(join(source, 'package.json'))
  const markerPath = join(profile, SEED_MARKER)
  const text = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : undefined
  if (text !== undefined && text !== 'unknown\n') {
    const marker = readJson(markerPath)
    if (marker?.version !== 1 || !releaseVersion(marker.release) || !/^[a-f0-9]{64}$/.test(marker.packageSha256 ?? '')) {
      return { managed: false, ownerManaged: false, reason: 'unsupported-seed-marker' }
    }
    const observedHash = packageHash(profile)
    const baseline = marker.imagePackage ?? [
      manifestAt(expected, PLUGINS, marker.release),
      manifestAt(legacyManifest(expected), LEGACY_PLUGINS, marker.release),
    ].find(candidate => extendsImage(pkg, candidate) &&
      (Object.hasOwn(candidate.dependencies, ADAPTER) || !Object.hasOwn(pkg.dependencies, ADAPTER)))
    if (!baseline || (!basePlugins({ imagePackage: baseline }).includes(ADAPTER) &&
        Object.hasOwn(pkg.dependencies ?? {}, ADAPTER)) ||
        (observedHash !== marker.packageSha256 && !extendsImage(pkg, baseline))) return ownerManaged()
    return { managed: true, ownerManaged: false, reason: 'image-seed', release: marker.release,
      packageSha256: observedHash, imagePackage: baseline }
  }
  for (const [manifest, names] of [[expected, PLUGINS], [legacyManifest(expected), LEGACY_PLUGINS]]) {
    const versions = names.map(name => vendorRelease(name, pkg.dependencies?.[name]))
    if (!versions[0] || !versions.every(version => version === versions[0])) continue
    const baseline = manifestAt(manifest, names, versions[0])
    if (baseline && `${JSON.stringify(baseline, null, 2)}\n` === raw) {
      return { managed: true, ownerManaged: false, reason: 'legacy-image-seed', release: versions[0],
        packageSha256: createHash('sha256').update(raw).digest('hex'), imagePackage: baseline }
    }
  }
  return ownerManaged()
}

export function profileState({ profile, source, build, dshHome, rolledBack = false }) {
  const own = ownership(profile, source), plugins = installedPlugins(profile)
  const base = basePlugins(own)
  const validImage = validBuild(build)
  const newerMarker = validImage && own.managed && compareRelease(own.release, build.automagik) > 0
  const matchesImage = validImage && !newerMarker && base.length === PLUGINS.length &&
    PLUGINS.every(name => plugins[name] === build.plugins[name])
  let reason = own.reason
  if (!validImage) reason = 'invalid-image-metadata'
  else if (own.managed && rolledBack) reason = 'update-rolled-back'
  else if (own.managed) {
    const path = join(dshHome, FOLLOW_STATUS)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    const status = stat?.isFile() ? readJson(path) : undefined
    if (status?.version === 1 && status.imageVersion === build.automagik &&
        status.packageSha256 === packageHash(profile) && status.result === 'update-rolled-back') reason = 'update-rolled-back'
    else if (base.some(name => plugins[name] === null)) reason = 'missing-plugins'
    else if (newerMarker || Object.values(plugins).some(v => v !== null && compareRelease(v, build.automagik) > 0)) reason = 'newer-than-image'
    else if (matchesImage) reason = stat && status === undefined ? 'update-rolled-back' : 'matching-image'
    else reason = 'update-required'
  }
  return { plugins, followsImage: reason === 'matching-image', ownerManaged: own.ownerManaged, matchesImage, reason }
}
