import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRoleCatalog } from '../src/host/role-catalog.js'
import { entryOf, INDEX, SIGNATURE, signer, VERSION } from './role-fixture.js'

const first = signer('first')
const second = signer('second')
const keys = [first.key, second.key]
const entry = entryOf()
const good = first.index([entry])

function fixture(options = {}) {
  let now = 0
  let allowed = true
  const calls = []
  const warnings = []
  const bodies = new Map([[INDEX, () => new Response(good.bytes)], [SIGNATURE, () => new Response(good.signature)]])
  const catalog = createRoleCatalog({
    keys, warn: (...args) => warnings.push(args), now: () => now, canFetch: () => allowed,
    fetch: async (url, init) => {
      calls.push({ url, ...init })
      assert.equal(init.redirect, 'manual')
      assert.ok(init.signal instanceof AbortSignal)
      assert.ok(bodies.has(url), 'unexpected fixture URL')
      return bodies.get(url)()
    },
    ...options,
  })
  const setIndex = ({ bytes, signature }) => {
    bodies.set(INDEX, () => new Response(bytes))
    bodies.set(SIGNATURE, () => new Response(signature))
  }
  return { catalog, calls, bodies, warnings, setIndex, tick: value => { now += value }, allow: value => { allowed = value } }
}

test('verifies the exact bytes with either pinned key and projects only public catalog fields', async () => {
  for (const key of [first, second]) {
    const f = fixture()
    f.setIndex(key.index([entry]))
    assert.deepEqual(f.catalog.view(), { available: false, roles: [] })
    const result = await f.catalog.snapshot()
    assert.deepEqual(result.view, { available: true, roles: [{
      id: entry.id, version: entry.version, name: entry.name, publisher: entry.publisher,
      capabilities: entry.capabilities, installable: true,
    }] })
    assert.equal(result.entries.get(entry.id).sha256, entry.sha256)
    assert.deepEqual(f.calls.map(call => call.url), [INDEX, SIGNATURE])
    assert.equal(f.calls[0].signal, f.calls[1].signal)
  }
})

test('fixture base is confined to the catalog instance and its derived package URLs', async () => {
  const base = 'https://example.test/releases/'
  const release = `${base}v${VERSION}/`
  const source = `${release}automagik-role-${entry.id}-${entry.version}.tgz`
  const signed = first.index([{ ...entry, source }])
  const f = fixture({ base })
  f.bodies.set(`${release}roles.json`, () => new Response(signed.bytes))
  f.bodies.set(`${release}roles.json.sig`, () => new Response(signed.signature))
  assert.equal((await f.catalog.snapshot()).entries.get(entry.id).source, source)
  assert.deepEqual(f.calls.map(call => call.url), [`${release}roles.json`, `${release}roles.json.sig`])
  assert.equal((await fixture().catalog.snapshot()).entries.get(entry.id).source, entry.source)
})

test('a missing index is ordinary and a missing signature or any other index failure is unverified', async () => {
  for (const [url, status, reason] of [[INDEX, 404, 'none'], [INDEX, 403, 'unverified'], [SIGNATURE, 404, 'unverified'], [SIGNATURE, 502, 'unverified']]) {
    const f = fixture()
    let cancelled = false
    f.bodies.set(url, () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status }))
    const result = await f.catalog.snapshot()
    assert.deepEqual(result.view, { available: false, reason, roles: [] })
    assert.equal(f.warnings.length, reason === 'unverified' ? 1 : 0)
    assert.equal(cancelled, true)
    if (url === INDEX) assert.equal(f.calls.length, 1)
  }
  const f = fixture({ fetch: async () => { throw new Error('failure at https://example.test/?token=private') } })
  assert.equal((await f.catalog.snapshot()).view.reason, 'unverified')
  assert.doesNotMatch(JSON.stringify(f.warnings), /token|private/)
})

test('fails closed on changed bytes, bad JSON, unknown key or wrong signed envelope', async () => {
  const bad = [
    { ...good, bytes: Buffer.concat([good.bytes, Buffer.from('\n')]) },
    { ...good, signature: 'bad signature' },
    { ...good, bytes: Buffer.from('{') },
    first.index([entry], { keyId: 'unknown' }),
    ...[{ version: '0.0.0' }, { publisher: 'community' }, { repository: 'https://example.test' }, { schemaVersion: 2 }]
      .map(fields => first.index([entry], fields)),
    first.index({}), first.index(Array(201).fill(null)),
  ]
  for (const input of bad) {
    const f = fixture()
    f.setIndex(input)
    const result = await f.catalog.snapshot()
    assert.deepEqual(result.view, { available: false, reason: 'unverified', roles: [] })
    assert.equal(result.entries, undefined)
    assert.ok(result.error)
  }
})

test('drops malformed and duplicate raw entries and keeps community display rows', async () => {
  const f = fixture()
  f.setIndex(first.index([
    entry,
    { id: entry.id },
    entryOf(undefined, { id: 'community', publisher: 'Community', official: true }),
    entryOf(undefined, { id: 'listed', official: false }),
    entryOf(undefined, { id: 'elsewhere', source: 'https://example.test' }),
    entryOf(undefined, { id: 'data' }),
    entryOf(undefined, { id: 'con' }),
    entryOf(undefined, { id: 'version', version: '1234567890.0.0' }),
    entryOf(undefined, { id: 'official', official: 'true' }),
    entryOf(undefined, { id: 'name', name: 'x'.repeat(61) }),
    entryOf(undefined, { id: 'publisher', publisher: 1 }),
    entryOf(undefined, { id: 'excess', size: 16 * 1024 * 1024 + 1 }),
    entryOf(undefined, { id: 'capability', capabilities: ['other'] }),
    entryOf(undefined, { id: 'constructor' }),
  ]))
  const { view, entries } = await f.catalog.snapshot()
  assert.deepEqual([...entries.keys()], ['community', 'listed', 'constructor'])
  assert.deepEqual(view.roles.map(({ id, installable, reason }) => [id, installable, reason]), [
    ['community', false, 'community'], ['listed', false, 'community'], ['constructor', true, undefined],
  ])
  assert.equal(f.warnings.length, 11)
})

test('caps streamed index, signature and package without a Content-Length and cancels the reader', async () => {
  for (const [url, limit] of [[INDEX, 256 * 1024], [SIGNATURE, 1024], [entry.source, entry.size]]) {
    const f = fixture()
    let cancelled = false
    let pulls = 0
    f.bodies.set(url, () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(limit)) },
      cancel() { cancelled = true },
    })))
    if (url === entry.source) await assert.rejects(f.catalog.download(entry), /size limit/)
    else assert.equal((await f.catalog.snapshot()).view.reason, 'unverified')
    assert.equal(cancelled, true)
    assert.ok(pulls <= 3)
  }
})

test('follows up to three HTTPS asset redirects with the same deadline and keeps query strings out of warnings', async () => {
  const origin = 'https://release-assets.githubusercontent.com'
  const hop = `${origin}/asset?secret=signed`
  const f = fixture()
  const redirect = location => () => new Response('redirecting', { status: 302, headers: { location } })
  f.bodies.set(INDEX, redirect(hop))
  f.bodies.set(hop, redirect(`${origin}/second`))
  f.bodies.set(`${origin}/second`, redirect(`${origin}:443/third`))
  f.bodies.set(`${origin}/third`, () => new Response(good.bytes))
  assert.equal((await f.catalog.snapshot()).view.available, true)
  assert.deepEqual(f.calls.map(call => call.url), [INDEX, hop, `${origin}/second`, `${origin}/third`, SIGNATURE])
  assert.ok(f.calls.every(call => call.signal === f.calls[0].signal))
  for (const target of [
    'http://release-assets.githubusercontent.com/here', 'https://example.test/here',
    'https://release-assets.githubusercontent.com:444/here', 'https://user@release-assets.githubusercontent.com/here',
    '/relative', `${origin}.example.test/here`, `blob:${origin}/id`,
  ]) {
    const blocked = fixture()
    blocked.bodies.set(INDEX, redirect(target))
    assert.equal((await blocked.catalog.snapshot()).view.reason, 'unverified')
    assert.equal(blocked.calls.length, 1)
  }
  const loop = fixture()
  loop.bodies.set(INDEX, redirect(hop))
  loop.bodies.set(hop, redirect(hop))
  assert.equal((await loop.catalog.snapshot()).view.reason, 'unverified')
  assert.equal(loop.calls.length, 4)
  assert.doesNotMatch(JSON.stringify(loop.warnings), /secret|signed/)
})

test('uses per-outcome TTLs, shares in-flight work and skips fetching without the lock', async () => {
  const f = fixture()
  f.allow(false)
  assert.deepEqual((await f.catalog.snapshot()).view, { available: false, reason: 'read-only', roles: [] })
  assert.equal(f.calls.length, 0)
  f.allow(true)
  let complete
  f.bodies.set(INDEX, () => new Promise(resolve => { complete = resolve }))
  const jobs = [f.catalog.snapshot(), f.catalog.snapshot()]
  assert.equal(f.calls.length, 1)
  f.allow(false)
  complete(new Response(null, { status: 404 }))
  for (const job of jobs) assert.equal((await job).view.reason, 'read-only')
  f.allow(true)
  assert.equal((await f.catalog.snapshot()).view.reason, 'none')
  f.tick(599_999)
  assert.equal((await f.catalog.snapshot()).view.reason, 'none')
  assert.equal(f.calls.length, 1)
  f.tick(1)
  f.bodies.set(INDEX, () => new Response(null, { status: 500 }))
  assert.equal((await f.catalog.snapshot()).view.reason, 'unverified')
  f.tick(59_999)
  assert.equal((await f.catalog.snapshot()).view.reason, 'unverified')
  assert.equal(f.calls.length, 2)
  f.tick(1)
  f.setIndex(good)
  assert.equal((await f.catalog.snapshot()).view.available, true)
  f.tick(599_999)
  assert.equal((await f.catalog.snapshot()).view.available, true)
  assert.equal(f.calls.length, 4)
})

test('projects bounded declarations separately and drops Genie only from new catalog admission', async () => {
  const f = fixture()
  const declared = entryOf(undefined, { id: 'constructor', description: 'x'.repeat(200), tools: ['sample_tool'] })
  const oversized = entryOf(undefined, { id: 'oversized', description: 'x'.repeat(201), tools: Array(17).fill('tool') })
  const malformed = entryOf(undefined, { id: 'malformed', description: false, tools: ['UPPER', 1] })
  f.setIndex(first.index([declared, oversized, malformed, entry, entryOf(undefined, { id: 'genie' })]))
  const { view } = await f.catalog.snapshot()
  assert.deepEqual(view.roles.map(role => role.id), ['constructor', 'oversized', 'malformed', entry.id])
  assert.equal(f.warnings.length, 1)
  assert.deepEqual(f.catalog.entries().get('constructor').details, {
    version: declared.version, sha256: declared.sha256, description: declared.description, tools: ['sample_tool'],
  })
  for (const raw of [oversized, malformed, entry]) {
    assert.deepEqual(f.catalog.entries().get(raw.id).details, { version: raw.version, sha256: raw.sha256 })
  }
  assert.equal(Object.hasOwn(view.roles[0], 'description'), false)
  assert.equal(Object.hasOwn(view.roles[0], 'tools'), false)
})
