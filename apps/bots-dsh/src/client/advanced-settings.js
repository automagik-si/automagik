import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

export const countText = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString() : t('Unknown')
export const statsRows = scope => scope ? [{ label: t('All-in'), totals: scope.allIn }, ...Object.entries(scope.byKind ?? {}).map(([label, totals]) => ({ label, totals }))] : []
export function contextSummary(context) {
  if (!context) return t('Loading…')
  return context.usage?.tokens == null ? t('Unavailable') : `${countText(context.usage.tokens)} ${t('tokens')} · ${t(context.usage.source)}`
}

// Empty resets an override; bad numbers never leave the input as a mutation.
function NumberSetting({ label, value, min, max, integer = false, disabled, onSave }) {
  const [draft, setDraft] = useState(String(value ?? ''))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setDraft(String(value ?? '')); setInvalid(false) }, [value])
  const commit = event => {
    const next = draft.trim() === '' ? null : Number(draft)
    const valid = next === null || (Number.isFinite(next) && next >= min && next <= max && (!integer || Number.isSafeInteger(next)))
    setInvalid(!valid)
    if (valid && next !== value) void onSave(next)
    if (!valid) event.currentTarget.setCustomValidity(t('Choose a number within the displayed limits.'))
    else event.currentTarget.setCustomValidity('')
  }
  return h('input', { type: 'number', className: 'bt-bs-input bt-bs-num', 'aria-label': label, 'aria-invalid': invalid, value: draft, min, max, step: integer ? 1 : 'any', disabled,
    onChange: event => { setDraft(event.target.value); setInvalid(false); event.currentTarget.setCustomValidity('') }, onBlur: commit,
    onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(value ?? '')); setInvalid(false) } },
  })
}

const COLUMNS = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write'], ['calls', 'Calls'], ['attempts', 'Attempts'], ['retries', 'Retries']]
const SCOPES = [['lastRequest', 'Last request'], ['lastTurn', 'Last turn'], ['session', 'Current Session'], ['bot', 'Bot total']]

function Statistics({ stats }) {
  const [scopeName, setScopeName] = useState('session')
  const scope = stats?.scopes?.[scopeName]
  return h('div', { className: 'bt-advanced-stats' },
    h('label', { className: 'bt-advanced-select' }, t('Stats scope'), ' ', h('select', { 'aria-label': t('Stats scope'), value: scopeName, onChange: event => setScopeName(event.target.value) }, SCOPES.map(([id, label]) => h('option', { key: id, value: id }, t(label))))),
    !stats ? h('p', { className: 'bt-set-hint' }, t('Loading…')) : !scope ? h('p', { className: 'bt-set-hint' }, t('No attributable attempts recorded for this scope.')) : h('div', { className: 'bt-advanced-table' },
      h('table', null, h('caption', { className: 'bt-sr' }, t('Recorded model attempts')), h('thead', null, h('tr', null, h('th', null, t('Use')), COLUMNS.map(([key, label]) => h('th', { key, scope: 'col' }, t(label))))),
        h('tbody', null, statsRows(scope).map(({ label, totals }) => h('tr', { key: label }, h('th', { scope: 'row' }, label), COLUMNS.map(([key]) => h('td', { key }, countText(totals?.[key])))))))),
    ...(scope?.byProvider ?? []).map((provider, index) => h('p', { key: `${provider.provider}:${provider.semantics}:${index}`, className: 'bt-set-hint' },
      `${provider.provider || t('Unknown provider')} · `, provider.cacheRatio
        ? `${t('Cache reads')} ${(provider.cacheRatio.ratio * 100).toFixed(1)}% (${countText(provider.cacheRatio.read)} / ${countText(provider.cacheRatio.prompt)} ${t('prompt tokens')}; ${provider.semantics})`
        : t('Cache ratio unavailable: missing fields or incompatible normalization.'))),
    h('p', { className: 'bt-set-hint' }, t('Input is reported input; unknown is not zero. Cache ratios use compatible prompt-token denominators, separately by provider.')),
    h('p', { className: 'bt-set-hint' }, t('Request and turn scopes include attributable attempts only. Unlinked memory, steward, checkpoint, handoff and child overhead remain in Session or Bot totals. Scopes overlap; do not add them together.')),
    stats?.coverage?.status !== 'complete' && stats ? h('p', { role: 'status', className: 'bt-set-hint' }, stats.scanning ? t('Accounting refresh in progress; totals may be incomplete.') : t('Partial accounting: some Session history could not be read.')) : null,
    h('p', { className: 'bt-set-hint' }, t('Tokens and attempts only. Cache efficiency is not task success; no cost, timing or native-DSH effectiveness comparison is inferred.')))
}

// The snapshot key blocks even one rendered frame of another Bot's private figures.
// Reads refresh derived accounting only; no timer performs a model call or checkpoint.
export function AdvancedSettings({ bot, roster, actions, save, Card, Row, SwitchRow }) {
  const sessionId = bot.sessionId ?? bot.id
  const key = `${bot.id}:${sessionId}`
  const [snapshot, setSnapshot] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [confirmFresh, setConfirmFresh] = useState(false)
  const reading = useRef(null)
  useEffect(() => {
    setError(''); setConfirmFresh(false)
    if (bot.advanced !== true) return undefined
    let current = true
    let sequence = 0
    const read = () => {
      // Slow ledger scans never accumulate overlapping polls or a timer backlog.
      if (reading.current !== null) return
      const request = ++sequence
      const job = Promise.resolve()
        .then(() => Promise.all([actions.contextStatus(bot.id), actions.usageStats(bot.id, sessionId), actions.memoryReviewStatus(bot.id)]))
        .then(([context, stats, memory]) => {
          if (current && request === sequence) { setSnapshot({ key, context, stats, memory }); setError('') }
        }, failure => { if (current && request === sequence) setError(failure?.message ?? String(failure)) })
        .finally(() => { if (reading.current === job) reading.current = null })
      reading.current = job
    }
    // A Bot/part switch waits for the previous read, then only the current effect
    // may start one replacement; ordinary timer ticks are skipped while busy.
    if (reading.current) void reading.current.then(() => { if (current) read() })
    else read()
    const timer = setInterval(read, 5000)
    return () => { current = false; clearInterval(timer) }
  }, [key, bot.advanced, bot.contextCheckRatio, bot.contextRecentTokens, bot.memoryReview, refresh])
  const shown = snapshot?.key === key ? snapshot : null
  const context = shown?.context
  const memory = shown?.memory
  const readOnly = Boolean(roster.readOnly) || context?.readOnly === true
  const mutate = async operation => {
    setPending(true); setError('')
    try { await operation(); setConfirmFresh(false); setRefresh(value => value + 1) }
    catch (failure) { setError(failure?.message ?? String(failure)) }
    finally { setPending(false) }
  }
  const disabled = pending || readOnly || !context
  return h('div', { className: 'bt-advanced' },
    h(Card, { title: t('Advanced') }, h(SwitchRow, { label: t('Advanced Bot'), hint: t('Show supported native DSH controls, Context and Stats for this Bot. This switch changes visibility only, not permissions, model access or context policy.'), on: bot.advanced === true, disabled: Boolean(roster.readOnly), onChange: advanced => save({ advanced }) })),
    bot.advanced !== true ? null : h('div', { className: 'bt-advanced-body' },
      error ? h('p', { role: 'alert', className: 'bt-advanced-error' }, error) : null,
      h(Card, { title: t('Context') },
        h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' }, h('strong', { 'data-context-usage': true }, contextSummary(context)),
          h('span', { className: 'bt-set-hint' }, `${t('Current part')} ${countText(context?.counts?.parts)} · ${t('Checkpoints')} ${countText(context?.counts?.checkpoints)}`),
          h('span', { className: 'bt-set-hint' }, context?.lines ? `${t('Usable window')}: ${countText(context.lines.usable)} · ${t('Check line')}: ${countText(context.lines.check)} · ${t('Hard safety')}: ${countText(context.lines.hard)} (95%)` : t('Effective model window is unavailable until a request header is known.'))),
        h(Row, { label: t('Check at (% usable window)'), hint: t('Per-Bot override. Default 80%; must stay below the protected 95% hard line.') }, h(NumberSetting, { label: t('Check at (% usable window)'), value: (bot.contextCheckRatio ?? context?.policy?.checkRatio ?? 0.8) * 100, min: 0.01, max: 94.99, disabled, onSave: value => save({ contextCheckRatio: value === null ? null : value / 100 }) })),
        h(Row, { label: t('Recent-message carry budget'), hint: t('Token budget for protected recent messages in checkpoints and handoffs; the effective budget is also capped by the check line.') }, h(NumberSetting, { label: t('Recent-message carry budget'), value: bot.contextRecentTokens ?? context?.policy?.recentTokens ?? 16384, min: 1, max: Number.MAX_SAFE_INTEGER, integer: true, disabled, onSave: contextRecentTokens => save({ contextRecentTokens }) })),
        h('div', { className: 'bt-set-row bt-bs-row bt-advanced-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: () => save({ contextCheckRatio: null, contextRecentTokens: null }) }, t('Use context defaults')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: disabled || !context?.canCheckpoint || context.sessionId !== sessionId, title: context?.checkpointReason ?? undefined, onClick: () => { void mutate(() => actions.checkpointBot(bot.id, sessionId)) } }, t('Checkpoint now')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: disabled || !context || Boolean(context.markers?.checking || context.markers?.condensing || context.markers?.switching) || context.status !== 'idle', onClick: () => { if (!confirmFresh) setConfirmFresh(true); else void mutate(() => actions.freshConversation(bot.id)) } }, confirmFresh ? t('Confirm new part') : t('Start new part'))),
        context?.checkpointReason ? h('p', { className: 'bt-set-hint bt-advanced-note' }, context.checkpointReason) : null,
        h('p', { className: 'bt-set-hint bt-advanced-note' }, confirmFresh ? t('Start new part carries nothing from this part. Earlier history remains searchable. Click Confirm new part to continue.') : t('Checkpoint now condenses this part while keeping protected recent messages. Start new part is separate and carries nothing. Native manual compaction is unavailable for Bot-managed Sessions.'))),
      h(Card, { title: t('Memory review') },
        h(SwitchRow, { label: t('Automatic memory review'), hint: t('Reviews this Bot’s own chat after idle turns. Independent of context compaction; no fixed ordering is promised.'), on: memory?.enabled === true, disabled: disabled || !memory?.allowed, onChange: memoryReview => save({ memoryReview }) }),
        h('p', { className: 'bt-set-hint bt-advanced-note', role: 'status' }, !memory ? t('Loading…') : !memory.allowed ? t('Automatic memory review is disabled by the host configuration.') : memory.running ? t('Memory review running. Disabling review prevents future passes; this pass may finish.') : memory.pending ? t('Memory review pending.') : memory.enabled ? t('Memory review idle.') : t('Automatic memory review is off for this Bot.'))),
      h(Card, { title: t('Stats') }, h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' }, h(Statistics, { stats: shown?.stats }), h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setRefresh(value => value + 1), disabled: pending }, t('Refresh stats'))))))
}

export const ADVANCED_SETTINGS_CSS = `
.bt-advanced,.bt-advanced-body{display:flex;flex-direction:column;gap:18px;min-width:0}
.bt-advanced-actions{gap:8px;flex-wrap:wrap}.bt-advanced-note{margin:0;padding:10px 14px}
.bt-advanced-error{color:var(--st-bad-strong,var(--bt-danger));font-size:13px}.bt-advanced-stats{width:100%;min-width:0}
.bt-advanced-select{display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px}
.bt-advanced-select select{max-width:100%;background:var(--bt-main);color:var(--bt-ink);border:1px solid var(--bt-line);border-radius:6px;padding:4px}
.bt-advanced-table{max-width:100%;overflow-x:auto}.bt-advanced-table table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
.bt-advanced-table th,.bt-advanced-table td{padding:5px 6px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--bt-line)}
.bt-advanced-table th:first-child{text-align:left}.bt-advanced-table tbody tr:first-child{font-weight:600}
.bt-advanced-stats p{margin:10px 0 0;overflow-wrap:anywhere}
`
