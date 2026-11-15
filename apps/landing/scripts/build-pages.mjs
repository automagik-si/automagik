// Static multi-page source. No build step is needed on Pages; generated HTML is committed.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { waitlistForm, waitlistIntro, privacyNote } from '../waitlist/lib/ui.js'

// The pages this site builds. /arca/ is not one of them: that address is Arca's own page,
// served by Arca's Worker (RFC 0027). This site links to it and carries no file there.
export const routes = ['/', '/desktop/', '/mobile/', '/omni/', '/genie/', '/cloud/', '/mykes/']
const repo = 'https://github.com/automagik-si/automagik'
const mac = `${repo}/releases/latest/download/Automagik-Mac.dmg`
const linux = `${repo}/releases/latest/download/Automagik-Linux.deb`
const appImage = `${repo}/releases/latest/download/Automagik-Linux.AppImage`
// LINKS OUT: guides and help live on the docs site (no deep paths yet). GitHub is linked for
// the downloads and once, quietly, in the footer; nothing links to a design document.
const docs = 'https://docs.automagik.dev'
const releases = JSON.parse(await readFile(new URL('../assets/releases.json', import.meta.url), 'utf8'))
const artFiles = JSON.parse(await readFile(new URL('../assets/art/manifest.json', import.meta.url), 'utf8')).files
// WE UNFOLD: the one place for its link and wording. The owner approves both lines before the
// site goes live; change them here and regenerate. Rules from the we unfold team: "Open
// Intelligence" always with both capitals and never shortened; "we unfold" in lower case in
// running text; "part of" is the movement, not ownership; in a sentence the text is the link.
export const weUnfold = {
  url: 'https://weunfold.ai/',
  name: 'we unfold',
  partOf: 'Automagik is part of we unfold, the home of the Open Intelligence movement.',
  openIntelligence: 'Open Intelligence: a future more people can understand, question, and shape.',
}
// ARCA: its page at /arca/ is Arca's own, not built here. Its one line is the owner's own
// (2026-11-12), used exactly as given wherever Arca is described. Get Arca opens Arca's
// page; the installer's address answers with a shell script, so nothing here links to it.
export const arca = { line: 'Be your own cloud. Infrastructure for AI agents.' }
// ARCA'S LOGO is the ark, in one colour, the text colour, never coloured (the owner's decision;
// the family package's issue 11c). With its word it is Arca's row in the family drawer
// (arcaLogo, below). Alone it is the small picture beside
// the name "Arca" in the Products menu and on the home card: the package's
// arca-ark-icon.svg, written into the page as it is, so it takes the text colour. The name
// stands beside it, so the picture is hidden from assistive technology. The arch was Arca's
// earlier logo: no page shows it, and its files are not in this site.
export const arcaArk = `<span class="arca-ark" aria-hidden="true">${readFileSync(new URL('../assets/family/arca-ark-icon.svg', import.meta.url), 'utf8').trim()}</span>`
// THE OFFICIAL LOCKUP: shown once, on the home page's brand block, never in the header,
// the hero, the favicon or a share picture.
const lockup = '/assets/brand/automagik/automagik-lockup-oi'
const licensing = 'Automagik, Genie and Omni are free and open source (Apache-2.0). Cloud will be a private, paid service; its contracts are public.'
// "Things that made our stack possible": the open projects the products are built on, as one
// row on the home. Each is its own project's mark, an unchanged copy of the official file
// (assets/brand/LICENSES.md lists every source), with the name set in this site's type and
// a link to the project's own site. mark: [file on a light page, file on a dark page or null
// when one file serves both, the file's width, its height]; shown: the height it is drawn at;
// inset: empty space inside the file's own box, taken back in the layout; alt: for a mark
// that carries the words itself, or whose owner asks for a trademark sign at first use.
export const used = [
  { name: 'DeepSeek Harness', href: 'https://deepseek.com/harness', mark: ['deepseek-harness/favicon.svg', null, 50, 50], shown: 30 },
  { name: 'Herdr', href: 'https://herdr.dev', mark: ['herdr/herdr.png', null, 160, 160], shown: 30 },
  { name: 'Agent Client Protocol', href: 'https://agentclientprotocol.com', mark: ['agent-client-protocol/light.svg', 'agent-client-protocol/dark.svg', 160, 61], shown: 22 },
  { name: 'Model Context Protocol', href: 'https://modelcontextprotocol.io', mark: ['model-context-protocol/favicon.svg', null, 180, 180], shown: 30 },
  { name: 'A2A', href: 'https://a2a-protocol.org', mark: ['a2a/a2a_icon_color.svg', 'a2a/a2a_icon_white.svg', 199.067, 198.437], shown: 32 },
  { name: 'Hermes Agent', href: 'https://hermes-agent.nousresearch.com', mark: ['hermes-agent/Square44x44Logo.scale-200.png', null, 88, 88], shown: 30 },
  { name: 'Oh My Pi', href: 'https://omp.sh', mark: ['oh-my-pi/favicon.svg', null, 64, 64], shown: 30 },
  { name: 'Pi', href: 'https://pi.dev', mark: ['pi/logo.svg', null, 800, 800], shown: 52, inset: true },
  { name: 'NATS', href: 'https://nats.io', mark: ['nats/nats-icon-color.svg', 'nats/nats-icon-white.svg', 280.4, 289.9], shown: 30, alt: 'NATS™, open source messaging' },
  { name: 'iroh', href: 'https://www.iroh.computer', mark: ['iroh/iroh-wordmark-dark.svg', 'iroh/iroh-wordmark-purple.svg', 93.26, 32], shown: 24, alt: 'iroh, direct connections between devices', wordmark: true },
  { name: 'Better Auth', href: 'https://better-auth.com', mark: ['better-auth/better-auth-mark-dark.svg', 'better-auth/better-auth-mark-light.svg', 400, 300], shown: 24 },
]
export const usedCredit = 'Each name and logo belongs to its project; none endorses Automagik.'
export const trademarks = 'DeepSeek Harness is a trademark of DeepSeek; NATS™ is a trademark of The Linux Foundation.'
const usedItem = ({ name, href, mark: [light, dark, width, height], shown, inset, alt, wordmark }) => {
  // A mark beside its name is decoration. A mark with its own alt text speaks for the item, so the name beside it is not read twice.
  const image = `<img${inset ? ' class="used-inset"' : ''} src="/assets/brand/used/${light}" width="${Math.round(shown * width / height)}" height="${shown}" ${alt ? `alt="${alt}"` : 'alt="" aria-hidden="true"'} loading="lazy" decoding="async">`
  const picture = dark ? `<picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/used/${dark}">${image}</picture>` : image
  return `<li><a class="used" href="${href}">${picture}${wordmark ? '' : `<span${alt ? ' aria-hidden="true"' : ''}>${name}</span>`}</a></li>`
}
// The row is written twice: the second copy only fills the gap while the row drifts, and is
// out of reach of the keyboard and of assistive technology. Under it sits the pause switch, a
// plain checkbox that needs no script: shown only while the row drifts, it holds the row
// still for a visitor on a touch screen, who has no pointer to rest on it.
const usedPause = `<label class="we-use-pause"><input type="checkbox"><svg class="when-moving" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 2.5h2.6v11H4zM9.4 2.5H12v11H9.4z"/></svg><svg class="when-paused" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4.2 2.2 13 8l-8.8 5.8z"/></svg><span class="when-moving">Pause</span><span class="when-paused">Paused</span></label>`
const usedRow = () => {
  const items = used.map(usedItem).join('')
  return `<section class="we-use" aria-labelledby="we-use-title"><h2 id="we-use-title" class="we-use-title">Things that made our stack possible</h2>
<div class="we-use-track"><ul class="we-use-list">${items}</ul><ul class="we-use-list we-use-copy" aria-hidden="true" inert>${items}</ul></div>
${usedPause}
<p class="we-use-note wrap">${usedCredit}</p></section>`
}
const arrow = '<span aria-hidden="true">→</span>'
const down = '<span aria-hidden="true">↓</span>'
const out = '<span aria-hidden="true">↗</span>'

// One art file at 1x and 2x. Decorative art carries an empty alt and aria-hidden.
// dark: the visitor's dark theme gets the picture's dark twin (name-dark), so an app capture
// never sits as a bright box on a dark page. sizes: the layout's widths, when the picture
// scales with the page. narrow: another picture of the same thing for phone-width screens.
function art(name, alt, { cls = '', eager = false, dark = false, sizes = '', narrow = '' } = {}) {
  const file = (key, suffix = '') => artFiles[`${key}${suffix}.webp`]
  const set = key => sizes
    ? `/assets/art/${key}.webp ${file(key).width}w, /assets/art/${key}-2x.webp ${file(key, '-2x').width}w`
    : `/assets/art/${key}.webp 1x, /assets/art/${key}-2x.webp 2x`
  const source = (key, media) => `<source media="${media}" srcset="${set(key)}"${sizes ? ` sizes="${sizes}"` : ''} width="${file(key).width}" height="${file(key).height}">`
  const { width, height } = file(name)
  const label = alt ? `alt="${alt}"` : 'alt="" aria-hidden="true"'
  const img = `<img${cls ? ` class="${cls}"` : ''} src="/assets/art/${name}.webp" srcset="${set(name)}"${sizes ? ` sizes="${sizes}"` : ''} width="${width}" height="${height}" ${label}${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`
  const sources = [
    narrow && dark ? source(`${narrow}-dark`, '(max-width: 700px) and (prefers-color-scheme: dark)') : '',
    narrow ? source(narrow, '(max-width: 700px)') : '',
    dark ? source(`${name}-dark`, '(prefers-color-scheme: dark)') : '',
  ].join('')
  return sources ? `<picture>${sources}${img}</picture>` : img
}
// Automagik's mark alone: the logo kit's triskle in three colours, the drawing made for the
// size shown (the 32 px drawing in a menu, the large one from about 100 px up). The triskle
// is Automagik's alone (the brand's rule 1): it stands for Automagik's own Cloud, and never
// beside Omni, Genie or Mykes.
const triskle = (cls, alt = '', { small = false } = {}) => `<img class="${cls}" src="/assets/brand/triskle-three-colours${small ? '-32' : ''}.svg" width="${small ? 32 : 300}" height="${small ? 32 : 300}" ${alt ? `alt="${alt}"` : 'alt="" aria-hidden="true"'}${small ? ' loading="lazy"' : ' fetchpriority="high"'} decoding="async">`
// A product's own mark alone, for the Products menu: the brand folder's flat drawing,
// unchanged, in ink on the light page and in cream on the dark one (the brand's rules 9 and
// 10: never the triskle, never a pet). The menu's picture is a mark's place, so no
// character stands there: Cloud, Automagik's own, shows the triskle. Omni's is the vortex drawn for about 32 px; the lamp
// and the cords have one drawing each. [file stem, size suffix, frame width, frame height].
export const PRODUCT_MARKS = { omni: ['omni-mark', '-32', 120, 120], genie: ['genie-lamp', '', 392, 200], mykes: ['mykes-clean', '', 220, 222] }
const productMark = slug => {
  const [stem, size, width, height] = PRODUCT_MARKS[slug], file = tone => `/assets/brand/${stem}-${tone}${size}.svg`
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${file('cream')}"><img class="menu-art" src="${file('ink')}" width="${width}" height="${height}" alt="" aria-hidden="true" loading="lazy" decoding="async"></picture>`
}
// The clay dots and threads of the app's install art, drawn once per page behind a stage.
function constellation() {
  const nodes = [[60, 120, 9, 'p'], [150, 70, 6, 'c'], [250, 150, 12, 'v'], [120, 260, 7, 'c'], [40, 380, 10, 'v'], [180, 470, 6, 'p'], [330, 540, 9, 'c'],
    [880, 520, 8, 'v'], [1010, 560, 11, 'p'], [1120, 470, 7, 'c'], [1160, 330, 9, 'p'], [1060, 230, 6, 'v'], [1150, 120, 12, 'c'], [980, 60, 7, 'p']]
  const links = [[0, 1], [1, 2], [0, 3], [3, 4], [4, 5], [5, 6], [3, 2], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [10, 12]]
  const line = ([a, b]) => `<line x1="${nodes[a][0]}" y1="${nodes[a][1]}" x2="${nodes[b][0]}" y2="${nodes[b][1]}"/>`
  const dot = ([x, y, r, tone]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#clay-${tone})"/>`
  const ball = (tone, light, dark) => `<radialGradient id="clay-${tone}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></radialGradient>`
  return `<svg class="constellation" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><defs>${ball('c', '#a6ecf8', '#1aa9cc')}${ball('p', '#ffb3d8', '#d63384')}${ball('v', '#d9c2ff', '#8457e0')}</defs><g class="threads">${links.map(line).join('')}</g><path class="arc" d="M200 40 Q300 120 290 220"/><path class="arc" d="M1000 420 Q930 470 900 560"/>${nodes.map(dot).join('')}</svg>`
}

// The site's navigation: three groups, the same in the header menus, the phone menu and the
// footer. Products keep one order everywhere, which is also the previous/next order (the
// pager walks the pages this site builds, so it passes Arca by: see more()).
const products = [
  { href: '/desktop/', name: 'Desktop', image: 'app-icon', line: 'Your agent team, in your chats.' },
  { href: '/mobile/', name: 'Mobile', image: 'app-icon', line: 'Your agents on your Android phone.' },
  { href: '/omni/', name: 'Omni', image: 'omni', mark: productMark('omni'), line: 'Your chat apps, connected.' },
  { href: '/genie/', name: 'Genie', image: 'genie', mark: productMark('genie'), line: 'A wish, a branch, a report.' },
  { href: '/cloud/', name: 'Cloud', image: 'pet', mark: triskle('menu-art', '', { small: true }), line: 'Coming soon. Register your interest.' },
  { href: '/arca/', name: 'Arca', mark: arcaArk, line: arca.line },
  { href: '/mykes/', name: 'Mykes', mark: productMark('mykes'), line: 'Coming soon.' },
]
const resources = [
  { href: docs, name: 'Docs', glyph: 'book', line: 'Guides for the app and its blocks.', external: true },
  { href: '/desktop/#install', name: 'Get the app', glyph: 'download', line: 'Automagik Desktop, for Mac and Linux.' },
  { href: '/mobile/#install', name: 'Get the phone app', glyph: 'phone', line: 'Automagik Mobile, for Android.' },
]
const company = [
  { href: weUnfold.url, name: weUnfold.name, glyph: 'globe', line: weUnfold.openIntelligence, external: true },
  { href: docs, name: 'Support', glyph: 'chat', line: 'Answers and guides, in the docs.', external: true },
  { href: '/cloud/#privacy', name: 'Privacy', glyph: 'ask', line: 'What we keep, and how to remove your details.' },
]
const blocks = products.slice(0, 5).map(({ href, name, image, line }) => [href, name, image, line])
const partOf = () => {
  assert.equal(weUnfold.partOf.split(weUnfold.name).length, 2, 'the part-of line names we unfold once')
  return weUnfold.partOf.replace(weUnfold.name, `<a href="${weUnfold.url}">${weUnfold.name}</a>`)
}
const icon = {
  ai: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  files: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  secret: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.4"/>',
  ask: '<path d="M12 3.5l7 3v5.2c0 4.3-3 7.6-7 8.8-4-1.2-7-4.5-7-8.8V6.5z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 21H19v-3"/><path d="M9 7.5h6"/>',
  phone: '<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10.8 18h2.4"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.7 2.5 2.7 14.7 0 17.2"/><path d="M12 3.4c-2.7 2.5-2.7 14.7 0 17.2"/>',
  chat: '<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v6.5a2.5 2.5 0 0 1-2.5 2.5h-5.2L7.5 19.5v-4H7a2.5 2.5 0 0 1-2.5-2.5z"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  chevron: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M7.5 10l3 2.4-3 2.4"/><path d="M13 15h3.5"/>',
  plug: '<path d="M9 3.5v4"/><path d="M15 3.5v4"/><path d="M6.5 7.5h11v3.8a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.8v3.7"/>',
}
const glyph = (name, cls = 'glyph') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon[name]}</svg>`

// GET AUTOMAGIK: one download hook for the whole site. A row of platforms, each with its
// own sign; a live one opens a sheet with what you get, the exact file, how to install it
// and its guide. Windows and iPhone are named and marked Soon, and are neither a link nor a
// button: nothing here points at a file that does not exist. The sheets are popovers, so
// they open, close on Escape or a click outside and hand the focus back with no script.
// GUIDES: each platform's guide is one address here; they all open the docs' front page
// until the docs have a page for each.
const guide = { mac: docs, linux: docs, android: docs, herdr: docs, dsh: docs }
// The platforms' signs are drawn here as plain shapes in the text colour. The Apple, Linux,
// Android and Windows signs name those systems; each belongs to its owner.
const sign = {
  mac: '<path d="M12.15 6.9c-.95 0-2.42-1.08-3.96-1.04-2.04.03-3.91 1.18-4.96 3.01-2.12 3.68-.55 9.1 1.52 12.09 1.01 1.45 2.2 3.09 3.79 3.04 1.52-.07 2.09-.99 3.93-.99 1.83 0 2.35.99 3.96.95 1.64-.03 2.68-1.48 3.68-2.95 1.16-1.69 1.64-3.33 1.66-3.42-.04-.01-3.18-1.22-3.22-4.86-.03-3.04 2.48-4.49 2.6-4.56-1.43-2.09-3.62-2.32-4.39-2.38-2-.16-3.68 1.09-4.61 1.09zM15.53 3.83c.84-1.01 1.4-2.43 1.25-3.83-1.21.05-2.66.8-3.53 1.82-.78.9-1.46 2.34-1.28 3.71 1.34.1 2.72-.69 3.56-1.7"/>',
  linux: '<path fill-rule="evenodd" d="M12 1.6c-2.2 0-3.7 1.8-3.7 4.2 0 1.1.1 2-.3 3-.5 1.3-2.3 3-3 5.2-.5 1.6-.5 3.1-.1 4.3-.9.3-1.7.9-1.7 1.7 0 1 1.1 1.3 2.3 1.5 1.2.2 1.9.9 3.1.9.9 0 1.4-.4 1.8-.9h3.2c.4.5.9.9 1.8.9 1.2 0 1.9-.7 3.1-.9 1.2-.2 2.3-.5 2.3-1.5 0-.8-.8-1.4-1.7-1.7.4-1.2.4-2.7-.1-4.3-.7-2.2-2.5-3.9-3-5.2-.4-1-.3-1.9-.3-3 0-2.4-1.5-4.2-3.7-4.2zm0 7.3c1.4 0 2 1.6 2.7 3.3.7 1.6 1 3.5.3 4.9-.5 1-1.7 1.3-3 1.3s-2.5-.3-3-1.3c-.7-1.4-.4-3.3.3-4.9.7-1.7 1.3-3.3 2.7-3.3zM10.5 4.9a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zm3 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zM12 6.7l-1.3.9 1.3.9 1.3-.9z"/>',
  android: '<path fill-rule="evenodd" d="M6.3 9.3 4.7 6.5a.6.6 0 0 1 1-.6l1.7 2.9A11.3 11.3 0 0 1 12 7.8c1.6 0 3.2.4 4.6 1l1.7-2.9a.6.6 0 0 1 1 .6l-1.6 2.8a10.4 10.4 0 0 1 5.3 8.5H1a10.4 10.4 0 0 1 5.3-8.5zM7.5 13a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm9 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z"/>',
  windows: '<path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z"/>',
  iphone: '<path fill-rule="evenodd" d="M8.2 1.5h7.6a2.6 2.6 0 0 1 2.6 2.6v15.8a2.6 2.6 0 0 1-2.6 2.6H8.2a2.6 2.6 0 0 1-2.6-2.6V4.1a2.6 2.6 0 0 1 2.6-2.6zm0 1.8a.8.8 0 0 0-.8.8v15.8c0 .4.4.8.8.8h7.6c.4 0 .8-.4.8-.8V4.1a.8.8 0 0 0-.8-.8zm2.3 1.5h3a.7.7 0 0 1 0 1.4h-3a.7.7 0 0 1 0-1.4z"/>',
}
const platformSign = id => `<svg class="platform-sign" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${sign[id]}</svg>`
const desktopGets = 'Your agent team in one window. Talk with your Bots, hand work over and review what comes back.'
export const platforms = {
  mac: { name: 'Mac', kind: '.dmg', product: 'Automagik Desktop', page: '/desktop/', gets: desktopGets,
    file: 'Automagik-Mac.dmg', needs: 'A Mac with Apple silicon, on macOS 13 or newer.',
    steps: ['Open Automagik-Mac.dmg.', 'Drag the Automagik icon to Applications.', 'Open Automagik from Applications.'],
    download: ['Download for Mac', mac] },
  linux: { name: 'Linux', kind: '.deb', product: 'Automagik Desktop', page: '/desktop/', gets: desktopGets,
    file: 'Automagik-Linux.deb', needs: 'A 64-bit PC. The .deb is for Debian and Ubuntu.',
    steps: ['Open Automagik-Linux.deb and choose Install. Or, in a terminal: <code>sudo apt install ./Automagik-Linux.deb</code>', 'Open Automagik from your apps.'],
    download: ['Download for Linux', linux], other: ['On another Linux, use the', 'AppImage', appImage] },
  android: { name: 'Android', kind: '.apk', product: 'Automagik Mobile', page: '/mobile/',
    gets: 'Your coding agents on your phone. See which ones need you, open their terminals and answer. It pairs with your own machines.',
    file: releases.pocket.url.split('/').pop(), needs: 'Android 8.0 or newer.', sha256: releases.pocket.sha256,
    steps: ['Open the APK on your phone.', 'Allow your browser to install apps when Android asks.', 'Pair it with Pocket Link on your computer.'],
    download: ['Download for Android', releases.pocket.url] },
  windows: { name: 'Windows', product: 'Automagik Desktop', soon: true },
  iphone: { name: 'iPhone', product: 'Automagik Mobile', soon: true },
}
// Which platforms a page offers: all five on the home page, a product's own on its page.
export const offered = { '/': ['mac', 'linux', 'android', 'windows', 'iphone'], '/desktop/': ['mac', 'linux', 'windows'], '/mobile/': ['android', 'iphone'] }
const steps = list => `<ol class="steps">${list.map(step => `<li>${step}</li>`).join('')}</ol>`
// The row. A browser without popovers gets a plain link in each button's place: to the
// product's page from the home page, straight to the file on the product's own page.
function getHook(route, label) {
  const chip = (id) => {
    const { name, kind, soon, page, download } = platforms[id]
    if (soon) return `<li class="get-chip soon">${platformSign(id)}<span class="get-name">${name}</span><small class="get-kind">Soon</small></li>`
    const inside = `${platformSign(id)}<span class="get-name">${name}</span><small class="get-kind">${kind}</small>`
    return `<li><button class="get-chip" type="button" popovertarget="get-${id}" aria-label="${name}: what you get and how to install it">${inside}</button><a class="get-chip get-fallback" href="${route === '/' ? `${page}#install` : download[1]}">${inside}</a></li>`
  }
  return `<div${route === '/' ? '' : ' id="install"'} class="get"><p class="get-label">${label}</p><ul class="get-row">${offered[route].map(chip).join('')}</ul></div>`
}
function getSheets(route) {
  const sheet = (id) => {
    const { name, product, page, gets, file, needs, sha256, steps: list, download, other } = platforms[id]
    const facts = [['File', `<code>${file}</code>`], ['Needs', needs], ...(sha256 ? [['SHA-256', `<code class="sum">${sha256.slice(0, 32)}<wbr>${sha256.slice(32)}</code>`]] : [])]
    return `<div class="sheet" id="get-${id}" popover role="dialog" aria-labelledby="get-${id}-title">
<div class="sheet-head"><span class="sheet-sign">${platformSign(id)}</span><div class="sheet-title"><p class="sheet-kicker">${product}</p><h2 id="get-${id}-title" tabindex="-1" autofocus>For ${name}</h2></div><button class="sheet-close" type="button" popovertarget="get-${id}" popovertargetaction="hide" aria-label="Close">${glyph('close')}</button></div>
<p class="sheet-gets">${gets}</p>
<dl class="sheet-facts">${facts.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('')}</dl>
<h3 class="sheet-how">How to install</h3>${steps(list)}${other ? `<p class="fine">${other[0]} <a href="${other[2]}">${other[1]}</a>.</p>` : ''}
<div class="sheet-actions"><a class="button primary" href="${download[1]}">${download[0]} ${down}</a><a class="detail-link" href="${guide[id]}">${name} guide ${out}</a></div>${route === page ? '' : `
<p class="sheet-more"><a href="${page}">About ${product} ${arrow}</a></p>`}
</div>`
  }
  return (offered[route] ?? []).filter(id => !platforms[id].soon).map(sheet).join('\n')
}
// The logo in the header and the footer: the logo kit's own lockup for small sizes (the
// approved triskle and the lowercase wordmark in one file), unchanged: the ink file on the
// light page, the cream file on the dark one.
export const brand = '<a class="brand" href="/" aria-label="Automagik home"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/automagik-lockup-three-colours-cream-header.svg"><img src="/assets/brand/automagik-lockup-three-colours-ink-header.svg" width="1632" height="264" alt="Automagik"></picture></a>'
// The browser's icons: the kit's favicon set at the site's root, and a manifest that names
// the two large ones.
export const icons = '<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">'
export const manifest = { name: 'Automagik', short_name: 'Automagik', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }], theme_color: '#3c3049', background_color: '#3c3049', display: 'browser', start_url: '/' }
const entry = route => ({ href, name, line, image, mark, glyph: sign, external }) => `<li><a class="menu-item" href="${href}"${href === route ? ' aria-current="page"' : ''}><span class="menu-icon">${mark ?? (image ? art(image, '', { cls: 'menu-art' }) : glyph(sign))}</span><span class="menu-text"><strong>${name}${external ? ` ${out}` : ''}</strong><span>${line}</span></span></a></li>`
// OPEN INTELLIGENCE TAG: we unfold's horizontal tag, the only Open Intelligence mark this
// site uses, applied the way Arca's site applies it. The file is pasted inline as given
// (assets/brand/open-intelligence/, one colour, the text colour around it; its words are live
// text in IBM Plex Mono SemiBold, which the stylesheet loads). In the footer it is 170 by
// 32 px and is a link to we unfold that holds nothing but the tag: no words in the link and
// no sentence beside it. Never redrawn, stretched, outlined, shadowed or recoloured; never
// bigger than the logo it sits with. The official lockup (the logo with the tag under it) is
// built by scripts/build-lockup.mjs into assets/brand/automagik/.
export const oiTag = readFileSync(new URL('../assets/brand/open-intelligence/open-intelligence-tag.svg', import.meta.url), 'utf8').trim()
// THE FAMILY DRAWER: the menu the whole product family shares (Arca's drawer package, issue
// 11, approved by the owner on 2026-11-12). assets/family/ holds the piece as it was given:
// family.html, header-button.html, family.css and family.js, and the art, all byte copies
// (assets/family/SOURCE.md lists each one's sha256). Nothing of it is written here: the
// markup below is the piece's own file with its comments left out, its slots filled, and
// this site's own parts put in the places the piece gives a host:
// - the top block is Automagik, the product whose site this is, with its lockup and line;
// - the list under it is this site's pages that have no row in the drawer; it shows where
//   the header has no room for its menus. A place on the page being read is written as a
//   bare #name, so the piece closes the drawer before going there;
// - addresses on automagik.si are written from this site's root, as every other link here;
// - the row or link of the page being read carries aria-current="page".
// The rows are the approved ones: Automagik's lockup with Desktop and Mobile, then omni,
// genie and mykes, each as its word in the lettering with no mark, "Coming soon." under
// Mykes. No pet, no Genie head, and the triskle beside nothing but Automagik.
// THE HOST IS AUTOMAGIK (the package's issue 11b, "A case of its own"): Automagik appears
// once, as the "You are here" block; the Automagik row is left out; Desktop and Mobile move
// into that block, right under the link and above the list of pages; and Products lists
// Arca first, by its own logo, then omni, genie and mykes.
const familyFile = name => readFileSync(new URL(`../assets/family/${name}`, import.meta.url), 'utf8')
// Arca's logo, the ark with its word: the package's file as it is, to write into a page so it
// takes the text colour. It carries its own name ("arca") for assistive technology.
export const arcaLogo = familyFile('arca-logo-b.svg').trim()
const once = (text, from, to, times = 1) => {
  assert.equal(text.split(from).length - 1, times, `the family piece holds ${from} ${times} time(s)`)
  return text.replaceAll(from, to)
}
export const familyArt = {
  __FAM_LOCKUP_CREAM_64__: 'automagik-lockup-three-colours-cream-64.png', __FAM_LOCKUP_CREAM_48__: 'automagik-lockup-three-colours-cream-48.png',
  __FAM_LOCKUP_INK_64__: 'automagik-lockup-three-colours-ink-64.png', __FAM_LOCKUP_INK_48__: 'automagik-lockup-three-colours-ink-48.png',
  __FAM_LOCKUP_CREAM_128__: 'automagik-lockup-three-colours-cream-128.png', __FAM_LOCKUP_INK_128__: 'automagik-lockup-three-colours-ink-128.png',
  __FAM_WORD_OMNI_CREAM__: 'omni-wordmark-cream.svg', __FAM_WORD_OMNI_INK__: 'omni-wordmark-ink.svg',
  __FAM_WORD_GENIE_CREAM__: 'genie-wordmark-cream.svg', __FAM_WORD_GENIE_INK__: 'genie-wordmark-ink.svg',
  __FAM_WORD_MYKES_CREAM__: 'mykes-wordmark-cream.svg', __FAM_WORD_MYKES_INK__: 'mykes-wordmark-ink.svg',
}
// The host's own parts. The line is the site's own, as in the footer.
export const familyHost = { name: 'Automagik', line: 'Open building blocks of superintelligence.', arcaLine: 'Be your own cloud. Infrastructure for AI agents.' }
// This site's pages with no row in the drawer, for a window whose header has no room for
// the menus. Docs is the drawer's own Support link; the phone app is on Mobile's page.
export const familyLinks = [['/cloud/', 'Cloud'], ['/desktop/#install', 'Get the app'], ['/cloud/#privacy', 'Privacy']]
const withoutComments = html => html.replace(/<!--[\s\S]*?-->\n?/g, '').trim()
// The button: the piece's own markup. With script off it is a plain link, and on this site
// that link goes to the page's own sitemap, the footer, where every page is listed.
export const familyButton = once(withoutComments(familyFile('header-button.html')).split('\n')[0], 'href="https://automagik.si/"', 'href="#sitemap"')
export function family(route) {
  let html = withoutComments(familyFile('family.html'))
  // The piece's own lockup markup, as it stands in the Automagik row, for the top block too:
  // there the link has no name of its own, so the picture carries it.
  const lockup = html.match(/<span class="fam-lockup"><picture class="fam-lock-cream">.*?<\/picture><picture class="fam-lock-ink">.*?<\/picture><\/span>/)[0]
  // Arca's row in Products: the piece's own Arca item, as it stands in the piece's top block,
  // without "You are here", as a logo row. The logo is the package's file, inline, so it
  // takes the text colour.
  let arcaRow = html.match(/<a class="fam-item is-here" .*?<\/a>/)[0]
  arcaRow = once(arcaRow, 'class="fam-item is-here"', 'class="fam-item is-logo"')
  arcaRow = once(arcaRow, ' aria-current="page"', '')
  arcaRow = once(arcaRow, '<span class="fam-here">You are here</span>', '')
  arcaRow = once(arcaRow, '__FAM_ARCA__', arcaLogo)
  html = once(html, '__FAM_ARCA__', once(lockup, 'alt=""', `alt="${familyHost.name}"`, 2))
  html = once(html, 'href="https://automagik.si/arca/" data-family-product="Arca"', `href="/" data-family-product="${familyHost.name}"`)
  html = once(html, familyHost.arcaLine, familyHost.line, 2)
  // "You are here" is the site. On the home page that is also the page being read.
  html = once(html, ' aria-current="page"><span class="fam-words"><span class="fam-logo">', ` aria-current="${route === '/' ? 'page' : 'true'}"><span class="fam-words"><span class="fam-logo">`)
  const links = familyLinks.map(([href, name]) => {
    const [path, place] = href.split('#')
    return `<li><a href="${place && path === route ? `#${place}` : href}"${href === route ? ' aria-current="page"' : ''}>${name}</a></li>`
  }).join('')
  const list = html.match(/(<ul class="fam-links" data-family-links aria-label="Sections">)(.*?)(<\/ul>)/)
  html = once(html, list[0], list[1] + links + list[3])
  // The host is Automagik: its row is left out, Desktop and Mobile stand in the top block
  // right under the link, and Arca is the first of the products.
  const apps = html.match(/<span class="fam-apps" role="group" aria-label="The Automagik app">.*?<\/span>/)[0]
  const row = html.match(/\n  <div class="fam-top">\n    <a class="fam-home" .*<\/a>\n    (.*)\n  <\/div>/)
  assert.equal(row[1], apps, 'the Automagik row holds the lockup and the two app buttons')
  html = once(html, row[0], '')
  html = once(html, '\n    <ul class="fam-links"', `\n    ${apps}\n    <ul class="fam-links"`)
  html = once(html, '<ul class="fam-list">\n', `<ul class="fam-list">\n    <li>${arcaRow}</li>\n`)
  for (const [slot, name] of Object.entries(familyArt)) html = html.replaceAll(slot, `/assets/family/${name}`)
  html = once(html, 'href="https://automagik.si/', 'href="/', 6)
  assert.doesNotMatch(html, /__FAM_|automagik\.si|fam-top|fam-home/, 'every slot is filled, every address is this site\'s own, and Automagik has no row of its own')
  if (route !== '/' && html.includes(`href="${route}" data-family-product=`)) html = once(html, `href="${route}" data-family-product=`, `href="${route}" aria-current="page" data-family-product=`)
  return html
}
// The header: the family's menu button first, at the window's left edge, then the logo, the
// three menus and one button. The menus need no script: each button opens its panel through
// the browser's own popover. The browser keeps the button's expanded state, closes the panel
// on Escape or a click outside, and returns focus to the button. Hover opens the same panel
// in CSS. Where the header has no room for the menus, the drawer carries the site's pages.
function header(route) {
  const here = products.find(({ href }) => href === route)
  const groups = [
    ['products', 'Products', products, `<span>Use one, or bring them together.</span><a href="/#blocks">All products ${arrow}</a>`],
    ['resources', 'Resources', resources, `<span>${licensing}</span>`],
    ['company', 'Company', company, `<span>${partOf()}</span>`],
  ]
  const menus = groups.map(([id, label, items, foot]) => {
    const current = id === 'products' && here
    return `<li class="menu"><button class="menu-button" type="button" popovertarget="menu-${id}"${current ? ' data-here' : ''}>${label}${current ? `<span class="menu-here"><span class="sr">, current page: </span>${here.name}</span>` : ''}${glyph('chevron', 'chev')}</button><div class="menu-panel" id="menu-${id}" popover><div class="menu-card"><ul class="menu-list">${items.map(entry(route)).join('')}</ul><p class="menu-foot">${foot}</p></div></div></li>`
  }).join('')
  return `<header class="top topbar">${familyButton}<div class="wrap top-inner topbar-in">${brand}<nav class="main-nav" aria-label="Main navigation"><ul class="menus">${menus}</ul></nav><a class="button primary small top-cta" href="/desktop/#install">Get the app</a></div></header>`
}
function footer(route) {
  const column = (label, items) => `<nav aria-label="${label}"><p class="footer-head">${label}</p>${items.map(({ href, name, external }) => `<a href="${href}"${href === route ? ' aria-current="page"' : ''}>${name}${external ? ` ${out}` : ''}</a>`).join('')}</nav>`
  // The one link to the repository on a page is the quiet one at the end of the footer.
  return `<footer class="site-footer"><div id="sitemap" class="wrap footer-grid"><div class="footer-brand">${brand}<p>Open building blocks of superintelligence.</p><p class="footer-part">${partOf()}</p></div>${column('Products', products)}${column('Resources', resources)}${column('Company', company)}<div class="footer-end"><p class="footer-license">${licensing} ${trademarks} <a href="${repo}">Source code ${out}</a></p><a class="oi-tag" href="${weUnfold.url}">${oiTag}</a></div></div></footer>`
}
// Every product page says where it is and leads back to all products.
function crumbs(route) {
  const here = products.find(({ href }) => href === route)
  return `<nav class="crumbs wrap" aria-label="Breadcrumb"><ol><li><a href="/#blocks">All products</a></li><li><span aria-current="page">${here.name}</span></li></ol></nav>`
}
function frame(route, title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${title} · Automagik</title><meta name="description" content="Automagik: open building blocks of superintelligence. Desktop, Mobile, Omni, Genie, Cloud, Arca and Mykes."><meta name="theme-color" content="#f6eee2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#1e1923" media="(prefers-color-scheme: dark)"><link rel="canonical" href="https://automagik.si${route}">${icons}<link rel="preload" href="/assets/brand/fredoka-latin.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/brand/dm-sans-latin.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/assets/family/family.css"><link rel="stylesheet" href="/styles.css"></head>
<body><div class="page" data-family-page><a class="skip" href="#main">Skip to content</a>${header(route)}
<main id="main">${route === '/' ? '' : crumbs(route)}${body}</main>
${footer(route)}</div>${getSheets(route) ? `\n${getSheets(route)}` : ''}
${family(route)}
<script src="/assets/family/family.js" defer></script></body></html>\n`
}
// The other blocks, each with its own art: the way on from every page.
function more(route) {
  const items = blocks.filter(([href]) => href !== route).map(([href, label, image, line]) => `<li><a href="${href}">${art(image, '', { cls: `more-art more-${image}` })}<span><strong>${label}</strong><span>${line}</span></span></a></li>`).join('')
  // Previous and next walk the pages this site builds, in the products' order. Arca's page is
  // Arca's own and has no pager that leads back, so the round passes it by: after Cloud comes
  // Mykes. The menus, the drawer, the footer and the home card still lead to Arca.
  const round = products.filter(({ href }) => routes.includes(href))
  const at = round.findIndex(({ href }) => href === route), step = by => round[(at + by + round.length) % round.length]
  const previous = step(-1), next = step(1)
  const pager = `<nav class="pager" aria-label="Previous and next product"><a class="pager-link" rel="prev" href="${previous.href}"><small><span aria-hidden="true">←</span> Previous</small><strong>${previous.name}</strong></a><a class="pager-all" href="/#blocks">All products</a><a class="pager-link next" rel="next" href="${next.href}"><small>Next ${arrow}</small><strong>${next.name}</strong></a></nav>`
  return `<section class="more wrap" aria-labelledby="more-title"><h2 id="more-title" class="more-title">More building blocks</h2><ul class="more-list">${items}</ul>${pager}</section>`
}
// A product's own logo: the brand folder's lockup for that name, unchanged: the product's own
// flat mark (Genie's lamp, Omni's vortex, Mykes's cords) beside its name in the brand's
// lettering (the brand's rule 10). The triskle lockups these replaced are retired: the
// triskle is Automagik's alone. `small` asks for the drawing made for small sizes, for a
// card: only Omni has one (under about 56 px its large vortex's suckers turn to specks);
// the lamp and the cords have one drawing each. The ink file shows on a light ground and the
// cream one on a dark ground; `ground: 'dark'` is a card that stays dark in both themes.
// [file stem, frame width (the frame is 264 high), has a drawing for small sizes].
export const PRODUCT_LOCKUPS = { genie: ['genie-lamp-lockup', 1115, false], omni: ['omni-mark-lockup', 885, true], mykes: ['mykes-clean-lockup', 1058, false] }
export const productLogo = (name, { small = false, ground, attrs = 'loading="lazy" decoding="async"' } = {}) => {
  const [stem, width, header] = PRODUCT_LOCKUPS[name.toLowerCase()], file = tone => `/assets/brand/${stem}-${tone}${small && header ? '-header' : ''}.svg`
  const image = tone => `<img class="product-logo" src="${file(tone)}" width="${width}" height="264" alt="${name}" ${attrs}>`
  return ground === 'dark' ? image('cream') : `<picture><source media="(prefers-color-scheme: dark)" srcset="${file('cream')}">${image('ink')}</picture>`
}
const heading = (eyebrow, title, intro) => `<p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="intro">${intro}</p>`

export function pages() {
  const preview = 'Automagik Mobile, in the app’s own interface preview with sample data'
  const phoneAlt = {
    home: `${preview}: the Home tab, with the agents that need you first.`,
    chat: `${preview}: a Bot’s chat asks for approval to run the tests, with No and Yes buttons.`,
    code: `${preview}: the Code tab, with three projects and their Bots.`,
  }
  const [term, rest] = weUnfold.openIntelligence.split(/(?<=:) /)
  assert.ok(rest, 'the Open Intelligence line starts with its name and a colon')
  const openLine = `<span class="ink-grad">${term}</span> ${rest}`
  const phone = (screen, cls, eager = false) => `<div class="phone ${cls}">${art(`pocket-${screen}`, phoneAlt[screen], { dark: true, sizes: '(max-width: 700px) 220px, 300px', eager })}</div>`

  const home = `<section class="hero home-hero">${constellation()}<div class="wrap home-hero-inner"><div class="hero-heading center">${heading('Automagik', 'Open building blocks of <span class="ink-grad">superintelligence.</span>', 'Tools that put your own agents to work. Use one, or bring them together.')}${getHook('/', 'Get Automagik for')}<p class="hero-also"><a href="#blocks">Or see every block ${down}</a></p></div>
<div class="scene"><div class="cast">${art('genie', 'Genie, Automagik’s clay character: a dark round face with a swirl of magenta hair.', { cls: 'scene-genie', eager: true })}<p class="bubble">A team of AI helpers that lives in your chats.</p>${art('omni', 'Omni, Automagik’s clay octopus, smiling.', { cls: 'scene-omni', eager: true })}</div><figure class="window scene-window">${art('team-chat', 'The real Automagik app: a fictional team’s chat. Pip, who leads the team, passes a request for a CSV export on to Genie and reports that it is running.', { dark: true, narrow: 'team-chat-phone', sizes: '(max-width: 700px) 94vw, (max-width: 1140px) 92vw, 1040px', eager: true })}</figure></div></div></section>
${usedRow()}
<section id="blocks" class="blocks wrap" aria-labelledby="blocks-title"><div class="section-heading"><p class="eyebrow">Choose a building block</p><h2 id="blocks-title">Start where your work is.</h2><p class="lede">Open a block to see what it does and how to use it.</p></div>
<div class="bento">
<article class="product-card" data-block="desktop"><div class="tile-copy"><p class="tile-tag">Mac and Linux</p><h3><a href="/desktop/">Automagik Desktop</a></h3><p>Your agent team, in your chats. A place to talk, hand work over and review what comes back.</p><span class="detail-link" aria-hidden="true">Download or install →</span></div><div class="tile-art window">${art('app-review-crop', 'The Automagik app: the team in the sidebar, and a finished wish’s report with the files it changed.', { dark: true, sizes: '(max-width: 700px) 640px, (max-width: 1100px) 92vw, 760px' })}</div></article>
<article class="product-card" data-block="mobile"><div class="tile-copy"><p class="tile-tag">Android</p><h3><a href="/mobile/">Automagik Mobile</a></h3><p>Your coding agents on your Android phone, paired to your own machines.</p><span class="detail-link" aria-hidden="true">Take your team along →</span></div><div class="tile-art">${phone('chat', 'tile-phone')}</div></article>
<article class="product-card" data-block="omni"><div class="tile-copy"><p class="tile-tag">Chat apps</p><h3><a href="/omni/">${productLogo('Omni', { small: true })}</a></h3><p>Connect your chat apps to Automagik, with channels and canvases in the same window.</p><span class="detail-link" aria-hidden="true">Meet Omni →</span></div><div class="tile-art">${art('omni', 'Omni, the clay octopus.', { cls: 'tile-omni' })}</div></article>
<article class="product-card" data-block="genie"><div class="tile-copy"><p class="tile-tag">Wishes</p><h3><a href="/genie/">${productLogo('Genie', { small: true, ground: 'dark' })}</a></h3><p>Turn a wish into a branch, a test run and a report you approve.</p><ol class="wish-steps" aria-label="What a wish becomes"><li>Wish</li><li>Branch</li><li>Test run</li><li>Report</li></ol><span class="detail-link" aria-hidden="true">Meet Genie →</span></div><div class="tile-art">${art('genie', 'Genie, the clay character with magenta hair.', { cls: 'tile-genie' })}${art('lamp', '', { cls: 'tile-lamp' })}</div></article>
<article class="product-card" data-block="cloud"><div class="tile-art">${art('pet', 'The Automagik triskelion as a clay character with a small face.', { cls: 'tile-pet' })}</div><div class="tile-copy"><p class="tile-tag soon">Coming soon</p><h3><a href="/cloud/">Cloud</a></h3><p>One sign-in, organisations and hosted workspaces. Register your interest.</p><span class="detail-link" aria-hidden="true">Explore Cloud →</span></div></article>
<article class="product-card" data-block="arca"><div class="tile-copy">${arcaArk}<h3><a href="/arca/">Arca</a></h3><p>${arca.line}</p><span class="detail-link" aria-hidden="true">Get Arca →</span></div></article>
</div>
<div class="also"><p class="also-label">Also on the way</p><article class="product-card"><h3><a href="/mykes/">Mykes</a></h3><p>Coming soon.</p></article></div></section>
<section class="wrap open" aria-labelledby="open-title"><div class="open-copy"><h2 id="open-title" class="open-line">${openLine}</h2><p class="open-part">${partOf()}</p></div></section>
<section id="film" class="made wrap" aria-labelledby="made-title"><div class="made-copy"><p class="eyebrow">Made by this team</p><h2 id="made-title">From inside Automagik.</h2><p>This page began as Genie’s draft, in a group chat with our launch team.</p></div><figure class="film-still" data-film="placeholder">${art('team-step', 'The Automagik app’s team step, recorded: Pip leads, Omni sleeps until powered on, and Genie is ready for a wish.', { dark: true })}<figcaption><strong>A short film is coming.</strong> It shows our launch team at work.</figcaption></figure></section>
<section id="brand" class="wrap kit" aria-labelledby="kit-title"><figure class="kit-logo"><picture><source media="(prefers-color-scheme: dark)" srcset="${lockup}-cream.svg"><img src="${lockup}-ink.svg" width="1628" height="529" alt="The Automagik logo, with the Open Intelligence tag under it at the right" loading="lazy" decoding="async"></picture></figure><div class="kit-copy"><p class="eyebrow">Brand</p><h2 id="kit-title">The Automagik logo</h2><p>The official logo, for print and press. Use it as it is.</p><dl class="kit-files"><div><dt>For light grounds</dt><dd><a href="${lockup}-ink.svg" download>SVG ${down}</a><a href="${lockup}-ink.png" download>PNG ${down}</a></dd></div><div><dt>For dark grounds</dt><dd><a href="${lockup}-cream.svg" download>SVG ${down}</a><a href="${lockup}-cream.png" download>PNG ${down}</a></dd></div></dl></div></section>`

  const desktop = `<section class="hero split-hero desktop-hero"><div class="wrap split"><div class="hero-heading">${art('app-icon', '', { cls: 'hero-icon', eager: true })}${heading('Your team, at your desk', 'Automagik Desktop', 'Bots that stay, each with its own name, role, model and memory. Talk with them, hand work over and keep the decisions that matter.')}${getHook('/desktop/', 'Download for')}<p class="fine">Mac with Apple silicon, macOS 13 or newer. Linux on a 64-bit PC.</p></div></div>
<div class="wrap stage-frame">${constellation()}<figure class="window wide-window">${art('app-review', 'The real Automagik app: a fictional team in the sidebar, a finished wish’s report with its four edited files, and the new file open for review.', { dark: true, narrow: 'thread-phone', sizes: '(max-width: 700px) 92vw, (max-width: 1100px) 92vw, 1040px', eager: true })}</figure></div><p class="wrap caption">The real app, with a fictional team and project. The AI’s replies are scripted; the commands, tests and file changes are real.</p></section>
<section class="wrap ways" aria-labelledby="ways-title"><div class="section-heading"><p class="eyebrow">Two more ways in</p><h2 id="ways-title">Code mode and Team mode.</h2><p class="lede">The app’s switch still says Work for Team mode. Code mode installs separately.</p></div><ul class="way-list"><li id="herdr"><span class="glyph-chip cyan">${glyph('terminal')}</span><div class="way-copy"><h3>Install on Herdr</h3><p>Code mode: your code agents in the Herdr window. It needs Herdr and the Automagik pack; the app alone does not set it up.</p></div><a class="detail-link" href="${guide.herdr}">Herdr guide ${out}</a></li><li id="dsh"><span class="glyph-chip lilac">${glyph('plug')}</span><div class="way-copy"><h3>Install on DSH</h3><p>Already on DeepSeek Harness? Add the Automagik Bot team through its plugin installer.</p></div><a class="detail-link" href="${guide.dsh}">DSH guide ${out}</a></li></ul></section>
<section class="wrap principles-section" aria-labelledby="yours-title"><div class="section-heading"><p class="eyebrow">Make it yours</p><h2 id="yours-title">Your model. Your files. Your team.</h2></div><div class="principles"><article><span class="glyph-chip cyan">${glyph('ai')}</span><h3>Bring your AI.</h3><p>Connect an AI account or an API key. Each Bot runs on the model you give it. Omni and an AI account can wait until you are ready.</p></article><article><span class="glyph-chip lilac">${glyph('files')}</span><h3>Keep your files and memory.</h3><p>The team keeps its files in your computer’s <code>.automagik</code> folder. What Bots read and write goes to your connected AI provider under its terms.</p></article><article><span class="glyph-chip pink">${glyph('secret')}</span><h3>Secrets the Bots never see.</h3><p>Type keys and passwords into a card in the chat. The Bot never sees the value.</p></article><article><span class="glyph-chip cream">${glyph('ask')}</span><h3>Permission, with clear limits.</h3><p>It asks before sending as you to a person, deleting something or disconnecting a channel. Main and Omni Bots can read chats and post to groups, WhatsApp channels and your own chat without asking. Other Bots ask for chat access; an Always grant lets them post to that group again.</p></article></div></section>
<section class="wrap first-steps" aria-labelledby="steps-title"><div class="section-heading"><p class="eyebrow">First steps</p><h2 id="steps-title">Install the app.</h2></div><div class="install-grid"><article><h3>Mac</h3>${steps(platforms.mac.steps)}</article><article><h3>Linux</h3>${steps(platforms.linux.steps)}<p class="fine">On another Linux, use the <a href="${appImage}">AppImage</a>.</p></article></div></section>${more('/desktop/')}`

  const mobile = `<section class="hero split-hero mobile-hero"><div class="wrap split"><div class="hero-heading">${heading('Pocket, with your team', 'Automagik Mobile', 'Your coding agents on your Android phone, paired to your own machines.')}${getHook('/mobile/', 'Download for')}<p class="fine">Android 8.0 or newer.</p></div><div class="hero-visual stage-disc">${constellation()}${phone('home', 'hero-phone', true)}</div></div></section>
<section class="wrap close" aria-labelledby="close-title"><div class="close-copy"><p class="eyebrow">On your phone</p><h2 id="close-title">Keep your agents close.</h2><p class="lede">See which agents need you, open their terminals and answer from your phone. Teams and code spaces come from your own machines.</p></div><div class="close-phones">${phone('chat', 'close-phone')}${phone('code', 'close-phone')}</div></section>
<section class="wrap pair" aria-labelledby="pair-title"><div class="pair-card"><div class="pair-steps"><h2 id="pair-title">Pair with Pocket Link.</h2><ol class="steps"><li>Add Pocket Link to Herdr on your computer.</li><li>Choose Pair a phone.</li><li>Scan the QR code in Automagik Mobile.</li></ol></div><div class="pair-notes"><p class="pair-free">No Cloud account is needed.</p><p class="fine">Open the APK on your phone and allow your browser to install apps when Android asks. Pocket Link needs Herdr desktop and herdr-core on macOS or Linux.</p><a class="detail-link" href="${docs}">Set up Pocket Link ${out}</a></div></div></section>${more('/mobile/')}`

  const omni = `<section class="hero split-hero omni-hero"><div class="wrap split"><div class="hero-heading">${heading('Your chats, connected', productLogo('Omni', { attrs: 'fetchpriority="high" decoding="async"' }), 'The service that links your chat apps to Automagik, with channels and canvases in the same window.')}<div class="actions"><a class="button primary" href="/desktop/">Use it with Desktop ${arrow}</a><a class="button secondary" href="${docs}">Read the docs ${out}</a></div></div><div class="hero-visual omni-visual">${constellation()}${art('omni', 'Omni, Automagik’s clay octopus, smiling.', { cls: 'hero-omni', eager: true })}${art('omni-faces', 'Omni’s seven clay expressions, from pleased to sorry.', { cls: 'faces', eager: true })}</div></div></section>
<section class="wrap omni-story" aria-labelledby="bring-title"><article class="story-copy"><p class="eyebrow">Channels</p><h2 id="bring-title">Bring your conversations.</h2><p>WhatsApp, Telegram, Slack and other channels sit beside your team. Connect an Omni when you are ready.</p><ul class="chips" aria-label="Channels named here"><li>WhatsApp</li><li>Telegram</li><li>Slack</li><li>Other channels</li></ul></article><figure class="story-art">${art('omni-card', 'The Automagik app’s team step: Omni sleeps until you press its power button.', { dark: true })}<figcaption>In the app, Omni sleeps until you bring it along.</figcaption></figure></section>
<section class="wrap omni-canvas" aria-labelledby="canvas-title"><div class="canvas-card"><p class="eyebrow">Canvases</p><h2 id="canvas-title">Put work in the conversation.</h2><p>In a Main Bot’s canvas, lists, boards and forms can keep themselves up to date. Give Bots access to the chats where they should work.</p></div><p class="fine">No live channel or personal conversation is shown here. Permissions and their exceptions are in the <a href="${docs}">docs</a>.</p></section>${more('/omni/')}`

  const genie = `<section class="hero split-hero genie-hero"><div class="wrap split"><div class="hero-heading">${heading('Wish → branch → report', productLogo('Genie', { attrs: 'fetchpriority="high" decoding="async"' }), 'A wish becomes a branch, a test run and a report you approve.')}<div class="actions"><a class="button primary" href="/desktop/">Open your team ${arrow}</a><a class="button secondary" href="${docs}">Read the docs ${out}</a></div><p class="fine"><code class="command">genie desktop</code> opens it on the team.</p></div><div class="hero-visual genie-visual">${constellation()}${art('genie', 'Genie, Automagik’s clay character, smiling with eyes closed.', { cls: 'hero-genie', eager: true })}${art('lamp', 'Genie’s clay lamp in plum, cyan and magenta.', { cls: 'hero-lamp', eager: true })}</div></div></section>
<section class="wrap flow" aria-labelledby="flow-title"><div class="section-heading"><p class="eyebrow">One wish, start to finish</p><h2 id="flow-title">From a wish to a report you approve.</h2></div><ol class="flow-steps"><li><figure class="window">${art('ask', 'Recorded app capture: a fictional Northwind request for a CSV export, which Pip passes to Genie.', { dark: true })}</figure><h3>The wish</h3><p>Ask in the chat. Genie takes the project work.</p></li><li><figure class="window">${art('checks', 'Recorded app capture: the wish runs the project’s tests and the export on its own branch; both tests pass.', { dark: true })}</figure><h3>A branch and a test run</h3><p>Each wish runs in its own copy of the project, on its own branch.</p></li><li><figure class="window">${art('report', 'Recorded app capture: Genie reports the CSV export is done, with nothing pushed or merged.', { dark: true })}</figure><h3>A report you approve</h3><p>The report comes back to the chat. Merging stays your call.</p></li></ol><p class="caption">Genie reports the CSV export branch back to the fictional Northwind team. Model replies are scripted; commands, commits and file changes are real. Nothing was pushed or merged.</p>${art('genie-faces', 'Genie’s seven clay expressions, from beaming to sorry.', { cls: 'faces genie-faces' })}</section>${more('/genie/')}`

  const cloud = `<section class="hero split-hero cloud-hero"><div class="wrap split"><div class="hero-heading">${heading('<span class="soon-pill">Coming soon</span>', 'Automagik Cloud', 'One sign-in, organisations and hosted workspaces, with a place to open each workspace.')}<p class="lede">Cloud is not live. It will be a private, paid service, with public contracts. Register your interest and tell us what you would like your agents to do.</p><div class="actions"><a class="button primary" href="#interest">Register your interest ${down}</a></div></div><div class="hero-visual cloud-visual">${constellation()}${triskle('hero-mark', 'The Automagik triskelion: three clay strokes in cyan, magenta and violet.')}${art('pet', '', { cls: 'hero-pet', eager: true })}</div></div></section>
<section id="interest" class="wrap form-section" aria-labelledby="build-title"><div class="form-intro"><h2 id="build-title">What would you build?</h2>${waitlistIntro()}</div><div class="form-card">${waitlistForm()}${privacyNote()}</div></section>${more('/cloud/')}`

  const coming = name => `<section class="hero coming"><div class="wrap"><div class="coming-card">${constellation()}<div class="hero-heading center">${heading('An Automagik building block', productLogo(name, { attrs: 'fetchpriority="high" decoding="async"' }), 'Coming soon.')}</div></div></div></section>${more('/mykes/')}`

  return new Map([
    ['/', frame('/', 'Open building blocks of superintelligence', home)],
    ['/desktop/', frame('/desktop/', 'Desktop', desktop)], ['/mobile/', frame('/mobile/', 'Mobile', mobile)],
    ['/omni/', frame('/omni/', 'Omni', omni)], ['/genie/', frame('/genie/', 'Genie', genie)],
    ['/cloud/', frame('/cloud/', 'Cloud', cloud)], ['/mykes/', frame('/mykes/', 'Mykes', coming('Mykes'))],
  ])
}
export function rootFiles() {
  const arcaSitemap = '<url><loc>https://automagik.si/arca/</loc></url> <url><loc>https://automagik.si/arca/llms.txt</loc></url> <url><loc>https://automagik.si/arca/index.md</loc></url>'
  return new Map([
    ['site.webmanifest', `${JSON.stringify(manifest, null, 2)}\n`],
    ['robots.txt', 'User-agent: *\nAllow: /\nAllow: /arca\nSitemap: https://automagik.si/sitemap.xml\n'],
    ['sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map(route => `<url><loc>https://automagik.si${route}</loc></url>`).join('\n')}
${arcaSitemap}
</urlset>
`],
    ['llms.txt', `# Automagik

> Open building blocks of superintelligence.

## Building blocks

- [Automagik Desktop](https://automagik.si/desktop/): Mac and Linux downloads; install on Herdr or DSH.
- [Automagik Mobile](https://automagik.si/mobile/): the Android companion for your own machines.
- [Omni](https://automagik.si/omni/): connect chat apps to your agent team.
- [Genie](https://automagik.si/genie/): a wish, a branch, a test run and a report.
- [Cloud](https://automagik.si/cloud/): coming soon; register your interest.
- [Automagik Arca, the page](https://automagik.si/arca/)
- [Automagik Arca, for an assistant](https://automagik.si/arca/llms.txt)
- [Mykes](https://automagik.si/mykes/): coming soon.

## Crawling

All crawlers are allowed, including AI training crawlers, and every page may be indexed.
`],
  ])
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = [...pages()].map(([route, html]) => [`${route.slice(1)}index.html`, html])
  for (const [path, text] of [...files, ...rootFiles()]) {
    const target = new URL(`../${path}`, import.meta.url)
    if (process.argv[2] === '--check') assert.equal(await readFile(target, 'utf8'), text, `Regenerate ${path}`)
    else { await mkdir(new URL('.', target), { recursive: true }); await writeFile(target, text) }
  }
}
