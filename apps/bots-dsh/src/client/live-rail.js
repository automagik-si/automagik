import { answerGroup, approvalDetail, approvalWhere, groupApprovals, nativeAsk } from './approvals.js'
import { openStops, stopLine } from './stops.js'
import { createElement as h, useEffect, useState } from 'react'
import { BotMark } from './mark.js'
import { workPhrase } from './cells.js'
import { endLabel, endOf, railEnded } from './task-card.js'
import { hostText, t } from './i18n.js'

// -------------------------------------------------------------------------
// Live content belongs to the native tab: the sidebar owns all geometry and focus.
export function LiveTab({ useRoster, ...props }) {
  const roster = useRoster(value => value)
  return h(LiveRail, { ...props, roster })
}

/** What the rail lists, from the work snapshot and the roster: { needs, working, ended }. */
export function liveOf(work, roster, now = Date.now()) {
  const byId = roster?.byId ?? {}
  const roomsById = roster?.roomsById ?? {}
  const tasks = roster?.tasks ?? {}
  const needs = groupApprovals((work?.approvals ?? []).filter(entry => byId[entry.botId]))
    .map(({ entries }) => {
      const entry = entries[0]
      const detail = approvalDetail(entry)
      const item = {
        key: `ask:${entry.id}`,
        bot: byId[entry.botId],
        place: entry.roomId ? roomsById[entry.roomId]?.name : tasks[entry.taskId]?.title ?? entry.label,
        tool: entry.tool,
        ...(entry.child ? { line: t('A subagent wants to use {tool}', { tool: entry.tool }) }
          : detail && entry.tool !== 'keep_working' ? { line: `${t('Wants to use {tool}', { tool: entry.tool })} · ${detail}` } : {}),
        open: entry.taskId ?? entry.roomId ?? entry.botId,
        count: entries.length,
        entries,
        detail,
      }
      if (entries.length === 1) return item
      const places = [...new Set(entries.map(entry => approvalWhere(entry, roster)).filter(Boolean))]
      // Merged asks share their reason and target (approvals.js), so the card shows all of both.
      return { ...item, places, place: places.join(', '), reason: entry.reason ?? '',
        line: t('{count} requests to use {tool}', { count: entries.length, tool: entry.tool }) }
    })
  for (const entry of openStops(work)) {
    if (!byId[entry.botId]) continue
    needs.push({ key: `stop:${entry.id}`, bot: byId[entry.botId], place: roomsById[entry.roomId]?.name ?? tasks[entry.taskId]?.title ?? entry.label,
      line: stopLine(entry), open: entry.taskId ?? entry.roomId ?? entry.botId, face: 'idle' })
  }
  const waitingTasks = new Set((work?.approvals ?? []).map(entry => entry.taskId).filter(Boolean))
  const working = []
  for (const [id, doing] of Object.entries(work?.bots ?? {})) {
    if (byId[id] && doing) working.push({ key: `bot:${id}`, bot: byId[id], phrase: workPhrase(doing), open: doing.roomId ?? id })
  }
  for (const [roomId, entries] of Object.entries(work?.rooms ?? {})) {
    for (const doing of entries ?? []) {
      if (!byId[doing.botId] || working.some(entry => entry.key === `bot:${doing.botId}`)) continue
      working.push({ key: `room:${roomId}:${doing.botId}`, bot: byId[doing.botId], phrase: workPhrase(doing), place: roomsById[roomId]?.name, open: roomId })
    }
  }
  for (const [sessionId, task] of Object.entries(tasks)) {
    const bot = byId[task.from]
    if (bot && task.status === 'working' && !waitingTasks.has(sessionId)) {
      working.push({ key: `task:${sessionId}`, bot, phrase: task.title ?? t('Task'), task: true, at: task.at, open: sessionId })
    }
  }
  const ended = railEnded(roster, now).map(([sessionId, task]) => ({
    key: `end:${sessionId}`, bot: byId[task.from], title: task.title ?? t('Task'), status: task.status, label: endLabel(task), at: endOf(task), open: sessionId,
  }))
  return { needs, working, ended }
}

/** The line under the rail's title: "1 needs you · 2 working", "nothing working". */
export function liveSummary({ needs, working }) {
  const parts = []
  const count = needs.reduce((sum, item) => sum + (item.count ?? 1), 0)
  if (count > 0) parts.push(t('{count} needs you', { count }))
  parts.push(working.length > 0 ? t('{count} working', { count: working.length }) : t('nothing working'))
  return parts.join(' · ')
}

const since = (at, now) => {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  return minutes < 1 ? t('just now') : minutes < 60 ? t('{count} min', { count: minutes }) : t('{count} h', { count: Math.round(minutes / 60) })
}

function Entry({ item, tone, line, actions }) {
  return h('button', { type: 'button', className: `bt-live-card${tone ? ` bt-live-${tone}` : ''}`, onClick: () => actions.openSession(item.open) },
    h('span', { className: 'bt-live-face' }, h(BotMark, { bot: item.bot, size: 28, state: item.face ?? (tone === 'need' ? 'alert' : tone === 'work' ? 'working' : 'idle') })),
    h('span', { className: 'bt-live-text' },
      h('span', { className: 'bt-live-name' }, item.bot.name, item.place ? h('span', { className: 'bt-live-place' }, ` · ${item.place}`) : null),
      h('span', { className: 'bt-live-line' }, line)),
    h('span', { className: 'bt-live-go' }, t('Open')))
}

function GroupEntry({ item, actions, statusMap }) {
  const [answering, setAnswering] = useState(false)
  // All or nothing: a decision on the card is a decision on every ask it counts. When one of
  // them cannot be answered from this window, the card only opens.
  const canAnswer = item.entries.every(entry => entry.answerable || nativeAsk(statusMap, entry))
  const answer = async choice => {
    if (answering) return
    setAnswering(true)
    try { await answerGroup(item.entries, choice, { actions, statusMap }) }
    finally { setAnswering(false) }
  }
  const what = [item.line, item.detail].filter(Boolean).join(' · ')
  return h('div', { className: 'bt-live-card bt-live-need', role: 'group', 'aria-label': `${item.bot.name} · ${what}`, 'aria-busy': answering || undefined },
    h('span', { className: 'bt-live-face' }, h(BotMark, { bot: item.bot, size: 28, state: 'alert' })),
    h('span', { className: 'bt-live-text' },
      h('span', { className: 'bt-live-name' }, item.bot.name, item.place ? h('span', { className: 'bt-live-place' }, ` · ${item.place}`) : null),
      h('span', { className: 'bt-live-line' }, item.line),
      item.reason && item.reason !== item.detail ? h('span', { className: 'bt-live-line' }, hostText(item.reason)) : null,
      item.detail ? h('span', { className: 'bt-live-line' }, item.detail) : null),
    h('div', { className: 'bt-q-foot' },
      canAnswer ? h('button', { type: 'button', className: 'bt-q-btn', disabled: answering, 'aria-label': `${t('Reject')} · ${what}`, onClick: () => answer('reject') }, t('Reject')) : null,
      canAnswer ? h('button', { type: 'button', className: 'bt-q-submit', disabled: answering, 'aria-label': `${t('Allow once')} · ${what}`, onClick: () => answer('allow') }, t('Allow once')) : null,
      h('button', { type: 'button', className: 'bt-live-go', onClick: () => actions.openSession(item.open) }, t('Open'))))
}

function Section({ label, dot, children, empty }) {
  return h('section', { className: 'bt-live-sec' },
    h('h3', { className: `bt-live-label bt-live-dot-${dot}` }, h('i', { 'aria-hidden': true }), label),
    children.length > 0 ? children : h('p', { className: 'bt-live-empty' }, empty))
}

export function LiveRail({ roster, actions, useWork, useSessionStatus }) {
  const statusMap = useSessionStatus?.(map => map) ?? new Map()
  const work = useWork(value => value)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const live = liveOf(work, roster, now)
  return h('aside', { className: 'bt-live', 'aria-label': t('Live') },
    h('div', { className: 'bt-live-top' },
      h('h2', { className: 'bt-live-title' }, t('Live')),
      h('span', { className: 'bt-live-sum' }, liveSummary(live))),
    h(Section, { label: t('Needs you'), dot: 'need', empty: t('Nothing waiting for you.') },
      live.needs.map(item => item.count > 1 ? h(GroupEntry, { key: item.key, item, actions, statusMap }) : h(Entry, { key: item.key, item, tone: 'need', actions, line: item.line ?? (item.tool ? t('Wants to use {tool}', { tool: item.tool }) : t('Waiting for your answer')) }))),
    h(Section, { label: t('Working'), dot: 'work', empty: t('Nothing running right now.') },
      live.working.map(item => h(Entry, { key: item.key, item, tone: 'work', actions, line: item.task && item.at ? `${item.phrase} · ${since(item.at, now)}` : item.phrase }))),
    live.ended.length > 0
      ? h(Section, { label: t('Just finished'), dot: 'done', empty: '' },
          live.ended.map(item => h(Entry, { key: item.key, item, tone: item.status === 'failed' ? 'bad' : 'done', actions, line: `${item.title} · ${item.label}` })))
      : null,
    h('section', { className: 'bt-live-sec' },
      h('h3', { className: 'bt-live-label' }, t('Automations')),
      h('button', { type: 'button', className: 'bt-live-card', onClick: () => actions.openSettings('schedules') },
        h('span', { className: 'bt-live-text' },
          h('span', { className: 'bt-live-name' }, t('Scheduled tasks')),
          h('span', { className: 'bt-live-line' }, t('What runs on a schedule or a trigger'))),
        h('span', { className: 'bt-live-go' }, t('Open')))))
}

export const LIVE_CSS = `
.bt-live{box-sizing:border-box;width:100%;height:100%;min-width:0;display:flex;flex-direction:column;gap:6px;padding:20px;overflow-y:auto;background:var(--bt-main);font-family:var(--bt-font);color:var(--bt-ink)}
.bt-live-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.bt-live-title{font:var(--bt-weight-title,700) 20px/26px var(--bt-head-font,var(--bt-font));letter-spacing:-.01em;margin:0}
.bt-live-sum{font-size:12px;line-height:16px;color:var(--bt-ink-2);text-align:right}
.bt-live-sec{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.bt-live-label{display:flex;align-items:center;gap:6px;margin:6px 0 0;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-live-label i{display:none;width:7px;height:7px;border-radius:50%}
.bt-live-dot-need i{display:block;background:var(--st-warndot,var(--bt-accent));box-shadow:0 0 0 3px color-mix(in srgb,var(--st-warndot,var(--bt-accent)) 22%,transparent)}
.bt-live-dot-work i{display:block;background:var(--st-work,var(--bt-accent))}
.bt-live-dot-done i{display:block;background:var(--st-okdot,var(--bt-green))}
.bt-live-empty{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-live-card{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border:1px solid var(--bt-line-2);border-radius:16px;background:var(--bt-sidebar);color:inherit;font:inherit;text-align:left;cursor:pointer}
div.bt-live-card.bt-live-need{flex-wrap:wrap;cursor:default}
div.bt-live-card.bt-live-need>.bt-q-foot{flex-basis:100%;align-items:center}
div.bt-live-card .bt-live-name{white-space:normal}
div.bt-live-card .bt-live-line{display:block;overflow:visible;overflow-wrap:anywhere;white-space:pre-wrap}
div.bt-live-card .bt-live-go{padding:0 4px;border:0;background:none;font:inherit;font-weight:600;cursor:pointer}
.bt-live-card:hover{background:var(--bt-card)}
.bt-live-need{border-color:color-mix(in srgb,var(--st-warndot,var(--bt-accent)) 60%,transparent);background:var(--bt-card)}
.bt-live-bad .bt-live-line{color:var(--st-bad-strong,var(--bt-danger))}
.bt-live-face{flex:none;display:grid;place-items:center;width:32px;height:32px}
.bt-live-text{flex:1;min-width:0;display:flex;flex-direction:column}
.bt-live-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-live-place{font-weight:500;color:var(--bt-ink-2)}
.bt-live-line{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bt-live-go{flex:none;font-weight:600;color:var(--bt-accent)}
`
