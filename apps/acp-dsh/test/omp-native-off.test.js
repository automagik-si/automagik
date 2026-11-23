import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeWorld } from './fixtures/managed-native-world.js'
import { OMP, holdOmpStart, offArgs, ompWorld, ownerMessage, textBlocks } from './fixtures/omp-world.js'

const expectedOverlay = `# Written by Automagik for omp with native tools off. Rewritten at each start; never edit.
memory:
  backend: "off"
autolearn:
  enabled: false
externalThinking: false
goal:
  enabled: false
speechgen:
  enabled: false
generate_image:
  enabled: false
dev:
  autoqa: false
`
const unexpectedTool = 'omp tried to use a tool while native tools are off, so this answer stopped.'
const toolsChanged = 'The tools setting changed; send again.'
const nowReadOnly = 'This conversation is now Read only. Send a new message to continue.'
const nativeOn = () => ({ name: 'Sofia', nativeTools: true, nativeToolsAgent: OMP })
const snapshot = home => readdirSync(home, { recursive: true }).sort().map(name => {
  const path = join(home, name)
  return [name, statSync(path).isDirectory() ? null : createHash('sha256').update(readFileSync(path)).digest('hex')]
})

function setEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

for (const location of ['adapter store default', 'catalog fallback', 'injected']) {
  test(`OFF uses the verified overlay at the ${location} and leaves the omp home alone`, async t => {
    const h = ompWorld(t, {
      storeHome: location !== 'catalog fallback',
      overlay: location === 'injected' ? dir => join(dir, 'injected overlay') : undefined,
    })
    const home = join(h.dir, 'home')
    const agentDir = join(home, '.omp', 'agent')
    const config = join(agentDir, 'config.yml')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(config, 'dev:\n  autoqa: true\n')
    const before = snapshot(home)
    const xdg = join(home, 'config')
    setEnv(t, { HOME: home, XDG_CONFIG_HOME: xdg, PI_AUTO_QA: '1', PI_CODING_AGENT_DIR: agentDir })
    h.service.botIdentity(() => ({ name: 'Sofia' }))
    const probe = await h.service.inspect(OMP)
    assert.equal(probe.signedIn, true)
    const probeStarts = h.events('start')
    assert.ok(probeStarts.some(row => row.args.length === 1 && row.args[0] === 'acp'))
    const chunks = await h.chat().turn('plain overlay-marker')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const chat = h.conversation('overlay-marker')
    assert.ok(probeStarts.every(row => row.pid !== chat.pid))
    assert.deepEqual(chat.args, offArgs(h.overlayPath))
    assert.deepEqual(chat.env, { PI_AUTO_QA: null, PI_CODING_AGENT_DIR: agentDir, HOME: home, XDG_CONFIG_HOME: xdg })
    assert.deepEqual(chat.servers, [])
    assert.equal(readFileSync(h.overlayPath, 'utf8'), expectedOverlay)
    if (process.platform !== 'win32') {
      assert.equal(statSync(h.overlayPath).mode & 0o777, 0o600)
      assert.equal(statSync(dirname(h.overlayPath)).mode & 0o777, 0o700)
    }
    assert.deepEqual(snapshot(home), before)
  })
}

for (const [label, identity] of [
  ['legacy without a team', undefined],
  ['saved ON at Manual', () => ({ name: 'Sofia', nativeTools: true })],
]) {
  test(label + ' launches plain omp acp with its inherited environment', async t => {
    const h = ompWorld(t)
    setEnv(t, { PI_AUTO_QA: '1' })
    if (identity) h.service.botIdentity(identity)
    await h.service.inspect(OMP)
    await h.chat().turn('plain on-control')
    const chat = h.conversation('on-control')
    assert.deepEqual(chat.args, ['acp'])
    assert.deepEqual(chat.servers, [])
    assert.equal(chat.env.PI_AUTO_QA, '1')
    assert.equal(existsSync(h.overlayPath), false)
  })
}

for (const [label, identities, options] of [
  ['a tag for Claude', [() => ({ name: 'Sofia', nativeTools: true, nativeToolsAgent: 'acp-claude' })], {}],
  ['Read only', [() => ({ name: 'Sofia', nativeTools: true })], { readOnly: true }],
  ['unknown level', [() => ({ name: 'Sofia', nativeTools: true })], { sandbox: false }],
  ['a throwing reader', [() => { throw new Error('identity unavailable') }], {}],
  ['competing readers', [() => ({ name: 'Sofia', nativeTools: true }), () => ({ name: 'Second', nativeTools: true })], {}],
  ['a workspace session without a Bot', [() => undefined], {}],
]) {
  test(label + ' starts OFF', async t => {
    const h = ompWorld(t, options)
    for (const reader of identities) h.service.botIdentity(reader)
    const chat = h.chat()
    if (options.readOnly) chat.session.append('sandbox/mode', { mode: 'read-only' })
    await chat.turn('plain off-control')
    assert.deepEqual(h.conversation('off-control').args, offArgs(h.overlayPath))
  })
}

test('an omp migration tag cannot enable Claude native tools after a provider change', async t => {
  const h = nativeWorld(t, { identity: () => ({ name: 'Sofia', nativeTools: true, nativeToolsAgent: OMP }) })
  await h.chat('changed-provider').turn('first Claude turn')
  h.assertToolset(0, false)
})

test('an owner turn replaces the running OFF child and replays the same DSH Session', async t => {
  const h = ompWorld(t)
  let on = false
  h.service.botIdentity(() => ({ ...nativeOn(), nativeTools: on }))
  const chat = h.chat()
  const { session } = chat
  session.append('user/message', ownerMessage('plain flip-first'), { surfaceOp: 'append' })
  const firstAnswer = await chat.stream()
  assert.equal(firstAnswer.at(-1).reason.kind, 'stop')
  session.append('assistant/message', { turn: 1, message: createAssistantMessage({
    source: { kind: 'model', provider: OMP, model: 'default' },
    content: [{ type: 'text', text: 'Reply to the first owner turn.' }],
  }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
  const off = h.adapter.live.get(session.id).run
  const first = h.conversation('flip-first')
  on = true
  session.append('turn/start', { turn: 2 })
  session.append('user/message', ownerMessage('plain flip-second'), { surfaceOp: 'append' })
  assert.equal((await chat.stream()).at(-1).reason.kind, 'stop')
  const second = h.conversation('flip-second')
  t.diagnostic(JSON.stringify({ offPid: first.pid, onPid: second.pid, session: session.id, argv: second.args }))
  assert.deepEqual(first.args, offArgs(h.overlayPath))
  assert.deepEqual(second.args, ['acp'])
  assert.notEqual(second.pid, first.pid)
  await off.gone.catch(() => {})
  assert.equal(off.alive, false)
  assert.equal(h.adapter.live.get(session.id).dshAgent.session, session)
  assert.match(second.prompt, /flip-first[\s\S]*Reply to the first owner turn\.[\s\S]*flip-second/)
})

test('a turn without owner input cannot inherit a running ON child', async t => {
  const h = ompWorld(t)
  h.service.botIdentity(nativeOn)
  const chat = h.chat()
  await chat.turn('plain owner-before-schedule')
  const owner = h.conversation('owner-before-schedule')
  await chat.turn(createUserMessage({ content: [{ type: 'text', text: 'plain scheduled-only' }], source: { kind: 'schedule' } }))
  const schedule = h.conversation('scheduled-only')
  assert.deepEqual(owner.args, ['acp'])
  assert.deepEqual(schedule.args, offArgs(h.overlayPath))
  assert.notEqual(schedule.pid, owner.pid)
})

test('a handoff with a user source does not count as owner input', async t => {
  const h = ompWorld(t)
  h.service.botIdentity(nativeOn)
  await h.chat().turn(createUserMessage({
    content: [{ type: 'text', text: 'plain resumed-relay' }],
    source: { kind: 'user', handoff: true, resume: true },
  }))
  assert.deepEqual(h.conversation('resumed-relay').args, offArgs(h.overlayPath))
})

for (const change of ['Read only', 'inherited preset', 'unknown level', 'throwing reader', 'late eligibility loss']) {
  test(`a held ON start stops when policy changes to ${change}`, async t => {
    const h = ompWorld(t)
    let eligible = true
    h.service.botIdentity(() => eligible ? nativeOn() : undefined)
    const chat = h.chat()
    const hold = holdOmpStart(t, h, chat.session.id)
    const late = Promise.withResolvers()
    const resume = Promise.withResolvers()
    if (change === 'late eligibility loss') {
      const heldBack = h.adapter.heldBack.bind(h.adapter)
      let checks = 0
      t.mock.method(h.adapter, 'heldBack', async (...args) => {
        if (++checks === 2) {
          late.resolve()
          await resume.promise
        }
        return heldBack(...args)
      })
    }
    const turn = chat.turn('plain held-policy')
    let run
    try {
      run = await hold.run(turn)
      if (change === 'Read only') chat.policyEvent('sandbox/mode', { mode: 'read-only' })
      else if (change === 'inherited preset') {
        h.services.sandboxPolicy.resolve = () => ({ mode: 'read-only' })
        chat.policyEvent('permission/preset', { preset: 'inherit' })
      } else if (change === 'unknown level') delete h.services.sandboxPolicy
      else if (change === 'throwing reader') h.services.sandboxPolicy.resolve = () => { throw new Error('sandbox unavailable') }
      else {
        hold.release()
        await Promise.race([late.promise, turn.then(() => assert.fail('the turn ended before its final gate'))])
        eligible = false
      }
    } finally {
      hold.release()
      resume.resolve()
    }
    const chunks = await turn
    const onPid = run.child.pid
    const prompts = h.events('prompt')
    t.diagnostic(JSON.stringify({ onPid, alive: run.alive, promptPids: prompts.map(row => row.pid), notice: textBlocks(chunks) }))
    assert.deepEqual(prompts.filter(row => row.pid === onPid || row.text.includes('held-policy')), [])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(textBlocks(chunks), [toolsChanged])
    await run.gone.catch(() => {})
    assert.equal(run.alive, false)
    assert.equal(h.adapter.live.has(chat.session.id), false)
    assert.deepEqual(hold.runs, [run])
    await chat.turn('plain owner-after-policy')
    const off = h.conversation('owner-after-policy')
    t.diagnostic(JSON.stringify({ offPid: off.pid, argv: off.args }))
    assert.notEqual(off.pid, onPid)
    assert.deepEqual(off.args, offArgs(h.overlayPath))
  })
}

for (const concurrentPolicy of [false, true]) {
  test(`Stop during ON startup keeps the existing reason${concurrentPolicy ? ' even when policy changes' : ''}`, async t => {
    const h = ompWorld(t)
    h.service.botIdentity(nativeOn)
    const chat = h.chat()
    chat.session.append('user/message', ownerMessage('plain held-stop'), { surfaceOp: 'append' })
    const controller = new AbortController()
    const hold = holdOmpStart(t, h, chat.session.id)
    const turn = chat.stream({ signal: controller.signal })
    let run
    try {
      run = await hold.run(turn)
      if (concurrentPolicy) chat.policyEvent('sandbox/mode', { mode: 'read-only' })
      controller.abort()
    } finally {
      hold.release()
    }
    const chunks = await turn
    await run.gone.catch(() => {})
    assert.equal(run.alive, false)
    assert.deepEqual(h.events('prompt').filter(row => row.pid === run.child.pid), [])
    assert.deepEqual(textBlocks(chunks), [])
    assert.equal(chunks.at(-1).reason.kind, 'aborted')
    assert.equal(chunks.at(-1).reason.failure.message, 'Stopped')
    assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED')
  })
}

test('an unchanged held ON start receives its prompt on the same child', async t => {
  const h = ompWorld(t)
  h.service.botIdentity(nativeOn)
  const chat = h.chat()
  const hold = holdOmpStart(t, h, chat.session.id)
  const turn = chat.turn('plain unchanged-start')
  let run
  try {
    run = await hold.run(turn)
    assert.deepEqual(h.events('prompt').filter(row => row.pid === run.child.pid), [])
  } finally {
    hold.release()
  }
  const chunks = await turn
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.conversation('unchanged-start').pid, run.child.pid)
  assert.equal(run.alive, true)
  assert.deepEqual(hold.runs, [run])
  t.diagnostic(JSON.stringify({ onPid: run.child.pid, promptPid: h.conversation('unchanged-start').pid, argv: ['acp'] }))
})

test('Read only immediately retires a live ON child and the next owner turn is OFF', async t => {
  const h = ompWorld(t)
  h.service.botIdentity(nativeOn)
  const chat = h.chat()
  const marker = 'hang before-read-only'
  const turn = chat.turn(marker)
  let on
  try {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !h.events('prompt').some(row => row.text.includes(marker))) await delay(20)
    on = h.conversation(marker)
    const { run } = h.adapter.live.get(chat.session.id)
    chat.policyEvent('sandbox/mode', { mode: 'read-only' })
    assert.equal(h.adapter.live.has(chat.session.id), false)
    await run.gone.catch(() => {})
    assert.equal(run.alive, false)
    const chunks = await turn
    const notice = textBlocks(chunks).at(-1)
    t.diagnostic(JSON.stringify({ liveOnPid: on.pid, alive: run.alive, notice }))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(notice, nowReadOnly)
  } finally {
    h.service.endSession(chat.session.id)
    await turn
  }
  await chat.turn('plain after-read-only')
  const off = h.conversation('after-read-only')
  assert.deepEqual(on.args, ['acp'])
  assert.deepEqual(off.args, offArgs(h.overlayPath))
  assert.notEqual(off.pid, on.pid)
  assert.equal(h.events('prompt').filter(row => row.pid === on.pid).length, 1)
})

test('loss of the native identity retires the ON child before the next prompt', async t => {
  const h = ompWorld(t)
  let identity = { name: 'Sofia', nativeTools: true }
  h.service.botIdentity(() => identity)
  const chat = h.chat()
  await chat.turn('plain loss-first')
  const old = h.adapter.live.get('chat').run
  const first = h.conversation('loss-first')
  identity = { name: 'Sofia' }
  await chat.turn('plain loss-second')
  const second = h.conversation('loss-second')
  assert.deepEqual(first.args, ['acp'])
  assert.deepEqual(second.args, offArgs(h.overlayPath))
  assert.notEqual(second.pid, first.pid)
  await old.gone.catch(() => {})
  assert.equal(old.alive, false)
})

test('an unusable overlay fails at the chat launch boundary without spawning a child', async t => {
  const h = ompWorld(t, { overlay: dir => {
    const path = join(dir, 'blocked-overlay')
    mkdirSync(join(path, 'native-off.yml'), { recursive: true })
    return path
  } })
  h.service.botIdentity(() => ({ name: 'Sofia' }))
  await h.service.inspect(OMP)
  const before = h.events('start')
  assert.ok(before.length > 0, 'the catalog probe ran')
  const launch = t.mock.method(h.adapter.agents.get(OMP), 'spawn')
  const chunks = await h.chat().turn('plain cannot-spawn')
  assert.equal(launch.mock.callCount(), 1)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /^omp \(ACP\) did not start:/)
  assert.deepEqual(h.events('start'), before)
  assert.deepEqual(h.events('prompt'), [])
})

for (const [offer, answer] of [
  ['reject-option', { outcome: 'selected', optionId: 'omp-reject' }],
  ['no-reject', { outcome: 'cancelled' }],
]) {
  test(`OFF permission-first request with ${offer} is refused without a DSH dialog`, async t => {
    const h = ompWorld(t)
    h.service.botIdentity(() => ({ name: 'Sofia' }))
    const marker = 'omp-permission-first ' + offer
    const chunks = await h.chat().turn(marker)
    const conversation = h.conversation(marker)
    assert.deepEqual(h.approvals, [])
    assert.deepEqual(h.events('permission-answer'), [{ event: 'permission-answer', pid: conversation.pid, answer }])
    assert.equal(chunks.some(chunk => chunk.block?.type === 'tool-call'), false)
    assert.deepEqual(conversation.args, offArgs(h.overlayPath))
  })
}

for (const kind of ['tool_call', 'tool_call_update']) {
  test(`OFF stops once on a first ${kind} for an unseen ID and starts a fresh OFF child next time`, async t => {
    const h = ompWorld(t)
    h.service.botIdentity(() => ({ name: 'Sofia' }))
    const end = t.mock.method(h.adapter, 'endSession')
    const chat = h.chat()
    const marker = 'omp-first-' + kind
    const chunks = await chat.turn(marker)
    const first = h.conversation(marker)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(textBlocks(chunks), [unexpectedTool])
    assert.deepEqual(end.mock.calls.map(call => call.arguments.slice(0, 3)), [['chat', unexpectedTool, OMP]])
    assert.equal(h.adapter.live.has('chat'), false)
    assert.deepEqual(h.approvals, [])
    await chat.turn('plain new-off-child')
    const second = h.conversation('new-off-child')
    assert.notEqual(second.pid, first.pid)
    assert.deepEqual(first.args, offArgs(h.overlayPath))
    assert.deepEqual(second.args, offArgs(h.overlayPath))
  })
}

test('ON still asks through DSH for a tool and receives the result', async t => {
  const h = ompWorld(t)
  h.service.botIdentity(() => ({ name: 'Sofia', nativeTools: true }))
  const chunks = await h.chat().turn('run it on-permission-control')
  assert.equal(h.approvals.length, 1)
  assert.match(textBlocks(chunks).join(''), /It printed hello/)
  assert.deepEqual(h.conversation('on-permission-control').args, ['acp'])
})

test('team registration during an asynchronous startup gate makes the first launch managed', async t => {
  const h = ompWorld(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.mock.method(h.adapter, 'access', async () => { entered.resolve(); await release.promise })
  const answer = h.chat().turn('plain late-registration')
  await entered.promise
  h.service.botIdentity(() => undefined)
  release.resolve()
  await answer
  assert.deepEqual(h.conversation('late-registration').args, offArgs(h.overlayPath))
})

for (const [label, identity, input, options] of [
  ['Workspace without a Bot identity', () => undefined],
  ['Bot default OFF', () => ({ name: 'Sofia' })],
  ['Bot saved OFF', () => ({ ...nativeOn(), nativeTools: false })],
  ['Bot saved ON with no owner input', nativeOn, { kind: 'schedule' }],
  ['Bot saved ON with another provider tag', () => ({ ...nativeOn(), nativeToolsAgent: 'acp-claude' })],
  ['Bot saved ON with unknown level', nativeOn, undefined, { sandbox: false }],
]) {
  test(`late team registration stops a held omp start for ${label}`, async t => {
    const h = ompWorld(t, options)
    const chat = h.chat()
    const hold = holdOmpStart(t, h, chat.session.id)
    const marker = 'plain late-team-start'
    const turn = chat.turn(input ? createUserMessage({ content: [{ type: 'text', text: marker }], source: input }) : marker)
    let run
    try {
      run = await hold.run(turn)
      assert.ok(run.alive)
      assert.ok(h.events('new-session').some(row => row.pid === run.child.pid))
      assert.equal(h.adapter.live.get(chat.session.id).nativeOff, undefined)
      assert.deepEqual(h.events('prompt'), [])
      h.service.botIdentity(identity)
    } finally {
      hold.release()
    }
    const chunks = await turn
    const legacyPid = run.child.pid
    const promptPids = h.events('prompt').map(row => row.pid)
    t.diagnostic(JSON.stringify({ legacyPid, argv: run.spec.args, promptPids, notice: textBlocks(chunks), alive: run.alive, exit: run.exited }))
    assert.deepEqual(promptPids, [])
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(textBlocks(chunks), [toolsChanged])
    await run.gone.catch(() => {})
    assert.ok(run.exited)
    assert.equal(run.alive, false)
    assert.equal(h.adapter.live.has(chat.session.id), false)
    assert.deepEqual(hold.runs, [run])

    // The scheduled turn was denied because it lacked owner input. A genuine owner
    // message with the saved ON choice should now be eligible, unlike the other cases.
    const nextOn = input?.kind === 'schedule'
    const next = await chat.turn('plain owner-after-registration')
    const child = h.conversation('owner-after-registration')
    const replacement = h.adapter.live.get(chat.session.id)
    t.diagnostic(JSON.stringify({ legacyPid, exit: run.exited, nextPid: child.pid, argv: child.args, servers: child.servers, provider: replacement.provider }))
    assert.equal(next.at(-1).reason.kind, 'stop')
    assert.notEqual(child.pid, legacyPid)
    assert.deepEqual(child.args, nextOn ? ['acp'] : offArgs(h.overlayPath))
    assert.deepEqual(child.servers, [])
    assert.equal(replacement.provider, OMP)
    assert.equal(replacement.run.spec.dshTools, false)
    assert.equal(replacement.run.spec.refuseTools === true, !nextOn)
  })
}

for (const [label, register, stop] of [
  ['standalone without registration', undefined, false],
  ['newly managed with eligible saved ON', nativeOn, false],
  ['explicit Stop during late registration', () => ({ name: 'Sofia' }), true],
]) {
  test(`a held omp start honors ${label}`, async t => {
    const h = ompWorld(t)
    const chat = h.chat()
    const controller = new AbortController()
    const hold = holdOmpStart(t, h, chat.session.id)
    const marker = 'held-registration-control'
    const turn = stop
      ? chat.stream({ messages: [ownerMessage(marker)], signal: controller.signal })
      : chat.turn(marker)
    let run
    try {
      run = await hold.run(turn)
      if (register) h.service.botIdentity(register)
      if (stop) controller.abort()
    } finally {
      hold.release()
    }
    const chunks = await turn
    const reason = chunks.at(-1).reason
    if (stop) {
      await run.gone.catch(() => {})
      assert.ok(run.exited)
      assert.deepEqual(h.events('prompt'), [])
      assert.deepEqual(textBlocks(chunks), [])
      assert.equal(reason.kind, 'aborted')
      assert.equal(reason.failure.message, 'Stopped')
      assert.equal(reason.failure.code, 'ABORTED')
    } else {
      assert.equal(reason.kind, 'stop')
      assert.match(textBlocks(chunks).join(''), /It printed hello/)
      assert.equal(h.conversation(marker).pid, run.child.pid)
      assert.equal(run.spec.refuseTools, undefined)
    }
    assert.deepEqual(hold.runs, [run])
    t.diagnostic(JSON.stringify({ pid: run.child.pid, promptPids: h.events('prompt').map(row => row.pid), reason, exit: run.exited }))
  })
}

test('a forbidden notification from a retired OFF child cannot stop its replacement', async t => {
  const h = ompWorld(t)
  h.service.botIdentity(() => ({ name: 'Sofia' }))
  const chat = h.chat()
  await chat.turn('plain retired-child')
  const retired = h.adapter.live.get('chat').run
  const late = retired.spec.onForbiddenTool
  assert.equal(typeof late, 'function')
  h.service.endSession('chat')
  await chat.turn('plain replacement-child')
  const replacement = h.adapter.live.get('chat')
  assert.notEqual(replacement.run, retired)
  late()
  assert.equal(h.adapter.live.get('chat'), replacement)
  await chat.turn('plain still-running-child')
  assert.equal(h.conversation('still-running-child').pid, h.conversation('replacement-child').pid)
})
