// Permissions. A Bot's permission level is its own: kept on the Bot and set on every
// Session it speaks from, so a fresh part or a new group Session keeps it. A group may
// set one level for all its members there, in place of each member's own, as it may
// set one working folder. A level is DSH's preset name; DSH's Auto review is one while
// its layer is loaded (../shared/permission-levels.js).
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { HELD_NOT_SET, HELD_UNREAD } from '../shared/held.js'
import { AUTO, AUTO_FALLBACK } from '../shared/permission-levels.js'
import { refusal } from './refusal.js'
import { narrowerLevel, narrowestOffered, rankOf } from './permission-rank.js'

export function install(rt) {
  const { ctx } = rt

  const presets = () => ctx.get?.('permissionPresets')
  const autoOffered = service => service.catalog().options.some(option => option.value === AUTO)

  // The presets DSH offers, or undefined when the profile has none.
  function permissionCatalog() {
    const service = presets()
    if (service === undefined) return undefined
    const { options, defaultPreset } = service.catalog()
    return { options, defaultPreset }
  }

  const newBotPermission = () => {
    const catalog = permissionCatalog()
    return rt.state?.prefs?.permission ?? (catalog?.options.some(option => option.value === 'workspace-write') ? 'workspace-write' : catalog?.defaultPreset)
  }

  const roomOfSession = sessionId => rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)

  // Bots (`bot:<id>`) and groups (`room:<id>`) whose saved Auto last ran as
  // workspace-write. Windows learn of a change, or of a new catalog, through
  // permissionKey in the team view's modelsKey, without a new revision.
  const fellBack = new Set()
  function markFallback(key, on) {
    if (on) fellBack.add(key)
    else fellBack.delete(key)
  }
  // What each offered level allows goes in too (its rank), and what became of each Session
  // whose saved level is no longer offered: a preset that keeps its name and changes what
  // it allows, or a Session lowered meanwhile, reaches the windows as a catalog change does.
  const permissionKey = () => {
    const service = presets()
    const options = service?.catalog().options.map(option => `${option.value}=${rankOf(service, option.value) ?? '?'}`).join(',') ?? ''
    // And what each Bot whose saved level is gone is told to run as (permissionFallbackOf):
    // a level DSH itself changed on its chat reaches the windows too: its rank, whether it
    // is offered, and a digest of its name, never what it allows. The digest is there to
    // tell one name from another, so two levels of the same rank still change the key; it
    // hides nothing, since the view already carries the name (`permissionRuns`).
    const runs = Object.values(rt.state?.bots ?? {}).filter(bot => typeof bot.permission === 'string' && bot.permission !== AUTO && service !== undefined && !offers(bot.permission)).map((bot) => {
      const level = levelRead(rt.chatOf(bot.id))
      return `${bot.id}~${level === undefined ? '-' : `${rankOf(service, level) ?? '?'}${offers(level) ? 'o' : 'x'}${digest(level)}`}`
    })
    return `${options}:${[...fellBack].sort().join(',')}:${[...goneOf].map(([id, outcome]) => `${id}=${outcome}`).sort().join(',')}:${runs.sort().join(',')}:${rt.autoKey?.() ?? ''}`
  }
  const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
  // The level DSH reports for a Session it has loaded, or undefined: nothing is opened.
  function levelRead(sessionId) {
    try {
      const session = (ctx.sessions?.list?.() ?? []).find(loaded => loaded?.id === sessionId)
      const level = session === undefined ? undefined : presets().current(session)
      return typeof level === 'string' && level !== '' ? level : undefined
    } catch {
      return undefined
    }
  }
  // `{ permissionFallback }` for a Bot's or group's view when its Auto runs as workspace-write.
  // `{ permissionNotOffered }` when its saved level is one DSH no longer offers (#1001):
  // the level stays saved, and the view tells it, with the level the Bot's own chat reads
  // now when DSH has that Session loaded (`permissionRuns`). A group's members each keep
  // their own, so a group names none.
  function permissionFallbackOf(kind, owner) {
    if (typeof owner.permission === 'string' && owner.permission !== AUTO) {
      if (presets() === undefined || offers(owner.permission)) return {}
      const runs = kind === 'bot' ? levelRead(rt.chatOf(owner.id)) : undefined
      return { permissionNotOffered: true, ...(runs === undefined ? {} : { permissionRuns: runs }) }
    }
    if (owner.permission !== AUTO) return {}
    const service = presets()
    const fallback = service === undefined || !autoOffered(service) || fellBack.has(`${kind}:${owner.id}`)
    return fallback ? { permissionFallback: AUTO_FALLBACK } : {}
  }

  // Applies run one at a time per Session, in call order; one with nothing before it
  // starts at once, so a listener's first preset lands inside DSH's announce. The chain
  // is in place before the job starts: a resolve inside it that opens the Session queues
  // the session/created re-apply behind it.
  const chains = new Map()
  function serial(sessionId, job) {
    const before = chains.get(sessionId)
    let release
    const tail = new Promise((resolve) => { release = resolve })
    chains.set(sessionId, tail)
    const run = before === undefined ? job() : before.then(job)
    void run.then(release, release)
    void tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId) })
    return run
  }

  // Sets a level on one Session; `session` spares the resolve where the caller holds it.
  // Auto is DSH's own while its layer offers it; when it cannot be set the Session runs as
  // workspace-write, never on what an earlier stop left (DSH moves Auto to full access when
  // its layer closes). Resolves whether the level holds.
  async function applyLevel(sessionId, level, session) {
    const service = presets()
    const target = session ?? (await rt.resolveAgent(sessionId)).session
    if (level === AUTO && autoOffered(service)) {
      try {
        service.set(target, AUTO)
        return true
      } catch (error) {
        rt.warn('ds-bot: Auto for %s not set: %s', sessionId, error)
      }
    }
    service.set(target, level === AUTO ? AUTO_FALLBACK : level)
    return level !== AUTO
  }

  // Sessions whose level was to be set and was not, with that level and when it was last
  // tried: each still runs at whatever it had, which may be wider. No tool runs there
  // until the level holds (levelHolds). Only a set that did not throw lifts a mark. Kept
  // in memory only: a Session DSH opens again takes its level again (session/created), and
  // is marked again when that fails.
  const unapplied = new Map()
  // What a marked Session answers with, for a tool call and for an ACP agent's turn.
  const notSet = level => `The ${level} permission level could not be set on this conversation, so no tool runs here until it is. Tell the user: restarting DeepSeek Harness, or changing the permission level, tries again.`
  const acpAgents = () => { try { return ctx.get?.('acpAgents') } catch { return undefined } }
  // An ACP agent (Claude Code, Codex) runs its own tools under its own mode, which no
  // tools/execute guard reaches: marking a Session ends its agent session at once, a turn
  // under way included, and the gate below keeps the next one from starting.
  // A subagent child works under its parent's level (markedFor), so the open Sessions that
  // resolve to the marked one are ended with it.
  const mark = (sessionId, level) => {
    unapplied.set(sessionId, { level, at: Date.now() })
    const acp = acpAgents()
    if (typeof acp?.endSession !== 'function') return
    const why = HELD_NOT_SET
    try { acp.endSession(sessionId, why) } catch {}
    let open = []
    try { open = ctx.sessions?.list?.() ?? [] } catch {}
    for (const session of open) {
      if (typeof session?.id !== 'string' || session.id === sessionId) continue
      try {
        if (markedFor({ id: session.id, session }) === sessionId) acp.endSession(session.id, why)
      } catch {}
    }
  }
  // Whether DSH offers `level` now. Auto counts: one DSH does not offer runs as its fallback.
  // A catalog that cannot be read counts too: a mark is dropped only when DSH is shown not
  // to offer the level, never because DSH failed to answer.
  function offers(level) {
    try {
      return level === AUTO || presets().catalog().options.some(option => option.value === level)
    } catch {
      return true
    }
  }
  // What became of a Session whose saved level DSH no longer offers, at its last apply
  // (#1001): `narrowed` to the narrowest level offered, `kept` (it already ran no wider),
  // `unknown` (its level could not be compared, so it was left as it was) or `held` (the
  // narrower level could not be set, so no tool runs there). In memory, as the marks are.
  const goneOf = new Map()
  // A saved level DSH no longer offers cannot be set, and is not rewritten: the person
  // chose it. A Session that already runs goes to the narrowest level DSH still offers,
  // and only when that is proven to narrow it: DSH reports a level for the Session that
  // can be ranked, and the narrowest allows less. One that already runs no wider is left
  // as it is. One whose level cannot be read or ranked (a preset DSH no longer resolves)
  // is never set to anything: nothing proves the narrowest offered allows no more than
  // what it has, so it keeps the level it had, as before. Resolves whether the Session
  // was settled here; false leaves the apply to fail as it always did.
  async function applyGone(sessionId, session) {
    const service = presets()
    const target = session ?? (await rt.resolveAgent(sessionId)).session
    const narrowest = narrowestOffered(service)
    let has
    try { has = service.current(target) } catch {}
    const [to, from] = [narrowest === undefined ? undefined : rankOf(service, narrowest), typeof has === 'string' ? rankOf(service, has) : undefined]
    if (to === undefined || from === undefined) {
      // Not comparable now. A Session held for a set that failed stays held: it was wider.
      if (goneOf.get(sessionId) !== 'held') goneOf.set(sessionId, 'unknown')
      return false
    }
    if (to >= from) {
      goneOf.set(sessionId, 'kept')
      return false
    }
    try {
      // Auto as the narrowest is DSH's own while it holds, else workspace-write (applyLevel).
      await applyLevel(sessionId, narrowest, target)
    } catch (error) {
      goneOf.set(sessionId, 'held')
      mark(sessionId, narrowest)
      throw error
    }
    goneOf.set(sessionId, 'narrowed')
    unapplied.delete(sessionId)
    return true
  }
  // One apply of `level` on a Session, inside its serial job. A Session DSH will not open
  // while Auto review is off is not marked: nothing runs there (autoClosed). One whose saved
  // level DSH no longer offers is lowered where that is proven to narrow it (applyGone);
  // otherwise no try could ever set the level, so the Session is left as it always was,
  // warned about. `start`: a Session about to start work is never lowered in its place:
  // its start is refused (startRefusal), as before.
  async function applyMarked(sessionId, level, session, { start = false } = {}) {
    const gone = !offers(level)
    if (!gone) goneOf.delete(sessionId)
    else if (!start && !starting.has(sessionId)) {
      const settled = await applyGone(sessionId, session)
      if (settled) return false
      // Held for a narrower level that could not be set: still held, and still refused.
      if (goneOf.get(sessionId) === 'held' && unapplied.has(sessionId)) throw refusal(notSet(unapplied.get(sessionId).level))
    }
    try {
      const held = await applyLevel(sessionId, level, session)
      unapplied.delete(sessionId)
      return held
    } catch (error) {
      if (error?.autoClosed !== true && offers(level)) mark(sessionId, level)
      // A Session held because the narrower level could not be set stays held: a start
      // refused on it (a greeting tried again) must not let its tools go.
      else if (error?.autoClosed !== true && goneOf.get(sessionId) !== 'held') unapplied.delete(sessionId)
      throw error
    }
  }
  // Sessions about to take their first turn (startTask): the re-apply DSH's announce asks
  // for must not lower one in place of the refusal its start gets.
  const starting = new Set()
  function startingSession(sessionId) {
    starting.add(sessionId)
    return () => starting.delete(sessionId)
  }
  // Before a Session is made for work that starts by itself: a saved level DSH no longer
  // offers refuses it there, so no Session is opened for it.
  function assertLevelOffered(name) {
    if (presets() === undefined || !name || offers(name)) return
    throw startRefusal(name)
  }

  // Sets the level on one of the Bot's Sessions: its group's there, else its own; a Bot
  // without one keeps DSH's default. `room` is for a group Session not indexed yet. The
  // level is read when the apply runs, not when it is queued. `start`: the Session is
  // about to start work, so a level that does not hold refuses it (startPermission).
  async function applyPermission(bot, sessionId, room = roomOfSession(sessionId), session, { start = false, starts = false } = {}) {
    if (start) return startPermission(bot, sessionId, room, session)
    if (presets() === undefined) return
    return serial(sessionId, async () => {
      const name = room?.permission ?? bot.permission
      if (!name) return
      const held = await applyMarked(sessionId, name, session, { start: starts })
      markFallback(room?.permission ? `room:${room.id}` : `bot:${bot.id}`, !held)
    })
  }

  // A task a Bot started (state.tasks, `from`) runs at that Bot's level, as the Bot's own
  // chat does; a task asked for in a group (`roomId`) at the group's level when it has one,
  // as the Bot's Session there does. A Bot without a level gives its task the catalog
  // default, set explicitly so a restart or a catalog change cannot leave it elsewhere. A
  // task no Bot asked for keeps DSH's default. When its Bot or its group is deleted, the
  // task keeps the level it ran at as a cap (`permissionCap`, capTasks): what governs it
  // afterwards (the default, the Bot's own level) can lower it, never raise it.
  // Work opened by a tool call also keeps its opener's current Session level as a cap,
  // but only when it narrows the level above. An uncapped task still follows later changes
  // of its Bot's level; a capped one can only run at or below that cap.
  // A task started from a group Session's tool call without a `roomId` (another plugin's
  // tool that forgot the group) remembers that group as `levelRoomId`: its level is the
  // narrower of the one above and that group's, read live, so a Bot with a wide level does
  // not carry it into work asked for in a narrower group. It only ever narrows: a wider
  // group gives the task nothing, and where the report goes (`roomId`) is not changed.
  // A task started from inside another task's tool call (`levelTaskId`, #1030) also never
  // runs wider than that task is set to run at, read live and up the whole chain, whatever
  // its own Bot, group or `roomId` say: the second hop does not leave the first one's level.
  // A task no Bot asked for has no level of its own and keeps what its Session has, as
  // without a parent: the parent can only lower that, when DSH reports a level there that
  // is known to allow more; one that allows no more is left untouched, and one DSH reports
  // no level for that can be ranked is not set either but held, as below. Where the two
  // levels cannot be compared (one of them cannot be ranked, and they are not the same
  // one), nothing proves the task allows no more than its parent: it is `unproven`, and
  // no tool runs there (applyTaskPermission). A parent no longer known gives the narrowest
  // level the catalog offers. A parent at Auto binds as workspace-write, whether its Auto
  // holds or not: narrower than needed while it holds, and never above a parent whose Auto
  // fell back. Only a start made while the task's tool call runs is bound (callerTask).
  const taskOf = sessionId => rt.state?.tasks?.[sessionId]
  const taskLevel = (task, service) => taskRun(task, service).level
  function taskRun(task, service, depth = 0) {
    const linked = task.levelTaskId !== undefined
    if (task.from === undefined) {
      if (!linked) return {}
      const has = readLevel(Object.keys(rt.state?.tasks ?? {}).find(id => rt.state.tasks[id] === task))
      if (has === undefined || runRank(service, has) === undefined) return { unproven: true }
      const bounded = boundedByParent(task, has, service, depth)
      return bounded.unproven !== true && bounded.level === has ? {} : bounded
    }
    const bot = task.from === undefined ? undefined : rt.botOf(task.from)
    const room = task.roomId ? rt.roomOf(task.roomId) : undefined
    const base = bot === undefined ? service.catalog().defaultPreset : room?.permission ?? bot.permission ?? service.catalog().defaultPreset
    const level = base === undefined ? base : narrowedByCaller(task, task.permissionCap === undefined ? base : narrowerLevel(service, base, task.permissionCap), service)
    if (!linked) return { level }
    if (level === undefined) return { unproven: true }
    return boundedByParent(task, level, service, depth)
  }
  // A level ranked as what it runs as: a saved Auto DSH does not offer runs as workspace-write.
  const runRank = (service, name) => rankOf(service, name === AUTO && !autoOffered(service) ? AUTO_FALLBACK : name)
  const PARENT_DEPTH = 32
  // What bounds the children of a task with no level of its own (no Bot asked for it, or
  // none could be ranked): the level DSH reports for its Session while that one is loaded.
  // Never the catalog default, which may have changed since the Session took it.
  function readLevel(sessionId) {
    try {
      const session = (ctx.sessions?.list?.() ?? []).find(loaded => loaded?.id === sessionId)
      return session === undefined ? undefined : presets().current(session)
    } catch {
      return undefined
    }
  }
  function boundedByParent(task, level, service, depth) {
    const parent = taskOf(task.levelTaskId)
    let bound
    if (parent !== undefined && depth < PARENT_DEPTH) {
      const run = taskRun(parent, service, depth + 1)
      if (run.unproven === true) return { level, unproven: true }
      bound = run.level ?? readLevel(task.levelTaskId)
      // What its Session reads is taken only when it can be ranked.
      if (run.level === undefined && bound !== undefined && runRank(service, bound) === undefined) bound = undefined
      if (bound === AUTO) bound = AUTO_FALLBACK
    }
    const own = runRank(service, level)
    if (bound === undefined) {
      // The parent is gone, the chain is longer than any real one, or its level is unknown.
      const narrowest = narrowestOffered(service)
      if (own === undefined || narrowest === undefined) return { level, unproven: true }
      return { level: runRank(service, narrowest) < own ? narrowest : level }
    }
    // The same level by name allows the same, ranked or not.
    if (bound === level) return { level }
    if (own === undefined || runRank(service, bound) === undefined) return { level, unproven: true }
    return { level: narrowedTo(level, bound, service) }
  }
  // `level`, or the group's when that one is known to allow less: both are ranked as what
  // they run as (a saved Auto DSH does not offer runs as workspace-write). A level of the
  // task that cannot be ranked stays, as without the group; a group's that cannot gives
  // the narrowest level the catalog offers, and only when that one allows less.
  function narrowedByCaller(task, level, service) {
    const asked = task.levelRoomId ? rt.roomOf(task.levelRoomId)?.permission : undefined
    if (level === undefined || !asked || asked === level) return level
    return narrowedTo(level, asked, service)
  }
  // `level`, or `asked` when that one is known to allow less (narrowedByCaller's rules).
  function narrowedTo(level, asked, service) {
    const rank = name => runRank(service, name)
    const was = rank(level)
    if (was === undefined) return level
    // A group's Auto DSH does not offer goes by the name it runs as: were the task given
    // `auto`, a layer loading before the level is set would run it as Auto, which is wider.
    const named = asked === AUTO && !autoOffered(service) ? AUTO_FALLBACK : asked
    const narrower = rank(named) === undefined ? narrowestOffered(service) : named
    const now = narrower === undefined ? undefined : rank(narrower)
    if (now === undefined || now >= was) return level
    // An Auto DSH offers may still fail to set, and then runs as workspace-write
    // (applyLevel): a level wider than that one would be wider than without the group.
    if (level === AUTO && autoOffered(service)) {
      const floor = rankOf(service, AUTO_FALLBACK)
      if (floor === undefined) return level
      if (now > floor) return AUTO_FALLBACK
    }
    return narrower
  }
  // Whether a task takes its level from this group: asked for there, or started from it.
  const taskOfRoom = (task, roomId) => task.roomId === roomId || task.levelRoomId === roomId

  // The Session whose tool call is running, for a startTask made inside it: the team's
  // tools/execute guard (tool-deny.js) runs the rest of the call through here. The store
  // outlives the call in the timers and promise chains the call started, so it is only
  // read while `active`, which ends with the call.
  const callers = new AsyncLocalStorage()
  function inToolCall(exec, next) {
    const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
    if (typeof sessionId !== 'string') return next()
    const call = { sessionId, session: exec.agent?.session, header: exec.agent?.session?.header, active: true }
    const owner = ownerOfSession(call)
    call.roomId = owner?.roomId
    call.taskId = owner?.taskId
    return callers.run(call, async () => {
      try {
        return await next()
      } finally {
        call.active = false
      }
    })
  }
  // The group a Session speaks in (`roomId`), or the task it is (`taskId`). A subagent child
  // is in none of the team's maps: it follows its parents, as the tool deny list does, up
  // to the first Session the team knows, and has that one's group, that task, or neither.
  const groupOfSession = call => ownerOfSession(call)?.roomId
  function ownerOfSession({ sessionId, header }) {
    let current = sessionId
    for (let depth = 0; typeof current === 'string' && depth < 32; depth += 1) {
      const group = rt.groupOwners.get(current)
      if (group !== undefined) return { roomId: group.roomId }
      if (rt.selfOf?.(current) !== undefined) return undefined
      if (taskOf(current) !== undefined) return { taskId: current }
      let from = header
      header = undefined
      try {
        from ??= ctx.sessions?.get?.(current)?.header
      } catch {
        return undefined
      }
      if (from?.origin !== 'subagent') return undefined
      current = from.parentSession
    }
    return undefined
  }
  // The group of the Session whose tool call this runs in, or undefined: outside a tool
  // call, after it returned, or from a Session that is not a group's. Read at the call's
  // start, and again here for a call that began before the team was loaded.
  function callerGroup() {
    const call = callers.getStore()
    if (call?.active !== true) return undefined
    return call.roomId ?? groupOfSession(call)
  }
  // The task Session whose tool call this runs in, or undefined: as the group, only while
  // the call runs. What the call left running (a timer, a queue another start drains) is
  // not the task's: a store that outlives its call would bind starts that are not its own.
  rt.callerSessionId = () => {
    const call = callers.getStore()
    return call?.active === true ? call.sessionId : undefined
  }
  rt.levelHeld = sessionId => unapplied.has(sessionId)

  function callerTask() {
    const call = callers.getStore()
    if (call?.active !== true) return undefined
    return call.taskId ?? ownerOfSession(call)?.taskId
  }
  // What the calling Session runs at now. An unreadable opener is still an opener:
  // it gives the narrowest offered level, never the wider saved level of its owner.
  function callerLevel() {
    const call = callers.getStore()
    const service = presets()
    if (call?.active !== true || service === undefined) return undefined
    try {
      const session = call.session ?? (ctx.sessions?.list?.() ?? []).find(loaded => loaded?.id === call.sessionId)
      if (session === undefined) return narrowestOffered(service)
      const level = service.current(session)
      return typeof level === 'string' && level !== '' ? level : undefined
    } catch {
      return narrowestOffered(service)
    }
  }
  // Save only a narrowing: an opener at the same or a wider level adds no lasting cap.
  function capTaskByOpener(task, opener) {
    const service = presets()
    if (service === undefined || !opener || task.from === undefined) return
    const run = taskRun(task, service)
    if (run.unproven === true || run.level === undefined) return
    const capped = narrowedTo(run.level, opener, service)
    if (capped !== run.level) task.permissionCap = capped
  }
  // A schedule's arming Session and each loaded parent, plus the team owner's level.
  // The last id owns the lineage even when the child or an earlier part is unloaded.
  function armedLevels(ids, bot) {
    const service = presets()
    if (service === undefined) return []
    const last = ids.at(-1)
    const task = taskOf(last)
    const roomId = (rt.groupOwners.get(last) ?? rt.pastOwners.get(last))?.roomId
    const owner = task === undefined ? rt.roomOf(roomId)?.permission ?? bot?.permission : taskLevel(task, service)
    return [...ids.map(levelRead), owner].filter(level => typeof level === 'string' && level !== '')
  }
  // Read and lower in the same queue as every other apply: an earlier lowering must
  // land before this comparison, so no stale read can raise the Session back up.
  async function lowerScheduledSession(session, levels) {
    const service = presets()
    if (service === undefined || levels.length === 0) return
    await serial(session.id, async () => {
      const has = service.current(session)
      if (typeof has !== 'string' || runRank(service, has) === undefined) throw new Error('The scheduled Session has no comparable permission level')
      let level = has
      for (const bound of levels) level = narrowedTo(level, bound, service)
      if (level !== has) await applyLevel(session.id, level, session)
    })
  }
  // How many tasks deep a task started from `sessionId` would be; a loop counts as too deep.
  function taskDepth(sessionId) {
    let depth = 0
    for (let task = taskOf(sessionId); task !== undefined && depth <= PARENT_DEPTH; depth += 1) task = task.levelTaskId === undefined ? undefined : taskOf(task.levelTaskId)
    return depth
  }
  const TOO_DEEP = `A task started from a task can be ${PARENT_DEPTH} tasks deep at most, so nothing was started.`
  function assertTaskDepth(sessionId) {
    if (taskDepth(sessionId) >= PARENT_DEPTH) throw refusal(TOO_DEEP)
  }
  // The ended tasks a working task descends from: kept while it works (startTask).
  function taskForebears() {
    const held = new Set()
    for (let task of Object.values(rt.state?.tasks ?? {})) {
      if (task.status !== 'working') continue
      for (let depth = 0; task?.levelTaskId !== undefined && depth <= PARENT_DEPTH; depth += 1) {
        held.add(task.levelTaskId)
        task = taskOf(task.levelTaskId)
      }
    }
    return held
  }
  // Before a Bot or a group leaves the state: each task `match` picks keeps the level it
  // runs at now as its cap. Saved with the deletion.
  function capTasks(match) {
    const service = presets()
    if (service === undefined) return
    for (const task of Object.values(rt.state?.tasks ?? {})) {
      if (!match(task)) continue
      const level = taskLevel(task, service)
      if (level !== undefined) task.permissionCap = level
    }
  }
  // The level a remembered task runs at, read before startTask forgets it.
  const taskLevelOf = (sessionId) => {
    const task = taskOf(sessionId)
    const service = presets()
    return task === undefined || service === undefined ? undefined : taskLevel(task, service)
  }
  // Sets a task Session's level, read when the apply runs, not when it is queued, so a
  // lower level picked meanwhile lands last. The fallback mark stays the Bot's and the
  // group's own: a task does not mark them. Resolves whether the Session is a task.
  async function applyTaskPermission(sessionId, session, { start = false, starts = false } = {}) {
    if (start) return startTaskPermission(sessionId, session)
    if (taskOf(sessionId) === undefined) return false
    const service = presets()
    if (rt.readOnly() !== undefined || service === undefined) return true
    await serial(sessionId, async () => {
      const task = taskOf(sessionId)
      const { level, unproven } = task === undefined ? { level: service.catalog().defaultPreset } : taskRun(task, service)
      if (unproven === true) {
        // Marked, so no tool and no agent turn runs there until the two can be compared.
        mark(sessionId, level ?? narrowestOffered(service) ?? AUTO_FALLBACK)
        throw refusal(UNPROVEN)
      }
      if (level) await applyMarked(sessionId, level, session, { start: starts })
      // Compared with its parent and found no wider: nothing to set, and nothing holds it.
      else if (task?.from === undefined && task?.levelTaskId !== undefined) unapplied.delete(sessionId)
      // No level could be ranked: the task keeps its own, not a default that may be wider.
      else if (task?.from !== undefined) rt.warn('ds-bot: no permission level for the task %s can be ranked; it keeps its own', sessionId)
    })
    return true
  }
  const UNPROVEN = 'The permission level of this task cannot be compared with the level of the task that started it, so nothing runs here.'
  // Where work starts by itself (a task's first turn, a new Bot's greeting, a member's
  // first turn in a group) nothing runs on a Session whose level did not hold: the start
  // is refused, never left on DSH's default, which may be wider than the level chosen. A
  // saved level that left the catalog is refused too, with what to do about it: no level
  // still offered is known to allow no more than it did. Auto's own fallback is
  // applyLevel's, as before.
  const NOT_SET = 'The permission level could not be set, so nothing was started. Try again.'
  const NOT_OFFERED = 'The saved permission level is no longer offered, so nothing was started. Pick a permission level again.'
  function startRefusal(name, error) {
    const service = presets()
    let offered = name === AUTO
    try {
      if (!offered) offered = service?.resolve(name) !== undefined
    } catch {}
    // `levelNotSet`: for a caller that words this refusal its own way (a group's failed line).
    return Object.assign(refusal(offered ? NOT_SET : NOT_OFFERED, { cause: error }), { levelNotSet: true })
  }
  // applyPermission with `start`, for a Session about to start work: rejects with a
  // refusal when its level does not hold.
  async function startPermission(bot, sessionId, room, session) {
    try {
      await applyPermission(bot, sessionId, room, session, { starts: true })
    } catch (error) {
      rt.warn('ds-bot: permission for %s not applied on %s: %s', bot.name, sessionId, error)
      throw startRefusal(room?.permission ?? bot.permission, error)
    }
  }
  // applyTaskPermission with `start`, for a task about to take its first turn, the same way.
  async function startTaskPermission(sessionId, session) {
    try {
      return await applyTaskPermission(sessionId, session, { starts: true })
    } catch (error) {
      rt.warn('ds-bot: permission for the task %s not applied: %s', sessionId, error)
      const task = taskOf(sessionId)
      const service = presets()
      throw startRefusal(task === undefined || service === undefined ? undefined : taskLevel(task, service), error)
    }
  }
  // The tasks `match` picks take their level again now, after a level changes or their Bot
  // goes: a loaded one, and a working one even if DSH has to open it. Any other takes it
  // from the session/created re-apply when DSH opens it next. Resolves the tasks whose
  // level was not set, apart from those that take it on opening, for the change that asked.
  async function reapplyTasks(match) {
    const left = []
    // And every task started from one of them, down the chain: it is bound by that one.
    const follows = (task) => {
      for (let depth = 0; task !== undefined && depth <= PARENT_DEPTH; depth += 1) {
        if (match(task)) return true
        task = task.levelTaskId === undefined ? undefined : taskOf(task.levelTaskId)
      }
      return false
    }
    const picked = Object.entries(rt.state?.tasks ?? {}).filter(([, task]) => follows(task))
    if (picked.length === 0 || rt.readOnly() !== undefined || presets() === undefined) return left
    const loaded = new Map((ctx.sessions?.list?.() ?? []).map(session => [session.id, session]))
    for (const [sessionId, task] of picked) {
      if (!loaded.has(sessionId) && task.status !== 'working') continue
      await applyTaskPermission(sessionId, loaded.get(sessionId))
        .catch((error) => {
          rt.warn('ds-bot: permission for the task %s not applied: %s', sessionId, error)
          if (keptLevel(error)) left.push(sessionId)
        })
    }
    return left
  }
  // A change of level that some Sessions did not take is saved all the same, never taken
  // back to the wider one, and whoever asked is told: the Sessions named kept the level
  // they had, and take the saved one when DSH opens them again (session/created), which
  // for a loaded Session may be its next start. A Session DSH will not open while Auto
  // review is off is not one of them: it takes the level when it opens (autoClosed).
  const NOT_EVERYWHERE = 'The permission level was saved, but some conversations could not take it and keep the level they had until DeepSeek Harness opens them again.'
  const keptLevel = error => error?.autoClosed !== true
  function notEverywhere(what, left) {
    rt.warn('ds-bot: the permission level of %s was not applied on %s', what, left.join(', '))
    return Object.assign(refusal(NOT_EVERYWHERE), { levelNotApplied: true, sessions: left })
  }
  // A task startTask no longer remembers (past TASKS_KEPT) goes now to the narrower of the
  // catalog default and `ranAt`, the level it ran at (taskLevelOf before the forget): when
  // DSH opens it again nothing tells it was a task, so it must not keep a level its Bot has
  // lowered since, and forgetting it must not raise it either. An unloaded one is opened
  // in DSH for this: one old Session per startTask past TASKS_KEPT, before the new task's
  // first turn.
  async function forgetTaskPermission(sessionId, ranAt) {
    const service = presets()
    if (rt.readOnly() !== undefined || service === undefined) return
    const fallback = service.catalog().defaultPreset
    const level = ranAt === undefined ? fallback : fallback === undefined ? ranAt : narrowerLevel(service, fallback, ranAt)
    if (!level) {
      rt.warn('ds-bot: no permission level for the forgotten task %s can be ranked; it keeps its own', sessionId)
      return
    }
    const loaded = (ctx.sessions?.list?.() ?? []).find(session => session.id === sessionId)
    await serial(sessionId, () => applyMarked(sessionId, level, loaded))
  }

  // A Session of a Bot's own chat, of a group or of a task, as DSH opens it or as the
  // presets change.
  async function reapply(session) {
    if (rt.readOnly() !== undefined) return
    // Not awaited first: the first preset must still land within DSH's announce.
    if (taskOf(session.id) !== undefined) return applyTaskPermission(session.id, session)
    const group = rt.groupOwners.get(session.id)
    const bot = rt.botOf(group?.botId ?? rt.chatOwners.get(session.id))
    if (bot === undefined) return
    await applyPermission(bot, session.id, group && rt.roomOf(group.roomId), session)
  }
  const warnNotApplied = sessionId => error => rt.warn('ds-bot: permission for %s not applied: %s', sessionId, error)

  // The Session of a tool call, or the nearest parent of a subagent child, that is marked.
  // A child is in none of the team's maps and works under its parent's level. Only asked
  // while a Session is marked (levelHolds): a Session DSH cannot read then may be a marked
  // one's child, so its call is refused, never let through.
  const UNREAD = 'DeepSeek Harness could not read where this conversation comes from while a permission level is not set, so no tool runs here until it can. Try again; if this goes on, tell the user to restart DeepSeek Harness.'
  function markedFor(agent) {
    let current = agent?.id ?? agent?.session?.id
    let header = agent?.session?.header
    for (let depth = 0; typeof current === 'string' && depth < 32; depth += 1) {
      if (unapplied.has(current)) return current
      try {
        header ??= ctx.sessions?.get?.(current)?.header
      } catch (error) {
        rt.warn('ds-bot: the Session %s could not be read while a permission level is not set: %s', current, error)
        throw Object.assign(refusal(UNREAD, { cause: error }), { held: HELD_UNREAD })
      }
      if (header?.origin !== 'subagent') return undefined
      current = header.parentSession
      header = undefined
    }
    return undefined
  }
  // Whether the Session reads the level it should run at: a saved Auto DSH does not offer
  // runs as workspace-write. False when DSH cannot tell.
  function reads(session, level) {
    const service = presets()
    if (service === undefined || session === undefined) return false
    try {
      return service.current(session) === (level === AUTO && !autoOffered(service) ? AUTO_FALLBACK : level)
    } catch {
      return false
    }
  }
  // The level a marked Session should run at, as its owner has it now: a task's, a
  // group's, a Bot's. No `level` when the owner has none of its own, or is gone.
  function wantedBy(sessionId) {
    const service = presets()
    if (service === undefined) return {}
    const task = taskOf(sessionId)
    if (task !== undefined) return { ...taskRun(task, service), task }
    const group = rt.groupOwners.get(sessionId)
    const bot = rt.botOf(group?.botId ?? rt.chatOwners.get(sessionId))
    if (bot === undefined) return {}
    const room = group && rt.roomOf(group.roomId)
    return { level: room?.permission ?? bot.permission, bot, room }
  }
  // The apply again: the owner's level now, through the same apply as any other time.
  // Where the owner has no level now (a level cleared or taken back since, a Bot gone),
  // the level that was to be set is tried only when it is proven to allow less than what
  // the Session reads: a raise that was taken back is never set, and such a Session, no
  // wider than it was to be, is let go. One that cannot be compared stays marked.
  async function retry(sessionId, session) {
    const { level, bot, room, task, unproven } = wantedBy(sessionId)
    // A task no Bot asked for that hangs from a task has no level to set: the same apply
    // compares it with its parent, and lifts the mark when it is no wider.
    const bound = task !== undefined && task.from === undefined && task.levelTaskId !== undefined
    if (task !== undefined && (level || unproven === true || bound)) return applyTaskPermission(sessionId, session)
    if (bot !== undefined && level) return applyPermission(bot, sessionId, room, session)
    const service = presets()
    const mark = unapplied.get(sessionId)
    const target = session ?? (ctx.sessions?.list?.() ?? []).find(loaded => loaded.id === sessionId)
    if (service === undefined || mark === undefined || target === undefined) return
    const [to, from] = [rankOf(service, mark.level === AUTO && !autoOffered(service) ? AUTO_FALLBACK : mark.level), rankOf(service, service.current(target))]
    if (to === undefined || from === undefined) return
    if (to >= from) unapplied.delete(sessionId)
    else return serial(sessionId, () => applyMarked(sessionId, mark.level, target))
  }
  // A failing set still writes to the Session's log, so a marked Session is not tried
  // again at every call.
  const LEVEL_RETRY_MS = 30_000
  // Before a tool runs (the team's tools/execute guard, tool-deny.js): on a Session whose
  // level was not set, the apply is tried again, and the call is refused while it does not
  // hold. It only ever refuses: a Session that is not marked is not looked at.
  async function levelHolds(exec) {
    if (unapplied.size === 0) return
    // No presets service any more: no level is set anywhere, so none is missed.
    if (presets() === undefined) return unapplied.clear()
    const sessionId = markedFor(exec?.agent)
    if (sessionId === undefined) return
    const own = sessionId === (exec.agent?.id ?? exec.agent?.session?.id) ? exec.agent?.session : undefined
    await rt.load()
    const mark = unapplied.get(sessionId)
    if (mark === undefined) return
    // It reads the level it should run at: nothing there is wider than chosen. Not for a
    // task that cannot be compared with its parent: the level it reads proves nothing.
    const wanted = wantedBy(sessionId)
    // A task with no level of its own, compared with its parent just now and found no
    // wider: nothing is to be set there, so nothing holds it.
    if (wanted.task !== undefined && wanted.task.from === undefined && wanted.task.levelTaskId !== undefined && wanted.unproven !== true && !wanted.level) {
      unapplied.delete(sessionId)
      return
    }
    if (wanted.unproven !== true && reads(own, wanted.level ?? mark.level)) {
      unapplied.delete(sessionId)
      return
    }
    if (rt.readOnly() === undefined && Date.now() - mark.at >= (rt.levelRetryMs ?? LEVEL_RETRY_MS)) {
      // Calls that arrive together share this try: the next ones find it just made.
      mark.at = Date.now()
      await retry(sessionId, own).catch(warnNotApplied(sessionId))
    }
    const left = unapplied.get(sessionId)
    if (left === undefined) return
    throw Object.assign(refusal(notSet(left.level)), { held: HELD_NOT_SET })
  }
  // The same rule for an ACP agent's turn (acp-dsh's `holdTurns`, when that plugin is here):
  // no turn starts and no step goes on in a marked Session. It answers the refusal's own
  // sentence; any other failure is thrown, which acp-dsh also takes as a refusal.
  const holdAgents = (sub) => {
    const off = sub.acpAgents?.holdTurns?.(async ({ agent } = {}) => {
      try {
        await levelHolds({ agent })
      } catch (error) {
        if (error?.code === 'bot/refused') {
          rt.noteStop?.(agent?.id ?? agent?.session?.id, { why: 'level' }, agent)
          return typeof error.held === 'string' ? error.held : error.message
        }
        throw error
      }
      return undefined
    })
    if (typeof off === 'function') sub.effect(() => off, 'ds-bot: level gate on agents')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['acpAgents'], holdAgents)
  else if (acpAgents() !== undefined) holdAgents({ acpAgents: acpAgents(), effect: (execute, label) => ctx.effect(execute, label) })

  // A Session DSH opens, after a restart too, gets its level. Once the team is loaded the
  // first preset is set within DSH's announce, before the Session is published; the
  // rest is async, and DSH only logs a rejection.
  ctx.on('session/created', (session) => {
    if (presets() === undefined) return undefined
    const run = () => reapply(session).catch(warnNotApplied(session.id))
    return rt.chatOwners.has(session.id) || rt.groupOwners.has(session.id) || taskOf(session.id) !== undefined ? run() : rt.load().then(run)
  })
  // Auto review's layer loaded or unloaded: the loaded Sessions get their level again, all
  // in one tick, so one DSH moved off Auto runs as workspace-write, not full access. An
  // idle Session is left closed.
  ctx.on('permission-presets/catalog-changed', async () => {
    if (presets() === undefined) return
    await rt.load()
    await Promise.all(ctx.sessions.list().map(session => reapply(session).catch(warnNotApplied(session.id))))
  })

  // DSH will not reopen a Session whose log holds Auto while Auto review's layer is off
  // (its pinInitialPermission throws), and its resolve says so only in the message. The
  // error a Bot's own resolve gives instead tells the user what to do.
  function autoClosed(sessionId, error) {
    if (!/cannot restore preset "auto"/.test(String(error?.message ?? ''))) return undefined
    const group = rt.groupOwners.get(sessionId)
    const room = group && rt.roomOf(group.roomId)
    const botId = group?.botId ?? rt.chatOwners.get(sessionId)
    if (room?.permission) markFallback(`room:${room.id}`, true)
    else if (botId !== undefined) markFallback(`bot:${botId}`, true)
    return Object.assign(new Error('Turn Auto review back on in Plugins to open this chat.', { cause: error }), { code: error.code, autoClosed: true })
  }

  function checkPreset(name) {
    const service = presets()
    if (service === undefined) throw refusal('Permissions are not available in this DeepSeek Harness')
    const wanted = String(name ?? '').trim()
    service.resolve(wanted)
    return wanted
  }

  // The level is kept before the apply: the resolve may open the Session, and the
  // session/created re-apply must find the new one. A chat DSH will not open while Auto
  // review is off keeps the new level and takes it when it opens again. A level the chat
  // refuses is not kept, unless it allows less than the one before: taking a lowering
  // back would save the wider level again, so it stays and the chat is reported.
  async function setPermission(bot, name) {
    const wanted = checkPreset(name)
    await rt.clearAuto?.(bot)
    return levelTo(bot, wanted)
  }

  async function levelTo(bot, wanted, { before = bot.permission } = {}) {
    // Read before the apply: whether the Bot's saved Auto last ran as workspace-write.
    const fell = fellBack.has(`bot:${bot.id}`)
    bot.permission = wanted
    const left = []
    try {
      await applyPermission(bot, rt.chatOf(bot.id))
    } catch (error) {
      if (error?.autoClosed !== true) {
        // Whether `wanted` is proven to allow less than what the chat ran at: a saved Auto
        // that DSH does not offer, or that fell back, ran as workspace-write. Anything that
        // cannot be ranked (the service gone meanwhile too) is not a lowering.
        let lowering = false
        try {
          const service = presets()
          const ran = before === AUTO && (fell || !autoOffered(service)) ? AUTO_FALLBACK : before ?? service.catalog().defaultPreset
          const [now, was] = [rankOf(service, wanted), rankOf(service, ran)]
          lowering = now !== undefined && was !== undefined && now < was
        } catch {}
        if (!lowering) {
          if (before === undefined) delete bot.permission
          else bot.permission = before
          throw error
        }
        rt.warn('ds-bot: permission for %s not applied: %s', bot.name, error)
        left.push(rt.chatOf(bot.id))
      }
    }
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      if (roomOfSession(sessionId)?.permission) continue
      await applyPermission(bot, sessionId)
        .catch((error) => {
          rt.warn('ds-bot: permission for %s in a group not applied: %s', bot.name, error)
          if (keptLevel(error)) left.push(sessionId)
        })
    }
    // Its tasks too, but one asked for in a group with a level of its own keeps that one.
    left.push(...await reapplyTasks(task => task.from === bot.id && !(task.roomId && rt.roomOf(task.roomId)?.permission)))
    if (left.length > 0) throw notEverywhere(bot.name, left)
  }

  // A new Bot takes its creator's level, narrowed by the opening Session and group.
  // Without a saved level, its loaded chat can only narrow the catalog default. A level
  // DSH cannot rank gives the narrowest offered (#315); when none ranks, creation fails.
  // Without presets nothing is inherited, as before.
  function inheritedPermission(creator, { level, roomId } = {}) {
    const service = presets()
    if (service === undefined) return undefined
    let own = creator.permission
    if (own === undefined) {
      own = service.catalog().defaultPreset
      const chat = levelRead(rt.chatOf(creator.id))
      if (chat !== undefined) own = narrowedTo(own, chat, service)
    }
    let result = narrowerLevel(service, own, own)
    for (const bound of [level, rt.roomOf(roomId)?.permission]) {
      if (result !== undefined && bound) result = narrowedTo(result, bound, service)
    }
    if (result === undefined) throw refusal(`no permission level of ${creator.name} can be given to a new Bot`)
    return result
  }

  // A group's level, or null when each member uses its own.
  const cleanRoomPermission = name => (name === null || name === '' ? null : checkPreset(name))

  // Members' Sessions in the group change now; a member that has none there yet gets the
  // group's level when its first turn there makes one. Returns whether it changed.
  async function setRoomPermission(room, name) {
    const wanted = cleanRoomPermission(name) ?? undefined
    if (wanted === room.permission) return false
    if (wanted === undefined) delete room.permission
    else room.permission = wanted
    markFallback(`room:${room.id}`, false)
    const service = presets()
    if (service === undefined) return true
    const left = []
    for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      // A member without a level of its own goes back to the default its Session started on.
      await applyPermission({ ...bot, permission: bot.permission ?? service.catalog().defaultPreset }, sessionId, room)
        .catch((error) => {
          rt.warn('ds-bot: permission for %s in %s not applied: %s', bot.name, room.name, error)
          if (keptLevel(error)) left.push(sessionId)
        })
    }
    // The tasks asked for in the group: its level, or now their Bot's own.
    left.push(...await reapplyTasks(task => taskOfRoom(task, room.id)))
    if (left.length > 0) throw notEverywhere(room.name, left)
    return true
  }

  // What the diagnostics page shows of one Session (permission-diagnostics.js). It only
  // reads: the owner's saved level, the preset DSH reports for `session` when the caller
  // holds one (nothing is opened to read it), and a copy of the mark above. It sets, applies
  // and retries nothing, lifts no mark, and loads nothing. A level that cannot be read
  // is left out; any other failure is told as `failed`. Without the presets service the saved level of a Bot or a group is still
  // told (`presets: false`); a task's needs the catalog, so it is left out.
  function permissionFactsOf(sessionId, session) {
    const out = { kind: 'other', source: 'none', auto: rt.autoFactsOf?.(sessionId, session) }
    try {
      const service = presets()
      if (service === undefined) out.presets = false
      const task = taskOf(sessionId)
      const group = rt.groupOwners.get(sessionId)
      const chat = rt.chatOwners.get(sessionId)
      if (task !== undefined) {
        out.kind = 'task'
        out.source = 'task'
        out.botId = rt.botOf(task.from)?.id
        out.roomId = task.roomId ? rt.roomOf(task.roomId)?.id : undefined
        if (service !== undefined) {
          try { out.saved = taskLevel(task, service) } catch {}
        }
      } else if (group !== undefined || chat !== undefined) {
        const bot = rt.botOf(group?.botId ?? chat)
        const room = group && rt.roomOf(group.roomId)
        out.kind = group === undefined ? 'chat' : 'group'
        out.botId = bot?.id
        out.roomId = room?.id
        out.saved = room?.permission ?? bot?.permission
        out.source = room?.permission ? 'group' : bot?.permission ? 'bot' : 'none'
      }
      // The saved level is one DSH no longer offers: what became of this Session (applyGone),
      // or `unknown` while no apply has said.
      if (service !== undefined && typeof out.saved === 'string' && !offers(out.saved)) out.gone = goneOf.get(sessionId) ?? 'unknown'
      if (service !== undefined && session !== undefined) {
        try { out.effective = service.current(session) } catch {}
      }
      const mark = unapplied.get(sessionId)
      if (mark !== undefined) out.unapplied = { level: mark.level, at: mark.at }
    } catch {
      // Told, so that a read that failed is not taken for a Session with nothing to say.
      out.failed = true
    }
    return out
  }
  // Whether a level is Full access by what it allows (no sandbox, no question), whatever its
  // name. A level DSH cannot resolve is not known to be: false.
  function wideLevel(service, name) {
    try {
      const spec = service.resolve(name)
      return spec?.sandbox === 'danger-full-access' && spec?.approval === 'never'
    } catch {
      return false
    }
  }
  // Whether a Session runs at Full access: the level DSH reports for `session` when the caller
  // holds it, else the one its owner has saved (a task's, a group's, a Bot's, else the catalog
  // default it started on). Without the presets service no level is set anywhere: false. It
  // only reads, for the rule that a Bot at Full access on a coding CLI is never moved to
  // another model on its own (fallback.js, models.js).
  // `owner` ({ bot, room }): whose Session it is, for one made a moment ago that is not the
  // Bot's yet (a fresh part, parts.js). It has no owner on record, so without this it would
  // be read at the catalog default, which is not the level it was given.
  function sessionWide(sessionId, session, owner) {
    const service = presets()
    if (service === undefined) return false
    if (session !== undefined) {
      try {
        return wideLevel(service, service.current(session))
      } catch {}
    }
    try {
      const level = owner?.bot === undefined ? wantedBy(sessionId).level : owner.room?.permission ?? owner.bot.permission
      return wideLevel(service, level ?? service.catalog().defaultPreset)
    } catch {
      return false
    }
  }
  // The Sessions that carry the mark now, as a fresh list.
  const unappliedSessions = () => [...unapplied.keys()]

  Object.assign(rt, { newBotPermission, sessionWide, permissionFactsOf, unappliedSessions, permissionCatalog, permissionFallbackOf, permissionKey, autoClosed, applyPermission, applyTaskPermission, levelHolds, reapplyTasks, capTasks, taskOfRoom, inToolCall, callerGroup, callerTask, callerLevel, capTaskByOpener, armedLevels, lowerScheduledSession, assertTaskDepth, taskForebears, taskLevelOf, forgetTaskPermission, checkPreset, startingSession, assertLevelOffered, setPermission, levelTo, inheritedPermission, cleanRoomPermission, setRoomPermission })
}
