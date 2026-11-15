// The Code side's renderer, in its own client chunk (RFC 0030 delivery 1): nothing of this
// file, xterm.js or its stylesheet loads until the view's Terminal face is pressed. The host
// serves it as `client.pane.js` beside `client.js`; code-side.js asks the module loader for it
// on the first render of the pane.
//
// It draws the team tree the host read from the registry and the two ledgers, and one
// herdr-core terminal watched in the app instead of the Herdr window. View only: the host
// attaches with `observe: true`, this page never sends a key or a resize.
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { t } from './i18n.js'
import { installStyles } from './styles.js'
import { botRowOf, statusKey } from './code-side-model.js'
import XTERM_CSS from '@xterm/xterm/css/xterm.css'

const WORD = { working: () => t('Working'), 'needs-you': () => t('Needs you'), idle: () => t('Idle'), 'not-running': () => t('Not running') }

/** One tree status as the words the bar uses. */
export const statusLabel = status => WORD[statusKey(status)]()

const decode = (text) => {
  if (typeof text !== 'string' || text === '') return new Uint8Array()
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The pane's ground: the first ancestor with a painted background, so no default black shows through. */
function groundOf(element) {
  for (let node = element; node; node = node.parentElement) {
    const background = getComputedStyle(node).backgroundColor
    if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background
  }
  return getComputedStyle(document.body).backgroundColor || 'Canvas'
}

/**
 * The terminal pane: one EventSource of the host's `pane`/`data`/`close` events, drawn by
 * xterm.js. It is a watcher: no stdin, no resize frame, no second connection per render.
 */
function TerminalPane({ botId, worker, title }) {
  const host = useRef(null)
  const [phase, setPhase] = useState({ kind: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    let disposed = false
    let term = null
    let fit = null
    let source = null
    let observer = null
    let fitFrame = 0

    const fitNow = () => {
      if (!fit || disposed) return
      cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => { try { fit.fit() } catch { /* the pane is between layouts */ } })
    }
    const start = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed) return
      const background = groundOf(element)
      const foreground = getComputedStyle(element).color || 'inherit'
      term = new Terminal({
        convertEol: false,
        cursorBlink: false,
        disableStdin: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: { background, foreground },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      fitNow()
      observer = new ResizeObserver(fitNow)
      observer.observe(element)
      setPhase({ kind: 'connecting' })
      const query = `api/omni-ui/code/stream?bot=${encodeURIComponent(botId)}${worker ? `&worker=${encodeURIComponent(worker)}` : ''}`
      source = new EventSource(query)
      source.addEventListener('pane', (event) => {
        if (!event.data) return
        setPhase({ kind: 'open' })
      })
      source.addEventListener('data', (event) => {
        if (!disposed && term && event.data) term.write(decode(event.data))
      })
      source.addEventListener('close', () => {
        if (source) { source.close(); source = null }
        setPhase({ kind: 'ended' })
      })
      source.onerror = () => {
        // EventSource would retry by itself and attach a second stream: let the person ask.
        if (source) { source.close(); source = null }
        setPhase({ kind: 'failed' })
      }
    }
    void start()
    return () => {
      disposed = true
      cancelAnimationFrame(fitFrame)
      observer?.disconnect()
      source?.close()
      try { term?.dispose() } catch { /* already gone */ }
      element.replaceChildren()
    }
  }, [botId, worker, attempt])
  const label = phase.kind === 'open' ? t('Watching · view only') : phase.kind === 'ended' ? t('This terminal ended') : phase.kind === 'failed' ? t('The terminal could not be reached') : t('Opening the terminal…')
  return h('div', { className: 'cs-pane' },
    h('div', { className: 'cs-pane-head' },
      h('span', { className: 'cs-pane-title', title }, title),
      h('span', { className: 'cs-pane-note', role: 'status' }, label),
      phase.kind === 'ended' || phase.kind === 'failed' ? h('button', { type: 'button', className: 'cs-btn', onClick: () => { setPhase({ kind: 'connecting' }); setAttempt(value => value + 1) } }, t('Reconnect')) : null),
    h('div', { ref: host, className: 'cs-screen', 'data-code-screen': phase.kind }))
}

const TreeRow = ({ label, status, depth = 0, current, note, title, onClick }) => h('button', {
  type: 'button', className: 'cs-row', 'data-depth': depth, 'aria-current': current ? 'true' : undefined, title, onClick,
},
  h('span', { className: 'cs-row-label' }, label),
  note ? h('span', { className: 'cs-row-note' }, note) : null,
  h('span', { className: `cs-mark cs-mark-${status}`, title: statusLabel(status) }, h('span', { className: 'cs-mark-word' }, statusLabel(status))))

/**
 * The Code body: the team tree on the left (projects, their Bots, the workers under them) and
 * the chosen terminal on the right. Every row and every click reads what the host sent; no
 * row starts, stops or types into anything.
 * `code` is the main client's store surface: { subscribe, snapshot, loadTree, selectPane }.
 */
export function CodeBody({ code }) {
  const current = useSyncExternalStore(code.subscribe, code.snapshot, code.snapshot)
  const tree = current.tree
  useEffect(() => { if (!current.tree && !current.loading) void code.loadTree() }, [code, current.tree, current.loading])
  const chosen = selecting(tree, current.selected)
  const title = chosen
    ? (chosen.worker ? `${chosen.bot.name} · ${chosen.worker.role ?? chosen.worker.agent ?? chosen.worker.terminal}` : chosen.bot.name)
    : t('No terminal chosen')
  const choose = (botId, worker = null) => {
    const bot = botRowOf(tree, botId)
    if (!bot) return
    if (worker) code.selectPane({ botId, worker })
    else if (bot.terminal) code.selectPane({ botId, worker: null })
    else if (bot.workers.length > 0) code.selectPane({ botId, worker: bot.workers[0].terminal })
    else code.selectPane({ botId, worker: null })
  }
  const projects = tree?.projects ?? []
  const projectCount = projects.length === 1 ? t('1 project') : t('{n} projects', { n: projects.length })
  const treeRows = projects.map(project => h('section', { key: project.folder, className: 'cs-project' },
    h('div', { className: 'cs-project-name', title: project.folder }, project.name ?? project.folder),
    project.bots.map(bot => h('div', { key: bot.id, className: 'cs-bot' },
      h(TreeRow, {
        label: bot.name,
        status: bot.status,
        current: current.selected?.botId === bot.id && !current.selected?.worker,
        note: bot.main ? t('lead') : null,
        onClick: () => choose(bot.id),
      }),
      bot.workers.map(worker => h(TreeRow, {
        key: worker.terminal,
        label: worker.role ?? worker.agent ?? worker.terminal,
        status: worker.status,
        depth: 1,
        current: current.selected?.botId === bot.id && current.selected?.worker === worker.terminal,
        title: [worker.role, worker.branch?.replace(/^refs\/heads\//, '')].filter(Boolean).join(' · '),
        onClick: () => choose(bot.id, worker.terminal),
      }))))))
  return h('div', { className: 'cs-host' },
    h('div', { className: 'cs-top' },
      h('span', { className: 'cs-machine' }, tree?.machine?.name ?? t('This computer')),
      h('span', { className: 'cs-count' }, projectCount)),
    h('div', { className: 'cs-body' },
      h('nav', { className: 'cs-tree', 'aria-label': t('Code team') },
        current.error ? h('p', { className: 'cs-empty' }, t('The Code side could not read this computer’s team.')) : null,
        !current.error && projects.length === 0 && !current.loading ? h('p', { className: 'cs-empty' }, t('No project has a Bot on this computer yet.')) : null,
        current.loading && !tree ? h('p', { className: 'cs-empty' }, t('Reading this computer’s team…')) : null,
        treeRows),
      h('section', { className: 'cs-view' },
        chosen
          ? h(TerminalPane, { key: `${chosen.bot.id}:${chosen.worker?.terminal ?? 'seat'}`, botId: chosen.bot.id, worker: chosen.worker?.terminal ?? null, title })
          : h('div', { className: 'cs-empty cs-empty-view' },
              current.loading ? t('Reading this computer’s team…') : t('No terminal for this Bot yet')))))
}

/** The selected row, with its Bot and worker: from the store, or from the row just pressed. */
function selecting(tree, selected) {
  if (!tree || !selected) return null
  const bot = botRowOf(tree, selected.botId)
  if (!bot) return null
  if (selected.worker) {
    const worker = bot.workers.find(candidate => candidate.terminal === selected.worker)
    return worker ? { bot, worker } : null
  }
  return bot.terminal ? { bot, worker: null } : null
}

// The pane's sheet: the bar's own sizes and type (left-bar-css.js tokens), so the tree reads
// beside the Team rows rather than under them. The pane's ground is the theme's card; xterm
// paints its own cell area over it, and a painted theme background keeps its gap from going black.
export const CODE_SIDE_CSS = `
.cs-host{display:flex;flex:1;flex-direction:column;min-height:0;height:100%;color:var(--bt-ink);font:var(--bt-weight-label,500) 14px/1.3 var(--bt-font)}
[data-conversation-scroll]:has(.cs-host){overflow:hidden}
[data-conversation-scroll]>[data-slot='conversation.session']{display:flex;flex:1 1 auto;min-height:0}
[data-conversation-scroll]:has(.cs-host)>[data-slot='conversation.session']{flex:1 1 100%}
[data-conversation-scroll]:has(.cs-host)>[data-slot='conversation.session']~*{display:none}
.cs-top{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--lb-line,var(--bt-line));background:var(--bt-main);flex:none}
.cs-machine{font:var(--bt-weight-title,600) 13px/1.3 var(--bt-head-font,var(--bt-font))}
.cs-count{color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));font:400 12.5px/1.3 var(--bt-font)}
.cs-btn{margin-left:auto;height:26px;padding:0 12px;border:1px solid var(--lb-line,var(--bt-line));border-radius:999px;background:none;color:var(--bt-ink);font:var(--bt-weight-label,500) 13px/1 var(--bt-head-font,var(--bt-font));cursor:pointer}
.cs-btn:disabled{opacity:.55;cursor:default}
.cs-body{display:flex;flex:1;min-height:0}
.cs-tree{width:var(--lb-list-w,264px);min-width:184px;max-width:42%;overflow:auto;padding:8px;border-right:1px solid var(--lb-line,var(--bt-line));background:var(--bt-card);flex:none}
.cs-project{margin:0 0 10px}
.cs-project-name{padding:6px 10px 5px;color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));font:var(--bt-weight-title,600) 10.5px/1.3 var(--bt-head-font,var(--bt-font));letter-spacing:.16em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cs-bot{display:block}
.cs-row{display:flex;align-items:center;gap:var(--lb-art-gap,10px);width:100%;min-width:0;height:var(--lb-row-h,34px);padding:0 10px 0 8px;margin:0;border:0;border-radius:var(--lb-row-r,8px);background:none;color:var(--bt-ink);font:var(--bt-weight-label,500) 15px/1.3 var(--bt-head-font,var(--bt-font));letter-spacing:-.005em;text-align:left;cursor:pointer}
.cs-row[data-depth='1']{height:var(--lb-channel-h,26px);padding-left:calc(8px + var(--lb-art,28px) + var(--lb-art-gap,10px));color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));font:400 13.5px/1.3 var(--bt-font);letter-spacing:0}
.cs-row:hover{background:var(--bt-hover)}
.cs-row[aria-current='true']{background:var(--lb-open,var(--bt-active))}
.cs-row:focus-visible{outline:3px solid var(--st-ring,var(--bt-accent));outline-offset:-3px}
.cs-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs-row-note{color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));font:400 11.5px/1.3 var(--bt-font);max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs-mark{display:inline-flex;align-items:center;gap:6px;font:400 12px/1 var(--bt-font);color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));white-space:nowrap;text-transform:lowercase}
.cs-mark::before{content:'';width:var(--lb-mark,12px);height:var(--lb-mark,12px);border-radius:999px;background:currentColor}
.cs-mark-working::before{background:var(--st-ok,var(--bt-accent))}
.cs-mark-needs-you{color:var(--lb-needs-ink,var(--st-warn,var(--bt-ink)))}
.cs-mark-needs-you::before{background:var(--st-warn,var(--bt-accent))}
.cs-mark-not-running{color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 62%,transparent))}
.cs-mark-not-running::before{background:transparent;box-shadow:inset 0 0 0 1px currentColor}
.cs-mark-word{overflow:hidden;text-overflow:ellipsis}
.cs-view{display:flex;flex:1;min-width:0;flex-direction:column;background:var(--bt-card)}
.cs-pane{display:flex;flex:1;flex-direction:column;min-height:0}
.cs-pane-head{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--lb-line,var(--bt-line));flex:none}
.cs-pane-title{font:var(--bt-weight-title,600) 13.5px/1.3 var(--bt-head-font,var(--bt-font));min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs-pane-note{margin-left:auto;color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));font:400 12.5px/1.3 var(--bt-font);white-space:nowrap}
.cs-screen{flex:1;min-height:0;padding:6px 8px 0;background:var(--bt-card);contain:strict}
.cs-screen .xterm{height:100%}
.cs-screen .xterm-viewport{background:transparent!important}
.cs-empty{margin:0;padding:14px 12px;color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 68%,transparent));font:400 13px/1.45 var(--bt-font)}
.cs-empty-view{display:flex;align-items:center;justify-content:center;flex:1;padding:24px;text-align:center}
@media (max-width:700px){.cs-body{flex-direction:column}.cs-tree{width:auto;max-width:none;max-height:38%;min-width:0;border-right:0;border-bottom:1px solid var(--lb-line,var(--bt-line))}}
`

if (typeof document !== 'undefined') {
  installStyles(CODE_SIDE_CSS, 'code-side')
  installStyles(XTERM_CSS, 'xterm')
}
