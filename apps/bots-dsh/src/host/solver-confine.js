import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { automagikHomeOf, within as withinPath } from './folders.js'
import { physical, within } from './member-wall/paths.js'
import { pathsIn } from './review-mark.js'

const dshReads = new Set(['read', 'read_image', 'grep', 'glob'])
const dshSearches = new Set(['grep', 'glob'])
const canonical = path => typeof path === 'string' && isAbsolute(path) ? physical(path) : undefined
const contains = (path, root) => withinPath(path, root) || within(path, root)
const strictlyInside = (path, root) => contains(path, root) && !contains(root, path)

function scopeOf(rt, bot) {
  let team
  try { team = canonical(rt.teamFolder?.()) } catch {}
  const folder = canonical(bot.workDir ?? team)
  if (folder === undefined || !statSync(folder).isDirectory()) return undefined
  const data = [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim(),
    automagikHomeOf(process.env.AUTOMAGIK_HOME)].filter(Boolean).map(canonical)
  const signIn = [
    ...['.claude', '.claude.json', '.codex', '.gemini'].map(name => join(homedir(), name)),
    ...(rt.ctx.get?.('acpAgents')?.signInRoots?.() ?? []),
  ].map(canonical)
  if (data.includes(undefined) || signIn.includes(undefined)) return undefined
  return { folder, team, data: [...new Set(data)], signIn: [...new Set(signIn)] }
}

function blockedAt(path, scope, search) {
  const denied = root => contains(path, root) || (search && contains(root, path))
  if (scope.signIn.some(denied)) return true
  return scope.data.some(root => denied(root) && !(scope.team && strictlyInside(scope.team, root)
    && contains(path, scope.team)))
}

function plainPath(spelling, cwd, placed) {
  const full = isAbsolute(spelling) ? spelling : cwd && `${cwd}${sep}${spelling}`
  if (!full || resolve(full) !== placed) return false
  let at = parse(full).root
  const parts = full.slice(at.length).split(process.platform === 'win32' ? /[\\/]/ : '/').filter(Boolean)
  for (const [index, part] of parts.entries()) {
    try {
      at = join(at, part)
      if (lstatSync(at).isSymbolicLink()) return false
    } catch (error) {
      return error?.code === 'ENOENT' && index === parts.length - 1
    }
  }
  return true
}

const unsafePattern = pattern => typeof pattern === 'string'
  && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..'))

export function solverReadPolicy(rt, bot, name, args, cwd, { agentConsumes = false } = {}) {
  const mirror = name === 'acp_tool'
  if (mirror ? !['read', 'search'].includes(args?.kind) : !dshReads.has(name)) return undefined
  const search = mirror ? args.kind === 'search' : dshSearches.has(name)
  const input = mirror ? args.input : args
  const key = search ? 'path' : Object.hasOwn(args ?? {}, 'file_path') ? 'file_path' : 'path'
  const paths = mirror
    ? [...pathsIn(input), ...(Array.isArray(args.locations) ? args.locations.map(at => at?.path) : [])]
    : search && input?.[key] === undefined ? [] : [input?.[key]]
  const held = path => ({ held: { why: 'confine', text: search
    ? `${bot.name} can search only inside its folder, and not a folder that holds the app's data or a sign-in folder: search a subfolder.`
    : `${bot.name} can read and search only inside its folder: ${typeof path === 'string' && path !== '' ? path : 'the requested path'} is outside it.` } })
  if (search && (mirror ? [input?.pattern, input?.glob] : [name === 'glob' ? input?.pattern : input?.include]).some(unsafePattern)) return held()
  if (search && paths.length === 0) paths.push(cwd)
  if (paths.length === 0 || (mirror && input !== null && typeof input !== 'object')) return held()
  try {
    const scope = scopeOf(rt, bot)
    if (scope === undefined) return held()
    let checked
    for (const path of paths) {
      if (typeof path !== 'string' || path === '' || (!isAbsolute(path) && !canonical(cwd))) return held(path)
      const placed = physical(path, cwd)
      if (placed === undefined || !contains(placed, scope.folder) || blockedAt(placed, scope, search)) return held(path)
      if (agentConsumes && !plainPath(path, cwd, placed)) return held(path)
      checked = placed
    }
    return mirror ? {} : { arguments: { ...args, [key]: checked } }
  } catch { return held() }
}

// Use the workspace exception only for data roots. A sign-in root is always protected.
export function solverWorkspace(rt, bot) {
  try {
    const scope = scopeOf(rt, bot)
    if (scope === undefined || blockedAt(scope.folder, scope, true)) return undefined
    return { cwd: realpathSync.native(scope.folder), protectedRoots: [...scope.data, ...scope.signIn],
      signInRoots: scope.signIn, team: scope.team }
  } catch { return undefined }
}

export function claudeDenyPaths(rt, bot) {
  let scope
  try { scope = scopeOf(rt, bot) } catch { return undefined }
  if (scope === undefined) return undefined
  const roots = new Set(scope.signIn)
  for (const root of scope.data) {
    if (!scope.team || !contains(scope.folder, scope.team) || !strictlyInside(scope.team, root)) {
      roots.add(root)
      continue
    }
    try {
      for (let current = scope.team; !contains(root, current); current = dirname(current)) {
        const parent = dirname(current)
        for (const entry of readdirSync(parent)) if (entry !== basename(current)) roots.add(join(parent, entry))
      }
    } catch { return undefined }
  }
  return [...roots].sort()
}
