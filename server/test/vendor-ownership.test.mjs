import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { cleanupOwnInstanceRecords } from '../first-boot.mjs'
import { CliHomes } from '../../apps/acp-dsh/src/host/cli-homes.js'
import { ownershipAt, sameOwnership } from '../../apps/acp-dsh/src/host/cli-generations.js'

const temp = () => mkdtempSync(join(tmpdir(), 'automagik-ownership-'))

test('a genuine second session is refused while the first is live', (t) => {
  const root = temp()
  const first = new CliHomes(root)
  t.after(() => { try { first.end('claude') } catch {} rmSync(root, { recursive: true, force: true }) })
  first.environment('claude')
  const second = new CliHomes(root)
  assert.throws(() => second.begin('claude'), /Close other Automagik sessions before changing the Bot account/)
})

test('a failed publish cleanup removes only the store-proven own record', (t) => {
  const root = temp()
  const homes = new CliHomes(root)
  t.after(() => { try { homes.end('claude') } catch {} rmSync(root, { recursive: true, force: true }) })
  homes.environment('claude')
  const home = homes.home('claude')
  const own = join(home, 'instances', homes.instance)
  assert.equal(existsSync(own), true)
  // Simulate publish() failing after its hard link: the record is on disk but not in owned.
  homes.generations.owned.delete(own)
  const removed = cleanupOwnInstanceRecords({ homes, vendor: 'claude', ownershipAt, sameOwnership })
  assert.deepEqual(removed, [own])
  assert.equal(existsSync(own), false)

  // A pid<=1 legacy record cannot be proven this process's own and is never deleted.
  writeFileSync(own, JSON.stringify({ format: 'app-birth-v1', pid: 1, nonce: basename(own), birth: null, marker: 'home' }))
  assert.deepEqual(cleanupOwnInstanceRecords({ homes, vendor: 'claude', ownershipAt, sameOwnership }), [])
  assert.equal(existsSync(own), true)
  rmSync(own, { force: true })
})
