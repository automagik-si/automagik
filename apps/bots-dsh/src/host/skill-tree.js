import { LIMITS, portableKey, skillPath } from './skill-library-rules.js'

export const SKILL_MD = 'SKILL.md'
export const RAW_MEMBERS = 1024
export const pathOrder = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))
export const treeError = message => Object.assign(new Error(message), { code: 'bot/invalid' })
export const archiveShape = () => treeError('Choose an archive containing a single skill folder with a root SKILL.md.')
const nestedSuffix = /\.(?:zip|tar|gz|tgz|bz2|xz|zst|7z|rar|jar|docx|xlsx|pptx|odt)$/i
const archiveMagic = [
  '504b0304', '504b0506', '1f8b', '425a68', 'fd377a585a00', '28b52ffd',
  '377abcaf271c', '526172211a07', '213c617263683e0a', '213c7468696e3e0a',
].map(hex => Buffer.from(hex, 'hex'))
const tarMagic = Buffer.from('ustar')
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const prefix = (bytes, expected, offset = 0) => bytes.subarray(offset, offset + expected.length).equals(expected)
const nested = path => treeError(`Nested archives are unavailable in skills: ${path}`)
const binary = path => treeError(`Skill files must contain UTF-8 text: ${path}`)

export function treeText(bytes, path) {
  if (archiveMagic.some(magic => prefix(bytes, magic)) || prefix(bytes, tarMagic, 257)) throw nested(path)
  if (bytes.includes(0)) throw binary(path)
  try { return utf8.decode(bytes) } catch { throw binary(path) }
}

export function skippedPath(path) {
  const components = path.split('/')
  return components[0] === '__MACOSX' ||
    components.some(part => part === '.git' || part === '.DS_Store' || part.startsWith('._'))
}

export function treeRegistry() {
  const paths = new Map()
  let total = 0
  let rawCount = 0
  let count = 0

  function register(path, directory, size) {
    if (++rawCount > RAW_MEMBERS) throw treeError('A skill may contain at most 1,024 entries.')
    if (path === '' && directory) {
      if (paths.has('')) throw treeError('A skill contains a duplicate or conflicting path: .')
      paths.set('', {})
      return
    }
    if (!skillPath(path)) throw treeError(`Unsafe skill path: ${path}`)
    const components = path.split('/')
    for (let i = 1; i <= components.length; i++) {
      const spelling = components.slice(0, i).join('/')
      const key = portableKey(spelling)
      const explicit = i === components.length
      const file = explicit && !directory
      const prior = paths.get(key)
      if (prior && (prior.spelling !== spelling || prior.file !== file || (prior.explicit && explicit))) {
        throw treeError(`A skill contains a duplicate or conflicting path: ${path}`)
      }
      paths.set(key, { spelling, file, explicit: explicit || Boolean(prior?.explicit) })
    }
    if (directory) return
    if (size > LIMITS.file || (path === SKILL_MD && size > LIMITS.skillMd)) {
      throw treeError(`A skill file exceeds its size limit: ${path}`)
    }
    total += size
    if (total > LIMITS.total) throw treeError('The skill expands to over 5 MiB.')
    if (nestedSuffix.test(path)) throw nested(path)
  }

  function kept() {
    if (++count > LIMITS.files) throw treeError('A skill may contain at most 256 files.')
  }
  return { register, kept }
}

// Preview and stored documents use exactly the same rules for retained files.
export function validateSkillTree(entries, registry = treeRegistry()) {
  for (const { path, bytes } of entries) {
    registry.register(path, false, bytes.length)
    if (skippedPath(path)) throw treeError(`A skill contains a skipped path: ${path}`)
    registry.kept()
    treeText(bytes, path)
  }
  if (!entries.some(entry => entry.path === SKILL_MD)) throw archiveShape()
  return entries.sort((a, b) => pathOrder(a.path, b.path))
}
