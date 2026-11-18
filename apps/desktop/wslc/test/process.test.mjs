// The smoke's stop check: DSH's entry is in AUTOMAGIK_DSH_ENTRY now, so the only command line the
// guest shows is the launcher's. Matching the entry (or the smoke fake's) calls a live DSH stopped.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DSH_LAUNCHER, dshRunning } from '../smoke/process.mjs'

const LIVE = 'node --require /opt/automagik/desktop/src/close-inherited-preload.cjs '
  + '/opt/automagik/dsh-launch/dsh-launch.cjs --profile omni --no-open --host 127.0.0.1 --port 41700'
const guestOf = lines => ({
  ok: (command, flag, pattern) => command === 'pgrep' && flag === '-f' && lines.some(line => line.includes(pattern)),
})

test('the smoke finds the live DSH by its launcher, not by the entry path', () => {
  assert.equal(dshRunning(guestOf([LIVE])), true, 'running while the fake DSH lives')
  assert.equal(dshRunning(guestOf([])), false, 'not running after the stop')
  // What the old check matched: either pattern misses the live process, so a mutant back to them
  // fails this row.
  assert.equal(guestOf([LIVE]).ok('pgrep', '-f', '@deepseek-ai/dsh/lib/bin.js'), false)
  assert.equal(guestOf([LIVE]).ok('pgrep', '-f', '/opt/smoke/fake-dsh.mjs'), false)
  assert.equal(DSH_LAUNCHER, '/opt/automagik/dsh-launch/dsh-launch.cjs')
})
