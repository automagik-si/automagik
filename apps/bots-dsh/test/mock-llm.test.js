import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MOCK = fileURLToPath(new URL('../dev/mock-llm.mjs', import.meta.url))

// One Anthropic-shaped request, its SSE reply folded into { text, tools }.
async function call(url, messages, names = ['list_bots']) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, tools: names.map(name => ({ name })), messages }),
  })
  assert.equal(res.status, 200)
  const events = (await res.text()).split('\n\n')
    .map(chunk => /^data: (.+)$/m.exec(chunk)?.[1]).filter(Boolean).map(line => JSON.parse(line))
  let text = ''
  const tools = []
  for (const event of events) {
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') tools.push({ id: event.content_block.id, name: event.content_block.name })
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
  }
  return { text, tools }
}

// Append the reply and its tool results, as the next model request would carry them.
function fold(messages, out) {
  messages.push(
    { role: 'assistant', content: [...(out.text ? [{ type: 'text', text: out.text }] : []), ...out.tools.map(used => ({ type: 'tool_use', id: used.id, name: used.name, input: {} }))] },
    { role: 'user', content: out.tools.map(used => ({ type: 'tool_result', tool_use_id: used.id, content: '[]' })) },
  )
}

async function startMock(t, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-mock-'))
  const mock = spawn(process.execPath, [MOCK], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(home, 'mock.jsonl'), MOCK_DELAY_MS: '5', MOCK_JITTER_MS: '0', ...env },
  })
  t.after(() => { mock.kill(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // MOCK_PORT=0 lets the kernel pick a free port; the mock prints the real one.
  return new Promise((resolve, reject) => {
    mock.stdout.on('data', chunk => {
      const found = /127\.0\.0\.1:(\d+)\/v1/.exec(String(chunk))
      if (found !== null) resolve(`http://127.0.0.1:${found[1]}/v1/messages`)
    })
    mock.once('exit', code => reject(new Error(`mock-llm exited ${code}`)))
  })
}

// "长任务 N [K]" adds about K×1000 characters per step, defaulting to 4. A missing K once
// parsed as NaN, so every step after the opener silently sent no text block.
test('长任务 writes text on every step when the step size is left out', async (t) => {
  const url = await startMock(t)

  const messages = [{ role: 'user', content: '长任务 3' }]
  let out = await call(url, messages)
  assert.equal(out.text.length, 4000) // 步骤0
  fold(messages, out)

  out = await call(url, messages)
  assert.equal(out.text.length, 4000) // a tool result continues the task
  fold(messages, out)

  // A spliced Bot message mid-task hits the other parse of the same command, and its
  // note comes before the step's text.
  messages.push({ role: 'user', content: '[Message from HelperBot] 进度如何？' })
  out = await call(url, messages)
  const ack = '（已按 HelperBot 的话调整）\n'
  assert.ok(out.text.startsWith(ack), out.text.slice(0, 40))
  assert.equal(out.text.length - ack.length, 4000)
  fold(messages, out)

  out = await call(url, messages)
  assert.match(out.text, /长任务做完了，一共 3 步。/)
})

// A Bot hands work on when a Bot message says 转告, and answers 慢慢做 N after N seconds,
// so the bench can watch a Bot wait for work it handed on.
test('a Bot message hands work on with 转告 and takes its time with 慢慢做', async (t) => {
  const url = await startMock(t)
  const tools = ['list_bots', 'message_bot']
  const handed = await call(url, [{ role: 'user', content: '[Message from Omni]\n转告 Coder: 慢慢做 1' }], tools)
  assert.deepEqual(handed.tools.map(used => used.name), ['message_bot'])
  const started = Date.now()
  const slow = await call(url, [{ role: 'user', content: '[Message from Writer]\n慢慢做 1' }], tools)
  assert.ok(Date.now() - started >= 1000)
  assert.equal(slow.text, '给 Writer 的回复：做完了，用了 1 秒。')
  const back = await call(url, [{ role: 'user', content: '[Reply from Coder · for the work Omni asked you for; your answer goes to Omni once everything you handed on is back]\n做完了' }], tools)
  assert.deepEqual([back.text, back.tools], ['Coder 交回了，我把结果交给 Omni。', []])
})

async function command(url, first, tools) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      model: 'mock', stream: true, tools: tools.map(name => ({ name })),
      messages: [{ role: 'user', content: [
        { type: 'text', text: first },
        { type: 'text', text: '[Runtime context] A reminder from DSH.' },
      ] }],
    }),
  })
  assert.equal(res.status, 200)
  const events = (await res.text()).split('\n\n')
    .map(chunk => /^data: (.+)$/m.exec(chunk)?.[1]).filter(Boolean).map(line => JSON.parse(line))
  const tool = events.find(event => event.content_block?.type === 'tool_use')
  assert.ok(tool, 'the mock should call a tool')
  const input = events
    .filter(event => event.index === tool.index && event.delta?.type === 'input_json_delta')
    .map(event => event.delta.partial_json).join('')
  return { name: tool.content_block.name, input: JSON.parse(input) }
}

const subagentResult = [
  { role: 'user', content: 'Start a background subagent' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'child', name: 'subagent', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child', content: 'Started' }] },
]

test('rfc0039 [P] M1 call command reads only the first text block', { timeout: 5000 }, async t => {
  const url = await startMock(t)
  assert.deepEqual(await command(url, '调用 bash {"command":"echo ok"}', ['bash']), {
    name: 'bash', input: { command: 'echo ok' },
  })
})

test('rfc0039 [P] M2 task command reads only the first text block', { timeout: 5000 }, async t => {
  const url = await startMock(t)
  assert.deepEqual(await command(url, '开任务 Fix: Check API', ['start_task']), {
    name: 'start_task', input: { title: 'Fix', instructions: 'Check API' },
  })
})

test('rfc0039 [P] M3 subagent wait delays the reply', { timeout: 5000 }, async t => {
  const url = await startMock(t, { MOCK_SUBAGENT_WAIT_MS: '1500' })
  const started = performance.now()
  const reply = await call(url, subagentResult, ['subagent'])
  assert.ok(performance.now() - started >= 1400)
  assert.equal(reply.text, '好了。')
})

test('rfc0039 [C] M4 no subagent wait replies at once', { timeout: 5000 }, async t => {
  const url = await startMock(t, { MOCK_SUBAGENT_WAIT_MS: undefined })
  const started = performance.now()
  const reply = await call(url, subagentResult, ['subagent'])
  assert.ok(performance.now() - started < 1000)
  assert.equal(reply.text, '好了。')
})

// One Anthropic-shaped request, its SSE reply folded into { text, tools }.
async function callRepeat(send, messages) {
  const res = await send({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, tools: [{ name: 'bash' }], messages }),
  })
  assert.equal(res.status, 200)
  const events = (await res.text()).split('\n\n')
    .map(chunk => /^data: (.+)$/m.exec(chunk)?.[1]).filter(Boolean).map(line => JSON.parse(line))
  let text = ''
  const tools = []
  const byIndex = new Map()
  for (const event of events) {
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const { id, name, input } = event.content_block
      const used = { id, name, input }
      tools.push(used)
      byIndex.set(event.index, { used, json: '' })
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      byIndex.get(event.index).json += event.delta.partial_json
    }
    if (event.type === 'content_block_stop') {
      const block = byIndex.get(event.index)
      if (block?.json) block.used.input = JSON.parse(block.json)
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return { text, tools }
}

// Append the reply and its tool results, as the next model request would carry them.
function foldRepeat(messages, out) {
  messages.push(
    { role: 'assistant', content: [
      ...(out.text ? [{ type: 'text', text: out.text }] : []),
      ...out.tools.map(used =>
        ({ type: 'tool_use', id: used.id, name: used.name, input: used.input })),
    ] },
    { role: 'user', content: out.tools.map(used =>
      ({ type: 'tool_result', tool_use_id: used.id, content: '[]' })) },
  )
}

// A sandbox can prohibit even loopback listeners. This drives the same mock HTTP adapter
// and stream without opening a socket or starting DSH.
async function startMockInProcess(env) {
  const [{ default: http }, { syncBuiltinESMExports }, { Readable }] = await Promise.all([
    import('node:http'), import('node:module'), import('node:stream'),
  ])
  const createServer = http.createServer
  let listener
  http.createServer = callback => { listener = callback; return { listen() {} } }
  syncBuiltinESMExports()
  const values = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  const assign = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    assign(env)
    const url = new URL('../dev/mock-llm.mjs', import.meta.url)
    url.searchParams.set('fixture', env.HC_SESSION)
    await import(url)
    assert.equal(typeof listener, 'function')
  } finally {
    assign(values)
    http.createServer = createServer
    syncBuiltinESMExports()
  }
  return ({ body, headers, method }) => new Promise(resolve => {
    const request = Object.assign(Readable.from([body]), { headers, method, url: '/v1/messages' })
    let status
    let responseHeaders
    const chunks = []
    listener(request, {
      writeHead(code, headers) { status = code; responseHeaders = headers },
      write(chunk) { chunks.push(chunk) },
      end(chunk = '') {
        resolve(new Response(chunks.join('') + chunk, { status, headers: responseHeaders }))
      },
    })
  })
}

function repeatMock(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-repeat-mock-'))
  const runtime = mkdtempSync(join(home, 'runtime-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return startMockInProcess({
    MOCK_PORT: '0', MOCK_LOG: join(home, 'mock.jsonl'), MOCK_DELAY_MS: '5', MOCK_JITTER_MS: '0',
    HC_SESSION: home, XDG_RUNTIME_DIR: runtime,
  })
}

for (const [name, prefix] of [['own chat', ''], ['delegated task', '[Task from Ada]\n']]) {
  test('rfc0039 D4 mock repeats identical arguments in ' + name + ' [P]', async t => {
    const send = await repeatMock(t)
    const args = { command: 'echo ok', description: 'rfc39', justification: 'rfc39',
      sandbox_permissions: 'danger-full-access' }
    const messages = [{ role: 'user', content: prefix + '重复调用 3 0: bash '
      + JSON.stringify(args) }]
    const ids = new Set()
    for (let n = 0; n < 3; n++) {
      const out = await callRepeat(send, messages)
      assert.equal(out.tools.length, 1)
      assert.equal(out.tools[0].name, 'bash')
      assert.deepEqual(out.tools[0].input, args)
      ids.add(out.tools[0].id)
      foldRepeat(messages, out)
    }
    assert.equal(ids.size, 3)
    const finished = await callRepeat(send, messages)
    assert.equal(finished.tools.length, 0)
    assert.equal(finished.text, '重复调用完成。')
  })
}
