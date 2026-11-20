import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { localRefusal } from '../src/host/browser/address-policy.js'
import { createSession, openBotBrowser } from '../src/host/browser/session.js'
import { nextContext, request, socket } from './fixtures/guard-order-playwright.mjs'

const playwrightUrl = new URL('./fixtures/guard-order-playwright.mjs', import.meta.url).href
const own = { listener: { host: '127.0.0.1', port: 41000 } }
const ownUrl = 'http://127.0.0.1:41000/'
const devUrl = 'http://127.0.0.1:41001/'
const schemeRefusal = { code: 'ADDRESS_REFUSED', message: 'Only web addresses open in the Bot browser.' }
const serverRefusal = { code: 'ADDRESS_REFUSED', message: "This address is Automagik's own server; the Bot browser never opens it." }
const addressPolicy = { local: (url, kind) => localRefusal(url, kind, own) }

function opener(t, urls = []) {
  const profileRoot = mkdtempSync(join(tmpdir(), 'bot-guard-order-'))
  const botId = 'bot'
  mkdirSync(join(profileRoot, botId))
  writeFileSync(join(profileRoot, botId, 'tabs.json'), JSON.stringify({ tabs: urls.map(url => ({ url })) }))
  let session
  t.after(async () => {
    await session?.close()
    rmSync(profileRoot, { recursive: true, force: true })
  })
  return async options => {
    session = await openBotBrowser({ botId, profileRoot, playwrightUrl, addressPolicy, ...options })
    return session
  }
}

test('both guards are ready before the first page and restore', async t => {
  const run = nextContext({ noInitialPage: true })
  const open = opener(t, [ownUrl, 'http://[', devUrl])
  const checks = []
  const session = await open({ addressPolicy: {
    local(url, kind) {
      const result = addressPolicy.local(url, kind)
      checks.push({ url, kind, result })
      return result
    },
    check(url) { checks.push({ url, kind: 'list' }); return { allowed: true } },
  } })
  assert.deepEqual(run.events.slice(0, 4), ['request guard', 'socket guard', 'pages', 'newPage'])
  assert.deepEqual(run.events.filter(event => event.startsWith('goto ')), [`goto ${devUrl}`])
  assert.deepEqual(checks, [
    { url: ownUrl, kind: 'open', result: serverRefusal },
    { url: 'http://[', kind: 'open', result: schemeRefusal },
    { url: devUrl, kind: 'open', result: undefined },
    { url: devUrl, kind: 'list' },
    { url: devUrl, kind: 'request', result: undefined },
    { url: devUrl, kind: 'list' },
  ])
  assert.equal(session.url(), devUrl)
  assert.deepEqual(await socket(run, ownUrl.replace('http:', 'ws:')), ['close'])
  assert.deepEqual(await socket(run, devUrl.replace('http:', 'ws:')), ['connect'])
})

for (const transport of ['http', 'socket']) {
  for (const [mode, message] of [['missing', /routing is unavailable/], ['throw', /registration threw/], ['reject', /registration rejected/]]) {
    test(`${transport} guard registration ${mode} closes the context and permits a retry`, async t => {
      const open = opener(t)
      const failed = nextContext({ [transport]: mode })
      await assert.rejects(open(), message)
      assert.ok(!failed.events.includes('pages'))
      assert.equal(failed.events.at(-1), 'close')
      const next = nextContext()
      assert.equal((await open()).url(), 'about:blank')
      assert.deepEqual(next.events.slice(0, 3), ['request guard', 'socket guard', 'pages'])
    })
  }
}

test('relay registration failure disconnects and preserves the context, and relay skips socket routing', async t => {
  const open = opener(t)
  const relay = { connect: async () => 'ws://relay.invalid/' }
  const failed = nextContext({ http: 'reject' })
  await assert.rejects(open(relay), /registration rejected/)
  assert.equal(failed.disconnected, true)
  assert.deepEqual(failed.events, [])
  const next = nextContext({ socket: 'throw', initialUrl: devUrl })
  assert.equal((await open(relay)).url(), devUrl)
  assert.deepEqual(next.events.slice(0, 3), [`goto ${devUrl}`, 'request guard', 'pages'])
})

test('an already-open page is handed over only after guard registration', async t => {
  const run = nextContext({ initialUrl: devUrl })
  const session = await opener(t, [ownUrl])()
  assert.deepEqual(run.events.slice(0, 4), [`goto ${devUrl}`, 'request guard', 'socket guard', 'pages'])
  assert.equal(session.url(), devUrl)
})

test('a top-level refusal during restore is not reported on the next action', async t => {
  nextContext()
  const session = await opener(t, [ownUrl])({ addressPolicy: {
    local: (url, kind) => kind === 'request' ? localRefusal(url, kind, own) : undefined,
  } })
  assert.equal(session.url(), 'about:blank')
  assert.match(await session.open(devUrl), /Fake page/)
})

test('background refusals do not affect a successful open, and a top-level refusal is reported', async t => {
  const run = nextContext()
  const session = await opener(t)({ addressPolicy: {
    local(url, kind) {
      if (url.endsWith('/exception')) throw new Error('policy unavailable')
      return addressPolicy.local(url, kind)
    },
    check(url) {
      if (url === devUrl) throw new Error('list unavailable')
      return { allowed: true }
    },
  } })
  const page = run.context.pages()[0]
  const subframe = { page: () => page }
  const noFrame = () => { throw new Error('no frame') }
  const [opened, ...blocked] = await Promise.all([
    session.open(devUrl),
    request(run.context, { url: ownUrl, navigation: true, frame: () => subframe }),
    request(run.context, { url: ownUrl, frame: noFrame }),
    request(run.context, { url: ownUrl, navigation: true, frame: noFrame }),
    request(run.context, { url: `${ownUrl}exception`, navigation: true, frame: page.mainFrame }),
  ])
  assert.match(opened, /Fake page/)
  assert.deepEqual(blocked, Array(4).fill(['blockedbyclient']))
  assert.deepEqual(await socket(run, devUrl.replace('http:', 'ws:') + 'exception'), ['close'])
  page.backTo = ownUrl
  await assert.rejects(session.back(), serverRefusal)
  await assert.rejects(session.open(ownUrl), serverRefusal)
  assert.equal(session.url(), devUrl)
})

test('request guard checks local policy first and lists only for top-level navigation', async t => {
  const run = nextContext()
  const checked = []
  await opener(t)({ addressPolicy: {
    local: addressPolicy.local,
    check(url) { checked.push(url); return { allowed: false, message: 'List refused' } },
  } })
  const page = run.context.pages()[0]
  const subframe = { page: () => page }
  assert.deepEqual(await request(run.context, { url: devUrl, navigation: true, frame: () => subframe }), ['continue'])
  assert.deepEqual(await request(run.context, { url: ownUrl, navigation: true, frame: () => page.mainFrame() }), ['blockedbyclient'])
  assert.deepEqual(checked, [])
  assert.deepEqual(await request(run.context, { url: devUrl, navigation: true, frame: () => page.mainFrame() }), ['blockedbyclient'])
  assert.deepEqual(checked, [devUrl])
})

test('check-only policy still refuses non-web routed requests', async t => {
  const run = nextContext()
  await opener(t)({ addressPolicy: { check: () => ({ allowed: true }) } })
  assert.deepEqual(await request(run.context, { url: 'file:///tmp/test' }), ['blockedbyclient'])
  assert.deepEqual(await request(run.context, { url: devUrl }), ['continue'])
})

test('check-only open keeps blank pages and web addresses, and refuses other direct opens', async t => {
  nextContext()
  const session = await opener(t)({ addressPolicy: { check: async () => ({ allowed: true }) } })
  assert.equal(session.url(), 'about:blank')
  for (const url of [devUrl, 'https://localhost/', 'about:blank', 'about:blank#fragment']) {
    await session.open(url)
    assert.equal(session.url(), url)
  }
  for (const url of ['data:text/plain,ok', 'about:srcdoc', 'about:config', 'file:///tmp/test']) {
    await assert.rejects(session.open(url), schemeRefusal)
  }
})

test('direct session construction stays synchronous when route registration rejects', async () => {
  const session = createSession({ context: {
    pages: () => [], on() {}, route: () => Promise.reject(new Error('registration rejected')),
  } })
  assert.equal(typeof session.open, 'function')
  await session.addressReady
})

test('direct session construction stays synchronous when route registration throws or is absent', async () => {
  for (const route of [undefined, () => { throw new Error('registration threw') }]) {
    const session = createSession({ context: { pages: () => [], on() {}, route } })
    assert.equal(typeof session.open, 'function')
    await session.addressReady
  }
})
