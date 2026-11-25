import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BotMark, lookOf, petOf, useBaked } from './mark.js'
import { PetSprite } from './pet.js'
import { BODY, CELL, FLOOR } from './pet-poses.js'
import { hostText, t } from './i18n.js'
import { botChannelSource } from './extend.js'
import { QUIET, Status, WORDED, stateOfStatus, statusOr, word, worstStatus } from './left-bar-status.js'

// -------------------------------------------------------------------------
// The Team side of the new left bar (direction C): the project's Bots, the channels and chats
// under a Bot, then the group chats. One line per row: the art, the name, one status mark. No
// crown or preview line.
//
// A team, as the bar reads it:
//   bots      [{ id, name, status, unread, channelSource?, channels?, ...the Bot's own look
//             fields }]. With a channelSource (extend.js's botChannels) the source's channels
//             hang under the Bot, each with its chats, on Omni's own status words (channel:
//             connected, needs-pairing, disconnected, error; chat: answering, paused,
//             needs-someone, idle); with none, `channels` already on the Bot are drawn as they
//             are. `status` is one of left-bar-status.js STATUSES.
//   frontId   the project's front Bot: shown first, above every section
//   sections  [{ label, bots: [id] }], optional quiet labels (DS Bot ruling 10)
//   groups    [{ id, name, members: [id], status, unread }], after the Bots

// Omni's own words for what a channel and a chat do (the botChannels contract, extend.js),
// as the bar's marks. The bar's own statuses are accepted too, so a source that predates them
// still draws.
const CHANNEL_STATUS = Object.freeze({ connected: 'idle', 'needs-pairing': 'needs', disconnected: 'off', error: 'error' })
const CHAT_STATUS = Object.freeze({ answering: 'working', paused: 'idle', 'needs-someone': 'needs', idle: 'idle' })
export const channelStatusOf = channel => statusOr(CHANNEL_STATUS[channel?.status] ?? channel?.status)
export const chatStatusOf = chat => statusOr(CHAT_STATUS[chat?.status] ?? chat?.status)

const chatStatuses = bot => (bot.channels ?? []).flatMap(channel => (channel.chats ?? []).map(chatStatusOf))

// A Bot whose chat already says "needs you" does not say it again on its own row: the chat's
// row, or its folded channel's, is where the owner goes.
export function botRowStatus(bot) {
  const status = statusOr(bot.status)
  // A Bot whose plugin is not installed cannot answer: that outranks a folded channel asking
  // for the person, which still says so on its own row.
  if (status === 'not-installed') return status
  if (status === 'needs' && chatStatuses(bot).includes('needs')) return 'idle'
  // A closed Bot's chats are not read yet; a channel that needs the person still reaches the
  // row he sees all day, so it is not only one line down and inside a Bot he did not open.
  const channels = bot.channels ?? []
  const closed = channels.length > 0 && channels.every(channel => channel.chats === undefined)
  return closed && channels.some(channel => channelStatusOf(channel) === 'needs') ? worstStatus([status, 'needs']) : status
}

const NO_FOLDS = new Set()

// A channel's chats, newest first: a source's lastAt; chats without one keep the source's order.
const chatsOf = channel => [...(channel.chats ?? [])].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

// A folded channel speaks for its own state and its chats': what asks for the owner first, then
// what failed, then what runs. A channel that is not running at all keeps its off, not idle.
const foldedStatusOf = (own, chats) => {
  const statuses = [own, ...chats.map(chatStatusOf)]
  const worst = worstStatus(statuses)
  return worst === 'idle' && statuses.includes('off') ? 'off' : worst
}

/**
 * A Bot's channel and chat rows, under its own row. `folded` holds the `botId/channelId` keys a
 * person folded. A channel stays folded while its source has not read its chats (its Bot is not
 * open and the person has not unfolded it): its own status speaks, and a press asks for them.
 */
export function channelRows(bot, channels = [], folded = NO_FOLDS) {
  const rows = []
  for (const channel of channels) {
    const chats = chatsOf(channel)
    const isFolded = channel.chats === undefined || folded.has(`${bot.id}/${channel.id}`)
    const own = channelStatusOf(channel)
    rows.push({
      kind: 'channel', key: `channel:${bot.id}/${channel.id}`, id: channel.id, botId: bot.id, name: channel.name, channel,
      folded: isFolded, status: isFolded ? foldedStatusOf(own, chats) : own,
      unread: chats.some(chat => Number(chat.unread) > 0), source: bot.channelSource,
    })
    if (isFolded) continue
    for (const chat of chats) {
      rows.push({
        kind: 'chat', key: `chat:${bot.id}/${channel.id}/${chat.id}`, id: chat.id, botId: bot.id, channelId: channel.id,
        name: chat.name, chat, who: chat.who, status: chatStatusOf(chat), unread: Number(chat.unread) > 0, unreadCount: Math.max(0, Math.floor(Number(chat.unread) || 0)), source: bot.channelSource,
      })
    }
  }
  return rows
}

/**
 * The Team list as the structure the bar draws: the front Bot, the Bots no section holds, each
 * section under its label, then the group chats. A Bot's own channels and chats are drawn under
 * its row (channelRows), from the source that serves it.
 */
export function teamRows(team) {
  const bots = team?.bots ?? []
  const byId = new Map(bots.map(bot => [bot.id, bot]))
  const sections = (team?.sections ?? []).map(section => ({ label: section.label, bots: (section.bots ?? []).map(id => byId.get(id)).filter(Boolean) })).filter(section => section.bots.length > 0)
  const placed = new Set(sections.flatMap(section => section.bots.map(bot => bot.id)))
  const front = byId.get(team?.frontId)
  const botRow = bot => ({ kind: 'bot', key: `bot:${bot.id}`, id: bot.id, name: bot.name, bot, status: botRowStatus(bot), unread: bot.unread === true })
  // The front Bot, then the Bots no section holds, then each section under its label.
  const loose = bots.filter(bot => bot !== front && !placed.has(bot.id))
  const rows = [...(front ? [front] : []), ...loose].map(botRow)
  sections.forEach((section, index) => {
    const held = section.bots.filter(bot => bot !== front)
    if (held.length === 0) return
    // The first label stands clear of the front Bot above it.
    rows.push({ kind: 'section', key: `section:${index}`, label: section.label, first: !rows.some(row => row.kind === 'section') })
    rows.push(...held.map(botRow))
  })
  ;(team?.groups ?? []).forEach((group, index) => {
    const members = (group.members ?? []).map(id => byId.get(id)).filter(Boolean)
    // Under sections the groups stand a little apart, so they do not read as the last section's.
    rows.push({ kind: 'group', key: `group:${group.id}`, id: group.id, name: group.name, members, lead: index === 0 && rows.some(row => row.kind === 'section'), status: statusOr(group.status), unread: group.unread === true })
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
    // A Bot's chats arrive after its own row does, so the list's content changes without a
    // scroll or a resize of the box: both watchers re-read the edges when rows come and go.
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    watch?.observe(node)
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(read) : null
    mutations?.observe(node, { childList: true, subtree: true })
    return () => {
      node.removeEventListener('scroll', read)
      watch?.disconnect()
      mutations?.disconnect()
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
//
// Omni's own character is baked from its clay picture: 16 units larger than BODY, with its feet
// 2 under the FLOOR (pet-bake.js, omniLayers). It paints that whole box from edge to edge, where
// the other characters leave about a twelfth of theirs clear, so it is fitted by a box a twelfth
// larger than the one it paints: it then stands at the size of the Bots beside it, by eye.
const OMNI_PAINTS = BODY + 16
const PET_BOX = { body: BODY, middle: FLOOR - BODY / 2 }
const OMNI_BOX = { body: OMNI_PAINTS * 13 / 12, middle: FLOOR + 2 - OMNI_PAINTS / 2 }
// The design draws each character trimmed close to its own outline, so its larger side is about
// the art's size. Fitted by its box, a character painted 25 to 26 px of a 28 px art box (measured
// in the app), so the bar draws it a twentieth larger: about 27 px, every one still inside the
// box (test/left-bar-browser.test.js measures them).
export const ART_TRIM = 21 / 20
/** How much larger than the art a baked pet is drawn, and how far it is lifted, as parts of its cell. */
export function bakedFit(bake) {
  const { body, middle } = bake?.clay === 'omni' ? OMNI_BOX : PET_BOX
  return { fit: (CELL.height / body) * ART_TRIM, lift: (middle - CELL.height / 2) / CELL.height }
}
function BotArt({ bot, size, state, look = lookOf(bot) }) {
  const wants = petOf(bot, look, { live: true, size })
  const baked = useBaked(wants?.bake)
  if (!wants?.bake) return h(BotMark, { bot, look, size, state, live: true })
  if (!baked) return h(BotMark, { bot, look, size, state })
  const { fit, lift } = bakedFit(wants.bake)
  const margin = Math.round((size * fit - size) / 2)
  const drawn = size + 2 * margin
  return h('span', { className: 'lb-art-pet', style: { left: -margin, top: -margin - Math.round(drawn * lift) } },
    h('span', { className: 'bt-mark', 'data-shape': 'pet', 'data-state': state, 'data-live': '', 'aria-hidden': true, style: { width: drawn, height: drawn } },
      h(PetSprite, { pet: baked, size: drawn, state, live: true })))
}
/** A Bot's character for a row, as the bar draws it by default. */
export const drawBot = (bot, size, state, look) => h(BotArt, { bot, size, state, look })
const Chevron = ({ open = false }) => h('svg', { className: open ? 'lb-chev lb-chev-open' : 'lb-chev', width: 13, height: 13, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M7.5 4.5L13 10l-5.5 5.5' }))
const classes = (...names) => names.filter(Boolean).join(' ')
// A name the row cuts shows in full on hover. Only the laid-out row can tell, so it is
// measured as the pointer enters.
export const nameIfCut = (event) => {
  const row = event.currentTarget
  const name = row.querySelector('.lb-name')
  if (name && name.scrollWidth > name.clientWidth) row.title = name.textContent
  else row.removeAttribute('title')
}

const initialsOf = (name) => String(name ?? '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map(word => word[0] ?? '').join('').toUpperCase() || '?'

// A chat's person: their photo, or their initials when there is none, on the tone Omni's own
// chat view gives their side of the conversation. The owner's own chat wears the outgoing tone
// and everyone else's the incoming one; the tokens are Omni's, shared by its chat view, and the
// fallbacks are the formulas it uses for them.
function ChatFace({ who }) {
  return h('span', { className: 'lb-chat-face', 'data-self': who?.self === true ? '' : undefined, 'aria-hidden': true },
    who?.photo ? h('img', { src: who.photo, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onError: event => { event.currentTarget.remove() } }) : null,
    h('span', { className: 'lb-chat-face-initials' }, initialsOf(who?.name)))
}

// A Bot's channels come from the one source that serves it (extend.js's botChannels); while
// there is none, its own channels (the design demo's or a test's) are drawn as they are.
function BotBlock({ row, renderRow, folded, loads }) {
  const source = row.bot.channelSource ?? botChannelSource(row.bot)
  return source
    ? h(BotChannels, { key: source.id, row, source, renderRow, folded, loads })
    : h(BotRows, { row, channels: row.bot.channels ?? [], source: row.bot.channelSource, renderRow, folded })
}

// The one hook call that a Bot's source gets: `open` says its Session is shown or one of its
// channels was unfolded, and only then does the source read that Bot's chats.
function BotChannels({ row, source, renderRow, folded, loads }) {
  const channels = source.useChannels(row.id, { open: loads ? loads(row.id) === true : false }) ?? []
  return h(BotRows, { row, channels, source, renderRow, folded })
}

// One Bot's row and its channels, in the place the row list gives the Bot.
function BotRows({ row, channels, source, renderRow, folded = NO_FOLDS }) {
  const bot = { ...row.bot, channels }
  const head = { ...row, bot, status: botRowStatus(bot), channelSource: source ?? row.bot.channelSource }
  return [renderRow(head), ...channelRows(bot, channels, folded).map(renderRow)]
}

/**
 * The Team rows. `current` is the open row's key (`bot:<id>`, `chat:<bot>/<channel>/<id>`,
 * `group:<id>`); `onOpen(row)` hears a press on any row, a channel's included (the caller folds
 * it). `renderArt(bot, size, state)` and `renderGlyph(channel)` draw a Bot's character and a
 * channel's glyph; a glyph is one colour, so colour only ever means status. `skin` is the
 * name of the token set in use (left-bar-css.js): when it changes, the art is measured again.
 * `onMenu(row, event)` hears a row's context menu. `renderAfter(row)` draws what hangs under a
 * row that the bar does not draw itself (a Bot's running tasks, what other plugins add under a
 * Bot, a DSH bot's Sessions); it is drawn as is, between that row and the next. `renderEnd(row)`
 * draws inside a Bot's row, between its name and its mark (the badges other plugins add).
 * `folded` holds the channel keys a person folded, and `loads(botId)` says whether that Bot is
 * open (or a channel of it was unfolded), which is when its source reads its chats.
 */
export function TeamRows({ team, current, onOpen, onMenu, renderAfter, renderEnd, label, skin, renderArt = drawBot, renderGlyph, worded = WORDED, quiet = QUIET, folded = NO_FOLDS, loads }) {
  const ref = useRef(null)
  const rows = teamRows(team)
  const { art, duo } = useArtSizes(ref, skin, rows.length)
  const edges = useScrollEdges(ref, rows.length)
  const press = row => (onOpen && !row.bot?.remote ? () => onOpen(row) : undefined)
  // A remote row's tag says why it is inert, so its status is the ring alone: the name keeps its room.
  // `detail` carries the installation reason a crew Bot's row adds to its status (#1771).
  const status = (row, detail = '') => h(Status, { status: row.status, worded: row.bot?.remote ? [] : worded, quiet: row.bot?.seat ? [] : quiet, detail })
  const button = (row, className, extra, ...children) => h('button', {
    key: row.key, type: 'button', className: classes('lb-row', className), 'data-kind': row.kind, 'data-id': row.id,
    'aria-current': row.key === current ? 'page' : undefined, onClick: press(row), onMouseEnter: row.bot?.remote ? undefined : nameIfCut,
    onContextMenu: onMenu ? (event) => { event.preventDefault(); onMenu(row, event) } : undefined, ...extra,
  }, ...children)
  const draw = (row) => {
    if (row.kind === 'section') return h('div', { key: row.key, className: classes('lb-sec', row.first && 'lb-sec-first') }, row.label)
    if (row.kind === 'bot') {
      // The row's own status may be silent (a chat says it); the character still plays the Bot's.
      const state = row.bot.state ?? stateOfStatus(statusOr(row.bot.status))
      const tag = row.bot.remote ? t('Needs the scoped link') : row.bot.seat ? row.bot.projectTag : row.bot.roleTag
      const extra = row.bot.remote ? {
        'aria-disabled': true,
        title: t('This Bot is on {machine}. It opens here once the link to that computer is scoped.', { machine: row.bot.machine }),
      } : null
      // Keep the button's name from its contents (including role and unread activity).
      // The missing plugin's reason describes the row and remains on the status mark.
      const reason = row.bot?.installed === false && typeof row.bot.reason === 'string' ? hostText(row.bot.reason) : ''
      return button(row, classes(row.unread && 'lb-row-unread', row.status === 'off' && 'lb-row-off'), { ...extra, 'aria-description': reason || undefined },
        h('span', { className: 'lb-art' }, renderArt(row.bot, art, state)),
        h('span', { className: 'lb-name' }, row.name),
        tag ? h('span', { className: 'bt-tag' }, tag) : null,
        row.unread ? h('span', { className: 'lb-sr' }, t('Unread activity')) : null,
        renderEnd ? renderEnd(row) : null,
        status(row, reason))
    }
    if (row.kind === 'channel') {
      return button(row, classes('lb-row-channel', row.unread && 'lb-row-unread'), { 'aria-expanded': !row.folded },
        h('span', { className: 'lb-glyph', 'aria-hidden': true }, renderGlyph ? renderGlyph(row.channel) : null),
        h('span', { className: 'lb-name' }, row.name),
        row.unread ? h('span', { className: 'lb-sr' }, t('Unread activity')) : null,
        status(row),
        h(Chevron, { open: !row.folded }))
    }
    if (row.kind === 'chat') {
      return button(row, classes('lb-row-chat', row.status !== 'idle' && 'lb-row-hot', row.unread && 'lb-row-unread'), null,
        h(ChatFace, { who: row.who }),
        h('span', { className: 'lb-name' }, row.name),
        row.unread ? h('span', { className: 'lb-sr' }, t('Unread activity')) : null,
        row.unreadCount > 0 ? h('span', { className: 'lb-count', 'aria-hidden': true }, row.unreadCount > 99 ? '99+' : String(row.unreadCount)) : null,
        status(row))
    }
    const [first, second] = row.members
    return button(row, classes(row.lead && 'lb-row-lead', row.unread && 'lb-row-unread'), null,
      second
        ? h('span', { className: 'lb-art lb-duo' },
          h('span', { className: 'lb-duo-a' }, renderArt(first, duo, 'idle')),
          h('span', { className: 'lb-duo-b' }, renderArt(second, duo, 'idle')))
        : h('span', { className: 'lb-art' }, first ? renderArt(first, art, 'idle') : null),
      h('span', { className: 'lb-name' }, row.name),
      row.unread ? h('span', { className: 'lb-sr' }, t('Unread activity')) : null,
      status(row))
  }
  // A row with something hanging under it comes with it, in one keyed fragment.
  const renderRow = (row) => {
    const after = renderAfter ? renderAfter(row) : null
    return after ? h(Fragment, { key: row.key }, draw(row), after) : draw(row)
  }
  // Only a Bot something can hang under takes the source's component; every other row is drawn
  // as it always was, so the bar keeps drawing plain teams exactly as before.
  const served = row => row.bot.channelSource ?? botChannelSource(row.bot) ?? (row.bot.channels?.length ? true : undefined)
  return h('div', { className: 'lb-scroll', 'data-above': edges.above ? '' : undefined, 'data-more': edges.more ? '' : undefined },
    h('div', { ref, className: 'lb-rows', role: 'group', 'aria-label': label ?? word('team') }, rows.map(row => (row.kind === 'bot' && served(row)
      ? h(BotBlock, { key: row.key, row, renderRow, folded, loads })
      : renderRow(row)))))
}
