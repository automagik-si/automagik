// The ACP adapters, at their newest release, installed in the background: at DSH's start and
// once a day after, never when a Session starts. Each install goes to a fresh folder that is
// renamed into place only once complete, and `current.json` then names it, so a spawn never
// runs a half-installed adapter. They live in Automagik's home, not in the DSH profile: DSH's
// pnpm owns the profile's node_modules and would reconcile anything put there.
//
// A new release must start before it replaces the one in use (#958): once installed in its
// fresh folder it is asked `initialize` (`check`, handshake.js). One that fails stays out: the
// adapter in use is the last-known-good, the failed version is not tried again for BAD_TTL_MS,
// and `current.json` says what happened (`rolledBack`). One that passes is still unproven until
// it has opened a session (`markGood`): until then the version before it stays on disk, and a
// session start that fails goes back to it (`rollback`). A newer release that installs while
// the one in use is still untested keeps that same way back: `previous` moves on only once the
// release in use has opened a session, so a run of untested releases never drops the last one
// that worked, and `previousProven` records whether `previous` ever opened a session.
//
// Not pinned (RFC 0003, as amended): the agents' CLIs update themselves, and an adapter that
// lags its CLI breaks first. What is checked is what npm publishes: the exact package name, the
// registry's integrity for every tarball, no install scripts, and no bundled CLI.
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findCommand, isExecutable } from './agents.js'
import { batchSafe } from './batch-spawn.js'

const REGISTRY = 'https://registry.npmjs.org'
// npm is asked again once the last check is this old. The timer that asks runs every
// CHECK_TICK_MS: a 24-hour timer beside a 24-hour window skipped every other day, because the
// check a tick starts lands a moment after the tick, so the next tick still found it fresh.
export const CHECK_EVERY_MS = 20 * 60 * 60 * 1000
export const CHECK_TICK_MS = 4 * 60 * 60 * 1000
// How long a release that failed its start check is left alone. The vendor's fix is a new
// version, which is tried at once; the same version is tried again after this, in case what
// failed was this computer and not the release.
export const BAD_TTL_MS = 3 * 24 * 60 * 60 * 1000
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
// What a failed install keeps for the settings page: the end of the installer output.
export const DIAGNOSTIC_MAX = 4000

import { redactText } from './redact.js'

/** Remove credential-shaped strings from installer output before it is stored or shown. */
export { redactText as redactInstallerOutput }

// Installer output can print absolute home paths (npm's log path, an nvm command); the stored
// diagnostic and the log show the same "~" the Bot team report does.
const HOME = homedir()
function homeRelativeText(text) {
  let out = String(text ?? '')
  if (HOME.length > 1) {
    out = out.split(HOME).join('~')
    const slashes = HOME.replace(/\\/g, '/')
    if (slashes !== HOME) out = out.split(slashes).join('~')
  }
  return out
}

export { homeRelativeText }

export const adaptersHome = (env = process.env) => join(env.AUTOMAGIK_HOME || join(homedir(), '.automagik'), 'acp', 'adapters')
const folderOf = pkg => pkg.replace(/^@/, '').replace(/\//g, '__')
// Old records name folders by version; a repair can select a different local folder.
const dirOf = (current, previous = false) => {
  const dir = current?.[previous ? 'previousDir' : 'dir']
  return localDir(dir) ? dir : current?.[previous ? 'previous' : 'version']
}
// A folder name current.json may select: a plain name in the package folder, never a path.
const localDir = dir => typeof dir === 'string' && dir !== '' && !dir.startsWith('.') && !dir.includes('/') && !dir.includes('\\') && !dir.includes('\0')
// The folders a repair moved off (`retired`): a Session started before it may still run one, so
// each stays as long as the release an ordinary update replaces does, one check window.
const retiredOf = (current, now) => (Array.isArray(current?.retired) ? current.retired : [])
  .filter(entry => localDir(entry?.dir) && Number.isFinite(entry.at) && now - entry.at < CHECK_EVERY_MS)
const retiredField = retired => (retired.length > 0 ? { retired } : {})
const lockfiles = { pnpm: 'pnpm-lock.yaml', npm: 'package-lock.json' }
// An install is of one named npm package. An agent that runs natively has none (agents.js
// `isNative`), so a caller that passes its `adapter` on passes nothing: said here in words,
// before any folder is derived from the name.
const noPackage = pkg => (typeof pkg === 'string' && pkg !== ''
  ? undefined
  : new Error(`an adapter install needs a package name, and got ${typeof pkg === 'string' ? 'an empty one' : pkg === null ? 'null' : typeof pkg}: an agent that runs natively has no adapter to install`))
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(tmp, file)
  } finally {
    try { rmSync(tmp, { force: true }) } catch {}
  }
}

// A version check that could not reach npm (#970): the request never got an answer. Which
// failures those are is decided here, from a closed list, and remembered beside the error
// itself: the error a caller gets is the very one `fetch` threw, unchanged.
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const unreachable = new WeakMap()

/**
 * Why a version check could not reach npm, when that is why it failed: one of a closed list of
 * connection error codes (`ENOTFOUND`, `ECONNREFUSED`, ...), or `timeout` for the check's own
 * deadline. Undefined for any other failure: an answer npm did give (whatever its status), a
 * check its caller stopped, an error of another kind.
 * @param {unknown} error an error `latestVersion` rejected with
 * @returns {string | undefined}
 */
export function registryUnreachable(error) {
  return error !== null && typeof error === 'object' ? unreachable.get(error) : undefined
}

// Remember `error` as a failure to reach npm when it is one. `timeout` is this check's own
// deadline signal: only its own reason counts as the deadline.
function noteUnreachable(error, timeout) {
  if (error === null || typeof error !== 'object') return
  if (timeout.aborted && error === timeout.reason) return void unreachable.set(error, 'timeout')
  for (const code of [error.code, error.cause?.code, error.cause?.cause?.code]) {
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return void unreachable.set(error, code)
  }
}

/** The newest version npm publishes for `pkg`. */
export async function latestVersion(pkg, { fetch = globalThis.fetch, timeoutMs = 15_000, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  let res
  try {
    res = await fetch(`${REGISTRY}/${pkg.replace('/', '%2F')}/latest`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } })
  } catch (error) {
    noteUnreachable(error, timeout)
    throw error
  }
  if (!res.ok) throw new Error(`npm answered ${res.status} for ${pkg}`)
  let body
  try {
    body = await res.json()
  } catch (error) {
    // The connection can still drop, or the deadline pass, while the answer is read.
    noteUnreachable(error, timeout)
    throw error
  }
  const { version } = body
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`npm gave no version for ${pkg}`)
  return version
}

// The platform packages that hold the CLIs the adapters bundle (Claude Agent SDK's `claude`,
// Codex's `codex`; hundreds of MB each). The person's own CLI replaces them, so an install that
// pulls one in is refused. `@openai/codex` itself, with no platform in its name, is a small
// launcher codex-acp depends on, and stays.
const PLATFORM = /^(@anthropic-ai[/+]claude-agent-sdk|@openai[/+]codex)-(darwin|linux|win32)-/
const dirsOf = (dir) => {
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
}

/** The platform CLI packages anywhere in the node_modules under `dir`. */
export function platformPackages(dir) {
  const found = []
  const walk = (modules) => {
    for (const name of dirsOf(modules)) {
      if (name === '.pnpm') {
        for (const entry of dirsOf(join(modules, name))) {
          if (PLATFORM.test(entry)) found.push(entry)
          else walk(join(modules, name, entry, 'node_modules'))
        }
      } else if (name.startsWith('@')) {
        for (const pkg of dirsOf(join(modules, name))) {
          if (PLATFORM.test(`${name}/${pkg}`)) found.push(`${name}/${pkg}`)
          else walk(join(modules, name, pkg, 'node_modules'))
        }
      } else if (!name.startsWith('.')) {
        walk(join(modules, name, 'node_modules'))
      }
    }
  }
  walk(join(dir, 'node_modules'))
  return found
}

// The package manager: the desktop app's own pnpm (AUTOMAGIK_PNPM, the pnpm 10 it bundles),
// never the person's, whose newer pnpm installs the platform packages anyway (pnpm 12 pulled
// about 700 MB for the two adapters); else npm, which skips optional dependencies itself.
export function packageManagerOf(env = process.env) {
  if (env.AUTOMAGIK_PNPM && isExecutable(env.AUTOMAGIK_PNPM)) return { kind: 'pnpm', command: env.AUTOMAGIK_PNPM }
  const npm = findCommand('npm', { env })
  return npm ? { kind: 'npm', command: npm } : undefined
}

// Stop an install and everything it started. On POSIX the install leads its own process group
// (spawned detached), so one kill of the group reaches all of it at once. It is out of DSH's
// group: DSH's SIGTERM disposes this plugin, which kills it here; a SIGKILL to DSH's group alone
// does not reach it. On Windows, taskkill /T walks the tree by parent pid, which Windows reuses:
// a process that outlived its parent can carry a stranger's pid as its parent.
export function killTree(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 }) } catch {}
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch {}
}

// One install command: rejects with its last output when it fails, and kills its whole tree
// when `signal` aborts or it runs past INSTALL_TIMEOUT_MS.
export function runInstall(command, args, { cwd, env, signal: abort, timeoutMs = INSTALL_TIMEOUT_MS, kill = killTree, onSpawn }) {
  return new Promise((resolve, reject) => {
    if (abort?.aborted) return reject(new Error('install stopped: DSH is quitting'))
    // On Windows the package manager is a batch file (the app's pnpm.cmd, npm.cmd): through
    // cmd.exe, whose tree killTree's taskkill /T ends with it.
    const child = spawn(...batchSafe(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }))
    // The process at once, for a caller that must tell when it is gone: 'exit' says Node reaped
    // it, while 'close' can come after, when a grandchild holds its output open.
    onSpawn?.(child)
    let output = ''
    let stopped
    const keep = (chunk) => { output = (output + chunk).slice(-16_384) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const stop = (why) => {
      if (stopped !== undefined) return
      stopped = why
      // Only while it runs: once Node has reaped it ('exit' comes before 'close'), its pid may
      // already be a stranger's.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) kill(child.pid)
    }
    const onAbort = () => stop('install stopped: DSH is quitting')
    const timer = setTimeout(() => stop(`install timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
    timer.unref?.()
    abort?.addEventListener('abort', onAbort, { once: true })
    const done = (error) => {
      clearTimeout(timer)
      abort?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', done)
    child.once('close', (code, sig) => {
      if (stopped !== undefined) done(new Error(stopped))
      else if (code !== 0) done(new Error(`${command} ${args[0]} failed (${sig ?? `exit ${code}`})\n${output.trim()}`))
      else done()
    })
  })
}

export async function defaultInstall(dir, pkg, version, env, { signal, frozen = false } = {}) {
  const manager = packageManagerOf(env)
  if (!manager) throw new Error("neither the desktop app's pnpm nor npm is here to install the ACP adapter with")
  const options = { cwd: dir, env: { ...env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, signal }
  // No optional dependencies: they are the CLIs the adapters bundle, which the person's own
  // replace. pnpm skips them through package.json's supportedArchitectures (see updateNow):
  // pnpm 10.34's --no-optional breaks on Codex's aliased platform packages
  // (ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY). updateNow refuses an install that has one anyway.
  if (manager.kind === 'pnpm') await runInstall(manager.command, ['install', '--prod', '--ignore-scripts', '--config.node-linker=hoisted', '--config.ignore-workspace=true', '--reporter=silent', ...(frozen ? ['--frozen-lockfile', '--prefer-offline'] : ['--no-frozen-lockfile'])], options)
  else await runInstall(manager.command, [frozen ? 'ci' : 'install', '--omit=optional', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...(frozen ? ['--prefer-offline'] : [])], options)
}

export class AdapterStore {
  /**
   * @param {{ home?: string, env?: NodeJS.ProcessEnv, latest?: typeof latestVersion, install?: typeof defaultInstall, now?: () => number, log?: (message: string) => void, check?: (pkg: string, staged: { path: string, version: string }) => Promise<void> }} [options]
   *   `check` starts a staged adapter and rejects when it does not answer; it may also be set
   *   later (`store.check = ...`), once the caller knows how to spawn each adapter.
   */
  constructor({ home = adaptersHome(), env = process.env, latest = latestVersion, install = defaultInstall, now = Date.now, log = () => {}, check } = {}) {
    Object.assign(this, { home, env, latest, install, now, log, check })
    this.running = new Map()
    this.repairing = new Set()
    this.failures = new Map()
    this.installing = new Set()
    this.quit = new AbortController()
  }

  /**
   * DSH is quitting: kill every running install's process tree and remove its half-done folder
   * now, as DSH may exit before the install's own cleanup runs. No install starts after this.
   */
  dispose() {
    this.quit.abort()
    for (const tmp of this.installing) rmSync(tmp, { recursive: true, force: true })
    this.installing.clear()
  }

  /** Why the last install of `pkg` failed, while no install has worked since: the short
   * message, the full diagnostic, and the log file it was written to. */
  lastFailure(pkg) {
    return this.failures.get(pkg)
  }

  /** The short message of the last failed install of `pkg`, for the connector state. */
  lastError(pkg) {
    return this.failures.get(pkg)?.message
  }

  /** Whether an install of `pkg` is running now. */
  busy(pkg) {
    return this.running.has(pkg)
  }

  /** The installed adapter's entry script, or undefined when none is complete. */
  binOf(pkg, bin) {
    const folder = join(this.home, folderOf(pkg))
    const current = readJson(join(folder, 'current.json'))
    if (!current?.version) return undefined
    const path = join(folder, dirOf(current), 'node_modules', ...pkg.split('/'), bin)
    return existsSync(path) ? { path, version: current.version } : undefined
  }

  /** What `current.json` records beside the version in use: the one before it, a rollback. */
  stateOf(pkg) {
    const current = readJson(join(this.home, folderOf(pkg), 'current.json'))
    if (!current?.version) return undefined
    const bad = current.bad?.version !== undefined && this.now() - current.bad.at < BAD_TTL_MS ? current.bad : undefined
    // Only a previous release still on disk is named: one the cleanup dropped is no way back.
    const previous = current.previous && current.previous !== current.version && existsSync(join(this.home, folderOf(pkg), dirOf(current, true))) ? current.previous : undefined
    return {
      version: current.version,
      proven: current.proven !== false,
      ...(previous ? { previous } : {}),
      // A rollback is shown while the version it left is still held back.
      ...(current.rolledBack && bad?.version === current.rolledBack.from ? { rolledBack: current.rolledBack } : {}),
      ...(bad ? { bad } : {}),
    }
  }

  /** The adapter in use opened a session: it is the last-known-good from now on. */
  markGood(pkg) {
    const file = join(this.home, folderOf(pkg), 'current.json')
    const current = readJson(file)
    if (!current?.version || current.proven !== false || !existsSync(join(this.home, folderOf(pkg), dirOf(current)))) return
    try {
      writeJson(file, { ...current, proven: true })
    } catch {}
  }

  /**
   * The adapter in use did not start. While it is unproven and the version before it is still
   * on disk, go back to that one: `current.json` names it again, and the failed version is
   * held back for BAD_TTL_MS. The release gone back to keeps its own state: proven only when
   * it had opened a session before (`previousProven`), never because it was rolled back to.
   * @returns {{ path: string, version: string } | undefined} the adapter now in use, when it changed
   */
  rollback(pkg, bin, reason) {
    const folder = join(this.home, folderOf(pkg))
    const file = join(folder, 'current.json')
    const current = readJson(file)
    if (!current?.version || current.proven !== false || !current.previous || current.previous === current.version) return undefined
    if (!existsSync(join(folder, dirOf(current, true), 'node_modules', ...pkg.split('/'), bin))) return undefined
    const why = homeRelativeText(redactText(String(reason?.message ?? reason ?? 'it did not start'))).slice(0, 300)
    const at = this.now()
    try {
      writeJson(file, {
        version: current.previous,
        ...(dirOf(current, true) !== current.previous ? { dir: dirOf(current, true) } : {}),
        ...retiredField(retiredOf(current, at)),
        checkedAt: current.checkedAt ?? at,
        ...(current.previousProven === true ? {} : { proven: false }),
        bad: { version: current.version, at, reason: why },
        rolledBack: { from: current.version, to: current.previous, at, reason: why },
      })
    } catch {
      return undefined
    }
    this.log(`${pkg}@${current.version} did not start (${why}); back on ${current.previous}`)
    return this.binOf(pkg, bin)
  }

  /** Install the newest release unless it is already here and was checked within a day. */
  update(pkg, bin, { force = false } = {}) {
    const refused = noPackage(pkg)
    if (refused) return Promise.reject(refused)
    const busy = this.running.get(pkg)
    if (busy) return busy
    if (this.quit.signal.aborted) return Promise.reject(new Error('install stopped: DSH is quitting'))
    return this.track(pkg, this.updateNow(pkg, bin, force))
  }

  /** Reinstall the selected release, even while its registry check is still fresh. */
  repair(pkg, bin) {
    const refused = noPackage(pkg)
    if (refused) return Promise.reject(refused)
    if (this.quit.signal.aborted) return Promise.reject(new Error('install stopped: DSH is quitting'))
    const busy = this.running.get(pkg)
    if (busy && this.repairing.has(pkg)) return busy
    // An update may select a new version; repair that selection once the update ends.
    const work = busy ? busy.catch(() => {}).then(() => this.repairNow(pkg, bin)) : this.repairNow(pkg, bin)
    this.repairing.add(pkg)
    return this.track(pkg, work)
  }

  track(pkg, work) {
    const job = work.then(
      (found) => { this.failures.delete(pkg); return found },
      (error) => { this.recordFailure(pkg, error); throw error },
    ).finally(() => {
      if (this.running.get(pkg) !== job) return
      this.running.delete(pkg)
      this.repairing.delete(pkg)
    })
    this.running.set(pkg, job)
    return job
  }

  recordFailure(pkg, error) {
    const full = homeRelativeText(redactText(error?.message ?? error))
    const message = full.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
    const diagnostic = full.slice(-DIAGNOSTIC_MAX)
    let logPath
    try {
      const dir = join(this.home, 'logs')
      // Owner-only: the log can hold paths and installer output.
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      logPath = join(dir, `${folderOf(pkg)}.log`)
      writeFileSync(logPath, `${new Date(this.now()).toISOString()} install of ${pkg} failed\n\n${diagnostic}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(logPath, 0o600)
    } catch { /* the diagnostic still travels in the status */ }
    // A check that could not reach npm says so in the record: the caller tries again sooner.
    const reason = registryUnreachable(error)
    this.failures.set(pkg, { message, diagnostic, ...(logPath === undefined ? {} : { logPath }), ...(reason === undefined ? {} : { unreachable: reason }) })
  }

  async repairNow(pkg, bin) {
    const { signal } = this.quit
    if (signal.aborted) throw new Error('install stopped: DSH is quitting')
    const folder = join(this.home, folderOf(pkg))
    const file = join(folder, 'current.json')
    const current = readJson(file)
    if (!current?.version) return this.updateNow(pkg, bin, true)
    const { version } = current
    let tmp
    let target
    try {
      tmp = await this.stage(folder, pkg, bin, version, dirOf(current))
      await this.check?.(pkg, { path: join(tmp, 'node_modules', ...pkg.split('/'), bin), version })
      if (signal.aborted) throw new Error('install stopped: DSH is quitting')
      const base = `${version}_r${this.now()}`
      let dir = base
      for (let n = 1; existsSync(join(folder, dir)); n++) dir = `${base}_${n}`
      const candidate = join(folder, dir)
      try { renameSync(tmp, candidate) } catch (error) {
        throw new Error(`${pkg}@${version}: could not move its repaired connector into place (${error?.code ?? error?.message ?? error})`)
      }
      target = candidate
      // A rollback or another update may have chosen a different folder while the check ran.
      const selected = readJson(file)
      if (selected?.version !== version || dirOf(selected) !== dirOf(current)) {
        rmSync(target, { recursive: true, force: true })
        return this.binOf(pkg, bin)
      }
      const at = this.now()
      const retired = [...retiredOf(selected, at).filter(entry => entry.dir !== dir), { dir: dirOf(selected), at }]
      const next = { ...selected, dir, retired }
      writeJson(file, next)
      target = undefined
      this.cleanup(folder, next, dirOf(current))
      return this.binOf(pkg, bin)
    } finally {
      if (tmp !== undefined) {
        try { rmSync(tmp, { recursive: true, force: true }) } catch {}
        this.installing.delete(tmp)
      }
      if (target !== undefined) {
        try { rmSync(target, { recursive: true, force: true }) } catch {}
      }
    }
  }

  async stage(folder, pkg, bin, version, installed) {
    const { signal } = this.quit
    const lock = lockfiles[packageManagerOf(this.env)?.kind]
    const archive = join(this.home, '.locks', folderOf(pkg), version)
    // The lockfile recorded for this version; else, for an install made before lockfiles were
    // recorded, the one its package manager left in the folder of that same version.
    const source = lock === undefined ? undefined : [join(archive, lock), ...(installed === undefined ? [] : [join(folder, installed, lock)])].find(file => existsSync(file))
    let frozen = source !== undefined
    const base = join(folder, `.install-${process.pid}-${this.now()}`)
    let serial = 0
    for (;;) {
      let tmp = serial === 0 ? base : `${base}-${serial}`
      while (existsSync(tmp)) tmp = `${base}-${++serial}`
      serial++
      mkdirSync(tmp, { recursive: true })
      this.installing.add(tmp)
      let complete = false
      try {
        // A platform nothing runs on: pnpm installs no platform-specific optional package.
        writeJson(join(tmp, 'package.json'), { name: 'automagik-acp-adapter', private: true, dependencies: { [pkg]: version }, pnpm: { supportedArchitectures: { os: ['none'], cpu: ['none'], libc: ['none'] } } })
        if (frozen) {
          try { copyFileSync(source, join(tmp, lock)) } catch (error) {
            this.log(`${pkg}@${version}: its recorded lockfile could not be read (${error?.code ?? 'error'}); resolving afresh`)
            frozen = false
          }
        }
        try {
          await this.install(tmp, pkg, version, this.env, { signal, ...(frozen ? { frozen: true } : {}) })
        } catch (error) {
          if (!frozen || signal.aborted || /^install (?:stopped: DSH is quitting|timed out after \d+s)$/.test(String(error?.message ?? error))) throw error
          // An app update can make its pnpm unable to read an old lockfile. Resolve afresh once,
          // as installs did before lockfiles, so Retry is not stuck on that lockfile forever.
          const why = homeRelativeText(redactText(String(error?.message ?? error))).split('\n')[0].slice(0, 300)
          this.log(`${pkg}@${version}: its recorded lockfile could not be installed (${why}); resolving afresh`)
          frozen = false
          continue
        }
        if (signal.aborted) throw new Error('install stopped: DSH is quitting')
        // Keep successful resolution even when the subsequent start check refuses the release.
        if (lock !== undefined && existsSync(join(tmp, lock))) {
          const saved = join(archive, `${lock}.${process.pid}.tmp`)
          // A lockfile that cannot be recorded costs only the next frozen install, never this one.
          try {
            mkdirSync(archive, { recursive: true })
            copyFileSync(join(tmp, lock), saved)
            renameSync(saved, join(archive, lock))
            for (const other of Object.values(lockfiles)) {
              if (other !== lock) rmSync(join(archive, other), { force: true })
            }
          } catch (error) {
            this.log(`${pkg}@${version}: its lockfile could not be recorded (${error?.code ?? 'error'})`)
          } finally {
            try { rmSync(saved, { force: true }) } catch {}
          }
        }
        if (!existsSync(join(tmp, 'node_modules', ...pkg.split('/'), bin))) throw new Error(`${pkg}@${version} installed without ${bin}`)
        const bundled = platformPackages(tmp)
        if (bundled.length > 0) throw new Error(`${pkg}@${version} installed the CLIs it bundles (${bundled.join(', ')}); refused`)
        complete = true
        return tmp
      } finally {
        if (!complete) {
          try { rmSync(tmp, { recursive: true, force: true }) } catch {}
          this.installing.delete(tmp)
        }
      }
    }
  }

  cleanup(folder, current, displaced) {
    const keep = new Set([dirOf(current), displaced, dirOf(current, true), ...retiredOf(current, this.now()).map(entry => entry.dir)].filter(Boolean))
    let names
    try { names = readdirSync(folder) } catch { return }
    for (const name of names) {
      if (name === 'current.json' || name.startsWith('.') || keep.has(name)) continue
      try { rmSync(join(folder, name), { recursive: true, force: true }) } catch {}
    }
  }

  pruneLocks(pkg, current) {
    const folder = join(this.home, '.locks', folderOf(pkg))
    const keep = new Set([current.version, current.previous, current.bad?.version].filter(Boolean))
    try {
      for (const name of readdirSync(folder)) {
        if (!keep.has(name)) rmSync(join(folder, name), { recursive: true, force: true })
      }
    } catch {}
  }

  async updateNow(pkg, bin, force) {
    const refused = noPackage(pkg)
    if (refused) throw refused
    const folder = join(this.home, folderOf(pkg))
    const current = readJson(join(folder, 'current.json'))
    const have = this.binOf(pkg, bin)
    if (!force && have && current?.checkedAt && this.now() - current.checkedAt < CHECK_EVERY_MS) return have
    const { signal } = this.quit
    const version = await this.latest(pkg, { signal })
    if (signal.aborted) throw new Error('install stopped: DSH is quitting')
    mkdirSync(folder, { recursive: true })
    this.dropStale(folder)
    // A release that failed its start check here stays out until a newer one is published or
    // its hold runs out; the adapter in use goes on.
    const held = current?.bad?.version === version && this.now() - current.bad.at < BAD_TTL_MS
    if (held && have) {
      writeJson(join(folder, 'current.json'), { ...current, checkedAt: this.now() })
      this.pruneLocks(pkg, current)
      return have
    }
    let installedNew = false
    if (have?.version !== version) {
      const tmp = await this.stage(folder, pkg, bin, version)
      try {
        // Start it before it replaces the one in use. With nothing in use there is no
        // last-known-good to keep: a first install is promoted either way, unproven.
        let failed
        try {
          await this.check?.(pkg, { path: join(tmp, 'node_modules', ...pkg.split('/'), bin), version })
        } catch (error) {
          failed = error
        }
        if (signal.aborted) throw new Error('install stopped: DSH is quitting')
        if (failed !== undefined && have) {
          const why = homeRelativeText(redactText(String(failed?.message ?? failed))).slice(0, 300)
          const at = this.now()
          rmSync(tmp, { recursive: true, force: true })
          const next = {
            ...current,
            version: have.version,
            checkedAt: at,
            bad: { version, at, reason: why },
            rolledBack: { from: version, to: have.version, at, reason: why },
          }
          writeJson(join(folder, 'current.json'), next)
          this.pruneLocks(pkg, next)
          this.log(`${pkg}@${version} failed its start check (${why}); staying on ${have.version}`)
          return have
        }
        if (failed !== undefined) this.log(`${pkg}@${version} failed its start check (${failed?.message ?? failed}); installed anyway: nothing else is here`)
        const target = join(folder, version)
        rmSync(target, { recursive: true, force: true })
        renameSync(tmp, target)
      } catch (error) {
        rmSync(tmp, { recursive: true, force: true })
        throw error
      } finally {
        this.installing.delete(tmp)
      }
      this.log(`installed ${pkg}@${version}`)
      installedNew = true
    }
    // A new release is unproven until it has opened a session (markGood); one already in use
    // keeps what it was.
    const proven = installedNew ? false : current?.proven !== false
    // The way back: the release in use when it has opened a session; while it is untested, the
    // way back it already had (the last release that worked), never the untested one.
    const haveProven = current?.proven !== false
    const moveOn = installedNew && have !== undefined && haveProven
    const previous = moveOn ? have.version : current?.previous
    const previousDir = moveOn ? dirOf(current) : dirOf(current, true)
    const previousProven = moveOn ? true : current?.previousProven === true
    // Once the release in use is proven it needs no way back, and the folder goes below.
    const keepPrevious = !proven && previous !== undefined && previous !== version
    // A held-back release is remembered only while the adapter it was kept out for is in use:
    // once a newer release took its place, that rollback is over.
    const bad = !installedNew && current?.bad?.version !== undefined && current.bad.version !== version && this.now() - current.bad.at < BAD_TTL_MS ? current.bad : undefined
    const next = {
      version,
      ...(!installedNew && dirOf(current) !== version ? { dir: dirOf(current) } : {}),
      checkedAt: this.now(),
      ...(keepPrevious ? { previous, previousProven, ...(previousDir !== previous ? { previousDir } : {}) } : {}),
      ...(proven ? {} : { proven: false }),
      ...(bad ? { bad, ...(current.rolledBack?.from === bad.version ? { rolledBack: current.rolledBack } : {}) } : {}),
      ...retiredField(retiredOf(current, this.now())),
    }
    writeJson(join(folder, 'current.json'), next)
    // Keep the physical folders still selected or just displaced by this update.
    this.cleanup(folder, next, have === undefined ? undefined : dirOf(current))
    this.pruneLocks(pkg, next)
    return this.binOf(pkg, bin)
  }

  // An install DSH was killed in the middle of leaves its folder (`.install-<pid>-<time>`): dropped
  // at once when that DSH is gone, else once older than any install can run, so one another DSH
  // is still running stays.
  dropStale(folder) {
    for (const name of readdirSync(folder)) {
      if (!name.startsWith('.install-')) continue
      const path = join(folder, name)
      const pid = Number(name.split('-')[1])
      try {
        if (!alive(pid) || this.now() - statSync(path).mtimeMs > INSTALL_TIMEOUT_MS) rmSync(path, { recursive: true, force: true })
      } catch {}
    }
  }
}

// Whether a process `pid` runs; one that is not ours (EPERM) still runs.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
