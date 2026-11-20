// The member wall's read fence: DSH's sandboxed filesystem (`ctx.fs`), plus a path rule for
// member sessions. It replaces DSH's `fs-sandbox` row (no DSH package is changed).
//
// With `members` off (the default) it is DSH's sandboxed filesystem, unchanged, and adds no
// listener. With `members` on:
// - every tool call and every agent step runs inside its session's scope, so a `ctx.fs` call
//   made for it knows the session (read, read_image, the editor's view, Office, present and
//   skills all read through `ctx.fs`);
// - a member session may only touch paths under its own area (`membersRoot/<name>`) or a
//   shared root, and never under a denied root. The decision is the one rule in paths.js, on
//   the folder a path really reaches on disk, never on its spelling. To a member, any other path looks
//   absent: a probe finds nothing and a read or a listing fails as not found, so it learns
//   nothing of what is there, and DSH's own probes (a workspace's parents) go on as for a path
//   that does not exist. A listing of a folder the member may reach leaves out every child whose
//   resolved target is denied, and every child whose walk crosses a denied folder, so neither a
//   child's name nor its metadata names what it may not read. Writing there is refused;
// - grep and glob search with ripgrep, which never reads through `ctx.fs`, so their search
//   root (as spelled, against the session's working directory) goes through the same rule before
//   they run, and a root with a denied root below it is refused. ripgrep walks the folder the
//   rule decided on and does not follow links below it, so what it finds is inside it;
// - DSH also reads files for a session after a tool's result and at a step's end (instruction
//   files), outside the tool call itself; those reads carry the session's scope too.
// Work outside any session (the owner's own interface) and owner sessions are unchanged.
import { lstatSync, mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { multiuserMode } from '../multiuser.js'
import { BOT_ID } from '../../shared/registry.js'
import { botPrincipalOf, principalOf, scopeSessions, scopeWith, sessionScope } from './principals.js'
import { checkBotConfig, mayUse, rootsOverlap } from './paths.js'

export const SEARCH_TOOLS = Object.freeze(['grep', 'glob'])

const absolute = z.string().pattern(/^\//)

const WallConfig = z.object({
  members: z.boolean().default(false).description('Members on. Off: DSH\'s sandboxed filesystem, unchanged.'),
  principalsFile: z.string().default('').description('The principal record (mode 0600).'),
  membersRoot: z.string().default('').description('Each member\'s own area is <membersRoot>/<name>.'),
  sharedReadRoots: z.array(absolute).default([]).description('Roots every member may read.'),
  denyReadRoots: z.array(absolute).default([]).description('Roots no member may read; wins over the rest.'),
  bots: z.boolean().default(false),
  botsRoot: z.string().default(''),
  botReadRoots: z.dict(z.array(absolute)).default({}),
  botDenyRoots: z.array(absolute).default([]),
  instanceId: z.string().default(''),
})

// An Agent's id is its session's id (dsh-agent); its session carries the same id.
export const sessionOfAgent = agent => agent?.id ?? agent?.session?.id

const absent = (what, displayPath) => new FsError(`cannot ${what} "${displayPath}": not found`, 'FS_NOT_FOUND')
const refused = (what, displayPath, actor = 'member') => new FsError(
  `cannot ${what} "${displayPath}": outside the files this ${actor} may use`, 'FS_SANDBOX_DENIED')
const actorOf = principals => principals.some(({ kind }) => kind === 'bot' || kind === 'none') ? 'Bot' : 'member'
const identityOf = info => `${info.dev}:${info.ino}`

export default class MemberWallFileSystem extends SandboxedFileSystem {
  static Config = z.intersect([LocalFileSystem.Config, WallConfig])

  constructor(ctx, config) {
    super(ctx, config)
    this.wall = config
    if (config.bots && !config.members) throw new Error('member wall: bots on needs members on')
    if (config.bots && !multiuserMode()) throw new Error('member wall: bots on needs AUTOMAGIK_MULTIUSER on')
    if (!config.members) return
    if (!isAbsolute(config.principalsFile)) throw new Error('member wall: members on needs an absolute principalsFile')
    if (!isAbsolute(config.membersRoot)) throw new Error('member wall: members on needs an absolute membersRoot')
    if (config.bots) {
      this.staticBotDenied = checkBotConfig(config)
      this.botsRoot = config.botsRoot.replace(/\/+$/, '') || '/'
      this.botsRootIdentity = identityOf(lstatSync(this.botsRoot))
      this.botWarnings = new Set()
      this.warnPrincipal = (id, message) => ctx.logger.warn('member wall: session %s: %s', id, message)
    }
    const inScope = (sessionId, next) => sessionId === undefined ? next() : sessionScope.run(scopeWith(sessionId), next)
    // First in each waterfall, so every later listener and the tool body run in the scope.
    ctx.on('tools/execute', (exec, next) => inScope(sessionOfAgent(exec.agent), next), { prepend: true })
    ctx.on('agent/pre-step', (step, next) => inScope(sessionOfAgent(step?.agent), next), { prepend: true })
    // DSH reads instruction files for a session from these two events, after the tool call and
    // the step have left their scope. The first listener adds the event's session to the scope of
    // the rest of the event and the work it starts. It can only add: the emitting work keeps the
    // sessions it had, so one session's event inside another's work holds that work to both
    // sessions' rules and never widens it.
    const enter = sessionId => {
      if (sessionId !== undefined && !scopeSessions().includes(sessionId)) sessionScope.enterWith(scopeWith(sessionId))
    }
    ctx.on('tools/result', exec => enter(sessionOfAgent(exec?.agent)), { prepend: true })
    ctx.on('session/event', (session, event) => { if (event?.type === 'step/end') enter(session?.id) }, { prepend: true })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!SEARCH_TOOLS.includes(exec.name)) return next()
      const sessionId = sessionOfAgent(exec.agent)
      const principals = this.principals(sessionId === undefined ? scopeSessions() : scopeWith(sessionId).sessions)
      if (principals.every(principal => principal.kind === 'owner')) return next()
      const operand = exec.arguments?.path
      // Ripgrep resolves a relative operand against the working directory again at spawn.
      if (actorOf(principals) === 'Bot' && typeof operand === 'string' && !isAbsolute(operand)) {
        return { kind: 'deny', reason: `${exec.name}: give an absolute path` }
      }
      const where = await this.searchRoot(exec)
      if (where === undefined || !mayUse(this.decisionConfig(), principals, where.path, where.cwd, { search: true })) {
        return { kind: 'deny', reason: `${exec.name}: outside the files this ${actorOf(principals)} may search` }
      }
      return next()
    }, { prepend: true })
  }

  // The search root a grep or glob call would use, as spelled, with the session's working
  // directory it resolves against; undefined when it cannot be known.
  async searchRoot(exec) {
    const path = exec.arguments?.path ?? '.'
    if (typeof path !== 'string') return undefined
    if (isAbsolute(path)) return { path, cwd: '/' }
    const directories = this.ctx.get('workingDirectory')
    if (exec.agent === undefined || directories === undefined) return undefined
    try {
      return { path, cwd: await directories.ensure(exec.agent, exec.signal) }
    } catch {
      return undefined
    }
  }

  // The principal of each session in a scope.
  principals(sessions) {
    if (this.wall.bots) {
      const botOf = this.service()?.botOf
      const instance = this.wall.instanceId || process.env.AUTOMAGIK_INSTANCE_ID
      return sessions.map(id => botPrincipalOf(this.wall.principalsFile, id, { botOf, instance, warn: this.warnPrincipal }))
    }
    return sessions.map(sessionId => principalOf(this.wall.principalsFile, sessionId))
  }

  service() {
    const service = this.ctx.get('automagikBotSessions')
    return service?.version === 1 ? service : undefined
  }

  warnBotOnce(key, message) {
    if (this.botWarnings.has(key)) return
    this.botWarnings.add(key)
    this.ctx.logger.warn('member wall: %s', message)
  }

  decisionConfig() {
    if (!this.wall.bots) return this.wall
    let protectedRoots
    const roots = () => {
      if (protectedRoots === undefined) {
        try {
          const result = this.service()?.protectedRoots?.()
          const paths = Array.isArray(result) ? [...result] : undefined
          const valid = paths?.length >= 2 && paths.every(root => typeof root === 'string' && isAbsolute(root) && !root.includes('\0'))
          protectedRoots = valid ? paths : ['/']
        } catch {
          protectedRoots = ['/']
        }
      }
      return protectedRoots
    }
    return {
      ...this.wall,
      botDenied: () => [...this.staticBotDenied, ...roots()],
      botGrants: id => (this.wall.botReadRoots[id] ?? []).filter(grant => {
        if (!roots().some(root => rootsOverlap(grant, root))) return true
        this.warnBotOnce(`grant:${id}:${grant}`, `ignoring ${id}'s read grant ${grant}: overlaps a protected root`)
        return false
      }),
      ownBot: id => this.ownFolder(id),
    }
  }

  ownFolder(id) {
    if (!BOT_ID.test(id)) return undefined
    const rootStillOurs = () => {
      const info = lstatSync(this.botsRoot)
      return info.isDirectory() && info.uid === process.getuid?.()
        && (info.mode & 0o022) === 0 && identityOf(info) === this.botsRootIdentity
    }
    const folder = `${this.botsRoot}/${id}`
    try {
      if (rootStillOurs()) {
        try {
          mkdirSync(folder, { mode: 0o700 })
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        const info = lstatSync(folder)
        if (info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && rootStillOurs()) {
          return identityOf(info)
        }
      }
    } catch {}
    this.warnBotOnce(`folder:${id}`, `cannot use ${id}'s own folder ${folder}`)
    return undefined
  }

  // Whether the current work may touch a path: always outside a session and with members off;
  // otherwise only when every session it acts for may (the owner always may).
  open(path, cwd = '/', opts) {
    if (!this.wall.members) return true
    return mayUse(this.decisionConfig(), this.principals(scopeSessions()), path, cwd, opts)
  }

  // The target key is the target's real path and the display path is the walk the kernel takes
  // to it. What is read is decided by both: a target whose walk crosses a denied folder is
  // denied even when the real path it ends on is allowed.
  visible(target, opts) {
    return this.open(String(target.targetKey), '/', opts) && this.open(String(target.displayPath), '/', opts)
  }

  // The fenced methods are async, so a refusal is a rejection, as DSH's own errors are.
  hide(what, target) {
    if (!this.visible(target)) throw absent(what, target.displayPath)
  }

  deny(what, target) {
    if (!this.visible(target)) {
      const actor = this.wall.bots ? actorOf(this.principals(scopeSessions())) : 'member'
      throw refused(what, target.displayPath, actor)
    }
  }

  async lstat(path, opts, signal) {
    if (this.wall.members && typeof path === 'string') {
      // As spelled: DSH's own display path keeps `..` for the disk to walk.
      const spelled = path.startsWith('~') ? (await super.resolve(path, opts)).displayPath : path
      if (!this.open(spelled, opts?.cwd ?? this.config.cwd)) return undefined
    }
    return super.lstat(path, opts, signal)
  }

  async stat(target, signal) {
    if (!this.visible(target)) return undefined
    return super.stat(target, signal)
  }

  async watch(target, changed, signal) {
    this.hide('watch', target)
    return super.watch(target, changed, signal)
  }

  async readText(target, signal) {
    this.hide('read', target)
    return super.readText(target, signal)
  }

  async streamText(target, signal) {
    this.hide('read', target)
    return super.streamText(target, signal)
  }

  async readBytes(target, signal, maxBytes) {
    this.hide('read', target)
    return super.readBytes(target, signal, maxBytes)
  }

  async readByteRange(target, range, signal) {
    this.hide('read', target)
    return super.readByteRange(target, range, signal)
  }

  async listDir(target, signal) {
    this.hide('list', target)
    const entries = await super.listDir(target, signal)
    // Every child is decided on the walk it takes and the target it really reaches, as every
    // other read is: a child that leaves for a denied path, or walks through one, is left out of
    // the listing whole, its name and metadata included, so the listing cannot name what the
    // member may not see.
    return this.wall.members ? entries.filter(entry => this.visible(entry.target)) : entries
  }

  async checkedTarget(target, policy) {
    const fresh = await super.checkedTarget(target, policy)
    if (this.wall.bots) {
      const principals = this.principals(scopeSessions())
      if (!principals.every(({ kind }) => kind === 'owner') && !this.visible(fresh, { write: true })) {
        throw refused('write', fresh.displayPath, actorOf(principals))
      }
    }
    return fresh
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    this.deny('write', target)
    return super.writeText(target, content, expected, signal, sandboxPolicy)
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    this.deny('edit', target)
    return super.editText(target, edit, expected, signal, sandboxPolicy)
  }

  async patchText(target, hunks, expected, signal, sandboxPolicy) {
    this.deny('edit', target)
    return super.patchText(target, hunks, expected, signal, sandboxPolicy)
  }

  async deleteFile(target, expected, signal, sandboxPolicy) {
    this.deny('delete', target)
    return super.deleteFile(target, expected, signal, sandboxPolicy)
  }

  async moveFile(source, destination, options, signal, sandboxPolicy) {
    this.deny('move', source)
    this.deny('move', destination)
    return super.moveFile(source, destination, options, signal, sandboxPolicy)
  }
}
