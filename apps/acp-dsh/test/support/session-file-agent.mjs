// Isolated ACP lifecycle peer. Filesystem enforcement is tested separately with real Codex.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { serveAgent } from '../../dev/serve-agent.mjs'
const trace = row => appendFileSync(process.env.FILE_TRACE, JSON.stringify(row) + '\n')
const exact = process.env.FILE_MODE
const modes = ['read-only', 'workspace-write', 'agent', 'agent-full-access', ...(exact && process.env.FILE_NO_MODE !== '1' ? [exact] : [])]
let mode = exact ?? modes[0]
let cwd
const implementation = {
  initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }),
  newSession: async params => { cwd = params.cwd; trace({ event: 'start', env: process.env.CODEX_CONFIG }); return { sessionId: 'file-session', modes: { currentModeId: mode, availableModes: modes.map(id => ({ id, name: id })) } } },
  setSessionMode: async params => {
    trace({ event: 'mode', mode: params.modeId })
    if (process.env.FILE_REFUSE === '1' && params.modeId === exact) throw RequestError.invalidParams(undefined, 'profile refused')
    mode = params.modeId; return {}
  },
  prompt: async ({ sessionId, prompt }) => {
    trace({ event: 'prompt', prompt, mode })
    if (process.env.FILE_QUIET === '1') return { stopReason: 'end_turn' }
    if (exact) {
      await peer.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'New user turn on exact profile.' } } })
      return { stopReason: 'end_turn' }
    }
    const path = process.env.FILE_PATH
    const toolCall = { toolCallId: 'native-image', name: 'request_permissions', title: 'Additional sandbox permissions', kind: 'other', status: 'pending', rawInput: {
      cwd, environmentId: null, permissions: { network: null, fileSystem: { read: [path], write: null, entries: [{ path: { type: 'path', path }, access: 'read' }] } },
    }, locations: [{ path }] }
    const answer = await peer.requestPermission({ sessionId, toolCall, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] })
    trace({ event: 'permission', answer })
    return { stopReason: 'cancelled' }
  },
  cancel: async () => {},
}
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
const peer = serveAgent(implementation, stream)
