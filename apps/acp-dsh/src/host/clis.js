// Required desktop tools, installed beside the ACP adapters in Automagik's own home.
// Only official packages are requested, at the registry's latest non-prerelease version.
// The package manager checks tarball integrity; no dependency install script runs. We use
// the platform package's native executable directly, without writing global bins or settings.
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { batchSafe } from './batch-spawn.js'
import { isExecutable } from './agents.js'
import { CliHomes, HOME_ENV } from './cli-homes.js'
import { AdapterStore, latestVersion, runInstall } from './install.js'

export const CLI_CHECK_EVERY_MS = 15 * 60 * 1000
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const folderOf = pkg => pkg.replace(/^@/, '').replace(/\//g, '__')
const writeJson = (file, value) => {
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
export const clisHome = (env = process.env) => join(env.AUTOMAGIK_HOME || join(homedir(), '.automagik'), 'acp', 'clis')

export function compareCliVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const delta = Number(a.split('.')[i]) - Number(b.split('.')[i])
    if (delta) return Math.sign(delta)
  }
  return 0
}

/** Only --version is read; this never starts login or runs an agent turn. */
export function cliVersion(path, { env = process.env, run = execFile, signal } = {}) {
  return new Promise(resolve => {
    try {
      run(...batchSafe(path, ['--version'], {
        env: { ...env, DISABLE_UPDATES: '1' }, cwd: env[HOME_ENV],
        signal, timeout: 8000, maxBuffer: 16_384, windowsHide: true,
      }), (error, stdout) => {
        const version = String(stdout ?? '').trim().match(/^(?:claude(?: code)?|codex(?:-cli)?)?\s*(\d+\.\d+\.\d+)(?=\s|$)/i)?.[1]
        resolve(!error && VERSION.test(version ?? '') ? version : undefined)
      })
    } catch { resolve(undefined) }
  })
}

export function cliPlatform({ platform = process.platform, arch = process.arch, musl = platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime, translated } = {}) {
  if (platform === 'darwin' && arch === 'x64') {
    // A desktop started under Rosetta still needs ARM Claude: its x64 build requires AVX.
    if (translated === undefined) {
      try { translated = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1' } catch { translated = false }
    }
    if (translated) arch = 'arm64'
  }
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(`Claude Code and Codex do not support ${platform}/${arch}`)
  return { platform, arch, musl }
}

export function cliLayout(spec, version, platform = cliPlatform()) {
  const { platform: os, arch, musl } = platform
  const suffix = `${os}-${arch}`
  const exe = os === 'win32' ? '.exe' : ''
  if (spec.key === 'claude') {
    const pkg = `@anthropic-ai/claude-code-${suffix}${os === 'linux' && musl ? '-musl' : ''}`
    return { pkg, dependency: version, bins: [join('node_modules', ...pkg.split('/'), `claude${exe}`)] }
  }
  const pkg = `@openai/codex-${suffix}`
  const triple = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-${os === 'darwin' ? 'apple-darwin' : os === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`
  const root = join('node_modules', ...pkg.split('/'), 'vendor', triple)
  return { pkg, dependency: `npm:@openai/codex@${version}-${suffix}`, bins: [join(root, 'bin', `codex${exe}`), join(root, 'codex', `codex${exe}`)] }
}

export async function installCli(dir, spec, version, env, { signal, platform = cliPlatform(), run = runInstall } = {}) {
  // A desktop always supplies its own pnpm. Never borrow or mutate a person's global tools.
  if (!env.AUTOMAGIK_PNPM || !isExecutable(env.AUTOMAGIK_PNPM)) throw new Error('The desktop package manager is unavailable; restart Automagik and retry the CLI installation.')
  const layout = cliLayout(spec, version, platform)
  // The platform binary is an explicit dependency too: an optional-download failure must
  // fail this install, rather than publish a launcher that has nothing to run.
  writeJson(join(dir, 'package.json'), {
    name: 'automagik-required-cli', private: true,
    dependencies: { [spec.cliPackage]: version, [layout.pkg]: layout.dependency },
    pnpm: { supportedArchitectures: { os: [platform.platform], cpu: [platform.arch], libc: [platform.musl ? 'musl' : 'glibc'] } },
  })
  // Scope mappings in a user's npmrc must not redirect these official packages elsewhere.
  // This file belongs only to this staging directory; the person's npmrc stays untouched.
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org\n@anthropic-ai:registry=https://registry.npmjs.org\n@openai:registry=https://registry.npmjs.org\n', { mode: 0o600 })
  await run(env.AUTOMAGIK_PNPM, ['install', '--prod', '--ignore-scripts', '--config.node-linker=hoisted', '--config.ignore-workspace=true', '--config.registry=https://registry.npmjs.org', `--config.userconfig=${join(dir, '.npmrc')}`, '--config.optional=true', '--reporter=silent'], {
    cwd: dir, env: { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, signal,
  })
}

export class CliStore extends AdapterStore {
  constructor({ env = process.env, home = clisHome(env), latest = latestVersion,
    install = installCli, versionOf = cliVersion, versionEnv, platform, installId, ...options } = {}) {
    super({ ...options, home, env, latest, install })
    this.versionOf = versionOf
    // Registry/package-manager environment stays separate. Only CLI queries use these homes.
    if (versionEnv === undefined) {
      this.versionHomes = new CliHomes(join(dirname(home), 'cli-homes'), { installId })
      versionEnv = spec => this.versionHomes.environment(spec.key, env)
    }
    this.versionEnv = versionEnv
    this.platform = platform
    this.external = new Map()
    this.selected = new Map()
    this.checked = new Map()
    this.rechecks = new Map()
  }

  binOf(pkg, spec) {
    const folder = join(this.home, folderOf(pkg))
    let versions
    try { versions = readdirSync(folder).filter(name => /^\d+\.\d+\.\d+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name)).map(directory => ({ directory, version: directory.split('-')[0] })) } catch { return undefined }
    // Publication is the atomic rename of a verified staging folder. Select the highest
    // completed version, so two desktop processes can never race a shared pointer backwards.
    versions.sort((a, b) => compareCliVersions(b.version, a.version))
    for (const { version, directory } of versions) {
      let layout
      try { layout = cliLayout(spec, version, this.platform ?? cliPlatform()) } catch { return undefined }
      const path = layout.bins.map(bin => join(folder, directory, bin)).find(isExecutable)
      if (path) return { path, version, managed: true }
    }
    return undefined
  }

  find(spec, external) {
    const selected = this.selected.get(spec.cliPackage)
    if (selected && isExecutable(selected.path) && (selected.managed || selected.path === external)) return selected
    // A restart while offline must not fall back to an older global CLI after a managed
    // upgrade. Reuse the verified managed copy until discovery can compare the user's CLI.
    return this.binOf(spec.cliPackage, spec) ?? (external ? { path: external, managed: false } : undefined)
  }

  ensure(spec, external, { force = false } = {}) {
    this.external.set(spec.cliPackage, external)
    const busy = this.running.get(spec.cliPackage)
    if (force && busy) {
      // A plugin update can land after this job read the registry. Its required fresh check
      // must not disappear into that old promise. Coalesce triggers into one queued check;
      // once it starts, a later trigger may queue the next without concurrent downloads.
      const pending = this.rechecks.get(spec.cliPackage)
      if (pending) return pending
      const next = busy.catch(() => {}).then(() => {
        this.rechecks.delete(spec.cliPackage)
        return this.update(spec.cliPackage, spec, { force: true })
      })
      this.rechecks.set(spec.cliPackage, next)
      return next
    }
    return this.update(spec.cliPackage, spec, { force })
  }

  async updateNow(pkg, spec, force) {
    const existing = this.external.get(pkg)
    const selected = this.find(spec, existing)
    if (!force && selected && this.checked.get(pkg) && this.now() - this.checked.get(pkg) < CLI_CHECK_EVERY_MS) return selected
    const { signal } = this.quit
    const have = this.binOf(pkg, spec)
    const ownVersion = existing
      ? await this.versionOf(existing, { env: this.versionEnv(spec), signal }) : undefined
    if (signal.aborted) throw new Error('install stopped: DSH is quitting')
    // Compare verified local copies before touching the network. An offline restart must
    // retain the newer one in either direction: managed upgrade or newer personal CLI.
    const local = ownVersion && (!have || compareCliVersions(ownVersion, have.version) >= 0)
      ? { path: existing, version: ownVersion, managed: false } : have
    if (local) this.selected.set(pkg, local)
    const version = await this.latest(pkg, { signal })
    if (!VERSION.test(version)) throw new Error(`No stable release was returned for ${pkg}`)
    if (signal.aborted) throw new Error('install stopped: DSH is quitting')
    // A wrapper or future CLI may use output we cannot recognize. Do not claim it is
    // current: use a verified managed release while leaving the user's command untouched.
    if (local && compareCliVersions(local.version, version) >= 0) {
      this.checked.set(pkg, this.now())
      return local
    }
    const platform = this.platform ?? cliPlatform()
    const folder = join(this.home, folderOf(pkg))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    this.dropStale(folder)
    const directory = `${version}-${randomUUID()}`
    const tmp = join(folder, `.install-${process.pid}-${this.now()}-${randomUUID()}`)
    mkdirSync(tmp, { mode: 0o700 })
    this.installing.add(tmp)
    try {
      await this.install(tmp, spec, version, this.env, { signal, platform })
      const bin = cliLayout(spec, version, platform).bins.find(bin => isExecutable(join(tmp, bin)))
      if (!bin) throw new Error(`${spec.defaultName} installed without a runnable native binary`)
      const actual = await this.versionOf(join(tmp, bin), { env: this.versionEnv(spec), signal })
      if (actual !== version) throw new Error(`${spec.defaultName} did not pass its version check after installation`)
      if (signal.aborted) throw new Error('install stopped: DSH is quitting')
      const concurrent = this.binOf(pkg, spec)
      if (concurrent && compareCliVersions(concurrent.version, version) > 0) {
        this.selected.set(pkg, concurrent)
        this.checked.set(pkg, this.now())
        return concurrent
      }
      // A unique version directory also makes two desktop profiles installing concurrently
      // safe: neither overwrites a binary another process may already be executing.
      renameSync(tmp, join(folder, directory))
      // Keep old versions: native CLIs can read their own executable throughout long sessions.
      const found = this.binOf(pkg, spec)
      this.selected.set(pkg, found)
      this.checked.set(pkg, this.now())
      this.log(`installed ${spec.defaultName} ${version}`)
      return found
    } finally {
      this.installing.delete(tmp)
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  dispose() {
    super.dispose()
    this.versionHomes?.dispose()
  }
}
