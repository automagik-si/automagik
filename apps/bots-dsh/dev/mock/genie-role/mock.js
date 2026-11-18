// The mock's own behaviour: the role picker, the wish rows it adds, and the theme switch.
// Sample data only; nothing here talks to a host. The rows are drawn the way genie-dsh's
// client draws them today (client.js, GenieWishes) and the panel uses the Bot team's classes.
const WISHES = [
  { title: 'Fix the login retry', state: 'local-only', short: 'Local branch', mark: '•' },
  { title: 'Add the pricing page', state: 'no-change', short: 'No change', mark: '•' },
  { title: 'Rewrite the onboarding email', state: 'failed', short: 'Failed', mark: '✕' },
]

const params = new URLSearchParams(location.search)
const gate = document.getElementById('gate')
const mock = document.getElementById('mock')
const live = document.getElementById('live')
const wishes = document.getElementById('wishes')
const roleTag = document.getElementById('who-role')
const adds = document.getElementById('role-adds')
const sub = document.getElementById('who-sub')
const tools = document.getElementById('tools-hint')
const themeButton = document.getElementById('theme')
const picker = [...document.querySelectorAll('[data-role]')]

// The page is a mock, so it is only shown behind ?mock=roles.
const flagged = params.get('mock') === 'roles'
// A checkout that has not run build-css.mjs has no mock.css: say so instead of half-drawing.
const styled = getComputedStyle(document.body).getPropertyValue('--bt-main').trim() !== ''
if (!styled) {
  document.getElementById('gate-copy').textContent =
    'This page has no mock.css yet. Run "node dev/mock/genie-role/build-css.mjs", then reload.'
  document.getElementById('gate-link').hidden = true
}
if (flagged && styled) {
  mock.hidden = false
  render('none')
  applyTheme(params.get('theme') === 'dark')
} else {
  gate.hidden = false
  const dark = params.get('theme') === 'dark' ? '&theme=dark' : ''
  document.getElementById('gate-link').href = `?mock=roles${dark}`
}

for (const button of picker) button.addEventListener('click', () => render(button.dataset.role))
themeButton.addEventListener('click', () => applyTheme(!isDark()))

function isDark() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

function applyTheme(dark) {
  document.body.toggleAttribute('data-ds-dark-theme', dark === true)
  themeButton.textContent = dark ? 'Light' : 'Dark'
}

// The one screen change the role makes: the tag, the added capabilities, the wish rows.
function render(role) {
  const genie = role === 'genie'
  for (const button of picker) {
    button.setAttribute('aria-pressed', String(button.dataset.role === role))
  }
  roleTag.hidden = !genie
  adds.hidden = !genie
  // The Bot's own role line is never overwritten: the role's name joins it, as Main Bot does.
  sub.textContent = genie ? 'Writes the launch posts · Genie' : 'Writes the launch posts'
  tools.textContent = genie
    ? "The team's tools, its memory, its sessions — plus grant_wish."
    : "The team's tools, its memory, its sessions."
  wishes.hidden = !genie
  wishes.replaceChildren(...(genie ? WISHES.map(wishRow) : []))
  live.textContent = genie
    ? 'Role: Genie. Writer keeps its model, permissions, memory and sessions; it gained one '
      + 'tool, one prompt part and these rows.'
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
    live.textContent = `Opens the wish thread: ${wish.title} (${wish.short.toLowerCase()}).`
  })
  return row
}
