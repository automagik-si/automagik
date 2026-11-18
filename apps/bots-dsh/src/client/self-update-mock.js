// The web self-update preview (issue 1540, step 1): the clickable mock the owner reviews before any
// updater exists. Nothing here downloads, verifies, installs, restarts or checks a release: every
// number on screen is sample data, the flow is timers, and the whole surface only appears when the
// page is opened with `?mock-1540` (or `#mock-1540`), so a normal app start is untouched.
//
// The shape it mocks is issue issue 1540's approved one: a nod at the bottom of the left menu when a
// newer version exists, a full-screen modal that says what changes in plain words, the steps live
// (download, check the signature, install beside the current version, restart, health check), a
// success screen, and a rollback screen that says the previous version came back and nothing was
// lost. Arca supplies the kept version and the health answer in the real thing; here the toast
// says so in one line.
import { t } from './i18n.js'

/** The flag: `?mock-1540` or `#mock-1540` in the page's URL. */
export const MOCK_FLAG = 'mock-1540'
const PARAM_FLAG = 'mock-1540'

/** The five steps, in order, as the real flow names them. */
export const MOCK_STEPS = Object.freeze([
  { key: 'download', label: () => t('Downloading the new version') },
  { key: 'signature', label: () => t('Checking the signature') },
  { key: 'install', label: () => t('Installing beside the current version') },
  { key: 'restart', label: () => t('Restarting') },
  { key: 'health', label: () => t('Checking that it is healthy') },
])

/** Everything on screen is sample data; the two versions are invented on purpose. */
export const MOCK_DATA = Object.freeze({
  current: '3.151.0',
  next: '3.152.0',
  downloadMb: 42,
  seconds: 3,
})

/** How long each step takes in the preview. */
const STEP_MS = 900
const SUCCESS_MS = 700

const CSS = `
/* The nod is one of the bar's own round buttons (.bt-round), seated in the bottom row like the
   other footer entries, never a floating pill of its own: same 36px circle, same --bt-* colours. */
.su-nod{position:relative}
.su-nod .su-dot{position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--bt-accent);box-shadow:0 0 0 2px var(--bt-main)}
.su-nod .su-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.su-layer{position:fixed;inset:0;z-index:80;display:flex;background:var(--bt-main);animation:su-veil .18s ease-out;font-family:var(--bt-font,system-ui)}
.su-modal{width:100%;height:100%;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);animation:su-pop .22s cubic-bezier(.34,1.3,.64,1)}
.su-head{display:flex;align-items:flex-start;gap:12px;padding:20px max(24px,calc((100vw - 760px)/2)) 0}
.su-head h2{margin:0;font-size:17px;line-height:24px;font-weight:600}
.su-close{margin-left:auto;border:0;background:transparent;color:var(--bt-ink-2);font:500 13px/18px var(--bt-font,system-ui);cursor:pointer;padding:2px 4px;border-radius:8px}
.su-close:hover{background:var(--bt-hover);color:var(--bt-ink)}
.su-body{flex:1;overflow:auto;padding:18px max(24px,calc((100vw - 760px)/2)) 24px;display:flex;flex-direction:column;gap:14px}
.su-body.su-fill{justify-content:center}
.su-body.su-center{align-items:center;text-align:center}
.su-body.su-center .su-example{align-self:center}
.su-example{align-self:flex-start;padding:2px 8px;border-radius:999px;background:var(--bt-accent-soft);color:var(--bt-accent);font:600 11px/16px var(--bt-font,system-ui);letter-spacing:.02em;text-transform:uppercase}
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
.su-step[data-state=failed] .su-mark{border-color:transparent;background:var(--bt-danger);color:var(--bt-accent-ink)}
.su-step[data-state=failed]{color:var(--bt-ink)}
.su-note{margin:0;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.su-caution{margin:0;padding:9px 11px;border-radius:10px;background:var(--bt-accent-soft);color:var(--bt-ink);font:500 13px/20px var(--bt-font,system-ui)}
.su-foot{display:flex;gap:10px;align-items:center;padding:14px max(24px,calc((100vw - 760px)/2)) 18px;border-top:.5px solid var(--bt-line);background:var(--bt-main)}
.su-primary{border:0;border-radius:10px;padding:10px 16px;background:var(--bt-accent);color:var(--bt-accent-ink);font:600 14px/18px var(--bt-font,system-ui);cursor:pointer}
.su-primary:hover{filter:brightness(1.05)}
.su-ghost{border:.5px solid var(--bt-line-2);border-radius:10px;padding:9px 14px;background:transparent;color:var(--bt-ink);font:500 14px/18px var(--bt-font,system-ui);cursor:pointer}
.su-ghost:hover{background:var(--bt-hover)}
.su-link{margin-left:auto;border:0;background:transparent;color:var(--bt-ink-2);font:500 12px/18px var(--bt-font,system-ui);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.su-result{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8vh 0 4px;text-align:center}
.su-result .su-badge{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--bt-accent-ink);background:var(--bt-accent)}
.su-result[data-kind=rollback] .su-badge{background:var(--bt-danger)}
.su-result h3{margin:0;font-size:16px;line-height:22px;font-weight:600}
.su-result p{margin:0;max-width:52ch;font-size:13px;line-height:20px;color:var(--bt-ink-2)}
@keyframes su-nod-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes su-pulse{0%{transform:scale(.9);opacity:.5}70%{transform:scale(1.5);opacity:0}100%{opacity:0}}
@keyframes su-veil{from{opacity:0}to{opacity:1}}
@keyframes su-pop{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.su-nod,.su-modal,.su-layer,.su-dot::after{animation:none}}
`

// The preview's own stylesheet: a style element that leaves with it, so the module needs nothing
// from the rest of the client and can be mounted in a test or a stand-alone harness.
function installStyle(css, doc) {
  const style = doc.createElement('style')
  style.dataset.mock = MOCK_FLAG
  style.textContent = css
  doc.head.append(style)
  return () => style.remove()
}

// The bar's own drawing conventions: a plain stroked glyph in currentColor, 18px.
const arrowSvg = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M10 3v8.5M6.5 8.5 10 12l3.5-3.5M4 16h12')
  svg.append(path)
  return svg
}

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.append(document.createTextNode(text))
  return node
}

/** Stage one: the nod at the bottom of the left menu. */
function renderNod(root, onOpen) {
  root.replaceChildren()
  const button = el('button', 'su-nod')
  button.type = 'button'
  button.dataset.mock = MOCK_FLAG
  button.append(el('span', 'su-dot', '↑'), el('span', null, t('Update available')))
  button.append(el('span', 'su-sr', t('Example data: nothing is downloaded in this preview.')))
  button.addEventListener('click', onOpen)
  root.append(button)
  return button
}

const EXAMPLE = () => el('span', 'su-example', t('Example data'))

function modal() {
  const layer = el('div', 'su-layer')
  const box = el('div', 'su-modal')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', t('Update Automagik'))
  layer.append(box)
  return { layer, box }
}

function head(box, title, onClose) {
  const row = el('div', 'su-head')
  row.append(el('h2', null, title))
  const close = el('button', 'su-close', t('Close'))
  close.type = 'button'
  close.addEventListener('click', onClose)
  row.append(close)
  box.append(row)
}

/**
 * The whole preview, mounted into `root`. `open()` shows the modal at its first screen, as a click
 * on the nod does; every screen returns to the nod when closed. All timers are cleared on dispose,
 * so a test never has to wait for the flow.
 */
export function mountSelfUpdateMock(root, { sample = MOCK_DATA, stepMs = STEP_MS, successMs = SUCCESS_MS, seat = null, doc = document } = {}) {
  let timers = []
  const stop = () => { for (const id of timers) clearTimeout(id); timers = [] }
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)) }
  const place = (node) => { root.replaceChildren(node) }

  const nod = () => {
    stop()
    const button = el('button', 'su-nod bt-round')
    button.type = 'button'
    button.dataset.mock = MOCK_FLAG
    button.title = t('Update available')
    button.setAttribute('aria-label', t('Update available'))
    button.append(arrowSvg(), el('span', 'su-dot'), el('span', 'su-label', t('Update available')))
    button.addEventListener('click', () => open())
    if (seat) {
      // The bottom row owns this seat: the same line as the app's other footer entries.
      seat.replaceChildren(button)
    } else {
      place(button)
    }
  }

  const open = () => changes()

  const changes = () => {
    stop()
    const { layer, box } = modal()
    head(box, t('Update Automagik'), nod)
    const body = el('div', 'su-body')
    body.append(EXAMPLE())
    body.append(el('p', 'su-line', t('A new version is ready. From now on it updates itself from this menu.')))
    const versions = el('div', 'su-versions')
    versions.append(el('span', null, t('You have')), el('span', 'su-version', sample.current),
      el('span', null, '\u2192'), el('span', 'su-version', sample.next))
    body.append(versions)
    body.append(el('h3', null, t('What changes')))
    const list = el('ul', 'su-changes')
    for (const line of [
      t('Signing in to a coding agent is one click, and a failure says why.'),
      t('A Bot that moves to a new part of its chat keeps what it was doing.'),
      t('This menu gets the update button, so you stop updating by hand.'),
    ]) list.append(el('li', null, line))
    body.append(list)
    body.append(el('p', 'su-note', t('Your previous version stays kept. If the new one does not start, Automagik goes back by itself.')))
    // The owner decided (RFC 0035, Q6): the click is the permission, and running work stops.
    const caution = el('p', 'su-caution', t('Work in progress stops when you click Update now, and it comes back by itself once the update is done. Nothing is lost.'))
    caution.setAttribute('role', 'note')
    body.append(caution)
    box.append(body)
    const foot = el('div', 'su-foot')
    const primary = el('button', 'su-primary', t('Update now'))
    primary.type = 'button'
    primary.addEventListener('click', () => steps())
    const ghost = el('button', 'su-ghost', t('Not now'))
    ghost.type = 'button'
    ghost.addEventListener('click', nod)
    const failure = el('button', 'su-link', t('Show the failure instead'))
    failure.type = 'button'
    failure.addEventListener('click', () => steps({ failAtHealth: true }))
    foot.append(primary, ghost, failure)
    box.append(foot)
    place(layer)
  }

  const steps = ({ failAtHealth = false } = {}) => {
    stop()
    const { layer, box } = modal()
    head(box, t('Updating Automagik'), nod)
    const body = el('div', 'su-body')
    body.append(EXAMPLE())
    const list = el('div', 'su-steps')
    const rows = MOCK_STEPS.map((step, index) => {
      const row = el('div', 'su-step')
      row.dataset.step = step.key
      row.dataset.state = 'waiting'
      row.append(el('span', 'su-mark', String(index + 1)), el('span', null, step.label()))
      list.append(row)
      return row
    })
    body.append(list)
    body.append(el('p', 'su-note', t('In this preview the steps are timers and nothing is downloaded.')))
    body.classList.add('su-fill')
    box.append(body)
    const foot = el('div', 'su-foot')
    foot.append(el('span', 'su-note', t('The previous version stays kept for the rollback.')))
    box.append(foot)
    place(layer)

    const mark = (row, state, glyph) => {
      row.dataset.state = state
      row.querySelector('.su-mark').textContent = glyph
    }
    let index = 0
    const advance = () => {
      if (index >= rows.length) { later(success, successMs); return }
      const row = rows[index]
      const key = MOCK_STEPS[index].key
      mark(row, 'active', '\u2022')
      index += 1
      later(() => {
        if (failAtHealth && key === 'health') {
          mark(row, 'failed', '!')
          body.append(el('p', 'su-note', t('The new version did not answer the health check.')))
          later(rollback, successMs)
          return
        }
        mark(row, 'done', '\u2713')
        advance()
      }, stepMs)
    }
    advance()
  }

  const result = (kind, badge, title, text, extra = []) => {
    const { layer, box } = modal()
    head(box, t('Update Automagik'), nod)
    const body = el('div', 'su-body')
    const card = el('div', 'su-result')
    card.dataset.kind = kind
    card.append(el('span', 'su-badge', badge))
    card.append(el('h3', null, title))
    card.append(el('p', null, text))
    body.append(card, EXAMPLE())
    body.classList.add('su-fill', 'su-center')
    for (const node of extra) body.append(node)
    box.append(body)
    return { layer, box, body }
  }

  const success = () => {
    stop()
    const { layer, box } = result('success', '\u2713',
      t('Done: you are on the new version.'),
      t('Keep working. Your chats, Bots and files are where they were.'),
      [el('p', 'su-note', t('In the real thing the instance restarts here, and the chat you had open comes back where it was.'))])
    const foot = el('div', 'su-foot')
    const primary = el('button', 'su-primary', t('Close'))
    primary.type = 'button'
    primary.addEventListener('click', nod)
    foot.append(primary)
    box.append(foot)
    place(layer)
  }

  const rollback = () => {
    stop()
    const versions = el('div', 'su-versions')
    versions.append(el('span', null, t('You are on')), el('span', 'su-version', sample.current))
    const { layer, box } = result('rollback', '\u21a9',
      t('Back to the previous version'),
      t('The new version did not start well. Automagik went back to the one that worked. Nothing was lost: your chats, Bots and files are where they were.'),
      [versions])
    const foot = el('div', 'su-foot')
    const primary = el('button', 'su-primary', t('Close'))
    primary.type = 'button'
    primary.addEventListener('click', nod)
    const retry = el('button', 'su-ghost', t('See the announcement again'))
    retry.type = 'button'
    retry.addEventListener('click', changes)
    foot.append(primary, retry)
    box.append(foot)
    place(layer)
  }

  nod()
  return {
    open,
    close: nod,
    /** The screen the preview is on: nod, changes, steps, success or rollback. */
    screen: () => {
      if (root.querySelector('.su-layer') === null) return 'nod'
      if (root.querySelector('.su-result[data-kind=success]') !== null) return 'success'
      if (root.querySelector('.su-result[data-kind=rollback]') !== null) return 'rollback'
      if (root.querySelector('.su-steps') !== null) return 'steps'
      return 'changes'
    },
    dispose: () => { stop(); root.remove() },
  }
}

/**
 * Install the preview on a running page. Only `?mock-1540` (or `#mock-1540`) mounts it, so a normal
 * start of the app is what it was; the disposer removes the nod and the styles.
 */
export function installSelfUpdateMock({ location = globalThis.location, document: doc = globalThis.document } = {}) {
  if (!doc || !location) return () => {}
  const search = typeof location.search === 'string' ? location.search : ''
  const hash = typeof location.hash === 'string' ? location.hash : ''
  if (!new RegExp(`(?:[?&])${PARAM_FLAG}(?:=|&|$)`).test(search) && !hash.includes(MOCK_FLAG)) return () => {}
  const offStyles = installStyle(CSS, doc)
  const root = doc.createElement('div')
  root.id = 'ds-bot-self-update-mock'
  doc.body.append(root)
  // The app's bottom row is DSH's own footer area; inside it the nod sits in the same line as
  // the footer's other entries. A harness can offer its own seat with `data-mock-seat`.
  const seat = doc.querySelector('.lb-foot')
    ?? doc.querySelector('[class*="_footArea"] [class*="_footerActions"] > div')
    ?? doc.querySelector('[data-mock-seat]')
  const control = mountSelfUpdateMock(root, { doc, seat })
  return () => {
    control.dispose()
    offStyles()
  }
}
