// Native cold continuity (continuity.js, docs/research/t3-code-acp-integration.md
// recommendation 2) over real stdio: the fake agent keeps each session's native context in a
// state file, as a CLI's session store does, so a marker it was told to remember lives only
// there, never in DSH's transcript. A restart is a new adapter over the same DSH Session.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { NATIVE_RECORD, bindingOf, decide, latestNative } from '../src/host/continuity.js'
import { ROUTE, answer, of, send, synthetic, turn, user, withFixture } from './fixtures/continuity-world.js'

for (const how of ['resume', 'load']) {
  test(`a restart takes back the native session by ${how}: the agent remembers what only it was told, and nothing is replayed`, async () => {
    await withFixture(how, { env: how === 'resume' ? { FAKE_ACP_RESUME: '1' } : { FAKE_ACP_LOAD: '1' } }, async (h) => {
      await turn(h, 'native-remember m-42')
      const first = of(h, 'new-session')[0].sessionId
      const before = of(h, 'bridge-credential')[0].digest
      h.restart()
      const after = await turn(h, 'native-recall')
      assert.equal(after.finish.reason.kind, 'stop')
      assert.match(after.said, /I remember: m-42 \(turn 2\)/)
      assert.equal(of(h, 'new-session').length, 1, 'no new session after the restart')
      assert.deepEqual(of(h, `${how}-session`).map(event => [event.sessionId, event.servers]), [[first, ['dsh']]])
      // The session switches go again with the reattachment: without `disableBuiltInTools`
      // Claude Code's resumed session offers its own tools beside the bridge (real-backend.test.js).
      assert.deepEqual(of(h, `${how}-session`)[0].meta, { disableBuiltInTools: true })
      const prompt = of(h, 'prompt').at(-1).text
      assert.equal(prompt, 'native-recall', 'the chat is not replayed to a session that holds it')
      // A fresh bridge credential for the reattached session, never the old one.
      const credentials = of(h, 'bridge-credential').map(event => event.digest)
      assert.equal(credentials.length, 2)
      assert.notEqual(credentials[1], before)
      if (how === 'load') {
        // The loaded history is quarantined: its question is cancelled unseen, its text, call,
        // plan and usage reach neither the turn nor the chat's records.
        assert.deepEqual(of(h, 'replayed-permission').map(event => event.outcome), ['cancelled'])
        assert.equal(after.said.includes('earlier'), false)
        assert.equal(after.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
        const types = h.session.snapshotEvents().map(event => event.type)
        assert.equal(types.includes('plugin:acp-dsh/plan'), false)
        assert.equal(h.session.snapshotEvents().filter(event => event.type === 'plugin:acp-dsh/usage').some(event => event.data.context?.used === 999), false)
        assert.equal(h.counts.approvals, 0)
      }
      assert.ok(h.logs.some(line => line.includes(`native session ${how === 'load' ? 'loaded' : 'resumed'}`)), h.logs.join('\n'))
      synthetic({ initialize: 'passed', session: 'passed', reattach: 'passed', prompt: 'passed', continuity: 'passed' })
    })
  })
}

test('a removed tool stays unavailable and a newly offered one runs once, with one approval, after a resume', async () => {
  await withFixture('tools', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    await turn(h, 'list-bridge')
    const old = [...h.adapter.live.values()][0]?.bridge
    assert.ok(old?.credential, 'the first session had a bridge')
    h.restart()
    h.tools.names = ['bash', 'read_group_chat']
    const listed = await turn(h, 'list-bridge')
    assert.match(listed.said, /bridge tools: .*read_group_chat/)
    assert.equal(/\bwrite\b/.test(listed.said), false, listed.said)
    // The first process's credential no longer opens the bridge.
    const response = await fetch(h.backchannel.urlFor(old), { method: 'POST', headers: { authorization: `Bearer ${old.credential}` }, body: JSON.stringify({ op: 'list' }) })
    assert.ok(response.status >= 400, `old credential answered ${response.status}`)
    const before = { ...h.counts }
    const ran = await turn(h, 'bridge read_group_chat')
    assert.match(ran.said, /ran read_group_chat/)
    assert.equal(h.counts.executed - before.executed, 1)
    assert.ok(h.counts.approvals - before.approvals <= 1)
    assert.equal(of(h, 'new-session').length, 1)
  })
})

const replayed = h => /The chat so far, before this new Fake agent session:/.test(of(h, 'prompt').at(-1).text)

test('an agent that does not advertise resume or load gets a new session and the chat replayed', async () => {
  await withFixture('unadvertised', {}, async (h) => {
    await turn(h, 'native-remember m-1')
    h.restart()
    const after = await turn(h, 'native-recall')
    assert.match(after.said, /I remember: nothing/)
    assert.equal(of(h, 'new-session').length, 2)
    assert.ok(replayed(h))
    assert.ok(h.logs.some(line => line.includes('native session fresh (not-advertised)')))
  })
})

test('a route that is not qualified never asks to resume, whatever the agent advertises', async () => {
  await withFixture('unqualified', { env: { FAKE_ACP_RESUME: '1' }, route: null }, async (h) => {
    await turn(h, 'native-remember m-2')
    h.restart()
    await turn(h, 'native-recall')
    assert.equal(of(h, 'resume-session').length, 0)
    assert.equal(of(h, 'new-session').length, 2)
    assert.ok(replayed(h))
    assert.ok(h.logs.some(line => line.includes('starts a new session (route-not-qualified)')))
  })
})

test('a changed account, a changed Bot policy or an old chat with no binding starts fresh', async () => {
  let account = 'account-a'
  await withFixture('account', { env: { FAKE_ACP_RESUME: '1' }, account: () => account }, async (h) => {
    await turn(h, 'native-remember m-3')
    account = 'account-b'
    h.restart()
    const after = await turn(h, 'native-recall')
    assert.match(after.said, /nothing/)
    assert.equal(of(h, 'resume-session').length, 0)
    assert.ok(h.logs.some(line => line.includes('(binding-changed)')))
  })
  // The decision itself, for what the adapter computes into the digest.
  assert.deepEqual(decide({ route: { methods: ['resume'] }, record: undefined, digest: 'd' }), { skip: 'no-binding' })
  assert.deepEqual(decide({ route: { methods: ['resume'] }, record: { v: 1, nativeSessionId: 'n', digest: 'x', state: 'idle' }, digest: 'd' }), { skip: 'binding-changed' })
  assert.deepEqual(decide({ route: { methods: ['resume'] }, record: { v: 1, nativeSessionId: 'n', digest: 'd', state: 'sent', rows: ['r1', 'r2'] }, digest: 'd' }), { sessionId: 'n', methods: ['resume'], interrupted: true, rows: ['r1', 'r2'] })
  // An uncertain dispatch that cannot say which rows it carried is not taken back.
  for (const rows of [undefined, ['r1', null], 'r1']) assert.deepEqual(decide({ route: { methods: ['resume'] }, record: { v: 1, nativeSessionId: 'n', digest: 'd', state: 'sent', rows }, digest: 'd' }), { skip: 'uncertain-rows-unknown' })
  await withFixture('old-chat', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    // Answers from before this version: no native-session record anywhere in the log.
    h.messages.push(user('earlier'), answer('earlier answer'))
    await turn(h, 'native-recall')
    assert.equal(of(h, 'resume-session').length, 0)
    assert.ok(h.logs.some(line => line.includes('(no-binding)')))
    assert.ok(replayed(h))
  })
})

test('an unknown account, a terminal CLI with no Bot home, or a launch naming no build binds nothing', async () => {
  // Each fails closed: no native-session record is written, and the next start is fresh.
  for (const [name, options] of [
    ['no-account', { account: () => undefined }],
    ['terminal-cli', { home: () => ({}) }],
    ['no-build', { connector: () => ({}) }],
  ]) {
    await withFixture(name, { env: { FAKE_ACP_RESUME: '1' }, ...options }, async (h) => {
      await turn(h, 'native-remember m-9')
      assert.equal(h.session.snapshotEvents(0).some(event => event.type === 'plugin:acp-dsh/native-session'), false, name)
      h.restart()
      const after = await turn(h, 'native-recall')
      assert.match(after.said, /nothing/, name)
      assert.equal(of(h, 'resume-session').length, 0, name)
      assert.ok(h.logs.some(line => line.includes('(binding-unknown)')), name)
    })
  }
  assert.equal(bindingOf({ provider: 'p', dshSessionId: 's', connector: 'c', home: 'h', account: undefined, cwd: '/w', identity: 'i' }), undefined)
})

test('a new CLI home generation (a Reset or another sign-in) or another connector build starts fresh', async () => {
  for (const [name, change] of [['generation', 'home'], ['build', 'connector']]) {
    let generation = 'g1'
    let version = '1.0.0'
    await withFixture(name, {
      env: { FAKE_ACP_RESUME: '1' },
      home: () => ({ AUTOMAGIK_BOT_CLI_HOME: '/bot-home', AUTOMAGIK_BOT_CLI_GENERATION: generation, AUTOMAGIK_BOT_CLI_VERSION: '' }),
      connector: () => ({ version, key: `fake ${version}` }),
    }, async (h) => {
      await turn(h, 'native-remember m-10')
      if (change === 'home') generation = 'g2'
      else version = '1.0.1'
      h.restart()
      const after = await turn(h, 'native-recall')
      assert.match(after.said, /nothing/, name)
      assert.ok(h.logs.some(line => line.includes('(binding-changed)')), name)
    })
  }
})

test('a stale native id is refused by the agent: a new session on the same process, with the chat replayed', async () => {
  await withFixture('stale', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    await turn(h, 'native-remember m-4')
    rmSync(h.state)
    h.restart()
    const after = await turn(h, 'native-recall')
    assert.equal(after.finish.reason.kind, 'stop')
    assert.deepEqual(of(h, 'resume-session').map(event => event.found), [false])
    assert.equal(of(h, 'start').length, 2, 'the refusal is answered on the same process')
    assert.ok(replayed(h))
    assert.ok(h.logs.some(line => line.includes('native session fresh (refused)')))
  })
})

for (const [name, env, startMs] of [
  ['a resume that binds no bridge', { FAKE_ACP_RESUME: '1', FAKE_ACP_RESUME_IGNORES_SERVERS: '1' }, undefined],
  ['a resume nobody answers', { FAKE_ACP_RESUME: '1', FAKE_ACP_RESUME_HANG: '1' }, 1500],
]) {
  test(`${name} ends that process: a fresh one starts with a new bridge and the chat replayed`, async () => {
    await withFixture(name.split(' ').at(-1), { env, startMs }, async (h) => {
      await turn(h, 'native-remember m-5')
      h.restart()
      const after = await turn(h, 'native-recall')
      assert.equal(after.finish.reason.kind, 'stop', JSON.stringify(after.finish))
      assert.equal(of(h, 'resume-session').length, 1, 'asked once, never again on the fresh process')
      assert.equal(of(h, 'new-session').length, 2)
      assert.equal(of(h, 'start').length, 3)
      assert.ok(replayed(h))
      assert.ok(h.logs.some(line => line.includes('did not take back its native session')))
    })
  })
}

test('a prompt the agent may have acted on is never sent again after the restart', async () => {
  await withFixture('uncertain', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    await turn(h, 'native-remember m-6')
    const cut = await turn(h, 'exit-mid-prompt now')
    assert.notEqual(cut.finish.reason.kind, 'stop')
    assert.equal(latestNative(h.session, ROUTE)?.state, 'sent', 'the binding says the dispatch is uncertain')
    h.restart()
    const after = await turn(h, 'native-recall')
    assert.match(after.said, /m-6/)
    const prompt = of(h, 'prompt').at(-1).text
    assert.equal(prompt.includes('exit-mid-prompt'), false, prompt)
    assert.match(prompt, /may have partly run/)
    assert.equal(of(h, 'acted').length, 1, 'the interrupted action ran once')
    assert.equal(latestNative(h.session, ROUTE)?.state, 'idle')
  })
})

test('a Stop during the reattachment ends the turn as a Stop and leaves the binding for next time', async () => {
  await withFixture('stop', { env: { FAKE_ACP_RESUME: '1', FAKE_ACP_RESUME_HANG: '1' } }, async (h) => {
    await turn(h, 'native-remember m-7')
    h.restart()
    const stop = new AbortController()
    h.messages.push(user('native-recall'))
    const chunks = []
    const stream = h.adapter.stream(markAgentLoopRequest({ provider: ROUTE, model: 'default', sessionId: 's1', messages: h.messages, signal: stop.signal }))
    setTimeout(() => stop.abort(), 300)
    for await (const chunk of stream) chunks.push(chunk)
    assert.notEqual(chunks.at(-1).reason.kind, 'stop')
    assert.equal(of(h, 'new-session').length, 1, 'no fresh session is started after a Stop')
    assert.equal(h.session.snapshotEvents().filter(event => event.type === NATIVE_RECORD).at(-1).data.state, 'idle')
  })
})

test('a cancellation the app did not request leaves the prompt uncertain', async () => {
  await withFixture('agent-cancel', {}, async h => {
    await turn(h, 'native-remember m-1')
    await send(h, 'reviewer denies 0')
    assert.equal(latestNative(h.session, ROUTE)?.state, 'sent')
  })
})

test('a fresh connector can still roll back after a reattachment fails', async () => {
  await withFixture('fallback-rollback', { env: { FAKE_ACP_RESUME: '1' } }, async h => {
    await turn(h, 'native-remember m-1')
    h.restart()
    const spawn = h.spec.spawn
    let starts = 0
    let rollbacks = 0
    h.spec.spawn = () => {
      starts += 1
      if (starts === 2) throw new Error('new connector failed to launch')
      const launch = spawn()
      if (starts === 1) launch.env.FAKE_ACP_RESUME_HANG = '1'
      return launch
    }
    h.spec.startMs = 1200
    h.spec.rollback = () => { rollbacks += 1; return true }
    const after = await send(h, 'native-recall')
    assert.equal(after.finish.reason.kind, 'stop')
    assert.equal(rollbacks, 1)
    assert.equal(starts, 3)
  })
})

// An interrupted turn leaves no answer after the person's rows, so the next request carries
// them again, after any rows sent since: only those the uncertain prompt carried are held back.
test('an uncertain prompt of several rows is never sent again, across two crashes, and the rows after it are', async () => {
  let canSave = true
  await withFixture('uncertain-rows', { env: { FAKE_ACP_RESUME: '1' }, flush: async () => canSave }, async (h) => {
    await turn(h, 'native-remember m-8')
    const cut = await send(h, 'exit-mid-prompt first-instruction', 'and-also second-instruction')
    assert.notEqual(cut.finish.reason.kind, 'stop')
    const sent = latestNative(h.session, ROUTE)
    assert.equal(sent.state, 'sent')
    assert.deepEqual(sent.rows, h.messages.slice(-2).map(row => row.id), 'the record names exactly the rows that prompt carried')
    h.restart()
    // The retry after the restart: the same native session, the interrupted rows held back.
    canSave = false
    assert.equal((await send(h, 'retry after save')).finish.reason.kind, 'error')
    canSave = true
    const second = await send(h, 'exit-mid-prompt third-instruction')
    assert.notEqual(second.finish.reason.kind, 'stop')
    let prompt = of(h, 'prompt').at(-1).text
    for (const old of ['first-instruction', 'second-instruction']) assert.equal(prompt.includes(old), false, prompt)
    assert.match(prompt, /third-instruction/)
    assert.match(prompt, /may have partly run/)
    // That prompt crashed too: its record still names the first prompt's rows beside its own.
    assert.deepEqual(latestNative(h.session, ROUTE).rows, h.messages.slice(-4).map(row => row.id))
    h.restart()
    const after = await send(h, 'native-recall')
    assert.equal(after.finish.reason.kind, 'stop')
    assert.match(after.said, /m-8/, 'still the same native session')
    prompt = of(h, 'prompt').at(-1).text
    for (const old of ['first-instruction', 'second-instruction', 'third-instruction']) assert.equal(prompt.includes(old), false, prompt)
    assert.match(prompt, /native-recall/)
    assert.equal(of(h, 'acted').length, 2, 'each interrupted action ran once: nothing was dispatched again')
    assert.equal(latestNative(h.session, ROUTE)?.state, 'idle')
  })
})

// SessionStore.flush rejects when a persistence listener failed and resolves false when none
// took part (dsh-session flush); either way the record is not on disk, and nothing goes out.
for (const [cause, fail, logged] of [
  ['the store fails to write it', async () => { throw new Error('disk full') }, 'disk full'],
  ['no store persists it (flush resolves false)', async () => false, 'no persistence listener'],
  ['flush resolves nothing', async () => undefined, 'no persistence listener'],
]) {
  test(`a sent record that cannot be saved sends nothing and leaves the record it found: ${cause}`, async () => {
    let failing = false
    const flush = target => (failing ? fail(target) : Promise.resolve(true))
    await unsaved(flush, () => { failing = true }, () => { failing = false }, logged)
  })
}

async function unsaved(flush, fail, heal, logged) {
  await withFixture('unsaved', { env: { FAKE_ACP_RESUME: '1' }, flush }, async (h) => {
    await turn(h, 'native-remember m-9')
    const before = latestNative(h.session, ROUTE)
    assert.equal(before.state, 'idle')
    const prompts = of(h, 'prompt').length
    fail()
    const refused = await send(h, 'native-remember never-sent')
    assert.equal(refused.finish.reason.kind, 'error')
    assert.equal(refused.finish.reason.failure.code, 'acp_binding_unsaved')
    assert.equal(of(h, 'prompt').length, prompts, 'no prompt went to the agent')
    const { v: _v, ...held } = latestNative(h.session, ROUTE)
    const { v: _w, ...was } = before
    assert.deepEqual(held, was, 'the record withdrawn: the chat says what it said before')
    assert.ok(h.logs.some(line => line.includes(logged)), h.logs.join('\n'))
    // Saved again, the next prompt goes, and a restart takes the session back with no warning.
    heal()
    h.messages.pop()
    await turn(h, 'native-remember m-10')
    h.restart()
    const after = await turn(h, 'native-recall')
    assert.match(after.said, /m-9,m-10/)
    assert.equal(of(h, 'prompt').at(-1).text.includes('may have partly run'), false)
  })
}

test('a qualified route with no session store sends no prompt at all', async () => {
  await withFixture('no-store', { env: { FAKE_ACP_RESUME: '1' }, store: null }, async (h) => {
    const refused = await send(h, 'native-remember never-sent')
    assert.equal(refused.finish.reason.kind, 'error')
    assert.equal(refused.finish.reason.failure.code, 'acp_binding_unsaved')
    assert.equal(of(h, 'prompt').length, 0, 'no prompt went to the agent')
    assert.equal(latestNative(h.session, ROUTE)?.state === 'sent', false, 'no sent record was left')
    assert.ok(h.logs.some(line => line.includes('no session store')), h.logs.join('\n'))
  })
})

test('a route that is not qualified needs no session store: its prompt goes and it binds nothing', async () => {
  await withFixture('unqualified', { route: null, store: null }, async (h) => {
    const sent = await turn(h, 'native-remember m-1')
    assert.equal(sent.finish.reason.kind, 'stop')
    assert.equal(of(h, 'prompt').length, 1)
    assert.equal(h.session.snapshotEvents().some(event => event.type === NATIVE_RECORD), false)
  })
})

test('a prompt that settles after its run was replaced writes nothing over the newer record', async () => {
  await withFixture('late', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    await turn(h, 'native-remember m-11')
    const old = h.adapter.live.get('s1').run
    h.restart()
    await turn(h, 'native-remember m-12')
    const records = h.session.snapshotEvents().filter(event => event.type === NATIVE_RECORD).length
    const newer = latestNative(h.session, ROUTE)
    assert.notEqual(newer.run, old.runId)
    // The old run's answer arriving now: it is not the chat's last prompt, so it says nothing.
    old.spec.onPromptSettled(1, true)
    // Nor does a prompt of the current run that is not the last record's.
    const current = h.adapter.live.get('s1').run
    current.spec.onPromptSettled(newer.ordinal + 1, true)
    assert.equal(h.session.snapshotEvents().filter(event => event.type === NATIVE_RECORD).length, records)
    assert.deepEqual(latestNative(h.session, ROUTE), newer)
  })
})
