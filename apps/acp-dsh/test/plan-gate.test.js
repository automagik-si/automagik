import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { AgentRun } from '../src/host/acp.js'
import { AGENTS, CLAUDE_HARD_ASK } from '../src/host/agents.js'
import { chatProfileModesFor } from '../src/host/codex-chat-profiles.js'
import { nativeWorld, CLAUDE, CODEX, person } from './fixtures/managed-native-world.js'

const profiles = chatProfileModesFor('0123456789abcdef0123456789abcdef')
const gate = 'permission-profile:automagik-gate-0123456789abcdef0123456789abcdef'
const full = 'danger-full-access'
const gateAsks = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch']
const readAsks = ['Read', 'Grep', 'Glob']
const combinedText = chunks => chunks.map(chunk => chunk.text ?? chunk.reason?.failure?.message ?? '').join('')

function session(t, { provider = CLAUDE, gated = true, solver = true, guarded = true, level = 'full',
  managed = true, binding = true, offers = true, refuse = '', kept = false, child = false } = {}) {
  let state = gated
  let world
  const identity = {
    name: 'Solver', nativeTools: true, nativeToolsAgent: provider, solver, guardedSolver: guarded && solver,
    solverPolicy: { state: solver ? 'solver' : 'none' },
    confineDeny: solver ? [{ path: '/synthetic/protected', kind: 'directory' }] : undefined,
    get solverWorkspace() { return { cwd: realpathSync(world.dir) } },
    get planGate() { return solver && state },
  }
  const codex = AGENTS[CODEX]
  const modes = provider === CODEX
    ? ['read-only', 'agent-full-access', 'workspace-write', ...(offers ? [gate] : [])]
    : ['auto', 'default', 'bypassPermissions']
  world = nativeWorld(t, {
    identity: () => identity, managed, hidden: true,
    policyState: id => world.identityReaders.readState?.(id),
    env: { FAKE_ACP_MODES: modes.join(','), FAKE_ACP_REFUSE_MODES: refuse,
      ...(child ? { FAKE_ACP_CHILD: '1', FAKE_ACP_IGNORE_CANCEL: '1' } : {}) },
    ...(provider === CODEX ? { codexPatch: {
      modeFor: codex.modeFor, nativeSwitch: codex.nativeSwitch,
      ...(kept ? { nativeKeptModels: ['default', 'fake-large'] } : {}),
    } } : {}),
  })
  if (provider === CODEX) {
    const row = world.adapter.agents.get(CODEX)
    if (kept) world.adapter.startModels.set(row, 'fake-large')
    const launch = row.spawn
    row.spawn = (...args) => ({
      ...launch(...args), profileModes: profiles,
      ...(binding ? { gateBinding: (cwd, scope) => cwd === scope?.cwd } : {}),
    })
  }
  if (level === 'full') world.services.approval.effectivePolicy = () => 'never'
  if (level === 'auto') world.services.permissionPresets = { current: () => 'auto' }
  const chat = world.chat('fixture-chat')
  if (level === 'full') chat.session.append('sandbox/mode', { mode: full })
  return { ...world, ...chat, turn: message => chat.turn(message ?? 'fixture', provider), setGate: value => { state = value } }
}

test('#2134 F5 G1/G2 G6 G9 H5 G15 Claude uses default and keeps session rules across the verdict', async t => {
  for (const level of ['full', 'auto', 'manual']) {
    await t.test(level, async t => {
      const w = session(t, { level })
      await w.turn('before designated review')
      assert.equal(w.events('set-mode').at(-1)?.modeId, 'default')
      const rules = w.events('new-session')[0].meta.claudeCode.options.settings.permissions
      for (const rule of [...gateAsks, ...readAsks]) assert.ok(rules.ask.includes(rule), rule)
      if (level === 'manual') for (const rule of CLAUDE_HARD_ASK) assert.ok(rules.ask.includes(rule), rule)
      assert.deepEqual(rules.deny, ['Read(//synthetic/protected/**)'])
      w.setGate(false)
      await w.turn('after designated review')
      assert.equal(w.events('new-session').length, 1)
      if (level === 'full') assert.equal(w.events('set-mode').at(-1)?.modeId, 'bypassPermissions')
    })
  }
})

test('#2134 F5/G6 controls standalone and known unmanaged keep their modes', async t => {
  for (const managed of [true, false]) {
    await t.test(String(managed), async t => {
      const w = session(t, { managed, solver: false })
      await w.turn()
      assert.equal(w.events('set-mode').at(-1)?.modeId, 'bypassPermissions')
      assert.equal(w.events('new-session').length, 1)
    })
  }
})

test('#2134 K2c reselects gated mode at the final dispatch barrier', async t => {
  for (const refuse of ['', 'default']) {
    await t.test(refuse ? 'unavailable mode' : 'reselects', async t => {
      const w = session(t, { gated: false, refuse })
      const original = AgentRun.prototype.setMode
      let first = true
      t.mock.method(AgentRun.prototype, 'setMode', async function (...args) {
        await original.apply(this, args)
        if (first) {
          first = false
          w.setGate(true)
        }
      })
      const reply = await w.turn()
      if (refuse) {
        assert.equal(w.events('prompt').length, 0)
        assert.match(combinedText(reply), /Work now waits for the reviewer.s verdict on a new plan/)
      } else {
        assert.deepEqual(w.events('set-mode').map(row => row.modeId), ['bypassPermissions', 'default'])
        assert.equal(w.events('prompt').length, 1)
      }
    })
  }
})

test('#2134 K4c/K4d effective Codex scope selects only the gate profile and refuses missing evidence', async t => {
  for (const variant of ['bound', 'no-proof', 'not-offered', 'kept', 'open']) {
    await t.test(variant, async t => {
      const w = session(t, { provider: CODEX, gated: variant !== 'open', binding: !['no-proof', 'kept'].includes(variant),
        offers: variant !== 'not-offered', kept: variant === 'kept' })
      const reply = await w.turn()
      if (variant === 'bound' || variant === 'open') {
        assert.deepEqual(w.events('set-mode').map(row => row.modeId), [variant === 'bound' ? gate : 'agent-full-access'])
        assert.equal(w.events('prompt').length, 1)
      } else {
        assert.equal(w.events('prompt').length, 0)
        assert.match(combinedText(reply), variant === 'kept' ? /always keeps its own tools/ : /mode is not available here/)
      }
    })
  }
})

test('#2134 K3b AW-R3 missing, disposed or competing rules refuse before dispatch', async t => {
  for (const situation of ['missing', 'disposed', 'throwing', 'contested']) {
    await t.test(situation, async t => {
      const identity = { name: 'Solver', nativeTools: true }
      const w = nativeWorld(t, {
        identity: () => identity,
        managed: situation !== 'disposed',
        policyState: id => w.identityReaders.readState?.(id),
      })
      if (situation === 'disposed') w.identityReaders.register(() => ({ solverPolicy: { state: 'none' } }))()
      if (situation === 'throwing') w.identityReaders.register(() => { throw new Error('fixture lookup failed') })
      if (situation === 'contested') w.identityReaders.register(() => ({ solverPolicy: { state: 'none' } }))
      const result = await w.chat('fixture-chat').turn(person('plain synthetic request'))
      assert.equal(w.events('prompt').length, 0)
      assert.match(combinedText(result), /could not confirm this Session.s rules/)
    })
  }
})

test('#2134 X1 K2e ending model-kept Codex disposes the fake process and child', { timeout: 15_000 }, async t => {
  const w = session(t, { provider: CODEX, gated: false, kept: true, child: true })
  const text = "Work now waits for the reviewer's verdict on a new plan, so this answer stopped. Send your message again."
  const hung = w.turn(person('hang'))
  const deadline = Date.now() + 5_000
  while (!w.events('prompt').length || !w.events('child').length) {
    assert.ok(Date.now() < deadline, 'the fake prompt and child started')
    await pause(10)
  }
  const run = w.adapter.live.get(w.session.id).run
  const pid = run.child.pid
  const child = w.events('child')[0].child
  assert.ok(Number.isInteger(child))
  assert.equal(w.adapter.endNative(w.session.id, text), false)
  w.setGate(true)
  assert.equal(w.adapter.endSession(w.session.id, text), true)
  assert.ok(combinedText(await hung).endsWith(text))
  const ended = value => {
    try { process.kill(value, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }
  const stopDeadline = Date.now() + 6_000
  while (!ended(pid) || !ended(child)) {
    assert.ok(Date.now() < stopDeadline, 'the run and child were disposed')
    await pause(10)
  }
  await w.turn('next synthetic request')
  assert.equal(w.events('new-session').length, 2)
  assert.equal(w.events('set-mode').at(-1)?.modeId, gate)
})
