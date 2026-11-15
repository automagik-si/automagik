// Where the "Say when, and I'll start" card stands, and what the jump arrow stands on (#1138).
// The card reads as the Bot's own message. It used to be in the composer's seat always, and
// the seat stays in place while the transcript scrolls: in a chat with earlier messages the
// card lay over the last of them, and the arrow floated on a message's text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'
import { nativeCss } from './native-css.js'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const bundle = await build({
  stdin: { contents: "export { ModelChoiceDock, ModelChoiceTail } from './src/client/model-menu.js'\nexport { SHELL_CSS, CONVERSATION_CSS } from './src/client/styles.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Fragment: 'Fragment',
  useState: initial => [initial, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }),
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, document: { body: {} }, window: { innerWidth: 1280, innerHeight: 800 },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { ModelChoiceDock, ModelChoiceTail, SHELL_CSS, CONVERSATION_CSS } = module.exports

const models = [{ ref: 'deepseek-official/deepseek-flash', provider: 'deepseek-official', providerName: 'DeepSeek', name: 'DeepSeek Flash' }]
// A Bot with no model, in a chat that lists `outline`'s turns.
function chat(outline, { model } = {}) {
  const bot = { id: 'writer', name: 'Writer', model }
  const roster = { ready: true, byId: { writer: bot }, models, defaultModel: models[0].ref }
  const sessions = { byId: {}, projectionsBySession: { writer: { values: { turnOutline: outline } } } }
  return { sessionId: 'writer', useRoster: select => select(roster), useSessions: select => select(sessions), actions: { updateBot: () => Promise.resolve() } }
}
const said = [{ turn: 1, prompt: 'Cut the newsletter to 120 words', response: 'Cut to 118 words.' }, { turn: 2, prompt: 'Name the file', response: 'orders.csv' }]
const classOf = node => node?.props?.className
const texts = node => (typeof node === 'string' ? [node] : node && typeof node === 'object' ? (node.children ?? []).flatMap(texts) : [])
// The tail hands the card to a component of its own: draw it as React would.
const drawn = node => (node && typeof node.type === 'function' ? node.type(node.props) : node)

test('a chat with no turn yet has the card in the dock over the composer', () => {
  for (const outline of [[], undefined]) {
    const card = ModelChoiceDock(chat(outline))
    assert.equal(classOf(card), 'bt-model-dock')
    assert.match(texts(card).join(' '), /Say when, and I'll start/)
  }
})

test('a chat that holds turns has no card in the dock: nothing of it stays over the messages', () => {
  assert.equal(ModelChoiceDock(chat(said)), null)
})

test('a chat that holds turns has the card after its last turn, in the transcript', () => {
  const tail = drawn(ModelChoiceTail({ ...chat(said), turn: said[1] }))
  assert.equal(classOf(tail), 'bt-model-seat', 'the card has a place of its own on the turn\'s tail')
  assert.equal(tail.children.length, 1)
  assert.equal(classOf(tail.children[0]), 'bt-model-dock')
  assert.match(texts(tail).join(' '), /Say when, and I'll start/)
})

test('only the last turn\'s tail draws the card, and a chat with no turn draws none there', () => {
  assert.equal(ModelChoiceTail({ ...chat(said), turn: said[0] }), null, 'an earlier turn has no card')
  assert.equal(ModelChoiceTail({ ...chat([]), turn: said[1] }), null)
  assert.equal(ModelChoiceTail({ ...chat(said), turn: undefined }), null)
})

test('a Bot that has its model draws no card in either place', () => {
  const served = { model: models[0].ref }
  assert.equal(ModelChoiceDock(chat([], served)), null)
  assert.equal(drawn(ModelChoiceTail({ ...chat(said, served), turn: said[1] })), null, 'and no empty seat is left on the tail')
})

test('the card is seated in both places: the dock and the turn tail', () => {
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /shadow\('conversation\.input\.dock', \{ id: 'bot-model',[^}]*\}, ModelChoiceDock\)/)
  assert.match(index, /shadow\('conversation\.chat\.turnTail', \{ id: 'bot-model-choice',[^}]*\}, ModelChoiceTail\)/)
})

// The arrow in a real layout: DSH's own sheets for the transcript, the arrow's slot and the
// composer's seat, with the plugin's sheet over them. NOT the shell: the real nesting, and
// --dsh-composer-height set inline where DSH sets it from the seat's observer.
const requireHarness = createRequire(new URL('../dev/harness/package.json', import.meta.url))
const sheetsOf = id => nativeCss(readFileSync(requireHarness.resolve(id), 'utf8'))
const sheet = (id, name, has) => {
  const css = sheetsOf(id).find(has)
  assert.ok(css, `supported DSH ${name} CSS must be present`)
  return css
}
const chatCss = sheet('@deepseek-ai/dsh-client-ui-chat/client', 'ChatView', css => /_toBottomSlot\{/.test(css))
const rootCss = sheet('@deepseek-ai/dsh-client-ui-conversation/client', 'ConversationRoot', css => /_composerSeat\{/.test(css) && /_scrollBody\{/.test(css))
const chatName = chatCss.match(/\.([\w-]+)_toBottomSlot\{/)[1]
const rootName = rootCss.match(/\.([\w-]+)_composerSeat\{/)[1]
const SEAT = 160
const CHIPS = 52
const MARK = 'rgb(255,0,0)'
const page = ({ arrow = true } = {}) => `<style>${chatCss}\n${rootCss}\n${SHELL_CSS}\n${CONVERSATION_CSS}
html,body{margin:0}
.fx{height:600px;width:800px;--dsh-composer-side-clearance:16px;--dsh-chat-content-width:720px;background:var(--bt-main)}
.fx-msg{height:22px;margin-top:6px;background:${MARK}}
.fx-chips{height:${CHIPS}px}
.fx-card{height:${SEAT - CHIPS}px;background:rgb(255,255,255)}
</style><body><div class="${rootName}_root fx" data-phase="active">
<div class="${rootName}_scrollBody" data-conversation-scroll style="--dsh-composer-height:${SEAT}px">
<div class="${chatName}_frame"><div class="${chatName}_root"><div class="${chatName}_scroll"><div class="${chatName}_column">
${Array.from({ length: 60 }, () => '<div class="fx-msg"></div>').join('')}
</div></div></div>
${arrow ? `<div class="${chatName}_toBottomSlot"><button type="button" class="${chatName}_toBottom" aria-label="Scroll to bottom"><svg width="16" height="16"></svg></button></div>` : ''}
</div>
<div class="${rootName}_composerSeat" data-composer-seat><div class="fx-chips" data-slot="conversation.input.dock"></div><div class="fx-card"></div></div>
</div></div></body>`

// What a person sees: the page drawn, then read back pixel by pixel. `rows` are the lines of
// message colour found in a band of the picture, by y.
async function seen(t, options) {
  const browser = await browserGuard()
  if (browser.skip) { t.skip(browser.skip); return null }
  const chrome = await browser.chromium.launch({ executablePath: browser.executablePath, headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] })
  t.after(() => chrome.close())
  const context = await chrome.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const view = await context.newPage()
  await view.setContent(page(options))
  const layout = await view.evaluate(() => {
    const box = (node) => { const at = node.getBoundingClientRect(); return { top: at.top, bottom: at.bottom, left: at.left, right: at.right } }
    const scroller = document.querySelector('[data-conversation-scroll]')
    // A chat scrolled up: the messages pass under the arrow and the composer's seat.
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 211
    const button = document.querySelector('[class*="_toBottomSlot"]>button')
    const middle = button ? box(button) : null
    return {
      range: scroller.scrollHeight - scroller.clientHeight,
      arrow: middle,
      hit: button ? document.elementFromPoint((middle.left + middle.right) / 2, (middle.top + middle.bottom) / 2)?.closest('button') === button : null,
      seat: box(document.querySelector('[data-composer-seat]')),
      card: box(document.querySelector('.fx-card')),
    }
  })
  const shot = (await view.screenshot({ type: 'png' })).toString('base64')
  const reader = await context.newPage()
  const marked = await reader.evaluate(async (png) => {
    const image = new Image()
    image.src = `data:image/png;base64,${png}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const draw = canvas.getContext('2d')
    draw.drawImage(image, 0, 0)
    const { data } = draw.getImageData(0, 0, image.width, image.height)
    // The lines that show any of the messages' colour: clearly red, however faint the rest.
    const rows = []
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const at = (y * image.width + x) * 4
        if (data[at] - Math.max(data[at + 1], data[at + 2]) > 24) { rows.push(y); break }
      }
    }
    return rows
  }, shot)
  return { ...layout, marked }
}
const within = (rows, from, to) => rows.filter(y => y >= from && y < to)

test('the jump arrow stands on the page\'s colour, and no message shows under it down to the composer', async (t) => {
  const view = await seen(t)
  if (!view) return
  assert.ok(view.arrow, 'the arrow is there')
  assert.ok(view.arrow.bottom <= view.seat.top, 'the arrow stands above the composer\'s seat')
  assert.ok(within(view.marked, 0, view.arrow.top - 80).length > 0, 'the messages above the arrow are still on screen')
  assert.deepEqual(within(view.marked, Math.floor(view.arrow.top) - 2, Math.ceil(view.arrow.bottom) + 2), [], 'no message is behind the arrow')
  assert.deepEqual(within(view.marked, Math.ceil(view.arrow.bottom), Math.floor(view.card.top)), [], 'none shows between the arrow and the input card, where the seat is open')
  assert.equal(view.hit, true, 'the arrow still takes the press')
})

test('what hides the messages under the arrow adds nothing to the chat\'s scroll range', async (t) => {
  const withArrow = await seen(t)
  if (!withArrow) return
  const without = await seen(t, { arrow: false })
  assert.equal(withArrow.range, without.range)
  // Without the arrow nothing is hidden: the messages pass behind the open part of the seat.
  assert.ok(within(without.marked, Math.ceil(without.seat.top), Math.floor(without.card.top)).length > 0)
})
