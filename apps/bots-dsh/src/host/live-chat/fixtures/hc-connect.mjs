// A stand-in for `hc connect` in plain mode, for hc.test.mjs only: answers hello, a few calls and
// one subscription, the way herdr-core shapes them.
import { createInterface } from 'node:readline'

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (text) => {
  const m = JSON.parse(text)
  if (m.method === 'hello') return out({ jsonrpc: '2.0', id: m.id, result: { generation: 1, framed: false, version: 'test', core: { id: 'c', name: 'test' }, methods: [], features: [] } })
  if (m.method === 'terminal.get') return out({ jsonrpc: '2.0', id: m.id, result: { address: m.params.terminal, env: process.env.HC_SESSION ?? null } })
  if (m.method === 'boom') return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } } })
  if (m.method === 'silent') return
  if (m.method === 'long') return out({ jsonrpc: '2.0', id: m.id, result: 'x'.repeat(5000) })
  if (m.method === 'die') return process.exit(3)
  if (m.method === 'events.subscribe') {
    out({ jsonrpc: '2.0', id: m.id, result: { channel: null, seq: 5, terminals: [{ address: 't1' }] } })
    out({ jsonrpc: '2.0', method: 'event', params: { type: 'status', terminal: 't1', seq: 6, data: { status: { app: 'claude-code', state: 'working' }, reported: true, records: {} } } })
    out({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 6 } })
    setTimeout(() => process.exit(0), 50)
  }
})
