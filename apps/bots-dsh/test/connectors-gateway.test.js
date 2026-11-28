import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createGateway } from '../src/host/connectors/gateway.js'
import { createRuntime } from '../index.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeContext } from './fake-ctx.js'
import { scratch } from './fixtures/w1-format-profile.mjs'

test('a direct connector mutation cannot create a key or publish a roster during a trial', async t => {
  const home = scratch(t)
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const rt = createRuntime(ctx, { home, github: false })
  await rt.load()
  const before = readFileSync(rt.statePath)
  rt.stateWriteProof = () => 'held'
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Held connector sign-in reached OAuth discovery'))
  await assert.rejects(rt.connectorEndpoint('connector-add', {
    name: 'Fixture', command: 'fixture-never-exec', env: { TOKEN: 'fixture-credential-value' },
  }), /after the update commits/)
  await assert.rejects(rt.connectorEndpoint('connector-connect', { id: 'notion' }), /after the update commits/)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(existsSync(join(home, 'connector-key')), false)
  assert.deepEqual(readFileSync(rt.statePath), before)
  assert.equal(rt.state.connectors, undefined)
})

test('an OAuth response arriving after the update holds the host cannot publish credentials', async t => {
  const home = scratch(t)
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  const rt = createRuntime(ctx, { home, github: false })
  await rt.load()
  rt.state.connectors = { notion: {
    oauth: { authorizationServerUrl: 'https://fixture.test' }, client: { via: 'manual', clientId: 'fake-client' },
  } }
  await rt.save({ required: true })
  await rt.secretEndpoint('secret-set', { name: 'CONNECTOR_NOTION_REFRESH', value: 'fixture-old-refresh', scope: [] })
  const before = readFileSync(rt.statePath)
  const secretPath = join(home, 'secrets.json')
  const secretsBefore = readFileSync(secretPath)
  let proof = 'steady'
  rt.stateWriteProof = () => proof
  const posted = Promise.withResolvers()
  const provider = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input?.url ?? input)
    if (url === 'https://fixture.test/.well-known/oauth-authorization-server') {
      return Response.json({ issuer: 'https://fixture.test', authorization_endpoint: 'https://fixture.test/auth',
        token_endpoint: 'https://fixture.test/token', response_types_supported: ['code'] })
    }
    assert.equal(url, 'https://fixture.test/token')
    posted.resolve()
    return provider.promise
  })
  const refresh = rt.connectorsInternals.refreshConnector('notion')
  await Promise.race([posted.promise, refresh.then(() => assert.fail('The token request never started'))])
  proof = 'held'
  provider.resolve(Response.json({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', token_type: 'Bearer' }))
  assert.equal(await refresh, false)
  assert.equal(rt.secretValue('CONNECTOR_NOTION_REFRESH'), 'fixture-old-refresh')
  assert.equal(rt.secretValue('CONNECTOR_NOTION_TOKEN'), undefined)
  assert.deepEqual(readFileSync(rt.statePath), before)
  assert.deepEqual(readFileSync(secretPath), secretsBefore)
})

for (const refreshing of [false, true]) {
  test(`an upstream stream error cannot crash the engine${refreshing ? ' during refresh' : ''}`, () => {
    const script = `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { createGateway } from ${JSON.stringify(new URL('../src/host/connectors/gateway.js', import.meta.url).href)}
      const upstream = createServer((req, res) => {
        res.writeHead(${refreshing ? 401 : 200}, { 'content-type': 'text/event-stream' })
        res.write('data: {}\\n\\n')
        setTimeout(() => res.destroy(), 10)
      })
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
      const gw = createGateway({
        credential: () => ({ url: 'http://127.0.0.1:' + upstream.address().port, headers: {} }),
        readOnly: () => false,
        onUnauthorized: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return false },
      })
      await gw.listen()
      try {
        const response = await fetch(gw.urlFor('svc'), { headers: gw.headers(), signal: AbortSignal.timeout(1000) })
        ${refreshing ? `// Two legal timings for the destroy: inside the refresh the gateway
        // already saw the stream error and answers 502 itself; after it, the
        // 401 headers were already forwarded and the piped body then breaks.
        // Either way the engine must answer without hanging or crashing.
        if (response.status === 502) {
          assert.match(await response.text(), /connector upstream failed/)
        } else {
          assert.equal(response.status, 401)
          await assert.rejects(response.text(), error => error.name !== 'TimeoutError' && error.name !== 'AbortError')
        }` : "await assert.rejects(response.text(), error => error.name !== 'TimeoutError' && error.name !== 'AbortError')"}
      } finally { await gw.close(); await new Promise(resolve => upstream.close(resolve)) }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  })
}

for (const limited of [false, true]) {
  test(`a 401 that refresh cannot fix answers the call with a sign-in reason${limited ? ' (read-only list)' : ''}`, async (t) => {
    let hits = 0
    const upstream = createServer((req, res) => {
      hits += 1
      req.resume()
      req.on('end', () => { res.writeHead(401, { 'www-authenticate': 'Bearer' }); res.end() })
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    t.after(() => upstream.close())
    let refreshes = 0
    const gw = createGateway({
      credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}/mcp`, headers: {} }),
      readOnly: () => limited,
      onUnauthorized: async () => { refreshes += 1; return false },
    })
    await gw.listen()
    t.after(() => gw.close())
    const method = limited ? 'tools/list' : 'tools/call'
    const response = await fetch(gw.urlFor('notion'), {
      method: 'POST',
      headers: { ...gw.headers(), accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { name: 'notion-search' } }),
    })
    assert.equal(response.status, 200)
    const answer = await response.json()
    assert.equal(answer.id, 7)
    assert.match(answer.error.message, /notion connector needs sign-in again.*request_connector/)
    assert.equal(refreshes, 1)
    assert.equal(hits, 1)
  })
}

test('gateway preserves MCP POST headers and bodies and reports expired sessions without replaying calls', async (t) => {
  const seen = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url })
      res.writeHead(seen.length === 1 ? 200 : 404, {
        'content-type': seen.length === 1 ? 'text/event-stream' : 'application/json',
        'mcp-session-id': 'private-session',
      })
      res.end(seen.length === 1 ? 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' : '{"error":"Session not found"}')
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  const logs = []
  let refreshes = 0
  const gw = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}/mcp?key=private-key`, headers: { Authorization: 'Bearer private-token' } }),
    readOnly: () => false,
    onUnauthorized: async () => { refreshes += 1; return false },
    log: (...args) => logs.push(args),
  })
  await gw.listen()
  t.after(() => gw.close())
  const headers = { ...gw.headers(), accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' }
  const body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  const response = await fetch(gw.urlFor('notion'), { method: 'POST', headers, body })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('mcp-session-id'), 'private-session')
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.match(await response.text(), /event: message/)
  assert.equal(seen[0].body, body)
  assert.equal(seen[0].headers.accept, headers.accept)
  assert.equal(seen[0].headers['mcp-protocol-version'], headers['mcp-protocol-version'])
  assert.equal(seen[0].headers.authorization, 'Bearer private-token')
  const expired = await fetch(gw.urlFor('notion'), {
    method: 'POST', headers: { ...headers, 'mcp-session-id': 'private-session' },
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write"}}',
  })
  assert.equal(expired.status, 404)
  assert.equal((await expired.json()).error, 'Session not found')
  assert.equal(seen[1].headers['mcp-session-id'], 'private-session')
  assert.equal(seen.length, 2)
  assert.equal(refreshes, 0)
  assert.match(JSON.stringify(logs), /notion.*POST.*404/)
  assert.equal(JSON.stringify(logs).includes('private-'), false)
})

test('OAuth refresh defers provider rotation while writes are held, including during discovery', async t => {
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home: scratch(t), github: false })
  t.after(() => ctx.dispose())
  await rt.load()
  await rt.loadSecrets()
  await rt.secretEndpoint('secret-set', { name: 'CONNECTOR_NOTION_REFRESH', value: 'fixture-original', scope: [] })
  rt.state.connectors = { notion: { oauth: { authorizationServerUrl: 'https://as.test' }, client: { via: 'manual', clientId: 'fixture' } } }
  let held = true
  rt.stateWriteProof = () => held ? 'held' : 'steady'
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    const address = String(url?.url ?? url)
    requests.push(address)
    held = true
    return Response.json(address.endsWith('/token')
      ? { access_token: 'fixture-access', refresh_token: 'fixture-rotated', token_type: 'Bearer' }
      : { issuer: 'https://as.test', authorization_endpoint: 'https://as.test/auth', token_endpoint: 'https://as.test/token',
          response_types_supported: ['code'] })
  })
  assert.equal(await rt.connectorsInternals.refreshConnector('notion'), false)
  assert.deepEqual(requests, [])
  held = false
  assert.equal(await rt.connectorsInternals.refreshConnector('notion'), false)
  assert.ok(requests.some(address => address.includes('well-known')))
  assert.equal(requests.includes('https://as.test/token'), false)
  assert.equal(rt.secretValue('CONNECTOR_NOTION_REFRESH'), 'fixture-original')
})
