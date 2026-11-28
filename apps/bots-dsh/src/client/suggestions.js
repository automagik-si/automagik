import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { chatSuggestions, useEntries } from './extend.js'
import * as icons from './icons.js'
import { HEADER } from './text.js'
import { t } from './i18n.js'
import { roleContributions, roleContributionVisible } from './team-actions.js'

// -------------------------------------------------------------------------
// What an empty chat offers: up to three chips above the composer, each filling it with a
// start the person finishes ("Draw an image of "), instead of a panel opening by itself. They
// show in a Bot's own chat until the person first writes there, and while the composer is
// empty; other plugins add their own (extend.js chatSuggestions), which come first. The
// team's: draw an image (when something draws them here), search the web, set a reminder.

export const MAX_SUGGESTIONS = 3

// Whether something draws images here, asked again after a minute: a ChatGPT sign-in or an
// OpenAI key added meanwhile shows the chip without a restart.
const IMAGE_ACCESS_TTL_MS = 60_000
let imagesReady
let imagesAsked = 0
export function imageAccess(now = Date.now()) {
  if (!imagesReady || now - imagesAsked > IMAGE_ACCESS_TTL_MS) {
    imagesAsked = now
    imagesReady = call('image-access').then(access => access !== null, () => false)
  }
  return imagesReady
}

// The team's own, for every Bot.
const teamItems = ({ images }) => [
  ...(images ? [{ id: 'image', label: t('Draw an image'), text: t('Draw an image of '), icon: 'ImageIcon' }] : []),
  { id: 'search', label: t('Search the web'), text: t('Search the web for '), icon: 'SearchIcon' },
  { id: 'remind', label: t('Set a reminder'), text: t('Every weekday at 9am, remind me to '), icon: 'ClockIcon' },
]

/**
 * Whether the person has written in a chat yet, from its turn outline: a turn the team started
 * (a greeting, a setup note, a message from another Bot) carries a header, and a hidden turn
 * (one Bot answering another) does not count.
 */
export function personWrote(outline, hiddenTurns = []) {
  if (!Array.isArray(outline)) return false
  return outline.some(entry => !hiddenTurns.includes(entry.turn) && typeof entry.prompt === 'string' && entry.prompt.trim() !== '' && !HEADER.test(entry.prompt))
}

/** The chips for a Bot: the plugins' first, then the team's, three at most. */
export function suggestionsFor(entries, context, definitions) {
  const items = []
  for (const entry of entries) {
    if (!roleContributionVisible('suggestions', entry.id, context.bot, context.roster, definitions)) continue
    try {
      if (entry.when && !entry.when(context)) continue
      for (const item of entry.items(context) ?? []) if (item?.label && item?.text) items.push({ ...item, key: `${entry.id}:${item.id ?? item.label}` })
    } catch { /* a plugin's suggestions that fail are left out */ }
  }
  return [...items, ...teamItems(context).map(item => ({ ...item, key: `team:${item.id}` }))].slice(0, MAX_SUGGESTIONS)
}

// The composer's text box gets the start, with the caret after it, as if typed.
function fillComposer(text) {
  const box = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true]')
  if (!(box instanceof HTMLElement)) return
  box.focus()
  const selection = window.getSelection()
  selection?.selectAllChildren(box)
  document.execCommand('insertText', false, text)
  selection?.collapseToEnd()
}

export function SuggestionDock({ sessionId, input, session, useRoster, useSessions }) {
  const roster = useRoster(value => value)
  // A Bot's own chat only (the Session shown is one of its parts), not a group or a task.
  const bot = roster?.byId?.[sessionId]
  const part = sessionId
  const outline = list => list.projectionsBySession?.[part]?.values?.turnOutline ?? list.byId?.[part]?.projectionValues?.turnOutline
  const wrote = useSessions ? useSessions(list => personWrote(outline(list), roster?.exchangeTurns?.[part] ?? [])) : true
  const entries = useEntries(chatSuggestions)
  const definitions = useEntries(roleContributions)
  const [images, setImages] = useState(false)
  // Asked when the chat opens, so a chat opened after signing in offers drawing.
  useEffect(() => { void imageAccess().then(setImages) }, [sessionId])
  if (!bot || wrote || session?.running || (input?.draft ?? '').trim() !== '') return null
  const items = suggestionsFor(entries, { bot, roster, images }, definitions)
  if (items.length === 0) return null
  return h('div', { className: 'bt-suggest', role: 'group', 'aria-label': t('Suggestions') },
    items.map(item => h('button', { key: item.key, type: 'button', className: 'bt-suggest-chip', onClick: () => fillComposer(item.text) },
      icons[item.icon] ? h('span', { className: 'bt-suggest-icon', 'aria-hidden': true }, h(icons[item.icon])) : null,
      h('span', null, item.label))))
}

export const SUGGEST_CSS = `
.bt-suggest{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;padding:0 4px 10px}
.bt-suggest-chip{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:6px 14px 6px 11px;border:1px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink);font:500 13px/18px var(--bt-font);cursor:pointer;box-shadow:0 1px 0 var(--bt-line);transition:background .12s ease,border-color .12s ease,transform .12s ease;animation:bt-suggest-in .28s ease both}
.bt-suggest-chip:nth-child(2){animation-delay:.05s}
.bt-suggest-chip:nth-child(3){animation-delay:.1s}
.bt-suggest-chip:hover{border-color:color-mix(in srgb,var(--bt-accent) 45%,var(--bt-line-2));background:color-mix(in srgb,var(--bt-accent) 6%,var(--bt-card));transform:translateY(-1px)}
.bt-suggest-icon{display:inline-flex;color:var(--bt-accent)}
@keyframes bt-suggest-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.bt-suggest-chip{animation:none}}
`
