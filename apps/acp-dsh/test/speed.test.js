// The Bot's Standard / Fast choice on the ACP wire (chooseSpeed, adapter.js): the speed option is
// shaped as the installed adapters send it to a client without boolean config options
// (codex-acp 2.12.1 `fast-mode`, claude-agent-acp 0.113.0 `fast`, category `speed`, `off` / `on`).
// The fake agent traces every `session/set_config_option` and the speed in effect at each prompt.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLAUDE, CODEX, nativeWorld, person } from './fixtures/managed-native-world.js'
import { speedFor } from '../src/host/adapter.js'

const bot = speed => ({ name: 'Ada', role: 'Builder', instructions: 'Build.', ...(speed === undefined ? {} : { speed }) })

function world(t, { id = 'fast-mode', refuse = false } = {}) {
  let speed
  const w = nativeWorld(t, {
    identity: () => bot(speed),
    env: { FAKE_ACP_FAST: id, ...(refuse ? { FAKE_ACP_FAST_REFUSE: '1' } : {}) },
  })
  const speedSets = () => w.events('set-config').filter(row => row.configId === id).map(row => row.value)
  const served = () => w.events('prompt-speed').map(row => row.fast)
  return { ...w, set: value => { speed = value }, speedSets, served, id }
}

const finishOf = chunks => chunks.find(chunk => chunk.type === 'finish')?.reason

for (const [provider, id] of [[CODEX, 'fast-mode'], [CLAUDE, 'fast']]) {
  test(`${provider}: Fast, then Standard, in the same session, each set before its prompt (${id})`, async t => {
    const w = world(t, { id })
    const chat = w.chat(`speed-both-${provider}`)
    w.set({ model: `${provider}/fake-large`, value: 'fast' })
    assert.equal(finishOf(await chat.turn(person('plain: one'), provider, [], 'fake-large')).kind, 'stop')
    assert.deepEqual(w.speedSets(), ['on'])
    assert.deepEqual(w.served(), [true])
    w.set({ model: `${provider}/fake-large`, value: 'standard' })
    assert.equal(finishOf(await chat.turn(person('plain: two'), provider, [], 'fake-large')).kind, 'stop')
    assert.deepEqual(w.speedSets(), ['on', 'off'])
    assert.deepEqual(w.served(), [true, false])
    assert.equal(w.events('new-session').length, 1, 'a speed change keeps the session')
  })
}

test('a cleared choice gives back the speed the session had before; an unset Bot never touches it', async t => {
  const w = world(t)
  const chat = w.chat('speed-reset')
  await chat.turn(person('plain: unset'), CODEX, [], 'fake-large')
  assert.deepEqual(w.speedSets(), [], 'an old Bot with no speed sends nothing')
  w.set({ model: `${CODEX}/fake-large`, value: 'fast' })
  await chat.turn(person('plain: fast'), CODEX, [], 'fake-large')
  w.set(undefined)
  await chat.turn(person('plain: cleared'), CODEX, [], 'fake-large')
  assert.deepEqual(w.speedSets(), ['on', 'off'])
  assert.deepEqual(w.served(), [false, true, false])
})

test('Fast saved for one model or provider never reaches another', async t => {
  const w = world(t)
  const chat = w.chat('speed-scope')
  w.set({ model: `${CLAUDE}/fake-large`, value: 'fast' })
  await chat.turn(person('plain: other provider'), CODEX, [], 'fake-large')
  w.set({ model: `${CODEX}/fake-small`, value: 'fast' })
  await chat.turn(person('plain: other model'), CODEX, [], 'fake-large')
  assert.deepEqual(w.speedSets(), [])
  assert.deepEqual(w.served(), [false, false])
})

test('Fast on a model that offers no speed fails the turn before any prompt', async t => {
  const w = world(t)
  const chat = w.chat('speed-unsupported')
  w.set({ model: `${CODEX}/fake-small`, value: 'fast' })
  const reason = finishOf(await chat.turn(person('plain: small'), CODEX, [], 'fake-small'))
  assert.equal(reason.kind, 'error')
  assert.match(reason.failure.message, /would not run fake-small in Fast mode: it offers no Fast mode/)
  assert.deepEqual(w.served(), [])
  // Standard there needs nothing: the model has no speed to set.
  w.set({ model: `${CODEX}/fake-small`, value: 'standard' })
  assert.equal(finishOf(await chat.turn(person('plain: small standard'), CODEX, [], 'fake-small')).kind, 'stop')
  assert.deepEqual(w.speedSets(), [])
})

test('Fast the agent keeps off fails the turn: no prompt runs at a speed nobody chose', async t => {
  const w = world(t, { refuse: true })
  const chat = w.chat('speed-refused')
  w.set({ model: `${CODEX}/fake-large`, value: 'fast' })
  const reason = finishOf(await chat.turn(person('plain: refused'), CODEX, [], 'fake-large'))
  assert.equal(reason.kind, 'error')
  assert.match(reason.failure.message, /in Fast mode: it kept Fast mode off/)
  assert.deepEqual(w.speedSets(), ['on'])
  assert.deepEqual(w.served(), [])
})

test('speedFor reads only a well-formed choice for the exact provider and model', () => {
  assert.equal(speedFor({ speed: { model: 'acp-codex/m', value: 'fast' } }, 'acp-codex', 'm'), 'fast')
  assert.equal(speedFor({ speed: { model: 'acp-codex/m', value: 'standard' } }, 'acp-codex', 'm'), 'standard')
  assert.equal(speedFor({ speed: { model: 'acp-codex/m', value: 'turbo' } }, 'acp-codex', 'm'), undefined)
  assert.equal(speedFor({ speed: { model: 'acp-codex/m', value: 'fast' } }, 'acp-claude', 'm'), undefined)
  assert.equal(speedFor({ get speed() { throw new Error('gone') } }, 'acp-codex', 'm'), undefined)
  assert.equal(speedFor(undefined, 'acp-codex', 'm'), undefined)
})
