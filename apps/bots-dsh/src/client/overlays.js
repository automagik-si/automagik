import { Component, createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.js'
import { NewChat } from './new-chat.js'
import { ExchangeDialog } from './exchange.js'
import { VoiceMode } from './voice.js'
import { SettingsDialog } from './settings.js'
import { ContextMenu } from './context-menu.js'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.js'
import { frameLayout } from './frame-layout.js'
import { MemoryDialog } from './memory-panel.js'
import { useLinger } from './motion.js'

// How long a closing dialog or menu stays for its exit (see their [data-leaving] CSS).
const DIALOG_EXIT_MS = 160
const MENU_EXIT_MS = 120

// Every openMenu() makes a new menu object. Keying the menu by that object remounts it on
// every open — including a reopen at the same kind, id and place inside the 120ms exit
// linger — so a confirmation from the closed menu cannot answer a click in the new one.
const menuKeys = new WeakMap()
let nextMenuKey = 0
function menuKey(menu) {
  let key = menuKeys.get(menu)
  if (key === undefined) { key = ++nextMenuKey; menuKeys.set(menu, key) }
  return key
}

class OverlayBoundary extends Component {
  state = { instance: this.props.instance, leaving: this.props.leaving, failure: null }

  static getDerivedStateFromProps({ instance, leaving }, state) {
    if (instance === state.instance && leaving === state.leaving) return null
    // The failed child stays absent through its exit. A reopen can reuse the healthy
    // boundary's key, so clear the failure only when an open instance takes over.
    return { instance, leaving, failure: leaving ? state.failure : null }
  }

  static getDerivedStateFromError() { return { failure: {} } }

  componentDidCatch(error) {
    if (this.handled === this.state.failure) return
    this.handled = this.state.failure
    console.warn('[ds-bot] overlay', this.props.name, error)
    try { this.props.close() } catch { /* A failed close must not break the slot. */ }
  }

  render() { return this.state.failure ? null : this.props.children }
}

const overlay = (name, key, instance, close, child, leaving = false) =>
  createPortal(h(OverlayBoundary, { name, key, instance, close, leaving }, child), document.body)

export function Overlays({ useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useRegistry, useBrowserPages, useBrowserTabs, useBrowserHolds, useComputer, useUpdate, useFrame, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  useRegistry(value => value)
  // The Bot panel and the conversation share the window: the team's bar sits in the shell's
  // own sidebar, which keeps its own track, so no column of ours comes out of the room.
  const viewport = useFrame ? useFrame(value => value.viewport) : window.innerWidth
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  // An open panel follows the conversation in the main view. Only a change of the
  // main view moves it, so opening details for another id (Rename) is not undone.
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (ui.voice && ui.voice !== current) actions.closeVoice()
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = useMemo(() => ui.details ? {
    id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab, side: ui.side, instance: ui.panelInstance,
  } : null, [ui.details, ui.view, ui.renaming, ui.tab, ui.side, ui.panelInstance])
  // A panel that no longer fits folds away: its state stays open, it just is not
  // mounted — the usual exit plays and the webview goes with it — until the room
  // returns and it shows again on its own.
  const layout = frameLayout({
    viewport, sidebarWidth: 0, pref: 'hidden',
    panel: open ? { view: open.view, yielded: ui.panelYield === true } : null,
  })
  const shown = open !== null && layout.panel !== 'folded' ? open : null
  const [kept, setKept] = useState(shown)
  useEffect(() => {
    if (shown) { setKept(shown); return undefined }
    const timer = setTimeout(() => setKept(null), PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [shown])
  const pane = shown ?? kept
  const [settings, settingsLeaving] = useLinger(ui.settings, DIALOG_EXIT_MS)
  // The memory dialog shows a Bot's memory or a group chat's.
  const memoryOwner = (id) => {
    const bot = roster.byId[id]
    if (bot) return { id: bot.id, name: bot.name }
    const room = roster.roomsById[id]
    return room ? { id: room.id, name: room.name, group: true } : null
  }
  const [memory, memoryLeaving] = useLinger(ui.memory && memoryOwner(ui.memory) ? ui.memory : null, DIALOG_EXIT_MS)
  const owner = memory ? memoryOwner(memory) : null
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  return h(Fragment, null,
    pane ? overlay('BotPanel', 'panel', pane, () => actions.closePanel(pane),
      h(BotPanel, { pane, leaving: shown === null, room: layout.room, overlay: layout.panel === 'overlay', roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds, useComputer }), shown === null) : null,
    ui.newChat ? overlay('NewChat', `${ui.newChat}:${ui.newChatSection ?? ''}`, ui.newChatInstance,
      () => actions.closeNewChat(ui.newChat, ui.newChatSection ?? null, ui.newChatInstance),
      h(NewChat, { mode: ui.newChat, sectionId: ui.newChatSection ?? null, roster, actions })) : null,
    ui.palette ? overlay('CommandPalette', ui.palette.token, ui.palette, () => actions.closePalette(ui.palette.token, ui.palette),
      h(CommandPalette, { start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions })) : null,
    ui.exchange ? overlay('ExchangeDialog', 'exchange', ui.exchange, () => actions.closeExchange(ui.exchange),
      h(ExchangeDialog, { pair: ui.exchange, roster, actions })) : null,
    ui.voice ? overlay('VoiceMode', ui.voice, ui.voiceInstance, () => actions.closeVoice(ui.voice, ui.voiceInstance),
      h(VoiceMode, { sessionId: ui.voice, roster, actions, useSessions, useSessionStatus })) : null,
    menu ? overlay('ContextMenu', menuKey(menu), menu, () => actions.closeMenu(menu),
      h(ContextMenu, { menu, roster, actions, useWork, leaving: menuLeaving }), menuLeaving) : null,
    settings ? overlay('SettingsDialog', 'settings', settings, () => actions.closeSettings(settings),
      h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, leaving: settingsLeaving }), settingsLeaving) : null,
    owner ? overlay('MemoryDialog', owner.id, ui.memoryInstance, () => actions.closeMemory(owner.id, ui.memoryInstance),
      h(MemoryDialog, { owner, actions, leaving: memoryLeaving }), memoryLeaving) : null)
}
