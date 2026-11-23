import { createElement as h } from 'react'
import { isMainOf } from './sources.js'
import { t } from './i18n.js'

// What a Bot can be asked for, as small pills in its sidebar row and on its profile (#318),
// always in this order. A Bot shows only the pills it has.
// - Computer: DSH's shell and file tools. Every Bot's Session has them, except a Bot that
//   operates a linked Omni (the host's omniLinked): the channels plugin takes them away from
//   every Main Bot and from the Omni Bot (omni-channels-dsh grants.js operatesHere).
// - Channels: that same Bot, which works in the user's Omni channels.
// - Leads the team: a Main Bot (mainBotIds).
export function pillsOf(roster, bot) {
  if (bot === undefined || bot === null) return []
  const leads = isMainOf(roster, bot.id)
  const operates = roster.omniLinked === true && (leads || bot.kind === 'omni')
  return [!operates && 'computer', operates && 'channels', leads && 'leads'].filter(Boolean)
}

// The pill's label and its tooltip, which says what to ask that Bot for.
const pillText = key => (key === 'computer'
  ? [t('Computer'), t('Has a computer: ask it for code, files and commands.')]
  : key === 'channels'
    ? [t('Channels'), t('Works in your Omni channels: ask it to read, send or answer messages there.')]
    : [t('Leads the team'), t('Leads the team: ask it to plan work, make Bots and hand tasks to the right one.')])

export const pillLabels = (roster, bot) => pillsOf(roster, bot).map(key => pillText(key)[0])

export function BotPills({ roster, bot, className = '' }) {
  const keys = pillsOf(roster, bot)
  if (keys.length === 0) return null
  return h('span', { className: `bt-caps ${className}`.trim() }, keys.map((key) => {
    const [label, tip] = pillText(key)
    return h('span', { key, className: 'bt-tag bt-cap', 'data-pill': key, title: tip }, label)
  }))
}
