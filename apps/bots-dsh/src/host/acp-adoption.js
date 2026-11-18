// Claude on ACP (RFC 0003, delivery 4). The Claude Code plugin left Automagik and its Bots
// moved once to pi-ai's `anthropic` route (store.js, `claudeCodeMoved`). With dshTools on,
// those Bots move on to `acp-claude`, once per team (`claudeAcpMoved`), when the route can
// actually take them: the ACP plugin's per-session bridge is on and this build's
// delivery-4/6 probes pass, the adapter is installed, and the route lists the model. A Bot
// the person has changed since (or whose model the route does not list) is left alone.
//
// A moved Bot keeps the model and thinking level it had in `acpMoved`. With `dshTools` off, or
// the route gone, it moves back to exactly that. A Bot the person changed since keeps their
// pick: the record is dropped, never applied over it. The off flip is heard live through
// acp-dsh's `acp-dsh/dsh-tools-changed`: DSH's `loader/volatile-update` reaches only the plugin
// whose config changed, so the team cannot watch acp-dsh's setting there. That live path needs
// acp-dsh loaded; when the route is gone and the plugin absent (or the announcement never
// arrived), the start pass reads the route as gone here and reverses from the record then.
//
// `acpAgents.bridge()` runs a live probe on this machine: a fresh per-session credential, the
// bridge over stdio, MCP `initialize` and `tools/list`. A success is cached per installed
// adapter version; a failure is retried after ten minutes or the next start, so one slow start
// never blocks the move forever. An older ACP plugin has no such method and is not migrated.
//
// A Claude Pro or Max plan signs in only through Claude Code now (subscription-move.js): while
// pi-ai's `anthropic` route runs on that sign-in, the rollback never puts a Bot back on it. The
// record is dropped and the Bot stays on `acp-claude`, unavailable while that route is gone
// (turning Claude Code off turns it off for every Bot). A Bot subscription-move.js moved is its
// own record's, never rebuilt here from `claudeCodeModel`.
import { claudeFamilyOf, piAiClaudeOf } from './claude-models.js'
import { acpLoading, anthropicSubscription } from './subscription-move.js'

const ACP_AGENT = 'acp-claude'

/**
 * The `acp-claude/<model>` a Bot should move to, or undefined when it must stay.
 * `listed` is the model ids the route serves, as DSH lists them.
 * @param {any} bot
 * @param {string[]} listed
 */
export function acpClaudeTarget(bot, listed) {
  const moved = piAiClaudeOf(bot?.claudeCodeModel)
  // Still on the exact pi-ai model the earlier move picked: a Bot the person changed since
  // is theirs, and the route must name a model it serves.
  if (moved === undefined || bot.model !== moved) return undefined
  const model = moved.slice(moved.indexOf('/') + 1)
  if (listed.includes(model)) return `${ACP_AGENT}/${model}`
  // The agents' own catalog uses Claude Code's aliases (`opus`, `sonnet`, `haiku`), while
  // pi-ai names exact versions. Same family, same route; no listing means no move. Claude
  // Code's `default` names no family on its own, so the pi-ai model it became names it.
  const family = claudeFamilyOf(bot.claudeCodeModel) ?? claudeFamilyOf(`claude-code/${model}`)
  if (family !== undefined && listed.includes(family)) return `${ACP_AGENT}/${family}`
  return undefined
}

/**
 * What the `acp-claude` route is doing on this machine: `ready` with its listed models,
 * `waiting` while its plugin, adapter, catalog or CLI sign-in is not ready, `off` with
 * `dshTools` off, or `gone` when the route is no longer served (the plugin, the agent setting
 * or its CLI). A `gone` or `off` route is the rollback: moved Bots go back to before.
 * @returns {Promise<{ state: 'ready', listed: string[] } | { state: 'waiting' | 'off' | 'gone' }>}
 */
async function acpClaudeState(ctx) {
  const acp = ctx.get?.('acpAgents')
  if (acp === undefined || typeof acp.bridge !== 'function') {
    return { state: acpLoading(ctx) ? 'waiting' : 'gone' }
  }
  let bridge
  try {
    bridge = await acp.bridge()
  } catch {
    return { state: acpLoading(ctx) ? 'waiting' : 'gone' }
  }
  if (bridge?.on !== true) return { state: 'off' }
  // A bridge that does not pass its probe is not a route that disappeared: the agent may
  // still be served while its tools cannot reach DSH.
  if (bridge?.probesPass !== true) return { state: 'waiting' }
  let status
  let agent
  const agentOf = value => value?.agents?.find?.(row => row?.id === ACP_AGENT)
  try {
    status = await acp.status?.()
  } catch {
    return { state: 'waiting' }
  }
  agent = agentOf(status)
  if (agent === undefined) return { state: 'gone' }
  // Installing is a route on its way in; off, no CLI and a failed install are a route gone.
  // Ready without a model list is a route that is still here, its catalog not answered yet.
  if (!['installing', 'ready'].includes(agent?.connector?.state)) return { state: 'gone' }
  if (agent.connector.state !== 'ready' || agent.model?.listed !== true) {
    return { state: 'waiting' }
  }
  // The CLI's sign-in is cached by the ACP service until it refreshes. Ask on every pass that
  // finds the route otherwise ready, so a later sign-in moves the team at the next pass (the
  // next start or a settings/adapter change) with no separate action; not signed in is a route
  // that must not take anyone yet.
  if (agent?.signedIn !== true) {
    try {
      await acp.refresh?.()
    } catch {}
    try {
      status = await acp.status?.()
    } catch {
      // A read that fails after the ask is not a route that disappeared: leave everything as
      // it is (a transient failure must not trigger the restore).
      return { state: 'waiting' }
    }
    agent = agentOf(status)
    if (agent === undefined) return { state: 'gone' }
    if (agent.connector?.state !== 'ready' || agent.model?.listed !== true) {
      return { state: 'waiting' }
    }
    if (agent?.signedIn !== true) return { state: 'waiting' }
  }
  // Signed in, to an account the person has not confirmed for Bots (#869): the route takes no
  // one yet. Waiting, never gone: nothing already moved goes back for it.
  if (agent.consent === 'needed') return { state: 'waiting' }
  try {
    const models = await ctx.llm.listModels(ACP_AGENT)
    const listed = (Array.isArray(models) ? models : []).map(model => model?.id).filter(id => typeof id === 'string')
    return listed.length > 0 ? { state: 'ready', listed } : { state: 'waiting' }
  } catch {
    return { state: 'waiting' }
  }
}

// The record an ACP move writes, when the team moved before this record existed (the
// `claudeAcpMoved` flag alone): the pi-ai model is still recoverable from `claudeCodeModel`.
// Only a Bot still on the same family's route alias is recorded; one the person moved to
// another family or agent is left alone.
function priorMove(bot) {
  if (bot?.acpMoved !== undefined || typeof bot.claudeCodeModel !== 'string') return undefined
  if (typeof bot.model !== 'string' || !bot.model.startsWith(`${ACP_AGENT}/`)) return undefined
  if (bot.subscriptionMoved?.target === bot.model) return undefined
  const from = piAiClaudeOf(bot.claudeCodeModel)
  if (from === undefined) return undefined
  const previous = from.slice(from.indexOf('/') + 1)
  // `claude-code/default` names no family on its own; the pi-ai model it became does.
  const family = claudeFamilyOf(bot.claudeCodeModel) ?? claudeFamilyOf(`claude-code/${previous}`)
  const moved = bot.model.slice(ACP_AGENT.length + 1)
  if (moved !== family && moved !== previous) return undefined
  return {
    from: { model: from, ...(bot.effort === undefined ? {} : { effort: bot.effort }) },
    target: bot.model,
  }
}

export function install(rt) {
  const { ctx, state } = rt
  let running

  // A moved Bot goes back to exactly the model and thinking level it had. One the person
  // changed since keeps their pick: the record is dropped, never applied over it.
  const restore = async (removed = false) => {
    const restored = []
    let changed = false
    // Asked once per pass, and only when a record would go back to `anthropic`.
    let cliOnly
    const signInOnCli = async () => {
      cliOnly ??= anthropicSubscription(ctx).then(value => value === true, () => false)
      return cliOnly
    }
    for (const bot of Object.values(state.bots ?? {})) {
      const moved = bot?.acpMoved ?? (state.claudeAcpMoved === true ? priorMove(bot) : undefined)
      if (moved === undefined) continue
      const pickedModel = bot.model !== moved.target
      const pickedEffort = (bot.effort ?? undefined) !== (moved.from.effort ?? undefined)
      delete bot.acpMoved
      changed = true
      // The Claude plan's sign-in is Claude Code's alone: never back onto pi-ai's sign-in route.
      if (typeof moved.from.model === 'string' && moved.from.model.startsWith('anthropic/') && await signInOnCli()) continue
      // A route that went away cannot keep answering, so even a Bot whose level the person
      // changed goes back to its model; their level is kept. With dshTools off the route is
      // still there and a person's change wins: leave the Bot where they put it.
      if (pickedModel || (pickedEffort && !removed)) continue
      bot.model = moved.from.model
      if (!pickedEffort) {
        if (moved.from.effort === undefined) delete bot.effort
        else bot.effort = moved.from.effort
      }
      // The Session's record of the model it ran on goes with it, so the next sync selects
      // the restored model. The Session and its history stay.
      delete bot.appliedModel
      delete bot.appliedEffort
      restored.push(bot)
    }
    if (state.claudeAcpMoved === true) {
      delete state.claudeAcpMoved
      changed = true
    }
    if (!changed) return
    await rt.save()
    if (rt.readOnly?.() !== undefined) return
    for (const bot of restored) {
      const apply = rt.applyModel
      if (typeof apply !== 'function') break
      await apply(bot, { force: true })
        .catch(error => rt.warn('ds-bot: model for %s not restored: %s', bot.name, error))
    }
  }

  const move = async () => {
    await rt.load()
    // Nothing is written by a host that only reads the team; the writer moves or restores them.
    if (rt.readOnly?.() !== undefined) return
    // A team moved before this record existed: the pi-ai model is still recoverable from the
    // old ref, so the rollback has something exact to restore. The record is saved, so a
    // later pass cannot rebuild it from a level the person changed meanwhile.
    let recovered = false
    if (state.claudeAcpMoved === true) {
      for (const bot of Object.values(state.bots ?? {})) {
        if (bot?.acpMoved !== undefined) continue
        const record = priorMove(bot)
        if (record !== undefined) {
          bot.acpMoved = record
          recovered = true
        }
      }
    }
    const route = await acpClaudeState(ctx)
    if (route.state === 'off' || route.state === 'gone') {
      await restore(route.state === 'gone')
      return
    }
    if (route.state !== 'ready') {
      if (recovered) await rt.save()
      return
    }
    const moved = []
    const reapply = []
    let waiting = false
    let changed = recovered
    for (const bot of Object.values(state.bots ?? {})) {
      const prior = bot?.acpMoved
      if (prior !== undefined) {
        if (bot.model !== prior.target) {
          // The person moved the Bot off the route this record tracks: theirs from now on.
          delete bot.acpMoved
          changed = true
        } else if ((bot.effort ?? undefined) !== (prior.from.effort ?? undefined)) {
          // The person changed only the level: keep the record so a dead route can still
          // restore the model, and leave their pick exactly as it is.
        } else {
          reapply.push(bot)
        }
        continue
      }
      if (state.claudeAcpMoved === true) continue
      const target = acpClaudeTarget(bot, route.listed)
      if (target === undefined) {
        // Eligible but this route does not list its model yet: the next catalog may, so the
        // team is not marked done and the Bot is not touched.
        if (bot?.claudeCodeModel !== undefined && bot.model === piAiClaudeOf(bot.claudeCodeModel)) waiting = true
        continue
      }
      bot.acpMoved = {
        from: { model: bot.model, ...(bot.effort === undefined ? {} : { effort: bot.effort }) },
        target,
      }
      bot.model = target
      // The applied record is the target's once the re-apply below writes it: it is not
      // dropped here, so the Bot's level is never lost between the move and the target
      // answering. `applyModel` maps it to the agent's own `thought_level`.
      moved.push(bot)
      changed = true
    }
    if (state.claudeAcpMoved !== true && !waiting) {
      state.claudeAcpMoved = true
      changed = true
    }
    if (changed) await rt.save()
    // A lock lost during the save leaves the file unchanged; do not move live Sessions to a
    // model the team file does not record.
    if (rt.readOnly?.() !== undefined) return
    for (const bot of moved) {
      const apply = rt.applyModel
      if (typeof apply !== 'function') break
      // The thinking level is the Bot's own, resolved against the route just picked: the move
      // carries it where the agent offers it, never dropping it before the route answers.
      await apply(bot, { force: true })
        .catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    }
    // The agent's catalog may have landed after the move: re-apply the moved Bots so the
    // thinking level is set once the route can express it. A no-op when it already is.
    for (const bot of reapply) {
      const apply = rt.applyModel
      if (typeof apply !== 'function') break
      await apply(bot)
        .catch(error => rt.warn('ds-bot: thinking level for %s not applied: %s', bot.name, error))
    }
  }

  // One pass at a time. An event that arrives while a pass awaits the route sets `again`,
  // so an adapter that lands mid-pass still moves the team in a second pass.
  let again = false
  const migrate = () => {
    if (running !== undefined) {
      again = true
      return running
    }
    running = (async () => {
      for (;;) {
        again = false
        await move()
        if (!again) break
      }
    })()
      .catch(error => rt.warn('ds-bot: the Claude Bots were not moved to acp-claude: %s', error))
      .finally(() => {
        running = undefined
        // An event that landed after the loop's last check gets its own pass.
        if (again) {
          again = false
          void migrate()
        }
      })
    return running
  }

  // At start, and again when the ACP route or its settings change: an adapter installed
  // later, or dshTools turned on or off live, still moves or reverses the team. The last
  // event is acp-dsh's own, because DSH keeps `loader/volatile-update` inside the plugin
  // whose config changed.
  // The roster now loads synchronously; let the remaining modules install its helpers first.
  void Promise.resolve().then(() => rt.load()).then(migrate)
  const events = [
    'llm/adapters-updated',
    'settings/document-updated',
    'loader/volatile-update',
    'acp-dsh/dsh-tools-changed',
  ]
  for (const event of events) ctx.on?.(event, () => { void migrate() })
}
