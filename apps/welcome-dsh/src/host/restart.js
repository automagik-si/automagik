const reasons = new Set(['force', 'app-update', 'lane', 'restart', 'quit'])

/** Planned desktop stops give agents and sign-ins time to finish cancelling. */
export function watchRestart(ctx, { proc = process, timers = globalThis, timeoutMs = 5000 } = {}) {
  if (typeof proc.send !== 'function') return
  let live = true
  let preparing
  const prepare = async () => {
    let agents = 0
    let timer
    const work = async () => {
      const cancellations = (ctx.get?.('agents')?.list?.() ?? [])
        .filter(agent => agent?.status === 'running').map(async agent => {
          try { await agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' }); agents += 1 } catch {}
        })
      const acp = ctx.get?.('acpAgents')
      const drain = async () => {
        if (typeof acp?.prepareRestart !== 'function') return 'absent'
        try { return (await acp.prepareRestart())?.ok === true ? 'done' : 'partial' } catch { return 'partial' }
      }
      const [result] = await Promise.all([drain(), ...cancellations])
      return { agents, acp: result }
    }
    try {
      return await Promise.race([
        work(), new Promise(resolve => { timer = timers.setTimeout(() => resolve({ agents, acp: 'timeout' }), timeoutMs) }),
      ])
    } catch { return { agents, acp: 'partial' } } finally { timers.clearTimeout(timer) }
  }
  const message = async (request) => {
    if (request?.type !== 'automagik:prepare-restart' || request.protocol !== 1
      || typeof request.id !== 'string' || !reasons.has(request.reason)) return
    const result = await (preparing ??= prepare())
    if (live) try { proc.send({ type: 'automagik:prepared-restart', id: request.id, protocol: 1, result }, () => {}) } catch {}
  }
  proc.on('message', message)
  ctx.effect(() => () => { live = false; proc.removeListener('message', message) })
}
