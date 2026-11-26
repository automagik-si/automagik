// Omni: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file in Omni's own home so they survive restarts without new Session event
// types. That home is $AUTOMAGIK_BOTS_HOME, else $AUTOMAGIK_HOME/bots (~/.automagik/bots),
// never under DSH_HOME: installed into someone's own DSH, the team keeps its files apart from
// DSH's and from other plugins'.
import { randomBytes } from 'node:crypto'
import fs, { cpSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { selectorRoutePolicy } from './src/shared/routes.js'
import { DEFAULT_ROUTE_POLICY } from './src/shared/route-policy.js'
import * as diagnostics from './src/host/diagnostics.js'
import * as extend from './src/host/extend.js'
import * as store from './src/host/store.js'
import { CONNECTOR_KEY, CONNECTOR_KEY_ORIGINS, connectorKeyOriginName, keyFileName, publishConnectorKey, readConnectorKey, readConnectorKeyOrigins } from './src/host/connectors/credential-key.js'
import { checkImportedCredentials } from './src/host/connectors/credential-state.js'
import { writeBytesAtomic } from './src/host/supervisor/store.js'
import * as addressPolicy from './src/host/address-policy.js'
import * as models from './src/host/models.js'
import * as modelState from './src/host/model-state.js'
import * as modelAccessHooks from './src/host/model-access-hooks.js'
import * as cliLogin from './src/host/cli-login.js'
import { RESERVATION_FILE } from './src/host/account-reservations.js'
import { createMachineRecord, reservationsDir } from './src/host/machine-reservations.js'
import { userName } from './src/host/user-name.js'
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
import * as nativeTools from './src/host/native-tools.js'
import * as ownTools from './src/host/own-tools.js'
import * as installed from './src/host/installed.js'
import * as folders from './src/host/folders.js'
import * as privateBots from './src/host/private-bots.js'
import * as agents from './src/host/agents.js'
import * as toolDeny from './src/host/tool-deny.js'
import * as reviewMark from './src/host/review-mark.js'
import * as reviewGuard from './src/host/review-guard.js'
import * as botRunner from './src/host/bot-runner.js'
import * as botSessions from './src/host/bot-sessions.js'
import * as readScope from './src/host/read-scope.js'
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
import * as wakeLog from './src/host/wake-log.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as callerAccess from './src/host/caller-access.js'
import * as callerView from './src/host/caller-view.js'
import * as callerFeed from './src/host/caller-feed.js'
import * as callerRoutes from './src/host/caller-routes.js'
import * as images from './src/host/images.js'
import * as avatarLibrary from './src/host/avatar-library.js'
import * as browser from './src/host/browser.js'
import * as imagegen from './src/host/imagegen.js'
import * as sharedUploads from './src/host/shared-uploads.js'
import * as browserPlugins from './src/host/browser-plugins.js'
import * as computer from './src/host/computer/index.js'
import * as secrets from './src/host/secrets.js'
import { dropUnlockVariables } from './src/host/unlock-env.js'
import * as connectors from './src/host/connectors/index.js'
import * as capabilities from './src/host/capabilities.js'
import * as learning from './src/host/learning.js'
import * as schedules from './src/host/schedules.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as selfUpdate from './src/host/self-update.js'
import * as selfUpdateCheck from './src/host/self-update-check.js'
import * as selfUpdateHold from './src/host/self-update-hold.js'
import * as dshUpdate from './src/host/dsh-update.js'
import * as thinking from './src/host/thinking.js'
import * as fallback from './src/host/fallback.js'
import * as channel from './src/host/channel.js'
import * as codeSide from './src/host/code-side.js'
import * as codeStart from './src/host/code-start.js'
import * as automations from './src/host/automations.js'
import * as accounts from './src/host/accounts.js'
import * as agentSpace from './src/host/agent-space.js'
import * as feed from './src/host/feed.js'
import * as genui from './src/host/genui.js'
import * as appManifest from './src/host/app-manifest.js'
import * as pocketChat from './src/host/pocket-chat.js'
import * as grants from './src/host/grants.js'
import * as skillLibrary from './src/host/skill-library.js'
import * as skillLibraryCall from './src/host/skill-library-call.js'
import * as seatChat from './src/host/seat-chat.js'
import * as hermesRemote from './src/host/hermes-remote.js'
import * as officeSkills from './src/host/office-skills.js'
import * as goalSkills from './src/host/goal-skills.js'

export { COLORS } from './src/host/constants.js'

export const name = 'omni-ui'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

const random = (size, encoding) => randomBytes(size).toString(encoding)
const sleepWord = new Int32Array(new SharedArrayBuffer(4))
const sleep = ms => Atomics.wait(sleepWord, 0, 0, ms)

const machineOf = rt => rt.machineRecord ??= createMachineRecord({
  fs, platform: process.platform, pid: process.pid, dir: () => reservationsDir(),
  uid: () => process.getuid?.(), random, now: Date.now, wait: sleep, userName,
})
const instanceId = () => process.env.AUTOMAGIK_INSTANCE_ID

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
// Upstream's chat-app layer (src/host/im) and its local agents (src/host/local-agents) are carried but not
// installed: channels are Omni's, and a local CLI runs a Bot through the ACP plugin's routes only.
const MODULES = [
  diagnostics, extend, store, ledger, addressPolicy, models, acpAdoption, subscriptionMove, providers, permissions, auto, ladder, autoJudge, permissionDiagnostics,
  turns, steer, handoffs, requests, delivery, roster, nativeTools, ownTools, installed, folders, agents, toolDeny, reviewMark, reviewGuard, botSessions, botRunner, readScope, privateBots, prompt, timeContext,
  tools, chatIndex, groups, goals, approvals, stops, whoRefused, subagentAsks, resume, wakeLog, memory,
  parts, callerAccess, callerView, callerFeed, callerRoutes, fallback, modelState,
  { install: rt => modelAccessHooks.install(rt, { machine: machineOf(rt), instanceId }) },
  { install: rt => cliLogin.install(rt, {
    path: join(rt.home, RESERVATION_FILE), fs, pid: process.pid,
    random,
    decodeKey: key => Buffer.from(key, 'base64url'),
    instanceId, machine: machineOf(rt),
  }) },
  sharedUploads, images, imagegen,
  avatarLibrary, secrets, connectors, capabilities, learning, schedules, browser, browserPlugins, computer, usage,
  update, selfUpdate, selfUpdateCheck, selfUpdateHold, dshUpdate, thinking, agentSpace, feed, codeSide, codeStart, automations, accounts, genui, channel, appManifest, pocketChat, seatChat, hermesRemote,
  officeSkills, goalSkills, grants, skillLibrary, skillLibraryCall,
]

// Other Omni plugins inject the runtime as `omniTeam` and add to it through rt.hooks
// (src/host/extend.js): Omni's channels and automations (@automagik/omni-channels-dsh),
// its canvases (@automagik/omni-canvas-dsh).
export function apply(ctx, config = {}) {
  const dropped = dropUnlockVariables()
  const rt = createRuntime(ctx, config)
  if (dropped > 0) rt.warn('ds-bot: removed %d password-manager unlock variable(s) from the Bot environment', dropped)
  ctx.provide('omniTeam', rt)
  // The plugin's own scope owns the team's end: when this plugin stops (a reload, the app
  // closing, the host unloading), every module lets go — the Code side's streams send their
  // CLOSE to herdr-core there.
  ctx.effect(() => () => rt.dispose(), 'omni-ui: stop the team modules')
}

// A team kept elsewhere before (config.importHome, e.g. ~/.dsh/bot) is copied in once,
// when the home has no team yet. Only on request: the source is left as it was.
function importTeam(home, from) {
  if (!from) return false
  const sourceState = join(from, 'state.json')
  const destinationState = join(home, 'state.json')
  if (existsSync(destinationState) || !existsSync(sourceState)) return false
  const skillNames = new Set(['skill-library', skillLibrary.SKILL_REVIEW_KEY, skillLibrary.SKILL_IMPORT_MARK])
  const skillAlias = name => name.toLowerCase().replace(/[ .]+$/, '')
  const skillSources = fs.readdirSync(from, { withFileTypes: true }).filter(entry => skillAlias(entry.name) === 'skill-library')
  if (skillSources.some(entry => entry.name !== 'skill-library' || !entry.isDirectory()) ||
      (existsSync(home) && fs.readdirSync(home).some(name => skillNames.has(skillAlias(name))))) {
    throw new Error('The imported team has an ambiguous Skills library destination.')
  }
  const copyHome = keyed => cpSync(from, home, { recursive: true, force: false, filter: source => {
    if (source.endsWith('state.lock') || /[\\/]wake\.jsonl\.[^\\/]*\.tmp$/.test(source)) return false
    if (dirname(source) !== from) return true
    const name = basename(source)
    const alias = skillAlias(name)
    return alias !== skillLibrary.SKILL_REVIEW_KEY && alias !== skillLibrary.SKILL_IMPORT_MARK &&
      !keyFileName(name) && name !== CONNECTOR_KEY_ORIGINS && (!keyed || source !== sourceState)
  } })
  const stateBytes = fs.readFileSync(sourceState)
  const sourceKey = readConnectorKey(join(from, CONNECTOR_KEY))
  checkImportedCredentials(stateBytes, sourceKey)
  if (skillSources.length) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    writeBytesAtomic(join(home, skillLibrary.SKILL_IMPORT_MARK), 'unverified\n', { durable: true, exclusive: true })
  }
  if (sourceKey.missing) {
    copyHome(false)
    return true
  }
  if (sourceKey.bytes === undefined) throw new Error('The imported Bot team needs a readable connector key.')

  const destinationPath = join(home, CONNECTOR_KEY)
  const checkDestination = () => {
    const destination = readConnectorKey(destinationPath)
    if (!destination.missing && !destination.bytes?.equals(sourceKey.bytes)) throw new Error('The imported Bot team needs a matching connector key.')
    return destination
  }
  const destination = checkDestination()
  // Remember the other homes that hold this key before publishing the copy.
  const origins = new Set([from, fs.realpathSync(from), ...readConnectorKeyOrigins(from)])
  const originDir = join(home, CONNECTOR_KEY_ORIGINS)
  fs.mkdirSync(originDir, { recursive: true, mode: 0o700 })
  for (const origin of origins) {
    writeBytesAtomic(join(originDir, connectorKeyOriginName(origin)), origin, { durable: process.platform !== 'win32' })
  }
  if (destination.missing) {
    try { publishConnectorKey(destinationPath, sourceKey.bytes) } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      checkDestination()
    }
  }
  copyHome(true)
  if (checkDestination().missing) throw new Error('The imported Bot team needs a matching connector key.')
  try { writeBytesAtomic(destinationState, stateBytes, { exclusive: true }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return false
  }
  return true
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(process.env.DSH_HOME)
  const home = folders.expandPath(config.home ?? folders.teamHomeOf(process.env))
  const imported = importTeam(home, config.importHome && folders.expandPath(config.importHome))
  const rt = {
    ctx,
    config,
    routePolicy: selectorRoutePolicy(config.routePolicy ?? DEFAULT_ROUTE_POLICY),
    get taskRoutePolicy() {
      return selectorRoutePolicy(config.routePolicy === undefined ? this.state?.taskRoutePolicySeed : config.routePolicy)
    },
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
  const disposers = []
  for (const module of MODULES) {
    const dispose = module.install(rt)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  let disposed = false
  rt.dispose = () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) { rt.warn?.('omni-ui: a module did not stop cleanly: %s', error?.message ?? error) }
    }
  }
  // Cordis runs prepended listeners newest first: the review guard, Auto, person grants, Pocket,
  // then the team card.
  autoJudge.installAhead(rt)
  reviewGuard.installAhead(rt)
  const disposeHold = botSessions.installAhead(rt)
  if (disposeHold !== undefined) disposers.push(disposeHold)
  const disposeRunner = botRunner.installAhead(rt)
  if (disposeRunner !== undefined) disposers.push(disposeRunner)
  // A live Agent can be scoped before the final module adds its tools; complete that scope now.
  rt.syncScopedTools?.()
  // Reloading the plugin while DSH is live must retain turns and child agents already running.
  void rt.adoptLiveWork?.().catch(error => rt.warn?.('omni-ui: adopting the work still running failed: %s', error))
  void rt.resumeFallbackWayBacks?.().catch(error => rt.warn?.('ds-bot: resuming model fallback failed: %s', error))
  if (imported) rt.warn?.('omni-ui: copied the team from %s into %s', config.importHome, home)
  return rt
}
