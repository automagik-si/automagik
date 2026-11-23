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

function shared(ctx, bot) {
  const people = bot.people
  if (people !== undefined && (people?.mode !== 'owners' || !Array.isArray(people.allow) || people.allow.length !== 0)) return true
  try {
    for (const runtime of ctx.registry.values()) {
      if (/liveshare/i.test(runtime.name) && [...runtime.fibers].some(fiber => fiber.state === 2)) return true
    }
    return false
  } catch { return true }
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

  function policyBlock(bot) {
    if (multiuserMode() || callerService(ctx)) return 'multiuser'
    if (modelKept(bot)) return 'model-kept'
    if (bot.kind !== undefined || (rt.isMain(bot.id) && rt.omniLinked?.())) return 'managed'
    if (shared(ctx, bot) || rt.imBoundBot?.(bot.id)) return 'shared'
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

  const ownChatBot = sessionId => rt.botOf(rt.chatOwners.get(sessionId))
  const nativeToolsEligible = sessionId => {
    const bot = ownChatBot(sessionId)
    return bot !== undefined && nativeToolsBlock(bot) === undefined
  }

  function endNativeTools(bot) {
    const acp = ctx.get('acpAgents')
    if (acp == null) return
    const sessions = [rt.chatOf(bot.id)]
    for (const owners of [rt.groupOwners, rt.pastOwners, rt.taskOwners]) {
      for (const [id, owner] of owners) if (owner.botId === bot.id) sessions.push(id)
    }
    // An older acp-dsh has no endNative: it ends Claude's processes only.
    const end = typeof acp.endNative === 'function' ? acp.endNative : acp.endClaudeSession
    for (const id of sessions) {
      try { end?.call(acp, id, NATIVE_OFF_TEXT, NATIVE_TOOLS_CHANGED_TEXT) }
      catch (error) { rt.warn('omni-ui: Session %s could not be ended: %s', id, error) }
      try { acp.endOmpSession?.(id, NATIVE_OFF_TEXT, NATIVE_TOOLS_CHANGED_TEXT) }
      catch (error) { rt.warn('omni-ui: omp Session %s could not be ended: %s', id, error) }
    }
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

  Object.assign(rt, {
    setNativeTools, endNativeTools, nativeToolsBlock, nativeToolsEligible,
    nativeToolsFor: sessionId => nativeToolsEligible(sessionId) && nativeToolsOn(ownChatBot(sessionId)),
  })
}
