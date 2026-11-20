const reasons = new Set(['force', 'app-update', 'lane', 'restart', 'quit'])

/** Planned desktop stops give agents and sign-ins time to finish cancelling. */
export function watchRestart(ctx, { proc = process, timers = globalThis, timeoutMs = 5000 } = {}) {
  if (typeof proc.send !== 'function') return
  let live = true
  let preparing
  const prepare = async () => {
    let agents = 0
    let timer
    let vault = 'timeout'
    // The key is added only when a vault plugin is mounted, so replies without one keep their shape.
    const withVault = result => vault === 'absent' ? result : { ...result, vault }
    const drain = async (name, method) => {
      try {
        const service = ctx.get?.(name)
        if (typeof service?.[method] !== 'function') return 'absent'
        return (await service[method]())?.ok === true ? 'done' : 'partial'
      } catch { return 'partial' }
    }
    const cancelAgents = async () => {
      try {
        await Promise.all((ctx.get?.('agents')?.list?.() ?? [])
          .filter(agent => agent?.status === 'running').map(async agent => {
            try { await agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' }); agents += 1 } catch {}
          }))
      } catch {}
    }
    const work = async () => {
      const [acp] = await Promise.all([
        drain('acpAgents', 'prepareRestart'),
        drain('secretSources', 'prepareQuit').then(result => { vault = result }),
        cancelAgents(),
      ])
      return withVault({ agents, acp })
    }
    try {
      return await Promise.race([
        work(), new Promise(resolve => { timer = timers.setTimeout(() => resolve(withVault({ agents, acp: 'timeout' })), timeoutMs) }),
      ])
    } catch { return withVault({ agents, acp: 'partial' }) } finally { timers.clearTimeout(timer) }
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
