// What other Omni plugins add to the team while it runs. The Omni channels and canvas
// plugins (@automagik/omni-channels-dsh, @automagik/omni-canvas-dsh) inject the runtime as
// the `omniTeam` service and add, through `rt.hooks` (apart from `rt.live`, the turns
// that run now, and the team view of channel.js):
//
//   endpoint(name, fn, { read })   one POST /api/omni-ui endpoint; `read` lets a host that
//                                  only reads the team (store.js) answer it too
//   view(fn)                       fields merged into the team view (revisioned)
//   sessionOwner(fn)               the team Bot and label of an external run Session
//   live(fn)                       fields merged into every state answer (no revision)
//   mainRules(fn, { order })       a part of the Main Bot's rules, text or nothing, inside
//                                  the bot-identity section (prompt.js)
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
const registrars = new WeakMap()
const windowEntries = new WeakSet()
export const isWindowEndpoint = entry => typeof entry === 'object' && entry !== null && windowEntries.has(entry)
export function windowEndpoint(rt, name, fn, { read = false } = {}) {
  const register = registrars.get(rt)
  // A test's stand-in runtime has no table of its own; its entries get no proof from the route.
  return register ? register(name, fn, read, true) : rt.hooks.endpoint(name, fn, { read })
}

export function install(rt) {
  const endpoints = new Map()
  const views = []
  const lives = []
  const sessionOwners = []
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

  // Frozen, so the entry another plugin gets from `endpointOf` cannot be given a new function.
  const register = (name, fn, read, window) => {
    if (endpoints.has(name)) throw new Error(`ds-bot: endpoint ${name} is already served`)
    const entry = Object.freeze({ fn, read: read === true })
    if (window) windowEntries.add(entry)
    endpoints.set(name, entry)
    return () => { if (endpoints.get(name) === entry) endpoints.delete(name) }
  }
  registrars.set(rt, register)
  rt.hooks = {
    endpoint: (name, fn, { read = false } = {}) => register(name, fn, read, false),
    view: fn => add(views, fn),
    sessionOwner: fn => add(sessionOwners, fn),
    live: fn => add(lives, fn),
    mainRules(fn, { order = 0 } = {}) {
      const dispose = add(rules, { fn, order })
      rules.sort((a, b) => a.order - b.order)
      return dispose
    },
    botModels(kind, source) {
      if (typeof kind !== 'string' || kind === '') throw new Error('ds-bot: a model menu needs a Bot kind')
      if (botModels.has(kind)) throw new Error(`ds-bot: the model menu of ${kind} Bots is already served`)
      if (typeof source?.snapshot !== 'function' || typeof source.pick !== 'function') throw new Error('ds-bot: a model menu needs snapshot() and pick()')
      botModels.set(kind, source)
      return () => { if (botModels.get(kind) === source) botModels.delete(kind) }
    },
  }

  // Apart from rt.hooks, on its own surface: rt.stepHooks.sendsOutside(fn), where fn({ tool, args })
  // is true for a step that sends to people outside the team (an Omni channel send). Such a step is
  // hard to undo: Auto never allows it by itself and every asking level asks the person (RFC 0031,
  // #1092). A hook that throws counts as true. The Bot team names no sender of its own.
  rt.stepHooks = { sendsOutside: fn => add(senders, fn) }
  rt.sendsOutside = step => senders.some(fn => {
    try { return fn({ tool: step.tool, args: step.args }) === true } catch { return true }
  })

  // What channel.js and prompt.js read.
  rt.extended = {
    endpointOf: name => (endpoints.has(name) ? endpoints.get(name) : undefined),
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
    view: () => merged(views),
    live: () => merged(lives),
    // The plugin that owns the model menu of a Bot kind, if one does.
    botModelsOf: kind => (typeof kind === 'string' ? botModels.get(kind) : undefined),
    // The parts for one Main Bot, in order; empty ones are left out.
    // One plugin's failing rule leaves the others, and the prompt, standing.
    rules: self => rules.map((rule) => {
      try {
        return rule.fn(self)
      } catch (error) {
        rt.warn?.('ds-bot: a Main Bot rule failed: %s', error?.message ?? error)
        return ''
      }
    }).filter(text => typeof text === 'string' && text !== ''),
  }
}
