// A Bot browser going away mid-load or mid-write must never fail the host. DSH turns every
// unhandled rejection into a fatal exit, so promises the session keeps for later (a new tab's
// load wait, a write's tracked requests) have to be caught inside the session (#1577).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSession } from '../src/host/browser/session.js'

const turns = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function fakePage({ loadRejects = false, clickFailsRequest = false } = {}) {
  const page = new EventEmitter()
  Object.assign(page, {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    isClosed: () => false,
    url: () => 'https://example.test/form',
    title: async () => 'Form',
    ariaSnapshot: async () => '- document',
    mainFrame: () => null,
    // A crashed renderer rejects the load-state waiter while the page is still not closed.
    waitForLoadState: async () => { if (loadRejects) throw new Error('Navigation failed because page crashed!') },
    locator: () => ({
      count: async () => 1,
      evaluate: async () => ({ kind: 'submit', label: 'Send', origin: 'https://example.test', host: 'example.test' }),
      getAttribute: async () => null,
      click: async () => {
        if (!clickFailsRequest) return
        // The write's POST starts and fails, then the click itself fails because the page went away.
        const request = { url: () => 'https://example.test/api', method: () => 'POST', failure: () => ({ errorText: 'net::ERR_ABORTED' }) }
        page.emit('request', request)
        page.emit('requestfailed', request)
        throw new Error('locator.click: Target page, context or browser has been closed')
      },
    }),
  })
  return page
}

function fakeContext(pages) {
  const context = new EventEmitter()
  Object.assign(context, {
    pages: () => pages,
    route: async () => {},
    unroute: async () => {},
    cookies: async () => [],
    close: async () => {},
  })
  return context
}

function watch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-session-teardown-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const unhandled = []
  const onUnhandled = reason => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  return { cookieFile: join(dir, 'cookies.json'), unhandled }
}

test('a new tab that crashes while loading, with no action pending, never leaves an unhandled rejection', async t => {
  const { cookieFile, unhandled } = watch(t)
  const first = fakePage()
  const context = fakeContext([first])
  const session = createSession({ context, page: first, cookieFile, actionTimeout: 1000 })
  await turns()

  context.emit('page', fakePage({ loadRejects: true }))
  await turns()

  assert.deepEqual(unhandled.map(reason => reason?.message), [])
  await session.close()
})

test('a write request that fails after the click threw never leaves an unhandled rejection', async t => {
  const { cookieFile, unhandled } = watch(t)
  const first = fakePage({ clickFailsRequest: true })
  const context = fakeContext([first])
  const session = createSession({ context, page: first, cookieFile, actionTimeout: 1000 })
  await turns()

  const result = await session.click('e1')
  await turns()

  assert.ok(result, 'the click still reports its unknown result')
  assert.deepEqual(unhandled.map(reason => reason?.message), [])
  await session.close()
})
