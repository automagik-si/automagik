// Account controls stay in the owner's Bot settings, never in team state or a transcript.
import { createElement as h, useEffect, useState } from 'react'
import { CLI_NAMES } from './cli-login-model.js'
import { ACCOUNT_RECOVERY_CODE, ACCOUNT_RECOVERY_HINT } from '../shared/cli-account.js'
import { t } from './i18n.js'

const botAccountName = account => account?.email ?? account?.org ?? t('Account not shown by the CLI')

export function CliAccounts({ bot, actions }) {
  const [accounts, setAccounts] = useState({})
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const refresh = async () => setAccounts((await actions.cliLoginAccounts?.())?.accounts ?? {})
  useEffect(() => {
    let alive = true
    Promise.resolve(actions.cliLoginAccounts?.()).then(value => {
      if (alive) setAccounts(value?.accounts ?? {})
    }).catch(() => {})
    return () => { alive = false }
  }, [bot.id, actions])
  useEffect(() => {
    // Refresh after an in-chat sign-in finishes, without polling either account in the UI.
    let alive = true
    const off = actions.cliLogin?.subscribe(() => {
      const rows = Object.values(actions.cliLogin.getSnapshot().rows)
      if (!rows.some(row => row.stage === 'done')) return
      Promise.resolve(actions.cliLoginAccounts?.()).then(value => {
        if (alive) setAccounts(value?.accounts ?? {})
      }).catch(() => {})
    })
    return () => { alive = false; off?.() }
  }, [actions])
  const change = async () => {
    setBusy(true)
    setError(null)
    try {
      const { provider, action } = pending
      if (action === 'recover') await actions.recoverCliLogin(bot.id, provider)
      else if (action === 'switch') await actions.cliLoginSwitch(bot.id, provider)
      else if (action === 'reset') await actions.cliLoginReset(bot.id, provider)
      else await actions.cliLoginSignOut(bot.id, provider)
      await actions.refreshModels?.()
      await refresh()
      setPending(null)
      if (action === 'switch' || action === 'reset') actions.openCliLogin(bot.id, provider)
    } catch (error) {
      if (error?.code === ACCOUNT_RECOVERY_CODE) {
        const provider = pending.provider
        setAccounts(current => ({ ...current, [provider]: {
          ...current[provider], signedIn: false, recoveryRequired: true,
        } }))
        setPending(null)
      } else setError(t('Account change failed. Close other app windows and try again.'))
    } finally { setBusy(false) }
  }
  const entries = Object.entries(accounts).filter(([id, entry]) => (
    Object.hasOwn(CLI_NAMES, id) && entry.authScope === 'isolated'
  ))
  if (!entries.length) return null
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Bot accounts')),
    h('p', { className: 'bt-set-hint' }, t('Bots in this installation share these accounts.')),
    h('p', { className: 'bt-set-hint' },
      t('Your terminal login is separate and stays unchanged.')),
    h('div', { className: 'bt-set-card' }, ...entries.map(([provider, entry]) => h('div', {
      key: provider, className: 'bt-set-row bt-bs-row bt-bs-stack',
    },
    h('strong', null, CLI_NAMES[provider]),
    h('span', null, t('Bots: {account}', {
      account: entry.signedIn ? botAccountName(entry.account)
        : t('Sign in again in the app to resume Bots'),
    })),
    h('span', { className: 'bt-set-hint' }, t('Terminal: {account}', {
      account: entry.terminal ? botAccountName(entry.terminal) : t('Account not shown by the CLI'),
    })),
    entry.recoveryRequired ? h('p', { role: 'alert' }, t(ACCOUNT_RECOVERY_HINT)) : null,
    pending?.provider === provider ? h('div', null,
      h('p', null, t('This stops running Bot work for this account. Continue?')),
      ['reset', 'recover'].includes(pending.action) ? h('div', null,
        h('p', null, t('This signs {vendor} out for Bots. Sign in again in the app.', {
          vendor: CLI_NAMES[provider],
        })),
        h('p', null, t('Bot models and history stay.')),
        h('p', null, t('Bot CLI user settings start empty.')),
        h('p', null, t('Previous Bot sign-in files stay separate and are never reused.')),
        h('p', null,
          t('No credentials are copied. Your terminal login stays unchanged.'))) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => void change() }, t('Continue')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => setPending(null) }, t('Cancel')),
      error ? h('p', { role: 'alert' }, error) : null) : h('div', null,
      entry.recoveryRequired ? h('div', null, h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => setPending({ provider, action: 'reset' }),
      }, t('Reset Bot sign-in')), h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => setPending({ provider, action: 'recover' }),
      }, t('Sign in again'))) : h('div', null,
      !entry.signedIn ? h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => actions.openCliLogin(bot.id, provider),
      }, t('Sign in')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => setPending({ provider, action: 'switch' }) },
        t('Switch account')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => setPending({ provider, action: 'signout' }) },
        t('Sign out'))))))))
}
