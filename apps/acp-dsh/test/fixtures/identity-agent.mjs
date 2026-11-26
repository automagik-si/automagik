// A stdio peer that records identity delivery without running tools or reading a CLI home.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { serveAgent } from '../../dev/serve-agent.mjs'

const trace = (method, params) => {
  appendFileSync(process.env.IDENTITY_TRACE, `${JSON.stringify({ method, params })}\n`)
}
let next = 0
let prompted = false
let release
const systemPrompts = new Map()
const conn = serveAgent({
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
    const sessionId = `identity-${++next}`
    systemPrompts.set(sessionId, params.systemPrompt?.content[0]?.text)
    return {
      sessionId,
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
  async cancel(params) { trace('cancel', params); release?.() },
  async prompt(params) {
    trace('prompt', params)
    if (!prompted) {
      prompted = true
      if (process.env.IDENTITY_REJECT_FIRST === '1') {
        if (process.env.IDENTITY_UPDATE_FIRST === '1') {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
          })
        }
        const echo = process.env.IDENTITY_ECHO === '1'
          ? [systemPrompts.get(params.sessionId), ...params.prompt.map(block => block.text)]
            .filter(Boolean).join('\n')
          : ''
        throw RequestError.invalidParams(undefined, `Prompt rejected\n${echo}`)
      }
      if (process.env.IDENTITY_HOLD_FIRST === '1') {
        await new Promise(resolve => { release = resolve })
        return { stopReason: 'cancelled' }
      }
    }
    return { stopReason: 'end_turn' }
  },
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
