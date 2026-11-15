import { createElement as h, useId, useRef, useState, useSyncExternalStore } from 'react'
import { AUTO, AUTO_ROW } from '../shared/permission-levels.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'
import { needsModelPick } from './model-menu.js'
import { AutoMissingNote, autoConfirmText, remoteConfirmText, remoteOfBot, RemotePermissionNote, autoQuestion, savedLevelOf, levelsOf, pickLevel, PermissionFallback, cliAuto, cliConfirmText, cliOfBot, PermissionOptions, presetDanger, presetName } from './permission-picker.js'
import { setEntry, sharedMap } from './shared-map.js'
import { createSource } from './sources.js'
import { STORAGE } from './storage.js'
import { currentPart } from './text.js'

// -------------------------------------------------------------------------
// The permission choice in a Bot's chat: every level the catalog offers with what it does,
// for a Bot the person has not chosen a level for yet. The card is this window's own: the
// app raises it, no tool, message or channel does, and nothing the Bot sends can answer it.
// A level is saved only by the person pressing Save (and the second question for Auto review
// and Full access), through the same updateBot the Details list uses. Left alone, dismissed
// or answered "Not now", it sends nothing: the Bot stays on the level it already runs at.

// Bots the person answered or put off, kept in this browser: { [Bot id]: true }.
const askedStore = () => sharedMap(STORAGE.permissionAsked)
const asked = createSource(null)
const askedNow = () => asked.getSnapshot() ?? askedStore().read()
const markAsked = id => asked.set(askedStore().update(map => setEntry(map, id, true), askedNow()))
// Bots whose card the person opened again from Details, in this window only.
const reopened = createSource({})
export const reopenPermissionChoice = id => reopened.set(map => setEntry(map, id, true))
const closeReopened = id => reopened.set(map => setEntry(map, id, undefined))

const FOOTNOTE = 'You can change this any time in Details.'

function PermissionCard({ bot, catalog, roster, actions, onClose, onSaved }) {
  catalog = levelsOf(catalog, bot)
  const saved = savedLevelOf(bot, catalog)
  const askedAtOpen = useRef()
  // The row marked follows the level in force until the person picks one.
  const [picked, setPicked] = useState(undefined)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const titleId = useId()
  const draft = picked ?? saved
  // A Bot on a coding CLI explains Full access in that CLI's words.
  const cli = cliOfBot(bot)
  const remote = remoteOfBot(bot)
  const auto = cliAuto(draft, cli)
  const offered = catalog.options.some(option => option.value === draft)
  const asks = draft === AUTO_ROW || draft === AUTO || presetDanger(draft)
  // Nothing picked on a Bot that has a level: there is nothing to save, and a level
  // narrowed elsewhere meanwhile is never sent back as it was.
  const unchanged = picked === undefined && bot.permission !== undefined
  const send = () => {
    if (busyRef.current || !offered) return
    if (unchanged) { onClose(); return }
    busyRef.current = true
    setBusy(true)
    setError('')
    void Promise.resolve().then(() => pickLevel(actions, bot, draft, askedAtOpen.current)).then(onSaved, (failure) => {
      setConfirming(false)
      setError(failure?.message ?? String(failure))
    }).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }
  const note = h('div', { className: 'bt-note' }, t(FOOTNOTE))
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  // The question holds for the level it was asked about, and only while DSH still offers it.
  if (confirming !== false && confirming === draft && offered) {
    const name = presetName(draft, catalog)
    return h('form', { className: 'bt-q', role: 'alert', 'aria-labelledby': titleId, 'aria-busy': busy || undefined, 'data-permission-confirm': draft, onSubmit: event => event.preventDefault() },
      h('div', { className: 'bt-q-head' },
        h('div', { className: 'bt-q-text' },
          h('p', { className: 'bt-q-title', id: titleId }, draft === AUTO_ROW ? t('Put {name} on Auto?', { name: bot.name }) : draft === AUTO ? name : t('Give {name} full access?', { name: bot.name })),
          draft === AUTO_ROW ? h('div', { className: 'bt-q-detail' }, ...autoQuestion(bot.name, presetName(bot.permission ?? catalog.defaultPreset, catalog), { ...bot.autoJudge, agent: String(bot.model ?? '').split('/')[0] }).map(text => h('div', { className: 'bt-note' }, text))) : draft === AUTO
            ? h('div', { className: 'bt-q-detail' }, autoConfirmText(remote))
            : h('div', { className: 'bt-q-detail' },
              h('span', { className: 'bt-danger' }, remote ? remoteConfirmText(remote) : auto ? cliConfirmText(cli) : t('{name} will run commands and change files anywhere without asking you first.', { name: bot.name })),
              ' ', t('Choose it only when you trust what you asked for.')))),
      h(RemotePermissionNote, { remote }),
      note,
      h('div', { className: 'bt-q-foot' },
        // Focus goes to Cancel, never to the button that gives the access.
        h('button', { type: 'button', className: 'bt-q-btn', autoFocus: true, disabled: busy, onClick: () => setConfirming(false) }, t('Cancel')),
        // Never the second press of a double click on Save, which sat in this place.
        h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: (event) => { if (!(event.detail > 1)) send() } }, draft === AUTO_ROW ? t('Use Auto') : draft === AUTO ? t('Use Auto review') : t('Give full access'))))
  }
  return h('form', {
    className: 'bt-q', 'aria-labelledby': titleId, 'aria-busy': busy || undefined, 'data-permission-card': bot.id,
    onSubmit: (event) => {
      event.preventDefault()
      if (busy || !offered) return
      if (asks && !unchanged) { askedAtOpen.current = { id: bot.id, rev: bot.permissionRev ?? 0 }; setConfirming(draft) }
      else send()
    },
  },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title', id: titleId }, `${t('Permissions')} · `, t('What may {name} do on its own?', { name: bot.name })),
        h('div', { className: 'bt-q-detail' }, t('You choose. Nothing changes until you save.'))),
      h('button', { type: 'button', className: 'bt-q-x', 'aria-label': t('Dismiss'), title: t('Dismiss'), onClick: onClose, disabled: busy }, h(CloseIcon))),
    h(PermissionOptions, { catalog, current: draft, onPick: (value) => { setError(''); setPicked(value) }, disabled: busy, cli, remote }),
    errorLine,
    bot.permissionAuto ? h(PermissionFallback, { fallback: bot.permissionFallback, owner: bot, catalog }) : null,
    h(AutoMissingNote, { bot, roster }),
    note,
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', onClick: onClose, disabled: busy }, t('Not now')),
      h('button', { type: 'submit', className: 'bt-q-submit', disabled: busy || !offered }, t('Save'))))
}

// Above the composer of the Bot's own current chat. A window that can only view the team
// shows no card; a Bot still waiting for its model asks for that first.
export function PermissionChoiceDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const again = useSyncExternalStore(reopened.subscribe, reopened.getSnapshot)
  useSyncExternalStore(asked.subscribe, asked.getSnapshot)
  const bot = roster.byId[sessionId]
  const catalog = roster.permissions
  if (!bot || !roster.ready || roster.readOnly || currentPart(bot) !== sessionId) return null
  if (!catalog?.options?.length || needsModelPick(bot, roster)) return null
  // A Bot whose plugin runs its own engine is not asked: these words describe DSH's levels.
  if (roster.hostModels?.[bot.id] !== undefined) return null
  const wanted = again[bot.id] === true
  if (!wanted && (bot.permission !== undefined || askedNow()[bot.id] === true)) return null
  // Put off, dismissed or saved, the card does not come back on its own for this Bot.
  const close = () => { markAsked(bot.id); closeReopened(bot.id) }
  return h('div', { className: 'bt-q-dock' }, h(PermissionCard, { key: bot.id, bot, catalog, roster, actions, onClose: close, onSaved: close }))
}
