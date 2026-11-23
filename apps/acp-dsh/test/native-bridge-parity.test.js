import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { nativeWorld } from './fixtures/managed-native-world.js'

for (const situation of ['revoked', 'relisted', 'never-listed']) {
  test(`managed and standalone native mode have bridge parity when ${situation}`, async t => {
    async function outcome(managed) {
      const skipped = situation === 'never-listed'
      const w = nativeWorld(t, {
        managed, hidden: managed ? undefined : true,
        identity: () => ({ name: 'Ada', nativeTools: true }),
        env: skipped ? { FAKE_ACP_SKIP_MCP: '1' } : {},
      })
      if (skipped) w.claude.bridgeReadyMs = 100
      const chat = w.chat('same')
      const reasons = [(await chat.turn('first answer')).at(-1).reason]
      assert.equal(w.events('new-session')[0].meta.disableBuiltInTools, false)
      if (!skipped) {
        const { bridge } = w.adapter.live.get('same')
        if (situation === 'revoked') w.backchannel.revoke(bridge)
        else {
          w.backchannel.detach(bridge)
          const list = await fetch(w.backchannel.urlFor(bridge), {
            method: 'POST',
            headers: { authorization: `Bearer ${bridge.credential}`, 'x-dsh-bridge-attachment': randomUUID().replaceAll('-', '') },
            body: JSON.stringify({ op: 'list' }),
          })
          assert.equal(list.status, 200)
          assert.equal(bridge.listed, true)
          assert.equal(bridge.disconnected, false)
        }
        reasons.push((await chat.turn('second answer')).at(-1).reason)
      }
      return {
        finishes: reasons.map(reason => [reason.kind, reason.failure?.code]),
        launches: w.events('new-session').length,
        prompts: w.events('prompt').length,
      }
    }
    const legacy = await outcome(false)
    const managed = await outcome(true)
    assert.deepEqual(managed, legacy)
    if (situation === 'never-listed') {
      assert.deepEqual(managed, { finishes: [['error', 'acp_bridge_missing']], launches: 1, prompts: 0 })
    } else {
      assert.deepEqual(managed, { finishes: [['stop', undefined], ['stop', undefined]], launches: situation === 'revoked' ? 2 : 1, prompts: 2 })
    }
  })
}
