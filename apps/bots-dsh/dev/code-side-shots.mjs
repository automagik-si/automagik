// The Code side's pictures and its lazy-load check, from the real app and a fake core
// (RFC 0030 delivery 1): the bench's web page on made-up names, light and dark, 1440 and 390
// wide, with the open Bot's Terminal face pressed and its watched herdr-core pane. Never a
// live Herdr and never a real pane: the terminal comes from test/fixtures/fake-hc-core.mjs.
//
//   FAKE_CORE_LOG=<bench core.log> node dev/code-side-shots.mjs <login-url> <out-dir> <bot-id>
//
// With FAKE_CORE_LOG set, the run also proves Chat alone fetches neither the tree (no hc
// spawn) nor the renderer chunk (no client.pane.js request), and that Terminal fetches both.
// The bench's settings document has no welcome acknowledgement, so the Preview Notice modal
// cannot close by itself; the picture run removes its overlay, not the app. CHROME_BIN may
// point at a Chromium; playwright-core comes from this package.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [login, outDir, botId] = process.argv.slice(2)
if (!login || !outDir || !botId) {
  console.error('usage: node dev/code-side-shots.mjs <login-url> <out-dir> <bot-id>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN, args: ['--force-color-profile=srgb'] })
const failures = []
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) failures.push(message) }
const coreLines = () => {
  try { return readFileSync(process.env.FAKE_CORE_LOG, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}
const chunkSeen = page => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('client.pane.js')))

for (const [width, height] of [[1440, 900], [390, 844]]) {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
    const page = await context.newPage()
    await page.goto(login)
    await page.waitForTimeout(4500)
    // The bench-only overlay line: no acknowledgement is stored in the bench's settings, so the
    // preview notice stays and its mask blocks clicks. The app underneath is the real one.
    await page.evaluate(() => { for (const overlay of document.querySelectorAll('[role="presentation"]')) overlay.remove() })
    await page.waitForTimeout(400)
    const rows = page.locator('.lb-row, .bt-row')
    await rows.first().waitFor({ timeout: 30_000 }).catch(() => {})
    if (await page.locator('.lb-face-part[data-face="terminal"]').count() === 0) {
      await rows.first().click().catch(() => {})
      await page.waitForTimeout(1500)
    }
    check(await page.locator('.lb-face-part[data-face="terminal"]').count() === 1, `${scheme} ${width}: the header shows the Chat / Terminal switch`)
    // Chat alone: neither the renderer chunk nor a team-tree read (an hc spawn) is fetched.
    const before = coreLines()
    await page.waitForTimeout(1200)
    check(!(await chunkSeen(page)), `${scheme} ${width}: Chat alone fetches no renderer chunk`)
    if (process.env.FAKE_CORE_LOG) check(coreLines() === before, `${scheme} ${width}: Chat alone reads no team tree (no hc spawn)`)
    // Press Terminal in the DOM: the bench's notice mask would swallow a pointer click.
    await page.locator('.lb-face-part[data-face="terminal"]').evaluate(node => node.click())
    await page.locator('.cs-host').waitFor({ timeout: 20_000 }).catch(() => {})
    const screen = page.locator('.xterm-rows')
    await screen.waitFor({ timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(1200)
    const text = (await screen.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check(text.includes('bun test') && text.includes('3 pass, 0 fail'), `${scheme} ${width}: the pane draws the fake terminal`)
    check(!text.includes('real pane'), `${scheme} ${width}: only the fake pane's made-up output`)
    check(await chunkSeen(page), `${scheme} ${width}: pressing Terminal fetches the renderer chunk`)
    if (process.env.FAKE_CORE_LOG) check(coreLines() > before, `${scheme} ${width}: pressing Terminal reads the team tree`)
    const note = (await page.locator('.cs-pane-note').innerText().catch(() => '')).trim()
    check(note.includes('Watching'), `${scheme} ${width}: the pane says it watches (${note})`)
    check(await page.getByRole('button', { name: 'Refresh', exact: true }).count() === 0, `${scheme} ${width}: no stale Refresh button beside a tree read on open`)
    if (width !== 1440) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(1200)
    }
    const shot = join(outDir, `code-side-${width === 1440 ? 'desktop' : 'phone'}-${scheme}.png`)
    await page.screenshot({ path: shot })
    console.log(`shot ${shot}`)
    await context.close()
  }
}
await browser.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
