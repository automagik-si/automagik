import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call as api } from './api.js'
import { HermesMark, HERMES_MARK_CSS } from './hermes-mark.js'
import { CheckIcon, CloseIcon, ShieldIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

const EMPTY_SSH = { host: '', user: '', port: '', identityFile: '', hermesPath: '', hermesHome: '' }
// SSH is the way in unless a connection by address was saved.
const draftOf = view => ({ mode: view?.mode === 'remote' && view?.address ? 'remote' : 'ssh', address: view?.address ?? '', authMode: view?.authMode === 'password' ? 'password' : 'token', credentialRef: view?.credentialRef ?? '', credential: '', username: view?.username ?? '', password: '', ssh: { ...EMPTY_SSH, ...view?.ssh } })
const configured = view => view?.enabled === true && Boolean(view?.profile)
const freshSecrets = draft => ({ ...draft, credential: '', password: '' })
const connectionLabel = draft => draft.mode === 'ssh' ? draft.ssh.host : draft.address.replace(/^https?:\/\//, '').replace(/\/$/, '')

function Field({ label, value, onChange, placeholder, hint, secret = false, type = 'text' }) {
  return h('label', { className: 'bt-hw-field' }, h('span', null, label),
    h('input', { type: secret ? 'password' : type, value, onChange: event => onChange(event.target.value), placeholder, 'aria-label': label, autoComplete: secret ? 'new-password' : 'off', spellCheck: false }),
    hint ? h('small', null, hint) : null)
}
const Button = ({ children, primary = false, ...props }) => h('button', { type: 'button', className: `bt-hw-button ${primary ? 'bt-hw-primary' : 'bt-hw-secondary'}`, ...props }, children)
const Note = ({ children, error = false }) => h('div', { className: `bt-hw-note${error ? ' bt-hw-error-note' : ''}` }, h(ShieldIcon), h('span', null, children))
const Pair = ({ label, value, mono = false }) => h('div', { className: 'bt-hw-pair' }, h('span', null, label), h('strong', { className: mono ? 'bt-hw-mono' : undefined }, value))
const Lines = ({ label, lines }) => h('div', { className: 'bt-hw-lines' }, h('span', null, label), h('pre', { tabIndex: 0, 'aria-label': label }, lines.join('\n')))

const sshHostRows = rows => {
  const seen = new Set()
  return (Array.isArray(rows) ? rows : []).slice(0, 2048).flatMap(row => {
    if (!row || typeof row !== 'object') return []
    const item = Object.fromEntries(['alias', 'hostname', 'user', 'port'].map(key => [key, typeof row[key] === 'string' && row[key].length <= 4096 && !/[\x00-\x1f\x7f]/.test(row[key]) ? row[key] : '']))
    if (!item.alias || seen.has(item.alias)) return []
    seen.add(item.alias)
    return [item]
  })
}

function SshHostPicker({ host, onPick }) {
  const [listing, setListing] = useState({ status: 'loading', aliases: [], knownHosts: [] })
  const [search, setSearch] = useState('')
  const [otherOpen, setOtherOpen] = useState(false)
  useEffect(() => {
    let current = true
    const controller = new AbortController()
    // This optional list owns its request. Leaving Details must never abort the
    // wizard's separate connection test or its progress request.
    void api('hermes-remote-ssh-hosts', undefined, controller.signal).then(answer => {
      if (current && !controller.signal.aborted) setListing({ status: 'ready', aliases: sshHostRows(answer?.aliases), knownHosts: sshHostRows(answer?.knownHosts) })
    }).catch(error => {
      if (current && !controller.signal.aborted && error?.name !== 'AbortError') setListing({ status: 'error', aliases: [], knownHosts: [] })
    })
    return () => { current = false; controller.abort() }
  }, [])
  const matches = item => [item.alias, item.hostname, item.user, item.port].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))
  const choices = (rows, label) => {
    const filtered = rows.filter(matches)
    return filtered.length ? h('div', { className: 'bt-hw-host-list', role: 'group', 'aria-label': label }, filtered.map(item => h('button', {
      key: item.alias, type: 'button', className: 'bt-hw-host-choice', 'aria-pressed': host === item.alias,
      'aria-label': t('Use SSH host {host}', { host: item.alias }), onClick: () => onPick(item),
    }, h('span', null, h('strong', null, item.alias), h('small', null, [item.hostname !== item.alias ? item.hostname : '', item.user, item.port].filter(Boolean).join(' · '))), host === item.alias ? h(CheckIcon) : null)))
      : h('p', { className: 'bt-hw-host-hint' }, t('No SSH hosts match your search.'))
  }
  const anyHosts = listing.aliases.length > 0 || listing.knownHosts.length > 0
  return h('section', { className: 'bt-hw-host-picker', 'aria-label': t('SSH hosts from your config') },
    h('strong', { className: 'bt-hw-host-title' }, t('SSH hosts from your config')),
    listing.status === 'loading' ? h('p', { className: 'bt-hw-host-hint', role: 'status' }, t('Loading saved SSH hosts…'))
      : listing.status === 'error' ? h('p', { className: 'bt-hw-host-hint', role: 'status' }, t('Saved SSH hosts could not be listed. Type a host below.'))
      : !anyHosts ? h('p', { className: 'bt-hw-host-hint' }, t('No saved SSH hosts. Type a host below.'))
      : h(Fragment, null,
        h(Field, { label: t('Search SSH hosts'), value: search, onChange: setSearch, placeholder: t('Search by name, address or user') }),
        listing.aliases.length ? choices(listing.aliases, t('SSH hosts from your config')) : null,
        listing.knownHosts.length ? h(Fragment, null,
          h('button', { type: 'button', className: 'bt-hw-other-hosts', 'aria-label': t('Other hosts you have connected to'), 'aria-expanded': otherOpen, onClick: () => setOtherOpen(value => !value) }, t('Other hosts you have connected to'), h('span', { 'aria-hidden': true }, otherOpen ? '−' : '+')),
          otherOpen ? choices(listing.knownHosts, t('Other hosts you have connected to')) : null) : null))
}

// What the host kept of one failed SSH connection, for its own screen. Every field is
// shaped again here: a value the page cannot show safely is dropped, never rendered.
const shortText = (value, max = 255) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : ''
const lineRows = value => (Array.isArray(value) ? value : []).map(line => shortText(line, 240)).filter(Boolean).slice(-8)
const release = value => /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value ?? '') ? value : ''
// How Hermes is updated where it runs, by the install kind its own "--version" names
// (Hermes's own table: a source install updates itself, an image or a package does not).
function updateStep(install, host) {
  if (['nix', 'nixos', 'home-manager'].includes(install)) return { hint: t('On {host}, update Hermes through the Nix source that installed it (nix profile upgrade, or update your flake input and rebuild), then try again.', { host }) }
  if (install === 'docker') return { command: 'docker pull nousresearch/hermes-agent:latest', hint: t('On {host}, run “{command}” and restart the Hermes container, then try again.', { host, command: 'docker pull nousresearch/hermes-agent:latest' }) }
  const command = install === 'apt' ? 'pkg upgrade hermes-agent' : 'hermes update'
  return { command, hint: t('On {host}, run “{command}”, then try again.', { host, command }) }
}
// The rows of an update screen: what runs there, what is needed, and the command to run.
function updateRows(facts, step) {
  return [facts.version ? { label: t('Hermes there'), value: `v${facts.version}` } : null, facts.minimum ? { label: t('Needed'), value: t('v{version} or newer', { version: facts.minimum }) } : null,
    step.command ? { label: t('Update command'), value: step.command, mono: true } : null].filter(Boolean)
}
function failureFacts(value) {
  if (!value || typeof value !== 'object') value = {}
  const count = key => Number.isSafeInteger(value[key]) ? value[key] : undefined
  return {
    kind: shortText(value.kind, 40), stage: shortText(value.stage, 40), keyType: /^[a-z0-9@.-]{3,64}$/.test(value.keyType ?? '') ? value.keyType : '',
    fingerprint: /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint ?? '') ? value.fingerprint : '', fault: /^[A-Za-z_]\w{0,40}$/.test(value.fault ?? '') ? value.fault : '',
    identities: (Array.isArray(value.identities) ? value.identities : []).filter(name => /^[\w.@+-]{1,64}$/.test(name ?? '')).slice(0, 6),
    agentKeys: count('agentKeys') ?? 0, port: count('port'), exit: count('exit'), errno: count('errno'), line: count('line'),
    ssh: lineRows(value.ssh), hermes: lineRows(value.hermes), unsaved: value.unsaved === true, mismatch: value.mismatch === true,
    version: release(value.version), minimum: release(value.minimum), install: /^[a-z0-9-]{1,32}$/.test(value.install ?? '') ? value.install : '',
  }
}
const STAGES = {
  details: () => t('Checking the SSH details'), 'ssh-sign-in': () => t('Signing in with SSH'), 'host-key': () => t('Checking the host key'),
  'remote-start': () => t('Finding Hermes'), 'hermes-start': () => t('Starting Hermes'), tunnel: () => t('Opening the tunnel'),
  token: () => t('Signing in to Hermes'), profiles: () => t('Listing profiles'), chat: () => t('Opening a chat connection'),
}

// One screen per kind of failure. An SSH screen names the host the person picked and
// the step that stopped; the generic SSH screen is only for a kind nothing here knows.
function errorFor(error, draft, detail, minimum) {
  const code = error?.code ?? ''
  const facts = failureFacts(detail)
  if (!facts.minimum) facts.minimum = release(minimum)
  const base = screenFor(code, draft, facts)
  if (!base.ssh) return base
  const host = shortText(draft?.ssh?.host?.trim?.() ?? '')
  const rows = [...(base.rows ?? [])]
  if (host) rows.unshift({ label: t('SSH host'), value: host })
  if (STAGES[facts.stage] && !base.trust) rows.push({ label: t('Stopped while'), value: STAGES[facts.stage]() })
  if (facts.exit !== undefined && !base.trust) rows.push({ label: t('Exit code'), value: String(facts.exit) })
  if (facts.fault) rows.push({ label: t('Error'), value: `${facts.fault}${facts.errno ? ` (${facts.errno})` : ''}${facts.line ? ` · ${t('line {line}', { line: facts.line })}` : ''}`, mono: true })
  return { ...base, rows, lines: base.trust ? [] : [facts.hermes.length ? { label: t('Last lines from Hermes'), lines: facts.hermes } : null, facts.ssh.length ? { label: t('Last lines from SSH'), lines: facts.ssh } : null].filter(Boolean) }
}

function screenFor(code, draft, facts) {
  const host = shortText(draft?.ssh?.host?.trim?.() ?? '') || t('the other computer')
  if (code === 'bot/hermes-busy') return { heading: t('Remote Hermes'), title: t('A chat is still running on this connection; stop it or wait.'), text: t('Your connection settings were not changed.'), hint: t('Stop the chat or wait') }
  if (code === 'bot/hermes-ssh-cleanup') return { heading: t('Connection cleanup is unconfirmed'), title: t('Check {host} before reconnecting', { host }), text: t('Automagik could not confirm that the owned Hermes process group stopped. Remote work may continue.'), hint: t('Check the remote Hermes process before connecting again.'), ssh: true }
  if (code === 'bot/hermes-ssh-update') {
    const step = updateStep(facts.install, host)
    return { heading: t('Hermes needs an update'), title: facts.minimum ? t('Update Hermes on {host} to v{version} or newer', { host, version: facts.minimum }) : t('Update Hermes on {host}', { host }),
      text: facts.version && facts.minimum ? t('{host} runs Hermes v{found}. This connection needs v{version} or newer.', { host, found: facts.version, version: facts.minimum }) : t('This Hermes installation lacks the server ownership options needed for an SSH connection.'),
      hint: step.hint, rows: updateRows(facts, step), ssh: true }
  }
  if (code === 'bot/hermes-ssh-version') {
    const step = updateStep(facts.install, host)
    return { heading: t('Hermes did not report its version'), title: t('Automagik could not read the Hermes version on {host}', { host }),
      text: facts.minimum ? t('“hermes --version” on {host} named no release, so Automagik cannot tell whether it is new enough. This connection needs v{version} or newer.', { host, version: facts.minimum }) : t('“hermes --version” on {host} named no release, so Automagik cannot tell whether it is new enough.', { host }),
      hint: step.hint, rows: updateRows(facts, step), ssh: true }
  }
  if (code === 'bot/hermes-ssh-platform') return { heading: t('This computer cannot run the SSH connection yet'), title: t('Check the remote system and Python'), text: t('The remote computer needs Linux or macOS, Python 3, and a supported Hermes installation.'), hint: t('Check Python and the supported system on the other computer, then try again.'), ssh: true }
  if (code === 'bot/hermes-ssh-exited') return { heading: t('Hermes stopped while starting'), title: t('Hermes on {host} stopped before it was ready', { host }), text: facts.exit !== undefined ? t('SSH signed in and started Hermes, but Hermes exited with code {code}.', { code: facts.exit }) : t('SSH signed in and started Hermes, but Hermes stopped right away.'), hint: t('Run “hermes serve” on {host} to see the full error, fix it there, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-not-ready') return { heading: t('Hermes took too long to start'), title: t('Hermes on {host} was not ready in time', { host }), text: t('SSH signed in and started Hermes, but Hermes did not say it was ready before the deadline.'), hint: t('Check that Hermes starts normally on {host}, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-port') return { heading: t('Hermes did not report its port'), title: t('Hermes on {host} started without a port', { host }), text: t('Hermes is running there, but it never said which port it listens on, so there is nothing to connect to.'), hint: t('Update Hermes on {host}, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-handshake' || (draft.mode === 'ssh' && code === 'bot/hermes-auth')) return { heading: t('The one-time token was not accepted'), title: t('Automagik and {host} could not agree on this connection', { host }), text: t('The start script or Hermes on {host} did not accept the one-time token made for this connection.', { host }), hint: t('Try again. If it keeps failing, update Hermes on {host} and check that signing in there prints no extra text.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-tunnel') return { heading: t('The tunnel did not open'), title: t('SSH could not open a tunnel to Hermes on {host}', { host }), text: t('Hermes started, but the SSH tunnel from this computer to it did not start listening, or carried no answer.'), hint: t('Check that {host} allows port forwarding, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-forward') return { heading: t('A port from your SSH config is in use'), title: facts.port ? t('Port {port} from the SSH config for {host} is busy', { port: facts.port, host }) : t('A port forward in the SSH config for {host} could not start', { host }), text: t('The SSH config entry for {host} forwards its own ports. One is already in use on this computer, usually by another SSH session to the same host, so SSH closed the tunnel.', { host }), hint: t('Close the other SSH session to {host}, or remove the forward from its config entry, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-script') return { heading: t('The start script stopped'), title: t('Automagik’s start script failed on {host}', { host }), text: t('SSH signed in, but the small script that finds and starts Hermes stopped with an error.'), hint: t('Check that Python 3 works on {host} and that this user can run Hermes, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-ssh-details') return { heading: t('Check the SSH details'), title: t('These SSH details can’t be used'), text: t('The host, user, port, key path or Hermes path has characters SSH does not accept.'), hint: t('Edit the SSH details, then try again.'), ssh: true }
  if (code === 'bot/hermes-ssh-timeout' || code === 'bot/hermes-timeout') return { heading: t('The connection timed out'), title: t('The other computer did not become ready in time'), hint: t('Check that the other computer is reachable and Hermes can start, then try again.'), ssh: draft.mode === 'ssh' }
  if (code === 'bot/hermes-ssh-unreachable') return { heading: t('We could not reach the other computer'), title: t('Check the SSH address and connection'), text: t('Check the host or config name, network, and SSH access to the other computer.'), hint: t('Confirm that SSH can reach this computer, then try again.'), ssh: true }
  if (code === 'bot/hermes-ssh-interactive') return { heading: t('SSH needs a check in a terminal'), title: t('Complete the SSH check once'), text: t('Connect once in a terminal and complete the required check. Then connect again.'), hint: t('Complete the terminal check without changing SSH host-key protection.'), ssh: true }
  // A Hermes too old to speak to, however it was reached: the same one fix.
  if (code === 'bot/hermes-outdated' || code === 'bot/hermes-protocol') {
    const step = updateStep(facts.install, host)
    return { heading: t('Hermes needs an update'), title: facts.minimum ? t('Update Hermes on {host} to v{version} or newer', { host, version: facts.minimum }) : t('Update Hermes on {host}', { host }), hint: step.hint, rows: updateRows(facts, step), ssh: draft.mode === 'ssh' }
  }
  // A host this computer has never seen: its key is shown, and trusted only by the button.
  if (code === 'bot/hermes-ssh-host-key-unknown') {
    const trust = Boolean(facts.keyType && facts.fingerprint && !facts.unsaved)
    return { heading: t('Trust this SSH host?'), title: t('{host} is new to this computer', { host }), ssh: true, trust,
      text: trust ? t('This computer has not connected to {host} before. Compare this key with one you trust. If it matches, trust the host to continue.', { host }) : t('This computer has not connected to {host} before, and Automagik cannot save its key for you.', { host }),
      hint: trust ? t('Only this exact key is saved to your known hosts. If {host} ever shows a different key, the connection is refused.', { host }) : facts.unsaved ? t('The SSH config for {host} does not keep host keys. Change that config entry, then try again.', { host }) : t('Connect to {host} once in a terminal and accept its key, then try again.', { host }),
      rows: trust ? [{ label: t('Key type'), value: facts.keyType, mono: true }, { label: t('Fingerprint'), value: facts.fingerprint, mono: true }] : [] }
  }
  // A changed key is never trusted from here, whatever the host says about it.
  if (code.includes('host-key')) return { heading: t('This host’s key has changed'), title: t('The key for {host} is not the one this computer saved', { host }), text: t('The host may have been reinstalled, or something may be between you and it. Automagik will not connect and cannot trust the new key for you.'), hint: t('Connect once in a terminal to verify the SSH host key, then try again.'), ssh: true }
  if (draft.mode === 'ssh' && code === 'bot/hermes-ssh-missing') return { heading: t('SSH couldn’t open Hermes'), title: t('Check the Hermes installation'), text: t('Install or update Hermes on the other computer, or enter its executable path. Then try again.'), hint: t('Install Hermes on {host}, or enter its path under More options, then try again.', { host }), ssh: true }
  if (code === 'bot/hermes-expired') return { heading: t('Connect again'), title: t('The connection waited too long and was closed'), hint: t('Choose Try again to connect.') }
  if (code === 'bot/hermes-profiles') return { heading: t('We couldn’t list the profiles'), title: t('Hermes on {host} offered no profile to chat with', { host }), hint: t('Check that Hermes on {host} has a profile, then try again.', { host }) }
  if (code === 'bot/hermes-unsupported') return { heading: t('This Hermes can’t be used here'), title: t('Hermes on {host} is run by a gateway that owns its sessions', { host }), hint: t('Connect to a Hermes started with “hermes serve”.') }
  if (code === 'bot/hermes-ssh-auth') {
    // Which key files SSH offered: their names only, on the person's own screen.
    const keys = [...facts.identities, ...(facts.agentKeys ? [facts.agentKeys === 1 ? t('1 key from your SSH agent') : t('{count} keys from your SSH agent', { count: facts.agentKeys })] : [])]
    return keys.length
      ? { heading: t('SSH couldn’t sign in'), title: t('{host} refused your SSH key', { host }), text: t('SSH offered {keys}, and {host} accepted none of them.', { keys: keys.join(', '), host }), hint: t('Check the SSH user and key, then try again.'), ssh: true }
      : { heading: t('SSH couldn’t sign in'), title: t('Check your SSH details'), text: t('Check the host and user. If your key is locked, unlock it in your SSH agent, or choose another key.'), hint: t('Check the SSH user and key, then try again.'), ssh: true }
  }
  if (draft.mode === 'ssh' && (code === 'bot/hermes-connection' || code === 'bot/hermes')) return { heading: t('Hermes did not answer'), title: t('Hermes on {host} started but did not answer correctly', { host }), text: t('SSH signed in and the tunnel opened, but Hermes did not complete the connection check.'), hint: t('Check that Hermes works on {host}, then try again.', { host }), ssh: true }
  if (draft.mode === 'ssh') return { heading: t('The SSH connection could not start'), title: t('SSH to {host} stopped with an unexpected error', { host }), text: facts.ssh.length ? t('This is not one of the failures Automagik knows. What SSH said is shown below.') : t('This is not one of the failures Automagik knows, and SSH said nothing more.'), hint: t('Run “ssh {host}” in a terminal to see the full error. Fix it there, then try again.', { host }), ssh: true, generic: true }
  if (code === 'bot/hermes-auth') return { heading: t('We couldn’t sign in'), title: draft.authMode === 'password' ? t('The sign-in wasn’t accepted') : t('The token wasn’t accepted'), text: draft.authMode === 'password' ? t('Check your user and password, then sign in again.') : t('Check the token, or choose user and password if this Hermes asks you to sign in.'), hint: draft.authMode === 'password' ? t('Enter your dashboard user and password again, then sign in.') : t('Enter a valid session token, then try again.') }
  return { heading: t('We couldn’t connect'), title: t('Check the remote address'), text: t('Check the address and that Hermes is running, then try again.'), hint: t('Check that Hermes is running at this address and try again.') }
}

// Setup is three things: choose a computer, Connect, chat. A saved connection opens
// straight away. Everything optional (another user, port or key, a Hermes reached by its
// address) is behind More: from Settings, or from a failure that needs it.
export function HermesRemoteConnect({ onClose, onConnected, edit = false, more = false, initialView, onSaved }) {
  const [view, setView] = useState(initialView ?? null)
  const [draft, setDraft] = useState(() => draftOf(initialView))
  // Setup always opens on the computer list, whatever was saved before; More is asked for.
  const [step, setStep] = useState(more ? 'more' : 'host')
  const [status, setStatus] = useState('loading')
  const [stage, setStage] = useState('reach')
  const [error, setError] = useState(null)
  const [test, setTest] = useState(null)
  const [profile, setProfile] = useState('')
  const [choosingKey, setChoosingKey] = useState(false)
  const [details, setDetails] = useState(false)
  const request = useRef(null)
  const testLease = useRef(null)
  const testRequest = useRef(null)
  const saving = useRef(false)
  const progress = useRef(null)
  const stopProgress = () => {
    if (!progress.current) return
    clearTimeout(progress.current.timer)
    progress.current.controller.abort()
    progress.current = null
  }
  const epoch = useRef(0)
  const live = useRef(true)
  const dialog = useRef(null)
  const callbacks = useRef({ onConnected, onSaved, onClose })
  callbacks.current = { onConnected, onSaved, onClose }
  const minimum = view?.minimum ?? initialView?.minimum
  const failed = (failure, shown, detail, requestId) => {
    setDetails(false); setError({ ...errorFor(failure, shown, detail, minimum), ...(requestId ? { requestId } : {}) }); setStep('error'); setStatus('error')
  }
  const discardTest = (testId, requestId = testRequest.current) => {
    // The host can finish a test while its HTTP response is lost or aborted. Its request
    // identity is known before POST, so cleanup never depends on receiving the test ID.
    if (!testId && !requestId) return
    if (testId && testLease.current === testId) testLease.current = null
    if (requestId && testRequest.current === requestId) testRequest.current = null
    void api('hermes-remote-disconnect', { testsOnly: true, ...(requestId ? { requestId } : {}), ...(testId ? { testId } : {}) }).catch(() => {})
  }
  const disposeDraft = () => {
    epoch.current++
    request.current?.abort()
    stopProgress()
    discardTest(testLease.current)
  }
  const close = () => {
    // A save may already be committing on the host. Keep its tested identity and wait
    // for the result rather than suggesting that closing the dialog cancels that commit.
    if (saving.current) return
    disposeDraft()
    setDraft(freshSecrets)
    onClose()
  }
  useEscape(close)
  // What the host kept of the failure just reported: best effort, never a new failure.
  const failureDetail = async key => {
    try { return (await api('hermes-remote-test-status', key))?.failure } catch { return undefined }
  }
  const run = async (endpoint, payload) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    return api(endpoint, payload, controller.signal)
  }
  useEffect(() => {
    live.current = true
    const generation = ++epoch.current
    let loadedDraft = draftOf(initialView)
    void (initialView ? Promise.resolve(initialView) : run('hermes-remote')).then(async next => {
      if (!live.current || generation !== epoch.current) return
      loadedDraft = draftOf(next)
      setView(next); setDraft(loadedDraft)
      if (!edit && configured(next)) {
        setStep('working'); setStatus('connecting')
        const connected = await run('hermes-remote-connect')
        if (!live.current || generation !== epoch.current) return
        await callbacks.current.onConnected?.(connected)
      } else setStatus('idle')
    }).catch(async failure => {
      if (!live.current || generation !== epoch.current || failure?.name === 'AbortError') return
      const detail = loadedDraft.mode === 'ssh' ? await failureDetail({ connect: true }) : undefined
      if (!live.current || generation !== epoch.current) return
      failed(failure, loadedDraft, detail, 'connect')
    })
    return () => { live.current = false; disposeDraft() }
  }, [])
  useEffect(() => { dialog.current?.querySelector('input,button:not(:disabled)')?.focus() }, [step, status])
  const change = (key, value) => { if (saving.current) return; discardTest(testLease.current); setDraft(current => ({ ...current, [key]: value })); setTest(null); setError(null) }
  const ssh = (key, value) => { if (saving.current) return; discardTest(testLease.current); setTest(null); setDraft(current => ({ ...current, ssh: { ...current.ssh, [key]: value } })) }
  const pickSshHost = item => {
    if (saving.current) return
    discardTest(testLease.current); setTest(null); setError(null)
    setDraft(current => ({ ...current, mode: 'ssh', ssh: { ...EMPTY_SSH, host: item.alias, user: item.user, port: item.port } }))
  }
  // Another computer starts from its own defaults: the user, port, key and path chosen for
  // the last one are not on this screen, so they never follow a newly typed host.
  const typeSshHost = value => {
    if (saving.current) return
    discardTest(testLease.current); setTest(null); setError(null)
    setDraft(current => ({ ...current, mode: 'ssh', ssh: { ...EMPTY_SSH, host: value } }))
  }
  // The connection is kept with the profile and the chat opens: nothing else to confirm.
  const save = async (testId, chosen, shown = draft) => {
    if (saving.current) return
    saving.current = true
    const generation = ++epoch.current
    setStatus('saving'); setError(null)
    try {
      const next = await run('hermes-remote-save', { testId, profile: chosen })
      if (!live.current || generation !== epoch.current) return
      testLease.current = null // The host consumed this test into the saved connection.
      testRequest.current = null
      setView(next); callbacks.current.onSaved?.(next)
      saving.current = false
      if (callbacks.current.onConnected) await callbacks.current.onConnected(next)
      else callbacks.current.onClose()
    } catch (failure) {
      if (!live.current || generation !== epoch.current || failure?.name === 'AbortError') return
      failed(failure, shown)
    } finally { saving.current = false }
  }
  const connect = async () => {
    if (saving.current) return
    discardTest(testLease.current)
    const generation = ++epoch.current
    const requestId = globalThis.crypto.randomUUID()
    testRequest.current = requestId
    const payload = { ...draft, ssh: { ...draft.ssh, port: draft.ssh.port === '' ? undefined : Number(draft.ssh.port) }, requestId }
    stopProgress()
    setStep('working'); setStatus('connecting'); setStage('reach'); setError(null); setTest(null)
    const polling = { controller: new AbortController(), timer: null }
    progress.current = polling
    const poll = async () => {
      try {
        const answer = await api('hermes-remote-test-status', { requestId }, polling.controller.signal)
        if (live.current && generation === epoch.current && !polling.controller.signal.aborted && ['reach', 'sign-in', 'open', 'connected'].includes(answer.stage)) setStage(answer.stage)
      } catch {}
      if (live.current && generation === epoch.current && !polling.controller.signal.aborted) polling.timer = setTimeout(poll, 200)
    }
    polling.timer = setTimeout(poll, 200)
    let answer
    try {
      answer = await run('hermes-remote-test', payload)
      if (!live.current || generation !== epoch.current) { discardTest(answer.testId, requestId); return }
      testLease.current = answer.testId
    } catch (failure) {
      if (!live.current || generation !== epoch.current || failure?.name === 'AbortError') return
      const detail = payload.mode === 'ssh' ? await failureDetail({ requestId }) : undefined
      if (!live.current || generation !== epoch.current) return
      failed(failure, payload, detail, requestId)
      return
    } finally {
      if (progress.current === polling) stopProgress()
      if (live.current && generation === epoch.current) setDraft(freshSecrets)
    }
    // One profile needs no choice. Several open on the one Hermes calls its default.
    const profiles = answer.profiles ?? []
    const chosen = profiles.some(item => item.id === answer.defaultProfile) ? answer.defaultProfile : profiles[0]?.id ?? ''
    setTest(answer); setProfile(chosen); setStage('connected')
    if (profiles.length > 1) { setStep('profile'); setStatus('idle'); return }
    await save(answer.testId, chosen, payload)
  }
  // Trust names only this wizard's own failed request: the host kept the key it showed.
  const trustHost = async () => {
    if (saving.current || !error?.trust || !error.requestId) return
    const generation = ++epoch.current, requestId = error.requestId, shown = draft
    setStatus('trusting')
    try {
      await run('hermes-remote-ssh-trust', { requestId })
      if (!live.current || generation !== epoch.current) return
      await connect()
    } catch (failure) {
      if (!live.current || generation !== epoch.current || failure?.name === 'AbortError') return
      const detail = await failureDetail({ requestId })
      if (!live.current || generation !== epoch.current) return
      failed(failure, shown, detail, requestId)
    }
  }
  const refreshProfiles = async () => {
    if (saving.current) return
    const generation = ++epoch.current
    const testId = test.testId
    setStatus('refreshing')
    try {
      const next = await run('hermes-remote-test-profiles', { testId })
      if (!live.current || generation !== epoch.current) return
      const profiles = next.profiles ?? []
      setTest(current => current?.testId === testId ? { ...current, profiles } : current)
      setProfile(current => profiles.some(item => item.id === current) ? current : profiles[0]?.id ?? '')
      setStatus('idle')
    } catch (failure) {
      if (!live.current || generation !== epoch.current || failure?.name === 'AbortError') return
      failed(failure, draft)
    }
  }
  const validDetails = draft.mode === 'ssh' ? draft.ssh.host.trim().length > 0 && (draft.ssh.port === '' || (/^\d+$/.test(String(draft.ssh.port)) && Number(draft.ssh.port) > 0 && Number(draft.ssh.port) <= 65535)) : draft.address.trim().length > 0 && (draft.authMode === 'password' ? draft.username.trim().length > 0 && draft.password.length > 0 : draft.credential.length > 0 || (view?.credentialSet === true && draft.address === view.address && draft.authMode === (view.authMode ?? 'token')))
  const label = connectionLabel(draft) || t('the other computer')
  let heading, content, footer
  if (step === 'host') {
    heading = t('Choose a computer')
    content = h(Fragment, null, h('p', { className: 'bt-hw-lead' }, t('Pick one of your SSH hosts. Automagik finds the Hermes there and opens a chat.')),
      h(SshHostPicker, { host: draft.ssh.host, onPick: pickSshHost }),
      h(Field, { label: t('SSH host or config name'), value: draft.ssh.host, onChange: typeSshHost, hint: t('You can also use a name from your SSH config.') }))
    footer = h(Fragment, null, h(Button, { onClick: close }, t('Cancel')), h(Button, { primary: true, disabled: status === 'loading' || draft.mode !== 'ssh' || !validDetails, onClick: connect }, t('Connect'), ' →'))
  } else if (step === 'more') {
    heading = t('More options')
    const route = h('div', { className: 'bt-hw-field' }, h('span', null, t('How would you like to connect?')), h('div', { className: 'bt-hw-segments', role: 'group', 'aria-label': t('How would you like to connect?') }, [['ssh', t('Through SSH')], ['remote', t('Remote address')]].map(([id, name]) => h('button', { key: id, type: 'button', 'aria-pressed': draft.mode === id, onClick: () => change('mode', id) }, name))))
    content = draft.mode === 'ssh'
      ? h(Fragment, null, route,
        h(Field, { label: t('SSH host or config name'), value: draft.ssh.host, onChange: value => ssh('host', value), hint: t('You can also use a name from your SSH config.') }),
        h('div', { className: 'bt-hw-two' }, h(Field, { label: t('User (optional)'), value: draft.ssh.user, onChange: value => ssh('user', value), placeholder: t('From SSH config') }), h(Field, { label: t('Port (optional)'), value: draft.ssh.port, onChange: value => ssh('port', value), placeholder: t('From SSH config'), type: 'text' })),
        h('div', { className: 'bt-hw-field' }, h('span', null, t('SSH key (optional)')), h('div', { className: 'bt-hw-file-choice' }, h('span', null, draft.ssh.identityFile || t('Use SSH agent or SSH config')), h(Button, { onClick: () => setChoosingKey(on => !on) }, t('Choose file…'))), h('small', null, t('The key stays on this computer.')), choosingKey ? h('div', { className: 'bt-hw-key-path' }, h(Field, { label: t('Key file path'), value: draft.ssh.identityFile, onChange: value => ssh('identityFile', value), placeholder: t('Path on the computer running Automagik'), hint: t('Enter a local path. The key is never uploaded or copied.') }), h(Button, { onClick: () => setChoosingKey(false) }, t('Use this path'))) : null),
        h(Field, { label: t('Hermes path (optional)'), value: draft.ssh.hermesPath, onChange: value => ssh('hermesPath', value), placeholder: t('Find Hermes automatically'), hint: t('Hermes must already be installed on the other computer.') }),
        h(Field, { label: t('Hermes home (optional)'), value: draft.ssh.hermesHome, onChange: value => ssh('hermesHome', value), hint: t('Absolute data folder on the remote computer. Leave empty for its default Hermes home.') }))
      : h(Fragment, null, route,
        h(Field, { label: t('Remote address'), value: draft.address, onChange: value => change('address', value), hint: t('A path after the address is okay.') }),
        h('div', { className: 'bt-hw-field' }, h('span', null, t('How do you sign in?')), h('div', { className: 'bt-hw-segments', role: 'group', 'aria-label': t('How do you sign in?') }, [['token', t('Session token')], ['password', t('User and password')]].map(([id, name]) => h('button', { key: id, type: 'button', 'aria-pressed': draft.authMode === id, onClick: () => setDraft(current => ({ ...freshSecrets(current), authMode: id })) }, name)))),
        draft.authMode === 'password' ? h(Fragment, null, h('div', { className: 'bt-hw-two' }, h(Field, { label: t('User'), value: draft.username, onChange: value => change('username', value), placeholder: t('Your dashboard user') }), h(Field, { label: t('Password'), value: draft.password, onChange: value => change('password', value), placeholder: t('Enter password'), secret: true })), h(Note, null, t('Your password is used to sign in and is not saved.')))
          : h(Fragment, null, h(Field, { label: t('Session token'), value: draft.credential, onChange: value => change('credential', value), placeholder: view?.credentialSet ? t('Key saved — enter a new token to replace it') : '', secret: true, hint: t('Use the session token from this Hermes instance.') }), h(Note, null, t('The saved token stays hidden. You can replace it later.'))))
    footer = h(Fragment, null, h(Button, { onClick: () => { setDraft(current => ({ ...freshSecrets(current), mode: 'ssh' })); setStep('host') } }, t('Back')), h(Button, { primary: true, disabled: status === 'loading' || !validDetails, onClick: connect }, t('Connect'), ' →'))
  } else if (step === 'error') {
    heading = error?.heading ?? t('We couldn’t connect')
    const facts = error?.rows?.length ? h('div', { className: 'bt-hw-summary bt-hw-facts' }, error.rows.map(row => h(Pair, { key: row.label, ...row }))) : null
    const said = (error?.lines ?? []).map(block => h(Lines, { key: block.label, ...block }))
    // A new host is a question, not a fault: its key, then one button that trusts it.
    // Any other failure is what went wrong and the one thing that fixes it; the rest is
    // behind Details.
    content = error?.trust
      ? h(Fragment, null, h('div', { className: 'bt-hw-result bt-hw-ask', role: 'alert' }, h('span', { className: 'bt-hw-result-icon' }, h(ShieldIcon)), h('h3', null, error.title), h('p', null, error.text)), facts, h(Note, null, error.hint))
      : h(Fragment, null, h('div', { className: 'bt-hw-result bt-hw-failed', role: 'alert' }, h('span', { className: 'bt-hw-result-icon' }, '!'), h('h3', null, error?.title)), h(Note, { error: true }, error?.hint),
        error?.text || facts || said.length ? h('button', { type: 'button', className: 'bt-hw-details-toggle', 'aria-expanded': details, onClick: () => setDetails(on => !on) }, t('Details'), h('span', { 'aria-hidden': true }, details ? '−' : '+')) : null,
        details ? h('div', { className: 'bt-hw-details' }, error?.text ? h('p', { className: 'bt-hw-quiet' }, error.text) : null, facts, said,
          error?.ssh ? h('p', { className: 'bt-hw-quiet' }, t('Settings → Feedback keeps a line about this failure for a report.')) : null) : null)
    footer = error?.trust
      ? h(Fragment, null, h(Button, { disabled: status === 'trusting', onClick: () => setStep('host') }, t('Back')), h(Button, { primary: true, disabled: status === 'trusting', onClick: trustHost }, status === 'trusting' ? t('Trusting…') : t('Trust this host'), ' →'))
      // A sign-in that was typed is gone by now: the way on is to enter it again.
      : validDetails ? h(Fragment, null, h(Button, { onClick: () => setStep('more') }, t('More options')), h(Button, { primary: true, onClick: connect }, t('Try again'), ' →'))
        : h(Fragment, null, h(Button, { onClick: close }, t('Cancel')), h(Button, { primary: true, onClick: () => setStep(draft.mode === 'ssh' ? 'host' : 'more') }, draft.mode === 'ssh' ? t('Back') : t('More options'), ' →'))
  } else if (step === 'profile') {
    heading = t('Which profile would you like?')
    const profiles = test?.profiles ?? []
    content = h(Fragment, null, h('p', { className: 'bt-hw-lead' }, t('The Hermes on {address} has more than one profile.', { address: label })),
      profiles.length === 0 ? h(Note, { error: true }, t('No profiles are available. Check the connection and try again.')) : h('div', { className: 'bt-hw-profiles', role: 'radiogroup', 'aria-label': t('Profile') }, profiles.map(item => h('button', { key: item.id, type: 'button', className: 'bt-hw-profile', role: 'radio', 'aria-checked': profile === item.id, disabled: status === 'saving', onClick: () => { if (!saving.current) setProfile(item.id) } }, h('span', { className: 'bt-hw-radio' }), h('span', null, h('strong', null, item.name), item.id === test?.defaultProfile ? h('small', null, t('Hermes’s default')) : null), profile === item.id ? h('span', { className: 'bt-hw-tag' }, t('Selected')) : null))),
      h('div', { className: 'bt-hw-profile-tools' }, h('span', null, t('{count} profiles available', { count: profiles.length })), h('button', { type: 'button', disabled: status === 'refreshing' || status === 'saving', onClick: refreshProfiles }, t('Refresh list'))))
    footer = h(Fragment, null, h(Button, { disabled: status === 'saving', onClick: () => { if (!saving.current) { discardTest(testLease.current); setTest(null); setStep(draft.mode === 'ssh' ? 'host' : 'more') } } }, t('Back')), h(Button, { primary: true, disabled: !profile || status === 'saving' || status === 'refreshing', onClick: () => save(test.testId, profile) }, status === 'saving' ? t('Opening…') : t('Use this profile'), ' →'))
  } else {
    heading = t('Connecting to {address}', { address: label })
    const at = status === 'saving' ? 3 : ['reach', 'sign-in', 'open', 'connected'].indexOf(stage)
    content = h('div', { className: 'bt-hw-checks', role: 'status' },
      [[t('Reach the computer'), label], [t('Sign in'), at >= 2 ? t('Your sign-in was accepted') : t('Checking your sign-in…')], [t('Open Hermes'), at >= 3 ? t('Opening the chat…') : t('Opening the connection…')]].map(([title, description], index) => {
        const done = index < at, working = index === at || (at >= 3 && index === 2)
        return h('div', { key: title, className: 'bt-hw-check-row' }, h('span', { className: `bt-hw-status${working ? ' bt-hw-working' : !done ? ' bt-hw-pending' : ''}` }, working ? h('span', { className: 'bt-hw-spinner' }) : done ? h(CheckIcon) : '·'), h('div', null, h('strong', null, title), h('small', null, description)))
      }))
    footer = h(Fragment, null, h(Button, { disabled: status === 'saving', onClick: close }, t('Cancel')), h(Button, { disabled: true }, t('Connecting…')))
  }
  const trap = event => {
    if (event.key !== 'Tab') return
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
    if (controls.length === 0) { event.preventDefault(); dialog.current.focus(); return }
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return createPortal(h('div', { className: 'bt-hermes-layer' }, h('style', null, HERMES_REMOTE_CSS), h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { ref: dialog, role: 'dialog', 'aria-modal': true, 'aria-label': t('Connect Remote Hermes'), 'aria-busy': status === 'saving' || status === 'trusting' || undefined, tabIndex: -1, className: 'bt-hermes-wizard', 'data-step': step, 'data-status': status, onKeyDown: trap },
      h('header', { className: 'bt-hw-head' }, h('div', { className: 'bt-hw-identity' }, h(HermesMark, { size: 36 }), h('div', null, h('strong', null, t('Connect Remote Hermes')), h('small', null, t('Chat with a Hermes agent on another computer.'))), h('button', { type: 'button', className: 'bt-hw-close', 'aria-label': t('Close connection setup'), disabled: status === 'saving', onClick: close }, h(CloseIcon)))),
      h('main', { className: 'bt-hw-content' }, h('h2', null, heading), content), h('footer', { className: 'bt-hw-foot' }, footer))), document.body)
}

export function HermesRemoteSettings({ run, Section, actions }) {
  const [view, setView] = useState(null)
  const [pairing, setPairing] = useState(false)
  const [editing, setEditing] = useState(null)
  const [reconciliation, setReconciliation] = useState(null)
  useEffect(() => { let on = true; void run(api('hermes-remote').then(next => { if (on) setView(next) })); return () => { on = false } }, [])
  if (!view) return null
  const where = view.mode === 'ssh' ? view.ssh?.host : view.address
  return h(Fragment, null, h('style', null, HERMES_REMOTE_CSS), h(Section, null,
    h('div', { className: 'bt-set-row' }, h('div', { className: 'bt-set-copy' }, h('span', null, t('Chat with a Hermes agent on another computer.')), h('span', { className: 'bt-set-hint' }, t('Your bots’ team tools (messages to other bots, secrets, memory, schedules) are not available in these chats.')))),
    h('div', { className: 'bt-set-row' }, h('div', { className: 'bt-set-copy' }, h('span', null, configured(view) ? where : t('No connection saved')), configured(view) ? h('span', { className: 'bt-set-hint' }, t('Profile: {profile}', { profile: view.profile })) : null),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setEditing('host') }, configured(view) ? t('Change computer') : t('Set up connection')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setEditing('more') }, t('More'))),
    configured(view) ? h('div', { className: 'bt-set-row' },
      h('label', null, t('Pair Hermes Bot'), h('select', { 'aria-label': t('Pair Hermes Bot'), value: view.pairedBotId ?? '', disabled: pairing,
        onChange: event => {
          const botId = event.target.value
          setPairing(true)
          void run(api('hermes-remote-pair', { botId }).then(next => setView(next)).finally(() => setPairing(false)))
        } }, h('option', { value: '' }, t('Not paired')),
        (view.bots ?? []).map(bot => h('option', { key: bot.id, value: bot.id, disabled: Boolean(view.pairedBotId && view.pairedBotId !== bot.id) }, bot.name)))),
      h('span', { className: 'bt-set-hint' }, t('Uses this profile’s existing Bot Chat. Other bots, groups and tasks cannot use this pairing. Unpair before changing it.'))) : null,
    configured(view) ? h('div', { className: 'bt-set-row' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(api('hermes-remote-disconnect').then(next => { if (next) setView(next) })) }, t('Disconnect'))) : null,
    (view.sessions ?? []).filter(session => session.uncertain || session.pendingSubmit).map(session => h('div', { key: session.sessionId }, h('p', { role: 'status' }, t('Connection lost; remote outcome unknown')), h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(api('hermes-remote-reconcile', { sessionId: session.sessionId }).then(next => { setView(next); setReconciliation(next.reconciliation) })) }, t('Reconnect and reconcile')))),
    reconciliation ? h('div', { role: 'status', className: 'bt-set-hint' }, reconciliation.unknown ? t('Connection lost; remote outcome unknown') : t('Remote session reconciled. Review the remote transcript before sending again.'), reconciliation.gap ? h('p', null, t('Replay gap: showing a fresh remote snapshot.')) : null, h('pre', null, (reconciliation.messages ?? []).map(message => `${message.role}: ${typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : ''}`).join('\n')), reconciliation.inflight?.assistant ? h('p', null, reconciliation.inflight.assistant) : null) : null),
    editing ? h(HermesRemoteConnect, { key: editing, edit: true, more: editing === 'more', initialView: view, onClose: () => setEditing(null), onSaved: next => { setView(next); void actions?.refreshModels?.() }, onConnected: () => setEditing(null) }) : null)
}

export const HERMES_REMOTE_CSS = `${HERMES_MARK_CSS}
.bt-hermes-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:90;display:flex;align-items:center;justify-content:center;font-family:var(--bt-font);color:var(--bt-ink)}
.bt-hermes-wizard{position:relative;width:min(736px,calc(100vw - 40px));max-height:calc(100dvh - 48px);display:flex;flex-direction:column;background:var(--st-raised,var(--bt-main));border:1px solid var(--st-line,var(--bt-line-2));border-radius:var(--st-r-dialog,24px);box-shadow:var(--st-lift,0 18px 60px rgba(0,0,0,.267));overflow:hidden}
.bt-hw-head{padding:24px 28px 18px;border-bottom:1px solid var(--st-line,var(--bt-line));background:var(--bt-card)}.bt-hw-identity{display:flex;align-items:center;gap:12px}.bt-hw-identity>div{display:flex;flex-direction:column;gap:2px}.bt-hw-identity strong{font:var(--bt-weight-strong,700) 16px var(--bt-head-font,var(--bt-font))}.bt-hw-identity small{font-size:12px;color:var(--bt-ink-2)}.bt-hw-close{margin-left:auto;width:30px;height:30px;border:0;border-radius:8px;display:grid;place-items:center;color:var(--bt-ink-2);background:var(--st-sunk,var(--bt-hover));cursor:pointer}
.bt-hw-content{padding:26px 28px;background:var(--bt-card);overflow:auto}.bt-hw-content h2{font:var(--bt-weight-title,700) 23px/30px var(--bt-head-font,var(--bt-font));margin:0 0 10px;letter-spacing:-.016em}.bt-hw-lead{color:var(--bt-ink-2);margin:0 0 22px;font-size:14px;line-height:21px}.bt-hw-quiet{color:var(--bt-ink-2);font-size:12px;line-height:18px;margin:18px 0 0}
.bt-hw-field{display:flex;flex-direction:column;gap:8px;margin:0 0 18px;font-size:13px}.bt-hw-field>span:first-child{font-weight:600}.bt-hw-field small{color:var(--bt-ink-2);font-size:12px;line-height:17px}.bt-hw-field input{height:42px;width:100%;box-sizing:border-box;border:1px solid var(--st-line,var(--bt-line-2));border-radius:8px;padding:0 12px;background:var(--st-raised,var(--bt-main));color:var(--bt-ink);font:14px var(--bt-font);outline:none}.bt-hw-field input::placeholder{color:var(--bt-ink-2);opacity:1}.bt-hw-field input:focus-visible,.bt-hermes-wizard button:focus-visible{outline:2px solid var(--st-ring,var(--bt-accent));outline-offset:2px}.bt-hw-segments{display:flex;gap:4px;padding:4px;border-radius:10px;align-self:flex-start;background:var(--st-sunk,var(--bt-hover))}.bt-hw-segments button{border:0;border-radius:var(--bt-hw-choice-radius,7px);background:transparent;color:var(--bt-ink-2);padding:8px 13px;font:12px var(--bt-font);cursor:pointer}.bt-hw-segments button[aria-pressed=true]{background:var(--bt-card);color:var(--bt-ink);box-shadow:0 1px 3px rgba(0,0,0,.067);font-weight:600}.bt-hw-file-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--st-line,var(--bt-line-2));border-radius:8px;padding:8px 10px;background:var(--st-raised,var(--bt-main));color:var(--bt-ink-2);font-size:13px}.bt-hw-file-choice>span{overflow-wrap:anywhere;min-width:0}.bt-hw-file-choice .bt-hw-button{height:30px;padding:0 10px;font-size:12px}.bt-hw-key-path{border:1px solid var(--bt-line-2);padding:14px;border-radius:10px;background:var(--bt-card)}.bt-hw-key-path .bt-hw-field{margin-bottom:10px}.bt-hw-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.bt-hw-note{display:flex;gap:10px;padding:13px 14px;border:1px solid var(--st-line,var(--bt-line));border-radius:10px;background:var(--st-raised,var(--bt-main));color:var(--bt-ink-2);font-size:12px;line-height:19px}.bt-hw-note svg{flex:none;margin-top:1px}.bt-hw-error-note{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));border-color:transparent;color:var(--st-bad-strong,var(--bt-danger))}
.bt-hw-foot{padding:18px 28px;display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--st-line,var(--bt-line));background:var(--st-raised,var(--bt-main))}.bt-hw-button{height:38px;border:1px solid transparent;border-radius:8px;font:600 13px var(--bt-font);padding:0 15px;display:inline-flex;gap:10px;align-items:center;justify-content:center;white-space:nowrap;cursor:pointer}.bt-hw-primary{background:var(--st-cyan,var(--bt-accent));color:var(--st-cyan-ink,var(--bt-accent-ink,var(--bt-card)));box-shadow:var(--st-clay,none)}.bt-hw-secondary{background:var(--bt-card);border-color:var(--st-line,var(--bt-line-2));color:var(--bt-ink)}.bt-hw-button:disabled{background:var(--st-sunk,var(--bt-hover));color:var(--bt-ink-2);box-shadow:none;cursor:default}
.bt-hw-checks{border:1px solid var(--st-line,var(--bt-line));border-radius:12px;overflow:hidden}.bt-hw-check-row{display:flex;gap:12px;align-items:center;padding:17px;border-bottom:1px solid var(--st-line,var(--bt-line))}.bt-hw-check-row:last-child{border:0}.bt-hw-check-row>div{display:flex;flex-direction:column;gap:4px}.bt-hw-check-row strong{font-size:13px}.bt-hw-check-row small{font-size:12px;color:var(--bt-ink-2)}.bt-hw-status{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--bt-green) 10%,var(--bt-card));color:var(--bt-green)}.bt-hw-pending{background:var(--bt-hover);color:var(--bt-ink-2)}.bt-hw-working{background:var(--st-lilac,var(--bt-active));color:var(--st-lilac-ink,var(--bt-ink))}.bt-hw-spinner{width:17px;height:17px;border-radius:50%;border:2px solid var(--bt-line-2);border-top-color:var(--st-lilac-ink,var(--bt-ink));animation:bt-hw-spin .8s linear infinite}@keyframes bt-hw-spin{to{transform:rotate(360deg)}}
.bt-hw-result{text-align:center;padding:10px 28px 28px}.bt-hw-result-icon{display:grid;place-items:center;width:58px;height:58px;margin:8px auto 16px;border-radius:50%}.bt-hw-result-icon svg{width:30px;height:30px}.bt-hw-success .bt-hw-result-icon{background:color-mix(in srgb,var(--bt-green) 10%,var(--bt-card));color:var(--bt-green)}.bt-hw-failed .bt-hw-result-icon{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger);font-size:30px}.bt-hw-result h3{font:var(--bt-weight-title,700) 20px var(--bt-head-font,var(--bt-font));margin:0 0 10px}.bt-hw-result p{margin:0;color:var(--bt-ink-2);font-size:14px;line-height:22px}.bt-hw-details-toggle{display:flex;align-items:center;justify-content:center;gap:8px;margin:14px auto;border:0;background:none;color:var(--bt-ink-2);font:12px var(--bt-font);padding:4px 8px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.bt-hw-details>.bt-hw-quiet{margin:0 0 14px}.bt-hw-summary{border:1px solid var(--st-line,var(--bt-line));border-radius:var(--bt-hw-summary-radius,11px);overflow:hidden;background:var(--st-raised,var(--bt-main))}.bt-hw-pair{display:flex;justify-content:space-between;gap:20px;padding:14px 16px;border-bottom:1px solid var(--st-line,var(--bt-line));font-size:13px}.bt-hw-pair:last-child{border:0}.bt-hw-pair span{color:var(--bt-ink-2);flex:none}.bt-hw-pair strong{font-weight:500;overflow-wrap:anywhere;min-width:0;text-align:right}.bt-hw-mono{font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace}.bt-hw-facts{margin:0 0 14px}.bt-hw-result+.bt-hw-facts{margin-top:-6px}.bt-hw-ask .bt-hw-result-icon{background:var(--st-lilac,var(--bt-active));color:var(--st-lilac-ink,var(--bt-ink))}.bt-hw-lines{margin:0 0 14px;border:1px solid var(--st-line,var(--bt-line));border-radius:var(--bt-hw-summary-radius,11px);background:color-mix(in srgb,var(--st-sunk,var(--bt-hover)) 55%,var(--bt-card));overflow:hidden}.bt-hw-lines>span{display:block;padding:11px 16px 0;font-size:11px;font-weight:600;color:var(--bt-ink-2)}.bt-hw-lines pre{margin:0;padding:6px 16px 12px;max-height:126px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--bt-ink);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace}.bt-hw-profiles{border:1px solid var(--st-cyan,var(--bt-accent));border-radius:12px;background:var(--st-raised,var(--bt-main));overflow:hidden}.bt-hw-profile{display:flex;align-items:center;gap:14px;width:100%;padding:20px;border:0;border-bottom:1px solid var(--bt-line);background:transparent;color:var(--bt-ink);text-align:left;cursor:pointer}.bt-hw-profile:last-child{border-bottom:0}.bt-hw-profile[aria-checked=true]{box-shadow:inset 0 0 0 1px var(--st-cyan,var(--bt-accent))}.bt-hw-profile>span:nth-child(2){display:flex;flex-direction:column;gap:5px}.bt-hw-profile strong{font-size:15px}.bt-hw-profile small{font-size:12px;color:var(--bt-ink-2)}.bt-hw-radio{width:18px;height:18px;box-sizing:border-box;border:1px solid var(--bt-line-2);border-radius:50%;background:var(--bt-card)}[aria-checked=true]>.bt-hw-radio{border:5px solid var(--st-cyan,var(--bt-accent))}.bt-hw-tag{margin-left:auto;padding:4px 8px;border-radius:6px;background:var(--st-lilac,var(--bt-active));color:var(--st-lilac-ink,var(--bt-ink));font-size:11px}.bt-hw-profile-tools{display:flex;justify-content:space-between;font-size:12px;color:var(--bt-ink-2);margin:14px 0 22px}.bt-hw-profile-tools button{border:0;background:none;padding:0;color:var(--bt-ink);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}.bt-hw-remember{display:flex;gap:9px;align-items:center;font-size:12px;color:var(--bt-green);margin:16px 0}.bt-hw-limits{font-size:12px;line-height:19px;color:var(--bt-ink-2);margin:18px 0 0}.bt-hw-compact{padding-top:0;padding-bottom:18px}.bt-hw-compact .bt-hw-result-icon{margin-top:0}
.bt-hw-host-picker{margin:0 0 20px;padding:14px;border:1px solid var(--st-line,var(--bt-line-2));border-radius:12px;background:var(--st-raised,var(--bt-main));min-width:0}.bt-hw-host-title{display:block;font-size:13px;margin-bottom:10px}.bt-hw-host-picker .bt-hw-field{margin:0 0 10px;gap:6px}.bt-hw-host-picker .bt-hw-field>span{font-size:12px;font-weight:400;color:var(--bt-ink-2)}.bt-hw-host-picker .bt-hw-field input{height:34px;font-size:13px}.bt-hw-host-list{max-height:248px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--st-line,var(--bt-line));border-radius:8px}.bt-hw-host-choice{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:0;border-bottom:1px solid var(--st-line,var(--bt-line));padding:9px 10px;background:transparent;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}.bt-hw-host-choice:last-child{border-bottom:0}.bt-hw-host-choice:hover,.bt-hw-host-choice[aria-pressed=true]{background:var(--bt-hover)}.bt-hw-host-choice>span{display:flex;flex-direction:column;gap:3px;min-width:0}.bt-hw-host-choice strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}.bt-hw-host-choice small{font-size:11px;color:var(--bt-ink-2);overflow-wrap:anywhere}.bt-hw-host-choice svg{flex:none;width:14px;height:14px;color:var(--st-cyan,var(--bt-accent))}.bt-hw-host-hint{margin:0;font-size:12px;line-height:18px;color:var(--bt-ink-2)}.bt-hw-other-hosts{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:0;background:none;color:var(--bt-ink-2);font:12px var(--bt-font);padding:12px 0 0;text-align:left;cursor:pointer}.bt-hw-other-hosts+ .bt-hw-host-list{margin-top:10px}
@media(max-width:640px){.bt-hermes-wizard{width:calc(100vw - 20px);max-height:calc(100dvh - 20px)}.bt-hw-head,.bt-hw-content{padding:18px}.bt-hw-foot{padding:14px 18px}.bt-hw-two{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.bt-hw-spinner{animation:none}}
`
