// The receipt writer (scripts/acp-receipts.mjs): phases of one launch merge, across test files
// running in separate processes at once, and never into a receipt of another launch or run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { withLock, writeReceipt } from '../scripts/acp-receipts.mjs'

const RECEIPTS = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'acp-receipts.mjs')).href
const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-receipts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const launch = { route: 'acp-x', scenario: 'real-unprompted', sdk: '2.12.0', adapter: { name: 'a/one', version: '1.0.0' }, cli: { version: '2.0.0' }, platform: 'p', node: 'v1', run: 'r1' }
const read = (dir, receipt = launch) => JSON.parse(readFileSync(join(dir, `${receipt.route}.${receipt.scenario}.json`), 'utf8'))

test('phases of one launch and run merge; another SDK, adapter, CLI or run replaces them', (t) => {
  const dir = folder(t)
  writeReceipt(dir, { ...launch, phases: { initialize: 'passed' } })
  writeReceipt(dir, { ...launch, phases: { session: 'passed' } })
  assert.deepEqual([read(dir).phases.initialize, read(dir).phases.session], ['passed', 'passed'])
  for (const other of [{ sdk: '2.13.0' }, { adapter: { name: 'a/one', version: '1.0.1' } }, { cli: { version: '2.0.1' } }, { run: 'r2' }, { node: 'v2' }]) {
    writeReceipt(dir, { ...launch, phases: { initialize: 'passed', session: 'passed' } })
    writeReceipt(dir, { ...launch, ...other, phases: { initialize: 'passed' } })
    assert.equal(read(dir).phases.session, 'unverified', `${JSON.stringify(other)}: the old launch's session does not carry over`)
  }
})

test('ACP_RECEIPT_RUN names the run when the writer does not', (t) => {
  const dir = folder(t)
  const { run: _run, ...unnamed } = launch
  const before = process.env.ACP_RECEIPT_RUN
  t.after(() => { if (before === undefined) delete process.env.ACP_RECEIPT_RUN; else process.env.ACP_RECEIPT_RUN = before })
  process.env.ACP_RECEIPT_RUN = 'env-run'
  writeReceipt(dir, { ...unnamed, phases: { initialize: 'passed' } })
  assert.equal(read(dir).run, 'env-run')
})

test('concurrent writers in separate processes lose none of each other\'s results', { timeout: 60_000 }, async (t) => {
  const dir = folder(t)
  const writers = 4
  const writes = 40
  const start = Date.now() + 400
  // Each process waits for the same moment, then writes its own keys as fast as it can.
  const child = index => new Promise((resolve, reject) => {
    const source = `import { writeReceipt } from ${JSON.stringify(RECEIPTS)}
      while (Date.now() < ${start}) {}
      for (let k = 0; k < ${writes}; k += 1) writeReceipt(${JSON.stringify(dir)}, { ...${JSON.stringify(launch)}, phases: { initialize: 'passed' }, advertised: { ['w${index}-' + k]: true } })`
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}: ${stderr}`))))
  })
  await Promise.all(Array.from({ length: writers }, (_, index) => child(index)))
  const keys = Object.keys(read(dir).advertised)
  assert.equal(keys.length, writers * writes, `${writers * writes - keys.length} results were lost`)
})

test('the lock: a held one is waited for within a bound, a dead writer\'s stale one is broken', (t) => {
  const dir = folder(t)
  // The lock writeReceipt takes for this receipt.
  const lock = join(dir, `${launch.route}.${launch.scenario}.json.lock`)
  writeFileSync(lock, '1')
  assert.throws(() => withLock(lock, () => 'never', { waitMs: 50 }), /is held/)
  const old = (Date.now() - 120_000) / 1000
  utimesSync(lock, old, old)
  assert.equal(withLock(lock, () => 'ran', { waitMs: 50 }), 'ran')
  writeFileSync(lock, '1')
  utimesSync(lock, old, old)
  writeReceipt(dir, { ...launch, phases: { initialize: 'passed' } })
  assert.equal(read(dir).phases.initialize, 'passed')
})
