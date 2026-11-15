// Scheduled tasks. DSH's schedule service stores each task with the Session it belongs
// to and, when it is due, sends its prompt to that Session as a new message. This
// module lists the team's tasks for Settings, creates and removes them there, and moves
// a Bot's tasks along when its chat goes on in a fresh part, so the Bot keeps seeing
// them. A group chat's task lives on the group's own Session, so the reminder reaches
// the group like a message from the user (see reminderText). DSH 0.2.0 mounts the service only with its Automation tasks bundle on, so
// the service is optional and every endpoint reports whether it is there.

const MAX_TITLE = 120
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
// The targets whose delivery opens a Session of its own: no subagent lineage, no task
// record, so no Bot's tool restriction can bind it (#584, L5). Their first delivery
// lowers the fresh Session to the arming Bot's level, including its Session lineage.
// Anonymous `new` deliveries can only be narrowed when every candidate task has a Bot:
// DSH hides their reserved Session ids, so a person's own task must keep its level.
const NEW_TARGETS = new Set(['new', 'new_once'])
// How often a pause the schedule store refused is retried while it stays refused.
const PAUSE_RETRY_MS = 15_000
// DSH drives deliveries through the schedule service's private `runtime.requestDrive`;
// a host without it leaves a refused delivery waiting for DSH's own next tick. Say so
// once per process, so a DSH bump that drops the hook is not a silent wedge.
let warnedNoDrive = false

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What a group sees of a due reminder: DSH frames it for one Session's model
// ("[SCHEDULE REMINDER]" with JSON fields); the group gets each prompt as one line.
export function reminderText(text) {
  const prompts = []
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    if (one) prompts.push(JSON.parse(one[1]))
    if (batch) for (const entry of JSON.parse(batch[1])) prompts.push(entry.reminder_prompt)
  } catch {
    // A framing this module cannot read goes to the group as it came.
    return text
  }
  const lines = prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  return lines.length === 0 ? text : lines.map(prompt => `[Scheduled task] ${prompt}`).join('\n')
}

// The Session a task delivers to; a `new` target has none until it creates one.
const targetSessionOf = entry => (entry.target?.kind === 'new' ? undefined : entry.target?.sessionId)
// DSH 0.2.2 keeps tasks Host-wide, each with a delivery target, and changes them through
// edit(); DSH 0.2.1 keeps them by Session. Both are served.
const hostWide = service => typeof service.edit === 'function'
// The existing Session a task delivers to; a task that opens new Sessions has none.
const sessionOf = entry => entry.target === undefined ? entry.sessionId : entry.target.kind === 'session' ? entry.target.sessionId : undefined
const OWN_TASK_TOOLS = ['schedule_edit', 'schedule_view']
// DSH 0.2.2's list page: 100 by default, at most 500.
const LIST_PAGE = 100
const LIST_READ_LIMIT = 500
const OTHER_TASK_REFUSAL = 'This task belongs to another chat. A Bot reads and changes only the tasks of its own chat.'
const sameOwner = (a, b) => a !== undefined && b !== undefined && a.botId === b.botId && a.roomId === b.roomId

// The settings form's timing as DSH 0.2.2's typed create selector.
function selectorOf(when) {
  const zone = typeof when?.timeZone === 'string' && when.timeZone !== '' ? when.timeZone : 'UTC'
  switch (when?.kind) {
    case 'at': {
      const at = new Date(String(when.at ?? ''))
      if (Number.isNaN(at.getTime())) throw invalid('Pick a date and time')
      if (at.getTime() <= Date.now()) throw invalid('Pick a time in the future')
      return { kind: 'at', at: at.toISOString() }
    }
    case 'daily':
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      return { kind: 'daily', daily: { time: `${when.time}:00`, time_zone: zone } }
    case 'weekly': {
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      const weekdays = [...new Set((Array.isArray(when.weekdays) ? when.weekdays : []).map(Number))].filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort()
      if (weekdays.length === 0) throw invalid('Pick at least one day')
      return { kind: 'weekly', weekly: { time: `${when.time}:00`, time_zone: zone, weekdays } }
    }
    case 'every': {
      const minutes = Number(when.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw invalid('Repeat every 1 minute to 7 days')
      return { kind: 'every', every_seconds: minutes * 60 }
    }
    default:
      throw invalid('Pick when it runs')
  }
}

export function install(rt) {
  const { ctx } = rt
  let service = null
  // Tasks whose pause failed. While one is stuck, an unlineaged delivery is refused rather
  // than let it run with no Bot to bind it; the next successful sweep clears it. `swept`
  // holds deliveries closed through the boot window, before the first check has run.
  const stuck = new Set()
  // The boot check runs after the team loads; before that an empty team would read as "no
  // restricted Bot" and open the guard too early, so only a load-backed sweep opens it.
  let teamLoaded = false
  let swept = false

  const attach = (sub) => {
    const own = sub.schedule
    service = own
    sub.effect(() => () => { if (service === own) service = null }, 'ds-bot: schedule service')
    void revokeNewSchedules()
      .catch(error => rt.warn('ds-bot: fresh-Session tasks were not checked: %s', error))
  }
  if (typeof ctx.inject === 'function') ctx.inject(['schedule'], attach)
  else if (ctx.get?.('schedule') !== undefined) attach({ schedule: ctx.get('schedule'), effect: (execute, label) => ctx.effect(execute, label) })

  // The Bot (and group chat) a task's Session speaks for, the group chat for a group's
  // own Session, or nothing for a Session outside the team.
  const ownerOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat }
    const room = rt.roomOf(sessionId)
    if (room !== undefined) return { roomId: room.id }
    return rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
  }
  const known = owner => owner !== undefined && (owner.botId === undefined ? rt.roomOf(owner.roomId) !== undefined : rt.botOf(owner.botId) !== undefined)

  // The durable header of a Session: the live registry first, then DSH's persisted copy.
  // The live registry only holds Sessions that are loaded, so a subagent child that ended,
  // or a team loaded after a restart before the child reopened, would be missed.
  const headerOf = async (sessionId) => {
    const live = ctx.sessions?.get?.(sessionId)?.header
    if (live !== undefined) return live
    if (typeof ctx.sessionPersistence?.stat !== 'function') return undefined
    try {
      return (await ctx.sessionPersistence.stat(sessionId))?.header
    } catch {
      return undefined
    }
  }
  // The Bot an involved Session speaks for: its own chat, a group Session, an earlier part,
  // a task run, or a subagent child (through its parent lineage). DSH records every Session
  // involved in a task, the creating one included.
  const lineageOf = async (sessionId) => {
    let current = sessionId
    const ids = []
    for (let depth = 0; typeof current === 'string' && current !== '' && depth < 32; depth += 1) {
      ids.push(current)
      const direct = rt.botOf(current)
      if (direct !== undefined) return { bot: direct, ids }
      const owner = rt.selfOf?.(current) ?? rt.state?.tasks?.[current]?.from
      if (owner !== undefined) {
        const bot = rt.botOf(owner)
        if (bot !== undefined) return { bot, ids }
      }
      const header = await headerOf(current)
      if (header?.origin !== 'subagent' || header.parentSession === undefined) return { ids }
      current = header.parentSession
    }
    return { ids }
  }
  const botOfTaskSession = async sessionId => (await lineageOf(sessionId)).bot
  const restricted = bot => Array.isArray(bot?.denyTools) && bot.denyTools.length > 0
  // Every Session a Bot speaks from now, plus the ones a caller already has.
  const sessionsOf = (bot, extra = []) => {
    const ids = new Set(extra)
    for (const id of rt.sessionsOfBot?.(bot.id) ?? []) ids.add(id)
    for (const part of bot.segments ?? []) ids.add(part.sessionId)
    for (const room of Object.values(rt.state?.rooms ?? {})) {
      for (const part of room.segments?.[bot.id] ?? []) ids.add(part.sessionId)
    }
    for (const [id, task] of Object.entries(rt.state?.tasks ?? {})) {
      if (task.from === bot.id) ids.add(id)
    }
    return ids
  }
  // A refused delivery is re-attempted only when DSH is asked to drive again; the tick that
  // opens the guard or clears the last stuck task does that, and a stuck pause is retried
  // on a timer until the store answers.
  const requestDrive = () => {
    const runtime = service?.runtime
    if (typeof runtime?.requestDrive !== 'function') {
      if (!warnedNoDrive) {
        warnedNoDrive = true
        rt.warn('ds-bot: the schedule service has no requestDrive hook; '
          + 'a refused delivery waits for DSH\'s own next tick')
      }
      return
    }
    try {
      runtime.requestDrive()
    } catch (error) {
      rt.warn('ds-bot: the schedule drive was not re-requested: %s', error?.message ?? error)
    }
  }
  let retryTimer
  const stopRetry = () => {
    if (retryTimer !== undefined) clearInterval(retryTimer)
    retryTimer = undefined
  }
  const scheduleRetry = () => {
    if (retryTimer !== undefined) return
    retryTimer = setInterval(() => {
      void revokeNewSchedules()
        .catch(error => rt.warn('ds-bot: fresh-Session tasks were not checked: %s', error))
      if (stuck.size === 0) stopRetry()
    }, PAUSE_RETRY_MS)
    retryTimer.unref?.()
  }
  ctx.effect(() => stopRetry, 'ds-bot: schedule pause retry')

  /**
   * Pause every active task with a fresh-Session target that a restricted Bot is involved
   * in. Scoped to one Bot when `botId` is given (a restriction, its deletion, or its list
   * becoming empty), else every Bot in the team (a restart, or a task armed by the user for
   * a restricted Bot's Session). The record stays; only its deliveries stop. Resolves the
   * ids it paused.
   * @param {string} [botId] - the Bot whose Sessions must not open fresh Sessions.
   * @param {string[]} [extra] - Sessions of that Bot a caller already holds (deletion).
   * @param {{ any?: boolean }} [options] - pause for this Bot even without a deny list
   *   (its deletion).
   */
  async function revokeNewSchedules(botId, extra = [], { any = false } = {}) {
    if (service === null) return []
    // The attach-time check can run before the team is read; it must neither act on an empty
    // team nor write another host's store. The load-backed sweep does the first check.
    if (botId === undefined && !teamLoaded) return []
    // A host that only reads the team does not write another host's schedule store, and it
    // cannot vouch for what it did not read: the guard stays closed for unlineaged
    // deliveries until this host owns the team and a later sweep runs.
    if (typeof rt.readOnly === 'function' && rt.readOnly() !== undefined) return []
    // Only a sweep that started with the team loaded may open the guard: an attach-time
    // sweep can finish after the boot chain and would otherwise vouch for pre-load state.
    const loadedThen = teamLoaded
    const scoped = botId !== undefined
    const bot = scoped ? rt.botOf(botId) : undefined
    if (scoped && bot === undefined) return []
    const sessions = scoped ? sessionsOf(bot, extra) : undefined
    const cache = new Map()
    const botFor = async (sessionId) => {
      if (cache.has(sessionId)) return cache.get(sessionId)
      const resolved = await botOfTaskSession(sessionId)
      cache.set(sessionId, resolved)
      return resolved
    }
    // Is this task's delivery one no team lineage can bind, and is it this Bot's?
    const freshEntry = async (entry) => {
      const target = entry.target ?? {}
      const unbound = target.kind === 'session'
        && await botFor(target.sessionId) === undefined
        && !(sessions !== undefined && sessions.has(target.sessionId))
      return NEW_TARGETS.has(target.kind) || unbound
    }
    const belongsToBot = async (entry) => {
      if (!(await freshEntry(entry))) return false
      const involved = Array.isArray(entry.involvedSessionIds) ? entry.involvedSessionIds : []
      if (sessions === undefined) {
        for (const sessionId of involved) {
          if (restricted(await botFor(sessionId))) return true
        }
        return false
      }
      // A scoped caller vouches for the ids it hands over, so they resolve before maps go.
      const matched = involved.some(sessionId => sessions.has(sessionId))
      if (matched && (any || restricted(bot))) return true
      if (bot === undefined) return false
      // A subagent child is in no team map; its durable header still names the Bot.
      for (const sessionId of involved) {
        const owner = await botFor(sessionId)
        if (owner?.id === bot.id && (any || restricted(bot))) return true
      }
      return false
    }
    const wasClosed = !swept || stuck.size > 0
    const paused = []
    const attempted = new Set()
    const pauseEntry = async (entry) => {
      attempted.add(entry.id)
      try {
        await service.edit({ id: entry.id, action: 'update', patch: { active: false } })
        stuck.delete(entry.id)
        paused.push(entry.id)
        rt.warn('ds-bot: paused the scheduled task %s: '
          + 'its fresh Session would run with no Bot lineage', entry.title ?? entry.id)
      } catch (error) {
        stuck.add(entry.id)
        rt.warn('ds-bot: the scheduled task %s could not be paused (%s); '
          + 'a delivery to a fresh Session is refused until it is', entry.title ?? entry.id,
        error?.message ?? error)
      }
    }
    const active = new Map()
    for (const entry of await service.catalog()) {
      if (entry.status === 'active') active.set(entry.id, entry)
    }
    for (const entry of active.values()) {
      if (await belongsToBot(entry)) await pauseEntry(entry)
    }
    // A stuck task this sweep did not match: a Bot that is now unrestricted or gone has no
    // restriction left to bypass, so the task is released; while a restricted Bot remains
    // involved, the pause is tried again here.
    for (const id of stuck) {
      const entry = active.get(id)
      if (entry === undefined) { stuck.delete(id); continue }
      if (attempted.has(id)) continue
      if (!(await freshEntry(entry))) { stuck.delete(id); continue }
      const involved = Array.isArray(entry.involvedSessionIds) ? entry.involvedSessionIds : []
      let stillRestricted = false
      for (const sessionId of involved) {
        if (restricted(await botFor(sessionId))) { stillRestricted = true; break }
      }
      if (!stillRestricted) stuck.delete(id)
      else await pauseEntry(entry)
    }
    if (stuck.size > 0) scheduleRetry()
    swept = swept || loadedThen
    if (wasClosed && swept && stuck.size === 0) requestDrive()
    return paused
  }
  // A restart keeps both the deny list and the armed task: check once the team is loaded.
  void Promise.resolve(rt.load?.()).then(() => {
    teamLoaded = true
    return revokeNewSchedules()
  }).catch(error => rt.warn('ds-bot: fresh-Session tasks were not checked: %s', error))
  // A task armed later for a restricted Bot's Session (by the user, in DSH's own surface)
  // is checked the moment the service reports it.
  ctx.on('schedule/changed', () => {
    void revokeNewSchedules()
      .catch(error => rt.warn('ds-bot: fresh-Session tasks were not checked: %s', error))
  })
  // Whether one delivery still belongs to a task a restricted Bot is involved in. Reads the
  // catalog only: management writes are serialized behind a delivery, reads are not.
  const unsafeDelivery = async (sessionId) => {
    let entries
    try {
      entries = await service.catalog()
    } catch {
      return true
    }
    const seen = new Map()
    const restrictedInvolved = async (ids) => {
      for (const id of ids) {
        if (!seen.has(id)) seen.set(id, await botOfTaskSession(id))
        if (restricted(seen.get(id))) return true
      }
      return false
    }
    let freshUnsafe = false
    let exact = false
    for (const entry of entries) {
      if (entry.status !== 'active') continue
      const target = entry.target ?? {}
      const involved = Array.isArray(entry.involvedSessionIds) ? entry.involvedSessionIds : []
      if (target.kind === 'new') {
        // A `new` target reserves a hidden Session id; while one of its tasks is unsafe,
        // any unlineaged activation could be that delivery.
        if (await restrictedInvolved(involved)) freshUnsafe = true
        continue
      }
      if (target.kind === 'new_once') {
        if (target.sessionId !== sessionId) continue
        exact = true
        if (await restrictedInvolved(involved)) return true
        continue
      }
      if (target.kind !== 'session' || target.sessionId !== sessionId) continue
      exact = true
      // A session target that resolves to a Bot is bound; one that does not is unsafe only
      // when a restricted Bot is involved (a fresh target that already delivered once).
      if (await botOfTaskSession(sessionId) !== undefined) continue
      if (await restrictedInvolved(involved)) return true
    }
    // An exact task for this Session decides it; only an anonymous `new` delivery falls
    // back to "some unsafe fresh task exists".
    return exact ? false : freshUnsafe
  }
  // This waterfall reads the catalog only: a write would wait on its own delivery.
  // A Session a task already delivered to keeps the level it got then. That covers a
  // `session` target and the Session in a task's last delivery, which DSH activates again
  // on each later drive to recover a reminder still queued there. A first delivery, or
  // its retry, is in no receipt yet.
  const openedLevel = async (sessionId, agent) => {
    if (service === null || agent?.session === undefined || rt.permissionCatalog?.() === undefined || await botOfTaskSession(sessionId) !== undefined) return agent
    const entries = await service.catalog()
    if (entries.some(entry => (entry.target?.kind === 'session' && entry.target.sessionId === sessionId) || entry.lastDelivery?.targetSessionId === sessionId)) return agent
    let armed = entries.filter(entry => entry.target?.kind === 'new_once' && entry.target.sessionId === sessionId)
    if (armed.length === 0) {
      // Run-now may deliver a paused or not-yet-due task. Neither status nor an
      // execution slot singles out a `new` target, so every such entry is a candidate.
      armed = entries.filter(entry => entry.target?.kind === 'new')
      for (const entry of armed) {
        let hasBot = false
        for (const id of entry.involvedSessionIds ?? []) {
          if ((await lineageOf(id)).bot !== undefined) { hasBot = true; break }
        }
        if (!hasBot) {
          rt.warn('ds-bot: the fresh scheduled Session %s keeps its level: a task no Bot armed may be the one it is for', sessionId)
          return agent
        }
      }
    }
    const levels = []
    for (const entry of armed) {
      for (const id of entry.involvedSessionIds ?? []) {
        const { bot, ids } = await lineageOf(id)
        if (bot !== undefined) levels.push(...(rt.armedLevels?.(ids, bot) ?? []))
      }
    }
    try {
      await rt.lowerScheduledSession?.(agent.session, levels)
    } catch (cause) {
      rt.warn('ds-bot: the fresh Session %s of a scheduled task was not lowered to its Bot\'s level: %s', sessionId, cause)
      throw new Error('ds-bot: a scheduled delivery is held until its Session runs no wider than its Bot\'s permission level', { cause })
    }
    return agent
  }
  // The last line for a delivery: if the check has not run yet, or a task could not be
  // paused, a Session no Bot binds must not be activated for a task a restricted Bot is in.
  // DSH drives deliveries through this waterfall, before the prompt runs. It must never
  // await a management write: that would queue behind the delivery's own serialized drive.
  ctx.on('schedule/resolve-agent', async (sessionId, next) => {
    if (swept && stuck.size === 0) return openedLevel(sessionId, await next())
    if (await botOfTaskSession(sessionId) !== undefined) return next()
    const unsafe = teamLoaded ? await unsafeDelivery(sessionId) : true
    if (!unsafe) return openedLevel(sessionId, await next())
    void revokeNewSchedules()
      .catch(error => rt.warn('ds-bot: fresh-Session tasks were not checked: %s', error))
    throw new Error('ds-bot: a scheduled delivery is blocked until its task can be paused')
  })

  async function schedulesView() {
    if (service === null) return { available: false, tasks: [] }
    const now = Date.now()
    const tasks = []
    for (const entry of await service.catalog()) {
      const sessionId = targetSessionOf(entry)
      const owner = sessionId === undefined ? undefined : ownerOf(sessionId)
      if (!known(owner)) continue
      // The state DSH derives for its own view: a task past its next firing reads
      // overdue; a paused one stays paused; any other is finished. catalog() carries
      // the status but not this state, so it is derived the same way here.
      const state = entry.status === 'active' ? (now >= Date.parse(entry.scheduledAt) ? 'overdue' : 'scheduled')
        : entry.status === 'paused' ? 'paused' : 'finished'
      tasks.push({ ...entry, sessionId, ...owner, state })
    }
    return { available: true, tasks }
  }

  const endpoints = {
    schedules: () => schedulesView(),
    async 'schedule-create'(body) {
      if (service === null) throw invalid('Automation tasks are off in DSH')
      const bot = rt.botOf(body.target)
      const room = rt.roomOf(body.target)
      if (bot === undefined && room === undefined) throw invalid('No such Bot or group chat')
      const title = String(body.title ?? '').trim()
      const prompt = String(body.prompt ?? '').trim()
      if (title === '') throw invalid('Give the task a name')
      if (title.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
      if (prompt === '') throw invalid('Say what the Bot should do')
      const sessionId = bot ? rt.chatOf(bot.id) : rt.sessionOfRoom(room)
      await service.create({ title, prompt, timing: selectorOf(body.when), target: { kind: 'session', sessionId } })
      return schedulesView()
    },
    async 'schedule-delete'(body) {
      if (service === null) throw invalid('Automation tasks are off in DSH')
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      const entry = (await service.catalog()).find(task => task.id === body.id)
      if (entry === undefined || targetSessionOf(entry) !== body.sessionId) throw invalid('No such task')
      await service.edit({ id: body.id, action: 'delete' })
      return schedulesView()
    },
  }

  // A fresh part takes over the earlier part's active tasks: each is created again on
  // the fresh Session before the old one goes, so a failure leaves it where it was.
  async function moveSchedules(fromId, toId) {
    if (service === null) return
    // A task changes its target in place and keeps its next firing; a paused one
    // moves too, so it resumes in the Bot's current part.
    for (const entry of await service.catalog()) {
      if (entry.status === 'ended' || targetSessionOf(entry) !== fromId) continue
      await service.edit({ id: entry.id, action: 'update', patch: { target: { kind: 'session', sessionId: toId } } })
    }
  }

  // DSH 0.2.2's task ids are Host-wide, so a Bot's schedule tools reach only the tasks
  // that deliver to its own chat, or to the same group place, in any of its parts.
  ctx.on('tools/pre-execute', async function ownTasksGate(exec, next) {
    const decision = await next()
    if (decision.kind !== 'allow' || !OWN_TASK_TOOLS.includes(exec.name) || service === null || !hostWide(service)) return decision
    await rt.load()
    const caller = exec.agent?.id
    if (!rt.isBotSession(caller)) return decision
    const entry = (await service.catalog()).find(task => task.id === exec.arguments?.id)
    // An unknown id gets DSH's own not-found result.
    if (entry === undefined) return decision
    const target = sessionOf(entry)
    if (target !== undefined && sameOwner(ownerOf(caller), ownerOf(target))) return decision
    return { kind: 'deny', reason: OTHER_TASK_REFUSAL }
  })
  // schedule_list pages over every Host task and cannot filter by Session, and only the
  // tool formats its items. So the tool is asked for the Host range that holds the
  // caller's page (catalog() keeps list()'s order), and the other chats' tasks in that
  // range are dropped. A page whose tasks span more than one Host page comes back
  // short; total still counts all of the caller's tasks, so the next offset goes on.
  ctx.on('tools/execute', async function listOwnSchedules(exec, next) {
    if (exec.name !== 'schedule_list' || service === null || !hostWide(service)) return next()
    await rt.load()
    const own = rt.isBotSession(exec.agent?.id) ? ownerOf(exec.agent.id) : undefined
    if (own === undefined) return next()
    const asked = exec.arguments ?? {}
    const limit = asked.limit ?? LIST_PAGE
    const offset = asked.offset ?? 0
    const mine = entry => {
      const target = sessionOf(entry)
      return target !== undefined && sameOwner(own, ownerOf(target))
    }
    // An invalid page gets DSH's own input error; a page it accepts anyway is still narrowed.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_READ_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
      const result = await next()
      if (result.isError || !Array.isArray(result.value?.items)) return result
      const items = result.value.items.filter(mine)
      const total = (await service.catalog()).filter(entry => mine(entry) && (asked.active === undefined || (entry.status === 'active') === asked.active)).length
      return { ...result, value: { ...result.value, items, shown: items.length, total } }
    }
    const pool = (await service.catalog()).filter(entry => asked.active === undefined || (entry.status === 'active') === asked.active)
    const positions = pool.flatMap((entry, at) => (mine(entry) ? [at] : []))
    const page = positions.slice(offset, offset + limit)
    const from = page[0] ?? pool.length
    exec.arguments = { ...asked, offset: from, limit: page.length === 0 ? 1 : Math.min(LIST_READ_LIMIT, page.at(-1) - from + 1) }
    let result
    try {
      result = await next()
    } finally {
      exec.arguments = asked
    }
    if (result.isError || !Array.isArray(result.value?.items)) return result
    const items = result.value.items.filter(mine).slice(0, limit)
    return { ...result, value: { ...result.value, items, shown: items.length, total: positions.length, limit, offset } }
  })

  Object.assign(rt, {
    scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}),
    moveSchedules,
    revokeNewSchedules,
  })
}
