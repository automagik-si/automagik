// Antigravity with the Bot team's native-tools switch (#1564, RFC 0003 "Amendment: Antigravity
// native tools"): the OFF launch (our agent and settings folder, written into the child's own
// home), the hooks and plugins refusals, the check of agy's own log at the start and before each
// later prompt, the version warning, and the capability the Bot team reads. A fake agy only.
import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, lutimesSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AGY_FRESH_TEXT, AGY_HOOKS_TEXT, AGY_NOT_LOADED_TEXT, AGY_OFF_AGENT, AGY_OFF_CHECKED, AGY_OFF_SETTINGS, AGY_PLUGINS_TEXT,
  AGY_TOOLS_OFF_TEXT, AGY_UNCHECKED_LOG, agyExtensionRefusal, agyOffPaths, pruneAgyLog, readAgyLog,
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
  // Timed from the turn itself, not the world's setup: the plan's bound is 2 s.
  let at
  const { h, chunks } = await offTurn(t, 'plain fifo-log', { log: { fifo: true }, before: () => { at = Date.now() } })
  assert.ok(Date.now() - at < 2_000, `the turn took ${Date.now() - at} ms`)
  assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${AGY_NOT_LOADED_TEXT}`)
  assert.deepEqual(h.events('prompt'), [])
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

// Our own log folder gains one file per OFF start: each start first removes the regular files with
// agy's log name more than 24 hours old (#1564 AJ-3), so past starts never fill the 4096 bound.
const TWO_DAYS_AGO = (Date.now() - 2 * 24 * 60 * 60_000) / 1000

test('8: an OFF start removes old log files first, so a crowd of past starts still refuses a failure', unixOnly, async t => {
  const old = n => `acp-server-20261120_000000-${900000 + n}.log`
  const { h, chunks } = await offTurn(t, 'plain pruned-log', {
    log: { lines: [BOOT, FAILED] },
    before: h => {
      mkdirSync(h.logDir(), { recursive: true })
      for (let n = 0; n < 4097; n++) {
        writeFileSync(join(h.logDir(), old(n)), `${BOOT}\n`)
        utimesSync(join(h.logDir(), old(n)), TWO_DAYS_AGO, TWO_DAYS_AGO)
      }
    },
  })
  assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${AGY_NOT_LOADED_TEXT}`)
  assert.deepEqual(h.events('prompt'), [])
  assert.deepEqual(unchecked(h.logs), [])
  // One prune reads at most 4096 entries: of the 4097 old files one is left for the next start,
  // next to this start's own log.
  const left = readdirSync(h.logDir())
  assert.equal(left.filter(name => name.startsWith('acp-server-20261120_000000-')).length, 1)
  assert.equal(left.length, 2)
})

test('8: the prune removes only old regular files with agy\'s log name, and never throws (unit)', unixOnly, async t => {
  const h = agyWorld(t)
  const home = join(h.dir, 'prune-home')
  // No folder, or no home at all: nothing to do, no throw.
  pruneAgyLog(home)
  pruneAgyLog(join(h.dir, 'nowhere'))
  const folder = agyOffPaths(home).logDir
  mkdirSync(folder, { recursive: true })
  const at = name => join(folder, name)
  const aged = path => utimesSync(path, TWO_DAYS_AGO, TWO_DAYS_AGO)
  writeFileSync(at('acp-server-20261120_000000-11.log'), 'old\n')
  aged(at('acp-server-20261120_000000-11.log'))
  writeFileSync(at('acp-server-20261124_000000-12.log'), 'fresh\n')
  for (const other of ['other.txt', 'acp-server-x-13.log', 'acp-server-20261120_000000-14.log.bak']) {
    writeFileSync(at(other), 'not ours\n')
    aged(at(other))
  }
  // A folder and a link with the log name are never removed, nor what the link points to.
  mkdirSync(at('acp-server-20261120_000000-15.log'))
  aged(at('acp-server-20261120_000000-15.log'))
  writeFileSync(join(h.dir, 'outside.log'), 'outside\n')
  aged(join(h.dir, 'outside.log'))
  symlinkSync(join(h.dir, 'outside.log'), at('acp-server-20261120_000000-16.log'))
  lutimesSync(at('acp-server-20261120_000000-16.log'), TWO_DAYS_AGO, TWO_DAYS_AGO)
  pruneAgyLog(home)
  assert.deepEqual(readdirSync(folder).sort(), [
    'acp-server-20261120_000000-14.log.bak', 'acp-server-20261120_000000-15.log', 'acp-server-20261120_000000-16.log',
    'acp-server-20261124_000000-12.log', 'acp-server-x-13.log', 'other.txt',
  ])
  assert.equal(readFileSync(join(h.dir, 'outside.log'), 'utf8'), 'outside\n')
  // 24 hours is measured from `now`: a day and a minute later the fresh one goes too.
  pruneAgyLog(home, Date.now() + 24 * 60 * 60_000 + 60_000)
  assert.equal(existsSync(at('acp-server-20261124_000000-12.log')), false)
})

// A kept OFF child can sit idle for more than a day: its log must still be there for its next
// turn's check, however old (#1564 AK-1). Once it has ended, its old log goes like any other.
test('8: the prune keeps the day-old log of a live kept OFF child, and its next turn still checks it', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  const idle = h.chat('idle')
  await idle.turn('plain idle-first')
  const first = h.conversation('idle-first')
  assert.deepEqual(first.args, AGY_OFF_ARGS)
  const run = h.adapter.live.get('idle').run
  const file = h.logOf(first.pid)
  utimesSync(file, TWO_DAYS_AGO, TWO_DAYS_AGO)
  // Another OFF start in the same home prunes first: the live child's old log stays as it was.
  const other = await h.chat('other').turn('plain idle-other')
  assert.equal(other.at(-1).reason.kind, 'stop')
  assert.notEqual(h.conversation('idle-other').pid, first.pid)
  assert.equal(h.logOf(first.pid), file)
  assert.equal(readFileSync(file, 'utf8'), `${BOOT}\n`)
  // agy logs the failure late: the idle child's next turn finds it and ends that child.
  writeFileSync(file, `${FAILED}\n`, { flag: 'a' })
  const chunks = await idle.turn('plain idle-second')
  assert.equal(failure(chunks), AGY_NOT_LOADED_TEXT)
  assert.equal(h.events('prompt').filter(row => row.text.includes('idle-second')).length, 0)
  await run.gone.catch(() => {})
  assert.equal(run.alive, false)
  // That child has ended: the next OFF start removes its old log.
  utimesSync(file, TWO_DAYS_AGO, TWO_DAYS_AGO)
  await h.chat('third').turn('plain idle-third')
  assert.equal(h.logOf(first.pid), undefined)
})

test('8: the prune keeps old files whose pid is live (unit)', unixOnly, async t => {
  const h = agyWorld(t)
  const home = join(h.dir, 'live-home')
  const folder = agyOffPaths(home).logDir
  mkdirSync(folder, { recursive: true })
  for (const pid of [21, 22, 23]) {
    writeFileSync(join(folder, `acp-server-20261120_000000-${pid}.log`), 'old\n')
    utimesSync(join(folder, `acp-server-20261120_000000-${pid}.log`), TWO_DAYS_AGO, TWO_DAYS_AGO)
  }
  pruneAgyLog(home, Date.now(), new Set([21, '23']))
  assert.deepEqual(readdirSync(folder).sort(), ['acp-server-20261120_000000-21.log', 'acp-server-20261120_000000-23.log'])
})

// A `log` that is a link is never followed, by the prune or by the read (#1564 AK-2): the read
// counts it as no log (a warning), the prune removes nothing through it.
test('8: a log folder that is a link is neither pruned nor read (unit)', unixOnly, async t => {
  const h = agyWorld(t)
  const home = join(h.dir, 'linked-home')
  const target = join(h.dir, 'elsewhere')
  mkdirSync(target)
  writeFileSync(join(target, 'acp-server-20261120_000000-31.log'), 'old\n')
  utimesSync(join(target, 'acp-server-20261120_000000-31.log'), TWO_DAYS_AGO, TWO_DAYS_AGO)
  writeFileSync(join(target, 'acp-server-20261124_022134-32.log'), `${BOOT}\n${FAILED}\n`)
  const folder = agyOffPaths(home).logDir
  mkdirSync(join(folder, '..'), { recursive: true })
  symlinkSync(target, folder)
  pruneAgyLog(home)
  assert.deepEqual(readdirSync(target).sort(), ['acp-server-20261120_000000-31.log', 'acp-server-20261124_022134-32.log'])
  assert.equal(readAgyLog(home, 32, Date.now()), 'unchecked')
  // A file in the log folder's place: no log either.
  const plain = join(h.dir, 'file-home')
  mkdirSync(join(agyOffPaths(plain).logDir, '..'), { recursive: true })
  writeFileSync(agyOffPaths(plain).logDir, `${FAILED}\n`)
  assert.equal(readAgyLog(plain, 32, Date.now()), 'unchecked')
  pruneAgyLog(plain)
  assert.equal(readFileSync(agyOffPaths(plain).logDir, 'utf8'), `${FAILED}\n`)
})

test('8: an OFF start whose log folder is a link warns once and answers, never reading through it', unixOnly, async t => {
  const { h, chunks } = await offTurn(t, 'plain linked-folder', {
    log: { lines: [BOOT, FAILED] },
    before: h => {
      const target = join(h.dir, 'linked-log')
      mkdirSync(target)
      mkdirSync(join(h.logDir(), '..'), { recursive: true })
      symlinkSync(target, h.logDir())
    },
  })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(unchecked(h.logs).length, 1)
  // agy itself wrote its failure line through the link: only the check refused to follow it.
  assert.ok(readdirSync(join(h.dir, 'linked-log')).some(name => name.endsWith(`-${h.conversation('linked-folder').pid}.log`)))
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

test('8: a file swapped in between the folder read and the open is refused (unit)', unixOnly, async t => {
  const h = agyWorld(t)
  const home = join(h.dir, 'swap-home')
  const folder = agyOffPaths(home).logDir
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'acp-server-20261124_022134-4545.log'), `${BOOT}\n`)
  writeFileSync(join(h.dir, 'other.log'), `${BOOT}\n`)
  const opened = []
  const open = (path, flags) => { opened.push(path); return openSync(path, flags) }
  assert.equal(readAgyLog(home, 4545, Date.now(), { open }), 'clean')
  // Another regular file's fd (not the device and inode lstat saw): failed, never read.
  const swapped = (_path, flags) => openSync(join(h.dir, 'other.log'), flags)
  assert.equal(readAgyLog(home, 4545, Date.now(), { open: swapped }), 'failed')
  assert.deepEqual(opened, [join(folder, 'acp-server-20261124_022134-4545.log')])
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
  assert.deepEqual(h.service.nativeOffNotes(AGY), { unchecked: AGY_OFF_CHECKED, skillsUnavailable: true })
  assert.equal(h.service.nativeOffNotes('acp-omp'), undefined)
})

test('9: the checked agy version gives no version warning and does not prove Skills availability', unixOnly, async t => {
  const h = agyWorld(t, { version: AGY_OFF_CHECKED })
  h.service.botIdentity(offBot)
  await h.chat().turn('plain version-checked')
  assert.deepEqual(h.logs.filter(line => line.includes('runs with native tools off')), [])
  assert.deepEqual(h.service.nativeOffNotes(AGY), { skillsUnavailable: true })
})

test('9: an ON start records the version too and never throws for it', unixOnly, async t => {
  const h = agyWorld(t, { version: '9.9.9' })
  const chunks = await h.chat().turn('plain version-on')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.conversation('version-on').args, ['acp'])
  assert.deepEqual(h.service.nativeOffNotes(AGY), { unchecked: AGY_OFF_CHECKED, skillsUnavailable: true })
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
      assert.deepEqual(h.service.nativeOffNotes(AGY), {
        [name === 'plugins' ? 'plugins' : 'hooks']: true, fresh: true, skillsUnavailable: true,
      })
      const starts = h.events('start').length
      const chunks = await h.chat().turn('plain extension-refused')
      assert.equal(failure(chunks), `Antigravity (ACP) did not start: ${offRefusal(text)}`)
      assert.deepEqual(h.startsAfter(starts), [])
      assert.deepEqual(h.events('prompt'), [])
    })
  }
}

test('12: with neither extension, OFF starts and Details reports Skills availability', unixOnly, async t => {
  const h = agyWorld(t)
  h.service.botIdentity(offBot)
  await h.service.inspect(AGY)
  assert.deepEqual(h.service.nativeOffNotes(AGY), { skillsUnavailable: true })
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
