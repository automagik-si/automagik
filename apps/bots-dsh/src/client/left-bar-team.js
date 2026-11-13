import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BotMark, lookOf, petOf, useBaked } from './mark.js'
import { PetSprite } from './pet.js'
import { BODY, CELL, FLOOR } from './pet-poses.js'
import { t } from './i18n.js'
import { QUIET, Status, WORDED, stateOfStatus, statusOr, word, worstStatus } from './left-bar-status.js'

// -------------------------------------------------------------------------
// The Team side of the new left bar (direction C): the project's Bots, the channels and chats
// under a Bot, then the group chats. One line per row: the art, the name, one status mark. No
// crown, no role chip, no tags, no preview line.
//
// A team, as the bar reads it:
//   bots      [{ id, name, status, unread, channels, ...the Bot's own look fields }]
//             status is one of left-bar-status.js STATUSES; channels hang under their Bot:
//             [{ id, name, kind, folded, chats: [{ id, name, status }] }]
//   frontId   the project's front Bot: shown first, above every section
//   sections  [{ label, bots: [id] }], optional quiet labels (DS Bot ruling 10)
//   groups    [{ id, name, members: [id] }], after the Bots

const chatStatuses = bot => (bot.channels ?? []).flatMap(channel => (channel.chats ?? []).map(chat => statusOr(chat.status)))

// A Bot whose chat already says "needs you" does not say it again on its own row: the chat's
// row, or its folded channel's, is where the owner goes.
export function botRowStatus(bot) {
  const status = statusOr(bot.status)
  return status === 'needs' && chatStatuses(bot).includes('needs') ? 'idle' : status
}

function botRows(bot) {
  const rows = [{ kind: 'bot', key: `bot:${bot.id}`, id: bot.id, name: bot.name, bot, status: botRowStatus(bot), unread: bot.unread === true }]
  for (const channel of bot.channels ?? []) {
    const chats = channel.chats ?? []
    const folded = channel.folded === true
    // A folded channel speaks for its chats; an open one leaves it to their rows.
    rows.push({ kind: 'channel', key: `channel:${bot.id}/${channel.id}`, id: channel.id, botId: bot.id, name: channel.name, channel, folded, status: folded ? worstStatus(chats.map(chat => statusOr(chat.status))) : 'idle' })
    if (folded) continue
    for (const chat of chats) rows.push({ kind: 'chat', key: `chat:${bot.id}/${channel.id}/${chat.id}`, id: chat.id, botId: bot.id, channelId: channel.id, name: chat.name, status: statusOr(chat.status) })
  }
  return rows
}

/** The Team list as flat rows, in the order the bar draws them. */
export function teamRows(team) {
  const bots = team?.bots ?? []
  const byId = new Map(bots.map(bot => [bot.id, bot]))
  const sections = (team?.sections ?? []).map(section => ({ label: section.label, bots: (section.bots ?? []).map(id => byId.get(id)).filter(Boolean) })).filter(section => section.bots.length > 0)
  const placed = new Set(sections.flatMap(section => section.bots.map(bot => bot.id)))
  const front = byId.get(team?.frontId)
  // The front Bot, then the Bots no section holds, then each section under its label.
  const loose = bots.filter(bot => bot !== front && !placed.has(bot.id))
  const rows = [...(front ? [front] : []), ...loose].flatMap(botRows)
  sections.forEach((section, index) => {
    const held = section.bots.filter(bot => bot !== front)
    if (held.length === 0) return
    // The first label stands clear of the front Bot above it.
    rows.push({ kind: 'section', key: `section:${index}`, label: section.label, first: !rows.some(row => row.kind === 'section') })
    rows.push(...held.flatMap(botRows))
  })
  ;(team?.groups ?? []).forEach((group, index) => {
    const members = (group.members ?? []).map(id => byId.get(id)).filter(Boolean)
    // Under sections the groups stand a little apart, so they do not read as the last section's.
    rows.push({ kind: 'group', key: `group:${group.id}`, id: group.id, name: group.name, members, lead: index === 0 && rows.some(row => row.kind === 'section') })
  })
  return rows
}

// The art's sizes are tokens (--lb-art and --lb-duo-art, left-bar-css.js), and a Bot's character
// is drawn for a size in pixels: the list measures its first art boxes and draws at those sizes.
const ART = { art: 28, duo: 19 }

function useArtSizes(ref, skin, count) {
  const [sizes, setSizes] = useState(ART)
  useLayoutEffect(() => {
    const width = selector => Math.round(ref.current?.querySelector(selector)?.getBoundingClientRect().width ?? 0)
    const art = width('.lb-art') || ART.art
    const duo = width('.lb-duo-a') || ART.duo
    setSizes(now => (now.art === art && now.duo === duo ? now : { art, duo }))
  }, [skin, count])
  return sizes
}

// Which of the list's two edges has rows under it: `above` once it has moved, `more` while rows
// lie below. The sheet draws each as a scroll edge.
function useScrollEdges(ref, count) {
  const [edges, setEdges] = useState({ above: false, more: false })
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const read = () => {
      const above = node.scrollTop > 1
      const more = node.scrollHeight - node.scrollTop - node.clientHeight > 1
      setEdges(now => (now.above === above && now.more === more ? now : { above, more }))
    }
    read()
    node.addEventListener('scroll', read, { passive: true })
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    watch?.observe(node)
    return () => {
      node.removeEventListener('scroll', read)
      watch?.disconnect()
    }
  }, [count])
  return edges
}

// A character baked into a pet (pet-bake.js) stands in a BODY box on the FLOOR of a taller cell,
// so a pet drawn at the art's size shows its character at about 72% of it. The bar draws such a
// pet larger and lifts it, so the character's own box is the art's box: the box the same
// character fills when it is drawn still. The pet stays on whole pixels. A pet the team
// installed keeps the art's size, since its cell is its own; until a bake is ready, and where
// the browser cannot bake, the character is drawn still at the same size.
const BAKED_FIT = CELL.height / BODY
const BAKED_LIFT = (FLOOR - BODY / 2 - CELL.height / 2) / CELL.height
function BotArt({ bot, size, state }) {
  const wants = petOf(bot, lookOf(bot), { live: true, size })
  const baked = useBaked(wants?.bake)
  if (!wants?.bake) return h(BotMark, { bot, size, state, live: true })
  if (!baked) return h(BotMark, { bot, size, state })
  const margin = Math.round((size * BAKED_FIT - size) / 2)
  const drawn = size + 2 * margin
  return h('span', { className: 'lb-art-pet', style: { left: -margin, top: -margin - Math.round(drawn * BAKED_LIFT) } },
    h('span', { className: 'bt-mark', 'data-shape': 'pet', 'data-state': state, 'data-live': '', 'aria-hidden': true, style: { width: drawn, height: drawn } },
      h(PetSprite, { pet: baked, size: drawn, state, live: true })))
}
const drawBot = (bot, size, state) => h(BotArt, { bot, size, state })
const Chevron = () => h('svg', { className: 'lb-chev', width: 13, height: 13, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M7.5 4.5L13 10l-5.5 5.5' }))
const classes = (...names) => names.filter(Boolean).join(' ')

/**
 * The Team rows. `current` is the open row's key (`bot:<id>`, `chat:<bot>/<channel>/<id>`,
 * `group:<id>`); `onOpen(row)` hears a press on any row, a channel's included (the caller folds
 * it). `renderArt(bot, size, state)` and `renderGlyph(channel)` draw a Bot's character and a
 * channel's glyph; a glyph is one colour, so colour only ever means status. `skin` is the
 * name of the token set in use (left-bar-css.js): when it changes, the art is measured again.
 */
export function TeamRows({ team, current, onOpen, label, skin, renderArt = drawBot, renderGlyph, worded = WORDED, quiet = QUIET }) {
  const ref = useRef(null)
  const rows = teamRows(team)
  const { art, duo } = useArtSizes(ref, skin, rows.length)
  const edges = useScrollEdges(ref, rows.length)
  const press = row => (onOpen ? () => onOpen(row) : undefined)
  const status = row => h(Status, { status: row.status, worded, quiet })
  const button = (row, className, extra, ...children) => h('button', {
    key: row.key, type: 'button', className: classes('lb-row', className), 'data-kind': row.kind, 'data-id': row.id,
    'aria-current': row.key === current ? 'page' : undefined, onClick: press(row), ...extra,
  }, ...children)
  const draw = (row) => {
    if (row.kind === 'section') return h('div', { key: row.key, className: classes('lb-sec', row.first && 'lb-sec-first') }, row.label)
    if (row.kind === 'bot') {
      // The row's own status may be silent (a chat says it); the character still plays the Bot's.
      const state = row.bot.state ?? stateOfStatus(statusOr(row.bot.status))
      return button(row, classes(row.unread && 'lb-row-unread', row.status === 'off' && 'lb-row-off'), null,
        h('span', { className: 'lb-art' }, renderArt(row.bot, art, state)),
        h('span', { className: 'lb-name' }, row.name),
        row.unread ? h('span', { className: 'lb-sr' }, t('Unread activity')) : null,
        status(row))
    }
    if (row.kind === 'channel') {
      return button(row, 'lb-row-channel', { 'aria-expanded': !row.folded },
        h('span', { className: 'lb-glyph', 'aria-hidden': true }, renderGlyph ? renderGlyph(row.channel) : null),
        h('span', { className: 'lb-name' }, row.name),
        row.folded ? status(row) : null,
        row.folded ? h(Chevron) : null)
    }
    if (row.kind === 'chat') {
      return button(row, classes('lb-row-chat', row.status !== 'idle' && 'lb-row-hot'), null,
        h('span', { className: 'lb-name' }, row.name),
        status(row))
    }
    const [first, second] = row.members
    return button(row, classes(row.lead && 'lb-row-lead'), null,
      second
        ? h('span', { className: 'lb-art lb-duo' },
          h('span', { className: 'lb-duo-a' }, renderArt(first, duo, 'idle')),
          h('span', { className: 'lb-duo-b' }, renderArt(second, duo, 'idle')))
        : h('span', { className: 'lb-art' }, first ? renderArt(first, art, 'idle') : null),
      h('span', { className: 'lb-name' }, row.name))
  }
  return h('div', { className: 'lb-scroll', 'data-above': edges.above ? '' : undefined, 'data-more': edges.more ? '' : undefined },
    h('div', { ref, className: 'lb-rows', role: 'group', 'aria-label': label ?? word('team') }, rows.map(draw)))
}
