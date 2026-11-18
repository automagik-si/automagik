// A Claude or ChatGPT subscription signs in once, through its own CLI (Claude Code, Codex),
// which Automagik installs. Bots that still run on a subscription through DSH (pi-ai's
// `openai-codex`, the ChatGPT sign-in; pi-ai's `anthropic` on a Claude Pro or Max sign-in) move
// once per team to that CLI's route over ACP: `acp-codex/<same id>` and `acp-claude/<same id,
// else the same family>`, else the agent's `default`. A Bot on an API key never moves:
// `openai`, every other route, and `anthropic` whenever a key may be what it runs on.
//
// `anthropic` counts as the Pro or Max sign-in only when all of these hold (anthropicSubscription):
// DSH's settings show its route with no `apiKeyEnv`, DSH's credential store holds pi-ai's
// `llm-pi-ai/anthropic` record as a sign-in grant (its kind only: the value is never read), and
// no ANTHROPIC_API_KEY is set where pi-ai's own discovery would find it. Anything else, or
// anything this cannot read, is a key route or an unknown one, and is left alone and unmarked.
//
// The move needs three things, and a pass that lacks one moves no one and marks nothing (#868):
// the CLI's route registered (acp-dsh serves it while the agent is on); the agent's catalog
// really read (until acp-dsh's probe answers, a route lists only the agent's `default` stand-in,
// and moving then would drop every Bot's model); and the CLI signed in, as acp-dsh's `inspect`
// says (`destination`). A sign-in that is `false` or unknown is not ready: the Bots stay on the
// route that answers them, and the Bot's settings say why (`subscriptionWaitingView`). A team
// with no Bot on the source route is marked done without asking the CLI anything. No credential
// is copied or read between programs: only the route names on the Bots change.
//
// A waiting pass looks again on a route or settings change, when acp-dsh says the CLI signed in
// (`acp-dsh/login-ready`), at the next start, and on a timer: the catalog every minute (it
// spawns nothing); a sign-in or CLI that could not be read after 1, 5 and 30 minutes, then on
// events only, which do not start those three again until a pass reads a definite answer; a
// CLI that says it is signed out every 10 minutes, so a sign-in done in a terminal is found
// without a restart.
//
// Codex has a way back (`restore: true`). Each moved Bot keeps a record (`subscriptionMoved`:
// the model and level it had and the target; the `previousModel` it had too, when that was not
// its model), and the team keeps when the route moved (`subscriptionMovedAt`). A Bot the person
// re-pointed since is theirs: its record is dropped, also when the pick lands while a pass is
// asking the CLI (the record is read again right before a Bot goes back, and before its
// Session selects). The others go back to exactly what they had, and the route's flag is
// cleared so the gated move runs again later, when:
// - Codex is gone: turned off, its service or row absent, or its CLI install failed. A CLI that
//   is missing or still installing is not gone (a PATH change, an update), and gone must be
//   read at the first pass after a start, or again a minute after it was first read: a burst
//   of events (a settings write, then acp-dsh publishing its routes) is one reading, not two.
//   This read is acp-dsh's `status()`, which spawns nothing, so a settled team never runs the
//   CLI for it.
// - Codex says it is signed out and the record is not `confirmed`. A record is confirmed only
//   by an answer on its target in the Bot's own chat since the move (model-state.js's
//   `lastAnswer`, read by the pass), or by a ready pass late enough that the sign-in read is
//   newer than the move (acp-dsh keeps a "signed in" answer for five minutes). Records written
//   before this gate (v3.109.1) have no `confirmed`, so a team that release stranded on a
//   signed-out Codex is repaired at its first pass.
// Nothing is restored unless `openai-codex` is still registered and DSH still holds its ChatGPT
// grant: without them the Bots stay on Codex, whose chat asks for the sign-in.
//
// This is a deliberate exception to "a plan runs Bots only through its CLI" (models.js D-a,
// D-c): a restored Bot runs on `openai-codex`, a route the model menu treats as covered. It
// keeps that model through edits that leave the model alone (models.js `keep`), cannot be
// picked back onto it, and moves to Codex again once Codex is signed in. Claude has no such
// exception: acp-adoption.js follows the rule, and neither rollback puts a Bot back on the
// `anthropic` sign-in route. A Claude plan Bot only gets the gate.
//
// Each source route is done once (`state.subscriptionCliMoved[<route>]`), so a model the
// person picks later is theirs. `previousModel` follows the same mapping: a confirmed Bot
// stays confirmed on its target, and a pending switch keeps the model it would go back to,
// never a subscription route that no longer answers. A Bot whose model stays but whose
// `previousModel` moved gets a small record of its own (`previousOnly`), so the way back
// covers it too. The Session and its history stay; the next sync selects the target, carrying
// the Bot's level where the agent offers it.
// Auxiliary jobs (prefs.backgroundModel) never run on an agent and are not touched here.
import { claudeFamilyOf } from './claude-models.js'
import { splitRef } from './text.js'

const PI_AI_NS = 'llm-pi-ai'
// The agent's own "default" row, which acp-dsh always serves (acp-dsh catalog.js DEFAULT_MODEL).
const AGENT_DEFAULT = 'default'
// pi-ai's stored sign-in for Claude, and the variable its own discovery reads for a key.
const ANTHROPIC_RECORD = `${PI_AI_NS}/anthropic`
const ANTHROPIC_KEY_REF = 'ANTHROPIC_API_KEY'
// pi-ai's stored ChatGPT sign-in. Its own constant: imagegen.js names the same record for images.
const CODEX_RECORD = `${PI_AI_NS}/openai-codex`
// A pass that waited on an agent's catalog looks again after this, and a route read as gone has
// to be read gone again this long after before its Bots go back.
export const RETRY_MS = 60_000
// A sign-in or CLI that could not be read: each look may spawn the CLI, so three, then none.
export const CHECK_BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000])
// A CLI that says it is signed out is asked again this often while Bots wait for it.
export const SIGN_IN_RECHECK_MS = 10 * 60_000
// acp-dsh keeps a "signed in" answer for five minutes (its SIGNED_IN_TTL_MS). A ready pass this
// long after a move read a sign-in newer than the move, so it may confirm the record.
export const CONFIRM_AFTER_MS = 6 * 60_000

/** Whether an agent's list is its real catalog: acp-dsh's stand-in before a probe may be only `default`. */
const catalogRead = listed => listed.some(id => id !== AGENT_DEFAULT)

/** The id an agent lists for a model: the same id, or a listed id that is that id with a suffix. */
const sameId = (id, listed) => (listed.includes(id)
  ? id
  : listed.find(entry => typeof entry === 'string' && /^[/[]/.test(entry.slice(id.length)) && entry.startsWith(id)))

export const SUBSCRIPTION_MOVES = Object.freeze([
  Object.freeze({
    from: 'openai-codex',
    to: 'acp-codex',
    cli: 'Codex',
    // The way back (the header): only while this record is still a sign-in grant.
    restore: true,
    record: CODEX_RECORD,
    target: (id, listed) => sameId(id, listed) ?? AGENT_DEFAULT,
  }),
  Object.freeze({
    from: 'anthropic',
    to: 'acp-claude',
    cli: 'Claude Code',
    // Claude Code lists its aliases (`opus`, `sonnet`, `haiku`) where pi-ai names versions.
    target: (id, listed) => {
      const same = sameId(id, listed)
      if (same !== undefined) return same
      const family = claudeFamilyOf(`claude-code/${id}`)
      return family !== undefined && listed.includes(family) ? family : AGENT_DEFAULT
    },
  }),
])

// Whether the ACP plugin is still on its way in: its loader entry exists and is enabled, but
// it has not provided `acpAgents` yet. Missing service is not a missing route.
export function acpLoading(ctx) {
  try {
    const loader = ctx.get?.('loader')
    if (loader === undefined || typeof loader.entries !== 'function') return false
    for (const entry of loader.entries()) {
      if (entry?.disabled === true) continue
      if (String(entry?.options?.name ?? '').includes('acp-dsh')) return true
    }
  } catch {}
  return false
}

const CHECKING = Object.freeze({ state: 'waiting', reason: 'checking' })
// One agent row of acp-dsh, read for whether its route is here: `gone` (off, no row, or a CLI
// install that failed), waiting on its CLI or connector, or undefined when it is served.
function rowState(row) {
  if (row === undefined || row === null || row.on === false) return { state: 'gone' }
  if (row.connector?.state === 'ready' && row.cli?.found !== false) return undefined
  return row.cli?.state === 'failed' ? { state: 'gone' } : { state: 'waiting', reason: 'cli' }
}

const providerOf = ref => splitRef(ref)?.provider

/** The move's record on a Bot when it is `spec`'s, else undefined. */
function recordOf(bot, spec) {
  const record = bot?.subscriptionMoved
  if (record === null || typeof record !== 'object') return undefined
  const [from, to] = record.previousOnly === true ? [record.from?.previousModel, record.previousTarget] : [record.from?.model, record.target]
  return providerOf(from) === spec.from && providerOf(to) === spec.to ? record : undefined
}

/**
 * The `<agent>/<model>` a ref moves to, or undefined when it is not on `move.from`.
 * @param {string | undefined} ref
 * @param {{ from: string, to: string, target(id: string, listed: string[]): string }} move
 * @param {string[]} listed the model ids the agent's route serves
 */
export function movedRef(ref, move, listed) {
  const route = splitRef(ref)
  if (route === undefined || route.provider !== move.from || route.model === '') return undefined
  return `${move.to}/${move.target(route.model, listed)}`
}

/**
 * Whether `provider` is a pi-ai route set up in DSH's settings with no `apiKeyEnv`: true, false
 * (a key route, or not set up), or undefined when the settings cannot be read.
 */
function signInRoute(ctx, provider) {
  try {
    const settings = ctx.get?.('settings')
    const entry = ctx.llm.listConfigurableProviders?.()?.find(row => row?.provider === provider)
    if (settings === undefined || entry === undefined || entry.settingsNs !== PI_AI_NS) return undefined
    const section = settings.describe({ redactSecrets: true }).find(row => row?.ns === PI_AI_NS)
    const profile = (entry.settingsPath ?? []).reduce((value, key) => value?.[key], section?.value)
    if (profile === undefined || profile === null) return false
    return !(typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '')
  } catch {
    return undefined
  }
}

/**
 * The one rule for whether a pi-ai route with no `apiKeyEnv` runs on its provider's sign-in
 * rather than a key, shared by the move (anthropicSubscription), the model menu (providers.js
 * routeAuth) and, through `omniTeam.anthropicSubscription`, Connect AI: pi-ai's stored record
 * is a sign-in grant (pi-ai stores a pasted key as a record too, of kind `api-key`), and no key
 * is found where pi-ai's own discovery would read one instead.
 * @param {{ configured?: boolean, kind?: string } | undefined} record DSH's description of the record
 * @param {boolean} keyFound
 */
export const runsOnSignIn = (record, keyFound) => record?.configured === true && record.kind === 'grant' && keyFound !== true

/**
 * Whether pi-ai's `anthropic` route runs on a Claude Pro or Max sign-in: true only when the
 * route names no `apiKeyEnv`, the stored record is a sign-in grant, and no ANTHROPIC_API_KEY is
 * found. false when a key is (or may be) what it runs on, or nothing is signed in; undefined
 * when DSH's settings or credential store cannot be read. Reads descriptions only, never a value.
 * @returns {Promise<boolean | undefined>}
 */
export async function anthropicSubscription(ctx) {
  const route = signInRoute(ctx, 'anthropic')
  if (route !== true) return route
  try {
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined || typeof credentials.describeRecord !== 'function') return undefined
    const record = await credentials.describeRecord(ANTHROPIC_RECORD)
    if (!runsOnSignIn(record, false)) return false
    // pi-ai's own discovery finds a key in the environment or DSH's store: it may win over the
    // grant, so the route may be on a key.
    const key = await credentials.describe?.(ANTHROPIC_KEY_REF)
    return runsOnSignIn(record, key?.configured === true)
  } catch {
    return undefined
  }
}

export function install(rt) {
  const { ctx, state } = rt
  const subscription = async from => (from === 'anthropic' ? await anthropicSubscription(ctx) === true : true)

  const registered = (id) => {
    try {
      return ctx.llm.listProviders().some(provider => provider?.id === id)
    } catch {
      return false
    }
  }
  async function listedOf(id) {
    const models = await ctx.llm.listModels(id)
    return (Array.isArray(models) ? models : []).map(model => model?.id).filter(value => typeof value === 'string')
  }

  // Set while this pass asks acp-dsh: an event its own read sets off is not a reason to ask again.
  let probing = false
  async function asking(run) {
    probing = true
    try {
      return await run()
    } finally {
      probing = false
    }
  }
  /**
   * Whether `spec.to` can take Bots now. Without `probe` only acp-dsh's `status()` is read
   * (nothing is spawned) and a served route is `present`; with it, `inspect` asks the CLI for
   * its sign-in and only a definite `true` is `ready`. Never `refresh()`, which starts installs.
   * @returns {Promise<{ state: 'ready' | 'present' | 'gone' } | { state: 'waiting', reason: 'sign-in' | 'account' | 'cli' | 'checking' }>}
   */
  async function destination(spec, probe) {
    let acp
    try { acp = ctx.get?.('acpAgents') } catch {}
    if (acp === undefined || acp === null) return acpLoading(ctx) ? CHECKING : { state: 'gone' }
    if (typeof acp.status === 'function') {
      let rows
      try { rows = (await asking(() => acp.status()))?.agents } catch { return CHECKING }
      if (!Array.isArray(rows)) return CHECKING
      const seen = rowState(rows.find(row => row?.id === spec.to))
      if (seen !== undefined) return seen
      if (!probe) return { state: 'present' }
    }
    if (!probe || typeof acp.inspect !== 'function') return CHECKING
    let row
    try { row = await asking(() => acp.inspect(spec.to)) } catch { return CHECKING }
    if (row === undefined || row === null) return CHECKING
    const seen = rowState(row)
    if (seen !== undefined) return seen
    // Signed in, but to an account the person has not confirmed for Bots (#869): no Bot moves
    // onto it. Only acp-dsh saying `needed` waits; anything else is as before.
    if (row.signedIn === true) return row.consent === 'needed' ? { state: 'waiting', reason: 'account' } : { state: 'ready' }
    return row.signedIn === false ? { state: 'waiting', reason: 'sign-in' } : CHECKING
  }

  // Whether the route a restore goes back to still answers: registered, and DSH still holds its
  // sign-in grant (the description only). Unreadable is no.
  async function sourceAnswers(spec) {
    // Isolation migration/sign-out deliberately pauses the Bot on its chosen CLI route.
    // Restoring a legacy plan here would silently bill a different account.
    try {
      if (ctx.get?.('acpAgents')?.authScope !== 'shared') return false
    } catch { return false }
    if (!registered(spec.from)) return false
    try {
      const credentials = ctx.get?.('credentials')
      return runsOnSignIn(await credentials?.describeRecord?.(spec.record), false)
    } catch {
      return false
    }
  }

  // One Bot back to what its record says. The level is not touched: the move never changes it,
  // so it is either the one recorded or the person's own since.
  function restoreBot(bot, record, spec) {
    delete bot.subscriptionMoved
    if (record.previousOnly === true) {
      bot.previousModel = record.from.previousModel
      return false
    }
    if (record.previousTarget !== undefined && bot.previousModel === record.previousTarget) bot.previousModel = record.from.previousModel
    // Elsewhere on the CLI's route: the move took it there with the model, an answer confirmed
    // it since, or v3.109.1 moved another model there and recorded nothing. None is a model to
    // switch back to (model-state.js's revertModel would strand the Bot on the CLI again).
    else if (providerOf(bot.previousModel) === spec.to) bot.previousModel = record.from.model
    bot.model = record.from.model
    // The Session's record of the model it ran on goes too, so the next sync selects again.
    delete bot.appliedModel
    delete bot.appliedEffort
    return true
  }

  // Why each source route still holds Bots, for the Bot's settings; and what the log last said.
  let waitingBy = new Map()
  const said = new Map()
  const say = (key, reason, ...line) => {
    if (said.get(key) === reason) return
    said.set(key, reason)
    if (reason !== undefined) rt.warn?.(...line)
  }
  const WHY = { 'sign-in': 'is not signed in', account: 'waits for its account to be confirmed', cli: 'is not ready', checking: 'could not be checked' }
  // When each route was first read as gone, and whether a pass has run since the start.
  const goneSince = new Map()
  let started = false
  let attempt = 0

  const move = async ({ timed = false } = {}) => {
    await rt.load()
    // Nothing is written by a host that only reads the team.
    if (rt.readOnly?.() !== undefined) return
    const first = !started
    started = true
    const done = state.subscriptionCliMoved !== null && typeof state.subscriptionCliMoved === 'object' ? state.subscriptionCliMoved : {}
    // A Bot its plugin answers for never runs on a DSH model: not moved, restored or counted.
    const bots = Object.values(state.bots ?? {}).filter(bot => bot !== undefined && bot !== null && rt.hostOwned?.(bot) !== true)
    const onRoute = (spec, bot) => providerOf(bot.model) === spec.from
    const moved = []
    const restored = []
    const reasons = new Map()
    const now = Date.now()
    // model-state.js's view, read at most once a pass and only when a record needs it.
    let answered
    const answers = () => {
      try { answered ??= rt.modelStateView?.() ?? {} } catch { answered = {} }
      return answered
    }
    let changed = false
    let unread = false
    for (const spec of SUBSCRIPTION_MOVES) {
      // When this route moved. Absent on a team v3.109.1 moved: an earlier process did that.
      const at = typeof state.subscriptionMovedAt?.[spec.from] === 'number' ? state.subscriptionMovedAt[spec.from] : 0
      for (const bot of bots) {
        const record = spec.restore === true ? recordOf(bot, spec) : undefined
        if (record === undefined) continue
        // The person re-pointed the Bot since: theirs from now on.
        if (record.previousOnly === true ? bot.previousModel !== record.previousTarget : bot.model !== record.target) {
          delete bot.subscriptionMoved
          changed = true
          continue
        }
        // An answer on the target in the Bot's own chat since the move: its sign-in works there.
        if (record.confirmed === true || record.previousOnly === true) continue
        const answer = answers()?.[bot.id]?.lastAnswer
        if (answer?.ref === record.target && answer.at >= at) {
          record.confirmed = true
          changed = true
        }
      }
      const recorded = spec.restore === true ? bots.filter(bot => recordOf(bot, spec) !== undefined) : []
      const unconfirmed = recorded.some(bot => bot.subscriptionMoved.confirmed !== true)
      let listed
      if (done[spec.from] !== true && await subscription(spec.from)) {
        if (!registered(spec.to)) {
          reasons.set(spec.from, 'cli')
        } else {
          try { listed = await listedOf(spec.to) } catch {}
          // Only the stand-in so far: every Bot would land on `default`. Not done; look again.
          if (listed !== undefined && !catalogRead(listed)) {
            listed = undefined
            lookAgain(RETRY_MS)
          }
          if (listed === undefined) reasons.set(spec.from, 'cli')
        }
      }
      // No Bot to take: done, with nothing asked of the CLI.
      if (listed !== undefined && !bots.some(bot => onRoute(spec, bot) || providerOf(bot.previousModel) === spec.from)) {
        done[spec.from] = true
        changed = true
        listed = undefined
      }
      const probe = listed !== undefined || unconfirmed
      if (!probe && recorded.length === 0) continue
      const route = await destination(spec, probe)
      const gone = route.state === 'gone'
      const read = Date.now()
      if (!gone) goneSince.delete(spec.from)
      else if (!goneSince.has(spec.from)) goneSince.set(spec.from, read)

      if (recorded.length > 0) {
        const left = gone ? goneSince.get(spec.from) + RETRY_MS - read : 0
        const settled = first || left <= 0
        const signedOut = route.state === 'waiting' && route.reason === 'sign-in'
        const back = gone && settled ? recorded : signedOut ? recorded.filter(bot => bot.subscriptionMoved.confirmed !== true) : []
        if (gone && !settled) lookAgain(left)
        if (back.length > 0 && await sourceAnswers(spec)) {
          say(`source:${spec.from}`, undefined)
          let went = false
          for (const bot of back) {
            // The awaits above let a pick or a removal in: read the Bot and its record again.
            const record = rt.botOf(bot.id) === bot ? recordOf(bot, spec) : undefined
            if (record === undefined) continue
            if (record.previousOnly === true ? bot.previousModel !== record.previousTarget : bot.model !== record.target) {
              delete bot.subscriptionMoved
              changed = true
              continue
            }
            went = true
            if (restoreBot(bot, record, spec)) restored.push({ bot, from: record.target, to: record.from.model })
          }
          if (went) {
            // The gated move runs again once the CLI is ready.
            delete done[spec.from]
            if (state.subscriptionMovedAt !== null && typeof state.subscriptionMovedAt === 'object') delete state.subscriptionMovedAt[spec.from]
            changed = true
            reasons.set(spec.from, signedOut ? 'sign-in' : 'cli')
          }
        } else if (back.length > 0) {
          say(`source:${spec.from}`, 'kept', 'ds-bot: Bots moved to %s stay there: %s no longer answers here (its route or its sign-in is gone)', spec.to, spec.from)
        } else if (route.state === 'ready') {
          // A sign-in read newer than the move: these never need the repair above.
          for (const bot of recorded) {
            const record = bot.subscriptionMoved
            if (record.confirmed === true) continue
            // Too soon after the move: this "signed in" may be older than it. Look once more.
            const early = at > 0 ? at + CONFIRM_AFTER_MS - now : 0
            if (early > 0) {
              lookAgain(Math.min(early, CONFIRM_AFTER_MS))
              continue
            }
            record.confirmed = true
            changed = true
          }
        } else if (unconfirmed && route.state === 'waiting') {
          unread = true
        }
      }

      if (listed === undefined) continue
      if (route.state !== 'ready') {
        const reason = route.state === 'waiting' ? route.reason : 'cli'
        reasons.set(spec.from, reason)
        // Neither a terminal sign-in nor a terminal account change is announced: look again later.
        if (reason === 'sign-in' || reason === 'account') lookAgain(SIGN_IN_RECHECK_MS)
        else if (route.state === 'waiting') unread = true
        continue
      }
      for (const bot of bots) {
        // The model a pending switch would go back to follows too, whatever the Bot is on now.
        const before = bot.previousModel
        const previous = movedRef(before, spec, listed)
        const target = movedRef(bot.model, spec, listed)
        if (previous !== undefined) bot.previousModel = previous
        const way = spec.restore === true
        if (target === undefined) {
          // Only what it would go back to moved. Another record on the Bot is never replaced.
          if (way && previous !== undefined && bot.subscriptionMoved === undefined) {
            bot.subscriptionMoved = { previousOnly: true, from: { previousModel: before }, previousTarget: previous }
          }
          continue
        }
        // What it would go back to is recorded only when it was not the Bot's own model: that
        // case the way back reads from the model itself.
        const apart = way && previous !== undefined && before !== bot.model
        bot.subscriptionMoved = {
          from: {
            model: bot.model,
            ...(bot.effort === undefined ? {} : { effort: bot.effort }),
            ...(apart ? { previousModel: before } : {}),
          },
          target,
          ...(apart ? { previousTarget: previous } : {}),
        }
        bot.model = target
        moved.push(bot)
      }
      done[spec.from] = true
      changed = true
      reasons.delete(spec.from)
      // One look after acp-dsh's kept answer has expired confirms the move or repairs it.
      if (spec.restore === true && bots.some(bot => recordOf(bot, spec) !== undefined)) {
        state.subscriptionMovedAt = { ...state.subscriptionMovedAt, [spec.from]: now }
        lookAgain(CONFIRM_AFTER_MS)
      }
    }

    // Three timed looks at a sign-in or CLI that gives no answer, then events only. Only a pass
    // that reads a definite answer starts the three again: an event does not (it neither uses
    // one up nor starts them over), or frequent events would have the CLI asked every minute
    // for as long as it gives none.
    if (!unread) attempt = 0
    else {
      if (timed) attempt += 1
      if (attempt < CHECK_BACKOFF_MS.length) lookAgain(CHECK_BACKOFF_MS[attempt])
    }
    waitingBy = new Map()
    for (const spec of SUBSCRIPTION_MOVES) {
      const reason = bots.some(bot => onRoute(spec, bot)) ? reasons.get(spec.from) : undefined
      if (reason !== undefined) waitingBy.set(spec.from, { to: spec.to, cli: spec.cli, reason })
      say(`wait:${spec.from}`, reason, 'ds-bot: Bots on %s stay there: %s %s', spec.from, spec.cli, WHY[reason])
    }
    if (!changed) return
    state.subscriptionCliMoved = done
    await rt.save()
    // A lock lost during the save leaves the file unchanged; do not move live Sessions to a
    // model the team file does not record.
    if (rt.readOnly?.() !== undefined) return
    const apply = rt.applyModel
    for (const { bot, from, to } of restored) {
      // A model picked during the save is the person's: their own switch selects it.
      if (bot.model !== to) continue
      rt.warn?.('ds-bot: %s moved back from %s to %s (its CLI cannot answer now)', bot.name, from, bot.model)
      if (typeof apply !== 'function') continue
      await apply(bot, { force: true })
        .catch(error => rt.warn('ds-bot: model for %s not restored: %s', bot.name, error))
    }
    for (const bot of moved) {
      rt.warn?.('ds-bot: %s moved from %s to %s (one sign-in per subscription)', bot.name, bot.subscriptionMoved.from.model, bot.model)
      if (typeof apply !== 'function') continue
      await apply(bot, { force: true })
        .catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    }
  }

  // A pass that has to look again schedules one more, the soonest asked for; acp-dsh announces
  // neither a finished probe nor a sign-in done in a terminal.
  let retryTimer
  let retryDue = 0
  let stopped = false
  function lookAgain(ms) {
    if (stopped) return
    const due = Date.now() + ms
    if (retryTimer !== undefined && retryDue <= due) return
    clearTimeout(retryTimer)
    retryDue = due
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void migrate({ timed: true })
    }, ms)
    retryTimer.unref?.()
  }
  ctx.effect?.(() => () => {
    stopped = true
    clearTimeout(retryTimer)
    retryTimer = undefined
  }, 'ds-bot: subscription move retry')

  // One pass at a time; an event during a pass gets a pass of its own after it. An event that
  // arrives while this pass asks acp-dsh (its `inspect` may publish its routes) gets one more
  // pass too, but that pass cannot earn another the same way: no loop through our own read.
  let running
  let again = false
  let echoed = false
  let echoPass = false
  const migrate = ({ timed = false } = {}) => {
    if (running !== undefined) {
      again = true
      return running
    }
    running = (async () => {
      let options = { timed }
      for (;;) {
        again = false
        echoed = false
        await move(options)
        options = {}
        if (!again && !(echoed && !echoPass)) break
        echoPass = !again
      }
    })()
      .catch(error => rt.warn('ds-bot: the subscription Bots were not moved to their CLI: %s', error))
      .finally(() => {
        running = undefined
        echoPass = false
        if (again) {
          again = false
          void migrate()
        }
      })
    return running
  }
  const heard = () => {
    if (probing) echoed = true
    else void migrate()
  }
  rt.moveSubscriptionBots = () => migrate()
  // The same rule for the other plugins that ask (Connect AI's duplicate of the Claude row).
  rt.anthropicSubscription = () => anthropicSubscription(ctx)
  rt.subscriptionWaitingView = () => (waitingBy.size === 0 ? {} : { subscriptionWaiting: Object.fromEntries(waitingBy) })

  // At start, and when a route or DSH's settings change: a CLI turned on later still takes the
  // team's subscription Bots. A sign-in acp-dsh announces (`acp-dsh/login-ready`) arrives through
  // cli-login.js, which already hears it and calls `moveSubscriptionBots`. `loader/volatile-update`
  // is not here: DSH keeps it inside the plugin whose config changed, so it never arrives.
  // The roster now loads synchronously; let the remaining modules install its helpers first.
  void Promise.resolve().then(() => rt.load()).then(() => migrate())
  for (const event of ['llm/adapters-updated', 'settings/document-updated']) ctx.on?.(event, heard)
}
