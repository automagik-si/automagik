// A stdio peer that records identity delivery without running tools or reading a CLI home.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { serveAgent } from '../../dev/serve-agent.mjs'

const trace = (method, params) => {
  appendFileSync(process.env.IDENTITY_TRACE, `${JSON.stringify({ method, params })}\n`)
}
let next = 0
serveAgent({
  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: {
          fork: {},
          ...(process.env.IDENTITY_CAPABILITY === '1' ? { systemPrompt: {} } : {}),
        },
      },
    }
  },
  async newSession(params) {
    trace('new', params)
    return {
      sessionId: `identity-${++next}`,
      modes: {
        currentModeId: 'default',
        availableModes: ['default', 'read-only', 'auto', 'full-access', 'bypassPermissions']
          .map(id => ({ id, name: id })),
      },
    }
  },
  async forkSession(params) {
    trace('fork', params)
    return { sessionId: `identity-${++next}` }
  },
  async closeSession(params) { trace('close', params); return {} },
  async setSessionMode(params) { trace('mode', params); return {} },
  async prompt(params) { trace('prompt', params); return { stopReason: 'end_turn' } },
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
