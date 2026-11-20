import { CLAY_TOKENS, pressed, raised, recessed } from './clay.js'
import { CLAY_OMNI, faceAt } from './vendor/clay-art.js'

// The Omni octopus (apps/bots-dsh/src/client/characters.js), as the claim page draws it
// (packages/api/src/login/pages.ts): the vector drawing, kept for when the clay art below is
// switched off. Copied, not imported: this plugin installs on its own. Every class is
// prefixed oai- so nothing here restyles DSH.
const BODY = 'M50 6C75 6 87 24 87 46C87 60 82 68 80 72C84 82 84 92 80 96C76 98 72 92 70 84C68 92 66 98 61 96C57 94 56 84 54 78C52 80 48 80 46 78C44 84 43 94 39 96C34 98 32 92 30 84C28 92 24 98 20 96C16 92 16 82 20 72C18 68 13 60 13 46C13 24 25 6 50 6Z'
const SHADE = 'M87 46C87 60 82 68 80 72C84 82 84 92 80 96C76 98 72 92 70 84C68 92 66 98 61 96C57 94 56 84 54 78C62 76 70 66 75 56C80 48 80 36 75 26C82 32 87 38 87 46Z'

export const OCTOPUS_SVG = `<svg class="oai-octo" viewBox="0 0 100 100" aria-hidden="true">
<defs><linearGradient id="oai-octo-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ff4ff"/><stop offset=".5" stop-color="#22d3ee"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs>
<path class="oai-ghost oai-cyan" d="${BODY}"/><path class="oai-ghost oai-magenta" d="${BODY}"/>
<path d="${BODY}" fill="url(#oai-octo-skin)"/><path d="${SHADE}" fill="#0b4f6c" opacity=".5"/>
<path d="M30 22C36 14 44 11 50 11C40 14 33 20 30 28Z" fill="#fff" opacity=".45"/>
<g class="oai-eyes"><ellipse cx="40" cy="36" rx="6.5" ry="11" fill="#06121f"/><ellipse cx="60" cy="36" rx="6.5" ry="11" fill="#06121f"/>
<circle cx="42" cy="31" r="2.4" fill="#fff"/><circle cx="62" cy="31" r="2.4" fill="#fff"/></g>
<path d="M44 54Q50 59 56 54" stroke="#06121f" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<ellipse cx="31" cy="50" rx="5" ry="2.8" fill="#ff5fb8" opacity=".6"/><ellipse cx="69" cy="50" rx="5" ry="2.8" fill="#ff5fb8" opacity=".6"/>
<g fill="none" stroke="#0e7490" stroke-width="3" stroke-linecap="round"><path d="M20 96Q13 99 12 92"/><path d="M80 96Q87 99 88 92"/></g>
</svg>`

// Omni's clay look (a candidate pending the owner's review; see vendor/clay-art.js), and the
// stage it stands on: a calm cream table of clay, light first, the same clay at night in
// DSH's dark palette (clay.js).
// One of Omni's clay faces (vendor/clay-art.js), drawn from its row of faces.
export const omniFace = (face, className = 'oai-octo') => `<span class="${className} oai-clay oai-clay-omni" data-face="${face}" style="--oai-face-at:${faceAt(face)}"></span>`
export const omniHero = () => (CLAY_OMNI ? omniFace('calm') : OCTOPUS_SVG)
// Unfold's clay face (its row of faces, 192x208 cells), for the stage in Unfold's instance.
export const unfoldHero = (face = 'calm') => `<span class="oai-unfold-hero oai-clay oai-clay-unfold" data-face="${face}" style="--oai-face-at:${faceAt(face)}"></span>`

export const STAGE_CSS = `${CLAY_TOKENS}
.oai-overlay{position:fixed;inset:0;z-index:2000;overflow:auto;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;color:var(--oai-ink);
  font:15px/1.55 var(--oai-font);background:var(--oai-bg)}
.oai-overlay *{box-sizing:border-box}
.oai-overlay ::selection{background:var(--oai-lilac);color:var(--oai-lilac-ink)}
/* The table the stage stands on: a faint pool of light from the upper left, nothing busy. */
.oai-overlay::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(1100px 620px at 30% -12%,color-mix(in srgb,var(--oai-bg) 55%,var(--oai-shine)),transparent 70%)}
body[data-ds-dark-theme] .oai-overlay::before{background:radial-gradient(1100px 620px at 30% -12%,color-mix(in srgb,var(--oai-bg) 88%,var(--oai-cyan)),transparent 70%)}
.oai-stage{position:relative;z-index:1;width:min(580px,100%);display:flex;flex-direction:column;align-items:center}
.oai-octo{width:124px;height:124px;animation:oai-float 4.5s ease-in-out infinite}
.oai-clay{display:block;background:var(--oai-clay-atlas) calc(var(--oai-face-at,0) * 100% / 6) 0/700% 100% no-repeat;filter:drop-shadow(0 10px 8px var(--oai-cast)) drop-shadow(0 22px 22px var(--oai-cast-far))}
.oai-clay-omni{--oai-clay-atlas:var(--oai-omni)}
.oai-clay-genie{--oai-clay-atlas:var(--oai-genie)}
.oai-clay-unfold{--oai-clay-atlas:var(--oai-unfold)}
path.oai-ghost{opacity:0}.oai-cyan{fill:#00f0ff}.oai-magenta{fill:#ff2bd6}
.oai-octo:hover .oai-cyan,.oai-glitch .oai-cyan{opacity:.55;transform:translate(-2.5px,0);animation:oai-glitch 2.4s steps(1) infinite}
.oai-octo:hover .oai-magenta,.oai-glitch .oai-magenta{opacity:.55;transform:translate(2.5px,0);animation:oai-glitch 2.4s steps(1) infinite reverse}
.oai-eyes{transform-origin:50px 36px;animation:oai-blink 5s infinite}
@keyframes oai-float{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-10px) rotate(2deg)}}
@keyframes oai-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
@keyframes oai-glitch{0%{clip-path:inset(0 0 70% 0)}25%{clip-path:inset(40% 0 30% 0)}50%{clip-path:inset(75% 0 0 0)}75%{clip-path:inset(10% 0 60% 0)}}
/* What the companion says: a speech bubble of cyan clay. */
.oai-bubble{position:relative;margin:10px 0 20px;padding:11px 18px;border-radius:var(--oai-r);${raised('var(--oai-cyan)', 4)};color:var(--oai-cyan-ink);font:500 15px/1.45 var(--oai-font);min-height:46px;max-width:100%}
.oai-bubble::before{content:"";position:absolute;top:-7px;left:50%;width:14px;height:14px;border-radius:3px 0 0 0;transform:translateX(-50%) rotate(45deg);background:var(--oai-cyan);box-shadow:inset 2px 2px 3px color-mix(in srgb,var(--oai-cyan) var(--oai-hi),var(--oai-shine))}
.oai-caret{display:inline-block;width:.5em;height:1.05em;margin-left:2px;vertical-align:-2px;border-radius:2px;background:var(--oai-accent-2);animation:oai-caret 1s steps(1) infinite}
@keyframes oai-caret{50%{opacity:0}}
.oai-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
/* The steps: clay beads on a string; the current one is lilac and stands up. */
.oai-rail{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin:0 0 18px;padding:0;list-style:none;font:600 12px/1 var(--oai-font);letter-spacing:.06em;text-transform:uppercase;color:var(--oai-ink2)}
.oai-rail li{padding:8px 12px;border-radius:var(--oai-r-sm);${recessed('var(--oai-niche)')}}
.oai-rail li.oai-on{color:var(--oai-lilac-ink);${raised('var(--oai-lilac)', 3)};transform:translateY(-2px)}
.oai-rail li.oai-done{color:var(--oai-cyan-ink);${raised('color-mix(in srgb,var(--oai-cyan) 55%,var(--oai-clay))', 2)}}
.oai-rail.oai-rail-many{gap:6px;font-size:10px;letter-spacing:.03em}
.oai-rail.oai-rail-many li{padding:6px 9px;border-radius:10px}
/* The card: a thick slab of cream clay resting on the table. */
.oai-card{width:100%;border-radius:26px 30px 25px 29px;padding:26px;${raised('var(--oai-card)', 6)}}
.oai-card h1{font:var(--bt-weight-title,800) 24px/1.2 var(--oai-head);letter-spacing:-.02em;margin:0 0 8px;outline:none}.oai-card p{margin:0 0 14px;color:var(--oai-ink2)}
.oai-mark{font:var(--bt-weight-title,800) 12px/1 var(--oai-head);letter-spacing:.3em;color:var(--oai-accent-2);margin-bottom:12px}
/* Buttons are clay pieces: they rest on their ledge, rise under the pointer, sink when pressed. */
.oai-card button{display:block;width:100%;min-height:44px;padding:12px 16px;margin:10px 0 0;border:0;border-radius:var(--oai-r-sm);${raised('var(--oai-clay)', 4)};color:var(--oai-ink);font:inherit;font-weight:600;cursor:pointer;text-align:center;transition:transform .16s cubic-bezier(.3,1.4,.5,1),box-shadow .16s ease,background-color .16s ease}
.oai-card button:hover:not(:disabled){transform:translateY(-2px)}
.oai-card button:active:not(:disabled){${pressed('var(--oai-clay)', 4)}}
.oai-card button:focus-visible{outline:3px solid var(--oai-ring);outline-offset:3px}
.oai-card button.oai-primary{${raised('var(--oai-cyan)', 5)};color:var(--oai-cyan-ink)}
.oai-card button.oai-primary:active:not(:disabled){${pressed('var(--oai-cyan)', 5)}}
.oai-card button:disabled{opacity:.5;cursor:default;transform:none}
.oai-card button.oai-quiet{background:none;box-shadow:none;color:var(--oai-ink2);font-weight:500}
.oai-card button.oai-quiet:active:not(:disabled){transform:none;box-shadow:none}
.oai-group{margin:18px 0 0}.oai-group h2{margin:0 0 4px;font:var(--bt-weight-title,700) 12px/1.4 var(--oai-head);letter-spacing:.12em;text-transform:uppercase;color:var(--oai-accent)}
.oai-group .oai-terms{margin:0 0 4px;font-size:12px}
.oai-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.oai-card button.oai-tile{margin:4px 0 0;text-align:left;padding:12px 14px}.oai-tile strong{display:block}.oai-tile span{display:block;font-size:12px;font-weight:400;color:var(--oai-ink2)}
.oai-card label{display:block;margin:12px 0 6px;font-size:13px;color:var(--oai-ink2)}
.oai-card input{width:100%;min-height:44px;padding:11px 14px;border-radius:var(--oai-r-sm);border:0;${recessed('var(--oai-niche)')};color:var(--oai-ink);font:15px/1.3 var(--oai-font)}
.oai-card input::placeholder{color:color-mix(in srgb,var(--oai-ink2) 80%,transparent)}
.oai-card input:focus{outline:3px solid var(--oai-ring);outline-offset:2px}
.oai-error{color:var(--oai-bad)!important}.oai-muted{font-size:13px}
.oai-models{margin:8px 0 0;padding:10px 12px;border-radius:var(--oai-r-sm);${recessed('var(--oai-niche)')};font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--oai-ink);max-height:120px;overflow:auto}
.oai-card a.oai-link{color:var(--oai-accent);text-decoration:underline;text-underline-offset:3px}
.oai-card a.oai-button{display:block;margin:12px 0 0;padding:12px 14px;border-radius:var(--oai-r-sm);text-align:center;font-weight:600;text-decoration:none;${raised('var(--oai-cyan)', 5)};color:var(--oai-cyan-ink)}
.oai-code{display:flex;align-items:center;gap:10px;margin:6px 0 4px;padding:12px 14px;border-radius:var(--oai-r-sm);${recessed('color-mix(in srgb,var(--oai-pink) 45%,var(--oai-niche))')}}
.oai-code code{flex:1;font:700 24px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;color:var(--oai-ink)}
.oai-card .oai-code button.oai-ghost{display:inline-block;width:auto;margin:0;padding:8px 12px;font-size:13px}
.oai-choices button{text-align:left}.oai-choices button span{display:block;font-size:12px;font-weight:400;color:var(--oai-ink2)}
.oai-waiting::before{content:"";display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;background:var(--oai-accent-2);animation:oai-caret 1s steps(1) infinite}
.oai-card button.oai-tile-on{${raised('var(--oai-lilac)', 3)};color:var(--oai-lilac-ink)}
.oai-tile em.oai-on{display:inline-block;margin-top:6px;padding:2px 8px;border-radius:999px;font:700 10px/1.6 var(--oai-font);letter-spacing:.08em;text-transform:uppercase;font-style:normal;color:var(--oai-cyan-ink);background:var(--oai-cyan)}
.oai-list{border-radius:var(--oai-r);overflow:hidden;${recessed('var(--oai-niche)')}}
.oai-ai{border-top:1px solid var(--oai-line)}.oai-ai:first-child{border-top:0}
.oai-ai-row{display:flex;align-items:center;gap:12px;padding:12px 14px}
.oai-logo{width:34px;height:34px;flex:none;display:grid;place-items:center;border-radius:11px 12px 10px 12px;${raised('var(--oai-clay)', 2)};font:var(--bt-weight-strong,800) 12px/1 var(--oai-head);color:var(--oai-ink)}
.oai-ai-on .oai-logo{${raised('var(--oai-cyan)', 2)};color:var(--oai-cyan-ink)}
.oai-ai-what{flex:1;min-width:0}.oai-ai-what strong{display:block;font-weight:600}.oai-ai-what span{display:block;font-size:12.5px;color:var(--oai-ink2)}
.oai-found{flex:none;font-style:normal;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--oai-cyan) 45%,var(--oai-card));color:var(--oai-cyan-ink);white-space:nowrap;max-width:40%;overflow:hidden;text-overflow:ellipsis}
/* A switch: a bead that slides in a groove; on, the groove fills with cyan. */
.oai-card button.oai-switch{position:relative;flex:none;width:46px;min-height:0;height:26px;margin:0;padding:0;border-radius:999px;${recessed('var(--oai-niche)')};transform:none}
.oai-card button.oai-switch::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;${raised('var(--oai-card)', 2)};transition:transform .18s cubic-bezier(.3,1.4,.5,1)}
.oai-card button.oai-switch[aria-checked="true"]{${recessed('var(--oai-cyan)')}}
.oai-card button.oai-switch[aria-checked="true"]::after{transform:translateX(20px)}
.oai-card button.oai-switch:hover:not(:disabled),.oai-card button.oai-switch:active:not(:disabled){transform:none}
.oai-ai-setup{padding:0 14px 12px 60px}.oai-ai-setup p{margin:8px 0 0}
.oai-ai-problem{margin:0 14px 10px 60px!important;font-size:13px}
.oai-field{display:flex;gap:10px;align-items:stretch}.oai-field input{flex:1;min-width:0}
.oai-card .oai-field button{width:auto;margin:0;white-space:nowrap}
.oai-setup-form input+.oai-field{margin-top:8px}
.oai-dupes{padding:0 14px 10px 60px}.oai-dupes p{margin:0 0 4px;font-size:12.5px}
.oai-card .oai-dupes button.oai-ghost{display:inline-block;width:auto;margin:2px 0 0;padding:6px 10px;font-size:12.5px}
.oai-card button.oai-more{margin:0;border-top:1px solid var(--oai-line);border-radius:0;background:none;box-shadow:none;color:var(--oai-accent);text-align:left;padding:12px 14px;font-weight:600;transform:none}
.oai-every{margin:12px 0 0!important}
.oai-card button.oai-inline{display:inline;width:auto;min-height:0;margin:0;padding:0;border:0;background:none;box-shadow:none;color:var(--oai-accent);font-weight:600;text-decoration:underline;text-underline-offset:3px;transform:none}
.oai-actions{display:flex;align-items:center;gap:12px;margin-top:20px;padding-top:16px;border-top:2px solid color-mix(in srgb,var(--oai-line) 70%,transparent)}
.oai-card .oai-actions button{width:auto;margin:0}.oai-actions .oai-quiet{margin-right:auto!important;padding-left:0}
.oai-count{font-size:13px;color:var(--oai-ink2)}
@media (max-width:520px){.oai-ai-setup,.oai-dupes{padding-left:14px}.oai-ai-problem{margin-left:14px!important}.oai-field{flex-direction:column}.oai-found{display:none}}
@media (prefers-reduced-motion:reduce){.oai-overlay *,.oai-overlay::before,.oai-overlay::after{animation:none!important;transition:none!important}}
`
