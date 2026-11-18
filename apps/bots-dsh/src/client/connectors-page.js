// Settings → Apps. The catalog is a two-column grid of apps grouped by
// category, with search and category chips on top and the connected count at the
// right. A tile connects in place when nothing more is needed, and shows the
// sign-in it started; anything that needs a form or a choice opens the app's own
// view, which reuses the rows in connectors.js. Connected apps and the mailbox
// accounts have their own view.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { OFFICIAL_APPS } from '../host/connectors/official.js'
import { ConnectorMark, ConnectorRow, MailAccount, MailCatalogRow, MailPending, MailRules, AddMenu, openSignIn, SignInPanel } from './connectors.js'
import { LAMP } from './clay-art.js'
import { OmniMark } from './logo.js'
import { AgentMark } from './marks.js'
import { useMorph } from './motion.js'
import { reserveWindow } from './open-window.js'
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon, PlusIcon, SearchIcon } from './icons.js'
import { hostText, t } from './i18n.js'

const CATEGORIES = [['dev', 'Developer'], ['docs', 'Docs & files'], ['work', 'Work'], ['design', 'Design'], ['data', 'Data'], ['commerce', 'Commerce'], ['search', 'Search']]
const FEATURED = ['github', 'mail', 'notion', 'linear', 'figma', 'slack']
const PREVIEW = 6

const matches = (query, ...texts) => query === '' || texts.join(' ').toLowerCase().includes(query.toLowerCase())

// The row that just turned ready plays one sweep; rows that load already
// connected stay still.
function useJustConnected(state) {
  const last = useRef(state)
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    const was = last.current
    last.current = state
    if (state !== 'ready' || was === 'ready') return undefined
    setFresh(true)
    const timer = setTimeout(() => setFresh(false), 1100)
    return () => clearTimeout(timer)
  }, [state])
  return fresh
}

function AppIcon({ app, size = 36 }) {
  return h('span', { className: 'bt-app-icon', style: { width: size, height: size } }, h(ConnectorMark, { connector: app }))
}

function tileStatus(app) {
  if (app.state === 'ready') return app.account ?? null
  if (app.state === 'connecting') return app.pending ? t('Waiting for sign-in…') : t('Connecting…')
  if (app.state === 'needs-sign-in') return t('Sign in again')
  if (app.state === 'needs-client') return t('NOT SET UP')
  if (app.state === 'error') return t('Could not connect: {error}', { error: hostText(app.error ?? '') })
  return null
}

function AppTile({ app, actions, onOpen, showsSignIn, onSignIn, inert = false, expanded }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const fresh = useJustConnected(app.state)
  const run = (task, after, failed) => {
    setBusy(true); setError(null)
    return Promise.resolve(task).then(value => after?.(value), (failure) => { failed?.(); setError(failure?.message ?? String(failure)) }).finally(() => setBusy(false))
  }
  // Connects in place when no form is needed; a browser sign-in gets its window
  // inside the click so it is not blocked.
  const connect = () => {
    const auth = app.auth ?? {}
    if (app.id === 'mail' || auth.kind === 'key' || (auth.kind === 'oauth' && auth.token && !auth.client?.id)) return onOpen()
    if (auth.kind === 'oauth') {
      onSignIn()
      const win = reserveWindow()
      return void run(actions.connectorConnect(app.id, {}), view => openSignIn(win, app.id, view), () => win.close())
    }
    return void run(actions.connectorConnect(app.id, {}))
  }
  const ready = app.state === 'ready'
  const off = app.state === 'off'
  const status = error ? hostText(error) : tileStatus(app)
  const label = busy ? t('Connecting…') : ready ? t('Connected') : off ? t('Connect') : app.state === 'error' ? t('Try again') : app.state === 'needs-sign-in' ? t('Sign in again') : t('Open')
  const press = () => {
    if (inert) return undefined
    if (off) return connect()
    if (app.state === 'error') return void run(actions.connectorRetry(app.id))
    return onOpen()
  }
  const signIn = showsSignIn ? app.pending?.kind : undefined
  const tile = useRef(null)
  useMorph(tile, signIn ?? '')
  return h('div', { ref: tile, className: 'bt-app', 'data-state': app.state, 'data-fresh': fresh ? '' : undefined, 'data-error': error ? '' : undefined, 'data-signing': signIn ? '' : undefined },
    h('button', { type: 'button', className: 'bt-app-main', onClick: onOpen, 'aria-expanded': expanded },
      h(AppIcon, { app }),
      h('span', { className: 'bt-app-text' },
        h('span', { className: 'bt-app-name' }, app.name, app.custom ? h('span', { className: 'bt-tag' }, t('Added')) : null),
        status ? h('span', { className: 'bt-app-status' }, status) : null)),
    signIn ? null : h('button', { type: 'button', className: ready ? 'bt-app-btn bt-app-btn-done' : 'bt-app-btn', disabled: busy, onClick: press },
      ready ? h(CheckIcon) : null, label),
    signIn ? h(SignInPanel, { connector: app, actions, run }) : null)
}

// An app can be listed in two sections. Only one tile draws the sign-in: the one
// that was clicked, or after a reload the first one on the page.
function Grid({ apps, actions, open, place = null, signInPlaces, inert = false }) {
  const homePlace = app => (FEATURED.includes(app.id) ? 'featured' : app.category)
  return h('div', { className: 'bt-app-grid' }, apps.map(app => h(AppTile, {
    key: app.id, app, actions, inert,
    onOpen: () => open(app.id),
    showsSignIn: place === null || place === (signInPlaces.current[app.id] ?? homePlace(app)),
    onSignIn: () => { signInPlaces.current[app.id] = place },
  })))
}

function Section({ title, apps, actions, open, onAll, place, signInPlaces }) {
  if (apps.length === 0) return null
  return h('section', { className: 'bt-app-section' },
    h('div', { className: 'bt-app-section-head' },
      h('h3', null, title),
      onAll && apps.length > PREVIEW ? h('button', { type: 'button', className: 'bt-app-all', onClick: onAll }, t('See all')) : null),
    h(Grid, { apps: onAll ? apps.slice(0, PREVIEW) : apps, actions, open, place, signInPlaces }))
}

function Subview({ title, onBack, children }) {
  return h('div', { className: 'bt-app-sub' },
    h('div', { className: 'bt-app-sub-head' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: onBack }, h(ChevronLeftIcon)),
      h('h3', null, title)),
    children)
}

function ConnectedSummary({ apps, count, onClick }) {
  if (count === 0) return null
  return h('button', { type: 'button', className: 'bt-app-summary', onClick },
    h('span', { className: 'bt-app-stack' }, apps.slice(0, 3).map(app => h(AppIcon, { key: app.id, app, size: 22 }))),
    t('{count} connected', { count }), h(ChevronRightIcon))
}

// --- the mock behind ?mock-apps ------------------------------------------
//
// The planned Apps page: Automagik's official apps on top, the upstream catalog below,
// all of it sample data. No install logic: every button is inert and a row only expands.
// It is drawn from the page's own tile, grid, section and row pieces, so what it shows is
// what the real page would look like.

const MOCK_STATE = Object.freeze({ omni: 'installed', genie: 'update', claude: 'install', codex: 'installed' })
const MOCK_INERT = Object.freeze({})

const mockFlag = () => {
  try {
    const search = String(window.location?.search ?? '').replace(/^\?/, '')
    return search.split('&').some(part => part === 'mock-apps' || part.startsWith('mock-apps='))
  } catch {
    return false
  }
}

function OfficialMark({ app, size = 22 }) {
  if (app.mark === 'omni') return h(OmniMark, { size })
  if (app.mark === 'genie') return h('img', { className: 'bt-agent-mark', src: LAMP, width: size, height: size, alt: '', 'aria-hidden': true, draggable: false })
  return h(AgentMark, { id: app.mark, name: app.name, size })
}

function officialLabel(state) {
  return state === 'installed' ? t('Installed') : state === 'update' ? t('Update') : t('Install')
}

function OfficialTile({ app, state, expanded, onToggle }) {
  const installed = state !== 'install'
  return h('div', { className: 'bt-app', 'data-state': installed ? 'ready' : 'off' },
    h('button', {
      type: 'button', className: 'bt-app-main', 'aria-expanded': expanded,
      onClick: onToggle,
    },
      h('span', { className: 'bt-app-icon' }, h(OfficialMark, { app })),
      h('span', { className: 'bt-app-text' },
        h('span', { className: 'bt-app-name' }, app.name, h('span', { className: 'bt-tag' }, t('Official'))),
        h('span', { className: 'bt-app-status' }, t(app.about)))),
    h('button', {
      type: 'button', className: state === 'installed' ? 'bt-app-btn bt-app-btn-done' : 'bt-app-btn',
      // The mock installs nothing: the control draws its state and does nothing.
      onClick: () => {},
    }, state === 'installed' ? h(CheckIcon) : null, officialLabel(state)))
}

function MockDetail({ app, official, state }) {
  const ready = official ? state !== 'install' : app.state === 'ready'
  const label = official ? officialLabel(state) : ready ? t('Connected') : t('Connect')
  return h('div', { className: 'bt-set-card bt-connectors-card bt-app-detail bt-app-expanded' },
    h('div', { className: 'bt-connector', 'data-state': ready ? 'ready' : 'off' },
      h('div', { className: 'bt-connector-head' },
        h('span', { className: 'bt-connector-mark' }, official ? h(OfficialMark, { app, size: 20 }) : h(ConnectorMark, { connector: app })),
        h('span', { className: 'bt-connector-text' },
          h('span', { className: 'bt-connector-name' }, app.name, official ? h('span', { className: 'bt-tag' }, t('Official')) : null),
          h('span', { className: 'bt-connector-status' }, t(app.about ?? ''))),
        h('span', { className: 'bt-connector-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => {} }, label)))),
    h('div', { className: 'bt-set-row' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, t(official ? 'Included with Automagik' : 'SAMPLE DATA')),
        h('span', { className: 'bt-set-hint' }, t('Sample row: nothing is installed from this preview.')))))
}

function MockSection({ title, hint, apps, openId, onToggle, official = false }) {
  if (apps.length === 0) return null
  const open = apps.find(app => app.id === openId)
  return h('section', { className: 'bt-app-section' },
    title === undefined && hint === undefined ? null : h('div', { className: 'bt-app-section-head' },
      title === undefined ? null : h('h3', null, title),
      hint === undefined ? null : h('span', { className: 'bt-app-status' }, hint)),
    h('div', { className: 'bt-app-grid' }, apps.map(app => (official
      ? h(OfficialTile, { key: app.id, app, state: MOCK_STATE[app.id], expanded: openId === app.id, onToggle: () => onToggle(app.id) })
      : h(AppTile, { key: app.id, app, actions: MOCK_INERT, inert: true, showsSignIn: true, expanded: openId === app.id, onOpen: () => onToggle(app.id) })))),
    open ? h(MockDetail, { app: open, official, state: MOCK_STATE[open.id] }) : null)
}

function MockAppsPage({ roster }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [expanded, setExpanded] = useState('genie')
  const upstream = (roster?.connectors?.connectors ?? []).filter(app => app.id !== 'mail')
  const queryText = query.trim()
  const searching = queryText !== '' || category !== ''
  const official = category === '' ? OFFICIAL_APPS.filter(app => matches(queryText, app.name, app.about, t(app.about))) : []
  const found = upstream.filter(app => (category === '' || app.category === category) && matches(queryText, app.name, app.about ?? '', t(app.about ?? '')))
  const toggle = id => setExpanded(current => (current === id ? null : id))
  const inCategory = id => upstream.filter(app => app.category === id)
  const sections = searching
    ? [
      h(MockSection, { key: 'official', title: t('Automagik official'), hint: t('Included with Automagik'), apps: official, openId: expanded, onToggle: toggle, official: true }),
      h(MockSection, { key: 'found', apps: found, openId: expanded, onToggle: toggle }),
    ]
    : [
      h(MockSection, { key: 'official', title: t('Automagik official'), hint: t('Included with Automagik'), apps: official, openId: expanded, onToggle: toggle, official: true }),
      ...CATEGORIES.map(([id, label]) => h(MockSection, { key: id, title: t(label), apps: inCategory(id), openId: expanded, onToggle: toggle })),
    ]
  return h('div', { className: 'bt-apps' },
    h('div', { className: 'bt-app-note', role: 'note' },
      h('span', { className: 'bt-tag' }, t('SAMPLE DATA')),
      h('span', null, t('A mock of the Apps page. Nothing here installs; click a row to expand it.'))),
    h('div', { className: 'bt-app-bar' },
      h('label', { className: 'bt-app-search' },
        h(SearchIcon),
        h('input', { type: 'search', 'aria-label': t('Search apps'), placeholder: t('Search apps'), value: query, onChange: e => setQuery(e.target.value) })),
      h('button', { type: 'button', className: 'bt-app-pill', onClick: () => {} }, h(PlusIcon), t('Custom'))),
    h('div', { className: 'bt-app-chips', role: 'group', 'aria-label': t('Category') },
      [['', 'All'], ...CATEGORIES].map(([id, label]) => h('button', { key: id || 'all', type: 'button', 'aria-pressed': category === id, onClick: () => setCategory(id) }, t(label)))),
    found.length === 0 && official.length === 0 ? h('p', { className: 'bt-app-empty' }, t('Nothing matches')) : sections)
}

// The flag is read at render time, so the page without it is today's page unchanged.
export function ConnectorsPage(props) {
  return mockFlag() ? h(MockAppsPage, props) : h(AppsPage, props)
}

function AppsPage({ roster, actions }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const signInPlaces = useRef({})
  const run = (task, onDone) => Promise.resolve(task).then((value) => { setError(null); onDone?.(value) }, failure => setError(failure?.message ?? String(failure)))
  const data = roster?.connectors ?? { connectors: [], mail: { accounts: [], google: false } }
  const mail = data.mail ?? { accounts: [] }
  const accounts = mail.accounts ?? []
  const mailbox = {
    id: 'mail', name: t('Mailbox'), category: 'work', about: t('QQ, 163, 126, Gmail, iCloud, and other IMAP mail'),
    state: accounts.length > 0 ? 'ready' : (mail.pending?.length ?? 0) > 0 ? 'connecting' : 'off',
    account: accounts.length === 1 ? accounts[0].address : accounts.length > 1 ? t('{count} accounts', { count: accounts.length }) : null,
  }
  const apps = [mailbox, ...(data.connectors ?? []).filter(c => c.id !== 'mail')]
  const connected = apps.filter(app => app.state !== 'off' || app.pending)
  const marks = [...accounts.map(account => ({ id: `mail-${account.provider}`, name: account.address })), ...connected.filter(app => app.id !== 'mail')]
  const count = accounts.length + connected.filter(app => app.id !== 'mail').length
  const open = id => setView({ app: id })
  const back = () => setView(null)
  const banner = error ? h('div', { className: 'bt-connector-error bt-connector-banner', role: 'alert' }, hostText(error)) : null

  if (view?.app === 'mail') {
    return h(Subview, { title: t('Mailbox'), onBack: back }, banner,
      h('div', { className: 'bt-set-card bt-connectors-card' },
        accounts.map(account => h(MailAccount, { key: account.id, account, actions, run })),
        (mail.pending ?? []).map(p => h(MailPending, { key: p.address ?? 'google', pending: p })),
        h(MailCatalogRow, { mail, actions }),
        h(MailRules, { mail, bots: roster?.bots, actions, run })))
  }
  const shown = view?.app ? apps.find(app => app.id === view.app) : null
  if (shown) {
    return h(Subview, { title: shown.name, onBack: back },
      h('div', { className: 'bt-set-card bt-connectors-card bt-app-detail' }, h(ConnectorRow, { connector: shown, actions })),
      shown.about ? h('p', { className: 'bt-app-about' }, t(shown.about)) : null)
  }
  if (view === 'connected') {
    const rows = connected.filter(app => app.id !== 'mail')
    return h(Subview, { title: t('Connected'), onBack: back }, banner,
      h('div', { className: 'bt-set-card bt-connectors-card' },
        count === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No apps connected'))) : null,
        rows.map(app => h(ConnectorRow, { key: app.id, connector: app, actions })),
        accounts.map(account => h(MailAccount, { key: account.id, account, actions, run })),
        (mail.pending ?? []).map(p => h(MailPending, { key: p.address ?? 'google', pending: p })),
        h(MailRules, { mail, bots: roster?.bots, actions, run })))
  }
  if (view === 'custom') {
    return h(Subview, { title: t('Other MCP server'), onBack: back }, banner,
      h('div', { className: 'bt-set-card bt-connectors-card' }, h(AddMenu, { actions, run })))
  }

  const inCategory = id => apps.filter(app => app.category === id)
  const searching = query.trim() !== ''
  const found = apps.filter(app => (category === '' || app.category === category) && matches(query.trim(), app.name, app.about ?? ''))
  let body
  if (searching || category !== '') {
    body = found.length === 0
      ? h('p', { className: 'bt-app-empty' }, t('Nothing matches'))
      : h(Grid, { apps: found, actions, open, signInPlaces })
  } else {
    const featured = FEATURED.map(id => apps.find(app => app.id === id)).filter(Boolean)
    body = [
      h(Section, { key: 'featured', place: 'featured', signInPlaces, title: t('Recommended'), apps: featured, actions, open }),
      ...CATEGORIES.map(([id, label]) => h(Section, { key: id, place: id, signInPlaces, title: t(label), apps: inCategory(id), actions, open, onAll: () => setCategory(id) })),
    ]
  }
  return h('div', { className: 'bt-apps' },
    banner,
    h('div', { className: 'bt-app-bar' },
      h('label', { className: 'bt-app-search' },
        h(SearchIcon),
        h('input', { type: 'search', 'aria-label': t('Search apps'), placeholder: t('Search apps'), value: query, onChange: e => setQuery(e.target.value) })),
      h('button', { type: 'button', className: 'bt-app-pill', onClick: () => setView('custom') }, h(PlusIcon), t('Custom')),
      h(ConnectedSummary, { apps: marks, count, onClick: () => setView('connected') })),
    h('div', { className: 'bt-app-chips', role: 'group', 'aria-label': t('Category') },
      [['', 'All'], ...CATEGORIES].map(([id, label]) => h('button', { key: id || 'all', type: 'button', 'aria-pressed': category === id, onClick: () => setCategory(id) }, t(label)))),
    body)
}

export const CONNECTORS_PAGE_CSS = `
.bt-apps{display:flex;flex-direction:column;gap:14px;container-type:inline-size}
.bt-app-note{display:flex;align-items:center;gap:8px;min-height:24px;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-app-note .bt-tag{max-width:none}
.bt-app-expanded{grid-column:1/-1;margin-top:4px}
.bt-app-bar{display:flex;align-items:center;gap:8px}
.bt-app-search{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:36px;padding:0 14px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-card);color:var(--bt-ink-3);cursor:text}
.bt-app-search:focus-within{border-color:var(--bt-line-2)}
.bt-app-search svg{flex:none;width:15px;height:15px}
.bt-app-search input{flex:1;min-width:0;border:0;outline:none;background:none;color:var(--bt-ink);font:inherit;font-size:13px}
.bt-app-search input::-webkit-search-cancel-button{display:none}
.bt-app-pill,.bt-app-summary{flex:none;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease}
.bt-app-pill:hover,.bt-app-summary:hover{background:var(--bt-hover)}
.bt-app-pill svg{width:14px;height:14px}
.bt-app-summary{padding:0 10px 0 6px;border-color:transparent;background:none;color:var(--bt-ink-2)}
.bt-app-summary svg{width:12px;height:12px}
.bt-app-stack{display:inline-flex}
.bt-app-stack .bt-app-icon{border-radius:6px;box-shadow:0 0 0 1.5px var(--bt-main)}
.bt-app-stack .bt-app-icon+.bt-app-icon{margin-left:-6px}
.bt-app-stack .bt-app-icon svg,.bt-app-stack .bt-connector-mono{width:13px;height:13px;font-size:9px}
.bt-app-chips{display:flex;flex-wrap:wrap;gap:6px}
.bt-app-chips button{height:28px;padding:0 12px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-app-chips button:hover{background:var(--bt-active)}
.bt-app-chips button[aria-pressed=true]{background:var(--bt-ink);color:var(--bt-main)}
.bt-app-section{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.bt-app-section-head{display:flex;align-items:center;justify-content:space-between;min-height:24px}
.bt-app-section-head h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
.bt-app-all{border:0;background:none;padding:2px 4px;color:var(--bt-ink-3);font:inherit;font-size:12px;cursor:pointer}
.bt-app-all:hover{color:var(--bt-ink)}
.bt-app-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px;align-items:start}
@container (max-width:520px){.bt-app-grid{grid-template-columns:minmax(0,1fr)}}
.bt-app{position:relative;display:flex;align-items:center;gap:10px;min-height:60px;border-radius:12px}
.bt-app-main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-app-icon{--bt-mark-ink:var(--bt-ink);flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 .5px var(--bt-line-2)}
.bt-app-icon svg{width:22px;height:22px}
.bt-app-text{min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-app-name{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-app-status{font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-app[data-state=error] .bt-app-status,.bt-app[data-error] .bt-app-status{color:var(--st-bad-strong,var(--bt-danger))}
.bt-app-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:72px;height:28px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-app-btn:hover:not(:disabled){background:var(--bt-active)}
.bt-app-btn:disabled{opacity:.5;cursor:default}
.bt-app-btn svg{width:13px;height:13px}
.bt-app-btn-done{background:none;color:var(--bt-ink-2);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-app-icon svg{transition:filter .6s ease,opacity .6s ease}
.bt-app:not([data-state=ready]) .bt-app-icon svg{filter:grayscale(1);opacity:.5}
.bt-app[data-fresh] .bt-app-icon{animation:bt-app-pop .5s cubic-bezier(.3,1.5,.5,1)}
.bt-app[data-fresh]::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 28%,color-mix(in srgb,var(--bt-ink) 7%,transparent) 44%,color-mix(in srgb,var(--bt-ink) 2%,transparent) 50%,color-mix(in srgb,var(--bt-ink) 7%,transparent) 56%,transparent 72%);background-size:300% 100%;border-radius:inherit;animation:bt-app-shine .9s cubic-bezier(.25,.8,.3,1) both}
.bt-app[data-fresh] .bt-app-btn-done{animation:bt-app-done .4s ease-out}
@keyframes bt-app-pop{0%{transform:scale(.86)}55%{transform:scale(1.07)}100%{transform:scale(1)}}
@keyframes bt-app-shine{0%{background-position:100% 0}100%{background-position:0 0}}
@keyframes bt-app-done{0%{opacity:.4;transform:scale(.94)}100%{opacity:1;transform:none}}
.bt-app[data-signing]{flex-wrap:wrap;padding-bottom:12px}
.bt-app[data-signing] .bt-app-main{flex-basis:100%;min-height:60px}
.bt-app[data-signing] .bt-connector-form{flex:1 0 100%;min-width:0}
.bt-app-empty{margin:24px 0;text-align:center;font-size:13px;color:var(--bt-ink-3)}
.bt-app-sub{display:flex;flex-direction:column;gap:12px}
.bt-app-sub-head{display:flex;align-items:center;gap:4px;margin-left:-6px}
.bt-app-sub-head h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
.bt-app-about{margin:0 4px;font-size:13px;line-height:20px;color:var(--bt-ink-2)}
.bt-connector-mark{--bt-mark-ink:var(--bt-ink)}
[data-bt-motion=off] .bt-app,[data-bt-motion=off] .bt-app *,[data-bt-motion=off] .bt-app::after{animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){.bt-app[data-fresh]::after,.bt-app[data-fresh] .bt-app-icon,.bt-app[data-fresh] .bt-app-btn-done{animation:none}}
`
