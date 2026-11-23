import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { raised } from './clay.js'

// Claude Code and Codex as DSH models (@automagik/acp-dsh), set up from the page: whether the
// CLI is on this computer (installing, updating or failed as acp-dsh's store says, with its install
// link when it is missing), the connector acp-dsh installs in the background, the CLI's own
// sign-in, and a switch that is acp-dsh's own claude/codex setting. Drawn in Settings (the
// acp-agents section); without acp-dsh the host answers { available: false } and Settings says
// so. Connect AI has no section of its own for them: its Claude and ChatGPT rows are these CLIs
// (connect-ai.js), and draw an agent's lines (AcpLine) while it is not ready.
//
// A signed-out CLI is signed in from a Bot's chat (the Bot team's sign-in row, plan v3 2.3): the
// row's Sign in button opens that chat, in the selected Bot or else the Main Bot, through the Bot
// team's bridge. Opening it starts no sign-in, picks no model and sends nothing; the page never
// sees a link, a code or a credential. The terminal command signs in to a shared CLI home.
//
// Antigravity runs in this installation's own home (#2048, `appSignIn`): its row signs in here,
// over ACP, with its browser opening on this computer (Sign in), names the terminal command that
// signs in to that same home as the fallback, and signs out by retiring the home (Sign out). On
// Windows its account is shared with the person's own agy (`sharedAccount`): every state of the
// row says so, and there is no Sign out.

export const CLI_OF = { 'acp-claude': 'claude', 'acp-codex': 'codex', 'acp-hermes': 'hermes', 'acp-antigravity': 'agy', 'acp-omp': 'omp' }
export const LOGO_OF = { 'acp-claude': 'CC', 'acp-codex': 'CX', 'acp-hermes': 'HM', 'acp-antigravity': 'AG', 'acp-omp': 'OM' }
// The native-ACP agents (acp-dsh #959: Hermes, Antigravity, omp) have no connector and no
// sign-in in a Bot's chat: the host marks their rows (`connector.native`) and names the terminal
// command that signs in (`cli.signInHint`). They are off until the person turns one on, which
// is their word that the app may use the sign-in that CLI already has on this computer.
export const isNative = agent => agent?.connector?.native === true
const isolatedSignIn = agent => agent.authScope === 'isolated' && !isNative(agent)
const signInCommand = agent => agent.cli?.signInHint ?? SIGN_IN_OF[agent.id] ?? CLI_OF[agent.id] ?? agent.key
// How the person signs in to the CLI in a terminal, the other way to the chat's row.
export const SIGN_IN_OF = { 'acp-claude': 'claude auth login', 'acp-codex': 'codex login' }
// The Bot team's bridge (apps/bots-dsh src/client/cli-login.js, CLI_LOGIN_BRIDGE): open(provider)
// opens the sign-in row in a Bot's chat and answers whether it could.
export const CHAT_LOGIN = Symbol.for('automagik.cli-login')
export function openChatLogin(provider, scope = globalThis) {
  if (!Object.hasOwn(SIGN_IN_OF, provider)) return false
  try { return scope[CHAT_LOGIN]?.open?.(provider) === true } catch { return false }
}
export const POLL_MS = 2000
const UNREACHABLE_POLL_MS = 15_000
export const SETTINGS_SECTION = 'acp-agents'
const cliBusy = agent => agent.cli.state === 'installing' || agent.cli.updating === true

// Where the agent stands, in one word: whether it can run, not only whether its connector is there.
// A found CLI whose last update failed (offline, say) still runs: its Retry line shows, but the
// state goes on to the connector, restart and sign-in, so it can still be Ready.
export function stateOf(agent) {
  if (agent.cli.state === 'installing') return 'installing'
  if (agent.cli.updating === true) return 'updating'
  if (agent.cli.state === 'failed' || (!agent.cli.found && agent.cli.error)) return 'failed'
  if (!agent.cli.found) return 'no-cli'
  if (!agent.on) return 'off'
  if (agent.connector.state !== 'ready') return agent.connector.state
  // Installed, but its last start failed: it needs a retry.
  if (typeof agent.connector.startError === 'string') return 'failed'
  if (agent.restartNeeded) return 'restart'
  if (agent.signedIn !== true) return agent.signedIn === false ? 'login-required' : 'sign-in-unknown'
  // Signed in on this computer, to an account that waits for the person's word (#869).
  if (agent.consent === 'needed') return 'account'
  return 'ready'
}

// The chip beside the name: the one word that says where the agent stands.
export function badgeOf(agent) {
  const state = stateOf(agent)
  if (state === 'no-cli') return t('Not installed')
  if (state === 'off') return t('Off')
  if (state === 'installing') return agent.cli.state === 'installing' ? t('Installing') : t('Setting up')
  if (state === 'updating') return t('Updating')
  if (state === 'failed') return t('Needs a retry')
  if (state === 'restart') return t('Restart needed')
  if (state === 'login-required') return t('Sign-in needed')
  if (state === 'sign-in-unknown') return t('Check sign-in')
  if (state === 'account') return t('Confirm account')
  if (state === 'ready') return t('Ready')
  return null
}

import { redactText } from './redact.js'

// Exported so the tests can exercise the client-layer redaction alone.
export { redactText }

/**
 * What the row says under its name, line by line: the CLI, the connector, the sign-in, and
 * where to find the model. Each line: { tone: ok|wait|bad|muted, text, link?, action? }, an
 * action being 'check' (look again), 'login' (the sign-in row in a Bot's chat), 'retry' (the
 * connector's install, or the CLI's) or 'install' (a CLI the app installs only on the person's
 * click). An account in Settings can also offer 'switch'.
 */
export function agentLines(agent, entry) {
  const name = agent.name
  const cli = CLI_OF[agent.id] ?? agent.key
  const lines = []
  // A CLI the app installs only when the person clicks Install (Antigravity): never on its own,
  // and only while the agent is on. Its install page shows only when the app's install failed.
  const manual = agent.cli.install === 'manual'
  if (manual && !agent.cli.found) {
    if (cliBusy(agent)) lines.push({ tone: 'wait', text: t('Installing {name}…', { name }) })
    else if (agent.cli.state === 'failed' || agent.cli.error) {
      lines.push({
        tone: 'bad',
        text: agent.cli.error ? t('The {name} installation or update failed: {error}', { name, error: redactText(agent.cli.error) }) : t('The {name} installation or update failed.', { name }),
        // Retry installs, so it shows only while the agent is on; off keeps the text and the link.
        ...(agent.on ? { action: 'install', label: t('Retry') } : {}),
        ...(agent.cli.installUrl ? { link: { href: agent.cli.installUrl, text: t('Install it yourself instead') } } : {}),
        ...(agent.cli.diagnostic ? { details: { diagnostic: redactText(agent.cli.diagnostic), ...(agent.cli.logPath ? { logPath: agent.cli.logPath } : {}) } } : {}),
      })
    } else if (agent.on) {
      lines.push({ tone: 'muted', text: t('The {cli} CLI is not on this computer. Automagik can install it for you.', { cli }), action: 'install' })
    } else {
      lines.push({ tone: 'muted', text: t('The {cli} CLI is not on this computer. Turn {name} on to install it.', { cli, name }) })
    }
    if (agent.sharedAccount === true) lines.push(sharedLine(name))
    return lines
  }
  if (cliBusy(agent)) {
    lines.push({ tone: 'wait', text: agent.cli.updating ? t('Updating {name} automatically…', { name }) : t('Installing {name} automatically…', { name }) })
  } else if (agent.cli.state === 'failed' || agent.cli.error) {
    lines.push({
      tone: 'bad',
      text: agent.cli.error ? t('The {name} installation or update failed: {error}', { name, error: redactText(agent.cli.error) }) : t('The {name} installation or update failed.', { name }),
      action: 'retry',
      ...(agent.cli.diagnostic ? { details: { diagnostic: redactText(agent.cli.diagnostic), ...(agent.cli.logPath ? { logPath: agent.cli.logPath } : {}) } } : {}),
    })
  }
  if (!agent.cli.found) {
    if (lines.length === 0) lines.push({ tone: 'muted', text: t('The {cli} CLI is not on this computer. Install it, sign in, then check again.', { cli }), ...(agent.cli.installUrl ? { link: { href: agent.cli.installUrl, text: t('Install {name}', { name }) } } : {}), action: 'check' })
    if (agent.sharedAccount === true) lines.push(sharedLine(name))
    return lines
  }
  lines.push({
    tone: 'ok',
    text: manual && agent.cli.managed === true && agent.cli.version
      ? t('Found the {cli} CLI (installed by Automagik as version {version}; it updates itself).', { cli, version: agent.cli.version })
      : agent.cli.version ? t('Found the {cli} CLI on this computer (version {version}).', { cli, version: agent.cli.version }) : t('Found the {cli} CLI on this computer.', { cli }),
  })
  if (agent.sharedAccount === true) lines.push(sharedLine(name))
  const app = agent.appSignIn === true
  if (agent.signedIn === true && agent.consent !== 'needed' && app) {
    // Sign out retires this installation's home; not where the account is shared (Windows).
    lines.push({ tone: 'ok', text: t('Signed in to {name}.', { name }), ...(agent.sharedAccount === true ? {} : { action: 'native-sign-out' }) })
  } else if (agent.signedIn === true && agent.consent !== 'needed') {
    const canSwitch = isolatedSignIn(agent) && entry?.authScope === 'isolated' && entry.signedIn === true
    const account = canSwitch && entry.account?.kind === 'account' ? entry.account.email ?? entry.account.org : undefined
    lines.push({
      tone: 'ok',
      text: account ? t('Signed in to {name} as {account}.', { name, account }) : t('Signed in to {name}.', { name }),
      ...(canSwitch ? { action: 'switch' } : {}),
    })
    if (canSwitch) lines.push({ tone: 'muted', text: t('Bots in this installation share this account. Your terminal sign-in stays as it is.') })
  }
  // Already signed in on this computer (the terminal's sign-in): the Bot's chat shows the
  // account and asks before any Bot uses it.
  if (agent.signedIn === true && agent.consent === 'needed' && !cliBusy(agent)) lines.push({ tone: 'bad', text: t('{name} is signed in on this computer. Confirm its account in a Bot\'s chat before Bots use it.', { name }), action: 'login', label: t('Confirm account') })
  // An agent with its own home signs in here, while it is on (acp-dsh refuses it off).
  if (app && agent.on && !cliBusy(agent)) lines.push(...appSignInLines(agent, name))
  // A native agent signs in only in a terminal, with its own command.
  if (agent.signedIn === false && isNative(agent) && !app) lines.push({ tone: 'bad', text: t('Not signed in to {name}. Run {command} in a terminal, then check again.', { name, command: signInCommand(agent) }), action: 'check' })
  // A terminal sign-in cannot reach the isolated home used by the app.
  if (agent.signedIn === false && !isNative(agent) && !cliBusy(agent)) {
    lines.push({ tone: 'bad', text: t('Not signed in to {name}. Sign in from a Bot\'s chat.', { name }), action: 'login' })
    if (!isolatedSignIn(agent)) lines.push({ tone: 'muted', text: t('Or run {command} in a terminal, then check again.', { command: SIGN_IN_OF[agent.id] ?? cli }), action: 'check' })
  }
  // A native agent that is off is never started, so there is no sign-in to check yet.
  if (agent.signedIn === undefined && !cliBusy(agent) && (agent.on || !isNative(agent))) {
    const text = agent.signInCheck === 'timeout'
      ? t('Could not check the sign-in to {name}: {cli} took too long to answer.', { name, cli })
      : agent.signInCheck === 'unreadable'
        ? t('Could not tell whether you are signed in to {name}.', { name })
        : t('The sign-in to {name} has not been checked yet.', { name })
    lines.push({ tone: 'muted', text, action: 'check' })
  }
  if (!agent.on) {
    lines.push({ tone: 'muted', text: t('Off. Turn it on to use {name} as a model in DSH.', { name }) })
    if (app && agent.sharedAccount !== true) lines.push({ tone: 'muted', text: t('Automagik keeps its own {name} sign-in, apart from the one in your terminal.', { name }) })
    else if (isNative(agent)) lines.push({ tone: 'muted', text: t('Turning it on lets Automagik use the sign-in {name} already has on this computer.', { name }) })
    return lines
  }
  const { state, version, error, diagnostic, logPath, unreachable } = agent.connector
  if (state === 'installing') lines.push({ tone: 'wait', text: t('Installing its connector in the background. This takes a minute or two.') })
  if (state === 'failed') {
    lines.push({
      tone: 'bad',
      text: unreachable === true
        ? t('Could not reach the connector registry. Automagik tries again by itself, or press Retry.')
        : error ? t('The connector did not install: {error}', { error: redactText(error) }) : t('The connector did not install.'),
      action: 'retry',
      // What DSH 0.2.2 shows for a failed plugin install: the full diagnostic and its log file.
      // The panel and its expander read this one value, so the shared table runs here too: a
      // diagnostic that arrived unredacted still draws masked.
      ...(diagnostic ? { details: { diagnostic: redactText(diagnostic), ...(logPath ? { logPath } : {}) } } : {}),
    })
  }
  if (state === 'ready' && typeof agent.connector.startError === 'string') {
    // Installed, but it did not start: Retry reinstalls the same release (acp-dsh).
    lines.push({ tone: 'bad', text: t('The connector did not start: {error}', { error: redactText(agent.connector.startError) }), action: 'retry' })
    return lines
  }
  if (state === 'ready') {
    if (!isNative(agent)) lines.push({ tone: 'ok', text: version ? t('Connector ready (version {version}).', { version }) : t('Connector ready.') })
    if (agent.restartNeeded) lines.push({ tone: 'bad', text: t('Restart DSH to see {name} in the model picker.', { name }) })
    else if (stateOf(agent) === 'ready') lines.push({ tone: 'ok', text: t('Ready: pick {name} in the model picker.', { name }), ready: true })
  }
  return lines
}

// Windows keeps Antigravity's sign-in in Credential Manager, shared with the person's own agy.
const sharedLine = name => ({ tone: 'muted', text: t('On Windows, the {name} account is shared: Automagik and your own {name} on this computer use one sign-in, kept in Windows Credential Manager. Sign out is not available here: sign out in {name} itself.', { name }) })

// The sign-in lines of an agent that signs in here (`appSignIn`): under way, why the last one
// failed, signed out with Sign in (or, with no browser on this computer, the terminal command
// only), and the terminal command as the fallback.
function appSignInLines(agent, name) {
  const lines = []
  const command = agent.cli.signInHint
  if (agent.signingIn === true) return [{ tone: 'wait', text: t('Finish the sign-in to {name} in your browser…', { name }) }]
  if (agent.signInError === 'unsupported') lines.push({ tone: 'bad', text: t('{name} did not offer a Google sign-in. Use the terminal command below.', { name }) })
  if (agent.signInError === 'timeout') lines.push({ tone: 'bad', text: t('The sign-in to {name} took too long. Try again.', { name }) })
  if (agent.signInError === 'failed') lines.push({ tone: 'bad', text: t('The sign-in to {name} did not finish. Try again.', { name }) })
  if (agent.signedIn !== false) return lines
  if (agent.signInWhere === 'terminal') {
    lines.push(command
      ? { tone: 'bad', text: t('Not signed in to {name}. This computer has no browser for the sign-in: run {command} in a new terminal window, then check again.', { name, command }), action: 'check' }
      : { tone: 'bad', text: t('Not signed in to {name}. This computer has no browser for the sign-in.', { name }), action: 'check' })
    return lines
  }
  lines.push({ tone: 'bad', text: t('Not signed in to {name}. Sign in here: your browser opens to finish.', { name }), action: 'native-login' })
  if (command) lines.push({ tone: 'muted', text: t('If no browser opens, run {command} in a new terminal window, then check again.', { command }), action: 'check' })
  return lines
}

// The agents' state from the host, refreshed (CLI search, sign-in) when the page opens and
// polled while a CLI or a connector installs, a switch is settling, or the connector registry
// is unreachable. `onLoginOpen` runs once a Bot's chat took a sign-in, so the page around it
// can step aside; `open` is the bridge (a test hands its own).
export function useAcp(request = call, { onLoginOpen, open = openChatLogin } = {}) {
  const [view, setView] = useState(null)
  const [busy, setBusy] = useState(null)
  const [problems, setProblems] = useState({})
  const [wanted, setWanted] = useState({})
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  const show = useCallback((next) => {
    if (!live.current) return
    setView(next ?? { available: false, agents: [] })
    setWanted(previous => Object.fromEntries(Object.entries(previous).filter(([id, on]) => next?.agents?.find(agent => agent.id === id)?.on !== on)))
  }, [])
  const load = useCallback(async (refresh) => {
    try {
      show(await request('acp', refresh ? { refresh: true } : null))
    } catch {
      // No acp-dsh, or a DSH that does not answer: nothing to draw.
      if (live.current) setView(previous => previous ?? { available: false, agents: [] })
    }
  }, [request, show])
  useEffect(() => { void load(true) }, [load])

  const settling = view?.agents?.some(agent => cliBusy(agent) || agent.signingIn === true || (agent.on && agent.cli.found && agent.connector.state === 'installing') || (wanted[agent.id] !== undefined && wanted[agent.id] !== agent.on)) === true
  const unreachable = view?.agents?.some(agent => agent.on && agent.cli.found && agent.connector.state === 'failed' && agent.connector.unreachable === true) === true
  const pollMs = settling ? POLL_MS : unreachable ? UNREACHABLE_POLL_MS : undefined
  useEffect(() => {
    if (pollMs === undefined) return undefined
    const timer = setInterval(() => { void load(false) }, pollMs)
    return () => clearInterval(timer)
  }, [pollMs, load])

  // The agent whose Sign out waits for the person's Continue.
  const [signingOut, setSigningOut] = useState(null)
  const say = (id, message) => setProblems(previous => ({ ...previous, [id]: message }))
  // Whether the host took it; a refusal leaves its words on the row.
  const act = async (id, endpoint, payload) => {
    say(id, null)
    setBusy(id)
    let ok = true
    try {
      show(await request(endpoint, payload))
    } catch (error) {
      ok = false
      say(id, error.message)
    }
    if (live.current) setBusy(null)
    return ok
  }
  return {
    view,
    busy,
    problems,
    setProblem: say,
    isOn: agent => wanted[agent.id] ?? agent.on,
    flip: async (agent) => {
      const on = !(wanted[agent.id] ?? agent.on)
      setWanted(previous => ({ ...previous, [agent.id]: on }))
      // Refused: the switch goes back to what acp-dsh has, and nothing waits for it to settle.
      if (!(await act(agent.id, 'acp-switch', { id: agent.id, on })) && live.current) {
        setWanted(previous => (previous[agent.id] === on ? Object.fromEntries(Object.entries(previous).filter(([id]) => id !== agent.id)) : previous))
      }
    },
    retry: agent => act(agent.id, 'acp-retry', { id: agent.id }),
    // The person's click on Install (a CLI the app installs only then).
    install: agent => act(agent.id, 'acp-install', { id: agent.id }),
    check: agent => act(agent.id, 'acp', { refresh: true }),
    // An agent that signs in here: Sign in starts it (its browser opens), and Sign out asks
    // first, with the same words as the account switch, then retires its home.
    nativeLogin: agent => act(agent.id, 'acp-sign-in', { id: agent.id }),
    signOutPending: signingOut,
    askSignOut: (agent) => { say(agent.id, null); setSigningOut(agent.id) },
    cancelSignOut: () => setSigningOut(null),
    nativeSignOut: (agent) => { setSigningOut(null); return act(agent.id, 'acp-sign-out', { id: agent.id }) },
    refresh: () => load(true),
    // Reads the agents again without asking the CLIs (after the host changed a switch).
    reload: () => load(false),
    // Opens the sign-in row in a Bot's chat. An isolated sign-in needs that chat.
    login: (agent) => {
      say(agent.id, null)
      if (!open(agent.id)) {
        say(agent.id, isolatedSignIn(agent)
          ? t('Sign-in needs a Bot chat. If you have no Bot yet, set one up first.')
          : t('No Bot chat to sign in from here. Run {command} in a terminal instead.', { command: signInCommand(agent) }))
        return false
      }
      onLoginOpen?.(agent)
      return true
    },
  }
}

export function AcpLine({ line, agent, acp, busy, accountControls }) {
  const canSwitch = line.action === 'switch' && accountControls !== undefined
  const signOut = line.action === 'native-sign-out'
  const confirmingOut = signOut && acp.signOutPending === agent.id
  const confirming = (canSwitch && accountControls.pending === agent.id) || confirmingOut
  const accountButton = (label, onClick) => h('button', { type: 'button', className: 'oai-ghost oai-acp-act', disabled: busy, onClick }, label)
  return h('div', { className: 'oai-acp-line-block' },
    h('p', { className: `oai-acp-line oai-acp-${line.tone}${line.tone === 'wait' ? ' oai-waiting' : ''}`, ...(line.tone === 'bad' ? { role: 'status' } : {}) },
      confirming ? t('This stops running Bot work for this account. Continue?') : line.text,
      line.link ? [' ', h('a', { key: 'link', className: 'oai-link', href: line.link.href, target: '_blank', rel: 'noreferrer' }, line.link.text)] : null,
      line.action === 'retry' ? h('button', { type: 'button', className: 'oai-ghost oai-acp-act', disabled: busy, onClick: () => acp.retry(agent) }, t('Retry')) : null,
      line.action === 'install' ? h('button', { type: 'button', className: 'oai-ghost oai-acp-act', disabled: busy, onClick: () => acp.install(agent) }, line.label ?? t('Install')) : null,
      line.action === 'login' ? h('button', { type: 'button', className: 'oai-ghost oai-acp-act', disabled: busy, onClick: () => acp.login(agent) }, line.label ?? t('Sign in')) : null,
      line.action === 'check' ? h('button', { type: 'button', className: 'oai-ghost oai-acp-act', disabled: busy, onClick: () => acp.check(agent) }, t('Check again')) : null,
      line.action === 'native-login' ? h('button', { type: 'button', className: 'oai-ghost oai-acp-act', disabled: busy, onClick: () => acp.nativeLogin(agent) }, t('Sign in')) : null,
      canSwitch && !confirming ? accountButton(t('Switch account'), () => accountControls.ask(agent)) : null,
      signOut && !confirming ? accountButton(t('Sign out'), () => acp.askSignOut(agent)) : null,
      confirming ? accountButton(t('Continue'), () => (confirmingOut ? acp.nativeSignOut(agent) : accountControls.confirm(agent))) : null,
      confirming ? accountButton(t('Cancel'), confirmingOut ? acp.cancelSignOut : accountControls.cancel) : null),
    line.details ? h('details', { className: 'oai-acp-details' },
      h('summary', null, t('Install details')),
      h('pre', { className: 'oai-acp-diagnostic' }, line.details.diagnostic),
      line.details.logPath ? h('p', { className: 'oai-acp-log' }, t('Log: {path}', { path: line.details.logPath })) : null) : null)
}

export function AcpAgentRow({ agent, acp, accountControls }) {
  const on = acp.isOn(agent)
  const busy = acp.busy !== null || accountControls?.busy === true
  const badge = badgeOf({ ...agent, on })
  // The switch as the person just set it: Install follows it at once.
  const lines = agentLines({ ...agent, on }, accountControls?.accounts[agent.id])
  return h('div', { className: `oai-ai oai-acp${on ? ' oai-ai-on' : ''}`, 'data-acp': agent.id, 'data-state': stateOf({ ...agent, on }) },
    h('div', { className: 'oai-ai-row' },
      h('div', { className: 'oai-logo', 'aria-hidden': true }, LOGO_OF[agent.id] ?? agent.name.slice(0, 1)),
      h('div', { className: 'oai-ai-what' },
        h('strong', null, agent.name),
        h('span', null, t('Your own {cli} CLI, as a model in DSH', { cli: CLI_OF[agent.id] ?? agent.key }))),
      badge ? h('em', { className: 'oai-found' }, badge) : null,
      h('button', { type: 'button', role: 'switch', className: 'oai-switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': agent.name, disabled: busy, onClick: () => acp.flip(agent) })),
    h('div', { className: 'oai-acp-lines' }, lines.map((line, i) => h(AcpLine, { key: i, line, agent, acp, busy, accountControls }))),
    acp.problems[agent.id] ? h('p', { className: 'oai-error oai-ai-problem', role: 'alert' }, acp.problems[agent.id]) : null)
}

/** The agents' list, or nothing while loading or without acp-dsh. */
export function AcpAgents({ acp, accountControls }) {
  if (acp.view?.available !== true || acp.view.agents.length === 0) return null
  return h('section', { className: 'oai-group oai-acp-group', 'aria-label': t('Coding agents') },
    h('div', { className: 'oai-list' }, acp.view.agents.map(agent => h(AcpAgentRow, { key: agent.id, agent, acp, accountControls }))))
}

const BOTS_CLIENT = '@automagik/bots-dsh/client'
const loadBots = () => require(BOTS_CLIENT)

async function readAccounts(load) {
  try {
    const omni = load()?.omni
    const face = omni?.face?.()
    if (typeof face?.actions?.cliLoginAccounts !== 'function' || typeof face.actions.cliLoginSwitch !== 'function') return null
    const result = await face.actions.cliLoginAccounts()
    return { face, hostText: face.hostText ?? omni.hostText, accounts: result?.accounts ?? {} }
  } catch {
    return null
  }
}

/** Settings → Coding agents: the same rows, after onboarding. Signing in closes the
 * settings panel (its `close`), so the Bot's chat with the sign-in row is in view. */
export function AcpSettingsSection({ close, load = loadBots } = {}) {
  const acp = useAcp(undefined, { onLoginOpen: () => close?.() })
  const [accountView, setAccountView] = useState(null)
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const switchBusy = useRef(false)
  // Read both accounts when Settings opens, apart from the agent status poll.
  useEffect(() => {
    let live = true
    void readAccounts(load).then(view => { if (live) setAccountView(view) })
    return () => { live = false }
  }, [])
  const confirm = async (agent) => {
    if (switchBusy.current) return
    switchBusy.current = true
    setBusy(true)
    acp.setProblem(agent.id, null)
    try {
      const { face } = accountView
      const snapshot = face.hooks?.roster?.getSnapshot?.()
      const main = [...(snapshot?.mainBotIds ?? []), snapshot?.mainBotId].find(id => id && snapshot.byId?.[id])
      if (!main) {
        acp.setProblem(agent.id, t('Sign-in needs a Bot chat. If you have no Bot yet, set one up first.'))
        return
      }
      await face.actions.cliLoginSwitch(main, agent.id)
      await face.actions.refreshModels?.()
      acp.login(agent)
    } catch (error) {
      const message = error?.message ?? String(error)
      acp.setProblem(agent.id, accountView.hostText?.(message) ?? message)
    } finally {
      setPending(null)
      setBusy(false)
      switchBusy.current = false
    }
  }
  const accountControls = accountView === null ? undefined : {
    accounts: accountView.accounts, pending, busy, confirm,
    ask: agent => { acp.setProblem(agent.id, null); setPending(agent.id) },
    cancel: () => setPending(null),
  }
  return h('div', { className: 'oai-acp-page' },
    h('div', { className: 'oai-card' },
      h('h1', null, t('Coding agents')),
      h('p', null, t('Use the coding agents you already have as models in DSH. Each runs your own CLI, with your own sign-in and settings.')),
      acp.view === null ? h('p', { className: 'oai-muted oai-waiting' }, t('Looking at what this computer has…'))
        : acp.view.available ? h(AcpAgents, { acp, accountControls })
          : h('p', { className: 'oai-muted' }, t('The ACP agents plugin is not running in this DSH.'))))
}

// The navigation glyph DSH's Settings shows for this section (its settings.section.icon seat):
// a terminal prompt in a rounded square, in the shell's own 16 px stroke style.
export function AcpSectionIcon({ size = 16 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5 }),
  h('path', { d: 'M4.6 6.2 6.8 8l-2.2 1.8M8.3 10.2h3.1' }))
}

// Settings → Coding agents, after onboarding too: DSH's settings and the
// Bot team's both list it. Always there, so an acp-dsh turned on after the page loaded has its
// page without a reload; without acp-dsh the page says the plugin is not running.
export function installAcpSection(ctx) {
  const section = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: SETTINGS_SECTION, order: 30, label: () => t('Coding agents') }, AcpSettingsSection)) ?? (() => {})
  const icon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: SETTINGS_SECTION, order: 30 }, AcpSectionIcon)) ?? (() => {})
  return () => {
    section()
    icon()
  }
}

export const ACP_CSS = `
.oai-acp-line-block{display:grid;gap:4px}
.oai-acp-details{font-size:12.5px;color:var(--oai-ink2)}
.oai-acp-details summary{cursor:pointer}
.oai-acp-diagnostic{max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:color-mix(in srgb,var(--oai-ink) 6%,transparent);border-radius:8px;padding:8px;font-size:11.5px}
.oai-acp-log{margin:0;font-size:12px;overflow-wrap:anywhere}
.oai-acp-page{padding:8px 0;font-family:var(--oai-font);color:var(--oai-ink)}
.oai-acp-page .oai-card{max-width:680px}
.oai-acp-lines{padding:0 14px 12px 60px;display:grid;gap:4px}
.oai-card p.oai-acp-line{margin:0;font-size:13px;line-height:1.45;color:var(--oai-ink2)}
.oai-card p.oai-acp-ok::before{content:"✓ ";color:var(--oai-ok);font-weight:700}
.oai-card p.oai-acp-bad{color:var(--oai-bad)}
.oai-card button.oai-acp-act{display:inline-block;width:auto;min-height:0;margin:0 0 0 8px;padding:4px 10px;font-size:12.5px;vertical-align:baseline}
.oai-acp .oai-found{background:color-mix(in srgb,var(--oai-lilac) 70%,var(--oai-card));color:var(--oai-lilac-ink)}
.oai-acp[data-state="ready"] .oai-found{background:color-mix(in srgb,var(--oai-cyan) 45%,var(--oai-card));color:var(--oai-cyan-ink)}
.oai-acp[data-state="failed"] .oai-found{background:color-mix(in srgb,var(--oai-bad) 22%,var(--oai-card));color:var(--oai-bad)}
@media (max-width:520px){.oai-acp-lines{padding-left:14px}}
.oai-aside{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2000;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 12px 10px 16px;border-radius:var(--oai-r-sm);${raised('var(--oai-card)', 3)};color:var(--oai-ink);font:500 13px/1.4 var(--oai-font)}
.oai-aside button{border:0;border-radius:var(--oai-r-sm);padding:6px 12px;${raised('var(--oai-cyan)', 2)};color:var(--oai-cyan-ink);font:inherit;font-weight:600;cursor:pointer}
.oai-aside button:focus-visible{outline:3px solid var(--oai-ring);outline-offset:2px}
`
