// The shared gen-UI kit's first cards (#1326, G0/G1/G5): progress and coverage rows, and
// the person card, all exposed to every plugin as omni.genui. A plugin draws them inside
// its own tool card; the rows read the host's live slice (host genui.js), and the person
// card reads the chat's reading note through the host endpoint `omni-reading-note`, only
// ever reading it. Nothing here sends, cancels or writes a note.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { coverageLine, personView, rowView } from './genui-model.js'

// The read the person card makes: the chat, its reading note and its coverage, as the
// Omni channels plugin serves it (read-only). A plugin with its own read passes `load`.
export const READING_NOTE = 'omni-reading-note'

export function loadReadingNote(chatId) {
  if (typeof chatId !== 'string' || chatId === '') return Promise.reject(new Error('A person card needs a chat id'))
  return call(READING_NOTE, { chat: chatId })
}

// The rows of one batch in the host's live slice, as a tool card got its roster.
export function genuiRows(roster, batchId) {
  const batches = roster?.genui?.batches
  if (batches === null || typeof batches !== 'object' || Array.isArray(batches)) return []
  const batch = typeof batchId === 'string' ? batches[batchId] : undefined
  return batch !== null && typeof batch === 'object' && Array.isArray(batch.rows) ? batch.rows : []
}

// The slice's revision: a card that should refresh while the bot works watches it.
export function revisionOf(roster) {
  const revision = roster?.genui?.revision
  return typeof revision === 'number' && Number.isFinite(revision) ? revision : 0
}

/** One chat's line: its name and state, its page or counts, then its media and marks. */
export function ProgressRow({ row }) {
  const view = rowView(row)
  return h('li', { className: 'bt-genui-row', 'data-state': view.state },
    h('span', { className: 'bt-genui-dot', 'aria-hidden': true }),
    h('div', { className: 'bt-genui-body' },
      h('div', { className: 'bt-genui-line' },
        view.name !== '' ? h('span', { className: 'bt-genui-name' }, view.name) : null,
        view.word !== '' ? h('span', { className: 'bt-genui-word' }, view.word) : null,
        view.page !== '' ? h('span', { className: 'bt-genui-num' }, view.page) : null,
        view.progress !== '' ? h('span', { className: 'bt-genui-num' }, view.progress) : null,
        view.span !== '' ? h('span', { className: 'bt-genui-num bt-genui-span' }, view.span) : null),
      view.media !== '' || view.marks !== ''
        ? h('div', { className: 'bt-genui-line bt-genui-sub' },
          view.media !== '' ? h('span', null, view.media) : null,
          view.marks !== '' ? h('span', null, view.marks) : null)
        : null))
}

/** One line per chat, in the order the host last changed them. */
export function ProgressRows({ rows: list, label }) {
  const shown = Array.isArray(list) ? list : []
  if (shown.length === 0) return null
  return h('ul', { className: 'bt-genui-rows', 'aria-label': typeof label === 'string' ? label : t('Progress') },
    shown.map((row, index) => h(ProgressRow, { key: typeof row?.chatId === 'string' ? row.chatId : index, row })))
}

/** What a chat holds now: its message count, the months it spans, deleted and missing media. */
export function CoverageRow({ coverage }) {
  const line = coverageLine(coverage)
  return line === '' ? null : h('div', { className: 'bt-genui-what' }, line)
}

/**
 * The person card: four parts of the bot's reading note, the read-through date, and the
 * chat's coverage. `revision` refetches it while the bot reads (a plugin passes the live
 * slice's revision); `load` replaces the default `omni-reading-note` read.
 */
export function PersonCard({ chatId, load, revision }) {
  const [state, setState] = useState({ data: undefined, error: undefined, loading: true })
  const [tries, setTries] = useState(0)
  // A plugin may pass an inline loader: the ref keeps a re-render from refetching by itself.
  const loader = useRef(load ?? loadReadingNote)
  loader.current = load ?? loadReadingNote
  const order = useRef(0)
  useEffect(() => {
    if (typeof chatId !== 'string' || chatId === '') return undefined
    const mine = ++order.current
    let live = true
    setState(current => ({ ...current, loading: true, error: undefined }))
    Promise.resolve().then(() => loader.current(chatId)).then((data) => {
      if (live && mine === order.current) setState({ data, error: undefined, loading: false })
    }).catch((error) => {
      if (live && mine === order.current) setState(current => ({ data: current.data, error, loading: false }))
    })
    return () => { live = false }
  }, [chatId, revision, tries])
  const retry = useCallback(() => setTries(count => count + 1), [])
  const view = personView(state.data)
  // The plain state only once the read has answered: loading or a failed read says so in
  // the foot, never "not read yet" over an answer that may still come.
  const answered = state.data !== undefined
  return h('section', { className: 'bt-q bt-genui-person', 'aria-busy': state.loading ? 'true' : undefined },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title' }, view.title),
        answered && view.subtitle !== '' ? h('div', { className: 'bt-q-detail' }, view.subtitle) : null)),
    view.blocks.length === 0 ? null : h('div', { className: 'bt-genui-blocks' },
      view.blocks.map(block => h('div', { className: 'bt-genui-block', key: block.key },
        h('div', { className: 'bt-genui-label' }, block.label),
        block.text !== ''
          ? h('p', { className: 'bt-genui-text' }, block.text)
          : h('p', { className: 'bt-genui-text bt-genui-muted' }, t('Not in the note yet.'))))),
    view.coverage === undefined ? null : h(CoverageRow, { coverage: view.coverage }),
    h('div', { className: 'bt-genui-foot' },
      view.readThrough !== '' ? h('span', { className: 'bt-genui-read' }, t('Read through {date}', { date: view.readThrough })) : null,
      state.loading ? h('span', { className: 'bt-genui-muted' }, t('Reading the note…')) : null,
      state.error === undefined ? null : h('span', { className: 'bt-genui-muted' }, t('The note could not be read.')),
      state.error === undefined ? null : h('button', { type: 'button', className: 'bt-genui-retry', onClick: retry }, t('Try again'))))
}

// The kit's own surface: the same card, hairline and muted text as the team's question
// cards (.bt-q in styles.js), a dot and a word for every state, and the four parts of a
// person card a step down from its title. Colors and corners are the brand's variables.
export const GENUI_CSS = `
.bt-genui-row{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:8px;border-radius:10px;font:inherit}
.bt-genui-row+.bt-genui-row{box-shadow:inset 0 1px 0 var(--bt-q-rule-2,var(--bt-line-weak))}
.bt-genui-rows{display:flex;flex-direction:column;gap:1px;min-width:0;margin:0 -8px;padding:0;list-style:none}
.bt-genui-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--bt-ink-3)}
.bt-genui-row[data-state=done] .bt-genui-dot{background:var(--bt-green)}
.bt-genui-row[data-state=failed] .bt-genui-dot{background:var(--bt-danger)}
.bt-genui-row[data-state=phone] .bt-genui-dot{background:var(--bt-gold)}
.bt-genui-row[data-state=stopped] .bt-genui-dot{background:var(--bt-ink-3)}
.bt-genui-row[data-state=work] .bt-genui-dot{background:var(--bt-accent)}
.bt-genui-row[data-state=work] .bt-genui-dot{animation:bt-genui-pulse 1.6s ease-in-out infinite}
.bt-genui-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-genui-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;min-width:0;font-size:13.5px;line-height:19px}
.bt-genui-name{font-weight:600;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-genui-word{color:var(--bt-ink-2)}
.bt-genui-num{color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-genui-span{color:var(--bt-ink-3)}
.bt-genui-sub{font-size:12.5px;line-height:17px;color:var(--bt-ink-3)}
.bt-genui-what{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;padding:0 8px;color:var(--bt-ink-2);font-size:12.5px;line-height:18px}
.bt-genui-blocks{display:flex;flex-direction:column;min-width:0}
.bt-genui-block{padding-top:10px;border-top:1px solid var(--bt-q-rule-2,var(--bt-line-weak))}
.bt-genui-block:first-child{padding-top:0;border-top:0}
.bt-genui-label{margin:0;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--bt-ink-3)}
.bt-genui-text{margin:2px 0 0;font-size:13.5px;line-height:19px;color:var(--bt-ink);white-space:pre-wrap;overflow-wrap:anywhere}
.bt-genui-muted{color:var(--bt-ink-3)}
.bt-genui-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding-top:10px;border-top:1px solid var(--bt-q-rule,var(--bt-line-2));font-size:12.5px;line-height:17px;color:var(--bt-ink-3)}
.bt-genui-read{color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-genui-retry{flex:none;height:26px;padding:0 10px;border:1px solid var(--bt-line-2);border-radius:999px;background:none;color:var(--bt-ink);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.bt-genui-retry:hover{background:var(--bt-hover)}
.bt-genui-retry:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-genui-person{max-width:560px}
@keyframes bt-genui-pulse{50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.bt-genui-row[data-state=work] .bt-genui-dot{animation:none}}
body[data-bt-motion=quiet] .bt-genui-row[data-state=work] .bt-genui-dot{animation:none}
`
