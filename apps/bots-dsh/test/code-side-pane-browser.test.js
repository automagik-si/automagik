// The typing pane's resume rule in a real browser with the real xterm (RFC 0030 delivery 2):
// nothing typed before typing is confirmed is sent. A waking Enter only retakes; keys during
// the retake are dropped; a paste in the ended state only retakes; after confirmation the next
// key reaches the input route. Every name and terminal here is made up.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = join(process.env.DSH_HARNESS, 'node_modules/@deepseek-ai')
const assets = join(harness, 'dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seedFactory = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seedFactory, 'pinned DSH supplies the React seed factory')
const seeds = await build({ stdin: { contents: `${frontend.slice(0, seedFactory.index + seedFactory[0].length)}; window.nativeSeeds = ${seedFactory[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const app = await build({
  entryPoints: [join(plugin, 'test/fixtures/code-side-pane-browser-app.js')],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text', '.svg': 'dataurl' },
})

const calls = page => page.evaluate(() => window.__calls.filter(call => call.url.includes('/code/')))
const note = page => page.locator('.cs-paste-note').textContent().catch(() => '')

test('a waking key or paste only retakes; nothing typed before confirmation is sent', async (t) => {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://automagik.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' })
    return route.abort()
  })
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(() => window.mountPane())
  await page.locator('.cs-screen').click()
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')

  // Make the next batch answer 409 (the lease ended) without a second key event: paste.
  const endTyping = async () => {
    await page.evaluate(() => { window.__inputStatus = 409; window.__calls.length = 0 })
    await page.evaluate(() => {
      const target = document.querySelector('.cs-screen')
      const data = new DataTransfer()
      data.setData('text/plain', 'x')
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'ended')
    assert.match(await note(page), /Typing paused after 60 s idle/)
  }
  // A waking Enter only retakes; it is not sent, before or after the confirmation.
  await endTyping()
  await page.evaluate(() => { window.__calls.length = 0 })
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')
  let recorded = await calls(page)
  assert.equal(recorded.filter(call => call.url.includes('/take')).length, 1, 'the waking Enter retakes once')
  assert.equal(recorded.filter(call => call.url.includes('/input')).length, 0, 'the waking Enter is never sent')
  assert.match(await note(page), /Typing is back: type again/)

  // After the confirmation, the next key goes through normally.
  await page.evaluate(() => { window.__inputStatus = 204; window.__calls.length = 0 })
  await page.keyboard.type('a')
  await page.waitForFunction(() => window.__calls.some(call => call.url.includes('/input')))
  recorded = await calls(page)
  const input = recorded.find(call => call.url.includes('/input'))
  assert.equal(Buffer.from(input.body.data, 'base64').toString('utf8'), 'a')

  // Keys typed during the retake are dropped: they are not sent after it either.
  await endTyping()
  await page.evaluate(() => { window.__calls.length = 0; window.__takeDelay = 300 })
  await page.keyboard.press('c')
  await page.keyboard.press('d')
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')
  recorded = await calls(page)
  assert.equal(recorded.filter(call => call.url.includes('/input')).length, 0, 'keys during the retake are never sent')
  assert.match(await note(page), /Typing is back: type again/)

  // A paste in the ended state only retakes; its text is not sent.
  await page.evaluate(() => { window.__takeDelay = 0 })
  await endTyping()
  await page.evaluate(() => {
    window.__calls.length = 0
    const target = document.querySelector('.cs-screen')
    const data = new DataTransfer()
    data.setData('text/plain', 'echo PASTED\n')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')
  recorded = await calls(page)
  assert.equal(recorded.filter(call => call.url.includes('/take')).length, 1, 'the paste retakes')
  assert.equal(recorded.filter(call => call.url.includes('/input')).length, 0, 'the paste is never sent')
  assert.match(await note(page), /Typing is back: type again/)

  assert.deepEqual(errors, [], 'the pane throws nothing')
})

function codeDocument(t) {
  const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
  const { window } = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://automagik.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  })
  t.after(() => window.close())
  window.Response = Response
  window.TextEncoder = TextEncoder
  // xterm can mount for the stream lifecycle test without measuring a real display.
  window.ResizeObserver = class { observe() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
  window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: () => ({ width: 8 }) })
  window.eval(seeds.outputFiles[0].text)
  window.require = name => window.nativeSeeds[name]
  window.eval(app.outputFiles[0].text)
  return window
}

async function waitFor(check, message) {
  const until = Date.now() + 2000
  while (!check() && Date.now() < until) await delay(10)
  assert.ok(check(), message)
}

const DESKTOP_ONLY = { v: 1, machine: null, projects: [], reason: 'desktop-only' }
const LIVE_TREE = {
  v: 1,
  machine: { name: 'This computer', core: 'fake-core' },
  projects: [{ folder: '/atlas', name: 'Atlas', bots: [
    { id: 'b-aaaaaaaaaa', name: 'Atlas', status: 'idle', terminal: { id: 't1', cols: 80, rows: 24 }, workers: [] },
  ] }],
}
const portuguese = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))

const REGISTRY_BOT = {
  id: 'session-12345678-1234-1234-1234-123456789abc', name: 'Builder', status: 'not-running', terminal: null,
  workers: [],
}
const REVIEWER = { terminal: 't2', role: 'Reviewer', status: 'idle' }
const withRegistryBot = () => {
  const tree = structuredClone(LIVE_TREE)
  tree.projects[0].bots.push(structuredClone(REGISTRY_BOT))
  return tree
}
const codeRow = (document, label) => [...document.querySelectorAll('.cs-row')].find(row => row.querySelector('.cs-row-label').textContent === label)
const herdrButton = (document, label) => {
  const action = codeRow(document, label)?.nextElementSibling
  return action?.getAttribute('aria-label') === 'Open in Herdr' ? action : null
}

test('a Code list with no footer checks Herdr on mount and keeps the registry Bot through the offer and Retry', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const tree = withRegistryBot()
  const shown = tree.projects[0].bots[0].id
  tree.projects[0].bots[0].workers.push(REVIEWER)
  const calls = []
  const status = Promise.withResolvers()
  let statusReads = 0
  const offer = { ok: false, reason: 'update', latest: '2.0.0' }
  const answers = [offer, { ok: false, reason: 'start' }, { ok: true, raised: true }, offer, { ok: true, raised: true }]
  window.omniDesktop = { herdr: {
    status: () => { statusReads++; return status.promise },
    open: request => calls.push(['legacy', request]),
    openCodeRow: (...args) => { calls.push(args); return answers.shift() },
  } }
  await window.mountCodeBarFixture(tree, shown)
  await waitFor(() => statusReads === 1 && codeRow(document, REGISTRY_BOT.name), 'the cold Code list reads status')
  assert.equal(herdrButton(document, REGISTRY_BOT.name), null)
  status.resolve({ state: 'closed' })
  const action = () => herdrButton(document, REGISTRY_BOT.name)
  await waitFor(action, 'the registry Bot has an action after status arrives')
  assert.equal(action().title, 'Code: open this Bot’s folder in Herdr')
  assert.equal(action().className, 'cs-btn cs-row-note')
  assert.equal(action().textContent, 'Herdr')
  assert.equal(action().tabIndex, 0)
  action().focus()
  assert.equal(document.activeElement, action())
  assert.equal(codeRow(document, REGISTRY_BOT.name).hasAttribute('aria-current'), false)
  assert.deepEqual(calls, [])

  action().dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }))
  assert.deepEqual(calls, [[REGISTRY_BOT.id]], 'the bridge runs during the click')
  assert.deepEqual(Array.from(window.__codePicks), [])
  assert.equal(window.__codeBubbles, 0)
  const noticeButton = (place, label) => [...document.querySelectorAll(`${place} .bt-code-note button`)].find(button => button.textContent === label)
  await waitFor(() => noticeButton('.lb-rows', 'Open this version'), 'the list shows the offer with the footer collapsed')
  noticeButton('.lb-rows', 'Open this version').click()
  await waitFor(() => noticeButton('.lb-rows', 'Retry'), 'the list shows the failure')
  noticeButton('.lb-rows', 'Retry').click()
  await waitFor(() => !document.querySelector('.bt-code-note') && !action().disabled, 'Retry completes')

  window.showCodeFooter(true)
  action().click()
  await waitFor(() => noticeButton('.lb-foot', 'Update and open'), 'the mounted footer shows the next offer')
  assert.equal(document.querySelector('.lb-rows .bt-code-note'), null)
  window.showCodeFooter(false)
  await waitFor(() => noticeButton('.lb-rows', 'Update and open'), 'the offer returns to the list when the footer unmounts')
  window.showCodeFooter(true)
  await waitFor(() => noticeButton('.lb-foot', 'Update and open'), 'the footer shows the same offer again')
  noticeButton('.lb-foot', 'Update and open').click()
  await waitFor(() => !document.querySelector('.bt-code-note') && !action().disabled, 'the footer answer completes')
  assert.deepEqual(structuredClone(calls), [
    [REGISTRY_BOT.id], [REGISTRY_BOT.id, { update: false }], [REGISTRY_BOT.id],
    [REGISTRY_BOT.id], [REGISTRY_BOT.id, { update: true }],
  ])
  codeRow(document, REGISTRY_BOT.name).click()
  codeRow(document, 'Reviewer').dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true, detail: 1 }))
  assert.deepEqual(structuredClone(window.__codePicks), [
    [{ botId: REGISTRY_BOT.id, worker: null }, { beside: false }],
    [{ botId: shown, worker: 't2' }, { beside: true }],
  ])
})

test('the Code row action renders its Brazilian Portuguese accessible label', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.setCodeLocale('pt', portuguese)
  window.omniDesktop = { herdr: {
    status: () => ({ state: 'open' }),
    open: () => ({ ok: true, raised: true }),
    openCodeRow: () => ({ ok: true, raised: true }),
  } }
  await window.mountCodeBarFixture(withRegistryBot(), REGISTRY_BOT.id)
  const action = () => codeRow(document, REGISTRY_BOT.name)?.nextElementSibling
  await waitFor(() => action()?.getAttribute('aria-label') === 'Abrir no Herdr', 'the row has a translated action')
})

test('the seat Code tree sends a worker action to its parent Bot without switching terminals', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const calls = []
  window.omniDesktop = { herdr: {
    status: () => ({ state: 'open' }),
    open: request => calls.push(['legacy', request]),
    openCodeRow: (...args) => { calls.push(args); return { ok: true, raised: true } },
  } }
  const tree = withRegistryBot()
  tree.projects[0].bots[1].workers.push(REVIEWER)
  window.mountSeatFixture(tree)
  await waitFor(() => document.querySelector('[data-face=terminal]'), 'the seat switch appeared')
  document.querySelector('[data-face=terminal]').click()
  const worker = () => herdrButton(document, 'Reviewer')
  await waitFor(() => worker() && window.__streams.length === 1, 'the seat shows the worker action')
  worker().click()
  assert.deepEqual(calls, [[REGISTRY_BOT.id]])
  assert.equal(window.codeSnapshot().selected.botId, tree.projects[0].bots[0].id)
  assert.equal(window.codeSnapshot().beside.length, 0)
  assert.equal(window.__streams.length, 1)
})

test('the seat tree keeps a worker offer and its answer on the parent Bot without a footer', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const calls = []
  const offer = { ok: false, reason: 'update', latest: '2.0.0' }
  window.omniDesktop = { herdr: {
    status: () => ({ state: 'open' }),
    open: request => calls.push(['legacy', request]),
    openCodeRow: (...args) => { calls.push(args); return calls.length === 1 ? offer : { ok: true, raised: true } },
  } }
  const tree = withRegistryBot()
  tree.projects[0].bots[1].workers.push(REVIEWER)
  window.mountSeatFixture(tree)
  await waitFor(() => document.querySelector('[data-face=terminal]'), 'the seat switch appeared')
  document.querySelector('[data-face=terminal]').click()
  await waitFor(() => herdrButton(document, 'Reviewer'), 'the seat shows the worker action')
  herdrButton(document, 'Reviewer').click()
  const answer = () => [...document.querySelectorAll('.cs-tree .bt-code-note button')]
    .find(button => button.textContent === 'Update and open')
  await waitFor(answer, 'the seat tree shows the offer without a footer')
  answer().click()
  await waitFor(() => !document.querySelector('.cs-tree .bt-code-note'), 'the offer answer completes')
  assert.deepEqual(structuredClone(calls), [[REGISTRY_BOT.id], [REGISTRY_BOT.id, { update: true }]])
})

for (const bridge of ['none', 'legacy', 'missing']) {
  test(`the Code list hides its row actions with a ${bridge} bridge`, async (t) => {
    const window = codeDocument(t)
    const { document } = window
    const tree = withRegistryBot()
    const calls = []
    let statusReads = 0
    if (bridge !== 'none') window.omniDesktop = { herdr: {
      status: () => { statusReads++; return { state: bridge === 'missing' ? 'missing' : 'open' } },
      open: request => calls.push(['legacy', request]),
      ...(bridge === 'missing' ? { openCodeRow: (...args) => calls.push(args) } : {}),
    } }
    await window.mountCodeBarFixture(tree, REGISTRY_BOT.id)
    if (bridge === 'legacy') window.showCodeFooter(true) // The legacy lookup also knows this Session id.
    await waitFor(() => codeRow(document, REGISTRY_BOT.name)
      && (bridge === 'legacy' ? document.querySelector('.lb-foot .bt-code-seg') : bridge !== 'missing' || statusReads > 0),
    'the Code list and available legacy footer rendered')
    await delay(0)
    assert.equal(document.querySelector('[aria-label="Open in Herdr"]'), null)
    codeRow(document, REGISTRY_BOT.name).click()
    assert.deepEqual(calls, [])
  })
}

for (const [language, message] of [
  ['en', 'Terminals show in the Automagik desktop app.'],
  ['zh', '终端会显示在 Automagik 桌面应用中。'],
  ['pt', 'Os terminais aparecem no app Automagik para desktop.'],
]) {
  test(`a denial arriving after mount shows one desktop message in ${language} without loading the pane`, async (t) => {
    const window = codeDocument(t)
    const { promise, resolve } = Promise.withResolvers()
    window.__readCodeTree = () => promise
    const pressed = window.pressTerminal()
    window.mountCodeBody(language, portuguese)
    await waitFor(() => window.document.querySelector('#code-fixture'), 'the body mounted before the tree answered')
    resolve(Response.json({ ok: true, value: DESKTOP_ONLY }))
    await pressed

    const body = () => window.document.querySelector('.cs-host')
    await waitFor(body, 'the mounted body reacted to the denial')
    assert.deepEqual(Array.from(body().children, child => [child.tagName, child.className, child.textContent]), [['P', 'cs-empty', message]])
    assert.equal(window.__chunkRequests.length, 0)
    assert.equal(window.__streams.length, 0)
    assert.equal(window.__calls.some(call => call.url.includes('/code/')), false)
  })
}

test('a denied refresh unmounts the live pane, closes its stream and releases typing', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.__readCodeTree = () => Response.json({ ok: true, value: LIVE_TREE })
  await window.pressTerminal()
  window.mountCodeBody('en')
  await waitFor(() => window.__streams.length === 1, 'the pane opened a stream')
  document.querySelector('.cs-screen').click()
  await waitFor(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing', 'typing started')

  window.__calls.length = 0
  window.__readCodeTree = () => Response.json({ ok: true, value: DESKTOP_ONLY })
  await window.refreshCodeTree()
  await waitFor(() => window.__closed && window.__calls.some(call => call.url.endsWith('/release')), 'the stream closed and typing was released')
  assert.equal(document.querySelector('.cs-host').textContent, 'Terminals show in the Automagik desktop app.')
  assert.equal(document.querySelector('.cs-pane'), null)
  assert.equal(window.__streams.length, 1)
  assert.deepEqual(Array.from(window.__calls, call => call.url).filter(url => url.includes('/code/')), ['api/omni-ui/code/release'])
})

test('a tree read error stays visible and only the next Terminal press retries the read', async (t) => {
  const window = codeDocument(t)
  window.__readCodeTree = () => new Response(null, { status: 503 })
  await window.pressTerminal()
  window.mountCodeBody('en')
  const message = () => window.document.querySelector('.cs-empty')?.textContent
  await waitFor(() => message() === 'The Code side could not read this computer’s team.', 'the read error stayed visible')
  const reads = () => window.__calls.filter(call => call.body?.endpoint === 'code-tree').length
  assert.equal(reads(), 1)

  window.__readCodeTree = () => Response.json({ ok: true, value: DESKTOP_ONLY })
  await window.pressTerminal()
  await waitFor(() => message() === 'Terminals show in the Automagik desktop app.', 'the next Terminal press showed the new response')
  assert.equal(reads(), 2)
  assert.equal(window.__streams.length, 0)
})

async function paneBrowser(t) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root" style="display:flex;width:520px;height:240px"></div>' })
    : route.abort()))
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  t.after(() => assert.deepEqual(errors, [], 'the panes throw nothing'))
  return page
}

test('a 120×40 grid shrinks, scrolls to the last cell if needed, grows back and resets in write order', async (t) => {
  const page = await paneBrowser(t)
  if (!page) return
  await page.evaluate(async () => {
    await window.inspectTerms()
    window.__initialGrid = { cols: 120, rows: 40 }
    window.mountPane()
  })
  await page.waitForFunction(() => window.__terms[0]?.options.fontSize < 12)
  assert.deepEqual(await page.evaluate(() => [window.__terms[0].cols, window.__terms[0].rows]), [120, 40])
  const reachable = await page.locator('.cs-screen').evaluate((box) => {
    const screen = box.querySelector('.xterm-screen')
    box.scrollLeft = box.scrollWidth
    box.scrollTop = box.scrollHeight
    const area = box.getBoundingClientRect()
    const grid = screen.getBoundingClientRect()
    return grid.right <= area.left + box.clientWidth + 1 && grid.bottom <= area.top + box.clientHeight + 1
  })
  assert.equal(reachable, true)

  await page.locator('#root').evaluate((root) => { root.style.width = '1500px'; root.style.height = '1000px' })
  await page.waitForFunction(() => window.__terms[0].options.fontSize === 12)
  await page.evaluate(() => {
    const stream = window.__streams[0]
    stream.emit('data', 'discard this old paint')
    stream.emit('reset', { cols: 95, rows: 30 })
    stream.emit('data', '\x1b[3;5Hnew paint')
  })
  await page.waitForFunction(() => window.__terms[0].buffer.active.getLine(2)?.translateToString(true) === '    new paint')
  assert.deepEqual(await page.evaluate(() => [window.__terms[0].cols, window.__terms[0].rows]), [95, 30])
  assert.equal(await page.evaluate(() => window.__terms[0].buffer.active.getLine(0).translateToString(true)), '')
})

test('reverse take replies send the next key to the latest pane and release the stale session', async (t) => {
  const page = await paneBrowser(t)
  if (!page) return
  await page.evaluate(() => {
    window.__pending = {}
    window.__takeAnswer = ({ bot }) => new Promise(resolve => {
      window.__pending[bot] = session => resolve(Response.json({ session }))
    })
    window.mountTwoPanes()
  })
  const screens = page.locator('.cs-screen')
  await page.waitForFunction(() => document.querySelectorAll('.cs-screen[aria-label="View only · click to type"]').length === 2)
  await screens.first().click()
  await screens.last().evaluate(node => node.click())
  await page.evaluate(() => window.__pending['b-bbbbbbbbbb']('latest'))
  await page.locator('.cs-screen[data-code-mode=typing]').waitFor()
  await page.evaluate(() => window.__pending['b-aaaaaaaaaa']('stale'))
  await page.waitForFunction(() => window.__calls.some(call => call.url.endsWith('/release') && call.body.session === 'stale'))
  await page.keyboard.press('x')
  await page.waitForFunction(() => window.__calls.some(call => call.url.endsWith('/input')))
  const recorded = await calls(page)
  const attempts = recorded.filter(call => call.url.endsWith('/take'))
  assert.notEqual(attempts[0].body.viewer, attempts[1].body.viewer)
  const viewers = await page.evaluate(() => window.__streams.map(stream => new URLSearchParams(stream.url.split('?')[1]).get('viewer')))
  assert.deepEqual(attempts.map(call => call.body.viewer), viewers)
  assert.deepEqual(recorded.filter(call => call.url.endsWith('/input')).map(call => [call.body.session, Buffer.from(call.body.data, 'base64').toString()]), [['latest', 'x']])
})

test('a stream error cancels a pending take and reopening requires the pane handshake', async (t) => {
  const page = await paneBrowser(t)
  if (!page) return
  await page.evaluate(async () => {
    await window.inspectTerms()
    window.__takeAnswer = () => new Promise(resolve => { window.__finishTake = () => resolve(Response.json({ session: 'lost' })) })
    window.mountPane()
  })
  const screen = page.locator('.cs-screen')
  await page.getByLabel('View only · click to type', { exact: true }).click()
  await page.evaluate(() => {
    window.__streams[0].onerror()
    window.__finishTake()
  })
  await page.waitForFunction(() => window.__calls.some(call => call.url.endsWith('/release') && call.body.session === 'lost'))
  assert.equal(await screen.getAttribute('aria-label'), 'The terminal could not be reached')
  // The click itself focuses xterm's own textarea; what matters is that the late take left
  // input off, so a key typed now reaches no session.
  assert.equal(await page.evaluate(() => window.__terms[0].options.disableStdin), true)
  await page.keyboard.type('x')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await calls(page)).filter(call => call.url.endsWith('/input')).length, 0)
  await screen.click()
  assert.equal((await calls(page)).filter(call => call.url.endsWith('/take')).length, 1)

  await page.evaluate(() => { window.__manualPane = true })
  await page.getByRole('button', { name: 'Reconnect' }).click()
  await page.waitForFunction(() => window.__streams.length === 2)
  await screen.click()
  assert.equal((await calls(page)).filter(call => call.url.endsWith('/take')).length, 1)
  await page.evaluate(() => window.__streams[1].emit('pane', {}))
  await page.getByLabel('View only · click to type', { exact: true }).waitFor()
})

test('an initial typing refusal stays view-only without key or paste retakes', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  let error = 'typing-elsewhere'
  window.__takeAnswer = () => Response.json({ error }, { status: 409 })
  window.mountPane()
  const screen = () => document.querySelector('.cs-screen')
  await waitFor(() => screen()?.getAttribute('aria-label') === 'View only · click to type', 'the watch opened')
  screen().click()
  await waitFor(() => screen().dataset.codeMode === 'elsewhere', 'the take was refused as typing elsewhere')
  assert.equal(screen().getAttribute('aria-label'), 'Typing elsewhere · view only')
  assert.equal(document.querySelector('.cs-paste-note'), null)
  window.__calls.length = 0
  const paste = new window.Event('paste', { bubbles: true, cancelable: true })
  screen().dispatchEvent(paste)
  document.querySelector('.xterm-helper-textarea').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.deepEqual(Array.from(window.__calls), [])

  error = 'attach-refused'
  screen().click()
  await waitFor(() => screen().dataset.codeMode === 'view', 'an attach refusal stayed in view mode')
  assert.equal(screen().getAttribute('aria-label'), 'View only · click to type')
  assert.equal(document.querySelector('.cs-paste-note'), null)
  assert.equal(window.__calls.filter(call => call.url.endsWith('/take')).length, 1)
})

test('the seat face toggles beside panes, prunes a gone worker and clears the selection on Back', async (t) => {
  const page = await paneBrowser(t)
  if (!page) return
  const tree = structuredClone(LIVE_TREE)
  const [bot] = tree.projects[0].bots
  bot.workers = ['Reviewer', 'Builder', 'Tester', 'Runner'].map((role, index) => ({
    terminal: `t${index + 2}`, role, status: 'idle', branch: 'refs/heads/feature',
  }))
  await page.locator('#root').evaluate((root) => { root.style.width = '1400px'; root.style.height = '900px' })
  await page.evaluate(value => window.mountSeatFixture(value), tree)
  await page.locator('[data-face=terminal]').click()
  const terminal = page.locator('[data-seat-face=terminal]')
  const pane = terminal.locator('.cs-pane')
  const row = name => terminal.locator('.cs-row', { hasText: name })
  const beside = name => row(name).click({ modifiers: ['Control'] })
  await page.waitForFunction(() => window.__streams.length === 1)
  for (const name of ['Reviewer', 'Builder', 'Tester']) await beside(name)
  await page.waitForFunction(() => window.__streams.length === 4)
  assert.equal(await terminal.locator('.cs-row[aria-current=true]').count(), 4)
  assert.equal(await pane.count(), 4)
  assert.equal(await pane.nth(0).evaluate(el => el.offsetTop), await pane.nth(1).evaluate(el => el.offsetTop))
  assert.ok(await pane.nth(2).evaluate(el => el.offsetTop) > await pane.nth(0).evaluate(el => el.offsetTop))
  await beside('Runner')
  const refusal = terminal.locator('.cs-pane-head .cs-paste-note[data-wrap]')
  assert.match(await refusal.textContent(), /Atlas, Atlas · Reviewer, Atlas · Builder, Atlas · Tester/)
  assert.equal(await refusal.evaluate(el => getComputedStyle(el).whiteSpace), 'normal')
  assert.equal(await page.evaluate(() => window.__streams.length), 4)
  await beside('Atlas')
  await terminal.locator('.cs-panes[data-count="3"]').waitFor()
  assert.equal(await refusal.count(), 0)
  assert.equal(await row('Atlas').getAttribute('aria-current'), null)

  await row('Reviewer').click()
  await terminal.locator('.cs-panes[data-count="1"]').waitFor()
  await row('Runner').focus()
  await page.keyboard.press('Control+Enter')
  await terminal.locator('.cs-panes[data-count="2"]').waitFor()
  assert.equal(await row('Runner').getAttribute('aria-current'), 'true')
  await page.evaluate(async () => {
    const workers = window.__tree.projects[0].bots[0].workers
    window.__tree.projects[0].bots[0].workers = workers.filter(worker => worker.role !== 'Runner')
    await window.refreshCodeTree()
  })
  await terminal.locator('.cs-panes[data-count="1"]').waitFor()
  assert.equal(await row('Runner').count(), 0)
  await beside('Atlas')
  await terminal.locator('.cs-panes[data-count="2"]').waitFor()
  await terminal.getByRole('button', { name: 'Back to chat' }).click()
  await page.locator('[data-seat-face=chat]').waitFor()
  assert.deepEqual(await page.evaluate(() => {
    const state = window.codeSnapshot()
    return [state.selected, state.beside, state.refused]
  }), [null, [], null])
})

test('the newest pending take wins even without pointer events; a later stream error cancels its own pending take', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  await window.inspectTerms()
  const pending = new Map()
  window.__takeAnswer = ({ bot }) => {
    const { promise, resolve } = Promise.withResolvers()
    pending.set(bot, resolve)
    return promise
  }
  window.mountTwoPanes()
  const screen = index => document.querySelectorAll('.cs-screen')[index]
  await waitFor(() => screen(1)?.getAttribute('aria-label') === 'View only · click to type', 'both watches opened')
  screen(0).click()
  screen(1).click()
  pending.get('b-bbbbbbbbbb')(Response.json({ session: 'latest' }))
  await waitFor(() => screen(1).dataset.codeMode === 'typing', 'the latest pane took typing')
  pending.get('b-aaaaaaaaaa')(Response.json({ session: 'stale' }))
  const released = id => window.__calls.some(call => call.url.endsWith('/release') && call.body.session === id)
  await waitFor(() => released('stale'), 'the stale reply was released')

  window.__terms[0].input('a', true)
  window.__terms[1].input('b', true)
  await waitFor(() => window.__calls.some(call => call.url.endsWith('/input')), 'the latest pane sent input')
  assert.deepEqual(Array.from(window.__calls.filter(call => call.url.endsWith('/input')),
    call => [call.body.session, Buffer.from(call.body.data, 'base64').toString()]), [['latest', 'b']])
  assert.equal(document.activeElement, window.__terms[1].textarea)

  screen(0).click()
  window.__streams[0].onerror()
  pending.get('b-aaaaaaaaaa')(Response.json({ session: 'disconnected' }))
  await waitFor(() => released('disconnected'), 'the disconnected pane released its late reply')
  assert.equal(screen(0).getAttribute('aria-label'), 'The terminal could not be reached')
  assert.equal(window.__terms[0].options.disableStdin, true)
  assert.notEqual(document.activeElement, window.__terms[0].textarea)
})

test('a seat rebinding remounts its watcher, and resets apply before the new paint', async (t) => {
  const window = codeDocument(t)
  await window.inspectTerms()
  let tree = structuredClone(LIVE_TREE)
  window.__readCodeTree = () => Response.json({ ok: true, value: tree })
  await window.pressTerminal()
  window.mountCodeBody('en')
  await waitFor(() => window.__streams.length === 1, 'the seat opened its first watch')
  const term = window.__terms[0]
  assert.deepEqual([term.cols, term.rows], [80, 24])
  window.__streams[0].emit('data', 'old paint')
  window.__streams[0].emit('reset', { cols: 95, rows: 30 })
  window.__streams[0].emit('data', '\x1b[3;5Hnew paint')
  await waitFor(() => term.buffer.active.getLine(2)?.translateToString(true) === '    new paint', 'the second paint followed its reset')
  assert.deepEqual([term.cols, term.rows], [95, 30])
  assert.equal(term.buffer.active.getLine(0).translateToString(true), '')

  tree = structuredClone(tree)
  tree.projects[0].bots[0].terminal.id = 't2'
  await window.refreshCodeTree()
  await waitFor(() => window.__streams.length === 2 && window.__closed, 'the seat closed its first watch and mounted another')
  assert.notEqual(window.__streams[0].url, window.__streams[1].url, 'the new watcher has a distinct viewer')
})

test('the seat row keyboard shortcut adds once and a fifth pick leaves the streams intact', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const tree = structuredClone(LIVE_TREE)
  tree.projects[0].bots[0].workers = ['Reviewer', 'Builder', 'Tester', 'Runner'].map((role, index) => ({
    terminal: `t${index + 2}`, role, status: 'idle',
  }))
  window.mountSeatFixture(tree)
  await waitFor(() => document.querySelector('[data-face=terminal]'), 'the seat switch appeared')
  document.querySelector('[data-face=terminal]').click()
  const row = label => Array.from(document.querySelectorAll('.cs-row')).find(button => button.querySelector('.cs-row-label').textContent === label)
  const beside = label => row(label).dispatchEvent(new window.MouseEvent('click', { ctrlKey: true, bubbles: true, detail: 1 }))
  await waitFor(() => window.__streams.length === 1 && row('Reviewer'), 'the first seat watch opened')

  const shortcut = new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
  await window.flushCodePick(() => {
    row('Reviewer').dispatchEvent(shortcut)
  })
  assert.equal(shortcut.defaultPrevented, true)
  row('Reviewer').click() // A keyboard-generated click has detail 0.
  await window.flushCodePick(() => beside('Builder'))
  await window.flushCodePick(() => beside('Tester'))
  await waitFor(() => window.__streams.length === 4, 'four distinct panes opened')
  assert.equal(document.querySelectorAll('.cs-row[aria-current=true]').length, 4)
  beside('Runner')
  const refusal = () => document.querySelector('.cs-pane-head .cs-paste-note[data-wrap]')
  await waitFor(refusal, 'the first pane showed the refusal')
  assert.match(refusal().textContent, /Atlas, Atlas · Reviewer, Atlas · Builder, Atlas · Tester/)
  assert.equal(window.__streams.length, 4)
  beside('Atlas')
  await waitFor(() => document.querySelector('.cs-panes')?.dataset.count === '3', 'the first pane was removed')
  assert.equal(refusal(), null)
  document.querySelector('[aria-label="Back to chat"]').click()
  await waitFor(() => document.querySelector('[data-seat-face=chat]'), 'Back returned to the seat chat')
  assert.equal(window.codeSnapshot().beside.length, 0)
})

test('outside pointerdown and Escape discard pending takes before their replies arrive', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  await window.inspectTerms()
  const pending = []
  window.__takeAnswer = () => {
    const answer = Promise.withResolvers()
    pending.push(answer.resolve)
    return answer.promise
  }
  window.mountPane()
  const screen = () => document.querySelector('.cs-screen')
  await waitFor(() => screen()?.getAttribute('aria-label') === 'View only · click to type', 'the watch opened')

  for (const [cancel, session] of [
    [() => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })), 'outside'],
    [() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 'escape'],
  ]) {
    screen().click()
    await waitFor(() => pending.length > 0, 'the take started')
    const answer = pending.shift()
    cancel()
    answer(Response.json({ session }))
    await waitFor(() => window.__calls.some(call => call.url.endsWith('/release') && call.body.session === session), 'the stale session was released')
    assert.equal(screen().dataset.codeMode, 'view')
    assert.equal(window.__terms[0].options.disableStdin, true)
    assert.notEqual(document.activeElement, window.__terms[0].textarea)
  }
})

test('a late refusal for an old input session cannot end a newer typing session', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  await window.inspectTerms()
  let rejectOldInput
  let inputs = 0
  window.__inputAnswer = () => {
    if (++inputs === 1) return new Promise(resolve => { rejectOldInput = resolve })
    return new Response(null, { status: 204 })
  }
  window.mountPane()
  const screen = () => document.querySelector('.cs-screen')
  await waitFor(() => screen()?.getAttribute('aria-label') === 'View only · click to type', 'the watch opened')
  screen().click()
  await waitFor(() => screen().dataset.codeMode === 'typing', 'the first take completed')
  window.__terms[0].input('a', true)
  await waitFor(() => rejectOldInput, 'the first input request is pending')
  const first = window.__calls.find(call => call.url.endsWith('/input')).body.session

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  screen().click()
  await waitFor(() => screen().dataset.codeMode === 'typing', 'the second take completed')
  rejectOldInput(Response.json({ error: 'not-typing' }, { status: 409 }))
  await delay(30)
  assert.equal(screen().dataset.codeMode, 'typing')
  assert.equal(window.__terms[0].options.disableStdin, false)
  window.__terms[0].input('b', true)
  await waitFor(() => window.__calls.filter(call => call.url.endsWith('/input')).length === 2, 'the second session sent input')
  const second = window.__calls.filter(call => call.url.endsWith('/input'))[1]
  assert.notEqual(second.body.session, first)
  assert.equal(Buffer.from(second.body.data, 'base64').toString(), 'b')
})

test('a network failure on the first take leaves view-only without an idle-resume note', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const failure = Promise.withResolvers()
  window.__takeAnswer = () => failure.promise
  window.mountPane()
  const screen = () => document.querySelector('.cs-screen')
  await waitFor(() => screen()?.getAttribute('aria-label') === 'View only · click to type', 'the watch opened')
  screen().click()
  await waitFor(() => window.__calls.some(call => call.url.endsWith('/take')), 'the first take started')
  failure.reject(new Error('offline'))
  await waitFor(() => screen().dataset.codeMode === 'view', 'the first take failed')
  assert.equal(document.querySelector('.cs-paste-note'), null)
  window.__calls.length = 0
  screen().dispatchEvent(new window.Event('paste', { bubbles: true, cancelable: true }))
  assert.deepEqual(Array.from(window.__calls), [])
  delete window.__takeAnswer
  screen().click()
  await waitFor(() => screen().dataset.codeMode === 'typing', 'a later click retried successfully')
  assert.equal(window.__calls.filter(call => call.url.endsWith('/take')).length, 1)
})

test('a Code view multiplexes four panes, routes their paints and reopens them together', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const tree = structuredClone(LIVE_TREE)
  const bot = tree.projects[0].bots[0]
  bot.workers = ['Reviewer', 'Builder', 'Tester'].map((role, index) => ({ terminal: `t${index + 2}`, role, status: 'idle' }))
  await window.inspectTerms()
  window.mountSeatFixture(tree)
  const screens = () => [...document.querySelectorAll('.cs-screen')]
  const openCount = () => screens().filter(screen => screen.getAttribute('aria-label') === 'View only · click to type').length
  const params = stream => new URLSearchParams(stream.url.split('?')[1])
  const live = () => window.__streams.filter(stream => !stream.closed)
  const text = index => window.__terms[index].buffer.active.getLine(0).translateToString(true)
  await waitFor(() => document.querySelector('[data-face=terminal]'), 'the seat switch appeared')
  document.querySelector('[data-face=terminal]').click()
  await waitFor(() => openCount() === 1, 'the single pane opened')
  const [single] = live()
  assert.deepEqual([...params(single).keys()], ['bot', 'viewer'])
  assert.equal(params(single).get('bot'), bot.id)
  single.emit('data', 'single history')
  await waitFor(() => text(0) === 'single history', 'the single stream used raw base64')

  let finishTake
  window.__takeAnswer = () => new Promise(resolve => { finishTake = resolve })
  screens()[0].click()
  await waitFor(() => finishTake, 'a take is pending during a pane-set change')
  for (const { role } of bot.workers) {
    const row = [...document.querySelectorAll('.cs-row')].find(button => button.querySelector('.cs-row-label').textContent === role)
    await window.flushCodePick(() => row.dispatchEvent(new window.MouseEvent('click', { ctrlKey: true, bubbles: true, detail: 1 })))
  }
  await waitFor(() => openCount() === 4, 'all four panes received their handshake')
  assert.equal(window.__streams.length, 4)
  assert.equal(live().length, 1)
  const [multi] = live()
  assert.ok(window.__streams.every(stream => stream.previousOpen === 0), 'each source was closed before the next was constructed')
  assert.deepEqual(params(multi).getAll('bot'), [bot.id, bot.id, bot.id, bot.id])
  assert.deepEqual(params(multi).getAll('worker'), ['', 't2', 't3', 't4'])
  const viewers = params(multi).getAll('viewer')
  assert.equal(viewers[0], params(single).get('viewer'))
  assert.equal(new Set(viewers).size, 4)
  assert.equal(new Set(viewers.map(viewer => viewer.slice(0, viewer.lastIndexOf('.')))).size, 1)
  finishTake(Response.json({ session: 'old-take' }))
  await waitFor(() => window.__calls.some(call => call.url.endsWith('/release') && call.body.session === 'old-take'), 'the old take was released')
  assert.ok(window.__terms.every(term => term.options.disableStdin))
  assert.equal(text(0), '', 'stream replacement cleared the original paint')
  finishTake = undefined
  screens()[1].click()
  await waitFor(() => finishTake, 'a take is pending in the pane that will close')
  multi.emit('data', 'first paint', 0)
  multi.emit('data', 'discard this', 2)
  multi.emit('reset', { cols: 85, rows: 25 }, 2)
  multi.emit('data', 'third paint', 2)
  multi.emit('close', { reason: 'ended' }, 1)
  finishTake(Response.json({ session: 'closed-pane-take' }))
  await waitFor(() => window.__calls.some(call => call.url.endsWith('/release') && call.body.session === 'closed-pane-take'), 'the closed pane released its late take')
  await waitFor(() => text(0) === 'first paint' && text(2) === 'third paint' && openCount() === 3, 'paint, reset and close reached their tagged panes')
  assert.deepEqual([window.__terms[2].cols, window.__terms[2].rows], [85, 25])
  assert.equal(screens()[1].getAttribute('aria-label'), 'This terminal ended')
  assert.equal(text(1), '')
  assert.equal(live().length, 1)

  window.__manualPane = true
  document.querySelector('.cs-pane .cs-btn').click()
  await waitFor(() => window.__streams.length === 5 && screens().every(screen => screen.getAttribute('aria-label') === 'Opening the terminal…'), 'Reconnect reset every pane')
  assert.equal(live().length, 1)
  const [reopened] = live()
  assert.equal(reopened.url, multi.url)
  assert.equal(reopened.previousOpen, 0)
  multi.emit('data', 'stale', 0)
  for (let p = 0; p < 4; p += 1) reopened.emit('pane', {}, p)
  await waitFor(() => openCount() === 4, 'the reopened view received all handshakes')
  assert.equal(text(0), '')
  assert.equal(text(2), '')

  window.__takeAnswer = () => Response.json({ session: 'signed-out' })
  window.__inputStatus = 401
  screens()[2].click()
  await waitFor(() => screens()[2].dataset.codeMode === 'typing', 'the third pane took typing')
  const paste = new window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'test byte' } })
  screens()[2].dispatchEvent(paste)
  await waitFor(() => screens().every(screen => screen.getAttribute('aria-label') === 'The terminal could not be reached'), 'input 401 failed the entire view')
  assert.equal(live().length, 0)
  assert.ok(window.__terms.every(term => term.options.disableStdin))
})
