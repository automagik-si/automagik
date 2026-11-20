import { createElement as h } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { WORKING, powerOf, startPower, subscribePower, usePowerState } from './power-store.js'
import { geniePowerOn, genieStatusOf, powerLocked, powerOff, powerOn, statusOf, unfoldPowerOn, unfoldStatusOf } from './team.js'

// Omni's, Genie's and Unfold's power, as the welcome's team step and each built-in Bot's
// settings read it: one state table (powerRow), one set of words, and the kind's own run
// (team.js powerOn, geniePowerOn, unfoldPowerOn) in the shared power store. The Bot team draws
// the settings card through its botSettings registry (@automagik/bots-dsh/client); it wears that
// settings page's own pieces (Card, Row, SwitchRow), so it follows every theme.

const NAMES = { omni: 'Omni', genie: 'Genie', unfold: 'Unfold' }
// What powering on leaves for the person: Omni found or not found, where it should live.
const CHOOSE = new Set(['found', 'none'])

const statusText = (kind, phase, detail) => (kind === 'omni' ? statusOf(phase, detail) : kind === 'unfold' ? unfoldStatusOf(phase, detail) : genieStatusOf(phase, detail))

// Genie's install steps (bot-types.js runGenieInstall), as the line names them.
const GENIE_STEPS = { git: () => t('Checking git'), team: () => t('Bot team'), genie: () => t('Genie plugin') }

/**
 * Where an install is: { at, count, step } from what the host's job says (Omni: the plugin it
 * installs now among the Omni plugins, the team step's InstallProgress; Genie: its steps), or
 * null before the job says.
 */
export function installStepOf(kind, detail) {
  if (kind === 'omni') {
    const rows = detail?.plugins?.plugins ?? []
    const install = detail?.plugins?.install
    const title = rows.find(row => row.name === install?.current)?.title
    if (!title || rows.length === 0) return null
    return { at: Math.min(rows.length, (install.done?.length ?? 0) + 1), count: rows.length, step: t(title) }
  }
  const install = detail?.[kind]?.install
  const steps = Array.isArray(install?.steps) ? install.steps : []
  if (!install?.current || steps.length === 0 || !GENIE_STEPS[install.current]) return null
  return { at: Math.min(steps.length, (install.done?.length ?? 0) + 1), count: steps.length, step: GENIE_STEPS[install.current]() }
}

// A row's status line while it works: the install's step and place, else the team step's line.
export function workingText(kind, phase, detail) {
  const at = phase === 'installing' ? installStepOf(kind, detail) : null
  return at ? t('Installing {name} · {at} of {count} · {step}', { name: NAMES[kind], ...at }) : statusText(kind, phase, detail)
}

// Whether the product is missing from this DSH, by the host's omni-plugins or genie-plugin answer.
const notInstalled = (kind, status) => (kind === 'omni' ? status?.installed === false : status?.plugin?.installed === false)
const INSTALL_NOTE = {
  omni: () => t('Adds the Omni plugins to this DSH, then looks for your Omni.'),
  genie: () => t('Adds the Genie plugin to this DSH. Genie then joins your team.'),
}

// The product's Bot on the team (the Main Bot when it is one of the kind, else the first). The
// Bot sits in the sidebar already, so the card does not open it.
function botOf(roster, kind) {
  const bots = (roster?.bots ?? []).filter(bot => bot.kind === kind)
  return bots.find(bot => bot.id === roster?.mainBotId) ?? bots[0] ?? null
}

/**
 * One product's row: `state` (on, off, working, attention) for the button's label, the status
 * line, a `note` under it, an `alert` when a power-on failed, `action`, the one thing to do next
 * (off, power, install, retry, choose, add, plugins) or null, and `secondary` (add) beside it. `pressed` says the action is the power button's off (aria-pressed), `locked` that it is held
 * as the team step's own box holds it. `power` is its phase in the power store, `status` the
 * welcome host's omni-plugins or genie-plugin answer (null until the card read it). A read-only
 * team, and Unfold (shown only in its own instance), get text only.
 */
export function powerRow(kind, power, { roster = {}, status = null } = {}) {
  const { phase, detail } = power ?? { phase: 'asleep', detail: null }
  const name = NAMES[kind]
  const bot = botOf(roster, kind)
  const readOnly = Boolean(roster?.readOnly)
  const row = (state, text, action = null, extra = {}) => ({
    kind, name, state, text, action: null, secondary: null, alert: null, note: null, pressed: false, locked: false, bot, ...extra,
    ...(readOnly ? { action: null, secondary: null } : { action, secondary: extra.secondary ?? null }),
  })
  if (kind === 'unfold') return { ...row(bot ? 'on' : 'off', statusText(kind, bot ? 'ready' : 'asleep')), action: null }
  if (WORKING.has(phase)) {
    // An install keeps going on the host: its power is held, as the team step's box holds it.
    const held = powerLocked(kind, phase)
    return row('working', workingText(kind, phase, detail), held ? null : 'off', { working: true, pressed: true, note: held ? t('You can close this. The install keeps going.') : null })
  }
  if (phase === 'failed') return row('attention', statusText(kind, 'failed'), 'retry', { alert: detail?.message ?? null })
  if (phase === 'restart') return row('attention', statusText(kind, 'restart'))
  if (kind === 'omni' && CHOOSE.has(phase)) return row('attention', statusText(kind, phase, detail), 'choose')
  if (kind === 'omni' && phase === 'pairing') return row('attention', statusText(kind, phase, detail), 'off', { pressed: true })
  const removed = phase === 'asleep' && detail?.removed === true
  const on = kind === 'omni' ? !removed && (roster?.omniLinked === true || phase === 'linked') : bot !== null || phase === 'ready'
  if (on) {
    const text = t('On · {status}', { status: kind === 'omni' ? statusText(kind, 'linked', phase === 'linked' ? detail : null) : statusText(kind, 'ready') })
    const secondary = bot === null && kind === 'omni' && roster?.omniAddable === true ? 'add' : null
    // Genie, once on the team, stays (team.js powerLocked): its off is shown, held, and says why.
    const locked = powerLocked(kind, 'ready')
    return row('on', text, 'off', { secondary, pressed: true, locked, note: locked ? t('{name} stays on once it joins your team.', { name }) : null })
  }
  const asleep = statusText(kind, 'asleep', removed ? detail : null)
  // This DSH has no plugin manager to install with: its Plugins page is the way.
  if (status && status.canInstall === false && status.ready !== true) return row('off', asleep, 'plugins')
  if (notInstalled(kind, status)) return row('off', t('Not installed'), 'install', { note: INSTALL_NOTE[kind]() })
  return row('off', asleep, 'power')
}

const ACTION_LABEL = {
  power: name => t('Power {name} on', { name }),
  off: name => t('Power {name} off', { name }),
  install: name => t('Install {name}', { name }),
  retry: () => t('Try again'),
  choose: () => t('Choose where Omni lives'),
  add: () => t('Add Omni'),
  plugins: () => t('Open Plugins'),
}
export const actionLabel = row => (row.action ? ACTION_LABEL[row.action](row.name) : null)
export const secondaryLabel = row => (row.secondary ? ACTION_LABEL[row.secondary](row.name) : null)

// The three Bots whose power this plugin owns, and each one's own run.
const POWER_KINDS = new Set(['omni', 'genie', 'unfold'])
const POWER_ON = { omni: powerOn, genie: geniePowerOn, unfold: unfoldPowerOn }

export const installRunning = status => status?.install?.phase === 'installing'

/**
 * Picks up an install the host is running that this window is not following (the window was
 * reloaded, or the install was started in another one): the kind's power-on, resumed from that
 * answer, so it draws the install's step and place and polls the host (team.js POLL_MS) until it
 * is done or failed. It asks for no install of its own, and a kind already working starts nothing
 * (startPower). Returns the run, or null.
 */
export function resumeInstall(kind, status, start = startPower) {
  if (!installRunning(status) || (kind !== 'omni' && kind !== 'genie')) return null
  const on = kind === 'omni' ? powerOn : geniePowerOn
  return start(kind, options => on({ ...options, resume: status }))
}

// What this DSH's plugins have (omni-plugins, genie-plugin), each null when its read failed.
export const readPlugins = (ask = call) => Promise.all(
  [ask('omni-plugins'), ask('genie-plugin')]
    .map(request => Promise.resolve(request).catch(() => null)),
)

export function officialRow(kind, power, { roster, read, actions }) {
  const asleep = (power?.phase ?? 'asleep') === 'asleep'
  if (!read.checked && asleep) {
    return { text: null, label: null, alert: null, action: null }
  }
  const status = asleep ? read.status : null
  const row = powerRow(kind, power, { roster, status })
  if (row.state === 'on' && row.action === 'off' && notInstalled(kind, status)) {
    const action = 'install'
    const label = actionLabel({ ...row, action })
    return { text: null, label, alert: null, action }
  }
  let action = null
  if (row.action === 'install' || row.action === 'power' || row.action === 'retry') {
    action = row.action
  } else if (row.action === 'choose' && typeof actions?.openHarnessOnboarding === 'function') {
    action = row.action
  } else if (row.action === 'plugins' && actions?.hasPlugins?.() === true) {
    action = row.action
  }
  const text = row.state === 'off' && action === 'install' ? null : row.text
  return { text, label: actionLabel({ ...row, action }), alert: row.alert, action }
}

export function actOfficial(kind, row, { actions, start = startPower }) {
  if (row.action === 'install' || row.action === 'power' || row.action === 'retry') {
    return start(kind, POWER_ON[kind])
  }
  if (row.action === 'choose') {
    actions.closeSettings?.()
    actions.openHarnessOnboarding('omni-team')
  } else if (row.action === 'plugins') {
    actions.closeSettings?.()
    actions.openPlugins?.()
  }
}

// The card's one control, from the switch's next value: off, or the kind's own power-on, in the
// shared store.
export function togglePowerSettings(kind, next, { start = startPower, stop = powerOff } = {}) {
  if (next) start(kind, POWER_ON[kind])
  else stop(kind)
}

/**
 * One Bot's power, as its settings page draws it: the Bot team's Card, Row and SwitchRow, the
 * same state table and words as the team step's box, and one switch (team.js powerOff, or the
 * kind's own power-on). A Bot of another kind gets no card; a read-only team gets the state line
 * only. Genie and Unfold stay on once their Bot is on the team, so their switch is shown held.
 */
export function PowerSettingsCard({ bot, roster, Card, Row, SwitchRow, start = startPower, stop = powerOff }) {
  const kind = POWER_KINDS.has(bot?.kind) ? bot.kind : null
  const power = usePowerState(kind ?? 'omni')
  if (kind === null || typeof Card !== 'function' || typeof Row !== 'function' || typeof SwitchRow !== 'function') return null
  const row = powerRow(kind, power, { roster })
  const readOnly = Boolean(roster?.readOnly)
  // Genie's and Unfold's Bots stay once they join the team, as their boxes hold them.
  const stays = kind !== 'omni' && row.bot !== null && row.state === 'on'
  // `pressed` is the state table's own "the next press is off": on, working, looking, pairing.
  const on = row.state === 'on' || row.pressed === true
  const note = row.note ?? (stays && kind === 'genie' ? t('{name} stays on once it joins your team.', { name: row.name }) : null)
  return h(Card, { title: t('Power') },
    readOnly
      ? h(Row, { label: t('Power'), hint: row.text }, null)
      : h(SwitchRow, {
        label: t('Power'),
        hint: row.text,
        on,
        disabled: row.working === true || row.locked === true || stays,
        onChange: value => togglePowerSettings(kind, value, { start, stop }),
      }),
    note ? h('div', { className: 'bt-bs-shell-note' }, note) : null,
    row.alert ? h('div', { className: 'bt-bs-shell-note', role: 'alert', style: { color: 'var(--st-bad-strong,var(--bt-danger))' } }, row.alert) : null)
}

/**
 * Puts the card in each built-in Bot's settings, when the Bot team runs here. Its client is
 * looked up only now (`dsh.client.external` loads it first when it is installed); without it,
 * or with one that has no botSettings, there is no card and nothing fails.
 */
export function installPowerSettings(load = () => require('@automagik/bots-dsh/client')) {
  let bots = null
  try {
    bots = load()
  } catch {
    bots = null
  }
  const settings = bots?.omni?.botSettings ?? null
  if (typeof settings?.register !== 'function') return () => {}
  return settings.register({ id: 'welcome-power', order: 0, Component: PowerSettingsCard })
}

export function installOfficialInstall(
  load = () => require('@automagik/bots-dsh/client'),
  { ask = call, start = startPower } = {},
) {
  let bots = null
  try {
    bots = load()
  } catch {
    bots = null
  }
  const registry = bots?.omni?.officialInstall
  if (typeof registry?.register !== 'function') return () => {}

  const empty = { checked: false, status: null }
  const reads = { omni: empty, genie: empty }
  const listeners = new Set()
  let version = 0
  let inFlight = null
  let disposed = false
  const changed = () => {
    version += 1
    for (const listener of Array.from(listeners)) listener()
  }
  const unsubscribePower = subscribePower(changed)
  const row = (kind, { roster, actions }) =>
    officialRow(kind, powerOf(kind), { roster, read: reads[kind], actions })
  const unregister = registry.register({
    id: 'welcome-install',
    order: 0,
    kinds: ['omni', 'genie'],
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    version: () => version,
    pending(kind) {
      const { phase } = powerOf(kind)
      const missing = phase === 'asleep' && notInstalled(kind, reads[kind].status)
      const needsAttention = phase === 'failed' || phase === 'restart' || phase === 'pairing'
      return missing || WORKING.has(phase) || needsAttention || CHOOSE.has(phase)
    },
    row,
    act: (kind, ctx) => actOfficial(kind, row(kind, ctx), { actions: ctx.actions, start }),
    refresh() {
      if (inFlight !== null) return inFlight
      inFlight = readPlugins(ask).then(([omni, genie]) => {
        if (disposed) return
        reads.omni = { checked: true, status: omni }
        reads.genie = { checked: true, status: genie }
        changed()
        resumeInstall('omni', omni, start)
        resumeInstall('genie', genie, start)
      }).finally(() => { inFlight = null })
      return inFlight
    },
  })
  return () => {
    disposed = true
    unsubscribePower()
    unregister()
  }
}
