import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pinStore, profileDirOf, PROFILE, seedProfile } from './lib.mjs'
import { FOLLOW_STATUS, installedPlugins, markSeed, ownership, packageHash, profileState, compareRelease, validBuild, writeJson, readJson } from './profile-state.mjs'
import { materializePlugins, PLUGINS, pruneImageArchives } from './plugin-payload.mjs'
import { mergeImageProfile, readLock } from './profile-lock.mjs'
import { withVolumeLock } from './volume-lock.mjs'

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
  } catch { /* Live version/ownership checks still make a mismatch unhealthy. */ }
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
  if (!PLUGINS.every(name => installedPlugins(target)[name] === current.release)) throw new Error('Incomplete image profile swap')
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
    return { target, seeded: false, result, ...profileState({ profile: target, source, build, dshHome }) }
  }
  if (own.reason === 'legacy-image-seed') {
    try { markSeed(target, own.release, own.packageSha256); own = ownership(target, source) }
    catch { return done('update-rolled-back') }
  }
  if (recovered) return done('update-rolled-back')
  if (!own.managed) return done(own.reason)
  if (!validBuild(build)) return done('invalid-image-metadata')
  const plugins = installedPlugins(target)
  if (PLUGINS.some(name => plugins[name] === null)) return done('missing-plugins')
  if (PLUGINS.some(name => compareRelease(plugins[name], build.automagik) > 0) || compareRelease(own.release, build.automagik) > 0) return done('newer-than-image')
  if (PLUGINS.every(name => plugins[name] === build.plugins[name])) {
    // Repair seeds made by older images too. These inputs must survive every later
    // `dsh plugin install`, which resolves all direct dependencies again.
    // Rebuild the lock too: a stopped seed may have written the archives but not
    // yet their new integrity. The workspace's own lock keeps what the welcome added; one
    // that cannot be read falls back to the image's, so a broken lock never stops the server.
    try { materializePlugins({ source, target, lock: readLock(target) }) }
    catch { materializePlugins({ source, target }) }
    pinStore(target, dshHome)
    return done('matching-image')
  }
  if (compareRelease(build.automagik, own.release) <= 0) return done('update-required')

  let staging
  const previous = `${target}.image-previous`
  try {
    const extras = Object.keys(readJson(join(target, 'package.json')).dependencies).filter(name => !PLUGINS.includes(name))
    const addedVersions = Object.fromEntries(extras.map(name => [name, readJson(join(target, 'node_modules', name, 'package.json'))?.version]))
    if (Object.values(addedVersions).some(version => typeof version !== 'string')) throw new Error('Missing added plugin')
    const stamp = `${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const backup = join(dshHome, 'backups', stamp)
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
    mkdirSync(backup, { mode: 0o700 })
    await cp(target, join(backup, PROFILE), { recursive: true, verbatimSymlinks: true })
    writeJson(join(backup, 'update.json'), { version: 1, from: own.release, to: build.automagik })
    staging = mkdtempSync(join(dshHome, '.image-update-'))
    const profile = profileDirOf(staging)
    mkdirSync(dirname(profile), { recursive: true })
    await cp(target, profile, { recursive: true, verbatimSymlinks: true })
    rmSync(join(profile, 'node_modules'), { recursive: true, force: true })
    const lock = mergeImageProfile({ source, target: profile })
    materializePlugins({ source, target: profile, lock })
    await overlayStore(store, join(dshHome, 'pnpm-store'))
    reuseInstalledIndexes(join(dshHome, 'pnpm-store'))
    pinStore(profile, dshHome)
    await install({ dshBin, profile, dshHome: staging })
    if (!PLUGINS.every(name => installedPlugins(profile)[name] === build.plugins[name])) throw new Error('Image plugin install did not converge')
    if (!extras.every(name => readJson(join(profile, 'node_modules', name, 'package.json'))?.version === addedVersions[name])) throw new Error('Added plugin did not survive image update')
    if (packageHash(target) !== own.packageSha256) return done('owner-managed')
    // Keep the materialized inputs on the data volume for subsequent plugin installs; the
    // previous image's are only in the backup.
    pruneImageArchives(profile)
    markSeed(profile, build.automagik, undefined, readJson(join(source, 'package.json')))
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
