// The Bot's isolated Codex home owns these profiles. A terminal home is never passed here.
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { IMAGE_PROFILE_DESCRIPTION, IMAGE_PROFILE_GRANTS, toToml } from './image.js'

export function chatProfileModesFor(hex) {
  return Object.freeze({
    'read-only': `permission-profile:automagik-read-${hex}`,
    'workspace-write': `permission-profile:automagik-workspace-${hex}`,
  })
}

// setMode takes the first offered id; an older adapter keeps the legacy fallback.
export function chatProfileModes(modes, profiles) {
  return modes?.flatMap(id => profiles[id] === undefined ? [id] : [profiles[id], id])
}

export function gateProfileOf(profiles) {
  const suffix = /^permission-profile:automagik-read-([0-9a-f]{32})$/.exec(profiles?.['read-only'])?.[1]
  if (suffix) return `permission-profile:automagik-gate-${suffix}`
}

const TOP = '# Automagik chat permissions (managed by Automagik)'
const BOTTOM = '# Automagik chat permission profiles (managed by Automagik)'
// The home's default stays Codex's own `:read-only`: a legacy read-only turn (Auto's fallback,
// an older adapter) takes its reads from the default profile, so naming ours there would cut
// that turn off from its own workspace. Our profiles are chosen per turn, by mode. A default
// naming our profile is what an earlier build wrote; it is taken back the same way.
const ownDefault = /^\s*default_permissions\s*=\s*['"](?::read-only|automagik-read-([0-9a-f]{32}))['"]\s*(#.*)?$/
const defaultConfig = () => `${TOP}\ndefault_permissions = ':read-only'\n`

// npm's codex.js picks its native package by this target (@openai/codex bin/codex.js).
const TARGETS = {
  'linux-x64': ['x86_64-unknown-linux-musl', '@openai/codex-linux-x64'],
  'linux-arm64': ['aarch64-unknown-linux-musl', '@openai/codex-linux-arm64'],
  'darwin-x64': ['x86_64-apple-darwin', '@openai/codex-darwin-x64'],
  'darwin-arm64': ['aarch64-apple-darwin', '@openai/codex-darwin-arm64'],
}
/**
 * The folder of Codex's own executable, read-only in both profiles: Linux's sandbox re-runs
 * that binary (bwrap execvp) for every command, and Codex puts its packaged `codex-path`
 * (its own `rg`) on each command's PATH. A packaged layout (`codex-package.json` beside
 * `bin/`) grants that whole layout; npm's JavaScript launcher grants the native layout it
 * starts, found the way the launcher finds it. Undefined when it does not resolve.
 */
export function codexRuntimeRoot(codexPath, { platform = process.platform, arch = process.arch } = {}) {
  if (typeof codexPath !== 'string' || codexPath === '') return undefined
  let real
  try { real = realpathSync(codexPath) } catch { return undefined }
  if (/\.[cm]?js$/.test(real)) {
    const [triple, pkg] = TARGETS[`${platform}-${arch}`] ?? []
    if (triple === undefined) return undefined
    let vendor
    try { vendor = join(dirname(createRequire(real).resolve(`${pkg}/package.json`)), 'vendor') } catch { vendor = join(dirname(real), '..', 'vendor') }
    try { real = realpathSync(join(vendor, triple, 'bin', 'codex')) } catch { return undefined }
  }
  const layout = dirname(dirname(real))
  return existsSync(join(layout, 'codex-package.json')) ? layout : dirname(real)
}

const checked = new Map()
/**
 * Whether Codex can run a command under `profile` from this home: `codex sandbox -P <id> --
 * true` with the chat's own environment, once per executable, grant and profile. A layout this
 * code does not know (a shim, a linked store) fails here, and the chat keeps the legacy modes.
 */
export function canRunProfile(codexPath, profile, { cwd, env, run = execFileSync } = {}) {
  const key = JSON.stringify([codexPath, profile, cwd])
  if (checked.has(key)) return checked.get(key)
  let ok = false
  try {
    run(codexPath, ['sandbox', '-P', profile, '-C', cwd, '--', 'true'], { cwd, env, stdio: 'ignore', timeout: 15_000 })
    ok = true
  } catch {}
  checked.set(key, ok)
  return ok
}

export function gateProfileHolds(codexPath, profile, { cwd, env, canary, control, run = spawnSync }) {
  try {
    const marker = readFileSync(canary, 'utf8')
    const inside = readFileSync(control, 'utf8')
    if (!marker || !inside || marker === inside) return false
    const read = path => run(codexPath, ['sandbox', '-P', profile.replace(/^permission-profile:/, ''),
      '-C', cwd, '--', 'env', 'LC_ALL=C', 'cat', '--', path], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    })
    const positive = read(control)
    if (positive.error || positive.signal || positive.status !== 0 || positive.stdout !== inside) return false
    const negative = read(canary)
    if (negative.error || negative.signal || negative.status !== 1 || negative.stdout !== '') return false
    return String(negative.stderr).split('\n').some(line =>
      line === `cat: ${canary}: Permission denied` || line === `cat: ${canary}: Operation not permitted`)
  } catch { return false }
}

const contains = (root, path) => {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}

// Only the host's physical program store can account for an app-root overlap.
function managedAppRoot(managedClisHome, executable, runtime) {
  if (typeof managedClisHome !== 'string' || !isAbsolute(managedClisHome)) return undefined
  try {
    const app = realpathSync.native(dirname(dirname(managedClisHome)))
    const store = realpathSync.native(managedClisHome)
    if (store === join(app, 'acp', 'clis') && statSync(store).isDirectory()
      && runtime !== store && contains(store, runtime) && contains(store, realpathSync.native(executable))) return app
  } catch {}
}

export function createGateBinding(codexPath, profile, env, canaryRoot, { managedClisHome, run } = {}) {
  const fileIdentity = path => {
    const { dev, ino, size, mtimeMs, ctimeMs } = statSync(path)
    return JSON.stringify([dev, ino, size, mtimeMs, ctimeMs])
  }
  let launchExecutable, launchExecutableId, configPath, launchConfig, launchConfigId
  try {
    launchExecutable = realpathSync(codexPath)
    launchExecutableId = fileIdentity(launchExecutable)
    configPath = join(env.CODEX_HOME, 'config.toml')
    launchConfig = readFileSync(configPath, 'utf8')
    launchConfigId = fileIdentity(configPath)
  } catch { return () => false }
  const proofs = new Map()
  return (effectiveCwd, scope, liveEnv = env) => {
    let canaryDir, controlDir, canary, control
    try {
      if (liveEnv !== env || typeof effectiveCwd !== 'string' || !isAbsolute(effectiveCwd) || !scope || !profile) return false
      const cwd = realpathSync(effectiveCwd)
      if (cwd !== scope.cwd || !statSync(cwd).isDirectory() || !Array.isArray(scope.protectedRoots)
        || !Array.isArray(scope.signInRoots)) return false
      const executable = realpathSync(codexPath)
      if (executable !== launchExecutable || fileIdentity(executable) !== launchExecutableId) return false
      const runtime = codexRuntimeRoot(executable)
      if (runtime === undefined || typeof canaryRoot !== 'string' || typeof env.CODEX_HOME !== 'string') return false
      const protectedRoot = realpathSync(canaryRoot)
      if (!scope.signInRoots.includes(protectedRoot)) return false
      const physicalRuntime = realpathSync.native(runtime)
      const overlapsRuntime = root => contains(physicalRuntime, root) || contains(root, physicalRuntime)
      if (scope.signInRoots.some(root => overlapsRuntime(root) || contains(cwd, root) || contains(root, cwd))) return false
      const app = managedAppRoot(managedClisHome, executable, physicalRuntime)
      const roots = scope.protectedRoots
      for (const root of roots) {
        if (contains(cwd, root) || (root !== app && overlapsRuntime(root))) return false
        if (contains(root, cwd) && (scope.signInRoots.includes(root) || !scope.team
          || root === scope.team || !contains(root, scope.team) || !contains(scope.team, cwd))) return false
      }
      const config = readFileSync(configPath, 'utf8')
      if (config !== launchConfig || fileIdentity(configPath) !== launchConfigId) return false
      const expected = gateGrants(runtime)
      const id = profile.slice('permission-profile:'.length)
      const section = `permissions.${id}.filesystem`
      const lines = config.split(/\r?\n/)
      const headings = lines.map(line => keyOf(headerOf(line) ?? ''))
      const start = headings.indexOf(section)
      if (start < 0 || headings.lastIndexOf(section) !== start) return false
      if (headings.some(header => header.startsWith(section + '.'))) return false
      const end = headings.findIndex((header, index) => index > start && header !== '')
      const actual = lines.slice(start + 1, end < 0 ? undefined : end).map(line => line.trim()).filter(Boolean)
      const grants = Object.entries(expected).map(([key, value]) => `${toToml(key)} = ${toToml(value)}`)
      if (actual.length !== grants.length || grants.some((grant, index) => grant !== actual[index])) return false
      const workspace = statSync(cwd)
      const key = JSON.stringify([cwd, workspace.dev, workspace.ino, roots, scope.signInRoots, scope.team, protectedRoot])
      if (proofs.has(key)) return proofs.get(key)
      canaryDir = mkdtempSync(join(protectedRoot, '.automagik-gate-'))
      controlDir = mkdtempSync(join(cwd, '.automagik-gate-'))
      const writeMarker = dir => {
        const path = join(dir, 'marker')
        writeFileSync(path, randomUUID(), { flag: 'wx', mode: 0o600 })
        return path
      }
      canary = writeMarker(canaryDir)
      control = writeMarker(controlDir)
      const ok = gateProfileHolds(executable, profile, { cwd, env, canary, control, run })
      proofs.set(key, ok)
      return ok
    } catch { return false } finally {
      for (const marker of [canary, control]) if (marker) {
        try { unlinkSync(marker) } catch {}
      }
      for (const dir of [canaryDir, controlDir]) if (dir) {
        try { rmdirSync(dir) } catch {}
      }
    }
  }
}

const gateGrants = runtime => ({
  ':root': 'deny', ':minimal': 'read', ':workspace_roots': 'read',
  ...(runtime === undefined ? {} : { [runtime]: 'read' }),
})

// One source for the restricted base, including the process-local exact-file profiles.
export function restrictedChatGrants(codexHome, access, runtime) {
  const grants = { ':root': 'deny', ':minimal': 'read', ':workspace_roots': access, ':project_roots': 'read' }
  if (access === 'write') Object.assign(grants, { ':tmpdir': 'write', ':slash_tmp': 'write' })
  grants[join(codexHome, 'skills')] = 'read'
  if (runtime !== undefined) grants[runtime] = 'read'
  return grants
}

function profilesConfig(codexHome, hex, runtime) {
  const lines = [BOTTOM]
  for (const [id, description, access] of [
    [`automagik-read-${hex}`, 'Automagik Read only: read the chat workspace', 'read'],
    [`automagik-workspace-${hex}`, 'Automagik Workspace: work in the chat workspace', 'write'],
  ]) {
    lines.push(`[permissions.${id}]`, `description = ${toToml(description)}`, `[permissions.${id}.filesystem]`)
    const grants = restrictedChatGrants(codexHome, access, runtime)
    for (const [key, value] of Object.entries(grants)) lines.push(`${toToml(key)} = ${toToml(value)}`)
  }
  const gate = `automagik-gate-${hex}`
  lines.push(`[permissions.${gate}]`, 'description = "Automagik Solver plan: read the Solver workspace"', `[permissions.${gate}.filesystem]`)
  for (const [key, value] of Object.entries(gateGrants(runtime))) lines.push(`${toToml(key)} = ${toToml(value)}`)
  const id = `automagik-image-${hex}`
  lines.push(`[permissions.${id}]`, `description = ${toToml(IMAGE_PROFILE_DESCRIPTION)}`, `[permissions.${id}.filesystem]`)
  for (const [key, value] of Object.entries(IMAGE_PROFILE_GRANTS)) lines.push(`${toToml(key)} = ${toToml(value)}`)
  return [...lines, ''].join('\n')
}

/** The managed default before any table, and the profiles with their per-home suffix. */
export function chatProfilesConfig(codexHome, hex, runtime) {
  return `${defaultConfig(hex)}\n${profilesConfig(codexHome, hex, runtime)}`
}

// Only the simple names we own matter here; accept quoted names after a Codex rewrite too.
const keyOf = text => text.trim().replace(/["']([\w-]+)["']/g, '$1').replace(/\s*\.\s*/g, '.')
const headerOf = line => line.trim().match(/^\s*\[\[?(.+?)\]\]?\s*(?:#.*)?$/)?.[1]
const ours = key => /^permissions\.automagik-(read|workspace|gate|image)-[0-9a-f]{32}(?:\.|$)/.test(key)
const reserved = key => key.startsWith('permissions.automagik-')

function unmanaged(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const kept = []
  let hex
  let topLevel = true
  let ownTable = false
  for (const line of lines) {
    const content = line.replace(/\r?\n$/, '')
    if (content === TOP || content === BOTTOM) {
      // The blank before our tables was inserted with them.
      if (content === BOTTOM && kept.at(-1)?.trim() === '') kept.pop()
      continue
    }
    const header = headerOf(line)
    if (header !== undefined) {
      topLevel = false
      ownTable = ours(keyOf(header))
      if (ownTable) hex ??= keyOf(header).match(/-([0-9a-f]{32})(?:\.|$)/)?.[1]
    }
    const match = topLevel && content.match(ownDefault)
    if (match) {
      if (match[1] !== undefined) hex ??= match[1]
      continue
    }
    if (ownTable) continue
    kept.push(line)
  }
  return { remaining: kept.join('').replace(/^(?:[\t \r]*\n)+/, ''), hex }
}

function conflicts(text) {
  let table = ''
  for (const line of text.split('\n')) {
    const header = headerOf(line)
    if (header !== undefined) {
      table = keyOf(header)
      if (reserved(table)) return true
      continue
    }
    const match = line.match(/^\s*([^#=]+)=/)
    if (!match) continue
    const key = keyOf(match[1])
    if (table === '' && (key === 'default_permissions' || key === 'permissions' || key.startsWith('permissions.'))) return true
    const full = table ? `${table}.${key}` : key
    if (reserved(full)) return true
  }
  return false
}

/** Refresh only our content. A refused config must never stop a chat from starting. */
export function ensureChatProfiles(codexHome, { platform = process.platform, log, codexPath, verify } = {}) {
  if (platform === 'win32') return undefined
  let temporary
  const warn = message => { try { log?.(message) } catch {} }
  // Without its own executable readable, every command of a profile chat would fail: such a
  // chat keeps the legacy modes instead.
  const runtime = codexRuntimeRoot(codexPath)
  if (codexPath !== undefined && runtime === undefined) {
    warn('Codex chat permission profiles were not written: the Codex executable was not found')
    return undefined
  }
  try {
    const config = join(codexHome, 'config.toml')
    let current = ''
    try { current = readFileSync(config, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const input = current.replace(/^\uFEFF/, '')
    let { remaining, hex } = unmanaged(input)
    if (input.includes('"""') || input.includes("'''") || conflicts(remaining)) {
      warn('Codex chat permission profiles were not written: conflicting config')
      return undefined
    }
    hex ??= randomBytes(16).toString('hex')
    if (remaining && !remaining.endsWith('\n')) remaining += '\n'
    const next = `${defaultConfig(hex)}${remaining}\n${profilesConfig(codexHome, hex, runtime)}`
    if (next !== current) {
      mkdirSync(codexHome, { recursive: true })
      temporary = `${config}.${randomUUID()}.tmp`
      writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, config)
      temporary = undefined
      // Another process may have written its own suffix at the same moment: the file decides.
      const written = unmanaged(readFileSync(config, 'utf8').replace(/^﻿/, '')).hex
      if (written === undefined) {
        warn('Codex chat permission profiles were not written: config changed while written')
        return undefined
      }
      hex = written
    }
    // The written profile must run a command here, or the chat keeps the legacy modes.
    if (verify !== undefined && verify(`automagik-read-${hex}`) !== true) {
      warn('Codex chat permission profiles were not used: Codex could not run a command under them')
      return undefined
    }
    return chatProfileModesFor(hex)
  } catch {
    warn('Codex chat permission profiles were not written: config unavailable')
    return undefined
  } finally {
    if (temporary !== undefined) try { rmSync(temporary, { force: true }) } catch {}
  }
}
