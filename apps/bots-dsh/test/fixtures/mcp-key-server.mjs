// A stdio MCP server for the Session mount tests: its one tool, read_key, answers with the
// PERSON_KEY it was started with, so a test sees whether a secret reached a tool result.
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const tools = [{
  name: 'read_key',
  description: 'Answer with the key this server was started with.',
  inputSchema: { type: 'object', properties: {} },
}]

for await (const line of createInterface({ input: process.stdin })) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (!request || request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'ds-bot-key', version: '1.0.0' },
      }
      break
    case 'ping':
      result = {}
      break
    case 'tools/list':
      result = { tools }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: `key: ${process.env.PERSON_KEY ?? '(none)'}` }] }
      break
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
      continue
  }
  send({ jsonrpc: '2.0', id: request.id, result })
}
