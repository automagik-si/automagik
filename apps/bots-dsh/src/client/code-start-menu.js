// New › Start an existing Bot (RFC 0030 delivery 6a): the Code tree's explicit start control. It
// lives in the main bundle, beside the store and the anchored menu it uses; the Code side's chunk
// only places the two elements (code-side-pane.js). A row click stays read-only: only this menu
// starts anything, and only a not-running Bot of this computer's projects.
//
// Global Bots and Bots the project's Herdr team file does not list are shown, disabled, with
// their reason: the CLI has no start path for them yet (RFC 0014). The host decides again when a
// start runs (src/host/code-start.js).
import { createElement as h, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.js'
import { useAnchoredMenu } from './model-menu.js'
import { startChoices, startOutcomeText } from './code-start-model.js'

export { startChoices, startOutcomeText }

/** The New control: a `.cs-btn` and its menu. */
export function CodeStartMenu({ current, startBot }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu({ minWidth: 260 })
  const busy = current.start?.busy === true
  const groups = startChoices(current.tree)
  const pick = (bot) => {
    close()
    void startBot(bot)
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'cs-btn', 'aria-haspopup': 'menu', 'aria-expanded': isOpen,
      disabled: busy || !current.tree?.machine, onClick: () => (isOpen ? close() : open()),
    }, t('New')),
    shownPlace ? createPortal(h('div', {
      ref: menu, className: `bt-menu bt-model-menu cs-start-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu', 'aria-label': t('Start an existing Bot'), style: shownPlace, 'data-leaving': leaving || undefined,
    },
    h('div', { className: 'bt-menu-sub-head' }, t('Start an existing Bot')),
    groups.length === 0 ? h('div', { className: 'bt-model-none' }, t('Every Bot on this computer is running.')) : null,
    // The model menu's step: its rows, groups and unavailable look.
    groups.map(group => h('div', { key: group.key, className: 'bt-model-step', role: 'group', 'aria-label': group.global ? t('Global Bots') : group.name ?? group.folder },
      h('div', { className: 'bt-model-group', role: 'presentation', title: group.folder ?? undefined }, group.global ? t('Global Bots') : group.name ?? group.folder),
      group.launch ? h('div', { className: 'bt-folder-path bt-folder-here', role: 'presentation', title: group.launch }, t('Starts in {folder}', { folder: group.launch })) : null,
      group.bots.map(bot => h('button', {
        key: bot.id, type: 'button', role: 'menuitem', disabled: busy || bot.blocked !== null,
        'aria-disabled': busy || bot.blocked !== null ? 'true' : undefined,
        'data-unavailable': bot.blocked !== null ? '' : undefined,
        onClick: () => { if (!busy && bot.blocked === null) pick(bot) },
      },
      h('span', { className: 'bt-folder-copy' },
        h('span', { className: 'bt-menu-label' }, bot.name),
        bot.blocked ? h('span', { className: 'bt-folder-path', 'data-wrap': '' }, startOutcomeText(bot.blocked, bot.name)) : null)))))), document.body) : null)
}

/** The last start's line: what is running now, or how it ended. */
export function CodeStartStatus({ current, className = 'cs-count' }) {
  const start = current.start
  if (!start) return null
  const text = start.outcome ? startOutcomeText(start.outcome, start.name) : start.busy ? t('Starting {name}…', { name: start.name }) : null
  return text ? h('span', { className, role: 'status' }, text) : null
}
