import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/approvals.js'

// The approval listener, with the team state it reads: a running task a Bot started, the
// Bots' own chats, and hidden group Sessions.
function bench({ tasks = {}, chats = [], groups = [], runs = [] } = {}) {
  const handlers = []
  const noted = []
  const disposers = []
  const stops = []
  const rt = {
    ctx: { on: (event, handler) => handlers.push({ event, handler }), effect: fn => disposers.push(fn()) },
    state: { tasks },
    groupOwners: new Map(groups),
    chatOwners: new Map(chats),
    botOf: id => (['genie', 'writer', 'ada'].includes(id) ? { id } : undefined),
    teamOwnerOf: id => new Map(runs).get(id),
    warn: () => {},
    noteStop: (...args) => stops.push(args),
    noteApproval: (sessionId, note) => noted.push([sessionId, note]),
    callDetail: () => ({ text: 'bun test', code: 'bun test' }),
    yieldRoomTurn: () => {},
  }
  install(rt)
  return { rt, handlers, noted, disposers, stops }
}

const request = (sessionId, toolName = 'bash') => ({ toolName, reason: 'run the tests', agent: { session: { id: sessionId } }, callId: 'c1' })

test('a task approval carries the task id and title, and clears when the task chat answers it', async () => {
  const { rt, handlers, noted } = bench({ tasks: { task1: { from: 'genie', status: 'working', title: 'Clone the automagik repo' } } })
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].event, 'approval/request')
  let settle
  const delegated = handlers[0].handler(request('task1'), () => new Promise((resolve) => { settle = resolve }))
  // A task's approval stays DSH's to answer in the task's own chat; the team notes it.
  const [entry] = rt.approvalsView()
  assert.equal(entry.sessionId, 'task1')
  assert.equal(entry.taskId, 'task1')
  assert.equal(entry.label, 'Clone the automagik repo')
  assert.equal(entry.botId, 'genie')
  assert.equal(entry.tool, 'bash')
  assert.equal(entry.answerable, false)
  assert.deepEqual(noted.at(-1), ['task1', { tool: 'bash', reason: 'run the tests' }])
  // Answered in the task's chat: the note goes, so the parent card and the Live rail follow.
  settle('allowed-once')
  assert.equal(await delegated, 'allowed-once')
  assert.deepEqual(rt.approvalsView(), [])
  assert.equal(noted.at(-1)[1], undefined)
})

test('a group approval is still answered once, from the team surface', async () => {
  const { rt, handlers } = bench({ groups: [['room-session', { botId: 'writer', roomId: 'room1' }]] })
  const answered = handlers[0].handler(request('room-session'), () => Promise.resolve('delegated'))
  const [entry] = rt.approvalsView()
  assert.equal(entry.roomId, 'room1')
  assert.equal(entry.answerable, true)
  rt.answerApproval(entry.id, 'allow')
  assert.equal(await answered, 'allowed-once')
  // A second decision for the same request is refused, not applied twice.
  assert.throws(() => rt.answerApproval(entry.id, 'allow'), /no longer open/)
  assert.throws(() => rt.answerApproval(entry.id, 'reject'), /no longer open/)
  assert.deepEqual(rt.approvalsView(), [])
})

test('a Bot\'s own approval keeps DSH\'s card, noted only', async () => {
  const { rt, handlers } = bench({ chats: [['bot-session', 'genie']] })
  const outcome = await handlers[0].handler(request('bot-session'), () => Promise.resolve('allowed-once'))
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(rt.approvalsView(), [])
})

test('an approval nobody on the team owns goes on to the next answerer', async () => {
  const { rt, handlers } = bench()
  const outcome = await handlers[0].handler(request('other'), () => Promise.resolve('unavailable'))
  assert.equal(outcome, 'unavailable')
  assert.deepEqual(rt.approvalsView(), [])
})

test('a run ask is noted without answering, and a run whose Bot left passes unnoted', async () => {
  const { rt, handlers, noted } = bench({ runs: [['x', { kind: 'run', run: true, botId: 'ada', taskId: 'x', label: 'someone' }]] })
  let settle
  const outcome = handlers[0].handler(request('x'), () => new Promise(resolve => { settle = resolve }))
  const [entry] = rt.approvalsView()
  assert.deepEqual([entry.botId, entry.sessionId, entry.taskId, entry.label, entry.answerable], ['ada', 'x', 'x', 'someone', false])
  settle('rejected')
  assert.equal(await outcome, 'rejected')
  assert.deepEqual(rt.approvalsView(), [])
  assert.equal(noted.at(-1)[1], undefined)
  const gone = bench()
  assert.equal(await gone.handlers[0].handler(request('x'), () => 'unavailable'), 'unavailable')
  assert.deepEqual(gone.noted, [])
})

test('a run child is cancelled with a stop and no approval note', async () => {
  const b = bench({ runs: [['x', { run: true, child: true, botId: 'ada' }]] })
  assert.equal(await b.handlers[0].handler(request('x'), () => assert.fail('must not pass to DSH')), 'cancelled')
  assert.deepEqual(b.noted, [])
  assert.equal(b.stops[0][1].why, 'unavailable')
})

test('a chat child is held and unload cancels it', async () => {
  const b = bench({ runs: [['x', { kind: 'chat', child: true, botId: 'ada', sessionId: 'ada-chat' }]] })
  const answer = b.handlers[0].handler(request('x'), () => assert.fail('must not pass to DSH'))
  assert.equal(b.rt.approvalsView()[0].answerable, true)
  assert.deepEqual(b.noted, [])
  b.disposers[0]()
  assert.equal(await answer, 'cancelled')
  assert.deepEqual(b.rt.approvalsView(), [])
})

test('a chat child whose signal is already aborted is cancelled, not held', async () => {
  const b = bench({ runs: [['x', { kind: 'chat', child: true, botId: 'ada', sessionId: 'ada-chat' }]] })
  const answer = b.handlers[0].handler({ ...request('x'), signal: AbortSignal.abort() }, () => assert.fail('must not pass to DSH'))
  assert.deepEqual(b.rt.approvalsView(), [])
  assert.equal(await answer, 'cancelled')
})

test('asks share a key only for the same Bot, folder, tool, reason and fully shown target', async () => {
  const { capabilityOfArgs } = await import('../src/host/turns.js')
  const { rt, handlers } = bench({ groups: [['one', { botId: 'writer', roomId: 'r' }], ['two', { botId: 'writer', roomId: 'r' }], ['other', { botId: 'ada', roomId: 'r' }], ['away', { botId: 'writer', roomId: 'r' }]] })
  const args = new Map()
  rt.callCapability = (_session, callId, tool) => capabilityOfArgs(args.get(callId), tool)
  rt.sessionFolder = agent => (agent?.id === 'away' ? '/elsewhere' : agent?.id === 'nowhere' ? undefined : '/work')
  const promises = []
  const add = (session, raw, tool = 'bash', reason = 'Run it') => {
    const callId = `c${args.size}`
    args.set(callId, raw)
    promises.push(handlers[0].handler({ ...request(session, tool), reason, callId }, () => assert.fail('held group request')))
    const entry = rt.approvalsView().at(-1)
    assert.equal(entry.callId, callId)
    return entry.capabilityKey
  }
  const key = add('one', '{"command":"echo hi","description":"say hi","timeout":5}')
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(key, add('two', '{"command":"echo hi","description":"greet"}'))
  assert.notEqual(key, add('other', '{"command":"echo hi"}'))
  assert.notEqual(key, add('away', '{"command":"echo hi"}'))
  assert.notEqual(key, add('one', '{"command":"echo hi"}', 'bash', 'Another reason'))
  assert.notEqual(key, add('one', '{"command":"echo hi"}', 'pwsh'))
  assert.notEqual(add('one', '{"command":"echo hi"}'), add('one', '{"command":"ECHO hi"}'))
  // Nothing the card would not show: padded or past 400 characters, extra fields, a workdir.
  assert.equal(add('one', '{"command":"echo hi "}'), undefined)
  assert.equal(add('one', JSON.stringify({ command: 'x'.repeat(401) })), undefined)
  assert.equal(add('one', '{"command":"echo hi","workdir":"/a"}'), undefined)
  assert.equal(add('one', '{"path":"/a","content":"x"}', 'write'), undefined)
  assert.equal(add('one', '{"command":"git push"}', 'keep_working'), undefined)
  for (const raw of [undefined, '', '{', '{}', '[]', '[1]', 'null', 'true', '123', '"text"']) assert.equal(add('one', raw), undefined)
  for (const entry of rt.approvalsView()) rt.answerApproval(entry.id, 'reject')
  assert.ok((await Promise.all(promises)).every(outcome => outcome === 'rejected'))
})

test('child requests carry call ids but never a capability key', async () => {
  const b = bench({ runs: [['x', { kind: 'chat', child: true, botId: 'ada', sessionId: 'ada-chat' }]] })
  b.rt.callCapability = () => '{"command":"same"}'
  const pending = b.handlers[0].handler(request('x'), () => assert.fail('held child'))
  const [entry] = b.rt.approvalsView()
  assert.equal(entry.callId, 'c1')
  assert.equal(entry.capabilityKey, undefined)
  b.rt.answerApproval(entry.id, 'allow')
  assert.equal(await pending, 'allowed-once')
})

test('capability identity drops a shell\'s description, keeps it for other tools', async () => {
  const { capabilityOfArgs } = await import('../src/host/turns.js')
  const plain = capabilityOfArgs('{"command":"git push"}', 'bash')
  assert.equal(plain, '["command","git push",null]')
  assert.equal(capabilityOfArgs('{"command":"git push","description":"Push the branch"}', 'bash'), plain)
  assert.equal(capabilityOfArgs('{"justification":"needs the network","command":"git push"}', 'bash'), plain)
  // The sandbox asked for is part of the effect: different ones never share a key.
  const escalated = capabilityOfArgs('{"command":"git push","sandbox_permissions":"require_escalated"}', 'bash')
  assert.notEqual(escalated, plain)
  assert.equal(escalated, capabilityOfArgs('{"command":"git push","sandbox_permissions":"require_escalated","justification":"x"}', 'bash'))
  // A line break or tab would show two commands as one line: never merged.
  for (const command of ['echo safe # note\nrm -rf build', 'echo a\rb', 'echo\ta']) assert.equal(capabilityOfArgs(JSON.stringify({ command }), 'bash'), undefined)
  // A description is real input for other tools (an issue's body): the card cannot show it.
  assert.equal(capabilityOfArgs('{"url":"https://x","description":"body"}', 'create_issue'), undefined)
  assert.equal(capabilityOfArgs('{"description":"only words"}', 'bash'), undefined)
})

test('a reason longer than the entry keeps never merges, and a native ask needs the whole reason', async () => {
  const { capabilityOfArgs } = await import('../src/host/turns.js')
  const { nativeAsk } = await import('../src/client/approvals.js')
  const { rt, handlers } = bench({ groups: [['one', { botId: 'writer', roomId: 'r' }]] })
  rt.callCapability = (_session, _callId, tool) => capabilityOfArgs('{"command":"echo hi"}', tool)
  rt.sessionFolder = () => '/work'
  const pending = handlers[0].handler({ ...request('one'), reason: 'r'.repeat(501) }, () => assert.fail('held group request'))
  const [entry] = rt.approvalsView()
  assert.equal(entry.capabilityKey, undefined)
  const ask = { kind: 'approval', callId: 'c1', toolName: 'bash', reason: 'r'.repeat(501), answer() {} }
  assert.equal(nativeAsk(new Map([['one', { pendingInteraction: ask }]]), entry), undefined)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await pending, 'rejected')
})

test('an agent call through ACP is one capability only when all but its id is the same', async () => {
  const { capabilityOfArgs } = await import('../src/host/turns.js')
  const call = (id, input, title = 'touch /tmp/probe') => JSON.stringify({ id, title, kind: 'execute', input })
  const a = capabilityOfArgs(call('call-1', { command: ['bash', '-lc', 'touch /tmp/probe'], cwd: '/work' }), 'acp_tool')
  assert.ok(a)
  assert.equal(capabilityOfArgs(call('call-2', { cwd: '/work', command: ['bash', '-lc', 'touch /tmp/probe'] }), 'acp_tool'), a)
  assert.notEqual(capabilityOfArgs(call('call-3', { command: ['bash', '-lc', 'touch /tmp/probe'], cwd: '/other' }), 'acp_tool'), a)
  assert.notEqual(capabilityOfArgs(call('call-4', { command: ['bash', '-lc', 'touch /tmp/probe'], cwd: '/work' }, 'touch /tmp/other'), 'acp_tool'), a)
  assert.equal(capabilityOfArgs(JSON.stringify({ id: 'x', kind: 'execute', input: {} }), 'acp_tool'), undefined)
  assert.equal(capabilityOfArgs(JSON.stringify({ id: 'x', title: 'touch', kind: 'execute' }), 'acp_tool'), undefined)
})

test('an ACP ask names its call by its reason wherever the command is shown', async () => {
  const { approvalDetail } = await import('../src/client/approvals.js')
  assert.equal(approvalDetail({ tool: 'acp_tool', reason: 'Codex (ACP): touch /tmp/probe' }), 'Codex (ACP): touch /tmp/probe')
  assert.equal(approvalDetail({ tool: 'acp_tool', reason: 'x', detail: { code: 'ls' } }), 'ls')
  assert.equal(approvalDetail({ tool: 'bash', reason: 'Run it' }), '')
})

test('a reason with a line break never merges', async () => {
  const { capabilityOfArgs } = await import('../src/host/turns.js')
  const { rt, handlers } = bench({ groups: [['one', { botId: 'writer', roomId: 'r' }]] })
  rt.callCapability = (_session, _callId, tool) => capabilityOfArgs('{"command":"echo hi"}', tool)
  rt.sessionFolder = () => '/work'
  const pending = handlers[0].handler({ ...request('one'), reason: 'first line\nsecond line' }, () => assert.fail('held group request'))
  const [entry] = rt.approvalsView()
  assert.equal(entry.capabilityKey, undefined)
  rt.answerApproval(entry.id, 'reject')
  assert.equal(await pending, 'rejected')
})
