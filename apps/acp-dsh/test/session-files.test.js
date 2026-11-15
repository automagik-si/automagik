import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chatProfileModesFor, restrictedChatGrants } from '../src/host/codex-chat-profiles.js'
import { AgentRun } from '../src/host/acp.js'
import { callArguments, mirrorTool, reviewed } from '../src/host/tool.js'
import { SessionFiles, requestedImages, fileIdentity, sameFiles, affirmativeFileAnswer, sessionFileConfig, drainFileSession, FILE_ALLOW } from '../src/host/session-files.js'

const CANCELLED = { outcome: { outcome: 'cancelled' } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const yes = id => ({ answers: [{ id, selected: [FILE_ALLOW] }] })
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['ws', 'outside', 'codex', 'bin']) mkdirSync(join(root, dir))
  const file = join(root, 'outside', 'approved.png')
  const sibling = join(root, 'outside', 'sibling.png')
  writeFileSync(file, 'image'); writeFileSync(sibling, 'other'); writeFileSync(join(root, 'bin', 'codex'), '')
  const call = { id: 'native-1', structuredName: 'request_permissions', kind: 'other', title: 'Additional sandbox permissions',
    rawInput: { cwd: join(root, 'ws'), environmentId: 'local', permissions: { network: null, fileSystem: {
      read: [file], write: null, entries: [{ path: { type: 'path', path: file }, access: 'read' }],
    } } }, locations: [{ path: file }] }
  return { root, file, sibling, call }
}

test('native 0.169 exact read+entries shape; every unknown or widening scope fails closed', t => {
  const { call, file, sibling } = fixture(t)
  assert.deepEqual(requestedImages(call), [file])
  for (const change of [
    x => { x.structuredName = undefined }, x => { x.structuredName = 'exec_command' },
    x => { x.rawInput.permissions.network = { enabled: true } },
    x => { x.rawInput.permissions.network = { enabled: false } },
    x => { x.rawInput.permissions.fileSystem.write = [file] },
    x => { x.rawInput.permissions.fileSystem.entries[0].access = 'write' },
    x => { x.rawInput.permissions.fileSystem.entries[0].path = { type: 'special', value: 'root' } },
    x => { x.rawInput.permissions.fileSystem.entries[0].path = { type: 'glob_pattern', pattern: '*' } },
    x => { x.rawInput.permissions.fileSystem.entries[0].path.path = sibling },
    x => { x.rawInput.permissions.fileSystem.unknown = true },
    x => { x.rawInput.permissions.unknown = true }, x => { x.rawInput.command = 'cat image' },
    x => { x.rawInput.environmentId = 'remote' }, x => { x.locations = [{ path: sibling }] },
    x => { x.rawInput.permissions.fileSystem.read = [file, file] },
  ]) { const x = structuredClone(call); change(x); assert.equal(requestedImages(x), undefined, change.toString()) }
})

test('canonical regular file identity detects symlink swaps and replacement without claiming immutable bytes', t => {
  const { file, sibling, root } = fixture(t)
  const link = join(root, 'linked.png'); symlinkSync(file, link)
  const identity = fileIdentity(link)
  assert.equal(identity.canonical, file); assert.equal(sameFiles([identity]), true)
  unlinkSync(link); symlinkSync(sibling, link); assert.equal(sameFiles([identity]), false)
  const old = fileIdentity(file)
  const replacement = join(root, 'outside', 'replacement.png')
  writeFileSync(replacement, 'replacement')
  const replacementIdentity = fileIdentity(replacement)
  assert.equal(replacementIdentity.dev, old.dev)
  assert.notEqual(replacementIdentity.ino, old.ino)
  renameSync(replacement, file)
  assert.equal(sameFiles([old]), false)
  assert.throws(() => fileIdentity(root), /regular/)
})

test('only a single exact nonce-bound affirmative with no custom text is accepted', () => {
  assert.equal(affirmativeFileAnswer(yes('nonce'), 'nonce'), true)
  for (const answer of [undefined, {}, { answers: [] }, yes('other'), { answers: [...yes('nonce').answers, ...yes('nonce').answers] },
    { answers: [{ id: 'nonce', selected: [FILE_ALLOW, 'Reject'] }] }, { answers: [{ id: 'nonce', selected: [FILE_ALLOW], custom: '' }] },
    { answers: [{ id: 'nonce', selected: ['allowed-once'] }] }, { answers: [{ id: 'nonce', selected: [FILE_ALLOW], extra: true }] }]) {
    assert.equal(affirmativeFileAnswer(answer, 'nonce'), false)
  }
})

test('process-local offered profiles preserve restricted base and never mutate shared config/env', t => {
  const { root, file } = fixture(t)
  const env = { CODEX_HOME: join(root, 'codex'), CODEX_PATH: join(root, 'bin', 'codex'), CODEX_CONFIG: JSON.stringify({ features: { image_generation: true }, developer_instructions: 'existing' }) }
  const configFile = join(env.CODEX_HOME, 'config.toml'); writeFileSync(configFile, 'unchanged')
  const before = structuredClone(env)
  const profileModes = chatProfileModesFor('0123456789abcdef0123456789abcdef')
  const mapping = structuredClone(profileModes)
  for (const sandbox of ['read-only', 'workspace-write']) {
    const result = sessionFileConfig(env, { sandbox, files: [fileIdentity(file)] }, profileModes)
    const config = JSON.parse(result.env.CODEX_CONFIG)
    assert.equal(config.features.request_permissions_tool, true); assert.equal(config.features.image_generation, true)
    const profile = config.permissions[result.sessionFileMode.replace('permission-profile:', '')]
    assert.equal(profile.filesystem[':root'], 'deny'); assert.equal(profile.filesystem[':minimal'], 'read')
    assert.equal(profile.filesystem[file], 'read'); assert.equal(profile.filesystem[join(root, 'outside')], undefined)
    assert.equal(profile.filesystem[':workspace_roots'], sandbox === 'read-only' ? 'read' : 'write')
    assert.equal(profile.filesystem[':tmpdir'], sandbox === 'read-only' ? undefined : 'write')
    assert.equal(result.sessionFileMode, profileModes[sandbox])
    assert.deepEqual(profile.filesystem, { ...restrictedChatGrants(env.CODEX_HOME, sandbox === 'read-only' ? 'read' : 'write', join(root, 'bin')), [file]: 'read' })
    assert.deepEqual(Object.keys(config.permissions), [result.sessionFileMode.slice('permission-profile:'.length)])
    assert.match(config.developer_instructions, /^existing/)
  }
  assert.equal(sessionFileConfig(env, { sandbox: 'read-only' }).sessionFileMode, undefined)
  assert.deepEqual(profileModes, mapping)
  for (const modes of [undefined, {}, { 'read-only': 'read-only' }, { 'read-only': profileModes['workspace-write'] }, { 'read-only': 'permission-profile:arbitrary' }, { 'read-only': 'permission-profile:automagik-read-guessed' }]) {
    assert.throws(() => sessionFileConfig(env, { sandbox: 'read-only', files: [fileIdentity(file)] }, modes), /managed image profile/)
  }
  assert.deepEqual(env, before); assert.equal(readFileSync(configFile, 'utf8'), 'unchanged')
})

function world(t, { level = { sandbox: 'read-only', policy: 'ask', full: false, auto: false }, answer, drainMs = 80 } = {}) {
  const data = fixture(t)
  const session = { id: 'chat', header: {}, snapshotEvents: () => [] }
  const agent = { session }
  const run = new AgentRun({ name: 'Codex', cwd: join(data.root, 'ws') })
  t.after(() => run.dispose())
  run.stop = async () => { run.dispose() }
  const live = { run, name: 'Codex', provider: 'acp-codex', dshAgent: agent, open: true, own: false, sessionFileEnabled: true, fileSandbox: 'read-only', calls: new Set(['mirror-1']), toolIds: new Map([['mirror-1', 'native-1']]) }
  let current = live
  const requests = []
  let reply
  const files = new SessionFiles({ agent: () => agent, live: () => current, level: () => level,
    questions: () => ({ ask: request => { requests.push(request); return answer ? answer(request) : new Promise(resolve => { reply = resolve }) } }),
    retire: () => { current = undefined; live.open = false; run.dispose() }, drainMs })
  live.fileOwner = files.owner(agent, 'acp-codex')
  const controller = new AbortController()
  const withdrawn = new AbortController()
  const permissionReply = run.onPermission({ toolCall: { ...data.call, name: data.call.structuredName, toolCallId: data.call.id }, options: [{ optionId: 'allow', kind: 'allow_once' }] }, withdrawn.signal)
  const tool = run.tools.get(data.call.id)
  const exec = { callId: 'mirror-1', agent, signal: controller.signal }
  let generic = 0
  const mirror = mirrorTool({ runOf: () => live, sessionFiles: (...args) => files.ask(...args), approval: () => ({ effectivePolicy: () => 'ask', request: async () => { generic++; return 'allowed-once' } }) })
  reviewed.set(exec, { policy: 'ask', sandbox: 'read-only' })
  return { ...data, files, live, run, tool, exec, requests, controller, withdrawn, permissionReply, level,
    execute: () => mirror.execute(callArguments(tool), exec), reply: value => reply(value), generic: () => generic }
}

test('standing/global tool approvals and reviewed outcomes cannot grant: native cancellation, staged consent, next user only', async t => {
  const w = world(t)
  const body = w.execute(); await tick()
  assert.equal(w.generic(), 0); assert.equal(w.files.owners.get('chat').grant, undefined)
  const request = w.requests[0], q = request.questions[0]
  assert.equal(request.agent, w.exec.agent); assert.match(q.id, /^acp-session-file:/)
  assert.equal(q.question, q.detail); assert.ok(q.question.includes(w.file)); assert.match(q.question, /chat session/)
  assert.deepEqual(q.intent, { kind: 'approval', approve: FILE_ALLOW, reject: 'Reject' })
  assert.equal(q.multiSelect, undefined); assert.equal(request.wait, undefined)
  w.reply(yes(q.id)); assert.match((await body).text, /Send a new message/)
  assert.deepEqual(await w.permissionReply, CANCELLED)
  const owner = w.live.fileOwner
  assert.equal(owner.grant.staged, true); await owner.grant.ready
  for (const message of [{ role: 'tool' }, { role: 'user', source: { kind: 'retry' } }, { role: 'user', source: { kind: 'acp-notice' } }]) {
    await assert.rejects(w.files.activate(owner, message), /new message/)
  }
  assert.deepEqual((await w.files.activate(owner, { role: 'user', source: { kind: 'user' } })).map(x => x.canonical), [w.file])
  assert.equal(w.generic(), 0)
})

for (const reason of ['reject', 'stop', 'withdraw', 'supersede', 'level', 'changed-file', 'malformed']) test(`${reason}: late affirmative grants nothing`, async t => {
  const w = world(t)
  const body = w.execute(); await tick()
  const id = w.requests[0].questions[0].id
  if (reason === 'stop') w.controller.abort()
  if (reason === 'withdraw') w.withdrawn.abort()
  if (reason === 'level') w.files.clear('chat')
  if (reason === 'changed-file') { unlinkSync(w.file); symlinkSync(w.sibling, w.file) }
  if (reason === 'supersede') {
    const second = w.run.onPermission({ toolCall: { toolCallId: 'native-1', title: 'another question' }, options: [] })
    t.after(() => w.run.tools.get('native-1').permission?.answer(CANCELLED)); second.catch(() => {})
  }
  w.reply(reason === 'reject' ? { answers: [{ id, selected: ['Reject'] }] } : reason === 'malformed' ? { ...yes(id), extra: true } : yes(id))
  assert.match((await body).text, /not approved/); assert.deepEqual(await w.permissionReply, CANCELLED)
  assert.equal(w.files.owners.get('chat')?.grant, undefined); assert.equal(w.generic(), 0)
})

test('Auto cannot enter the consent transaction even with the feature flag', async t => {
  const w = world(t, { level: { sandbox: 'danger-full-access', policy: 'ask', full: false, auto: true } })
  assert.match((await w.execute()).text, /not approved/)
  assert.equal(w.requests.length, 0); assert.equal(w.generic(), 0)
})

test('two live chat objects never inherit the same filename grant', async t => {
  const w = world(t, { answer: request => yes(request.questions[0].id) })
  await w.execute(); await w.live.fileOwner.grant.ready
  const other = { session: { id: 'other' } }
  assert.equal(w.files.owner(other, 'acp-codex').grant, undefined)
  const reopened = { session: { id: 'chat' } }
  assert.equal(w.files.owner(reopened, 'acp-codex').grant, undefined)
  assert.equal(w.live.fileOwner.lifetime.signal.aborted, true)
})

test('drain requires process success AND finished bridge/mirror bodies and rows; cancellation and deadlines fail closed', async () => {
  const signal = new AbortController()
  await assert.rejects(drainFileSession({ run: { stop: async () => { throw new Error('child alive') } } }, signal.signal, 30), /child alive/)
  await assert.rejects(drainFileSession({ run: { stop: () => new Promise(() => {}) } }, signal.signal, 30), /cancelled|drain/)
  for (const more of [{ bridge: { calls: 1 } }, { mirrorBodies: 1 }, { pendingMirrors: new Set(['row']) }]) {
    await assert.rejects(drainFileSession({ run: { stop: async () => {} }, ...more }, signal.signal, 30), /cancelled|drain/)
  }
  const live = { run: { stop: async () => {} }, bridge: { calls: 1 }, pendingMirrors: new Set(['row']) }
  const wait = drainFileSession(live, signal.signal, 200)
  live.bridge.calls = 0; live.pendingMirrors.clear(); await wait
  signal.abort(); await assert.rejects(drainFileSession(live, signal.signal, 30), /abort|cancel/i)
})

for (const failure of ['missing-service', 'rejected-service', 'retire', 'native-answer']) test(`${failure}: consent failure leaves no staged authority`, async t => {
  const w = world(t, { answer: request => yes(request.questions[0].id) })
  if (failure === 'missing-service') w.files.host.questions = () => undefined
  if (failure === 'rejected-service') w.files.host.questions = () => ({ ask: async () => { throw new Error('withdrawn') } })
  if (failure === 'retire') w.files.host.retire = () => { throw new Error('retire failed') }
  if (failure === 'native-answer') {
    const permission = w.tool.permission, original = permission.answer
    permission.answer = response => { permission.answer = original; original(response); throw new Error('answer failed') }
  }
  const result = await w.execute()
  assert.match(result.text, /not approved/)
  assert.equal(w.files.owners.get('chat')?.grant, undefined)
  if (['retire', 'native-answer'].includes(failure)) assert.equal(w.run.disposed, true)
})

test('withdrawal immediately revokes the owner; a late answer cannot clear a replacement owner', async t => {
  const w = world(t)
  const body = w.execute(); await tick()
  const id = w.requests[0].questions[0].id
  w.withdrawn.abort()
  assert.equal(w.files.owners.size, 0)
  const replacement = w.files.owner(w.exec.agent, 'acp-codex')
  w.reply(yes(id)); await body
  assert.equal(w.files.owners.get('chat'), replacement)
  assert.equal(replacement.grant, undefined)
})

for (const failure of ['stop-rejected', 'stop-pending', 'bridge', 'mirror', 'row', 'abort']) test(`${failure}: staged activation fails without file authority`, async t => {
  const w = world(t, { answer: request => yes(request.questions[0].id), drainMs: 30 })
  if (failure === 'stop-rejected') w.run.stop = async () => { throw new Error('stop failed') }
  if (failure === 'stop-pending') w.run.stop = () => new Promise(() => {})
  if (['bridge', 'abort'].includes(failure)) w.live.bridge = { calls: 1 }
  if (failure === 'mirror') w.live.mirrorBodies = 1
  if (failure === 'row') w.live.pendingMirrors = new Set(['other-row'])
  const owner = w.live.fileOwner
  await w.execute()
  const ready = owner.grant.ready
  if (failure === 'abort') w.controller.abort()
  await assert.rejects(ready)
  await assert.rejects(w.files.activate(owner, { role: 'user', source: { kind: 'user' } }))
  assert.equal(owner.grant, undefined)
})
