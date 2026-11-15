// The member wall's one path rule. Every read, list, search and skill load a member makes is
// decided here, and only here, on the folder the path really reaches, never on its spelling:
// - a path is first walked on disk as the kernel walks it (links followed, then `..`, in
//   order), so a link followed by `..` lands where it really lands; a part that does not exist
//   yet is kept by name, and `..` or `.` after a missing part cannot be placed, so it is refused;
// - a root holds a path when the path's real folder, or one of its folders above, is the very
//   same folder on disk (device and inode) as the root's. So a case or Unicode spelling the
//   disk treats as the same name is the same folder, and `ana` never holds `anabel`;
// - a root that does not exist holds nothing: there is nothing on disk to compare with.
import { realpathSync, statSync } from 'node:fs'
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

const identity = path => {
  try {
    const info = statSync(path)
    return `${info.dev}:${info.ino}`
  } catch {
    return undefined
  }
}

// Whether a real path lies in a root: the same folder on disk at or above the path.
export function within(path, root) {
  const real = physical(root)
  const id = real === undefined ? undefined : identity(real)
  if (id === undefined) return false
  for (let at = path; ; at = dirname(at)) {
    if (identity(at) === id) return true
    if (dirname(at) === at) return false
  }
}

// The roots a principal may read: its own area and the shared roots.
const reach = (config, principal) => [
  ...principal.name !== undefined && config.membersRoot !== '' ? [join(config.membersRoot, principal.name)] : [],
  ...config.sharedReadRoots,
]

// Whether a member may use a path: in its reach, and in no denied root.
export function memberMay(config, principal, spelling, cwd) {
  const path = physical(spelling, cwd)
  if (path === undefined) return false
  if (config.denyReadRoots.some(root => within(path, root))) return false
  return reach(config, principal).some(root => within(path, root))
}

// A search reads a whole tree: its root must be usable and hold no denied root below it.
export function memberMaySearch(config, principal, spelling, cwd) {
  if (!memberMay(config, principal, spelling, cwd)) return false
  const root = physical(spelling, cwd)
  return !config.denyReadRoots.some(denied => {
    const held = physical(denied)
    return held !== undefined && within(held, root)
  })
}
