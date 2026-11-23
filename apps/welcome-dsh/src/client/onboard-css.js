import { pressed, raised, recessed } from './clay.js'

// Styles for the companion and team steps, on top of the stage (octopus.js STAGE_CSS): the
// same clay, every class prefixed oai-. A Bot type's card is a slab of clay with a niche
// pressed into it, where its character sits: lit when it is awake, in shadow asleep.
export const ONBOARD_CSS = `
.oai-stage.oai-wide{width:min(980px,100%)}
/* veil.js: the table alone, over DSH's first frame until the welcome is up. */
.oai-veil{transition:opacity .2s ease}.oai-veil-out{opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){.oai-veil{transition:none}}
.oai-hero{width:132px;height:132px;display:grid;place-items:center;animation:oai-float 4.5s ease-in-out infinite}
.oai-hero svg{width:132px;height:132px;filter:drop-shadow(0 10px 8px var(--oai-cast)) drop-shadow(0 22px 22px var(--oai-cast-far))}
.oai-hero .oai-octo{width:126px;height:126px;animation:none}
.oai-hero .oai-unfold-hero{width:120px;height:130px}
.oai-hero-img{width:132px;height:132px;object-fit:cover;border-radius:30px 34px 29px 33px;box-shadow:0 5px 0 color-mix(in srgb,var(--oai-clay) var(--oai-ledge),var(--oai-umber)),0 12px 16px var(--oai-cast)}
.oai-hatch{animation:oai-hatch 1s cubic-bezier(.2,1.4,.4,1) both}
@keyframes oai-hatch{0%{transform:scale(.6) rotate(-8deg)}60%{transform:scale(1.18) rotate(3deg)}100%{transform:scale(1)}}
/* Before a look is chosen: an egg of the two clays, cyan and magenta, kneaded together. */
.oai-egg{position:relative}
.oai-egg-shell{width:84px;height:104px;border-radius:50% 50% 46% 46%/58% 58% 42% 42%;background:radial-gradient(circle at 36% 28%,color-mix(in srgb,var(--oai-cyan) 40%,var(--oai-shine)) 0,var(--oai-cyan) 34%,color-mix(in srgb,var(--oai-cyan) 50%,var(--oai-pink)) 62%,var(--oai-pink) 100%);box-shadow:inset 4px 5px 8px color-mix(in srgb,var(--oai-cyan) 40%,var(--oai-shine)),inset -6px -8px 12px color-mix(in srgb,var(--oai-pink) 70%,var(--oai-umber)),0 10px 10px var(--oai-cast),0 22px 26px var(--oai-cast-far);animation:oai-wobble 2.6s ease-in-out infinite}
@keyframes oai-wobble{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg) translateY(-4px)}}
.oai-spark{position:absolute;width:7px;height:7px;border-radius:50%;${raised('var(--oai-cyan)', 1)};animation:oai-twinkle-dot 2.4s ease-in-out infinite}
.oai-spark-0{top:8px;left:16px}.oai-spark-1{top:22px;right:10px;animation-delay:.5s}.oai-spark-2{bottom:16px;left:6px;animation-delay:1s;background:var(--oai-pink)}.oai-spark-3{bottom:6px;right:22px;animation-delay:1.5s}.oai-spark-4{top:52px;right:-4px;animation-delay:.8s;background:var(--oai-pink)}
@keyframes oai-twinkle-dot{0%,100%{opacity:.35;transform:scale(.7)}50%{opacity:1;transform:scale(1.1)}}
.oai-lede{color:var(--oai-ink2);margin:0 0 16px}
/* Two-way choice: a groove with a lilac bead in it. */
.oai-seg{display:inline-flex;padding:5px;border-radius:16px 18px 15px 17px;${recessed('var(--oai-niche)')};gap:4px;margin-bottom:16px}
.oai-card .oai-seg button{width:auto;min-height:40px;margin:0;white-space:nowrap;background:transparent;box-shadow:none;color:var(--oai-ink2);font-weight:600;font-size:14px;padding:9px 16px;border-radius:12px 13px 11px 13px;transform:none}
.oai-card .oai-seg button:active:not(:disabled){transform:none;box-shadow:none}
.oai-card .oai-seg button[aria-selected="true"]{${raised('var(--oai-lilac)', 3)};color:var(--oai-lilac-ink);transform:translateY(-2px)}
.oai-describe,.oai-pick,.oai-name{display:grid;gap:10px;margin-bottom:16px}
.oai-describe label,.oai-name label{font-size:13px;color:var(--oai-ink2)}
.oai-describe textarea,.oai-name input{width:100%;border:0;${recessed('var(--oai-niche)')};border-radius:var(--oai-r-sm);color:var(--oai-ink);padding:11px 14px;font:inherit;resize:vertical}
.oai-describe textarea:focus,.oai-name input:focus{outline:3px solid var(--oai-ring);outline-offset:2px}
.oai-name .oai-row,.oai-characters{display:grid;gap:10px}
.oai-chips{display:flex;flex-wrap:wrap;gap:8px}
.oai-card button.oai-chip{display:inline-block;width:auto;min-height:32px;margin:0;font-weight:500;${raised('var(--oai-clay)', 2)};color:var(--oai-ink);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.oai-card button.oai-chip:active:not(:disabled){${pressed('var(--oai-clay)', 2)}}
.oai-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.oai-muted{color:var(--oai-ink2);font-size:13px;margin:0}
.oai-note{color:var(--oai-ink);border-radius:var(--oai-r-sm);${recessed('color-mix(in srgb,#f2c25b 30%,var(--oai-niche))')};padding:10px 12px;font-size:13.5px;margin:0}
.oai-drawing{height:8px;border-radius:999px;${recessed('var(--oai-niche)')};background-image:linear-gradient(90deg,transparent,var(--oai-cyan),var(--oai-pink),transparent);background-size:200% 100%;animation:oai-shimmer 1.2s linear infinite}
@keyframes oai-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
/* The characters to pick from: each in its own little dish. */
.oai-shapes{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:10px}
.oai-card button.oai-shape{width:auto;min-height:0;margin:0;aspect-ratio:1;${raised('var(--oai-clay)', 3)};border-radius:16px 18px 15px 17px;padding:4px;display:grid;place-items:center;cursor:pointer}
.oai-card button.oai-shape[aria-checked="true"]{${raised('var(--oai-lilac)', 3)};transform:translateY(-2px)}
.oai-swatches{display:flex;flex-wrap:wrap;gap:10px}
.oai-card button.oai-swatch{display:inline-block;width:28px;height:28px;min-height:0;margin:0;padding:0;border-radius:50%;corner-shape:round;cursor:pointer;box-shadow:inset 2px 3px 3px rgba(255,255,255,.45),inset -2px -3px 4px rgba(0,0,0,.22),0 2px 0 rgba(0,0,0,.18),0 4px 5px var(--oai-cast)}
.oai-card button.oai-swatch[aria-checked="true"]{outline:3px solid var(--oai-ink);outline-offset:3px;transform:translateY(-2px)}
.oai-error{color:var(--oai-bad);margin:0 0 10px}
.oai-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
.oai-big{padding:13px 22px;font-size:15px}
/* Who joins: one card per Bot type. A chosen card stands up on a lilac rim. */
.oai-select{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:20px;margin-bottom:14px;align-items:start}
.oai-fighter{position:relative;display:grid;gap:12px;align-content:start;padding:16px;border-radius:24px 27px 23px 26px;${raised('var(--oai-clay)', 4)};transition:transform .3s cubic-bezier(.3,1.4,.5,1),box-shadow .3s ease}
.oai-fighter.oai-chosen{${raised('color-mix(in srgb,var(--oai-lilac) 55%,var(--oai-clay))', 5)};transform:translateY(-3px)}
.oai-fighter header{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:32px}
.oai-fighter h2{margin:0;font:var(--bt-weight-title,800) 21px/1.2 var(--oai-head);letter-spacing:-.016em}
.oai-fighter p{margin:0;color:var(--oai-ink2);font-size:14px}
.oai-about{font-size:13.5px!important}
/* A wish is the clay lamp it comes out of. */
.oai-wish{display:flex;align-items:center;gap:10px}
.oai-wish-lamp{flex:none;width:46px;height:auto;filter:drop-shadow(0 3px 2px rgba(91,59,34,.18));-webkit-user-drag:none;user-select:none}
/* The niche: a hollow in the card where the character rests. Asleep, the light leaves it. */
.oai-box{position:relative;height:340px;display:grid;grid-template-rows:32px 136px 24px 1fr;padding:12px 14px 14px;border-radius:20px 23px 19px 22px;overflow:hidden;
  ${recessed('color-mix(in srgb,var(--oai-cyan) 9%,var(--oai-card))')};transition:background-color .6s ease}
.oai-box.oai-is-asleep{${recessed('color-mix(in srgb,var(--oai-niche) 90%,var(--oai-umber))')}}
body[data-ds-dark-theme] .oai-box.oai-is-asleep{${recessed('var(--oai-niche)')}}
.oai-chosen .oai-box.oai-box-genie{${recessed('color-mix(in srgb,var(--oai-pink) 12%,var(--oai-card))')}}
.oai-box-top{display:flex;align-items:center;justify-content:space-between}
/* Three clay beads: power, plugins, connection. */
.oai-lights{display:flex;gap:7px;padding-left:4px}
.oai-light{width:9px;height:9px;border-radius:50%;font-style:normal;background:color-mix(in srgb,var(--oai-niche) 80%,var(--oai-umber));box-shadow:inset 1px 1px 2px rgba(0,0,0,.25);transition:background-color .3s,box-shadow .3s}
.oai-light-on{background:var(--oai-ok);box-shadow:inset 1px 1px 1px rgba(255,255,255,.55),inset -1px -1px 2px rgba(0,0,0,.25),0 0 6px color-mix(in srgb,var(--oai-ok) 60%,transparent)}
.oai-light-busy{background:var(--oai-cyan);box-shadow:inset 1px 1px 1px rgba(255,255,255,.55),inset -1px -1px 2px rgba(0,0,0,.25),0 0 6px color-mix(in srgb,var(--oai-cyan) 70%,transparent);animation:oai-blink-light 1s steps(2) infinite}
.oai-light-warn{background:var(--oai-warn);box-shadow:inset 1px 1px 1px rgba(255,255,255,.5),inset -1px -1px 2px rgba(0,0,0,.25)}
@keyframes oai-blink-light{50%{opacity:.35}}
.oai-is-waking .oai-light{animation:oai-light-up .3s ease-out both}
.oai-is-waking .oai-light:nth-child(2){animation-delay:.3s}.oai-is-waking .oai-light:nth-child(3){animation-delay:.6s}
@keyframes oai-light-up{to{background:var(--oai-ok)}}
/* The power button: a round clay button. Asleep it breathes to say "press me". */
.oai-card button.oai-power{display:grid;place-items:center;width:34px;height:34px;min-height:0;margin:0;padding:0;border-radius:50%;corner-shape:round;${raised('var(--oai-card)', 3)};color:var(--oai-accent)}
.oai-is-asleep button.oai-power{animation:oai-call 2.4s ease-in-out infinite}
@keyframes oai-call{0%,100%{transform:none}50%{transform:translateY(-2px) scale(1.06)}}
.oai-card button.oai-power.on{${raised('var(--oai-cyan)', 2)};color:var(--oai-cyan-ink);transform:translateY(1px)}
.oai-card button.oai-power:active:not(:disabled){${pressed('var(--oai-card)', 3)}}
.oai-screen{position:relative;display:grid;place-items:end center}
.oai-octo-wrap{position:relative;width:122px;height:122px}
.oai-octo-wrap .oai-octo{position:absolute;inset:0;width:122px;height:122px;animation:oai-float 4.5s ease-in-out infinite}
.oai-is-asleep .oai-octo-wrap .oai-octo{animation:oai-slump 5.2s ease-in-out infinite}
@keyframes oai-slump{0%,100%{transform:translateY(6px) rotate(-7deg) scale(1,.95)}50%{transform:translateY(3px) rotate(-6deg) scale(1.01,.97)}}
.oai-is-waking .oai-octo-wrap .oai-octo{animation:oai-rise-up .9s cubic-bezier(.2,1.3,.4,1) both,oai-float 4.5s ease-in-out .9s infinite}
@keyframes oai-rise-up{0%{transform:translateY(6px) rotate(-7deg)}60%{transform:translateY(-8px) rotate(2deg)}100%{transform:none}}
.oai-closed{display:none}.oai-is-asleep .oai-closed{display:inline}.oai-is-asleep .oai-eyes{display:none}
.oai-is-waking .oai-eyes{animation:oai-open .5s cubic-bezier(.3,1.5,.5,1) both}
@keyframes oai-open{from{transform:scaleY(.08)}to{transform:scaleY(1)}}
/* Genie, from its row of faces (vendor/clay-art.js); asleep is its own face, never dimmed. */
.oai-genie-wrap{align-self:center;justify-self:center;width:118px;height:128px}
.oai-genie-pet{width:100%;height:100%;animation:oai-float 5s ease-in-out infinite}
.oai-genie-pet[data-face=asleep]{animation-duration:6.5s}
.oai-unfold-wrap{align-self:center;justify-self:center;width:118px;height:128px}
.oai-unfold-pet{width:100%;height:100%;animation:oai-float 5s ease-in-out infinite}
.oai-unfold-pet[data-face=asleep]{animation-duration:6.5s}
.oai-zzz i{position:absolute;left:57%;top:46%;font:var(--bt-weight-title,800) 15px/1 var(--oai-head);font-style:normal;color:var(--oai-ink2);opacity:0;animation:oai-z 3.6s ease-in infinite}
.oai-zzz i:nth-child(2){animation-delay:1.2s;font-size:12px}.oai-zzz i:nth-child(3){animation-delay:2.4s;font-size:10px}
@keyframes oai-z{0%{transform:translate(0,0);opacity:0}20%{opacity:.85}100%{transform:translate(24px,-54px);opacity:0}}
.oai-scan{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.oai-scan i{position:absolute;width:56px;height:56px;border-radius:50%;border:2px solid color-mix(in srgb,var(--oai-cyan) 80%,var(--oai-ink));opacity:0;animation:oai-ping 2.1s cubic-bezier(.2,.6,.4,1) infinite}
.oai-scan i:nth-child(2){animation-delay:.7s;border-color:color-mix(in srgb,var(--oai-pink) 80%,var(--oai-ink))}.oai-scan i:nth-child(3){animation-delay:1.4s}
@keyframes oai-ping{0%{transform:scale(.4);opacity:.9}100%{transform:scale(3.6);opacity:0}}
.oai-status{align-self:center;margin:0!important;text-align:center;font:600 13px/1.3 var(--oai-font)!important;color:var(--oai-ink)!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oai-is-asleep .oai-status,.oai-working::after{content:"";display:inline-block;width:7px;height:7px;margin-left:8px;vertical-align:1px;border-radius:50%;background:var(--oai-accent-2);animation:oai-caret 1s steps(1) infinite}
.oai-inside{min-height:0;overflow:auto;display:grid;align-content:center;gap:6px;padding-top:4px}
.oai-inside-note{margin:0!important;text-align:center;font-size:12.5px!important;color:var(--oai-ink2)!important;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.oai-genie-skills{display:flex;flex-direction:column;gap:6px}
.oai-genie-skills .oai-inside-note{-webkit-line-clamp:3}
.oai-cli-line{display:flex;align-items:center;gap:6px;min-width:0}
.oai-cli-line code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;padding:5px 8px;border-radius:8px;background:color-mix(in srgb,var(--oai-ink) 6%,transparent);font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--oai-ink)}
.oai-copy{flex:none;padding:4px 10px;border:1px solid color-mix(in srgb,var(--oai-ink) 20%,transparent);border-radius:8px;background:none;color:var(--oai-ink);font:600 12px/16px inherit;cursor:pointer}
.oai-inside-note.oai-bad{color:var(--oai-bad)!important}
.oai-install{list-style:none;margin:0;padding:0;display:flex;justify-content:center;gap:14px;font-size:12.5px;color:var(--oai-ink2)}
.oai-install li{display:flex;align-items:center;gap:6px}
.oai-install-dot{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;${recessed('var(--oai-niche)')}}
.oai-install-done{color:var(--oai-ink)}.oai-install-done .oai-install-dot{${raised('var(--oai-ok)', 1)};color:var(--oai-card)}
.oai-install-now{color:var(--oai-ink);font-weight:600}.oai-install-now .oai-install-dot{border:2px solid color-mix(in srgb,var(--oai-cyan) 35%,transparent);border-top-color:var(--oai-accent);box-shadow:none;background:none;animation:oai-spin .8s linear infinite}
.oai-install-next{opacity:.6}
@keyframes oai-spin{to{transform:rotate(360deg)}}
.oai-found-box{display:grid;gap:6px;justify-items:center}
/* Omni's choices ("choose your destiny"): one clay tile each, the icon a pressed-in coin. */
.oai-destiny-box{display:grid;gap:8px;width:100%}
.oai-destiny{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px;width:100%}
.oai-card button.oai-destiny-tile{display:grid;justify-items:center;align-content:start;gap:3px;width:auto;min-height:92px;margin:0;padding:10px 8px 9px;border-radius:var(--oai-r-sm);${raised('var(--oai-card)', 3)};color:var(--oai-ink);text-align:center;font-weight:400;line-height:1.3}
.oai-card button.oai-destiny-tile:hover:not(:disabled){transform:translateY(-2px)}
.oai-card button.oai-destiny-tile:focus-visible{outline:2px solid var(--oai-ring);outline-offset:2px}
.oai-card button.oai-destiny-tile:disabled{opacity:.55;cursor:default}
.oai-destiny-tile strong{font:var(--bt-weight-strong,700) 13.5px/1.25 var(--oai-head)}
.oai-destiny-tile small{font-size:11.5px;color:var(--oai-ink2)}
.oai-destiny-icon{width:32px;height:32px;margin-bottom:3px;display:grid;place-items:center;border-radius:12px;${raised('var(--oai-cyan)', 2)};color:var(--oai-cyan-ink)}
.oai-destiny-sandbox .oai-destiny-icon{${raised('var(--oai-pink)', 2)};color:var(--oai-pink-ink)}
.oai-destiny-remote .oai-destiny-icon{${raised('var(--oai-lilac)', 2)};color:var(--oai-lilac-ink)}
.oai-destiny-icon svg{width:18px;height:18px}
.oai-destiny-waiting{list-style:none;margin:0;padding:0;font-size:12px;color:var(--oai-ink2);text-align:center}
.oai-remote{display:grid;gap:6px;width:100%;text-align:left}
.oai-remote label{font:var(--bt-weight-strong,700) 13.5px/1.3 var(--oai-head)}
.oai-remote-row{display:flex;gap:8px}
.oai-remote input{flex:1;min-width:0;height:42px;padding:0 14px;border:1px solid var(--oai-line);border-radius:var(--oai-r-sm);background:var(--oai-card);color:var(--oai-ink);font:15px var(--oai-font);outline:none}
.oai-remote input:focus{border-color:var(--oai-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--oai-accent) 22%,transparent)}
.oai-card .oai-remote-row button{width:auto;margin:0;min-height:42px;white-space:nowrap}
.oai-remote small{font-size:12px;color:var(--oai-ink2)}
.oai-unowned{gap:8px}
.oai-unowned>strong{font:var(--bt-weight-strong,700) 14px/1.3 var(--oai-head);color:var(--oai-ink)}
.oai-unowned .oai-remote{gap:6px}
.oai-cmd{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--oai-line);border-radius:var(--oai-r-sm);background:var(--oai-card)}
.oai-cmd code{flex:1;min-width:0;overflow-wrap:anywhere;font:600 12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--oai-ink);user-select:all}
.oai-pair-hint{font-size:12px;color:var(--oai-ink2);text-align:center}
.oai-pair-hint code{font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all}
.oai-remote .oai-textlink{justify-self:start!important}
.oai-found-list{list-style:none;margin:0;padding:0;display:grid;gap:8px;width:100%}
.oai-found-row{display:flex;align-items:center;gap:10px;padding:7px 7px 7px 12px;border-radius:14px 16px 13px 15px;${raised('var(--oai-card)', 3)}}
.oai-found-row.oai-quiet{box-shadow:none;background:none;opacity:.65}
.oai-found-what{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.25}
.oai-found-what strong{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oai-found-what small{font-size:11.5px;color:var(--oai-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oai-card .oai-pill,.oai-pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:auto;min-height:32px;margin:0;padding:6px 14px;border:0;border-radius:999px;${raised('var(--oai-clay)', 3)};color:var(--oai-ink);font:inherit;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;cursor:pointer}
.oai-card .oai-pill-primary,.oai-pill-primary{${raised('var(--oai-cyan)', 3)};color:var(--oai-cyan-ink)}
.oai-card button.oai-textlink{display:inline;width:auto;min-height:0;margin:0;padding:0;border:0;background:none;box-shadow:none;color:var(--oai-accent);font-size:13px;font-weight:600;transform:none;justify-self:center}
.oai-card button.oai-textlink:active:not(:disabled){transform:none;box-shadow:none}
.oai-elsewhere{display:grid;gap:8px}
.oai-elsewhere .oai-field input{min-height:36px;padding:7px 12px;font-size:13px}
.oai-pairing{display:grid;gap:8px;justify-items:center}
.oai-pair-code{font:700 22px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;color:var(--oai-ink)}
.oai-menu{display:grid;gap:6px}
.oai-menu-label{font:var(--bt-weight-title,700) 10.5px/1 var(--oai-head);letter-spacing:.14em;text-transform:uppercase;color:var(--oai-ink2)}
.oai-menu-preview{list-style:none;margin:0;padding:8px 10px;border-radius:var(--oai-r-sm);${raised('var(--oai-card)', 2)};display:grid;gap:4px;font-size:12.5px}
.oai-menu-preview li{display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oai-dot{width:8px;height:8px;border-radius:50%;flex:none}.oai-dot.ok{background:var(--oai-ok)}.oai-dot.warn{background:var(--oai-warn)}
.oai-team-line{display:inline-flex;align-items:center;gap:10px}
.oai-on-team{display:inline-flex;align-items:center;gap:5px;color:var(--oai-ok);font-weight:700;font-size:13px}
.oai-card button.oai-remove{width:auto;min-height:30px;margin:0;padding:4px 12px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--oai-ink);${raised('var(--oai-card)', 2)}}
.oai-card button.oai-remove:active:not(:disabled){${pressed('var(--oai-card)', 2)}}
.oai-starts summary{cursor:pointer;color:var(--oai-ink2);font-size:13px;list-style:none;display:flex;align-items:center;gap:6px;min-height:28px;border-radius:8px}
.oai-starts summary:focus-visible{outline:3px solid var(--oai-ring);outline-offset:2px}
.oai-starts summary::-webkit-details-marker{display:none}
.oai-starts summary::before{content:"›";display:inline-block;transition:transform .15s;color:var(--oai-accent);font-weight:700}
.oai-starts[open] summary::before{transform:rotate(90deg)}
.oai-starts[open] summary{margin-bottom:8px}
.oai-core{font:700 10px/1 var(--oai-font);letter-spacing:.08em;text-transform:uppercase;color:var(--oai-cyan-ink);background:color-mix(in srgb,var(--oai-cyan) 55%,var(--oai-card));border-radius:999px;padding:4px 8px;white-space:nowrap}
.oai-caps{display:grid;gap:12px;padding-top:6px;border-top:2px solid color-mix(in srgb,var(--oai-line) 70%,transparent)}
.oai-cap-group h3{margin:8px 0 6px;font:var(--bt-weight-title,700) 11px/1 var(--oai-head);letter-spacing:.14em;text-transform:uppercase;color:var(--oai-ink2)}
.oai-cap-group ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.oai-cap{display:flex;align-items:center;gap:10px;font-size:13.5px}
.oai-cap.oai-off .oai-cap-what{opacity:.55}
.oai-cap-what{flex:1;min-width:0;display:flex;flex-direction:column}
.oai-cap-what strong{font-weight:600}
.oai-cap-what small{color:var(--oai-ink2);font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis}
.oai-cap-what code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--oai-accent);overflow-wrap:anywhere}
.oai-cap-empty{font-size:12.5px!important}
.oai-version{flex:none;font:11px/1 ui-monospace,Menlo,monospace;color:var(--oai-ink2);padding:4px 8px;border-radius:999px;${recessed('var(--oai-niche)')}}
.oai-version.oai-pending{opacity:.7}
.oai-tick{flex:none;display:grid;place-items:center;color:var(--oai-ok)}
@media (prefers-reduced-motion: reduce){.oai-hero,.oai-egg-shell,.oai-spark,.oai-octo-wrap .oai-octo,.oai-genie-pet,.oai-drawing,.oai-zzz i,.oai-scan i,.oai-power,.oai-eyes,.oai-light,.oai-box,.oai-fighter{animation:none!important;transition:none!important}.oai-scan i:nth-child(n+2){display:none}.oai-zzz i{opacity:.7}.oai-zzz i:nth-child(2){transform:translate(12px,-22px)}.oai-zzz i:nth-child(3){transform:translate(22px,-40px)}.oai-scan i{opacity:.6;transform:scale(2.2)}.oai-is-asleep .oai-octo-wrap .oai-octo{transform:translateY(6px) rotate(-7deg)}}
`
