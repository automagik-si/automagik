import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import { call } from './api.js'
import { Stage, StepAside, useFinish, useGate, useGlitch } from './stage.js'
import { SUBSCRIPTION_TILES, SubscriptionSignIn, signedInCount } from './subscriptions.js'
import { AcpLine, agentLines, LOGO_OF, useAcp } from './acp-agents.js'
import { t } from './i18n.js'

// Step omni-connect-ai (order -200): every AI is a row with a switch, and several can be on.
// What this computer already has comes first, on (src/host/ais.js finds it). A row that is not
// set up opens its setup in place: a key, the provider's own sign-in in DSH (or, where the
// provider takes both, a choice of the two), a gateway. Off stops using an AI and keeps its
// key or sign-in.
//
// One sign-in per vendor: Claude and ChatGPT sign in through their own CLIs, Claude Code and
// Codex (acp-dsh's agents). Their Sign in opens the sign-in row in a Bot's chat through the Bot
// team's bridge (acp-agents.js), and the step steps aside meanwhile; Claude also takes an
// Anthropic API key, as before. A signed-in CLI that can answer is an AI on, and counts for
// Continue. Their switch is the CLI's own, for every Bot on it. The agents' own rows are in
// Settings → Claude Code and Codex, not here.
//
// Antigravity (#2048) is a third CLI row, listed when acp-dsh offers its sign-in in the app. Its
// switch turns acp-dsh's own Antigravity switch on and opens its setup, where it installs by
// click and signs in in place, as in Settings: the link, a Copy button and the field for the
// address the browser ends on (onboarding may run before any Bot exists, so no Bot chat).
// Cancel, or a second flip, before it is signed in turns it back off.
//
// Everything else: DSH's own sign-ins and keys, and dsh-subscriptions for what nothing else
// covers.
//
// The copy follows the DSH language (i18n.js). The host's rows stay English (src/host/ais.js)
// and read in the DSH language here, through aiText.

export const VENDOR_TERMS = 'Personal use under the vendor\'s terms'
// How many "Add another" rows show before "Show N more".
export const FIRST_OTHERS = 4
export const LOGOS = { claude: 'C', chatgpt: 'G', antigravity: LOGO_OF['acp-antigravity'], deepseek: 'D', kimi: 'K', copilot: 'P', grok: 'X', openai: 'O', openrouter: 'R', zai: 'Z', moonshot: 'M', opencode: 'OC', cliproxy: '⇄', ollama: 'L' }

// dsh-subscriptions' vendors as rows, when that plugin is here.
export function subscriptionRows(subscriptions) {
  if (!subscriptions) return []
  return SUBSCRIPTION_TILES.map((tile) => {
    const count = signedInCount(subscriptions.accounts.map(account => ({ ...account, configured: true })), tile.provider)
    const on = count > 0 && !subscriptions.hidden.includes(tile.provider)
    return { id: `sub:${tile.provider}`, name: tile.name, via: `${tile.note} · dsh-subscriptions`, kind: 'subscription', tile, ready: count > 0, on, found: count > 1 ? `${count} accounts` : count === 1 ? 'Signed in' : null }
  })
}

// The two sections: what was found (on by default, or set up already), then the rest.
export function sections(rows) {
  const found = rows.filter(row => row.found || row.on)
  const others = rows.filter(row => !found.includes(row))
  return { found, others }
}

export const onCount = rows => rows.filter(row => row.on).length

// What the host and subscriptionRows say about a row, in the DSH language: each part between
// ' · ', with the value kept where a row names one.
const AI_ROWS = [
  [/^Signed in to (.+)$/, name => t('Signed in to {name}', { name })],
  [/^(\S+) found$/, ref => t('{ref} found', { ref })],
  [/^(\d+) accounts$/, count => t('{count} accounts', { count })],
]
export function aiText(text) {
  if (typeof text !== 'string') return text
  return text.split(' · ').map((part) => {
    for (const [pattern, of] of AI_ROWS) {
      const match = pattern.exec(part)
      if (match) return of(match[1])
    }
    return t(part)
  }).join(' · ')
}

// What a switch does when flipped: turn it off, turn on what is set up, or open its setup.
export function flipAction(row) {
  if (row.on) return 'off'
  return row.ready ? 'on' : 'setup'
}

function KeyForm({ row, provider, onSaved }) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      await call('provider-key', { provider, apiKey })
      setApiKey('')
      onSaved()
    } catch (error) {
      setProblem(error.message)
      setBusy(false)
    }
  }
  return h('form', { onSubmit: submit, className: 'oai-setup-form' },
    h('div', { className: 'oai-field' },
      h('input', { type: 'password', required: true, autoComplete: 'off', spellCheck: false, autoFocus: true, placeholder: t('Paste your {name} key', { name: row.name }), 'aria-label': t('{name} key', { name: row.name }), value: apiKey, onChange: e => setApiKey(e.target.value) }),
      h('button', { type: 'submit', className: 'oai-primary', disabled: busy }, busy ? t('Turning on…') : t('Turn on'))),
    h('p', { className: 'oai-muted' }, t('It stays on this computer, in DSH\'s own credential store.'), row.keyUrl ? [' ', h('a', { key: 'k', className: 'oai-link', href: row.keyUrl, target: '_blank', rel: 'noreferrer' }, t('Get a {name} key', { name: row.name }))] : null),
    problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null)
}

// A sign-in running in DSH: its latest notice (a page to open, a code to type), its open
// question, and how it ended. Polled, so a reload finds it again. The route is written by the
// host only once the sign-in succeeds.
function SignIn({ row, provider, onSaved, onCancel }) {
  const [attempt, setAttempt] = useState(null)
  const [problem, setProblem] = useState(null)
  const [answer, setAnswer] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true
    let timer = 0
    const poll = async (first) => {
      try {
        const next = await call(first ? 'signin-start' : 'signin-status', { provider })
        if (!live) return
        setAttempt(next)
        if (next.status === 'authorized') return onSaved()
        if (next.status === 'running') timer = setTimeout(() => poll(false), 1000)
      } catch (error) {
        if (live) setProblem(error.message)
      }
    }
    poll(true)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [provider])
  const reply = async (value) => {
    setProblem(null)
    try {
      setAttempt(await call('signin-answer', { provider, promptId: attempt.prompt.id, value }))
      setAnswer('')
    } catch (error) {
      setProblem(error.message)
    }
  }
  const cancel = async () => {
    await call('signin-cancel', { provider }).catch(() => {})
    onCancel()
  }
  const notice = attempt?.notice
  const prompt = attempt?.prompt
  const ended = attempt && ['cancelled', 'failed', 'none'].includes(attempt.status)
  const endedText = {
    failed: () => t('The sign-in did not finish: {error}', { error: attempt?.error }),
    cancelled: () => t('The sign-in was cancelled. Nothing was turned on.'),
    none: () => t('The sign-in stopped before it finished. Flip the switch to start again.'),
  }
  return h('div', { className: 'oai-signin' },
    !attempt && !problem ? h('p', { className: 'oai-muted' }, t('Starting the {name} sign-in…', { name: row.name })) : null,
    notice?.message ? h('p', null, notice.message) : null,
    notice?.code ? h('div', { className: 'oai-code' },
      h('code', null, notice.code),
      h('button', { type: 'button', className: 'oai-ghost', onClick: () => navigator.clipboard?.writeText(notice.code).then(() => setCopied(true)) }, copied ? t('Copied') : t('Copy code'))) : null,
    notice?.url ? h('a', { className: 'oai-primary oai-button', href: notice.url, target: '_blank', rel: 'noreferrer' }, t('Sign in with {name}', { name: row.name })) : null,
    prompt?.kind === 'select' ? h('div', { className: 'oai-choices', role: 'group', 'aria-label': prompt.message },
      h('p', null, prompt.message),
      prompt.options.map(option => h('button', { key: option.id, type: 'button', onClick: () => reply(option.id) }, h('strong', null, option.label), option.description ? h('span', null, option.description) : null))) : null,
    prompt && prompt.kind !== 'select' ? h('form', { onSubmit: (event) => { event.preventDefault(); reply(answer) } },
      h('label', { htmlFor: `oai-answer-${row.id}` }, prompt.message),
      h('input', { id: `oai-answer-${row.id}`, type: prompt.kind === 'secret' ? 'password' : 'text', required: true, autoComplete: 'off', spellCheck: false, autoFocus: true, placeholder: prompt.placeholder, value: answer, onChange: e => setAnswer(e.target.value) }),
      h('button', { type: 'submit', className: 'oai-primary' }, t('Continue'))) : null,
    attempt?.status === 'running' && !prompt ? h('p', { className: 'oai-muted oai-waiting' }, t('Finish signing in on their page…')) : null,
    ended ? h('p', { className: 'oai-error', role: 'alert' }, endedText[attempt.status]()) : null,
    problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null,
    !ended && !problem ? h('button', { type: 'button', className: 'oai-quiet', onClick: cancel }, t('Cancel')) : null)
}

function CliproxyForm({ onSaved }) {
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      await call('cliproxy', { baseURL, apiKey })
      setApiKey('')
      onSaved()
    } catch (error) {
      setProblem(error.message)
      setBusy(false)
    }
  }
  return h('form', { onSubmit: submit, className: 'oai-setup-form' },
    h('input', { type: 'url', required: true, placeholder: 'http://localhost:8317/v1', 'aria-label': t('Gateway address'), autoComplete: 'off', value: baseURL, onChange: e => setBaseURL(e.target.value) }),
    h('div', { className: 'oai-field' },
      h('input', { type: 'password', required: true, placeholder: t('Gateway key'), 'aria-label': t('Gateway key'), autoComplete: 'off', spellCheck: false, value: apiKey, onChange: e => setApiKey(e.target.value) }),
      h('button', { type: 'submit', className: 'oai-primary', disabled: busy }, busy ? t('Turning on…') : t('Turn on'))),
    h('p', { className: 'oai-muted' }, t('Omni lists the gateway\'s models with your key and keeps the key in DSH\'s credential store.')),
    problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null)
}

// A provider that takes both a sign-in and a key (Claude: a Pro or Max plan or an Anthropic API
// key; Grok): the person picks one before anything starts.
function SignInOrKey({ row, provider, onSaved, onClose }) {
  const [way, setWay] = useState(null)
  if (way === 'signin') return h(SignIn, { row, provider, onSaved, onCancel: onClose })
  if (way === 'key') return h(KeyForm, { row, provider, onSaved })
  return h('div', { className: 'oai-choices', role: 'group', 'aria-label': t('How to connect {name}', { name: row.name }) },
    h('button', { type: 'button', onClick: () => setWay('signin') }, h('strong', null, t('Sign in to {name}', { name: row.name })), h('span', null, t('With your plan, in the browser'))),
    h('button', { type: 'button', onClick: () => setWay('key') }, h('strong', null, t('Use an API key')), h('span', null, t('Billed per use'))))
}

// The rows that are a CLI, and the agent behind each: the page's latest look at it, else the
// host's (row.cli). Without acp-dsh there is none.
export const CLI_ROWS = { claude: 'acp-claude', chatgpt: 'acp-codex', antigravity: 'acp-antigravity' }
function cliAgentOf(row, acp) {
  const id = CLI_ROWS[row.id]
  if (id === undefined) return undefined
  return acp?.view?.agents?.find(agent => agent.id === id) ?? (row.cli?.cli ? row.cli : undefined)
}
const acpBusy = acp => (acp ? acp.busy !== null : false)
// A CLI that can take a sign-in now: found, and not installing, updating or failed.
const canSignIn = agent => agent.cli.found === true && agent.cli.state !== 'installing' && agent.cli.state !== 'failed' && agent.cli.updating !== true
// An agent that signs in here, in the app (Antigravity): its row installs and signs in in place.
const appRow = agent => agent?.appSignIn === true

// Antigravity's setup: its own lines, as in Settings (Install, Sign in, the link, Copy and the
// paste field), never the "in a Bot's chat" button or a key. Cancel before it is signed in turns
// it back off (the switch never reads off while it is on).
function AppAgentSetup({ agent, acp, onClose }) {
  const busy = acpBusy(acp)
  const problem = acp?.problems?.[agent.id]
  const cancel = async () => {
    if (agent.signedIn !== true && acp.isOn(agent)) await acp.flip(agent)
    onClose()
  }
  return h('div', { className: 'oai-signin' },
    h('div', { className: 'oai-acp-lines' }, agentLines(agent).map((line, i) => h(AcpLine, { key: i, line, agent, acp, busy }))),
    problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null,
    h('button', { type: 'button', className: 'oai-quiet', onClick: cancel }, t('Cancel')))
}

// Claude or ChatGPT: sign in to the CLI in a Bot's chat (the step steps aside), or for Claude an
// Anthropic API key. A CLI that is missing, installing or failed shows where it stands instead.
function CliSetup({ row, agent, acp, onSaved, onClose }) {
  const [way, setWay] = useState(null)
  if (appRow(agent) && acp) return h(AppAgentSetup, { agent, acp, onClose })
  if (way === 'key' || (agent === undefined && row.keyUrl)) return h(KeyForm, { row, provider: providerOf(row), onSaved })
  if (agent === undefined) return h('p', null, t('This DSH offers no {name} sign-in.', { name: row.name }))
  const busy = acpBusy(acp)
  const lines = canSignIn(agent) ? [] : agentLines(agent)
  const problem = acp?.problems?.[agent.id]
  return h('div', { className: 'oai-signin' },
    h('div', { className: 'oai-choices', role: 'group', 'aria-label': t('How to connect {name}', { name: row.name }) },
      canSignIn(agent) ? h('button', { type: 'button', disabled: busy || !acp, onClick: () => acp?.login(agent) }, h('strong', null, t('Sign in to {name}', { name: agent.name })), h('span', null, t('With your plan, in a Bot\'s chat'))) : null,
      row.keyUrl ? h('button', { type: 'button', onClick: () => setWay('key') }, h('strong', null, t('Use an API key')), h('span', null, t('Billed per use'))) : null),
    lines.length ? h('div', { className: 'oai-acp-lines' }, lines.map((line, i) => h(AcpLine, { key: i, line, agent, acp, busy }))) : null,
    problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null,
    h('button', { type: 'button', className: 'oai-quiet', onClick: onClose }, t('Cancel')))
}

function Setup({ row, acp, onSaved, onClose }) {
  if (Object.hasOwn(CLI_ROWS, row.id)) return h(CliSetup, { row, agent: cliAgentOf(row, acp), acp, onSaved, onClose })
  if (row.kind === 'key') return h(KeyForm, { row, provider: providerOf(row), onSaved })
  if (row.kind === 'signin') {
    if (row.signIn && row.keyUrl) return h(SignInOrKey, { row, provider: providerOf(row), onSaved, onClose })
    if (row.signIn) return h(SignIn, { row, provider: providerOf(row), onSaved, onCancel: onClose })
    if (row.keyUrl) return h(KeyForm, { row, provider: providerOf(row), onSaved })
    return h('p', null, t('This DSH offers no {name} sign-in.', { name: row.name }))
  }
  if (row.kind === 'gateway') return h(CliproxyForm, { onSaved })
  if (row.kind === 'local') return h('p', { className: 'oai-muted' }, t('Ollama is not running on this computer. Start it, then flip this again.'))
  if (row.kind === 'subscription') return h(SubscriptionSignIn, { tile: row.tile, onBack: onClose, onSaved, glitch: () => {} })
  return null
}

export const PROVIDER_OF = { claude: 'anthropic', kimi: 'kimi-coding', copilot: 'github-copilot', grok: 'xai', openai: 'openai', openrouter: 'openrouter', zai: 'zai', moonshot: 'moonshotai', opencode: 'opencode', deepseek: 'deepseek' }
const providerOf = row => PROVIDER_OF[row.id] ?? row.id

// "Also connected through …": the other ways this row's AI is connected, which Omni does not use.
function Duplicates({ row, onDedupe }) {
  if (!row.duplicates?.length) return null
  const shown = row.duplicates.filter(duplicate => !duplicate.hidden)
  return h('div', { className: 'oai-dupes' },
    row.duplicates.map(duplicate => h('p', { key: `${duplicate.via}:${duplicate.provider}`, className: 'oai-muted' },
      t('Also connected through {via}; Omni uses {name} here.', { via: t(duplicate.via), name: row.name }),
      duplicate.hidden ? t(' Its models are hidden.') : null)),
    shown.length && row.on ? h('button', { type: 'button', className: 'oai-ghost', onClick: onDedupe }, t('Use only this {name}', { name: row.name })) : null)
}

export function Row({ row, acp, open, busy, problem, onFlip, onSaved, onClose, onDedupe }) {
  const logo = LOGOS[row.id] ?? row.name.slice(0, 1)
  // A signed-in CLI turned on but not answering yet (its connector installing, a restart
  // pending): where it stands, under the row.
  const agent = cliAgentOf(row, acp)
  // Antigravity on but not signed in, with its setup closed (a reload): its lines, under the row.
  const settling = !row.on && !open && agent?.on === true && ((agent.signedIn === true && agent.cli.found === true) || appRow(agent))
  const agentProblem = appRow(agent) && !open ? acp?.problems?.[agent.id] : null
  return h('div', { className: `oai-ai${row.on ? ' oai-ai-on' : ''}` },
    h('div', { className: 'oai-ai-row' },
      h('div', { className: 'oai-logo', 'aria-hidden': true }, logo),
      h('div', { className: 'oai-ai-what' },
        h('strong', null, row.name),
        h('span', null, aiText(row.detail ? `${row.via} · ${row.detail}` : row.via))),
      row.found ? h('em', { className: 'oai-found' }, aiText(row.found)) : null,
      h('button', { type: 'button', role: 'switch', className: 'oai-switch', 'aria-checked': row.on ? 'true' : 'false', 'aria-label': row.name, disabled: busy, onClick: onFlip })),
    open && !row.on ? h('div', { className: 'oai-ai-setup' }, h(Setup, { row, acp, onSaved, onClose })) : null,
    settling ? h('div', { className: 'oai-acp-lines' }, agentLines(agent).map((line, i) => h(AcpLine, { key: i, line, agent, acp, busy: busy || acpBusy(acp) }))) : null,
    problem ? h('p', { className: 'oai-error oai-ai-problem', role: 'alert' }, problem) : null,
    agentProblem ? h('p', { className: 'oai-error oai-ai-problem', role: 'alert' }, agentProblem) : null,
    h(Duplicates, { row, onDedupe }))
}

export function ConnectAiStep(props) {
  const state = useGate(props)
  const finish = useFinish(props)
  // Continue with an AI on: the host gives the companions their model (endpoint.js).
  const proceed = useFinish(useMemo(() => ({ ...props, connected: true }), [props]))
  const [glitching, glitch] = useGlitch()
  const [rows, setRows] = useState(null)
  const [subs, setSubs] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(null)
  const [problems, setProblems] = useState({})
  const [showAll, setShowAll] = useState(false)
  // Signing in to a coding agent happens in a Bot's chat: the step steps aside for it and stays
  // open (opening the sign-in never completes the step, and marks nothing done).
  const [aside, setAside] = useState(false)
  const acp = useAcp(undefined, { onLoginOpen: () => setAside(true) })

  const refresh = useCallback(async () => {
    const reply = await call('ais').catch(() => ({ rows: [], subscriptions: null }))
    setRows(reply.rows ?? [])
    setSubs(reply.subscriptions ?? null)
  }, [])
  // The rows again whenever an agent's state changes (a CLI's sign-in checked, its connector
  // ready), not on every poll while one signs in.
  const agentsDigest = agentsDigestOf(acp.view)
  useEffect(() => { void refresh() }, [refresh, agentsDigest])
  useEffect(() => { if (state) glitch() }, [state, glitch])
  if (!state) return null
  if (aside) {
    return h(StepAside, {
      text: t('Sign in from the Bot\'s chat, then come back to finish setting up.'),
      back: t('Back to setup'),
      onBack: () => { setAside(false); void acp.refresh().then(refresh) },
    })
  }

  const say = (id, message) => setProblems(previous => ({ ...previous, [id]: message }))

  const flip = async (row) => {
    const action = flipAction(row)
    say(row.id, null)
    // Antigravity: the flip is the person's word to turn it on (acp-dsh's own switch), and
    // opens its setup; a second flip before it is signed in turns it back off.
    const agent = cliAgentOf(row, acp)
    if (action === 'setup' && appRow(agent)) {
      if (!acp.isOn(agent)) {
        if (await acp.flip(agent)) setOpen(row.id)
      } else if (open === row.id) {
        await acp.flip(agent)
        setOpen(null)
      } else setOpen(row.id)
      return
    }
    if (action === 'setup') {
      setOpen(current => (current === row.id ? null : row.id))
      return
    }
    setBusy(row.id)
    try {
      if (row.kind === 'subscription') await call('ai-subscription', { provider: row.tile.provider, on: action === 'on' })
      else await call('ai-switch', { id: row.id, on: action === 'on' })
      if (action === 'on') glitch()
      // A CLI's switch changed in acp-dsh: the agents are read again, and polled while they settle.
      if (row.cli) await acp.reload()
      await refresh()
    } catch (error) {
      say(row.id, error.message)
    }
    setBusy(null)
  }
  const saved = row => async () => {
    setOpen(null)
    glitch()
    // A row set up just now stops its duplicates, as turning it on does.
    if (row.kind !== 'subscription') await call('ai-dedupe', { id: row.id }).catch(() => {})
    await refresh()
  }
  const dedupe = row => async () => {
    say(row.id, null)
    try {
      await call('ai-dedupe', { id: row.id })
      await refresh()
    } catch (error) {
      say(row.id, error.message)
    }
  }

  return h(ConnectAiView, {
    state,
    rows,
    subscriptions: subs,
    open,
    showAll,
    glitching,
    rowProps: row => ({ acp, busy: busy !== null, problem: problems[row.id], onFlip: () => flip(row), onSaved: saved(row), onClose: () => setOpen(null), onDedupe: dedupe(row) }),
    onShowAll: () => setShowAll(true),
    onSkip: () => finish(),
    onModels: () => finish('models'),
    onContinue: () => proceed(),
  })
}

// What of the agents makes the rows read again: their switch, sign-in and readiness only.
export function agentsDigestOf(view) {
  return JSON.stringify((view?.agents ?? []).map(agent => [agent.id, agent.on, agent.signedIn, agent.cli?.found, agent.cli?.state,
    agent.connector?.state, agent.restartNeeded]))
}

// What the step draws, from its state: `rows` is null while the host looks, `rowProps` a row's
// handlers.
export function ConnectAiView({ state, rows, subscriptions, open, showAll, glitching, rowProps, onShowAll, onSkip, onModels, onContinue }) {
  const all = rows === null ? null : [...rows, ...subscriptionRows(subscriptions)]
  const count = all ? onCount(all) : 0
  const { found, others } = sections(all ?? [])
  const visible = showAll ? others : others.slice(0, FIRST_OTHERS)
  const rowOf = row => h(Row, { key: row.id, row, open: open === row.id, ...rowProps(row) })
  const another = found.length ? t('Add another') : t('Your AIs')

  return h(Stage, {
    title: t('Turn on your AIs'),
    speech: count > 0 ? t('Turn on everything you have. More brains, more {name}.', { name: state.companionName ?? 'Omni' }) : t('Now give me a brain. Turn on every AI you have; you can change it any time.'),
    at: 'omni-connect-ai',
    glitching,
  },
  all === null ? h('p', { className: 'oai-muted' }, t('Looking at what this computer has…')) : [
    found.length ? h('section', { key: 'found', className: 'oai-group', 'aria-label': t('Found on this computer') },
      h('h2', null, t('Found on this computer')),
      h('div', { className: 'oai-list' }, found.map(rowOf))) : null,
    h('section', { key: 'others', className: 'oai-group', 'aria-label': another },
      h('h2', null, another),
      h('p', { className: 'oai-terms oai-muted' }, t('Subscriptions: {terms}.', { terms: t(VENDOR_TERMS).toLowerCase() })),
      h('div', { className: 'oai-list' }, visible.map(rowOf),
        !showAll && others.length > FIRST_OTHERS ? h('button', { type: 'button', className: 'oai-more', onClick: onShowAll }, t('Show {count} more', { count: others.length - FIRST_OTHERS })) : null)),
    h('p', { key: 'more', className: 'oai-muted oai-every' }, t('Every other provider DSH knows is in '), h('button', { type: 'button', className: 'oai-inline', onClick: onModels }, t('Settings → Models')), '.'),
  ],
  h('div', { className: 'oai-actions' },
    h('button', { type: 'button', className: 'oai-quiet', onClick: onSkip }, t('Skip for now')),
    h('span', { className: 'oai-count' }, count > 0 ? t('{count} on', { count }) : t('Turn on at least one')),
    h('button', { type: 'button', className: 'oai-primary', disabled: count === 0, onClick: onContinue }, count > 0 ? t('Continue →') : t('Continue'))))
}
