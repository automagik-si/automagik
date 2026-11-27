import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHttpsOpen, linkCredentialCheck, skillLinkOperation } from '../src/host/skill-fetch.js'
import { parseSkillLink, validLinkSource } from '../src/host/skill-link.js'
import { directLink, fakeRequest, publicResolver, response } from './fixtures/skill-link-fixtures.js'

const direct = new URL(directLink)
const fail = () => assert.fail('refused request reached transport')

test('link GET refuses local DNS answers, address literals and metadata without opening a connection', async () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '192.168.1.1', '169.254.1.1', '169.254.169.254', '168.63.129.16']) {
    const { linkGet } = skillLinkOperation({ resolve: async () => [{ address, family: 4 }], open: fail })
    await assert.rejects(linkGet(direct), { code: 'bot/invalid', reason: 'link-local' })
  }
  const { linkGet } = skillLinkOperation({ resolve: fail, open: fail })
  await assert.rejects(linkGet(new URL('https://127.0.0.1/SKILL.md')), { reason: 'link-address' })
  await assert.rejects(linkGet(new URL('https://metadata.goog/SKILL.md')), { reason: 'link-local' })
})

test('link GET refuses credentials before DNS, including percent-encoded tokens', async () => {
  const token = 'ghp_' + 'z'.repeat(36)
  const encoded = [...token].map(char => '%' + char.charCodeAt(0).toString(16)).join('')
  const { linkGet } = skillLinkOperation({ resolve: fail, open: fail })
  for (const url of ['https://user@automagik-si.example/', 'https://user:pass@automagik-si.example/',
    new URL('/' + token, direct), new URL('/' + encoded, direct)]) {
    await assert.rejects(linkGet(new URL(url)), { reason: 'link-credentials' })
  }
})

test('#2079 source admission preserves the context of a synthetic path assignment', () => {
  const pathOnly = { href: direct.href, pathname: '/AUTH_TOKEN=mock/SKILL.md', search: '' }
  assert.throws(() => linkCredentialCheck(pathOnly), { reason: 'link-credentials' })
  const url = new URL('/' + encodeURIComponent('AUTH_TOKEN=mock') + '/SKILL.md', direct)
  assert.throws(() => parseSkillLink(url.href), { reason: 'link-credentials' })
  assert.equal(validLinkSource({ kind: 'link', url: url.href, host: url.host, ref: null,
    revision: 'sha256:' + 'a'.repeat(64), fetchedAt: 1 }), false)
})

test('#2079 source admission refuses malformed path encoding before DNS', async () => {
  const url = new URL('/bad%XX/SKILL.md', direct)
  const { linkGet } = skillLinkOperation({ resolve: fail, open: fail })
  await assert.rejects(linkGet(url), { reason: 'link-credentials' })
})

test('link redirects readmit each hop and close every response', async () => {
  for (const [location, reason] of [['https://private.automagik-si.example/', 'link-local'],
    ['http://automagik-si.example/', 'link-scheme'], ['/SKILL.md?access=opaque', 'link-signed']]) {
    const redirected = response('', { status: 302, headers: { location } })
    let opened = 0
    const { linkGet } = skillLinkOperation({
      resolve: host => host === direct.hostname ? publicResolver() : [{ address: '10.0.0.1', family: 4 }],
      open: () => { assert.equal(++opened, 1); return redirected },
    })
    await assert.rejects(linkGet(direct), { reason })
    assert.equal(redirected.destroyed, true)
  }
  const responses = []
  const { linkGet } = skillLinkOperation({ resolve: publicResolver, open() {
    const next = response('', { status: 302, headers: { location: '/hop-' + responses.length } })
    responses.push(next)
    return next
  } })
  await assert.rejects(linkGet(direct), { reason: 'link-redirect-limit' })
  assert.equal(responses.length, 4)
  assert.ok(responses.every(result => result.destroyed))
})

test('link GET aborts an unresponsive open and destroys an oversized stream', async () => {
  const waiting = Promise.withResolvers()
  const clock = new AbortController()
  const { linkGet } = skillLinkOperation({ resolve: publicResolver, open: () => { waiting.resolve(); return new Promise(() => {}) },
    timeout: duration => duration === 10_000 ? clock.signal : new AbortController().signal })
  const request = linkGet(direct)
  await waiting.promise
  clock.abort()
  await assert.rejects(request, { reason: 'link-timeout' })
  const oversized = response(Buffer.alloc(5 * 1024 * 1024 + 1))
  await assert.rejects(skillLinkOperation({ resolve: publicResolver, open: () => oversized }).linkGet(direct), { reason: 'link-large' })
  assert.ok(oversized.destroyed)
})

test('token-gated links point to File or Folder and close their response', async () => {
  for (const status of [401, 403]) {
    const blocked = response('', { status })
    await assert.rejects(skillLinkOperation({ resolve: publicResolver, open: () => blocked }).linkGet(direct),
      { reason: 'link-sign-in', message: /use File or Folder/ })
    assert.ok(blocked.destroyed)
  }
})

test('TLS request writes only after the connected peer matches the pinned public DNS answer', async () => {
  for (const [peer, own] of [['127.0.0.1', false], ['140.82.112.4', false], ['140.82.112.3', true], ['140.82.112.3', false]]) {
    let writes = 0
    const open = createHttpsOpen({ request: fakeRequest(() => response('synthetic'), peer, options => {
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.servername, direct.hostname)
      assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'accept-encoding', 'user-agent'])
      options.lookup(direct.hostname, {}, (error, address, family) => {
        assert.ifError(error)
        assert.deepEqual([address, family], [peer, 4])
      })
      writes++
    }) })
    const { linkGet } = skillLinkOperation({ resolve: publicResolver, open,
      interfaces: () => own ? { fixture: [{ address: '::ffff:' + peer }] } : {} })
    if (own || peer !== '140.82.112.3') {
      await assert.rejects(linkGet(direct), { reason: 'link-local' })
      assert.equal(writes, 0)
    } else {
      assert.equal((await linkGet(direct)).bytes.toString(), 'synthetic')
      assert.equal(writes, 1)
    }
  }
})
