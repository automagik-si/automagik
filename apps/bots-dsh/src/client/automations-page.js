import { createElement as h, Fragment, useEffect, useState } from 'react'
import { call } from './api.js'
import { language, t } from './i18n.js'

const INTRO = "Agent runs on a schedule, through the Herdr scheduler. A Bot's own scheduled tasks are under Scheduled tasks."
const ACTION_FAILURE = 'The scheduler could not do this.'
const KINDS = { prompt: 'Prompt', workflow: 'Workflow', command: 'Command' }
const STATUSES = {
  scheduled: 'Scheduled', running: 'Running', done: 'Done', failed: 'Failed',
  skipped: 'Skipped', missed: 'Missed', invalid: 'Invalid', cancelled: 'Cancelled',
}
const AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex']]
const WORKSPACES = [['worktree', 'A new worktree'], ['root', 'The folder itself']]
const INITIAL = { name: '', cron: '0 9 * * 1-5', repo: '', agent: 'claude', workspace: 'worktree', prompt: '', timeout_minutes: '60' }

const hint = (message, role) => h('div', { className: 'bt-set-hint', role }, message)
const when = value => value ? new Date(value).toLocaleString(language(), { dateStyle: 'medium', timeStyle: 'short' }) : ''
const requestFailure = error => error?.code === 'bot/read-only' ? 'This host can only read automations.' : ACTION_FAILURE

function AutomationRow({ row, invalid, busy, remove }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const timer = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(timer)
  }, [confirm])
  const clearOrRemove = () => {
    setConfirm(!confirm)
    if (confirm) void remove({ name: row.removeName, rev: row.rev })
  }
  const agent = AGENTS.find(([id]) => id === row.agent)?.[1]
  const status = Object.hasOwn(STATUSES, row.last?.status) ? STATUSES[row.last.status] : 'Unknown'
  const details = invalid ? [
    t("This entry does not load. Fix it in the scheduler's file (line {line}).", { line: row.line }),
  ] : [
    [t(KINDS[row.kind]), row.disabled ? t('Disabled') : '', row.hasTarget ? t('Has a target') : ''].filter(Boolean).join(' · '),
    [row.cron, row.next ? t('Next: {time}', { time: when(row.next) }) : ''].filter(Boolean).join(' · '),
    row.repo,
    row.template ? t('Template: {name}', { name: row.template }) : [agent ? t(agent) : row.agent, row.model].filter(Boolean).join(' · '),
    row.last ? t('Last run: {run}', { run: [t(status), when(row.last.at)].filter(Boolean).join(' · ') }) : t('No runs yet.'),
  ].filter(Boolean)
  const label = row.name || t('Unnamed automation')
  return h('div', { className: 'bt-set-row bt-task' },
    h('div', { className: 'bt-set-copy' },
      h('span', { className: 'bt-task-title', title: label }, label),
      details.map((detail, index) => h('span', { key: index, className: 'bt-set-hint' }, detail))),
    row.removeName !== undefined ? h('button', {
      type: 'button', className: 'bt-mini bt-task-remove', 'data-confirm': confirm || undefined, disabled: busy,
      'aria-label': t(confirm ? 'Confirm removing {name}' : 'Remove {name}', { name: label }), onClick: clearOrRemove,
    }, t(confirm ? 'Remove?' : 'Remove')) : null)
}

function Field({ label, stack, children }) {
  return h('label', { className: stack ? 'bt-set-row bt-bs-row bt-bs-stack' : 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t(label))),
    children)
}

function AutomationForm({ busy, cancel, put }) {
  const [entry, setEntry] = useState(INITIAL)
  const [answer, setAnswer] = useState(null)
  const field = name => ({
    value: entry[name],
    onChange: event => {
      setEntry({ ...entry, [name]: event.target.value })
      setAnswer(null)
    },
  })
  const select = (name, options) => h('select', { className: 'bt-select', disabled: busy, ...field(name) },
    options.map(([value, label]) => h('option', { key: value, value }, t(label))))
  const submit = async dryRun => {
    setAnswer(null)
    const result = await put({ entry: { ...entry, timeout_minutes: Number(entry.timeout_minutes) }, dryRun })
    setAnswer(result)
  }
  const ready = [entry.name, entry.cron, entry.repo, entry.prompt, entry.timeout_minutes].every(value => value.trim() !== '')
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: event => { event.preventDefault(); if (ready && !busy) void submit(false) } },
    h(Field, { label: 'Name' }, h('input', { className: 'bt-bs-input', maxLength: 64, disabled: busy, ...field('name') })),
    h(Field, { label: 'Schedule (cron)' }, h('input', { className: 'bt-bs-input', disabled: busy, ...field('cron') })),
    h(Field, { label: 'Folder' }, h('input', { className: 'bt-bs-input', disabled: busy, ...field('repo') })),
    h(Field, { label: 'Agent' }, select('agent', AGENTS)),
    h(Field, { label: 'Runs in' }, select('workspace', WORKSPACES)),
    h(Field, { label: 'Prompt', stack: true }, h('textarea', { className: 'bt-bs-input bt-bs-area', rows: 3, maxLength: 8000, disabled: busy, ...field('prompt') })),
    h(Field, { label: 'Timeout (minutes)' }, h('input', { className: 'bt-bs-input', type: 'number', min: 1, step: 1, disabled: busy, ...field('timeout_minutes') })),
    h('div', { className: 'bt-set-row' }, hint(t("Uses the agent's own configured permissions."))),
    answer ? h('div', { className: 'bt-set-row' },
      answer.problem ? h('span', { className: 'bt-danger bt-set-hint', role: 'alert' }, t(answer.problem))
        : hint(answer.next.length ? t('Next runs: {times}', { times: answer.next.map(when).join(' · ') }) : t('No upcoming runs.'), 'status')) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: cancel, disabled: busy }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void submit(true), disabled: busy || !ready }, t('Preview')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: busy || !ready }, t('Save'))))
}

export function AutomationsPage({ Section }) {
  const [view, setView] = useState(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const load = async signal => {
    try { setView(await call('automations-list', null, signal)) }
    catch { if (!signal?.aborted) setView({ message: ACTION_FAILURE }) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  const put = async payload => {
    setBusy(true)
    setError(null)
    try {
      const result = await call('automations-put', payload).catch(error => ({ problem: requestFailure(error) }))
      if (payload.dryRun) return { problem: result.problem ?? result.message, next: result.next ?? [] }
      await load()
      const problem = result.problem ?? result.message
      if (problem) return { problem }
      setAdding(false)
      return null
    } finally { setBusy(false) }
  }
  const remove = async payload => {
    setBusy(true)
    setError(null)
    try {
      const result = await call('automations-remove', payload).catch(error => ({ message: requestFailure(error) }))
      await load()
      if (result.reason === 'changed') setError('This automation changed. Review the list and try again.')
      else if (result.reason === 'gone') setError('This automation is already gone.')
      else if (result.message) setError(result.message)
    } finally { setBusy(false) }
  }

  const intro = h('p', { className: 'bt-set-hint' }, t(INTRO))
  let content
  if (!view) content = hint(t('Loading…'), 'status')
  else if (view.reason === 'desktop-only') content = hint(t('Automations show in the Automagik desktop app.'))
  else if (view.installed !== true) content = hint(t(view.message ?? ACTION_FAILURE), view.reason === 'not-installed' ? undefined : 'alert')
  else {
    const row = (invalid, item, index) => h(AutomationRow, { key: item.rev + ':' + index, row: item, invalid, busy, remove })
    content = h(Fragment, null,
      !view.schedulerRunning ? hint(t('The scheduler is stopped.')) : null,
      view.paused ? hint(t('The scheduler is paused.')) : null,
      error ? h('div', { className: 'bt-error', role: 'alert' }, t(error)) : null,
      view.automations.length > 0 ? h(Section, { className: 'bt-set-places' }, view.automations.map((item, index) => row(false, item, index)))
        : hint(t('No automations yet.')),
      view.invalid.length > 0 ? h(Section, { className: 'bt-set-places', title: t('Invalid entries') }, view.invalid.map((item, index) => row(true, item, index))) : null,
      adding ? h(AutomationForm, { busy, cancel: () => setAdding(false), put })
        : h('div', { className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setAdding(true) }, t('Add automation'))))
  }
  return h(Fragment, null, intro, content)
}
