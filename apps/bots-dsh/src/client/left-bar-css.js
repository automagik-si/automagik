// -------------------------------------------------------------------------
// The new left bar's sheet (direction C, "Foot line"): the panel, the project rail, the Team
// rows, the status marks and the view's Chat and Terminal switch. Its skin and its sizes are custom properties, so another skin, a
// taller row or a bigger character is a change of tokens and no rule below changes.
//
// The names and values are design round 1.1's. Two skins. "stage", the default: the bar stands
// on the theme's stage as one rounded panel, and the open row and the tiles are its cream spot.
// "flat": one plain ground, hairlines between the rail, the list and the view. Colours are the
// theme's own (--bt-*, and the brand's --st-* where a theme has them; a theme without them
// falls back to its --bt-* colours).

const SIZES = {
  // The panel's two columns.
  '--lb-rail-w': '56px',
  '--lb-list-w': '264px',
  // The rail's tiles.
  '--lb-tile': '36px',
  '--lb-tile-r': '12px',
  '--lb-tile-icon': '28px',
  '--lb-rail-gap': '10px',
  // The rows: one line each. A Bot's and a group's carry art; a channel carries its glyph, a
  // chat its person's face.
  '--lb-row-h': '34px',
  '--lb-channel-h': '26px',
  '--lb-chat-h': '25px',
  '--lb-chat-face': '16px',
  '--lb-label-h': '26px',
  '--lb-label-first-gap': '8px',
  '--lb-row-r': 'var(--st-r-seg,8px)',
  // The Bot's character, and each of the two in a group's box.
  '--lb-art': '28px',
  '--lb-art-gap': '10px',
  '--lb-duo-art': '19px',
  '--lb-glyph': '16px',
  // The status mark, and the "!" on its amber disc: the brand's plum where the theme names it,
  // else a dark of the disc's own colour.
  '--lb-mark': '12px',
  '--lb-mark-ink': 'var(--plum,rgba(0,0,0,.78))',
  '--lb-line': 'var(--st-line,var(--bt-line))',
  // How far the rows fade before a scroll edge.
  '--lb-edge-fade': '12px',
  // The view's switch: its height, its glyphs, its corners.
  '--lb-face-h': '32px',
  '--lb-face-glyph': '15px',
  '--lb-face-r': '11px',
}

export const LEFT_BAR_SKINS = Object.freeze({
  stage: Object.freeze({
    // The stage's first 62%: it runs from its cyan to its lilac and stops before the pink end.
    '--lb-ground': 'var(--st-stage,var(--bt-sidebar)) top / 100% 160% no-repeat',
    '--lb-panel-gap': '8px',
    '--lb-panel-r': 'var(--st-r-stage,22px)',
    '--lb-view-line': 'transparent',
    '--lb-open': 'var(--st-spot,var(--bt-active))',
    '--lb-tile-ground': 'var(--st-spot,var(--bt-hover))',
    '--lb-tile-open': 'var(--st-spot,var(--bt-hover))',
    // Small text on the stage: the ink at 84%, and the "needs you" amber a step toward the ink.
    '--lb-muted': 'color-mix(in srgb,var(--bt-ink) 84%,transparent)',
    '--lb-needs-ink': 'color-mix(in srgb,var(--st-warn,var(--bt-ink)) 70%,var(--bt-ink))',
  }),
  flat: Object.freeze({
    '--lb-ground': 'var(--bt-main)',
    '--lb-panel-gap': '0px',
    '--lb-panel-r': '0px',
    '--lb-view-line': 'var(--lb-line)',
    '--lb-open': 'var(--bt-active)',
    '--lb-tile-ground': 'var(--bt-hover)',
    '--lb-tile-open': 'transparent',
    '--lb-muted': 'color-mix(in srgb,var(--bt-ink) 72%,transparent)',
    '--lb-needs-ink': 'var(--st-warn,var(--bt-ink))',
  }),
})
export const LEFT_BAR_SKIN = 'stage'
export const LEFT_BAR_TOKENS = Object.freeze({ ...SIZES, ...LEFT_BAR_SKINS[LEFT_BAR_SKIN] })

/** A set of tokens as one rule: `tokenCss('[data-lb-skin=roomy]', { '--lb-row-h': '38px' })` is a whole change of size. */
export const tokenCss = (selector, tokens) => `${selector}{${Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';')}}`

// The panel holds the rail and the list on one ground. `data-lb-fill` is the phone's: the
// ground fills the screen, with no inset and no corners, and the list takes the width left.
const PANEL = `
.lb-bar{flex:none;display:flex;min-width:0;height:calc(100% - 2 * var(--lb-panel-gap));margin:var(--lb-panel-gap);box-sizing:border-box;border-radius:var(--lb-panel-r);overflow:hidden;background:var(--lb-ground);color:var(--bt-ink);font-family:var(--bt-font)}
.lb-bar[data-lb-fill]{flex:1;height:100%;margin:0;border-radius:0}
.lb-list{flex:none;display:flex;flex-direction:column;min-width:0;width:var(--lb-list-w);box-sizing:border-box;border-right:1px solid var(--lb-view-line)}
.lb-bar[data-lb-fill] .lb-list{flex:1;width:auto}
`

// A tile's face carries its ground and its picture. A tile with a status on its corner has that
// corner cut out of the face, so the ring around the mark is the ground itself, on any skin.
const RAIL = `
.lb-rail{flex:none;display:flex;flex-direction:column;align-items:center;gap:var(--lb-rail-gap);width:var(--lb-rail-w);padding:12px 0;box-sizing:border-box;border-right:1px solid var(--lb-line);overflow-y:auto;scrollbar-width:none}
.lb-tile{position:relative;flex:none;display:block;width:var(--lb-tile);height:var(--lb-tile);margin:0;padding:0;border:0;border-radius:var(--lb-tile-r);background:none;color:var(--bt-ink);font:inherit;cursor:pointer}
.lb-tile-face{display:grid;place-items:center;width:100%;height:100%;border-radius:inherit;background:var(--lb-tile-ground)}
/* The computer mark has no opening; only actionable tiles promise one on hover. */
.lb-tile:not(.lb-tile-still):hover .lb-tile-face{background:var(--bt-active)}
/* Keep the focus ring while the resting mark stops offering a pointer action. */
.lb-tile-still{cursor:default}
.lb-tile[aria-current]{outline:1.5px solid var(--bt-ink);outline-offset:1.5px}
.lb-tile[aria-current] .lb-tile-face{background:var(--lb-tile-open)}
.lb-tile-letter .lb-tile-face,.lb-tile-letter:hover .lb-tile-face,.lb-tile-letter[aria-current] .lb-tile-face{background:color-mix(in srgb,var(--st-lilac,var(--bt-active)) 72%,var(--st-paper,var(--bt-card)));color:var(--st-lilac-ink,var(--bt-ink));font:var(--bt-weight-title,600) 18px/1 var(--bt-head-font,var(--bt-font))}
.lb-tile-add .lb-tile-face,.lb-tile-add:hover .lb-tile-face{background:none;box-shadow:inset 0 0 0 1px var(--st-line-2,var(--bt-line-2));color:var(--lb-muted)}
.lb-tile-add:hover .lb-tile-face{color:var(--bt-ink)}
.lb-tile img{display:block;width:var(--lb-tile-icon);height:var(--lb-tile-icon);object-fit:contain}
body[data-ds-dark-theme] .lb-tile .lb-on-light,body:not([data-ds-dark-theme]) .lb-tile .lb-on-dark{display:none}
.lb-tile:focus-visible{outline:3px solid var(--st-ring,var(--bt-accent));outline-offset:3px}
.lb-pip{position:absolute;right:-4px;bottom:-4px;display:block}
.lb-tile-badged .lb-tile-face{-webkit-mask-image:radial-gradient(circle calc(var(--lb-mark) / 2 + 2.5px) at calc(100% + 4px - var(--lb-mark) / 2) calc(100% + 4px - var(--lb-mark) / 2),transparent 97%,#000);mask-image:radial-gradient(circle calc(var(--lb-mark) / 2 + 2.5px) at calc(100% + 4px - var(--lb-mark) / 2) calc(100% + 4px - var(--lb-mark) / 2),transparent 97%,#000)}
`

// The list scrolls inside .lb-scroll. Its lower edge is a quiet line while everything fits. When
// rows lie under it, the line runs the list's whole width and the rows fade over their last
// --lb-edge-fade before it, so a row cut by the edge reads as scrolling on, not as a row that
// was sliced. The upper edge does the same once the list has moved. --lb-inset and --lb-chat-inset are where a
// channel's and a chat's name start: they follow the art by default, and either can be set. A
// chat starts one step under its channel: its person's face stands where the channel's name
// begins, so its own name sits under that.
const ROWS = `
.lb-scroll{position:relative;flex:1;display:flex;flex-direction:column;min-height:0}
.lb-scroll::before,.lb-scroll::after{content:'';position:absolute;left:8px;right:8px;height:14px;pointer-events:none}
.lb-scroll::before{top:0}
.lb-scroll::after{bottom:0;border-bottom:1px solid var(--lb-line)}
.lb-scroll[data-above]::before{left:0;right:0;border-top:1px solid var(--st-line-2,var(--bt-line-2))}
.lb-scroll[data-more]::after{left:0;right:0;border-bottom-color:var(--st-line-2,var(--bt-line-2))}
.lb-scroll[data-more] .lb-rows{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - var(--lb-edge-fade)),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - var(--lb-edge-fade)),transparent)}
.lb-scroll[data-above] .lb-rows{-webkit-mask-image:linear-gradient(to bottom,transparent,#000 var(--lb-edge-fade));mask-image:linear-gradient(to bottom,transparent,#000 var(--lb-edge-fade))}
.lb-scroll[data-above][data-more] .lb-rows{-webkit-mask-image:linear-gradient(to bottom,transparent,#000 var(--lb-edge-fade),#000 calc(100% - var(--lb-edge-fade)),transparent);mask-image:linear-gradient(to bottom,transparent,#000 var(--lb-edge-fade),#000 calc(100% - var(--lb-edge-fade)),transparent)}
.lb-rows{flex:1;display:flex;flex-direction:column;min-height:0;padding:2px 8px 4px;box-sizing:border-box;overflow-y:auto;scrollbar-width:none}
.lb-row{flex:none;display:flex;align-items:center;gap:var(--lb-art-gap);width:100%;min-width:0;height:var(--lb-row-h);margin:0;padding:0 10px 0 8px;box-sizing:border-box;border:0;border-radius:var(--lb-row-r);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.lb-row:hover{background:var(--bt-hover)}
.lb-row[aria-current]{background:var(--lb-open)}
.lb-row:focus-visible{outline:3px solid var(--st-ring,var(--bt-accent));outline-offset:-3px}
.lb-row-lead{margin-top:6px}
.lb-art{position:relative;flex:none;display:grid;place-items:center;width:var(--lb-art);height:var(--lb-art)}
.lb-art-pet{position:absolute;display:block;line-height:0}
.lb-duo{position:relative;display:block}
.lb-duo-a,.lb-duo-b{position:absolute;display:block;width:var(--lb-duo-art);height:var(--lb-duo-art);line-height:0}
.lb-duo-a{left:0;top:0}
.lb-duo-b{right:0;bottom:0}
.lb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--bt-weight-label,500) 15px/1.3 var(--bt-head-font,var(--bt-font));letter-spacing:-.005em}
.lb-row-unread .lb-name{font-weight:var(--bt-weight-title,600)}
.lb-row-off .lb-name{color:var(--lb-muted)}
.lb-row-off .lb-art{filter:grayscale(1);opacity:.55}
.lb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.lb-row-channel{height:var(--lb-channel-h);gap:8px;padding-left:var(--lb-inset,calc(8px + var(--lb-art) + var(--lb-art-gap)))}
.lb-row-chat{height:var(--lb-chat-h);gap:7px;padding-right:8px;padding-left:var(--lb-chat-inset,calc(8px + var(--lb-art) + var(--lb-art-gap) + var(--lb-glyph) + 8px))}
.lb-row-chat .lb-st{gap:5px}
.lb-count{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:600 10px/1 var(--bt-font)}
/* A chat's person: the photo, else their initials, on the incoming tone Omni's chat view uses
   for the other side; the owner's own chat adds the outgoing tone as a ring. Every chat mark is
   one tile, so the initials sit like a photo does. Omni shares --oc-in/--oc-out with the bar
   today, and PR 1777's names --oc-them/--oc-me stand beside them for when it lands; the
   fallbacks are the formulas its own chat view uses, so a row and that chat agree. */
.lb-chat-face{position:relative;flex:none;display:grid;place-items:center;width:var(--lb-chat-face);height:var(--lb-chat-face);box-sizing:border-box;border-radius:50%;overflow:hidden;background:var(--oc-in,var(--oc-them,var(--bt-card)));color:var(--bt-ink)}
body[data-ds-dark-theme] .lb-chat-face{background:var(--oc-in,var(--oc-them,var(--bt-bubble)))}
.lb-chat-face[data-self]{box-shadow:inset 0 0 0 1.5px var(--oc-out,var(--oc-me,color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card))))}
body[data-ds-dark-theme] .lb-chat-face[data-self]{box-shadow:inset 0 0 0 1.5px var(--oc-out,var(--oc-me,color-mix(in srgb,var(--bt-accent) 26%,var(--bt-bubble))))}
.lb-chat-face img{position:absolute;inset:1px;width:calc(100% - 2px);height:calc(100% - 2px);border-radius:50%;object-fit:cover}
.lb-chat-face-initials{font:600 7.5px/1 var(--bt-head-font,var(--bt-font));letter-spacing:.02em}
.lb-row-chat .lb-chat-face-initials{color:inherit}
.lb-row-channel .lb-name,.lb-row-chat .lb-name{font:400 13.5px/1.3 var(--bt-font);letter-spacing:0}
.lb-row-chat .lb-name{color:var(--lb-muted)}
.lb-row-chat.lb-row-hot .lb-name,.lb-row-chat[aria-current] .lb-name{color:var(--bt-ink)}
.lb-glyph{flex:none;display:grid;place-items:center;width:var(--lb-glyph);height:var(--lb-glyph);color:var(--lb-muted)}
.lb-glyph svg{display:block;width:100%;height:100%}
.lb-chev{flex:none;display:block;color:var(--lb-muted);opacity:.8}
.lb-chev-open{transform:rotate(90deg)}
.lb-sec{flex:none;display:flex;align-items:flex-end;height:var(--lb-label-h);padding:0 10px 5px;box-sizing:border-box;font:var(--bt-weight-title,600) 10.5px/1.3 var(--bt-head-font,var(--bt-font));letter-spacing:.16em;text-transform:uppercase;color:var(--lb-muted)}
.lb-sec-first{margin-top:var(--lb-label-first-gap)}
`

// Each mark has its own shape as well as its colour. The working ring turns; it rests where
// motion is turned down, in the app (data-bt-motion) or in the system. The error word is text
// and reads the strong red; its mark is a fill and keeps the brand's red (status-colours.test.js).
const MARKS = `
.lb-st{flex:none;display:inline-flex;align-items:center;gap:6px;font:400 12px/1 var(--bt-font);color:var(--lb-muted);white-space:nowrap;text-transform:lowercase}
.lb-st-needs{color:var(--lb-needs-ink)}
.lb-st-error{color:var(--st-bad-strong,var(--bt-danger))}
.lb-mark{flex:none;display:block;width:var(--lb-mark);height:var(--lb-mark)}
.lb-mark svg{display:block;width:100%;height:100%;overflow:visible}
.lb-mark-working{color:var(--st-work,var(--bt-accent))}
.lb-mark-needs{color:var(--st-warndot,var(--bt-star,var(--bt-accent)))}
.lb-mark-error rect{fill:var(--st-bad,var(--bt-danger))}
.lb-mark-idle,.lb-mark-off{color:var(--lb-muted);opacity:.7}
.lb-mark-needs .lb-mark-glyph{stroke:var(--lb-mark-ink)}
.lb-mark-error .lb-mark-glyph{stroke:var(--bt-main)}
.lb-mark-arc{transform-origin:6px 6px;transform:rotate(-25deg);animation:lb-turn 1.1s linear infinite}
@keyframes lb-turn{from{transform:rotate(-25deg)}to{transform:rotate(335deg)}}
body[data-bt-motion=quiet] .lb-mark-arc{animation:none}
@media (prefers-reduced-motion:reduce){.lb-mark-arc{animation:none}}
`

// The view's switch stands on the view's own ground, not on the bar's, so it reads the theme's
// colours and no skin token: a sunk track, and the open face raised on the theme's paper.
const FACES = `
.lb-face{flex:none;display:inline-flex;align-items:stretch;gap:2px;height:var(--lb-face-h);padding:3px;box-sizing:border-box;border-radius:var(--lb-face-r);background:var(--bt-hover)}
.lb-face-part{flex:none;display:inline-flex;align-items:center;gap:6px;margin:0;padding:0 12px 0 10px;border:0;border-radius:var(--st-r-seg,8px);background:none;color:color-mix(in srgb,var(--bt-ink) 72%,transparent);font:var(--bt-weight-label,500) 13px/1 var(--bt-head-font,var(--bt-font));white-space:nowrap;cursor:pointer}
.lb-face-part:hover{color:var(--bt-ink)}
.lb-face-part[aria-pressed=true]{background:var(--st-paper,var(--bt-card));color:var(--bt-ink);box-shadow:0 1px 0 var(--lb-line);cursor:default}
.lb-face-part:focus-visible{outline:3px solid var(--st-ring,var(--bt-accent));outline-offset:1px}
.lb-face-glyph{flex:none;display:block;width:var(--lb-face-glyph);height:var(--lb-face-glyph)}
.lb-face-part[aria-disabled=true],.lb-face-part[aria-disabled=true]:hover{color:color-mix(in srgb,var(--bt-ink) 42%,transparent);cursor:not-allowed}
.bt-head .lb-face{margin-right:4px}
`

// In the app the bar fills the shell's sidebar card (left-bar.js, through sidebar.js). The card
// is the panel: its ground is the skin's, it sits --lb-panel-gap in, and nothing pads it, so the
// rail runs from its top edge; a hairline at the rail's edge runs the card's whole height, past
// the shell's footer (the account menu), which stands in the list's column. The shell's own
// scroll fade goes: the Team rows fade their own edges. A phone's drawer fills the screen.
const HOST = `
.bt-side.lb-host{display:flex;flex-direction:column;height:100%;min-height:0;padding:0}
.lb-bar[data-lb-host]{flex:1;height:auto;min-height:0;margin:0;border-radius:0;background:none}
.lb-bar[data-lb-host] .lb-rail{border-right:0}
.lb-railcol{flex:none;display:flex;flex-direction:column;align-items:center;width:var(--lb-rail-w);min-height:0}
.lb-railcol .lb-rail{flex:1;min-height:0}
/* Both wide and drawer seats use the rail's existing control face. */
.lb-railcol .bt-side-collapse,.bt-side-collapse.bt-foot-toggle{flex:none;width:36px;height:36px;margin:0 0 10px;border:0;border-radius:var(--lb-tile-r);background:none;box-shadow:none;color:var(--lb-muted)}
/* The footer seat has the same hover affordance as the drawer's rail control. */
.lb-railcol .bt-side-collapse:hover,.bt-side-collapse.bt-foot-toggle:hover{background:var(--bt-hover);color:var(--bt-ink)}
.lb-bar[data-lb-host] .lb-list{flex:1;width:auto}
html body [class*="_sidebarCol"]>[data-slot=sidebar]>[class*="_root"]:has(.lb-host){position:relative;margin:var(--lb-panel-gap)!important;height:calc(100% - 2 * var(--lb-panel-gap))!important;padding:0!important;border-radius:var(--lb-panel-r);background:var(--lb-ground)!important}
html body [class*="_sidebarCol"]>[data-slot=sidebar]>[class*="_root"]:has(.lb-host)::before{content:'';position:absolute;left:calc(var(--lb-rail-w) - 1px);top:0;bottom:0;width:1px;background:var(--lb-line);pointer-events:none}
html body [class*="_frame"][data-sidebar-drawer] [class*="_sidebarCol"]>[data-slot=sidebar]>[class*="_root"]:has(.lb-host){margin:0!important;height:100%!important;border-radius:0}
/* The phone's drawer is DSH's own 280 whatever the wide width was: the wide width stays in
   DSH's state and comes back the moment the frame leaves drawer mode. */
html body [class*="_frame"][data-sidebar-drawer] [class*="_sidebarCol"]:has(.lb-host){width:min(280px,calc(100vw - 48px))!important}
[class*="_root"]:has(.lb-host) [class*="_scrollArea"]:has(.lb-host){grid-template-columns:0 minmax(0,1fr) 0;grid-template-rows:0 max-content 0 minmax(0,1fr);margin:0}
[class*="_root"]:has(.lb-host) [class*="_scrollFade"]{display:none}
[class*="_root"]:has(.lb-host)>[class*="_footArea"]{margin-left:var(--lb-rail-w);padding-left:10px!important}
/* Anchor against the card so footer entries and a scrolling list cannot move the toggle. */
html:not([data-windows-titlebar]):not([data-platform=darwin]) [class*="_frame"]:not([data-sidebar-drawer]) [class*="_root"]:has(.lb-host) .bt-foot-toggle{position:absolute;left:calc(10px - var(--lb-panel-gap));bottom:calc(18px - var(--lb-panel-gap));margin:0}
/* The rail draws its icons at 18px (DSH's rail spec), so the glyph keeps its size across the fold. */
.bt-side-collapse.bt-foot-toggle svg{width:18px;height:18px}
/* Keep the drawer's rail control until a footer seat takes over outside the drawer. */
[class*="_frame"]:not([data-sidebar-drawer]) [class*="_root"]:has(.bt-foot-toggle) .lb-railcol .bt-side-collapse{display:none}
/* The drawer retains its rail control and its existing placement. */
[class*="_frame"][data-sidebar-drawer] .bt-foot-toggle{display:none}
.lb-head{flex:none;display:flex;align-items:center;gap:4px;height:52px;padding:0 8px 0 14px;box-sizing:border-box}
.lb-brand{flex:1;min-width:0;display:flex;align-items:center;overflow:hidden}
.lb-brand .omni-wordmark{display:block;flex:none;max-width:100%;height:auto}
.lb-head .bt-round{flex:none;width:30px;height:30px;background:none;box-shadow:none;color:var(--bt-ink)}
.lb-head .bt-round:hover{background:var(--bt-hover)}
html[data-automagik-desktop] .lb-brand{visibility:hidden}
html[data-automagik-desktop=darwin]:not([data-automagik-fullscreen]) .lb-bar[data-lb-host] .lb-rail{padding-top:44px}
html[data-automagik-desktop=darwin] .lb-head{-webkit-app-region:drag}
html[data-automagik-desktop=darwin] .lb-head :is(a,button,input,[role=button],[aria-haspopup],[tabindex]){-webkit-app-region:no-drag}
.lb-host .bt-hint{margin:2px 10px 8px}
.lb-foot{flex:none;padding:6px 8px 2px}
.lb-foot:empty{display:none}
.lb-agent .bt-agent-sub-in{margin-left:calc(8px + var(--lb-art) + var(--lb-art-gap) - 8px)}
.lb-host .bt-threads{margin-left:calc(8px + var(--lb-art) / 2)}
/* The account menu in the footer, under the list: the person's face and the word Account. */
.bt-account-name{display:none}
[class*="_root"]:has(.lb-host) .bt-account{width:auto;height:36px;align-items:center;gap:10px;padding:0 12px 0 0;border-radius:18px;color:var(--bt-ink);font:var(--bt-weight-label,500) 14px/1 var(--bt-head-font,var(--bt-font))}
[class*="_root"]:has(.lb-host) .bt-account-name{display:inline}
[class*="_root"]:has(.lb-host) .bt-account:hover{background:var(--bt-hover)}
.bt-you .bt-person{display:block}
.lb-tile-add[aria-expanded=true] .lb-tile-face{background:var(--bt-hover);color:var(--bt-ink)}
.lb-note{position:fixed;z-index:200;width:max-content;max-width:min(260px,calc(100vw - 24px));padding:10px 12px;box-sizing:border-box;border-radius:12px;background:var(--st-paper,var(--bt-main));border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.12),0 4px 6px -4px rgba(0,0,0,.1);color:var(--bt-ink);font:400 13px/1.45 var(--bt-font)}
/* A phone's view header carries the bar's Chat / Terminal switch beside one More disclosure:
   the Bot's plugin buttons, Live, the right sidebar and Details fold into it, so nothing
   pushes the switch off the left edge. The panel is a quiet card under the button. */
.bt-head-more{position:relative;flex:none;pointer-events:auto}
.bt-head-more>summary{list-style:none;cursor:pointer}
.bt-head-more>summary::-webkit-details-marker{display:none}
.bt-head-more>summary::marker{content:''}
.bt-head-more-pop{position:absolute;top:46px;right:0;z-index:40;display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:190px;padding:8px;box-sizing:border-box;border-radius:12px;background:var(--st-paper,var(--bt-main));border:.5px solid var(--bt-line-2);box-shadow:0 12px 28px -8px rgba(0,0,0,.3);pointer-events:auto}
.bt-head-more-pop .bt-head-details{width:100%;min-width:0;height:34px;justify-content:flex-start;gap:8px;padding:0 12px;border:0;border-radius:10px;background:none;box-shadow:none;color:var(--bt-ink);font-size:13px}
.bt-head-more-word{display:none}
.bt-head-more-pop .bt-head-more-word{display:inline}
.bt-head-more-pop .bt-head-details:hover{background:var(--bt-hover)}
.bt-head-more-pop .bt-head-word{display:inline}
.bt-head-more-pop .os-head-btn{display:flex;align-items:center;width:100%;height:34px;justify-content:flex-start;gap:8px}
.bt-head-more-pop .os-head-count{flex:none;min-width:18px;padding:0 6px;box-sizing:border-box;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink);font:600 11px/18px var(--bt-font);text-align:center}
`

export const LEFT_BAR_CSS = `
${tokenCss('body', LEFT_BAR_TOKENS)}
${tokenCss('[data-lb-skin=flat]', LEFT_BAR_SKINS.flat)}
${tokenCss('[data-lb-skin=stage]', LEFT_BAR_SKINS.stage)}${PANEL}${RAIL}${ROWS}${MARKS}${FACES}${HOST}`
