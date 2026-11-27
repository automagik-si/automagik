#!/usr/bin/env node
// A scripted ACP agent for the wire replay (test/wire-replay.test.js): it plays one recorded
// exchange from SCRIPTED_ACP_SCRIPT (JSON) and writes every frame it sees, both ways, to
// SCRIPTED_ACP_TRACE, normalized (no ids, paths or timings) so a run compares with its golden.
//
// Script: { initialize: <InitializeResponse>, session: <NewSessionResponse> | { authRequired: true },
//           turn: [<step>] | turns: [[<step>], ...] } (`turns`: one list per prompt, in order) with steps
//   { update: <SessionUpdate> }                     a session/update notification
//   { ask: { toolCall, options } }                 a session/request_permission, its outcome traced
//   { waitCancel: true }                            waits for session/cancel, then ends cancelled
//   { elicit: <CreateElicitationRequest> }          an elicitation/create, its answer traced
//   { end: <stopReason>, usage?: <Usage> }         the prompt's answer (with its usage, if any)
import { agent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk/unstable'
import { appendFileSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

const script = JSON.parse(readFileSync(process.env.SCRIPTED_ACP_SCRIPT, 'utf8'))
const trace = frame => appendFileSync(process.env.SCRIPTED_ACP_TRACE, `${JSON.stringify(frame)}\n`)
const { session } = methods.agent
let cancelled
let prompts = 0
const cancel = new Promise((resolve) => { cancelled = resolve })

agent({ name: 'scripted-agent' })
  .onNotification(session.cancel, () => { trace({ in: 'session/cancel' }); cancelled() })
  .onRequest(methods.agent.initialize, ({ params }) => {
    trace({ in: 'initialize', clientCapabilities: params.clientCapabilities })
    return script.initialize
  })
  .onRequest(session.new, ({ params }) => {
    trace({ in: 'session/new', servers: (params.mcpServers ?? []).map(server => server.name) })
    if (script.session?.authRequired) throw RequestError.authRequired(undefined, 'sign in first')
    return script.session
  })
  .onRequest(session.setMode, ({ params }) => { trace({ in: 'session/set_mode', modeId: params.modeId }); return {} })
  .onRequest(session.setConfigOption, ({ params }) => { trace({ in: 'session/set_config_option', configId: params.configId, value: params.value }); return {} })
  .onRequest(session.close, () => { trace({ in: 'session/close' }); return {} })
  .onRequest(session.prompt, async ({ params, client }) => {
    trace({ in: 'session/prompt', text: params.prompt.filter(block => block.type === 'text').map(block => block.text).join(' ') })
    const steps = script.turns === undefined ? script.turn : script.turns[Math.min(prompts, script.turns.length - 1)]
    prompts += 1
    for (const step of steps) {
      if (step.update !== undefined) {
        trace({ out: 'session/update', update: step.update })
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: step.update })
      } else if (step.ask !== undefined) {
        trace({ out: 'session/request_permission', toolCallId: step.ask.toolCall.toolCallId, options: step.ask.options.map(option => option.kind) })
        const answer = await client.request(methods.client.session.requestPermission, { sessionId: params.sessionId, ...step.ask })
        trace({ in: 'permission-answer', outcome: answer.outcome.outcome, ...(answer.outcome.optionId === undefined ? {} : { kind: step.ask.options.find(option => option.optionId === answer.outcome.optionId)?.kind }) })
        if (answer.outcome.outcome === 'cancelled') {
          trace({ out: 'session/prompt', stopReason: 'cancelled' })
          return { stopReason: 'cancelled' }
        }
      } else if (step.elicit !== undefined) {
        trace({ out: 'elicitation/create', mode: step.elicit.mode })
        const answer = await client.request(methods.client.elicitation.create, { sessionId: params.sessionId, ...step.elicit })
        trace({ in: 'elicitation-answer', action: answer.action, ...(answer.content === undefined ? {} : { content: answer.content }) })
      } else if (step.waitCancel) {
        await cancel
        trace({ out: 'session/prompt', stopReason: 'cancelled' })
        return { stopReason: 'cancelled' }
      } else if (step.end !== undefined) {
        trace({ out: 'session/prompt', stopReason: step.end })
        return { stopReason: step.end, ...(step.usage === undefined ? {} : { usage: step.usage }) }
      }
    }
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
