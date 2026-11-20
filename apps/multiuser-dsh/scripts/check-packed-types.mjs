// Manual offline check using the locally cached TypeScript compiler and installed DSH harness.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const plugin = resolve(import.meta.dirname, '..')
const compiler = join(homedir(), '.bun/install/cache/typescript@5.9.3@@@1/bin/tsc')
const harness = process.env.DSH_HARNESS ?? join(plugin, 'dev', 'harness')
const dir = mkdtempSync(join(tmpdir(), 'multiuser-packed-types-'))
try {
  execFileSync('bun', ['pm', 'pack', '--destination', dir], { cwd: plugin, stdio: 'inherit' })
  const archive = readdirSync(dir).find(file => file.endsWith('.tgz'))
  const modules = join(dir, 'node_modules')
  const pkg = join(modules, '@automagik/multiuser-dsh')
  mkdirSync(pkg, { recursive: true })
  symlinkSync(join(harness, 'node_modules/@deepseek-ai'), join(modules, '@deepseek-ai'), 'dir')
  execFileSync('tar', ['-xzf', join(dir, archive), '--strip-components=1', '-C', pkg], { stdio: 'inherit' })
  const consumer = join(dir, 'consumer.mts')
  writeFileSync(consumer, `import { Config, type AutomagikPrincipal } from '@automagik/multiuser-dsh'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
const caller: AutomagikPrincipal = { kind: 'automagik', instance: 'w',
  person: { issuer: 'issuer', subject: 'person', roles: ['member'], workspace: 'w' } }
const accept = (principal: Principal) => principal
accept(caller)
const limit: number = Config({}).maxRequestBodyBytes
void limit
`)
  execFileSync(process.execPath, [compiler, '--module', 'NodeNext', '--strict', '--noEmit', '--skipLibCheck', consumer], { stdio: 'inherit' })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
