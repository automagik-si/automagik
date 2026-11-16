// The Code side's pure part: what the pane store's answers mean for one Bot, without React,
// the DOM or the bundle's stylesheet. The view (code-side.js) and its tests share these.

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

/** The four status words the host sends, as keys the view localizes. */
export const STATUS_WORDS = Object.freeze(['working', 'needs-you', 'idle', 'not-running'])
/** One status as its key, falling back to idle for a word this version does not know. */
export const statusKey = status => (STATUS_WORDS.includes(status) ? status : 'idle')
