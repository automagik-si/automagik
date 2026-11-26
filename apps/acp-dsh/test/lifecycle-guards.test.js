import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { fileIdentity } from '../src/host/session-files.js'

const PROVIDER = 'acp-omp'
const OTHER = 'acp-replacement'
const ID = 'chat'

function pause() {
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  return {
    entered: entered.promise,
    release: resume.resolve,
    reject: resume.reject,
    wait: () => { entered.resolve(); return resume.promise },
  }
}

function world(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-lifecycle-'))
  const agents = new Map()
  const sessions = new Map()
  const events = new Map()
  const ctx = {
    agents,
    sessions,
    on(name, listener) {
      if (!events.has(name)) events.set(name, new Set())
      events.get(name).add(listener)
      return () => events.get(name).delete(listener)
    },
    get: name => ({
      approval: { effectivePolicy: () => 'ask' },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    })[name],
  }
  const backchannel = new Backchannel({ ctx })
  const listen = t.mock.method(backchannel, 'listen', async () => {})
  const mint = t.mock.method(backchannel, 'mint')
  const launch = t.mock.method(AgentRun.prototype, 'start', async function () {
    this.child = {}
    this.sessionId = 'fake-acp-session'
    this.options = []
  })
  const prompt = t.mock.method(AgentRun.prototype, 'prompt', async function () {
    this.promptEnded = true
    this.push({ type: 'end', stopReason: 'end_turn' })
  })
  t.mock.method(AgentRun.prototype, 'setMode', async function (modes) {
    if (modes !== undefined) this.modes = { currentModeId: modes.at(-1) }
  })
  const row = {
    name: 'Fake',
    spawn: context => ({ command: 'fake-acp', ...(context?.sessionFiles && {
      sessionFileEnabled: true, sessionFileMode: 'default',
    }) }),
  }
  const prepare = t.mock.method(row, 'spawn')
  const rows = new Map([[PROVIDER, row], [OTHER, { ...row, name: 'Replacement' }]])
  const adapter = new AcpAdapter(ctx, rows, { backchannel, dshTools: () => true, ...options })
  t.after(() => {
    adapter.dispose()
    backchannel.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  function addAgent() {
    const session = { id: ID, header: { cwd }, append() {} }
    const agent = { session, ctx: { tools: { register() {} } } }
    agents.set(ID, agent)
    sessions.set(ID, session)
    return agent
  }

  function grantImage(agent, provider = PROVIDER) {
    const image = join(cwd, 'approved.png')
    writeFileSync(image, 'fake image')
    const owner = adapter.sessionFiles.owner(agent, provider)
    const grant = { staged: true, ready: Promise.resolve(), files: [fileIdentity(image)] }
    owner.grant = grant
    return { owner, grant }
  }

  async function stream(provider = PROVIDER) {
    const messages = [{ id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fake prompt' }] }]
    const chunks = await Array.fromAsync(adapter.stream({ provider, sessionId: ID, model: 'default', messages }))
    return chunks.at(-1).reason
  }

  return {
    adapter, agents, sessions, rows, row, listen, mint, launch, prompt, prepare, addAgent, grantImage, stream,
    emit: (name, ...args) => { for (const listener of events.get(name) ?? []) listener(...args) },
  }
}

test('B1 disposed agent reports account refusal before touching the live run', async t => {
  const h = world(t)
  const old = h.addAgent()
  await h.stream(OTHER)
  const live = h.adapter.live.get(ID)
  const gate = pause()
  h.adapter.holds = () => [gate.wait]
  h.adapter.access = () => 'Confirm the fake account.'
  const turn = h.stream()
  await gate.entered
  h.agents.delete(ID)
  h.emit('agent/disposed', { agent: old })
  gate.release()

  assert.deepEqual(await turn, {
    kind: 'error', failure: { code: 'MODEL_ACCESS_REQUIRED', message: 'Confirm the fake account.' },
  })
  assert.equal(h.prepare.mock.callCount(), 1)
  assert.equal(h.launch.mock.callCount(), 1)
  assert.ok(h.adapter.live.get(ID) === live, 'the refused start must not remake the existing run')
})

test('B1 a refused account leaves an eligible run and skips prompt preparation', async t => {
  const h = world(t)
  h.addAgent()
  await h.stream(OTHER)
  const live = h.adapter.live.get(ID)
  h.row.sessionFiles = true
  h.adapter.access = () => 'Confirm the fake account.'
  const filePreflight = t.mock.method(h.adapter.sessionFiles, 'owner')

  assert.equal((await h.stream()).failure?.code, 'MODEL_ACCESS_REQUIRED')
  assert.equal(filePreflight.mock.callCount(), 0)
  assert.equal(h.prepare.mock.callCount(), 1)
  assert.equal(h.launch.mock.callCount(), 1)
  assert.ok(h.adapter.live.get(ID) === live, 'the still-eligible run must remain alive')
  assert.equal(live.run.alive, true)
})

test('B1 disposed agent reports the recorded connector install failure without preparing a launch', async t => {
  const gate = pause()
  const h = world(t, { holds: () => [gate.wait] })
  const old = h.addAgent()
  h.row.connectorStartFailure = () => 'the last install failed: fake connector error'
  const turn = h.stream()
  await gate.entered
  h.agents.delete(ID)
  h.emit('agent/disposed', { agent: old })
  gate.release()

  const reason = await turn
  assert.equal(h.prepare.mock.callCount(), 0)
  assert.equal(h.launch.mock.callCount(), 0)
  assert.match(reason.failure?.message, /Fake did not start: the last install failed: fake connector error/)
})

test('B2 late agent disposal leaves the same-ID replacement and its image grant', async t => {
  const h = world(t)
  const old = h.addAgent()
  const replacement = h.addAgent()
  const { owner, grant } = h.grantImage(replacement)
  h.row.sessionFiles = true
  assert.equal((await h.stream()).kind, 'stop')
  const live = h.adapter.live.get(ID)
  assert.equal(live.fileOwner, owner)

  h.emit('agent/disposed', { agent: old })
  assert.ok(h.adapter.live.get(ID) === live, 'late disposal must leave the replacement run')
  assert.equal(live.run.alive, true)
  assert.equal(h.adapter.sessionFiles.owners.get(ID), owner)
  assert.equal(owner.grant, grant)
})

test('B3 direct Session disposal fences a start waiting on account access', async t => {
  const gate = pause()
  const h = world(t, { access: gate.wait })
  const old = h.addAgent()
  const turn = h.stream()
  await gate.entered
  h.sessions.delete(ID)
  h.emit('session/disposed', old.session)
  gate.release()
  await turn

  assert.deepEqual([h.prepare, h.launch, h.mint, h.prompt].map(mock => mock.mock.callCount()), [0, 0, 0, 0])
})

test('B4 adapter disposal holds an entry waiting on account access', async t => {
  const gate = pause()
  const h = world(t, { access: gate.wait })
  h.addAgent()
  const turn = h.stream()
  await gate.entered
  const entry = h.adapter.starting.get(ID)
  h.adapter.dispose()
  gate.release()
  await turn

  assert.deepEqual([h.prepare, h.launch, h.mint, h.prompt].map(mock => mock.mock.callCount()), [0, 0, 0, 0])
  assert.equal(typeof entry.held, 'string')
  assert.equal(h.adapter.live.has(ID), false)
})

for (const hadFileOwner of [false, true]) {
  test(`B5 rejected start ${hadFileOwner ? 'with' : 'without'} an old file owner preserves the replacement grant`, async t => {
    const h = world(t)
    h.row.sessionFiles = hadFileOwner
    const startup = pause()
    h.launch.mock.mockImplementationOnce(startup.wait)
    h.addAgent()
    const turn = h.stream()
    await startup.entered
    const old = h.adapter.live.get(ID)
    assert.equal(Boolean(old.fileOwner), hadFileOwner)
    if (old.fileOwner !== undefined) h.adapter.sessionFiles.clear(ID, { owner: old.fileOwner, retire: false })

    const replacement = h.addAgent()
    const { owner, grant } = h.grantImage(replacement)
    startup.reject(new Error('fake startup rejection'))
    await turn

    assert.equal(h.adapter.live.has(ID), false)
    assert.ok(h.adapter.sessionFiles.owners.get(ID) === owner, 'late cleanup must leave the replacement owner')
    assert.equal(owner.grant, grant)
    assert.equal(owner.lifetime.signal.aborted, false)
  })
}

test('B6 provider registry replacement during the initial gate supplies the launch row', async t => {
  const gate = pause()
  const h = world(t, { holds: () => [gate.wait] })
  h.addAgent()
  const turn = h.stream()
  await gate.entered
  const replacement = { ...h.row, name: 'New row', spawn: () => ({ command: 'replacement-fake-acp' }) }
  h.rows.set(PROVIDER, replacement)
  gate.release()

  assert.equal((await turn).kind, 'stop')
  assert.equal(h.launch.mock.calls[0].this.spec.command, 'replacement-fake-acp')
  assert.equal(h.prepare.mock.callCount(), 0)
})

test('B7 concurrent listeners await one bind, share its failure and can retry', async t => {
  const backchannel = new Backchannel({})
  t.after(() => backchannel.dispose())
  const pending = []
  const bind = t.mock.method(Server.prototype, 'listen', function () { pending.push(this); return this })
  const outcomes = Promise.allSettled([backchannel.listen(), backchannel.listen()])
  const beforeBind = backchannel.server
  pending[0].emit('error', new Error('injected bind failure'))
  const failed = await outcomes

  assert.deepEqual(failed.map(result => result.reason?.message), ['injected bind failure', 'injected bind failure'])
  assert.equal(beforeBind, undefined)
  assert.equal(backchannel.server, undefined)
  const retry = Promise.all([backchannel.listen(), backchannel.listen()])
  t.mock.method(pending[1], 'address', () => ({ port: 12345 }))
  pending[1].emit('listening')
  assert.deepEqual(await retry, [backchannel, backchannel])
  assert.equal(bind.mock.callCount(), 2)
  assert.equal(backchannel.url, 'http://127.0.0.1:12345')
  backchannel.dispose()
  await assert.rejects(backchannel.listen(), /the back-channel is closed/)
})

test('B9 a pre-bridge crossing invalidates the old start and spares the same-ID replacement', async t => {
  const oldGate = pause()
  const newGate = pause()
  const h = world(t, { holds: () => [({ provider }) => provider === PROVIDER ? oldGate.wait() : newGate.wait()] })
  const old = h.addAgent()
  const first = h.stream()
  await oldGate.entered
  const oldEntry = h.adapter.starting.get(ID)
  assert.equal(h.mint.mock.callCount(), 0)
  h.adapter.noteEvent(old.session, { type: 'model/selection', data: { provider: OTHER } })
  const heldAtCrossing = oldEntry.held

  const replacement = h.addAgent()
  const second = h.stream(OTHER)
  await newGate.entered
  const newEntry = h.adapter.starting.get(ID)
  const { owner, grant } = h.grantImage(replacement, OTHER)
  oldGate.release()
  await first
  const oldEffects = [h.prepare, h.launch, h.mint, h.prompt].map(mock => mock.mock.callCount())
  const entryAfterCleanup = h.adapter.starting.get(ID)
  const ownerAfterCleanup = h.adapter.sessionFiles.owners.get(ID)
  const grantAfterCleanup = owner.grant
  newGate.release()
  assert.equal((await second).kind, 'stop')

  assert.deepEqual(oldEffects, [0, 0, 0, 0], 'old preparation, launch, mint and prompt counts')
  assert.equal(typeof heldAtCrossing, 'string', 'the event itself must invalidate the pre-bridge start')
  assert.equal(entryAfterCleanup, newEntry)
  assert.equal(ownerAfterCleanup, owner)
  assert.equal(grantAfterCleanup, grant)
  assert.equal(owner.lifetime.signal.aborted, false)
  assert.equal(h.prompt.mock.callCount(), 1)
})

for (const changed of ['ownership', 'provider row', 'bridge eligibility']) {
  test(`B10 rechecks ${changed} after the final pre-launch wait`, async t => {
    const h = world(t)
    const bind = pause()
    h.listen.mock.mockImplementation(bind.wait)
    h.addAgent()
    const turn = h.stream()
    await bind.entered
    assert.equal(h.prepare.mock.callCount(), 1, 'the initial gate and launch preparation already passed')
    if (changed === 'ownership') h.addAgent()
    else if (changed === 'provider row') h.rows.set(PROVIDER, { ...h.row, name: 'New row' })
    else h.adapter.dshTools = () => false
    bind.release()
    await turn

    assert.deepEqual([h.launch, h.mint, h.prompt].map(mock => mock.mock.callCount()), [0, 0, 0])
  })
}

test('B10 a provider row replaced in the final prompt gate receives no first prompt', async t => {
  const gate = pause()
  let calls = 0
  const h = world(t, { holds: () => [() => { if (++calls === 2) return gate.wait() }] })
  h.addAgent()
  const turn = h.stream()
  await gate.entered
  assert.equal(h.launch.mock.callCount(), 1)
  h.rows.set(PROVIDER, { ...h.row, name: 'New row' })
  gate.release()
  await turn

  assert.equal(h.prompt.mock.callCount(), 0)
  assert.equal(h.adapter.live.has(ID), false)
})
