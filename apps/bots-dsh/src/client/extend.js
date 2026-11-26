// What other Omni plugins add to the Bot surface. The Omni channels and canvas plugins
// require this package's client bundle (`dsh.client.external`), so they share its one
// module instance: one interface dictionary, one roster, one set of these registries.
// Every `register` returns its disposer; a plugin that stops takes what it added along.
import { useSyncExternalStore } from 'react'
import { createSource } from './sources.js'

// A registry is a source over its entries, so the outlets that draw them re-render when
// a plugin loads after the surface is up.
function registry() {
  const source = createSource([])
  return {
    source,
    entries: () => source.getSnapshot(),
    register(entry) {
      source.set(list => [...list, entry].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)))
      return () => source.set(list => list.filter(item => item !== entry))
    },
  }
}

// The entries of a registry, for an outlet that re-renders when they change.
export const useEntries = list => useSyncExternalStore(list.source.subscribe, list.source.getSnapshot, list.source.getSnapshot)

// Tool cards: how the transcript draws one tool's call. `render(props)` gets the call's
// `{ call, tool, arg, argValue, done, content, sessionId, roster, actions }` and returns
// an element, or null to draw nothing; `render` null leaves the call undrawn. `phrase(arg)`
// is what the activity row says while it runs, `{ label, state }`. `asks`: the call can
// draw a card the user answers, which a dock above the composer also carries when the call
// is not drawn; drawn, the dock leaves it out. The last registration for a name wins.
const cards = registry()
const cardOf = name => cards.entries().findLast(entry => entry.names.includes(name))
export const toolCards = {
  source: cards.source,
  register: (names, render, { phrase, asks = false } = {}) => cards.register({ names: [names].flat(), render, phrase, asks }),
  renderer: name => cardOf(name)?.render ?? undefined,
  phrase: name => cardOf(name)?.phrase,
  asks: name => cardOf(name)?.asks === true,
}

// Sidebar nav: rows of the account menu, `{ id, label(), icon, run(actions), order }`.
export const nav = registry()
// Row badges: drawn at the end of a Bot's sidebar row, `Component({ bot, roster, useWork })`.
export const badges = registry()
// Rows under a Bot's row in the wide sidebar, `Component({ bot, roster, actions, wide,
// useSessions, useUi, useSessionStatus, useSessionRetainInfo, useActivity, useWork })`, the
// props of the Bot's own rows: a row drawn from them shows DSH's working, waiting and unread
// state, and `actions.openSession` folds the sidebar below 1024 px. The Omni channels plugin
// hangs the Omni Bot's channels and their chats there.
export const botChildren = registry()
// A Bot's channels as the new left bar draws them, one source per Bot:
// `{ id, order?, botId? or owns?(bot), useChannels(botId, { open }), open(chatId) }`.
// `useChannels` is a hook returning the channels (their chats only while `open`, i.e. the Bot's
// Session is shown or a channel of it is unfolded); `open` opens one of its chats. While a
// source serves a Bot its rows take the place of the team's own botChildren rows for it, never
// both, so a team with no source keeps today's rows. The bar only reads what the source returns.
export const botChannels = registry()
/** The one source serving a Bot: one naming its id wins over one that owns it. */
export const botChannelSource = (bot) => {
  if (!bot) return undefined
  const entries = botChannels.entries()
  return entries.findLast(entry => entry.botId === bot.id) ?? entries.findLast(entry => entry.owns?.(bot) === true)
}
// Header buttons: drawn in a Bot's chat header, `Component({ bot, roster, actions, useWork })`.
export const headerButtons = registry()
// Sidebar tools: buttons in the sidebar's top row, between the update cloud and Search, and in
// the collapsed rail under the cloud, `{ id, order, Component }` drawn as `Component({ wide,
// roster, actions, useRoster })`. They wear the row's own classes (.bt-round, and the update
// card's .bt-update-* for a popover); one that throws is left out and the row stays.
export const sidebarTools = registry()
// Bot settings: cards of a Bot's settings page, after its capabilities,
// `Component({ bot, roster, actions, run, Card, Row, SwitchRow })`.
export const botSettings = registry()

// Official install: how the Apps page's Omni and Genie rows install in place. The welcome
// registers { id, order, kinds, subscribe, version, pending, row, act, refresh }. The last
// entry wins. With no entry, the rows open the team step as before.
export const officialInstall = registry()

// Chat suggestions: what an empty chat offers above its composer, chips that fill it with a
// start the person finishes. `{ id, order, when?({ bot, roster }), items({ bot, roster }) }`:
// `when` picks the Bots it is for (a kind, one Bot), `items` returns `{ id, label, text,
// icon? }` with `icon` one of icons.js's names. Up to three show, lowest `order` first, so a
// plugin's own (order below 0) go before the team's (suggestions.js).
export const chatSuggestions = registry()

// Composer packs: what a Bot's composer offers for the AI the Bot runs on. The first pack
// (lowest `order`) that matches the Bot's provider and is available wins; none means
// Omni's own composer, which shows no permission, plan or model control. See
// composer-packs.js for the shape and the packs Omni brings (a plugin's own model menu, thinking levels).
export const composerPacks = registry()
export const registerComposerPack = pack => composerPacks.register(pack)

// Shell installers: each one runs while the Bot shell is up (Bot mode) and comes off with
// it, so what it registers follows the surface like Omni's own panels. It gets the
// surface's `face`, `shadow` (a slot registration on the shell) and `installStyles`, and
// returns its steps: functions that each mount one thing and return its disposer.
const installers = new Set()
let shell = null
const running = new Map()

function start(installer) {
  const disposers = []
  try {
    for (const step of [installer(shell)].flat()) if (step) disposers.push(step())
  } catch (error) {
    console.warn('[ds-bot] shell installer', error)
  }
  running.set(installer, disposers)
}
function stop(installer) {
  const disposers = running.get(installer) ?? []
  running.delete(installer)
  for (const dispose of disposers.reverse()) {
    try { dispose?.() } catch (error) { console.warn('[ds-bot] shell installer', error) }
  }
}

export function onShell(installer) {
  installers.add(installer)
  if (shell !== null) start(installer)
  return () => {
    installers.delete(installer)
    stop(installer)
  }
}

// One step of the shell group (index.js): runs every installer, and withdraws them all
// when the shell comes off.
export function mountShellInstallers(tools) {
  shell = tools
  for (const installer of installers) start(installer)
  return () => {
    for (const installer of [...running.keys()]) stop(installer)
    shell = null
  }
}
