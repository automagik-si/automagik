import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runSensitive } from '../src/bw/run.js'
import { classify } from '../src/bws/classify.js'
import { runBws } from '../src/bws/run.js'
import { fakeToken } from './fixtures/bws.mjs'

const executable = process.env.AUTOMAGIK_TEST_PINNED_BWS

test('installed bws 2.1.0 uses the explicit opt-out before contacting a closed loopback port', {
  skip: !executable, timeout: 20000,
}, async t => {
  const home = mkdtempSync(join(tmpdir(), 'pinned-bws-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const configuration = join(home, '.config')
  const options = {
    parent: { HOME: home, XDG_CONFIG_HOME: configuration, PATH: process.env.PATH },
    tmpRoot: home,
    resolveHelper: () => ({ file: executable, prefix: [] }),
  }
  const version = await runBws(['--version'], { timeout: 4500 }, options)
  assert.equal(version.code === 0 && version.stdout.trim() === 'bws 2.1.0', true)
  const id = randomUUID()
  const token = '0.' + id + '.' + randomBytes(16).toString('base64') + ':' + randomBytes(16).toString('base64')
  const run = (accessToken = token) => runBws(['project', 'list'],
    { token: accessToken, server: 'https://127.0.0.1:1', timeout: 4500 }, options)
  const failedAtLoopback = result => result.code !== 0 && result.stderr?.includes('127.0.0.1:1/identity/connect/token') === true
  const closed = await run()
  assert.equal(failedAtLoopback(closed), true)
  assert.equal(classify('2.1.0', closed), 'unavailable')
  assert.equal(closed.stderr.includes('crates/bws/src/main.rs:107'), true)
  const unpadded = await run(token.slice(0, -2))
  assert.equal(failedAtLoopback(unpadded), true)
  assert.equal(classify('2.1.0', unpadded), classify('2.1.0', closed))
  const state = join(configuration, 'bws', 'state')
  assert.equal(existsSync(state), false)

  mkdirSync(state, { recursive: true })
  const stale = join(state, id)
  writeFileSync(stale, 'invalid fixture state')
  utimesSync(stale, 100000, 100000)
  const before = statSync(stale).atimeMs
  assert.equal(failedAtLoopback(await run()), true)
  assert.equal(statSync(stale).atimeMs, before)
})

test('installed bws 2.1.0 classifies HTTPS loopback failures', {
  skip: !executable, timeout: 30000,
}, async t => {
  const home = mkdtempSync(join(tmpdir(), 'pinned-bws-reports-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const keyFile = join(home, 'key.pem')
  const certFile = join(home, 'cert.pem')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-addext', 'basicConstraints=critical,CA:FALSE', '-keyout', keyFile, '-out', certFile],
  { stdio: 'ignore', timeout: 10000 })
  if (generated.error?.code === 'ENOENT') return t.skip('openssl is unavailable')
  assert.equal(generated.status, 0, 'openssl could not generate a loopback certificate')

  const token = fakeToken()
  const item = randomUUID()
  let response
  const requests = []
  const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    requests.push(req.method === 'POST' && req.url === '/identity/connect/token')
    req.resume()
    const [status, body] = response
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Sandbox denies loopback sockets')
    throw error
  }
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const { port } = server.address()
  const config = join(home, 'config.toml')
  const run = async ({ endpoint = port, trust = true, accessToken = token } = {}) => {
    const base = 'https://127.0.0.1:' + endpoint
    writeFileSync(config, '[profiles.automagik]\n' +
      'server_api = "' + base + '/api"\nserver_identity = "' + base + '/identity"\nstate_opt_out = "true"\n', { mode: 0o600 })
    const parent = { HOME: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH }
    if (trust) parent.SSL_CERT_FILE = certFile
    return runSensitive(['--config-file', config, '--profile', 'automagik', '--output', 'json', '--color', 'no',
      'secret', 'get', item], { credentials: { BWS_ACCESS_TOKEN: accessToken }, timeout: 4500 },
    () => ({ file: executable, prefix: [] }), { parent })
  }
  const verify = (result, code, accessToken = token) => {
    assert.equal(result.code === 1 && result.stdout === '' && typeof result.stderr === 'string', true)
    const [client, key] = accessToken.split('.').slice(1)
    assert.equal([accessToken, client, ...key.split(':'), item].every(value => !result.stderr.includes(value)), true)
    assert.equal(result.stderr.includes('crates/bws/src/main.rs:107'), true)
    assert.equal(classify('2.1.0', result), code)
  }
  for (const [status, body, code] of [
    [400, { error: 'invalid_client' }, 'auth'],
    [400, { error: 'invalid_grant' }, 'auth'],
    [401, { error: 'unauthorized' }, 'auth'],
    [404, { message: 'Secret not found.' }, 'unavailable'],
    [429, { message: 'Too many requests.' }, 'unavailable'],
    [500, { message: 'Service unavailable.' }, 'unavailable'],
  ]) {
    response = [status, body]
    const result = await run()
    verify(result, code)
    assert.equal(result.stderr.includes('[' + status + ' '), true)
  }
  verify(await run({ trust: false }), 'unavailable')
  response = [401, { error: 'unauthorized' }]
  const unpadded = token.slice(0, -2)
  const unpaddedResult = await run({ accessToken: unpadded })
  verify(unpaddedResult, 'auth', unpadded)
  assert.equal(unpaddedResult.stderr.includes('[401 '), true)
  const closed = await run({ endpoint: 1 })
  verify(closed, 'unavailable')
  assert.equal(closed.stderr.includes('Connection refused'), true)
  assert.deepEqual(requests, [true, true, true, true, true, true, true])
})
