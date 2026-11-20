import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { attachedRoleIds, isRoleId, isRoleVersion, rolesOn } from '../shared/roles.js'
import { isSha256, parseRoleJson, plainObject, roleName, validCapabilities } from './role-catalog.js'
import { MAX_ROLE_BYTES, MAX_ROLE_FILES, MAX_ROLE_FILE_SIZE, readRoleTar, roleFilePath } from './role-tar.js'
import { refusal } from './refusal.js'

const MANIFEST_LIMIT = 64 * 1024
const MANIFEST_FIELDS = new Set(['id', 'version', 'name', 'publisher', 'entry', 'prompt', 'tools', 'capabilities', 'settings', 'ui', 'description', 'requires'])
const invalidManifest = detail => refusal(`Invalid role manifest (${detail}).`)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function rolePaths(home, id, version) {
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('\0')) throw refusal('Invalid Bot team folder.')
  if (!isRoleId(id) || !isRoleVersion(version)) throw refusal('Invalid role id or version.')
  const rolesDir = join(home, 'roles')
  const pkgDir = join(rolesDir, id)
  return { home, rolesDir, pkgDir, verDir: join(pkgDir, version) }
}

function decodeManifest(bytes) {
  if (!bytes || bytes.length > MANIFEST_LIMIT) throw invalidManifest('missing or oversized role.json')
  let manifest
  try { manifest = parseRoleJson(bytes) } catch { throw invalidManifest('role.json is not valid JSON') }
  if (!plainObject(manifest)) throw invalidManifest('expected a JSON object')
  return manifest
}

function validateManifest(files, entry) {
  const manifest = decodeManifest(files.get('role.json'))
  const { id, version, publisher, name, entry: script, prompt, tools, capabilities, settings, ui, description, requires } = manifest
  if (id !== entry.id || version !== entry.version || publisher !== entry.publisher || !roleName(name)) {
    throw invalidManifest('id, version, publisher or name')
  }
  if (!roleFilePath(script) || !/\.m?js$/.test(script) || !files.has(script)) throw invalidManifest('entry file')
  if (!roleFilePath(prompt) || !/\.(?:md|txt)$/.test(prompt) || !files.has(prompt) || files.get(prompt).length > 16 * 1024) {
    throw invalidManifest('prompt file')
  }
  if (!Array.isArray(tools) || tools.length > 16 || !tools.every(tool => plainObject(tool)
    && typeof tool.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(tool.name)
    && typeof tool.description === 'string' && tool.description.length >= 1 && tool.description.length <= 1024
    && plainObject(tool.parameters)) || new Set(tools.map(tool => tool.name)).size !== tools.length) {
    throw invalidManifest('tools')
  }
  if (!validCapabilities(capabilities) || capabilities.length !== entry.capabilities.length
    || !capabilities.every(capability => entry.capabilities.includes(capability))) throw invalidManifest('capabilities')
  if (!Array.isArray(settings) || !Array.isArray(ui)) throw invalidManifest('settings or ui')
  if (settings.length || ui.length) throw refusal('Role settings and ui are not supported yet.')
  if (requires !== undefined && (!Array.isArray(requires) || !requires.every(item => typeof item === 'string'))) throw invalidManifest('requires')
  if (requires?.length) throw refusal('Required role features are not supported yet.')
  if (description !== undefined && typeof description !== 'string') throw invalidManifest('description')
  return Object.keys(manifest).filter(key => !MANIFEST_FIELDS.has(key))
}

const ownRecord = (map, id) => map !== null && typeof map === 'object' && Object.hasOwn(map, id)
  && (!Array.isArray(map) || (id !== 'length' && map[id] !== null))
const validRecord = (map, id, record) => plainObject(map) && ownRecord(map, id)
  && isRoleId(id) && plainObject(record) && record.id === id && isRoleVersion(record.version) && isSha256(record.sha256)
const sameFile = (a, b) => a === undefined || b === undefined ? a === b : a.dev === b.dev && a.ino === b.ino

async function lstat(fs, path) {
  try { return await fs.lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

// The team home is private and owner-controlled. These checks refuse links and unexpected
// directory changes, within the cooperative lock. They do not sandbox concurrent local writers.
async function directories(fs, paths) {
  const found = []
  for (const path of [paths.home, paths.rolesDir, paths.pkgDir, paths.verDir]) {
    const stat = await lstat(fs, path)
    if (stat && !stat.isDirectory()) throw refusal(`A folder is in the way: ${path}`)
    found.push(stat)
    if (!stat) break
  }
  return found
}

async function readRegular(fs, path, stat, limit) {
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size > limit) return undefined
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, stat) || opened.size !== stat.size) return undefined
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read({ buffer: bytes, offset, length: bytes.length - offset, position: offset })
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === stat.size ? bytes.subarray(0, offset) : undefined
  } finally {
    await file.close()
  }
}

function expectedDirectories(files) {
  const expected = new Set()
  for (const path of files.keys()) {
    for (let parent = posix.dirname(path); parent !== '.' && !expected.has(parent); parent = posix.dirname(parent)) expected.add(parent)
  }
  return expected
}

async function inspect(fs, root, files) {
  const expected = files && expectedDirectories(files)
  let remaining = files?.size
  let count = 0
  let total = 0
  async function walk(path) {
    const directory = await fs.opendir(join(root, path))
    for await (const child of directory) {
      const name = path ? `${path}/${child.name}` : child.name
      if (++count > (files ? files.size + expected.size : MAX_ROLE_FILES * 96) || !roleFilePath(name)) return false
      const target = join(root, name)
      const stat = await lstat(fs, target)
      if (stat?.isDirectory()) {
        if ((expected && !expected.has(name)) || !await walk(name)) return false
      } else {
        if (!stat?.isFile() || stat.nlink !== 1 || stat.size > MAX_ROLE_FILE_SIZE || (total += stat.size) > MAX_ROLE_BYTES) return false
        if (files) {
          const file = files.get(name)
          if (!file || file.length !== stat.size) return false
          const actual = await readRegular(fs, target, stat, file.length)
          if (!actual || !(Buffer.isBuffer(file) ? file.equals(actual) : file.sha256 === digest(actual))) return false
          remaining--
        }
      }
    }
    return true
  }
  return await walk('') && (remaining === undefined || remaining === 0)
}

async function prune(fs, path) {
  try { await fs.rmdir(path) } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

export function createRolePackages(rt, catalog, { fs = fsPromises, now = Date.now } = {}) {
  const { state } = rt
  const statuses = new Map()
  // The install record pins the compressed archive. Keep verified file digests for this
  // host's lazy checks without changing the on-disk record or keeping an archive in memory.
  const fingerprints = new WeakMap()
  const warn = (...args) => rt.warn?.(...args)
  const recordOf = id => ownRecord(state.roles, id) ? state.roles[id] : undefined
  const expectRecord = (id, hadRecord, record) => {
    if (Boolean(ownRecord(state.roles, id)) !== hadRecord || !Object.is(recordOf(id), record)) {
      throw refusal('The role install record changed. Try again.')
    }
  }
  const requireWriter = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly, { code: 'bot/read-only' })
    if (!rt.holdsLock()) throw refusal('This host does not hold the Bot team.')
  }
  const requireDetached = id => {
    if (Object.values(state.bots).some(bot => attachedRoleIds(bot).includes(id))) {
      throw refusal('Detach this role from every Bot before uninstalling it.')
    }
  }

  async function statusOf(id, record) {
    if (!validRecord(state.roles, id, record)) return 'damaged'
    const cached = statuses.get(id)
    if (cached?.record === record) return cached.status
    const paths = rolePaths(rt.home, id, record.version)
    const expected = fingerprints.get(record)
    let status
    try {
      if (!(await directories(fs, paths))[3]) {
        status = 'broken'
      } else if (expected) {
        status = await inspect(fs, paths.verDir, expected) ? 'ok' : 'damaged'
      } else if (await inspect(fs, paths.verDir)) {
        const path = join(paths.verDir, 'role.json')
        const manifest = decodeManifest(await readRegular(fs, path, await lstat(fs, path), MANIFEST_LIMIT))
        const script = roleFilePath(manifest.entry) && await lstat(fs, join(paths.verDir, manifest.entry))
        const prompt = roleFilePath(manifest.prompt) && await lstat(fs, join(paths.verDir, manifest.prompt))
        if (manifest.id === id && manifest.version === record.version && manifest.publisher === record.publisher
          && script && script.isFile() && /\.m?js$/.test(manifest.entry)
          && prompt && prompt.isFile() && /\.(?:md|txt)$/.test(manifest.prompt) && prompt.size <= 16 * 1024) status = 'ok'
      }
    } catch { /* An unreadable or unsafe package is damaged. */ }
    status ??= 'damaged'
    if (recordOf(id) === record && statuses.get(id) === cached) statuses.set(id, { record, status })
    return statuses.get(id)?.record === record ? statuses.get(id).status : status
  }

  async function install(id) {
    requireWriter()
    if (!rolesOn(state.prefs)) throw refusal('Roles are turned off for this team.')
    if (!isRoleId(id)) throw refusal('Unknown role')
    const snapshot = await catalog.snapshot()
    requireWriter()
    if (!snapshot.view.available) throw refusal('The role catalog is unavailable.')
    const entry = snapshot.entries.get(id)
    if (!entry) throw refusal('This role is not in the catalog.')
    if (!entry.display.installable) throw refusal('Community roles cannot be installed yet.')
    const { version, publisher } = entry.display
    const { sha256, source } = entry
    const paths = rolePaths(rt.home, id, version)
    const hadRecord = Boolean(ownRecord(state.roles, id))
    const previous = recordOf(id)
    if (hadRecord) {
      if (!validRecord(state.roles, id, previous)) throw refusal('The role install is damaged. Uninstall it first.')
      if (previous.version !== version) throw refusal('Another version is installed. Uninstall it first.')
      if (previous.sha256.toLowerCase() !== sha256) throw refusal('The installed role conflicts with this package.')
    }

    const bytes = await catalog.download(entry)
    if (bytes.length !== entry.size || digest(bytes) !== sha256) throw refusal('The role download does not match the catalog size or checksum.')
    const files = readRoleTar(bytes)
    const warnings = validateManifest(files, entry.display)
    const result = { id, version, warnings }
    const admit = () => {
      requireWriter()
      expectRecord(id, hadRecord, previous)
      if (state.roles !== undefined && !plainObject(state.roles)) throw refusal('The role install records are damaged.')
    }
    admit()
    statuses.delete(id)
    const { rolesDir, pkgDir, verDir } = paths
    const current = await directories(fs, paths).catch(error => {
      if (!hadRecord) throw error
      return undefined
    })
    if (hadRecord || current[3]) {
      let equal = false
      try { equal = Boolean(current?.[3]) && await inspect(fs, verDir, files) } catch { /* Preserve an unreadable directory. */ }
      admit()
      if (hadRecord) {
        statuses.set(id, { record: previous, status: equal ? 'ok' : current && !current[3] ? 'broken' : 'damaged' })
        if (equal) return result
        throw refusal('The role install is damaged. Uninstall it first.')
      }
      if (!equal) throw refusal(`A folder is in the way: ${verDir}`)
    }

    let staged
    let stagingIdentity
    let published = current[3]
    let renamed = false
    let parents = current
    let refusedBeforeCommit = false
    const record = { id, version, publisher, sha256, installedAt: new Date(now()).toISOString(), source }
    fingerprints.set(record, new Map([...files].map(([path, bytes]) => [path, { length: bytes.length, sha256: digest(bytes) }])))
    const add = team => { team.roles = { ...team.roles, [id]: record } }
    try {
      if (!published) {
        admit()
        await fs.mkdir(pkgDir, { mode: 0o700, recursive: true })
        parents = await directories(fs, paths)
        if (!parents[2] || parents[3] || !current.every((stat, index) => !stat || sameFile(stat, parents[index]))) {
          throw refusal(`A folder is in the way: ${verDir}`)
        }
        admit()
        staged = await fs.mkdtemp(join(rolesDir, '.staging-'))
        stagingIdentity = await lstat(fs, staged)
        if (!stagingIdentity?.isDirectory()) throw refusal('The role staging folder changed.')
        for (const [path, data] of files) {
          const target = join(staged, path)
          await fs.mkdir(dirname(target), { mode: 0o700, recursive: true })
          const file = await fs.open(target, 'wx', 0o600)
          try { await file.writeFile(data) } finally { await file.close() }
        }
        const before = await directories(fs, paths)
        const stagedBefore = await lstat(fs, staged)
        admit()
        if (!parents.every((stat, index) => sameFile(stat, before[index])) || before[3]
          || !sameFile(stagingIdentity, stagedBefore)) throw refusal(`A folder is in the way: ${verDir}`)
        await fs.rename(staged, verDir)
        renamed = true
        staged = undefined
        published = await lstat(fs, verDir)
      }
      const before = await directories(fs, paths)
      admit()
      if (!published || !parents.slice(0, 3).every((stat, index) => sameFile(stat, before[index]))
        || !sameFile(published, before[3])) throw refusal(`A folder is in the way: ${verDir}`)
      await rt.saveCopy(add, {
        beforeCommit: () => {
          try { admit() } catch (error) { refusedBeforeCommit = true; throw error }
        },
        afterWrite: () => add(state),
      })
      return result
    } catch (error) {
      if (!renamed && !current[3]) throw error
      if (renamed && refusedBeforeCommit && published) {
        let rolledBack = false
        try {
          const before = await directories(fs, paths)
          admit()
          if (parents.slice(0, 3).every((stat, index) => sameFile(stat, before[index])) && sameFile(published, before[3])) {
            await fs.rm(verDir, { recursive: true })
            rolledBack = true
            await prune(fs, pkgDir)
          }
        } catch { /* Ownership or identity is uncertain. */ }
        if (rolledBack) throw error
      }
      warn('Role %s could not finish installing. Package folder left at %s.', id, verDir)
      return { installed: false, leftover: verDir }
    } finally {
      if (staged !== undefined) {
        try {
          const before = await directories(fs, paths)
          const stagedBefore = await lstat(fs, staged)
          admit()
          if (!stagingIdentity || !parents.slice(0, 3).every((stat, index) => sameFile(stat, before[index]))
            || !sameFile(stagingIdentity, stagedBefore)) throw refusal('The role staging folder changed.')
          await fs.rm(staged, { recursive: true })
          if (!current[2] && rt.holdsLock()) await prune(fs, pkgDir)
        } catch {
          warn('Role staging cleanup could not finish at %s.', staged)
        }
      }
    }
  }

  async function uninstall(id) {
    requireWriter()
    if (typeof id !== 'string' || !ownRecord(state.roles, id)) throw refusal('This role is not installed.')
    requireDetached(id)
    statuses.delete(id)
    const record = recordOf(id)
    const paths = validRecord(state.roles, id, record) ? rolePaths(rt.home, id, record.version) : undefined
    const original = paths && await directories(fs, paths).catch(() => undefined)
    const remove = team => {
      const records = Array.isArray(team.roles) ? team.roles.slice() : { ...team.roles }
      delete records[id]
      team.roles = records
    }
    const admit = () => {
      requireWriter()
      expectRecord(id, true, record)
      requireDetached(id)
    }
    admit()
    let committed = false
    try {
      await rt.saveCopy(remove, {
        beforeCommit: admit,
        afterWrite: () => { remove(state); committed = true },
      })
    } catch (error) {
      if (!committed || !paths) throw error
      warn('Role %s was removed from the team. Package folder left at %s.', id, paths.verDir)
      return { removed: false, leftover: paths.verDir }
    }
    if (!paths) return { removed: true }
    try {
      if (!original) throw refusal('The package path is unsafe.')
      if (!original[3]) return { removed: true }
      if (!await inspect(fs, paths.verDir)) throw refusal('The package folder contains unsafe entries.')
      const before = await directories(fs, paths)
      requireWriter()
      expectRecord(id, false, undefined)
      requireDetached(id)
      if (!original.every((stat, index) => sameFile(stat, before[index]))) throw refusal('The package folder changed.')
      await fs.rm(paths.verDir, { recursive: true })
      await prune(fs, paths.pkgDir)
      return { removed: true }
    } catch {
      warn('Role %s was removed from the team. Package folder left at %s.', id, paths.verDir)
      return { removed: false, leftover: paths.verDir }
    }
  }

  async function recordsView() {
    for (;;) {
      const map = state.roles
      if (map === null || typeof map !== 'object') return {}
      const records = Object.entries(map).filter(([id]) => ownRecord(map, id))
      const projected = await Promise.all(records.map(async ([id, record]) => [id, {
        id,
        version: isRoleVersion(record?.version) ? record.version : undefined,
        publisher: roleName(record?.publisher) ? record.publisher : undefined,
        installedAt: typeof record?.installedAt === 'string' && record.installedAt.length <= 40 ? record.installedAt : undefined,
        status: await statusOf(id, record),
      }]))
      if (map === state.roles) return Object.fromEntries(projected)
    }
  }

  return { install, uninstall, recordsView }
}
