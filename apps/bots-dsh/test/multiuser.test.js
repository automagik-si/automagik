import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createRuntime } from '../index.js'
import { appOf, appRoutes } from '../src/host/app-manifest.js'
import { callerOf, callerService, multiuserMode } from '../src/host/multiuser.js'
import { fakeContext } from './fake-ctx.js'

test('mode parsing and the versioned caller service', () => {
  for (const value of [undefined, '', '0']) assert.equal(multiuserMode({ AUTOMAGIK_MULTIUSER: value }), false)
  for (const value of ['1', 'yes']) assert.equal(multiuserMode({ AUTOMAGIK_MULTIUSER: value }), true)
  assert.equal(callerOf(undefined), undefined)
  assert.equal(callerOf({ get: () => undefined }), undefined)
  assert.equal(callerOf({ get: () => ({ version: 3, current() { assert.fail('unknown service version') } }) }), undefined)
  const principal = Object.freeze({ kind: 'automagik' })
  for (const version of [1, 2, 3]) {
    for (const multiuser of [false, true]) {
      const service = { version, multiuser, current: () => principal }
      const ctx = { get: () => service }
      assert.equal(callerOf(ctx), version <= 2 ? principal : undefined)
      assert.equal(callerService(ctx), version === 2 && multiuser ? service : undefined)
    }
  }
  assert.equal(callerOf({ get(name) {
    assert.equal(name, 'automagikCaller')
    return { version: 1, current: () => principal }
  } }), principal)
})

const mcpPath = '/api/omni-mcp'
const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
function mcpRequest(token, url = 'http://localhost' + mcpPath) {
  return new Request(url, { method: 'POST', body: rpc, headers: {
    authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
  } })
}

async function mcpFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'multiuser-mcp-'))
  const ctx = fakeContext()
  const routes = new Map()
  ctx.connection.fetch.register = route => { routes.set(route.path, route); return () => routes.delete(route.path) }
  const rt = createRuntime(ctx, { home, browser: false, updateCheck: false, github: false })
  const token = `am_agent_${randomBytes(32).toString('hex')}`
  await writeFile(join(home, 'agent-tokens.json'), JSON.stringify([{
    hash: createHash('sha256').update(token).digest('hex'), id: 'fixture', name: 'Fixture', createdAt: Date.now(),
  }]))
  const previous = process.env.AUTOMAGIK_MULTIUSER
  t.after(async () => {
    if (previous === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = previous
    try { await ctx.dispose() }
    finally { await rm(home, { recursive: true, force: true }) }
  })
  assert.ok(routes.has(mcpPath))
  return { rt, token, exact: candidate => routes.get(mcpPath).fetch(mcpRequest(candidate)) }
}

test('the exact MCP route checks mode on every call before token, throttle and audit', async t => {
  const f = await mcpFixture(t)
  process.env.AUTOMAGIK_MULTIUSER = '1'
  assert.equal((await f.exact(f.token)).status, 403)
  for (let i = 0; i < 12; i++) assert.equal((await f.exact('invalid-grant')).status, 403)
  assert.deepEqual(await f.rt.agentAccess.history(), [])
  process.env.AUTOMAGIK_MULTIUSER = '0'
  assert.equal((await f.exact(f.token)).status, 200)
  assert.equal((await f.exact('invalid-grant')).status, 401)
})

test('the real direct MCP listener checks mode for a valid grant', async t => {
  const f = await mcpFixture(t)
  await f.rt.agentAccess.resume()
  const { url } = await f.rt.agentAccess.owner('view')
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  process.env.AUTOMAGIK_MULTIUSER = '1'
  assert.equal((await fetch(mcpRequest(f.token, url))).status, 403)
  assert.deepEqual(await f.rt.agentAccess.history(), [])
  process.env.AUTOMAGIK_MULTIUSER = '0'
  assert.equal((await fetch(mcpRequest(f.token, url))).status, 200)
})

test('manifest and PNG and SVG icon resources preserve GET and HEAD in real WebServer reads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'multiuser-manifest-'))
  const svg = join(dir, 'fixture.svg')
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const ctx = new Context()
  const web = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const apps = [appOf({}), appOf({ appManifest: { name: 'Fixture', short_name: 'Fixture', icon: svg } })]
  for (const app of apps) {
    for (const route of appRoutes(app)) {
      const unregister = web.register(route)
      try {
        for (const method of ['GET', 'HEAD']) {
          let status, headers, body
          await route.handler({ method }, { writeHead(code, fields) { status = code; headers = fields }, end(bytes) { body = bytes } })
          const response = await web.readResource(new Request('http://localhost' + route.path, { method }), {})
          assert.equal(response.status, status)
          assert.deepEqual(Object.fromEntries(response.headers), headers)
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), body ?? Buffer.alloc(0))
        }
      } finally { unregister() }
    }
  }
})
