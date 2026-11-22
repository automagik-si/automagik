import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as immediate } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { createGateway } from '../src/host/connectors/gateway.js'
import { CONNECTOR_KEY, CREDENTIAL_UNAVAILABLE, KEY_ERROR } from '../src/host/connectors/credential-key.js'
import { fakeContext } from './fake-ctx.js'

// Exercise the real gateway routing without opening sockets or resolving names.
function transport(t) {
  const requests = []
  const listeners = []
  const io = { listeners, requests, error: undefined }
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
      if (io.error !== undefined) throw io.error(options.headers)
      return Object.assign(new EventEmitter(), { end: () => {
        response(Object.assign(Readable.from(['ok']), { statusCode: 200, headers: {} }))
      } })
    })
  }
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return io
}

async function team(t, extra = {}, learning) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-connector-security-'))
  const contexts = []
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
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
  const open = async (options = {}) => {
    const ctx = fakeContext({ services: { loader: { import: async () => ({ name: 'mcp', apply() {} }) } } })
    const register = ctx.connection.fetch.register
    let route
    ctx.connection.fetch.register = options => {
      if (options.path === '/api/omni-ui') route = options
      return register(options)
    }
    const post = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))).json()
    const mounts = []
    const warnings = []
    ctx.plugin = (_plugin, config) => {
      mounts.push(config)
      return { await: async () => options.start?.(config), dispose: () => options.dispose?.(config) }
    }
    const rt = createRuntime(ctx, { home, github: false, ...options.config })
    rt.warn = (...args) => warnings.push(args)
    contexts.push(ctx)
    await rt.load()
    return { ctx, rt, mounts, warnings, post, call: (name, body) => rt.connectorEndpoint(`connector-${name}`, body) }
  }
  const first = await open()
  return { ...first, home, path, open }
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
    return await dispatchTo(io, gw, 'svc')
  } finally { await gw.close() }
}

async function dispatchTo(io, gw, id) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET', url: new URL(gw.urlFor(id)).pathname, headers: { authorization: gw.headers().Authorization },
  })
  const res = new PassThrough()
  res.writeHead = status => { res.statusCode = status }
  io.listeners.at(-1)(req, res)
  let body = ''
  for await (const chunk of res) body += chunk
  return { status: res.statusCode, body }
}

const onDisk = path => JSON.parse(readFileSync(path, 'utf8'))
const envValue = (saved, id, name = 'TOKEN') => saved.connectors[id].custom.env[name]
const fakeValue = ['fixture', 'credential9'].join('-')

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

test('connector snapshots keep credentials encrypted at rest and preserve settings through restart', async (t) => {
  const io = transport(t)
  const { ctx, home, path, open } = await team(t)
  const legacyObject = { enc: 'v1', kid: '1'.repeat(16), iv: 'AAAAAAAAAAAAAAAA', data: 'YQ==', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', parts: [null] }
  const mixed = `  Bearer ${fakeValue}  $DSH_SECRET_REF  extra text repeats ${fakeValue}  `
  const headers = { Authorization: mixed, 'X-Mode': ' one ', 'X-Token': legacyObject, 'X-Secret': 'Bearer $DSH_SECRET_REF' }
  const env = { TOKEN: `${fakeValue}-env`, AUTH_MODE: 'production', OBJECT_TOKEN: { literal: 'a setting' } }
  const baseline = { version: 2, connectors: {
    remote: { custom: { name: 'Remote', url: 'https://mcp.example.test', headers } },
    local: { custom: { name: 'Local', command: 'mcp', env } },
  } }
  assert.equal(onDisk(path).version, 2)
  writeFileSync(path, JSON.stringify({ ...onDisk(path), ...baseline }))
  await ctx.dispose()
  const writer = await open()
  assert.equal(onDisk(path).version, 2)
  assert.deepEqual(writer.rt.state.connectors, baseline.connectors)
  await writer.call('set', { id: 'remote', readOnly: true })
  await writer.rt.secretEndpoint('secret-set', { name: 'REF', value: 'before-rotation', scope: [] })
  const saved = onDisk(path)
  assert.equal(saved.version, 3)
  const key = join(home, CONNECTOR_KEY)
  if (process.platform !== 'win32') assert.equal(statSync(key).mode & 0o777, 0o600)
  const keyBytes = readFileSync(key)
  assert.equal(keyBytes.length, 32)
  const kid = createHash('sha256').update(keyBytes).digest('hex').slice(0, 16)
  const envelope = saved.connectors.remote.custom.headers.Authorization
  assert.equal(readFileSync(path, 'utf8').includes(fakeValue), false)
  assert.deepEqual(envelope.parts, [null, '$DSH_SECRET_REF', null])
  for (const field of [envelope, envValue(saved, 'local')]) {
    assert.equal(field.enc, 'v1')
    assert.equal(field.kid, kid)
    assert.equal(Buffer.from(field.iv, 'base64').length, 12)
    assert.equal(Buffer.from(field.tag, 'base64').length, 16)
  }
  assert.equal(saved.connectors.remote.custom.headers['X-Secret'], headers['X-Secret'])
  assert.equal(saved.connectors.remote.custom.headers['X-Mode'], headers['X-Mode'])
  assert.equal(saved.connectors.local.custom.env.AUTH_MODE, env.AUTH_MODE)
  await writer.rt.save()
  assert.notEqual(envValue(onDisk(path), 'local').iv, envValue(saved, 'local').iv)
  assert.deepEqual(readFileSync(key), keyBytes)
  await writer.ctx.dispose()
  const reader = await open()
  await reader.rt.secretEndpoint('secret-set', { name: 'REF', value: 'after-rotation', scope: [] })
  await reader.call('retry', { id: 'remote' })
  assert.deepEqual(reader.rt.state.connectors.remote.custom.headers, headers)
  assert.deepEqual(reader.mounts.find(mount => mount.serverName === 'local').env, { ...env, OBJECT_TOKEN: '[object Object]' })
  assert.deepEqual(await dispatchTo(io, reader.rt.connectorsInternals.gateways.gw, 'remote'), { status: 200, body: 'ok' })
  assert.equal(io.requests.at(-1).headers.Authorization, mixed.replace('$DSH_SECRET_REF', 'after-rotation'))
  const execute = reader.ctx.listeners.get('tools/execute').find(listener => listener.name === 'redactToolResult')
  assert.deepEqual(await execute({}, async () => ({ value: env.TOKEN })), { value: '[secret:CONNECTOR_LOCAL_TOKEN]' })
})

test('state saves retain the committed envelope and connector writes require encryption', async (t) => {
  transport(t)
  const { home, path, rt, call, mounts } = await team(t)
  await call('add', { name: 'Local', command: 'mcp', env: { TOKEN: fakeValue } })
  const key = join(home, CONNECTOR_KEY)
  const envelope = envValue(onDisk(path), 'local')
  rmSync(key)
  rt.state.prefs.marker = 'ordinary save'
  await rt.save()
  assert.deepEqual(envValue(onDisk(path), 'local'), envelope)
  await rt.saveCopy(copy => { copy.prefs.marker = 'eager copy' })
  assert.equal(onDisk(path).prefs.marker, 'eager copy')
  assert.deepEqual(envValue(onDisk(path), 'local'), envelope)
  await rt.saveCopy(copy => { copy.prefs.marker = 'deferred copy' }, { afterWrite: () => {} })
  assert.equal(onDisk(path).prefs.marker, 'deferred copy')
  assert.deepEqual(envValue(onDisk(path), 'local'), envelope)
  const saved = readFileSync(path)
  await assert.rejects(call('add', { name: 'New', command: 'mcp', env: { TOKEN: `${fakeValue}-new` } }), { message: KEY_ERROR })
  await assert.rejects(rt.saveCopy(copy => { copy.connectors.local.custom.env.TOKEN = `${fakeValue}-edit` }, {
    afterWrite: () => assert.fail('unexpected connector edit'),
  }), { message: KEY_ERROR })
  assert.deepEqual(readFileSync(path), saved)
  assert.equal(rt.state.connectors.new, undefined)
  assert.equal(rt.state.connectors.local.custom.env.TOKEN, fakeValue)
  assert.equal(mounts.some(mount => mount.serverName === 'new'), false)
  assert.equal(existsSync(key), false)
})

test('credentials authenticate their field and key, with independent connector recovery', async (t) => {
  const io = transport(t)
  const { ctx, home, path, call, open } = await team(t)
  await call('add', { name: 'Moved header', url: 'https://mcp.example.test', headers: { TOKEN: fakeValue } })
  await call('add', { name: 'Moved env', command: 'mcp', env: { TOKEN: fakeValue } })
  await call('add', { name: 'Wrong key', command: 'mcp', env: { TOKEN: fakeValue } })
  await call('add', { name: 'Malformed', command: 'mcp', env: { TOKEN: fakeValue } })
  await call('add', { name: 'Recovery', command: 'mcp', env: { TOKEN: fakeValue } })
  await call('add', { name: 'Sibling', command: 'mcp', env: { TOKEN: 'unavailable' } })
  await ctx.dispose()
  const saved = onDisk(path)
  const rows = saved.connectors
  const headers = rows['moved-header'].custom.headers
  headers.OTHER_TOKEN = headers.TOKEN
  delete headers.TOKEN
  const moved = rows['moved-env'].custom
  moved.headers = { TOKEN: moved.env.TOKEN }
  delete moved.env.TOKEN
  rows['wrong-key'].custom.env.TOKEN.kid = '0'.repeat(16)
  rows.malformed.custom.env.TOKEN.iv = 'invalid'
  writeFileSync(path, JSON.stringify(saved))
  const key = join(home, CONNECTOR_KEY)
  renameSync(key, `${key}.saved`)
  const writer = await open()
  const view = await writer.call('retry', { id: 'sibling' })
  for (const id of ['moved-header', 'moved-env', 'wrong-key', 'malformed', 'recovery']) {
    assert.equal(view.connectors.find(row => row.id === id).error, CREDENTIAL_UNAVAILABLE)
    assert.equal(writer.mounts.some(mount => mount.serverName === id), false)
  }
  assert.equal(writer.mounts.find(mount => mount.serverName === 'sibling').env.TOKEN, 'unavailable')
  assert.throws(() => writer.rt.connectorsInternals.upstreamOf('moved-header'), { message: CREDENTIAL_UNAVAILABLE })
  assert.deepEqual(io.requests, [])
  await writer.rt.save()
  assert.deepEqual(onDisk(path).connectors, rows)
  renameSync(`${key}.saved`, key)
  const recovered = await writer.call('retry', { id: 'recovery' })
  assert.equal(recovered.connectors.find(row => row.id === 'recovery').state, 'ready')
  for (const id of ['moved-header', 'moved-env', 'wrong-key', 'malformed']) {
    assert.equal(recovered.connectors.find(row => row.id === id).error, CREDENTIAL_UNAVAILABLE)
  }
  const removed = await writer.call('remove', { id: 'wrong-key' })
  assert.equal(removed.connectors.some(row => row.id === 'wrong-key'), false)
  const replaced = await writer.call('add', { name: 'Wrong key', command: 'mcp', env: { TOKEN: `${fakeValue}-replacement` } })
  assert.equal(replaced.connectors.find(row => row.id === 'wrong-key').state, 'ready')
  assert.equal(JSON.stringify(replaced).includes(fakeValue), false)
  assert.equal(envValue(onDisk(path), 'wrong-key').enc, 'v1')
})

test('Settings directs users to restore the key and retry without recreating the connector', async (t) => {
  transport(t)
  const { ctx, home, path, call, open } = await team(t)
  const spec = { name: 'Local', command: 'mcp', args: ['--custom'], env: { TOKEN: fakeValue } }
  await call('add', spec)
  await ctx.dispose()
  const key = join(home, CONNECTOR_KEY)
  renameSync(key, `${key}.saved`)
  const writer = await open()
  const saved = readFileSync(path)
  const before = await writer.post('connector-retry', { id: 'local' })
  assert.equal(before.ok, true)
  assert.match(before.value.connectors.find(row => row.id === 'local').error, /Restore the matching connector key and try again/)
  renameSync(`${key}.saved`, key)
  const after = await writer.post('connector-retry', { id: 'local' })
  assert.equal(after.ok, true)
  assert.equal(after.value.connectors.find(row => row.id === 'local').state, 'ready')
  assert.equal(JSON.stringify(after).includes(fakeValue), false)
  const mount = writer.mounts.find(mount => mount.serverName === 'local')
  assert.equal(mount.env.TOKEN, fakeValue)
  assert.deepEqual(mount.args, spec.args)
  assert.deepEqual(readFileSync(path), saved)
})

test('a replaced key cannot add slots to an encrypted team before or after restart', async (t) => {
  transport(t)
  const { ctx, home, path, rt, call, open } = await team(t)
  await call('add', { name: 'Original', command: 'mcp', env: { TOKEN: fakeValue } })
  const key = join(home, CONNECTOR_KEY)
  renameSync(key, `${key}.saved`)
  writeFileSync(key, Buffer.alloc(32, 3), { mode: 0o600 })
  const saved = readFileSync(path)
  const add = { name: 'New', command: 'mcp', env: { TOKEN: `${fakeValue}-new` } }
  await assert.rejects(call('add', add), { message: KEY_ERROR })
  assert.deepEqual(readFileSync(path), saved)
  rt.state.connectors.new = { custom: add }
  await assert.rejects(rt.save(), { message: KEY_ERROR })
  assert.deepEqual(readFileSync(path), saved)
  delete rt.state.connectors.new
  await ctx.dispose()
  const restarted = await open()
  assert.equal(restarted.rt.connectorsView().connectors.find(row => row.id === 'original').error, CREDENTIAL_UNAVAILABLE)
  await assert.rejects(restarted.call('add', add), { message: KEY_ERROR })
  assert.deepEqual(readFileSync(path), saved)

  const dest = mkdtempSync(join(tmpdir(), 'dsb-connector-import-'))
  const importCtx = fakeContext()
  t.after(async () => { await importCtx.dispose(); rmSync(dest, { recursive: true, force: true }) })
  assert.throws(() => createRuntime(importCtx, { home: dest, importHome: home }), /matching connector key/)
  assert.equal(existsSync(join(dest, 'state.json')), false)
  renameSync(`${key}.saved`, key)
  const imported = createRuntime(importCtx, { home: dest, importHome: home })
  await imported.load()
  assert.equal(envValue(imported.state, 'original'), fakeValue)
  assert.equal(imported.state.connectors.new, undefined)
})

test('a reader stops using an unavailable credential and keeps its healthy sibling mounted', async (t) => {
  const io = transport(t)
  const { ctx, home, path, call, open } = await team(t)
  await call('add', { name: 'Remote', url: 'https://mcp.example.test', headers: { TOKEN: fakeValue } })
  await call('add', { name: 'Sibling', command: 'mcp' })
  await ctx.dispose()
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ token: 'writer', host: os.hostname(), pid: process.ppid }))
  const disposed = []
  const reader = await open({ dispose: config => disposed.push(config.serverName) })
  assert.match(reader.rt.readOnly(), /open in another dsh/)
  await reader.rt.connectorStateChanged()
  disposed.length = 0
  const gateway = reader.rt.connectorsInternals.gateways.gw
  assert.equal((await dispatchTo(io, gateway, 'remote')).status, 200)
  const key = join(home, CONNECTOR_KEY)
  renameSync(key, `${key}.saved`)
  writeFileSync(path, JSON.stringify({ ...onDisk(path), check: 'reader refresh' }))
  await reader.rt.refresh()
  assert.equal(reader.rt.connectorsView().connectors.find(row => row.id === 'remote').error, CREDENTIAL_UNAVAILABLE)
  assert.equal((await dispatchTo(io, gateway, 'remote')).status, 502)
  assert.equal(io.requests.length, 1)
  await immediate()
  assert.deepEqual(disposed, ['remote'])
  assert.equal(reader.rt.connectorsView().connectors.find(row => row.id === 'sibling').state, 'ready')
  renameSync(`${key}.saved`, key)
  const beforeRetry = readFileSync(path)
  const refusal = await reader.post('connector-retry', { id: 'remote' })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.error.code, 'bot/read-only')
  assert.match(refusal.error.message, /Try again in the window that can edit the Bot team/)
  assert.deepEqual(readFileSync(path), beforeRetry)
})

test('mount status and gateway warnings mask restored connector credentials', async (t) => {
  const io = transport(t)
  const { ctx, call, open } = await team(t)
  await call('add', { name: 'Local', command: 'mcp', env: { TOKEN: fakeValue } })
  await call('add', { name: 'Remote', url: 'https://mcp.example.test', headers: { Authorization: `Bearer ${fakeValue}-remote` } })
  await ctx.dispose()
  const { call: retry, rt, warnings } = await open({ start: config => {
    if (config.serverName === 'local') throw new Error(`Transport said ${config.env.TOKEN}`)
  } })
  const view = await retry('retry', { id: 'local' })
  assert.match(view.connectors.find(row => row.id === 'local').error, /Transport said \[secret:CONNECTOR_LOCAL_TOKEN\]/)
  io.error = headers => new Error(`Transport said ${headers.Authorization}`)
  assert.equal((await dispatchTo(io, rt.connectorsInternals.gateways.gw, 'remote')).status, 502)
  const logs = JSON.stringify(warnings)
  assert.match(logs, /\[secret:CONNECTOR_LOCAL_TOKEN\]/)
  assert.match(logs, /\[secret:CONNECTOR_REMOTE_HEAD_AUTHORIZATION\]/)
  assert.equal(logs.includes(fakeValue), false)
})

test('team imports retain the matching host key and keep key temporaries local', async (t) => {
  transport(t)
  const { home, call } = await team(t)
  await call('add', { name: 'Local', command: 'mcp', env: { TOKEN: fakeValue } })
  writeFileSync(join(home, `${CONNECTOR_KEY}.sample.tmp`), 'host only', { mode: 0o600 })
  mkdirSync(join(home, 'notes'))
  for (const name of [CONNECTOR_KEY, `${CONNECTOR_KEY}.sample.tmp`]) writeFileSync(join(home, 'notes', name), 'user file')
  const dest = mkdtempSync(join(tmpdir(), 'dsb-connector-import-'))
  const key = join(dest, CONNECTOR_KEY)
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(dest, { recursive: true, force: true }) })
  writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 })
  assert.throws(() => createRuntime(ctx, { home: dest, importHome: home }), /matching connector key/)
  assert.equal(existsSync(join(dest, 'state.json')), false)
  rmSync(key)
  const imported = createRuntime(ctx, { home: dest, importHome: home })
  await imported.load()
  assert.deepEqual(readFileSync(key), readFileSync(join(home, CONNECTOR_KEY)))
  if (process.platform !== 'win32') assert.equal(statSync(key).mode & 0o777, 0o600)
  assert.equal(existsSync(join(dest, `${CONNECTOR_KEY}.sample.tmp`)), false)
  for (const name of [CONNECTOR_KEY, `${CONNECTOR_KEY}.sample.tmp`]) {
    assert.equal(readFileSync(join(dest, 'notes', name), 'utf8'), 'user file')
  }
  assert.equal(envValue(imported.state, 'local'), fakeValue)
})

test('file tools guard both copies of an imported connector key after restart', async (t) => {
  transport(t)
  const { home, call } = await team(t)
  await call('add', { name: 'Local', command: 'mcp', env: { TOKEN: fakeValue } })
  const dest = mkdtempSync(join(tmpdir(), 'dsb-connector-import-'))
  const importCtx = fakeContext()
  const restartCtx = fakeContext()
  restartCtx.workspaceRegistry = new Map()
  t.after(async () => { await restartCtx.dispose(); await importCtx.dispose(); rmSync(dest, { recursive: true, force: true }) })
  await createRuntime(importCtx, { home: dest, importHome: home }).load()
  await importCtx.dispose()
  await createRuntime(restartCtx, { home: dest }).load()
  const agent = { id: 'm1', session: { id: 'm1', header: { cwd: dest } } }
  const execute = (name, args) => restartCtx.listeners.get('tools/execute').reduceRight((next, listener) =>
    () => listener({ name, arguments: args, agent }, next), () => 'ran')()
  for (const root of [dest, home]) {
    await assert.rejects(execute('read', { file_path: join(root, CONNECTOR_KEY) }), /belongs to the Bot team's host/)
    await assert.rejects(execute('grep', { path: root }), /belongs to the Bot team's host/)
  }
})

test('importing an ordinary team works without hard-link support', async (t) => {
  const { home, path } = await team(t)
  const dest = mkdtempSync(join(tmpdir(), 'dsb-connector-import-'))
  const ctx = fakeContext()
  t.after(async () => { await ctx.dispose(); rmSync(dest, { recursive: true, force: true }) })
  const link = t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' }) })
  const imported = createRuntime(ctx, { home: dest, importHome: home })
  assert.deepEqual(readFileSync(imported.statePath), readFileSync(path))
  assert.equal(link.mock.callCount(), 0)
  await imported.load()
  assert.equal(onDisk(imported.statePath).version, 2)
})
