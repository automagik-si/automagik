// The desktop's plugin eligibility reads actual agent activity here. Protocol 2 is enabled
// only by a supporting parent plus ACP's structured getter and restart preparation. Older
// combinations retain literal { running: agents + logins, at }. No account data is written.
import { renameSync, writeFileSync } from 'node:fs'

function writeAtomic(file, text) {
  const next = `${file}.${process.pid}.tmp`
  writeFileSync(next, text)
  renameSync(next, file)
}

export function watchBusy(ctx, { env = process.env, write = writeAtomic, now = Date.now } = {}) {
  const file = env.AUTOMAGIK_BUSY_FILE?.trim()
  if (!file) return
  // The agents already at work when the welcome (re)loads, as DSH's agent registry lists them.
  const running = new Set((ctx.get?.('agents')?.list?.() ?? []).filter(agent => agent?.status === 'running').map(agent => agent.id))
  const count = value => (Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 0)
  const service = ctx.get?.('acpAgents')
  const modern = env.AUTOMAGIK_BUSY_PROTOCOL === '2'
    && typeof service?.loginActivity === 'function' && typeof service?.prepareRestart === 'function'
  const activity = () => {
    const value = service.loginActivity()
    if (!Number.isInteger(value?.active) || value.active < 0
      || !Number.isInteger(value.confirming) || value.confirming < 0 || value.confirming > value.active
      || (value.confirming > 0 && !Number.isFinite(value.confirmingUntil))) throw new Error('Untrusted login activity')
    return value
  }
  let logins = 0
  let lastModern
  try { logins = count(ctx.get?.('acpAgents')?.loginActive?.()) } catch {}
  const save = () => {
    try {
      let value = { running: running.size + logins }
      if (modern) {
        try {
          const current = activity()
          value = { running: running.size, logins: current.active, confirming: current.confirming,
            ...(current.confirming > 0 ? { confirmingUntil: current.confirmingUntil } : {}) }
        } catch { value = { untrusted: true } }
        const signature = JSON.stringify(value)
        if (signature === lastModern) return
      }
      write(file, `${JSON.stringify({ ...value, at: now() })}\n`)
      if (modern) lastModern = JSON.stringify(value)
    } catch (error) {
      ctx.logger?.warn?.('omni-ai: the busy file was not written: %s', error?.message ?? error)
    }
  }
  ctx.on('agent/status', ({ agent, status }) => {
    const was = running.size
    if (status === 'running') running.add(agent.id)
    else running.delete(agent.id)
    if (running.size !== was) save()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (running.delete(agent.id)) save()
  })
  if (modern) ctx.on('acp-dsh/login-activity', save)
  else ctx.on('acp-dsh/login-active', (payload) => {
    const next = count(payload?.active)
    if (next === logins) return
    logins = next
    save()
  })
  save()
}
