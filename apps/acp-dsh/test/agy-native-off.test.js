// Antigravity with the Bot team's native-tools switch (#1564, RFC 0003 "Amendment: Antigravity
// native tools"): the OFF launch (our agent and settings folder, written into the child's own
// home), the hooks and plugins refusals, the check of agy's own log at the start and before each
// later prompt, the version warning, and the capability the Bot team reads. A fake agy only.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AGY_FRESH_TEXT, AGY_HOOKS_TEXT, AGY_NOT_LOADED_TEXT, AGY_OFF_AGENT, AGY_OFF_CHECKED, AGY_OFF_SETTINGS, AGY_PLUGINS_TEXT,
  AGY_TOOLS_OFF_TEXT, AGY_UNCHECKED_LOG, agyExtensionRefusal, agyOffPaths, readAgyLog,
} from '../src/host/agy-off.js'
import { AGENTS } from '../src/host/agents.js'
import { CliHomes } from '../src/host/cli-homes.js'
import { AGY, AGY_OFF_ARGS, agyWorld, BOOT, FAILED, MALFORMED, unixOnly } from './fixtures/agy-world.js'

const textBlocks = chunks => chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => chunk.block.text)
const nativeOn = () => ({ name: 'Sofia', nativeTools: true, nativeToolsAgent: AGY })
const offBot = () => ({ name: 'Sofia' })
const unchecked = logs => logs.filter(line => line === `acp-dsh: ${AGY_UNCHECKED_LOG}`)
const failure = chunks => chunks.at(-1).reason.failure?.message
const offRefusal = text => (process.platform === 'win32' ? text : `${text} ${AGY_FRESH_TEXT}`)

// One OFF turn on a fresh world, after the catalog probe: what it answered and what it started.
async function offTurn(t, marker, { log, before, options } = {}) {
  const h = agyWorld(t, options)
  h.service.botIdentity(offBot)
  await h.service.inspect(AGY)
  if (log !== undefined) h.setLog(log)
  before?.(h)
  const starts = h.events('start').length
  const chunks = await h.chat().turn(marker)
  return { h, chunks, started: h.startsAfter(starts) }
}

test('1: OFF starts agy with our agent and settings folder, written in its own home with their modes', unixOnly, async t => {
  const { h, chunks, started } = await offTurn(t, 'plain off-files')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.conversation('off-files').args, AGY_OFF_ARGS)
  assert.equal(started.length, 1)
  const paths = agyOffPaths(h.home())
  assert.equal(readFileSync(paths.agentFile, 'utf8'), AGY_OFF_AGENT)
  assert.equal(readFileSync(paths.settingsFile, 'utf8'), AGY_OFF_SETTINGS)
  assert.equal(statSync(paths.agentFile).mode & 0o777, 0o600)
  assert.equal(statSync(paths.settingsFile).mode & 0o777, 0o600)
  assert.equal(statSync(paths.agentDir).mode & 0o777, 0o700)
  assert.equal(statSync(paths.settingsDir).mode & 0o777, 0o700)
  assert.deepEqual(JSON.parse(AGY_OFF_SETTINGS).permissions.deny,
    ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'command(*)', 'mcp(*)'])
  assert.deepEqual(h.logs.filter(line => /Antigravity/.test(line)), [])
})

for (const [label, identity] of [['no Bot team', undefined], ['a Bot saved ON for Antigravity', nativeOn]]) {
  test(`2: ${label} starts plain agy acp and writes nothing`, unixOnly, async t => {
    const h = agyWorld(t)
    if (identity) h.service.botIdentity(identity)
    await h.service.inspect(AGY)
    const chunks = await h.chat().turn('plain on-control')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(h.conversation('on-control').args, ['acp'])
    const paths = agyOffPaths(h.home())
    assert.equal(existsSync(paths.agentFile), false)
    assert.equal(existsSync(paths.settingsDir), false)
  })
}

test('3: with no isolated home OFF refuses before any child', unixOnly, async t => {
  const { h, chunks, started } = await offTurn(t, 'plain no-home', { options: { cliHome: false } })
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(failure(chunks), 'Antigravity (ACP) did not start: Antigravity could not start with its tools off: it has no settings folder.')
  assert.deepEqual(started, [])
  assert.deepEqual(h.events('prompt'), [])
})

test('3: a file that cannot be written fails the start before any child', unixOnly, async t => {
  const { h, chunks, started } = await offTurn(t, 'plain blocked-file', {
    before: h => mkdirSync(join(agyOffPaths(h.home()).agentFile, 'in-the-way'), { recursive: true }),
  })
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.match(failure(chunks), /^Antigravity \(ACP\) did not start:/)
  assert.deepEqual(started, [])
  assert.deepEqual(h.events('prompt'), [])
})

test('3b: the OFF files go to the home the child runs in, not the one selected later', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  await h.service.inspect(AGY)
  const other = join(h.dir, 'generation-a')
  t.mock.method(CliHomes.prototype, 'home', () => other)
  const chunks = await h.chat().turn('plain split-home')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const runs = h.envs().filter(row => row.pid === h.conversation('split-home').pid)
  const home = runs[0].values.HOME
  assert.notEqual(home, other)
  assert.equal(readFileSync(agyOffPaths(home).agentFile, 'utf8'), AGY_OFF_AGENT)
  assert.equal(readFileSync(agyOffPaths(home).settingsFile, 'utf8'), AGY_OFF_SETTINGS)
  assert.equal(existsSync(join(other, '.gemini')), false)
})

test('3b: a child environment whose HOME is not its isolated home refuses before any child', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  await h.service.inspect(AGY)
  const environment = CliHomes.prototype.environment
  t.mock.method(CliHomes.prototype, 'environment', function (...args) {
    return { ...environment.apply(this, args), HOME: join(h.dir, 'elsewhere') }
  })
  const starts = h.events('start').length
  const chunks = await h.chat().turn('plain mismatched-home')
  assert.equal(failure(chunks), 'Antigravity (ACP) did not start: Antigravity could not start with its tools off: its home did not match.')
  assert.deepEqual(h.startsAfter(starts), [])
})

for (const kind of ['tool_call', 'tool_call_update']) {
  test(`4: OFF ends the answer at a first ${kind} with Antigravity's own sentence`, unixOnly, async t => {
    const h = agyWorld(t)
    h.service.botIdentity(offBot)
    const chat = h.chat()
    const chunks = await chat.turn(`omp-first-${kind}`)
    assert.deepEqual(h.conversation(`omp-first-${kind}`).args, AGY_OFF_ARGS)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.deepEqual(textBlocks(chunks), [AGY_TOOLS_OFF_TEXT])
    assert.equal(h.adapter.live.has('chat'), false)
    assert.deepEqual(h.approvals, [])
  })
}

test('4: OFF refuses an ask without a DSH dialog', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  const chunks = await h.chat().turn('omp-permission-first')
  const conversation = h.conversation('omp-permission-first')
  assert.deepEqual(conversation.args, AGY_OFF_ARGS)
  assert.deepEqual(h.approvals, [])
  assert.deepEqual(h.events('permission-answer'), [{ event: 'permission-answer', pid: conversation.pid, answer: { outcome: 'selected', optionId: 'omp-reject' } }])
  assert.equal(chunks.some(chunk => chunk.block?.type === 'tool-call'), false)
})

test('5: Read only retires a live ON agy child and the next turn starts OFF', unixOnly, async t => {
  const h = agyWorld(t)
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
  } finally {
    h.service.endSession(chat.session.id)
    await turn
  }
  await chat.turn('plain after-read-only')
  assert.deepEqual(on.args, ['acp'])
  assert.deepEqual(h.conversation('after-read-only').args, AGY_OFF_ARGS)
})

test('6: an ON saved for omp does not start agy ON', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(() => ({ name: 'Sofia', nativeTools: true, nativeToolsAgent: 'acp-omp' }))
  await h.chat().turn('plain omp-tag')
  assert.deepEqual(h.conversation('omp-tag').args, AGY_OFF_ARGS)
})

test('7: endOmpSession ends a live ON agy child and leaves an OFF one', unixOnly, async t => {
  const h = agyWorld(t)
  let identity = nativeOn()
  h.service.botIdentity(() => identity)
  const on = h.chat('on-chat')
  await on.turn('plain on-child')
  const onRun = h.adapter.live.get('on-chat').run
  identity = offBot()
  const off = h.chat('off-chat')
  await off.turn('plain off-child')
  assert.deepEqual(h.conversation('off-child').args, AGY_OFF_ARGS)
  assert.equal(h.service.endOmpSession('off-chat', 'Native tools were turned off.'), false)
  assert.equal(h.adapter.live.has('off-chat'), true)
  assert.equal(h.service.endOmpSession('on-chat', 'Native tools were turned off.'), true)
  assert.equal(h.adapter.live.has('on-chat'), false)
  await onRun.gone.catch(() => {})
  assert.equal(onRun.alive, false)
})

test('8: a fresh log of the child with no failure line answers with no warning', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain clean-log', { log: { lines: [BOOT] } })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(unchecked(h.logs), [])
})

for (const [label, line] of [['missing', FAILED], ['malformed', MALFORMED]]) {
  test(`8: agy saying it did not load its settings (${label}) refuses before the first prompt`, unixOnly, async t => {
    const { h, chunks, started } = await offTurn(t, 'plain failed-log', { log: { lines: [BOOT, line] } })
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${AGY_NOT_LOADED_TEXT}`)
    assert.equal(started.length, 1)
    assert.deepEqual(h.events('prompt'), [])
    assert.equal(h.adapter.live.has('chat'), false)
  })
}

test('8: a failure line in another process\'s file is not this child\'s', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain other-pid', {
    log: { lines: [BOOT] },
    before: h => {
      mkdirSync(h.logDir(), { recursive: true })
      writeFileSync(join(h.logDir(), 'acp-server-20261124_021000-1.log'), `${FAILED}\n`)
    },
  })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(unchecked(h.logs), [])
})

test('8: no log folder answers and warns once', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain no-log', { log: {} })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(unchecked(h.logs).length, 1)
})

test('8: the child\'s log as a link to a large file refuses at once', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain link-log', {
    before: h => {
      writeFileSync(join(h.dir, 'big'), Buffer.alloc(8 * 1024 * 1024, 0x61))
      h.setLog({ link: join(h.dir, 'big') })
    },
  })
  assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${AGY_NOT_LOADED_TEXT}`)
  assert.deepEqual(h.events('prompt'), [])
})

test('8: the child\'s log as a FIFO refuses at once, with no hang', unixOnly, async t => {
  const at = Date.now()
  const { h, chunks } = await offTurn(t, 'plain fifo-log', { log: { fifo: true } })
  assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${AGY_NOT_LOADED_TEXT}`)
  assert.deepEqual(h.events('prompt'), [])
  assert.ok(Date.now() - at < 10_000)
})

test('8: an older file of the same pid with the failure line is ignored next to a fresh clean one', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain old-and-fresh', { log: { old: { lines: [FAILED] }, lines: [BOOT] } })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(unchecked(h.logs), [])
})

test('8: only an older file of the same pid warns and answers', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain only-old', { log: { old: { lines: [FAILED] } } })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(unchecked(h.logs).length, 1)
})

test('8: a fresh file whose name stamp reads a day old is still this start\'s', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain skewed-stamp', { log: { stampDaysBack: 1, lines: [BOOT] } })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(unchecked(h.logs), [])
  const failed = await offTurn(t, 'plain skewed-failed', { log: { stampDaysBack: 1, lines: [BOOT, FAILED] } })
  assert.equal(failure(failed.chunks), `Antigravity (ACP) did not start: ${AGY_NOT_LOADED_TEXT}`)
})

test('8: more than 4096 entries in the log folder warns and answers', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain crowded-log', {
    log: { lines: [BOOT, FAILED] },
    before: h => {
      mkdirSync(h.logDir(), { recursive: true })
      for (let n = 0; n < 4097; n++) writeFileSync(join(h.logDir(), `other-${n}.txt`), '')
    },
  })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(unchecked(h.logs).length, 1)
})

test('8: a failure line written after the first answer is not caught at the start (no marker)', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain late-line', { log: { lines: [BOOT], late: { ms: 300, lines: [FAILED] } } })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(unchecked(h.logs), [])
})

test('8: the read is bounded and never follows a link (unit)', unixOnly, async t => {
  const h = agyWorld(t)
  const home = join(h.dir, 'unit-home')
  const folder = agyOffPaths(home).logDir
  mkdirSync(folder, { recursive: true })
  assert.equal(readAgyLog(home, 'not-a-pid', Date.now()), 'unchecked')
  assert.equal(readAgyLog(join(h.dir, 'nowhere'), 4242, Date.now()), 'unchecked')
  writeFileSync(join(folder, 'acp-server-20261124_022134-4242.log'), `${BOOT}\n`)
  assert.equal(readAgyLog(home, 4242, Date.now()), 'clean')
  assert.equal(readAgyLog(home, 424, Date.now()), 'unchecked')
  // The failure text past 256 KiB is not read.
  writeFileSync(join(folder, 'acp-server-20261124_022135-4343.log'), `${'x'.repeat(256 * 1024)}\n${FAILED}\n`)
  assert.equal(readAgyLog(home, 4343, Date.now()), 'clean')
  symlinkSync(join(folder, 'acp-server-20261124_022134-4242.log'), join(folder, 'acp-server-20261124_022136-4444.log'))
  assert.ok(lstatSync(join(folder, 'acp-server-20261124_022136-4444.log')).isSymbolicLink())
  assert.equal(readAgyLog(home, 4444, Date.now()), 'failed')
})

test('8b: a failure line after the first turn ends the kept child before the next prompt', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  const chat = h.chat()
  await chat.turn('plain recheck-first')
  const first = h.conversation('recheck-first')
  assert.deepEqual(first.args, AGY_OFF_ARGS)
  const run = h.adapter.live.get('chat').run
  writeFileSync(h.logOf(first.pid), `${BOOT}\n${FAILED}\n`, { flag: 'a' })
  const chunks = await chat.turn('plain recheck-second')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(failure(chunks), AGY_NOT_LOADED_TEXT)
  assert.equal(h.events('prompt').filter(row => row.text.includes('recheck-second')).length, 0)
  assert.equal(h.events('prompt').filter(row => row.pid === first.pid).length, 1)
  assert.equal(h.adapter.live.has('chat'), false)
  await run.gone.catch(() => {})
  assert.equal(run.alive, false)
  // The next turn starts a new child, which is checked at its own start.
  await chat.turn('plain recheck-third')
  const third = h.conversation('recheck-third')
  assert.notEqual(third.pid, first.pid)
  assert.deepEqual(third.args, AGY_OFF_ARGS)
})

test('8b: a kept clean child is checked again and answers', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  const chat = h.chat()
  await chat.turn('plain kept-first')
  const chunks = await chat.turn('plain kept-second')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(h.conversation('kept-first').pid, h.conversation('kept-second').pid)
})

test('9: another agy version starts OFF and warns once; Details names the checked one', unixOnly, async t => {
  const h = agyWorld(t, { version: '9.9.9' })
  h.service.botIdentity(offBot)
  const first = await h.chat('one').turn('plain version-one')
  const second = await h.chat('two').turn('plain version-two')
  assert.equal(first.at(-1).reason.kind, 'stop')
  assert.equal(second.at(-1).reason.kind, 'stop')
  const warned = h.logs.filter(line => line.includes('runs with native tools off'))
  assert.deepEqual(warned, [`acp-dsh: Antigravity 9.9.9 runs with native tools off; native tools off was checked on agy ${AGY_OFF_CHECKED} only`])
  assert.deepEqual(h.service.nativeOffNotes(AGY), { unchecked: AGY_OFF_CHECKED })
  assert.equal(h.service.nativeOffNotes('acp-omp'), undefined)
})

test('9: the checked agy version gives no warning and no Details line', unixOnly, async t => {
  const h = agyWorld(t, { version: AGY_OFF_CHECKED })
  h.service.botIdentity(offBot)
  await h.chat().turn('plain version-checked')
  assert.deepEqual(h.logs.filter(line => line.includes('runs with native tools off')), [])
  assert.deepEqual(h.service.nativeOffNotes(AGY), {})
})

test('9: an ON start records the version too and never throws for it', unixOnly, async t => {
  const h = agyWorld(t, { version: '9.9.9' })
  const chunks = await h.chat().turn('plain version-on')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.conversation('version-on').args, ['acp'])
  assert.deepEqual(h.service.nativeOffNotes(AGY), { unchecked: AGY_OFF_CHECKED })
  assert.deepEqual(h.logs.filter(line => line.includes('runs with native tools off')), [])
})

test('10: with a Bot team, a Session with no Bot identity is chat only; with none, as today', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(() => undefined)
  const chunks = await h.chat('workspace').turn('omp-first-tool_call workspace')
  assert.deepEqual(h.conversation('workspace').args, AGY_OFF_ARGS)
  assert.deepEqual(textBlocks(chunks), [AGY_TOOLS_OFF_TEXT])
  const plain = agyWorld(t)
  await plain.chat().turn('plain no-team')
  assert.deepEqual(plain.conversation('no-team').args, ['acp'])
})

test(`11: agy acp --help (captured from agy ${AGY_OFF_CHECKED}) lists every OFF flag`, () => {
  // Checks the text captured from the agy version in AGY_OFF_CHECKED, not the agy on a person's
  // computer; a later agy is covered by the version warning and acp-dsh's own guard.
  const help = readFileSync(join(import.meta.dirname, 'fixtures', `agy-acp-help-${AGY_OFF_CHECKED}.txt`), 'utf8')
  assert.match(help, /^\s+--cli_dir_name\b/m)
  assert.match(help, /^\s+--agent\b/m)
  const flags = AGENTS[AGY].offArgs.filter(arg => arg.startsWith('--'))
  assert.deepEqual(flags, ['--agent', '--cli_dir_name'])
  for (const flag of flags) assert.match(help, new RegExp(`^\\s+${flag}\\s`, 'm'), flag)
})

for (const [what, make] of [
  ['a file', path => writeFileSync(path, '{}')],
  ['a folder', path => mkdirSync(path)],
  ['a dangling link', path => symlinkSync(join(path, '..', 'missing-target'), path)],
]) {
  for (const [name, text] of [['hooks.json', AGY_HOOKS_TEXT], ['plugins', AGY_PLUGINS_TEXT]]) {
    test(`12: ${name} as ${what} in agy's home refuses OFF before any child`, unixOnly, async t => {
      const h = agyWorld(t)
      h.service.botIdentity(offBot)
      await h.service.inspect(AGY)
      const config = join(h.home(), '.gemini', 'config')
      mkdirSync(config, { recursive: true })
      make(join(config, name))
      assert.deepEqual(h.service.nativeOffNotes(AGY), name === 'plugins' ? { plugins: true, fresh: true } : { hooks: true, fresh: true })
      const starts = h.events('start').length
      const chunks = await h.chat().turn('plain extension-refused')
      assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${offRefusal(text)}`)
      assert.deepEqual(h.startsAfter(starts), [])
      assert.deepEqual(h.events('prompt'), [])
    })
  }
}

test('12: with neither, OFF starts and Details has no line', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  await h.service.inspect(AGY)
  assert.deepEqual(h.service.nativeOffNotes(AGY), {})
  const chunks = await h.chat().turn('plain no-extensions')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('12: the refusal names Switch account only off Windows; hooks come first', t => {
  const h = agyWorld(t)
  const home = join(h.dir, 'unit-home')
  assert.equal(agyExtensionRefusal(home), undefined)
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true })
  writeFileSync(join(home, '.gemini', 'config', 'hooks.json'), '{}')
  assert.equal(agyExtensionRefusal(home, { platform: 'linux' }), `${AGY_HOOKS_TEXT} ${AGY_FRESH_TEXT}`)
  assert.equal(agyExtensionRefusal(home, { platform: 'win32' }), AGY_HOOKS_TEXT)
  assert.deepEqual(readdirSync(join(home, '.gemini', 'config', 'plugins')), [])
})

test('13: acp-dsh lists the agents whose switch is their launch args', t => {
  const h = agyWorld(t)
  assert.deepEqual(h.service.nativeArgsAgents, ['acp-antigravity', 'acp-omp'])
  assert.ok(Object.isFrozen(h.service.nativeArgsAgents))
})
