import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { callerService, multiuserMode } from './multiuser.js'
import { refusal } from './refusal.js'
import { NATIVE_TOOLS_CHANGED_TEXT } from '../shared/held.js'
import { effectiveMarkOf, NATIVE_AGENTS, nativeToolsOn, restrictedBot } from '../shared/native-tools.js'

export const NATIVE_OFF_TEXT = 'Native tools were turned off for this Bot, so this answer stopped. Send your message again.'
export const NATIVE_TOOLS_BLOCK_TEXT = Object.freeze({
  multiuser: 'Native tools are not offered in a multi-user workspace yet.',
  'model-kept': "This model can't turn its native tools off.",
  managed: 'Not available for a Bot that operates Omni or that another plugin manages.',
  shared: 'Not available while this Bot is shared with other people or a sharing plugin (LiveShare) is installed.',
  restricted: 'Not available while this Bot has shell access off or denied tools.',
  'read-only': 'Not available at the Read only level.',
  'level-unknown': "Not available: the permission level of this Bot's chat could not be read.",
})

// A sharing plugin (LiveShare) that shares right now: one of its fibers is live. Throws when the
// registry cannot be read.
function liveShareActive(ctx) {
  for (const runtime of ctx.registry.values()) {
    if (/liveshare/i.test(runtime.name) && [...runtime.fibers].some(fiber => fiber.state === 2)) {
      return true
    }
  }
  return false
}

const levelBlock = mode => {
  if (mode === 'read-only') return 'read-only'
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') return 'level-unknown'
}

export function install(rt) {
  const { ctx } = rt
  const pending = new WeakMap()
  const sessionOf = bot => ctx.sessions?.get?.(rt.chatOf(bot.id))
  const defaultMode = bot => bot.permission === undefined ? ctx.get('sandboxPolicy')?.defaultMode
    : ctx.get('permissionPresets')?.resolve?.(bot.permission)?.sandbox

  function sandboxBlock(bot) {
    try {
      const session = sessionOf(bot)
      return levelBlock(session === undefined ? defaultMode(bot) : ctx.get('sandboxPolicy')?.resolve?.({ session })?.mode)
    } catch { return 'level-unknown' }
  }

  // A Codex model the switch never applies to: it launches with Codex's own tools in every
  // Session (acp-dsh agents.js `nativeKeptModels`). acp-dsh answers; no answer is not kept.
  const modelKept = bot => effectiveMarkOf(bot) === 'acp-codex' && (() => {
    try { return ctx.get('acpAgents')?.nativeModelKept?.(bot.model ?? bot.appliedModel) === true } catch { return false }
  })()

  // The lock the switch had before it applied in every chat of the Bot (#1564, RFC 0003,
  // Amendment: native tools in every chat of the Bot): `shared`, shared with people, bound to an
  // IM connection, or a live LiveShare share. It lives on only for the upgrade below and until it
  // has run on the host that writes the team. Any throw goes to the caller. `managed` is not
  // removed: Omni's plugin takes the tools of a Bot that operates it. A Main Bot with Omni
  // configured counts here too, read from the saved link, so the upgrade writes its ON off once
  // even while `omniLinked()` still reads false at host start (before `omniChannels` registers).
  function lockOf(bot, liveShare) {
    if (rt.isMain(bot.id) && (rt.omniLinked?.() === true || typeof rt.config?.omni?.url === 'string'
      || (typeof rt.home === 'string' && existsSync(join(rt.home, 'omni.json'))))) return 'shared'
    const people = bot.people
    if (people !== undefined && (people?.mode !== 'owners' || !Array.isArray(people.allow)
      || people.allow.length !== 0)) return 'shared'
    if (rt.imBoundBot?.(bot.id) === true || liveShare()) return 'shared'
  }

  // The one-time upgrade: a Bot that sat in the removed lock with the switch ON is turned off once,
  // so nothing gains native tools without the person. It runs at the first native read or switch
  // write on a host that writes the loaded team. Phase 1 only reads: a throw writes nothing,
  // sets no marker, warns once and is tried again at the next read. Phase 2 cannot throw: it
  // writes the Bots and the marker together. Bots already off are not written: the marker then
  // rides the next save.
  let retireWarned = false
  function retireRemovedLocks() {
    const state = rt.state
    if (state === undefined || state === null || state.nativeToolsLocksRetired === true) return
    let list
    try {
      if (rt.teamLoaded?.() !== true) return
      if (rt.holdsLock?.() !== true && rt.canWriteTeam?.() !== true) return
      const live = liveShareActive(ctx)
      list = Object.values(state.bots ?? {})
        .filter(bot => bot?.nativeTools === true && lockOf(bot, () => live) !== undefined)
    } catch (error) {
      if (!retireWarned) {
        retireWarned = true
        try { rt.warn('ds-bot: native tools upgrade check failed, retrying: %s', error) } catch {}
      }
      return
    }
    for (const bot of list) {
      bot.nativeTools = false
      delete bot.nativeToolsAgent
      delete bot.nativeToolsKept
    }
    state.nativeToolsLocksRetired = true
    if (list.length === 0) return
    const failed = (error) => {
      try { rt.warn('ds-bot: native tools upgrade was not saved yet: %s', error) } catch {}
    }
    try { void Promise.resolve(rt.save({ required: true })).catch(failed) }
    catch (error) { failed(error) }
  }

  function policyBlock(bot) {
    retireRemovedLocks()
    if (multiuserMode() || callerService(ctx)) return 'multiuser'
    if (modelKept(bot)) return 'model-kept'
    if (bot.kind !== undefined || (rt.isMain(bot.id) && rt.omniLinked?.())) return 'managed'
    // Until the upgrade has run, a Bot in the removed lock keeps it, as before.
    if (rt.state?.nativeToolsLocksRetired !== true) {
      try {
        const lock = lockOf(bot, () => liveShareActive(ctx))
        if (lock !== undefined) return lock
      } catch { return 'shared' }
    }
    if (restrictedBot(bot)) return 'restricted'
  }

  function nativeToolsBlock(bot) {
    return policyBlock(bot) ?? sandboxBlock(bot)
  }

  async function saveBlock(bot) {
    const block = policyBlock(bot)
    if (block !== undefined) return block
    const sessionId = rt.chatOf(bot.id)
    let handle
    try {
      if (sessionOf(bot) !== undefined) return sandboxBlock(bot)
      const persistence = ctx.get('sessionPersistence')
      if (typeof persistence?.open !== 'function') return 'level-unknown'
      handle = await persistence.open(sessionId, 'read')
      const { events } = await handle.read()
      const override = events.findLast(event => event.type === 'sandbox/mode')
      // A live Session may have appeared while the stored log was being read.
      if (sessionOf(bot) !== undefined) return sandboxBlock(bot)
      if (rt.chatOf(bot.id) !== sessionId) return 'level-unknown'
      return levelBlock(override?.data?.mode ?? ctx.get('sandboxPolicy')?.defaultMode)
    } catch (error) {
      if (error?.name === 'SessionPersistenceNotFoundError') return sandboxBlock(bot)
      return 'level-unknown'
    } finally {
      await handle?.close()
    }
  }

  // The Bot a Session runs as: its own chat, a group Session, a task, an earlier part, or a fresh
  // scheduled Session whose task belongs to one Bot (schedules.js).
  const sessionBot = sessionId =>
    rt.botOf(rt.selfOf?.(sessionId) ?? rt.scheduledNativeOwner?.(sessionId))
  // The switch applies in every Session of the Bot at that Session's own level.
  function sessionBlock(bot, sessionId) {
    let session
    try {
      session = ctx.sessions?.get?.(sessionId)
      if (session !== undefined) {
        return levelBlock(ctx.get('sandboxPolicy')?.resolve?.({ session })?.mode)
      }
    } catch { return 'level-unknown' }
    return sandboxBlock(bot)
  }
  const nativeToolsEligible = sessionId => {
    const bot = sessionBot(sessionId)
    return bot !== undefined && (policyBlock(bot) ?? sessionBlock(bot, sessionId)) === undefined
  }

  // Ends the native processes of one Session (every agent).
  function endNativeSession(id) {
    const acp = ctx.get('acpAgents')
    if (acp == null) return
    // An older acp-dsh has no endNative: it ends Claude's processes only.
    const end = typeof acp.endNative === 'function' ? acp.endNative : acp.endClaudeSession
    try { end?.call(acp, id, NATIVE_OFF_TEXT, NATIVE_TOOLS_CHANGED_TEXT) }
    catch (error) { rt.warn('omni-ui: Session %s could not be ended: %s', id, error) }
    try { acp.endOmpSession?.(id, NATIVE_OFF_TEXT, NATIVE_TOOLS_CHANGED_TEXT) }
    catch (error) { rt.warn('omni-ui: omp Session %s could not be ended: %s', id, error) }
  }

  function endNativeTools(bot) {
    if (ctx.get('acpAgents') == null) return
    const sessions = [rt.chatOf(bot.id)]
    for (const owners of [rt.groupOwners, rt.pastOwners, rt.taskOwners]) {
      for (const [id, owner] of owners) if (owner.botId === bot.id) sessions.push(id)
    }
    // Fresh scheduled Sessions of its tasks too.
    for (const id of rt.scheduledNativeSessions?.(bot.id) ?? []) sessions.push(id)
    for (const id of sessions) endNativeSession(id)
  }

  async function setNativeTools(id, patch, actorId) {
    const bot = rt.botOf(id)
    if (actorId !== undefined) throw refusal('Only the user can turn native tools on or off for ' + (bot?.name ?? 'this Bot'))
    if (Object.keys(patch).some(key => key !== 'id' && key !== 'nativeTools')) {
      throw refusal('Change native tools on their own, without other settings.')
    }
    const on = patch.nativeTools
    if (typeof on !== 'boolean') throw Object.assign(new Error('Native tools must be true or false.'), { code: 'bot/invalid' })
    if (bot === undefined) throw refusal('Unknown Bot')
    // ON is for the agent the Bot runs on when it is asked, and only for that agent.
    const mark = effectiveMarkOf(bot)
    if (on) {
      if (!NATIVE_AGENTS.includes(mark)) throw refusal("Native tools are not offered for this Bot's agent.")
      const block = await saveBlock(bot) ?? policyBlock(bot)
      if (block !== undefined) throw refusal(NATIVE_TOOLS_BLOCK_TEXT[block])
      if (rt.botOf(id) !== bot || effectiveMarkOf(bot) !== mark) throw refusal('The Bot team changed. Try again.')
    }
    // An ON saved for another agent is not ON here: turning it on writes this agent.
    const previous = on ? nativeToolsOn(bot) : bot.nativeTools === true
    const saved = { nativeTools: bot.nativeTools, nativeToolsAgent: bot.nativeToolsAgent, nativeToolsKept: bot.nativeToolsKept }
    const untagged = saved.nativeToolsKept === undefined && (on || saved.nativeToolsAgent === undefined)
    if (previous === on && untagged && !pending.has(bot)) return bot
    const change = {}
    pending.set(bot, change)
    if (!on) {
      delete bot.nativeTools
      delete bot.nativeToolsAgent
      delete bot.nativeToolsKept
      endNativeTools(bot)
    }
    try {
      await rt.save({ required: true, ...(on ? { enableNativeTools: bot, nativeToolsAgent: mark } : {}) })
      if (on && pending.get(bot) === change && rt.botOf(id) === bot) {
        bot.nativeTools = true
        bot.nativeToolsAgent = mark
        delete bot.nativeToolsKept
      }
    } catch (error) {
      if (!on && pending.get(bot) === change) {
        for (const [key, value] of Object.entries(saved)) if (value !== undefined) bot[key] = value
      }
      throw error
    } finally {
      if (pending.get(bot) === change) pending.delete(bot)
    }
    return bot
  }

  // Read only: whether the Bot's switch is ON for the agent it runs on and no Bot-wide lock
  // blocks it (a managed Bot, one that operates Omni included, always reads false).
  const nativeToolsBotOn = botId => {
    const bot = rt.botOf(botId)
    return bot !== undefined && policyBlock(bot) === undefined && nativeToolsOn(bot)
  }

  Object.assign(rt, {
    setNativeTools, endNativeTools, endNativeSession, nativeToolsBlock, nativeToolsEligible,
    nativeToolsBotOn,
    nativeToolsFor: sessionId =>
      nativeToolsEligible(sessionId) && nativeToolsOn(sessionBot(sessionId)),
  })
}
