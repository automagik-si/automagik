import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from './api.js'
import { CopyIcon, DownloadIcon, ExpandIcon } from './icons.js'
import { t } from './i18n.js'
import { clayArtOf, faceAt, LAMP, markArt } from './clay-art.js'
import { lookOf } from './characters.js'
import { GENIE_AURORA, genieTint } from './genie-tint.js'
import { IMAGE_VIEWER_CSS, ImageViewer } from './image-viewer.js'

// -------------------------------------------------------------------------
// An image being made in the chat (a generate_image call, or an agent's own image tool): the Bot
// whose chat it is paints while it is made (Omni its octopus, Genie its lamp, every other Bot
// the Automagik mark), with how long it has run; the partial images a service streams (the
// Images API sends two) take the painter's place, sharper each time, and the finished image
// fades in where the painter was. Progress comes from the host (imagegen.js) by polling, since a tool call
// reports nothing until it ends. A finished image loads by its id from the image route, so it
// shows again in a reopened chat.

const POLL_MS = 800
const IMAGE_ID = /images[\\/](img-[a-z0-9-]{8,64})\.png/
export const imageIdOf = text => IMAGE_ID.exec(String(text ?? ''))?.[1]
export const imageUrl = id => `api/omni-ui/image?id=${encodeURIComponent(id)}`
// An image an agent makes with its own tool (a Bot on Codex asked for a picture): acp-dsh's mirror
// call (`acp_tool`) says `image: true` from its first sight when the agent titled it as image
// generation, and its result names the image it kept (acp-dsh's agent-image.js), so another
// agent's call that answered with an image draws here once it ends.
export const AGENT_TOOL = 'acp_tool'
export const AGENT_KEPT_TEXT = 'Image generated and saved as'
export const isAgentImageCall = ({ name, image, done, content }) => name === AGENT_TOOL
  && (image === true || (done === true && String(content ?? '').startsWith(AGENT_KEPT_TEXT) && imageIdOf(content) !== undefined))
// The prompt an agent's image call carries, when it carries one.
export const agentPromptOf = (input) => {
  const prompt = input?.prompt ?? input?.revised_prompt ?? input?.revisedPrompt
  return typeof prompt === 'string' && prompt !== '' ? prompt : undefined
}

// The frame's shape before the image says its own.
export const ratioOf = size => ({ '1536x1024': '3 / 2', '1024x1536': '2 / 3' }[size] ?? '1 / 1')

// While the image is made, Omni paints it (the owner's choice, "B · Omni paints"): Omni's own
// clay art and nothing behind it, swaying, its face moving through focused, pleased, focused,
// delighted, focused, curious every 0.9 s, four dabs of the Automagik colours popping around it.
// With reduced motion (or the team's quiet motion) Omni stands still and focused, no dabs.
export const PAINT_FACES = Object.freeze(['focused', 'pleased', 'focused', 'delighted', 'focused', 'curious'])
const FACE_MS = 900
const still = () => typeof document !== 'undefined'
  && (document.body?.dataset?.btMotion === 'quiet' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true)

function useFace(running) {
  const [at, setAt] = useState(0)
  useEffect(() => {
    if (!running || still()) return undefined
    const timer = setInterval(() => setAt(n => (n + 1) % PAINT_FACES.length), FACE_MS)
    return () => clearInterval(timer)
  }, [running])
  return PAINT_FACES[at] ?? PAINT_FACES[0]
}

function useElapsed(running, since) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return Math.max(0, Math.floor((now - (since ?? now)) / 1000))
}

// The host's progress for this call while it draws: { phase, started, partial, count, error }.
function useProgress(callId, running) {
  const [state, setState] = useState({ phase: running ? 'generating' : undefined, partial: undefined, count: 0, started: undefined })
  const seen = useRef(0)
  useEffect(() => {
    if (!running || !callId) return undefined
    let live = true
    let timer
    const poll = async () => {
      const next = await call('image-progress', { callId, seen: seen.current }).catch(() => null)
      if (!live) return
      if (next) {
        const latest = next.partials?.at(-1)
        if (latest) seen.current = latest.index + 1
        setState(prev => ({ phase: next.phase, started: next.started, count: next.count, error: next.error, partial: latest?.image ?? prev.partial }))
        if (next.phase !== 'generating') return
      }
      timer = setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [callId, running])
  return state
}

/**
 * Who paints in a Bot's chat: 'omni' for the Omni Bot (kind `omni`, or the Bot the team draws as
 * the clay octopus, clayArtOf), 'genie' for a Genie, and 'logo' (the Automagik mark) for every
 * other Bot and for a chat whose Bot is not known (a group chat, a Bot that left).
 */
export function painterOf(bot) {
  if (!bot) return 'logo'
  if (bot.kind === 'genie') return 'genie'
  if (bot.kind === 'omni' || clayArtOf(bot, lookOf(bot)) === 'omni') return 'omni'
  return 'logo'
}

const dabs = () => [0, 1, 2, 3].map(key => h('i', { key, className: 'bt-img-dab' }))

/** Omni painting: the clay octopus (the team's own atlas, clay-art.js) and its four dabs. */
export function OmniPaints({ face = PAINT_FACES[0] }) {
  return h('div', { className: 'bt-img-paint', 'data-painter': 'omni', 'aria-hidden': true },
    dabs(),
    h('span', { className: 'bt-img-omni', 'data-face': face },
      h('span', { className: 'bt-clay bt-clay-omni', style: { '--bt-face-at': faceAt(face) } })))
}

// The mark's frame is square; its three arms are as wide as the frame, 124 px here.
const MARK_SIZE = 126

/** Any other Bot painting ("L1 · Logo paints"): the Automagik mark sways among Omni's four dabs. */
export function LogoPaints() {
  return h('div', { className: 'bt-img-paint', 'data-painter': 'logo', 'aria-hidden': true },
    dabs(),
    h('span', { className: 'bt-img-omni bt-img-logo' },
      h('img', { className: 'omni-logo omni-mark bt-img-mark', src: markArt(MARK_SIZE), width: MARK_SIZE, height: MARK_SIZE, alt: '', draggable: false })))
}

// The photo card the lamp puffs out: a frame, its sky, a sun and two hills.
const photoCard = key => h('svg', { key, className: 'bt-img-pic', viewBox: '0 0 32 26', 'aria-hidden': true },
  h('rect', { className: 'bt-img-pic-bg', x: 1, y: 1, width: 30, height: 24, rx: 5 }),
  h('rect', { className: 'bt-img-pic-sky', x: 4, y: 4, width: 24, height: 18, rx: 2.5 }),
  h('circle', { className: 'bt-img-pic-sun', cx: 21.5, cy: 9.5, r: 3 }),
  h('path', { className: 'bt-img-pic-h1', d: 'M4.5 22 12 13l7.5 9z' }),
  h('path', { className: 'bt-img-pic-h2', d: 'M14 22l7.5-6.5L27.5 22z' }))

/**
 * Genie painting ("G3a · Pictures puff out"): the clay lamp rocks and glows, Genie
 * hovers over the spout, and four photo cards leave the spout one after another, rise, drift,
 * grow a little and fade like smoke. A Genie in its own colour wears it here too (genie-tint.js).
 */
export function GeniePaints({ face = PAINT_FACES[0], bot }) {
  const tint = genieTint(bot?.color)
  return h('div', { className: 'bt-img-paint', 'data-painter': 'genie', 'aria-hidden': true },
    h('span', { className: 'bt-img-lampscene' },
      h('i', { className: 'bt-img-glow' }),
      h('span', { className: 'bt-img-rise', 'data-face': face },
        h('span', {
          className: 'bt-clay bt-clay-genie',
          'data-tint': tint === GENIE_AURORA ? GENIE_AURORA : undefined,
          style: { '--bt-face-at': faceAt(face), ...(tint && tint !== GENIE_AURORA ? { filter: tint } : {}) },
        })),
      [0, 1, 2].map(key => h('i', { key, className: 'bt-img-spark' })),
      [0, 1, 2, 3].map(photoCard),
      h('img', { className: 'bt-img-lamp bt-lamp-art', src: LAMP, alt: '', draggable: false })))
}

/** The painter of this chat's image: Omni, Genie, or the Automagik mark. */
export function Painter({ bot, face }) {
  const who = painterOf(bot)
  return who === 'omni' ? h(OmniPaints, { face }) : who === 'genie' ? h(GeniePaints, { face, bot }) : h(LogoPaints)
}

async function copyImage(url) {
  const blob = await (await fetch(url)).blob()
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

/**
 * The image card: the chat's Bot (`bot`, painterOf) paints while the image is made (a partial
 * image the service streams takes its place, sharper each time), and the finished image fades in
 * where the painter was once it has loaded. A call that failed or was stopped says the image was
 * not made, and why; an image that was made but no longer loads says so, and the painting stops.
 * The finished image opens over the whole window (image-viewer.js) from a click on it or from
 * its Open tool; `onAsk` sends what the person asks there to this chat.
 */
export function ImageCell({ callId, prompt, size, done, content, isError, bot, onAsk }) {
  const running = !done
  const progress = useProgress(callId, running)
  // Until the host says when it started, the card counts from when it first showed.
  const [shown] = useState(() => Date.now())
  const elapsed = useElapsed(running, progress.started ?? shown)
  const id = done ? imageIdOf(content) : undefined
  // The finished image: 'loading' until it shows, 'loaded', or 'lost' when it cannot load (its
  // file is no longer in the team folder, say after the workspace moved or was cleaned).
  const [image, setImage] = useState('loading')
  const loaded = image === 'loaded'
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState('closed')
  const opener = useRef(null)
  const open = () => setView('open')
  // Focus goes back to the card without scrolling to it: after a request the chat shows its end.
  const close = () => { setView('closed'); opener.current?.focus({ preventScroll: true }) }
  const face = useFace(running || (id !== undefined && image === 'loading'))
  const failed = done && (isError || id === undefined)
  if (failed || (id !== undefined && image === 'lost')) {
    return h('div', { className: 'bt-img bt-img-failed', role: 'status', 'data-state': failed ? 'failed' : 'lost' },
      h('div', { className: 'bt-img-failed-title' }, failed ? t('The image was not made') : t('The image could not be shown')),
      h('div', { className: 'bt-img-failed-why' }, failed ? String(content ?? '').slice(0, 300) : t('This image is no longer in the team folder.')))
  }
  const url = id ? imageUrl(id) : undefined
  const partial = url ? undefined : progress.partial
  const step = progress.count > 0 ? Math.min(progress.count, 2) : 0
  const state = url ? (loaded ? 'done' : 'arriving') : partial ? 'partial' : 'drawing'
  // The painter stays until there is a picture to show in its place.
  const painting = state === 'drawing' || state === 'arriving'
  return h('figure', { className: 'bt-img', 'data-state': state },
    h('div', { className: 'bt-img-frame', style: painting ? undefined : { aspectRatio: ratioOf(size) } },
      painting ? h(Painter, { bot, face }) : null,
      partial ? h('img', { className: 'bt-img-partial', 'data-step': step, src: partial, alt: '', draggable: false }) : null,
      url ? h('img', { className: 'bt-img-final', src: url, alt: prompt ?? '', onClick: loaded ? open : undefined, onLoad: () => setImage('loaded'), onError: () => setImage('lost') }) : null,
      url && loaded
        ? h('div', { className: 'bt-img-tools' },
            h('button', { ref: opener, type: 'button', className: 'bt-img-tool', title: t('Open image'), 'aria-label': t('Open image'), 'aria-haspopup': 'dialog', onClick: open }, h(ExpandIcon)),
            h('a', { className: 'bt-img-tool', href: url, download: `${id}.png`, title: t('Save image'), 'aria-label': t('Save image') }, h(DownloadIcon)),
            typeof ClipboardItem === 'function' ? h('button', { type: 'button', className: 'bt-img-tool', title: copied ? t('Copied') : t('Copy image'), 'aria-label': t('Copy image'), onClick: () => { void copyImage(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {}) } }, h(CopyIcon)) : null)
        : null),
    url && loaded
      ? null
      : h('figcaption', { className: 'bt-img-status', role: 'status' },
          h('span', { className: 'bt-img-dot', 'aria-hidden': true }),
          h('b', { className: 'bt-img-caption' }, t('Painting your image…')),
          h('span', { className: 'bt-img-time' }, `${elapsed}s`)),
    url && loaded && view === 'open'
      ? createPortal(h(ImageViewer, { id, url, alt: prompt, onAsk, onClose: close }), document.body)
      : null)
}

// No card behind the painter while it paints: only the painter, its dabs or its photo cards, and
// the caption. The frame takes the
// image's shape, with the card's edge, once there is a picture in it.
export const IMAGE_CELL_CSS = `
.bt-img{box-sizing:border-box;margin:6px 0;width:min(100%,440px);display:flex;flex-direction:column;gap:8px}
.bt-img-frame{position:relative;height:210px;display:grid;place-items:center}
.bt-img:is([data-state=partial],[data-state=done]) .bt-img-frame{height:auto;border-radius:18px;overflow:hidden;background:var(--bt-card);box-shadow:0 0 0 1px var(--bt-line),0 10px 30px -18px color-mix(in srgb,var(--bt-ink) 50%,transparent);isolation:isolate}
.bt-img-paint{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.bt-img-omni{position:relative;z-index:1;width:132px;height:132px;display:flex;justify-content:center;animation:bt-img-sway 1.2s ease-in-out infinite alternate;transform-origin:50% 90%}
.bt-img-omni .bt-clay{height:100%}
.bt-img-dab{position:absolute;width:18px;height:18px;border-radius:50%;opacity:0;animation:bt-img-dab 2.4s ease-out infinite}
.bt-img-dab:nth-child(1){background:var(--bt-magic-violet);left:22%;top:22%}
.bt-img-dab:nth-child(2){background:var(--bt-magic-cyan);right:22%;top:30%;animation-delay:.6s}
.bt-img-dab:nth-child(3){background:var(--bt-magic-pink);left:28%;bottom:30%;animation-delay:1.2s}
.bt-img-dab:nth-child(4){background:var(--bt-gold);right:26%;bottom:34%;animation-delay:1.8s}
.bt-img-logo{align-items:center}
.bt-img-mark{display:block;flex:none;height:auto;filter:drop-shadow(0 3px 4px color-mix(in srgb,var(--bt-ink) 22%,transparent))}
.bt-img-lampscene{position:absolute;inset:0}
.bt-img-lampscene .bt-img-lamp{position:absolute;left:50%;bottom:10px;width:132px;height:63px;margin-left:-46px;transform-origin:50% 90%;animation:bt-img-rub 1.6s ease-in-out infinite}
.bt-img-glow{position:absolute;left:50%;bottom:-6px;width:210px;height:110px;margin-left:-85px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,var(--bt-gold) 55%,transparent),transparent);animation:bt-img-glow 1.6s ease-in-out infinite}
.bt-img-rise{position:absolute;left:50%;top:2px;height:112px;margin-left:-86px;display:flex;animation:bt-img-float 2.6s ease-in-out infinite}
.bt-img-spark{position:absolute;right:21%;top:24%;width:14px;height:14px;background:var(--bt-gold);clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%);animation:bt-img-twinkle 1.8s ease-in-out infinite}
.bt-img-spark:nth-of-type(3){right:13%;top:52%;width:10px;height:10px;background:var(--bt-magic-pink);animation-delay:.6s}
.bt-img-spark:nth-of-type(4){right:auto;left:14%;top:60%;width:11px;height:11px;background:var(--bt-magic-cyan);animation-delay:1.2s}
.bt-img-pic{position:absolute;left:50%;bottom:58px;width:36px;height:29px;margin-left:-62px;opacity:0;overflow:visible;--x:104px;--y:-96px;--r:9deg;animation:bt-img-pic 3.2s ease-out infinite}
.bt-img-pic:nth-of-type(2){--x:-50px;--y:-58px;--r:-10deg;animation-delay:.8s}
.bt-img-pic:nth-of-type(3){--x:122px;--y:-56px;--r:6deg;animation-delay:1.6s}
.bt-img-pic:nth-of-type(4){--x:74px;--y:-112px;--r:-6deg;animation-delay:2.4s}
.bt-img-pic-bg{fill:var(--bt-card);stroke:var(--bt-ink-3);stroke-width:1;vector-effect:non-scaling-stroke}
.bt-img-pic-sky{fill:color-mix(in srgb,var(--bt-magic-cyan) 38%,var(--bt-card))}
.bt-img-pic-sun{fill:var(--bt-gold)}
.bt-img-pic-h1{fill:var(--bt-magic-violet)}
.bt-img-pic-h2{fill:var(--bt-magic-pink)}
.bt-img-partial,.bt-img-final{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.bt-img-partial{filter:blur(16px) saturate(1.1);transform:scale(1.06);transition:filter .8s ease,transform .8s ease;animation:bt-img-in .6s ease both}
.bt-img-partial[data-step="2"]{filter:blur(6px);transform:scale(1.02)}
.bt-img-final{opacity:0}
.bt-img[data-state=done] .bt-img-final{opacity:1;animation:bt-img-in .5s ease both}
.bt-img-status{display:flex;align-items:center;gap:8px;margin:0;color:var(--bt-ink-2);font:400 13px/18px var(--bt-font);font-variant-numeric:tabular-nums}
.bt-img-caption{color:var(--bt-ink);font-weight:600}
.bt-img-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-magic-violet);animation:bt-img-pulse 1.2s ease-in-out infinite}
.bt-img-tools{position:absolute;top:8px;right:8px;display:flex;gap:6px;opacity:0;transition:opacity .15s ease}
.bt-img:hover .bt-img-tools,.bt-img:focus-within .bt-img-tools{opacity:1}
.bt-img-tool{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:10px;background:color-mix(in srgb,var(--bt-card) 85%,transparent);backdrop-filter:blur(8px);color:var(--bt-ink);cursor:pointer}
.bt-img-tool:hover{background:var(--bt-card)}
.bt-img-failed{padding:14px 16px;gap:4px;border-radius:18px;background:var(--bt-card);box-shadow:0 0 0 1px var(--bt-line)}
.bt-img-failed-title{font:600 14px/20px var(--bt-font);color:var(--bt-ink)}
.bt-img-failed-why{font:400 12px/16px var(--bt-font);color:var(--bt-ink-2)}
@keyframes bt-img-sway{from{transform:rotate(-6deg)}to{transform:rotate(6deg)}}
@keyframes bt-img-dab{0%{transform:scale(.2);opacity:0}20%{transform:scale(1.1);opacity:1}70%{opacity:.9}100%{transform:scale(.9) translateY(-14px);opacity:0}}
@keyframes bt-img-rub{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(4deg)}}
@keyframes bt-img-glow{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.05)}}
@keyframes bt-img-float{0%,100%{transform:translateY(5px)}50%{transform:translateY(-7px)}}
@keyframes bt-img-twinkle{0%,100%{transform:scale(.3) rotate(0);opacity:0}50%{transform:scale(1) rotate(45deg);opacity:1}}
@keyframes bt-img-pic{0%{transform:translate(0,0) scale(.3) rotate(0deg);opacity:0}14%{opacity:1}70%{opacity:.95}100%{transform:translate(var(--x),var(--y)) scale(1.4) rotate(var(--r));opacity:0}}
@keyframes bt-img-pulse{50%{opacity:.35}}
@keyframes bt-img-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.bt-img-omni,.bt-img-dot,.bt-img-partial,.bt-img-final,.bt-img-lamp,.bt-img-glow,.bt-img-rise{animation:none!important}.bt-img-dab,.bt-img-spark,.bt-img-pic{display:none}.bt-img-glow{opacity:.6}}
body[data-bt-motion=quiet] :is(.bt-img-omni,.bt-img-dot,.bt-img-partial,.bt-img-final,.bt-img-lamp,.bt-img-glow,.bt-img-rise){animation:none!important}
body[data-bt-motion=quiet] :is(.bt-img-dab,.bt-img-spark,.bt-img-pic){display:none}
body[data-bt-motion=quiet] .bt-img-glow{opacity:.6}
${IMAGE_VIEWER_CSS}`

// What the Images row says for an `image-access` reply: undefined (loading), null, an access
// view (an older host), or { access, environmentKey } (asked with detail).
export function imagesRowOf(reply) {
  const detailed = reply !== null && typeof reply === 'object' && Object.hasOwn(reply, 'access')
  const access = detailed ? reply.access : reply
  const ignored = detailed && reply.environmentKey === 'ignored'
  const label = access === undefined ? t('Loading…')
    : access === null ? t('Not connected')
      : access.kind === 'codex' ? t('Codex, on your ChatGPT plan')
        : access.kind === 'chatgpt' ? t('Your ChatGPT account') : t('Your OpenAI key')
  const hint = access === null
    ? (ignored ? t('An OPENAI_API_KEY from the environment is not used for images. Sign in to Codex from a Bot\'s chat, or save that key in Settings → Models.')
      : t('Sign in to Codex from a Bot\'s chat, and every Bot can draw images in its chats.'))
    : t('Every Bot can draw images in its chats. They are saved in the team workspace\'s images folder.')
  return { label, hint, value: access?.model ? `${label} · ${access.model}` : label }
}

// Settings → Bots: what draws the Bots' images here, and why an inherited key is not used.
export function ImagesSection({ Section, Row }) {
  const [reply, setReply] = useState(undefined)
  useEffect(() => { void call('image-access', { detail: true }).then(setReply, () => setReply(null)) }, [])
  const { hint, value } = imagesRowOf(reply)
  return h(Section, { title: t('Images') },
    h(Row, { label: t('Drawn with'), hint }, h('span', { className: 'bt-set-hint' }, value)))
}
