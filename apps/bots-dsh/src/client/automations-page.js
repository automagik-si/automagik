import { createElement as h, Fragment, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { dateTimeLabel as when, elapsedLabel } from './text.js'

const INTRO = "Agent runs on a schedule, through the Herdr scheduler. A Bot's own scheduled tasks are under Scheduled tasks."
const ACTION_FAILURE = 'The scheduler could not do this.'
const KINDS = { prompt: 'Prompt', workflow: 'Workflow', command: 'Command' }
const STATUSES = {
  scheduled: 'Scheduled', running: 'Running', done: 'Done', failed: 'Failed',
  skipped: 'Skipped', missed: 'Missed', invalid: 'Invalid', cancelled: 'Cancelled',
}
const TRIGGERS = { cron: 'On schedule', catchup: 'Catch-up', manual: 'Manual' }
const STALE = {
  changed: 'This automation changed. Review the list and try again.',
  gone: 'This automation is already gone.',
  'not-editable': 'This automation cannot be edited here. Use the Herdr panel.',
}
const AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex']]
const WORKSPACES = [['worktree', 'A new worktree'], ['root', 'The folder itself']]
const INITIAL = { name: '', cron: '0 9 * * 1-5', repo: '', agent: 'claude', workspace: 'worktree', prompt: '', timeout_minutes: '60' }

const hint = (message, role) => h('div', { className: 'bt-set-hint', role }, message)
const requestFailure = error => error?.code === 'bot/read-only' ? 'This host can only read automations.' : ACTION_FAILURE
const statusWord = status => t(Object.hasOwn(STATUSES, status) ? STATUSES[status] : 'Unknown')
const triggerWord = trigger => Object.hasOwn(TRIGGERS, trigger) ? t(TRIGGERS[trigger]) : ''
const historyLine = run => [
  statusWord(run.status), triggerWord(run.trigger), when(run.started ?? run.at),
  run.seconds !== null ? elapsedLabel(run.seconds * 1000) : '',
  run.exitCode !== null ? t('Exit code {code}', { code: run.exitCode }) : '',
].filter(Boolean).join(' · ')

function AutomationRow({ row, invalid, capabilities, busy, formOpen, act, clearFeedback }) {
  const [confirm, setConfirm] = useState(false)
  const [history, setHistory] = useState(null)
  useEffect(() => {
    if (!confirm) return
    const timer = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(timer)
  }, [confirm])
  const binding = { name: row.removeName, rev: row.rev }
  const clearOrRemove = () => {
    clearFeedback()
    setConfirm(!confirm)
    if (confirm) void act('automations-remove', binding)
  }
  const toggleHistory = () => {
    clearFeedback()
    if (history) setHistory(null)
    else {
      setHistory({ loading: true })
      void act('automations-history', { name: binding.name }).then(result => setHistory(result ?? {}))
    }
  }
  const agent = AGENTS.find(([id]) => id === row.agent)?.[1]
  const details = invalid ? [
    t("This entry does not load. Fix it in the scheduler's file (line {line}).", { line: row.line }),
  ] : [
    [t(KINDS[row.kind]), row.disabled ? t('Disabled') : '', row.hasTarget ? t('Has a target') : ''].filter(Boolean).join(' · '),
    [row.cron, row.next ? t('Next: {time}', { time: when(row.next) }) : ''].filter(Boolean).join(' · '),
    row.repo,
    row.template ? t('Template: {name}', { name: row.template }) : [agent ? t(agent) : row.agent, row.model].filter(Boolean).join(' · '),
    row.last ? t('Last run: {run}', { run: [statusWord(row.last.status), triggerWord(capabilities?.lastTrigger), when(row.last.at)].filter(Boolean).join(' · ') }) : t('No runs yet.'),
  ].filter(Boolean)
  const label = row.name || t('Unnamed automation')
  const action = (word, aria, onClick, props) => h('button', {
    type: 'button', className: 'bt-mini', disabled: busy,
    'aria-label': t(aria, { name: label }), onClick, ...props,
  }, t(word))
  const historyLines = history?.loading ? [t('Loading…')]
    : history?.runs?.length ? history.runs.map(historyLine)
      : history ? [t(history.runs ? 'No runs yet.' : ACTION_FAILURE)] : []
  return h('div', { className: 'bt-set-row bt-task' },
    h('div', { className: 'bt-set-copy' },
      h('span', { className: 'bt-task-title', title: label }, label),
      details.map((detail, index) => h('span', { key: index, className: 'bt-set-hint' }, detail)),
      history ? h('div', { className: 'bt-set-copy', role: history.loading ? 'status' : undefined },
        historyLines.map((line, index) => h('span', { key: index, className: 'bt-set-hint' }, line))) : null),
    capabilities?.run ? h('div', { className: 'bt-actions' },
      action('Run now', 'Run {name} now', () => void act('automations-run', binding)),
      capabilities.pause ? action(row.disabled ? 'Resume' : 'Pause', row.disabled ? 'Resume {name}' : 'Pause {name}',
        () => void act('automations-pause', { ...binding, paused: !row.disabled })) : null,
      capabilities.edit && !formOpen ? action('Edit', 'Edit {name}', () => void act('automations-entry', binding)) : null,
      action('History', 'History of {name}', toggleHistory, { 'aria-expanded': history !== null })) : null,
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

function AutomationForm({ busy, cancel, put, initial = INITIAL, original, ownArgs }) {
  const [entry, setEntry] = useState(initial)
  const [answer, setAnswer] = useState(null)
  const field = name => ({
    value: entry[name],
    onChange: event => {
      setEntry({ ...entry, [name]: event.target.value })
      setAnswer(null)
    },
  })
  const select = (name, options) => h('select', { className: 'bt-select', disabled: busy || (name === 'agent' && Boolean(original)), ...field(name) },
    options.map(([value, label]) => h('option', { key: value, value }, t(label))))
  const submit = async dryRun => {
    setAnswer(null)
    const result = await put({ entry: { ...entry, timeout_minutes: Number(entry.timeout_minutes) }, dryRun, ...(original ? { original } : {}) })
    setAnswer(result)
  }
  const ready = [entry.name, entry.cron, entry.repo, entry.prompt, entry.timeout_minutes].every(value => value.trim() !== '')
  return h('form', { className: 'bt-set-card bt-task-form', onSubmit: event => { event.preventDefault(); if (ready && !busy) void submit(false) } },
    h(Field, { label: 'Name' }, h('input', { className: 'bt-bs-input', maxLength: 64, disabled: busy, ...field('name') })),
    h(Field, { label: 'Schedule (cron)' }, h('input', { className: 'bt-bs-input', disabled: busy, ...field('cron') })),
    h(Field, { label: 'Folder' }, h('input', { className: 'bt-bs-input', disabled: busy, ...field('repo') })),
    h(Field, { label: 'Agent' }, select('agent', AGENTS)),
    original ? h('div', { className: 'bt-set-row' }, hint(t('The agent can be changed in the Herdr panel.'))) : null,
    h(Field, { label: 'Runs in' }, select('workspace', WORKSPACES)),
    h(Field, { label: 'Prompt', stack: true }, h('textarea', { className: 'bt-bs-input bt-bs-area', rows: 3, maxLength: 8000, disabled: busy, ...field('prompt') })),
    h(Field, { label: 'Timeout (minutes)' }, h('input', { className: 'bt-bs-input', type: 'number', min: 1, step: 1, disabled: busy, ...field('timeout_minutes') })),
    h('div', { className: 'bt-set-row' }, hint(t(ownArgs ? 'Keeps its own agent arguments.' : "Uses the agent's own configured permissions."))),
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
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const load = async signal => {
    try {
      const result = await call('automations-list', null, signal)
      if (!signal?.aborted) setView(result)
    }
    catch { if (!signal?.aborted) setView({ message: ACTION_FAILURE }) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [])

  const clearFeedback = () => { setNotice(null); setError(null) }
  const perform = async (endpoint, payload, handle) => {
    setBusy(true)
    clearFeedback()
    try {
      const result = await call(endpoint, payload).catch(error => ({ message: requestFailure(error) }))
      if (Object.hasOwn(STALE, result.reason)) {
        if (endpoint === 'automations-put' || endpoint === 'automations-entry') setForm(null)
        await load()
        setError(STALE[result.reason])
        return null
      }
      return await handle(result)
    } finally { setBusy(false) }
  }
  const put = payload => perform('automations-put', payload, async result => {
    if (payload.original && result.message) {
      setError(result.message)
      return null
    }
    const problem = result.problem ?? result.message ?? (result.reason ? ACTION_FAILURE : undefined)
    if (payload.dryRun) return { problem, next: result.next ?? [] }
    await load()
    if (problem) return { problem }
    setForm(null)
    return null
  })
  const act = (endpoint, payload) => perform(endpoint, payload, async result => {
    if (endpoint === 'automations-history') return result
    if (result.entry) {
      setForm({ original: payload, ownArgs: result.ownArgs, initial: { ...result.entry, timeout_minutes: String(result.entry.timeout_minutes) } })
      return
    }
    if (result.requested) setNotice(t('Run requested for {name}.', { name: payload.name }))
    if (result.requested || result.done || endpoint === 'automations-remove') await load()
    if (result.message || result.reason) setError(result.message ?? ACTION_FAILURE)
  })

  const intro = h('p', { className: 'bt-set-hint' }, t(INTRO))
  let content
  if (!view) content = hint(t('Loading…'), 'status')
  else if (view.reason === 'desktop-only') content = hint(t('Automations show in the Automagik desktop app.'))
  else if (view.installed !== true) content = hint(t(view.message ?? ACTION_FAILURE), view.reason === 'not-installed' ? undefined : 'alert')
  else {
    const row = (invalid, item, index) => h(AutomationRow, {
      key: item.rev + ':' + index, row: item, invalid, busy, formOpen: form !== null, act, clearFeedback,
      capabilities: invalid ? undefined : view.details?.[index],
    })
    content = h(Fragment, null,
      !view.schedulerRunning ? hint(t('The scheduler is stopped.')) : null,
      view.paused ? hint(t('The scheduler is paused.')) : null,
      view.automations.length > 0 ? h(Section, { className: 'bt-set-places' }, view.automations.map((item, index) => row(false, item, index)))
        : hint(t('No automations yet.')),
      view.invalid.length > 0 ? h(Section, { className: 'bt-set-places', title: t('Invalid entries') }, view.invalid.map((item, index) => row(true, item, index))) : null,
      form ? h(AutomationForm, {
        key: form.original ? 'edit:' + form.original.name + ':' + form.original.rev : 'add',
        ...form, busy, cancel: () => { clearFeedback(); setForm(null) }, put,
      }) : h('div', { className: 'bt-actions' }, h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => { clearFeedback(); setForm({}) },
      }, t('Add automation'))))
  }
  return h(Fragment, null, intro, notice ? hint(notice, 'status') : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, t(error)) : null, content)
}
