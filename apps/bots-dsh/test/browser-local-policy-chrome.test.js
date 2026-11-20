import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { install } from '../src/host/address-policy.js'
import { openBotBrowser } from '../src/host/browser/session.js'
import { browserGuard } from './browser-guard.js'
import { devPage, probePage, probeUrl, socketUrl, workerScript } from './fixtures/local-policy-pages.mjs'

const playwrightUrl = new URL('./fixtures/observed-chromium.mjs', import.meta.url).href
const ownRefusal = { code: 'ADDRESS_REFUSED', message: "This address is Automagik's own server; the Bot browser never opens it." }
const schemeRefusal = { code: 'ADDRESS_REFUSED', message: 'Only web addresses open in the Bot browser.' }
const badSavedUrl = 'http://['

async function loopback(t, page) {
  const httpHits = [], upgrades = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    httpHits.push(url.searchParams.get('actor'))
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': url.pathname === '/worker' ? 'text/javascript' : 'text/html',
    })
    response.end(page(url))
  })
  const ws = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    upgrades.push(url.searchParams.get('actor'))
    ws.handleUpgrade(request, socket, head, () => {})
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate()
    ws.close()
    await new Promise(resolve => server.close(resolve))
  })
  const { port } = server.address()
  return { port, url: `http://127.0.0.1:${port}`, httpHits, upgrades }
}

function policyFor(own, enabled, refusals) {
  const service = {
    host: '127.0.0.1', port: own.port, protocol: 'http:', getOrigin: () => own.url,
  }
  const rt = { ctx: {
    inject([name], run) {
      if (name === 'webServer') run({ webServer: service, effect: setup => setup() })
    },
  } }
  install(rt)
  return { async local(url, kind) {
    const refusal = enabled ? await rt.addressPolicy.local(url, kind) : undefined
    if (refusal) refusals.push({ url, kind, refusal })
    return refusal
  } }
}

async function scenario(t, executablePath, enabled) {
  const urls = {}
  const own = await loopback(t, url => probePage(url, 'own', urls.dev))
  const dev = await loopback(t, url => url.pathname === '/worker' ? workerScript : devPage(url, urls))
  const frame = await loopback(t, url => devPage(url, urls))
  Object.assign(urls, { own: own.url, dev: dev.url, frame: frame.url })
  const profileRoot = await mkdtemp(join(tmpdir(), 'bot-local-policy-chrome-'))
  const botId = 'browser'
  const refusals = []
  let session
  try {
    if (enabled) {
      await mkdir(join(profileRoot, botId))
      await writeFile(join(profileRoot, botId, 'tabs.json'), JSON.stringify({ tabs: [{ url: badSavedUrl }] }))
    }
    session = await openBotBrowser({
      botId, profileRoot, playwrightUrl, executablePath, addressPolicy: policyFor(own, enabled, refusals),
    })
    if (enabled) {
      assert.equal(session.url(), 'about:blank')
      assert.deepEqual(refusals.find(({ url, kind }) => url === badSavedUrl && kind === 'open')?.refusal, schemeRefusal)
      await assert.rejects(session.open('file:///tmp/browser-local-policy'), schemeRefusal)
      await assert.rejects(session.open(probeUrl(own.url, 'open')), ownRefusal)
      assert.deepEqual(own.httpHits, [])
    }
    await session.open(dev.url)
    const { observed: { context, failed } } = await import(playwrightUrl)
    const page = context.pages()[0]
    await page.evaluate(() => window.startProbes())

    const topUrl = probeUrl(own.url, 'top')
    const childUrl = probeUrl(own.url, 'child')
    if (enabled) {
      await Promise.all([expectFailed(context, failed, topUrl), expectFailed(context, failed, childUrl)])
      assertRefused(refusals, topUrl)
      await page.evaluate(() => window.postMessage({ actor: 'top', kind: 'navigation', side: 'own', succeeded: false }, location.origin))
    }

    await page.waitForFunction(() => window.outcomes.length >= 7)
    const outcomes = await page.evaluate(() => window.outcomes)
    for (const actor of ['page', 'frame', 'worker', 'top']) {
      const url = probeUrl(own.url, actor)
      assert.equal(own.httpHits.includes(actor), !enabled, `${actor} own HTTP hit`)
      assert.ok(dev.httpHits.includes(actor), `${actor} dev HTTP hit`)
      if (enabled) assertRefused(refusals, url)
      if (actor === 'top') {
        assert.deepEqual(outcomes.filter(item => item.actor === actor).map(item => [item.side, item.succeeded]).sort(),
          [['dev', true], ['own', !enabled]])
      } else {
        assert.deepEqual(outcomes.find(item => item.actor === actor && item.kind === 'fetch'),
          { actor, kind: 'fetch', own: !enabled, dev: true })
      }
    }
    for (const actor of ['page', 'frame']) {
      assert.equal(own.upgrades.includes(actor), !enabled, `${actor} own WebSocket upgrade`)
      assert.ok(dev.upgrades.includes(actor), `${actor} dev WebSocket upgrade`)
      if (enabled) assertRefused(refusals, socketUrl(own.url, actor))
      assert.deepEqual(outcomes.find(item => item.actor === actor && item.kind === 'socket'),
        { actor, kind: 'socket', own: !enabled, dev: true })
    }
    if (enabled) {
      assertRefused(refusals, childUrl)
      assert.deepEqual(own.httpHits, [])
      assert.deepEqual(own.upgrades, [])
    } else {
      assert.ok(own.httpHits.includes('child'))
      assert.deepEqual(refusals, [])
    }
  } finally {
    await session?.close()
    await rm(profileRoot, { recursive: true, force: true })
  }
}

function assertRefused(refusals, url) {
  assert.deepEqual(refusals.find(item => item.url === url && item.kind === 'request')?.refusal, ownRefusal, url)
}

async function expectFailed(context, failed, url) {
  if (!failed.some(item => item.url === url)) {
    await context.waitForEvent('requestfailed', { predicate: request => request.url() === url, timeout: 5000 })
  }
  assert.equal(failed.find(item => item.url === url)?.error, 'net::ERR_BLOCKED_BY_CLIENT', url)
}

test('browser navigation and request policy on launched Chrome', { timeout: 60_000 }, async t => {
  const { skip, executablePath } = await browserGuard()
  if (skip) return t.skip(skip)
  await t.test('policy enabled', t => scenario(t, executablePath, true))
  await t.test('policy disabled control', t => scenario(t, executablePath, false))
})
