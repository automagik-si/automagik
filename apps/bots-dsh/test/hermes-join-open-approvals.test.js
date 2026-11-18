import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HermesTransport, RemoteChat } from '../src/host/hermes-transport.js'
import { desktop8Session } from './fixtures/hermes-desktop8.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const approval = (sessionId = 'runtime') => ({
  id: 'approval-a', method: 'approval',
  params: { session_id: sessionId, request_id: 'request-a', command: 'sample-command', choices: ['once', 'deny'] },
})
const cancel = (overrides = {}) => ({
  kind: 'event', type: 'request.cancel', session_id: 'runtime', epoch: 'epoch-a', seq: 11,
  payload: { id: 'approval-a', method: 'approval', reason: 'resolved' }, ...overrides,
})

// Like the attach tests, exercise the real session/prepare/control paths with only
// request and socket writes stubbed. No connection or process is started.
function fixture(t, options = {}) {
  const transport = new HermesTransport({
    address: 'http://127.0.0.1:40123', profile: 'sample', credential: 'sample-credential',
    allowLoopback: true, attached: options.attached !== false,
  })
  transport.epoch = 'epoch-a'
  const snapshot = { ...desktop8Session('runtime', 'stored').live, open_requests: options.snapshotRequests ?? [] }
  const replay = {
    events: [], latest_seq: 12, epoch: 'epoch-a', truncated: false, count: 0,
    open_requests: [], ...options.replay,
  }
  const calls = [], answers = [], sent = [], asked = []
  transport.ws = { send: text => sent.push(JSON.parse(text)), close() {} }
  const answer = transport.answer.bind(transport)
  transport.answer = (id, result, unsupported = false) => {
    answers.push(unsupported ? { id, unsupported } : { id, result })
    answer(id, result, unsupported)
  }
  const identity = options.identity ?? {
    canonicalBot: true, runtimeSessionId: 'runtime', storedSessionId: 'stored', epoch: 'epoch-a', lastSeq: 10,
  }
  const question = (params, signal) => new Promise(resolve => {
    asked.push({ params, signal, epoch: identity.epoch, resolve })
  })
  const run = new RemoteChat(transport, { identity, question: options.noQuestion ? undefined : question })
  transport.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'session.list') return { sessions: [{ id: 'stored', title: params.title }] }
    if (method === 'session.resume' || method === 'session.activate') return snapshot
    if (method === 'session.events.since') {
      // Capture first, then deliver live frames before the captured reply resolves.
      const captured = structuredClone(replay)
      captured.count = captured.events.length
      await options.duringReplay?.({ run, transport, captured, params })
      return captured
    }
    if (method === 'prompt.submit') return { admission_id: 'admission' }
    throw new Error(`Unexpected request: ${method}`)
  }
  t.after(() => {
    run.dispose()
    for (const card of asked) card.resolve('deny')
  })
  return { transport, run, identity, snapshot, replay, calls, answers, sent, asked, question }
}

function expectState(f, ids, answered = []) {
  assert.deepEqual(f.asked.map(card => card.params.request_id), ids, 'question callback request ids')
  const expected = answered.map(id => ({ id, result: { choice: 'once' } }))
  assert.deepEqual(f.answers, expected, 'answer calls')
  assert.deepEqual(f.sent, expected.map(frame => ({ jsonrpc: '2.0', ...frame })), 'socket response frames')
  assert.equal(f.sent.some(frame => frame.error?.code === -32601), false, 'no unsupported-request refusal')
}

async function answerOnce(f) {
  expectState(f, ['request-a'])
  assert.equal(f.asked[0].signal.aborted, false)
  f.asked[0].resolve('once')
  await flush()
  expectState(f, ['request-a'], ['approval-a'])
}

test('attached join asks a replay open approval once and sends one once answer', async t => {
  const request = approval()
  const f = fixture(t, { replay: { open_requests: [request] } })
  await f.run.submit('sample')
  assert.deepEqual(f.asked[0]?.params, request.params)
  await answerOnce(f)
  f.run.receive({ ...request, kind: 'question', epoch: 'epoch-a' })
  await flush()
  expectState(f, ['request-a'], ['approval-a'])
})

test('attached join ignores an activate-only approval absent from replay open requests', async t => {
  const f = fixture(t, { snapshotRequests: [approval()] })
  await f.run.submit('sample')
  await flush()
  expectState(f, [])
})

test('attached join does not ask a replay open approval cancelled in replay events', async t => {
  const f = fixture(t, { replay: { open_requests: [approval()], events: [cancel()] } })
  await f.run.submit('sample')
  await flush()
  expectState(f, [])
})

test('first attached join retains a live approval arriving after replay capture', async t => {
  const request = approval()
  const f = fixture(t, {
    identity: { canonicalBot: true },
    duringReplay: ({ run, captured }) => {
      assert.deepEqual(captured.open_requests, [])
      run.receive({ ...request, kind: 'question', epoch: 'epoch-a' })
    },
  })
  await f.run.submit('sample')
  assert.equal(f.identity.runtimeSessionId, 'runtime')
  assert.equal(f.identity.epoch, 'epoch-a')
  assert.deepEqual(f.asked[0]?.params, request.params)
  await answerOnce(f)
})

test('first attached join applies a live cancellation to a listed approval before asking', async t => {
  const f = fixture(t, {
    identity: { canonicalBot: true }, replay: { open_requests: [approval()] },
    duringReplay: ({ run, captured }) => {
      assert.equal(captured.open_requests[0].id, 'approval-a')
      run.receive(cancel())
    },
  })
  await f.run.submit('sample')
  await flush()
  expectState(f, [])
})

test('changed runtime at join retains a buffered live approval under the joined identity', async t => {
  const request = approval()
  const f = fixture(t, {
    identity: { canonicalBot: true, runtimeSessionId: 'previous-runtime', storedSessionId: 'stored', epoch: 'epoch-a', lastSeq: 100 },
    replay: { latest_seq: 1 },
    duringReplay: ({ run }) => run.receive({ ...request, kind: 'question', epoch: 'epoch-a' }),
  })
  await f.run.submit('sample')
  assert.equal(f.identity.runtimeSessionId, 'runtime')
  assert.equal(f.identity.lastSeq, 1)
  assert.equal(f.asked[0]?.epoch, 'epoch-a')
  await answerOnce(f)
})

test('changed epoch at join asks a buffered live approval with the new epoch', async t => {
  const request = approval()
  const f = fixture(t, {
    replay: { epoch: 'epoch-b', latest_seq: 1 },
    duringReplay: ({ run }) => run.receive({ ...request, kind: 'question', epoch: 'epoch-b' }),
  })
  await f.run.submit('sample')
  assert.equal(f.identity.epoch, 'epoch-b')
  assert.equal(f.transport.epoch, 'epoch-b')
  assert.equal(f.asked[0]?.epoch, 'epoch-b')
  await answerOnce(f)
})

test('live seq above captured latest seq causes no false rewind and a live cancel suppresses the listed approval', async t => {
  const f = fixture(t, {
    replay: { open_requests: [approval()], latest_seq: 12 },
    duringReplay: ({ run, params }) => {
      assert.equal(params.last_seen, 10)
      run.receive({ kind: 'event', type: 'session.info', session_id: 'runtime', epoch: 'epoch-a', seq: 14, payload: {} })
      // This cancel is behind the live watermark and must still win.
      run.receive(cancel())
    },
  })
  const queued = { kind: 'text', text: 'sample-prefix' }
  const tool = { status: 'running' }
  f.run.queue.push(queued)
  f.run.streamed = 'sample-prefix'
  f.run.tools.set('tool-a', tool)
  f.transport.textCarry = 'held-prefix'
  const generation = f.run.generation
  await f.run.submit('sample')
  await flush()
  expectState(f, [])
  assert.equal(f.identity.lastSeq, 14)
  assert.equal(f.run.generation, generation)
  assert.deepEqual(f.run.queue, [queued])
  assert.equal(f.run.streamed, 'sample-prefix')
  assert.equal(f.run.tools.get('tool-a'), tool)
  assert.equal(tool.status, 'running')
  assert.equal(f.transport.textCarry, 'held-prefix')
  assert.equal(f.run.joinGap, false)
  assert.deepEqual(f.run.takeRecovered(), [])
})

test('the same approval id in replay and a live question is asked and answered once', async t => {
  const request = approval()
  const f = fixture(t, {
    replay: { open_requests: [request] },
    duringReplay: ({ run }) => run.receive({ ...request, kind: 'question', epoch: 'epoch-a' }),
  })
  await f.run.submit('sample')
  await answerOnce(f)
})

test('another session open approval is neither asked nor answered at join', async t => {
  const f = fixture(t, { replay: { open_requests: [approval('other-session')] } })
  await f.run.submit('sample')
  await flush()
  expectState(f, [])
})

test('a non-approval open request produces no question, answer or unsupported refusal at join', async t => {
  const request = { id: 'request-other', method: 'sample.request', params: { session_id: 'runtime' } }
  const f = fixture(t, { snapshotRequests: [request], replay: { open_requests: [request] } })
  await f.run.submit('sample')
  await flush()
  expectState(f, [])
})

test('Settings join and observational reconcile leave approvals for one explicit answering reconcile', async t => {
  const request = approval()
  const f = fixture(t, { noQuestion: true, snapshotRequests: [request], replay: { open_requests: [request] } })
  await f.run.prepare()
  await flush()
  expectState(f, [])
  await f.run.reconcile()
  await flush()
  expectState(f, [])
  await f.run.reconcile({ answerQuestions: true })
  await flush()
  expectState(f, [], [])
  // The answering view now supplies its card callback; observational capture
  // must remain silent even with that callback available.
  f.run.question = f.question
  await f.run.reconcile()
  await flush()
  expectState(f, [])
  await f.run.reconcile({ answerQuestions: true })
  f.run.receive({ ...request, kind: 'question', epoch: 'epoch-a' })
  await answerOnce(f)
  f.run.receive({ ...request, kind: 'question', epoch: 'epoch-a' })
  await flush()
  expectState(f, ['request-a'], ['approval-a'])
  assert.equal(f.calls.some(call => call.method === 'prompt.submit'), false)
})

test('a non-attached resumed session asks its snapshot open approval', async t => {
  const request = approval('stored')
  const f = fixture(t, {
    attached: false, identity: { storedSessionId: 'stored', epoch: 'epoch-a' }, snapshotRequests: [request],
  })
  await f.run.submit('sample')
  assert.equal(f.calls[0].method, 'session.resume')
  assert.equal(f.calls[0].params.session_id, 'stored')
  assert.equal(f.calls.some(call => ['session.create', 'session.activate', 'session.events.since'].includes(call.method)), false)
  assert.deepEqual(f.asked[0]?.params, request.params)
  await answerOnce(f)
})

test('a live cancel after the join card shows withdraws it and suppresses a late once choice', async t => {
  const request = approval()
  const f = fixture(t, { replay: { open_requests: [request] } })
  await f.run.submit('sample')
  expectState(f, ['request-a'])
  assert.equal(f.asked[0].signal.aborted, false)
  f.run.receive(cancel({ seq: 13 }))
  assert.equal(f.asked[0].signal.aborted, true, 'the visible card is withdrawn')
  assert.equal(f.run.questions.has(request.id), false)
  f.asked[0].resolve('once')
  await flush()
  f.run.receive({ ...request, kind: 'question', epoch: 'epoch-a' })
  await flush()
  expectState(f, ['request-a'])
})
