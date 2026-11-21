// The shared gen-UI kit's first cards (#1326, G0/G1/G5): progress and coverage rows, and
// the person card, all exposed to every plugin as omni.genui. A plugin draws them inside
// its own tool card; the rows read the host's live slice (host genui.js), and the person
// card reads the chat's reading note through the host endpoint `omni-reading-note`, only
// ever reading it. Nothing here sends, cancels or writes a note.
import { Fragment, createElement as h, useCallback, useEffect, useId, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { backfillView, countText, coverageLine, personView, rowView } from './genui-model.js'

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
export function ProgressRow({ row, view: given, action }) {
  // A kit card that already built the view (the backfill card) passes it; a plain row is read here.
  const view = given ?? rowView(row)
  const windowLine = view.windowLine ?? ''
  return h('li', { className: 'bt-genui-row', 'data-state': view.state },
    h('span', { className: 'bt-genui-dot', 'aria-hidden': true }),
    h('div', { className: 'bt-genui-body' },
      h('div', { className: 'bt-genui-line' },
        view.name !== '' ? h('span', { className: 'bt-genui-name' }, view.name) : null,
        view.word !== '' ? h('span', { className: 'bt-genui-word' }, view.word) : null,
        view.page !== '' ? h('span', { className: 'bt-genui-num' }, view.page) : null,
        view.progress !== '' ? h('span', { className: 'bt-genui-num' }, view.progress) : null,
        view.span !== '' ? h('span', { className: 'bt-genui-num bt-genui-span' }, view.span) : null),
      view.media !== '' || view.marks !== '' || windowLine !== ''
        ? h('div', { className: 'bt-genui-line bt-genui-sub' },
          view.media !== '' ? h('span', null, view.media) : null,
          view.marks !== '' ? h('span', null, view.marks) : null,
          windowLine !== '' ? h('span', null, windowLine) : null)
        : null),
    // A card of the kit's own may hang one action off a row (a backfill's Stop).
    action === undefined || action === null ? null : h('div', { className: 'bt-genui-action' }, action))
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
  // The answer is bound to the chat it belongs to. A card is mounted once and may be handed
  // another chat; nothing of the old one (name, note, coverage) may show under the new one,
  // while its read is pending, after it fails, or when the id is cleared.
  const [state, setState] = useState({ chatId: undefined, data: undefined, error: undefined, loading: true })
  const [tries, setTries] = useState(0)
  // A plugin may pass an inline loader: the ref keeps a re-render from refetching by itself.
  const loader = useRef(load ?? loadReadingNote)
  loader.current = load ?? loadReadingNote
  const order = useRef(0)
  useEffect(() => {
    if (typeof chatId !== 'string' || chatId === '') return undefined
    const mine = ++order.current
    let live = true
    // A refresh of the same chat keeps its answer while the read runs; another chat starts empty.
    setState(current => (current.chatId === chatId
      ? { ...current, loading: true, error: undefined }
      : { chatId, data: undefined, error: undefined, loading: true }))
    Promise.resolve().then(() => loader.current(chatId)).then((data) => {
      if (live && mine === order.current) setState({ chatId, data, error: undefined, loading: false })
    }).catch((error) => {
      // A failed read drops the answer, also the one this same chat had: a card never shows a
      // note it no longer knows is current.
      if (live && mine === order.current) setState({ chatId, data: undefined, error, loading: false })
    })
    return () => { live = false }
  }, [chatId, revision, tries])
  const retry = useCallback(() => setTries(count => count + 1), [])
  // The state is only drawn for the chat the card is for now; a switch hides it at once,
  // before the effect that starts the new read runs.
  const shown = state.chatId === chatId ? state : { chatId, data: undefined, error: undefined, loading: true }
  const view = personView(shown.data)
  // The plain state only once the read has answered: loading or a failed read says so in
  // the foot, never "not read yet" over an answer that may still come.
  const answered = shown.data !== undefined
  return h('section', { className: 'bt-q bt-genui-person', 'aria-busy': shown.loading ? 'true' : undefined },
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
      shown.loading ? h('span', { className: 'bt-genui-muted' }, t('Reading the note…')) : null,
      shown.error === undefined ? null : h('span', { className: 'bt-genui-muted' }, t('The note could not be read.')),
      shown.error === undefined ? null : h('button', { type: 'button', className: 'bt-genui-retry', onClick: retry }, t('Try again'))))
}

// The owner actions a backfill card sends (#1326 K2). Both are endpoints of the host's
// POST /api/omni-ui, served by Omni's channels plugin: `start_backfill` is the person's one
// approval, never a Bot's tool, and `cancel_backfill` stops one queued or fetching job.
export const START_BACKFILL = 'start_backfill'
export const CANCEL_BACKFILL = 'cancel_backfill'

const backfillId = value => (typeof value === 'string' ? value.trim() : '')
const backfillMessage = (error, fallback) => (typeof error?.message === 'string' && error.message !== '' ? error.message : fallback)

/** One approval: the proposal, the chats the person ticked and both dates. */
export function startBackfill(payload) {
  const proposalId = backfillId(payload?.proposalId)
  const chats = [...new Set((Array.isArray(payload?.chats) ? payload.chats : []).map(backfillId).filter(id => id !== ''))]
  const from = backfillId(payload?.from)
  const to = backfillId(payload?.to)
  if (proposalId === '' || chats.length === 0 || from === '' || to === '') {
    return Promise.reject(new Error('A backfill start needs a proposal, at least one chat and both dates'))
  }
  return call(START_BACKFILL, { proposalId, chats, from, to })
}

/** Stop one job; the row ends on the next live answer. */
export function cancelBackfill(payload) {
  const jobId = backfillId(payload?.jobId)
  if (jobId === '') return Promise.reject(new Error('Cancelling a backfill needs its job id'))
  return call(CANCEL_BACKFILL, { jobId })
}

const toggleChat = (list, id) => (list.includes(id) ? list.filter(item => item !== id) : [...list, id])

/**
 * The interactive backfill card. It reads the open proposals and the live runs from the
 * same roster every kit card reads (`omniBackfillProposals`, `omniBackfills`), so a plugin
 * mounts it with `roster: p.roster`. A bound card takes a proposalId, a runId, or both.
 * The person ticks chats, sets dates and presses Start
 * once; that single approval goes through `start_backfill`. A running row offers Stop,
 * which sends `cancel_backfill` for that job. Nothing here starts on its own, and nothing
 * sends a message: the card draws labels, dates, states and counts only.
 */
export function BackfillCard({ roster, proposalId, runId, start, cancel }) {
  // A plugin may pass its own actions (a test, another host half); the ref keeps a
  // re-render from swapping the function under a request already in flight.
  const starter = useRef(start ?? startBackfill)
  starter.current = start ?? startBackfill
  const stopper = useRef(cancel ?? cancelBackfill)
  stopper.current = cancel ?? cancelBackfill
  const [forms, setForms] = useState({})
  const [busy, setBusy] = useState(undefined)
  const [sent, setSent] = useState(undefined)
  const [errors, setErrors] = useState({})
  const [stopping, setStopping] = useState({})
  const prefix = useId()
  const view = backfillView(roster, { proposalId, runId })
  const readOnly = Boolean(roster?.readOnly)
  const readOnlyNote = readOnly
    ? h('span', { className: 'bt-genui-muted' }, t('This window only reads the team; open the team where it runs to act.'))
    : null
  const formOf = proposal => forms[proposal.id] ?? { from: proposal.from, to: proposal.to, chats: proposal.ticked }
  const update = (proposal, patch) => setForms(all => ({
    ...all,
    [proposal.id]: { ...(all[proposal.id] ?? { from: proposal.from, to: proposal.to, chats: proposal.ticked }), ...patch },
  }))
  const onStart = async (proposal, form) => {
    const ready = form.chats.length > 0 && form.from !== '' && form.to !== '' && form.from <= form.to
    if (readOnly || busy !== undefined || !ready) return
    setBusy(proposal.id)
    setErrors(all => { const next = { ...all }; delete next[proposal.id]; return next })
    try {
      const answer = await starter.current({ proposalId: proposal.id, chats: form.chats, from: form.from, to: form.to })
      setSent({ proposalId: proposal.id, runId: answer?.runId })
    } catch (error) {
      setErrors(all => ({ ...all, [proposal.id]: backfillMessage(error, t('The backfill could not be started.')) }))
    } finally {
      setBusy(undefined)
    }
  }
  const onCancel = async (run, row) => {
    if (readOnly || stopping[row.jobId] === true) return
    setStopping(all => ({ ...all, [row.jobId]: true }))
    setErrors(all => { const next = { ...all }; delete next[`run:${run.id}`]; return next })
    try {
      await stopper.current({ jobId: row.jobId })
    } catch (error) {
      setErrors(all => ({ ...all, [`run:${run.id}`]: backfillMessage(error, t('The backfill could not be stopped.')) }))
    } finally {
      setStopping(all => { const next = { ...all }; delete next[row.jobId]; return next })
    }
  }
  // Once the live roster lists an approved run, retire its waiting message even if
  // the run is outside this card's scope or is later pruned from the roster.
  const sentRunListed = sent?.runId !== undefined && Array.isArray(roster?.omniBackfills)
    && roster.omniBackfills.some(run => run?.id === sent.runId)
  useEffect(() => {
    if (sentRunListed) setSent(current => current === sent ? undefined : current)
  }, [sent, sentRunListed])
  const showsSentProposal = proposalId === undefined ? runId === undefined : sent?.proposalId === proposalId
  const waiting = showsSentProposal && !sentRunListed ? sent : undefined
  const proposalSettled = view.proposalSettled && waiting === undefined
  const runMissing = runId !== undefined && view.runs.length === 0
  if (waiting === undefined && view.proposals.length === 0 && view.runs.length === 0 && !proposalSettled && !runMissing) return null
  const pickers = view.proposals.filter(proposal => waiting?.proposalId !== proposal.id).map((proposal) => {
    const form = formOf(proposal)
    const starting = busy === proposal.id
    const held = readOnly || busy !== undefined
    const ordered = form.chats.length > 0 && form.from !== '' && form.to !== '' && form.from <= form.to
    const backwards = form.from !== '' && form.to !== '' && form.from > form.to
    return h('section', { key: proposal.id, className: 'bt-q bt-genui-backfill', 'aria-busy': starting ? 'true' : undefined },
      h('div', { className: 'bt-q-head' },
        h('div', { className: 'bt-q-text' },
          h('p', { className: 'bt-q-title' }, t('Read chat history')),
          h('div', { className: 'bt-q-detail' }, proposal.range)),
        h('button', {
          type: 'button', className: 'bt-genui-start', disabled: held || !ordered,
          onClick: () => onStart(proposal, form),
        }, starting ? t('Starting…') : t('Start'))),
      h('p', { className: 'bt-genui-note' }, t('Choose the chats to read, then set the dates. Nothing starts until you press Start.')),
      h('div', { className: 'bt-genui-dates' },
        h('label', { className: 'bt-genui-date-label', htmlFor: `${prefix}-${proposal.id}-from` },
          t('Start date'),
          h('input', {
            id: `${prefix}-${proposal.id}-from`, type: 'date', className: 'bt-genui-date', value: form.from,
            disabled: held, 'aria-label': t('Start date'),
            onChange: event => update(proposal, { from: event.target.value }),
          })),
        h('label', { className: 'bt-genui-date-label', htmlFor: `${prefix}-${proposal.id}-to` },
          t('End date'),
          h('input', {
            id: `${prefix}-${proposal.id}-to`, type: 'date', className: 'bt-genui-date', value: form.to,
            disabled: held, 'aria-label': t('End date'),
            onChange: event => update(proposal, { to: event.target.value }),
          }))),
      proposal.chats.length === 0
        ? h('p', { className: 'bt-genui-muted' }, t('There are no chats to read here.'))
        : h('ul', { className: 'bt-genui-picks', 'aria-label': t('Chats to read') },
          proposal.chats.map(chat => h('li', { key: chat.id, className: 'bt-genui-pick' },
            h('label', { className: 'bt-genui-pick-label' },
              h('input', {
                type: 'checkbox', checked: form.chats.includes(chat.id), disabled: held,
                onChange: () => update(proposal, { chats: toggleChat(form.chats, chat.id) }),
              }),
              h('span', { className: 'bt-genui-name' }, chat.name),
              chat.channel !== '' ? h('span', { className: 'bt-genui-muted' }, chat.channel) : null)))),
      h('div', { className: 'bt-genui-foot' },
        h('span', { className: 'bt-genui-muted' }, t('{count} chats selected', { count: countText(form.chats.length) })),
        backwards ? h('span', { className: 'bt-genui-error' }, t('The start date must be before the end date.')) : null,
        errors[proposal.id] !== undefined ? h('span', { className: 'bt-genui-error', role: 'status' }, errors[proposal.id]) : null,
        starting ? h('span', { className: 'bt-genui-muted' }, t('Sending your approval…')) : null,
        readOnlyNote))
  })
  const waitingNode = waiting === undefined ? null : h('section', { className: 'bt-q bt-genui-backfill', 'aria-busy': 'true' },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title' }, t('Backfill')),
        h('div', { className: 'bt-q-detail' }, t('Your approval was sent. One backfill is starting for each chat you chose.')))),
    h('div', { className: 'bt-genui-foot' },
      h('span', { className: 'bt-genui-muted' }, t('Starting…')),
      readOnlyNote))
  const runsNode = view.runs.length === 0 ? null : h('section', { className: 'bt-q bt-genui-backfill-runs' },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, t('Backfills')))),
    view.runs.map(run => h('div', { key: run.id, className: 'bt-genui-run' },
      h('div', { className: 'bt-genui-run-head' },
        h('span', { className: 'bt-genui-run-range' }, run.range),
        h('span', { className: 'bt-genui-num' }, t('{count} chats', { count: countText(run.total) })),
        run.summary !== '' ? h('span', { className: 'bt-genui-word' }, run.summary) : null,
        run.started !== '' ? h('span', { className: 'bt-genui-muted' }, t('Started {date}', { date: run.started })) : null),
      h('ul', { className: 'bt-genui-rows', 'aria-label': run.range },
        run.rows.map(row => h(ProgressRow, {
          key: row.chatId, view: row,
          action: row.cancelable
            ? h('button', {
              type: 'button', className: 'bt-genui-cancel', disabled: readOnly || stopping[row.jobId] === true,
              'aria-label': t('Stop the backfill of {chat}', { chat: row.name }),
              onClick: () => onCancel(run, row),
            }, stopping[row.jobId] === true ? t('Stopping…') : t('Stop'))
            : null,
        }))),
      run.more > 0 ? h('div', { className: 'bt-genui-more' }, t('{count} more chats', { count: countText(run.more) })) : null,
      errors[`run:${run.id}`] !== undefined ? h('div', { className: 'bt-genui-foot' }, h('span', { className: 'bt-genui-error', role: 'status' }, errors[`run:${run.id}`])) : null)),
    view.moreRuns > 0 ? h('div', { className: 'bt-genui-more' }, t('Showing only {count} runs', { count: countText(view.runs.length) })) : null,
    readOnly ? h('div', { className: 'bt-genui-foot' }, readOnlyNote) : null)
  const settledNode = proposalSettled || runMissing ? h('section', { className: 'bt-q bt-genui-backfill' },
    h('div', { className: 'bt-genui-foot' },
      proposalSettled ? h('span', { className: 'bt-genui-muted' }, t('This request is no longer open.')) : null,
      runMissing ? h('span', { className: 'bt-genui-muted' }, t('This run is no longer listed.')) : null,
      readOnlyNote)) : null
  return h(Fragment, null, waitingNode, pickers, runsNode, settledNode)
}

// Plugins can check whether this kit honors proposalId and runId.
BackfillCard.binds = true

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
.bt-genui-backfill,.bt-genui-backfill-runs{max-width:560px}
.bt-genui-note{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-genui-dates{display:flex;flex-wrap:wrap;gap:10px}
.bt-genui-date-label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--bt-ink-3)}
.bt-genui-date{height:30px;padding:0 8px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;color-scheme:light}
body[data-ds-dark-theme] .bt-genui-date{color-scheme:dark}
.bt-genui-picks{display:flex;flex-direction:column;gap:1px;max-height:220px;overflow:auto;margin:0 -8px;padding:0;list-style:none}
.bt-genui-pick{min-width:0}
.bt-genui-pick-label{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 8px;border-radius:10px;cursor:pointer;font-size:13.5px;line-height:19px}
.bt-genui-pick-label:hover{background:var(--bt-hover)}
.bt-genui-pick-label input{flex:none;width:15px;height:15px;margin:0;accent-color:var(--bt-accent)}
.bt-genui-start{flex:none;height:30px;padding:0 12px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.bt-genui-start:disabled{opacity:.5;cursor:default}
.bt-genui-start:focus-visible,.bt-genui-cancel:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-genui-cancel{flex:none;height:26px;padding:0 10px;border:1px solid var(--bt-line-2);border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.bt-genui-cancel:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-genui-cancel:disabled{opacity:.5;cursor:default}
.bt-genui-action{flex:none;margin-top:1px}
.bt-genui-run{display:flex;flex-direction:column;gap:6px;min-width:0}
.bt-genui-run+.bt-genui-run{padding-top:10px;border-top:1px solid var(--bt-q-rule-2,var(--bt-line-weak))}
.bt-genui-run-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;padding:0 8px;font-size:12.5px;line-height:17px}
.bt-genui-run-range{font-weight:600;color:var(--bt-ink)}
.bt-genui-more{padding:2px 8px 0;font-size:12.5px;line-height:17px;color:var(--bt-ink-3)}
.bt-genui-error{color:var(--st-bad-strong,var(--bt-danger))}
@media (prefers-reduced-motion:reduce){.bt-genui-row[data-state=work] .bt-genui-dot{animation:none}}
body[data-bt-motion=quiet] .bt-genui-row[data-state=work] .bt-genui-dot{animation:none}
`
