import { dmSansLatin, fredokaLatin } from './art/inline.js'

// -------------------------------------------------------------------------
// Direction C, "stage and bench": the team's default look (themes.js `deepseek`, the id saved
// choices keep). The team stands on a coloured stage at the left; everything you work in sits
// on a flat cream bench with hairline dividers; what needs you or runs docks in the panel at
// the right. One elevation (--st-lift) for what floats: menus, dialogs, the chosen segment.
// Clay only on the characters, the logo and the send button. Type scale: 11, 12, 14 (body),
// 16, 20, 28, 40. The owner's direction C mockups (stage, bench, live rail) are the reference;
// the clay sheet (clay.js) stays as the `clay` theme.

export const STAGE_LIGHT = Object.freeze({ bg: '#f6eee2', sidebar: '#fbf6ee', bubble: '#dcf0f3', card: '#fffdf9', text: '#3c3049', user: '#f6d8ec', userText: '#3c3049', accent: '#007087' })
export const STAGE_DARK = Object.freeze({ bg: '#1e1923', sidebar: '#262029', bubble: '#22414a', card: '#2b2431', text: '#f3e9dd', user: '#5c3556', userText: '#fdf0f8', accent: '#7fd8ea' })

const FONT = '"DM Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
// The brand's title face and its three weights (docs/brand: tokens/tokens.json, fonts/). 536 is the
// logo letters' weight; Fredoka is never set heavier.
const HEAD = 'Fredoka,"DM Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
const DSH_TEXT = '"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif'

const TOKENS = `
@font-face{font-family:"DM Sans";font-style:normal;font-weight:100 1000;font-display:swap;src:url("${dmSansLatin}") format("woff2")}
@font-face{font-family:"Fredoka";font-style:normal;font-weight:300 700;font-display:swap;size-adjust:105%;src:url("${fredokaLatin}") format("woff2")}
html body{
  --bt-font:var(--dsh-font-family-text,${FONT}),${FONT};--bt-head-font:${HEAD};--bt-weight-title:536;--bt-weight-strong:469;--bt-weight-label:402;--dsh-font-family-text-default:${DSH_TEXT};
  --st-stage:linear-gradient(170deg,#d3eff4 0%,#e4dcf5 55%,#f7d9ea 100%);--st-spot:rgba(255,253,249,.62);--st-tag:rgba(255,253,249,.92);
  --st-raised:#fbf6ee;--st-paper:#fffdf9;--st-sunk:#efe5d6;
  --st-r-stage:26px;--st-r-dialog:24px;--st-r-menu:14px;--st-r-seg:9px;
  --st-line:rgba(60,48,73,.13);--st-line-2:rgba(60,48,73,.24);
  --st-ok:#047960;--st-okdot:#04ae84;--st-bad:#90040a;--st-warn:#945e06;--st-warndot:#e39a1f;--st-work:#00859d;--st-warn-strong:#7f5105;--st-bad-strong:#90040a;
  --st-cyan:#8fdcec;--st-cyan-ink:#1d4753;--st-lilac:#e6dcf6;--st-lilac-ink:#4b3a73;--st-ring:#a73d83;
  --st-lift:0 1px 0 rgba(91,59,34,.06),0 14px 32px -12px rgba(91,59,34,.32);
  --st-clay:inset 2px 2px 3px rgba(255,255,255,.6),inset -2px -3px 5px rgba(91,59,34,.16),0 2px 0 rgba(91,59,34,.15),0 10px 22px -8px rgba(111,81,53,.36);
  --st-hollow:inset 1px 2px 4px rgba(91,59,34,.12);--st-cast:rgba(91,59,34,.26);
  --bt-hover:rgba(60,48,73,.06);--bt-active:rgba(60,48,73,.1);--bt-danger:#90040a;--bt-green:#047960;
  --dsw-focus-ring-color:var(--st-ring)}
html body[data-ds-dark-theme]{
  --st-stage:linear-gradient(170deg,#173840 0%,#2a2440 55%,#3d2234 100%);--st-spot:rgba(255,245,235,.1);--st-tag:rgba(255,245,235,.14);
  --st-raised:#262029;--st-paper:#2b2431;--st-sunk:#18141c;
  --st-line:rgba(243,233,221,.12);--st-line-2:rgba(243,233,221,.22);
  --st-ok:#91f1be;--st-okdot:#71e8a8;--st-bad:#e8695f;--st-warn:#f4cc7e;--st-warndot:#f4bb43;--st-work:#3faec2;--st-warn-strong:#f4cc7e;--st-bad-strong:#ffa89e;
  --st-cyan:#5cbdd1;--st-cyan-ink:#0d262c;--st-lilac:#4a3d61;--st-lilac-ink:#f1e9ff;--st-ring:#f2a6dc;
  --st-lift:0 1px 0 rgba(0,0,0,.3),0 14px 32px -12px rgba(0,0,0,.6);
  --st-clay:inset 2px 2px 3px rgba(255,255,255,.25),inset -2px -3px 5px rgba(0,0,0,.35),0 2px 0 rgba(0,0,0,.35),0 10px 22px -8px rgba(0,0,0,.6);
  --st-hollow:inset 1px 2px 4px rgba(0,0,0,.35);--st-cast:rgba(0,0,0,.45);
  --bt-hover:rgba(255,240,225,.07);--bt-active:rgba(255,240,225,.12);--bt-danger:#e8695f;--bt-green:#91f1be}
html body ::selection{background:var(--st-lilac);color:var(--st-lilac-ink)}
html body{font-family:var(--bt-font)}
`

// DSH's frame: the bench is the whole window; the sidebar is the stage, a coloured card set
// into it; the conversation lies flat on the bench; a side panel is divided off by a hairline.
const FRAME = `
html body [class*="_frame"],html body [class*="_sidebarCol"],html body [class*="_centerCol"]{background:var(--bt-main)!important}
html body [class*="_sidebarCol"]{border:0!important}
html body [class*="_sidebarCol"]>[data-slot=sidebar]>[class*="_root"]{margin:12px;width:auto!important;height:calc(100% - 24px);border-radius:var(--st-r-stage);overflow:hidden;background:var(--st-stage)!important;box-shadow:none;border:0}
html body [data-slot="main.conversation"]>[class*="_root"]{background:var(--bt-main)!important;box-shadow:none;border:0}
html body [class*="_rightbarCol"]{background:var(--bt-main)!important;border:0!important;border-left:1px solid var(--st-line)!important}
html body [class*="_rightbarCol"] section[class*="_tabHost"][class*="_pane"]{background:var(--bt-main);border:0;box-shadow:none}
html body .bt-head{min-height:64px;padding:18px 24px 12px;--bt-island-top:18px;--bt-island-lift:-3px;--bt-island-radius:12px}
html body header[class*="_header"]:has(.bt-head)>[class*="_headerLeading"]{padding-top:18px;padding-bottom:12px}
html body .bt-head :is(.bt-head-title,.bt-head-name){font:var(--bt-weight-title) 20px/26px var(--bt-head-font);letter-spacing:-.01em}
`

// The stage: the brand, the team as characters standing in a row, the open one in a cream
// spotlight on a clay pedestal; the round buttons are cream tags.
const STAGE = `
html body .bt-side{font-family:var(--bt-font);color:var(--bt-ink)}
html body .bt-brand-name,html body .bt-brand{font:var(--bt-weight-strong) 16px/22px var(--bt-head-font)}
html body .bt-round{width:30px;height:30px;border:0;border-radius:10px;background:var(--st-tag);color:var(--bt-ink);box-shadow:none}
html body .bt-round:hover{background:var(--st-paper)}
html body .bt-side-top{margin-bottom:8px}
html body .bt-list{display:flex;flex-direction:column;gap:4px}
html body .bt-row-body{display:flex;flex-direction:column;gap:2px}
html body .bt-row,html body .bt-tile{border-radius:18px;background:transparent;box-shadow:none;transition:background-color .16s ease}
html body .bt-row:hover,html body .bt-tile:hover{background:color-mix(in srgb,var(--st-spot) 60%,transparent)}
html body .bt-row[aria-current=page],html body .bt-tile[aria-current=page]{background:var(--st-spot);color:var(--bt-ink);transform:none}
html body .bt-row[aria-current=page] .bt-row-preview{color:var(--bt-ink-2)}
html body .bt-row-title,html body .bt-tile-name{font-weight:600}
html body .bt-row-preview{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
html body .bt-row .bt-row-preview-ask,html body .bt-row[aria-current=page] .bt-row-preview-ask{color:var(--st-warn-strong)}
html body .bt-row>:is(svg,.bt-mark,.bt-cluster){position:relative;width:44px;height:44px;flex:none;filter:drop-shadow(0 4px 3px var(--st-cast))}
html body .bt-row{min-height:64px;gap:12px;padding:8px 10px}
html body .bt-row[aria-current=page]>:is(svg,.bt-mark,.bt-cluster){filter:drop-shadow(0 5px 4px var(--st-cast));transform:scale(1.08)}
html body .bt-role{font-size:11px;line-height:14px;font-weight:600;color:var(--st-lilac-ink);background:var(--st-tag);border-radius:999px;padding:1px 7px;text-transform:none;letter-spacing:0}
html body .bt-chip{background:var(--st-tag);border:0;border-radius:999px;padding:1px 7px;font-size:11px;line-height:14px;font-weight:600}
html body .bt-unread{background:#d0549f;box-shadow:0 0 0 3px rgba(208,84,159,.18)}
html body .bt-badge-working{background:var(--st-work)}
html body :is(.bt-connect,.bt-you){border:0;border-radius:var(--st-r-menu);background:var(--st-spot);box-shadow:none}
html body .bt-connect:hover{background:var(--st-tag)}
html body :is(.bt-menu-label,.bt-list-label,.bt-section-label){font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
`

// The Bot conversation group's mark on the page (<html>): the Stage composer rules key on it.
export const CONVERSATION_MARK = 'data-bt-conversation'

// Sets the mark for as long as the conversation group is mounted; returns its disposer.
export function markConversation(root = document.documentElement) {
  root.setAttribute(CONVERSATION_MARK, '')
  return () => root.removeAttribute(CONVERSATION_MARK)
}

// Controls on the bench: flat, a hairline around, ink for the primary one; the send button
// is the one piece of clay. The two-row structure below belongs only to the Bot composer:
// its six rules key on CONVERSATION_MARK, which the conversation group sets on <html> as its
// first step and removes as its last (index.js installConversation), the group that brings
// CONVERSATION_CSS's row card and ComposerPlus. Plain Agent/wish sessions keep this theme
// but mount no conversation group, so they have no marker: their native card is a column,
// where a 100% flex basis is height (#88). The marker is on the page, not in the card,
// because DSH paints the card before it mounts any input slot: a marker inside the card
// (the "+", #319) came a few frames late and the card jumped from one row to two (#322).
// Until the slots mount the controls row is empty, so the tools group keeps the box of the
// "+" it will hold (28px square, as the mic and voice buttons): wide enough to wrap below the
// draft, tall enough for the row. A floor only: it never caps what grows.
// The card is capped at 760px; DSH's queued-message dock sizes itself from the wider native
// card variable, so it takes the same cap less its two insets, as natively (#91). Its panel
// then sits 16px inside each card edge and keeps DSH's own 3px seam under the card. The goal
// bar, the todo panel and the Bot's side-question (btw) dock size from that variable too, with
// no padding of their own: they take the cap less four insets, so each sits 16px inside each
// card edge as natively, and their inner boxes follow, since the variable can be narrower or
// wider than the card it no longer drives (#363). The variable itself is left alone: the hero
// shell, the hero stack and the composer notice read it as well.
const CONTROLS = `
html body :is(.bt-soft,.bt-q-btn,.bt-pill,.bt-model-chip,.bt-head button){border:1px solid var(--st-line-2);border-radius:10px;background:transparent;box-shadow:none;font-weight:600;transition:background-color .16s ease}
html body :is(.bt-soft,.bt-q-btn,.bt-pill,.bt-model-chip,.bt-head button):hover:not(:disabled){background:var(--bt-hover)}
html body :is(.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send){border:0;background:var(--st-cyan);color:var(--st-cyan-ink);box-shadow:var(--st-clay)}
html body :is(.bt-send,.bt-nc-send,.bt-q-submit,.bt-mem-send):hover:not(:disabled){filter:brightness(1.04)}
html body .bt-icon-btn:hover{background:var(--bt-hover)}
html body :is(.bt-state,.bt-token){border:1px solid var(--st-line);background:var(--st-raised);box-shadow:none}
html body .bt-state[aria-pressed=true]{background:var(--st-lilac);color:var(--st-lilac-ink)}
html body [class*="_composerStack"] [data-composer-card][data-composer-card]{max-width:min(760px,100%)!important;margin-inline:auto!important}
html body [class*="_composerStack"] [data-queue-dock]{max-width:calc(760px - 2*var(--dsh-composer-dock-inset,8px))!important}
html body [class*="_composerStack"] :is([data-goal-bar],[data-goal-bar]>*,[data-testid="todo-panel"],[data-composer-dock]:has(.bt-btw),.bt-btw-dock){max-width:calc(760px - 4*var(--dsh-composer-dock-inset,8px))}
html body [class*="_composerStack"] [data-composer-dock]:has(.bt-btw){width:calc(100% - 4*var(--dsh-composer-dock-inset,8px))}
html body [data-composer-card]{background:var(--st-raised)!important;border:1px solid var(--st-line)!important;border-radius:18px!important;box-shadow:var(--st-hollow)!important}
html[${CONVERSATION_MARK}] body [data-composer-card][data-composer-card]{flex-wrap:wrap!important;row-gap:6px!important;padding:10px 10px 8px 12px!important;border-radius:18px!important;min-height:0!important}
html[${CONVERSATION_MARK}] body [data-composer-card][data-composer-card]>[data-input-scroll]{order:0!important;flex:1 1 100%!important;padding:2px 4px 4px!important}
html[${CONVERSATION_MARK}] body [data-composer-card][data-composer-card] [data-composer-input]{min-height:40px!important}
html[${CONVERSATION_MARK}] body [data-composer-card][data-composer-card] [class*="_tools"]{order:1!important;align-self:center!important;display:flex;align-items:center;gap:6px;min-width:28px;min-height:28px}
html[${CONVERSATION_MARK}] body [data-composer-card][data-composer-card] [class*="_trailing"]{order:2!important;align-self:center!important;margin-left:auto!important;display:flex;align-items:center;gap:6px}
html[${CONVERSATION_MARK}] body [data-composer-card][data-composer-card]>[data-slot="conversation.input.attachments"]{order:-1!important}
html body [data-composer-card]:focus-within{border-color:var(--st-ring)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--st-ring) 14%,transparent)!important}
html body [data-composer-card] button[class*="_primary"],html body .bt-voice{background:var(--st-cyan)!important;color:var(--st-cyan-ink)!important;box-shadow:var(--st-clay)!important;border:0!important}
html body :is(.bt-plus,.bt-mic){background:transparent;box-shadow:none;color:var(--bt-ink-2)}
html body :is(.bt-plus,.bt-mic):hover{background:var(--bt-hover);color:var(--bt-ink)}
html body [class*="_toBottomSlot"]>button{background:var(--st-paper)!important;border:1px solid var(--st-line)!important;box-shadow:var(--st-lift)!important;color:var(--bt-ink)!important}
html body :is(.bt-tabs,.bt-seg,.bt-avedit-tabs){border-radius:12px;padding:3px;background:var(--st-sunk);box-shadow:none}
html body .bt-tabs{margin:16px 16px 0;align-self:center}
html body :is(.bt-tabs,.bt-seg,.bt-avedit-tabs)>.bt-thumb,html body :is(.bt-tab,.bt-avedit-tab)[aria-selected=true],html body .bt-seg button[aria-pressed=true]{background:var(--st-paper);color:var(--bt-ink);box-shadow:var(--st-lift);border-radius:var(--st-r-seg)}
html body :is(.bt-tabs,.bt-seg,.bt-avedit-tabs)[data-glide] :is(.bt-tab,.bt-avedit-tab,button)[aria-selected=true],html body .bt-seg[data-glide] button[aria-pressed=true]{background:transparent;box-shadow:none}
html body :is(.bt-tab,.bt-avedit-tab){min-height:28px;font-weight:600}
html body :is(.bt-input,.bt-textarea,.bt-q-field,.bt-drawer-name-input,.bt-mem-ask){border:1px solid var(--st-line-2);border-radius:12px;background:var(--st-paper);box-shadow:none}
html body .bt-mem-ask{border-radius:16px;background:var(--st-raised);box-shadow:var(--st-hollow)}
html body :is(.bt-input,.bt-textarea,.bt-drawer-name-input):focus,html body :is(.bt-q-field,.bt-mem-ask):focus-within{outline:0;border-color:var(--st-ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--st-ring) 14%,transparent)}
html body .bt-range input::-webkit-slider-runnable-track{height:6px;border-radius:6px;background:linear-gradient(to right,var(--bt-accent) var(--bt-fill),var(--st-sunk) var(--bt-fill))}
html body .bt-range input::-webkit-slider-thumb{width:16px;height:16px;margin-top:-5px;border-radius:50%;background:var(--st-paper);box-shadow:0 1px 2px rgba(60,48,73,.3)}
`

// The conversation: flat bubbles, the Bot's in cyan with its tail low on the left, yours in
// magenta with it low on the right; cards on the transcript are paper with a hairline.
const CHAT = `
html body [class*="_column"]{max-width:760px}
html body [class*="_userRow"] [class*="_bubble"],html body [data-chat-flow-kind=question-reply] [class*="_bubble"],html body [data-chat-flow-kind=command-input] [class*="_bubble"]{border-radius:18px 18px 6px 18px!important;background:var(--bt-user)!important;box-shadow:none!important;padding:9px 14px!important}
html body .bt-ububble{border-radius:18px 18px 6px 18px;background:var(--bt-user);box-shadow:none;padding:9px 14px}
html body .bt-bubble{border-radius:18px 18px 18px 6px;background:var(--bt-bubble);box-shadow:none;padding:9px 14px;margin-bottom:0}
html body :is(.bt-q,.bt-create-inline,.bt-create-looks,.bt-addlist,.bt-mem-reply){border:1px solid var(--st-line);border-radius:16px;background:var(--st-paper);box-shadow:none}
html body .bt-q-raised{box-shadow:var(--st-lift)}
html body .bt-q-opt[aria-pressed=true],html body button.bt-q-opt:active{background:var(--st-lilac);color:var(--st-lilac-ink)}
html body .bt-key{border:1px solid var(--st-line-2);border-radius:6px;background:var(--st-raised)}
html body :is(.bt-q-title,.bt-create-name,.bt-drawer-name,.bt-mem-head h2,.bt-mem-summary h3,.bt-mem-empty-title){font-family:var(--bt-head-font);font-weight:var(--bt-weight-title);letter-spacing:-.01em}
html body .op-task{padding:0;background:none;border-radius:16px}
html body .op-task-in{border:1px solid var(--st-line);border-radius:16px;padding:12px 14px;background:var(--st-raised);box-shadow:none}
html body .op-task-mark{border-radius:10px;background:var(--st-cyan);color:var(--st-cyan-ink);box-shadow:none}
html body .op-task[data-state=done] .op-task-mark{background:var(--st-ok);color:var(--st-paper)}
html body .op-task[data-state=failed] .op-task-mark{background:var(--st-bad);color:var(--st-paper)}
html body .op-task-title{font-family:var(--bt-head-font);font-weight:var(--bt-weight-strong)}
html body .op-task-bar{height:6px;border-radius:6px;background:var(--st-sunk);box-shadow:none}
html body .op-task-bar i{border-radius:6px;background:var(--st-work);box-shadow:none}
html body .op-task-open{color:var(--bt-accent);font-weight:600}
html body :is(.bt-time-sep,.bt-turn-time){font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2);letter-spacing:0;text-transform:none}
`

// What floats: menus and dialogs are paper with a hairline and the one lift; the details
// panel and pages are the raised cream, divided off by a hairline.
const PANELS = `
html body .bt-panel{border-left:1px solid var(--st-line);background:var(--st-raised);box-shadow:none}
html body :is(.bt-menu,.bt-drop,.bt-avedit,.bt-react-strip){border:1px solid var(--st-line);border-radius:var(--st-r-menu);background:var(--st-paper);box-shadow:var(--st-lift)}
html body .bt-menu button{border-radius:var(--st-r-seg)}
html body .bt-menu button:hover,html body .bt-option[aria-selected=true]{background:var(--bt-main);color:var(--bt-ink)}
html body :is(.bt-settings,.bt-mem){border:1px solid var(--st-line);border-radius:var(--st-r-dialog);background:var(--bt-main);box-shadow:var(--st-lift)}
html body :is(.bt-settings-item,.bt-settings-nav button,.bt-settings nav button)[aria-current=page],html body :is(.bt-settings-item,.bt-settings-nav button,.bt-settings nav button)[aria-selected=true]{background:var(--st-lilac)!important;color:var(--st-lilac-ink);box-shadow:inset 3px 0 0 #6b4f99}
html body .bt-set-card{border:1px solid var(--st-line);border-radius:16px;background:var(--st-paper);box-shadow:none}
html body .bt-mem-row{border:0;border-bottom:1px solid var(--st-line);border-radius:0;background:transparent;box-shadow:none}
html body .bt-swatch{box-shadow:inset 0 0 0 1px rgba(60,48,73,.12)}
html body .bt-swatch[aria-pressed=true]{border-color:var(--bt-ink)}
`

const REDUCED = `
@media (prefers-reduced-motion:reduce){html body :is(.bt-row,.bt-tile,.bt-soft,.bt-pill){transition:none!important}}
body[data-bt-motion=quiet] :is(.bt-row,.bt-tile,.bt-soft,.bt-pill){transition:none!important}
`

export const STAGE_CSS = TOKENS + FRAME + STAGE + CONTROLS + CHAT + PANELS + REDUCED

// What DSH's own surfaces take from the theme (ctx.theme.overrideTokens): flat paper cards
// with hairlines, the lilac selection, the plum focus ring.
export function stageShellTokens({ light, dark }) {
  const both = (l, d) => ({ light: l, dark: d })
  return {
    '--dsw-alias-bg-layer-1': both(light.card, dark.card),
    '--dsw-alias-bg-layer-2': both(light.sidebar, dark.sidebar),
    '--dsw-alias-settings-card-fill': both(light.card, dark.card),
    '--dsw-alias-settings-card-stroke': both('rgba(60,48,73,.13)', 'rgba(243,233,221,.12)'),
    '--dsw-specific-menu': both(light.card, dark.card),
    '--dsw-alias-interactive-bg-hover': both('rgba(60,48,73,.06)', 'rgba(255,240,225,.07)'),
    '--dsw-alias-interactive-bg-active': both('rgba(60,48,73,.1)', 'rgba(255,240,225,.12)'),
    '--dsw-specific-sidebar-nav-item-hover': both('rgba(255,253,249,.45)', 'rgba(255,245,235,.07)'),
    '--dsw-specific-sidebar-nav-item-active': both('rgba(255,253,249,.62)', 'rgba(255,245,235,.1)'),
    '--dsw-alias-border-l1': both('rgba(60,48,73,.13)', 'rgba(243,233,221,.12)'),
    '--dsw-alias-border-l2': both('rgba(60,48,73,.18)', 'rgba(243,233,221,.16)'),
    '--dsw-alias-border-l3': both('rgba(60,48,73,.24)', 'rgba(243,233,221,.22)'),
    '--dsw-alias-toast-bg': both(light.text, dark.card),
    '--dsw-alias-toast-label': both(light.card, dark.text),
    '--dsw-alias-tooltip-bg': both(light.text, dark.card),
    '--dsw-alias-onboarding-card-fill': both(light.card, dark.card),
    '--dsw-focus-ring-color': both('#a73d83', '#f2a6dc'),
  }
}
