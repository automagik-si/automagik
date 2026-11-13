// ACP agents as DSH models. Each agent is a provider route whose models and reasoning efforts
// are the agent's own (catalog.js); the chosen ones are set on its session before each prompt,
// with the permission mode. A DSH turn on it is
// one ACP prompt to that Session's agent process: its words stream as text, its thoughts as
// reasoning, and each of its tool calls ends the model step with a call to the mirror tool
// (tool.js), so DSH shows the card and asks for approval. The next step drains what the agent
// said since. DSH keeps the Session, its history and the sidebar.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { LlmAdapter, boundContextSummary, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AgentRun, isStopped, isUnanswered, valuesOf, waited } from './acp.js'
import { recordDrift } from './backchannel.js'
import { DEFAULT_MODEL } from './catalog.js'
import { SessionFiles, restrictedLevel } from './session-files.js'
import { chatProfileModes } from './codex-chat-profiles.js'
import { BRIDGE_NAME, CREDENTIAL_ENV, isAuthRequired, MODEL_ACCESS_REQUIRED, SYNTHETIC_KIND, URL_ENV } from './names.js'
import { shownText } from './shown-text.js'
import { agentRoute, answered, boundaryNotice, isHandoff, lastProviderOf, missedBy, replayBlocks, turnStart } from './switch.js'
import { ImageLinks, savedPathsOf } from './agent-image.js'
import { callArguments, entered, levelOf, mirrorTool, reviewed, TOOL_NAME } from './tool.js'
import { guardSession } from './write-guard.js'

// How long a prompt has to end after it was asked to stop. `session/cancel` is a notification:
// nothing says the agent took it, and one that ignores it would stay busy for good.
export const CANCEL_WAIT_MS = 5000
// A bridge that never listed its tools fails the turn: codex-acp skips a server whose name the
// person's own Codex config defines, and a Session must not run with half a tool set.
const BRIDGE_READY_MS = 15_000
const BRIDGE_READY_POLL_MS = 25
// The MCP bridge script, spawned by the adapter as a child of its own.
export const BRIDGE_PATH = fileURLToPath(new URL('./bridge.js', import.meta.url))
// An agent may announce a call before it says what the call does (Claude Code's adapter sends
// the command in an update right after): the card waits this long for it.
const DETAIL_WAIT_MS = 1500
// How long the turn gates (`acpAgents.holdTurns`) get to answer before a step. A gate normally
// answers from memory; the Bot team's may try to set a level again first (one Session resolve
// and one preset write). Beside this adapter's other waits (5 s for a cancel, 15 s for a
// bridge) ten seconds is ample, and running out only refuses the one step.
export const OWN_MODE_WAIT_MS = 2_000
export const HOLD_WAIT_MS = 10_000
/** What a held Session's step answers when no gate gave a sentence of its own (it threw, never answered, or answered nothing readable). */
export const HELD_TEXT = 'This conversation is on hold while its permission level is checked, so the agent is not running here. Send the message again in a moment.'

// The exact disposer of the mirror-tool registration a Session agent carries. It lives on the
// agent, never in this module: a plugin reload replaces the module and the adapter while the
// agent and its scoped tools live on, so the next adapter must find and replace the registration
// the previous one made. A Symbol.for key is the same key in the reloaded module.
const MIRROR_REGISTRATION = Symbol.for('@automagik/acp-dsh/mirror-registration')

const detailed = tool => (tool.rawInput !== undefined && tool.rawInput !== null && Object.keys(tool.rawInput).length > 0) || tool.permission !== undefined || tool.status !== 'pending'
function settle(tool, ms) {
  if (detailed(tool)) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      tool.listeners.delete(check)
      resolve()
    }
    const check = () => { if (detailed(tool)) done() }
    const timer = setTimeout(done, ms)
    tool.listeners.add(check)
  })
}

const failure = (message, code = 'ACP_AGENT') => ({ message, code })
// What a turn that fails says is shown in the chat, and much of it is somebody else's words:
// the end of an agent's stderr, an error of its protocol, a model id it advertised. Every
// message goes out through `shownText` (credential shapes masked, the home folder as `~`), here,
// in the one place a step's end is built, whatever built the sentence (#970).
const finish = (kind, message, code) => ({ type: 'finish', reason: message === undefined ? { kind } : { kind, failure: failure(typeof message === 'string' ? shownText(message) : message, code) } })
const FINISH = { end_turn: 'stop', max_tokens: 'max-tokens', max_turn_requests: 'stop', refusal: 'stop' }
// An agent whose CLI is not signed in says so with ACP's `auth_required`, at the start of its
// session or of a prompt. The turn fails with its own code, never ACP_AGENT: a sign-in answers
// it, another model does not (the Bot team never falls back on it).
// An agent with no sign-in in the app (`signInHint`, agents.js) names its own terminal command.
const signInFailure = (agent, error) => finish('error', typeof agent.signInHint === 'string' && agent.signInHint !== ''
  ? `${agent.name} is not signed in. Run \`${agent.signInHint}\` in a terminal, then send again.`
  : `${agent.name} is not signed in: ${error?.message ?? error}`, MODEL_ACCESS_REQUIRED)
const STOPPED = () => finish('aborted', 'Stopped', 'ABORTED')

/**
 * What the person reads when the agent did not answer in time. A start that hangs is usually a
 * CLI waiting for the person (a first-run question, a keychain dialog, an update), so it says
 * where to look; any later request ended the session, so it says the next message starts one.
 * @param {string} name the agent's name
 * @param {string} doing `starting`, or what was asked of it before the prompt
 * @param {number} ms how long it had
 */
export function unansweredText(name, doing, ms) {
  if (doing === 'starting') return `${name} did not answer while starting (${waited(ms)}). Open it once in a terminal to check it is not waiting for you, then send again.`
  return `${name} did not answer while ${doing} (${waited(ms)}), so its session was ended. Send again to start a new one.`
}

// Resolves after `ms` on `timers`, or as soon as `signal` aborts; `clear` withdraws both.
function pause(ms, signal, timers) {
  let clear
  const done = new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', resolve, { once: true })
    clear = () => {
      timers.clearTimeout(timer)
      signal?.removeEventListener('abort', resolve)
    }
    if (signal?.aborted) resolve()
  })
  return { done, clear }
}

// The blocks of one model step: text and reasoning open as they come, close before a tool call.
class Blocks {
  constructor() { this.index = 0; this.open = undefined }
  *add(type, text) {
    if (this.open?.type !== type) {
      yield* this.close()
      this.open = { type, index: this.index++, text: '' }
      yield { type: 'block-start', index: this.open.index, blockType: type }
    }
    this.open.text += text
    yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: this.open.index, text }
  }
  *close() {
    if (this.open === undefined) return
    const { type, index, text } = this.open
    this.open = undefined
    yield { type: 'block-end', index, block: { type, text } }
  }
  *toolCall(id, name, args) {
    yield* this.close()
    const index = this.index++
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
  }
}

const textOf = content => (typeof content === 'string' ? content : (content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n'))

/** The source kind of the row that says a new agent session does not see the chat before it. */
export const NOTICE_KIND = 'acp-session'

/**
 * The chat row that says the agent is a new session and has not seen the chat's earlier
 * messages: a user-role notice DSH draws as a one-line row outside the reply, never reply text.
 * @param {string} name the agent's name
 */
export function freshSessionNotice(name) {
  const summary = `A new ${name} session: it does not see this chat's earlier messages`
  return createUserMessage({
    content: [{ type: 'text', text: `[${summary}.]` }],
    source: { kind: NOTICE_KIND, form: 'notice', summary: boundContextSummary(summary) },
  })
}

/**
 * The chat row that says the Session's level is not applied to this agent: it has no mode DSH
 * knows how to set (`modeFor`, agents.js), so it runs under its own permission settings.
 * Written once per agent session, the same kind of row as the new-session notice.
 * @param {string} name the agent's name
 */
export function ownPermissionsNotice(name) {
  const summary = `${name} runs under its own permission settings: this chat's level is not applied to it`
  return createUserMessage({
    content: [{ type: 'text', text: `[${summary}.]` }],
    source: { kind: NOTICE_KIND, form: 'notice', summary: boundContextSummary(summary) },
  })
}

// What the person said this turn: the user messages after the last assistant or tool one.
// DSH's own context notes (its tool and file policies) are for its own loop, not the agent's,
// and the new-session notice is for the person. A Bot part's handoff package is the record the
// part carries on from, so it stays beside the person's words (in its place) rather than being
// dropped for them; it is a crossing of earlier text, so it passes the redactor.
export function promptOf(messages, redact = text => text) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start--
  // A failed request may leave no assistant row. Retry starts a new continuation even
  // then: never resend the earlier instruction to an ACP session that already accepted it.
  const retry = messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'retry')
  const turn = messages.slice(Math.max(start, retry)).filter(message => message.source?.kind !== NOTICE_KIND)
  const own = turn.filter(message => message.source?.kind === 'user' || message.source?.kind === 'retry' || isHandoff(message))
  const text = (own.length > 0 ? own : turn)
    .map(message => (isHandoff(message) ? redact(textOf(message.content)) : textOf(message.content)))
    .filter(Boolean).join('\n\n')
  return [{ type: 'text', text: text || (own.some(message => message.source?.kind === 'retry') ? 'Continue.' : '') }]
}

/** Where a Session title on an agent's chat goes when DSH's default model is an agent too. */
export const SIDE_MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' })
const TITLE_PURPOSE = 'session-title'
// Auto review is a side request DSH's Auto preset makes on the Session's route. Like a title it
// must not reach the agent; unlike a title it reads the Session, so it gets the redactor.
const REVIEW_PURPOSE = 'auto-review'
const SIDE_PURPOSES = new Set([TITLE_PURPOSE, REVIEW_PURPOSE])

/** Redact the fixed system prompt and every text block of a review request. */
function redactedReview(options, redact) {
  return {
    ...options,
    ...(typeof options.system === 'string' ? { system: redact(options.system) } : {}),
    ...(Array.isArray(options.messages) ? {
      messages: options.messages.map(message => ({
        ...message,
        ...(Array.isArray(message.content) ? {
          content: message.content.map(block => (block?.type === 'text' && typeof block.text === 'string' ? { ...block, text: redact(block.text) } : block)),
        } : {}),
      })),
    } : {}),
  }
}

/**
 * The `llm/stream` listener that keeps DSH's side requests (a Session title, a compaction
 * summary) away from the agents: they would reach the agent as prompts of their own. A Session
 * title on an agent's route goes to a model that answers on its own instead, without the
 * agent's effort, which is the agent's model's: DSH's default model when that is not an agent,
 * else an explicitly chosen `sideModel`, each configured non-agent route in turn, and the
 * built-in DeepSeek Flash last. DSH's default is the model the person last picked, so on a team
 * that chats with an agent it is usually an agent.
 * Auto review is another side request: DSH's Auto preset sends it on the Session's route, and
 * it must reach a model that answers on its own just as a title does. It is redacted first:
 * the reviewer reads the Session's history, so its text passes the shared redactor.
 * Every other side request (a compaction summary) is turned down: it would carry the agent's
 * whole chat to another provider, and the agent manages its own context. The agent loop's own
 * requests, and every other route's, go on as they are. Only here is the agent loop's mark on
 * a request reliable; DSH rebuilds the request before the adapter sees it whenever the
 * Session's tool set changed. `next` takes no request, so the side call is a nested
 * `ctx.llm.stream`, which passes through this listener again as another route's.
 * @param {Map<string, unknown>} providers the agents' routes
 * @param {{ llm?: { stream(options: object): AsyncIterable<object> }, get?: (name: string) => any }} [ctx]
 * @param {() => { provider?: string, model?: string } | undefined} [sideModel]
 * @param {(text: string) => string} [redact] the shared redactor, for Auto review
 * @param {{ review(options: object): ((chosen: object, outcome: object) => void) | undefined }} [diagnostics]
 *   told each review candidate and how it ended (permission-diagnostics.js); it only records
 */
export function aside(providers, ctx, sideModel = () => SIDE_MODEL, redact = text => text, diagnostics) {
  const answers = choice => typeof choice?.provider === 'string' && choice.provider !== ''
    && typeof choice.model === 'string' && choice.model !== ''
    && !agentRoute(providers, choice.provider)
  const synthetic = message => message?.source?.synthetic === SYNTHETIC_KIND
  const refuse = () => (async function* () { yield finish('error', 'An ACP agent answers only in its own chat', 'UNSUPPORTED') })()
  // A credential or route failure on one candidate is not a review verdict: try the next model
  // the team has. Anything else (a bad reply, a timeout) is that candidate's answer.
  const NEXT_MODEL = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER'])
  // Every model that can answer beside the chat, in the order the team can reach it: DSH's
  // default model when it is not an agent, a sideModel the person chose, each configured
  // non-agent route in turn (capped), and only then the built-in DeepSeek Flash. Nothing here
  // reaches an agent: a review must never become a prompt in the chat it reviews.
  const choicesFor = async () => {
    const choices = []
    const add = (choice) => {
      if (!answers(choice)) return
      const same = seen => seen.provider === choice.provider && seen.model === choice.model
      if (choices.some(same)) return
      choices.push({ provider: choice.provider, model: choice.model })
    }
    try { add(ctx.get?.('agentDefaultModel')?.currentSelection?.()) } catch {}
    let configured
    try { configured = sideModel() } catch {}
    const explicit = computed => computed !== undefined
      && (computed.provider !== SIDE_MODEL.provider || computed.model !== SIDE_MODEL.model)
    if (answers(configured) && explicit(configured)) add(configured)
    let routes = []
    try { routes = ctx.llm?.listProviders?.() ?? [] } catch {}
    let probed = 0
    for (const route of Array.isArray(routes) ? routes : []) {
      // The cap is on routes examined, not candidates kept: one slow or model-less route must
      // not make the chain walk every provider on the machine.
      if (probed >= 8) break
      if (!answers({ provider: route?.id, model: 'candidate' })) continue
      probed += 1
      let models
      try { models = await ctx.llm?.listModels?.(route.id) } catch {}
      const first = Array.isArray(models)
        ? models.find(model => typeof model?.id === 'string' && model.id !== '')
        : undefined
      if (first === undefined) continue
      add({ provider: route.id, model: first.id })
    }
    // The built-in fallback is last, whatever the person configured: an explicit side model
    // that cannot run must not remove it.
    add(SIDE_MODEL)
    return choices
  }
  return (options, next) => {
    if (!providers.has(options.provider)) {
      // A bridge review block that outlived its call (a crash, a failed replacement) is not a
      // turn: drop it before any native model sees it. The nested call re-enters here clean.
      if (Array.isArray(options.messages) && options.messages.some(synthetic) && ctx?.llm !== undefined) {
        return ctx.llm.stream({ ...options, messages: options.messages.filter(message => !synthetic(message)) })
      }
      return next()
    }
    if (isAgentLoopRequest(options)) return next()
    if (!SIDE_PURPOSES.has(options.purpose) || ctx?.llm === undefined) return refuse()
    const routed = options.purpose === REVIEW_PURPOSE ? redactedReview(options, redact) : options
    const { reasoningEffort: _agentEffort, ...request } = routed
    return (async function* () {
      let last
      const noteReviewer = diagnostics?.review(options)
      for (const chosen of await choicesFor()) {
        const chunks = []
        let failure
        let finished = false
        try {
          const attempt = { ...request, provider: chosen.provider, model: chosen.model }
          const stream = ctx.llm.stream(attempt)
          for await (const chunk of stream) {
            chunks.push(chunk)
            if (chunk?.type !== 'finish') continue
            finished = true
            const kind = chunk.reason?.kind
            if (kind === 'error' || kind === 'aborted') failure = chunk.reason.failure
            break
          }
        } catch (error) {
          failure = { message: error?.message ?? String(error), code: error?.code }
        }
        noteReviewer?.(chosen, { finished, failure })
        if (failure === undefined && finished) {
          for (const chunk of chunks) yield chunk
          return
        }
        last = failure ?? {
          message: `${chosen.provider}/${chosen.model} ended without an answer`,
          code: 'EMPTY_RESPONSE',
        }
        if (!NEXT_MODEL.has(last.code)) {
          yield finish('error', last.message, last.code)
          return
        }
      }
      yield finish('error', last?.message ?? 'An ACP agent answers only in its own chat',
        last?.code ?? 'UNSUPPORTED')
    })()
  }
}

/**
 * Put the agent on DSH's model and effort, the model first: the efforts it offers are that
 * model's. DSH's `default` model is the one the agent started on. With no effort, the model's
 * own comes back, so an earlier turn's choice does not stay: the agent's "default" row when it
 * has one (Claude Code's, which hands effort back to its settings), else `ownEffort()`, the one
 * the agent showed for that model when it was read, asked only then; when it is not known, no
 * effort is set.
 * @param {AgentRun} run
 * @param {string} model
 * @param {string | undefined} effort
 * @param {() => string | undefined} [ownEffort]
 * @param {{ signal?: AbortSignal }} [options] the turn's Stop, for each request
 */
export async function choose(run, model, effort, ownEffort, { signal } = {}) {
  const option = run.option('model')
  if (option === undefined) {
    if (model !== DEFAULT_MODEL) throw new Error(`it offers no choice of model, so not ${model}`)
  } else {
    const target = model === DEFAULT_MODEL && !valuesOf(option).some(choice => choice.value === DEFAULT_MODEL) ? run.startModel : model
    if (target !== undefined) await run.setOption('model', target, { signal })
  }
  if (effort !== undefined) return run.setOption('thought_level', effort, { signal })
  const levels = run.option('thought_level')
  if (levels === undefined) return
  const offered = valuesOf(levels).map(choice => choice.value)
  if (offered.includes(DEFAULT_MODEL)) return run.setOption('thought_level', DEFAULT_MODEL, { signal })
  const own = ownEffort?.()
  if (own !== undefined && offered.includes(own)) await run.setOption('thought_level', own, { signal })
}

export class AcpAdapter extends LlmAdapter {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {Map<string, { name: string, catalog: import('./catalog.js').Catalog, installed?(): boolean, spawn(): { command: string, args?: string[], env?: Record<string, string> } }>} agents
   *   An agent's own `startMs` and `requestMs` replace acp.js's deadlines; `cancelWaitMs`
   *   replaces CANCEL_WAIT_MS; `timers` is the clock all three run on. Tests set them, so none
   *   waits a real deadline out.
   */
  constructor(ctx, agents, { dshTools = () => false, backchannel, redactor, onSignedOut, images = () => undefined, access, holds, ownMode = () => undefined, ownModeWaitMs = OWN_MODE_WAIT_MS, holdWaitMs = HOLD_WAIT_MS, cancelWaitMs = CANCEL_WAIT_MS, fileDrainMs = 6000, timers = globalThis } = {}) {
    super()
    this.cancelWaitMs = cancelWaitMs
    this.timers = timers
    // The turn gates (index.js `holdTurns`): asked before an agent acts for a Session. They
    // only ever refuse; with none registered nothing is asked.
    this.ownMode = ownMode
    this.ownModeWaitMs = ownModeWaitMs
    this.holds = holds
    this.holdWaitMs = holdWaitMs
    // Session id -> the turn that is starting there (from its step's entry to its prompt):
    // `endSession` marks it, so a Session ended before its agent session exists (the consent
    // wait, the start) still refuses that turn.
    this.starting = new Map()
    // Asked before a turn opens on an agent (#869): a text when its signed-in account has not
    // been confirmed for the app, else undefined. Never asked for a call that continues a turn.
    this.access = access
    // Told which agent answered ACP's auth_required, so a cached "signed in" is dropped at once.
    this.onSignedOut = onSignedOut
    this.ctx = ctx
    this.agents = agents
    this.dshTools = dshTools
    this.backchannel = backchannel
    this.redact = redactor ?? (text => text)
    this.live = new Map()
    this.sessionFiles = new SessionFiles({
      agent: id => this.ctx.agents?.get?.(id), live: id => this.live.get(id),
      level: session => levelOf(ctx.get?.('approval'), session, ctx.get?.('sandboxPolicy'), ctx.get?.('permissionPresets')),
      questions: () => ctx.get?.('userQuestions'), drainMs: fileDrainMs,
      retire: (id, live) => this.end(id, live, { preserveFiles: true }),
      revoke: owner => {
        if (this.live.get(owner.session.id)?.fileOwner === owner) this.endSession(owner.session.id, 'Image session permission expired.')
      },
    })
    this.tool = mirrorTool({ sessionFiles: (...args) => this.sessionFiles.ask(...args), runOf: sessionId => this.live.get(sessionId), cancelled: (sessionId, live) => this.reap(sessionId, live), approval: () => ctx.get?.('approval'), sandboxPolicy: () => ctx.get?.('sandboxPolicy'), permissionPresets: () => ctx.get?.('permissionPresets'), images, attachments: () => ctx.get?.('attachments') })
    // A new chat's first model step lists its tools after `agent/created`: register the mirror
    // tool there in every agent's own scope, with the step condition that admits it only on
    // this adapter's routes. A chat is created on DSH's default route and may be picked to an
    // ACP one before its first prompt, so a create-time check would miss that first step. The
    // stream's `scope()` stays as the fallback for an agent this event missed.
    this.ctx.on?.('agent/created', ({ agent } = {}) => this.registerMirror(agent))
    // A plugin reload replaces this adapter while live chats keep their agents. DSH resolves a
    // step's tools before the adapter streams it, so replacing a registration during a running
    // turn would close that step's admission of the mirror tool and its call would fail as
    // UNKNOWN_TOOL. Take over the agents that are idle now, before their next step resolves;
    // for an agent still running, replace on the status edge to idle, after its current step.
    this.ctx.on?.('agent/status', ({ agent, status } = {}) => {
      if (status !== 'idle') return
      const id = agent?.session?.id
      const live = this.live.get(id)
      if (live?.own && live.run.busy) this.end(id, live)
      this.registerMirror(agent)
    })
    this.ctx.on?.('agent/disposed', ({ agent } = {}) => {
      const id = agent?.session?.id
      const live = this.live.get(id)
      if (live?.own || live?.fileOwner) this.end(id, live)
      if (this.sessionFiles.owners.get(id)?.agent === agent) this.sessionFiles.clear(id)
    })
    for (const agent of this.ctx.agents?.list?.() ?? []) this.registerMirror(agent)
    // A mirror call DSH refuses before its body (a gate, a failed review, the person's no, a
    // Stop) leaves the agent's permission question with nobody to answer it.
    this.offResult = this.ctx.on?.('tools/result', exec => this.refusedFirst(exec))
    // No prepend: this must run after Auto review's prepended gate lets the call through.
    this.offReviewed = this.ctx.on?.('tools/pre-execute', (exec, next) => this.reviewedGate(exec, next))
  }

  /**
   * Remember this adapter's own root mirror execution at Auto, after the review gate. The body
   * runs only if the whole stage allowed, so recording before next() adds no decision and no
   * async gap for the remaining gates. A recording failure must not stop the waterfall.
   */
  reviewedGate(exec, next) {
    try {
      if (exec?.name === TOOL_NAME && exec.parent === undefined) {
        const session = exec.agent?.session
        if (this.live.get(session.id)?.calls?.has(exec.callId) === true) {
          const level = levelOf(this.ctx.get?.('approval'), session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
          if (level.auto === true) reviewed.set(exec, { sandbox: level.sandbox, policy: level.policy })
        }
      }
    } catch (error) {
      try { this.ctx.logger?.warn?.(`acp-dsh: a reviewed call was not recorded: ${error?.message ?? error}`) } catch {}
    }
    return next()
  }

  /**
   * A finished mirror call whose body never ran: hand the agent the refusal, for this Session's
   * own call only (its Session id, its DSH call id, and the tool id this adapter mapped to it,
   * never the call's arguments). It must not throw: DSH only logs a failing observer.
   */
  refusedFirst(exec) {
    try {
      if (exec?.name === TOOL_NAME && exec.parent === undefined) {
        const live = this.live.get(exec.agent?.session?.id)
        live?.pendingMirrors?.delete(exec.callId)
        this.sessionFiles.owners.get(exec.agent?.session?.id)?.grant?.retired?.pendingMirrors?.delete(exec.callId)
      }
      if (exec?.name !== TOOL_NAME || exec.parent !== undefined || entered.has(exec)) return
      const live = this.live.get(exec.agent?.session?.id)
      if (live?.calls?.has(exec.callId) !== true) return
      const toolId = live.toolIds?.get(exec.callId)
      if (toolId !== undefined) live.run?.refuse(toolId, exec.signal?.aborted === true)
    } catch (error) {
      try { this.ctx.logger?.warn?.(`acp-dsh: a refused call did not reach its agent: ${error?.message ?? error}`) } catch {}
    }
  }

  /**
   * Put the mirror tool in the Session agent's own scope, once per adapter, with the condition
   * DSH evaluates when it resolves a step's tools: admitted only while the step's provider is
   * one of this adapter's routes. No model selection means no admission, never a throw. An
   * agent registered by an earlier adapter instance is taken over: its exact disposer is called
   * once and this adapter's registration replaces it. While the agent is running, DSH has
   * already resolved the current step's tools, so a replacement now would fail that step's
   * mirror call as UNKNOWN_TOOL: keep the old registration for this turn and replace it on the
   * next idle edge. A missing agent is a no-op; `scope()` decides what that means for a turn.
   * @param {any} agent
   */
  registerMirror(agent) {
    if (agent === undefined) return
    const current = agent[MIRROR_REGISTRATION]
    if (current?.adapter === this) return
    if (current !== undefined && agent.status === 'running') return
    if (current !== undefined) {
      try { current.dispose() } catch {}
    }
    const dispose = agent.ctx.tools.register(this.tool, {
      when: ({ modelSelection }) => this.agents.has(modelSelection?.provider),
    })
    Object.defineProperty(agent, MIRROR_REGISTRATION, {
      value: { adapter: this, dispose },
      configurable: true,
      writable: true,
    })
  }

  /**
   * Whether DSH's tools reach this agent when the setting says nothing. Only an adapter that
   * can drop its own built-in tools is in the default: today that is Claude Code's. Codex keeps
   * its own tool set, so bridging it by default would run two tool sets; an explicit true
   * still does it.
   */
  bridgeDefault(agent) {
    return agent?.disableBuiltInTools === true
  }

  /**
   * Whether DSH's tools reach an agent at all: an explicit true/false decides, and an absent
   * setting takes the adapter's own switch (`bridgeDefault`).
   */
  bridgeOn(agent) {
    if (this.backchannel === undefined) return false
    // A row that declares no bridge (`bridge: false`, the native agents) gets none, even with
    // `dshTools: true`: its bridge calls would not be recognised, so each would draw a mirror
    // card beside the bridge's rows and ask twice.
    if (agent?.bridge === false) return false
    const setting = this.dshTools()
    if (setting === true || setting === false) return setting
    return this.bridgeDefault(agent)
  }

  /**
   * Whether the chat crosses to an agent with it (plan A-5): independent of the bridge, so
   * Codex replays by default too. Only an explicit `dshTools: false`, the kill switch, keeps
   * the 2026-11-03 path, where an agent sees no transcript but its own session's.
   */
  replayOn() {
    return this.dshTools() !== false
  }

  /**
   * The kill switch flipped off: end every live agent session and its bridge. The DSH Session
   * keeps its transcript; the next turn starts a fresh agent session without the bridge, so a
   * credential minted while `dshTools` was on cannot keep reaching DSH tools.
   */
  endSessions() {
    for (const id of this.sessionFiles.owners.keys()) this.sessionFiles.clear(id)
    for (const [sessionId, live] of this.live) this.end(sessionId, live)
  }

  endProvider(provider, why) {
    for (const [id, owner] of this.sessionFiles.owners) if (owner.provider === provider) this.endSession(id, why)
    for (const [id, starting] of this.starting) {
      if (starting.provider === provider) this.endSession(id, why)
    }
    for (const [id, live] of this.live) {
      if (live.provider === provider) this.endSession(id, why)
    }
  }

  /**
   * End one agent session now: its process, its bridge credential and its place in `live`. The
   * DSH Session keeps its transcript, so the next turn starts a new agent session and the
   * replay carries the chat to it.
   */
  end(sessionId, live, { preserveFiles = false } = {}) {
    if (!preserveFiles) this.sessionFiles.clear(sessionId, { retire: false })
    const bridge = live.bridge
    if (bridge !== undefined && bridge.calls > 0 && bridge.drained === undefined) {
      const hold = guardSession(live.dshAgent?.session ?? bridge.agent?.session)
      bridge.drained = () => hold?.release()
    }
    this.timers.clearTimeout(live.reaper)
    live.reaper = undefined
    live.reaping = undefined
    live.open = false
    live.run?.dispose()
    if (live.bridge !== undefined) this.backchannel?.revoke(live.bridge)
    if (this.live.get(sessionId) === live) this.live.delete(sessionId)
  }

  /**
   * The agent was just asked to stop its prompt (a Stop, a stopped tool call, drift). Nothing
   * says it will: a prompt still open after `cancelWaitMs` is an agent that ignored the cancel,
   * and its session ends here, on the app's side. Otherwise the run would stay busy, its
   * process would go on with whatever it was doing, and every later message would fail.
   */
  reap(sessionId, live) {
    if (live?.fileOwner) { this.end(sessionId, live); return }
    const prompt = live?.run?.prompting
    if (prompt === undefined || live.reaping === prompt) return
    this.timers.clearTimeout(live.reaper)
    live.reaping = prompt
    const timer = this.timers.setTimeout(() => {
      if (live.reaper !== timer) return
      live.reaper = undefined
      live.reaping = undefined
      if (live.run.prompting !== prompt) return
      this.warn(`${live.name} did not stop its answer within ${waited(this.cancelWaitMs)} of being asked: its session was ended`)
      this.end(sessionId, live)
    }, this.cancelWaitMs)
    timer.unref?.()
    live.reaper = timer
  }

  /**
   * A new turn found the agent still on its last prompt: ask it to stop and wait for the end,
   * no longer than `cancelWaitMs` or this turn's own Stop. Whether the prompt ended.
   */
  async stopping(live, signal) {
    const prompt = live.run.prompting
    // The wait starts with the cancel, not after it: a write the agent no longer reads must
    // not add its own deadline to this one.
    const wait = pause(this.cancelWaitMs, signal, this.timers)
    try {
      await Promise.race([live.run.cancel().then(() => prompt), wait.done])
    } finally {
      wait.clear()
    }
    return !live.run.busy
  }

  /**
   * A request before the prompt that the agent did not answer in time, or that the person's
   * Stop ended: the agent may still act on it, so its session ends rather than be asked
   * anything else. The turn's finish for either; undefined for any other error.
   */
  abandoned(sessionId, live, agent, error, doing) {
    const left = this.unanswered(agent, error, doing)
    if (left !== undefined) this.end(sessionId, live)
    return left
  }

  /** The turn's finish for a request nobody answered, or one the turn's Stop ended. */
  unanswered(agent, error, doing) {
    if (isStopped(error)) return STOPPED()
    if (!isUnanswered(error)) return undefined
    this.warn(`${agent.name} did not answer ${error.step ?? `while ${doing}`} within ${waited(error.ms)}: its session was ended`)
    return finish('error', unansweredText(agent.name, doing, error.ms))
  }

  warn(message) {
    try { this.ctx.logger?.warn?.(`acp-dsh: ${message}`) } catch {}
  }

  /** Ask once, bounded in time; only the exact answer true permits the own mode. */
  async ownAnswer(sessionId, agent, provider) {
    let timer
    try {
      const answer = this.ownMode()
      if (typeof answer !== 'function') return 'none'
      return await Promise.race([
        Promise.resolve().then(() => answer({ sessionId, agent, provider })).then(value => value === true ? 'yes' : 'no', () => 'no'),
        new Promise(resolve => { timer = setTimeout(resolve, this.ownModeWaitMs, 'late') }),
      ])
    } catch { return 'no' } finally { clearTimeout(timer) }
  }

  /** Whether this Session is busy on a prompt in its own mode. */
  ownModeIn(sessionId) {
    const live = this.live.get(sessionId)
    return live?.own === true && live.run.busy === true
  }

  /**
   * Whether a gate holds this Session now: the sentence to answer the step with, or undefined.
   * Every gate is asked; any refusal wins, the first to arrive. A gate lets the Session go only
   * by answering undefined (or null) in time. One that throws, does not answer within the
   * bound, or answers anything but a non-empty text holds it with `HELD_TEXT`: an error's own
   * message never becomes chat text. With no gate registered nothing is asked.
   */
  async heldBack(sessionId, agent, provider) {
    let gates = []
    try { gates = [...(this.holds?.() ?? [])] } catch { return HELD_TEXT }
    if (gates.length === 0) return undefined
    const read = answer => (answer === undefined || answer === null ? undefined : typeof answer === 'string' && answer.trim() !== '' ? answer : HELD_TEXT)
    let timer
    try {
      return await new Promise((resolve) => {
        timer = setTimeout(resolve, this.holdWaitMs, HELD_TEXT)
        let left = gates.length
        for (const gate of gates) {
          Promise.resolve().then(() => gate({ sessionId, agent, provider })).then(read, () => HELD_TEXT).then((held) => {
            left -= 1
            if (held !== undefined) resolve(held)
            else if (left === 0) resolve(undefined)
          })
        }
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * End one Session's agent session, as the kill switch ends them all: its process is disposed
   * (its open questions withdrawn, SIGTERM then SIGKILL), its bridge credential revoked, and
   * the live entry removed, so an agent that ignores a cancel cannot go on and the next turn
   * starts a fresh agent session that takes its mode again. A step still streaming that
   * session answers `why` and stops. A turn still starting there (no agent session yet) is
   * refused the same way, whatever a gate says later. The DSH Session and its transcript stay.
   * A bridge call under way keeps the Session's write guard until it is back, so the step's
   * end closes its open call and its late result is not written outside the step.
   * @param {string} sessionId
   * @param {string} [why] the sentence a step under way answers
   * @returns {boolean} whether an agent session was live or starting there
   */
  endSession(sessionId, why) {
    this.sessionFiles.clear(sessionId, { retire: false })
    const text = typeof why === 'string' && why.trim() !== '' ? why : HELD_TEXT
    const starting = this.starting.get(sessionId)
    if (starting !== undefined) starting.held ??= text
    const live = this.live.get(sessionId)
    if (live === undefined) return starting !== undefined
    live.held = text
    live.open = false
    // A cancel's own wait on this session (reap) has nothing left to end.
    this.timers.clearTimeout(live.reaper)
    live.reaper = undefined
    live.reaping = undefined
    this.live.delete(sessionId)
    live.run?.dispose()
    const bridge = live.bridge
    if (bridge !== undefined && bridge.calls > 0 && bridge.drained === undefined) {
      const hold = guardSession(live.dshAgent?.session ?? bridge.agent?.session)
      bridge.drained = () => hold?.release()
    }
    if (bridge !== undefined) this.backchannel?.revoke(bridge)
    // A step waiting for the agent's next event wakes now, not when the process has exited.
    try { live.run?.push({ type: 'error', message: 'held' }) } catch {}
    return true
  }

  /** The `session/new` server entry for one bridge: the adapter spawns it with this env only. */
  bridgeServer(record) {
    return {
      name: BRIDGE_NAME,
      command: process.execPath,
      args: [BRIDGE_PATH],
      env: [
        ...(process.versions.electron ? [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] : []),
        { name: CREDENTIAL_ENV, value: record.credential },
        { name: URL_ENV, value: this.backchannel.urlFor(record) },
      ],
    }
  }

  /**
   * The session/new answer is in: release the bridge's first announcement and wait for its
   * first `tools/list`. A bridge that never asks is the turn's failure, not a quiet half set.
   */
  async ready(agent, state) {
    const record = state.bridge
    if (record === undefined) return
    this.backchannel.announce(record)
    const deadline = Date.now() + (agent.bridgeReadyMs ?? BRIDGE_READY_MS)
    while (!record.listed && !record.closed) {
      if (Date.now() > deadline) {
        const error = new Error(`the ${BRIDGE_NAME} bridge did not reach DSH (a server of that name in the agent's own config skips it)`)
        error.code = 'acp_bridge_missing'
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, BRIDGE_READY_POLL_MS).unref?.())
    }
    if (record.closed) {
      const error = new Error(`the ${BRIDGE_NAME} bridge closed before it listed its tools`)
      error.code = 'acp_bridge_missing'
      throw error
    }
  }

  /**
   * A preset or level change on an agent that ignores `tools/list_changed` (`acp-codex`): fork
   * the ACP session with the new server set, close the source (with its bridge), and go on from
   * the fork. The fork continues the same conversation; the source is never left holding a
   * second bridge. Each of the fork's requests has its own deadline; `signal`, the turn's
   * Stop, ends the wait for all of them.
   */
  async refork(agent, live, dshAgent, signal) {
    const previous = live.bridge
    const next = this.backchannel.mint({ sessionId: dshAgent?.session?.id, agent: dshAgent, name: agent.name, promptRunning: () => live.open === true && live.run?.busy === true })
    live.bridge = next
    try {
      await live.run.held(() => live.run.fork({
        cwd: dshAgent?.session?.header?.cwd ?? homedir(),
        mcpServers: [this.bridgeServer(next)],
      }), { ms: 0, signal })
    } catch (error) {
      // The fork may already have moved the run to a new ACP session (a bridge that never
      // listed). Nothing can resume that half state: revoke both credentials, end the run and
      // let the next turn start clean.
      live.bridge = previous
      this.backchannel.revoke(next)
      this.timers.clearTimeout(live.reaper)
      live.run.dispose()
      this.live.delete(dshAgent?.session?.id ?? '')
      if (previous !== undefined) this.backchannel.revoke(previous)
      throw error
    }
    this.backchannel.revoke(previous)
    return next
  }

  /**
   * The runtime drift detector, an allowlist (RFC 0003, amendment, delivery 6). With `dshTools`
   * on and the agent's built-in tools off, every structured call name must be an MCP name — the
   * bridge's `mcp__dsh__<tool>` or a server the session was given, `mcp__<server>__<tool>` — or
   * `ToolSearch`, the deferred-tool loader the adapter keeps with `tools: []`. Anything else is
   * a built-in file or shell tool and drift: it DETECTS and CANCELS. It cannot prevent the call
   * that triggered it (the update arrives after the call started), so the turn is cancelled on
   * the same trace and the record says what ran.
   */
  checkDrift(sessionId, agent, tool) {
    if (!this.bridgeOn(agent) || agent.drift !== true || tool.drift === true) return
    const name = tool.structuredName
    if (name === undefined || name.startsWith('mcp__') || name === 'ToolSearch') return
    // Every drifted call stays cardless, but the record and the cancel belong to the turn: a
    // latch that outlived the turn would let a later turn's built-in call through unrecorded
    // (and would draw it as a mirror card).
    tool.drift = true
    const live = this.live.get(sessionId)
    if (live?.drifted === true) return
    if (live !== undefined) live.drifted = true
    const session = live?.dshAgent?.session ?? this.ctx.agents?.get?.(sessionId)?.session
    const recorded = session === undefined ? false : recordDrift(session, { name, title: tool.title, provider: live?.provider })
    try {
      this.ctx.logger?.warn?.(`acp-dsh: acp_toolset_drift: ${name} is not an MCP tool${recorded ? '' : ' (the record could not be written)'}`)
    } catch {}
    void live?.run.cancel()
    // The call that drifted is already running: an agent that ignores the cancel is ended.
    this.reap(sessionId, live)
  }

  /**
   * A model selection on a Session this adapter served: moving off the agent is a crossing too,
   * and ends its agent session (and the bridge that belongs to it). The row is the one the chat
   * shows; the model selection itself is DSH's.
   */
  noteEvent(session, event) {
    // Every observed crossing invalidates this owner's epoch, including away and back and
    // sessions kept by the ordinary bridge-off path. No transcript can recreate authority.
    const owner = this.sessionFiles.owners.get(session?.id)
    if (owner?.session === session && ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection'].includes(event?.type)) {
      this.endSession(session.id, 'Image session permission changed. Send a new message to continue.')
    }
    if (event?.type !== 'model/selection') return
    const live = this.live.get(session?.id)
    if (live === undefined) return
    // Off is the old path, byte for byte: the agent session is kept across a turn on another
    // provider, so switching back resumes the same ACP session. The default is per agent.
    if (!this.bridgeOn(this.agents.get(live.provider))) return
    const provider = event.data?.provider
    if (agentRoute(this.agents, provider)) return
    this.end(session.id, live)
    try {
      session.append?.('user/message', boundaryNotice('Switching to DSH'), { surfaceOp: 'append' })
    } catch (error) {
      try { this.ctx.logger?.warn?.(`acp-dsh: the provider-boundary row was not written: ${error?.message ?? error}`) } catch {}
    }
  }

  providerInfo(provider) {
    return { id: provider, name: this.agents.get(provider)?.name ?? provider }
  }

  // An agent whose ACP adapter is not installed yet lists no model, so nothing (a picker, a
  // Bot's model) can choose one that cannot answer.
  async listModels(provider) {
    const agent = this.agents.get(provider)
    if (agent === undefined || agent.installed?.() === false) return []
    return (await agent.catalog.models()).map(model => ({ provider, id: model.id, name: model.name, ...(model.description ? { description: model.description } : {}) }))
  }

  // A model's efforts are the ones the agent offers for it; DSH turns down any other before the
  // agent sees it. An id the agent does not list resolves bare, as DSH's routing allows.
  async resolveModel(provider, model) {
    const found = await this.agents.get(provider)?.catalog.model(model)
    if (found === undefined) return { provider, id: model, name: model }
    return { provider, id: found.id, name: found.name, ...(found.description ? { description: found.description } : {}), ...(found.reasoning ? { reasoning: found.reasoning } : {}) }
  }

  // The mirror tool lives in the agent's own scope: no other Session's model sees it. The
  // agent/created listener (and a reloaded adapter's construction) registers it before the
  // first step; this fallback covers an agent those missed and fails clearly when the Session
  // has no live agent at all.
  scope(sessionId) {
    const agent = this.ctx.agents?.get?.(sessionId)
    if (agent === undefined) {
      const error = new Error(`the Session ${sessionId} has no live agent`)
      error.code = 'acp_agent_missing'
      throw error
    }
    this.registerMirror(agent)
    return agent
  }

  signedOut(id) {
    try { this.onSignedOut?.(id) } catch {}
  }

  // One model step. The turn that is starting there is tracked from here to the step's last
  // exit (`starting`), whichever way it leaves: a refusal, a failure, a stop, its end.
  async *stream(options) {
    if (this.sessionFiles.owners.get(options.sessionId)?.grant && this.starting.has(options.sessionId)) {
      return yield finish('error', 'The image session is already starting. Wait for that message to finish.')
    }
    const entry = { held: undefined }
    const stopFiles = () => {
      if (this.sessionFiles.owners.has(options.sessionId)) this.endSession(options.sessionId, 'The image session was stopped.')
    }
    options.signal?.addEventListener('abort', stopFiles, { once: true })
    if (options.signal?.aborted) stopFiles()
    try {
      yield* this.step(options, entry)
    } finally {
      options.signal?.removeEventListener('abort', stopFiles)
      if (entry.fileStartup && this.starting.get(options.sessionId) === entry && this.sessionFiles.owners.get(options.sessionId)?.grant) this.endSession(options.sessionId)
      if (this.starting.get(options.sessionId) === entry) this.starting.delete(options.sessionId)
    }
  }

  async *step(options, entry) {
    const agent = this.agents.get(options.provider)
    if (agent === undefined) return yield finish('error', `No ACP agent is set up as ${options.provider}`, 'NO_ADAPTER')
    // A title or summary DSH asks for on the side is refused at the llm/stream waterfall (aside).
    if (options.sessionId === undefined) return yield finish('error', `${agent.name} answers only in its own chat`, 'UNSUPPORTED')
    const sessionId = options.sessionId
    let dshAgent
    try {
      dshAgent = this.scope(sessionId)
    } catch (error) {
      return yield finish('error', `${agent.name} cannot show its tools here: ${error?.message ?? error}`, error?.code)
    }
    const blocks = new Blocks()
    let live = this.live.get(sessionId)
    // The agent's links to the images it saved locally leave its text before DSH writes it
    // (agent-image.js): the chat shows the image in its own card instead.
    const links = new ImageLinks(() => savedPathsOf(live?.run?.tools?.values()))
    const shown = function* () {
      const rest = links.flush()
      if (rest !== '') yield* blocks.add('text', rest)
    }
    // A held Session's step: the sentence as the answer, and nothing else happens there.
    const stopped = function* (why) {
      // In a block of its own, after whatever the agent had already said this step.
      yield* blocks.close()
      yield* blocks.add('text', why)
      yield* blocks.close()
      yield finish('stop')
    }
    // No agent acts for a Session a gate holds: not a new turn, not the next step of one. The
    // agent session there ends with the refusal.
    // The turn is starting from here: an `endSession` that lands before its prompt refuses it.
    entry.provider = options.provider
    this.starting.set(sessionId, entry)
    const started = () => { if (this.starting.get(sessionId) === entry) this.starting.delete(sessionId) }
    const held = await this.heldBack(sessionId, dshAgent, options.provider) ?? entry.held
    if (held !== undefined) {
      started()
      this.endSession(sessionId, held)
      return yield* stopped(held)
    }
    live = this.live.get(sessionId)
    const last = options.messages.at(-1)
    // The step after a mirror call's result continues the agent's turn. The bridge writes result
    // rows of its own (a DSH tool call's result, or the row that closes a call still open when
    // its step ended, #957), and one of those can come after the mirror call's result: the
    // mirror result is looked for among all the tool messages the transcript ends with.
    const mirrorAnswered = (() => {
      for (let i = options.messages.length - 1; i >= 0 && options.messages[i]?.role === 'tool'; i--) {
        if (live?.calls.has(options.messages[i].toolCallId)) return true
      }
      return false
    })()
    const continuing = mirrorAnswered && live?.provider === options.provider && live.open
    if (continuing) started()
    if (!continuing) {
      if (last?.role === 'tool') {
        // The agent may still be on the prompt this step belonged to. Nobody is reading it any
        // more, so it is asked to stop now, and its session is ended if it has not stopped in
        // the time a cancel gets (`reap`, which also answers whatever it was still asking),
        // instead of going on unseen until the person's next message (#969).
        if (live?.run?.busy === true) {
          void live.run.cancel()
          if (live.own) this.end(sessionId, live)
          else this.reap(sessionId, live)
        }
        yield* blocks.add('text', `${agent.name} was interrupted before it finished, so it is not answering this turn any more.`)
        yield* blocks.close()
        return yield finish('stop')
      }
      // Only a genuine user message activates staged file authority. The trailing-tool
      // guard above remains the sole continuation rule; no approval creates a prompt.
      let fileOwner
      let fileContext
      if (agent.sessionFiles === true) {
        const level = levelOf(this.ctx.get?.('approval'), dshAgent.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
        let strictChat = restrictedLevel(level)
        if (strictChat && level.sandbox === 'workspace-write' && agent.ownMode !== undefined) {
          strictChat = await this.ownAnswer(sessionId, dshAgent, options.provider) !== 'yes'
        }
        if (options.signal?.aborted || entry.held !== undefined) return yield* stopped(entry.held ?? 'The image session was stopped.')
        const currentLevel = levelOf(this.ctx.get?.('approval'), dshAgent.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
        if (strictChat && (!restrictedLevel(currentLevel) || currentLevel.sandbox !== level.sandbox)) {
          this.endSession(sessionId)
          return yield* stopped('Image session permission changed. Send a new message to continue.')
        }
        if (strictChat) {
          fileOwner = this.sessionFiles.owner(dshAgent, options.provider)
          entry.fileStartup = true
          try {
            const files = await this.sessionFiles.activate(fileOwner, last, options.signal)
            if (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined) throw new Error('Image permission changed before startup.')
            fileContext = { sandbox: level.sandbox, files }
          } catch (error) {
            this.endSession(sessionId)
            return yield finish('error', error.message)
          }
        } else if (this.sessionFiles.owners.has(sessionId)) {
          this.endSession(sessionId, 'Image session permission changed. Send a new message to continue.')
          return yield* stopped('Image session permission changed. Send a new message to continue.')
        }
        // Feature configuration belongs to the process. An effective own-mode/level crossing
        // cannot retain it, even when there is no bridge and no granted file yet.
        if (live && (Boolean(live.fileOwner) !== Boolean(fileOwner) || (fileOwner && live.fileOwner !== fileOwner))) {
          this.end(sessionId, live, { preserveFiles: true })
          live = undefined
        }
      }
      // A bridge that closed (its process ended and said so) is not coming back: the agent on
      // that session has lost DSH's tools for good, and would answer this turn without them.
      // Its session ends here and the turn starts a new one, which the replay carries the chat
      // to, as for an agent that is no longer alive (#969).
      let full = false
      try { full = levelOf(this.ctx.get?.('approval'), dshAgent?.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets')).full === true } catch {}
      const asks = typeof agent.hardAsk === 'function' && !(this.bridgeOn(agent) && agent.disableBuiltInTools === true) && !full
      const bridgeGone = live?.bridge?.closed === true && this.bridgeOn(agent)
      if (bridgeGone) this.warn(`${live.name} lost its ${BRIDGE_NAME} bridge: its session was ended and a new one starts`)
      if (live !== undefined && (live.provider !== options.provider || !live.run.alive || bridgeGone || live.asks !== asks)) {
        this.end(sessionId, live)
        live = undefined
      }
      // The account this CLI is signed in to waits for the person's word (index.js, consent.js):
      // refused like a signed-out CLI, before any process starts, and never answered elsewhere.
      let unconfirmed
      try { unconfirmed = await this.access?.(options.provider) } catch {
        unconfirmed = 'The Bot account could not be checked. Sign in again in the app.'
      }
      // Ended while the consent was read: nothing starts for this turn.
      if (entry.held !== undefined) {
        started()
        return yield* stopped(entry.held)
      }
      if (typeof unconfirmed === 'string' && unconfirmed !== '') return yield finish('error', unconfirmed, MODEL_ACCESS_REQUIRED)
      // The agent is still on its last prompt (a Stop it has not answered yet, a turn DSH ended
      // without it). Asked to stop, it has `cancelWaitMs`; one that will not end is replaced
      // below by a new session in this same turn, which the replay carries the chat to, so the
      // chat never waits on it again.
      if (live !== undefined && live.run.busy) {
        const ended = await this.stopping(live, options.signal)
        // Ended while the old prompt was given its time (endSession): nothing starts here.
        if (entry.held !== undefined) {
          started()
          return yield* stopped(entry.held)
        }
        if (options.signal?.aborted) {
          if (!ended) this.reap(sessionId, live)
          return yield STOPPED()
        }
        // `alive` and the map: the Stop's own wait (reap) may have ended it meanwhile.
        if (!ended || !live.run.alive || this.live.get(sessionId) !== live) {
          if (!ended) this.warn(`${agent.name} did not stop its last answer within ${waited(this.cancelWaitMs)}: a new session replaces it`)
          this.end(sessionId, live)
          live = undefined
        }
      }
      let fresh = false
      let crossing = false
      const prior = lastProviderOf(options.messages)
      // The transcript before this turn: what a replay carries (plan A-5, independent of the
      // bridge; only the kill switch turns it off).
      const history = options.messages.slice(0, turnStart(options.messages))
      const replaying = this.replayOn()
      if (live === undefined) {
        crossing = replaying && prior !== undefined && prior !== options.provider
        const state = { fileOwner, pendingMirrors: new Set(), fileSandbox: fileContext?.sandbox, provider: options.provider, name: agent.name, asks, run: undefined, calls: new Set(), toolIds: new Map(), open: false, dshAgent, bridge: undefined, replay: undefined, owed: undefined, drifted: false }
        // A connector release that passed its start check is still unproven until it opens a
        // session. One that fails here goes back to the release before it (install.js), and the
        // session start is tried once more on that one: the turn is not lost to a bad release.
        for (let attempt = 0; ; attempt += 1) {
          try {
            // The chat profile modes belong to this process's home, read once at its start: a
            // later spawn or a replaced agent object never changes what a running session asks.
            const { profileModes, sessionFileMode, sessionFileEnabled, ...spec } = await agent.spawn(fileContext === undefined ? undefined : { sessionFiles: fileContext })
            state.profileModes = profileModes
            state.sessionFileMode = sessionFileMode
            state.sessionFileEnabled = sessionFileEnabled === true
            if (fileContext?.files.length && (!sessionFileMode || !state.sessionFileEnabled)) throw new Error('The exact image profile is unavailable.')
            if (fileOwner && (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined)) throw new Error('Image permission changed during startup.')
            if (!state.sessionFileEnabled && fileOwner) {
              this.sessionFiles.clear(sessionId, { owner: fileOwner })
              state.fileOwner = fileOwner = undefined
            }
            if (this.bridgeOn(agent)) {
              await this.backchannel.listen()
              if (fileOwner && (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined || options.signal?.aborted)) throw new Error('Image permission changed while the bridge started.')
              state.bridge = this.backchannel.mint({ sessionId, agent: dshAgent, name: agent.name, promptRunning: () => state.open === true && state.run?.busy === true })
            }
            this.diagnostics?.started(sessionId, this, agent, state)
            const run = new AgentRun({
              ...spec,
              cwd: dshAgent?.session?.header?.cwd
                ?? spec.env?.AUTOMAGIK_BOT_CLI_HOME ?? homedir(),
              name: agent.name,
              mcpServers: state.bridge === undefined ? [] : [this.bridgeServer(state.bridge)],
              ...(this.bridgeOn(agent) && agent.disableBuiltInTools === true
                ? { sessionMeta: { disableBuiltInTools: true } }
                : asks ? { sessionMeta: agent.hardAsk() } : {}),
              dshTools: this.bridgeOn(agent),
              refresh: agent.refresh,
              onReady: state.bridge === undefined ? undefined : () => this.ready(agent, state),
              onAsked: () => { if (state.own === true && state.bridge !== undefined) state.bridge.agentAsked = true },
              onToolCall: tool => this.checkDrift(sessionId, agent, tool),
              onIgnored: message => this.warn(message),
              onRefusedMcp: tool => this.warn(`${agent.name} asked to run an MCP tool of ${typeof tool.mcpServer === 'string' ? `server "${tool.mcpServer.slice(0, 80)}"` : 'an unnamed server'}: refused, only the ${BRIDGE_NAME} bridge's tools run with DSH's tools on`),
              onMode: seen => this.diagnostics?.mode(sessionId, state, seen),
              ...(agent.startMs === undefined ? {} : { startMs: agent.startMs }),
              ...(agent.requestMs === undefined ? {} : { requestMs: agent.requestMs }),
              timers: this.timers,
            })
            state.run = run
            this.live.set(sessionId, state)
            await run.start({ signal: options.signal })
            if (fileOwner && (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined)) throw new Error('Image permission changed during startup.')
            try { agent.proven?.() } catch {}
            break
          } catch (error) {
            // Nothing is left of a start that failed: the process is gone with its bridge.
            this.end(sessionId, state)
            state.run = undefined
            state.bridge = undefined
            // Ended while it started (endSession): not a failed connector, so no rollback.
            if (state.held !== undefined) return yield* stopped(state.held)
            // A Stop while it started ends the turn as any Stop does; a start nobody answered
            // says where to look. Neither blames the connector's release: a CLI waiting for the
            // person hangs the same way on any release, so there is no rollback for them.
            const left = this.unanswered(agent, error, 'starting')
            if (left !== undefined) return yield left
            if (isAuthRequired(error)) {
              this.signedOut(options.provider)
              return yield signInFailure(agent, error)
            }
            if (error?.code === 'acp-account/busy') {
              return yield finish('error', error.message, MODEL_ACCESS_REQUIRED)
            }
            // A missing bridge is this computer's config, not the release: no rollback for it.
            let back = false
            if (!fileContext?.files.length && attempt === 0 && error?.code !== 'acp_bridge_missing' && options.signal?.aborted !== true) {
              try { back = agent.rollback?.(error) === true } catch {}
            }
            if (back) {
              try { this.ctx.logger?.warn?.(`acp-dsh: ${agent.name} did not start on its newest connector (${error?.message ?? error}); trying the one before it`) } catch {}
              continue
            }
            let repairing = false
            if (!fileContext?.files.length && attempt === 0 && error?.code !== 'acp_bridge_missing' && options.signal?.aborted !== true) {
              try { repairing = agent.repair?.(error) === true } catch {}
            }
            const repair = repairing ? ' Its connector looks damaged, so it is being reinstalled: send this again in a minute.' : ''
            return yield finish('error', `${agent.name} did not start: ${error?.message ?? error}${repair}`, error?.code === 'acp_bridge_missing' ? 'acp_bridge_missing' : undefined)
          }
        }
        live = state
        fresh = true
        if (crossing) {
          this.appendBoundary(dshAgent, agent, options.provider)
          live.owed = { from: this.agents.get(prior)?.name ?? 'DSH' }
          live.replay = replayBlocks(history, { redact: this.redact, to: agent.name, ...live.owed })
        } else if (replaying && answered(history)) {
          // A new session of the same agent in a chat that already has answers (a restart, a
          // session ended by a crossing or a flip, the first real turn of a Bot part whose
          // handoff turn the Bot team answered itself) is a crossing too: the chat, the handoff
          // package included, reaches it. No boundary row: the chat did not change providers.
          const blocks = replayBlocks(history, { redact: this.redact, to: agent.name, renewed: true })
          if (blocks.length > 1) {
            live.owed = { renewed: true }
            live.replay = blocks
          }
        }
      } else if (replaying && live.replay !== undefined) {
        // The last turn never reached its prompt (a refused model, a busy agent): its replay is
        // still owed, read again over the chat as it is now. Its row is already written.
        const source = live.owed?.missed === true ? missedBy(history, options.provider) : history
        if (source !== undefined) live.replay = replayBlocks(source, { redact: this.redact, to: agent.name, ...live.owed })
      } else if (replaying) {
        // A live session resumed after the chat answered elsewhere (an agent whose session a
        // move off it keeps, Codex by default): the turns it missed are replayed before the
        // prompt, so Codex -> API -> Codex loses nothing, and the move back writes its row.
        const missed = missedBy(history, options.provider)
        const owed = { from: this.agents.get(prior)?.name ?? 'DSH', missed: true }
        const blocks = missed === undefined ? [] : replayBlocks(missed, { redact: this.redact, to: agent.name, ...owed })
        if (blocks.length > 1) {
          if (prior !== undefined && prior !== options.provider) this.appendBoundary(dshAgent, agent, options.provider)
          live.owed = owed
          live.replay = blocks
        }
      }
      // A preset or level change since the last turn: the bridge serves the new set, and an
      // agent that ignores `tools/list_changed` gets the list through a fork instead.
      if (live.bridge !== undefined && this.bridgeOn(agent)) {
        const changed = this.backchannel.refresh(live.bridge)
        if (changed && agent.refresh === 'fork') {
          if (live.sessionFileMode) {
            this.endSession(sessionId)
            return yield* stopped('The image session ended when its tools changed. Ask for image permission again.')
          }
          try {
            await this.refork(agent, live, dshAgent, options.signal)
          } catch (error) {
            if (live.held !== undefined) return yield* stopped(live.held)
            const left = this.unanswered(agent, error, 'refreshing its DSH tools')
            if (left !== undefined) return yield left
            return yield finish('error', `${agent.name} would not refresh its DSH tools: ${error?.message ?? error}`, error?.code === 'acp_bridge_missing' ? 'acp_bridge_missing' : undefined)
          }
        }
      }
      // The Session's model and effort, then its level as the agent's own permission mode, before every prompt.
      try {
        await choose(
          live.run, options.model, options.reasoningEffort,
          () => agent.catalog?.ownEffort(options.model),
          { signal: options.signal },
        )
      } catch (error) {
        if (live.held !== undefined) return yield* stopped(live.held)
        const left = this.abandoned(sessionId, live, agent, error, `taking ${options.model}`)
        if (left !== undefined) return yield left
        const at = options.reasoningEffort ? ` at ${options.reasoningEffort} effort` : ''
        const reason = error?.message ?? error
        const why = `${agent.name} would not take ${options.model}${at}: ${reason}`
        return yield finish('error', why)
      }
      const level = levelOf(this.ctx.get?.('approval'), dshAgent?.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
      const originalModes = agent.modeFor?.(level)
      const profiles = live.profileModes
      const modes = live.sessionFileMode ? [live.sessionFileMode] : profiles ? chatProfileModes(originalModes, profiles) : originalModes
      const strict = live.sessionFileMode ? [live.sessionFileMode] : profiles ? chatProfileModes([originalModes?.at(-1)], profiles) : [originalModes?.at(-1)]
      const possible = agent.ownMode !== undefined && level.sandbox === 'workspace-write' && level.policy === 'ask' && !level.full && !level.auto
      const candidate = possible && live.run.modes?.availableModes?.some(mode => mode.id === agent.ownMode)
      let own = 'none'
      if (candidate) {
        own = await this.ownAnswer(sessionId, dshAgent, options.provider)
        if (live.held !== undefined) return yield* stopped(live.held)
        if (own === 'yes' && live.sessionFileEnabled) {
          this.endSession(sessionId)
          return yield finish('error', 'The effective permission mode changed. Send a new message to continue.')
        }
        if (own === 'yes') {
          live.ownSent = true
          try { await live.run.setMode([agent.ownMode], { signal: options.signal }) } catch (error) {
            if (live.held !== undefined) return yield* stopped(live.held)
            const left = this.abandoned(sessionId, live, agent, error, 'taking DSH\'s permission level')
            if (left !== undefined) return yield left
            own = 'refused'
          }
          if (live.held !== undefined) return yield* stopped(live.held)
        }
      }
      try {
        if (possible && own !== 'yes') {
          if (live.ownSent === true || live.sessionFileMode) await live.run.setMode(strict, { signal: options.signal, force: true })
          else await live.run.setMode(modes, { signal: options.signal })
        } else if (!possible) await live.run.setMode(modes, { signal: options.signal, force: Boolean(live.sessionFileMode) })
        if (live.held !== undefined) return yield* stopped(live.held)
      } catch (error) {
        if (live.held !== undefined) return yield* stopped(live.held)
        const left = this.abandoned(sessionId, live, agent, error, 'taking DSH\'s permission level')
        if (left !== undefined) return yield left
        if (live.ownSent === true || live.fileOwner) this.end(sessionId, live)
        return yield finish('error', `${agent.name} would not take DSH's permission level: ${error?.message ?? error}`)
      }
      // Asked again right before the prompt: a Session held since the first ask (while consent,
      // the start, a fork or the mode were awaited) gets no prompt. One that was ended since
      // the step's entry is refused whatever the gate says now: its mode above was read from a
      // level that has changed, and a gate that lets go here must not let this turn through.
      const late = entry.held ?? live.held ?? await this.heldBack(sessionId, dshAgent, options.provider) ?? entry.held
      started()
      if (late !== undefined) {
        this.endSession(sessionId, late)
        return yield* stopped(late)
      }
      if (own === 'yes') {
        const again = await this.ownAnswer(sessionId, dshAgent, options.provider)
        if (live.held !== undefined) return yield* stopped(live.held)
        if (again !== 'yes') {
          own = 'changed'
          try { await live.run.setMode(strict, { signal: options.signal, force: true }) } catch (error) {
            if (live.held !== undefined) return yield* stopped(live.held)
            const left = this.abandoned(sessionId, live, agent, error, 'taking DSH\'s permission level')
            if (left !== undefined) return yield left
            this.end(sessionId, live)
            return yield finish('error', `${agent.name} would not take DSH's permission level: ${error?.message ?? error}`)
          }
          if (live.held !== undefined) return yield* stopped(live.held)
        }
      }
      // A table agent with no `modeFor` took no level above: say so once per agent session.
      if (fresh && agent.levelNotice === true) {
        try {
          dshAgent?.session?.append?.('user/message', ownPermissionsNotice(agent.name), { surfaceOp: 'append' })
        } catch (error) {
          try { this.ctx.logger?.warn?.(`acp-dsh: the permission notice was not written: ${error?.message ?? error}`) } catch {}
        }
      }
      // A new agent session in a chat that already has answers says so once, in a row of its
      // own before the reply (bots-dsh's fallback.js writes its notice the same way). The
      // prompt below was read before it, and promptOf leaves it out of later ones.
      if (fresh && live.replay === undefined && options.messages.some(message => message.role === 'assistant')) {
        try {
          dshAgent?.session?.append?.('user/message', freshSessionNotice(agent.name), { surfaceOp: 'append' })
        } catch (error) {
          try { this.ctx.logger?.warn?.(`acp-dsh: the new-session notice was not written: ${error?.message ?? error}`) } catch {}
        }
      }
      if (live.fileOwner) {
        try {
          await this.sessionFiles.activate(live.fileOwner, last, options.signal)
          if (!this.sessionFiles.valid(live.fileOwner) || this.live.get(sessionId) !== live ||
              (live.sessionFileMode && live.run.modes?.currentModeId !== live.sessionFileMode) || own === 'yes') throw new Error('Image permission changed before the prompt.')
        } catch (error) {
          this.endSession(sessionId)
          return yield finish('error', error.message)
        }
      }
      const prompt = live.replay !== undefined
        ? [...live.replay, ...promptOf(options.messages, this.redact)]
        : promptOf(options.messages, this.redact)
      live.replay = undefined
      live.owed = undefined
      live.drifted = false
      live.open = true
      live.own = own === 'yes'
      // Ordinary strict sessions have no Auto record until an own-mode attempt or a late answer.
      this.diagnostics?.own(sessionId, live, live.ownSent === true || ['yes', 'late', 'changed', 'refused'].includes(own) ? { answer: own, taken: live.own } : undefined)
      if (live.bridge !== undefined) live.bridge.agentAsked = false
      // The previous turn's mirrors are finished for DSH; continuation steps keep these above.
      live.calls.clear()
      live.toolIds?.clear()
      live.run.prompt(prompt).catch(() => {})
    }
    // The turn stays open until its end is drained here: the agent may finish it before DSH
    // asks for the step after a tool result.
    for (;;) {
      const event = await live.run.next(options.signal)
      // Its agent session was ended under it (endSession): whatever came is not shown.
      if (live.held !== undefined) {
        yield* shown()
        return yield* stopped(live.held)
      }
      if (event.type === 'end' || event.type === 'error') live.open = false
      // The prompt is over (finished, failed or stopped): nobody waits for a DSH tool call the
      // bridge still has in flight, so each is stopped; the bridge itself stays for the next turn.
      if (event.type === 'end' || event.type === 'error' || event.type === 'aborted') this.backchannel?.cancel?.(live.bridge, event.type === 'aborted' ? 'the turn was stopped' : 'the turn ended')
      // Inbound text is logged as the agent said it: DSH does not redact at ingest, and neither
      // does this plugin. The redactor runs at each provider crossing instead — the replay out
      // (`replayBlocks`) and the transcript handed back to a native provider (`crossed`).
      if (event.type === 'text') {
        const text = links.push(event.text)
        if (text !== '') yield* blocks.add('text', text)
      } else if (event.type === 'thought') {
        yield* shown()
        yield* blocks.add('reasoning', event.text)
      } else if (event.type === 'tool') {
        const tool = live.run.tools.get(event.id)
        // Its entry went with a fork or retirement.
        if (tool === undefined) continue
        this.diagnostics?.call(sessionId, live, tool)
        // A DSH tool call is not a mirror call: the bridge writes its rows and DSH draws the one
        // card from them. On `acp-codex` no structured name is proven, so any MCP call there is
        // left to the bridge too; its own tools keep their cards.
        // `ToolSearch` is the adapter's own deferred-tool loader (it stays with `tools: []`); it
        // is not a DSH tool and gets no card or dialog either.
        const skip = tool.drift === true || tool.bridge === true
          || tool.structuredName === 'ToolSearch'
          || (agent.refresh === 'fork' && tool.mcp === true)
        if (this.bridgeOn(agent) && skip) {
          live.run.answerSkippedMcp(tool)
          if (tool.drift === true) {
            // Drift can be discovered after the nameless event was queued. No card will ask
            // its question: the built-in call already started and is being cancelled. A
            // mirror would wrongly invite approval. Withdraw stored and later questions here.
            tool.unanswerable = true
            tool.permission?.answer({ outcome: { outcome: 'cancelled' } })
          }
          continue
        }
        yield* shown()
        await settle(tool, DETAIL_WAIT_MS)
        const id = `acp_${randomUUID()}`
        live.calls.add(id)
        live.pendingMirrors?.add(id)
        // The agent's own id for the call, for a refusal that comes before the mirror's body.
        ;(live.toolIds ??= new Map()).set(id, tool.id)
        yield* blocks.toolCall(id, TOOL_NAME, JSON.stringify(callArguments(tool)))
        return yield finish('tool-calls')
      } else if (event.type === 'end') {
        const wasOwn = live.own
        live.own = false
        const r = live.run.reviews
        if (wasOwn && r?.denied > 0 && (r.inRow >= 3 || r.denied >= 10 || (r.last === 'denied' && !r.after))) {
          try { dshAgent?.session?.append?.('user/message', reviewerStopNotice(agent.name, r.denied), { surfaceOp: 'append' }) } catch (error) {
            try { this.ctx.logger?.warn?.(`acp-dsh: the reviewer notice was not written: ${error?.message ?? error}`) } catch {}
          }
          yield* shown()
          yield* blocks.close()
          return yield finish('stop')
        }
        yield* shown()
        yield* blocks.close()
        if (event.stopReason === 'cancelled') return yield finish('aborted', 'Stopped', 'ABORTED')
        return yield finish(FINISH[event.stopReason] ?? 'stop')
      } else if (event.type === 'error') {
        live.own = false
        yield* shown()
        yield* blocks.close()
        if (isAuthRequired(event)) {
          this.signedOut(options.provider)
          return yield signInFailure(agent, event)
        }
        return yield finish('error', `${agent.name}: ${event.message}`)
      } else if (event.type === 'aborted') {
        live.open = false
        // The turn ends here for the person; the agent's side of it has `cancelWaitMs` to end,
        // counted from now, whether or not the agent still reads what it is sent.
        if (live.own) {
          const cancelling = live.run.cancel()
          this.end(sessionId, live)
          await cancelling
        } else {
          this.reap(sessionId, live)
          await live.run.cancel()
        }
        yield* shown()
        yield* blocks.close()
        return yield finish('aborted', 'Stopped', 'ABORTED')
      }
    }
  }

  /**
   * The row that says the chat is moving to another provider. It is written before the reply,
   * and the call can still fail after it, so it claims no answer (plan A-4): "Switching to X",
   * never "Now answered by X". Whether X answered is read from the next assistant message's
   * source, never from this row.
   */
  appendBoundary(dshAgent, agent, provider) {
    try {
      dshAgent?.session?.append?.('user/message', boundaryNotice(`Switching to ${agent.name} (${provider})`), { surfaceOp: 'append' })
    } catch (error) {
      try { this.ctx.logger?.warn?.(`acp-dsh: the provider-boundary row was not written: ${error?.message ?? error}`) } catch {}
    }
  }

  dispose() {
    try { this.offResult?.() } catch {}
    try { this.offReviewed?.() } catch {}
    this.starting.clear()
    for (const id of this.sessionFiles.owners.keys()) this.sessionFiles.clear(id)
    for (const agent of this.agents.values()) agent.catalog?.dispose()
    for (const [sessionId, live] of this.live) this.end(sessionId, live)
  }
}

export function reviewerStopNotice(name, n) {
  const summary = `${name} stopped after its own reviewer refused ${n === 1 ? 'a step' : `${n} steps`}. Reply to let it go on; refused steps stay refused`
  return createUserMessage({ content: [{ type: 'text', text: `[${summary}.]` }], source: { kind: NOTICE_KIND, form: 'notice', stop: 'refusals', summary } })
}
