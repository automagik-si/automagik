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
import { dirname, join, posix, sep } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { accountOf, accountView } from './src/host/account.js'
import { AcpAdapter, aside, BRIDGE_PATH, SIDE_MODEL } from './src/host/adapter.js'
import { AGENTS, findCommand, isNative, launchOf, signedInOf } from './src/host/agents.js'
import { Backchannel } from './src/host/backchannel.js'
import { batchSafe } from './src/host/batch-spawn.js'
import { Catalog, cliStamp, DEFAULT_MODEL } from './src/host/catalog.js'
import { CliStore, CLI_CHECK_EVERY_MS } from './src/host/clis.js'
import { CliHomes, HOME_ENV, stopRuns } from './src/host/cli-homes.js'
import { canRunProfile, ensureChatProfiles } from './src/host/codex-chat-profiles.js'
import { CONSENT_FILE, ConsentStore } from './src/host/consent.js'
import { adaptersHome, AdapterStore, CHECK_TICK_MS, homeRelativeText, redactInstallerOutput } from './src/host/install.js'
import { handshake } from './src/host/handshake.js'
import { drawImage, imageRefusal, imageSupport, SIGNED_OUT, UNAVAILABLE, unsupported } from './src/host/image.js'
import { CliLogins } from './src/host/login.js'
import { CREDENTIAL_ENV, URL_ENV } from './src/host/names.js'
import { PermissionDiagnostics } from './src/host/permission-diagnostics.js'
import { enginesFor, PRESSURE_METHOD, pressureGuard } from './src/host/pressure.js'
import { redactorFor } from './src/host/redact.js'
import { agentRoute, carryEffort, crossed } from './src/host/switch.js'

export const name = 'acp-dsh'
export const inject = ['llm', 'agents']

// The bridge, its DSH approval, the drift detector and live switching: an absent key takes the
// per-agent default for the bridge (Claude on; Codex only on an explicit true), the transcript
// replay reaches both agents unless the key is false (plan A-5), and false is the kill switch.
// The key is public (installed teams keep it in their profile patch). DSH_TOOLS_DEFAULT is the
// Claude/service view used for the bridge probe, crossings and effort carry; it is not a schema
// default, so an absent key still reaches the adapter as absent.
export const DSH_TOOLS_DEFAULT = true

// claude, codex, hermes, antigravity, omp, sideModel and dshTools are live (volatile): DSH's settings service writes them
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
  antigravity: z.boolean().default(false).volatile().description('Offer Antigravity as the acp-antigravity model when the agy CLI is installed. It runs `agy acp` on the sign-in and settings Antigravity already has on this computer.'),
  omp: z.boolean().default(false).volatile().description('Offer omp as the acp-omp model when the omp CLI is installed. It runs `omp acp` on the sign-in and settings omp already has on this computer.'),
  sideModel: z.object({
    provider: z.string().required(),
    model: z.string().required(),
  }).default({ ...SIDE_MODEL }).volatile().description("The model that writes a Session's title when the Session is on an agent and DSH's default model is an agent too. Never an agent."),
  fakeAgent: z.string().description('Tests only: a script that speaks ACP, served as the acp-fake model. The command comes from these host settings, never from a client route.'),
  // No schema default: absent is the per-agent default (Claude Code on, because only its
  // adapter can drop the built-in tool set; Codex off, so it never runs two tool sets), and an
  // explicit true/false is the person's word. False is also the kill switch and the 2026-11-03
  // behaviour. A schema default would materialise true and erase the difference. Hidden from
  // settings forms (`.hidden()`): it is a rollback lever, not a preference, and stays writable
  // through DSH's settings service and the profile patch.
  dshTools: z.boolean().volatile().hidden().description([
    "Hand DSH's own tools to the agent over a per-session MCP bridge named dsh (the Session's",
    "preset, filtered by its level), approve every DSH tool call in DSH whatever the agent's own",
    "rules say, and turn the agent's built-in tools off where its adapter allows. On by default",
    "for Claude Code; an agent whose adapter cannot drop its own tools (Codex) bridges only on an",
    'explicit true. The transcript reaches either agent when a Session moves to it, whatever the',
    'bridge, unless this is false. False is the kill switch and the behaviour without it: each',
    'agent keeps its own tools and approvals, and sees only its own session.',
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

/**
 * @param {any} ctx
 * @param {{ claude?: any, codex?: any, hermes?: any, antigravity?: any, omp?: any, sideModel?: any, fakeAgent?: string, dshTools?: any }}
 *   [config]
 * @param {{ store?: any, cliStore?: any, find?: typeof findCommand, signedIn?: typeof signedInOf, catalogHome?: string, loginSpawn?: typeof spawn, loginTimers?: any, imageSetup?: (launch: any) => Promise<any> }} [deps]
 *   catalogHome: where each agent's models and efforts are kept (beside the adapters by default).
 *   loginSpawn, loginTimers: tests only, a fake CLI process and clock for sign-in attempts.
 *   loginRecord: tests only, ownership records with a fake sign-in process.
 *   checkTimers: tests only, the clock of the retries after a connector check that failed.
 *   imageSetup: tests only, the image run's lockdown check (image.js imageSetup).
 *   account: reads which account a signed-in CLI is on (account.js); consentFile: where the
 *   person's word for each account is kept (consent.js), in the isolated CLI root by default.
 *   cliHome/logoutRun: private home root and fake logout runner for tests. A synthetic store
 *   without a home keeps the legacy in-memory test behavior; real stores always have a home.
 */
export function apply(ctx, config = {}, {
  store = new AdapterStore({ log: message => info(ctx, message) }),
  cliStore,
  find = name => findCommand(name), signedIn = signedInOf,
  catalogHome = store.home ? join(dirname(store.home), 'catalog') : undefined,
  loginSpawn, loginTimers, loginRecord, imageSetup, account = accountOf,
  cliHome = store.home ? join(dirname(store.home), 'cli-homes') : undefined,
  consentFile = cliHome ? join(cliHome, CONSENT_FILE)
    : typeof store.home === 'string' && store.home === adaptersHome()
      ? join(dirname(store.home), CONSENT_FILE) : undefined,
  logoutRun = execFile, checkTimers = globalThis, profileCheck = canRunProfile,
} = {}) {
  const homes = cliHome === undefined ? undefined : new CliHomes(cliHome)
  if (homes) for (const vendor of ['claude', 'codex']) {
    try { homes.startup(vendor) } catch {} // Unproved abandoned homes remain untouched.
  }
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
  // The turn gates (`holdTurns`): each registrant's own entry, so one never replaces another's.
  const turnGates = new Set()
  let ownAnswerer
  let ownContested = false
  const adapter = new AcpAdapter(ctx, agents, {
    ownMode: () => (ownContested ? undefined : ownAnswerer?.answer),
    holds: () => [...turnGates].map(entry => entry.gate),
    images: () => imageKeeper,
    // The raw tri-state: an absent setting takes each agent's own switch in AcpAdapter.
    dshTools: () => flagOf(config.dshTools),
    backchannel,
    redactor: redact,
    onSignedOut: id => signedOut(id),
    access: id => consentGate(id),
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
    const env = homes && !isNative(spec) ? homes.environment(spec.key) : {}
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
  const install = (spec, { repair = false } = {}) => {
    // A native agent has no connector: its CLI is the ACP server.
    if (isNative(spec)) return Promise.resolve()
    // The first-run account record is on disk before this version installs a connector, so a
    // connector found with no record always means an earlier version (consent.js).
    consents?.settle()
    const before = store.binOf(spec.adapter, spec.bin)?.path
    // A record that could not be written: a connector installed now would look, at the next
    // start, like one an earlier version left, and its vendor would be carried unasked. The
    // connector waits for the record (every later install tries the write again). One already
    // installed says nothing new, so its updates go on.
    if (consents !== undefined && !consents.saved && before === undefined) {
      if (!disposed) warn(ctx, `${spec.adapter} not installed yet: the account record could not be saved`)
      // Said as a failed install, so the settings page shows why and offers Retry, which comes
      // back here and tries the record again. Only the write error's code, never a path.
      recordWaits.set(spec.adapter, { message: `the account record could not be saved (${consents.saveError ?? 'error'})` })
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
    ...(typeof spec.signInHint === 'string' ? { signInHint: spec.signInHint } : {}),
    ...(spec.modeFor === undefined ? { levelNotice: true } : {}),
    cli,
    // The agent's own models and efforts, read from the adapter release installed now.
    catalog: new Catalog({
      id,
      name: spec.name,
      defaultName: spec.defaultName,
      fallback: spec.fallback,
      onChange: catalog => {
        if (!disposed && agents.get(id)?.catalog === catalog) publish()
      },
      home: homes && !isNative(spec) ? join(cliHome, 'catalog') : catalogHome,
      log,
      key: () => launch(spec, cli, id).key,
      spawn: () => { const { command, args, env } = launch(spec, cli, id); return { command, args, env } },
    }),
    installed: () => launch(spec, cli, id).ready,
    // The connector in use opened a session: it is the last-known-good. One that did not start
    // goes back to the release before it, when that is still here (install.js). A native agent
    // has no connector in the store, so it has neither: a failed start is only reported.
    ...(isNative(spec) ? {} : {
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
        throw new Error(failed
          ? `its ACP adapter (${spec.adapter}) is still being installed; the last install failed: ${failed}`
          : `its ACP adapter (${spec.adapter}) is still being installed; send this again in a minute`)
      }
      // The chat profiles of the Bot's isolated Codex home, for the session this process starts
      // (adapter.js keeps them with that session).
      if (homes && !isNative(spec) && spec.key === 'codex' && typeof env.CODEX_HOME === 'string' && typeof env.CODEX_PATH === 'string') {
        const profileModes = ensureChatProfiles(env.CODEX_HOME, {
          codexPath: env.CODEX_PATH, log: line => warn(ctx, line),
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
      // Only a CLI Automagik installs itself (`cliPackage`) can have a managed copy.
      const detail = (spec.cliPackage === undefined ? undefined : cliStore?.find(spec, external)) ?? (external ? { path: external, managed: false } : undefined)
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
    if (homes && !isNative(spec) && (accountChanges.has(id) || homes.paused(spec.key))) {
      signIns.set(id, false)
      return
    }
    const cli = clis.get(id)
    const env = { ...process.env, ...cliEnvironment(spec, cliDetails.get(id)) }
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
  const probeAll = options => Promise.all(Object.keys(AGENTS).map(id => probe(id, options)))
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
  // What a turn about to open on an agent is told (adapter.js `access`): a text when the account
  // its CLI is signed in to has not been confirmed, else undefined. A sign-in nobody has read
  // yet is read first; one already read answers at once and is read again in the background
  // when its answer is old, so no turn of a consented agent waits on the CLI.
  const consentGate = async (id) => {
    const spec = AGENTS[id]
    if (homes && spec && !isNative(spec)) {
      if (accountChanges.has(id) || homes.changing(spec.key) || homes.paused(spec.key)) {
        return `Sign in to ${spec.defaultName} in the app to resume this Bot. `
          + 'Your terminal login is separate.'
      }
      await inspect(id)
      if (signIns.get(id) !== true) {
        return `Sign in to ${spec.defaultName} in the app to resume this Bot. `
          + 'Your terminal login is separate.'
      }
    }
    if (consents === undefined || disposed || !Object.hasOwn(AGENTS, id)) return undefined
    const entry = inspections.get(id)
    const stale = entry === undefined || entry.cli !== clis.get(id) || (entry.at !== undefined && Date.now() - entry.at >= entry.ttl)
    if (signIns.get(id) === undefined || consentStates.get(id) === 'needed') {
      try { await inspect(id) } catch {}
    } else if (stale) void inspect(id).catch(() => {})
    if (signIns.get(id) !== true || consentStates.get(id) !== 'needed') return undefined
    // The Bot team's own refusal, word for word (its models.js ACCESS_MESSAGES.account), so the
    // row this text lands in is translated like that one. The account step says who it is.
    return `Confirm the account of ${AGENTS[id].defaultName} before using this model.`
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
  const ensureCli = (spec, { force = false } = {}) => {
    // Only a CLI with an official package (`cliPackage`) is Automagik's to install.
    if (!cliStore || disposed || spec.cliPackage === undefined) return Promise.resolve()
    return cliStore.ensure(spec, find(spec.cli), { force }).then(() => {
      if (!disposed) reconcile()
    }, () => {
      if (!disposed) {
        // Discovery may have found a newer verified local copy before the registry failed.
        reconcile()
        warn(ctx, `${spec.defaultName} update check failed: ${cliStore.lastError?.(spec.cliPackage) ?? 'the install failed'}`)
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
    const failure = native ? undefined : store.lastFailure?.(spec.adapter) ?? recordWaits.get(spec.adapter)
    const connectorState = native ? undefined : store.stateOf?.(spec.adapter)
    // Only a CLI Automagik installs itself has an install to report; any other is found or missing.
    const managed = cliStore !== undefined && spec.cliPackage !== undefined
    const cliFailure = managed ? cliStore.lastFailure(spec.cliPackage) : undefined
    const cliBusy = managed && cliStore.busy(spec.cliPackage) === true
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
        ...(typeof spec.signInHint === 'string' ? { signInHint: spec.signInHint } : {}),
        state: cli ? 'ready' : cliBusy || (managed && !cliFailure) ? 'installing' : cliFailure ? 'failed' : 'missing',
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
      ...(signIns.get(id) === undefined ? {} : { signedIn: signIns.get(id) }),
      ...(homes && !native ? { authScope: 'isolated' } : {}),
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
    // Why an attempt failed, for the host log (#970): a fixed class, where the attempt stood,
    // the CLI's exit and its version. Never what the CLI printed, a link, a code or an account.
    onFail({ id, cause, phase, exit }) {
      // The version of the CLI the attempt started, as it was read then (`resolve` below).
      const version = attemptVersions.get(id)
      const cli = typeof version === 'string' && /^\d+\.\d+\.\d+[\w.+-]{0,32}$/.test(version) ? `CLI ${version}` : 'CLI version unknown'
      warn(ctx, `sign-in to ${AGENTS[id]?.defaultName ?? id} failed: ${cause} (${phase}${exit === undefined ? '' : `, ${exit}`}; ${cli})`)
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
    async onReady(id, selected, { existing = false, valid = () => false } = {}) {
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
        if (!existing) consents.confirm(id, who)
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
    onActivity(activity) {
      try { ctx.emit?.('acp-dsh/login-activity', activity) } catch {}
    },
    onChange(active) {
      for (const id of restarting ? [] : loginLocks) {
        if (logins.current(id)) continue
        loginLocks.delete(id)
        homes.end(AGENTS[id].key)
      }
      try {
        ctx.emit?.('acp-dsh/login-active', { active })
      } catch (error) {
        warn(ctx, `the sign-in count was not announced: ${error?.message ?? error}`)
      }
    },
  })

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

  async function signOutAccount(id) {
    restartGuard()
    if (!homes || !consentIds.includes(id) || disposed) {
      throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    }
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const spec = AGENTS[id]
    const cli = clis.get(id)
    if (!cli) throw accountFailure('unavailable', 'Install the CLI before changing accounts.')
    if (loginLocks.delete(id)) homes.end(spec.key)
    homes.begin(spec.key)
    accountChanges.add(id)
    authVersions.set(id, (authVersions.get(id) ?? 0) + 1)
    signedOut(id)
    try {
      // Block admission first, then end starting/live chats, model probes, images and logins.
      adapter.endProvider(id, 'The Bot account changed. Sign in again in the app.')
      agents.get(id)?.catalog?.dispose()
      await logins.stop(id)
      await stopRuns(homes.home(spec.key))
      const env = cliEnvironment(spec, cliDetails.get(id))
      // Both CLIs may answer differently when logout is asked on a brand-new home. A definite
      // signed-out status already proves there is no login to end; unknown still logs out.
      if (await signedIn(spec, cli, { env }).catch(() => undefined) !== false) {
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

  async function resetAccount(id) {
    restartGuard()
    if (!homes || !consentIds.includes(id) || disposed) {
      throw accountFailure('unavailable', 'The Bot account cannot be changed here.')
    }
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const spec = AGENTS[id]
    // Reserve outside the replaceable home before pausing/awaiting work. Other app instances
    // cannot reset or admit a launch while the pointer transition is in progress.
    const reset = homes.reserveReset(spec.key)
    accountChanges.add(id)
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

  async function startLogin(id, label, alreadySignedOut = false) {
    restartGuard()
    if (!homes || !consentIds.includes(id)) return logins.start(id, { label })
    if (accountChanges.has(id)) throw accountFailure('busy', 'The Bot account is changing.')
    const current = logins.current(id)
    if (current) return current
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
    try { return logins.start(id, { label }) } catch (error) {
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
  const imageSupported = imageSupport({ ...(imageSetup ? { setup: imageSetup } : {}), log: line => warn(ctx, line) })
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
  const generateImage = async ({ prompt, size, quality, background, signal, timeoutMs,
    accountGeneration } = {}) => {
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
    if (!access.ready && access.reason === 'account') throw imageRefusal(UNAVAILABLE, 'Codex is signed in on this computer, but you have not confirmed its account for Automagik. Confirm it in a Bot\'s chat (choose a Codex model there), or add an OpenAI key, then try again.')
    // A Codex config that does not load, or a check that keeps breaking, may have been put
    // right since it was remembered: the draw's own check answers for those.
    if (!access.ready && access.reason !== 'config' && access.reason !== 'unreadable') {
      if (access.signedIn === false) throw imageRefusal(SIGNED_OUT, 'Codex is not signed in. Sign in to Codex from a Bot\'s chat, or add an OpenAI key, then try again.')
      if (access.unsupported === true) throw unsupported()
      throw imageRefusal(UNAVAILABLE, 'Codex cannot draw images here yet: it is off, not installed, or its sign-in could not be checked.')
    }
    try {
      return await drawImage({ spawn: () => {
        checkAccount()
        return agents.get(IMAGE_AGENT).spawn()
      }, prompt, size, quality, background, signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      name: AGENTS[IMAGE_AGENT].defaultName, log: line => warn(ctx, line) })
    } catch (error) {
      // A run refused as signed out says the CLI's sign-in ended: the next check asks again.
      if (error?.code === SIGNED_OUT) { signIns.delete(IMAGE_AGENT); signInChecks.delete(IMAGE_AGENT) }
      throw error
    }
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
      if (homes) await Promise.all(consentIds.map(id => stopRuns(homes.home(AGENTS[id].key))))
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
    settingsEntry: name,
    status,
    // Sign-in, for the DSH owner's views only (the Bot team's owner-only route): never tools,
    // never listed by status(), and nothing here writes into a conversation or a model setting.
    // `label` names the view that opens an attempt (a Bot id) for the cancel confirmation.
    loginStart: (id, { label } = {}) => {
      restartGuard()
      return homes && consentIds.includes(id) ? startLogin(id, label) : logins.start(id, { label })
    },
    accountSignOut: id => signOutAccount(id),
    accountReset: id => resetAccount(id),
    accountRecovery: id => ({ required: !!(homes && consentIds.includes(id)
      && homes.recovery(AGENTS[id].key)) }),
    accountSwitch: async (id, { label } = {}) => {
      await signOutAccount(id)
      return startLogin(id, label, true)
    },
    /** The attempt at work for this agent, from any view, or undefined. Never starts or cancels one. */
    loginCurrent: id => logins.current(id),
    loginStatus: (id, attemptId) => logins.status(id, attemptId),
    loginAnswer: (id, attemptId, value) => logins.answer(id, attemptId, value),
    loginCancel: (id, attemptId) => logins.cancel(id, attemptId),
    /** Whether a text carries a Claude sign-in state shown in the last day. Only a boolean. */
    loginTextMatches: text => logins.textMatches(text),
    /** How many sign-in attempts are starting or waiting (the busy signal). */
    loginActive: () => logins.activeAttempts(),
    loginActivity: () => logins.activity(),
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
    ownModeOf(provider) {
      const agent = agents.get(provider)
      if (agent?.ownMode === undefined) return undefined
      return { mode: agent.ownMode, bridged: adapter.bridgeOn(agent), answerer: ownAnswerer !== undefined && !ownContested }
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
  ctx.effect?.(() => () => {
    disposed = true
    // First, so a throwing cleanup below never leaves the wrapper on a live engine.
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
    if (homes && !prepared) {
      void Promise.all(consentIds.map(async id => {
        await logins.stop(id)
        await stopRuns(homes.home(AGENTS[id].key))
      })).then(() => homes.dispose()).catch(() => {})
    }
    backchannel.dispose()
    diagnostics.clear()
  })
}

const idOf = spec => Object.keys(AGENTS).find(id => AGENTS[id] === spec)

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`acp-dsh: ${message}`)
  } catch {}
}

function info(ctx, message) {
  try {
    ctx.logger?.info?.(`acp-dsh: ${message}`)
  } catch {}
}
