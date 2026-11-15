import { approvalDetail } from './approvals.js'
import { openStops, stopLine } from './stops.js'
import { createElement as h, Fragment, useEffect, useState } from 'react'
import { t, hostText } from './i18n.js'

// A task a Bot handed on (start_task, agents.js): it shows itself working, where the user
// can watch, then what it found.

// Now, once a second, while `on`.
function useNow(on) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

const duration = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Running tasks a Bot started, from the team view (`roster.tasks`, agents.js), newest first.
export const runningTasksOf = (roster, botId) => Object.entries(roster.tasks ?? {})
  .filter(([, task]) => task.from === botId && task.status === 'working')
  .map(([sessionId, task]) => ({ sessionId, ...task }))
  .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))

const ENDED_SHOWN = 3
const ENDED_FOR_MS = 6 * 60 * 60 * 1000
export const endOf = task => task.endedAt ?? task.at ?? 0

// The ended tasks the Live rail lists, newest end first: a Bot's, three at most, six hours
// at most.
export const railEnded = (roster, now) => Object.entries(roster?.tasks ?? {})
  .filter(([, task]) => roster.byId?.[task.from] !== undefined && task.status !== 'working' && now - endOf(task) < ENDED_FOR_MS)
  .sort(([, a], [, b]) => endOf(b) - endOf(a))
  .slice(0, ENDED_SHOWN)

// The Sessions a DSH bot's row lists: all of a DSH bot's. Of the tasks record, what the
// sidebar has no other place for: a Session with no record, a task whose Bot is gone and,
// given the clock, an ended task the rail no longer lists. A Bot's threads are its running
// tasks, so without that last one a stopped task is in no list at all (#164).
export const agentRowSessions = (agent, roster, now) => {
  if (agent.kind !== 'tasks') return agent.sessions
  const inRail = new Set(now === undefined ? [] : railEnded(roster, now).map(([id]) => id))
  return agent.sessions.filter((id) => {
    const task = roster?.tasks?.[id]
    if (roster?.byId?.[task?.from] === undefined) return true
    return now !== undefined && task.status !== 'working' && !inRail.has(id)
  })
}

// Whether a task's Session waits for the user: DSH's approval or question card is up there,
// or the team's host noted an approval the task waits on (approvals.js `taskId`).
export const waitsForUser = (status, sessionId) => sessionId != null && status?.get(sessionId)?.pendingInteraction !== undefined
export const approvalFor = (work, sessionId) => sessionId != null && (work?.approvals ?? []).some(entry => entry.taskId === sessionId)

// A task's state for its card and its thread in the sidebar: working, waiting (for the
// user), done or failed.
export const taskState = (task, waiting) => {
  const status = task?.status ?? 'working'
  return status === 'working' && waiting ? 'waiting' : status
}

// What an ended task says on its card and in its Bot's chat: a failed one names why.
export const endLabel = (task) => {
  if (task?.status === 'failed') {
    const reason = String(task.summary ?? '').split('\n')[0].trim()
    return reason ? t('Failed: {reason}', { reason }) : t('Failed')
  }
  return task?.status === 'stopped' ? t('Stopped') : t('Task finished')
}

export function TaskCard({ sessionId, title, task, onOpen, useSessionStatus, useWork }) {
  // The start_task call has no Session id until its result names one, and the card is drawn
  // again when it arrives. The hooks are read every render, with a null id before then, so
  // that second render keeps the hook order the first one set.
  const taskId = sessionId ?? null
  const asked = useSessionStatus ? useSessionStatus(map => waitsForUser(map, taskId)) : false
  // The approval itself, not just whether one waits: its `answer` settles the one request
  // DSH holds for the task, so this card and the task's own prompt are two views of one
  // decision, never two decisions.
  const pending = useSessionStatus ? useSessionStatus(map => map.get(taskId)?.pendingInteraction) : undefined
  const ask = pending?.kind === 'approval' && typeof pending.answer === 'function' ? pending : undefined
  const approval = useWork ? useWork(work => approvalFor(work, taskId)) : false
  // What the card's buttons answer is the ask DSH shows, so the command named is that ask's own;
  // without one, the task's single waiting ask. Two at once and none named: the card cannot say
  // which the person would be answering.
  const askCall = ask?.callId
  const detail = useWork ? useWork(work => {
    const mine = (work.approvals ?? []).filter(entry => entry.taskId === taskId)
    const entry = askCall !== undefined ? mine.find(item => item.sessionId === taskId && item.callId === askCall) : ask === undefined && mine.length === 1 ? mine[0] : undefined
    return entry ? approvalDetail(entry) : ''
  }) : ''
  const stop = useWork ? useWork(work => {
    const entry = taskId === null ? undefined : openStops(work).filter(item => item.taskId === taskId).sort((a, b) => b.at - a.at)[0]
    return entry ? stopLine(entry) : ''
  }) : ''
  const waiting = asked || approval
  const status = taskState(task, waiting)
  const working = status === 'working' || status === 'waiting'
  const now = useNow(working)
  const started = task?.at ?? now
  const elapsed = (task?.endedAt ?? now) - started
  const [answering, setAnswering] = useState(false)
  const answer = (choice) => {
    if (answering || ask?.answerable === false) return
    setAnswering(true)
    void Promise.resolve(ask.answer(choice)).catch(() => {}).finally(() => setAnswering(false))
  }
  return h('section', { className: 'op-task', 'data-state': status, 'aria-busy': answering || undefined },
    h('div', { className: 'op-task-in' },
      h('div', { className: 'op-task-head' },
        h('span', { className: 'op-task-mark', 'aria-hidden': true },
          status === 'waiting' ? h('span', { className: 'op-task-wait' })
            : working ? h('span', { className: 'op-orbit' }, h('i'), h('i'), h('i'))
            : status === 'done' ? h('svg', { viewBox: '0 0 20 20', width: 18, height: 18 }, h('path', { d: 'M5 10.5l3.2 3L15 6.5', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
              : h('svg', { viewBox: '0 0 20 20', width: 16, height: 16 }, h('path', { d: 'M6 6l8 8M14 6l-8 8', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }))),
        h('div', { className: 'op-task-titles' },
          h('span', { className: 'op-task-kicker' }, status === 'waiting' ? t('Waiting for you') : working ? t('Task running') : endLabel(task)),
          h('strong', { className: 'op-task-title' }, title)),
        h('span', { className: 'op-task-time' }, duration(elapsed))),
      status === 'waiting'
        ? ask
          ? h('div', { className: 'op-task-ask' },
              h('span', { className: 'op-task-ask-text' }, ask.toolName === 'keep_working' ? hostText(ask.reason) : t('Task {title} is waiting for approval: {tool}', { title, tool: ask.toolName || t('a tool') })),
              h('span', { className: 'op-task-ask-actions' },
                h('button', { type: 'button', className: 'op-task-ask-btn', disabled: answering || ask.answerable === false, onClick: () => answer('rejected') }, t('Reject')),
                h('button', { type: 'button', className: 'op-task-ask-allow', disabled: answering || ask.answerable === false, onClick: () => answer('allowed-once') }, t('Allow once'))))
          : h('div', { className: 'op-task-live' }, h('span', { className: 'op-task-said' }, t('It asks for your OK. Open it to answer.')))
        : working ? h(Fragment, null,
          h('div', { className: 'op-task-live' },
            stop || task?.said ? h('span', { key: stop || task.said, className: 'op-task-said' }, stop || task.said)
              : h('span', { className: 'op-task-said op-task-quiet' }, t('Getting started…')),
            task?.steps ? h('span', { className: 'op-task-steps' }, t('step {count}', { count: task.steps })) : null),
          h('div', { className: 'op-task-bar', 'aria-hidden': true }, h('i')))
          : task?.summary ? h('p', { className: 'op-task-summary' }, task.summary) : null,
      status === 'waiting' && detail ? h('span', { className: 'op-task-said' }, detail) : null,
      sessionId ? h('button', { type: 'button', className: 'op-task-open', onClick: onOpen }, ask ? t('Open task') : status === 'waiting' ? t('Answer it') : working ? t('Watch it work') : t('Open task'), ' →') : null))
}

export const TASK_CSS = `
@property --op-angle{syntax:'<angle>';inherits:false;initial-value:0deg}
@keyframes op-spin{to{--op-angle:360deg}}
@keyframes op-card-in{from{opacity:0;transform:translateY(8px) scale(.985);filter:blur(3px)}}
@keyframes op-pop{from{transform:scale(0)}}
@keyframes op-row-in{from{opacity:0;transform:translateY(6px);filter:blur(2px)}}
.op-task{position:relative;max-width:640px;padding:1.5px;border-radius:20px;background:conic-gradient(from var(--op-angle),color-mix(in srgb,var(--bt-accent) 30%,transparent),var(--bt-accent),#a78bfa,#f472b6,color-mix(in srgb,var(--bt-accent) 30%,transparent));animation:op-card-in .45s cubic-bezier(.2,.8,.2,1),op-spin 3s linear infinite}
.op-task[data-state=done]{background:linear-gradient(135deg,#00c972,color-mix(in srgb,#00c972 30%,var(--bt-line)));animation:op-card-in .45s cubic-bezier(.2,.8,.2,1)}
.op-task[data-state=failed]{background:color-mix(in srgb,#e5484d 50%,var(--bt-line));animation:none}
.op-task[data-state=stopped]{background:var(--bt-line);animation:none}
.op-task[data-state=waiting]{background:linear-gradient(135deg,var(--bt-gold),color-mix(in srgb,var(--bt-gold) 30%,var(--bt-line)));animation:op-card-in .45s cubic-bezier(.2,.8,.2,1)}
.op-task[data-state=waiting] .op-task-mark{background:color-mix(in srgb,var(--bt-gold) 18%,transparent)}
.op-task-wait{width:12px;height:12px;border-radius:50%;corner-shape:round;background:var(--bt-gold);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-gold) 22%,transparent)}
.op-task-in{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:18.5px;background:var(--bt-card)}
.op-task-head{display:flex;align-items:center;gap:12px;min-width:0}
.op-task-mark{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent)}
.op-task[data-state=done] .op-task-mark{background:#00c972;color:#fff;animation:op-pop .55s cubic-bezier(.3,1.6,.5,1)}
.op-task[data-state=failed] .op-task-mark{background:#e5484d;color:#fff}
.op-orbit{position:relative;width:20px;height:20px;animation:op-turn 1.1s linear infinite}
.op-orbit i{position:absolute;width:6px;height:6px;border-radius:50%;background:currentColor}
.op-orbit i:nth-child(1){top:0;left:7px}
.op-orbit i:nth-child(2){bottom:2px;left:1px;opacity:.6}
.op-orbit i:nth-child(3){bottom:2px;right:1px;opacity:.3}
@keyframes op-turn{to{transform:rotate(360deg)}}
.op-task-titles{display:flex;flex-direction:column;flex:1;min-width:0}
.op-task-kicker{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--bt-ink-3);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.op-task-title{font-size:14.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.op-task-time{flex:none;font-size:13px;font-variant-numeric:tabular-nums;color:var(--bt-ink-2)}
.op-task-live{display:flex;align-items:baseline;gap:10px;min-width:0;font-size:13px}
.op-task-ask{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.op-task-ask-text{flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op-task-ask-actions{flex:none;display:flex;gap:8px}
.op-task-ask-btn,.op-task-ask-allow{height:28px;padding:0 12px;border:1px solid var(--bt-line-2);border-radius:999px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.op-task-ask-allow{border-color:transparent;background:var(--bt-accent);color:var(--bt-accent-ink)}
.op-task-ask :is(button:disabled){opacity:.6;cursor:default}
.op-task-said{flex:1;min-width:0;color:var(--bt-ink-2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;animation:op-row-in .4s ease both}
.op-task-quiet{color:var(--bt-ink-3)}
.op-task-steps{flex:none;font-size:11.5px;color:var(--bt-ink-3)}
.op-task-bar{position:relative;height:3px;border-radius:2px;overflow:hidden;background:var(--bt-hover)}
.op-task-bar i{position:absolute;top:0;bottom:0;width:35%;border-radius:2px;background:linear-gradient(90deg,transparent,var(--bt-accent),#a78bfa,transparent);animation:op-slide 1.4s ease-in-out infinite}
@keyframes op-slide{from{left:-35%}to{left:100%}}
.op-task-summary{margin:0;font-size:13.5px;line-height:20px;color:var(--bt-ink);display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;animation:op-row-in .45s ease both}
.op-task-open{align-self:flex-start;padding:0;border:0;background:none;color:var(--bt-accent);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.op-task-open:hover{text-decoration:underline;text-underline-offset:3px}
@media (prefers-reduced-motion:reduce){.op-task,.op-task-said,.op-task-summary,.op-orbit,.op-task-bar i{animation:none!important}}
body[data-bt-motion=quiet] :is(.op-task,.op-task-said,.op-task-summary,.op-orbit,.op-task-bar i){animation:none!important}
`
