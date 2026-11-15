// The member wall's read fence, through DSH's real tools on a real cordis context: read,
// read_image, grep, glob and skill. A member is refused on an owner-only path and allowed in
// its own area; the owner, and every session while members are off, are unchanged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionScope } from '../src/host/member-wall/principals.js'
import { CANARY, agentFor, allowed, call, layout, refused, world } from './member-wall-world.js'

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
