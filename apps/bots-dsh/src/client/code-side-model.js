// The Code side's pure part: what the pane store's answers mean for one Bot, without React,
// the DOM or the bundle's stylesheet. The view (code-side.js) and its tests share these.

export { validGrid } from '../shared/code-grid.js'

export const MAX_PANES = 4

/** A Bot's row in the tree, or null. */
export function botRowOf(tree, botId) {
  for (const project of tree?.projects ?? []) {
    const bot = project.bots.find(candidate => candidate.id === botId)
    if (bot) return bot
  }
  return null
}

/** Whether the open Bot has anything to show in Terminal: its own seat or a worker's pane. */
export function codeHasPane(tree, botId) {
  const bot = botRowOf(tree, botId)
  return Boolean(bot && (bot.terminal || bot.workers.length > 0))
}

/** The pane a face should open for a Bot: its seat, else its first worker, else null. */
export function paneFor(tree, botId) {
  const bot = botRowOf(tree, botId)
  if (!bot) return null
  if (bot.terminal) return { botId: bot.id, worker: null }
  if (bot.workers.length > 0) return { botId: bot.id, worker: bot.workers[0].terminal }
  return null
}

/** A selection that still names a pane in `tree`, else null. */
export function stillThere(selected, tree) {
  if (!selected || !tree?.projects) return null
  const bot = botRowOf(tree, selected.botId)
  if (!bot) return null
  if (selected.worker === null || selected.worker === undefined) return bot.terminal ? { botId: bot.id, worker: null } : null
  return bot.workers.some(worker => worker.terminal === selected.worker) ? { botId: bot.id, worker: selected.worker } : null
}

/** The terminal a row names and the title shown over it. */
export function paneDetails(pane, tree) {
  const bot = pane && botRowOf(tree, pane.botId)
  if (!bot) return null
  if (pane.worker == null) return bot.terminal ? { terminal: bot.terminal.id, title: bot.name } : null
  const worker = bot.workers.find(candidate => candidate.terminal === pane.worker)
  return worker ? { terminal: worker.terminal, title: `${bot.name} · ${worker.role ?? worker.agent ?? worker.terminal}` } : null
}

export function togglePane(list, pane, tree, max = MAX_PANES) {
  const selected = stillThere(pane, tree)
  if (!selected) return { list }
  const terminal = paneDetails(selected, tree).terminal
  const index = list.findIndex(candidate =>
    (candidate.botId === selected.botId && (candidate.worker ?? null) === selected.worker)
    || (terminal && paneDetails(candidate, tree)?.terminal === terminal))
  if (index !== -1) return { list: list.filter((_, at) => at !== index) }
  if (list.length >= max) return { list, refused: list.map(candidate => paneDetails(candidate, tree)?.title).filter(Boolean) }
  return { list: [...list, selected] }
}

export function prunePanes(list, tree) {
  const unique = []
  const seen = new Set()
  for (const pane of list) {
    const selected = stillThere(pane, tree)
    if (!selected) continue
    const terminal = paneDetails(selected, tree).terminal
    const key = terminal ?? `${selected.botId}:${selected.worker ?? 'seat'}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(selected)
  }
  return unique
}

/** The four status words the host sends, as keys the view localizes. */
export const STATUS_WORDS = Object.freeze(['working', 'needs-you', 'idle', 'not-running'])
/** One status as its key, falling back to idle for a word this version does not know. */
export const statusKey = status => (STATUS_WORDS.includes(status) ? status : 'idle')
