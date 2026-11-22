import assert from 'node:assert/strict'
import { install } from '../../src/host/self-update-hold.js'
import { selfUpdateStatus } from '../../src/host/self-update.js'

export async function observeHeldTurn(profileDir, record) {
  const requestId = process.env.REINSTALL_HELD_REQUEST
  const runId = process.env.AUTOMAGIK_SUPERVISOR_RUN
  if (!requestId && !runId) return

  const rt = {
    ctx: { get: key => key === 'profileContext' ? { dir: profileDir } : undefined },
    selfUpdateStatus: () => selfUpdateStatus({ profileDir, inDesktop: false }),
    resumeUpdateStopped: () => record({ event: 'update-work-resumed', requestId }),
  }
  const dispose = install(rt)
  try {
    if (requestId) {
      rt.updateHold.close(requestId)
      rt.updateHold.wrote()
    }
    assert.equal(rt.updateHold.closed, true)
    const step = rt.updateHold.wait()
    record({ event: 'turn-held', requestId, runId })
    await step
    record({ event: 'turn-resumed', requestId, runId })
  } finally {
    dispose()
  }
}
