// Settings → About Automagik: the version, updates for Automagik and DSH, the plugins' versions
// and the links to the repository. The sidebar's cloud button shows the same update state.
// Inside the Automagik app the page is the app's: its version, its update and its plugins come
// from the app (desktop-update.js); in a plain DSH the Bot team's own update (Omni's) shows.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { GitHubMark } from './connectors.js'
import { whenText } from './feedback.js'
import { dateLocale, hostText, t } from './i18n.js'
import { StarLineIcon } from './icons.js'
import { SPRING_POP } from './motion.js'
import { BotMark } from './mark.js'
import { MAIN_LOOK } from './characters.js'
import { showsDshRow } from './dsh-offer.js'
import { appState, pluginName, updatePill, useDesktopUpdate, useDesktopVersions } from './desktop-update.js'
import { opensIntoPlugins, splitsPlugins } from './update-hold.js'
import { Switch } from './bot-settings.js'

// The length of the mark's `done` hop (bt-done in styles.js).
const CHEER_MS = 1800

const starCount = count => new Intl.NumberFormat(dateLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(count)

// Inside the Automagik app: the app says so itself (its bridge), or the host does.
const inApp = (update, app) => Boolean(app.bridge) || update.source === 'app'

// A copy of the app that says it does not update (a development run, or updates switched off).
const updatesOff = versions => versions?.updates === false

function botHint(update, app, versions) {
  // In the Automagik app everything updates with the app: the row follows the app's update,
  // whatever the plugin's own check setting says.
  if (inApp(update, app)) {
    if (updatesOff(versions)) return t('Updates are off in this copy of Automagik.')
    return (app.bridge ? updatePill(appState(app.state))?.label : null) ?? t('Updates come with the Automagik app.')
  }
  if (update.phase === 'installing') return t('Updating Omni…')
  if (update.phase === 'installed') return t('Restart DSH to start using Omni {version}.', { version: update.installed ?? update.latest })
  if (update.phase === 'updated') return t('Omni {version} is installed.', { version: update.installed ?? update.latest })
  if (update.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(update.error ?? '') })
  if (update.available) return t('Omni {version} is available', { version: update.latest })
  if (update.enabled === false) return t('Update checks are off.')
  if (update.source === 'path') return t('Installed from a local folder; update it there.')
  if (!update.checkedAt) return null
  if (!update.latest && update.source !== 'registry') return t('Updates are not offered for this install.')
  const checked = t('Checked {time}', { time: whenText(update.checkedAt) })
  return `${update.latest ? t('Up to date') : t('Could not check for updates.')} · ${checked}`
}

function dshHint(dsh, shown) {
  if (dsh.phase === 'installing') return t('Updating DSH…')
  if (dsh.phase === 'installed') return t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
  if (dsh.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(dsh.error ?? '') })
  if (dsh.available === false && dsh.blockedBy) return t('Update Omni {version} first.', { version: dsh.blockedBy })
  if (shown) return t('DSH {version} is available', { version: dsh.verified })
  return t('Version {version}', { version: dsh.current })
}

// One plugin the app's lane updates, as About → Updates lists it.
function pluginHint(change, plugins) {
  const versions = change.from ? `${change.from} → ${change.to}` : change.to
  if (plugins.phase === 'downloading') return `${versions} · ${t('Downloading · {percent}%', { percent: plugins.percent ?? 0 })}`
  if (plugins.phase === 'installing') return `${versions} · ${t('Updating…')}`
  return `${versions} · ${plugins.auto === false ? t('Waits for a restart') : t('Updates when no agent is at work')}`
}

// The plugins this copy of the app runs, each with its own version, as the app reads them.
// An app that does not say has only the Bot team's own, from its host.
function versionRows({ versions, update, Row }) {
  const plugins = versions ? (Array.isArray(versions.plugins) ? versions.plugins : []) : [{ name: update.name, version: update.current }]
  return plugins
    .filter(plugin => typeof plugin?.name === 'string' && typeof plugin.version === 'string')
    .map(plugin => h(Row, { key: `version:${plugin.name}`, label: pluginName(plugin.name), hint: pluginVersionHint(plugin, versions?.latest?.[plugin.name]) }))
}

// The plugins the Automagik app updates by itself (its lane): a row for each one updating, and the
// switch that lets them go in without a restart.
function pluginRows({ app, Row }) {
  const plugins = splitsPlugins(app.state) ? app.state.plugins : null
  if (!plugins || !app.bridge) return []
  const changes = Array.isArray(plugins.changes) ? plugins.changes : []
  const auto = plugins.auto !== false
  const rows = changes.map(change => h(Row, { key: `plugin:${change.name}`, label: pluginName(change.name), hint: pluginHint(change, plugins) },
    plugins.phase === 'ready' && plugins.auto === false && app.bridge.applyPlugins
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void app.bridge.applyPlugins().catch(() => {}) } }, t('Update now'))
      : null))
  if (typeof app.bridge.setAutoApply === 'function') {
    rows.push(h(Row, {
      key: 'plugins:auto',
      label: t('Apply plugin updates automatically'),
      hint: auto ? t('A plugin update goes in once no agent is at work: DSH restarts for a few seconds and the window stays.') : t('Plugin updates wait until you update them here or restart Automagik.'),
    }, h(Switch, { on: auto, label: t('Apply plugin updates automatically'), onChange: on => { void app.bridge.setAutoApply(on).catch(() => {}) } })))
  }
  return rows
}

// Versions from the desktop are semver text, including prereleases.
function newerVersion(next, current) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?(?:\+[\w.]+)?$/.exec(value ?? '')
  const a = parse(next), b = parse(current)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +a[i] > +b[i]
  if (!a[4] || !b[4]) return !a[4] && Boolean(b[4])
  const x = a[4].split('.'), y = b[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined || y[i] === undefined) return y[i] === undefined
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i])
    if (nx && ny) return +x[i] > +y[i]
    return nx !== ny ? !nx : x[i] > y[i]
  }
  return false
}

function pluginVersionHint(plugin, latest) {
  return newerVersion(latest, plugin.version)
    ? t('Version {version} · {latest} available', { version: plugin.version, latest })
    : t('Version {version}', { version: plugin.version })
}

function forceHint(force) {
  switch (force?.phase) {
    case 'stopping': return t('Stopping conversations…')
    case 'checking': return t('Checking for updates…')
    case 'downloading': return t('Downloading the Automagik update…')
    case 'installing': return t('Installing…')
    case 'restarting': return t('Restarting…')
  }
  switch (force?.code) {
    case 'up-to-date': return t('Everything is up to date.')
    case 'updated': return t('Updated.')
    case 'plugins-rolled-back': return t('The plugins did not start, so the previous ones are back.')
    case 'app-download-failed': return t('The Automagik update could not be downloaded. Try again.')
    case 'app-manual': return t("This copy updates through your system's package manager.")
    case 'restart-failed': return t('The restart did not finish. Try again.')
    default: return pluginReason({ reason: force }) ?? t('Stops running conversations and sign-ins, installs every available update and restarts.')
  }
}

function pluginReason(versions) {
  const params = versions?.reason?.params ?? {}
  switch (versions?.reason?.code) {
    case 'app-line': return t('Plugins {version} need Automagik {line}; this app is {app}. Update Automagik first.', params)
    case 'app-minimum': return t('Plugins {version} need Automagik {base} or newer; this app is {app}.', params)
    case 'trial-failed': return t('Plugins {version} did not start here before, so the current ones are kept.', params)
    case 'dsh-range': return t('Plugins {version} need a different DeepSeek Harness version.', params)
    case 'older-sequence':
    case 'invalid-lane': return t('The published plugin update was not accepted.')
    case 'not-checked':
    case 'check-failed': return t('Plugin updates could not be checked. Try again.')
    default: return null
  }
}

const linkProps = href => ({ className: 'bt-soft bt-soft-sm bt-about-link', href, target: '_blank', rel: 'noopener noreferrer' })

export function AboutPage({ useUpdate, actions, run, Section, Row }) {
  const update = useUpdate(value => value) ?? {}
  const app = useDesktopUpdate()
  const versions = useDesktopVersions(app.state)
  const [checking, setChecking] = useState(false)
  const [stars, setStars] = useState(null)
  useEffect(() => {
    let live = true
    actions.repoStars().then((count) => { if (live && Number.isInteger(count)) setStars(count) }, () => {})
    return () => { live = false }
  }, [])
  // The whale hops when the page opens, after a check, and when an update is in.
  const [cheer, setCheer] = useState(true)
  useEffect(() => {
    if (!cheer) return undefined
    const timer = setTimeout(() => setCheer(false), CHEER_MS)
    return () => clearTimeout(timer)
  }, [cheer])
  const check = () => {
    setChecking(true)
    void run(actions.checkUpdate()).then((done) => { setChecking(false); if (done) setCheer(true) })
  }
  const phase = update.phase ?? 'idle'
  const dsh = update.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  useEffect(() => { if (phase === 'installed' || phase === 'updated' || dshPhase === 'installed') setCheer(true) }, [phase, dshPhase])
  const markState = checking ? 'searching' : phase === 'installing' || dshPhase === 'installing' ? 'working' : cheer ? 'done' : 'idle'
  // Same rule as the sidebar card.
  const dshNew = showsDshRow(dsh, update.app)
  const dshShown = dshNew && dsh.available
  const appPill = updatePill(appState(app.state))
  const appBusy = ['checking', 'downloading', 'installing'].includes(appState(app.state)?.phase)
  const ours = inApp(update, app)
  // A check is only a check (the app's `check`): `open` also restarts into an update that is
  // ready and puts staged plugins in, so it is asked only under the label that says so. An
  // app from before `check` has only `open`.
  // That app's `open` is not asked while it would restart DSH under the agents at work, with
  // auto-apply on or off (#1029).
  const [confirmForce, setConfirmForce] = useState(false)
  const [pendingForce, setPendingForce] = useState(null)
  const forceSent = useRef(false)
  const force = pendingForce ?? app.state?.force
  const forceBusy = Boolean(force?.phase && !['done', 'failed'].includes(force.phase))
  const canForce = typeof app.bridge?.force === 'function' && !updatesOff(versions)
  const startForce = () => {
    if (!canForce || forceBusy || forceSent.current) return
    forceSent.current = true
    setConfirmForce(false)
    setPendingForce({ phase: 'stopping' })
    void Promise.resolve().then(() => app.bridge.force()).then(() => setPendingForce(null), () => {
      setPendingForce({ phase: 'failed', code: 'restart-failed' })
    }).finally(() => { forceSent.current = false })
  }
  // Main owns progress, including after the page is reloaded by the restart.
  useEffect(() => { if (app.state?.force) setPendingForce(null) }, [app.state?.force])
  const reason = pluginReason(versions)
  const held = opensIntoPlugins(app.bridge, app.state)
  const appCheck = () => {
    if (held) return
    void (typeof app.bridge.check === 'function' ? app.bridge.check() : app.bridge.open()).catch(() => {})
  }
  const botControl = ours
    ? app.bridge && !updatesOff(versions)
      // The app's own button: restart into a downloaded update or open its release, else check.
      ? appPill?.primary
        ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: appBusy, onClick: () => { void app.bridge.open().catch(() => {}) } }, appPill.label)
        : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: appBusy || held, onClick: appCheck }, appBusy ? t('Checking…') : t('Check for updates'))
      : null
    : phase === 'installed' || phase === 'updated' ? null
    : update.available || phase === 'installing'
      ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: phase === 'installing', onClick: () => run(actions.installUpdate()) },
          phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: checking || update.enabled === false, onClick: check }, checking ? t('Checking…') : t('Check for updates'))
  const dshControl = !dshNew || dshPhase === 'installed' ? null
    : dsh.kind === 'app'
      ? dsh.available ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openAppUpdates(dsh.verified)) }, t('Open updates')) : null
      : dsh.available || dshPhase !== 'idle'
        ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: dshPhase === 'installing', onClick: () => run(actions.installDshUpdate()) },
            dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update'))
        : null
  const repo = update.repoUrl
  // The app's own version inside the app; in a plain DSH the Bot team's is the only one there is.
  const version = ours ? versions?.app : update.current
  const plugins = ours ? versionRows({ versions, update, Row }) : []
  return [
    h('div', { key: 'hero', className: 'bt-about-hero' },
      h('span', { className: 'bt-about-mark' }, h(BotMark, { look: MAIN_LOOK, bot: { id: 'about' }, size: 52, state: markState, live: true, gaze: true, pokeable: true })),
      h('div', { className: 'bt-about-copy' },
        h('span', { className: 'bt-about-name' }, 'Automagik'),
        version ? h('span', { className: 'bt-about-version' }, t('Version {version}', { version })) : null),
      repo ? h('a', {
        className: 'bt-star', href: repo, target: '_blank', rel: 'noopener noreferrer', title: t('Star Omni on GitHub'),
        'aria-label': stars === null ? t('Star Omni on GitHub') : `${t('Star Omni on GitHub')} · ${t('{count} stars', { count: stars })}`,
      },
      h('span', { className: 'bt-star-main' }, h('span', { className: 'bt-star-icon' }, h(StarLineIcon)), 'Star'),
      stars === null ? null : h('span', { className: 'bt-star-count' }, starCount(stars))) : null),
    repo ? h('p', { key: 'ask', className: 'bt-about-ask' }, t('If Omni helps you, a star on GitHub helps more people find it.')) : null,
    h(Section, { key: 'updates', title: t('Updates') },
      h(Row, { label: ours ? 'Automagik' : 'Omni', hint: botHint(update, app, versions) }, botControl, update.available && update.notesUrl ? h('a', linkProps(update.notesUrl), t("What's new")) : null),
      dsh?.current ? h(Row, { label: 'DeepSeek Harness', hint: dshHint(dsh, dshShown) }, dshControl)
        // With the plugin's own check off, the app still knows the runtime it carries.
        : ours && typeof versions?.dsh === 'string' ? h(Row, { label: 'DeepSeek Harness', hint: t('Version {version}', { version: versions.dsh }) }) : null,
      ...pluginRows({ app, Row }),
      reason ? h(Row, { label: t('Plugin updates'), hint: reason }) : null,
      canForce ? h(Row, { label: t('Force update'), hint: confirmForce && !forceBusy
        ? t('Running conversations, tasks and Bot sign-ins stop now. Bots that were signing in ask you to sign in again.') : forceHint(force) },
      confirmForce && !forceBusy ? [
        h('button', { key: 'stop', type: 'button', className: 'bt-fb-primary', onClick: startForce }, t('Stop and update')),
        h('button', { key: 'cancel', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirmForce(false) }, t('Cancel')),
      ] : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: forceBusy, onClick: () => { if (!forceBusy) setConfirmForce(true) } }, t('Force update'))) : null),
    plugins.length > 0 ? h(Section, { key: 'plugins', title: t('Plugins') }, ...plugins) : null,
    h(Section, { key: 'links', title: t('Links') },
      repo ? h(Row, { label: t('Source code'), hint: repo.replace(/^https:\/\//, '') }, h('a', linkProps(repo), h(GitHubMark), t('Open'))) : null,
      update.notesUrl ? h(Row, { label: t('Release notes') }, h('a', linkProps(update.notesUrl), t('Open'))) : null,
      h(Row, { label: t('Report a problem') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('feedback') }, t('Open')))),
  ]
}

export const ABOUT_CSS = `
.bt-about-hero{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-about-mark{flex:none;display:inline-flex;position:relative}
.bt-about-mark::before{content:'';position:absolute;inset:-20%;border-radius:50%}
body:not([data-bt-motion=quiet]) .bt-about-mark:hover .bt-mark[data-live][data-state=idle]:not(.bt-mark-poke) .bt-b{rotate:8deg;translate:5% -1%;animation:bt-nuzzle .78s ease-in-out .32s infinite}
body:not([data-bt-motion=quiet]) .bt-about-mark:hover .bt-mark[data-live][data-state=idle] .bt-eye{scale:1 0;animation:none}
body:not([data-bt-motion=quiet]) .bt-about-mark:hover .bt-mark[data-live][data-state=idle] .bt-eye-happy{opacity:1;transition-delay:.1s}
.bt-about-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-about-name{font-size:16px;line-height:22px;font-weight:600}
.bt-about-version{font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-about-ask{margin:-10px 4px 0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-star{flex:none;display:inline-flex;align-items:stretch;height:30px;border-radius:999px;border:1px solid var(--bt-line-2,var(--bt-line));overflow:hidden;color:var(--bt-ink);text-decoration:none;font-size:12px;line-height:28px;transition:transform .12s ease,border-color .15s ease}
.bt-star:hover{border-color:color-mix(in srgb,#e3a008 55%,var(--bt-line))}
.bt-star:active{transform:scale(.96)}
.bt-star-main{display:inline-flex;align-items:center;gap:6px;padding:0 12px 0 10px;background:var(--bt-hover);font-weight:500}
.bt-star-icon{display:inline-flex;color:var(--bt-ink-2);transition:color .15s ease}
.bt-star-icon path{transition:fill .15s ease}
.bt-star:hover .bt-star-icon{color:#e3a008;animation:bt-star-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-star:hover .bt-star-icon path{fill:currentColor}
.bt-star-count{display:inline-flex;align-items:center;padding:0 11px;border-left:1px solid var(--bt-line-2,var(--bt-line));color:var(--bt-ink-2);font-variant-numeric:tabular-nums;animation:bt-star-count-in ${SPRING_POP.duration}ms ${SPRING_POP.easing},bt-veil-in .2s ease-out}
@keyframes bt-star-pop{from{scale:.6;rotate:-30deg}}
@keyframes bt-star-count-in{from{translate:-6px 0}}
.bt-about-link{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.bt-about-link svg{width:14px;height:14px}
.bt-fb-primary:disabled{opacity:.6;cursor:default;filter:none}
@media (prefers-reduced-motion:reduce){.bt-star:hover .bt-star-icon,.bt-star-count{animation:none}}
`
