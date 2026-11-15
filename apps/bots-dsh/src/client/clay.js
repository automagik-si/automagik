import { dmSansLatin, fredokaLatin } from './art/inline.js'

// -------------------------------------------------------------------------
// The Automagik clay theme: the team's default look (themes.js `deepseek`, the id saved
// choices keep). Everything is a piece of stop-motion modelling clay on a calm cream table,
// lit from the upper left: a piece has a highlight bevel on its upper left, a shade bevel on
// its lower right, a ledge (its own side, seen under it) and a soft contact shadow. At rest a
// piece stands on its ledge; under the pointer it lifts; pressed it sinks onto the ledge;
// selected it is lilac (the mix of Omni's cyan and your magenta) and stands a little higher;
// a field is a hollow pressed into the clay. Light first; DSH's dark palette
// (body[data-ds-dark-theme]: DSH's Appearance setting, which follows the system unless the
// person picks one) is the same clay at night.
//
// The colours are proposed values sampled from the owner's clay landing page (cream table,
// plum ink, softened cyan and magenta), recorded here as proposals, not brand standards.
// The welcome (apps/welcome-dsh src/client/clay.js) restates the same tokens.

// The logo's pigments (the owner's automagik-*.svg: the cyan piece left, the magenta one
// right) and the ink of the tab icon, by day and at night.
export const LOGO = Object.freeze({ left: '#2bc3b6', right: '#d1376b', ink: '#3c3049', night: '#f3e9dd' })

export const CLAY_LIGHT = Object.freeze({ bg: '#f6eee2', sidebar: '#efe3d1', bubble: '#cdedf3', card: '#fbf5ec', text: '#3c3049', user: '#f3c8e6', userText: '#3c3049', accent: '#1b7f96' })
export const CLAY_DARK = Object.freeze({ bg: '#1e1923', sidebar: '#18141c', bubble: '#24434b', card: '#2a2330', text: '#f3e9dd', user: '#7a4470', userText: '#fdf0f8', accent: '#7fd8ea' })

const FONT = '"DM Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
// The brand's title face and its three weights (docs/brand: tokens/tokens.json, fonts/). 536 is the
// logo letters' weight; Fredoka is never set heavier.
const HEAD = 'Fredoka,"DM Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
const DSH_TEXT = '"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif'

// A raised piece of `fill`, standing `depth` px on its ledge.
const raised = (fill, depth = 3) => `background:${fill};box-shadow:inset 2px 3px 4px color-mix(in srgb,${fill} var(--clay-hi),var(--clay-shine)),inset -3px -4px 6px color-mix(in srgb,${fill} var(--clay-lo),var(--clay-umber)),0 ${depth}px 0 color-mix(in srgb,${fill} var(--clay-ledge),var(--clay-umber)),0 ${depth + 3}px ${depth + 5}px var(--clay-cast),0 ${depth * 3 + 4}px ${depth * 5 + 8}px var(--clay-cast-far)`
// Lifted under the pointer: higher on its ledge, its shadow wider and softer.
const lifted = (fill, depth = 3) => `transform:translateY(-2px);${raised(fill, depth + 2)}`
// Pressed onto its ledge.
const pressed = (fill, depth = 3) => `transform:translateY(${Math.max(1, depth - 1)}px);box-shadow:inset 3px 4px 6px color-mix(in srgb,${fill} var(--clay-lo),var(--clay-umber)),inset -1px -2px 3px color-mix(in srgb,${fill} var(--clay-hi),var(--clay-shine)),0 1px 0 color-mix(in srgb,${fill} var(--clay-ledge),var(--clay-umber)),0 2px 3px var(--clay-cast)`
// A hollow pressed into the clay around it: fields, grooves, tracks.
const recessed = fill => `background:${fill};box-shadow:inset 3px 4px 6px color-mix(in srgb,${fill} var(--clay-lo),var(--clay-umber)),inset -2px -2px 3px color-mix(in srgb,${fill} var(--clay-hi),var(--clay-shine)),0 1px 0 color-mix(in srgb,var(--bt-main) var(--clay-hi),var(--clay-shine))`
// A broad slab the others rest on (the sidebar, the conversation, a side panel): only its
// bevels, no ledge, so it reads as the table's own thickness.
const slab = fill => `background:${fill};box-shadow:inset 3px 4px 7px color-mix(in srgb,${fill} var(--clay-hi),var(--clay-shine)),inset -4px -5px 9px color-mix(in srgb,${fill} var(--clay-lo),var(--clay-umber))`
// Every declaration of `css` marked !important, to win over the base sheet's own !important rules.
const important = css => css.split(';').map(rule => `${rule}!important`).join(';')
const move = 'transition:transform .16s cubic-bezier(.3,1.4,.5,1),box-shadow .16s ease,background-color .16s ease'

const TOKENS = `
@font-face{font-family:"DM Sans";font-style:normal;font-weight:100 1000;font-display:swap;src:url("${dmSansLatin}") format("woff2")}
@font-face{font-family:"Fredoka";font-style:normal;font-weight:300 700;font-display:swap;size-adjust:105%;src:url("${fredokaLatin}") format("woff2")}
html body{
  --bt-font:var(--dsh-font-family-text,${FONT}),${FONT};--bt-head-font:${HEAD};--bt-weight-title:536;--bt-weight-strong:469;--bt-weight-label:402;--dsh-font-family-text-default:${DSH_TEXT};
  --clay-cyan:#8fdcec;--clay-cyan-ink:#1d4753;--clay-pink:#f0bddf;--clay-pink-ink:#5a2550;--clay-lilac:#e0cff3;--clay-lilac-ink:#45305e;
  --clay-cream:#f2e6d5;--clay-niche:#ebdecb;--clay-ok:#047960;--clay-bad:#90040a;
  --clay-shine:#fff;--clay-umber:#5b3b22;--clay-hi:42%;--clay-lo:80%;--clay-ledge:72%;
  --clay-cast:rgba(111,81,53,.2);--clay-cast-far:rgba(121,91,53,.1);--clay-ring:#b4498f;
  --clay-r-xs:9px 10px 8px 10px;--clay-r-sm:12px 14px 12px 13px;--clay-r-md:16px 18px 15px 17px;--clay-r:19px 22px 18px 21px;--clay-r-lg:24px 28px 23px 27px;--clay-r-xl:28px 32px 27px 31px;
  --clay-r-you:20px 23px 8px 21px;--clay-r-bot:20px 23px 21px 8px;
  --st-ok:#047960;--st-okdot:#04ae84;--st-bad:#90040a;--st-warn:#945e06;--st-warndot:#e39a1f;--st-work:#00859d;--st-warn-strong:#7f5105;--st-bad-strong:#90040a;
  --bt-hover:rgba(91,59,34,.07);--bt-active:rgba(91,59,34,.12);--bt-danger:#90040a;--bt-green:#047960;
  --dsw-focus-ring-color:var(--clay-ring)}
html body[data-ds-dark-theme]{
  --clay-cyan:#5cbdd1;--clay-cyan-ink:#0d262c;--clay-pink:#b76aa1;--clay-pink-ink:#fff2fa;--clay-lilac:#55456b;--clay-lilac-ink:#f4ecff;
  --clay-cream:#322a39;--clay-niche:#16121a;--clay-ok:#91f1be;--clay-bad:#e8695f;
  --clay-shine:#fff;--clay-umber:#000;--clay-hi:84%;--clay-lo:62%;--clay-ledge:50%;
  --clay-cast:rgba(0,0,0,.42);--clay-cast-far:rgba(0,0,0,.28);--clay-ring:#f2a6dc;
  --st-ok:#91f1be;--st-okdot:#71e8a8;--st-bad:#e8695f;--st-warn:#f4cc7e;--st-warndot:#f4bb43;--st-work:#3faec2;--st-warn-strong:#f4cc7e;--st-bad-strong:#ffa89e;
  --bt-hover:rgba(255,240,225,.07);--bt-active:rgba(255,240,225,.12);--bt-danger:#e8695f;--bt-green:#91f1be}
html body ::selection{background:var(--clay-lilac);color:var(--clay-lilac-ink)}
`

// DSH's frame: the table, then the sidebar, the conversation and the side panel as slabs on
// it, a few pixels apart like the landing page's app. Its composer is a hollow; its send
// button, a cyan piece.
const SHELL = `
html body [class*="_frame"]{background:var(--bt-main)!important}
html body [class*="_sidebarCol"]{background:var(--bt-main)!important}
html body [class*="_sidebarCol"]>[data-slot=sidebar]>[class*="_root"]{margin:8px 0 8px 8px;height:calc(100% - 16px);border-radius:var(--clay-r-lg);overflow:hidden;${slab('var(--bt-sidebar)')}}
html body [data-slot="main.conversation"]>[class*="_root"]{margin:8px;height:calc(100% - 16px);border-radius:var(--clay-r-lg);overflow:hidden;${slab('var(--bt-main)')}}
html body [class*="_sidebarCol"]{border:0!important}
html body [class*="_rightbarCol"]{background:var(--bt-main)!important;border:0!important}
html body [class*="_rightbarCol"] section[class*="_tabHost"][class*="_pane"]{margin:8px 8px 8px 0;height:calc(100% - 16px);border:0;border-radius:var(--clay-r-lg);overflow:hidden;${slab('var(--bt-sidebar)')}}
html body [data-composer-card]{${important(recessed('var(--clay-niche)'))};border:0!important;border-radius:var(--clay-r)!important}
html body [data-composer-card]:hover{border:0!important}
html body [data-composer-card]:focus-within{border:0!important;box-shadow:inset 3px 4px 6px color-mix(in srgb,var(--clay-niche) var(--clay-lo),var(--clay-umber)),inset -2px -2px 3px color-mix(in srgb,var(--clay-niche) var(--clay-hi),var(--clay-shine)),0 0 0 1.5px color-mix(in srgb,var(--clay-ring) 40%,transparent)!important}
html body [data-composer-card] button[class*="_primary"]{${important(raised('var(--clay-cyan)', 2))};color:var(--clay-cyan-ink)!important}
html body [data-composer-card] button[class*="_primary"]:active:not(:disabled){${important(pressed('var(--clay-cyan)', 2))}}
html body :is(.bt-plus,.bt-mic){${raised('var(--clay-cream)', 2)};color:var(--bt-ink-2);${move}}
html body :is(.bt-plus,.bt-mic):hover{${lifted('var(--clay-cream)', 2)};color:var(--bt-ink)}
html body :is(.bt-plus,.bt-mic):active{${pressed('var(--clay-cream)', 2)}}
html body .bt-voice{${raised('var(--clay-cyan)', 2)};color:var(--clay-cyan-ink)}
html body [class*="_toBottomSlot"]>button{${important(raised('var(--bt-card)', 3))};color:var(--bt-ink)!important}
`

// The team's own sidebar: its rows lie flat on the slab until the pointer lifts one; the
// open one is a lilac piece. The round buttons and the Channels button are cream pieces.
const SIDEBAR = `
html body .bt-side{font-family:var(--bt-font)}
html body .bt-row,html body .bt-tile{border-radius:var(--clay-r);${move}}
html body .bt-row:hover,html body .bt-tile:hover{${raised('color-mix(in srgb,var(--bt-card) 70%,var(--bt-sidebar))', 2)}}
html body .bt-row[aria-current=page],html body .bt-tile[aria-current=page]{${raised('var(--clay-lilac)', 3)};color:var(--clay-lilac-ink);transform:translateY(-1px)}
html body .bt-row:active,html body .bt-tile:active{${pressed('var(--clay-lilac)', 3)}}
html body .bt-row[aria-current=page] .bt-row-preview{color:color-mix(in srgb,var(--clay-lilac-ink) 72%,transparent)}
html body .bt-row[aria-current=page] .bt-row-preview-ask{color:var(--st-warn-strong)}
html body .bt-tile-name,html body .bt-brand{font-family:var(--bt-head-font);font-weight:var(--bt-weight-strong)}
html body .bt-chip{background:color-mix(in srgb,var(--bt-card) 60%,transparent);border:0;border-radius:999px;padding:1px 7px}
html body :is(.bt-round,.bt-connect){border:0;${raised('var(--bt-card)', 3)};${move}}
html body :is(.bt-round,.bt-connect):hover{${lifted('var(--bt-card)', 3)}}
html body :is(.bt-round,.bt-connect):active{${pressed('var(--bt-card)', 3)}}
html body .bt-unread{background:var(--clay-pink);box-shadow:inset 1px 1px 1px rgba(255,255,255,.5),0 1px 0 color-mix(in srgb,var(--clay-pink) var(--clay-ledge),var(--clay-umber))}
html body .bt-badge-working{background:var(--clay-ok)}
`

// Buttons across the team's pages: the primary ones are cyan pieces, the others cream.
const BUTTONS = `
html body :is(.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send){${raised('var(--clay-cyan)', 3)};color:var(--clay-cyan-ink);${move}}
html body :is(.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send):hover:not(:disabled){opacity:1;${lifted('var(--clay-cyan)', 3)}}
html body :is(.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send):active:not(:disabled){${pressed('var(--clay-cyan)', 3)}}
html body :is(.bt-soft,.bt-q-btn,.bt-pill,.bt-model-chip,.bt-head button){border:0;${raised('var(--bt-card)', 3)};${move}}
html body :is(.bt-soft,.bt-q-btn,.bt-pill,.bt-model-chip,.bt-head button):hover:not(:disabled){${lifted('var(--bt-card)', 3)}}
html body :is(.bt-soft,.bt-q-btn,.bt-pill,.bt-model-chip,.bt-head button):active:not(:disabled){scale:none;${pressed('var(--bt-card)', 3)}}
html body .bt-icon-btn:hover{background:var(--bt-hover)}
html body :is(.bt-state,.bt-token){border:0;${raised('var(--bt-card)', 2)}}
html body .bt-state[aria-pressed=true]{${raised('var(--clay-lilac)', 2)};color:var(--clay-lilac-ink)}
`

// Tabs and segmented choices: a groove pressed into the clay with a lilac bead in it.
const TABS = `
html body :is(.bt-tabs,.bt-seg,.bt-avedit-tabs){border-radius:var(--clay-r-md);padding:4px;${recessed('var(--clay-niche)')}}
html body .bt-tabs{margin:16px 16px 0;align-self:center}
html body :is(.bt-tabs,.bt-seg,.bt-avedit-tabs)>.bt-thumb,html body :is(.bt-tab,.bt-avedit-tab)[aria-selected=true],html body .bt-seg button[aria-pressed=true]{${raised('var(--clay-lilac)', 2)};color:var(--clay-lilac-ink)}
html body :is(.bt-tabs,.bt-seg,.bt-avedit-tabs)[data-glide] :is(.bt-tab,.bt-avedit-tab,button)[aria-selected=true],html body .bt-seg[data-glide] button[aria-pressed=true]{background:transparent;box-shadow:none;color:var(--clay-lilac-ink)}
html body :is(.bt-tabs,.bt-avedit-tabs)>.bt-thumb{border-radius:var(--clay-r-sm)}
html body .bt-seg>.bt-thumb{border-radius:var(--clay-r-xs)}
html body :is(.bt-tab,.bt-avedit-tab){min-height:28px;font-weight:600}
`

// What the chat shows: your messages are magenta pieces, a Bot's are cyan ones; cards (a
// question, a task, a canvas) are cream slabs standing on the transcript.
const CHAT = `
html body [class*="_userRow"] [class*="_bubble"],html body [data-chat-flow-kind=question-reply] [class*="_bubble"],html body [data-chat-flow-kind=command-input] [class*="_bubble"]{border-radius:var(--clay-r-you)!important;${important(raised('var(--bt-user)', 3))};padding:9px 14px!important}
html body .bt-ububble{border-radius:var(--clay-r-you);${raised('var(--bt-user)', 3)};padding:9px 14px}
html body .bt-bubble{border-radius:var(--clay-r-bot);${raised('var(--bt-bubble)', 3)};padding:9px 14px;margin-bottom:3px}
html body .bt-msg:not(:first-child)>.bt-msg-line>.bt-bubble{border-start-start-radius:10px}
html body .bt-msg:not(:last-child)>.bt-msg-line>.bt-bubble{border-end-start-radius:10px}
html body :is(.bt-q,.bt-create-inline,.bt-create-looks,.bt-addlist,.bt-mem-reply){border:0;border-radius:var(--clay-r-lg);${raised('var(--bt-card)', 4)}}
html body .bt-q{--bt-q-edge:transparent}
html body .bt-q-raised{${raised('var(--bt-card)', 5)}}
html body .bt-q-opt[aria-pressed=true],html body button.bt-q-opt:active{${raised('var(--clay-lilac)', 2)};color:var(--clay-lilac-ink)}
html body .bt-key{border-radius:var(--clay-r-xs);${raised('var(--clay-cream)', 2)}}
html body .bt-q-title,html body .bt-create-name,html body .bt-drawer-name,html body .bt-mem-head h2,html body .bt-mem-summary h3,html body .bt-mem-empty-title{font-family:var(--bt-head-font);font-weight:var(--bt-weight-title);letter-spacing:-.01em}
html body .op-task{padding:0;background:none;border-radius:var(--clay-r-lg);animation:op-card-in .45s cubic-bezier(.2,.8,.2,1)}
html body .op-task-in{border-radius:var(--clay-r-lg);padding:16px 18px;${raised('var(--bt-card)', 4)}}
html body .op-task-mark{border-radius:var(--clay-r-sm);${raised('var(--clay-cyan)', 2)};color:var(--clay-cyan-ink)}
html body .op-task[data-state=done] .op-task-mark{${raised('var(--clay-ok)', 2)};color:var(--bt-card)}
html body .op-task[data-state=failed] .op-task-mark{${raised('var(--clay-bad)', 2)};color:var(--bt-card)}
html body .op-task-kicker{color:var(--bt-ink-2);font-family:var(--bt-head-font)}
html body .op-task-title{font-family:var(--bt-head-font);font-weight:var(--bt-weight-strong)}
html body .op-task-bar{height:9px;border-radius:999px;${recessed('var(--clay-niche)')}}
html body .op-task-bar i{top:1px;bottom:1px;border-radius:999px;background:linear-gradient(90deg,var(--clay-cyan),var(--clay-lilac),var(--clay-pink));box-shadow:inset 1px 1px 1px rgba(255,255,255,.5),inset -1px -1px 2px rgba(0,0,0,.15)}
html body .op-task-open{color:var(--bt-accent)}
html body .bt-time-sep,html body [class*="_scroll"]>[class*="_column"]::before{font-family:var(--bt-head-font);font-weight:var(--bt-weight-title);font-size:11px;letter-spacing:.12em;text-transform:uppercase}
`

// Panels, overlays and menus: the details panel and pages are slabs; menus and pop-overs are
// cream pieces lifted off the table, their shadow longer than a resting piece's.
const PANELS = `
html body .bt-panel{border-left:0;${slab('var(--bt-sidebar)')}}
html body :is(.bt-menu,.bt-drop,.bt-avedit,.bt-react-strip){border:0;border-radius:var(--clay-r-md);${raised('var(--bt-card)', 3)};box-shadow:inset 2px 3px 4px color-mix(in srgb,var(--bt-card) var(--clay-hi),var(--clay-shine)),inset -3px -4px 6px color-mix(in srgb,var(--bt-card) var(--clay-lo),var(--clay-umber)),0 3px 0 color-mix(in srgb,var(--bt-card) var(--clay-ledge),var(--clay-umber)),0 14px 18px var(--clay-cast),0 30px 44px var(--clay-cast-far)}
html body .bt-menu button{border-radius:var(--clay-r-xs)}
html body .bt-menu button:hover,html body .bt-option[aria-selected=true]{${raised('var(--clay-lilac)', 2)};color:var(--clay-lilac-ink)}
html body :is(.bt-settings,.bt-mem){border:0;border-radius:var(--clay-r-xl);${raised('var(--bt-main)', 6)}}
html body .bt-settings-item[aria-current=page],html body .bt-settings-item[aria-selected=true]{color:var(--clay-lilac-ink)}
html body .bt-set-card{border:0;border-radius:var(--clay-r);${raised('var(--bt-card)', 3)}}
html body .bt-mem-row{border:0;border-radius:var(--clay-r-sm);${raised('var(--bt-card)', 2)}}
html body :is(.bt-input,.bt-textarea,.bt-q-field,.bt-drawer-name-input,.bt-mem-ask){border:0;border-radius:var(--clay-r-sm);${recessed('var(--clay-niche)')}}
html body .bt-mem-ask{border-radius:999px}
html body :is(.bt-input,.bt-textarea,.bt-drawer-name-input):focus,html body :is(.bt-q-field,.bt-mem-ask):focus-within{outline:2px solid var(--clay-ring);outline-offset:2px}
html body :is(.bt-q-submit,.bt-q-btn,.bt-q-opt):focus-visible{outline-color:var(--clay-ring)}
html body .bt-browser-action-choice input{accent-color:var(--bt-accent)}
html body .bt-swatch{box-shadow:inset 2px 2px 3px rgba(255,255,255,.4),inset -2px -2px 3px rgba(0,0,0,.2),0 2px 0 rgba(0,0,0,.16)}
html body .bt-swatch[aria-pressed=true]{border-color:var(--bt-ink);transform:translateY(-1px)}
html body .bt-range input::-webkit-slider-runnable-track{height:8px;${recessed('var(--clay-niche)')};background:linear-gradient(to right,var(--clay-cyan) var(--bt-fill),var(--clay-niche) var(--bt-fill))}
html body .bt-range input::-webkit-slider-thumb{width:18px;height:18px;margin-top:-5px;${raised('var(--bt-card)', 2)}}
`

const REDUCED = `
@media (prefers-reduced-motion:reduce){html body :is(.bt-row,.bt-tile,.bt-round,.bt-connect,.bt-soft,.bt-q-btn,.bt-pill,.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send,.bt-plus,.bt-mic){transition:none!important;transform:none!important}}
body[data-bt-motion=quiet] :is(.bt-row,.bt-tile,.bt-round,.bt-connect,.bt-soft,.bt-q-btn,.bt-pill,.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send,.bt-plus,.bt-mic){transition:none!important}
`

export const CLAY_CSS = TOKENS + SHELL + SIDEBAR + BUTTONS + TABS + CHAT + PANELS + REDUCED

// What DSH's own surfaces take from the theme (ctx.theme.overrideTokens, on top of the
// colours themes.js derives from the eight): its cards, menus, rows and focus ring.
export function clayShellTokens({ light, dark }) {
  const both = (l, d) => ({ light: l, dark: d })
  return {
    '--dsw-alias-bg-layer-1': both(light.card, dark.card),
    '--dsw-alias-bg-layer-2': both(light.card, dark.card),
    '--dsw-alias-settings-card-fill': both(light.card, dark.card),
    '--dsw-alias-settings-card-stroke': both('rgba(91,59,34,.10)', 'rgba(255,240,225,.10)'),
    '--dsw-specific-menu': both(light.card, dark.card),
    '--dsw-alias-interactive-bg-hover': both('rgba(91,59,34,.07)', 'rgba(255,240,225,.07)'),
    '--dsw-alias-interactive-bg-active': both('rgba(91,59,34,.12)', 'rgba(255,240,225,.12)'),
    '--dsw-specific-sidebar-nav-item-hover': both('rgba(91,59,34,.07)', 'rgba(255,240,225,.07)'),
    '--dsw-specific-sidebar-nav-item-active': both('#e0cff3', '#55456b'),
    '--dsw-alias-border-l1': both('rgba(91,59,34,.10)', 'rgba(255,240,225,.10)'),
    '--dsw-alias-border-l2': both('rgba(91,59,34,.14)', 'rgba(255,240,225,.14)'),
    '--dsw-alias-border-l3': both('rgba(91,59,34,.20)', 'rgba(255,240,225,.20)'),
    '--dsw-alias-toast-bg': both(light.text, dark.card),
    '--dsw-alias-toast-label': both(light.card, dark.text),
    '--dsw-alias-tooltip-bg': both(light.text, dark.card),
    '--dsw-alias-onboarding-card-fill': both(light.card, dark.card),
    '--dsw-focus-ring-color': both('#b4498f', '#f2a6dc'),
  }
}
