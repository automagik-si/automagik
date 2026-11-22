import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dryRunVendorClis } from '../cli-store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ACP = join(ROOT, 'apps', 'acp-dsh')

test('the shipped CLI store asks for both official CLIs through AUTOMAGIK_PNPM and npmjs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-cli-store-test-'))
  const pnpm = join(dir, 'pnpm')
  writeFileSync(pnpm, '#!/bin/sh\nexit 0\n')
  chmodSync(pnpm, 0o755)
  try {
    const result = await dryRunVendorClis({ acpDshDir: ACP, env: { AUTOMAGIK_PNPM: pnpm }, log: () => {} })
    assert.equal(result.pnpm, pnpm)
    assert.deepEqual(result.agents.map((agent) => agent.package).sort(), ['@anthropic-ai/claude-code', '@openai/codex'])
    assert.equal(result.calls.length, 2)
    for (const call of result.calls) {
      assert.equal(call.command, pnpm)
      assert.ok(call.args.includes('--config.registry=https://registry.npmjs.org'))
      assert.ok(call.args.includes('--ignore-scripts'))
      assert.ok(call.args.includes('--prod'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing AUTOMAGIK_PNPM is refused before any install starts', async () => {
  await assert.rejects(
    dryRunVendorClis({ acpDshDir: ACP, env: { AUTOMAGIK_PNPM: join(tmpdir(), 'missing-pnpm') }, log: () => {} }),
    /AUTOMAGIK_PNPM is not an executable/,
  )
})
