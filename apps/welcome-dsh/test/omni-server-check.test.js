import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { install } from '../src/host/endpoint.js'
import { fakeContext } from './fake-ctx.js'

const version = '2.261118.15'
const npm = '2.261109.2'
const github = 'v2.261120.2'
const registry = 'https://npm.example/proxy/'
const versionURL = `${registry}@automagik%2fomni/${version}`
const tagsURL = `${registry}-/package/@automagik%2fomni/dist-tags`
const githubURL = 'https://api.github.com/repos/automagik-si/omni/releases/latest'
const command = version => `bun x --bun @automagik/omni${version ? `@${version}` : ''} install --sandbox --at-login`

function host({ files = {}, env = {}, ...options } = {}) {
  const asked = []
  const fake = fakeContext({ entries: { 'omni-ai': {} } })
  const fetch = async (url, init) => {
    asked.push(url)
    assert.ok(Object.hasOwn(files, url), `unexpected URL: ${url}`)
    const body = files[url]
    if (typeof body === 'function') return body(init)
    return new Response(typeof body === 'number' ? null : JSON.stringify(body), { status: typeof body === 'number' ? body : 200 })
  }
  install(fake.ctx, { fetch, env: { BUN_CONFIG_REGISTRY: registry, ...env }, omniServer: { platform: 'darwin', ...options } })
  const ask = async (payload = { version }) => {
    const request = new Request('http://localhost/api/omni-ai', { method: 'POST', body: JSON.stringify({ endpoint: 'omni-server-check', payload }) })
    return (await fake.routes[0].fetch(request)).json()
  }
  return { ask, asked }
}

test('a published server version is ok, with only one request on the chosen registry', async () => {
  const { ask, asked } = host({ files: { [versionURL]: 200 } })
  assert.deepEqual(await ask(), { ok: true, value: { ok: true } })
  assert.deepEqual(await ask(), { ok: true, value: { ok: true } })
  assert.deepEqual(asked, [versionURL])
})

test('404 reports the requested version and the npm and GitHub releases when available', async () => {
  let now = 0
  const files = { [versionURL]: 404, [tagsURL]: { latest: npm }, [githubURL]: { tag_name: github } }
  const f = host({ files, now: () => now })
  const output = { ok: true, value: { ok: false, reason: 'unpublished', version, npm, github } }
  assert.deepEqual(await f.ask(), output)
  assert.deepEqual(await f.ask(), output)
  assert.deepEqual(f.asked, [versionURL, tagsURL, githubURL])
  files[versionURL] = 200
  now = 60_000
  assert.deepEqual(await f.ask(), { ok: true, value: { ok: true } })
  const missing = host({ files: { [versionURL]: 404, [tagsURL]: 500, [githubURL]: 500 } })
  assert.deepEqual(await missing.ask(), { ok: true, value: { ok: false, reason: 'unpublished', version, npm: null, github: null } })
})

test('GitHub release notes can fill 1 MiB before the release tag is discarded', async () => {
  const release = { tag_name: github, body: '' }
  const padding = 1024 * 1024 - Buffer.byteLength(JSON.stringify(release))
  for (const extra of [0, 1]) {
    const { ask } = host({ files: {
      [versionURL]: 404, [tagsURL]: { latest: npm },
      [githubURL]: { ...release, body: 'x'.repeat(padding + extra) },
    } })
    assert.deepEqual(await ask(), {
      ok: true, value: { ok: false, reason: 'unpublished', version, npm, github: extra ? null : github },
    })
  }
})

test('a registry failure or timeout leaves the command unchecked', async () => {
  const expected = { ok: true, value: { ok: true, unchecked: true } }
  const failed = host({ files: { [versionURL]: 500 } })
  assert.deepEqual(await failed.ask(), expected)
  assert.deepEqual(failed.asked, [versionURL])
  let signal
  const timeout = host({
    requestMs: 10,
    files: { [versionURL]: init => { signal = init.signal; return new Promise(() => {}) } },
  })
  const [answer] = await Promise.all([timeout.ask(), delay(25)])
  assert.deepEqual(answer, expected)
  assert.equal(signal.aborted, true)
  assert.deepEqual(timeout.asked, [versionURL])
})

test('Linux requires an executable systemctl on PATH before contacting the registry', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'welcome-systemctl-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const f = host({ platform: 'linux', env: { PATH: path }, files: { [versionURL]: 200 } })
  const missing = { ok: true, value: { ok: false, reason: 'no-systemd' } }
  assert.deepEqual(await f.ask(), missing)
  const systemctl = join(path, 'systemctl')
  writeFileSync(systemctl, '', { mode: 0o600 })
  assert.deepEqual(await f.ask(), missing)
  assert.deepEqual(f.asked, [])
  chmodSync(systemctl, 0o700)
  assert.deepEqual(await f.ask(), { ok: true, value: { ok: true } })
  assert.deepEqual(f.asked, [versionURL])
})

test('server check validates its strict payload and allows a release prerelease', async () => {
  const prerelease = `${version}-rc.1`
  const f = host({ files: { [`${versionURL}-rc.1`]: 200 } })
  for (const payload of [null, {}, { version: 123 }, { version: 'latest' }, { version: '2.3.4' }, { version: '2.261118.15/anything' }, { version, extra: true }]) {
    const reply = await f.ask(payload)
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'omni-ai/invalid')
  }
  assert.deepEqual(f.asked, [])
  assert.deepEqual(await f.ask({ version: prerelease }), { ok: true, value: { ok: true } })
})

// Load the actual browser module with the same React stand-ins as steps.test.js.
async function loadSandbox() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/team.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    external: ['react', 'react-dom'],
    loader: { '.css': 'text' },
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, URL, require: () => ({}) })
  return module.exports.sandboxInstall
}

let sandbox
async function runSandbox({ open = { state: 'ready', command: command(version) }, reads = [], check, writes = [] }) {
  sandbox ??= await loadSandbox()
  const calls = []
  const shown = []
  const checked = []
  const omniUi = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'omni-terminal-open') return { terminal: 'test-terminal', ...open }
    if (endpoint === 'omni-terminal-read') return reads.shift() ?? { state: 'exited', exitCode: 0, result: { status: 'paired', origin: 'http://localhost:8882' } }
    if (endpoint === 'omni-terminal-write') return { ok: writes.shift() ?? true }
    return {}
  }
  const last = await sandbox({
    show: (...args) => shown.push(JSON.parse(JSON.stringify(args))),
    omniUi, wait: async () => {},
    check: check && (async (version) => { checked.push(version); return check(version) }),
  })
  return { last, calls, shown, checked }
}

test('unpublished command closes the terminal without Enter and shows the reason in the card', async () => {
  const result = await runSandbox({ check: () => ({ ok: false, reason: 'unpublished', npm, github }) })
  assert.equal(result.last, 'failed')
  assert.deepEqual(result.checked, [version])
  assert.deepEqual(result.calls.map(([endpoint]) => endpoint), ['omni-terminal-open', 'omni-terminal-close'])
  assert.deepEqual(result.shown.at(-1), ['failed', {
    message: `Omni ${version} is not on npm, where Omni's installer gets it. The newest there is ${npm}. Omni ${github} is out on GitHub and not on npm yet. Power Omni off and on again to take the Omni plugins that work with it, or use an Omni on another computer.`,
  }])
})

test('the command from the ready read takes precedence over the earlier preparing view', async () => {
  const result = await runSandbox({
    open: { state: 'preparing', command: command(npm) },
    reads: [{ state: 'preparing', command: command(npm) }, { state: 'ready', command: command(version), data: 'prompt' }],
    check: checked => (checked === npm ? { ok: true } : { ok: false, reason: 'unpublished', npm, github: `v${npm}` }),
  })
  assert.equal(result.last, 'failed')
  assert.deepEqual(result.checked, [version])
  assert.ok(result.calls.every(([, payload]) => payload.data !== '\r'))
  assert.equal(result.calls.at(-1)[0], 'omni-terminal-close')
  assert.equal(Object.hasOwn(result.shown.at(-1)[1], 'log'), false)
  assert.doesNotMatch(result.shown.at(-1)[1].message, /GitHub/)
})

test('no systemd uses its own message and sends no Enter', async () => {
  const result = await runSandbox({ check: () => ({ ok: false, reason: 'no-systemd' }) })
  assert.equal(result.last, 'failed')
  assert.deepEqual(result.shown.at(-1), ['failed', {
    message: "Omni's installer needs systemd on this computer, and it has none (a container, for example). Use an Omni on another computer.",
  }])
  assert.ok(result.calls.every(([, payload]) => payload.data !== '\r'))
})

test('a successful version check is reused when the first Enter is unaccepted', async () => {
  const result = await runSandbox({
    reads: [{ state: 'ready', command: command(version) }, { state: 'ready', command: command(version) }],
    writes: [false, true],
    check: () => ({ ok: true }),
  })
  assert.equal(result.last, 'linked')
  assert.deepEqual(result.checked, [version])
  assert.deepEqual(result.calls.filter(([endpoint]) => endpoint === 'omni-terminal-write').map(([, payload]) => payload.data), ['\r', '\r'])
})

test('an unversioned command behaves as before without calling check', async () => {
  const result = await runSandbox({ open: { state: 'ready', command: command() }, check: () => ({ ok: false }) })
  assert.equal(result.last, 'linked')
  assert.deepEqual(result.checked, [])
  assert.equal(result.calls.find(([endpoint]) => endpoint === 'omni-terminal-write')[1].data, '\r')
})
