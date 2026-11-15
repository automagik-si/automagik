export const CHECK_TIMEOUT_MS = 30_000
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const running = new WeakMap()

function bounded(work, timeoutMs, timers) {
  let timer
  return Promise.race([
    Promise.resolve().then(work),
    new Promise(resolve => { timer = timers.setTimeout(() => resolve(false), timeoutMs) }),
  ]).finally(() => timers.clearTimeout(timer))
}

/** One explicit update at a time; callers sharing the dependencies join it. */
export function forceUpdate(deps) {
  if (running.has(deps)) return running.get(deps)
  const promise = Promise.resolve().then(() => run(deps)).finally(() => running.delete(deps))
  running.set(deps, promise)
  return promise
}

async function run(deps) {
  const { publish, log = () => {}, timers = globalThis,
    checkTimeoutMs = CHECK_TIMEOUT_MS, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS } = deps
  const say = (phase, code, params) => {
    const state = { phase, ...(code ? { code } : {}), ...(params ? { params } : {}) }
    publish(state)
    log(`force: ${phase}${code ? ` ${code}` : ''}`)
    return state
  }
  const install = async () => { say('installing'); await deps.installApp() }
  try {
    say('stopping')
    if (deps.appReady()) return await install()
    say('checking')
    const [answer, laneReason] = await Promise.all([
      bounded(deps.check, checkTimeoutMs, timers),
      Promise.resolve().then(deps.lookLanes).catch(() => ({ code: 'check-failed' })),
    ])
    let code
    if (deps.appReady()) return await install()
    if (deps.appMode() !== 'auto') code = 'app-manual'
    else if (['found', 'ready', 'busy'].includes(answer?.result)) {
      say('downloading')
      let ready = false
      try {
        ready = await bounded(() => deps.waitAppReady({ timeoutMs: downloadTimeoutMs }), downloadTimeoutMs, timers)
      } catch {}
      if (ready) return await install()
      code = 'app-download-failed'
    } else if (!answer || answer.result === 'error') code = 'app-download-failed'
    say('restarting')
    let updated = false
    if (deps.laneStaged()) {
      const outcome = await deps.applyLane()
      if (outcome === 'restored' || outcome === 'rollback') return say('failed', 'plugins-rolled-back')
      if (outcome === 'down') return say('failed', 'restart-failed')
      updated = outcome === 'good' || outcome === 'applied'
    } else await deps.restartDsh()
    // Applying an older staged lane does not resolve a failed or blocked check of the latest.
    if (laneReason?.code && laneReason.code !== 'up-to-date') return say('failed', laneReason.code, laneReason.params)
    return say('done', code ?? (updated ? 'updated' : 'up-to-date'))
  } catch {
    return say('failed', 'restart-failed')
  }
}
