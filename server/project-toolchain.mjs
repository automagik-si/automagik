#!/usr/bin/env node
// Per-project toolchain bootstrap. The common server image stays project-agnostic: a project
// commits `.automagik-toolchain.json`, this module reads it and installs exactly those pinned
// tools into that project's own volume, and a native worker then runs the project's real gate
// with the volume's bin directory on PATH.
//
// The module knows a small, closed set of tool installers. Today that is Bun only: the version
// must be exact, the release zip's sha256 must be pinned in the manifest, and both the archive
// and the extracted binary are checked before anything is published. A successful install is a
// marker plus a binary in a versioned directory, renamed into place whole; a second run reads
// the marker and changes nothing. Writes are confined to <volume>/.automagik/toolchain — never
// /opt/automagik, /usr/local, HOME, /tmp or the workspace.
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createInflateRaw } from 'node:zlib'

/** Where a project commits what its gate needs, relative to the project workspace. */
export const MANIFEST_RELATIVE = '.automagik-toolchain.json'
/** Where the bootstrap installs, relative to the project's persistent volume. */
export const TOOLCHAIN_RELATIVE = '.automagik/toolchain'
/** The only manifest shape this module understands. */
export const MANIFEST_SCHEMA_VERSION = 1
/** The install record written inside each versioned tool directory. */
export const INSTALL_RECORD = '.automagik-install.json'
/** Platforms the closed Bun installer can produce a runnable binary for. */
export const SUPPORTED_PLATFORMS = Object.freeze(['linux-x64', 'linux-arm64'])
/** The only tool the common image's bootstrap knows how to install today. */
export const SUPPORTED_TOOLS = Object.freeze(['bun'])
/** A project manifest never needs an archive this large; a stuck or hostile stream stops here. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
/** A staging directory older than this is from an interrupted run, not a live install. */
export const STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** A download that has not finished by now is a failure, not a startup hang. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

const BUN_RELEASES = 'https://github.com/oven-sh/bun/releases/download'
const BUN_ASSET_ARCH = Object.freeze({ 'linux-x64': 'x64', 'linux-arm64': 'aarch64' })
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256 = /^[0-9a-f]{64}$/
const EOCD = 0x06054b50
const CDIR = 0x02014b50
const LOCAL = 0x04034b50

/** A bootstrap failure with a stable code, so callers can distinguish manifest, network and path errors. */
export class ToolchainError extends Error {
  constructor(message, { code = 'toolchain', cause } = {}) {
    super(message, { cause })
    this.name = 'ToolchainError'
    this.code = code
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function manifestError(where, message) {
  return new ToolchainError(`project toolchain manifest ${where}: ${message}`, { code: 'manifest' })
}

function assertOnlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw manifestError(`${where}.${key}`, 'is not a known field')
  }
}

/**
 * Validate a parsed manifest and return the canonical shape the installer consumes. Unknown
 * fields are refused rather than ignored: a misspelled pin must not silently install nothing.
 */
export function validateManifest(value) {
  if (!isRecord(value)) throw manifestError('$', 'must be a JSON object')
  assertOnlyKeys(value, ['$schema', 'schemaVersion', 'tools', 'gate'], '$')
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    throw manifestError('$.$schema', 'must be a string')
  }
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw manifestError('$.schemaVersion', `must be ${MANIFEST_SCHEMA_VERSION}`)
  }
  if (!isRecord(value.tools) || Object.keys(value.tools).length === 0) {
    throw manifestError('$.tools', 'must name at least one tool')
  }
  for (const [name, spec] of Object.entries(value.tools)) {
    if (!SUPPORTED_TOOLS.includes(name)) {
      throw manifestError(`$.tools.${name}`, `is not a tool this image can install (${SUPPORTED_TOOLS.join(', ')})`)
    }
    if (!isRecord(spec)) throw manifestError(`$.tools.${name}`, 'must be an object')
    assertOnlyKeys(spec, ['version', 'sha256'], `$.tools.${name}`)
    if (typeof spec.version !== 'string' || !EXACT_VERSION.test(spec.version)) {
      throw manifestError(`$.tools.${name}.version`, `must be an exact x.y.z version, not ${JSON.stringify(spec.version)}`)
    }
    if (!isRecord(spec.sha256) || Object.keys(spec.sha256).length === 0) {
      throw manifestError(`$.tools.${name}.sha256`, 'must pin at least one platform')
    }
    for (const [platform, digest] of Object.entries(spec.sha256)) {
      if (!SUPPORTED_PLATFORMS.includes(platform)) {
        throw manifestError(`$.tools.${name}.sha256.${platform}`, `is not a supported platform (${SUPPORTED_PLATFORMS.join(', ')})`)
      }
      if (typeof digest !== 'string' || !SHA256.test(digest)) {
        throw manifestError(`$.tools.${name}.sha256.${platform}`, 'must be a lowercase sha256')
      }
    }
  }
  if (!isRecord(value.gate)) throw manifestError('$.gate', 'must name the project gate')
  assertOnlyKeys(value.gate, ['command'], '$.gate')
  if (
    typeof value.gate.command !== 'string' ||
    value.gate.command.trim().length === 0 ||
    value.gate.command.trim() !== value.gate.command ||
    value.gate.command.length > 4096 ||
    /[\r\n]/.test(value.gate.command)
  ) {
    throw manifestError('$.gate.command', 'must be one non-empty command line without leading or trailing whitespace')
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tools: Object.fromEntries(Object.entries(value.tools).map(([name, spec]) => [
      name,
      { version: spec.version, sha256: { ...spec.sha256 } },
    ])),
    gate: { command: value.gate.command },
  }
}

/** The manifest file a project commits, at the one location the bootstrap reads. */
export function manifestFile(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new ToolchainError('project toolchain: a workspace is required', { code: 'path' })
  }
  return join(resolve(workspace), MANIFEST_RELATIVE)
}

/**
 * Read a project's manifest without touching its volume. No manifest is the common case for a
 * project that needs nothing beyond the image, and every caller must treat it as a no-op.
 */
export function readProjectManifest(workspace) {
  const file = manifestFile(workspace)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent', path: file }
    throw new ToolchainError(`project toolchain: cannot read ${file}: ${error?.message ?? error}`, { code: 'manifest', cause: error })
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ToolchainError(`project toolchain: ${file} is not JSON: ${error?.message ?? error}`, { code: 'manifest', cause: error })
  }
  return { state: 'present', path: file, manifest: validateManifest(parsed) }
}

/** The Linux platform name the manifest pins, from this process's platform and architecture. */
export function platformOf({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux') {
    throw new ToolchainError(`project toolchain: this image installs Linux tools only (got ${platform})`, { code: 'platform' })
  }
  if (arch === 'x64') return 'linux-x64'
  if (arch === 'arm64') return 'linux-arm64'
  throw new ToolchainError(`project toolchain: no Bun build for ${platform}-${arch}`, { code: 'platform' })
}

/** The official Bun release artifact for one exact version and platform, including where it sits in the zip. */
export function bunRelease(version, platform) {
  const arch = BUN_ASSET_ARCH[platform]
  if (!EXACT_VERSION.test(String(version)) || !arch) {
    throw new ToolchainError(`project toolchain: no Bun release for ${version} on ${platform}`, { code: 'platform' })
  }
  const asset = `bun-linux-${arch}.zip`
  return {
    version,
    platform,
    url: `${BUN_RELEASES}/bun-v${version}/${asset}`,
    asset,
    entry: `bun-linux-${arch}/bun`,
  }
}

/** Remove staging entries left by an interrupted run; an active install is nowhere near this old. */
function pruneStaging(stagingRoot, now = Date.now()) {
  let names
  try {
    names = readdirSync(stagingRoot)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(stagingRoot, name)
    try {
      const info = lstatSync(path)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      if (now - info.mtimeMs < STAGING_MAX_AGE_MS) continue
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Another process may have removed it between readdir and lstat; nothing to do.
    }
  }
}

/** True when `target` is strictly below `base`, both resolved. */
const inside = (base, target) => {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve the one directory the bootstrap may write. The volume is the boundary: an explicit
 * root (tests, an operator) is accepted only when it stays inside that volume.
 */
export function toolchainRoot({ volume, rootPath } = {}) {
  if (typeof volume !== 'string' || volume.length === 0 || !isAbsolute(volume)) {
    throw new ToolchainError('project toolchain: the project volume must be an absolute path', { code: 'path' })
  }
  const base = resolve(volume)
  if (base === parse(base).root) {
    throw new ToolchainError('project toolchain: refusing to use the filesystem root as the project volume', { code: 'path' })
  }
  let baseInfo
  try {
    baseInfo = lstatSync(base)
  } catch (error) {
    throw new ToolchainError(`project toolchain: the project volume ${base} does not exist`, { code: 'path', cause: error })
  }
  if (baseInfo.isSymbolicLink()) {
    throw new ToolchainError(`project toolchain: the project volume ${base} is a symbolic link; use its real path`, { code: 'path' })
  }
  if (!baseInfo.isDirectory()) throw new ToolchainError(`project toolchain: the project volume ${base} is not a directory`, { code: 'path' })
  const root = rootPath === undefined ? join(base, TOOLCHAIN_RELATIVE) : resolve(rootPath)
  if (!inside(base, root)) {
    throw new ToolchainError(`project toolchain: install root ${root} is outside the project volume ${base}`, { code: 'path' })
  }
  return { volume: base, root }
}

/** Refuse a pre-existing symlink on the way to the install root, so a write cannot be redirected out of the volume. */
function assertNoSymlinkComponents(base, root) {
  const chain = [base]
  let current = base
  for (const part of relative(base, root).split(sep).filter(Boolean)) {
    current = join(current, part)
    chain.push(current)
  }
  for (const path of chain) {
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new ToolchainError(
        `project toolchain: ${path} is a symbolic link; the toolchain writes only inside the project volume's own directories`,
        { code: 'path' },
      )
    }
  }
}

/** The environment a native worker needs to run the project gate against the installed tools. */
export function gateEnvironment(root) {
  const base = resolve(root)
  const path = process.env.PATH ?? ''
  return {
    PATH: `${join(base, 'bin')}${path ? `:${path}` : ''}`,
    BUN_INSTALL: base,
    BUN_INSTALL_CACHE_DIR: join(base, 'cache'),
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function toolError(message, cause) {
  return new ToolchainError(message, { code: 'install', cause })
}

/**
 * Download one pinned archive into the staging directory, hashing the exact bytes written.
 * `fetch` is injectable so tests never touch a host.
 */
async function downloadArchive({ url, file, fetch, maxBytes }) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    throw toolError(`project toolchain: downloading ${url} failed: ${error?.message ?? error}`, error)
  }
  if (!response || response.ok !== true) {
    throw toolError(`project toolchain: ${url} answered ${response?.status ?? 'no response'}${response?.statusText ? ` ${response.statusText}` : ''}`)
  }
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw toolError(`project toolchain: ${url} declares ${declared} bytes, over the ${maxBytes} byte limit`)
  }
  if (!response.body) throw toolError(`project toolchain: ${url} returned no body`)

  const digest = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        callback(toolError(`project toolchain: ${url} passed the ${maxBytes} byte limit`))
        return
      }
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    )
  } catch (error) {
    throw error instanceof ToolchainError ? error : toolError(`project toolchain: downloading ${url} failed: ${error?.message ?? error}`, error)
  }
  return { sha256: digest.digest('hex'), bytes }
}

function readFully(fd, length, position, what) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, position + read)
    if (count === 0) throw toolError(`project toolchain: ${what} is truncated`)
    read += count
  }
  return buffer
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crcUpdate = (crc, buffer) => {
  let value = crc
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return value
}

const crcOf = (crc) => (crc ^ 0xffffffff) >>> 0

/**
 * Extract exactly one named member of a ZIP archive to `destination`, streaming the member and
 * refusing zip64, encryption, unsupported compression, a declared-size lie and a CRC mismatch.
 * The destination is a fixed path owned by the caller, never the member's name, so a hostile
 * archive cannot write outside staging even before its hash is checked.
 */
export async function extractZipEntry({ archive, entry, destination, maxBytes = MAX_ARCHIVE_BYTES }) {
  let fd
  try {
    fd = openSync(archive, 'r')
  } catch (error) {
    throw toolError(`project toolchain: cannot open ${archive}: ${error?.message ?? error}`, error)
  }
  try {
    const size = fstatSync(fd).size
    const tailLength = Math.min(size, 22 + 0xffff)
    if (tailLength < 22) throw toolError(`project toolchain: ${archive} is not a ZIP archive`)
    const tail = readFully(fd, tailLength, size - tailLength, archive)
    let eocd = -1
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) !== EOCD) continue
      // A real end record accounts for the rest of the tail as its comment; an EOCD-looking
      // run inside a comment must not be mistaken for the record.
      if (tail.readUInt16LE(at + 20) !== tail.length - at - 22) continue
      eocd = at
      break
    }
    if (eocd < 0) throw toolError(`project toolchain: ${archive} has no ZIP end record`)
    const disk = tail.readUInt16LE(eocd + 4)
    const directoryDisk = tail.readUInt16LE(eocd + 6)
    const diskCount = tail.readUInt16LE(eocd + 8)
    const count = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (disk !== 0 || directoryDisk !== 0 || diskCount !== count) {
      throw toolError(`project toolchain: ${archive} is a multi-disk ZIP`)
    }
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw toolError(`project toolchain: ${archive} is a zip64 archive`)
    }
    if (directoryOffset + directorySize > size) throw toolError(`project toolchain: ${archive} has a truncated central directory`)
    const directory = readFully(fd, directorySize, directoryOffset, archive)

    let found
    let at = 0
    for (let index = 0; index < count; index++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CDIR) {
        throw toolError(`project toolchain: ${archive} has a corrupt central directory`)
      }
      const flags = directory.readUInt16LE(at + 8)
      const method = directory.readUInt16LE(at + 10)
      const crc = directory.readUInt32LE(at + 16)
      const compressed = directory.readUInt32LE(at + 20)
      const uncompressed = directory.readUInt32LE(at + 24)
      const nameLength = directory.readUInt16LE(at + 28)
      const extraLength = directory.readUInt16LE(at + 30)
      const commentLength = directory.readUInt16LE(at + 32)
      const localOffset = directory.readUInt32LE(at + 42)
      if (at + 46 + nameLength > directory.length) throw toolError(`project toolchain: ${archive} has a corrupt central directory`)
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8')
      if (name === entry) {
        if (found) throw toolError(`project toolchain: ${archive} contains ${entry} more than once`)
        found = { flags, method, crc, compressed, uncompressed, localOffset }
      }
      at += 46 + nameLength + extraLength + commentLength
    }
    if (!found) throw toolError(`project toolchain: ${archive} does not contain ${entry}`)
    if (found.flags & 0x1) throw toolError(`project toolchain: ${entry} is encrypted`)
    if (found.compressed === 0xffffffff || found.uncompressed === 0xffffffff) {
      throw toolError(`project toolchain: ${entry} is zip64`)
    }
    if (![0, 8].includes(found.method)) throw toolError(`project toolchain: ${entry} uses unsupported compression ${found.method}`)
    if (found.uncompressed > maxBytes) throw toolError(`project toolchain: ${entry} is ${found.uncompressed} bytes, over the ${maxBytes} byte limit`)

    const local = readFully(fd, 30, found.localOffset, archive)
    if (local.readUInt32LE(0) !== LOCAL) throw toolError(`project toolchain: ${entry} has a corrupt local header`)
    const localNameLength = local.readUInt16LE(26)
    const localExtraLength = local.readUInt16LE(28)
    const localName = readFully(fd, localNameLength, found.localOffset + 30, archive).toString('utf8')
    if (localName !== entry) throw toolError(`project toolchain: ${entry} has a different name in its local header`)
    const dataStart = found.localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + found.compressed > size) throw toolError(`project toolchain: ${entry} is truncated`)

    const digest = createHash('sha256')
    let written = 0
    let crc = 0xffffffff
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        written += chunk.length
        if (written > found.uncompressed) {
          callback(toolError(`project toolchain: ${entry} inflates past its declared ${found.uncompressed} bytes`))
          return
        }
        crc = crcUpdate(crc, chunk)
        digest.update(chunk)
        callback(null, chunk)
      },
    })
    const sink = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    try {
      if (found.compressed === 0) await pipeline(Readable.from([]), meter, sink)
      else {
        const source = createReadStream(archive, { start: dataStart, end: dataStart + found.compressed - 1 })
        if (found.method === 0) await pipeline(source, meter, sink)
        else await pipeline(source, createInflateRaw({ maxOutputLength: Math.max(found.uncompressed, 1) }), meter, sink)
      }
    } catch (error) {
      throw error instanceof ToolchainError ? error : toolError(`project toolchain: ${entry} could not be extracted: ${error?.message ?? error}`, error)
    }
    if (written !== found.uncompressed) throw toolError(`project toolchain: ${entry} is ${written} bytes, not its declared ${found.uncompressed}`)
    if (crcOf(crc) !== found.crc) throw toolError(`project toolchain: ${entry} failed its CRC check`)
    return { bytes: written, sha256: digest.digest('hex') }
  } finally {
    closeSync(fd)
  }
}

/** A stable identity for one installed version: the manifest pin plus the platform. */
function installRecord({ version, platform, archiveSha256, binary, installedAt }) {
  return {
    schemaVersion: 1,
    tool: 'bun',
    version,
    platform,
    archiveSha256,
    binarySha256: binary.sha256,
    binaryBytes: binary.bytes,
    installedAt,
  }
}

function inspectInstall(target, expected) {
  let targetInfo
  try {
    targetInfo = lstatSync(target)
  } catch {
    return { ok: false, reason: 'it is not installed' }
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    return { ok: false, reason: 'its version path is not a real directory' }
  }
  let record
  try {
    record = JSON.parse(readFileSync(join(target, INSTALL_RECORD), 'utf8'))
  } catch {
    return { ok: false, reason: 'there is no install record' }
  }
  if (
    record?.schemaVersion !== 1 ||
    record.tool !== 'bun' ||
    record.version !== expected.version ||
    record.platform !== expected.platform ||
    record.archiveSha256 !== expected.archiveSha256
  ) {
    return { ok: false, reason: 'its install record does not match the manifest' }
  }
  let binary
  try {
    binary = lstatSync(join(target, 'bun'))
  } catch {
    return { ok: false, reason: 'its Bun binary is missing' }
  }
  if (!binary.isFile()) return { ok: false, reason: 'its Bun path is not a regular file' }
  if (binary.size !== record.binaryBytes) return { ok: false, reason: 'its Bun binary has the wrong size' }
  return { ok: true, record, binary }
}

/** Point <root>/bin/bun at the installed version, replacing a stale link atomically. */
function exposeBinary(root, version) {
  const bin = join(root, 'bin')
  const link = join(bin, 'bun')
  const target = join('..', 'tools', 'bun', version, 'bun')
  assertNoSymlinkComponents(resolve(root), bin)
  mkdirSync(bin, { recursive: true, mode: 0o755 })
  try {
    const existing = lstatSync(link)
    if (existing.isSymbolicLink() && readlinkSync(link) === target) return { state: 'present', link }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const fresh = join(bin, `.bun-${process.pid}-${randomUUID()}`)
  try {
    symlinkSync(target, fresh)
    renameSync(fresh, link)
  } finally {
    rmSync(fresh, { force: true })
  }
  return { state: 'linked', link }
}

/**
 * Install one pinned Bun into `root`. The versioned directory is built under staging and renamed
 * into place only after the archive hash, member CRC, size and binary hash all agree; a failure
 * removes staging and leaves the version directory absent.
 */
export async function installBun({
  root,
  version,
  sha256: pinned,
  platform,
  fetch = globalThis.fetch,
  now = () => new Date().toISOString(),
  maxBytes = MAX_ARCHIVE_BYTES,
  log = () => {},
} = {}) {
  const release = bunRelease(version, platform)
  const archiveSha256 = pinned?.[platform]
  if (!archiveSha256) {
    throw new ToolchainError(`project toolchain: bun ${version} pins no sha256 for ${platform}`, { code: 'manifest' })
  }
  const target = join(root, 'tools', 'bun', version)
  assertNoSymlinkComponents(resolve(root), target)
  assertNoSymlinkComponents(resolve(root), join(root, 'bin'))
  assertNoSymlinkComponents(resolve(root), join(root, '.staging'))
  const current = inspectInstall(target, { version, platform, archiveSha256 })
  if (current.ok) {
    const exposed = exposeBinary(root, version)
    log(`bun ${version}: present at ${target}`)
    return { state: 'present', version, platform, path: join(target, 'bun'), link: exposed.link }
  }

  const stagingRoot = join(root, '.staging')
  assertNoSymlinkComponents(resolve(root), stagingRoot)
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
  pruneStaging(stagingRoot)
  const staging = join(stagingRoot, `${version}-${platform}-${randomUUID()}`)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const archive = join(staging, release.asset)
    const downloaded = await downloadArchive({ url: release.url, file: archive, fetch, maxBytes })
    if (downloaded.sha256 !== archiveSha256) {
      throw toolError(`project toolchain: bun ${version} download is sha256 ${downloaded.sha256}, not the pinned ${archiveSha256}; nothing was installed`)
    }
    const payload = join(staging, 'payload')
    mkdirSync(payload, { mode: 0o700 })
    const binary = join(payload, 'bun')
    const extracted = await extractZipEntry({ archive, entry: release.entry, destination: binary, maxBytes })
    chmodSync(binary, 0o755)
    const record = installRecord({ version, platform, archiveSha256, binary: extracted, installedAt: now() })
    writeFileSync(join(payload, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })

    assertNoSymlinkComponents(resolve(root), target)
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
    let replaced = false
    if (existsSync(target)) {
      const raced = inspectInstall(target, { version, platform, archiveSha256 })
      if (raced.ok) {
        const exposed = exposeBinary(root, version)
        log(`bun ${version}: present at ${target}`)
        return { state: 'present', version, platform, path: join(target, 'bun'), link: exposed.link }
      }
      rmSync(target, { recursive: true, force: true })
      replaced = true
    }
    renameSync(payload, target)
    const exposed = exposeBinary(root, version)
    log(`bun ${version}: installed at ${target}`)
    return { state: replaced ? 'replaced' : 'installed', version, platform, path: join(target, 'bun'), link: exposed.link }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Bootstrap one project. With no manifest this touches neither the volume nor the network. With
 * one, it validates the whole manifest first, then installs every named tool into the project
 * volume and returns the environment and gate a native worker needs.
 */
export async function bootstrapProjectToolchain({
  volume,
  workspace,
  rootPath,
  platform = undefined,
  fetch = globalThis.fetch,
  now = () => new Date().toISOString(),
  maxBytes = MAX_ARCHIVE_BYTES,
  log = () => {},
} = {}) {
  const manifest = readProjectManifest(workspace)
  if (manifest.state === 'absent') {
    log(`project toolchain: no ${MANIFEST_RELATIVE}; nothing to install`)
    return { state: 'absent', manifest: manifest.path, root: null, tools: {}, gate: null }
  }
  const targetPlatform = platform ?? platformOf()
  for (const [name, spec] of Object.entries(manifest.manifest.tools)) {
    if (!spec.sha256[targetPlatform]) {
      throw new ToolchainError(
        `project toolchain: ${name} ${spec.version} pins no sha256 for ${targetPlatform}; nothing was installed`,
        { code: 'manifest' },
      )
    }
  }
  const { volume: base, root } = toolchainRoot({ volume, rootPath })
  assertNoSymlinkComponents(base, root)
  mkdirSync(root, { recursive: true, mode: 0o700 })

  const tools = {}
  for (const [name, spec] of Object.entries(manifest.manifest.tools)) {
    tools[name] = await installBun({
      root,
      version: spec.version,
      sha256: spec.sha256,
      platform: targetPlatform,
      fetch,
      now,
      maxBytes,
      log,
    })
  }
  return {
    state: 'ready',
    manifest: manifest.path,
    root,
    bin: join(root, 'bin'),
    env: gateEnvironment(root),
    tools,
    gate: manifest.manifest.gate,
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      options.help = true
      continue
    }
    if (!['--workspace', '--volume', '--root'].includes(flag)) {
      throw new ToolchainError(`project toolchain: unknown argument ${flag}`, { code: 'usage' })
    }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) {
      throw new ToolchainError(`project toolchain: ${flag} needs a path`, { code: 'usage' })
    }
    options[flag.slice(2)] = value
  }
  return options
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write('usage: project-toolchain.mjs [--workspace <project workspace>] [--volume <project volume>] [--root <install root>]\n')
      process.exitCode = 0
    } else {
      const result = await bootstrapProjectToolchain({
        workspace: options.workspace ?? process.env.AUTOMAGIK_WORKSPACE ?? '/data/workspace',
        volume: options.volume ?? process.env.AUTOMAGIK_HOME ?? '/data',
        rootPath: options.root,
        log: (message) => process.stdout.write(`${message}\n`),
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exitCode = result.state === 'absent' || result.state === 'ready' ? 0 : 1
    }
  } catch (error) {
    process.stderr.write(`project toolchain: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
