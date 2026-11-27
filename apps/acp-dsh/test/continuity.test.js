// Native cold continuity (continuity.js, docs/research/t3-code-acp-integration.md
// recommendation 2) over real stdio: the fake agent keeps each session's native context in a
// state file, as a CLI's session store does, so a marker it was told to remember lives only
// there, never in DSH's transcript. A restart is a new adapter over the same DSH Session.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { NATIVE_RECORD, decide, latestNative } from '../src/host/continuity.js'
import { ROUTE, answer, of, turn, user, withFixture } from './fixtures/continuity-world.js'

for (const how of ['resume', 'load']) {
  test(`a restart takes back the native session by ${how}: the agent remembers what only it was told, and nothing is replayed`, async () => {
    await withFixture(how, { env: how === 'resume' ? { FAKE_ACP_RESUME: '1' } : { FAKE_ACP_LOAD: '1' } }, async (h) => {
      await turn(h, 'remember m-42')
      const first = of(h, 'new-session')[0].sessionId
      const before = of(h, 'bridge-credential')[0].digest
      h.restart()
      const after = await turn(h, 'recall')
      assert.equal(after.finish.reason.kind, 'stop')
      assert.match(after.said, /I remember: m-42 \(turn 2\)/)
      assert.equal(of(h, 'new-session').length, 1, 'no new session after the restart')
      assert.deepEqual(of(h, `${how}-session`).map(event => [event.sessionId, event.servers]), [[first, ['dsh']]])
      const prompt = of(h, 'prompt').at(-1).text
      assert.equal(prompt, 'recall', 'the chat is not replayed to a session that holds it')
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
    await turn(h, 'remember m-1')
    h.restart()
    const after = await turn(h, 'recall')
    assert.match(after.said, /I remember: nothing/)
    assert.equal(of(h, 'new-session').length, 2)
    assert.ok(replayed(h))
    assert.ok(h.logs.some(line => line.includes('native session fresh (not-advertised)')))
  })
})

test('a route that is not qualified never asks to resume, whatever the agent advertises', async () => {
  await withFixture('unqualified', { env: { FAKE_ACP_RESUME: '1' }, route: null }, async (h) => {
    await turn(h, 'remember m-2')
    h.restart()
    await turn(h, 'recall')
    assert.equal(of(h, 'resume-session').length, 0)
    assert.equal(of(h, 'new-session').length, 2)
    assert.ok(replayed(h))
    assert.ok(h.logs.some(line => line.includes('starts a new session (route-not-qualified)')))
  })
})

test('a changed account, a changed Bot policy or an old chat with no binding starts fresh', async () => {
  let account = 'account-a'
  await withFixture('account', { env: { FAKE_ACP_RESUME: '1' }, account: () => account }, async (h) => {
    await turn(h, 'remember m-3')
    account = 'account-b'
    h.restart()
    const after = await turn(h, 'recall')
    assert.match(after.said, /nothing/)
    assert.equal(of(h, 'resume-session').length, 0)
    assert.ok(h.logs.some(line => line.includes('(binding-changed)')))
  })
  // The decision itself, for what the adapter computes into the digest.
  assert.deepEqual(decide({ route: { methods: ['resume'] }, record: undefined, digest: 'd' }), { skip: 'no-binding' })
  assert.deepEqual(decide({ route: { methods: ['resume'] }, record: { v: 1, nativeSessionId: 'n', digest: 'x', state: 'idle' }, digest: 'd' }), { skip: 'binding-changed' })
  assert.deepEqual(decide({ route: { methods: ['resume'] }, record: { v: 1, nativeSessionId: 'n', digest: 'd', state: 'sent' }, digest: 'd' }), { sessionId: 'n', methods: ['resume'], interrupted: true })
  await withFixture('old-chat', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    // Answers from before this version: no native-session record anywhere in the log.
    h.messages.push(user('earlier'), answer('earlier answer'))
    await turn(h, 'recall')
    assert.equal(of(h, 'resume-session').length, 0)
    assert.ok(h.logs.some(line => line.includes('(no-binding)')))
    assert.ok(replayed(h))
  })
})

test('a stale native id is refused by the agent: a new session on the same process, with the chat replayed', async () => {
  await withFixture('stale', { env: { FAKE_ACP_RESUME: '1' } }, async (h) => {
    await turn(h, 'remember m-4')
    rmSync(h.state)
    h.restart()
    const after = await turn(h, 'recall')
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
      await turn(h, 'remember m-5')
      h.restart()
      const after = await turn(h, 'recall')
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
    await turn(h, 'remember m-6')
    const cut = await turn(h, 'exit-mid-prompt now')
    assert.notEqual(cut.finish.reason.kind, 'stop')
    assert.equal(latestNative(h.session, ROUTE)?.state, 'sent', 'the binding says the dispatch is uncertain')
    h.restart()
    const after = await turn(h, 'recall')
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
    await turn(h, 'remember m-7')
    h.restart()
    const stop = new AbortController()
    h.messages.push(user('recall'))
    const chunks = []
    const stream = h.adapter.stream(markAgentLoopRequest({ provider: ROUTE, model: 'default', sessionId: 's1', messages: h.messages, signal: stop.signal }))
    setTimeout(() => stop.abort(), 300)
    for await (const chunk of stream) chunks.push(chunk)
    assert.notEqual(chunks.at(-1).reason.kind, 'stop')
    assert.equal(of(h, 'new-session').length, 1, 'no fresh session is started after a Stop')
    assert.equal(h.session.snapshotEvents().filter(event => event.type === NATIVE_RECORD).at(-1).data.state, 'idle')
  })
})
