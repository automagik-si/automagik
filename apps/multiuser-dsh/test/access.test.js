import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs, { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { createSigner } from '../../../server/gate-caller.mjs'
import * as adapter from '../index.js'
import { roleOf, visibleBotIds } from '../src/access.js'
import { MUX_PATH } from '../src/mux-carrier.js'
import { createSeen } from '../src/seen.js'
import { invoke, prefix, rpc, runtime, wire } from './runtime.mjs'

const instance = wire.payload.aud
const person = (role, subject = 'same-person') => ({ ...wire.payload.principal, subject, roles: [role] })
const caller = (role, subject) => ({ kind: 'automagik', instance, person: person(role, subject) })
const member = caller('member')
const guest = caller('guest')
const stranger = caller('guest', 'stranger')
const named = [{ issuer: member.person.issuer, subject: member.person.subject }]
const fact = (id, mode = 'workspace', allow = [], main = false) => ({ id, main, people: { mode, allow } })
const bots = (...facts) => ({ bots: () => facts })
const muxPublic = '/api/remote.mux'
const sessionAddress = { kind: 'session', sessionId: 'shared-session' }

async function host(t, { multiuser = '1', inventory = [], wireOpen, observeHttp } = {}) {
  const { ctx, webServer } = runtime(t)
  webServer.listenedPort = 54321
  const access = new RemoteAccessService(ctx)
  const typert = new TypertRegistry(ctx)
  for (const entry of inventory) {
    if (!entry.module.package.endsWith('/dsh-api-remote-access')) typert.register(entry.module)
  }
  const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}))
  if (wireOpen) gateway.wireStream.open = wireOpen
  if (observeHttp) {
    gateway.claimsEndpoint = endpoint => endpoint === 'fixture/seen'
    gateway.dispatchRpc = observeHttp
  }
  const dir = mkdtempSync(join(tmpdir(), 'caller-access-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const signer = createSigner({ dir, publicDir: dir, instance: () => instance })
  signer.publish()
  const read = fs.readFileSync
  const mount = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/mountinfo') return '2 1 0:2 / ' + dir + ' ro - tmpfs tmpfs rw'
    if (typeof file === 'string' && file.startsWith('/proc/self/fdinfo/')) return 'mnt_id:\t2\n'
    return read(file, ...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mount.mock.restore(); syncBuiltinESMExports() })
  const env = { AUTOMAGIK_MULTIUSER: multiuser, AUTOMAGIK_CALLER_KEYS: join(dir, 'caller-keys.json'),
    AUTOMAGIK_INSTANCE_ID: instance, DSH_HOME: dir }
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  Object.assign(process.env, env)
  const start = Date.now() - 10_000
  const clock = t.mock.method(Date, 'now', () => start)
  try {
    await ctx.plugin(adapter)
  } finally {
    clock.mock.restore()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  await tick()
  const service = ctx.get('automagikCaller')
  const authority = '127.0.0.1:54321'
  let families = 0
  const headers = (principal, method, path) => ({
    host: authority, 'content-type': 'application/json',
    'x-automagik-caller': principal && signer.sign({ principal: principal.person, familyId: 'family-' + ++families, method, path }),
  })
  const http = (principal, endpoint, args) => {
    const path = '/api/' + endpoint
    return invoke(webServer.match(prefix + path).handler, {
      url: prefix + path, method: 'POST', headers: headers(principal, 'POST', path),
      body: rpc(endpoint, { args }),
    })
  }
  const socket = principal => {
    const socket = new EventEmitter()
    let refused
    Object.assign(socket, {
      destroy() { this.emit('close') },
      end(bytes, finish) { refused = bytes; finish() },
    })
    const incoming = headers(principal, 'GET', muxPublic)
    const request = { method: 'GET', url: MUX_PATH, headers: incoming,
      rawHeaders: Object.entries(incoming).filter(([, value]) => value !== undefined).flat() }
    const out = []
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      close() {
        if (this.readyState !== WebSocket.OPEN) return
        this.readyState = WebSocket.CLOSED
        this.emit('close')
        socket.destroy()
      },
      terminate() { this.close() },
      send(data, done) { out.push(JSON.parse(data)); done() },
    })
    request.ws = ws
    webServer.upgrades.get(MUX_PATH).handler(request, socket, Buffer.alloc(0))
    t.after(() => ws.close())
    return {
      refused, out,
      open: (streamId, endpoint, args = {}) => ws.emit('message', Buffer.from(JSON.stringify({
        type: 'open', streamId, endpoint, payload: { args },
      })), false),
      close: () => ws.close(),
    }
  }
  return { access, gateway, service, http, socket, logs: () => ctx.logger.buffer }
}

function inProcessSockets(t) {
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (req, _socket, _head, accept) => accept(req.ws))
}

async function results(socket, count) {
  for (let tries = 0; socket.out.length < count && tries < 100; tries++) await tick()
  assert.equal(socket.out.length, count)
  return socket.out
}

let discovered
function inventory() {
  return discovered ??= (async () => {
    const names = new URL('../dev/harness/node_modules/@deepseek-ai/', import.meta.url)
    const modules = await Promise.all(readdirSync(names).sort().map(async name => {
      const url = new URL(name + '/lib/typert.host.js', names)
      if (!existsSync(url)) return
      return { name, module: (await import(pathToFileURL(fs.realpathSync(url)).href)).TYPERT }
    }))
    return modules.filter(entry => entry?.module?.invocations?.length)
  })()
}

test('A1 effective roles fail closed on unknown, malformed and owner or admin carrier roles', () => {
  for (const [roles, expected] of [
    [['member'], 'member'], [['guest'], 'guest'], [['guest', 'member'], 'member'],
    [['owner', 'member'], undefined], [['guest', 'admin'], undefined], [[], undefined],
    [['unknown'], undefined], ['member', undefined], [['member', 1], undefined],
  ]) {
    assert.equal(roleOf({ ...member, person: { ...member.person, roles } }), expected)
  }
  assert.equal(roleOf({ kind: 'owner' }), 'owner')
  assert.equal(roleOf({ kind: 'bot' }), undefined)
  assert.equal(roleOf(undefined), undefined)
})

test('A2 visibility uses role and exact identity across every mode and Main status', () => {
  for (const principal of [member, guest, stranger]) {
    for (const main of [false, true]) {
      const facts = bots(fact('owners', 'owners', named, main), fact('named', 'allowlist', named, main),
        fact('other', 'allowlist', [{ ...named[0], issuer: 'other' }], main),
        fact('workspace', 'workspace', [], main), fact('workspace-named', 'workspace', named, main),
        fact('bad-mode', 'public', named, main), fact('bad-allow', 'workspace', null, main),
        { id: 'missing', main })
      const expected = principal === stranger ? [] : ['named', 'workspace-named']
      if (principal === member && !main) expected.push('workspace')
      assert.deepEqual([...visibleBotIds(principal, facts)].sort(), expected.sort())
    }
  }
})

test('A3 both family orders preserve the guest restriction while native grants stay empty', async t => {
  const { access, service } = await host(t)
  service.provide(bots(fact('workspace'), fact('allowlist', 'allowlist', named)))
  for (const order of [[member, guest], [guest, member]]) {
    for (const principal of order) {
      assert.deepEqual([...service.visibleBotIds(principal)], principal === member ? ['workspace', 'allowlist'] : ['allowlist'])
      assert.deepEqual(access.snapshotFor(principal).grants, [])
    }
  }
})

test('A4 rejects ambiguous or oversized facts and warns once per throwing provider', async t => {
  const { service, logs } = await host(t)
  const malformed = fact('second-duplicate')
  malformed.main = 'false'
  const dispose = service.provide(bots(fact('valid'), fact(''), fact('x'.repeat(513)), fact(3),
    fact('duplicate'), fact('duplicate'), malformed, fact('second-duplicate'), { id: 'invalid-main', main: 0 }))
  assert.deepEqual([...service.visibleBotIds(member)], ['valid'])
  assert.throws(() => service.provide(bots()), /already registered/)
  dispose()
  assert.deepEqual([...service.visibleBotIds(member)], [])
  const overflow = service.provide(bots(...Array.from({ length: 4097 }, (_, i) => fact(String(i)))))
  assert.deepEqual([...service.visibleBotIds(member)], [])
  overflow()
  const baseline = logs().length
  const throwing = service.provide({ *bots() { yield fact('valid'); throw new Error('private provider data') } })
  assert.deepEqual([...service.visibleBotIds(member)], [])
  assert.deepEqual([...service.visibleBotIds(guest)], [])
  const warnings = JSON.stringify(logs().slice(baseline), (key, value) => key === 'meta' ? undefined : value)
  assert.equal(warnings.match(/caller visibility provider failed/g)?.length, 1)
  assert.doesNotMatch(warnings, /private provider data/)
  throwing()
})

test('A5 every installed native action and forwarded event defaults to denial', async t => {
  const { access, service } = await host(t)
  service.provide(bots(fact('visible', 'workspace', named)))
  const methods = (await inventory()).flatMap(({ module }) =>
    module.invocations.map(({ namespace, method }) => namespace + '/' + method))
  for (const method of ['session/prompt', 'session/list', 'session/events', 'session/follow', 'session/control', 'workspace/follow']) {
    assert.ok(methods.includes(method), method)
  }
  for (const namespace of ['terminal/', 'settings/']) assert.ok(methods.some(method => method.startsWith(namespace)))
  assert.ok(API_REMOTE_FORWARDED_EVENTS.length > 0)
  t.diagnostic(methods.length + ' installed invocation descriptors; ' + API_REMOTE_FORWARDED_EVENTS.length + ' forwarded events')
  const actions = [...new Set(methods), ...API_REMOTE_FORWARDED_EVENTS.map(({ event }) => 'event:' + event), 'fixture/unknown']
  for (const principal of [member, guest]) {
    assert.deepEqual([...service.visibleBotIds(principal)], ['visible'])
    for (const action of actions) {
      for (const resource of [{ kind: 'global' }, { kind: 'session', id: sessionAddress.sessionId }, { kind: 'workspace', id: '/shared-workspace' }]) {
        const decision = access.decide({ principal, action, resources: [resource] })
        assert.deepEqual(decision, action === 'remoteAccess/follow' ? { kind: 'allow' } : { kind: 'deny', reason: 'no-allow' }, action)
      }
    }
  }
})

const sessionOnly = async () => (await inventory()).filter(({ name }) =>
  ['dsh-api-session-controller', 'dsh-api-workspace-controller', 'dsh-api-settings-controller', 'dsh-api-terminal-controller'].includes(name))

test('A6 real unary gateway rejects native reads, prompting, settings and terminal calls', async t => {
  const f = await host(t, { inventory: await sessionOnly() })
  f.service.provide(bots(fact('visible')))
  for (const [endpoint, args] of [
    ['session/list', { _request: {} }],
    ['session/prompt', { request: { requestId: 'prompt-1', sessionId: sessionAddress.sessionId, mode: 'queue', content: [{ type: 'text', text: 'fixture' }] } }],
    ['session/page', { request: { address: sessionAddress } }],
    ['session/events', { request: { address: sessionAddress } }],
    ['settings/describe', {}],
    ['terminal/list', { sessionId: sessionAddress.sessionId }],
  ]) {
    const response = await f.http(member, endpoint, args)
    assert.equal(response.status, 200, endpoint)
    const result = JSON.parse(response.bytes).result
    assert.equal(result?.error?.code, 'remote-access/denied', endpoint + ': ' + JSON.stringify(result))
    assert.equal(result.error.details.reason, 'no-allow', endpoint)
  }
})

test('A7 frozen v2 remembers only admitted HTTP and upgrade identities, up to 1000', async t => {
  inProcessSockets(t)
  const f = await host(t)
  assert.ok(Object.isFrozen(f.service))
  assert.equal(f.service.version, 2)
  assert.equal(f.service.multiuser, true)
  assert.equal(f.service.current(), undefined)
  assert.equal((await f.http(undefined, 'fixture/no-such-endpoint', {})).status, 401)
  assert.match(f.socket(undefined).refused, /^HTTP\/1\.1 401/)
  assert.deepEqual(f.service.seen(), [])
  await f.http(caller('member', 'http-admitted'), 'fixture/no-such-endpoint', {})
  assert.equal(f.socket(caller('guest', 'mux-admitted')).refused, undefined)
  const records = f.service.seen()
  assert.deepEqual(records.map(row => row.subject).sort(), ['http-admitted', 'mux-admitted'])
  assert.ok(Object.isFrozen(records) && records.every(row => Object.isFrozen(row) && Object.isFrozen(row.roles)))
  const seen = createSeen({ now: (() => { let time = 0; return () => ++time })() })
  for (let id = 0; id <= 1000; id++) seen.record(person('member', String(id)))
  assert.equal(seen.list().length, 1000)
  assert.equal(seen.list().at(-1).subject, '1')
  seen.record(person('guest', '1'))
  assert.deepEqual(seen.list()[0].roles, ['guest'])
})

test('A8 real carried mux refuses native stream opens and only grants protocol baselines', async t => {
  inProcessSockets(t)
  const f = await host(t, { inventory: await sessionOnly() })
  f.service.provide(bots(fact('visible', 'workspace', named)))
  const notices = [Promise.withResolvers(), Promise.withResolvers()]
  const remove = f.gateway.registerRemoteEvents(async function* (signal) {
    for (const notice of notices) {
      await notice.promise
      yield { event: API_REMOTE_FORWARDED_EVENTS[0].event, args: ['fixture'] }
    }
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }, { home: '/fixture' })
  t.after(() => { for (const notice of notices) notice.resolve(); return remove() })
  for (const [principal, notice] of [[member, notices[0]], [guest, notices[1]]]) {
    const mux = f.socket(principal)
    assert.equal(mux.refused, undefined)
    for (const [endpoint, args] of [
      ['session/control', {}], ['session/follow', { request: { address: sessionAddress } }],
      ['workspace/follow', {}], ['remoteAccess/follow', {}], ['$events', {}],
    ]) mux.open(endpoint, endpoint, args)
    const frames = await results(mux, 5)
    for (const endpoint of ['session/control', 'session/follow', 'workspace/follow']) {
      const frame = frames.find(frame => frame.streamId === endpoint)
      assert.equal(frame?.error?.code, 'remote-access/denied', JSON.stringify(frame))
    }
    assert.deepEqual(frames.find(frame => frame.streamId === 'remoteAccess/follow').value, { type: 'baseline', owner: false, grants: [] })
    const ready = frames.find(frame => frame.streamId === '$events')
    assert.equal(ready?.value?.type, 'ready', JSON.stringify(ready))
    notice.resolve()
    await tick()
    assert.equal(frames.filter(frame => frame.streamId === '$events' && frame.type === 'item').length, 1)
    mux.close()
  }
})

test('A9 a v2 adapter without a provider and an off-mode adapter have no visibility by default', async t => {
  const active = await host(t)
  assert.deepEqual([...active.service.visibleBotIds(member)], [])
  const off = await host(t, { multiuser: '0' })
  assert.equal(off.service.multiuser, false)
  const dispose = off.service.provide(bots(fact('visible-if-enabled')))
  assert.deepEqual([...off.service.visibleBotIds(member)], [])
  dispose()
})

test('A10 the admitted identity list refuses in carried HTTP and stream callbacks', async t => {
  inProcessSockets(t)
  let f
  let streamRead = false
  let httpRead = false
  f = await host(t, {
    wireOpen: async () => {
      streamRead = true
      assert.throws(() => f.service.seen(), /admitted-person list/)
      return [{ verified: true }]
    },
    observeHttp: () => {
      httpRead = true
      assert.throws(() => f.service.seen(), /admitted-person list/)
      return { ok: true, value: 'verified' }
    },
  })
  const mux = f.socket(caller('member', 'stream'))
  mux.open('scope', 'remoteAccess/follow')
  await results(mux, 2)
  assert.equal(streamRead, true)
  assert.deepEqual(mux.out[0].value, { verified: true })
  assert.equal((await f.http(caller('guest', 'http'), 'fixture/seen', {})).status, 200)
  assert.equal(httpRead, true)
  assert.deepEqual(f.service.seen().map(row => row.subject).sort(), ['http', 'stream'])
})

test('A11 the adapter and gate share the whole-array role rule', async () => {
  const { roles } = (await import('../../../server/test/fixtures/caller-role-paths.json', { with: { type: 'json' } })).default
  for (const row of roles) {
    const expected = row.role === 'member' || row.role === 'guest' ? row.role : undefined
    assert.equal(roleOf({ kind: 'automagik', person: { roles: row.roles } }), expected, JSON.stringify(row))
  }
})
