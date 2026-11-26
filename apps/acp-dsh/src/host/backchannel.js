// The bridge→DSH leg (RFC 0003, amendment, "The bridge"). The bridge runs as the agent's child,
// so it cannot inherit a pipe from DSH: it reaches this plugin over a loopback HTTP channel with
// a per-session credential minted at spawn and passed only in that bridge's env. The credential
// binds a request to its Session. The host revokes it when the session or agent process ends,
// a fork replaces it, or a probe ends. A bridge process exit only detaches, so a respawn can
// use the same credential. Same-user code can read the bearer and impersonate a replacement.
// DSH's server-side approval service owns each call under the Session's level.
//
// This module also owns the tool set the bridge serves: the Session's preset tools (standard,
// or cordis in creator mode: whatever preset the Session runs), minus the tools its level cannot
// use, minus the mirror tool. A preset, model or level change is a new signature, and the
// bridge announces it (`notifications/tools/list_changed`) instead of the agent keeping a stale
// list.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createAssistantMessage, createDeveloperMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SYNTHETIC_KIND } from './names.js'
import { bridgeImages, nestedPlaceholder, readMsOf, readStoredImage, refMediaType } from './bridge-image.js'
import { levelOf, TOOL_NAME } from './tool.js'
import { guardSession } from './write-guard.js'

export function bridgeRefusalText(name, outcome, policy) {
  if (outcome === 'rejected') return policy === 'never'
    ? `Nobody was asked about ${name}: approval prompts are off in this conversation, so DSH refused it.`
    : `The person rejected ${name}.`
  if (outcome === 'unavailable') return `DSH could not approve ${name}: nobody could answer its approval request.`
  return `DSH could not approve ${name}.`
}

/**
 * The text an in-process approval listener left on a bridge ask it rejected (`bridgeCall.refused`,
 * the Solver's review guard, RFC 0048), so the agent reads why instead of "The person rejected".
 */
const refusedText = request => {
  const reason = request?.bridgeCall?.refused?.reason
  return typeof reason === 'string' && reason.trim() !== '' ? reason.replace(/\s+/g, ' ').slice(0, 2000) : undefined
}

/** How long a bridge's long-poll waits before answering "nothing changed". */
export const WAIT_MS = 20_000
const MAX_BODY = 16 * 1024 * 1024
const MAX_RETIRED = 64
const OUTPUT_LIMIT = 20_000
// A reviewer that never answers must not hold the bridge's call forever. Auto only.
const REVIEW_TIMEOUT_MS = 120_000
// Events that can change the Session's level while a review is pending.
const LEVEL_EVENTS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])

// Tools that only write files: a Session in DSH's read-only sandbox cannot run them, so they
// are not offered. Shell tools stay (read-only commands are legitimate; the sandbox denies the
// writes) and every other tool is DSH's own decision at execution time.
export const MUTATING_TOOLS = Object.freeze(new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'office_convert', 'office_recalculate', 'office_render']))
// User-owned terminals are outside the Session's read-only filesystem boundary.
export const READ_ONLY_DENIED_TOOLS = new Set([...MUTATING_TOOLS, 'user_terminal_list', 'user_terminal_read'])
// Native-tools mode (`nativeTools`, #1564): the agent keeps its own built-in tools, so the
// bridge does not offer DSH's twin of any of them, nor the DSH subagent tools that would only
// talk to a registry the agent's own `Agent` tool never uses. What stays is what Claude Code
// has no tool for: the Bot team's tools, goals, workflow, working_directory and the rest.
// `web_search`, `web_fetch` and `exit_plan_mode` are conditional and not offered today; they
// are named so they stay out once they are.
export const NATIVE_TWIN_TOOLS = Object.freeze(new Set([
  'bash', 'job_output', 'job_list', 'job_kill',
  'read', 'write', 'edit', 'read_image', 'apply_patch', 'str_replace_editor', 'glob', 'grep',
  'skill', 'todo_write',
  'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent', 'list_subagent_models',
  'web_search', 'web_fetch', 'exit_plan_mode',
]))

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block?.type === 'text' ? block.text ?? '' : block?.type === 'resource' ? block.resource?.text ?? '' : '')).filter(Boolean).join('\n')
}

// Inline image blocks are base64 text already, and one large or undecodable picture would
// otherwise reach the agent's model whole: only the types every provider decodes, and at most
// 5 MiB decoded.
const INLINE_IMAGE_TYPES = Object.freeze(new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']))
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024

// The decoded byte count of base64 text, from its length: the payload is sized, never decoded,
// so checking a block does not cost its decode.
const base64Bytes = (data) => Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

// Why an inline image block cannot go to the agent as image content, or undefined when it can:
// its type is one the agent's model decodes and its payload is within the cap.
function inlineImageProblem(block) {
  if (!INLINE_IMAGE_TYPES.has(block.mimeType ?? block.mediaType)) return 'not a supported image type'
  if (base64Bytes(block.data) > MAX_INLINE_IMAGE_BYTES) return 'larger than 5 MiB'
  return undefined
}

// The MCP image content of one DSH image block, in the shape an ACP agent's model accepts:
// `{ type: 'image', data, mimeType }`. Inline data is already base64 and passes through as it is
// (never encoded twice) when it is a supported image type within the cap; a durable attachment
// (`attachment`, DSH's own image block) is read and encoded once. Undefined when the bytes cannot
// be recovered: unsupported or oversized inline data, no attachment store is mounted, or it
// refused the reference.
async function mcpImage(block, attachments) {
  const mimeType = block.mimeType ?? block.mediaType ?? block.attachment?.mediaType
  if (typeof block.data === 'string' && block.data !== '') {
    // ACP image content needs a media type the model decodes, and no block may push an
    // unbounded payload at it; an untyped, unsupported or oversized block is not guessed at.
    if (inlineImageProblem(block) !== undefined) return undefined
    return { type: 'image', data: block.data, mimeType }
  }
  if (block.attachment === undefined) return undefined
  try {
    const stored = await readStoredImage(attachments, block.attachment, readMsOf())
    const storedType = stored?.ref?.mediaType ?? mimeType
    if (stored === undefined || storedType === undefined) return undefined
    return { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: storedType }
  } catch {
    return undefined
  }
}

// The one-line text an image's place in the result becomes when its bytes cannot reach the
// model: the media type it named, then why.
function unavailableText(image) {
  if (nestedPlaceholder(image) !== undefined) return nestedPlaceholder(image)
  const type = image.mimeType ?? image.mediaType ?? refMediaType(image) ?? 'unknown media type'
  const reason = typeof image.data === 'string' && image.data !== ''
    ? inlineImageProblem(image)
    : 'the attachment could not be read'
  return `[image unavailable: ${type}; ${reason}]`
}

// A DSH tool result as MCP content: its text exactly as before (one joined, truncated block),
// then each image as MCP image content. An image whose bytes cannot be recovered becomes a text
// placeholder, so the agent sees that the result had one instead of only an empty line.
async function contentOf(content, attachments) {
  const text = textOf(content)
  const clipped = text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text
  const images = bridgeImages(content)
  if (images.length === 0) return [{ type: 'text', text: clipped }]
  const blocks = text === '' ? [] : [{ type: 'text', text: clipped }]
  for (const image of images) {
    const mcp = await mcpImage(image, attachments)
    blocks.push(mcp ?? { type: 'text', text: unavailableText(image) })
  }
  return blocks
}

// The `error` of a tool/result row: a string name and, when there is one, a string code. A tool
// may hand back any object as its error; only these two fields enter the log.
function infoOf(info) {
  if (info === undefined || info === null) return undefined
  // Reading a field of somebody else's object can throw (a getter, a proxy): it is then an
  // error with no name and no code of its own.
  try {
    // Each field is read once: a getter may answer differently the next time.
    const { name, code } = info
    return {
      name: typeof name === 'string' && name !== '' ? name : 'Error',
      ...(typeof code === 'string' ? { code } : {}),
    }
  } catch {
    return { name: 'Error' }
  }
}

// What a thrown value says, as text, whatever it is (#855). A tool body is somebody else's
// code: it can throw a Symbol, an object with no prototype, or an object whose own fields
// throw when read, and building a sentence from one must never throw in turn: the call would
// be left with no result.
function thrownText(cause) {
  try {
    const message = cause?.message
    if (typeof message === 'string') return message
  } catch {}
  try {
    const text = String(cause)
    if (typeof text === 'string') return text
  } catch {}
  return 'a value that cannot be shown'
}

/** The agent's preset, as the preset registry records it; `standard` when no registry composes. */
export function presetOf(ctx, session) {
  try {
    return ctx?.get?.('agentPresets')?.presetForSession?.(session) ?? 'standard'
  } catch {
    return 'standard'
  }
}

/**
 * What the bridge offers this Session right now: its preset's visible tools, without the mirror
 * tool, and without output tools or user-terminal access when the Session is read-only. In
 * native-tools mode (`native`), without DSH's twins of the agent's own tools either.
 * @param {{ get?: (name: string) => any }} ctx
 * @param {any} agent the DSH Agent the Session runs
 * @param {{ native?: boolean }} [options]
 * @returns {Array<{ name: string, description: string, inputSchema: object }>}
 */
export function offeredTools(ctx, agent, { native = false, skillOnly = false } = {}) {
  const tools = ctx?.get?.('tools')
  if (tools?.definitions === undefined || agent === undefined) return []
  const level = levelOf(ctx?.get?.('approval'), agent.session, ctx?.get?.('sandboxPolicy'), ctx?.get?.('permissionPresets'))
  return tools.definitions(agent)
    .filter((definition) => definition.name !== TOOL_NAME)
    .filter((definition) => !skillOnly || definition.name === 'load_skill')
    // A conditional tool (step admission via `when`) has no call outside a model step; DSH's
    // own tools here run outside the agent's loop, so only unconditionally executable ones are
    // offered.
    .filter((definition) => typeof tools.executable !== 'function' || tools.executable(definition.name, agent) !== undefined)
    .filter((definition) => level.sandbox !== 'read-only' || !READ_ONLY_DENIED_TOOLS.has(definition.name))
    .filter((definition) => native !== true || !NATIVE_TWIN_TOOLS.has(definition.name))
    .map((definition) => ({
      name: definition.name,
      description: typeof definition.description === 'string' ? definition.description : '',
      inputSchema: definition.parameters ?? { type: 'object', properties: {} },
    }))
}

/**
 * The Session's current provider route, for the source of a block written on its behalf. A
 * Session before its first request has none; the block only needs a producer-owned source kind.
 * @returns {{ provider?: string, model?: string }}
 */
export function routeOf(session) {
  try {
    const config = session?.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') return { provider: config.provider, model: config.model }
  } catch {}
  return {}
}

/** A stable fingerprint of what the bridge would list: preset, level (Auto and Full included) and every tool's schema. */
export function signatureOf(ctx, agent, { native = false, skillOnly = false } = {}) {
  const level = levelOf(ctx?.get?.('approval'), agent?.session, ctx?.get?.('sandboxPolicy'), ctx?.get?.('permissionPresets'))
  return JSON.stringify({
    preset: presetOf(ctx, agent?.session),
    sandbox: level.sandbox ?? null,
    approval: level.policy ?? null,
    auto: level.auto === true,
    full: level.full === true,
    tools: offeredTools(ctx, agent, { native, skillOnly }).map((tool) => [tool.name, tool.description, tool.inputSchema]),
  })
}

/**
 * The turn and step the Session is in, as the log last committed them, for a reader that needs
 * the position whether or not the step is still open. `Backchannel.call` requires an open step
 * (`openStepOf`) because a tool row outside one is not a loadable v4 shape.
 */
export function positionOf(ctx, session) {
  const turn = (() => {
    try {
      return ctx?.agents?.turnBoundaryOf?.(session)?.lastTurn ?? 0
    } catch {
      return 0
    }
  })()
  let step = 0
  const events = session?.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'turn/start') break
    if (event?.type === 'step/start' && typeof event.data?.step === 'number') {
      step = event.data.step
      break
    }
  }
  return { turn, step }
}

/**
 * The step a bridge call can record in, if one is still open. A row written after its step
 * closed does not load, and Auto review's snapshot reads the pending call from this step.
 * @returns {{ turn: number, step: number } | undefined}
 */
export function openStepOf(session) {
  const events = session?.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'turn/start' || event?.type === 'turn/end' || event?.type === 'step/end') return undefined
    if (event?.type === 'step/start' && typeof event.data?.step === 'number') {
      return { turn: event.data.turn, step: event.data.step }
    }
  }
  return undefined
}

/** Keep caller ids out of the mirror's namespace and within the Session's id shape. */
export function bridgeCallId(callId) {
  return typeof callId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(callId) && !callId.startsWith('acp_')
    ? callId
    : `bridge_${randomBytes(8).toString('hex')}`
}

// The turn waiting for another step, if its latest boundary ended a step rather than the turn.
function betweenStepTurn(session) {
  const events = session?.snapshotEvents?.() ?? []
  let ended = false
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'turn/end') return undefined
    if (event?.type === 'turn/start') return ended ? event.data?.turn : undefined
    if (!ended && event?.type === 'step/start') return undefined
    if (event?.type === 'step/end') ended = true
  }
  return undefined
}

/** Whether the current turn ended a step and has not ended itself. */
export const betweenSteps = session => betweenStepTurn(session) !== undefined

// Capture the Session position when the bridge accepts the call. The tool can finish
// after another turn starts, and its completion then says nothing about its origin.
function outsideOriginOf(session) {
  const events = session?.snapshotEvents?.() ?? []
  const start = events.findLastIndex(event => event.type === 'turn/start')
  const turn = events[start]?.data?.turn
  if (!Number.isSafeInteger(turn) || turn < 0) return
  const end = events.findLastIndex(event => event.type === 'turn/end' && event.data?.turn === turn)
  if (end <= start) return
  for (let i = start + 1; i < end; i++) {
    const { type, data } = events[i]
    if (type !== 'user/message') continue
    const source = data?.source
    if (source?.kind === 'user') return source.handoff !== true ? { turn, exchangeId: null } : undefined
    if (source?.kind === 'bot') {
      return typeof source.exchangeId === 'string' && source.exchangeId !== ''
        ? { turn, exchangeId: source.exchangeId } : undefined
    }
    if (['goal', 'retry', 'schedule', 'user-question-reply'].includes(source?.kind)) return
  }
}

/**
 * What Auto review needs before it can read a bridge call: an open step, the Session's route,
 * and exactly one complete schema for the call in the request header. Missing any of them is a
 * refusal, never a call that runs unreviewed.
 * @returns {{ step: { turn: number, step: number }, provider: string, model: string } | { error: { code: string, text: string } }}
 */
export function reviewRouteOf(session, name) {
  const step = openStepOf(session)
  if (step === undefined) return { error: { code: 'AUTO_REVIEW_NO_STEP', text: 'Auto review cannot see this call: the Session has no open step.' } }
  let header
  try {
    header = session?.requestHeader?.()
  } catch {
    header = undefined
  }
  const provider = header?.config?.provider
  const model = header?.config?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return { error: { code: 'AUTO_REVIEW_NO_ROUTE', text: 'Auto review cannot see this call: the Session has no request route.' } }
  }
  const schemas = (Array.isArray(header.tools) ? header.tools : []).filter(tool => tool?.name === name)
  const schema = schemas[0]
  if (schemas.length !== 1 || typeof schema?.description !== 'string' || schema.parameters === null || typeof schema.parameters !== 'object' || Array.isArray(schema.parameters)) {
    return { error: { code: 'AUTO_REVIEW_NO_SCHEMA', text: `Auto review cannot see this call: the request header has no single complete schema for ${name}.` } }
  }
  return { step, provider, model }
}

/**
 * The marked assistant block that advertises one bridge call at its step, and the function that
 * takes it off the surface again. A bridge call is out-of-band: DSH's loop never writes the
 * assistant block that advertises a tool call, and the v4 Session loader requires one before
 * every tool/call row (#842). The block is replaced with an empty developer message, which
 * derives to no model message, so no later request or crossing sees the fake call (switch.js
 * also skips it). Throws when the block cannot be written. `openStepOf` is hoisted.
 * @returns {() => void} hide the block; a second call does nothing
 */
export function advertise(session, { turn, step }, route, { id, name, raw }, log) {
  let seq = session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id, name, arguments: raw }],
      source: { ...route, bridge: true, synthetic: SYNTHETIC_KIND },
    }),
  }, { surfaceOp: 'append' }).seq
  return () => {
    if (seq === undefined) return
    const shadowed = seq
    seq = undefined
    // The replacement is a step row: the loader refuses one stamped with a step that is no
    // longer the open one. The write guard hides the block before its step ends; one that
    // still missed that is left alone (`aside` in adapter.js skips it for a native provider).
    const open = openStepOf(session)
    if (open === undefined || open.turn !== turn || open.step !== step) {
      log('the synthetic bridge block was not removed: its step already ended')
      return
    }
    try {
      session.append('developer/message', {
        turn,
        step,
        message: createDeveloperMessage({ content: [], source: { kind: SYNTHETIC_KIND } }),
      }, { surfaceOp: { op: 'replace', startSeq: shadowed, endSeq: shadowed }, sourceEventSeqs: [shadowed] })
    } catch (cause) {
      log(`the synthetic bridge block was not removed: ${cause?.message ?? cause}`)
    }
  }
}

// DSH's own wording for a tool request that never reached a recorded start. The v4 loader
// accepts exactly this row (and no other) as the answer to an advertised call with no tool/call.
const NOT_STARTED_TEXT = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'

/**
 * Close an advertised call whose tool/call row could not be written. The advertisement is in
 * the log for good (hiding it only takes it off the surface), and the loader refuses a step
 * that ends with an advertised call unanswered: `step/end leaves unresolved tool call` (#957,
 * a session whose log has no tool/call row for the id the error names). The one answer it
 * accepts for a call that never started is DSH's own not-started repair row, written here.
 */
function closeNotStarted(session, { turn, step }, id, log) {
  try {
    session.append('tool/result', {
      turn,
      step,
      message: {
        id: `interrupted-tool-result-${id}-${session.snapshotEvents?.().length ?? 0}`,
        role: 'tool',
        toolCallId: id,
        isError: true,
        source: { kind: 'tool', callId: id },
        content: [{ type: 'text', text: NOT_STARTED_TEXT }],
      },
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    }, { surfaceOp: 'append' })
  } catch (cause) {
    log(`an advertised bridge call was not closed: ${cause?.message ?? cause}`)
  }
}

/**
 * The `acp_toolset_drift` record: a plugin record (replay-safe, outside DSH's released event
 * schemas) naming the structured call that should have been an MCP name. A reader that does not
 * know it retains and skips it.
 * @returns {boolean} whether the record landed
 */
export function recordDrift(session, data) {
  try {
    appendPluginRecord(session, 'plugin:acp-dsh/toolset-drift', data)
    return true
  } catch {
    return false
  }
}

/**
 * One back-channel for the plugin instance. Every ACP session gets its own credential; all of
 * them reach the same loopback server, which resolves the credential to its Session before it
 * reads anything else.
 */
function checkedSkillContent(ctx, record, name, requested, content) {
  if (name !== 'load_skill') return content
  const part = content.find(block => block?.automagikSkill?.kind === 'automagik-skill')
  if (!part || part.automagikSkill.use !== 'load' || part.automagikSkill.name !== requested) return []
  const current = ctx?.get?.('omniTeam')?.skillCalls?.load(record.sessionId, requested)
  return current?.automagikSkill.hash === part.automagikSkill.hash &&
    current.automagikSkill.botId === part.automagikSkill.botId && current.text === part.text ? [part] : []
}

function skillRequest(ctx, record, name, requested) {
  if (name !== 'load_skill') return
  const skills = ctx?.get?.('omniTeam')?.skillCalls
  if (typeof skills?.unavailable !== 'string') return
  // Capture the prompt's set now. A late result cannot close a native call in the next prompt.
  const refused = record.promptSkillRefusals?.()
  return {
    available: () => !refused?.has(requested) && skills.load(record.sessionId, requested) !== undefined,
    refuse: () => {
      if (typeof requested === 'string') refused?.add(requested)
      return { content: [{ type: 'text', text: skills.unavailable }], isError: true }
    },
  }
}

function skillActivityPosition(skills, session, position) {
  try { return skills?.bridgePosition?.(session, position) } catch { return undefined }
}

export class Backchannel {
  /**
   * @param {{ ctx: any, log?: (message: string) => void, reviewTimeoutMs?: number, stepWaitMs?: number }} options
   */
  constructor({ ctx, log = () => {}, reviewTimeoutMs = REVIEW_TIMEOUT_MS, stepWaitMs = 30_000 }) {
    this.ctx = ctx
    this.log = log
    this.reviewTimeoutMs = reviewTimeoutMs
    this.stepWaitMs = stepWaitMs
    this.records = new Map()
    this.closed = false
    // A turn that ends stops the calls still in flight on it: nobody waits for them any more.
    // (The adapter does the same when the agent's prompt ends; this covers every other end.)
    if (typeof ctx?.on === 'function') {
      try {
        this.offTurnEnd = ctx.on('session/event', (session, event) => {
          if (event?.type !== 'turn/end') return
          for (const record of this.records.values()) if (record.agent?.session === session) this.cancel(record, 'the turn ended')
        })
      } catch {}
    }
  }

  async listen() {
    if (this.closed) throw new Error('the back-channel is closed')
    if (this.server !== undefined) return this
    this.listening ??= this.bind().finally(() => { this.listening = undefined })
    return this.listening
  }

  async bind() {
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        try {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'internal' }))
        } catch {}
        this.log(`bridge request failed: ${error?.message ?? error}`)
      })
    })
    const bound = await new Promise((resolve, reject) => {
      const failed = error => {
        server.off('listening', listening)
        server.off('error', failed)
        reject(error)
      }
      const listening = () => {
        server.off('error', failed)
        resolve(server.address())
      }
      server.once('error', failed)
      server.once('listening', listening)
      try { server.listen(0, '127.0.0.1') } catch (error) { failed(error) }
    })
    if (this.closed) {
      server.close()
      throw new Error('the back-channel is closed')
    }
    server.unref?.()
    this.url = `http://127.0.0.1:${bound.port}`
    this.server = server
    return this
  }

  /**
   * Mint a Session-bound credential. A respawned bridge process re-attaches with the same
   * value. The host revokes it on session end, agent exit, fork or probe end.
   * `native`: the agent keeps its own tools (native-tools mode), so this bridge offers and runs
   * only DSH's extras, never a twin of one of them (NATIVE_TWIN_TOOLS).
   * @param {{ sessionId: string, agent: any, name: string, promptRunning?: () => boolean,
   *   promptSkillRefusals?: () => Set<string> | undefined, native?: boolean, skillOnly?: boolean,
   *   canList?: () => boolean }} options
   */
  mint({ sessionId, agent, name, promptRunning, promptSkillRefusals, native = false, skillOnly = false, canList }) {
    const credential = randomBytes(32).toString('hex')
    const record = {
      credential,
      sessionId,
      path: `/${encodeURIComponent(sessionId)}`,
      agent,
      name: name ?? 'agent',
      promptRunning,
      promptSkillRefusals,
      canList,
      native: native === true,
      skillOnly,
      generation: 0,
      signature: signatureOf(this.ctx, agent, { native: native === true, skillOnly }),
      announced: false,
      listed: false,
      closed: false,
      attachment: undefined,
      attachmentAbort: undefined,
      retired: new Set(),
      disconnected: false,
      waiters: new Set(),
      approvalCalls: new Set(),
      approvalWaiters: new Set(),
      abort: new AbortController(),
      // The controller of every call in flight (#957): each call has its own, so Stop, the end
      // of its turn or a caller that went away ends that call without revoking the bridge.
      controllers: new Set(),
    }
    this.records.set(credential, record)
    // From here the bridge may write rows on this Session: none the reader refuses (#958).
    record.guard = guardSession(agent?.session, { log: this.log })
    return record
  }

  /**
   * The URL one bridge posts to: its Session's own path, so a credential minted for another
   * Session is refused there even when it is otherwise live. Only this record's Session matches.
   */
  urlFor(record) {
    return `${this.url}${record.path}`
  }

  /** Revoke one bridge's credential and wake whatever it left waiting. */
  revoke(record) {
    if (record === undefined || record.closed) return
    record.closed = true
    this.records.delete(record.credential)
    record.retired.clear()
    try {
      record.abort.abort()
    } catch {}
    for (const wake of record.waiters) wake()
    record.waiters.clear()
    // The write guard stays while a call of this bridge is still in flight: its step can end
    // before its body does, and the guard is what closes it then (`leave` releases it).
    if (record.controllers.size === 0) record.guard?.release()
  }

  retire(record, id) {
    // Bound the history of a respawn storm. Dropping an id would let its process attach again.
    if (record.retired.size === MAX_RETIRED) return this.revoke(record)
    record.retired.add(id)
  }

  detach(record) {
    const { attachment, attachmentAbort } = record
    if (attachment !== undefined) this.retire(record, attachment)
    record.attachment = undefined
    record.attachmentAbort = undefined
    record.disconnected = true
    record.listed = false
    attachmentAbort?.abort(new Error('the bridge process exited'))
    this.wake(record)
  }

  attach(record, id) {
    if (record.attachment !== undefined) this.detach(record)
    if (record.closed) return
    record.attachment = id
    record.attachmentAbort = new AbortController()
    record.disconnected = false
    record.listed = false
    this.wake(record)
  }

  /**
   * Stop every call this bridge has in flight, and keep the bridge: the adapter calls it when
   * the agent's prompt ends, fails or is stopped, and the back-channel when the turn ends. An open
   * approval dialog is withdrawn and a running tool body gets its abort signal.
   */
  cancel(record, reason = 'the call was stopped') {
    if (record === undefined) return
    for (const controller of record.controllers) {
      try {
        controller.abort(new Error(reason))
      } catch {}
    }
  }

  /**
   * Recompute the offered set (a preset or level change may have landed since the last turn)
   * and, when it changed, let a waiting bridge announce it.
   * @returns {boolean} whether the list changed
   */
  refresh(record) {
    if (record === undefined || record.closed) return false
    const signature = signatureOf(this.ctx, record.agent, { native: record.native, skillOnly: record.skillOnly })
    if (signature === record.signature) return false
    record.signature = signature
    record.generation++
    this.wake(record)
    return true
  }

  /**
   * The ACP session exists (`session/new` or `session/fork` answered): only now may the bridge
   * announce a changed list. The spike's ordering rule: a `list_changed` before that answer
   * produced no re-list.
   */
  announce(record) {
    if (record === undefined || record.closed) return
    record.announced = true
    this.wake(record)
  }

  wake(record) {
    for (const wake of record.waiters) wake()
    record.waiters.clear()
  }

  /** Read the JSON body, capped: the bridge speaks small JSON-RPC envelopes. */
  async body(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async handle(request, response) {
    const reply = (status, value, onFinished) => {
      if (response.writableEnded || response.destroyed) return
      const body = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json' })
      if (onFinished !== undefined) response.once('finish', onFinished)
      response.end(body)
    }
    if (request.method !== 'POST') return reply(405, { error: 'method' })
    const header = String(request.headers.authorization ?? '')
    const credential = header.startsWith('Bearer ') ? header.slice(7) : ''
    const record = this.records.get(credential)
    const path = (() => {
      try {
        return new URL(request.url, 'http://127.0.0.1').pathname
      } catch {
        return ''
      }
    })()
    // A missing, another Session's, or a revoked credential is refused before the body is read:
    // the path names the Session, and this credential must be that Session's.
    if (record === undefined || record.closed || record.path !== path) {
      request.resume()
      return reply(401, { error: 'refused' })
    }
    const id = request.headers['x-dsh-bridge-attachment']
    if (id !== undefined && (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id))) {
      request.resume()
      return reply(400, { error: 'attachment' })
    }
    if (record.retired.has(id)) {
      request.resume()
      return reply(401, { error: 'refused' })
    }
    let body
    try {
      body = await this.body(request)
    } catch {}
    if (record.closed || record.retired.has(id)) return reply(401, { error: 'refused' })
    if (body === undefined) return reply(400, { error: 'body' })
    const op = body?.op
    // Headerless clients act for the current attachment. Only a process naming itself in a
    // handshake can take over, so a late call or poll cannot replace the one that listed.
    if (op === 'bye') {
      if (id === undefined || id === record.attachment) this.detach(record)
      else {
        this.retire(record, id)
        if (record.attachment === undefined) this.detach(record)
      }
      return reply(200, { ok: true })
    }
    if (id !== undefined && id !== record.attachment) {
      if (op !== 'hello' && op !== 'list') return reply(401, { error: 'refused' })
      this.attach(record, id)
      if (record.closed) return reply(401, { error: 'refused' })
    }
    if (op === 'hello') {
      this.refresh(record)
      return reply(200, { generation: record.generation })
    }
    if (op === 'list') {
      // A replacement can list before the ACP answer. Let that request finish with an empty
      // list; readiness then retires the refused bridge without releasing its announcement.
      if (record.canList?.() === false) return reply(200, { tools: [], generation: record.generation })
      this.refresh(record)
      record.listed = true
      return reply(200, { tools: offeredTools(this.ctx, record.agent, { native: record.native, skillOnly: record.skillOnly }), generation: record.generation })
    }
    if (op === 'call') {
      const attachment = record.attachment
      const attachmentSignal = record.attachmentAbort?.signal
      // The bridge puts no deadline on a call (a long wait, a slow command and an open approval
      // dialog are all legitimate), so the caller going away is what ends one: an MCP
      // `notifications/cancelled` or a dead bridge closes this request before its answer.
      const gone = new AbortController()
      response.once('close', () => {
        if (!response.writableFinished) gone.abort(new Error('the caller went away'))
      })
      if (response.destroyed) gone.abort(new Error('the caller went away'))
      // Counted while it runs, its rows included: who ends this bridge with a call under way
      // (the adapter's endSession) keeps the Session's write guard until the last one is back.
      record.calls = (record.calls ?? 0) + 1
      let result
      let confirmSkill
      const callId = typeof body.callId === 'string' ? body.callId : undefined
      try {
        result = await this.call(record, {
          name: typeof body.name === 'string' ? body.name : '',
          arguments: body.arguments ?? {},
          callId,
          signal: gone.signal,
          attachmentSignal,
          onSkillDelivered: confirm => { confirmSkill = confirm },
        })
      } finally {
        record.calls -= 1
        if (record.calls === 0) record.drained?.()
      }
      this.diagnostics?.bridgeCall(record, result)
      // A call that lost its authority while running answers with a refusal.
      if (record.closed || attachmentSignal?.aborted || result?.revoked === true) return reply(401, { error: 'refused' })
      if (confirmSkill === undefined || result?.isError !== false) return reply(200, result)
      return reply(200, result, () => {
        if (!response.writableFinished || response.destroyed || gone.signal.aborted || record.closed || attachmentSignal?.aborted) return
        // The request ID is for activity replay only. The execution, approval and mirror
        // still use the call ID. Scope request IDs to the authenticated bridge attachment.
        const requestId = body.requestId
        const replay = callId === undefined && (typeof requestId === 'string' || Number.isFinite(requestId) || requestId === null)
          ? createHash('sha256').update(JSON.stringify([credential, attachment, requestId])).digest('hex') : undefined
        try { confirmSkill(replay) } catch { /* Activity cannot change the bridge answer. */ }
      })
    }
    if (op === 'wait') {
      const since = Number.isFinite(body.generation) ? body.generation : record.generation
      const timeout = Number.isFinite(body.timeoutMs) ? Math.min(Math.max(body.timeoutMs, 0), WAIT_MS) : WAIT_MS
      const attachment = record.attachment
      const ready = () => record.closed || record.disconnected || record.attachment !== attachment
        || (record.announced && record.generation > since)
      const deadline = Date.now() + timeout
      // A generation bump before `session/new` answered wakes this poll too; it must park again,
      // not answer, or the bridge would announce before the agent can re-list (the spike's rule).
      while (!ready()) {
        const left = deadline - Date.now()
        if (left <= 0) break
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            record.waiters.delete(finish)
            resolve()
          }
          const timer = setTimeout(finish, left)
          timer.unref?.()
          record.waiters.add(finish)
        })
      }
      // A parked poll that times out while the list is still unannounceable answers with what
      // the bridge already knew, so the change is announced only after `session/new`.
      const answerable = record.closed || record.announced
      return reply(200, { generation: answerable ? record.generation : since, ...(record.closed ? { closed: true } : {}) })
    }
    return reply(400, { error: 'op' })
  }

  /** Park a call between steps without writing anything on the ended step. */
  waitForStep(record, turn, signals) {
    const session = record.agent.session
    return new Promise(resolve => {
      let timer
      let poll
      let off
      let done = false
      const finish = outcome => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(poll)
        off?.()
        for (const signal of signals) signal.removeEventListener('abort', abort)
        resolve(outcome)
      }
      const abort = () => finish('cancelled')
      const check = (events = []) => {
        // A batch may end this turn and open another before listeners run.
        if (events.some(event => event.type === 'turn/end' && event.data?.turn === turn)) return finish('ended')
        const open = openStepOf(session)
        if (open !== undefined) return finish(open.turn === turn ? 'ready' : 'ended')
        if (betweenStepTurn(session) !== turn) finish('ended')
      }
      timer = setTimeout(() => {
        // A step that opened without a notice to this waiter still counts.
        check()
        finish('timeout')
      }, this.stepWaitMs)
      timer.unref?.()
      off = record.guard?.subscribe?.(check)
      if (off === undefined) {
        poll = setInterval(check, 25)
        poll.unref?.()
      }
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
      if (signals.some(signal => signal.aborted)) abort()
      else check()
    })
  }

  /** Keep the mirror in its step until that step's approval calls have written their results. */
  async awaitApprovals(sessionId, position, signal) {
    try {
      if (position !== undefined) await this.waitForApprovalCalls(sessionId, position, signal)
    } catch {}
  }

  /** No deadline: an unanswered approval may keep its step open for as long as it needs. */
  waitForApprovalCalls(sessionId, { turn, step }, signal) {
    return new Promise(resolve => {
      let poll
      let done = false
      const subscriptions = new Map()
      const unsubscribe = record => {
        try { subscriptions.get(record)?.() } catch {}
        record.approvalWaiters.delete(check)
        record.abort.signal.removeEventListener('abort', check)
        subscriptions.delete(record)
      }
      const finish = () => {
        if (done) return
        done = true
        clearInterval(poll)
        for (const record of subscriptions.keys()) unsubscribe(record)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const check = () => {
        if (done) return
        try {
          const records = [...this.records.values()].filter(record =>
            record.sessionId === sessionId && !record.closed)
          for (const record of subscriptions.keys()) {
            if (!records.includes(record)) unsubscribe(record)
          }
          let pending = false
          for (const record of records) {
            if (!subscriptions.has(record)) {
              subscriptions.set(record, undefined)
              record.approvalWaiters.add(check)
              record.abort.signal.addEventListener('abort', check, { once: true })
              subscriptions.set(record, record.guard?.subscribe?.(() => check()))
            }
            const open = openStepOf(record.agent?.session)
            if (open?.turn !== turn || open?.step !== step) return finish()
            pending ||= record.promptRunning?.() === true && [...record.approvalCalls].some(call =>
              call.turn === turn && call.step === step && !call.stopped.aborted)
          }
          if (!pending || signal?.aborted) finish()
        } catch { finish() }
      }
      try {
        // The prompt can end or another record can be minted without a Session write.
        poll = setInterval(check, 25)
        poll.unref?.()
        signal?.addEventListener('abort', finish, { once: true })
        check()
      } catch { finish() }
    })
  }

  /**
   * Run one DSH tool call for the bridge: it must be offered, DSH must approve it, and only
   * then does it run. Rows land on the Session as DSH's own tool rows do, so the chat shows the
   * call and its result; the bridge's call is the single record for it.
   * @param {any} record
   * @param {{ name: string, arguments: any, callId?: string, signal?: AbortSignal, attachmentSignal?: AbortSignal, onSkillDelivered?: Function }} call
   */
  async call(record, { name, arguments: args, callId, signal: callerGone, attachmentSignal = record.attachmentAbort?.signal, onSkillDelivered }) {
    const error = (text) => ({ content: name === 'load_skill' ? [] : [{ type: 'text', text }], isError: true })
    if (record.skillOnly && name !== 'load_skill') return error('Unknown tool')
    const unavailable = (code, text) => ({ ...error(text), error: { name: 'AutoReviewUnavailableError', code } })
    const recordFailed = (text, code = 'BRIDGE_RECORD_FAILED') => ({ ...error(text), error: { name: 'BridgeRecordError', code } })
    // Stop and a closed caller end individual calls. Detachment and revocation take away
    // their authority, including calls still waiting for a step or an approval.
    const authority = attachmentSignal === undefined ? record.abort.signal : AbortSignal.any([record.abort.signal, attachmentSignal])
    const ended = () => record.closed || authority.aborted
    if (ended()) return { revoked: true }
    const skill = skillRequest(this.ctx, record, name, args?.name)
    const session = record.agent?.session
    const tools = this.ctx?.get?.('tools')
    if (session === undefined || tools?.execute === undefined) return error(`DSH tools are not available to ${record.name}.`)
    let waited
    const waitingTurn = betweenStepTurn(session)
    const hasStep = openStepOf(session) !== undefined
    const origin = hasStep ? undefined : outsideOriginOf(session)
    if (!hasStep && waitingTurn !== undefined && record.promptRunning?.() === true) {
      const waiting = new AbortController()
      record.controllers.add(waiting)
      try {
        waited = await this.waitForStep(record, waitingTurn, [authority, waiting.signal, callerGone].filter(Boolean))
        if (ended()) return { revoked: true }
        // Stop can arrive after the step wakes us but before this continuation runs.
        if (waiting.signal.aborted || callerGone?.aborted) {
          if (openStepOf(session)?.turn === waitingTurn || betweenStepTurn(session) === waitingTurn) {
            return { ...error(`${name} was stopped before it started.`), error: { name: 'BridgeCancelledError', code: 'BRIDGE_CANCELLED' } }
          }
          waited = 'ended'
        }
        if (waited === 'ready' && record.promptRunning?.() !== true) waited = 'ended'
      } finally {
        record.controllers.delete(waiting)
        if (record.closed && record.controllers.size === 0) record.guard?.release()
      }
    }
    const offered = offeredTools(this.ctx, record.agent, { native: record.native, skillOnly: record.skillOnly })
    if (!offered.some((tool) => tool.name === name)) return error(`Tool "${name}" is not offered to this Session.`)
    if (skill && !skill.available()) return skill.refuse()
    const raw = JSON.stringify(args ?? {})
    // A native background task or subagent finishing after its turn ends wakes Claude Code on its
    // own: there is no DSH step open and no DSH turn to wait for. Manual and Full run the extra
    // without a card (no loadable row exists outside a step); Auto refuses, because Auto review
    // reads a call from its step. A plain refusal here would be a silent dead end for the agent.
    if (openStepOf(session) === undefined && !betweenSteps(session) && record.promptRunning?.() !== true) {
      return await this.selfOpenedCall(record, { name, raw, callId, signal: callerGone, authority, ended, skill, onSkillDelivered, origin: origin ?? null })
    }
    const approval = this.ctx?.get?.('approval')
    const level = levelOf(approval, session, this.ctx?.get?.('sandboxPolicy'), this.ctx?.get?.('permissionPresets'))
    // Every level advertises the call (`advertise`, #842) with the same turn/step, id, name and
    // raw arguments the tool/call row carries; Auto review reads the same block. A call with no
    // open step cannot be recorded in a loadable shape: refuse it.
    let review
    if (waited !== undefined && (waited !== 'ready' || openStepOf(session)?.turn !== waitingTurn)) {
      return level.auto
        ? unavailable('AUTO_REVIEW_NO_STEP', 'Auto review cannot see this call: the Session has no open step.')
        : recordFailed('The bridge cannot record this call: the Session has no open step.', 'BRIDGE_NO_STEP')
    }
    if (level.auto) {
      review = reviewRouteOf(session, name)
      if (review.error !== undefined) return unavailable(review.error.code, review.error.text)
    }
    const position = review?.step ?? openStepOf(session)
    if (position === undefined) {
      return review === undefined
        ? recordFailed('The bridge cannot record this call: the Session has no open step.', 'BRIDGE_NO_STEP')
        : unavailable('AUTO_REVIEW_NO_STEP', 'Auto review cannot see this call: the Session has no open step.')
    }
    const id = bridgeCallId(callId)
    if (callId !== undefined && id !== callId) {
      let caller
      try { caller = JSON.stringify(callId) } catch { caller = thrownText(callId) }
      // The caller's id is the agent's text, of any size: the line keeps only its start.
      if (typeof caller === 'string' && caller.length > 160) caller = `${caller.slice(0, 160)}…`
      this.log(`bridge call id ${caller} replaced by ${id}`)
    }
    const { turn, step } = position
    const skills = skill && this.ctx?.get?.('omniTeam')?.skillCalls
    const skillPosition = skillActivityPosition(skills, session, position)
    const route = review === undefined
      ? routeOf(session)
      : { provider: review.provider, model: review.model }
    // From here the call has rows, and its step may end before it does (#957): the write guard
    // (#958) then closes it before the step/end row.
    // This call's own controller: `cancel` (Stop, the turn's end) and its caller going away
    // abort it; the authority signal also aborts it when the attachment or record ends.
    const own = new AbortController()
    const onGone = () => own.abort(callerGone.reason)
    if (callerGone?.aborted) onGone()
    else callerGone?.addEventListener('abort', onGone, { once: true })
    record.controllers.add(own)
    const stopped = AbortSignal.any([authority, own.signal])
    const cancelled = () => settle([{ type: 'text', text: `${name} was stopped before it finished.` }], true, { name: 'BridgeCancelledError', code: 'BRIDGE_CANCELLED' })
    const leave = () => {
      record.controllers.delete(own)
      callerGone?.removeEventListener('abort', onGone)
      if (record.closed && record.controllers.size === 0) record.guard?.release()
    }
    // The synthetic block is for the advertisement (and the review on Auto) only.
    let hideSynthetic
    let callSeq
    try {
      try {
        hideSynthetic = advertise(session, { turn, step }, route, { id, name, raw }, this.log)
      } catch (cause) {
        return review === undefined
          ? recordFailed(`The bridge could not advertise ${name}: ${cause?.message ?? cause}`)
          : unavailable('AUTO_REVIEW_FAILED', `Auto review could not see this call: ${cause?.message ?? cause}`)
      }
      try {
        callSeq = session.append('tool/call', { turn, step, callId: id, name, arguments: raw }).seq
      } catch (cause) {
        // A call without its row cannot be reviewed or shown: answer the advertisement (it stays
        // in the log), take it off the surface and refuse.
        closeNotStarted(session, { turn, step }, id, this.log)
        hideSynthetic()
        return review === undefined
          ? recordFailed(`The bridge could not record ${name}: ${cause?.message ?? cause}`)
          : unavailable('AUTO_REVIEW_FAILED', `Auto review could not record this call: ${cause?.message ?? cause}`)
      }
    } finally {
      if (callSeq === undefined) leave()
    }
    let controller
    const approvalCall = { turn, step, stopped }
    const releaseApproval = () => {
      if (!record.approvalCalls.delete(approvalCall)) return
      stopped.removeEventListener('abort', releaseApproval)
      controller?.signal.removeEventListener('abort', releaseApproval)
      for (const wake of record.approvalWaiters) wake()
    }
    if (!level.full) {
      record.approvalCalls.add(approvalCall)
      stopped.addEventListener('abort', releaseApproval, { once: true })
    }
    let answered = false
    const settle = async (resultContent, isError, rawInfo) => {
      const content = checkedSkillContent(this.ctx, record, name, args?.name, resultContent)
      const terminal = skill && content.length === 0 && (!isError || (rawInfo === undefined && !skill.available()))
        ? skill.refuse() : undefined
      if (terminal) isError = true
      // The row is plain JSON with string fields: a tool's own error object is not trusted to be.
      const info = infoOf(rawInfo)
      // A result is written only into its call's own step, while that step is open. Once the
      // step has ended the write guard has closed the call (superseded, or cancelled at a turn's
      // end), so its row is answered and nothing may carry the ended step's stamp. The agent
      // still gets the real answer below.
      // The write guard drops and reports such a row itself; a Session it could not guard is
      // checked here.
      const open = openStepOf(session)
      if (record.guard === undefined && (open === undefined || open.turn !== turn || open.step !== step)) {
        this.log(`the late result of ${name} (${id}) was not recorded: its step already ended`)
      } else {
        const write = (rowContent, rowError, rowInfo) => session.append('tool/result', {
          turn,
          step,
          message: createToolResultMessage({ callId: id, content: rowContent, isError: rowError }),
          ...(rowInfo === undefined ? {} : { error: rowInfo }),
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        try {
          const saved = write(content, isError, info)
          answered = true
          if (name === 'load_skill' && !isError && content.length > 0) {
            this.ctx?.get?.('omniTeam')?.skillCalls?.admit({
              sessionId: record.sessionId, messages: [saved.data.message],
            }, session, { activity: false })
          }
        } catch (cause) {
          // A result the log refuses must not leave the call open: record a minimal row that
          // is always valid. (The write guard already replaces data that is not plain JSON;
          // this covers a Session it does not guard and any other refusal.) What refused it
          // may be anything a tool's result can throw when read, so nothing here depends on it.
          try { this.log(`bridge result row failed: ${thrownText(cause)}`) } catch {}
          try {
            write(error(`The result of ${name} could not be recorded.`).content, true, { name: 'BridgeRecordError', code: 'BRIDGE_RESULT_UNRECORDABLE' })
            answered = true
          } catch (again) {
            // The write guard closes the call before its step ends.
            try { this.log(`bridge fallback result row failed: ${thrownText(again)}`) } catch {}
          }
        }
      }
      // The terminal sentence is an MCP result only. The durable row carries
      // an empty error, so a later replay never turns it into an instruction.
      if (skills && !isError && content.length > 0) {
        onSkillDelivered?.(replay => skills.bridgeActivity?.(session, skillPosition, id, content[0], replay))
      }
      return terminal ?? {
        content: name === 'load_skill' ? content.map(({ text }) => ({ type: 'text', text }))
          : await contentOf(content, this.ctx?.get?.('attachments')),
        isError,
        ...(info === undefined ? {} : { error: info }),
      }
    }
    const revoked = async () => {
      await settle([{ type: 'text', text: `The bridge was revoked before ${name} ran.` }], true, { name: 'BridgeRevokedError', code: 'BRIDGE_REVOKED' })
      return { revoked: true }
    }
    let unwatch
    let unwatchPre
    let timer
    let timedOut = false
    let levelChanged = false
    try {
      if (skill && !skill.available()) return await settle([], false)
      // Manual and every other asking level raise the one DSH dialog here. Auto does not: the
      // pipeline's pre-execute is auto-review's gate, and its ask (if any) is the one dialog.
      if (!level.full && !level.auto) {
        let outcome = 'unavailable'
        let policy
        try { policy = approval?.effectivePolicy?.(session) } catch {}
        const request = {
            agent: record.agent,
            toolName: name,
            callId: id,
            reason: `${record.name}: ${name}`,
            displayReason: { en: `${record.name} wants to run ${name}` },
            signal: stopped,
            bridgeCall: { agentAsked: record.agentAsked === true },
        }
        try {
          outcome = await approval.request(request)
        } catch (cause) {
          outcome = 'unavailable'
          this.log(`approval for ${name} failed: ${cause?.message ?? cause}`)
        }
        if (outcome !== 'allowed-once') {
          // If the call lost its authority during the ask, close its row as revoked even
          // when the dialog returned a different outcome.
          if (ended()) return await revoked()
          // Stop (or a caller that went away) withdrew the dialog: nobody refused the call.
          if (own.signal.aborted) return await cancelled()
          const text = (outcome === 'rejected' ? refusedText(request) : undefined)
            ?? (outcome === 'rejected' && typeof request.bridgeCall.judged?.reason === 'string'
              ? `Auto's judge refused ${name}: ${request.bridgeCall.judged.reason}.`.replace(/\s+/g, ' ').slice(0, 300)
              : bridgeRefusalText(name, outcome, policy))
          return await settle([{ type: 'text', text }], true, { name: 'ApprovalDeniedError', code: String(outcome).toUpperCase() })
        }
      }
      // A late grant can arrive after the bridge lost its authority. Check again before
      // dispatch, since a tool body may ignore the abort signal.
      if (ended()) return await revoked()
      // Stopped while it waited for its approval: nothing may start now.
      if (own.signal.aborted) return await cancelled()
      if (skill && !skill.available()) return await settle([], false)
      if (level.auto) {
        // A level that stopped being Auto before dispatch would let this call run unreviewed.
        // The subscription below also watches while the review is pending; this re-check covers
        // a host that composes no session/event listeners.
        let now
        try {
          now = levelOf(approval, session, this.ctx?.get?.('sandboxPolicy'), this.ctx?.get?.('permissionPresets'))
        } catch {
          now = { auto: false }
        }
        if (now.auto !== true) levelChanged = true
      }
      // The timeout and the level watcher cover the review and approval phase, not the body.
      // The pipeline reaches its tools/execute waterfall only after the pre-execute gate and any
      // approval ask have settled; disarming there, immediately around the body, keeps a long
      // allowed body out of the deadline and covers a level change while the ask is pending.
      if (!levelChanged && level.auto && typeof this.ctx?.on === 'function') {
        controller = new AbortController()
        controller.signal.addEventListener('abort', releaseApproval, { once: true })
        timer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error('Auto review timed out'))
        }, this.reviewTimeoutMs)
        timer.unref?.()
        unwatch = this.ctx.on('session/event', (eventSession, event) => {
          if (eventSession !== session || !LEVEL_EVENTS.has(event?.type)) return
          let now
          try {
            now = levelOf(approval, session, this.ctx?.get?.('sandboxPolicy'), this.ctx?.get?.('permissionPresets'))
          } catch {
            now = { auto: false }
          }
          if (now.auto !== true) {
            levelChanged = true
            controller.abort(new Error('the level changed during Auto review'))
          }
        })
        unwatchPre = this.ctx.on('tools/execute', (exec, next) => {
          if (exec?.callId !== id || exec.parent !== undefined || exec.agent !== record.agent) return next()
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          unwatch?.()
          unwatch = undefined
          return next()
        })
      }
      if (levelChanged) {
        return await settle([{ type: 'text', text: `Auto review cannot finish ${name}: the permission level changed.` }], true, { name: 'AutoReviewUnavailableError', code: 'AUTO_REVIEW_LEVEL_CHANGED' })
      }
      const signal = controller === undefined ? stopped : AbortSignal.any([stopped, controller.signal])
      let settled
      try {
        settled = await tools.execute({
          calls: [{ id, name, arguments: raw }],
          agent: record.agent,
          signal,
        })
      } catch (cause) {
        if (ended()) return await revoked()
        if (timedOut) {
          return await settle([{ type: 'text', text: `Auto review timed out before ${name} ran.` }], true, { name: 'AutoReviewTimeoutError', code: 'AUTO_REVIEW_TIMEOUT' })
        }
        if (levelChanged) {
          return await settle([{ type: 'text', text: `Auto review cannot finish ${name}: the permission level changed.` }], true, { name: 'AutoReviewUnavailableError', code: 'AUTO_REVIEW_LEVEL_CHANGED' })
        }
        if (own.signal.aborted) return await cancelled()
        const text = `Error: ${thrownText(cause)}`
        // The info lands in the tool/result row, which must be plain JSON: an Error with no
        // string code (or a non-string name) would leave an undefined field, the row would be
        // refused, and the call would stay unresolved in the session log. (A value whose own
        // fields throw when read is settled by the catch at the end of this call.)
        const info = { name: typeof cause?.name === 'string' ? cause.name : 'Error' }
        if (typeof cause?.code === 'string') info.code = cause.code
        return await settle([{ type: 'text', text }], true, info)
      }
      // A revocation, a timeout or a level change during the review wins over its result: the
      // body must not be reported as executed under a level or credential that no longer holds.
      if (ended()) return await revoked()
      if (timedOut) {
        return await settle([{ type: 'text', text: `Auto review timed out before ${name} ran.` }], true, { name: 'AutoReviewTimeoutError', code: 'AUTO_REVIEW_TIMEOUT' })
      }
      if (levelChanged) {
        return await settle([{ type: 'text', text: `Auto review cannot finish ${name}: the permission level changed.` }], true, { name: 'AutoReviewUnavailableError', code: 'AUTO_REVIEW_LEVEL_CHANGED' })
      }
      // Stopped while the body ran: a body that ignored its signal is not reported as a result.
      if (own.signal.aborted) return await cancelled()
      const result = settled?.results?.[0]?.result
      if (result === undefined) return await settle([{ type: 'text', text: 'The tool returned no result.' }], true)
      const info = result.isError === true ? (result.error?.info ?? (typeof result.error?.code === 'string' ? result.error : undefined)) : undefined
      return await settle(result.content ?? [], result.isError === true, info)
    } catch (cause) {
      // Nothing above is meant to throw; if it does, the call still gets its one result row.
      // This is the call's last chance of a result: nothing here may throw on what was thrown.
      const text = `Error: ${thrownText(cause)}`
      try { this.log(`bridge call ${name} failed: ${thrownText(cause)}`) } catch {}
      if (answered) return error(text)
      if (ended()) return await revoked()
      return await settle([{ type: 'text', text }], true, { name: 'BridgeCallError', code: 'BRIDGE_CALL_FAILED' })
    } finally {
      clearTimeout(timer)
      unwatch?.()
      unwatchPre?.()
      // After its step ended this writes nothing: the write guard hid the block there.
      hideSynthetic()
      releaseApproval()
      leave()
    }
  }

  /**
   * A bridge call in a turn the agent opened itself (a native background task finished after its
   * DSH turn ended): no step exists and none can be opened out of band, because the agent loop's
   * own turn numbering is private. Manual and Full run it without DSH rows and record a plugin
   * record instead; Auto refuses, because Auto review reads the pending call from its step.
   * @param {any} record
   * @param {{ name: string, raw: string, callId?: string, signal?: AbortSignal, authority: AbortSignal, ended: () => boolean, skill?: any, onSkillDelivered?: Function, origin?: {turn: number, exchangeId: string | null} | null }} call
   */
  async selfOpenedCall(record, { name, raw, callId, signal: callerGone, authority, ended, skill, onSkillDelivered, origin = outsideOriginOf(record.agent?.session) }) {
    const error = text => ({ content: name === 'load_skill' ? [] : [{ type: 'text', text }], isError: true })
    const unavailable = (code, text) => ({ ...error(text), error: { name: 'AutoReviewUnavailableError', code } })
    const session = record.agent?.session
    const tools = this.ctx?.get?.('tools')
    const approval = this.ctx?.get?.('approval')
    const id = bridgeCallId(callId)
    const skills = skill && this.ctx?.get?.('omniTeam')?.skillCalls
    const note = (outcome) => {
      const position = outcome === 'ran' ? origin : undefined
      try { return appendPluginRecord(session, 'plugin:acp-dsh/bridge-outside-step', { callId: id, name, outcome, ...position }) } catch {}
    }
    const level = levelOf(approval, session, this.ctx?.get?.('sandboxPolicy'), this.ctx?.get?.('permissionPresets'))
    if (level.auto) {
      note('refused')
      return unavailable('BRIDGE_OUTSIDE_STEP', `DSH did not run ${name}: Claude Code opened this turn itself (a background task finished), and DSH Auto review cannot see a call outside a DSH step. Ask the person to send a message in the chat; the next turn has a DSH step, and the call works there.`)
    }
    if (session === undefined || tools?.execute === undefined) return error(`DSH tools are not available to ${record.name}.`)
    if (callId !== undefined && id !== callId) this.log(`bridge call id ${JSON.stringify(callId).slice(0, 160)} replaced by ${id} in an agent-opened turn`)
    const own = new AbortController()
    const onGone = () => own.abort(callerGone.reason)
    if (callerGone?.aborted) onGone()
    else callerGone?.addEventListener('abort', onGone, { once: true })
    record.controllers.add(own)
    const stopped = AbortSignal.any([authority, own.signal])
    const cancelled = () => ({ ...error(`${name} was stopped before it finished.`), error: { name: 'BridgeCancelledError', code: 'BRIDGE_CANCELLED' } })
    const leave = () => {
      record.controllers.delete(own)
      callerGone?.removeEventListener('abort', onGone)
      if (record.closed && record.controllers.size === 0) record.guard?.release()
    }
    try {
      if (ended()) return { revoked: true }
      if (!level.full) {
        let outcome = 'unavailable'
        let policy
        try { policy = approval?.effectivePolicy?.(session) } catch {}
        const request = {
          agent: record.agent,
          toolName: name,
          callId: id,
          reason: `${record.name}: ${name}`,
          displayReason: { en: `${record.name} wants to run ${name}` },
          signal: stopped,
          bridgeCall: { agentAsked: record.agentAsked === true },
        }
        try { outcome = await approval.request(request) } catch {
          outcome = 'unavailable'
          this.log(`approval for ${name} failed in an agent-opened turn`)
        }
        if (outcome !== 'allowed-once') {
          if (ended()) return { revoked: true }
          if (own.signal.aborted) return cancelled()
          note('refused')
          return error((outcome === 'rejected' ? refusedText(request) : undefined) ?? bridgeRefusalText(name, outcome, policy))
        }
      }
      if (ended()) return { revoked: true }
      if (own.signal.aborted) return cancelled()
      if (skill && !skill.available()) return skill.refuse()
      const settled = await tools.execute({ calls: [{ id, name, arguments: raw }], agent: record.agent, signal: stopped })
      if (ended()) return { revoked: true }
      if (own.signal.aborted) return cancelled()
      const result = settled?.results?.[0]?.result
      if (result === undefined) {
        note('failed')
        return error('The tool returned no result.')
      }
      const info = result.isError === true ? (result.error?.info ?? (typeof result.error?.code === 'string' ? result.error : undefined)) : undefined
      const content = checkedSkillContent(this.ctx, record, name, name === 'load_skill' ? JSON.parse(raw)?.name : undefined, result.content ?? [])
      if (skill && content.length === 0 && (result.isError !== true || !skill.available())) {
        note('refused')
        return skill.refuse()
      }
      const eventSeq = note(result.isError === true ? 'failed' : 'ran')
      if (skills && eventSeq !== undefined && result.isError !== true && content.length > 0) {
        onSkillDelivered?.(replay => skills.bridgeActivity?.(session, { eventSeq }, id, content[0], replay))
      }
      return {
        content: name === 'load_skill' ? content.map(({ text }) => ({ type: 'text', text }))
          : await contentOf(content, this.ctx?.get?.('attachments')),
        isError: result.isError === true,
        ...(info === undefined ? {} : { error: info }),
      }
    } catch (cause) {
      if (ended()) return { revoked: true }
      note('failed')
      return error(`Error: ${thrownText(cause)}`)
    } finally {
      leave()
    }
  }

  dispose() {
    this.closed = true
    try { this.offTurnEnd?.() } catch {}
    // A Map iterator tolerates the deletes `revoke` makes; a copy here would be noise.
    for (const record of this.records.values()) this.revoke(record)
    try {
      this.server?.close()
    } catch {}
    this.server = undefined
  }
}
