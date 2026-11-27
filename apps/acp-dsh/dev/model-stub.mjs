// A synthetic model backend on loopback for the real connectors and CLIs (test/real-backend.test.js
// and scripts/acp-qualify.mjs): it answers Claude Code's Anthropic Messages API and Codex's
// OpenAI Responses API with a fixed, rule-based reply, so a real connector, CLI, session store
// and bridge run end to end with no account, no paid call and no network. It is not a model:
// it only says what it can read in the request it was sent.
//
//   REMEMBER <marker>   in the last user text: replies "Noted."
//   RECALL              in the last user text: names the first REMEMBER marker anywhere in the
//                       request (the CLI's own history), else "I do not know."
//   TOOLS               in the last user text: lists the tool names the request offers
//   CALL <name>         in the last user text: calls the offered tool whose name ends with
//                       <name> (no arguments); once its result is back, says "Done: <result>"
//
// Every request is recorded (`requests`: path, model, the texts and tool names it carried), so a
// test can prove which history the CLI sent and which tools it offered.
import { createServer } from 'node:http'

const MARKER = /REMEMBER ([A-Z0-9-]{3,40})/
let calls = 0

function textsOf(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) textsOf(item, out)
  else if (value !== null && typeof value === 'object') {
    if (typeof value.text === 'string') out.push(value.text)
    for (const key of ['content', 'input', 'messages', 'output']) if (key in value) textsOf(value[key], out)
  }
  return out
}

function lastUserText(body) {
  const turns = body.messages ?? body.input ?? []
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    if (turn?.role !== 'user') continue
    // A turn that only carries tool results is the CLI's, not the person's.
    const content = Array.isArray(turn.content) ? turn.content.filter(block => block?.type !== 'tool_result') : turn.content
    const texts = textsOf(content).filter(text => !text.startsWith('<system-reminder>'))
    if (texts.length > 0) return texts.join('\n')
  }
  return typeof body.input === 'string' ? body.input : ''
}

function toolNames(body) {
  return (body.tools ?? []).map(tool => tool?.name ?? tool?.function?.name).filter(name => typeof name === 'string')
}

const COMMAND = /^(REMEMBER [A-Z0-9-]{3,40}|RECALL|TOOLS|CALL [A-Za-z0-9_-]+)\s*$/

/** The person's latest command and how many times it was said (a CLI may merge or reshape turns). */
function commandOf(body) {
  const texts = textsOf(body.messages ?? body.input ?? []).flatMap(text => text.split('\n')).map(line => line.trim())
  const commands = texts.filter(line => COMMAND.test(line))
  const command = commands.at(-1) ?? lastUserText(body).trim()
  return { command, times: commands.filter(line => line === command).length }
}

function lastToolResult(body) {
  const results = []
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') {
      if (value.type === 'tool_result') results.push(textsOf(value.content).join(' ').trim())
      else if (value.type === 'function_call_output') results.push(String(value.output ?? '').trim())
      else for (const key of ['content', 'input', 'messages']) if (key in value) walk(value[key])
    }
  }
  walk(body.messages ?? body.input ?? [])
  return results.at(-1) || '(no result)'
}

/**
 * What the stub answers: `{ text }`, or `{ call: name }` to call an offered tool. A CALL is
 * made once per time the person said it (`issued`): the next request is its answer.
 */
export function decideReply(body, issued = new Set()) {
  const { command, times } = commandOf(body)
  const called = /^CALL ([A-Za-z0-9_-]+)$/.exec(command)?.[1]
  if (called !== undefined) {
    const key = `${command}#${times}`
    if (issued.has(key)) return { text: `Done: ${lastToolResult(body)}` }
    const name = toolNames(body).find(tool => tool === called || tool.endsWith(`__${called}`))
    if (name === undefined) return { text: `No tool ${called}.` }
    issued.add(key)
    return { call: name }
  }
  return { text: replyTo(body, command) }
}

export function replyTo(body, said = lastUserText(body)) {
  if (MARKER.test(said)) return 'Noted.'
  if (/\bRECALL\b/.test(said)) {
    const earlier = textsOf(body.messages ?? body.input ?? []).map(text => MARKER.exec(text)?.[1]).find(Boolean)
    return earlier === undefined ? 'I do not know.' : `The marker was ${earlier}.`
  }
  if (/\bTOOLS\b/.test(said)) return `Tools: ${toolNames(body).sort().join(', ') || 'none'}.`
  return 'OK.'
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [event, data] of events) res.write(`${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`)
  res.end()
}

function anthropic(res, body, { text, call }) {
  const usage = { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const message = { id: 'msg_stub', type: 'message', role: 'assistant', model: body.model ?? 'stub', content: [], stop_reason: null, stop_sequence: null, usage }
  if (call !== undefined) {
    const use = { type: 'tool_use', id: `toolu_stub_${calls += 1}`, name: call, input: {} }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...message, content: [use], stop_reason: 'tool_use' }))
      return
    }
    sse(res, [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { ...use, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    return
  }
  if (body.stream !== true) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' }))
    return
  }
  sse(res, [
    ['message_start', { type: 'message_start', message }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

function responses(res, body, { text = '', call }) {
  if (call !== undefined) {
    const item = { id: `fc_stub_${calls += 1}`, type: 'function_call', status: 'completed', call_id: `call_stub_${calls}`, name: call, arguments: '{}' }
    const response = { id: 'resp_stub', object: 'response', status: 'completed', model: body.model ?? 'stub', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }
    sse(res, [
      ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response }],
    ])
    return
  }
  const item = { id: 'msg_stub', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const response = { id: 'resp_stub', object: 'response', status: 'completed', model: body.model ?? 'stub', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
  sse(res, [
    ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response }],
  ])
}

/** Starts the stub on 127.0.0.1 (a free port). `{ url, requests, close }`. */
export async function startModelStub() {
  const requests = []
  const issued = new Set()
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = raw === '' ? {} : JSON.parse(raw) } catch {}
      const path = (req.url ?? '').split('?')[0]
      requests.push({ method: req.method, path, model: body.model, texts: textsOf(body.messages ?? body.input ?? []), lastUser: lastUserText(body), command: commandOf(body).command, tools: toolNames(body) })
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [], models: [] }))
        return
      }
      if (path.endsWith('/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 12 }))
        return
      }
      if (path.endsWith('/messages')) return anthropic(res, body, decideReply(body, issued))
      if (path.endsWith('/responses')) return responses(res, body, decideReply(body, issued))
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'not_found', message: `stub: no ${path}` } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}
