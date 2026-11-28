import { createHash } from 'node:crypto'
import { isWindowsReservedName } from '../shared/windows-names.js'

export const LIMITS = Object.freeze({
  skillMd: 65536, files: 256, file: 1048576, total: 5242880, pathBytes: 200, depth: 8, description: 1024,
})
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const order = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
export const skillName = value => typeof value === 'string' && value.length <= 32 && /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(value) && value.trim() === value
export const portableKey = value => value.normalize('NFC').toLowerCase()

export function isPortableDeviceName(segment) {
  const base = portableKey(segment).split('.')[0].replace(/[ .]+$/, '')
  return isWindowsReservedName(base) || /^(?:com|lpt)[¹²³]$/.test(base) || ['conin$', 'conout$', 'clock$'].includes(base)
}

export const skillPath = value => typeof value === 'string' && Buffer.byteLength(value) <= LIMITS.pathBytes
  && Buffer.from(value).toString() === value && value.split('/').length <= LIMITS.depth
  && !/[\\<>:"|?*\x00-\x1f\x7f-\x9f]/u.test(value)
  && value.split('/').every(segment => segment && !/[ .]$/.test(segment) && !isPortableDeviceName(segment))

export function fileEntries(files) {
  return files.map(({ path, bytes }) => ({
    path, size: bytes.byteLength, sha256: digest(bytes),
    script: path.startsWith('scripts/') || (bytes[0] === 35 && bytes[1] === 33),
  })).sort(order)
}

export const manifestOf = entries => [...entries].sort(order).map(({ path, size, sha256 }) => JSON.stringify([path, size, sha256]) + '\n').join('')
export const skillHash = entries => digest(manifestOf(entries[0]?.bytes === undefined ? entries : fileEntries(entries)))

export function textSkillMd({ name, description, content }) {
  const quoted = JSON.stringify(description ?? '').replace(/[\u2028\u2029\ufeff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
  return Buffer.from(`---\nname: ${name}\ndescription: ${quoted}\n---\n\n${content ?? ''}\n`)
}

export function textSkillFields(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)\n$/.exec(text)
  if (!match || !skillName(match[1])) throw new SkillFilesChanged()
  const description = JSON.parse(match[2])
  if (typeof description !== 'string') throw new SkillFilesChanged()
  return { name: match[1], description, body: match[3] }
}

export class SkillFilesChanged extends Error {
  constructor() {
    super('Its stored files are missing or changed; save the skill again.')
    this.code = 'files-changed'
  }
}
