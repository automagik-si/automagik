// The member wall's read fence: DSH's sandboxed filesystem (`ctx.fs`), plus a path rule for
// member sessions. It replaces DSH's `fs-sandbox` row (no DSH package is changed).
//
// With `members` off (the default) it is DSH's sandboxed filesystem, unchanged, and adds no
// listener. With `members` on:
// - every tool call and every agent step runs inside its session's scope, so a `ctx.fs` call
//   made for it knows the session (read, read_image, the editor's view, Office, present and
//   skills all read through `ctx.fs`);
// - a member session may only touch paths under its own area (`membersRoot/<name>`) or a
//   shared root, and never under a denied root; the check runs on the path as given and on its
//   real path, so a link out of the area is refused too. To a member, any other path looks
//   absent: a probe finds nothing and a read or a listing fails as not found, so it learns
//   nothing of what is there, and DSH's own probes (a workspace's parents) go on as for a path
//   that does not exist. Writing there is refused;
// - grep and glob search with ripgrep, which never reads through `ctx.fs`, so their search
//   root (real path, against the session's working directory) is checked before they run, and
//   a root with a denied root below it is refused. ripgrep does not follow links below its root.
// Work outside any session (the owner's own interface) and owner sessions are unchanged.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { currentSession, principalOf, sessionOfAgent, sessionScope } from './principals.js'

export const SEARCH_TOOLS = Object.freeze(['grep', 'glob'])

const absolute = z.string().pattern(/^\//)

const WallConfig = z.object({
  members: z.boolean().default(false).description('Members on. Off: DSH\'s sandboxed filesystem, unchanged.'),
  principalsFile: z.string().default('').description('The principal record (mode 0600).'),
  membersRoot: z.string().default('').description('Each member\'s own area is <membersRoot>/<name>.'),
  sharedReadRoots: z.array(absolute).default([]).description('Roots every member may read.'),
  denyReadRoots: z.array(absolute).default([]).description('Roots no member may read; wins over the rest.'),
})

// The real path of a path that may not exist yet: the nearest existing ancestor's real path
// plus the missing rest.
function realish(path) {
  const rest = []
  for (let at = path; ; at = dirname(at)) {
    try {
      return [realpathSync(at), ...rest].join(sep).replace(/\/+/g, '/')
    } catch {
      if (dirname(at) === at) return path
      rest.unshift(basename(at))
    }
  }
}

const under = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

// Both spellings of each root: as configured and as its real path.
const spellings = roots => [...new Set(roots.flatMap(root => [resolve(root), realish(resolve(root))]))]

export function readRule(config) {
  const deny = spellings(config.denyReadRoots)
  const shared = spellings(config.sharedReadRoots)
  return (principal, path) => {
    const area = principal.name !== undefined && config.membersRoot !== ''
      ? spellings([resolve(config.membersRoot, principal.name)])
      : []
    const allowed = [...area, ...shared]
    const fits = candidate => !deny.some(root => under(candidate, root)) && allowed.some(root => under(candidate, root))
    return fits(path) && fits(realish(path))
  }
}

// A search reads a whole tree, so its root must fit and must hold no denied root below it.
export function searchRule(config) {
  const allows = readRule(config)
  const deny = spellings(config.denyReadRoots)
  return (principal, root) => {
    if (!allows(principal, root)) return false
    const real = realish(root)
    return !deny.some(held => under(held, root) || under(held, real))
  }
}

const absent = (what, displayPath) => new FsError(`cannot ${what} "${displayPath}": not found`, 'FS_NOT_FOUND')
const refused = (what, displayPath) => new FsError(
  `cannot ${what} "${displayPath}": outside the files this member may use`, 'FS_SANDBOX_DENIED')

export default class MemberWallFileSystem extends SandboxedFileSystem {
  static Config = z.intersect([LocalFileSystem.Config, WallConfig])

  constructor(ctx, config) {
    super(ctx, config)
    this.wall = config
    if (!config.members) return
    if (!isAbsolute(config.principalsFile)) throw new Error('member wall: members on needs an absolute principalsFile')
    if (!isAbsolute(config.membersRoot)) throw new Error('member wall: members on needs an absolute membersRoot')
    this.allows = readRule(config)
    this.searchable = searchRule(config)
    const inScope = (sessionId, next) => sessionId === undefined ? next() : sessionScope.run({ sessionId }, next)
    // First in each waterfall, so every later listener and the tool body run in the scope.
    ctx.on('tools/execute', (exec, next) => inScope(sessionOfAgent(exec.agent), next), { prepend: true })
    ctx.on('agent/pre-step', (step, next) => inScope(sessionOfAgent(step?.agent), next), { prepend: true })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!SEARCH_TOOLS.includes(exec.name)) return next()
      const sessionId = sessionOfAgent(exec.agent) ?? currentSession()
      if (sessionId === undefined) return next()
      const principal = principalOf(config.principalsFile, sessionId)
      if (principal.kind === 'owner') return next()
      const root = await this.searchRoot(exec)
      if (root === undefined || !this.searchable(principal, root)) {
        return { kind: 'deny', reason: `${exec.name}: outside the files this member may search` }
      }
      return next()
    }, { prepend: true })
  }

  // The search root a grep or glob call would use, or undefined when it cannot be known.
  async searchRoot(exec) {
    const path = exec.arguments?.path
    if (path !== undefined && typeof path !== 'string') return undefined
    if (typeof path === 'string' && isAbsolute(path)) return resolve(path)
    const directories = this.ctx.get('workingDirectory')
    if (exec.agent === undefined || directories === undefined) return undefined
    try {
      const cwd = await directories.ensure(exec.agent, exec.signal)
      return resolve(cwd, path ?? '.')
    } catch {
      return undefined
    }
  }

  // Whether the current work may touch a path: always outside a session, for the owner, and
  // with members off; for a member, only when the path fits its rule.
  open(path) {
    if (!this.wall.members) return true
    const sessionId = currentSession()
    if (sessionId === undefined) return true
    const principal = principalOf(this.wall.principalsFile, sessionId)
    if (principal.kind === 'owner') return true
    return this.allows(principal, path)
  }

  // The target key is the target's real path: what is read is decided by it.
  visible(target) {
    return this.open(String(target.targetKey))
  }

  hide(what, target) {
    if (!this.visible(target)) throw absent(what, target.displayPath)
  }

  deny(what, target) {
    if (!this.visible(target)) throw refused(what, target.displayPath)
  }

  async lstat(path, opts, signal) {
    if (this.wall.members && typeof path === 'string') {
      const spelled = path.startsWith('~') ? (await super.resolve(path, opts)).displayPath : resolve(opts?.cwd ?? this.config.cwd, path)
      if (!this.open(spelled)) return undefined
    }
    return super.lstat(path, opts, signal)
  }

  async stat(target, signal) {
    if (!this.visible(target)) return undefined
    return super.stat(target, signal)
  }

  watch(target, changed, signal) {
    this.hide('watch', target)
    return super.watch(target, changed, signal)
  }

  readText(target, signal) {
    this.hide('read', target)
    return super.readText(target, signal)
  }

  streamText(target, signal) {
    this.hide('read', target)
    return super.streamText(target, signal)
  }

  readBytes(target, signal, maxBytes) {
    this.hide('read', target)
    return super.readBytes(target, signal, maxBytes)
  }

  readByteRange(target, range, signal) {
    this.hide('read', target)
    return super.readByteRange(target, range, signal)
  }

  listDir(target, signal) {
    this.hide('list', target)
    return super.listDir(target, signal)
  }

  writeText(target, content, expected, signal, sandboxPolicy) {
    this.deny('write', target)
    return super.writeText(target, content, expected, signal, sandboxPolicy)
  }

  editText(target, edit, expected, signal, sandboxPolicy) {
    this.deny('edit', target)
    return super.editText(target, edit, expected, signal, sandboxPolicy)
  }

  patchText(target, hunks, expected, signal, sandboxPolicy) {
    this.deny('edit', target)
    return super.patchText(target, hunks, expected, signal, sandboxPolicy)
  }

  deleteFile(target, expected, signal, sandboxPolicy) {
    this.deny('delete', target)
    return super.deleteFile(target, expected, signal, sandboxPolicy)
  }

  moveFile(source, destination, options, signal, sandboxPolicy) {
    this.deny('move', source)
    this.deny('move', destination)
    return super.moveFile(source, destination, options, signal, sandboxPolicy)
  }
}
