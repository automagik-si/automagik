// A wire-only ACP peer. Claude's discovery and its answering session are separate.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [trace, provider, acknowledgement = 'selected'] = process.argv.slice(2)
const codex = provider === 'acp-codex'
const concrete = codex ? 'gpt-6-sol' : 'sonnet'
const mode = codex ? 'workspace-write' : 'default'
const rows = [{ value: 'default', name: 'Default' }, { value: concrete, name: codex ? 'GPT-6 Sol' : 'Sonnet 5.5' }]
if (!codex) rows.push(
  { value: 'opus', name: 'Opus' },
  { value: 'claude-opus-5-5', name: 'Opus 5.5' },
  { value: 'claude-haiku-5-5', name: 'Haiku 5.5' },
)
if (acknowledgement === 'own-model') rows.shift()
const sessionId = `wire-${process.pid}`
let selected = 'default'
const configOptions = () => [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: selected, options: rows }]
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  let result
  switch (method) {
    case 'initialize':
      result = { protocolVersion: 1, agentCapabilities: {} }
      break
    case 'session/new':
      if (['already-current', 'own-model'].includes(acknowledgement)) selected = concrete
      result = { sessionId, configOptions: configOptions(), modes: { currentModeId: mode, availableModes: [{ id: mode, name: mode }] } }
      break
    case 'session/set_config_option':
      if (acknowledgement !== 'different') selected = params.value
      if (acknowledgement === 'different-concrete') selected = 'claude-haiku-5-5'
      appendFileSync(trace, `${JSON.stringify({ method, sessionId, value: params.value, selected })}\n`)
      result = acknowledgement === 'echo-only' ? {} : { configOptions: configOptions() }
      break
    case 'session/prompt':
      appendFileSync(trace, `${JSON.stringify({ method, sessionId, selected })}\n`)
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Verdict: SHIP\nEvidence verified.' } } } })
      if (acknowledgement === 'conflict') {
        selected = 'default'
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: configOptions() } } })
      }
      result = { stopReason: 'end_turn' }
      break
    default:
      send({ id, error: { code: -32601, message: method } })
      continue
  }
  send({ id, result })
}
