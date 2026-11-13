// -------------------------------------------------------------------------
// The new left bar's sheet (direction C, "Foot line"): the panel, the project rail, the Team
// rows and the status marks. Its skin and its sizes are custom properties, so another skin, a
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
  // The rows: one line each. A Bot's and a group's carry art; a channel's and a chat's do not.
  '--lb-row-h': '34px',
  '--lb-channel-h': '26px',
  '--lb-chat-h': '25px',
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
  // The shade a scroll edge casts on the rows under it.
  '--lb-edge-shade': 'rgba(0,0,0,.14)',
}
const DARK = { '--lb-edge-shade': 'rgba(0,0,0,.4)' }

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
.lb-tile:hover .lb-tile-face{background:var(--bt-active)}
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
// rows lie under it, the line runs the list's whole width and casts a shade on them, so a row
// cut by the edge reads as going under what stands below, not as a row that was clipped. The
// upper edge does the same once the list has moved. --lb-inset and --lb-chat-inset are where a
// channel's and a chat's name start: they follow the art by default, and either can be set.
const ROWS = `
.lb-scroll{position:relative;flex:1;display:flex;flex-direction:column;min-height:0}
.lb-scroll::before,.lb-scroll::after{content:'';position:absolute;left:8px;right:8px;height:14px;pointer-events:none}
.lb-scroll::before{top:0}
.lb-scroll::after{bottom:0;border-bottom:1px solid var(--lb-line)}
.lb-scroll[data-above]::before{left:0;right:0;border-top:1px solid var(--st-line-2,var(--bt-line-2));background:linear-gradient(to bottom,var(--lb-edge-shade),transparent)}
.lb-scroll[data-more]::after{left:0;right:0;border-bottom-color:var(--st-line-2,var(--bt-line-2));background:linear-gradient(to top,var(--lb-edge-shade),transparent)}
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
.lb-row-chat{height:var(--lb-chat-h);padding-left:var(--lb-chat-inset,calc(16px + var(--lb-art) + var(--lb-art-gap) + var(--lb-glyph)))}
.lb-row-channel .lb-name,.lb-row-chat .lb-name{font:400 13.5px/1.3 var(--bt-font);letter-spacing:0}
.lb-row-chat .lb-name{color:var(--lb-muted)}
.lb-row-chat.lb-row-hot .lb-name,.lb-row-chat[aria-current] .lb-name{color:var(--bt-ink)}
.lb-glyph{flex:none;display:grid;place-items:center;width:var(--lb-glyph);height:var(--lb-glyph);color:var(--lb-muted)}
.lb-glyph svg{display:block;width:100%;height:100%}
.lb-chev{flex:none;display:block;color:var(--lb-muted);opacity:.8}
.lb-sec{flex:none;display:flex;align-items:flex-end;height:var(--lb-label-h);padding:0 10px 5px;box-sizing:border-box;font:var(--bt-weight-title,600) 10.5px/1.3 var(--bt-head-font,var(--bt-font));letter-spacing:.16em;text-transform:uppercase;color:var(--lb-muted)}
.lb-sec-first{margin-top:var(--lb-label-first-gap)}
`

// Each mark has its own shape as well as its colour. The working ring turns; it rests where
// motion is turned down, in the app (data-bt-motion) or in the system.
const MARKS = `
.lb-st{flex:none;display:inline-flex;align-items:center;gap:6px;font:400 12px/1 var(--bt-font);color:var(--lb-muted);white-space:nowrap;text-transform:lowercase}
.lb-st-needs{color:var(--lb-needs-ink)}
.lb-st-error{color:var(--st-bad-strong,var(--st-bad,var(--bt-danger)))}
.lb-mark{flex:none;display:block;width:var(--lb-mark);height:var(--lb-mark)}
.lb-mark svg{display:block;width:100%;height:100%;overflow:visible}
.lb-mark-working{color:var(--st-work,var(--bt-accent))}
.lb-mark-needs{color:var(--st-warndot,var(--bt-star,var(--bt-accent)))}
.lb-mark-error{color:var(--st-bad,var(--bt-danger))}
.lb-mark-idle,.lb-mark-off{color:var(--lb-muted);opacity:.7}
.lb-mark-needs .lb-mark-glyph{stroke:var(--lb-mark-ink)}
.lb-mark-error .lb-mark-glyph{stroke:var(--bt-main)}
.lb-mark-arc{transform-origin:6px 6px;transform:rotate(-25deg);animation:lb-turn 1.1s linear infinite}
@keyframes lb-turn{from{transform:rotate(-25deg)}to{transform:rotate(335deg)}}
body[data-bt-motion=quiet] .lb-mark-arc{animation:none}
@media (prefers-reduced-motion:reduce){.lb-mark-arc{animation:none}}
`

export const LEFT_BAR_CSS = `
${tokenCss('body', LEFT_BAR_TOKENS)}
${tokenCss('body[data-ds-dark-theme]', DARK)}
${tokenCss('[data-lb-skin=flat]', LEFT_BAR_SKINS.flat)}
${tokenCss('[data-lb-skin=stage]', LEFT_BAR_SKINS.stage)}${PANEL}${RAIL}${ROWS}${MARKS}`
