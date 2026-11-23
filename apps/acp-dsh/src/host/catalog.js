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
  if (modelOption === undefined) {
    const state = { models: [{ id: DEFAULT_MODEL, name: defaultName, reasoning: startEffort, probed: true }], complete: true, start: null }
    seen(state)
    return state
  }
  const start = run.startModel
  const models = valuesOf(modelOption).map(choice => ({ id: choice.value, name: choice.name || choice.value, ...(choice.description ? { description: choice.description } : {}), probed: false }))
  const own = models.find(model => model.id === start)
  if (!models.some(model => model.id === DEFAULT_MODEL)) {
    models.unshift({ id: DEFAULT_MODEL, name: defaultName, description: own ? `Its own setting: ${own.name}` : 'Its own setting', reasoning: startEffort, probed: true })
  }
  for (const model of models) {
    if (model.id === start) Object.assign(model, { reasoning: startEffort, probed: true })
  }
  // The model the agent itself starts on: what DSH's `default` is for it (adapter.js nativeKept).
  const state = { models, complete: false, start: typeof start === 'string' ? start : null }
  seen(state)
  for (const model of models) {
    if (model.probed) continue
    if (stopped()) return state
    await run.setOption('model', model.id)
    if (stopped()) return state
    model.reasoning = reasoningOf(run.option('thought_level'))
    model.probed = true
    seen(state)
  }
  state.complete = true
  seen(state)
  return state
}

/**
 * @typedef {{ id: string, name: string, description?: string, reasoning?: { efforts: { id: string, name: string, description?: string }[], defaultEffort?: string }, probed?: boolean }} CatalogModel
 * @typedef {{ models: CatalogModel[], complete: boolean, start?: string | null }} CatalogState
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

export class Catalog {
  /**
   * @param {{
   *   id: string, name: string, defaultName: string, fallback: CatalogModel[],
   *   key(): string | undefined, spawn(): { command: string, args?: string[], env?: Record<string, string> } | Promise<any>,
   *   home?: string, log?(message: string): void, waitMs?: number, now?(): number,
   *   onChange?(catalog: Catalog): void,
   * }} spec - `key` names what the probe ran (the adapter's release); a new one probes again.
   */
  constructor(spec) {
    this.spec = spec
    this.now = spec.now ?? Date.now
    this.waitMs = spec.waitMs ?? LIST_WAIT_MS
    this.file = spec.home ? join(spec.home, `${spec.id}.json`) : undefined
    this.saved = this.read()
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

  write(key, models, start = null) {
    if (this.file === undefined) return
    try {
      mkdirSync(this.spec.home, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ key, at: this.now(), start, models: models.map(({ probed, ...model }) => model) }, null, 2)}\n`)
      renameSync(tmp, this.file)
    } catch (error) {
      this.spec.log?.(`could not keep ${this.spec.name}'s models: ${error?.message ?? error}`)
    }
  }

  /** Probe again when nothing has, the agent's release changed, or the last try failed a while ago. */
  kick() {
    if (this.probing !== undefined || this.disposed) return
    const key = this.spec.key()
    if (key === undefined) return
    const fresh = this.failedAt !== undefined
      ? this.now() - this.failedAt < RETRY_MS
      : this.readAt !== undefined && this.now() - this.readAt < STALE_MS
    if (this.probedKey === key && fresh) return
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
    this.generation += 1
    this.run?.dispose()
    this.run = undefined
    this.releaseList?.()
    this.releaseList = undefined
    this.probing = undefined
    this.refreshing = false
  }

  begin(key, forced = false) {
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
    return JSON.stringify(this.current().map(model => ({
      id: model.id, name: model.name,
      resolvesTo: model.resolvesTo ?? (model.id === DEFAULT_MODEL
        ? /^Its own setting: (.+)$/.exec(model.description ?? '')?.[1]?.trim() : undefined),
      reasoning: model.reasoning,
    })))
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
          listed()
          if (first || state.complete) this.changed()
          first = false
        },
      })
      if (!current()) return
      if (!state.complete) throw new Error('it stopped before every model was read')
      this.readAt = this.now()
      this.saved = { key, at: this.readAt, start: state.start ?? null, models: structuredClone(state.models) }
      this.write(key, state.models, state.start ?? null)
    } catch (error) {
      if (!current()) return
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

  /** One model by id, or undefined when the agent does not offer it. */
  async model(id) {
    return (await this.models()).find(model => model.id === id)
  }

  dispose() {
    this.disposed = true
    this.retire()
  }
}
