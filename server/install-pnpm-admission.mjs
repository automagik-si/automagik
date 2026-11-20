#!/usr/bin/env node
// Build-time: make every shipped pnpm package entry a wrapper around the one admission script.
// Rename the real bin/pnpm.cjs to pnpm-real.cjs beside it; the wrapper resolves that sibling.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const out = process.argv[2]
if (!out) { process.stderr.write('usage: install-pnpm-admission.mjs OUT\n'); process.exit(2) }
const wrapper = `#!/usr/bin/env node
// automagik-pnpm-admission: one lock and bounded env for every pnpm entry.
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const result = spawnSync('/bin/sh', ['/usr/local/bin/pnpm-admission', join(__dirname, 'pnpm-real.cjs'), ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
const found = []
const seen = new Set()
const walk = (dir) => {
  let real
  try { real = realpathSync(dir) } catch { return }
  if (seen.has(real)) return
  seen.add(real)
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) { walk(path); continue }
    if (!stat.isFile() || entry.name !== 'pnpm.cjs') continue
    if (!path.endsWith('/pnpm/bin/pnpm.cjs')) continue
    found.push(path)
  }
}
for (const root of [join(out, 'runtime'), join(out, 'profile')]) {
  if (existsSync(root)) walk(join(root, 'node_modules'))
}
const wrapped = []
for (const file of found) {
  const real = join(dirname(file), 'pnpm-real.cjs')
  const current = readFileSync(file, 'utf8')
  if (current.includes('automagik-pnpm-admission')) { wrapped.push({ wrapper: file, real }); continue }
  if (!existsSync(real)) renameSync(file, real)
  writeFileSync(file, wrapper, { mode: 0o755 })
  chmodSync(file, 0o755)
  wrapped.push({ wrapper: file, real })
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'pnpm-admission.json'), `${JSON.stringify({ version: 1, wrapped }, null, 2)}\n`, { mode: 0o644 })
process.stdout.write(`wrapped ${wrapped.length} pnpm entr${wrapped.length === 1 ? 'y' : 'ies'}\n`)
