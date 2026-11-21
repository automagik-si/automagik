import { createElement as h, Fragment, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { dateTimeLabel } from './text.js'

// ---- Claude Code (5b) ----

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

const states = () => ({
  'not-signed-in': t('Not signed in'),
  override: t('An environment variable overrides this login'),
  'bad-folder': t('Its folder cannot be used'),
  ambiguous: t('Two logins share this email'),
  timeout: t('Did not answer in time'),
  failed: t('Could not be read'),
})

function AccountRow({ row, launcher, canUse, busy, useLogin }) {
  const label = row.label === 'default' ? t('Default login') : t('Login {id}', { id: row.id })
  const details = [row.email, states()[row.state]].filter(Boolean).join(' · ')
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, label),
      details ? h('span', { className: 'bt-set-hint' }, details) : null,
      row.effective && !launcher ? h('span', { className: 'bt-set-hint' }, t('Used by new launches')) : null),
    canUse && row.use ? h('button', { className: 'bt-mini', type: 'button', disabled: busy,
      'aria-label': t('Use {login}', { login: label }), onClick: () => void useLogin(row.id) }, t('Use this login')) : null)
}

function ClaudeLogins({ Section }) {
  const [view, setView] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const load = async signal => {
    const next = await call('accounts-claude', null, signal).catch(() => ({ reason: 'cli-error' }))
    if (!signal?.aborted) setView(next)
  }
  useEffect(() => {
    const controller = new AbortController()
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

  const messages = reasons()
  const reason = view?.reason === 'failed' ? 'unreadable' : view?.reason ?? view?.why
  const message = (code, fallback) => Object.hasOwn(messages, code) ? messages[code] : messages[fallback]
  return h(Fragment, null,
    !view ? hint(t('Loading…'), 'status') : null,
    result ? hint(result.switched ? t('Claude Code login switched.') : message(result.reason, 'unknown'), 'status') : null,
    reason && reason !== 'desktop-only' && reason !== result?.reason ? hint(message(reason, 'cli-error')) : null,
    view?.readOnly && result?.reason !== 'read-only' ? hint(messages['read-only']) : null,
    view?.fallback ? hint(t('The selected login cannot be used. Fix it in the Herdr Accounts panel.')) : null,
    view?.launcher ? hint(t('Claude Code starts through your own launcher here, so this page cannot tell which login it uses.')) : null,
    view?.rows?.length ? h(Section, { title: t('Claude Code') }, view.rows.map(row => h(AccountRow, {
      key: row.id, row, launcher: view.launcher, canUse: Boolean(view.token) && !view.readOnly, busy, useLogin,
    }))) : null)
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
