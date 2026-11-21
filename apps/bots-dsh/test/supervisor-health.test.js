import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { localListener } from '../src/host/supervisor/child.js'
import { checkHealth, healthListener, localRequest } from '../src/host/supervisor/health.js'
import { applicationRow, batch, bootGraphJson, bootstrap, bootstrapRow, cookie, frontendRow, healthReply, loaderRow, mountRow, shell } from './fixtures/supervisor-health-wire.mjs'

const name = '@automagik/bots-dsh'
const version = '4.0.0'
const runId = 'health-run'
const address = 'http://127.0.0.1:3080/'
const plugins = [{ name, version, loaded: true }]
const defaultArgs = ['web', '--port', '3080']

function fixture({ fault, args = defaultArgs, launch = address, reply = value => value } = {}) {
  const calls = []
  const child = { launchUrl: launch + '?token=stdout-secret', listener: localListener(args) }
  const options = {
    args, runId, expect: { [name]: version }, retryMs: 5, windows: { first: 80, second: 80 },
    probe: async (url, { cookie, payload, stream }) => {
      calls.push({ url, cookie, payload, stream })
      if (fault === 'port') throw new Error('no listener')
      return reply(healthReply({ url, headers: { cookie }, payload, plugins, run: runId, fault }), url, payload)
    },
  }
  return { calls, child, options }
}

test('signs in on the fixed local listener and checks both forms and DSH-shaped boot assets', async () => {
  // Node does not strip TypeScript directly from node_modules.
  const source = import.meta.resolve('@deepseek-ai/dsh-client-modules/src/client/manifest.ts')
  const parser = stripTypeScriptTypes(fs.readFileSync(new URL(source), 'utf8'))
  const { parseBootManifest } = await import('data:text/javascript,' + encodeURIComponent(parser))
  const manifest = parseBootManifest(JSON.parse(bootGraphJson))
  assert.deepEqual(manifest.modules.map(row => [row.id, row.initialUrl]), [
    ['@deepseek-ai/dsh-client-modules', bootstrap.slice(1)], [name, batch.slice(1)],
  ])
  const args = [...defaultArgs, '--public-url=https://example.invalid/prefix/']
  const { calls, child, options } = fixture({ args, launch: 'https://example.invalid/prefix/' })
  const result = await checkHealth(child, options)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.map(call => call.url.pathname + call.url.search), [
    '/', '/?token=stdout-secret', '/api/omni-ui', '/api/omni-ui', '/', batch, bootstrap, shell,
  ])
  assert.deepEqual(calls.map(call => call.cookie), [undefined, undefined, cookie, cookie, cookie, cookie, cookie, cookie])
  assert.ok(calls.every(call => call.url.origin === 'http://127.0.0.1:3080'))
  assert.deepEqual(calls.slice(2, 4).map(call => call.payload), ['self-update-status', 'state']
    .map(endpoint => ({ endpoint, payload: { health: true } })))
  assert.ok(calls.slice(-3).every(call => call.stream))
})

for (const fault of ['port', 'sign-in', 'plugins', 'roster', 'page']) {
  test('reports only the failure code for ' + fault, async () => {
    const { child, options } = fixture({ fault })
    assert.deepEqual(await checkHealth(child, options), { ok: false, failed: fault })
  })
}

test('a trial can neither prove health after exiting nor open its hold for the wrong run', async () => {
  const f = fixture()
  f.child.result = { code: 7 }
  assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'exited' })
  assert.equal(f.calls.length, 0)
  const other = fixture()
  assert.deepEqual(await checkHealth(other.child, { ...other.options, runId: 'another-run' }), { ok: false, failed: 'plugins' })
})

test('a closed hold without an observed run fails plugin health', async () => {
  const f = fixture({ reply: reply => ({ ...reply, body: reply.body.replace('"run":"health-run"', '"run":null') }) })
  assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'plugins' })
})

test('a missing saved team fails even when the empty replacement is readable', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'supervisor-health-team-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const teamPath = join(dir, 'state.json')
  fs.writeFileSync(teamPath, '{"revision":5,"bots":{}}')
  const { child, options } = fixture({ reply: (reply, url) => url.pathname === '/api/omni-ui'
    ? { ...reply, body: reply.body.replace('"present":true', '"present":false') } : reply })
  assert.deepEqual(await checkHealth(child, { ...options, team: { path: teamPath, revision: 5 } }),
    { ok: false, failed: 'roster', teamMissing: true })
  assert.deepEqual(await checkHealth(child, options), { ok: true })
})

for (const [name, row] of [
  ['frontend module', frontendRow], ['bootstrap script', bootstrapRow], ['application batch', applicationRow],
  ['frontend mount element', mountRow], ['inline module loader', loaderRow],
]) {
  test('page health requires the ' + name, async () => {
    assert.ok(row)
    const f = fixture({ reply: reply => ({ ...reply, body: reply.body.replace(row, '') }) })
    assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'page' })
  })
}

for (const [field, invalid] of [['rev', 1], ['release', { version: 'fixture', commit: 1 }], ['entries', [{}]], ['batches', [{}]]]) {
  test('page health rejects a missing or malformed boot graph ' + field, async () => {
    for (const value of [undefined, invalid]) {
      const graph = JSON.parse(bootGraphJson)
      graph[field] = value
      const f = fixture({ reply: reply => ({ ...reply, body: reply.body.replace(bootGraphJson, JSON.stringify(graph)) }) })
      assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'page' })
    }
  })
}

test('page health matches the bootstrap and Bots batch URLs from the graph to the HTML', async () => {
  for (const phase of ['bootstrap', 'application']) {
    const graph = JSON.parse(bootGraphJson)
    graph.batches.find(row => row.phase === phase).url += '&changed'
    const f = fixture({ reply: reply => ({ ...reply, body: reply.body.replace(bootGraphJson, JSON.stringify(graph)) }) })
    assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'page' })
  }
})

test('roster health checks the on-disk team even when the loaded roster is readable', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'supervisor-health-team-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const teamPath = join(dir, 'state.json')
  for (const [bytes, lost] of [[undefined, true], ['{', false], ['[]', false], ['{"revision":1,"bots":{}}', true]]) {
    fs.writeFileSync(teamPath, '{"revision":5,"bots":{"bot-a":{}}}')
    const f = fixture({ reply: (reply, _url, payload) => {
      // The child already loaded the original roster and can still answer from memory.
      if (payload?.endpoint === 'self-update-status') {
        if (bytes === undefined) fs.unlinkSync(teamPath)
        else fs.writeFileSync(teamPath, bytes)
      }
      return reply
    } })
    assert.deepEqual(await checkHealth(f.child, { ...f.options, team: { path: teamPath, revision: 5 } }),
      { ok: false, failed: 'roster', ...(lost ? { teamMissing: true } : {}) })
    assert.ok(f.calls.every(call => call.payload?.endpoint !== 'state'))
  }
})

test('the page fails for an empty script, an external URL, or a script redirect', async () => {
  const atBatch = url => url.pathname + url.search === batch
  const edits = [
    (reply, url) => atBatch(url) ? { ...reply, size: 0 } : reply,
    reply => ({ ...reply, body: reply.body.replace('.' + shell, '//example.invalid/escaped.js') }),
    (reply, url) => atBatch(url) ? { ...reply, status: 303, headers: { location: 'http://example.invalid/' } } : reply,
  ]
  for (const reply of edits) {
    const f = fixture({ reply })
    assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'page' })
    assert.ok(f.calls.every(call => call.url.host === '127.0.0.1:3080'))
  }
})

test('the second window starts after the first passes and a fresh probe can check an old child', async () => {
  const f = fixture()
  const probe = f.options.probe
  f.options.windows = { first: 50, second: 50 }
  f.options.probe = async (url, opts) => {
    if (['self-update-status', 'state'].includes(opts.payload?.endpoint)) await wait(30, undefined, { signal: opts.signal })
    return probe(url, opts)
  }
  assert.deepEqual(await checkHealth(f.child, f.options), { ok: true })
  assert.deepEqual(await checkHealth(f.child, { ...f.options, since: Date.now() - 61_000 }), { ok: false, failed: 'port' })
})

test('TLS and an announcement mismatch never send a credential', async () => {
  assert.equal(healthListener([...defaultArgs, '--tls-cert=/some/cert']), null)
  const f = fixture({ launch: 'http://127.0.0.1:3081/' })
  assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'port' })
  assert.equal(f.calls.length, 0)
})

test('direct HTTP checks send no credential to the wrong listener or a redirect sink', async t => {
  const sinkRequests = []
  async function serve(handler) {
    const server = createServer(handler)
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return server.address().port
  }
  const sinkPort = await serve((req, res) => {
    sinkRequests.push({ path: req.url, cookie: req.headers.cookie })
    res.writeHead(200).end('not DSH')
  })
  const sink = 'http://127.0.0.1:' + sinkPort
  let mode = 'redirect'
  const local = await serve(async (req, res) => {
    assert.equal(req.headers.host, '127.0.0.1:' + local)
    const url = new URL(req.url, 'http://' + req.headers.host)
    if (url.pathname === '/plugin/' && mode === 'redirect') return res.writeHead(302, { location: sink }).end()
    const chunks = []
    for await (const part of req) chunks.push(part)
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
    const reply = healthReply({ url, headers: req.headers, payload, plugins, run: runId })
    res.writeHead(reply.status, reply.headers).end(reply.body)
  })
  const f = fixture({ args: ['--port', String(local)], launch: 'http://127.0.0.1:' + local + '/' })
  const options = { ...f.options, probe: localRequest, windows: { first: 200, second: 200 } }
  assert.deepEqual(await checkHealth(f.child, options), { ok: false, failed: 'page' })
  assert.deepEqual(sinkRequests, [])
  mode = 'pass'
  assert.deepEqual(await checkHealth(f.child, options), { ok: true })
  const wrong = fixture({ args: ['--port', String(sinkPort), '--public-url=https://example.invalid/'],
    launch: 'https://example.invalid/' })
  assert.deepEqual(await checkHealth(wrong.child, { ...wrong.options, probe: localRequest }), { ok: false, failed: 'port' })
  assert.ok(sinkRequests.length > 0)
  assert.ok(sinkRequests.every(request => request.path === '/' && request.cookie === undefined))
})

test('a wrong public argv listener can receive only a credential-free identity probe', async () => {
  const f = fixture({ args: [...defaultArgs, '--public-url=https://example.invalid/'],
    launch: 'https://example.invalid/', reply: () => ({ status: 401, headers: {}, body: 'other service' }) })
  assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'port' })
  assert.ok(f.calls.length > 0)
  assert.ok(f.calls.every(call => call.url.href === address && call.cookie === undefined && call.payload === undefined))
})

test('plugin health needs a complete versioned active inventory even for legacy baselines', async () => {
  const inventory = body => value => ({ ...value, body: value.body.replace(
    /"plugins":\[[^\]]*\]/, body,
  ) })
  for (const body of ['"other":[]', '"plugins":[]', '"plugins":[{"name":"' + name + '","version":"3.0.0","loaded":true}]',
    '"plugins":[{"name":"' + name + '","version":"' + version + '","loaded":false}]']) {
    const f = fixture({ reply: inventory(body) })
    assert.deepEqual(await checkHealth(f.child, f.options), { ok: false, failed: 'plugins' })
  }
  const f = fixture({ reply: inventory('"other":[]') })
  assert.deepEqual(await checkHealth(f.child, { ...f.options, expect: { [name]: null } }), { ok: false, failed: 'plugins' })
})

test('wildcard public binds probe the matching loopback and an unassigned IP is refused', async () => {
  const wildcard = fixture({ args: ['--host=0.0.0.0', '--port=3080', '--public-url=https://example.invalid/'],
    launch: 'https://example.invalid/' })
  assert.deepEqual(await checkHealth(wildcard.child, wildcard.options), { ok: true })
  assert.ok(wildcard.calls.every(call => call.url.hostname === '127.0.0.1'))
  const unassigned = fixture({ args: ['--host=192.0.2.1', '--port=3080'], launch: 'http://192.0.2.1:3080/' })
  assert.deepEqual(await checkHealth(unassigned.child, unassigned.options), { ok: false, failed: 'port' })
  assert.deepEqual(unassigned.calls, [])
})
