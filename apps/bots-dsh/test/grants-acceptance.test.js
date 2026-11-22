import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as reviewer from '@deepseek-ai/dsh-experimental-auto-review'
import * as persistentBash from '@deepseek-ai/dsh-tool-bash-persistent'
import { createUnfold } from './fake-unfold-bot.js'
import { API, bench, DOMAIN, REASON, ROUTE, STEP } from './grants-fixture.js'
import { immediate, until } from './until.js'

test('rfc0039 D4 A1 a task replays with one DSH decision per call [P]', async t => {
  const r = await bench(t)
  const grantId = await r.grant()
  assert.equal((await r.state()).work.grants[0].uses, 0)
  const replay = r.ask('t1')
  assert.equal(await replay.answer, 'allowed-once')
  const asks = r.ledger.filter(row => row.type === 'approval/asked')
  const decisions = r.ledger.filter(row => row.type === 'approval/decided')
  assert.equal(asks.length, 2)
  assert.notEqual(asks[0].data.id, asks[1].data.id)
  assert.deepEqual(decisions.map(row => row.data), asks.map(row =>
    ({ id: row.data.id, outcome: 'allowed-once' })))
  assert.equal(r.records.filter(row => row.kind === 'open').length, 1)
  assert.ok(r.records.some(row => row.kind === 'grant' && row.requestId === asks[1].data.id
    && row.decidedBy === 'grant' && row.grantId === grantId))
  assert.equal((await r.state()).work.grants[0].uses, 1)
})

test('rfc0039 D4 A1f first ask works before the window polls [P]', async t => {
  const r = await bench(t)
  const ask = r.ask('a')
  await until(() => r.records.some(row => row.kind === 'open'), { poll: immediate })
  const open = r.records.find(row => row.kind === 'open')
  assert.equal(open.grantable, true)
  assert.equal((await r.allow(open)).ok, true)
  assert.equal(await ask.answer, 'allowed-once')
  const chat = r.opened.get('a')
  chat.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  r.turn(chat, 2)
  assert.equal(await r.replay('a'), 'allowed-once')
})

test('rfc0039 D4 A1c an ordinary allow asks again [C]', async t => {
  const r = await bench(t)
  for (let n = 0; n < 2; n++) {
    const asking = r.ask('t1')
    assert.equal((await r.once(await r.held(asking))).ok, true)
    assert.equal(await asking.answer, 'allowed-once')
  }
  assert.equal(r.records.filter(row => row.kind === 'open').length, 2)
})

for (const [name, id, spec] of [
  ['rfc0039 D4 A2 changed side argument has its own offer [P]', 't1',
    { args: { ...STEP, timeout_ms: 1000 } }],
  ['rfc0039 D4 A3 wider command has its own offer [P]', 't1',
    { args: { ...STEP, command: 'echo ok more' } }],
  ['rfc0039 D4 A4 another task has its own offer [P]', 't2'],
  ['rfc0039 D4 A5 another Bot has its own offer [P]', 't3'],
]) test(name, async t => {
  const r = await bench(t)
  const original = await r.grant()
  const asking = r.ask(id, spec)
  const card = await r.held(asking)
  assert.equal(card.grantable, true)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await asking.answer, 'rejected')
  assert.equal(await r.replay('t1'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => [row.id, row.uses]), [[original, 1]])
})

test('rfc0039 D4 A6 and A6s route changes end grants and demote started calls [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const survivor = await r.grant('t2')
  const started = r.start('t1')
  const task = r.opened.get('t1')
  for (const route of [{ ...ROUTE, model: 'v5' }, ROUTE]) {
    task.append('model/selection', route)
    r.routeTo(task, route)
  }
  const old = r.ask('t1', { callId: started })
  const card = await r.held(old)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
  assert.equal((await r.once(card)).ok, true)
  assert.equal(await old.answer, 'allowed-once')
  const next = r.ask('t1')
  const nextCard = await r.held(next)
  assert.equal(nextCard.grantable, true)
  await r.once(nextCard, 'reject')
  assert.equal(await next.answer, 'rejected')
  assert.equal(await r.replay('t2'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 A6e effort-only native selection keeps the grant [P]', async t => {
  const r = await bench(t)
  const id = await r.grant('a')
  await r.rt.selectSessionModel('a', { ...ROUTE, reasoningEffort: 'high' })
  assert.equal(await r.replay('a'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => [row.id, row.uses]), [[id, 1]])
})

test('rfc0039 D4 A7 a level change holds the Bot until the apply settles [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const survivor = await r.grant('t3')
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  r.resolving.before = async id => {
    if (id !== 'a') return
    entered.resolve()
    await gate.promise
  }
  try {
    const changing = r.request('update-bot', { id: 'a', permission: 'read-only' })
    await Promise.race([entered.promise, changing.then(result => {
      assert.fail('the setter returned before applying the level: ' + JSON.stringify(result))
    })])
    const pending = r.ask('t1')
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.allow(card)).error.code, 'bot/refused')
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
    gate.resolve()
    assert.equal((await changing).ok, true)
    assert.equal((await r.request('update-bot', { id: 'a', permission: 'workspace-write' })).ok,
      true)
  } finally { gate.resolve() }
  assert.equal(await r.replay('t3'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 A7p an unowned parent prevents a descendant grant [P]', async t => {
  const r = await bench(t, { tasks: {
    parent: { title: 'Unowned parent', status: 'working', at: Date.now() },
    child: { from: 'a', title: 'Child', status: 'working', at: Date.now(), levelTaskId: 'parent' },
  } })
  r.open('parent')
  r.open('child')
  await immediate()
  await r.grant()
  const child = r.ask('child')
  const card = await r.held(child)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
  await r.once(card, 'reject')
  assert.equal(await child.answer, 'rejected')
})

test('rfc0039 D4 A8 a deny-list save ends the grant [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const survivor = await r.grant('t3')
  assert.equal((await r.request('update-bot', { id: 'a', denyTools: ['bash'] })).ok, true)
  assert.equal((await r.request('update-bot', { id: 'a', denyTools: [] })).ok, true)
  const pending = r.ask('t1')
  assert.equal((await r.held(pending)).grantable, true)
  assert.equal(await r.replay('t3'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 A9 terminal task turns and wake-log repair end their grants [P]', async t => {
  const extra = { from: 'a', title: 'Fixture task', status: 'working', at: Date.now() }
  const r = await bench(t, { tasks: { t4: { ...extra }, t5: { ...extra } } })
  await r.rt.wakeLog.replayed
  const survivor = await r.grant('c')
  const endGrants = t.mock.method(r.rt, 'endGrants')
  for (const id of ['t4', 't5']) r.open(id)
  const result = [{ kind: 'completed' }, { kind: 'error', error: { message: 'mock failure' } },
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'error', error: { code: 'ABORTED', message: 'ACP cancellation' } },
    { kind: 'interrupted' }]
  for (const [n, reason] of result.entries()) {
    const id = 't' + (n + 1)
    await r.grant(id)
    const session = r.opened.get(id)
    // Supply the ACP provider to the terminal-status classifier without a route event.
    const header = id === 't4' && t.mock.method(session, 'requestHeader',
      () => ({ config: { provider: 'acp-codex', model: 'fixture' } }))
    try {
      session.append('turn/end', { turn: 1, reason })
    } finally {
      if (header) header.mock.restore()
    }
    if (id === 't4') assert.deepEqual(endGrants.mock.calls.at(-1)?.arguments, [id, 'task'])
  }
  assert.equal(r.rt.state.tasks.t5.status, 'working')
  assert.ok(r.rt.grantsView().some(row => row.owner.id === 't5'))
  const report = { role: 'task-done', note: 'Fixture task', text: 'Repaired report',
    taskSessionId: 't5' }
  const outcome = { status: 'done', endedAt: Date.now(), summary: 'Repaired report' }
  assert.equal(r.rt.wakeLog.intent({ id: 'repair', kind: 'task-report', botId: 'a',
    key: 'task:t5', sessionId: 'a', report, outcome }), 'written')
  r.rt.wakeLog.firstFinished('repair')
  await r.rt.wakeLog.retryTakeover()
  await r.rt.wakeLog.replayed
  const state = await r.state()
  assert.deepEqual(Object.values(state.tasks).map(task => task.status),
    ['done', 'failed', 'stopped', 'stopped', 'done'])
  assert.deepEqual(state.work.grants.map(row => row.id), [survivor])
  assert.equal(await r.replay('c'), 'allowed-once')
})

test('rfc0039 D4 A10 revocation stops replay and obeys the team lock [P]', async t => {
  const r = await bench(t)
  const first = await r.grant()
  // The owner API may revoke a grant; it cannot mint a ticket to make one.
  assert.equal((await r.request('grant-revoke', { id: first }, API)).ok, true)
  assert.equal((await r.request('grant-revoke', { id: first })).error.code, 'bot/stale')
  const second = await r.grant()
  t.mock.method(r.rt, 'holdsLock', () => false)
  assert.equal((await r.request('grant-revoke', { id: second })).error.code, 'bot/read-only')
})

test('rfc0039 D4 A11 runtime restart does not reload grants [P]', async t => {
  const r = await bench(t)
  await r.grant()
  await r.close()
  const restarted = await bench(t, { restart: r })
  try {
    assert.equal(restarted.home, r.home)
    assert.deepEqual((await restarted.state()).work.grants, [])
    const next = restarted.ask('t1')
    assert.equal((await restarted.held(next)).answerable, true)
  } finally {
    await restarted.close()
  }
})

test('rfc0039 D4 A12 never-auto with a key keeps its ordinary card [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const asking = r.ask('t1', { args: { ...STEP, command: 'rm -rf ' + r.folder + '/scratch' } })
  const card = await r.held(asking)
  assert.ok(card.capabilityKey)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
  await r.once(card, 'reject')
  assert.equal(await asking.answer, 'rejected')
})

test('rfc0039 D4 A12p a prerelease tag push cannot receive a grant [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const pending = r.pipeline('t1', { ...STEP, command: 'git push origin v1.2.3-rc.1' })
  const card = await r.held(pending)
  assert.ok(card.capabilityKey)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.once(card, 'reject')).ok, true)
  await pending.answer
  assert.deepEqual(r.steps, [])
})


test('rfc0039 D4 A12n version destinations keep their ordinary card [P]', async t => {
  const r = await bench(t)
  await r.grant()
  for (const ref of ['refs/heads/v1.2.3-rc.1', 'feat/x:refs/heads/v2-beta', '+v1',
    'refs/heads/"v3-beta"', '--tags', '--follow-tags']) {
    const args = { ...STEP, command: 'git -C . push origin ' + ref }
    const pending = r.pipeline('t1', args)
    const card = await r.held(pending)
    assert.ok(card.capabilityKey, ref)
    assert.equal(card.grantable, undefined, ref)
    assert.equal((await r.once(card, 'reject')).ok, true, ref)
    await pending.answer
  }
  assert.deepEqual(r.steps, [])
})

test('rfc0039 D4 A12c ordinary rejection of a never-auto step stays available [C]', async t => {
  const r = await bench(t)
  const asking = r.ask('t1', { args: { ...STEP, command: 'rm -rf ' + r.folder + '/scratch' } })
  assert.equal((await r.once(await r.held(asking), 'reject')).ok, true)
  assert.equal(await asking.answer, 'rejected')
})

test('rfc0039 D4 A14 extra arguments that change scope prevent a grant key [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const asking = r.ask('t1', { args: { ...STEP, workdir: r.otherFolder } })
  const card = await r.held(asking)
  assert.equal(card.capabilityKey, undefined)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
})

test('rfc0039 D4 A14c an ungrouped ask is still answerable [C]', async t => {
  const r = await bench(t)
  const asking = r.ask('t1', { args: { ...STEP, workdir: r.otherFolder } })
  assert.equal((await r.once(await r.held(asking))).ok, true)
  assert.equal(await asking.answer, 'allowed-once')
})

test('rfc0039 D4 A15 a reused call key cannot match or offer a grant [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const task = r.opened.get('t1')
  for (const mode of ['result', 'overlap', 'malformed']) {
    const callId = r.start('t1', { args: mode === 'malformed' ? '[]' : STEP })
    if (mode === 'result') {
      task.append('tool/result', { callId,
        message: { id: 'result', role: 'tool', toolCallId: callId, content: [],
          source: { kind: 'tool', callId } },
      }, { surfaceOp: 'append' })
    }
    r.start('t1', { callId })
    const asking = r.ask('t1', { callId })
    const card = await r.held(asking)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card)).ok, true)
    assert.equal(await asking.answer, 'allowed-once')
  }
  assert.equal((await r.state()).work.grants[0].uses, 0)
})

test('rfc0039 D4 A16 event changes end grants and Auto review takes precedence [P]', async t => {
  const r = await bench(t)
  await r.grant('a')
  let reviewed = 0
  const llm = r.ctx.get('llm')
  llm.stream = async function* () {
    reviewed++
    yield { type: 'text-delta', index: 0,
      text: '{"risk":"high","decision":"deny","reason":"review fixture"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await r.ctx.plugin(reviewer)
  await immediate()
  const session = r.opened.get('a')
  r.presets.set(session, 'auto')
  assert.equal(r.presets.current(session), 'auto')
  session.append('request/header', { header: { config: ROUTE,
    tools: r.ctx.get('tools').schemas(r.agents.get('a')) }, reason: 'epoch' })
  const ask = r.pipeline('a', STEP, 'bash', { review: true })
  const card = await r.held(ask)
  assert.equal(reviewed, 1)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.state()).work.grants.length, 0)
  assert.equal((await r.once(card, 'reject')).ok, true)
  await ask.answer
  assert.deepEqual(r.steps, [])
})

test('rfc0039 D4 A17 invisible marks keep the task grouping key [P]', async t => {
  const r = await bench(t)
  await r.grant()
  for (const mark of ['\u202e', '\u034f']) {
    const args = { ...STEP, command: 'echo s' + mark + 'afe' }
    const first = await r.held(r.ask('t1', { args }))
    const second = await r.held(r.ask('t1', { args }))
    assert.ok(first.capabilityKey)
    assert.equal(first.capabilityKey, second.capabilityKey)
    assert.equal(first.grantable, undefined)
    assert.equal(second.grantable, undefined)
  }
})

test('rfc0039 D4 A17b two reasons produce different keys for identical calls [P]', async t => {
  const r = await bench(t)
  const first = await r.held(r.ask('t1', { reason: 'First reason' }))
  const second = await r.held(r.ask('t1', { reason: 'Second reason' }))
  assert.equal(first.grantable, true)
  assert.equal(second.grantable, true)
  assert.ok(first.capabilityKey)
  assert.notEqual(first.capabilityKey, second.capabilityKey)
})

test('rfc0039 D4 A18 only the pinned shell executors can acquire grants [P]', async t => {
  const r = await bench(t)
  await r.grant()
  for (const [tool, args] of [['read', { path: r.folder + '/example.txt' }],
    ['read', { path: 'relative' }], ['read_image', { path: r.folder + '/image.png' }],
    ['browser_open', { url: 'https://example.test' }], ['mcp__dsh__send', { path: r.folder }]]) {
    const card = await r.held(r.ask('t1', { tool, args }))
    assert.equal(card.grantable, undefined)
    assert.equal((await r.allow(card)).error.code, 'bot/refused')
  }
})

test('rfc0039 D4 A19 bridge metadata rules out a native-looking shell ask [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const bridged = r.ask('t1', { bridgeCall: { id: 'sandbox-mirror' } })
  const card = await r.held(bridged)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
  assert.equal((await r.once(card)).ok, true)
  assert.equal(await bridged.answer, 'allowed-once')
  assert.equal(await r.replay('t1'), 'allowed-once')
})

test('rfc0039 D4 A20 DSH folder away and back ends shell grants [P]', async t => {
  const r = await bench(t)
  await r.grant('a')
  const survivor = await r.grant('seat')
  const before = r.start('a')
  const session = r.opened.get('a')
  for (const cwd of [r.otherFolder, r.folder]) session.append('working-directory/change', { cwd })
  const pending = r.ask('a', { callId: before })
  assert.equal((await r.held(pending)).grantable, undefined)
  assert.equal((await r.held(r.ask('a'))).folder, r.folder)
  assert.equal(await r.replay('seat'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 A20w no reported folder means an ordinary shell ask [P]', async t => {
  const r = await bench(t)
  const positive = await r.held(r.ask('t1'))
  assert.equal(positive.grantable, true)
  const original = r.wd.get.bind(r.wd)
  t.mock.method(r.wd, 'get', session => session.id === 't2' ? undefined : original(session))
  const card = await r.held(r.ask('t2'))
  assert.ok(card.capabilityKey)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
})

test('rfc0039 D4 A20t team workspace away and back ends shell grants [P]', async t => {
  const r = await bench(t)
  await r.grant()
  for (const path of [r.otherFolder, r.folder]) {
    const result = await r.request('team-workspace', { path })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  assert.equal((await r.held(r.ask('t1'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants, [])
})

test('rfc0039 D4 A21 persistent Bash registration prevents a shell grant [P]', async t => {
  const r = await bench(t)
  const original = await r.held(r.ask('t1'))
  assert.equal(original.grantable, true)
  // The registration itself blocks grants, even before a terminal backend is composed.
  const scoped = r.agents.get('t2').ctx
  const persistent = await scoped.plugin(persistentBash)
  try {
    assert.notEqual(r.ctx.get('tools').get('bash', r.agents.get('t2')),
      r.ctx.get('tools').get('bash'))
    assert.equal((await r.allow(original)).error.code, 'bot/refused')
    const card = await r.held(r.ask('t2'))
    assert.equal(card.grantable, undefined)
    assert.equal((await r.allow(card)).error.code, 'bot/refused')
  } finally { await persistent.dispose() }
  assert.ok(await r.grant('t3'))
})

test('rfc0039 D4 W1 the browser can create a grant [P]', async t => {
  assert.ok(await (await bench(t)).grant())
})

test('rfc0039 D4 W1D the desktop marker works without connection admission [P]', async t => {
  const r = await bench(t, { desktop: true })
  const card = await r.held(r.ask('t1'))
  assert.equal(card.grantable, true)
  assert.equal((await r.allow(card, {})).error.code, 'bot/refused')
  assert.equal((await r.allow(card)).ok, true)
})

test('rfc0039 D4 W1K a browser admitted by pinned connection can create a grant [P]', async t => {
  assert.ok(await (await bench(t, { pinnedConnection: true })).grant())
})

test('rfc0039 D4 K1 pinned connection keeps browser and credential peers apart [C]', async t => {
  const r = await bench(t, { pinnedConnection: true })
  const connection = r.ctx.get('connection')
  const request = headers => new Request(DOMAIN + '/api/omni-ui', { headers })
  assert.equal(connection.admit(request(r.person)).peer, connection.browserPeer)
  assert.equal(connection.admit(request({ ...API, host: r.person.host })).rejection, 401)
})

test('rfc0039 D4 W2 an owner API peer cannot grant the persons pending ask [P]', async t => {
  const r = await bench(t)
  const card = await r.held(r.ask('t1'))
  assert.equal((await r.allow(card, API)).error.code, 'bot/refused')
  assert.equal((await r.state()).work.approvals[0].id, card.id)
  assert.equal((await r.allow(card)).ok, true)
})

test('rfc0039 D4 W2t the same id with a stale token is refused [P]', async t => {
  const r = await bench(t)
  const first = await r.held(r.ask('t1'))
  const other = await r.held(r.ask('t2'))
  assert.equal((await r.allow({ ...first, offer: other.offer })).error.code, 'bot/refused')
  assert.equal((await r.allow(first)).ok, true)
})

test('rfc0039 D4 W2r a rejected or throwing admission leaves the ask open [P]', async t => {
  const r = await bench(t)
  const asking = r.ask('t1')
  const card = await r.held(asking)
  for (const headers of [{}, { 'x-test-admission-error': 'true' }]) {
    assert.equal((await r.allow(card, headers)).error.code, 'bot/refused')
  }
  assert.equal((await r.cardOf(asking.key)).id, card.id)
  assert.equal((await r.allow(card)).ok, true)
})

test('rfc0039 D4 W3b a lockless host refuses a live offer [P]', async t => {
  const r = await bench(t)
  const card = await r.held(r.ask('t1'))
  assert.equal(card.grantable, true)
  t.mock.method(r.rt, 'holdsLock', () => false)
  assert.equal((await r.allow(card)).error.code, 'bot/read-only')
})

test('rfc0039 D4 W4 extra fields in a grant request are invalid [P]', async t => {
  const r = await bench(t)
  const card = await r.held(r.ask('t1'))
  const { id, offer } = card
  assert.equal((await r.request('grant-approval', { id, offer, choice: 'allow' })).error.code,
    'bot/invalid')
  assert.equal((await r.allow(card)).ok, true)
})

test('rfc0039 D4 E8 leaving a group drops just that seat grant [P]', async t => {
  const r = await bench(t)
  await r.grant('seat')
  const unaffected = await r.grant('seat-other')
  const removed = await r.request('update-room', { id: 'r', remove: ['a'] })
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.equal(await r.replay('seat-other'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [unaffected])
})


test('rfc0039 D4 E9 group level changes end inherited grants selectively [P]', async t => {
  const r = await bench(t, { tasks: {
    t1: { from: 'a', levelRoomId: 'r', status: 'working', title: 'Inherits room', at: Date.now() },
  } })
  await r.grant()
  const survivor = await r.grant('t2')
  for (const permission of ['read-only', 'workspace-write']) {
    const result = await r.request('update-room', { id: 'r', permission })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  assert.equal((await r.held(r.ask('t1'))).grantable, true)
  assert.equal(await r.replay('t2'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 E11 only a committed DSH archive ends a Session grant [P]', async t => {
  const r = await bench(t, { workspace: true })
  await r.grant('a')
  const survivor = await r.grant('b')
  const registry = r.ctx.get('workspaceRegistry')
  const dispose = r.ctx.on('workspace/session-activity', ({ sessionId }, next) =>
    sessionId === 'a' ? ['active fixture chat'] : next(), { prepend: true })
  try {
    await assert.rejects(registry.archiveSession('a'), { name: 'WorkspaceActiveSessionError' })
    assert.equal(await r.replay('a'), 'allowed-once')
  } finally { dispose() }
  await registry.archiveSession('a')
  await registry.unarchiveSession('a')
  const chat = r.opened.get('a')
  chat.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  r.turn(chat, 2)
  assert.equal((await r.held(r.ask('a'))).grantable, true)
  assert.equal(await r.replay('b'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 R1 two windows cannot answer the same offer twice [P]', async t => {
  const r = await bench(t)
  const asking = r.ask('t1')
  const card = await r.held(asking)
  const results = await Promise.all([r.allow(card), r.allow(card)])
  assert.equal(results.filter(result => result.value?.grantId).length, 1)
  assert.equal(results.filter(result => result.error?.code === 'bot/stale').length, 1)
  assert.equal(await asking.answer, 'allowed-once')
  assert.equal((await r.state()).work.grants.length, 1)
})

test('rfc0039 D4 R3 an end before DSH decides returns allowed once only [P]', async t => {
  const r = await bench(t)
  const seen = Promise.withResolvers()
  const gate = Promise.withResolvers()
  r.ctx.on('approval/request', async (_request, next) => {
    const outcome = await next()
    seen.resolve()
    await gate.promise
    return outcome
  }, { prepend: true })
  try {
    const asking = r.ask('t1')
    const card = await r.held(asking)
    assert.equal(card.grantable, true)
    const result = r.allow(card)
    await seen.promise
    r.opened.get('t1').append('working-directory/change', { cwd: r.otherFolder })
    gate.resolve()
    assert.equal(await asking.answer, 'allowed-once')
    assert.deepEqual(await result, { ok: true, value: { allowedOnce: true } })
    assert.deepEqual((await r.state()).work.grants, [])
  } finally { gate.resolve() }
})

test('rfc0039 D4 R6 a changed offer is refused without answering its card [P]', async t => {
  const r = await bench(t)
  const ask = r.ask('t1')
  const card = await r.held(ask)
  assert.equal(card.grantable, true)
  r.opened.get('t1').append('working-directory/change', { cwd: r.otherFolder })
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
  assert.equal((await r.once(card)).ok, true)
  assert.equal(await ask.answer, 'allowed-once')
})

test('rfc0039 D4 R6c an ordinary answer survives a folder change [C]', async t => {
  const r = await bench(t)
  const ask = r.ask('t1')
  const card = await r.held(ask)
  r.opened.get('t1').append('working-directory/change', { cwd: r.otherFolder })
  assert.equal((await r.once(card)).ok, true)
  assert.equal(await ask.answer, 'allowed-once')
})

test('rfc0039 D4 P1 an ineligible group ask keeps ordinary event fields [C]', async t => {
  const r = await bench(t)
  const pending = r.ask('seat', { tool: 'message_bot', args: { message: 'hello' } })
  const card = await r.held(pending)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await pending.answer, 'rejected')
  assert.deepEqual(r.records.map(row => row.kind), ['open', 'settled'])
  assert.deepEqual(Object.keys(r.records[1]).sort(), ['at', 'decidedBy', 'id', 'kind', 'outcome'])
})

test('rfc0039 D4 P2 Bash side arguments stay out of D4 projections [P]', async t => {
  const r = await bench(t)
  const sentinel = 1973917351
  const args = { ...STEP, timeout_ms: sentinel }
  const first = r.pipeline('t1', args)
  const card = await r.held(first)
  assert.equal(card.grantable, true)
  assert.equal((await r.allow(card)).ok, true)
  await first.answer
  await r.pipeline('t1', args).answer
  assert.equal(r.steps.length, 2)
  assert.ok(r.ledger.some(row => row.type === 'tool/call'
    && String(row.data.arguments).includes(String(sentinel))))
  const state = await r.state()
  assert.equal(state.work.grants[0].uses, 1)
  assert.equal(r.rt.autoAuditRows().filter(row => row.code === 'person-grant').length, 1)
  for (const rows of [r.rt.grantsView(), state.work.grants, r.records, r.rt.autoAuditRows()]) {
    assert.ok(!JSON.stringify(rows).includes(String(sentinel)))
  }
})

test('rfc0039 D4 P3 a sandbox object is omitted from the open projection [P]', async t => {
  const r = await bench(t)
  for (const mode of [{ private: 'sandbox marker' }, 'unknown-mode']) {
    const args = { ...STEP, sandbox_permissions: mode }
    const pending = r.ask('t1', { args })
    const card = await r.held(pending)
    assert.equal(card.shownTarget, STEP.command)
    assert.equal(Object.hasOwn(card, 'sandboxMode'), false)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
  }
})

test('rfc0039 D4 A22 dispatch middleware cannot replay a different command [P]', async t => {
  const r = await bench(t)
  const original = r.pipeline('t1')
  assert.equal((await r.allow(await r.held(original))).ok, true)
  await original.answer
  const command = 'echo rewritten'
  r.ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'bash') exec.arguments = { ...exec.arguments, command }
    return next()
  }, { prepend: true })
  const pending = r.pipeline('t1')
  const card = await r.held(pending)
  assert.equal(card.grantable, undefined)
  const logged = r.ledger.find(row => row.type === 'tool/call' && row.data.callId === pending.key)
  assert.equal(JSON.parse(logged.data.arguments).command, STEP.command)
  assert.equal((await r.once(card)).ok, true)
  await pending.answer
  assert.deepEqual(r.steps.map(step => step.command), [STEP.command, command])
  assert.equal((await r.state()).work.grants[0].uses, 0)
})


test('rfc0039 D4 A22i dispatch requires the frozen arguments by identity [P]', async t => {
  const r = await bench(t)
  const args = { ...STEP, timeout_ms: [{ lines: ['private'] }] }
  const id = await r.grant('t1', { args })
  let exec
  let replace = false
  r.ctx.on('tools/execute', (current, next) => {
    exec = current
    assert.notEqual(exec.arguments, args)
    assert.ok(Object.isFrozen(exec.arguments.timeout_ms[0].lines))
    if (replace) exec.arguments = structuredClone(exec.arguments)
    return next()
  })
  const offered = r.ask('t1', { args: { ...args, command: 'echo other' } })
  const card = await r.held(offered)
  assert.equal(card.grantable, true)
  exec.arguments = structuredClone(exec.arguments)
  assert.equal((await r.allow(card)).error.code, 'bot/refused')
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await offered.answer, 'rejected')

  replace = true
  const pending = r.ask('t1', { args })
  const ordinary = await r.held(pending)
  assert.equal(ordinary.grantable, undefined)
  assert.equal((await r.once(ordinary, 'reject')).ok, true)
  assert.equal(await pending.answer, 'rejected')
  assert.deepEqual((await r.state()).work.grants.map(row => [row.id, row.uses]), [[id, 0]])
})

test('rfc0039 D4 A23 a scoped replacement cannot replay after unregistering [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const agent = r.agents.get('t1')
  const tools = agent.ctx.get('tools')
  const native = tools.get('bash')
  const outcome = Promise.withResolvers()
  const unregister = tools.register({
    ...native,
    async execute(_args, exec) {
      unregister()
      await immediate()
      assert.equal(tools.executable('bash', agent), native)
      outcome.resolve(await r.approval.request({
        agent, toolName: exec.name, callId: exec.callId, reason: REASON, signal: exec.signal,
      }))
      return { content: [] }
    },
  })
  const pending = r.pipeline('t1')
  const card = await r.held(pending)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.once(card, 'reject')).ok, true)
  await pending.answer
  assert.equal(await outcome.promise, 'rejected')
  assert.equal((await r.state()).work.grants[0].uses, 0)
})

test('rfc0039 D4 A17p blank filename characters keep the ordinary card [P]', async t => {
  const r = await bench(t)
  await r.grant()
  for (const blank of ['\u2800', '\u3164', '\uffa0', '\u115f', '\u1160']) {
    const pending = r.pipeline('t1', { ...STEP, command: 'ls ./file' + blank + '.txt' })
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    await pending.answer
  }
  assert.deepEqual(r.steps, [])
})

test('rfc0039 D4 R2p Pocket and the window decide the same request once [P]', async t => {
  const r = await bench(t, { pocket: true })
  for (const [choice, phoneFirst] of [
    ['allow', true], ['deny', true], ['allow', false], ['deny', false],
  ]) {
    const pending = r.pipeline('a')
    const card = await r.held(pending)
    assert.equal(card.grantable, true)
    const phone = r.pocket.events.find(event => event.type === 'approval'
      && event.row.open && event.row.call === pending.key)
    assert.ok(phone?.row.answerable)
    const asked = r.ledger.find(event => event.type === 'approval/asked'
      && event.data.callId === pending.key)
    assert.ok(asked?.data.id)
    const answer = () => r.pocket.answer({ row: phone.row.id, choice })
    const expected = phoneFirst && choice === 'deny' ? 'rejected' : 'allowed-once'
    let grantId
    if (phoneFirst) {
      assert.equal((await answer()).ok, true)
      assert.equal((await r.allow(card)).error.code, 'bot/stale')
    } else {
      const result = await r.allow(card)
      grantId = result.value?.grantId
      assert.ok(grantId, JSON.stringify(result))
      const late = await answer()
      assert.equal(late.reason, 'settled')
      assert.equal(late.receipt.by, 'computer')
    }
    const result = (await pending.answer).results[0].result
    assert.equal(result.isError === true, expected === 'rejected')
    const receipt = r.pocket.events.find(event => event.type === 'approval'
      && event.row.id === phone.row.id && !event.row.open)?.row.receipt
    assert.equal(receipt?.by, phoneFirst ? 'phone' : 'computer')
    assert.deepEqual(r.ledger.filter(event => event.type === 'approval/decided'
      && event.data.id === asked.data.id).map(event => event.data.outcome), [expected])
    const grants = r.records.filter(row => row.kind === 'grant' && row.requestId === asked.data.id)
    assert.deepEqual(grants.map(row => [row.decidedBy, row.grantId]),
      phoneFirst ? [] : [['web', grantId]])
    assert.deepEqual((await r.state()).work.grants.map(row => row.id), phoneFirst ? [] : [grantId])
    if (grantId) assert.equal((await r.request('grant-revoke', { id: grantId })).ok, true)
  }
})


test('rfc0039 D4 R2o Pocket wins after the public window claim [P]', async t => {
  const claimed = Promise.withResolvers()
  const release = Promise.withResolvers()
  const r = await bench(t, { pocket: true, async pocketGate(_request, next) {
    const outcome = await next()
    claimed.resolve(outcome)
    await release.promise
    return outcome
  } })
  const pending = r.pipeline('a')
  const card = await r.held(pending)
  assert.equal(card.grantable, true)
  const phone = r.pocket.events.find(event => event.type === 'approval'
    && event.row.open && event.row.call === pending.key)
  const asked = r.ledger.find(event => event.type === 'approval/asked'
    && event.data.callId === pending.key)
  assert.ok(phone?.row.answerable)
  assert.ok(asked?.data.id)
  const window = r.allow(card)
  try {
    assert.equal(await claimed.promise, 'allowed-once')
    assert.ok(r.records.some(row => row.kind === 'settled' && row.id === card.id
      && row.decidedBy === 'web'), 'the window completed its local claim')
    assert.equal(r.ledger.some(event => event.type === 'approval/decided'
      && event.data.id === asked.data.id), false)
    assert.equal((await r.pocket.answer({ row: phone.row.id, choice: 'allow' })).ok, true)
    const result = await window
    assert.equal(result.value?.grantId, undefined)
    assert.equal(result.error?.code, 'bot/stale')
    assert.equal((await pending.answer).results[0].result.isError === true, false)
  } finally { release.resolve() }

  const receipt = r.pocket.events.find(event => event.type === 'approval'
    && event.row.id === phone.row.id && !event.row.open)?.row.receipt
  assert.equal(receipt?.by, 'phone')
  assert.equal(receipt.outcome, 'allow')
  assert.deepEqual(r.ledger.filter(event => event.type === 'approval/decided'
    && event.data.id === asked.data.id).map(event => event.data.outcome), ['allowed-once'])
  assert.deepEqual((await r.state()).work.grants, [])
  assert.equal(r.records.some(row => row.kind === 'grant'), false)
})

test('rfc0039 D4 A6b another owner changing route leaves this grant active [P]', async t => {
  const r = await bench(t)
  const kept = await r.grant('a')
  await r.grant('b')
  const other = r.opened.get('b')
  other.append('model/selection', { ...ROUTE, model: 'v5' })
  r.routeTo(other, { ...ROUTE, model: 'v5' })
  assert.equal(await r.replay('a'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => [row.id, row.uses]), [[kept, 1]])
})


test('rfc0039 D4 A6m real model changes hold grants through saves and restores [P]', async t => {
  const r = await bench(t, { models: [{ id: 'v4' }, { id: 'v5' }] })
  const bot = r.rt.botOf('a')
  const chat = r.opened.get('a')
  chat.append('assistant/message', { turn: 1, step: 0, stream: [],
    message: { id: 'first-answer', role: 'assistant', source: { kind: 'model', ...ROUTE },
      content: [{ type: 'text', text: 'First answer' }] },
  }, { surfaceOp: 'append' })
  assert.equal(bot.previousModel, 'deepseek/v4')
  const survivor = await r.grant('t3')
  const apply = r.ctx.get('sessionController')
  const selectModel = apply.selectModel
  const save = r.rt.save
  const applyModel = r.rt.applyModel
  const rename = r.ctx.get('sessionTitle')
  let pauseSave
  let pauseRestore
  let automatic = false
  let restored = false
  let refuseRename = false
  t.mock.method(r.rt, 'applyModel', async (...args) => {
    const result = await applyModel(...args)
    if (automatic && args[0] === bot) restored = true
    return result
  })
  t.mock.method(r.rt, 'save', async (...args) => {
    if (pauseSave?.when()) await pauseSave.wait()
    return save(...args)
  })
  t.mock.method(apply, 'selectModel', async input => {
    if (pauseRestore && input.sessionId === 'a' && input.model === 'v5') {
      await pauseRestore.wait()
      throw new Error('fixture restore refused')
    }
    return selectModel(input)
  })
  t.mock.method(rename, 'rename', async () => {
    if (refuseRename) throw new Error('fixture rename refused')
  })
  const pause = when => {
    const gate = Promise.withResolvers()
    let entered = false
    return { when, release: gate.resolve, entered: () => entered,
      wait() { entered = true; return gate.promise } }
  }
  const offer = async () => {
    const card = await r.held(r.ask('t1', { args: { ...STEP, command: 'echo another' } }))
    assert.equal(card.grantable, true)
    return card
  }
  const probe = async (held, offered) => {
    await until(held.entered, { ms: 1800, poll: immediate })
    assert.equal((await r.allow(offered)).error.code, 'bot/refused')
    assert.equal((await r.once(offered, 'reject')).ok, true)
    const pending = r.ask('t1')
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
  }
  const onlySurvivor = async () => {
    assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
  }

  await r.grant('t1')
  const beforeSwitch = await offer()
  pauseSave = pause(() => bot.appliedModel === 'deepseek/v5')
  const changing = r.request('update-bot', { id: 'a', model: 'deepseek/v5' })
  try { await probe(pauseSave, beforeSwitch) } finally { pauseSave.release() }
  assert.equal((await changing).ok, true)
  assert.equal(bot.appliedModel, 'deepseek/v5')
  await onlySurvivor()

  await r.grant('t1')
  const beforeRefusal = await offer()
  refuseRename = true
  pauseRestore = pause()
  const refused = r.request('update-bot', { id: 'a', model: 'deepseek/v4', name: 'New Ada' })
  try { await probe(pauseRestore, beforeRefusal) } finally { pauseRestore.release() }
  assert.equal((await refused).ok, false)
  assert.equal(bot.appliedModel, 'deepseek/v5')
  await onlySurvivor()

  await r.grant('t1')
  const beforeAutomatic = await offer()
  pauseRestore = undefined
  automatic = true
  pauseSave = pause(() => bot.model === 'deepseek/v4' && bot.appliedModel === 'deepseek/v5')
  chat.append('turn/end', { turn: 1, reason: { kind: 'error',
    error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'fixture first call failed' } } })
  try { await probe(pauseSave, beforeAutomatic) } finally { pauseSave.release() }
  await until(() => restored, { ms: 1800, poll: immediate })
  assert.equal(bot.appliedModel, 'deepseek/v4')
  const fresh = await r.held(r.ask('t1'))
  assert.equal(fresh.grantable, true)
  assert.equal(await r.replay('t3'), 'allowed-once')
  await onlySurvivor()
})

test('rfc0039 D4 A6r a refused model route holds the whole team through the save [P]',
  async t => {
    const r = await bench(t)
    await r.grant()
    const save = r.rt.save
    const entered = Promise.withResolvers()
    const gate = Promise.withResolvers()
    t.mock.method(r.rt, 'save', async (...args) => {
      if (r.rt.botOf('b').model !== 'deepseek/v4') {
        entered.resolve()
        await gate.promise
      }
      return save(...args)
    })
    const chat = r.opened.get('b')
    try {
      chat.append('turn/end', { turn: 1, reason: { kind: 'error',
        error: { code: 'HOSTED_ENGINE_ROUTE', message: 'fixture route refusal' } } })
      let saving = false
      void entered.promise.then(() => { saving = true })
      await until(() => saving, { ms: 1600, poll: immediate })
      const ask = r.ask('t1')
      const card = await r.held(ask)
      assert.equal(card.grantable, undefined)
      assert.equal((await r.once(card, 'reject')).ok, true)
      assert.equal(await ask.answer, 'rejected')
    } finally { gate.resolve() }
    assert.deepEqual((await r.state()).work.grants, [])
  })

test('rfc0039 D4 A7x changing a parent level ends another Bot descendant grant [P]', async t => {
  const r = await bench(t, { tasks: {
    t3: { from: 'b', title: 'Child task', status: 'working', at: Date.now(), levelTaskId: 't1' },
  } })
  await r.grant('t3')
  const kept = await r.grant('c')
  for (const permission of ['read-only', 'workspace-write']) {
    const result = await r.request('update-bot', { id: 'a', permission })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  assert.equal((await r.held(r.ask('t3'))).grantable, true)
  assert.equal(await r.replay('c'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [kept])
})

test('rfc0039 D4 A7d failed parent deletion ends a different Bot descendant grant [P]',
  async t => {
    const r = await bench(t, { tasks: {
      parent: { from: 'b', title: 'Parent task', status: 'working', at: Date.now() },
      t1: { from: 'a', title: 'Child task', status: 'working', at: Date.now(),
        levelTaskId: 'parent' },
    } })
    r.open('parent')
    await immediate()
    await r.grant()
    const kept = await r.grant('c')
    const reached = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.mock.method(r.rt, 'releaseBot', async () => {
      reached.resolve()
      await release.promise
      throw new Error('fixture release failure')
    })
    const removal = r.request('delete-bot', { id: 'b' })
    try {
      await Promise.race([reached.promise, removal.then(result => {
        assert.fail('deletion did not reach release: ' + JSON.stringify(result))
      })])
      const ask = r.ask('t1')
      const card = await r.held(ask)
      assert.equal(card.grantable, undefined)
      assert.equal((await r.once(card, 'reject')).ok, true)
    } finally { release.resolve() }
    assert.equal((await removal).ok, false)
    assert.equal((await r.held(r.ask('t1'))).grantable, true)
    assert.equal(await r.replay('c'), 'allowed-once')
    assert.deepEqual((await r.state()).work.grants.map(row => row.id), [kept])
  })

test('rfc0039 D4 A20b Bot and group folder changes end only reachable grants [P]', async t => {
  const r = await bench(t)
  await r.grant('t1')
  await r.grant('seat-b')
  const kept = await r.grant('c')
  for (const workDir of [r.otherFolder, r.folder]) {
    const bot = await r.request('update-bot', { id: 'a', workDir })
    assert.equal(bot.ok, true, JSON.stringify(bot))
    const room = await r.request('update-room', { id: 'r', workDir })
    assert.equal(room.ok, true, JSON.stringify(room))
  }
  assert.equal(await r.replay('c'), 'allowed-once')
  assert.equal((await r.held(r.ask('t1'))).grantable, true)
  assert.equal((await r.held(r.ask('seat-b'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [kept])
})

test('rfc0039 D4 A20c the working directory tool ends the member seat grant [P]', async t => {
  const r = await bench(t)
  await r.grant('seat')
  const kept = await r.grant('seat-other')
  for (const cd of [r.otherFolder, r.folder]) {
    const call = r.pipeline('seat', { cd }, 'working_directory')
    // Moving outside the shared workspace asks first. The return to it needs no approval.
    if (cd === r.otherFolder) {
      const card = await r.held(call)
      assert.equal((await r.once(card)).ok, true)
    }
    const result = await call.answer
    assert.equal(result.results[0].result.isError, false, JSON.stringify(result.results[0]))
  }
  assert.equal(await r.replay('seat-other'), 'allowed-once')
  assert.equal((await r.held(r.ask('seat'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [kept])
})

test('rfc0039 D4 A20p folder grants stay held until the switch settles [P]', async t => {
  const r = await bench(t)
  await r.grant('a')
  const reached = Promise.withResolvers()
  const finish = Promise.withResolvers()
  r.agents.get('a').runMaintenance = async () => {
    reached.resolve()
    await finish.promise
    throw new Error('fixture folder switch failed')
  }
  const follow = t.mock.method(r.rt, 'followFolder')
  const updated = await r.request('update-bot', { id: 'a', workDir: r.otherFolder })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  try {
    await reached.promise
    const pending = r.ask('a')
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
    assert.deepEqual((await r.state()).work.grants, [])
  } finally {
    finish.resolve()
  }
  await follow.mock.calls[0].result
  assert.equal((await r.held(r.ask('a'))).grantable, true)
})

test('rfc0039 D4 W3a a read-only host refuses a grant request before dispatch [C]', async t => {
  const r = await bench(t)
  const asking = r.ask('t1')
  const card = await r.held(asking)
  t.mock.method(r.rt, 'readOnly', () => 'Fixture lock holder')
  assert.equal((await r.allow(card)).error.code, 'bot/read-only')
  assert.equal((await r.once(card)).ok, true)
  assert.equal(await asking.answer, 'allowed-once')
})

test('rfc0039 D4 E3 reopening away and back keeps another owner grant [P]', async t => {
  const r = await bench(t)
  const branch = r.open('a-earlier')
  const other = await r.grant('seat-other')
  await r.grant('a')
  const bot = r.rt.botOf('a')
  bot.segments = [{ sessionId: branch.id, endedAt: Date.now() }]
  r.rt.indexSessions()
  const chat = r.opened.get('a')
  for (const session of [chat, branch]) {
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  for (const sessionId of [branch.id, 'a']) {
    const moved = await r.request('bot-open-part', { botId: 'a', sessionId })
    assert.equal(moved.ok, true, JSON.stringify(moved))
  }
  r.turn(chat, 2)
  assert.equal(await r.replay('seat-other'), 'allowed-once')
  assert.equal((await r.held(r.ask('a'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [other])
})

test('rfc0039 D4 A6v E2 E4 a revert holds the Bot and leaves another seat grant [P]', async t => {
  const r = await bench(t)
  await r.grant('a')
  const survivor = await r.grant('seat-other')
  const chat = r.opened.get('a')
  chat.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const archived = []
  t.mock.method(r.ctx.get('workspaceRegistry'), 'archiveSession', async id => { archived.push(id) })
  t.mock.method(r.rt, 'answersAside', () => false)
  t.mock.method(r.rt, 'createSession', async () => r.open('fresh').id)
  const result = await r.request('bot-new-part', { botId: 'a' })
  assert.equal(result.ok, true, JSON.stringify(result))
  await until(() => r.rt.chatOf('a') === 'fresh' && [...r.rt.switchJobs()].length === 0,
    { ms: 2500, poll: immediate })
  assert.equal(r.rt.awaitingFirstAnswer('fresh'), true)
  const fresh = r.opened.get('fresh')
  await r.grant('fresh')
  const save = r.rt.save
  const release = Promise.withResolvers()
  let saving = false
  t.mock.method(r.rt, 'save', async (...args) => {
    if (!saving && r.rt.chatOf('a') === 'a') {
      saving = true
      await release.promise
    }
    return save(...args)
  })
  try {
    fresh.append('turn/end', { turn: 1, reason: { kind: 'error',
      error: { code: 'AUTH', message: 'fixture model refused' } } })
    await until(() => saving, { ms: 2200, poll: immediate })
    const pending = r.ask('seat-other', { args: { ...STEP, command: 'echo new' } })
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
  } finally { release.resolve() }
  await until(() => archived.includes('fresh'), { ms: 2200, poll: immediate })
  await immediate()
  assert.equal(r.rt.chatOf('a'), 'a')
  r.turn(chat, 2)
  assert.equal(await r.replay('seat-other'), 'allowed-once')
  assert.equal((await r.held(r.ask('a'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 E6 and E7b rollback and re-adoption end the old grant [P]', async t => {
  const r = await bench(t)
  const session = r.open('native-chat')
  r.rt.state.agents.native = {
    id: 'native', name: 'Native fixture', kind: 'dsh', sessions: [session.id], createdAt: 1,
  }
  await r.rt.save()
  const adopt = () => r.request('agent-bot-adopt', { agentId: 'native' })
  const first = await adopt()
  assert.equal(first.ok, true, JSON.stringify(first))
  await r.grant(session.id)
  const survivor = await r.grant('c')
  const rollback = await r.request('agent-bot-rollback', { agentId: 'native' })
  assert.equal(rollback.ok, true, JSON.stringify(rollback))
  const again = await adopt()
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(await r.replay('c'), 'allowed-once')
  assert.equal((await r.held(r.ask(session.id))).grantable, true)
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 E5 a saved shell hold ends grants through restoration [P]', async t => {
  const r = await bench(t)
  await r.grant('a')
  const survivor = await r.grant('c')
  const bot = r.rt.botOf('a')
  bot.model = 'acp-codex/fixture'
  bot.shell = false
  await r.rt.save()
  assert.ok(bot.shellHeld)
  const ask = r.ask('a', { dispatch: false })
  const card = await r.held(ask)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await ask.answer, 'rejected')
  bot.model = 'deepseek/v4'
  delete bot.shell
  await r.rt.save()
  assert.equal(bot.shellHeld, undefined)
  assert.equal((await r.held(r.ask('a'))).grantable, true)
  assert.equal(await r.replay('c'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 E6c the host adapter restoring the first Session ends grants [P]', async t => {
  const r = await bench(t)
  const moved = r.open('moved')
  const bot = r.rt.botOf('a')
  Object.assign(bot, { kind: 'unfold', sessionId: moved.id,
    segments: [{ sessionId: 'a', endedAt: Date.now() }] })
  await r.rt.save()
  await r.grant(moved.id)
  const survivor = await r.grant('seat-other')
  r.ctx.provide('unfoldSession', { sessionId: 'a', ready: Promise.resolve() })
  const adapter = createUnfold(r.ctx, r.rt, {}, { AUTOMAGIK_HOST: 'unfold' })
  assert.equal((await adapter.unfoldReady)?.id, 'a')
  assert.equal(r.rt.chatOf('a'), 'a')
  assert.equal(await r.replay('seat-other'), 'allowed-once')
  assert.equal((await r.held(r.ask('a'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 E10a losing and reclaiming the real lock ends grants [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const lock = join(r.home, 'state.lock')
  unlinkSync(lock)
  await r.rt.refresh()
  assert.equal(r.rt.holdsLock(), true)
  assert.equal((await r.held(r.ask('t1'))).grantable, true)
  assert.deepEqual((await r.state()).work.grants, [])
})

test('rfc0039 D4 E10b a broken team lock invalidates a live grant offer [P]', async t => {
  const r = await bench(t)
  await r.grant()
  const ask = r.ask('t1', { args: { ...STEP, command: 'echo second' } })
  const card = await r.held(ask)
  assert.equal(card.grantable, true)
  const backup = r.home + '-backup'
  renameSync(r.home, backup)
  try {
    writeFileSync(r.home, 'Not a directory')
    await r.rt.refresh()
  } finally {
    unlinkSync(r.home)
    renameSync(backup, r.home)
  }
  assert.equal(r.rt.holdsLock(), false)
  assert.equal(r.rt.readOnly(), undefined)
  assert.equal((await r.allow(card)).error.code, 'bot/read-only')
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await ask.answer, 'rejected')
  assert.deepEqual((await r.state()).work.grants, [])
})

test('rfc0039 D4 E10p heartbeat loss ends grants and offers none after the lock returns [P]', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const r = await bench(t)
  await r.grant()
  const lock = join(r.home, 'state.lock')
  const backup = lock + '.saved'
  renameSync(lock, backup)
  try {
    t.mock.timers.tick(15_000)
  } finally {
    renameSync(backup, lock)
  }
  assert.equal(r.rt.holdsLock(), true)
  const pending = r.ask('t1')
  const card = await r.held(pending)
  assert.equal(card.grantable, undefined)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await pending.answer, 'rejected')
  assert.deepEqual((await r.state()).work.grants, [])
})


test('rfc0039 D4 E10o an observed lock loss ends grants before heartbeat [P]', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const r = await bench(t)
  await r.grant()
  const before = r.rt.teamGeneration()
  const lock = join(r.home, 'state.lock')
  const backup = lock + '.saved'
  renameSync(lock, backup)
  try {
    assert.equal(r.rt.holdsLock(), false)
    assert.equal(r.rt.teamGeneration().term, before.term + 1)
    assert.equal(r.rt.holdsLock(), false)
    assert.equal(r.rt.teamGeneration().term, before.term + 1)
  } finally { renameSync(backup, lock) }
  assert.equal(r.rt.holdsLock(), true)
  const pending = r.ask('t1')
  const card = await r.held(pending)
  assert.equal(card.grantable, true)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await pending.answer, 'rejected')
  assert.deepEqual((await r.state()).work.grants, [])
})

test('rfc0039 D4 A13 an authenticated agent tool cannot grant a pending id [C]', async t => {
  const r = await bench(t)
  const pending = r.ask('t1')
  const card = await r.held(pending)
  const secret = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(secret).digest('hex')
  writeFileSync(join(r.home, 'agent-tokens.json'), JSON.stringify([
    { id: 'fixture', name: 'Test agent', hash, createdAt: Date.now() },
  ]), { mode: 0o600 })
  const response = await r.rt.agentAccess.fetch(new Request(DOMAIN + '/api/omni-mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'grant-approval', arguments: { id: card.id } } }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).error, { code: -32602, message: 'Unknown tool' })
  assert.equal((await r.cardOf(pending.key)).id, card.id)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await pending.answer, 'rejected')
})

test('rfc0039 D4 A12w a git push is never grantable, wrapped or plain [P]', async t => {
  const r = await bench(t)
  await r.grant()
  for (const command of ["sh -c 'git push origin refs/heads/v1.2.3-rc.1'",
    'bash -c "git -C . push origin feat/x"', 'git push origin feat/x']) {
    const pending = r.pipeline('t1', { ...STEP, command })
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined, command)
    assert.equal((await r.once(card, 'reject')).ok, true, command)
    await pending.answer
  }
  assert.deepEqual(r.steps, [])
})

test('rfc0039 D4 A6g a Session model selection holds that Session until it settles [P]', async t => {
  const r = await bench(t, { models: [{ id: 'v4' }, { id: 'v5' }] })
  await r.grant('a')
  const survivor = await r.grant('b')
  const controller = r.ctx.get('sessionController')
  const selectModel = controller.selectModel
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  t.mock.method(controller, 'selectModel', async input => {
    if (input.sessionId === 'a' && input.model === 'v5') {
      entered.resolve()
      await gate.promise
    }
    return selectModel(input)
  })
  const selecting = r.rt.selectSessionModel('a', { ...ROUTE, model: 'v5' })
  try {
    await entered.promise
    const pending = r.ask('a')
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
    assert.equal(await r.replay('b'), 'allowed-once')
  } finally {
    gate.resolve()
  }
  await selecting.catch(() => {})
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 E9s a group level change holds the room until its save settles [P]', async t => {
  const r = await bench(t, { tasks: {
    t1: { from: 'a', levelRoomId: 'r', status: 'working', title: 'Inherits room', at: Date.now() },
  } })
  await r.grant()
  const save = r.rt.save
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  let pausing = true
  t.mock.method(r.rt, 'save', async (...args) => {
    if (pausing && r.rt.roomOf?.('r')?.permission === 'read-only') {
      pausing = false
      entered.resolve()
      await gate.promise
    }
    return save(...args)
  })
  const changing = r.request('update-room', { id: 'r', permission: 'read-only' })
  try {
    await entered.promise
    const pending = r.ask('t1')
    const card = await r.held(pending)
    assert.equal(card.grantable, undefined)
    assert.equal((await r.once(card, 'reject')).ok, true)
    assert.equal(await pending.answer, 'rejected')
  } finally {
    gate.resolve()
  }
  assert.equal((await changing).ok, true)
  assert.deepEqual((await r.state()).work.grants, [])
})
