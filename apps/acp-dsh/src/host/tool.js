// The mirror tool. An ACP agent runs its own tools; DSH should still show each one as its own
// tool card and ask through its own approval dialog. So the adapter ends the model step at the
// agent's tool call with a call to this tool, registered in that agent's scope only. DSH writes
// the tool/call and tool/result rows itself, as for any tool. The body runs nothing: it waits
// for the agent's call to finish, and when the agent asks permission for it, asks DSH's
// approval service and hands the agent the answer.
import { isDeepStrictEqual } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { contentImages, contentText, isTerminal } from './acp.js'
import { agentImageOf, isImageCall, isPng, KEPT_TEXT } from './agent-image.js'
import { openStepOf } from './backchannel.js'
import { terminalResult } from './terminal-evidence.js'

export const TOOL_NAME = 'acp_tool'
const DSH_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])
const kindOf = kind => (DSH_KINDS.has(kind) ? kind : 'other')
const OUTPUT_LIMIT = 20_000
const LASTING_ONLY = 'lasting-only'
const CONFINED = 'confined'

const diffsOf = content => (Array.isArray(content) ? content : [])
  .filter(item => item?.type === 'diff' && typeof item.path === 'string')
  .map(item => ({ path: item.path, oldText: item.oldText ?? null, newText: item.newText ?? '' }))

const commandOf = (input) => {
  const command = input?.command ?? input?.cmd
  if (Array.isArray(command)) return command.join(' ')
  return typeof command === 'string' ? command : undefined
}

/** The arguments the adapter writes for one of the agent's calls, as it first shows it. */
export function callArguments(tool) {
  const diffs = diffsOf(tool.content)
  return {
    id: tool.id,
    title: tool.title,
    kind: tool.kind,
    input: tool.rawInput ?? null,
    ...(tool.locations?.length ? { locations: tool.locations.map(at => ({ path: at.path, ...(at.line == null ? {} : { line: at.line }) })) } : {}),
    ...(diffs.length ? { diffs } : {}),
    // An image being made: the chat draws its image card from the first sight of the call.
    ...(isImageCall(tool) ? { image: true } : {}),
    // A native subagent's call: the agent's id of the Agent/Task call it ran inside, so the
    // card's own row says which worker it belongs to.
    ...(typeof tool.parent === 'string' ? { parent: tool.parent } : {}),
  }
}

// The text of a call Auto's judge refused (bots-dsh auto-judge.js): it names the judge, never the person.
const judgedText = tool => `Auto's judge refused ${tool.title}: ${tool.judgeReason}.`.replace(/\s+/g, ' ').slice(0, 300)

function resultText(tool) {
  if (tool.sessionFileResult !== undefined) return tool.sessionFileResult
  if (tool.confinedReason !== undefined) return tool.confinedReason
  if (tool.lastingReason !== undefined) return tool.lastingReason
  if (tool.refusedReason !== undefined) return tool.refusedReason
  if (typeof tool.judgeReason === 'string') return judgedText(tool)
  const text = contentText(tool.content) || tool.output || (tool.rawOutput === undefined ? '' : typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput))
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text
}

// The image blocks of an agent's call as DSH image content. DSH keeps an image in a tool result
// as a durable attachment (`{ type: 'image', attachment }`), never inline base64, so the bytes
// are stored once through the attachment service and the result carries the reference a chat and
// a replay can show. A block that already has an attachment is passed through; with no store (or
// an image the store refuses) the call keeps its text result, as it did before.
async function resultImages(tool, attachments) {
  const blocks = []
  for (const image of contentImages(tool.content)) {
    if (image.attachment !== undefined) {
      blocks.push({ type: 'image', attachment: image.attachment, ...(image.offloaded === true ? { offloaded: true } : {}) })
      continue
    }
    if (typeof image.data !== 'string' || image.data === '' || typeof attachments?.saveImage !== 'function') continue
    const mediaType = image.mimeType ?? image.mediaType
    if (mediaType === undefined) continue
    try {
      const ref = await attachments.saveImage({ data: Buffer.from(image.data, 'base64'), mediaType })
      blocks.push({ type: 'image', attachment: ref })
    } catch {
      // An image the store refuses (not an image, too large) leaves the text result as it was.
    }
  }
  return blocks
}

async function resultOf(tool, attachments) {
  const diffs = diffsOf(tool.content)
  const images = await resultImages(tool, attachments)
  return {
    title: tool.title,
    kind: tool.kind,
    status: tool.confinedReason !== undefined ? 'failed' : tool.status,
    text: resultText(tool),
    ...(diffs.length ? { diffs } : {}),
    ...(images.length ? { images } : {}),
  }
}

// DSH's one-shot answer, as the option the agent offered for it.
export function optionFor(outcome, options) {
  const pick = kinds => kinds.map(kind => options.find(option => option.kind === kind)).find(Boolean)
  let chosen
  if (outcome === 'allowed-once') chosen = pick(['allow_once'])
  if (outcome === 'rejected') chosen = pick(['reject_once', 'reject_always'])
  if (outcome === LASTING_ONLY || outcome === CONFINED) chosen = pick(['reject_once'])
  return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } }
}

// The answer of a call that makes an image: the PNG from the call's own update goes to the
// chat's image keeper (agent-image.js), and the result names the kept file, never the agent's
// own saved path or the image's bytes.
async function imageResult(host, live, tool, exec) {
  const keeper = host.images?.()
  const callId = exec.callId
  const sessionId = exec.agent?.session?.id
  const base = { title: tool.title, kind: tool.kind, status: tool.status }
  const failed = (text) => {
    try { keeper?.fail?.({ callId, sessionId, error: text }) } catch {}
    return { ...base, status: 'failed', text }
  }
  if (exec.signal?.aborted) return failed('The image was stopped before it was finished.')
  const base64 = agentImageOf(tool)
  if (base64 === undefined) {
    return failed(tool.confinedReason ?? tool.lastingReason ?? tool.refusedReason ?? (typeof tool.judgeReason === 'string' ? judgedText(tool) : tool.status === 'failed'
      ? `${live.name} could not make this image. Try again, or describe it differently.`
      : `${live.name} ended without an image. Try again.`))
  }
  if (!isPng(base64)) return failed(`${live.name} answered with something that is not a PNG image. Try again.`)
  if (keeper === undefined || typeof keeper.keep !== 'function') return failed('The image was made, but this chat has no place to keep it.')
  try {
    const kept = await keeper.keep({ callId, sessionId, base64, mimeType: 'image/png', via: live.name })
    if (typeof kept?.file !== 'string' || kept.file === '') return failed('The image could not be kept. Try again.')
    return { ...base, status: 'completed', text: `${KEPT_TEXT} ${kept.file}. It is on screen in the chat, so do not describe it back.` }
  } catch (error) {
    return failed(`The image could not be kept: ${String(error?.message ?? error).slice(0, 200)}`)
  }
}

// `run`: also wake on a question stored for any other call of that run (native-tools mode).
const changed = (tool, signal, run) => new Promise((resolve) => {
  const done = () => {
    tool.listeners.delete(done)
    run?.askListeners?.delete(done)
    signal?.removeEventListener('abort', done)
    resolve()
  }
  tool.listeners.add(done)
  run?.askListeners?.add(done)
  signal?.addEventListener('abort', done, { once: true })
})

// Native-tools mode (#1564): while this card waits for its call to end, the agent can ask about
// another call whose card cannot come before this one ends. That is a subagent's nested call
// (Claude Code's Agent tool waits for its child, the child waits for the answer): its question
// is asked here, through DSH's approval, naming that call, so it is never left unanswered and
// a refusal reaches the agent before the call runs. Its own card follows, already answered.
const nestedQuestion = (live, tool) => {
  if (live?.native !== true) return undefined
  for (const other of live.run.tools.values()) {
    if (other === tool || other.retired === true || other.mirrored === true || other.unanswerable === true) continue
    if (other.permission !== undefined && other.permission.asked !== true) return other
  }
  return undefined
}

// The executions whose mirror body started. DSH hands one `exec` object to its gates, to the body
// and to `tools/result`, so the adapter can tell a call that was refused before the body (and
// whose question from the agent nobody will answer here) from one this body is answering.
export const entered = new WeakSet()

// The executions Auto review let through, with the level when the gate passed. Only the
// adapter's reviewedGate sets a record; the body's first answer takes it.
export const reviewed = new WeakMap()

/**
 * `images()` is the chat's image keeper (acpAgents.keepImages), or undefined. `attachments()` is
 * DSH's attachment store, where an image a call answers with is kept, or undefined.
 * @param {{ runOf(sessionId: string): { run: import('./acp.js').AgentRun, name: string } | undefined, approval(): any, sandboxPolicy?(): any, permissionPresets?(): any, images?(): { start?(call: object): void, keep(image: object): Promise<{ file: string }>, fail?(call: object): void } | undefined, attachments?(): { saveImage?(input: { data: Buffer, mediaType: string }): Promise<any> } | undefined }} host
 */
export function mirrorTool(host) {
  return defineTool({
    name: TOOL_NAME,
    description: 'A tool call the ACP agent made with its own tools. Only the agent calls it; it shows the call and asks for approval when the agent needs it.',
    parameters: {
      id: { type: 'string', required: true, description: "The agent's own id for the call." },
      title: { type: 'string', required: true },
      kind: { type: 'string', required: true },
      input: { type: 'json' },
      locations: { type: 'json' },
      diffs: { type: 'json' },
      image: { type: 'boolean' },
      parent: { type: 'string', description: "The agent's id of the subagent call this call ran inside." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          status: { type: 'string', required: true },
          text: { type: 'string', required: true },
          diffs: { type: 'json' },
          images: { type: 'json' },
          terminalOutcome: { type: 'json' },
          terminalStart: { type: 'json' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.text || `${value.title}: ${value.status}` },
        ...(Array.isArray(value.images) ? value.images : []),
      ],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      entered.add(exec)
      const position = openStepOf(exec.agent?.session)
      const live = host.runOf(exec.agent?.session?.id)
      const tool = live?.run.tools.get(args.id)
      if (!tool || tool.retired === true) return { title: args.title, kind: args.kind, status: 'failed', text: 'The agent is no longer running this call.' }
      // The card follows an image being made from its start (the keeper's progress).
      if (isImageCall(tool)) {
        try { host.images?.()?.start?.({ callId: exec.callId, sessionId: exec.agent?.session?.id, via: live.name }) } catch {}
      }
      live.mirrorBodies = (live.mirrorBodies ?? 0) + 1
      try {
        try {
          for (;;) {
            if (exec.signal?.aborted) {
              tool.permission?.answer({ outcome: { outcome: 'cancelled' } })
              // The agent may ignore the cancel: the host gives its prompt a bounded time to end.
              host.cancelled?.(exec.agent?.session?.id, live)
              await live.run.cancel()
              break
            }
            const permission = tool.permission
            if (permission && !permission.asked) {
              permission.asked = true
              if (live.sessionFileEnabled && permission.call?.structuredName === 'request_permissions') {
                try { tool.sessionFileResult = await host.sessionFiles?.(live, tool, exec, permission) } catch {
                  tool.sessionFileResult = 'The image was not approved for this chat session.'
                }
                permission.answer({ outcome: { outcome: 'cancelled' } })
                break
              }
              permission.answer(optionFor(await ask(host, live, tool, exec, permission), permission.options))
              continue
            }
            if (isTerminal(tool) || !live.run.busy) break
            const nested = nestedQuestion(live, tool)
            if (nested !== undefined) {
              const question = nested.permission
              // Auto review reads a call from its own DSH execution. A nested call asked from
              // the waiting Agent card has none yet, so at Auto run its own card here, inside
              // the open step: the reviewer answers it like any call, and only an escalation
              // reaches the person. Manual and Full keep the direct dialog below.
              const level = levelOf(host.approval(), exec.agent?.session, host.sandboxPolicy?.(), host.permissionPresets?.())
              if (level.auto === true && typeof host.runNested === 'function'
                && await host.runNested(live, nested, exec)) continue
              question.asked = true
              question.answer(optionFor(await ask(host, live, nested, exec, question, { review: false }), question.options))
              continue
            }
            await changed(tool, exec.signal, live.native === true ? live.run : undefined)
          }
        } finally {
          // The card's body is done asking, however it left: a question that comes for the call
          // now has nobody to ask it, and the agent's run answers it as cancelled (acp.js
          // onPermission). One still stored when the body failed is withdrawn the same way.
          tool.mirrored = true
          tool.permission?.answer({ outcome: { outcome: 'cancelled' } })
        }
        if (!exec.signal?.aborted && isTerminal(tool)) {
          try {
            await host.bridgeApprovals?.(exec.agent?.session?.id, position, exec.signal)
          } catch {}
          if (exec.signal?.aborted) {
            tool.permission?.answer({ outcome: { outcome: 'cancelled' } })
            host.cancelled?.(exec.agent?.session?.id, live)
            await live.run.cancel()
          }
        }
        // Only an image-generation call is answered as a kept image; any other call that answers
        // with an image (a Read, a screenshot) keeps its own result, image blocks included.
        if (isImageCall(tool)) return await imageResult(host, live, tool, exec)
        const result = await resultOf(tool, host.attachments?.())
        if (tool.kind === 'execute') Object.assign(result, terminalResult(live, tool, args, exec))
        return result
      } finally { live.mirrorBodies -= 1 }
    },
    presentCall(args) {
      const title = typeof args?.title === 'string' ? args.title : 'Tool'
      if (Array.isArray(args?.diffs) && args.diffs.length > 0) return { card: 'diff', title, diffs: args.diffs, ...(args.locations ? { locations: args.locations } : {}) }
      const command = commandOf(args?.input)
      if (args?.kind === 'execute') return { card: 'terminal', title, ...(command ? { description: command } : {}) }
      return { card: 'generic', title, kind: kindOf(args?.kind), ...(args?.input == null ? {} : { rawInput: args.input }), ...(Array.isArray(args?.locations) ? { locations: args.locations } : {}) }
    },
    presentResult(args, result) {
      const meta = result?.meta && typeof result.meta === 'object' ? result.meta : undefined
      const title = meta?.title ?? args?.title
      if (Array.isArray(meta?.diffs) && meta.diffs.length > 0) return { card: 'diff', title, diffs: meta.diffs }
      if ((meta?.kind ?? args?.kind) === 'execute') return { card: 'terminal', title, output: meta?.text ?? contentText(result?.content) }
      return { card: 'generic', title, content: result?.content ?? [] }
    },
  })
}

// The sandbox mode the Session runs in, as DSH's own tools get it: the sandbox-policy service
// folds the Session's last sandbox/mode row over the deployment default (DSH_PERMISSION_MODE).
// Without the service, the Session's last row.
function sandboxOf(session, sandboxPolicy) {
  const mode = sandboxPolicy?.resolve?.({ session })?.mode
  if (typeof mode === 'string') return mode
  const events = session?.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'sandbox/mode') return events[i].data?.mode
  return undefined
}

// The Session's stored permission preset, from its own log: the identity the permission service
// folds, including Auto under a delegated child's `never` approval.
function presetOf(session) {
  const events = session?.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'permission/preset') return events[i].data?.preset
  }
  return undefined
}

/** The Session's level: its sandbox mode, its approval policy, and whether that is full access. */
export function levelOf(approval, session, sandboxPolicy, permissionPresets, { failClosed = false } = {}) {
  let policy
  let sandbox
  let preset
  try {
    policy = approval?.effectivePolicy?.(session)
    sandbox = sandboxOf(session, sandboxPolicy)
    preset = permissionPresets?.current?.(session)
  } catch {
    if (failClosed) return undefined
  }
  // Auto is the identity the review gate reads (dsh-experimental-auto-review checks
  // `permissionPresets.current(session) !== AUTO_PRESET`), never the knob bundle: a custom
  // preset with Auto's `ask` + `danger-full-access` has no reviewer, so the bridge must keep its
  // own ask. Without the permission-preset service no identity exists (and no Auto gate can be
  // installed), so the Session's Auto row may only stop it reading Full — it cannot claim Auto.
  if (preset === undefined) {
    const auto = presetOf(session) === 'auto'
    const full = !auto && policy === 'never' && sandbox === 'danger-full-access'
    return { sandbox, policy, full, auto: false }
  }
  // DSH's real presets (dsh-permission-presets): Full access is `never` with no sandbox, Manual
  // is the stock `ask` + workspace-write. A Session's Auto row wins over the effective policy:
  // dsh-subagent pins a child to `never` so its reviewer's denials stay final, and reading only
  // that policy would report the child as full access, bypassing the Auto review the row
  // promises.
  if (preset === 'auto') return { sandbox, policy, full: false, auto: true }
  return {
    sandbox,
    policy,
    full: policy === 'never' && sandbox === 'danger-full-access',
    auto: false,
  }
}

// Full access (no approval prompts, no sandbox) lets the agent's calls through as it lets DSH's
// own: DSH's approval service would reject them unasked under its `never` policy.
export const fullAccess = (approval, session, sandboxPolicy, permissionPresets) => levelOf(approval, session, sandboxPolicy, permissionPresets).full

// The rows backchannel.js's LEVEL_EVENTS watches: any one after the call invalidates its review.
const LEVEL_ROWS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])

// The arguments Auto review read from this call's own logged row, parsed as parseLoggedArguments
// does there. A level change since that row, even back to Auto, leaves no reviewed call.
function reviewedArguments(session, callId) {
  const events = session?.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (LEVEL_ROWS.has(event?.type)) return undefined
    if (event?.type === 'tool/call' && event.data?.callId === callId) {
      const raw = event.data.arguments
      if (raw === '') return {}
      try { return JSON.parse(raw) } catch { return raw }
    }
  }
  return undefined
}

function reviewHolds(host, live, tool, exec, permission, record) {
  if (record === undefined || tool.parentConflict === true) return false
  if (!permission.options.some(option => option.kind === 'allow_once')) return false
  if (live?.calls?.has(exec.callId) !== true || live.toolIds?.get(exec.callId) !== tool.id) return false
  const level = levelOf(host.approval(), exec.agent?.session, host.sandboxPolicy?.(), host.permissionPresets?.())
  if (level.auto !== true || level.policy !== record.policy || level.sandbox !== record.sandbox) return false
  const args = reviewedArguments(exec.agent.session, exec.callId)
  if (args === null || typeof args !== 'object' || Object.getPrototypeOf(args) !== Object.prototype || permission.call === undefined) return false
  const { parent: rowParent, ...reviewedCall } = args
  if (Object.hasOwn(args, 'parent') && typeof rowParent !== 'string') return false
  const { parent: questionParent, ...questionCall } = callArguments(permission.call)
  const { parent: liveParent, ...liveCall } = callArguments(tool)
  // Claude ACP can send the stamp later. It says which worker the call belongs to.
  // Any conflicting stamp invalidates the review.
  const parents = new Set([rowParent, questionParent, liveParent].filter(parent => typeof parent === 'string'))
  if (parents.size > 1) return false
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(questionCall)), reviewedCall)) return false
  return isDeepStrictEqual(JSON.parse(JSON.stringify(liveCall)), reviewedCall)
}

// `review: false` (a nested call's question, asked from another call's card): the Auto review
// record of this execution belongs to that card's own call and is left for it.
async function ask(host, live, tool, exec, permission, { review = true } = {}) {
  const record = review ? reviewed.get(exec) : undefined
  if (review) reviewed.delete(exec)
  tool.confinedReason = undefined
  tool.lastingReason = undefined
  tool.refusedReason = undefined
  const options = permission?.options ?? []
  const mode = live.run?.modes?.currentModeId
  const call = permission?.call
  const rawInput = call?.rawInput ?? tool.rawInput
  const network = typeof permission?.title === 'string'
    && /^(?:https?|socks5(?:tcp|udp)) network access to \S/i.test(permission.title)
  // Codex keeps the managed profile's deny rule even after approving a command escalation.
  // codex-acp's standard renderer uses execute/pending for both new commands and write_stdin approvals.
  if (typeof mode === 'string' && /^permission-profile:automagik-(?:read|workspace|image)-[0-9a-f]{32}$/.test(mode)
    && permission?.startsCommand === true
    && tool.mcp !== true && !network
    && rawInput !== null && typeof rawInput === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(rawInput))
    && Object.hasOwn(rawInput, 'command') && typeof rawInput.command === 'string' && rawInput.command.trim() !== ''
    && Reflect.ownKeys(rawInput).every(key => key === 'command' || key === 'cwd')
    && options.some(option => option.kind === 'allow_once' || option.kind === 'allow_always')) {
    tool.confinedReason = `${live.name} runs inside its own folder at this Bot's level, so an approval cannot run ${tool.title} outside it. Raise the Bot's level to Full access to run it.`.replace(/\s+/g, ' ').slice(0, 300)
    live.confinedReason = tool.confinedReason
    return CONFINED
  }
  const lasting = options.find(option => option.kind === 'allow_always')
  if (lasting !== undefined && !options.some(option => option.kind === 'allow_once')) {
    // A one-time yes is never sent as the agent's lasting allow (#1718): refuse with no dialog
    // and say why in the call's result.
    const name = typeof lasting.name === 'string' ? lasting.name.trim() : ''
    tool.lastingReason = `${live.name} offered to allow ${tool.title} only from now on${name ? ` ("${name}")` : ''}, not just once, so Automagik did not approve it.`.replace(/\s+/g, ' ').slice(0, 300)
    return LASTING_ONLY
  }
  const approval = host.approval()
  if (!approval || !exec.agent) return 'unavailable'
  if (fullAccess(approval, exec.agent.session, host.sandboxPolicy?.(), host.permissionPresets?.())) return 'allowed-once'
  // At Auto, the reviewer (or the person in its denial dialog) already answered for this
  // execution. That answer covers only the first question, at the same level, about the call
  // the reviewer read: both the question's snapshot and the call now must match its logged
  // arguments. The body's args can have been replaced after review. Never make a standing
  // allow_always rule from this answer; a missing proof or a throw asks as before.
  try { if (reviewHolds(host, live, tool, exec, permission, record)) return 'allowed-once' } catch {}
  const asking = tool.permission?.title
  const reason = `${live.name}: ${asking && asking !== tool.title ? `${asking.replace(/\?$/, '')}: ` : ''}${tool.title}`
  let mirrorCall
  try {
    const { id, title, kind, input, locations } = callArguments(tool)
    // Plain JSON: DSH passes an approval nobody here answers on to its remote approval card only as lossless JSON (dsh-api-gateway
    // projectRemoteEventRequest), and a member left undefined (`locations` of a call that has none) fails that dispatch: the call
    // would be cancelled with no card.
    mirrorCall = JSON.parse(JSON.stringify({ id, title, kind, input, locations, allowOnce: tool.permission?.options?.some(option => option.kind === 'allow_once') === true }))
  } catch {
    // Unreadable call details leave the question for the person.
  }
  try {
    const callId = review ? exec.callId : `${exec.callId}:child:${tool.id}`
    const outcome = await approval.request({ agent: exec.agent, toolName: TOOL_NAME, callId, reason, displayReason: { en: reason }, signal: exec.signal, ...(mirrorCall === undefined ? {} : { mirrorCall }) })
    // Auto's judge refused it (bots-dsh auto-judge.js sets `mirrorCall.judged`): the call's result says so (section 4).
    tool.refusedReason = outcome === 'rejected' && typeof mirrorCall?.refused?.reason === 'string' ? mirrorCall.refused.reason : undefined
    tool.judgeReason = outcome === 'rejected' && typeof mirrorCall?.judged?.reason === 'string' ? mirrorCall.judged.reason : undefined
    return outcome
  } catch {
    return 'unavailable'
  }
}
