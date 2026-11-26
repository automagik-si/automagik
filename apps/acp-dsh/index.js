// Automagik ACP for DeepSeek Harness: agents other than DSH's own, over the Agent Client
// Protocol, as DSH models (RFC 0003). A Session on one keeps DSH's history and sidebar; the
// agent's tool calls show as DSH tool cards and ask through DSH's approval dialog.
//
// Host only: no browser half, so nothing here can stop the web UI from loading. An agent is
// offered only when its CLI is on this computer and its setting is on; with none, no route is
// registered at all. The set follows the settings and the CLIs live: turning an agent on or
// off, a CLI installed after DSH started (found by the service's refresh), and an adapter
// install that lands all reach the model picker without a restart (`llm/adapters-updated`).
//
// The `acpAgents` service tells a settings page (the welcome's Connect AI and its Settings
// section) what each agent has: its CLI, its connector (the ACP adapter), its sign-in, and
// whether its model is in the picker. Provisioning keeps its own CLI store; switches remain
// this plugin's live settings, written through DSH's settings service.
import { sessionFileConfig } from './src/host/session-files.js'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter, dirname, join, posix, sep } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { accountEvidenceOf, accountOf, accountView } from './src/host/account.js'
import { AcpAdapter, aside, BRIDGE_PATH, SIDE_MODEL } from './src/host/adapter.js'
import { AgentRun, isUnanswered } from './src/host/acp.js'
import { AGENTS, cliIdOf, findCommand, isNative, isolatedSignInHintOf, isSignInUrl, launchOf, signedInOf, signInHintOf } from './src/host/agents.js'
import { Backchannel } from './src/host/backchannel.js'
import { batchSafe } from './src/host/batch-spawn.js'
import { Catalog, cliStamp, DEFAULT_MODEL } from './src/host/catalog.js'
import { CliStore, CLI_CHECK_EVERY_MS } from './src/host/clis.js'
import { CliHomes, HOME_ENV, runCount, stopRuns } from './src/host/cli-homes.js'
import { canRunProfile, ensureChatProfiles } from './src/host/codex-chat-profiles.js'
import { NATIVE_OFF_UNAVAILABLE, nativeOffLaunch } from './src/host/codex-native.js'
import { CONSENT_FILE, ConsentStore } from './src/host/consent.js'
import { adaptersHome, AdapterStore, CHECK_TICK_MS, homeRelativeText, redactInstallerOutput } from './src/host/install.js'
import { installationCliHome, installationIdentity } from './src/host/installation.js'
import { handshake } from './src/host/handshake.js'
import { createIdentityReaders, IDENTITY_PROVIDERS } from './src/host/identity.js'
import { drawImage, imageRefusal, imageSupport, MAX_IMAGE_BYTES, SIGNED_OUT, UNAVAILABLE, unsupported } from './src/host/image.js'
import { CliLogins } from './src/host/login.js'
import { CREDENTIAL_ENV, URL_ENV } from './src/host/names.js'
import { writeOmpOverlay } from './src/host/omp-overlay.js'
import { AGY_OFF_CHECKED, AGY_OFF_SKILLS_NAME, agyExtensions, agyExtensionRefusal, agyOffCheck, agySkillsProofReader, writeAgyOff } from './src/host/agy-off.js'
import { PermissionDiagnostics } from './src/host/permission-diagnostics.js'
import { retiredLine } from './src/host/retired-home.js'
import { callbackOf, checkCallback, deliverCallback } from './src/host/sign-in-callback.js'
import { makeSignInOpener, readSignInLinks, removeSignInOpener, sweepSignInOpeners } from './src/host/sign-in-opener.js'
import { enginesFor, PRESSURE_METHOD, pressureGuard } from './src/host/pressure.js'
import { redactorFor } from './src/host/redact.js'
import {
  reservationDigests, reservationOutcome, validReservationDigest, validReservationKey,
} from './src/host/reservation-evidence.js'
import { agentRoute, carryEffort, crossed } from './src/host/switch.js'

export const name = 'acp-dsh'
export const inject = ['llm', 'agents', 'sessions']

// The bridge, its DSH approval, the drift detector and live switching: an absent key takes the
// per-agent default for the bridge (Claude on; Codex only on an explicit true), the transcript
// replay reaches both agents unless the key is false (plan A-5), and false is the kill switch.
// The key is public (installed teams keep it in their profile patch). DSH_TOOLS_DEFAULT is the
// Claude/service view used for the bridge probe, crossings and effort carry; it is not a schema
// default, so an absent key still reaches the adapter as absent.
export const DSH_TOOLS_DEFAULT = true

// claude, codex, hermes, antigravity, omp, sideModel, dshTools and nativeTools are live (volatile): DSH's settings service writes them
// without remounting the plugin, and loader/volatile-update brings the change here.
export const Config = z.object({
  claude: z.boolean().default(true).volatile().description(
    'Offer Claude Code with its own Bot sign-in and settings when the CLI is installed.',
  ),
  codex: z.boolean().default(true).volatile().description('Offer Codex as the acp-codex model when the codex CLI is installed.'),
  // The native-ACP agents (#959) are off until the person turns one on: none is installed by
  // Automagik, and turning one on is the person's word that the app may use the sign-in that CLI
  // already has on this computer, shared with their terminal.
  hermes: z.boolean().default(false).volatile().description('Offer Hermes as the acp-hermes model when the hermes CLI is installed. It runs `hermes acp` on the sign-in and settings Hermes already has on this computer.'),
  antigravity: z.boolean().default(false).volatile().description('Offer Antigravity as the acp-antigravity model when the agy CLI is installed. It runs `agy acp` in its own home in this installation, signed in from Settings, apart from the Antigravity sign-in in your terminal.'),
  omp: z.boolean().default(false).volatile().description('Offer omp as the acp-omp model when the omp CLI is installed. It runs `omp acp` on the sign-in and settings omp already has on this computer.'),
  sideModel: z.object({
    provider: z.string().required(),
    model: z.string().required(),
  }).default({ ...SIDE_MODEL }).volatile().description("The model that writes a Session's title when the Session is on an agent and DSH's default model is an agent too. Never an agent."),
  fakeAgent: z.string().description('Tests only: a script that speaks ACP, served as the acp-fake model. The command comes from these host settings, never from a client route.'),
  // No schema default: absent is the per-agent default (Claude Code on, because only its
  // adapter can drop the built-in tool set; Codex on for team Bots that need DSH's extras), and an
  // explicit true/false is the person's word. False is also the kill switch and the 2026-11-03
  // behaviour. A schema default would materialise true and erase the difference. Hidden from
  // settings forms (`.hidden()`): it is a rollback lever, not a preference, and stays writable
  // through DSH's settings service and the profile patch.
  dshTools: z.boolean().volatile().hidden().description([
    "Hand DSH's own tools to the agent over a per-session MCP bridge named dsh (the Session's",
    "preset, filtered by its level), approve every DSH tool call in DSH whatever the agent's own",
    "rules say, and turn the agent's built-in tools off where its adapter allows. On by default",
    "for Claude Code. Codex bridges on an explicit true or for a team Bot that needs DSH's extras.",
    'The transcript reaches either agent when a Session moves to it, whatever the',
    'bridge, unless this is false. False is the kill switch and the behaviour without it: each',
    'agent keeps its own tools and approvals, and sees only its own session.',
  ].join(' ')),
  // Native-tools mode (#1564). No schema default: absent is today's behaviour for everyone.
  // `true` is every Claude Code Session; an object turns it on per Bot (its name) or per DSH
  // Session id, so it can be on for one Bot only. Read at each turn's start: a flip takes
  // effect on that Session's next turn, in a new agent session. Hidden like dshTools: it is
  // written through DSH's settings service or the profile patch.
  nativeTools: z.union([z.boolean(), z.dict(z.boolean())]).volatile().hidden().description([
    "Claude Code keeps its own tools (Agent, Bash, Read, Edit, Write, Grep, Glob, Skill) and the dsh",
    "bridge adds only Automagik's extras; true for every Claude Code Session, or Bot names or",
    'Session ids to true for those only. Each native call still shows as a card and its',
    "permission request is answered by DSH's approval at the Session's level. Native commands and",
    "edits run in Claude Code, outside DSH's file sandbox.",
    "Ignored where the Bot team runs: there a Bot's own switch decides.",
  ].join(' ')),
})

export const SERVICE = 'acpAgents'
const FIRST_CHECK_MS = 5000
// A failed probe is retried after this long in the same process; a new process starts with an
// empty cache, so the next app start also retries. A success is kept for its adapter version.
export const PROBE_RETRY_MS = 10 * 60 * 1000
// How long one fresh sign-in check (`inspect`) stands for the same agent.
export const INSPECT_TTL_MS = 3000
// How long a confirmed "signed in" stands: `auth status` spawns the whole CLI, and a Bot's turn
// asks before its first call. A sign-in that ends meanwhile is caught by the agent itself: its
// ACP `auth_required` is MODEL_ACCESS_REQUIRED (adapter.js) and drops this answer at once.
export const SIGNED_IN_TTL_MS = 5 * 60 * 1000
// What a status row's `signInCheck` can say: why a sign-in check that ran could not tell.
const SIGN_IN_CHECKS = new Set(['timeout', 'unreadable'])
// A connector that is missing because npm could not be reached is tried again after each of
// these, then left to the timer that checks every few hours (#970): a laptop that started
// before its network was up does not wait for that timer.
export const CHECK_RETRY_MS = Object.freeze([1, 5, 15, 60].map(minutes => minutes * 60 * 1000))

// A live field is a reference ({ get() }) in the running fiber; a plain value elsewhere (tests).
export const flagOf = value => (typeof value?.get === 'function' ? value.get() : value)

// The Claude Code (and Bot-move) view of `dshTools`: absent means on, and only an explicit
// false is the kill switch. Per-agent bridging reads the raw setting in AcpAdapter.
export const dshToolsOn = (value) => {
  const read = flagOf(value)
  return (read === undefined ? DSH_TOOLS_DEFAULT : read) === true
}

// The Node that runs an adapter: the one running DSH (as Node when that is Electron's binary),
// never another node on the PATH, which may be too old for the adapter (Node 22 or newer).
export function nodeCommand() {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

function defaultCliHome(ctx, storeHome, identity) {
  const { root, owner } = installationCliHome(dirname(storeHome), undefined, {
    identity,
    warn: message => warn(ctx, message),
  })
  info(ctx, owner ? 'Bot sign-ins: this installation keeps the existing Bot sign-in home'
    : 'Bot sign-ins: this installation has its own Bot sign-in home')
  return root
}

/**
 * @param {any} ctx
 * @param {{ claude?: any, codex?: any, hermes?: any, antigravity?: any, omp?: any, sideModel?: any, fakeAgent?: string, dshTools?: any, nativeTools?: any }}
 *   [config]
 * @param {{ store?: any, cliStore?: any, find?: typeof findCommand, signedIn?: typeof signedInOf, catalogHome?: string, ompOverlayDir?: string, codexOffDir?: string, loginSpawn?: typeof spawn, loginTimers?: any, imageSetup?: (launch: any) => Promise<any>, installation?: string, cliHome?: string, evidenceOf?: typeof accountEvidenceOf }} [deps]
 *   catalogHome: where each agent's models and efforts are kept (beside the adapters by default).
 *   ompOverlayDir: overrides the private ACP state folder for omp's OFF overlay in tests.
 *   codexOffDir: where an OFF Codex's checked model catalogs are written (the ACP folder's
 *   `codex-native-off`, outside every Codex home), for tests.
 *   loginSpawn, loginTimers: tests only, a fake CLI process and clock for sign-in attempts.
 *   loginRecord: tests only, ownership records with a fake sign-in process.
 *   checkTimers: tests only, the clock of the retries after a connector check that failed.
 *   imageSetup: tests only, the image run's lockdown check (image.js imageSetup).
 *   account: reads which account a signed-in CLI is on (account.js); consentFile: where the
 *   person's word for each account is kept (consent.js), in the isolated CLI root by default.
 *   evidenceOf: a direct account read for the owner's reservation check (account.js).
 *   installation: the DSH home used for the default private CLI root. cliHome overrides that root.
 *   nativeSignInMs, nativeLogoutMs: how long an in-app sign-in (ACP `authenticate`) and a sign-out
 *   over ACP may take, shorter in tests. nativeSignInWindowMs: how long a sign-in link stays
 *   good from `authenticate` (shown as its expiry); nativeSignInCheckMs: how long agy has to
 *   finish once a pasted address was delivered (#2048, paste-back).
 *   logoutRun: fake logout runner for tests. A synthetic store
 *   without a home keeps the legacy in-memory test behavior; real stores always have a home.
 */
export function apply(ctx, config = {}, {
  store = new AdapterStore({ log: message => info(ctx, message) }),
  cliStore,
  find = name => findCommand(name), signedIn = signedInOf,
  catalogHome = typeof store.home === 'string' ? join(dirname(store.home), 'catalog') : undefined,
  ompOverlayDir = typeof store.home === 'string' ? join(dirname(store.home), 'omp')
    : typeof catalogHome === 'string' ? join(dirname(catalogHome), 'omp') : undefined,
  codexOffDir = typeof store.home === 'string' ? join(dirname(store.home), 'codex-native-off') : undefined,
  loginSpawn, loginTimers, loginRecord, loginProbe, imageSetup, account = accountOf, evidenceOf = accountEvidenceOf,
  installation = process.env.DSH_HOME,
  cliHome: override, consentFile: accountFile,
  logoutRun = execFile, checkTimers = globalThis, profileCheck = canRunProfile, agySkillsVersions,
  platform = process.platform,
  nativeSignInMs = 600_000, nativeLogoutMs = 30_000, nativeSignInLinkMs = 15_000,
  nativeSignInWindowMs = 240_000, nativeSignInCheckMs = 60_000,
} = {}) {
  // Windows has no Codex chat permission profiles (codex-chat-profiles.js). There, and only there,
  // an OFF Codex takes its legacy `read-only` mode as the backstop instead: adapter.js forces that
  // mode before every prompt and fails the turn when Codex does not offer it. Its own tools still
  // go through the checked config and the bridge is still forced. Elsewhere OFF needs the profiles.
  const offOnLegacyReadOnly = platform === 'win32'
  const identity = installationIdentity(installation)
  const cliHome = override === undefined && store.home ? defaultCliHome(ctx, store.home, identity) : override
  const consentFile = accountFile !== undefined ? accountFile
    : cliHome ? join(cliHome, CONSENT_FILE)
      : typeof store.home === 'string' && store.home === adaptersHome()
        ? join(dirname(store.home), CONSENT_FILE) : undefined
  const homes = cliHome === undefined ? undefined : new CliHomes(cliHome, {
    probe: loginProbe,
    acpHome: store.home ? dirname(store.home) : undefined,
    identity,
    onSelectionError: action => warn(ctx, `the selected Bot sign-in root could not be ${action}`),
    onRecordError: vendor => warn(ctx, `the ${vendor} generation record could not be saved at startup`),
    onRetired: (vendor, retired) => info(ctx, retiredLine(vendor, retired)),
  })
  // Antigravity has its own home too (#2048), on every installation with one, even while it is
  // off: its CliLogins recovery below does not apply (agy never has login trees).
  if (homes) for (const vendor of ['claude', 'codex', 'antigravity']) {
    try { homes.startup(vendor) } catch {} // Unproved abandoned homes remain untouched.
  }
  // Sign-in attempts' folders a crash left behind (signInNative's stand-in opener).
  if (homes) sweepSignInOpeners(homes.acpHome)
  if (homes) for (const vendor of ['claude', 'codex']) void homes.recoverLogins(vendor).catch(() => {})
  if (cliStore === undefined && !config.fakeAgent
    && (process.env.AUTOMAGIK_APP_BROWSER === '1' || process.env.AUTOMAGIK_PNPM)) {
    cliStore = new CliStore({ log: message => info(ctx, message),
      ...(homes ? { versionEnv: spec => homes.environment(spec.key) } : {}),
    })
  }
  const accountChanges = new Set()
  const loginLocks = new Set()
  let restarting = false
  let preparingRestart
  // The preparation finished: its stops are proved, so dispose has nothing left to stop.
  let prepared = false
  const restartGuard = () => {
    if (restarting) throw accountFailure('busy', 'Automagik is restarting.')
  }
  const authVersions = new Map()
  const agents = new Map()
  const log = message => info(ctx, message)
  if (config.fakeAgent) {
    const spawn = () => ({ command: process.execPath, args: [config.fakeAgent] })
    agents.set('acp-fake', {
      name: 'Fake agent',
      // Tests only: keep a test of the missing-bridge failure from waiting the real grace period.
      ...(Number(process.env.ACP_BRIDGE_READY_MS) > 0 ? { bridgeReadyMs: Number(process.env.ACP_BRIDGE_READY_MS) } : {}),
      catalog: new Catalog({ id: 'acp-fake', name: 'Fake agent', defaultName: 'Fake agent', fallback: [{ id: DEFAULT_MODEL, name: 'Fake agent' }], key: () => config.fakeAgent, spawn, log }),
      // The fake stands in for Claude Code where the bridge default is concerned: it declares
      // the adapter switch that drops its own built-in tool set.
      disableBuiltInTools: true,
      spawn,
    })
  }
  const backchannel = new Backchannel({ ctx, log })
  const redact = redactorFor(ctx)
  // The chat's image keeper (`keepImages`): where an image an agent makes in a chat is kept so the
  // chat can show it. One at a time; the Bot team registers its images folder.
  let imageKeeper
  const identityReaders = createIdentityReaders(message => warn(ctx, message))
  // The turn gates (`holdTurns`): each registrant's own entry, so one never replaces another's.
  const turnGates = new Set()
  let ownAnswerer
  let ownContested = false
  // DSH installs its SIGTERM/SIGINT handlers before plugins load. While the host stops, an ACP
  // prompt the agent cancels on its way down was cut by the restart, not stopped by the person
  // or by its own policy (adapter.js). A bare test process has no such handler, so it keeps
  // Node's default signal behaviour.
  const hostStopping = { now: false }
  const stopWatchingSignals = []
  for (const signal of ['SIGTERM', 'SIGINT']) {
    if (process.listenerCount(signal) === 0) continue
    const stop = () => { hostStopping.now = true }
    process.on(signal, stop)
    stopWatchingSignals.push(() => process.removeListener(signal, stop))
  }
  if (stopWatchingSignals.length > 0) {
    ctx.effect?.(() => () => { for (const stop of stopWatchingSignals) stop() })
  }
  const adapter = new AcpAdapter(ctx, agents, {
    ownMode: () => (ownContested ? undefined : ownAnswerer?.answer),
    holds: () => [...turnGates].map(entry => entry.gate),
    images: () => imageKeeper,
    hostStopping: () => hostStopping.now,
    botIdentity: identityReaders.read,
    solverIdentity: id => {
      const identity = identityReaders.read(id)
      if (typeof identity?.solverLimitsPrompt === 'string') return { name: identity.name, solverLimitsPrompt: identity.solverLimitsPrompt }
    },
    teamManaged: identityReaders.everRegistered,
    // The raw tri-state: an absent setting takes each agent's own switch in AcpAdapter.
    dshTools: () => flagOf(config.dshTools),
    // The raw native-tools setting: AcpAdapter.nativeOn reads it per Session.
    nativeTools: () => flagOf(config.nativeTools),
    backchannel,
    redactor: redact,
    onSignedOut: id => signedOut(id),
    access: id => consentGate(id),
    currentAccess: id => currentAccountRefusal(id),
  })
  // What acted on each Session's permissions (permission-diagnostics.js): it only records.
  const diagnostics = new PermissionDiagnostics()
  adapter.diagnostics = backchannel.diagnostics = diagnostics
  // The kill switch is live: any change of `dshTools` ends the agent sessions and revokes their
  // bridges, so a credential minted while it was on cannot keep calling DSH tools and a Session
  // started with the bridge never runs on the old tool set. The next turn starts afresh.
  // The flip is also announced on the plugin context: DSH delivers `loader/volatile-update`
  // only to the plugin whose config changed, so a Bot team watching its own context never sees
  // this one. A profile-patch edit emits no other event there, and the Bot move reverses on it.
  // A listener that throws must not undo the setting or the ended sessions above, but it must
  // not vanish either: the live reverse is lost, and the next start (off or route gone) is the
  // fallback, so the warning makes that deferral visible.
  let toolsSetting = flagOf(config.dshTools)
  const syncTools = () => {
    const next = flagOf(config.dshTools)
    if (toolsSetting === next) return
    toolsSetting = next
    adapter.endSessions()
    try {
      ctx.emit?.('acp-dsh/dsh-tools-changed', { on: dshToolsOn(config.dshTools) })
    } catch (error) {
      const why = error?.message ?? error
      warn(ctx, `the dshTools flip was not announced: ${why}; the next start reverses`)
    }
  }
  const clis = new Map()
  const cliDetails = new Map()
  const signIns = new Map()
  // Why an agent's last sign-in check could not tell, while its sign-in is unknown.
  const signInChecks = new Map()
  // In-app sign-ins of an agent with its own home (signInNative): the attempt at work, one per
  // agent, and the one word that says why the last one failed (`unsupported`, `timeout`,
  // `failed`), kept until the next attempt or a check that finds it signed in.
  const nativeSignIns = new Map()
  const nativeSignInErrors = new Map()
  // For acceptance, the two log words as status fields, set where the log lines are written:
  // whether the agent offers a sign-out over ACP (`yes|no`), and how the last sign-out over ACP
  // went (`done|none|failed`; cleared when a sign-in starts).
  const signOutOverAcp = new Map()
  const lastSignOuts = new Map()
  // How the last in-app attempt ended, in one word, for acceptance (`signInEnd`): agy's own end
  // (`agent-error`, `agent-exit`), the process cap (`deadline`), the link's window (`window`),
  // the cap after a delivered paste (`checking`) or a paste that did not reach agy
  // (`unreachable`). Cleared when a sign-in starts.
  const signInEnds = new Map()
  // The last ended in-app attempt of each agent, for a Bot chat that reads it by its id
  // (loginStatus) for NATIVE_RETAIN_MS: { attemptId, status, cause?, at }.
  const nativeEnded = new Map()
  const NATIVE_RETAIN_MS = 60_000
  const abortNativeSignIn = (id) => { nativeSignIns.get(id)?.controller.abort() }
  // Account consent inside the isolated home (#869, consent.js): a signed-in CLI is used for
  // chats/images only once the person said so. `consentStates` is what the last
  // read of each agent meant ('given', 'carried', 'needed'); `accountsSeen` who it was signed in
  // as then, kept in memory for the owner's confirm step and never put on a status row, in a log
  // or in an event. Real installations never carry consent from the old terminal-shared home.
  const consents = consentFile === undefined ? undefined : new ConsentStore({
    file: consentFile,
    // The vendors whose account the app can read and ask about. A native agent has no account
    // read and is off by default: its switch is the person's word (Config, above).
    ids: Object.keys(AGENTS).filter(id => !isNative(AGENTS[id])),
    earlier: id => homes === undefined && !isNative(AGENTS[id])
      && store.binOf(AGENTS[id].adapter, AGENTS[id].bin) !== undefined,
    log: message => warn(ctx, message),
  })
  const consentIds = Object.keys(AGENTS).filter(id => !isNative(AGENTS[id]))
  // The agents that run in this installation's own home (cli-homes.js): Claude Code and Codex,
  // and a native agent marked `isolatedHome` (Antigravity, #2048). Only the first two have an
  // account read, a consent and a logout command (`consentIds`); the homed native one signs in
  // and out in the app only (signInNative, resetAccount).
  const homed = spec => homes !== undefined && (!isNative(spec) || spec?.isolatedHome === true)
  const homedNative = spec => homed(spec) && isNative(spec)
  const homeIds = Object.keys(AGENTS).filter(id => homed(AGENTS[id]))
  // The homed native agent's terminal command, in its own home, for the log only (never the
  // page or a chat); undefined when it cannot be quoted safely (agents.js isolatedSignInHintOf).
  const isolatedHint = (spec, detail) => {
    let home
    try { home = homes.home(spec.key) } catch { return undefined }
    return isolatedSignInHintOf(spec, detail, home, platform)
  }
  const consentStates = new Map()
  const accountsSeen = new Map()
  // The account reads still running behind an answer already given (`probe`), and a count per
  // agent that a newer read, a sign-out or the person's word moves on, so an older read that
  // lands late changes nothing.
  const accountReads = new Map()
  const accountEpochs = new Map()
  const nextEpoch = (id) => { const epoch = (accountEpochs.get(id) ?? 0) + 1; accountEpochs.set(id, epoch); return epoch }
  const accountRead = id => accountReads.get(id) ?? Promise.resolve()
  const noteAccount = (id, authenticated, who) => {
    if (consents === undefined) return
    if (authenticated === true) accountsSeen.set(id, who)
    else accountsSeen.delete(id)
    const state = consents.note(id, authenticated, who)
    if (state === undefined) consentStates.delete(id)
    else consentStates.set(id, state)
  }
  let registration
  let disposed = false
  const cliEnvironment = (spec, detail) => {
    const env = homed(spec) ? homes.environment(spec.key) : {}
    if (!detail?.managed) return env
    if (spec.key === 'claude') return { ...env, DISABLE_UPDATES: '1' }
    // Managed Codex runs its native executable; inherited package-manager ownership flags
    // must not send an upgrade command to a global installation.
    return { ...env, CODEX_MANAGED_BY_NPM: undefined, CODEX_MANAGED_BY_PNPM: undefined,
      CODEX_MANAGED_BY_BUN: undefined, CODEX_MANAGED_BY_VITE_PLUS: undefined,
      CODEX_MANAGED_PACKAGE_ROOT: undefined }
  }

  // An absent switch is on for Claude Code and Codex, as it always was (a bare config in a
  // test, an older profile), and off for a native agent, whatever built the config.
  const enabled = spec => (isNative(spec) ? flagOf(config[spec.key]) === true : flagOf(config[spec.key]) !== false)
  // The routes DSH serves follow `agents`; each change is published as llm/adapters-updated.
  const publish = () => {
    if (disposed) return
    const routes = [...agents.keys()]
    if (routes.length === 0) {
      registration?.()
      registration = undefined
    } else if (registration === undefined) {
      registration = ctx.llm.registerAdapter(routes, adapter) ?? (() => {})
    } else {
      registration.replace?.(routes)
    }
  }
  // A new connector release is started once before it replaces the one in use (install.js): it
  // is spawned as a Session would spawn it and asked `initialize`, nothing more. Without the
  // agent's CLI nothing could run it either way, so there is nothing to check.
  if (store instanceof AdapterStore && store.check === undefined) {
    store.check = async (pkg, staged) => {
      const [id, spec] = Object.entries(AGENTS).find(([, entry]) => entry.adapter === pkg) ?? []
      const cli = id === undefined ? undefined : clis.get(id)
      if (cli === undefined) return
      const node = nodeCommand()
      await handshake({ command: node.command, args: [staged.path], env: {
        ...cliEnvironment(spec, cliDetails.get(id)), ...node.env, ...spec.env(cli),
      } }, { signal: store.quit?.signal })
    }
  }
  // The connectors that wait for the account record (see `install`): connector package -> what
  // the status and a turn say meanwhile. Without it the wait showed as "installing" for good.
  const recordWaits = new Map()
  const accountRecordWait = () => {
    consents?.settle()
    if (consents !== undefined && !consents.saved) {
      return `the account record could not be saved (${consents.saveError ?? 'error'})`
    }
  }
  const connectorStartMessage = (spec, failed) => {
    const reason = failed ? `the last install failed: ${failed}` : 'send this again in a minute'
    return `its ACP adapter (${spec.adapter}) is still being installed; ${reason}`
  }
  const install = (spec, { repair = false } = {}) => {
    // A native agent has no connector: its CLI is the ACP server.
    if (isNative(spec)) return Promise.resolve()
    // The first-run account record is on disk before this version installs a connector, so a
    // connector found with no record always means an earlier version (consent.js).
    const wait = accountRecordWait()
    const before = store.binOf(spec.adapter, spec.bin)?.path
    // A record that could not be written: a connector installed now would look, at the next
    // start, like one an earlier version left, and its vendor would be carried unasked. The
    // connector waits for the record (every later install tries the write again). One already
    // installed says nothing new, so its updates go on.
    if (wait !== undefined && before === undefined) {
      if (!disposed) warn(ctx, `${spec.adapter} not installed yet: the account record could not be saved`)
      // Said as a failed install, so the settings page shows why and offers Retry, which comes
      // back here and tries the record again. Only the write error's code, never a path.
      recordWaits.set(spec.adapter, { message: wait })
      // Nothing can be installed until the record is saved: no retry waits meanwhile.
      forgetCheckRetry(spec)
      return Promise.resolve()
    }
    recordWaits.delete(spec.adapter)
    const job = repair && typeof store.repair === 'function'
      ? store.repair(spec.adapter, spec.bin)
      : store.update(spec.adapter, spec.bin, ...(repair ? [{ force: true }] : []))
    return job.then(
      // A connector that landed (or moved up) is announced, so the picker lists its model now.
      () => {
        forgetCheckRetry(spec)
        // A reinstalled connector has not failed a start yet.
        if (repair) startFailed.delete(spec.adapter)
        if (store.binOf(spec.adapter, spec.bin)?.path !== before && agents.has(idOf(spec))) publish()
      },
      // The store's short message is already redacted and home-relative; the raw installer
      // error is not, so it never reaches the host log.
      () => {
        if (disposed) return
        warn(ctx, `${spec.adapter} not installed: ${store.lastError?.(spec.adapter) ?? 'the install failed'}`)
        retryCheckSoon(spec)
      },
    )
  }
  // A connector that is not here because npm could not be reached (#970): the install is tried
  // again by itself after CHECK_RETRY_MS[0], [1], ... One timer per connector, and only for
  // that failure on a missing connector: an install that failed for another reason would only
  // fail again, and a connector that is here goes on while the next check waits for its timer.
  // One failed check is one step, however many callers waited on it (a turn, the person's
  // Retry and the timer share the store's one install). Once every step is used the entry
  // stays, so nothing starts the steps over until an install lands or fails another way.
  const checkRetries = new Map()
  const forgetCheckRetry = (spec) => {
    const entry = checkRetries.get(spec.adapter)
    if (entry === undefined) return
    checkTimers.clearTimeout(entry.timer)
    checkRetries.delete(spec.adapter)
  }
  // Whether a retry may install now: the plugin runs, the agent is on with its CLI found, and
  // its connector is still missing. Read when a failure arrives and again when the timer fires.
  const wantsConnector = spec => !disposed && enabled(spec) && agents.has(idOf(spec)) && clis.get(idOf(spec)) !== undefined && store.binOf(spec.adapter, spec.bin) === undefined
  const retryCheckSoon = (spec) => {
    if (store.lastFailure?.(spec.adapter)?.unreachable === undefined || !wantsConnector(spec)) return forgetCheckRetry(spec)
    const entry = checkRetries.get(spec.adapter) ?? { tries: 0, timer: undefined }
    checkRetries.set(spec.adapter, entry)
    // One already waiting (another caller of the same failed install set it, or this failure
    // came from a turn or the person's Retry meanwhile), or every step used: the timer that
    // checks every few hours goes on.
    if (entry.timer !== undefined || entry.tries >= CHECK_RETRY_MS.length) return
    const delay = CHECK_RETRY_MS[entry.tries]
    entry.tries += 1
    entry.timer = checkTimers.setTimeout(() => {
      entry.timer = undefined
      // The CLIs are looked for again first, as the regular check does: one removed since is
      // no reason to install its connector.
      if (!disposed) reconcile({ kick: false })
      // Stopped, turned off, its CLI gone or installed meanwhile: nothing to do, and a later
      // failure starts from the first step.
      if (!wantsConnector(spec)) { if (!disposed) checkRetries.delete(spec.adapter); return }
      void install(spec)
    }, delay)
    entry.timer?.unref?.()
  }
  // How `spec` starts now (agents.js launchOf): the adapter installed at this moment, or the
  // CLI itself for a native agent.
  const launch = (spec, cli, id = idOf(spec)) => launchOf(spec, cli, { store, node: nodeCommand(), cliEnv: cliEnvironment(spec, cliDetails.get(id)), stamp: cliStamp })
  const agySkillsProof = agySkillsProofReader(agySkillsVersions)
  // The agy version the last Antigravity start answered in this host run (`initialize`'s
  // agentInfo), for the version native tools off was checked on (agy-off.js AGY_OFF_CHECKED). An
  // OFF start on another version warns once per version and goes on (#1564, AG-2 (a)).
  let agyVersionSeen
  const agyWarned = new Set()
  const recordAgyVersion = (run, off = false) => {
    const version = run?.init?.agentInfo?.version
    if (typeof version !== 'string' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)) return
    agyVersionSeen = version
    if (off && version !== AGY_OFF_CHECKED && !agyWarned.has(version)) {
      agyWarned.add(version)
      warn(ctx, `Antigravity ${version} runs with native tools off; native tools off was checked on agy ${AGY_OFF_CHECKED} only`)
    }
  }
  // The pids of this host's live Antigravity OFF children, from their start until they exit: an
  // OFF start's prune (agy-off.js pruneAgyLog) keeps their logs however old, so a kept child idle
  // for a day is still checked at its next turn (#1564 AK-1).
  const agyOffLive = new Set()
  const trackAgyOff = run => {
    const child = run?.child
    const pid = child?.pid
    if (!Number.isInteger(pid) || agyOffLive.has(pid) || child.exitCode !== null || child.signalCode !== null) return
    agyOffLive.add(pid)
    child.once('exit', () => { agyOffLive.delete(pid) })
  }
  // Auto-repairs started in this run, one per connector release: a reinstall that did not help
  // is not started again by every failed turn (Retry still is). And the connectors whose last
  // start failed: Retry reinstalls those, while a Retry pressed for a CLI error leaves a
  // connector that works alone.
  const repaired = new Set()
  // connector package -> the short reason its last start failed, for the status (redacted).
  const startFailed = new Map()
  // The lines of Node's missing-module output that name where the missing file was wanted: the
  // "Cannot find ..." line (ESM's "imported from <file>") and the first file of CJS's
  // "Require stack". Stack frames of whatever printed it do not count.
  const missingFrom = (evidence) => {
    const lines = evidence.replace(/\\/g, '/').replace(/\/+/g, '/').split(/\r?\n/)
    const at = lines.findIndex(line => /Cannot find (?:module|package)/.test(line))
    if (at < 0) return []
    const stack = lines.findIndex((line, index) => index > at && /^\s*Require stack:/.test(line))
    return [lines[at], ...(stack < 0 || lines[stack + 1] === undefined ? [] : [lines[stack + 1]])]
  }
  const agentOf = (spec, cli, id = idOf(spec)) => ({
    name: spec.name,
    sessionFiles: homes && !isNative(spec) && spec.key === 'codex',
    modeFor: spec.modeFor,
    ownMode: spec.ownMode,
    ...(typeof spec.hardAsk === 'function' ? { hardAsk: spec.hardAsk } : {}),
    // The adapter reads these off the agent object: without them the bridge default would not
    // find Claude's switch, the drift detector would never run and Codex would never fork.
    ...(spec.disableBuiltInTools === true ? { disableBuiltInTools: true } : {}),
    ...(spec.imageInput === true ? { imageInput: true } : {}),
    ...(spec.drift === true ? { drift: true } : {}),
    ...(spec.refresh === undefined ? {} : { refresh: spec.refresh }),
    // A native agent takes no bridge, names its own sign-in command when signed out, and says
    // so in the chat when it has no mode for DSH's level (adapter.js).
    ...(isNative(spec) ? { bridge: false } : {}),
    // The Bot team's native-tools switch: omp by its launch args, Codex by a checked config,
    // with the models it never applies to (adapter.js nativeKept).
    ...(spec.nativeSwitch ? { nativeSwitch: spec.nativeSwitch } : {}),
    ...(id === 'acp-antigravity' ? { agySkillsVersion: () => agySkillsProof(cli)?.version } : {}),
    ...(spec.nativeKeptModels ? { nativeKeptModels: spec.nativeKeptModels } : {}),
    // A copy Automagik installed (Antigravity) is not on PATH: the command names its path. One
    // with its own home signs in only in Settings, which the chat names instead.
    ...(homedNative(spec) ? { signInWhere: 'settings' }
      : typeof spec.signInHint === 'string' ? { signInHint: signInHintOf(spec, cliDetails.get(id)) } : {}),
    ...(spec.modeFor === undefined ? { levelNotice: true } : {}),
    cli,
    ...(id === 'acp-claude' ? { concreteClaude: true } : {}),
    // The agent's own models and efforts, read from the adapter release installed now.
    catalog: new Catalog({
      id,
      name: spec.name,
      defaultName: spec.defaultName,
      fallback: spec.fallback,
      announceIdentity: true,
      onChange: catalog => {
        if (!disposed && agents.get(id)?.catalog === catalog) publish()
      },
      home: homed(spec) ? join(cliHome, 'catalog') : catalogHome,
      log,
      key: () => launch(spec, cli, id).key,
      spawn: () => { const { command, args, env } = launch(spec, cli, id); return { command, args, env } },
    }),
    installed: () => launch(spec, cli, id).ready,
    // The connector in use opened a session: it is the last-known-good. One that did not start
    // goes back to the release before it, when that is still here (install.js). A native agent
    // has no connector in the store, so it has neither: a failed start is only reported.
    ...(isNative(spec) ? {} : {
      connectorStartFailure: () => {
        if (store.binOf(spec.adapter, spec.bin) !== undefined) return
        const failed = store.lastError?.(spec.adapter) ?? accountRecordWait()
        if (failed) return connectorStartMessage(spec, failed)
      },
      proven: () => { startFailed.delete(spec.adapter); return store.markGood?.(spec.adapter) },
      repair: (error) => {
        if (disposed) return false
        startFailed.set(spec.adapter, homeRelativeText(redactInstallerOutput(String(error?.message ?? error ?? 'it did not start'))).split('\n')[0].slice(0, 300))
        if (typeof error?.missingModule !== 'string') return false
        const installed = store.binOf(spec.adapter, spec.bin)
        if (installed === undefined) return false
        const normalized = posix.normalize(installed.path.replace(/\\/g, '/'))
        const at = normalized.lastIndexOf('/node_modules/')
        if (at < 0) return false
        const folder = normalized.slice(0, at)
        // A CLI elsewhere can lose a module too; only this connector's folder is evidence.
        const names = line => {
          const found = line.indexOf(folder)
          return found >= 0 && (found === 0 || /[\s'"`(:]/.test(line[found - 1])) && /^(?:[/\s'"`)]|$)/.test(line.slice(found + folder.length))
        }
        const key = `${spec.adapter}@${installed.version}`
        if (!missingFrom(error.missingModule).some(names) || repaired.has(key)) return false
        repaired.add(key)
        void install(spec, { repair: true })
        warn(ctx, `${spec.adapter}: its connector looks damaged; reinstalling it`)
        return true
      },
      rollback: (reason) => {
        const back = store.rollback?.(spec.adapter, spec.bin, reason) !== undefined
        if (back && !disposed) warn(ctx, `${spec.adapter}: the newest release did not start; running the one before it`)
        return back
      },
    }),
    spawn: (context) => {
      const { ready, command, args, env } = launch(spec, cli, id)
      if (!ready) {
        void install(spec)
        // Read after the try above: a record that still cannot be saved is this turn's reason.
        const failed = store.lastError?.(spec.adapter) ?? recordWaits.get(spec.adapter)?.message
        throw new Error(connectorStartMessage(spec, failed))
      }
      // Antigravity's switch (#1564): every start records the version agy answered; an OFF start
      // writes and checks its files in the home this child runs in, before any child exists.
      if (spec.nativeSwitch === 'args' && spec.key === 'antigravity') {
        if (context?.nativeOff !== true) return { command, args, env, agyReady: run => { recordAgyVersion(run) } }
        if (!homedNative(spec)) throw new Error(`${spec.defaultName} could not start with its tools off: it has no settings folder.`)
        // The home `environment()` fixed for this start (cli-homes.js): a Reset or sign-out since
        // cannot split the files from the child.
        const home = env?.[HOME_ENV]
        if (typeof home !== 'string' || env.HOME !== home) throw new Error(`${spec.defaultName} could not start with its tools off: its home did not match.`)
        const refused = agyExtensionRefusal(home, { platform })
        if (refused !== undefined) throw new Error(refused)
        const proof = context.skillBridge === true ? agySkillsProof(command) : undefined
        writeAgyOff(home, { platform, live: agyOffLive, skills: proof !== undefined })
        const profile = proof ? AGY_OFF_SKILLS_NAME : undefined
        const check = agyOffCheck(home, { profile, spawnedAt: Date.now(), warn: line => warn(ctx, line) })
        const offArgs = proof ? ['--agent', profile, '--cli_dir_name', profile] : spec.offArgs
        return {
          command: proof?.command ?? command, args: [...args, ...offArgs], env, agySkillsVersion: proof?.version,
          agyReady: async run => { trackAgyOff(run); recordAgyVersion(run, true); check.start(run) },
          offRecheck: run => check.again(run),
        }
      }
      if (spec.nativeSwitch === 'args' && context?.nativeOff === true) {
        if (ompOverlayDir === undefined) throw new Error(`${spec.defaultName} could not start with its tools off: it has no settings folder.`)
        const overlay = writeOmpOverlay(ompOverlayDir)
        return { command, args: [...args, ...spec.offArgs, '--config', overlay], env: { ...env, PI_AUTO_QA: undefined } }
      }
      // Codex with its own tools off: the config this start runs with is checked first, against
      // this start's own home and folder (codex-native.js). Image grants never come with it.
      if (spec.key === 'codex' && context?.nativeOff === true) {
        return (async () => {
          const refused = reason => Object.assign(new Error(reason), { code: NATIVE_OFF_UNAVAILABLE, reason })
          const cwd = context.cwd ?? env.AUTOMAGIK_BOT_CLI_HOME ?? homedir()
          const profileModes = homes && !isNative(spec) && typeof env.CODEX_HOME === 'string' && typeof env.CODEX_PATH === 'string'
            ? ensureChatProfiles(env.CODEX_HOME, {
                platform, codexPath: env.CODEX_PATH, log: line => warn(ctx, line),
                verify: profile => profileCheck(env.CODEX_PATH, profile, { cwd: env.CODEX_HOME, env }),
              })
            : undefined
          if (profileModes === undefined && !offOnLegacyReadOnly) {
            throw refused('its permission profiles are unavailable')
          }
          if (codexOffDir === undefined) throw refused('it has no settings folder')
          const launched = await nativeOffLaunch({ command, args, env }, {
            cwd, dir: codexOffDir, kept: spec.nativeKeptModels ?? [], signal: context.signal,
            log: line => info(ctx, line.replace(/^acp-dsh: /, '')),
          })
          return { ...launched, profileModes }
        })()
      }
      // The chat profiles of the Bot's isolated Codex home, for the session this process starts
      // (adapter.js keeps them with that session).
      if (homes && !isNative(spec) && spec.key === 'codex' && typeof env.CODEX_HOME === 'string' && typeof env.CODEX_PATH === 'string') {
        const profileModes = ensureChatProfiles(env.CODEX_HOME, {
          platform, codexPath: env.CODEX_PATH, log: line => warn(ctx, line),
          verify: profile => profileCheck(env.CODEX_PATH, profile, { cwd: env.CODEX_HOME, env }),
        })
        if (profileModes !== undefined) return { command, args, env, profileModes,
          ...(context?.sessionFiles === undefined ? {} : sessionFileConfig(env, context.sessionFiles, profileModes)),
        }
        if (context?.sessionFiles?.files?.length) throw new Error('The restricted image profile is unavailable; no image prompt was sent.')
      }
      return { command, args, env }
    },
  })

  // The agents that should be offered now: setting on and CLI here. `kick` installs the
  // connector of one that just became offered (at start, the first check waits a little).
  const reconcile = ({ kick = true } = {}) => {
    let changed = false
    const added = []
    for (const [id, spec] of Object.entries(AGENTS)) {
      const external = find(spec.cli)
      // An install a hard quit left half done goes now, with no click (a manual CLI's folder).
      if (spec.cliInstall?.manual) cliStore?.sweep?.(spec)
      // Only a CLI Automagik installs itself (`cliPackage`, or a manual `cliInstall`) can have a
      // managed copy.
      const detail = (cliIdOf(spec) === undefined ? undefined : cliStore?.find(spec, external)) ?? (external ? { path: external, managed: false } : undefined)
      const cli = detail?.path
      cliDetails.set(id, detail)
      if (clis.get(id) !== cli) { signIns.delete(id); signInChecks.delete(id) }
      clis.set(id, cli)
      const want = enabled(spec) && cli !== undefined
      const have = agents.get(id)
      if (want && have?.cli !== cli) {
        if (have?.sessionFiles) adapter.endProvider(id, 'The Codex provider changed. Send a new message to continue.')
        have?.catalog?.dispose()
        agents.set(id, agentOf(spec, cli))
        changed = true
        if (have === undefined) added.push(spec)
      } else if (!want && have !== undefined) {
        // Turned off (or its CLI gone): an in-app sign-in under way ends with it.
        abortNativeSignIn(id)
        if (have.sessionFiles) adapter.endProvider(id, 'The Codex provider is no longer available.')
        have.catalog?.dispose()
        agents.delete(id)
        changed = true
      }
    }
    if (changed) publish()
    if (kick) for (const spec of added) void install(spec)
    return added
  }

  // A native agent's sign-in is what its own ACP session said (catalog.js `signedIn`): its CLI
  // has no status command. Only while it is offered: an agent that is off starts nothing.
  const nativeSignedIn = (id, fresh) => Promise.resolve(agents.get(id)?.catalog?.signedIn?.({ fresh })).catch(() => undefined)
  const probe = async (id, { fresh = false } = {}) => {
    const spec = AGENTS[id]
    const version = authVersions.get(id)
    let env
    try {
      if (homed(spec) && (accountChanges.has(id) || homes.paused(spec.key))) {
        signIns.set(id, false)
        return
      }
      env = { ...process.env, ...cliEnvironment(spec, cliDetails.get(id)) }
    } catch (error) {
      // A homed native agent whose home cannot be read (a damaged pointer) is signed out: its
      // Sign in retires that home and signs in to a fresh one (signInNative). Claude Code and
      // Codex keep their own recovery (accountRecovery).
      if (!homedNative(spec)) throw error
      signIns.set(id, false)
      return
    }
    const cli = clis.get(id)
    // Why a check that ran could not tell (agents.js `signedInOf`): a timeout or an answer it
    // could not read. Kept only while the sign-in is unknown, for the status row. It is this
    // probe's own until an answer that is not "signed in" is written, and is written with it
    // (`noteCheck`, under the same guard): a check of a CLI that was replaced meanwhile says
    // nothing of the new one, and of two probes of one CLI the one that ends last is the one
    // both maps hold. A "signed in" answer writes nothing here: the row shows a reason only
    // while the sign-in is unknown (`statusOf`), so while that answer waits for its account to
    // be read the row still says what it said, and after it the reason is not shown.
    let unknown
    const noteCheck = (answer) => {
      if (answer === undefined && SIGN_IN_CHECKS.has(unknown)) signInChecks.set(id, unknown)
      else signInChecks.delete(id)
    }
    const authenticated = cli === undefined ? undefined : isNative(spec) ? await nativeSignedIn(id, fresh) : await signedIn(spec, cli, { env, onUnknown: (why) => { unknown = why } }).catch(() => undefined)
    if (authVersions.get(id) !== version) return
    const epoch = nextEpoch(id)
    if (authenticated !== true || consents === undefined || isNative(spec)) {
      if (clis.get(id) === cli) {
        // A sign-in that now holds clears the last in-app attempt's failure.
        if (authenticated === true) nativeSignInErrors.delete(id)
        signIns.set(id, authenticated)
        noteCheck(authenticated)
        noteAccount(id, authenticated, undefined)
      }
      return
    }
    // Who it is signed in as, asked of the same CLI with the same environment, for the consent
    // record only. A CLI that does not say leaves the record as it stands.
    const read = Promise.resolve().then(() => account(spec, cli, { env })).catch(() => undefined)
    // An agent whose last read here already had the person's word: the answer stands and the
    // account is read behind it, so no status, picker or turn waits on the CLI (Codex's is an
    // app-server). Another account found then stops the next turn. The first read of a process,
    // of a CLI or after a sign-out, and every read of an agent that waits for the person, is
    // waited for: no turn opens on an account nobody has read.
    const state = consentStates.get(id)
    if (clis.get(id) === cli && signIns.get(id) === true && (state === 'given' || state === 'carried')) {
      const behind = read.then((who) => {
        if (accountReads.get(id) === behind) accountReads.delete(id)
        if (disposed || accountEpochs.get(id) !== epoch || clis.get(id) !== cli || signIns.get(id) !== true) return
        noteAccount(id, true, who)
        if (consentStates.get(id) !== state) publish()
      })
      accountReads.set(id, behind)
      return
    }
    const who = await read
    if (authVersions.get(id) !== version) return
    if (clis.get(id) === cli) {
      signIns.set(id, true)
      noteAccount(id, true, who)
    }
  }
  // One agent whose check throws never keeps the others' answers from the person.
  const probeAll = options => Promise.all(Object.keys(AGENTS).map(id => probe(id, options).catch(() => {})))
  // One agent's status with a fresh sign-in check, for a Bot that is about to be put on it
  // (bots-dsh models.js). Read-only: it asks the CLI `auth status` and nothing else, never
  // installs, enables or starts a login. Only that sign-in check is shared and kept: checks a
  // few at once share one probe, and its answer stands for INSPECT_TTL_MS (a confirmed sign-in
  // for SIGNED_IN_TTL_MS) for the same CLI, so a burst of picks, or a Bot's turns, spawn the CLI
  // once. Everything else in the row (the setting, the CLI, the connector) is read again on every
  // inspect: an agent turned off or a connector that failed is never reported ready from cache.
  const inspections = new Map()
  // The agent itself said it is signed out (ACP auth_required): the cached answer goes, and the
  // next check asks the CLI again.
  const signedOut = (id) => {
    if (disposed || !Object.hasOwn(AGENTS, id)) return
    inspections.delete(id)
    consentStates.delete(id)
    accountsSeen.delete(id)
    nextEpoch(id)
    agents.get(id)?.catalog?.signedOut?.()
    if (signIns.get(id) !== false) {
      signIns.set(id, false)
      publish()
    }
  }
  const isolatedAccount = spec => homes !== undefined && spec !== undefined && !isNative(spec)
  const accountChanging = (id, spec) => accountChanges.has(id) || homes.changing(spec.key) || homes.paused(spec.key)
  // A background read can change the decision after a turn was admitted. Read it again at
  // startup boundaries without inspecting the CLI or waiting on an account read.
  const currentAccountRefusal = (id) => {
    if (disposed || !Object.hasOwn(AGENTS, id)) return
    const spec = AGENTS[id]
    if (isolatedAccount(spec) && (accountChanging(id, spec) || signIns.get(id) !== true)) {
      return `Sign in to ${spec.defaultName} in the app to resume this Bot. `
        + 'Your terminal login is separate.'
    }
    if (signIns.get(id) === true && consentStates.get(id) === 'needed') {
      // The Bot team's refusal (models.js ACCESS_MESSAGES.account), translated the same way.
      return `Confirm the account of ${spec.defaultName} before using this model.`
    }
  }
  // What a turn about to open on an agent is told (adapter.js `access`): a text when the account
  // its CLI is signed in to has not been confirmed, else undefined. A sign-in nobody has read
  // yet is read first; one already read answers at once and is read again in the background
  // when its answer is old, so no turn of a consented agent waits on the CLI.
  const consentGate = async (id) => {
    const spec = AGENTS[id]
    if (isolatedAccount(spec)) {
      if (accountChanging(id, spec)) return currentAccountRefusal(id)
      await inspect(id)
      if (signIns.get(id) !== true) return currentAccountRefusal(id)
    }
    if (consents === undefined || disposed || !Object.hasOwn(AGENTS, id)) return currentAccountRefusal(id)
    const entry = inspections.get(id)
    const stale = entry === undefined || entry.cli !== clis.get(id) || (entry.at !== undefined && Date.now() - entry.at >= entry.ttl)
    if (signIns.get(id) === undefined || consentStates.get(id) === 'needed') {
      try { await inspect(id) } catch {}
    } else if (stale) void inspect(id).catch(() => {})
    return currentAccountRefusal(id)
  }
  const inspect = async (id) => {
    if (!Object.hasOwn(AGENTS, id)) return undefined
    reconcile({ kick: false })
    const cli = clis.get(id)
    let entry = inspections.get(id)
    if (entry === undefined || entry.cli !== cli || (entry.at !== undefined && Date.now() - entry.at >= entry.ttl)) {
      const fresh = { at: undefined, ttl: INSPECT_TTL_MS, cli, promise: undefined }
      fresh.promise = probe(id).then(() => {
        if (signIns.get(id) === true) fresh.ttl = SIGNED_IN_TTL_MS
      }).finally(() => { fresh.at = Date.now() })
      fresh.promise.catch(() => { if (inspections.get(id) === fresh) inspections.delete(id) })
      inspections.set(id, entry = fresh)
    }
    await entry.promise
    return statusOf(id)
  }

  // Required desktop tools are independent of model switches and onboarding. Installing
  // them never starts authentication; the existing explicit refresh owns sign-in checks.
  const ensureCli = (spec, { force = false, click = false } = {}) => {
    // Only a CLI with an official package (`cliPackage`) or a manual install (`cliInstall`) is
    // Automagik's to install, and a manual one only on the person's click (installCli): the
    // start, the 15 min check, a plugin install, a switch, Retry and refresh never reach it.
    if (!cliStore || disposed || cliIdOf(spec) === undefined) return Promise.resolve()
    if (spec.cliInstall?.manual && click !== true) return Promise.resolve()
    return cliStore.ensure(spec, find(spec.cli), { force, click }).then(() => {
      if (!disposed) reconcile()
    }, () => {
      if (!disposed) {
        // Discovery may have found a newer verified local copy before the registry failed.
        reconcile()
        // A manual CLI only ever installs on a click: there is no update check to speak of.
        warn(ctx, `${spec.defaultName} ${spec.cliInstall?.manual ? 'install failed' : 'update check failed'}: ${cliStore.lastError?.(cliIdOf(spec)) ?? 'the install failed'}`)
      }
    })
  }
  // Each lifecycle trigger checks the registry even if a previous check was recent. The
  // store shares in-flight work, so simultaneous plugin changes do not duplicate downloads.
  const required = () => { for (const spec of Object.values(AGENTS)) void ensureCli(spec, { force: true }) }

  // A path under the person's home is shown relative to it, as the Bot team's report row does.
  const shownPath = (path) => {
    if (typeof path !== 'string') return undefined
    const home = homedir()
    return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
  }

  // What one agent has, without spawning anything: the CLI search ran in the last reconcile,
  // the sign-in in the last refresh (a settings page refreshes when it opens).
  const statusOf = async (id) => {
    const spec = AGENTS[id]
    const cli = clis.get(id)
    const on = enabled(spec)
    const native = isNative(spec)
    // A native agent has no connector to install: it is ready as soon as its CLI is found.
    const bin = cli === undefined || native ? undefined : store.binOf(spec.adapter, spec.bin)
    const busy = !native && store.busy?.(spec.adapter) === true
    // The installer's own failure first; else a connector that waits for the account record.
    const installFailure = native ? undefined : store.lastFailure?.(spec.adapter)
    const failure = installFailure ?? (native ? undefined : recordWaits.get(spec.adapter))
    const connectorState = native ? undefined : store.stateOf?.(spec.adapter)
    // Only a CLI Automagik installs itself has an install to report; any other is found or missing.
    const managed = cliStore !== undefined && cliIdOf(spec) !== undefined
    // A manual one (Antigravity) installs on the person's click only: missing until then.
    const manual = managed && spec.cliInstall?.manual === true
    const cliFailure = managed ? cliStore.lastFailure(cliIdOf(spec)) : undefined
    const cliBusy = managed && cliStore.busy(cliIdOf(spec)) === true
    const detail = cliDetails.get(id)
    // A connector being reinstalled (Retry, or a start that showed it damaged) is installing:
    // the settings page says so and follows it until it is back.
    const repairing = busy && store.repairing?.has?.(spec.adapter) === true
    const connector = !on ? 'off'
      : cli === undefined ? 'no-cli'
        : (bin !== undefined || native) && !repairing ? 'ready'
          : busy || failure === undefined ? 'installing'
            : 'failed'
    // In the picker: DSH serves the route. Read from the registry, never the model list, which may
    // wait on a first read of the agent's models (catalog.js); a settings page must not.
    let listed = false
    if (connector === 'ready' && agents.has(id)) {
      try { listed = ctx.llm.listProviders?.().some(provider => provider.id === id) === true } catch {}
    }
    return {
      id,
      key: spec.key,
      name: spec.defaultName,
      on,
      cli: {
        found: cli !== undefined, installUrl: spec.installUrl,
        // How the person signs in to a CLI that has no sign-in in the app: its terminal command.
        // An agent with its own home signs in in the app only: no command (#2048, owner).
        ...(homedNative(spec) ? {}
          : typeof spec.signInHint === 'string' ? { signInHint: signInHintOf(spec, detail) } : {}),
        state: cli ? 'ready' : cliBusy || (managed && !manual && !cliFailure) ? 'installing' : cliFailure ? 'failed' : 'missing',
        ...(manual ? { install: 'manual' } : {}),
        managed: detail?.managed === true,
        ...(detail?.version ? { version: detail.version } : {}),
        ...(cliBusy && cli ? { updating: true } : {}),
        ...(cliFailure ? {
          error: cliFailure.message,
          ...(cliFailure.diagnostic ? { diagnostic: cliFailure.diagnostic } : {}),
          ...(cliFailure.logPath ? { logPath: shownPath(cliFailure.logPath) } : {}),
        } : {}),
      },
      connector: {
        state: connector,
        ...(native ? { native: true } : {}),
        ...(bin ? { version: bin.version } : {}),
        ...(connector === 'failed'
          ? {
            error: failure?.message,
            ...(failure?.diagnostic ? { diagnostic: failure.diagnostic } : {}),
            ...(failure?.logPath ? { logPath: shownPath(failure.logPath) } : {}),
          }
          : {}),
        ...(connector === 'ready' && busy ? { updating: true } : {}),
        // Installed, but its last start failed and no session opened since: Retry reinstalls it.
        ...(connector === 'ready' && startFailed.has(spec.adapter) ? { startError: startFailed.get(spec.adapter) } : {}),
        // The release before the one in use, and a rollback while the failed release is held
        // back: "running the previous connector; the newest failed to start".
        ...(bin && connectorState?.previous ? { previous: connectorState.previous } : {}),
        ...(bin && connectorState?.rolledBack ? { rolledBack: connectorState.rolledBack } : {}),
      },
      ...(connector === 'failed' && installFailure?.unreachable !== undefined ? { connectorUnreachable: true } : {}),
      ...(signIns.get(id) === undefined ? {} : { signedIn: signIns.get(id) }),
      ...(homes && !native ? { authScope: 'isolated' } : {}),
      // An agent with its own home that signs in in the app (Antigravity): Settings offers Sign
      // in (signInNative), says while it runs, with the sign-in link the agent printed if any,
      // and, in one word, why the last one failed. While a link waits, the page may paste back
      // the address the browser ends on (`signInPaste`, signInCallback), for that attempt
      // (`signInAttempt`) until `signInExpiresAt`; `signInChecking` once it was delivered.
      // Never the pasted address or its code: the status never holds them.
      ...(homedNative(spec) && typeof spec.acpSignIn === 'string' ? {
        appSignIn: true,
        ...(nativeSignIns.has(id) ? nativeSignInFields(nativeSignIns.get(id)) : {}),
        ...(nativeSignInErrors.has(id) ? { signInError: nativeSignInErrors.get(id) } : {}),
        ...(signInEnds.has(id) ? { signInEnd: signInEnds.get(id) } : {}),
        ...(signOutOverAcp.has(id) ? { signOutOverAcp: signOutOverAcp.get(id) } : {}),
        ...(lastSignOuts.has(id) ? { lastSignOut: lastSignOuts.get(id) } : {}),
      } : {}),
      // Windows keeps the sign-in in Credential Manager, which belongs to the Windows account
      // and not to the home: there the account is shared with the person's own agy.
      ...(homedNative(spec) && platform === 'win32' ? { sharedAccount: true } : {}),
      // No `signedIn`: the last check ran and could not tell, and this is why. Absent when no
      // check has run yet (or there was nothing to check), so the two are told apart (#971).
      ...(signIns.get(id) === undefined && signInChecks.get(id) !== undefined ? { signInCheck: signInChecks.get(id) } : {}),
      // Only the state of the person's word for the signed-in account; who it is never rides here.
      ...(signIns.get(id) === true && consentStates.get(id) !== undefined ? { consent: consentStates.get(id) } : {}),
      model: { provider: id, id: DEFAULT_MODEL, name: spec.defaultName, listed },
      // Ready but not in the picker: only a DSH that has not loaded this plugin's routes.
      restartNeeded: connector === 'ready' && !listed,
    }
  }
  const status = async () => ({ agents: await Promise.all(Object.keys(AGENTS).map(statusOf)) })
  // The status fields of an in-app attempt at work (#2048, paste-back).
  function nativeSignInFields(attempt) {
    const pasting = typeof attempt.url === 'string' && attempt.callback !== undefined && !attempt.delivered
    return {
      signingIn: true,
      signInAttempt: attempt.attemptId,
      ...(typeof attempt.url === 'string' ? { signInUrl: attempt.url } : {}),
      ...(pasting ? { signInPaste: true } : {}),
      ...(attempt.delivered ? { signInChecking: true } : {}),
      ...(!attempt.delivered && Number.isFinite(attempt.expiresAt) ? { signInExpiresAt: attempt.expiresAt } : {}),
    }
  }

  // A real probe of this machine's bridge, run once per installed adapter version and cached:
  // a fresh per-session credential, the bridge process over stdio, MCP `initialize`, then
  // `tools/list`. A missing adapter, a bridge that does not answer, or an empty list fails
  // closed, so the Bot team never moves a Bot onto a route whose bridge cannot work.
  const bridgeProbes = new Map()
  let probeSequence = 0
  function bridgeList(record) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BRIDGE_PATH], {
        env: {
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          [CREDENTIAL_ENV]: record.credential,
          [URL_ENV]: backchannel.urlFor(record),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdin.on('error', () => {})
      let buffer = ''
      let sequence = 0
      let settled = false
      const pending = new Map()
      const finish = (error, tools) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.stdin.end() } catch {}
        try { child.kill('SIGTERM') } catch {}
        if (error === undefined) resolve(tools)
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error('the bridge did not answer in time')), 5000)
      timer.unref?.()
      child.on('error', error => finish(error))
      child.on('exit', code => finish(new Error(`the bridge exited with ${code}`)))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          let message
          try { message = JSON.parse(line) } catch { continue }
          const waiter = pending.get(message.id)
          if (waiter === undefined) continue
          pending.delete(message.id)
          if (message.error !== undefined) waiter.reject(new Error(message.error.message))
          else waiter.resolve(message.result)
        }
      })
      const request = (method, params) => new Promise((res, rej) => {
        const id = ++sequence
        pending.set(id, { resolve: res, reject: rej })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
      request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acp-dsh-probe', version: '1' } })
        .then(() => request('tools/list', {}))
        .then(list => finish(undefined, Array.isArray(list?.tools) ? list.tools : []), error => finish(error))
    })
  }

  async function probeBridge() {
    await backchannel.listen()
    const sessionId = `acp-dsh-probe-${process.pid}-${++probeSequence}`
    // The bridge asks the back-channel for the Session's offered tools; a real DSH tools
    // service answers. No Session is started and no agent prompt is sent.
    const agent = { session: { id: sessionId, snapshotEvents: () => [] } }
    const record = backchannel.mint({ sessionId, agent, name: 'acp-dsh probe' })
    try {
      return (await bridgeList(record)).length > 0
    } finally {
      backchannel.revoke(record)
    }
  }

  async function bridgeStatus() {
    if (disposed) return { on: false, probesPass: false }
    const on = dshToolsOn(config.dshTools)
    if (!on) return { on: false, probesPass: false }
    const spec = AGENTS['acp-claude']
    const bin = store.binOf(spec.adapter, spec.bin)
    if (bin === undefined) return { on: true, probesPass: false }
    const key = `${bin.path}\u0000${bin.version ?? ''}`
    const cached = bridgeProbes.get(key)
    // A success is kept for its adapter version. A running probe is shared; a failure is kept
    // only until its backoff ends, so one transient start never blocks the move forever.
    if (cached?.ok === true) return { on: true, probesPass: true }
    if (cached !== undefined && cached.ok === undefined) return { on: true, probesPass: await cached.promise }
    if (cached?.ok === false && Date.now() - cached.at < PROBE_RETRY_MS) return { on: true, probesPass: false }
    const entry = { at: Date.now(), ok: undefined, promise: undefined }
    entry.promise = probeBridge().then(
      (ok) => {
        entry.ok = ok === true
        entry.at = Date.now()
        return entry.ok
      },
      () => {
        entry.ok = false
        entry.at = Date.now()
        return false
      },
    )
    bridgeProbes.set(key, entry)
    return { on: true, probesPass: await entry.promise }
  }

  // Sign-in attempts (login.js): one per agent, owned here, read by any owner view. A ready
  // sign-in is recorded only for the executable that confirmed it (the update loop may have
  // installed a newer CLI meanwhile), and announced on the plugin context, as the dshTools flip
  // is, so the Bot team can apply the model the person chose (`acp-dsh/login-ready`). The
  // number at work is announced too (`acp-dsh/login-active`): the welcome adds it to the busy
  // file, so the app's own restarts wait for an attempt to end.
  const attemptVersions = new Map()
  const logins = new CliLogins({
    // The command a terminal-only sign-in names: a copy Automagik installed by its path. An
    // agent with its own home names none (null): it signs in in the app only (#2048).
    hintOf: id => (homedNative(AGENTS[id]) ? null : signInHintOf(AGENTS[id], cliDetails.get(id))),
    // Why an attempt failed, for the host log (#970): a fixed class, where the attempt stood,
    // the CLI's exit and its version. Never what the CLI printed, a link, a code or an account.
    onFail({ id, cause, phase, exit }) {
      // The version of the CLI the attempt started, as it was read then (`resolve` below).
      const version = attemptVersions.get(id)
      const cli = typeof version === 'string' && /^\d+\.\d+\.\d+[\w.+-]{0,32}$/.test(version) ? `CLI ${version}` : 'CLI version unknown'
      signInNote(ctx, `sign-in to ${AGENTS[id]?.defaultName ?? id} failed: ${cause} (${phase}${exit === undefined ? '' : `, ${exit}`}; ${cli})`)
    },
    // A Switch account's start and end (#2064), for the app log: fixed words only, never an
    // account, a link or a code.
    onSwitch({ id, step, signedIn, status, linkShown, exit, same, signedInAfter }) {
      const name = AGENTS[id]?.defaultName ?? id
      const yes = value => (value === true ? 'yes' : value === false ? 'no' : 'unknown')
      if (step === 'start') {
        signInNote(ctx, `account switch for ${name}: status at the new sign-in's start: ${signedIn ? 'signed in' : 'not signed in'}`)
        return
      }
      const ended = ['ready', 'failed', 'expired', 'cancelled'].includes(status) ? status : 'unknown'
      const how = typeof exit === 'string' && /^(?:exit -?\d{1,5}|SIG[A-Z0-9]{2,12}|running)$/.test(exit) ? exit : 'unknown'
      signInNote(ctx, `account switch for ${name} ended: ${ended} (link shown: ${linkShown ? 'yes' : 'no'}; ${how}; same account: ${yes(same)}; signed in after: ${yes(signedInAfter)})`)
    },
    ...(loginSpawn ? { spawn: loginSpawn } : {}),
    ...(loginRecord ? { record: loginRecord } : {}),
    ...(loginTimers ? { timers: loginTimers, now: () => loginTimers.now() } : {}),
    signedIn,
    resolve(id) {
      restartGuard()
      if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
      reconcile({ kick: false })
      attemptVersions.set(id, cliDetails.get(id)?.version)
      const version = authVersions.get(id)
      return { cli: clis.get(id), env: { ...process.env, ...cliEnvironment(AGENTS[id], cliDetails.get(id)) },
        valid: () => !disposed && !restarting && !accountChanges.has(id) && authVersions.get(id) === version }
    },
    // `existing`: the CLI was signed in before the attempt, so nobody signed in through it. A
    // sign-in the person made here is their word for that account; an existing one waits for
    // `accountConfirm`, and until then nothing is announced, so no chosen model is applied.
    async onReady(id, selected, { existing = false, fresh = false, compare = false, valid = () => false, same } = {}) {
      const version = authVersions.get(id)
      const current = () => {
        if (!valid() || disposed || restarting || accountChanges.has(id)
          || authVersions.get(id) !== version || clis.get(id) !== selected.cli) return false
        try {
          return !homes || (selected.env[HOME_ENV] === homes.home(AGENTS[id].key)
            && homes.matches(selected.env))
        } catch { return false }
      }
      if (!current()) return
      const who = consents === undefined ? undefined
        : await Promise.resolve().then(() => current() ? account(AGENTS[id], selected.cli, { env: selected.env }) : undefined).catch(() => undefined)
      if (!current()) return
      signIns.set(id, true)
      inspections.delete(id)
      nextEpoch(id)
      if (consents !== undefined) {
        if (!current()) return
        if (!existing) {
          // A Switch that ended on the account it signed out of says so (#2064); read before the
          // new word is written over it, and only when the one signed out was agreed here.
          if (fresh && compare && consents.sameAccount(id, who)) same?.()
          consents.confirm(id, who)
        }
        if (!current()) return
        noteAccount(id, true, who)
      }
      if (!current()) return
      if (loginLocks.delete(id)) {
        homes.resume(AGENTS[id].key)
        homes.end(AGENTS[id].key)
      }
      agents.get(id)?.catalog.refresh()
      if (!current()) return
      publish()
      if (!current() || consentStates.get(id) === 'needed') return
      try {
        ctx.emit?.('acp-dsh/login-ready', { id })
      } catch (error) {
        warn(ctx, `the sign-in of ${id} was not announced: ${error?.message ?? error}`)
      }
    },
    // A failed Switch never strands Bots (#2064): still signed in -> the home runs again on the
    // account that stayed; signed out or unknown -> it stays paused until a sign-in. Only this
    // attempt's own lock: a newer sign-out, switch or restart already took it.
    onSettled({ id, attemptId, signedIn, valid }) {
      if (restarting || disposed || !loginLocks.has(id) || logins.current(id) || !logins.owns(id, attemptId)) return
      const { key } = AGENTS[id]
      loginLocks.delete(id)
      const resume = signedIn === true && valid() && !accountChanges.has(id)
      if (resume) homes.resume(key)
      homes.end(key)
      if (resume) { inspections.delete(id); agents.get(id)?.catalog.refresh(); void inspect(id).catch(() => {}) }
      publish()
    },
    // Both events carry the in-app attempts too (#2048): one count for the busy signal.
    onActivity(activity) { announceActivity(activity) },
    onChange(active) {
      for (const id of restarting ? [] : loginLocks) {
        // A Switch that settles keeps its lock until `onSettled` decides the home (#2064).
        if (logins.current(id) || logins.settling(id)) continue
        loginLocks.delete(id)
        homes.end(AGENTS[id].key)
      }
      announceActive(active)
    },
  })
  // The busy signal counts the in-app sign-ins of a homed native agent beside the terminal
  // ones (#2048): the app does not restart DSH under a sign-in finishing on another computer.
  const nativeActive = () => (disposed ? 0 : nativeSignIns.size)
  const loginActivity = () => {
    const activity = logins.activity()
    return { ...activity, active: activity.active + nativeActive() }
  }
  const loginActive = () => logins.activeAttempts() + nativeActive()
  // From CliLogins, its own counts plus the in-app ones; from an in-app start or end, both read.
  const announceActivity = (activity = logins.activity()) => {
    try { ctx.emit?.('acp-dsh/login-activity', { ...activity, active: activity.active + nativeActive() }) } catch {}
  }
  const announceActive = (active = logins.activeAttempts()) => {
    try {
      ctx.emit?.('acp-dsh/login-active', { active: active + nativeActive() })
    } catch (error) {
      warn(ctx, `the sign-in count was not announced: ${error?.message ?? error}`)
    }
  }
  const announceLogins = () => { announceActivity(); announceActive() }

  // One read of an account, named for the confirm step: never stored.
  const refOf = who => (who?.id === undefined ? 'unknown' : consents.digest(who.id))
  const accountFailure = (code, message) => Object.assign(new Error(message), { code: `acp-account/${code}` })
  async function accountOfAgent(id, { fresh = false } = {}) {
    if (!Object.hasOwn(AGENTS, id)) return undefined
    if (fresh) inspections.delete(id)
    await inspect(id)
    // The owner is shown the account read now, never the one before it.
    await accountRead(id)
    const authenticated = signIns.get(id)
    const scope = homes && !isNative(AGENTS[id]) ? { authScope: 'isolated' } : {}
    if (authenticated !== true || consents === undefined) return {
      id, ...scope, ...(typeof authenticated === 'boolean' ? { signedIn: authenticated } : {}),
    }
    const who = accountsSeen.get(id)
    const shown = accountView(who)
    return {
      id,
      ...scope,
      signedIn: true,
      ...(consentStates.get(id) === undefined ? {} : { consent: consentStates.get(id) }),
      ref: refOf(who),
      ...(shown === undefined ? {} : { account: shown }),
      ...(consents.noticePending(id) ? { notice: true } : {}),
    }
  }
  async function confirmAccount(id, ref) {
    restartGuard()
    if (disposed) throw accountFailure('disposed', 'Automagik is restarting. Try again.')
    if (!consentIds.includes(id)) throw accountFailure('invalid', `Choose ${consentIds.map(other => AGENTS[other].defaultName).sort().join(' or ')}.`)
    if (consents === undefined) throw accountFailure('unavailable', 'This installation keeps no account record.')
    // The CLI is asked again: the word is for the account signed in now, not for an old answer.
    inspections.delete(id)
    await inspect(id)
    await accountRead(id)
    if (disposed) throw accountFailure('disposed', 'Automagik is restarting. Try again.')
    if (signIns.get(id) !== true) throw accountFailure('signed-out', 'This CLI is not signed in any more.')
    const who = accountsSeen.get(id)
    if (typeof ref === 'string' && ref !== refOf(who)) throw accountFailure('changed', 'The account changed since it was shown.')
    nextEpoch(id)
    consents.confirm(id, who)
    noteAccount(id, true, who)
    agents.get(id)?.catalog.refresh()
    publish()
    try {
      ctx.emit?.('acp-dsh/login-ready', { id })
    } catch (error) {
      warn(ctx, `the confirmed account of ${id} was not announced: ${error?.message ?? error}`)
    }
    return { id, signedIn: true, consent: consentStates.get(id) }
  }

  async function expectAccount(id, expect) {
    if (!validReservationKey(expect?.key) || !validReservationDigest(expect.loose)
      || (expect.exact !== undefined && !validReservationDigest(expect.exact))
      || (expect.recheck !== undefined && typeof expect.recheck !== 'function')) {
      throw accountFailure('invalid', 'The sign-out request is not valid.')
    }
    if (!homes || !consentIds.includes(id) || disposed || !clis.has(id)) {
      throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    }
    const spec = AGENTS[id]
    if (accountChanges.has(id) || loginLocks.has(id)
      || homes.paused(spec.key) || homes.changing(spec.key)) {
      throw accountFailure('busy', 'The Bot account is changing.')
    }
    const cli = clis.get(id)
    const version = authVersions.get(id)
    accountChanges.add(id)
    try {
      const env = { ...process.env, ...cliEnvironment(spec, cliDetails.get(id)) }
      const { evidence } = await evidenceOf(spec, cli, { env })
      const seen = reservationDigests(evidence, expect.key)
      if (!disposed && (seen.loose !== expect.loose || seen.exact !== expect.exact)) {
        throw accountFailure('changed', 'The Bot account changed. Look again.')
      }
      return { cli, version }
    } finally {
      accountChanges.delete(id)
    }
  }

  function confirmMatch(id, spec, matched, expect) {
    let current = false
    try { current = expect.recheck === undefined || expect.recheck() === true } catch {}
    if (!current || clis.get(id) !== matched.cli || authVersions.get(id) !== matched.version
      || signIns.get(id) !== true || loginLocks.has(id)
      || homes.paused(spec.key) || homes.changing(spec.key)) {
      throw accountFailure('changed', 'The Bot account changed. Look again.')
    }
  }

  async function awaitRecovery(id) {
    const key = AGENTS[id].key
    const version = authVersions.get(id) ?? 0
    const home = homes.home(key)
    await homes.recoverLogins(key).catch(() => false)
    restartGuard()
    if (disposed) throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    if ((authVersions.get(id) ?? 0) !== version || homes.home(key) !== home) {
      throw accountFailure('changed', 'The Bot account changed. Look again.')
    }
  }

  async function signOutAccount(id, { expect, note = false } = {}) {
    restartGuard()
    const matched = expect === undefined ? undefined : await expectAccount(id, expect)
    if (!homes || !consentIds.includes(id) || disposed) {
      throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    }
    await awaitRecovery(id)
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const spec = AGENTS[id]
    const cli = clis.get(id)
    if (!cli) throw accountFailure('unavailable', 'Install the CLI before changing accounts.')
    if (matched !== undefined) confirmMatch(id, spec, matched, expect)
    if (loginLocks.delete(id)) homes.end(spec.key)
    homes.begin(spec.key)
    accountChanges.add(id)
    authVersions.set(id, (authVersions.get(id) ?? 0) + 1)
    signedOut(id)
    try {
      // Block admission first, then end starting/live chats, model probes, images and logins.
      adapter.endProvider(id, 'The Bot account changed. Sign in again in the app.')
      // For a Switch's log line (#2064): whether a model probe of this home was alive here.
      const probe = agents.get(id)?.catalog?.run !== undefined
      agents.get(id)?.catalog?.dispose()
      await logins.stop(id)
      const runs = runCount(homes.home(spec.key))
      await stopRuns(homes.home(spec.key))
      const env = cliEnvironment(spec, cliDetails.get(id))
      let logout = false
      // Both CLIs may answer differently when logout is asked on a brand-new home. A definite
      // signed-out status already proves there is no login to end; unknown still logs out.
      if (await signedIn(spec, cli, { env }).catch(() => undefined) !== false) {
        logout = true
        await new Promise((resolve, reject) => {
          const args = spec.key === 'claude' ? ['auth', 'logout'] : ['logout']
          logoutRun(...batchSafe(cli, args, {
            env, cwd: homes.home(spec.key), timeout: 10_000, maxBuffer: 64 * 1024,
            windowsHide: true,
          }), error => error
            ? reject(accountFailure('logout', 'Sign-out did not finish. Try again.')) : resolve())
        })
      }
      if (await signedIn(spec, cli, { env }).catch(() => undefined) !== false) {
        throw accountFailure('logout', 'Sign-out could not be verified. Try again.')
      }
      if (note) {
        signInNote(ctx, `account switch for ${spec.defaultName}: sign-out verified (logout run: ${logout ? 'yes' : 'no'}; model probe live: ${probe ? 'yes' : 'no'}; runs stopped: ${runs})`)
      }
      homes.resume(spec.key)
      return { id, signedIn: false, authScope: 'isolated' }
    } finally {
      signedOut(id)
      accountChanges.delete(id)
      homes.end(spec.key)
      // Fresh catalog/session state for the next account; Bot models and transcripts stay.
      if (!disposed && agents.has(id)) agents.set(id, agentOf(spec, cli))
      publish()
    }
  }

  // A homed native agent's sign-out over ACP, in its current home, before that home is retired:
  // only where the agent says it can (`agentCapabilities.auth.logout`), never on Windows (the
  // sign-in there is the person's own too), and never longer than nativeLogoutMs. Whatever
  // happens is one word in the log, and the retire goes on.
  async function nativeLogout(id, spec) {
    if (platform === 'win32') return
    let word = 'none'
    let run
    try {
      const cli = clis.get(id)
      if (cli !== undefined && !homes.paused(spec.key) && !homes.changing(spec.key)) {
        const { command, args, env } = launch(spec, cli, id)
        run = new AgentRun({ command, args, env, cwd: env[HOME_ENV], name: spec.name, logout: true,
          startMs: nativeLogoutMs })
        await run.start()
        if (run.init !== undefined) signOutOverAcp.set(id, run.init?.agentCapabilities?.auth?.logout ? 'yes' : 'no')
        word = run.loggedOut === true ? 'done' : 'none'
      }
    } catch {
      word = 'failed'
    } finally {
      try { run?.dispose() } catch {}
    }
    lastSignOuts.set(id, word)
    info(ctx, `${spec.defaultName} sign-out over ACP: ${word}`)
  }

  async function resetAccount(id) {
    restartGuard()
    if (!homes || !homeIds.includes(id) || disposed) {
      throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    }
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const spec = AGENTS[id]
    const native = isNative(spec)
    // The change is marked first, so a second Sign out or a Sign in during the sign-out over
    // ACP below is refused as busy, and an in-app sign-in under way ends.
    accountChanges.add(id)
    let reset
    try {
      if (native) {
        abortNativeSignIn(id)
        await nativeLogout(id, spec)
        restartGuard()
        if (disposed) throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
      }
      // Reserve outside the replaceable home before pausing/awaiting work. Other app instances
      // cannot reset or admit a launch while the pointer transition is in progress.
      reset = homes.reserveReset(spec.key)
    } catch (error) {
      accountChanges.delete(id)
      if (native) publish()
      throw error
    }
    authVersions.set(id, (authVersions.get(id) ?? 0) + 1)
    signedOut(id)
    try {
      adapter.endProvider(id, 'The Bot sign-in was reset. Sign in again in the app.')
      agents.get(id)?.catalog?.dispose()
      await Promise.all([
        reset.home === undefined ? undefined : stopRuns(reset.home),
        // A failed login drain cannot prevent this explicitly proof-free fresh-home escape.
        // Its durable record and absolute old path remain intact, isolated from the new home.
        logins.stop(id).catch(() => {}),
      ])
      loginLocks.delete(id)
      reset.complete()
      // No sign-in flow of its own lifts the new home's pause for a homed native agent: it is
      // lifted here. A crash before this line leaves a paused home, which its Sign in retires.
      if (native) homes.resume(spec.key)
      logins.retire(id, reset.home)
      consents?.forget(id)
      if (consents?.saveError) {
        throw accountFailure('unavailable', 'Bot sign-in was reset. Retry sign-in in the app.')
      }
      return { id, signedIn: false, authScope: 'isolated' }
    } finally {
      signedOut(id)
      accountChanges.delete(id)
      reset.release()
      if (!disposed && agents.has(id)) agents.set(id, agentOf(spec, clis.get(id)))
      publish()
    }
  }

  // The ids an agent's `initialize` offers for sign-in, for the log: plain ids only, at most 8.
  const methodIds = init => (Array.isArray(init?.authMethods) ? init.authMethods : [])
    .map(method => method?.id).filter(value => typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value)).slice(0, 8)
  const signInFailure = (code, message) => Object.assign(new Error(message), { code: `acp-sign-in/${code}` })
  // The Claude/Codex sentence for an ended sign-in, for Antigravity too (#2048, parity).
  const EXPIRED_SIGN_IN = 'This sign-in expired. Start again.'
  // The terminal command that signs in to a homed native agent's own home, for support: the
  // log only, never the page or a chat (#2048, owner).
  const logTerminalHint = (spec, id, why) => {
    const hint = isolatedHint(spec, cliDetails.get(id))
    if (typeof hint !== 'string') return
    info(ctx, `${spec.defaultName}: ${why}; its terminal sign-in, for support: ${hint}`)
  }

  // The in-app sign-in of an agent with its own home (Antigravity, #2048): ACP `authenticate`
  // with its `acpSignIn` method, in that home. It answers at once (`signingIn` on its status
  // row); one attempt per agent, whichever view opened it (Settings, Connect AI, a Bot's chat).
  // A home left paused (a sign-out that did not finish) or unreadable is first retired for a
  // fresh one, as Reset does, so no old sign-in is reused.
  // agy never opens the browser itself on Linux and macOS: a stand-in for its opener, first on
  // the sign-in run's PATH only, hands the link over (sign-in-opener.js), the status carries it
  // once it passes isSignInUrl, and the app shows it as a link with Copy; a person's click
  // opens it. The person may also sign in on another computer and paste back the address the
  // browser ends on (signInCallback). On Linux an attempt with no link nativeSignInLinkMs after
  // `authenticate` ends as `no-browser`; a link is good for nativeSignInWindowMs after
  // `authenticate`.
  async function signInNative(id, { label } = {}) {
    restartGuard()
    const spec = AGENTS[id]
    if (spec === undefined || !homedNative(spec) || typeof spec.acpSignIn !== 'string') {
      throw signInFailure('unsupported', 'Automagik cannot sign in to this agent here.')
    }
    if (!enabled(spec)) throw signInFailure('off', `Turn ${spec.defaultName} on first.`)
    reconcile({ kick: false })
    if (clis.get(id) === undefined) throw signInFailure('missing', `Install ${spec.defaultName} first.`)
    if (nativeSignIns.has(id)) return status()
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    // A live change lock fails closed, as today. A home that cannot be read counts as paused.
    let changing = false
    let paused = false
    try {
      changing = homes.changing(spec.key)
      paused = !changing && homes.paused(spec.key)
    } catch { paused = true }
    if (changing) throw accountFailure('busy', 'The Bot account is changing.')
    if (paused) {
      // Awaited before the attempt is registered, so the reset never ends this attempt; a
      // second click meanwhile is refused as busy (`accountChanges`).
      try {
        await resetAccount(id)
        homes.resume(spec.key)
        paused = homes.paused(spec.key)
      } catch (error) {
        // The recovery's sign-out word is not the person's Sign out: it does not stay.
        lastSignOuts.delete(id)
        nativeSignInErrors.set(id, 'failed')
        const line = homeRelativeText(redactInstallerOutput(String(error?.message ?? error))).split('\n')[0].slice(0, 300)
        warn(ctx, `the sign-in to ${spec.defaultName} could not start in a fresh home: ${line}`)
        return status()
      }
      if (paused) throw accountFailure('busy', 'The Bot account is changing.')
    }
    restartGuard()
    if (disposed || nativeSignIns.has(id)) return status()
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const controller = new AbortController()
    const attempt = { controller, attemptId: randomUUID(), delivered: false,
      ...(typeof label === 'string' && label !== '' ? { label } : {}) }
    nativeSignIns.set(id, attempt)
    nativeSignInErrors.delete(id)
    signInEnds.delete(id)
    nativeEnded.delete(id)
    lastSignOuts.delete(id)
    announceLogins()
    const current = () => !disposed && nativeSignIns.get(id) === attempt && !controller.signal.aborted
    attempt.current = current
    // Ends this attempt as `no-browser`: there is no link to show. `why` goes to the log.
    const noBrowser = (why) => {
      if (!current()) return
      attempt.noBrowser = why
      attempt.url = undefined
      controller.abort()
    }
    // After a delivered paste, agy has nativeSignInCheckMs to finish (G6-6).
    attempt.checkCap = () => {
      if (!current() || !attempt.delivered) return
      attempt.end = 'checking'
      attempt.checkFailed = true
      controller.abort()
    }
    void (async () => {
      let run
      let word
      let opener
      let poll
      let linkTimer
      try {
        const { command, args, env } = launch(spec, clis.get(id), id)
        // A sign-in link the agent prints while it waits (its browser may not have opened) is
        // shown as a link, only when it is one of its own OAuth entry points (isSignInUrl) and
        // names where agy listens and the state it waits for (callbackOf). Its state is
        // remembered, so a Bot chat refuses a message carrying the address it ends on.
        let printed = ''
        const found = (url) => {
          if (attempt.url !== undefined || !current()) return
          const callback = callbackOf(url)
          if (callback === undefined) return
          attempt.url = url
          attempt.callback = callback
          logins.rememberCallbackState(callback.state)
          publish()
        }
        const onStderr = (chunk) => {
          if (attempt.url !== undefined || controller.signal.aborted) return
          printed = (printed + chunk).slice(-16_384)
          const urls = printed.match(/https:\/\/[^\s<>"'\p{Cc}]+/gu) ?? []
          const url = urls.find(link => isSignInUrl(spec, link))
          if (url !== undefined) found(url)
        }
        // The stand-in for agy's opener (Linux, macOS), on this run's PATH only.
        let runEnv = env
        if (platform === 'linux' || platform === 'darwin') {
          opener = makeSignInOpener(homes.acpHome, platform)
          if (opener !== undefined) {
            runEnv = { ...env, PATH: [opener.bin, env.PATH].filter(Boolean).join(delimiter) }
            // What it handed over, read while the attempt runs. Two different links that both
            // pass are not told apart: the attempt ends instead (a same-user writer, R10).
            poll = setInterval(() => {
              if (!current()) return
              const links = new Set(readSignInLinks(opener.links).filter(line => isSignInUrl(spec, line)))
              if (links.size > 1) noBrowser('more than one sign-in link')
              else if (links.size === 1) found([...links][0])
            }, 200)
            poll.unref?.()
          } else if (platform === 'linux') {
            // No stand-in, so no link could reach the app: the browser cannot open.
            attempt.noBrowser = 'agy handed no sign-in link'
          }
        }
        // From `authenticate`, on every platform, a link is good for nativeSignInWindowMs: the
        // app ends the attempt as `expired` before agy ends its own wait (G6-2). On Linux the
        // link comes right after `authenticate`, or there is no link to show.
        const onAuthenticate = () => {
          attempt.authenticateAt = Date.now()
          attempt.expiresAt = attempt.authenticateAt + nativeSignInWindowMs
          attempt.window = setTimeout(() => {
            if (current() && !attempt.delivered) { attempt.end = 'window'; attempt.expired = true; controller.abort() }
          }, nativeSignInWindowMs)
          attempt.window.unref?.()
          publish()
          if (platform !== 'linux') return
          linkTimer = setTimeout(() => {
            if (attempt.url === undefined) noBrowser('agy handed no sign-in link')
          }, nativeSignInLinkMs)
          linkTimer.unref?.()
        }
        if (attempt.noBrowser === undefined) {
          run = new AgentRun({ command, args, env: runEnv, cwd: env[HOME_ENV], name: spec.name,
            authenticate: spec.acpSignIn, startMs: nativeSignInMs, onStderr, onAuthenticate })
          await run.start({ signal: controller.signal })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          word = error?.code === 'acp-sign-in/unsupported' ? 'unsupported' : isUnanswered(error) ? 'timeout' : 'failed'
          attempt.end = isUnanswered(error) ? 'deadline' : run?.exited !== undefined ? 'agent-exit' : 'agent-error'
          // Only the first line, redacted and home-relative, goes to the log; the page gets the word.
          if (word === 'failed') {
            const line = homeRelativeText(redactInstallerOutput(String(error?.message ?? error))).split('\n')[0].slice(0, 300)
            warn(ctx, `the sign-in to ${spec.defaultName} did not finish: ${line}`)
          }
        }
      } finally {
        clearTimeout(linkTimer)
        clearTimeout(attempt.window)
        clearTimeout(attempt.check)
        clearInterval(poll)
        if (run?.init !== undefined) {
          const ids = methodIds(run.init)
          const logout = run.init?.agentCapabilities?.auth?.logout ? 'yes' : 'no'
          signOutOverAcp.set(id, logout)
          info(ctx, `${spec.defaultName} offers sign-in methods: ${ids.length > 0 ? ids.join(', ') : 'none'}; `
            + `sign-out over ACP: ${logout}`)
        }
        try { run?.dispose() } catch {}
        if (opener !== undefined) removeSignInOpener(opener.dir)
      }
      // How the attempt ended, for a Bot chat that reads it by its id (loginStatus).
      const ended = (status, cause) => {
        if (disposed) return
        nativeEnded.set(id, { attemptId: attempt.attemptId, status, ...(cause ? { cause } : {}), at: Date.now() })
      }
      try {
        if (!disposed && attempt.noBrowser !== undefined) {
          nativeSignInErrors.set(id, 'no-browser')
          ended('failed', 'no sign-in link in time')
          logTerminalHint(spec, id, `the browser did not open (${attempt.noBrowser})`)
          return
        }
        if (!disposed && attempt.expired) {
          nativeSignInErrors.set(id, 'expired')
          signInEnds.set(id, attempt.end)
          ended('expired')
          info(ctx, `the sign-in to ${spec.defaultName} expired`)
          return
        }
        if (!disposed && attempt.checkFailed) {
          nativeSignInErrors.set(id, 'failed')
          signInEnds.set(id, attempt.end)
          ended('failed')
          warn(ctx, `the sign-in to ${spec.defaultName} was not finished by agy after the address was delivered`)
          return
        }
        if (disposed || controller.signal.aborted) {
          ended('cancelled')
          return
        }
        if (word !== undefined) {
          nativeSignInErrors.set(id, word)
          signInEnds.set(id, attempt.end)
          ended('failed', attempt.end === 'agent-exit' ? 'the CLI exited' : undefined)
          logTerminalHint(spec, id, `the sign-in ended (${word})`)
          return
        }
        // Signed in: the agent's own session says so, read afresh in the same home.
        signIns.delete(id)
        signInChecks.delete(id)
        inspections.delete(id)
        await agents.get(id)?.catalog?.refresh?.()
        if (!disposed) await probe(id, { fresh: true }).catch(() => {})
        ended(signIns.get(id) === true ? 'ready' : 'failed')
        if (!disposed && signIns.get(id) === true) {
          // As a terminal sign-in: the Bot team applies the model the person chose.
          try {
            ctx.emit?.('acp-dsh/login-ready', { id })
          } catch (error) {
            warn(ctx, `the sign-in of ${id} was not announced: ${error?.message ?? error}`)
          }
        }
      } finally {
        if (nativeSignIns.get(id) === attempt) nativeSignIns.delete(id)
        announceLogins()
        if (!disposed) publish()
      }
    })()
    return status()
  }

  // The address the browser ended on after the person signed in, on any computer, pasted back
  // for the attempt `attemptId` (#2048, paste-back). It must name that attempt's own listener
  // and state (checkCallback); it is delivered once, by one loopback GET (deliverCallback).
  // Never logged, kept or returned: only the status and a refusal word come back.
  async function signInCallback(id, attemptId, value) {
    const spec = AGENTS[id]
    if (spec === undefined || !homedNative(spec) || typeof spec.acpSignIn !== 'string') {
      throw signInFailure('unsupported', 'Automagik cannot sign in to this agent here.')
    }
    const attempt = nativeSignIns.get(id)
    if (attempt === undefined || attempt.attemptId !== attemptId || !attempt.current()
      || attempt.delivered || attempt.callback === undefined) {
      throw signInFailure('expired', EXPIRED_SIGN_IN)
    }
    let checked = checkCallback(value, attempt.callback)
    value = undefined
    if (checked === undefined) throw signInFailure('not-this-sign-in', 'This link is not from this sign-in.')
    // Marked before any wait: a second paste is refused above, and the window no longer runs.
    attempt.delivered = true
    clearTimeout(attempt.window)
    attempt.check = setTimeout(attempt.checkCap, nativeSignInCheckMs)
    attempt.check.unref?.()
    publish()
    let answer
    try {
      answer = await deliverCallback({ ...attempt.callback, path: checked.path })
    } catch {
      checked = undefined
      if (attempt.current()) {
        attempt.end = 'unreachable'
        attempt.expired = true
        clearTimeout(attempt.check)
        attempt.controller.abort()
      }
      throw signInFailure('expired', EXPIRED_SIGN_IN)
    }
    checked = undefined
    // Only the status number: never the path, the code or the answer's body.
    if (answer.status >= 400) info(ctx, `agy answered the sign-in address with HTTP ${answer.status}`)
    return status()
  }

  // The view of an in-app attempt in the shape of a terminal sign-in's (login.js view), for a
  // Bot chat's sign-in row (#2048, parity): the link, its expiry, and the paste field.
  function nativeLoginView(id, attempt) {
    const pasting = typeof attempt.url === 'string' && attempt.callback !== undefined && !attempt.delivered
    return {
      id, attemptId: attempt.attemptId, status: typeof attempt.url === 'string' ? 'waiting' : 'starting',
      ...(!attempt.delivered && Number.isFinite(attempt.expiresAt) ? { expiresAt: attempt.expiresAt, expiresBy: 'app' } : {}),
      ...(attempt.label ? { openedBy: attempt.label } : {}),
      ...(typeof attempt.url === 'string' ? { url: attempt.url } : {}),
      ...(pasting ? { prompt: { id: 'agy-callback', secret: true } } : {}),
      ...(attempt.delivered ? { checking: true } : {}),
    }
  }
  const nativeNotFound = () => Object.assign(new Error('This sign-in has ended. Start again.'), { code: 'acp-login/not-found' })
  // The live attempt with this id, else the retained end with this id (NATIVE_RETAIN_MS).
  function nativeViewOf(id, attemptId) {
    const attempt = nativeSignIns.get(id)
    if (attempt !== undefined && attempt.attemptId === attemptId && attempt.current()) return nativeLoginView(id, attempt)
    const ended = nativeEnded.get(id)
    if (ended !== undefined && ended.attemptId === attemptId && Date.now() - ended.at < NATIVE_RETAIN_MS) {
      return { id, attemptId, status: ended.status, ...(ended.cause ? { cause: ended.cause } : {}) }
    }
    throw nativeNotFound()
  }
  const nativeLogins = {
    async start(id, label) {
      await signInNative(id, { label })
      const attempt = nativeSignIns.get(id)
      if (attempt === undefined) {
        const ended = nativeEnded.get(id)
        if (ended !== undefined) return { id, attemptId: ended.attemptId, status: ended.status }
        throw signInFailure('failed', `The sign-in to ${AGENTS[id].defaultName} did not start. Try again.`)
      }
      if (attempt.label === undefined && typeof label === 'string' && label !== '') attempt.label = label
      return nativeLoginView(id, attempt)
    },
    current(id) {
      const attempt = nativeSignIns.get(id)
      return attempt !== undefined && attempt.current() ? nativeLoginView(id, attempt) : undefined
    },
    status: (id, attemptId) => nativeViewOf(id, attemptId),
    async answer(id, attemptId, value) {
      await signInCallback(id, attemptId, value)
      return nativeViewOf(id, attemptId)
    },
    cancel(id, attemptId) {
      const attempt = nativeSignIns.get(id)
      if (attempt === undefined || attempt.attemptId !== attemptId || !attempt.current()) throw nativeNotFound()
      attempt.controller.abort()
      return { id, attemptId, status: 'cancelled' }
    },
  }
  const isHomedNative = id => Object.hasOwn(AGENTS, id) && homedNative(AGENTS[id])

  // Sign out of an agent with its own home: its home is retired, as Reset does (resetAccount).
  // Not on Windows: the sign-in is in Credential Manager there, shared with the person's own
  // agy, so retiring the home would not sign out. Only this and the `acp-sign-out` route refuse
  // there; `accountReset` is reached only in-process (the Bot team filters this agent out).
  async function signOutNative(id) {
    restartGuard()
    const spec = AGENTS[id]
    if (spec === undefined || !homedNative(spec) || typeof spec.acpSignIn !== 'string') {
      throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    }
    if (platform === 'win32') {
      throw accountFailure('unavailable', `Sign out is not available on Windows. Sign out in ${spec.defaultName} itself.`)
    }
    return resetAccount(id)
  }

  // `alreadySignedOut` is a Switch account (#2064): its attempt is fresh, never a plain one.
  async function startLogin(id, label, alreadySignedOut = false, { compare = false } = {}) {
    restartGuard()
    if (!homes || !consentIds.includes(id)) return logins.start(id, { label })
    await awaitRecovery(id)
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const current = logins.current(id)
    if (current && !alreadySignedOut) return current
    // A Switch ends any attempt it did not start (#2064); its own runs under the home's lock below.
    if (current) {
      await logins.stop(id)
      restartGuard()
      if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    }
    const spec = AGENTS[id]
    if (!alreadySignedOut) await inspect(id)
    restartGuard()
    if (!alreadySignedOut && signIns.get(id) === true && !homes.paused(spec.key)) {
      return logins.start(id, { label })
    }
    if (!alreadySignedOut) await signOutAccount(id)
    restartGuard()
    homes.begin(spec.key)
    loginLocks.add(id)
    authVersions.set(id, (authVersions.get(id) ?? 0) + 1)
    try { return logins.start(id, { label, ...(alreadySignedOut ? { fresh: true, compare } : {}) }) } catch (error) {
      loginLocks.delete(id)
      homes.end(spec.key)
      throw error
    }
  }

  // Images on the person's ChatGPT plan, through the Codex CLI's own sign-in (image.js). Ready
  // means: Codex is on and found, its connector installed, its CLI says it is signed in, and
  // this Codex takes the image run's lockdown. An unknown sign-in is asked once
  // (`codex login status`, read-only); the lockdown is asked of Codex's own CLI (its features
  // and the tools it would offer: no session, no model request) and remembered per Codex. A
  // Codex that does not take it is not ready, so the caller goes on to its next image source.
  const IMAGE_AGENT = 'acp-codex'
  const imageSupported = imageSupport({ ...(imageSetup ? { setup: imageSetup } : {}), log: line => imageWarn(ctx, line) })
  const imageAccess = async () => {
    const version = authVersions.get(IMAGE_AGENT) ?? 0
    const changed = () => disposed || (authVersions.get(IMAGE_AGENT) ?? 0) !== version
    if (disposed) return { ready: false, signedIn: false }
    reconcile({ kick: false })
    const agent = agents.get(IMAGE_AGENT)
    if (homes && (accountChanges.has(IMAGE_AGENT)
      || homes.paused('codex') || homes.changing('codex'))) {
      return { ready: false, signedIn: false }
    }
    if (agent === undefined || agent.installed?.() !== true) return { ready: false }
    if (signIns.get(IMAGE_AGENT) === undefined) await probe(IMAGE_AGENT).catch(() => {})
    if (changed()) return { ready: false, signedIn: false }
    const signedIn = signIns.get(IMAGE_AGENT)
    if (signedIn !== true) return { ready: false, ...(signedIn === undefined ? {} : { signedIn }) }
    // Signed in to an account the person has not confirmed (#869): no image is billed to it.
    if (consentStates.get(IMAGE_AGENT) === 'needed') return { ready: false, signedIn, reason: 'account' }
    // A Codex whose check does not hold is not ready, and `reason` says which check: the caller
    // goes on to its next image source. Only a check that ran out of time leaves Codex ready
    // (the draw makes its own and says why).
    let support
    try {
      support = await imageSupported(agent.spawn())
    } catch {}
    if (changed()) return { ready: false, signedIn: false }
    return support?.ok === false
      ? { ready: false, signedIn, reason: support.reason,
          ...(support.reason === 'unsupported' ? { unsupported: true } : {}) }
      : { ready: true, signedIn, ...(homes ? { accountGeneration: version } : {}) }
  }
  const makeImage = async ({ prompt, size, quality, background, signal, timeoutMs,
    accountGeneration } = {}, input) => {
    const version = authVersions.get(IMAGE_AGENT) ?? 0
    if (disposed || (accountGeneration !== undefined && accountGeneration !== version)) {
      throw imageRefusal(SIGNED_OUT, 'The Bot account changed. Start the image again.')
    }
    const access = await imageAccess()
    const checkAccount = () => {
      if (disposed || (authVersions.get(IMAGE_AGENT) ?? 0) !== version) {
        throw imageRefusal(SIGNED_OUT, 'The Bot account changed. Sign in again in the app.')
      }
    }
    checkAccount()
    // An edit whose locked run could not be started answers with the reason bots-dsh's
    // generate_image uses to hand the Bot its own verified copy, so the change is made on the
    // file itself. A draw keeps its own refusal.
    const editFallback = refusal => input === undefined ? refusal : Object.assign(refusal, { reason: 'edit-not-isolated' })
    if (!access.ready && access.reason === 'account') throw editFallback(imageRefusal(UNAVAILABLE, 'Codex is signed in on this computer, but you have not confirmed its account for Automagik. Confirm it in a Bot\'s chat (choose a Codex model there), then try again.'))
    // A Codex config that does not load, or a check that keeps breaking, may have been put
    // right since it was remembered: the draw's own check answers for those.
    if (!access.ready && access.reason !== 'config' && access.reason !== 'unreadable') {
      if (access.signedIn === false) throw editFallback(imageRefusal(SIGNED_OUT, 'Codex is not signed in. Sign in to Codex from a Bot\'s chat, then try again.'))
      if (access.unsupported === true) throw editFallback(unsupported())
      throw editFallback(imageRefusal(UNAVAILABLE, 'Codex cannot draw images here yet: it is off, not installed, or its sign-in could not be checked.'))
    }
    try {
      return await drawImage({ spawn: () => {
        checkAccount()
        return agents.get(IMAGE_AGENT).spawn()
      }, prompt, size, quality, background, signal, ...(input ? { input } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      name: AGENTS[IMAGE_AGENT].defaultName, log: line => imageWarn(ctx, line) })
    } catch (error) {
      // A run refused as signed out says the CLI's sign-in ended: the next check asks again.
      if (error?.code === SIGNED_OUT) { signIns.delete(IMAGE_AGENT); signInChecks.delete(IMAGE_AGENT) }
      throw error
    }
  }

  const generateImage = request => makeImage(request)
  const editImage = (request = {}) => {
    const image = request.image
    const invalid = () => imageRefusal(UNAVAILABLE, 'The picture to edit is not a valid PNG, JPEG or WebP image.')
    if (!image || typeof image !== 'object' ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
        typeof image.base64 !== 'string' || image.base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
      return Promise.reject(invalid())
    }
    const data = Buffer.from(image.base64, 'base64')
    const magic = image.mimeType === 'image/png'
      ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : image.mimeType === 'image/jpeg'
        ? data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : data.length >= 12 && data.subarray(0, 4).equals(Buffer.from('RIFF')) && data.subarray(8, 12).equals(Buffer.from('WEBP'))
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES ||
        data.toString('base64') !== image.base64 || !magic) return Promise.reject(invalid())
    return makeImage(request, { data, mimeType: image.mimeType })
  }

  // Only proved stops release the locks. Paused homes stay paused for the next sign-in.
  function prepareRestart() {
    if (preparingRestart) return preparingRestart
    restarting = true
    const timers = loginTimers ?? globalThis
    let expired = false
    let step = 'logins'
    let timer
    const work = async () => {
      await Promise.all(consentIds.map(id => logins.stop(id)))
      if (accountChanges.size > 0) return { ok: false, step: 'accounts' }
      if (expired) return { ok: false, step }
      step = 'runs'
      adapter.dispose()
      for (const agent of agents.values()) agent.catalog?.dispose()
      for (const id of nativeSignIns.keys()) abortNativeSignIn(id)
      // Only the pointer read is forgiven, for a homed native agent's damaged pointer: a stop
      // that cannot be proved still fails the step, for every agent.
      if (homes) {
        await Promise.all(homeIds.map(async (id) => {
          let home
          try { home = homes.home(AGENTS[id].key) } catch (error) {
            if (isNative(AGENTS[id])) return
            throw error
          }
          await stopRuns(home)
        }))
      }
      if (expired) return { ok: false, step }
      step = 'homes'
      for (const id of loginLocks) {
        homes.end(AGENTS[id].key)
        loginLocks.delete(id)
      }
      homes?.dispose()
      prepared = true
      return { ok: true }
    }
    preparingRestart = Promise.race([
      Promise.resolve().then(work).catch(() => ({ ok: false, step })),
      new Promise(resolve => {
        timer = timers.setTimeout(() => { expired = true; resolve({ ok: false, step }) }, 4500)
      }),
    ]).finally(() => timers.clearTimeout(timer))
    return preparingRestart
  }

  const service = {
    ...(homes ? { authScope: 'isolated' } : {}),
    reservationEvidence: 2,
    rolePromptProviders: IDENTITY_PROVIDERS,
    settingsEntry: name,
    status,
    // Sign-in, for the DSH owner's views only (the Bot team's owner-only route): never tools,
    // never listed by status(), and nothing here writes into a conversation or a model setting.
    // `label` names the view that opens an attempt (a Bot id) for the cancel confirmation.
    // An agent with its own home (Antigravity) answers the same five calls with its in-app
    // sign-in (#2048, parity): the link, its expiry and the field for the address the browser
    // ends on, the attempt Settings shows too. Never a terminal-only attempt.
    loginStart: (id, { label } = {}) => {
      restartGuard()
      if (isHomedNative(id)) return nativeLogins.start(id, label)
      return homes && consentIds.includes(id) ? startLogin(id, label) : logins.start(id, { label })
    },
    accountSignOut: (id, options) => signOutAccount(id, options),
    accountReset: id => resetAccount(id),
    /**
     * The in-app sign-in of an agent with its own home (Antigravity): starts ACP `authenticate`
     * in that home and answers status() at once; `signingIn` on its row while it runs, and
     * `signInError` (`unsupported`, `timeout`, `failed`, `no-browser`, `expired`) after a failure.
     * Refusals carry an `acp-sign-in/*` code (`unsupported`, `off`, `missing`) or `acp-account/busy`.
     */
    signInNative: id => signInNative(id),
    /**
     * The address the browser ended on after a sign-in on any computer, for the attempt
     * `attemptId` (#2048, paste-back): answers status() once it reached agy. Refusals carry
     * `acp-sign-in/not-this-sign-in` (not that attempt's address; the attempt goes on) or
     * `acp-sign-in/expired` (no such attempt waiting, or the address did not reach agy).
     */
    signInCallback: (id, attemptId, value) => signInCallback(id, attemptId, value),
    /** Signs out of an agent with its own home by retiring that home; refused on Windows. */
    accountSignOutNative: id => signOutNative(id),
    accountRecovery: async id => {
      if (!homes || !consentIds.includes(id)) return { required: false }
      const { key } = AGENTS[id]
      await homes.recoverLogins(key).catch(() => false)
      return { required: homes.recovery(key) }
    },
    accountSwitch: async (id, { label } = {}) => {
      // "Before" is read before the sign-out (#2064): only a signed-in, agreed account is compared.
      const compare = signIns.get(id) === true && ['given', 'carried'].includes(consentStates.get(id))
      await signOutAccount(id, { note: true })
      return startLogin(id, label, true, { compare })
    },
    /** The attempt at work for this agent, from any view, or undefined. Never starts or cancels one. */
    loginCurrent: id => (isHomedNative(id) ? nativeLogins.current(id) : logins.current(id)),
    loginStatus: (id, attemptId) => (isHomedNative(id) ? nativeLogins.status(id, attemptId) : logins.status(id, attemptId)),
    loginAnswer: (id, attemptId, value) => (isHomedNative(id) ? nativeLogins.answer(id, attemptId, value) : logins.answer(id, attemptId, value)),
    loginCancel: (id, attemptId) => (isHomedNative(id) ? nativeLogins.cancel(id, attemptId) : logins.cancel(id, attemptId)),
    /** Whether a text carries a sign-in state shown in the last day (Claude, Antigravity). Only a boolean. */
    loginTextMatches: text => logins.textMatches(text),
    /** How many sign-in attempts are starting, waiting or settling (the busy signal). */
    loginActive: () => loginActive(),
    loginActivity: () => loginActivity(),
    prepareRestart,
    /**
     * Which account an agent's CLI is signed in to, for the DSH owner's views only (#869): never
     * tools, never a status or inspect row, a log or an event. { id, signedIn?, consent?, ref?,
     * account?: { kind: 'account' | 'key', email?, org?, plan? }, notice? }. `ref` names the
     * account read (an install-keyed digest, or `unknown` when the CLI does not say who) and
     * goes back with `accountConfirm`; `notice` says a carried vendor's one-time notice is still
     * to be shown. `fresh` asks the CLI again instead of taking the last answer.
     */
    account: (id, { fresh = false } = {}) => accountOfAgent(id, { fresh }),
    /**
     * Reservation evidence for the DSH owner's views only (RFC 0024): never tools, status,
     * inspect, logs or events. The card compares `ref` with `account()` before offering Reserve.
     * Reserve must match the shown `exact` on a new read; refusal and sign-out must still match
     * under the same outcome on a new read. `changed` asks the caller to retry.
     * With reservationEvidence >= 2, `keys` adds `digests` from the same observation.
     * accountSignOut accepts `expect` with matching digests and an optional synchronous
     * `recheck` that must return true before sign-out proceeds.
     */
    async accountEvidence(id, { key, keys } = {}) {
      if (!validReservationKey(key)) {
        throw accountFailure('invalid', 'A reservation key must be 32 bytes.')
      }
      if (keys !== undefined && (!Array.isArray(keys) || keys.length < 1 || keys.length > 4
        || !Array.from(keys).every(validReservationKey))) {
        throw accountFailure('invalid', 'Reservation keys must be 32 bytes each.')
      }
      if (!Object.hasOwn(AGENTS, id)) return undefined
      const spec = AGENTS[id]
      if (isNative(spec) || consents === undefined) return { id, supported: false }
      inspections.delete(id)
      await inspect(id)
      await accountRead(id)
      const authenticated = signIns.get(id)
      if (authenticated !== true) return { id, ...(authenticated === false ? { signedIn: false } : {}) }

      const cli = clis.get(id)
      const version = authVersions.get(id)
      const changed = () => disposed || clis.get(id) !== cli || authVersions.get(id) !== version
        || signIns.get(id) !== true || accountChanges.has(id) || homes?.paused(spec.key)
      if (changed()) return { id, signedIn: true, outcome: 'changed' }
      const env = { ...process.env, ...cliEnvironment(spec, cliDetails.get(id)) }
      const { account: who, evidence } = await evidenceOf(spec, cli, { env })
      if (changed()) return { id, signedIn: true, outcome: 'changed' }

      const scope = homes ? { authScope: 'isolated' } : {}
      const result = evidence === undefined ? { outcome: 'unread', reservable: false, why: 'unknown' }
        : reservationOutcome(evidence)
      const digests = reservationDigests(evidence, key)
      return {
        id, ...scope, signedIn: true, vendor: spec.key, ref: refOf(who), ...result,
        ...(spec.key === 'codex' && evidence?.class !== undefined ? { class: evidence.class } : {}),
        ...digests,
        ...(keys && digests.loose
          ? { digests: keys.map(k => reservationDigests(evidence, k)) } : {}),
      }
    },
    // Read-only comparison for the owner's account controls. This never logs in, refreshes a
    // token or changes terminal auth; Bots' own account reads always use cliEnvironment.
    terminalAccount: async (id) => {
      if (!consentIds.includes(id)) return undefined
      const who = await account(AGENTS[id], clis.get(id), { env: { ...process.env } })
      const shown = accountView(who)
      return shown ? { account: shown } : undefined
    },
    /**
     * The person's word that the app may use the account this CLI is signed in to, shared with
     * their terminal: asks the CLI again, records the consent and announces the agent ready
     * (`acp-dsh/login-ready`), so the model the person chose is applied. `ref` is the account
     * they were shown; another account signed in meanwhile is refused (`acp-account/changed`).
     */
    accountConfirm: (id, { ref } = {}) => confirmAccount(id, ref),
    /** The one-time notice of a carried vendor was shown. */
    accountNoticed: (id) => { if (Object.hasOwn(AGENTS, id)) consents?.noticed(id) },
    /**
     * Whether Codex can draw an image now, on its own ChatGPT sign-in: { ready, signedIn?,
     * reason?, unsupported? }. Signed in and not ready, `reason` says which check of the image
     * run did not hold: `unsupported` (this Codex does not take the lockdown; `unsupported:
     * true` says the same), `config` (Codex cannot load its configuration) or `unreadable`
     * (the check keeps breaking).
     * Never starts a sign-in and never reads a credential.
     * Isolated ready answers include accountGeneration; pass it to generateImage to bind a
     * drawing selected here to this account generation (including zero).
     */
    imageAccess,
    /**
     * Draws one image with the Codex CLI (image.js): { prompt, size?, quality?, background?,
     * signal?, timeoutMs? } -> { base64, mimeType }. Refusals carry an `acp/image-*` code and a
     * message to show as it is.
     */
    generateImage,
    /**
     * Edits one uploaded picture with Codex: generateImage's fields plus
     * image: { base64, mimeType }, accountGeneration? -> { base64, mimeType }.
     * Refusals carry an `acp/image-*` code and a message to show as it is.
     */
    editImage,
    /**
     * Claude Code's native subagents in each running agent's current prompt, as workers
     * (acp.js workersOf), by DSH Session id: { [sessionId]: [{ id, title, state: 'running' |
     * 'done' | 'failed', result?, stopped?, at?, steps: [{ id, title, tool?, state }], more? }] }.
     * `stopped`: DSH closed it when its turn ended (Stop, or the agent went away), so it is
     * `failed` with the result `Stopped`. Only Sessions with a worker are listed. Read-only: it
     * starts, stops and answers nothing.
     */
    nativeWorkers: () => {
      const out = {}
      for (const [sessionId, state] of adapter.live) {
        let workers
        try { workers = state?.run?.workers?.() } catch { workers = undefined }
        if (Array.isArray(workers) && workers.length > 0) out[sessionId] = workers
      }
      return out
    },
    /** Read only the Bot that owns this Session. Returns this registration's disposer. */
    botIdentity: identityReaders.register,
    modelIdentityOf: (provider, model) => adapter.modelIdentityOf(provider, model),
    resolveModelIdentity: (provider, model) => adapter.resolveModelIdentity(provider, model),
    /** The live ACP acknowledgement for the answering DSH turn. A canonical resolver also checks for conflicting reports. */
    /**
     * Where an image an agent makes in a chat goes (agent-image.js): `keeper` is
     * { start?({ callId, sessionId, via }), keep({ callId, sessionId, base64, mimeType, via }) ->
     * Promise<{ file }>, fail?({ callId, sessionId, error }) }. The PNG comes from the agent's own
     * tool update, never from a file it saved. Returns the disposer; a later keeper replaces it.
     */
    keepImages(keeper) {
      imageKeeper = keeper
      return () => { if (imageKeeper === keeper) imageKeeper = undefined }
    },
    /**
     * Register one answerer for an unbridged Workspace Session's own mode. Before a prompt,
     * and again before sending it, answer({ sessionId, agent, provider }) must return exactly
     * true in time. Any other answer keeps strict mode. A second registration disables own
     * mode for good; the returned disposer clears only its own entry. Non-functions do nothing.
     */
    ownMode(answer) {
      if (typeof answer !== 'function') return () => {}
      if (ownContested || ownAnswerer !== undefined) {
        if (!ownContested) ctx.logger?.warn?.('acp-dsh: competing own-mode answerers; own mode is disabled')
        ownContested = true
        ownAnswerer = undefined
        return () => {}
      }
      const entry = { answer }
      ownAnswerer = entry
      return () => { if (ownAnswerer === entry) ownAnswerer = undefined }
    },
    /** Read the provider's own mode, bridge status and answerer availability. */
    ownModeOf(provider, sessionId) {
      const agent = agents.get(provider)
      if (agent?.ownMode === undefined) return undefined
      return { mode: agent.ownMode, bridged: adapter.bridgeOn(agent, sessionId), answerer: ownAnswerer !== undefined && !ownContested }
    },
    /** Whether a Session is busy on a prompt in its own mode. */
    ownModeIn: sessionId => adapter.ownModeIn(sessionId),
    /**
     * A veto on agent turns, for a plugin that must keep an agent from acting in a Session (the
     * Bot team: a Session whose permission level could not be set). `gate({ sessionId, agent,
     * provider })` is asked before every model step on an agent's route, and again right before
     * a turn's prompt is sent. It answers (or resolves) undefined to let the Session go, or the
     * sentence to answer the step with. It can only refuse: a gate that throws, takes longer
     * than ten seconds, or answers anything else holds the Session with a fixed sentence. A held
     * Session's agent session is ended (as `endSession`). Several plugins may register; any
     * refusal wins, and the returned disposer removes only its own gate. With none registered
     * nothing is asked.
     */
    holdTurns(gate) {
      if (typeof gate !== 'function') return () => {}
      const entry = { gate }
      turnGates.add(entry)
      return () => { turnGates.delete(entry) }
    },
    /**
     * Ends one Session's agent session now, a turn under way included: the agent's process is
     * stopped and its bridge credential revoked, and the step answers `why` (a sentence for the
     * person; a fixed one without it). The DSH Session and its transcript stay; the next turn
     * starts a fresh agent session. A turn still starting there is refused too. Answers whether
     * one was live or starting.
     */
    endSession: (sessionId, why) => adapter.endSession(sessionId, why),
    endClaudeSession: (sessionId, why, startupWhy) => adapter.endClaudeSession(sessionId, why, startupWhy),
    endOmpSession: (sessionId, why, startupWhy) => adapter.endOmpSession(sessionId, why, startupWhy),
    /**
     * Ends one Session's agent process when it holds its own tools: Claude's in native mode, a
     * Codex whose switch let it keep them (never an OFF Codex or one on a kept model). A process
     * still before its first prompt answers `startupWhy`.
     */
    endNative: (sessionId, why, startupWhy) => adapter.endNative(sessionId, why, startupWhy),
    /**
     * Whether a Bot's route (`acp-codex/<model>`) is on a model the native-tools switch never
     * applies to: it launches with Codex's own tools in every Session (agents.js
     * `nativeKeptModels`, or a model a check measured with no tool block for this Codex release,
     * any age). Anything else, or a failure, is false.
     */
    nativeModelKept: route => adapter.nativeKeptRoute(route),
    /**
     * The agents whose native-tools switch is their launch args (omp, Antigravity): the Bot team
     * offers Antigravity's switch only when it is listed here.
     */
    nativeArgsAgents: Object.freeze(Object.keys(AGENTS).filter(id => AGENTS[id].nativeSwitch === 'args')),
    /**
     * What Details says under Antigravity's switch, or undefined (another agent, or a failure):
     * `unchecked` (the version native tools off was checked on) when the agy version seen differs
     * from it, `hooks` / `plugins` while the current Antigravity home holds them (an OFF start
     * refuses then), and `fresh` with either off Windows (Switch account starts a new home).
     * `skillsUnavailable` uses the launch's exact executable proof.
     * Before any agy start in this host run the version is the installed folder's.
     */
    nativeOffNotes: provider => {
      if (provider !== 'acp-antigravity') return undefined
      try {
        const spec = AGENTS[provider]
        const notes = {
          ...(agySkillsProof(clis.get(provider)) === undefined && { skillsUnavailable: true }),
        }
        const version = agyVersionSeen ?? cliDetails.get(provider)?.version
        if (typeof version === 'string' && version !== AGY_OFF_CHECKED) notes.unchecked = AGY_OFF_CHECKED
        if (homedNative(spec)) {
          const found = agyExtensions(homes.home(spec.key))
          if (found.hooks) notes.hooks = true
          if (found.plugins) notes.plugins = true
          if ((found.hooks || found.plugins) && platform !== 'win32') notes.fresh = true
        }
        return notes
      } catch { return undefined }
    },
    /**
     * What acted on one Session's permissions, for a diagnostics view (read-only, a fresh plain
     * copy, undefined for a Session that ran no agent here): { version, agent, startedAt, active,
     * bridge?: { on, why, at, open? }, modes?: { wanted, offered, chosen?, fellToStrict, at,
     * current?, applied? }, lastCall?: { path, kind, at }, bridgeCall?: { at }, reviewer?:
     * { provider, model, ok, code?, at }, review?: { code, at }, ownMode?: { answer, taken, at } }. Identifiers and fixed values
     * only: never a credential, a prompt, a file's content or path, or an account.
     */
    permissionDiagnostics: sessionId => diagnostics.read(sessionId),
    /**
     * What the Bot team gates its one-time Claude move on: whether DSH's tools reach an agent
     * here (`dshTools`), and whether this machine's bridge really answers `initialize` and
     * `tools/list` for a freshly minted per-session credential. The answer is cached per
     * installed adapter version; off, a missing adapter, or a failed probe says no.
     */
    async bridge() {
      return bridgeStatus()
    },
    /**
     * One agent's status (`status()`'s row) with a fresh sign-in check: what the Bot team reads
     * before it puts a Bot on that agent. Read-only; undefined for an id that is no agent here.
     * @param {string} id
     */
    inspect,
    /** Looks for the CLIs again (one installed since DSH started) and asks each whether it is signed in. */
    async refresh() {
      inspections.clear()
      reconcile()
      // The person asked: a native agent that was not signed in is asked again.
      await probeAll({ fresh: true })
      // The owner asked: the answer waits for every account read.
      await Promise.all(accountReads.values())
      return status()
    },
    /**
     * Installs a manual CLI (Antigravity) on the person's click: only while its switch is on,
     * never one that is already here, and never an update. Answers at once, the install under
     * way (`cli.state: 'installing'`); the agent is offered when it ends.
     */
    async installCli(id) {
      const spec = AGENTS[id]
      if (spec === undefined) throw new Error(`no ACP agent ${String(id).slice(0, 40)}`)
      if (spec.cliInstall?.manual !== true || !cliStore) {
        throw Object.assign(new Error(`Automagik cannot install the ${spec.defaultName} CLI here.`), { code: 'acp-install/unsupported' })
      }
      if (!enabled(spec)) throw Object.assign(new Error(`Turn ${spec.defaultName} on first.`), { code: 'acp-install/off' })
      reconcile({ kick: false })
      if (clis.get(id) !== undefined) return status()
      void ensureCli(spec, { force: true, click: true })
      return status()
    },
    /** Retries the required CLI and its connector; answers at once without enabling a model. */
    async retry(id) {
      const spec = AGENTS[id]
      if (spec === undefined) throw new Error(`no ACP agent ${String(id).slice(0, 40)}`)
      reconcile({ kick: false })
      void ensureCli(spec, { force: true })
      // The connector is reinstalled when it is why the agent fails: its last start failed, its
      // last install failed (not only for want of npm), or it is missing; else Retry checks for a
      // release as before.
      // A native agent has no connector (install does nothing for it).
      if (agents.has(id)) void install(spec, { repair: !isNative(spec) && (startFailed.has(spec.adapter) || (store.lastFailure?.(spec.adapter) !== undefined && store.lastFailure(spec.adapter).unreachable === undefined) || store.binOf(spec.adapter, spec.bin) === undefined) })
      return status()
    },
  }

  reconcile({ kick: false })
  // The fake agent alone changes nothing reconcile counts.
  if (registration === undefined) publish()
  ctx.provide?.(SERVICE, service)
  ctx.on?.('llm/stream', aside(agents, ctx, () => flagOf(config.sideModel) ?? SIDE_MODEL, redact, diagnostics))
  // The record goes with its Session, and reads the review code of a call DSH's own gate refused.
  ctx.on?.('agent/disposed', ({ agent } = {}) => diagnostics.drop(agent?.session?.id))
  ctx.on?.('tools/result', (exec, result) => diagnostics.result(exec, result))
  // The other crossing: a transcript that carries an agent's turn is redacted before it is
  // handed back to a native provider. Live switching's rule, so it follows `dshTools`.
  const crossing = crossed(agents, ctx, redact, () => dshToolsOn(config.dshTools))
  ctx.on?.('llm/stream', crossing)
  // A switch flipped in the settings: offer or withdraw the agent now, and install what it needs.
  ctx.on?.('loader/volatile-update', () => { syncTools(); reconcile() })
  // DSH's updateBundle installs through installBundle, which emits reason "install" (there
  // is no "update" reason). It also emits when a change needs a later host restart. This
  // covers any plugin, not just ACP, and the background check never blocks plugin loading.
  ctx.on?.('plugin-manager/changed', change => { if (change?.reason === 'install') required() })
  // A model selection that moves a Session off its agent: its boundary row, and the agent
  // session (and bridge) belonging to the old route ends (RFC 0003, amendment, "Live switching").
  ctx.on?.('session/event', (session, event) => adapter.noteEvent(session, event))
  // The other half of a crossing: the effort the Session ran on follows it both ways when the
  // target offers it, and a notice says so when it cannot. Live switching's rule, so it
  // follows `dshTools`.
  const carry = carryEffort(
    async (provider, model) => (await ctx.llm.resolveModelInfo?.(provider, model))?.reasoning,
    () => dshToolsOn(config.dshTools),
    (previous, next) => agentRoute(agents, previous.provider) || agentRoute(agents, next.provider),
  )
  ctx.on?.('session/event', (session, event) => { void carry(session, event) })
  // The model-switch guard: an agent destination needs no compaction (pressure.js). Adopted when
  // an agent is created, and again on its requests, so an engine made after the agent (a
  // reloaded compaction plugin) is covered before its guard prices the next switch. The
  // request listener is not prepended: compaction-basic's prepended listener calls `next()`
  // (this one) before it prices the switch.
  // A compaction engine without that private method (a DSH update took it away, #871) is
  // said once, as a warning: the switch to an agent then fails as it did without this guard.
  let unguardedSaid = false
  const pressure = pressureGuard({
    agentDestination: provider => agentRoute(agents, provider),
    onUnguarded: (reason) => {
      if (unguardedSaid) return
      unguardedSaid = true
      warn(ctx, `the compaction engine ${reason === 'missing' ? 'has no' : 'does not let this plugin wrap'} ${PRESSURE_METHOD}: switching a conversation to Claude Code or Codex can fail (MODEL_SWITCH_COMPACTION_FAILED)`)
    },
  })
  const adoptPressure = (agent) => {
    if (agent === undefined || agent === null) return
    for (const engine of enginesFor(ctx, agent)) pressure.adopt(engine)
  }
  ctx.on?.('agent/created', ({ agent } = {}) => adoptPressure(agent))
  ctx.on?.('agent/request', (payload, next) => {
    adoptPressure(payload?.agent)
    return next()
  })
  // The newest adapter releases, at start and daily after; a Session already running keeps its own.
  const refresh = () => {
    for (const [id, spec] of Object.entries(AGENTS)) if (agents.has(id)) void install(spec)
  }
  const first = setTimeout(() => { required(); refresh() }, FIRST_CHECK_MS)
  const cliChecks = cliStore ? setInterval(required, CLI_CHECK_EVERY_MS) : undefined
  // Every few hours, so npm is asked at least once a day (install.js, CHECK_TICK_MS).
  const daily = setInterval(() => { reconcile({ kick: false }); refresh() }, CHECK_TICK_MS)
  first.unref?.()
  daily.unref?.()
  cliChecks?.unref?.()
  // Cordis 4 has no 'dispose' event: an effect's cleanup is what runs when the plugin stops.
  const dispose = () => {
    disposed = true
    homes?.closeRecovery()
    homes?.withdraw()
    // Restore the pressure wrapper before invoking the remaining cleanup hooks.
    pressure.dispose()
    clearTimeout(first)
    clearInterval(daily)
    for (const entry of checkRetries.values()) checkTimers.clearTimeout(entry.timer)
    checkRetries.clear()
    clearInterval(cliChecks)
    logins.dispose()
    // A running adapter install would otherwise outlive DSH and keep writing into its home.
    store.dispose?.()
    cliStore?.dispose?.()
    adapter.dispose()
    for (const id of nativeSignIns.keys()) abortNativeSignIn(id)
    if (homes && !prepared) {
      void Promise.all(homeIds.map(async id => {
        if (consentIds.includes(id)) await logins.stop(id)
        let home
        // A homed native agent's damaged pointer: nothing of it runs, and the rest goes on.
        try { home = homes.home(AGENTS[id].key) } catch (error) {
          if (isNative(AGENTS[id])) return
          throw error
        }
        await stopRuns(home)
      })).then(() => homes.dispose()).catch(() => {})
    }
    backchannel.dispose()
    diagnostics.clear()
  }
  if (ctx.effect) {
    ctx.effect(() => dispose)
    homes?.publishSelection()
  }
}

const idOf = spec => Object.keys(AGENTS).find(id => AGENTS[id] === spec)

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`acp-dsh: ${message}`)
  } catch {}
}

function imageWarn(ctx, line) {
  warn(ctx, line)
  try { console.error(`[acp-dsh] ${line}`) } catch {}
}

// A sign-in line that also reaches the app's log (dsh.log), as the image lines do: fixed words
// only, never an account, a link or a code.
function signInNote(ctx, line) {
  warn(ctx, line)
  try { console.error(`[acp-dsh] ${line}`) } catch {}
}

function info(ctx, message) {
  try {
    ctx.logger?.info?.(`acp-dsh: ${message}`)
  } catch {}
}
