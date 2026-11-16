import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runVendorChild } from '../first-boot.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const temp = () => mkdtempSync(join(tmpdir(), 'automagik-vendor-child-'))

test('an awaited bounded install leaves the event loop free for a supervisor callback', async () => {
  let ticked = false
  const timer = setTimeout(() => { ticked = true }, 50)
  const result = await runVendorChild(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { timeout: 5000 })
  clearTimeout(timer)
  assert.equal(result.status, 0)
  assert.equal(result.error, null)
  assert.equal(ticked, true, 'the supervisor callback did not run while the install child was open')
  assert.ok(result.durationMs >= 250)
})

test('a timed-out install reaps its detached grandchild before resolving', async () => {
  const dir = temp()
  const pidFile = join(dir, 'grandchild.pid')
  const script = `
    const { spawn } = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
    writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))
    g.unref()
    setTimeout(() => {}, 60000)
  `
  const token = `test-${process.pid}-${Date.now()}`
  try {
    const result = await runVendorChild(process.execPath, ['-e', script], {
      timeout: 500, env: { ...process.env, AUTOMAGIK_VENDOR_INSTALL_TOKEN: token },
    })
    assert.equal(result.timedOut, true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 1)
    assert.ok(!result.remaining.includes(pid), `the grandchild ${pid} survived the reap`)
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the install child exits nonzero when its store reports a failure', () => {
  const dir = temp()
  const profile = join(dir, 'profile'), home = join(dir, 'home')
  const host = join(profile, 'node_modules', '@automagik', 'acp-dsh', 'src', 'host')
  mkdirSync(host, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(host, 'clis.js'), "export class CliStore { constructor() {} async ensure() { throw new Error('pnpm install failed (SIGKILL)') } dispose() {} }\n")
  writeFileSync(join(host, 'agents.js'), "export const AGENTS = { claude: { key: 'claude', cliPackage: '@x/y', defaultName: 'Claude' } }\n")
  try {
    const result = spawnSync(process.execPath, [join(ROOT, '..', 'vendor-install.mjs'), '--profile', profile, '--vendor', 'claude', '--home', home], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(JSON.parse(result.stdout).state, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
