import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import * as roles from '../src/shared/roles.js'
import { fakeContext } from './fake-ctx.js'
import { pins, readFormatContract, rosterBytes } from './fixtures/w1-format-profile.mjs'
import { assertCleanCell, assertRefusedCell, assertSourceRollback, legacyCells, prepareRollback, rollbackCells } from './fixtures/w1-format-predecessor.mjs'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const installedRunner = 'test/fixtures/w1-format-installed.mjs'
const { legacy } = readFormatContract(plugin)

async function withCheckoutHost(_plugin, home, check) {
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, diagnosticsFile: false, github: false })
  try {
    await rt.load()
    await check(rt, roles)
  } finally {
    rt.dispose()
    await ctx.dispose()
  }
}

for (const cell of legacyCells) {
  test('guarded checkout refuses ' + cell.shape + ' in roster format ' + cell.format, {
    skip: legacy ? false : 'The checkout reads 4/5. Use the guarded fixture on installed 5A-F, or '
      + installedRunner + ' for a signed pre-5A-F artifact.',
  }, t => assertRefusedCell(t, plugin, cell, { host: withCheckoutHost }))
}

for (const format of [0, 1, 2, 3]) {
  test('legacy single pin and explicit Genie detach survive format ' + format,
    t => assertCleanCell(t, plugin, format, { host: withCheckoutHost, legacy }))
}

for (const [from, to] of rollbackCells) {
  test('rollback with captured 0–3 contract and roster ' + from + ' → ' + to, async t => {
    await assertSourceRollback(t, plugin, from, to)
  })
}

test('rollback setup accepts the exact clean switch-time roster and explicit trial pins', async t => {
  const switchTimeBytes = rosterBytes(2, { roles: [pins.voice], revision: 42 })
  const trialRoles = [pins.registry]
  const { original, trial } = await prepareRollback(t, plugin, 2, 4, undefined, { switchTimeBytes, trialRoles })
  assert.deepEqual(original, switchTimeBytes)
  assert.deepEqual(JSON.parse(trial).bots.a.roles, trialRoles)
  assert.equal(JSON.parse(trial).revision, 43)
})
