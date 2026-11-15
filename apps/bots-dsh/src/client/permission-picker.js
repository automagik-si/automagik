import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AUTO, AUTO_ROW, MARK_LEVEL, markOf, judgeOf } from '../shared/permission-levels.js'
import { Segmented } from './motion.js'
import { CheckIcon } from './icons.js'
import { CLI_NAMES, cliProviderOf } from './cli-login-model.js'
import { ACP_NAME, Caret, useAnchoredMenu } from './model-menu.js'
import { t } from './i18n.js'

const LABELS = { [AUTO_ROW]: 'Auto', 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access', [AUTO]: 'Auto review' }
const DANGER = new Set(['danger-full-access'])

export const presetDanger = value => DANGER.has(value)

// Remote tools keep the remote computer's rules; a local file sandbox cannot contain them.
export const remoteOfBot = bot => {
  const remote = ref => typeof ref === 'string' && ref.startsWith('hermes-remote/')
  const selected = remote(bot?.model), applied = remote(bot?.appliedModel)
  if (bot?.model && bot?.appliedModel && selected !== applied) return 'mixed'
  return selected || applied
}

// A Bot whose model runs on a coding CLI (Claude Code, Codex): there Full access is the CLI's
// own no-ask mode, explained by the CLI's name. `mode` is the CLI's own word for that mode.
// The stored level is the same one (danger-full-access): only the explanation differs, and
// only for such a Bot. Both the model saved for the Bot and the one last applied to its
// Sessions must be on that CLI: a Bot saved on Codex that answers on another
// model (its CLI not served, a move not applied yet) runs DSH's own tools there, so "the CLI
// decides" would be false. Undefined for any other Bot.
const CLI_MODES = { 'acp-claude': 'bypass permissions', 'acp-codex': 'full access' }
export const cliOfBot = (bot) => {
  const id = cliProviderOf(bot?.model)
  if (id === undefined || cliProviderOf(bot.appliedModel) !== id) return undefined
  return { id, name: CLI_NAMES[id], mode: CLI_MODES[id] }
}
const CLI_TEXT = '{cli} decides by itself and runs commands and changes files anywhere without asking you. Automagik asks it for its own "{mode}" mode, and does not review or ask. This holds while the Bot runs on {cli}.'
const CLI_CONFIRM = '{cli} will decide by itself and run without asking you. Automagik will ask it for its own "{mode}" mode, and will not review or ask. This holds while the Bot runs on {cli}.'
const cliWords = cli => ({ cli: cli.name, mode: cli.mode })
export const cliAuto = (value, cli) => cli !== undefined && presetDanger(value)
export const cliConfirmText = cli => t(CLI_CONFIRM, cliWords(cli))

export const presetName = (value, catalog) => (LABELS[value] ? t(LABELS[value]) : catalog?.options?.find(option => option.value === value)?.name ?? value)

// A saved Auto that runs as workspace-write where Auto cannot hold (`permissionFallback`).
// `owner.permissionNotOffered`: the saved level is one DeepSeek Harness no longer offers
// (#1001). The level stays saved and is not among the choices, so these lines name it,
// say what the Bot's conversation runs as now when the host knows (`permissionRuns`), and
// how it is settled. They only tell: nothing here saves or changes a level.
export function PermissionFallback({ fallback, owner, catalog }) {
  if (owner?.permissionNotOffered === true && typeof owner.permission === 'string') {
    const runs = typeof owner.permissionRuns === 'string' ? owner.permissionRuns : undefined
    return h(Fragment, null,
      h('div', { className: 'bt-note' }, t('Saved level: {level}. DeepSeek Harness no longer offers it.', { level: presetName(owner.permission, catalog) })),
      h('div', { className: 'bt-note' }, runs === undefined
        ? t('Each conversation keeps the level it has now, or a narrower one. Settings → Feedback lists them.')
        : t('This conversation runs as {level} now.', { level: presetName(runs, catalog) })),
      h('div', { className: 'bt-note' }, t('Pick a level to settle it. If DeepSeek Harness offers the saved level again, it is used again by itself.')))
  }
  return fallback ? h('div', { className: 'bt-note' }, t('Runs as Workspace here')) : null
}

// What each level really does, in plain words. DSH's `ask` does not ask before each action: a
// confined call runs at once, and the person is asked only when the Bot wants one action with
// wider access. The file rules cover writes, not the network. A level these do not name (a
// custom preset) shows what DSH's catalog says of it, or its name alone: nothing is made up.
const TEXTS = {
  [AUTO_ROW]: 'Works as Workspace. Where Workspace would ask you, Codex decides first, with its own reviewer: it runs the step, refuses it, or asks you.',
  'read-only': 'It cannot change files unless you allow that one action. It can still run commands and use the network and its other tools.',
  'workspace-write': 'Changes files inside its folder and a temporary folder without asking. For other files it asks you first. It can still run commands and use the network and its other tools.',
  [AUTO]: 'A model reviews each action first. You are asked only about the ones it stops. The rest run with full access, and it can let a wrong one through.',
  'danger-full-access': 'Runs commands and changes files anywhere without asking you. Choose it only when you trust what you asked for.',
}
const REMOTE_ASK = 'Automagik asks you before answering each Hermes approval question.'
const REMOTE_FULL = 'Automagik still asks you before answering each Hermes approval question. Full access does not answer for you.'
const REMOTE_AUTO = 'Automagik asks you before answering each Hermes approval question. Auto review does not review Hermes approval questions.'
// What Hermes asks is answered by the person at every level, a custom one included.
const REMOTE_CUSTOM = REMOTE_ASK
const REMOTE_FILES = 'Read only and Workspace differ only for files on this computer. Remote chats do not use those files.'
const MIXED_FILES = 'On Remote Hermes, these local file permissions do not apply.'
const REMOTE_LIMITS = 'Hermes runs tools on the other computer under its own rules. This computer’s file sandbox does not protect that computer.'
const MIXED_ASK = 'While this chat changes routes, Automagik asks you before answering each Hermes approval question. On a local route, this level’s file rules apply on this computer.'
const MIXED_FULL = 'While this chat changes routes, Automagik still asks you before answering each Hermes approval question. A local route runs commands and changes files without asking.'
const MIXED_AUTO = 'While this chat changes routes, Automagik asks you before answering each Hermes approval question. Auto review does not review Hermes approval questions. On a local route, a model reviews each action first, and you decide on the ones it stops.'
const MIXED_CUSTOM = 'This chat is changing routes. Automagik asks you before answering each Hermes approval question. On a local route, this level decides.'
const MIXED_EXPERIMENTAL = 'On a local route, Auto review is experimental and can allow or stop the wrong action.'
export const remoteConfirmText = remote => t(remote === 'mixed' ? MIXED_FULL : REMOTE_FULL)
export const autoConfirmText = (remote = false) => remote === 'mixed'
  ? `${t(MIXED_AUTO)} ${t(MIXED_EXPERIMENTAL)}`
  : t(remote ? REMOTE_AUTO : 'Auto review runs tools without a sandbox: a model reviews each call first, and you decide on the ones it stops. It is experimental, can let through or stop the wrong call, and uses more tokens.')
export const presetText = (value, catalog, cli, remote = false) => remote === 'mixed'
  ? t(value === 'danger-full-access' ? MIXED_FULL : value === AUTO ? MIXED_AUTO : ['read-only', 'workspace-write'].includes(value) ? MIXED_ASK : MIXED_CUSTOM)
  : remote
  ? t(value === 'danger-full-access' ? REMOTE_FULL : value === AUTO ? REMOTE_AUTO : ['read-only', 'workspace-write'].includes(value) ? REMOTE_ASK : REMOTE_CUSTOM)
  : value === AUTO_ROW ? catalog?.options?.find(option => option.value === value)?.description ?? t(TEXTS[AUTO_ROW]) : cliAuto(value, cli) ? t(CLI_TEXT, cliWords(cli)) : Object.hasOwn(TEXTS, value) ? t(TEXTS[value]) : String(catalog?.options?.find(option => option.value === value)?.description ?? '')

export function RemotePermissionNote({ remote }) {
  return remote ? h('div', { className: 'bt-note bt-remote-permission-note' }, `${t(remote === 'mixed' ? MIXED_FILES : REMOTE_FILES)} `, t(REMOTE_LIMITS)) : null
}

// A pick shows at once and holds until the saved value catches up, or falls back when
// `onPick` resolves false. `repick` lets the shown preset be picked again. Auto review is
// experimental: picking it asks once before it is sent, and so does Full access where
// `confirmFull` is set. `confirming` is the level waiting for that answer.
export function usePermissionPick({ saved, onPick, askedOf, repick = false, confirmFull = false }) {
  const asked = useRef()
  const [pending, setPending] = useState(null)
  const [confirming, setConfirming] = useState(false)
  // One save runs at a time. A pick made while one is in flight waits as `latest`
  // (newer ones overwrite it), so a request that settles cannot clear or reorder a
  // pick made after it; two saves never land out of order on the server.
  const flight = useRef({ value: undefined, latest: undefined })
  useEffect(() => {
    const flying = flight.current.value
    if (pending === saved && (flying === undefined || flying === pending)) setPending(null)
  }, [pending, saved])
  const send = (value) => {
    flight.current.value = value
    void Promise.resolve(onPick(value, asked.current)).then(done => done !== false, () => false).then((ok) => {
      const wanted = flight.current.latest
      flight.current.latest = undefined
      if (wanted !== undefined && !(wanted === value && ok)) { send(wanted); return }
      flight.current.value = undefined
      if (!ok) setPending(null)
    })
  }
  const current = pending ?? saved
  const asks = value => value === AUTO_ROW || value === AUTO || (confirmFull && presetDanger(value))
  const pick = (value, confirmed = false) => {
    if (value === current && !repick) return
    if (asks(value) && !confirmed) { asked.current = askedOf?.(); setConfirming(value); return }
    setConfirming(false)
    setPending(value)
    if (flight.current.value !== undefined) { flight.current.latest = value; return }
    send(value)
  }
  return { current, pick, confirming, asks, cancel: () => setConfirming(false) }
}

// The question asked before Auto review or Full access is sent; `name` is the Bot it is for.
export function PermissionConfirm({ value, name, replaced, cli, remote, judge, onConfirm, onCancel }) {
  if (value === AUTO_ROW) {
    return h('div', { className: 'bt-perm-confirm', role: 'alert' },
      h('span', { className: 'bt-note' }, t('Put {name} on Auto?', { name })),
      ...autoQuestion(name, replaced, judge).map(text => h('span', { className: 'bt-note' }, text)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onConfirm }, t('Use Auto')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')))
  }
  if (value === AUTO) {
    return h('div', { className: 'bt-perm-confirm', role: 'alert' },
      h('span', { className: 'bt-note' }, autoConfirmText(remote)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onConfirm }, t('Use Auto review')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')))
  }
  if (remote) {
    return h('div', { className: 'bt-perm-confirm', role: 'alert' },
      h('span', { className: 'bt-note' }, h('span', { className: 'bt-danger' }, name === undefined ? remoteConfirmText(remote)
        : `${t('Give {name} full access?', { name })} ${remoteConfirmText(remote)}`)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onConfirm }, t('Give full access')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')))
  }
  // A Bot on a coding CLI: the same question, in the words of what that CLI does there.
  if (cliAuto(value, cli)) {
    return h('div', { className: 'bt-perm-confirm', role: 'alert' },
      h('span', { className: 'bt-note' }, h('span', { className: 'bt-danger' }, name === undefined ? cliConfirmText(cli)
        : `${t('Give {name} full access?', { name })} ${cliConfirmText(cli)}`)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onConfirm }, t('Give full access')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')))
  }
  return h('div', { className: 'bt-perm-confirm', role: 'alert' },
    h('span', { className: 'bt-note' }, h('span', { className: 'bt-danger' }, name === undefined ? presetText(value)
      : `${t('Give {name} full access?', { name })} ${t('{name} will run commands and change files anywhere without asking you first.', { name })}`)),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onConfirm }, t('Give full access')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')))
}

// The presets DeepSeek Harness offers, as one segmented choice; Auto review only while
// DSH offers it (usePermissionPick).
export function PermissionPicker({ catalog, saved, onPick, repick = false, confirmFull = false }) {
  const { current, pick, confirming, cancel } = usePermissionPick({ saved, onPick, repick, confirmFull })
  const choice = h(Segmented, { label: t('Permissions'), value: current },
    catalog.options.map(option => h('button', {
      key: option.value, type: 'button', 'aria-pressed': option.value === current,
      title: option.description, onClick: () => pick(option.value),
      className: presetDanger(option.value) ? 'bt-perm-danger' : undefined,
    }, presetName(option.value, catalog), option.value === AUTO ? h('span', { className: 'bt-perm-exp' }, t('Experimental')) : null)))
  if (!confirming) return choice
  return h(Fragment, null, choice,
    h(PermissionConfirm, { value: confirming, onConfirm: () => pick(confirming, true), onCancel: cancel }))
}

// Every level the catalog offers, in its order, each with what it does: the current one
// marked, Full access in the danger ink. No letter keys: a stray key never moves a level.
// `cli`: the Bot's coding CLI (cliOfBot), when it runs on one.
export function PermissionOptions({ catalog, current, onPick, disabled = false, cli, remote = false }) {
  return h(Fragment, null, h('div', { className: 'bt-q-list', role: 'group', 'aria-label': t('Permissions') },
    catalog.options.map((option) => {
      const danger = presetDanger(option.value) ? ' bt-danger' : ''
      const text = presetText(option.value, catalog, cli, remote)
      return h('button', {
        key: option.value, type: 'button', className: 'bt-q-opt', disabled,
        'aria-pressed': option.value === current, 'data-permission': option.value,
        onClick: () => onPick(option.value),
      },
      h('span', { className: 'bt-q-body' },
        h('span', { className: `bt-q-label${danger}` }, presetName(option.value, catalog), option.value === AUTO ? h('span', { className: 'bt-perm-exp' }, t('Experimental')) : null),
        text ? h('span', { className: `bt-q-desc${danger}` }, text) : null),
      option.value === current ? h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon)) : null)
    })), h(RemotePermissionNote, { remote }))
}

// The explained list as the picker itself (Details): a click saves, as a segment did, through
// the same one-save-at-a-time path; Auto review and Full access ask once first.
export function PermissionList({ catalog, saved, onPick, repick = false, disabled = false, name, cli, remote = false, askedOf, replaced, judge }) {
  const { current, pick, confirming, cancel } = usePermissionPick({ saved, onPick, askedOf, repick, confirmFull: true })
  return h(Fragment, null,
    h(PermissionOptions, { catalog, current, onPick: value => pick(value), disabled, cli, remote }),
    confirming && !disabled ? h(PermissionConfirm, { value: confirming, name, replaced, cli, remote, judge, onConfirm: (event) => { if (event?.detail > 1) return; pick(confirming, true) }, onCancel: cancel }) : null)
}

// Details keeps the pick and its save queue mounted while the explained menu opens and closes.
export function PermissionSelect({ catalog, saved, onPick, repick = false, disabled = false, name, cli, remote = false, askedOf, replaced, judge }) {
  const { current, pick, confirming, asks, cancel } = usePermissionPick({ saved, onPick, askedOf, repick, confirmFull: true })
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu({ minWidth: Math.min(380, window.innerWidth - 24) })
  useEffect(() => {
    if (!isOpen && menu.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true })
    if (confirming && (!isOpen || disabled)) cancel()
  }, [isOpen, disabled, confirming])
  useEffect(() => {
    if (!isOpen) return
    const target = (!repick && !disabled && menu.current?.querySelector('.bt-q-opt[aria-pressed="true"]:not(:disabled)')) || menu.current
    target?.focus()
  }, [isOpen])
  useEffect(() => {
    if (isOpen && disabled) menu.current?.focus()
  }, [isOpen, disabled])
  const catalogValues = catalog.options.map(option => option.value).join(',')
  useEffect(() => {
    if (isOpen && document.activeElement === document.body) menu.current?.focus()
  }, [isOpen, catalogValues])
  useEffect(() => {
    if (isOpen && confirming) menu.current?.querySelector('.bt-perm-confirm')?.scrollIntoView?.({ block: 'nearest' })
  }, [isOpen, confirming])
  const finish = () => { close(); button.current?.focus({ preventScroll: true }) }
  const choose = (value) => {
    if (disabled) return
    if (value === current && !repick) { finish(); return }
    pick(value)
    if (!asks(value)) finish()
  }
  const onConfirm = (event) => { if (event?.detail > 1) return; pick(confirming, true); finish() }
  const onCancel = () => {
    const row = menu.current?.querySelector(`.bt-q-opt[data-permission="${confirming}"]:not(:disabled)`)
    cancel()
    ;(row ?? menu.current)?.focus()
  }
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')]
    const first = buttons[0]
    const last = buttons.at(-1)
    const active = document.activeElement
    if (!first || (event.shiftKey ? active === first || active === menu.current : active === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last ?? menu.current : first ?? menu.current).focus()
    }
  }
  const level = presetName(current, catalog)
  const text = catalog.options.some(option => option.value === current) ? presetText(current, catalog, cli, remote) : ''
  const danger = presetDanger(current)
  return h(Fragment, null,
    h('button', {
      ref: button, className: 'bt-model-trigger', 'data-wide': true, type: 'button',
      'aria-haspopup': 'dialog', 'aria-expanded': isOpen, 'aria-label': t('Permissions: {level}', { level }),
      onClick: () => { if (isOpen) finish(); else open() },
    }, h('span', { className: 'bt-model-copy' }, h('span', { className: `bt-model-name${danger ? ' bt-danger' : ''}` }, level)), h(Caret)),
    text ? h('div', { className: 'bt-note' }, danger ? h('span', { className: 'bt-danger' }, text) : text) : null,
    !shownPlace ? h(RemotePermissionNote, { remote }) : null,
    shownPlace ? createPortal(h('div', {
      ref: menu, className: `bt-menu bt-permission-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'dialog', 'aria-label': t('Permissions'), tabIndex: -1, style: shownPlace, 'data-leaving': leaving || undefined, onKeyDown,
      onClickCapture: (event) => { if (event.detail > 1 && event.target.closest('.bt-q-opt')) event.stopPropagation() },
    }, h(PermissionOptions, { catalog, current, onPick: choose, disabled, cli, remote }),
    confirming && !disabled ? h(PermissionConfirm, { value: confirming, name, replaced, cli, remote, judge, onConfirm, onCancel }) : null), document.body) : null)
}

// What every offered level does, as plain lines: for the places that keep the segmented choice.
export function PermissionExplanations({ catalog }) {
  return h('div', { className: 'bt-perm-about' }, catalog.options.map((option) => {
    const text = presetText(option.value, catalog)
    return h('div', { key: option.value, className: 'bt-note' },
      h('span', { className: presetDanger(option.value) ? 'bt-danger' : undefined }, presetName(option.value, catalog)), text ? `: ${text}` : null)
  }))
}

export const savedLevelOf = (bot, catalog) => bot.permission === MARK_LEVEL && typeof bot.permissionAuto === 'string' ? AUTO_ROW : bot.permission ?? catalog.defaultPreset
export function levelsOf(catalog, bot) {
  if (!catalog) return catalog
  if (bot?.autoOffered !== true && typeof bot?.permissionAuto !== 'string') return catalog
  return { ...catalog, options: catalog.options.flatMap(option => option.value === MARK_LEVEL ? [option, { value: AUTO_ROW, name: 'Auto', description: autoRowText(bot.autoJudge) }] : [option]) }
}
// Why a Bot's pickers show no Auto row, from what the window already knows (RFC 0031). Nothing
// when the row is there (offered, or saved), when this window cannot change levels, or while a
// saved level DeepSeek Harness no longer offers is being told (PermissionFallback has that space).
export function autoMissingText(bot, roster) {
  if (!bot || bot.autoOffered === true || typeof bot.permissionAuto === 'string') return undefined
  if (roster?.readOnly || bot.permissionNotOffered === true) return undefined
  if (roster?.hostModels?.[bot.id] !== undefined) return t("This Bot runs on its plugin's own engine, so Auto is not offered.")
  if (typeof bot.model !== 'string' || bot.model === '') return t('Auto needs a model chosen for this Bot.')
  if (bot.model.startsWith('hermes-remote/')) return t('Auto is not offered on Remote Hermes.')
  const mark = markOf(bot.model)
  if (mark === undefined) return t("Auto is not offered for this Bot's model.")
  if (markOf(bot.appliedModel) !== mark) return t("Auto is offered once this Bot's chat runs on the model saved for it.")
  if (judgeOf(mark) === 'team' && !roster?.backgroundModel) return t('On this model, Auto needs a background model, and no connected model can be one. Connect a model with an API key to turn it on.')
  return t('Auto is not available for this Bot right now.')
}
export function AutoMissingNote({ bot, roster }) {
  const text = autoMissingText(bot, roster)
  return text ? h('div', { className: 'bt-note' }, text) : null
}

export const pickLevel = (actions, bot, value, asked) => value === AUTO_ROW ? actions.setBotAuto(asked.id, asked.rev) : actions.updateBot(bot.id, { permission: value })
export function autoRowText(judge) {
  const text = {"claude": "Works as Workspace. Where Workspace would ask you, Claude Code decides first, with its auto mode: it runs the step, refuses it, or asks you.", "own": "Works as Workspace. Where Workspace would ask you, {model}, this Bot's own model, decides first: it runs the step, refuses it, or asks you.", "team": "Works as Workspace. Where Workspace would ask you, {model}, the team's background model, decides first: it runs the step, refuses it, or asks you."}
  return t(text[judge?.by] ?? TEXTS[AUTO_ROW], { model: judge?.model })
}
export const autoQuestion = (name, level, judge) => {
  const by = judge?.by ?? 'codex'
  const words = { name, level, model: judge?.model, agent: ACP_NAME[judge?.agent] ?? judge?.agent }
  const first = {"own": "On Auto, {model}, {name}'s own model, decides in a separate request each step Workspace would ask you about, except plugin, folder and website changes: it runs the step, refuses it with a reason, or asks you. Commands and file changes stay in the sandbox, except a step it allows to leave it: that step may change files outside {name}'s folder without asking you.", "claude": "On Auto, Claude Code decides by itself, with its auto mode, which steps it runs, refuses or asks you about. Steps it runs with its own tools may change files outside {name}'s folder without asking you, and Automagik does not review them.", "team": "On Auto, {model}, the team's background model, decides each step {agent} asks you about: it runs the step, refuses it with a reason, or asks you. {agent} runs its own tools, so a step it allows may change files outside {name}'s folder without asking you."}
  const out = [by === 'codex' ? t("On Auto, Codex decides by itself, with its own reviewer, which steps it runs, refuses or asks you about. It may change files outside {name}'s folder without asking you, and Automagik does not review those steps.", { name }) : t(first[by], words)]
  if (judge?.bridged && judge.model && ['codex', 'claude'].includes(by)) out.push(t("When it uses DeepSeek Harness's tools, {model}, the team's background model, decides each call first and asks you when unsure. Those tools stay in the sandbox.", words))
  if (judge?.model && (['own', 'team'].includes(by) || judge.bridged)) out.push(t("{model} never decides hard-to-undo steps, such as deleting many files or a force push: they come to you, and so does the rest of a turn after three refusals in a row or ten in all.", words))
  out.push(t("Any message that reaches {name}'s chat can lead to such a step: yours, another Bot's or a schedule's. Tasks and Bots it starts from that chat while on Auto start on Auto too.", { name }))
  out.push(by === 'codex' ? t('This replaces {level}. Based on Codex 0.167.0; a later Codex may decide differently.', { level }) : t('This replaces {level}.', { level }))
  return out
}
