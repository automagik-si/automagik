// The member wall's one path rule. Every read, list, search and skill load a member makes is
// decided here, and only here, on the folders the path really walks and the folder it reaches,
// never on its spelling alone:
// - a path is first walked on disk as the kernel walks it (links followed, then `..`, in
//   order), so a link followed by `..` lands where it really lands; a part that does not exist
//   yet is kept by name, and `..` or `.` after a missing part cannot be placed, so it is refused;
// - every folder that walk enters is remembered, so a link that crosses a denied folder is
//   denied even when its final target is allowed: what a link walks through is part of what it
//   reaches;
// - a root holds a path when the path's real folder, or one of its folders above, is the very
//   same folder on disk (device and inode) as the root's. So a case or Unicode spelling the
//   disk treats as the same name is the same folder, and `ana` never holds `anabel`;
// - a root that does not exist holds nothing: there is nothing on disk to compare with.
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

// The real path a spelling reaches, or undefined when it cannot be placed.
export function physical(spelling, cwd = '/') {
  if (typeof spelling !== 'string' || spelling.length === 0 || spelling.includes('\0')) return undefined
  const spelled = isAbsolute(spelling) ? spelling : `${cwd}/${spelling}`
  const missing = []
  for (let at = spelled; ; at = dirname(at)) {
    try {
      const real = realpathSync.native(at)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch {
      const name = basename(at)
      if (dirname(at) === at) return undefined
      if (name === '..' || name === '.') return undefined
      if (name !== '') missing.unshift(name)
    }
  }
}

// The real path a spelling walks, with every folder the walk enters, or undefined when it
// cannot be placed. It follows links exactly as the kernel does, in order, and records each
// folder or file the walk lands on, so a link that crosses a denied folder leaves that folder
// in `hops` even when its final target is allowed. A missing tail is kept by name, as in
// physical(); `..` or `.` after a missing part cannot be placed, so the whole walk is refused.
function walk(spelling, cwd = '/') {
  const bad = typeof spelling !== 'string' || spelling.length === 0 || spelling.includes('\0')
  if (bad) return undefined
  const relative = isAbsolute(spelling) ? spelling : `${cwd}/${spelling}`
  const spelled = isAbsolute(relative) ? relative : `${process.cwd()}/${relative}`
  let at = '/'
  let links = 0
  const hops = []
  const missing = []
  const pending = spelled.split('/').filter(part => part !== '')
  while (pending.length > 0) {
    const part = pending.shift()
    if (missing.length > 0) {
      if (part === '..' || part === '.') return undefined
      missing.push(part)
      continue
    }
    if (part === '.' || part === '') continue
    if (part === '..') {
      at = dirname(at)
      continue
    }
    const next = join(at, part)
    let info
    try {
      info = lstatSync(next)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return undefined
      missing.push(part)
      continue
    }
    if (info.isSymbolicLink()) {
      if (++links > 40) return undefined
      let target
      try {
        target = readlinkSync(next)
      } catch {
        return undefined
      }
      if (isAbsolute(target)) at = '/'
      pending.unshift(...target.split('/').filter(piece => piece !== ''))
      continue
    }
    hops.push(next)
    if (info.isDirectory()) {
      at = next
      continue
    }
    if (pending.length > 0) return undefined
    at = next
  }
  return { path: missing.length > 0 ? join(at, ...missing) : at, hops }
}

const identity = path => {
  try {
    const info = statSync(path)
    return `${info.dev}:${info.ino}`
  } catch {
    return undefined
  }
}

// The folder identity of a root, or undefined when it does not exist.
const rootIdentity = root => {
  const real = physical(root)
  return real === undefined ? undefined : identity(real)
}

// Whether a real path lies under a folder identity: at the same folder, or below it.
function under(path, id) {
  if (id === undefined) return false
  for (let at = path; ; at = dirname(at)) {
    if (identity(at) === id) return true
    if (dirname(at) === at) return false
  }
}

// Whether a real path lies in a root: the same folder on disk at or above the path.
export function within(path, root) {
  return under(path, rootIdentity(root))
}

// The roots a principal may read: its own area and the shared roots.
const reach = (config, principal) => [
  ...principal.name !== undefined && config.membersRoot !== '' ? [join(config.membersRoot, principal.name)] : [],
  ...config.sharedReadRoots,
]

// Whether a member may use a path: in its reach, in no denied root, and crossing none. A path
// that walks through a denied folder is denied even when its final target is allowed.
function memberMay(config, principal, spelling, cwd) {
  const path = physical(spelling, cwd)
  const walked = walk(spelling, cwd)
  if (path === undefined || walked === undefined) return false
  const denied = config.denyReadRoots.map(rootIdentity).filter(id => id !== undefined)
  if (denied.some(id => under(path, id))) return false
  if (denied.some(id => walked.hops.some(hop => under(hop, id)))) return false
  return reach(config, principal).some(root => within(path, root))
}

// A search reads a whole tree: its root must be usable and hold no denied root below it.
function memberMaySearch(config, principal, spelling, cwd) {
  if (!memberMay(config, principal, spelling, cwd)) return false
  const root = physical(spelling, cwd)
  return !config.denyReadRoots.some(denied => {
    const held = physical(denied)
    return held !== undefined && within(held, root)
  })
}

// Whether work acting for these principals may use a path (or search from it): the owner
// always; each member only by its own rule. Work for several sessions needs every one of them.
export function mayUse(config, principals, spelling, cwd, { search = false } = {}) {
  const rule = search ? memberMaySearch : memberMay
  return principals.every(principal => principal.kind === 'owner' || rule(config, principal, spelling, cwd))
}
