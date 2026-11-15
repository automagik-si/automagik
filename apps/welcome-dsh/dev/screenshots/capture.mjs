// The "From another tool" step's screenshot set: every state the page can show, drawn from the
// same pure view the step uses (src/client/migrate.js) with fixed fixtures. No React, no DSH,
// no Hermes: esbuild bundles the view, a tiny recorder turns the elements into static HTML, and
// Chromium photographs it with the real clay styles and the brand's Fredoka and DM Sans.
//
//   SHOT_CHROME=/path/to/chrome node dev/screenshots/capture.mjs [--out DIR]
//
// `playwright-core` comes from the repository's devDependencies (bun install at the root). The
// HTML, the PNGs and the page it uses are written under --out (default .tools/welcome-migrate-shots
// at the repository root), never into the plugin's shipped files.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = resolve(PLUGIN, '..', '..')
const arg = process.argv.indexOf('--out')
const OUT = resolve(arg !== -1 && process.argv[arg + 1] ? process.argv[arg + 1] : join(ROOT, '.tools', 'welcome-migrate-shots'))

// ── the view, bundled and recorded ─────────────────────────────────────────────────────────
const bundle = await build({
  stdin: {
    contents: [
      "export { MigrateView, MIGRATE_CSS, TOOLS, MOVE } from './src/client/migrate.js'",
      "export { STAGE_CSS } from './src/client/octopus.js'",
      "export { ONBOARD_CSS } from './src/client/onboard-css.js'",
      "export { ACP_CSS } from './src/client/acp-agents.js'",
      "export { CLAY_ART_CSS } from './src/client/vendor/clay-art.js'",
      "export { INK_CSS } from './src/client/companion-art.js'",
      "export { announceStep } from './src/client/stage.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@automagik/bots-dsh/client', '@xterm/xterm'],
  loader: { '.css': 'text' },
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useRef: current => ({ current }), useCallback: fn => fn,
  useMemo: fn => fn(), useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, setTimeout, clearTimeout,
  document: { body: null, getElementById: () => null },
  // Reduced motion is the screenshots' own rule: the speech is fully typed, the motion is still.
  matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
  require: name => ({
    react,
    'react-dom': { createPortal: node => node },
    '@automagik/bots-dsh/client': {},
    '@xterm/xterm': {},
  })[name],
})
const view = module.exports

function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])
function html(node) {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node !== 'object') return esc(node)
  if (node.type === 'raw') return String(node.html ?? '')
  const props = node.props ?? {}
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on') || key === 'children' || key === 'dangerouslySetInnerHTML' || key === 'key' || key === 'ref' || key === 'style') continue
    if (key === 'className') { attrs.push(`class="${esc(value)}"`); continue }
    if (key === 'htmlFor') { attrs.push(`for="${esc(value)}"`); continue }
    if (key === 'tabIndex') { attrs.push(`tabindex="${esc(value)}"`); continue }
    if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'autoFocus' || key === 'spellCheck') {
      if (value === true) attrs.push(key.toLowerCase())
      continue
    }
    if (typeof value === 'function' || typeof value === 'object') continue
    if (!/^[\w:-]+$/.test(key)) continue
    attrs.push(`${key}="${esc(value)}"`)
  }
  const inner = props.dangerouslySetInnerHTML?.__html !== undefined ? String(props.dangerouslySetInnerHTML.__html) : node.children.map(html).join('')
  if (VOID.has(node.type)) return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${node.type}>`
}

// ── the clay, with the brand's own faces ───────────────────────────────────────────────────
const font = (path, family, extra = '') => {
  try {
    const bytes = readFileSync(path)
    return `@font-face{font-family:"${family}";font-style:normal;font-display:swap;${extra}src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2")}`
  } catch {
    return ''
  }
}
const FONTS = [
  font(join(ROOT, 'docs/brand/fonts/fredoka-latin.woff2'), 'Fredoka', 'font-weight:300 700;size-adjust:105%;'),
  font(join(ROOT, 'apps/landing/assets/brand/dm-sans-latin.woff2'), 'DM Sans', 'font-weight:100 1000;'),
].join('\n')
const CSS = `${FONTS}\nhtml,body{margin:0;min-height:100%;background:#f6eee2}body[data-ds-dark-theme]{background:#1e1923}\n${view.STAGE_CSS}\n${view.CLAY_ART_CSS}\n${view.INK_CSS}\n${view.ONBOARD_CSS}\n${view.ACP_CSS}\n${view.MIGRATE_CSS}`

// ── the fixtures: one per state the step can show ─────────────────────────────────────────
// A neutral person's Hermes: no real bot, host or account stands in these pictures.
const BOT = 'B0B0B0B0-2222-4333-8444-555555555555'
const OTHER = 'C0C0C0C0-3333-4444-8555-666666666666'
const probe = (overrides = {}) => ({
  hermes: { found: true, where: 'local', channel: 'on', key: 'available', gatewayRunning: true, pendingRestart: false, ...overrides.hermes },
  omni: {
    linked: true, attach: true, telegram: null,
    bots: [{ id: BOT, name: 'Omni', main: true }, { id: OTHER, name: 'Harbor', main: false }],
    ...(overrides.omni ?? {}),
  },
})
const RESULT = {
  channelId: OTHER, channelName: 'Telegram', connected: true, botName: '@LumenBot', chatUrl: 'https://t.me/LumenBot',
  attached: true, answering: true, answerBot: { id: BOT, name: 'Omni' }, hermesOff: true, hermesWasOff: false, hermesWasStopped: false, gatewayStopped: false,
}
const STEPS = ['key', 'hermes', 'omni', 'listen'].map((id, at) => ({ id, state: at < 1 ? 'done' : at === 1 ? 'now' : 'pending' }))
const STATES = [
  { name: '01-choosing-light', phase: 'choosing', height: 980 },
  { name: '02-choosing-dark', phase: 'choosing', height: 980, dark: true },
  { name: '03-cards', phase: 'choosing', height: 980, clip: '.oai-mig-grid' },
  { name: '04-checking', phase: 'checking', height: 760 },
  { name: '05-confirm-on', phase: 'confirm', probe: probe(), botId: BOT, agreed: false, height: 1080 },
  { name: '06-confirm-off', phase: 'confirm', probe: probe({ hermes: { channel: 'off', pendingRestart: false } }), botId: BOT, agreed: true, height: 1000 },
  { name: '07-moving-key', phase: 'moving', steps: STEPS, height: 900 },
  { name: '08-done-connected', phase: 'done', result: RESULT, height: 900 },
  { name: '09-done-waiting', phase: 'done', result: { ...RESULT, connected: false, chatUrl: null }, onCheckStatus: () => {}, height: 900 },
  { name: '10-done-answering-off', phase: 'done', result: { ...RESULT, answering: false, answeringOff: true, chatUrl: null }, canOpenSettings: true, height: 980 },
  { name: '11-handoff-no-key', phase: 'handoff', handoff: { reason: 'no-key' }, onOpenChannels: () => {}, height: 860 },
  { name: '12-problem-still-on', phase: 'problem', error: { code: 'hermes-still-on', message: 'Hermes did not confirm that its Telegram channel stopped, so nothing was handed to Omni and its config was put back.', changed: { hermesOff: false, omniCreated: false } }, height: 820 },
  { name: '13-aside-channels', phase: 'handoff', handoff: { reason: 'no-key' }, aside: { kind: 'channels', onBack: () => {} }, height: 660 },
  { name: '14-confirm-stopped', phase: 'confirm', probe: probe({ hermes: { gatewayRunning: false } }), botId: BOT, agreed: false, height: 1080 },
  { name: '15-done-stopped', phase: 'done', result: { ...RESULT, hermesWasStopped: true }, height: 900 },
]

// The rail is the welcome's own: in the app, every step that brings one has announced it.
for (const id of ['omni-companion', 'omni-team', 'omni-connect', 'omni-migrate', 'omni-connect-ai']) view.announceStep(id)

mkdirSync(OUT, { recursive: true })
const page = join(OUT, 'preview.html')
const paths = []
const browser = await chromium.launch({ executablePath: process.env.SHOT_CHROME || undefined, args: ['--no-sandbox'] })
try {
  const tab = await browser.newPage({ viewport: { width: 1120, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  for (const state of STATES) {
    const tree = render(view.MigrateView({ phase: state.phase, probe: state.probe ?? null, botId: state.botId ?? null, agreed: state.agreed ?? false, steps: state.steps ?? null, result: state.result ?? null, error: state.error ?? null, handoff: state.handoff ?? null, aside: state.aside ?? null, canOpenSettings: state.canOpenSettings === true, onCheckStatus: state.onCheckStatus ?? null, onOpenChannels: state.onOpenChannels ?? null }))
    writeFileSync(page, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${state.name}</title><style>${CSS}</style></head><body${state.dark ? ' data-ds-dark-theme' : ''}>${html(tree)}</body></html>`)
    await tab.setViewportSize({ width: 1120, height: state.height })
    await tab.goto(pathToFileURL(page).href)
    await tab.evaluate(() => document.fonts.ready)
    const target = join(OUT, `${state.name}.png`)
    if (state.clip) await tab.locator(state.clip).screenshot({ path: target })
    else await tab.screenshot({ path: target })
    paths.push(target)
    console.log(relative(ROOT, target))
  }
} finally {
  await browser.close()
}
console.log(`\n${paths.length} screenshots in ${relative(ROOT, OUT)}`)
