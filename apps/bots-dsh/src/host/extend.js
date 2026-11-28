// What other Omni plugins add to the team while it runs. The Omni channels and canvas
// plugins (@automagik/omni-channels-dsh, @automagik/omni-canvas-dsh) inject the runtime as
// the `omniTeam` service and add, through `rt.hooks` (apart from `rt.live`, the turns
// that run now, and the team view of channel.js):
//
//   endpoint(name, fn, { read })   one POST /api/omni-ui endpoint; `read` lets a host that
//                                  only reads the team (store.js) answer it too
//   around(name, fn)               wrap a plugin endpoint with fn(body, signal, next)
//                                  next(nextBody = body) serves it once during that call
//   view(fn)                       fields merged into the team view (revisioned)
//   sessionOwner(fn)               the team Bot and label of an external run Session
//   live(fn)                       fields merged into every state answer (no revision)
//   mainRules(fn, { order })       a part of the Main Bot's rules, text or nothing, inside
//                                  the bot-identity section (prompt.js)
//   rules(scope, fn, { order })   a rule for a Bot with the given position and/or role;
//                                  fn(botId, sessionId) returns text or nothing
//   botModels(kind, source)        the model menu of the Bots of one kind, owned by the
//                                  plugin that hosts them (host-models.js has the shape)
//   genui.publish(batchId, row)    one row of a live kit card, merged into the slice every
//                                  state answer carries (genui.js has the shape and the cap)
//   media.register(name, fn)       bytes a kit card shows, served by the kit's media route
//
// Each returns its disposer, so a plugin that stops takes what it added with it. Hooks
// are read at run time, never during install.
//
// The team's own window-only endpoints (the seat chat's reads, the Code tree, automations)
// register through `windowEndpoint`, which is not on `rt`: only those get the route's proof of
// the desktop window (desktop-window.js). An endpoint added through `rt.hooks` never does.
import { isPromise } from 'node:util/types'
import { OMNI_KIND } from './roster.js'
import { BUILTIN_ROLES, genieDetached, isRoleId, isRoleVersion } from '../shared/roles.js'

const registrars = new WeakMap()
const windowEntries = new WeakSet()
const legacyMainOrOmni = Symbol('legacy Main or Omni')
export const isWindowEndpoint = entry => typeof entry === 'object' && entry !== null && windowEntries.has(entry)
export function windowEndpoint(rt, name, fn, { read = false } = {}) {
  const register = registrars.get(rt)
  // A test's stand-in runtime has no table of its own; its entries get no proof from the route.
  return register ? register(name, fn, read, true) : rt.hooks.endpoint(name, fn, { read })
}

export function install(rt) {
  const endpoints = new Map()
  const around = new Map()
  const views = []
  const lives = []
  const sessionOwners = []
  let sessionOwnersRevision = 0
  const senders = []
  const rules = []
  const botModels = new Map()
  const add = (list, item) => {
    list.push(item)
    return () => {
      const at = list.indexOf(item)
      if (at !== -1) list.splice(at, 1)
    }
  }
  const addRule = (scope, fn, order) => {
    const dispose = add(rules, { scope, fn, order })
    rules.sort((a, b) => a.order - b.order)
    return dispose
  }
  const collectRules = (matches, botId, sessionId) => rules.filter(matches).map(({ scope, fn }) => {
    try {
      if (scope === legacyMainOrOmni) return fn(botId)
      return fn(botId, sessionId)
    } catch (error) {
      rt.warn?.(scope === legacyMainOrOmni ? 'ds-bot: a Main Bot rule failed: %s' : 'ds-bot: a Bot rule failed: %s', error?.message ?? error)
      return ''
    }
  }).filter(text => typeof text === 'string' && text !== '')
  // Views and lives merge in the order they were added; a hook that fails leaves its
  // fields out rather than the whole answer.
  const merged = list => Object.assign({}, ...list.map((fn) => {
    try {
      return fn() ?? {}
    } catch (error) {
      rt.warn?.('ds-bot: a team view hook failed: %s', error?.message ?? error)
      return {}
    }
  }))
  const readSessionOwners = sessionId => {
    const revision = sessionOwnersRevision
    const owners = []
    for (const fn of sessionOwners.slice()) {
      try {
        const owner = fn(sessionId)
        if (owner === undefined) continue
        if (isPromise(owner)) {
          void owner.catch(() => {})
          return undefined
        }
        if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return undefined
        const { botId, label } = owner
        if (typeof botId !== 'string' || (label !== undefined && typeof label !== 'string')) return undefined
        owners.push({ botId, label })
      } catch { return undefined }
    }
    return sessionOwnersRevision === revision ? owners : undefined
  }

  // Frozen, so the entry another plugin gets from `endpointOf` cannot be given a new function.
  const register = (name, fn, read, window) => {
    if (endpoints.has(name)) throw new Error(`ds-bot: endpoint ${name} is already served`)
    const entry = Object.freeze({ fn, read: read === true })
    if (window) windowEntries.add(entry)
    endpoints.set(name, entry)
    return () => { if (endpoints.get(name) === entry) endpoints.delete(name) }
  }
  registrars.set(rt, register)
  const roles = new Map()
  const toolOwners = new Map()
  const changedRoles = () => {
    rt.roleRuntime?.reconcile()
    rt.syncScopedTools?.()
    rt.reapplyToolMasks?.()
  }
  rt.roleRegistry = {
    of: id => roles.get(id),
    all: () => [...roles.values()].sort((a, b) => a.order - b.order),
    toolsWithheldFrom(bot) {
      const withheld = new Set(genieDetached(bot, rt.state.prefs) ? BUILTIN_ROLES.genie.tools : [])
      for (const [tool, owners] of toolOwners) {
        const held = bot ? rt.roleRuntime?.heldsOf(bot.id) ?? [] : []
        const registry = held.some(entry => entry.pin.source === 'registry' && owners.has(entry.pin.id)
          && entry.record.tools.includes(tool))
        const catalog = held.some(entry => entry.pin.source === undefined
          && entry.runtime?.tools.some(candidate => candidate.definition.name === tool))
        const genie = owners.has('genie') && BUILTIN_ROLES.genie.tools.includes(tool)
          && bot?.kind === 'genie' && !genieDetached(bot, rt.state.prefs)
        if (registry || catalog || genie) withheld.delete(tool)
        else withheld.add(tool)
      }
      return [...withheld]
    },
  }
  rt.hooks = {
    role(def) {
      const strings = list => Array.isArray(list) && list.every(item => typeof item === 'string' && item.length)
        && new Set(list).size === list.length
      const { id, name, version = '1.0.0', tools = [], capabilities = [], prompt, attachable = true, order = 0 } = def ?? {}
      if (!isRoleId(id) || typeof name !== 'string' || !name.trim() || !isRoleVersion(version)
        || !strings(tools) || !strings(capabilities) || (prompt !== undefined && !['string', 'function'].includes(typeof prompt))
        || !['boolean', 'function'].includes(typeof attachable) || !Number.isFinite(order) || roles.has(id)) throw new Error('Invalid or duplicate Bot role provider')
      const role = Object.freeze({ id, name, version, tools: Object.freeze([...tools]),
        capabilities: Object.freeze([...capabilities]), prompt, attachable, order })
      roles.set(id, role)
      for (const tool of tools) {
        if (!toolOwners.has(tool)) toolOwners.set(tool, new Set())
        toolOwners.get(tool).add(id)
      }
      changedRoles()
      return () => {
        if (roles.get(id) !== role) return
        roles.delete(id)
        changedRoles()
      }
    },
    endpoint: (name, fn, { read = false } = {}) => register(name, fn, read, false),
    around(name, fn) {
      if (around.has(name)) throw new Error(`ds-bot: endpoint ${name} is already wrapped`)
      const entry = { fn }
      around.set(name, entry)
      return () => { if (around.get(name) === entry) around.delete(name) }
    },
    view: fn => add(views, fn),
    sessionOwner: fn => {
      const dispose = add(sessionOwners, fn)
      sessionOwnersRevision += 1
      return () => { dispose(); sessionOwnersRevision += 1 }
    },
    live: fn => add(lives, fn),
    mainRules: (fn, { order = 0 } = {}) => addRule(legacyMainOrOmni, fn, order),
    rules(scope, fn, { order = 0 } = {}) {
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)
        || Object.keys(scope).some(key => key !== 'position' && key !== 'role')) throw new Error('ds-bot: unknown rule selector')
      const { position, role } = scope
      if (position !== undefined && position !== 'chief') throw new Error(`ds-bot: unknown rule position ${position}`)
      if (role !== undefined && (typeof role !== 'string' || role === '')) throw new Error('ds-bot: a rule role needs an id')
      return addRule({ position, role }, fn, order)
    },
    botModels(kind, source) {
      if (typeof kind !== 'string' || kind === '') throw new Error('ds-bot: a model menu needs a Bot kind')
      if (botModels.has(kind)) throw new Error(`ds-bot: the model menu of ${kind} Bots is already served`)
      if (typeof source?.snapshot !== 'function' || typeof source.pick !== 'function') throw new Error('ds-bot: a model menu needs snapshot() and pick()')
      botModels.set(kind, source)
      return () => { if (botModels.get(kind) === source) botModels.delete(kind) }
    },
  }

  // rt.stepHooks.sendsOutside(fn) classifies steps that send to people outside the team (an Omni
  // channel send). The classifier receives { tool, args, sessionId }. The Session id is a string,
  // or undefined when the caller has no Session, so a plugin can keep its rules for its own Sessions.
  // Auto never allows such a step by itself and every asking level asks the person (RFC 0031,
  // #1092). A hook that throws counts as true. The Bot team names no sender of its own.
  rt.stepHooks = { sendsOutside: fn => add(senders, fn) }
  rt.sendsOutside = (step, sessionId) => senders.some(fn => {
    try { return fn({ tool: step.tool, args: step.args, sessionId }) === true } catch { return true }
  })

  // What channel.js and prompt.js read.
  rt.extended = {
    endpointOf: name => (endpoints.has(name) ? endpoints.get(name) : undefined),
    aroundOf: name => around.get(name)?.fn,
    endpointNames: () => [...endpoints.keys()],
    sessionOwner(sessionId) {
      for (const fn of sessionOwners) {
        try {
          const owner = fn(sessionId)
          if (owner && rt.botOf?.(owner.botId) !== undefined) return { botId: owner.botId, label: String(owner.label ?? '').trim().slice(0, 80) }
        } catch (error) {
          rt.warn?.('ds-bot: a Session owner hook failed: %s', error?.message ?? error)
        }
      }
      return undefined
    },
    // A drop can certify exclusivity only when the registered hooks read cleanly.
    sessionOwnerRead(sessionId) {
      const owners = readSessionOwners(sessionId)
      return owners === undefined ? 'unreadable' : owners.length === 0 ? 'free' : 'owned'
    },
    // The execution boundary needs a stable identity or a verified absence.
    sessionBotOwner(sessionId) {
      if (sessionOwners.length === 0) return null
      const owners = readSessionOwners(sessionId)
      if (owners === undefined) return undefined
      const again = readSessionOwners(sessionId)
      if (again?.length !== owners.length
        || owners.some(({ botId, label }, i) => again[i].botId !== botId || again[i].label !== label)
        || rt.teamCurrent?.() !== true) return undefined
      if (owners.length === 0) return null
      const { botId } = owners[0]
      if (owners.some(owner => owner.botId !== botId)) return undefined
      return rt.botOf?.(botId) === undefined ? undefined : botId
    },
    view: () => merged(views),
    live: () => merged(lives),
    // The plugin that owns the model menu of a Bot kind, if one does.
    botModelsOf: kind => (typeof kind === 'string' ? botModels.get(kind) : undefined),
    // The prompt still selects legacy Main and Omni Bots before calling this reader.
    rules: self => collectRules(({ scope }) => scope === legacyMainOrOmni, self),
    rulesFor(botId, sessionId) {
      const bot = rt.botOf?.(botId)
      if (!bot) return []
      return collectRules(({ scope }) => {
        if (scope === legacyMainOrOmni) return rt.isMain?.(botId) === true || bot.kind === OMNI_KIND
        // The position and role readers can arrive after the hook registration.
        return (scope.position === undefined || rt.isChief?.(botId) === true)
          && (scope.role === undefined || rt.hasRole?.(botId, scope.role) === true)
      }, botId, sessionId)
    },
  }
}
