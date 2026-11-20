import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { install } from '../src/host/address-policy.js'
import { localRefusal, ownServerRefusal, schemeRefusal } from '../src/host/browser/address-policy.js'

const schemeMessage = 'Only web addresses open in the Bot browser.'
const ownMessage = "This address is Automagik's own server; the Bot browser never opens it."
const refusal = message => ({ code: 'ADDRESS_REFUSED', message })

test('browser schemes by request kind', () => {
  const web = ['http://example.test', 'https://example.test', 'about:blank', 'about:blank#fragment']
  const requestOnly = ['ws://example.test', 'wss://example.test', 'data:text/plain,ok',
    'blob:https://example.test/document', 'about:srcdoc']
  const neither = ['about:config', 'about:blank?x', 'file:///tmp/test', 'chrome://settings',
    'chrome-extension://extension/page', 'devtools://devtools/', 'filesystem:https://example.test/',
    'javascript:void(0)', 'view-source:https://example.test', 'ftp://example.test', 'not a URL']
  for (const [kind, allowed, denied] of [
    ['open', web, [...requestOnly, ...neither]],
    ['request', [...web, ...requestOnly], neither],
  ]) {
    for (const url of allowed) assert.equal(schemeRefusal(url, kind), undefined, `${kind}: ${url}`)
    for (const url of denied) assert.equal(schemeRefusal(url, kind), schemeMessage, `${kind}: ${url}`)
  }
  assert.deepEqual(localRefusal('not a URL', 'request'), refusal(schemeMessage))
})

test('the listener uses canonical IPs and effective ports', () => {
  const own = { listener: { host: '[::ffff:127.0.0.1]', port: 80, protocol: 'http:' } }
  for (const host of ['localhost', 'API.LOCALHOST.', '127.0.0.1', '127.5.6.7', '127.1',
    '[::1]', '[::ffff:127.0.0.2]', '0.0.0.0', '[::]']) {
    for (const protocol of ['http', 'ws']) {
      const url = `${protocol}://${host}/`
      assert.equal(ownServerRefusal(url, own), ownMessage, url)
    }
  }
  for (const url of ['https://localhost/', 'http://localhost:81/', 'ws://127.0.0.1:81/',
    'http://192.0.2.1/', 'http://[2001:db8::1]/', 'ftp://127.0.0.1:80/']) {
    assert.equal(ownServerRefusal(url, own), undefined, url)
  }

  const tls = { listener: { host: '2001:DB8:0:0:0:0:0:1', port: 443, protocol: 'https:' } }
  for (const url of ['https://[2001:db8::1]/', 'wss://[2001:db8::1]/', 'http://[2001:db8::1]:443/']) {
    assert.deepEqual(localRefusal(url, 'request', tls), refusal(ownMessage), url)
  }
  assert.equal(ownServerRefusal('https://[2001:db8::2]/', tls), undefined)
  assert.equal(ownServerRefusal('https://127.0.0.1/', tls), undefined)
  assert.equal(ownServerRefusal('http://[::ffff:192.0.2.1]:8080/', {
    listener: { host: '192.0.2.1', port: 8080 },
  }), ownMessage)
})

test('listener-port hostnames are refused without a lookup', () => {
  const own = { listener: { host: '192.0.2.1', port: 8080 } }
  const options = { lookup: () => assert.fail('The listener rule must not use DNS') }
  for (const name of ['no-answer.invalid', 'another-service.example', 'LOCALHOST.']) {
    assert.equal(ownServerRefusal(`http://${name}:8080/`, own, options), ownMessage)
    assert.equal(ownServerRefusal(`http://${name}:8081/`, own, options), undefined)
  }
  assert.equal(ownServerRefusal('http://192.0.2.2:8080/', own), undefined)
})

test('advertised root uses normalized origin and path segments', () => {
  const own = { advertised: new URL('https://PUBLIC.EXAMPLE.:9443/app/') }
  for (const url of ['https://public.example:9443/app', 'https://public.example:9443/app/',
    'wss://public.example:9443/app/nested/route', 'https://public.example:9443/other/../app?x=1',
    'https://public.example:9443/app%2fchild', 'https://public.example:9443/app%5Cchild']) {
    assert.equal(ownServerRefusal(url, own), ownMessage, url)
  }
  for (const url of ['https://public.example:9443/app2', 'https://public.example:9443/sibling',
    'https://public.example:9444/app', 'ws://public.example:9443/app', 'https://other.example:9443/app']) {
    assert.equal(ownServerRefusal(url, own), undefined, url)
  }
  assert.equal(ownServerRefusal('http://127.1.1.1:9443/sibling', {
    ...own, listener: { host: '127.0.0.1', port: 9443 },
  }), ownMessage)
  assert.equal(ownServerRefusal('https://other.example/anything', {
    advertised: new URL('https://other.example/'),
  }), ownMessage)
})

test('installed policy reads optional services as they bind, change and dispose', async () => {
  const callbacks = new Map()
  const rt = { ctx: { inject: ([name], callback) => callbacks.set(name, callback) } }
  install(rt)
  const inject = (name, service) => {
    let dispose
    callbacks.get(name)({ [name]: service, effect: setup => { dispose = setup() } })
    return dispose
  }
  const check = (url, kind = 'request') => rt.addressPolicy.local(url, kind)
  const own = 'http://127.0.0.1:40200/'
  const other = 'http://192.0.2.1:40200/'
  const publicRoot = 'https://public.example/app/'
  assert.equal(await check(own), undefined)
  assert.deepEqual(await check('file:///tmp/test', 'open'), refusal(schemeMessage))

  let host = '[fe80::1%eth0]'
  let port
  const stopListener = inject('webServer', {
    get port() { return port },
    get host() { return host },
    getOrigin() { assert.fail('The listener identity comes from its bound host and port') },
  })
  assert.equal(await check(own), undefined)
  port = 0
  assert.equal(await check(own), undefined)
  port = 40200
  assert.deepEqual(await check(other), refusal(ownMessage))
  assert.equal(await check('http://192.0.2.1:40201/'), undefined)

  let advertised = publicRoot
  const stopApp = inject('webApp', { getAdvertisedUrl: () => advertised })
  assert.deepEqual(await check(publicRoot), refusal(ownMessage))
  host = '127.0.0.1'
  assert.equal(await check(other), undefined)
  assert.deepEqual(await check(own), refusal(ownMessage))
  assert.deepEqual(await check(publicRoot), refusal(ownMessage))
  advertised = 'https://public.example/other/'
  assert.equal(await check(publicRoot), undefined)
  assert.deepEqual(await check(advertised), refusal(ownMessage))

  const stopReplacement = inject('webServer', {
    get port() { return 40200 },
    get host() { throw new Error('no host') },
  })
  stopListener()
  assert.deepEqual(await check(other), refusal(ownMessage))
  stopReplacement()
  assert.equal(await check(own), undefined)
  assert.deepEqual(await check(advertised), refusal(ownMessage))

  const stopNoPort = inject('webServer', {
    get port() { throw new Error('no port') },
    host: '127.0.0.1',
  })
  assert.equal(await check(own), undefined)
  assert.deepEqual(await check(advertised), refusal(ownMessage))
  const stopNoAppRoot = inject('webApp', { getAdvertisedUrl() { throw new Error('no root') } })
  stopApp()
  assert.equal(await check(advertised), undefined)
  stopNoAppRoot()
  stopNoPort()
})

test('installed policy keeps live address lists and their existing check contract', async () => {
  const rt = { ctx: {}, state: { prefs: { browserAllow: [], browserDeny: [] } } }
  install(rt)
  assert.deepEqual(rt.addressPolicy.lists(), { allow: [], deny: [] })
  assert.deepEqual(await rt.addressPolicy.check('http://dev.example/'), { allowed: true })
  rt.state.prefs.browserDeny = ['dev.example']
  assert.deepEqual(rt.addressPolicy.lists(), { allow: [], deny: ['dev.example'] })
  assert.equal((await rt.addressPolicy.check('http://dev.example/')).allowed, false)
  assert.equal(await rt.addressPolicy.local('http://dev.example/', 'open'), undefined)
  assert.deepEqual(await rt.addressPolicy.local('file:///tmp/test', 'open'), refusal(schemeMessage))
})

test('browser plugin passes the installed address policy through to its session', () => {
  const source = readFileSync(new URL('../src/host/browser-plugins.js', import.meta.url), 'utf8')
  assert.match(source, /addressPolicy:\s*rt\.addressPolicy\s*,/)
  assert.match(source, /openSession:\s*options\s*=>\s*\(options\.executablePath\s*\|\|\s*options\.connect\s*\?\s*openBotBrowser\(options\)/)
})

test('RFC amendment names the approved 2a and 2b split', () => {
  const source = readFileSync(new URL('../../../docs/rfcs/0002-browser-group-1-completion.md', import.meta.url), 'utf8')
  assert.match(source, /2a, browser navigation and request policy on launched Chrome/)
  assert.match(source, /2b, the remaining hosts and cases/)
  assert.match(source, /\*\*2a\.\*\* Browser\s+navigation and request policy on launched Chrome/)
  assert.match(source, /\*\*2b\.\*\*\s+Browser navigation and request policy, the remaining hosts and cases/)
})
