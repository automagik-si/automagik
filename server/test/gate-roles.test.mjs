import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { createGate } from '../gate.mjs'
import { memberRole } from '../gate-mux.mjs'
import { CALLER_HTTP, CALLER_UPGRADE, callerTarget, effectiveRole } from '../gate-roles.mjs'
import fixture from './fixtures/caller-role-paths.json' with { type: 'json' }

const origin = new URL('https://workspace.invalid')
const pair = row => row.method + ' ' + row.path
const targetOf = row => row.path + (row.query ?? '')

test('G1 role precedence and raw target decisions are shared across gate and adapter', () => {
  assert.deepEqual(CALLER_HTTP, new Set(fixture.targets.filter(row => row.transport === 'http').map(pair)))
  assert.equal(CALLER_UPGRADE, pair(fixture.targets.find(row => row.transport === 'upgrade')))
  for (const row of fixture.roles) {
    assert.equal(effectiveRole(row.roles), row.role ?? undefined, JSON.stringify(row))
    assert.equal(memberRole(row.roles), ['member', 'guest'].includes(row.role) ? row.role : undefined)
  }
  for (const role of ['member', 'guest', undefined]) {
    for (const row of [...fixture.targets, ...fixture.refused]) {
      const decision = callerTarget({ role, method: row.method, raw: targetOf(row), upgrade: row.transport === 'upgrade', origin })
      const denied = !role || row.status === 403
      assert.deepEqual(decision, denied ? { allow: false, status: 403 } : { allow: true }, pair(row))
    }
  }
})

test('G1 the viewer-bound feed permits only its canonical query on GET', () => {
  const path = targetOf(fixture.targets.find(row => row.query))
  const allow = (raw, method = 'GET') => callerTarget({ role: 'member', raw, method, origin }).allow
  assert.equal(allow(path), true)
  assert.equal(allow(path, 'POST'), false)
  for (const raw of [path + '&since=1', path + '&viewer=other.member', path.replace('mounted', '%6Dounted'),
    path.replace('.member', '.none'), path.replace('/feed', '/./feed')]) assert.equal(allow(raw), false, raw)
})

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('G2 the gate refuses raw spelling variants and malformed roles before probing or signing', async t => {
  let probed = 0, signed = 0
  const family = { id: 'f', principal: { roles: ['member'] } }
  const sessions = Object.assign(new EventEmitter(), { authenticate: () => family, active: () => true })
  const gate = createGate({
    origin: origin.origin, sessions, multiuser: true,
    connectDsh() { probed++; assert.fail('refused request reached the probe') },
    caller: { sign() { signed++; assert.fail('refused request reached the signer') } },
    credentials: { cookie() { assert.fail('refused request requested an owner credential') } },
  })
  t.after(() => gate.closeGate())
  async function request(row) {
    const upgrade = row.transport === 'upgrade'
    const headers = { host: origin.host, origin: origin.origin }
    if (upgrade) headers.upgrade = 'websocket'
    const req = { url: targetOf(row), method: row.method, headers, rawHeaders: Object.entries(headers).flat() }
    let status
    if (upgrade) {
      const socket = new EventEmitter()
      socket.destroy = () => socket.emit('close')
      socket.end = (line, flush) => { status = Number(line.split(' ')[1]); flush() }
      await gate.listeners('upgrade')[0](req, socket, Buffer.alloc(0))
    } else {
      const res = {
        writeHead(code) { status = code; return this },
        end() {},
      }
      await gate.listeners('request')[0](req, res)
    }
    return status
  }
  for (const row of fixture.roles.filter(row => row.role === null)) {
    family.principal.roles = row.roles
    for (const target of fixture.targets) assert.equal(await request(target), 403, JSON.stringify(row))
    assert.equal(await request({ method: 'GET', path: '/_gate/sessions' }), 403, JSON.stringify(row))
  }
  for (const role of ['member', 'guest']) {
    family.principal.roles = [role]
    for (const row of fixture.refused) assert.equal(await request(row), row.status, pair(row))
  }
  assert.equal(probed, 0)
  assert.equal(signed, 0)
})

test('G2 only the exact Bot UI HTTP pairs are signed and owner forwarding keeps its ordinary path', async t => {
  const hops = [], signed = [], probes = []
  const response = (req, res) => {
    if (req.url === '/_automagik/caller/_ready') {
      probes.push(req.url)
      res.writeHead(204, { 'x-automagik-ready': '1' }).end()
    } else {
      hops.push(req.url)
      req.resume()
      res.writeHead(200).end()
    }
  }
  const upstream = http.createServer(response)
  const port = await listen(upstream)
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)) })
  const family = { id: 'f', principal: { issuer: 'https://id.invalid', subject: 's', roles: ['member'] } }
  const sessions = Object.assign(new EventEmitter(), { authenticate: () => family, active: () => true })
  const common = {
    origin: origin.origin, sessions,
    credentials: { port, authority: '127.0.0.1:' + port, cookie: async () => 'dsh=fixture' },
    caller: { sign(input) { signed.push(input); return 'fixture' } },
  }
  const gate = createGate({ ...common, multiuser: true })
  const gatePort = await listen(gate)
  t.after(() => gate.closeGate())
  const off = createGate(common)
  const offPort = await listen(off)
  t.after(() => off.closeGate())
  function request(row, target = gatePort) {
    const upgrade = row.transport === 'upgrade'
    const headers = { host: origin.host, origin: origin.origin }
    if (upgrade) Object.assign(headers, { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13' })
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: target, path: targetOf(row), method: row.method, headers }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
  }
  const pairs = fixture.targets.filter(row => row.callerRoute)
  for (const row of pairs) assert.equal(await request(row), 200, pair(row))
  assert.equal(await request(fixture.refused.find(row => row.method === 'GET' && row.path === pairs[1].path)), 403)
  assert.deepEqual(signed.map(input => [input.method, input.path]), pairs.map(row => [row.method, targetOf(row)]))
  assert.equal(probes.length, 2)
  assert.deepEqual(hops, pairs.map(row => '/_automagik/caller' + targetOf(row)))
  const arbitrary = { transport: 'http', method: 'POST', path: '/api/other?x=1' }
  assert.equal(await request(arbitrary, offPort), 403)
  family.principal.roles = ['owner']
  assert.equal(await request(arbitrary), 200)
  assert.equal(await request(arbitrary, offPort), 200)
  family.principal.roles = ['owner', 'unknown']
  assert.equal(await request(arbitrary, offPort), 200)
  assert.equal(signed.length, 2)
})
