// A transport-neutral row adapter: a native transport supplies text/tool/done rows and
// receives individual approval answers. DSH owns the visible tool cards and level policy.
import { types, isDeepStrictEqual } from 'node:util'
import { LlmAdapter, isAgentLoopRequest, projectFilesToText } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LOST } from './hermes-transport.js'

export const REMOTE_TOOL = 'remote_hermes_tool'
// A carried-over attached chat has no visible row until its first open normalizes the
// record. The attached transport joins Bot Chat without using this model, so a placeholder
// lets that first open happen instead of refusing the turn; the record's real row is
// published by the normalization and is the only row ever listed.
const ATTACHED_PLACEHOLDER = Object.freeze({ id: 'attach', name: 'Hermes', model: '', provider: '' })
export const MISSING_TOOLS = 'Remote Hermes has no Automagik team tools: message_bot, list_bots, create_bot, request_secret, or Automagik memory and schedules. Its tools run remotely under the remote profile’s rules.'
const finish = (kind, message) => ({ type: 'finish', reason: { kind, ...(message ? { failure: { code: 'REMOTE_HERMES', message } } : {}) } })
const service = (ctx, name) => { try { return ctx.get?.(name) } catch { return undefined } }

// What Hermes asks is the person's to answer at every chat level: nothing here says yes or
// no for them. A level that asks shows the chat's approval card. A level that never asks has
// no such card, so the same question goes to the chat as a question with these two answers.
const ALLOW = 'Allow once', DENY = 'Deny'
const asked = params => String(params?.description || params?.command || params?.tool_name || 'Run a remote tool')

async function askInChat(ctx, agent, params, signal) {
  const questions = service(ctx, 'userQuestions')
  if (!questions?.ask) return 'deny'
  try {
    const answer = await questions.ask({ agent, signal, questions: [{
      id: String(params?.request_id ?? 'remote-hermes-approval'),
      question: 'Remote Hermes asks before it runs this. Allow it?', detail: asked(params),
      options: [{ label: ALLOW }, { label: DENY }],
      intent: { kind: 'approval', approve: ALLOW, reject: DENY, subject: { name: 'Remote Hermes' } },
    }] })
    const [picked] = answer?.answers ?? []
    return !picked?.custom && picked?.selected?.length === 1 && picked.selected[0] === ALLOW ? 'once' : 'deny'
  } catch (error) {
    // Classify the failure without logging question text, remote output or credentials.
    const code = ['ASK_ABORTED', 'BAD_INTENT', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER', 'EMPTY_QUESTIONS', 'NO_PROVIDER'].includes(error?.code)
      ? error.code : error instanceof TypeError ? 'TypeError' : 'Error'
    try { ctx.logger?.warn?.('ds-bot: Remote Hermes question failed (%s); the remote tool was denied.', code) } catch {}
    return 'deny'
  }
}

export async function remoteApproval(ctx, agent, params, signal) {
  if (!agent) return 'deny'
  const approval = service(ctx, 'approval')
  let policy
  try { policy = approval?.effectivePolicy?.(agent.session) } catch { policy = undefined }
  if (!approval?.request || policy === undefined || policy === 'never') return askInChat(ctx, agent, params, signal)
  try {
    const answer = await approval.request({ agent, toolName: REMOTE_TOOL, callId: params.request_id, reason: `Remote Hermes: ${asked(params)}`, signal })
    return answer === 'allowed-once' || answer === 'allowed' ? 'once' : 'deny'
  } catch { return 'deny' }
}

function* textBlocks(text, index) {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
}

// Deep-frozen plain data only: an object with its own toJSON, a getter, a Proxy or a class
// prototype could answer one read and behave differently on the next, so it is not a message.
function plainData(value) {
  if (value === null || typeof value !== 'object') return typeof value !== 'function'
  if (types.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
  if (Object.hasOwn(value, 'toJSON') || !Object.isFrozen(value)) return false
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) return false
    if (!plainData(descriptor.value)) return false
  }
  return true
}

// The envelope DSH dispatches for one Session message: a foreign answer that carries replay
// state is rebuilt as a plain model source; everything else is the message itself.
function asDispatched(message, provider) {
  const source = message?.source
  if (message?.role !== 'assistant' || source?.replayState === undefined || source?.provider === provider) return message
  return { ...message, source: { kind: 'model', provider: source.provider, model: source.model } }
}

// The request envelope read once: provider, model, sessionId, purpose, messages and signal
// must be own data properties. An accessor or a Proxy could answer the guard with the
// Session's values and the adapter with others, so only own data is accepted and the stream
// never reads the envelope again after this.
function requestFields(options) {
  if (options === null || typeof options !== 'object') return undefined
  const marked = isAgentLoopRequest(options)
  // The loop always freezes; a marked object is the loop's own, so only an unmarked envelope
  // must prove it is the frozen copy DSH dispatches.
  if (!marked && (types.isProxy(options) || !Object.isFrozen(options))) return undefined
  const field = name => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name)
    if (descriptor === undefined) return { absent: true }
    return 'value' in descriptor ? { value: descriptor.value } : { accessor: true }
  }
  const provider = field('provider'), model = field('model'), sessionId = field('sessionId')
  const messages = field('messages'), purpose = field('purpose'), signal = field('signal')
  const text = entry => entry !== undefined && entry.accessor !== true && typeof entry.value === 'string' && entry.value !== ''
  if (!text(provider) || !text(model) || !text(sessionId) || messages?.accessor === true || !Array.isArray(messages?.value)) return undefined
  if (purpose?.accessor === true || signal?.accessor === true) return undefined
  return { provider: provider.value, model: model.value, sessionId: sessionId.value, purpose: purpose?.value, messages: messages.value, signal: signal?.value, marked }
}

function lastMessage(messages) {
  const length = messages.length
  const message = length > 0 ? messages[length - 1] : undefined
  return { length, message, role: length > 0 ? message.role : undefined }
}

export class RemoteChatAdapter extends LlmAdapter {
  constructor(rt, { open, models, identity, save, enabled, attached = () => false }) {
    super()
    Object.assign(this, { rt, open, models, identity, save, enabled, attached })
    this.live = new Map()
    this.registrations = new Map()
    this.mirror = defineTool({
      name: REMOTE_TOOL,
      description: 'Displays a remote Hermes tool and waits for its result. Does not run an Automagik tool.',
      parameters: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, input: { type: 'json' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', required: true }, kind: { type: 'string', required: true }, status: { type: 'string', required: true }, text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text || `${value.title}: ${value.status}` }],
        presentationMeta: (_args, value) => value,
      },
      execute: async (args, exec) => {
        const run = this.live.get(exec.agent?.session?.id)?.run
        const tool = run?.tools.get(args.id)
        if (!tool) return { title: args.title, kind: 'other', status: 'unknown', text: LOST }
        if (tool.status === 'running') await new Promise(resolve => {
          const abort = () => { void run.stop(); done() }
          const done = () => { exec.signal?.removeEventListener('abort', abort); resolve() }
          tool.done = done
          exec.signal?.addEventListener('abort', abort, { once: true })
          if (exec.signal?.aborted) abort()
        })
        return { title: tool.title, kind: 'other', status: tool.status, text: tool.text ?? '' }
      },
      presentCall: args => ({ card: 'generic', title: args.title, rawInput: args.input }),
      presentResult: (args, result) => ({ card: 'generic', title: args.title, content: result?.content ?? [] }),
    })
    const register = agent => {
      if (!this.enabled() || typeof agent?.ctx?.tools?.register !== 'function' || this.registrations.has(agent)) return
      this.registrations.set(agent, agent.ctx.tools.register(this.mirror, {
        when: ({ modelSelection }) => modelSelection?.provider === 'hermes-remote',
      }))
    }
    this.register = register
    this.registerAll = () => { for (const agent of service(rt.ctx, 'agents')?.list?.() ?? []) register(agent) }
    rt.ctx.on?.('agent/created', ({ agent }) => register(agent))
    this.registerAll()
  }

  providerInfo(provider) { return { id: provider, name: 'Remote Hermes' } }
  async listModels(provider) { return this.enabled() ? this.models().map(model => ({ id: model.id, name: model.name, provider })) : [] }
  // DSH's compaction guard prices a model switch through this exact-model result. The
  // attached row's own window must reach it, or the guard throws before it can measure
  // the carried-over chat. A carried-over ref is served by that same one row, so it is
  // priced there too.
  async resolveModel(provider, id) {
    const rows = this.models()
    const row = rows.find(model => model.id === id) ?? (this.attached() ? rows[0] : undefined)
    return {
      provider,
      id,
      name: row?.name ?? id,
      ...(Number.isInteger(row?.contextWindow) && row.contextWindow > 0 ? { context: { contextWindow: row.contextWindow } } : {}),
    }
  }

  // DSH dispatches a loop request as itself unless it must project it: the projections here
  // strip developer notes (tool-set changes) and turn file blocks into text handles, and the
  // dispatch hands the adapter a new deep-frozen envelope. The loop's marker is a WeakSet
  // identity a copy cannot carry, so the adapter rebuilds the same projection from the live
  // Session and accepts only that exact sequence, in order, on the Session's own route.
  // A subset, a reordering, a rebuilt message with new text, or a new text under an old id
  // is not that turn and is refused.
  static ownTurn(options, agent, filePath = () => undefined) {
    const request = requestFields(options)
    return request !== undefined && RemoteChatAdapter.ownTurnFields(request, agent, filePath)
  }

  static ownTurnFields(request, agent, filePath = () => undefined) {
    if (request.marked) return true
    if (request.purpose !== undefined || request.messages.length === 0) return false
    let header
    try { header = agent?.session?.requestHeader?.() } catch { return false }
    if (header?.config?.provider !== request.provider || header?.config?.model !== request.model) return false
    let derived
    try { derived = agent.session.deriveMessages?.() } catch { return false }
    if (!Array.isArray(derived)) return false
    let expected
    try { expected = projectFilesToText(derived.filter(message => message?.role !== 'developer'), filePath) } catch { return false }
    if (expected.length !== request.messages.length || expected.length === 0) return false
    // Only deep-frozen plain data: no toJSON, accessors, Proxies or class instances can make one
    // read (this comparison) differ from the next (the text the adapter actually submits).
    if (!plainData(request.messages)) return false
    const want = expected.map(message => asDispatched(message, request.provider))
    if (!want.every((message, index) => isDeepStrictEqual(request.messages[index], message))) return false
    // The payload itself, read exactly as the stream reads it, must be that turn's text.
    return RemoteChatAdapter.promptText(request.messages) === RemoteChatAdapter.promptText(expected)
  }

  // The text one request submits to the remote: the trailing run of person messages.
  static promptText(messages, last = lastMessage(messages)) {
    const trailing = []
    let { length, message, role } = last
    while (length > 0 && role === 'user') {
      trailing.push(message)
      if (--length === 0) break
      message = messages[length - 1]
      role = message.role
    }
    return trailing.reverse().filter(message => message.source?.kind !== 'acp-session').map(message => {
      const content = message.content
      return typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    }).join('\n\n')
  }

  // The runtime's own read path for a durable file reference, so the same projection can be
  // rebuilt here from the live Session.
  filePath(ref) {
    let hostPath
    try { hostPath = service(this.rt.ctx, 'attachments')?.fileHostPath?.(ref) } catch { return undefined }
    if (hostPath === undefined) return undefined
    return service(this.rt.ctx, 'fs')?.processPathFromHostPath?.(hostPath)
  }

  async *stream(options) {
    const request = requestFields(options)
    if (!this.enabled() || !request) return yield finish('error', 'Remote Hermes answers only enabled Bot chat sessions.')
    const agent = service(this.rt.ctx, 'agents')?.get?.(request.sessionId)
    if (!RemoteChatAdapter.ownTurnFields(request, agent, ref => this.filePath(ref))) return yield finish('error', 'Remote Hermes answers only enabled Bot chat sessions.')
    if (!agent) return yield finish('error', 'Remote Hermes needs a live Automagik chat to show its tools and approvals.')
    this.register(agent)
    let entry = this.live.get(request.sessionId)
    let index = 0
    let complete = false
    let yieldedTool = false
    const stop = () => { entry?.abortWake?.(); if (entry) void entry.run.stop() }
    request.signal?.addEventListener('abort', stop, { once: true })
    try {
      // Read once before opening: a marked list can change between reads.
      const messages = request.messages
      let last, continuing = false, failed = false, prompt
      try {
        last = lastMessage(messages)
        const toolCallId = last.role === 'tool' ? last.message.toolCallId : undefined
        continuing = last.role === 'tool' && entry?.calls.has(toolCallId)
      } catch { failed = true }
      if (!continuing && entry) { entry.run.dispose(); this.live.delete(request.sessionId); entry = undefined }
      if (failed) return yield finish('error', 'Remote Hermes answers only enabled Bot chat sessions.')
      if (!continuing) {
        try { prompt = { text: RemoteChatAdapter.promptText(messages, last) } } catch { prompt = { failed: true } }
      }
      if (request.signal?.aborted) return yield finish('aborted', 'Stopped before a remote submit.')
      if (!entry) {
        const identity = this.identity(request.sessionId)
        const run = await this.open({ identity, save: this.save, signal: request.signal, question: (params, withdrawn) => remoteApproval(this.rt.ctx, agent, params, AbortSignal.any([request.signal, withdrawn].filter(Boolean))) })
        entry = { run, calls: new Set() }
        this.live.set(request.sessionId, entry)
        if (request.signal?.aborted) return yield finish('aborted', 'Stopped before a remote submit.')
        if (identity.pendingSubmit || identity.uncertain) {
          const reconciled = await run.reconcile({ answerQuestions: true })
          run.takeRecovered?.()
          yield* textBlocks('Resuming the existing remote turn. This new message was not submitted.', index++)
          if (reconciled.snapshot.inflight?.assistant) {
            run.streamed = reconciled.snapshot.inflight.assistant
            yield* textBlocks(run.streamed, index++)
          }
          if (!reconciled.unknown) {
            const last = reconciled.snapshot.messages?.filter(message => message.role === 'assistant').at(-1)
            const recovered = typeof last?.text === 'string' ? last.text : last?.content
            if (!reconciled.snapshot.inflight?.assistant && typeof recovered === 'string') yield* textBlocks(recovered, index++)
            complete = true
            return yield finish('stop')
          }
        } else {
        // An attached connection has one row: the bot's own model. A carried-over
        // old ref is replaced by that row, never sent as a model or a provider. Before
        // the first connect there is no visible row yet; a placeholder lets that first
        // open normalize the record, and the attached transport ignores the model.
        const rows = this.models()
        const model = rows.find(model => model.id === request.model) ?? (this.attached() ? rows[0] ?? ATTACHED_PLACEHOLDER : undefined)
        if (!model) { complete = true; return yield finish('error', 'Discover this remote model again before using it.') }
        // Recovery above does not need this new message's text.
        if (prompt.failed) return yield finish('error', 'Remote Hermes answers only enabled Bot chat sessions.')
        const { text } = prompt
        if (!text) return yield finish('error', 'Remote Hermes accepts text in this delivery.')
        // Prompts never contain the standing credential or a transient ticket.
        await run.submit(run.transport.redact(text), model)
        for (const text of run.takeRecovered?.() ?? []) yield* textBlocks(text, index++)
        }
      }
      for (;;) {
        const row = await Promise.race([entry.run.next(), new Promise(resolve => {
          if (request.signal?.aborted) resolve({ kind: 'error', text: LOST })
          else entry.abortWake = () => resolve({ kind: 'error', text: LOST })
        })])
        if (row.kind === 'text') yield* textBlocks(row.text, index++)
        if (row.kind === 'tool') {
          const id = `hermes-${row.tool.id}`
          entry.calls.add(id)
          const args = JSON.stringify({ id: row.tool.id, title: row.tool.title, input: row.tool.input })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: REMOTE_TOOL, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: REMOTE_TOOL, arguments: args } }
          yieldedTool = true
          return yield finish('tool-calls')
        }
        if (row.kind === 'error') return yield finish('error', row.text)
        if (row.kind === 'aborted') { complete = true; return yield finish('aborted', row.text) }
        if (row.kind === 'done') { complete = true; return yield finish('stop') }
      }
    } catch (error) {
      yield finish('error', error?.code === 'bot/hermes-busy' ? 'A chat is still running on this connection; stop it or wait.' : ['bot/hermes', 'bot/hermes-pairing', 'bot/hermes-attach-profile'].includes(error?.code) ? error.message : 'Remote Hermes could not complete this turn. Reconcile the remote session before sending again.')
    } finally {
      request.signal?.removeEventListener('abort', stop)
      if (entry && !yieldedTool) {
        this.live.delete(request.sessionId)
        if (!complete && entry.run.identity.pendingSubmit) await entry.run.stop()
        else await entry.run.close()
      }
    }
  }

  dispose() {
    for (const entry of this.live.values()) void entry.run.stop()
    this.live.clear()
    for (const dispose of this.registrations.values()) dispose?.()
    this.registrations.clear()
  }
}
