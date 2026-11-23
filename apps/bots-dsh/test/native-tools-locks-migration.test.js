// #1564 follow-up (RFC 0003, Amendment: native tools in every chat of the Bot): the one-time
// upgrade that turns off, once, the switch of every Bot that sat in a lock this change removes.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, NATIVE_TOOLS_BLOCK_TEXT } from '../src/host/native-tools.js'

const CLAUDE = 'acp-claude/default'
const on = (id, fields = {}) =>
  ({ id, model: CLAUDE, nativeTools: true, nativeToolsAgent: 'acp-claude', ...fields })
const notFound = () =>
  Object.assign(new Error('No stored Session'), { name: 'SessionPersistenceNotFoundError' })

// A counting registry: `reads` is how many times the runtimes were listed.
function registryOf(fibers) {
  const registry = { reads: 0, fail: false, values() {
    registry.reads += 1
    if (registry.fail) throw new Error('registry unavailable')
    return fibers === undefined ? [] : [{ name: 'liveshare-share-host', fibers }]
  } }
  return registry
}

function host(t, options) {
  const { bots, registry = registryOf(), loaded = true, holds = true, canWrite = false } = options
  const { state = {}, omniFile = false } = options
  const home = mkdtempSync(join(tmpdir(), 'native-locks-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  if (omniFile) writeFileSync(join(home, 'omni.json'), '{}')
  const saves = []
  const warns = []
  const rt = {
    home,
    state: { bots: Object.fromEntries(bots.map(bot => [bot.id, bot])), ...state },
    ctx: {
      registry,
      get: name => ({
        sandboxPolicy: {
          defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }),
        },
        sessionPersistence: { open: async () => { throw notFound() } },
      })[name],
      sessions: { get: () => undefined },
    },
    chatOwners: new Map(bots.map(bot => ['chat-' + bot.id, bot.id])),
    groupOwners: new Map(),
    pastOwners: new Map(),
    taskOwners: new Map(),
    botOf: id => rt.state.bots[id],
    chatOf: id => 'chat-' + id,
    selfOf: id => rt.chatOwners.get(id),
    isMain: id => id === 'main',
    teamLoaded: () => loaded,
    holdsLock: () => holds,
    canWriteTeam: () => canWrite,
    // As store.js: an ON is written into the saved copy before memory flips it.
    save: async (options = {}) => {
      const snapshot = structuredClone(rt.state)
      if (options.enableNativeTools !== undefined) {
        Object.assign(snapshot.bots[options.enableNativeTools.id],
          { nativeTools: true, nativeToolsAgent: options.nativeToolsAgent })
      }
      saves.push(snapshot)
    },
    warn: (...args) => { warns.push(args) },
  }
  install(rt)
  const reload = (snapshot, options = {}) => {
    const { bots: saved, ...rest } = structuredClone(snapshot)
    return host(t, { bots: Object.values(saved), state: rest, registry, ...options })
  }
  return { rt, saves, warns, registry, reload }
}

const fieldsOf = bot => [bot.nativeTools, bot.nativeToolsAgent, bot.nativeToolsKept]

test('(a) each removed lock: an ON Bot gets false once, with the marker, in one save', async t => {
  const cases = [
    ['omni kind', on('x', { kind: 'omni' }), {}],
    ['genie kind', on('x', { kind: 'genie' }), {}],
    ['unfold kind', on('x', { kind: 'unfold' }), {}],
    ['Main Bot with Omni linked', on('main'), { linked: true }],
    ['Main Bot with only the saved Omni link', on('main'), { omniFile: true }],
    ['shared with people', on('x', { people: { mode: 'allowlist', allow: ['visitor'] } }), {}],
    ['IM-bound', on('x'), { im: true }],
    ['omp kept ON', {
      id: 'x', model: 'acp-omp/default', nativeTools: true, nativeToolsKept: 'acp-omp',
      kind: 'omni',
    }, {}],
  ]
  for (const [label, bot, { linked, omniFile, im }] of cases) {
    const other = on('free')
    const h = host(t, { bots: [bot, other], omniFile })
    if (linked) h.rt.omniLinked = () => true
    if (im) h.rt.imBoundBot = id => id === 'x'
    assert.equal(h.rt.nativeToolsBlock(other), undefined, label)
    assert.deepEqual(fieldsOf(bot), [false, undefined, undefined], label)
    assert.deepEqual(fieldsOf(other), [true, 'acp-claude', undefined], label)
    assert.equal(h.rt.state.nativeToolsLocksRetired, true, label)
    await Promise.resolve()
    assert.equal(h.saves.length, 1, label)
    assert.equal(h.saves[0].nativeToolsLocksRetired, true, label)
    assert.equal(h.saves[0].bots[bot.id].nativeTools, false, label)
    // The lock itself is gone: the Bot can be turned ON again.
    assert.equal(h.rt.nativeToolsBlock(bot), undefined, label)
    assert.equal(h.rt.nativeToolsFor('chat-' + bot.id), false, label)
  }
})

test('(b) LiveShare counts only when live at the pass; one registry read per pass', async t => {
  const stopped = registryOf([{ state: 1 }])
  const quiet = host(t, { bots: [on('x'), on('y'), on('z')], registry: stopped })
  assert.equal(quiet.rt.nativeToolsBlock(quiet.rt.botOf('x')), undefined)
  for (const id of ['x', 'y', 'z']) assert.equal(quiet.rt.botOf(id).nativeTools, true, id)
  assert.equal(quiet.rt.state.nativeToolsLocksRetired, true)
  await Promise.resolve()
  assert.equal(quiet.saves.length, 0)
  assert.equal(stopped.reads, 1)

  const live = registryOf([{ state: 1 }, { state: 2 }])
  const sharing = host(t, { bots: [on('x'), on('y'), on('z')], registry: live })
  assert.equal(sharing.rt.nativeToolsFor('chat-x'), false)
  for (const id of ['x', 'y', 'z']) assert.equal(sharing.rt.botOf(id).nativeTools, false, id)
  await Promise.resolve()
  assert.equal(sharing.saves.length, 1)
  assert.equal(live.reads, 1)
  // With the marker set, a live share no longer locks anything, and the registry is not read.
  assert.equal(sharing.rt.nativeToolsBlock(sharing.rt.botOf('x')), undefined)
  assert.equal(live.reads, 1)
})

test('(c) Bots already off are not written; the marker rides; later choices survive', async t => {
  const h = host(t, { bots: [
    { id: 'off', model: CLAUDE, nativeTools: false, kind: 'omni' },
    { id: 'none', model: CLAUDE, people: { mode: 'allowlist', allow: ['visitor'] } },
    on('free'),
  ] })
  assert.equal(h.rt.nativeToolsFor('chat-free'), true)
  assert.equal(h.rt.botOf('off').nativeTools, false)
  assert.equal(Object.hasOwn(h.rt.botOf('none'), 'nativeTools'), false)
  assert.equal(h.rt.botOf('free').nativeTools, true)
  assert.equal(h.rt.state.nativeToolsLocksRetired, true)
  await Promise.resolve()
  assert.equal(h.saves.length, 0)
  // A second read writes nothing.
  assert.equal(h.rt.nativeToolsFor('chat-free'), true)
  await Promise.resolve()
  assert.equal(h.saves.length, 0)

  // The person turns ON a Bot that sat in a removed lock; a reload with the marker keeps it.
  await h.rt.setNativeTools('none', { nativeTools: true })
  assert.equal(h.rt.botOf('none').nativeTools, true)
  const saved = h.saves.at(-1)
  assert.equal(saved.nativeToolsLocksRetired, true)
  const reloaded = h.reload(saved)
  assert.equal(reloaded.rt.nativeToolsFor('chat-none'), true)
  assert.equal(reloaded.rt.botOf('none').nativeTools, true)
  await Promise.resolve()
  assert.equal(reloaded.saves.length, 0)
  // And a later explicit OFF survives a reload too.
  await reloaded.rt.setNativeTools('none', { nativeTools: false })
  const again = reloaded.reload(reloaded.saves.at(-1))
  assert.equal(again.rt.nativeToolsFor('chat-none'), false)
  assert.equal(again.rt.botOf('none').nativeTools, undefined)
})

test('(d) a throw in the check writes nothing, sets no marker, warns once and retries', async t => {
  const registry = registryOf([{ state: 1 }])
  registry.fail = true
  const h = host(t, { bots: [on('x'), on('y', { kind: 'omni' })], registry })
  assert.equal(h.rt.nativeToolsBlock(h.rt.botOf('x')), 'shared')
  assert.equal(h.rt.nativeToolsFor('chat-x'), false)
  assert.equal(h.rt.botOf('x').nativeTools, true)
  assert.equal(h.rt.botOf('y').nativeTools, true)
  assert.equal(h.rt.state.nativeToolsLocksRetired, undefined)
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0][0], /native tools upgrade check failed, retrying/)
  await Promise.resolve()
  assert.equal(h.saves.length, 0)
  // The registry recovers with a stopped share: today's predicate, nothing for the free Bot.
  registry.fail = false
  assert.equal(h.rt.nativeToolsFor('chat-x'), true)
  assert.equal(h.rt.botOf('x').nativeTools, true)
  assert.equal(h.rt.botOf('y').nativeTools, false)
  assert.equal(h.rt.state.nativeToolsLocksRetired, true)
  await Promise.resolve()
  assert.equal(h.saves.length, 1)
  assert.equal(h.warns.length, 1)

  // A live share at the recovered pass turns every ON Bot off.
  const later = registryOf([{ state: 2 }])
  later.fail = true
  const sharing = host(t, { bots: [on('x')], registry: later })
  sharing.rt.nativeToolsBlock(sharing.rt.botOf('x'))
  later.fail = false
  sharing.rt.nativeToolsBlock(sharing.rt.botOf('x'))
  assert.equal(sharing.rt.botOf('x').nativeTools, false)

  // A throw at the second Bot of the check: the first is not written either.
  const partial = host(t, { bots: [on('first', { kind: 'omni' }), on('second')] })
  partial.rt.imBoundBot = (id) => {
    if (id === 'second') throw new Error('IM state unreadable')
    return false
  }
  partial.rt.nativeToolsBlock(partial.rt.botOf('first'))
  assert.equal(partial.rt.botOf('first').nativeTools, true)
  assert.equal(partial.rt.state.nativeToolsLocksRetired, undefined)
  await Promise.resolve()
  assert.equal(partial.saves.length, 0)
})

test('(e) until the check runs where the team is written, the old locks stay', async t => {
  for (const options of [{ holds: false }, { loaded: false }]) {
    const h = host(t, { ...options, bots: [
      on('omni', { kind: 'omni' }), on('people', { people: { mode: 'allowlist', allow: [] } }),
      { id: 'off', model: CLAUDE, kind: 'genie' }, on('free'),
    ] })
    assert.equal(h.rt.nativeToolsBlock(h.rt.botOf('omni')), 'managed')
    assert.equal(h.rt.nativeToolsBlock(h.rt.botOf('people')), 'shared')
    for (const id of ['omni', 'people']) {
      assert.equal(h.rt.nativeToolsFor('chat-' + id), false, id)
      assert.equal(h.rt.nativeToolsEligible('chat-' + id), false, id)
      assert.equal(h.rt.nativeToolsBotOn(id), false, id)
      assert.equal(h.rt.botOf(id).nativeTools, true, id)
    }
    await assert.rejects(h.rt.setNativeTools('off', { nativeTools: true }),
      { message: NATIVE_TOOLS_BLOCK_TEXT.managed })
    assert.equal(h.rt.nativeToolsFor('chat-free'), true)
    assert.equal(h.rt.state.nativeToolsLocksRetired, undefined)
    await Promise.resolve()
    assert.equal(h.saves.length, 0)
  }
  // An unreadable registry in the window reads as shared, as before.
  const unreadable = registryOf()
  unreadable.fail = true
  const blind = host(t, { holds: false, bots: [on('free')], registry: unreadable })
  assert.equal(blind.rt.nativeToolsBlock(blind.rt.botOf('free')), 'shared')

  // E3-2: a host that cannot hold the lock but writes the team runs the check.
  const broken = host(t, { holds: false, canWrite: true, bots: [
    on('omni', { kind: 'omni' }), { id: 'off', model: CLAUDE, kind: 'genie' },
  ] })
  assert.equal(broken.rt.nativeToolsBlock(broken.rt.botOf('omni')), undefined)
  assert.equal(broken.rt.botOf('omni').nativeTools, false)
  assert.equal(broken.rt.state.nativeToolsLocksRetired, true)
  await Promise.resolve()
  assert.equal(broken.saves.length, 1)
  // After the marker: no code, and ON saves.
  await broken.rt.setNativeTools('off', { nativeTools: true })
  assert.equal(broken.rt.botOf('off').nativeTools, true)
  assert.equal(broken.rt.nativeToolsFor('chat-off'), true)
  assert.equal(broken.rt.nativeToolsBotOn('off'), true)
})
