// The Bot team's native-tools switch (#1564), one model for every agent it is offered on.
// Pure, so the client imports it too.
import { markOf } from './permission-levels.js'

/** The agents whose own tools the switch keeps or turns off. */
// Antigravity's is offered only with an acp-dsh that lists it (host/native-tools.js `unoffered`).
export const NATIVE_AGENTS = Object.freeze(['acp-claude', 'acp-codex', 'acp-omp', 'acp-antigravity'])

/** The agent a Bot runs on now: its own model, else the team default it was given. */
export const effectiveMarkOf = bot => markOf(bot?.model ?? bot?.appliedModel)

/**
 * The agent an ON was turned on for: the saved tag, else the omp migration's
 * (`nativeToolsKept`), else Claude's (an ON from before the switch named its agent).
 */
export const nativeAgentOf = bot => bot?.nativeTools === true
  ? (bot.nativeToolsAgent ?? bot.nativeToolsKept ?? 'acp-claude')
  : undefined

/** Whether the switch is ON for the agent the Bot runs on now. A move to another agent reads OFF. */
export const nativeToolsOn = bot => {
  const agent = nativeAgentOf(bot)
  return agent !== undefined && agent === effectiveMarkOf(bot)
}

/** Shell access off or denied tools: the agent's own tools would bypass both. */
export const restrictedBot = bot => bot?.shell === false || (Array.isArray(bot?.denyTools) && bot.denyTools.length > 0)
