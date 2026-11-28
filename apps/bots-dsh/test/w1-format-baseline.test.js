import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readFormatContract } from './fixtures/w1-format-profile.mjs'
import { assertLegacyCell, assertSourceRollback, legacyCells, rollbackCells } from './fixtures/w1-format-predecessor.mjs'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const installedRunner = 'test/fixtures/w1-format-installed.mjs'
const { legacy } = readFormatContract(plugin)

for (const cell of legacyCells) {
  test('checkout with 0–3 contract: ' + cell.shape + ' in roster format ' + cell.format, {
    skip: legacy ? false : 'The checkout reads 4/5. Run ' + installedRunner + ' with a verified 0–3 artifact.',
  }, t => assertLegacyCell(t, plugin, cell))
}

for (const [from, to] of rollbackCells) {
  test('rollback with captured 0–3 contract and roster ' + from + ' → ' + to, async t => {
    await assertSourceRollback(t, plugin, from, to)
  })
}
