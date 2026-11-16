#!/usr/bin/env node
// One vendor CLI install in its own child process: bounded heap, serialized by the caller, and
// a failure report that names the kernel's OOM kill and the cgroup peak, not just a signal.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENTS_RELATIVE, CLI_STORE_RELATIVE, PNPM_PATH } from './toolchain.mjs'

const args = process.argv.slice(2)
const value = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const profile = value('--profile')
const vendor = value('--vendor')
const home = value('--home')
if (!profile || !vendor || !home) {
  process.stderr.write('usage: vendor-install.mjs --profile DIR --vendor KEY --home DIR\n')
  process.exit(2)
}
const read = (file) => { try { return readFileSync(file, 'utf8').trim() } catch { return null } }
const cgroup = () => {
  const events = read('/sys/fs/cgroup/memory.events') ?? ''
  const number = (name) => Number((events.match(new RegExp(`^${name} (\\d+)$`, 'm')) ?? [])[1] ?? 0)
  return {
    memoryEvents: events || null,
    oom: number('oom'),
    oomKill: number('oom_kill'),
    memoryPeakBytes: Number(read('/sys/fs/cgroup/memory.peak') ?? 0) || null,
    memoryMaxBytes: Number(read('/sys/fs/cgroup/memory.max') ?? 0) || null,
  }
}
const failure = (error, state = {}) => ({
  state: 'failed',
  error: String(error?.stderr ?? error?.message ?? error),
  signal: error?.signal ?? null,
  code: error?.code ?? null,
  status: error?.status ?? null,
  ...cgroup(),
  ...state,
})
let store
try {
  const { CliStore } = await import(pathToFileURL(join(profile, CLI_STORE_RELATIVE)).href)
  const { AGENTS } = await import(pathToFileURL(join(profile, AGENTS_RELATIVE)).href)
  const spec = Object.values(AGENTS).find((candidate) => candidate?.key === vendor)
  if (!spec) { process.stdout.write(`${JSON.stringify(failure(`unknown vendor ${vendor}`))}\n`); process.exit(0) }
  store = new CliStore({
    env: { ...process.env, AUTOMAGIK_HOME: home, AUTOMAGIK_PNPM: process.env.AUTOMAGIK_PNPM || PNPM_PATH },
    log: (message) => process.stderr.write(`vendor CLIs: ${message}\n`),
  })
  const found = await store.ensure(spec, undefined)
  const result = found
    ? { state: 'ready', version: found.version, path: found.path, managed: Boolean(found.managed), ...cgroup() }
    : { state: 'missing', ...cgroup() }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify(failure(error))}\n`)
} finally {
  try { store?.dispose?.() } catch {}
}
