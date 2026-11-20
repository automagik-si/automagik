import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

test('the image grants the Omni capability to DSH and starts its supervisor after DSH spawns', () => {
  // main() is intentionally not run here: it launches the real core and DSH.
  const source = readFileSync(new URL('../entrypoint.mjs', import.meta.url), 'utf8')
  const launch = source.slice(source.indexOf('const launchDsh = () => {'), source.indexOf('await runStartup('))
  assert.match(launch, /child = spawn\(process\.execPath, dshArgs\(publicArgs\), \{\s*env: \{ \.\.\.env, AUTOMAGIK_OMNI_SUPERVISOR: '1' \}/)
  assert.match(launch, /child\.once\('spawn', \(\) => \{\s*if \(!stopping\) supervisor\.start\(\)/)
  assert.match(source, /prepareGateView\(gateView, dirname\(gateView\), \{[\s\S]*?secrets, omni: omniHome/)
})

test('entrypoint shutdown waits for Omni and DSH before stopping core', async () => {
  const source = readFileSync(new URL('../entrypoint.mjs', import.meta.url), 'utf8')
  const shutdown = source.slice(source.indexOf('const shutdown = (code,'), source.indexOf('for (const signal of'))
  assert.match(shutdown, /Promise\.allSettled\(\[supervisor\.stop\(\), stopChild\(child, signal\)\]\)/)
  const events = []
  let finishOmni, finishDsh
  const omni = new Promise(resolve => { finishOmni = resolve })
  const dsh = new Promise(resolve => { finishDsh = resolve })
  const child = { kind: 'dsh' }
  const core = { kind: 'core' }
  runInNewContext(`${shutdown}\nshutdown(7)`, {
    supervisor: { stop: () => { events.push('omni'); return omni } },
    stopChild: target => {
      events.push(target.kind)
      return target === child ? dsh : Promise.resolve()
    },
    child, core, stopping: false, warn: message => { throw new Error(message) },
    isRunning: () => false,
    setTimeout: () => ({ unref() {} }),
    process: { exit: code => events.push(`exit ${code}`) },
  })
  assert.deepEqual(events, ['omni', 'dsh'])
  finishDsh()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['omni', 'dsh'])
  finishOmni()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['omni', 'dsh', 'core', 'exit 7'])
})

test('the image carries the supervisor and schedules the Omni restart smoke after the scan', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const dockerfile = read('../Dockerfile')
  const workflow = read('../../.github/workflows/server-image.yml')
  const compose = read('../compose.gate.yml')
  const smoke = read('../omni-smoke.mjs')
  assert.match(dockerfile, /COPY server\/entrypoint\.mjs[\s\S]*?server\/omni-supervisor\.mjs/)
  assert.ok(workflow.indexOf('Secrecy (extract rootfs and scan)') < workflow.indexOf('run: node server/omni-smoke.mjs'))
  assert.match(workflow, /timeout-minutes: 90/)
  assert.match(compose, /stop_grace_period: 90s/)
  assert.match(smoke, /const route = '\/api\/omni-ai'/)
  assert.match(smoke, /\['restart', '-t', '90', container\]/)
})
