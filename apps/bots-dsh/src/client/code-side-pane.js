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
import { ChevronRightIcon } from './icons.js'
import { botRowOf, paneFor, statusKey } from './code-side-model.js'
import { pasteBytes } from './code-side-paste.js'
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

// One viewer per window: the id that says which window holds a pane's typing.
const VIEWER = (() => {
  try { return crypto.randomUUID() } catch { return `viewer-${Math.random().toString(36).slice(2)}` }
})()

const base64Of = (bytes) => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** JSON over the plugin's own exact routes; resolves { status, body }, never the request. */
async function post(path, payload) {
  const answer = await fetch(`api/omni-ui/code/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await answer.json() } catch { body = null }
  return { status: answer.status, body }
}

/**
 * The terminal pane: one EventSource of the host's `pane`/`data`/`close` events, drawn by
 * xterm.js. It watches by default; a click into it takes the pane, and then its keys go to the
 * host in small batches until Escape, a click outside, another Bot or an ended session lets go.
 * No key, batch or paste is ever written to a log or a record here.
 */
export function TerminalPane({ botId, worker, title }) {
  const host = useRef(null)
  const [phase, setPhase] = useState({ kind: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  const [mode, setMode] = useState('view')
  const [pasteNote, setPasteNote] = useState(false)
  // 'paused': the lease ended typing (or a batch was lost); 'back': a retake succeeded.
  const [resumeNote, setResumeNote] = useState(false)
  const modeRef = useRef('view')
  const sessionRef = useRef(null)
  const termRef = useRef(null)
  const takeRef = useRef(null)
  const takingRef = useRef(false)
  const queueRef = useRef([])
  const timerRef = useRef(0)
  const flushingRef = useRef(null)
  const setModeNow = (next) => { modeRef.current = next; setMode(next) }
  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    let disposed = false
    let term = null
    let fit = null
    let source = null
    let observer = null
    let fitFrame = 0
    let outside = null
    let cleanupPaste = null

    const fitNow = () => {
      if (!fit || disposed) return
      cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => { try { fit.fit() } catch { /* the pane is between layouts */ } })
    }
    const encodeQueue = () => {
      const queued = queueRef.current
      queueRef.current = []
      let size = 0
      for (const chunk of queued) size += chunk.length
      if (size === 0) return null
      const bytes = new Uint8Array(size)
      let at = 0
      for (const chunk of queued) { bytes.set(chunk, at); at += chunk.length }
      return base64Of(bytes)
    }
    const sendQueue = async () => {
      const data = encodeQueue()
      if (!data) return true
      const session = sessionRef.current
      if (!session) return false
      const answer = await post('input', { session, data }).catch(() => ({ status: 0 }))
      if (answer.status === 204) return true
      if (answer.status === 401) {
        sessionRef.current = null
        setModeNow('ended')
        setResumeNote('paused')
        // A batch the host refused (a signed-out page) means this watch stream is the only
        // thing left to tell the host to let the typing attach go: close it.
        if (source) { source.close(); source = null }
        return false
      }
      if (answer.status === 409) {
        // The batch that hit the end is lost on purpose (nothing is replayed); the note tells
        // the owner to type again.
        sessionRef.current = null
        setModeNow('ended')
        setResumeNote('paused')
        return false
      }
      return true
    }
    const flush = () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
      flushingRef.current = (flushingRef.current ?? Promise.resolve(true)).then(sendQueue, sendQueue)
      return flushingRef.current
    }
    const stopTyping = (reason = 'released') => {
      const session = sessionRef.current
      sessionRef.current = null
      if (modeRef.current === 'typing') setModeNow(reason === 'ended' ? 'ended' : 'view')
      setPasteNote(false)
      setResumeNote(reason === 'ended' ? 'paused' : false)
      if (term) term.options.disableStdin = true
      if (outside) { document.removeEventListener('pointerdown', outside, true); outside = null }
      return flush().then(() => (session ? post('release', { session }).catch(() => {}) : undefined))
    }
    // A take, and a retake after the idle lease ended typing: the same watch, no navigating.
    // Nothing typed before the take is confirmed is ever sent: the waking key or paste only
    // asks for typing back, and the owner types again after the confirmation.
    const take = async () => {
      if (takingRef.current || modeRef.current === 'typing') return
      takingRef.current = true
      setModeNow('taking')
      const answer = await post('take', { bot: botId, worker: worker ?? null, viewer: VIEWER }).catch(() => ({ status: 0 }))
      takingRef.current = false
      if (disposed) {
        // The watch may have closed before the host finished taking the typing attach.
        if (answer.status === 200 && answer.body?.session) void post('release', { session: answer.body.session }).catch(() => {})
        return
      }
      if (answer.status === 200 && answer.body?.session) {
        sessionRef.current = answer.body.session
        setModeNow('typing')
        setResumeNote('back')
        if (term) { term.options.disableStdin = false; term.focus() }
        if (!outside) {
          outside = (event) => { if (!element.contains(event.target)) void stopTyping('left') }
          document.addEventListener('pointerdown', outside, true)
        }
        return
      }
      setModeNow(answer.status === 409 ? 'elsewhere' : 'ended')
      setResumeNote('paused')
    }
    takeRef.current = take
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
      termRef.current = term
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      fitNow()
      observer = new ResizeObserver(fitNow)
      observer.observe(element)
      // Escape ends typing and is never sent; every other key is one batch.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && event.key === 'Escape' && modeRef.current === 'typing') {
          event.preventDefault()
          void stopTyping('escape')
          return false
        }
        return true
      })
      term.onData((data) => {
        if (modeRef.current === 'typing' && sessionRef.current) {
          setResumeNote(false)
          queueRef.current.push(new TextEncoder().encode(data))
          if (!timerRef.current) timerRef.current = setTimeout(() => { timerRef.current = 0; void flush() }, 20)
        } else if (modeRef.current === 'ended') {
          // The lease ended typing; the waking key only takes typing back, it is never sent
          // (Enter included).
          void takeRef.current?.()
        }
      })
      // A paste never goes through xterm's own paste path (which turns newlines into Enter):
      // the clipboard text is queued with no CR and no LF at all, so nothing in a paste can
      // press Enter, whatever the program's bracketed-paste state.
      const onPaste = (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (modeRef.current === 'ended') {
          // A paste in the ended state asks for typing back too; it is not sent.
          void takeRef.current?.()
          return
        }
        if (modeRef.current !== 'typing' || !sessionRef.current) return
        const pasted = pasteBytes(event.clipboardData?.getData('text/plain') ?? '')
        setPasteNote(pasted.note ?? false)
        setResumeNote(false)
        if (pasted.bytes.length === 0) return
        queueRef.current.push(pasted.bytes)
        if (!timerRef.current) timerRef.current = setTimeout(() => { timerRef.current = 0; void flush() }, 20)
      }
      element.addEventListener('paste', onPaste, true)
      cleanupPaste = () => element.removeEventListener('paste', onPaste, true)
      setPhase({ kind: 'connecting' })
      const query = `api/omni-ui/code/stream?bot=${encodeURIComponent(botId)}${worker ? `&worker=${encodeURIComponent(worker)}` : ''}&viewer=${encodeURIComponent(VIEWER)}`
      source = new EventSource(query)
      source.addEventListener('pane', (event) => {
        if (!event.data) return
        setPhase({ kind: 'open' })
      })
      source.addEventListener('data', (event) => {
        if (disposed || !event.data) return
        const bytes = decode(event.data)
        if (term) term.write(bytes)
      })
      source.addEventListener('close', () => {
        if (source) { source.close(); source = null }
        if (modeRef.current === 'typing') void stopTyping('ended')
        setPhase({ kind: 'ended' })
      })
      source.onerror = () => {
        // EventSource would retry by itself and attach a second stream: let the person ask.
        if (source) { source.close(); source = null }
        if (modeRef.current === 'typing') void stopTyping('ended')
        setPhase({ kind: 'failed' })
      }
    }
    void start()
    return () => {
      disposed = true
      void stopTyping('left')
      cancelAnimationFrame(fitFrame)
      cleanupPaste?.()
      observer?.disconnect()
      source?.close()
      try { term?.dispose() } catch { /* already gone */ }
      element.replaceChildren()
    }
  }, [botId, worker, attempt])
  const watching = phase.kind === 'open' ? t('Watching · view only') : phase.kind === 'ended' ? t('This terminal ended') : phase.kind === 'failed' ? t('The terminal could not be reached') : t('Opening the terminal…')
  const stateWord = mode === 'typing' ? t('Typing · Esc to stop')
    : mode === 'taking' ? t('Taking the pane…')
      : mode === 'elsewhere' ? t('Typing is open in another window · view only')
        : mode === 'ended' ? t('Your session ended · view only')
          : phase.kind === 'open' ? t('View only · click to type') : watching
  const retryable = phase.kind === 'ended' || phase.kind === 'failed'
  return h('div', { className: 'cs-pane' },
    h('div', { className: 'cs-pane-head' },
      h('span', { className: 'cs-pane-title', title }, title),
      h('span', { className: 'cs-pane-note', role: 'status', 'data-mode': mode }, stateWord),
      resumeNote === 'paused' ? h('span', { className: 'cs-paste-note', role: 'status' }, t('Typing paused after 60 s idle. Press any key to resume'))
        : resumeNote === 'back' ? h('span', { className: 'cs-paste-note', role: 'status' }, t('Typing is back: type again'))
          : pasteNote ? h('span', { className: 'cs-paste-note', role: 'status' }, pasteNote === 'controls-stripped' ? t('Control characters were removed from the paste') : t('Line breaks were removed from the paste')) : null,
      retryable ? h('button', { type: 'button', className: 'cs-btn', onClick: () => { setPhase({ kind: 'connecting' }); setAttempt(value => value + 1) } }, t('Reconnect')) : null),
    h('div', { ref: host, className: 'cs-screen', role: 'button', tabIndex: 0, 'aria-label': stateWord, 'data-code-mode': mode, onClick: () => { if (modeRef.current === 'view' || modeRef.current === 'elsewhere' || modeRef.current === 'ended') void takeRef.current?.() } }))
}

export const TreeRow = ({ label, status, depth = 0, current, note, title, onClick }) => h('button', {
  type: 'button', className: 'cs-row', 'data-depth': depth, 'aria-current': current ? 'true' : undefined, title, onClick,
},
  h('span', { className: 'cs-row-label' }, label),
  note ? h('span', { className: 'cs-row-note' }, note) : null,
  h('span', { className: `cs-mark cs-mark-${status}`, title: statusLabel(status) }, h('span', { className: 'cs-mark-word' }, statusLabel(status))))

const TreeFold = ({ label, title, open, onClick }) => h('button', {
  type: 'button', className: 'lb-row', title, 'aria-expanded': open, onClick,
},
  h('span', { className: 'lb-name' }, label),
  h('span', { className: open ? 'lb-chev lb-chev-open' : 'lb-chev' }, h(ChevronRightIcon)))

export function CodeTree({ current, onSelect, sidebar = false }) {
  const { tree, loading, error, selected } = current
  const [folded, setFolded] = useState(() => new Set())
  const toggle = key => setFolded((before) => {
    const next = new Set(before)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const machine = tree?.machine?.name || t('This computer')
  const projects = tree?.projects ?? []
  const machineOpen = !folded.has(null)
  const treeRows = machineOpen ? projects.map((project) => {
    const label = project.global === true ? t('Global Bots') : project.name ?? project.folder
    const key = project.global === true ? 'global' : project.folder
    const title = project.global === true ? label : project.folder
    const open = !folded.has(key)
    return h('section', { key, className: 'cs-project' },
      sidebar ? h(TreeFold, { label, title, open, onClick: () => toggle(key) })
        : h('div', { className: 'cs-project-name', title }, label),
      open ? project.bots.map(bot => h('div', { key: bot.id, className: 'cs-bot' },
        h(TreeRow, {
          label: bot.name,
          status: bot.status,
          current: selected?.botId === bot.id && !selected?.worker,
          note: sidebar ? bot.agent ?? (bot.main ? t('lead') : null) : bot.main ? t('lead') : null,
          onClick: () => onSelect(paneFor(tree, bot.id) ?? { botId: bot.id, worker: null }),
        }),
        bot.workers.map(worker => h(TreeRow, {
          key: worker.terminal,
          label: worker.role ?? worker.agent ?? worker.terminal,
          status: worker.status,
          depth: 1,
          current: selected?.botId === bot.id && selected?.worker === worker.terminal,
          title: [worker.role, worker.branch?.replace(/^refs\/heads\//, '')].filter(Boolean).join(' · '),
          onClick: () => onSelect({ botId: bot.id, worker: worker.terminal }),
        })))) : null)
  }) : null
  return h('nav', { className: sidebar ? 'lb-rows' : 'cs-tree', 'aria-label': t('Code team') },
    sidebar && tree?.machine ? h(TreeFold, { label: machine, open: machineOpen, onClick: () => toggle(null) }) : null,
    error || (sidebar && tree?.reason === 'no-core') ? h('p', { className: 'cs-empty' }, t('The Code side could not read this computer’s team.')) : null,
    !error && projects.length === 0 && !loading && (!sidebar || tree?.reason !== 'no-core') ? h('p', { className: 'cs-empty' }, t('No project has a Bot on this computer yet.')) : null,
    loading && !tree ? h('p', { className: 'cs-empty' }, t('Reading this computer’s team…')) : null,
    treeRows)
}

/** The chosen terminal, shared by the seat face and the bar's main Code panel. */
export function CodeTerminal({ tree, selected, loading }) {
  const chosen = selecting(tree, selected)
  if (!chosen) return h('div', { className: 'cs-empty cs-empty-view' },
    loading ? t('Reading this computer’s team…') : t('No terminal for this Bot yet'))
  const title = chosen.worker
    ? `${chosen.bot.name} · ${chosen.worker.role ?? chosen.worker.agent ?? chosen.worker.terminal}`
    : chosen.bot.name
  return h(TerminalPane, { key: `${chosen.bot.id}:${chosen.worker?.terminal ?? 'seat'}`, botId: chosen.bot.id, worker: chosen.worker?.terminal ?? null, title })
}

/** The seat's Terminal face: keep its own tree next to its terminal. */
export function CodeBody({ code }) {
  const current = useSyncExternalStore(code.subscribe, code.snapshot, code.snapshot)
  const { tree, loading, error } = current
  useEffect(() => {
    if (!tree && !loading && !error) void code.loadTree()
  }, [code, tree, loading, error])
  const realProjects = (tree?.projects ?? []).filter(project => project.global !== true)
  const projectCount = realProjects.length === 1 ? t('1 project') : t('{n} projects', { n: realProjects.length })
  return h('div', { className: 'cs-host' },
    h('div', { className: 'cs-top' },
      h('span', { className: 'cs-machine' }, tree?.machine?.name ?? t('This computer')),
      h('span', { className: 'cs-count' }, projectCount)),
    h('div', { className: 'cs-body' },
      h(CodeTree, { current, onSelect: code.selectPane }),
      h('section', { className: 'cs-view' }, h(CodeTerminal, { tree, selected: current.selected, loading }))))
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
.cs-paste-note{color:var(--lb-needs-ink,var(--st-warn,var(--bt-ink)));font:400 12px/1.3 var(--bt-font);white-space:nowrap}
.cs-pane-note{margin-left:auto;color:var(--lb-muted,color-mix(in srgb,var(--bt-ink) 72%,transparent));font:400 12.5px/1.3 var(--bt-font);white-space:nowrap}
.cs-screen{flex:1;min-height:0;padding:6px 8px 0;background:var(--bt-card);contain:strict;cursor:text}
.cs-screen[data-code-mode='typing']{cursor:text}
.cs-screen[data-code-mode='view']{cursor:pointer}
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
