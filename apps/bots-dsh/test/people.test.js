import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanPeople, peopleOf, personKey } from '../src/host/people.js'
import { until } from './until.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { allowlist, code, fixture, guest, identity, member, owners, serviceStub, workspace } from './caller-fixture.js'

test('P1 validates a bounded, recently admitted allowlist', () => {
  const options = { seen: [member.person] }
  assert.deepEqual(cleanPeople({ mode: 'owners' }), owners)
  assert.deepEqual(cleanPeople(allowlist, options), allowlist)
  assert.deepEqual(cleanPeople(allowlist, { current: allowlist }), allowlist)
  assert.notEqual(personKey({ issuer: 'a:b', subject: 'c' }), personKey({ issuer: 'a', subject: 'b:c' }))
  for (const input of [null, [], {}, { mode: 'public' }, { ...owners, parts: [] }, { ...owners, x: 1 },
    { ...owners, allow: null }, { ...owners, allow: Array(101).fill(allowlist.allow[0]) },
    ...[{ ...identity }, { ...identity, role: 'admin' }, { ...identity, issuer: '', role: 'member' },
      { ...identity, subject: 'x'.repeat(513), role: 'guest' }, { ...identity, subject: 'a\u0000b', role: 'guest' },
      { ...allowlist.allow[0], extra: true }].map(entry => ({ ...allowlist, allow: [entry] })),
    { ...allowlist, allow: Array(2).fill(allowlist.allow[0]) }]) {
    assert.throws(() => cleanPeople(input, options), code('invalid'))
  }
  assert.throws(() => cleanPeople(workspace, { main: true }), /only with people you name/)
  assert.throws(() => cleanPeople(allowlist), /not signed in/)
  assert.throws(() => cleanPeople(allowlist, { seen: [guest.person] }), /not as a member/)
  assert.throws(() => cleanPeople(allowlist, { seen: [{ ...member.person, roles: ['owner', 'member'] }] }), code('refused'))
})

test('P2 malformed persisted grants are owner-only and Main workspace grants are allowlists', () => {
  for (const people of [undefined, null, [], 5, {}, { mode: 'owners' }, { ...workspace, mode: 'public' },
    { ...workspace, parts: [] }, { ...workspace, allow: [{}] },
    { ...allowlist, allow: [allowlist.allow[0], allowlist.allow[0]] }]) {
    assert.deepEqual(peopleOf({ people }), owners)
  }
  assert.deepEqual(peopleOf({ people: { ...allowlist, mode: 'workspace' } }, { main: true }), allowlist)
})

test('P3 the real owner switch opens one fresh part after saving', async t => {
  const f = fixture(t)
  await f.start()
  f.event('b', 'turn/start', { turn: 1 })
  f.event('b', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'before sharing' }] })
  const save = f.rt.save
  let checked
  t.mock.method(f.rt, 'save', async (...args) => {
    if (f.rt.chatOf('b') !== 'b' && checked === undefined) {
      checked = true
      assert.deepEqual(f.readable(), [])
      assert.equal(f.rt.shareState('b'), 'opening')
    }
    return save(...args)
  })
  assert.deepEqual(await f.call('update-bot', { id: 'b', people: workspace }), {
    ok: true, value: { id: 'b', people: workspace, opening: true },
  })
  await f.finishSwitch()
  assert.equal(checked, true)
  const fresh = f.rt.chatOf('b')
  assert.equal(f.rt.shareState('b'), 'open')
  assert.deepEqual(f.readable(), [fresh])
  assert.equal(f.saved().bots.b.sessionId, fresh)
  const [pack] = f.logs.get(fresh)
  assert.equal(f.logs.get(fresh).length, 1)
  assert.equal(pack.data.source.handoff, true)
  assert.equal(pack.data.source.role, 'handoff')
  assert.deepEqual(await f.rt.callerChat(member, 'b'), { items: [], cursor: null })
  assert.deepEqual(await f.rt.callerChat(member, 'b', Buffer.from('{"part":1}').toString('base64url')), { items: [], cursor: null })
  assert.deepEqual(f.reads, [fresh])
})

test('P4 refuses pending switches, pins, cards, goals, work and both inboxes before saving', async t => {
  const attempts = [
    ['already moving', f => { f.rt.switchJobs = () => [{ botId: 'b' }] }],
    ['host runs', f => { f.rt.botOf('b').sessionPinned = true }],
    ['earlier messages', f => { f.rt.state.switching.z = { botId: 'b' } }],
    ['open card', f => { f.rt.state.questions.b = { id: 'q' } }],
    ['open card', f => { f.rt.state.views.b = { id: 'v' } }],
    ['Pause Writer', f => { f.goals.set('b', { phase: 'active' }) }],
    ['Wait for Writer', f => { f.agentOf('b').status = 'running' }],
    ['messages waiting', f => { f.agentOf('b').inbox.nextTurn.push({ id: 'queued' }) }],
    ['messages waiting', f => { f.agentOf('b').inbox.nextStep.push({ id: 'queued' }) }],
  ]
  for (const [message, arrange] of attempts) {
    const f = fixture(t)
    await f.start()
    arrange(f)
    const write = t.mock.method(f.rt, 'saveCopy')
    await assert.rejects(f.rt.setPeople('b', workspace), { ...code('refused'), message: new RegExp(message) })
    assert.equal(write.mock.callCount(), 0)
    assert.equal(f.rt.botOf('b').people, undefined)
    assert.deepEqual(f.created, [])
  }
})

test('P5 a newly held message, a late claim and an active goal each spoil the real share switch', async t => {
  for (const carried of ['held', 'late-claim', 'goal']) {
    const f = fixture(t)
    await f.start()
    const old = f.agentOf('b')
    const message = { id: 'late', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'late' }] }
    const make = f.ctx.sessionController.create
    const create = t.mock.method(f.ctx.sessionController, 'create', async () => {
      if (carried === 'goal') f.goals.set('b', { phase: 'active' })
      if (carried === 'held') old.inbox.nextTurn.push(message)
      return make()
    })
    const flush = t.mock.method(f.ctx.sessions, 'flush', async session => {
      if (carried === 'late-claim' && session.id === f.rt.chatOf('b') && session.id !== 'b') {
        const job = [...f.rt.switchJobs()][0]
        if (job && job.carry.length === 0 && !f.logs.get(session.id).some(item => item.data?.content?.[0]?.text === 'late')) {
          // Let the package flush resume and the first carry batch be collected.
          queueMicrotask(() => queueMicrotask(() => job.carry.push(message)))
        }
      }
    })
    await f.open()
    assert.equal(f.rt.shareState('b'), 'spoiled', carried)
    assert.deepEqual(f.readable(), [])
    if (carried !== 'goal') assert.equal(f.logs.get(f.rt.chatOf('b')).at(-1).data.content[0].text, 'late')
    create.mock.restore()
    flush.mock.restore()
    f.goals.clear()
    await f.rt.setPeople('b', owners)
    const reopened = await f.open()
    assert.deepEqual(f.readable(), [reopened])
  }
})

test('P6 chained moves keep published parts, and stale or unrelated moves cannot add one', async t => {
  const f = fixture(t)
  await f.start()
  const first = await f.open()
  const originalShare = f.rt.shareIdOf('b')
  assert.equal((await f.call('bot-fresh', { id: 'b' })).ok, true)
  await f.finishSwitch()
  const second = f.rt.chatOf('b')
  assert.deepEqual(f.readable(), [first, second])
  const current = () => f.rt.chatOf('b')
  async function cutoff(id) {
    const agent = f.agentOf(id)
    const start = (f.ctx.listeners.get('agent/pre-step') ?? []).find(listener => listener.toString().includes('checkpoint.carry'))
    await start({ agent, messages: [], step: 1, signal: AbortSignal.timeout(60_000) }, () => 'next')
    for (let turn = 1; turn <= 2; turn++) {
      f.event(id, 'turn/start', { turn })
      f.event(id, 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    }
    f.ctx.emit('agent/status', { agent, status: 'idle' })
    await until(() => current() !== id, { label: 'size handoff to open a part' })
    await f.finishSwitch()
    return current()
  }
  const third = await cutoff(second)
  assert.deepEqual(f.readable(), [first, second, third])
  assert.equal(f.rt.botOf('b').segments.at(-1).fallback, 'cutoff')
  f.rt.answersAside = () => false
  f.rt.backgroundModel = async () => undefined
  f.agentOf(third).session.requestHeader = () => ({ config: { provider: 'deepseek', model: 'v4' } })
  assert.equal((await f.call('bot-new-part', { botId: 'b' })).ok, true)
  await f.finishSwitch()
  const trial = current()
  assert.notEqual(trial, third)
  assert.deepEqual(f.readable(), [first, second, third, trial])
  const unpublish = t.mock.method(f.rt, 'unpublishPart')
  f.event(trial, 'turn/start', { turn: 1 })
  f.event(trial, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_OVERFLOW', message: 'fixture' } } })
  await until(() => f.archived.includes(trial), { label: 'failed part to revert and archive' })
  assert.equal(unpublish.mock.calls[0].arguments[1], trial)
  assert.equal(current(), third)
  assert.deepEqual(f.readable(), [first, second, third])
  assert.equal((await f.call('bot-open-part', { botId: 'b', sessionId: 'b' })).ok, true)
  assert.equal(current(), 'b')
  assert.deepEqual(f.readable(), [third, first, second])
  const unrelated = await cutoff('b')
  assert.ok(!f.readable().includes(unrelated))

  f.rt.botOf('b').kind = 'dsh'
  f.rt.botOf('b').dshAgentId = 'native'
  f.rt.state.agents.native = { id: 'native', kind: 'dsh', name: 'Writer', sessions: ['b'], adoptedBotId: 'b' }
  f.ctx.agents.turnBoundaryOf = () => ({ openTurnStartSeq: null, lastTurn: 0 })
  const adopted = await f.call('bot-session-adopt', { botId: 'b', sessionId: 'owner-session', sourceSessionId: unrelated })
  assert.equal(adopted.ok, true, JSON.stringify(adopted))
  assert.equal(current(), 'owner-session')
  assert.deepEqual(f.readable(), [third, first, second])
  await f.rt.setPeople('b', owners)
  assert.deepEqual(f.readable(), [])
  const newPart = await f.open()
  await f.rt.publishPart({ botId: 'b', fromPart: newPart, freshId: newPart, shareId: originalShare, kind: 'move' })
  assert.deepEqual(f.readable(), [newPart])
})

test('P7 queued unsharing, stale publication and a reading host fail closed', async t => {
  for (const unshareFirst of [false, true]) {
    const f = fixture(t)
    await f.start()
    const former = await f.open()
    const stale = f.rt.shareIdOf('b')
    const wait = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const save = f.rt.saveCopy
    let first = true
    t.mock.method(f.rt, 'saveCopy', async (...args) => {
      if (first) {
        first = false
        entered.resolve()
        await wait.promise
      }
      return save(...args)
    })
    const updates = (unshareFirst ? [owners, allowlist] : [allowlist, owners]).map(people => f.rt.setPeople('b', people))
    await entered.promise
    wait.resolve()
    await Promise.all(updates)
    await f.finishSwitch()
    assert.equal(f.readable().includes(former), false)
    if (unshareFirst) {
      const current = f.rt.chatOf('b')
      await f.rt.publishPart({ botId: 'b', fromPart: former, freshId: current, shareId: stale, kind: 'share' })
      assert.deepEqual(f.readable(), [current])
    } else {
      assert.deepEqual(f.readable(), [])
    }
  }
  const f = fixture(t)
  await f.start()
  const publish = f.rt.publishPart
  t.mock.method(f.rt, 'publishPart', args => {
    f.rt.readOnly = () => 'lock lost'
    return publish(args)
  })
  await f.rt.setPeople('b', workspace)
  await f.finishSwitch()
  assert.deepEqual(f.readable(), [])
  await assert.rejects(f.rt.callerChat(member, 'b'), code('read-only'))
})

test('P8 Bot relays close an entire part synchronously, including missed events read from history', async t => {
  for (const [trigger, source] of [
    ['user', { role: 'request' }],
    ['schedule', { role: 'request', joined: true }],
    [undefined, { role: 'reply' }],
    [undefined, { role: 'report', deferred: true }],
    [undefined, { role: 'handoff', handoff: true, resume: true, joined: ['relay'] }],
  ]) {
    const f = fixture(t)
    await f.start()
    const part = await f.open()
    f.event(part, 'turn/start', { turn: 1 })
    f.event(part, 'user/message', { source: { kind: SOURCE_KIND, role: 'handoff', handoff: true } })
    f.event(part, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(f.readable(), [part])
    f.event(part, 'turn/start', { turn: 2 })
    if (trigger) f.event(part, 'user/message', { source: { kind: trigger }, content: [{ type: 'text', text: 'turn opener' }] })
    f.event(part, 'user/message', { source: { kind: SOURCE_KIND, exchangeId: 'joining-relay', ...source } })
    if (trigger) assert.equal((f.rt.state.exchangeTurns[part] ?? []).includes(2), false)
    assert.deepEqual(f.readable(), [])
    assert.deepEqual(await f.rt.callerChat(member, 'b'), { items: [], cursor: null })
  }
  const marked = fixture(t)
  await marked.start()
  const markedPart = await marked.open()
  const closing = t.mock.method(marked.rt, 'closePart')
  marked.event(markedPart, 'turn/start', { turn: 1 })
  marked.event(markedPart, 'user/message', { source: { kind: SOURCE_KIND, role: 'room', exchangeId: 'hidden' } })
  assert.deepEqual(marked.rt.state.exchangeTurns[markedPart], [1])
  assert.ok(closing.mock.calls.some(call => call.arguments[1] === 'exchange'))
  assert.deepEqual(marked.readable(), [])

  const f = fixture(t)
  await f.start()
  const part = await f.open()
  f.event(part, 'user/message', { source: { kind: SOURCE_KIND, role: 'reply' } }, { notify: false })
  await assert.rejects(f.rt.callerChat(member, 'b'), code('not-found'))
  assert.deepEqual(f.readable(), [])
})

test('P9 reset persists once before providing visibility and reload never restores old parts', async t => {
  let f
  const service = serviceStub({ onProvide() { assert.deepEqual(f.saved().bots.b.people, owners) } })
  let reset
  f = fixture(t, {
    service, seed: team => { team.bots.b.people = workspace },
    beforeLoad: rt => { reset = t.mock.method(rt, 'save') },
  })
  await f.start()
  assert.equal(reset.mock.calls.filter(call => call.arguments[0]?.required).length, 1)
  const part = await f.open()
  const replacement = serviceStub()
  await f.emitService(replacement)
  assert.equal(service.hasProvider(), false)
  assert.equal(replacement.hasProvider(), true)
  assert.deepEqual(f.saved().bots.b.people, owners)
  assert.deepEqual(f.readable(), [])
  const reopened = await f.open()
  assert.deepEqual(f.readable(), [reopened])
  assert.equal(f.readable().includes(part), false)

  const broken = fixture(t, {
    seed: team => { team.bots.b.people = workspace },
    beforeLoad: rt => {
      const save = rt.save
      rt.save = options => options?.required ? Promise.reject(new Error('fixture disk failure')) : save(options)
    },
  })
  await broken.start()
  assert.equal(broken.service.hasProvider(), false)
  assert.deepEqual([...broken.service.visibleBotIds(member)], [])
  assert.match(broken.warnings.join('\n'), /resetting Bot sharing failed/)
})

test('P10 outside edits preserve grants in memory and withdraw on ownership changes', async t => {
  const room = id => ({ id, name: 'Room', named: true, members: [], sessions: {}, log: [] })
  for (const change of [
    next => { next.mainBotIds.push('b') },
    next => { next.mainBotIds = ['a'] },
    (next, part) => { next.rooms[part] = room(part) },
    (next, part) => { next.rooms.r = { ...room('r'), sessionId: part } },
    (next, part) => { next.tasks = { [part]: {} } },
    (next, part) => { next.subscriptionRuns = [{ sessionId: part }] },
    next => { next.bots.b.sessionId = 'outside-session' },
    next => { next.bots.b.segments = [] },
  ]) {
    const demote = change.toString().includes('mainBotIds =')
    const f = fixture(t, { seed: team => { if (demote) team.mainBotIds.push('b') } })
    await f.start()
    const part = await f.open('b', demote ? allowlist : workspace)
    await f.edit(next => change(next, part))
    assert.equal(f.rt.shareState('b'), undefined)
    assert.deepEqual(f.readable(), [])
    assert.equal(f.saved().bots.b.people.mode, 'owners')
    assert.equal(f.warnings.filter(message => message.includes('outside edit of the team file closed')).length, 1)
  }
  const claimed = fixture(t)
  await claimed.start()
  const claimedPart = await claimed.open()
  claimed.rt.state.rooms.r = { ...room('r'), sessionId: claimedPart }
  await claimed.rt.save()
  assert.deepEqual(claimed.readable(), [])
  await claimed.edit(next => { delete next.rooms.r })
  assert.equal(claimed.rt.shareState('b'), undefined)
  assert.deepEqual(claimed.readable(), [])
  assert.deepEqual(claimed.saved().bots.b.people, owners)

  const f = fixture(t)
  await f.start()
  const part = await f.open('b', allowlist)
  await f.edit(next => { next.bots.b.people = workspace })
  assert.deepEqual(f.rt.botOf('b').people, allowlist)
  assert.deepEqual(f.readable(), [part])
})
