import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, MicIcon, PaperclipIcon, PeopleIcon, PlusIcon, ShieldIcon, WaveIcon } from './icons.js'
import { BotMark } from './mark.js'
import { useLinger, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'
import { useAnchoredMenu } from './model-menu.js'
import { remoteOfBot, cliOfBot, PermissionList, PermissionFallback, savedLevelOf, levelsOf, pickLevel, presetName } from './permission-picker.js'
import { currentPart } from './text.js'

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()
const plusRow = (Icon, label, description, onClick, onMouseDown) => h('button', {
  type: 'button', role: 'menuitem', className: 'bt-plus-row', ...(onMouseDown ? { onMouseDown } : {}), onClick,
}, h(Icon), h('span', { className: 'bt-menu-label' }, label), h('span', { className: 'bt-plus-desc' }, description))

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => recognition.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = ({ continuous = true, onEnd } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    engine.lang = navigator.language || 'zh-CN'
    engine.interimResults = true
    engine.continuous = continuous
    engine.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
    }
    engine.onend = () => { setListening(false); recognition.current = null; onEnd?.() }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  return { listening, note, start, stop }
}

export function ComposerVoice({ sessionId, inputActions, actions, useUi }) {
  const dictation = useDictation((text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  // Reply from a message's hover toolbar quotes it into this composer.
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  useEffect(() => {
    if (!quote || !inputActions) return
    actions.clearQuote(quote.token)
    const excerpt = quote.text.replace(/\s+/g, ' ').trim()
    const line = `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
    inputActions.insertText(line, inputActions.captureInsertion())
    const box = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true]')
    if (box instanceof HTMLElement) {
      box.focus()
      const selection = window.getSelection()
      selection?.selectAllChildren(box)
      selection?.collapseToEnd()
    }
  }, [quote?.token])
  if (sessionId === undefined) return null
  // With the Voice Input plugin on, its own microphone sits in this composer.
  const pluginMic = actions.speech() !== undefined
  return h(Fragment, null,
    pluginMic ? null : h('button', {
      type: 'button', className: 'bt-mic', 'aria-label': dictation.listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': dictation.listening, title: dictation.listening ? t('Stop dictation') : t('Dictate'),
      onMouseDown: keepComposerFocus, onClick: () => (dictation.listening ? dictation.stop() : dictation.start()),
    }, h(MicIcon)),
    h('button', {
      type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      onMouseDown: keepComposerFocus, onClick: () => actions.openVoice(sessionId),
    }, h(WaveIcon, { size: 18 })),
    dictation.note ? h('span', { className: 'bt-mic-note', role: 'status' }, dictation.note) : null)
}

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu
// does not remount its mark on every keystroke.
export function menuIcons(roster) {
  const marks = new Map()
  return (row) => {
    if (!row.bot) return PeopleIcon
    const id = row.bot.id
    if (!marks.has(id)) marks.set(id, ({ size = 14 }) => h(BotMark, { bot: roster.getSnapshot().byId[id] ?? row.bot, size }))
    return marks.get(id)
  }
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another
// chat, or set a scheduled task for this chat. It stands in for the shell's command
// menu, whose plan, permission, model and compact rows reach past what Omni keeps
// for its Bots; "/" still opens that menu. Files go through the shell's own file
// input beside it.
// The permission level in the composer's one row: a shield and the level's name in the
// accent ink, always visible. It opens the same explained levels the Details list uses and
// saves through the same updateBot, with the one confirm step for Auto and Full access.
export function ComposerPermission({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId[sessionId]
  const catalog = levelsOf(roster.permissions, bot)
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu({ minWidth: 320 })
  if (!bot || !catalog?.options?.length || roster.readOnly || currentPart(bot) !== sessionId) return null
  const saved = savedLevelOf(bot, catalog)
  const cli = cliOfBot(bot)
  const name = presetName(saved, catalog)
  const title = t('Permissions: {level}', { level: name }) + (bot.permissionAuto && bot.permissionFallback ? ` · ${t('Runs as Workspace here')}` : '')
  const toggle = () => { if (isOpen) close(); else open() }
  const pick = (value, asked) => Promise.resolve(pickLevel(actions, bot, value, asked)).then(
    () => { close(); return true },
    (failure) => { actions.reportError?.(failure, 'permission'); return false },
  )
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-perm-chip', 'aria-haspopup': 'menu', 'aria-expanded': isOpen,
      'aria-label': title, title,
      onMouseDown: keepComposerFocus, onClick: toggle,
    },
    h(ShieldIcon, { size: 14 }),
    h('span', null, name)),
    shownPlace ? createPortal(h('div', {
      ref: menu, className: `bt-menu bt-menu-up bt-permission-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu', 'aria-label': t('Permissions'), style: shownPlace, 'data-leaving': leaving || undefined,
    }, h(PermissionList, { judge: { ...bot.autoJudge, agent: String(bot.model ?? '').split('/')[0] }, catalog, saved, onPick: pick, name: bot.name, cli, remote: remoteOfBot(bot), askedOf: () => ({ id: bot.id, rev: bot.permissionRev ?? 0 }), replaced: presetName(bot.permission ?? catalog.defaultPreset, catalog) }), bot.permissionAuto ? h(PermissionFallback, { fallback: bot.permissionFallback, owner: bot, catalog }) : null), document.body) : null)
}

export function ComposerPlus({ sessionId, inputActions, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(null) }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(null) } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // Hooks stay above the early return below: the roster may not know the Bot yet, and a
  // render that skips a hook breaks the composer's slot when the roster arrives.
  // Anchored to the "+" each render: the visible viewport can move (on-screen
  // keyboard) while the menu is open.
  const place = useMemo(() => {
    if (!shown || !button.current) return null
    const rect = button.current.getBoundingClientRect()
    return { left: rect.left, bottom: viewBottom() - rect.top + 8 }
  }, [shown, open, tick])
  const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id
  if (sessionId === undefined || target === undefined) return null
  const fileInput = () => button.current?.closest('[data-composer-card]')?.querySelector('input[type=file]')
  const toggle = () => {
    if (open) { setOpen(null); return }
    // Files go through the composer's own file input; a composer without one takes none.
    setOpen({ files: Boolean(fileInput()) })
  }
  const attach = () => {
    setOpen(null)
    fileInput()?.click()
  }
  const schedule = () => {
    setOpen(null)
    actions.openSettings('schedules', target)
  }
  // The chats open in the shell's "@" menu at the caret, so the pick lands where the
  // user was typing.
  const reference = () => {
    setOpen(null)
    actions.referenceChat(sessionId, inputActions?.captureInsertion?.())
  }
  const canReference = typeof inputActions?.captureInsertion === 'function' && actions.canReferenceChat()
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(open), onMouseDown: keepComposerFocus, onClick: toggle,
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-menu-up bt-plus-menu', role: 'menu', 'aria-label': t('Add'),
      style: place ?? {}, 'data-leaving': leaving || undefined,
    },
    shown.files ? plusRow(PaperclipIcon, t('Add photos & files'), t('Upload from computer'), attach) : null,
    canReference ? plusRow(ChatsIcon, t('Reference a chat'), t('Continue in another conversation'), reference, keepComposerFocus) : null,
    plusRow(ClockIcon, t('Scheduled task'), t('Run this chat later'), schedule)), document.body) : null)
}
