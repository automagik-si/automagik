// Browser fixture for the new left bar's parts (left-bar-*.js): the project rail, the Team rows,
// the status marks and the view's Chat and Terminal switch, with the Bot team's real styles,
// themes and Bot art, on made-up data. Every name here is invented. The head, the Code line, the
// Account row and the view beside the bar (all of it but its switch) are stand-ins drawn by this
// page only, so the parts sit where direction C puts them: they are not product parts.
import { createElement as h, useState } from 'react'
import { SHELL_CSS } from '../../src/client/styles.js'
import { PET_CSS } from '../../src/client/pet.js'
import { allThemes, themeCss } from '../../src/client/themes.js'
import { markArt } from '../../src/client/clay-art.js'
import { BotMark } from '../../src/client/mark.js'
import { Wordmark } from '../../src/client/logo.js'
import { LEFT_BAR_CSS, tokenCss } from '../../src/client/left-bar-css.js'
import { StatusMark } from '../../src/client/left-bar-status.js'
import { TeamRows } from '../../src/client/left-bar-team.js'
import { ProjectRail } from '../../src/client/left-bar-rail.js'
import { FaceSwitch } from '../../src/client/left-bar-faces.js'
// The brand's own marks, unchanged (docs/brand, "Which logo file"): ink on a light ground, cream
// on a dark one; Omni's small drawing, since a tile is under 56 px.
import lampInk from '../../../../docs/brand/logo/svg/genie-lamp-ink.svg'
import lampCream from '../../../../docs/brand/logo/svg/genie-lamp-cream.svg'
import vortexInk from '../../../../docs/brand/logo/svg/omni-mark-ink-32.svg'
import vortexCream from '../../../../docs/brand/logo/svg/omni-mark-cream-32.svg'

const { createRoot } = window.nativeSeeds['react-dom/client']

const PAGE_CSS = `
html,body,#root{height:100%;margin:0}
body{background:var(--bt-main);overflow:hidden;-webkit-font-smoothing:antialiased}
.fx-win{display:flex;width:100vw;height:100vh;background:var(--bt-main)}
.fx-head{flex:none;display:flex;align-items:center;gap:4px;height:50px;padding:0 10px 0 16px;box-sizing:border-box}
.fx-grow{flex:1}
.fx-tool{flex:none;display:grid;place-items:center;width:30px;height:30px;color:var(--lb-muted)}
.fx-flip{flex:none;display:flex;align-items:center;gap:9px;height:36px;margin:0 8px;padding:0 10px;box-sizing:border-box;font:var(--bt-weight-strong) 14.5px/1.3 var(--bt-head-font)}
.fx-count{display:inline-flex;align-items:center;gap:5px;font:400 12px/1 var(--bt-font);color:var(--lb-muted)}
.fx-foot{flex:none;display:flex;align-items:center;gap:9px;height:44px;margin:0 8px 4px;padding:0 6px 0 8px;box-sizing:border-box;border-top:1px solid var(--lb-line);font:var(--bt-weight-label) 14px/1.3 var(--bt-head-font)}
.fx-me{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--lb-tile-ground)}
.fx-view{flex:1;min-width:0;display:flex;flex-direction:column;color:var(--bt-ink);font:400 15px/1.5 var(--bt-font)}
.fx-view-head{flex:none;display:flex;align-items:center;gap:10px;height:66px;padding:0 24px 0 16px;box-sizing:border-box;border-bottom:1px solid var(--lb-line)}
.fx-view-name{font:var(--bt-weight-strong) 17px/1.3 var(--bt-head-font);letter-spacing:-.01em}
.fx-view-role{font-size:13px;opacity:.72}
.fx-view-tool{color:color-mix(in srgb,var(--bt-ink) 72%,transparent)}
.fx-talk{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;gap:10px;width:100%;max-width:760px;margin:0 auto;padding:0 24px 18px;box-sizing:border-box}
.fx-said{max-width:520px;padding:10px 14px;border-radius:18px;align-self:flex-start;background:var(--bt-bubble)}
.fx-said-you{align-self:flex-end;background:var(--bt-user);color:var(--bt-user-ink)}
.fx-draft{flex:none;width:100%;max-width:712px;height:86px;margin:0 auto 22px;padding:14px 16px;box-sizing:border-box;border-radius:20px;background:var(--st-paper);box-shadow:inset 0 0 0 1px var(--st-line-2);opacity:.9}
`
const style = document.createElement('style')
document.head.append(style)
let extra = ''
const paint = (id) => { style.textContent = SHELL_CSS + PET_CSS + LEFT_BAR_CSS + PAGE_CSS + themeCss(allThemes()[id]) + extra }
window.setTheme = (id, dark) => {
  paint(id)
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

const bot = (id, name, shape, color, more = {}) => ({ id, name, avatar: { shape }, color, status: 'idle', ...more })
const chat = (id, name, status = 'idle') => ({ id, name, status })
const HELP = { id: 'ch-help', kind: 'whatsapp', name: 'Help desk', chats: [chat('mika', 'Mika', 'working'), chat('tess', 'Tess', 'needs')] }
const STORE = { id: 'ch-store', kind: 'telegram', name: 'Storefront', chats: [chat('order', 'Order 1042')] }
const FRONT = { id: 'ch-front', kind: 'telegram', name: 'Front desk', chats: [chat('noa', 'Noa', 'working'), chat('bakery', 'Corner bakery'), chat('ivo', 'Ivo', 'needs'), chat('weekend', 'Weekend crew')] }
const JUNO = bot('juno', 'Juno', 'octopus', 'deepseek', { status: 'working' })
const WREN = bot('wren', 'Wren', 'moon', 'violet', { unread: true })
const OTTO = bot('otto', 'Otto', 'acorn', 'orange')
const pip = store => bot('pip', 'Pip', 'star', 'cyan', { status: 'needs', channels: [HELP, store] })
const CREW = { id: 'crew', name: 'Launch crew', members: ['wren', 'otto'] }

const TEAMS = {
  team: { frontId: 'juno', bots: [JUNO, pip(STORE), WREN, OTTO], groups: [CREW] },
  many: {
    frontId: 'juno',
    bots: [
      JUNO, pip({ ...STORE, folded: true }),
      bot('kit', 'Kit', 'bunny', 'magenta', { status: 'working', channels: [FRONT] }),
      bot('zuri', 'Zuri', 'hex', 'orange', { status: 'needs' }),
      WREN, bot('lark', 'Lark', 'gumdrop', 'red', { unread: true }), bot('miso', 'Miso', 'kitty', 'yellow', { status: 'working' }), OTTO, bot('nico', 'Nico', 'gem', 'cyan'),
      bot('bram', 'Bram', 'peanut', 'green'), bot('sol', 'Sol', 'saucer', 'yellow'), bot('tully', 'Tully', 'pebbles', 'blue', { status: 'off' }),
    ],
    sections: [{ label: 'Front desk', bots: ['pip', 'kit', 'zuri'] }, { label: 'Studio', bots: ['wren', 'lark', 'miso', 'otto', 'nico'] }, { label: 'Back office', bots: ['bram', 'sol', 'tully'] }],
    groups: [CREW, { id: 'studio', name: 'Studio sync', members: ['lark', 'wren', 'miso'] }],
  },
  // Every status once, the one direction C's cases do not hold (error) among them.
  marks: {
    bots: [
      bot('a', 'Working', 'star', 'cyan', { status: 'working' }), bot('b', 'Needs you', 'moon', 'violet', { status: 'needs' }),
      bot('c', 'Idle', 'acorn', 'orange'), bot('d', 'Error', 'gumdrop', 'red', { status: 'error' }), bot('e', 'Not running', 'pebbles', 'blue', { status: 'off' }),
      bot('f', 'A long name that runs out of its row before the mark', 'kitty', 'yellow', { status: 'needs' }),
    ],
  },
  empty: { bots: [] },
}
const PROJECTS = [
  { id: 'automagik', name: 'Automagik', icon: markArt(28), status: 'working' },
  { id: 'genie', name: 'Genie', icon: { light: lampInk, dark: lampCream }, iconSize: 30, status: 'needs' },
  { id: 'omni', name: 'Omni', icon: { light: vortexInk, dark: vortexCream }, iconSize: 27 },
  { id: 'harbor', name: 'Harbor' },
]

// A channel's glyph is the channels plugin's to draw; these two stand in for it, in one colour.
const GLYPHS = {
  whatsapp: [h('path', { key: 'a', d: 'M12 3.6a8.4 8.4 0 0 0-7.2 12.8L3.7 20.3l4-1.1A8.4 8.4 0 1 0 12 3.6z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }), h('path', { key: 'b', d: 'M9.2 8.3c-.3 0-.7.1-.9.5-.3.5-.5 1.2-.2 2.1.6 1.8 2.3 3.5 4.1 4.1.9.3 1.6.1 2.1-.2.4-.2.5-.6.5-.9l-.1-.4-1.6-.8-.9 1c-1-.4-1.9-1.3-2.3-2.3l1-.9-.8-1.6z', fill: 'currentColor' })],
  telegram: [h('path', { key: 'a', d: 'M20.5 4.5 3.5 11.2l5.3 1.9 2 6.1 3-3.3 4.4 3.3z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }), h('path', { key: 'b', d: 'M8.8 13.1 16.8 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })],
}
const renderGlyph = channel => h('svg', { viewBox: '0 0 24 24' }, GLYPHS[channel.kind])
const line = (paths, size = 18) => h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths.map(d => h('path', { key: d, d })))

// The open Bot's view, as a quiet stand-in: the bar is compared beside it, as in the design's
// pictures. Its switch is the real part; the page keeps which face is open.
function View() {
  const [face, setFace] = useState('chat')
  const onFace = (next) => { window.opened.push(`face:${next}`); setFace(next) }
  return h('main', { className: 'fx-view' },
    h('header', { className: 'fx-view-head' }, h(BotMark, { bot: JUNO, size: 28 }), h('span', { className: 'fx-view-name' }, JUNO.name), h('span', { className: 'fx-view-role' }, 'Orchestrator'),
      h('span', { className: 'fx-grow' }), h(FaceSwitch, { face, onFace }),
      h('span', { className: 'fx-tool fx-view-tool' }, line(['M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M10 9.2v4.3', 'M10 6.6h.01'], 16))),
    h('div', { className: 'fx-talk' },
      h('div', { className: 'fx-said' }, 'Morning. Tess on Help desk is waiting for you, and Mika is being answered now.'),
      h('div', { className: 'fx-said fx-said-you' }, 'Open Tess first.'),
      h('div', { className: 'fx-said' }, 'Opening it. I will keep the launch notes moving meanwhile.')),
    h('div', { className: 'fx-draft' }, 'Message Juno'))
}

function Page({ kase, skin, fill }) {
  const team = TEAMS[kase]
  const projects = kase === 'empty' ? PROJECTS.slice(0, 1) : PROJECTS
  const live = kase !== 'empty' && kase !== 'marks'
  return h('div', { className: 'fx-win' },
    h('div', { className: 'lb-bar', 'data-lb-skin': skin, 'data-lb-fill': fill ? '' : undefined },
      h(ProjectRail, { projects, currentId: 'automagik', onOpen: project => window.opened.push(`project:${project.id}`), onAdd: () => window.opened.push('add') }),
      h('section', { className: 'lb-list' },
        h('div', { className: 'fx-head' }, h(Wordmark, { height: 28 }), h('span', { className: 'fx-grow' }),
          h('span', { className: 'fx-tool' }, line(['M9 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M13.2 13.2 17 17'])), h('span', { className: 'fx-tool' }, line(['M10 4.5v11M4.5 10h11']))),
        h(TeamRows, { team, current: kase === 'marks' ? undefined : 'bot:juno', skin, renderGlyph, onOpen: row => window.opened.push(row.key) }),
        h('div', { className: 'fx-flip' }, line(['M4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4z', 'M6.5 8l2.5 2.5L6.5 13', 'M11 13h3.5']), 'Code', h('span', { className: 'fx-grow' }),
          live ? h('span', { className: 'fx-count' }, h(StatusMark, { status: 'working' }), '2') : null, live ? h('span', { className: 'fx-count' }, h(StatusMark, { status: 'needs' }), '1') : null),
        h('div', { className: 'fx-foot' }, h('span', { className: 'fx-me' }, line(['M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M4.5 16.5c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5'])), 'Account'))),
    fill || kase === 'empty' || kase === 'marks' ? null : h(View))
}

let root = null
window.opened = []
// `tokens` is a change of tokens alone, as a later skin or the owner's answer would be.
window.mount = ({ kase = 'team', skin, fill = false, tokens, theme = 'deepseek' } = {}) => {
  root?.unmount()
  window.opened = []
  extra = tokens ? tokenCss('body', tokens) : ''
  paint(theme)
  root = createRoot(document.getElementById('root'))
  root.render(h(Page, { kase, skin, fill }))
}
