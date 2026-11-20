import { gunzipSync } from 'node:zlib'
import { isWindowsReservedName } from '../shared/roles.js'
import { refusal } from './refusal.js'

const BLOCK = 512
const ROOT = 'package/'
const MAX_PATH_BYTES = 200
export const MAX_ROLE_FILES = 512
export const MAX_ROLE_FILE_SIZE = 8 * 1024 * 1024
export const MAX_ROLE_BYTES = 32 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const invalid = detail => refusal(`Invalid role archive (${detail}).`)
const zero = bytes => bytes.every(byte => byte === 0)

export function roleFilePath(path) {
  return typeof path === 'string' && path.length <= MAX_PATH_BYTES - ROOT.length && path.split('/').every(part =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) && !part.endsWith('.') && !isWindowsReservedName(part))
}

function field(bytes) {
  const end = bytes.indexOf(0)
  if (end !== -1 && !zero(bytes.subarray(end))) throw invalid('embedded NUL')
  try { return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end)) } catch { throw invalid('path encoding') }
}

function octal(bytes) {
  const match = /^ *([0-7]+)[\x00 ]*$/.exec(bytes.toString('latin1'))
  if (!match) throw invalid('octal field')
  return Number.parseInt(match[1], 8)
}

function member(header) {
  if (header.toString('latin1', 257, 265) !== 'ustar\x0000') throw invalid('ustar format required')
  let checksum = 0
  for (const [index, byte] of header.entries()) checksum += index >= 148 && index < 156 ? 32 : byte
  if (checksum !== octal(header.subarray(148, 156))) throw invalid('header checksum')

  const type = header[156]
  const directory = type === 53
  if (!directory && type !== 48 && type !== 0) throw invalid('unsupported entry type')
  const size = octal(header.subarray(124, 136))
  if (size > MAX_ROLE_FILE_SIZE || (directory && size !== 0)) throw invalid('entry size')
  const name = field(header.subarray(0, 100))
  const prefix = field(header.subarray(345, 500))
  const full = prefix ? `${prefix}/${name}` : name
  if (!name || !full.startsWith(ROOT) || Buffer.byteLength(full) > MAX_PATH_BYTES) throw invalid('package path')
  const relative = full.slice(ROOT.length)
  const path = directory && relative.endsWith('/') ? relative.slice(0, -1) : relative
  if (!(directory && full === ROOT) && !roleFilePath(path)) throw invalid('package path')
  return { path, size, directory }
}

function registerPath(paths, path, directory) {
  const parts = path === '' ? [] : path.split('/')
  let current = ''
  for (const [index, part] of parts.entries()) {
    current += current ? `/${part}` : part
    const end = index === parts.length - 1
    const key = current.toLowerCase()
    const known = paths.get(key)
    if (known && known.path !== current) throw invalid('case collision')
    if (known && (!known.directory || (end && !directory))) throw invalid('file/directory collision or duplicate file')
    if (end && known?.explicit) throw invalid('duplicate entry')
    if (end || !known) paths.set(key, { path: current, directory: !end || directory, explicit: end })
  }
}

export function readRoleTar(bytes) {
  let tar
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_ROLE_BYTES }) } catch { throw invalid('gzip data or expanded size') }
  const files = new Map()
  const paths = new Map()
  let count = 0
  let root = false
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (zero(header)) {
      const end = tar.subarray(offset + BLOCK)
      if (end.length < BLOCK || end.length % BLOCK !== 0 || !zero(end)) throw invalid('archive termination')
      return files
    }
    if (++count > MAX_ROLE_FILES) throw invalid('entry count')
    const { path, size, directory } = member(header)
    if (path === '') {
      if (root) throw invalid('duplicate package root')
      root = true
    } else {
      registerPath(paths, path, directory)
    }
    const start = offset + BLOCK
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    if (offset > tar.length) throw invalid('truncated entry')
    if (!zero(tar.subarray(start + size, offset))) throw invalid('entry padding')
    if (!directory) files.set(path, tar.subarray(start, start + size))
  }
  throw invalid('truncated archive')
}
