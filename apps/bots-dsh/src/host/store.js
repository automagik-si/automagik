// Store: the saved team (state.json), its migrations, the lock that keeps a second dsh
// host on the same data from writing it, and the indexes that map a Session to the Bot
// or group chat it belongs to.
import { createHash } from 'node:crypto'
import { constants, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'

import { dirname, join } from 'node:path'
import { piAiClaudeOf } from './claude-models.js'
import { KEY_ERROR } from './connectors/credential-key.js'
import { connectorState, ENCRYPTED_STATE_VERSION } from './connectors/credential-state.js'
import { DRAFT_SWEEP_MAX, LEGACY_THEMES, MAX_EXCHANGES, ROOM_MODES, SECTION_COLORS, SECTION_NAME_MAX, TEXT_KEPT } from './constants.js'
import { replaceFile, syncDirectory, syncFile } from './files.js'
import { homeLock } from './home-lock.js'
import { GENIE_CLAY, shippedPet, shipsPet } from './pets.js'
import { refusal } from './refusal.js'
import { currentColor, headOf, normalize, unquote } from './text.js'
import { markOf } from '../shared/permission-levels.js'
import { effectiveMarkOf, nativeToolsOn, restrictedBot } from '../shared/native-tools.js'
import { TASK_ROUTE_DEFAULT } from '../shared/route-policy.js'
import { shellHoldModelOf, shellHoldText } from '../shared/routes.js'
import { GUARD_OFF_NOTICE } from '../shared/guard-groups.js'
import updateContract from './update-contract.json' with { type: 'json' }

// The saved team's format. A file may carry an older version this build still reads and
// migrates (the formats before the stamp count as LEGACY_VERSION); any other value means a
// newer Omni wrote it, and this one must not touch it.
const COMPATIBLE_VERSIONS = updateContract.stateFormats
const STATE_VERSION = 2
const LEGACY_VERSION = 0

// A table read that sees only the keys the table holds itself. Ids that come from
// outside (a request body, a tool argument, a name a model gives) go through this, so
// "__proto__" and other inherited names read as "not there" instead of returning
// Object.prototype.
export const own = (table, key) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined)

// Compare only the recovery fields. In particular, annotating a work does not
// open or close a request. A roster or copy save can also change a review track.
const recoveryFields = ({ bots, works }) => JSON.stringify({
  tracks: Object.keys(bots ?? {}).sort().filter(id => bots[id]?.reviewTrack !== undefined)
    .map(id => [id, bots[id].reviewTrack]),
  open: Object.keys(works ?? {}).sort().map(id => [id, works[id]?.at, works[id]?.open]),
})

export function install(rt) {
  const { ctx, home, statePath } = rt
  const credentials = connectorState(home, () => rt.ownsLockForPendingWrite())

  /** @type {{version:2, workspaceId?:string, mainBotIds:string[], bots:Record<string,any>, privateArchives:any[], rooms:Record<string,any>, agents:Record<string,any>, sections:any[], capabilities:{items:Record<string,any>}, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number}} */
  const state = { version: STATE_VERSION, mainBotIds: [], bots: {}, privateArchives: [], rooms: {}, agents: {}, sections: [], capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, requests: {}, questions: {}, views: {}, closedCards: {}, prefs: {}, switching: {}, revision: 0 }
  let loaded = null
  // Whether `state` is the team as its file has it (teamLoaded).
  let teamRead = false
  let teamPresentAtLoad = null
  // Preserve ENOENT as evidence until the supervisor decides the trial.
  const missingTeamHeld = () => teamPresentAtLoad === false && !!process.env.AUTOMAGIK_SUPERVISOR_RUN
    && rt.updateHold?.awaitingBootVerdict !== false
  let writing = Promise.resolve()
  let savedRecovery = recoveryFields(state)
  // Failed attempts stay with their owner. A published replacement can survive a takeover.
  let pendingDurability
  let unconfirmedState
  const { warn } = rt

  const diagnosticLabel = value => headOf(String(value).replace(/\s+/g, ' ').trim(), 120)
  // Keep the on-disk marker and the admission checks on the same Bot record.
  const refreshShellHolds = (bots, { log = true } = {}) => {
    let changed = false
    for (const bot of Object.values(bots)) {
      const model = shellHoldModelOf(bot)
      if (model === undefined) {
        if (bot.shellHeld !== undefined) {
          delete bot.shellHeld
          changed = true
          if (bots === state.bots) rt.dropGrantsForBot?.(bot.id)
        }
        continue
      }
      const cli = model.split('/')[0]
      if (bot.shellHeld?.model === model && bot.shellHeld.cli === cli) continue
      bot.shellHeld = { cli, model }
      changed = true
      if (bots === state.bots) rt.dropGrantsForBot?.(bot.id)
      if (log) warn('ds-bot: %s loads with its shell off on %s, a coding CLI that brings its own shell: '
        + 'it is held until the shell is turned on or it runs on a model that uses DeepSeek Harness\'s tools.',
      diagnosticLabel(bot.name ?? 'This Bot'), diagnosticLabel(cli))
    }
    return changed
  }

  const EMPTY = JSON.stringify(state)
  // The other dsh host that holds state.lock while this one only reads (see home-lock.js);
  // undefined while this host may write.
  let holder
  let lockBroken = false
  let stuck
  let warnedReadOnly = false
  let stopped = false
  // Other notes kept beside the team (resume.js's inflight.json) end their last write before
  // the lock is released at stop (rt.holdLockUntil).
  const lockWaits = new Set()
  // mtime and size of the state.json this host last read or wrote.
  let seen = ''
  // Bumped each time the in-memory state is replaced from the file, so a queued
  // save cannot write a snapshot taken of the state it replaced.
  let lockEpoch = 0
  const stamp = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  let lockTerm = 0
  // A failed read ends the term even if the lock comes back before the next heartbeat. Before
  // the first claim there is no term to end (an unusable lock keeps term 0 for resume's notes).
  let observedLoss = false
  const onLockLost = () => {
    if (observedLoss || lockTerm === 0) return
    observedLoss = true
    lockTerm++
    rt.solverSettle?.cancel()
    rt.dropAllGrants?.()
  }
  const lock = homeLock(join(home, 'state.lock'), { onLost: onLockLost })
  const gainedListeners = new Set()
  const onLockGained = (fn) => {
    gainedListeners.add(fn)
    return () => gainedListeners.delete(fn)
  }
  const lockGained = () => {
    for (const fn of gainedListeners) {
      try { fn() } catch (error) { warn('ds-bot: a lock listener failed: %s', error) }
    }
  }
  const claimLock = () => {
    if (lockBroken) return
    try {
      const held = holder === undefined && lock.owns()
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
      if (!held && holder === undefined && lock.owns()) {
        lockTerm += 1
        observedLoss = false
      }
    } catch (error) {
      // An unusable lock (a read-only or odd file system) must not stop the team; a
      // save that then cannot write still rejects.
      lockBroken = true
      rt.dropAllGrants?.()
      holder = undefined
      warn('omni-ui: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
    }
  }
  const readOnly = () => {
    if (stuck !== undefined) return `The Bot team file ${statePath} could not be read (${stuck}). Omni does not change it; fix or move the file and reload.`
    if (holder === undefined) return missingTeamHeld()
      ? 'The Bot team is read-only while the update is being checked.' : undefined
    const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
    return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`
  }

  // A file this host cannot read is copied aside byte for byte before anything can rewrite
  // it, so the person keeps the original bytes; a failed copy keeps the team read-only.
  // The name is the content's hash, so a restart that sees the same corrupt bytes finds and
  // reuses that one copy instead of adding a timestamped backup on every restart.
  let aside = false
  const setAside = (error, bytes) => {
    aside = true
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const backup = `${statePath}.broken-${digest}`
    // What is at the backup's name: a complete copy of exactly these bytes, readable bytes
    // that differ (a torn or foreign copy), or something that cannot be read at all.
    const classify = () => {
      try {
        return { case: readFileSync(backup).equals(bytes) ? 'same' : 'torn' }
      } catch (readError) {
        const reason = readError?.code ?? readError?.message ?? String(readError)
        return { case: 'unreadable', reason }
      }
    }
    try {
      // COPYFILE_EXCL: a complete copy an earlier load made is reused, never rewritten.
      copyFileSync(statePath, backup, constants.COPYFILE_EXCL)
    } catch (copyError) {
      // A copy that failed for another reason keeps the team read-only, as before.
      if (copyError?.code !== 'EEXIST') {
        stuck = copyError?.code ?? copyError?.message ?? error?.message ?? String(error)
        warn('ds-bot: unreadable state %s: %s; backup failed: %s', statePath, error, copyError)
        return undefined
      }
      // Reuse only a complete copy of exactly these bytes. A torn or foreign copy is the
      // incomplete case readOnly() names; one that cannot be read is named apart from it.
      const existing = classify()
      if (existing.case !== 'same') {
        stuck = existing.case === 'torn'
          ? 'the set-aside backup is incomplete'
          : `the set-aside backup is unreadable: ${existing.reason}`
        warn('ds-bot: unreadable state %s: %s; %s', statePath, error, stuck)
        return undefined
      }
    }
    stuck = undefined
    warn('ds-bot: unreadable state %s: %s; backed up as %s', statePath, error, backup)
    return undefined
  }

  // Populate the roster and Session indexes before a synchronous shell env resolve.
  const readFileState = () => {
    aside = false
    let contents
    try {
      contents = readFileSync(statePath)
    } catch (error) {
      seen = stamp()
      if (error?.code === 'ENOENT') {
        stuck = undefined
        unconfirmedState = undefined
        return undefined
      }
      stuck = error?.code ?? error?.message ?? String(error)
      warn('omni-ui: unreadable state %s: %s', statePath, error)
      return undefined
    }
    seen = stamp()
    const bytes = contents.toString('utf8')
    if (unconfirmedState !== bytes) unconfirmedState = undefined
    let parsed
    try {
      parsed = JSON.parse(bytes)
    } catch (error) {
      return setAside(error, contents)
    }
    // A top level that is not a plain object is corrupt, not the format before the stamp:
    // it is set aside byte for byte and refused like an unparsable file, never migrated.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // A list is described without serializing it: a deeply nested one would overflow
      // JSON.stringify, and the warning only needs the shape anyway.
      let what = 'a list'
      if (!Array.isArray(parsed)) {
        const shown = JSON.stringify(parsed)
        what = shown.length > 32 ? `${headOf(shown, 32)}…` : shown
      }
      return setAside(new Error(`the saved team is ${what}, not an object`), contents)
    }
    // The file's own version decides: only a missing stamp is the format before this field,
    // and only an exact integer in the list is compatible. Any other value or type is refused
    // untouched — never migrated and never rewritten.
    const raw = parsed?.version
    const version = raw === undefined ? LEGACY_VERSION : (Number.isInteger(raw) ? raw : undefined)
    if (version !== undefined && COMPATIBLE_VERSIONS.includes(version)) {
      stuck = undefined
      return parsed
    }
    stuck = version !== undefined && version > Math.max(...COMPATIBLE_VERSIONS)
      ? 'saved by a newer Omni; update Omni'
      : `saved by an Omni this version cannot read (format ${JSON.stringify(raw)?.slice(0, 24)})`
    return undefined
  }

  const ownPart = bot => typeof bot.sessionId === 'string' && bot.sessionId !== '' ? bot.sessionId : bot.id
  function legacyGuard(bot, team) {
    const on = bot.reviewGuardNotice
    return team.guardGroupMigrated !== true && team.reviewGuardMigrated === true
      && bot.guardOffNotice === undefined && typeof bot.reviewerId === 'string'
      && bot.reviewerId !== '' && bot.reviewerId !== bot.id && Number.isFinite(on?.at)
      && typeof on.sessionId === 'string'
      && (on.sessionId === ownPart(bot) || on.sessionId === bot.id
        || (Array.isArray(bot.segments) && bot.segments.some(part => part?.sessionId === on.sessionId)))
  }

  function guardImportProblem(team) {
    const { bots = {}, rooms = {} } = team
    if (!plain(bots) || Object.entries(bots).some(([id, bot]) => !plain(bot) || bot.id !== id)) {
      return 'the saved Bot map is invalid. Restore a valid team backup'
    }
    if (!plain(rooms) || Object.entries(rooms).some(([id, room]) => !plain(room) || room.id !== id
      || !Array.isArray(room.members) || room.members.some(id => typeof id !== 'string'))) {
      return 'the saved group map is invalid. Restore a valid team backup'
    }
    for (const room of Object.values(rooms)) {
      for (const id of room.members) {
        const bot = own(bots, id)
        if (bot?.reviewGuard !== true || legacyGuard(bot, team)) continue
        return `${diagnosticLabel(bot.name ?? id)} has the review guard on in ${diagnosticLabel(room.name ?? room.id)}. `
          + 'Restore a valid team backup or turn off that Bot\'s review guard in the saved file before reloading'
      }
    }
  }

  function migrateReviewGuard() {
    const members = new Set(Object.values(state.rooms).flatMap(room => room.members))
    const at = Date.now()
    let turnedOn = false
    let repaired = false
    for (const bot of Object.values(state.bots)) {
      const reviewer = bot.reviewerId
      const turnsOn = state.reviewGuardMigrated !== true && bot.reviewGuard !== true
        && typeof reviewer === 'string' && reviewer !== '' && reviewer !== bot.id
        && plain(own(state.bots, reviewer))
      if (members.has(bot.id) && (turnsOn || bot.reviewGuard === true)) {
        delete bot.reviewGuard
        bot.guardOffNotice = { id: GUARD_OFF_NOTICE, kind: GUARD_OFF_NOTICE, at, sessionId: ownPart(bot) }
        // A Solver upgraded straight from D1 gets only OFF. An older stored ON remains.
        repaired = true
      } else if (turnsOn) {
        bot.reviewGuard = true
        bot.reviewGuardNotice = { at, sessionId: ownPart(bot) }
        turnedOn = true
      }
    }
    state.reviewGuardMigrated = true
    state.guardGroupMigrated = true
    return { repaired, turnedOn }
  }

  // Fill `state` from the saved file and bring an older team up to date. Returns the
  // groups whose Session titles still need the new name.
  const adopt = (parsed) => {
    lockEpoch += 1
    // Until the end of this: a file that could not be read, or was set aside as corrupt,
    // leaves an empty team in memory that is not the saved one.
    rt.hostAuthority?.capture()
    teamRead = false
    if (parsed !== undefined) {
      const problem = guardImportProblem(parsed)
      if (problem !== undefined) {
        stuck = problem
        warn('ds-bot: cannot activate the saved Bot team: %s', problem)
        parsed = undefined
      }
    }
    const valid = parsed !== null && parsed !== undefined ? true : stuck === undefined && !aside
    const hadCapabilities = parsed !== null && parsed !== undefined && Object.hasOwn(parsed, 'capabilities')
    credentials.decode(parsed)
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    savedRecovery = recoveryFields(state)
    pendingDurability = undefined
    // The serializer stamps the format of the saved fields.
    state.version = STATE_VERSION
    state.prefs ??= {}
    // Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    // `computer` is the computer-use switch; absent or corrupt means off.
    if (state.computer === null || typeof state.computer !== 'object' || Array.isArray(state.computer)) state.computer = {}
    let migrated = !hadCapabilities || (parsed?.version !== STATE_VERSION && parsed?.version !== ENCRYPTED_STATE_VERSION)
    if (state.autoStamp !== state.revision && rt.dropAutoMarks()) migrated = true
    if (holder !== undefined) rt.dropAutoMarks()
    // The single DSH Agent of older teams splits into a DSH bot and the tasks record (agents.js).
    if (rt.migrateAgents?.()) migrated = true
    if (state.capabilities === null || typeof state.capabilities !== 'object' || Array.isArray(state.capabilities)) {
      state.capabilities = { items: {} }
      migrated = true
    } else if (state.capabilities.items === null || typeof state.capabilities.items !== 'object' || Array.isArray(state.capabilities.items)) {
      state.capabilities.items = {}
      migrated = true
    }
    for (const bot of Object.values(state.bots)) {
      if (!Array.isArray(bot.capabilities)) {
        bot.capabilities = []
        migrated = true
      }
      if (bot.color !== currentColor(bot.color)) {
        bot.color = currentColor(bot.color)
        migrated = true
      }
      // `bot.computer` holds the computer-use level and Always-grant apps; corrupt values reset.
      if (bot.computer !== undefined && (bot.computer === null || typeof bot.computer !== 'object' || Array.isArray(bot.computer))) delete bot.computer
      else if (bot.computer !== undefined && (bot.computer.apps === null || typeof bot.computer.apps !== 'object' || Array.isArray(bot.computer.apps))) delete bot.computer.apps
      // LEGACY: Bots saved with a lab ran on that lab's default model; the model they
      // last ran on becomes their own, so dropping the lab changes nothing for them.
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    if (refreshShellHolds(state.bots)) migrated = true
    // A team from before several Main Bots were allowed names a single one.
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
    if (!Array.isArray(state.privateArchives)) state.privateArchives = []
    // Deleted Sessions whose composer state the owner's page still removes (roster.js).
    if (Object.hasOwn(state, 'draftSweep')) {
      const sweep = [...new Set(Array.isArray(state.draftSweep) ? state.draftSweep.filter(id => typeof id === 'string' && id !== '') : [])].slice(-DRAFT_SWEEP_MAX)
      if (sweep.length > 0) state.draftSweep = sweep
      else delete state.draftSweep
    }
    if (!Array.isArray(state.sections)) state.sections = []
    else {
      const seen = new Set()
      state.sections = state.sections
        .filter(sec => sec && typeof sec === 'object' && typeof sec.id === 'string' && sec.id !== '' && typeof sec.name === 'string' && sec.name.trim() !== '' && !seen.has(sec.id) && seen.add(sec.id))
        .map(sec => ({
          id: sec.id,
          name: sec.name.trim().slice(0, SECTION_NAME_MAX),
          ...(sec.collapsed === true ? { collapsed: true } : {}),
          ...(SECTION_COLORS.includes(sec.color) ? { color: sec.color } : {}),
        }))
    }
    const sectionIds = new Set(state.sections.map(sec => sec.id))
    for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms), ...Object.values(state.agents)]) {
      if (entry.sectionId !== undefined && (typeof entry.sectionId !== 'string' || !sectionIds.has(entry.sectionId) || entry.id === state.mainBotIds[0])) {
        delete entry.sectionId
      }
    }
    // Teams from before the whale was stored at setup: their first Bot, while still a
    // Main Bot, gets it once wherever it has no look of its own. After that the whale is
    // an ordinary look the user can change, and it never passes to another Bot.
    if (state.whaleStored !== true) {
      const first = Object.values(state.bots).reduce((best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best), undefined)
      if (first !== undefined && state.mainBotIds.includes(first.id)) {
        if (!first.avatar?.shape && !first.avatar?.image) first.avatar = { ...first.avatar, shape: 'octopus' }
        if (!first.color) first.color = 'deepseek'
      }
      state.whaleStored = true
      if (first !== undefined) migrated = true
    }
    // The Main Bot's mark moved from the whale to the octopus. Once, every Main Bot still wearing the whale changes to it.
    if (state.octopusStored !== true) {
      for (const id of state.mainBotIds) {
        const bot = state.bots[id]
        if (bot?.avatar?.shape === 'whale') bot.avatar = { ...bot.avatar, shape: 'octopus' }
      }
      state.octopusStored = true
      migrated = true
    }
    // Genie's pet moved from genie-cosmic to genie-clay. Once, every Bot wearing genie-cosmic
    // changes to it.
    if (state.genieClayStored !== true) {
      for (const bot of Object.values(state.bots)) {
        const pet = bot?.avatar?.pet
        if (pet?.source === 'builtin' && pet.id === 'genie-cosmic') bot.avatar = { ...bot.avatar, pet: { ...GENIE_CLAY } }
      }
      state.genieClayStored = true
      migrated = true
    }
    // Claude through Claude Code (Oh My Claude) left Automagik; Claude comes through pi-ai's
    // anthropic route. Once, every Bot on a claude-code model moves to the pi-ai model closest
    // to it (claude-models.js) and keeps the old ref as `claudeCodeModel`, for a later move to
    // ACP's acp-claude. The Session's record of the model it ran on goes with it, so the next
    // sync selects the new one; the Session and its history stay as they are.
    if (state.claudeCodeMoved !== true) {
      for (const bot of Object.values(state.bots)) {
        const moved = piAiClaudeOf(bot?.model)
        if (moved !== undefined) {
          bot.claudeCodeModel = bot.model
          bot.model = moved
        }
        if (piAiClaudeOf(bot?.appliedModel) !== undefined) {
          delete bot.appliedModel
          delete bot.appliedEffort
        }
      }
      state.claudeCodeMoved = true
      migrated = true
    }
    // Existing omp Bots keep their native tools in the owner's direct chat once.
    // Nothing to keep writes nothing: the marker set here rides the next real save, which
    // encodes the whole state, so an omp Bot made or switched later is saved with it and
    // starts OFF.
    if (state.nativeToolsOmpKept !== true) {
      let restricted = 0
      let kept = 0
      for (const bot of Object.values(state.bots)) {
        if (bot.nativeTools !== undefined || markOf(bot.model ?? bot.appliedModel) !== 'acp-omp') continue
        if (bot.shell === false || (Array.isArray(bot.denyTools) && bot.denyTools.length > 0)) {
          restricted += 1
          continue
        }
        bot.nativeTools = true
        bot.nativeToolsKept = 'acp-omp'
        kept += 1
      }
      if (restricted > 0) warn('omni-ui: %d omp Bot(s) keep native tools off: shell access off or denied tools', restricted)
      state.nativeToolsOmpKept = true
      if (kept > 0) migrated = true
    }
    // #1564: Codex's own tools became the native-tools switch, off by default. A team saved
    // before it ran its Codex Bots on Codex's own tools; once, each keeps them in the owner's
    // direct chat (RFC 0003, Amendment: Codex native tools). A Bot with shell access off or
    // denied tools stays off: Codex's own tools would bypass both. As for omp, the marker
    // rides the next real save when nothing was kept. A Bot whose ON was saved for another agent
    // (Claude's untagged ON, omp's migrated one) and now runs on Codex ran on Codex's own tools
    // too: its ON is moved to Codex. The app stores an OFF as no value, so a Bot turned OFF is
    // migrated like any other; only an explicit `nativeTools: false` is left as it is.
    if (state.nativeToolsCodexKept !== true) {
      let restricted = 0
      let kept = 0
      for (const bot of Object.values(state.bots)) {
        if (bot === null || typeof bot !== 'object' || effectiveMarkOf(bot) !== 'acp-codex') continue
        if (bot.nativeTools === false || nativeToolsOn(bot)) continue
        if (restrictedBot(bot)) {
          restricted += 1
          continue
        }
        bot.nativeTools = true
        bot.nativeToolsAgent = 'acp-codex'
        delete bot.nativeToolsKept
        kept += 1
      }
      if (restricted > 0) warn('omni-ui: %d Codex Bot(s) kept off native tools: shell access off or denied tools', restricted)
      state.nativeToolsCodexKept = true
      if (kept > 0) migrated = true
    }
    // RFC 0048 delivery 1.5: once, each Solver made by the D1 dialog whose reviewer Bot is still on
    // the team gets the review guard (the owner's rule: always a counterpoint), with one line in its
    // chat saying so (`reviewGuardNotice`, its part read from the record, H7-6). A Solver with no
    // reviewer Bot stays off. The cosmetic Solver marker is not read. Nothing to change writes
    // nothing: the flag rides the next real save, which encodes the whole state, so a Solver made
    // or copied later keeps what its own create gave it, and an OFF the person chose stays off.
    const { repaired, turnedOn } = migrateReviewGuard()
    if (repaired || turnedOn) migrated = true
    // #1564: Antigravity got the switch too, off by default. Before it, every Antigravity Bot ran
    // agy's own tools: once, each keeps them (RFC 0003, Amendment: Antigravity native tools), with
    // the Codex block's rule: an ON saved for another agent moves to Antigravity, a Bot with shell
    // access off or denied tools stays off, an explicit `nativeTools: false` is left as it is, and
    // the marker rides the next real save when nothing was kept. A Bot made or moved to
    // Antigravity after this starts OFF.
    if (state.nativeToolsAntigravityKept !== true) {
      let restricted = 0
      let kept = 0
      for (const bot of Object.values(state.bots)) {
        if (bot === null || typeof bot !== 'object' || effectiveMarkOf(bot) !== 'acp-antigravity') continue
        if (bot.nativeTools === false || nativeToolsOn(bot)) continue
        if (restrictedBot(bot)) {
          restricted += 1
          continue
        }
        bot.nativeTools = true
        bot.nativeToolsAgent = 'acp-antigravity'
        delete bot.nativeToolsKept
        kept += 1
      }
      if (restricted > 0) warn('omni-ui: %d Antigravity Bot(s) kept off native tools: shell access off or denied tools', restricted)
      state.nativeToolsAntigravityKept = true
      if (kept > 0) migrated = true
    }
    // A builtin pet the plugin no longer ships would draw nothing: its Bot wears Genie instead.
    // Genie kept from before its approved figure names the old atlas's version: it reads as
    // the Genie shipped now (pets.js shippedPet), whatever the file says, every time.
    for (const bot of Object.values(state.bots)) {
      const pet = bot?.avatar?.pet
      if (pet?.source !== 'builtin') continue
      const worn = shipsPet(pet.id) ? shippedPet(pet) : { ...GENIE_CLAY }
      if (worn.id === pet.id && worn.version === pet.version && worn.sleep === pet.sleep) continue
      bot.avatar = { ...bot.avatar, pet: worn }
      migrated = true
    }
    if (Object.hasOwn(LEGACY_THEMES, state.prefs.theme ?? '')) {
      state.prefs.theme = LEGACY_THEMES[state.prefs.theme]
      migrated = true
    }
    if (state.works === null || typeof state.works !== 'object' || Array.isArray(state.works)) state.works = {}
    if (state.requests === null || typeof state.requests !== 'object' || Array.isArray(state.requests)) state.requests = {}
    // Group call batches (groups.js); a batch that is not whole is dropped.
    if (state.roomBatches === null || typeof state.roomBatches !== 'object' || Array.isArray(state.roomBatches)) state.roomBatches = {}
    for (const [key, batch] of Object.entries(state.roomBatches)) {
      if (!Array.isArray(batch?.pending) || !Array.isArray(batch.done) || !Array.isArray(batch.results) || batch.key !== key) delete state.roomBatches[key]
    }
    if (state.views === null || typeof state.views !== 'object' || Array.isArray(state.views)) state.views = {}
    if (state.closedCards === null || typeof state.closedCards !== 'object' || Array.isArray(state.closedCards)) state.closedCards = {}
    // LEGACY: v0.3.2 kept closed dock views here, pinning them above the composer.
    if ('closedViews' in state) {
      delete state.closedViews
      migrated = true
    }
    // LEGACY: aside cards lived in this file only before the feature shipped;
    // they are kept under btw/ per part now. A saved copy is dropped, not moved.
    if ('btwCards' in state) {
      delete state.btwCards
      migrated = true
    }
    const writer = holder === undefined && stuck === undefined
    // LEGACY: Bots no longer count the rounds they start in a group.
    for (const room of Object.values(state.rooms)) {
      if (!('botRounds' in room)) continue
      delete room.botRounds
      migrated = true
    }
    // LEGACY: the late-round limit went with the round caps, and the relay limit that
    // followed it went too. Calls it parked stay until the group's next round runs them.
    for (const room of Object.values(state.rooms)) {
      if (['lateRounds', 'quietNoticed', 'quietShown', 'relays', 'relayLimit'].every(key => room[key] === undefined)) continue
      delete room.lateRounds
      delete room.quietNoticed
      delete room.quietShown
      delete room.relays
      delete room.relayLimit
      migrated = true
    }
    // Groups from before group settings existed reply in turn, led by a Main Bot member.
    for (const room of Object.values(state.rooms)) {
      if (room.admin !== undefined && ROOM_MODES.includes(room.mode)) continue
      if (room.admin === undefined) room.admin = room.members.find(id => state.mainBotIds.includes(id)) ?? null
      if (!ROOM_MODES.includes(room.mode)) room.mode = 'everyone'
      room.notice ??= ''
      migrated = true
    }
    // A Bot deleted while a group was made or changed could stay listed in it, even as its
    // admin; it leaves the group now.
    for (const room of Object.values(state.rooms)) {
      const members = room.members.filter(id => state.bots[id])
      const admin = members.includes(room.admin) ? room.admin : null
      if (members.length === room.members.length && admin === room.admin) continue
      room.members = members
      room.admin = admin
      migrated = true
    }
    for (const room of Object.values(state.rooms)) {
      if (room.scoped === true) continue
      if (room.workDir !== undefined || Object.keys(room.memberDirs ?? {}).length > 0 || room.permission !== undefined) {
        room.scoped = true
        migrated = true
      }
    }
    // Teams from before #206 kept every long message whole in this file, written whole on
    // every save. A message between Bots is whole in its recipient's Session; a group
    // line's whole text moves to a file of its own, which only the writing host makes.
    for (const entry of state.exchanges) {
      if (typeof entry.text !== 'string' || entry.text.length <= TEXT_KEPT || entry.length !== undefined) continue
      entry.length = entry.text.length
      entry.text = headOf(entry.text, TEXT_KEPT)
      migrated = true
    }
    for (const room of writer ? Object.values(state.rooms) : []) {
      if (!Array.isArray(room.log)) continue
      const log = room.log.map(line => (typeof line.text === 'string' && line.length === undefined && typeof line.seq === 'number' ? rt.keepGroupLine(room.id, line, line.text) : line))
      if (log.some((line, index) => line !== room.log[index])) {
        room.log = log
        migrated = true
      }
    }
    // Unnamed groups from before names followed their members may still list old names.
    const stale = Object.values(state.rooms).filter(room => !room.named && room.name !== rt.autoRoomName(room.members))
    for (const room of stale) room.name = rt.autoRoomName(room.members)
    // An explicit policy permanently supersedes a fresh team's install seed.
    const retiredSeed = writer && !aside && rt.config?.routePolicy !== undefined && Object.hasOwn(state, 'taskRoutePolicySeed')
    if (retiredSeed) delete state.taskRoutePolicySeed
    indexSessions()
    rt.solverSettle?.adopted()
    rt.hostAuthority?.restore()
    teamRead = valid
    if (lockEpoch > 1) rt.connectorStateChanged?.()
    return { migrated: migrated || stale.length > 0, stale, repaired, retiredSeed }
  }

  const saveMigration = async required => {
    try {
      await save({ required })
    } catch (error) {
      warn('omni-ui: saving the migrated Bot team failed: %s', error)
    }
  }

  const load = () => loaded ??= (async () => {
    claimLock()
    if (holder !== undefined) warn('ds-bot: %s', readOnly())
    const parsed = readFileState()
    teamPresentAtLoad = parsed !== undefined ? true : stuck === undefined && !aside ? false : null
    const { migrated, stale, repaired, retiredSeed } = adopt(parsed)
    if (holder !== undefined) return
    if (teamPresentAtLoad === false && rt.config?.routePolicy === undefined) state.taskRoutePolicySeed = TASK_ROUTE_DEFAULT
    // A file set aside just now stays where it is: the person's bytes were copied, and the
    // fresh team reaches the disk on the next real save rather than within this read.
    if ((migrated || retiredSeed) && stuck === undefined && !aside) {
      // A failed write must not poison `loaded`: the migrated state stays in
      // memory and the next save() writes it.
      await saveMigration(repaired || retiredSeed)
    }
    // Not awaited: renaming a session must not hold up the first roster read.
    for (const room of stale) void rt.retitleRoom(room)
  })()

  // An outside edit of state.json while this host held the lock, found at a
  // reclaim or by a queued write that saw the file change: this host's in-memory
  // state goes aside first, then the file on disk is adopted. Queued behind
  // `writing` — and behind any adopt already queued — so no save or second
  // refresh slips between finding the change and the adopt.
  let adopting
  let recoveryPending = false
  const mayInitializeRecoveryKey = () => {
    try { return JSON.parse(readFileSync(statePath))?.version !== ENCRYPTED_STATE_VERSION } catch { return false }
  }
  const adoptAfterReclaim = () => {
    const run = (adopting ?? writing).then(async () => {
      if (stamp() !== seen) {
        const aside = `${statePath}.replaced-${Date.now()}`
        const snapshot = credentials.encode(state, { initializeKey: mayInitializeRecoveryKey() })
        try {
          if (snapshot.pending || snapshot.refused || !snapshot.keyIsCurrent()) throw refusal(KEY_ERROR)
          await writeFile(aside, snapshot.bytes, { mode: 0o600, flag: 'wx' })
          warn('ds-bot: %s changed while no host held the team; it is adopted and this host\'s state is kept as %s', statePath, aside)
        } catch (error) {
          if (snapshot.encrypted || snapshot.pending || snapshot.refused) {
            recoveryPending = true
            warn('ds-bot: keeping the current Bot team open until its recovery copy can be saved: %s', error)
            throw error
          }
          warn('ds-bot: %s changed while no host held the team; it is adopted, and this host\'s state is lost because it could not be kept aside: %s', statePath, error)
        }
      }
      const { repaired, retiredSeed } = adopt(readFileState())
      recoveryPending = false
      return repaired || retiredSeed
    })
    writing = run.catch(() => {})
    const tracked = run.then(required => required ? saveMigration(true) : undefined)
      .finally(() => { if (adopting === tracked) adopting = undefined })
    adopting = tracked
    return tracked
  }

  // The lock was this host's and is its own again. An adopt still queued is
  // awaited; otherwise the file is compared with what this host last saw:
  // unchanged means nothing external happened and the in-memory state stays,
  // changed means an outside edit is adopted the usual way.
  const reclaimHeld = () => {
    warnedReadOnly = false
    if (adopting !== undefined) return adopting
    return stamp() === seen ? undefined : adoptAfterReclaim()
  }

  // A reading host follows the file and takes over once the other host has gone.
  const refresh = async () => {
    await load()
    const hadHolder = holder !== undefined
    if (hadHolder) {
      claimLock()
      if (holder === undefined) {
        warn('omni-ui: the other dsh has closed; this one now saves the Bot team')
        warnedReadOnly = false
        const { repaired, retiredSeed } = adopt(readFileState())
        if (repaired || retiredSeed) await saveMigration(true)
        lockGained()
        return
      }
    } else if (!lockBroken && !lock.owns()) {
      rt.dropAllGrants?.()
      // A cached "writer" is stale once the lock file no longer names this host:
      // another dsh may have taken it over, or the file may just be gone. Re-claim
      // and re-check instead of trusting the flag.
      claimLock()
      if (lockBroken) return
      if (holder === undefined) {
        await reclaimHeld()
        lockGained()
        return
      }
      warn('omni-ui: %s', readOnly())
    }
    if (adopting !== undefined) return adopting
    if (recoveryPending && rt.holdsLock()) {
      await adoptAfterReclaim()
      lockGained()
      return
    }
    if ((stuck !== undefined || holder !== undefined) && stamp() !== seen) {
      const { repaired, retiredSeed } = adopt(readFileState())
      if (retiredSeed) await save({ required: true })
      else if (repaired && holder === undefined) await saveMigration(true)
    }
  }

  // Admission reads the adopted team without refreshing an unchanged writer.
  const refreshShellChoice = async () => {
    await load()
    if (adopting !== undefined || stamp() !== seen) await refresh()
  }

  const warnReadOnly = () => {
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('omni-ui: not saving the Bot team: %s', readOnly())
    }
    return false
  }
  const writable = () => {
    if (stuck !== undefined) return warnReadOnly()
    if (lockBroken) return true
    if (holder === undefined && lock.owns()) return true
    rt.dropAutoMarks()
    rt.dropAllGrants?.()
    // Lost the lock: retake it when nobody else holds it (its file was deleted), else
    // another host took it over and this one stops writing.
    if (holder === undefined) {
      claimLock()
      if (holder === undefined) {
        // A changed file is adopted first; the save queues behind that adopt.
        const pending = reclaimHeld()
        if (pending !== undefined) void pending.then(lockGained, () => {})
        else queueMicrotask(lockGained)
        return true
      }
    }
    return warnReadOnly()
  }

  rt.canWriteTeam = () => stuck === undefined && (lockBroken || (holder === undefined && lock.owns()))
  rt.lockBeating = () => lock.beating?.() !== false
  rt.holdsLock = () => {
    if (stopped || lockBroken || stuck !== undefined || holder !== undefined) return false
    if (!lock.owns()) {
      onLockLost()
      return false
    }
    observedLoss = false
    return true
  }
  // A write that was already on its way when the plugin stopped may still land: the lock is
  // released only after the writes registered here end (holdLockUntil), so it is still ours.
  rt.ownsLockForPendingWrite = () => !lockBroken && stuck === undefined && holder === undefined && lock.owns()
  rt.holdLockUntil = (pending) => { lockWaits.add(pending) }
  // RFC 0039 delivery 3: the team an ending operation began in. An adopt replaces the team in memory (`epoch`);
  // a lost and re-claimed lock ends this host's term (`term`, claimLock). Only a host that holds the team now,
  // in the same epoch and term, may publish an end.
  rt.teamGeneration = () => ({ epoch: lockEpoch, term: lockTerm })
  const sameGeneration = gen => gen?.epoch === lockEpoch && gen.term === lockTerm
  rt.sameTeam = gen => sameGeneration(gen) && rt.holdsLock()
  // A stopped host may undo its own unsaved edits in memory. Only a current writer can save them.
  rt.canRestoreTeamInMemory = gen => sameGeneration(gen) && (stopped || rt.holdsLock())
  rt.dropAutoMarks = () => {
    let dropped = false
    for (const bot of Object.values(state.bots ?? {})) {
      if (Object.hasOwn(bot, 'permissionAuto')) { delete bot.permissionAuto; dropped = true }
    }
    for (const task of Object.values(state.tasks ?? {})) {
      for (const key of ['auto', 'autoRev']) if (Object.hasOwn(task, key)) { delete task[key]; dropped = true }
    }
    return dropped
  }
  rt.saveCopy = (change, { beforeCommit, afterPublish, afterWrite, durable = false } = {}) => {
    const admitted = rt.teamGeneration()
    if (missingTeamHeld()) return Promise.reject(new Error(`This host cannot save the Bot team: ${readOnly()}`))
    if (stopped || !writable()) return Promise.reject(new Error('This host cannot save the Bot team.'))
    refreshShellHolds(state.bots)
    indexSessions()
    rt.sweepAuto?.()
    if (afterWrite !== undefined || afterPublish !== undefined) {
      let revision
      const applyCopy = callback => {
        state.revision = state.autoStamp = revision
        state.version = STATE_VERSION
        state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
        callback()
        refreshShellHolds(state.bots)
      }
      return writeSnapshot(() => {
        const copy = credentials.clone(state)
        change(copy)
        refreshShellHolds(copy.bots, { log: false })
        revision = state.revision + 1
        copy.revision = copy.autoStamp = revision
        copy.version = STATE_VERSION
        copy.exchanges = copy.exchanges.slice(-MAX_EXCHANGES)
        return copy
      }, {
        required: true,
        durable,
        admitted,
        epoch: lockEpoch,
        beforeCommit,
        afterPublish: afterPublish && (current => {
          if (current) applyCopy(() => afterPublish(true))
          else afterPublish(false)
        }),
        afterWrite: afterWrite && (() => applyCopy(afterWrite)),
      })
    }
    state.revision += 1
    state.autoStamp = state.revision
    state.version = STATE_VERSION
    state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
    const copy = credentials.clone(state)
    change(copy)
    refreshShellHolds(copy.bots, { log: false })
    // Permission copies belong to the state the caller inspected. Never apply one
    // to a replacement team adopted while this write waited.
    const useLiveConnectors = JSON.stringify(copy.connectors) === JSON.stringify(state.connectors)
    return writeSnapshot(() => {
      // Permission copies take the current connector rows when their changes only touch other settings.
      if (useLiveConnectors && state.connectors !== undefined) copy.connectors = state.connectors
      else if (useLiveConnectors) delete copy.connectors
      if (copy.revision < state.revision) copy.revision = copy.autoStamp = state.revision + 1
      return copy
    }, { required: true, durable, admitted, epoch: lockEpoch, afterWrite: () => {
      if (copy.revision > state.revision) state.revision = state.autoStamp = copy.revision
    } })
  }

  const save = ({ required = false, durable = false, copy, enableNativeTools, nativeToolsAgent } = {}) => {
    if (copy !== undefined) return rt.saveCopy(copy.change, { durable, ...copy })
    const admitted = durable ? rt.teamGeneration() : undefined
    if (stopped) return required ? Promise.reject(new Error('The Bot team cannot be saved after this host stopped.')) : writing
    refreshShellHolds(state.bots)
    indexSessions()
    // A reading host keeps the file's revision, so its window does not skip the next change.
    if (missingTeamHeld() || !writable()) return required ? Promise.reject(new Error(`This host cannot save the Bot team: ${readOnly()}`)) : writing
    return writeSnapshot(() => {
      refreshShellHolds(state.bots)
      rt.sweepAuto?.()
      state.revision += 1
      state.autoStamp = state.revision
      state.version = STATE_VERSION
      state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
      if (enableNativeTools === undefined) return state
      // ON belongs to this write's encoding until the owner route receives its
      // acknowledgement. Other saves continue to encode the live Bot record.
      const bot = enableNativeTools
      if (own(state.bots, bot.id) !== bot) throw refusal('The Bot team changed. Try again.')
      // The commit point: ON is written for the agent the Bot runs on, or not at all.
      if (nativeToolsAgent === undefined || effectiveMarkOf(bot) !== nativeToolsAgent) throw refusal('The Bot team changed. Try again.')
      const enabled = { ...bot, nativeTools: true, nativeToolsAgent }
      delete enabled.nativeToolsKept
      return { ...state, bots: { ...state.bots, [bot.id]: enabled } }
    }, { required, durable, admitted })
  }

  let warnedCredentialSave = false
  const writeSnapshot = (snapshotOf, { required = false, durable = false, admitted, epoch: copyEpoch, beforeCommit, afterPublish, afterWrite } = {}) => {
    const run = writing.then(async () => {
      // An adopt ahead of this save may have made the team read-only.
      if (missingTeamHeld()) {
        if (required) throw new Error(`This host cannot save the Bot team: ${readOnly()}`)
        return
      }
      if (stuck !== undefined || holder !== undefined) {
        if (required) throw new Error(`This host cannot save the Bot team: ${readOnly()}`)
        warnReadOnly()
        return
      }
      const epoch = copyEpoch ?? lockEpoch
      // Ordinary saves use the adopted state, not a snapshot of the replaced team.
      const generation = admitted ?? rt.teamGeneration()
      const temp = `${statePath}.${process.pid}.tmp`
      let flush = durable
      try {
        if (durable && sameGeneration(generation)) pendingDurability = generation
        await mkdir(home, { recursive: true })
        const ensureLock = () => {
          const owned = lockBroken || lock.owns()
          const current = lockBroken ? '' : stamp()
          // An outside edit is adopted instead of overwritten; deletion can be saved again.
          const changed = owned && current !== '' && current !== seen
          if (changed) void adoptAfterReclaim().catch(() => {})
          if (!owned || changed || lockEpoch !== epoch || (flush && !sameGeneration(generation))) {
            const error = new Error(changed ? 'ds-bot: the Bot team file changed under this host\'s lock' : 'ds-bot lost the state lock to another dsh')
            error.code = 'ELOCKLOST'
            rt.dropAllGrants?.()
            throw error
          }
        }
        ensureLock()
        const data = snapshotOf()
        const recovery = recoveryFields(data)
        flush ||= recovery !== savedRecovery || unconfirmedState !== undefined || sameGeneration(pendingDurability)
        if (flush) {
          ensureLock()
          pendingDurability = generation
        }
        const snapshot = credentials.encode(data)
        if (snapshot.refused) throw refusal(KEY_ERROR)
        if (snapshot.pending && !warnedCredentialSave) {
          warnedCredentialSave = true
          warn('ds-bot: %s', KEY_ERROR)
        }
        await writeFile(temp, snapshot.bytes, 'utf8')
        if (flush) await syncFile(temp)
        const ensureKey = () => {
          if (!snapshot.keyIsCurrent()) throw refusal(KEY_ERROR)
        }
        const ensureCommit = () => {
          ensureLock()
          const checked = beforeCommit?.()
          if (typeof checked?.then === 'function') return checked.then(() => {
            ensureLock()
            ensureKey()
          })
          ensureKey()
        }
        const checked = ensureCommit()
        if (checked !== undefined) await checked
        await replaceFile(temp, statePath, ensureCommit)
        // Even if the directory sync fails, this rename was ours. A later save
        // can retry durability without mistaking the new stamp for an outside edit.
        seen = stamp()
        savedRecovery = recovery
        if (flush) {
          pendingDurability = undefined
          unconfirmedState = snapshot.bytes
        }
        afterPublish?.(lockEpoch === epoch)
        if (flush) {
          await syncDirectory(dirname(statePath))
          unconfirmedState = undefined
          ensureLock()
        }
        snapshot.commit()
        afterWrite?.()
        // The file now holds this team, a fresh one after a corrupt file included.
        if (stuck === undefined) teamRead = true
        rt.capabilitiesStateSaved?.()
        for (const listener of savedListeners) {
          try { listener() } catch (error) { warn('omni-ui: saved listener failed: %s', error) }
        }
        return true
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = run.then(() => {}, () => {})
    return run.catch(error => {
      warn('omni-ui: state write failed: %s', error)
      throw error
    })
  }

  ctx.effect(() => () => {
    stopped = true
    return Promise.allSettled([writing, ...[...lockWaits].map(pending => pending())]).finally(() => lock.release())
  }, 'omni-ui: state lock')

  const botOf = id => (id === undefined ? undefined : own(state.bots, id))
  // A group's own Session moves on to a fresh part when the group's folder no longer
  // matches the one it was made in (parts.js), like a Bot's own chat: `room.id` stays
  // the first Session's id and `room.sessionId` the current one, so the group keeps
  // one identity while its Session moves. `roomOwners` maps the current Session.
  const roomOf = id => (id === undefined ? undefined : own(state.rooms, id) ?? own(state.rooms, roomOwners.get(id)))
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)

  // Group Sessions. A member speaks in each group from a hidden Session of its own,
  // `room.sessions[botId]`, that renders the same system prompt and tools as its own
  // chat: the provider's prefix cache is shared, and a group turn never re-reads the
  // member's private context. Created on the member's first turn in the group.
  //
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js), and a group's own Session to a fresh part when the group's folder
  // changes. A Bot's id is the Session id of its first own-chat segment and never
  // changes; `bot.sessionId` is the current one, and `room.sessionId` the group's.
  // Earlier segments, of the own chat (`bot.segments`), of each group Session
  // (`room.segments[botId]`) and of the group's own Session (`room.parts`), are
  // archived and stay readable.
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  // Single-run task Sessions a subscription started for a Bot (subscriptions.js).
  const taskOwners = new Map()
  /** @type {Map<string, string>} */
  const roomOwners = new Map()
  /** @type {Map<string, {botId?:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  const sessionOfRoom = room => (room === undefined ? undefined : room.sessionId ?? room.id)
  // DSH turns away every step of an archived Session and every task aimed at it, so a
  // Session the team speaks from now leaves the archive: an earlier open of an old part
  // could leave one there, and DSH's own Session list can archive one. Earlier parts
  // stay archived.
  let restoring
  const restoreCurrent = () => {
    const registry = ctx.workspaceRegistry
    if (restoring !== undefined || readOnly() !== undefined || typeof registry?.unarchiveSession !== 'function') return
    const leave = enterOwnership()
    try {
      let archived
      try { archived = new Set(registry.archivedSessionIds ?? []) } catch { return }
      const held = [...chatOwners.keys(), ...groupOwners.keys(), ...roomOwners.keys()].filter(id => archived.has(id) && botOf(selfOf(id))?.shellHeld === undefined)
      if (held.length === 0) return
      restoring = (async () => {
        for (const sessionId of held) {
          await registry.unarchiveSession(sessionId)
            .then(() => warn('omni-ui: current Session %s was archived in DSH; taken back out', sessionId))
            .catch(error => warn('omni-ui: current Session %s is archived in DSH and could not be taken out: %s', sessionId, error))
        }
      })().finally(() => { restoring = undefined; leave() })
    } finally {
      if (restoring === undefined) leave()
    }
  }
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    roomOwners.clear()
    pastOwners.clear()
    taskOwners.clear()
    for (const run of state.subscriptionRuns ?? []) if (run.sessionId && run.botId && run.task) taskOwners.set(run.sessionId, { botId: run.botId, ...(run.shellOffCli === true ? { shellOffCli: true } : {}) })
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id, ...(segment.shellOffCli === true ? { shellOffCli: true } : {}) })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
    for (const room of Object.values(state.rooms)) {
      const sessionId = sessionOfRoom(room)
      if (sessionId !== undefined) roomOwners.set(sessionId, room.id)
      for (const segment of room.parts ?? []) pastOwners.set(segment.sessionId, { roomId: room.id })
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id, ...(segment.shellOffCli === true ? { shellOffCli: true } : {}) })
      }
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
    }
    // The agents module owns the DSH Agent session index, and tools.js re-syncs
    // the scoped tools with this ownership (drops Sessions that left, scopes
    // live Agents that joined); both install after this.
    rt.indexAgents?.()
    rt.roleRuntime?.reconcile?.()
    rt.syncScopedTools?.()
    restoreCurrent()
  }
  // The Bot a Session speaks for: its own chat, one of its group Sessions, or an
  // earlier segment of either.
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? taskOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id) || taskOwners.has(id)
  const assertShellChoice = (sessionId, botId) => {
    const task = own(state.tasks, sessionId)
    const owner = botOf(selfOf(sessionId) ?? task?.from)
    const target = botOf(botId)
    const held = owner?.shellHeld !== undefined ? owner : target?.shellHeld !== undefined ? target : undefined
    if (held !== undefined) throw Object.assign(new Error(shellHoldText(held)), { code: 'bot/shell' })
    if (owner?.shell === false && (pastOwners.get(sessionId)?.shellOffCli === true || task?.shellOffCli === true
      || taskOwners.get(sessionId)?.shellOffCli === true)) {
      throw Object.assign(new Error('This earlier Session was set aside when the Bot moved off its coding CLI.'), { code: 'bot/shell' })
    }
  }
  const groupSessionsOf = botId => Object.values(state.rooms).map(room => room.sessions?.[botId]).filter(Boolean)
  // Ownership changes are counted from their first read until the last write.
  let ownershipRuns = 0
  const enterOwnership = () => {
    ownershipRuns += 1
    let left = false
    return () => { if (!left) { left = true; ownershipRuns -= 1 } }
  }
  const plain = value => {
    if (value === null || typeof value !== 'object') return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }
  // Scan raw ownership: the indexes may still describe the team before the drop.
  // Per-Session records such as questions and views describe a Session without owning it.
  const sessionNamed = (sessionId, room, botId) => {
    const optionalId = value => value !== undefined && (typeof value !== 'string' || value === sessionId)
    const listNames = (list, item) => {
      if (list === undefined) return false
      if (!Array.isArray(list)) return true
      for (let i = 0; i < list.length; i += 1) {
        if (!Object.hasOwn(list, i) || item(list[i])) return true
      }
      return false
    }
    const idNames = id => typeof id !== 'string' || id === sessionId
    const parts = list => listNames(list, part => !plain(part) || idNames(part.sessionId))
    const table = (value, item) => value !== undefined && (!plain(value) || Object.entries(value).some(([key, entry]) => key === sessionId || item(entry, key)))
    if (!plain(state.bots) || !plain(state.rooms)) return true
    if (table(state.bots, (bot, key) => !plain(bot) || bot.id !== key || optionalId(bot.sessionId) || parts(bot.segments))) return true
    if (table(state.rooms, (other, key) => !plain(other) || other.id !== key || optionalId(other.sessionId) || parts(other.parts)
      || table(other.sessions, entry => typeof entry !== 'string' || entry === sessionId) || table(other.segments, entry => parts(entry ?? null)))) return true
    if (table(state.switching, owner => !plain(owner) || (owner.botId === undefined && owner.roomId === undefined)
      || (owner.botId !== undefined && typeof owner.botId !== 'string') || (owner.roomId !== undefined && typeof owner.roomId !== 'string')
      || (owner.botId === botId && owner.roomId === room.id))) return true
    if (table(state.tasks, task => !plain(task)) || taskOwners.has(sessionId)) return true
    if (listNames(state.subscriptionRuns, run => !plain(run) || optionalId(run.sessionId))) return true
    return table(state.agents, agent => !plain(agent) || listNames(agent.sessions, idNames))
  }
  const seatAuthority = room => ownershipRuns === 0 && teamCurrent() && own(state.rooms, room.id) === room
    && rt.holdsLock() === true && readOnly() === undefined
  const seatEnded = (room, botId, options, sessionId) => {
    if (!seatAuthority(room) || sessionNamed(sessionId, room, botId)) return undefined
    const explicit = options !== undefined && Object.hasOwn(options, 'bot')
    const member = explicit ? options.bot : botOf(botId)
    if (member === undefined) return undefined
    // Hooks can change the team synchronously, so validate ownership and authority again.
    return () => {
      const returns = rt.returnsTo?.(sessionId)
      if (returns !== undefined && returns !== false) return undefined
      const hooks = rt.extended?.sessionOwnerRead
      if (hooks !== undefined && (typeof hooks !== 'function' || hooks(sessionId) !== 'free')) return undefined
      if ((!explicit && botOf(botId) !== member) || sessionNamed(sessionId, room, botId) || !seatAuthority(room)) return undefined
      return (owner, entry) => owner?.kind === 'group' && owner.room === room && owner.bot === member
        && (entry.ownerSessionId ?? entry.sessionId) === sessionId ? 'group' : undefined
    }
  }
  const dropGroupSession = (room, botId, options) => {
    if (room.memberDirs !== undefined) delete room.memberDirs[botId]
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    const readLabels = rt.prepareGroupApprovalCancel?.(sessionId, () => seatEnded(room, botId, options, sessionId))
    for (const segment of room.segments?.[botId] ?? []) delete state.switching[segment.sessionId]
    if (room.segments !== undefined) delete room.segments[botId]
    delete state.switching[sessionId]
    groupOwners.delete(sessionId)
    rt.cancelApprovals?.(sessionId, readLabels)
    // A plain archive refuses a running Session, which would go on working for a group
    // that no longer has it.
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
    rt.endGrants?.(sessionId, 'group')
  }
  // A group Session DSH can no longer open is set aside; the member's earlier parts in
  // the group stay, and its next turn there starts a new Session.
  const retireGroupSession = (room, botId, options) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    const readLabels = rt.prepareGroupApprovalCancel?.(sessionId, () => seatEnded(room, botId, options, sessionId))
    groupOwners.delete(sessionId)
    rt.cancelApprovals?.(sessionId, readLabels)
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
    rt.endGrants?.(sessionId, 'group')
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    const byId = own(state.bots, ref)
    if (byId) return byId
    const wanted = normalize(unquote(ref)).replace(/^@/, '')
    return Object.values(state.bots).find(bot => normalize(bot.name) === wanted)
  }
  // Every group chat whose id or name matches; callers refuse an ambiguous name.
  const findRooms = (ref) => {
    if (ref === undefined || ref === null) return []
    const byId = own(state.rooms, ref)
    if (byId) return [byId]
    const wanted = normalize(unquote(ref))
    return Object.values(state.rooms).filter(room => normalize(room.name) === wanted)
  }
  const isAdminOf = (room, id) => id !== undefined && room.admin === id

  // Whether the team in memory was read from its file, or is a new team no file held yet,
  // or was saved since: false before the first load, and after a file that could not be
  // read or was set aside as corrupt. It reads memory only.
  const teamLoaded = () => teamRead
  const teamCurrent = () => adopting === undefined && stamp() === seen

  const savedListeners = new Set()
  const onSaved = (listener) => {
    savedListeners.add(listener)
    return () => savedListeners.delete(listener)
  }

  // A question or view card closed without an answer on the card (dismissed, or
  // answered by a message) stays in the chat, read-only: by the Session where it
  // was asked, its call id and how it closed. A card answered on the card shows
  // on its reply message.
  const closeCard = (sessionId, card, outcome) => {
    if (typeof card?.callId !== 'string') return
    const target = typeof card.callSessionId === 'string' ? card.callSessionId : sessionId
    state.closedCards[target] = { ...own(state.closedCards, target), [card.callId]: outcome }
  }

  Object.assign(rt, {
    state, load, save, refresh, readOnly, teamLoaded,
    connectorCredentialsUnavailable: credentials.hasUnavailable,
    retryConnectorCredentials: () => credentials.retry(state.connectors),
    // The first read distinguishes an absent roster from a saved empty team.
    teamHealth: () => teamPresentAtLoad !== null && teamRead && stuck === undefined && !aside
      ? { present: teamPresentAtLoad, revision: state.revision, bots: Object.keys(state.bots).length } : null,
    teamCurrent, own, onSaved, onLockGained, lockTerm: () => lockTerm, closeCard, assertShellChoice, refreshShellChoice,
    botOf, roomOf, isMain, chatOf, sessionOfRoom, selfOf, isBotSession,
    chatOwners, groupOwners, roomOwners, pastOwners, taskOwners, indexSessions,
    groupSessionsOf, dropGroupSession, retireGroupSession, findBot, findRooms, isAdminOf,
    enterOwnership, ownershipBusy: () => ownershipRuns,
  })
}

