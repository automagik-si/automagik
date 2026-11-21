import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isAppLink, linkInArgs, parseDeepLink, registerSchemes, SCHEMES } from '../src/deeplink.js'

test('a connect link gives the Omni\'s address, cleaned, and whether it is encrypted', () => {
  assert.deepEqual(parseDeepLink('omni://connect?url=https%3A%2F%2Fomni.example.com'), { action: 'connect', url: 'https://omni.example.com', host: 'omni.example.com', secure: true })
  assert.deepEqual(parseDeepLink('omni://connect?url=https://omni.example.com/api/v2/'), { action: 'connect', url: 'https://omni.example.com', host: 'omni.example.com', secure: true })
  assert.deepEqual(parseDeepLink('omni://connect?url=https://example.com/omni/'), { action: 'connect', url: 'https://example.com/omni', host: 'example.com', secure: true })
  assert.equal(parseDeepLink('omni://connect?url=http://192.168.1.5:8882').secure, false)
  assert.deepEqual(parseDeepLink('omni:connect?url=https://omni.example.com').url, 'https://omni.example.com')
  assert.deepEqual(parseDeepLink('omni://open'), { action: 'open' })
})

test('a connect link from the Omni carries its one-time grant on to the page', () => {
  const grant = 'Zx81_kq-Pz0aBcD9eF12-_Qw'
  assert.deepEqual(parseDeepLink(`omni://connect?url=${encodeURIComponent('https://omni.example.com')}&grant=${grant}`), { action: 'connect', url: 'https://omni.example.com', host: 'omni.example.com', secure: true, grant })
  assert.equal('grant' in parseDeepLink('omni://connect?url=https://omni.example.com'), false)
  for (const bad of ['', 'short', `${grant}x`, `${grant.slice(0, 23)}.`, `${grant.slice(0, 23)}%20`]) {
    assert.equal(parseDeepLink(`omni://connect?url=https://omni.example.com&grant=${bad}`), null, bad)
  }
})

test('anything else is refused: other schemes, other actions, odd or credentialed addresses', () => {
  for (const bad of [
    'https://omni.example.com',
    'omni://connect',
    'omni://connect?url=',
    'omni://connect?url=javascript:alert(1)',
    'omni://connect?url=file:///etc/passwd',
    'omni://connect?url=https://user:pass@omni.example.com',
    'omni://delete?url=https://omni.example.com',
    'not a link',
  ]) assert.equal(parseDeepLink(bad), null, bad)
})

test('the link comes from the command line on Linux, among Electron\'s own arguments', () => {
  assert.equal(linkInArgs(['/usr/bin/omni-desktop', '--no-sandbox', 'omni://connect?url=https://a.example']), 'omni://connect?url=https://a.example')
  assert.equal(linkInArgs(['/usr/bin/omni-desktop']), null)
  assert.equal(linkInArgs(undefined), null)
})

test('isAppLink recognizes both app schemes on string arguments', () => {
  assert.equal(isAppLink('automagik://open'), true)
  assert.equal(isAppLink('omni:open'), true)
  assert.equal(isAppLink('https://example.com'), false)
  for (const arg of [undefined, null, 1, { toString: () => 'omni:open' }]) assert.equal(isAppLink(arg), false)
})

// RFC 0013 delivery 3: automagik:// is Automagik's own, omni:// its alias.
const SESSION = 'session-5273feee-7fa0-4cfc-a2b9-f0ae484ad60e'
const REGISTRY = 'b-k2m7qz4xha'

test('automagik://open and omni://open both bring the app forward, with or without a Bot', () => {
  for (const scheme of ['automagik', 'omni']) {
    assert.deepEqual(parseDeepLink(`${scheme}://open`), { action: 'open' }, scheme)
    assert.deepEqual(parseDeepLink(`${scheme}:open`), { action: 'open' }, scheme)
    assert.deepEqual(parseDeepLink(`${scheme}://open/`), { action: 'open' }, scheme)
    for (const bot of [SESSION, REGISTRY]) {
      assert.deepEqual(parseDeepLink(`${scheme}://open?bot=${bot}`), { action: 'open', bot }, `${scheme} ${bot}`)
    }
  }
  assert.deepEqual(parseDeepLink(`AUTOMAGIK://open?bot=${REGISTRY}`), { action: 'open', bot: REGISTRY })
})

test('a bot that is not a Bot id still opens the app, and selects nothing', () => {
  for (const bad of [
    '',
    'b-k2m7qz4xh', // 9 characters
    'b-k2m7qz4xhaa', // 11
    'b-k2m7qz4x18', // 1 and 8 are not base32
    'B-K2M7QZ4XHA',
    'session-5273feee-7fa0-1cfc-a2b9-f0ae484ad60e', // not a v4 uuid
    '5273feee-7fa0-4cfc-a2b9-f0ae484ad60e',
    `${SESSION}/../x`,
    `${SESSION}%0A`,
    `../${REGISTRY}`,
    'omni',
  ]) {
    for (const scheme of ['automagik', 'omni']) {
      assert.deepEqual(parseDeepLink(`${scheme}://open?bot=${bad}`), { action: 'open' }, `${scheme} ${bad}`)
    }
  }
  assert.deepEqual(parseDeepLink(`automagik://open?bot=${SESSION}&bot=${REGISTRY}`), { action: 'open', bot: SESSION })
})

test('automagik:// only opens: no connect, and nothing else', () => {
  for (const bad of [
    'automagik://connect?url=https://omni.example.com',
    `automagik://connect?url=https://omni.example.com&grant=${'a'.repeat(24)}`,
    'automagik://start?bot=b-k2m7qz4xha',
    'automagik://send?bot=b-k2m7qz4xha&text=hi',
    'automagik://',
    'automagik:',
    'automagik://open.evil',
    'automagikx://open',
    'magik://open',
  ]) assert.equal(parseDeepLink(bad), null, bad)
})

test('omni://connect means what it did: the alias changes nothing about it', () => {
  const grant = 'Zx81_kq-Pz0aBcD9eF12-_Qw'
  assert.deepEqual(parseDeepLink(`omni://connect?url=https://omni.example.com&grant=${grant}&bot=${REGISTRY}`),
    { action: 'connect', url: 'https://omni.example.com', host: 'omni.example.com', secure: true, grant })
  assert.equal(parseDeepLink('omni://connect?url=javascript:alert(1)'), null)
})

test('a second launch hands either scheme on from its command line', () => {
  assert.equal(linkInArgs(['C:\\Program Files\\Automagik\\Automagik.exe', '--', `automagik://open?bot=${REGISTRY}`]), `automagik://open?bot=${REGISTRY}`)
  assert.equal(linkInArgs(['/usr/bin/automagik', '--no-sandbox', 'omni://open']), 'omni://open')
  assert.equal(linkInArgs(['/usr/bin/automagik', '--automagik=1', 'automagic://open']), null)
})

test('the builder registers every scheme the app answers to', () => {
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  const installer = readFileSync(new URL('../assets/installer.nsh', import.meta.url), 'utf8')
  const listed = builder.slice(builder.indexOf('\nprotocols:'), builder.indexOf('\nafterPack:'))
  assert.match(builder, /\nnsis:\n {2}include: assets\/installer\.nsh\n/)
  for (const scheme of SCHEMES) {
    assert.match(listed, new RegExp(`\\n {6}- ${scheme}\\n`), `protocols lists ${scheme}`)
    assert.match(installer, new RegExp(`automagikRegisterScheme ${scheme}\\n`), `installer.nsh registers ${scheme}`)
    assert.match(installer, new RegExp(`automagikUnregisterScheme ${scheme}\\n`), `installer.nsh removes ${scheme}`)
  }
})

test('only a packaged app takes the schemes: a dev run would hand them to Electron', () => {
  const appOf = (isPackaged, refused = []) => {
    const calls = []
    return { calls, isPackaged, setAsDefaultProtocolClient: (...args) => (calls.push(args), !refused.includes(args[0])) }
  }
  const packaged = appOf(true)
  assert.deepEqual(registerSchemes(packaged), ['automagik', 'omni'])
  assert.deepEqual(packaged.calls, [['automagik'], ['omni']])
  const dev = appOf(false)
  assert.deepEqual(registerSchemes(dev), [])
  assert.deepEqual(dev.calls, [])
  assert.deepEqual(registerSchemes(appOf(true, ['omni'])), ['automagik'])
  assert.deepEqual(registerSchemes(undefined), [])
})
