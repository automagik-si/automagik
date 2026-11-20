// The person's picks for Pocket chat (RFC 0014, `shown[]` in the home file): which project Bots
// a phone may open. Read from `$AUTOMAGIK_HOME/bots/bots.json`, always the registry home,
// whatever AUTOMAGIK_BOTS_HOME says. A global Bot (no project) needs no yes; a project Bot is
// shown only when an entry `{ project, machine?, bots: [id] }` for its project, on its machine,
// lists its id.
//
// It also links a DSH Bot to its registry Bot (#672): the id Pocket's Team needs to join a
// `dsh:<sessionId>` chat to the Bot it also shows from the registry. Only Herdr's `b-` ids are
// that key; a `session-<uuid>` entry is DSH's own and is not served. Read from the same home
// file and from this computer's project files (`projects[]` -> `<folder>/.automagik/bots/
// bots.json`): the Bot with the same id (the link DSH's own export keeps, RFC 0014 delivery 3),
// else the one with the same name: a project Bot only among its own project's Bots (a universal
// Bot is the project's main Bot under a `b-` id in its repo file), a global Bot among all of
// them. One match links; two or more, or none, give null, never a guess.
//
// Fails closed: with no file, nothing is picked and no Bot is linked. An unreadable file or one
// that does not parse serves the last good read, with a warn, else no project Bot is shown.
// Read again on every call (the file is capped at 1 MB), so a yes taken back holds at the next
// list, watch or write.
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { HOME_PATH, REPO_PATH, isBotId, parseRegistry } from '../shared/registry.js'
import { automagikHomeOf } from './folders.js'

/** The home file's path: `$AUTOMAGIK_HOME/bots/bots.json`. */
export const homeRegistryPathOf = (env = process.env) => join(automagikHomeOf(env.AUTOMAGIK_HOME), HOME_PATH)

/** Herdr's registry id (`b-` plus 10 base32): the key Pocket joins a DSH chat and a Bot by. */
const isRegistryId = id => isBotId(id) && id.startsWith('b-')
/** Names compare as DSH's `findBot` does: trimmed and lowercased. */
const nameKey = name => String(name ?? '').trim().toLowerCase()

const EMPTY = Object.freeze({ shown: [], bots: new Map(), registry: [], projects: [] })
/** A file that can't be read and no good read before it: nothing is known, nothing is shown. */
const UNKNOWN = Object.freeze({ shown: [], bots: null, registry: [], projects: [] })

/**
 * A reader of the home file's picks, per-Bot places and registry ids.
 * @param {{ path?: string, warn?: (...args: any[]) => void }} [options]
 * @returns {{ shown(bot: { id: string, project?: string | null, machine?: string | null }): boolean,
 *   places(): Map<string, { folder: string, machine?: string }> | null,
 *   bindingOf(botId: string): { listed: boolean, project?: string, machine?: string,
 *     picked(project: string, machine?: string): boolean } | undefined,
 *   registryIdOf(bot: { id: string, name?: string, project?: string | null }): string | null }}
 */
export function shownReader({ path = homeRegistryPathOf(), warn = () => {} } = {}) {
  let lastGood = null
  let lastError = null
  const read = () => {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      // No file: nothing is picked, and no earlier read stands in for it.
      if (error?.code === 'ENOENT') { lastGood = null; lastError = null; return EMPTY }
      return failed(error)
    }
    try {
      const { file } = parseRegistry(text, { kind: 'home' })
      const bots = new Map()
      const registry = []
      for (const bot of file.bots) {
        if (typeof bot.folder === 'string') bots.set(bot.id, { folder: bot.folder, ...(bot.machine !== undefined ? { machine: String(bot.machine) } : {}) })
        // A Bot on another machine is not this host's DSH Bot, whatever its name.
        if (bot.machine !== undefined || !isRegistryId(bot.id)) continue
        registry.push({ id: bot.id, name: bot.name, ...(typeof bot.folder === 'string' ? { folder: bot.folder } : {}) })
      }
      lastGood = { shown: file.shown, bots, registry, projects: file.projects }
      lastError = null
      return lastGood
    } catch (error) {
      return failed(error)
    }
  }
  const failed = (error) => {
    const message = String(error?.message ?? error)
    // Once per new error, not on every 2 s check of every watched chat.
    if (message !== lastError) {
      lastError = message
      warn(lastGood ? 'ds-bot: %s unreadable (%s); Pocket chat keeps its last good read' : 'ds-bot: %s unreadable (%s); no project Bot is shown in Pocket chat', path, message)
    }
    return lastGood ?? UNKNOWN
  }
  // A project file is read at most once per change: the link only needs its `b-` Bots, and a
  // listing asks per Bot. A missing or unreadable file contributes nothing (a project listed in
  // `projects[]` may have moved or not have a repo file yet).
  const repos = new Map()
  const repoBotsOf = (folder) => {
    const file = join(folder, REPO_PATH)
    let stat
    try { stat = statSync(file) } catch { return [] }
    const key = `${stat.mtimeMs}:${stat.size}`
    const cached = repos.get(file)
    if (cached?.key === key) return cached.bots
    let entries = []
    try {
      const { file: repo } = parseRegistry(readFileSync(file, 'utf8'), { kind: 'repo' })
      entries = repo.bots.filter(bot => isRegistryId(bot.id)).map(bot => ({ id: bot.id, name: bot.name, folder }))
    } catch { entries = [] }
    repos.set(file, { key, bots: entries })
    return entries
  }
  return {
    // Management uses one fresh snapshot, including rows the chat parser would discard.
    bindingOf(botId) {
      try {
        const { raw, file } = parseRegistry(readFileSync(path, 'utf8'), { kind: 'home' })
        const rows = raw.bots.filter(bot => bot?.id === botId)
        if (rows.length > 1) return undefined
        const row = rows[0]
        const bot = file.bots.find(bot => bot.id === botId)
        if (row && !bot) return undefined
        if (row && Object.hasOwn(row, 'machine') && (typeof row.machine !== 'string' || row.machine !== bot.machine)) return undefined
        return {
          listed: row !== undefined, project: bot?.folder, machine: bot?.machine,
          picked: (project, machine) => file.shown.some(entry => entry.project === project && entry.machine === machine && entry.bots.includes(botId)),
        }
      } catch {
        return undefined
      }
    },
    shown(bot) {
      // A Bot whose place could not be read may be a project Bot: never shown as global.
      if (bot?.placeUnknown === true) return false
      if (bot?.project == null) return true
      if (typeof bot.project !== 'string' || typeof bot.id !== 'string') return false
      const machine = bot.machine ?? null
      // Machine compared both ways: a pick on one machine never grants the same folder on another.
      return read().shown.some(entry => entry.project === bot.project && (entry.machine ?? null) === machine && entry.bots.includes(bot.id))
    },
    /**
     * Each home-file Bot with a folder: id -> { folder, machine? }, one read for all of them;
     * null when the file can't be read and there is no good read to fall back on.
     */
    places() {
      return read().bots
    },
    /**
     * The `b-` registry id of the registry Bot a DSH Bot is, or null: the same id first (DSH
     * exports its Bots under their id, RFC 0014 delivery 3), else the same name among the Bots
     * this computer knows (the home file's, and its projects' repo files). A Bot with a project
     * matches only the Bots in that project folder, so a namesake in another project never takes
     * its link; a global Bot (no project) links one same-named Bot and gives null for two. One
     * match links, anything else gives null, never a wrong Bot; a `session-<uuid>` entry is not
     * a registry id.
     * @param {{ id: string, name?: string, project?: string | null }} bot
     */
    registryIdOf(bot) {
      if (typeof bot?.id !== 'string') return null
      const known = read()
      const all = new Map()
      for (const entry of known.registry) all.set(entry.id, entry)
      for (const project of known.projects) {
        // Another machine's project file is not readable here, and a relative folder has no
        // root to read from: neither yields a link.
        if (typeof project?.folder !== 'string' || project.machine !== undefined || !isAbsolute(project.folder)) continue
        for (const entry of repoBotsOf(project.folder)) if (!all.has(entry.id)) all.set(entry.id, entry)
      }
      const byId = all.get(bot.id)
      if (byId) return byId.id
      const wanted = nameKey(bot.name)
      if (wanted === '') return null
      let matches = [...all.values()].filter(entry => nameKey(entry.name) === wanted)
      // A project Bot is never a namesake in another project: narrow to its own folder always.
      if (typeof bot.project === 'string') matches = matches.filter(entry => entry.folder === bot.project)
      return matches.length === 1 ? matches[0].id : null
    },
  }
}
