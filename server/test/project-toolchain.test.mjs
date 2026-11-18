// The per-project toolchain bootstrap: a project's committed manifest installs its pinned Bun
// into that project's volume, a second run is a no-op, and a failed download leaves neither a
// tool directory nor a bin link. Every test is offline: fetch is a stub serving a fixture ZIP.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import {
  bootstrapProjectToolchain,
  bunRelease,
  gateEnvironment,
  MANIFEST_RELATIVE,
  platformOf,
  STAGING_MAX_AGE_MS,
  readProjectManifest,
  TOOLCHAIN_RELATIVE,
  validateManifest,
} from '../project-toolchain.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERSION = '1.4.4'
const NOW = '2026-11-16T12:00:00.000Z'
const BUN_BINARY = Buffer.from('#!/bin/sh\necho 1.4.4\n')

const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-project-toolchain-test-'))
  temps.push(dir)
  return dir
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A project layout: a workspace holding the committed manifest and a separate project volume. */
function project() {
  const parent = temp()
  const workspace = join(parent, 'workspace')
  const volume = join(parent, 'volume')
  mkdirSync(workspace)
  mkdirSync(volume)
  return { parent, workspace, volume }
}

function writeManifest(workspace, manifest) {
  writeFileSync(join(workspace, MANIFEST_RELATIVE), `${JSON.stringify(manifest, null, 2)}\n`)
}

function manifestFor(archive, overrides = {}) {
  return {
    schemaVersion: 1,
    tools: {
      bun: {
        version: VERSION,
        sha256: { 'linux-x64': sha256(archive) },
        ...overrides.bun,
      },
    },
    gate: { command: 'bun run check' },
    ...overrides.top,
  }
}

function fakeFetch(archive, { failure } = {}) {
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    if (failure) throw failure
    return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } })
  }
  return { calls, fetch }
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
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A one-file ZIP in the shape Bun publishes: a directory member then `bun-linux-x64/bun`. */
function zipOf(entries, { method = 8 } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const plain = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '')
    const body = method === 0 ? plain : deflateRawSync(plain)
    const crc = crc32(plain)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(plain.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(plain.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const bunArchive = () => zipOf([
  { name: 'bun-linux-x64/', data: Buffer.alloc(0) },
  { name: 'bun-linux-x64/bun', data: BUN_BINARY },
])
const singleBunArchive = () => zipOf([{ name: 'bun-linux-x64/bun', data: BUN_BINARY }])

/** Everything the second-run test can observe without relying on a clock. */
function snapshot(dir) {
  const entries = []
  const walk = (base, prefix = '') => {
    for (const name of readdirSync(base).sort()) {
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const path = join(base, name)
      const info = lstatSync(path)
      const entry = {
        relative,
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ino: info.ino,
        kind: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'file',
      }
      if (entry.kind === 'symlink') entry.target = readlinkSync(path)
      entries.push(entry)
      if (entry.kind === 'directory') walk(path, relative)
    }
  }
  walk(dir)
  return entries
}

test('a project manifest with Bun installs it into the project volume and exposes bin/bun', async () => {
  const { workspace, volume } = project()
  const archive = bunArchive()
  writeManifest(workspace, manifestFor(archive))
  const stub = fakeFetch(archive)

  const result = await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: stub.fetch,
    now: () => NOW,
  })

  assert.equal(result.state, 'ready')
  assert.equal(result.manifest, join(workspace, MANIFEST_RELATIVE))
  assert.equal(result.root, join(volume, TOOLCHAIN_RELATIVE))
  assert.equal(result.gate.command, 'bun run check')
  assert.deepEqual(result.tools.bun.state, 'installed')
  assert.deepEqual(stub.calls, [`https://github.com/oven-sh/bun/releases/download/bun-v${VERSION}/bun-linux-x64.zip`])

  const target = join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)
  assert.equal(readFileSync(join(target, 'bun')).toString(), BUN_BINARY.toString())
  assert.equal(statSync(join(target, 'bun')).mode & 0o777, 0o755)
  const record = JSON.parse(readFileSync(join(target, '.automagik-install.json'), 'utf8'))
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.tool, 'bun')
  assert.equal(record.version, VERSION)
  assert.equal(record.platform, 'linux-x64')
  assert.equal(record.archiveSha256, sha256(archive))
  assert.equal(record.binarySha256, sha256(BUN_BINARY))
  assert.equal(record.binaryBytes, BUN_BINARY.length)
  assert.equal(record.installedAt, NOW)

  const link = join(volume, TOOLCHAIN_RELATIVE, 'bin', 'bun')
  assert.equal(readlinkSync(link), `../tools/bun/${VERSION}/bun`)
  assert.equal(readFileSync(link).toString(), BUN_BINARY.toString())

  // The workspace only ever held the manifest; every install write landed in the volume.
  assert.deepEqual(readdirSync(workspace), ['.automagik-toolchain.json'])
  assert.deepEqual(readdirSync(join(volume, TOOLCHAIN_RELATIVE)).sort(), ['.staging', 'bin', 'tools'])
  assert.deepEqual(readdirSync(join(volume, TOOLCHAIN_RELATIVE, '.staging')), [])
})

test('a second run changes nothing and never reaches the network', async () => {
  const { workspace, volume } = project()
  const archive = bunArchive()
  writeManifest(workspace, manifestFor(archive))
  await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: fakeFetch(archive).fetch,
    now: () => NOW,
  })
  const before = snapshot(volume)

  const second = fakeFetch(archive, { failure: new Error('the network must not be reached on a second run') })
  const result = await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: second.fetch,
    now: () => '2030-01-01T00:00:00.000Z',
  })

  assert.equal(result.state, 'ready')
  assert.equal(result.tools.bun.state, 'present')
  assert.deepEqual(second.calls, [])
  assert.deepEqual(snapshot(volume), before)
})

test('a new pin installs beside the old version and moves bin/bun to it', async () => {
  const { workspace, volume } = project()
  const first = bunArchive()
  writeManifest(workspace, manifestFor(first))
  await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: fakeFetch(first).fetch,
    now: () => NOW,
  })

  const secondBinary = Buffer.from('#!/bin/sh\necho 1.4.5\n')
  const second = zipOf([{ name: 'bun-linux-x64/bun', data: secondBinary }])
  const manifest = manifestFor(second)
  manifest.tools.bun.version = '1.4.5'
  writeManifest(workspace, manifest)
  const result = await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: fakeFetch(second).fetch,
    now: () => NOW,
  })

  assert.equal(result.tools.bun.state, 'installed')
  assert.equal(result.tools.bun.version, '1.4.5')
  assert.equal(readFileSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', '1.4.4', 'bun')).toString(), BUN_BINARY.toString())
  assert.equal(readFileSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', '1.4.5', 'bun')).toString(), secondBinary.toString())
  assert.equal(readlinkSync(join(volume, TOOLCHAIN_RELATIVE, 'bin', 'bun')), '../tools/bun/1.4.5/bun')
})

test('a stored (uncompressed) release archive also installs', async () => {
  const { workspace, volume } = project()
  const archive = zipOf([{ name: 'bun-linux-x64/bun', data: BUN_BINARY }], { method: 0 })
  writeManifest(workspace, manifestFor(archive))

  const result = await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: fakeFetch(archive).fetch,
  })

  assert.equal(result.tools.bun.state, 'installed')
  assert.equal(readFileSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION, 'bun')).toString(), BUN_BINARY.toString())
})

test('a failed download leaves no half-installed tool', async () => {
  const { workspace, volume } = project()
  writeManifest(workspace, manifestFor(bunArchive()))
  const failure = new Error('connection reset')

  await assert.rejects(
    bootstrapProjectToolchain({
      workspace,
      volume,
      platform: 'linux-x64',
      fetch: fakeFetch(null, { failure }).fetch,
    }),
    /downloading .* failed: connection reset/,
  )

  const target = join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)
  assert.equal(existsSync(target), false, 'no version directory may survive a failed download')
  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'bin', 'bun')), false, 'no bin link may point at a missing tool')
  const staging = join(volume, TOOLCHAIN_RELATIVE, '.staging')
  assert.equal(existsSync(staging) ? readdirSync(staging).length : 0, 0, 'staging must be cleaned')
})

test('a download whose bytes do not match the pin leaves no half-installed tool', async () => {
  const { workspace, volume } = project()
  const served = bunArchive()
  const pinned = manifestFor(served)
  pinned.tools.bun.sha256['linux-x64'] = sha256(Buffer.from('a different release'))
  writeManifest(workspace, pinned)

  await assert.rejects(
    bootstrapProjectToolchain({
      workspace,
      volume,
      platform: 'linux-x64',
      fetch: fakeFetch(served).fetch,
    }),
    /not the pinned/,
  )

  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)), false)
  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'bin', 'bun')), false)
})

test('staging left by an interrupted run is pruned, a live staging directory is kept', async () => {
  const { workspace, volume } = project()
  writeManifest(workspace, manifestFor(bunArchive()))
  const staging = join(volume, TOOLCHAIN_RELATIVE, '.staging')
  const stale = join(staging, 'interrupted')
  const live = join(staging, 'live')
  mkdirSync(stale, { recursive: true })
  mkdirSync(live)
  writeFileSync(join(stale, 'bun.zip'), 'partial download')
  const old = new Date(Date.now() - STAGING_MAX_AGE_MS * 2)
  utimesSync(stale, old, old)

  await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: fakeFetch(bunArchive()).fetch,
  })

  assert.equal(existsSync(stale), false, 'an interrupted staging directory is removed')
  assert.equal(existsSync(live), true, 'a recent staging directory is left alone')
})

test('a project with no manifest does nothing at all', async () => {
  const { workspace, volume } = project()
  const result = await bootstrapProjectToolchain({
    workspace,
    volume,
    platform: 'linux-x64',
    fetch: async () => {
      throw new Error('a project with no manifest must not reach the network')
    },
  })

  assert.equal(result.state, 'absent')
  assert.equal(result.root, null)
  assert.equal(result.gate, null)
  assert.equal(existsSync(join(volume, '.automagik')), false, 'the volume must not be touched')
  assert.deepEqual(readProjectManifest(workspace), { state: 'absent', path: join(workspace, MANIFEST_RELATIVE) })
})

test('a manifest that is not pinned exactly is refused before the volume is touched', async () => {
  const cases = [
    ['a version tag', (manifest) => { manifest.tools.bun.version = 'latest' }, /exact x\.y\.z version/],
    ['a range', (manifest) => { manifest.tools.bun.version = '^1.4.4' }, /exact x\.y\.z version/],
    ['a short digest', (manifest) => { manifest.tools.bun.sha256['linux-x64'] = 'abc' }, /lowercase sha256/],
    ['no platform digest', (manifest) => { manifest.tools.bun.sha256 = {} }, /pin at least one platform/],
    ['an unknown tool', (manifest) => { manifest.tools.node = manifest.tools.bun }, /not a tool this image can install/],
    ['an unknown field', (manifest) => { manifest.tools.bun.channel = 'stable' }, /not a known field/],
    ['no gate', (manifest) => { manifest.gate = {} }, /must be one non-empty command line/],
    ['a multi-line gate', (manifest) => { manifest.gate.command = 'bun run check\nrm -rf /' }, /one non-empty command line/],
  ]
  for (const [label, mutate, expected] of cases) {
    const { workspace, volume } = project()
    const manifest = manifestFor(bunArchive())
    mutate(manifest)
    writeManifest(workspace, manifest)
    await assert.rejects(
      bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: fakeFetch(bunArchive()).fetch }),
      expected,
      label,
    )
    assert.equal(existsSync(join(volume, '.automagik')), false, `${label}: the volume must stay untouched`)
  }
})

test('a platform the manifest does not pin is refused before anything is written', async () => {
  const { workspace, volume } = project()
  const archive = bunArchive()
  writeManifest(workspace, manifestFor(archive, { bun: { sha256: { 'linux-arm64': sha256(archive) } } }))

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: fakeFetch(archive).fetch }),
    /pins no sha256 for linux-x64; nothing was installed/,
  )
  assert.equal(existsSync(join(volume, '.automagik')), false)
})

test('an install root outside the project volume is refused', async () => {
  const { parent, workspace, volume } = project()
  const outside = join(parent, 'outside')
  writeManifest(workspace, manifestFor(bunArchive()))

  await assert.rejects(
    bootstrapProjectToolchain({
      workspace,
      volume,
      platform: 'linux-x64',
      rootPath: outside,
      fetch: fakeFetch(bunArchive()).fetch,
    }),
    /is outside the project volume/,
  )
  assert.equal(existsSync(outside), false)
})

test('a missing project volume is refused, never created', async () => {
  const { parent, workspace } = project()
  const volume = join(parent, 'not-mounted')
  writeManifest(workspace, manifestFor(bunArchive()))
  const stub = fakeFetch(bunArchive())

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: stub.fetch }),
    /does not exist/,
  )
  assert.equal(existsSync(volume), false)
  assert.deepEqual(stub.calls, [])
})

test('a symlinked install root is refused, never followed out of the volume', async () => {
  const { parent, workspace, volume } = project()
  const outside = join(parent, 'outside')
  mkdirSync(outside)
  mkdirSync(join(volume, '.automagik'))
  const { symlinkSync } = await import('node:fs')
  symlinkSync(outside, join(volume, TOOLCHAIN_RELATIVE))
  writeManifest(workspace, manifestFor(bunArchive()))
  const stub = fakeFetch(bunArchive())

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: stub.fetch }),
    /is a symbolic link/,
  )
  assert.deepEqual(stub.calls, [], 'the containment check runs before the network')
  assert.deepEqual(readdirSync(outside), [])
})

test('a symlinked project volume is refused, never followed out of the volume', async () => {
  const { parent, workspace } = project()
  const real = join(parent, 'real-volume')
  mkdirSync(real)
  const volume = join(parent, 'volume-link')
  const { symlinkSync } = await import('node:fs')
  symlinkSync(real, volume)
  writeManifest(workspace, manifestFor(bunArchive()))
  const stub = fakeFetch(bunArchive())

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: stub.fetch }),
    /project volume .* is a symbolic link/,
  )
  assert.deepEqual(stub.calls, [], 'the volume check runs before the network')
  assert.deepEqual(readdirSync(real), [])
})

test('a dangling symlink at the version target is refused before the network', async () => {
  const { parent, workspace, volume } = project()
  const missing = join(parent, 'missing-version')
  const binRoot = join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun')
  mkdirSync(binRoot, { recursive: true })
  const { symlinkSync } = await import('node:fs')
  symlinkSync(missing, join(binRoot, VERSION))
  writeManifest(workspace, manifestFor(bunArchive()))
  const stub = fakeFetch(bunArchive())

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: stub.fetch }),
    /is a symbolic link/,
  )
  assert.deepEqual(stub.calls, [], 'the target check runs before the network')
  assert.equal(existsSync(missing), false)
})

test('a symlinked bin directory is refused, never followed out of the volume', async () => {
  const { parent, workspace, volume } = project()
  const outside = join(parent, 'outside')
  mkdirSync(outside)
  mkdirSync(join(volume, TOOLCHAIN_RELATIVE), { recursive: true })
  const { symlinkSync } = await import('node:fs')
  symlinkSync(outside, join(volume, TOOLCHAIN_RELATIVE, 'bin'))
  writeManifest(workspace, manifestFor(bunArchive()))
  const stub = fakeFetch(bunArchive())

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: stub.fetch }),
    /is a symbolic link/,
  )
  assert.deepEqual(stub.calls, [], 'the containment check runs before the network')
  assert.deepEqual(readdirSync(outside), [])
})

test('a dangling symlink on the install path is refused, never created through', async () => {
  const { parent, workspace, volume } = project()
  const missing = join(parent, 'missing')
  mkdirSync(join(volume, TOOLCHAIN_RELATIVE), { recursive: true })
  const { symlinkSync } = await import('node:fs')
  symlinkSync(missing, join(volume, TOOLCHAIN_RELATIVE, 'tools'))
  writeManifest(workspace, manifestFor(bunArchive()))
  const stub = fakeFetch(bunArchive())

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: stub.fetch }),
    /is a symbolic link/,
  )
  assert.deepEqual(stub.calls, [], 'the containment check runs before the network')
  assert.equal(existsSync(missing), false)
})

const centralOffset = (archive) => archive.readUInt32LE(archive.length - 22 + 16)

test('malformed archives are refused before publication', async () => {
  const cases = [
    ['a duplicate member', () => zipOf([
      { name: 'bun-linux-x64/bun', data: BUN_BINARY },
      { name: 'bun-linux-x64/bun', data: BUN_BINARY },
    ]), /more than once/],
    ['an encrypted member', () => {
      const archive = singleBunArchive()
      const at = centralOffset(archive) + 8
      archive.writeUInt16LE(archive.readUInt16LE(at) | 0x1, at)
      return archive
    }, /is encrypted/],
    ['a zip64 marker', () => {
      const archive = bunArchive()
      archive.writeUInt16LE(0xffff, archive.length - 22 + 8)
      archive.writeUInt16LE(0xffff, archive.length - 22 + 10)
      return archive
    }, /zip64/],
    ['an unsupported compression method', () => {
      const archive = singleBunArchive()
      archive.writeUInt16LE(99, centralOffset(archive) + 10)
      return archive
    }, /unsupported compression/],
    ['an uncompressed-size lie', () => {
      const archive = singleBunArchive()
      archive.writeUInt32LE(BUN_BINARY.length - 1, centralOffset(archive) + 24)
      return archive
    }, /inflates past|not its declared/],
  ]
  for (const [label, build, expected] of cases) {
    const { workspace, volume } = project()
    const archive = build()
    writeManifest(workspace, manifestFor(archive))
    await assert.rejects(
      bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: fakeFetch(archive).fetch }),
      expected,
      label,
    )
    assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)), false, `${label}: nothing installed`)
  }
})

test('an over-large declared download is refused before it is read', async () => {
  const { workspace, volume } = project()
  writeManifest(workspace, manifestFor(bunArchive()))
  const fetch = async () => new Response(bunArchive(), {
    status: 200,
    headers: { 'content-length': String(1024 * 1024) },
  })

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch, maxBytes: 1024 }),
    /declares .* over the 1024 byte limit/,
  )
  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)), false)
})

test('an archive without the expected member is refused and leaves nothing installed', async () => {
  const { workspace, volume } = project()
  const archive = zipOf([{ name: 'bun-linux-x64/README', data: 'not the binary' }])
  writeManifest(workspace, manifestFor(archive))

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: fakeFetch(archive).fetch }),
    /does not contain bun-linux-x64\/bun/,
  )
  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)), false)
  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'bin', 'bun')), false)
})

test('a corrupted archive that matches its pin is refused before it is published', async () => {
  const { workspace, volume } = project()
  const archive = zipOf([{ name: 'bun-linux-x64/bun', data: BUN_BINARY }])
  const body = 30 + Buffer.byteLength('bun-linux-x64/bun')
  archive[body] ^= 0xff
  writeManifest(workspace, manifestFor(archive))

  await assert.rejects(
    bootstrapProjectToolchain({ workspace, volume, platform: 'linux-x64', fetch: fakeFetch(archive).fetch }),
    /could not be extracted|CRC check/,
  )
  assert.equal(existsSync(join(volume, TOOLCHAIN_RELATIVE, 'tools', 'bun', VERSION)), false)
})

test('the repository manifest pins Bun and the real root check', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, MANIFEST_RELATIVE), 'utf8'))
  const manifest = validateManifest(raw)
  assert.equal(manifest.tools.bun.version, '1.4.4')
  assert.match(manifest.tools.bun.sha256['linux-x64'], /^[0-9a-f]{64}$/)
  assert.match(manifest.tools.bun.sha256['linux-arm64'], /^[0-9a-f]{64}$/)
  assert.equal(manifest.gate.command, 'bun run check')
  assert.match(manifest.gate.command, /^bun run check$/, 'the real root check, not a Node equivalent')
})

test('the checked-in schema describes the same closed manifest', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'server', 'project-toolchain.schema.json'), 'utf8'))
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual([...schema.required].sort(), ['gate', 'schemaVersion', 'tools'])
  assert.equal(schema.properties.schemaVersion.const, 1)
  assert.equal(schema.properties.tools.additionalProperties, false)
  assert.equal(schema.properties.tools.properties.bun.additionalProperties, false)
  assert.deepEqual([...schema.properties.tools.properties.bun.required].sort(), ['sha256', 'version'])
  assert.equal(schema.properties.gate.properties.command.pattern, '^\\S(?:[^\\r\\n]*\\S)?$')
})

test('the native worker gets a volume-local Bun and cache on PATH', () => {
  const root = '/data/.automagik/toolchain'
  const env = gateEnvironment(root)
  assert.equal(env.BUN_INSTALL, root)
  assert.equal(env.BUN_INSTALL_CACHE_DIR, `${root}/cache`)
  assert.match(env.PATH, new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin:`))
})

test('the platform is mapped from the image, and unknown platforms are refused', () => {
  assert.equal(platformOf({ platform: 'linux', arch: 'x64' }), 'linux-x64')
  assert.equal(platformOf({ platform: 'linux', arch: 'arm64' }), 'linux-arm64')
  assert.throws(() => platformOf({ platform: 'darwin', arch: 'arm64' }), /Linux tools only/)
  assert.throws(() => platformOf({ platform: 'linux', arch: 'ia32' }), /no Bun build/)
})

test('the Bun release URL is derived from the exact version, never a tag or a caller URL', () => {
  assert.deepEqual(bunRelease('1.4.4', 'linux-x64'), {
    version: '1.4.4',
    platform: 'linux-x64',
    url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip',
    asset: 'bun-linux-x64.zip',
    entry: 'bun-linux-x64/bun',
  })
  assert.equal(bunRelease('1.4.4', 'linux-arm64').entry, 'bun-linux-aarch64/bun')
  assert.throws(() => bunRelease('latest', 'linux-x64'), /no Bun release/)
})
