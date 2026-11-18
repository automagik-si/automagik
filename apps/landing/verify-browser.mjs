// Real browser QA against local static pages and the real Pages Functions with an isolated
// in-memory SQLite fixture. No production binding, provider key or mail delivery is used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { routes, rootFiles, platforms, offered, used } from './scripts/build-pages.mjs'
import { fixture } from './waitlist/d1-fixture.mjs'
import { onRequest as waitlist } from './functions/api/waitlist.js'
import { onRequest as emailLink } from './functions/api/waitlist/email-confirm.js'
import { onRequest as whatsappConfirm } from './functions/api/waitlist/whatsapp-confirm.js'
import { CONSENT_VERSION, hash, now } from './waitlist/lib/shared.js'

const root = dirname(fileURLToPath(import.meta.url))
const evidence = resolve(process.env.LANDING_EVIDENCE ?? join(root, '../../.cache/landing-evidence'))
const types = { '.js': 'text/javascript', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' }
const isolated = fixture()
let bindingMode = 'missing', origin
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname === '/api/waitlist' || pathname === '/api/waitlist/email-confirm') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const request = new Request(origin + req.url, { method: req.method, headers: { ...req.headers, 'CF-Connecting-IP': '203.0.113.1' }, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) })
      const env = bindingMode === 'ready' ? isolated.env : {}
      const response = await (pathname.endsWith('email-confirm') ? emailLink : waitlist)({ request, env })
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()))
      return
    }
    const path = resolve(root, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`)
    if (!path.startsWith(root + sep)) return res.writeHead(403).end()
    const body = await readFile(path)
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch { res.writeHead(404).end() }
})
// The projects row's files for a dark page, as each project names them.
const rowDark = used.flatMap(({ mark: [, dark] }) => dark ? [`/assets/brand/used/${dark}`] : [])
let browser
const reports = []
const sampledCaptures = new Set()
// Midpoint between the lightest dark capture (52) and the darkest light capture (211), on a 0–255 scale.
const captureLightnessThreshold = 132
// Layout shift, as the browser itself scores it (shifts right after a click or key do not
// count). The observer is the test's; the pages' one script is the family drawer's.
const watchShift = context => context.addInitScript(() => {
  window.__shift = 0
  new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shift += entry.value }).observe({ type: 'layout-shift', buffered: true })
})
async function guard(context) {
  const outside = []
  await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : (outside.push(route.request().url()), route.abort())))
  return outside
}
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  origin = `http://127.0.0.1:${server.address().port}`
  await mkdir(evidence, { recursive: true })
  for (const [path, text] of rootFiles()) {
    const response = await fetch(`${origin}/${path}`)
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), text, path)
    assert.equal(response.headers.get('x-robots-tag'), null, `${path} is indexable`)
  }
  console.log('PASS root discovery files: 200, generated content, indexable')
  browser = await chromium.launch({ executablePath: process.env.LANDING_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  for (const route of routes) for (const colorScheme of ['light', 'dark']) for (const width of [1440, 1024, 880, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context)
      await watchShift(context)
      const page = await context.newPage(), responses = [], errors = []
      page.on('response', response => responses.push({ url: response.url().replace(origin, ''), status: response.status(), type: response.request().resourceType(), contentType: response.headers()['content-type'] }))
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(origin + route, { waitUntil: 'load' })
      await page.evaluate(() => Promise.all([...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => { image.loading = 'eager'; return image.decode() })).then(() => document.fonts.ready))
      await page.waitForLoadState('networkidle')
      const report = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth, viewport: innerWidth,
        images: [...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => ({ src: image.currentSrc.replace(location.origin, ''), ok: image.complete && image.naturalWidth > 0, shown: image.getBoundingClientRect().width })),
        fonts: ['Fredoka', 'DM Sans'].every(family => [...document.fonts].some(font => font.family.replaceAll('"', '') === family && font.status === 'loaded')),
        robots: document.querySelector('meta[name="robots"]')?.content,
        h1: document.querySelectorAll('h1').length,
        reducedMotion: [...document.getAnimations()].every(animation => animation.playState !== 'running'),
        background: getComputedStyle(document.body).backgroundColor,
      }))
      const headingBounds = await page.evaluate(() => [...document.querySelectorAll('.hero-heading h1')].map(heading => {
        const card = heading.closest('.hero-heading'), box = card.getBoundingClientRect(), style = getComputedStyle(card)
        const range = document.createRange(); range.selectNodeContents(heading)
        const horizontal = rect => ({ left: rect.left, right: rect.right })
        return {
          card: horizontal(box),
          content: { left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) },
          heading: horizontal(heading.getBoundingClientRect()),
          text: [...range.getClientRects()].filter(rect => rect.width > 0).map(horizontal),
        }
      }))
      // Layout checks for the redesign: no heading word split across lines at any width, every
      // image sized, the film's still never the biggest picture, and a visible keyboard focus.
      // App pictures: a dark page shows the dark capture of each view and a light page the
      // light one; the home's speech bubble stays off the app window; and the hero's capture is
      // shown near its real size (a 1100px window, or the 390px one on phone-width screens).
      const layout = await page.evaluate(sampled => {
        const brokenWords = []
        for (const heading of document.querySelectorAll('h1, h2, h3')) {
          if (!heading.getClientRects().length) continue
          const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of node.data.matchAll(/\S+/g)) {
              const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length)
              const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)))
              if (lines.size > 1) brokenWords.push(`${heading.tagName} "${match[0]}"`)
            }
          }
        }
        const area = image => { const box = image.getBoundingClientRect(); return box.width * box.height }
        const shown = [...document.images].filter(image => !image.closest('.fam, .fam-world')).filter(image => image.getClientRects().length && getComputedStyle(image).visibility !== 'hidden')
        const film = document.querySelector('[data-film] img')
        // The drawer's pictures are the family piece's own markup: its stylesheet sets their height, and the drawer is out of the page's flow.
        const unsized = [...document.querySelectorAll('img')].filter(image => !image.getAttribute('width') || !image.getAttribute('height')).map(image => image.src || image.dataset.src)
        const sampledSources = new Set(sampled)
        const captures = []
        const themed = [...document.querySelectorAll('picture')].filter(picture => picture.querySelector('source[media*="prefers-color-scheme: dark"]')).map(picture => {
          const image = picture.querySelector('img')
          const source = image.currentSrc.replace(location.origin, '')
          if (/^\/assets\/(?:art\/[^/]+\.webp|screens\/[^/]+\.png)$/.test(source) && !sampledSources.has(source)) {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 16
            const ctx = canvas.getContext('2d')
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let sum = 0, weight = 0
            for (let i = 0; i < pixels.length; i += 4) {
              const alpha = pixels[i + 3] / 255
              sum += alpha * (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2])
              weight += alpha
            }
            captures.push({ source, lightness: sum / weight })
            sampledSources.add(source)
          }
          return source
        })
        const box = selector => { const node = document.querySelector(selector); return node ? node.getBoundingClientRect().toJSON() : null }
        // The Open Intelligence tag in the footer: its size, its colour, where it sits in the
        // footer's last row, what its link holds, and the logo it sits with.
        const tagLink = document.querySelector('.footer-end > .oi-tag'), tagBox = tagLink.querySelector('svg').getBoundingClientRect()
        const row = document.querySelector('.footer-end').getBoundingClientRect(), licence = document.querySelector('.footer-license').getBoundingClientRect()
        const tag = {
          width: tagBox.width, height: tagBox.height, left: Math.round(tagBox.left - row.left), right: Math.round(row.right - tagBox.right),
          beside: tagBox.top < licence.bottom && tagBox.bottom > licence.top, under: tagBox.top >= licence.bottom,
          colour: getComputedStyle(tagLink.querySelector('text')).fill, text: getComputedStyle(document.querySelector('.site-footer nav a')).color,
          holds: [...tagLink.childNodes].map(node => node.nodeName), href: tagLink.href, words: tagLink.querySelector('text').textContent,
          font: document.fonts.check('600 18px "IBM Plex Mono"'), logo: document.querySelector('.footer-brand .brand img').getBoundingClientRect().width,
        }
        return { tag, brokenWords, unsized, film: film ? area(film) : 0, largest: Math.max(0, ...shown.filter(image => !image.closest('[data-film]')).map(area)), themed, captures, bubble: box('.bubble'), heroWindow: box('.scene-window img') }
      }, [...sampledCaptures])
      await page.keyboard.press('Tab')
      const focus = await page.evaluate(() => ({ skip: document.activeElement?.classList.contains('skip'), outline: getComputedStyle(document.activeElement).outlineStyle }))
      await page.keyboard.press('Tab')
      const nextFocus = await page.evaluate(() => { const style = getComputedStyle(document.activeElement).outlineStyle; document.activeElement.blur(); return style })
      const label = `${route} ${colorScheme} ${width}px`
      assert.deepEqual(layout.brokenWords, [], `A heading word breaks across lines: ${label}`)
      assert.deepEqual(layout.unsized, [], `Images without width/height: ${label}`)
      assert.ok(layout.tag.width === 170 && layout.tag.height === 32 && layout.tag.colour === layout.tag.text && layout.tag.font && layout.tag.words === 'OPEN INTELLIGENCE', `The Open Intelligence tag is 170 by 32 px, in the footer's text colour and its own type: ${label} ${JSON.stringify(layout.tag)}`)
      assert.ok(layout.tag.holds.length === 1 && layout.tag.holds[0] === 'svg' && layout.tag.href === 'https://weunfold.ai/', `The tag's link holds nothing but the tag: ${label} ${JSON.stringify(layout.tag.holds)}`)
      assert.ok(width > 700 ? layout.tag.right === 0 && layout.tag.beside : layout.tag.left === 0 && layout.tag.under, `The tag ends the footer's last row on a wide screen and sits under it, at the left, on a phone: ${label} ${JSON.stringify(layout.tag)}`)
      assert.ok(layout.tag.logo * 1325 / 1632.34 >= layout.tag.width, `The tag is never bigger than the logo's word: ${label} ${layout.tag.logo}`)
      assert.deepEqual(layout.themed.filter(source => (/(?:-dark(?:-2x)?\.webp|\/automagik-lockup-oi-cream\.svg|\/automagik-lockup-three-colours-cream(?:-header)?\.svg|\/(?:genie-lamp|omni-mark|mykes-clean)(?:-lockup)?-cream(?:-32|-header)?\.svg)$/.test(source) || rowDark.some(file => source.endsWith(file))) !== (colorScheme === 'dark')), [], `App pictures follow the theme: ${label}`)
      for (const { source, lightness } of layout.captures) {
        assert.ok(colorScheme === 'dark' ? lightness < captureLightnessThreshold : lightness > captureLightnessThreshold, `App capture lightness follows the theme: ${label} ${source} measured ${lightness.toFixed(1)} (threshold ${captureLightnessThreshold})`)
        sampledCaptures.add(source)
      }
      if (route === '/') {
        assert.ok(layout.themed.length >= 4, `The home's app pictures have dark captures: ${label}`)
        assert.ok(layout.bubble.bottom <= layout.heroWindow.top && layout.bubble.left >= 0 && layout.bubble.right <= width, `The speech bubble stays off the app window: ${label} ${JSON.stringify([layout.bubble, layout.heroWindow])}`)
        const real = width > 700 ? 1100 : 390
        assert.ok(layout.heroWindow.width >= real * 0.7, `The hero shows the app near its real size: ${label} ${layout.heroWindow.width}px of ${real}px`)
      }
      if (layout.film) assert.ok(layout.film < layout.largest, `The film still must not be the biggest picture: ${label} ${layout.film} vs ${layout.largest}`)
      assert.ok(focus.skip && focus.outline !== 'none' && nextFocus !== 'none', `Keyboard focus is visible: ${label}`)
      for (const bounds of headingBounds) {
        assert.ok([bounds.heading, ...bounds.text].every(box => box.left >= bounds.content.left - 0.5 && box.right <= bounds.content.right + 0.5), `Heading stays inside card padding: ${label} ${JSON.stringify(bounds)}`)
      }
      assert.equal(report.scroll, report.viewport, `Horizontal overflow: ${label}`)
      // The homepage's brand accent hides on narrow screens by design; shown product images
      // still must decode, and every image request must return 200.
      assert.ok(report.images.every(image => image.ok), `Every image decodes: ${label}`)
      assert.ok(report.fonts, `Both bundled fonts loaded: ${label}`)
      assert.equal(report.robots, undefined, `No robots meta, the page is indexable: ${label}`); assert.equal(report.h1, 1)
      // Reduced motion: nothing runs, nothing is held back from view, and nothing shifts.
      assert.ok(report.reducedMotion)
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0, `Reduced motion runs no animation: ${label}`)
      assert.equal(await page.evaluate(() => window.__shift), 0, `No layout shift: ${label}`)
      assert.equal(report.background, colorScheme === 'dark' ? 'rgb(30, 25, 35)' : 'rgb(246, 238, 226)')
      for (const src of new Set(report.images.map(image => image.src))) assert.ok(responses.some(response => response.url === src && response.status === 200), `${src} answered 200: ${label}`)
      assert.deepEqual(responses.filter(response => response.status >= 400), [], `No failed request: ${label}`)
      assert.deepEqual(outside, [], `No external request: ${label}`); assert.deepEqual(errors, [])
      if (await page.locator('video').count()) {
        const video = page.locator('video'); assert.equal(await video.count(), 1)
        await video.evaluate(async element => { element.muted = true; await element.play() })
        await page.waitForFunction(() => document.querySelector('video').currentTime > 0)
        await video.evaluate(element => element.pause())
        assert.ok(responses.some(response => response.url.endsWith('.mp4') && response.contentType === 'video/mp4' && [200, 206].includes(response.status)))
      }
      if (route === '/cloud/') {
        await page.locator('#privacy').evaluate(details => { details.open = true })
        await page.getByRole('heading', { name: 'Support on WhatsApp', exact: true }).waitFor()
        await page.getByRole('heading', { name: 'Suporte pelo WhatsApp', exact: true }).waitFor()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `Expanded privacy overflow: ${label}`)
        await page.locator('#privacy').evaluate(details => { details.open = false })
      }
      const slug = route === '/' ? 'home' : route.split('/')[1]
      const screenshot = join(evidence, `${slug}-${colorScheme}-${width}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      if ([1440, 390].includes(width)) {
        const viewportShot = await page.screenshot()
        const appShot = await readFile(join(root, `assets/screens/app-stage-${colorScheme}-${width}.png`))
        const comparison = await context.newPage()
        await comparison.setViewportSize({ width: width * 2, height: 934 })
        await comparison.setContent(`<html><body style="margin:0;background:${report.background};color:${colorScheme === 'dark' ? '#f3e9dd' : '#3c3049'};font:14px system-ui;display:flex"><div style="width:${width}px;flex:none"><p style="height:34px;margin:0;padding:6px 12px;box-sizing:border-box">Site ${route} · ${colorScheme} · ${width}px</p><img style="display:block;width:100%" src="data:image/png;base64,${viewportShot.toString('base64')}"></div><div style="width:${width}px;flex:none"><p style="height:34px;margin:0;padding:6px 12px;box-sizing:border-box">Real app · ${colorScheme} · ${width}px</p><img style="display:block;width:100%" src="data:image/png;base64,${appShot.toString('base64')}"></div></body></html>`)
        await comparison.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
        await comparison.screenshot({ path: join(evidence, `comparison-${slug}-${colorScheme}-${width}.png`) })
        await comparison.close()
      }
      reports.push({ route, colorScheme, width, ...report, headingBounds, responses, screenshot })
      console.log(`PASS ${label}: no overflow; images and fonts loaded; local requests`)
    } finally { await context.close() }
  }
  // The menus, with real clicks and keys. They need no script: the browser's popover opens
  // and closes each panel, keeps the button's expanded state and returns the focus.
  const panelState = (page, id) => page.evaluate(id => {
    const panel = document.getElementById(id), box = panel.getBoundingClientRect(), active = document.activeElement
    return {
      open: panel.matches(':popover-open'), shown: getComputedStyle(panel).display !== 'none' && box.height > 0, box: box.toJSON(),
      focusButton: active?.getAttribute('popovertarget') ?? null, focusInside: panel.contains(active), focusHref: active?.getAttribute('href') ?? null,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }
  }, id)
  // What assistive technology is told: the button's expanded state in the accessibility tree.
  const expanded = async (cdp, name) => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    const button = nodes.find(node => node.role?.value === 'button' && (node.name?.value ?? '').startsWith(name))
    return button?.properties?.find(property => property.name === 'expanded')?.value.value
  }
  const linkCheck = async page => {
    const links = await page.evaluate(() => [...document.querySelectorAll('.menu-panel a, .fam a, .site-footer a, .crumbs a, .pager a')].map(link => link.getAttribute('href')))
    assert.ok(links.length >= 40, 'menus, drawer and footer carry their links')
    for (const href of new Set(links)) {
      const url = new URL(href, origin)
      if (url.origin !== origin) { assert.equal(url.protocol, 'https:', href); continue }
      // Arca's page is Arca's own, served by Arca's Worker at this one address. This site
      // links to it and carries no file there, so nothing of ours is published over it.
      if (url.pathname.startsWith('/arca')) { assert.equal(href, '/arca/', href); assert.equal((await fetch(url)).status, 404, 'This site carries no page at /arca/'); continue }
      const response = await fetch(url)
      assert.equal(response.status, 200, `menu link answers 200: ${href}`)
      if (url.hash) assert.ok((await response.text()).includes(`id="${url.hash.slice(1)}"`), `menu link target exists: ${href}`)
    }
  }
  // A spot outside the menus, to click or point at: the first place, from the window's foot up,
  // with nothing under it or near it that a click could follow or press (a link, a button, a
  // field, a label, a summary, anything focusable) and outside the header and every shown
  // panel. It is measured each time, so a page laid out a little higher or lower cannot put a
  // link under the click and end the run on a navigation the check never names.
  const clear = page => page.evaluate(() => {
    const taken = [document.querySelector('.top'), ...document.querySelectorAll('.menu-panel')].map(node => node.getBoundingClientRect()).filter(box => box.height > 0)
    const free = (x, y) => !taken.some(box => x >= box.left - 8 && x <= box.right + 8 && y >= box.top - 8 && y <= box.bottom + 8) && !document.elementFromPoint(x, y)?.closest('a, button, input, select, textarea, label, summary, [tabindex], [contenteditable], [popover]')
    for (let y = innerHeight - 24; y > 0; y -= 24) for (let x = 40; x < innerWidth - 40; x += 40) {
      if ([[0, 0], [-8, 0], [8, 0], [0, -8], [0, 8]].every(([dx, dy]) => free(x + dx, y + dy))) return [x, y]
    }
    return null
  })
  for (const colorScheme of ['light', 'dark']) for (const route of ['/', '/genie/', '/mykes/']) {
    const label = `${route} ${colorScheme}`, slug = route === '/' ? 'home' : route.split('/')[1]
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
    try {
      const outside = await guard(desk), page = await desk.newPage(), cdp = await desk.newCDPSession(page)
      await page.goto(origin + route, { waitUntil: 'load' })
      const button = id => page.locator(`[popovertarget="menu-${id}"]`)
      for (const name of ['Products', 'Resources', 'Company']) assert.equal(await expanded(cdp, name), false, `${name} starts collapsed: ${label}`)
      // Click opens and closes; the panel sits under the header, inside the page's width.
      await button('products').click()
      let state = await panelState(page, 'menu-products')
      const header = await page.locator('.top').boundingBox()
      assert.ok(state.open && state.shown, `Click opens Products: ${label}`)
      assert.equal(await expanded(cdp, 'Products'), true, `Products is announced expanded: ${label}`)
      assert.ok(state.box.left >= 0 && state.box.right <= 1440 && Math.abs(state.box.top - (header.y + header.height)) <= 2 && state.overflow === 0, `Products panel sits under the header: ${label} ${JSON.stringify(state.box)}`)
      assert.equal(await page.locator('#menu-products .menu-item').count(), 7)
      await page.screenshot({ path: join(evidence, `menu-products-${slug}-${colorScheme}.png`) })
      await button('products').click()
      assert.ok(!(await panelState(page, 'menu-products')).open && await expanded(cdp, 'Products') === false, `A second click closes Products: ${label}`)
      // Keyboard: Enter and Space open, Tab goes into the panel, Escape closes and the focus
      // returns to the button.
      for (const key of ['Enter', 'Space']) {
        await button('resources').focus(); await page.keyboard.press(key)
        assert.ok((await panelState(page, 'menu-resources')).open, `${key} opens Resources: ${label}`)
        await page.keyboard.press('Tab')
        state = await panelState(page, 'menu-resources')
        assert.ok(state.focusInside && state.focusHref, `Tab moves into the open panel: ${label}`)
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', `Menu links show keyboard focus: ${label}`)
        await page.keyboard.press('Escape')
        state = await panelState(page, 'menu-resources')
        assert.ok(!state.open && !state.shown && state.focusButton === 'menu-resources', `Escape closes Resources and returns focus: ${label} ${JSON.stringify(state)}`)
      }
      // One panel at a time, and a click outside closes it.
      await button('products').click(); await button('company').click()
      assert.ok(!(await panelState(page, 'menu-products')).open && (await panelState(page, 'menu-company')).open, `Opening Company closes Products: ${label}`)
      await page.screenshot({ path: join(evidence, `menu-company-${slug}-${colorScheme}.png`) })
      let spot = await clear(page)
      assert.ok(spot, `A spot with nothing to click is found outside the open panel: ${label}`)
      await page.mouse.click(...spot)
      assert.ok(!(await panelState(page, 'menu-company')).shown, `A click outside closes the panel: ${label} ${spot}`)
      // Hover opens the same panel in the same place, and it stays while the pointer is in it.
      await page.mouse.move(...spot); await button('resources').hover()
      state = await panelState(page, 'menu-resources')
      assert.ok(state.shown && !state.open, `Hover shows Resources: ${label}`)
      const hovered = state.box
      await page.locator('#menu-resources .menu-item').last().hover()
      assert.ok((await panelState(page, 'menu-resources')).shown, `The panel stays while the pointer is in it: ${label}`)
      await button('resources').click()
      state = await panelState(page, 'menu-resources')
      assert.ok(state.open && Math.abs(state.box.top - hovered.top) < 1 && Math.abs(state.box.left - hovered.left) < 1, `Hover and click show the panel in one place: ${label}`)
      await page.keyboard.press('Escape'); spot = await clear(page)
      assert.ok(spot, `A spot with nothing to point at is found outside the panel: ${label}`)
      await page.mouse.move(...spot)
      assert.ok(!(await panelState(page, 'menu-resources')).shown, `The panel goes when the pointer leaves: ${label}`)
      // The active page in the header, and a menu link that takes you there.
      const here = await page.evaluate(() => ({ button: document.querySelector('.menu-button[data-here] .menu-here')?.lastChild.textContent ?? null, current: document.querySelector('#menu-products [aria-current="page"]')?.getAttribute('href') ?? null, crumb: document.querySelector('.crumbs [aria-current="page"]')?.textContent ?? null }))
      if (route === '/') assert.deepEqual(here, { button: null, current: null, crumb: null })
      else assert.ok(here.button && here.button === here.crumb && here.current === route, `The header shows the active page: ${label} ${JSON.stringify(here)}`)
      await linkCheck(page)
      await button('products').click(); await page.locator('#menu-products .menu-item[href="/omni/"]').click()
      await page.waitForURL(origin + '/omni/')
      assert.equal(await page.locator('.menu-button[data-here] .menu-here').evaluate(node => node.lastChild.textContent), 'Omni')
      assert.deepEqual(outside, [], `No external request from the menus: ${label}`)
    } finally { await desk.close() }
    // The family drawer, with real clicks and keys, in a wide window and on a phone. It is
    // the one script on the page (assets/family/family.js, the piece's own) and the one menu
    // a phone has: the header keeps no second menu button.
    for (const width of [1440, 390, 320]) {
      const height = width > 860 ? 900 : 844, about = `${label} ${width}px`
      const view = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
      try {
        const outside = await guard(view), page = await view.newPage(), cdp = await view.newCDPSession(page), errors = [], art = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('request', request => { if (request.url().includes('/assets/family/') && /\.(?:png|svg)$/.test(request.url())) art.push(request.url().split('/').pop()) })
        await page.goto(origin + route, { waitUntil: 'load' })
        const menu = page.locator('[data-family-open]')
        const state = () => page.evaluate(() => {
          const root = document.documentElement, drawer = document.querySelector('[data-family-drawer]'), wrap = document.querySelector('[data-family-page]'), button = document.querySelector('[data-family-open]')
          const box = drawer.getBoundingClientRect()
          return {
            open: root.classList.contains('is-family-open'), hidden: drawer.hidden, drawer: { left: box.left, top: box.top, width: box.width, bottom: box.bottom }, page: wrap.getBoundingClientRect().left,
            inert: wrap.inert, ariaHidden: wrap.getAttribute('aria-hidden'), expanded: button.getAttribute('aria-expanded'),
            focus: document.activeElement === button ? 'button' : drawer.contains(document.activeElement) ? 'drawer' : 'page',
            overflow: root.scrollWidth - innerWidth, scroll: getComputedStyle(root).overflowY,
          }
        })
        const shut = { open: false, page: 0, inert: false, ariaHidden: null, expanded: 'false', focus: 'button', overflow: 0, scroll: 'visible' }
        const closed = async why => {
          await page.waitForFunction(() => document.querySelector('[data-family-drawer]').hidden && document.querySelector('[data-family-scrim]').hidden)
          const { hidden, drawer, ...now } = await state()
          assert.deepEqual(now, shut, `${why}: ${about}`)
        }
        // At rest: the button is the header's first thing, at the window's left edge, in the
        // middle of the header's height; its three lines wear the family's colours for this
        // ground; the logo stands clear of it and keeps the page column where there is room.
        const rest = await page.evaluate(() => {
          const header = document.querySelector('.top'), button = header.querySelector('[data-family-open]'), column = document.querySelector('.site-footer .wrap')
          const box = node => node.getBoundingClientRect().toJSON()
          return {
            first: header.firstElementChild === button, role: button.getAttribute('role'), href: button.getAttribute('href'), name: button.getAttribute('aria-label'),
            button: box(button), row: box(header.querySelector('.top-inner')), logo: box(header.querySelector('.brand img')),
            lines: [...button.querySelectorAll('.fam-lines > span')].map(line => getComputedStyle(line).backgroundColor),
            column: column.getBoundingClientRect().left + parseFloat(getComputedStyle(column).paddingLeft),
            menus: getComputedStyle(header.querySelector('.main-nav')).display !== 'none', others: header.querySelectorAll('.menu-open, .menu-fallback, [popovertarget="site-menu"]').length,
            drawer: getComputedStyle(document.querySelector('[data-family-drawer]')).display, outsidePage: !document.querySelector('[data-family-page]').contains(document.querySelector('[data-family-drawer]')),
          }
        })
        assert.ok(rest.first && rest.role === 'button' && rest.href === null && rest.name === 'Menu' && rest.drawer === 'none' && rest.outsidePage, `The menu button is the header's first thing, a button: ${about} ${JSON.stringify(rest)}`)
        // A closed drawer costs the page nothing (the piece's twelfth issue): none of its twelve
        // picture addresses is set, so none of its pictures is among the page's requests.
        const closedArt = await page.evaluate(() => ({ given: document.querySelectorAll('.fam img[src], .fam source[srcset], .fam-world img[src]').length, waiting: document.querySelectorAll('.fam img[data-src], .fam source[data-srcset], .fam-world img[data-src]').length }))
        assert.deepEqual([closedArt, art], [{ given: 0, waiting: 12 }, []], `A closed drawer fetches nothing: ${about} ${JSON.stringify([closedArt, art])}`)
        assert.equal(await expanded(cdp, 'Menu'), false, `Menu starts collapsed: ${about}`)
        assert.ok(rest.button.left === 7 && rest.button.width === 48 && rest.button.height === 48 && Math.abs(rest.button.top + 24 - (rest.row.top + rest.row.height / 2)) <= 0.5, `The button is at the window's edge, in the middle of the header: ${about} ${JSON.stringify(rest.button)}`)
        assert.deepEqual(rest.lines, colorScheme === 'dark' ? ['rgb(181, 134, 231)', 'rgb(238, 84, 150)', 'rgb(21, 189, 224)'] : ['rgb(144, 98, 190)', 'rgb(208, 63, 124)', 'rgb(7, 129, 164)'], `Three lines: violet, pink, cyan for this ground: ${about}`)
        const clear = width > 480 ? 68 : width > 360 ? 62 : 56
        assert.ok(rest.logo.left >= clear - 0.5, `The logo stands clear of the button: ${about} ${rest.logo.left}`)
        if (width === 1440) assert.ok(Math.abs(rest.logo.left - rest.column) <= 0.5, `The logo keeps the page column: ${about} ${rest.logo.left} ${rest.column}`)
        assert.equal(rest.menus, width > 860, `The header's menus show only where there is room: ${about}`)
        assert.equal(rest.others, 0, `The header has one menu button: ${about}`)
        // A click opens it from the left edge and pushes the page aside; the page is out of reach.
        await menu.click()
        let now = await state()
        const wide = Math.min(420, width - 34)
        assert.ok(now.open && !now.hidden && now.drawer.left === 0 && now.drawer.top === 0 && now.drawer.width === wide && now.drawer.bottom === height, `A click opens the drawer at the left edge: ${about} ${JSON.stringify(now)}`)
        assert.equal(now.page, wide, `The drawer pushes the page aside: ${about}`)
        assert.equal(now.overflow, 0, `The pushed page does not widen the window: ${about}`)
        assert.ok(now.inert && now.ariaHidden === 'true' && now.expanded === 'true' && now.scroll === 'hidden' && now.focus === 'drawer', `The page behind is out of reach and the focus is in the drawer: ${about} ${JSON.stringify(now)}`)
        // What assistive technology is offered: the drawer's own things and nothing of the page.
        const phone = width <= 860
        const names = ['Automagik', 'Desktop', 'Mobile', ...(phone ? ['Cloud', 'Get the app', 'Privacy'] : []), 'Arca', 'Omni', 'Genie', 'Mykes', 'Support', 'Close']
        // (The tree lists them in its own order, with a label's capitals as they are drawn.)
        const offered = (await cdp.send('Accessibility.getFullAXTree')).nodes.filter(node => !node.ignored && ['link', 'button'].includes(node.role?.value)).map(node => (node.name?.value ?? '').toLowerCase())
        const unmatched = [...offered]
        for (const name of names) { const at = unmatched.findIndex(given => given.startsWith(name.toLowerCase())); assert.ok(at >= 0, `The drawer offers ${name}: ${about} ${JSON.stringify(offered)}`); unmatched.splice(at, 1) }
        assert.deepEqual(unmatched, [], `Only the drawer is offered while it is open: ${about}`)
        // Every link and control of the page is inside the wrapper the drawer puts out of reach.
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('a, button, input, select, textarea, summary')].filter(node => !node.closest('[data-family-page], [data-family-drawer], [popover]')).map(node => node.outerHTML.slice(0, 80))), [], `Nothing of the page stands outside its wrapper: ${about}`)
        // The art: Automagik's lockup for this ground, then omni, genie and mykes as words,
        // at one letter size; no pet, no head, no mark beside a product; "Coming soon." under Mykes.
        await page.waitForFunction(() => [...document.querySelectorAll('[data-family-drawer] img')].filter(image => image.getClientRects().length).every(image => image.complete && image.naturalWidth > 0))
        const seen = await page.evaluate(() => {
          const drawer = document.querySelector('[data-family-drawer]'), shown = [...drawer.querySelectorAll('img')].filter(image => image.getClientRects().length)
          return {
            lock: parseFloat(getComputedStyle(drawer).getPropertyValue('--lock')), files: shown.map(image => image.currentSrc.split('/').pop()), heights: shown.map(image => image.getBoundingClientRect().height), alts: shown.map(image => image.alt),
            every: [...document.querySelectorAll('.fam img, .fam source, .fam-world img')].map(node => node.getAttribute('src') ?? node.getAttribute('srcset') ?? node.dataset.src ?? node.dataset.srcset),
            // Which pictures have their address: only the ones shown on this ground.
            given: [...document.querySelectorAll('.fam img[src], .fam source[srcset], .fam-world img[src]')].map(node => (node.getAttribute('src') ?? node.getAttribute('srcset')).split('/').pop()),
            waiting: document.querySelectorAll('.fam img[data-src], .fam source[data-srcset], .fam-world img[data-src]').length,
            rows: [...drawer.querySelectorAll('.fam-list > li')].map(row => row.innerText.trim()), here: drawer.querySelector('[data-family-here] .fam-item').textContent.trim(), hereCurrent: drawer.querySelector('[data-family-here] .fam-item').getAttribute('aria-current'),
            links: [...drawer.querySelectorAll('[data-family-links] a')].filter(link => link.getClientRects().length).map(link => link.getAttribute('href')),
            // The host is Automagik: what stands in the top block, in order; whether the Automagik
            // row is there; where Desktop and Mobile stand against the block's link; and where
            // the label, Arca's line and Omni's line begin.
            block: [...drawer.querySelector('[data-family-here]').children].map(node => node.className), row: drawer.querySelectorAll('.fam-top, .fam-home').length,
            chips: (() => { const link = drawer.querySelector('[data-family-here] .fam-item').getBoundingClientRect(), first = drawer.querySelector('[data-family-here] .fam-apps .fam-chip').getBoundingClientRect(), mark = shown[0].getBoundingClientRect(); return { side: first.left - mark.left, under: first.top - link.bottom, hrefs: [...drawer.querySelectorAll('[data-family-here] .fam-apps .fam-chip')].map(chip => chip.getAttribute('href')) } })(),
            starts: ['.fam > .eyebrow', '.fam-item.is-logo .fam-words > span:last-child', '.fam-item[href="/omni/"] .fam-words > span:last-child'].map(selector => { const node = drawer.querySelector(selector); return node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft) }),
            ark: (() => { const ark = drawer.querySelector('.fam-list > li:first-child .fam-item.is-logo .fam-logo svg'); return ark && { height: ark.getBoundingClientRect().height, name: ark.getAttribute('aria-label'), ink: getComputedStyle(ark).fill, text: getComputedStyle(drawer.querySelector('.fam-item.is-logo')).color, href: ark.closest('a').getAttribute('href') } })(),
            current: [...drawer.querySelectorAll('[aria-current="page"]')].filter(node => !node.matches('.is-here')).map(node => node.getAttribute('href')),
            inside: drawer.scrollWidth - drawer.clientWidth,
          }
        })
        const tone = colorScheme === 'dark' ? 'cream' : 'ink', lockup = `automagik-lockup-three-colours-${tone}-${width <= 480 ? 48 : 64}.png`
        assert.equal(seen.lock, width <= 480 ? 24 : 30)
        // The host is Automagik: its lockup is shown once, in the top block, and it has no row.
        assert.deepEqual(seen.files, [lockup, `omni-wordmark-${tone}.svg`, `genie-wordmark-${tone}.svg`, `mykes-wordmark-${tone}.svg`], `The drawer shows the lockup once and the three words for this ground: ${about}`)
        assert.deepEqual(seen.alts, ['Automagik', 'Omni', 'Genie', 'Mykes'], `Each picture has its name: ${about}`)
        assert.equal(seen.row, 0, `Automagik has no row under its own block: ${about}`)
        assert.ok(Math.abs(seen.heights[0] - seen.lock) <= 0.5, `The lockup is drawn at its row's height: ${about} ${seen.heights}`)
        assert.ok(Math.abs(seen.heights[1] - seen.lock) <= 0.5 && Math.abs(seen.heights[2] - seen.lock) <= 0.5 && Math.abs(seen.heights[3] - seen.lock * 257 / 264) <= 0.5, `The three words are one letter size: ${about} ${seen.heights}`)
        // Desktop and Mobile stand in the top block, right under the link, in the block's side room.
        assert.deepEqual(seen.block, ['fam-item is-here', 'fam-apps', 'fam-links'], `The top block holds the link, the two app buttons, then the pages: ${about}`)
        assert.deepEqual(seen.chips.hrefs, ['/desktop/', '/mobile/'], about)
        assert.ok(Math.abs(seen.chips.side) <= 0.5 && Math.abs(seen.chips.under - 8) <= 0.5, `Desktop and Mobile stand in the block's side room, under the link: ${about} ${JSON.stringify(seen.chips)}`)
        // Arca is the first product, by its own logo in the text colour, and its line stands in
        // the names' column with the label and the other lines.
        assert.deepEqual(seen.ark && [seen.ark.name, seen.ark.href, seen.ark.ink === seen.ark.text], ['arca', '/arca/', true], `Arca is the first of the products, by its logo: ${about} ${JSON.stringify(seen.ark)}`)
        assert.ok(Math.abs(seen.ark.height - seen.lock * 0.7) <= 0.5, `Arca's logo at the piece's height: ${about} ${seen.ark.height}`)
        assert.ok(Math.abs(seen.starts[1] - seen.starts[0]) <= 0.5 && Math.abs(seen.starts[1] - seen.starts[2]) <= 0.5, `Arca's line stands in the names' column: ${about} ${seen.starts}`)
        assert.ok(seen.every.every(file => /^\/assets\/family\/(?:automagik-lockup-three-colours-(?:cream|ink)-(?:48|64|128)\.png|(?:omni|genie|mykes)-wordmark-(?:cream|ink)\.svg)$/.test(file)) && seen.every.length === 12, `No pet, no head and no mark beside a product: ${about} ${seen.every}`)
        assert.deepEqual(seen.rows, ['Be your own cloud. Infrastructure for AI agents.', 'Your chat apps, connected.', 'A wish, a branch, a report.', 'Coming soon.'], `Each product's line, "Coming soon." under Mykes: ${about}`)
        assert.equal(seen.here, 'Open building blocks of superintelligence.You are here', `The top block is Automagik: ${about}`)
        assert.equal(seen.hereCurrent, route === '/' ? 'page' : 'true')
        assert.deepEqual(seen.links, phone ? ['/cloud/', '/desktop/#install', '/cloud/#privacy'] : [], `The site's other pages show in the drawer only where the header has no room: ${about}`)
        assert.deepEqual(seen.current, route === '/' ? [] : [route], `The drawer marks the page being read: ${about}`)
        assert.equal(seen.inside, 0, `Nothing in the drawer is wider than it: ${about}`)
        // Opened, the drawer gives an address only to the pictures shown on this ground: the
        // lockup (with its small file for a narrow window) and the three words. The other
        // ground's four and the large lockup wait. Only those four files are fetched.
        assert.deepEqual([seen.given, seen.waiting], [[`automagik-lockup-three-colours-${tone}-48.png`, `automagik-lockup-three-colours-${tone}-64.png`, `omni-wordmark-${tone}.svg`, `genie-wordmark-${tone}.svg`, `mykes-wordmark-${tone}.svg`], 7], `Only this ground's pictures have their address: ${about} ${JSON.stringify([seen.given, seen.waiting])}`)
        assert.deepEqual([...new Set(art)].sort(), [lockup, `omni-wordmark-${tone}.svg`, `genie-wordmark-${tone}.svg`, `mykes-wordmark-${tone}.svg`].sort(), `Only the art for this ground is fetched: ${about} ${art}`)
        if (width !== 320) await page.screenshot({ path: join(evidence, `drawer-${slug}-${width}-${colorScheme}.png`) })
        // The keyboard stays in the drawer and reaches every one of its things.
        const stops = new Set()
        for (let press = 0; press < 30; press++) {
          await page.keyboard.press('Tab')
          stops.add(await page.evaluate(() => { const active = document.activeElement; return active.closest('[data-family-drawer]') ? `drawer:${active.getAttribute('href') ?? active.textContent}:${active.className}` : `behind:${active.outerHTML.slice(0, 60)}` }))
        }
        assert.deepEqual([...stops].filter(stop => stop.startsWith('behind:')), [], `Tab never lands behind the drawer: ${about}`)
        assert.equal(stops.size, names.length, `Tab reaches everything in the drawer: ${about} ${[...stops]}`)
        // Shift+Tab from the first stop goes round to Close, and Tab from Close back to the
        // first: the piece's focus holds, with this site's own top block as the first stop.
        await page.locator('[data-family-drawer] .fam-item.is-here').focus()
        await page.keyboard.press('Shift+Tab')
        const back = await page.evaluate(() => document.activeElement.hasAttribute('data-family-close'))
        await page.keyboard.press('Tab')
        const round = await page.evaluate(() => document.activeElement.matches('[data-family-drawer] .fam-item.is-here'))
        // The second hold, on its own: the first stop loses the focus to nothing after a key,
        // and the focus goes on to Close.
        await page.evaluate(() => document.activeElement.blur())
        const held = await page.waitForFunction(() => document.activeElement.hasAttribute('data-family-close'), null, { timeout: 2000 }).then(() => true, () => false)
        assert.deepEqual([back, round, held], [true, true, true], `Shift+Tab from the first stop goes to Close, and Tab from Close to the first: ${about}`)
        // Escape closes it and the focus is back on the button; Enter and Space open it.
        await page.keyboard.press('Escape')
        await closed('Escape closes the drawer and returns the focus to the button')
        assert.equal(await expanded(cdp, 'Menu'), false)
        for (const key of ['Enter', 'Space']) {
          await page.keyboard.press(key)
          now = await state()
          assert.ok(now.open && now.focus === 'drawer' && now.inert && now.page === wide, `${key} opens the drawer: ${about} ${JSON.stringify(now)}`)
          await page.keyboard.press('Escape')
          await closed(`Escape closes the drawer opened with ${key}`)
        }
        // Close, a press beside the drawer and a second press on the button close it too.
        await menu.click(); await page.locator('[data-family-close]').click()
        await closed('Close closes the drawer')
        await menu.click(); await page.mouse.click(wide + (width - wide) / 2, height - 60)
        await closed('A press beside the drawer closes it')
        if (width === 1440) {
          await menu.click(); await page.mouse.click(rest.button.left + 24 + wide, rest.button.top + 24)
          await closed('A press on the button beside the open drawer closes it')
        }
        // A product in the drawer goes to its page; the drawer is shut there.
        await menu.click(); await page.locator('[data-family-drawer] .fam-item[href="/omni/"]').click()
        await page.waitForURL(origin + '/omni/')
        assert.equal(await page.locator('.crumbs [aria-current="page"]').innerText(), 'Omni')
        assert.ok(!(await state()).open, `The drawer is shut on the page it led to: ${about}`)
        if (phone && route === '/') {
          // One of the site's other pages, from the list under the top block; then a place on
          // the page being read: the drawer steps aside first, and the page goes there.
          await page.locator('[data-family-open]').click(); await page.locator('[data-family-links] a[href="/cloud/"]').click()
          await page.waitForURL(origin + '/cloud/')
          await page.locator('[data-family-open]').click(); await page.locator('[data-family-links] a[href="#privacy"]').click()
          await page.waitForFunction(() => location.hash === '#privacy')
          const landed = await page.evaluate(() => ({ open: document.documentElement.classList.contains('is-family-open'), inert: document.querySelector('[data-family-page]').inert, hidden: document.querySelector('[data-family-drawer]').hidden, focus: document.activeElement.id }))
          assert.deepEqual(landed, { open: false, inert: false, hidden: true, focus: 'privacy' }, `A place on this page closes the drawer and lands there: ${about}`)
        }
        assert.deepEqual(outside, [], `No external request from the drawer: ${about}`); assert.deepEqual(errors, [], about)
      } finally { await view.close() }
    }
    // With script off the button is a plain link to the page's own sitemap, the footer, and
    // the drawer stays shut.
    if (route === '/') {
      const plain = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce', javaScriptEnabled: false })
      try {
        const page = await plain.newPage()
        await page.goto(origin + route, { waitUntil: 'load' })
        const link = page.locator('[data-family-open]')
        assert.equal(await link.getAttribute('href'), '#sitemap'); assert.equal(await link.getAttribute('role'), null)
        await link.click()
        assert.ok(page.url().endsWith('/#sitemap') && !(await page.locator('[data-family-drawer]').isVisible()) && await page.locator('#sitemap').isVisible(), `With script off the button leads to the sitemap: ${label}`)
      } finally { await plain.close() }
    }
    console.log(`PASS menus ${label}: click, keyboard, Escape and focus return, hover, one panel at a time, active page, links; the family drawer by click, Enter, Space and Escape, the page pushed and out of reach, its art, script off`)
  }
  // The pager, by real clicks: Next from the first product page walks every product page this
  // site builds, once each, and comes back; Previous walks the same round the other way. No
  // step leaves the site's own pages: Arca's page is Arca's own and has no pager that leads
  // back, so the round passes it by.
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context), page = await context.newPage(), round = routes.filter(route => route !== '/')
      for (const [rel, order] of [['next', round], ['prev', [...round].reverse()]]) {
        await page.goto(origin + order[0], { waitUntil: 'load' })
        const walked = [order[0]]
        for (let step = 0; step < round.length; step++) {
          const link = page.locator(`.pager a[rel="${rel}"]`), href = await link.getAttribute('href')
          // Said before the click: a link that leaves this site's pages would otherwise be
          // found only by the wait for a page that never loads.
          assert.ok(round.includes(href), `The pager's ${rel} leads to a product page this site builds: ${href} from ${walked.at(-1)} ${width}px`)
          await link.click()
          await page.waitForURL(origin + href, { waitUntil: 'load' })
          walked.push(new URL(page.url()).pathname)
          assert.equal(await page.locator('.pager').count(), 1, `The pager's ${rel} leads to a page of this site with a pager of its own: ${href} from ${walked.at(-2)} ${width}px`)
        }
        assert.deepEqual(walked, [...order, order[0]], `The pager's ${rel} walks every product page once and comes back: ${width}px`)
      }
      assert.deepEqual(outside, [], `No external request from the pager: ${width}px`)
    } finally { await context.close() }
    console.log(`PASS pager ${width}px: next and previous walk this site's product pages, once each, and come back`)
  }
  // The logo in the header and the footer: the kit's lockup for small sizes, the triskle in
  // colour with ink letters on the light page and cream ones on the dark page (read from the
  // name's drawn colour, not only from the file's name), drawn at its own proportions. The triskle (222 of the file's 264 in height) keeps the size and the
  // centred place it had, nothing in the header is pushed aside, and the browser's icons
  // load from the site.
  for (const colorScheme of ['light', 'dark']) for (const [width, header, footer] of [[1440, 32, 40], [1024, 32, 40], [390, 26, 34], [360, 24, 34], [320, 24, 34]]) {
    const label = `${colorScheme} ${width}px`
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context)
      const page = await context.newPage()
      await page.goto(origin + '/', { waitUntil: 'load' })
      await page.evaluate(() => Promise.all([...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => { image.loading = 'eager'; return image.decode() })).then(() => document.fonts.ready))
      const logo = await page.evaluate(async () => {
        // The colour the name is drawn in: the commonest solid pixel to the right of the triskle.
        const word = image => {
          const canvas = document.createElement('canvas'); canvas.width = 816; canvas.height = 132
          const pen = canvas.getContext('2d'); pen.drawImage(image, 0, 0, canvas.width, canvas.height)
          const from = Math.ceil(canvas.width * 300 / 1632.34), pixels = pen.getImageData(from, 0, canvas.width - from, canvas.height).data, seen = new Map()
          for (let at = 0; at < pixels.length; at += 4) if (pixels[at + 3] === 255) { const colour = `${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`; seen.set(colour, (seen.get(colour) || 0) + 1) }
          return [...seen].sort((one, other) => other[1] - one[1])[0]?.[0].split(',').map(Number) ?? null
        }
        // The ground the logo stands on: every background from the page down to the logo's own
        // link, painted one over the other (a see-through one lets the one under it show).
        const ground = image => {
          const layers = []; for (let node = image.parentElement; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor)
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
          const pen = canvas.getContext('2d'); pen.fillStyle = '#fff'; pen.fillRect(0, 0, 1, 1)
          for (const layer of layers) { pen.fillStyle = layer; pen.fillRect(0, 0, 1, 1) }
          return [...pen.getImageData(0, 0, 1, 1).data.slice(0, 3)]
        }
        const place = scope => {
          const link = document.querySelector(`${scope} .brand`), image = link.querySelector('img'), box = image.getBoundingClientRect(), frame = link.getBoundingClientRect()
          return {
            size: [box.width, box.height], top: box.top, hang: box.bottom - frame.bottom, right: box.right, file: image.currentSrc.split('/').pop(), drawn: image.naturalWidth > 0, word: word(image), ground: ground(image),
            effects: [link, image].map(node => { const style = getComputedStyle(node); return [style.filter, style.opacity, style.transform, style.mixBlendMode].join(' ') }),
          }
        }
        const row = document.querySelector('.top-inner').getBoundingClientRect()
        const shown = [...document.querySelectorAll('.top-inner > *')].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect()).sort((one, other) => one.left - other.left)
        const tabs = [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map(link => new URL(link.href).pathname)
        return {
          top: place('.top'), foot: place('.footer-brand'), rowMiddle: row.top + row.height / 2, tabs,
          apart: shown.every((box, index) => index === 0 || box.left >= shown[index - 1].right), inside: shown.at(-1).right <= innerWidth && shown[0].left >= 0,
          column: document.querySelector('.footer-brand').getBoundingClientRect().right, over: document.documentElement.scrollWidth - innerWidth,
        }
      })
      for (const [name, spot, mark] of [['header', logo.top, header], ['footer', logo.foot, footer]]) {
        const unit = mark / 222, near = (value, wanted) => Math.abs(value - wanted) <= 0.6
        // The brand's floor, measured: a lockup is never under 28 px high (the family drawer's
        // phone layout is its one exception, and neither the header nor the footer is that).
        assert.ok(spot.size[1] >= 28 - 0.05, `The ${name}'s logo is 28 px high or more: ${label} ${spot.size[1]}`)
        assert.equal(spot.file, `automagik-lockup-three-colours-${colorScheme === 'dark' ? 'cream' : 'ink'}-header.svg`, `The logo's file follows the theme: ${name} ${label}`)
        // The file's name is not enough: the name must be drawn dark on a light ground and light on a
        // dark one, measured against the ground the logo itself stands on (the header's, the footer's).
        const light = colour => colour.map(value => value / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
        const against = spot.word && (Math.max(light(spot.word), light(spot.ground)) + 0.05) / (Math.min(light(spot.word), light(spot.ground)) + 0.05)
        assert.ok(against >= 7, `The name is drawn in the theme's colour, clear against its own ground: ${name} ${label} ${JSON.stringify([spot.word, spot.ground, against])}`)
        assert.ok(spot.drawn && near(spot.size[1], 264 * unit) && near(spot.size[0], 1632.34 * unit), `The logo's size, unstretched: ${name} ${label} ${spot.size}`)
        assert.ok(near(spot.hang, name === 'header' ? 42 * unit : 0), `The g's tail hangs under the header's link and inside the footer's: ${name} ${label} ${spot.hang}`)
        assert.deepEqual([...new Set(spot.effects)], ['none 1 none normal'], `Nothing is drawn over the logo: ${name} ${label}`)
      }
      assert.ok(Math.abs(logo.top.top + header / 2 - logo.rowMiddle) <= 0.6, `The triskle stays centred in the header: ${label} ${[logo.top.top, logo.rowMiddle]}`)
      assert.ok(logo.apart && logo.inside && logo.over <= 0, `The wider logo pushes nothing aside: ${label} ${JSON.stringify([logo.apart, logo.inside, logo.over])}`)
      assert.ok(logo.foot.right <= logo.column, `The footer's logo stays in its column: ${label} ${[logo.foot.right, logo.column]}`)
      // The page's own policy allows no fetch from script, so the icons are asked for from here.
      const tabs = []
      for (const path of logo.tabs) { const answer = await context.request.get(origin + path); tabs.push([path, answer.status(), (await answer.body()).length > 0]) }
      assert.deepEqual(tabs, [['/favicon.ico', 200, true], ['/favicon.svg', 200, true], ['/apple-touch-icon.png', 200, true], ['/site.webmanifest', 200, true]], `The browser's icons load: ${label}`)
      // The keyboard's order in the header: the skip link, the family's menu button, the logo.
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.className), 'fam-btn', `The menu button is the header's first stop: ${label}`)
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => { const link = document.activeElement, style = getComputedStyle(link), box = link.getBoundingClientRect(), word = link.querySelector('img')?.getBoundingClientRect(); return { link: link.className, clears: word && box.bottom + parseFloat(style.outlineOffset) >= word.bottom, style: style.outlineStyle } })
      assert.deepEqual(ring, { link: 'brand', clears: true, style: 'solid' }, `The focus ring goes round the whole logo: ${label} ${JSON.stringify(ring)}`)
      assert.deepEqual(outside, [], `No outside request: ${label}`)
      console.log(`PASS logo ${label}: the kit's file for the theme, its name drawn in the theme's colour, at its own proportions, header and footer in place, icons load`)
    } finally { await context.close() }
  }
  // Genie's, Omni's and Mykes's own lockups (the brand's rule 10: each product's own flat mark
  // beside its name, never the triskle): the heading of each one's page and the title of
  // Genie's and Omni's cards on the home page. Omni has a drawing for small sizes, on its
  // card; the lamp and the cords have one drawing each. The file follows the theme, except
  // on Genie's card, which is dark in both themes. As for the logo above, the file's name is
  // not enough: the colour the mark and the name are drawn in must stand clear of the ground
  // they sit on (Mykes's heading stands on the stage's gradient: every stop of it is tried).
  // Each is drawn at its file's own proportions inside its column, at every width, with
  // nothing drawn over it; and Omni's large drawing is never shown under 56 px high.
  for (const colorScheme of ['light', 'dark']) for (const width of [1440, 1024, 900, 768, 390, 320]) {
    const label = `${colorScheme} ${width}px`, tone = colorScheme === 'dark' ? 'cream' : 'ink'
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context)
      const page = await context.newPage()
      const heading = Math.min(128, width * (width > 860 ? 0.104 : 0.185))
      assert.ok(heading >= 56, `Omni's large drawing is for 56 px and up: ${label} ${heading}`)
      for (const [route, selector, stop, file, units, height, name] of [
        ['/genie/', 'h1 .product-logo', null, `genie-lamp-lockup-${tone}.svg`, 1114.74, heading, 'Genie'],
        ['/omni/', 'h1 .product-logo', null, `omni-mark-lockup-${tone}.svg`, 885.24, heading, 'Omni'],
        ['/mykes/', 'h1 .product-logo', '--st-stage', `mykes-clean-lockup-${tone}.svg`, 1058.16, heading, 'Mykes'],
        ['/', '[data-block="omni"] h3 .product-logo', null, `omni-mark-lockup-${tone}-header.svg`, 885.24, 44, 'Omni'],
        ['/', '[data-block="genie"] h3 .product-logo', '--plum-2', 'genie-lamp-lockup-cream.svg', 1114.74, 44, 'Genie'],
      ]) {
        await page.goto(origin + route, { waitUntil: 'load' })
        await page.evaluate(() => Promise.all([...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => { image.loading = 'eager'; return image.decode() })).then(() => document.fonts.ready))
        const seen = await page.evaluate(([selector, stop]) => {
          const image = document.querySelector(selector), box = image.getBoundingClientRect(), holder = image.closest('h1, h3'), column = holder.getBoundingClientRect(), card = image.closest('[data-block]')
          const canvas = document.createElement('canvas'); canvas.height = 132; canvas.width = Math.round(132 * box.width / box.height)
          const pen = canvas.getContext('2d', { willReadFrequently: true })
          // The ground the lockup stands on, as for the logo above: every background from the
          // page down, painted one over the other. A gradient is something that cannot read,
          // so its colours are painted last, one at a time: Genie's card by its lightest stop
          // (the hardest ground for cream letters), the stage by every stop it names.
          const layers = []; for (let node = image.parentElement; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor)
          const value = stop ? getComputedStyle(card ?? image).getPropertyValue(stop).trim() : '', last = !stop ? [null] : value.includes('gradient') ? value.match(/#[0-9a-f]{6}\b/gi) : [value]
          const under = last.map(colour => {
            pen.fillStyle = '#fff'; pen.fillRect(0, 0, 1, 1)
            for (const layer of colour ? [...layers, colour] : layers) { pen.fillStyle = layer; pen.fillRect(0, 0, 1, 1) }
            return [...pen.getImageData(0, 0, 1, 1).data.slice(0, 3)]
          })
          // The colour the mark and the name are drawn in: the commonest solid pixel of the
          // picture (the sparkle on an i is the only other colour, and it is small).
          pen.clearRect(0, 0, canvas.width, canvas.height); pen.drawImage(image, 0, 0, canvas.width, canvas.height)
          const pixels = pen.getImageData(0, 0, canvas.width, canvas.height).data, colours = new Map()
          for (let at = 0; at < pixels.length; at += 4) if (pixels[at + 3] === 255) { const colour = `${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`; colours.set(colour, (colours.get(colour) || 0) + 1) }
          return {
            file: image.currentSrc.split('/').pop(), drawn: image.naturalWidth > 0, size: [box.width, box.height], under, name: image.alt, text: holder.textContent.trim(),
            word: [...colours].sort((one, other) => other[1] - one[1])[0]?.[0].split(',').map(Number) ?? null,
            inside: box.left >= column.left - 0.5 && box.right <= column.right + 0.5, over: document.documentElement.scrollWidth - innerWidth,
            effects: [holder, image].map(node => { const style = getComputedStyle(node); return [style.filter, style.opacity, style.mixBlendMode].join(' ') }),
          }
        }, [selector, stop])
        const spot = `${route} ${selector} ${label}`, near = (value, wanted) => Math.abs(value - wanted) <= 0.6
        assert.equal(seen.file, file, `The lockup's file: ${spot}`)
        const light = colour => colour.map(value => value / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
        const against = seen.word && seen.under.length ? Math.min(...seen.under.map(under => (Math.max(light(seen.word), light(under)) + 0.05) / (Math.min(light(seen.word), light(under)) + 0.05))) : 0
        assert.ok(against >= 7, `The mark and the name are drawn clear against their ground: ${spot} ${JSON.stringify([seen.word, seen.under, against])}`)
        assert.ok(seen.drawn && near(seen.size[1], height) && near(seen.size[0], height * units / 264), `The lockup's size, unstretched: ${spot} ${seen.size}`)
        assert.ok(seen.inside && seen.over <= 0, `The lockup stays inside its column: ${spot} ${JSON.stringify([seen.inside, seen.over])}`)
        assert.deepEqual([...new Set(seen.effects)], ['none 1 normal'], `Nothing is drawn over the lockup: ${spot}`)
        assert.deepEqual([seen.name, seen.text], [name, ''], `The lockup's text is the product's name, and the heading holds nothing else: ${spot}`)
      }
      assert.deepEqual(outside, [], `No outside request: ${label}`)
      console.log(`PASS product lockups ${label}: Genie's, Omni's and Mykes's own files for the theme, the mark and the name clear against their ground, unstretched inside the column, page heading and home card`)
    } finally { await context.close() }
  }
  // The marks alone. In the Products menu each of Omni, Genie and Mykes stands beside its own
  // flat mark from the brand folder (Omni's is the vortex drawn for about 32 px), in ink on
  // the light page and cream on the dark one, drawn clear against the menu's ground: never
  // the triskle, never a pet. The triskle is Automagik's alone: it stands for Automagik's own
  // Cloud, the kit's 32 px drawing beside Cloud in the menu and the large one in Cloud's hero,
  // and no product's own page shows it. No character stands in a menu's picture.
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context), tone = colorScheme === 'dark' ? 'cream' : 'ink'
      const page = await context.newPage()
      const seen = async selector => page.evaluate(async selector => {
        const image = [...document.querySelectorAll(selector)].find(node => node.getClientRects().length)
        if (!image) return null
        await image.decode()
        const box = image.getBoundingClientRect()
        return [image.currentSrc.split('/').pop(), image.naturalWidth > 0, Math.round(box.width), Math.round(box.height)]
      }, selector)
      await page.goto(origin + '/', { waitUntil: 'load' })
      await page.locator('[popovertarget="menu-products"]').click()
      const light = colour => colour.map(value => value / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      for (const [slug, file] of [['omni', `omni-mark-${tone}-32.svg`], ['genie', `genie-lamp-${tone}.svg`], ['mykes', `mykes-clean-${tone}.svg`]]) {
        const entry = `#menu-products .menu-item[href="/${slug}/"]`
        assert.deepEqual(await seen(`${entry} .menu-art`), [file, true, 32, 32], `The ${slug} entry's mark is its own, for the theme: ${colorScheme}`)
        const drawn = await page.evaluate(async entry => {
          const pictures = [...document.querySelectorAll(`${entry} img`)], image = pictures[0]
          await image.decode()
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96
          const pen = canvas.getContext('2d', { willReadFrequently: true })
          const layers = []; for (let node = image.parentElement; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor)
          pen.fillStyle = '#fff'; pen.fillRect(0, 0, 1, 1)
          for (const layer of layers) { pen.fillStyle = layer; pen.fillRect(0, 0, 1, 1) }
          const under = [...pen.getImageData(0, 0, 1, 1).data.slice(0, 3)]
          pen.clearRect(0, 0, 96, 96); pen.drawImage(image, 0, 0, 96, 96)
          const pixels = pen.getImageData(0, 0, 96, 96).data, colours = new Map()
          for (let at = 0; at < pixels.length; at += 4) if (pixels[at + 3] === 255) { const colour = `${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`; colours.set(colour, (colours.get(colour) || 0) + 1) }
          return { count: pictures.length, sources: pictures.map(picture => picture.getAttribute('src')), under, ink: [...colours].sort((one, other) => other[1] - one[1])[0]?.[0].split(',').map(Number) ?? null, shades: colours.size }
        }, entry)
        const against = drawn.ink && (Math.max(light(drawn.ink), light(drawn.under)) + 0.05) / (Math.min(light(drawn.ink), light(drawn.under)) + 0.05)
        assert.ok(drawn.count === 1 && !/triskle|\/assets\/art\//.test(drawn.sources.join(' ')), `Beside ${slug} stands its own mark alone, no triskle and no pet: ${colorScheme} ${drawn.sources}`)
        assert.ok(against >= 7 && drawn.shades === 1, `The ${slug} mark is flat, one colour, clear against the menu's ground: ${colorScheme} ${JSON.stringify([drawn.ink, drawn.under, against, drawn.shades])}`)
      }
      assert.deepEqual(await seen('#menu-products .menu-item[href="/cloud/"] .menu-art'), ['triskle-three-colours-32.svg', true, 32, 32], `The Cloud entry's mark is the triskle drawn for 32 px: ${colorScheme}`)
      const pets = await page.evaluate(() => [...document.querySelectorAll('.menu-panel .menu-icon img')].map(image => image.getAttribute('src')).filter(src => /\/assets\/art\/(?!app-icon)|omni-pleased|lamp\.webp/.test(src)))
      assert.deepEqual(pets, [], `No character stands in a menu's picture: ${colorScheme}`)
      await page.goto(origin + '/cloud/', { waitUntil: 'load' })
      assert.deepEqual(await seen('.hero-mark'), ['triskle-three-colours.svg', true, 300, 300], `The Cloud hero's mark: ${colorScheme}`)
      for (const route of ['/mykes/', '/genie/', '/omni/']) {
        await page.goto(origin + route, { waitUntil: 'load' })
        const triskles = await page.evaluate(() => [...document.querySelectorAll('main img, #menu-products .menu-item:is([href="/omni/"], [href="/genie/"], [href="/mykes/"]) img')].map(image => image.getAttribute('src')).filter(src => /triskle|lockup-three-colours/.test(src)))
        assert.deepEqual(triskles, [], `No triskle stands on a product's own page or beside its name: ${route} ${colorScheme}`)
      }
      assert.deepEqual(outside, [], `No outside request: marks ${colorScheme}`)
      console.log(`PASS marks ${colorScheme}: Omni's, Genie's and Mykes's own flat marks in the Products menu, clear against its ground; the triskle only for Automagik's Cloud; no character in a menu's picture`)
    } finally { await context.close() }
  }
  // The drawer's lockup on a narrow phone. The brand's floor for a lockup is 28 px, with one
  // exception: 24 px in the family drawer's phone layout. Here Automagik is the host, so its
  // lockup stands alone in the top block and nothing squeezes it: it is 24 px high or more at
  // 375 and 360 px wide, at its own proportions (396 by 64).
  for (const width of [375, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context), page = await context.newPage()
      await page.goto(origin + '/', { waitUntil: 'load' })
      await page.locator('[data-family-open]').click()
      await page.waitForFunction(() => document.documentElement.classList.contains('is-family-open'))
      await page.waitForFunction(() => [...document.querySelectorAll('[data-family-drawer] .fam-logo img')].some(image => image.getClientRects().length && image.complete && image.naturalWidth > 0))
      const lockups = await page.evaluate(() => [...document.querySelectorAll('[data-family-drawer] .fam-logo img')].filter(image => image.getClientRects().length).map(image => { const box = image.getBoundingClientRect(); return [image.currentSrc.split('/').pop(), box.width, box.height] }))
      assert.equal(lockups.length, 1, `The drawer shows Automagik's lockup once: ${width}px ${JSON.stringify(lockups)}`)
      const [file, wide, high] = lockups[0]
      assert.ok(/^automagik-lockup-three-colours-ink-(?:48|64|128)\.png$/.test(file) && high >= 24 - 0.05 && Math.abs(wide - high * 396 / 64) <= 0.6, `The drawer's lockup is 24 px high or more on a narrow phone, unstretched: ${width}px ${JSON.stringify(lockups[0])}`)
      assert.deepEqual(outside, [], `No outside request from the drawer: ${width}px`)
      console.log(`PASS drawer lockup ${width}px: 24 px high or more, at its own proportions`)
    } finally { await context.close() }
  }
  // The download hook, with real clicks and keys. A live platform opens its sheet: in the
  // middle of a wide window, rising from the bottom edge of a phone. A platform that is
  // coming later is a label: no click, no focus, no file.
  const sheetBehind = page => page.evaluate(() => ({ scroll: getComputedStyle(document.documentElement).overflowY, inert: [...document.querySelectorAll('.top, main, .site-footer')].map(part => getComputedStyle(part).interactivity) }))
  for (const colorScheme of ['light', 'dark']) for (const [route, ids] of Object.entries(offered)) for (const [width, height] of [[1440, 900], [390, 844], [320, 700]]) {
    const label = `${route} ${colorScheme} ${width}px`, slug = route === '/' ? 'home' : route.split('/')[1]
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'reduce' })
    try {
      const outside = await guard(context)
      await watchShift(context)
      const page = await context.newPage(), cdp = await context.newCDPSession(page)
      await page.goto(origin + route, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      const chips = await page.evaluate(() => [...document.querySelectorAll('.get-row > li')].map(item => {
        const chip = item.matches('.get-chip') ? item : item.querySelector('button.get-chip'), fallback = item.querySelector('.get-fallback')
        const box = chip.getBoundingClientRect(), top = selector => Math.round(chip.querySelector(selector).getBoundingClientRect().top)
        return { name: chip.querySelector('.get-name').textContent, target: chip.getAttribute('popovertarget'), controls: item.querySelectorAll('a, button').length, left: box.left, right: box.right, top: Math.round(box.top), width: box.width, height: Math.round(box.height), sign: top('.platform-sign'), word: top('.get-name'), kind: chip.querySelector('.get-kind').textContent, fallback: fallback && getComputedStyle(fallback).display }
      }))
      assert.deepEqual(chips.map(chip => [chip.name, chip.target, chip.controls, chip.kind === 'Soon']), ids.map(id => platforms[id].soon ? [platforms[id].name, null, 0, true] : [platforms[id].name, `get-${id}`, 2, false]), `The tray offers its platforms in order, and the ones coming later are not controls: ${label}`)
      for (const chip of chips) {
        assert.ok(chip.left >= 0 && chip.right <= width && chip.width >= 44 && chip.height >= 44, `Each platform is a full tap target inside the screen: ${label} ${JSON.stringify(chip)}`)
        assert.deepEqual([chip.top, chip.height, chip.sign, chip.word], [chips[0].top, chips[0].height, chips[0].sign, chips[0].word], `Live and coming platforms line up: ${label} ${chip.name}`)
        if (chip.target) assert.equal(chip.fallback, 'none', `The plain link is only for a browser without popovers: ${label}`)
      }
      // The keyboard stops on the live platforms, in order, and on nothing else in the tray
      // (a short page comes round to them again; each stop counts once).
      const stops = []
      for (let press = 0; press < 40; press++) {
        await page.keyboard.press('Tab')
        const stop = await page.evaluate(() => document.activeElement.closest('.get-row') ? document.activeElement.getAttribute('popovertarget') ?? document.activeElement.outerHTML.slice(0, 60) : null)
        if (stop && !stops.includes(stop)) stops.push(stop)
      }
      assert.deepEqual(stops, chips.filter(chip => chip.target).map(chip => chip.target), `Tab reaches the live platforms only: ${label}`)
      await page.locator('.get-chip.soon').first().click()
      assert.equal(await page.locator(':popover-open').count(), 0, `A platform that is coming later opens nothing: ${label}`)
      for (const id of ids.filter(id => !platforms[id].soon)) {
        const platform = platforms[id], button = page.locator(`.get-row [popovertarget="get-${id}"]`), sheet = page.locator(`#get-${id}`), about = `${label} ${id}`
        assert.equal(await expanded(cdp, `${platform.name}: `), false, `The platform starts collapsed: ${about}`)
        await button.click()
        let state = await panelState(page, `get-${id}`)
        assert.ok(state.open && state.shown && state.overflow === 0, `A click opens the sheet: ${about}`)
        // The page behind an open sheet is inert, the platform's button with it: it is not announced at all.
        assert.equal(await expanded(cdp, `${platform.name}: `), undefined, `The platform is out of reach behind its sheet: ${about}`)
        assert.ok(state.box.left >= 0 && state.box.right <= width && state.box.top >= 0 && state.box.bottom <= height, `The sheet is inside the screen: ${about} ${JSON.stringify(state.box)}`)
        if (width > 700) assert.ok(Math.abs(state.box.left + state.box.width / 2 - width / 2) <= 1 && Math.abs(state.box.top + state.box.height / 2 - height / 2) <= 1, `The sheet sits in the middle of the window: ${about} ${JSON.stringify(state.box)}`)
        else assert.ok(state.box.left === 0 && state.box.width === width && Math.abs(state.box.bottom - height) <= 1, `The sheet rises from the bottom edge: ${about} ${JSON.stringify(state.box)}`)
        assert.ok(state.focusInside, `The focus moves into the sheet: ${about}`)
        assert.equal(await sheet.getAttribute('role'), 'dialog')
        assert.equal(await page.evaluate(id => document.getElementById(document.getElementById(id).getAttribute('aria-labelledby')).textContent, `get-${id}`), `For ${platform.name}`)
        assert.deepEqual(await sheetBehind(page), { scroll: width > 700 ? 'visible' : 'hidden', inert: ['inert', 'inert', 'inert'] }, `The page behind the sheet is out of reach: ${about}`)
        // What the sheet says: the exact file, how to install it, the download, one guide.
        assert.equal(await sheet.locator('.sheet-facts code').first().innerText(), platform.file, `The sheet names the file: ${about}`)
        assert.ok(await sheet.locator('.steps > li').count() >= 2, `The sheet says how to install: ${about}`)
        const download = sheet.locator('a.button.primary')
        assert.equal(await download.getAttribute('href'), platform.download[1], `The button fetches that file: ${about}`)
        assert.equal(await sheet.locator('.detail-link').count(), 1)
        // Every part of the sheet can be brought onto the screen, on the smallest phone too.
        for (const part of [download, sheet.locator('.detail-link'), sheet.locator('.sheet-close')]) {
          await part.scrollIntoViewIfNeeded()
          const box = await part.boundingBox()
          assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height && box.height >= 44, `The sheet's controls are reachable, full tap targets: ${about} ${JSON.stringify(box)}`)
        }
        assert.equal(await sheet.evaluate(node => node.scrollWidth - node.clientWidth), 0, `Nothing in the sheet is wider than it: ${about}`)
        if (width !== 320) await page.screenshot({ path: join(evidence, `hook-${slug}-${id}-${colorScheme}-${width}.png`) })
        // The keyboard stays in the sheet and reaches its close button, download and guide.
        const inside = new Set()
        for (let press = 0; press < 12; press++) {
          await page.keyboard.press('Tab')
          inside.add(await page.evaluate(id => { const active = document.activeElement; return active === document.body ? 'page' : active.closest(`#${id}`) ? `sheet:${active.getAttribute('href') ?? active.className}` : `behind:${active.outerHTML.slice(0, 60)}` }, `get-${id}`))
        }
        assert.deepEqual([...inside].filter(stop => stop.startsWith('behind:')), [], `Tab never lands behind the sheet: ${about}`)
        for (const stop of ['sheet:sheet-close', `sheet:${platform.download[1]}`]) assert.ok(inside.has(stop), `Tab reaches ${stop}: ${about} ${[...inside]}`)
        // Escape, from anywhere in the sheet, closes it and the focus goes back to the platform.
        await sheet.locator('.sheet-close').focus()
        await page.keyboard.press('Escape')
        state = await panelState(page, `get-${id}`)
        assert.ok(!state.open && !state.shown && state.focusButton === `get-${id}`, `Escape closes the sheet and returns the focus: ${about} ${JSON.stringify(state)}`)
        assert.equal(await expanded(cdp, `${platform.name}: `), false)
        assert.deepEqual(await sheetBehind(page), { scroll: 'visible', inert: ['auto', 'auto', 'auto'] }, `The page is back in reach: ${about}`)
        // Enter opens it from the keyboard; its own button and a click beside it close it.
        await page.keyboard.press('Enter')
        assert.ok((await panelState(page, `get-${id}`)).open, `Enter opens the sheet: ${about}`)
        await sheet.locator('.sheet-close').click()
        state = await panelState(page, `get-${id}`)
        assert.ok(!state.open && state.focusButton === `get-${id}`, `The close button closes the sheet and returns the focus: ${about}`)
        await button.click(); await page.mouse.click(6, 6)
        assert.ok(!(await panelState(page, `get-${id}`)).shown, `A click beside the sheet closes it: ${about}`)
      }
      assert.equal(await page.evaluate(() => window.__shift), 0, `The sheets never shift the page: ${label}`)
      assert.deepEqual(outside, [], `No external request from the download hook: ${label}`)
    } finally { await context.close() }
    console.log(`PASS download hook ${label}: order, alignment, tap targets, soon is a label, sheet in place, file and download, keyboard, Escape, focus return`)
  }
  // For a visitor who allows motion the sheet eases in (opacity and a short rise) and ends
  // fully shown, in place; with reduced motion it simply appears.
  for (const reducedMotion of ['no-preference', 'reduce']) for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion })
    try {
      const page = await context.newPage()
      await page.goto(origin + '/', { waitUntil: 'load' })
      const eased = await page.evaluate(async () => {
        const sheet = document.getElementById('get-mac')
        document.querySelector('[popovertarget="get-mac"]').click()
        await new Promise(done => requestAnimationFrame(done))
        const running = sheet.getAnimations(), moved = running.map(animation => animation.transitionProperty).sort()
        await Promise.all(running.map(animation => animation.finished))
        const style = getComputedStyle(sheet)
        return { open: sheet.matches(':popover-open'), moved, opacity: style.opacity, translate: style.translate }
      })
      assert.deepEqual(eased, { open: true, moved: reducedMotion === 'reduce' ? [] : ['opacity', 'translate'], opacity: '1', translate: 'none' }, `The sheet's entrance: ${reducedMotion} ${width}px ${JSON.stringify(eased)}`)
    } finally { await context.close() }
  }
  console.log('PASS download hook motion: the sheet eases in for visitors who allow motion, appears at once otherwise, and ends in place')
  // The projects row. Every mark is the project's own file at its own proportions, the dark
  // file on a dark page. For a visitor who allows motion it is one line that drifts (slower on
  // a phone, where every name is whole on screen for at least 7 s as it passes), stops under
  // the pointer and turns into the still list for the keyboard; a pause switch under it holds
  // it still for a tap, a click or the Space key. With reduced motion it is the still, wrapped
  // list and there is no switch. The copy that fills the gap is never reached.
  const drift = {}
  for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [390, 844]]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const label = `${width}px ${colorScheme} ${reducedMotion}`
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion, hasTouch: width < 700 })
    try {
      const outside = await guard(context), page = await context.newPage()
      await page.goto(origin + '/', { waitUntil: 'load' })
      await page.locator('.we-use').scrollIntoViewIfNeeded()
      await page.evaluate(() => Promise.all([...document.querySelectorAll('.we-use-list:not(.we-use-copy) img')].map(image => { image.loading = 'eager'; return image.decode().catch(() => {}) })))
      const row = () => page.evaluate(() => {
        const track = document.querySelector('.we-use-track'), [list, copy] = track.querySelectorAll('.we-use-list'), style = getComputedStyle(list)
        const edge = parseFloat(getComputedStyle(track).getPropertyValue('--edge')) || 0
        return {
          items: [...list.children].map(item => { const box = item.getBoundingClientRect(), image = item.querySelector('img'), drawn = image.getBoundingClientRect(); return { left: box.left, right: box.right, middle: Math.round(box.top + box.height / 2), width: box.width, file: new URL(image.currentSrc).pathname, loaded: image.naturalWidth > 0, ratio: image.naturalWidth / image.naturalHeight, drawn: [drawn.width, drawn.height], link: item.querySelector('a').getBoundingClientRect().height } }),
          wraps: style.flexWrap, copy: getComputedStyle(copy).display, running: list.getAnimations().map(animation => [animation.animationName, animation.playState]),
          lap: parseFloat(style.animationDuration), length: list.getBoundingClientRect().width, clear: track.clientWidth * (1 - 2 * edge / 100), overflow: document.documentElement.scrollWidth - innerWidth,
          tall: document.querySelector('.we-use').getBoundingClientRect().height,
          pause: (() => { const label = document.querySelector('.we-use-pause'), box = label.getBoundingClientRect(), input = label.querySelector('input'), over = input.getBoundingClientRect(); return { shown: getComputedStyle(label).display, size: [box.width, box.height], covered: over.width >= box.width - 0.5 && over.height >= box.height - 0.5, on: input.checked, says: label.innerText.trim(), inTrack: Boolean(label.closest('.we-use-track')) } })(),
        }
      })
      let state = await row()
      assert.equal(state.overflow, 0, `The row never widens the page: ${label}`)
      used.forEach(({ name, mark: [light, dark, markWidth, markHeight], shown }, index) => {
        const item = state.items[index]
        assert.ok(item.loaded && item.file === `/assets/brand/used/${colorScheme === 'dark' && dark ? dark : light}`, `${name} shows its own file for the theme: ${label} ${item.file}`)
        assert.ok(Math.abs(item.drawn[1] - shown) < 0.5 && Math.abs(item.drawn[0] / item.drawn[1] - markWidth / markHeight) < 0.03 && Math.abs(item.ratio - markWidth / markHeight) < 0.03, `${name} is drawn at its own proportions: ${label} ${JSON.stringify(item.drawn)}`)
        assert.ok(item.link >= 44, `${name} is a 44px target: ${label}`)
      })
      if (reducedMotion === 'reduce') {
        assert.deepEqual([state.wraps, state.copy, state.running], ['wrap', 'none', []], `Reduced motion: the still, wrapped list: ${label}`)
        assert.equal(state.pause.shown, 'none', `Reduced motion: nothing moves, so there is no pause switch: ${label}`)
        for (const item of state.items) assert.ok(item.left >= 0 && item.right <= width, `Every item is on screen: ${label}`)
      } else {
        assert.deepEqual([state.wraps, state.copy, state.running], ['nowrap', 'flex', [['we-use-drift', 'running']]], `The row is one drifting line: ${label} ${JSON.stringify(state.running)}`)
        assert.equal(new Set(state.items.map(item => item.middle)).size, 1, `Every item sits on one centre line: ${label}`)
        // Slow enough to read: the widest item fits whole between the faded edges, with time to spare.
        const speed = state.length / state.lap, widest = Math.max(...state.items.map(item => item.width))
        drift[width] = speed
        const whole = (state.clear - widest) / speed, least = width < 700 ? 7 : 4
        assert.ok(widest < state.clear && whole >= least, `Each name is whole on screen for at least ${least} s as it passes: ${label} ${speed.toFixed(1)}px/s ${whole.toFixed(1)}s`)
        if (width === 1440) {
          const band = await page.locator('.we-use-track').boundingBox()
          await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2)
          assert.deepEqual((await row()).running, [['we-use-drift', 'paused']], `The row stops under the pointer: ${label}`)
          await page.mouse.move(0, 0)
        }
        // The pause switch: a real checkbox under the row, a 44px target that the box itself
        // covers. A tap on a phone (a click elsewhere) holds the row where it is, with nothing
        // moved on the page; the Space key lets it go again, and the row drifts on.
        assert.deepEqual([state.pause.shown, state.pause.covered, state.pause.on, state.pause.says, state.pause.inTrack], ['flex', true, false, 'Pause', false], `The pause switch is shown, off, outside the row: ${label} ${JSON.stringify(state.pause)}`)
        assert.ok(state.pause.size[0] >= 44 && state.pause.size[1] >= 44, `The pause switch is a 44px target: ${label} ${state.pause.size}`)
        // What assistive technology is told: one checkbox, named by its label, with its state.
        const told = async () => {
          const cdp = await context.newCDPSession(page), { nodes } = await cdp.send('Accessibility.getFullAXTree')
          await cdp.detach()
          return nodes.filter(node => !node.ignored && node.role?.value === 'checkbox').map(node => [node.name?.value, String(node.properties?.find(property => property.name === 'checked')?.value.value)])
        }
        assert.deepEqual(await told(), [['Pause', 'false']], `The switch is read out as a checkbox named Pause, not checked: ${label}`)
        const box = page.getByRole('checkbox', { name: 'Pause', exact: true })
        if (width < 700) await box.tap(); else await box.click()
        await page.mouse.move(0, 0)
        assert.deepEqual(await told(), [['Paused', 'true']], `Once on, it is read out as Paused, checked: ${label}`)
        const held = await row()
        assert.deepEqual([held.running, held.wraps, held.copy, held.pause.on, held.pause.says, held.tall], [[['we-use-drift', 'paused']], 'nowrap', 'flex', true, 'Paused', state.tall], `The switch holds the row still, in place: ${label} ${JSON.stringify([held.running, held.pause, held.tall])}`)
        await page.getByRole('checkbox', { name: 'Paused', exact: true }).focus()
        await page.keyboard.press('Space')
        const freed = await row()
        assert.deepEqual([freed.running, freed.wraps, freed.pause.on, freed.pause.says], [[['we-use-drift', 'running']], 'nowrap', false, 'Pause'], `Space lets the row go again: ${label} ${JSON.stringify([freed.running, freed.pause])}`)
        await page.evaluate(() => document.activeElement.blur())
      }
      await page.screenshot({ path: join(evidence, `we-use-${width}-${colorScheme}-${reducedMotion === 'reduce' ? 'still' : 'drifting'}.png`) })
      // The keyboard reaches the eleven links once, in order, and the row holds still while it is in it;
      // then the pause switch, where there is one; then it leaves the row.
      await page.locator('.we-use-title').evaluate(node => { node.tabIndex = -1; node.focus() })
      const reached = []
      for (const { href } of used) {
        await page.keyboard.press('Tab')
        reached.push(await page.evaluate(() => { const active = document.activeElement, box = active.getBoundingClientRect(); return [active.getAttribute('href'), Boolean(active.closest('.we-use-copy')), box.left >= 0 && box.right <= innerWidth] }))
      }
      assert.deepEqual(reached, used.map(({ href }) => [href, false, true]), `Tab walks the row once, each link on screen: ${label}`)
      state = await row()
      assert.deepEqual([state.wraps, state.copy, state.running], ['wrap', 'none', []], `With the keyboard in it the row is the still list: ${label}`)
      if (reducedMotion !== 'reduce') {
        // The next Tab is the pause switch: the ring goes round its pill, and with the keyboard
        // out of the row the row drifts again.
        await page.keyboard.press('Tab')
        const ring = await page.evaluate(() => { const active = document.activeElement, pill = active.closest('.we-use-pause'), style = pill && getComputedStyle(pill); return { on: active.matches('.we-use-pause input:focus-visible'), ring: style && [style.outlineStyle, style.outlineWidth, style.outlineColor !== 'rgba(0, 0, 0, 0)'] } })
        assert.deepEqual(ring, { on: true, ring: ['solid', '3px', true] }, `Tab reaches the pause switch and its focus ring shows: ${label} ${JSON.stringify(ring)}`)
        assert.deepEqual((await row()).running, [['we-use-drift', 'running']], `With the keyboard on the switch the row drifts: ${label}`)
      }
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.we-use'))), false, `The copy is never reached: ${label}`)
      assert.deepEqual(outside, [], `The row asks nothing of another site: ${label}`)
    } finally { await context.close() }
  }
  assert.ok(drift[390] < drift[1440] && drift[390] <= 16, `The phone drift is the slower one: ${JSON.stringify(drift)}`)
  console.log('PASS projects row: own files per theme at their proportions, one drifting line that stops for pointer and keyboard, readable phone drift, still wrapped list with reduced motion, copy out of reach, no outside request')
  // Motion, for a visitor who allows it. Every page is scrolled from top to bottom at desktop
  // and phone width: something moves, nothing shifts the layout (the browser's own layout-shift
  // score stays 0), nothing overflows, and everything that rises into view ends fully shown,
  // down to the last section. Then a link is followed: the page-to-page transition runs to
  // its end, and the menu eases in.
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' })
    try {
      const outside = await guard(context)
      await watchShift(context)
      await context.addInitScript(() => addEventListener('pagereveal', event => {
        window.__arrived = event.viewTransition ? 'running' : 'plain'
        event.viewTransition?.finished.then(() => { window.__arrived = 'finished' }, () => { window.__arrived = 'skipped' })
      }))
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      for (const route of routes) {
        const label = `${route} ${width}px`
        await page.goto(origin + route, { waitUntil: 'load' })
        await page.evaluate(() => Promise.all([...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => { image.loading = 'eager'; return image.decode() })).then(() => document.fonts.ready))
        const seen = { held: 0, driven: 0, timed: 0 }
        for (let top = 0, last = false; !last; top += 160) {
          const step = await page.evaluate(async top => {
            scrollTo({ top, behavior: 'instant' })
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
            const animations = document.getAnimations(), driven = animations.filter(animation => animation.timeline instanceof ScrollTimeline)
            const rising = driven.filter(animation => ['rise', 'press'].includes(animation.animationName))
            const end = scrollY + innerHeight >= document.documentElement.scrollHeight - 1
            // Held back: the rise has not finished, so the element is still dim or low.
            const held = animation => (animation.effect.getComputedTiming().progress ?? 1) < 1
            const name = ({ effect: { target } }) => `${target.tagName.toLowerCase()}.${target.className}`.slice(0, 60)
            return {
              end, driven: driven.length, timed: animations.length - driven.length, held: rising.filter(held).length,
              // Well inside the screen, or anywhere on it at the page's end: fully shown.
              stuck: rising.filter(animation => held(animation) && animation.effect.target.getBoundingClientRect().top < innerHeight - (end ? 0 : 520)).map(name),
              overflow: document.documentElement.scrollWidth - innerWidth,
            }
          }, top)
          assert.deepEqual(step.stuck, [], `Everything that rises into view ends fully shown: ${label} at ${top}px`)
          assert.equal(step.overflow, 0, `Motion never widens the page: ${label} at ${top}px`)
          seen.held = Math.max(seen.held, step.held); seen.driven = Math.max(seen.driven, step.driven); seen.timed = Math.max(seen.timed, step.timed)
          last = step.end
        }
        assert.ok(seen.driven > 0 && seen.held > 0, `Scrolling drives the page's motion: ${label} ${JSON.stringify(seen)}`)
        if (route === '/') assert.ok(seen.timed > 0, `The home's stage moves on its own: ${label}`)
        assert.equal(await page.evaluate(() => window.__shift), 0, `No layout shift with motion: ${label}`)
        // Arca's logo is never animated.
        assert.deepEqual(await page.evaluate(() => document.getAnimations().map(animation => animation.effect.target).filter(element => element.closest?.('.arca-ark, .fam-logo')).length), 0, `Arca's logo stays still: ${label}`)
      }
      // Page to page: the browser's cross-document transition runs to its end (a name used
      // twice on a page would skip it), and the character named on both pages is one of a kind.
      const names = () => page.evaluate(() => { const count = {}; for (const element of document.querySelectorAll('*')) { const name = getComputedStyle(element).viewTransitionName; if (name !== 'none') count[name] = (count[name] ?? 0) + 1 } return count })
      // A busy machine can make the browser drop one transition, so the walk gets three tries;
      // a page that breaks transitions fails all three.
      let arrived = ''
      for (let attempt = 0; attempt < 3 && arrived !== 'finished'; attempt++) {
        await page.goto(origin + '/', { waitUntil: 'load' })
        assert.deepEqual(await names(), { root: 1, 'site-top': 1, 'fb-bar': 1, genie: 1, omni: 1, pet: 1 }, `Transition names are unique on the home: ${width}px`)
        if (width > 860) { await page.locator('[popovertarget="menu-products"]').click(); await page.locator('#menu-products .menu-item[href="/genie/"]').click() }
        else { await page.locator('[data-family-open]').click(); await page.locator('[data-family-drawer] .fam-item[href="/genie/"]').click() }
        await page.waitForURL(origin + '/genie/')
        await page.waitForFunction(() => window.__arrived === 'finished' || window.__arrived === 'skipped' || window.__arrived === 'plain')
        arrived = await page.evaluate(() => window.__arrived)
      }
      assert.equal(arrived, 'finished', `The page-to-page transition runs: ${width}px`)
      assert.deepEqual(await names(), { root: 1, 'site-top': 1, 'fb-bar': 1, genie: 1, omni: 1, pet: 1 }, `Transition names are unique on a product page: ${width}px`)
      // The menu eases in and settles fully shown, in place.
      // On a phone the menu is the family drawer: it slides in from the left edge.
      const opener = width > 860 ? '[popovertarget="menu-products"]' : '[data-family-open]', eased = width > 860 ? '#menu-products .menu-card' : '[data-family-drawer]'
      await page.locator(opener).click()
      assert.notEqual(await page.locator(eased).evaluate(node => getComputedStyle(node).transitionDuration), '0s', `The menu has an entrance: ${width}px`)
      await page.waitForFunction(selector => { const style = getComputedStyle(document.querySelector(selector)); return style.opacity === '1' && style.translate === 'none' && style.transform === 'none' }, eased)
      assert.deepEqual(outside, []); assert.deepEqual(errors, [])
      console.log(`PASS motion ${width}px: every page scrolled; scroll-driven and timed motion run; layout shift 0; nothing left dim; page transition and menu entrance`)
    } finally { await context.close() }
  }
  // Native form submissions against the actual function, with no real binding/provider.
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } })
  const outside = await guard(context)
  try {
    const page = await context.newPage()
    const fill = async () => {
      await page.goto(origin + '/cloud/')
      await page.locator('[name=goal]').fill('Review the project reports')
      await page.locator('[name=expected_result]').fill('A report I can review')
      await page.locator('[name=email]').fill('demo@example.com')
      await page.locator('[name=consent]').check()
    }
    await fill()
    const failure = page.waitForResponse(response => response.url() === origin + '/api/waitlist' && response.request().method() === 'POST')
    await page.getByRole('button', { name: /Register my interest/ }).click()
    assert.equal((await failure).status(), 503)
    await page.getByRole('heading', { name: 'Registration is unavailable' }).waitFor()
    // The answer page carries the site's logo at the header's size, and none of the retired pictures.
    const answerLogo = await page.evaluate(async () => {
      await Promise.all([...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => image.decode()))
      const image = document.querySelector('.top .brand img')
      return { height: image.getBoundingClientRect().height, file: image.currentSrc.split('/').pop(), drawn: image.naturalWidth > 0, pictures: [...document.images].filter(image => !image.closest('.fam, .fam-world')).map(image => new URL(image.currentSrc).pathname) }
    })
    assert.ok(Math.abs(answerLogo.height - 26 * 264 / 222) <= 0.6 && answerLogo.drawn && answerLogo.file === 'automagik-lockup-three-colours-ink-header.svg', `The answer page's logo is the header's: ${JSON.stringify(answerLogo)}`)
    assert.deepEqual(answerLogo.pictures.filter(source => /\.webp$/.test(source)), [], 'No answer page shows a retired picture')
    // The form offers email only: no WhatsApp choice, the email field required. The removal
    // form still takes a WhatsApp sender or code, for people who signed up that way before.
    await page.goto(origin + '/cloud/')
    assert.deepEqual(await page.locator('.waitlist-form [name=channel]').evaluate(input => [input.type, input.value]), ['hidden', 'email'])
    assert.equal(await page.locator('.waitlist-form [name=email]').evaluate(input => input.required), true)
    assert.doesNotMatch(await page.locator('.waitlist-form').innerText(), /WhatsApp/)
    assert.equal(await page.locator('a[href*="wa.me"]').count(), 0)
    assert.deepEqual(await page.locator('.removal-form [name=channel] option').evaluateAll(options => options.map(option => option.value)), ['email', 'whatsapp', 'code'])
    await page.locator('.waitlist-form').screenshot({ path: join(evidence, 'email-only-form-390.png') })
    // A stale page still sending WhatsApp, against a ready binding: refused, and no code issued.
    bindingMode = 'ready'
    await fill()
    await page.locator('.waitlist-form [name=channel]').evaluate(input => { input.value = 'whatsapp' })
    const stale = page.waitForResponse(response => response.url() === origin + '/api/waitlist' && response.request().method() === 'POST')
    await page.getByRole('button', { name: /Register my interest/ }).click()
    assert.equal((await stale).status(), 503)
    await page.getByRole('heading', { name: 'Registration is unavailable' }).waitFor()
    assert.doesNotMatch(await page.content(), /AMG-|wa\.me/)
    assert.equal(isolated.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0)
    // Codes issued before the pause still confirm, and the removal form removes them by sender or code.
    const earlier = async code => {
      const time = now()
      isolated.sqlite.prepare('INSERT INTO waitlist(id,channel,email,goal,platform,apps,expected_result,language,consent_version,created_at,expires_at,confirmation_hash,address_key,group_key,mail_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'whatsapp', null, 'Review the project reports', 'both', '', 'A report I can review', 'en', CONSENT_VERSION, time, time + 1800, await hash(code), null, `earlier-${code}`, new Date(time * 1000).toISOString().slice(0, 10))
    }
    await earlier('AMG-7K2M9Q')
    const confirmed = await whatsappConfirm({ env: isolated.env, request: new Request('https://automagik.si/api/waitlist/whatsapp-confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${isolated.env.WAITLIST_CONFIRM_SECRET}` }, body: JSON.stringify({ type: 'message.received', timestamp: Date.now(), payload: { externalId: 'earlier-message', from: 'earlier-sender-LID@lid', content: { text: 'Confirm my Automagik waitlist: AMG-7K2M9Q' } } }) }) })
    assert.equal(confirmed.status, 200)
    assert.equal(isolated.sqlite.prepare('SELECT count(*) AS n FROM waitlist WHERE confirmed_at IS NOT NULL').get().n, 1)
    await earlier('AMG-3HX8VW')
    for (const [channel, contact, left] of [['code', 'AMG-3HX8VW', 1], ['whatsapp', 'earlier-sender-LID', 0]]) {
      await page.goto(origin + '/cloud/')
      await page.locator('#privacy').evaluate(details => { details.open = true })
      await page.locator('.removal-form [name=channel]').selectOption(channel)
      await page.locator('.removal-form [name=contact]').fill(contact)
      const removed = page.waitForResponse(response => response.url() === origin + '/api/waitlist' && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Remove my details' }).click()
      assert.equal((await removed).status(), 200)
      await page.getByRole('heading', { name: 'Removal complete' }).waitFor()
      assert.equal(isolated.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, left, `removed by ${channel}`)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
    assert.deepEqual(outside, [])
    console.log('PASS native form: missing binding 503; email only; stale WhatsApp POST 503 with no code; earlier code confirms; removal by sender and code; no external request')
  } finally { await context.close() }
  await writeFile(join(evidence, 'browser-report.json'), JSON.stringify(reports, null, 2) + '\n')
} finally {
  await browser?.close()
  if (server.listening) await new Promise(done => server.close(done))
  isolated.close()
}
