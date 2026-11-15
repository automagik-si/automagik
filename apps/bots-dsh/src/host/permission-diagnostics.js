// The permission section of the diagnostics page (Settings → Feedback): for each Bot Session
// DSH has open, the level saved for it and where that comes from, the preset DSH reports,
// whether a saved Auto runs as Workspace there, whether the level was not applied (#984), and,
// when acp-dsh keeps one, its record of which mechanism acted (acpAgents.permissionDiagnostics).
//
// It only reads memory. It sets no level, tries no apply, opens no Session, loads no team,
// takes no lock and calls no network: the channel answers it before its own refresh
// (channel.js), and while the team is not loaded here the answer is `unavailable`.
//
// Nothing free-form leaves: no name, title, folder, model, provider, prompt or Session id.
// A row carries the Bot's and the group's own ids, which the window already holds and names
// from its roster, and values from the fixed lists below. A level leaves only as one of the
// stock keys this codebase names; any other preset, whatever its key or label, is `custom`.
// The ACP record is another plugin's: it is rebuilt field by field, and a version or a shape
// this code does not know gives nothing. Nothing here throws: a read that fails answers
// `unavailable`, and a part that fails `partial`, so the channel never notes a failure to the
// log for it and the window never takes a failure for nothing to show.
import { AUTO, AUTO_FALLBACK } from '../shared/permission-levels.js'

/** The answer's shape version: the window checks it before it reads a field. */
export const VERSION = 2
/** The ACP record version this code reads. */
export const ACP_VERSION = 1
/**
 * How many Sessions are listed, at most: the answer never grows past it. The marked ones
 * come first, so no other row takes the place of one; when the marked ones alone are more
 * than this, the answer says how many are left out (`moreMarked`).
 */
export const MAX_ROWS = 40
const MAX_MODES = 16
const OTHER = 'other'
/** What a preset this codebase does not name becomes: its key and label are a person's own. */
export const CUSTOM = 'custom'
const LEVELS = new Set(['read-only', 'workspace-write', 'danger-full-access', AUTO])

/** What became of a Session whose saved level DSH no longer offers (permissions.js applyGone). */
const GONE = new Set(['narrowed', 'kept', 'unknown', 'held'])
const AGENTS = new Set(['acp-claude', 'acp-codex'])
const BUILT_IN = { provider: 'deepseek-official', model: 'deepseek-flash' }
const BRIDGE_WHY = new Set(['no-backchannel', 'agent-no-bridge', 'agent-default', 'setting'])
const PATHS = new Set(['dsh-bridge', 'mcp', 'cli', 'loader', 'drift'])
const MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto', 'read-only', 'workspace-write', 'agent', 'agent-full-access', 'permission-profile:automagik-read', 'permission-profile:automagik-workspace'])
const REVIEW_CODES = new Set(['AUTO_REVIEW_NO_STEP', 'AUTO_REVIEW_NO_ROUTE', 'AUTO_REVIEW_NO_SCHEMA', 'AUTO_REVIEW_FAILED', 'AUTO_REVIEW_LEVEL_CHANGED', 'AUTO_REVIEW_TIMEOUT', 'AUTO_REVIEW_DENIED'])
const FAILURE_CODES = new Set([
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'EMPTY_RESPONSE', 'UNSUPPORTED', 'ABORTED',
  'MODEL_ACCESS_REQUIRED', 'ACP_AGENT',
  'AUTH', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'ACCOUNT_QUOTA', 'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED', 'PI_AI_ERROR',
])

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const pick = (known, value) => (typeof value === 'string' && known.has(value) ? value : OTHER)
const time = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined)
const flag = value => (typeof value === 'boolean' ? value : undefined)
const modes = (list) => {
  if (!Array.isArray(list)) return []
  const out = []
  for (let i = 0; i < Math.min(list.length, MAX_MODES); i += 1) out.push(pick(MODES, list[i]))
  return out
}
// Only the keys that hold a value.
const kept = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

function reviewerRoute(provider, model) {
  if (provider === 'custom' || model === 'custom') return 'custom'
  if (provider === BUILT_IN.provider && model === BUILT_IN.model) return 'built-in'
  if (typeof provider === 'string' && AGENTS.has(provider)) return 'agent'
  return OTHER
}

/**
 * acp-dsh's record of one Session, rebuilt from fixed values only, or undefined. Each
 * property is read once; whatever a read raises gives nothing.
 * @param {unknown} raw
 */
export function acpView(raw) {
  try {
    if (!plain(raw) || ![ACP_VERSION, 2].includes(raw.version)) return undefined
    const { agent, active, bridge, modes: mode, lastCall, reviewer, review } = raw
    const out = { agent: pick(AGENTS, agent), active: active === true }
    if (raw.version === 2 && plain(raw.ownMode)) out.ownMode = kept({ answer: pick(new Set(['yes', 'no', 'late', 'none', 'changed', 'refused']), raw.ownMode.answer), taken: flag(raw.ownMode.taken), at: time(raw.ownMode.at) })
    if (plain(bridge)) {
      const { on, why, open } = bridge
      if (typeof on === 'boolean') out.bridge = kept({ on, why: pick(BRIDGE_WHY, why), open: on ? flag(open) : undefined })
    }
    if (plain(mode)) {
      const { wanted, offered, chosen, current, applied, fellToStrict } = mode
      out.modes = kept({
        wanted: modes(wanted),
        offered: modes(offered),
        chosen: chosen === undefined ? undefined : pick(MODES, chosen),
        current: current === undefined ? undefined : pick(MODES, current),
        applied: flag(applied),
        // Recorded before the agent is asked to switch: it holds only once the mode does.
        fellToStrict: fellToStrict === true && applied === true,
      })
    }
    if (plain(lastCall)) {
      const { path, at } = lastCall
      if (time(at) !== undefined) out.lastCall = { path: pick(PATHS, path), at }
    }
    if (plain(reviewer)) {
      const { provider, model, ok, code, at } = reviewer
      if (typeof ok === 'boolean' && time(at) !== undefined) {
        out.reviewer = kept({ route: reviewerRoute(provider, model), ok, code: ok ? undefined : pick(FAILURE_CODES, code), at })
      }
    }
    if (plain(review)) {
      const { code, at } = review
      if (time(at) !== undefined) out.review = { code: pick(REVIEW_CODES, code), at }
    }
    return out
  } catch {
    return undefined
  }
}

const ORDER = { chat: 0, group: 1, task: 2, other: 3 }

export function install(rt) {
  const { ctx } = rt

  // A level as it leaves: a stock key, or `custom`. Nothing of DSH's catalog is forwarded.
  const levelView = value => (typeof value !== 'string' || value === '' ? undefined : { value: LEVELS.has(value) ? value : CUSTOM })

  function acpOf(sessionId) {
    try {
      return acpView(ctx.get?.('acpAgents')?.permissionDiagnostics?.(sessionId))
    } catch {
      return undefined
    }
  }

  function permissionDiagnostics() {
    try {
      return read()
    } catch {
      return { version: VERSION, unavailable: true }
    }
  }

  function read() {
    // Not loaded here yet, or the saved team could not be read: nothing to answer from.
    // The store says so itself; a host without that reader is judged by its Bots, as before.
    const loadedTeam = typeof rt.teamLoaded === 'function' ? rt.teamLoaded() === true : Object.keys(rt.state?.bots ?? {}).length > 0
    if (!loadedTeam) return { version: VERSION, unavailable: true }
    // A part that cannot be read is said (`partial`), never passed off as nothing to show.
    let partial = false
    let loaded = []
    try {
      loaded = ctx.sessions?.list?.() ?? []
    } catch {
      partial = true
    }
    const open = new Map(loaded.filter(session => typeof session?.id === 'string').map(session => [session.id, session]))
    let marked = []
    try {
      marked = rt.unappliedSessions()
    } catch {
      partial = true
    }
    const rows = []
    for (const sessionId of new Set([...marked, ...open.keys()])) {
      const session = open.get(sessionId)
      let facts
      try {
        facts = rt.permissionFactsOf(sessionId, session)
      } catch {}
      if (facts === undefined || facts.failed === true) {
        partial = true
        continue
      }
      // A Session no Bot owns is listed only for its mark.
      if (facts.kind === 'other' && facts.unapplied === undefined) continue
      const saved = levelView(facts.saved)
      const effective = levelView(facts.effective)
      rows.push(kept({
        kind: facts.kind,
        botId: facts.botId,
        roomId: facts.roomId,
        open: session !== undefined,
        auto: plain(facts.auto) ? kept({ counts: flag(facts.auto.counts), why: pick(new Set(['lock', 'level', 'deny', 'session', 'preset', 'route', 'agent', 'judge']), facts.auto.why), by: pick(new Set(['codex', 'claude', 'own', 'team']), facts.auto.by) }) : undefined,
        presets: facts.presets === false ? false : undefined,
        // `unknown`: a task's level cannot be told without DSH's levels.
        source: saved !== undefined ? facts.source : facts.kind === 'task' && facts.presets === false ? 'unknown' : 'none',
        saved,
        effective,
        // Seen, not inferred: the saved Auto reads as Workspace on this Session now.
        fallback: facts.saved === AUTO && facts.effective === AUTO_FALLBACK ? true : undefined,
        // Compared by their own keys, before a custom one loses its key: two different
        // presets of the person's own still differ.
        differs: typeof facts.saved === 'string' && typeof facts.effective === 'string' ? facts.saved !== facts.effective : undefined,
        // The saved level is no longer offered: one of the fixed outcomes, never a level's name.
        notOffered: typeof facts.gone === 'string' && GONE.has(facts.gone) ? facts.gone : undefined,
        unapplied: facts.unapplied === undefined ? undefined : kept({ level: levelView(facts.unapplied.level), at: time(facts.unapplied.at) }),
        acp: acpOf(sessionId),
      }))
    }
    const first = row => (row.unapplied === undefined ? 1 : 0)
    rows.sort((a, b) => first(a) - first(b) || ORDER[a.kind] - ORDER[b.kind])
    // Marked rows the cap leaves out are counted, so none goes unsaid.
    const hidden = rows.slice(MAX_ROWS).filter(row => row.unapplied !== undefined).length
    // A window that only views the team (another DSH holds it) answers from its last
    // refresh: said, since this read does not refresh. Only the fact leaves, as a flag.
    let viewOnly = false
    try {
      viewOnly = rt.readOnly() !== undefined
    } catch {
      partial = true
    }
    return {
      version: VERSION,
      sessions: rows.slice(0, MAX_ROWS),
      ...(rows.length > MAX_ROWS ? { more: true } : {}),
      ...(hidden > 0 ? { moreMarked: hidden } : {}),
      ...(viewOnly ? { viewOnly: true } : {}),
      ...(partial ? { partial: true } : {}),
    }
  }

  Object.assign(rt, { permissionDiagnostics })
}
