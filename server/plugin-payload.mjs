// Materialize local install inputs from the image's scanned, unpacked plugin files.
// Archives stay in the writable profile for later installs, never in the image being scanned.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parse, stringify } from 'yaml'
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

/**
 * After an update, remove earlier images' archives of the three plugins (about 10 MB a
 * release); the backup keeps the old profile's. Any archive the manifest names is kept, and
 * nothing in vendor/ that is not one of the image's plugin archives is touched.
 */
export function pruneImageArchives(profile) {
  const named = new Set(Object.values(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies ?? {})
    .filter(spec => typeof spec === 'string' && spec.startsWith('file:vendor/')).map(spec => spec.slice('file:vendor/'.length)))
  const ours = new RegExp(`^automagik-(?:${PLUGINS.map(name => name.split('/')[1]).join('|')})-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?\\.tgz$`)
  for (const file of readdirSync(join(profile, 'vendor'))) {
    if (ours.test(file) && !named.has(file)) rmSync(join(profile, 'vendor', file))
  }
}

export function materializePlugins({ source, target, lock = parse(readFileSync(join(source, 'pnpm-lock.yaml'), 'utf8')) }) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  mkdirSync(join(target, 'vendor'), { recursive: true })
  for (const name of PLUGINS) {
    const match = /^file:vendor\/([A-Za-z0-9._-]+\.tgz)$/.exec(manifest.dependencies?.[name] ?? '')
    if (!match) throw new Error('Unsupported image plugin source')
    const file = match[1], bytes = packPlugin(join(source, 'node_modules', ...name.split('/')))
    const entry = lock.packages?.[`${name}@file:vendor/${file}`]
    if (entry?.resolution?.tarball !== `file:vendor/${file}`) throw new Error('Unsupported image plugin lock')
    entry.resolution.integrity = sha512(bytes)
    writeFileSync(join(target, 'vendor', file), bytes)
  }
  writeFileSync(join(target, 'pnpm-lock.yaml'), stringify(lock, { lineWidth: 0 }))
}
