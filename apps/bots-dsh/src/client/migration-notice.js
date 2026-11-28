import { createElement as h, useRef, useState } from 'react'
import { call } from './api.js'
import { hostText, t } from './i18n.js'

const isText = value => typeof value === 'string' && value.trim() !== ''
const namedBot = bot => isText(bot?.id) && isText(bot.name)

// Owner state can advertise migrationNotices: [{ id, reason, affected: [{ id, name,
// capabilities?: string[] }], action?: { kind: 'role-settings', botId } }] and
// chiefRecovery: { reason, choices: [{ id, name }] }. Reasons are host display text.
// Only the current recovery choices authorize offering the existing set-chief route.
function migrationView(roster, owner) {
  if (!owner || roster?.ready !== true) return { notices: [] }
  const notices = Array.isArray(roster.migrationNotices)
    ? roster.migrationNotices.filter(notice => isText(notice?.id) && isText(notice.reason)) : []
  const recovery = isText(roster.chiefRecovery?.reason) ? roster.chiefRecovery : undefined
  const choices = Array.isArray(recovery?.choices) ? recovery.choices.filter(namedBot) : []
  return { notices, recovery, choices, readOnly: roster.readOnly }
}

function MigrationNotice({ notice, openRoleSettings }) {
  const affected = Array.isArray(notice.affected) ? notice.affected.filter(namedBot) : []
  const target = notice.action?.kind === 'role-settings' && affected.find(bot => bot.id === notice.action.botId)
  return h('section', { className: 'bt-migration-card', 'aria-label': t('Bot team update') },
    h('p', null, hostText(notice.reason)),
    affected.length === 0 ? null : h('ul', null, affected.map(bot => {
      const capabilities = Array.isArray(bot.capabilities) ? bot.capabilities.filter(isText).map(hostText) : []
      return h('li', { key: bot.id }, capabilities.length === 0 ? bot.name
        : t('{bot} · {capabilities}', { bot: bot.name, capabilities: capabilities.join(', ') }))
    })),
    target ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openRoleSettings(notice.id, target.id) },
      t('Open Role settings for {name}', { name: target.name })) : null)
}

function ChiefRecovery({ recovery, choices, readOnly, setChief }) {
  const [selected, select] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const id = choices.some(bot => bot.id === selected) ? selected : ''
  const submit = async event => {
    event.preventDefault()
    if (!id || readOnly || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      await setChief(id)
    } catch (failure) {
      setError(failure?.message || t('Could not save the chief of staff.'))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return h('section', { className: 'bt-migration-card', 'aria-label': t('Choose the chief of staff again') },
    h('strong', { role: 'status' }, t('Choose the chief of staff again')),
    h('p', null, hostText(recovery.reason)),
    isText(readOnly) ? h('p', null, hostText(readOnly)) : null,
    choices.length === 0 ? null : h('form', { onSubmit: submit },
      h('select', {
        className: 'bt-select', 'aria-label': t('Chief of staff'), value: id,
        disabled: pending || Boolean(readOnly), onChange: event => select(event.target.value),
      }, h('option', { value: '' }, t('Choose a Bot…')), choices.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: pending || Boolean(readOnly) || !id }, t('Save chief of staff'))),
    error ? h('p', { role: 'alert' }, error) : null)
}

export function migrationFace({ actions, roster, gated, mountedViewer, after }) {
  return {
    actions, hooks: { roster }, readRoster: roster.getSnapshot,
    isOwner: () => !gated || ['owner', 'admin'].includes(mountedViewer()?.role),
    after,
  }
}

export function MigrationNotices({ useRoster, readRoster, isOwner, after, actions }) {
  const roster = useRoster(value => value)
  const { notices, recovery, choices, readOnly } = migrationView(roster, isOwner())
  if (notices.length === 0 && recovery === undefined) return null
  const current = () => migrationView(readRoster(), isOwner())
  return h('div', { className: 'bt-migration' },
    recovery === undefined ? null : h(ChiefRecovery, { recovery, choices, readOnly, setChief: async id => {
      const next = current()
      if (next.readOnly || !next.choices?.some(bot => bot.id === id)) throw new Error(t('The recovery choices changed. Choose a Bot again.'))
      await after(call('set-chief', { id }))
    } }),
    notices.map(notice => h(MigrationNotice, { key: notice.id, notice, openRoleSettings: (id, botId) => {
      const action = current().notices.find(entry => entry.id === id)?.action
      if (action?.kind === 'role-settings' && action.botId === botId) actions.openSettings('bots', botId)
    } })))
}

export const MIGRATION_NOTICE_CSS = `
.bt-migration{position:fixed;inset-inline-end:16px;--bt-migration-top:calc(max(72px,var(--dsh-frame-overlay-top,0px)) + env(safe-area-inset-top,0px));top:var(--bt-migration-top);z-index:40;display:grid;gap:8px;width:min(340px,calc(100vw - 32px));max-height:calc(100dvh - var(--bt-migration-top) - 16px - env(safe-area-inset-bottom,0px));overflow:auto}
.bt-migration-card{display:grid;gap:8px;padding:12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);font-size:13px;overflow-wrap:anywhere}
.bt-migration-card p,.bt-migration-card ul{margin:0}
.bt-migration-card ul{padding-inline-start:20px}
.bt-migration-card form{display:grid;gap:8px}
.bt-migration-card button{justify-self:start}
.bt-migration-card [role=alert]{color:var(--st-bad-strong,var(--bt-danger))}
`
