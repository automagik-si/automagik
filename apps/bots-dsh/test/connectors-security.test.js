import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createGateway } from '../src/host/connectors/gateway.js'
import { fakeContext } from './fake-ctx.js'

// Exercise the real gateway routing without opening sockets or resolving names.
function transport(t) {
  const requests = []
  const listeners = []
  t.mock.method(http, 'createServer', listener => {
    listeners.push(listener)
    return Object.assign(new EventEmitter(), {
      listen: (_port, _host, ready) => ready(),
      address: () => ({ port: 12345 }),
      close: done => done(),
    })
  })
  for (const protocol of [http, https]) {
    t.mock.method(protocol, 'request', (url, options, response) => {
      requests.push({ protocol, url: String(url), headers: options.headers })
      return Object.assign(new EventEmitter(), { end: () => {
        response(Object.assign(Readable.from(['ok']), { statusCode: 200, headers: {} }))
      } })
    })
  }
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return { listeners, requests }
}

async function team(t, extra = {}, learning) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-connector-security-'))
  const path = join(home, 'state.json')
  const bot = id => ({ id, sessionId: id, name: id, role: 'Reader', instructions: '', createdAt: 1 })
  writeFileSync(path, JSON.stringify({
    version: 2, mainBotIds: ['m1'], revision: 1, bots: { m1: bot('m1') },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, ...extra,
  }))
  if (learning !== undefined) {
    mkdirSync(join(home, 'learning'))
    writeFileSync(join(home, 'learning', 'state.json'), JSON.stringify(learning))
  }
  const ctx = fakeContext({ services: { loader: { import: async () => ({ name: 'mcp', apply() {} }) } } })
  const mounts = []
  ctx.plugin = (_plugin, config) => {
    mounts.push(config)
    return { await: async () => {}, dispose() {} }
  }
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  return { ctx, rt, home, path, mounts, call: (name, body) => rt.connectorEndpoint(`connector-${name}`, body) }
}

function importFrom(t, home, servers) {
  t.mock.method(os, 'homedir', () => home)
  t.mock.method(os, 'platform', () => 'linux')
  syncBuiltinESMExports()
  mkdirSync(join(home, '.cursor'), { recursive: true })
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return name => ({ items: [{ source: 'cursor', name }] })
}

async function dispatch(io, url) {
  const gw = createGateway({ credential: () => ({ url, headers: {} }), readOnly: () => false })
  await gw.listen()
  try {
    const req = Object.assign(new EventEmitter(), {
      method: 'GET', url: new URL(gw.urlFor('svc')).pathname, headers: { authorization: gw.headers().Authorization },
    })
    const res = new PassThrough()
    res.writeHead = status => { res.statusCode = status }
    io.listeners.at(-1)(req, res)
    let body = ''
    for await (const chunk of res) body += chunk
    return { status: res.statusCode, body }
  } finally { await gw.close() }
}

test('both output hooks mask connector credential literals with an empty Secrets store', async (t) => {
  transport(t)
  const legacy = { custom: { name: 'Legacy', command: 'mcp', env: { TOKEN: 'legacy-env-value' } } }
  const { ctx, rt, call } = await team(t, { connectors: { legacy } })
  await call('add', { name: 'Remote', url: 'https://mcp.example.test', headers: {
    'x-aUtH': '$DSH_SECRET_EXISTING manual-header-value',
    Authorization: 'Bearer literal-bearer-token',
    'Proxy-Authorization': 'bAsIc bGl0ZXJhbDpwYXNz',
  } })
  await call('add', { name: 'Local', command: 'mcp', env: { password: ['manual', 'env', 'value'].join('-') } })
  assert.deepEqual(rt.secretsView(), [])
  const plain = [
    'legacy-env-value', 'manual-header-value', 'manual-env-value',
    'Bearer literal-bearer-token', 'literal-bearer-token', 'bAsIc bGl0ZXJhbDpwYXNz', 'bGl0ZXJhbDpwYXNz',
  ].join(' | ')
  const masked = [
    'CONNECTOR_LEGACY_TOKEN', 'CONNECTOR_REMOTE_HEAD_X_AUTH', 'CONNECTOR_LOCAL_PASSWORD',
    'CONNECTOR_REMOTE_HEAD_AUTHORIZATION', 'CONNECTOR_REMOTE_HEAD_AUTHORIZATION',
    'CONNECTOR_REMOTE_HEAD_PROXY_AUTHORIZATION', 'CONNECTOR_REMOTE_HEAD_PROXY_AUTHORIZATION',
  ].map(name => `[secret:${name}]`).join(' | ')
  const execute = ctx.listeners.get('tools/execute').find(listener => listener.name === 'redactToolResult')
  const result = await execute({}, async () => ({ content: [{ type: 'text', text: plain }] }))
  assert.equal(result.content[0].text, masked)

  const stream = ctx.listeners.get('llm/stream').find(listener => listener.name === 'redactModelRequest')
  ctx.llm.stream = request => stream(request, () => request)
  const sent = ctx.llm.stream({ messages: [{ role: 'user', content: plain }], system: plain })
  assert.equal(sent.messages[0].content, masked)
  assert.equal(sent.system, masked)
})

test('padded connector headers are masked in both raw and trimmed form', async (t) => {
  transport(t)
  const { ctx, rt, call } = await team(t)
  const header = '  header-token9  '
  await call('add', { name: 'Remote', url: 'https://mcp.example.test', headers: { 'X-API-Key': header } })
  assert.equal(rt.connectorsInternals.upstreamOf('remote').headers['X-API-Key'], header)

  const execute = ctx.listeners.get('tools/execute').find(listener => listener.name === 'redactToolResult')
  const result = await execute({}, async () => ({ value: header, trimmed: header.trim() }))
  const label = '[secret:CONNECTOR_REMOTE_HEAD_X_API_KEY]'
  assert.deepEqual(result, { value: label, trimmed: label })
})

test('connector masking preserves ordinary words and masks credential-shaped values', async (t) => {
  // A clearly fake, low-entropy fixture built at run time (no literal credential in the source).
  const fakeLong = ['abcdefgh', 'ijklmnoq'].join('')
  transport(t)
  const legacy = { custom: { name: 'Legacy', command: 'mcp', env: {
    AUTH_MODE: 'production', AUTH_STAGE: 'staging', AUTH_STATUS: 'enabled',
    TOKEN_DESCRIPTION: 'a long description', TOKEN_NUMBER: '12345678',
    TOKEN: 'token123', PASSWORD: fakeLong,
  } } }
  const { ctx } = await team(t, { connectors: { legacy } })
  const plain = 'Deploy to production | staging | enabled | a long description | 12345678'
  const credentials = `token123 | ${fakeLong}`
  const masked = '[secret:CONNECTOR_LEGACY_TOKEN] | [secret:CONNECTOR_LEGACY_PASSWORD]'
  const execute = ctx.listeners.get('tools/execute').find(listener => listener.name === 'redactToolResult')
  assert.deepEqual(await execute({}, async () => ({ plain, credentials })), { plain, credentials: masked })

  const stream = ctx.listeners.get('llm/stream').find(listener => listener.name === 'redactModelRequest')
  ctx.llm.stream = request => stream(request, () => request)
  const sent = ctx.llm.stream({ messages: [{ role: 'user', content: plain }], system: credentials })
  assert.equal(sent.messages[0].content, plain)
  assert.equal(sent.system, masked)
})

test('editing or removing a connector refreshes its output mask immediately', async (t) => {
  transport(t)
  const { ctx, rt, call } = await team(t)
  await call('add', { name: 'First', command: 'mcp', env: { TOKEN: 'first-token1' } })
  await call('add', { name: 'Second', command: 'mcp', env: { TOKEN: 'second-token2' } })
  const execute = ctx.listeners.get('tools/execute').find(listener => listener.name === 'redactToolResult')
  const value = 'first-token1 | edited-token3 | second-token2'
  const masked = () => execute({}, async () => ({ value }))
  const before = await masked()
  rt.state.connectors.first.custom.env.TOKEN = 'edited-token3'
  const edited = await masked()
  await call('remove', { id: 'first' })
  const removed = await masked()
  assert.deepEqual([before.value, edited.value, removed.value], [
    '[secret:CONNECTOR_FIRST_TOKEN] | edited-token3 | [secret:CONNECTOR_SECOND_TOKEN]',
    'first-token1 | [secret:CONNECTOR_FIRST_TOKEN] | [secret:CONNECTOR_SECOND_TOKEN]',
    'first-token1 | edited-token3 | [secret:CONNECTOR_SECOND_TOKEN]',
  ])
})

test('manual add preserves settings and learning keeps an ordinary credential-shaped value', async (t) => {
  transport(t)
  const proposal = { kind: 'skill', botId: 'm1', content: 'Deploy to production or staging.' }
  const legacy = { custom: { name: 'Legacy', command: 'mcp', env: { AUTH_MODE: 'production' } } }
  const { rt, call, mounts, path } = await team(t, { connectors: { legacy } }, { proposals: { release: proposal } })
  await rt.secretEndpoint('secret-set', { name: 'EXISTING', value: 'saved-credential', scope: 'all' })
  const headers = { Authorization: 'Bearer $DSH_SECRET_EXISTING', 'X-Mode': ' one ', X_Mode: 'two' }
  const env = { TOKEN: '$DSH_SECRET_EXISTING', SHORT_TOKEN: 'short7!', DEBUG: '0', EMPTY: '', LONG: 'x'.repeat(16_385) }
  await call('add', { name: 'Remote', url: 'https://mcp.example.test', headers })
  await call('add', { name: 'Local', command: 'mcp', env })
  const { connectors } = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(connectors.remote.custom.headers, headers)
  assert.deepEqual(connectors.local.custom.env, env)
  assert.equal(rt.connectorsInternals.upstreamOf('remote').headers.Authorization, 'Bearer saved-credential')
  assert.deepEqual(mounts.find(mount => mount.serverName === 'local').env, { ...env, TOKEN: 'saved-credential' })
  assert.deepEqual(rt.secretsView().map(secret => secret.name), ['EXISTING'])
  assert.equal(rt.redactSecretsAnywhere('production two short7! Bearer'), 'production two short7! Bearer')
  assert.deepEqual(rt.learningView(), { m1: [proposal] })
})

test('add, import and dispatch reject non-loopback HTTP and URL userinfo', async (t) => {
  const io = transport(t)
  const { call, home, rt } = await team(t)
  const urls = [
    'http://localhost.example.test/mcp', 'http://127.example.test/mcp', 'http://192.0.2.1/mcp',
    'http://localhost@127.0.0.1/mcp', 'https://user:pass@example.test/mcp', 'http://@localhost/mcp',
    'https://:@example.test/mcp',
  ]
  const servers = Object.fromEntries(urls.map((url, i) => [`bad-${i}`, { url }]))
  const ipv6 = 'http://[0:0:0:0:0:0:0:1]:8000/mcp'
  servers.ipv6 = { url: ipv6 }
  const pick = importFrom(t, home, servers)
  for (const [i, url] of urls.entries()) {
    const name = `bad-${i}`
    await assert.rejects(call('add', { name, url }), /https/)
    await assert.rejects(call('import', pick(name)), /https/)
    assert.equal(rt.state.connectors?.[name], undefined)
    assert.deepEqual(await dispatch(io, url), { status: 502, body: JSON.stringify({ error: 'connector address must be https' }) })
  }
  assert.deepEqual(io.requests, [])
  assert.ok((await call('add', { name: 'IPv6', url: ipv6 })).connectors.some(row => row.id === 'ipv6'))
  assert.equal((await call('import', pick('ipv6'))).created.length, 1)
  assert.deepEqual(await dispatch(io, ipv6), { status: 200, body: 'ok' })
  assert.equal(io.requests.at(-1).protocol, http)
})

test('add, import and dispatch accept HTTPS, localhost and IPv4 loopback', async (t) => {
  const io = transport(t)
  const { call, home } = await team(t)
  const urls = [
    'https://mcp.example.test/mcp', 'http://localhost:8000/mcp', 'http://localhost.:8000/mcp',
    'http://127.99.1.2:8000/mcp',
  ]
  const servers = Object.fromEntries(urls.map((url, i) => [`good-${i}`, { serverUrl: url }]))
  const pick = importFrom(t, home, servers)
  for (const [name, { serverUrl: url }] of Object.entries(servers)) {
    assert.ok((await call('add', { name, url })).connectors.some(row => row.id === name))
    assert.equal((await call('import', pick(name))).created.length, 1)
    assert.deepEqual(await dispatch(io, url), { status: 200, body: 'ok' })
    assert.equal(io.requests.at(-1).protocol, new URL(url).protocol === 'http:' ? http : https)
  }
})
