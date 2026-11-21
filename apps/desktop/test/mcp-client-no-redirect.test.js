// A redirecting remote MCP server is refused, not followed (issue #475), tested against the real
// pinned package: fixtures/mcp-client-no-redirect/index.js is the unmodified lib/index.js of
// @deepseek-ai/dsh-mcp-client 0.2.2-rc.2 (MIT; LICENSE beside it). Its sha256 must be the
// `before` hash in runtime/patches/patches.json, so these tests apply the carried patch to the
// bytes npm installs, take the patched createTransport() from them, and send what it builds
// through Node's fetch at two local servers on different ports (different origins): A answers
// with a redirect to B, and B records what reaches it.
//
// What this does NOT cover: @modelcontextprotocol/client itself. Its StreamableHTTPClientTransport
// is a stand-in here that records its options; that 2.2.0 spreads requestInit into the fetch of
// every message was checked against the real 2.2.0 package (a 307 to another origin re-sent the
// custom header, a 302 reached the target as a GET; with redirect "error" both were refused and
// nothing reached the other origin). prepare-runtime's install, the desktop build and the server
// image build are out of scope: the boot check and the Server image CI job exercise those.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { patchRuntime } from '../scripts/runtime-patches.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = dirname(HERE)
const PATCHES = join(APP, 'runtime', 'patches')
const FIXTURE = join(HERE, 'fixtures', 'mcp-client-no-redirect', 'index.js')
const PACKAGE = '@deepseek-ai/dsh-mcp-client'
const FILE = 'lib/index.js'
const PATCH = 'mcp-client-no-redirect.patch'
const DSH = '0.2.2-rc.2'
const VERSION = '0.2.2-rc.2'

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const sha256 = text => createHash('sha256').update(text).digest('hex')

function entry() {
  const entries = readJson(join(PATCHES, 'patches.json')).filter(item => item.patch === PATCH)
  assert.equal(entries.length, 1, `patches.json must carry exactly one ${PATCH}`)
  return entries[0]
}

function patchedSource(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-mcp-redirect-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const modules = join(root, 'node_modules')
  const pkg = join(modules, PACKAGE)
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(modules, '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH }))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: PACKAGE, version: VERSION, type: 'module' }))
  writeFileSync(join(pkg, FILE), readFileSync(FIXTURE))
  const patches = join(root, 'patches')
  mkdirSync(patches)
  writeFileSync(join(patches, 'patches.json'), `${JSON.stringify([entry()], null, 2)}\n`)
  cpSync(join(PATCHES, PATCH), join(patches, PATCH))
  assert.deepEqual(patchRuntime(modules, patches).map(({ name, state }) => [name, state]), [[`${PACKAGE}/${FILE}`, 'patched']])
  return readFileSync(join(pkg, FILE), 'utf8')
}

// The patched createTransport(), evaluated with stand-in transports that record their options.
function createTransportOf(source) {
  const match = /\nfunction createTransport\(config\) \{\n[\s\S]*?\n\}\n/.exec(source)
  assert.ok(match, 'createTransport(config) is in the patched file')
  class StreamableHTTPClientTransport {
    constructor(url, options) { Object.assign(this, { kind: 'http', url, options }) }
  }
  class StdioClientTransport {
    constructor(options) { Object.assign(this, { kind: 'stdio', options }) }
  }
  const buildChildEnv = env => env
  return new Function('StreamableHTTPClientTransport', 'StdioClientTransport', 'buildChildEnv',
    `${match[0]}\nreturn createTransport`)(StreamableHTTPClientTransport, StdioClientTransport, buildChildEnv)
}

const listen = handler => new Promise(done => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => done(server))
})

test('patches.json pins the real 0.2.2-rc.2 dsh-mcp-client to the desktop runtime', () => {
  const pinned = readJson(join(APP, 'runtime', 'package.json')).dependencies['@deepseek-ai/dsh']
  const item = entry()
  assert.equal(item.dsh, pinned)
  assert.equal(item.dsh, DSH)
  assert.deepEqual(item.files.map(file => [file.package, file.version, file.file]), [[PACKAGE, VERSION, FILE]])
  assert.equal(sha256(readFileSync(FIXTURE)), item.files[0].before)
  const lock = readJson(join(APP, 'runtime', 'package-lock.json'))
  assert.equal(lock.packages[`node_modules/${PACKAGE}`].version, VERSION)
})

test('the patched transport refuses a redirect: no header crosses origins, no POST becomes a GET', async (t) => {
  const source = patchedSource(t)
  assert.equal(sha256(source), entry().files[0].after)
  const createTransport = createTransportOf(source)
  const seen = []
  const target = await listen((req, res) => {
    seen.push({ method: req.method, header: req.headers['x-mcp-canary'] ?? null })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  let status = 307
  const redirecting = await listen((req, res) => {
    res.writeHead(status, { location: `http://127.0.0.1:${target.address().port}/mcp` }).end()
  })
  t.after(() => { target.close(); redirecting.close() })
  const url = `http://127.0.0.1:${redirecting.address().port}/mcp`
  const transport = createTransport({ transport: 'streamable-http', url, headers: { 'x-mcp-canary': 'CANARY' } })
  assert.equal(transport.kind, 'http')
  assert.equal(transport.url.href, url)
  assert.deepEqual(transport.options, { requestInit: { headers: { 'x-mcp-canary': 'CANARY' }, redirect: 'error' } })
  for (const code of [307, 302]) {
    status = code
    // The shape 2.2.0 sends a message with: its requestInit spread, then the method and body.
    await assert.rejects(fetch(url, { ...transport.options.requestInit, method: 'POST', body: '{}' }), TypeError)
  }
  assert.deepEqual(seen, [], 'nothing reached the other origin')
})

test('stdio servers are built as before', (t) => {
  const createTransport = createTransportOf(patchedSource(t))
  const transport = createTransport({ transport: 'stdio', command: 'x', args: ['a'], env: { A: '1' }, cwd: '/tmp' })
  assert.deepEqual({ ...transport }, { kind: 'stdio', options: { command: 'x', args: ['a'], env: { A: '1' }, cwd: '/tmp' } })
})
