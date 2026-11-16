// The show_settings card: one page of the team's Settings, inside the chat. It draws the
// same page the Settings dialog draws (SettingsPage), from the live roster, and saves
// through the same actions, so there is no second way to change a setting and the card
// shows today's values whenever it is opened. The Bot only opens the page: every change
// on it is the user's own click, which is how a Bot can show a setting only the user may
// change (the tools a Bot is denied, who may send) without being able to change it.
import { createElement as h, useState } from 'react'
import { CellEmpty } from './cell-empty.js'
import { ChevronRightIcon, PlugIcon } from './icons.js'
import { t } from './i18n.js'
import { SETTINGS_PAGES } from '../shared/settings-pages.js'

// The Settings pages, registered by index.js (as canvas-slot.js is), so the chat cells load
// without the whole Settings dialog. Without them (tests, a window before the client is
// installed) the card still opens the page in Settings.
let pages = null
export const setSettingsPages = (value) => {
  pages = value
  return () => { if (pages === value) pages = null }
}

// The host's answer to a show_settings call it accepted; anything else is a refusal.
export const SHOWN = /^Showing Settings\b/

const normalize = text => String(text ?? '').trim().toLowerCase().replace(/^@/, '')
const findBot = (roster, ref) => (ref ? roster.byId?.[ref] ?? roster.bots?.find(bot => normalize(bot.name) === normalize(ref)) : undefined)
const findRoom = (roster, ref) => (ref ? roster.roomsById?.[ref] ?? roster.rooms?.find(room => normalize(room.name) === normalize(ref)) : undefined)

// What the card opens: the page, the Bot or group it is about, and its title.
export function settingsTarget({ page, bot: botRef, group: groupRef }, roster, plugins = []) {
  const pluginPage = typeof page === 'string' && page.startsWith('plugin:') ? plugins.find(section => `plugin:${section.id}` === page) : undefined
  const own = SETTINGS_PAGES.find(([key]) => key === page)
  const known = own !== undefined || pluginPage !== undefined || page === 'hermes-remote'
  // A Bot or group named on its page opens its own form; on Scheduled tasks or Usage, its view.
  const bot = page === 'bots' ? findBot(roster, botRef) : undefined
  const room = page === 'groups' ? findRoom(roster, groupRef) : undefined
  const focusBot = page === 'schedules' || page === 'usage' ? findBot(roster, botRef) : undefined
  const id = bot?.id ?? room?.id ?? (focusBot ? (page === 'usage' ? `bot:${focusBot.id}` : focusBot.id) : null)
  const label = pluginPage ? pluginPage.label : page === 'hermes-remote' ? t('Remote Hermes') : own ? t(own[1]) : String(page ?? '')
  const title = bot?.name ?? room?.name ?? (focusBot ? `${label} · ${focusBot.name}` : label)
  return { known, page, id, bot, room, pluginPage, label, title }
}

const run = setError => promise => Promise.resolve(promise)
  .then(() => { setError(''); return true })
  .catch(failure => { setError(failure?.message ?? String(failure)); return false })

export function SettingsCard({ target, note, roster, actions, useUpdate, startOpen = false }) {
  const [open, setOpen] = useState(startOpen)
  const [error, setError] = useState('')
  const Icon = pages?.PAGE_ICONS[target.page] ?? PlugIcon
  const openInSettings = () => actions.openSettings?.(target.page, target.id)
  return h('section', { className: 'bt-setcard', 'data-open': open || undefined, 'aria-label': t('Settings: {title}', { title: target.title }) },
    h('div', { className: 'bt-setcard-head' },
      h('button', { type: 'button', className: 'bt-setcard-toggle', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
        h('span', { className: 'bt-setcard-icon', 'aria-hidden': true }, h(Icon)),
        h('span', { className: 'bt-setcard-text' },
          h('span', { className: 'bt-setcard-kicker' }, t('Settings')),
          h('span', { className: 'bt-setcard-title' }, target.title),
          note ? h('span', { className: 'bt-setcard-note' }, note) : null),
        h('span', { className: 'bt-setcard-chev', 'aria-hidden': true }, h(ChevronRightIcon))),
      actions.openSettings ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: openInSettings }, t('Open in Settings')) : null),
    open
      ? h('div', { className: 'bt-setcard-body bt-settings-page' },
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
        target.known && pages !== null
          ? h(pages.PageBoundary, null, h(pages.SettingsPage, {
            shown: target.page, id: target.id, bot: target.bot, room: target.room, pluginPage: target.pluginPage,
            roster, actions, run: run(setError), useUpdate: useUpdate ?? (() => undefined), close: () => setOpen(false),
          }))
          : h('p', { className: 'bt-setcard-missing' }, t('This page is not in this window\'s Settings.')))
      : null)
}

// The show_settings call in the transcript: drawn once the host accepted it.
export function SettingsCall({ args, done, content, isError, roster, actions }) {
  if (!done || isError || !SHOWN.test(content ?? '')) return h(CellEmpty)
  const target = settingsTarget({ page: args.text('page'), bot: args.text('bot'), group: args.text('group') }, roster, actions.pluginSettings?.() ?? [])
  return h('div', { className: 'bt-q-inline' }, h(SettingsCard, { target, note: args.text('note'), roster, actions }))
}

export const SETTINGS_CARD_CSS = `
.bt-setcard{width:100%;max-width:640px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card,var(--bt-bg));overflow:hidden}
.bt-setcard-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 6px}
.bt-setcard-toggle{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:2px 4px;border-radius:10px}
.bt-setcard-toggle:focus-visible{outline:2px solid var(--bt-accent)}
.bt-setcard-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink-2);flex:none}
.bt-setcard-text{display:flex;flex-direction:column;min-width:0}
.bt-setcard-kicker{font-size:11px;color:var(--bt-ink-3)}
.bt-setcard-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-setcard-note{font-size:12px;color:var(--bt-ink-2)}
.bt-setcard-chev{margin-left:auto;color:var(--bt-ink-3);transition:transform .15s}
.bt-setcard[data-open] .bt-setcard-chev{transform:rotate(90deg)}
.bt-setcard-body{border-top:1px solid var(--bt-line);padding:12px 14px;max-height:480px;overflow:auto}
.bt-setcard-missing{margin:0;color:var(--bt-ink-2)}
`
