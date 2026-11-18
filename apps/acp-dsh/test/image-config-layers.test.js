// Temp homes only. System and ancestor paths are mapped inside the fixture.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import {
  codexConfigSources, configFingerprint, drawImage, IMAGE_TITLE, imageProfileFor, UNAVAILABLE,
} from '../src/host/image.js'

const input = { data: Buffer.from('89504e470d0a1a0a', 'hex'), mimeType: 'image/png' }
const systemPaths = [
  '/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
]
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'image-layers-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileModes = ensureChatProfiles(home, { platform: 'linux' })
  const launch = { command: 'fake-codex', profileModes, env: { CODEX_HOME: home } }
  const logs = [], scratches = []
  const original = readFileSync(join(home, 'config.toml'))
  const mapped = path => join(home, 'layers', path)
  const configSources = options => codexConfigSources({ ...options, platform: 'linux' })
    .map(source => source.kind === 'required' ? source : {
      ...source, path: mapped(source.path),
    })
  return { home, launch, logs, scratches, original, mapped,
    request: {
      spawn: () => launch, prompt: 'test drawing', log: line => logs.push(line), configSources,
      scratch: async () => {
        const dir = mkdtempSync(join(home, 'scratch-'))
        scratches.push(dir)
        return dir
      },
    },
  }
}
const refusedEdit = error => error.code === UNAVAILABLE && error.reason === 'edit-not-isolated'
const fallback = reason =>
  `the Codex image run is not isolated (${reason}); falling back to read-only`
async function withoutFallback() {
  const suffix = '?image-layers-no-fallback'
  const hook = registerHooks({ load(url, context, next) {
    const result = next(url, context)
    if (!url.endsWith(suffix)) return result
    const policy = 'const ALLOW_IMAGE_READ_ONLY_FALLBACK = true'
    assert.ok(String(result.source).includes(policy))
    return { ...result,
      source: String(result.source).replace(policy, 'const ALLOW_IMAGE_READ_ONLY_FALLBACK = false'),
    }
  } })
  try { return await import(`../src/host/image.js${suffix}`) } finally { hook.deregister() }
}

// Exercise the CLI/session boundary without a child transport.
function boundary(t, { onCheck, onMode } = {}) {
  const f = fixture(t), events = []
  const mock = t.mock.method(childProcess, 'execFile', (_command, args, options, callback) => {
    const debug = args.includes('prompt-input')
    if (debug) {
      events.push({ event: 'check' })
      onCheck?.(f)
    }
    const grants = '<permission_profile type="managed"><file_system type="restricted">'
      + '<entry access="deny" escalatable="false"><special>:root</special></entry>'
      + `<entry access="read"><path>${options.cwd}</path></entry>`
      + '</file_system></permission_profile>'
    const answer = args.includes('features')
      ? 'shell_tool stable false\nview_image stable false\nimage_generation stable true\n'
      : debug ? JSON.stringify([
        { type: 'additional_tools', tools: [{ type: 'namespace', name: 'image_gen', tools: [
          { type: 'function', name: 'imagegen', parameters: {} },
        ] }] },
        { type: 'message', content: [{ type: 'input_text', text: grants }] },
      ]) : '[]'
    queueMicrotask(() => callback(null, answer, ''))
    return { kill() {} }
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  class Run {
    constructor(spec) { this.spec = spec }
    async start() {
      events.push({ event: 'start' })
      this.modes = { availableModes: [
        { id: 'read-only' }, { id: imageProfileFor(f.launch.profileModes).mode },
      ] }
    }
    async setMode(mode) {
      events.push({ event: 'mode', mode })
      onMode?.(f, mode)
      events.push({ event: 'ack', mode })
    }
    async prompt() {
      events.push({ event: 'prompt' })
      this.spec.onTool({ id: 'one-image', title: IMAGE_TITLE, status: 'completed',
        rawOutput: { result: input.data.toString('base64') },
      })
    }
    async next() { return { type: 'end' } }
    dispose() {}
  }
  return { ...f, events, request: { ...f.request, Run } }
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`config sources for ${platform} have the required order`, () => {
    const expected = [{ path: '/H/config.toml', kind: 'required' }]
    if (platform !== 'win32') {
      expected.push(...systemPaths.map(path => ({ path, kind: 'file' })))
      for (const ancestor of ['/a/b', '/a', '/']) {
        expected.push({ path: join(ancestor, '.codex/config.toml'), kind: 'file' })
        expected.push({ path: join(ancestor, '.git'), kind: 'marker' })
      }
    }
    assert.deepEqual(codexConfigSources({ codexHome: '/H', scratch: '/a/b/s', platform }), expected)
  })
}

const ioError = code => Object.assign(new Error('fixture read failed'), { code })
function fingerprintFixture() {
  const sources = codexConfigSources({ codexHome: '/H', scratch: '/a/b/s', platform: 'linux' })
  const values = new Map(sources.map(({ path, kind }) => [
    path, kind === 'marker' ? true : Buffer.from('# original\n'),
  ]))
  const io = {
    read: path => {
      if (!values.has(path)) throw ioError('ENOENT')
      return values.get(path)
    },
    stat: (path, options) => {
      assert.deepEqual(options, { throwIfNoEntry: false })
      return values.has(path) ? {} : undefined
    },
  }
  return { sources, values, io, hash: () => configFingerprint(sources, io) }
}

test('the config fingerprint is stable and includes source paths and order', () => {
  const f = fingerprintFixture(), baseline = f.hash()
  assert.match(baseline, /^[0-9a-f]{64}$/)
  assert.equal(f.hash(), baseline)
  assert.notEqual(configFingerprint([...f.sources].reverse(), f.io), baseline)
  const renamed = f.sources.map((source, i) => i ? source : { ...source, path: '/other/config' })
  f.values.set('/other/config', f.values.get('/H/config.toml'))
  assert.notEqual(configFingerprint(renamed, f.io), baseline)
})

test('a marker fingerprints presence without reading its contents', () => {
  const sources = [{ path: '/a/.git', kind: 'marker' }]
  let present = true, reads = 0, stats = 0
  const io = {
    read: () => { reads++; throw ioError('EISDIR') },
    stat: (path, options) => {
      assert.equal(path, '/a/.git')
      assert.deepEqual(options, { throwIfNoEntry: false })
      stats++
      return present ? {} : undefined
    },
  }
  const baseline = configFingerprint(sources, io)
  assert.match(baseline, /^[0-9a-f]{64}$/)
  assert.equal(configFingerprint(sources, io), baseline)
  present = false
  const absent = configFingerprint(sources, io)
  assert.match(absent, /^[0-9a-f]{64}$/)
  assert.notEqual(absent, baseline)
  assert.equal(stats, 3)
  assert.equal(reads, 0)
})

for (const source of fingerprintFixture().sources) {
  test(`the config fingerprint tracks ${source.kind} ${source.path}`, () => {
    const f = fingerprintFixture(), baseline = f.hash(), before = f.values.get(source.path)
    if (source.kind !== 'marker') {
      f.values.set(source.path, Buffer.from('# changed\n'))
      assert.notEqual(f.hash(), baseline)
      f.values.set(source.path, before)
    }
    f.values.delete(source.path)
    const absent = f.hash()
    if (source.kind === 'required') assert.equal(absent, undefined)
    else assert.match(absent, /^[0-9a-f]{64}$/)
    assert.notEqual(absent, baseline)
    f.values.set(source.path, before)
    assert.equal(f.hash(), baseline)
    assert.notEqual(f.hash(), absent)
  })
}

for (const kind of ['required', 'file', 'marker']) {
  for (const code of ['EACCES', 'EIO', 'ENOENT', 'ENOTDIR']) {
    test(`${kind} config source handles ${code}`, () => {
      const sources = [{ path: '/fixture', kind }]
      const fail = () => { throw ioError(code) }
      const actual = configFingerprint(sources, { read: fail, stat: fail })
      if (kind === 'required' || ['EACCES', 'EIO'].includes(code)) {
        assert.equal(actual, undefined)
      } else {
        const absent = () => { throw ioError('ENOENT') }
        assert.match(actual, /^[0-9a-f]{64}$/)
        assert.equal(actual, configFingerprint(sources, { read: absent, stat: () => undefined }))
      }
    })
  }
}

const layers = [
  ...systemPaths.map(path => ({ name: path, path: () => path, kind: 'file' })),
  { name: 'ancestor config', path: f => join(f.home, '.codex/config.toml'), kind: 'file' },
  { name: 'ancestor marker', path: f => join(f.home, '.git'), kind: 'marker' },
]
function put(path, value = '# original\n') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

for (const layer of layers) {
  const changes = layer.kind === 'marker'
    ? ['created', 'removed'] : ['created', 'modified', 'removed']
  for (const change of changes) for (const timing of ['check', 'acknowledgement']) {
    for (const policy of ['draw', 'edit', 'strict']) {
      test(`${layer.name} ${change} at ${timing}: ${policy} loses isolation`, async t => {
        const mutate = f => {
          const path = f.mapped(layer.path(f))
          if (change === 'removed') rmSync(path)
          else put(path, '# changed\n')
        }
        const hooks = timing === 'check' ? { onCheck: mutate } : {
          onMode: (f, mode) => { if (mode.startsWith('permission-profile:')) mutate(f) },
        }
        const f = boundary(t, hooks)
        if (change !== 'created') put(f.mapped(layer.path(f)))
        const draw = policy === 'strict' ? (await withoutFallback()).drawImage : drawImage
        const drawing = draw({ ...f.request, ...(policy === 'edit' ? { input } : {}) })
        if (policy === 'edit') await assert.rejects(drawing, refusedEdit)
        else if (policy === 'strict') {
          await assert.rejects(drawing, error => error.code === UNAVAILABLE)
        } else assert.equal((await drawing).isolated, false)
        const prompt = f.events.findIndex(row => row.event === 'prompt')
        assert.equal(prompt !== -1, policy === 'draw')
        const logs = policy === 'strict' ? [] : [fallback('profile config changed')]
        assert.deepEqual(f.logs, logs)
        if (policy !== 'strict') {
          assert.equal(f.events.filter(row => row.event === 'ack').at(-1).mode, 'read-only')
        }
        if (policy === 'draw') {
          const ack = f.events.findIndex(row => row.event === 'ack' && row.mode === 'read-only')
          assert.ok(ack >= 0 && ack < prompt)
        }
        assert.deepEqual(readFileSync(join(f.home, 'config.toml')), f.original)
      })
    }
  }
}

for (const present of [false, true]) test(`unchanged layers, present=${present}`, async t => {
  const f = boundary(t)
  if (present) for (const layer of layers) put(f.mapped(layer.path(f)))
  assert.equal((await drawImage(f.request)).isolated, true)
  assert.deepEqual(f.logs, [])
  const prompt = f.events.findIndex(row => row.event === 'prompt')
  const ack = f.events.findIndex(row => row.event === 'ack')
  assert.ok(ack >= 0 && ack < prompt)
  assert.equal(f.events[ack].mode, imageProfileFor(f.launch.profileModes).mode)
})

for (const timing of ['check', 'acknowledgement']) {
  test(`ancestor marker contents changed at ${timing} keep isolation`, async t => {
    const mutate = f => put(f.mapped(join(f.home, '.git')), '# changed\n')
    const hooks = timing === 'check' ? { onCheck: mutate } : {
      onMode: (f, mode) => { if (mode.startsWith('permission-profile:')) mutate(f) },
    }
    const f = boundary(t, hooks)
    put(f.mapped(join(f.home, '.git')))
    assert.equal((await drawImage(f.request)).isolated, true)
    assert.deepEqual(f.logs, [])
    assert.equal(f.events.filter(row => row.event === 'ack').at(-1).mode,
      imageProfileFor(f.launch.profileModes).mode)
    assert.equal(f.events.filter(row => row.event === 'prompt').length, 1)
  })
}

for (const path of systemPaths) test(`unreadable baseline ${path} falls back`, {
  skip: process.getuid?.() === 0 ? 'root can read mode 000 files' : false,
}, async t => {
  const f = boundary(t), file = f.mapped(path)
  put(file)
  chmodSync(file, 0o000)
  assert.throws(() => readFileSync(file), { code: 'EACCES' })
  assert.equal((await drawImage(f.request)).isolated, false)
  assert.deepEqual(f.logs, [fallback('profile unavailable')])
  const ack = f.events.findIndex(row => row.event === 'ack' && row.mode === 'read-only')
  assert.ok(ack >= 0 && ack < f.events.findIndex(row => row.event === 'prompt'))
})
