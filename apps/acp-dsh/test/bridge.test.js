// The stdio bridge (RFC 0003, amendment, "The bridge"): plain MCP over the adapter's pipe, its
// tools listed from DSH, its calls forwarded with the session credential, and a changed list
// announced as `notifications/tools/list_changed` only once the ACP session exists. A refused
// credential ends the process instead of leaving an agent with half a tool set.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

const BRIDGE = join(import.meta.dirname, '..', 'src', 'host', 'bridge.js')
const CREDENTIAL = 'test-credential-0123456789'

// A controllable stand-in for acp-dsh's back-channel, on a real loopback socket.
async function backchannel() {
  const state = {
    credential: CREDENTIAL,
    generation: 0,
    announced: true,
    tools: [
      { name: 'bash', description: 'Run a command', inputSchema: { type: 'object', properties: {} } },
      { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
    ],
    calls: [],
    holdMs: 0,
    abandoned: [],
    waiters: new Set(),
  }
  const wake = () => {
    for (const waiter of state.waiters) waiter()
    state.waiters.clear()
  }
  const server = createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const header = String(request.headers.authorization ?? '')
    if (header !== `Bearer ${state.credential}`) {
      request.resume()
      return reply(401, { error: 'refused' })
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body.op === 'list') return reply(200, { tools: state.tools, generation: state.generation })
    if (body.op === 'call') {
      state.calls.push({ name: body.name, arguments: body.arguments })
      // A slow call (`holdMs`), and whether its caller went away before the answer.
      if (state.holdMs > 0) {
        const gone = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), state.holdMs)
          response.once('close', () => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        if (gone) {
          state.abandoned.push(body.name)
          return
        }
      }
      return reply(200, { content: [{ type: 'text', text: `ran ${body.name}` }], isError: false })
    }
    if (body.op === 'wait') {
      const since = body.generation
      const ready = () => state.announced && state.generation > since
      const deadline = Date.now() + 5_000
      while (!ready() && Date.now() < deadline) {
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            state.waiters.delete(finish)
            resolve()
          }
          const timer = setTimeout(finish, deadline - Date.now())
          state.waiters.add(finish)
        })
      }
      return reply(200, { generation: state.announced ? state.generation : since })
    }
    return reply(200, { ok: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    bump({ announced = state.announced } = {}) {
      state.generation++
      state.announced = announced
      wake()
    },
    announce() {
      state.announced = true
      wake()
    },
    close() {
      wake()
      server.close()
    },
  }
}

function bridge(env, args = []) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = []
  let buffer = ''
  let seq = 0
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') messages.push(JSON.parse(line))
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  return {
    child,
    messages,
    exited,
    stderr: () => stderr,
    send(method, params) {
      const id = ++seq
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return id
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    async answer(id) {
      const deadline = Date.now() + 5_000
      for (;;) {
        const found = messages.find(message => message.id === id)
        if (found !== undefined) return found
        if (Date.now() > deadline) throw new Error(`no answer to ${id}; stderr: ${stderr}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    async notification(method, ms = 5_000) {
      const deadline = Date.now() + ms
      for (;;) {
        const found = messages.find(message => message.method === method)
        if (found !== undefined) return found
        if (Date.now() > deadline) return undefined
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    close() {
      try { child.kill('SIGTERM') } catch {}
    },
  }
}

test('server/discover is method-not-found, so both adapters fall back to the standard handshake', async () => {
  const channel = await backchannel()
  const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: CREDENTIAL })
  try {
    const id = run.send('server/discover', {})
    const answer = await run.answer(id)
    assert.equal(answer.error.code, -32601)
    const init = run.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test' } })
    const ready = await run.answer(init)
    assert.equal(ready.result.protocolVersion, '2025-11-25')
    assert.deepEqual(ready.result.capabilities.tools, { listChanged: true })
    assert.equal(ready.result.serverInfo.name, 'dsh')
  } finally {
    run.close()
    channel.close()
  }
})

for (const [label, args, name] of [
  ['takes the explicit name', ['--server-name', 'dshbbbbbbbbbb'], 'dshbbbbbbbbbb'],
  ['keeps the legacy name without an argument', [], 'dsh'],
  ['rejects a malformed name', ['--server-name', 'dsh_x']],
  ['rejects a missing name value', ['--server-name']],
]) {
  test(`#2125 bridge ${label}`, { timeout: 10_000 }, async () => {
    const channel = await backchannel()
    const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: CREDENTIAL,
      DSH_BRIDGE_SERVER: 'dshaaaaaaaaaa' }, args)
    try {
      if (name !== undefined) {
        const answer = await run.answer(run.send('initialize', {}))
        assert.equal(answer.result.serverInfo.name, name)
      } else {
        const closed = once(run.child, 'close')
        run.child.stdin.on('error', () => {})
        run.send('initialize', {})
        run.child.stdin.end()
        assert.equal((await closed)[0], 2)
        assert.deepEqual(run.messages, [])
        assert.equal(run.stderr(), 'acp-dsh bridge: invalid --server-name\n')
      }
    } finally {
      run.close()
      channel.close()
    }
  })
}

test('tools come from DSH, a call is forwarded with the bridge credential, and a new list is announced', async () => {
  const channel = await backchannel()
  const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: CREDENTIAL })
  try {
    const init = run.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    await run.answer(init)
    run.notify('notifications/initialized', {})
    const listed = await run.answer(run.send('tools/list', {}))
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['bash', 'read'])
    assert.deepEqual(listed.result.tools[0].inputSchema, { type: 'object', properties: {} })

    const called = await run.answer(run.send('tools/call', { name: 'bash', arguments: { command: 'echo hi' } }))
    assert.deepEqual(called.result, { content: [{ type: 'text', text: 'ran bash' }], isError: false })
    assert.deepEqual(channel.state.calls, [{ name: 'bash', arguments: { command: 'echo hi' } }])

    // A changed list: the long poll sees it and the agent is told to re-list.
    channel.state.tools = [...channel.state.tools, { name: 'write', description: 'Write', inputSchema: { type: 'object', properties: {} } }]
    channel.bump()
    const notice = await run.notification('notifications/tools/list_changed')
    assert.ok(notice, 'a list_changed notification reached the agent')
    const relisted = await run.answer(run.send('tools/list', {}))
    assert.deepEqual(relisted.result.tools.map(tool => tool.name), ['bash', 'read', 'write'])
  } finally {
    run.close()
    channel.close()
  }
})

test('a changed list before the ACP session exists is held, not announced', async () => {
  const channel = await backchannel()
  channel.state.announced = false
  const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: CREDENTIAL })
  try {
    await run.answer(run.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    await run.answer(run.send('tools/list', {}))
    channel.bump({ announced: false })
    assert.equal(await run.notification('notifications/tools/list_changed', 300), undefined, 'no announcement before session/new answers')
    // acp-dsh replies to session/new, then releases the bridge.
    channel.announce()
    assert.ok(await run.notification('notifications/tools/list_changed'), 'the held announcement lands after the answer')
  } finally {
    run.close()
    channel.close()
  }
})

test('a refused credential ends the bridge instead of running without tools', async () => {
  const channel = await backchannel()
  const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: 'another-session' })
  try {
    await run.answer(run.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    run.send('tools/list', {})
    const code = await run.exited
    assert.notEqual(code, 0)
    assert.match(run.stderr(), /credential/)
  } finally {
    run.close()
    channel.close()
  }
})

test('without its credential or address the bridge refuses to start', async () => {
  const run = bridge({ DSH_BRIDGE_URL: '', DSH_BRIDGE_CREDENTIAL: '' })
  const code = await run.exited
  assert.notEqual(code, 0)
  assert.match(run.stderr(), /DSH_BRIDGE_CREDENTIAL/)
})

// #957: the bridge used to give up on any exchange after a fixed 60 s, while DSH kept running
// the tool (a `job_output` with a 240 s wait, a slow command, an approval dialog left open).
// The deadline of the short exchanges is injected here so the test does not take a minute: a
// call that outlasts it several times over must still come back with its real result.
test('a call has no deadline: one that outlasts the short-exchange deadline returns its real result', async () => {
  const channel = await backchannel()
  const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: CREDENTIAL, DSH_BRIDGE_RPC_TIMEOUT_MS: '150' })
  try {
    await run.answer(run.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    channel.state.holdMs = 1_200
    const called = await run.answer(run.send('tools/call', { name: 'bash', arguments: {} }))
    assert.deepEqual(called.result, { content: [{ type: 'text', text: 'ran bash' }], isError: false })
    assert.deepEqual(channel.state.abandoned, [], 'the bridge never closed the request')
  } finally {
    run.close()
    channel.close()
  }
})

test('notifications/cancelled closes that call\'s request to DSH, and the cancelled request gets no response', async () => {
  const channel = await backchannel()
  const run = bridge({ DSH_BRIDGE_URL: channel.url, DSH_BRIDGE_CREDENTIAL: CREDENTIAL })
  try {
    await run.answer(run.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    channel.state.holdMs = 4_000
    const id = run.send('tools/call', { name: 'bash', arguments: {} })
    const deadline = Date.now() + 3_000
    while (channel.state.calls.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    run.notify('notifications/cancelled', { requestId: id, reason: 'stopped' })
    while (channel.state.abandoned.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(channel.state.abandoned, ['bash'], 'DSH saw the caller go away')
    // The bridge is still serving, and the cancelled request was never answered.
    channel.state.holdMs = 0
    const next = await run.answer(run.send('tools/call', { name: 'read', arguments: {} }))
    assert.equal(next.result.isError, false)
    assert.equal(run.messages.some(message => message.id === id), false)
  } finally {
    run.close()
    channel.close()
  }
})
