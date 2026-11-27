// Bot authentication belongs to this installation, never to the terminal (#869).
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  CHAT_GENERATION, checkDirectory, completeChatCleanup, deferChatCleanup, deferredChatCleanups,
  oldChatRunsExited, ownedDirectory, readChatCleanup, readStagedHome, removeChatHome,
  removeStagingMarker, stagingPath, writeChatCleanup, writeStagedHome,
} from './chat-home-cleanup.js'
import {
  LOGIN_OWNER_ENV, LOGIN_RECORD_VERSION, reclaimWindowsLogins, unverifiedLogin, verifyLoginRecords,
} from './login-ownership.js'
import {
  assertGeneration, CliGenerations, GENERATION_ENV, ownershipAt, ownershipState,
  POINTER_ENV, removeDeadOwnership,
} from './cli-generations.js'
import { NO_BUS_ADDRESS } from './agents.js'
import { installationDigest, installationIdentity, publishSelectedRoot } from './installation.js'
import { processState, validBirth } from './process-identity.js'
import { retiredHomes, writeRetiredNote } from './retired-home.js'
import { probeWindowsChatHome, waitForWindowsChatHome } from './windows-chat-home.js'
import { probeWindowsLogin } from './windows-job-probe.js'

export const HOME_ENV = 'AUTOMAGIK_BOT_CLI_HOME'
export const VERSION_ENV = 'AUTOMAGIK_BOT_CLI_VERSION'
// Antigravity (#2048) has its own home like the other two: agy keeps everything under its
// HOME's `.gemini` (its own folder name below), and the app's agy never sees the person's.
const vendors = new Set(['claude', 'codex', 'antigravity'])
// Each vendor's own config folder in its home, created 0700 with the home.
const CONFIG = { claude: '.claude', codex: '.codex', antigravity: '.gemini' }
const runs = new Map()
// An allowlist, rather than a list of known tokens: future CLI auth overrides must not leak
// in either. Undefined entries mask process.env where older spawn helpers merge environments.
const inherited = new RegExp([
  '^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_.*|TZ|TERM',
  '|COLORTERM|USER|USERNAME|LOGNAME|SHELL|HTTPS?_PROXY|ALL_PROXY|NO_PROXY',
  '|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|DBUS_SESSION_BUS_ADDRESS',
  '|DISPLAY|WAYLAND_DISPLAY)$',
].join(''), 'i')
const failure = message => Object.assign(new Error(message), { code: 'acp-account/busy' })
const chatCleanupPending = 'A previous Bot sign-in home is still in use or could not be checked. '
  + 'The current account and Reset are available. Cleanup will be retried when the app starts.'

export class CliHomes {
  constructor(root, {
    acpHome = dirname(resolve(root)), identity = installationIdentity(),
    onRecordError = () => console.warn('acp-dsh: the generation record could not be saved at startup'),
    onSelectionError = action => console.warn(`acp-dsh: the selected Bot sign-in root could not be ${action}`),
    onRetired = () => {}, probe = probeWindowsLogin, probeChatHome = probeWindowsChatHome,
    platform = process.platform, onChatCleanupPending = message => console.warn(message),
  } = {}) {
    this.root = resolve(root)
    this.acpHome = resolve(acpHome)
    this.identity = identity
    this.onRecordError = onRecordError
    this.onSelectionError = onSelectionError
    this.onRetired = onRetired
    this.instance = `${process.pid}-${randomUUID()}`
    this.registered = new Map()
    this.changes = new Map()
    this.probe = probe
    this.platform = platform
    this.probeChatHome = probeChatHome
    this.onChatCleanupPending = onChatCleanupPending
    this.recovering = new Map()
    this.cleanupTimers = new Map()
    this.chatRecoveries = new Set()
    this.deferredRecoveries = new Map()
    this.chatCleanupNotices = new Map()
    this.started = new Set()
    this.generations = new CliGenerations(this.root, this.instance, { reader: true })
  }

  publishSelection() {
    this.selectionEnabled = true
    this.refreshSelection()
  }

  refreshSelection() {
    if (!this.selectionEnabled || !this.identity || this.started.size === 0 || this.withdrawn
      || !['linux', 'darwin'].includes(this.generations.birth?.platform)) return
    if (this.selection?.vendors === this.started.size) return
    this.clearSelection()
    if (this.selection) return
    const directory = join(this.acpHome, 'selected')
    const path = join(directory, installationDigest(this.identity), `${this.instance}.json`)
    try {
      const handle = publishSelectedRoot(directory, path, {
        version: 1, identity: this.identity, root: this.root, instance: this.instance, pid: process.pid,
        birth: this.generations.birth, vendors: [...this.started], startedAt: new Date().toISOString(),
      })
      this.selection = { path, handle, vendors: this.started.size }
    } catch { try { this.onSelectionError('recorded') } catch {} }
  }

  home(vendor) {
    if (!vendors.has(vendor)) throw new Error('No isolated home for this agent.')
    return this.generations.folder(vendor)
  }

  environment(vendor, source = process.env) {
    if (!vendors.has(vendor)) throw new Error('No isolated home for this agent.')
    if (this.withdrawn) throw failure('This Bot sign-in panel has closed.')
    const registered = this.generations.registered.has(vendor)
    this.generations.register(vendor)
    try { this.generations.check(vendor) } catch (error) {
      if (!registered) this.generations.unregister(vendor)
      throw error
    }
    // Registration fences Reset before selecting any path. Capture the physical home and
    // marker from one generation, rather than reading the selection again at return time.
    const generation = this.generations.current(vendor)
    const home = this.generations.folder(vendor, generation)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const instances = join(home, 'instances')
    mkdirSync(instances, { recursive: true, mode: 0o700 })
    // Register before checking the mutation lock: either a concurrent changer sees us and
    // refuses, or we see its lock and refuse. Other app processes can never change live auth.
    if (this.registered.get(vendor) !== home) {
      this.generations.publish(join(instances, this.instance), LOGIN_RECORD_VERSION)
      if (existsSync(join(home, 'changing'))) {
        this.generations.release(join(instances, this.instance))
        if (!registered) this.generations.unregister(vendor)
        throw failure('The Bot account is changing. Try again when it finishes.')
      }
      this.registered.set(vendor, home)
    }
    this.verify(home)
    const selected = this.environmentAt(vendor, home, source)
    selected[POINTER_ENV] = this.generations.pointer(vendor)
    selected[GENERATION_ENV] = generation
    this.generations.check(vendor)
    assertGeneration(selected)
    return selected
  }

  environmentAt(vendor, home, source) {
    const env = Object.fromEntries(Object.keys(source).map(key => [
      key, inherited.test(key) ? source[key] : undefined,
    ]))
    const config = join(home, CONFIG[vendor])
    for (const dir of [config, 'config', 'data', 'cache', 'state', 'roaming', 'local']) {
      mkdirSync(dir === config ? dir : join(home, dir), { recursive: true, mode: 0o700 })
    }
    return {
      ...env,
      // agy stores its sign-in in the desktop session's Secret Service when it reaches a D-Bus
      // session bus, and that store belongs to the session, not to HOME. agy finds the session
      // bus by the user id when the address is unset, so it gets one that can never connect
      // (NO_BUS_ADDRESS) and keeps the sign-in in its file store, inside this home (agy's
      // changelog; checked at acceptance). Claude Code and Codex keep the address.
      ...(vendor === 'antigravity' ? { DBUS_SESSION_BUS_ADDRESS: NO_BUS_ADDRESS } : {}),
      HOME: home,
      DSH_HOME: this.identity,
      AUTOMAGIK_HOME: dirname(this.acpHome),
      USERPROFILE: home,
      APPDATA: join(home, 'roaming'),
      LOCALAPPDATA: join(home, 'local'),
      HOMEDRIVE: undefined,
      HOMEPATH: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      [HOME_ENV]: home,
      [LOGIN_OWNER_ENV]: this.instance,
      [VERSION_ENV]: existsSync(join(home, 'version'))
        ? readFileSync(join(home, 'version'), 'utf8') : '',
    }
  }

  stageLogin(vendor) {
    return this.generations.exclusive(vendor, () => this.stageLoginLocked(vendor))
  }

  stageLoginLocked(vendor) {
    const previous = this.generations.current(vendor)
    const old = this.generations.folder(vendor, previous)
    if (this.changes.get(vendor) !== old) throw failure('The Bot account is changing.')
    const physical = path => {
      const identity = ownedDirectory(this.root, path)
      if (!identity) throw unverifiedLogin()
      return identity
    }
    const original = physical(old)
    const generation = randomUUID()
    const home = this.generations.folder(vendor, generation)
    const staging = stagingPath(this.root, vendor)
    const marker = join(staging, generation)
    const container = dirname(home)
    const newContainer = !existsSync(container)
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    physical(staging)
    writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
    let owned
    const discard = () => {
      if (this.generations.current(vendor) === generation) return
      if (owned) {
        checkDirectory(this.root, home, owned)
        rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        owned = undefined
      }
      if (newContainer) try { rmdirSync(container) } catch {}
      rmSync(marker, { force: true })
    }
    try {
      mkdirSync(container, { recursive: true, mode: 0o700 })
      physical(container)
      mkdirSync(home, { mode: 0o700 })
      owned = physical(home)
      writeStagedHome(this.root, marker, { home: owned, owner: { pid: process.pid, birth: this.generations.birth } })
      const env = this.environmentAt(vendor, home, process.env)
      // Windows places Job control files beside the generation pointers. Supplying the
      // staged generation does not select it, so ordinary Bot runs still cannot use it.
      env[POINTER_ENV] = this.generations.pointer(vendor)
      env[GENERATION_ENV] = generation
      const adopt = () => {
        const release = this.generations.acquire(vendor)
        try {
          if (this.changes.get(vendor) !== old || this.generations.current(vendor) !== previous) throw unverifiedLogin()
          this.requireNoChatCleanup(vendor)
          this.generations.otherApps(vendor, old)
          checkDirectory(this.root, old, original)
          checkDirectory(this.root, home, owned)
          this.verify(old)
          this.verify(home)
          writeFileSync(join(home, 'paused'), '', { mode: 0o600 })
          const instance = join(home, 'instances', this.instance)
          this.generations.publish(instance, LOGIN_RECORD_VERSION)
          try {
            // Publish deletion intent before the pointer can commit adoption. The pointer
            // authorizes recovery only if it actually selected this replacement.
            writeChatCleanup(this.root, vendor, {
              version: 1, vendor, previous, replacement: generation, old: original, adopted: owned,
              owner: { pid: process.pid, birth: this.generations.birth },
              runs: chatRunEvidence(old), stopped: false,
            })
            this.generations.select(vendor, generation, { previous })
          } catch (error) {
            this.generations.release(instance)
            try {
              if (this.generations.current(vendor) === previous) completeChatCleanup(this.root, vendor)
            } catch {}
            throw error
          }
          this.registered.set(vendor, home)
          return {
            release,
            removePrevious: () => this.generations.exclusive(vendor, () => {
              const entry = readChatCleanup(this.root, vendor)
              if (entry?.replacement !== generation || runCount(old) !== 0) throw unverifiedLogin()
              this.finishChatCleanup(vendor, entry)
            }),
          }
        } catch (error) {
          release()
          throw error
        }
      }
      return { env, adopt, discard, old }
    } catch (error) {
      discard()
      throw error
    }
  }

  checkAdoptedHome(vendor, entry) {
    if (this.generations.current(vendor) !== entry.replacement) throw unverifiedLogin()
    const adopted = this.generations.folder(vendor, entry.replacement)
    checkDirectory(this.root, adopted, entry.adopted)
    return adopted
  }

  finishChatCleanup(vendor, entry, deferred) {
    if (!deferred) this.checkAdoptedHome(vendor, entry)
    if (this.generations.current(vendor) === entry.previous) throw unverifiedLogin()
    const old = this.generations.folder(vendor, entry.previous)
    if (lstatSync(join(this.root, 'retired', vendor, entry.previous), { throwIfNoEntry: false })) throw unverifiedLogin()
    if (!entry.stopped) writeChatCleanup(this.root, vendor, { ...entry, stopped: true }, deferred)
    removeChatHome(this.root, old, entry.old, () => {
      this.generations.peers(join(old, 'instances'), 'home', this.instance)
      this.verify(old)
      this.generations.release(join(old, 'instances', this.instance))
    })
    if (!deferred) removeStagingMarker(this.root, join(stagingPath(this.root, vendor), entry.replacement))
    completeChatCleanup(this.root, vendor, deferred)
  }

  recoverStagedHomes(vendor, current, home) {
    const staging = stagingPath(this.root, vendor)
    if (!existsSync(staging) || !ownedDirectory(this.root, staging)) return
    const entry = readChatCleanup(this.root, vendor)
    const lock = join(home, 'changing')
    const legacyActive = existsSync(lock) && this.lockState(lock) !== 'dead'
    for (const generation of readdirSync(staging)) {
      if (!CHAT_GENERATION.test(generation) || generation === current || generation === entry?.previous
        || lstatSync(join(this.root, 'retired', vendor, generation), { throwIfNoEntry: false })) continue
      try {
        const marker = join(staging, generation)
        const staged = readStagedHome(this.root, marker)
        if (!staged || (staged.owner ? !this.deadChatOwner(staged.owner) : legacyActive)) continue
        const attemptedAdoption = entry?.previous === current && entry.replacement === generation
        if (attemptedAdoption && !this.deadChatOwner(entry.owner)) continue
        const target = this.generations.folder(vendor, generation)
        if (existsSync(dirname(target))) {
          const identity = ownedDirectory(this.root, target)
          if (identity) {
            const expected = attemptedAdoption ? entry.adopted : staged.home ?? identity
            checkDirectory(this.root, target, expected)
            const records = join(target, 'login-trees')
            if (this.platform === 'win32' && existsSync(records) && ownedDirectory(this.root, records)
              && readdirSync(records).length > 0) {
              this.recoverStagedWindowsLogin(vendor, generation, marker, staged, target, expected)
              continue
            }
            this.removeStagedHome(target, expected)
          }
        }
        removeStagingMarker(this.root, marker)
      } catch {} // Keep unproved homes and their ownership markers.
    }
  }

  removeStagedHome(home, expected) {
    removeChatHome(this.root, home, expected, () => {
      this.generations.peers(join(home, 'instances'), 'home', this.instance)
      this.verify(home)
    })
  }

  recoverStagedWindowsLogin(vendor, generation, marker, staged, home, expected) {
    const commit = change => {
      if (this.recoveryClosed) return false
      try {
        return this.generations.exclusive(vendor, () => {
          const markerNow = readStagedHome(this.root, marker)
          const upgraded = !staged.owner && markerNow?.owner && this.deadChatOwner(markerNow.owner)
            && isDeepStrictEqual(markerNow.home, expected)
          if (this.generations.current(vendor) === generation
            || lstatSync(join(this.root, 'retired', vendor, generation), { throwIfNoEntry: false })
            || (!upgraded && !isDeepStrictEqual(staged, markerNow))
            || !checkDirectory(this.root, home, expected, { missing: true })) return false
          return change()
        })
      } catch { return false }
    }
    void reclaimWindowsLogins({
      home, owner: this.instance, controlRoot: join(this.root, 'login-jobs'), probe: this.probe, commit,
    }).then(removed => {
      if (removed > 0) commit(() => {
        this.removeStagedHome(home, expected)
        removeStagingMarker(this.root, marker)
      })
    }).catch(() => {})
  }

  deadChatOwner(owner) { return processState(owner.pid, owner.birth) === 'dead' }

  startupGeneration(vendor) {
    try { return this.generations.current(vendor) } catch (error) {
      if (vendor === 'antigravity') throw error
      const entry = readChatCleanup(this.root, vendor)
      if (entry?.previous !== 'legacy' || !this.deadChatOwner(entry.owner)) throw error
      checkDirectory(this.root, this.generations.folder(vendor, entry.previous), entry.old)
      checkDirectory(this.root, this.generations.folder(vendor, entry.replacement), entry.adopted)
      return this.generations.rollbackUnselectedChat(vendor, entry.replacement)
    }
  }

  recoverChatCleanup(vendor) {
    if (vendor === 'antigravity' || this.recoveryClosed || this.cleanupTimers.has(vendor)
      || this.chatRecoveries.has(vendor)) return
    this.chatRecoveries.add(vendor)
    void this.retryChatCleanup(vendor).finally(() => this.chatRecoveries.delete(vendor))
  }

  async retryChatCleanup(vendor) {
    try {
      if (!readChatCleanup(this.root, vendor)) return
      const pending = this.generations.exclusive(vendor, () => {
        const entry = readChatCleanup(this.root, vendor)
        if (!entry) return
        if (!this.deadChatOwner(entry.owner)) return false
        const current = this.generations.current(vendor)
        if (current === entry.previous) {
          const staging = stagingPath(this.root, vendor)
          const marker = join(staging, entry.replacement)
          const staged = this.generations.folder(vendor, entry.replacement)
          if (existsSync(dirname(staged)) && checkDirectory(this.root, staged, entry.adopted, { missing: true })) {
            // Carry forward proof of the unselected home if any process still owns it.
            if (!readStagedHome(this.root, marker)?.owner) {
              writeStagedHome(this.root, marker, { home: entry.adopted, owner: entry.owner })
            }
          }
          completeChatCleanup(this.root, vendor)
          return
        }
        this.verify(this.checkAdoptedHome(vendor, entry))
        this.resume(vendor)
        if (oldChatRunsExited(entry, this.generations.birth)) {
          this.finishChatCleanup(vendor, entry)
          return
        }
        return this.platform === 'win32' && entry.runs === null ? entry : false
      })
      if (pending === undefined) return
      if (pending && await this.recoverWindowsChatCleanup(vendor, pending)) return
    } catch {} // Unproved or temporarily unavailable directories remain fenced off.
    if (this.recoveryClosed) return
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(vendor)
      this.recoverChatCleanup(vendor)
    }, 1000)
    timer.unref?.()
    this.cleanupTimers.set(vendor, timer)
  }

  async recoverWindowsChatCleanup(vendor, entry, deferred) {
    const old = this.generations.folder(vendor, entry.previous)
    const state = await waitForWindowsChatHome(old, this.probeChatHome)
    if (this.recoveryClosed) return true
    return this.generations.exclusive(vendor, () => {
      if (!isDeepStrictEqual(entry, readChatCleanup(this.root, vendor, deferred))) return true
      if (this.generations.current(vendor) === entry.previous) throw unverifiedLogin()
      checkDirectory(this.root, old, entry.old, { missing: true })
      if (state === 'unused' || !existsSync(old)) {
        try {
          this.finishChatCleanup(vendor, entry, deferred)
          if (deferredChatCleanups(this.root, vendor).length === 0) this.chatCleanupNotices.delete(vendor)
          return true
        } catch {} // Windows can still reject removal, for example while an open file is locked.
      }
      if (!deferred) {
        this.checkAdoptedHome(vendor, entry)
        removeStagingMarker(this.root, join(stagingPath(this.root, vendor), entry.replacement))
        deferChatCleanup(this.root, vendor, entry)
      }
      if (!this.chatCleanupNotices.has(vendor)) {
        this.chatCleanupNotices.set(vendor, chatCleanupPending)
        try { this.onChatCleanupPending(chatCleanupPending) } catch {}
      }
      return true
    })
  }

  chatCleanupNotice(vendor) { return this.chatCleanupNotices.get(vendor) }

  async retryDeferredChatCleanups(vendor) {
    if (this.platform !== 'win32' || this.recoveryClosed) return true
    const pending = this.deferredRecoveries.get(vendor)
    if (pending) return pending
    const deferred = deferredChatCleanups(this.root, vendor)
    if (deferred.length === 0) return true
    const recovery = Promise.all(deferred.map(async generation => {
      try {
        const entry = readChatCleanup(this.root, vendor, generation)
        if (entry && this.deadChatOwner(entry.owner)) {
          await this.recoverWindowsChatCleanup(vendor, entry, generation)
        }
      } catch {}
    })).then(() => deferredChatCleanups(this.root, vendor).length === 0)
      .finally(() => this.deferredRecoveries.delete(vendor))
    this.deferredRecoveries.set(vendor, recovery)
    return recovery
  }

  async completeChatSignIn(vendor) {
    if (await this.retryDeferredChatCleanups(vendor)) return
    throw Object.assign(new Error(chatCleanupPending), { code: 'acp-account/chat-cleanup-pending' })
  }

  requireNoChatCleanup(vendor) {
    if (vendor !== 'antigravity' && readChatCleanup(this.root, vendor)) {
      throw failure('The Bot account is changing. Try again when it finishes.')
    }
  }

  changing(vendor) { return existsSync(join(this.home(vendor), 'changing')) }
  matches(env) {
    assertGeneration(env)
    const file = join(env[HOME_ENV], 'version')
    return env[VERSION_ENV] === (existsSync(file) ? readFileSync(file, 'utf8') : '')
  }
  paused(vendor) { return existsSync(join(this.home(vendor), 'paused')) }
  resume(vendor) { rmSync(join(this.home(vendor), 'paused'), { force: true }) }

  recovery(vendor) {
    try {
      const home = this.home(vendor)
      this.generations.check(vendor)
      this.verify(home)
      const lock = join(home, 'changing')
      if (existsSync(lock)) {
        return this.lockState(lock) !== 'live'
      }
      return false
    } catch { return true }
  }

  recoverLogins(vendor) {
    if (this.disposed || this.recoveryClosed) return Promise.resolve(false)
    const pending = this.recovering.get(vendor)
    if (pending) return pending
    let generation
    try { generation = this.generations.current(vendor) } catch { return Promise.resolve(false) }
    const home = this.generations.folder(vendor, generation)
    if (!existsSync(join(home, 'login-trees'))) return Promise.resolve(false)
    const commit = change => {
      if (this.disposed || this.recoveryClosed) return false
      try {
        return this.generations.exclusive(vendor, () => (
          !this.disposed && !this.recoveryClosed && this.generations.current(vendor) === generation
            ? change() : false
        ))
      } catch { return false }
    }
    const recovery = reclaimWindowsLogins({
      home, owner: this.instance, controlRoot: join(this.root, 'login-jobs'), probe: this.probe, commit,
    }).then(removed => {
      if (removed > 0 && !this.disposed && !this.recoveryClosed) {
        commit(() => this.recoverChanging(home))
        try { this.generations.ensureRecord() } catch {}
      }
      return removed > 0
    }).finally(() => this.recovering.delete(vendor))
    this.recovering.set(vendor, recovery)
    return recovery
  }

  closeRecovery() {
    this.recoveryClosed = true
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer)
    this.cleanupTimers.clear()
  }

  // Reset changes only the pointer. Never move the old physical path or reuse it: a vendor
  // that survived the app still has that absolute path in its environment and may write late.
  reset(vendor) {
    const reset = this.reserveReset(vendor)
    try { return reset.complete() } finally { reset.release() }
  }

  reserveReset(vendor) {
    // Validate the vendor even when its current-generation pointer is damaged.
    if (!vendors.has(vendor)) throw new Error('No isolated home for this agent.')
    const release = this.generations.acquire(vendor)
    try {
      this.requireNoChatCleanup(vendor)
      let previous
      try { previous = this.generations.current(vendor) } catch {}
      const old = previous === undefined ? this.registered.get(vendor)
        : this.generations.folder(vendor, previous)
      this.generations.otherApps(vendor, old ?? join(this.root, vendor))
      if (old && existsSync(old)) {
        writeFileSync(join(old, 'paused'), '', { mode: 0o600 })
        writeFileSync(join(old, 'version'), randomUUID(), { mode: 0o600 })
      }
      return { home: old, release, complete: () => this.resetLocked(vendor, previous) }
    } catch (error) { release(); throw error }
  }

  resetLocked(vendor, previous) {
    const generation = randomUUID()
    const home = this.generations.folder(vendor, generation)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'paused'), '', { mode: 0o600 })
    writeFileSync(join(home, 'version'), randomUUID(), { mode: 0o600 })
    if (previous !== undefined) {
      const retired = join(this.root, 'retired', vendor)
      mkdirSync(retired, { recursive: true, mode: 0o700 })
      writeFileSync(join(retired, previous), '', { mode: 0o600 })
      // #1529: the marker says the home is retired; the note in it says what stays and how to
      // inspect or keep it. Neither removes anything, and a note failure never stops the reset.
      writeRetiredNote({ root: this.root, vendor, generation: previous, home: this.generations.folder(vendor, previous) })
    }
    this.end(vendor)
    const registered = this.registered.get(vendor)
    if (registered) {
      this.generations.release(join(registered, 'instances', this.instance))
      this.registered.delete(vendor)
    }
    this.generations.select(vendor, generation)
    this.environment(vendor)
    this.started.add(vendor)
    this.refreshSelection()
    return home
  }

  // #1529: collection keeps every retired home. Removal needs four separately proved
  // conditions - the recorded owners are dead, a complete measurement scan taken after the
  // home's last write with the root frozen, the measurement retirement record, and the
  // session-absorption receipt. The last three belong to the measurement side and to the
  // skill's receipt, so none is available here yet and the default is keep. The report is for
  // inspection and for that later gate; it never deletes, and a home whose marker, note or
  // bound path cannot be proved to be its own is refused and left untouched.
  collect(vendor) {
    if (!vendors.has(vendor)) return []
    return retiredHomes(this.root, vendor)
  }

  /** Every vendor's retired homes when no vendor is named, for inspection only. */
  retired(vendor) {
    if (vendor !== undefined) return this.collect(vendor)
    return [...vendors].flatMap(key => this.collect(key))
  }

  verify(home) {
    verifyLoginRecords(home, this.instance)
    const instances = join(home, 'instances')
    if (!existsSync(instances)) return
    for (const name of readdirSync(instances)) {
      const snapshot = ownershipAt(join(instances, name), { legacy: 'home' })
      if (!snapshot || (ownershipState(snapshot) === 'dead'
        && snapshot.record.marker !== LOGIN_RECORD_VERSION)) {
        throw unverifiedLogin()
      }
    }
  }

  // Deliberately fail closed after a crashed account operation: the app must not resume on
  // credentials whose logout could not be confirmed. A new attempt can explicitly recover
  // the lock only when its owning process AND every persisted login tree are gone.
  begin(vendor, { preserveVersion = false } = {}) {
    return this.generations.exclusive(vendor, () => this.beginLocked(vendor, preserveVersion))
  }

  beginLocked(vendor, preserveVersion) {
    this.requireNoChatCleanup(vendor)
    const home = this.home(vendor)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.verify(home)
    const lock = join(home, 'changing')
    if (existsSync(lock)) this.recoverChanging(home)
    this.environment(vendor)
    try { mkdirSync(lock, { mode: 0o700 }) } catch {
      throw failure('The Bot account is already changing. Try again when it finishes.')
    }
    this.changes.set(vendor, home)
    try {
      writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
      writeFileSync(join(lock, 'owner'), this.instance, { mode: 0o600 })
      writeFileSync(join(lock, 'birth'), JSON.stringify(this.generations.birth), { mode: 0o600 })
      this.generations.otherApps(vendor, home)
      const instances = join(home, 'instances')
      for (const name of readdirSync(instances)) {
        if (name === this.instance) continue
        const snapshot = ownershipAt(join(instances, name), { legacy: 'home' })
        if (ownershipState(snapshot) !== 'dead' || !removeDeadOwnership(snapshot)) {
          throw failure('Close other Automagik sessions before changing the Bot account.')
        }
      }
      if (preserveVersion && !existsSync(join(home, 'paused'))) {
        writeFileSync(join(lock, 'resume-chat'), '', { mode: 0o600 })
      }
      writeFileSync(join(home, 'paused'), '', { mode: 0o600 })
      if (!preserveVersion) this.advanceVersion(vendor)
    } catch (error) {
      this.end(vendor)
      throw error
    }
  }

  // The lock and pause protect admission while a preserving sign-in runs. A confirmed
  // account change invalidates launches prepared under the previous version.
  advanceVersion(vendor) {
    const home = this.changes.get(vendor)
    if (home === undefined || home !== this.home(vendor)) throw failure('The Bot account is changing.')
    const version = randomUUID()
    writeFileSync(join(home, 'version'), version, { mode: 0o600 })
    return version
  }

  lockSnapshot(lock) {
    const stat = lstatSync(lock)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unverifiedLogin()
    const fields = {}
    for (const name of ['pid', 'owner', 'birth', 'recovering', 'resume-chat']) {
      try {
        const entry = lstatSync(join(lock, name))
        if (!entry.isFile() || entry.size > 4096) throw unverifiedLogin()
        fields[name] = { bytes: readFileSync(join(lock, name), 'utf8'), dev: entry.dev, ino: entry.ino }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { dev: stat.dev, ino: stat.ino, fields }
  }

  lockState(lock, snapshot = this.lockSnapshot(lock)) {
    const { fields } = snapshot
    const pid = Number(fields.pid?.bytes)
    const owner = fields.owner?.bytes
    if (!/^\d+-[a-f0-9-]+$/.test(owner ?? '') || Number(owner.split('-')[0]) !== pid) return 'unknown'
    let birth = null
    if (fields.birth) {
      try { birth = JSON.parse(fields.birth.bytes) } catch { return 'unknown' }
      if (birth !== null && !validBirth(birth)) return 'unknown'
    }
    const state = processState(pid, birth)
    if (state !== 'dead') return state
    if (fields.recovering) {
      const claim = fields.recovering.bytes
      if (!/^\d+-[a-f0-9-]+$/.test(claim)
        || processState(Number(claim.split('-')[0]), null) !== 'dead') return 'unknown'
    }
    return 'dead'
  }

  recoverChanging(home) {
    const lock = join(home, 'changing')
    if (!existsSync(lock)) return
    this.verify(home)
    const snapshot = this.lockSnapshot(lock)
    if (this.lockState(lock, snapshot) !== 'dead') throw unverifiedLogin()
    const exact = () => JSON.stringify(this.lockSnapshot(lock)) === JSON.stringify(snapshot)
    if (!exact() || this.lockState(lock, snapshot) !== 'dead') throw unverifiedLogin()
    // A preserving chat sign-in left the selected account alone. Other interrupted
    // account changes keep the pause until proof of a subsequent sign-in.
    if (snapshot.fields['resume-chat']?.bytes === '') {
      rmSync(join(home, 'paused'), { force: true })
    } else {
      const fd = openSync(join(home, 'paused'), 'a', 0o600)
      try { fsyncSync(fd) } finally { closeSync(fd) }
    }
    // Linux/Unix directory fsync persists the new pause entry as well as its file bytes.
    if (process.platform !== 'win32') {
      const directory = openSync(home, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    this.verify(home)
    if (!exact() || this.lockState(lock, snapshot) !== 'dead' || !exact()) throw unverifiedLogin()
    rmSync(lock, { recursive: true, force: true })
  }

  startup(vendor) {
    this.generations.register(vendor)
    this.generations.exclusive(vendor, () => {
      const current = this.startupGeneration(vendor)
      const home = this.generations.folder(vendor, current)
      if (vendor !== 'antigravity') {
        this.recoverStagedHomes(vendor, current, home)
      }
      if (existsSync(home)) {
        this.verify(home)
        this.recoverChanging(home)
      }
      for (const [directory, legacy] of [[this.generations.instances(vendor), 'root'], [join(home, 'instances'), 'home']]) {
        if (!existsSync(directory)) continue
        for (const name of readdirSync(directory)) {
          if (name === this.instance) continue
          const snapshot = ownershipAt(join(directory, name), { legacy })
          if (legacy === 'home' && snapshot?.record.marker !== LOGIN_RECORD_VERSION) continue
          if (ownershipState(snapshot) === 'dead') removeDeadOwnership(snapshot)
        }
      }
    })
    this.recoverChatCleanup(vendor)
    if (vendor !== 'antigravity') void this.retryDeferredChatCleanups(vendor).catch(() => {})
    const retired = this.collect(vendor)
    if (retired.length > 0) {
      try { this.onRetired(vendor, retired) } catch {}
    }
    // The generation record follows both pointers. A matching record is left in place.
    try { this.generations.ensureRecord() } catch {
      try { this.onRecordError(vendor) } catch {}
      return
    }
    this.started.add(vendor)
    this.refreshSelection()
  }

  end(vendor) {
    const home = this.changes.get(vendor)
    if (home === undefined) return
    this.changes.delete(vendor)
    rmSync(join(home, 'changing'), { recursive: true, force: true })
  }

  closeSelection() {
    if (!this.selection) return
    const { handle } = this.selection
    if (!this.selection.closed && this.retryWithdrawal(() => handle.close())) this.selection.closed = true
  }

  clearSelection() {
    if (!this.selection) return
    const { handle, closed } = this.selection
    const removed = this.retryWithdrawal(() => handle.unlink())
    if (!closed) this.retryWithdrawal(() => handle.revoke())
    this.closeSelection()
    if (removed && this.selection.closed) this.selection = undefined
  }

  retryWithdrawal(remove) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { remove(); return true } catch {}
    }
    try { this.onSelectionError('withdrawn') } catch {}
    return false
  }

  withdraw({ unregister = this.selection !== undefined } = {}) {
    this.withdrawn = true
    this.clearSelection()
    if (!unregister) return
    // Leave the physical-home ownership in place until detached runs have drained.
    for (const vendor of this.generations.registered) {
      this.retryWithdrawal(() => this.generations.unregister(vendor, { strict: true }))
    }
  }

  dispose() {
    this.disposed = true
    this.closeRecovery()
    this.withdraw({ unregister: true })
    for (const [vendor, home] of this.registered) {
      if (this.retryWithdrawal(() => this.generations.release(join(home, 'instances', this.instance), { strict: true }))) {
        this.registered.delete(vendor)
      }
    }
  }
}

export function trackRun(run) {
  assertGeneration(run.spec.env ?? {})
  const home = run.spec.env?.[HOME_ENV]
  if (home === undefined) return
  if (existsSync(join(home, 'changing')) || existsSync(join(home, 'paused'))) {
    throw failure('The Bot account is changing. Sign in again when it finishes.')
  }
  const current = existsSync(join(home, 'version'))
    ? readFileSync(join(home, 'version'), 'utf8') : ''
  if (run.spec.env[VERSION_ENV] !== current) {
    throw failure('The Bot account changed. Start this work again after signing in.')
  }
  if (!runs.has(home)) runs.set(home, new Set())
  runs.get(home).add(run)
}

export function releaseRun(run) {
  const home = run.spec.env?.[HOME_ENV]
  if (!runs.get(home)?.has(run)) return Promise.resolve()
  if (run.accountStopping === undefined) {
    run.accountStopping = Promise.resolve().then(() => run.stop()).then(() => {
      runs.get(home)?.delete(run)
      if (runs.get(home)?.size === 0) runs.delete(home)
    })
    // The changer awaits this rejection. Background cleanup must not reject unobserved.
    run.accountStopping.catch(() => { run.accountStopping = undefined })
  }
  return run.accountStopping
}

/** How many runs are tracked on a home now (#2064, a Switch's log line). */
export function runCount(home) {
  return runs.get(home)?.size ?? 0
}

export async function stopRuns(home) {
  await Promise.all([...(runs.get(home) ?? [])].map(releaseRun))
}

function chatRunEvidence(home) {
  const evidence = []
  for (const run of runs.get(home) ?? []) {
    if (run.child && run.child.pid === undefined) continue // No process started.
    const proof = run.chatStopEvidence?.()
    if (!proof) return null
    evidence.push(proof)
  }
  return evidence
}
