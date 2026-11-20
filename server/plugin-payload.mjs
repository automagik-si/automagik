// Materialize local install inputs from the image's scanned, unpacked plugin files.
// Archives stay in the writable profile for later installs, never in the image being scanned.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parse, stringify } from 'yaml'
import { readLock } from './profile-lock.mjs'
import { PLUGINS } from './profile-state.mjs'

export { PLUGINS }
const sha512 = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

/** USTAR files, ordered deterministically, with no owner, build path or timestamp metadata. */
export function packPlugin(dir) {
  const blocks = []
  const visit = (folder, relative = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === 'node_modules') continue
      const path = join(folder, entry.name), name = `${relative}${entry.name}`
      if (entry.isDirectory()) { visit(path, `${name}/`); continue }
      if (!entry.isFile()) throw new Error('Unsupported plugin payload entry')
      const content = readFileSync(path), header = Buffer.alloc(512), fullName = `package/${name}`
      let short = fullName, prefix = ''
      if (Buffer.byteLength(short) > 100) {
        const split = fullName.lastIndexOf('/')
        short = fullName.slice(split + 1); prefix = fullName.slice(0, split)
      }
      if (Buffer.byteLength(short) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Plugin payload name is too long')
      header.write(short, 0, 100)
      const octal = (value, offset, size) => {
        const encoded = value.toString(8)
        if (encoded.length >= size) throw new Error('Plugin payload field is too large')
        header.write(`${encoded.padStart(size - 1, '0')}\0`, offset, size)
      }
      octal(lstatSync(path).mode & 0o111 ? 0o755 : 0o644, 100, 8)
      octal(0, 108, 8); octal(0, 116, 8); octal(content.length, 124, 12); octal(0, 136, 12)
      header.fill(32, 148, 156); header[156] = 48
      header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155)
      const sum = header.reduce((total, byte) => total + byte, 0)
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
      blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512))
    }
  }
  visit(dir)
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

/** Remove the previous image's archives only after the manifest and lock stop using them. */
export function pruneImageArchives(profile, previousFiles) {
  const named = new Set()
  const collect = value => {
    if (typeof value === 'string') {
      const refs = /(?:^|(?:^|\()(?:@[\w.-]+\/)?[\w.-]+@)(?:file:)?(?:\.\/)?vendor\/([A-Za-z0-9._-]+\.tgz)(?=$|[()])/g
      for (const [, file] of value.matchAll(refs)) named.add(file)
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        collect(key)
        collect(entry)
      }
    }
  }
  collect(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies)
  collect(readLock(profile))
  for (const file of previousFiles) {
    if (!named.has(file)) rmSync(join(profile, 'vendor', file), { force: true })
  }
}

function replaceInput(path, bytes, stat) {
  const fresh = `${path}.${randomUUID()}.tmp`
  const fd = openSync(fresh, 'wx', stat ? stat.mode & 0o7777 : 0o666)
  try {
    try {
      writeFileSync(fd, bytes)
      if (stat) fchmodSync(fd, stat.mode & 0o7777)
    } finally { closeSync(fd) }
    renameSync(fresh, path)
  } catch (error) {
    rmSync(fresh, { force: true })
    throw error
  }
}

export function materializePlugins({ source, target, previousFiles = [], lock = parse(readFileSync(join(source, 'pnpm-lock.yaml'), 'utf8')) }) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const vendor = join(target, 'vendor'), lockPath = join(target, 'pnpm-lock.yaml')
  const vendorStat = lstatSync(vendor, { throwIfNoEntry: false }), lockStat = lstatSync(lockPath, { throwIfNoEntry: false })
  if (vendorStat && !vendorStat.isDirectory()) throw new Error('Unsupported image profile vendor directory')
  if (lockStat && !lockStat.isFile()) throw new Error('Unsupported image profile lock file')
  const archives = PLUGINS.map(name => {
    const match = /^file:vendor\/([A-Za-z0-9._-]+\.tgz)$/.exec(manifest.dependencies?.[name] ?? '')
    if (!match) throw new Error('Unsupported image plugin source')
    const file = match[1], path = join(vendor, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw new Error('Unsupported image profile archive file')
    const entry = lock?.packages?.[`${name}@file:vendor/${file}`]
    if (entry?.resolution?.tarball !== `file:vendor/${file}`) throw new Error('Unsupported image plugin lock')
    const bytes = packPlugin(join(source, 'node_modules', ...name.split('/')))
    if (stat && !previousFiles.includes(file) && !readFileSync(path).equals(bytes)) throw new Error('Conflicting owner plugin archive')
    entry.resolution.integrity = sha512(bytes)
    return { path, bytes, stat }
  })
  const updatedLock = stringify(lock, { lineWidth: 0 })
  mkdirSync(vendor, { recursive: true })
  for (const { path, bytes, stat } of archives) replaceInput(path, bytes, stat)
  replaceInput(lockPath, updatedLock, lockStat)
}
