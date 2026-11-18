// Claude Code's native subagents as workers under a Bot's row (issue 1564). acp-dsh keeps the
// link each subagent call carries on the ACP wire and groups the calls under their Agent/Task
// call; the host hands them out per Bot as the live answer's `work.native` (native-workers.js
// on the host). They hang under the row the way the tasks a Bot started do (sidebar.js
// BotThreads): a spinner while one runs, a green or red mark once it ended, its title and age,
// and the line its result opens with. A worker opens a popover with its status, result and steps.
// Nothing here starts, stops or answers a worker.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.js'

/** Past this many, a Bot's workers fold into a count (as BotThreads). */
export const WORKERS_SHOWN = 3

// Additions only: the row, thread and popover rules of the sidebar stay the look, every colour
// a --bt-* token; only the two ended marks, the result line and the steps list are new.
export const NATIVE_WORKERS_CSS = `
.bt-worker{display:flex;flex-direction:column}
.bt-worker>.bt-worker-line{margin:0 8px 2px 28px;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-thread-mark{flex:none;width:10px;height:10px;margin:0 1px;border-radius:50%;corner-shape:round;background:var(--bt-ink-3);box-sizing:border-box}
.bt-thread[data-state=done] .bt-thread-mark{background:var(--bt-green)}
.bt-thread[data-state=failed] .bt-thread-mark{background:var(--bt-danger)}
.bt-worker-pop{width:288px;max-height:calc(100vh - 32px);overflow:auto;z-index:76}
.bt-worker-head{display:flex;align-items:center;gap:8px;padding:2px 8px 4px;min-width:0}
.bt-worker-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink);font-weight:600;font-size:13px;line-height:18px}
.bt-worker-badge{flex:none;padding:1px 7px;border-radius:999px;background:var(--bt-accent-soft);color:var(--bt-accent);font-size:10px;line-height:16px;font-weight:700;letter-spacing:.04em}
.bt-worker-badge[data-state=done]{background:color-mix(in srgb,var(--bt-green) 14%,transparent);color:var(--bt-green)}
.bt-worker-badge[data-state=failed]{background:var(--bt-danger-soft);color:var(--st-bad-strong,var(--bt-danger))}
.bt-worker-steps{display:flex;flex-direction:column;gap:2px}
.bt-worker-step{display:flex;align-items:flex-start;gap:8px;padding:5px 8px;border-radius:8px;color:var(--bt-ink)}
.bt-worker-step[data-state=running]{background:var(--bt-accent-soft)}
.bt-worker-step .bt-menu-label{font-size:12.5px;white-space:normal;overflow:visible;line-height:16px;overflow-wrap:anywhere}
.bt-worker-step .bt-menu-hint{font-size:11px;margin-left:auto}
.bt-worker-step-mark{flex:none;width:8px;height:8px;margin-top:4px;border-radius:50%;background:var(--bt-ink-3)}
.bt-worker-step[data-state=done] .bt-worker-step-mark{background:var(--bt-green)}
.bt-worker-step[data-state=failed] .bt-worker-step-mark{background:var(--bt-danger)}
.bt-worker-step[data-state=running] .bt-worker-step-mark{background:var(--bt-accent)}
`

const stateLabel = state => (state === 'done' ? t('Done') : state === 'failed' ? t('Failed') : t('Running'))
// How an ended worker ended: Stopped when DSH closed it with its turn (acp-dsh `stopped`), else
// the line its result opens with, else its state.
const endedLine = worker => (worker.stopped === true ? t('Stopped') : worker.result || stateLabel(worker.state))

/** The Bot's native workers from the live answer (`work.native`), as one stable text. */
export const workersKey = (work, botId) => JSON.stringify(work?.native?.[botId] ?? [])

/** How many of a Bot's native workers still run, for its row's line. */
export const runningWorkers = (work, botId) => (work?.native?.[botId] ?? []).filter(worker => worker?.state === 'running').length

// The line under a worker: what it is doing while it runs, how it ended once it did.
export function workerLine(worker) {
  if (worker.state === 'running') {
    const step = [...(worker.steps ?? [])].reverse().find(entry => entry.state === 'running') ?? worker.steps?.at(-1)
    return step ? t('{step}…', { step: step.title }) : t('Starting…')
  }
  return endedLine(worker)
}

// Running ones first, then the newest; past WORKERS_SHOWN the rest fold into a count.
const ordered = workers => workers.map((worker, index) => ({ worker, index }))
  .sort((a, b) => Number(b.worker.state === 'running') - Number(a.worker.state === 'running') || b.index - a.index)
  .map(entry => entry.worker)

function WorkerPopover({ worker, anchor, age, onClose }) {
  const pop = useRef(null)
  const [place, setPlace] = useState(() => ({ left: 340, top: 96 }))
  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect?.()
    const height = pop.current?.getBoundingClientRect?.().height ?? 0
    const viewport = globalThis.innerHeight ?? 800
    if (rect && rect.width > 0) setPlace({ left: Math.round(rect.right + 12), top: Math.max(16, Math.min(Math.round(rect.top), viewport - Math.max(height, 120) - 16)) })
  }, [anchor, worker.steps?.length])
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    const onDown = (event) => {
      if (pop.current?.contains(event.target) || anchor?.contains?.(event.target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [anchor, onClose])
  const steps = worker.steps ?? []
  return createPortal(h('div', { ref: pop, className: 'bt-menu bt-worker-pop', role: 'dialog', 'aria-label': t('Worker details'), style: { left: place.left, top: place.top } },
    h('div', { className: 'bt-worker-head' },
      h('span', { className: 'bt-worker-title', title: worker.title }, worker.title),
      h('span', { className: 'bt-worker-badge', 'data-state': worker.state }, stateLabel(worker.state)),
      age ? h('span', { className: 'bt-menu-hint' }, age) : null),
    h('div', { className: 'bt-menu-sep' }),
    h('div', { className: 'bt-menu-note' }, t('Result: {line}', { line: worker.state === 'running' ? t('still running') : endedLine(worker) })),
    h('div', { className: 'bt-menu-sep' }),
    h('div', { className: 'bt-menu-note' }, worker.more > 0 ? t('Steps (latest {n})', { n: steps.length }) : t('Steps')),
    steps.length === 0
      ? h('div', { className: 'bt-menu-note' }, t('No steps yet.'))
      : h('div', { className: 'bt-worker-steps', role: 'list', 'aria-label': t('Steps') },
        steps.map(step => h('div', { key: step.id, className: 'bt-worker-step', 'data-state': step.state, role: 'listitem' },
          h('span', { className: 'bt-worker-step-mark', 'aria-hidden': true }),
          h('span', { className: 'bt-menu-label' }, step.title),
          h('span', { className: 'bt-menu-hint' }, [step.tool, stateLabel(step.state)].filter(Boolean).join(' · '))))),
    h('div', { className: 'bt-menu-sep' }),
    h('button', { type: 'button', onClick: onClose }, t('Close'))), document.body)
}

/**
 * Under a Bot's row in the wide sidebar: the native Claude Code subagents of its current turn
 * (and of the last one, until the next starts). `age(ms)` is the threads' short age.
 */
export function NativeWorkers({ bot, useWork, wide, age }) {
  const key = useWork ? useWork(work => workersKey(work, bot.id)) : '[]'
  const [openId, setOpenId] = useState(null)
  const [all, setAll] = useState(false)
  const anchors = useRef(new Map())
  const workers = JSON.parse(key)
  const open = openId === null ? undefined : workers.find(worker => worker.id === openId)
  useEffect(() => { if (openId !== null && open === undefined) setOpenId(null) }, [openId, open])
  if (!wide || workers.length === 0) return null
  const sorted = ordered(workers)
  const shown = all || sorted.length <= WORKERS_SHOWN + 1 ? sorted : sorted.slice(0, WORKERS_SHOWN)
  const more = sorted.length - shown.length
  const close = () => setOpenId(null)
  return h('div', { className: 'bt-threads bt-workers', role: 'group', 'aria-label': t('Subagents {name} started', { name: bot.name }) },
    shown.map((worker) => {
      const line = workerLine(worker)
      const when = worker.at === undefined ? '' : age(worker.at)
      return h('div', { key: worker.id, className: 'bt-worker', 'data-state': worker.state },
        h('button', {
          type: 'button', className: 'bt-thread', 'data-state': worker.state, 'data-worker': worker.id,
          'aria-label': [worker.title, stateLabel(worker.state), line].filter(Boolean).join(', '), title: worker.title,
          'aria-haspopup': 'dialog', 'aria-expanded': openId === worker.id,
          ref: (node) => { if (node) anchors.current.set(worker.id, node); else anchors.current.delete(worker.id) },
          onClick: () => setOpenId(id => (id === worker.id ? null : worker.id)),
        },
        h('span', { className: worker.state === 'running' ? 'bt-thread-spin' : 'bt-thread-mark', 'aria-hidden': true }),
        h('span', { className: 'bt-thread-title' }, worker.title),
        when ? h('span', { className: 'bt-thread-age', 'aria-hidden': true }, when) : null),
        h('span', { className: 'bt-worker-line' }, line))
    }),
    more > 0 ? h('button', { type: 'button', className: 'bt-thread bt-thread-more', onClick: () => setAll(true) }, t('+{n} more', { n: more })) : null,
    open ? h(WorkerPopover, { worker: open, anchor: anchors.current.get(open.id), age: open.at === undefined ? '' : age(open.at), onClose: close }) : null)
}
