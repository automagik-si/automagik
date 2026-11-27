import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRun, optionOf, valuesOf, withModels } from './acp.js'
import { choose } from './adapter.js'
import { AGY_OFF_CHECKED } from './agy-off.js'
import { assertGeneration } from './cli-generations.js'
import { chatProfileModes } from './codex-chat-profiles.js'
import { modelPart } from './codex-native.js'
import { pinOf, pinWire } from './model-identity.js'
import { isAuthRequired } from './names.js'
import { usageLimitOf } from './usage-limit.js'

const MAX_BYTES = 64 * 1024

// Claude Code Bots use background for memory until a hook-free subscription launch exists.
export const supportsAside = provider => ['acp-codex', 'acp-antigravity', 'acp-omp'].includes(provider)
export const supportsReview = provider => provider === 'acp-claude' || supportsAside(provider)

export const asideFailure = (kind, message) => Object.assign(new Error(message), {
  code: `acp/aside-${kind}`,
})
const unavailable = () => asideFailure('unavailable', 'A tools-off memory session is unavailable.')
const toolRefused = () => asideFailure('tool-refused', 'The memory session tried to use a tool.')
const cutOff = () => asideFailure('cut-off', 'The memory answer was cut off.')
const quota = () => asideFailure('quota', 'The account reached its usage limit.')

const real = path => {
  try { return realpathSync(path) } catch { return undefined }
}

class AsideRun extends AgentRun {
  takeOptions(options, models, fallback) {
    super.takeOptions(options, models, fallback)
    const option = optionOf(options, 'model')
    const sessionModelId = models?.currentModelId
    // A later effort-only update can omit a report that already contradicted the other.
    if (option && typeof sessionModelId === 'string') {
      // Codex reports a bare model option alongside a session model ID with its effort.
      const sessionSlug = this.spec.provider === 'acp-codex'
        ? sessionModelId.replace(/\[(?:none|minimal|low|medium|high|xhigh|max)\]$/, '') : sessionModelId
      if (option.currentValue !== sessionSlug) this.conflictingModels = true
    }
  }

  onPermission(params, signal) {
    const answer = super.onPermission(params, signal)
    this.spec.onForbiddenTool()
    return answer
  }
}

const concreteModel = value => typeof value === 'string' && value !== 'default' && /^\S+$/.test(value)
  ? value : undefined

const CLAUDE_VERSIONED = /^claude-(?:[a-z]+-\d+(?:-\d+)*|\d+(?:-\d+)*-[a-z]+(?:-\d{8})?)(?:\[1m\])?$/

function claudeIdentity(option) {
  if (option?.type !== 'select') return
  const value = option.currentValue
  const rows = valuesOf(option)
  const pin = pinOf(value)
  if (pin) {
    const wire = pinWire(rows, pin)
    if (value === pin.id) return wire === value ? pin.id : undefined
    // An explicit version elsewhere in the list cannot prove the selected alias.
    if (wire && pinWire(rows.filter(row => row.value !== pin.id), pin) === value) return pin.id
  } else if (typeof value === 'string' && CLAUDE_VERSIONED.test(value)
    && rows.filter(row => row.value === value).length === 1) {
    return value
  }
}

function claudeReportedModel(option, models) {
  const selected = claudeIdentity(option)
  if (models === undefined) return selected
  const legacy = claudeIdentity(optionOf(withModels([], models), 'model'))
  if (option === undefined) return legacy
  return selected === legacy ? selected : undefined
}

class ReviewRun extends AsideRun {
  takeOptions(options, models, fallback) {
    const modelOptions = options.filter(entry => entry?.category === 'model')
    const option = modelOptions[0]
    const current = models?.currentModelId
    super.takeOptions(options, models, fallback)
    if (!option && models === undefined) return

    const selected = option?.type === 'select' ? concreteModel(option.currentValue) : undefined
    const sessionModel = concreteModel(this.spec.provider === 'acp-codex' && typeof current === 'string'
      ? current.replace(/\[(?:none|minimal|low|medium|high|xhigh|max)\]$/, '') : current)
    const model = this.spec.provider === 'acp-claude'
      ? (modelOptions.length <= 1 ? claudeReportedModel(option, models) : undefined)
      : (selected && sessionModel && selected !== sessionModel ? undefined : selected ?? sessionModel)
    if (this.promptModel !== undefined && this.promptModel !== model) this.modelChanged = true
    this.reviewModel = model
  }

  async setOption(category, value, options) {
    if (category === 'model' && this.option('model')?.currentValue !== value) this.reviewModel = undefined
    return super.setOption(category, value, options)
  }

  endPrompt(event) {
    if (!this.modelChanged && this.reviewModel === this.promptModel) this.completedModel = this.promptModel
    return super.endPrompt(event)
  }
}

// Admission readers may ignore cancellation, but no late result can open a session or prompt.
async function duringSetup(work, signal) {
  signal.throwIfAborted()
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([work(), cancelled]) } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function answerAside({ spawn, check, name }, request) {
  const { provider, model, effort, timeoutMs = 120_000 } = request
  const review = request.purpose === 'review'
  const noSession = () => review ? asideFailure('unavailable', 'A tools-off review session is unavailable.') : unavailable()
  const refuseTool = () => review ? asideFailure('tool-refused', 'The review session tried to use a tool.') : toolRefused()
  const cutoff = () => review ? asideFailure('cut-off', 'The review answer was cut off.') : cutOff()
  const unproved = () => asideFailure('reviewer-model', 'The review session could not prove its model.')
  if (!(review ? supportsReview : supportsAside)(provider)) throw noSession()
  const timeout = AbortSignal.timeout(timeoutMs)
  const refused = new AbortController()
  const signal = AbortSignal.any([timeout, refused.signal, ...(request.signal ? [request.signal] : [])])
  let cwd
  let run
  let received = ''
  let receivedBytes = 0
  let clipped = false
  const capture = text => {
    if (clipped) return
    const bytes = Buffer.byteLength(text)
    const remaining = MAX_BYTES - receivedBytes
    if (bytes <= remaining) {
      received += text
      receivedBytes += bytes
      return
    }
    const chunk = Buffer.from(text)
    let end = remaining
    // The first byte outside the limit may belong to a character inside it.
    while (end > 0 && (chunk[end] & 0xc0) === 0x80) end--
    received += chunk.toString('utf8', 0, end)
    clipped = true
  }
  try {
    signal.throwIfAborted()
    cwd = await mkdtemp(join(tmpdir(), review ? 'automagik-review-' : 'automagik-memory-'))
    const launch = await duringSetup(() => spawn({ cwd, nativeOff: true, signal }), signal)
    const codex = provider === 'acp-codex'
    const agy = provider === 'acp-antigravity'
    const claudeReview = review && provider === 'acp-claude'
    const checkedCwd = codex && real(launch.checkedCwd)
    const modes = codex ? chatProfileModes(['read-only'], launch.profileModes ?? {}) : ['default']
    if (codex && (launch.nativeOff !== true || !checkedCwd || checkedCwd !== real(cwd)
      || !launch.models?.length)) throw noSession()
    if (agy && (!launch.agyReady || !launch.offRecheck)) throw noSession()

    const dispatch = () => {
      signal.throwIfAborted()
      assertGeneration(launch.env ?? {})
      check()
    }
    const readPrompt = () => {
      dispatch()
      return request.readPrompt()
    }
    dispatch()
    const Run = review ? ReviewRun : AsideRun
    run = new Run({
      ...launch, provider, name, cwd, mcpServers: [], refuseTools: true,
      ...(claudeReview ? {
        sessionMeta: { disableBuiltInTools: true, claudeCode: { options: { settingSources: [] } } },
      } : {}),
      onForbiddenTool: () => refused.abort(refuseTool()),
      beforeSession: async (current) => {
        if (agy && current.init?.agentInfo?.version !== AGY_OFF_CHECKED) throw noSession()
        // omp's launch arguments already disabled tools. Codex and agy need a
        // post-session check, so their private instructions go in the first prompt.
        if (!codex && !agy && current.init?.agentCapabilities?.sessionCapabilities?.systemPrompt != null) {
          await duringSetup(() => request.prepare?.(), signal)
          current.spec.botIdentity = () => readPrompt().system
        } else {
          dispatch()
        }
      },
      onReady: launch.agyReady,
    })
    await run.start({ signal })
    const pin = claudeReview ? pinOf(model) : undefined
    const modelAlias = pin && model === pin.alias ? model : undefined
    const expectedModel = pin?.id ?? model
    if (pin) {
      const rows = valuesOf(run.option('model'))
      const wire = pinWire(modelAlias === undefined ? rows : rows.filter(row => row.value !== pin.id), pin)
      if (wire === undefined) throw unproved()
      await choose(run, model, effort, undefined, { signal, pin: pin.id, wire })
    } else {
      await choose(run, model, effort, undefined, { signal })
    }
    await run.setMode(modes, { signal })
    await duringSetup(() => request.prepare?.(), signal)
    if (agy) launch.offRecheck(run)
    const selected = review ? run.reviewModel : run.option('model')?.currentValue
    if (review && (selected === undefined || (model !== 'default' && selected !== expectedModel))) throw unproved()
    if (!review && model !== 'default' && selected !== model) throw noSession()
    if (codex && (!launch.models.includes(modelPart(selected))
      || run.conflictingModels
      || (!review && run.reportedModel?.currentValue !== selected)
      || !modes.includes(run.modes?.currentModeId))) throw noSession()
    const { system, text } = readPrompt()
    if (run.identityDelivery !== 'systemPrompt' && system) run.identityPreamble = system
    if (review) run.promptModel = run.reviewModel
    void run.prompt([{ type: 'text', text }])
    let reply = ''
    let bytes = 0
    for (;;) {
      const event = await run.next(signal)
      if (review && event.type === 'text') capture(event.text)
      signal.throwIfAborted()
      if (event.type === 'text') {
        if (review) {
          if (clipped) throw cutoff()
        } else {
          bytes += Buffer.byteLength(event.text)
          if (bytes > MAX_BYTES) throw cutOff()
          reply += event.text
        }
      }
      if (event.type === 'end' && event.stopReason === 'end_turn') {
        dispatch()
        if (review) {
          if (run.completedModel === undefined) throw unproved()
          if (received.trim()) return { text: received.trim(), model: run.completedModel,
            ...(modelAlias === undefined ? {} : { modelAlias }) }
        }
        if (reply.trim()) return { text: reply.trim(), model: selected }
        break
      }
      if (event.type === 'end' && event.stopReason === 'max_tokens') throw cutoff()
      if (event.type === 'error' && event.usageLimit) throw quota()
      if (event.type === 'end' || event.type === 'error' || event.type === 'aborted') {
        if (isAuthRequired(event)) throw event
        break
      }
    }
    throw asideFailure('failed', review ? 'The review session wrote no complete answer.' : 'The memory session wrote no complete answer.')
  } catch (error) {
    if (review) {
      for (const event of run?.queue.splice(0) ?? []) {
        if (event.type === 'text') capture(event.text)
      }
      if (received) await request.onPartial?.(received)
    }
    if (refused.signal.aborted) throw refused.signal.reason
    if (request.signal?.aborted) throw asideFailure('stopped', review ? 'The review session stopped.' : 'The memory session stopped.')
    if (timeout.aborted) throw asideFailure('timeout', review ? 'The review session timed out.' : 'The memory session timed out.')
    if (error?.code?.startsWith?.('acp/aside-') || error?.code?.startsWith?.('bot/')) throw error
    if (usageLimitOf(provider, error)) throw quota()
    if (isAuthRequired(error)) throw asideFailure('signed-out', 'The account signed out.')
    throw noSession()
  } finally {
    if (run?.busy) await run.held(() => run.cancel(), { ms: 500 }).catch(() => {})
    if (run?.alive && run.sessionId !== undefined && typeof run.conn.closeSession === 'function') {
      await run.held(() => run.conn.closeSession({ sessionId: run.sessionId }), { ms: 500 }).catch(() => {})
    }
    run?.dispose()
    if (cwd !== undefined) await rm(cwd, { recursive: true, force: true })
  }
}
