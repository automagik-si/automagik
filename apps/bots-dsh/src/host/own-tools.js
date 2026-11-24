// A Bot that denies `acp_tool` is kept off a model that runs its own tools, and `acp_tool` is
// not added to the Denied tools of a Bot that runs on one (#2026, the owner's option A): such a
// model's own calls run without asking and the guard only sees them after they ran. Both checks
// refuse a save that MAKES the combination; a Bot already in it keeps running and may still
// edit everything else (the Details notice names what to change). No turn is ever refused here.
//
// Both checks are synchronous, so a caller runs them right before its write with no await
// between. A model not known to keep its own tools at save time passes (fails open): Codex's
// `default` before its start model is known, a model measured kept later, a missing or
// throwing `acpAgents`.
import { refusal } from './refusal.js'
import { switchPending } from './model-state.js'
import {
  OWN_TOOLS_AGENTS, OWN_TOOLS_DENY_TEXT, OWN_TOOLS_MODEL_TEXT, addsAcpToolDeny, deniesAcpTool,
} from '../shared/own-tools.js'

// Tagged so a caller (Pocket's settings) can tell this refusal from the rest.
const ownToolsRefusal = text => Object.assign(refusal(text), { ownTools: true })

export function install(rt) {
  const { ctx } = rt

  // Antigravity, or a Codex model acp-dsh knows keeps its own tools (agents.js
  // `nativeKeptModels` and the measured set). Hermes is not one: the owner left it out.
  function ownToolsRoute(ref) {
    if (typeof ref !== 'string' || ref === '') return false
    const provider = ref.split('/')[0]
    if (OWN_TOOLS_AGENTS.includes(provider)) return true
    if (provider !== 'acp-codex') return false
    try {
      return ctx.get?.('acpAgents')?.nativeModelKept?.(ref) === true
    } catch {
      return false
    }
  }

  // The model side: a move to a model that runs its own tools while `denyTools` holds
  // `acp_tool`. The Bot's current model is spared (a re-pick changes nothing).
  function assertOwnToolsModel(bot, { next, denyTools }, { text = OWN_TOOLS_MODEL_TEXT } = {}) {
    if (next === (bot?.model ?? bot?.appliedModel)) return
    if (deniesAcpTool(denyTools) && ownToolsRoute(next)) throw ownToolsRefusal(text)
  }

  // The deny side: adding `acp_tool` while the Bot runs on such a model, or while the way back
  // of a switch it has not confirmed yet is one. Nothing is checked unless the save adds it.
  // A model change still under way (another save's pick, or an update between its switch and
  // its end, `settlingModel`) refuses as busy: its rollback could put such a model back.
  // `self` counts the caller's own settling update.
  function assertOwnToolsDeny(bot, options) {
    const { next, self = false } = options
    if (!addsAcpToolDeny(bot.denyTools, next)) return
    // An agent switch under way is a model change too (RFC 0030, Handoff note).
    if (rt.pickingModel?.(bot.id) || rt.switchingChat?.(bot.id, { crossing: true }) || (rt.settlingModel?.(bot.id) ?? 0) > (self ? 1 : 0)) {
      throw refusal(`${bot.name} is already changing models.`)
    }
    const runsOn = Object.hasOwn(options, 'runsOn') ? options.runsOn : bot.model ?? bot.appliedModel
    const wayBack = Object.hasOwn(options, 'wayBack') ? options.wayBack
      : switchPending(bot) ? bot.previousModel : undefined
    // An agent switch that moved but has not answered yet can still go back to its old model.
    if (ownToolsRoute(runsOn) || ownToolsRoute(wayBack) || ownToolsRoute(rt.crossingWayBack?.(bot.id))) throw ownToolsRefusal(OWN_TOOLS_DENY_TEXT)
  }

  Object.assign(rt, { ownToolsRoute, assertOwnToolsModel, assertOwnToolsDeny })
}
