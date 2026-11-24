// A new Genie: one per git repository, in a color no other Genie wears. genie-dsh answers
// genie-create { folder } with that repository's Genie, the one it has or a new one
// (existed), so picking a repository that has a Genie opens it.
import { createElement as h, useState } from 'react'
import { BotMark, catalogueLookOf } from './mark.js'
import { FolderMenu } from './folder-menu.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { hostText, t } from './i18n.js'

/** The Genie colors no Genie wears yet, from the team view (genie-dsh: genie.colors, genie.taken). */
export const freeGenieColors = genie => (genie?.colors ?? []).filter(color => !(genie?.taken ?? []).includes(color))

export function NewGenie({ roster, actions, onBack, onCreated }) {
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const free = freeGenieColors(roster.genie)
  const full = (roster.genie?.colors ?? []).length > 0 && free.length === 0
  const run = promise => Promise.resolve(promise).catch(failure => setError(failure?.message ?? String(failure)))
  const create = async () => {
    if (busy || folder === '' || full) return
    setBusy(true)
    setError('')
    try {
      const reply = await actions.createGenie(folder)
      onCreated(reply.bot)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }
  const preview = { id: 'new-genie', kind: 'genie', name: 'Genie', color: free[0] }
  return h('div', { className: 'bt-create', role: 'dialog', 'aria-label': t('New Genie') },
    h('div', { className: 'bt-create-head' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to new chat'), onClick: onBack }, h(ChevronLeftIcon)),
      h('span', { className: 'bt-create-title' }, t('New Genie')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeOverlay() }, h(CloseIcon))),
    h('div', { className: 'bt-create-body' },
      h('div', { className: 'bt-create-card' },
        h('div', { className: 'bt-create-preview' },
          h('span', { className: 'bt-create-pop' }, h(BotMark, { bot: preview, look: catalogueLookOf(preview), size: 88, live: true, gaze: true, pokeable: true }))),
        h('div', { className: 'bt-field' },
          h('span', { className: 'bt-field-label' }, t('Repository')),
          h(FolderMenu, { value: folder || undefined, team: true, actions, run, onPick: path => { setError(''); setFolder(path) }, wide: true }),
          h('span', { className: 'bt-note' }, full
            ? t('Every Genie color is taken. Remove a Genie to add another.')
            : t('Each repository has one Genie, in its own color. A repository that has one opens it.'))),
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, hostText(error)) : null,
        h('div', { className: 'bt-create-foot' },
          h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, t('Back')),
          h('button', { type: 'button', className: 'bt-send bt-create-go', disabled: busy || folder === '' || full, onClick: () => void create() }, busy ? t('Creating…') : t('Create'))))))
}
