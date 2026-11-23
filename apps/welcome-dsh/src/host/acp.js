// Claude Code and Codex as DSH models, through @automagik/acp-dsh: what each has (its CLI,
// its connector, its sign-in, its model in the picker), read from acp-dsh's `acpAgents`
// service, and its switch, which is acp-dsh's own live setting (`claude`, `codex`) in its
// settings entry. Without acp-dsh every answer is { available: false } and the page shows
// nothing of it.
//
//   acp { refresh? }        the agents; `refresh` looks for the CLIs again and asks each
//                           whether it is signed in (the page does this when it opens)
//   acp-switch { id, on }   turns an agent on or off in acp-dsh's settings
//   acp-retry { id }        starts a failed connector install again
//   acp-install { id }      installs a CLI the app installs only on the person's click
//                           (Antigravity, acp-dsh `installCli`), while its switch is on
//   acp-sign-in { id }      signs in to an agent with its own home in the app (Antigravity,
//                           acp-dsh `signInNative`): its browser opens on this computer
//   acp-sign-out { id }     signs out of it by retiring its home (acp-dsh
//                           `accountSignOutNative`); never where its account is shared (Windows)
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { z } from 'zod'
import { parse } from './payloads.js'

export const ACP_SERVICE = 'acpAgents'
export const ACP_ENTRY = 'acp-dsh'
// Claude Code and Codex, then the native-ACP agents (acp-dsh #959): Hermes, Antigravity, omp.
export const ACP_IDS = ['acp-claude', 'acp-codex', 'acp-hermes', 'acp-antigravity', 'acp-omp']

const AgentId = z.enum(ACP_IDS)
const RefreshPayload = z.object({ refresh: z.boolean().optional() })
const SwitchPayload = z.object({ id: AgentId, on: z.boolean() })
const RetryPayload = z.object({ id: AgentId })
const SIGN_IN_CHECKS = new Set(['timeout', 'unreadable'])

const failure = (code, message) => Object.assign(new Error(message), { code })
const invalid = message => failure('omni-ai/invalid', message)
const refused = message => failure('omni-ai/refused', message)

// Only the fields the page draws: a newer acp-dsh may say more.
import { redactText } from './redact.js'

// A path under the person's home is shown relative to it, never as an absolute home path.
const shownText = (text) => {
  let out = String(text ?? '')
  const home = homedir()
  if (home.length > 1) {
    out = out.split(home).join('~')
    const slashes = home.replace(/\\/g, '/')
    if (slashes !== home) out = out.split(slashes).join('~')
  }
  return out
}
// The terminal command that signs in to a CLI with no sign-in in the app: a plain command line,
// or exactly the command for a copy of Antigravity acp-dsh installed itself, which is not on
// PATH and so is named by its path, quoted (acp-dsh agents.js signInHintOf). Shown, never run.
const BARE_HINT = /^[a-z][a-z0-9]{0,23}( [a-z0-9-]{1,24}){0,4}$/
const V = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`
const UUID = String.raw`[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}`
// The path's class is acp-dsh's (agents.js POSIX_UNSAFE, WIN32_UNSAFE): controls, line separators
// and bidi controls refused; \x60 is the backtick.
const UNSHOWN = String.raw`\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069`
const POSIX_AGY = new RegExp(String.raw`^'(/[^'\x60${UNSHOWN}]*/acp/clis/agy/${V}-${UUID}/bin/agy)' acp --login$`, 'u')
const WIN32_AGY = new RegExp(String.raw`^& "([A-Za-z]:\\[^"\x60$\u201C\u201D\u201E${UNSHOWN}]*\\acp\\clis\\agy\\${V}-${UUID}\\bin\\agy\.exe)" acp --login$`, 'u')
// Antigravity with its own home (acp-dsh agents.js isolatedSignInHintOf): its CLI by its path,
// in its home under the installation's cli-homes, and nothing else of the person's.
const POSIX_HOME = String.raw`/[^'\x60${UNSHOWN}]*/acp/(?:installations/[a-f0-9]{32}/)?cli-homes/(?:antigravity|homes/antigravity/${UUID})`
const POSIX_ISOLATED = new RegExp(String.raw`^env -i PATH="\$PATH" TERM="\$TERM" LANG="\$LANG" HOME='(${POSIX_HOME})' XDG_CONFIG_HOME='\1/config' XDG_DATA_HOME='\1/data' XDG_CACHE_HOME='\1/cache' XDG_STATE_HOME='\1/state' '(/[^'\x60${UNSHOWN}]*/agy)' acp --login$`, 'u')
const WIN32_CLASS = String.raw`[^"\x60$\u201C\u201D\u201E${UNSHOWN}]*`
const WIN32_HOME = String.raw`[A-Za-z]:\\${WIN32_CLASS}\\acp\\(?:installations\\[a-f0-9]{32}\\)?cli-homes\\(?:antigravity|homes\\antigravity\\${UUID})`
const WIN32_ISOLATED = new RegExp(String.raw`^\$env:USERPROFILE="(${WIN32_HOME})"; \$env:HOME="\1"; \$env:HOMEPATH="\1"; \$env:APPDATA="\1\\roaming"; \$env:LOCALAPPDATA="\1\\local"; & "([A-Za-z]:\\${WIN32_CLASS}\\agy\.exe)" acp --login$`, 'u')
const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/
export function isSignInHint(hint) {
  if (typeof hint !== 'string' || hint.length > 4096) return false
  if (BARE_HINT.test(hint)) return true
  const path = (POSIX_AGY.exec(hint) ?? WIN32_AGY.exec(hint))?.[1]
  if (path !== undefined) return !TRAVERSAL.test(path)
  const isolated = POSIX_ISOLATED.exec(hint) ?? WIN32_ISOLATED.exec(hint)
  return isolated !== null && !TRAVERSAL.test(isolated[1]) && !TRAVERSAL.test(isolated[2])
}
// The one word that says why an in-app sign-in failed (acp-dsh `signInError`).
const SIGN_IN_ERRORS = new Set(['unsupported', 'timeout', 'failed'])
// A sign-in link agy printed while it signs in (acp-dsh `signInUrl`, agents.js isSignInUrl):
// only Google's own OAuth entry points, over https, asking for a code for a named client.
const GOOGLE_SIGN_IN = new Set(['accounts.google.com/o/oauth2/v2/auth', 'accounts.google.com/o/oauth2/auth'])
export function isSignInUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\p{Cc}\s]/u.test(value)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (!GOOGLE_SIGN_IN.has(`${url.hostname}${url.pathname}`)) return false
    return url.searchParams.get('response_type') === 'code'
      && /^[\w.-]{1,256}$/.test(url.searchParams.get('client_id') ?? '')
  } catch { return false }
}

const shownPath = (path) => {
  if (typeof path !== 'string') return undefined
  const home = homedir()
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
}

export function agentView(agent) {
  const check = agent.signInCheck
  return {
    id: agent.id,
    key: agent.key,
    name: agent.name,
    on: agent.on === true,
    ...(agent.authScope === 'isolated' ? { authScope: 'isolated' } : {}),
    // The CLI as acp-dsh's own store has it (#749): installing, failed or ready, its version and
    // an update under way, redacted like the connector's.
    cli: {
      found: agent.cli?.found === true,
      ...(typeof agent.cli?.installUrl === 'string' && agent.cli.installUrl.startsWith('https://') ? { installUrl: agent.cli.installUrl } : {}),
      // The terminal command that signs in to a CLI with no sign-in in the app (isSignInHint).
      // Never for one that signs in here (Antigravity): no command reaches its row (#2048).
      ...(agent.appSignIn !== true && isSignInHint(agent.cli?.signInHint) ? { signInHint: agent.cli.signInHint } : {}),
      // A CLI the app installs only when the person clicks Install (Antigravity), and whether
      // the copy found is the one it installed (its row says it updates itself).
      ...(agent.cli?.install === 'manual' ? { install: 'manual', ...(agent.cli.managed === true ? { managed: true } : {}) } : {}),
      ...(['missing', 'installing', 'failed', 'ready'].includes(agent.cli?.state) ? { state: agent.cli.state } : {}),
      ...(typeof agent.cli?.version === 'string' ? { version: shownText(redactText(agent.cli.version)).slice(0, 80) } : {}),
      ...(agent.cli?.updating === true ? { updating: true } : {}),
      ...(typeof agent.cli?.error === 'string' ? { error: shownText(redactText(agent.cli.error)).slice(0, 300) } : {}),
      ...(typeof agent.cli?.diagnostic === 'string' ? { diagnostic: shownText(redactText(agent.cli.diagnostic)).slice(0, 4000) } : {}),
      ...(typeof agent.cli?.logPath === 'string' ? { logPath: shownText(redactText(agent.cli.logPath)) } : {}),
    },
    connector: {
      state: ['off', 'no-cli', 'installing', 'failed', 'ready'].includes(agent.connector?.state) ? agent.connector.state : 'installing',
      // A native agent: its CLI is the ACP server, so there is no connector to install or show.
      ...(agent.connector?.native === true ? { native: true } : {}),
      ...(agent.connector?.state === 'failed' && agent.connectorUnreachable === true ? { unreachable: true } : {}),
      ...(typeof agent.connector?.version === 'string' ? { version: agent.connector.version } : {}),
      ...(typeof agent.connector?.error === 'string' ? { error: shownText(redactText(agent.connector.error)).slice(0, 300) } : {}),
      // Installed, but its last start failed: the settings page offers Retry, which reinstalls it.
      ...(agent.connector?.state === 'ready' && typeof agent.connector?.startError === 'string' ? { startError: shownText(redactText(agent.connector.startError)).slice(0, 300) } : {}),
      // The installer's own output and where it was written, for a failed connector.
      ...(typeof agent.connector?.diagnostic === 'string' ? { diagnostic: shownText(redactText(agent.connector.diagnostic)).slice(0, 4000) } : {}),
      ...(typeof agent.connector?.logPath === 'string' ? { logPath: shownPath(agent.connector.logPath) } : {}),
    },
    ...(typeof agent.signedIn === 'boolean' ? { signedIn: agent.signedIn } : {}),
    // Why the last check could not tell: only these two words reach the page.
    ...(agent.signedIn === undefined && SIGN_IN_CHECKS.has(check) ? { signInCheck: check } : {}),
    // Signed in on this computer, to an account the person has not confirmed for the app
    // (#869, acp-dsh's consent): only that it waits, never who it is.
    ...(agent.signedIn === true && agent.consent === 'needed' ? { consent: 'needed' } : {}),
    // An agent with its own home that signs in here (Antigravity, #2048): exact values only.
    ...(agent.appSignIn === true ? { appSignIn: true } : {}),
    ...(agent.signingIn === true ? { signingIn: true } : {}),
    ...(agent.appSignIn === true && agent.signingIn === true && isSignInUrl(agent.signInUrl) ? { signInUrl: agent.signInUrl } : {}),
    ...(SIGN_IN_ERRORS.has(agent.signInError) ? { signInError: agent.signInError } : {}),
    ...(agent.signInWhere === 'terminal' ? { signInWhere: 'terminal' } : {}),
    // Its account is the person's own too (Windows Credential Manager): the row says so.
    ...(agent.sharedAccount === true ? { sharedAccount: true } : {}),
    listed: agent.model?.listed === true,
    restartNeeded: agent.restartNeeded === true,
  }
}

// acp-dsh's service, or undefined without it (or with one that cannot say its status).
export function acpService(ctx) {
  try {
    const found = ctx.get?.(ACP_SERVICE)
    return typeof found?.status === 'function' ? found : undefined
  } catch {
    return undefined
  }
}

// Whether an agent can answer a turn now: its CLI found and not installing or updating, its
// switch on, its connector ready, no restart pending, and the CLI signed in. The client's
// stateOf (acp-agents.js) says 'ready' for exactly this.
export function agentRunning(agent) {
  if (agent === undefined || agent === null) return false
  if (agent.cli?.found !== true || agent.cli.state === 'installing' || agent.cli.state === 'failed' || agent.cli.updating === true) return false
  // An account that waits for the person's word answers no turn (#869).
  if (agent.consent === 'needed') return false
  return agent.on === true && agent.connector?.state === 'ready' && agent.restartNeeded !== true && agent.signedIn === true
}

// Turns an agent on or off in acp-dsh's own settings (its `claude` or `codex` switch), the one
// switch every Bot on that agent shares. Answers acp-dsh's service.
export async function setAgent(ctx, id, on) {
  const acp = acpService(ctx)
  if (acp === undefined) throw refused('The ACP agents plugin is not running in this DSH.')
  const agent = (await acp.status())?.agents?.find(row => row.id === id)
  // The settings entry acp-dsh says is its own; an older acp-dsh does not say.
  const ns = typeof acp.settingsEntry === 'string' && acp.settingsEntry !== '' ? acp.settingsEntry : ACP_ENTRY
  const entry = ctx.settings.describe().find(row => row.ns === ns)
  if (agent === undefined || entry === undefined) throw refused('This DSH cannot change the ACP agents\' settings.')
  try {
    await ctx.settings.update(ns, { [agent.key]: on }, entry.revision)
  } catch (error) {
    if (error?.code === 'SETTINGS_CONFLICT') throw refused('The ACP agents\' settings changed while saving. Try again.')
    throw refused(`DSH did not save the switch: ${error?.message ?? error}`)
  }
  return acp
}

export function createAcpActions(ctx) {
  const service = () => acpService(ctx)
  const view = async (ask) => {
    const acp = service()
    if (acp === undefined) return { available: false, agents: [] }
    const status = await ask(acp)
    return { available: true, agents: (status?.agents ?? []).filter(agent => ACP_IDS.includes(agent?.id)).map(agentView) }
  }

  return {
    acp: (payload) => {
      const { refresh } = parse(RefreshPayload, payload ?? {}) ?? {}
      return view(acp => (refresh === true && typeof acp.refresh === 'function' ? acp.refresh() : acp.status()))
    },
    'acp-switch': async (payload) => {
      const asked = parse(SwitchPayload, payload)
      if (asked === undefined) throw invalid('Say which agent, and on or off.')
      const acp = await setAgent(ctx, asked.id, asked.on)
      // Turning one on looks for its CLI and its sign-in at once.
      return view(() => (asked.on && typeof acp.refresh === 'function' ? acp.refresh() : acp.status()))
    },
    'acp-retry': async (payload) => {
      const asked = parse(RetryPayload, payload)
      if (asked === undefined) throw invalid('Say which agent.')
      const acp = service()
      if (acp === undefined) throw refused('The ACP agents plugin is not running in this DSH.')
      return view(next => next.retry(asked.id))
    },
    // The person's click on Install. acp-dsh refuses while the agent is off; its words go back.
    'acp-install': async (payload) => {
      const asked = parse(RetryPayload, payload)
      if (asked === undefined) throw invalid('Say which agent.')
      const acp = service()
      if (acp === undefined) throw refused('The ACP agents plugin is not running in this DSH.')
      if (typeof acp.installCli !== 'function') throw refused('This ACP agents plugin cannot install that CLI.')
      try {
        return await view(next => next.installCli(asked.id))
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('acp-install/')) throw refused(String(error.message).slice(0, 300))
        throw error
      }
    },
    // The person's click on Sign in, for an agent that signs in here: answers at once, the
    // sign-in under way (`signingIn`). acp-dsh's refusals go back in its words.
    'acp-sign-in': async (payload) => {
      const asked = parse(RetryPayload, payload)
      if (asked === undefined) throw invalid('Say which agent.')
      const acp = service()
      if (acp === undefined) throw refused('The ACP agents plugin is not running in this DSH.')
      if (typeof acp.signInNative !== 'function') throw refused('This ACP agents plugin cannot sign in to that agent here.')
      try {
        return await view(next => next.signInNative(asked.id))
      } catch (error) {
        if (typeof error?.code === 'string' && /^acp-(?:sign-in|account)\//.test(error.code)) throw refused(String(error.message).slice(0, 300))
        throw error
      }
    },
    // Sign out of such an agent: only a row that signs in here, and never one whose account is
    // shared (Windows), where retiring its home would not sign out. acp-dsh refuses that too.
    'acp-sign-out': async (payload) => {
      const asked = parse(RetryPayload, payload)
      if (asked === undefined) throw invalid('Say which agent.')
      const acp = service()
      if (acp === undefined) throw refused('The ACP agents plugin is not running in this DSH.')
      if (typeof acp.accountSignOutNative !== 'function') throw refused('This ACP agents plugin cannot sign out of that agent here.')
      const row = (await acp.status())?.agents?.find(agent => agent?.id === asked.id)
      if (row?.appSignIn !== true) throw refused('Sign out of this agent where you signed in to it.')
      if (row.sharedAccount === true) throw refused(`Sign out is not available on Windows. Sign out in ${row.name ?? 'the agent'} itself.`)
      try {
        await acp.accountSignOutNative(asked.id)
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('acp-account/')) throw refused(String(error.message).slice(0, 300))
        throw error
      }
      return view(next => next.status())
    },
  }
}
