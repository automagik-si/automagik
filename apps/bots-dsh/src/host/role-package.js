import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_ROLE_CAPABILITIES, BUNDLED_ROLE_HISTORY, BUNDLED_ROLE_IDS, bundleDigest, expectedBundleDigest, manifestBytes } from './bundled-roles.js'
import { compareVersions } from './lane-verify.js'
import { attachedRoleIds, isPackageRoleId, isRoleId, isRoleVersion, ROLES_OFF_REASON, ROLE_SOURCE_UNCONFIRMED, rolesOn } from '../shared/roles.js'
import { isSha256, parseRoleJson, plainObject, ROLE_EVIDENCE_LIMITS, ROLE_PLUGIN_VERSION, roleDescription, roleName, roleToolName, validCapabilities } from './role-catalog.js'
import { MAX_ROLE_BYTES, MAX_ROLE_FILES, MAX_ROLE_FILE_SIZE, readRoleTar, roleFilePath } from './role-tar.js'
import { refusal } from './refusal.js'

const MANIFEST_LIMIT = 64 * 1024
const BUNDLE_LEAVES = new Map([['prompt.md', 16 * 1024], ['role.json', MANIFEST_LIMIT], ['role.mjs', 4096]])
const BUNDLED_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const bundleInvalid = () => refusal('Bundled role files are invalid.')
const filesDiffer = () => refusal('The installed role files differ from the signed package.')
const MANIFEST_FIELDS = new Set(['id', 'version', 'name', 'publisher', 'entry', 'prompt', 'tools', 'capabilities', 'settings', 'ui', 'description', 'requires'])
const invalidManifest = detail => refusal(`Invalid role manifest (${detail}).`)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const evidencePaths = ({ verDir }) => [`${verDir}.tgz`, `${verDir}.roles.json`, `${verDir}.roles.json.sig`]
const privateEvidence = stat => stat && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600)
const moduleDependency = /\b(?:import|require)\b|\bexport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*(?:\*|\{[\s\S]*?\}(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*from\b)/u

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
    && roleToolName(tool.name)
    && typeof tool.description === 'string' && tool.description.length >= 1 && tool.description.length <= 1024
    && plainObject(tool.parameters)) || new Set(tools.map(tool => tool.name)).size !== tools.length) {
    throw invalidManifest('tools')
  }
  if (!validCapabilities(capabilities) || capabilities.length !== entry.capabilities.length
    || !capabilities.every(capability => entry.capabilities.includes(capability))) throw invalidManifest('capabilities')
  if (!Array.isArray(settings) || !Array.isArray(ui)) throw invalidManifest('settings or ui')
  if (ui.length) throw refusal('Role settings and ui are not supported yet.')
  if (settings.length > 8 || !settings.every(setting => plainObject(setting)
    && Object.keys(setting).length === 3 && /^[a-z][a-z0-9-]{0,30}$/.test(setting.key ?? '')
    && typeof setting.key === 'string' && ['voice', 'speed'].includes(setting.kind) && roleName(setting.label))
    || new Set(settings.map(setting => setting.key)).size !== settings.length) {
    throw refusal('These role settings are not supported yet.')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let source, promptText
  try {
    source = decoder.decode(files.get(script))
    promptText = decoder.decode(files.get(prompt))
  } catch { throw invalidManifest('entry or prompt encoding') }
  // Prompt-only packages never evaluate their entry. Executable entries are
  // reviewed, single-module sources. Reject imports and re-exports before evaluating bytes.
  if ((tools.length || settings.length) && moduleDependency.test(source)) throw invalidManifest('entry must be self-contained')
  if (requires !== undefined && (!Array.isArray(requires) || !requires.every(item => typeof item === 'string'))) throw invalidManifest('requires')
  if (requires?.length) throw refusal('Required role features are not supported yet.')
  if (description !== undefined && typeof description !== 'string') throw invalidManifest('description')
  return {
    manifest, entryBytes: files.get(script), prompt: promptText,
    warnings: Object.keys(manifest).filter(key => !MANIFEST_FIELDS.has(key)),
    declarations: {
      name, ...(roleDescription(description) ? { description } : {}),
      tools: tools.map(tool => tool.name), capabilities, verified: true,
    },
  }
}

export { validateManifest as validateRoleManifest }

const ownRecord = (map, id) => map !== null && typeof map === 'object' && Object.hasOwn(map, id)
  && (!Array.isArray(map) || (id !== 'length' && map[id] !== null))
const validRecord = (map, id, record) => plainObject(map) && ownRecord(map, id)
  && isRoleId(id) && plainObject(record) && record.id === id && isRoleVersion(record.version) && isSha256(record.sha256)
const sameFile = (a, b) => a === undefined || b === undefined ? a === b : a.dev === b.dev && a.ino === b.ino

export async function lstat(fs, path) {
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

export function readRegular(fs, path, stat, limit) {
  return readBounded(fs, path, stat, limit, true)
}

const validLeaf = (stat, limit, singleLink) => stat?.isFile() && (!singleLink || stat.nlink === 1)
  && stat.size <= limit

async function readBounded(fs, path, stat, limit, singleLink) {
  if (!validLeaf(stat, limit, singleLink)) return undefined
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await file.stat()
    if (!validLeaf(opened, limit, singleLink) || !sameFile(opened, stat) || opened.size !== stat.size) return undefined
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

// A path relative to a held directory resolves from that inode, even if its
// original name is replaced. Without descriptor-relative traversal, fail closed.
async function readBundleFiles(fs, folder, singleLink) {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) throw bundleInvalid()
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const handles = []
  try {
    let path = '/'
    for (const name of ['', ...folder.split('/').filter(Boolean)]) {
      const handle = await fs.open(join(path, name), flags)
      handles.push(handle)
      path = `/proc/self/fd/${handle.fd}`
      if (!sameFile(await handle.stat(), await fs.stat(path))) throw bundleInvalid()
    }
    const names = await fs.readdir(path)
    if (names.length !== BUNDLE_LEAVES.size || !names.every(name => BUNDLE_LEAVES.has(name))) throw bundleInvalid()
    const leaves = []
    for (const [name, limit] of BUNDLE_LEAVES) {
      const target = join(path, name)
      const stat = await lstat(fs, target)
      if (!validLeaf(stat, limit, singleLink)) throw bundleInvalid()
      leaves.push({ name, target, stat, limit })
    }
    const files = new Map()
    for (const { name, target, stat, limit } of leaves) {
      const data = await readBounded(fs, target, stat, limit, singleLink)
      if (!data) throw bundleInvalid()
      files.set(name, data)
    }
    return files
  } finally {
    await Promise.all(handles.reverse().map(handle => handle.close()))
  }
}

function validateBundle(files, id, version, expected) {
  const manifest = decodeManifest(files.get('role.json'))
  if (manifest.publisher !== 'automagik' || manifest.entry !== 'role.mjs' || manifest.prompt !== 'prompt.md'
    || !['tools', 'settings', 'capabilities', 'ui'].every(key => Array.isArray(manifest[key]) && manifest[key].length === 0)
    || !manifestBytes(manifest).equals(files.get('role.json'))) throw bundleInvalid()
  const details = validateManifest(files, { id, version, publisher: 'automagik', capabilities: [] })
  const sha256 = bundleDigest(files)
  if (!details.prompt.trim() || sha256 !== expected) throw bundleInvalid()
  return { ...details, sha256 }
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

export function createRolePackages(rt, catalog, {
  fs = fsPromises, now = Date.now, bundledRoot = BUNDLED_ROOT, bundledHistory = BUNDLED_ROLE_HISTORY,
} = {}) {
  const { state } = rt
  const statuses = new Map()
  // The install record pins the compressed archive. Keep verified file digests for this
  // host's lazy checks without changing the on-disk record or keeping an archive in memory.
  const fingerprints = new WeakMap()
  // Declarations here also attest that this exact record passed official install admission.
  const verified = new WeakMap()
  const verifiedBundled = record => record?.source === 'bundled' && verified.has(record)
  const runtimeDamage = new WeakMap()
  const warn = (...args) => rt.warn?.(...args)
  const hasRecord = id => Boolean(ownRecord(state.roles, id))
  const recordOf = id => hasRecord(id) ? state.roles[id] : undefined
  const expectRecord = (id, hadRecord, record) => {
    if (Boolean(ownRecord(state.roles, id)) !== hadRecord || !Object.is(recordOf(id), record)) {
      throw refusal('The role install record changed. Try again.')
    }
  }
  const requireWriter = () => {
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw refusal(readOnly, { code: 'bot/read-only' })
    if (rt.holdsLock?.() !== true) throw refusal('This host does not hold the Bot team.')
  }
  const requireRoles = () => {
    if (!rolesOn(state.prefs)) throw refusal('Roles are turned off for this team.', { reason: ROLES_OFF_REASON })
  }
  const requireDetached = id => {
    if (Object.values(state.bots).some(bot => attachedRoleIds(bot).includes(id))) {
      throw refusal('Detach this role from every Bot before uninstalling it.')
    }
  }
  const attachable = (id, record, entry) => isPackageRoleId(id) && (verified.has(record)
    || (record.source !== 'bundled' && entry?.display.installable === true && entry.display.version === record.version
      && entry.sha256 === record.sha256.toLowerCase()))
  const fingerprint = files => new Map([...files].map(([path, data]) => [path, { length: data.length, sha256: digest(data) }]))
  const remember = (record, details, files) => {
    verified.set(record, details.sha256 ? { ...details.declarations, sha256: details.sha256 } : details.declarations)
    fingerprints.set(record, fingerprint(files))
  }
  const expectedDigest = (id, version) => compareVersions(version, ROLE_PLUGIN_VERSION) <= 0
    ? expectedBundleDigest(bundledHistory, id, version) : undefined

  async function bundledSource(id) {
    try {
      const root = await fs.realpath(bundledRoot)
      const files = await readBundleFiles(fs, join(root, 'roles', id), false)
      const { manifest } = validateBundle(files, id, '0.0.0', expectedDigest(id, ROLE_PLUGIN_VERSION))
      return { files, manifest }
    } catch {
      warn('Bundled role %s could not be read or verified.', id)
    }
  }

  function requireOfficial(id, record) {
    if (!attachable(id, record, catalog.entries()?.get(id))) throw refusal(ROLE_SOURCE_UNCONFIRMED)
  }

  async function authenticate(id, record) {
    const bundled = record?.source === 'bundled'
    if (!validRecord(state.roles, id, record) || record.publisher !== 'automagik'
      || (bundled && !BUNDLED_ROLE_IDS.includes(id))) throw refusal('The installed role record is invalid.')
    const term = rt.lockTerm?.()
    const paths = rolePaths(rt.home, id, record.version)
    const currentWriter = () => recordOf(id) === record && rt.holdsLock?.() === true
      && rt.lockTerm?.() === term && rt.readOnly?.() === undefined
    const verifiedDetails = (details, files) => {
      if (currentWriter() && !runtimeDamage.has(record)) {
        remember(record, details, files)
        if (bundled) statuses.set(id, { record, status: 'ok' })
      }
      return details
    }
    if (bundled) {
      let status = 'damaged'
      try {
        const before = await directories(fs, paths)
        if (!before[3]) {
          status = 'broken'
          throw refusal('The installed role folder is missing.')
        }
        try {
          const files = await readBundleFiles(fs, paths.verDir, true)
          const details = validateBundle(files, id, record.version, expectedDigest(id, record.version))
          const after = await directories(fs, paths)
          if (before.every((stat, index) => sameFile(stat, after[index]))) return verifiedDetails(details, files)
        } catch { /* Unreadable or untrusted installed files. */ }
        throw filesDiffer()
      } catch (error) {
        if (currentWriter()) {
          verified.delete(record)
          fingerprints.delete(record)
          statuses.set(id, { record, status })
        }
        throw error
      }
    }
    const before = await directories(fs, paths)
    if (!before[3]) throw refusal('The installed role folder is missing.')
    const [archive, bytes, signature] = await Promise.all(evidencePaths(paths).map(async (path, i) => {
      const stat = await lstat(fs, path)
      if (privateEvidence(stat)) return readRegular(fs, path, stat, ROLE_EVIDENCE_LIMITS[i])
    }))
    if (!archive || !bytes || !signature) throw refusal('The signed role install evidence is missing or unreadable.')
    const entry = catalog.retained(bytes, signature, id)
    if (!entry?.display.installable || entry.display.version !== record.version || entry.source !== record.source
      || entry.sha256 !== record.sha256.toLowerCase() || archive.length !== entry.size || digest(archive) !== entry.sha256) {
      throw refusal('The installed role does not match its signed catalog.')
    }
    const files = readRoleTar(archive)
    const details = validateManifest(files, entry.display)
    const equal = await inspect(fs, paths.verDir, files)
    const after = await directories(fs, paths)
    if (!equal || !before.every((stat, i) => sameFile(stat, after[i]))) throw filesDiffer()
    return verifiedDetails(details, files)
  }

  async function verifyExisting(id, record) {
    requireWriter()
    const term = rt.lockTerm?.()
    const details = await authenticate(id, record)
    requireWriter()
    expectRecord(id, true, record)
    if (rt.lockTerm?.() !== term || runtimeDamage.has(record) || !verified.has(record)) {
      throw refusal(runtimeDamage.get(record)?.reason ?? 'The role install record changed. Try again.')
    }
    return details
  }

  async function requireAttachable(id, record) {
    if (BUNDLED_ROLE_IDS.includes(id) && record) return verifyExisting(id, record)
    const status = await statusOf(id, record)
    if (status === 'broken') throw refusal('The role install is broken. Uninstall it first.')
    if (status !== 'ok') throw refusal('The role install is damaged. Uninstall it first.')
    requireOfficial(id, record)
  }

  function detailsView() {
    const entries = catalog.entries()
    const details = new Map([...(entries ?? [])].map(([id, entry]) => [id, { catalog: entry.details }]))
    for (const [id, record] of Object.entries(state.roles ?? {})) {
      if (!validRecord(state.roles, id, record)) continue
      details.set(id, {
        ...details.get(id),
        installed: {
          version: record.version,
          ...(record.source !== 'bundled' ? { sha256: record.sha256.toLowerCase() } : {}),
          attachable: attachable(id, record, entries?.get(id)),
          ...verified.get(record),
          ...(verifiedBundled(record) && BUNDLED_ROLE_IDS.includes(id) ? { capabilities: BUNDLED_ROLE_CAPABILITIES[id] } : {}),
        },
      })
    }
    return Object.fromEntries(details)
  }

  async function statusOf(id, record) {
    if (!validRecord(state.roles, id, record)) return 'damaged'
    const cached = statuses.get(id)
    if (cached?.record === record) return cached.status
    const pending = { record, status: inspectStatus(id, record).then(status => {
      const current = statuses.get(id)
      if (current !== pending && current?.record === record) return current.status
      if (recordOf(id) === record && current === pending) pending.status = status
      return status
    }) }
    statuses.set(id, pending)
    return pending.status
  }

  async function inspectStatus(id, record) {
    const paths = rolePaths(rt.home, id, record.version)
    const expected = fingerprints.get(record)
    let status
    try {
      if (!(await directories(fs, paths))[3]) {
        status = 'broken'
      } else if (record.source === 'bundled') {
        const files = await readBundleFiles(fs, paths.verDir, true)
        validateBundle(files, id, record.version, expectedDigest(id, record.version))
        status = 'ok'
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
    return status ?? 'damaged'
  }

  async function install(id, prepare) {
    requireWriter()
    requireRoles()
    if (!isPackageRoleId(id)) throw refusal('Unknown role')
    const hadRecord = hasRecord(id)
    const previous = recordOf(id)
    const canBundle = BUNDLED_ROLE_IDS.includes(id)
    if (canBundle && hadRecord) {
      await verifyExisting(id, previous)
      requireRoles()
      return { id, version: previous.version, warnings: [] }
    }
    const bundle = canBundle ? await bundledSource(id) : undefined
    let entry, snapshot, bytes, files
    if (bundle) {
      const version = ROLE_PLUGIN_VERSION
      files = bundle.files
      files.set('role.json', manifestBytes({ ...bundle.manifest, version }))
      entry = { display: { id, version, publisher: 'automagik', capabilities: [] },
        sha256: bundleDigest(files), source: 'bundled' }
    } else {
      snapshot = await catalog.snapshot()
      requireWriter()
      if (!snapshot.view.available) throw refusal('The role catalog is unavailable.')
      entry = snapshot.entries.get(id)
      if (!entry) throw refusal('This role is not in the catalog.')
      if (!entry.display.installable) throw refusal('Community roles cannot be installed yet.')
      if (hadRecord) {
        if (!validRecord(state.roles, id, previous)) throw refusal('The role install is damaged. Uninstall it first.')
        if (previous.version !== entry.display.version) throw refusal('Another version is installed. Uninstall it first.')
        if (previous.sha256.toLowerCase() !== entry.sha256) throw refusal('The installed role conflicts with this package.')
      }
      bytes = await catalog.download(entry)
      if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
        throw refusal('The role download does not match the catalog size or checksum.')
      }
      files = readRoleTar(bytes)
    }
    const { version, publisher } = entry.display
    const { sha256, source } = entry
    const paths = rolePaths(rt.home, id, version)
    const details = validateManifest(files, entry.display)
    const { warnings } = details
    requireWriter()
    await prepare?.(details, sha256)
    const result = { id, version, warnings }
    const admit = () => {
      requireWriter()
      if (canBundle) requireRoles()
      expectRecord(id, hadRecord, previous)
      if (state.roles !== undefined && !plainObject(state.roles)) throw refusal('The role install records are damaged.')
    }
    admit()
    statuses.delete(id)
    const { rolesDir, pkgDir, verDir } = paths
    const evidence = bundle ? [] : [bytes, snapshot.bytes, snapshot.signature]
    const sidecars = bundle ? [] : evidencePaths(paths)
    const addedEvidence = []
    async function retain() {
      for (const [index, path] of sidecars.entries()) {
        const stat = await lstat(fs, path)
        const data = evidence[index]
        if (privateEvidence(stat) && (await readRegular(fs, path, stat, ROLE_EVIDENCE_LIMITS[index]))?.equals(data)) continue
        if (stat) throw refusal('The retained role install evidence conflicts with this package.')
        const stagedEvidence = join(pkgDir, `.evidence-${randomUUID()}`)
        admit()
        try {
          await fs.writeFile(stagedEvidence, data, { flag: 'wx', mode: 0o600 })
          admit()
          // Publish the complete file without replacing evidence owned by an
          // earlier attempt. The staging name is removed before state commits.
          await fs.link(stagedEvidence, path)
          addedEvidence.push(path)
        } finally {
          await fs.unlink(stagedEvidence).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
      }
    }
    const current = await directories(fs, paths).catch(error => {
      if (!hadRecord) throw error
      return undefined
    })
    if (hadRecord || current[3]) {
      let equal = false
      try {
        if (current?.[3] && bundle) {
          const actual = await readBundleFiles(fs, verDir, true)
          equal = [...files].every(([name, data]) => data.equals(actual.get(name)))
        } else if (current?.[3]) equal = await inspect(fs, verDir, files)
      } catch { /* Preserve an unreadable directory. */ }
      admit()
      if (hadRecord) {
        statuses.set(id, { record: previous, status: equal ? 'ok' : current && !current[3] ? 'broken' : 'damaged' })
        if (equal) {
          // The original signed evidence stays valid across catalog releases.
          try { await authenticate(id, previous) } catch { await retain() }
          runtimeDamage.delete(previous)
          remember(previous, details, files)
          return result
        }
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
      await retain()
      await rt.saveCopy(add, {
        beforeCommit: () => {
          try { admit() } catch (error) { refusedBeforeCommit = true; throw error }
        },
        afterWrite: () => {
          add(state)
          if (!bundle) remember(record, details, files)
        },
      })
    } catch (error) {
      if (!renamed && !current[3]) throw error
      if (renamed && refusedBeforeCommit && published) {
        let rolledBack = false
        try {
          const before = await directories(fs, paths)
          admit()
          if (parents.slice(0, 3).every((stat, index) => sameFile(stat, before[index])) && sameFile(published, before[3])) {
            await fs.rm(verDir, { recursive: true })
            for (const path of addedEvidence) await fs.unlink(path).catch(unlinkError => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError
            })
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
          if (!current[2] && rt.holdsLock?.() === true) await prune(fs, pkgDir)
        } catch {
          warn('Role staging cleanup could not finish at %s.', staged)
        }
      }
    }
    if (bundle) {
      requireRoles()
      await verifyExisting(id, record)
      requireRoles()
    }
    return result
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
        afterWrite: () => {
          remove(state)
          verified.delete(record)
          fingerprints.delete(record)
          committed = true
        },
      })
    } catch (error) {
      if (!committed || !paths) throw error
      warn('Role %s was removed from the team. Package folder left at %s.', id, paths.verDir)
      return { removed: false, leftover: paths.verDir }
    }
    if (!paths) return { removed: true }
    try {
      if (!original) throw refusal('The package path is unsafe.')
      if (!original[2]) return { removed: true }
      if (original[3] && !await inspect(fs, paths.verDir)) throw refusal('The package folder contains unsafe entries.')
      const before = await directories(fs, paths)
      requireWriter()
      expectRecord(id, false, undefined)
      requireDetached(id)
      if (!original.every((stat, index) => sameFile(stat, before[index]))) throw refusal('The package folder changed.')
      if (original[3]) await fs.rm(paths.verDir, { recursive: true })
      for (const path of evidencePaths(paths)) {
        const stat = await lstat(fs, path)
        if (stat) await fs.unlink(path)
      }
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
        ...runtimeDamage.get(record),
      }]))
      if (map === state.roles) return Object.fromEntries(projected)
    }
  }

  const damage = (record, reason) => runtimeDamage.set(record, { status: 'damaged', reason })
  return { install, uninstall, recordsView, detailsView, hasRecord, recordOf, expectRecord, requireWriter, requireAttachable, requireOfficial,
    authenticate, verifyExisting, verifiedBundled, damage, damaged: record => runtimeDamage.has(record) }
}
