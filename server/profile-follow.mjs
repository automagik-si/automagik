import { execFileSync } from 'node:child_process'
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import * as yaml from 'yaml'
import { hasReadScopeAdapters, mergePatch, replaceProfilePatch } from '../apps/desktop/src/profile-patch.mjs'
import { pinStore, profileDirOf, PROFILE, seedProfile, workspaceFileStat } from './lib.mjs'
import { ADAPTER, basePlugins, FOLLOW_STATUS, installedPlugins, LEGACY_PLUGINS, markSeed, ownership, packageHash, profileState, compareRelease, validBuild, vendorRelease, writeJson, readJson } from './profile-state.mjs'
import { materializePlugins, PLUGINS, pruneImageArchives } from './plugin-payload.mjs'
import { mergeImageProfile, readLock } from './profile-lock.mjs'
import { withVolumeLock } from './volume-lock.mjs'

// Reconcile the managed profile with the adapter exports of the Bot package it will run.
function mergeReadScopePatch(source, profile, readScopeAvailable) {
  const name = 'cordis.patch.yml'
  const shipped = readFileSync(join(source, name), 'utf8')
  const file = join(profile, name)
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat !== undefined && !stat.isFile()) throw new Error('Unsupported image profile patch file')
  const merged = mergePatch(yaml, stat === undefined ? '' : readFileSync(file, 'utf8'), shipped, { readScopeOnly: true, readScopeAvailable })
  if (merged !== null) replaceProfilePatch(file, merged, stat === undefined ? undefined : stat.mode & 0o777)
}

export function mergeImageRows(source, profile) {
  const name = 'cordis.patch.yml'
  const shipped = yaml.parse(readFileSync(join(source, name), 'utf8'), { logLevel: 'error' }) ?? []
  const rows = shipped.flatMap(row => {
    const insert = row?.insert
    if (!Array.isArray(insert)) return []
    const adapter = insert.filter(entry => entry?.name === ADAPTER)
    return adapter.length ? [{ ...row, insert: adapter }] : []
  })
  if (!rows.length) return
  const file = join(profile, name)
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat !== undefined && !stat.isFile()) throw new Error('Unsupported image profile patch file')
  const fragment = yaml.stringify(rows, { singleQuote: true })
  const merged = mergePatch(yaml, stat ? readFileSync(file, 'utf8') : '', fragment, { readScopeOnly: false })
  if (merged !== null) replaceProfilePatch(file, merged, stat === undefined ? undefined : stat.mode & 0o777)
}

function inputHash(profile, name) {
  const file = join(profile, name)
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) throw new Error('Unsupported image profile input file')
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function profileListing(profile) {
  const root = requireProfileDirectory(profile)
  const listing = []
  function visit(dir = '') {
    for (const name of readdirSync(join(profile, dir)).sort()) {
      if (!dir && name === 'node_modules') continue
      const path = join(dir, name)
      const stat = lstatSync(join(profile, path))
      listing.push([path, stat.mode & constants.S_IFMT, stat.mode & 0o7777, stat.size, stat.mtimeMs, stat.ctimeMs])
      if (stat.isDirectory()) visit(path)
    }
  }
  visit()
  return JSON.stringify({ mode: root.mode & 0o7777, ctimeMs: root.ctimeMs, entries: listing })
}

function requireProfileDirectory(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) throw new Error('Unsupported image profile directory')
  return stat
}

/** Copy cache files by rename: an existing store file may be hard-linked by the old profile. */
async function overlayStore(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) await overlayStore(from, to)
    else if (entry.isFile()) {
      const fresh = `${to}.${process.pid}.tmp`
      cpSync(from, fresh)
      renameSync(fresh, to)
    } else throw new Error('Unsupported offline store entry')
  }
}

/**
 * pnpm indexes a package the lock holds no integrity for (a git-hosted one, such as Omni's
 * plugins the welcome adds) by whether its scripts ran: DSH's own installs write
 * `integrity.json`, and the update's --ignore-scripts install reads `integrity-not-built.json`.
 * Give the update the index of the files the workspace already installed, so it stays offline
 * and installs exactly those. An index pnpm already wrote is never replaced.
 */
export function reuseInstalledIndexes(store) {
  const root = join(store, 'v10')
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const built = join(root, entry.name, 'integrity.json'), plain = join(root, entry.name, 'integrity-not-built.json')
    if (!existsSync(built) || !lstatSync(built).isFile() || existsSync(plain)) continue
    const fresh = `${plain}.${process.pid}.tmp`
    cpSync(built, fresh)
    renameSync(fresh, plain)
  }
}

/** The profile is only ever installed through DSH, with all resolution pinned and offline. */
export function installOffline({ dshBin, profile, dshHome }) {
  execFileSync(process.execPath, [dshBin, 'plugin', '--profile', PROFILE, 'install', '--offline', '--frozen-lockfile', '--prod', '--ignore-scripts'], {
    cwd: profile, env: { ...process.env, DSH_HOME: dshHome, DO_NOT_TRACK: '1' },
    stdio: 'ignore', timeout: 120_000,
  })
}

function record(dshHome, target, build, result) {
  try {
    writeJson(join(dshHome, FOLLOW_STATUS), { version: 1, imageVersion: build.automagik,
      packageSha256: packageHash(target), result })
  } catch { /* The follower still reports its rollback to the entrypoint. */ }
}

/** Recover the directory-swap window before first-start seeding can mistake it for no profile. */
function recoverSwap(target, source) {
  const previous = `${target}.image-previous`
  if (!existsSync(previous)) return false
  if (!ownership(previous, source).managed) throw new Error('Unsupported previous image profile')
  if (!existsSync(target)) { renameSync(previous, target); return true }
  // A completed swap already has the new marker and coherent installed versions. An owner
  // edit afterwards wins: never replace it with the previous image's directory.
  const current = ownership(target, source)
  if (!current.managed) return false
  const plugins = installedPlugins(target)
  // Recovery needs the recorded base, even when reporting can use a fallback inventory.
  const dependencies = current.imagePackage.dependencies ?? {}
  const base = PLUGINS.filter(name => Object.hasOwn(dependencies, name))
  if (!LEGACY_PLUGINS.every(name => base.includes(name)) ||
      !base.every(name => plugins[name] === current.release)) throw new Error('Incomplete image profile swap')
  rmSync(previous, { recursive: true, force: true })
  return false
}

export function followImage(options) {
  return withVolumeLock(options.dshHome, () => followImageUnlocked(options))
}

async function followImageUnlocked({ dshHome, source, store, build, dshBin, install = installOffline, now = () => new Date() }) {
  const target = profileDirOf(dshHome)
  const recovered = recoverSwap(target, source)
  if (!existsSync(target)) {
    if (!validBuild(build)) throw new Error('Invalid image metadata for first seed')
    const seeded = await seedProfile({ dshHome, source, release: build.automagik })
    if (seeded.seeded) {
      materializePlugins({ source, target })
      pinStore(target, dshHome)
      record(dshHome, target, build, 'seeded')
      return { ...seeded, result: 'seeded', ...profileState({ profile: target, source, build, dshHome }) }
    }
    // A competing first-start seed won. Re-read its ownership and versions below;
    // this process must not stamp an existing profile as its own fresh seed.
  }
  let own = ownership(target, source)
  const done = result => {
    record(dshHome, target, build, result)
    return { target, seeded: false, result, ...profileState({ profile: target, source, build, dshHome,
      rolledBack: result === 'update-rolled-back' }) }
  }
  if (own.reason === 'legacy-image-seed') {
    try { markSeed(target, own.release, own.packageSha256); own = ownership(target, source) }
    catch { return done('update-rolled-back') }
  }
  if (recovered) return done('update-rolled-back')
  if (!own.managed) return done(own.reason)
  if (!validBuild(build)) return done('invalid-image-metadata')
  const plugins = installedPlugins(target)
  const base = basePlugins(own)
  if (base.some(name => plugins[name] === null)) return done('missing-plugins')
  if (Object.values(plugins).some(version => version !== null && compareRelease(version, build.automagik) > 0) ||
      compareRelease(own.release, build.automagik) > 0) return done('newer-than-image')
  const oldSpecs = own.imagePackage.dependencies ?? {}
  const previousFiles = base.filter(name => vendorRelease(name, oldSpecs[name])).map(name => basename(oldSpecs[name]))
  if (base.length === PLUGINS.length && PLUGINS.every(name => plugins[name] === build.plugins[name])) {
    // Repair seeds made by older images too. These inputs must survive every later
    // `dsh plugin install`, which resolves all direct dependencies again.
    // Rebuild the lock too: a stopped seed may have written the archives but not
    // yet their new integrity. The workspace's own lock keeps what the welcome added; one
    // that cannot be read falls back to the image's, so a broken lock never stops the server.
    try {
      workspaceFileStat(join(target, 'pnpm-workspace.yaml'))
      let lock
      try { lock = readLock(target) } catch { /* Use the image lock when the workspace lock is unreadable. */ }
      materializePlugins({ source, target, lock, previousFiles })
    } catch { return done('update-rolled-back') }
    try { pinStore(target, dshHome) }
    catch (error) {
      if (error.code === 'UNSUPPORTED_PROFILE_WORKSPACE') return done('update-rolled-back')
      throw error
    }
    mergeReadScopePatch(source, target, hasReadScopeAdapters(source) && hasReadScopeAdapters(target))
    return done('matching-image')
  }
  const releaseOrder = compareRelease(build.automagik, own.release)
  const addsAdapter = !base.includes(ADAPTER) && base.every(name => plugins[name] === own.release)
  if (releaseOrder < 0 || (releaseOrder === 0 && !addsAdapter)) return done('update-required')

  let staging
  const previous = `${target}.image-previous`
  try {
    const listing = profileListing(target)
    const inputs = ['cordis.patch.yml', 'pnpm-lock.yaml'].map(name => [name, inputHash(target, name)])
    const extras = Object.keys(readJson(join(target, 'package.json')).dependencies).filter(name => !PLUGINS.includes(name))
    const addedVersions = Object.fromEntries(extras.map(name => [name, readJson(join(target, 'node_modules', name, 'package.json'))?.version]))
    if (Object.values(addedVersions).some(version => typeof version !== 'string')) throw new Error('Missing added plugin')
    const stamp = `${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const backup = join(dshHome, 'backups', stamp)
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
    mkdirSync(backup, { mode: 0o700 })
    requireProfileDirectory(target)
    await cp(target, join(backup, PROFILE), { recursive: true, verbatimSymlinks: true })
    writeJson(join(backup, 'update.json'), { version: 1, from: own.release, to: build.automagik })
    staging = mkdtempSync(join(dshHome, '.image-update-'))
    const profile = profileDirOf(staging)
    mkdirSync(dirname(profile), { recursive: true })
    requireProfileDirectory(target)
    await cp(target, profile, { recursive: true, verbatimSymlinks: true })
    requireProfileDirectory(profile)
    for (const dir of ['.plugin-manager', '.plugin-manager/logs']) {
      const stat = lstatSync(join(profile, dir), { throwIfNoEntry: false })
      if (stat && !stat.isDirectory()) throw new Error('Unsupported image profile plugin manager directory')
    }
    rmSync(join(profile, 'node_modules'), { recursive: true, force: true })
    const lock = mergeImageProfile({ source, target: profile, base })
    const readScope = hasReadScopeAdapters(source)
    mergeReadScopePatch(source, profile, readScope)
    mergeImageRows(source, profile)
    materializePlugins({ source, target: profile, lock, previousFiles })
    pinStore(profile, dshHome)
    await overlayStore(store, join(dshHome, 'pnpm-store'))
    reuseInstalledIndexes(join(dshHome, 'pnpm-store'))
    await install({ dshBin, profile, dshHome: staging })
    const staged = installedPlugins(profile)
    if (!PLUGINS.every(name => staged[name] === build.plugins[name])) throw new Error('Image plugin install did not converge')
    if (readScope && !hasReadScopeAdapters(profile)) throw new Error('Image profile install lost the file-scope adapters')
    if (!extras.every(name => readJson(join(profile, 'node_modules', name, 'package.json'))?.version === addedVersions[name])) throw new Error('Added plugin did not survive image update')
    // Keep the materialized inputs on the data volume for subsequent plugin installs; the
    // previous image's are only in the backup.
    pruneImageArchives(profile, previousFiles)
    markSeed(profile, build.automagik, undefined, readJson(join(source, 'package.json')))
    if (inputHash(target, 'package.json') !== own.packageSha256) return done('owner-managed')
    if (inputs.some(([name, hash]) => inputHash(target, name) !== hash) || profileListing(target) !== listing) return done('update-rolled-back')
    renameSync(target, previous)
    try { renameSync(profile, target) }
    catch (error) { renameSync(previous, target); throw error }
    // Backup is already complete; failure to remove this extra copy is recoverable next start.
    try { rmSync(previous, { recursive: true, force: true }) } catch {}
    return done('updated')
  } catch {
    if (!existsSync(target) && existsSync(previous)) renameSync(previous, target)
    return done('update-rolled-back')
  } finally {
    if (staging) try { rmSync(staging, { recursive: true, force: true }) } catch {}
  }
}
