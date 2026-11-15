// Omni: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file in Omni's own home so they survive restarts without new Session event
// types. That home is $AUTOMAGIK_BOTS_HOME, else $AUTOMAGIK_HOME/bots (~/.automagik/bots),
// never under DSH_HOME: installed into someone's own DSH, the team keeps its files apart from
// DSH's and from other plugins'.
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { selectorRoutePolicy } from './src/shared/routes.js'
import * as diagnostics from './src/host/diagnostics.js'
import * as extend from './src/host/extend.js'
import * as store from './src/host/store.js'
import * as addressPolicy from './src/host/address-policy.js'
import * as models from './src/host/models.js'
import * as modelState from './src/host/model-state.js'
import * as modelAccessHooks from './src/host/model-access-hooks.js'
import * as cliLogin from './src/host/cli-login.js'
import * as acpAdoption from './src/host/acp-adoption.js'
import * as subscriptionMove from './src/host/subscription-move.js'
import * as providers from './src/host/providers.js'
import * as permissions from './src/host/permissions.js'
import * as auto from './src/host/auto.js'
import * as ladder from './src/host/ladder.js'
import * as autoJudge from './src/host/auto-judge.js'
import * as permissionDiagnostics from './src/host/permission-diagnostics.js'
import * as turns from './src/host/turns.js'
import * as steer from './src/host/steer.js'
import * as handoffs from './src/host/handoffs.js'
import * as requests from './src/host/requests.js'
import * as delivery from './src/host/delivery.js'
import * as roster from './src/host/roster.js'
import * as folders from './src/host/folders.js'
import * as privateBots from './src/host/private-bots.js'
import * as agents from './src/host/agents.js'
import * as toolDeny from './src/host/tool-deny.js'
import * as prompt from './src/host/prompt.js'
import * as timeContext from './src/host/time-context.js'
import * as tools from './src/host/tools.js'
import * as chatIndex from './src/host/chat-index.js'
import * as groups from './src/host/groups.js'
import * as ledger from './src/host/books.js'
import * as goals from './src/host/goals.js'
import * as approvals from './src/host/approvals.js'
import * as stops from './src/host/stops.js'
import * as whoRefused from './src/host/who-refused.js'
import * as subagentAsks from './src/host/subagent-asks.js'
import * as resume from './src/host/resume.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as images from './src/host/images.js'
import * as avatarLibrary from './src/host/avatar-library.js'
import * as browser from './src/host/browser.js'
import * as imagegen from './src/host/imagegen.js'
import * as sharedUploads from './src/host/shared-uploads.js'
import * as browserPlugins from './src/host/browser-plugins.js'
import * as computer from './src/host/computer/index.js'
import * as secrets from './src/host/secrets.js'
import * as connectors from './src/host/connectors/index.js'
import * as capabilities from './src/host/capabilities.js'
import * as learning from './src/host/learning.js'
import * as schedules from './src/host/schedules.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as dshUpdate from './src/host/dsh-update.js'
import * as thinking from './src/host/thinking.js'
import * as fallback from './src/host/fallback.js'
import * as channel from './src/host/channel.js'
import * as agentSpace from './src/host/agent-space.js'
import * as feed from './src/host/feed.js'
import * as appManifest from './src/host/app-manifest.js'
import * as pocketChat from './src/host/pocket-chat.js'
import * as hermesRemote from './src/host/hermes-remote.js'
import * as officeSkills from './src/host/office-skills.js'
import * as goalSkills from './src/host/goal-skills.js'

export { COLORS } from './src/host/constants.js'

export const name = 'omni-ui'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
// Upstream's chat-app layer (src/host/im) and its local agents (src/host/local-agents) are carried but not
// installed: channels are Omni's, and a local CLI runs a Bot through the ACP plugin's routes only.
const MODULES = [
  diagnostics, extend, store, ledger, addressPolicy, models, acpAdoption, subscriptionMove, providers, permissions, auto, ladder, autoJudge, permissionDiagnostics,
  turns, steer, handoffs, requests, delivery, roster, folders, agents, toolDeny, privateBots, prompt, timeContext,
  tools, chatIndex, groups, goals, approvals, stops, whoRefused, subagentAsks, resume, memory, parts, fallback, modelState, modelAccessHooks, cliLogin, sharedUploads, images, imagegen,
  avatarLibrary, secrets, connectors, capabilities, learning, schedules, browser, browserPlugins, computer, usage,
  update, dshUpdate, thinking, agentSpace, feed, channel, appManifest, pocketChat, hermesRemote, officeSkills, goalSkills,
]

// Other Omni plugins inject the runtime as `omniTeam` and add to it through rt.hooks
// (src/host/extend.js): Omni's channels and automations (@automagik/omni-channels-dsh),
// its canvases (@automagik/omni-canvas-dsh).
export function apply(ctx, config = {}) {
  const rt = createRuntime(ctx, config)
  ctx.provide('omniTeam', rt)
}

// A team kept elsewhere before (config.importHome, e.g. ~/.dsh/bot) is copied in once,
// when the home has no team yet. Only on request: the source is left as it was.
function importTeam(home, from) {
  if (!from || existsSync(join(home, 'state.json')) || !existsSync(join(from, 'state.json'))) return false
  cpSync(from, home, { recursive: true, force: false, filter: source => !source.endsWith('state.lock') })
  return true
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = folders.expandPath(config.home ?? folders.teamHomeOf(process.env))
  const imported = importTeam(home, config.importHome && folders.expandPath(config.importHome))
  const rt = {
    ctx,
    config,
    routePolicy: selectorRoutePolicy(config.routePolicy),
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    // The Bot-only tools each module defines; tools.js registers them in each
    // Bot Session's own scope, never globally (see shareBotTools).
    teamTools: [],
    defaults: {
      mainName: config.mainName ?? 'Omni',
      mainRole: config.mainRole ?? 'Orchestrator',
    },
  }
  for (const module of MODULES) module.install(rt)
  // After every module: cordis runs prepended listeners newest first, so Auto's judge decides an approval before Pocket
  // (pocket-chat.js) or approvals.js could show it as the person's to answer (auto-judge.js installAhead).
  autoJudge.installAhead(rt)
  // A live Agent can be scoped before the final module adds its tools; complete that scope now.
  rt.syncScopedTools?.()
  // Reloading the plugin while DSH is live must retain turns and child agents already running.
  void rt.adoptLiveWork?.().catch(error => rt.warn?.('omni-ui: adopting the work still running failed: %s', error))
  if (imported) rt.warn?.('omni-ui: copied the team from %s into %s', config.importHome, home)
  return rt
}
