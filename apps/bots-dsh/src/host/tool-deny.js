// A Bot's tool deny list. `state.bots.<id>.denyTools` names the tools that Bot never gets,
// and they are removed from the model's surface by DSH's own `tools.restrict` on every
// Session of that Bot: its own chat, each group Session, an earlier part reopened, a task,
// and every subagent child of any of them (by its Session header's parent lineage).
// A denied tool is absent, not forbidden by an instruction: the model cannot call what it
// cannot see, and a call that reaches the executor anyway is refused. A tool registered
// after the Session started stays visible until the next resolve; the executor guard
// refuses it in the meantime.
//
// A name this profile does not serve is ignored with a warning instead of failing the boot:
// a list written for another DSH keeps working here, and a typo is reported where the user
// can see it (the Bot's own chat is untouched by it).
//
// A Bot that denies anything is restricted, and it also loses DSH's `schedule_create` and
// `schedule_edit`: their `new` and `new_once` targets open a Session that is neither a
// subagent child nor a task record, so no lineage would bind the restriction to it (#584).
import { refusal } from './refusal.js'

/** The most names one Bot may deny. */
export const DENY_MAX = 64
/** The longest tool name accepted. */
export const DENY_NAME_MAX = 64
// The tools that can start or retarget a scheduled task on a Session outside the team's
// lineage. Every restricted Bot loses both; `schedule_list` and `schedule_view` open nothing.
const SCHEDULE_TOOLS = ['schedule_create', 'schedule_edit']
const RETRY_MS = 1_000
const RETRY_TRIES = 15

/**
 * A Bot's deny list, cleaned: trimmed, deduplicated, empty entries dropped.
 * `undefined` leaves it alone, `null` or an empty list clears it.
 * @param {unknown} value - the list the caller sent.
 * @returns {string[] | null | undefined} the names, or null to clear.
 */
export function cleanDenyTools(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Array.isArray(value)) throw refusal('denyTools is a list of tool names')
  if (value.length > DENY_MAX) throw refusal(`denyTools holds at most ${DENY_MAX} tool names`)
  const names = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') throw refusal('Each denyTools entry is a tool name')
    const name = entry.trim()
    if (name === '') continue
    if (name.length > DENY_NAME_MAX) throw refusal(`A tool name is at most ${DENY_NAME_MAX} characters`)
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names.length === 0 ? null : names
}

export function install(rt) {
  const { ctx } = rt

  // Session id -> the restriction in force there: the agent it was set on, the names it
  // asked for, and DSH's disposer that gives every tool back.
  /** @type {Map<string, { agent: object, names: string[], lift: () => void }>} */
  const held = new Map()
  // Sessions whose restriction could not be set yet (schemas not up, restrict missing).
  /** @type {Map<string, { agent: object, tries: number }>} */
  const waiting = new Map()
  // What was already reported per Session, so a stuck name warns once.
  const warned = new Map()
  let timer

  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  ctx.effect(() => stop, 'ds-bot: tool deny retry')

  const schedule = (sessionId, agent) => {
    const seen = waiting.get(sessionId)
    waiting.set(sessionId, { agent, tries: (seen?.tries ?? 0) + 1 })
    if (timer === undefined) {
      timer = setInterval(() => {
        for (const [id, entry] of waiting) {
          if (entry.tries > RETRY_TRIES) {
            // The profile never published what this Session needs; the Bot keeps every tool
            // rather than waiting forever, and the reason is on the record.
            waiting.delete(id)
            warnOnce(id, `ds-bot: the denied tools of Session ${id} could not be set; they stay available`)
            continue
          }
          void apply(id, entry.agent)
        }
        if (waiting.size === 0) stop()
      }, RETRY_MS)
      timer.unref?.()
    }
  }

  const release = (sessionId) => {
    const entry = held.get(sessionId)
    held.delete(sessionId)
    if (entry === undefined) return
    try {
      entry.lift?.()
    } catch (error) {
      rt.warn('ds-bot: the denied tools of Session %s stay hidden until DSH restarts: %s', sessionId, error)
    }
  }

  const same = (left, right) => left.length === right.length && left.every((name, index) => name === right[index])

  // The names in force for a Bot: its own list, sorted, plus the schedule tools every
  // restricted Bot loses. An empty (or cleared) list restricts nothing.
  const deniedNames = (bot) => {
    const listed = Array.isArray(bot?.denyTools) ? bot.denyTools : []
    return listed.length === 0 ? [] : [...new Set([...listed, ...SCHEDULE_TOOLS])].sort()
  }

  // The tool names this profile serves for an Agent, before any restriction. `schemas()` is the
  // visible surface, so after a restriction it hides a name this Bot already denies: reading
  // the served set from it would call an additive update's earlier name unknown and drop it
  // from the new list. `view().restrictableNames` is the set `restrict()` itself accepts.
  const servedNames = (agent) => {
    if (typeof ctx.tools.view === 'function') {
      const view = ctx.tools.view(agent)
      if (view?.restrictableNames !== undefined) return new Set(view.restrictableNames)
    }
    return new Set(ctx.tools.schemas(agent).map(schema => schema.name))
  }

  // Every name this DSH serves to an Agent before any restriction, its own scope included: a
  // capability mounted on `agent.ctx` registers there, so `restrictableNames` leaves it out,
  // yet the name is real and the executor guard still refuses a call to it. Validation uses
  // this set; application uses `servedNames`, because `restrict()` only takes global names.
  const knownNames = (agent) => {
    if (typeof ctx.tools.view === 'function') {
      const view = ctx.tools.view(agent)
      if (view?.knownNames !== undefined) return new Set(view.knownNames)
    }
    return new Set(ctx.tools.schemas(agent).map(schema => schema.name))
  }

  const warnOnce = (sessionId, message) => {
    if (warned.get(sessionId) === message) return
    warned.set(sessionId, message)
    rt.warn('%s', message)
  }

  // A Session's creation header, while DSH still holds it: a subagent child names its parent
  // there, and that parent may be the Bot's own chat, a part, a group Session or a task.
  const headerOf = (sessionId) => {
    try {
      return ctx.sessions?.get?.(sessionId)?.header
    } catch {
      return undefined
    }
  }

  // The Bot a Session speaks for: its own chat (a Session keyed by the Bot's id, indexed or
  // not yet), a group Session, an earlier part of either, or a task run. `start_task` records
  // its Session in `state.tasks` only, which the store's `selfOf` does not read, so a task is
  // resolved here from the record the task run wrote. A subagent child is in none of the
  // team's maps: it follows its durable parent lineage, so a restricted Bot cannot reach its
  // tools through one.
  const botOfSession = (sessionId, agent) => {
    let current = sessionId
    let header = agent?.session?.header ?? headerOf(current)
    for (let depth = 0; typeof current === 'string' && depth < 32; depth += 1) {
      const direct = rt.botOf(current)
      if (direct !== undefined) return direct
      const owner = rt.selfOf(current) ?? rt.state?.tasks?.[current]?.from
      if (owner !== undefined) {
        const bot = rt.botOf(owner)
        if (bot !== undefined) return bot
      }
      if (header?.origin !== 'subagent' || header.parentSession === undefined) return undefined
      current = header.parentSession
      header = headerOf(current)
    }
    return undefined
  }

  /**
   * Set (or refresh, or lift) the restriction on one Session against the Bot's current list.
   * @param {string} sessionId - the Session being resolved.
   * @param {object} agent - its live agent, the object DSH assembles tools for.
   */
  async function apply(sessionId, agent, knownBot) {
    if (typeof sessionId !== 'string' || agent === undefined) return
    const bot = knownBot ?? botOfSession(sessionId, agent)
    const wanted = deniedNames(bot)
    const current = held.get(sessionId)
    if (current !== undefined && current.agent === agent && same(current.names, wanted)) {
      waiting.delete(sessionId)
      return
    }
    if (wanted.length === 0) {
      waiting.delete(sessionId)
      release(sessionId)
      return
    }
    if (typeof agent?.ctx?.tools?.restrict !== 'function') {
      schedule(sessionId, agent)
      return
    }
    let served
    try {
      served = servedNames(agent)
    } catch {
      schedule(sessionId, agent)
      return
    }
    if (served.size === 0) {
      // The profile has not published its tool schemas yet: not the same as an unknown name.
      schedule(sessionId, agent)
      return
    }
    // A tool registered after this Session started is not in `served`: the executor guard
    // below still refuses it, and the next resolve re-applies this list.
    const deny = wanted.filter(name => served.has(name))
    const missing = wanted.filter(name => !served.has(name))
    // An implicit schedule name this profile cannot restrict is not the user's typo: the
    // executor guard still refuses it, so there is nothing to report.
    const listed = new Set(Array.isArray(bot?.denyTools) ? bot.denyTools : [])
    const unknown = missing.filter(name => listed.has(name))
    if (unknown.length > 0) {
      warnOnce(sessionId, `ds-bot: ${bot?.name ?? 'a Bot'} denies ${unknown.join(', ')}, `
        + 'which this DSH does not serve or cannot restrict; ignored')
    }
    waiting.delete(sessionId)
    release(sessionId)
    if (deny.length === 0) return
    try {
      const lift = agent.ctx.tools.restrict({ deny })
      held.set(sessionId, { agent, names: wanted, lift })
    } catch (error) {
      rt.warn('ds-bot: the tools of %s not denied on Session %s: %s', bot?.name ?? 'a Bot', sessionId, error)
      schedule(sessionId, agent)
    }
  }

  /**
   * Apply a Bot's list to every Session it has now. Safe to call after any change: a new
   * list is lifted and re-applied, an emptied one gives every tool back.
   * @param {object} bot - the Bot record (its `denyTools` is read live).
   */
  async function applyToolDeny(bot, extra = []) {
    if (bot === undefined) return
    const sessions = new Set([...rt.sessionsOfBot(bot.id), ...extra])
    for (const part of bot.segments ?? []) sessions.add(part.sessionId)
    // A group keeps its earlier parts under the room, beside the Bot's own history.
    for (const room of Object.values(rt.state?.rooms ?? {})) {
      for (const part of room.segments?.[bot.id] ?? []) sessions.add(part.sessionId)
    }
    await Promise.all([...sessions].map(async (sessionId) => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        // The Bot is known here, and a fresh part can be mapped before the store's own
        // indexes see it; apply the list from this record rather than re-resolving it.
        await apply(sessionId, agent?.agent ?? agent, bot)
      } catch (error) {
        rt.warn('ds-bot: the tool deny list of %s not applied to Session %s: %s', bot.name, sessionId, error?.message ?? error)
      }
    }))
  }

  /**
   * The names in `names` this DSH does not serve, read from a Session's own tool surface.
   * An empty list means the Session could not be resolved yet, which is not a verdict.
   * @param {string} sessionId - the Session whose Bot asked for the list.
   * @param {string[]} names - the cleaned deny list.
   */
  async function unknownDenyTools(sessionId, names) {
    if (!Array.isArray(names) || names.length === 0) return []
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch {
      return []
    }
    const live = agent?.agent ?? agent
    let served
    try {
      served = knownNames(live)
    } catch {
      return []
    }
    if (served.size === 0) return []
    return names.filter(name => !served.has(name))
  }

  // Refuse a save that names a tool this DSH does not serve: for a hard read-only list, a
  // typo must fail loudly rather than leave the tool the person meant to remove on the Bot.
  async function assertDenyTools(sessionId, names) {
    const unknown = await unknownDenyTools(sessionId, names)
    if (unknown.length === 0) return
    throw refusal(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not a tool' : 'are not tools'} this DSH serves. denyTools takes exact tool names, case-sensitive: use the name the tool shows in this Bot's surface, or leave it out.`)
  }

  // A Session resolving its agent, saved earlier included: the same moment the team tools
  // of a DSH bot Session are decided, and before a step assembles its tools.
  ctx.on('agent/created', ({ agent } = {}) => {
    void rt.load()
      .then(() => apply(agent?.session?.id, agent))
      .catch(error => rt.warn('ds-bot: tool deny on agent/created failed: %s', error))
  })

  // The last line: a call that reaches the executor for a name this Bot denies is refused,
  // whatever put the tool on the surface.
  ctx.on('tools/execute', async (exec, next) => {
    // And none at all on a Session whose permission level was not set (permissions.js).
    try {
      await rt.levelHolds?.(exec)
    } catch (error) {
      if (error?.code === 'bot/refused') rt.noteStop?.(exec.agent?.id ?? exec.agent?.session?.id, { why: 'level', tool: exec.name, callId: exec.callId }, exec.agent)
      throw error
    }
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (name === '' || exec?.agent === undefined) return next()
    const bot = botOfSession(exec.agent?.id ?? exec.agent?.session?.id, exec.agent)
    // A call that goes on carries its Session, for a task started inside it (permissions.js).
    if (bot === undefined || !deniedNames(bot).includes(name)) return rt.inToolCall === undefined ? next() : rt.inToolCall(exec, next)
    rt.noteStop?.(exec.agent?.id ?? exec.agent?.session?.id, { why: 'tool', tool: name, callId: exec.callId }, exec.agent)
    throw refusal(`${bot.name} does not have the ${name} tool`)
  })

  // Retries stop on a Session that leaves the team, so a lift is not attempted on a gone agent.
  Object.assign(rt, { botOfSession, applyToolDeny, cleanDenyTools, unknownDenyTools, assertDenyTools })
}
