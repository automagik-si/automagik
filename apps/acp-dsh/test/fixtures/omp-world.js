import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, SERVICE } from '../../index.js'
import { AgentRun } from '../../src/host/acp.js'
import { adaptersHome, AdapterStore } from '../../src/host/install.js'

export const OMP = 'acp-omp'
export const HERMES = 'acp-hermes'
export const ownerMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
export const textBlocks = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => chunk.block.text)

const windows = process.platform === 'win32'
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const fake = pathToFileURL(join(import.meta.dirname, '../../dev/fake-agent.mjs')).href

function recordingCli(dir, provider, trace) {
  const script = join(dir, provider + '.mjs')
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs'",
    `process.env.FAKE_ACP_TRACE = ${JSON.stringify(trace)}`,
    "process.env.FAKE_ACP_MODES = 'default'",
    `const env = Object.fromEntries(['PI_AUTO_QA', 'PI_CODING_AGENT_DIR', 'HOME', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key] ?? null]))`,
    `appendFileSync(process.env.FAKE_ACP_TRACE, JSON.stringify({ event: 'env', pid: process.pid, provider: ${JSON.stringify(provider)}, env }) + '\\n')`,
    `await import(${JSON.stringify(fake)})`,
  ].join('\n'))
  const path = join(dir, provider + (windows ? '.cmd' : ''))
  const command = windows
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`
  writeFileSync(path, command, { mode: 0o755 })
  return path
}

export function ompWorld(t, { sandbox = true, overlay, storeHome = true, otherProvider = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-world-'))
  const trace = join(dir, 'trace.ndjson')
  const agents = new Map()
  const approvals = []
  const services = {
    approval: { effectivePolicy: () => 'ask', request: async request => { approvals.push(request); return 'allowed-once' } },
    ...(sandbox ? { sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: ({ session }) => ({ mode: session?.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write' }),
    } } : {}),
  }
  const clis = { omp: recordingCli(dir, OMP, trace) }
  if (otherProvider) clis.hermes = recordingCli(dir, HERMES, trace)
  const disposers = []
  const listeners = new Map()
  let adapter
  const ctx = {
    logger: { warn() {}, info() {} },
    llm: { registerAdapter: (_providers, candidate) => { adapter = candidate; return () => {} } },
    agents: { get: id => agents.get(id), turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: name => services[name],
    on: (name, listener) => {
      const callbacks = listeners.get(name) ?? new Set()
      callbacks.add(listener)
      listeners.set(name, callbacks)
      return () => callbacks.delete(listener)
    },
    effect: fn => { disposers.push(fn()) },
    provide: (name, service) => { services[name] = service },
    emit() {},
  }
  const injected = overlay?.(dir)
  const store = storeHome
    ? new AdapterStore({ home: adaptersHome({ AUTOMAGIK_HOME: join(dir, 'state') }) })
    : { binOf: () => undefined, stateOf: () => undefined, dispose() {} }
  apply(ctx, { claude: false, codex: false, omp: true, hermes: otherProvider, dshTools: true }, {
    store,
    cliHome: join(dir, 'cli'),
    find: name => clis[name],
    signedIn: async () => undefined,
    ...(storeHome ? {} : { catalogHome: join(dir, 'state', 'acp', 'catalog') }),
    ...(injected === undefined ? {} : { ompOverlayDir: injected }),
  })
  t.after(() => { for (const dispose of disposers) dispose(); rmSync(dir, { recursive: true, force: true }) })
  const service = services[SERVICE]
  const events = (event) => {
    let rows
    try { rows = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return event === undefined ? rows : rows.filter(row => row.event === event)
  }
  function conversation(marker) {
    const prompts = events('prompt').filter(row => row.text.includes(marker))
    assert.equal(prompts.length, 1, marker)
    const { pid } = prompts[0]
    const child = events().filter(row => row.pid === pid)
    return {
      pid, args: child.find(row => row.event === 'start').args,
      env: child.find(row => row.event === 'env').env,
      servers: child.find(row => row.event === 'new-session').servers,
      prompt: prompts[0].text,
    }
  }
  function chat(id = 'chat') {
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const agent = { session, ctx: { tools: { register: () => () => {} } } }
    agents.set(id, agent)
    const history = []
    async function stream({ model = 'default', provider = OMP, messages = session.deriveMessages(), signal } = {}) {
      const chunks = []
      for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model, sessionId: id, messages, signal }))) chunks.push(chunk)
      return chunks
    }
    async function turn(message, provider = OMP) {
      history.push(typeof message === 'string' ? ownerMessage(message) : message)
      for (let step = 0; step < 4; step++) {
        const chunks = await stream({ provider, messages: [...history] })
        const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
        history.push({ role: 'assistant', source: { kind: 'model', provider, model: 'default' }, content })
        const calls = content.filter(block => block.type === 'tool-call')
        if (calls.length === 0) return chunks
        for (const call of calls) {
          const result = await adapter.tool.execute(JSON.parse(call.arguments), { agent, callId: call.id, signal: new AbortController().signal })
          history.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: result.text }] })
        }
      }
      assert.fail('the fake did not finish its turn')
    }
    function policyEvent(type, data) {
      const event = session.append(type, data)
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    }
    return { session, stream, turn, policyEvent }
  }
  const overlayPath = join(injected ?? join(dir, 'state', 'acp', 'omp'), 'native-off.yml')
  return { dir, adapter, service, events, conversation, approvals, services, chat, overlayPath }
}

export const offArgs = path => ['acp', '--no-tools', '--no-extensions', '--no-lsp', '--config', path]

// Keep the real process in run.start() after session/new, with its startup Stop still armed.
export function holdOmpStart(t, h, id) {
  const ready = Promise.withResolvers()
  const release = Promise.withResolvers()
  const runs = []
  const start = AgentRun.prototype.start
  t.mock.method(AgentRun.prototype, 'start', function (options) {
    if (h.adapter.live.get(id)?.run === this && this.spec.provider === OMP) {
      runs.push(this)
      if (runs.length === 1) {
        const onReady = this.spec.onReady
        this.spec.onReady = async () => {
          await onReady?.(this)
          ready.resolve(this)
          await release.promise
        }
      }
    }
    return start.call(this, options)
  })
  return {
    runs,
    async run(answer) {
      const run = await Promise.race([ready.promise, answer.then(() => assert.fail('the turn ended before the chat child was held'))])
      assert.deepEqual(h.events('start').find(row => row.pid === run.child.pid)?.args, ['acp'])
      return run
    },
    release: release.resolve,
  }
}
