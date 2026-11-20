// Account controls stay in the owner's Bot settings, never in team state or a transcript.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { CLI_NAMES } from './cli-login-model.js'
import {
  ACCOUNT_RECOVERY_CODE, ACCOUNT_RECOVERY_HINT, ACCOUNT_SHARING_HINT, accountChangeFailure,
} from '../shared/cli-account.js'
import { reservationMessage } from '../shared/account-reservations.js'
import { t } from './i18n.js'

const botAccountName = account => account?.email ?? account?.org ?? t('Account not shown by the CLI')
const consented = entry => entry.consent === 'given' || entry.consent === 'carried'
const button = (label, onClick, disabled) => h('button', {
  type: 'button', className: 'bt-soft bt-soft-sm', onClick, disabled,
}, t(label))

function Reservation({ provider, reservation, actions, refresh, updated }) {
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const offerId = reservation.offer?.offerId
  useEffect(() => {
    setForm(current => current?.offerId === offerId ? current : null)
  }, [offerId])
  const active = offerId !== undefined && form?.offerId === offerId ? form : null
  const edit = claim => {
    setProblem(null)
    setForm({ offerId, label: claim?.label ?? '',
      ...(claim ? { claimId: claim.claimId, rev: claim.rev } : {}) })
  }
  const change = async action => {
    setBusy(true)
    setProblem(null)
    try {
      updated(await action())
      setForm(null)
      await refresh().catch(() => {})
    } catch (error) {
      setProblem(error?.message || t('The reservation could not be saved. Try again.'))
      if (error?.code !== 'bot/invalid') await refresh().catch(() => {})
    } finally { setBusy(false) }
  }
  function submit() {
    if (!active || busy) return
    const { offerId, label, claimId, rev } = active
    void change(() => claimId === undefined ? actions.cliLoginReserve(offerId, label)
      : actions.cliLoginReserve(offerId, label, { claimId, rev }))
  }

  const { state, claims } = reservation
  const line = reservationMessage(reservation)
  const hasCurrent = claims.some(claim => claim.current)
  return h('div', null,
    ...claims.map(claim => h('div', { key: claim.claimId },
      h('span', null, t(!claim.mine ? 'Reserved by another installation: {label}.'
        : claim.current ? 'Reserved for {label}. This holds in this installation only for now; other installations are not checked yet.'
          : state === 'complete' ? 'Also reserved here: {label} (another {vendor} account).'
            : 'Reserved here: {label}.', { label: claim.label, vendor: CLI_NAMES[provider] })),
      claim.mine && claim.current && offerId
        ? button('Rename', () => edit(claim), busy || active !== null) : null,
      claim.mine ? button('Make shared',
        () => void change(() => actions.cliLoginRelease(claim.claimId, claim.rev)), busy || active !== null) : null)),
    line ? h('span', { className: 'bt-set-hint' }, t(line)) : null,
    !hasCurrent && offerId
      ? h('span', null, t('Shared with other instances (default).')) : null,
    !hasCurrent && !active
      ? h('div', null, button('Reserve for a project', () => edit(), busy || !offerId)) : null,
    active ? h('div', null,
      h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Project name')),
        h('input', { className: 'bt-input', autoFocus: true, value: active.label,
          maxLength: 120, disabled: busy,
          onChange: event => setForm({ ...active, label: event.target.value }),
          onKeyDown: event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          },
        })),
      h('p', { className: 'bt-set-hint' },
        t("The record keeps no email: only keyed digests. Anyone who can read this team's files and the key could test a guessed email.")),
      button('Continue', submit, busy),
      button('Cancel', () => { setForm(null); setProblem(null) }, busy)) : null,
    problem ? h('p', { role: 'alert' }, problem) : null)

}

export function CliAccounts({ bot, actions }) {
  const [accounts, setAccounts] = useState({})
  const [installation, setInstallation] = useState(undefined)
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const latest = useRef(0)
  const refresh = async (alive = () => true) => {
    const request = ++latest.current
    const value = await actions.cliLoginAccounts?.({ reservations: true })
    if (latest.current !== request || !alive()) return
    setAccounts(value?.accounts ?? {})
    setInstallation(value?.installation)
  }
  const updated = (provider, reservation) => {
    latest.current++
    setAccounts(current => current[provider] === undefined ? current
      : { ...current, [provider]: { ...current[provider], reservation } })
  }
  useEffect(() => {
    let alive = true
    void refresh(() => alive).catch(() => {})
    return () => { alive = false }
  }, [bot.id, actions])
  useEffect(() => {
    // Refresh after an in-chat sign-in finishes, without polling either account in the UI.
    let alive = true
    const off = actions.cliLogin?.subscribe(() => {
      const rows = Object.values(actions.cliLogin.getSnapshot().rows)
      if (!rows.some(row => row.stage === 'done')) return
      void refresh(() => alive).catch(() => {})
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
          ...(current[provider]?.reservation ? { reservation: {
            state: 'recovery', claims: current[provider].reservation.claims.map(claim => ({ ...claim, current: false })),
          } } : {}),
        } }))
        setPending(null)
      } else setError(accountChangeFailure(error) ?? t('Account change failed. Close other app windows and try again.'))
    } finally { setBusy(false) }
  }
  const entries = Object.entries(accounts).filter(([id, entry]) => (
    Object.hasOwn(CLI_NAMES, id) && (entry.authScope === 'isolated' || consented(entry))
  ))
  if (!entries.length) return null
  const isolated = entries.some(([, entry]) => entry.authScope === 'isolated')
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Bot accounts')),
    installation ? h('p', { className: 'bt-set-hint' },
      t('This installation: {installation}', { installation })) : null,
    h('p', { className: 'bt-set-hint' }, t('Bots in this installation share these accounts.')),
    isolated ? h('p', { className: 'bt-set-hint' }, t(ACCOUNT_SHARING_HINT)) : null,
    isolated ? h('p', { className: 'bt-set-hint' },
      t('Your terminal login is separate and stays unchanged.')) : null,
    h('div', { className: 'bt-set-card' }, ...entries.map(([provider, entry]) => h('div', {
      key: provider, className: 'bt-set-row bt-bs-row bt-bs-stack',
    },
    h('strong', null, CLI_NAMES[provider]),
    h('span', null, t('Bots: {account}', {
      account: entry.signedIn || consented(entry) ? botAccountName(entry.account)
        : t('Sign in again in the app to resume Bots'),
    })),
    entry.reservation?.scope === 'personal' ? h('span', { className: 'bt-set-hint' }, t('Personal plan'))
      : entry.reservation?.scope === 'workspace' ? h('span', { className: 'bt-set-hint' },
        t('Workspace plan: covers every ChatGPT workspace of this email')) : null,
    entry.reservation || consented(entry) ? h(Reservation, {
      provider, reservation: entry.reservation ?? { state: 'unsupported', claims: [] }, actions, refresh,
      updated: reservation => updated(provider, reservation),
    }) : null,
    entry.authScope === 'isolated' ? h('span', { className: 'bt-set-hint' }, t('Terminal: {account}', {
      account: entry.terminal ? botAccountName(entry.terminal) : t('Account not shown by the CLI'),
    })) : null,
    entry.recoveryRequired ? h('p', { role: 'alert' }, t(ACCOUNT_RECOVERY_HINT)) : null,
    entry.authScope !== 'isolated' ? null : pending?.provider === provider ? h('div', null,
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
