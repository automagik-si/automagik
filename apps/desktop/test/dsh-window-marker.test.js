import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { dshEnv, dshRun, dshWindowMarker } from '../src/dsh.js'

const origin = 'http://127.0.0.1:54321'
const nextOrigin = 'http://127.0.0.1:54322'
const header = 'x-automagik-window'
const childAt = (url) => ({
  url,
  child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
})

test('the marker follows only the ready child, the DSH webContents, and the allowed paths', async () => {
  const marker = dshWindowMarker()
  let intercept
  marker.bind({ id: 3, session: { webRequest: { onBeforeSendHeaders: (_filter, callback) => { intercept = callback } } } })
  const headersFor = (url, webContentsId = 3, requestHeaders = {}) => new Promise(resolve =>
    intercept({ url, webContentsId, requestHeaders }, result => resolve(result.requestHeaders)))
  const marked = path => headersFor(origin + path)
  const pending = marker.start()
  const env = dshEnv({ base: { AUTOMAGIK_WINDOW_DIGEST: 'stale' }, home: '/fixture', windowDigest: pending.digest })
  assert.deepEqual(Object.keys(env).filter(name => name.startsWith('AUTOMAGIK_WINDOW_')), ['AUTOMAGIK_WINDOW_DIGEST'])
  assert.equal(env.AUTOMAGIK_WINDOW_DIGEST, pending.digest)
  assert.equal(dshEnv({ base: env, home: '/fixture-wsl' }).AUTOMAGIK_WINDOW_DIGEST, undefined)
  const first = childAt(origin + '/?token=fixture')
  assert.deepEqual(await marked('/api/omni-ui'), {})
  pending.ready(first, nextOrigin)
  assert.deepEqual(await marked('/api/omni-ui'), {})
  pending.ready(first, origin)

  const secret = (await marked('/api/omni-ui'))[header]
  assert.match(secret, /^[a-f0-9]{64}$/)
  assert.equal(createHash('sha256').update(secret, 'ascii').digest('hex'), pending.digest)
  for (const action of ['stream', 'take', 'input', 'release']) {
    assert.equal((await marked(`/api/omni-ui/code/${action}?bot=test`))[header], secret)
  }
  assert.deepEqual(await headersFor(origin + '/api/omni-ui', 4), {})
  assert.deepEqual(await headersFor(nextOrigin + '/api/omni-ui'), {})
  assert.deepEqual(await marked('/api/omni-ui/code/other'), {})
  assert.deepEqual(await headersFor(origin + '/api/omni-ui', 3, { 'X-Automagik-Window': 'spoof' }), { [header]: secret })

  const next = marker.start()
  assert.notEqual(next.digest, pending.digest)
  assert.deepEqual(await marked('/api/omni-ui'), {})
  const second = childAt(nextOrigin + '/?token=fixture')
  next.ready(second, nextOrigin)
  first.child.emit('exit')
  assert.ok((await headersFor(nextOrigin + '/api/omni-ui'))[header], 'an old exit does not clear the new child')
  assert.deepEqual(await marked('/api/omni-ui'), {})
  second.child.emit('exit')
  assert.deepEqual(await headersFor(nextOrigin + '/api/omni-ui'), {})

  const stop = marker.start()
  stop.ready(first, origin)
  const run = dshRun({ beforeStop: marker.clear })
  await run.stop()
  stop.ready(first, origin)
  assert.deepEqual(await marked('/api/omni-ui'), {}, 'stopping revokes the marker and any pending activation')
})

test('Electron marks real fetch and EventSource requests to a fixture DSH listener', { timeout: 30_000 }, async (t) => {
  const require = createRequire(import.meta.url)
  const packageDir = dirname(require.resolve('electron/package.json'))
  const pathFile = join(packageDir, 'path.txt')
  const executable = existsSync(pathFile)
    ? join(packageDir, 'dist', readFileSync(pathFile, 'utf8').trim())
    : null
  // Importing Electron's npm entry point without a binary triggers a download.
  if (!executable || !existsSync(executable)) return t.skip('Electron executable is unavailable')
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return t.skip('Electron needs a display')
  const home = mkdtempSync(join(tmpdir(), 'dsh-marker-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  await promisify(execFile)(executable, [
    '--disable-background-networking', `--user-data-dir=${home}`,
    fileURLToPath(new URL('./fixtures/dsh-window-marker.mjs', import.meta.url)),
  ], { timeout: 25_000 })
})
