import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { hostText, t } from './i18n.js'
import { useEscape } from './overlay-hooks.js'

export function grantLabel({ taskId, roomId }) {
  if (taskId !== undefined) return t('Allow this step for this task')
  if (roomId !== undefined) return t('Allow this step in this group')
  return t('Allow this step for this chat')
}

export function GrantConfirm({ card, busy, onConfirm, onCancel }) {
  const cancel = useRef(null)
  useEffect(() => { cancel.current?.focus() }, [])
  useEscape(() => { if (!busy) onCancel() })
  const until = card.taskId !== undefined ? t('Until this task ends or you stop allowing it.')
    : card.roomId !== undefined ? t('Until this group session ends or you stop allowing it.')
      : t('Until this chat part ends or you stop allowing it.')
  return h('div', {
    className: 'bt-apr', role: 'dialog', 'aria-label': grantLabel(card),
    'aria-busy': busy || undefined,
  },
  h('div', { className: 'bt-apr-title' }, grantLabel(card)),
  h('div', { className: 'bt-apr-note' }, t('Where: {place}', { place: card.place })),
  h('div', { className: 'bt-apr-quote' }, card.shownTarget),
  h('div', { className: 'bt-apr-quote' }, t('Folder: {folder}', { folder: card.folder })),
  card.reason ? h('div', { className: 'bt-apr-quote' }, hostText(card.reason)) : null,
  card.sandboxMode === undefined ? null : h('div', { className: 'bt-apr-note' },
    t('Sandbox: {mode}', { mode: card.sandboxMode })),
  h('p', { className: 'bt-apr-note' }, until),
  h('p', { className: 'bt-apr-note' }, t(
    'Files this step changes can make the same command do something else next time.',
  )),
  h('div', { className: 'bt-apr-actions' },
    h('button', { type: 'button', ref: cancel, className: 'bt-q-btn', disabled: busy,
      onClick: onCancel }, t('Cancel')),
    h('button', { type: 'button', className: 'bt-q-submit', disabled: busy,
      onClick: onConfirm }, t('Go'))))
}

export function GrantAction({ approval, place, actions, disabled, className = 'bt-q-btn' }) {
  const [card, setCard] = useState()
  const [busy, setBusy] = useState(false)
  const button = useRef(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!card && restoreFocus.current) {
      restoreFocus.current = false
      button.current?.focus()
    }
  }, [card])

  function open() {
    const { id, offer, roomId, taskId, shownTarget, reason, sandboxMode, folder } = approval
    setCard(Object.freeze({ id, offer, place, roomId, taskId, shownTarget, reason,
      sandboxMode, folder }))
  }
  function close() {
    restoreFocus.current = true
    setCard(undefined)
  }
  async function confirm() {
    if (busy) return
    setBusy(true)
    try {
      const result = await actions.grantApproval(card.id, card.offer)
      if (result?.allowedOnce) actions.showNotice?.(t('Allowed once'))
    } catch (error) {
      actions.reportError?.(error, 'approval')
    } finally {
      setBusy(false)
      close()
    }
  }

  if (card) return h(GrantConfirm, { card, busy, onConfirm: confirm, onCancel: close })
  if (!approval?.grantable || !approval.answerable || typeof approval.offer !== 'string'
    || typeof actions?.grantApproval !== 'function') return null
  return h('button', {
    type: 'button', className, ref: button, disabled, onClick: open,
    title: t('Where: {place}', { place }),
  }, grantLabel(approval))
}

function grantPlace({ owner }, roster) {
  if (owner.kind === 'task') return roster.tasks?.[owner.id]?.title ?? t('Task')
  if (owner.kind === 'group') return roster.roomsById?.[owner.roomId]?.name ?? t('Group')
  return t('in its own chat')
}

function GrantRow({ grant, roster, actions }) {
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    setBusy(true)
    try { await actions.revokeGrant(grant.id) }
    catch (error) { actions.reportError?.(error, 'approval') }
    finally { setBusy(false) }
  }
  return h('div', { className: 'bt-drawer-model' },
    h('div', { className: 'bt-kv' },
      h('span', null, grant.tool, ' · ', grantPlace(grant, roster)),
      h('span', null, t('{count} uses', { count: grant.uses }))),
    h('div', { className: 'bt-apr-quote' }, grant.target),
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn',
        disabled: busy || roster.readOnly || typeof actions.revokeGrant !== 'function',
        onClick: stop }, t('Stop allowing'))))
}

export function GrantList({ bot, roster, actions, useWork }) {
  const work = useWork?.(value => value)
  const grants = (work?.grants ?? []).filter(grant => grant.botId === bot.id)
  if (grants.length === 0) return null
  return h(Fragment, null,
    h('div', { className: 'bt-section-title' }, t('Allowed for now')),
    grants.map(grant => h(GrantRow, { key: grant.id, grant, roster, actions })))
}
