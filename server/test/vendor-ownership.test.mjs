import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CliHomes } from '../../apps/acp-dsh/src/host/cli-homes.js'

const temp = () => mkdtempSync(join(tmpdir(), 'automagik-ownership-'))

test('a genuine second session is refused while the first is live', (t) => {
  const root = temp()
  const first = new CliHomes(root)
  t.after(() => { try { first.end('claude') } catch {} rmSync(root, { recursive: true, force: true }) })
  first.environment('claude')
  const second = new CliHomes(root)
  assert.throws(() => second.begin('claude'), /Close other Automagik sessions before changing the Bot account/)
})
