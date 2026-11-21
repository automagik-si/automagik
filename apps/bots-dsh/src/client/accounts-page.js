import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { dateTimeLabel } from './text.js'

// ---- Claude Code (5b) ----

const CONFIRM_MS = 5_000
// The row states that confirm a login is signed in (accounts here's slot states).
const SIGNED_IN = ['eligible', 'override', 'ambiguous']
const hint = (message, role) => h('div', { className: 'bt-set-hint', role }, message)
const reasons = () => ({
  'not-installed': t('am or the Herdr pack is not installed on this computer.'),
  'old-cli': t('Update am or the Herdr pack to switch logins here.'),
  'panel-old': t('The Herdr Accounts panel is on and older than this page. Update the Herdr pack, or switch the panel off, to switch here.'),
  'panel-unknown': t('Could not tell which version of the Herdr Accounts panel is installed.'),
  'home-mismatch': t('This app and the command line use different Herdr homes, so switching is off here.'),
  unreadable: t('Could not read the Claude Code logins.'),
  'chosen-home': t('This installation uses a separate agent home. Manage its logins in the Herdr Accounts panel.'),
  unavailable: t('Accounts are not available on Windows yet.'),
  'read-only': t('This host can only read accounts.'),
  'cli-error': t('am could not do this.'),
  'cli-timeout': t('am took too long to reply.'),
  'cli-protocol': t('am returned an unexpected reply.'),
  conflict: t('The logins changed since this page read them. Read again.'),
  busy: t('Another change to the logins is in progress. Read again.'),
  unknown: t('Could not confirm the switch. Read again before trying again.'),
  changed: t('This login choice has changed or expired. Read again.'),
  failed: t('Could not switch the Claude Code login.'),
})

// Add and Remove login (5b, RFC 0030 Decisions (2026-11-21), 1): the Herdr Accounts panel's checks, kept.
const editReasons = () => ({
  'no-folder': t('That folder does not exist yet. Make it first, then sign in there.'),
  'not-signed-in': t('Claude Code is not signed in there yet. Sign in with the command, then press Add.'),
  moved: t('Claude Code settings move this login to another folder, so this page will not change it.'),
  'probe-failed': t('Could not tell whether Claude Code is signed in there. Try again.'),
  'no-claude': t('Claude Code is not found where launches look for it.'),
  'bad-folder': t('That folder cannot be used: it must be a folder of its own, not a link. Make it again, then sign in there.'),
  'in-use': t('New launches use this login. Switch to another login first.'),
  running: t('A terminal still runs on this login. Restart or stop it first.'),
  'running-unknown': t('A terminal runs on a login folder this page cannot match. Restart or stop it first.'),
  'no-home': t('The Herdr home folder does not exist yet, so no login can be added here.'),
  'panes-unknown': t('Could not check the running terminals, so nothing was removed.'),
  unknown: t('Could not confirm the change. Read again before trying again.'),
  failed: t('Could not change the Claude Code logins.'),
})

const states = () => ({
  'not-signed-in': t('Not signed in'),
  override: t('An environment variable overrides this login'),
  'bad-folder': t('Its folder cannot be used'),
  ambiguous: t('Two logins share this email'),
  timeout: t('Did not answer in time'),
  failed: t('Could not be read'),
})

const loginLabel = row => row.label === 'default' ? t('Default login') : t('Login {id}', { id: row.id })

function AccountRow({ row, launcher, canUse, busy, useLogin, confirming, askRemove, keep, removeLogin }) {
  const label = loginLabel(row)
  const details = [row.email, states()[row.state]].filter(Boolean).join(' · ')
  return h('div', { className: 'bt-set-row', 'data-confirm': confirming ? '' : undefined },
    h('div', { className: 'bt-set-copy' },
      h('span', null, label),
      confirming
        ? h('span', { className: 'bt-set-hint' }, t('Remove {login} from this list? Its folder stays.', { login: label }))
        : details ? h('span', { className: 'bt-set-hint' }, details) : null,
      !confirming && row.effective && !launcher ? h('span', { className: 'bt-set-hint' }, t('Used by new launches')) : null),
    confirming
      ? h('div', { className: 'bt-set-control' },
          h('button', { className: 'bt-mini', type: 'button', autoFocus: true, onClick: keep }, t('Keep')),
          h('button', { className: 'bt-mini', type: 'button', disabled: busy, 'data-confirm': '',
            'aria-label': t('Remove {login} now', { login: label }), onClick: () => void removeLogin(row.id) }, t('Remove')))
      : [
          canUse && row.use ? h('button', { key: 'use', className: 'bt-mini', type: 'button', disabled: busy,
            'aria-label': t('Use {login}', { login: label }), onClick: () => void useLogin(row.id) }, t('Use this login')) : null,
          row.remove ? h('button', { key: 'remove', className: 'bt-mini', type: 'button', disabled: busy,
            'aria-label': t('Remove {login}', { login: label }), onClick: () => askRemove(row.id) }, t('Remove')) : null,
        ])
}

function AddLogin({ add, busy, addLogin }) {
  const label = t('Login {id}', { id: add.id })
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, t('Add {login}', { login: label })),
      h('span', { className: 'bt-set-hint' }, t('Make the folder {folder} (link settings.json and CLAUDE.md from ~/.claude into it to share them), sign in there from a terminal with this command, then press Add.', { folder: add.folder })),
      h('code', { className: 'bt-aa-address' }, add.signIn)),
    h('div', { className: 'bt-set-control' },
      h('button', { className: 'bt-mini', type: 'button', disabled: busy,
        'aria-label': t('Add {login}', { login: label }), onClick: () => void addLogin(add.id) }, t('Add'))))
}

function ClaudeLogins({ Section }) {
  const [view, setView] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [confirm, setConfirm] = useState(null)
  // A Remove asked for and not confirmed lapses, as the panel's second press does.
  useEffect(() => {
    if (confirm === null) return undefined
    const timer = setTimeout(() => setConfirm(null), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirm])
  // Once Add or Remove has been offered, Read again stays, so a failed read can be retried in place.
  const [editing, setEditing] = useState(false)
  // One signal for the page's life: leaving Settings cancels a queued edit and its read.
  const life = useRef(null)
  const load = async (signal = life.current?.signal) => {
    setConfirm(null)
    const next = await call('accounts-claude', null, signal).catch(() => ({ reason: 'cli-error' }))
    if (signal?.aborted) return
    setView(next)
    if (next?.editToken) setEditing(true)
  }
  useEffect(() => {
    const controller = new AbortController()
    life.current = controller
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  const useLogin = async id => {
    if (busy || !view?.token) return
    setBusy(true)
    setResult(null)
    try {
      const answer = await call('accounts-claude-use', { id, token: view.token }).catch(error => ({
        reason: error?.code === 'bot/read-only' ? 'read-only' : 'unknown',
      }))
      setResult(answer)
      await load()
    } finally { setBusy(false) }
  }

  // One change at a time; the page reads again after each, whatever the answer.
  const edit = async (endpoint, id) => {
    if (busy || !view?.editToken) return
    setBusy(true)
    setResult(null)
    setConfirm(null)
    try {
      const signal = life.current?.signal
      const answer = await call(endpoint, { id, token: view.editToken }, signal).catch(error => ({
        reason: error?.code === 'bot/read-only' ? 'read-only' : 'unknown',
      }))
      if (signal?.aborted) return
      setResult({ ...answer, edit: true, id })
      await load(signal)
    } finally { setBusy(false) }
  }
  const addLogin = id => edit('accounts-claude-add', id)
  const removeLogin = id => edit('accounts-claude-remove', id)
  const readAgain = async () => {
    if (busy) return
    setBusy(true)
    setResult(null)
    try { await load() } finally { setBusy(false) }
  }

  const messages = reasons()
  const edits = editReasons()
  const reason = view?.reason === 'failed' ? 'unreadable' : view?.reason ?? view?.why
  const message = (code, fallback) => Object.hasOwn(messages, code) ? messages[code] : messages[fallback]
  // The logout command is shown only while the read after the refusal still offers that login's Remove.
  // The read after the refusal must still name that same login (id and folder) as removable and signed in.
  const stillRemovable = result?.reason === 'signed-in' && !busy && Boolean(view?.editToken) && typeof result.key === 'string'
    && view.rows?.some(row => row.id === result.id && row.remove === true && row.key === result.key && SIGNED_IN.includes(row.state))
  const editMessage = answer => {
    if (answer.added) return t('Login {id} added. Use it to start new Claude launches there.', { id: answer.id })
    if (answer.removed) return t('Login {id} removed. Its folder stays; delete it by hand if you want.', { id: answer.id })
    if (answer.reason === 'signed-in' && busy) return null
    if (answer.reason === 'signed-in') return stillRemovable ? t('Login {id} is still signed in. Sign it out in a terminal with this command, then remove it again.', { id: answer.id }) : messages.changed
    if (Object.hasOwn(edits, answer.reason)) return edits[answer.reason]
    return Object.hasOwn(messages, answer.reason) && answer.reason !== 'failed' ? messages[answer.reason] : edits.failed
  }
  const resultText = !result ? null : result.edit ? editMessage(result)
    : result.switched ? t('Claude Code login switched.') : message(result.reason, 'unknown')
  return h(Fragment, null,
    !view ? hint(t('Loading…'), 'status') : null,
    resultText ? hint(resultText, 'status') : null,
    stillRemovable && typeof result.signOut === 'string' ? h('code', { className: 'bt-aa-address' }, result.signOut) : null,
    reason && reason !== 'desktop-only' && reason !== result?.reason ? hint(message(reason, 'cli-error')) : null,
    view?.readOnly && result?.reason !== 'read-only' ? hint(messages['read-only']) : null,
    view?.fallback ? hint(t('The selected login cannot be used. Fix it in the Herdr Accounts panel.')) : null,
    view?.launcher ? hint(t('Claude Code starts through your own launcher here, so this page cannot tell which login it uses.')) : null,
    view?.editWhy === 'no-home' ? hint(edits['no-home']) : null,
    view?.rows?.length ? h(Section, { title: t('Claude Code') }, view.rows.map(row => h(AccountRow, {
      key: row.id, row: view.editToken ? row : { ...row, remove: false }, launcher: view.launcher,
      canUse: Boolean(view.token) && !view.readOnly, busy, useLogin,
      confirming: confirm === row.id && row.remove === true && Boolean(view.editToken), askRemove: setConfirm, keep: () => setConfirm(null), removeLogin,
    })), view.add && view.editToken ? h(AddLogin, { add: view.add, busy, addLogin }) : null) : null,
    // After a sign-in in a terminal the page reads again on demand; shown where Add or Remove is offered.
    view && (view.editToken || editing) ? h('button', { className: 'bt-mini', type: 'button', disabled: busy, onClick: () => void readAgain() }, t('Read again')) : null)
}

// ---- Codex (5c) ----

const FAILURE = "Could not read this computer's accounts."
const codexHint = (message, role) => h('p', { className: 'bt-set-hint', role }, t(message))
const row = (...lines) => h('div', { className: 'bt-set-row' },
  h('div', { className: 'bt-set-copy' }, lines.filter(Boolean).map((line, index) =>
    h('span', { key: index, className: 'bt-set-hint' }, line))))

function fileLabel({ file, account }) {
  if (file === 'present') return account ? t('Account fingerprint: {account}', { account })
    : t('Account unknown: the sign-in file names no account.')
  return file === 'absent' ? t('No sign-in file in this folder.') : t('Could not read the sign-in file.')
}

function CodexAccount({ Section }) {
  const [view, setView] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    call('accounts-codex', null, controller.signal).then(
      result => { if (!controller.signal.aborted) setView(result) },
      () => { if (!controller.signal.aborted) setView({ reason: 'failed' }) },
    )
    return () => controller.abort()
  }, [])

  const codex = view?.codex
  const refreshed = dateTimeLabel(codex?.lastRefresh)
  let content
  if (!view) content = codexHint('Loading…', 'status')
  else if (view.reason === 'desktop-only') content = codexHint('Accounts show in the Automagik desktop app.')
  else if (!codex) content = codexHint(FAILURE, 'alert')
  else content = h(Section, { title: t('Codex') },
    row(fileLabel(codex),
      codex.file === 'absent' && t('Codex can also keep its sign-in elsewhere, such as the system keyring.'),
      codex.folder && t('Folder: {folder}', { folder: codex.folder }),
      refreshed && t('Last refreshed: {time}', { time: refreshed })),
    row(t('Account proxy: Unknown'), t("The proxy's state needs its management key, which only the Herdr panel reads for now.")))

  return h(Fragment, null,
    codexHint("This computer's Codex account, as its sign-in file shows it. Switching accounts stays in the Herdr Accounts panel."), content)
}

// Settings → Accounts: the Claude Code logins of this Herdr home, switched here (5b), then this
// computer's Codex account, read only (5c; its switch stays in the Herdr Accounts panel, Q23).
export function AccountsPage({ Section }) {
  return h(Fragment, null,
    h('p', { className: 'bt-set-hint' }, t('Choose which Claude Code login new launches use, for bots that run from this Herdr home. Running bots keep their login until they restart.')),
    h(ClaudeLogins, { Section }),
    h(CodexAccount, { Section }))
}
