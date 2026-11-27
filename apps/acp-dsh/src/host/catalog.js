// What an agent offers as DSH models: its own model list and each model's effort levels, read
// from the agent itself over ACP (its session config options of category `model` and
// `thought_level`). A probe starts the agent once, opens a session that is never prompted (no
// turn, no tokens), reads the models, then picks each one to read the efforts it offers, since
// an agent rebuilds its effort list per model. The result is kept here and, for the real
// agents, on disk, so the next start lists them at once while a new probe runs behind it.
// Until a probe answers, a short list of the agent's well-known names stands in.
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentRun, valuesOf } from './acp.js'
import { isAuthRequired } from './names.js'

/** DSH's model for "whatever the agent's own settings choose"; Sessions saved before models came from the agent use it. */
export const DEFAULT_MODEL = 'default'
// How long a model list waits on a first probe before the stand-in list answers: the picker
// waits on every provider at once.
export const LIST_WAIT_MS = 8000
const PROBE_TIMEOUT_MS = 120_000
const RETRY_MS = 10 * 60 * 1000
// A kept catalog older than this is read again in the background (the picker answers from it
// meanwhile): it carries the person's own effort settings, which they may have changed.
export const STALE_MS = 24 * 60 * 60 * 1000
// How long a sign-in question waits on the probe that answers it (`signedIn`): an agent's first
// start can take a while (Hermes loads its whole toolset).
export const ACCESS_WAIT_MS = 30_000

/**
 * The CLI as a catalog key, with no process spawned: the file it resolves to and when that file
 * last changed. A CLI on PATH is often a link to a versioned folder (Claude Code's installer)
 * or a file updated in place (npm), so the path alone stays the same across its updates.
 */
export function cliStamp(cli) {
  try {
    const real = realpathSync(cli)
    return `${real} ${statSync(real).mtimeMs}`
  } catch {
    return cli
  }
}

/**
 * The efforts a `thought_level` option offers, from least to most, as DSH reasoning metadata.
 * The agent's own "default" row is no level: DSH sends no effort for it. The option's current
 * value, the person's own setting for that model, is the default effort.
 */
export function reasoningOf(option) {
  const efforts = valuesOf(option).filter(choice => choice.value !== DEFAULT_MODEL).map(choice => ({ id: choice.value, name: choice.name || choice.value, ...(choice.description ? { description: choice.description } : {}) }))
  if (efforts.length === 0) return undefined
  return { efforts, ...(efforts.some(effort => effort.id === option.currentValue) ? { defaultEffort: option.currentValue } : {}) }
}

/**
 * Read what one agent offers. `seen` gets the model list as soon as the session is open (each
 * model with `probed: false` until its efforts are read) and again after each model.
 * @param {AgentRun} run - started, never prompted.
 * @param {{ defaultName: string, seen?(state: CatalogState): void, stopped?(): boolean }} options
 */
export async function readCatalog(run, { defaultName, seen = () => {}, stopped = () => false }) {
  const modelOption = run.option('model')
  const startEffort = reasoningOf(run.option('thought_level'))
  // The models that offer a speed option (category `speed`: codex-acp's `fast-mode`,
  // claude-agent-acp's `fast`), as each model's options say. Kept beside the models, never in them.
  const startFast = run.option('speed') !== undefined
  if (modelOption === undefined) {
    const state = { models: [{ id: DEFAULT_MODEL, name: defaultName, reasoning: startEffort, probed: true }], complete: true, start: null,
      fast: startFast ? [DEFAULT_MODEL] : [] }
    seen(state)
    return state
  }
  const start = run.startModel
  const models = valuesOf(modelOption).map(choice => ({ id: choice.value, name: choice.name || choice.value, ...(choice.description ? { description: choice.description } : {}), probed: false }))
  const own = models.find(model => model.id === start)
  const syntheticDefault = !models.some(model => model.id === DEFAULT_MODEL)
  if (syntheticDefault) {
    models.unshift({ id: DEFAULT_MODEL, name: defaultName, description: own ? `Its own setting: ${own.name}` : 'Its own setting', reasoning: startEffort, probed: true })
  }
  for (const model of models) {
    if (model.id === start) Object.assign(model, { reasoning: startEffort, probed: true })
  }
  // The model the agent itself starts on: what DSH's `default` is for it (adapter.js nativeKept).
  const state = { models, offered: true, complete: false, start: typeof start === 'string' ? start : null,
    ...(syntheticDefault && own ? { defaultModel: start } : {}),
    fast: startFast ? [...new Set([...(syntheticDefault ? [DEFAULT_MODEL] : []), ...(typeof start === 'string' ? [start] : [])])] : [] }
  seen(state)
  for (const model of models) {
    if (model.probed) continue
    if (stopped()) return state
    await run.setOption('model', model.id)
    if (stopped()) return state
    model.reasoning = reasoningOf(run.option('thought_level'))
    if (run.option('speed') !== undefined) state.fast.push(model.id)
    model.probed = true
    seen(state)
  }
  state.complete = true
  seen(state)
  return state
}

/**
 * @typedef {{ id: string, name: string, description?: string, reasoning?: { efforts: { id: string, name: string, description?: string }[], defaultEffort?: string }, probed?: boolean }} CatalogModel
 * @typedef {{ models: CatalogModel[], complete: boolean, start?: string | null, defaultModel?: string }} CatalogState
 */

const isText = value => typeof value === 'string' && value.length > 0
const isEffort = effort => isText(effort?.id) && isText(effort?.name) && (effort.description === undefined || typeof effort.description === 'string')
/** Whether a kept entry is a model as a probe writes it: DSH turns down any other shape. */
export function isModel(model) {
  if (!isText(model?.id) || !isText(model?.name)) return false
  if (model.description !== undefined && typeof model.description !== 'string') return false
  const reasoning = model.reasoning
  if (reasoning === undefined) return true
  if (!Array.isArray(reasoning?.efforts) || reasoning.efforts.length === 0 || !reasoning.efforts.every(isEffort)) return false
  const ids = reasoning.efforts.map(effort => effort.id)
  if (new Set(ids).size !== ids.length) return false
  return reasoning.defaultEffort === undefined || ids.includes(reasoning.defaultEffort)
}

// A model slug as Codex names it (codex-native.js modelPart).
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const slugsOf = models => [...new Set((Array.isArray(models) ? models : []).filter(slug => typeof slug === 'string' && SLUG.test(slug)))]

/** A measured set as `recordMeasured` keeps it ({ key, at, models }), else undefined. */
function measuredOf(value) {
  if (value === null || typeof value !== 'object' || !isText(value.key) || !Number.isFinite(value.at)) return undefined
  if (!Array.isArray(value.models) || slugsOf(value.models).length !== value.models.length) return undefined
  return { key: value.key, at: value.at, models: [...value.models] }
}

export class Catalog {
  /**
   * @param {{
   *   id: string, name: string, defaultName: string, fallback: CatalogModel[],
   *   key(): string | undefined, spawn(): { command: string, args?: string[], env?: Record<string, string> } | Promise<any>,
   *   home?: string, log?(message: string): void, waitMs?: number, now?(): number, announceIdentity?: boolean,
   *   onChange?(catalog: Catalog): void,
   * }} spec - `key` names what the probe ran (the adapter's release); a new one probes again.
   */
  constructor(spec) {
    this.spec = spec
    this.now = spec.now ?? Date.now
    this.waitMs = spec.waitMs ?? LIST_WAIT_MS
    this.file = spec.home ? join(spec.home, `${spec.id}.json`) : undefined
    this.saved = this.read()
    // The models the last check of this agent with its own tools off measured with no tool block
    // (Codex, codex-native.js; #1564 B1-4): kept beside the start model, so the Details row reads
    // them right after a restart. Read for the release that measured them, and for a day.
    this.measured = measuredOf(this.saved?.measured)
    this.live = undefined
    this.probing = undefined
    this.listed = undefined
    // A kept catalog read from the release and CLI installed now is not read again at start
    // unless it is a day old: a new adapter release or an updated CLI changes the key.
    this.probedKey = this.saved?.key
    // A file kept before the start model was recorded is read again once, so it gets one.
    this.readAt = typeof this.saved?.at === 'number' && this.saved.start !== undefined ? this.saved.at : undefined
    this.failedAt = undefined
    this.run = undefined
    this.disposed = false
    this.generation = 0
    this.refreshing = false
    this.releaseList = undefined
    this.identityListing = undefined
    this.notified = this.visibleKey()
    // What the agent's own session last said of its sign-in: true once a probe opened a
    // session, false when the agent refused one with ACP's auth_required, undefined until then.
    this.access = undefined
  }

  // A kept file that is not wholly what a probe writes is not used: the stand-ins answer until
  // the next probe writes it again.
  read() {
    if (this.file === undefined) return undefined
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'))
      const start = saved?.start === undefined || saved.start === null || isText(saved.start)
      return Array.isArray(saved?.models) && saved.models.length > 0 && saved.models.every(isModel) && start ? saved : undefined
    } catch {
      return undefined
    }
  }

  write(key, models, start = null, at = this.now(), fast) {
    if (this.file === undefined) return
    try {
      mkdirSync(this.spec.home, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      const measured = this.measured === undefined ? {} : { measured: this.measured }
      const speeds = Array.isArray(fast) ? { fast } : {}
      writeFileSync(tmp, `${JSON.stringify({ key, at, start, models: models.map(({ probed, ...model }) => model), ...speeds, ...measured }, null, 2)}\n`)
      renameSync(tmp, this.file)
    } catch (error) {
      this.spec.log?.(`could not keep ${this.spec.name}'s models: ${error?.message ?? error}`)
    }
  }

  /** Probe again when nothing has, the agent's release changed, or the last try failed a while ago. */
  kick({ requireLive = false } = {}) {
    if (this.probing !== undefined || this.disposed) return
    const key = this.spec.key()
    if (key === undefined) return
    const fresh = this.failedAt !== undefined
      ? this.now() - this.failedAt < RETRY_MS
      : this.readAt !== undefined && this.now() - this.readAt < STALE_MS
    if (this.probedKey === key && fresh && (!requireLive || this.identityListing || this.failedAt !== undefined)) return
    this.begin(key)
  }

  /** Read again after sign-in, keeping the last catalog while this read runs. */
  refresh() {
    if (this.disposed || this.refreshing) return this.probing
    const key = this.spec.key()
    if (key === undefined) return
    this.retire()
    return this.begin(key, true)
  }

  retire() {
    this.identityListing = undefined
    this.generation += 1
    this.run?.dispose()
    this.run = undefined
    this.releaseList?.()
    this.releaseList = undefined
    this.probing = undefined
    this.refreshing = false
  }

  begin(key, forced = false) {
    this.identityListing = undefined
    const generation = ++this.generation
    this.probedKey = key
    this.failedAt = undefined
    this.refreshing = forced
    let listed
    this.listed = new Promise((resolve) => { listed = resolve })
    this.releaseList = listed
    this.probing = this.probe(key, generation, listed).finally(() => {
      listed()
      if (this.disposed || this.generation !== generation) return
      this.probing = undefined
      this.refreshing = false
      this.releaseList = undefined
    })
    return this.probing
  }

  visibleKey() {
    const models = this.current().map(model => ({
      id: model.id, name: model.name,
      resolvesTo: model.resolvesTo ?? (model.id === DEFAULT_MODEL
        ? /^Its own setting: (.+)$/.exec(model.description ?? '')?.[1]?.trim() : undefined),
      reasoning: model.reasoning,
    }))
    return JSON.stringify([models, this.spec.announceIdentity === true && this.identityListing !== undefined])
  }

  changed() {
    const visible = this.visibleKey()
    if (visible === this.notified) return
    this.notified = visible
    try {
      this.spec.onChange?.(this)
    } catch (error) {
      this.spec.log?.(`could not publish ${this.spec.name}'s models: ${error?.message ?? error}`)
    }
  }

  async probe(key, generation, listed) {
    const current = () => !this.disposed && this.generation === generation
    let run
    let first = true
    const previous = this.live?.complete ? this.live : undefined
    const timer = setTimeout(() => run?.dispose(), PROBE_TIMEOUT_MS)
    timer.unref?.()
    try {
      const launch = await this.spec.spawn()
      if (!current()) return
      run = new AgentRun({ ...launch,
        cwd: launch.env?.AUTOMAGIK_BOT_CLI_HOME ?? homedir(), name: this.spec.name })
      this.run = run
      await run.start()
      if (!current()) return
      this.access = true
      const state = await readCatalog(run, {
        defaultName: this.spec.defaultName,
        stopped: () => !current() || !run.alive,
        seen: (state) => {
          if (!current()) return
          // readCatalog mutates its state as efforts arrive. Retired reads own no live data.
          this.live = structuredClone(state)
          this.identityListing = { key, defaultModel: state.defaultModel, models: state.offered ? this.live.models : [] }
          listed()
          if (first || state.complete) this.changed()
          first = false
        },
      })
      if (!current()) return
      if (!state.complete) throw new Error('it stopped before every model was read')
      this.readAt = this.now()
      this.saved = { key, at: this.readAt, start: state.start ?? null, models: structuredClone(state.models), fast: [...state.fast] }
      this.write(key, state.models, state.start ?? null, undefined, state.fast)
    } catch (error) {
      if (!current()) return
      this.identityListing = undefined
      if (previous !== undefined) this.live = previous
      this.failedAt = this.now()
      // Signed out is the agent's own word; any other failure says nothing of the sign-in.
      if (isAuthRequired(error)) this.access = false
      this.changed()
      this.spec.log?.(`could not read ${this.spec.name}'s models, offering its usual ones: `
        + `${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
      run?.dispose()
      if (current() && this.run === run) this.run = undefined
    }
  }

  /** The models as best known now: a probe's, else the last one kept, else the stand-ins. */
  current() {
    const saved = this.saved?.models
    if (this.live === undefined) return saved ?? this.spec.fallback
    const provisional = this.live.models.find(model => model.id === DEFAULT_MODEL)?.reasoning
    return this.live.models.map((model) => {
      if (model.probed) return model
      // Efforts not read yet: the ones kept for it, else those of the model the agent started on.
      const kept = saved?.find(other => other.id === model.id)
      return { ...model, reasoning: kept ? kept.reasoning : provisional }
    })
  }

  // Only a session opened by this process on the currently installed connector can
  // establish a catalog identity. The kept list is still used for ordinary routes.
  identityModels() {
    const listing = this.identityListing
    return listing && listing.key === this.spec.key() ? listing.models : undefined
  }

  identityDefault() {
    if (this.identityModels() !== undefined) return this.identityListing.defaultModel
  }

  async probeIdentityModels() {
    this.kick({ requireLive: true })
    if (this.identityModels() === undefined && this.listed !== undefined) {
      let timer
      await Promise.race([this.listed, new Promise(resolve => { timer = setTimeout(resolve, this.waitMs); timer.unref?.() })])
      clearTimeout(timer)
    }
    return this.identityModels()
  }

  /** Every model the agent offers; a first probe is waited on briefly. */
  async models() {
    this.kick()
    if (this.saved === undefined && this.live === undefined && this.listed !== undefined) {
      let timer
      await Promise.race([this.listed, new Promise((resolve) => { timer = setTimeout(resolve, this.waitMs); timer.unref?.() })])
      clearTimeout(timer)
    }
    return this.current()
  }

  /**
   * Whether a model offers Standard / Fast, as its own options said when it was read:
   * true, false, or undefined while nothing has read it. Never waited for.
   */
  offersFast(id) {
    const live = this.live?.models.find(model => model.id === id)
    if (live?.probed && Array.isArray(this.live.fast)) return this.live.fast.includes(id)
    const kept = this.saved?.fast
    if (Array.isArray(kept) && this.saved.models.some(model => model.id === id)) return kept.includes(id)
    return undefined
  }

  /**
   * The effort the agent itself shows for a model, as read for that model: a probe's when it has
   * read that model, else what was kept, else undefined. Never a stand-in's, and never waited
   * for: a turn does not stall on a probe.
   */
  ownEffort(id) {
    const live = this.live?.models.find(model => model.id === id)
    if (live?.probed) return live.reasoning?.defaultEffort
    return this.saved?.models.find(model => model.id === id)?.reasoning?.defaultEffort
  }

  /**
   * Whether the agent is signed in, as its own ACP session says, for an agent whose CLI has no
   * status command (the native agents, agents.js): true when a probe opened a session (or the
   * kept catalog was read from this same CLI), false when the agent answered auth_required,
   * undefined when nothing says. It opens no session of its own: the answer is the catalog
   * probe's, which runs when the CLI changes and once a day, so no empty session is left in the
   * agent's history per check. `fresh` (the person asked to check again) runs the probe again
   * unless the last one opened a session; a signed-out agent refuses before it makes one.
   */
  async signedIn({ fresh = false, waitMs = ACCESS_WAIT_MS } = {}) {
    if (this.disposed) return undefined
    if (fresh && this.access !== true && this.probing === undefined) {
      this.probedKey = undefined
      this.failedAt = undefined
    }
    this.kick()
    if (this.probing !== undefined && this.access !== true) {
      let timer
      await Promise.race([this.listed, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.() })])
      clearTimeout(timer)
    }
    if (this.access !== undefined || this.probing !== undefined || this.failedAt !== undefined) return this.access
    return this.saved !== undefined && this.saved.key === this.spec.key() ? true : undefined
  }

  /** The agent said it is signed out in a turn (ACP auth_required): the next check probes again. */
  signedOut() {
    this.access = false
    if (this.probing === undefined) this.probedKey = undefined
  }

  /**
   * The model the agent itself starts on, as its last probe saw it (or as kept on disk), else
   * undefined. Never waited for.
   */
  ownModel() {
    const start = this.live?.start ?? this.saved?.start
    return typeof start === 'string' ? start : undefined
  }

  /**
   * The models measured kept now: recorded for the release installed now, less than a day ago.
   * `anyAge` (the Details row and the Bot team's ON eligibility, which can only block; #1564
   * BG-3) drops the day, never the release. Anything else, or a failure, is none.
   */
  measuredKept({ anyAge = false } = {}) {
    try {
      const measured = this.measured
      if (measured === undefined || measured.key !== this.spec.key()) return []
      if (anyAge) return [...measured.models]
      const age = this.now() - measured.at
      return age >= 0 && age < STALE_MS ? [...measured.models] : []
    } catch {
      return []
    }
  }

  /**
   * Record the models a check measured with no tool block, replacing the last record. It is
   * written into the kept file without changing the catalog's own age; with no kept file yet it
   * is held here and the next probe writes it.
   */
  recordMeasured(models) {
    let key
    try { key = this.spec.key() } catch { return }
    if (!isText(key)) return
    this.measured = { key, at: this.now(), models: slugsOf(models) }
    const saved = this.saved
    if (saved !== undefined && saved.start !== undefined && typeof saved.at === 'number') this.write(saved.key, saved.models, saved.start, saved.at, saved.fast)
  }

  /** One model by id, or undefined when the agent does not offer it. */
  async model(id) {
    return (await this.models()).find(model => model.id === id)
  }

  dispose() {
    this.disposed = true
    this.retire()
  }
}
