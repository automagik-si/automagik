import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { t, hostText, hostTemplateOf } from './i18n.js'

// -------------------------------------------------------------------------
// The approval card for the team's own tools, in place of DSH's (whose text is the call's
// raw arguments when a Claude Code chat asks through its MCP bridge, `mcp__dsh__<name>`).
// Handing work to another Bot is the team's most consequential act, so the card says it the
// way a person would: who asks, who it goes to, and the message itself, then Allow or Reject.
// Enter allows and Escape rejects, as on DSH's card. Other tools keep DSH's card.

export const teamToolOf = name => String(name ?? '').replace(/^mcp__dsh__/, '')
const TEAM_TOOLS = new Set(['message_bot', 'start_task', 'stop_bot', 'create_bot', 'update_bot', 'delete_bot', 'create_group', 'update_group', 'delete_group', 'post_to_group', 'group_relay', 'remember', 'forget', 'save_capability', 'delete_capability', 'show_view'])
export const KEEP_WORKING = 'keep_working'
const ladderOf = pending => teamToolOf(pending.toolName) === KEEP_WORKING ? 'keep'
  : hostTemplateOf(pending.reason) === 'This step is hard to undo: {step}. Allow it once?' ? 'hard' : undefined
export const isTeamApproval = pending => pending?.kind === 'approval' && (TEAM_TOOLS.has(teamToolOf(pending.toolName)) || ladderOf(pending) !== undefined)

/** The call's arguments from the request's reason: the bridge's JSON, else none. */
export function argsOf(reason) {
  try {
    const value = JSON.parse(String(reason ?? ''))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const text = value => (typeof value === 'string' ? value.trim() : '')

/** What the card says for one call: { title, to?, quote?, rows }. `name(id)` reads a Bot's name. */
export function approvalView(toolName, args, from) {
  const tool = teamToolOf(toolName)
  const who = from ?? t('This Bot')
  const rows = (keys) => keys.map(key => [key, text(args[key])]).filter(([, value]) => value !== '')
  switch (tool) {
    case 'message_bot': return { title: t('{from} wants to hand work to {to}', { from: who, to: text(args.to) || t('another Bot') }), to: text(args.to), quote: text(args.message), note: t('{to} works on it in its own chat and reports back.', { to: text(args.to) || t('The Bot') }), rows: [] }
    case 'start_task': return { title: t('{from} wants to start a task', { from: who }), quote: text(args.brief) || text(args.prompt) || text(args.message), rows: [...rows(['title', 'folder']), ...(text(args.model) ? [['Requested model', text(args.model)]] : [])] }
    case 'stop_bot': return { title: t('{from} wants to stop {to}', { from: who, to: text(args.to) || text(args.name) || t('another Bot') }), to: text(args.to) || text(args.name), quote: text(args.reason), rows: [] }
    case 'create_bot': return { title: t('{from} wants to add {name} to the team', { from: who, name: text(args.name) || t('a Bot') }), quote: text(args.instructions), rows: rows(['role', 'model']) }
    case 'update_bot': return { title: t('{from} wants to change {name}', { from: who, name: text(args.name) || text(args.to) || t('a Bot') }), quote: text(args.instructions), rows: rows(['role', 'model']) }
    case 'delete_bot': return { title: t('{from} wants to delete {to}', { from: who, to: text(args.bot) || t('another Bot') }), to: text(args.bot), note: t('Deleting archives its memory and conversations, removes it from the team and groups, and deletes its secrets.'), rows: [] }
    case 'post_to_group': case 'group_relay': return { title: t('{from} wants to post in {group}', { from: who, group: text(args.group) || text(args.to) || t('a group chat') }), quote: text(args.message) || text(args.text), rows: [] }
    case 'remember': return { title: t('{from} wants to remember this', { from: who }), quote: text(args.text) || text(args.fact) || text(args.memory), rows: [] }
    case 'forget': return { title: t('{from} wants to forget this', { from: who }), quote: text(args.text) || text(args.fact) || text(args.memory), rows: [] }
    default: return { title: t('{from} wants to use {tool}', { from: who, tool }), rows: Object.entries(args).filter(([, value]) => typeof value === 'string' && value.trim() !== '').slice(0, 6).map(([key, value]) => [key, value.trim()]) }
  }
}

const findBot = (roster, name) => {
  const wanted = String(name ?? '').toLowerCase()
  return wanted ? roster.byId?.[name] ?? (roster.bots ?? []).find(bot => bot.name.toLowerCase() === wanted) : undefined
}

export function TeamApproval({ matched, useRoster }) {
  const pending = matched
  const roster = useRoster(value => value)
  const [answered, setAnswered] = useState(false)
  const root = useRef(null)
  // The Bot whose chat asks; a task asks for the Bot that started it.
  const fromBot = roster.byId?.[pending.botId] ?? roster.byId?.[pending.sessionId] ?? roster.byId?.[roster.tasks?.[pending.sessionId]?.from]
  const ladder = ladderOf(pending)
  const view = ladder ? { title: hostText(pending.reason), rows: [], ...(ladder === 'keep' ? { note: t('Allow once lets it keep working: nothing that was refused runs. Reject stops it here.') } : {}) }
    : approvalView(pending.toolName, argsOf(pending.reason), fromBot?.name)
  const quote = view.quote || (pending.child === true ? pending.detail?.code : '')
  const note = view.note || (pending.child === true ? [pending.detail?.text, Object.keys(argsOf(pending.reason)).length === 0 ? pending.reason : ''].filter(Boolean).join(' · ') : '')
  const toBot = findBot(roster, view.to)
  const answer = (outcome) => {
    if (answered || !pending.answerable) return
    setAnswered(true)
    void Promise.resolve(pending.answer(outcome)).catch(() => setAnswered(false))
  }
  useEffect(() => { if (pending.child !== true) root.current?.focus({ preventScroll: true }) }, [pending.key, pending.child])
  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.target.closest?.('input, textarea, [contenteditable]')) return
    if (event.key === 'Escape') { event.preventDefault(); answer('rejected') }
    else if (event.key === 'Enter' && !event.target.closest?.('button')) { event.preventDefault(); answer('allowed-once') }
  }
  return h('div', { ref: root, className: 'bt-apr', role: 'group', tabIndex: -1, 'aria-label': view.title, 'aria-busy': answered || undefined, onKeyDown },
    h('div', { className: 'bt-apr-head' },
      h('span', { className: 'bt-apr-faces', 'aria-hidden': true },
        fromBot ? h(BotMark, { bot: fromBot, size: 36, state: 'alert' }) : null,
        toBot ? h('span', { className: 'bt-apr-arrow' }, '→') : null,
        toBot ? h(BotMark, { bot: toBot, size: 36, state: 'idle' }) : null),
      h('div', { className: 'bt-apr-heading' },
        h('span', { className: 'bt-apr-kicker' }, pending.child === true ? t('A subagent is waiting for your approval') : t('Waiting for your approval')),
        h('p', { className: 'bt-apr-title' }, view.title))),
    quote ? h('blockquote', { className: 'bt-apr-quote' }, quote) : null,
    view.rows.length > 0
      ? h('dl', { className: 'bt-apr-rows' }, view.rows.flatMap(([key, value]) => [h('dt', { key: `k:${key}` }, key), h('dd', { key: `v:${key}` }, value)]))
      : null,
    note ? h('p', { className: 'bt-apr-note' }, note) : null,
    h('div', { className: 'bt-apr-actions' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: answered, onClick: () => answer('rejected') }, t('Reject'), h('kbd', null, 'Esc')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: answered, onClick: () => answer('allowed-once') }, toBot && teamToolOf(pending.toolName) === 'message_bot' ? t('Send to {name}', { name: toBot.name }) : t('Allow once'), h('kbd', null, '↵'))))
}

export function ChildApprovalDock({ sessionId, useRoster, useWork, actions }) {
  const entry = useWork(work => (work.approvals ?? []).find(item => item.child === true && item.answerable === true && item.ownerSessionId === sessionId))
  if (!entry) return null
  return h(TeamApproval, { key: entry.id, useRoster, matched: {
    key: entry.id, kind: 'approval', child: true, botId: entry.botId, sessionId: entry.ownerSessionId,
    toolName: entry.tool, reason: entry.reason, detail: entry.detail, answerable: true,
    answer: outcome => actions.answerApproval(entry.id, outcome === 'allowed-once' ? 'allow' : 'reject'),
  } })
}

export const TEAM_APPROVAL_CSS = `
.bt-apr{display:flex;flex-direction:column;gap:12px;margin:0 auto 12px;max-width:760px;width:100%;box-sizing:border-box;padding:16px 18px;border:1px solid color-mix(in srgb,var(--st-warndot,var(--bt-accent)) 55%,transparent);border-radius:16px;background:var(--bt-card);color:var(--bt-ink);font-family:var(--bt-font);outline:none}
.bt-apr[aria-busy]{opacity:.7}
.bt-apr-head{display:flex;align-items:center;gap:12px}
.bt-apr-faces{display:flex;align-items:center;gap:6px;flex:none}
.bt-apr-arrow{color:var(--bt-ink-2);font-weight:600}
.bt-apr-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-apr-kicker{font-size:12px;line-height:16px;font-weight:600;color:var(--st-warn,var(--bt-ink-2))}
.bt-apr-title{margin:0;font:var(--bt-weight-strong,700) 16px/22px var(--bt-head-font,var(--bt-font))}
.bt-apr-quote{margin:0;padding:10px 14px;border-left:3px solid var(--bt-accent);border-radius:0 12px 12px 0;background:var(--bt-bubble);white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow-y:auto}
.bt-apr-rows{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:12px;line-height:16px}
.bt-apr-rows dt{color:var(--bt-ink-2);font-weight:600}
.bt-apr-rows dd{margin:0;overflow-wrap:anywhere}
.bt-apr-note{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-apr-actions{display:flex;justify-content:flex-end;gap:8px}
.bt-apr-actions button{display:inline-flex;align-items:center;gap:8px}
.bt-apr-actions kbd{font:600 11px/14px var(--bt-font);opacity:.6}
`
