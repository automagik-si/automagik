import { createElement as h, useEffect, useRef, useState } from 'react'
import { call, callOmniUi } from './api.js'
import { OCTOPUS_SVG, omniFace } from './octopus.js'
import { CLAY_OMNI, LAMP, faceAt } from './vendor/clay-art.js'
import { ProductLockup } from './product-lockup.js'
import { Stage, reducedMotion, useFinish, useGate, useGlitch } from './stage.js'
import { InstallLog } from './terminal.js'
import { t } from './i18n.js'
import { WORKING, powerOf, powerSignal, runPower, showPower, stopPower, usePowerState } from './power-store.js'
import { whereOf } from './where.js'

// Step omni-team (order -270): who joins the companion's team. Each Bot type is a card with
// what it starts with (its model, plugins, tools, skills, folder and permissions), read from
// this DSH (src/host/bot-types.js), with a switch where the person sets it.
//
// Omni's card starts asleep. Its power button wakes it: when this DSH lacks the Omni plugins
// (a plain DSH; the desktop app ships them) it installs them through DSH's plugin manager,
// then it looks for an Omni to connect (the channels plugin's omni-discover) and offers
// what it found, or the ways to reach one. A link made here completes the Connect Omni step
// by itself; anything the card cannot finish waits for that step. Genie's power button
// installs its plugin (@automagik/genie-dsh, with the Bot team under it in a plain DSH), which
// puts the Genie Bot on the team. Unfold's card is shown only in Unfold's own instance
// (state.host 'unfold'), where its plugin and defaults come bundled: it installs nothing. Omni
// and Genie come bundled there too: Omni's card offers no new Omni of its own and Genie's no line
// to paste into a terminal. Its copy is the welcome.team namespace (i18n.js).

export const WAKE_MS = 1100
export const LOOK_MS = 1800
export const POLL_MS = 900
// After an install, how long the new plugins may take to come up before a restart is asked.
export const READY_POLLS = 20

const abortError = () => Object.assign(new Error('Omni was switched off'), { name: 'AbortError' })
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  if (ms <= 0) return resolve()
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(abortError())
  }, { once: true })
})

/**
 * Pressing the power button. `show(phase, detail)` draws each step: waking, installing
 * ({ plugins }), starting ({ plugins }: installed, coming up), looking, then linked ({ origin }), found ({ omnis, sandbox }), none
 * ({ sandbox }), restart ({ plugins }) or failed ({ message }). Returns the last phase.
 * `signal` is the power going off; `quick` (reduced motion) skips the pauses.
 */
export async function powerOn({ show, signal, omniAi = call, omniUi = callOmniUi, wait = sleep, quick = reducedMotion(), resume = null }) {
  const check = () => { if (signal?.aborted) throw abortError() }
  const pause = ms => wait(quick ? 0 : ms, signal)
  const end = (phase, detail) => {
    check()
    show(phase, detail)
    return phase
  }
  // `resume` is an omni-plugins answer whose install is already running on the host (one
  // started in another window, or before a reload): no wake, the poll picks it up.
  let plugins = resume
  if (plugins === null) {
    show('waking')
    await pause(WAKE_MS)
    check()
    plugins = await omniAi('omni-plugins')
    check()
  }
  if (!plugins.ready) {
    show('installing', { plugins })
    if (plugins.install?.phase !== 'installing') {
      try {
        plugins = await omniAi('omni-plugins-install')
      } catch (error) {
        return end('failed', { message: error.message })
      }
    }
    let polls = 0
    while (plugins.install?.phase === 'installing' || (plugins.install?.phase === 'done' && !plugins.ready && polls < READY_POLLS)) {
      check()
      // Installed, and DSH is bringing the plugins up.
      show(plugins.install?.phase === 'installing' ? 'installing' : 'starting', { plugins })
      await wait(POLL_MS, signal)
      plugins = await omniAi('omni-plugins')
      if (plugins.install?.phase !== 'installing') polls += 1
    }
    if (plugins.install?.phase === 'failed') return end('failed', { message: plugins.install.error })
    if (!plugins.ready) return end('restart', { plugins })
  }
  show('looking')
  const started = Date.now()
  // The channels plugin answers on the Omni plugins' route once it runs; a route that is not
  // there yet waits for DSH to restart.
  let link = null
  try {
    link = await omniUi('omni-link')
  } catch (error) {
    if (error?.code === 'HTTP_404') return end('restart', { plugins })
  }
  check()
  if (link?.linked === true || link?.configured === true) {
    await pause(LOOK_MS / 2)
    return end('linked', { origin: link.origin ?? null })
  }
  const found = await omniUi('omni-discover').catch(() => null)
  check()
  await pause(Math.max(0, LOOK_MS - (Date.now() - started)))
  const omnis = Array.isArray(found?.omnis) ? found.omnis : []
  return end(omnis.length > 0 ? 'found' : 'none', { omnis, sandbox: found?.sandbox ?? null })
}

/**
 * Pressing Genie's power button: waking, installing ({ genie }), starting ({ genie }:
 * installed, coming up), then ready ({ bot }) once the Genie Bot is on the team, restart
 * ({ genie }) or failed ({ message }). Returns the last phase.
 */
export const geniePowerOn = ({ genieAi = call, ...options }) => botPowerOn('genie', { ...options, ai: genieAi })
// Unfold's power button, as Genie's: its plugin and defaults install, then the Unfold Bot is ready.
export const unfoldPowerOn = ({ unfoldAi = call, ...options }) => botPowerOn('unfold', { ...options, ai: unfoldAi })

// A Bot type that is one plugin making its own Bot (Genie, Unfold): ready at once when the Bot
// is there, else its install, a few polls while DSH starts it, then ready or a restart.
async function botPowerOn(kind, { show, signal, ai, wait = sleep, quick = reducedMotion(), resume = null }) {
  const check = () => { if (signal?.aborted) throw abortError() }
  const end = (phase, detail) => {
    check()
    show(phase, detail)
    return phase
  }
  // `resume`: a running install's answer, picked up without a wake (as powerOn's).
  let reply = resume
  if (reply === null) {
    show('waking')
    await wait(quick ? 0 : WAKE_MS, signal)
    check()
    reply = await ai(`${kind}-plugin`)
    check()
  }
  if (reply.ready) return end('ready', { bot: reply.bot })
  show('installing', { [kind]: reply })
  if (reply.install?.phase !== 'installing') {
    try {
      reply = await ai(`${kind}-plugin-install`)
    } catch (error) {
      return end('failed', { message: error.message })
    }
  }
  let polls = 0
  while (!reply.ready && (reply.install?.phase === 'installing' || (reply.install?.phase === 'done' && polls < READY_POLLS))) {
    check()
    show(reply.install?.phase === 'installing' ? 'installing' : 'starting', { [kind]: reply })
    await wait(POLL_MS, signal)
    reply = await ai(`${kind}-plugin`)
    if (reply.install?.phase !== 'installing') polls += 1
  }
  if (reply.ready) return end('ready', { bot: reply.bot })
  if (reply.install?.phase === 'failed') return end('failed', { message: reply.install.error, [kind]: reply })
  return end('restart', { [kind]: reply })
}

/**
 * A new Omni of its own on this computer, from Omni's card: Omni's installer
 * (`omni install --sandbox --at-login`) runs in a terminal the Omni channels plugin owns
 * (omni-terminal-*), started at once since choosing the tile is the go-ahead, and what it
 * prints shows in the card ({ terminal, log, step }). It ends linked (exit 0 links the Bot
 * team to the new Omni), pairing, or failed ({ message, log }). Returns the last phase.
 */
export const SANDBOX_LOG_MAX = 48_000
const TERMINAL_ENDED = new Set(['done', 'exited', 'failed', 'cancelled', 'closed'])
export async function sandboxInstall({ show, signal, omniUi = callOmniUi, wait = sleep, poll = 400 }) {
  const check = () => { if (signal?.aborted) throw abortError() }
  const opened = await omniUi('omni-terminal-open', { kind: 'install', cols: 72, rows: 8 })
  check()
  const { terminal } = opened
  let log = ''
  let from = 0
  show('sandbox', { terminal, log, step: null })
  let started = false
  const start = async state => {
    if (started || state !== 'ready') return
    check()
    // Install terminals open before Bun and the shell are ready. Keys sent while
    // preparing are rejected; only an accepted Enter starts this command once.
    const written = await omniUi('omni-terminal-write', { terminal, data: '\r' })
    started = written?.ok === true
  }
  await start(opened.state)
  const end = (phase, detail) => {
    void omniUi('omni-terminal-close', { terminal }).catch(() => {})
    check()
    show(phase, detail)
    return phase
  }
  for (;;) {
    check()
    const read = await omniUi('omni-terminal-read', { terminal, from })
    check()
    log = `${log}${read.data ?? ''}`.slice(-SANDBOX_LOG_MAX)
    from = read.next ?? from
    if (read.result?.status === 'paired') return end('linked', { origin: read.result.origin ?? null })
    if (read.result?.status === 'pairing') return end('pairing', { pairing: read.result.pairing })
    const exited = typeof read.exitCode === 'number' || TERMINAL_ENDED.has(read.state)
    if (exited && read.exitCode === 0) return end('linked', { origin: null })
    if (exited) return end('failed', { message: read.error ?? (read.exitCode === 130 ? t('The install was cancelled.') : t('Omni\'s installer stopped (exit code {code}). What it printed is above.', { code: read.exitCode ?? '?' })), log })
    show('sandbox', { terminal, log, step: read.step ?? null })
    await start(read.state)
    await wait(poll, signal)
  }
}

// A translated sentence with an element where its {name} placeholder is.
const around = (text, name, node) => {
  const [before, after = ''] = text.split(`{${name}}`)
  return [before, node, after]
}
// "Your Omni on this Mac" inside a sentence: "Use your Omni on this Mac".
const titleIn = (omni, choice) => (omni.source === 'sandbox' ? choice.title.charAt(0).toLowerCase() + choice.title.slice(1) : choice.title)
// Without a where, name the workspace's computer without assuming the viewer sits at it.
const WORKSPACE = { at: 'unknown' }

/**
 * The sentences that name the machine DSH runs on, for a where from whereOf
 * (src/client/where.js): an Omni of its own on it, an Omni found on it, the line under a found
 * one, and the tile that sets a new one up. Whole sentences, so each language words them its own way.
 */
export function placeOf(where = WORKSPACE) {
  const install = { run: t('Install Omni here') }
  if (where?.at !== 'here') {
    return {
      ...install,
      sandbox: t('Your Omni on the computer this workspace runs on'),
      local: t('Omni on the computer this workspace runs on'),
      already: t('Already on the computer this workspace runs on'),
      on: t('On the computer this workspace runs on'),
    }
  }
  switch (where.os) {
    case 'macos': return {
      ...install, sandbox: t('Your Omni on this Mac'), local: t('Omni on this Mac'),
      already: t('Already on this Mac'), on: t('On this Mac'),
    }
    case 'windows': return {
      ...install, sandbox: t('Your Omni on this PC'), local: t('Omni on this PC'),
      already: t('Already on this PC'), on: t('On this PC'),
    }
    default: return {
      ...install, sandbox: t('Your Omni on this computer'), local: t('Omni on this computer'),
      already: t('Already on this computer'), on: t('On this computer'),
    }
  }
}
const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const portOf = (url) => {
  try {
    return new URL(url).port
  } catch {
    return ''
  }
}

/**
 * One found Omni as a choice: its title, the line under it, and its one-click action — `use`
 * (this computer has its key), `connect` (approve this device from the phone) — or none,
 * with a note on what the Connect Omni step can do for it instead.
 */
export function foundChoice(omni, { where = WORKSPACE } = {}) {
  const place = placeOf(where)
  const title = omni.source === 'sandbox' ? place.sandbox : omni.local ? place.local : hostOf(omni.url)
  const port = omni.local ? portOf(omni.url) : ''
  const sub = [omni.version ? `v${omni.version}` : null, port ? t('port {port}', { port }) : null, !omni.local ? t('saved in your Omni CLI') : null].filter(Boolean).join(' · ')
  const row = (action, note = null) => ({ id: omni.id, title, sub, action, note })
  if (omni.local && omni.reachable === false) return row(null, t('Not answering right now.'))
  if (omni.updateTo || (omni.pairing === 'too-old' && !omni.hasKey)) return row(null, t('Needs an update first; Connect Omni, next, does it.'))
  if (omni.hasKey) return row('use')
  if (omni.pairing === 'off') return row(null, t('Sign-in from devices is off on it.'))
  return row('connect')
}

// The link an Omni sends its owner (https://<omni>/api/login/app?grant=…, or the
// omni://connect?url=…&grant=… it opens), the claim link an Omni nobody owns prints in its
// server log (https://<omni>/api/login/claim?token=…: opened on Omni's own page, never
// spent here), or an address to sign in to.
export function readRemote(text) {
  const value = String(text ?? '').trim()
  if (value === '') return null
  let link = null
  try {
    link = new URL(value)
  } catch { /* an address without a scheme */ }
  const grant = link?.searchParams.get('grant') ?? ''
  if (/^[A-Za-z0-9_-]{24}$/.test(grant)) {
    if (link.protocol === 'omni:') {
      const url = link.searchParams.get('url')
      return url ? { kind: 'grant', url, grant } : { kind: 'bad-link' }
    }
    if (/\/api\/login\/app\/?$/.test(link.pathname)) return { kind: 'grant', url: `${link.origin}${link.pathname.replace(/\/api\/login\/app\/?$/, '')}`, grant }
  }
  if (link && /^https?:$/.test(link.protocol) && /\/api\/login\/claim\/?$/.test(link.pathname) && link.searchParams.get('token')) {
    return { kind: 'claim', url: `${link.origin}${link.pathname.replace(/\/api\/login\/claim\/?$/, '')}`, claimUrl: link.href }
  }
  if (/^omni:/i.test(value) || /[?&]grant=/.test(value)) return { kind: 'bad-link' }
  return { kind: 'address', url: value }
}

// Omni channels refuses to sign in to an Omni nobody owns yet (omni-link.js start(), in
// the omni repository): "<host> has no owner yet. Claim it first…".
export const isUnowned = message => /has no owner yet/i.test(String(message ?? ''))

const TYPE_LABEL = { 'whatsapp-baileys': 'WhatsApp', 'whatsapp-cloud': 'WhatsApp Business', slack: 'Slack', telegram: 'Telegram', discord: 'Discord', gupshup: 'Gupshup' }
export const channelLabel = channel => TYPE_LABEL[channel.type] ?? channel.type ?? t('Channel')

// Genie's setup (genie-dsh in the genie repository). Its labels are English keys, read in the
// DSH language where they are drawn (Capabilities).
export const GENIE_TYPE = {
  type: 'genie',
  groups: [
    { id: 'plugins', label: 'Plugins', rows: [{ id: 'genie', label: 'Genie', detail: 'Installs when Genie powers on' }] },
    { id: 'tools', label: 'Tools', rows: [{ id: 'threads', label: 'A Task per wish', detail: 'Under Genie, with its report in Genie\'s chat' }, { id: 'computer', label: 'Shell, files and git', detail: 'In the wish\'s own copy of the project' }] },
    { id: 'setup', label: 'Setup', rows: [{ id: 'folder', label: 'Folder', detail: 'Its own, in your team workspace' }] },
  ],
}

// Unfold's setup (unfold-bot-dsh): its plugin and defaults, in the order they install.
const UNFOLD_ROWS = [
  ['unfold', 'Unfold', 'The Unfold Bot, Unfold inside DSH'],
  ['bridge', 'Unfold bridge', 'Unfold watches this DSH'],
  ['session', 'Unfold session', 'Unfold\'s own session, in DSH'],
  ['events', 'Unfold events and stream', 'What Unfold did, as it happens'],
  ['mind', 'Unfold Mind', 'What Unfold is thinking'],
  ['more', 'Unfold capabilities, settings and trajectory', 'What Unfold can do, its settings, each run step by step'],
]
// In Unfold's own instance a plugin is already here; elsewhere it installs when its Bot powers on.
const BUNDLED = 'Comes with this DSH'
export function unfoldTypeOf(host) {
  return {
    type: 'unfold',
    groups: [
      { id: 'plugins', label: 'Plugins', rows: UNFOLD_ROWS.map(([id, label, what]) => ({ id, label, detail: `${t(what)} · ${host === 'unfold' ? t(BUNDLED) : t('Installs when Unfold powers on')}` })) },
      { id: 'setup', label: 'Setup', rows: [{ id: 'lead', label: 'Leads', detail: host === 'unfold' ? 'Your Main Bot here' : 'Joins your team beside your Main Bot' }] },
    ],
  }
}
export const genieTypeOf = host => (host === 'unfold'
  ? { ...GENIE_TYPE, groups: GENIE_TYPE.groups.map(group => (group.id === 'plugins' ? { ...group, rows: [{ id: 'genie', label: 'Genie', detail: BUNDLED }] } : group)) }
  : GENIE_TYPE)

// The switches the person sets: the tool groups that are not locked, as `{ id: on }`.
export const abilitiesOf = type => Object.fromEntries((type?.groups ?? []).find(group => group.id === 'tools')?.rows.filter(row => typeof row.on === 'boolean').map(row => [row.id, row.on]) ?? [])

// A long folder, shortened in the middle so it fits on one line: ~/…/workspace/omni.
export function shortPath(path, keep = 2) {
  const parts = String(path).split('/')
  const head = parts[0] === '~' ? '~' : ''
  const tail = parts.slice(-keep).filter(Boolean)
  return parts.length - (head ? 1 : 0) > keep + 1 ? `${head}/…/${tail.join('/')}` : path
}

const Check = () => h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true }, h('path', { d: 'M3 8.5l3 3 7-7', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))

// The host's rows (src/host/bot-types.js) are English: each is a key, or one of these with a value
// in it. A folder, a model's name or a skill has no key and stays as it is.
const HOST_ROWS = [
  [/^(.+) · you confirm it in Omni's first chat$/, ref => t('{ref} · you confirm it in Omni\'s first chat', { ref })],
  [/^(.+) \(DSH's default\)$/, preset => t('{preset} (DSH\'s default)', { preset })],
]
export function rowText(text) {
  if (typeof text !== 'string') return text
  for (const [pattern, of] of HOST_ROWS) {
    const match = pattern.exec(text)
    if (match) return of(match[1])
  }
  return t(text)
}

/** A Bot type's preloaded setup, group by group, with a switch where it is tunable. */
export function Capabilities({ type, abilities = {}, onToggle, disabled = false }) {
  if (!type) return h('p', { className: 'oai-muted oai-caps-wait' }, t('Reading what it starts with…'))
  return h('div', { className: 'oai-caps' }, type.groups.map(group => h('section', { key: group.id, className: 'oai-cap-group', 'aria-label': rowText(group.label) },
    h('h3', null, rowText(group.label)),
    group.rows.length === 0
      ? h('p', { className: 'oai-muted oai-cap-empty' }, group.empty ? rowText(group.empty) : t('None'))
      : h('ul', null, group.rows.map((row) => {
        const on = typeof row.on === 'boolean' ? abilities[row.id] ?? row.on : null
        return h('li', { key: row.id, className: `oai-cap${on === false ? ' oai-off' : ''}`, 'data-cap': row.id },
          h('span', { className: 'oai-cap-what' },
            h('strong', null, rowText(row.label)),
            row.detail ? h('small', row.path ? { title: row.detail } : null, row.path ? shortPath(row.detail) : rowText(row.detail)) : null,
            row.installed === false ? h('small', null, t('Installs when Omni powers on')) : null,
            row.tools ? h('code', null, row.tools.join(' · ')) : null),
          row.version ? h('span', { className: `oai-version${row.installed === false ? ' oai-pending' : ''}` }, `v${row.version}`) : null,
          row.installed === true ? h('span', { className: 'oai-tick', title: t('Installed') }, h(Check)) : null,
          row.locked ? h('span', { className: 'oai-core', title: t('What this Bot is for: always on') }, t('Always on'))
            : on !== null && onToggle ? h('button', { type: 'button', role: 'switch', className: 'oai-switch', 'aria-checked': on, 'aria-label': t('{label} for this Bot', { label: rowText(row.label) }), disabled, onClick: () => onToggle(row.id, !on) })
              : null)
      })))))
}

const CLOSED_EYES = '<g class="oai-closed" fill="none" stroke="#06121f" stroke-width="3" stroke-linecap="round"><path d="M33 37Q40 42 47 37"/><path d="M53 37Q60 42 67 37"/></g>'
const PORTRAIT_SVG = OCTOPUS_SVG.replace('</svg>', `${CLOSED_EYES}</svg>`)

/**
 * Omni's face in its box, by the box's phase: asleep while powered off, focused while it
 * wakes, installs and looks, curious when it waits for the person (found, none, pairing,
 * restart), delighted once linked, sad when the install failed.
 */
export function omniFaceOf(phase) {
  if (phase === 'asleep') return 'asleep'
  if (phase === 'failed') return 'sad'
  if (phase === 'linked') return 'delighted'
  if (['waking', 'installing', 'starting', 'looking'].includes(phase)) return 'focused'
  return 'curious'
}
// The clay face, or the vector octopus (its eyes closed while asleep) with CLAY_OMNI off.
const portraitOf = phase => (CLAY_OMNI ? omniFace(omniFaceOf(phase)) : PORTRAIT_SVG)

/**
 * Genie's face on its card, by its box's phase: asleep while powered off, focused while it
 * wakes and installs, delighted once on the team, curious when a restart waits, sad when
 * the install failed.
 */
export function genieExpressionOf(phase) {
  if (phase === 'asleep') return 'asleep'
  if (phase === 'failed') return 'sad'
  if (phase === 'ready') return 'delighted'
  if (['waking', 'installing', 'starting'].includes(phase)) return 'focused'
  return 'curious'
}
const GeniePet = ({ expression }) => h('div', { className: 'oai-genie-pet oai-clay oai-clay-genie', 'data-face': expression, style: { '--oai-face-at': faceAt(expression) } })
// Unfold's face follows its box as Genie's does.
const UnfoldPet = ({ expression }) => h('div', { className: 'oai-unfold-pet oai-clay oai-clay-unfold', 'data-face': expression, style: { '--oai-face-at': faceAt(expression) } })

// The power symbol, on each card's box.
export const PowerIcon = ({ size = 18, stroke = 2.4 } = {}) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true },
  h('path', { d: 'M12 3v8', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
  h('path', { d: 'M6.4 6.6a8 8 0 1 0 11.2 0', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }))

const titleOf = (plugins, name) => rowText(plugins?.plugins?.find(row => row.name === name)?.title ?? 'Omni')

// The one status line inside the box, under Omni.
export function statusOf(phase, detail) {
  if (phase === 'asleep') return detail?.removed ? t('Powered off · not on your team') : t('Powered off')
  if (phase === 'installing') {
    const rows = detail?.plugins?.plugins ?? []
    const install = detail?.plugins?.install
    const at = Math.min(rows.length, (install?.done?.length ?? 0) + 1)
    return install?.current ? t('Installing {title} · {at} of {count}', { title: titleOf(detail.plugins, install.current), at, count: rows.length }) : t('Installing Omni…')
  }
  if (phase === 'found') {
    const count = (detail?.omnis ?? []).filter(omni => foundChoice(omni).action).length
    return count === 1 ? t('Found an Omni') : count > 1 ? t('Found {count} Omnis', { count }) : t('Found Omnis, none ready to connect')
  }
  if (phase === 'linked') return detail?.origin ? t('Connected to {origin}', { origin: detail.origin }) : t('Connected')
  return {
    waking: t('Waking up…'),
    starting: t('Starting Omni in this DSH…'),
    looking: t('Looking for a connection…'),
    none: t('Where should Omni live?'),
    pairing: t('Approve this device on your phone'),
    sandbox: detail?.step === 'download-bun' ? t('Downloading Bun for Omni…') : t('Setting up your Omni…'),
    restart: t('Installed · restart DSH to start it'),
    failed: t('Could not install Omni'),
  }[phase] ?? ''
}

// Genie's status line, inside its box.
export function genieStatusOf(phase, detail) {
  if (phase === 'asleep') return detail?.removed ? t('Powered off · not on your team') : t('Powered off')
  return {
    waking: t('Waking up…'),
    installing: t('Installing Genie…'),
    starting: t('Starting Genie in this DSH…'),
    ready: t('Ready for a wish'),
    restart: t('Installed · restart DSH to start it'),
    failed: t('Could not install Genie'),
  }[phase] ?? ''
}
// Unfold's status line, inside its box.
export function unfoldStatusOf(phase, detail) {
  if (phase === 'asleep') return detail?.removed ? t('Powered off · not on your team') : t('Powered off')
  return {
    waking: t('Waking up…'),
    installing: t('Installing Unfold…'),
    starting: t('Starting Unfold in this DSH…'),
    ready: t('On your team'),
    restart: t('Installed · restart DSH to start it'),
    failed: t('Could not install Unfold'),
  }[phase] ?? ''
}
// Genie's lights: power, its plugin, and the Genie Bot on the team (Unfold's are the same).
export function genieLightsOf(phase) {
  return [
    ['power', phase === 'asleep' ? 'off' : 'on'],
    ['plugins', phase === 'ready' ? 'on' : ['installing', 'starting'].includes(phase) ? 'busy' : phase === 'failed' || phase === 'restart' ? 'warn' : 'off'],
    ['team', phase === 'ready' ? 'on' : 'off'],
  ]
}

// The box's three lights: power, its plugins, its connection. Waking lights them one by one;
// then each shows what is true: on, working (a blink), or off.
export function lightsOf(phase) {
  const ready = ['looking', 'found', 'none', 'pairing', 'linked', 'sandbox'].includes(phase)
  return [
    ['power', phase === 'asleep' ? 'off' : 'on'],
    ['plugins', ready ? 'on' : ['installing', 'starting'].includes(phase) ? 'busy' : phase === 'failed' || phase === 'restart' ? 'warn' : 'off'],
    ['link', phase === 'linked' ? 'on' : ['looking', 'pairing', 'sandbox'].includes(phase) ? 'busy' : phase === 'found' ? 'warn' : 'off'],
  ]
}

function InstallProgress({ plugins }) {
  const install = plugins?.install
  const done = new Set(install?.done ?? [])
  return h('ol', { className: 'oai-install', 'aria-label': t('The Omni plugins') }, (plugins?.plugins ?? []).map((row) => {
    const state = done.has(row.name) || (row.installed && row.enabled !== false) ? 'done' : install?.current === row.name ? 'now' : 'next'
    return h('li', { key: row.name, className: `oai-install-${state}` },
      h('span', { className: 'oai-install-dot', 'aria-hidden': true }, state === 'done' ? h(Check) : null),
      t(row.title.replace(/^Omni /, '')))
  }))
}

function Pairing({ pairing, onCancel }) {
  return h('div', { className: 'oai-pairing', 'aria-live': 'polite' },
    h('code', { className: 'oai-pair-code' }, pairing.code),
    h('div', { className: 'oai-row' },
      pairing.waLink ? h('a', { className: 'oai-pill oai-pill-primary', href: pairing.waLink, target: '_blank', rel: 'noreferrer' }, t('Open WhatsApp')) : null,
      pairing.approveUrl ? h('a', { className: `oai-pill${pairing.waLink ? '' : ' oai-pill-primary'}`, href: pairing.approveUrl, target: '_blank', rel: 'noreferrer' }, t('Approve')) : null,
      h('button', { type: 'button', className: 'oai-pill', onClick: onCancel }, t('Cancel'))),
    pairing.waLink ? null : h('small', { className: 'oai-pair-hint' }, ...around(t('No WhatsApp on that Omni? Run {command} on its server.'), 'command', h('code', null, `omni approve ${pairing.code}`))))
}

// The command that makes an Omni nobody owns yet the operator's and prints a one-time
// link that connects this app (`omni connect` in Omni's CLI, which holds its primary key).
export const connectCommand = url => `omni connect --url ${url}`

// An Omni nobody owns yet: this app does not claim it (the claim token stays on Omni's own
// page). Its owner makes it theirs on the server, or opens the claim link from its log;
// the link `omni connect` prints connects here with no second sign-in.
function Unowned({ url, claimUrl, busy, onRemote, onBack }) {
  const [copied, setCopied] = useState(false)
  const command = connectCommand(url)
  let host = url
  try { host = new URL(url).host } catch { /* shown as typed */ }
  return h('div', { className: 'oai-remote oai-unowned' },
    h('strong', null, t('{host} has no owner yet', { host })),
    h('small', null, t('Make it yours on its server, then paste the link it prints below:')),
    h('div', { className: 'oai-cmd' },
      h('code', null, command),
      h('button', { type: 'button', className: 'oai-copy', onClick: () => navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {}) }, copied ? t('Copied') : t('Copy'))),
    claimUrl
      ? h('small', null, ...around(t('Or {link}, click Claim this Omni, then connect its address again.'), 'link', h('a', { className: 'oai-link', href: claimUrl, target: '_blank', rel: 'noreferrer' }, t('open its claim page'))))
      : h('small', null, t('Or open the claim link from its server log in your browser, then connect its address again.')),
    h(Remote, { busy, onRemote, onBack, label: t('The link it printed') }))
}

const ICONS = {
  // A laptop: an Omni already on this computer.
  here: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V15H4zM2 17h20l-1 2H3z',
  // A box with a spark: a new Omni of its own, set apart on this computer.
  sandbox: 'M12 2l1.6 3.4L17 7l-3.4 1.6L12 12l-1.6-3.4L7 7l3.4-1.6zM4 13h16v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  // A globe: an Omni somewhere else.
  remote: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2c1.1 1.4 2 3.8 2.2 7H9.8c.2-3.2 1.1-5.6 2.2-7M4.1 13h3.7c.1 2.4.7 4.6 1.6 6.1A8 8 0 0 1 4.1 13m12.1 0h3.7a8 8 0 0 1-5.3 6.1c.9-1.5 1.5-3.7 1.6-6.1M4.1 11a8 8 0 0 1 5.3-6.1C8.5 6.4 7.9 8.6 7.8 11zm12.1 0c-.1-2.4-.7-4.6-1.6-6.1a8 8 0 0 1 5.3 6.1zM9.8 13h4.4c-.2 3.2-1.1 5.6-2.2 7-1.1-1.4-2-3.8-2.2-7',
}
const Icon = ({ name }) => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, h('path', { d: ICONS[name], fill: 'currentColor' }))

/**
 * Where Omni comes from, as choices, the first time and every time nothing is linked yet:
 * each Omni found here or saved in the Omni CLI (use or connect it), a new Omni of its own on
 * this computer, or one somewhere else (only that one asks for an address). Found Omnis that
 * cannot be used yet stay listed, with why.
 */
export function destinyOf(omnis = [], { where = WORKSPACE, newOmni = true } = {}) {
  const place = placeOf(where)
  const rows = omnis.map(omni => ({ omni, choice: foundChoice(omni, { where }) }))
  const tiles = rows.filter(row => row.choice.action).map(({ omni, choice }) => ({
    id: omni.id, icon: omni.local ? 'here' : 'remote', omni,
    title: choice.action === 'use' ? t('Use {omni}', { omni: titleIn(omni, choice) }) : t('Connect {omni}', { omni: titleIn(omni, choice) }),
    sub: choice.sub || (omni.local ? place.already : t('Saved in your Omni CLI')),
  }))
  if (newOmni && !rows.some(row => row.omni.source === 'sandbox')) {
    tiles.push({ id: 'local', icon: 'sandbox', title: place.run, sub: place.on })
  }
  tiles.push({ id: 'remote', icon: 'remote', title: t('An Omni somewhere else'), sub: t('On a server, or the link Omni sent you') })
  return { tiles, waiting: rows.filter(row => !row.choice.action).map(row => row.choice) }
}

function Destiny({ omnis, machine, busy, onUse, onLocal, onRemote }) {
  const [remote, setRemote] = useState(false)
  if (remote) return h(Remote, { busy, onRemote, onBack: () => setRemote(false) })
  // Without a way to set one up (Unfold's own instance bundles its Omni), no new Omni is offered.
  const { tiles, waiting } = destinyOf(omnis, { where: whereOf({ machine }), newOmni: typeof onLocal === 'function' })
  const pick = tile => (tile.id === 'remote' ? setRemote(true) : tile.id === 'local' ? onLocal() : onUse(tile.omni))
  return h('div', { className: 'oai-destiny-box' },
    h('div', { className: 'oai-destiny', role: 'group', 'aria-label': t('Where your Omni is') }, tiles.map(tile => h('button', {
      key: tile.id, type: 'button', className: `oai-destiny-tile oai-destiny-${tile.icon}`, disabled: busy !== null, onClick: () => pick(tile),
    },
    h('span', { className: 'oai-destiny-icon' }, h(Icon, { name: tile.icon })),
    h('strong', null, busy === tile.id ? t('Connecting…') : tile.title),
    h('small', null, tile.sub)))),
    waiting.length > 0 ? h('ul', { className: 'oai-destiny-waiting' }, waiting.map(row => h('li', { key: row.id }, h('strong', null, row.title), ` · ${row.note}`))) : null)
}

// An Omni somewhere else: its address, or the link it sent its owner.
function Remote({ busy, onRemote, onBack, label = t('Where is your Omni?') }) {
  const [text, setText] = useState('')
  const wanted = readRemote(text)
  const submit = (event) => {
    event.preventDefault()
    if (wanted !== null && wanted.kind !== 'bad-link') onRemote(wanted)
  }
  return h('form', { className: 'oai-remote', onSubmit: submit },
    h('label', { htmlFor: 'oai-remote-url' }, label),
    h('div', { className: 'oai-remote-row' },
      h('input', { id: 'oai-remote-url', type: 'text', inputMode: 'url', autoComplete: 'off', spellCheck: false, autoFocus: true, value: text, placeholder: 'omni.example.com', onChange: event => setText(event.target.value) }),
      h('button', { type: 'submit', className: 'oai-pill oai-pill-primary', disabled: busy !== null || wanted === null || wanted.kind === 'bad-link' }, busy === 'remote' ? t('Connecting…') : t('Connect'))),
    h('small', null, wanted?.kind === 'bad-link' ? t('That link is cut short. Copy the whole link Omni sent you.') : wanted?.kind === 'claim' ? t('Its claim link: Omni opens it in your browser to make it yours.') : t('Its address, or paste the link Omni sent you on WhatsApp.')),
    h('button', { type: 'button', className: 'oai-textlink', onClick: onBack }, t('Back to the choices')))
}

// What the box shows under the status line: one thing at a time, in the same place.
function Inside({ phase, detail, power, live }) {
  const channels = live?.configured ? live.channels ?? [] : []
  if (phase === 'installing') return h(InstallProgress, { plugins: detail?.plugins })
  if (phase === 'pairing') return h(Pairing, { pairing: detail.pairing, onCancel: power.cancelPairing })
  if (phase === 'sandbox') return h(InstallLog, { text: detail?.log ?? '', label: t('What Omni\'s installer printed') })
  if (phase === 'failed' && detail?.log) return h('div', null, h(InstallLog, { text: detail.log, label: t('What Omni\'s installer printed') }), h('p', { className: 'oai-inside-note oai-bad', title: detail.message }, t('What went wrong is above. Power Omni on to try again.')))
  if ((phase === 'none' || phase === 'found') && power.unowned) return h(Unowned, { ...power.unowned, busy: power.busy, onRemote: power.remote, onBack: power.forgetUnowned })
  if (phase === 'none' || phase === 'found') return h(Destiny, { omnis: detail?.omnis ?? [], machine: power.machine, busy: power.busy, onUse: power.use, onLocal: power.local, onRemote: power.remote })
  // Once connected, its real channels, as they will sit in the menu.
  if (phase === 'linked' && channels.length > 0) {
    return h('div', { className: 'oai-menu' },
      h('span', { className: 'oai-menu-label' }, t('In your menu')),
      h('ul', { className: 'oai-menu-preview' }, channels.slice(0, 3).map(channel => h('li', { key: channel.id }, h('span', { className: `oai-dot ${channel.status === 'connected' ? 'ok' : 'warn'}` }), `${channelLabel(channel)} · ${channel.name}`))))
  }
  if (phase === 'restart') return h('p', { className: 'oai-inside-note' }, t('Restart DSH, then power Omni on again.'))
  if (phase === 'failed') return h('p', { className: 'oai-inside-note oai-bad', title: detail?.message }, detail?.message ?? t('Add the Omni plugins on DSH\'s Plugins page.'))
  return null
}

// Whether a box's power button is held: while its plugins install or start, and, for Genie and
// Unfold, once on the team, since their plugins made their Bots and they stay.
export const powerLocked = (kind, phase) => phase === 'installing' || phase === 'starting' || (kind !== 'omni' && phase === 'ready')

/**
 * Powering a box off, from its button or a Bot's settings: its run stops, a sign-in waiting
 * on the phone is cancelled and Omni's installer gets Ctrl-C, and the box sleeps, not on the team.
 * Nothing more: a linked Omni stays linked and no Bot is removed (only the team step's Continue,
 * team-save, leaves Omni out of the team).
 */
export function powerOff(kind, { phase, detail } = powerOf(kind), omniUi = callOmniUi) {
  stopPower(kind)
  if (kind === 'omni' && phase === 'pairing') void omniUi('omni-pair-cancel').catch(() => {})
  if (kind === 'omni' && phase === 'sandbox' && detail?.terminal) void omniUi('omni-terminal-write', { terminal: detail.terminal, data: '\x03' }).catch(() => {})
  showPower(kind, 'asleep', { removed: true })
}

/**
 * The machine: one box of a fixed size, Omni inside it, a switch on its corner and three
 * lights. Asleep it is a powered-down screen; everything after happens inside, in place.
 */
export function Machine({ kind = 'omni', phase, detail, power, live, onPower, children }) {
  const awake = phase !== 'asleep'
  const omni = kind === 'omni'
  const unfold = kind === 'unfold'
  const title = omni ? 'Omni' : unfold ? 'Unfold' : 'Genie'
  const locked = powerLocked(kind, phase)
  // An Omni being set up can still be stopped (its installer gets Ctrl-C).
  return h('div', { className: `oai-box oai-box-${kind} oai-is-${phase}`, 'data-phase': phase },
    h('div', { className: 'oai-box-top' },
      h('span', { className: 'oai-lights', 'aria-hidden': true }, (omni ? lightsOf(phase) : genieLightsOf(phase)).map(([id, state]) => h('i', { key: id, className: `oai-light oai-light-${state}`, title: t(id) }))),
      h('button', { type: 'button', className: `oai-power${awake ? ' on' : ''}`, 'aria-pressed': awake, 'aria-label': awake ? t('Power {name} off', { name: title }) : t('Power {name} on', { name: title }), onClick: onPower, disabled: locked }, h(PowerIcon))),
    h('div', { className: 'oai-screen', 'aria-hidden': 'true' },
      phase === 'looking' ? h('div', { className: 'oai-scan' }, h('i'), h('i'), h('i')) : null,
      phase === 'asleep' ? h('div', { className: 'oai-zzz' }, h('i', null, 'z'), h('i', null, 'z'), h('i', null, 'z')) : null,
      children),
    h('p', { className: `oai-status${['waking', 'installing', 'starting', 'looking', 'sandbox'].includes(phase) ? ' oai-working' : ''}`, role: 'status', 'aria-live': 'polite' }, omni ? statusOf(phase, detail) : unfold ? unfoldStatusOf(phase, detail) : genieStatusOf(phase, detail)),
    h('div', { className: 'oai-inside' },
      omni ? h(Inside, { phase, detail, power, live }) : unfold ? h(UnfoldInside, { phase, detail }) : h(GenieInside, { phase, detail }),
      omni && power?.problem ? h('p', { className: 'oai-inside-note oai-bad', role: 'alert' }, power.problem) : null))
}

// Under Genie's status line: what its install is doing, as it prints it, and what to do when
// it could not start. The log stays on screen after a failure.
export const genieLogOf = (phase, detail) => (['installing', 'starting', 'restart', 'failed'].includes(phase) ? detail?.genie?.install?.log || null : null)
function GenieInside({ phase, detail }) {
  // A command line the instance bundled is there already: nothing to install by hand.
  if (phase === 'ready' && detail?.genie?.skills === false && detail.genie.cli && detail.genie.cliBundled !== true) return h(GenieSkillsOffer, { line: detail.genie.cli })
  const log = genieLogOf(phase, detail)
  const terminal = log === null ? null : h(InstallLog, { text: log, label: t('What the Genie install printed') })
  if (phase === 'restart') return h('div', null, terminal, h('p', { className: 'oai-inside-note' }, t('Restart DSH, then power Genie on again.')))
  if (phase === 'failed') return h('div', null, terminal, h('p', { className: 'oai-inside-note oai-bad', title: detail?.message }, terminal === null ? detail?.message ?? t('Add @automagik/genie-dsh on DSH\'s Plugins page.') : t('What went wrong is above. Power Genie on to try again.')))
  return terminal
}

// Under Unfold's status line: what to do when it could not start.
function UnfoldInside({ phase, detail }) {
  if (phase === 'restart') return h('p', { className: 'oai-inside-note' }, t('Restart DSH, then power Unfold on again.'))
  if (phase === 'failed') return h('p', { className: 'oai-inside-note oai-bad', title: detail?.message }, detail?.message ?? t('Add @automagik/unfold-bot-dsh on DSH\'s Plugins page.'))
  return null
}

// Genie is on the team, but its skills (/wish and the rest) come with its command line: the
// one line that installs it, to run once in a terminal.
function GenieSkillsOffer({ line }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(line).then(() => setCopied(true), () => {}) }
  return h('div', { className: 'oai-genie-skills' },
    h('p', { className: 'oai-inside-note' }, t('Genie is ready for wishes. For its skills too, like /wish, install its command line once, in a terminal:')),
    h('div', { className: 'oai-cli-line' },
      h('code', null, line),
      h('button', { type: 'button', className: 'oai-copy', onClick: copy }, copied ? t('Copied') : t('Copy'))))
}

// What a Bot type starts with, behind one disclosure, closed until asked.
const StartsWith = props => h('details', { className: 'oai-starts' }, h('summary', null, t('What it starts with')), h(Capabilities, props))

// Omni's card: the machine, its name and one sentence. The rest waits behind the disclosure.
export function OmniCard({ power, onPower, type, abilities, onToggle, live }) {
  const { phase, detail } = power
  const awake = phase !== 'asleep'
  return h('article', { className: `oai-fighter oai-omni${awake ? ' oai-chosen' : ''}`, 'data-phase': phase },
    h(Machine, { phase, detail, power, live, onPower },
      h('div', { className: 'oai-octo-wrap', dangerouslySetInnerHTML: { __html: portraitOf(phase) } })),
    h('header', null,
      h(ProductLockup, { product: 'omni' }),
      awake && phase !== 'failed'
        ? h('span', { className: 'oai-team-line' }, h('span', { className: 'oai-on-team' }, h(Check), t('On your team')), h('button', { type: 'button', className: 'oai-remove', onClick: onPower, disabled: phase === 'installing' || phase === 'starting' }, t('Remove')))
        : null),
    h('p', { className: 'oai-about' }, t('Every chat on every channel, answered by your team.')),
    h(StartsWith, { type, abilities, onToggle, disabled: !awake }))
}

// Genie's card: its box, its name, the wish it grants. Joined once its Bot is on the team.
export function GenieCard({ power, host = null }) {
  const { phase, detail } = power
  const joined = phase === 'ready' || phase === 'restart'
  return h('article', { className: `oai-fighter oai-genie${joined ? ' oai-chosen' : ''}`, 'data-phase': phase },
    h(Machine, { kind: 'genie', phase, detail, onPower: power.toggle },
      h('div', { className: 'oai-genie-wrap' }, h(GeniePet, { expression: genieExpressionOf(phase) }))),
    h('header', null,
      h(ProductLockup, { product: 'genie' }),
      joined ? h('span', { className: 'oai-team-line' }, h('span', { className: 'oai-on-team' }, h(Check), t('On your team'))) : null),
    h('p', { className: 'oai-about oai-wish' },
      h('img', { className: 'oai-wish-lamp', src: LAMP, alt: '', draggable: false }),
      t('Give it a wish, get one delivery.')),
    h(StartsWith, { type: genieTypeOf(host) }))
}

// Unfold's card: its box, its name, what it is. Joined once its Bot is on the team.
export function UnfoldCard({ power, host = null }) {
  const { phase, detail } = power
  const joined = phase === 'ready' || phase === 'restart'
  return h('article', { className: `oai-fighter oai-unfold${joined ? ' oai-chosen' : ''}`, 'data-phase': phase },
    h(Machine, { kind: 'unfold', phase, detail, onPower: power.toggle },
      h('div', { className: 'oai-unfold-wrap' }, h(UnfoldPet, { expression: genieExpressionOf(phase) }))),
    h('header', null,
      h('h2', null, 'Unfold'),
      joined ? h('span', { className: 'oai-team-line' }, h('span', { className: 'oai-on-team' }, h(Check), t('On your team'))) : null),
    h('p', { className: 'oai-about' }, t('Unfold itself, working inside DSH.')),
    h(StartsWith, { type: unfoldTypeOf(host) }))
}

// Genie's power button: on installs and starts it; off, before it joined, leaves it out.
const useGeniePower = () => useBotPower('genie', geniePowerOn)
// Unfold's, the same way.
const useUnfoldPower = () => useBotPower('unfold', unfoldPowerOn)
function useBotPower(kind, powerOnOf) {
  // The phase lives in the power store (power-store.js): an install keeps running, and shows,
  // after this card closes, and a Bot's settings card reads the same one.
  const { phase, detail } = usePowerState(kind)
  // The Bot may already be on the team (installed before a restart or an update, or made by
  // its plugin in Unfold's own instance): its card says so from the start, rather than asleep.
  useEffect(() => {
    let alive = true
    call(`${kind}-plugin`).then((reply) => {
      if (alive && reply?.ready && !WORKING.has(powerOf(kind).phase)) showPower(kind, 'ready', { bot: reply.bot })
    }, () => {})
    return () => { alive = false }
  }, [])
  const on = () => { runPower(kind, powerOnOf) }
  const off = () => powerOff(kind)
  return { phase, detail, toggle: () => (phase === 'asleep' ? on() : off()) }
}

// The power button's state, and the connecting a found Omni or a typed address does.
function usePower() {
  // Omni's phase lives in the power store, as Genie's does (useBotPower).
  const { phase, detail } = usePowerState('omni')
  const [busy, setBusy] = useState(null)
  const [problem, setProblem] = useState(null)
  // An Omni nobody owns yet, { url, claimUrl? }: how to make it yours comes first.
  const [unowned, setUnowned] = useState(null)
  const back = useRef(null)

  const show = (next, value = null) => showPower('omni', next, value)
  const on = () => {
    setProblem(null)
    runPower('omni', powerOn)
  }
  // Off is Remove: Omni sleeps again and does not join the team.
  const off = () => {
    setProblem(null)
    setBusy(null)
    powerOff('omni', { phase, detail })
  }

  // Each connect answers `paired`, `pairing` (approve it on the phone) or a message.
  const connect = async (row, endpoint, payload) => {
    setBusy(row)
    setProblem(null)
    try {
      const reply = await callOmniUi(endpoint, payload)
      if (powerSignal('omni')?.aborted) return
      if (reply.status === 'paired' || reply.pairing) setUnowned(null)
      if (reply.status === 'paired') show('linked', { origin: reply.origin ?? null })
      else if (reply.pairing) {
        back.current = { phase, detail }
        show('pairing', { pairing: reply.pairing })
      } else setProblem(reply.message ?? t('That Omni cannot approve this app from here. Connect Omni, next, can use its API key.'))
    } catch (error) {
      if (endpoint === 'omni-pair-start' && isUnowned(error.message)) setUnowned(current => ({ url: payload.url, claimUrl: current?.claimUrl ?? null }))
      else setProblem(error.message)
    } finally {
      setBusy(null)
    }
  }

  // A sign-in waits for the person's phone.
  useEffect(() => {
    if (phase !== 'pairing') return undefined
    let timer = 0
    let alive = true
    const tick = async () => {
      try {
        const reply = await callOmniUi('omni-pair-poll')
        if (!alive) return
        if (reply.status === 'paired') return show('linked', { origin: reply.origin ?? null })
        if (reply.status !== 'pending') {
          setProblem(reply.status === 'denied' ? t('The sign-in was denied.') : t('The code expired. Try again for a new one.'))
          return show(back.current?.phase ?? 'none', back.current?.detail ?? null)
        }
      } catch (error) {
        if (alive) setProblem(error.message)
      }
      if (alive) timer = setTimeout(tick, detail?.pairing?.pollIntervalMs ?? 2000)
    }
    timer = setTimeout(tick, detail?.pairing?.pollIntervalMs ?? 2000)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [phase])

  return {
    phase, detail, busy, problem, unowned,
    forgetUnowned: () => setUnowned(null),
    toggle: () => (phase === 'asleep' ? on() : off()),
    use: omni => connect(omni.id, 'omni-discover-use', { id: omni.id }),
    sandbox: () => {
      setProblem(null)
      back.current = { phase, detail }
      runPower('omni', sandboxInstall)
    },
    remote: wanted => (wanted.kind === 'bad-link'
      ? setProblem(t('That is not a link your Omni sends. It looks like https://your-omni/api/login/app?grant=…'))
      : wanted.kind === 'claim'
        ? (setProblem(null), setUnowned({ url: wanted.url, claimUrl: wanted.claimUrl }), window.open(wanted.claimUrl, '_blank', 'noreferrer'))
      : wanted.kind === 'grant' ? connect('remote', 'omni-connect-grant', { url: wanted.url, grant: wanted.grant }) : connect('remote', 'omni-pair-start', { url: wanted.url })),
    cancelPairing: () => {
      void callOmniUi('omni-pair-cancel').catch(() => {})
      show(back.current?.phase ?? 'none', back.current?.detail ?? null)
    },
  }
}

// The product the desktop app was opened for (state.preload: 'omni', 'genie', 'unfold' or null,
// from AUTOMAGIK_PRELOAD): its card comes first and starts chosen, Omni's by powering on through
// its box as a press would. The other cards stay there to add, then or later. Unfold's card is
// shown only in Unfold's own instance, which always opens for Unfold (preload 'unfold'), and
// comes first there.
export function teamOrder(preload) {
  if (preload === 'unfold') return ['unfold', 'omni', 'genie']
  return preload === 'genie' ? ['genie', 'omni'] : ['omni', 'genie']
}
export const cardsOf = preload => teamOrder(preload)
export const preselected = preload => ({ omni: preload === 'omni', genie: preload === 'genie', ...(preload === 'unfold' ? { unfold: true } : {}) })
// Whether Omni powers on by itself now: preloaded, still asleep, and never switched off here.
export const powersOnByItself = (preload, phase, detail, started, kind = 'omni') =>
  preselected(preload)[kind] === true && !started && phase === 'asleep' && detail?.removed !== true

// Who joins, in words, for the button.
export function joinedLabel({ omni, genie, unfold = false }, name) {
  const who = [omni && 'Omni', genie && 'Genie', unfold && 'Unfold'].filter(Boolean)
  return who.length === 0 ? t('Continue with just {name}', { name }) : t('Continue with {who}', { who: who.join(t(' and ')) })
}

// The speech bubble, by Omni's phase.
const speechOf = (phase, name, origin) => ({
  asleep: t('{name} here! Omni is asleep. Click its power button to bring it along.', { name }),
  waking: t('Omni is waking up…'),
  installing: t('Bringing Omni into this DSH. One moment.'),
  starting: t('Omni is starting up…'),
  looking: t('Omni is looking for a connection…'),
  found: t('Omni found where your channels live!'),
  none: t('No Omni here yet. Tell Omni where yours lives.'),
  pairing: t('Approve this device, and Omni connects.'),
  sandbox: t('Omni is moving in. This takes a few minutes the first time.'),
  linked: origin ? t('Omni is connected to {origin}!', { origin }) : t('Omni is connected!'),
  restart: t('Omni is installed. Restart DSH to wake it.'),
  failed: t('Omni could not be installed here.'),
})[phase]
const unfoldSpeechOf = phase => ({
  waking: t('Unfold is waking up…'),
  installing: t('Bringing Unfold into this DSH. One moment.'),
  starting: t('Unfold is starting up…'),
  ready: t('Unfold is on your team.'),
  restart: t('Unfold is installed. Restart DSH to wake it.'),
  failed: t('Unfold could not be installed here.'),
})[phase]
const genieSpeechOf = phase => ({
  waking: t('Genie is waking up…'),
  installing: t('Bringing Genie into this DSH. One moment.'),
  starting: t('Genie is starting up…'),
  ready: t('Genie is on your team. Give it a wish once you are in!'),
  restart: t('Genie is installed. Restart DSH to wake it.'),
  failed: t('Genie could not be installed here.'),
})[phase]

// The step's opening: who leads, and the rule for code work. A Bot with Computer is one
// whose sidebar row and profile wear that pill (bots-dsh capability-pills.js).
export const TeamLede = ({ name }) => h('p', { className: 'oai-lede' },
  t('{name} leads. Who comes along?', { name }), h('br'),
  h('span', { className: 'oai-lede-rule' }, t('Code work goes to a Bot with Computer.')))

// Opened on purpose (DSH's `explicit`), the step is a place to power Bots on: Continue only
// closes it. It saves no team, so it never puts the companion's name back on the Main Bot
// (companion.js applyCompanion) nor skips Connect Omni.
export const explicitOf = props => props?.explicit === true

export function TeamStep(props) {
  const explicit = explicitOf(props)
  const state = useGate(explicit ? { ...props, explicit: true } : props)
  const finish = useFinish(props)
  const [glitching, glitch] = useGlitch()
  const power = usePower()
  const geniePower = useGeniePower()
  const unfoldPower = useUnfoldPower()
  // The speech follows whichever box was pressed last.
  const [lastPressed, setLastPressed] = useState('omni')
  const [omniType, setOmniType] = useState(null)
  const [abilities, setAbilities] = useState({})
  const [live, setLive] = useState(undefined)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(null)
  const autoPowered = useRef(false)
  const genieAutoPowered = useRef(false)
  const unfoldAutoPowered = useRef(false)

  const { phase } = power
  // Read again once Omni is awake, when what it brings may have just been installed.
  const awakeNow = phase === 'looking' || phase === 'linked'
  useEffect(() => { call('bot-type', { type: 'omni' }).then(setOmniType, () => {}) }, [awakeNow])
  useEffect(() => { callOmniUi('omni-overview', {}).then(setLive, () => setLive(null)) }, [])
  useEffect(() => {
    if (phase !== 'linked') return
    callOmniUi('omni-overview', {}).then(setLive, () => setLive(null))
    glitch()
  }, [phase, glitch])
  useEffect(() => { if (state) glitch() }, [state, glitch])
  useEffect(() => {
    if (!state || !powersOnByItself(state.preload, power.phase, power.detail, autoPowered.current)) return
    autoPowered.current = true
    power.toggle()
  }, [state])
  useEffect(() => {
    if (!state || !powersOnByItself(state.preload, geniePower.phase, geniePower.detail, genieAutoPowered.current, 'genie')) return
    genieAutoPowered.current = true
    setLastPressed('genie')
    geniePower.toggle()
  }, [state])
  useEffect(() => {
    if (!state || !powersOnByItself(state.preload, unfoldPower.phase, unfoldPower.detail, unfoldAutoPowered.current, 'unfold')) return
    unfoldAutoPowered.current = true
    setLastPressed('unfold')
    unfoldPower.toggle()
  }, [state])
  if (!state) return null

  const name = state.companionName ?? t('Your companion')
  const omni = phase !== 'asleep' && phase !== 'failed'
  const genie = geniePower.phase === 'ready' || geniePower.phase === 'restart'
  const genieWorking = ['waking', 'installing', 'starting'].includes(geniePower.phase)
  // Opened for Unfold, Unfold leads (it is the Main Bot); elsewhere it joins beside the others.
  const unfold = state.preload !== 'unfold' && (unfoldPower.phase === 'ready' || unfoldPower.phase === 'restart')
  const unfoldWorking = ['waking', 'installing', 'starting'].includes(unfoldPower.phase)
  const working = ['waking', 'installing', 'starting', 'looking', 'sandbox'].includes(phase)

  async function go({ omni: joined = omni } = {}) {
    if (explicit) {
      props.complete?.()
      return
    }
    setSaving(true)
    setProblem(null)
    try {
      await call('team-save', { omni: joined, genie, omniAbilities: { ...abilitiesOf(omniType), ...abilities } })
      // Omni's card is where Omni connects: Omni's own Connect step (omni-channels-dsh) does not
      // follow it. Unlinked, Omni connects later from Channels.
      if (joined) await call('done', { stepId: 'omni-connect' }).catch(() => {})
      finish()
    } catch (error) {
      setProblem(error.message)
      setSaving(false)
    }
  }
  // Unfold's own instance bundles its Omni: no new Omni of its own is offered there. The machine
  // DSH runs on rides along, for the choices that name it.
  const omniPower = { ...power, local: state.host === 'unfold' ? undefined : power.sandbox, machine: state.machine }
  const speech = (lastPressed === 'genie' && genieSpeechOf(geniePower.phase)) || (lastPressed === 'unfold' && unfoldSpeechOf(unfoldPower.phase)) || speechOf(phase, name, power.detail?.origin)

  return h(Stage, {
    title: t('Grow your team'),
    speech,
    at: 'omni-team',
    glitching,
    wide: true,
  },
  h(TeamLede, { name }),
  h('div', { className: 'oai-select' },
    ...cardsOf(state.preload).map(id => (id === 'omni'
      ? h(OmniCard, { key: 'omni', power: omniPower, onPower: () => { setLastPressed('omni'); power.toggle() }, type: omniType, abilities, onToggle: (row, on) => setAbilities(rows => ({ ...rows, [row]: on })), live })
      : id === 'genie'
        ? h(GenieCard, { key: 'genie', host: state.host ?? null, power: { ...geniePower, toggle: () => { setLastPressed('genie'); geniePower.toggle() } } })
        : h(UnfoldCard, { key: 'unfold', host: state.host ?? null, power: { ...unfoldPower, toggle: () => { setLastPressed('unfold'); unfoldPower.toggle() } } })))),
  problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null,
  h('div', { className: 'oai-actions' },
    h('button', { type: 'button', className: 'oai-primary oai-big', disabled: saving || working || genieWorking || unfoldWorking, onClick: () => go() },
      saving ? t('Bringing them in…') : phase === 'sandbox' ? t('Omni is moving in…') : working ? t('Omni is waking…') : genieWorking ? t('Genie is waking…') : unfoldWorking ? t('Unfold is waking…') : joinedLabel({ omni, genie, unfold }, name))))
}
