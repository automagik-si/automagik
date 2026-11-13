// #162: the save path probes a streamable-http MCP endpoint with the initialize request the
// mount sends, and the verdict is recorded on the item. Every endpoint here is a local fake;
// no test reaches a real server.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET_VALUE = `probe-${randomBytes(12).toString('hex')}`
const HEADER_VALUE = 'plain-header-value'
const ACCEPT = 'application/json, text/event-stream'

const makeHome = state => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-probe-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Omni', capabilities: [], createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
    helper: { id: 'helper', sessionId: 'helper', name: 'Helper', capabilities: [], createdAt: 3 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})
const secret = { name: 'TOKEN', value: SECRET_VALUE, purpose: '', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 }

async function setup(entries = [secret]) {
  const home = makeHome(team())
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ secrets: entries }))
  const loader = { import: async () => ({ default: { name: 'mcp-client', apply() {} } }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  ctx.sessionTitle = { rename: async () => {} }
  await rt.load()
  return {
    home,
    ctx,
    rt,
    async dispose() {
      ctx.dispose()
      await rt.scheduleCapabilitiesReconcile()
      await new Promise(resolve => setImmediate(resolve))
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

const readBody = request => new Promise(resolve => {
  let text = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { text += chunk })
  request.on('end', () => resolve(text))
})

// A local fake endpoint. close() destroys open sockets too, so a probe still waiting on a
// silent server cannot keep the test process alive.
function serve(handler) {
  const sockets = new Set()
  const server = createServer((request, response) => { void handler(request, response) })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        close: () => new Promise(done => {
          for (const socket of sockets) socket.destroy()
          server.close(done)
        }),
      })
    })
  })
}

const capability = (name, url, headers = {}) => ({ name, kind: 'mcp', description: '', transport: 'streamable-http', url, headers })
const live = env => env.rt.state.capabilities.items

test('a 401 probe refuses the save with the challenge, and no header value survives', async t => {
  const requests = []
  const server = await serve(async (request, response) => {
    const body = await readBody(request)
    requests.push({ method: request.method, headers: request.headers, body })
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="probe"', 'Content-Type': 'text/plain' })
    response.end(`Unauthorized ${request.headers.authorization} ${request.headers['x-probe-header']}`)
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  await assert.rejects(
    env.rt.capabilitySave(capability('blocked', server.url, {
      Authorization: 'Bearer $DSH_SECRET_TOKEN',
      'X-Probe-Header': HEADER_VALUE,
    }), { botId: 'chief' }),
    error => {
      assert.match(error.message, /Not saved: blocked answered HTTP 401/)
      assert.match(error.message, /WWW-Authenticate: Bearer realm="probe"/)
      assert.match(error.message, /body: Unauthorized/)
      assert.match(error.message, /stores headers only and has no sign-in flow/)
      assert.doesNotMatch(error.message, new RegExp(SECRET_VALUE))
      assert.doesNotMatch(error.message, new RegExp(HEADER_VALUE))
      return true
    },
  )
  assert.equal(live(env).blocked, undefined)
  assert.equal(readFileSync(join(env.home, 'state.json'), 'utf8').includes('blocked'), false)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].headers['content-type'], 'application/json')
  assert.equal(requests[0].headers.accept, ACCEPT)
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET_VALUE}`)
  const body = JSON.parse(requests[0].body)
  assert.equal(body.method, 'initialize')
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(typeof body.params.protocolVersion, 'string')
})

test('a 403 probe refuses the save the same way', async t => {
  const server = await serve((_request, response) => {
    response.writeHead(403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' })
    response.end('Forbidden')
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  await assert.rejects(
    env.rt.capabilitySave(capability('blocked', server.url, { Authorization: 'Bearer $DSH_SECRET_TOKEN' }), { botId: 'chief' }),
    error => {
      assert.match(error.message, /HTTP 403/)
      assert.match(error.message, /WWW-Authenticate: Bearer error="insufficient_scope"/)
      assert.doesNotMatch(error.message, new RegExp(SECRET_VALUE))
      return true
    },
  )
  assert.equal(live(env).blocked, undefined)
})

test('a 2xx initialize probe saves the capability as verified', async t => {
  const requests = []
  const server = await serve(async (request, response) => {
    requests.push({ method: request.method, headers: request.headers, body: await readBody(request) })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}')
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(capability('probe', server.url, { Authorization: 'Bearer $DSH_SECRET_TOKEN' }), { botId: 'chief' })
  assert.equal(saved.verification.status, 'verified')
  assert.ok(Number.isFinite(Date.parse(saved.verification.checkedAt)))
  assert.equal(live(env).probe.verification.status, 'verified')
  assert.equal(env.rt.capabilityLibraryView().find(item => item.name === 'probe').verification.status, 'verified')
  assert.equal(readFileSync(join(env.home, 'state.json'), 'utf8').includes(SECRET_VALUE), false)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].headers.accept, ACCEPT)
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET_VALUE}`)
  assert.equal(JSON.parse(requests[0].body).method, 'initialize')
})

test('a transport failure saves the capability as unverified with the reason', async t => {
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(capability('down', 'http://127.0.0.1:1/mcp'), { botId: 'chief' })
  assert.equal(saved.verification.status, 'unverified')
  assert.match(saved.verification.reason, /could not reach the server/)
  assert.ok(Number.isFinite(Date.parse(saved.verification.checkedAt)))
  assert.equal(live(env).down.verification.status, 'unverified')
})

test('a timed-out probe saves the capability as unverified, after one request', async t => {
  const requests = []
  const server = await serve(async request => {
    requests.push(await readBody(request))
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(capability('slow', server.url), { botId: 'chief' })
  assert.equal(saved.verification.status, 'unverified')
  assert.match(saved.verification.reason, /timed out after 10s/)
  assert.equal(requests.length, 1)
})

test('Save unverified records the check without contacting the server', async t => {
  let contacted = 0
  const server = await serve((_request, response) => {
    contacted += 1
    response.writeHead(500)
    response.end('no')
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilityEndpoint('capability-save', {
    ...capability('noted', server.url, { Authorization: 'Bearer $DSH_SECRET_TOKEN' }),
    unverified: true,
  })
  assert.equal(contacted, 0)
  assert.equal(saved.verification.status, 'unverified')
  assert.equal(Object.hasOwn(saved.verification, 'reason'), false)
  assert.ok(Number.isFinite(Date.parse(saved.verification.checkedAt)))
  assert.equal(readFileSync(join(env.home, 'state.json'), 'utf8').includes(SECRET_VALUE), false)

  // A Bot cannot skip the probe by asking for it; only the operator's Settings action can.
  const bypass = await env.rt.capabilitySave({ ...capability('bypass', server.url), unverified: true }, { botId: 'chief' })
  assert.equal(contacted, 1)
  assert.equal(bypass.verification.status, 'unverified')
  assert.match(bypass.verification.reason, /HTTP 500/)
})

test('save_capability answers verified, unverified, or the refusal', async t => {
  let mode = 'ok'
  const server = await serve((_request, response) => {
    if (mode === 'ok') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}')
    } else {
      response.writeHead(mode === 'auth' ? 401 : 500, { 'WWW-Authenticate': 'Bearer realm="probe"' })
      response.end('nope')
    }
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())
  const tool = env.ctx.registeredTools.get('save_capability')
  const ask = args => tool.execute(args, { agent: { id: 'chief' } })

  const verified = await ask(capability('good', server.url))
  assert.match(verified, /^Saved good \(verified\)\. Bots with it attached use the change from their next message\.$/)

  mode = 'auth'
  const refused = await ask(capability('auth', server.url))
  assert.match(refused, /HTTP 401/)
  assert.doesNotMatch(refused, /^Saved/)

  mode = 'error'
  const unverified = await ask(capability('error', server.url))
  assert.match(unverified, /^Saved error \(unverified: HTTP 500/)
  assert.match(unverified, /Bots with it attached use the change from their next message\.$/)
})

// The row receives the saved item from the library view; render it with a React stand-in and
// read the text the reader gets.
const { outputFiles } = await build({
  stdin: { contents: "export { CapabilityRow } from './src/client/capability-settings.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useEffect() {},
  useLayoutEffect() {},
  useState: initial => [initial, () => {}],
  useMemo: make => make(),
  useRef: current => ({ current }),
  useId: () => 'id',
}
const clientModule = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: clientModule,
  exports: clientModule.exports,
  require: name => (name === 'react' ? react : {}),
  console,
})
const { CapabilityRow } = clientModule.exports
const textOf = node => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.props ? textOf(node.props.children) : ''
}
const rowText = item => textOf(CapabilityRow({ item, onEdit() {}, onDelete() {}, onApprove() {} }))

test('the Shared capabilities row shows the verdict a failed probe left', () => {
  const base = { name: 'probe', kind: 'mcp', transport: 'streamable-http', description: '' }
  assert.match(rowText({ ...base, verification: { checkedAt: new Date().toISOString(), status: 'verified' } }), /Verified/)
  const unverified = rowText({ ...base, verification: { checkedAt: new Date().toISOString(), status: 'unverified', reason: 'HTTP 401 (WWW-Authenticate: Bearer)' } })
  assert.match(unverified, /Unverified: HTTP 401/)
  assert.doesNotMatch(unverified, /Verified/)
  assert.match(rowText({ ...base, verification: { checkedAt: new Date().toISOString(), status: 'unverified' } }), /Unverified/)
})

// A redirect must not be followed: fetch would replay the POST (307) or turn it into a GET
// (302) at another origin, where the custom headers are still attached.
const redirectCase = async (status, t) => {
  const target = []
  const destination = await serve(async (request, response) => {
    target.push({ method: request.method, headers: request.headers })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"jsonrpc":"2.0","id":1,"result":{}}')
  })
  t.after(() => destination.close())
  const origin = []
  const source = await serve(async (request, response) => {
    origin.push({ method: request.method, headers: request.headers, body: await readBody(request) })
    response.writeHead(status, { Location: destination.url })
    response.end()
  })
  t.after(() => source.close())
  return { origin, target, source }
}

test('a 307 probe makes exactly one POST and never reaches the redirect target', async t => {
  const { origin, target, source } = await redirectCase(307, t)
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(capability('moved', source.url, {
    Authorization: 'Bearer $DSH_SECRET_TOKEN',
    'X-Api-Key': '$DSH_SECRET_TOKEN',
  }), { botId: 'chief' })
  assert.equal(saved.verification.status, 'unverified')
  assert.match(saved.verification.reason, /HTTP 307/)
  assert.doesNotMatch(saved.verification.reason, new RegExp(SECRET_VALUE))
  assert.equal(live(env).moved.verification.status, 'unverified')

  assert.equal(target.length, 0)
  assert.equal(origin.length, 1)
  assert.equal(origin[0].method, 'POST')
  assert.equal(origin[0].headers.authorization, `Bearer ${SECRET_VALUE}`)
  assert.equal(origin[0].headers['x-api-key'], SECRET_VALUE)

  const base = { name: 'moved', kind: 'mcp', transport: 'streamable-http', description: '' }
  const row = rowText({ ...base, verification: saved.verification })
  assert.match(row, /Unverified: HTTP 307/)
  assert.doesNotMatch(row, new RegExp(SECRET_VALUE))
  assert.doesNotMatch(row, new RegExp(source.url))
})

test('a 302 probe makes exactly one POST and its answer carries no header value', async t => {
  const { origin, target, source } = await redirectCase(302, t)
  const env = await setup()
  t.after(() => env.dispose())

  const answer = await env.ctx.registeredTools.get('save_capability').execute(
    capability('moved', source.url, {
      'X-Api-Key': '$DSH_SECRET_TOKEN', 'X-Probe-Header': HEADER_VALUE,
    }),
    { agent: { id: 'chief' } },
  )
  assert.match(answer, /^Saved moved \(unverified: HTTP 302/)
  assert.doesNotMatch(answer, new RegExp(SECRET_VALUE))
  assert.doesNotMatch(answer, new RegExp(HEADER_VALUE))
  assert.equal(answer.includes(source.url), false)

  assert.equal(target.length, 0)
  assert.equal(origin.length, 1)
  assert.equal(origin[0].method, 'POST')
  assert.equal(live(env).moved.verification.status, 'unverified')
  assert.equal(live(env).moved.verification.reason, 'HTTP 302 (a redirect is not followed)')
})

test('a 3xx to the same origin is still one request', async t => {
  const origin = []
  const followed = []
  const server = await serve(async (request, response) => {
    if (request.url === '/moved-elsewhere') {
      followed.push({ method: request.method, headers: request.headers })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      return
    }
    origin.push({ method: request.method, headers: request.headers, body: await readBody(request) })
    response.writeHead(301, { Location: '/moved-elsewhere' })
    response.end()
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(
    capability('moved', server.url, { 'X-Api-Key': '$DSH_SECRET_TOKEN' }),
    { botId: 'chief' },
  )
  assert.equal(saved.verification.status, 'unverified')
  assert.equal(saved.verification.reason, 'HTTP 301 (a redirect is not followed)')
  assert.doesNotMatch(saved.verification.reason, new RegExp(SECRET_VALUE))
  assert.equal(origin.length, 1)
  assert.equal(origin[0].method, 'POST')
  assert.equal(followed.length, 0)
})

test('a challenge value is redacted before it is capped', async t => {
  const long = 'x'.repeat(400)
  const server = await serve((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': `Bearer ${SECRET_VALUE} ${long}` })
    response.end('no')
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  await assert.rejects(
    env.rt.capabilitySave(
      capability('blocked', server.url, { 'X-Api-Key': '$DSH_SECRET_TOKEN' }),
      { botId: 'chief' },
    ),
    error => {
      // The redactor runs first, so the challenge reads as the secret label; the header scrub
      // has nothing left to replace (the accepted consequence: the label wins, no byte of the
      // secret survives).
      assert.match(error.message, /WWW-Authenticate: Bearer \[secret:TOKEN\]/)
      assert.doesNotMatch(error.message, /\[header\]/)
      assert.doesNotMatch(error.message, new RegExp(SECRET_VALUE))
      assert.doesNotMatch(error.message, /x{200}/)
      return true
    },
  )
})

// The edge the tester found: the sent header value is a substring of the secret. Scrubbing the
// header first cuts the secret around it, so redaction can no longer see the secret and its
// prefix and suffix stay in the answer. Every clean() here redacts first.
const runsOf = (text, value, size = 4) => {
  const found = []
  for (let i = 0; i + size <= value.length; i += size) {
    const run = value.slice(i, i + size)
    if (text.includes(run)) found.push(run)
  }
  return found
}

test('a header value inside the secret echoes the label, never the secret edges', async t => {
  // The server reflects the whole secret (it has it from Authorization); the configured header
  // only carries a piece of it.
  const inner = SECRET_VALUE.slice(6, 22)
  const server = await serve((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fake"' })
    response.end(`reflected ${SECRET_VALUE}`)
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  await assert.rejects(
    env.rt.capabilitySave(capability('leaky', server.url, {
      Authorization: 'Bearer $DSH_SECRET_TOKEN',
      'X-Probe-Header': inner,
    }), { botId: 'chief' }),
    error => {
      assert.match(error.message, /body: reflected \[secret:TOKEN\]\)/)
      assert.deepEqual(runsOf(error.message, SECRET_VALUE), [])
      assert.equal(error.message.includes('probe-'), false)
      assert.equal(error.message.includes(inner), false)
      assert.doesNotMatch(error.message, /\[header\]/)
      return true
    },
  )
  assert.equal(live(env).leaky, undefined)
})

test('a header that embeds a whole secret reads as the label, not as [header]', async t => {
  const server = await serve(async (request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fake"' })
    response.end(`got ${request.headers['x-api-key']}`)
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  await assert.rejects(
    env.rt.capabilitySave(
      capability('wrapped', server.url, { 'X-Api-Key': 'k-$DSH_SECRET_TOKEN-z' }),
      { botId: 'chief' },
    ),
    error => {
      assert.match(error.message, /body: got k-\[secret:TOKEN\]-z\)/)
      assert.doesNotMatch(error.message, /\[header\]/)
      assert.deepEqual(runsOf(error.message, SECRET_VALUE), [])
      return true
    },
  )
  assert.equal(live(env).wrapped, undefined)
})

test('a header value with no secret overlap is still scrubbed to [header]', async t => {
  const server = await serve(async (request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fake"' })
    response.end(`got ${request.headers['x-probe-header']}`)
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  await assert.rejects(
    env.rt.capabilitySave(
      capability('plain', server.url, { 'X-Probe-Header': HEADER_VALUE }),
      { botId: 'chief' },
    ),
    error => {
      assert.match(error.message, /body: got \[header\]\)/)
      assert.equal(error.message.includes(HEADER_VALUE), false)
      return true
    },
  )
  assert.equal(live(env).plain, undefined)
})

test('a cap after redaction cannot split a secret into surviving halves', async t => {
  // The secret starts 186 characters in, so its original span crosses the 200-character cap;
  // the configured header carries a slice of it that also crosses the cap.
  const filler = 'y'.repeat(186)
  const inner = SECRET_VALUE.slice(6, 24)
  const server = await serve((_request, response) => {
    response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end(`${filler}${SECRET_VALUE}${'z'.repeat(40)}`)
  })
  t.after(() => server.close())
  const env = await setup()
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(capability('capped', server.url, {
    Authorization: 'Bearer $DSH_SECRET_TOKEN',
    'X-Probe-Header': inner,
  }), { botId: 'chief' })
  assert.match(saved.verification.reason, /^HTTP 500: y{186}\[secret:TOKEN\]$/)
  assert.equal(saved.verification.reason.slice('HTTP 500: '.length).length, 200)
  assert.deepEqual(runsOf(saved.verification.reason, SECRET_VALUE), [])
  assert.equal(saved.verification.reason.includes('probe-'), false)
  assert.doesNotMatch(saved.verification.reason, /\[header\]/)
})

// #480: below WHOLE_VALUE the global redactor only matches a value that stands alone, so a
// 4-7 character secret echoed between letters is never replaced; the header scrub then cuts the
// echo around the header slice and leaves the secret's edges. The probe redacts every known
// value anywhere instead, so the whole secret reads as its label and nothing is left to rebuild.
const shortSecret = value => ({
  name: 'TOKEN', value, purpose: '', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1,
})
const shortEcho = async (t, value) => {
  const inner = value.slice(1, -1)
  const requests = []
  const server = await serve((request, response) => {
    requests.push(request.headers)
    response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end(`aaay${value}buzzz`)
  })
  t.after(() => server.close())
  const env = await setup([shortSecret(value)])
  t.after(() => env.dispose())

  const saved = await env.rt.capabilitySave(capability(`short-${value.length}`, server.url, {
    Authorization: 'Bearer $DSH_SECRET_TOKEN',
    'X-Probe-Header': inner,
  }), { botId: 'chief' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]['x-probe-header'], inner)
  assert.equal(saved.verification.status, 'unverified')
  assert.equal(saved.verification.reason, 'HTTP 500: aaay[secret:TOKEN]buzzz')
  assert.equal(saved.verification.reason.includes('[header]'), false)
  assert.equal(saved.verification.reason.includes(inner), false)
  assert.deepEqual(runsOf(saved.verification.reason, value, 2), [])
}

test('a 4-character secret echoed inside letters is redacted whole by the probe', async t => {
  await shortEcho(t, '4821')
})

test('a 6-character secret echoed inside letters is redacted whole by the probe', async t => {
  await shortEcho(t, '935174')
})

test('a 7-character secret echoed inside letters is redacted whole by the probe', async t => {
  await shortEcho(t, '6284917')
})

// #484: a value below the write floor (MIN_VALUE = 4) reaches the store only by hand-editing
// secrets.json, and no redactor can match a 1-3 character value without hitting ordinary words.
// The loader holds it, so the probe refuses before any request, names the floor, and no byte of
// the value leaves the host (the #482 probe-only policy for 4+ values is untouched).
test('a hand-edited 3-character secret in the URL is held, and the probe refuses naming the floor', async t => {
  const value = 'q7z'
  const hits = []
  const server = await serve((_request, response) => {
    hits.push(true)
    response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end(`aaay${value}buzzz`)
  })
  t.after(() => server.close())
  const env = await setup([shortSecret(value)])
  t.after(() => env.dispose())

  // A Bot cannot save it at all (a held key is no Bot's); the person's save is probed.
  await assert.rejects(env.rt.capabilitySave(capability('held-url', `${server.url}?k=$DSH_SECRET_TOKEN`), { botId: 'chief' }), /not saved for you/)
  const saved = await env.rt.capabilitySave(capability('held-url', `${server.url}?k=$DSH_SECRET_TOKEN`), { ui: true })
  assert.equal(hits.length, 0, 'a held secret must not reach the wire')
  assert.equal(saved.verification.status, 'unverified')
  assert.match(saved.verification.reason, /^Secret TOKEN is held: its saved value is shorter than 4 characters/)
  assert.deepEqual(runsOf(saved.verification.reason, value, 2), [])
  assert.equal(saved.verification.reason.includes('aaay'), false)
})

test('a hand-edited 1-character secret in a header is held, and no request is sent', async t => {
  const value = 'q'
  const hits = []
  const server = await serve((_request, response) => {
    hits.push(true)
    response.end(`aaay${value}[header]zbuzzz`)
  })
  t.after(() => server.close())
  const env = await setup([shortSecret(value)])
  t.after(() => env.dispose())

  const held = capability('held-header', server.url, { Authorization: 'Bearer $DSH_SECRET_TOKEN' })
  await assert.rejects(env.rt.capabilitySave(held, { botId: 'chief' }), /not saved for you/)
  const saved = await env.rt.capabilitySave(held, { ui: true })
  assert.equal(hits.length, 0, 'a held secret must not reach the wire')
  assert.equal(saved.verification.status, 'unverified')
  assert.match(saved.verification.reason, /^Secret TOKEN is held: its saved value is shorter than 4 characters/)
  // The surrounds the echo would have left are nowhere: the request was never made.
  assert.equal(saved.verification.reason.includes('aaay'), false)
  assert.equal(saved.verification.reason.includes('[header]'), false)
})
