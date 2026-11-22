// The rendered face of a seat on this computer (RFC 0022 delivery 1L): each orchestrator seat in
// the team's left bar opens as a chat, read from its own Herdr pane as it runs. Reads only: this
// module never sends to, types into, interrupts or answers a seat, and no orchestrator seat is
// reachable as a DSH tool or from an automation (RFC 0022 (f)). The writes are delivery 2L's and
// are not served here.
//
// - Only a confirmed local attach-ledger binding can open a seat. Remote picks can be listed,
//   but wait for RFC 0022's scoped link before they can be opened.
// - Read what exists. The rows come from the one live-chat engine (`live-chat/`, a byte-equal
//   copy of the pack's) over the terminal's own transcript, else its screen; the status and the
//   waiting card come from herdr-core's report and the dialog reader. No row starts, stops or
//   restarts anything ((i), "Read, never run").
// - Kept in memory only. Watches live while a window watches and 10 minutes after (the engine's
//   LINGER_MS); no row is written to disk or logged.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fromWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'
import { teamHomeOf } from './folders.js'
import { createEngine } from './live-chat/engine.js'
import { addressParts } from './live-chat/hc.js'
import { agentOf } from './live-chat/find.js'
import { statusOf as terminalStatusOf } from './live-chat/status.js'
import { homeRegistryPathOf } from './shown.js'
import { heldIn } from '../shared/attach-record.js'
import { appHomeOf, confirmPanes, readAttachLedger, readBarRegistry, seatProjectKey } from './bar-registry.js'
import { connectCore } from './code-core.js'

/** The endpoints this module serves on the team's `/api/omni-ui` route. All of them read. */
export const SEAT_ENDPOINTS = Object.freeze(['seat-chat-list', 'seat-chat-open', 'seat-chat-read', 'seat-chat-close'])
/** A window's own id: stable across a reload, so a re-open finds its watch and its own draft. */
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,64}$/
/** A local hc address: `t7`; one with a `/` names another machine and is never opened. */
const LOCAL_TERMINAL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** A window's watches kept at once (a bar opens one seat at a time; a leak closes its oldest). */
const MAX_WATCHES = 4

const refused = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })
const sameBinding = (binding, current) => binding.bot === current?.bot && binding.core === current.core
  && binding.terminal === current.terminal && binding.created_ms === current.created_ms
  && (binding.project ?? null) === (current.project ?? null)
  && binding.at === current.at && binding.by === current.by

/** The bar's status word for one live terminal, from herdr-core's own report. */
export function seatStatusOf(terminal) {
  if (!terminal) return 'off'
  const status = terminalStatusOf(terminal)
  if (status.state === 'blocked') return 'needs'
  if (status.state === 'error') return 'error'
  if (status.state === 'working') return 'working'
  return 'idle'
}

function seatRow(bot, order, front, terminal = null) {
  const agent = terminal ? agentOf(terminal) : null
  const folder = bot.folder ?? null
  const machine = bot.machine ?? null
  const main = bot.main === true
  return {
    id: bot.id,
    key: bot.key,
    name: bot.name,
    role: bot.role ?? null,
    project: bot.project ?? null,
    folder,
    machine,
    kind: folder === null ? 'global' : main ? 'main' : 'bot',
    main,
    front: front?.bot === bot.id && front.project === folder && (front.machine ?? null) === machine,
    order,
    terminal: terminal?.address ?? null,
    agent,
    chat: terminal ? (agent ? 'transcript' : 'screen') : null,
    status: seatStatusOf(terminal),
  }
}

async function listSeats(chat) {
  const registry = readBarRegistry({ homePath: chat.registryPath, warn: chat.warn })
  const seats = await chat.list({ registry })
  return {
    seats: [...seats, ...registry.remote.map((bot, index) => seatRow(bot, seats.length + index, registry.front))],
    front: registry.front,
  }
}

/** The local seats and the read-only engine watches each window has opened. */
export class SeatChat {
  constructor({ engine, registryPath, warn = () => {}, connect = connectCore, env = process.env, teamHome = teamHomeOf(env), teamFolder }) {
    this.engine = engine
    this.registryPath = registryPath
    this.warn = warn
    this.connect = connect
    this.env = env
    this.teamFolder = () => teamFolder?.() ?? join(teamHome, 'workspace')
    /** @type {Map<string, Map<string, object>>} window -> terminal -> watch */
    this.watches = new Map()
    this.pending = new Map()
    // Keep the binding even after the last window closes, while the engine can retain rows.
    this.opened = new Map()
    this.disposed = false
  }

  /**
   * The team's seats as the bar reads them, in the home file's order: the registry Bot, its
   * project's name, the terminal on this computer that is it, and the status herdr-core reports.
   * A registry Bot with no live pane stays, as "Not running" ((d)); it opens no view.
   */
  async list(options) {
    return (await this.listWithBindings(options)).map(({ seat }) => seat)
  }

  async listWithBindings({ registry = readBarRegistry({ homePath: this.registryPath, warn: this.warn }), fresh = false, requiredTerminal } = {}) {
    if (!registry.bots.length) return []
    const { fold } = readAttachLedger({ appHome: appHomeOf(this.env), warn: this.warn })
    const bindings = new Map()
    const workspace = this.teamFolder()
    const roots = [...registry.roots, workspace]
    const matches = new Map()
    for (const bot of registry.bots) {
      const binding = fold && heldIn(fold, bot.id, null)
      if (!binding) continue
      // Compare each binding against the key for its selected folder, even when the id is unique.
      if (bot.folder === undefined && binding.project == null) {
        bindings.set(bot.id, binding)
        continue
      }
      const folder = bot.folder ?? workspace
      if (!matches.has(folder)) matches.set(folder, await seatProjectKey(folder, this.env, roots))
      const key = matches.get(folder)
      if (key !== null && key !== 'missing' && binding.project === key) bindings.set(bot.id, binding)
    }
    const keys = [...matches.values()].filter(key => key !== null && key !== 'missing')
    const confirmed = await confirmPanes({ env: this.env, connect: this.connect, bindings, roots: [...roots, ...keys], fresh })
    if (confirmed === null && requiredTerminal !== undefined
      && [...bindings.values()].some(binding => binding.terminal === requiredTerminal)) {
      throw refused('The terminal could not be reached', 'bot/unavailable')
    }
    return registry.bots.map((bot, order) => {
      const terminal = confirmed?.get(bot.id)
      return {
        seat: seatRow({ ...bot, project: registry.projectNames[bot.folder] }, order, registry.front, terminal),
        binding: terminal ? bindings.get(bot.id) : null,
      }
    })
  }

  /** The seat this window may open, or a refusal: a local seat the registry lists and a pane runs. */
  async seatOf(terminal) {
    if (typeof terminal !== 'string' || !LOCAL_TERMINAL.test(terminal) || addressParts(terminal).machine !== null) {
      throw refused('This seat is on another computer. It needs the scoped link (delivery H).')
    }
    const current = (await this.listWithBindings({ fresh: true, requiredTerminal: terminal })).find(({ seat }) => seat.terminal === terminal)
    if (current === undefined) throw refused('This terminal is not a seat on this computer.')
    return current
  }

  watchOf(client, terminal) {
    return this.watches.get(client)?.get(terminal) ?? null
  }

  discard(terminal, { keepPending = false } = {}) {
    if (keepPending) {
      for (const [client, watches] of this.watches) {
        const watch = watches.get(terminal)
        if (watch) this.close(client, terminal, watch.generation)
      }
    } else {
      for (const client of new Set([...this.watches.keys(), ...this.pending.keys()])) this.close(client, terminal)
    }
    this.opened.delete(terminal)
    this.engine.drop(terminal)
  }

  async confirmWatch(terminal, stillCurrent) {
    try {
      return await this.seatOf(terminal)
    } catch (error) {
      if (error?.code !== 'bot/unavailable' && this.opened.has(terminal) && stillCurrent()) this.discard(terminal)
      throw error
    }
  }

  bindingStillPicked(seat, binding) {
    // The selected folder must still be the one resolved by Git before confirmation.
    const { bots } = readBarRegistry({ homePath: this.registryPath, warn: this.warn })
    const bot = bots.find(bot => bot.id === binding.bot)
    if (!bot || (bot.folder ?? null) !== seat.folder) return false
    const { fold } = readAttachLedger({ appHome: appHomeOf(this.env), warn: this.warn })
    return Boolean(fold && sameBinding(binding, heldIn(fold, bot.id, null)))
  }

  hubMatches(terminal, binding) {
    const current = this.engine.hub.current(terminal)
    return current?.created_ms === binding.created_ms && current.state !== 'finished'
  }

  /**
   * A window opens a seat's face. The engine watches the terminal (read only); the answer is the
   * face as it stands now. Null when the engine holds its limit of terminals, every one watched.
   */
  async open(client, terminal) {
    if (typeof client !== 'string' || !CLIENT_ID.test(client)) throw refused('This window cannot open a seat.')
    const opened = this.opened.get(terminal)
    const pending = this.pending.get(client) ?? new Map()
    const generation = randomUUID()
    pending.set(terminal, generation)
    this.pending.set(client, pending)
    const stillPending = () => !this.disposed && pending.get(terminal) === generation
    try {
      const { seat, binding } = await this.confirmWatch(terminal, () => stillPending() && this.opened.get(terminal) === opened)
      const stillCurrent = () => {
        const current = this.opened.get(terminal)
        return stillPending() && (current === opened || sameBinding(binding, current))
      }
      if (!stillCurrent()) throw refused('This chat is not open in this window.')
      if (!this.engine.hub.current(terminal)) {
        await this.engine.hub.ready?.()
        if (!stillCurrent()) throw refused('This chat is not open in this window.')
      }
      if (!this.hubMatches(terminal, binding) || !this.bindingStillPicked(seat, binding)) {
        this.discard(terminal)
        throw refused('This seat is not running on this computer.')
      }
      const current = this.opened.get(terminal)
      if (current && !sameBinding(binding, current)) {
        this.discard(terminal, { keepPending: true })
      }
      const owned = this.watches.get(client) ?? new Map()
      this.watches.set(client, owned)
      let handle = owned.get(terminal)?.handle
      if (!handle) {
        // One window might click through the bar: keep its oldest watch from holding a terminal.
        while (owned.size >= MAX_WATCHES) this.close(client, owned.keys().next().value)
        handle = this.engine.watch(terminal, client, () => {})
      }
      if (!handle) {
        if (owned.size === 0) this.watches.delete(client)
        return null
      }
      if (!this.opened.has(terminal)) this.opened.set(terminal, binding)
      owned.set(terminal, { generation, handle })
      return { ...this.snapshot(seat, handle, { all: true }), generation }
    } finally {
      if (pending.get(terminal) === generation) pending.delete(terminal)
      if (pending.size === 0 && this.pending.get(client) === pending) this.pending.delete(client)
    }
  }

  /** The face since `after`: rows after the cursor (all of them when it is gone), status, card. */
  async read(client, terminal, after) {
    if (typeof client !== 'string' || !CLIENT_ID.test(client)) throw refused('This window cannot open a seat.')
    const watch = this.watchOf(client, terminal)
    if (!watch) throw refused('This chat is not open in this window.')
    const opened = this.opened.get(terminal)
    const stillCurrent = () => !this.disposed && this.watchOf(client, terminal) === watch
      && this.opened.get(terminal) === opened
    const { seat, binding } = await this.confirmWatch(terminal, stillCurrent)
    if (!stillCurrent()) throw refused('This chat is not open in this window.')
    if (!sameBinding(binding, opened) || !this.hubMatches(terminal, binding) || !this.bindingStillPicked(seat, binding)) {
      this.discard(terminal)
      throw refused('This seat is not running on this computer.')
    }
    return this.snapshot(seat, watch.handle, { after })
  }

  snapshot(seat, handle, { after, all = false } = {}) {
    let rows = all ? handle.rows() : handle.rows(after)
    const reset = rows === null
    if (reset) rows = handle.rows()
    return {
      seat,
      reset,
      rows,
      screen: handle.screen(),
      status: handle.status(),
      approval: handle.approval(),
      question: handle.question(),
    }
  }

  /** A window leaves a seat (or every seat): looking stops, the rows stay 10 minutes. */
  close(client, terminal, generation) {
    if (terminal === undefined && generation !== undefined) return true
    const pending = this.pending.get(client)
    if (terminal === undefined) pending?.clear()
    else if (generation === undefined || pending?.get(terminal) === generation) pending?.delete(terminal)
    if (pending?.size === 0) this.pending.delete(client)
    const owned = this.watches.get(client)
    if (!owned) return true
    if (terminal === undefined) {
      for (const { handle } of owned.values()) handle.close()
      this.watches.delete(client)
      return true
    }
    const watch = owned.get(terminal)
    if (watch && (generation === undefined || watch.generation === generation)) {
      watch.handle.close()
      owned.delete(terminal)
    }
    if (owned.size === 0) this.watches.delete(client)
    return true
  }

  closeAll() {
    for (const client of new Set([...this.watches.keys(), ...this.pending.keys()])) this.close(client)
  }

  /** The runtime stops: every watch ends and the engine's own hc children go with it. */
  dispose() {
    this.disposed = true
    this.closeAll()
    this.opened.clear()
    this.engine.close()
  }
}

/**
 * The chat engine is made on first open. Listing uses the registry, ledger and framed core
 * independently of the engine.
 */
export function hcAvailable(hcPath) {
  // One check, not a retry loop: without herdr-core nothing here listens, and a host that has no
  // `hc` (a server image) must not spawn a missing child every few seconds. Installing it later
  // needs a plugin reload, as a new Herdr does.
  try {
    const found = spawnSync(hcPath, ['--version'], { timeout: 2500, stdio: 'ignore', shell: process.platform === 'win32' })
    return found.error === undefined && found.status === 0
  } catch {
    return false
  }
}

function engineFor(rt) {
  const appHome = process.env.HERDR_APP_HOME?.startsWith('/') ? process.env.HERDR_APP_HOME : join(homedir(), '.config/herdr-app')
  const log = (...args) => rt.warn?.(...args)
  const hcPath = process.env.OMNI_SEAT_CHAT_HC || 'hc'
  if (!hcAvailable(hcPath)) {
    log('omni-ui: seat chat needs herdr-core (`hc`) on this computer; the chat face is unavailable')
    return null
  }
  try {
    return createEngine({ home: homedir(), appHome, hcPath, env: process.env, log })
  } catch (error) {
    log('omni-ui: seat chat is off: %s', error?.message ?? error)
    return null
  }
}

/**
 * Wire the seat chat when the runtime holds a home registry path (always) and herdr-core answers
 * when asked. Every endpoint reads; none is a tool. A host that only reads the team answers them
 * too (`read: true`).
 */
export function install(rt, { engine: injected } = {}) {
  const path = rt.registryPath ?? homeRegistryPathOf()
  const options = {
    registryPath: path, teamHome: rt.home, warn: (...args) => rt.warn?.(...args),
    teamFolder: () => rt.teamFolder?.() ?? rt.defaultTeamFolder?.(),
  }
  let chat = null
  let made = false
  const seatChat = () => {
    if (chat) return chat
    if (made) return null
    made = true
    const engine = injected ?? engineFor(rt)
    if (engine) chat = new SeatChat({ ...options, engine })
    return chat
  }
  // `windowSeen` must be the shared route's proof (desktop-window.js), never a caller's `true`.
  const answer = (fn, { screen = false } = {}) => async (body, _signal, windowSeen = false) => {
    if (screen && !fromWindow(windowSeen)) throw refused('desktop-only')
    const seat = seatChat()
    if (!seat) throw refused('Seat chat is not available on this computer.')
    return fn(seat, body ?? {})
  }
  const offs = [
    windowEndpoint(rt, 'seat-chat-list', async (_body, _signal, windowSeen) => {
      if (!fromWindow(windowSeen)) throw refused('desktop-only')
      return listSeats(chat ?? new SeatChat(options))
    }, { read: true }),
    windowEndpoint(rt, 'seat-chat-open', answer((seat, body) => seat.open(String(body.client ?? ''), body.terminal), { screen: true }), { read: true }),
    windowEndpoint(rt, 'seat-chat-read', answer((seat, body) => seat.read(String(body.client ?? ''), body.terminal, body.after ?? null), { screen: true }), { read: true }),
    windowEndpoint(rt, 'seat-chat-close', answer((seat, body) => ({
      closed: seat.close(String(body.client ?? ''), body.terminal, body.generation ?? ''),
    }), { screen: true }), { read: true }),
  ]
  if (typeof rt.ctx?.effect === 'function') {
    rt.ctx.effect(() => () => {
      for (const off of offs) off()
      chat?.dispose()
      chat = null
    }, 'omni-ui: seat chat')
  }
  return () => {
    for (const off of offs) off()
    chat?.dispose()
    chat = null
  }
}

// What the engine reads (a transcript's tail) is the owner's; no row is logged or written here.
