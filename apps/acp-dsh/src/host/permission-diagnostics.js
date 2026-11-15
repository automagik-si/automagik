// The permission diagnostics record: for each DSH Session that ran an ACP agent, which mechanism
// acted. The agent's permission modes (wanted, offered, chosen, and whether it fell to the strict
// one), whether DSH's tools were bridged and why, the path of the last call, the route that
// reviewed for Auto, and the last AUTO_REVIEW_* code with its time.
//
// It only records. Nothing here decides, allows, refuses or throws, nothing the callers do waits
// on it, and it reads no setting: every recorder is told what the real decision already computed
// and catches whatever its own reading raises, so an observation can never change a turn. The
// record lives in memory only (never a file, a Session row, a log line or an event), is dropped
// with its Session, and is capped.
//
// It takes no free text and calls nothing outside this module. Every stored string is one this
// codebase names: a fixed value, a permission mode of Claude Code or Codex, a failure code from a
// fixed list, or a provider or model id written in this plugin's own source. Anything else is
// stored as `other`; a reviewer route the code does not name (a person's own provider or model)
// is stored as `custom`, never by its id. Each input property is read once, and only primitives
// are kept. Never read: a call's title, arguments, output, content or locations (its name is only
// compared with fixed names), an error's message, a bridge's credential or URL, a prompt, a
// folder.
//
// The adapter and the back-channel reach it through a `diagnostics` property the plugin sets
// (index.js), always as `this.diagnostics?.…`, so either works without it.
import { AGENTS } from './agents.js'
import { isBridgeName } from './names.js'

/** The record's shape version: a reader checks it before it reads a field. */
export const DIAGNOSTICS_VERSION = 2
/** How many Sessions keep a record; the one that started longest ago goes first. */
export const MAX_SESSIONS = 200
/** How many mode ids of one list are kept. */
export const MAX_MODES = 16
/** What a value this code does not know becomes. */
export const OTHER = 'other'
/** What a provider or model id this code does not name becomes: a person's own is never kept. */
export const CUSTOM = 'custom'

const REVIEW_PURPOSE = 'auto-review'
// The built-in reviewer route (adapter.js SIDE_MODEL).
const BUILT_IN = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' })
// The provider and model ids this plugin's source names: the built-in reviewer pair, and each
// agent with the models that stand in until it lists its own (agents.js).
export const ROUTES = new Map([
  [BUILT_IN.provider, new Set([BUILT_IN.model])],
  ...Object.entries(AGENTS).map(([id, spec]) => [id, new Set(spec.fallback.map(model => model.id))]),
])
// ACP's tool kinds (the SDK's ToolKind).
const KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
// The permission modes of the two agents. Claude Code's (its ACP adapter's session modes, and
// `dontAsk` of its CLI): default, acceptEdits, plan, dontAsk, bypassPermissions, auto. Codex's
// (codex-acp): read-only, workspace-write, agent, agent-full-access. The ones this plugin asks
// for (agents.js modeFor) are among them; a test holds the two together.
export const MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto', 'read-only', 'workspace-write', 'agent', 'agent-full-access'])
const PROFILE_BASES = {
  'permission-profile:automagik-read': 'read-only',
  'permission-profile:automagik-workspace': 'workspace-write',
}
const KNOWN_MODES = new Set([...MODES, ...Object.keys(PROFILE_BASES)])
const profileLabel = value => typeof value === 'string'
  ? value.replace(/^(permission-profile:automagik-(?:read|workspace))-[0-9a-f]{32}$/, '$1') : value
const modeOf = value => pick(KNOWN_MODES, profileLabel(value))
const baseOf = value => Object.hasOwn(PROFILE_BASES, value) ? PROFILE_BASES[value] : value
// The review codes of the back-channel (backchannel.js) and of DSH's Auto review.
export const REVIEW_CODES = new Set(['AUTO_REVIEW_NO_STEP', 'AUTO_REVIEW_NO_ROUTE', 'AUTO_REVIEW_NO_SCHEMA', 'AUTO_REVIEW_FAILED', 'AUTO_REVIEW_LEVEL_CHANGED', 'AUTO_REVIEW_TIMEOUT', 'AUTO_REVIEW_DENIED'])
// How a review candidate can fail: the codes of the review route itself (adapter.js aside), of
// this plugin (names.js, adapter.js), and DSH's llm failure classes, the ones its providers
// raise included.
export const FAILURE_CODES = new Set([
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'EMPTY_RESPONSE', 'UNSUPPORTED', 'ABORTED',
  'MODEL_ACCESS_REQUIRED', 'ACP_AGENT',
  'AUTH', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'ACCOUNT_QUOTA', 'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED', 'PI_AI_ERROR',
])

// `value` when it is a string of `known`, else `other`. The caller read `value` once; a string
// is a primitive, so what was checked is what is stored.
const pick = (known, value) => (typeof value === 'string' && known.has(value) ? value : OTHER)

function modesOf(values) {
  const out = []
  if (!Array.isArray(values)) return out
  const count = Math.min(values.length, MAX_MODES)
  for (let i = 0; i < count; i++) out.push(modeOf(values[i]))
  return out
}

// Why the bridge is on or off. `on` is the decision itself, read from what it left (the bridge
// the adapter minted, or none); no setting is read here. `setting` means the decision differs
// from the agent's own default, so an explicit `dshTools` made it; `agent-default` means it is
// what the agent's default says (with no setting, or one that says the same). A reason that
// cannot explain the decision is `other`.
function bridgeOf(adapter, agent, state) {
  const on = state.bridge !== undefined
  const byDefault = agent?.disableBuiltInTools === true
  if (adapter.backchannel === undefined) return { on, why: on ? OTHER : 'no-backchannel' }
  if (agent?.bridge === false) return { on, why: on ? OTHER : 'agent-no-bridge' }
  return { on, why: on === byDefault ? 'agent-default' : 'setting' }
}

// The path and kind of one call, from the marks the adapter itself reads (acp.js markCall,
// adapter.js checkDrift), each read once. A bridge name counts only while this Session is
// bridged; `mcp` is an MCP call that carries no bridge name (another server, or any MCP call of
// an agent that names none).
function classify(tool, bridged) {
  const { drift, bridge, mcp, structuredName: name, kind } = tool
  const named = typeof name === 'string' ? name : undefined
  const path = drift === true ? 'drift'
    : bridged && (bridge === true || isBridgeName(named)) ? 'dsh-bridge'
      : named === 'ToolSearch' ? 'loader'
        : mcp === true || named?.startsWith('mcp__') === true ? 'mcp'
          : 'cli'
  return { path, kind: pick(KINDS, kind) }
}

function errorCode(error) {
  const code = error?.info?.code
  return code === undefined ? error?.code : code
}

export class PermissionDiagnostics {
  /**
   * @param {{ now?: () => number, max?: number }} [options] a clock and a cap, for tests
   */
  constructor({ now = () => Date.now(), max = MAX_SESSIONS } = {}) {
    this.now = now
    this.max = max
    this.records = new Map()
  }

  // The record of `sessionId`, when it describes the agent session `state` (the adapter's own
  // entry for it). A recorder that speaks for an agent session that was replaced finds nothing.
  entry(sessionId, state) {
    const entry = this.records.get(sessionId)
    if (entry === undefined) return undefined
    if (state !== undefined && entry.state.deref() !== state) return undefined
    return entry
  }

  /**
   * A new agent session starts in a Session, after the adapter decided its bridge: the only
   * recorder that creates a record. It resets what described the session before (agent, bridge,
   * modes, last call) and keeps the review facts, which carry their own times.
   * @param {string} sessionId
   * @param {any} adapter the AcpAdapter
   * @param {any} agent the agent's row in the adapter's routes
   * @param {any} state the adapter's entry for the new agent session
   */
  started(sessionId, adapter, agent, state) {
    try {
      if (typeof sessionId !== 'string' || sessionId === '' || state === null || typeof state !== 'object') return
      const earlier = this.records.get(sessionId)
      const at = this.now()
      const provider = state.provider
      const entry = {
        // A route of this plugin, or nothing this code knows.
        agent: typeof provider === 'string' && adapter.agents?.has(provider) === true ? provider : OTHER,
        startedAt: at,
        adapter: new WeakRef(adapter),
        state: new WeakRef(state),
        reviewer: earlier?.reviewer,
        review: earlier?.review,
      }
      this.records.delete(sessionId)
      this.records.set(sessionId, entry)
      while (this.records.size > this.max) this.records.delete(this.records.keys().next().value)
      entry.bridge = { ...bridgeOf(adapter, agent, state), at }
    } catch {}
  }

  /**
   * The modes `AgentRun.setMode` chose among: said before the agent is asked to switch, so it is
   * what was attempted. Whether it holds is read from the run when the record is read.
   * @param {string} sessionId
   * @param {any} state
   * @param {{ wanted?: string[], offered?: string[], chosen?: string }} seen
   */
  mode(sessionId, state, seen) {
    try {
      const entry = this.entry(sessionId, state)
      if (entry === undefined) return
      const { wanted: wantedIds, offered: offeredIds, chosen: chosenId } = seen
      const wanted = modesOf(wantedIds)
      const chosen = chosenId === undefined ? undefined : modeOf(chosenId)
      const bases = (Array.isArray(wantedIds) ? wantedIds : []).map(id => baseOf(profileLabel(id)))
        .filter((base, index, all) => index === 0 || base !== all[index - 1])
      entry.modes = {
        wanted,
        offered: modesOf(offeredIds),
        ...(chosen === undefined ? {} : { chosen }),
        // The last wanted mode is the strict one (agents.js modeFor).
        fellToStrict: chosenId !== undefined && bases.length > 1 && baseOf(profileLabel(chosenId)) === bases.at(-1),
        // A chat profile was wanted and its own legacy mode was taken instead.
        ...(Array.isArray(wantedIds) && wantedIds.some(id => Object.hasOwn(PROFILE_BASES, profileLabel(id)) && baseOf(profileLabel(id)) === chosenId) ? { profileFallback: true } : {}),
        at: this.now(),
      }
    } catch {}
  }

  /**
   * A call the agent made, at the adapter's first sight of it. An agent may name a call in a
   * later update, so the record follows the call's own updates while it is the last one.
   * @param {string} sessionId
   * @param {any} state
   * @param {any} tool the run's entry for the call
   */
  call(sessionId, state, tool) {
    try {
      const entry = this.entry(sessionId, state)
      if (entry === undefined || tool === null || typeof tool !== 'object') return
      const bridged = entry.bridge?.on === true
      const last = { ...classify(tool, bridged), at: this.now() }
      entry.lastCall = last
      // The run tells a call's listeners after each update (acp.js changeTool): classify again,
      // for as long as this is still the Session's last call. It never throws.
      tool.listeners?.add?.(() => {
        try {
          if (entry.lastCall === last) Object.assign(last, classify(tool, bridged))
        } catch {}
      })
    } catch {}
  }

  /**
   * An Auto review begins (adapter.js aside). The answer is told each candidate route and how it
   * ended: whether it answered, or the code it failed with, never its message. Any other side
   * request is not a review, and a review that outlives its agent session says nothing about
   * the next one.
   * @param {{ purpose?: string, sessionId?: string }} options the review request
   * @returns {((chosen: any, outcome: any) => void) | undefined}
   */
  review(options) {
    try {
      const { purpose, sessionId } = options
      if (purpose !== REVIEW_PURPOSE) return undefined
      const entry = this.records.get(sessionId)
      if (entry === undefined) return undefined
      return (chosen, outcome) => {
        try {
          if (this.records.get(sessionId) !== entry) return
          const { provider, model } = chosen
          const { finished, failure } = outcome
          const ok = finished === true && failure === undefined
          const code = failure === undefined ? 'EMPTY_RESPONSE' : failure.code
          // Only a route this plugin's source names is kept by its ids.
          const models = typeof provider === 'string' ? ROUTES.get(provider) : undefined
          const reviewer = {
            provider: models === undefined ? CUSTOM : provider,
            model: models !== undefined && typeof model === 'string' && models.has(model) ? model : CUSTOM,
            ok,
            ...(ok ? {} : { code: pick(FAILURE_CODES, code) }),
            at: this.now(),
          }
          entry.reviewer = reviewer
        } catch {}
      }
    } catch {
      return undefined
    }
  }

  noteReview(entry, error, at) {
    const code = errorCode(error)
    if (typeof code !== 'string' || !code.startsWith('AUTO_REVIEW_')) return
    entry.review = { code: pick(REVIEW_CODES, code), at }
  }

  /**
   * A call that reached DSH over the bridge and its result (backchannel.js handle). `record` is
   * the bridge's own entry: one that is not this agent session's bridge any more says nothing.
   * @param {any} record
   * @param {any} result
   */
  bridgeCall(record, result) {
    try {
      const entry = this.entry(record?.sessionId)
      if (entry === undefined || entry.state.deref()?.bridge !== record) return
      const at = this.now()
      entry.bridgeCall = { at }
      this.noteReview(entry, result?.error, at)
    } catch {}
  }

  /**
   * A finished DSH tool call (`tools/result`): a mirror call Auto review denied never reaches the
   * back-channel, so its code is read here. Only a mirror call of this agent session counts: the
   * DSH agent outlives an agent session, so the call must be one this session made.
   * @param {any} exec
   * @param {any} result
   */
  result(exec, result) {
    try {
      if (result?.isError !== true) return
      const { agent, callId } = exec
      const entry = this.entry(agent?.session?.id)
      const state = entry?.state.deref()
      if (state === undefined || state.dshAgent !== agent || state.calls?.has(callId) !== true) return
      this.noteReview(entry, result.error, this.now())
    } catch {}
  }

  /** Record the bounded own-mode answer and whether the prompt took it; undefined (a prompt where the own mode was not in question) clears it. */
  own(sessionId, state, seen) {
    try {
      const entry = this.entry(sessionId, state)
      if (entry === undefined) return
      if (seen === undefined) { delete entry.ownMode; return }
      const { answer, taken } = seen
      entry.ownMode = { answer: pick(new Set(['yes', 'no', 'late', 'none', 'changed', 'refused']), answer), taken: taken === true, at: this.now() }
    } catch {}
  }

  /**
   * The record of one Session, as a fresh plain copy, or undefined. `active` says whether the
   * agent session it describes is still the Session's live one; the mode the agent is in and
   * whether the bridge is still open are read from the live session then.
   * @param {string} sessionId
   */
  read(sessionId) {
    try {
      const entry = this.records.get(sessionId)
      if (entry === undefined) return undefined
      const state = entry.state.deref()
      let active = false
      try {
        active = state !== undefined && entry.adapter.deref()?.live?.get(sessionId) === state && state.run?.alive === true
      } catch {}
      const out = { version: DIAGNOSTICS_VERSION, agent: entry.agent, startedAt: entry.startedAt, active }
      if (entry.ownMode !== undefined) out.ownMode = { ...entry.ownMode }
      if (entry.bridge !== undefined) {
        out.bridge = { ...entry.bridge }
        if (entry.bridge.on) {
          const bridge = active ? state.bridge : undefined
          out.bridge.open = bridge !== undefined && bridge.closed !== true
        }
      }
      if (entry.modes !== undefined) {
        const { wanted, offered, ...rest } = entry.modes
        out.modes = { wanted: [...wanted], offered: [...offered], ...rest }
        if (active) {
          const current = state.run.modes?.currentModeId
          if (current !== undefined && current !== null) out.modes.current = modeOf(current)
          // Only two ids this code does not know say nothing about each other: a known mode
          // and an unknown one differ.
          const unknown = rest.chosen === OTHER && out.modes.current === OTHER
          if (!unknown) out.modes.applied = rest.chosen !== undefined && out.modes.current === rest.chosen
        }
      }
      if (entry.lastCall !== undefined) out.lastCall = { ...entry.lastCall }
      if (entry.bridgeCall !== undefined) out.bridgeCall = { ...entry.bridgeCall }
      if (entry.reviewer !== undefined) out.reviewer = { ...entry.reviewer }
      if (entry.review !== undefined) out.review = { ...entry.review }
      return out
    } catch {
      return undefined
    }
  }

  /** The Session is gone: so is its record. */
  drop(sessionId) {
    try { this.records.delete(sessionId) } catch {}
  }

  clear() {
    this.records.clear()
  }
}
