// A model that runs its own tools whatever the Bot's Denied tools say: its own calls run
// without asking and reach the deny guard only after they ran, as `acp_tool` (#2026). A Bot
// that denies `acp_tool` is kept off such a model, and `acp_tool` is not added to the Denied
// tools of a Bot that runs on one (the owner's option A). The host decides which models these
// are (host/own-tools.js) and marks them `ownTools` in the view; the client only reads that.

// Agents whose own tools always run: no bridge and no native-tools switch. Hermes is left out
// by the owner's decision on #2026. Revisit if acp-dsh gives Antigravity a bridge or a native
// switch (#2048). A Codex model is one when acp-dsh knows it keeps its own tools.
export const OWN_TOOLS_AGENTS = Object.freeze(['acp-antigravity'])

export const OWN_TOOLS_MODEL_TEXT = 'This Bot denies acp_tool, and this model runs its own tools anyway. '
  + 'Remove acp_tool from Denied tools first, or pick another model.'
export const OWN_TOOLS_MENU_HINT = 'Not with acp_tool denied'
export const OWN_TOOLS_DENY_TEXT = 'acp_tool cannot be denied while this Bot runs on a model that runs its own '
  + 'tools. Pick another model first.'
export const OWN_TOOLS_NOTICE = 'acp_tool is denied, but this model runs its own tools, so those calls still run '
  + 'and show as refused. Remove acp_tool from Denied tools in Bot settings, or pick another model.'
export const OWN_TOOLS_CREATE_TEXT = 'A Bot made by a Bot that denies acp_tool cannot run on a model that runs its '
  + 'own tools. Name another model.'

// Exact and case-sensitive, like the guard (host/tool-deny.js).
export const deniesAcpTool = list => Array.isArray(list) && list.includes('acp_tool')

// A save that adds `acp_tool` to the list; keeping or removing it is not one.
export const addsAcpToolDeny = (before, next) => deniesAcpTool(next) && !deniesAcpTool(before)

// A menu row the Bot cannot move to: the model runs its own tools and the Bot denies
// `acp_tool`. The Bot's own current model is never refused: it stays shown and ticked.
export const ownToolsRefused = (bot, entry) => entry?.ownTools === true && deniesAcpTool(bot?.denyTools)
  && entry.ref !== (bot.model ?? bot.appliedModel)

// A Bot already in the combination: it keeps running, and Details names what to change.
export const ownToolsNotice = bot => bot?.ownTools === true && deniesAcpTool(bot.denyTools)
