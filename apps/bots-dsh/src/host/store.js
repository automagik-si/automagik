// Store: the saved team (state.json), its migrations, the lock that keeps a second dsh
// host on the same data from writing it, and the indexes that map a Session to the Bot
// or group chat it belongs to.
import { createHash } from 'node:crypto'
import { constants, copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'

// The saved team's format. A file may carry an older version this build still reads and
// migrates (the formats before the stamp count as LEGACY_VERSION); any other value means a
// newer Omni wrote it, and this one must not touch it.
const STATE_VERSION = 1
const LEGACY_VERSION = 0
const COMPATIBLE_VERSIONS = [LEGACY_VERSION, STATE_VERSION]
import { join } from 'node:path'
import { piAiClaudeOf } from './claude-models.js'
import { LEGACY_THEMES, MAX_EXCHANGES, ROOM_MODES, TEXT_KEPT } from './constants.js'
import { replaceFile } from './files.js'
import { homeLock } from './home-lock.js'
import { GENIE_CLAY, shippedPet, shipsPet } from './pets.js'
import { currentColor, headOf, normalize, unquote } from './text.js'

// A table read that sees only the keys the table holds itself. Ids that come from
// outside (a request body, a tool argument, a name a model gives) go through this, so
// "__proto__" and other inherited names read as "not there" instead of returning
// Object.prototype.
export const own = (table, key) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined)

export function install(rt) {
  const { ctx, home, statePath } = rt

  /** @type {{version:1, workspaceId?:string, mainBotIds:string[], bots:Record<string,any>, rooms:Record<string,any>, agents:Record<string,any>, capabilities:{items:Record<string,any>}, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number}} */
  const state = { version: STATE_VERSION, mainBotIds: [], bots: {}, rooms: {}, agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, requests: {}, questions: {}, views: {}, prefs: {}, switching: {}, revision: 0 }
  let loaded = null
  // Whether `state` is the team as its file has it (teamLoaded).
  let teamRead = false
  let writing = Promise.resolve()
  const { warn } = rt

  const EMPTY = JSON.stringify(state)
  // The other dsh host that holds state.lock while this one only reads (see home-lock.js);
  // undefined while this host may write.
  let holder
  let lockBroken = false
  let stuck
  let warnedReadOnly = false
  let stopped = false
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
  const lock = homeLock(join(home, 'state.lock'))
  const claimLock = () => {
    if (lockBroken) return
    try {
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
    } catch (error) {
      // An unusable lock (a read-only or odd file system) must not stop the team; a
      // save that then cannot write still rejects.
      lockBroken = true
      holder = undefined
      warn('ds-bot: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
    }
  }
  const readOnly = () => {
    if (stuck !== undefined) return `The Bot team file ${statePath} could not be read (${stuck}). Omni does not change it; fix or move the file and reload.`
    if (holder === undefined) return undefined
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
        return undefined
      }
      stuck = error?.code ?? error?.message ?? String(error)
      warn('ds-bot: unreadable state %s: %s', statePath, error)
      return undefined
    }
    seen = stamp()
    let parsed
    try {
      parsed = JSON.parse(contents.toString('utf8'))
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
    stuck = version !== undefined && version > STATE_VERSION
      ? 'saved by a newer Omni; update Omni'
      : `saved by an Omni this version cannot read (format ${JSON.stringify(raw)?.slice(0, 24)})`
    return undefined
  }

  // Fill `state` from the saved file and bring an older team up to date. Returns the
  // groups whose Session titles still need the new name.
  const adopt = (parsed) => {
    lockEpoch += 1
    // Until the end of this: a file that could not be read, or was set aside as corrupt,
    // leaves an empty team in memory that is not the saved one.
    teamRead = false
    const valid = parsed !== null && parsed !== undefined ? true : stuck === undefined && !aside
    const hadCapabilities = parsed !== null && parsed !== undefined && Object.hasOwn(parsed, 'capabilities')
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    // Every read ends in the current format; the next save writes this stamp.
    state.version = STATE_VERSION
    state.prefs ??= {}
    // Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    let migrated = !hadCapabilities
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
      // LEGACY: Bots saved with a lab ran on that lab's default model; the model they
      // last ran on becomes their own, so dropping the lab changes nothing for them.
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    // A team from before several Main Bots were allowed names a single one.
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
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
    if (state.views === null || typeof state.views !== 'object' || Array.isArray(state.views)) state.views = {}
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
    // LEGACY: the late-round limit went with the round caps; a group counts relays to
    // its pause now.
    for (const room of Object.values(state.rooms)) {
      if (room.lateRounds === undefined && room.quietNoticed === undefined && room.quietShown === undefined) continue
      delete room.lateRounds
      delete room.quietNoticed
      delete room.quietShown
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
    indexSessions()
    teamRead = valid
    return { migrated: migrated || stale.length > 0, stale }
  }

  const load = () => loaded ??= (async () => {
    claimLock()
    if (holder !== undefined) warn('ds-bot: %s', readOnly())
    const { migrated, stale } = adopt(readFileState())
    if (holder !== undefined) return
    // A file set aside just now stays where it is: the person's bytes were copied, and the
    // fresh team reaches the disk on the next real save rather than within this read.
    if (migrated && stuck === undefined && !aside) {
      // A failed write must not poison `loaded`: the migrated state stays in
      // memory and the next save() writes it.
      try {
        await save()
      } catch (error) {
        warn('ds-bot: saving the migrated Bot team failed: %s', error)
      }
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
  const adoptAfterReclaim = () => {
    const run = (adopting ?? writing).then(async () => {
      if (stamp() !== seen) {
        const aside = `${statePath}.replaced-${Date.now()}`
        try {
          await writeFile(aside, JSON.stringify(state))
          warn('ds-bot: %s changed while no host held the team; it is adopted and this host\'s state is kept as %s', statePath, aside)
        } catch (error) {
          warn('ds-bot: %s changed while no host held the team; it is adopted, and this host\'s state is lost because it could not be kept aside: %s', statePath, error)
        }
      }
      adopt(readFileState())
    })
    writing = run.catch(() => {})
    const tracked = run.finally(() => { if (adopting === tracked) adopting = undefined })
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
        warn('ds-bot: the other dsh has closed; this one now saves the Bot team')
        warnedReadOnly = false
        adopt(readFileState())
        return
      }
    } else if (!lockBroken && !lock.owns()) {
      // A cached "writer" is stale once the lock file no longer names this host:
      // another dsh may have taken it over, or the file may just be gone. Re-claim
      // and re-check instead of trusting the flag.
      claimLock()
      if (lockBroken) return
      if (holder === undefined) {
        await reclaimHeld()
        return
      }
      warn('ds-bot: %s', readOnly())
    }
    if (adopting !== undefined) return adopting
    if ((stuck !== undefined || holder !== undefined) && stamp() !== seen) adopt(readFileState())
  }

  const warnReadOnly = () => {
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('ds-bot: not saving the Bot team: %s', readOnly())
    }
    return false
  }
  const writable = () => {
    if (stuck !== undefined) return warnReadOnly()
    if (lockBroken) return true
    if (holder === undefined && lock.owns()) return true
    rt.dropAutoMarks()
    // Lost the lock: retake it when nobody else holds it (its file was deleted), else
    // another host took it over and this one stops writing.
    if (holder === undefined) {
      claimLock()
      if (holder === undefined) {
        // A changed file is adopted first; the save queues behind that adopt.
        const pending = reclaimHeld()
        if (pending !== undefined) void pending.catch(() => {})
        return true
      }
    }
    return warnReadOnly()
  }

  rt.holdsLock = () => !stopped && !lockBroken && stuck === undefined && holder === undefined && lock.owns()
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
  rt.saveCopy = (change) => {
    if (stopped || !writable()) return Promise.reject(new Error('This host cannot save the Bot team.'))
    indexSessions()
    rt.sweepAuto?.()
    state.revision += 1
    state.autoStamp = state.revision
    state.version = STATE_VERSION
    state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
    const copy = JSON.parse(JSON.stringify(state))
    change(copy)
    // Permission copies belong to the state the caller inspected. Never apply one
    // to a replacement team adopted while this write waited.
    const snapshot = JSON.stringify(copy)
    return writeSnapshot(() => snapshot, { required: true, epoch: lockEpoch })
  }

  const save = ({ required = false } = {}) => {
    if (stopped) return required ? Promise.reject(new Error('The Bot team cannot be saved after this host stopped.')) : writing
    indexSessions()
    // A reading host keeps the file's revision, so its window does not skip the next change.
    if (!writable()) return required ? Promise.reject(new Error(`This host cannot save the Bot team: ${readOnly()}`)) : writing
    return writeSnapshot(() => {
      rt.sweepAuto?.()
      state.revision += 1
      state.autoStamp = state.revision
      state.version = STATE_VERSION
      state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
      return JSON.stringify(state)
    }, { required })
  }

  const writeSnapshot = (snapshotOf, { required = false, epoch: copyEpoch } = {}) => {
    const run = writing.then(async () => {
      // An adopt ahead of this save may have made the team read-only.
      if (stuck !== undefined || holder !== undefined) {
        if (required) throw new Error(`This host cannot save the Bot team: ${readOnly()}`)
        warnReadOnly()
        return
      }
      const epoch = copyEpoch ?? lockEpoch
      // Ordinary saves use the adopted state, not a snapshot of the replaced team.
      const snapshot = snapshotOf()
      const temp = `${statePath}.${process.pid}.tmp`
      try {
        await mkdir(home, { recursive: true })
        const ensureLock = () => {
          if (lockBroken) return
          const owned = lock.owns()
          const current = stamp()
          // An outside edit is adopted instead of overwritten; deletion can be saved again.
          const changed = owned && current !== '' && current !== seen
          if (changed) void adoptAfterReclaim().catch(() => {})
          if (!owned || changed || lockEpoch !== epoch) {
            const error = new Error(changed ? 'ds-bot: the Bot team file changed under this host\'s lock' : 'ds-bot lost the state lock to another dsh')
            error.code = 'ELOCKLOST'
            throw error
          }
        }
        ensureLock()
        await writeFile(temp, snapshot, 'utf8')
        ensureLock()
        await replaceFile(temp, statePath, ensureLock)
        seen = stamp()
        // The file now holds this team, a fresh one after a corrupt file included.
        if (stuck === undefined) teamRead = true
        rt.capabilitiesStateSaved?.()
        rt.stateSaved?.()
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = run.catch(() => {})
    return run.catch(error => {
      warn('ds-bot: state write failed: %s', error)
      throw error
    })
  }

  ctx.effect(() => () => {
    stopped = true
    return writing.finally(() => lock.release())
  }, 'ds-bot: state lock')

  const botOf = id => (id === undefined ? undefined : own(state.bots, id))
  const roomOf = id => (id === undefined ? undefined : own(state.rooms, id))
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)

  // Group Sessions. A member speaks in each group from a hidden Session of its own,
  // `room.sessions[botId]`, that renders the same system prompt and tools as its own
  // chat: the provider's prefix cache is shared, and a group turn never re-reads the
  // member's private context. Created on the member's first turn in the group.
  //
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js). A Bot's id is the Session id of its first own-chat segment and
  // never changes; `bot.sessionId` is the current one. Earlier segments, of the own
  // chat (`bot.segments`) and of each group Session (`room.segments[botId]`), are
  // archived and stay readable.
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  // Single-run task Sessions a subscription started for a Bot (subscriptions.js).
  const taskOwners = new Map()
  /** @type {Map<string, {botId:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  // DSH turns away every step of an archived Session and every task aimed at it, so a
  // Session the team speaks from now leaves the archive: an earlier open of an old part
  // could leave one there, and DSH's own Session list can archive one. Earlier parts
  // stay archived.
  let restoring
  const restoreCurrent = () => {
    const registry = ctx.workspaceRegistry
    if (restoring !== undefined || readOnly() !== undefined || typeof registry?.unarchiveSession !== 'function') return
    let archived
    try {
      archived = new Set(registry.archivedSessionIds ?? [])
    } catch {
      return
    }
    const held = [...chatOwners.keys(), ...groupOwners.keys(), ...Object.keys(state.rooms)].filter(id => archived.has(id))
    if (held.length === 0) return
    restoring = (async () => {
      for (const sessionId of held) {
        await registry.unarchiveSession(sessionId)
          .then(() => warn('ds-bot: current Session %s was archived in DSH; taken back out', sessionId))
          .catch(error => warn('ds-bot: current Session %s is archived in DSH and could not be taken out: %s', sessionId, error))
      }
    })().finally(() => { restoring = undefined })
  }
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    pastOwners.clear()
    taskOwners.clear()
    for (const run of state.subscriptionRuns ?? []) if (run.sessionId && run.botId && run.task) taskOwners.set(run.sessionId, { botId: run.botId })
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
    for (const room of Object.values(state.rooms)) {
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id })
      }
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
    }
    // The agents module owns the DSH Agent session index; it installs after this.
    rt.indexAgents?.()
    restoreCurrent()
  }
  // The Bot a Session speaks for: its own chat, one of its group Sessions, or an
  // earlier segment of either.
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? taskOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id) || taskOwners.has(id)
  const groupSessionsOf = botId => Object.values(state.rooms).map(room => room.sessions?.[botId]).filter(Boolean)
  const dropGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    for (const segment of room.segments?.[botId] ?? []) delete state.switching[segment.sessionId]
    if (room.segments !== undefined) delete room.segments[botId]
    delete state.switching[sessionId]
    groupOwners.delete(sessionId)
    rt.cancelApprovals?.(sessionId)
    // A plain archive refuses a running Session, which would go on working for a group
    // that no longer has it.
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  // A group Session DSH can no longer open is set aside; the member's earlier parts in
  // the group stay, and its next turn there starts a new Session.
  const retireGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    groupOwners.delete(sessionId)
    rt.cancelApprovals?.(sessionId)
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    const byId = own(state.bots, ref)
    if (byId) return byId
    const wanted = normalize(ref).replace(/^@/, '')
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

  Object.assign(rt, {
    state, load, save, refresh, readOnly, teamLoaded, own,
    botOf, roomOf, isMain, chatOf, selfOf, isBotSession,
    chatOwners, groupOwners, pastOwners, taskOwners, indexSessions,
    groupSessionsOf, dropGroupSession, retireGroupSession, findBot, findRooms, isAdminOf,
  })
}
