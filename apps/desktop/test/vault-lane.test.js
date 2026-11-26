import assert from 'node:assert/strict'
import { test } from 'node:test'
import { laneUpdate, PUBLISHERS } from '../src/lane.js'

test('the desktop lane updates Vault only for a profile that installed it', () => {
  const version = '3.159.2'
  const vault = '@automagik/vault-dsh'
  const bots = '@automagik/bots-dsh'
  const lane = { publisher: 'automagik', version, sequence: 3159002, base: '3.159.0', plugins: [bots, vault].map(name => ({
    name, version, url: 'https://github.com/example/plugin.tgz', engines: { dsh: '>=0.2.2-rc.2 <0.3.0-0' },
  })) }
  const context = { publisher: PUBLISHERS[0], appVersion: '3.159.0', dshVersion: '0.2.2-rc.2' }
  for (const names of [[bots], [bots, vault], [vault]]) {
    const installed = Object.fromEntries(names.map(name => [name, '3.159.1']))
    assert.deepEqual(laneUpdate(lane, { ...context, installed }).plugins.map(entry => entry.name), names)
  }
})
