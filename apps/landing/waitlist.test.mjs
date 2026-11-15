import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { onRequest as formFunction, networkPrefix } from './functions/api/waitlist.js'
import { onRequest as confirmFunction } from './functions/api/waitlist/whatsapp-confirm.js'
import { onRequest as emailLinkFunction } from './functions/api/waitlist/email-confirm.js'
import { codePattern, CONSENT_VERSION, constantEqual, hash, now, WHATSAPP_BACKLOG_SECONDS, WHATSAPP_SIGNUPS_OPEN } from './waitlist/lib/shared.js'
import { fixture } from './waitlist/d1-fixture.mjs'

const origin = 'https://automagik.si'
// The site's pages are indexable; the waitlist's answers never are. Every response a test
// receives from the three functions goes through this check: the header on all of them,
// and the robots meta too on every HTML answer.
const kinds = new Set()
const outOfSearch = handler => async context => {
  const response = await handler(context), type = response.headers.get('content-type') ?? ''
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', `${context.request.method} ${context.request.url} answered ${response.status} without X-Robots-Tag`)
  if (type.startsWith('text/html')) assert.match(await response.clone().text(), /<head>(?:(?!<\/head>).)*<meta name="robots" content="noindex, nofollow">/s, `${context.request.url} answered ${response.status} without the robots meta`)
  kinds.add(type.split(';')[0] || 'empty')
  return response
}
const form = outOfSearch(formFunction), confirm = outOfSearch(confirmFunction), emailLink = outOfSearch(emailLinkFunction)
const fields = { action: 'add', goal: 'Organise my project reports', platform: 'both', apps: 'My editor', expected_result: 'A report I can review', language: 'en', channel: 'email', email: 'demo@example.com', consent: 'yes' }
function post(env, values = {}, options = {}) {
  const request = new Request(origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.1', ...options.headers }, body: new URLSearchParams({ ...fields, ...values }) })
  return form({ request, env })
}
async function callback(env, body, { auth = `Bearer ${env.WAITLIST_CONFIRM_SECRET}`, method = 'POST', type = 'application/json', raw, protocol = 'https:' } = {}) {
  return confirm({ env, request: new Request(origin.replace('https:', protocol) + '/api/waitlist/whatsapp-confirm', { method, headers: { 'Content-Type': type, Authorization: auth, 'X-Omni-Event-Id': 'fixture-event' }, ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }) }) })
}
const event = (code, from = '15555550100@s.whatsapp.net', messageId = 'fixture-message') => ({
  id: 'fixture-event', type: 'message.received', timestamp: Date.now(), metadata: {},
  payload: { externalId: messageId, from, senderName: 'Fictional Sender', chatId: 'fixture-chat', content: { text: `Confirm my Automagik waitlist: ${code}` } },
})
// A code issued before WhatsApp sign-ups were paused: the row the endpoint wrote then, with its
// 30-minute expiry. The endpoint issues none now, and these codes must still confirm.
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
async function whatsapp(f, extra = {}) {
  const code = 'AMG-' + [...crypto.getRandomValues(new Uint8Array(6))].map(byte => alphabet[byte & 31]).join('')
  assert.match(code, codePattern)
  const values = { ...fields, ...extra }, time = now()
  f.sqlite.prepare('INSERT INTO waitlist(id,channel,email,goal,platform,apps,expected_result,language,consent_version,created_at,expires_at,confirmation_hash,address_key,group_key,mail_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), 'whatsapp', null, values.goal, values.platform, values.apps, values.expected_result, values.language, CONSENT_VERSION, time, time + 1800, await hash(code), null, `earlier-${crypto.randomUUID()}`, new Date(time * 1000).toISOString().slice(0, 10))
  return code
}

test('email registration reserves, sends one fixed confirmation and confirms on POST only', async t => {
  const f = fixture(); t.after(f.close)
  const sends = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { sends.push({ url, init }); return new Response('{}', { status: 200 }) })
  const response = await post(f.env, { email: ' DEMO@EXAMPLE.COM ' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].url, 'https://api.resend.com/emails')
  const mail = JSON.parse(sends[0].init.body)
  assert.equal(mail.from, 'Automagik <confirm@send.automagik.si>')
  assert.deepEqual(mail.to, ['demo@example.com'])
  assert.equal('html' in mail, false, 'No user text is interpolated into mail HTML')
  assert.match(sends[0].init.headers['Idempotency-Key'], /^waitlist-/)
  const token = mail.text.match(/token=([a-f0-9]{64})/)[1]
  const before = f.sqlite.prepare('SELECT * FROM waitlist').get()
  assert.equal(before.confirmed_at, null)
  assert.equal(before.email, 'demo@example.com')
  assert.equal(before.confirmation_hash, await hash(token))
  assert.ok(!Object.values(before).includes(token))
  assert.equal((await emailLink({ request: new Request(origin + `/api/waitlist/email-confirm?token=${token}`) })).status, 200)
  assert.equal(f.sqlite.prepare('SELECT confirmed_at FROM waitlist').get().confirmed_at, null, 'Opening the link cannot confirm')
  assert.equal((await post(f.env, { action: 'confirm', token })).status, 200)
  assert.ok(f.sqlite.prepare('SELECT confirmed_at FROM waitlist').get().confirmed_at)
  assert.equal((await post(f.env, { action: 'confirm', token })).status, 404)
  assert.equal(sends.length, 1)
})

test('duplicates and concurrent joins share cooldown and store one row; ambiguous mail is not retried', async t => {
  const f = fixture(); t.after(f.close); let sends = 0
  t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('delivery outcome unknown') })
  assert.equal((await post(f.env)).status, 503)
  const replies = await Promise.all(Array.from({ length: 8 }, () => post(f.env)))
  assert.ok(replies.every(response => response.status === 200))
  assert.equal(sends, 1)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 1)
  await post(f.env, { action: 'remove', contact: fields.email })
  assert.equal((await post(f.env)).status, 200)
  assert.equal(sends, 1, 'Removal cannot reset email cooldown')
})

test('every intent field is bounded and consent/contact/configuration failures fail closed', async t => {
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No delivery for rejected requests'))
  for (const change of [{ goal: '' }, { goal: 'x'.repeat(1001) }, { apps: 'x'.repeat(201) }, { expected_result: '' }, { expected_result: 'x'.repeat(501) }, { platform: 'windows' }, { language: 'xx' }, { channel: 'other' }, { consent: '' }, { email: 'bad' }, { email: 'a'.repeat(250) + '@example.com' }]) assert.equal((await post(f.env, change)).status, 400, JSON.stringify(change).slice(0, 80))
  for (const key of ['WAITLIST_DB', 'RESEND_API_KEY', 'WAITLIST_CONFIRM_SECRET', 'WAITLIST_DATA_JURISDICTION']) assert.equal((await post({ ...f.env, [key]: undefined })).status, 503, key)
  assert.equal((await post(f.env, {}, { headers: { 'CF-Connecting-IP': '' } })).status, 503)
  assert.equal((await post({ ...f.env, WAITLIST_WHATSAPP_NUMBER: '' }, { channel: 'whatsapp' })).status, 503)
  assert.equal((await form({ env: f.env, request: new Request(origin, { method: 'PUT' }) })).status, 405)
  assert.equal((await form({ env: f.env, request: new Request(origin, { method: 'POST', body: '{}' }) })).status, 415)
  assert.equal((await post(f.env, { goal: 'x'.repeat(10000) })).status, 400)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0)
})

test('five joins per minute, ten per prefix per day, sixty emails per UTC day are atomic', async t => {
  const f = fixture(); t.after(f.close); let sends = 0
  t.mock.method(globalThis, 'fetch', async () => { sends++; return new Response('{}') })
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => post(f.env, { email: `parallel${i}@example.com` })))
  assert.equal(first.filter(response => response.status === 200).length, 5)
  assert.equal(first.filter(response => response.status === 429).length, 5)
  f.sqlite.prepare("DELETE FROM waitlist_quota WHERE key LIKE 'minute:%'").run()
  for (let i = 10; i < 15; i++) assert.equal((await post(f.env, { email: `day${i}@example.com` })).status, 200)
  f.sqlite.prepare("DELETE FROM waitlist_quota WHERE key LIKE 'minute:%'").run()
  assert.equal((await post(f.env, { email: 'daylimit@example.com' })).status, 429)
  const day = new Date().toISOString().slice(0, 10)
  f.sqlite.prepare('UPDATE waitlist_quota SET count=60 WHERE key=?').run(`mail:${day}`)
  assert.equal((await post(f.env, { email: 'global@example.com' }, { headers: { 'CF-Connecting-IP': '203.0.113.2' } })).status, 429)
  assert.equal(sends, 10)
})

test('WhatsApp sign-ups are paused: a WhatsApp POST gets the unavailable page and issues no code', async t => {
  assert.equal(WHATSAPP_SIGNUPS_OPEN, false)
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', () => assert.fail('A refused sign-up makes no request'))
  // A stale page, a direct POST, with or without an email, with or without the support number.
  for (const env of [f.env, { ...f.env, WAITLIST_WHATSAPP_NUMBER: '' }, {}]) {
    for (const extra of [{ channel: 'whatsapp', email: '' }, { channel: 'whatsapp' }, { channel: 'whatsapp', language: 'pt-BR' }]) {
      const response = await post(env, extra)
      assert.equal(response.status, 503, JSON.stringify(extra))
      const html = await response.text()
      assert.match(html, /<h1>Registration is unavailable<\/h1>/)
      assert.doesNotMatch(html, /AMG-|wa\.me|<svg|WhatsApp/)
    }
  }
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0, 'No row and no code')
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist_quota').get().n, 0, 'No reservation either')
})

test('an earlier WhatsApp sign-up is removed by its sender or its original code', async t => {
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', () => assert.fail('Removal makes no request'))
  const pending = await whatsapp(f)
  assert.equal((await post(f.env, { action: 'remove', channel: 'code', contact: pending.toLowerCase() })).status, 200)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0, 'A pending code is removed by the code')
  const confirmed = await whatsapp(f)
  assert.equal((await callback(f.env, event(confirmed))).status, 200)
  assert.equal((await post(f.env, { action: 'remove', channel: 'code', contact: confirmed })).status, 200)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0, 'A confirmed code is removed by the code')
  assert.equal((await callback(f.env, event(await whatsapp(f), '15555550100@s.whatsapp.net', 'second-message'))).status, 200)
  assert.equal((await post(f.env, { action: 'remove', channel: 'whatsapp', contact: '+15555550100' })).status, 200)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0, 'A confirmed sign-up is removed by the sender')
  assert.equal((await post(f.env, { action: 'remove', channel: 'code', contact: 'AMG-12' })).status, 400)
})

test('WhatsApp event: first match, idempotent replay, new message/different sender, unknown and expired', async t => {
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', () => assert.fail('WhatsApp must make no third-party request'))
  const code = await whatsapp(f, { language: 'pt-BR' })
  const firstEvent = event(code.toLowerCase())
  const first = await callback(f.env, firstEvent)
  assert.equal(first.status, 200)
  const data = await first.json(); assert.deepEqual(Object.keys(data), ['reply']); assert.match(data.reply, /confirmado/)
  const repeated = await callback(f.env, event(code)); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), data)
  for (const body of [event(code, '15555550100@s.whatsapp.net', 'new-message'), event(code, 'other-LID@lid')]) {
    const response = await callback(f.env, body); assert.equal(response.status, 409); assert.deepEqual(await response.json(), { status: 'already_confirmed' })
  }
  const unknown = await callback(f.env, event('AMG-000000', undefined, 'unknown-message')); assert.equal(unknown.status, 404); assert.deepEqual(await unknown.json(), { status: 'unknown_or_expired' })
  const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
  assert.equal(row.whatsapp_number, '+15555550100'); assert.equal(row.whatsapp_sender, '+15555550100'); assert.ok(row.confirmed_at)
  assert.equal(row.message_id, 'fixture-message'); assert.ok(row.received_at)
  assert.equal('message_text' in row, false); assert.equal('senderName' in row, false)
  t.mock.method(Date, 'now', () => (row.expires_at + 1) * 1000)
  assert.equal((await callback(f.env, event(code, undefined, 'expired-new-message'))).status, 404)
  assert.deepEqual(await (await callback(f.env, firstEvent)).json(), data, 'Exact original reply is retained for retries')
})

test('WhatsApp: Bearer comparison, required event fields and every transport/status failure', async t => {
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', () => assert.fail('No callback outbound request'))
  for (const auth of ['', 'Bearer wrong', 'bearer ' + f.env.WAITLIST_CONFIRM_SECRET]) {
    const response = await callback(f.env, event('AMG-123456'), { auth }); assert.equal(response.status, 401); assert.equal(await response.text(), '')
  }
  assert.equal((await callback(f.env, {}, { method: 'GET' })).status, 405)
  assert.equal((await callback(f.env, {}, { type: 'text/plain' })).status, 415)
  assert.equal((await callback(f.env, {}, { protocol: 'http:' })).status, 415)
  const valid = event('AMG-123456')
  for (const body of [{}, { ...valid, type: 'message.sent' }, { ...valid, payload: {} }, { ...valid, payload: { ...valid.payload, from: '' } }, { ...valid, payload: { ...valid.payload, externalId: null } }, { ...valid, payload: { ...valid.payload, content: {} } }]) assert.equal((await callback(f.env, body)).status, 400)
  assert.equal((await callback(f.env, {}, { raw: '{' })).status, 400)
  assert.equal((await callback(f.env, event('without a code'))).status, 404)
  assert.equal((await callback(f.env, {}, { raw: 'x'.repeat(33000) })).status, 400)
  const code = await whatsapp(f)
  const concurrent = await Promise.all(['a', 'b'].map(id => callback(f.env, event(code, '15555550100@s.whatsapp.net', id))))
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409])
  f.sqlite.prepare("UPDATE waitlist_quota SET count=60 WHERE key LIKE 'wa-callback:%'").run()
  assert.equal((await callback(f.env, event(code))).status, 429)
  assert.equal((await callback({ ...f.env, WAITLIST_DB: undefined }, event(code))).status, 503)
  assert.equal((await callback({ ...f.env, WAITLIST_DB: { prepare() { throw new Error('down') } } }, event(code))).status, 503)
  assert.equal(constantEqual('a'.repeat(64), 'a'.repeat(64)), true)
  assert.equal(constantEqual('a'.repeat(64), 'a'.repeat(63) + 'b'), false)
})

test('opaque LIDs are retained without inventing a phone; no event text/name/body logging or storage', async t => {
  const f = fixture(); t.after(f.close)
  const logs = []
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, name, (...args) => logs.push(args))
  t.mock.method(globalThis, 'fetch', () => assert.fail('No callback outbound request'))
  const code = await whatsapp(f)
  const body = event(code, 'opaque-user-LID@lid')
  body.payload.senderName = 'PRIVATE_SENTINEL_NAME'
  body.payload.content.text = `PRIVATE_SENTINEL_MESSAGE ${code} PRIVATE_SENTINEL_END`
  body.metadata = { marker: 'PRIVATE_SENTINEL_METADATA' }
  const result = await callback(f.env, body); assert.equal(result.status, 200)
  const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
  assert.equal(row.whatsapp_number, null); assert.equal(row.whatsapp_sender, 'opaque-user-LID')
  const dump = JSON.stringify(f.sqlite.prepare('SELECT * FROM waitlist').all())
  assert.doesNotMatch(dump, /PRIVATE_SENTINEL/)
  const broken = { ...f.env, WAITLIST_DB: { prepare() { throw new Error(JSON.stringify(body)) } } }
  assert.equal((await callback(broken, body)).status, 503)
  assert.deepEqual(logs, [])
  assert.equal((await post(f.env, { action: 'remove', channel: 'whatsapp', contact: 'opaque-user-LID' })).status, 200)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0)
})

test('removal is non-enumerating, stored text stays inert, expired pending entries are excluded/deleted', async t => {
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', () => assert.fail('No WhatsApp sends'))
  const code = await whatsapp(f, { goal: '<script>fetch("https://example.com")</script>' })
  assert.equal((await callback(f.env, event(code))).status, 200)
  const a = await post(f.env, { action: 'remove', channel: 'whatsapp', contact: '+15555550100' })
  const b = await post(f.env, { action: 'remove', channel: 'whatsapp', contact: '+15555550100' })
  assert.equal(await a.text(), await b.text()); assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0)
  await whatsapp(f)
  f.sqlite.prepare('UPDATE waitlist SET expires_at=?').run(now() - WHATSAPP_BACKLOG_SECONDS - 1)
  await post(f.env, { action: 'remove', contact: 'missing@example.com' })
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0)
  assert.equal(networkPrefix('2001:db8:abcd:1234::1'), networkPrefix('2001:db8:abcd:1234::2'))
  assert.equal(networkPrefix('bad'), null)
  assert.doesNotMatch(readFileSync(new URL('functions/api/waitlist/whatsapp-confirm.js', import.meta.url), 'utf8'), /\bfetch\s*\(/)
})


test('WhatsApp backlog: received before expiry confirms after days', async t => {
  const f = fixture(); t.after(f.close)
  t.mock.method(globalThis, 'fetch', () => assert.fail('No callback outbound request'))
  const code = await whatsapp(f)
  const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
  const receivedAt = (row.expires_at - 1) * 1000
  const processingAt = (row.expires_at + 3 * 86400) * 1000
  t.mock.method(Date, 'now', () => processingAt)
  // A human request between receiving and processing must not erase the pending code.
  await post(f.env, { action: 'remove', contact: 'absent@example.com' })
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 1)
  const body = { ...event(code), timestamp: receivedAt }
  const response = await callback(f.env, body)
  assert.equal(response.status, 200)
  const confirmed = f.sqlite.prepare('SELECT * FROM waitlist').get()
  assert.equal(confirmed.received_at, receivedAt)
  assert.equal(confirmed.confirmed_at, processingAt / 1000)
  assert.deepEqual(await (await callback(f.env, body)).json(), await response.json())
  assert.equal((await callback(f.env, { ...body, payload: { ...body.payload, externalId: 'late-new-message' } })).status, 409)
})

test('WhatsApp backlog: received after expiry is refused', async t => {
  const f = fixture(); t.after(f.close)
  const code = await whatsapp(f)
  const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
  t.mock.method(Date, 'now', () => (row.expires_at + 86400) * 1000)
  const response = await callback(f.env, { ...event(code), timestamp: row.expires_at * 1000 + 1 })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { status: 'unknown_or_expired' })
  assert.equal(f.sqlite.prepare('SELECT confirmed_at FROM waitlist').get().confirmed_at, null)
})

test('WhatsApp backlog: received timestamp more than two minutes in the future is refused', async t => {
  const f = fixture(); t.after(f.close)
  const code = await whatsapp(f)
  const processingAt = Date.now()
  t.mock.method(Date, 'now', () => processingAt)
  const response = await callback(f.env, { ...event(code), timestamp: processingAt + 120001 })
  assert.equal(response.status, 400)
  assert.equal(await response.text(), '')
  assert.equal(f.sqlite.prepare('SELECT confirmed_at FROM waitlist').get().confirmed_at, null)
  for (const timestamp of [undefined, null, 'not-a-time']) assert.equal((await callback(f.env, { ...event(code), timestamp })).status, 400)
  assert.equal((await callback(f.env, { ...event(code), timestamp: processingAt + 120000 })).status, 200)
})

test('WhatsApp backlog: processing after 180 days past expiry is refused', async t => {
  const f = fixture(); t.after(f.close)
  const code = await whatsapp(f)
  const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
  t.mock.method(Date, 'now', () => (row.expires_at + WHATSAPP_BACKLOG_SECONDS + 1) * 1000)
  const response = await callback(f.env, { ...event(code), timestamp: (row.expires_at - 1) * 1000 })
  assert.equal(response.status, 404)
  assert.equal(f.sqlite.prepare('SELECT confirmed_at FROM waitlist').get().confirmed_at, null)
  await post(f.env, { action: 'remove', contact: 'absent@example.com' })
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0)
})


test('WhatsApp backlog cutoff: first use allows the exact boundary and refuses one millisecond later', async t => {
  const start = Date.now(); let clock = start
  t.mock.method(Date, 'now', () => clock)
  t.mock.method(globalThis, 'fetch', () => assert.fail('No callback outbound request'))
  for (const delta of [0, 1]) {
    clock = start
    const f = fixture()
    try {
      const code = await whatsapp(f)
      const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
      const body = { ...event(code), timestamp: row.expires_at * 1000 }
      clock = (row.expires_at + WHATSAPP_BACKLOG_SECONDS) * 1000 + delta
      const response = await callback(f.env, body)
      assert.equal(response.status, delta === 0 ? 200 : 404, `first use at cutoff + ${delta}ms`)
      assert.equal(f.sqlite.prepare('SELECT confirmed_at FROM waitlist').get().confirmed_at !== null, delta === 0)
      if (delta === 1) {
        await post(f.env, { action: 'remove', contact: 'absent@example.com' })
        assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM waitlist').get().n, 0, 'Cleanup uses the same millisecond cutoff')
      }
    } finally { f.close() }
  }
})

test('WhatsApp backlog cutoff: replay allows the exact boundary and refuses one millisecond later', async t => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  t.mock.method(globalThis, 'fetch', () => assert.fail('No callback outbound request'))
  const f = fixture(); t.after(f.close)
  const code = await whatsapp(f)
  const row = f.sqlite.prepare('SELECT * FROM waitlist').get()
  const body = event(code)
  const original = await callback(f.env, body)
  assert.equal(original.status, 200)
  const reply = await original.json()
  clock = (row.expires_at + WHATSAPP_BACKLOG_SECONDS) * 1000
  const atBoundary = await callback(f.env, body)
  assert.equal(atBoundary.status, 200)
  assert.deepEqual(await atBoundary.json(), reply)
  clock++
  const pastBoundary = await callback(f.env, body)
  assert.equal(pastBoundary.status, 404, 'replay at cutoff + 1ms')
  assert.deepEqual(await pastBoundary.json(), { status: 'unknown_or_expired' })
})

test('waitlist answers stay out of search: X-Robots-Tag on every kind, the robots meta on HTML', async t => {
  const f = fixture(); t.after(f.close)
  // One answer of each kind, read here directly; every other test's answers pass the same check.
  const page = await formFunction({ env: {}, request: new Request(origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.1' }, body: new URLSearchParams(fields) }) })
  assert.equal(page.status, 503); assert.match(page.headers.get('content-type'), /^text\/html/)
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal((await page.text()).match(/<meta name="robots" content="noindex, nofollow">/g)?.length, 1)
  const link = await emailLinkFunction({ env: f.env, request: new Request(origin + '/api/waitlist/email-confirm?token=absent') })
  assert.match(link.headers.get('content-type'), /^text\/html/); assert.equal(link.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.match(await link.text(), /<meta name="robots" content="noindex, nofollow">/)
  const refused = await confirmFunction({ env: f.env, request: new Request(origin + '/api/waitlist/whatsapp-confirm') })
  assert.equal(refused.status, 405); assert.equal(refused.headers.get('content-type'), null); assert.equal(refused.headers.get('x-robots-tag'), 'noindex, nofollow')
  const unknown = await callback(f.env, event('AMG-ABSENT-CODE'))
  assert.equal(unknown.headers.get('content-type'), 'application/json'); assert.equal(unknown.headers.get('x-robots-tag'), 'noindex, nofollow')
  // The wrapped functions met all three kinds across this file.
  await post(f.env, { consent: '' }); await callback(f.env, {}, { method: 'GET' })
  assert.deepEqual([...kinds].sort(), ['application/json', 'empty', 'text/html'])
})
