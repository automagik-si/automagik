import fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readCommand } from './child.js'
import { OFFICIAL_REGISTRY, registryOnlyNpmrc } from './release.js'
import { identity, projectedRealpath } from './store.js'

async function readSettings(cwd, env, signal) {
  // The installed DSH CLI runs pnpm from PATH with this cwd and environment.
  // Let pnpm interpret YAML, rc precedence and environment substitutions.
  const json = await readCommand('pnpm', ['config', 'list', '--json'], { cwd, env, signal })
  let settings
  try { settings = JSON.parse(json.slice(json.indexOf('{'))) } catch {
    // pnpm 10 may include authentication settings in this output.
    throw new Error('Invalid pnpm configuration')
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid pnpm configuration')
  return new Map(Object.entries(settings).map(([key, value]) => [key.replaceAll('-', '').toLowerCase(), value]))
}

export async function installRegistry(profileDir, env = process.env, signal) {
  registryOnlyNpmrc(profileDir)
  const settings = await readSettings(profileDir, env, signal)
  const registry = settings.get('registry') ?? OFFICIAL_REGISTRY
  return registry.trim().replace(/\/+$/, '') + '/'
}

function contains(dir, path) {
  const part = relative(dir, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}

const STAGE_ONLY = ['lockfiledir', 'modulesdir', 'virtualstoredir', 'workspacedir', 'workspaceprefix', 'dir']
const SHARED = ['storedir', 'globalvirtualstoredir', 'cachedir', 'statedir', 'pnpmhomedir', 'globaldir', 'globalbindir']

export async function checkWriteDestinations(config, staging, signal) {
  const cwd = staging.profileDir
  const env = { ...config.env, DSH_HOME: staging.root }
  const root = fs.realpathSync(staging.root)
  const live = fs.realpathSync(config.profileDir)
  const home = env.HOME || homedir()
  const check = (key, value, staysInStage, base = cwd) => {
    if (value == null) return base
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid pnpm path setting: ' + key)
    const path = value.startsWith('~/') ? join(home, value.slice(2)) : value
    const target = projectedRealpath(resolve(base, path))
    if (contains(live, target) || (staysInStage && !contains(root, target))) {
      throw new Error('Unsafe staged pnpm write destination: ' + key)
    }
    return target
  }
  const workspaceOverride = env.NPM_CONFIG_WORKSPACE_DIR ?? env.npm_config_workspace_dir
  check('workspace override', workspaceOverride, true)
  if (workspaceOverride === undefined) {
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (identity(join(dir, 'pnpm-workspace.yaml'))) {
        check('workspace root', dir, true)
        break
      }
      if (dir === dirname(dir)) break
    }
  }
  check('pnpm home', env.PNPM_HOME ?? join(env.XDG_DATA_HOME || join(home, '.local/share'), 'pnpm'), false)
  check('pnpm cache home', env.XDG_CACHE_HOME ?? join(home, '.cache'), false)
  check('pnpm state home', env.XDG_STATE_HOME ?? join(home, '.local/state'), false)
  const settings = await readSettings(cwd, env, signal)
  if ([true, 'true'].includes(settings.get('global'))) throw new Error('Staging requires a local pnpm install')
  for (const key of STAGE_ONLY) check(key, settings.get(key), true)
  const lockfileDir = check('lockfiledir', settings.get('lockfiledir'), true)
  for (const key of SHARED) check(key, settings.get(key), false, lockfileDir)
  const modules = check('modulesdir', settings.get('modulesdir') ?? 'node_modules', true)
  check('virtualstoredir', settings.get('virtualstoredir') ?? join(modules, '.pnpm'), true, lockfileDir)
  // Resolve pnpm's implicit store after checking the explicitly configured paths.
  const store = (await readCommand('pnpm', ['store', 'path'], { cwd, env, signal })).split('\n').at(-1)
  if (!isAbsolute(store)) throw new Error('Invalid pnpm store path')
  check('effective store', store, false)
}
