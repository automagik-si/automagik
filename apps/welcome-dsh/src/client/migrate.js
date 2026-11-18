import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { Stage, StepAside, useFinish, useGate, useGlitch } from './stage.js'
import { pressed, raised, recessed } from './clay.js'
import { t } from './i18n.js'

// Step omni-migrate (order -230), between Connect Omni (-250) and Connect AI (-200): where a
// person coming from another tool brings its bot over. Hermes is the tool this release can
// move: the welcome reads Hermes's Telegram bot key only after the person confirms, switches
// Hermes's Telegram channel off, and starts Omni's with the same bot (src/host/hermes-migrate.js;
// the key never reaches this page). Until OpenClaw, Grok bot and Muse are surveyed, their cards
// show only the name and a "Coming soon" pill, never a button that does nothing.
//
// The Hermes move is the split's order, one bot and one listener: confirm -> Hermes's Telegram
// off (its config kept, its gateway restarted for a few seconds) -> Omni on -> Omni's live
// status. When Hermes has no key this wizard can read, or the channel is not there, the step
// hand-offs to Omni's own Telegram setup in Channels: no second copy of that guide lives here.
//
// Copy is the welcome.team namespace (i18n.js). Every class is prefixed oai-mig- and wears the
// stage's clay, so it follows DSH's light and dark themes.

// The tools of the migration list. `vendor` names the company when the product name alone is
// ambiguous; `ready` is this release's truth, not a promise.
export const TOOLS = [
  { id: 'hermes', name: 'Hermes', vendor: null, tag: 'H', what: 'Telegram bot', blurb: 'Move its Telegram bot to Omni, with the bot you already know.', ready: true },
  { id: 'openclaw', name: 'OpenClaw', vendor: null, tag: 'OC', ready: false },
  { id: 'grok', name: 'Grok bot', vendor: 'xAI', tag: 'X', ready: false },
  { id: 'muse', name: 'Muse', vendor: 'Meta', tag: 'M', ready: false },
]

// The move's steps, in the order the split requires. The host reports the same ids.
export const MOVE = [
  { id: 'key', label: 'Read Hermes\'s bot key', doing: 'It goes straight to Omni, which keeps it private. You never see it here.' },
  { id: 'hermes', label: 'Switch Hermes\'s Telegram off', doing: 'Hermes restarts for a few seconds. Its other channels come back by themselves.' },
  { id: 'omni', label: 'Hand the bot to Omni', doing: 'Omni takes the same bot. Nothing else changes on Hermes.' },
  { id: 'listen', label: 'Wait for Omni to answer', doing: 'One bot, one listener. Omni is starting it.' },
]

// Why Hermes cannot be moved from here, and what the person does instead. Each is a plain
// fact, never an apology that hides what happened.
export function handoffOf(probe) {
  if (probe === null) return null
  if (probe.omni?.telegram?.connected === true) return null
  if (probe.hermes?.found !== true) return { reason: 'no-hermes' }
  if (probe.hermes.channel === 'none') return { reason: 'no-channel' }
  if (probe.hermes.key !== 'available') return { reason: 'no-key' }
  if (probe.omni?.linked !== true) return { reason: 'no-omni' }
  return null
}

/** Whether the confirm card can offer the move at all. */
export const canMove = probe => probe !== null && handoffOf(probe) === null

/** The Bots offered as the one who answers, main first. Only A's attach can bind one. */
export function answerBots(probe) {
  const bots = Array.isArray(probe?.omni?.bots) ? probe.omni.bots : []
  return probe?.omni?.attach === true ? [...bots].sort((a, b) => Number(b.main === true) - Number(a.main === true)) : []
}

export function defaultAnswerBot(probe) {
  return answerBots(probe)[0]?.id ?? null
}

/** The reading of a status answer, for the live pill under the bot's name. */
export const statusOf = (connected) => (connected === true ? 'connected' : 'waiting')

// What the card says about Hermes before the person confirms.
export function foundOf(probe) {
  const channel = probe?.hermes?.channel
  return channel === 'off' ? 'off' : channel === 'on' ? 'on' : 'unknown'
}

// The hand-off's words per reason.
export const HANDOFF = {
  'no-hermes': { title: 'Hermes is not on this computer', text: 'DSH is not connected to a Hermes here. Set up Omni\'s Telegram in Channels; it takes a minute.' },
  'no-channel': { title: 'No Hermes Telegram bot to move', text: 'Hermes has no Telegram channel here, so there is nothing to move. Set up Omni\'s Telegram in Channels.' },
  'no-key': { title: 'Hermes has no bot key this wizard can read', text: 'Set Omni\'s Telegram up in Channels, or copy the key into Omni yourself. Hermes\'s channel is left alone.' },
  'no-omni': { title: 'Connect Omni first', text: 'The Connect Omni step does that. Then come back here.' },
  manual: { title: 'Set Omni\'s Telegram up in Channels', text: 'Omni\'s own Telegram setup has every step. Hermes is left exactly as it is.' },
}

// ── small parts ───────────────────────────────────────────────────────────────────────────

// A host sentence is shown, but a key-shaped run in it never is: the shared redactor does not
// know a Telegram bot key's shape, so the page keeps the last line of defence. The prefix may
// be split before its colon or inside its digits, and a space, line break or any control
// character may split the suffix.
export function redactKey(value) {
  const text = String(value ?? '')
  let out = ''
  let copied = 0
  const digit = /^[0-9]$/
  const tokenChar = /^[A-Za-z0-9_-]$/
  const separated = ch => /^\s$/.test(ch) || ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f
  for (let colon = text.indexOf(':'); colon !== -1; colon = text.indexOf(':', colon + 1)) {
    if (colon < copied) continue
    let at = colon - 1
    let digits = 0
    let first = colon
    while (at >= 0) {
      const ch = text[at]
      if (separated(ch)) { at -= 1; continue }
      if (digit.test(ch)) { digits += 1; first = at; at -= 1; continue }
      break
    }
    if (digits < 6 || digits > 12 || first < copied) continue
    if (first > 0 && digit.test(text[first - 1])) continue
    let run = colon + 1
    let taken = 0
    let last = run
    while (run < text.length && taken < 35) {
      const ch = text[run]
      if (tokenChar.test(ch)) { taken += 1; run += 1; last = run; continue }
      if (separated(ch)) { run += 1; continue }
      break
    }
    if (taken < 30) continue
    out += text.slice(copied, first) + '[hidden]'
    copied = last
    colon = last - 1
  }
  return out + text.slice(copied)
}
const hidden = value => redactKey(value)
const Check = () => h('span', { className: 'oai-mig-tick', 'aria-hidden': 'true' }, '✓')
const Arrow = () => h('span', { className: 'oai-mig-arrow', 'aria-hidden': 'true' }, '→')
const Lock = () => h('span', { className: 'oai-mig-lock', 'aria-hidden': 'true' }, h('i', null))
const Spinner = () => h('span', { className: 'oai-mig-spin', 'aria-hidden': 'true' })

const ToolMark = ({ tag }) => h('span', { className: 'oai-mig-mark', 'aria-hidden': 'true' }, tag)

function ToolCard({ tool, onPick }) {
  if (tool.ready !== true) {
    return h('article', { className: 'oai-mig-tool oai-mig-is-soon', 'aria-label': t('{name}: coming soon', { name: tool.name }) },
      h('div', { className: 'oai-mig-top' },
        h(ToolMark, { tag: tool.tag }),
        h('div', { className: 'oai-mig-who' },
          h('strong', null, tool.name, tool.vendor ? h('small', null, tool.vendor) : null))),
      h('span', { className: 'oai-soon' }, t('Coming soon')))
  }
  return h('button', { type: 'button', className: 'oai-mig-tool oai-mig-is-ready', onClick: () => onPick(tool.id), 'aria-label': t('Move {name} to Omni', { name: tool.name }) },
    h('div', { className: 'oai-mig-top' },
      h(ToolMark, { tag: tool.tag }),
      h('div', { className: 'oai-mig-who' },
        h('strong', null, tool.name, tool.vendor ? h('small', null, tool.vendor) : null),
        h('span', null, t(tool.what)))),
    h('span', { className: 'oai-mig-ready' }, Check(), t('Ready')),
    h('p', { className: 'oai-mig-blurb' }, t(tool.blurb)),
    h('span', { className: 'oai-mig-go' }, t('Move it'), Arrow()))
}

function ToolGrid({ onPick }) {
  return h('div', { className: 'oai-mig-grid', role: 'group', 'aria-label': t('Tools you can come from') },
    TOOLS.map(tool => h(ToolCard, { key: tool.id, tool, onPick })))
}

function BotPicker({ bots, value, onPick }) {
  if (bots.length === 0) return null
  return h('div', { className: 'oai-mig-pick', role: 'radiogroup', 'aria-label': t('Who answers') },
    h('span', { className: 'oai-mig-label' }, t('Who answers in the chats?')),
    h('div', { className: 'oai-mig-bots' }, bots.map(bot => h('button', {
      key: bot.id, type: 'button', role: 'radio', 'aria-checked': bot.id === value,
      className: `oai-mig-botpick${bot.id === value ? ' is-on' : ''}`,
      onClick: () => onPick(bot.id),
    }, h('span', { className: 'oai-mig-dot', 'aria-hidden': 'true' }), bot.name, bot.main === true ? h('small', null, t('Main Bot')) : null))),
    h('p', { className: 'oai-mig-fine' }, t('You can change this later in Omni.')))
}

function StepList({ steps }) {
  return h('ol', { className: 'oai-mig-steps' }, MOVE.map((step) => {
    const state = steps?.find(entry => entry.id === step.id)?.state ?? 'pending'
    return h('li', { key: step.id, 'data-state': state },
      h('span', { className: 'oai-mig-bead' }, state === 'done' ? Check() : state === 'now' ? Spinner() : state === 'failed' ? '!' : String(MOVE.indexOf(step) + 1)),
      h('span', { className: 'oai-mig-step' },
        h('strong', null, t(step.label)),
        state === 'now' ? h('small', null, t(step.doing)) : null))
  }))
}

function KeyMove() {
  return h('div', { className: 'oai-mig-key' },
    h(Lock, null),
    h('div', { className: 'oai-mig-keytext' },
      h('strong', null, t('The bot key passes straight from Hermes into Omni.')),
      h('span', null, t('It never appears here or in a log.')),
      h('span', { className: 'oai-mig-dots', 'aria-hidden': 'true' }, '••••••••••••••••')))
}

function StatusPill({ connected, text }) {
  return h('span', { className: 'oai-mig-status', 'data-state': statusOf(connected) },
    h('span', { className: 'oai-mig-statusdot', 'aria-hidden': 'true' }),
    text ?? (connected ? t('Listening on Telegram') : t('Waiting for Omni to say it is up')))
}

function BotPanel({ result }) {
  const name = result.botName ?? t('Your Telegram bot')
  return h('div', { className: 'oai-mig-botbox' },
    h('span', { className: 'oai-mig-bigmark', 'aria-hidden': 'true' }, 'TG'),
    h('div', { className: 'oai-mig-botwho' },
      h('strong', null, name),
      h('span', null, result.channelName ?? t('Telegram')),
      h(StatusPill, { connected: result.connected })))
}

function HandoffCard({ handoff, note, onOpenChannels, onCheckAgain, onSkip }) {
  const words = HANDOFF[handoff?.reason] ?? HANDOFF['no-key']
  return h('div', { className: 'oai-mig-handoff' },
    h('h2', null, t(words.title)),
    h('p', { className: 'oai-mig-lede' }, t(words.text)),
    note ? h('p', { className: 'oai-mig-note', role: 'status' }, t(note)) : null,
    h('div', { className: 'oai-actions' },
      onOpenChannels ? h('button', { type: 'button', className: 'oai-quiet', onClick: onCheckAgain }, t('Check again')) : null,
      h('button', { type: 'button', className: 'oai-primary', onClick: onOpenChannels ?? onCheckAgain }, t(onOpenChannels ? 'Open Omni\'s Channels' : 'Check again'))),
    h('button', { type: 'button', className: 'oai-textlink', onClick: onSkip }, t('Not now')))
}

function ConfirmCard({ probe, botId, agreed, busy, onPickBot, onAgree, onStart, onBack }) {
  const off = foundOf(probe) === 'off'
  const bots = answerBots(probe)
  const gatewayRunning = probe.hermes?.gatewayRunning === true
  const stopped = !off && !gatewayRunning
  const pending = probe.hermes?.pendingRestart === true
  const restart = (!off && gatewayRunning) || pending
  return h('div', { className: 'oai-mig-confirm' },
    h('div', { className: 'oai-mig-found' },
      h('span', { className: 'oai-mig-dot', 'data-on': !off && !stopped ? 'on' : undefined, 'aria-hidden': 'true' }),
      h('span', null,
        h('strong', null, t(off ? 'Hermes · Telegram is already off' : stopped ? 'Hermes · not running' : 'Hermes · Telegram is on')),
        h('small', null, t(probe.hermes?.where === 'ssh' ? 'on your Hermes computer' : 'on this computer')))),
    h('ol', { className: 'oai-mig-do' },
      h('li', null, h('span', { className: 'oai-mig-do-text' }, h('b', null, t('The wizard reads Hermes\'s bot key.')), ' ', t('It stays hidden and goes straight to Omni, which keeps it private.'))),
      h('li', null, h('span', { className: 'oai-mig-do-text' }, off
        ? (pending
            ? h('span', null, h('b', null, t('Hermes\'s Telegram is already off; nothing is switched.')), ' ', t('Hermes still has to let go of the old channel, so it restarts for a few seconds. Its other channels blink and come back by themselves.'))
            : t('Hermes is already off; nothing is switched. No restart is needed.'))
        : stopped
          ? h('span', null, h('b', null, t('Hermes is not running.')), ' ', t('Its Telegram is switched off in its settings, so it stays off when you start Hermes again.'))
          : h('span', null, h('b', null, t('Hermes\'s Telegram is switched off.')), ' ', t('Hermes keeps a copy of its settings first, then restarts for a few seconds. Its other channels blink and come back by themselves.')))),
      h('li', null, h('span', { className: 'oai-mig-do-text' }, h('b', null, t('Omni starts its Telegram channel with the same bot.')), ' ', t('One bot, one listener.')))),
    h(BotPicker, { bots, value: botId, onPick: onPickBot }),
    h('label', { className: 'oai-mig-agree' },
      h('input', { type: 'checkbox', checked: agreed === true, onChange: event => onAgree(event.target.checked) }),
      h('span', { className: 'oai-mig-box' }, Check()),
      h('span', null, t(stopped ? 'I am ready: Omni starts with Hermes\'s bot, and Hermes\'s Telegram stays off.' : restart ? 'I am ready: Hermes restarts for a few seconds and its Telegram goes off.' : 'I am ready: Omni starts with Hermes\'s bot.'))),
    h('div', { className: 'oai-actions' },
      h('button', { type: 'button', className: 'oai-quiet', onClick: onBack }, t('Back')),
      h('button', { type: 'button', className: 'oai-primary', disabled: agreed !== true || busy, onClick: onStart }, t(off ? 'Start Omni with it' : 'Switch it over'))))
}

function MovingCard({ steps }) {
  return h('div', { className: 'oai-mig-moving', role: 'status', 'aria-live': 'polite' },
    h(KeyMove, null),
    h(StepList, { steps }),
    h('p', { className: 'oai-mig-fine' }, t('You can leave this open. It takes a few seconds.')))
}

function DoneCard({ result, onDone, onCheckStatus, canOpenSettings, onOpenSettings, gatewayStopped }) {
  return h('div', { className: 'oai-mig-doneview' },
    h(BotPanel, { result }),
    result.recovered === true ? h('p', { className: 'oai-mig-note', role: 'status' }, t('No Bot answers in these chats yet. Pick one in Omni\'s Channels.')) : null,
    result.connected !== true ? h('p', { className: 'oai-mig-note', role: 'status' }, t('Omni has the channel. It is bringing the bot up now.')) : null,
    result.chatUrl ? h('a', { className: 'oai-pill oai-mig-sayhi', href: result.chatUrl, target: '_blank', rel: 'noreferrer' }, t('Say hi to your bot'), Arrow()) : null,
    result.answering === true && result.answerBot ? h('p', { className: 'oai-mig-answer' }, Check(), t('Replies through {name}.', { name: result.answerBot.name })) : null,
    result.answeringOff === true ? h('div', { className: 'oai-mig-warn' },
      h('strong', null, t('Omni added the bot, but your Bot {name} is off and already answers on other channels. Turning it on here would turn those on too.', { name: result.answerBot?.name ?? t('this Bot') })),
      h('span', null, t('Turn it on in its settings when you are ready. Omni answers here as well.')),
      canOpenSettings ? h('button', { type: 'button', className: 'oai-mig-soft', onClick: () => onOpenSettings(result.answerBot?.id) }, t('Open {name}\'s settings', { name: result.answerBot?.name ?? t('this Bot') })) : null) : null,
    result.attached === false ? h('p', { className: 'oai-mig-fine' }, t('Omni has the channel. Its next update adds your Bot as the one who answers.')) : null,
    h('div', { className: 'oai-mig-summary' },
      result.hermesOff === true ? h('span', null, result.hermesWasOff === true ? t('Hermes: Telegram was already off') : t('Hermes: Telegram off')) : null,
      h('span', null, t('Omni: listening'))),
    result.hermesWasStopped === true ? h('p', { className: 'oai-mig-note', role: 'status' }, t('Hermes was not running. Its Telegram stays off until you start Hermes again.')) : null,
    gatewayStopped === true ? h('p', { className: 'oai-mig-note', role: 'status' }, t('Hermes is not running right now. Start it again to bring its other channels back.')) : null,
    h('div', { className: 'oai-actions' },
      result.connected !== true && onCheckStatus ? h('button', { type: 'button', className: 'oai-quiet', onClick: onCheckStatus }, t('Check status')) : null,
      h('button', { type: 'button', className: 'oai-primary', onClick: onDone }, t('Done'))))
}

function ProblemCard({ error, note, restoring, onRetry, onHandoff, onRestoreHermes }) {
  const changed = error?.changed ?? {}
  const lines = error?.code === 'hermes-still-on'
    ? 'Hermes still has the channel. Nothing was handed to Omni, and its settings were put back.'
    : error?.code === 'refused'
      ? 'Hermes would not restart. It may still have a chat open; finish it and try again.'
      : changed.omniUnknown === true
        ? 'Hermes\'s Telegram is off. Omni did not confirm which channel is the move\'s, so check Omni\'s Channels before trying again. Hermes still has the key.'
        : changed.hermesOff === true && changed.omniCreated !== true
          ? 'Hermes\'s Telegram is off and Omni did not take the bot. Nothing is listening right now. Try again; Hermes still has the key.'
          : 'Nothing was changed. Hermes is exactly as it was.'
  // The way back is offered only when the host still holds the copy it made before switching
  // Hermes off, and the result is unknown: a channel Omni confirmed must keep one listener.
  const canRestore = changed.omniUnknown === true && error?.canRestoreHermes === true
  return h('div', { className: 'oai-mig-problem' },
    h('p', { className: 'oai-mig-error', role: 'alert' }, t(lines)),
    error?.message && !['hermes-still-on', 'refused', 'omni', 'failed'].includes(error.code) ? h('p', { className: 'oai-mig-fine' }, hidden(error.message)) : null,
    note ? h('p', { className: 'oai-mig-note', role: 'status' }, t(note)) : null,
    h('div', { className: 'oai-actions' },
      canRestore ? h('button', { type: 'button', className: 'oai-quiet', disabled: restoring === true, onClick: onRestoreHermes }, t('Turn Hermes\'s Telegram back on')) : null,
      h('button', { type: 'button', className: 'oai-quiet', disabled: restoring === true, onClick: onHandoff }, t('Set up Omni\'s Telegram instead')),
      h('button', { type: 'button', className: 'oai-primary', disabled: restoring === true, onClick: onRetry }, t('Try again'))))
}

function RestoredCard({ onDone }) {
  return h('div', { className: 'oai-mig-handoff' },
    h('p', { className: 'oai-mig-lede' }, t('Nothing else changed. If Omni kept a channel from this move, check it in Omni\'s Channels before moving again.')),
    h('div', { className: 'oai-actions' },
      h('button', { type: 'button', className: 'oai-primary', onClick: onDone }, t('Done'))))
}

// ── the view ──────────────────────────────────────────────────────────────────────────────

const TITLES = {
  choosing: 'From another tool',
  checking: 'Looking at your Hermes…',
  confirm: 'Move this bot to Omni?',
  moving: 'Moving your bot…',
  done: 'Omni has your bot',
  problem: 'That did not finish',
  restored: 'Hermes is back on',
  handoff: 'Set up Omni\'s Telegram',
}

const SPEECH = {
  choosing: 'Coming from somewhere else? Pick the tool you use, and I\'ll bring your bot over.',
  checking: 'Let me look at your Hermes. One moment.',
  confirm: 'One bot can only listen in one place. Hermes lets go first; then Omni picks it up.',
  moving: 'Moving your bot. The key stays with me the whole time.',
  done: 'There it is. Your bot answers on Omni now.',
  problem: 'That did not finish. I\'ll tell you exactly where it stopped.',
  restored: 'That is your way back. Hermes has its Telegram again.',
  handoff: 'We will do this Omni\'s own way.',
}

/**
 * The step as one pure view: every state the page can show, from the host's answers and
 * `actions`. The container below owns the hooks and the calls; tests and the screenshot
 * harness render this directly with fixed fixtures.
 */
export function MigrateView({
  phase = 'choosing', probe = null, botId = null, agreed = false, steps = null, result = null,
  error = null, handoff = null, note = null, busy = false, canOpenSettings = false, glitching = false,
  onPick = () => {}, onBack = () => {}, onAgree = () => {}, onPickBot = () => {}, onStart = () => {},
  onRetry = () => {}, onSkip = () => {}, onDone = () => {}, onCheckAgain = () => {}, onOpenChannels = null,
  onHandoff = () => {}, onOpenSettings = () => {}, onCheckStatus = null, gatewayStopped = false, aside = null,
  onRestoreHermes = () => {}, restoring = false,
}) {
  if (aside !== null) {
    return h(StepAside, {
      text: aside.kind === 'channels'
        ? t('Set up Telegram in Omni\'s Channels. Add a channel, and follow Omni\'s steps there. Then come back here.')
        : t('Turn {name} on in its settings, then come back here.', { name: aside.name ?? t('this Bot') }),
      back: t('Back to setup'),
      onBack: aside.onBack,
    })
  }
  const title = t(TITLES[phase] ?? TITLES.choosing)
  const speech = t(SPEECH[phase] ?? SPEECH.choosing)
  return h(Stage, { title, speech, at: 'omni-migrate', glitching },
    phase === 'choosing' ? h('div', { className: 'oai-mig-choose' },
      h('p', { className: 'oai-lede' }, t('Move the Telegram bot you already have into Omni, or keep your other tools exactly as they are. The bot you and your people already talk to stays the same.')),
      h(ToolGrid, { onPick }),
      h('button', { type: 'button', className: 'oai-textlink', onClick: onSkip }, t('Not now'))) : null,
    phase === 'checking' ? h('div', { className: 'oai-mig-checking' },
      h(Spinner, null),
      h('p', { className: 'oai-mig-lede' }, t('This only reads. Nothing is changed by looking.'))) : null,
    phase === 'confirm' && probe !== null ? h(ConfirmCard, { probe, botId, agreed, busy, onPickBot, onAgree, onStart, onBack }) : null,
    phase === 'moving' ? h(MovingCard, { steps }) : null,
    phase === 'done' && result !== null ? h(DoneCard, { result, onDone, onCheckStatus, canOpenSettings, onOpenSettings, gatewayStopped }) : null,
    phase === 'problem' ? h(ProblemCard, { error, note, restoring, onRetry, onHandoff, onRestoreHermes }) : null,
    phase === 'restored' ? h(RestoredCard, { onDone }) : null,
    phase === 'handoff' ? h(HandoffCard, { handoff, note, onOpenChannels, onCheckAgain, onSkip }) : null)
}

// ── the container ─────────────────────────────────────────────────────────────────────────

const POLL_MS = 900
const STATUS_MS = 4_000
const STATUS_TRIES = 6

/** Opens the Bot team's Channels page, where Omni's own Telegram guide lives. */
export function openChannels(load = () => require('@automagik/bots-dsh/client')) {
  try {
    const face = load()?.omni?.face?.()
    if (face === null || face === undefined || typeof face.actions?.selectPanel !== 'function') return false
    face.actions.selectPanel('omni-channels')
    return true
  } catch {
    return false
  }
}

/** Opens one Bot's settings, where the person turns it on (answers on its channels). */
export function openBotSettings(botId, load = () => require('@automagik/bots-dsh/client')) {
  if (typeof botId !== 'string' || botId === '') return false
  try {
    const face = load()?.omni?.face?.()
    if (face === null || face === undefined || typeof face.actions?.openSettings !== 'function') return false
    face.actions.openSettings('bots', botId)
    return true
  } catch {
    return false
  }
}

const idle = { steps: MOVE.map(step => ({ id: step.id, state: 'pending' })) }
const telegramUrl = (detail) => {
  const name = typeof detail === 'string' ? detail.trim().replace(/^@/, '') : ''
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? `https://t.me/${name}` : null
}

export function MigrateStep(props) {
  const state = useGate(props)
  const finish = useFinish(props)
  const [glitching, glitch] = useGlitch()
  const [phase, setPhase] = useState('choosing')
  const [probe, setProbe] = useState(null)
  const [botId, setBotId] = useState(null)
  const [agreed, setAgreed] = useState(false)
  const [jobId, setJobId] = useState(null)
  const [steps, setSteps] = useState(idle.steps)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [handoff, setHandoff] = useState(null)
  const [note, setNote] = useState(null)
  const [aside, setAside] = useState(null)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => { if (state) glitch() }, [state, glitch])

  const doneWithProbe = (next) => {
    setProbe(next)
    setBotId(defaultAnswerBot(next))
    const telegram = next.omni?.telegram
    if (telegram?.connected === true) {
      setResult({ channelId: telegram.id, channelName: telegram.name, connected: true, botName: telegram.detail, chatUrl: telegramUrl(telegram.detail), attached: true, answering: null })
      setPhase('done')
      return
    }
    const why = handoffOf(next)
    if (why === null) {
      setHandoff(null)
      setPhase('confirm')
      return
    }
    setHandoff(why)
    setPhase('handoff')
  }

  const look = async ({ recheck = false } = {}) => {
    setPhase('checking')
    setNote(null)
    setError(null)
    try {
      const next = await call('migrate-probe')
      if (!alive.current) return
      doneWithProbe(next)
      if (recheck && handoffOf(next) !== null) setNote(t('Not yet. Nothing changed.'))
    } catch (problem) {
      if (!alive.current) return
      setError({ code: 'probe', message: problem.message, changed: {} })
      setPhase('problem')
    }
  }

  const move = async () => {
    if (agreed !== true || busy) return
    setBusy(true)
    setPhase('moving')
    setSteps(idle.steps)
    try {
      const started = await call('migrate-start', { confirm: true, ...(botId !== null && answerBots(probe).length > 0 ? { answerBot: botId } : {}) })
      if (!alive.current) return
      setJobId(started.jobId)
      setBusy(false)
    } catch (problem) {
      if (!alive.current) return
      setBusy(false)
      setError({ code: problem.code ?? 'failed', message: problem.message, changed: {} })
      setPhase('problem')
    }
  }

  // The move's own poll: one request every beat until the host says it is done or stopped.
  useEffect(() => {
    if (jobId === null) return undefined
    let live = true
    let timer = 0
    const tick = async () => {
      try {
        const next = await call('migrate-status', { jobId })
        if (!live) return
        setSteps(next.steps ?? idle.steps)
        if (next.phase === 'done') {
          setResult(next.result)
          setError(null)
          setPhase('done')
          return
        }
        if (next.phase === 'failed') {
          setError(next.error ?? { code: 'failed', message: '', changed: {} })
          setPhase('problem')
          return
        }
      } catch {
        // A missed beat is not a failed move; the next one asks again.
      }
      if (live) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => { live = false; clearTimeout(timer) }
  }, [jobId])

  // Once the channel is made but Omni has not said it is up, ask a few times more.
  useEffect(() => {
    if (phase !== 'done' || result === null || result.connected === true) return undefined
    let live = true
    let timer = 0
    let tries = 0
    const tick = async () => {
      try {
        const next = await call('migrate-omni-status', { channelId: result.channelId })
        if (!live) return
        setResult(previous => ({ ...previous, connected: next.connected, botName: next.detail ?? previous.botName, chatUrl: next.chatUrl ?? previous.chatUrl }))
        if (next.connected) return
      } catch {
        // Omni not answering yet is the waiting state; the next beat asks again.
      }
      tries += 1
      if (live && tries < STATUS_TRIES) timer = setTimeout(tick, STATUS_MS)
    }
    timer = setTimeout(tick, 2_500)
    return () => { live = false; clearTimeout(timer) }
  }, [phase, result?.channelId, result?.connected])

  if (!state) return null

  const openChannelsHere = () => {
    if (openChannels()) {
      setAside({ kind: 'channels', onBack: () => { setAside(null); void look({ recheck: true }) } })
      return
    }
    setNote(t('Open Channels from the Bot team\'s sidebar, then Add a channel → Telegram.'))
  }
  const openSettingsHere = (id) => {
    if (openBotSettings(id)) setAside({ kind: 'bot', name: result?.answerBot?.name ?? t('this Bot'), onBack: () => setAside(null) })
    else setNote(t('Open this Bot\'s settings from the Bot team\'s sidebar and turn it on.'))
  }
  const checkStatus = async () => {
    if (result === null) return
    try {
      const next = await call('migrate-omni-status', { channelId: result.channelId })
      if (!alive.current) return
      setResult(previous => ({ ...previous, connected: next.connected, botName: next.detail ?? previous.botName, chatUrl: next.chatUrl ?? previous.chatUrl }))
    } catch (problem) {
      if (alive.current) setNote(problem.message)
    }
  }
  // The way back after an unknown Omni result: the host puts back the copy it made before
  // switching Hermes off, and the step ends with Hermes's Telegram on again.
  const restoreHermes = async () => {
    if (restoring) return
    setRestoring(true)
    setNote(null)
    try {
      await call('migrate-restore-hermes')
      if (alive.current) setPhase('restored')
    } catch (problem) {
      if (alive.current) setNote(problem.message)
    } finally {
      if (alive.current) setRestoring(false)
    }
  }

  return h(MigrateView, {
    phase,
    probe,
    botId,
    agreed,
    steps,
    result,
    error,
    handoff,
    note,
    busy,
    glitching,
    canOpenSettings: true,
    aside,
    onPick: (id) => { if (id === 'hermes') void look() },
    onBack: () => { setPhase('choosing'); setProbe(null); setHandoff(null); setNote(null) },
    onAgree: setAgreed,
    onPickBot: setBotId,
    onStart: () => { void move() },
    onRetry: () => { setAgreed(false); void look() },
    onSkip: () => finish(),
    onDone: () => finish(),
    onCheckAgain: () => { void look({ recheck: true }) },
    onOpenChannels: openChannelsHere,
    onHandoff: () => { setError(null); setHandoff({ reason: 'manual' }); setPhase('handoff') },
    onOpenSettings: openSettingsHere,
    onCheckStatus: checkStatus,
    onRestoreHermes: () => { void restoreHermes() },
    restoring,
    gatewayStopped: result?.gatewayStopped === true,
  })
}

// ── its clay ──────────────────────────────────────────────────────────────────────────────

export const MIGRATE_CSS = `
.oai-mig-choose{display:grid;gap:12px}
.oai-mig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px;margin:2px 0 4px}
.oai-card .oai-mig-tool{display:grid;gap:9px;width:auto;min-height:0;margin:0;padding:15px 16px 14px;text-align:left;border-radius:20px 23px 19px 22px;${raised('var(--oai-card)', 4)};color:var(--oai-ink);font:inherit;font-weight:400;cursor:pointer;transition:transform .18s cubic-bezier(.3,1.4,.5,1),box-shadow .18s ease}
.oai-card .oai-mig-tool:hover:not(:disabled){transform:translateY(-2px)}
.oai-card .oai-mig-tool:active:not(:disabled){${pressed('var(--oai-card)', 4)}}
.oai-card .oai-mig-tool:focus-visible{outline:3px solid var(--oai-ring);outline-offset:3px}
.oai-card .oai-mig-tool.oai-mig-is-soon{cursor:default;align-content:start;${recessed('color-mix(in srgb,var(--oai-lilac) 16%,var(--oai-niche))')};box-shadow:inset 2px 3px 4px color-mix(in srgb,var(--oai-niche) var(--oai-lo),var(--oai-umber)),inset -2px -2px 3px color-mix(in srgb,var(--oai-niche) var(--oai-hi),var(--oai-shine))}
.oai-mig-top{display:flex;align-items:center;gap:11px;min-width:0}
.oai-mig-mark{flex:none;width:38px;height:38px;display:grid;place-items:center;border-radius:12px 14px 11px 13px;font:var(--bt-weight-title,800) 13px/1 var(--oai-head);letter-spacing:.02em;${raised('var(--oai-clay)', 2)};color:var(--oai-ink)}
.oai-mig-tool.oai-mig-is-ready .oai-mig-mark{${raised('var(--oai-cyan)', 2)};color:var(--oai-cyan-ink)}
.oai-mig-who{display:grid;min-width:0;line-height:1.25}
.oai-mig-who strong{font:var(--bt-weight-strong,700) 15.5px/1.25 var(--oai-head);letter-spacing:-.01em;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.oai-mig-who strong small{font:600 11px/1 var(--oai-font);letter-spacing:.02em;color:var(--oai-ink2)}
.oai-mig-who>span{font-size:11.5px;color:var(--oai-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oai-soon{justify-self:start;display:inline-block;padding:3px 10px;border-radius:999px;background:var(--oai-lilac);color:var(--oai-lilac-ink);font:var(--bt-weight-title,800) .66rem/1.5 var(--oai-head);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
.oai-mig-ready{justify-self:start;display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;${raised('var(--oai-cyan)', 1)};color:var(--oai-cyan-ink);font:var(--bt-weight-strong,700) 10.5px/1.6 var(--oai-head);letter-spacing:.08em;text-transform:uppercase}
.oai-mig-tick{font-style:normal;font-weight:700}
.oai-card .oai-mig-blurb{margin:0!important;color:var(--oai-ink2);font-size:12.5px;line-height:1.45}
.oai-mig-go{display:inline-flex;align-items:center;gap:6px;justify-self:start;margin-top:2px;font:var(--bt-weight-strong,700) 12.5px/1 var(--oai-head);color:var(--oai-accent)}
.oai-mig-arrow{transition:transform .18s ease}
.oai-card .oai-mig-tool:hover .oai-mig-arrow{transform:translateX(3px)}
.oai-mig-lede{color:var(--oai-ink2);margin:0}
.oai-mig-fine{margin:0;color:var(--oai-ink2);font-size:12px}
.oai-mig-note{margin:0;padding:9px 12px;border-radius:var(--oai-r-sm);${recessed('var(--oai-niche)')};font-size:13px;color:var(--oai-ink)}
.oai-mig-checking{display:grid;place-items:center;gap:14px;padding:18px 0 10px;text-align:center}
.oai-mig-spin{display:inline-block;width:16px;height:16px;border-radius:50%;border:2px solid color-mix(in srgb,var(--oai-cyan) 30%,transparent);border-top-color:var(--oai-accent);animation:oai-mig-spin .8s linear infinite}
.oai-mig-checking .oai-mig-spin{width:30px;height:30px;border-width:3px}
@keyframes oai-mig-spin{to{transform:rotate(360deg)}}
.oai-mig-found{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:var(--oai-r-sm);${recessed('var(--oai-niche)')};margin-bottom:14px}
.oai-mig-found>span:last-child{display:grid;line-height:1.3}
.oai-mig-found strong{font:var(--bt-weight-strong,700) 13.5px/1.3 var(--oai-head)}
.oai-mig-found small{font-size:11.5px;color:var(--oai-ink2)}
.oai-mig-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--oai-warn);box-shadow:inset 1px 1px 1px rgba(255,255,255,.5),0 0 0 3px color-mix(in srgb,var(--oai-warn) 18%,transparent)}
.oai-mig-dot[data-on=on]{background:var(--oai-ok);box-shadow:inset 1px 1px 1px rgba(255,255,255,.5),0 0 0 3px color-mix(in srgb,var(--oai-ok) 20%,transparent)}
.oai-mig-do{list-style:none;counter-reset:oai-mig-do;margin:0 0 14px;padding:0;display:grid;gap:11px}
.oai-mig-do li{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;font-size:13.5px;line-height:1.5;color:var(--oai-ink2)}
.oai-mig-do li::before{counter-increment:oai-mig-do;content:counter(oai-mig-do);display:grid;place-items:center;width:26px;height:26px;border-radius:50%;${raised('var(--oai-clay)', 2)};color:var(--oai-ink);font:var(--bt-weight-title,800) 12px/1 var(--oai-head)}
.oai-mig-do b{color:var(--oai-ink);font-weight:600}
.oai-mig-do-text{display:block;min-width:0}
.oai-mig-pick{display:grid;gap:7px;margin:0 0 14px}
.oai-mig-label{font:var(--bt-weight-title,700) 10.5px/1 var(--oai-head);letter-spacing:.14em;text-transform:uppercase;color:var(--oai-ink2)}
.oai-mig-bots{display:flex;flex-wrap:wrap;gap:8px}
.oai-card button.oai-mig-botpick{display:inline-flex;align-items:center;gap:7px;width:auto;min-height:34px;margin:0;padding:6px 13px;border-radius:999px;${raised('var(--oai-card)', 2)};color:var(--oai-ink);font:inherit;font-size:13px;font-weight:600}
.oai-mig-botpick small{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--oai-cyan-ink);background:color-mix(in srgb,var(--oai-cyan) 55%,var(--oai-card));border-radius:999px;padding:2px 6px}
.oai-card button.oai-mig-botpick.is-on{${raised('var(--oai-lilac)', 3)};color:var(--oai-lilac-ink)}
.oai-card button.oai-mig-botpick.is-on .oai-mig-dot{background:var(--oai-lilac-ink)}
.oai-card label.oai-mig-agree{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;margin:0 0 4px;font-size:13px;color:var(--oai-ink);padding:11px 12px;border-radius:var(--oai-r-sm);${recessed('var(--oai-niche)')};color:var(--oai-ink);font-size:13px;line-height:1.45;cursor:pointer;margin:0 0 4px}
.oai-mig-agree input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.oai-mig-box{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px 8px 7px 8px;${raised('var(--oai-card)', 2)};color:transparent;transition:background-color .15s ease,color .15s ease}
.oai-mig-agree input:checked+.oai-mig-box{${raised('var(--oai-cyan)', 2)};color:var(--oai-cyan-ink)}
.oai-mig-agree input:focus-visible+.oai-mig-box{outline:3px solid var(--oai-ring);outline-offset:2px}
.oai-mig-key{display:flex;align-items:center;gap:13px;padding:12px 14px;border-radius:var(--oai-r-sm);${recessed('color-mix(in srgb,var(--oai-lilac) 34%,var(--oai-niche))')};margin-bottom:15px}
.oai-mig-lock{position:relative;flex:none;width:34px;height:30px;display:grid;place-items:end center;padding-bottom:2px}
.oai-mig-lock i{display:block;width:26px;height:20px;border-radius:6px 7px 5px 7px;${raised('var(--oai-lilac)', 2)};position:relative}
.oai-mig-lock::before{content:"";position:absolute;top:1px;left:50%;transform:translateX(-50%);width:16px;height:14px;border:3px solid color-mix(in srgb,var(--oai-lilac-ink) 55%,var(--oai-lilac));border-bottom:0;border-radius:9px 9px 0 0}
.oai-mig-keytext{display:grid;gap:2px;line-height:1.35;min-width:0}
.oai-mig-keytext strong{font:var(--bt-weight-strong,700) 13px/1.35 var(--oai-head);color:var(--oai-ink)}
.oai-mig-keytext span{font-size:11.5px;color:var(--oai-ink2)}
.oai-mig-dots{margin-top:5px;letter-spacing:.28em;color:color-mix(in srgb,var(--oai-lilac-ink) 55%,transparent);font-size:12px;line-height:1}
.oai-mig-steps{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:3px}
.oai-mig-steps li{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;padding:7px 0}
.oai-mig-bead{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;${recessed('var(--oai-niche)')};color:var(--oai-ink2);font:var(--bt-weight-title,800) 12px/1 var(--oai-head)}
.oai-mig-steps li[data-state=done] .oai-mig-bead{${raised('var(--oai-ok)', 1)};color:var(--oai-card)}
.oai-mig-steps li[data-state=now] .oai-mig-bead{${raised('var(--oai-cyan)', 1)}}
.oai-mig-steps li[data-state=failed] .oai-mig-bead{${raised('var(--oai-bad)', 1)};color:var(--oai-card)}
.oai-mig-step{display:grid;gap:2px;line-height:1.35;padding-top:3px}
.oai-mig-step strong{font-weight:600;color:var(--oai-ink2);font-size:13px}
.oai-mig-steps li[data-state=now] .oai-mig-step strong,.oai-mig-steps li[data-state=done] .oai-mig-step strong{color:var(--oai-ink)}
.oai-mig-step small{font-size:11.5px;color:var(--oai-ink2)}
.oai-mig-botbox{display:flex;align-items:center;gap:14px;padding:14px;border-radius:20px 23px 19px 22px;${raised('var(--oai-card)', 4)};margin:2px 0 14px}
.oai-mig-bigmark{flex:none;width:50px;height:50px;display:grid;place-items:center;border-radius:14px 16px 13px 15px;${raised('var(--oai-cyan)', 3)};color:var(--oai-cyan-ink);font:var(--bt-weight-title,800) 15px/1 var(--oai-head);letter-spacing:.04em}
.oai-mig-botwho{display:grid;gap:3px;min-width:0}
.oai-mig-botwho>strong{font:var(--bt-weight-title,800) 18px/1.2 var(--oai-head);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oai-mig-botwho>span{font-size:11.5px;color:var(--oai-ink2)}
.oai-mig-status{justify-self:start;display:inline-flex;align-items:center;gap:7px;margin-top:3px;padding:4px 10px;border-radius:999px;${recessed('var(--oai-niche)')};font-size:11.5px;font-weight:600;color:var(--oai-ink)}
.oai-mig-statusdot{width:8px;height:8px;border-radius:50%;background:var(--oai-warn);animation:oai-mig-pulse 1.6s ease-in-out infinite}
.oai-mig-status[data-state=connected] .oai-mig-statusdot{background:var(--oai-ok);animation:none}
@keyframes oai-mig-pulse{0%,100%{opacity:.45}50%{opacity:1}}
.oai-mig-sayhi{justify-self:start;margin:0 0 12px;text-decoration:none;font-size:13px;gap:7px}
.oai-mig-answer{display:flex;align-items:center;gap:6px;margin:2px 0 12px;font-size:12.5px;color:var(--oai-ok);font-weight:600}
.oai-mig-warn{display:grid;gap:7px;padding:12px 14px;border-radius:var(--oai-r-sm);${recessed('color-mix(in srgb,#f2c25b 30%,var(--oai-niche))')};margin:0 0 14px;font-size:12.5px;line-height:1.45;color:var(--oai-ink)}
.oai-mig-warn strong{font-size:13px;font-weight:600}
.oai-card button.oai-mig-soft{justify-self:start;width:auto;min-height:34px;margin:2px 0 0;padding:7px 14px;font-size:12.5px;${raised('var(--oai-card)', 2)};color:var(--oai-ink)}
.oai-mig-summary{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--oai-ink2);margin:0 0 14px}
.oai-mig-problem{display:grid;gap:10px}
.oai-mig-problem .oai-actions{flex-wrap:wrap}
.oai-mig-error{margin:0;color:var(--oai-bad);font-size:13.5px;line-height:1.5}
.oai-mig-handoff{display:grid;gap:12px}
.oai-card .oai-mig-handoff h2{margin:0;font:var(--bt-weight-title,800) 19px/1.25 var(--oai-head);letter-spacing:-.016em}
@media (max-width:520px){.oai-mig-grid{grid-template-columns:1fr}.oai-mig-botbox{gap:11px}}
@media (prefers-reduced-motion:reduce){.oai-mig-tool,.oai-mig-arrow,.oai-mig-box,.oai-mig-spin,.oai-mig-statusdot{transition:none!important;animation:none!important}.oai-mig-statusdot{opacity:1}}
`
