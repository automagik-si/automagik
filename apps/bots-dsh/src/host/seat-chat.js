// The rendered face of a seat on this computer (RFC 0022 delivery 1L): each orchestrator seat in
// the team's left bar opens as a chat, read from its own Herdr pane as it runs. Reads only: this
// module never sends to, types into, interrupts or answers a seat, and no orchestrator seat is
// reachable as a DSH tool or from an automation (RFC 0022 (f)). The writes are delivery 2L's and
// are not served here.
//
// - Local only. A seat is a registry Bot (`b-` id) in the team's home file whose Herdr terminal
//   is on this computer (`labels.bot`); an address naming a machine is refused before any call,
//   and no call carries `on`. Seats on another computer wait for RFC 0022's H.
// - Read what exists. The rows come from the one live-chat engine (`live-chat/`, a byte-equal
//   copy of the pack's) over the terminal's own transcript, else its screen; the status and the
//   waiting card come from herdr-core's report and the dialog reader. No row starts, stops or
//   restarts anything ((i), "Read, never run").
// - Kept in memory only. Watches live while a window watches and 10 minutes after (the engine's
//   LINGER_MS); no row is written to disk or logged.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from './live-chat/engine.js'
import { addressParts } from './live-chat/hc.js'
import { agentOf } from './live-chat/find.js'
import { statusOf as terminalStatusOf } from './live-chat/status.js'
import { homeRegistryPathOf } from './shown.js'
import { isBotId, parseRegistry } from '../shared/registry.js'

/** The endpoints this module serves on the team's `/api/omni-ui` route. All of them read. */
export const SEAT_ENDPOINTS = Object.freeze(['seat-chat-list', 'seat-chat-open', 'seat-chat-read', 'seat-chat-close'])
/** A window's own id: stable across a reload, so a re-open finds its watch and its own draft. */
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,64}$/
/** A local hc address: `t7`; one with a `/` names another machine and is never opened. */
const LOCAL_TERMINAL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** A window's watches kept at once (a bar opens one seat at a time; a leak closes its oldest). */
const MAX_WATCHES = 4

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

/** The bar's status word for one live terminal, from herdr-core's own report. */
export function seatStatusOf(terminal) {
  if (!terminal) return 'off'
  const status = terminalStatusOf(terminal)
  if (status.state === 'blocked') return 'needs'
  if (status.state === 'error') return 'error'
  if (status.state === 'working') return 'working'
  return 'idle'
}

/** This computer's own registry Bots: a `b-` id, and no machine (a linked bot is not a seat here). */
function readRegistry(path, warn) {
  try {
    const { file } = parseRegistry(readFileSync(path, 'utf8'), { kind: 'home' })
    const projects = (file.projects ?? []).filter(project => project && typeof project.folder === 'string' && project.machine === undefined)
    const bots = (file.bots ?? []).filter(bot => bot && typeof bot.id === 'string' && isBotId(bot.id) && bot.machine === undefined)
    return { bots, projects }
  } catch (error) {
    // No home file is a normal fresh install: no seats, and the bar shows the team it has.
    if (error?.code !== 'ENOENT') warn?.('omni-ui: seat chat could not read the registry: %s', error?.message ?? error)
    return { bots: [], projects: [] }
  }
}

/**
 * The seat chat: the listing, and one watch per window and seat. The engine is the one live-chat
 * engine; it is made here when the bar first asks, and closed with the runtime.
 */
export class SeatChat {
  constructor({ engine, registryPath, warn = () => {} }) {
    this.engine = engine
    this.registryPath = registryPath
    this.warn = warn
    /** @type {Map<string, Map<string, object>>} window -> terminal -> watch */
    this.watches = new Map()
  }

  /**
   * The team's seats as the bar reads them, in the home file's order: the registry Bot, its
   * project's name, the terminal on this computer that is it, and the status herdr-core reports.
   * A registry Bot with no live pane stays, as "Not running" ((d)); it opens no view.
   */
  async list() {
    // The engine's first snapshot is in (or its short wait is over): a just-loaded window lists
    // live statuses rather than every seat as "not running" until the next poll.
    await this.engine.ready()
    const { bots, projects } = readRegistry(this.registryPath, this.warn)
    const projectName = (folder) => (typeof folder === 'string' ? projects.find(project => project.folder === folder)?.name ?? null : null)
    const byBot = new Map()
    for (const terminal of this.engine.hub.all()) {
      if (typeof terminal?.address !== 'string' || addressParts(terminal.address).machine !== null) continue
      const id = typeof terminal.labels?.bot === 'string' ? terminal.labels.bot : null
      if (id !== null && !byBot.has(id)) byBot.set(id, terminal)
    }
    return bots.map((bot, order) => {
      const terminal = byBot.get(bot.id) ?? null
      const agent = terminal ? agentOf(terminal) : null
      return {
        id: bot.id,
        name: String(bot.name ?? '').trim() || bot.id,
        project: projectName(bot.folder),
        order,
        terminal: terminal ? terminal.address : null,
        agent,
        // A decoder reads the transcript; any other agent, dsh-tui included, reads its screen.
        chat: terminal ? (agent ? 'transcript' : 'screen') : null,
        status: seatStatusOf(terminal),
      }
    })
  }

  /** The seat this window may open, or a refusal: a local seat the registry lists and a pane runs. */
  async seatOf(terminal, { live = true } = {}) {
    if (typeof terminal !== 'string' || !LOCAL_TERMINAL.test(terminal) || addressParts(terminal).machine !== null) {
      throw refused('This seat is on another computer. It needs the scoped link (delivery H).')
    }
    const seat = (await this.list()).find(candidate => candidate.terminal === terminal)
    if (seat === undefined) throw refused('This terminal is not a seat on this computer.')
    if (live && seat.status === 'off') throw refused('This seat is not running on this computer.')
    return seat
  }

  watchOf(client, terminal) {
    return this.watches.get(client)?.get(terminal) ?? null
  }

  /**
   * A window opens a seat's face. The engine watches the terminal (read only); the answer is the
   * face as it stands now. Null when the engine holds its limit of terminals, every one watched.
   */
  async open(client, terminal) {
    const seat = await this.seatOf(terminal)
    if (!CLIENT_ID.test(String(client ?? ''))) throw refused('This window cannot open a seat.')
    const existing = this.watchOf(client, terminal)
    if (existing) return this.snapshot(seat, existing, { all: true })
    const owned = this.watches.get(client) ?? new Map()
    this.watches.set(client, owned)
    // One window might click through the bar: keep its oldest watch from holding a terminal.
    while (owned.size >= MAX_WATCHES) {
      const oldest = owned.keys().next().value
      owned.get(oldest)?.close()
      owned.delete(oldest)
    }
    const handle = this.engine.watch(terminal, client, () => {})
    if (!handle) {
      if (owned.size === 0) this.watches.delete(client)
      return null
    }
    owned.set(terminal, handle)
    return this.snapshot(seat, handle, { all: true })
  }

  /** The face since `after`: rows after the cursor (all of them when it is gone), status, card. */
  async read(client, terminal, after) {
    const seat = await this.seatOf(terminal, { live: false })
    const handle = this.watchOf(client, terminal)
    if (!handle) throw refused('This chat is not open in this window.')
    return this.snapshot(seat, handle, { after })
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
  close(client, terminal) {
    const owned = this.watches.get(client)
    if (!owned) return true
    if (terminal === undefined) {
      for (const handle of owned.values()) handle.close()
      this.watches.delete(client)
      return true
    }
    owned.get(terminal)?.close()
    owned.delete(terminal)
    if (owned.size === 0) this.watches.delete(client)
    return true
  }

  closeAll() {
    for (const client of [...this.watches.keys()]) this.close(client)
  }

  /** The runtime stops: every watch ends and the engine's own hc children go with it. */
  dispose() {
    this.closeAll()
    this.engine.close()
  }
}

/**
 * The runtime's seat chat, made on first use so a host without Herdr spawns nothing: the engine
 * spawns this computer's own `hc connect` only when the bar first lists the seats. Null when the
 * engine cannot be made; the bar then shows no seat and the team's own rows are unchanged.
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
    log('omni-ui: seat chat needs herdr-core (`hc`) on this computer; the bar lists no seat')
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
  let chat = null
  let made = false
  const seatChat = () => {
    if (chat) return chat
    if (made) return null
    made = true
    const engine = injected ?? engineFor(rt)
    if (engine) chat = new SeatChat({ engine, registryPath: path, warn: (...args) => rt.warn?.(...args) })
    return chat
  }
  const answer = (fn) => async (body) => {
    const seat = seatChat()
    if (!seat) throw refused('Seat chat is not available on this computer.')
    return fn(seat, body ?? {})
  }
  const offs = [
    rt.hooks.endpoint('seat-chat-list', answer(async (seat) => ({ seats: await seat.list() })), { read: true }),
    rt.hooks.endpoint('seat-chat-open', answer((seat, body) => seat.open(String(body.client ?? ''), body.terminal)), { read: true }),
    rt.hooks.endpoint('seat-chat-read', answer((seat, body) => seat.read(String(body.client ?? ''), body.terminal, body.after ?? null)), { read: true }),
    rt.hooks.endpoint('seat-chat-close', answer((seat, body) => ({ closed: seat.close(String(body.client ?? ''), body.terminal) })), { read: true }),
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
