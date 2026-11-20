export const initialMember = {
  bots: [], byId: Object.create(null), botId: null, pages: [], cursor: null,
  generation: 0, loading: false, failed: false, withdrawn: false,
}

export function selectBot(view, botId, withdrawn = false) {
  return {
    ...view, botId, withdrawn, generation: view.generation + 1,
    pages: [], cursor: null, loading: false, failed: false,
  }
}

export function updateRoster(view, bots) {
  const byId = Object.fromEntries(bots.map(bot => [bot.id, bot]))
  const next = { ...view, bots, byId }
  if (view.botId !== null && Object.hasOwn(byId, view.botId)) return next
  if (view.botId !== null) return selectBot(next, null, true)
  return view.withdrawn || bots.length === 0 ? next : selectBot(next, bots[0].id)
}

export const requestView = ({ generation, botId }) => ({ generation, botId })
export const isCurrent = (view, request) => view.generation === request.generation && view.botId === request.botId
export const changedBot = (view, request, botId) => isCurrent(view, request) && view.botId === botId

export function applyPage(view, request, page, earlier) {
  if (!isCurrent(view, request)) return view
  const items = Array.isArray(page.items) ? page.items : []
  return {
    ...view, pages: earlier ? [...view.pages, items] : [items], cursor: page.cursor,
    loading: false, failed: false,
  }
}

export const feedEnded = view => selectBot(view, view.botId, view.withdrawn)
export const pageRows = pages => pages.map((items, page) =>
  items.map((row, index) => ({ row, key: `${page}:${index}` }))).reverse().flat()

export function botLabels(bots) {
  const counts = new Map()
  for (const { name } of bots) counts.set(name, (counts.get(name) ?? 0) + 1)
  return new Map(bots.map(({ id, name }) => [id, counts.get(name) > 1 ? `${name} · ${id}` : name]))
}
