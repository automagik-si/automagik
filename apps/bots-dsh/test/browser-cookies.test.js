import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { openBotBrowser } from '../src/host/browser/session.js'
import { chromium } from './fixtures/fake-playwright.mjs'

const botId = 'bot-1'
const playwrightUrl = new URL('./fixtures/fake-playwright.mjs', import.meta.url).href
const launchFake = chromium.launchPersistentContext
const missing = path => assert.rejects(access(path), { code: 'ENOENT' })

async function scratchProfile(t) {
  const profileRoot = await mkdtemp(join(tmpdir(), 'bot-browser-cookies-'))
  const userDataDir = join(profileRoot, botId)
  const legacyFile = join(userDataDir, 'cookies.json')
  const sessions = []
  t.after(async () => {
    try {
      for (const session of sessions) {
        if (!session.closed) await session.close()
      }
    } finally {
      await rm(profileRoot, { recursive: true, force: true })
    }
  })
  await mkdir(userDataDir)
  return {
    profileRoot, userDataDir, legacyFile,
    async open(options) {
      const session = await openBotBrowser({ botId, profileRoot, playwrightUrl, ...options })
      sessions.push(session)
      return session
    },
  }
}

for (const host of ['launched Chrome', 'app relay']) {
  test(`${host} removes only the legacy cookie file before opening`, async t => {
    const profile = await scratchProfile(t)
    const nativeFile = join(profile.userDataDir, 'Default', 'Cookies')
    const tabsFile = join(profile.userDataDir, 'tabs.json')
    const tabs = '{"tabs":[{"url":"https://example.invalid/","title":"Saved tab"}],"active":0}\n'
    await mkdir(join(profile.userDataDir, 'Default'))
    await writeFile(nativeFile, 'browser-owned cookies')
    await writeFile(tabsFile, tabs)
    await writeFile(profile.legacyFile, JSON.stringify([{ name: 'old', value: 'fake' }]))

    const context = await launchFake()
    const addCookies = t.mock.method(context, 'addCookies')
    const contextClose = t.mock.method(context, 'close')
    const launch = t.mock.method(chromium, 'launchPersistentContext', async dir => {
      assert.equal(dir, profile.userDataDir)
      await missing(profile.legacyFile)
      return context
    })
    const relay = new EventEmitter()
    relay.contexts = () => [context]
    relay.close = t.mock.fn(async () => { relay.emit('disconnected') })
    const connectOverCDP = t.mock.method(chromium, 'connectOverCDP', async endpoint => {
      assert.equal(endpoint, 'fake-relay')
      return relay
    })
    const connect = t.mock.fn(async id => {
      assert.equal(id, botId)
      await missing(profile.legacyFile)
      return 'fake-relay'
    })
    const session = await profile.open({ connect: host === 'app relay' ? connect : undefined })
    await session.close()

    const usesRelay = host === 'app relay'
    assert.equal(launch.mock.callCount(), usesRelay ? 0 : 1)
    assert.equal(connect.mock.callCount(), usesRelay ? 1 : 0)
    assert.equal(connectOverCDP.mock.callCount(), usesRelay ? 1 : 0)
    assert.equal(relay.close.mock.callCount(), usesRelay ? 1 : 0)
    assert.equal(contextClose.mock.callCount(), usesRelay ? 0 : 1)
    assert.equal(addCookies.mock.callCount(), 0)
    await missing(profile.legacyFile)
    assert.equal(await readFile(nativeFile, 'utf8'), 'browser-owned cookies')
    assert.equal(await readFile(tabsFile, 'utf8'), tabs)
  })
}

test('a directory named cookies.json and its contents survive open', async t => {
  const profile = await scratchProfile(t)
  const child = join(profile.legacyFile, 'keep')
  await mkdir(profile.legacyFile)
  await writeFile(child, 'keep me')
  const session = await profile.open()
  await session.close()
  assert.equal(await readFile(child, 'utf8'), 'keep me')
})

test('a cookies.json symlink is removed and its target survives', async t => {
  const profile = await scratchProfile(t)
  const target = join(profile.profileRoot, 'keep')
  await writeFile(target, 'keep me')
  await symlink(target, profile.legacyFile)
  const session = await profile.open()
  await session.close()
  await missing(profile.legacyFile)
  assert.equal(await readFile(target, 'utf8'), 'keep me')
})

test('Chrome closes without reading cookies and reopens with its own persistent sign-in', async t => {
  const profile = await scratchProfile(t)
  const persistent = { name: 'sign-in', value: 'fake', expires: Math.floor(Date.now() / 1000) + 3600 }
  const temporary = { name: 'session', value: 'fake', expires: -1 }
  const fakeProfiles = new Map()
  const launches = []
  t.mock.method(chromium, 'launchPersistentContext', async dir => {
    const context = await launchFake()
    const cookies = [...(fakeProfiles.get(dir) ?? [])]
    const readCookies = t.mock.method(context, 'cookies', async () => cookies)
    const addCookies = t.mock.method(context, 'addCookies')
    const closeContext = context.close
    const close = t.mock.method(context, 'close', async () => {
      fakeProfiles.set(dir, cookies.filter(cookie => cookie.expires > 0))
      await closeContext()
    })
    launches.push({ cookies, readCookies, addCookies, close })
    return context
  })

  const first = await profile.open()
  const original = launches[0]
  original.cookies.push(persistent, temporary)
  await missing(profile.legacyFile)
  await first.close()
  assert.equal(original.readCookies.mock.callCount(), 0)
  assert.equal(original.addCookies.mock.callCount(), 0)
  assert.equal(original.close.mock.callCount(), 1)
  assert.equal(temporary.expires, -1)
  await missing(profile.legacyFile)

  const second = await profile.open()
  const reopened = launches[1]
  assert.deepEqual(reopened.cookies, [persistent])
  await missing(profile.legacyFile)
  await second.close()
  assert.equal(reopened.addCookies.mock.callCount(), 0)
  assert.equal(reopened.readCookies.mock.callCount(), 0)
  assert.equal(reopened.close.mock.callCount(), 1)
  await missing(profile.legacyFile)
})

test('dropping a Bot removes its browser profile and preserves the other profiles', async t => {
  const { profileRoot, userDataDir } = await scratchProfile(t)
  const nativeFile = join(userDataDir, 'Default', 'Cookies')
  const otherBot = join(profileRoot, 'bot-2')
  await mkdir(join(userDataDir, 'Default'))
  await writeFile(nativeFile, 'browser-owned cookies')
  await mkdir(otherBot)
  const api = {}
  mountBrowserPlugin({ effect() {} }, { toolDefs: [], profileRoot, headless: true, api })

  await api.drop(botId)

  await missing(userDataDir)
  await access(otherBot)
})

test('app relay closes without reading or changing cookie lifetimes', async t => {
  const profile = await scratchProfile(t)
  const cookies = [
    { name: 'persistent', value: 'sign-in', expires: 2_000_000_000 },
    { name: 'session', value: 'temporary', expires: -1 },
  ]
  const original = structuredClone(cookies)
  const context = await launchFake()
  const readCookies = t.mock.method(context, 'cookies', async () => cookies)
  const addCookies = t.mock.method(context, 'addCookies')
  const relay = new EventEmitter()
  relay.contexts = () => [context]
  relay.close = t.mock.fn(async () => { relay.emit('disconnected') })
  t.mock.method(chromium, 'connectOverCDP', async () => relay)

  const session = await profile.open({ connect: async () => 'fake-relay' })
  await session.close()

  assert.equal(readCookies.mock.callCount(), 0)
  assert.equal(addCookies.mock.callCount(), 0)
  assert.deepEqual(cookies, original)
  assert.equal(relay.close.mock.callCount(), 1)
  await missing(profile.legacyFile)
})
