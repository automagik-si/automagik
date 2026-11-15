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
const shownPath = (path) => {
  if (typeof path !== 'string') return undefined
  const home = homedir()
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
}

export function agentView(agent) {
  return {
    id: agent.id,
    key: agent.key,
    name: agent.name,
    on: agent.on === true,
    // The CLI as acp-dsh's own store has it (#749): installing, failed or ready, its version and
    // an update under way, redacted like the connector's.
    cli: {
      found: agent.cli?.found === true,
      ...(typeof agent.cli?.installUrl === 'string' && agent.cli.installUrl.startsWith('https://') ? { installUrl: agent.cli.installUrl } : {}),
      // The terminal command that signs in to a CLI with no sign-in in the app: a plain command
      // line, nothing else.
      ...(typeof agent.cli?.signInHint === 'string' && /^[a-z][a-z0-9]{0,23}( [a-z0-9-]{1,24}){0,4}$/.test(agent.cli.signInHint) ? { signInHint: agent.cli.signInHint } : {}),
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
      ...(typeof agent.connector?.version === 'string' ? { version: agent.connector.version } : {}),
      ...(typeof agent.connector?.error === 'string' ? { error: shownText(redactText(agent.connector.error)).slice(0, 300) } : {}),
      // Installed, but its last start failed: the settings page offers Retry, which reinstalls it.
      ...(agent.connector?.state === 'ready' && typeof agent.connector?.startError === 'string' ? { startError: shownText(redactText(agent.connector.startError)).slice(0, 300) } : {}),
      // The installer's own output and where it was written, for a failed connector.
      ...(typeof agent.connector?.diagnostic === 'string' ? { diagnostic: shownText(redactText(agent.connector.diagnostic)).slice(0, 4000) } : {}),
      ...(typeof agent.connector?.logPath === 'string' ? { logPath: shownPath(agent.connector.logPath) } : {}),
    },
    ...(typeof agent.signedIn === 'boolean' ? { signedIn: agent.signedIn } : {}),
    // Signed in on this computer, to an account the person has not confirmed for the app
    // (#869, acp-dsh's consent): only that it waits, never who it is.
    ...(agent.signedIn === true && agent.consent === 'needed' ? { consent: 'needed' } : {}),
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
  }
}
