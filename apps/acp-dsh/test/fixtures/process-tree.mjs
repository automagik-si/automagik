// Report each identity before waiting for the whole tree to be ready.
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { processBirth } from '../../src/host/process-identity.js'

const [role = 'agent', stubborn = 'no', handshake = 'ready'] = process.argv.slice(2)
const report = record => writeSync(1, `${JSON.stringify(record)}\n`)
report({ role, pid: process.pid, birth: processBirth(process.pid) })
setTimeout(() => process.exit(0), 25_000)
if (role === 'tool' || role === 'unrelated') {
  if (stubborn === 'yes') process.on('SIGTERM', () => {})
  report({ ready: true })
} else {
  const next = role === 'agent' ? 'child' : 'tool'
  const child = spawn(process.execPath, [import.meta.filename, next, stubborn], {
    detached: next === 'tool', stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.once('spawn', () => {
    report({ role: next, pid: child.pid, birth: processBirth(child.pid) })
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const record = JSON.parse(line)
    if (!record.ready || handshake === 'ready') report(record)
  })
}
