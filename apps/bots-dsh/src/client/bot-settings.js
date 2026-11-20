import { createElement as h, Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { paintCss } from './inks.js'
import { CHARACTERS, PICKER_SHAPES, PICKER_COLUMNS, CHARACTER_COLORS, SHAPES, shapeOf, bodyOf, maskBox, holes, nextMarkSerial } from './characters.js'
import { isMainOf } from './sources.js'
import { PencilIcon, ChevronRightIcon } from './icons.js'
import { BotMark } from './mark.js'
import { CharacterSelect } from './character-select.js'
import { ModelMenu, modelHint } from './model-menu.js'
import { settingsModelPicker } from './settings-model-picker.js'
import { FolderMenu } from './folder-menu.js'
import { BotSchedules } from './schedules.js'
import { BotCapabilitiesCard } from './capability-settings.js'
import { BotComputerCard } from './computer.js'
import { avatarImage } from './avatar-library.js'
import { botSettings, useEntries } from './extend.js'
import { useMemoryCount } from './memory-panel.js'
import { SPRING_SHAPE, SPRING_TAP, Segmented, spring } from './motion.js'
import { hostText, t } from './i18n.js'
import { useVoices } from './voice-settings.js'
import { cliProviderOf } from './cli-login-model.js'
import { CliAccounts } from './cli-accounts.js'
import { AdvancedSettings, ADVANCED_SETTINGS_CSS } from './advanced-settings.js'
import {
  attachedRoleIds, attachmentStatus, BUILTIN_ROLES, CHOOSE_NONE_FIRST, effectiveRoleIds, GENIE_ATTACH_REFUSAL,
  isPackageRoleId, packageAttachment, packageDeclarations, packageRecoveryId, ROLE_SOURCE_UNCONFIRMED, roleTagOf, rolesOn, sameRolePin,
} from '../shared/roles.js'
import { PeopleCard } from './people-card.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

// Settings save on blur or Enter, with no Save button; Escape puts the
// saved value back. A required field never saves empty.
export function InlineText({ label, value, placeholder, required = false, maxLength, multiline = false, onSave }) {
  const [draft, setDraft] = useState(null)
  const reverting = useRef(false)
  const commit = () => {
    const next = draft?.trim()
    setDraft(null)
    if (reverting.current) { reverting.current = false; return }
    if (next === undefined || next === (value ?? '') || (required && next === '')) return
    void onSave(next)
  }
  return h(multiline ? 'textarea' : 'input', {
    className: multiline ? 'bt-bs-input bt-bs-area' : 'bt-bs-input', value: draft ?? value ?? '', placeholder, maxLength, required, 'aria-label': label, spellCheck: false,
    onChange: event => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); reverting.current = true; event.currentTarget.blur() }
      if (event.key === 'Enter' && !multiline && !event.nativeEvent.isComposing) event.currentTarget.blur()
    },
  })
}

// One labelled card row with its control on the right, or below when `stack`.
export function Row({ label, hint, stack = false, children }) {
  return h('label', { className: stack ? 'bt-set-row bt-bs-row bt-bs-stack' : 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children)
}

export function Card({ title, children }) {
  return h('section', { className: 'bt-set-section' }, title ? h('h3', null, title) : null, h('div', { className: 'bt-set-card' }, children))
}

export function Switch({ on, label, disabled, onChange }) {
  return h('button', { type: 'button', role: 'switch', className: 'bt-switch', 'aria-checked': on, 'aria-label': label, disabled, onClick: () => onChange(!on) },
    h('span', { className: 'bt-switch-knob', 'aria-hidden': true }))
}

// A row with a switch. Not a label: a click on the copy must not flip it twice.
export function SwitchRow({ label, hint, on, disabled, onChange }) {
  return h('div', { className: 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    h(Switch, { on, label, disabled, onChange }))
}

// The selection ring of a picker cell follows the shape: a 1px line 3px outside it.
function ShapeRing({ shape, size }) {
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-ring-${nextMarkSerial()}`
  const def = shapeOf(shape)
  const unit = def.size / size
  const markup = `<defs><mask id="${maskId.current}" ${maskBox(def.size)}>${holes(def, `<g stroke="#000" stroke-width="${6 * unit}" stroke-linejoin="round">${bodyOf(def, '#000', true)}</g>`)}</mask></defs><g mask="url(#${maskId.current})" stroke="currentColor" stroke-width="${8 * unit}" stroke-linejoin="round">${bodyOf(def, 'currentColor', true)}</g>`
  return h('svg', { className: 'bt-ring', viewBox: `0 0 ${def.size} ${def.size}`, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: markup } })
}

// Every character shape, six to a row, then the color swatches.
export function CharacterGrid({ look, hasPhoto = false, onShape, onColor }) {
  const shapes = [...PICKER_SHAPES, ...Object.keys(SHAPES).filter(id => !Object.hasOwn(CHARACTERS, id))]
  if (!shapes.includes(look.shape)) shapes.push(look.shape)
  const rows = []
  for (let index = 0; index < shapes.length; index += PICKER_COLUMNS) rows.push(shapes.slice(index, index + PICKER_COLUMNS))
  return h(Fragment, null,
    h('div', { className: 'bt-shapes', role: 'group', 'aria-label': t('Character shape') }, rows.map((row, index) => h('div', { key: index, className: 'bt-shape-row' }, row.map(id => h('button', {
      key: id, type: 'button', className: 'bt-shape', 'aria-label': t(shapeOf(id).label), title: t(shapeOf(id).label), 'aria-pressed': !hasPhoto && look.shape === id,
      onClick: () => onShape(id),
    }, h(ShapeRing, { shape: id, size: 36 }), h(BotMark, { look: { shape: id, color: look.color }, size: 36 })))))),
    h('div', { className: 'bt-colors', role: 'group', 'aria-label': t('Character color') }, CHARACTER_COLORS.map(color => h('button', {
      key: color, type: 'button', className: 'bt-color', 'aria-label': t(capitalize(color)), title: t(capitalize(color)), 'aria-pressed': look.color === color,
      onClick: () => onColor(color),
    }, h('span', { style: { background: paintCss(color) } })))))
}

function MemoryCard({ bot, actions }) {
  const count = useMemoryCount(bot.id, actions)
  const label = count === null ? t('Loading…') : count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count })
  return h(Card, { title: t('Memory') },
    h('button', { type: 'button', className: 'bt-set-row bt-bs-row', 'aria-label': t("Manage {name}'s memory", { name: bot.name }), onClick: () => actions.openMemory(bot.id) },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, label)),
      h('span', { className: 'bt-mem-row-go' }, t('Manage'), h(ChevronRightIcon))))
}

const noSubscribe = () => () => {}

// A Bot's deny list as the settings field edits it: one exact tool name per line. A Bot
// without a list shows an empty field, which means every tool is allowed.
export function denyToolsText(bot) {
  return (Array.isArray(bot?.denyTools) ? bot.denyTools : []).join('\n')
}

// Comma or newline separated, trimmed, case kept: the host takes exact tool names. Empty
// entries are dropped, as the host drops them; the list is deduplicated in the field too.
export function parseDenyTools(text) {
  return [...new Set(String(text ?? '').split(/[\n,]+/).map(name => name.trim()).filter(Boolean))]
}

export function useRolePackageAction(run) {
  const [result, setResult] = useState(null)
  const [pending, setPending] = useState(false)
  const change = (action, id) => {
    setPending(true)
    setResult(null)
    return run(action(id).then(value => {
      if (value?.warnings?.length || value?.leftover) setResult(value)
    }).finally(() => setPending(false)))
  }
  return { result, pending, change }
}

export function rolePackageResult(result) {
  return result ? h('div', { className: 'bt-bs-shell-note', role: 'status' },
    result.warnings?.map(field => h('div', { key: field }, t('Ignored role manifest field: {field}', { field }))),
    result.leftover ? h('div', null, t('Role package folder left at {folder}.', { folder: result.leftover })) : null) : null
}

function RolePackagesCard({ roster, actions, run }) {
  const { result, pending, change } = useRolePackageAction(run)
  const records = roster.roles ?? {}
  const roles = new Map((roster.roleCatalog?.roles ?? []).map(role => [role.id, role]))
  for (const id of Object.keys(records)) {
    if (!roles.has(id)) roles.set(id, { id, name: id })
  }
  if (roles.size === 0 && !result && !pending) return null

  const attached = new Set((roster.bots ?? Object.values(roster.byId ?? {})).flatMap(attachedRoleIds))
  const readOnly = roleReadOnly(roster)
  return h(Card, { title: t('Roles') },
    [...roles.values()].map(role => {
      const record = Object.hasOwn(records, role.id) ? records[role.id] : undefined
      const inUse = record && attached.has(role.id)
      const hints = [
        record?.status === 'broken' && t('Broken'),
        record?.status === 'damaged' && t('Damaged'),
        inUse && t('Detach this role from every Bot before uninstalling it.'),
        !record && role.reason === 'community' && t('Community: not installable yet'),
      ].filter(Boolean)
      const version = record ? record.version : role.version
      const button = record
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending || readOnly || inUse,
          onClick: () => change(actions.uninstallRole, role.id) }, t('Uninstall'))
        : role.installable && h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending || readOnly,
          onClick: () => change(actions.installRole, role.id) }, t('Install'))
      return h(Row, { key: role.id, label: [role.name, version].filter(Boolean).join(' · '), hint: hints.join(' · ') }, button || null)
    }),
    rolePackageResult(result))
}

const roleHealthLabels = { broken: 'Broken', damaged: 'Damaged', missing: 'Missing', 'version-mismatch': 'Version mismatch' }
export const roleHealth = status => t(roleHealthLabels[status] ?? 'Details unavailable')
export const roleReadOnly = roster => Boolean(roster.readOnly) || roster.roleCatalog?.reason === 'read-only'

function RoleControls({ bot, runtime, actions, run, readOnly }) {
  const { pin } = runtime
  const voices = useVoices()
  const [values, setValues] = useState()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (readOnly || !runtime.settings.length) return
    let live = true
    void run(actions.roleSettings(bot.id, pin).then(value => { if (live) setValues(value) }))
    return () => { live = false }
  }, [bot.id, pin.id, pin.version, pin.attachedAt, readOnly])
  const change = (key, value) => {
    setValues(before => ({ ...before, [key]: value }))
    setDirty(true)
  }
  const save = () => {
    setSaving(true)
    void run(actions.setRoleSettings(bot.id, pin, values).then(value => {
      setValues(value)
      setDirty(false)
    }).finally(() => setSaving(false)))
  }
  const granted = bot.roles[0].grants.includes('audio-out')
  return h(Fragment, null,
    runtime.capabilities.includes('audio-out') ? h(SwitchRow, { label: t('Allow speech'), on: granted, disabled: readOnly,
      onChange: on => void run(actions.grantRole(bot.id, pin, 'audio-out', on)) }) : null,
    values ? runtime.settings.map(({ key, kind, label }) => {
      const name = label === 'Voice' ? t('Voice') : label === 'Speed' ? t('Speed') : label
      const value = values[key]
      return h(Row, { key, label: name },
        kind === 'voice'
          ? h('span', { className: 'bt-voice-set' },
            h('select', { className: 'bt-input', 'aria-label': name, value, disabled: readOnly || saving,
              onChange: event => change(key, event.target.value) },
            h('option', { value: '' }, t('Automatic, by language')),
            value && !voices.some(voice => voice.voiceURI === value) ? h('option', { value }, t('Saved voice unavailable')) : null,
            voices.map(voice => h('option', { key: voice.voiceURI, value: voice.voiceURI }, `${voice.name} (${voice.lang})`))))
          : h('span', { className: 'bt-voice-set' },
            h('input', { type: 'range', min: 0.5, max: 2, step: 0.1, value, 'aria-label': name, disabled: readOnly || saving,
              onChange: event => change(key, Number(event.target.value)) }),
            h('span', { className: 'bt-set-hint' }, `${Number(value.toFixed(2))}×`)))
    }) : null,
    dirty ? h(Row, null, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || saving, onClick: save }, t('Save'))) : null)
}

function PackageAttachmentCard({ roster, bot, pin, recoveryId, onDetach, actions, run }) {
  const declarations = pin && packageDeclarations(pin, roster)
  const health = pin && attachmentStatus(pin, roster.roles)
  const recover = !pin || health !== 'ok'
  const candidate = Object.hasOwn(roster.roleRuntime ?? {}, bot.id) ? roster.roleRuntime[bot.id] : undefined
  const runtime = !recover && rolesOn(roster.prefs) && sameRolePin(pin, candidate?.pin) ? candidate : undefined
  const healthReason = pin && Object.hasOwn(roster.roles ?? {}, pin.id) ? roster.roles[pin.id].reason : undefined
  return h(Card, { title: t('Role') },
    h(Row, {
      label: declarations?.name ?? (pin ? `${pin.id}@${pin.version}` : recoveryId),
      hint: [declarations?.name && `${pin.id}@${pin.version}`, recover && roleHealth(health ?? 'damaged')].filter(Boolean).join(' · '),
    }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: roleReadOnly(roster), onClick: onDetach }, t('Detach'))),
    h(Row, { label: runtime ? t('Active tools') : t('Declared tools'), hint: runtime ? undefined : t('Declared, not active yet'), stack: true },
      (runtime?.tools ?? declarations?.tools)?.join(', ') || (runtime || declarations?.tools ? t('None') : t('Details unavailable'))),
    runtime ? h(RoleControls, { key: `${bot.id}:${pin.attachedAt}`, bot, runtime, actions, run, readOnly: roleReadOnly(roster) })
      : h(Row, { label: t('Grants requested'), hint: declarations ? declarations.capabilities.join(', ') || t('None') : t('Details unavailable') }),
    !runtime && declarations?.fromCatalog ? h(Row, { label: t('From the catalog') }) : null,
    runtime?.acp ? h(Row, { label: t('ACP coding agents do not receive this role’s prompt.') }) : null,
    !runtime ? h(Row, { label: healthReason ? hostText(healthReason) : t('Its tools arrive with the role runtime.'),
      hint: recover ? t('Detach it from every Bot, uninstall, then install again.') : undefined }) : null)
}

// A Bot's settings as grouped cards: who it is (avatar, name, description, role), what it runs on
// (model), what it does (instructions), its memory and tasks, its Main Bot role, its
// sidebar place, and copies.
export function BotSettingsForm({ bot, roster = {}, actions, run }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const closeEditor = useCallback(() => setEditing(false), [])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const isMainBot = isMainOf(roster, bot.id)
  const onlyMain = isMainBot && (roster.mainBotIds ?? []).length === 1
  const isTile = roster.mainBotId === bot.id
  const inGroup = (roster.rooms ?? []).some(room => room.members?.includes(bot.id))
  const privateHint = t('Other Bots cannot read its folder, memory or chats, and you approve what it shares with them.')
  const privacyHint = bot.private === true ? privateHint : isMainBot ? t('A Main Bot cannot be private.') : inGroup ? t('Leave its group chats before making it private.') : !bot.workDir ? t('Choose a working folder of its own first.') : privateHint
  const save = patch => run(actions.updateBot(bot.id, patch))
  const teamBot = roster.bots?.some(item => item.id === bot.id)
    ?? (Object.hasOwn(roster.byId ?? {}, bot.id) && roster.byId[bot.id]?.id === bot.id)
  const showingRoles = teamBot && rolesOn(roster.prefs)
  const requestedRoleCatalog = useRef()
  useEffect(() => {
    if (!showingRoles || !actions.roleCatalog || requestedRoleCatalog.current === bot.id) return
    requestedRoleCatalog.current = bot.id
    void run(actions.roleCatalog())
  }, [showingRoles, bot.id])
  const pin = teamBot ? packageAttachment(bot) : undefined
  const recoveryId = teamBot ? packageRecoveryId(bot) : undefined
  const roleTag = showingRoles ? roleTagOf(bot, roster.prefs, roster, t) : undefined
  const rawIds = showingRoles ? attachedRoleIds(bot) : []
  const effective = showingRoles ? effectiveRoleIds(bot, roster.prefs) : []
  const activeRole = effective[0] ?? pin?.id ?? rawIds[0]
  const detach = () => void run(actions.detachRole(bot.id))
  const readOnly = roleReadOnly(roster)
  const detachReason = id => t('Detach {name} first.', {
    name: id === 'genie' ? t('Genie') : (pin?.id === id ? packageDeclarations(pin, roster)?.name : undefined) ?? id,
  })
  const genieOccupied = rawIds.find(id => id !== 'genie')
  const genieReason = genieOccupied !== undefined ? detachReason(genieOccupied)
    : bot.kind !== BUILTIN_ROLES.genie.kind ? t(GENIE_ATTACH_REFUSAL) : undefined
  const choices = new Map()
  if (showingRoles) {
    for (const [id, record] of Object.entries(roster.roles ?? {})) {
      if (isPackageRoleId(id) && record.status === 'ok') choices.set(id, record.version)
    }
    if (pin) choices.set(pin.id, pin.version)
  }
  const rolePicker = choices.size ? 'div' : Segmented
  const rolePickerProps = choices.size
    ? { className: 'bt-app-chips', role: 'group', 'aria-label': t('Role') }
    : { label: t('Role'), value: activeRole }
  // A model whose agent is signed out: the refusal shows as usual, and Sign in opens the sign-in
  // row in this Bot's chat (rule 2). The chat opens only on this click.
  const [signIn, setSignIn] = useState(null)
  useEffect(() => { setSignIn(null) }, [bot.id, bot.model])
  // A model whose agent is signed in to an account not confirmed for Bots (#869): the refusal
  // shows as usual, and Confirm account opens the row's account step in this Bot's chat.
  const [account, setAccount] = useState(null)
  useEffect(() => { setAccount(null) }, [bot.id, bot.model])
  const pickFailure = ref => (error) => {
    if (error?.code === 'bot/sign-in-required' && cliProviderOf(ref)) setSignIn(ref)
    if (error?.code === 'bot/account-confirm-required' && cliProviderOf(ref)) setAccount(ref)
    throw error
  }
  // A route or agent crossing is the host's new-conversation handoff, never an in-place
  // updateBot. The picker asks first; this is the confirmed pick.
  const picker = settingsModelPicker({ bot, roster, actions, run, onFailure: pickFailure })
  // What the model really did (the host's model state, with every state answer).
  const modelState = useSyncExternalStore(actions.subscribeWork ?? noSubscribe, () => actions.modelStateOf?.(bot.id))
  // Cards other Omni plugins add (extend.js), such as what the Bot may do on Omni.
  const extraCards = useEntries(botSettings)
  const duplicate = () => run(actions.duplicateBot(bot.id).then(copy => actions.openSession(copy.id)))
  const remove = () => { if (confirming) void run(actions.deleteBot(bot.id)); else setConfirming(true) }
  // DSH settings can change the model list at any time; the hint should match it.
  useEffect(() => { void actions.refreshModels?.() }, [bot.id])
  return h('div', { className: 'bt-bs' },
    h('div', { className: 'bt-bs-hero' },
      h('div', { className: 'bt-avatar-anchor' },
        h('button', { type: 'button', className: 'bt-avatar-trigger', 'aria-label': t('Choose a character'), 'aria-haspopup': 'dialog', 'aria-expanded': editing, onClick: () => setEditing(true) },
          h(BotMark, { bot, size: 64, live: true }),
          h('span', { className: 'bt-avatar-pencil', 'aria-hidden': true }, h(PencilIcon))),
        editing ? h(CharacterSelect, { bot, actions, run, onClose: closeEditor, avatarImage }) : null),
      h('div', { className: 'bt-bs-who' },
        h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-bs-name' }, bot.name),
          roleTag ? h('span', { className: 'bt-tag' }, roleTag) : null),
        h('span', { className: 'bt-bs-sub' }, [bot.role, isMainBot ? t('Main Bot') : ''].filter(Boolean).join(' · ') || t('Bot')))),
    h(Card, { title: t('Profile') },
      h(Row, { label: t('Name') }, h(InlineText, { label: t('Name'), value: bot.name, placeholder: 'Bob', required: true, maxLength: 40, onSave: name => save({ name }) })),
      h(Row, { label: t('Description'), hint: t('A few words on what it does.') }, h(InlineText, { label: t('Description'), value: bot.role, placeholder: t('Research, admin…'), maxLength: 24, onSave: role => save({ role }) })),
      showingRoles ? h('div', { className: choices.size ? 'bt-set-row bt-bs-row bt-bs-stack' : 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Role')),
          h('span', { className: 'bt-set-hint' }, t('What this Bot can do, on top of what every Bot has.'))),
        h(rolePicker, rolePickerProps,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-pressed': activeRole === undefined, disabled: readOnly,
            onClick: () => { if (activeRole !== undefined && !readOnly) detach() } }, t('None')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-pressed': effective.includes('genie'),
            disabled: readOnly || Boolean(genieReason), title: genieReason,
            onClick: () => { if (activeRole === undefined && !genieReason && !readOnly) void run(actions.attachRole(bot.id, 'genie')) } }, t('Genie')),
          ...[...choices].map(([id, version]) => {
            const installed = Object.hasOwn(roster.roleDetails ?? {}, id) ? roster.roleDetails[id].installed : undefined
            const pressed = pin?.id === id && activeRole === id
            const occupied = rawIds.find(rawId => rawId !== id) ?? (!pressed ? rawIds[0] : undefined)
            const reason = occupied !== undefined ? detachReason(occupied)
              : effective.includes('genie') ? t(CHOOSE_NONE_FIRST)
                : !pressed && installed?.attachable !== true ? t(ROLE_SOURCE_UNCONFIRMED) : undefined
            return h('button', { key: id, type: 'button', className: 'bt-soft bt-soft-sm', 'aria-pressed': pressed,
              disabled: readOnly || Boolean(reason), title: reason,
              onClick: () => { if (!pressed && !reason && !readOnly) void run(actions.attachRole(bot.id, id)) } },
            installed?.verified && installed.version === version ? installed.name : id)
          }))) : null),
    (showingRoles ? pin || recoveryId : recoveryId) ? h(PackageAttachmentCard, { roster, bot, pin, recoveryId, onDetach: detach, actions, run }) : null,
    showingRoles ? h(RolePackagesCard, { key: `role-packages:${bot.id}`, roster, actions, run }) : null,
    h(Card, { title: t('Model') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Model')), h('span', { className: 'bt-set-hint', role: modelState?.lastFailure?.kept ? 'status' : undefined }, modelHint(bot, roster, modelState))),
        h(ModelMenu, picker)),
      signIn && actions.openCliLogin ? h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-set-hint' }, t('This model needs a sign-in to its coding agent.'))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { actions.openCliLogin(bot.id, cliProviderOf(signIn), signIn); setSignIn(null) } }, t('Sign in'))) : null,
      account && actions.openCliLogin ? h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-set-hint' }, t('This model needs you to confirm the account of its coding agent.'))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { actions.openCliLogin(bot.id, cliProviderOf(account), account); setAccount(null) } }, t('Confirm account'))) : null),
    h(CliAccounts, { bot, actions }),
    h(Card, { title: t('Working folder') },
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Folder'))),
        h(FolderMenu, { value: bot.workDir, actions, run, onPick: workDir => save({ workDir }) }))),
    h(Card, { title: t('Privacy') },
      h(SwitchRow, {
        label: t('Private'),
        hint: privacyHint,
        on: bot.private === true,
        disabled: bot.private !== true && (isMainBot || inGroup || !bot.workDir),
        onChange: value => save({ private: value }),
      })),
    h(PeopleCard, { bot, roster }),
    h(Card, { title: t('Instructions') },
      h(Row, { label: t('What this Bot does'), hint: t('Its job on the team. Part of the Bot\'s system prompt.'), stack: true },
        h(InlineText, { label: t('Instructions'), value: bot.instructions, multiline: true, placeholder: t('What this Bot is responsible for…'), onSave: instructions => save({ instructions }) }))),
    h(BotCapabilitiesCard, { bot, roster, actions, run, Card, SwitchRow }),
    h(Card, { title: t('Tools') },
      h(SwitchRow, {
        label: t('Shell access'),
        hint: t('A Bot with shell access can read what the operating-system user can read.'),
        on: bot.shell !== false,
        onChange: value => save({ shell: value }),
      }),
      h('div', { className: 'bt-bs-shell-note' },
        t('The Bot team enforces this at the tool grant: it removes the tools; it does not put a shell in an operating-system sandbox.')),
      h('div', { className: 'bt-bs-shell-note' },
        t('This removes this Bot\'s own shell tools; it does not stop another Bot with a shell, or the operating-system user, from reading files this Bot can read.')),
      h(Row, {
        label: t('Denied tools'),
        hint: t('Exact tool names, one per line or comma separated, case-sensitive. Empty allows every tool.'),
        stack: true,
      }, h(InlineText, {
        label: t('Denied tools'),
        value: denyToolsText(bot),
        multiline: true,
        placeholder: 'bash, write',
        onSave: (text) => {
          const names = parseDenyTools(text)
          save({ denyTools: names.length ? names : null })
        },
      }))),
    ...extraCards.map(entry => h(entry.Component, { key: entry.id, bot, roster, actions, run, Card, Row, SwitchRow })),
    h(BotComputerCard, { bot, roster, actions, run, Card, Row }),
    roster.memory === false ? null : h(MemoryCard, { bot, actions }),
    h(BotSchedules, { bot, roster, actions }),
    h(AdvancedSettings, { key: bot.id, bot, roster, actions, save, Card, Row, SwitchRow }),
    h(Card, { title: t('Main Bot') },
      onlyMain
        ? h('div', { className: 'bt-set-row bt-bs-row' },
            h('span', { className: 'bt-set-copy' },
              h('span', { className: 'bt-bs-label' }, t('Main Bot')),
              h('span', { className: 'bt-set-hint' }, t('The only Main Bot. To hand the role to another Bot, use Main Bot on the Bots page.'))),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('bots') }, t('Change')))
        : h(SwitchRow, {
          label: t('Main Bot'),
          hint: bot.private === true ? t('A private Bot cannot be a Main Bot.') : t('Can create and change Bots, and runs every group chat.'),
          on: isMainBot,
          disabled: bot.private === true,
          onChange: on => run(actions.setMain(bot.id, on)),
        })),
    // The Main Bot tile is always first and always shown, like in the context menu.
    isTile ? null : h(Card, { title: t('Sidebar') },
      h(SwitchRow, { label: t('Pin'), hint: t('Kept above the other chats.'), on: bot.pinned === true, onChange: pinned => run(actions.setFlags(bot.id, { pinned })) }),
      isMainBot ? null : h(SwitchRow, { label: t('Hide from sidebar'), hint: t('Search still finds it.'), on: bot.hidden === true, onChange: hidden => run(actions.setFlags(bot.id, { hidden })) })),
    h(Card, { title: t('Manage') },
      bot.private === true ? null : h('button', { type: 'button', className: 'bt-set-row bt-bs-row', onClick: duplicate },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Duplicate')), h('span', { className: 'bt-set-hint' }, t('A copy with the same job and model, and fresh memory.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))),
      isMainBot ? null : h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger', 'data-confirm': confirming || undefined, onClick: remove },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-bs-label' }, confirming ? t('Delete {name}?', { name: bot.name }) : t('Delete Bot')),
          h('span', { className: 'bt-set-hint' }, confirming ? t('Click again to delete. Its chats are archived.') : t('Removes the Bot from the team.'))),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))))
}

export const BOT_SETTINGS_CSS = ADVANCED_SETTINGS_CSS + `
.bt-bs{display:flex;flex-direction:column;gap:18px}
.bt-bs-hero{display:flex;align-items:center;gap:14px;padding:2px 4px}
.bt-bs-who{display:flex;flex-direction:column;min-width:0;gap:2px}
.bt-bs-name{font-size:17px;line-height:24px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-bs-sub{font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-bs .bt-avedit{left:0;transform:none;width:min(284px,calc(100vw - 32px))}
.bt-bs-row{min-height:48px}
.bt-bs-shell-note{font-size:12px;line-height:16px;padding:0 16px 12px;color:color-mix(in srgb,var(--bt-ink-2) 50%,var(--bt-ink-3))}
label.bt-bs-row{cursor:text}
.bt-bs-row>.bt-set-copy{flex:1 1 auto}
.bt-bs-label{font-size:13px;line-height:18px;font-weight:500}
.bt-bs-row .bt-model-trigger{flex:none;max-width:58%}
.bt-bs-input{flex:0 1 220px;width:0;min-width:96px;height:30px;box-sizing:border-box;margin:-4px -6px -4px 0;padding:0 8px;border:1px solid transparent;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:13px;text-align:right;outline:none;transition:background-color .12s ease,border-color .12s ease}
.bt-bs-input:hover{background:var(--bt-hover)}
.bt-bs-input:focus{background:var(--bt-main);border-color:var(--bt-line-2);text-align:left}
.bt-bs-input::placeholder{color:var(--bt-ink-3)}
.bt-bs-input.bt-bs-num{flex:0 0 72px;min-width:0}
.bt-bs-stack{flex-direction:column;align-items:stretch;gap:8px}
.bt-bs-area{flex:none;width:auto;min-height:112px;height:auto;margin:0 -6px -4px;padding:8px;line-height:19px;text-align:left;resize:vertical;background:var(--bt-hover)}
.bt-bs-area:hover{background:var(--bt-active)}
.bt-bs-danger .bt-bs-label{color:var(--st-bad-strong,var(--bt-danger))}
.bt-bs-danger[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 8%,transparent)}
.bt-bs-danger[data-confirm]:hover{background:color-mix(in srgb,var(--bt-danger) 12%,transparent)}
.bt-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--bt-line-2);cursor:pointer;transition:background-color .2s ease}
.bt-switch[aria-checked=true]{background:var(--bt-accent)}
.bt-switch:disabled{opacity:.45;cursor:default}
.bt-switch:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:${spring(SPRING_SHAPE, 'transform')},${spring(SPRING_TAP, 'width')}}
.bt-switch[aria-checked=true] .bt-switch-knob{transform:translateX(16px)}
.bt-switch:active:not(:disabled) .bt-switch-knob{width:21px}
.bt-switch[aria-checked=true]:active:not(:disabled) .bt-switch-knob{transform:translateX(11px)}
.bt-avedit :is(.bt-shapes,.bt-colors,.bt-dropzone){animation:bt-veil-in .18s ease-out}
@media (prefers-reduced-motion:reduce){.bt-switch,.bt-switch-knob{transition:none}.bt-avedit :is(.bt-shapes,.bt-colors,.bt-dropzone){animation:none}}
`
