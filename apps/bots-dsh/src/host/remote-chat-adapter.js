// A transport-neutral row adapter: a native transport supplies text/tool/done rows and
// receives individual approval answers. DSH owns the visible tool cards and level policy.
import { LlmAdapter, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LOST } from './hermes-transport.js'

export const REMOTE_TOOL = 'remote_hermes_tool'
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

export class RemoteChatAdapter extends LlmAdapter {
  constructor(rt, { open, models, identity, save, enabled }) {
    super()
    Object.assign(this, { rt, open, models, identity, save, enabled })
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
  async resolveModel(provider, id) { return { provider, id, name: this.models().find(model => model.id === id)?.name ?? id } }

  // DSH dispatches a loop request as itself unless it must project it (developer messages or
  // a tool update): the dispatch then hands the adapter a new deep-frozen envelope, and the
  // loop's marker is a WeakSet identity that a copy cannot carry. What still proves the call
  // is the Bot's own turn is the envelope being frozen, on the Session's current route, over
  // that Session's own message objects; a hand-built call beside the chat carries new ones.
  static ownTurn(options, agent) {
    if (isAgentLoopRequest(options)) return true
    if (!Object.isFrozen(options) || options.purpose !== undefined || !Array.isArray(options.messages) || options.messages.length === 0) return false
    const header = agent?.session?.requestHeader?.()
    if (header?.config?.provider !== options.provider || header?.config?.model !== options.model) return false
    let derived
    try { derived = agent.session.deriveMessages?.() } catch { return false }
    if (!Array.isArray(derived) || derived.length === 0) return false
    const own = new Set(derived), ids = new Set(derived.map(message => message?.id).filter(id => typeof id === 'string'))
    // A projection that rebuilt a message (file or image projection) keeps its id.
    return options.messages.every(message => own.has(message) || (typeof message?.id === 'string' && ids.has(message.id)))
  }

  async *stream(options) {
    if (!this.enabled() || !options.sessionId) return yield finish('error', 'Remote Hermes answers only enabled Bot chat sessions.')
    const agent = service(this.rt.ctx, 'agents')?.get?.(options.sessionId)
    if (!RemoteChatAdapter.ownTurn(options, agent)) return yield finish('error', 'Remote Hermes answers only enabled Bot chat sessions.')
    if (!agent) return yield finish('error', 'Remote Hermes needs a live Automagik chat to show its tools and approvals.')
    this.register(agent)
    let entry = this.live.get(options.sessionId)
    const continuing = options.messages.at(-1)?.role === 'tool' && entry?.calls.has(options.messages.at(-1)?.toolCallId)
    if (!continuing && entry) { entry.run.dispose(); this.live.delete(options.sessionId); entry = undefined }
    let index = 0
    let complete = false
    let yieldedTool = false
    const stop = () => { entry?.abortWake?.(); if (entry) void entry.run.stop() }
    options.signal?.addEventListener('abort', stop, { once: true })
    try {
      if (options.signal?.aborted) return yield finish('aborted', 'Stopped before a remote submit.')
      if (!entry) {
        const identity = this.identity(options.sessionId)
        const run = await this.open({ identity, save: this.save, signal: options.signal, question: (params, withdrawn) => remoteApproval(this.rt.ctx, agent, params, AbortSignal.any([options.signal, withdrawn].filter(Boolean))) })
        entry = { run, calls: new Set() }
        this.live.set(options.sessionId, entry)
        if (options.signal?.aborted) return yield finish('aborted', 'Stopped before a remote submit.')
        if (identity.pendingSubmit || identity.uncertain) {
          const reconciled = await run.reconcile({ answerQuestions: true })
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
        const model = this.models().find(model => model.id === options.model)
        if (!model) { complete = true; return yield finish('error', 'Discover this remote model again before using it.') }
        let start = options.messages.length
        while (start > 0 && options.messages[start - 1].role === 'user') start--
        const text = options.messages.slice(start).filter(message => message.source?.kind !== 'acp-session').map(message =>
          typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n\n')
        if (!text) return yield finish('error', 'Remote Hermes accepts text in this delivery.')
        // Prompts never contain the standing credential or a transient ticket.
        await run.submit(run.transport.redact(text), model)
        }
      }
      for (;;) {
        const row = await Promise.race([entry.run.next(), new Promise(resolve => {
          if (options.signal?.aborted) resolve({ kind: 'error', text: LOST })
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
      yield finish('error', error?.code === 'bot/hermes-busy' ? 'A chat is still running on this connection; stop it or wait.' : error?.code === 'bot/hermes' ? error.message : 'Remote Hermes could not complete this turn. Reconcile the remote session before sending again.')
    } finally {
      options.signal?.removeEventListener('abort', stop)
      if (entry && !yieldedTool) {
        this.live.delete(options.sessionId)
        if (!complete && entry.run.identity.pendingSubmit) await entry.run.stop()
        else entry.run.dispose()
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
