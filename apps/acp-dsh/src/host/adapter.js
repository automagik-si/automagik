// ACP agents as DSH models. Each agent is a provider route whose models and reasoning efforts
// are the agent's own (catalog.js); the chosen ones are set on its session before each prompt,
// with the permission mode. A DSH turn on it is
// one ACP prompt to that Session's agent process: its words stream as text, its thoughts as
// reasoning, and each of its tool calls ends the model step with a call to the mirror tool
// (tool.js), so DSH shows the card and asks for approval. The next step drains what the agent
// said since. DSH keeps the Session, its history and the sidebar.
import { CLAUDE_PINS, pinOf, pinWire } from './model-identity.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  LlmAdapter, boundContextSummary, createUserMessage, fileHandleText,
  isAgentLoopRequest, offloadedImageText,
} from '@deepseek-ai/dsh-llm'
import { AgentRun, isStopped, isUnanswered, valuesOf, waited } from './acp.js'
import { AGY_NOT_LOADED_TEXT, AGY_TOOLS_OFF_TEXT } from './agy-off.js'
import { ACP_USAGE_LIMIT_CODES } from './usage-limit.js'
import { advertise, openStepOf, recordDrift, routeOf } from './backchannel.js'
import { DEFAULT_MODEL } from './catalog.js'
import { SessionFiles, restrictedLevel } from './session-files.js'
import { chatProfileModes } from './codex-chat-profiles.js'
import { CATALOG_MAX_AGE_MS, ensureCatalog, keptModel, modelPart, NATIVE_OFF_UNAVAILABLE, NATIVE_OFF_UNVERIFIABLE } from './codex-native.js'
import { IDENTITY_PROVIDERS, identityText, readIdentity, rolePromptOf } from './identity.js'
import { AGENT_INTERRUPTED, BRIDGE_NAME, CREDENTIAL_ENV, isAuthRequired, MODEL_ACCESS_REQUIRED, SYNTHETIC_KIND, URL_ENV } from './names.js'
import { shownText } from './shown-text.js'
import {
  agentRoute, answered, boundaryNotice, isHandoff, lastProviderOf, missedBy, NOTICE_KIND, renderMessage,
  replayBlocks, turnStart, unreadHandoff,
} from './switch.js'
import { ImageLinks, savedPathsOf } from './agent-image.js'
import { callArguments, entered, levelOf, mirrorTool, reviewed, TOOL_NAME } from './tool.js'
import { guardSession } from './write-guard.js'
import { checkUploadSize, prepareUpload } from './upload-content.js'

// How long a prompt has to end after it was asked to stop. `session/cancel` is a notification:
// nothing says the agent took it, and one that ignores it would stay busy for good.
export const CANCEL_WAIT_MS = 5000
// A bridge that never listed its tools fails the turn: codex-acp skips a server whose name the
// person's own Codex config defines, and a Session must not run with half a tool set.
const SKILL_BRIDGE_PROVIDERS = new Set(['acp-claude', 'acp-codex', 'acp-antigravity', 'acp-omp'])
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
const NATIVE_TOOLS_CHANGED_TEXT = 'The tools setting changed; send again.'
// Codex with its own tools off (codex-native.js). Off is not Read only: DSH's tools keep the
// Session's level.
// The Details switch applies in every Session of a Bot it is not blocked for (#1564): there these
// texts point to it. Elsewhere (a blocked Bot or Session, a Session with no Bot) they name what
// helps there.
const noBridgeText = switchHere => "Codex's own tools are off for this Bot and Automagik's tools"
  + ' are turned off in this app, so Codex was not started. ' + (switchHere
  ? "Turn native tools on in the Bot's Details, or turn Automagik's tools back on."
  : "Turn Automagik's tools back on, or switch its model.")
const offUnavailableText = (reason, switchHere) => 'Codex could not turn its own tools off'
  + ` (${reason}), so the message was not sent. ` + (switchHere
  ? "Turn native tools on in the Bot's Details, or update Automagik."
  : 'Switch its model, or update Automagik.')
const NATIVE_CALL_TEXT = 'Codex used one of its own tools while they are off, so this answer stopped. Send your message again.'

// The exact disposer of the mirror-tool registration a Session agent carries. It lives on the
// agent, never in this module: a plugin reload replaces the module and the adapter while the
// agent and its scoped tools live on, so the next adapter must find and replace the registration
// the previous one made. A Symbol.for key is the same key in the reloaded module.
const MIRROR_REGISTRATION = Symbol.for('@automagik/acp-dsh/mirror-registration')

const bridgeRow = message => (
  (message?.role === 'assistant' && message?.source?.synthetic === SYNTHETIC_KIND)
  || (message?.role === 'developer' && message?.source?.kind === SYNTHETIC_KIND)
)

const permitsNative = level => level?.sandbox === 'workspace-write' || level?.sandbox === 'danger-full-access'
const OMP_TOOLS_OFF_TEXT = 'omp tried to use a tool while native tools are off, so this answer stopped.'
// The agents whose switch is their launch args (agents.js `nativeSwitch: 'args'`): OFF is a
// child with no tools of its own and no bridge, ended at the first tool call it reports.
const ARGS_SWITCH = new Set(['acp-omp', 'acp-antigravity'])
const toolsOffText = provider => (provider === 'acp-antigravity' ? AGY_TOOLS_OFF_TEXT : OMP_TOOLS_OFF_TEXT)

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
const STOP_LINE = Object.freeze({
  refusal: name => `[${name} declined to go on with this request. Ask again in a new message.]`,
  max_turn_requests: name => `[${name} stopped at its limit of requests for one turn. Reply to let it go on.]`,
})
export const STAND_IN_LINE = (name, model) => `[${name} does not offer ${model} now, so this reply used its own model. Choose a model again for this Bot.]`
// An agent whose CLI is not signed in says so with ACP's `auth_required`, at the start of its
// session or of a prompt. The turn fails with its own code, never ACP_AGENT: a sign-in answers
// it, another model does not (the Bot team never falls back on it).
// An agent with no sign-in in the app (`signInHint`, agents.js) names its own terminal command;
// one that signs in only in the app's Settings (`signInWhere`, an agent with its own home) says so.
const signInFailure = (agent, error) => finish('error', agent.signInWhere === 'settings'
  ? `${agent.name} is not signed in. Sign in to it in Settings, under Coding agents, then send again.`
  : typeof agent.signInHint === 'string' && agent.signInHint !== ''
    ? `${agent.name} is not signed in. Run \`${agent.signInHint}\` in a terminal, then send again.`
    : `${agent.name} is not signed in: ${error?.message ?? error}`, MODEL_ACCESS_REQUIRED)
const STOPPED = () => finish('aborted', 'Stopped', 'ABORTED')
// Thrown out of a Codex start to run the turn again as a kept one from the start's catch, never
// inside its `try`: an error of that turn is never a connector failure (no rollback, no repair).
const KEPT_RELAUNCH = Symbol('acp-dsh kept relaunch')
const ARCHIVED = Symbol('archived Session')
const START_CHANGED = Symbol('ACP start changed')

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

// The source kind of the row that says a new agent session does not see the chat before it
// (switch.js, which reads it too).
export { NOTICE_KIND }

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
function promptRows(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === 'user') start--
  // A failed request may leave no assistant row. Retry starts a new continuation even
  // then: never resend the earlier instruction to an ACP session that already accepted it.
  const retry = messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'retry')
  const turn = messages.slice(Math.max(start, retry)).filter(message => message.source?.kind !== NOTICE_KIND && message.source?.kind !== 'automagik-skill-notice')
  const own = turn.filter(message => message.source?.kind === 'user' || message.source?.kind === 'retry' || isHandoff(message))
  // Offload is a durable DSH decision, not permission to recover an omitted image. Use
  // DSH's existing no-path placeholder for a genuine user's marked occurrence.
  const rows = (own.length > 0 ? own : turn).map(row => row.source?.kind === 'user' && !isHandoff(row) && Array.isArray(row.content)
    ? { ...row, content: row.content.map(block => block?.type === 'image' && block.offloaded === true
      ? { type: 'text', text: offloadedImageText(block.attachment) } : block) } : row)
  return { own, rows }
}

export function promptOf(messages, redact = text => text) {
  const { own, rows } = promptRows(messages)
  const text = rows
    .map(message => (isHandoff(message) ? redact(textOf(message.content)) : textOf(message.content)))
    .filter(Boolean).join('\n\n')
  return [{ type: 'text', text: text || (own.some(message => message.source?.kind === 'retry') ? 'Continue.' : '') }]
}

// Recovery sends a marked user note. The preceding cut turn may have accepted its
// brief without ever reaching the CLI, so recover its durable user rows on a fresh run.
function cutUserRows(messages, session) {
  if (!promptRows(messages).own.some(row => row.source?.kind === 'user' && row.source.resumed === true)) return []
  const rows = []
  let cut
  for (let seq = (session?.seq ?? 0) - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt?.(seq)
    if (event === undefined) break
    if (cut === undefined) {
      if (event.type !== 'turn/end') continue
      const reason = event.data?.reason
      if (reason?.kind !== 'interrupted' && !(reason?.kind === 'aborted' && reason.reason?.kind === 'disposed')) return []
      cut = event.data?.turn
    } else if (event.type === 'turn/start' && event.data?.turn === cut) {
      return rows.reverse()
    } else if (event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.source.resumed !== true) {
      rows.push(event.data)
    }
  }
  return []
}

// A group relay carries pointers only. Both Sessions and the current membership must
// agree before the person's durable row can supply a reference for a workspace copy.
function ownsRoomUploads(ctx, session, roomId) {
  try {
    const team = ctx?.get?.('omniTeam')
    const owner = team?.groupOwners?.get(session?.id)
    if (!session?.id || owner?.roomId !== roomId || !owner.botId) return false
    const room = team.roomOf(roomId)
    return Array.isArray(room?.members) && room.members.includes(owner.botId) &&
      room.sessions?.[owner.botId] === session.id
  } catch { return false }
}

function roomUploads(row, saved, session, ctx) {
  const fresh = message => message?.source?.kind === 'bot' &&
    message.source.role === 'room' && !isHandoff(message) &&
    !message.source.resumed && !message.source.retried && !message.source.resume
  const uploads = row.source?.uploads
  if (!fresh(row) || !fresh(saved) || uploads?.v !== 1 ||
      typeof uploads.roomId !== 'string' || !Array.isArray(uploads.items) ||
      !isDeepStrictEqual(saved.source.uploads, uploads)) return []
  const groups = []
  try {
    if (!ownsRoomUploads(ctx, session, uploads.roomId)) return []
    const team = ctx.get('omniTeam')
    const room = team.roomOf(uploads.roomId)
    // room.id stays fixed while room.sessionId follows the current part.
    const current = typeof team.sessionOfRoom === 'function' ? team.sessionOfRoom(room) : (room.sessionId ?? room.id)
    const parts = Array.isArray(room.parts) ? room.parts.map(part => part?.sessionId).reverse() : []
    const ids = new Set([current, ...parts, room.id].filter(id => typeof id === 'string'))
    for (const id of ids) {
      const group = ctx.agents?.get(id)?.session?.deriveMessages?.()
      if (Array.isArray(group)) groups.push(group)
    }
  } catch { return [] }
  return uploads.items.flatMap(item => {
    if (!item || typeof item.messageId !== 'string' ||
        typeof item.attachmentId !== 'string' ||
        !Number.isInteger(item.blockIndex) || item.blockIndex < 0 ||
        !['file', 'image'].includes(item.kind)) return []
    let person
    for (const group of groups) {
      person = group.find(message => message.id === item.messageId)
      if (person) break
    }
    if (person?.source?.kind !== 'user' || person.source.handoff ||
        !Array.isArray(person.content) || item.blockIndex >= person.content.length) return []
    const block = person.content[item.blockIndex]
    return block?.type === item.kind &&
      block.attachment?.attachmentId === item.attachmentId && !block.offloaded
      ? [{ type: block.type, attachment: block.attachment, copyOnly: true }] : []
  })
}

function isFileHandle(text, ref) {
  if (text === fileHandleText(ref, undefined)) return true
  if (typeof text !== 'string') return false
  const template = fileHandleText(ref, '')
  // DSH's quoted() uses JSON.stringify for names and paths.
  const empty = JSON.stringify('')
  const marker = ': verbatim read-only copy saved at '
  const at = template.lastIndexOf(marker + empty)
  if (at < 0) return false
  const head = template.slice(0, at + marker.length)
  const tail = template.slice(at + marker.length + empty.length)
  if (!text.startsWith(head) || !text.endsWith(tail)) return false
  const middle = text.slice(head.length, text.length - tail.length)
  try {
    const path = JSON.parse(middle)
    return typeof path === 'string' && JSON.stringify(path) === middle
  } catch { return false }
}

// Legacy fallback rows still supply text, never fresh image authority. Retry and handoff
// rows likewise cannot replay an earlier accepted image. Undefined keeps the text path exact.
function uploadBlocks(messages, redact, session, ctx) {
  const selected = promptRows(messages).rows
  const durable = session?.deriveMessages?.() ?? []
  const files = new Set()
  const relays = new Set()
  const rows = selected.map(row => {
    const saved = row.id ? durable.find(message => message.id === row.id) : undefined
    const verified = roomUploads(row, saved, session, ctx)
    if (verified.length > 0) {
      const content = Array.isArray(row.content)
        ? row.content.filter(block => block?.type === 'text') : []
      if (!Array.isArray(row.content)) content.push({ type: 'text', text: textOf(row.content) })
      const consumed = new Set()
      for (const block of verified) {
        const index = Array.isArray(saved.content) && Array.isArray(row.content) &&
          saved.content.length === row.content.length
          ? saved.content.findIndex((part, index) => {
            if (consumed.has(index) || part?.type !== 'file' || block.type !== 'file' ||
                part.attachment?.attachmentId !== block.attachment.attachmentId ||
                part.attachment?.name !== block.attachment.name ||
                row.content[index]?.type !== 'text') return false
            return isFileHandle(row.content[index].text, part.attachment)
          }) : -1
        const projected = index < 0 ? undefined : row.content[index]
        const at = projected === undefined ? -1 : content.indexOf(projected)
        if (at < 0) content.push(block)
        else {
          content.splice(at, 1, block)
          consumed.add(index)
        }
        files.add(block)
      }
      const relay = { ...row, content }
      relays.add(relay)
      return relay
    }
    if (row.source?.kind !== 'user' || isHandoff(row) || !row.id ||
        !Array.isArray(row.content)) return row
    if (!saved || saved.source?.kind !== 'user' || isHandoff(saved) ||
        !Array.isArray(saved.content) || saved.content.length !== row.content.length) return row
    if (saved.content.some((block, index) =>
      block?.type === 'file' && row.content[index]?.type !== 'text')) return row
    return { ...row, content: row.content.map((block, index) => {
      if (saved.content[index]?.type !== 'file') return block
      const file = saved.content[index]
      files.add(file)
      return file
    }) }
  })
  const genuine = row => relays.has(row) ||
    (row.source?.kind === 'user' && !isHandoff(row))
  const upload = block => block?.type === 'image' || files.has(block)
  if (!rows.some(row => genuine(row) && Array.isArray(row.content) &&
      row.content.some(upload))) return undefined
  const blocks = []
  for (const row of rows) {
    const parts = genuine(row) && Array.isArray(row.content)
      ? row.content.filter(block => upload(block) || block?.type === 'text')
      : [{ type: 'text', text: isHandoff(row) ? redact(textOf(row.content)) : textOf(row.content) }]
    if (!parts.some(block => upload(block) || block.text)) continue
    if (blocks.length) blocks.push({ type: 'text', text: '\n\n' })
    for (let i = 0; i < parts.length; i++) {
      if (i > 0 && parts[i - 1].type === 'text' && parts[i].type === 'text') blocks.push({ type: 'text', text: '\n' })
      blocks.push({ ...parts[i] })
    }
  }
  return { blocks, roomIds: [...relays].map(row => row.source.uploads.roomId) }
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
 * has one (Claude Code's, which hands effort back to its settings), else `ownEffort(id)`, the one
 * the agent showed for that model when it was read, asked only then; when it is not known, no
 * effort is set.
 * @param {AgentRun} run
 * @param {string} model
 * @param {string | undefined} effort
 * @param {(id: string) => string | undefined} [ownEffort]
 * @param {{ signal?: AbortSignal, standIns?: string[], pin?: string, wire?: string, bindModel?: boolean }} [options]
 */
export async function choose(run, model, effort, ownEffort, { signal, standIns = [], pin, wire, bindModel = false } = {}) {
  const option = run.option('model')
  const offered = valuesOf(option).map(choice => choice.value)
  const ownModel = offered.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : run.startModel
  // A stand-in that has disappeared can use the agent's own model if it is still offered.
  const substituted = model !== DEFAULT_MODEL && standIns.includes(model) && !offered.includes(model)
    && (option === undefined || offered.includes(ownModel))
  const target = wire ?? (substituted || model === DEFAULT_MODEL ? ownModel : model)
  if (option === undefined) {
    if (!substituted && model !== DEFAULT_MODEL) throw new Error(`it offers no choice of model, so not ${model}`)
  } else if (target !== undefined) {
    await run.setOption('model', target, { signal, ...(pin ? { requireReported: true } : {}) })
  }
  if (bindModel && !substituted && model !== DEFAULT_MODEL) run.bindModel(model, target, pin)
  if (!substituted && effort !== undefined) {
    await run.setOption('thought_level', effort, { signal })
  } else {
    const levelOption = run.option('thought_level')
    const levels = valuesOf(levelOption).map(choice => choice.value)
    if (levels.includes(DEFAULT_MODEL)) await run.setOption('thought_level', DEFAULT_MODEL, { signal })
    else if (levelOption !== undefined) {
      const own = ownEffort?.(wire ?? (substituted ? target ?? DEFAULT_MODEL : model))
      if (levels.includes(own)) await run.setOption('thought_level', own, { signal })
    }
  }
  if (substituted) return { model }
}

const EFFORT_LADDER = new Map(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((id, rank) => [id, rank]))
const effortRank = id => EFFORT_LADDER.get(id) ?? EFFORT_LADDER.size

function withOfferedEfforts(entry, models) {
  const efforts = new Map()
  for (const model of [entry, ...models]) {
    for (const effort of model.reasoning?.efforts ?? []) {
      if (!efforts.has(effort.id)) efforts.set(effort.id, effort)
    }
  }
  if (efforts.size === 0 && !entry.reasoning) return entry
  return { ...entry, reasoning: { efforts: [...efforts.values()].sort((a, b) => effortRank(a.id) - effortRank(b.id)) } }
}

export class AcpAdapter extends LlmAdapter {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {Map<string, { name: string, catalog: import('./catalog.js').Catalog, installed?(): boolean, spawn(): { command: string, args?: string[], env?: Record<string, string> } }>} agents
   *   An agent's own `startMs` and `requestMs` replace acp.js's deadlines; `cancelWaitMs`
   *   replaces CANCEL_WAIT_MS; `timers` is the clock all three run on. Tests set them, so none
   *   waits a real deadline out.
   */
  constructor(ctx, agents, {
    dshTools = () => false, nativeTools = () => undefined, backchannel, redactor, onSignedOut, images = () => undefined,
    botIdentity = () => undefined, solverIdentity = () => undefined, teamManaged = () => false, access, currentAccess, holds, ownMode = () => undefined, hostStopping = () => false,
    ownModeWaitMs = OWN_MODE_WAIT_MS, holdWaitMs = HOLD_WAIT_MS, cancelWaitMs = CANCEL_WAIT_MS,
    fileDrainMs = 6000, timers = globalThis,
  } = {}) {
    super()
    this.cancelWaitMs = cancelWaitMs
    this.timers = timers
    // Whether the host itself is stopping (index.js watches its SIGTERM/SIGINT): a prompt the
    // agent then cancels was cut by the restart, not stopped by the person or by its own policy.
    this.hostStopping = hostStopping
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
    // Codex agent row -> the model its last process with its own tools started on: what DSH's
    // `default` is for that agent when a turn decides whether its model is kept (nativeKept).
    this.startModels = new Map()
    // Codex agent row -> the models its last check measured with no tool block, when its catalog
    // cannot keep them (measuredKept): read like `nativeKeptModels` for a day (B1-4).
    this.measured = new Map()
    // Asked before a turn opens on an agent (#869): a text when its signed-in account has not
    // been confirmed for the app, else undefined. Never asked for a call that continues a turn.
    this.access = access
    // Synchronous decision at startup boundaries, using the account state already read.
    this.currentAccess = currentAccess
    // Told which agent answered ACP's auth_required, so a cached "signed in" is dropped at once.
    this.onSignedOut = onSignedOut
    this.ctx = ctx
    this.agents = agents
    this.dshTools = dshTools
    // The raw `nativeTools` setting (index.js): absent, a boolean, or Bot names/Session ids to
    // booleans. Read at each turn's start by `nativeOn`.
    this.nativeTools = nativeTools
    this.botIdentity = botIdentity
    this.solverIdentity = solverIdentity
    this.teamManaged = teamManaged
    this.backchannel = backchannel
    this.redact = redactor ?? (text => text)
    this.live = new Map()
    this.roleTurns = new Map()
    this.sessionFiles = new SessionFiles({
      agent: id => this.ctx.agents?.get?.(id), live: id => this.live.get(id),
      level: session => levelOf(ctx.get?.('approval'), session, ctx.get?.('sandboxPolicy'), ctx.get?.('permissionPresets')),
      questions: () => ctx.get?.('userQuestions'), drainMs: fileDrainMs,
      retire: (id, live) => this.end(id, live, { preserveFiles: true }),
      revoke: owner => {
        if (this.live.get(owner.session.id)?.fileOwner === owner) this.endSession(owner.session.id, 'Image session permission expired.')
      },
    })
    this.tool = mirrorTool({
      sessionFiles: (...args) => this.sessionFiles.ask(...args),
      runOf: sessionId => this.live.get(sessionId),
      cancelled: (sessionId, live) => this.reap(sessionId, live),
      bridgeApprovals: (sessionId, position, signal) =>
        this.backchannel?.awaitApprovals?.(sessionId, position, signal),
      runNested: (...args) => this.runNested(...args),
      approval: () => ctx.get?.('approval'),
      sandboxPolicy: () => ctx.get?.('sandboxPolicy'),
      permissionPresets: () => ctx.get?.('permissionPresets'),
      images,
      attachments: () => ctx.get?.('attachments'),
    })
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
      if (agent === undefined) return
      const id = agent?.session?.id
      const live = this.live.get(id)
      const starting = this.starting.get(id)
      if (starting?.dshAgent === agent) {
        starting.agentDisposed = true
        this.invalidateStart(id, starting)
      }
      if (this.live.get(id) === live && live?.dshAgent === agent && (live.own || live.fileOwner)) {
        this.end(id, live, { preserveFiles: true })
      }
      if (this.sessionFiles.owners.get(id)?.agent === agent) this.sessionFiles.clear(id)
    })
    this.offSessionDisposed = this.ctx.on?.('session/disposed', session => {
      const starting = this.starting.get(session?.id)
      if (starting !== undefined && starting.session === session) {
        this.invalidateStart(session.id, starting)
      }
    })
    for (const agent of this.ctx.agents?.list?.() ?? []) this.registerMirror(agent)
    // A mirror call DSH refuses before its body (a gate, a failed review, the person's no, a
    // Stop) leaves the agent's permission question with nobody to answer it.
    this.offResult = this.ctx.on?.('tools/result', exec => this.refusedFirst(exec))
    // No prepend: this must run after Auto review's prepended gate lets the call through.
    this.offReviewed = this.ctx.on?.('tools/pre-execute', (exec, next) => this.reviewedGate(exec, next))
    // DSH emits this after each new durable archive, whether from the UI (with or without
    // Stop), Bot Delete, group delete or bulk removal. Retire only that Session's run,
    // cutting off any reply in flight. Idle unarchived Sessions keep their runs.
    this.offArchived = this.ctx.on?.('workspace/session-archived', ({ sessionId } = {}) => {
      if (sessionId !== undefined) this.archiveSession(sessionId)
    })
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
   * Run one subagent's nested call as its own DSH card inside the step its Agent card holds
   * open. At Auto this is what puts the call through DSH's review gate: the reviewer answers a
   * real execution, and the mirror body answers the agent's question. The call's rows are
   * written in that step; the agent's queued update later finds `cardExecuted` and draws no
   * second card. A failure leaves the question unanswered for the direct ask that follows.
   * @returns {Promise<boolean>} whether the nested question got its answer
   */
  async runNested(live, nested, exec) {
    const session = exec.agent?.session
    const position = openStepOf(session)
    const tools = this.ctx.get?.('tools')
    const question = nested.permission
    if (session === undefined || position === undefined || tools?.execute === undefined
      || exec.toolSet === undefined || question === undefined) return false
    const id = `acp_${randomUUID()}`
    const raw = JSON.stringify(callArguments(nested))
    let hide
    try {
      hide = advertise(session, position, routeOf(session), { id, name: TOOL_NAME, raw }, message => this.warn(message))
    } catch (error) {
      this.warn(`a nested call was not advertised: ${error?.message ?? error}`)
      return false
    }
    // The execution is admitted by the step's own tool set: the mirror is a conditional tool.
    nested.cardExecuted = id
    live.calls.add(id)
    live.toolIds.set(id, nested.id)
    try {
      await tools.execute({
        calls: [{ id, name: TOOL_NAME, arguments: raw }],
        agent: exec.agent,
        signal: exec.signal,
        toolSet: exec.toolSet,
        log: position,
      })
    } catch (error) {
      this.warn(`a nested call was not recorded: ${error?.message ?? error}`)
    } finally {
      hide()
      live.calls.delete(id)
      live.toolIds.delete(id)
      if (nested.permission === question) nested.cardExecuted = undefined
    }
    return nested.permission !== question
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
   * Whether DSH's tools reach this agent when the setting says nothing. An adapter that can
   * drop its own built-in tools is in the default: today that is Claude Code's. An agent that
   * keeps them (Codex) bridges by default when its Bot needs DSH's team or role tools.
   * bots-dsh sends that as `needsDshTools` in the Session's identity.
   */
  bridgeDefault(agent, sessionId) {
    if (agent?.disableBuiltInTools === true) return true
    return this.roleToolsInDsh(sessionId)
  }

  /** Whether this Session's Bot needs DSH's tools whatever its agent keeps (bots-dsh identity). */
  roleToolsInDsh(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    try { return this.botIdentity(sessionId)?.needsDshTools === true } catch { return false }
  }

  bridgeOn(agent, sessionId) {
    return this.bridgeDecision(agent, sessionId).on
  }

  /**
   * Whether DSH's tools reach an agent at all: an explicit true/false decides, and an absent
   * setting takes the adapter's own switch (`bridgeDefault`).
   */
  bridgeDecision(agent, sessionId, off = this.live.get(sessionId)?.nativeOff === true) {
    if (this.backchannel === undefined) return { on: false, setting: undefined }
    // A row that declares no bridge (`bridge: false`, the native agents) gets none, even with
    // `dshTools: true`: its bridge calls would not be recognised, so each would draw a mirror
    // card beside the bridge's rows and ask twice.
    if (agent?.bridge === false) return { on: false, setting: undefined }
    // Codex with its own tools off works only through the bridge: it is on unless the admin's
    // kill switch says false (then the spawn is refused). A spawn passes its own value; the live
    // entry's serves the reads after it.
    if (off) return { on: this.dshTools() !== false, setting: undefined }
    const setting = this.dshTools()
    if (typeof setting === 'boolean') return { on: setting, setting }
    return { on: this.bridgeDefault(agent, sessionId), setting: undefined }
  }

  /**
   * Native-tools mode (#1564) for one Session: the agent keeps its own built-in tools (Claude
   * Code's Agent, Bash, Read, Edit, Write, Grep, Glob, Skill...) and the bridge serves only DSH's
   * extras (backchannel.js NATIVE_TWIN_TOOLS). Only for an agent whose built-in tools the bridge
   * would otherwise turn off (`disableBuiltInTools`, Claude Code) while its bridge is on; off
   * everywhere else, so an absent or false setting is today's behaviour. The setting is `true`
   * (every such Session) or an object whose keys are Bot names or DSH Session ids: a Session is
   * on when at least one key names it and none that names it says false. A throwing reader is off.
   * @param {any} agent this plugin's agent row
   * @param {string} sessionId the DSH Session
   * @param {string} provider the route being started
   */
  nativeOn(agent, sessionId, provider) {
    // Codex (`nativeSwitch: 'config'`) keeps its own tools by default and needs no bridge for
    // them; its team switch turns them off (codex-native.js).
    const codexRow = agent?.nativeSwitch === 'config'
    if (!codexRow && (agent?.disableBuiltInTools !== true || !this.bridgeOn(agent, sessionId))) return false
    if (this.teamManaged()) {
      const expected = codexRow ? 'acp-codex' : 'acp-claude'
      if (agent !== this.agents.get(expected) || (provider !== undefined && provider !== expected)) return false
      // A Bot with no agent tag is from before Codex had the switch: its ON is Claude's.
      // No identity is OFF (fail closed).
      try {
        const identity = this.botIdentity(sessionId)
        return identity?.nativeToolsBlocked !== true && identity?.nativeTools === true
          && (identity.nativeToolsAgent ?? 'acp-claude') === expected
      } catch { return false }
    }
    // With no Bot team ever registered, Codex launches as it always has.
    if (codexRow) return true
    let setting
    try { setting = this.nativeTools() } catch { return false }
    if (setting === true) return true
    if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) return false
    const keys = [sessionId]
    try {
      const name = this.botIdentity(sessionId)?.name
      if (typeof name === 'string' && name !== '') keys.push(name)
    } catch {}
    const said = keys.filter(key => typeof key === 'string' && Object.hasOwn(setting, key)).map(key => setting[key])
    return said.length > 0 && said.every(value => value === true)
  }

  readLevel(session, failClosed) {
    try {
      return levelOf(this.ctx.get?.('approval'), session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'), { failClosed })
    } catch { return undefined }
  }

  savedNativeOn(sessionId, provider) {
    try {
      const who = this.botIdentity(sessionId)
      // A kept child is reused only while the saved switch still reads ON (fail closed).
      if (who?.nativeToolsBlocked === true || who?.nativeTools !== true) return false
      // An ON always names its agent: an untagged one is not this provider's.
      return who.nativeToolsAgent === provider
    } catch { return false }
  }

  /**
   * Whether a Codex turn's model is kept: on the row's kept list (`nativeKeptModels`) or in the
   * set its last check measured with no tool block (B1-4). Such a model launches as today, with
   * Codex's own tools, whatever the switch says. DSH's `default` is the model Codex itself starts
   * with: the last one a process with its own tools reported, else the catalog's recorded start
   * model. Unknown is not kept (the checked path). `anyAge` (the Details row and the Bot team's
   * ON eligibility, which can only block) reads the measured set whatever its age (BG-3).
   */
  nativeKept(agent, model, { anyAge = false } = {}) {
    if (agent?.nativeSwitch !== 'config') return false
    const id = model === DEFAULT_MODEL ? (this.startModels.get(agent) ?? agent.catalog?.ownModel?.()) : model
    return this.keptSlug(agent, modelPart(id), { anyAge })
  }

  /** Whether a Codex model slug launches as today: the row's kept list or the measured set. */
  keptSlug(agent, slug, { anyAge = false } = {}) {
    return keptModel(agent, slug) || (typeof slug === 'string' && this.measuredKept(agent, { anyAge }).includes(slug))
  }

  /**
   * The models a Codex check last measured with no tool block (codex-native.js `unverified`):
   * the catalog's record, kept beside its start model on disk, else this host's. A turn reads
   * it for a day, then checks again; `anyAge` (the Details row and the Bot team's ON
   * eligibility, which can only block) reads it whatever its age, for the release that
   * measured it, so the row never unlocks and promises OFF because a day passed (BG-3).
   */
  measuredKept(agent, { anyAge = false } = {}) {
    try {
      if (typeof agent?.catalog?.measuredKept === 'function') {
        const models = agent.catalog.measuredKept({ anyAge })
        return Array.isArray(models) ? models : []
      }
      const mine = this.measured.get(agent)
      if (mine === undefined) return []
      if (anyAge) return mine.models
      const age = Date.now() - mine.at
      return age >= 0 && age < CATALOG_MAX_AGE_MS ? mine.models : []
    } catch { return [] }
  }

  /**
   * Add models a Codex check measured with no tool block before another reason refused it
   * (BG-1): merged into the current record, never replacing it.
   */
  mergeMeasured(agent, models) {
    this.recordMeasured(agent, [...this.measuredKept(agent), ...(Array.isArray(models) ? models : [])])
  }

  /** Record what a Codex check measured with no tool block, replacing its last record. */
  recordMeasured(agent, models) {
    const slugs = [...new Set((Array.isArray(models) ? models : []).map(modelPart).filter(slug => slug !== undefined))]
    if (typeof agent?.catalog?.recordMeasured === 'function') {
      try { agent.catalog.recordMeasured(slugs) } catch {}
      return
    }
    this.measured.set(agent, { models: slugs, at: Date.now() })
  }

  /** `nativeKept` for a Bot's route (`acp-codex/<model>`), for the Bot team's Details row. */
  nativeKeptRoute(route) {
    try {
      if (typeof route !== 'string') return false
      const at = route.indexOf('/')
      if (at <= 0) return false
      const agent = this.agents.get(route.slice(0, at))
      return this.nativeKept(agent, route.slice(at + 1), { anyAge: true }) === true
    } catch { return false }
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
    for (const [id, starting] of this.starting) {
      if (starting.provider !== provider) continue
      // The pending turn must keep this hold scoped when it returns from an await.
      if (starting.held === undefined) starting.heldByProvider = provider
      this.endSession(id, why, provider, candidate => candidate === starting)
    }
    for (const [id, live] of this.live) {
      if (live.provider === provider) this.endSession(id, why, provider, candidate => candidate === live)
    }
    for (const [id, owner] of this.sessionFiles.owners) {
      if (owner.provider === provider) this.sessionFiles.clear(id, { owner, retire: false })
    }
  }

  /**
   * End one agent session now: its process, its bridge credential and its place in `live`. The
   * DSH Session keeps its transcript. The next turn starts a new agent session and
   * replays the chat if replay is enabled and the history is eligible.
   */
  end(sessionId, live, { preserveFiles = false } = {}) {
    const owner = this.live.get(sessionId) === live ? this.sessionFiles.owners.get(sessionId) : live.fileOwner
    const upload = this.starting.get(sessionId)?.upload
    const { bridge, run } = live
    if (upload && upload.live === live && upload.run === run) upload.controller.abort()
    if (!preserveFiles && owner !== undefined) this.sessionFiles.clear(sessionId, { owner, retire: false })
    if (bridge !== undefined && bridge.calls > 0 && bridge.drained === undefined) {
      const hold = guardSession(live.dshAgent?.session ?? bridge.agent?.session)
      bridge.drained = () => hold?.release()
    }
    this.timers.clearTimeout(live.reaper)
    live.reaper = undefined
    live.reaping = undefined
    live.open = false
    live.substitution = undefined
    run?.dispose()
    if (bridge !== undefined) this.backchannel?.revoke(bridge)
    if (this.live.get(sessionId) === live) this.live.delete(sessionId)
  }

  isArchived(sessionId) {
    try {
      return this.ctx.get?.('workspaceRegistry')?.archivedSessionIds?.includes(sessionId) === true
    } catch {
      // The registry can be unavailable while the workspace service is activating.
      return false
    }
  }

  archiveSession(sessionId) {
    const entry = this.starting.get(sessionId)
    const live = this.live.get(sessionId)
    const run = live?.run
    const owner = this.sessionFiles.owners.get(sessionId)
    if (entry !== undefined) {
      entry.archived = true
      this.starting.delete(sessionId)
    }
    if (live !== undefined) live.archived = true
    entry?.upload?.controller.abort()
    if (owner !== undefined) this.sessionFiles.clear(sessionId, { owner, retire: false })
    if (live !== undefined) {
      this.end(sessionId, live, { preserveFiles: true })
      // A reader can finish before the child exits.
      run?.push({ type: 'aborted' })
    }
  }

  /**
   * The agent was just asked to stop its prompt (a Stop, a stopped tool call, drift). Nothing
   * says it will: a prompt still open after `cancelWaitMs` is an agent that ignored the cancel,
   * and its session ends here, on the app's side. Otherwise the run would stay busy, its
   * process would go on with whatever it was doing, and every later message would fail.
   */
  reap(sessionId, live) {
    if (live !== undefined) live.substitution = undefined
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
   * @param {string} [startupWhy] the sentence before a managed ON process receives its first prompt
   * @returns {boolean} whether an agent session was live or starting there
   */
  endClaudeSession(sessionId, why, startupWhy) {
    const live = this.live.get(sessionId)
    const startingNative = startupWhy !== undefined && this.starting.get(sessionId)?.provider === 'acp-claude'
      && live?.provider === 'acp-claude' && live.nativeManaged === true && live.native === true
      && live.run?.promptEnded === undefined
    return this.endSession(sessionId, startingNative ? startupWhy : why, 'acp-claude')
  }

  /**
   * End one Session's agent process when it holds its own tools (#1564): Claude's in native
   * mode (endClaudeSession), and Codex's when its switch let it keep them. An OFF Codex and one
   * on a kept model are left running. A Codex still starting there is held as Claude's is.
   * @returns {boolean} whether a process was live or starting there
   */
  endNative(sessionId, why, startupWhy) {
    const live = this.live.get(sessionId)
    if (live?.provider === 'acp-codex') {
      if (live.native !== true || live.nativeKept === true) return false
      return this.endSession(sessionId, startupWhy !== undefined && live.nativeManaged === true
        && live.run?.promptEnded === undefined ? startupWhy : why, 'acp-codex')
    }
    if (live === undefined && this.starting.get(sessionId)?.provider === 'acp-codex') {
      return this.endSession(sessionId, startupWhy ?? why, 'acp-codex')
    }
    return this.endClaudeSession(sessionId, why, startupWhy)
  }

  // An args-switch child (omp, Antigravity) holding its own tools; the name stays for the Bot
  // team, which calls it for every agent.
  endOmpSession(sessionId, why, startupWhy) {
    const live = this.live.get(sessionId)
    if (!this.teamManaged() || !ARGS_SWITCH.has(live?.provider) || live.nativeOff === true) return false
    const startingNative = startupWhy !== undefined && this.starting.get(sessionId)?.provider === live.provider
      && live.run?.promptEnded === undefined
    return this.endSession(sessionId, startingNative ? startupWhy : why, live.provider, state => state.nativeOff !== true)
  }

  endSession(sessionId, why, provider, matches = () => true) {
    const text = typeof why === 'string' && why.trim() !== '' ? why : HELD_TEXT
    const starting = this.starting.get(sessionId)
    const stopStarting = starting !== undefined && (provider === undefined || starting.provider === provider) && matches(starting)
    const live = this.live.get(sessionId)
    const stopLive = live !== undefined && (provider === undefined || live.provider === provider) && matches(live)
    const owner = this.sessionFiles.owners.get(sessionId)
    if (provider === undefined && owner !== undefined && (
      (stopStarting && starting.fileOwner === owner) || (stopLive && live.fileOwner === owner)
      || matches({ dshAgent: owner.agent, session: owner.session, provider: owner.provider })
    )) this.sessionFiles.clear(sessionId, { owner, retire: false })
    if (stopStarting) {
      starting.held ??= text
      starting.upload?.controller.abort()
    }
    if (!stopLive || this.live.get(sessionId) !== live) return stopStarting
    live.held = text
    live.open = false
    live.substitution = undefined
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

  // A crossing or disposal can arrive before there is any child or credential to revoke.
  invalidateStart(sessionId, entry) {
    entry.invalidated = true
    this.endSession(sessionId, undefined, undefined, candidate => candidate === entry || candidate === entry.startup)
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
    // fork and renew reach readiness only after receiving the replacement Session.
    if (state.checkReforkAccount?.() === false) {
      if (record !== undefined) this.backchannel.revoke(record)
      return
    }
    if (record === undefined) return
    this.backchannel.announce(record)
    const deadline = Date.now() + (agent.bridgeReadyMs ?? BRIDGE_READY_MS)
    while (!record.listed && !record.closed && !record.disconnected) {
      if (Date.now() > deadline) {
        const error = new Error(`the ${BRIDGE_NAME} bridge did not reach DSH (a server of that name in the agent's own config skips it)`)
        error.code = 'acp_bridge_missing'
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, BRIDGE_READY_POLL_MS).unref?.())
    }
    if (record.closed || record.disconnected) {
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
  async refork(agent, live, dshAgent, signal, { renew = false, checkAccount } = {}) {
    const { bridge: previous, run } = live
    const next = previous === undefined ? undefined : this.backchannel.mint({
      sessionId: dshAgent?.session?.id,
      agent: dshAgent,
      name: agent.name,
      promptRunning: () => live.open === true && live.run?.busy === true,
      promptSkillRefusals: () => live.open && live.run?.busy ? live.run.promptSkillRefusals : undefined,
      native: live.twinsOff === true,
      skillOnly: previous?.skillOnly === true,
      canList: checkAccount,
    })
    live.bridge = next
    live.checkReforkAccount = checkAccount
    // The source is done running tools before the fork starts.
    if (previous) this.backchannel.revoke(previous)
    try {
      // An OFF Codex opens the replacement where its tools were checked.
      const cwd = live.checkedCwd ?? (renew ? run.spec.cwd : dshAgent?.session?.header?.cwd ?? homedir())
      await run.held(() => run[renew ? 'renew' : 'fork']({
        cwd,
        mcpServers: next ? [this.bridgeServer(next)] : [],
      }), { ms: 0, signal })
    } catch (error) {
      // The fork may already have moved the run to a new ACP session (a bridge that never
      // listed). Nothing can resume that half state: revoke both credentials, end the run and
      // let the next turn start clean.
      live.bridge = previous
      if (next) this.backchannel.revoke(next)
      this.timers.clearTimeout(live.reaper)
      run.dispose()
      const sessionId = dshAgent?.session?.id
      if (this.live.get(sessionId) === live) this.live.delete(sessionId)
      if (previous !== undefined) this.backchannel.revoke(previous)
      throw error
    } finally {
      if (next !== undefined) next.canList = undefined
      if (live.checkReforkAccount === checkAccount) delete live.checkReforkAccount
    }
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
    if (!this.bridgeOn(agent, sessionId) || agent.drift !== true || tool.drift === true) return
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
    if (event?.type === 'turn/start' && typeof session?.id === 'string') {
      this.roleTurns.set(session.id, { turn: event.data?.turn })
    }
    // Every observed crossing invalidates this owner's epoch, including away and back and
    // sessions kept by the ordinary bridge-off path. No transcript can recreate authority.
    const owner = this.sessionFiles.owners.get(session?.id)
    if (owner?.session === session && ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection'].includes(event?.type)) {
      this.endSession(session.id, 'Image session permission changed. Send a new message to continue.', undefined,
        candidate => candidate.dshAgent === owner.agent && (candidate.session ?? candidate.dshAgent?.session) === session)
    }
    if (this.teamManaged() && ['sandbox/mode', 'permission/preset', 'approval/policy'].includes(event?.type)) {
      const live = this.live.get(session?.id)
      const claudeOn = live?.provider === 'acp-claude' && live.nativeManaged === true && live.native === true
      // A Codex process on a kept model keeps today's behaviour at Read only (Codex's own mode).
      const codexOn = live?.provider === 'acp-codex' && live.nativeManaged === true && live.native === true && live.nativeKept !== true
      const ompOn = ARGS_SWITCH.has(live?.provider) && live.nativeOff !== true
      if ((claudeOn || codexOn || ompOn)
        && ((event.type === 'sandbox/mode' && event.data?.mode === 'read-only') || !permitsNative(this.readLevel(session, true)))) {
        const readOnly = 'This conversation is now Read only. Send a new message to continue.'
        if (ompOn) this.endOmpSession(session.id, readOnly, NATIVE_TOOLS_CHANGED_TEXT)
        else this.endNative(session.id, readOnly, NATIVE_TOOLS_CHANGED_TEXT)
      }
    }
    if (event?.type !== 'model/selection') return
    const provider = event.data?.provider
    const starting = this.starting.get(session?.id)
    const live = this.live.get(session?.id)
    if (starting !== undefined && starting.session === session && typeof provider === 'string' && provider !== starting.provider) {
      this.invalidateStart(session.id, starting)
    }
    const liveSession = live?.dshAgent?.session
    if (live === undefined || (liveSession !== undefined && liveSession !== session)) return
    // Off is the old path, byte for byte: the agent session is kept across a turn on another
    // provider, so switching back resumes the same ACP session. The default is per agent.
    if (!this.bridgeOn(this.agents.get(live.provider), session?.id)) return
    if (agentRoute(this.agents, provider)) return
    if (this.live.get(session.id) === live) this.end(session.id, live)
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
  // Omit modalities here so bots-dsh never picks ACP models for OCR side requests.
  async listModels(provider) {
    const agent = this.agents.get(provider)
    if (agent === undefined || agent.installed?.() === false) return []
    if (agent.concreteClaude) agent.catalog.kick({ requireLive: true })
    const models = await agent.catalog.models()
    const live = agent.concreteClaude ? agent.catalog.identityModels() : undefined
    const pinned = live === undefined ? [] : CLAUDE_PINS.flatMap(pin => {
      if (this.pinIn(live, pin) !== pin.alias) return []
      const alias = models.find(row => row.id === pin.alias)
      return alias ? [{ ...alias, id: pin.id }] : []
    })
    return [...models, ...pinned]
      .map(model => ({ provider, id: model.id, name: model.name, ...(model.description ? { description: model.description } : {}) }))
  }

  pinIn(models, pin) {
    return models && pinWire(models.map(({ id, name }) => ({ value: id, name })), pin)
  }

  async resolveModelIdentity(provider, model) {
    const agent = this.agents.get(provider)
    if (agent?.installed?.() === false || !agent?.catalog) return { status: 'unavailable' }
    await agent.catalog.probeIdentityModels()
    return this.modelIdentityOf(provider, model)
  }

  modelIdentityOf(provider, model) {
    const agent = this.agents.get(provider)
    if (agent?.installed?.() === false || !agent?.catalog) return { status: 'unavailable' }
    agent.catalog.kick({ requireLive: true })
    const models = agent.catalog.identityModels()
    if (models === undefined) return { status: 'unavailable' }
    // When ACP offers no Default row, the router uses the model the live probe
    // reported at session start. An agent's own Default row makes no such claim.
    const own = model === DEFAULT_MODEL ? agent.catalog.identityDefault() : undefined
    if (own) model = own
    const pin = agent.concreteClaude ? pinOf(model) : undefined
    if (pin !== undefined) {
      const wire = this.pinIn(models, pin)
      // A raw alias alongside a concrete row still needs its own exact affiliation.
      const alias = this.pinIn(models.filter(row => row.id !== pin.id), pin)
      if (wire && (model === pin.id || alias === pin.alias)) return { status: 'offered', model: pin.id }
      return { status: 'unresolved' }
    }
    return models.filter(row => row.id === model).length === 1
      ? { status: 'offered', model } : { status: 'unresolved' }
  }

  // A model's efforts are the ones the agent offers for it; DSH turns down any other before the
  // agent sees it. A missing stand-in other than default takes its own efforts and every one the
  // known catalog offers, so the prompt reaches this adapter, which runs it on the agent's own model.
  async resolveModel(provider, model) {
    const agent = this.agents.get(provider)
    const models = agent?.catalog ? await agent.catalog.models() : []
    let found = models.find(entry => entry.id === model)
    const pin = agent?.concreteClaude ? pinOf(model) : undefined
    if (found === undefined && pin !== undefined && model === pin.id) {
      const wire = this.pinIn(agent.catalog.identityModels(), pin)
      const row = models.find(entry => entry.id === wire)
      if (row) found = { ...row, id: pin.id }
    }
    if (found === undefined) {
      found = agent?.catalog?.spec?.fallback?.find(entry => entry.id === model)
      if (found && model !== DEFAULT_MODEL) found = withOfferedEfforts(found, models)
    }
    const imageInput = agent?.imageInput === true ? { inputModalities: ['text', 'image'] } : {}
    if (found === undefined) return { provider, id: model, name: model, ...imageInput }
    return {
      provider, id: found.id, name: found.name,
      ...(found.description ? { description: found.description } : {}),
      ...(found.reasoning ? { reasoning: found.reasoning } : {}),
      ...imageInput,
    }
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

  // A CLI account waiting for the person's word is refused before any process starts.
  async accountRefusal(provider) {
    let unconfirmed
    try { unconfirmed = await this.access?.(provider) } catch {
      unconfirmed = 'The Bot account could not be checked. Sign in again in the app.'
    }
    if (typeof unconfirmed === 'string' && unconfirmed !== '') return finish('error', unconfirmed, MODEL_ACCESS_REQUIRED)
  }

  // One model step. The turn that is starting there is tracked from here to the step's last
  // exit (`starting`), whichever way it leaves: a refusal, a failure, a stop, its end.
  async *stream(options) {
    const { sessionId, signal } = options
    const fileOwner = this.sessionFiles.owners.get(sessionId)
    // Latch durable membership at admission, before the first await. Undo can remove
    // the id before this step resumes, but only a fresh entry may start afterward.
    const entry = { held: undefined, archived: this.isArchived(sessionId), fileOwner, fileLive: this.live.get(sessionId) }
    const pending = this.starting.get(sessionId)
    if (!entry.archived && fileOwner?.grant && pending !== undefined
        && pending.dshAgent === fileOwner.agent && pending.held === undefined) {
      return yield finish('error', 'The image session is already starting. Wait for that message to finish.')
    }
    const stopFiles = () => {
      // Stop and archive can abort the turn after persisting the archive, before the event.
      entry.archived ||= this.isArchived(sessionId)
      if (entry.archived) return
      if (entry.fileOwner === undefined || this.sessionFiles.owners.get(sessionId) !== entry.fileOwner) return
      const current = this.live.get(sessionId)
      const starting = this.starting.get(sessionId)
      if (current !== undefined && current !== entry.fileLive) return
      if (starting !== undefined && starting !== entry) return
      const why = 'The image session was stopped.'
      entry.held ??= why
      this.sessionFiles.clear(sessionId, { owner: entry.fileOwner, retire: false })
      this.endSession(sessionId, why, undefined, candidate => candidate === entry || candidate === entry.fileLive)
    }
    signal?.addEventListener('abort', stopFiles, { once: true })
    if (signal?.aborted) stopFiles()
    try {
      yield* this.step(options, entry)
    } finally {
      signal?.removeEventListener('abort', stopFiles)
      if (!entry.archived && entry.fileStartup && this.starting.get(sessionId) === entry
          && entry.fileOwner?.grant && this.sessionFiles.owners.get(sessionId) === entry.fileOwner
          && (entry.upload === undefined || (this.live.get(sessionId) === entry.upload.live
            && entry.upload.live.run === entry.upload.run))) {
        this.endSession(sessionId, undefined, undefined, candidate => candidate === entry || candidate === entry.fileLive)
      }
      if (this.starting.get(sessionId) === entry) this.starting.delete(sessionId)
    }
  }

  async *step(options, entry) {
    let agent = this.agents.get(options.provider)
    if (agent === undefined) {
      return yield entry.archived ? finish('stop') : finish('error', `No ACP agent is set up as ${options.provider}`, 'NO_ADAPTER')
    }
    // A title or summary DSH asks for on the side is refused at the llm/stream waterfall (aside).
    if (options.sessionId === undefined) return yield finish('error', `${agent.name} answers only in its own chat`, 'UNSUPPORTED')
    const sessionId = options.sessionId
    let dshAgent
    try {
      dshAgent = this.scope(sessionId)
    } catch (error) {
      if (entry.archived) return yield finish('stop')
      return yield finish('error', `${agent.name} cannot show its tools here: ${error?.message ?? error}`, error?.code)
    }
    const blocks = new Blocks()
    let live = this.live.get(sessionId)
    const archived = () => entry.archived || live?.archived === true
    // The agent's links to the images it saved locally leave its text before DSH writes it
    // (agent-image.js): the chat shows the image in its own card instead.
    const links = new ImageLinks(() => savedPathsOf(live?.run?.tools?.values()))
    const shown = function* () {
      const rest = links.flush()
      if (rest !== '') yield* blocks.add('text', rest)
    }
    // A held Session's step: the sentence as the answer, and nothing else happens there.
    const stopped = function* (why) {
      if (why === NATIVE_TOOLS_CHANGED_TEXT && options.signal?.aborted) return yield STOPPED()
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
    entry.dshAgent = dshAgent
    entry.session = dshAgent.session
    if (entry.fileOwner?.agent !== dshAgent || entry.fileOwner?.session !== entry.session) entry.fileOwner = undefined
    if (!entry.archived) this.starting.set(sessionId, entry)
    const started = () => { if (this.starting.get(sessionId) === entry) this.starting.delete(sessionId) }
    const ownsStart = () => this.starting.get(sessionId) === entry && !entry.agentDisposed
      && this.ctx.agents?.get?.(sessionId) === dshAgent && dshAgent.session === entry.session
      && (typeof this.ctx.sessions?.get !== 'function' || this.ctx.sessions.get(sessionId) === entry.session)
    const startChanged = () => entry.held !== undefined || !ownsStart() || this.agents.get(options.provider) !== agent
    const stopOwned = (why, expected, { provider, account = false, sessionHold = false } = {}) => {
      if (this.starting.get(sessionId) !== entry) return
      // A warmed run can still belong to this Session after its DSH Agent was replaced.
      const stopLive = expected !== undefined && this.live.get(sessionId) === expected
        && (provider === undefined || expected.provider === provider)
        && (!entry.invalidated || expected === entry.startup)
        && expected.dshAgent?.session === entry.session
        && (account || sessionHold || expected.dshAgent === dshAgent)
      const owner = this.sessionFiles.owners.get(sessionId)
      if (owner !== undefined && (provider === undefined || owner.provider === provider)
          && ((!account && owner === entry.fileOwner) || (stopLive && owner === expected.fileOwner))) {
        this.sessionFiles.clear(sessionId, { owner, retire: false })
      }
      this.endSession(sessionId, why, provider, candidate => candidate === entry || (stopLive && candidate === expected))
    }
    const stopChanged = function* () {
      const why = entry.held ?? live?.held ?? HELD_TEXT
      stopOwned(why, live, { provider: entry.heldByProvider })
      if (options.signal?.aborted && why === HELD_TEXT) return yield STOPPED()
      return yield* stopped(why)
    }
    const currentRefusal = () => this.currentAccess?.(options.provider)
    const accountRefused = (message = currentRefusal()) => {
      if (message === undefined) return
      stopOwned(message, live, { provider: options.provider, account: true })
      return finish('error', message, MODEL_ACCESS_REQUIRED)
    }
    let reforked = false
    let readinessRefusal
    const checkReforkAccount = () => {
      // A refused list stays binding for this replacement until readiness can retire it.
      readinessRefusal ??= currentRefusal()
      return readinessRefusal === undefined
    }
    const reforkRefusal = () => reforked ? accountRefused(readinessRefusal) : undefined
    const firstPromptRefusal = () => live.run.promptEnded === undefined || reforked ? accountRefused() : undefined
    const sessionHold = await this.heldBack(sessionId, dshAgent, options.provider)
    const held = sessionHold ?? entry.held
    if (archived()) return yield finish('stop')
    agent = this.agents.get(options.provider)
    if (agent === undefined) return yield finish('error', `No ACP agent is set up as ${options.provider}`, 'NO_ADAPTER')
    const followsTool = options.messages.findLast(message => !bridgeRow(message))?.role === 'tool'
    if (!ownsStart()) {
      // A disposed agent can still report a known account or connector refusal for its turn.
      if (!followsTool && this.starting.get(sessionId) === entry && (held === undefined || entry.agentDisposed)) {
        const refusal = await this.accountRefusal(options.provider)
        if (archived()) return yield finish('stop')
        if (this.starting.get(sessionId) === entry) {
          if (refusal !== undefined) return yield refusal
          const current = this.agents.get(options.provider)
          const failed = current?.connectorStartFailure?.()
          if (failed !== undefined) return yield finish('error', `${current.name} did not start: ${failed}`)
        }
      }
      return yield* stopped(held ?? HELD_TEXT)
    }
    if (held !== undefined) {
      stopOwned(held, live, {
        provider: sessionHold === undefined ? entry.heldByProvider : undefined,
        sessionHold: sessionHold !== undefined,
      })
      started()
      return yield* stopped(held)
    }
    live = entry.fileLive = this.live.get(sessionId)
    const last = options.messages.at(-1)
    // The step after a mirror call's result continues the agent's turn. The bridge writes result
    // rows of its own (a DSH tool call's result, or the row that closes a call still open when
    // its step ended, #957). Its advertisement can also follow the mirror result (#1293).
    // Look back through tool messages and bridge rows for the mirror result.
    const mirrorAnswered = (() => {
      for (let i = options.messages.length - 1; i >= 0; i--) {
        const message = options.messages[i]
        if (bridgeRow(message)) continue
        if (message?.role !== 'tool') return false
        if (live?.calls.has(message.toolCallId)) return true
      }
      return false
    })()
    const continuing = mirrorAnswered && live?.provider === options.provider && live.open
    if (continuing) started()
    if (!continuing) {
      if (live !== undefined) live.substitution = undefined
      if (followsTool) {
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
      // Codex's switch (`nativeSwitch: 'config'`) and a model on its kept list, which launches
      // as today, with Codex's own tools, whatever the switch says (RFC 0003, Codex amendment).
      const codexRow = agent.nativeSwitch === 'config'
      // `keptRelaunch`: this turn's OFF check measured its model with no tool block, so it runs
      // as today in this same turn (B1-4, below).
      const kept = codexRow && (entry.keptRelaunch === true || this.nativeKept(agent, options.model))
      const managed = ['acp-claude', 'acp-codex'].includes(options.provider) && this.teamManaged() && !kept
      const omp = agent.nativeSwitch === 'args'
      const levelAtStart = () => this.readLevel(dshAgent?.session, managed || (omp && this.teamManaged()))
      const turnLevel = levelAtStart()
      const skills = this.ctx.get?.('omniTeam')?.skillCalls
      const supportsSkillBridge = SKILL_BRIDGE_PROVIDERS.has(options.provider)
      const agy = options.provider === 'acp-antigravity'
      const skillCatalog = state => supportsSkillBridge && (!agy || state.nativeOff !== true || state.agySkillsVersion !== undefined)
        ? skills?.catalog(sessionId) : undefined
      const canMountSkills = () => this.backchannel !== undefined && supportsSkillBridge &&
        skills?.available(sessionId) === true
      const agySkillsWanted = () => canMountSkills() ? agent.agySkillsVersion?.() : undefined
      const inputStart = turnStart(options.messages)
      const history = options.messages.slice(0, inputStart)
      const session = dshAgent?.session
      const skillOptions = { catalog: false, session }
      const historyOf = rows => skills?.project({ ...options, messages: rows }, { ...skillOptions, historyOnly: true }).messages ?? rows
      const replayOf = (rows, owed) => replayBlocks(historyOf(rows), { redact: this.redact, to: agent.name, ...owed })
      const durableHistory = () => {
        const saved = new Set(session?.deriveMessages?.().map(row => row.id))
        return history.filter(row => saved.has(row.id))
      }
      // The switch is the Bot's: every turn of its Sessions follows it, whoever sends it (#1564).
      const ompNativeAllowed = () => permitsNative(levelAtStart())
        && this.savedNativeOn(sessionId, options.provider)
      // Capture the turn's initial switch before the account wait. A later flip still
      // invalidates startup when it reaches the launch checks.
      const codexOffAtStart = codexRow && !kept && this.teamManaged()
        && !(permitsNative(turnLevel) && this.nativeOn(agent, sessionId, options.provider))
      const refusal = await this.accountRefusal(options.provider)
      if (archived()) return yield finish('stop')
      if (startChanged()) return yield* stopChanged()
      const takesIdentity = IDENTITY_PROVIDERS.includes(options.provider)
      const botIdentity = takesIdentity || options.provider === 'acp-omp' ? readIdentity(this.botIdentity, sessionId)
        : readIdentity(this.solverIdentity, sessionId)
      const identityRead = takesIdentity ? botIdentity : undefined
      // Other ACP agents can receive the Solver's method supplement through the
      // existing identity prompt delivery, without adopting the whole Bot role.
      const role = takesIdentity ? rolePromptOf(identityRead)
        : rolePromptOf({ name: botIdentity?.name, rolePrompt: botIdentity?.solverLimitsPrompt })
      const turn = this.roleTurns.get(sessionId)
      const sameTurn = live !== undefined && turn !== undefined && live.roleTurn === turn
      const roleChanged = live !== undefined && !sameTurn && (live.roleDigest ?? '') !== role.digest
      if (refusal !== undefined) {
        const owner = entry.fileOwner
        if (owner?.provider === options.provider && owner.grant?.staged) {
          this.sessionFiles.clear(sessionId, { owner, retire: false })
        }
        // A run with a revoked role must give up its old authority even on a refused turn.
        if (roleChanged && live.roleDigest && live.provider === options.provider
            && live.dshAgent === dshAgent && this.live.get(sessionId) === live) this.end(sessionId, live)
        return yield refusal
      }
      // Whether the Details switch could turn this turn's Codex ON, read when the text is made: any
      // Session of a Bot it is not blocked for.
      const switchHere = () => {
        try { return identityRead?.nativeToolsBlocked === false } catch { return false }
      }
      const offText = reason => offUnavailableText(reason, switchHere())
      // An OFF Codex turn does not ask for own mode or open an image-file grant.
      // Only a genuine user message activates staged file authority. The trailing-tool
      // guard above remains the sole continuation rule; no approval creates a prompt.
      let fileOwner
      let fileContext
      let keepsFiles = () => false
      if (codexOffAtStart && this.sessionFiles.owners.has(sessionId)) this.sessionFiles.clear(sessionId, { retire: false })
      if (agent.sessionFiles === true && !codexOffAtStart) {
        const level = levelOf(this.ctx.get?.('approval'), dshAgent.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
        let strictChat = restrictedLevel(level)
        if (strictChat && level.sandbox === 'workspace-write' && agent.ownMode !== undefined) {
          strictChat = await this.ownAnswer(sessionId, dshAgent, options.provider) !== 'yes'
        }
        if (archived()) return yield finish('stop')
        if (startChanged()) return yield* stopChanged()
        if (options.signal?.aborted || entry.held !== undefined) return yield* stopped(entry.held ?? 'The image session was stopped.')
        const currentLevel = levelOf(this.ctx.get?.('approval'), dshAgent.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
        if (strictChat && (!restrictedLevel(currentLevel) || currentLevel.sandbox !== level.sandbox)) {
          this.endSession(sessionId)
          return yield* stopped('Image session permission changed. Send a new message to continue.')
        }
        if (strictChat) {
          fileOwner = entry.fileOwner = this.sessionFiles.owner(dshAgent, options.provider)
          entry.fileStartup = true
          try {
            const fileGrant = fileOwner.grant
            const files = await this.sessionFiles.activate(fileOwner, last, options.signal)
            if (archived()) return yield finish('stop')
            if (startChanged()) return yield* stopChanged()
            if (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined) throw new Error('Image permission changed before startup.')
            fileContext = { sandbox: level.sandbox, files }
            keepsFiles = () => fileOwner !== undefined && this.sessionFiles.valid(fileOwner)
              && fileOwner.grant === fileGrant && entry.held === undefined
          } catch (error) {
            if (archived()) return yield finish('stop')
            if (startChanged()) return yield* stopChanged()
            stopOwned(undefined, live)
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
      // If the bridge process exited and the adapter has yet to re-attach by the next turn,
      // start a new agent session with DSH's tools and replay the chat to it (#969).
      // Native-tools mode keeps the agent's own tools, so it keeps the hard ask rules too: the
      // person's own allow rules must not silently skip the ask for a hard Bash or file case.
      // For a Codex row, `native` means its process holds Codex's own tools.
      const native = kept ? true : managed
        ? live?.native === true && live.nativeManaged === true && permitsNative(turnLevel)
          && identityRead !== undefined && identityRead.nativeToolsBlocked !== true
          && identityRead.nativeTools === true
          && (codexRow || this.bridgeOn(agent, sessionId))
        : this.nativeOn(agent, sessionId, options.provider)
      // A turn replaces a managed OFF process when the saved switch is ON.
      const upgrade = managed && live !== undefined && live.native !== true && live.nativeManaged === true
        && permitsNative(turnLevel)
        && identityRead !== undefined && identityRead.nativeToolsBlocked !== true && this.nativeOn(agent, sessionId, options.provider)
      const hardAsks = (enabled, currentLevel, bridged) => typeof agent.hardAsk === 'function'
        && !((bridged ?? this.bridgeOn(agent, sessionId)) && agent.disableBuiltInTools === true && !enabled)
        && currentLevel?.full !== true
      const asks = hardAsks(native, turnLevel)
      const agyOffLive = agy && live?.provider === options.provider && live.nativeOff === true
      const wantedAgyVersion = agyOffLive ? agySkillsWanted() : undefined
      const wantsSkills = agyOffLive ? wantedAgyVersion !== undefined : canMountSkills()
      const bridgeGone = (live?.bridge?.closed === true || live?.bridge?.disconnected === true)
        && (this.bridgeOn(agent, sessionId) || wantsSkills)
      const needsSkillBridge = live?.bridge === undefined && wantsSkills
      // Antigravity OFF selects its exact tool list at process launch. When
      // eligibility or executable proof changes, replace the child and replay delivered history.
      const relaunchForSkills = agyOffLive && live.agySkillsVersion !== wantedAgyVersion
      if (bridgeGone) this.warn(`${live.name} lost its ${BRIDGE_NAME} bridge: its session was ended and a new one starts`)
      // A new tool set or role needs a new agent session.
      const remade = live !== undefined && (live.provider !== options.provider || !live.run.alive
        || (live.run.promptEnded === undefined && (live.dshAgent !== dshAgent
          || (live.providerRow !== undefined && live.providerRow !== agent)))
        || bridgeGone || needsSkillBridge || relaunchForSkills || live.asks !== asks || (live.native === true) !== native || roleChanged || upgrade)
      if (remade) {
        if (roleChanged) {
          try {
            this.ctx.logger?.info?.(
              `acp-dsh: ${agent.name} role prompt changed: a new agent session starts`)
          } catch {}
        }
        this.end(sessionId, live, { preserveFiles: keepsFiles() })
        live = undefined
      }
      // The agent is still on its last prompt (a Stop it has not answered yet, a turn DSH ended
      // without it). Asked to stop, it has `cancelWaitMs`; one that will not end is replaced
      // below by a new session in this same turn, which the replay carries the chat to, so the
      // chat never waits on it again.
      if (live !== undefined && live.run.busy) {
        const ended = await this.stopping(live, options.signal)
        // Ended while the old prompt was given its time (endSession): nothing starts here.
        if (archived()) return yield finish('stop')
        if (startChanged()) return yield* stopChanged()
        if (options.signal?.aborted) {
          if (!ended) this.reap(sessionId, live)
          return yield STOPPED()
        }
        // `alive` and the map: the Stop's own wait (reap) may have ended it meanwhile.
        if (!ended || !live.run.alive || this.live.get(sessionId) !== live) {
          if (!ended) this.warn(`${agent.name} did not stop its last answer within ${waited(this.cancelWaitMs)}: a new session replaces it`)
          this.end(sessionId, live, { preserveFiles: keepsFiles() })
          live = undefined
        }
      }
      if (live !== undefined && live.run.preambleOutcome === 'unsure'
        && (live.roleDigest ?? '') !== '') {
        try {
          this.ctx.logger?.info?.(
            `acp-dsh: ${agent.name} role prompt not confirmed: a new agent session starts`)
        } catch {}
        this.end(sessionId, live, { preserveFiles: keepsFiles() })
        live = undefined
      }
      // omp takes its tools from argv. Replace a child whose launch no longer fits this turn.
      if (omp && live !== undefined && this.teamManaged()) {
        const keep = live.nativeOff !== undefined && live.nativeOff === !ompNativeAllowed()
        if (!keep) {
          this.end(sessionId, live, { preserveFiles: keepsFiles() })
          live = undefined
        }
      }
      if (live !== undefined) live.roleTurn = turn
      let fresh = false
      let crossing = false
      let renewedForSkills = false
      let replaySource
      let launchEligible
      const prior = lastProviderOf(options.messages)
      // The transcript before this turn: what a replay carries (plan A-5, independent of the
      // bridge; only the kill switch turns it off).
      const replaying = this.replayOn()
      if (live !== undefined && live.skillCatalog !== undefined && live.skillCatalog !== skillCatalog(live)?.key) {
        try {
          if (startChanged()) return yield* stopChanged()
          const refused = accountRefused()
          if (refused !== undefined) return yield refused
          if (codexRow && live.nativeOff === true) ensureCatalog(live.offCatalog)
          await this.refork(agent, live, dshAgent, options.signal, { renew: true, checkAccount: checkReforkAccount })
        } catch (error) {
          if (archived()) return yield finish('stop')
          if (live.held !== undefined) return yield* stopped(live.held)
          if (startChanged()) return yield* stopChanged()
          this.end(sessionId, live)
          const left = this.unanswered(agent, error, 'refreshing its Skills catalog')
          if (left !== undefined) return yield left
          return yield finish('error', `${agent.name} would not refresh its session: ${error?.message ?? error}`)
        }
        if (archived()) return yield finish('stop')
        if (startChanged()) return yield* stopChanged()
        reforked = true
        const refused = reforkRefusal()
        if (refused !== undefined) return yield refused
        live.skillCatalog = undefined
        fresh = renewedForSkills = true
        // The DSH Session and its visible transcript stay in place. Rebuild
        // the provider context from its durable rows, which have no catalog.
        replaySource = durableHistory()
        live.owed = { renewed: true, skills: true }
        const blocks = replayOf(replaySource, live.owed)
        live.replay = blocks.length > 1 ? blocks : undefined
      } else if (live === undefined) {
        crossing = replaying && prior !== undefined && prior !== options.provider
        const state = {
          fileOwner, pendingMirrors: new Set(), fileSandbox: fileContext?.sandbox,
          provider: options.provider, providerRow: agent, name: agent.name, asks, native, twinsOff: false,
          run: undefined, calls: new Set(), toolIds: new Map(), open: false, dshAgent,
          bridge: undefined, replay: undefined, owed: undefined, drifted: false,
          roleDigest: role.digest, roleTurn: turn,
        }
        entry.startup = state
        if (role.refused) {
          try {
            this.ctx.logger?.info?.(
              `acp-dsh: ${agent.name} Bot role prompt refused (${role.refused})`)
          } catch {}
        }
        const text = takesIdentity ? identityText(identityRead, role.part) : role.part
        // A Codex OFF check that measured this turn's model with no tool block (B1-4): the turn
        // runs again from its start as a kept one (today's launch), with no notice. Nothing of the
        // OFF attempt was started. Once per turn.
        const relaunchKept = () => {
          entry.keptRelaunch = true
          entry.nativeOff = undefined
          try { this.ctx.logger?.info?.(`acp-dsh: ${agent.name} shows no tools to check on this model; it runs with its own tools, as before`) } catch {}
          return this.step(options, entry)
        }
        // `default` whose start model is not known yet: what Codex starts on is not known either.
        const startUnknown = () => {
          if (options.model !== DEFAULT_MODEL) return false
          try { return (this.startModels.get(agent) ?? agent.catalog?.ownModel?.()) === undefined } catch { return true }
        }
        const checkStart = () => {
          entry.archived ||= this.isArchived(sessionId)
          if (entry.archived) throw ARCHIVED
          if (startChanged() || options.signal?.aborted) throw START_CHANGED
          const message = this.currentAccess?.(options.provider)
          if (message !== undefined) throw Object.assign(new Error(message), { code: MODEL_ACCESS_REQUIRED })
        }
        // A connector release that passed its start check is still unproven until it opens a
        // session. One that fails here goes back to the release before it (install.js), and the
        // session start is tried once more on that one: the turn is not lost to a bad release.
        for (let attempt = 0; ; attempt += 1) {
          try {
            // The chat profile modes belong to this process's home, read once at its start: a
            // later spawn or a replaced agent object never changes what a running session asks.
            // omp's tool set is launch argv. Decide it after the startup awaits,
            // so a permission change during startup applies to the first process.
            const spawnOmpManaged = omp && this.teamManaged()
            // Codex keeps its own tools only when its saved switch is ON for it, on a kept
            // model, or with no Bot team; anything else starts it OFF.
            const codexManaged = codexRow && !kept && this.teamManaged()
            const preOn = !codexManaged || (permitsNative(levelAtStart())
              && this.nativeOn(agent, sessionId, options.provider))
            const codexOff = codexRow && !preOn
            const nativeOff = spawnOmpManaged ? !ompNativeAllowed() : codexRow ? codexOff : undefined
            const checkArgsMode = () => {
              if (omp && (spawnOmpManaged !== this.teamManaged()
                  || (spawnOmpManaged && nativeOff === ompNativeAllowed()))) throw START_CHANGED
            }
            entry.nativeOff = state.nativeOff = nativeOff
            const agyOff = agy && nativeOff === true
            let prepareAgySkills = agyOff && agySkillsWanted() !== undefined
            if (prepareAgySkills) {
              await this.backchannel.listen()
              checkStart()
              checkArgsMode()
              prepareAgySkills = canMountSkills()
            }
            if (codexOff) {
              // ON when the turn started, OFF now: a staged image grant cannot come with it.
              if (fileOwner !== undefined) {
                this.sessionFiles.clear(sessionId, { owner: fileOwner })
                started()
                return yield* stopped(NATIVE_TOOLS_CHANGED_TEXT)
              }
              // Its own tools off and DSH's turned off: nothing would be left to work with.
              if (!this.bridgeDecision(agent, sessionId, true).on) {
                return yield finish('error', noBridgeText(switchHere()), 'acp/native-off-no-bridge')
              }
            }
            const spawnContext = codexOff
              ? { nativeOff: true, cwd: dshAgent?.session?.header?.cwd, signal: options.signal }
              : {
                  ...(fileContext === undefined ? {} : { sessionFiles: fileContext }),
                  ...(nativeOff === true ? { nativeOff: true } : {}),
                  ...(prepareAgySkills ? { skillBridge: true } : {}),
                }
            checkStart()
            const launch = agent.spawn(Object.keys(spawnContext).length === 0 ? undefined : spawnContext)
            // omp's launch spec is synchronous and it has no bridge to prepare.
            // Keep its policy decision and actual spawn in the same event-loop turn.
            const { profileModes, sessionFileMode, sessionFileEnabled, nativeOff: spawnedOff, checkedCwd, models, unverified, offCatalog, agyReady, agySkillsVersion, offRecheck, ...spec } = omp ? launch : await launch
            checkStart()
            state.agySkillsVersion = agySkillsVersion
            const agySkills = agySkillsVersion !== undefined
            if (spawnOmpManaged && entry.held !== undefined) return yield* stopped(entry.held)
            // The check measured these models with no tool block: kept from now on (B1-4 (b)). When
            // this turn's model is one of them it runs as today, in this same turn.
            if (codexOff && Array.isArray(unverified)) {
              this.recordMeasured(agent, unverified)
              if (entry.keptRelaunch !== true && this.nativeKept(agent, options.model)) {
                if (options.signal?.aborted) return yield STOPPED()
                // Run from the catch, out of this `try` (BG-2).
                throw KEPT_RELAUNCH
              }
            }
            if (codexOff) {
              // The checks ran for this start: its folder, at least one model, its own tools off.
              const real = path => { try { return realpathSync(path) } catch { return undefined } }
              const checkedAt = typeof checkedCwd === 'string' ? real(checkedCwd) : undefined
              const runsAt = real(dshAgent?.session?.header?.cwd ?? spec.env?.AUTOMAGIK_BOT_CLI_HOME ?? homedir())
              if (spawnedOff !== true || !Array.isArray(models) || models.length === 0 || checkedAt === undefined || checkedAt !== runsAt) {
                throw Object.assign(new Error('its check did not match this start'), { code: NATIVE_OFF_UNAVAILABLE, reason: 'its check did not match this start' })
              }
            }
            state.checkedModels = codexOff ? models : undefined
            state.offCatalog = codexOff ? offCatalog : undefined
            state.checkedCwd = codexOff ? checkedCwd : undefined
            state.nativeKept = kept
            // Antigravity OFF: its settings check before each later prompt (agy-off.js).
            state.offRecheck = offRecheck
            state.profileModes = profileModes
            state.sessionFileMode = sessionFileMode
            state.sessionFileEnabled = sessionFileEnabled === true
            if (fileContext?.files.length && (!sessionFileMode || !state.sessionFileEnabled)) throw new Error('The exact image profile is unavailable.')
            if (fileOwner && (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined)) throw new Error('Image permission changed during startup.')
            if (!state.sessionFileEnabled && fileOwner) {
              this.sessionFiles.clear(sessionId, { owner: fileOwner })
              state.fileOwner = fileOwner = undefined
            }
            const decision = this.bridgeDecision(agent, sessionId, codexOff)
            const bridged = decision.on
            state.bridgeDefault = decision.setting === undefined ? bridged : undefined
            const skillOnly = !bridged && (agyOff ? agySkills : canMountSkills())
            launchEligible = () => {
              const current = this.bridgeDecision(agent, sessionId, codexOff)
              return current.on === bridged && current.setting === decision.setting
                && (agyOff ? !agySkills || canMountSkills() : skillOnly === (!bridged && canMountSkills()))
                && (!fileOwner || this.sessionFiles.valid(fileOwner))
            }
            if ((bridged || skillOnly) && !agySkills) {
              await this.backchannel.listen()
              checkStart()
              checkArgsMode()
            }
            const spawnManaged = ['acp-claude', 'acp-codex'].includes(options.provider) && this.teamManaged() && !kept
            if (spawnManaged && entry.held !== undefined) return yield* stopped(entry.held)
            if (bridged && fileOwner && (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined || options.signal?.aborted)) throw new Error('Image permission changed while the bridge started.')
            // Read the saved switch after asynchronous process preparation, just before
            // choosing the bridge tools and starting the process that will use them.
            const spawnLevel = spawnManaged ? levelAtStart() : turnLevel
            // An OFF Codex never turns ON mid-spawn.
            const spawnNative = codexOff ? false : spawnManaged
              ? permitsNative(spawnLevel) && this.nativeOn(agent, sessionId, options.provider)
              : native
            // ON before the spawn, no longer after it: no process starts, the next turn opens OFF.
            if (codexRow && preOn && spawnManaged && !spawnNative) return yield* stopped(NATIVE_TOOLS_CHANGED_TEXT)
            const spawnAsks = spawnManaged ? hardAsks(spawnNative, spawnLevel, bridged) : asks
            state.native = codexRow ? !codexOff : spawnNative
            state.nativeManaged = spawnManaged
            state.asks = spawnAsks
            // A Bot whose team or role tools live in DSH gets DSH's extras by default on Codex.
            // An explicit `dshTools: true` keeps the whole preset, and so does an OFF Codex.
            const roleExtras = bridged && agent.disableBuiltInTools !== true && decision.setting !== true && this.roleToolsInDsh(sessionId)
            const twinsOff = codexRow ? !codexOff && roleExtras : spawnNative || roleExtras
            state.twinsOff = twinsOff
            checkStart()
            if (!launchEligible()) throw START_CHANGED
            if (bridged || skillOnly) {
              state.bridge = this.backchannel.mint({ sessionId, agent: dshAgent, name: agent.name,
                promptRunning: () => state.open === true && state.run?.busy === true,
                promptSkillRefusals: () => state.open && state.run?.busy ? state.run.promptSkillRefusals : undefined,
                native: twinsOff, skillOnly })
            }
            this.diagnostics?.started(sessionId, this, agent, state)
            const run = new AgentRun({
              ...spec,
              provider: options.provider,
              cwd: dshAgent?.session?.header?.cwd
                ?? spec.env?.AUTOMAGIK_BOT_CLI_HOME ?? homedir(),
              name: agent.name,
              botIdentity: () => text,
              // Which way the Bot's identity went (never its text), for the log.
              onIdentity: takesIdentity ? delivery => {
                try { this.ctx.logger?.info?.(`acp-dsh: ${agent.name} Bot identity: ${delivery}`) } catch {}
              } : undefined,
              mcpServers: state.bridge === undefined ? [] : [this.bridgeServer(state.bridge)],
              // Native-tools mode: the built-in tools stay on (`disableBuiltInTools: false`), with
              // the hard ask rules unless the level is Full.
              ...(agySkills ? { sessionMeta: { antigravity: { eagerMcpServers: [BRIDGE_NAME] } } }
                : spawnNative && !codexRow
                ? { sessionMeta: { ...(spawnAsks ? agent.hardAsk() : {}), disableBuiltInTools: false } }
                : bridged && agent.disableBuiltInTools === true
                  ? { sessionMeta: { disableBuiltInTools: true } }
                  : spawnAsks ? { sessionMeta: agent.hardAsk() } : {}),
              dshTools: bridged,
              skillBridge: state.bridge !== undefined && SKILL_BRIDGE_PROVIDERS.has(options.provider),
              ...(omp && nativeOff === true ? {
                refuseTools: true,
                onForbiddenTool: () => {
                  if (this.live.get(sessionId) === state && state.run === run) {
                    this.endSession(sessionId, toolsOffText(options.provider), options.provider,
                      candidate => candidate === state || candidate === entry)
                  }
                },
              } : {}),
              ...(codexOff ? {
                nativeOff: true,
                onNativeOffCall: tool => {
                  this.warn(`${agent.name} used one of its own tools (${tool.kind ?? 'other'}) while they are off: its session was ended`)
                  if (this.live.get(sessionId) === state && state.run === run) this.endSession(sessionId, NATIVE_CALL_TEXT, options.provider)
                },
              } : {}),
              refresh: agent.refresh,
              // Keep Antigravity's settings check before a prompt, including when
              // session/new also mounted the Skills bridge.
              onReady: async run => {
                if (agyReady !== undefined) await agyReady(run)
                if (state.bridge !== undefined || state.checkReforkAccount !== undefined) await this.ready(agent, state)
              },
              onAsked: () => { if (state.own === true && state.bridge !== undefined) state.bridge.agentAsked = true },
              // In native-tools mode a built-in call is the point, not drift: it gets its mirror
              // card and DSH's approval like any call of an agent without the bridge.
              onToolCall: tool => {
                if (!spawnNative && this.live.get(sessionId) === state && state.run === run) {
                  this.checkDrift(sessionId, agent, tool)
                }
              },
              onIgnored: message => this.warn(message),
              onRefusedMcp: tool => this.warn(`${agent.name} asked to run an MCP tool of ${typeof tool.mcpServer === 'string' ? `server "${tool.mcpServer.slice(0, 80)}"` : 'an unnamed server'}: refused, only the ${BRIDGE_NAME} bridge's tools run with DSH's tools on`),
              onMode: seen => this.diagnostics?.mode(sessionId, state, seen),
              ...(agent.startMs === undefined ? {} : { startMs: agent.startMs }),
              ...(agent.requestMs === undefined ? {} : { requestMs: agent.requestMs }),
              timers: this.timers,
            })
            checkStart()
            if (!launchEligible()) throw START_CHANGED
            state.run = run
            this.live.set(sessionId, state)
            entry.fileLive = state
            const starting = run.start({ signal: options.signal })
            run.gone?.catch(() => {
              // A fork can replace the bridge on this run. A startup retry can replace the run.
              if (state.run === run && state.bridge !== undefined) this.backchannel.revoke(state.bridge)
            })
            await starting
            if (state.archived) throw ARCHIVED
            checkStart()
            // DSH's `default` for Codex is the model a process with its own tools started on. An
            // OFF process reads a catalog without the kept models, so it never says.
            if (codexRow && !codexOff && typeof run.startModel === 'string') this.startModels.set(agent, run.startModel)
            if (fileOwner && (!this.sessionFiles.valid(fileOwner) || entry.held !== undefined)) throw new Error('Image permission changed during startup.')
            try { agent.proven?.() } catch {}
            break
          } catch (error) {
            if (error === ARCHIVED || entry.archived || state.archived || this.isArchived(sessionId)) {
              entry.archived = true
              this.end(sessionId, state, { preserveFiles: true })
              return yield finish('stop')
            }
            // Not a failed start: the turn runs again as a kept one, outside the start's `try`.
            if (error === KEPT_RELAUNCH) return yield* relaunchKept()
            // Nothing is left of a start that failed: the process is gone with its bridge.
            if (state.fileOwner !== undefined) {
              this.sessionFiles.clear(sessionId, { owner: state.fileOwner, retire: false })
            }
            this.end(sessionId, state, { preserveFiles: true })
            state.run = undefined
            state.bridge = undefined
            // Ended while it started (endSession): not a failed connector, so no rollback.
            if (state.held !== undefined || entry.held !== undefined) return yield* stopped(state.held ?? entry.held)
            if (error === START_CHANGED || startChanged()) return yield* stopChanged()
            // A Stop while it started ends the turn as any Stop does; a start nobody answered
            // says where to look. Neither blames the connector's release: a CLI waiting for the
            // person hangs the same way on any release, so there is no rollback for them.
            const left = this.unanswered(agent, error, 'starting')
            if (left !== undefined) return yield left
            if (isAuthRequired(error)) {
              this.signedOut(options.provider)
              return yield signInFailure(agent, error)
            }
            if (error?.code === MODEL_ACCESS_REQUIRED || error?.code === 'acp-account/busy') {
              return yield finish('error', error.message, MODEL_ACCESS_REQUIRED)
            }
            // Every model of this Codex answered its check with no tool block (B1-4): none is
            // refused. The turn runs as today in this same turn when its model is now kept, or is
            // `default` with no known start model; any other model was not checked (LQ1).
            if (error?.code === NATIVE_OFF_UNVERIFIABLE) {
              if (options.signal?.aborted) return yield STOPPED()
              this.recordMeasured(agent, error.models)
              if (entry.keptRelaunch !== true && (this.nativeKept(agent, options.model) || startUnknown())) return yield* relaunchKept()
              return yield finish('error', offText('this model was not checked'), NATIVE_OFF_UNAVAILABLE)
            }
            // A check that refused OFF is this Codex's answer, not the connector's release.
            const offRefused = error?.code === NATIVE_OFF_UNAVAILABLE
            if (offRefused && options.signal?.aborted) return yield STOPPED()
            // Refused for another model's reason after this check measured models with no tool
            // block (BG-1): they are kept (merged into the record), and a turn on one of them runs
            // as today in this same turn. A deadline, a Stop, Codex's `Invalid configuration` or
            // an unreadable call carries none (codex-native.js).
            if (offRefused && Array.isArray(error.unverified) && error.unverified.length > 0) {
              this.mergeMeasured(agent, error.unverified)
              if (entry.keptRelaunch !== true && this.nativeKept(agent, options.model)) return yield* relaunchKept()
            }
            if (offRefused) return yield finish('error', offText(error.reason ?? error.message ?? 'its check failed'), NATIVE_OFF_UNAVAILABLE)
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
        if (relaunchForSkills) {
          renewedForSkills = true
          replaySource = durableHistory()
          live.owed = { renewed: true, skills: true }
          const blocks = replayOf(replaySource, live.owed)
          live.replay = blocks.length > 1 ? blocks : undefined
        } else if (crossing) {
          this.appendBoundary(dshAgent, agent, options.provider)
          live.owed = { from: this.agents.get(prior)?.name ?? 'DSH' }
          replaySource = history
          live.replay = replayOf(replaySource, live.owed)
        } else if (replaying && answered(history)) {
          // A new session of the same agent in a chat that already has answers (a restart, a
          // session ended by a crossing or a flip, the first real turn of a Bot part whose
          // handoff turn the Bot team answered itself) is a crossing too: the chat, the handoff
          // package included, reaches it. No boundary row: the chat did not change providers.
          const blocks = replayOf(history, { renewed: true })
          if (blocks.length > 1) {
            replaySource = history
            live.owed = { renewed: true }
            live.replay = blocks
          }
        } else if (!replaying) {
          // The kill switch carries no chat, but a Bot part's handoff package is not chat: it is the record the
          // part starts from, which the Bot team acknowledged itself, so the agent has never read it. It goes
          // ahead of the person's words in this first prompt, once, the way the replay would carry it.
          const row = unreadHandoff(historyOf(history))
          const line = row === undefined ? undefined : renderMessage(row)
          if (line !== undefined) {
            live.owed = { renewed: true, handoff: true }
            live.replay = [{ type: 'text', text: this.redact(line) }]
          }
        }
      } else if (live.owed?.skills || (replaying && live.replay !== undefined)) {
        // The last turn never reached its prompt (a refused model, a busy agent): its replay is
        // still owed, read again over the chat as it is now. Its row is already written.
        replaySource = live.owed?.skills ? durableHistory()
          : live.owed?.missed === true ? missedBy(history, options.provider) : history
        if (replaySource !== undefined) {
          const blocks = replayOf(replaySource, live.owed)
          live.replay = blocks.length > 1 ? blocks : undefined
        }
      } else if (replaying) {
        // A live session resumed after the chat answered elsewhere (an agent whose session a
        // move off it keeps, Codex by default): the turns it missed are replayed before the
        // prompt, so Codex -> API -> Codex loses nothing, and the move back writes its row.
        const missed = missedBy(history, options.provider)
        const owed = { from: this.agents.get(prior)?.name ?? 'DSH', missed: true }
        const blocks = missed === undefined ? [] : replayOf(missed, owed)
        if (blocks.length > 1) {
          if (prior !== undefined && prior !== options.provider) this.appendBoundary(dshAgent, agent, options.provider)
          live.owed = owed
          live.replay = blocks
          replaySource = missed
        }
      }
      // A preset or level change since the last turn: the bridge serves the new set, and an
      // agent that ignores `tools/list_changed` gets the list through a fork instead.
      if (live.bridge !== undefined) {
        const changed = this.backchannel.refresh(live.bridge)
        if (changed && agent.refresh === 'fork') {
          if (live.sessionFileMode) {
            this.endSession(sessionId)
            return yield* stopped('The image session ended when its tools changed. Ask for image permission again.')
          }
          // A fork of an OFF Codex reads the catalog its spawn checked: written back first when
          // it is missing or changed.
          if (codexRow && live.nativeOff === true) {
            try { ensureCatalog(live.offCatalog) } catch {
              this.endSession(sessionId)
              return yield finish('error', offText('the checked model catalog could not be written'), NATIVE_OFF_UNAVAILABLE)
            }
          }
          try {
            if (startChanged()) return yield* stopChanged()
            const refusal = accountRefused()
            if (refusal !== undefined) return yield refusal
            await this.refork(agent, live, dshAgent, options.signal, { checkAccount: checkReforkAccount })
          } catch (error) {
            if (archived()) return yield finish('stop')
            if (live.held !== undefined) return yield* stopped(live.held)
            if (startChanged()) return yield* stopChanged()
            const left = this.unanswered(agent, error, 'refreshing its DSH tools')
            if (left !== undefined) return yield left
            return yield finish('error', `${agent.name} would not refresh its DSH tools: ${error?.message ?? error}`, error?.code === 'acp_bridge_missing' ? 'acp_bridge_missing' : undefined)
          }
          if (archived()) return yield finish('stop')
          if (startChanged()) return yield* stopChanged()
          reforked = true
          const refused = reforkRefusal()
          if (refused !== undefined) return yield refused
        }
      }
      // A refused model can leave the run alive with no prompt yet. Revalidate when its
      // eventual first prompt is ready, too. AgentRun sets promptEnded during its first prompt.
      // A Codex process on a kept model holds its own tools by that rule, not by the switch.
      if (archived()) return yield finish('stop')
      const firstNativePrompt = (options.provider === 'acp-claude' || codexRow) && live.native === true
        && live.nativeKept !== true && live.run.promptEnded === undefined
      const startingNative = firstNativePrompt && live.nativeManaged === true
      // A plain omp child may have launched before the Bot team registered.
      const startingOmp = omp && live.nativeOff !== true && live.run.promptEnded === undefined
      const stopForNativeChange = () => {
        if (startingOmp) {
          this.endSession(sessionId, NATIVE_TOOLS_CHANGED_TEXT, options.provider,
            candidate => candidate === entry || candidate === live)
        } else this.endSession(sessionId, NATIVE_TOOLS_CHANGED_TEXT, options.provider)
        return stopped(NATIVE_TOOLS_CHANGED_TEXT)
      }
      // The Session's model and effort, then its level as the agent's own permission mode, before every prompt.
      let substitution
      const claudePin = agent.concreteClaude ? pinOf(options.model) : undefined
      const pin = claudePin?.id === options.model ? claudePin : undefined
      const wire = pin && pinWire(valuesOf(live.run.option('model')), pin)
      live.run.modelProof = undefined
      const standIns = (agent.catalog?.spec?.fallback ?? []).map(entry => entry.id).filter(id => id !== DEFAULT_MODEL)
      try {
        if (pin && !wire) throw new Error(`the pinned ${pin.family} model is not offered`)
        substitution = await choose(
          live.run, options.model, options.reasoningEffort,
          id => agent.catalog?.ownEffort(id),
          { signal: options.signal, standIns, bindModel: true, pin: pin?.id, wire },
        )
      } catch (error) {
        if (archived()) return yield finish('stop')
        if (live.held !== undefined) return yield* stopped(live.held)
        if (startChanged()) return yield* stopChanged()
        const refused = reforkRefusal()
        if (refused !== undefined) return yield refused
        const left = this.abandoned(sessionId, live, agent, error, `taking ${options.model}`)
        if (left !== undefined) return yield left
        const at = options.reasoningEffort ? ` at ${options.reasoningEffort} effort` : ''
        const reason = error?.message ?? error
        const why = `${agent.name} would not take ${options.model}${at}: ${reason}`
        return yield finish('error', why)
      }
      if (archived()) return yield finish('stop')
      if (startChanged()) return yield* stopChanged()
      let refused = reforkRefusal()
      if (refused !== undefined) return yield refused
      // The model now on a Codex process decides which launch it needed. Every branch that ends
      // here sends no prompt.
      if (codexRow) {
        const value = live.run.option('model')?.currentValue
        const slug = modelPart(value)
        const restart = () => {
          if (typeof value === 'string') this.startModels.set(agent, value)
          this.endSession(sessionId, undefined, options.provider)
          return stopped(NATIVE_TOOLS_CHANGED_TEXT)
        }
        // OFF on a kept model (a stale `default`): the next turn launches it as today.
        if (live.nativeOff === true && this.keptSlug(agent, slug)) return yield* restart()
        // OFF on a model its spawn did not check: never prompted (LQ1).
        if (live.nativeOff === true && !live.checkedModels?.includes(slug)) {
          this.endSession(sessionId, undefined, options.provider)
          return yield finish('error', offText('this model was not checked'), NATIVE_OFF_UNAVAILABLE)
        }
        // Launched as kept, now on a checked model, with a Bot team: its own tools on a turn that
        // must be OFF (a stale `default` the other way): at worst one more "send again" on a stale
        // `default`, and it fails closed. The next turn opens by the usual rule.
        if (live.nativeKept === true && !this.keptSlug(agent, slug) && this.teamManaged()
          && !(permitsNative(levelAtStart())
            && this.nativeOn(agent, sessionId, options.provider))) {
          return yield* restart()
        }
        live.nativeKept = this.keptSlug(agent, slug)
      }
      const checkLevel = startingNative || ((firstNativePrompt || startingOmp) && this.teamManaged())
      const level = checkLevel ? this.readLevel(dshAgent?.session, true)
        : levelOf(this.ctx.get?.('approval'), dshAgent?.session, this.ctx.get?.('sandboxPolicy'), this.ctx.get?.('permissionPresets'))
      if (level === undefined) return yield* stopForNativeChange()
      const originalModes = agent.modeFor?.(level)
      const profiles = live.profileModes
      // An OFF Codex is put in its own read-only mode before every prompt (a fork included), as a
      // backstop against its own tools only: DSH's tools run in DSH, at the Session's level.
      const offModes = codexRow && live.nativeOff === true ? (profiles ? chatProfileModes(['read-only'], profiles) : ['read-only']) : undefined
      const modes = offModes ?? (live.sessionFileMode ? [live.sessionFileMode] : profiles ? chatProfileModes(originalModes, profiles) : originalModes)
      const strict = offModes ?? (live.sessionFileMode ? [live.sessionFileMode] : profiles ? chatProfileModes([originalModes?.at(-1)], profiles) : [originalModes?.at(-1)])
      const possible = offModes === undefined && agent.ownMode !== undefined && level.sandbox === 'workspace-write' && level.policy === 'ask' && !level.full && !level.auto
      const candidate = possible && live.run.modes?.availableModes?.some(mode => mode.id === agent.ownMode)
      let own = 'none'
      if (candidate) {
        own = await this.ownAnswer(sessionId, dshAgent, options.provider)
        if (archived()) return yield finish('stop')
        if (live.held !== undefined) return yield* stopped(live.held)
        if (startChanged()) return yield* stopChanged()
        refused = reforkRefusal()
        if (refused !== undefined) return yield refused
        if (own === 'yes' && live.sessionFileEnabled) {
          this.endSession(sessionId)
          return yield finish('error', 'The effective permission mode changed. Send a new message to continue.')
        }
        if (own === 'yes') {
          live.ownSent = true
          try { await live.run.setMode([agent.ownMode], { signal: options.signal }) } catch (error) {
            if (archived()) return yield finish('stop')
            if (live.held !== undefined) return yield* stopped(live.held)
            if (startChanged()) return yield* stopChanged()
            refused = reforkRefusal()
            if (refused !== undefined) return yield refused
            const left = this.abandoned(sessionId, live, agent, error, 'taking DSH\'s permission level')
            if (left !== undefined) return yield left
            own = 'refused'
          }
          if (archived()) return yield finish('stop')
          if (live.held !== undefined) return yield* stopped(live.held)
          if (startChanged()) return yield* stopChanged()
        }
      }
      try {
        if (possible && own !== 'yes') {
          if (live.ownSent === true || live.sessionFileMode) await live.run.setMode(strict, { signal: options.signal, force: true })
          else await live.run.setMode(modes, { signal: options.signal })
        } else if (!possible) await live.run.setMode(modes, { signal: options.signal, force: Boolean(live.sessionFileMode) || offModes !== undefined })
        if (archived()) return yield finish('stop')
        if (live.held !== undefined) return yield* stopped(live.held)
        if (startChanged()) return yield* stopChanged()
      } catch (error) {
        if (archived()) return yield finish('stop')
        if (live.held !== undefined) return yield* stopped(live.held)
        if (startChanged()) return yield* stopChanged()
        refused = reforkRefusal()
        if (refused !== undefined) return yield refused
        const left = this.abandoned(sessionId, live, agent, error, 'taking DSH\'s permission level')
        if (left !== undefined) return yield left
        if (live.ownSent === true || live.fileOwner) this.end(sessionId, live)
        return yield finish('error', `${agent.name} would not take DSH's permission level: ${error?.message ?? error}`)
      }
      refused = reforkRefusal()
      if (refused !== undefined) return yield refused
      const currentSkills = personCalls => skills?.project(options, { ...skillOptions, turnStart: inputStart, personCalls }) ?? options
      const beforeUploads = currentSkills()
      const uploads = uploadBlocks(
        beforeUploads.messages, this.redact, dshAgent?.session, this.ctx)
      const uploadRun = live.run
      const uploadSession = uploadRun.sessionId
      // Only the asynchronous upload path uses this stricter ownership check. Never
      // endSession on a failed check: the live map may already contain a replacement.
      const uploadValid = () => uploads === undefined || (
        !archived() && !options.signal?.aborted && entry.held === undefined && live.held === undefined &&
        this.starting.get(sessionId) === entry && this.live.get(sessionId) === live &&
        live.run === uploadRun && uploadRun.alive && uploadRun.sessionId === uploadSession &&
        live.dshAgent === dshAgent && this.ctx.agents?.get(sessionId) === dshAgent &&
        this.agents.get(options.provider) === agent &&
        uploads.roomIds.every(roomId => ownsRoomUploads(this.ctx, dshAgent?.session, roomId))
      )
      const uploadStopped = () => options.signal?.aborted ? STOPPED()
        : finish('error', entry.held ?? live.held ?? 'Uploaded image turn changed before the prompt. Send again.', 'acp_upload_content')
      let prepared
      if (uploads !== undefined) {
        const controller = new AbortController()
        entry.upload = { controller, run: uploadRun, live }
        try {
          prepared = await prepareUpload({
            blocks: uploads.blocks, replay: live.replay, run: uploadRun,
            attachments: this.ctx.get?.('attachments'), cwd: dshAgent?.session?.header?.cwd,
            warn: message => this.warn(message),
            signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
            timers: this.timers,
            valid: () => { if (!uploadValid()) throw new Error('Uploaded image turn changed before the prompt. Send again.') },
          })
        } catch (error) {
          if (archived()) return yield finish('stop')
          refused = reforkRefusal()
          if (refused !== undefined) return yield refused
          if (!uploadValid()) return yield uploadStopped()
          return yield finish('error', `Uploaded image input failed: ${error?.message ?? error}`, 'acp_upload_content')
        }
        if (archived()) return yield finish('stop')
        refused = reforkRefusal()
        if (refused !== undefined) return yield refused
        if (!uploadValid()) return yield uploadStopped()
        if (startChanged()) return yield* stopChanged()
      }
      // Asked again right before the prompt: a Session held since the first ask (while consent,
      // the start, a fork or the mode were awaited) gets no prompt. One that was ended since
      // the step's entry is refused whatever the gate says now: its mode above was read from a
      // level that has changed, and a gate that lets go here must not let this turn through.
      const alreadyHeld = entry.held ?? live.held
      const lateSessionHold = alreadyHeld === undefined ? await this.heldBack(sessionId, dshAgent, options.provider) : undefined
      const late = alreadyHeld ?? lateSessionHold ?? entry.held
      if (archived()) return yield finish('stop')
      if (lateSessionHold === undefined) {
        refused = reforkRefusal()
        if (refused !== undefined) return yield refused
      }
      if (!uploadValid()) return yield uploadStopped()
      if (late !== undefined) {
        stopOwned(late, live, {
          provider: lateSessionHold === undefined ? entry.heldByProvider : undefined,
          sessionHold: lateSessionHold !== undefined,
        })
        return yield* stopped(late)
      }
      if (startChanged()) return yield* stopChanged()
      if (own === 'yes') {
        const again = await this.ownAnswer(sessionId, dshAgent, options.provider)
        if (archived()) return yield finish('stop')
        refused = reforkRefusal()
        if (refused !== undefined) return yield refused
        if (!uploadValid()) return yield uploadStopped()
        if (live.held !== undefined) return yield* stopped(live.held)
        if (startChanged()) return yield* stopChanged()
        if (again !== 'yes') {
          own = 'changed'
          try { await live.run.setMode(strict, { signal: options.signal, force: true }) } catch (error) {
            if (archived()) return yield finish('stop')
            refused = reforkRefusal()
            if (refused !== undefined) return yield refused
            if (!uploadValid()) return yield uploadStopped()
            if (live.held !== undefined) return yield* stopped(live.held)
            if (startChanged()) return yield* stopChanged()
            const left = this.abandoned(sessionId, live, agent, error, 'taking DSH\'s permission level')
            if (left !== undefined) return yield left
            this.end(sessionId, live)
            return yield finish('error', `${agent.name} would not take DSH's permission level: ${error?.message ?? error}`)
          }
          if (archived()) return yield finish('stop')
          refused = reforkRefusal()
          if (refused !== undefined) return yield refused
          if (!uploadValid()) return yield uploadStopped()
          if (live.held !== undefined) return yield* stopped(live.held)
          if (startChanged()) return yield* stopChanged()
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
      if (fresh && !renewedForSkills && live.replay === undefined && options.messages.some(message => message.role === 'assistant')) {
        try {
          dshAgent?.session?.append?.('user/message', freshSessionNotice(agent.name), { surfaceOp: 'append' })
        } catch (error) {
          try { this.ctx.logger?.warn?.(`acp-dsh: the new-session notice was not written: ${error?.message ?? error}`) } catch {}
        }
      }
      if (live.fileOwner) {
        try {
          await this.sessionFiles.activate(live.fileOwner, last, options.signal)
          if (archived()) return yield finish('stop')
          refused = reforkRefusal()
          if (refused !== undefined) return yield refused
          if (!uploadValid()) return yield uploadStopped()
          if (startChanged()) return yield* stopChanged()
          if (!this.sessionFiles.valid(live.fileOwner) || this.live.get(sessionId) !== live ||
              (live.sessionFileMode && live.run.modes?.currentModeId !== live.sessionFileMode) || own === 'yes') throw new Error('Image permission changed before the prompt.')
        } catch (error) {
          if (archived()) return yield finish('stop')
          refused = reforkRefusal()
          if (refused !== undefined) return yield refused
          if (!uploadValid()) return yield uploadStopped()
          if (startChanged()) return yield* stopChanged()
          stopOwned(undefined, live)
          return yield finish('error', error.message)
        }
      }
      if (archived() || this.isArchived(sessionId)) return yield finish('stop')
      if (!uploadValid()) return yield uploadStopped()
      if (startChanged()) return yield* stopChanged()
      const personCalls = new WeakSet()
      const send = currentSkills(personCalls)
      const catalog = skillCatalog(live)
      if (agy && live.nativeOff === true && live.agySkillsVersion !== agySkillsWanted()) {
        return yield* this.step(options, entry)
      }
      if (live.skillCatalog !== undefined && live.skillCatalog !== catalog?.key) {
        // A catalog edit can land while the model or permission mode is being
        // set. Re-enter before sending to the session with that catalog.
        return yield* this.step(options, entry)
      }
      const replay = live.replay === undefined || replaySource === undefined ? live.replay : replayOf(replaySource, live.owed)
      if (prepared !== undefined && (!isDeepStrictEqual(send.messages, beforeUploads.messages) ||
          !isDeepStrictEqual(replay ?? [], live.replay ?? []))) return yield uploadStopped()
      const cutRows = prepared === undefined && fresh && (live.replay === undefined || live.owed?.handoff === true)
        ? cutUserRows(send.messages, dshAgent?.session) : []
      const cutIds = new Set(cutRows.map(row => row.id))
      const current = cutRows.length === 0 ? send.messages : send.messages.filter(row => !cutIds.has(row.id))
      const recovered = cutRows.length === 0 ? [] : [
        ...replayOf(cutRows, { renewed: true }),
        { type: 'text', text: 'The previous turn was interrupted. Check any tool outcomes before repeating work.' },
      ]
      const prompt = prepared ?? [...(replay ?? []), ...recovered, ...promptOf(current, this.redact)]
      if (catalog?.text && live.skillCatalog !== catalog.key) {
        if (live.bridge === undefined) return yield finish('error', 'Send this turn again.', 'acp_bridge_missing')
        const block = { type: 'text', text: this.redact(catalog.text) }
        // A prepared upload still represents these rows after the equality check
        // above. Use the checked parts in the final selection to order either prompt.
        const hasPersonCall = promptRows(current).rows.some(row =>
          Array.isArray(row.content) && row.content.some(part => personCalls.has(part)))
        if (hasPersonCall) prompt.unshift(block)
        else prompt.push(block)
      }
      if (prepared !== undefined) {
        try { checkUploadSize(uploadRun.sessionId, prompt) } catch (error) {
          return yield finish('error', error.message, 'acp_upload_content')
        }
      }
      // The first prompt is the last point where startup can lose its tool authority. The
      // permission mode, bridge and gates above can all wait after the ON process exists.
      const managedNativeNow = firstNativePrompt && this.teamManaged()
      const checkOmp = startingOmp && this.teamManaged()
      if (checkOmp || startingNative || managedNativeNow) {
        const held = entry.held ?? live.held
        if (held !== undefined) return yield* stopped(held)
        if (options.signal?.aborted) {
          this.end(sessionId, live)
          return yield STOPPED()
        }
        // Team registration during startup invalidates the standalone hidden ON grant.
        const allowed = checkOmp ? ompNativeAllowed()
          : startingNative && managedNativeNow && permitsNative(this.readLevel(dshAgent?.session, true))
            && this.nativeOn(agent, sessionId, options.provider)
        if (!allowed) return yield* stopForNativeChange()
      }
      // A kept Antigravity OFF child checks again that agy loaded its settings before each later
      // prompt (its first prompt was checked at the start): a failure ends it, nothing is sent.
      if (live.offRecheck !== undefined && live.run.promptEnded !== undefined) {
        try { live.offRecheck(live.run) } catch {
          this.end(sessionId, live)
          return yield finish('error', AGY_NOT_LOADED_TEXT)
        }
      }
      if (pin && live.run.acknowledgedModel() !== pin.id) {
        return yield finish('error', `${agent.name} did not acknowledge the pinned ${pin.family} model.`)
      }
      if (agy && live.nativeOff === true && live.agySkillsVersion === undefined &&
          skills?.available(sessionId) === true && agent.agySkillsVersion?.() === undefined) {
        skills.noticeAgyUnavailable?.(session)
      }
      if (startChanged() || live.held !== undefined || this.live.get(sessionId) !== live || options.signal?.aborted
          || launchEligible?.() === false) return yield* stopChanged()
      const promptRefusal = firstPromptRefusal()
      if (promptRefusal !== undefined) return yield promptRefusal
      started()
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
      live.confinedReason = undefined
      live.toolIds?.clear()
      live.skillCatalog = catalog?.text ? catalog.key : undefined
      live.run.prompt(prompt, () => skills?.admit({ ...send, messages: promptRows(current).rows }, session)).catch(() => {})
      // The notice belongs to this prompt, including any step after a mirror result.
      if (substitution !== undefined) live.substitution = { ...substitution, signal: options.signal }
    }
    // The turn stays open until its end is drained here: the agent may finish it before DSH
    // asks for the step after a tool result.
    for (;;) {
      const event = await live.run.next(options.signal)
      if (archived()) {
        yield* blocks.close()
        return yield finish('stop')
      }
      // Its agent session was ended under it (endSession): whatever came is not shown.
      if (live.held !== undefined) {
        yield* shown()
        return yield* stopped(live.held)
      }
      // The prompt is over (finished, failed or stopped): nobody waits for a DSH tool call the
      // bridge still has in flight, so each is stopped; the bridge itself stays for the next turn.
      let substitution
      if (event.type === 'end' || event.type === 'error' || event.type === 'aborted') {
        live.open = false
        substitution = live.substitution
        live.substitution = undefined
        this.backchannel?.cancel?.(live.bridge, event.type === 'aborted' ? 'the turn was stopped' : 'the turn ended')
      }
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
        // A subagent's nested call at Auto already ran through the pipeline inside its Agent
        // card's step: its card is written, so this queued update is not a second one.
        if (tool.cardExecuted !== undefined) continue
        if (live.run.refuseUnavailableSkill(tool)) continue
        // A DSH tool call is not a mirror call: the bridge writes its rows and DSH draws the one
        // card from them. On `acp-codex` no structured name is proven, so any MCP call there is
        // left to the bridge too; its own tools keep their cards.
        // `ToolSearch` is the adapter's own deferred-tool loader (it stays with `tools: []`); it
        // is not a DSH tool and gets no card or dialog either.
        const skip = tool.skillBridge === true || (live.bridge?.skillOnly !== true && (
          tool.drift === true || tool.structuredName === 'ToolSearch'
          || (!tool.skillConflict && (tool.bridge === true || (agent.refresh === 'fork' && tool.mcp === true)))))
        if (live.bridge !== undefined && skip) {
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
        if (live.run.refuseUnavailableSkill(tool)) continue
        if (archived()) {
          yield* blocks.close()
          return yield finish('stop')
        }
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
        const reviewerStopped = wasOwn && r?.denied > 0 && (r.inRow >= 3 || r.denied >= 10 || (r.last === 'denied' && !r.after))
        if (reviewerStopped) {
          try { dshAgent?.session?.append?.('user/message', reviewerStopNotice(agent.name, r.denied), { surfaceOp: 'append' }) } catch (error) {
            try { this.ctx.logger?.warn?.(`acp-dsh: the reviewer notice was not written: ${error?.message ?? error}`) } catch {}
          }
        }
        yield* shown()
        yield* blocks.close()
        if (Object.hasOwn(STOP_LINE, event.stopReason)) {
          yield* blocks.add('text', shownText(STOP_LINE[event.stopReason](agent.name)))
          yield* blocks.close()
        }
        // A queued end can reach a continuation after its Stop.
        if (substitution !== undefined && this.live.get(sessionId) === live && Object.hasOwn(FINISH, event.stopReason)
            && !options.signal?.aborted && !substitution.signal?.aborted && !live.run.cancelled && !this.hostStopping()) {
          const { model } = substitution
          try { this.ctx.logger?.info?.(`acp-dsh: ${options.provider}: ${model} is not offered; ran on the agent's own model`) } catch {}
          yield* blocks.add('text', shownText(STAND_IN_LINE(agent.name, model)))
          yield* blocks.close()
        }
        if (reviewerStopped) return yield finish('stop')
        // A cancel the app did not ask for (the turn's Stop would have aborted the signal) while
        // the host itself is stopping came from outside: its SIGTERM reached the agent, which
        // answered with `cancelled`. That is an interruption, not the person's Stop, and not a
        // model failure: the Bot team resumes the work after the restart.
        if (event.stopReason === 'cancelled' && options.signal?.aborted !== true
            && live.run.cancelled !== true && this.hostStopping()) {
          return yield finish('error', `${agent.name} was interrupted before it finished.`, AGENT_INTERRUPTED)
        }
        if (event.stopReason === 'cancelled' && typeof live.confinedReason === 'string'
            && options.signal?.aborted !== true && live.run.cancelled !== true) {
          const reason = live.confinedReason
          live.confinedReason = undefined
          yield* blocks.add('text', shownText(`[${reason}]`))
          yield* blocks.close()
          return yield finish('stop')
        }
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
        // The agent process took the host's SIGTERM while its prompt was in flight: the work
        // was cut while running, so it is reported as an interruption rather than a failure.
        if (options.signal?.aborted !== true && live.run.cancelled !== true
            && (this.hostStopping() || live.run.exited?.signal === 'SIGTERM' || live.run.exited?.signal === 'SIGINT')) {
          return yield finish('error', `${agent.name}: ${event.message}`, AGENT_INTERRUPTED)
        }
        if (event.usageLimit === true && Object.hasOwn(ACP_USAGE_LIMIT_CODES, options.provider)) {
          return yield finish('error', `${agent.name}: ${event.message}`, ACP_USAGE_LIMIT_CODES[options.provider])
        }
        return yield finish('error', `${agent.name}: ${event.message}`)
      } else if (event.type === 'aborted') {
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
    try { this.offArchived?.() } catch {}
    this.offArchived = undefined
    try { this.offResult?.() } catch {}
    try { this.offReviewed?.() } catch {}
    try { this.offSessionDisposed?.() } catch {}
    this.offSessionDisposed = undefined
    for (const entry of this.starting.values()) {
      entry.held ??= HELD_TEXT
      entry.upload?.controller.abort()
    }
    this.starting.clear()
    this.roleTurns.clear()
    for (const id of this.sessionFiles.owners.keys()) this.sessionFiles.clear(id)
    for (const agent of this.agents.values()) agent.catalog?.dispose()
    for (const [sessionId, live] of this.live) this.end(sessionId, live)
  }
}

export function reviewerStopNotice(name, n) {
  const summary = `${name} stopped after its own reviewer refused ${n === 1 ? 'a step' : `${n} steps`}. Reply to let it go on; refused steps stay refused`
  return createUserMessage({ content: [{ type: 'text', text: `[${summary}.]` }], source: { kind: NOTICE_KIND, form: 'notice', stop: 'refusals', summary } })
}
