// Antigravity installed from the app on the person's click (#2048), through the real CliStore
// and the plugin's real wiring. The manifest and the download are fakes (no network); the
// staged `agy` is a fake CLI that answers --version and is otherwise the fake ACP agent. No
// real agy runs, no script is run and no login starts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, SERVICE } from '../index.js'
import { AGENTS, signInHintOf } from '../src/host/agents.js'
import { AGY_DOWNLOAD_HOST, AGY_DOWNLOAD_PATH, installAgy } from '../src/host/agy-source.js'
import { CliStore, CLI_CHECK_EVERY_MS } from '../src/host/clis.js'

const ID = 'acp-antigravity'
const SPEC = AGENTS[ID]
const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const unixOnly = { skip: process.platform === 'win32' ? 'the fake agy uses a POSIX shebang' : false }
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const URL = `https://${AGY_DOWNLOAD_HOST}${AGY_DOWNLOAD_PATH}1.5.15-5514532022517760/linux-x64/cli_linux_x64.tar.gz`
const MANIFEST = { version: '1.5.15', url: URL, sha512: 'ab'.repeat(64) }

// The fake agy: --version prints `version` and, like a CLI that keeps state, writes in its
// HOME (a scratch one, which must never be published); anything else is the fake ACP agent.
const agyScript = (version, env = {}) => `#!/bin/sh
if [ "$#" = 1 ] && [ "$1" = --version ]; then
  mkdir -p "$HOME/.gemini/antigravity-cli" "$HOME/.local/bin" && echo x > "$HOME/.gemini/antigravity-cli/mark"
  echo "export PATH=nowhere" >> "$HOME/.profile"
  echo ${quote(`agy ${version}`)}
  exit 0
fi
${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')}
exec ${quote(process.execPath)} ${quote(FAKE)} "$@"
`
const writeAgy = (path, version = '1.5.15', env) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, agyScript(version, env))
  chmodSync(path, 0o755)
  return path
}

function world(t, { config = {}, external, manifest = async () => MANIFEST, installManifest, agentEnv = { FAKE_ACP_MODES: 'default' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-agy-'))
  const home = join(dir, 'automagik', 'acp', 'clis')
  const calls = { manifest: [], download: [] }
  const jobs = []
  const fakeInstall = installManifest ?? (async (staging) => { writeAgy(join(staging, 'bin', 'agy'), '1.5.15', agentEnv) })
  const cliStore = new CliStore({
    home, platform: { platform: 'linux', arch: 'x64', musl: false }, env: { ...process.env },
    versionEnv: () => ({}),
    latest: async () => { throw new Error('the npm registry is not reached in this test') },
    install: async () => assert.fail('no npm install in this test'),
    manifest: async (key, options) => { calls.manifest.push(key); return manifest(key, options) },
    installManifest: async (...args) => { calls.download.push(args[0]); return fakeInstall(...args) },
  })
  const ensure = cliStore.ensure.bind(cliStore)
  cliStore.ensure = (...args) => {
    const job = ensure(...args)
    jobs.push(job)
    return job
  }
  const registered = {}
  const routes = { now: [] }
  const services = {}
  const disposers = []
  const listeners = new Map()
  const session = { id: 's1', header: { cwd: dir }, append: () => ({ seq: 1 }) }
  const agent = {
    session,
    model: { current: () => ({ provider: ID, model: 'default' }) },
    options: { provider: ID },
    status: 'idle',
    ctx: { tools: { register: () => () => {} } },
  }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.adapter = adapter
        routes.now = [...providers]
        const handle = () => { routes.now = [] }
        handle.replace = (next) => { routes.now = [...next] }
        return handle
      },
      listProviders: () => routes.now.map(id => ({ id, name: id })),
    },
    agents: { get: id => (id === 's1' ? agent : undefined), list: () => [agent] },
    get: name => (name === 'approval' ? { request: async () => 'allowed-once' } : undefined),
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} },
    effect: (fn) => { disposers.push(fn()) },
    provide: (name, value) => { services[name] = value },
    emit: () => {},
  }
  const store = {
    binOf: () => undefined, busy: () => false, lastError: () => undefined, lastFailure: () => undefined,
    update: async () => {}, stateOf: () => undefined, markGood: () => {}, rollback: () => undefined, dispose: () => {},
  }
  const clis = external ? { agy: external } : {}
  const live = { claude: false, codex: false, ...config }
  apply(ctx, live, {
    store, cliStore, find: name => clis[name],
    signedIn: async () => undefined,
    catalogHome: join(dir, 'catalog'),
  })
  t.after(() => { for (const fn of disposers) fn?.(); rmSync(dir, { recursive: true, force: true }) })
  return {
    dir, home, calls, cliStore, config: live, routes, clis,
    service: services[SERVICE],
    get adapter() { return registered.adapter },
    emit(name, payload) { for (const listener of listeners.get(name) ?? []) listener(payload) },
    async settle() {
      let completed = 0
      do {
        const pending = jobs.slice(completed)
        completed = jobs.length
        await Promise.allSettled(pending)
        await new Promise(resolve => setImmediate(resolve))
      } while (completed < jobs.length)
    },
    row: async () => (await services[SERVICE].status()).agents.find(row => row.id === ID),
  }
}
const folders = home => (existsSync(join(home, 'agy')) ? readdirSync(join(home, 'agy')).filter(name => name !== 'logs').sort() : [])

test('T10: off or on, nothing but the click installs Antigravity: no timer, plugin change, switch, Retry or refresh', unixOnly, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  for (const on of [false, true]) {
    const w = world(t, { config: { antigravity: on } })
    t.mock.timers.tick(5000)
    await w.settle()
    t.mock.timers.tick(CLI_CHECK_EVERY_MS)
    await w.settle()
    w.emit('plugin-manager/changed', { reason: 'install' })
    w.emit('loader/volatile-update')
    await w.service.retry(ID)
    await w.service.refresh()
    await w.settle()
    assert.deepEqual(w.calls, { manifest: [], download: [] }, `antigravity ${on ? 'on' : 'off'}`)
    const row = await w.row()
    assert.equal(row.cli.state, 'missing')
    assert.equal(row.cli.install, 'manual')
    assert.equal(row.cli.installUrl, 'https://antigravity.google/docs/getting-started')
    assert.deepEqual(folders(w.home), [])
  }
})

test('T11 and T7: Install is refused while off; on, a click installs agy, publishes only bin/, and offers the agent', unixOnly, async (t) => {
  const w = world(t)
  await assert.rejects(w.service.installCli(ID), error => error.code === 'acp-install/off' && error.message === 'Turn Antigravity on first.')
  await assert.rejects(w.service.installCli('acp-claude'), error => error.code === 'acp-install/unsupported')
  assert.deepEqual(w.calls.manifest, [])
  w.config.antigravity = true
  w.emit('loader/volatile-update')
  const first = (await w.service.installCli(ID)).agents.find(row => row.id === ID)
  assert.equal(first.cli.state, 'installing')
  assert.equal(first.cli.install, 'manual')
  await w.settle()
  assert.deepEqual(w.calls.manifest, ['linux_amd64'])
  const row = await w.row()
  assert.equal(row.cli.state, 'ready')
  assert.equal(row.cli.found, true)
  assert.equal(row.cli.managed, true)
  assert.equal(row.cli.version, '1.5.15')
  assert.equal(row.cli.install, 'manual')
  assert.deepEqual(w.routes.now, [ID])
  // One published version folder, holding exactly bin/agy: no staging, payload or scratch home.
  const [published, ...rest] = folders(w.home)
  assert.deepEqual(rest, [])
  assert.match(published, /^1\.5\.15-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.deepEqual(readdirSync(join(w.home, 'agy', published)), ['bin'])
  assert.deepEqual(readdirSync(join(w.home, 'agy', published, 'bin')), ['agy'])
  assert.deepEqual(w.cliStore.find(SPEC), { path: join(w.home, 'agy', published, 'bin', 'agy'), version: '1.5.15', managed: true })
})

test('T11b: a managed agy is signed in to by its path, in the status, the chat and the sign-in refusal', unixOnly, async (t) => {
  const w = world(t, { config: { antigravity: true }, agentEnv: { FAKE_ACP_MODES: 'default', FAKE_ACP_AUTH: 'session' } })
  await w.service.installCli(ID)
  await w.settle()
  const path = w.cliStore.find(SPEC).path
  const command = `'${path}' acp --login`
  assert.equal((await w.row()).cli.signInHint, command)
  assert.equal(w.adapter.agents.get(ID).signInHint, command)
  assert.throws(() => w.service.loginStart(ID), error => error.message === `Sign in to Antigravity in a terminal: run ${command}, then check again.`)
  const chunks = []
  const request = markAgentLoopRequest({ provider: ID, model: 'default', sessionId: 's1', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] })
  for await (const chunk of w.adapter.stream(request)) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.failure.message, `Antigravity (ACP) is not signed in. Run \`${command}\` in a terminal, then send again.`)
})

test('T11b: the person\'s own agy keeps the plain command; a path the quoting cannot carry falls back to it', unixOnly, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'acp-dsh-agy-own-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const own = writeAgy(join(scratch, 'agy'))
  const w = world(t, { config: { antigravity: true }, external: own })
  assert.equal((await w.row()).cli.signInHint, 'agy acp --login')
  assert.equal(w.adapter.agents.get(ID).signInHint, 'agy acp --login')
  assert.throws(() => w.service.loginStart(ID), /run agy acp --login, then check again/)
  // The shapes, by platform.
  const managed = path => ({ path, managed: true })
  assert.equal(signInHintOf(SPEC, managed('C:\\Users\\a\\.automagik\\acp\\clis\\agy\\1.5.15-x\\bin\\agy.exe'), 'win32'), '& "C:\\Users\\a\\.automagik\\acp\\clis\\agy\\1.5.15-x\\bin\\agy.exe" acp --login')
  for (const [path, platform] of [
    ["/srv/o'hara/.automagik/acp/clis/agy/1.5.15-x/bin/agy", 'linux'],
    ['/srv/a`b/.automagik/acp/clis/agy/1.5.15-x/bin/agy', 'linux'],
    ['/srv/a/../b/agy', 'linux'],
    ['relative/bin/agy', 'linux'],
    ['C:\\Users\\a\u201Db\\acp\\clis\\agy\\1.5.15-x\\bin\\agy.exe', 'win32'],
    ['C:\\Users\\a$b\\bin\\agy.exe', 'win32'],
    ['C:\\Users\\a/..\\b\\agy.exe', 'win32'],
    ['\\\\server\\share\\agy.exe', 'win32'],
    ['/srv/a\u202Eb/.automagik/acp/clis/agy/1.5.15-x/bin/agy', 'linux'],
    ['/srv/a\u2028b/.automagik/acp/clis/agy/1.5.15-x/bin/agy', 'linux'],
    ['C:\\Users\\a\u2066b\\acp\\clis\\agy\\1.5.15-x\\bin\\agy.exe', 'win32'],
  ]) assert.equal(signInHintOf(SPEC, managed(path), platform), 'agy acp --login', path)
  assert.equal(signInHintOf(SPEC, { path: '/opt/agy', managed: false }), 'agy acp --login')
  assert.equal(signInHintOf(AGENTS['acp-hermes'], managed('/opt/hermes')), 'hermes acp --setup')
})

test('T9: no update loop: a second click, the person\'s own agy, a copy another process published, a click while busy', unixOnly, async (t) => {
  const w = world(t, { config: { antigravity: true } })
  await w.service.installCli(ID)
  await w.settle()
  const installed = w.cliStore.find(SPEC)
  // Here already: a click answers at once, and even a direct click on the store downloads nothing.
  await w.service.installCli(ID)
  assert.deepEqual(await w.cliStore.ensure(SPEC, undefined, { force: true, click: true }), installed)
  assert.equal(w.calls.manifest.length, 1)
  assert.equal(w.calls.download.length, 1)

  // The person's own agy on PATH: returned as theirs, nothing fetched.
  const own = new CliStore({ home: join(w.dir, 'other'), platform: { platform: 'linux', arch: 'x64', musl: false }, versionEnv: () => ({}), manifest: () => assert.fail('no manifest for the person\'s own agy') })
  assert.deepEqual(await own.ensure(SPEC, '/opt/person/agy', { click: true }), { path: '/opt/person/agy', managed: false })

  // Another desktop profile published one while ours downloaded: ours steps aside.
  let rival
  const raced = world(t, {
    config: { antigravity: true },
    installManifest: async (staging) => {
      writeAgy(join(staging, 'bin', 'agy'))
      rival = join(staging, '..', '1.5.15-00000000-0000-0000-0000-000000000000')
      writeAgy(join(rival, 'bin', 'agy'))
    },
  })
  const got = await raced.cliStore.ensure(SPEC, undefined, { force: true, click: true })
  assert.equal(got.path, join(rival, 'bin', 'agy'))
  assert.deepEqual(folders(raced.home), ['1.5.15-00000000-0000-0000-0000-000000000000'])

  // Two clicks while the first downloads: one download, and the second gets the published copy.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const busy = world(t, { config: { antigravity: true }, installManifest: async (staging) => { await gate; writeAgy(join(staging, 'bin', 'agy')) } })
  const one = busy.cliStore.ensure(SPEC, undefined, { force: true, click: true })
  const two = busy.cliStore.ensure(SPEC, undefined, { force: true, click: true })
  await new Promise(resolve => setImmediate(resolve))
  release()
  const [a, b] = await Promise.all([one, two])
  assert.equal(a.path, b.path)
  assert.equal(busy.calls.download.length, 1)
  assert.equal(busy.calls.manifest.length, 1)
})

test('T9b: the store itself refuses a manual install without a click, and a spent click licenses nothing', unixOnly, async (t) => {
  const w = world(t, { config: { antigravity: true } })
  await assert.rejects(w.cliStore.ensure(SPEC, undefined, { force: true }), /^Error: acp-install\/manual/)
  assert.equal(w.cliStore.lastFailure('agy'), undefined)
  await assert.rejects(w.cliStore.update('agy', SPEC), /acp-install\/manual/)
  assert.deepEqual(w.calls, { manifest: [], download: [] })
  // A click whose install returned a copy already here spends its token: a later update is refused.
  await w.cliStore.ensure(SPEC, undefined, { click: true })
  await w.cliStore.ensure(SPEC, undefined, { click: true })
  assert.equal(w.calls.download.length, 1)
  await assert.rejects(w.cliStore.update('agy', SPEC), /acp-install\/manual/)
  assert.equal(w.cliStore.clicked.size, 0)
})

test('T8: a wrong version, a failed download or a quit publish nothing, and the row says why', unixOnly, async (t) => {
  const old = world(t, { config: { antigravity: true }, installManifest: async staging => { writeAgy(join(staging, 'bin', 'agy'), '1.5.14') } })
  await old.service.installCli(ID)
  await old.settle()
  assert.deepEqual(folders(old.home), [])
  const row = await old.row()
  assert.equal(row.cli.state, 'failed')
  assert.match(row.cli.error, /Antigravity did not pass its version check after installation/)
  assert.match(row.cli.diagnostic, /agy --version printed: "agy 1\.5\.14"/)

  const bad = world(t, { config: { antigravity: true }, installManifest: async () => { throw new Error('Antigravity\'s download did not match its published checksum') } })
  await bad.service.installCli(ID)
  await bad.settle()
  assert.deepEqual(folders(bad.home), [])
  assert.match((await bad.row()).cli.error, /did not match its published checksum/)

  const quit = world(t, {
    config: { antigravity: true },
    installManifest: (staging, spec, manifest, { signal }) => new Promise((resolve, reject) => {
      writeAgy(join(staging, 'bin', 'agy'))
      signal.addEventListener('abort', () => reject(new Error('install stopped: DSH is quitting')))
    }),
  })
  const job = quit.cliStore.ensure(SPEC, undefined, { force: true, click: true })
  await new Promise(resolve => setImmediate(resolve))
  quit.cliStore.dispose()
  await assert.rejects(job, /quitting/)
  assert.deepEqual(folders(quit.home), [])
})

test('T8b: an install a hard quit left half done is removed with no click', unixOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-agy-stale-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const w = world(t, { config: { antigravity: true } })
  const stale = join(w.home, 'agy', '.install-999999999-1-00000000-0000-0000-0000-000000000000')
  mkdirSync(join(stale, 'bin'), { recursive: true })
  writeFileSync(join(stale, 'payload'), 'half a download')
  await w.service.status()
  w.emit('loader/volatile-update')
  assert.equal(existsSync(stale), false)
  assert.deepEqual(w.calls, { manifest: [], download: [] })
})

test('T12: the real unpack and version check leave the person\'s shell profiles and ~/.local/bin as they were', unixOnly, async (t) => {
  const person = mkdtempSync(join(tmpdir(), 'acp-dsh-agy-person-'))
  t.after(() => rmSync(person, { recursive: true, force: true }))
  const files = ['.bashrc', '.profile', '.zshrc'].map(name => join(person, name))
  for (const file of files) writeFileSync(file, `# ${file}\n`)
  mkdirSync(join(person, '.local', 'bin'), { recursive: true })
  const before = files.map(file => readFileSync(file))
  const saved = process.env.HOME
  process.env.HOME = person
  t.after(() => { process.env.HOME = saved })
  // A real tar.gz holding the fake agy, checked against its real sha512.
  const src = join(person, '..', `${person.split('/').pop()}-src`)
  mkdirSync(src)
  t.after(() => rmSync(src, { recursive: true, force: true }))
  writeFileSync(join(src, 'antigravity'), agyScript('1.5.15'), { mode: 0o755 })
  execFileSync('tar', ['-czf', join(src, 'agy.tar.gz'), '-C', src, 'antigravity'])
  const bytes = readFileSync(join(src, 'agy.tar.gz'))
  const fetches = []
  const fetch = async (url, options) => { fetches.push([url, options.redirect]); return new Response(bytes) }
  const w = world(t, {
    config: { antigravity: true },
    manifest: async () => ({ ...MANIFEST, sha512: createHash('sha512').update(bytes).digest('hex') }),
    installManifest: (staging, spec, manifest, options) => installAgy(staging, spec, manifest, { ...options, fetch }),
  })
  await w.service.installCli(ID)
  await w.settle()
  assert.equal((await w.row()).cli.state, 'ready')
  assert.deepEqual(fetches, [[URL, 'error']])
  assert.deepEqual(files.map(file => readFileSync(file)), before)
  assert.equal(existsSync(join(person, '.local', 'bin', 'agy')), false)
  assert.equal(existsSync(join(person, '.gemini')), false)
  const [published] = folders(w.home)
  assert.deepEqual(readdirSync(join(w.home, 'agy', published)), ['bin'])
})
