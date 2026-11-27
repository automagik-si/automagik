#!/usr/bin/env node
// The per-session MCP bridge (RFC 0003, amendment, "The bridge"). The ACP agent's
// adapter spawns this process itself and speaks MCP to it over stdio, so there is no listen
// socket on this leg: the only way in is the adapter's pipe. Its tools are DSH's, reached over
// the loopback back-channel to acp-dsh with the credential minted for this session; DSH executes
// them, asks its own approval, and writes the Session's tool rows.
//
// Plain Node and its builtins only: this file runs as the agent's child, outside a DSH profile,
// so it must not import the plugin's peers or the ACP SDK. It speaks newline-delimited JSON-RPC
// (MCP). `server/discover` is answered `-32601`, as the spike shows both adapters then fall back
// to the 2025-06-18/2025-11-25 handshake.
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { createInterface } from 'node:readline'

const CREDENTIAL = process.env.DSH_BRIDGE_CREDENTIAL
const ATTACHMENT = randomBytes(16).toString('hex')
const URL = process.env.DSH_BRIDGE_URL
const nameFlag = process.argv.indexOf('--server-name', 2)
const serverName = nameFlag === -1 ? 'dsh' : process.argv[nameFlag + 1]
if (serverName !== 'dsh' && (serverName?.length !== 13 || !/^dsh[a-z2-7]{10}$/.test(serverName))) {
  process.stderr.write('acp-dsh bridge: invalid --server-name\n')
  process.exit(2)
}
const WAIT_MS = 20_000
// The deadline of a short exchange (`list`, `hello`, `bye`). A `call` has none: DSH runs the
// tool for as long as it takes (a long wait, a slow command, an approval dialog left open), and
// a bridge that gave up first left DSH running a call nobody was waiting for (#957).
const RPC_MS = Number(process.env.DSH_BRIDGE_RPC_TIMEOUT_MS) > 0 ? Number(process.env.DSH_BRIDGE_RPC_TIMEOUT_MS) : 60_000

if (typeof CREDENTIAL !== 'string' || CREDENTIAL === '' || typeof URL !== 'string' || URL === '') {
  process.stderr.write('acp-dsh bridge: DSH_BRIDGE_CREDENTIAL and DSH_BRIDGE_URL are required\n')
  process.exit(2)
}

let generation = 0
let listed = false
let listingStarted = false
let probed = false
let stopped = false

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })
const notify = (method, params) => write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })

const CANCELLED = Symbol('cancelled')

class Fatal extends Error {}
class Refused extends Error {}

// One exchange with the back-channel. Node's own `fetch` cannot carry a call: it has a fixed
// five-minute wait for the answer's headers, so this is a plain HTTP request on a socket of its
// own (no pooled socket, no idle timeout). `signal` ends the exchange early: the back-channel
// sees the request close and stops the call.
function rpc(op, payload = {}, { signal } = {}) {
  const deadline = op === 'call' ? undefined : op === 'wait' ? WAIT_MS + 10_000 : RPC_MS
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ op, ...payload })
    let timer
    const fail = (error) => {
      clearTimeout(timer)
      reject(error instanceof Fatal ? error : new Refused(`back-channel unreachable: ${error?.message ?? error}`))
    }
    let outgoing
    try {
      outgoing = request(URL, {
        method: 'POST',
        agent: false,
        headers: {
          authorization: `Bearer ${CREDENTIAL}`,
          'x-dsh-bridge-attachment': ATTACHMENT,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        ...(signal === undefined ? {} : { signal }),
      }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', fail)
        response.on('end', () => {
          clearTimeout(timer)
          if (response.statusCode === 401) return reject(new Fatal('the bridge credential is not valid for this Session'))
          if (response.statusCode < 200 || response.statusCode > 299) return reject(new Refused(`back-channel answered ${response.statusCode}`))
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            fail(error)
          }
        })
      })
    } catch (error) {
      return fail(error)
    }
    if (deadline !== undefined) {
      timer = setTimeout(() => outgoing.destroy(new Error('timed out')), deadline)
      timer.unref?.()
    }
    outgoing.on('error', fail)
    outgoing.end(body)
  })
}

async function tools() {
  listingStarted = true
  const answer = await rpc('list')
  if (typeof answer.generation === 'number') generation = answer.generation
  listed = true
  return Array.isArray(answer.tools) ? answer.tools : []
}

async function readList() {
  try {
    return await tools()
  } catch (error) {
    if (error instanceof Fatal) {
      process.stderr.write(`acp-dsh bridge: ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

// The calls in flight, by their JSON-RPC request id, so `notifications/cancelled` can end one.
const inflight = new Map()

async function call(params, requestId) {
  const name = typeof params?.name === 'string' ? params.name : ''
  if (name === '') return { content: [{ type: 'text', text: 'The bridge needs a tool name.' }], isError: true }
  const controller = new AbortController()
  inflight.set(requestId, controller)
  let answer
  try {
    const callId = typeof params._meta?.callId === 'string' ? params._meta.callId : undefined
    answer = await rpc('call', { name, arguments: params.arguments ?? {}, callId,
      ...((name === 'load_skill' || name === 'read_own_chat') && callId === undefined && { requestId }),
    }, { signal: controller.signal })
  } catch (error) {
    // A cancelled request gets no response (MCP): the agent already stopped waiting for it.
    if (controller.signal.aborted) return CANCELLED
    throw error
  } finally {
    inflight.delete(requestId)
  }
  const content = Array.isArray(answer.content) ? answer.content : []
  return { content: content.length > 0 ? content : [{ type: 'text', text: '' }], isError: answer.isError === true }
}

// Announce every new list the back-channel reports, but only after the first list was served:
// the spike's ordering rule (a `list_changed` before `session/new` answered produced no re-list;
// the plugin holds `announced` until then, so this loop simply never sees one early).
async function poll() {
  let last = generation
  while (!stopped) {
    let answer
    try {
      answer = await rpc('wait', { generation: last, timeoutMs: WAIT_MS })
    } catch (error) {
      if (error instanceof Fatal) return process.exit(1)
      await new Promise((resolve) => setTimeout(resolve, 1000).unref?.())
      continue
    }
    if (answer.closed === true) return stop()
    if (typeof answer.generation === 'number' && answer.generation > last) {
      last = answer.generation
      if (listed) notify('notifications/tools/list_changed')
    }
  }
}

function stop() {
  if (stopped) return
  stopped = true
  try {
    process.stdin.pause()
  } catch {}
  // omp closes its probe after falling back to initialize. Its next process will list the
  // tools, so the probe must leave the back-channel waiting for that first list.
  if (probed && !listingStarted) return process.stdout.write('', () => process.exit(0))
  // Let the last reply flush before leaving; `bye` is best effort.
  rpc('bye').catch(() => {}).finally(() => process.exit(0))
}

const handlers = {
  async initialize(params) {
    return {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: serverName, version: '1' },
    }
  },
  async ping() {
    return {}
  },
  async 'tools/list'() {
    return { tools: await readList() }
  },
  async 'tools/call'(params, requestId) {
    return call(params, requestId)
  },
}

async function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string') return
  const id = message.id
  // Notifications (no id) are acknowledged by doing nothing, except `notifications/cancelled`:
  // the agent stopped waiting for that call, so its request to DSH is closed and DSH stops it.
  if (id === undefined) {
    if (message.method === 'notifications/cancelled') inflight.get(message.params?.requestId)?.abort()
    return
  }
  if (message.method === 'shutdown') {
    reply(id, null)
    return stop()
  }
  if (message.method === 'server/discover') {
    probed = true
    return fail(id, -32601, 'method not found: server/discover')
  }
  const handler = handlers[message.method]
  if (handler === undefined) {
    return fail(id, -32601, `method not found: ${message.method}`)
  }
  try {
    const result = await handler(message.params, id)
    if (result === CANCELLED) return
    reply(id, result)
    if (message.method === 'tools/list' && !stopped) void poll()
  } catch (error) {
    if (error instanceof Fatal) {
      process.stderr.write(`acp-dsh bridge: ${error.message}\n`)
      process.exit(1)
    }
    fail(id, -32603, `bridge failed: ${error?.message ?? error}`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (line.trim() === '') return
  void handle(line)
})
lines.on('close', () => stop())
process.on('SIGTERM', () => stop())
process.on('SIGINT', () => stop())
