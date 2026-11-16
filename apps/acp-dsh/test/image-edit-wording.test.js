import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { drawImage, IMAGE_PROFILE_GRANTS, UNAVAILABLE } from '../src/host/image.js'
import { chatProfilesConfig, ensureChatProfiles } from '../src/host/codex-chat-profiles.js'
import { realpathSync } from 'node:fs'
import { AcpAdapter } from '../src/host/adapter.js'
import { AgentRun } from '../src/host/acp.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

for (const mode of ['not-offered', 'selection-rejected']) test(`an edit with its locked profile ${mode} retains UNAVAILABLE and a reason and sends no prompt`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'edit-wording-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profileModes = ensureChatProfiles(home, { platform: 'linux' })
  let prompts = 0
  // Keep this refusal test at the CLI boundary: no child transport is needed to
  // exercise the real preflight and the later profile acknowledgement check.
  const checked = []
  const mock = t.mock.method(childProcess, 'execFile', (_command, args, _opts, callback) => {
    checked.push(args)
    const answer = args.includes('features')
      ? 'shell_tool stable false\nview_image stable false\nimage_generation stable true\n'
      : args.includes('debug')
        ? JSON.stringify([{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'image_gen', description: '', tools: [{ type: 'function', name: 'imagegen', description: '', parameters: { type: 'object' } }] }] }, { type: 'message', content: [{ type: 'input_text', text: `<permission_profile type="managed"><file_system type="restricted"><entry access="deny" escalatable="false"><special>:root</special></entry><entry access="read"><path>${_opts.cwd}</path></entry><entry access="read"><path>${realpathSync(home)}/tmp/arg0-linux/codex-arg0hEg6rp</path></entry></file_system></permission_profile>` }] }])
        : '[]'
    queueMicrotask(() => callback(null, answer, ''))
    return { kill() {} }
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const selected = []
  class Run {
    constructor(spec) { this.spec = spec }
    async start() {
      const id = JSON.parse(this.spec.env.CODEX_CONFIG).default_permissions
      this.modes = { availableModes: [{ id: 'read-only' }, ...(mode === 'selection-rejected' ? [{ id: `permission-profile:${id}` }] : [])] }
    }
    async setMode(id) {
      selected.push(id)
      if (id.startsWith('permission-profile:')) throw new Error('test profile refused')
    }
    async prompt() { prompts++; assert.fail('the isolation check must refuse first') }
    dispose() {}
  }
  await assert.rejects(drawImage({
    spawn: () => ({ command: 'test-codex', args: [], profileModes, env: { CODEX_HOME: home } }),
    scratch: () => mkdtemp(join(home, 'scratch-')), Run, log: line => t.diagnostic(line),
    input: { data: PNG, mimeType: 'image/png' }, prompt: 'Make the background blue',
  }), error => {
    assert.equal(error.code, UNAVAILABLE)
    assert.equal(error.reason, 'edit-not-isolated', error.message)
    assert.equal(error.message, 'Codex can edit a picture only inside its locked image run, which could not be set up on this computer, so the picture was not edited.')
    return true
  })
  assert.equal(prompts, 0)
  assert.equal(checked.length, 3)
  assert.equal(selected.at(-1), 'read-only')
  assert.equal(selected.length, mode === 'selection-rejected' ? 2 : 1)
})

test('the per-image profile still denies the filesystem root and reads only its scratch workspace', () => {
  const hex = 'a'.repeat(32)
  assert.deepEqual(IMAGE_PROFILE_GRANTS, { ':root': 'deny', ':workspace_roots': 'read' })
  assert.equal(chatProfilesConfig('/h', hex).split(`[permissions.automagik-image-${hex}.filesystem]\n`)[1], "':root' = 'deny'\n':workspace_roots' = 'read'\n")
})

test('all image refusals retain Codex guidance without OpenAI suggestions; isolation stays enabled', async () => {
  const image = await readFile(new URL('../src/host/image.js', import.meta.url), 'utf8')
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  for (const text of [image, index]) {
    for (const line of text.split('\n').filter(line => /imageRefusal\(|unsupported:|config:/.test(line))) assert.doesNotMatch(line, /OpenAI/)
  }
  assert.match(image, /const EDIT_NEEDS_ISOLATION = true/)
  assert.match(image, /if \(input && EDIT_NEEDS_ISOLATION && isolated !== true\)/)
})

test('a non-person relay with added path text passes uploadBlocks without a block-count check', async t => {
  const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, bytes: PNG.length, mediaType: 'image/png', width: 1, height: 1, name: 'picture.png' } }
  const original = { id: 'forward', role: 'user', source: { kind: 'bot', form: 'relay', role: 'request', senderSessionId: 'test-bot', forwarded: { v: 1 } }, content: [image] }
  const row = { ...original, content: [image, { type: 'text', text: '[Saved picture sha256:aaaaaaaaaaaa: your read-only copy at "/test/picture.png".]' }] }
  const session = { id: 'test-chat', deriveMessages: () => [original] }
  const agent = { id: session.id, session, ctx: { tools: { register: () => () => {} } } }
  const ctx = { agents: { get: () => agent }, get: () => undefined }
  const adapter = new AcpAdapter(ctx, new Map([['acp-test', { name: 'test', spawn: () => assert.fail('no process') }]]))
  const sent = []
  const run = new AgentRun({ name: 'test' })
  run.child = {}
  run.sessionId = 'test-native'
  run.init = { agentCapabilities: { promptCapabilities: { image: true } } }
  run.gone = new Promise(() => {})
  run.conn = { prompt: async params => { sent.push(params); return { stopReason: 'end_turn' } } }
  run.dispose = () => { run.disposed = true; run.letGo(true) }
  adapter.live.set(session.id, { run, provider: 'acp-test', name: 'test', dshAgent: agent, asks: false, calls: new Set(), open: false })
  t.after(() => { adapter.dispose(); run.letGo(true) })
  const before = structuredClone(row)
  await Array.fromAsync(adapter.stream({ provider: 'acp-test', model: 'default', sessionId: session.id, messages: [row] }))
  assert.deepEqual(row, before)
  assert.equal(original.content.length, 1)
  assert.equal(sent.length, 1)
  assert.match(JSON.stringify(sent[0]), /Saved picture sha256:aaaaaaaaaaaa/)
  // Pin the early return independently of the adapter's text-only relay projection.
  const source = await readFile(new URL('../src/host/adapter.js', import.meta.url), 'utf8')
  assert.ok(source.indexOf("if (row.source?.kind !== 'user'") < source.indexOf('saved.content.length !== row.content.length'))
})
