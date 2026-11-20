// A Bot's proposed change to a Bot's setup (propose_bot_change, host/tools.js), drawn as a card
// with Apply (settings-card.js). The host checks and resolves the values (the model's and the
// level's ids, the folder's full path) and writes them on the result's last line, so the card
// shows and saves exactly what was checked, not what the Bot typed.

// The fields a proposal may carry, as the Bot's form saves them and as the tool takes them.
// What only the user may set (denied tools, private, browser grants) is left out on purpose:
// a Bot must not be able to pre-fill a card that loosens its own limits.
export const PROPOSAL_FIELDS = [
  ['name', 'name'], ['role', 'role'], ['instructions', 'instructions'],
  ['workDir', 'work_dir'], ['model', 'model'], ['effort', 'effort'],
]
const KEYS = new Set(PROPOSAL_FIELDS.map(([key]) => key))
const MARK = 'proposal: '

export const proposalLine = proposal => `${MARK}${JSON.stringify(proposal)}`

// The proposal on a result's last line, or undefined for a refusal or a line that is not one.
export function parseProposal(text) {
  const last = String(text ?? '').split('\n').at(-1) ?? ''
  if (!last.startsWith(MARK)) return undefined
  let value
  try { value = JSON.parse(last.slice(MARK.length)) } catch { return undefined }
  if (value === null || typeof value !== 'object' || typeof value.bot !== 'string') return undefined
  const change = value.change
  if (change === null || typeof change !== 'object') return undefined
  const clean = {}
  for (const [key, field] of Object.entries(change)) if (KEYS.has(key) && typeof field === 'string') clean[key] = field
  if (Object.keys(clean).length === 0) return undefined
  return { bot: value.bot, note: typeof value.note === 'string' ? value.note : undefined, change: clean }
}

// The order Apply saves in: a new model (and its level) first, alone, because a model on
// another route starts a new conversation and the host takes no other field with it; then
// everything else in one save.
export function applySteps(change) {
  const model = {}
  const rest = {}
  for (const [key, value] of Object.entries(change)) {
    if (key === 'model' || (key === 'effort' && change.model !== undefined)) model[key] = value
    else rest[key] = value
  }
  return [model, rest].filter(step => Object.keys(step).length > 0)
}
