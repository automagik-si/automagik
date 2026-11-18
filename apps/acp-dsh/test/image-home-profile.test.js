// Temp homes only. The fake sees the same home and overrides as the session.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { chatProfileModes, chatProfileModesFor, chatProfilesConfig, ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { configArgs, drawImage, IMAGE_PROFILE_DESCRIPTION, IMAGE_PROFILE_GRANTS, IMAGE_TITLE, imageOverrides, imageProfileFor, imageSupport, UNAVAILABLE } from '../src/host/image.js'

const FAKE = join(import.meta.dirname, '../dev/fake-image-agent.mjs')
const HEX = 'a'.repeat(32)
const PROFILE = imageProfileFor(chatProfileModesFor(HEX))
const input = { data: Buffer.from('89504e470d0a1a0a', 'hex'), mimeType: 'image/png' }
function fixture(t, env = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'image-home-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileModes = ensureChatProfiles(home, { platform: 'linux' })
  const launch = { command: process.execPath, args: [FAKE], profileModes, env: { CODEX_HOME: home, FAKE_IMAGE_PROFILE: 'offer', FAKE_IMAGE_TRACE: join(home, 'trace'), ...env } }
  const logs = [], scratches = []
  const original = readFileSync(join(home, 'config.toml'))
  return { home, launch, logs, scratches, original,
    trace: () => existsSync(join(home, 'trace')) ? readFileSync(join(home, 'trace'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    request: { spawn: () => launch, prompt: 'test drawing', log: line => logs.push(line), scratch: async () => { const dir = mkdtempSync(join(home, 'scratch-')); scratches.push(dir); return dir } },
  }
}
const refusedEdit = error => error.code === UNAVAILABLE && error.reason === 'edit-not-isolated'
const fallback = reason => `the Codex image run is not isolated (${reason}); falling back to read-only`
// A render with one required switch on is a feature-effect proof, not a session check.
const isProof = args => args.some(arg => arg.startsWith('features=') && /(?:^|[ {,])(shell_tool|view_image) = true/.test(arg))
async function withoutFallback() {
  const suffix = '?image-home-no-fallback'
  const hook = registerHooks({ load(url, context, next) {
    const result = next(url, context)
    if (!url.endsWith(suffix)) return result
    const policy = 'const ALLOW_IMAGE_READ_ONLY_FALLBACK = true'
    assert.ok(String(result.source).includes(policy))
    return { ...result, source: String(result.source).replace(policy, 'const ALLOW_IMAGE_READ_ONLY_FALLBACK = false') }
  } })
  try { return await import(`../src/host/image.js${suffix}`) } finally { hook.deregister() }
}

// Exercise missing failure combinations at the CLI/session boundary without a child
// transport. The fake-agent cases still cover the actual ACP exchange.
function boundary(t, { modes = 'offered', refuseConfig = false, onCheck, onMode } = {}) {
  const f = fixture(t), events = []
  const mock = t.mock.method(childProcess, 'execFile', (_command, args, options, callback) => {
    const profile = args.some(arg => arg.startsWith('default_permissions='))
    const debug = args.includes('prompt-input')
    // The switch's effect is read too: with one required feature on, its tool must appear.
    const table = args.find((arg, index) => args[index - 1] === '-c' && arg.startsWith('features=')) ?? ''
    const on = name => new RegExp(`(?:^|[ {,])${name} = true`).test(table)
    // A render with a required switch on is a feature proof, not the session's own config.
    const proof = on('shell_tool') || on('view_image')
    if (debug) {
      events.push({ event: 'check', profile, proof })
      if (!proof) onCheck?.(f)
    }
    const grants = `<permission_profile type="managed"><file_system type="restricted"><entry access="deny" escalatable="false"><special>:root</special></entry><entry access="read"><path>${options.cwd}</path></entry></file_system></permission_profile>`
    const nested = ['apply_patch', ...(on('shell_tool') ? ['exec_command'] : []), ...(on('view_image') ? ['view_image'] : [])]
    const tools = [
      { type: 'namespace', name: 'image_gen', tools: [{ type: 'function', name: 'imagegen', parameters: {} }] },
      { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: nested.map(name => `declare const tools: { ${name}(args: {}): Promise<unknown>; };`).join('\n') }] },
    ]
    const answer = args.includes('features')
      ? 'shell_tool stable false\nview_image stable false\nimage_generation stable true\n'
      : debug ? JSON.stringify([
        { type: 'additional_tools', tools },
        { type: 'message', content: [{ type: 'input_text', text: grants }] },
      ]) : '[]'
    queueMicrotask(() => callback(null, answer, profile && refuseConfig ? 'Invalid configuration; using defaults' : ''))
    return { kill() {} }
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  class Run {
    constructor(spec) { this.spec = spec }
    async start() {
      events.push({ event: 'start' })
      const profile = imageProfileFor(f.launch.profileModes)
      this.modes = modes === 'absent' ? undefined : { availableModes: [
        { id: 'read-only' }, ...(modes === 'legacy' ? [] : [{ id: profile.mode }]),
      ] }
    }
    async setMode(mode) {
      events.push({ event: 'mode', mode })
      if (mode.startsWith('permission-profile:') && modes === 'reject') throw new Error('profile selection refused')
      onMode?.(f, mode)
      events.push({ event: 'ack', mode })
    }
    async prompt() {
      events.push({ event: 'prompt' })
      this.spec.onTool({ id: 'one-image', title: IMAGE_TITLE, status: 'completed', rawOutput: { result: input.data.toString('base64') } })
    }
    async next() { return { type: 'end' } }
    dispose() {}
  }
  return { ...f, events, request: { ...f.request, Run } }
}

test('imageProfileFor uses only the exact lowercase read-profile suffix', () => {
  assert.deepEqual(PROFILE, { id: `automagik-image-${HEX}`, mode: `permission-profile:automagik-image-${HEX}` })
  for (const modes of [undefined, {}, { 'read-only': 1 }, ...[
    `permission-profile:automagik-other-${HEX}`, `permission-profile:automagik-read-${'a'.repeat(31)}`,
    `permission-profile:automagik-read-${'a'.repeat(33)}`, `permission-profile:automagik-read-${'A'.repeat(32)}`,
    `permission-profile:automagik-workspace-${HEX}`,
  ].map(mode => ({ 'read-only': mode }))]) assert.equal(imageProfileFor(modes), undefined)
})

test('imageOverrides keeps the legacy object and adds exactly the selected profile keys', () => {
  const old = { features: { image_generation: true, shell_tool: false, view_image: false }, web_search: 'disabled', mcp_servers: {}, skills: { bundled: { enabled: false }, config: [] }, projects: { '/S': { trust_level: 'trusted' } } }
  assert.deepEqual(imageOverrides({ project: '/S' }), old)
  const overrides = imageOverrides({ project: '/S', profile: PROFILE })
  assert.deepEqual(overrides, { ...old, default_permissions: PROFILE.id, permissions: { [PROFILE.id]: { description: IMAGE_PROFILE_DESCRIPTION, filesystem: IMAGE_PROFILE_GRANTS } } })
  assert.deepEqual(Object.keys(overrides), [...Object.keys(old), 'default_permissions', 'permissions'])
  const args = configArgs(overrides)
  assert.ok(args.includes(`default_permissions='${PROFILE.id}'`))
  assert.ok(args.includes(`permissions={ ${PROFILE.id} = { description = 'Draw one image in the scratch folder', filesystem = { ':root' = 'deny', ':workspace_roots' = 'read' } } }`))
})

test('the image table is last, migrates old homes, and is owned by name', t => {
  const f = fixture(t)
  const config = chatProfilesConfig('/h', HEX, '/runtime')
  const imageTable = config.slice(config.indexOf(`[permissions.${PROFILE.id}]`))
  assert.equal(imageTable, `[permissions.${PROFILE.id}]\ndescription = 'Draw one image in the scratch folder'\n[permissions.${PROFILE.id}.filesystem]\n':root' = 'deny'\n':workspace_roots' = 'read'\n`)
  assert.equal(config.match(new RegExp(`\\[permissions\\.${PROFILE.id}\\]`, 'g')).length, 1)
  const file = join(f.home, 'config.toml')
  writeFileSync(file, config.slice(0, config.indexOf(`[permissions.${PROFILE.id}]`)))
  const modes = ensureChatProfiles(f.home, { platform: 'linux' })
  assert.deepEqual(modes, chatProfileModesFor(HEX))
  assert.ok(readFileSync(file, 'utf8').endsWith(imageTable))
  writeFileSync(file, readFileSync(file, 'utf8') + "'/private-extra' = 'read'\n")
  ensureChatProfiles(f.home, { platform: 'linux' })
  assert.equal(readFileSync(file, 'utf8').includes('private-extra'), false)
  writeFileSync(file, `[permissions.${PROFILE.id}]\ndescription = 'personal'\n[permissions.${PROFILE.id}.filesystem]\n'/personal' = 'write'\n`)
  assert.deepEqual(ensureChatProfiles(f.home, { platform: 'linux' }), modes)
  assert.equal(readFileSync(file, 'utf8').includes('/personal'), false)
  writeFileSync(file, '[permissions.automagik-other]\ndescription = "personal"\n')
  const before = readFileSync(file)
  assert.equal(ensureChatProfiles(f.home, { platform: 'linux' }), undefined)
  assert.deepEqual(readFileSync(file), before)
})

for (const edit of [false, true]) test(`home image profile: ${edit ? 'edit' : 'draw'} is checked and acknowledged before its prompt`, async t => {
  const f = fixture(t)
  let observed = 0
  // Observe the default ImageRun without replacing its image-tool update handling.
  for (const method of ['start', 'prompt']) {
    const original = AgentRun.prototype[method]
    t.mock.method(AgentRun.prototype, method, function (...args) {
      assert.equal(existsSync(join(this.spec.cwd, '.codex')), false)
      observed++
      return original.apply(this, args)
    })
  }
  const made = await drawImage({ ...f.request, ...(edit ? { input } : {}) })
  assert.equal(made.isolated, true)
  assert.equal(observed, 2)
  const trace = f.trace(), config = JSON.parse(trace.find(row => row.event === 'start').codexConfig)
  const profile = imageProfileFor(f.launch.profileModes)
  assert.equal(config.default_permissions, profile.id)
  assert.deepEqual(config.permissions[profile.id], { description: IMAGE_PROFILE_DESCRIPTION, filesystem: IMAGE_PROFILE_GRANTS })
  for (const check of trace.filter(row => row.event === 'cli' && row.args[0] === 'debug' && !isProof(row.args))) assert.deepEqual(check.args, ['debug', 'prompt-input', ...configArgs(config)])
  assert.equal(trace.filter(row => row.event === 'cli' && row.args[0] === 'debug' && isProof(row.args)).length, 2, 'one effect proof per required switch')
  const ack = trace.find(row => row.event === 'mode-ack'), prompt = trace.find(row => row.event === 'prompt')
  assert.equal(ack.modeId, profile.mode)
  assert.ok(trace.indexOf(ack) < trace.indexOf(prompt))
  assert.deepEqual(readFileSync(join(f.home, 'config.toml')), f.original)
  assert.deepEqual(f.logs, [])
})

for (const missing of ['profileModes', 'CODEX_HOME', 'home file']) test(`missing ${missing} falls back and refuses editing`, async t => {
  for (const edit of [false, true]) {
    const f = fixture(t)
    if (missing === 'profileModes') delete f.launch.profileModes
    else if (missing === 'CODEX_HOME') delete f.launch.env.CODEX_HOME
    else rmSync(join(f.home, 'config.toml'))
    const drawing = drawImage({ ...f.request, ...(edit ? { input } : {}) })
    if (edit) await assert.rejects(drawing, refusedEdit)
    else assert.equal((await drawing).isolated, false)
    assert.deepEqual(f.logs, [fallback('profile unavailable')])
    assert.equal(f.trace().some(row => row.event === 'prompt'), !edit)
  }
})

for (const resolved of ['wider', 'write', 'missing', 'odd']) test(`resolved profile ${resolved} retries without the profile and refuses edits`, async t => {
  for (const edit of [false, true]) {
    const f = fixture(t, { FAKE_PROFILE_RESOLVED: resolved })
    const drawing = drawImage({ ...f.request, ...(edit ? { input } : {}) })
    if (edit) await assert.rejects(drawing, refusedEdit)
    else assert.equal((await drawing).isolated, false)
    const trace = f.trace(), checks = trace.filter(row => row.event === 'cli' && row.args[0] === 'debug' && !isProof(row.args))
    assert.deepEqual(checks.map(row => row.args.some(arg => arg.startsWith('default_permissions='))), [true, false])
    const config = JSON.parse(trace.find(row => row.event === 'start').codexConfig)
    assert.equal('default_permissions' in config, false)
    assert.equal('permissions' in config, false)
    assert.deepEqual(f.logs, [fallback('profile wider than requested')])
    assert.equal(trace.some(row => row.event === 'prompt'), !edit)
  }
  const strict = await withoutFallback(), f = fixture(t, { FAKE_PROFILE_RESOLVED: resolved })
  await assert.rejects(strict.drawImage(f.request), error => error.code === UNAVAILABLE)
  assert.equal(f.trace().some(row => row.event === 'start'), false)
})

test('a lost concurrent home suffix never offers the other image mode', async t => {
  for (const edit of [false, true]) {
    const f = fixture(t)
    f.launch.profileModes = chatProfileModesFor(HEX)
    const drawing = drawImage({ ...f.request, ...(edit ? { input } : {}) })
    if (edit) await assert.rejects(drawing, refusedEdit)
    else assert.equal((await drawing).isolated, false)
    assert.deepEqual(f.logs, [fallback('profile mode not offered')])
    assert.equal(f.trace().some(row => row.event === 'prompt'), !edit)
  }
})

test('home bytes changed during mode acknowledgement fall back before the prompt', async t => {
  const setMode = AgentRun.prototype.setMode
  // Keep ImageRun's tool handling while changing the home after the real acknowledgement.
  t.mock.method(AgentRun.prototype, 'setMode', async function (mode, options) {
    const result = await setMode.call(this, mode, options)
    if (mode.startsWith('permission-profile:')) writeFileSync(join(this.spec.env.CODEX_HOME, 'config.toml'), '# changed\n')
    return result
  })
  for (const policy of ['draw', 'edit', 'strict']) {
    const f = fixture(t)
    const draw = policy === 'strict' ? (await withoutFallback()).drawImage : drawImage
    const drawing = draw({ ...f.request, ...(policy === 'edit' ? { input } : {}) })
    if (policy === 'edit') await assert.rejects(drawing, refusedEdit)
    else if (policy === 'strict') await assert.rejects(drawing, error => error.code === UNAVAILABLE)
    else assert.equal((await drawing).isolated, false)
    const trace = f.trace()
    assert.equal(trace.some(row => row.event === 'prompt'), policy === 'draw')
    if (policy === 'strict') assert.deepEqual(f.logs, [])
    else {
      assert.deepEqual(f.logs, [fallback('profile config changed')])
      assert.equal(trace.filter(row => row.event === 'mode-ack').at(-1).modeId, 'read-only')
      if (policy === 'draw') assert.equal(trace.find(row => row.event === 'prompt').modeId, 'read-only')
    }
  }
})

test('concurrent draws share an image id, keep separate scratch folders, and preserve home bytes', async t => {
  const f = fixture(t)
  const results = await Promise.all([drawImage(f.request), drawImage(f.request), drawImage(f.request)])
  assert.ok(results.every(result => result.isolated === true))
  const sessions = f.trace().filter(row => row.event === 'new-session')
  assert.equal(new Set(sessions.map(row => row.profileId)).size, 1)
  assert.equal(new Set(sessions.map(row => row.cwd)).size, 3)
  assert.deepEqual(readFileSync(join(f.home, 'config.toml')), f.original)
})

test('readiness passes when only the profile override is refused and drawing retries', async t => {
  const f = fixture(t, { FAKE_INVALID_CONFIG: 'profile' })
  assert.deepEqual(await imageSupport()(f.launch), { ok: true })
  assert.equal((await drawImage(f.request)).isolated, false)
  assert.deepEqual(f.logs, [fallback('profile config refused')])
})

test('adding the image table preserves the complete chat tables, default, and mode mapping', () => {
  const config = chatProfilesConfig('/chat/home', HEX, '/codex/runtime')
  const imageAt = config.indexOf(`[permissions.${PROFILE.id}]`)
  assert.equal(config.slice(0, imageAt), [
    '# Automagik chat permissions (managed by Automagik)', "default_permissions = ':read-only'", '',
    '# Automagik chat permission profiles (managed by Automagik)',
    `[permissions.automagik-read-${HEX}]`, "description = 'Automagik Read only: read the chat workspace'",
    `[permissions.automagik-read-${HEX}.filesystem]`,
    "':root' = 'deny'", "':minimal' = 'read'", "':workspace_roots' = 'read'", "':project_roots' = 'read'",
    `'${join('/chat/home', 'skills')}' = 'read'`, "'/codex/runtime' = 'read'",
    `[permissions.automagik-workspace-${HEX}]`, "description = 'Automagik Workspace: work in the chat workspace'",
    `[permissions.automagik-workspace-${HEX}.filesystem]`,
    "':root' = 'deny'", "':minimal' = 'read'", "':workspace_roots' = 'write'", "':project_roots' = 'read'",
    "':tmpdir' = 'write'", "':slash_tmp' = 'write'", `'${join('/chat/home', 'skills')}' = 'read'`, "'/codex/runtime' = 'read'", '',
  ].join('\n'))
  const modes = chatProfileModesFor(HEX)
  assert.deepEqual(modes, {
    'read-only': `permission-profile:automagik-read-${HEX}`,
    'workspace-write': `permission-profile:automagik-workspace-${HEX}`,
  })
  assert.deepEqual(chatProfileModes(['read-only', 'workspace-write', 'agent'], modes), [
    modes['read-only'], 'read-only', modes['workspace-write'], 'workspace-write', 'agent',
  ])
})

for (const original of ["permissions = {}\n", "default_permissions = 'personal'\n"]) {
  test(`image profile refresh still refuses conflicting top-level ${original.split(' ')[0]}`, t => {
    const f = fixture(t), file = join(f.home, 'config.toml')
    writeFileSync(file, original)
    assert.equal(ensureChatProfiles(f.home, { platform: 'linux' }), undefined)
    assert.equal(readFileSync(file, 'utf8'), original)
  })
}

for (const modes of ['absent', 'legacy', 'reject']) for (const policy of ['draw', 'edit', 'strict']) {
  test(`older adapter ${modes} mode: ${policy} never claims isolation`, async t => {
    const f = boundary(t, { modes })
    const draw = policy === 'strict' ? (await withoutFallback()).drawImage : drawImage
    const drawing = draw({ ...f.request, ...(policy === 'edit' ? { input } : {}) })
    if (policy === 'edit') await assert.rejects(drawing, refusedEdit)
    else if (policy === 'strict') await assert.rejects(drawing, error => error.code === UNAVAILABLE)
    else assert.equal((await drawing).isolated, false)
    assert.equal(f.events.some(row => row.event === 'prompt'), policy === 'draw')
    const reason = modes === 'reject' ? 'profile mode selection rejected' : 'profile mode not offered'
    assert.deepEqual(f.logs, policy === 'strict' ? [] : [fallback(reason)])
    const selected = f.events.filter(row => row.event === 'mode').map(row => row.mode)
    const profileMode = imageProfileFor(f.launch.profileModes).mode
    assert.deepEqual(selected, [...(modes === 'reject' ? [profileMode] : []), ...(policy === 'strict' ? [] : ['read-only'])])
    if (policy === 'draw') assert.ok(f.events.findIndex(row => row.event === 'ack' && row.mode === 'read-only') < f.events.findIndex(row => row.event === 'prompt'))
    assert.deepEqual(readFileSync(join(f.home, 'config.toml')), f.original)
  })
}

for (const policy of ['edit', 'strict']) test(`profile-only config refusal: ${policy} sends no prompt`, async t => {
  const f = boundary(t, { refuseConfig: true })
  const draw = policy === 'strict' ? (await withoutFallback()).drawImage : drawImage
  await assert.rejects(draw({ ...f.request, ...(policy === 'edit' ? { input } : {}) }), policy === 'edit' ? refusedEdit : error => error.code === UNAVAILABLE)
  assert.equal(f.events.some(row => row.event === 'prompt'), false)
  assert.deepEqual(f.events.filter(row => row.event === 'check' && !row.proof).map(row => row.profile), policy === 'strict' ? [true] : [true, false])
  assert.equal(f.events.some(row => row.event === 'start'), policy === 'edit')
  assert.deepEqual(f.logs, policy === 'strict' ? [] : [fallback('profile config refused')])
})

for (const entry of ['directory', 'file', 'dangling symlink']) for (const timing of ['check', 'acknowledgement']) for (const policy of ['draw', 'edit', 'strict']) {
  test(`scratch .codex ${entry} at ${timing}: ${policy} cannot proceed as isolated`, async t => {
    const addEntry = f => {
      const path = join(f.scratches[0], '.codex')
      if (entry === 'directory') mkdirSync(path)
      else if (entry === 'file') writeFileSync(path, '')
      else symlinkSync(join(f.home, 'missing'), path)
    }
    const f = boundary(t, timing === 'check' ? { onCheck: addEntry }
      : { onMode: (f, mode) => { if (mode.startsWith('permission-profile:')) addEntry(f) } })
    const draw = policy === 'strict' ? (await withoutFallback()).drawImage : drawImage
    const drawing = draw({ ...f.request, ...(policy === 'edit' ? { input } : {}) })
    if (policy === 'edit') await assert.rejects(drawing, refusedEdit)
    else if (policy === 'strict') await assert.rejects(drawing, error => error.code === UNAVAILABLE)
    else assert.equal((await drawing).isolated, false)
    assert.equal(f.events.some(row => row.event === 'prompt'), policy === 'draw')
    assert.deepEqual(f.logs, policy === 'strict' ? [] : [fallback('profile config changed')])
    if (policy !== 'strict') assert.equal(f.events.filter(row => row.event === 'ack').at(-1).mode, 'read-only')
    if (policy === 'draw') assert.ok(f.events.findIndex(row => row.event === 'ack' && row.mode === 'read-only') < f.events.findIndex(row => row.event === 'prompt'))
    assert.deepEqual(readFileSync(join(f.home, 'config.toml')), f.original)
  })
}

for (const timing of ['during check', 'unreadable at acknowledgement']) for (const policy of ['draw', 'edit', 'strict']) {
  test(`home config ${timing}: ${policy} cannot proceed as isolated`, async t => {
    const f = boundary(t, timing === 'during check'
      ? { onCheck: f => writeFileSync(join(f.home, 'config.toml'), '# changed before mode acknowledgement\n') }
      : { onMode: (f, mode) => { if (mode.startsWith('permission-profile:')) rmSync(join(f.home, 'config.toml')) } })
    const draw = policy === 'strict' ? (await withoutFallback()).drawImage : drawImage
    const drawing = draw({ ...f.request, ...(policy === 'edit' ? { input } : {}) })
    if (policy === 'edit') await assert.rejects(drawing, refusedEdit)
    else if (policy === 'strict') await assert.rejects(drawing, error => error.code === UNAVAILABLE)
    else assert.equal((await drawing).isolated, false)
    assert.equal(f.events.some(row => row.event === 'prompt'), policy === 'draw')
    assert.deepEqual(f.logs, policy === 'strict' ? [] : [fallback('profile config changed')])
    if (policy !== 'strict') assert.equal(f.events.filter(row => row.event === 'ack').at(-1).mode, 'read-only')
    if (policy === 'draw') assert.ok(f.events.findIndex(row => row.event === 'ack' && row.mode === 'read-only') < f.events.findIndex(row => row.event === 'prompt'))
  })
}
