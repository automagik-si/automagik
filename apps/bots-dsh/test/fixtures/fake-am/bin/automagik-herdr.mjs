// The fake accounts CLI is invoked through accounts.mjs; the page's launch-path adapter imports this
// module and calls its launch-path handler, which answers from the fixture state.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export async function cmdLaunchPath(_opts, words) {
  appendFileSync(process.env.FAKE_ACCOUNTS_LOG, JSON.stringify({ argv: ['launch-path', ...words], dir: dirname(import.meta.dirname),
    cwd: process.cwd(), stdin: '', appHome: process.env.HERDR_APP_HOME }) + '\n')
  const { where } = JSON.parse(readFileSync(process.env.FAKE_ACCOUNTS_STATE, 'utf8'))
  const control = where ?? {}
  if (control.text !== undefined) writeFileSync(1, control.text)
  else writeFileSync(1, `${JSON.stringify(control.reply ?? { program: null, path: null })}\n`)
  if (control.exit) process.exitCode = control.exit
}
