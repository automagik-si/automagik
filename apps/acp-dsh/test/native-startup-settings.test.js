import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { CLAUDE, holdNativeStartup, nativeWorld, person } from './fixtures/managed-native-world.js'

const notice = 'The tools setting changed; send again.'
const textOf = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => chunk.block.text).join('')

for (const [kind, identity] of [
  ['a Workspace without an identity', undefined],
  ['an eligible Bot with no saved switch', { name: 'Ada', nativeToolsBlocked: false }],
]) {
  test(`team registration during standalone ON startup stops ${kind} before its first prompt`, async t => {
    const w = nativeWorld(t, { hidden: true, managed: false })
    const chat = w.chat('direct')
    const startup = holdNativeStartup(t, w)
    const pending = chat.turn('owner before team registration')
    let on
    let legacyPid
    try {
      on = await Promise.race([startup.entered, pending.then(() => assert.fail('ON startup did not reach the hold'))])
      w.assertToolset(0, true)
      const [launch] = w.events('new-session')
      legacyPid = launch.pid
      assert.equal(on.child.pid, legacyPid)
      assert.equal(on.alive, true)
      assert.equal(launch.systemPrompt, undefined)
      assert.equal(w.identityReaders.everRegistered(), false)
      assert.deepEqual(w.events('prompt'), [], 'the ON PID has no prompt before registration')
      w.identityReaders.register(id => id === chat.session.id ? identity : undefined)
      assert.equal(w.identityReaders.everRegistered(), true)
      assert.equal(w.identityReaders.read(chat.session.id), identity)
      assert.deepEqual(w.events('prompt'), [], 'registration sends no prompt while startup is held')
    } finally {
      startup.release()
    }

    const stopped = await pending
    if (!on.alive) await on.gone.catch(() => {})
    const first = {
      launchPids: w.events('new-session').map(row => row.pid),
      promptPids: w.events('prompt').map(row => row.pid),
      reason: stopped.at(-1).reason,
      text: textOf(stopped),
      exit: on.exited,
    }
    const next = await chat.turn('next owner message after registration')
    const launches = w.events('new-session')
    const flags = launches.map(row => row.meta.disableBuiltInTools)
    const promptPids = w.events('prompt').map(row => row.pid)
    t.diagnostic(JSON.stringify({ first, next: { launchPids: launches.map(row => row.pid), flags, promptPids } }))

    assert.deepEqual(first.promptPids, [], 'the legacy ON PID receives no prompt after registration')
    assert.deepEqual(first.launchPids, [legacyPid], 'the interrupted turn did not retry')
    assert.deepEqual(first.reason, { kind: 'stop' })
    assert.equal(first.text, notice)
    assert.ok(first.exit, 'the legacy ON PID exited before the next owner message')
    assert.deepEqual(next.at(-1).reason, { kind: 'stop' })
    assert.deepEqual(flags, [false, true])
    assert.notEqual(launches[1].pid, legacyPid)
    assert.deepEqual(promptPids, [launches[1].pid])
    assert.match(w.events('prompt')[0].text, /next owner message after registration/)
    assert.equal(launches[1].systemPrompt?.includes('You are Ada') ?? false, identity !== undefined)
  })
}

test('a standalone ON startup without team registration prompts its original PID', async t => {
  const w = nativeWorld(t, { hidden: true, managed: false })
  const chat = w.chat('direct')
  const startup = holdNativeStartup(t, w)
  const pending = chat.turn('standalone owner message')
  try {
    await Promise.race([startup.entered, pending.then(() => assert.fail('ON startup did not reach the hold'))])
    w.assertToolset(0, true)
    assert.deepEqual(w.events('prompt'), [])
  } finally {
    startup.release()
  }
  const reply = await pending
  const launchPids = w.events('new-session').map(row => row.pid)
  const promptPids = w.events('prompt').map(row => row.pid)
  t.diagnostic(JSON.stringify({ launchPids, flags: [false], promptPids }))
  assert.equal(w.identityReaders.everRegistered(), false)
  assert.deepEqual(reply.at(-1).reason, { kind: 'stop' })
  assert.equal(launchPids.length, 1)
  assert.deepEqual(promptPids, launchPids)
  assert.match(w.events('prompt')[0].text, /standalone owner message/)
})

for (const change of ['saved switch OFF', 'effective Read only', 'unknown level', 'a throwing preset reader']) {
  test(`an ON startup stops before its first prompt after ${change}`, async t => {
    let saved = true
    let mode = 'workspace-write'
    let fails = false
    const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: saved }) })
    w.services.sandboxPolicy.resolve = () => ({ mode })
    w.services.permissionPresets = { current() {
      if (fails) throw new Error('test preset read failure')
    } }
    const chat = w.chat('direct')
    const startup = holdNativeStartup(t, w)
    const pending = chat.turn('owner while startup is held')
    let on
    try {
      on = await Promise.race([startup.entered, pending.then(() => assert.fail('ON startup did not reach the hold'))])
      w.assertToolset(0, true)
      assert.deepEqual(w.events('prompt'), [])
      if (change === 'saved switch OFF') saved = false
      else if (change === 'effective Read only') mode = 'read-only'
      else if (change === 'unknown level') mode = undefined
      else fails = true
    } finally {
      startup.release()
    }
    const stopped = await pending
    const first = {
      flags: w.events('new-session').map(row => row.meta.disableBuiltInTools),
      launchPids: w.events('new-session').map(row => row.pid),
      promptPids: w.events('prompt').map(row => row.pid),
      reason: stopped.at(-1).reason,
      text: textOf(stopped),
      onAlive: on.alive,
    }
    if (!on.alive) await on.gone.catch(() => {})
    const next = await chat.turn('owner after the change')
    const launches = w.events('new-session')
    const promptPids = w.events('prompt').map(row => row.pid)
    t.diagnostic(JSON.stringify({ first, next: { launchPids: launches.map(row => row.pid), promptPids } }))

    assert.deepEqual(first.promptPids, [], 'the interrupted turn sends zero prompts')
    assert.deepEqual(first.flags, [false], 'the interrupted turn never retries OFF')
    assert.deepEqual(first.reason, { kind: 'stop' })
    assert.equal(first.text, notice)
    assert.equal(first.onAlive, false)
    assert.ok(on.exited)
    assert.deepEqual(next.at(-1).reason, { kind: 'stop' })
    assert.deepEqual(launches.map(row => row.meta.disableBuiltInTools), [false, true])
    assert.notEqual(launches[0].pid, launches[1].pid)
    assert.deepEqual(promptPids, [launches[1].pid])
  })
}

test('Stop during ON startup keeps the ordinary Stop result when the level also changes', async t => {
  let mode = 'workspace-write'
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: true }) })
  w.services.sandboxPolicy.resolve = () => ({ mode })
  const { session } = w.chat('direct')
  const startup = holdNativeStartup(t, w)
  const controller = new AbortController()
  const request = markAgentLoopRequest({
    provider: CLAUDE, model: 'default', sessionId: session.id, messages: [person('plain: stopped')],
    signal: controller.signal,
  })
  const chunks = []
  const pending = (async () => {
    for await (const chunk of w.adapter.stream(request)) chunks.push(chunk)
  })()
  let on
  try {
    on = await Promise.race([startup.entered, pending.then(() => assert.fail('ON startup did not reach the hold'))])
    w.assertToolset(0, true)
    mode = 'read-only'
    controller.abort()
    w.adapter.noteEvent(session, session.append('sandbox/mode', { mode }))
  } finally {
    startup.release()
  }
  await pending
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.deepEqual(chunks.at(-1).reason.failure, { message: 'Stopped', code: 'ABORTED' })
  assert.equal(textOf(chunks), '')
  assert.deepEqual(w.events('prompt'), [])
  assert.equal(w.events('new-session').length, 1)
  await on.gone.catch(() => {})
  assert.ok(on.exited)
})

test('a switch change during the final turn gate still stops before the first prompt', async t => {
  let saved = true
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: saved }) })
  const chat = w.chat('direct')
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let checks = 0
  w.adapter.holds = () => [async () => {
    if (++checks === 2) {
      entered.resolve()
      await release.promise
    }
  }]
  const pending = chat.turn('owner during last startup check')
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail('the final turn gate was not reached'))])
    w.assertToolset(0, true)
    assert.deepEqual(w.events('prompt'), [])
    saved = false
  } finally {
    release.resolve()
  }
  const stopped = await pending
  assert.deepEqual(stopped.at(-1).reason, { kind: 'stop' })
  assert.equal(textOf(stopped), notice)
  assert.deepEqual(w.events('prompt'), [])
  assert.equal(w.events('new-session').length, 1)
  assert.equal(w.adapter.live.has('direct'), false)
})

// #1564 follow-up (A13): reuse confirms the saved switch once more (fail closed).
test('an unchanged ON startup gets its first prompt and reuses the same PID, confirming the switch once', async t => {
  let reads = 0
  const w = nativeWorld(t, { identity: () => ({ name: 'Ada', get nativeTools() { reads++; return true } }) })
  const chat = w.chat('direct')
  const startup = holdNativeStartup(t, w)
  const pending = chat.turn('first owner turn')
  try {
    await Promise.race([startup.entered, pending.then(() => assert.fail('ON startup did not reach the hold'))])
    assert.deepEqual(w.events('prompt'), [])
  } finally {
    startup.release()
  }
  assert.deepEqual((await pending).at(-1).reason, { kind: 'stop' })
  w.assertToolset(0, true)
  const startupReads = reads
  assert.equal(startupReads, 2)
  await chat.turn('next owner turn')
  const [launch] = w.events('new-session')
  assert.equal(w.events('new-session').length, 1)
  assert.deepEqual(w.events('prompt').map(row => row.pid), [launch.pid, launch.pid])
  assert.equal(reads, startupReads + 1)
})

for (const [type, value] of [
  ['sandbox/mode', { mode: 'read-only' }],
  ['permission/preset', { preset: 'read-only' }],
  ['approval/policy', { policy: 'never' }],
]) {
  test(`${type} ends a live ON child when the effective level becomes Read only`, async t => {
    let mode = 'workspace-write'
    const w = nativeWorld(t, { identity: () => ({ name: 'Ada', nativeTools: true }) })
    w.services.sandboxPolicy.resolve = () => ({ mode })
    const chat = w.chat('direct')
    await chat.turn('first owner turn')
    w.assertToolset(0, true)
    const live = w.adapter.live.get('direct')
    const on = live.run
    mode = 'read-only'
    w.adapter.noteEvent(chat.session, chat.session.append(type, value))
    assert.equal(w.adapter.live.has('direct'), false)
    await on.gone.catch(() => {})
    assert.ok(on.exited)
    await chat.turn('owner after the change')
    w.assertToolset(1, false)
    const [first, next] = w.events('new-session')
    assert.notEqual(first.pid, next.pid)
    assert.deepEqual(w.events('prompt').map(row => row.pid), [first.pid, next.pid])
    assert.equal(live.held, 'This conversation is now Read only. Send a new message to continue.')
  })
}
