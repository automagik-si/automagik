// A Bot's tool deny list and its shell capability. `state.bots.<id>.denyTools` names the
// tools that Bot never gets; `state.bots.<id>.shell === false` says the Bot has no shell.
// Both are removed from the model's surface by DSH's own `tools.restrict` on every Session
// of that Bot: its own chat, each group Session, an earlier part reopened, a task, and
// every subagent child of any of them (by its Session header's parent lineage). A denied
// tool is absent, not forbidden by an instruction: the model cannot call what it cannot
// see, and a call that reaches the executor anyway is refused. A tool registered after
// the Session started stays visible until the next resolve; the executor guard refuses it
// in the meantime.
//
// The shell capability is fail-closed: a shell-less Bot loses every tool that can run a
// command or a program, whatever the tool is called. Names the product serves (`bash`,
// `pwsh`, `terminal_*`, `start_task`, `attach_capability`, `approve_agent_action`, the
// computer-use tools) are denied outright; any other tool whose parameters take a command,
// a program or a terminal's text is denied from its schema, and a renamed or aliased copy
// is refused by the executor from the definition it resolves. A tool the profile registers
// later is refused there without another apply.
//
// A name this profile does not serve is ignored with a warning instead of failing the boot:
// a list written for another DSH keeps working here, and a typo is reported where the user
// can see it (the Bot's own chat is untouched by it).
//
// A Bot that denies anything or has no shell is restricted, and it also loses DSH's
// `schedule_create` and `schedule_edit`: their `new` and `new_once` targets open a Session
// that is neither a subagent child nor a task record, so no lineage would bind the
// restriction to it (#584).
import { isComputerTool } from './computer/catalog.js'
import { changesWorkingFolder } from './folders.js'
import { refusal } from './refusal.js'
import { teamToolOf } from './approvals.js'
import { isSolverBot } from '../shared/solver-method.js'

/** The most names one Bot may deny. */
export const DENY_MAX = 64
/** The longest tool name accepted. */
export const DENY_NAME_MAX = 64
// The tools that can start or retarget a scheduled task on a Session outside the team's
// lineage. Every restricted Bot loses both; `schedule_list` and `schedule_view` open nothing.
const SCHEDULE_TOOLS = ['schedule_create', 'schedule_edit']
const RETRY_MS = 1_000
const RETRY_TRIES = 15

// The shell tools this product serves by name. `terminal_*` and `user_terminal_*` cover
// every terminal tool the profile offers now or adds later.
const SHELL_NAMES = new Set(['bash', 'pwsh', 'powershell'])
const SHELL_PREFIXES = ['terminal_', 'user_terminal_']
// Tools that start a worker, spawn a program from outside the tool surface, or approve a
// local agent CLI's command. They are scope-local, so the executor guard is what refuses
// them; the restriction only hides the ones the registry lets it name.
const SHELL_LAUNCHERS = new Set(['start_task', 'attach_capability', 'approve_agent_action'])
// The parameters a tool takes when it runs a command or a program, required or not: a
// shell-less Bot must not gain one through a tool nobody has taught this plugin about.
const COMMAND_PARAMS = new Set(['command', 'cmd', 'program', 'executable', 'argv', 'shell', 'bash', 'pwsh', 'powershell'])
// A session id beside one of these types into a terminal, whatever the tool is called.
const TERMINAL_PARAMS = ['text', 'type', 'keys']
// An ACP agent's own call (acp-dsh's `acp_tool`): these kinds do not run a command. Any
// other kind, a missing kind, or an input carrying a command is refused for a shell-less Bot.
const ACP_SAFE_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'fetch'])
// The definitions this process has already identified as shell tools. A plugin that
// registers the same definition (or its `execute`) under another name is a renamed tool
// (aliasing it left its capability behind), and the shape alone may not say so.
const shellDefinitions = new WeakSet()
const shellExecutes = new WeakSet()

/**
 * A Bot's shell capability, cleaned. `undefined` leaves it alone; `true` means the Bot may
 * have a shell; `false` means it never gets one.
 * @param {unknown} value - the setting the caller sent.
 * @returns {boolean | undefined} the capability, or undefined to leave it alone.
 */
export function cleanShell(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw refusal('shell is true or false')
  return value
}

/**
 * The names one tool takes, by the product's names and its parameters. A tool this plugin
 * has never seen is still a shell tool when it takes a command or a program.
 * @param {string} name - the tool name as registered.
 * @param {object} [definition] - the tool definition or projected schema.
 * @returns {boolean} whether the tool can run a command, a program or a terminal.
 */
export function reachesShell(name, definition) {
  if (typeof name !== 'string' || name === '') return false
  // An MCP tool is `mcp__<server>__<tool>`; a server may alias a shell tool under its own
  // prefix, so the last segment is checked too.
  const leaf = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name
  if (SHELL_NAMES.has(name) || SHELL_NAMES.has(leaf)) return rememberShell(definition, true)
  if (SHELL_PREFIXES.some(prefix => name.startsWith(prefix) || leaf.startsWith(prefix))) return rememberShell(definition, true)
  if (isComputerTool(name)) return rememberShell(definition, true)
  // A definition already known to run a shell, registered under one more name.
  if (shellDefinitions.has(definition) || shellExecutes.has(definition?.execute)) return true
  const properties = propertiesOf(definition)
  if (properties === undefined) return false
  if (Object.keys(properties).some(key => COMMAND_PARAMS.has(key))) return rememberShell(definition, true)
  if (properties.sessionId !== undefined && TERMINAL_PARAMS.some(key => properties[key] !== undefined)) return rememberShell(definition, true)
  return false
}

function rememberShell(definition, verdict) {
  if (definition !== null && typeof definition === 'object') shellDefinitions.add(definition)
  if (typeof definition?.execute === 'function') shellExecutes.add(definition.execute)
  return verdict
}

/**
 * Whether one call of `name` with `args` runs a command or a program. `reachesShell` covers
 * the tools that always do; this adds the ACP mirror, whose calls mostly do not.
 * @param {string} name - the tool name as registered.
 * @param {unknown} args - the call's own arguments.
 * @param {object} [definition] - the tool definition or projected schema.
 * @returns {boolean} whether the call must be refused on a shell-less Bot.
 */
export function shellCall(name, args, definition) {
  if (reachesShell(name, definition)) return true
  if (SHELL_LAUNCHERS.has(name)) return true
  if (name === 'acp_tool' || acpShaped(definition)) return runsProgram(args)
  return false
}

function propertiesOf(definition) {
  const properties = definition?.parameters?.properties
  return properties !== null && typeof properties === 'object' ? properties : undefined
}

// acp-dsh's mirror: the agent's own call, shown to the person and approved through DSH.
function acpShaped(definition) {
  const properties = propertiesOf(definition)
  return properties !== undefined && properties.title !== undefined
    && properties.input !== undefined && properties.kind !== undefined
}

function runsProgram(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return true
  if (args.kind === 'execute') return true
  const input = args.input
  if (input !== null && typeof input === 'object'
    && (Object.hasOwn(input, 'command') || Object.hasOwn(input, 'cmd'))) return true
  // An image the agent makes is not a command, even when the agent calls it an "other" tool.
  if (args.image === true) return false
  return typeof args.kind !== 'string' || !ACP_SAFE_KINDS.has(args.kind)
}

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
  /** @type {Map<string, { agent: object, names: string[], lift?: () => void }>} */
  const held = new Map()
  // Sessions whose restriction could not be set yet (schemas not up, restrict missing).
  /** @type {Map<string, { agent: object, tries: number }>} */
  const waiting = new Map()
  // What was already reported per Session, so a stuck name warns once.
  const warned = new Map()
  // Shell tool names seen for a Bot while its shell is off. A tool hidden by the restriction
  // no longer shows in the visible surface, so the next apply keeps what this one found.
  /** @type {Map<string, Set<string>>} */
  const shellSeen = new Map()
  let timer

  const noShell = bot => bot?.shell === false
  const isRestricted = bot => noShell(bot) || (Array.isArray(bot?.denyTools) && bot.denyTools.length > 0)

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

  // The names this Bot's sessions must not get now: the user's list, the schedule tools a
  // restricted Bot loses, and every shell tool and launcher when the Bot has no shell.
  // Shell tools are found from the Session's own surface, so a renamed copy is named too.
  const deniedNames = (bot, agent) => {
    const names = new Set(Array.isArray(bot?.denyTools) ? bot.denyTools : [])
    if (isRestricted(bot)) for (const name of SCHEDULE_TOOLS) names.add(name)
    if (noShell(bot)) {
      for (const name of SHELL_LAUNCHERS) names.add(name)
      for (const name of shellNamesOf(agent, bot)) names.add(name)
    } else if (bot?.id !== undefined) shellSeen.delete(bot.id)
    return [...names].sort()
  }

  // Every shell tool the Session's surface shows, plus what an earlier apply found while the
  // restriction already hid some of them. `view().visible` is the surface; `knownNames` and
  // `restrictableNames` are pre-restriction, so a canonical name is caught even when hidden.
  const shellNamesOf = (agent, bot) => {
    const names = new Set()
    let view
    try { view = typeof ctx.tools?.view === 'function' ? ctx.tools.view(agent) : undefined } catch { view = undefined }
    const visible = view?.visible
    if (visible !== undefined && typeof visible.entries === 'function') {
      for (const [name, definition] of visible) if (reachesShell(name, definition)) names.add(name)
      // A second pass catches an alias registered before the definition it shares, which the
      // first pass only learned to recognize when it reached the shell tool's own name.
      for (const [name, definition] of visible) if (reachesShell(name, definition)) names.add(name)
    } else {
      try {
        for (const schema of ctx.tools?.schemas?.(agent) ?? []) {
          if (reachesShell(schema?.name, schema)) names.add(schema.name)
        }
      } catch { /* no surface yet: the next resolve asks again */ }
    }
    for (const name of view?.restrictableNames ?? view?.knownNames ?? []) {
      if (reachesShell(name)) names.add(name)
    }
    if (bot?.id !== undefined) {
      const seen = shellSeen.get(bot.id) ?? new Set()
      for (const name of names) seen.add(name)
      shellSeen.set(bot.id, seen)
      for (const name of seen) names.add(name)
    }
    return names
  }

  // The tool definition a call runs under. The step's own schema wins; otherwise the
  // registry (scope-local tools included) is asked, so an alias is checked by what it is.
  const definitionOf = (exec) => {
    if (exec?.schema !== undefined && exec.schema?.parameters !== undefined) return exec.schema
    try {
      if (typeof ctx.tools?.get === 'function') {
        const found = ctx.tools.get(exec.name, exec.agent, exec.toolSet)
        if (found !== undefined) return found
      }
      return ctx.tools?.view?.(exec.agent)?.visible?.get?.(exec.name)
    } catch {
      return undefined
    }
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
  // tools through one. The session classifier follows and checks each parent itself.
  const botOfSession = (sessionId, agent, { followParents = true } = {}) => {
    let current = sessionId
    let header = followParents ? agent?.session?.header ?? headerOf(current) : undefined
    for (let depth = 0; typeof current === 'string' && depth < (followParents ? 32 : 1); depth += 1) {
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

  // Whether a Session is `bot`'s own chat (a part of it included) or a subagent under it, by the
  // same durable parent lineage as botOfSession; a group Session or a task run is not.
  const ownChatLineage = (sessionId, agent, bot) => {
    let current = sessionId
    let header = agent?.session?.header ?? headerOf(current)
    for (let depth = 0; typeof current === 'string' && depth < 32; depth += 1) {
      if (current === bot.id || rt.chatOwners?.get(current) === bot.id || current === rt.chatOf?.(bot.id)) return true
      if (rt.botOf(current) !== undefined || rt.selfOf(current) !== undefined || rt.state?.tasks?.[current] !== undefined) return false
      if (header?.origin !== 'subagent' || header.parentSession === undefined) return false
      current = header.parentSession
      header = headerOf(current)
    }
    return false
  }

  /**
   * Set (or refresh, or lift) the restriction on one Session against the Bot's current list.
   * @param {string} sessionId - the Session being resolved.
   * @param {object} agent - its live agent, the object DSH assembles tools for.
   */
  async function apply(sessionId, agent, knownBot) {
    if (typeof sessionId !== 'string' || agent === undefined) return
    const bot = knownBot ?? botOfSession(sessionId, agent)
    const wanted = deniedNames(bot, agent)
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
    // An implicit schedule, shell or launcher name this profile cannot restrict is not the
    // user's typo: the executor guard still refuses it, so there is nothing to report.
    const listed = new Set(Array.isArray(bot?.denyTools) ? bot.denyTools : [])
    const unknown = missing.filter(name => listed.has(name))
    if (unknown.length > 0) {
      warnOnce(sessionId, `ds-bot: ${bot?.name ?? 'a Bot'} denies ${unknown.join(', ')}, `
        + 'which this DSH does not serve or cannot restrict; ignored')
    }
    waiting.delete(sessionId)
    release(sessionId)
    if (deny.length === 0) {
      // The guard still refuses what cannot be restricted (a scope-local tool); keeping the
      // entry lets a later apply compare without lifting and re-setting it every time.
      held.set(sessionId, { agent, names: wanted })
      return
    }
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
   * @param {object} bot - the Bot record (its `denyTools` and `shell` are read live).
   */
  async function applyToolDeny(bot, extra = []) {
    if (bot === undefined || bot.shellHeld !== undefined) return
    const sessions = new Set([...rt.sessionsOfBot(bot.id), ...extra])
    for (const part of bot.segments ?? []) sessions.add(part.sessionId)
    // A group keeps its earlier parts under the room, beside the Bot's own history.
    for (const room of Object.values(rt.state?.rooms ?? {})) {
      for (const part of room.segments?.[bot.id] ?? []) sessions.add(part.sessionId)
    }
    await Promise.all([...sessions].map(async (sessionId) => {
      try { rt.assertShellChoice?.(sessionId) } catch { return }
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
      .then(() => {
        const sessionId = agent?.session?.id
        try { rt.assertShellChoice?.(sessionId) } catch { return }
        return apply(sessionId, agent)
      })
      .catch(error => rt.warn('ds-bot: tool deny on agent/created failed: %s', error))
  })

  // The last line: a call that reaches the executor for a name this Bot denies, or for any
  // tool that runs a command when the Bot has no shell, is refused whatever put it on the
  // surface.
  ctx.on('tools/execute', (exec, next) => {
    // A folder change can move a Session. Hold ownership through the permission retry
    // and the downstream folder change, starting before the guard resolves the owner.
    if (exec.agent === undefined || !changesWorkingFolder(exec)) return guardTool(exec, next)
    const leave = rt.enterOwnership?.()
    return guardTool(exec, next).finally(() => leave?.())
  })
  async function guardTool(exec, next) {
    // And none at all on a Session whose permission level was not set (permissions.js).
    try {
      rt.assertShellChoice?.(exec.agent?.session?.id ?? exec.agent?.id)
      await rt.levelHolds?.(exec)
    } catch (error) {
      if (error?.code === 'bot/refused') rt.noteStop?.(exec.agent?.id ?? exec.agent?.session?.id, { why: 'level', tool: exec.name, callId: exec.callId }, exec.agent)
      throw error
    }
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (name === '' || exec?.agent === undefined) return next()
    const bot = botOfSession(exec.agent?.id ?? exec.agent?.session?.id, exec.agent)
    if (bot === undefined) return rt.inToolCall === undefined ? next() : rt.inToolCall(exec, next)
    const launch = taskLaunchOf(exec, bot)
    if (launch !== undefined) {
      rt.noteStop?.(launch.sessionId, { why: launch.held.why, tool: name, callId: exec.callId, text: launch.held.text }, exec.agent)
      throw refusal(launch.held.text)
    }
    const denied = deniedNames(bot, exec.agent)
    // A tool registered after the last apply is caught here from its definition, so a
    // renamed or aliased shell tool never needs this plugin to know its name first.
    const shell = noShell(bot) && shellCall(name, exec.arguments, definitionOf(exec))
    if (!denied.includes(name) && !shell) {
      // A Solver's work call in its own chat dates its review mark (review-mark.js). A Bot with the
      // person's review guard on has its work refused there until its reviewer answers the plan
      // (review-guard.js). Only a Solver or a guarded Bot walks the lineage: every other Bot's call
      // skips it. The Session's folder is where a relative path lands (a write to the Solver's notes
      // file is not work).
      if (isSolverBot(bot) || bot.reviewGuard === true) {
        const { sessionId, base, own, definition, held } = reviewGuardOf(exec, bot, name)
        if (held !== undefined) {
          rt.noteStop?.(sessionId, { why: held.why, tool: name, callId: exec.callId, text: held.text }, exec.agent)
          throw refusal(held.text)
        }
        rt.reviewWork?.(bot, own, name, exec.arguments, definition, base)
      }
      return rt.inToolCall === undefined ? next() : rt.inToolCall(exec, next)
    }
    rt.noteStop?.(exec.agent?.id ?? exec.agent?.session?.id, { why: 'tool', tool: name, callId: exec.callId }, exec.agent)
    if (noShell(bot) && (shell || reachesShell(name) || SHELL_LAUNCHERS.has(name))) {
      throw refusal(`${bot.name} has no shell, so it cannot use the ${name} tool`)
    }
    throw refusal(`${bot.name} does not have the ${name} tool`)
  }

  // The review guard's answer for one call of a Solver or a guarded Bot (review-guard.js).
  function reviewGuardOf(exec, bot, name) {
    const sessionId = exec.agent?.id ?? exec.agent?.session?.id
    const base = exec.agent?.session === undefined ? undefined : rt.sessionFolder?.(exec.agent.session)
    const own = ownChatLineage(sessionId, exec.agent, bot)
    const definition = definitionOf(exec)
    return { sessionId, base, own, definition, held: rt.reviewGuardHolds?.(bot, own, name, exec.arguments, definition, base) }
  }

  // The same hold for `tools/pre-execute` (review-guard.js installAhead), with guardTool's own
  // preconditions: { held, sessionId } when the guard refuses the call, else undefined. A denied
  // name or a shell call without a shell is left to guardTool's refusal.
  function heldOfExec(exec) {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (name === '' || exec?.agent === undefined) return undefined
    const bot = botOfSession(exec.agent?.id ?? exec.agent?.session?.id, exec.agent)
    if (bot === undefined || (!isSolverBot(bot) && bot.reviewGuard !== true)) return undefined
    const launch = taskLaunchOf(exec, bot)
    if (launch !== undefined) return launch
    if (deniedNames(bot, exec.agent).includes(name)) return undefined
    if (noShell(bot) && shellCall(name, exec.arguments, definitionOf(exec))) return undefined
    const { sessionId, held } = reviewGuardOf(exec, bot, name)
    return held === undefined ? undefined : { held, sessionId }
  }

  function taskLaunchOf(exec, bot) {
    if (teamToolOf(exec.name) !== 'start_task') return undefined
    const held = rt.taskLaunchHold?.(bot.id)
    if (held !== undefined) return { held, sessionId: exec.agent?.id ?? exec.agent?.session?.id }
  }

  // Retries stop on a Session that leaves the team, so a lift is not attempted on a gone agent.
  Object.assign(rt, { botOfSession, ownChatLineage, applyToolDeny, applyToolDenyToAgent: apply, cleanDenyTools, unknownDenyTools, assertDenyTools })
  Object.assign(rt, { reviewGuardOfExec: heldOfExec })
}
