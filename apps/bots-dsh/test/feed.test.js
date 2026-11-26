import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 3,
  bots: {
    m1: { id: 'm1', sessionId: 'm1c', segments: [{ sessionId: 'm1', endedAt: 50 }], name: 'Omni', role: 'Omni of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  // Omni's turn 7 answers another Bot, so the chat does not show it.
  exchangeTurns: { m1c: [7] },
  questions: {},
}

const userMessage = (text, time) => ({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const botMessage = (text, time, turn = 1) => ({ type: 'assistant/message', time, data: { turn, message: { content: [{ type: 'text', text }] } } })

function start({ pages = {}, services = {}, team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-feed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 100 } } }),
    // Two pages per Session, newest first, keyed by the cursor that asks for them.
    page: async ({ address, beforeSeq }) => pages[`${address.sessionId}:${beforeSeq ?? 'end'}`] ?? { records: [], hasMore: false },
  }
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/omni-ui'].fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, stop, routes }
}

// Reads Server-Sent Events off a response, one `{ event, data }` per call.
function reader(response) {
  const source = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith(':')) continue
        const field = name => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
        return { event: field('event'), data: JSON.parse(field('data')) }
      }
      const { value, done } = await source.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

test('the live feed tells a window about saves, new chat entries and the reply being written', async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const abort = new AbortController()
  // Held until the window closes, as a host holds the request it is answering: a Request
  // made with an outside signal follows it only through a weak reference, so once the
  // Request is garbage collected, aborting the outside signal no longer reaches the feed's
  // listener on `request.signal`, and the read below waits forever.
  const request = new Request('http://localhost/api/omni-ui/feed', { signal: abort.signal })
  const response = await routes['/api/omni-ui/feed'].fetch(request)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const next = reader(response)
  assert.equal((await next()).event, 'hello')

  await call('set-prefs', { motion: 'lively' })
  const saved = await next()
  assert.equal(saved.event, 'revision')
  assert.equal(saved.data.revision > TEAM.revision, true)

  // The feed's own listener is the last on session/event; the others need a live dsh.
  const onEvent = ctx.listeners.get('session/event').at(-1)
  onEvent({ id: 'm1c' }, userMessage('hello', 60))
  assert.deepEqual(await next(), { event: 'message', data: { botId: 'm1', sessionId: 'm1c', item: { kind: 'user', text: 'hello', time: 60 } } })
  // A group Session or an earlier part is not a Bot's own chat now.
  onEvent({ id: 'm1' }, userMessage('old', 1))
  onEvent({ id: 'm1c' }, botMessage('hidden', 61, 7))

  const [onStream] = ctx.listeners.get('agent/assistant-stream')
  const agent = { id: 'm1c' }
  onStream({ agent, frame: { type: 'start', attemptId: 'a7', turn: 7 } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a7', chunk: { type: 'text-delta', text: 'hidden' } } })
  onStream({ agent, frame: { type: 'start', attemptId: 'a1', turn: 8 } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: 'hmm' } } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'Hi ' } } })
  onStream({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'there' } } })
  onStream({ agent, frame: { type: 'end', attemptId: 'a1' } })
  onStream({ agent, frame: { type: 'end', attemptId: 'a7' } })
  const target = { botId: 'm1', sessionId: 'm1c', attemptId: 'a1' }
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'start' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: 'Hi ' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, text: 'there' } })
  assert.deepEqual(await next(), { event: 'stream', data: { ...target, phase: 'end' } })

  // Status changes in a burst come as one notice.
  const onStatus = ctx.listeners.get('agent/status').at(-1)
  for (const id of ['b2', 'm1c', 'b2']) onStatus({ agent: { id }, status: 'running' })
  onStatus({ agent: { id: 'not-a-bot' }, status: 'running' })
  assert.deepEqual(await next(), { event: 'live', data: {} })

  abort.abort()
  assert.equal(await next(), undefined)
  assert.equal(request.signal.aborted, true)
})

test('a window that stops reading the feed is dropped', { timeout: 10_000 }, async (t) => {
  const { ctx, call, stop, routes } = start()
  t.after(stop)
  await call('state')
  const response = await routes['/api/omni-ui/feed'].fetch(new Request('http://localhost/api/omni-ui/feed'))
  const onEvent = ctx.listeners.get('session/event').at(-1)
  for (let index = 0; index < 1000; index += 1) onEvent({ id: 'm1c' }, userMessage(`line ${index}`, index))
  // What was queued before the drop still arrives, then the stream ends.
  const next = reader(response)
  let count = 0
  while (await next() !== undefined) count += 1
  assert.equal(count > 1 && count < 1000, true)
})

test('the chat endpoint pages a Bot\'s own chat from the newest part back', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const { call, stop } = start({
    pages: {
      'm1c:end': { records: [record(userMessage('second', 70), 41), record(botMessage('reply', 71), 42)], hasMore: true },
      'm1c:41': { records: [record(userMessage('first', 60), 40)], hasMore: false },
      'm1:end': { records: [record(userMessage('long ago', 5), 3)], hasMore: false },
    },
  })
  t.after(stop)
  await call('state')
  const first = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(first, {
    sessionId: 'm1c',
    items: [{ kind: 'user', text: 'second', time: 70, seq: 41 }, { kind: 'bot', text: 'reply', time: 71, seq: 42 }],
    window: { part: 1, beforeSeq: 43 },
    cursor: { part: 1, beforeSeq: 41 },
  })
  // The current part's first message has the line that marks where the part began.
  const second = (await call('chat', { botId: 'm1', cursor: first.cursor })).value
  assert.deepEqual(second.items, [{ kind: 'divider', time: 50 }, { kind: 'user', text: 'first', time: 60, seq: 40 }])
  assert.deepEqual(second.cursor, { part: 0 })
  const third = (await call('chat', { botId: 'm1', cursor: second.cursor })).value
  assert.deepEqual([third.items, third.cursor], [[{ kind: 'user', text: 'long ago', time: 5, seq: 3 }], null])
  assert.equal((await call('chat', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('a show_view call in a part reads back as a view row with its blueprint', async (t) => {
  const record = (event, seq) => ({ event: { ...event, seq } })
  const showView = (time, args) => ({ type: 'tool/call', time, data: { callId: 'c1', name: 'show_view', arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
  const { call, stop } = start({
    pages: {
      'm1c:end': {
        records: [
          record(userMessage('look', 70), 41),
          record(showView(71, { title: 'A long note', view: { type: 'stack', children: [0, 1, 2, 3].map(() => ({ type: 'text', text: 'x'.repeat(1900) })) } }), 42),
          // A view needs no title; a call the tool refused leaves no row. Other tools stay out too.
          record(showView(72, { view: { type: 'text', text: 'y' } }), 43),
          record(showView(72, { title: 'Refused', view: { type: 'nope' } }), 45),
          record({ type: 'tool/call', time: 73, data: { callId: 'c3', name: 'list_bots', arguments: '{}' } }, 44),
        ],
        hasMore: false,
      },
    },
  })
  t.after(stop)
  await call('state')
  const page = (await call('chat', { botId: 'm1' })).value
  const row = page.items.find(item => item.kind === 'view')
  assert.equal(row.title, 'A long note')
  assert.equal(row.callId, 'c1')
  assert.equal(row.view.children.length, 4)
  assert.equal(JSON.stringify(row.view).length > 7500, true)
  assert.deepEqual(page.items.map(item => item.kind), ['divider', 'user', 'view', 'view'])
  assert.equal(page.items.at(-1).title, '')
})

test('view replay omits hidden, refused and interactive calls in pages and the live feed', async (t) => {
  const view = { type: 'text', text: 'Visible' }
  const cases = [
    { turn: 7, arguments: { title: 'Hidden', view } },
    { arguments: { title: 'Refused wait', view, await_reply: true } },
    { arguments: { title: 'Too long', view: { type: 'text', text: 'x'.repeat(7800) } } },
    { arguments: { title: 'Interactive', view: { type: 'confirm', id: 'ok' } } },
    { arguments: '{invalid' },
    { arguments: { title: '  Accepted  ', view: { type: 'progress', percent: '40' } } },
  ]
  const events = cases.map((data, index) => ({
    type: 'tool/call', time: 70 + index, seq: 41 + index,
    data: { turn: 8, callId: `v${index}`, name: 'show_view', ...data },
  }))
  const { ctx, call, stop, routes } = start({ pages: { 'm1c:end': { records: events.map(event => ({ event })), hasMore: false } } })
  t.after(stop)
  await call('state')
  const expected = { kind: 'view', title: 'Accepted', view: { type: 'progress', percent: 40 }, callId: 'v5', time: 75 }
  const page = (await call('chat', { botId: 'm1' })).value
  assert.deepEqual(page.items.filter(item => item.kind === 'view'), [expected])

  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await routes['/api/omni-ui/feed'].fetch(new Request('http://localhost/api/omni-ui/feed', { signal: abort.signal }))
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  const onEvent = ctx.listeners.get('session/event').at(-1)
  for (const event of events) onEvent({ id: 'm1c' }, event)
  assert.deepEqual(await next(), { event: 'message', data: { botId: 'm1', sessionId: 'm1c', item: expected } })
})

test('a display view is retained when its part becomes earlier history', async (t) => {
  const view = { type: 'text', text: 'From the first part' }
  const event = { type: 'tool/call', time: 20, seq: 3, data: { turn: 1, callId: 'old-view', name: 'show_view', arguments: JSON.stringify({ title: 'Earlier card', view }) } }
  const { call, stop } = start({ pages: { 'm1:end': { records: [{ event }], hasMore: false } } })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items, [{ kind: 'view', title: 'Earlier card', view, callId: 'old-view', time: 20 }])
})

test('a question or view card closed without an answer reads back in earlier history, including hidden turns; an answered one does not', async (t) => {
  const options = [{ label: 'Short' }, { label: 'Long' }]
  const pick = { type: 'options', id: 'lane', options: [{ label: 'Ship now' }] }
  const meter = { type: 'metric', label: 'Done', value: '3' }
  const events = [
    { type: 'tool/call', time: 20, seq: 3, data: { turn: 1, callId: 'q-closed', name: 'ask_user', arguments: JSON.stringify({ question: 'Which draft?', options }) } },
    { type: 'tool/call', time: 21, seq: 4, data: { turn: 1, callId: 'q-answered', name: 'ask_user', arguments: JSON.stringify({ question: 'Answered', options }) } },
    { type: 'tool/call', time: 22, seq: 5, data: { turn: 1, callId: 'v-closed', name: 'show_view', arguments: JSON.stringify({ title: 'Pick a lane', view: pick }) } },
    { type: 'tool/call', time: 23, seq: 6, data: { turn: 2, callId: 'v-hidden-meter', name: 'show_view', arguments: JSON.stringify({ title: 'Hidden meter', view: meter }) } },
    { type: 'tool/call', time: 24, seq: 7, data: { turn: 2, callId: 'v-hidden-closed', name: 'show_view', arguments: JSON.stringify({ title: 'Browser default?', view: pick }) } },
  ]
  const team = {
    ...TEAM,
    exchangeTurns: { ...TEAM.exchangeTurns, m1: [2] },
    closedCards: { m1: { 'q-closed': 'replied', 'v-closed': 'dismissed', 'v-hidden-closed': 'replied' } },
  }
  const { call, stop } = start({ team, pages: { 'm1:end': { records: events.map(event => ({ event })), hasMore: false } } })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items, [
    { kind: 'closed', closed: 'replied', question: { question: 'Which draft?', options, multiSelect: false }, callId: 'q-closed', time: 20 },
    { kind: 'closed', closed: 'dismissed', title: 'Pick a lane', view: pick, callId: 'v-closed', time: 22 },
    { kind: 'closed', closed: 'replied', title: 'Browser default?', view: pick, callId: 'v-hidden-closed', time: 24 },
  ])
})

test('the run-stats endpoint reads DSH\'s figures for the current part of a Bot\'s chat', async (t) => {
  const views = { sessionStats: { turns: 3 }, tokenUsage: { cacheReadTokens: 9 }, contextPressure: { contextWindow: 100 } }
  const read = []
  const sessionProjections = {
    snapshot: (session, keys) => {
      read.push([session.id, keys])
      return { asOfSeq: 7, values: views }
    },
  }
  const { call, stop } = start({ services: { sessionProjections } })
  t.after(stop)
  await call('state')
  assert.deepEqual((await call('run-stats', { botId: 'm1' })).value, views)
  assert.deepEqual(read, [['m1c', ['sessionStats', 'tokenUsage', 'contextPressure']]])
  assert.equal((await call('run-stats', { botId: 'nobody' })).error.code, 'bot/not-found')
})

test('without DSH\'s session projections the run-stats endpoint has nothing to show', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  await call('state')
  assert.deepEqual(await call('run-stats', { botId: 'm1' }), { ok: true, value: null })
})

test('earlier parts replay dedicated cards once and keep activity for calls without a replay card', async (t) => {
  const { handoffReply, questionReply, viewReply } = await import('../src/host/parts.js')
  const question = { id: 'q', callId: 'question', question: 'Which draft?', options: [{ label: 'Short' }] }
  const view = { type: 'options', id: 'lane', options: [{ label: 'Ship now' }] }
  const part = (seq, name, args, ids) => ({
    type: ids.subCallId ? 'tool/ptc-dispatch-start' : 'tool/call', seq, time: seq,
    data: { turn: 1, name, arguments: JSON.stringify(args), ...ids },
  })
  const reply = (seq, { text, source }) => ({
    type: 'user/message', seq, time: seq, data: { source, content: [{ type: 'text', text }] },
  })
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    part(2, 'ask_user', question, { subCallId: 'question' }),
    part(3, 'bash', {}, { subCallId: 'shell' }),
    part(4, 'ask_user', question, { subCallId: 'closed-question' }),
    part(5, 'show_view', { title: 'Pick a lane', view }, { subCallId: 'view' }),
    part(6, 'show_view', { title: 'Refused view', view, await_reply: false }, { callId: 'refused-view' }),
    part(7, 'request_secret', {}, { callId: 'secret' }),
    part(8, 'browser_handoff', { reason: 'other' }, { callId: 'handoff' }),
    reply(9, questionReply(question, { selected: ['Short'] })),
    reply(10, viewReply({ id: 'v', callId: 'view', title: 'Pick a lane', view }, 'lane', { selected: ['Ship now'] })),
    reply(11, handoffReply({ callId: 'handoff', reason: 'other' }, 'done')),
  ]
  const { call, stop } = start({
    team: { ...TEAM, closedCards: { m1: { 'closed-question': 'dismissed' } } },
    pages: { 'm1:end': { records: events.map(event => ({ event })), hasMore: false } },
  })
  t.after(stop)
  await call('state')
  const page = (await call('earlier', { sessionId: 'm1c' })).value
  assert.deepEqual(page.items.map(item => [item.kind, item.id ?? item.callId ?? item.seq]), [
    ['tool-activity', 'shell'],
    ['closed', 'closed-question'],
    ['tool-activity', 'refused-view'],
    ['tool-activity', 'secret'],
    ['answer', 9],
    ['answer', 10],
    ['answer', 11],
  ])
  assert.equal(page.items[4].answers[0].selected[0], 'Short')
  assert.equal(page.items[5].views[0].title, 'Pick a lane')
  assert.equal(page.items[6].handoff.outcome, 'done')
})

test('earlier history keeps one activity row for each question refused for unusable options', async (t) => {
  const { questionReply } = await import('../src/host/parts.js')
  const asked = { id: 'question', callId: 'answered', question: 'Which draft?', options: [{ label: 'Short' }] }
  const { source, text } = questionReply(asked, { selected: ['Short'] })
  const turn = { type: 'turn/start', seq: 1, data: { turn: 1 } }
  const question = (seq, id, options, dispatch = false) => ({
    type: dispatch ? 'tool/ptc-dispatch-start' : 'tool/call', seq, time: seq,
    data: {
      name: 'ask_user', arguments: dispatch ? { question: asked.question, options } : JSON.stringify({ question: asked.question, options }),
      ...(dispatch ? { rootCallId: 'program', parentCallId: 'program', subCallId: id } : { callId: id, turn: 1 }),
    },
  })
  const page = (events, hasMore = false) => ({ records: events.map(event => ({ event })), hasMore })
  const { call, ctx, stop } = start({
    team: { ...TEAM, closedCards: { m1: { closed: 'dismissed' } } },
    pages: {
      'm1:end': page([
        question(7, 'program:ptc:1', [{ label: ' ' }], true),
        { type: 'user/message', seq: 8, time: 8, data: { source, content: [{ type: 'text', text }] } },
      ], true),
      'm1:7': page([
        turn,
        question(2, 'refused', []),
        question(3, 'answered', asked.options),
        question(4, 'closed', asked.options, true),
      ]),
    },
  })
  t.after(stop)
  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async id => {
    if (id === 'm1') throw new Error('Archived part')
    return resolve(id)
  }
  await call('state')
  const newest = (await call('earlier', { sessionId: 'm1c' })).value
  const older = (await call('earlier', { sessionId: 'm1c', cursor: newest.cursor })).value
  const items = [...older.items, ...newest.items]
  assert.deepEqual(items.filter(item => item.kind !== 'tool-activity').map(item => item.kind), ['closed', 'answer'])
  assert.equal(items.find(item => item.kind === 'closed').callId, 'closed')
  assert.equal(items.find(item => item.kind === 'answer').answers[0].selected[0], 'Short')
  assert.deepEqual(items.filter(item => item.kind === 'tool-activity'), [
    { kind: 'tool-activity', label: 'tool', name: 'ask_user', id: 'refused', seq: 2, time: 2, turn: 1 },
    { kind: 'tool-activity', label: 'tool', name: 'ask_user', id: 'program:ptc:1', seq: 7, time: 7, turn: 1 },
  ])
})

test('earlier history keeps one activity row for each computer handoff refused while off', async (t) => {
  const name = 'computer_handoff'
  const refused = [{ type: 'text', text: 'Computer use is off for you.' }]
  const turn = { type: 'turn/start', seq: 1, data: { turn: 1 } }
  const direct = (seq, callId, tool = name) => ({
    type: 'tool/call', seq, time: seq, data: { turn: 1, step: 0, name: tool, callId, arguments: '{"reason":"login"}' },
  })
  const result = (seq, sourceSeq, toolCallId) => ({
    type: 'tool/result', seq, time: seq, sourceEventSeqs: [sourceSeq], surfaceOp: 'append',
    data: { turn: 1, step: 0, message: { role: 'tool', toolCallId, content: refused } },
  })
  const program = { rootCallId: 'program', parentCallId: 'program', subCallId: 'program:ptc:1', name, arguments: { reason: 'login' } }
  const answer = { kind: 'answer_to_pending_handoff', tool: name, callId: 'answered', reason: 'login', outcome: 'done' }
  const page = (events, hasMore = false) => ({ records: events.map(event => ({ event })), hasMore })
  const { call, ctx, stop } = start({
    pages: {
      'm1:end': page([
        { type: 'user/message', seq: 6, time: 6, data: { source: { kind: 'user' }, content: [] } },
        result(7, 2, 'refused'),
        { type: 'tool/ptc-dispatch-start', seq: 8, time: 8, data: program },
        { type: 'tool/ptc-dispatch', seq: 9, time: 9, data: { ...program, isError: false, content: refused } },
        { type: 'user/message', seq: 10, time: 10, data: {
          source: { kind: 'user-question-reply', callId: 'answered', outcome: 'answered' },
          content: [{ type: 'text', text: JSON.stringify(answer) }],
        } },
      ], true),
      'm1:6': page([turn, direct(2, 'refused'), direct(3, 'answered'), direct(4, 'shell', 'bash'), result(5, 4, 'shell')]),
      'm1:3': page([turn, direct(2, 'refused')]),
    },
  })
  t.after(stop)
  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async id => {
    if (id === 'm1') throw new Error('Archived part')
    return resolve(id)
  }
  await call('state')
  const newest = (await call('earlier', { sessionId: 'm1c' })).value
  const older = (await call('earlier', { sessionId: 'm1c', cursor: newest.cursor })).value
  const items = [...older.items, ...newest.items]
  assert.deepEqual(items.filter(item => item.kind === 'answer').map(item => item.handoff.callId), ['answered'])
  assert.deepEqual(items.filter(item => item.kind === 'tool-activity').map(item => [item.name, item.id, item.seq, item.turn]), [
    ['bash', 'shell', 4, 1],
    ['computer_handoff', 'refused', 7, 1],
    ['computer_handoff', 'program:ptc:1', 8, 1],
  ])
})
