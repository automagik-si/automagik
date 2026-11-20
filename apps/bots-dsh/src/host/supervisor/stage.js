import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { runCommand } from './child.js'
import { installedPlugins, profileRegistry } from './release.js'
import { directory, identity, regularBytes, sameEntry, writeBytesAtomic } from './store.js'

export const VENDOR = 'vendor/automagik-update'
export const ARCHIVE = /^[0-9a-f]{64}\.tgz$/
export const PROFILE_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']
const OPTIONAL_INPUTS = new Set(PROFILE_INPUTS.slice(2))
const LOCK_WAIT_MS = 120_000
const install = ['install', '--frozen-lockfile', '--offline', '--ignore-scripts']
const ARCHIVE_RECORD = 'created-archives.json'
const archiveName = plugin => `${plugin.sha256.toLowerCase()}.tgz`

function pidIsDead(record) {
  if (!/^\d+\n$/.test(record ?? '')) return false
  const pid = Number(record)
  if (pid <= 0 || pid > 0x7fffffff || pid === process.pid) return false
  try { process.kill(pid, 0) } catch (error) { return error.code === 'ESRCH' }
  return false
}

function reapProfileLock(path, entry) {
  if (!entry?.isFile() || entry.size > 32n) return
  const record = regularBytes(path, { optional: true })?.toString()
  if (!pidIsDead(record)) return
  // Use DSH's claim name so our takeover also serializes with DSH's contenders.
  const suffix = createHash('sha256').update(record).digest('hex').slice(0, 16)
  const claim = `${path}.takeover-${suffix}`
  try { fs.writeFileSync(claim, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = identity(claim)
    if (existing?.isFile() && existing.size <= 32n
      && pidIsDead(regularBytes(claim, { optional: true })?.toString())
      && sameEntry(existing, identity(claim))) fs.rmSync(claim, { force: true })
    return
  }
  try {
    if (sameEntry(entry, identity(path)) && regularBytes(path, { optional: true })?.toString() === record
      && pidIsDead(record)) fs.rmSync(path, { force: true })
  } finally {
    fs.rmSync(claim, { force: true })
  }
}

export async function takeProfileLock(profileDir, signal) {
  const path = join(profileDir, 'package.json.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    signal?.throwIfAborted()
    let fd
    try { fd = fs.openSync(path, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      reapProfileLock(path, identity(path))
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the DSH profile lock')
      if (identity(path)) await wait(100, undefined, { signal })
      continue
    }
    const entry = fs.fstatSync(fd, { bigint: true })
    const release = () => {
      if (sameEntry(entry, identity(path))) fs.rmSync(path, { force: true })
    }
    try { fs.writeFileSync(fd, `${process.pid}\n`) } catch (error) {
      release()
      throw error
    } finally {
      fs.closeSync(fd)
    }
    return release
  }
}

export function stagePaths(store, runId, profile) {
  const root = join(store, `stage-${runId}`)
  return { root, source: join(root, 'source'), profileDir: join(root, 'profiles', profile) }
}

export function downloadPath(staging, plugin) {
  return join(staging.root, `${plugin.name.split('/')[1]}.tgz`)
}

function treeSize(root) {
  let size = 0
  const pending = [root]
  while (pending.length) {
    const path = pending.pop()
    const entry = fs.lstatSync(path)
    if (entry.isDirectory()) {
      for (const item of fs.readdirSync(path)) pending.push(join(path, item))
    } else {
      size += entry.size
    }
  }
  return size
}

function checkDisk(profileDir, staging, plugins) {
  const { bavail, bsize } = fs.statfsSync(staging.root)
  const installed = join(profileDir, 'node_modules')
  if (!identity(installed)?.isDirectory()) throw new Error('Invalid installed module tree')
  const needed = treeSize(installed) + plugins.reduce((sum, item) => sum + item.size, 0)
  if (bavail * bsize < needed) throw new Error('Insufficient space for the staged profile')
}

export function laneEntries(manifest, names) {
  return Object.fromEntries(names.map(name => [name, manifest.dependencies[name]]))
}

export function withLaneEntries(manifest, entries) {
  return { ...manifest, dependencies: { ...manifest.dependencies, ...entries } }
}

function assertVersions(profileDir, versions) {
  if (!isDeepStrictEqual(installedPlugins(profileDir), versions)) throw new Error('Installed versions changed')
}

export function runDsh(config, home, cwd, args, signal) {
  return runCommand(config.command[0], [config.command[1], 'plugin', '--profile', config.profile, ...args], {
    cwd, env: { ...config.env, DSH_HOME: home }, signal,
  })
}

export function relink(config, signal) {
  return runDsh(config, config.home, config.profileDir, [
    'install', '--offline', '--frozen-lockfile', '--prod', '--ignore-scripts',
  ], signal)
}

function copyInputs(profileDir, staging) {
  directory(staging.source)
  directory(join(staging.root, 'profiles'))
  directory(staging.profileDir)
  for (const file of PROFILE_INPUTS) {
    const bytes = regularBytes(join(profileDir, file), { optional: OPTIONAL_INPUTS.has(file) })
    if (bytes === undefined) continue
    fs.writeFileSync(join(staging.source, file), bytes, { mode: 0o600 })
    fs.writeFileSync(join(staging.profileDir, file), bytes, { mode: file === 'compatibility.json' ? 0o400 : 0o600 })
  }
}

function equalFile(a, b, file) {
  const from = regularBytes(join(a, file), { optional: OPTIONAL_INPUTS.has(file) })
  const to = regularBytes(join(b, file), { optional: OPTIONAL_INPUTS.has(file) })
  return from === undefined ? to === undefined : to !== undefined && from.equals(to)
}

export function sourceMatches(profileDir, source) {
  return PROFILE_INPUTS.every(file => equalFile(profileDir, source, file))
}

function pinArchives(profileDir, staging, plugins) {
  const live = directory(join(directory(join(profileDir, 'vendor')), 'automagik-update'))
  const target = directory(join(directory(join(staging.profileDir, 'vendor')), 'automagik-update'))
  const created = []
  try {
    for (const plugin of plugins) {
      const name = archiveName(plugin)
      const from = join(live, name)
      if (!identity(from)) {
        writeBytesAtomic(join(staging.root, ARCHIVE_RECORD), JSON.stringify([...created, name]), { durable: true })
        writeBytesAtomic(from, regularBytes(downloadPath(staging, plugin)), { exclusive: true })
        created.push(name)
      } else {
        const entry = identity(from)
        if (!entry?.isFile() || entry.size !== BigInt(plugin.size)
          || createHash('sha256').update(regularBytes(from)).digest('hex') !== plugin.sha256.toLowerCase()) {
          throw new Error('An existing archive does not match its content address')
        }
      }
      fs.linkSync(from, join(target, name))
    }
  } catch (error) {
    discardArchives(profileDir, staging)
    throw error
  }
}

export function discardArchives(profileDir, staging) {
  const record = regularBytes(join(staging.root, ARCHIVE_RECORD), { optional: true })
  if (record === undefined) return
  const names = JSON.parse(record)
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && ARCHIVE.test(name))) {
    throw new Error('Invalid staged archive record')
  }
  const pins = lockPins(regularBytes(join(profileDir, 'pnpm-lock.yaml')).toString())
  for (const name of names) {
    const pin = `${VENDOR}/${name}`
    if (!pins.has(pin)) fs.rmSync(join(profileDir, pin), { force: true })
  }
}

export function lockPins(lockfile) {
  // pnpm repeats local references in importer values, package keys and peer suffixes.
  return new Set(Array.from(lockfile.matchAll(/(?:file|link):([^\s'"(){}[\],]+?)(?=:\s|[\s'"(){}[\],]|$)/g), match => match[1]))
}

function verifyCandidate(profileDir, staging, plugins, expectedEntries) {
  const after = JSON.parse(regularBytes(join(staging.profileDir, 'package.json')))
  const before = JSON.parse(regularBytes(join(staging.source, 'package.json')))
  if (!isDeepStrictEqual(after, withLaneEntries(before, expectedEntries))
    || !equalFile(staging.source, staging.profileDir, 'pnpm-workspace.yaml')
    || !equalFile(staging.source, staging.profileDir, 'compatibility.json')) {
    throw new Error('DSH changed inputs outside the selected plugin entries')
  }
  assertVersions(staging.profileDir, new Map(plugins.map(plugin => [plugin.name, plugin.version])))

  const beforePins = lockPins(regularBytes(join(staging.source, 'pnpm-lock.yaml')).toString())
  const afterLock = regularBytes(join(staging.profileDir, 'pnpm-lock.yaml')).toString()
  const afterPins = lockPins(afterLock)
  if (afterLock.includes(staging.root) || afterLock.includes(encodeURI(staging.root))) throw new Error('Nonportable staged lockfile')
  for (const pin of afterPins) {
    if (beforePins.has(pin)) continue
    const path = decodeURIComponent(pin)
    const absolute = resolve(profileDir, path)
    const rel = relative(profileDir, fs.realpathSync(absolute))
    if (isAbsolute(path) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('A new file pin does not resolve within the live profile')
    }
  }
  for (const spec of Object.values(expectedEntries)) {
    if (!afterPins.has(spec.slice('file:'.length))) throw new Error('The lockfile is missing a selected archive')
  }
}

export async function stageInstall(config, staging, { plugins, registry }, versions, signal) {
  const { profileDir, profile, env } = config
  profileRegistry(profileDir, env)
  assertVersions(profileDir, versions)
  checkDisk(profileDir, staging, plugins)
  copyInputs(profileDir, staging)
  const expectedEntries = Object.fromEntries(plugins.map(plugin => [plugin.name, `file:${VENDOR}/${archiveName(plugin)}`]))
  pinArchives(profileDir, staging, plugins)
  try {
    const options = [`--registry=${registry}`]
    await runDsh(config, staging.root, staging.profileDir, [
      'add', '--prefer-offline', '--ignore-scripts', ...options, ...Object.values(expectedEntries),
    ], signal)
    verifyCandidate(profileDir, staging, plugins, expectedEntries)
    const lock = regularBytes(join(staging.profileDir, 'pnpm-lock.yaml'))
    await runDsh(config, staging.root, staging.profileDir, [...install, ...options], signal)
    verifyCandidate(profileDir, staging, plugins, expectedEntries)
    if (!lock.equals(regularBytes(join(staging.profileDir, 'pnpm-lock.yaml')))) {
      throw new Error(`Frozen lockfile changed for profile ${profile}`)
    }
  } catch (error) {
    discardArchives(profileDir, staging)
    throw error
  }
}

export function assertRelinked(profileDir, staging) {
  const modules = join(profileDir, 'node_modules')
  for (const name of ['.modules.yaml', '.pnpm/lock.yaml']) {
    if (regularBytes(join(modules, name), { optional: true })?.includes(staging.root)) {
      throw new Error('The relink retained staged module paths')
    }
  }
  const pending = [modules]
  while (pending.length) {
    const path = pending.pop()
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const item = join(path, entry.name)
      if (entry.isDirectory()) pending.push(item)
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(item), fs.readlinkSync(item))
        if (target === staging.root || target.startsWith(staging.root + sep)) {
          throw new Error('The relink retained a staged symlink')
        }
      }
    }
  }
}
