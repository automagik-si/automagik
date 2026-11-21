import { CHECK_FRESH_MS } from '../shared/self-update.js'
import { failedHealthCheck, runMessage, selfUpdateReason } from './about.js'
import { changeText, pluginName } from './desktop-update.js'
import { sameVersion } from './dsh-offer.js'
import { language, t } from './i18n.js'
import { recoveryDetails } from './self-update-recovery.js'
import { roundButtonCss, SHELL_DARK_PALETTE, SHELL_LIGHT_PALETTE } from './styles.js'

const classic = 'html:not(:has(style[data-dsh-bot="shell"]))'
const CSS = `
/* The dialog and nod also appear in classic Agent mode, where the Bot shell sheet is absent. */
${classic} body :is(.su-layer,.su-nod){${SHELL_LIGHT_PALETTE}}
${classic} body[data-ds-dark-theme] :is(.su-layer,.su-nod){${SHELL_DARK_PALETTE}}
${roundButtonCss(`${classic} body .su-nod.bt-round`)}
/* The nod is one of the bar's own round buttons (.bt-round), seated in the bottom row like the
   other footer entries, never a floating pill of its own: same 36px circle, same --bt-* colours. */
.su-nod{position:relative}
.su-nod .su-dot{position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--bt-accent);box-shadow:0 0 0 2px var(--bt-main)}
.su-layer{position:fixed;inset:0;z-index:80;display:flex;background:var(--bt-main);animation:su-veil .18s ease-out;font-family:var(--bt-font,system-ui)}
.su-modal{width:100%;height:100%;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);animation:su-pop .22s cubic-bezier(.34,1.3,.64,1)}
.su-head{display:flex;align-items:flex-start;gap:12px;padding:20px max(24px,calc((100vw - 760px)/2)) 0}
.su-head h2{margin:0;font-size:17px;line-height:24px;font-weight:600}
.su-close{margin-left:auto;border:0;background:transparent;color:var(--bt-ink-2);font:500 13px/18px var(--bt-font,system-ui);cursor:pointer;padding:2px 4px;border-radius:8px}
.su-close:hover{background:var(--bt-hover);color:var(--bt-ink)}
.su-body{flex:1;overflow:auto;padding:18px max(24px,calc((100vw - 760px)/2)) 24px;display:flex;flex-direction:column;gap:14px}
.su-body.su-fill{justify-content:safe center}
.su-body.su-center{align-items:center;text-align:center}
.su-line{margin:0;font-size:14px;line-height:21px;color:var(--bt-ink)}
.su-versions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--bt-ink-2)}
.su-version{padding:3px 8px;border-radius:8px;background:var(--bt-tag-bg);font-variant-numeric:tabular-nums;color:var(--bt-ink)}
.su-changes{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px;line-height:21px}
.su-steps{display:flex;flex-direction:column;gap:2px}
.su-step{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;font-size:14px;line-height:20px;color:var(--bt-ink-2)}
.su-step[data-state=active]{background:var(--bt-accent-soft);color:var(--bt-ink)}
.su-step[data-state=active] .su-mark{border-color:var(--bt-accent);background:var(--bt-accent-soft);color:var(--bt-accent)}
.su-step[data-state=done]{color:var(--bt-ink)}
.su-mark{width:20px;height:20px;flex:none;border-radius:50%;border:1.5px solid var(--bt-line-2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.su-step[data-state=done] .su-mark{border-color:transparent;background:var(--bt-accent);color:var(--bt-accent-ink)}
.su-note{margin:0;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.su-caution{margin:0;padding:9px 11px;border-radius:10px;background:var(--bt-accent-soft);color:var(--bt-ink);font:500 13px/20px var(--bt-font,system-ui)}
.su-foot{display:flex;gap:10px;align-items:center;padding:14px max(24px,calc((100vw - 760px)/2)) 18px;border-top:.5px solid var(--bt-line);background:var(--bt-main)}
.su-foot:empty{display:none}
.su-primary{border:0;border-radius:10px;padding:10px 16px;background:var(--bt-accent);color:var(--bt-accent-ink);font:600 14px/18px var(--bt-font,system-ui);cursor:pointer}
.su-primary:hover{filter:brightness(1.05)}
.su-ghost{border:.5px solid var(--bt-line-2);border-radius:10px;padding:9px 14px;background:transparent;color:var(--bt-ink);font:500 14px/18px var(--bt-font,system-ui);cursor:pointer}
.su-ghost:hover{background:var(--bt-hover)}
.su-result{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8vh 0 4px;text-align:center}
.su-result .su-badge{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--bt-accent-ink);background:var(--bt-accent)}
.su-result[data-kind=rollback] .su-badge{background:var(--bt-danger)}
.su-result h3{margin:0;font-size:16px;line-height:22px;font-weight:600}
.su-result p{margin:0;max-width:52ch;font-size:13px;line-height:20px;color:var(--bt-ink-2)}
@keyframes su-veil{from{opacity:0}to{opacity:1}}
@keyframes su-pop{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.su-modal,.su-layer{animation:none}}
`

const STEPS = [
  ['checking', 'Checking the signed release'],
  ['downloading', 'Downloading the new version'],
  ['verifying', 'Verifying the downloaded packages'],
  ['staging', 'Installing beside the current version'],
  ['restarting', 'Restarting and checking health'],
]
const PHASE_STEP = { checking: 0, downloading: 1, verifying: 2, staging: 3, switching: 3, restarting: 4, health: 4 }
const active = run => Object.hasOwn(PHASE_STEP, run?.phase) || run?.phase === 'rollingBack'
const terminal = run => ['healthy', 'rolledBack', 'notUpdated', 'manualRecovery'].includes(run?.phase)
const enabled = status => status?.startEnabled === true && status.supervisor != null && status.reason !== 'desktop-app'
const pendingWindowMs = 75_000 // The host's stop wait and the supervisor's request acceptance window.
const statusTimeoutMs = 10_000
const terminalKey = 'omni-ui:self-update-result:'
const documentUpdate = Symbol.for('omni-ui:web-self-update')

function canOffer(status, now) {
  const check = status?.check
  const checkedAt = Date.parse(check?.checkedAt)
  const age = now - checkedAt
  return enabled(status) && status.available === true && status.startRefusal === null
    && !active(status.run) && status.run?.phase !== 'manualRecovery'
    && (!terminal(status.run) || !(checkedAt <= Date.parse(status.run.startedAt)))
    && check?.state === 'available' && check.newer === true && check.fresh === true && age >= 0 && age < CHECK_FRESH_MS
}

const candidateOf = ({ check: { sequence, laneVersion, plugins }, rollback }) => JSON.stringify([
  sequence, laneVersion, plugins.map(({ name, from, to }) => [name, from, to]), rollback === true,
])

/** Live status confirms progress. Connection loss can show an unconfirmed restart. */
export function createSelfUpdateController({
  readStatus, startUpdate, present, onStatus = () => {}, keepChat = () => {}, storage,
  now = Date.now, visible = () => true,
}) {
  let status
  let run
  let screen = null
  let dismissed
  let offline = false
  let connectionLost = false
  let refused = null
  let confirmation = null
  let attempt = null
  let latestRead = 0
  let reading
  let disposed = false
  let disconnected = false
  let keeping = false
  let connection
  let offConnection
  const shown = new Set()
  const offer = () => !attempt && !offline && canOffer(status, now())
  const paint = () => {
    const nod = active(run) || attempt ? 'progress' : offer() ? 'offer' : null
    present({ nod, screen, run, offline, connectionLost, refused, check: status?.check, rollback: status?.rollback === true,
      recovery: status?.recovery, retry: !confirmation && offer() })
  }
  const holdChat = () => {
    if (keeping) return
    keeping = true
    keepChat(true)
  }
  const releaseChat = (restore = false) => {
    if (!keeping) return
    keeping = false
    keepChat(false, restore && disconnected)
    disconnected = false
  }
  const seen = id => {
    if (shown.has(id)) return true
    try { return storage?.getItem(terminalKey + id) === '1' } catch { return false }
  }
  const noteShown = id => {
    shown.add(id)
    try { storage?.setItem(terminalKey + id, '1') } catch {}
  }
  const showResult = () => {
    const id = run?.runId
    if (!terminal(run) || !visible() || seen(id)) return false
    screen = 'result'
    paint()
    noteShown(id)
    return true
  }
  const clear = () => {
    status = undefined
    run = undefined
    screen = null
    confirmation = null
    attempt = null
    offline = false
    connectionLost = false
    refused = null
    releaseChat()
    paint()
  }
  const apply = (next) => {
    if (!enabled(next)) { clear(); return }
    if (next.problem) {
      offline = true
      paint()
      return
    }
    offline = false
    connectionLost = false
    status = next
    const live = next.run
    if (attempt) {
      const expired = now() - attempt.at >= pendingWindowMs
      const matches = attempt.requestId ? live?.requestId === attempt.requestId
        : (attempt.lost || expired) && live?.requestId && live.runId !== attempt.before
      if (matches) {
        if (attempt.dismissed) dismissed = live.runId
        attempt = null
      } else {
        if (!expired) {
          paint()
          return
        }
        attempt = null
        refused = 'unconfirmed'
        releaseChat()
      }
    }
    const previousRun = run?.runId
    run = live
    if (active(run)) {
      holdChat()
      if (run.runId !== dismissed) screen = 'progress'
    } else {
      releaseChat(terminal(run))
      if (showResult()) return
      if (screen === 'progress' || (screen === 'offer' && !offer())) {
        screen = refused ? 'refused' : null
      } else if (screen === 'result' && (!terminal(run) || run.runId !== previousRun)) {
        screen = null
      }
    }
    paint()
  }

  const refresh = async ({ force = false } = {}) => {
    if (disposed || (reading && !force)) return
    if (connection && ['connecting', 'disconnected'].includes(connection.getSnapshot())) return
    const read = ++latestRead
    reading?.abort()
    const controller = new AbortController()
    const { signal } = controller
    reading = controller
    const stopped = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const timeout = setTimeout(() => controller.abort(), statusTimeoutMs)
    try {
      const next = await Promise.race([stopped, readStatus(signal)])
      if (!disposed && read === latestRead) {
        if (!next?.problem) onStatus(next)
        apply(next)
        return next
      }
    } catch (error) {
      if (disposed || read !== latestRead) return
      if (error?.code === 'bot/read-only') { onStatus(null); clear(); return }
      offline = true
      if (error?.code === 'NETWORK') {
        connectionLost = true
        if (keeping) disconnected = true
      }
      paint()
    } finally {
      clearTimeout(timeout)
      if (read === latestRead) reading = undefined
    }
  }

  const cancelRead = () => {
    latestRead += 1
    reading?.abort()
    reading = undefined
  }
  const unconfirm = (lostConnection) => {
    offline = true
    connectionLost ||= lostConnection
    if (keeping) disconnected = true
    if (attempt && !attempt.requestId) attempt.lost = true
    paint()
  }
  const watchConnection = (source, detached = false) => {
    offConnection?.()
    cancelRead()
    connection = source
    let state = source?.getSnapshot()
    offConnection = source?.subscribe(() => {
      const next = source.getSnapshot()
      if (state === next) return
      state = next
      cancelRead()
      if (next === 'connected') void refresh()
      else unconfirm(true)
    })
    const unavailable = state === 'connecting' || state === 'disconnected'
    if (detached || unavailable) unconfirm(unavailable)
    else void refresh()
  }

  const open = () => {
    if (active(run) || attempt) {
      dismissed = undefined
      if (attempt) attempt.dismissed = false
      screen = 'progress'
    } else if (offer()) {
      refused = null
      screen = 'offer'
    }
    paint()
  }
  const close = () => {
    confirmation = null
    if (screen === 'progress') {
      dismissed = run?.runId
      if (attempt) attempt.dismissed = true
    }
    screen = null
    paint()
  }
  const start = async () => {
    if (disposed || screen !== 'offer' || confirmation) return
    if (!offer()) {
      if (!offline) screen = null
      paint()
      return
    }
    const candidate = candidateOf(status)
    const confirming = {}
    confirmation = confirming
    paint()
    const next = await refresh({ force: true })
    if (disposed || confirmation !== confirming) return
    confirmation = null
    if (next !== status || screen !== 'offer' || !offer() || candidateOf(status) !== candidate) {
      paint()
      return
    }
    refused = null
    const pending = { at: now(), before: run?.runId }
    attempt = pending
    run = null
    screen = 'progress'
    holdChat()
    paint()
    try {
      const reply = await startUpdate()
      if (disposed || attempt !== pending) return
      if (reply?.started === true && typeof reply.requestId === 'string') {
        pending.requestId = reply.requestId
      } else if (reply?.started === false) {
        attempt = null
        refused = reply.reason
        if (!pending.dismissed) screen = 'refused'
        releaseChat()
      } else {
        pending.lost = true
      }
    } catch (error) {
      if (disposed || attempt !== pending) return
      if (error?.code === 'bot/read-only') { clear(); return }
      pending.lost = true
    }
    if (!disposed) {
      paint()
      await refresh({ force: true })
    }
  }

  return {
    refresh, open, close, start, watchConnection,
    onVisibilityChange() {
      if (visible()) void refresh({ force: true })
    },
    dispose() {
      disposed = true
      reading?.abort()
      offConnection?.()
    },
  }
}

const RECOVERY_GUIDE = 'https://github.com/automagik-si/automagik/blob/dev/docs/upgrade.md#in-app-updates-the-supervisor'

function announcement(body, check, rollback, el) {
  body.append(el('p', 'su-line', t('Automagik {version} is ready to install.', { version: check.laneVersion })))
  const current = check.plugins[0]?.from
  const versions = el('div', 'su-versions')
  if (current && check.plugins.every(plugin => plugin.from === current)) {
    versions.append(el('span', null, t('You have')), el('span', 'su-version', current), el('span', null, '→'))
  }
  versions.append(el('span', 'su-version', check.laneVersion))
  body.append(versions, el('h3', null, t('What changes')))
  const changes = el('ul', 'su-changes')
  for (const plugin of check.plugins) {
    changes.append(el('li', null, sameVersion(plugin.from, plugin.to)
      ? t('{plugin} is already on {version}.', { plugin: pluginName(plugin.name), version: plugin.to })
      : changeText(plugin)))
  }
  body.append(changes, el('p', 'su-note', rollback
    ? t('Your previous version stays kept. If the new one does not start, Automagik goes back by itself.')
    : t('Your previous version stays kept.')))
  const caution = el('p', 'su-caution', t('Work in progress stops when you click Update now. Automagik will pick it up again once a healthy version is ready.'))
  caution.setAttribute('role', 'note')
  body.append(caution)
}

function progress(body, run, offline, connectionLost, el) {
  body.classList.add('su-fill')
  // The host can stop between reads of the install and switch phases.
  const confirmedStep = PHASE_STEP[run?.phase]
  const phase = connectionLost && confirmedStep < PHASE_STEP.restarting ? PHASE_STEP.restarting : confirmedStep
  if (run?.phase === 'rollingBack') {
    body.append(el('p', 'su-line', runMessage(run)))
    if (failedHealthCheck(run.rollback?.failed)) body.append(el('p', 'su-note', failedHealthCheck(run.rollback.failed)))
  } else {
    const list = el('div', 'su-steps')
    for (const [i, [key, label]] of STEPS.entries()) {
      const row = el('div', 'su-step')
      row.dataset.step = key
      row.dataset.state = i < phase ? 'done' : i === phase ? 'active' : 'waiting'
      const mark = el('span', 'su-mark', i < phase ? '✓' : i === phase ? '•' : String(i + 1))
      mark.setAttribute('aria-hidden', 'true')
      if (i === phase) row.setAttribute('aria-current', 'step')
      row.append(mark, el('span', null, t(label)))
      list.append(row)
    }
    body.append(list)
    body.append(el('p', 'su-note', !run ? t('Waiting for the update supervisor to confirm the request.')
      : run.phase === 'switching' ? t('Switching versions…')
        : run.phase === 'health' ? t('Checking that it is healthy') : t('The previous version stays kept for the rollback.')))
  }
  if (offline) {
    body.append(el('p', 'su-note', t('The update status is unconfirmed.')), guideLink(el))
  }
}

function guideLink(el) {
  const link = el('a', 'su-note', t('In-app update recovery guide'))
  link.href = RECOVERY_GUIDE
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

const restoreReason = (why) => {
  switch (why) {
    case 'same-format': return t('The previous version can read the team data format.')
    case 'unknown': return t('The team data format could not be determined.')
    case 'team-in-use': return t('The team data was in use.')
    case 'superseded': return t('The team data changed after the restore was planned.')
    case 'snapshot-changed': return t('The saved team snapshot had changed.')
    default: return null
  }
}

const rollbackStep = {
  stop: 'Stop DSH', manifest: 'Restore the plugin entries', rename: 'Put back the kept files',
  current: 'Restore the version record', data: 'Restore team data', verify: 'Verify the profile',
  restart: 'Restart DSH', health: 'Check health',
}
const rollbackAction = {
  'rename-back': 'Put back the kept files', 'data-restore': 'Restore team data',
  restart: 'Restart DSH', health: 'Check health',
}
const fileLocation = { live: 'Live profile', kept: 'Kept version', staging: 'Staging folder', missing: 'Missing' }

function rollbackFacts(card, rollback, el) {
  if (rollback?.data?.restored) {
    card.append(el('p', null, t('The saved team snapshot was restored. Sessions, memory, settings and keys are kept separately.')))
    if (rollback.trialFrom && rollback.trialTo) {
      const time = value => new Date(value).toLocaleString(language())
      card.append(el('p', null, t('If you saved a team change between {start} and {end}, it may have been replaced.', {
        start: time(rollback.trialFrom), end: time(rollback.trialTo),
      })))
    }
    const { trialKept } = rollback.data
    card.append(el('p', null, trialKept === true ? t('A copy of the trial team data was kept.')
      : trialKept === false ? t('No copy of the trial team data was kept.')
        : t('The supervisor did not record whether a copy of the trial team data was kept.')))
  } else if (rollback?.data?.restored === false) {
    card.append(el('p', null, t('The team snapshot was skipped. {reason}', { reason: restoreReason(rollback.data.why) ?? '' })))
  } else {
    card.append(el('p', null, t('The supervisor recorded no team snapshot outcome.')))
  }
}

function recoveryFacts(body, run, recovery, el) {
  const { message, items, truncation } = recoveryDetails(run, recovery)
  if (message) body.append(el('p', 'su-note', message))
  if (!items) return
  const list = el('ul', 'su-changes')
  for (const { text, sessionId } of items) {
    const line = el('li', null, text)
    line.title = sessionId
    list.append(line)
  }
  body.append(el('h3', null, t('Work recovery')))
  if (truncation) body.append(el('p', 'su-note', truncation))
  if (items.length) body.append(list)
}

function verdict(body, run, recovery, el) {
  const card = el('div', 'su-result')
  card.dataset.kind = run.phase === 'healthy' ? 'success' : 'rollback'
  const badge = el('span', 'su-badge', run.phase === 'healthy' ? '✓' : run.phase === 'rolledBack' ? '↩' : '!')
  badge.setAttribute('aria-hidden', 'true')
  card.append(badge)
  const reason = failedHealthCheck(run.rollback?.failed)
  switch (run.phase) {
    case 'healthy':
      card.append(el('h3', null, run.reinstall === true ? t('Done: the same version is installed again.') : t('Done: you are on the new version.')),
        el('p', null, runMessage(run)))
      break
    case 'rolledBack':
      card.append(el('h3', null, t('Back to the previous version')),
        el('p', null, t('The previous plugin set passed its checks.')))
      if (run.to) card.append(el('p', null, t('Update target {version}.', { version: run.to })))
      if (run.from) card.append(el('p', null, t('Oldest plugin version before the update: {version}.', { version: run.from })))
      if (reason) card.append(el('p', null, reason))
      rollbackFacts(card, run.rollback, el)
      break
    case 'notUpdated':
      card.append(el('h3', null, t('Automagik was not updated')), el('p', null, run.detail === 'previous-unsupported'
        ? t('This version of Automagik cannot roll an update back from the app; update it once by hand (docs/upgrade.md).')
        : run.reason === 'not-newer' ? t('The signed release did not offer a newer compatible plugin set.')
          : t('Cannot update: {reason}', { reason: selfUpdateReason(run.reason) })))
      if (run.detail === 'previous-unsupported') card.append(guideLink(el))
      break
    case 'manualRecovery': {
      const rollback = run.rollback
      card.append(el('h3', null, t('Manual recovery required')), el('p', null,
        t('See the recovery guide and the supervisor’s state.json before moving any files.')))
      if (run.from) card.append(el('p', null, t('Previous plugin version recorded for the update: {version}.', { version: run.from })))
      if (run.reason === 'health-failed') {
        card.append(el('p', null, t('The supervisor could not confirm a healthy running instance.')))
      } else if (run.reason) {
        card.append(el('p', null, t('Cannot update: {reason}', { reason: selfUpdateReason(run.reason) })))
      }
      if (reason) card.append(el('p', null, reason))
      if (rollback?.previousFailed) card.append(el('p', null, t('Previous version check: {reason}', { reason: failedHealthCheck(rollback.previousFailed) })))
      if (rollback?.step) card.append(el('p', null, t('Last rollback step: {step}.', { step: t(rollbackStep[rollback.step]) })))
      if (rollback?.tried?.length) card.append(el('p', null, t('Rollback actions tried: {actions}.', {
        actions: rollback.tried.map(action => t(rollbackAction[action])).join(', '),
      })))
      if (rollback?.location) {
        for (const [file, location] of Object.entries({
          'node_modules/': rollback.location.modules, 'pnpm-lock.yaml': rollback.location.lockfile,
        })) {
          card.append(el('p', null, t('{file}: previous — {previous}; candidate — {candidate}.', {
            file, previous: t(fileLocation[location.previous]), candidate: t(fileLocation[location.candidate]),
          })))
        }
      }
      if (rollback) rollbackFacts(card, rollback, el)
      card.append(guideLink(el))
      break
    }
  }
  body.classList.add('su-fill', 'su-center')
  body.append(card)
  if (run.phase !== 'manualRecovery') recoveryFacts(body, run, recovery, el)
}

export function installSelfUpdate({ desktop = false, document: doc = globalThis.document, ...bindings }) {
  if (desktop || !doc?.body) return null
  doc[documentUpdate] ??= createDocumentUpdate(doc, bindings.storage)
  return doc[documentUpdate].attach(bindings)
}

function createDocumentUpdate(doc,
  storage = (() => { try { return globalThis.localStorage } catch { return null } })(),
) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const makeButton = (className, label, click) => {
    const button = el('button', className, label)
    button.type = 'button'
    button.addEventListener('click', click)
    return button
  }
  const svgNs = 'http://www.w3.org/2000/svg'
  const icon = doc.createElementNS(svgNs, 'svg')
  for (const [name, value] of Object.entries({
    viewBox: '0 0 20 20', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) icon.setAttribute(name, value)
  const path = doc.createElementNS(svgNs, 'path')
  path.setAttribute('d', 'M10 3v8.5M6.5 8.5 10 12l3.5-3.5M4 16h12')
  icon.append(path)

  const style = el('style', null, CSS)
  doc.head.append(style)
  const nod = makeButton('su-nod bt-round', undefined, () => controller.open())
  const dot = el('span', 'su-dot')
  dot.setAttribute('aria-hidden', 'true')
  nod.append(icon, dot)
  nod.setAttribute('aria-haspopup', 'dialog')
  const layer = el('div', 'su-layer')
  const box = el('div', 'su-modal')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-labelledby', 'su-title')
  box.tabIndex = -1
  layer.append(box)
  const head = el('div', 'su-head')
  const title = el('h2')
  title.id = 'su-title'
  const close = makeButton('su-close', t('Close'), () => controller.close())
  head.append(title, close)
  const body = el('div', 'su-body')
  body.setAttribute('aria-live', 'polite')
  const foot = el('div', 'su-foot')
  box.append(head, body, foot)

  let nodVisible = false
  let modalVisible = false
  let focusBack = null
  let lastView
  const placeNod = () => {
    if (!nodVisible) { nod.remove(); return }
    const seat = doc.querySelector('.lb-foot')
      ?? doc.querySelector('[class*="_footArea"] [class*="_footerActions"] > div')
    if (!seat) nod.remove()
    else if (nod.parentNode !== seat) seat.append(nod)
  }
  const placeLayer = () => {
    if (modalVisible && doc.body && layer.parentNode !== doc.body) {
      doc.body.append(layer)
      close.focus()
    }
  }
  const Observer = doc.defaultView?.MutationObserver
  const observer = Observer ? new Observer(() => { placeNod(); placeLayer() }) : null
  observer?.observe(doc.documentElement, { childList: true, subtree: true })
  const present = view => {
    const { screen, run, check, recovery, offline, connectionLost, refused, retry, rollback } = view
    const key = JSON.stringify([language(), view])
    if (lastView === key) return
    lastView = key
    if (screen && !modalVisible) focusBack = doc.activeElement
    modalVisible = Boolean(screen)
    nodVisible = !screen && view.nod !== null
    if (nodVisible) {
      const label = view.nod === 'progress' ? t('Updating Automagik') : t('Update available')
      nod.title = label
      nod.setAttribute('aria-label', label)
    }
    placeNod()
    if (!screen) {
      if (layer.parentNode) {
        layer.remove()
        if (focusBack?.isConnected) focusBack.focus()
        else if (nod.isConnected) nod.focus()
      }
      focusBack = null
      return
    }

    const focused = doc.activeElement
    const scroll = body.scrollTop
    title.textContent = screen === 'progress' ? t('Updating Automagik') : t('Update Automagik')
    close.textContent = t('Close')
    body.className = 'su-body'
    body.replaceChildren()
    foot.replaceChildren()
    if (screen === 'offer') {
      announcement(body, check, rollback, el)
      if (offline) body.append(el('p', 'su-note', t('The update status is unconfirmed.')))
      const update = makeButton('su-primary', t('Update now'), () => void controller.start())
      update.disabled = !retry
      foot.append(update, makeButton('su-ghost', t('Not now'), () => controller.close()))
    } else if (screen === 'progress') {
      progress(body, run, offline, connectionLost, el)
    } else if (screen === 'result') {
      verdict(body, run, recovery, el)
      if (run.phase === 'rolledBack' && retry) {
        foot.append(makeButton('su-ghost', t('See the announcement again'), () => controller.open()))
      }
    } else {
      body.append(el('p', 'su-line', refused === 'unconfirmed'
        ? t('The supervisor has not confirmed the update request.')
        : t('Cannot update: {reason}', { reason: selfUpdateReason(refused) })))
    }
    placeLayer()
    body.scrollTop = scroll
    if (focused && !focused.isConnected) close.focus()
  }

  let owner
  let readStatus
  let deferredChat
  let tracking = false
  let retryTimer
  const pollDetached = () => {
    if (owner || !tracking) return
    void controller.refresh()
    retryTimer = setTimeout(pollDetached, doc.hidden ? 10_000 : 1500)
  }
  const controller = createSelfUpdateController({
    readStatus: signal => readStatus(signal),
    startUpdate: () => owner.startUpdate(),
    onStatus: status => owner?.onStatus?.(status),
    keepChat(...args) {
      if (owner) owner.keepChat?.(...args)
      else deferredChat = args
    },
    present(view) {
      tracking = view.nod === 'progress'
      present(view)
      if (!owner && !tracking && !view.screen) dispose()
    },
    storage, visible: () => doc.visibilityState === 'visible',
  })
  doc.addEventListener('visibilitychange', controller.onVisibilityChange)

  const onKeyDown = event => {
    if (!layer.isConnected) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      controller.close()
    } else if (event.key === 'Tab') {
      const stops = [...box.querySelectorAll('button:not(:disabled),a[href]')]
      const at = stops.indexOf(doc.activeElement)
      event.preventDefault()
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length
      stops[next]?.focus()
    }
  }
  doc.addEventListener('keydown', onKeyDown, true)
  function dispose() {
    delete doc[documentUpdate]
    clearTimeout(retryTimer)
    controller.dispose()
    observer?.disconnect()
    doc.removeEventListener('visibilitychange', controller.onVisibilityChange)
    doc.removeEventListener('keydown', onKeyDown, true)
    nod.remove()
    layer.remove()
    style.remove()
    if (focusBack?.isConnected) focusBack.focus()
  }
  return {
    attach(bindings) {
      owner = bindings
      readStatus = bindings.readStatus
      clearTimeout(retryTimer)
      if (deferredChat) {
        bindings.keepChat?.(...deferredChat)
        deferredChat = undefined
      }
      controller.watchConnection(bindings.connection)
      return {
        refresh: options => owner === bindings ? controller.refresh(options) : undefined,
        dispose() {
          if (owner !== bindings) return
          owner = undefined
          if (!tracking) { dispose(); return }
          // A client-generation change can tear down Bots while DSH is still restarting.
          // Keep the document's layer and use ordinary status reads until Bots reattaches.
          controller.watchConnection(undefined, true)
          retryTimer = setTimeout(pollDetached, 1500)
        },
      }
    },
  }
}
