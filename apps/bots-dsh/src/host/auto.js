import { MARK_LEVEL, markOf, judgeOf, OWN_MODE_MARKS } from '../shared/permission-levels.js'

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

export function install(rt) {
  const { ctx, state } = rt
  const inflight = new Map()
  const acp = () => ctx.get?.('acpAgents')
  const presets = () => ctx.get?.('permissionPresets')
  const sessionOf = id => (ctx.sessions?.list?.() ?? []).find(session => session?.id === id)
  const presetOK = () => {
    const spec = presets()?.resolve(MARK_LEVEL)
    return spec?.sandbox === 'workspace-write' && spec?.approval === 'ask'
  }
  const owner = id => rt.botOf(rt.chatOwners.get(id) ?? state.tasks?.[id]?.from)
  const inherited = (bot, id) => {
    const task = state.tasks?.[id]
    return task?.from === bot.id && task.status === 'working' && task.auto === bot.permissionAuto && task.autoRev === (bot.permissionRev ?? 0) && !task.roomId && !task.levelRoomId && !task.levelTaskId && !task.permissionCap
  }
  const movePermissionRev = bot => { bot.permissionRev = (Number.isInteger(bot.permissionRev) ? bot.permissionRev : 0) + 1 }
  function autoWhy(bot, { sessionId, session, route, provider, view } = {}) {
    if (!rt.holdsLock() || !rt.teamLoaded()) return 'lock'
    if (judgeOf(bot.permissionAuto) === undefined || bot.permission !== MARK_LEVEL) return 'level'
    if (rt.chatOwners.get(sessionId) !== bot.id && !inherited(bot, sessionId)) return 'session'
    if (session !== undefined && (presets()?.current(session) !== MARK_LEVEL || !presetOK() || rt.levelHeld(sessionId))) return 'preset'
    if (markOf(route ?? provider) !== bot.permissionAuto || markOf(bot.model) !== bot.permissionAuto) return 'route'
    if (view) {
      const by = judgeOf(bot.permissionAuto)
      if (['codex', 'claude'].includes(by) && acp()?.ownModeOf?.(bot.permissionAuto)?.answerer !== true) return 'agent'
      if (by === 'team' && !rt.cachedBackground?.()) return 'judge'
    }
    return undefined
  }
  function autoOffer(bot) {
    try {
      const mark = markOf(bot.model)
      const by = judgeOf(mark)
      const ready = by === 'own' || (by === 'team' ? !!rt.cachedBackground?.() : acp()?.ownModeOf?.(mark)?.answerer === true)
      return { offered: mark !== undefined && markOf(bot.appliedModel) === mark && !rt.hostOwned?.(bot) && presetOK() && rt.holdsLock() && ready }
    } catch { return { offered: false } }
  }
  function autoViewOf(bot) {
    const out = autoOffer(bot).offered ? { autoOffered: true } : {}
    if (out.autoOffered || bot.permissionAuto) {
      const mark = bot.permissionAuto ?? markOf(bot.model)
      const by = judgeOf(mark)
      const bridged = acp()?.ownModeOf?.(mark)?.bridged === true
      const ref = by === 'own' ? bot.model : by === 'team' || bridged ? rt.cachedBackground?.() : undefined
      const catalog = rt.cachedCatalog?.()
      const model = Array.isArray(catalog) ? catalog.find(entry => entry.ref === ref)?.name ?? ref : ref
      out.autoJudge = { by, bridged, model }
    }
    if (bot.permissionAuto) {
      try {
        const id = rt.chatOf(bot.id)
        if (autoWhy(bot, { sessionId: id, session: sessionOf(id), route: bot.appliedModel, view: true }) !== undefined) out.permissionFallback = MARK_LEVEL
      } catch { out.permissionFallback = MARK_LEVEL }
    }
    return out
  }
  function autoFactsOf(sessionId, session) {
    const bot = owner(sessionId)
    if (!bot?.permissionAuto || (rt.chatOwners.get(sessionId) !== bot.id && !state.tasks?.[sessionId]?.auto)) return undefined
    try {
      const why = autoWhy(bot, { sessionId, session, route: bot.appliedModel, view: true })
      return { counts: why === undefined, why, by: judgeOf(bot.permissionAuto) }
    } catch { return { counts: false, why: 'agent', by: judgeOf(bot.permissionAuto) } }
  }
  function endAuto(bot, ids) {
    ids ??= [rt.chatOf(bot.id), ...Object.entries(state.tasks ?? {}).filter(([, task]) => task.from === bot.id && task.status === 'working' && task.auto).map(([id]) => id)]
    rt.dropAutoGrants?.(ids)
    for (const id of ids) { try { acp()?.endSession?.(id) } catch {} }
  }
  async function clearAuto(bot) {
    await inflight.get(bot.id)?.catch(() => {})
    movePermissionRev(bot)
    if (!bot.permissionAuto) return
    delete bot.permissionAuto
    endAuto(bot)
    await rt.save({ required: true })
  }
  function sweepAuto() {
    for (const bot of Object.values(state.bots)) {
      if (!bot.permissionAuto || (bot.permission === MARK_LEVEL && markOf(bot.model) === bot.permissionAuto)) continue
      delete bot.permissionAuto
      movePermissionRev(bot)
      endAuto(bot)
    }
  }
  async function setBotAuto(id, rev) {
    const bot = rt.botOf(id)
    if (!bot) throw refused('Unknown Bot')
    const stale = () => refused(`${bot.name}'s permissions changed meanwhile, so nothing was saved. Look again and choose.`)
    if (!Number.isInteger(rev) || rev !== (bot.permissionRev ?? 0)) throw stale()
    if (!autoOffer(bot).offered) throw refused(`Auto is not offered for ${bot.name} here.`)
    if (bot.permissionAuto === markOf(bot.model)) return bot
    if (inflight.has(id)) { await inflight.get(id).catch(() => {}); throw stale() }
    const run = (async () => {
      const next = { permission: MARK_LEVEL, permissionAuto: markOf(bot.model), permissionRev: rev + 1 }
      const before = bot.permission
      const writing = rt.saveCopy(copy => Object.assign(copy.bots[id], next))
      const revision = state.revision
      await writing
      if (rt.botOf(id) !== bot || (bot.permissionRev ?? 0) !== rev) { void rt.save(); throw stale() }
      Object.assign(bot, next)
      try {
        if (state.revision > revision) await rt.save({ required: true })
      } catch (error) {
        if (before === undefined) delete bot.permission
        else bot.permission = before
        delete bot.permissionAuto
        movePermissionRev(bot)
        endAuto(bot)
        throw error
      }
      try { await rt.levelTo(bot, MARK_LEVEL, { before }) } catch (error) {
        if (error?.levelNotApplied === true) throw error
        delete bot.permissionAuto
        movePermissionRev(bot)
        endAuto(bot)
        await rt.save({ required: true })
        throw error
      }
      return bot
    })()
    inflight.set(id, run)
    try { return await run } finally { if (inflight.get(id) === run) inflight.delete(id) }
  }
  function autoOpener() {
    const sessionId = rt.callerSessionId()
    const bot = rt.botOf(rt.chatOwners.get(sessionId))
    if (!bot || (OWN_MODE_MARKS.includes(bot.permissionAuto) && acp()?.ownModeIn?.(sessionId) !== true)) return undefined
    try {
      const session = sessionOf(sessionId)
      const config = session?.requestHeader?.()?.config
      const route = config?.provider && config?.model ? `${config.provider}/${config.model}` : bot.appliedModel
      if (autoWhy(bot, { sessionId, session, route }) === undefined) return { route: bot.permissionAuto, rev: bot.permissionRev ?? 0, botId: bot.id }
    } catch {}
    return undefined
  }
  async function markInherited(bot, route) {
    if (bot.permission !== MARK_LEVEL || markOf(bot.model) !== route) return
    try {
      const writing = rt.saveCopy(copy => Object.assign(copy.bots[bot.id], { permissionAuto: route, permissionRev: 1 }))
      const revision = state.revision
      await writing
      if (rt.botOf(bot.id) !== bot) return
      Object.assign(bot, { permissionAuto: route, permissionRev: 1 })
      if (state.revision > revision) await rt.save({ required: true })
    } catch (error) {
      delete bot.permissionAuto
      movePermissionRev(bot)
      endAuto(bot)
      rt.warn('ds-bot: inherited Auto was not saved: %s', error)
    }
  }
  const register = sub => {
    const off = sub.acpAgents?.ownMode?.(({ sessionId, agent, provider }) => {
      try {
        const bot = owner(sessionId)
        return bot !== undefined && autoWhy(bot, { sessionId, session: agent?.session, provider }) === undefined
      } catch { return false }
    })
    if (typeof off === 'function') sub.effect(() => off, 'ds-bot: own mode on agents')
  }
  Object.assign(rt, { movePermissionRev, autoWhy, autoOffer, autoViewOf, autoFactsOf, endAuto, clearAuto, sweepAuto, setBotAuto, autoOpener, markInherited,
    autoKey: () => Object.values(state.bots).filter(bot => bot.permissionAuto || autoOffer(bot).offered).map(bot => {
      let counts = false
      try {
        const id = rt.chatOf(bot.id)
        counts = autoFactsOf(id, sessionOf(id))?.counts === true
      } catch {}
      const { by, bridged, model } = autoViewOf(bot).autoJudge ?? {}
      return `${bot.id}:${autoOffer(bot).offered}${counts}:${by}${bridged ? 'b' : ''}${model ?? ''}`
    }).sort().join(',') })
  if (typeof ctx.inject === 'function') ctx.inject(['acpAgents'], register)
  else if (acp() !== undefined) register({ acpAgents: acp(), effect: (execute, label) => ctx.effect(execute, label) })
}
