// Settings → Agent access: keys that let an agent outside Automagik read the space and set
// up its Bots, how to connect one, and the log of what each key did. The host owns the keys,
// the listener and the log (src/host/agent-access.js); this page only shows them. A key's
// value passes through here once, on creation, and is never read back.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from './icons.js'
import { KeyIcon } from './secret-card.js'
import { dateLocale, hostText, t } from './i18n.js'

// The same rule the host applies to a key's name (agent-access.js `create`).
const NAME = /^[\w .-]{1,60}$/
// How many revoked keys stay listed before the rest fold away.
const REVOKED_SHOWN = 3
const PLACEHOLDER_KEY = 'YOUR_KEY'
// The name the host logs for a call whose key it does not know.
const UNKNOWN = 'Unknown token'
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/

const WarnIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M10 3.5 17.2 16H2.8z' }), h('path', { d: 'M10 8.5v3.5M10 14.3h.01' }))

const day = time => new Date(time).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' })
const moment = time => new Date(time).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// 'local' when only the computer Automagik runs on can reach the address, 'network' for an
// address on a private network. The host binds nothing public.
export function reachOf(url) {
  try { return LOOPBACK.test(new URL(url).hostname) ? 'local' : 'network' } catch { return null }
}

// The web address of a space served over HTTPS, where the same agents come in through the
// page's own origin. A desktop window and a plain local page have none.
export function webAddressOf(view, place = globalThis.location) {
  if (place?.protocol !== 'https:' || typeof view?.webPath !== 'string') return null
  return `${place.origin}${view.webPath}`
}

export const exampleOf = address => JSON.stringify({
  mcpServers: { automagik: { type: 'http', url: address, headers: { Authorization: `Bearer ${PLACEHOLDER_KEY}` } } },
}, null, 2)

// The log the page holds is a window: the host hands over the latest 200 records out of the
// last 256 KiB of its file (src/host/agent-access.js `history`).
const LOG_ROWS = 200
const LOG_BYTES = 256 * 1024
const utf8Length = (text) => {
  let bytes = 0
  for (const letter of text) {
    const code = letter.codePointAt(0)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}
// Whether older records may have dropped out of the window. By count: the window is full.
// By size: the host drops the record its cut lands in, so the rows weigh less than the
// window; a record is far smaller than half of it, and past that half the window may be cut.
export function logMayHaveRolled(audit) {
  if (audit.length >= LOG_ROWS) return true
  let bytes = 0
  for (const entry of audit) {
    bytes += utf8Length(JSON.stringify(entry)) + 1
    if (bytes >= LOG_BYTES / 2) return true
  }
  return false
}

// A key's last call, from that window. A key with no row in it is `unused` only while the
// window still holds the whole log: once records may have dropped out, nothing here can say
// the key was never used.
export function useOf(row, audit) {
  let last
  for (const entry of audit) {
    if (entry.tokenName !== row.name || entry.time < row.createdAt) continue
    if (row.revokedAt !== undefined && entry.time > row.revokedAt) continue
    if (last === undefined || entry.time > last) last = entry.time
  }
  if (last !== undefined) return { last }
  return { unused: !logMayHaveRolled(audit) }
}

// Keys in use first, newest on top; then the revoked ones, latest revoked on top.
export function keyRows(view) {
  const live = view.tokens.filter(row => row.revokedAt === undefined).sort((a, b) => b.createdAt - a.createdAt)
  const revoked = view.tokens.filter(row => row.revokedAt !== undefined).sort((a, b) => b.revokedAt - a.revokedAt)
  return { live, revoked }
}

// What a logged call did, in the owner's words. A call the host names otherwise is a request.
const ACTIONS = {
  list_bots: 'Listed the Bots', get_bot: 'Looked at a Bot', create_bot: 'Created a Bot',
  update_bot: 'Changed a Bot', delete_bot: 'Deleted a Bot', set_main: 'Changed who is a Main Bot',
  list_groups: 'Listed the group chats', get_group: 'Looked at a group chat',
  create_group: 'Created a group chat', update_group: 'Changed a group chat',
  delete_group: 'Deleted a group chat', list_conversations: 'Listed the chats',
  get_conversation: 'Looked at a chat', read_messages: 'Read messages',
  read_settings: 'Read the settings', recent_activity: 'Read recent activity',
  read_audit: 'Read the access log', initialize: 'Opened a connection',
  'notifications/initialized': 'Opened a connection', 'tools/list': 'Asked what it can do',
  ping: 'Checked the connection', http: 'Tried to connect',
}
const actionText = action => t(ACTIONS[action] ?? 'Sent a request')
// The steps every agent takes when it connects. One connection logs several in a row.
const HELLO = new Set(['initialize', 'notifications/initialized', 'tools/list', 'ping'])
const REASONS = {
  'Invalid agent token': 'The key was wrong or already revoked.',
  'Too many failed attempts': 'Too many wrong keys in a row. It can try again in a minute.',
  'Agent access unavailable': 'Agent access was not available.',
  'Invalid MCP URL': 'The agent used a wrong address.',
  'Invalid MCP origin or URL': 'The agent used a wrong address, or came from a web page that is not allowed.',
}
const OUTCOMES = { allowed: 'Allowed', refused: 'Refused', started: 'Did not finish' }
const reasonText = reason => (Object.hasOwn(REASONS, reason) ? t(REASONS[reason]) : hostText(reason))

// The log as the page lists it, newest first. A change is logged when it starts and again
// when it ends: the start shows only while it has no end. A key's connection steps within a
// minute of each other are one line; a refused step always keeps its own.
export function logRows(audit, keyName) {
  const ended = new Set(audit.filter(entry => entry.outcome !== 'started').map(entry => entry.callId))
  const rows = []
  for (const entry of audit) {
    if (keyName !== undefined && entry.tokenName !== keyName) continue
    if (entry.outcome === 'started' && ended.has(entry.callId)) continue
    const hello = entry.outcome === 'allowed' && HELLO.has(entry.action)
    const last = rows.at(-1)
    if (hello && last?.hello && last.tokenName === entry.tokenName && entry.time - last.time < 60000) continue
    rows.push({ ...entry, hello })
  }
  return rows.reverse()
}

// The names in the key filter: every key, then any other name the log holds.
export function keyNames(view) {
  return [...new Set([...view.tokens.map(row => row.name), ...view.audit.map(entry => entry.tokenName)])]
}
const keyLabel = name => (name === UNKNOWN ? t('Unknown key') : name)

const FIELDS = {
  name: 'name', role: 'role', color: 'color', instructions: 'instructions', model: 'model',
  effort: 'effort', permission: 'permissions', main: 'Main Bot', notice: 'notice',
  members: 'members', admin: 'admin', mode: 'mode',
}
// The copy picked at run time, which no literal call to `t` names: the dictionaries cover it too.
export const LOG_COPY = [...Object.values(ACTIONS), 'Sent a request', ...Object.values(REASONS), ...Object.values(OUTCOMES), ...Object.values(FIELDS)]
const nameOf = (roster, id) => roster?.byId?.[id]?.name ?? roster?.roomsById?.[id]?.name ?? id
const clip = text => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
function valueText(field, value, roster) {
  if (value === null || value === undefined || value === '') return t('none')
  if (value === true) return t('yes')
  if (value === false) return t('no')
  if (Array.isArray(value)) return value.length === 0 ? t('none') : clip(value.map(id => nameOf(roster, id)).join(', '))
  if (field === 'admin') return clip(String(nameOf(roster, value)))
  return clip(String(value))
}

// A change's before and after as lines to read: "Writer: role Writer → Editor".
export function changeLines(changes, roster) {
  const lines = []
  for (const kind of ['bots', 'groups']) {
    for (const [id, fields] of Object.entries(changes?.[kind] ?? {})) {
      const name = fields.name?.after ?? fields.name?.before ?? nameOf(roster, id)
      const keys = Object.keys(fields).filter(key => key !== 'id')
      if (fields.id?.before === null) { lines.push(t('{name}: created', { name })); continue }
      if (fields.id?.after === null) { lines.push(t('{name}: deleted', { name })); continue }
      for (const key of keys) {
        const field = t(FIELDS[key] ?? key)
        // Instructions run long, and the log is not where to read them.
        lines.push(key === 'instructions'
          ? t('{name}: {field} changed', { name, field })
          : t('{name}: {field} {before} → {after}', { name, field, before: valueText(key, fields[key].before, roster), after: valueText(key, fields[key].after, roster) }))
      }
    }
  }
  if (changes?.mainBotIds) {
    lines.push(t('Main Bots: {before} → {after}', {
      before: valueText('members', changes.mainBotIds.before, roster), after: valueText('members', changes.mainBotIds.after, roster),
    }))
  }
  return lines
}

// No clipboard (a page that is not on HTTPS, a locked-down window) is a failure the page says.
const copyText = text => (globalThis.navigator?.clipboard === undefined
  ? Promise.resolve(false)
  : globalThis.navigator.clipboard.writeText(text).then(() => true, () => false))

function CopyButton({ text, label, buttonRef, onResult }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => {
    void copyText(text).then((ok) => {
      onResult?.(ok)
      setCopied(ok)
      clearTimeout(timer.current)
      if (ok) timer.current = setTimeout(() => setCopied(false), 1600)
    })
  }
  return h('button', { ref: buttonRef, type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon bt-aa-copy', 'aria-label': label, onClick: copy },
    copied ? h(CheckIcon) : h(CopyIcon), h('span', { role: 'status' }, copied ? t('Copied') : t('Copy')))
}

// The one time a key's value is on screen. Leaving the page or choosing Done drops it.
function NewKey({ created, onDone }) {
  const [failed, setFailed] = useState(false)
  const copy = useRef(null)
  useEffect(() => { copy.current?.focus() }, [])
  return h('div', { className: 'bt-aa-new' },
    h('div', { className: 'bt-aa-new-head', role: 'status' }, h(CheckIcon), t('Key created for {name}', { name: created.name })),
    h('div', { className: 'bt-aa-secret' },
      h('code', { className: 'bt-aa-code' }, created.token),
      h(CopyButton, { text: created.token, label: t('Copy the key'), buttonRef: copy, onResult: ok => setFailed(!ok) })),
    h('div', { className: 'bt-aa-new-foot' },
      h('span', { className: 'bt-aa-warn', role: 'note' }, h(WarnIcon),
        failed ? t('Copying did not work here. Select the key and copy it by hand. You will not see it again.')
          : t('Copy it now. You will not see this key again.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Done'))))
}

function CreateKey({ busy, onCreate }) {
  const [name, setName] = useState('')
  const [asked, setAsked] = useState(false)
  const input = useRef(null)
  const valid = NAME.test(name)
  const create = () => {
    if (busy) return
    // The button never looks switched off: with no usable name yet it says what is missing.
    if (!valid) { setAsked(true); input.current?.focus(); return }
    void Promise.resolve(onCreate(name)).then((ok) => { if (ok) { setName(''); setAsked(false) } })
  }
  const wrong = asked && !valid
  return h('div', { className: 'bt-set-row bt-set-paste' },
    h('div', { className: 'bt-aa-create' },
      h('input', {
        ref: input, className: 'bt-input', value: name, maxLength: 60, spellCheck: false, autoComplete: 'off',
        'aria-label': t('Name for the new key'), 'aria-invalid': wrong || undefined, 'aria-describedby': wrong ? 'bt-aa-name-help' : undefined,
        placeholder: t('Name, e.g. Claude Code'),
        onChange: event => setName(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') create() },
      }),
      h('button', { type: 'button', className: 'bt-fb-primary', disabled: busy, onClick: create }, t('Create key'))),
    wrong ? h('span', { id: 'bt-aa-name-help', className: 'bt-aa-problem', role: 'alert' },
      name === '' ? t('Give the key a name first.') : t('Use plain letters (a–z), numbers, spaces, dots and dashes, up to 60.')) : null)
}

function KeyRow({ row, audit, busy, confirming, onAsk, onKeep, onRevoke }) {
  const revoked = row.revokedAt !== undefined
  const use = useOf(row, audit)
  const used = use.last !== undefined ? t('Last used {time}', { time: moment(use.last) })
    : use.unused ? t('Not used yet') : t('No recent use')
  const meta = revoked
    ? [t('Created {date}', { date: day(row.createdAt) }), t('Revoked {date}', { date: day(row.revokedAt) })]
    : [t('Created {date}', { date: day(row.createdAt) }), used]
  return h('div', { className: 'bt-set-row bt-aa-key', 'data-revoked': revoked ? '' : undefined, 'data-confirm': confirming ? '' : undefined },
    h('div', { className: 'bt-set-copy' },
      h('span', { className: 'bt-aa-name' }, h(KeyIcon), h('span', null, row.name), revoked ? h('span', { className: 'bt-tag' }, t('Revoked')) : null),
      confirming
        ? h('span', { className: 'bt-aa-ask' }, t('Revoke {name}? The agent using it loses access at once.', { name: row.name }))
        : h('span', { className: 'bt-set-hint' }, meta.join(' · '))),
    revoked ? null : h('div', { className: 'bt-set-control' }, confirming
      ? [
          h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', autoFocus: true, onClick: onKeep }, t('Keep')),
          h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-aa-danger', 'data-confirm': '', disabled: busy, onClick: onRevoke }, t('Revoke')),
        ]
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-aa-danger', disabled: busy, 'aria-label': t('Revoke {name}', { name: row.name }), onClick: onAsk }, t('Revoke'))))
}

function Address({ label, address, hint, reach }) {
  return h('div', { className: 'bt-set-row bt-aa-line' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, label),
      h('code', { className: 'bt-aa-address' }, address),
      h('span', { className: 'bt-set-hint bt-aa-reach', 'data-reach': reach ?? undefined }, hint)),
    h('div', { className: 'bt-set-control' }, h(CopyButton, { text: address, label: t('Copy the address') })))
}

function ConnectSection({ view, Section }) {
  const web = webAddressOf(view)
  const direct = view.url
  const reach = direct ? reachOf(direct) : null
  // A space on the web says "the computer Automagik runs on": the reader's own is another one.
  const reachHint = reach === 'network' ? t('Private network: agents on your private network can connect.')
    : web ? t('Only the computer Automagik runs on: agents elsewhere cannot reach this address.')
      : t('Only this computer: agents elsewhere cannot reach this address.')
  const address = web ?? direct
  return h(Section, { title: t('Connect an agent') },
    address === null ? h('div', { className: 'bt-set-row' },
      h('span', { className: 'bt-set-hint' }, t('Create a key first. The address and an example setup then show here.'))) : null,
    web ? h(Address, { label: t('Web address'), address: web, hint: t('For an agent on any computer that can open this page.') }) : null,
    direct ? h(Address, { label: web ? t('Direct address') : t('Address'), address: direct, hint: reachHint, reach }) : null,
    address === null ? null : h('div', { className: 'bt-set-row bt-set-paste bt-aa-example' },
      h('div', { className: 'bt-aa-example-head' },
        h('div', { className: 'bt-set-copy' },
          h('span', null, t('Example setup')),
          h('span', { className: 'bt-set-hint' }, t('For Claude Code, in a file named .mcp.json. Other agents ask for the same address and key.'))),
        h(CopyButton, { text: exampleOf(address), label: t('Copy the example') })),
      h('pre', { className: 'bt-aa-pre', tabIndex: 0, 'aria-label': t('Example setup') }, exampleOf(address)),
      h('span', { className: 'bt-set-hint' }, t('Put your key in place of {placeholder}. Keep the file out of anything you share.', { placeholder: PLACEHOLDER_KEY }))))
}


function LogRow({ entry, roster }) {
  const lines = entry.changes ? changeLines(entry.changes, roster) : []
  const reason = entry.outcome === 'refused' && entry.reason ? reasonText(entry.reason)
    : entry.outcome === 'started' ? t('This change was cut short. Check it before the agent tries again.') : null
  return h('div', { className: 'bt-set-row bt-aa-line bt-aa-log' },
    h('div', { className: 'bt-set-copy' },
      h('span', { className: 'bt-aa-what', title: entry.action },
        h('span', null, actionText(entry.action)), entry.target ? h('span', { className: 'bt-aa-target' }, nameOf(roster, entry.target)) : null),
      h('span', { className: 'bt-set-hint' }, `${keyLabel(entry.tokenName)} · ${moment(entry.time)}`),
      reason ? h('span', { className: 'bt-aa-reason' }, reason) : null,
      lines.length > 0 ? h('ul', { className: 'bt-aa-changes' }, lines.map((line, index) => h('li', { key: index }, line))) : null),
    h('span', { className: 'bt-aa-pill', 'data-outcome': entry.outcome }, t(OUTCOMES[entry.outcome] ?? 'Refused')))
}

function LogSection({ view, roster, busy, onRefresh, Section }) {
  const [picked, setPicked] = useState('')
  const names = keyNames(view)
  const keyName = names.includes(picked) ? picked : undefined
  const rows = logRows(view.audit, keyName)
  return h(Section, { title: t('Access log') },
    h('div', { className: 'bt-set-row' },
      h('div', { className: 'bt-set-copy' },
        h('span', null, t('What agents did with their keys')),
        h('span', { className: 'bt-set-hint' }, t('Newest first. The latest 200 show here.'))),
      h('div', { className: 'bt-set-control bt-aa-tools' },
        names.length > 0 ? h('select', { className: 'bt-select bt-aa-filter', 'aria-label': t('Show the log of'), value: keyName ?? '', onChange: event => setPicked(event.target.value) },
          h('option', { value: '' }, t('All keys')), names.map(name => h('option', { key: name, value: name }, keyLabel(name)))) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onRefresh }, t('Refresh')))),
    rows.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' },
      keyName === undefined ? t('Nothing yet. What an agent does with a key is listed here.') : t('Nothing from this key in the latest 200.'))) : null,
    rows.map((entry, index) => h(LogRow, { key: `${entry.callId}-${index}`, entry, roster })))
}

export function AgentAccessPage({ actions, run, roster, Section }) {
  const [view, setView] = useState(null)
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [older, setOlder] = useState(false)
  const refresh = () => actions.agentAccess().then(setView)
  useEffect(() => { void run(refresh()) }, [])
  const perform = (work) => {
    setBusy(true)
    return run(work().then(refresh).finally(() => setBusy(false)))
  }
  const create = name => perform(async () => {
    setCreated(null)
    const result = await actions.agentTokenCreate(name)
    setCreated({ id: result.id, name, token: result.token })
  })
  const revoke = id => perform(async () => {
    await actions.agentTokenRevoke(id)
    setConfirm(null)
    setCreated(null)
  })
  const about = h('p', { key: 'about', className: 'bt-aa-about' },
    t('Let an agent outside Automagik, like Claude Code on your laptop, read your chats and set up your Bots. Each agent gets a key of its own, and you can revoke it at any time.'))
  if (!view) {
    return h('div', { className: 'bt-aa' }, about,
      h(Section, { title: t('Agent keys') }, h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('Loading…')))))
  }
  const { live, revoked } = keyRows(view)
  const shown = older ? revoked : revoked.slice(0, REVOKED_SHOWN)
  const keyRow = row => h(KeyRow, {
    key: row.id, row, audit: view.audit, busy, confirming: confirm === row.id,
    onAsk: () => setConfirm(row.id), onKeep: () => setConfirm(null), onRevoke: () => revoke(row.id),
  })
  return h('div', { className: 'bt-aa' }, about,
    h(Section, { title: t('Agent keys · {count}', { count: live.length }) },
      h(CreateKey, { busy, onCreate: create }),
      created ? h(NewKey, { key: created.id, created, onDone: () => setCreated(null) }) : null,
      view.tokens.length === 0 ? h('div', { className: 'bt-set-row' },
        h('span', { className: 'bt-set-hint' }, t('No keys yet. Create one for each agent you let in, so you can revoke them one by one.'))) : null,
      live.map(keyRow),
      shown.map(keyRow),
      revoked.length > shown.length ? h('button', { type: 'button', className: 'bt-set-row bt-aa-more', onClick: () => setOlder(true) },
        t('Show {count} older revoked keys', { count: revoked.length - shown.length })) : null),
    h(ConnectSection, { view, Section }),
    h(LogSection, { view, roster, busy, onRefresh: () => run(refresh()), Section }))
}

export const AGENT_ACCESS_CSS = `
.bt-aa{display:flex;flex-direction:column;gap:20px}
.bt-aa-about{margin:0;padding:0 4px;max-width:640px;font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-aa :is(.bt-soft,.bt-fb-primary,.bt-select,.bt-aa-more,.bt-aa-pre):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-aa .bt-input:focus-visible{border-color:var(--bt-accent);box-shadow:0 0 0 1px var(--bt-accent)}
.bt-aa-create{display:flex;align-items:center;gap:8px}
.bt-aa-create .bt-input{flex:1;min-width:0;height:34px}
.bt-aa-create .bt-fb-primary{height:34px;padding:0 16px;font-size:13px}
.bt-aa-problem{font-size:12px;line-height:16px;color:color-mix(in srgb,var(--st-bad-strong,var(--bt-danger)) 72%,var(--bt-ink))}
.bt-aa-new{display:flex;flex-direction:column;gap:10px;padding:12px;background:color-mix(in srgb,var(--bt-accent) 6%,transparent)}
.bt-aa-new-head{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:600}
.bt-aa-new-head svg{flex:none;color:color-mix(in srgb,var(--bt-green) 70%,var(--bt-ink))}
.bt-aa-secret{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 12px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card)}
.bt-aa-code{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:18px;color:var(--bt-ink);overflow-wrap:anywhere;user-select:all}
.bt-aa-new-foot{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}
.bt-aa-warn{flex:1;min-width:220px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;font-weight:500;color:color-mix(in srgb,var(--bt-star) 58%,var(--bt-ink))}
.bt-aa-warn svg{flex:none}
.bt-aa-new-foot .bt-soft{margin-left:auto}
.bt-aa-copy span{min-width:0}
.bt-aa-name{display:flex;align-items:center;gap:6px;min-width:0;font-weight:500}
.bt-aa-name svg{flex:none;color:var(--bt-ink-2)}
.bt-aa-name>span:not(.bt-tag){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-aa-key[data-revoked] .bt-aa-name{font-weight:400;color:var(--bt-ink-2)}
.bt-aa-key[data-revoked] .bt-aa-name svg{color:var(--bt-ink-3)}
.bt-aa-ask{font-size:12px;line-height:16px;color:var(--bt-ink)}
.bt-aa-danger{color:color-mix(in srgb,var(--st-bad-strong,var(--bt-danger)) 72%,var(--bt-ink))}
.bt-aa-danger[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 14%,transparent)}
.bt-aa-danger[data-confirm]:hover{background:color-mix(in srgb,var(--bt-danger) 22%,transparent)}
.bt-aa-more{justify-content:center;font-size:12px;color:var(--bt-ink-2)}
.bt-aa-address{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:18px;color:var(--bt-ink);overflow-wrap:anywhere;user-select:all}
.bt-aa-reach[data-reach]{display:flex;align-items:baseline;gap:6px}
.bt-aa-reach[data-reach]::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-green);translate:0 -1px}
.bt-aa-reach[data-reach=network]::before{background:var(--bt-star)}
.bt-aa-example-head{display:flex;align-items:center;gap:12px}
.bt-aa-pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:11.5px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;overflow-x:auto;tab-size:2}
.bt-aa-tools{flex-wrap:wrap;justify-content:flex-end}
.bt-aa-filter{width:auto;min-width:120px;max-width:220px;height:28px;font-size:12px}
.bt-aa-log{align-items:flex-start}
.bt-aa-what{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.bt-aa-target{font-weight:500;overflow-wrap:anywhere}
.bt-aa-target::before{content:"·";margin-right:6px;font-weight:400;color:var(--bt-ink-3)}
.bt-aa-reason{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-aa-changes{margin:4px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:17px;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-aa-changes li{padding-left:10px;border-left:2px solid var(--bt-line-2)}
.bt-aa-pill{flex:none;margin-top:1px;padding:1px 8px;border-radius:999px;font-size:11.5px;line-height:16px;font-weight:500;white-space:nowrap;background:color-mix(in srgb,var(--bt-danger) 12%,transparent);color:color-mix(in srgb,var(--st-bad-strong,var(--bt-danger)) 72%,var(--bt-ink))}
.bt-aa-pill[data-outcome=allowed]{background:color-mix(in srgb,var(--bt-green) 14%,transparent);color:color-mix(in srgb,var(--bt-green) 50%,var(--bt-ink))}
.bt-aa-pill[data-outcome=started]{background:color-mix(in srgb,var(--bt-star) 16%,transparent);color:color-mix(in srgb,var(--bt-star) 58%,var(--bt-ink))}
@media (max-width:640px){
  .bt-set-row.bt-aa-line,.bt-set-row.bt-aa-key:not([data-confirm]){flex-direction:row;align-items:flex-start;gap:12px}
  .bt-set-row.bt-aa-line>.bt-set-copy,.bt-set-row.bt-aa-key:not([data-confirm])>.bt-set-copy{width:auto}
  .bt-aa-key[data-confirm] .bt-set-control{justify-content:flex-end}
  .bt-aa-tools{justify-content:space-between}
  .bt-aa-filter{flex:1;max-width:none}
  .bt-aa-example-head{align-items:flex-start}
  .bt-aa-pre{white-space:pre-wrap;overflow-wrap:anywhere}
}
`
