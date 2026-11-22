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
  await window.mountCodeBarFixture(tree)
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
  await waitFor(() => noticeButton('.lb-rows', 'Open this version'), 'the list shows the offer under the row tree')
  noticeButton('.lb-rows', 'Open this version').click()
  await waitFor(() => noticeButton('.lb-rows', 'Retry'), 'the list shows the failure')
  noticeButton('.lb-rows', 'Retry').click()
  await waitFor(() => !document.querySelector('.bt-code-note') && !action().disabled, 'Retry completes')

  action().click()
  await waitFor(() => noticeButton('.lb-rows', 'Update and open'), 'the row tree shows the next offer')
  noticeButton('.lb-rows', 'Update and open').click()
  await waitFor(() => !document.querySelector('.bt-code-note') && !action().disabled, 'the row answer completes')
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
  await window.mountCodeBarFixture(withRegistryBot())
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

for (const bridge of ['none', 'missing']) {
  test(`the Code list hides its row actions with a ${bridge} bridge`, async (t) => {
    const window = codeDocument(t)
    const { document } = window
    const tree = withRegistryBot()
    const calls = []
    let statusReads = 0
    if (bridge !== 'none') window.omniDesktop = { herdr: {
      status: () => { statusReads++; return { state: 'missing' } },
      open: request => calls.push(['legacy', request]),
      openCodeRow: (...args) => calls.push(args),
    } }
    await window.mountCodeBarFixture(tree)
    await waitFor(() => codeRow(document, REGISTRY_BOT.name) && (bridge === 'none' || statusReads > 0), 'the Code list rendered')
    await delay(0)
    assert.equal(document.querySelector('[aria-label="Open in Herdr"]'), null)
    codeRow(document, REGISTRY_BOT.name).click()
    assert.deepEqual(calls, [])
  })
}

test('a legacy desktop opens Herdr without a Bot space from the row and its offer', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const calls = []
  window.omniDesktop = { herdr: {
    status: () => ({ state: 'open' }),
    open: request => {
      calls.push(request)
      return request.update ? { ok: true, raised: true } : { ok: false, reason: 'update', latest: '2.0.0' }
    },
  } }
  const tree = withRegistryBot()
  tree.projects[0].bots.at(-1).id = 'session-341a3de3-87c4-4dda-b228-67efca79821b'
  await window.mountCodeBarFixture(tree)
  const action = () => herdrButton(document, REGISTRY_BOT.name)
  await waitFor(action, 'a legacy desktop has a row action')
  codeRow(document, REGISTRY_BOT.name).click()
  assert.deepEqual(calls, [], 'selecting a pane does not raise Herdr')
  action().click()
  const update = () => [...document.querySelectorAll('.lb-rows .bt-code-note button')].find(button => button.textContent === 'Update and open')
  await waitFor(update, 'the legacy offer is in the row tree')
  update().click()
  assert.deepEqual(structuredClone(calls), [{ botId: null }, { botId: null, update: true }])
})

test('only the tree that opened Herdr shows the notice and pointer entry refreshes status', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const calls = []
  let statusReads = 0
  window.omniDesktop = { herdr: {
    status: () => { statusReads++; return { state: 'open' } },
    open: request => calls.push(['legacy', request]),
    openCodeRow: (...args) => { calls.push(args); return { ok: false, reason: 'update', latest: '2.0.0' } },
  } }
  await window.mountCodeBarFixture(withRegistryBot(), { twoTrees: true })
  const trees = () => [...document.querySelectorAll('.lb-rows')]
  const action = (tree, label) => herdrButton(tree, label)
  await waitFor(() => trees().length === 2 && trees().every(tree => action(tree, REGISTRY_BOT.name)), 'both trees show the action')
  const [first, second] = trees()
  const row = action(second, REGISTRY_BOT.name)
  const readsBefore = statusReads
  row.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }))
  await waitFor(() => statusReads > readsBefore, 'pointer entry refreshes without a click')
  assert.deepEqual(calls, [])
  row.click()
  await waitFor(() => second.querySelector('.bt-code-note'), 'the second tree shows its offer')
  assert.equal(Boolean(first.querySelector('.bt-code-note')), false)
  action(first, 'Atlas').click()
  const update = () => [...first.querySelectorAll('.bt-code-note button')].find(button => button.textContent === 'Update and open')
  await waitFor(update, 'the first tree shows its own offer')
  assert.equal(Boolean(second.querySelector('.bt-code-note')), false)
  update().click()
  assert.deepEqual(structuredClone(calls), [[REGISTRY_BOT.id], [LIVE_TREE.projects[0].bots[0].id], [LIVE_TREE.projects[0].bots[0].id, { update: true }]])
  assert.deepEqual(Array.from(window.__codePicks), [])
  assert.equal(window.__streams.length, 0)
})

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

const ATLAS = 'b-aaaaaaaaaa'
const BUILDER = 'b-bbbbbbbbbb'
const atlasSeat = { id: ATLAS, key: ATLAS, kind: 'global', name: 'Atlas', terminal: 't1', status: 'idle', agent: 'claude' }
const builderSeat = { ...atlasSeat, id: BUILDER, key: BUILDER, name: 'Builder', terminal: 't4' }

function barTree() {
  const tree = structuredClone(LIVE_TREE)
  tree.projects[0].bots[0].workers = [
    { terminal: 't2', role: 'Reviewer', status: 'idle' },
    { terminal: 't3', role: 'Tester', status: 'idle' },
  ]
  tree.projects[0].bots.push({ id: BUILDER, name: 'Builder', status: 'idle', terminal: { id: 't4', cols: 80, rows: 24 }, workers: [] })
  return tree
}

const endpointTraffic = (endpoint, target = null) => ({ method: 'POST', url: '/api/omni-ui', endpoint, target })
const streamTraffic = (...target) => ({ method: 'EventSource', url: '/api/omni-ui/code/stream', target })
function exactTraffic(window, expected) {
  const received = window.__barTraffic.splice(0)
  const multiset = rows => Array.from(rows, row => JSON.stringify(row)).sort()
  assert.deepEqual(multiset(received), multiset(expected))
}

const barRow = (document, name) => [...document.querySelectorAll('nav[aria-label="Code team"] .cs-row')]
  .find(node => node.querySelector('.cs-row-label').textContent === name)
const sidebarFace = (document, part) => document.querySelector(`[data-face="${part}"]`)
const seatFace = (document, part) => document.querySelector(`.bt-seat-head [data-face="${part}"]`)
const teamSeat = (document, id) => document.querySelector(`[data-id="seat:${id}"]`)
const codePanel = document => document.querySelector('[data-code-panel]')

test('a Code Bot opens its own missing-terminal view, and only the worker row opens the worker', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const tree = barTree()
  tree.projects[0].bots[0].terminal = null
  window.mountBarFixture({ tree })
  await waitFor(() => sidebarFace(document, 'code'), 'side switch mounted')
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Atlas'), 'tree mounted')
  barRow(document, 'Atlas').click()
  await waitFor(() => codePanel(document)?.textContent.includes('No terminal for this Bot yet'), 'the offline Bot showed its own empty view')
  assert.equal(window.__streams.length, 0)
  barRow(document, 'Reviewer').click()
  await waitFor(() => window.__streams.length === 1, 'the worker opened')
  assert.ok(window.__barTraffic.some(row => row.method === 'EventSource'))
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('code-tree'), streamTraffic([ATLAS, 't2'])])
  codePanel(document).querySelector('[aria-label=Back]').click()
  await waitFor(() => document.querySelector('#conversation') && window.__closed, 'Back restored the conversation and closed the stream')
  exactTraffic(window, [])
})

test('a live Code seat outside Team keeps its Terminal face', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat] })
  await waitFor(() => teamSeat(document, ATLAS), 'Team has Atlas')
  assert.equal(teamSeat(document, BUILDER), null)
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Builder'), 'Code has Builder')
  barRow(document, 'Builder').click()
  await waitFor(() => window.__streams.length === 1 && codePanel(document)?.querySelector('.cs-pane-head'), 'Builder opened its terminal')
  assert.equal(Boolean(codePanel(document).querySelector('[data-face=chat]')), false)
  assert.deepEqual(Array.from(new URL(window.__streams[0].url, window.location.href).searchParams.getAll('bot')), [BUILDER])
})

test('pressing Terminal on Team requires the same seat in the fresh tree', async (t) => {
  for (const fresh of [null, { id: 't8', cols: 80, rows: 24 }]) {
    const window = codeDocument(t)
    const { document } = window
    const tree = barTree()
    tree.projects[0].bots[0].terminal = fresh
    window.mountBarFixture({ tree, seats: [atlasSeat] })
    await waitFor(() => teamSeat(document, ATLAS), 'a polled live seat showed')
    teamSeat(document, ATLAS).click()
    await waitFor(() => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79'), 'chat shows its rows')
    seatFace(document, 'terminal').click()
    await waitFor(() => document.querySelector('.bt-seat-why')?.textContent.includes('not running on this computer'), 'the fresh tree refused the seat')
    assert.equal(window.codeSnapshot().selected, null)
    assert.equal(window.__streams.length, 0)
    exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'), endpointTraffic('code-tree')])
  }
})

function scrollSeat(window, top) {
  const node = window.document.querySelector('.bt-seat-scroll')
  Object.defineProperties(node, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
  node.scrollTop = top
  node.dispatchEvent(new window.Event('scroll'))
  return node
}

test('a Team seat opened before flipping to Code stays in-panel and restores chat scroll', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat] })
  await waitFor(() => teamSeat(document, ATLAS), 'the seat is listed')
  teamSeat(document, ATLAS).click()
  await waitFor(() => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79'), 'the chat rendered')
  scrollSeat(window, 349)
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Atlas'), 'the Code list is showing')
  seatFace(document, 'terminal').click()
  await waitFor(() => window.__streams.length === 1, 'the in-panel watch opened')
  assert.equal(codePanel(document), null)
  assert.ok(document.querySelector('[data-seat-face=terminal] .cs-pane'))
  seatFace(document, 'chat').click()
  await waitFor(() => document.querySelector('.bt-seat-scroll')?.scrollTop === 349, 'the in-panel face kept its scroll')
  assert.ok(window.__streams.length)
  exactTraffic(window, [
    endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'), endpointTraffic('code-tree'),
    endpointTraffic('code-tree'), streamTraffic([ATLAS, null]),
  ])
})

test('a Code seat returns to the same four panes in order and keeps its chat scroll across a remount', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat, builderSeat] })
  await waitFor(() => sidebarFace(document, 'code'), 'side switch mounted')
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Atlas'), 'the Code list is showing')
  const pick = async (name, index) => {
    barRow(document, name).dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: index !== 0 }))
    await waitFor(() => window.__streams.length === index + 1, 'the watch set changed')
  }
  for (const [index, name] of ['Atlas', 'Builder', 'Reviewer', 'Tester'].entries()) await pick(name, index)
  const panes = [[ATLAS, null], [BUILDER, null], [ATLAS, 't2'], [ATLAS, 't3']]
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('code-tree'),
    ...panes.map((_, i) => streamTraffic(...panes.slice(0, i + 1)))])
  const heads = () => [...document.querySelectorAll('.cs-pane-head')]
  const chatButton = row => heads()[row].querySelector('[data-face=chat]')
  assert.deepEqual(heads().map((_head, index) => Boolean(chatButton(index))), [true, true, false, false])
  chatButton(1).click()
  await waitFor(() => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79'), 'the second seat opened in chat')
  assert.equal(window.codeSnapshot().side, 'code')
  assert.deepEqual(JSON.parse(JSON.stringify(window.codeSnapshot().seatOrigin.panes.map(pane => [pane.botId, pane.worker]))), panes)
  scrollSeat(window, 278)
  seatFace(document, 'terminal').click()
  await waitFor(() => window.__streams.length === 5, 'all four watches returned')
  assert.equal(document.querySelector('.cs-panes').dataset.count, '4')
  exactTraffic(window, [endpointTraffic('seat-chat-open', 't4'), endpointTraffic('seat-chat-close', 't4'), streamTraffic(...panes)])
  chatButton(1).click()
  await waitFor(() => document.querySelector('.bt-seat-scroll')?.scrollTop === 278, 'the remounted chat kept its scroll')
  document.querySelector('[aria-label="Back to the team"]').click()
  await waitFor(() => document.querySelector('#conversation'), 'Back restored the conversation')
  exactTraffic(window, [endpointTraffic('seat-chat-open', 't4'), endpointTraffic('seat-chat-close', 't4')])
})

test('Team and Code flip the list without closing the stream, and Back restores the previous panel', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat] })
  await waitFor(() => teamSeat(document, ATLAS), 'the seat was listed')
  teamSeat(document, ATLAS).click()
  await waitFor(() => document.querySelector('.bt-seat-scroll'), 'the seat chat is open')
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Reviewer'), 'the worker is listed')
  barRow(document, 'Reviewer').click()
  await waitFor(() => window.__streams.length === 1, 'one stream opened')
  sidebarFace(document, 'team').click()
  await waitFor(() => teamSeat(document, ATLAS), 'Team returned')
  assert.ok(codePanel(document))
  assert.equal(window.codeSnapshot().barSelected.worker, 't2')
  assert.equal(window.__streams[0].closed, false)
  codePanel(document).querySelector('[aria-label=Back]').click()
  await waitFor(() => window.__streams[0].closed, 'Back closed the stream')
  await waitFor(() => document.querySelector('.bt-seat-scroll'), 'Back restored the seat chat')
  exactTraffic(window, [
    endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'), endpointTraffic('code-tree'),
    endpointTraffic('seat-chat-close', 't1'), streamTraffic([ATLAS, 't2']), endpointTraffic('seat-chat-open', 't1'),
  ])
})

test('Back restores the previous Team seat after opening another seat’s Code and Chat faces', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat, builderSeat] })
  await waitFor(() => teamSeat(document, ATLAS), 'Team has Atlas')
  teamSeat(document, ATLAS).click()
  const title = () => document.querySelector('.bt-seat-title')?.textContent
  await waitFor(() => title() === 'Atlas', 'Atlas chat is open')
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Builder'), 'Code has Builder')
  barRow(document, 'Builder').click()
  await waitFor(() => codePanel(document)?.querySelector('[data-face=chat]'), 'Builder terminal has a chat face')
  codePanel(document).querySelector('[data-face=chat]').click()
  await waitFor(() => title() === 'Builder', 'Builder chat is open')
  seatFace(document, 'terminal').click()
  await waitFor(() => codePanel(document)?.querySelector('.cs-pane'), 'Builder terminal returned')
  codePanel(document).querySelector('[aria-label=Back]').click()
  await waitFor(() => title() === 'Atlas', 'Back restored Atlas by seat key')
  assert.equal(window.__calls.filter(call => call.body?.endpoint === 'seat-chat-open').at(-1).body.payload.terminal, 't1')
})

test('an unselected Herdr row shows its update offer while the previous Team chat stays open', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat, builderSeat] })
  window.__herdrAnswer = (_bot, options) => options?.update
    ? { ok: true, raised: true } : { ok: false, reason: 'update', latest: '2.0.0' }
  await waitFor(() => teamSeat(document, ATLAS), 'Team has Atlas')
  teamSeat(document, ATLAS).click()
  await waitFor(() => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79'), 'Atlas chat is open')
  sidebarFace(document, 'code').click()
  await waitFor(() => herdrButton(document, 'Builder'), 'Builder has a row action')
  herdrButton(document, 'Builder').click()
  const update = () => [...document.querySelectorAll('.lb-rows .bt-code-note button')].find(button => button.textContent === 'Update and open')
  await waitFor(update, 'the offer is visible without changing the panel')
  assert.equal(document.querySelector('.bt-seat-title').textContent, 'Atlas')
  update().click()
  assert.deepEqual(structuredClone(window.__herdrOpens), [{ botId: BUILDER }, { botId: BUILDER, update: true }])
  assert.equal(window.__streams.length, 0)
})

test('the host’s identity refusal clears the Team rows and waiting card and closes the watch', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [{ ...atlasSeat, status: 'needs' }] })
  window.__dialog = { prompt: 'Choose a branch', options: ['main'] }
  await waitFor(() => teamSeat(document, ATLAS), 'the seat was listed')
  teamSeat(document, ATLAS).click()
  await waitFor(() => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79'), 'the original chat opened')
  assert.ok(document.querySelector('[data-seat-wait]'), 'the original waiting card appeared')
  window.__readRefusal = 'This seat is not running on this computer.'
  await waitFor(() => document.querySelector('.bt-seat-error')?.textContent === window.__readRefusal, 'the host refused the read')
  assert.ok(!document.querySelector('[data-seat-wait]'), 'the refusal clears the waiting card')
  assert.doesNotMatch(document.body.textContent, /Line 79/)
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'),
    endpointTraffic('seat-chat-read', 't1'), endpointTraffic('seat-chat-close', 't1')])
})

test('a temporary seat refusal keeps the Team chat open and later reads resume', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const schedule = window.setTimeout.bind(window)
  const reads = []
  window.setTimeout = (fn, ms, ...args) => {
    if (ms !== 1200) return schedule(fn, ms, ...args)
    reads.push(fn)
    return undefined
  }
  const poll = async () => {
    const read = reads.shift()
    assert.ok(read, 'another read was scheduled')
    await read()
  }
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat] })
  const answer = window.__seatAnswer
  const message = 'The terminal could not be reached'
  let failRead = true
  window.__seatAnswer = (body) => {
    if (body.endpoint !== 'seat-chat-read' || !failRead) return answer(body)
    failRead = false
    return Response.json({ ok: false, error: { code: 'bot/unavailable', message } })
  }
  await waitFor(() => teamSeat(document, ATLAS), 'the seat was listed')
  teamSeat(document, ATLAS).click()
  const transcript = () => document.querySelector('.bt-seat-scroll')?.textContent
  await waitFor(() => transcript()?.includes('Line 79'), 'the original chat opened')
  await poll()
  await waitFor(() => document.querySelector('.bt-seat-error')?.textContent === message, 'the read showed the temporary refusal')
  assert.equal(document.querySelector('.bt-seat-title').textContent, 'Atlas')
  assert.match(transcript(), /Line 79/)

  for (const i of [80, 81]) {
    window.__seatRows = [{ id: `row-${i}`, kind: 'text', role: 'assistant', text: `Line ${i}` }]
    await poll()
    await waitFor(() => transcript()?.includes(`Line ${i}`), 'the next read added a row')
    assert.equal(document.querySelector('.bt-seat-error'), null)
  }
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'),
    ...Array.from({ length: 3 }, () => endpointTraffic('seat-chat-read', 't1'))])
})

test('a withdrawn Team pick clears the open face and closes its watch on the next roster poll', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const schedule = window.setTimeout.bind(window)
  let poll
  window.setTimeout = (fn, ms, ...args) => {
    if (ms !== 4000) return schedule(fn, ms, ...args)
    poll = fn
    return undefined
  }
  window.mountBarFixture({ tree: barTree(), seats: [{ ...atlasSeat, status: 'needs' }] })
  window.__dialog = { prompt: 'Choose a branch', options: ['main'] }
  await waitFor(() => teamSeat(document, ATLAS), 'the seat was listed')
  teamSeat(document, ATLAS).click()
  await waitFor(() => document.querySelector('[data-seat-wait]'), 'the original waiting card appeared')
  assert.match(document.body.textContent, /Line 79/)
  window.__listedSeats = []
  await poll()
  await waitFor(() => document.querySelector('.bt-seat-empty'), 'the sidebar withdrew the open seat')
  await waitFor(() => window.__barTraffic.some(event => event.endpoint === 'seat-chat-close'), 'the withdrawn watch closed')
  assert.ok(!document.querySelector('[data-seat-wait]'), 'the withdrawal clears the waiting card')
  assert.doesNotMatch(document.body.textContent, /Line 79/)
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'),
    endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-close', 't1')])
})

test('a failed Team roster poll and a successful retry keep the open seat and its watch', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const schedule = window.setTimeout.bind(window)
  let poll
  window.setTimeout = (fn, ms, ...args) => {
    if (ms !== 4000) return schedule(fn, ms, ...args)
    poll = fn
    return undefined
  }
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat] })
  await waitFor(() => teamSeat(document, ATLAS), 'the seat was listed')
  teamSeat(document, ATLAS).click()
  const faceIsOpen = () => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79')
  await waitFor(faceIsOpen, 'the original chat opened')
  for (const failure of ['transport', 'refusal']) {
    window.__listFailure = failure
    await poll()
    await delay(30)
    assert.ok(teamSeat(document, ATLAS), failure)
    assert.ok(faceIsOpen(), failure)
    window.__listFailure = null
    await poll()
    await delay(30)
    assert.ok(faceIsOpen(), 'the recovered roster keeps the chat open')
  }
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('seat-chat-open', 't1'),
    ...Array.from({ length: 4 }, () => endpointTraffic('seat-chat-list'))])
})

test('a late seat open reply closes only its own generation after the replacement starts reading', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const schedule = window.setTimeout.bind(window)
  let poll
  window.setTimeout = (fn, ms, ...args) => {
    if (ms !== 1200) return schedule(fn, ms, ...args)
    poll = fn
    return undefined
  }
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat] })
  const answer = window.__seatAnswer
  const delayed = Promise.withResolvers()
  let firstOpen
  window.__seatAnswer = body => {
    const result = answer(body)
    if (body.endpoint !== 'seat-chat-open' || firstOpen) return result
    firstOpen = result
    return delayed.promise
  }
  await waitFor(() => teamSeat(document, ATLAS), 'the seat was listed')
  teamSeat(document, ATLAS).click()
  await waitFor(() => firstOpen, 'the first open is pending')
  sidebarFace(document, 'code').click()
  await waitFor(() => barRow(document, 'Reviewer'), 'the worker is listed')
  barRow(document, 'Reviewer').click()
  await waitFor(() => window.__streams.length === 1, 'the worker opened')
  codePanel(document).querySelector('[aria-label=Back]').click()
  const faceIsOpen = () => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79')
  await waitFor(faceIsOpen, 'the replacement chat opened')
  await poll()
  delayed.resolve(firstOpen)
  const closes = () => window.__calls.filter(call => call.body?.endpoint === 'seat-chat-close')
  await waitFor(() => closes().length, 'the late open was closed')
  assert.equal(closes().length, 1)
  assert.equal(closes()[0].body.payload.generation, 'fixture-open-1')
  assert.ok(faceIsOpen())
  await poll()
  assert.equal(window.__calls.filter(call => call.body?.endpoint === 'seat-chat-read').length, 2)
})

test('a browser without a list proof shows no seats or error and local refresh ignores a remote namesake', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  window.mountBarFixture({ tree: barTree(), seats: [atlasSeat], denied: true })
  await waitFor(() => window.__barTraffic.length, 'the browser tried the list')
  assert.equal(teamSeat(document, ATLAS), null)
  assert.doesNotMatch(document.body.textContent, /desktop-only/)
  const remote = { ...atlasSeat, key: ATLAS + '@box', machine: 'box', terminal: null }
  assert.equal(window.localFixtureSeat([remote, atlasSeat], ATLAS).terminal, 't1')
  exactTraffic(window, [endpointTraffic('seat-chat-list')])
})

test('only a blocked Claude Code seat draws the waiting card, while all blocked agents say Needs you', async (t) => {
  for (const agent of ['claude', 'codex', 'omp', 'dsh-tui', 'agy']) {
    const window = codeDocument(t)
    const { document } = window
    window.mountBarFixture({ tree: barTree(), seats: [{ ...atlasSeat, status: 'needs', agent }] })
    window.__dialog = { kind: 'question', prompt: 'Choose a deploy', options: ['staging'] }
    await waitFor(() => teamSeat(document, ATLAS), 'the blocked seat was listed')
    assert.match(teamSeat(document, ATLAS).textContent, /Needs you/)
    teamSeat(document, ATLAS).click()
    await waitFor(() => document.querySelector('.bt-seat-scroll')?.textContent.includes('Line 79'), 'the chat rendered')
    assert.match(document.querySelector('.bt-seat-status').textContent, /Needs you/)
    assert.equal(Boolean(document.querySelector('[data-seat-wait]')), agent === 'claude', agent)
  }
})

test('an Open Herdr button targets its row without selecting a pane, and notices preserve that target', async (t) => {
  const window = codeDocument(t)
  const { document } = window
  const tree = barTree()
  tree.projects[0].bots[1].terminal = null
  window.mountBarFixture({ tree })
  await waitFor(() => sidebarFace(document, 'code'), 'side switch mounted')
  sidebarFace(document, 'code').click()
  const herdr = name => barRow(document, name)?.nextElementSibling
  await waitFor(() => herdr('Builder'), 'an offline Bot can ask Herdr to open')
  herdr('Builder').dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: true }))
  herdr('Builder').focus()
  assert.deepEqual(Array.from(window.__herdrOpens), [])
  const fold = [...document.querySelectorAll('button[aria-expanded]')].find(button => button.textContent === 'Atlas')
  fold.click()
  await waitFor(() => !barRow(document, 'Builder'), 'folding hid the project rows')
  fold.click()
  await waitFor(() => herdr('Builder'), 'the row returned after expanding')
  herdr('Builder').click()
  await waitFor(() => window.__herdrOpens.length === 1, 'one click reached the bridge')
  assert.equal(window.__herdrOpens[0].botId, BUILDER)
  assert.equal(window.codeSnapshot().barSelected, null)
  assert.equal(window.__streams.length, 0)

  barRow(document, 'Atlas').click()
  await waitFor(() => window.__streams.length === 1, 'clicking the row itself selected the pane')
  await waitFor(() => document.querySelector('.lb-rows .bt-code-note')?.textContent.includes('Herdr is open in another window'), 'the row notice stays in the tree')
  herdr('Reviewer').click()
  await waitFor(() => window.__herdrOpens.length === 2, 'a worker forwards its owner')
  assert.equal(window.__herdrOpens[1].botId, ATLAS)
  assert.equal(window.__streams.length, 1)
  exactTraffic(window, [endpointTraffic('seat-chat-list'), endpointTraffic('code-tree'), streamTraffic([ATLAS, null])])
})

test('Open Herdr is hidden when the desktop bridge is absent or Herdr is not set up', async (t) => {
  for (const bridge of ['absent', 'missing']) {
    const window = codeDocument(t)
    const { document } = window
    window.mountBarFixture({ tree: barTree(), bridge })
    await waitFor(() => sidebarFace(document, 'code'), 'side switch mounted')
    sidebarFace(document, 'code').click()
    await waitFor(() => barRow(document, 'Atlas'), 'the Code list is showing')
    assert.equal(barRow(document, 'Atlas').nextElementSibling, null)
    assert.deepEqual(Array.from(window.__herdrOpens), [])
  }
})

test('Open Herdr can be reached by Tab and activated once by Enter and Space without selecting the row', async (t) => {
  const page = await paneBrowser(t)
  if (!page) return
  await page.evaluate(tree => window.mountBarFixture({ tree }), barTree())
  await page.locator('[data-face=code]').click()
  const row = page.locator('.cs-row').filter({ hasText: 'Builder' })
  await row.focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Herdr')
  assert.deepEqual(await page.evaluate(() => window.__herdrOpens), [])
  for (const [index, key] of ['Enter', 'Space'].entries()) {
    await page.keyboard.press(key)
    await page.waitForFunction(count => window.__herdrOpens.length === count, index + 1)
    await page.locator('button.cs-btn:focus').waitFor({ state: 'attached' })
  }
  assert.deepEqual(await page.evaluate(() => window.__herdrOpens), [{ botId: BUILDER }, { botId: BUILDER }])
  assert.deepEqual(await page.evaluate(() => [window.codeSnapshot().barSelected, window.__streams.length]), [null, 0])
})
