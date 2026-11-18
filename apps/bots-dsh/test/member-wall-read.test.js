// The member wall's read fence, through DSH's real tools on a real cordis context: read,
// read_image, grep, glob and skill. A member is refused on an owner-only path and allowed in
// its own area; the owner, and every session while members are off, are unchanged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFs from '@deepseek-ai/dsh-skill-filesystem'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'
import { sessionScope } from '../src/host/member-wall/principals.js'

const CANARY = 'OWNER-ONLY canary 7f3a'
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'member-wall-'))
  const owner = join(root, 'owner')
  const members = join(root, 'members')
  const ana = join(members, 'ana')
  const shared = join(root, 'shared')
  const dshHome = join(root, 'dsh-home')
  for (const dir of [owner, ana, join(members, 'bo'), shared, dshHome]) mkdirSync(dir, { recursive: true })
  const skill = (dir, name) => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${name === 'owner-notes' ? CANARY : 'ana body'}\n`)
  }
  writeFileSync(join(owner, 'secret.txt'), `${CANARY}\n`)
  writeFileSync(join(owner, 'secret.png'), PNG)
  skill(join(owner, 'skills'), 'owner-notes')
  writeFileSync(join(ana, 'notes.txt'), 'ana canary\n')
  writeFileSync(join(ana, 'pic.png'), PNG)
  skill(join(ana, 'skills'), 'ana-notes')
  writeFileSync(join(members, 'bo', 'bo.txt'), 'bo canary\n')
  mkdirSync(join(members, 'anabel'))
  writeFileSync(join(members, 'anabel', 'anabel.txt'), `${CANARY}\n`)
  writeFileSync(join(shared, 'team.txt'), 'shared canary\n')
  mkdirSync(join(shared, 'held'))
  writeFileSync(join(shared, 'held', 'held.txt'), `${CANARY}\n`)
  symlinkSync(join(owner, 'secret.txt'), join(ana, 'link.txt'))
  symlinkSync(owner, join(ana, 'owner-dir'))
  const principals = join(root, 'principals.json')
  const record = (sessions, mode = 0o600) => {
    writeFileSync(principals, JSON.stringify({ version: 1, sessions }))
    chmodSync(principals, mode)
  }
  record({ 'session-owner': 'owner', 'session-ana': 'member:ana' })
  return { root, owner, members, ana, shared, dshHome, principals, record }
}

async function world(t, places, { members = true, skillTool = true, cwd = places.ana } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: places.ana, additionalWritableRoots: [] }),
  })
  provideWorkingDirectoryFixture(ctx, places.ana)
  await ctx.plugin(MemberWallFileSystem, {
    cwd,
    members,
    principalsFile: places.principals,
    membersRoot: places.members,
    sharedReadRoots: [places.shared],
    denyReadRoots: [places.dshHome, join(places.shared, 'held')],
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(skillFs, {
    includeDefaultRoots: false, dshHome: places.dshHome, agentsHome: places.dshHome, watch: false,
    customSkillDirs: [join(places.owner, 'skills'), join(places.ana, 'skills')],
  })
  ctx.provide('agents', { list: () => [], get: () => undefined })
  // Stand-ins for the image path: a route that takes images and an attachment store.
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  ctx.provide('attachments', {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 20 },
    saveImage: async ({ data, mediaType }) => ({ attachmentId: 'a1', mediaType, bytes: data.length, width: 1, height: 1 }),
  })
  await ctx.plugin(toolFs, {})
  await ctx.plugin(toolSearch, { sampleOverCapGlobResults: false })
  if (skillTool) await ctx.plugin(toolSkill, {})
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const name of ['fs', 'tools', 'skills', 'subprocess']) assert.ok(ctx.get(name), `${name} is mounted`)
  return ctx
}

// The shape of a dsh-agent Agent: its id is its session's id.
const agentFor = (sessionId, cwd) => ({
  id: sessionId,
  options: { provider: 'test', model: 'test' },
  session: { id: sessionId, header: { cwd }, requestHeader: () => undefined },
})

async function call(ctx, sessionId, cwd, name, args) {
  const agent = agentFor(sessionId, cwd)
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal })
  try {
    const batch = await ctx.tools.execute({ calls: [{ id: 'c1', name, arguments: args }], agent, signal, toolSet })
    const { result } = batch.results[0]
    return { error: result.isError === true, text: JSON.stringify(result) }
  } finally {
    toolSet.dispose?.()
  }
}

// Refused by the wall itself, not by some other failure on the way: to a member a path out of
// its reach looks absent (the same path reads for the owner, so it is there), a search over it
// is refused, and a skill out of its reach is not listed for it, so it reads as unknown.
const refused = (out, label, wall = /not found|outside the files this member may search/) => {
  assert.equal(out.error, true, `${label}: refused`)
  assert.match(out.text, wall, `${label}: by the wall (${out.text.slice(0, 300)})`)
  assert.doesNotMatch(out.text, /7f3a/, `${label}: no owner content`)
}
const allowed = (out, label, pattern) => {
  assert.equal(out.error, false, `${label}: allowed (${out.text.slice(0, 300)})`)
  if (pattern) assert.match(out.text, pattern, label)
}

// Every read path: [tool, owner-only arguments, member-area arguments, what the member area shows].
const paths = places => [
  ['read', { file_path: join(places.owner, 'secret.txt') }, { file_path: join(places.ana, 'notes.txt') }, /ana canary/],
  ['read_image', { file_path: join(places.owner, 'secret.png') }, { file_path: join(places.ana, 'pic.png') }, /image/],
  ['grep', { pattern: 'canary', path: places.owner }, { pattern: 'canary', path: places.ana }, /ana canary/],
  ['glob', { pattern: '*.txt', path: places.owner }, { pattern: '*.txt', path: places.ana }, /notes\.txt/],
  ['skill', { name: 'owner-notes' }, { name: 'ana-notes' }, /ana body/],
]

test('a member is refused each read path on an owner-only path and allowed in its own area', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  for (const [tool, owner, own, shows] of paths(places)) {
    const wall = tool === 'skill' ? /owner-notes.{0,3} is unknown/ : undefined
    refused(await call(ctx, 'session-ana', places.ana, tool, owner), `member ${tool} on the owner's path`, wall)
    allowed(await call(ctx, 'session-ana', places.ana, tool, own), `member ${tool} in its own area`, shows)
  }
})

test("the owner's skills are left out of a member's skill list, and only there", async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  // DSH keys its skill list by the asking agent, as the skill tool and the catalog do.
  const agents = new Map()
  const names = sessionId => sessionScope.run({ sessionId }, async () => {
    if (!agents.has(sessionId)) agents.set(sessionId, agentFor(sessionId, places.ana))
    return (await ctx.skills.list({ scope: agents.get(sessionId) })).map(skill => skill.name).sort()
  })
  // The owner lists first, so the files are already known when the member asks.
  assert.deepEqual(await names('session-owner'), ['ana-notes', 'owner-notes'])
  assert.deepEqual(await names('session-ana'), ['ana-notes'])
  assert.deepEqual(await names('session-owner'), ['ana-notes', 'owner-notes'])
  const body = sessionId => sessionScope.run({ sessionId }, async () => (await ctx.skills.get('owner-notes', { scope: agents.get(sessionId) }))?.content)
  assert.equal(await body('session-ana'), undefined)
  assert.match(await body('session-owner'), /7f3a/)
})

test('the owner is unchanged: each read path reaches the owner-only path', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  for (const [tool, owner] of paths(places)) {
    allowed(await call(ctx, 'session-owner', places.owner, tool, owner), `owner ${tool}`, tool === 'read_image' || tool === 'glob' ? undefined : /7f3a/)
  }
  allowed(await call(ctx, 'session-owner', places.owner, 'read', { file_path: join(places.dshHome, '..', 'owner', 'secret.txt') }), 'owner read', /7f3a/)
})

test('with members off, every session reads as before', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places, { members: false })
  allowed(await call(ctx, 'session-ana', places.ana, 'read', { file_path: join(places.owner, 'secret.txt') }), 'off: read', /7f3a/)
  allowed(await call(ctx, 'session-ana', places.ana, 'grep', { pattern: 'canary', path: places.owner }), 'off: grep', /7f3a/)
})

test('a member reaches the shared roots, but not another member, a denied root, or out through a link', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  writeFileSync(join(places.dshHome, 'launch-token'), `${CANARY}\n`)
  const ctx = await world(t, places)
  const ana = (tool, args) => call(ctx, 'session-ana', places.ana, tool, args)
  allowed(await ana('read', { file_path: join(places.shared, 'team.txt') }), 'shared read', /shared canary/)
  allowed(await ana('grep', { pattern: 'shared canary', path: join(places.shared, 'team.txt') }), 'shared grep', /shared canary/)
  // The shared root holds a denied folder, so a search over all of it is refused.
  refused(await ana('grep', { pattern: 'canary', path: places.shared }), 'grep over a shared root holding a denied one')
  refused(await ana('glob', { pattern: '*.txt', path: places.shared }), 'glob over a shared root holding a denied one')
  allowed(await ana('read', { file_path: join(places.shared, 'team.txt') }), 'shared read beside a denied root', /shared canary/)
  refused(await ana('read', { file_path: join(places.members, 'bo', 'bo.txt') }), "another member's file")
  refused(await ana('grep', { pattern: 'canary', path: join(places.members, 'bo') }), "grep over another member's area")
  refused(await ana('read', { file_path: join(places.dshHome, 'launch-token') }), 'a denied root')
  refused(await ana('read', { file_path: join(places.shared, 'held', 'held.txt') }), 'a denied root inside a shared one')
  refused(await ana('grep', { pattern: 'canary', path: join(places.shared, 'held') }), 'grep in a denied root inside a shared one')
  refused(await ana('read', { file_path: join(places.ana, 'link.txt') }), 'a link to an owner file')
  refused(await ana('read', { file_path: 'link.txt' }), 'a relative link to an owner file')
  refused(await ana('read', { file_path: join(places.ana, 'owner-dir', 'secret.txt') }), 'through a linked folder')
  refused(await ana('grep', { pattern: 'canary', path: join(places.ana, 'owner-dir') }), 'grep rooted at a linked folder')
  refused(await ana('read', { file_path: join(places.ana, '..', '..', 'owner', 'secret.txt') }), 'a dot-dot path')
  refused(await ana('grep', { pattern: 'canary', path: '../..' }), 'grep up and out')
  // A search over the member's own area does not follow its links out.
  const own = await ana('grep', { pattern: 'canary', path: places.ana })
  allowed(own, 'grep over its own area')
  assert.doesNotMatch(own.text, /7f3a/)
})

test('a listing withholds every child whose resolved target is denied, and only those', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  // Children of the member's own folder that leave it: absolute, relative, through `..`, and
  // through a denied folder that itself links back into an allowed one.
  writeFileSync(join(places.dshHome, 'launch-token'), `${CANARY}\n`)
  symlinkSync('../../dsh-home/launch-token', join(places.ana, 'rel-token'))
  symlinkSync('../../shared/held/held.txt', join(places.ana, 'held-link'))
  symlinkSync('../../owner', join(places.ana, 'escape'))
  symlinkSync('../../dsh-home/door', join(places.ana, 'door'))
  symlinkSync('../shared/team.txt', join(places.dshHome, 'door'))
  const ctx = await world(t, places)
  const folder = await ctx.fs.resolve(places.ana)
  const listing = await sessionScope.run({ sessionId: 'session-ana' }, () => ctx.fs.listDir(folder))
  const names = listing.map(entry => entry.name)
  assert.deepEqual(names, ['door', 'notes.txt', 'pic.png', 'skills'])
  const text = JSON.stringify(listing)
  for (const hidden of ['link.txt', 'owner-dir', 'rel-token', 'held-link', 'escape']) {
    assert.ok(!names.includes(hidden), `${hidden}: withheld`)
    assert.ok(!text.includes(hidden), `${hidden}: no name in the listing`)
  }
  // An allowed child is reported as before: its type, size, version and resolved target.
  const notes = listing.find(entry => entry.name === 'notes.txt')
  assert.equal(notes.type, 'file')
  assert.equal(notes.size, 11)
  assert.ok(notes.version)
  assert.deepEqual(notes.target, {
    targetKey: realpathSync(join(places.ana, 'notes.txt')),
    displayPath: join(places.ana, 'notes.txt'),
  })
  // The decision is on the resolved target: a child of an allowed folder that reaches an allowed
  // file through a denied folder is still reported, with that file's metadata.
  const door = listing.find(entry => entry.name === 'door')
  assert.equal(door.type, 'file')
  assert.equal(door.size, 14)
  assert.equal(door.target.targetKey, realpathSync(join(places.shared, 'team.txt')))
  // With members off the same listing is the whole folder, as DSH gives it.
  const whole = ['door', 'escape', 'held-link', 'link.txt', 'notes.txt', 'owner-dir', 'pic.png', 'rel-token', 'skills']
  const off = await world(t, places, { members: false })
  const all = await sessionScope.run({ sessionId: 'session-ana' }, async () => off.fs.listDir(await off.fs.resolve(places.ana)))
  assert.deepEqual(all.map(entry => entry.name), whole)
  assert.equal(all.find(entry => entry.name === 'link.txt').target.targetKey, realpathSync(join(places.owner, 'secret.txt')))
  // The owner's listing under the same fence is unchanged: the wall only ever narrows a member.
  const owner = await sessionScope.run({ sessionId: 'session-owner' }, () => ctx.fs.listDir(folder))
  assert.deepEqual(owner.map(entry => entry.name), whole)
})

test('an unknown session, an open record and a missing record all fall to member', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  const ownerRead = id => call(ctx, id, places.owner, 'read', { file_path: join(places.owner, 'secret.txt') })
  refused(await ownerRead('session-fork'), 'an unrecorded session')
  places.record({ 'session-owner': 'owner', 'session-ana': 'member:ana' }, 0o644)
  refused(await ownerRead('session-owner'), 'the owner, while the record is open to others')
  rmSync(places.principals)
  refused(await ownerRead('session-owner'), 'the owner, while the record is missing')
  places.record({ 'session-owner': 'owner', 'session-x': 'member:../owner' })
  refused(await call(ctx, 'session-x', places.owner, 'read', { file_path: join(places.owner, 'secret.txt') }), 'a member name that is not a slug')
  allowed(await ownerRead('session-owner'), 'the owner, once recorded again', /7f3a/)
})

test("work outside any session (the owner's own interface) reads as before", async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  const target = await ctx.fs.resolve(join(places.owner, 'secret.txt'))
  assert.match(await ctx.fs.readText(target), /7f3a/)
  const folder = await ctx.fs.resolve(places.owner)
  // A target resolved outside the session is still checked on every use inside it.
  await sessionScope.run({ sessionId: 'session-ana' }, async () => {
    const absent = { code: 'FS_NOT_FOUND', message: /not found/ }
    const denied = { code: 'FS_SANDBOX_DENIED', message: /outside the files this member may use/ }
    // Probes find nothing, the same as for a path that does not exist.
    assert.equal(await ctx.fs.lstat(join(places.owner, 'secret.txt')), undefined)
    assert.equal(await ctx.fs.lstat(join(places.ana, 'link.txt')), undefined)
    assert.equal(await ctx.fs.stat(target), undefined)
    assert.equal(await ctx.fs.stat(await ctx.fs.resolve(join(places.ana, 'link.txt'))), undefined)
    assert.ok(await ctx.fs.stat(await ctx.fs.resolve(join(places.ana, 'notes.txt'))), 'its own file is there')
    await assert.rejects(async () => ctx.fs.readText(target), absent)
    await assert.rejects(async () => ctx.fs.streamText(target), absent)
    await assert.rejects(async () => ctx.fs.readBytes(target, undefined, 1024), absent)
    await assert.rejects(async () => ctx.fs.readByteRange(target, { start: 0, end: 4 }), absent)
    await assert.rejects(async () => ctx.fs.listDir(folder), absent)
    await assert.rejects(async () => ctx.fs.watch(folder, () => {}, new AbortController().signal), absent)
    await assert.rejects(async () => ctx.fs.writeText(target, 'x'), denied)
    // Full access skips DSH's own write check; the wall still holds.
    await assert.rejects(async () => ctx.fs.writeText(target, 'x', undefined, undefined, { mode: 'danger-full-access' }), denied)
    await assert.rejects(async () => ctx.fs.deleteFile(target), denied)
  })
})

test("an agent step runs in its session's scope, so a member's skill catalog is fenced too", async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  // The skill tool's own step listeners need a whole agent; the scope is what is under test.
  const ctx = await world(t, places, { skillTool: false })
  const step = sessionId => ctx.waterfall('agent/pre-step', {
    agent: agentFor(sessionId, places.ana), messages: [], signal: new AbortController().signal,
  }, async () => {
    try {
      return { kind: 'read', text: await ctx.fs.readText(await ctx.fs.resolve(join(places.owner, 'secret.txt'))) }
    } catch (error) {
      return { kind: 'refused', code: error.code }
    }
  })
  assert.deepEqual(await step('session-ana'), { kind: 'refused', code: 'FS_NOT_FOUND' })
  assert.equal((await step('session-owner')).kind, 'read')
})

test("DSH's reads for a session after a tool's result or at a step's end are fenced too", async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  // Resolved outside any session, as DSH's instruction files are found.
  const target = await ctx.fs.resolve(join(places.owner, 'secret.txt'))
  const reads = []
  const readLater = () => reads.push(ctx.fs.readText(target).then(() => 'read', error => error.code))
  ctx.on('tools/result', readLater)
  ctx.on('session/event', (_session, event) => { if (event.type === 'step/end') readLater() })
  // Each emit runs in a scope of its own, as DSH's tool pipeline and agent loop do.
  const signal = new AbortController().signal
  sessionScope.run(undefined, () => ctx.emit('tools/result', { agent: agentFor('session-ana', places.ana), signal }, { isError: false }))
  sessionScope.run(undefined, () => ctx.emit('session/event', { id: 'session-ana' }, { type: 'step/end' }))
  sessionScope.run(undefined, () => ctx.emit('tools/result', { agent: agentFor('session-owner', places.owner), signal }, { isError: false }))
  sessionScope.run(undefined, () => ctx.emit('session/event', { id: 'session-owner' }, { type: 'step/end' }))
  assert.deepEqual(await Promise.all(reads), ['FS_NOT_FOUND', 'FS_NOT_FOUND', 'read', 'read'])
})

test('a record owned by another user counts for nothing', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  const uid = process.getuid()
  t.mock.method(process, 'getuid', () => uid + 1)
  refused(await call(ctx, 'session-owner', places.owner, 'read', { file_path: join(places.owner, 'secret.txt') }), 'the owner, while the record is not ours')
})

test("grep and glob search from the session's own working folder, not the configured one", async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  // The deployment folder is the owner's; the member's session works in its own area.
  const ctx = await world(t, places, { cwd: places.owner })
  allowed(await call(ctx, 'session-ana', places.ana, 'grep', { pattern: 'canary' }), 'grep, no path', /ana canary/)
  allowed(await call(ctx, 'session-ana', places.ana, 'grep', { pattern: 'canary', path: '.' }), 'grep .', /ana canary/)
  allowed(await call(ctx, 'session-ana', places.ana, 'glob', { pattern: '*.txt' }), 'glob, no path', /notes\.txt/)
})

test('a member whose name starts like another reaches only its own area (ana, not anabel)', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  refused(await call(ctx, 'session-ana', places.ana, 'read', { file_path: join(places.members, 'anabel', 'anabel.txt') }), 'read anabel')
  refused(await call(ctx, 'session-ana', places.ana, 'grep', { pattern: 'canary', path: join(places.members, 'anabel') }), 'grep anabel')
})

test('a folder link followed by .. is decided where it really lands', async t => {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  const ctx = await world(t, places)
  const ana = (tool, args) => call(ctx, 'session-ana', places.ana, tool, args)
  // owner-dir is a link to the owner folder: owner-dir/.. is the owner folder's parent on disk.
  // Spelled by hand: path.join would fold the .. away before DSH ever sees it.
  const out = `${places.ana}/owner-dir/../owner`
  refused(await ana('grep', { pattern: 'canary', path: out }), 'grep through a link and ..')
  refused(await ana('glob', { pattern: '*.txt', path: out }), 'glob through a link and ..')
  refused(await ana('read', { file_path: `${out}/secret.txt` }), 'read through a link and ..')
  await sessionScope.run({ sessionId: 'session-ana' }, async () => {
    assert.equal(await ctx.fs.lstat(`${out}/secret.txt`), undefined, 'lstat through a link and ..')
  })
})

// One session's event inside another session's work (the shapes of the review, E1 to E6): the
// work keeps every session it acted for, so it is held to all their rules and never widened.
async function crossWorld(t) {
  const places = layout(); t.after(() => rmSync(places.root, { recursive: true, force: true }))
  places.record({ 'session-owner': 'owner', 'session-ana': 'member:ana', 'session-bo': 'member:bo' })
  const ctx = await world(t, places)
  const signal = new AbortController().signal
  const files = {
    owner: join(places.owner, 'secret.txt'), ana: join(places.ana, 'notes.txt'),
    bo: join(places.members, 'bo', 'bo.txt'), shared: join(places.shared, 'team.txt'),
  }
  // What the current work may read: 'read', or the error it gets.
  const reads = async () => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([who, path]) => {
    const target = await ctx.fs.resolve(path)
    return [who, await ctx.fs.readText(target).then(() => 'read', error => error.code)]
  })))
  const result = id => ctx.emit('tools/result', { agent: agentFor(id, places.ana), signal }, { isError: false })
  const stepEnd = id => ctx.emit('session/event', { id }, { type: 'step/end' })
  const as = (id, work) => sessionScope.run({ sessionId: id }, work)
  return { ctx, places, reads, result, stepEnd, as }
}

const HIDDEN = 'FS_NOT_FOUND'
const tick = () => new Promise(resolve => setImmediate(resolve))

test("E1: an owner's event inside a member's work never makes that work the owner's", async t => {
  const { reads, result, stepEnd, as } = await crossWorld(t)
  const member = { owner: HIDDEN, ana: 'read', bo: HIDDEN, shared: 'read' }
  assert.deepEqual(await as('session-ana', () => { result('session-owner'); return reads() }), member, 'after a tool result')
  assert.deepEqual(await as('session-ana', () => { stepEnd('session-owner'); return reads() }), member, "after a step's end")
  // E1c: still so after further awaits.
  assert.deepEqual(await as('session-ana', async () => {
    result('session-owner'); await tick(); await null; stepEnd('session-owner'); await tick()
    return reads()
  }), member, 'after further awaits')
})

test('E2: a member\'s event inside the owner\'s work holds that work to the member\'s rules too', async t => {
  // Entering nothing here would read the member's instruction files as the owner's.
  const { reads, result, stepEnd, as } = await crossWorld(t)
  const both = { owner: HIDDEN, ana: 'read', bo: HIDDEN, shared: 'read' }
  assert.deepEqual(await as('session-owner', () => { result('session-ana'); return reads() }), both, 'after a tool result')
  assert.deepEqual(await as('session-owner', () => { stepEnd('session-ana'); return reads() }), both, "after a step's end")
})

test("E3: an event in the synchronous start of an awaited helper never widens the caller", async t => {
  const { reads, result, stepEnd, as } = await crossWorld(t)
  const helper = async emit => { emit('session-owner'); await null }
  const member = { owner: HIDDEN, ana: 'read', bo: HIDDEN, shared: 'read' }
  assert.deepEqual(await as('session-ana', async () => { await helper(result); return reads() }), member, 'tool result')
  assert.deepEqual(await as('session-ana', async () => { await helper(stepEnd); await tick(); return reads() }), member, "step's end")
})

test("E4: another member's event inside a member's work reaches neither member's area", async t => {
  const { reads, result, as } = await crossWorld(t)
  assert.deepEqual(await as('session-ana', () => { result('session-bo'); return reads() }),
    { owner: HIDDEN, ana: HIDDEN, bo: HIDDEN, shared: 'read' })
})

test("E5: an event outside any session acts for its session; a session's own event changes nothing", async t => {
  const { reads, result, as } = await crossWorld(t)
  assert.deepEqual(await sessionScope.run(undefined, () => { result('session-ana'); return reads() }),
    { owner: HIDDEN, ana: 'read', bo: HIDDEN, shared: 'read' }, 'outside any session')
  assert.deepEqual(await as('session-owner', () => { result('session-owner'); return reads() }),
    { owner: 'read', ana: 'read', bo: 'read', shared: 'read' }, "the owner's own event")
})

test("E6: an owner's tool call inside a member's work reads as the member", async t => {
  const { ctx, places, as } = await crossWorld(t)
  refused(await as('session-ana', () => call(ctx, 'session-owner', places.owner, 'read', { file_path: join(places.owner, 'secret.txt') })), 'read')
  refused(await as('session-ana', () => call(ctx, 'session-owner', places.owner, 'grep', { pattern: 'canary', path: places.owner })), 'grep')
})
