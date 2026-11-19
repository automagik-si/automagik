import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { AcpAdapter } from '../src/host/adapter.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'
import { assertLoadable, bridgeHost, resultsOf, ticks } from './support/bridge-host.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

function host(t, options) {
  const h = bridgeHost(options)
  h.originalAppend = h.session.append
  h.mint()
  t.after(() => h.backchannel.dispose())
  return h
}

// Drive the HTTP handler with a writable request so a takeover can happen during its body read.
function wire(h, attachment, { record = h.record, credential = record.credential } = {}) {
  const headers = {
    authorization: `Bearer ${credential}`,
    ...(attachment === undefined ? {} : { 'x-dsh-bridge-attachment': attachment }),
  }
  const start = () => {
    const request = Object.assign(new PassThrough(), { headers, method: 'POST', url: record.path })
    const response = new EventEmitter()
    let status
    let body
    response.writeHead = code => { status = code }
    response.end = json => { body = JSON.parse(json) }
    const answer = h.backchannel.handle(request, response).then(() => ({ status, body }))
    return { answer, send: (op, fields) => request.end(JSON.stringify({ op, ...fields })) }
  }
  return {
    start,
    post(op, fields) {
      const { send, answer } = start()
      send(op, fields)
      return answer
    },
  }
}

test('only a valid handshake takes over, resets listed and wakes the old poll', { timeout: 2000 }, async t => {
  const h = host(t)
  const a = wire(h, A)
  const b = wire(h, B)
  const legacy = wire(h)
  assert.equal((await wire(h, 'A'.repeat(32)).post('list')).status, 400)
  assert.equal(h.record.attachment, undefined)
  assert.equal((await legacy.post('unknown')).status, 400)
  assert.equal((await a.post('list')).status, 200)
  for (const op of ['unknown', 'call', 'wait']) assert.equal((await b.post(op)).status, 401, op)
  assert.equal(h.record.attachment, A)
  assert.equal(h.record.listed, true)
  assert.equal(h.record.retired.size, 0)

  const parked = a.post('wait')
  await ticks()
  assert.equal(h.record.waiters.size, 1)
  assert.equal((await b.post('hello')).status, 200)
  assert.equal((await parked).status, 200)
  assert.equal(h.record.waiters.size, 0)
  assert.equal(h.record.listed, false)
  assert.equal((await a.post('bye')).status, 401)
  assert.equal((await a.post('wait')).status, 401)
  assert.equal((await b.post('unknown')).status, 400)
  assert.equal(h.record.attachment, B)
  assert.equal(h.record.disconnected, false)
  assert.equal((await b.post('list')).status, 200)
  assert.equal(h.record.listed, true)
})

test('malformed attachment headers are refused without changing the current attachment', async t => {
  const h = host(t)
  const a = wire(h, A)
  await a.post('list')
  for (const id of ['', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)]) {
    assert.equal((await wire(h, id).post('list')).status, 400, id)
    assert.equal(h.record.attachment, A)
    assert.equal(h.record.retired.size, 0)
  }
})

test('an unlisted process bye leaves the current attachment alone, while current bye wakes its poll', { timeout: 2000 }, async t => {
  const h = host(t)
  const a = wire(h, A)
  const b = wire(h, B)
  await a.post('list')
  assert.deepEqual(await b.post('bye'), { status: 200, body: { ok: true } })
  assert.equal(h.record.attachment, A)
  assert.equal(h.record.disconnected, false)
  assert.equal((await b.post('list')).status, 401)

  const parked = a.post('wait')
  await ticks()
  assert.equal(h.record.waiters.size, 1)
  assert.deepEqual(await a.post('bye'), { status: 200, body: { ok: true } })
  assert.equal((await parked).status, 200)
  assert.equal(h.record.waiters.size, 0)
  assert.equal(h.record.disconnected, true)
  assert.equal((await a.post('list')).status, 401)
})

test('ready waits for the replacement list after its hello resets listed', { timeout: 2000 }, async t => {
  const h = host(t)
  await wire(h, A).post('list')
  const b = wire(h, B)
  assert.equal((await b.post('hello')).status, 200)
  assert.equal(h.record.listed, false)
  const adapter = new AcpAdapter({}, new Map(), { backchannel: h.backchannel })
  let ready = false
  const waiting = adapter.ready({ bridgeReadyMs: 1000 }, { bridge: h.record }).then(() => { ready = true })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(ready, false)
  assert.equal((await b.post('list')).status, 200)
  // ready's own poll timer is unref'ed; the watchdog keeps the loop alive until it resumes.
  let watchdog
  try {
    await Promise.race([waiting, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('ready did not resume after list')), 1000)
    })])
  } finally {
    clearTimeout(watchdog)
  }
  assert.equal(ready, true)
})

test('a Session credential stays bound to its path after detach and revocation releases its guard', async t => {
  const h = host(t)
  const a = wire(h, A)
  await a.post('list')
  assert.equal((await wire(h).post('bye')).status, 200)
  assert.equal(h.record.disconnected, true)
  assert.equal((await a.post('list')).status, 401)
  assert.notEqual(h.session.append, h.originalAppend)
  const other = h.backchannel.mint({ sessionId: 'other', agent: h.agent })
  assert.equal((await wire(h, B, { credential: other.credential }).post('list')).status, 401)
  assert.equal((await wire(h, B, { record: other, credential: h.record.credential }).post('list')).status, 401)
  h.backchannel.revoke(other)
  h.backchannel.revoke(h.record)
  assert.equal(h.backchannel.records.has(h.record.credential), false)
  assert.equal(h.record.retired.size, 0)
  assert.equal(h.session.append, h.originalAppend)
})

test('a request whose body arrives after retirement or revocation is refused', async t => {
  const h = host(t)
  const a = wire(h, A)
  const b = wire(h, B)
  await a.post('list')
  const old = a.start()
  await b.post('list')
  old.send('list')
  assert.equal((await old.answer).status, 401)
  assert.equal(h.record.attachment, B)

  const revoked = b.start()
  h.backchannel.revoke(h.record)
  revoked.send('list')
  assert.equal((await revoked.answer).status, 401)
})

test('the 65th retirement revokes the credential', async t => {
  const h = host(t)
  await wire(h, A).post('list')
  for (let i = 0; i < 64; i += 1) {
    const id = i.toString(16).padStart(32, '0')
    assert.deepEqual(await wire(h, id).post('bye'), { status: 200, body: { ok: true } })
  }
  assert.equal(h.record.retired.size, 64)
  assert.equal(h.record.attachment, A)
  assert.equal((await wire(h, B).post('list')).status, 401)
  assert.equal(h.record.closed, true)
  assert.equal(h.record.retired.size, 0)
  assert.equal(h.backchannel.records.has(h.record.credential), false)
})

test('bye withdraws a pending approval and settles its row once before the replacement runs', async t => {
  const h = host(t, { level: 'manual' })
  h.startTurn()
  h.startStep()
  const a = wire(h, A)
  const b = wire(h, B)
  await a.post('list')
  const first = a.post('call', { name: 'bash', callId: 'bridge_first' })
  await ticks()
  const [{ request }] = h.asks
  assert.equal(request.signal.aborted, false)
  assert.equal((await a.post('bye')).status, 200)
  assert.equal(request.signal.aborted, true)
  // A grant that was already on its way must not run the retired process's tool.
  assert.equal(h.answer(), true)
  assert.equal((await first).status, 401)
  assert.equal(h.bodies.length, 0)
  assert.deepEqual(resultsOf(h.session, 'bridge_first').map(row => row.data.error?.code), ['BRIDGE_REVOKED'])

  assert.equal((await b.post('list')).status, 200)
  const second = b.post('call', { name: 'bash', callId: 'bridge_second' })
  await ticks()
  assert.equal(h.answer(), true)
  await ticks()
  assert.equal(h.bodies[0].call.name, 'bash')
  assert.equal(h.finish(), true)
  assert.equal((await second).status, 200)
  assert.equal(resultsOf(h.session, 'bridge_first').length, 1)
  assertLoadable(h.session)
})

test('a takeover withdraws the old approval and lets the new attachment run', async t => {
  const h = host(t, { level: 'manual' })
  h.startTurn()
  h.startStep()
  const a = wire(h, A)
  const b = wire(h, B)
  await a.post('list')
  const old = a.post('call', { name: 'bash', callId: 'old_approval' })
  await ticks()
  assert.equal(h.asks[0].request.signal.aborted, false)
  assert.equal((await b.post('list')).status, 200)
  assert.equal(h.asks[0].request.signal.aborted, true)
  assert.equal(h.answer(), true)
  assert.equal((await old).status, 401)
  assert.equal(h.bodies.length, 0)
  assert.deepEqual(resultsOf(h.session, 'old_approval').map(row => row.data.error?.code), ['BRIDGE_REVOKED'])

  const current = b.post('call', { name: 'bash', callId: 'new_approval' })
  await ticks()
  assert.equal(h.answer(), true)
  await ticks()
  assert.equal(h.bodies[0].call.name, 'bash')
  assert.equal(h.finish(), true)
  assert.equal((await current).status, 200)
  assert.equal(resultsOf(h.session, 'old_approval').length, 1)
  assertLoadable(h.session)
})

test('Stop still aborts every call controller of the current attachment', async t => {
  const h = host(t)
  h.startTurn()
  h.startStep()
  const a = wire(h, A)
  await a.post('list')
  const first = a.post('call', { name: 'bash', callId: 'stop_first' })
  const second = a.post('call', { name: 'bash', callId: 'stop_second' })
  await ticks()
  const controllers = [...h.record.controllers]
  assert.equal(controllers.length, 2)
  assert.ok(controllers.every(controller => !controller.signal.aborted))
  h.backchannel.cancel(h.record)
  assert.ok(controllers.every(controller => controller.signal.aborted))
  assert.equal(h.finish(), true)
  assert.equal(h.finish(), true)
  assert.equal((await first).status, 200)
  assert.equal((await second).status, 200)
  assert.equal(h.record.controllers.size, 0)
})

test('takeover ends a headerless call parked between steps under the old attachment', { timeout: 2000 }, async t => {
  const h = host(t)
  h.record.promptRunning = () => true
  h.startTurn()
  h.startStep()
  h.endStep()
  await wire(h, A).post('list')
  const pending = wire(h).post('call', { name: 'bash' })
  await ticks()
  assert.equal(h.record.controllers.size, 1)
  assert.equal((await wire(h, B).post('list')).status, 200)
  h.startStep()
  assert.equal((await pending).status, 401)
  assert.equal(h.bodies.length, 0)
  assert.equal(h.record.controllers.size, 0)
})

test('takeover aborts the old tool body and keeps its controller until it returns', async t => {
  const h = host(t)
  h.startTurn()
  h.startStep()
  const get = h.backchannel.ctx.get
  let signal
  t.mock.method(h.backchannel.ctx, 'get', name => {
    const service = get(name)
    if (name !== 'tools') return service
    return {
      ...service,
      execute(execution) {
        signal = execution.signal
        return service.execute(execution)
      },
    }
  })
  const a = wire(h, A)
  await a.post('list')
  const pending = a.post('call', { name: 'bash', callId: 'bridge_body' })
  await ticks()
  assert.equal(signal.aborted, false)
  assert.equal((await wire(h, B).post('list')).status, 200)
  assert.equal(signal.aborted, true)
  assert.equal(h.record.controllers.size, 1)
  assert.equal(h.finish(), true)
  assert.equal((await pending).status, 401)
  assert.equal(h.record.controllers.size, 0)
  assert.deepEqual(resultsOf(h.session, 'bridge_body').map(row => row.data.error?.code), ['BRIDGE_REVOKED'])
})

test('a detached process cannot finish an approval in an agent-opened turn', async t => {
  const h = host(t, { level: 'manual' })
  const a = wire(h, A)
  await a.post('list')
  const pending = a.post('call', { name: 'bash' })
  await ticks()
  assert.equal(h.asks[0].request.signal.aborted, false)
  await a.post('bye')
  assert.equal(h.asks[0].request.signal.aborted, true)
  assert.equal(h.answer(), true)
  assert.equal((await pending).status, 401)
  assert.equal(h.bodies.length, 0)
})

test('ready fails when the process exited before its first list', { timeout: 2000 }, async t => {
  const h = host(t)
  const a = wire(h, A)
  assert.deepEqual(await a.post('bye'), { status: 200, body: { ok: true } })
  assert.equal(h.record.closed, false)
  assert.equal((await a.post('list')).status, 401)

  const adapter = new AcpAdapter({}, new Map(), { backchannel: h.backchannel })
  await assert.rejects(adapter.ready({ bridgeReadyMs: 60_000 }, { bridge: h.record }), { code: 'acp_bridge_missing' })
})

test('the source bridge credential is refused while the fork request is pending', async t => {
  const h = host(t)
  const old = wire(h, A)
  assert.equal((await old.post('list')).status, 200)
  const started = Promise.withResolvers()
  const fork = Promise.withResolvers()
  const adapter = new AcpAdapter({}, new Map(), { backchannel: h.backchannel })
  const live = {
    bridge: h.record,
    run: {
      held: fn => fn(),
      fork() {
        started.resolve()
        return fork.promise
      },
    },
  }
  const pending = adapter.refork({ name: 'Probe agent' }, live, h.agent)
  await started.promise
  try {
    assert.equal((await old.post('list')).status, 401)
    assert.equal((await wire(h, B, { record: live.bridge }).post('list')).status, 200)
  } finally {
    fork.resolve()
    await pending
  }
  assert.equal(await pending, live.bridge)
})

test('permission diagnostics reports a live Session bridge as closed while detached', async t => {
  const h = host(t)
  const adapter = new AcpAdapter({}, new Map(), { dshTools: () => true, backchannel: h.backchannel })
  const diagnostics = new PermissionDiagnostics()
  const state = { provider: 'acp-claude', run: { alive: true }, bridge: h.record }
  adapter.live.set(h.session.id, state)
  diagnostics.started(h.session.id, adapter, { disableBuiltInTools: true }, state)
  const read = () => diagnostics.read(h.session.id)
  const a = wire(h, A)
  await a.post('list')
  assert.equal(read().bridge.open, true)
  await a.post('bye')
  assert.equal(read().active, true)
  assert.equal(read().bridge.open, false)
  await wire(h, B).post('list')
  assert.equal(read().bridge.open, true)
})
