import fs from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readCommand } from './child.js'
import { OFFICIAL_REGISTRY, profileRegistry, registryOnlyNpmrc } from './release.js'
import { identity, projectedRealpath, regularBytes } from './store.js'

const WORKSPACE = 'pnpm-workspace.yaml'
const STAGE_ONLY = ['lockfiledir', 'modulesdir', 'virtualstoredir', 'workspacedir', 'workspaceprefix', 'dir']
const SHARED = ['storedir', 'cachedir', 'statedir', 'pnpmhomedir', 'globaldir', 'globalbindir']
const SIDE_EFFECTS = new Set(['configdependencies', 'pnpmfile', 'globalpnpmfile', 'hooks', 'enableglobalvirtualstore',
  'globalvirtualstoredir'])
const CONFIG_ENV = /^(npm|pnpm)_config_/i
const SAFETY_SETTINGS = new Set([...SIDE_EFFECTS, ...STAGE_ONLY, ...SHARED,
  'global', 'prefix', 'userconfig', 'globalconfig', 'ignorescripts', 'ignorepnpmfile', 'offline', 'managepackagemanagerversions'])
const keyOf = key => key.replace(/[-_]/g, '').toLowerCase()
function settingsOf(entries) {
  const settings = new Map()
  for (const [key, value] of entries) {
    const normalized = keyOf(key)
    if (SAFETY_SETTINGS.has(normalized) && settings.has(normalized) && settings.get(normalized) !== value) {
      throw new Error('Ambiguous pnpm setting: ' + normalized)
    }
    settings.set(normalized, value)
  }
  return settings
}

export function pnpmSafetyEnv(env) {
  const restrictions = {
    ignore_scripts: 'true', ignore_pnpmfile: 'true', manage_package_manager_versions: 'false', offline: 'true',
  }
  const overrides = new Set(Object.keys(restrictions).map(keyOf))
  const result = Object.fromEntries(Object.entries(env ?? {}).filter(([key]) =>
    !CONFIG_ENV.test(key) || !overrides.has(keyOf(key.replace(CONFIG_ENV, '')))))
  for (const [key, value] of Object.entries(restrictions)) result['npm_config_' + key] = value
  return { ...result, COREPACK_ENABLE_NETWORK: '0' }
}

const isOn = value => value != null && value !== false && !/^(false|0|)$/i.test(value)

function checkSideEffects(settings) {
  for (const key of SIDE_EFFECTS) {
    const value = settings.get(key)
    if (value != null && !(key === 'enableglobalvirtualstore' && !isOn(value))) {
      throw new Error('Unsafe pnpm setting: ' + key)
    }
  }
  if (isOn(settings.get('global'))) throw new Error('Staging requires a local pnpm install')
}

function expand(value, env) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (env[name] === undefined) throw new Error('Unresolved pnpm path setting')
    return env[name]
  })
}

function workspaceSettings(bytes, dshEntry, env) {
  if (!bytes) return new Map()
  // Resolve the YAML parser shipped with DSH from its runtime. The supervisor copy itself has no dependencies.
  const { load, CORE_SCHEMA } = createRequire(dshEntry)('js-yaml')
  const value = load(bytes.toString(), { schema: CORE_SCHEMA })
  if (value == null) return new Map()
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pnpm workspace configuration')
  if (value.packages !== undefined && (!Array.isArray(value.packages) || value.packages.some(path => !['.', './'].includes(path)))) {
    throw new Error('Staging requires a single-profile pnpm workspace')
  }
  const settings = settingsOf(Object.entries(value).map(([key, setting]) => [expand(key, env), setting]))
  for (const key of ['ignorescripts', 'ignorepnpmfile', 'offline']) {
    if (settings.has(key) && settings.get(key) !== true) throw new Error('Unsafe pnpm setting: ' + key)
  }
  for (const key of ['enableglobalvirtualstore', 'managepackagemanagerversions', 'global']) {
    if (settings.has(key) && settings.get(key) !== false) throw new Error('Unsafe pnpm setting: ' + key)
  }
  return settings
}

function rcSettings(path, env) {
  const bytes = regularBytes(projectedRealpath(path), { optional: true })
  const entries = (bytes?.toString() ?? '').split(/[\r\n]+/).map(line => line.trim())
    .filter(line => line && !/^[#;]/.test(line)).map(line => {
      const match = /^([^=\s]+)\s*=\s*(.*)$/.exec(line)
      if (!match || /["'\\;#]/.test(match[1])) throw new Error('Unsupported pnpm rc configuration')
      const key = expand(match[1].replace(/\[\]$/, ''), env)
      const setting = keyOf(key)
      if (!SAFETY_SETTINGS.has(setting)) return [key, match[2]]
      if (match[1].endsWith('[]')) throw new Error('Unsafe pnpm setting: ' + setting)
      const raw = /^(?:"(?:\\.|[^"\\])*"|'[^']*'|[^;#"']*)(?=\s*(?:[;#]|$))/.exec(match[2])?.[0].trim()
      if (raw === undefined || (!raw.startsWith('"') && raw.includes('\\'))) throw new Error('Unsupported pnpm rc configuration')
      const value = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'(.*)'$/, '$1')
      return [key, value]
    })
  return settingsOf(entries)
}

function environmentSettings(env) {
  return settingsOf(Object.entries(env).filter(([key]) => CONFIG_ENV.test(key))
    .map(([key, value]) => [key.replace(CONFIG_ENV, ''), value]))
}

function contains(dir, path) {
  const part = relative(dir, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}

function checkWorkspaceRoot(profileDir) {
  for (let dir = profileDir; ; dir = dirname(dir)) {
    if (identity(join(dir, WORKSPACE))) {
      if (dir !== profileDir) throw new Error('Unsafe staged pnpm write destination: workspace root')
      return
    }
    if (dir === dirname(dir)) return
  }
}

function validateStaging(config, staging, env, inputDir = staging.profileDir) {
  const { profileDir: cwd, root } = staging
  const live = fs.realpathSync(config.profileDir)
  const stage = fs.realpathSync(root)
  const home = env.HOME || homedir()
  const check = (key, value, staysInStage, base = cwd) => {
    if (value == null) return base
    value = expand(value, env)
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid pnpm path setting: ' + key)
    const path = value.startsWith('~/') ? join(home, value.slice(2)) : value
    const target = projectedRealpath(resolve(base, path))
    if (contains(live, target) || (staysInStage && !contains(stage, target))) {
      throw new Error('Unsafe staged pnpm write destination: ' + key)
    }
    return target
  }
  const checkSettings = settings => {
    checkSideEffects(settings)
    for (const key of STAGE_ONLY) check(key, settings.get(key), true)
    const lockfileDir = check('lockfiledir', settings.get('lockfiledir'), true)
    for (const key of SHARED) check(key, settings.get(key), false, lockfileDir)
    const store = expand(settings.get('storedir'), env)
    if (typeof store === 'string' && !isAbsolute(store) && !store.startsWith('~/')) {
      check('storedir', store, true, lockfileDir)
    }
    // pnpm resolves the virtual store from the lockfile directory. Check the
    // modules location at both bases used by its project and hoisting code.
    const modulesDir = settings.get('modulesdir') ?? 'node_modules'
    check('modulesdir', modulesDir, true)
    const modules = check('modulesdir', modulesDir, true, lockfileDir)
    check('virtualstoredir', settings.get('virtualstoredir') ?? join(modules, '.pnpm'), true, lockfileDir)
  }

  check('workspace override', env.NPM_CONFIG_WORKSPACE_DIR ?? env.npm_config_workspace_dir, true)
  checkWorkspaceRoot(live)
  checkWorkspaceRoot(cwd)
  check('pnpm home', env.PNPM_HOME ?? join(env.XDG_DATA_HOME || join(home, '.local/share'), 'pnpm'), false)
  check('pnpm cache home', env.XDG_CACHE_HOME ?? join(home, '.cache'), false)
  check('pnpm state home', env.XDG_STATE_HOME ?? join(home, '.local/state'), false)
  registryOnlyNpmrc(live)
  registryOnlyNpmrc(cwd)

  const inherited = environmentSettings(env)
  const prefix = inherited.get('prefix') ?? env.PREFIX ?? dirname(dirname(process.execPath))
  const configHome = env.XDG_CONFIG_HOME || (process.platform === 'darwin' ? join(home, 'Library/Preferences') : join(home, '.config'))
  const rc = [
    inherited.get('userconfig') ?? join(home, '.npmrc'),
    inherited.get('globalconfig') ?? join(prefix, 'etc/npmrc'),
    join(configHome, 'pnpm/rc'),
  ].map(path => rcSettings(resolve(inputDir, expand(path, env)), env))
  const workspaceBytes = regularBytes(join(inputDir, WORKSPACE), { optional: true })
  const workspace = workspaceSettings(workspaceBytes, config.dshEntry ?? config.command?.[1], env)
  const manifest = JSON.parse(regularBytes(join(inputDir, 'package.json')))
  checkSideEffects(settingsOf(Object.entries(manifest.pnpm ?? {})))
  for (const settings of [...rc, inherited, workspace, new Map([...rc.flatMap(settings => [...settings]), ...inherited, ...workspace])]) {
    checkSettings(settings)
  }
  return { check, checkSettings }
}

async function effectiveSettings(config, staging, env, signal) {
  const { check, checkSettings } = validateStaging(config, staging, env)
  // Only start pnpm after inspecting the config files and the environment directly.
  const options = { cwd: staging.profileDir, env, signal }
  const json = await readCommand('pnpm', ['config', 'list', '--json'], options)
  let value
  try { value = JSON.parse(json.slice(json.indexOf('{'))) } catch { throw new Error('Invalid pnpm configuration') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pnpm configuration')
  const settings = settingsOf(Object.entries(value))
  checkSettings(settings)
  const store = (await readCommand('pnpm', ['store', 'path'], options)).split('\n').at(-1)
  if (!isAbsolute(store)) throw new Error('Invalid pnpm store path')
  check('effective store', store, false)
  return settings
}

export async function installRegistry(config, root, { signal, manager, supervised = true } = {}) {
  const { profileDir } = config
  if (!supervised && !manager?.registries) return profileRegistry(profileDir, config.env)
  const settings = registryOnlyNpmrc(profileDir)
  const probe = fs.mkdtempSync(join(root, 'registry-'))
  const cwd = join(probe, 'profiles', basename(profileDir))
  const staging = { root: probe, profileDir: cwd }
  try {
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
    for (const file of [WORKSPACE, 'package.json']) {
      const bytes = regularBytes(join(profileDir, file), { optional: file === WORKSPACE })
      if (bytes) fs.writeFileSync(join(cwd, file), bytes, { mode: 0o600 })
    }
    if (settings.length) fs.writeFileSync(join(cwd, '.npmrc'), settings.join('\n') + '\n', { mode: 0o600 })
    const env = pnpmSafetyEnv(config.env)
    const registry = supervised
      ? normalizeRegistry((await effectiveSettings(config, staging, env, signal)).get('registry') ?? OFFICIAL_REGISTRY)
      : profileRegistry(profileDir, env)
    if (manager?.registries) {
      const profile = manager.profile
      const packageManager = profile?.packageManager
      if (packageManager?.args?.length) throw new Error('Unsupported plugin manager pnpm arguments')
      const managerEnv = pnpmSafetyEnv(packageManager?.env)
      validateStaging(config, staging, { ...config.env, ...managerEnv })
      // DSH's registry method runs pnpm in this.profile.dir. Give this call a
      // staged profile while keeping the manager's registry and executable settings.
      const stagedManager = Object.create(manager, { profile: { value: {
        ...profile, dir: cwd, packageManager: { command: manager.pnpmCommand, ...packageManager, env: managerEnv },
      } } })
      let answer
      try { answer = await stagedManager.registries() } catch {}
      const configured = answer?.registry ?? answer?.resolved
      if (!supervised) return configured ? normalizeRegistry(configured) : registry
      if (configured && normalizeRegistry(configured) !== registry) {
        throw new Error('The plugin manager and the supervised install use different registries')
      }
    }
    return registry
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

const normalizeRegistry = value => value.trim().replace(/\/+$/, '') + '/'

export function checkWriteDestinations(config, staging, signal) {
  return effectiveSettings(config, staging, pnpmSafetyEnv({ ...config.env, DSH_HOME: staging.root }), signal)
}

export function checkRelinkConfig(config, staging) {
  // Recheck inherited configuration with the environment DSH will use for the live relink.
  validateStaging(config, staging, pnpmSafetyEnv({ ...config.env, DSH_HOME: config.home }), config.profileDir)
}
