import { createElement as h, Fragment, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { dateTimeLabel } from './text.js'

const FAILURE = "Could not read this computer's accounts."
const hint = (message, role) => h('p', { className: 'bt-set-hint', role }, t(message))
const row = (...lines) => h('div', { className: 'bt-set-row' },
  h('div', { className: 'bt-set-copy' }, lines.filter(Boolean).map((line, index) =>
    h('span', { key: index, className: 'bt-set-hint' }, line))))

function fileLabel({ file, account }) {
  if (file === 'present') return account ? t('Account fingerprint: {account}', { account })
    : t('Account unknown: the sign-in file names no account.')
  return file === 'absent' ? t('No sign-in file in this folder.') : t('Could not read the sign-in file.')
}

export function AccountsPage({ Section }) {
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
  if (!view) content = hint('Loading…', 'status')
  else if (view.reason === 'desktop-only') content = hint('Accounts show in the Automagik desktop app.')
  else if (!codex) content = hint(FAILURE, 'alert')
  else content = h(Section, { title: t('Codex') },
    row(fileLabel(codex),
      codex.file === 'absent' && t('Codex can also keep its sign-in elsewhere, such as the system keyring.'),
      codex.folder && t('Folder: {folder}', { folder: codex.folder }),
      refreshed && t('Last refreshed: {time}', { time: refreshed })),
    row(t('Account proxy: Unknown'), t("The proxy's state needs its management key, which only the Herdr panel reads for now.")))

  return h(Fragment, null,
    hint("This computer's Codex account, as its sign-in file shows it. Switching accounts stays in the Herdr Accounts panel."), content)
}
