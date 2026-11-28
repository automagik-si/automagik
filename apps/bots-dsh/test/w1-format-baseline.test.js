import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { effectiveRoleIds } from '../src/shared/roles.js'
import { fakeContext } from './fake-ctx.js'
import { pins, readFormatContract, rosterBytes, scratch } from './fixtures/w1-format-profile.mjs'
import { assertLegacyCell, assertSourceRollback, legacyCells, rollbackCells } from './fixtures/w1-format-predecessor.mjs'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const installedRunner = 'test/fixtures/w1-format-installed.mjs'
const { legacy } = readFormatContract(plugin)

for (const cell of legacyCells) {
  test('guarded checkout refuses ' + cell.shape + ' in roster format ' + cell.format, {
    skip: legacy ? false : 'The checkout reads 4/5. Run ' + installedRunner + ' with a verified 0–3 artifact.',
  }, async t => {
    if (cell.format >= 4) return assertLegacyCell(t, plugin, cell)
    const home = scratch(t)
    const path = join(home, 'state.json')
    const roles = cell.shape === 'registry pin' ? [pins.registry] : [pins.solver, pins.voice]
    const source = rosterBytes(cell.format, { roles })
    fs.writeFileSync(path, source)
    const ctx = fakeContext()
    t.after(() => ctx.dispose())
    const rt = createRuntime(ctx, { home })
    await rt.load()
    assert.equal(rt.teamLoaded(), false)
    assert.equal(rt.teamHealth(), null)
    assert.equal(rt.botOf('a'), undefined)
    assert.equal(rt.state.connectors, undefined)
    await assert.rejects(rt.save({ required: true }), /unrecognized saved Bot role attachments/)
    await rt.save()
    assert.deepEqual(fs.readFileSync(path), source)
  })
}

for (const format of [0, 1, 2, 3]) {
  test('legacy single pin and explicit Genie detach survive format ' + format, async t => {
    const home = scratch(t)
    const path = join(home, 'state.json')
    const source = rosterBytes(format)
    fs.writeFileSync(path, source)
    const ctx = fakeContext()
    t.after(() => ctx.dispose())
    const rt = createRuntime(ctx, { home })
    await rt.load()
    assert.equal(rt.teamLoaded(), true)
    assert.deepEqual(rt.botOf('a').roles, [pins.solver])
    assert.deepEqual(effectiveRoleIds(rt.botOf('b'), rt.state.prefs), ['genie'])
    await rt.detachRole('b')
    await rt.detachRole('a')
    const saved = JSON.parse(fs.readFileSync(path))
    assert.deepEqual(saved.bots.a.roles, [])
    assert.deepEqual(saved.bots.b.roles, [])
    assert.equal(saved.version, format === 3 ? 3 : 2)
    if (format === 3) assert.deepEqual(saved.connectors, JSON.parse(source).connectors)
  })
}

for (const [from, to] of rollbackCells) {
  test('rollback with captured 0–3 contract and roster ' + from + ' → ' + to, async t => {
    await assertSourceRollback(t, plugin, from, to)
  })
}
