import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const argv = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_ACCOUNTS_LOG, JSON.stringify({ argv, dir: dirname(import.meta.dirname),
  cwd: process.cwd(), stdin, appHome: process.env.HERDR_APP_HOME }) + '\n')
const { answer, here, write } = JSON.parse(readFileSync(process.env.FAKE_ACCOUNTS_STATE, 'utf8'))
const read = argv[0] === 'here'
const control = (read ? here : write) ?? {}
if (control.delay) await delay(control.delay)
if (control.stderr) writeFileSync(2, control.stderr)
if (control.text !== undefined) writeFileSync(1, control.text)
else if (control.exit !== 2) {
  const result = read ? answer : { ok: true, snapshot: 'b'.repeat(64), use: argv[2] }
  writeFileSync(1, JSON.stringify(control.reply ?? result))
}
process.exitCode = control.exit ?? 0
