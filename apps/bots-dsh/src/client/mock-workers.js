// Native subagents as workers, the clickable mock for issue 1564, step 1. It is the only
// code in that step: no host half, no ACP change and no feature behind it. It mounts only
// when the page is opened with `?mock-workers` (or `#mock-workers`), and every value it
// draws is sample data, said so in words on the surface.
//
// What it shows is the view the owner asked for: under a Bot's row, the native Claude Code
// subagents it started as worker threads, the way task sessions already hang under a Bot
// (sidebar.js BotThreads): a spinner while one runs, its title and age, and a line saying
// how it ended. Clicking a worker opens its own steps, its result and its status in a
// popover built from the Bot team's row and popover pieces. Nothing here starts, stops or
// reports a real subagent.
import { t } from './i18n.js'

/** The flag: `?mock-workers` or `#mock-workers` in the page's URL. */
export const MOCK_FLAG = 'mock-workers'
const PARAM_FLAG = 'mock-workers'
const ROOT_ID = 'ds-bot-mock-workers'

// Additions only: the row, thread and popover rules the Bot team already ships stay the
// look. Every colour comes from a --bt-* token, and only layout and the two ended states
// (done, failed) are named here, the running one reusing the sidebar's own spinner.
const CSS = `
.bt-mock-workers{left:16px;top:auto;right:auto;bottom:16px;width:308px;max-height:calc(100vh - 32px);overflow:auto;z-index:75}
.bt-mock-workers .bt-mock-head{display:flex;align-items:center;gap:8px;padding:4px 6px 2px}
.bt-mock-workers .bt-mock-head .bt-menu-label{font-weight:600}
.bt-mock-badge{flex:none;align-self:center;padding:1px 7px;border-radius:999px;background:var(--bt-accent-soft);color:var(--bt-accent);font-size:10px;line-height:16px;font-weight:700;letter-spacing:.04em}
.bt-mock-avatar{flex:none;width:36px;height:36px;border-radius:50%;background:var(--bt-tag-bg);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;font:600 14px/1 var(--bt-font)}
.bt-mock-workers .bt-threads{margin-top:2px}
.bt-mock-worker{display:flex;flex-direction:column}
.bt-mock-worker>.bt-row-preview{margin:0 8px 4px 28px;font-size:12px}
.bt-mock-workers .bt-thread-mark{flex:none;width:10px;height:10px;border-radius:50%;background:var(--bt-ink-3);box-sizing:border-box}
.bt-mock-workers .bt-thread[data-state=done] .bt-thread-mark{background:var(--bt-green)}
.bt-mock-workers .bt-thread[data-state=failed] .bt-thread-mark{background:var(--bt-danger)}
.bt-mock-steps{display:flex;flex-direction:column;gap:2px}
.bt-mock-step{display:flex;align-items:flex-start;gap:8px;padding:5px 8px;border-radius:8px;color:var(--bt-ink)}
.bt-mock-step[data-state=running]{background:var(--bt-accent-soft)}
.bt-mock-step .bt-menu-label{font-size:12.5px;white-space:normal;overflow:visible;line-height:16px}
.bt-mock-step .bt-menu-hint{font-size:11px;flex:none;margin-left:auto}
.bt-mock-pop-head{display:flex;align-items:center;gap:8px;padding:2px 8px 4px;min-width:0}
.bt-mock-pop-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink);font-weight:600;font-size:13px;line-height:18px}
.bt-mock-step-mark{flex:none;width:8px;height:8px;margin-top:4px;border-radius:50%;background:var(--bt-ink-3)}
.bt-mock-step[data-state=done] .bt-mock-step-mark{background:var(--bt-green)}
.bt-mock-step[data-state=failed] .bt-mock-step-mark{background:var(--bt-danger)}
.bt-mock-step[data-state=running] .bt-mock-step-mark{background:var(--bt-accent)}
`

// The sample workers: one running, one done, one failed, so the three states the owner
// asked for are all on screen. Their titles, steps and result lines are invented.
export const MOCK_WORKERS = Object.freeze([
  Object.freeze({
    id: 'adapter',
    state: 'running',
    age: () => t('now'),
    title: () => t('Review the adapter bundle'),
    line: () => t('Reading the adapter bundle…'),
    steps: Object.freeze([
      Object.freeze({ tool: 'Grep', state: 'done', title: () => t('find the adapter version') }),
      Object.freeze({ tool: 'Read', state: 'running', title: () => t('read the session update path') }),
      Object.freeze({ tool: 'Grep', state: 'pending', title: () => t('search for parentToolUseId') }),
    ]),
  }),
  Object.freeze({
    id: 'memory',
    state: 'done',
    age: () => t('{n}m', { n: 4 }),
    title: () => t('Audit memory writes'),
    line: () => t('2 files changed · 4 notes kept'),
    steps: Object.freeze([
      Object.freeze({ tool: 'Read', state: 'done', title: () => t('read the memory doors') }),
      Object.freeze({ tool: 'Grep', state: 'done', title: () => t('compare both memory stores') }),
      Object.freeze({ tool: 'Edit', state: 'done', title: () => t('keep the app memory as the source') }),
    ]),
  }),
  Object.freeze({
    id: 'approval',
    state: 'failed',
    age: () => t('{n}m', { n: 9 }),
    title: () => t('Check the approval path'),
    line: () => t('Bash exited 1 · approval path missing'),
    steps: Object.freeze([
      Object.freeze({ tool: 'Read', state: 'done', title: () => t('list the approval levels') }),
      Object.freeze({ tool: 'Bash', state: 'failed', title: () => t('run the permission probe') }),
    ]),
  }),
])

const stateLabel = (state) => state === 'done' ? t('Done')
  : state === 'failed' ? t('Failed')
    : state === 'pending' ? t('Not started')
      : t('Running')

function installStyle(text, doc) {
  const style = doc.createElement('style')
  style.dataset.dshBotMock = 'workers'
  style.textContent = text
  doc.head.append(style)
  return () => style.remove()
}

function el(doc, tag, props, ...children) {
  const node = doc.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'style' && typeof value === 'object') for (const [name, setting] of Object.entries(value)) node.style.setProperty(name, setting)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) if (child !== undefined && child !== null) node.append(child)
  return node
}

function workerRow(doc, worker, { onOpen }) {
  const state = worker.state
  const label = [worker.title(), stateLabel(state), worker.line()].filter(Boolean).join(', ')
  const mark = state === 'running'
    ? el(doc, 'span', { class: 'bt-thread-spin', 'aria-hidden': 'true' })
    : el(doc, 'span', { class: 'bt-thread-mark', 'aria-hidden': 'true' })
  const button = el(doc, 'button', {
    type: 'button', class: 'bt-thread', dataset: { state, worker: worker.id }, 'aria-label': label, title: worker.title(),
  },
  mark,
  el(doc, 'span', { class: 'bt-thread-title' }, worker.title()),
  el(doc, 'span', { class: 'bt-thread-age', 'aria-hidden': 'true' }, worker.age()))
  button.addEventListener('click', () => onOpen(worker, button))
  return el(doc, 'div', { class: 'bt-mock-worker', dataset: { state } },
    button,
    el(doc, 'span', { class: 'bt-row-preview' }, worker.line()))
}

function stepsList(doc, worker) {
  return el(doc, 'div', { class: 'bt-mock-steps', role: 'list', 'aria-label': t('Steps') },
    ...worker.steps.map(step => el(doc, 'div', { class: 'bt-mock-step', dataset: { state: step.state }, role: 'listitem' },
      el(doc, 'span', { class: 'bt-mock-step-mark', 'aria-hidden': 'true' }),
      el(doc, 'span', { class: 'bt-menu-label' }, step.title()),
      el(doc, 'span', { class: 'bt-menu-hint' }, `${step.tool} · ${stateLabel(step.state)}`))))
}

function popover(doc, worker, anchor, onClose) {
  // Beside the worker it belongs to; a preview with no laid-out rect keeps a fixed place.
  const rect = typeof anchor?.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : undefined
  const viewport = doc.defaultView?.innerHeight ?? 800
  const left = rect !== undefined && rect.width > 0 ? Math.round(rect.right + 12) : 340
  const top = Math.max(16, Math.min(rect !== undefined && rect.height > 0 ? Math.round(rect.top) : 96, viewport - 360))
  const steps = stepsList(doc, worker)
  const status = el(doc, 'span', { class: 'bt-mock-badge', dataset: { state: worker.state } }, stateLabel(worker.state))
  const close = el(doc, 'button', { type: 'button', 'aria-label': t('Close') }, t('Close'))
  close.addEventListener('click', onClose)
  return el(doc, 'div', {
    class: 'bt-menu bt-mock-popover', role: 'dialog', 'aria-label': t('Worker details'),
    style: { left: `${left}px`, top: `${top}px`, bottom: 'auto', right: 'auto', width: '288px', 'max-height': 'calc(100vh - 32px)', overflow: 'auto', 'z-index': 76 },
  },
  el(doc, 'div', { class: 'bt-mock-pop-head' }, el(doc, 'span', { class: 'bt-mock-pop-title' }, worker.title()), status, el(doc, 'span', { class: 'bt-menu-hint' }, worker.age())),
  el(doc, 'div', { class: 'bt-menu-note' }, t('Sample data: nothing here is real.')),
  el(doc, 'div', { class: 'bt-menu-sep' }),
  el(doc, 'div', { class: 'bt-menu-note' }, t('Result'), ': ', worker.line() || stateLabel(worker.state)),
  el(doc, 'div', { class: 'bt-menu-sep' }),
  el(doc, 'div', { class: 'bt-menu-note' }, t('Steps')),
  steps,
  el(doc, 'div', { class: 'bt-menu-sep' }),
  close)
}

/**
 * Mount the preview into `root` and return its controls. The root is filled with the
 * sidebar's own row, threads and popover classes, so the preview keeps the Bot team's look.
 */
export function mountWorkersMock(root, { doc = globalThis.document } = {}) {
  const panel = el(doc, 'div', {
    class: 'bt-menu bt-mock-workers', role: 'region', 'aria-label': t('Native subagents'),
  })
  const closePreview = el(doc, 'button', { type: 'button', 'aria-label': t('Close preview') }, t('Close preview'))
  closePreview.addEventListener('click', () => { panel.hidden = true })
  const head = el(doc, 'div', { class: 'bt-mock-head' },
    el(doc, 'span', { class: 'bt-menu-label' }, t('Native subagents')),
    el(doc, 'span', { class: 'bt-mock-badge' }, t('SAMPLE DATA')))
  const closeRow = el(doc, 'div', null, closePreview)
  const note = el(doc, 'div', { class: 'bt-menu-note' }, t('Sample data: nothing here is real.'))
  const bot = el(doc, 'div', { class: 'bt-row', dataset: { bot: 'sample' } },
    el(doc, 'span', { class: 'bt-mock-avatar', 'aria-hidden': 'true' }, 'C'),
    el(doc, 'span', { class: 'bt-row-body' },
      el(doc, 'span', { class: 'bt-row-name' }, el(doc, 'span', { class: 'bt-row-title' }, 'Claude Code')),
      el(doc, 'span', { class: 'bt-row-preview' }, t('Working on {n} things', { n: MOCK_WORKERS.length }))))
  let open = null
  const close = () => {
    if (open !== null) {
      open.remove()
      open = null
    }
  }
  const onOpen = (worker, anchor) => {
    close()
    open = popover(doc, worker, anchor, close)
    panel.after(open)
  }
  const threads = el(doc, 'div', { class: 'bt-threads', role: 'group', 'aria-label': t('Native subagents') },
    ...MOCK_WORKERS.map(worker => workerRow(doc, worker, { onOpen })))
  panel.append(head, note, el(doc, 'div', { class: 'bt-menu-sep' }), bot, threads, closeRow)
  root.append(panel)
  return {
    panel,
    screen: () => (open === null ? 'workers' : 'worker'),
    open: (id) => {
      const worker = MOCK_WORKERS.find(entry => entry.id === id)
      if (worker !== undefined) onOpen(worker, panel.querySelector(`[data-worker="${id}"]`))
    },
    close,
    dispose: () => {
      close()
      panel.remove()
    },
  }
}

/** Install the preview only when the URL carries the flag; returns its disposer. */
export function installWorkersMock({ location = globalThis.location, document: doc = globalThis.document } = {}) {
  if (!doc || !location) return () => {}
  const search = typeof location.search === 'string' ? location.search : ''
  const hash = typeof location.hash === 'string' ? location.hash : ''
  if (!new RegExp(`(?:[?&])${PARAM_FLAG}(?:=|&|$)`).test(search) && !hash.includes(MOCK_FLAG)) return () => {}
  const offStyles = installStyle(CSS, doc)
  const root = doc.createElement('div')
  root.id = ROOT_ID
  doc.body.append(root)
  const control = mountWorkersMock(root, { doc })
  return () => {
    control.dispose()
    offStyles()
    root.remove()
  }
}
