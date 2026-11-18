// Claude Code's native subagents as workers under a Bot's row (issue 1564). acp-dsh keeps the
// link each subagent call carries on the wire (`_meta.claudeCode.parentToolUseId`) and groups
// the calls under their Agent/Task call (`acpAgents.nativeWorkers()`, by DSH Session). Here each
// Session is mapped onto the Bot it belongs to, for the live answer's `work.native`: the sidebar
// draws them under the Bot's row. Read-only; nothing here starts, stops or answers a worker.

const STATES = new Set(['running', 'done', 'failed'])
const MAX_PER_BOT = 12
const MAX_STEPS = 40
const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const stateOf = value => (STATES.has(value) ? value : 'running')

// What one worker may carry to the client: short texts, a known state, bounded steps.
function cleanWorker(worker) {
  if (typeof worker?.id !== 'string' || worker.id === '') return undefined
  const steps = (Array.isArray(worker.steps) ? worker.steps : []).slice(-MAX_STEPS)
    .filter(step => typeof step?.id === 'string' && step.id !== '')
    .map(step => ({
      id: step.id.slice(0, 200),
      title: text(step.title, 160) || text(step.tool, 80),
      ...(text(step.tool, 80) ? { tool: text(step.tool, 80) } : {}),
      state: stateOf(step.state),
    }))
  const more = (Number.isInteger(worker.more) && worker.more > 0 ? worker.more : 0) + Math.max(0, (worker.steps?.length ?? 0) - MAX_STEPS)
  return {
    id: worker.id.slice(0, 200),
    title: text(worker.title, 160),
    state: stateOf(worker.state),
    ...(text(worker.result, 160) ? { result: text(worker.result, 160) } : {}),
    ...(Number.isFinite(worker.at) ? { at: worker.at } : {}),
    steps,
    ...(more > 0 ? { more } : {}),
  }
}

/**
 * Per Bot, its native workers: from its own chat and from any group Session it works in, in
 * the order acp-dsh lists them. A Session no Bot owns is left out.
 * @param {{ chatOwners: Map<string, string>, groupOwners: Map<string, { botId?: string }> }} rt
 * @param {{ nativeWorkers?: () => Record<string, unknown[]> } | undefined} acp
 * @returns {Record<string, ReturnType<typeof cleanWorker>[]>}
 */
export function nativeWorkersView(rt, acp) {
  let bySession
  try { bySession = acp?.nativeWorkers?.() } catch { return {} }
  if (bySession === null || typeof bySession !== 'object') return {}
  const out = {}
  for (const [sessionId, workers] of Object.entries(bySession)) {
    const botId = rt.chatOwners?.get(sessionId) ?? rt.groupOwners?.get(sessionId)?.botId
    if (typeof botId !== 'string' || !Array.isArray(workers)) continue
    const list = out[botId] ??= []
    for (const worker of workers) {
      const clean = cleanWorker(worker)
      if (clean !== undefined) list.push(clean)
    }
  }
  for (const [botId, list] of Object.entries(out)) {
    if (list.length === 0) delete out[botId]
    else if (list.length > MAX_PER_BOT) out[botId] = list.slice(-MAX_PER_BOT)
  }
  return out
}
