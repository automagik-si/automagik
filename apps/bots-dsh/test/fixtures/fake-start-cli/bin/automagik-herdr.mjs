// A stand-in for the pack CLI's `am start ... --local-only --json` (code-start.test.js). It logs
// what it was given and answers what the test's state file says; it starts nothing.
//   FAKE_START_LOG    JSONL: argv, cwd and the transport variables it saw
//   FAKE_START_STATE  { code, stdout, stderr, delayMs, marker, pad, bulk }: `pad` spaces after stdout,
//                     `bulk` bytes more on both streams
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const state = (() => {
  try { return JSON.parse(readFileSync(process.env.FAKE_START_STATE, 'utf8')) } catch { return {} }
})()
const seen = {}
for (const name of ['PATH', 'HC_SOCKET', 'AUTOMAGIK_HERDR_CORE_SOCKET', 'HC_SESSION', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'AUTOMAGIK_HERDR_DEADLINE']) {
  seen[name] = process.env[name] ?? null
}
appendFileSync(process.env.FAKE_START_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: seen, cli: import.meta.url })}\n`)
if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs))
process.stdout.write(state.stdout ?? '')
process.stderr.write(state.stderr ?? '')
const repeat = (count, text) => {
  const block = text.repeat(64 * 1024)
  for (let sent = 0; sent < count; sent += block.length) {
    process.stdout.write(block)
    process.stderr.write(block)
  }
}
if (state.pad) repeat(state.pad, ' ')
if (state.bulk) repeat(state.bulk, 'x')
if (state.marker) writeFileSync(state.marker, 'finished')
process.exitCode = state.code ?? 0
