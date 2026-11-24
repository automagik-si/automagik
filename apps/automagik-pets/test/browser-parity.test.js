// The headless bake against the browser's: one look baked by the Bot team's own canvas code
// (pet-bake.js bakeBlobs) in Chromium, with the light theme's ink variables on the page as
// styles.js sets them, and by automagik-pets. Chromium resolves the inks and color-mix itself,
// so this proves resolveInks gives the colors the browser paints. Skipped, and said so, when
// playwright-core (apps/bots-dsh's dependency) or its Chromium is not installed.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { bakeMarkup } from '../../bots-dsh/src/client/characters.js'
import { INKS } from '../../bots-dsh/src/client/inks.js'
import { cellPlan, cellSvg, lookParts, resolveInks } from '../src/art.js'
import { renderCell } from '../src/bake.js'

const BOTS = fileURLToPath(new URL('../../bots-dsh/', import.meta.url))
const LOOK = { character: 'kitty', colour: 'blue' }

async function launch() {
  try {
    const require = createRequire(join(BOTS, 'package.json'))
    const { chromium } = require('playwright-core')
    const { build } = require('esbuild')
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, args: ['--force-color-profile=srgb'] })
    return { browser, build }
  } catch (error) {
    return { reason: error.message.split('\n')[0] }
  }
}
const { browser, build, reason } = await launch()
const skip = browser ? false : `no Chromium for the parity check (${reason})`

async function pageWithBake() {
  const bundle = await build({
    stdin: { contents: "export { bakeBlobs } from './src/client/pet-bake.js'", resolveDir: BOTS },
    bundle: true, format: 'iife', globalName: 'PetBake', platform: 'browser', write: false, logLevel: 'silent',
    plugins: [{ name: 'no-react', setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const createElement = () => null, useEffect = () => {}, useRef = () => ({}), useState = v => [v, () => {}]', loader: 'js' }))
    } }],
  })
  const page = await browser.newPage()
  // The light theme's inks, as styles.js puts them on body.
  const vars = Object.entries(INKS).map(([name, [light]]) => `--bt-ink-${name}:${light}`).join(';')
  await page.setContent(`<!doctype html><style>body{${vars}}</style><body></body>`)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  return page
}
const rgbOf = text => text.match(/[\d.]+/g).slice(0, 3).map(Number)

test('the gradient stops resolve to the colors Chromium computes', { skip }, async (t) => {
  const page = await pageWithBake()
  t.after(() => page.close())
  const raw = [...bakeMarkup(LOOK.character, LOOK.colour).body.matchAll(/stop-color:([^"]+)"/g)].map(match => match[1])
  assert.equal(raw.length, 3)
  const computed = await page.evaluate(values => values.map((value) => {
    const probe = document.createElement('i')
    probe.style.color = value
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }), raw)
  // Chromium gives color-mix as color(srgb r g b) in 0-1 and a plain color as rgb() in 0-255.
  const browserRgb = computed.map(text => (text.startsWith('color(') ? rgbOf(text.slice(11)).map(value => value * 255) : rgbOf(text)))
  const ours = raw.map(value => resolveInks(value)).map(hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)))
  for (const [index, rgb] of ours.entries()) {
    for (const [channel, value] of rgb.entries()) assert.ok(Math.abs(value - browserRgb[index][channel]) <= 0.5, `stop ${index} ${raw[index]}: ours ${rgb}, Chromium ${computed[index]}`)
  }
})

test("the neutral cell's fill matches the browser bake", { skip }, async (t) => {
  const page = await pageWithBake()
  t.after(() => page.close())
  const sheet = Buffer.from(await page.evaluate(async (look) => {
    const { sheet } = await globalThis.PetBake.bakeBlobs({ shape: look.character, color: look.colour }, 1)
    const bytes = new Uint8Array(await sheet.arrayBuffer())
    let text = ''
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    return btoa(text)
  }, LOOK), 'base64')
  const neutral = cellPlan().find(cell => cell.name === 'neutral-0')
  const browserCell = await sharp(sheet).extract({ left: neutral.column * 192, top: neutral.row * 208, width: 192, height: 208 }).ensureAlpha().raw().toBuffer()
  const oursCell = await renderCell(cellSvg(lookParts(LOOK), neutral.pose))
  // The body's own fill, inside the silhouette where no layer edge falls: the browser's lossy
  // WebP and its raster scaling move a channel by a few units at most.
  const at = (bytes, x, y) => [...bytes.subarray((y * 192 + x) * 4, (y * 192 + x) * 4 + 4)]
  const samples = [[70, 150], [96, 170], [120, 150], [96, 110]]
  for (const [x, y] of samples) {
    const [a, b] = [at(browserCell, x, y), at(oursCell, x, y)]
    assert.equal(a[3], 255, `browser pixel ${x},${y} is inside the body`)
    for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(a[channel] - b[channel]) <= 4, `pixel ${x},${y}: browser ${a}, ours ${b}`)
  }
  // And over whole cells: the rest pose, and posed ones that use every term of the move (a
  // hop and squash, a tilt, the gaze and the body's turn, the sad face looking down), so the
  // transform order and the face's offset match drawCell's, not only the colors.
  const parts = lookParts(LOOK)
  for (const name of ['neutral-0', 'jumping-2', 'waving-1', 'look-12', 'failed-3', 'running-right-1']) {
    const cell = cellPlan().find(entry => entry.name === name)
    const browserPixels = await sharp(sheet).extract({ left: cell.column * 192, top: cell.row * 208, width: 192, height: 208 }).ensureAlpha().raw().toBuffer()
    const ourPixels = await renderCell(cellSvg(parts, cell.pose))
    let total = 0
    for (let index = 0; index < browserPixels.length; index += 1) total += Math.abs(browserPixels[index] - ourPixels[index])
    const mean = total / browserPixels.length
    t.diagnostic(`${name}: mean channel difference ${mean.toFixed(2)}`)
    assert.ok(mean < 3, `${name}: mean channel difference ${mean.toFixed(2)}`)
  }
})

// A Solver goes through the same two bakes with no path of its own: Cap, whose spots are a
// decal over the body, so the feet, the big eyes and a paint layer are all in the cells.
test('a Solver bakes the same headless as in the browser', { skip }, async (t) => {
  const solver = { character: 'cap', colour: 'red' }
  const page = await pageWithBake()
  t.after(() => page.close())
  const sheet = Buffer.from(await page.evaluate(async (look) => {
    const { sheet } = await globalThis.PetBake.bakeBlobs({ shape: look.character, color: look.colour }, 1)
    const bytes = new Uint8Array(await sheet.arrayBuffer())
    let text = ''
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    return btoa(text)
  }, solver), 'base64')
  const parts = lookParts(solver)
  for (const name of ['neutral-0', 'jumping-2', 'waving-1', 'look-12', 'failed-3', 'running-right-1']) {
    const cell = cellPlan().find(entry => entry.name === name)
    const browserPixels = await sharp(sheet).extract({ left: cell.column * 192, top: cell.row * 208, width: 192, height: 208 }).ensureAlpha().raw().toBuffer()
    const ourPixels = await renderCell(cellSvg(parts, cell.pose))
    let total = 0
    let painted = 0
    for (let index = 0; index < browserPixels.length; index += 1) total += Math.abs(browserPixels[index] - ourPixels[index])
    for (let index = 3; index < ourPixels.length; index += 4) painted += ourPixels[index] === 255 ? 1 : 0
    const mean = total / browserPixels.length
    t.diagnostic(`${name}: mean channel difference ${mean.toFixed(2)}`)
    assert.ok(painted > 3000, `${name}: the cell holds the character (${painted} opaque pixels)`)
    assert.ok(mean < 3, `${name}: mean channel difference ${mean.toFixed(2)}`)
  }
})

test.after(() => browser?.close())
