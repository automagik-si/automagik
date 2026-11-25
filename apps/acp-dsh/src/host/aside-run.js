import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRun, optionOf } from './acp.js'
import { choose } from './adapter.js'
import { AGY_OFF_CHECKED } from './agy-off.js'
import { assertGeneration } from './cli-generations.js'
import { chatProfileModes } from './codex-chat-profiles.js'
import { modelPart } from './codex-native.js'
import { isAuthRequired } from './names.js'
import { usageLimitOf } from './usage-limit.js'

const MAX_BYTES = 64 * 1024

// Claude Code Bots use background for memory until a hook-free subscription launch exists.
export const supportsAside = provider => ['acp-codex', 'acp-antigravity', 'acp-omp'].includes(provider)

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
    if (option && typeof sessionModelId === 'string' && option.currentValue !== sessionModelId) {
      this.conflictingModels = true
    }
  }

  onPermission(params, signal) {
    const answer = super.onPermission(params, signal)
    this.spec.onForbiddenTool()
    return answer
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
  if (!supportsAside(provider)) throw unavailable()
  const timeout = AbortSignal.timeout(timeoutMs)
  const refused = new AbortController()
  const signal = AbortSignal.any([timeout, refused.signal, ...(request.signal ? [request.signal] : [])])
  let cwd
  let run
  try {
    signal.throwIfAborted()
    cwd = await mkdtemp(join(tmpdir(), 'automagik-memory-'))
    const launch = await duringSetup(() => spawn({ cwd, nativeOff: true, signal }), signal)
    const codex = provider === 'acp-codex'
    const agy = provider === 'acp-antigravity'
    const checkedCwd = codex && real(launch.checkedCwd)
    const modes = codex ? chatProfileModes(['read-only'], launch.profileModes ?? {}) : ['default']
    if (codex && (launch.nativeOff !== true || !checkedCwd || checkedCwd !== real(cwd)
      || !launch.models?.length)) throw unavailable()
    if (agy && (!launch.agyReady || !launch.offRecheck)) throw unavailable()

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
    run = new AsideRun({
      ...launch, provider, name, cwd, mcpServers: [], refuseTools: true,
      onForbiddenTool: () => refused.abort(toolRefused()),
      beforeSession: async (current) => {
        if (agy && current.init?.agentInfo?.version !== AGY_OFF_CHECKED) throw unavailable()
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
    await choose(run, model, effort, undefined, { signal })
    await run.setMode(modes, { signal })
    await duringSetup(() => request.prepare?.(), signal)
    if (agy) launch.offRecheck(run)
    const selected = run.option('model')?.currentValue
    if (model !== 'default' && selected !== model) throw unavailable()
    if (codex && (!launch.models.includes(modelPart(selected))
      || run.conflictingModels
      || run.reportedModel?.currentValue !== selected
      || !modes.includes(run.modes?.currentModeId))) throw unavailable()
    const { system, text } = readPrompt()
    if (run.identityDelivery !== 'systemPrompt' && system) run.identityPreamble = system
    void run.prompt([{ type: 'text', text }])
    let reply = ''
    let bytes = 0
    for (;;) {
      const event = await run.next(signal)
      signal.throwIfAborted()
      if (event.type === 'text') {
        bytes += Buffer.byteLength(event.text)
        if (bytes > MAX_BYTES) throw cutOff()
        reply += event.text
      }
      if (event.type === 'end' && event.stopReason === 'end_turn') {
        dispatch()
        if (reply.trim()) return { text: reply.trim(), model: selected }
        break
      }
      if (event.type === 'end' && event.stopReason === 'max_tokens') throw cutOff()
      if (event.type === 'error' && event.usageLimit) throw quota()
      if (event.type === 'end' || event.type === 'error' || event.type === 'aborted') {
        if (isAuthRequired(event)) throw event
        break
      }
    }
    throw asideFailure('failed', 'The memory session wrote no complete answer.')
  } catch (error) {
    if (refused.signal.aborted) throw refused.signal.reason
    if (request.signal?.aborted) throw asideFailure('stopped', 'The memory session stopped.')
    if (timeout.aborted) throw asideFailure('timeout', 'The memory session timed out.')
    if (error?.code?.startsWith?.('acp/aside-') || error?.code?.startsWith?.('bot/')) throw error
    if (usageLimitOf(provider, error)) throw quota()
    if (isAuthRequired(error)) throw asideFailure('signed-out', 'The account signed out.')
    throw unavailable()
  } finally {
    if (run?.busy) await run.held(() => run.cancel(), { ms: 500 }).catch(() => {})
    if (run?.alive && run.sessionId !== undefined && typeof run.conn.closeSession === 'function') {
      await run.held(() => run.conn.closeSession({ sessionId: run.sessionId }), { ms: 500 }).catch(() => {})
    }
    run?.dispose()
    if (cwd !== undefined) await rm(cwd, { recursive: true, force: true })
  }
}
