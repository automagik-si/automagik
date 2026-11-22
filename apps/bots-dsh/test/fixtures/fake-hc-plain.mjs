#!/usr/bin/env node
// The plain JSON-RPC side of the seat engine, over the same read seam as its unit tests.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createFakeHc } from '../../src/host/live-chat/fake-hc.mjs'

const log = row => appendFileSync(process.env.FAKE_HC_LOG, JSON.stringify(row) + '\n')
if (process.argv[2] === '--version') {
  log({ method: '--version' })
  process.exit(0)
}
if (process.argv[2] !== 'connect') process.exit(2)

const fake = createFakeHc(JSON.parse(readFileSync(process.env.FAKE_HC_STATE, 'utf8')))
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const reads = new Set(['terminal.get', 'terminal.read', 'file.read'])
const input = createInterface({ input: process.stdin })
for await (const line of input) {
  const { id, method, params } = JSON.parse(line)
  log({ method, params })
  try {
    if (method === 'hello') reply(id, { core: { id: 'core-test' }, generation: 1 })
    else if (method === 'events.subscribe') fake.subscribe(params, ({ seq, terminals }) => reply(id, { seq, terminals }))
    else if (reads.has(method)) reply(id, await fake.call(method, params))
    else throw new Error('method refused')
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }) + '\n')
  }
}
fake.close()
