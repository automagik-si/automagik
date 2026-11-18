// The mock's behaviour: the Apps page's roles, install, the Bot's Role picker, attach, and
// the theme switch. Sample data only; nothing here talks to a host. Every product surface
// uses the Bot team's own bt-* classes and --bt-* tokens (cards from bot-settings.js, tiles
// from connectors-page.js, rows from the left bar).
const ROLES = [
  {
    id: 'genie',
    name: 'Genie',
    version: '0.4.0',
    publisher: 'Automagik',
    official: true,
    about: 'Grants wishes in one project',
    adds: 'grant_wish, the wish rows, Genie’s rules and its chat suggestions',
    grants: 'task-start, route-policy',
    detail: 'One Genie per repository. It writes a branch and reports back; it cannot push.',
  },
  {
    id: 'voice-mouth',
    name: 'Voice / Mouth',
    version: '0.1.0',
    publisher: 'Automagik',
    official: true,
    about: 'Speech in and out, and a voice of its own',
    adds: 'speak, the voice prompt part and the Voice row',
    grants: 'audio-out',
    detail: 'Speaks into the person’s open voice pane. No files, no shell, no channels.',
  },
  {
    id: 'standup',
    name: 'Standup Summaries',
    version: '0.3.2',
    publisher: '@northstar',
    official: false,
    about: 'Summarises a standup from the team’s chat',
    adds: 'summarise and a notes prompt part',
    grants: 'history-read',
    detail: 'A community role adds host tools and a prompt part. It waits for the sandboxed '
      + 'runtime (P5): a signature and a review cannot contain code that runs in the host.',
  },
]

const APPS = [
  { id: 'omni', name: 'Omni', about: 'The Main Bot: the team, channels and memory' },
  { id: 'bots', name: 'Bot team', about: 'The team every Automagik product builds on' },
  { id: 'welcome', name: 'Welcome', about: 'Connects your AI and sets up the team' },
]

const UPSTREAM = [
  { id: 'code-mode', name: 'Code mode', about: 'A code workspace inside the app' },
  { id: 'plugin-market', name: 'Plugin market', about: 'Every DSH plugin index' },
  { id: 'voice-input', name: 'Voice input', about: 'Local speech recognition' },
]

const WISHES = [
  { title: 'Fix the login retry', state: 'local-only', short: 'Local branch', mark: '•' },
  { title: 'Add the pricing page', state: 'no-change', short: 'No change', mark: '•' },
  { title: 'Rewrite the onboarding email', state: 'failed', short: 'Failed', mark: '✕' },
]

const ICONS = {
  genie: '<path d="M10 2.5l1.7 4.3L16 8.5l-4.3 1.7L10 14.5 8.3 10.2 4 8.5l4.3-1.7z"/>'
    + '<path d="M15.5 13.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  'voice-mouth': '<path d="M4 8h3l4-3.5v11L7 12H4z"/><path d="M14 7.5a3.5 3.5 0 010 5"/>'
    + '<path d="M16 5a6.5 6.5 0 010 10"/>',
  standup: '<path d="M4 4h12v12H4z"/><path d="M7 8h6M7 11h6M7 14h3"/>',
  omni: '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13"/>'
    + '<path d="M10 3.5c2 2.2 2.9 4.4 2.9 6.5s-.9 4.3-2.9 6.5c-2-2.2-2.9-4.4-2.9-6.5'
    + 'S8 5.7 10 3.5z"/>',
  bots: '<circle cx="7" cy="7.5" r="2"/><circle cx="13" cy="7.5" r="2"/>'
    + '<path d="M3.5 15c0-2 1.6-3.5 3.5-3.5h6c1.9 0 3.5 1.5 3.5 3.5"/>',
  welcome: '<path d="M3 10c2-4 5-6 7-6s5 2 7 6c-2 4-5 6-7 6s-5-2-7-6z"/>'
    + '<circle cx="10" cy="10" r="2.5"/>',
  'code-mode': '<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>',
  'plugin-market': '<rect x="3.5" y="3.5" width="5" height="5" rx="1"/>'
    + '<rect x="11.5" y="3.5" width="5" height="5" rx="1"/>'
    + '<rect x="3.5" y="11.5" width="5" height="5" rx="1"/>'
    + '<path d="M14 11.5v5M11.5 14h5"/>',
  'voice-input': '<rect x="7.5" y="3" width="5" height="9" rx="2.5"/>'
    + '<path d="M5 9.5a5 5 0 0010 0M10 14.5V17"/>',
}

const params = new URLSearchParams(location.search)
const gate = document.getElementById('gate')
const mock = document.getElementById('mock')
const live = document.getElementById('live')
const writerLive = document.getElementById('writer-live')
const wishes = document.getElementById('wishes')
const roleTag = document.getElementById('who-role')
const rowRole = document.getElementById('row-role')
const adds = document.getElementById('role-adds')
const sub = document.getElementById('who-sub')
const tools = document.getElementById('tools-hint')
const voiceCard = document.getElementById('voice-card')
const themeButton = document.getElementById('theme')
const picker = document.getElementById('role-picker')
const shopSections = document.getElementById('shop-sections')
const roleDetail = document.getElementById('role-detail')
const views = [...document.querySelectorAll('.mock-view')]
const tabs = [...document.querySelectorAll('[data-view]')]
const chips = [...document.querySelectorAll('[data-chip]')]
const search = document.querySelector('.bt-app-search input')

const state = {
  installed: new Set(['genie']),
  attached: null,
  view: 'shop',
  chip: 'all',
  detail: null,
}

if (params.get('voice') === 'installed' || params.get('role') === 'voice-mouth') {
  state.installed.add('voice-mouth')
}
if (['genie', 'voice-mouth'].includes(params.get('role'))) state.attached = params.get('role')
if (params.get('view') === 'writer') state.view = 'writer'
if (['genie', 'voice-mouth', 'standup'].includes(params.get('detail'))) {
  state.detail = params.get('detail')
}

const roleOf = id => ROLES.find(role => role.id === id)
const isDark = () => document.body.hasAttribute('data-ds-dark-theme')

// A checkout that has not run build-css.mjs has no mock.css: say so instead of half-drawing.
const styled = getComputedStyle(document.body).getPropertyValue('--bt-main').trim() !== ''
const flagged = ['bazaar', 'roles'].includes(params.get('mock'))
if (!styled) {
  document.getElementById('gate-copy').textContent =
    'This page has no mock.css yet. Run "node dev/mock/genie-role/build-css.mjs", then reload.'
  document.getElementById('gate-link').hidden = true
}
if (flagged && styled) {
  mock.hidden = false
  applyTheme(params.get('theme') === 'dark')
  render()
} else {
  gate.hidden = false
  const dark = params.get('theme') === 'dark' ? '&theme=dark' : ''
  document.getElementById('gate-link').href = `?mock=bazaar${dark}`
}

themeButton.addEventListener('click', () => applyTheme(!isDark()))
for (const tab of tabs) tab.addEventListener('click', () => setView(tab.dataset.view))
for (const chip of chips) chip.addEventListener('click', () => setChip(chip.dataset.chip))
document.getElementById('manage-roles').addEventListener('click', () => setView('shop'))
document.getElementById('try-voice').addEventListener('click', () => {
  writerLive.textContent = 'Speaks: “The launch post is ready; want the short version first?” '
    + '(through this browser’s system voice).'
})
search?.addEventListener('input', () => filterTiles(search.value))

function applyTheme(dark) {
  document.body.toggleAttribute('data-ds-dark-theme', dark === true)
  themeButton.textContent = dark ? 'Light' : 'Dark'
}

function setView(view) {
  state.view = view
  render()
}

function setChip(chip) {
  state.chip = chip
  for (const button of chips) {
    button.setAttribute('aria-pressed', String(button.dataset.chip === chip))
  }
  renderShop()
}

function render() {
  for (const tab of tabs) {
    const selected = tab.dataset.view === state.view
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  for (const view of views) view.hidden = view.id !== `view-${state.view}`
  live.hidden = state.view !== 'shop'
  renderShop()
  renderPicker()
  renderWriter()
}

function section(title, note, kind, tiles) {
  return `<section class="bt-app-section" data-section="${kind}">
    <div class="bt-app-section-head"><h3>${title}</h3>
      <span class="bt-app-status">${note}</span></div>
    <div class="bt-app-grid">${tiles.join('')}</div>
  </section>`
}

function appTile(app) {
  return `<div class="bt-app" data-state="ready">
    <button type="button" class="bt-app-main" disabled>
      <span class="bt-app-icon mock-icon"><svg viewBox="0 0 20 20" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${ICONS[app.id] ?? ''}</svg></span>
      <span class="bt-app-text">
        <span class="bt-app-name">${app.name}</span>
        <span class="bt-app-status">${app.about}</span>
      </span>
    </button>
    <button type="button" class="bt-app-btn bt-app-btn-done" disabled>Included</button>
  </div>`
}

function upstreamTile(app) {
  return `<div class="bt-app">
    <button type="button" class="bt-app-main" disabled>
      <span class="bt-app-icon mock-icon"><svg viewBox="0 0 20 20" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${ICONS[app.id] ?? ''}</svg></span>
      <span class="bt-app-text">
        <span class="bt-app-name">${app.name}</span>
        <span class="bt-app-status">${app.about}</span>
      </span>
    </button>
    <button type="button" class="bt-app-btn" disabled>Install</button>
  </div>`
}

function roleTile(role) {
  const installed = state.installed.has(role.id)
  const community = !role.official
  const stateLabel = community ? 'Community · unreviewed'
    : installed ? 'Installed · attach it to one Bot' : role.about
  const button = installed
    ? '<button type="button" class="bt-app-btn bt-app-btn-done" disabled>Installed</button>'
    : community
      ? '<button type="button" class="bt-app-btn" disabled '
        + 'title="Needs the sandboxed runtime (P5)">Install</button>'
      : `<button type="button" class="bt-app-btn" data-install="${role.id}">Install</button>`
  return `<div class="bt-app" data-state="${installed ? 'ready' : 'off'}">
    <button type="button" class="bt-app-main" data-detail="${role.id}">
      <span class="bt-app-icon mock-icon"><svg viewBox="0 0 20 20" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${ICONS[role.id] ?? ''}</svg></span>
      <span class="bt-app-text">
        <span class="bt-app-name">${role.name}
          <span class="bt-tag">Role</span>
          <span class="bt-tag">${community ? 'Community' : 'Official'}</span></span>
        <span class="bt-app-status">${stateLabel} · v${role.version}</span>
      </span>
    </button>
    ${button}
  </div>`
}

function renderShop() {
  const sections = [
    section('Automagik official', 'Included with Automagik', 'apps', APPS.map(appTile)),
    section('Roles', 'One per Bot, installed here, attached on the Bot', 'roles',
      ROLES.map(roleTile)),
    section('DeepSeek Harness', 'Upstream catalog, below Automagik’s rows', 'plugins',
      UPSTREAM.map(upstreamTile)),
  ]
  shopSections.innerHTML = sections.join('')
  shopSections.querySelector('[data-section="roles"]')?.append(roleDetail)
  for (const button of shopSections.querySelectorAll('[data-install]')) {
    button.addEventListener('click', () => install(button.dataset.install))
  }
  for (const button of shopSections.querySelectorAll('[data-detail]')) {
    button.addEventListener('click', () => showDetail(button.dataset.detail))
  }
  for (const node of shopSections.querySelectorAll('[data-section]')) {
    node.hidden = state.chip !== 'all' && node.dataset.section !== state.chip
  }
  filterTiles(search?.value ?? '')
  renderDetail()
}

function filterTiles(query) {
  const needle = query.trim().toLowerCase()
  for (const tile of shopSections.querySelectorAll('.bt-app')) {
    tile.hidden = needle !== '' && !tile.textContent.toLowerCase().includes(needle)
  }
}

function install(id) {
  const role = roleOf(id)
  if (!role || !role.official || state.installed.has(id)) return
  state.installed.add(id)
  state.detail = id
  live.textContent = `${role.name} installed. It adds no tool to any Bot until you attach it.`
  render()
}

function showDetail(id) {
  state.detail = state.detail === id ? null : id
  renderDetail()
}

function renderDetail() {
  const role = roleOf(state.detail)
  roleDetail.hidden = role === undefined
  if (!role) return
  const installed = state.installed.has(role.id)
  const attached = state.attached === role.id
  const action = !installed
    ? role.official
      ? `<button type="button" class="bt-soft bt-soft-sm" data-install-detail="${role.id}">`
        + 'Install</button>'
      : '<button type="button" class="bt-soft bt-soft-sm" disabled '
        + 'title="Needs the sandboxed runtime (P5)">Install</button>'
    : `<button type="button" class="bt-soft bt-soft-sm" data-uninstall="${role.id}" `
      + `${attached ? 'disabled title="Detach it from Writer first"' : ''}>Uninstall</button>`
  roleDetail.innerHTML = `<div class="bt-set-card">
    <div class="bt-set-row bt-bs-row">
      <span class="bt-set-copy">
        <span class="bt-bs-label">${role.name} · ${role.version}</span>
        <span class="bt-set-hint">${role.publisher} · ${role.official ? 'official' : 'community'}
          · sha256 ${role.official ? '9f2c…' : 'not verified'}</span>
      </span>${action}
    </div>
    <div class="bt-set-row bt-bs-row">
      <span class="bt-set-copy"><span class="bt-bs-label">Adds</span>
        <span class="bt-set-hint">${role.adds}</span></span>
    </div>
    <div class="bt-set-row bt-bs-row">
      <span class="bt-set-copy"><span class="bt-bs-label">Grants it asks for</span>
        <span class="bt-set-hint"><code>${role.grants}</code>. The person grants each one;
          none is on by default.</span></span>
    </div>
    <div class="bt-set-row bt-bs-row">
      <span class="bt-set-copy"><span class="bt-bs-label">What it cannot change</span>
        <span class="bt-set-hint">Writer’s model, permissions, shell, channels, memory,
          sessions and Main Bot powers.</span></span>
    </div>
    <div class="bt-set-row bt-bs-row">
      <span class="bt-set-copy"><span class="bt-bs-label">Note</span>
        <span class="bt-set-hint">${role.detail}</span></span>
    </div>
  </div>`
  roleDetail.querySelector('[data-install-detail]')?.addEventListener('click',
    event => install(event.currentTarget.dataset.installDetail))
  roleDetail.querySelector('[data-uninstall]')?.addEventListener('click', () => {
    if (state.attached === role.id) return
    state.installed.delete(role.id)
    live.textContent = `${role.name} uninstalled. Its Bot data stays where the plugin kept it.`
    render()
  })
}

function renderPicker() {
  const choices = [null, ...ROLES.filter(role => state.installed.has(role.id))]
  picker.replaceChildren(...choices.map((role) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'bt-soft bt-soft-sm'
    button.dataset.pickRole = role?.id ?? 'none'
    button.setAttribute('aria-pressed', String((role?.id ?? null) === state.attached))
    button.textContent = role ? `${role.name} — ${role.about}` : 'None'
    button.addEventListener('click', () => attach(role?.id ?? null))
    return button
  }))
}

function attach(id) {
  state.attached = id
  const role = roleOf(id)
  live.textContent = role
    ? `${role.name} attached to Writer. It adds ${role.adds}; everything common stays.`
    : 'Role detached. Writer keeps its model, permissions, memory and sessions.'
  render()
}

function renderWriter() {
  const role = roleOf(state.attached)
  roleTag.hidden = !role
  rowRole.hidden = !role
  adds.hidden = !role
  voiceCard.hidden = role?.id !== 'voice-mouth'
  if (role) {
    roleTag.textContent = role.name
    rowRole.textContent = role.name
    sub.textContent = `Writes the launch posts · ${role.name}`
    adds.textContent = `Adds ${role.adds}. It asks for ${role.grants}. It cannot change `
      + 'Writer’s model, permissions, shell, capabilities, memory or sessions; and it may not '
      + 'add another role.'
  } else {
    sub.textContent = 'Writes the launch posts'
  }
  tools.textContent = role
    ? `The team’s tools, its memory, its sessions — plus ${role.adds.split(',')[0]}.`
    : 'The team’s tools, its memory, its sessions.'
  wishes.hidden = role?.id !== 'genie'
  wishes.replaceChildren(...(role?.id === 'genie' ? WISHES.map(wishRow) : []))
  writerLive.textContent = role
    ? `Role: ${role.name}. Writer keeps everything common and gains only what the role adds.`
    : 'Role: none. Writer is an ordinary Bot.'
}

function wishRow(wish) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'bt-thread'
  row.dataset.state = wish.state
  row.title = `${wish.title} · ${wish.short} · wish/fix-the-login-retry`
  row.setAttribute('aria-label', `${wish.title}, ${wish.short}`)
  row.innerHTML = `<span class="bt-thread-age" aria-hidden="true">${wish.mark}</span>`
    + `<span class="bt-thread-title"></span><span class="bt-thread-age"></span>`
  row.querySelector('.bt-thread-title').textContent = wish.title
  row.lastElementChild.textContent = wish.short
  row.addEventListener('click', () => {
    writerLive.textContent = `Opens the wish thread: ${wish.title} (${wish.short.toLowerCase()}).`
  })
  return row
}
