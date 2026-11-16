import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { AgentRun, KILL_AFTER_MS } from '../src/host/acp.js'
import { parseProcStat, processBirth, processState } from '../src/host/process-identity.js'
import { descendants, parsePsTable, signalTree, treeBudget, treeStates }
  from '../src/host/process-tree.js'

const boot = '12345678-1234-1234-1234-123456789abc'
const birth = { platform: 'linux', boot, start: '12345' }
const stat = (pid, ppid, pgid, start = birth.start) => {
  const fields = ['S', String(ppid), String(pgid), String(pgid), ...Array(15).fill('0'),
    start, ...Array(30).fill('0')]
  return `${pid} (odd ) name (still)) ${fields.join(' ')}\n`
}
const table = new Map([
  [42, stat(42, 1, 42)], [43, stat(43, 42, 42)], [44, stat(44, 43, 44)],
  [45, stat(45, 44, 44)], [46, stat(46, 1, 46)],
])
function fakeDeps(entries = table) {
  return {
    platform: 'linux', list: () => [...entries.keys()].map(String),
    read: path => {
      if (path.endsWith('boot_id')) return boot
      const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1])
      if (pid === process.pid) return stat(pid, 1, 20)
      if (!entries.has(pid)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return entries.get(pid)
    },
  }
}

test('proc stat shares birth parsing after the last parenthesis', () => {
  assert.deepEqual(parseProcStat(42, stat(42, 10, 40)), {
    ppid: 10, pgid: 40, session: 40, start: birth.start,
  })
  for (const malformed of ['', '42 (name) S 1 2', stat(43, 1, 42),
    stat(42, 1, 42).replace(') S', ')S'), stat(42, 1, 42).replace(') S', ') 9')]) {
    assert.equal(parseProcStat(42, malformed), null)
  }
  assert.deepEqual(processBirth(42, fakeDeps()), birth)
})

test('snapshot follows parent ids across sessions, skipping unreadable individual pids', () => {
  const deps = fakeDeps()
  deps.list = () => ['42', '43', '44', '45', '46', '47', 'self', '001']
  const { records } = descendants(42, birth, deps)
  assert.deepEqual(records.map(({ pid, ppid, pgid }) => ({ pid, ppid, pgid })), [
    { pid: 43, ppid: 42, pgid: 42 }, { pid: 44, ppid: 43, pgid: 44 },
    { pid: 45, ppid: 44, pgid: 44 },
  ])
  assert.deepEqual(records[1].birth, birth)
  assert.deepEqual(descendants(46, birth, deps), { records: [], complete: true })
})

test('impossible snapshots report incomplete results', () => {
  const deps = fakeDeps()
  const unknown = { records: [], complete: false }
  assert.deepEqual(descendants(42, birth, {
    ...deps, list: () => { throw new Error() },
  }), unknown)
  assert.deepEqual(descendants(42, birth, {
    ...deps, read: () => { throw new Error() },
  }), unknown)
  assert.deepEqual(descendants(42, { ...birth, start: '999' }, deps), unknown)
  let clock = 0
  assert.deepEqual(descendants(42, birth, { ...deps, now: () => clock += 1501 }), unknown)
  assert.deepEqual(descendants(42, null, deps), unknown)
  assert.deepEqual(descendants(42, birth, { platform: 'freebsd' }), unknown)
})

test('macOS parses a fixed ps table and reads it once with bounded UTC options', () => {
  const output = [
    '    42 1 42 Fri Nov  6 13:14:15 2026',
    '    43 42 42 Fri Nov  6 13:14:16 2026',
    '    44 43 44 Fri Nov  6 13:14:17 2026',
    '    45 1 45 Fri Nov  6 13:14:18 2026',
    '    46 42 46 Fri Nov  6 99:14:15 2026', 'malformed', '',
  ].join('\n')
  const records = parsePsTable(output)
  assert.equal(records.length, 4)
  assert.equal(records[0].birth.start, 'Fri Nov 6 13:14:15 2026')
  let calls = 0
  const exec = (command, args, options) => {
    calls++
    assert.equal(command, '/bin/ps')
    assert.deepEqual(args, ['-A', '-o', 'pid=,ppid=,pgid=,lstart='])
    assert.deepEqual(options.env, { LC_ALL: 'C', TZ: 'UTC' })
    assert.ok(options.timeout <= 1500)
    return output
  }
  assert.deepEqual(descendants(42, records[0].birth, { platform: 'darwin', exec }),
    { records: records.slice(1, 3), complete: false })
  assert.equal(calls, 1)
  assert.deepEqual(descendants(42, records[0].birth, {
    platform: 'darwin', exec: () => { throw new Error('timeout') },
  }), { records: [], complete: false })
})

test('signals only live identities and groups with a recorded live leader', () => {
  const entries = new Map(table)
  const deps = fakeDeps(entries)
  const { records } = descendants(42, birth, deps)
  const signals = []
  deps.kill = (pid, signal) => { if (signal !== 0) signals.push([pid, signal]) }
  signalTree(records, 'SIGTERM', { ...deps, agentPgid: 42 })
  assert.deepEqual(signals, [
    [43, 'SIGTERM'], [-44, 'SIGTERM'], [44, 'SIGTERM'], [45, 'SIGTERM'],
  ])
  signals.length = 0
  entries.set(44, stat(44, 43, 44, '999'))
  signalTree(records, 'SIGKILL', { ...deps, agentPgid: 42 })
  assert.deepEqual(signals, [[43, 'SIGKILL'], [45, 'SIGKILL']])
  signals.length = 0
  signalTree([records[2]], 'SIGTERM', deps)
  assert.deepEqual(signals, [[45, 'SIGTERM']])
})

test('never signals DSH, its group, unsafe ids or a group whose identity is unknown', () => {
  const entries = new Map([
    [20, stat(20, 1, 20)], [50, stat(50, 20, 20)], [60, stat(60, 1, 60)],
    [61, stat(61, 60, 60)],
  ])
  const deps = fakeDeps(entries)
  const signals = []
  deps.kill = (pid, signal) => { if (signal !== 0) signals.push(pid) }
  const record = (pid, pgid) => ({ pid, pgid, ppid: 42, birth })
  signalTree([record(0, 0), record(1, 1), record(-1, -1), record(process.pid, process.pid),
    record(20, 20), record(50, 20)], 'SIGTERM', deps)
  assert.deepEqual(signals, [50])
  signals.length = 0
  entries.set(60, 'unreadable identity')
  signalTree([record(60, 60), record(61, 60)], 'SIGKILL', deps)
  assert.deepEqual(signals, [61])
})

test('failed group sends fall back only to members checked live in this pass', () => {
  for (const code of ['ESRCH', 'EPERM', undefined]) {
    const entries = new Map([
      [44, stat(44, 42, 44)], [45, stat(45, 44, 44)],
      [46, stat(46, 44, 44, '99999')], [47, 'unreadable identity'],
    ])
    const deps = fakeDeps(entries)
    const read = deps.read
    const reads = new Map()
    const signals = []
    deps.read = path => {
      reads.set(path, (reads.get(path) ?? 0) + 1)
      return read(path)
    }
    deps.kill = (pid, signal) => {
      if (pid === 48) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (!signal) return
      signals.push([pid, signal])
      if (pid === -44) throw Object.assign(new Error('group send failed'), { code })
      if (pid === 44) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    }
    const records = [44, 45, 46, 47, 48].map(pid => ({ pid, ppid: 42, pgid: 44, birth }))
    signalTree([...records, ...records], 'SIGKILL', deps)
    assert.deepEqual(signals, [[-44, 'SIGKILL'], [44, 'SIGKILL'], [45, 'SIGKILL']])
    for (const pid of [44, 45, 46, 47]) assert.equal(reads.get(`/proc/${pid}/stat`), 1)
    assert.equal(reads.has('/proc/48/stat'), false)
  }
})

test('successful group sends also signal each live member once in the same pass', () => {
  const entries = new Map([
    [44, stat(44, 42, 60)], [45, stat(45, 44, 44)],
    [46, stat(46, 44, 44, '99999')], [47, 'unreadable identity'],
    [49, stat(49, 44, 44)],
  ])
  const deps = fakeDeps(entries)
  const read = deps.read
  const reads = new Map()
  const signals = []
  deps.read = path => {
    reads.set(path, (reads.get(path) ?? 0) + 1)
    return read(path)
  }
  deps.kill = (pid, signal) => {
    if (pid === 48 || pid === 49) {
      throw Object.assign(new Error('probe failed'), { code: pid === 48 ? 'ESRCH' : 'EPERM' })
    }
    if (signal) signals.push([pid, signal])
  }
  const records = [44, 45, 46, 47, 48, 49].map(pid => ({ pid, ppid: 42, pgid: 44, birth }))
  signalTree([...records, ...records], 'SIGKILL', deps)
  assert.deepEqual(signals, [[-44, 'SIGKILL'], [44, 'SIGKILL'], [45, 'SIGKILL']])
  for (const pid of [44, 45, 46, 47]) assert.equal(reads.get(`/proc/${pid}/stat`), 1)
  for (const pid of [48, 49]) assert.equal(reads.has(`/proc/${pid}/stat`), false)
})

const linuxOnly = { skip: process.platform !== 'linux' && 'real process trees need Linux /proc' }
const fixture = new URL('./fixtures/process-tree.mjs', import.meta.url)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 1500) {
  const end = Date.now() + ms
  while (!check()) {
    assert.ok(Date.now() < end, 'process state reached its deadline')
    await pause(20)
  }
}
async function launch(t, role = 'agent', stubborn = 'no', options = {}) {
  const { handshake = 'ready', observed = new Map(), readyMs = 3000 } = options
  const child = spawn(process.execPath, [fixture.pathname, role, stubborn, handshake], {
    detached: true, stdio: ['pipe', 'pipe', 'inherit'],
  })
  const rootBirth = processBirth(child.pid)
  observed.set(child.pid, rootBirth)
  const record = {}
  const lines = createInterface({ input: child.stdout })
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    const snapshot = descendants(child.pid, observed.get(child.pid))
    for (const entry of snapshot.records) observed.set(entry.pid, entry.birth)
    for (const [pid, birth] of observed) {
      if (processState(pid, birth) !== 'live') continue
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    lines.close()
    child.stdin.destroy()
    child.stdout.destroy()
    if (Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
      await once(child, 'exit')
    }
  }
  t.after(cleanup)
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('fixture readiness timed out')), readyMs)
      child.once('error', reject)
      lines.on('line', line => {
        const entry = JSON.parse(line)
        if (entry.ready) { resolve(); return }
        record[entry.role] = entry.pid
        observed.set(entry.pid, entry.birth)
      })
    })
  } catch (error) {
    await cleanup()
    throw error
  } finally {
    clearTimeout(timer)
  }
  return { child, record }
}
function runOf(child) {
  const run = new AgentRun({ name: 'Tree test' })
  run.child = child
  run.grouped = true
  run.birth = processBirth(child.pid)
  child.once('exit', () => run.endTree())
  return run
}
function groupGone(pid) {
  try { process.kill(-pid, 0); return false } catch (error) {
    if (error.code !== 'ESRCH') throw error
    return true
  }
}

for (const stubborn of ['no', 'yes']) {
  test(`dispose ends a detached grandchild (ignores TERM: ${stubborn})`, linuxOnly, async t => {
    const { child, record } = await launch(t, 'agent', stubborn)
    const unrelated = await launch(t, 'unrelated')
    const run = runOf(child)
    const toolBirth = processBirth(record.tool)
    const otherBirth = processBirth(unrelated.child.pid)
    const before = performance.now()
    const { records: snapshot } = descendants(child.pid, run.birth)
    t.diagnostic(`snapshot: ${(performance.now() - before).toFixed(2)} ms`)
    assert.ok(snapshot.some(entry => entry.pid === record.tool && entry.pgid === record.tool))
    const started = Date.now()
    run.dispose()
    assert.ok(run.detached.some(entry => entry.pid === record.tool))
    await until(() => groupGone(child.pid))
    if (stubborn === 'yes') {
      assert.equal(processState(record.tool, toolBirth), 'live')
      await pause(Math.max(0, KILL_AFTER_MS - 150 - (Date.now() - started)))
      assert.equal(processState(record.tool, toolBirth), 'live')
    }
    await until(() => processState(record.tool, toolBirth) === 'dead', KILL_AFTER_MS + 1500)
    assert.equal(processState(unrelated.child.pid, otherBirth), 'live')
    if (stubborn === 'yes') assert.ok(Date.now() - started >= KILL_AFTER_MS - 50)
  })
}

test('stop waits until the detached grandchild is confirmed gone', linuxOnly, async t => {
  const { child, record } = await launch(t, 'agent', 'yes')
  const run = runOf(child)
  const toolBirth = processBirth(record.tool)
  let finished = false
  const stopped = run.stop().then(() => { finished = true })
  await until(() => groupGone(child.pid))
  assert.equal(finished, false)
  assert.equal(processState(record.tool, toolBirth), 'live')
  await stopped
  assert.equal(processState(record.tool, toolBirth), 'dead')
})

test('stop kills a captured leader that moved to another captured group', linuxOnly, async t => {
  // Both leaders share a session so L can join H's group after the snapshot.
  const script = `
    use POSIX qw(setpgid);
    $| = 1;
    pipe(my $ready, my $notify) or die $!;
    my $h = fork();
    die $! unless defined $h;
    if (!$h) {
      close $ready;
      setpgid(0, 0) == 0 or die $!;
      $SIG{TERM} = 'IGNORE';
      alarm 25;
      syswrite($notify, "H", 1);
      close $notify;
      while (1) { sleep 1; }
    }
    close $notify;
    sysread($ready, my $byte, 1) == 1 or die $!;
    close $ready;
    my $l = fork();
    die $! unless defined $l;
    if (!$l) {
      setpgid(0, 0) == 0 or die $!;
      $SIG{TERM} = sub {
        setpgid(0, $h) == 0 or die $!;
        kill 'KILL', $h;
        $SIG{TERM} = 'IGNORE';
      };
      alarm 25;
      print "$h $$\\n";
      while (1) { sleep 1; }
    }
    alarm 25;
    while (1) { sleep 1; }
  `
  const child = spawn('/usr/bin/perl', ['-e', script], {
    detached: true, stdio: ['pipe', 'pipe', 'inherit'],
  })
  const run = runOf(child)
  const lines = createInterface({ input: child.stdout })
  const observed = new Map([[child.pid, run.birth]])
  t.after(async () => {
    for (const record of descendants(child.pid, run.birth).records) {
      observed.set(record.pid, record.birth)
    }
    for (const [pid, birth] of observed) {
      if (processState(pid, birth) !== 'live') continue
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    lines.close()
    child.stdin.destroy()
    child.stdout.destroy()
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  })
  const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(3000) })
  const [h, l] = line.split(' ').map(Number)
  for (const pid of [h, l]) observed.set(pid, processBirth(pid))
  const signals = []
  run.treeDeps = {
    kill: (pid, signal) => {
      if (signal) signals.push([pid, signal])
      return process.kill(pid, signal)
    },
  }
  const stopped = run.stop()
  assert.deepEqual(run.detached.map(record => record.pid).sort((a, b) => a - b), [h, l])
  for (const record of run.detached) assert.equal(record.pgid, record.pid)
  await until(() => {
    const stat = readFileSync(`/proc/${l}/stat`, 'utf8')
    return parseProcStat(l, stat)?.pgid === h
  })
  await until(() => processState(h, observed.get(h)) === 'dead')
  assert.equal(processState(l, observed.get(l)), 'live')
  assert.equal(groupGone(l), true)
  await stopped
  assert.ok(signals.some(([pid, signal]) => pid === -l && signal === 'SIGKILL'))
  assert.ok(signals.some(([pid, signal]) => pid === l && signal === 'SIGKILL'))
  assert.equal(processState(l, observed.get(l)), 'dead')
})

test('stop kills a moved leader while its child stays in the old group', linuxOnly, async t => {
  // Both leaders share a session so L can join H's group after the snapshot.
  const script = `
    use POSIX qw(setpgid);
    $| = 1;
    $SIG{TERM} = 'IGNORE';
    pipe(my $ready, my $notify) or die $!;
    my $h = fork();
    die $! unless defined $h;
    if (!$h) {
      close $ready;
      setpgid(0, 0) == 0 or die $!;
      $SIG{TERM} = 'IGNORE';
      alarm 25;
      syswrite($notify, "H", 1);
      close $notify;
      while (1) { sleep 1; }
    }
    close $notify;
    sysread($ready, my $byte, 1) == 1 or die $!;
    close $ready;
    my $l = fork();
    die $! unless defined $l;
    if (!$l) {
      setpgid(0, 0) == 0 or die $!;
      pipe(my $ready_m, my $notify_m) or die $!;
      my $m = fork();
      die $! unless defined $m;
      if (!$m) {
        close $ready_m;
        alarm 25;
        syswrite($notify_m, "M", 1);
        close $notify_m;
        while (1) { sleep 1; }
      }
      close $notify_m;
      sysread($ready_m, my $byte_m, 1) == 1 or die $!;
      close $ready_m;
      $SIG{TERM} = sub {
        setpgid(0, $h) == 0 or die $!;
        kill 'KILL', $h;
        $SIG{TERM} = 'IGNORE';
      };
      alarm 25;
      print "$h $$ $m\\n";
      while (1) { sleep 1; }
    }
    alarm 25;
    waitpid($h, 0);
    exit 0;
  `
  const child = spawn('/usr/bin/perl', ['-e', script], {
    detached: true, stdio: ['pipe', 'pipe', 'inherit'],
  })
  const run = runOf(child)
  const lines = createInterface({ input: child.stdout })
  const observed = new Map([[child.pid, run.birth]])
  t.after(async () => {
    for (const record of descendants(child.pid, run.birth).records) {
      observed.set(record.pid, record.birth)
    }
    for (const [pid, birth] of observed) {
      if (processState(pid, birth) !== 'live') continue
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    lines.close()
    child.stdin.destroy()
    child.stdout.destroy()
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  })
  const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(3000) })
  const [h, l, m] = line.split(' ').map(Number)
  for (const pid of [h, l, m]) observed.set(pid, processBirth(pid))
  const signals = []
  run.treeDeps = {
    kill: (pid, signal) => {
      const sent = process.kill(pid, signal)
      if (signal) signals.push([pid, signal])
      return sent
    },
  }
  const stopped = run.stop()
  const groups = new Map(run.detached.map(record => [record.pid, record.pgid]))
  assert.deepEqual(groups, new Map([[h, h], [l, l], [m, l]]))
  await until(() => {
    const stat = readFileSync(`/proc/${l}/stat`, 'utf8')
    return parseProcStat(l, stat)?.pgid === h
  })
  await until(() => processState(h, observed.get(h)) === 'dead')
  assert.equal(processState(l, observed.get(l)), 'live')
  assert.equal(processState(m, observed.get(m)), 'live')
  assert.equal(parseProcStat(m, readFileSync(`/proc/${m}/stat`, 'utf8')).pgid, l)
  assert.equal(groupGone(l), false)
  await stopped
  assert.ok(signals.some(([pid, signal]) => pid === -l && signal === 'SIGKILL'))
  assert.ok(signals.some(([pid, signal]) => pid === l && signal === 'SIGKILL'))
  assert.equal(processState(l, observed.get(l)), 'dead')
  assert.equal(processState(m, observed.get(m)), 'dead')
  assert.equal(signals.filter(([pid, signal]) => pid === l && signal === 'SIGKILL').length, 1)
})

test('stop refuses an unknown detached identity after its bounded wait', linuxOnly, async t => {
  const { child, record } = await launch(t)
  const run = runOf(child)
  run.dispose()
  await until(() => groupGone(child.pid))
  let clock = 0
  run.treeDeps = {
    now: () => clock += 2500,
    kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
  }
  assert.ok(run.detached.some(entry => entry.pid === record.tool))
  await assert.rejects(run.stop(), { message: 'The Bot process has not stopped. Try again.' })
  run.treeDeps = undefined
  await run.stop()
})

test('dispose snapshots before closing stdin', linuxOnly, async t => {
  const { child, record } = await launch(t)
  const run = runOf(child)
  const end = child.stdin.end.bind(child.stdin)
  child.stdin.end = (...args) => {
    assert.ok(run.detached.some(entry => entry.pid === record.tool))
    return end(...args)
  }
  await run.stop()
})

test('the Linux parser reads this group without exposing command lines', linuxOnly, () => {
  const parsed = parseProcStat(process.pid, readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
  assert.ok(parsed.pgid >= 1)
})

test('snapshot rejects older descendants of a reused intermediate pid', () => {
  const entries = new Map([
    [44, stat(44, 43, 44, '9')], [45, stat(45, 44, 44, '9')],
    [42, stat(42, 1, 42, '1')], [43, stat(43, 42, 42, '10')],
  ])
  const snapshot = descendants(42, { ...birth, start: '1' }, fakeDeps(entries))
  assert.deepEqual(snapshot.records.map(record => record.pid), [43])
  entries.delete(43)
  assert.deepEqual(descendants(42, { ...birth, start: '1' }, fakeDeps(entries)).records, [])
})

test('macOS ancestry permits equal seconds but rejects an older child', () => {
  const output = [
    '42 1 42 Fri Nov 6 13:14:15 2026',
    '43 42 43 Fri Nov 6 13:14:15 2026',
    '44 43 44 Fri Nov 6 13:14:14 2026',
  ].join('\n')
  const rootBirth = parsePsTable(output)[0].birth
  const snapshot = descendants(42, rootBirth, { platform: 'darwin', exec: () => output })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.records.map(record => record.pid), [43])
})

test('missing ancestors and read errors mark a partial snapshot incomplete', () => {
  for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EIO']) {
    const deps = fakeDeps()
    const read = deps.read
    deps.read = path => {
      if (path === '/proc/43/stat') throw Object.assign(new Error('unreadable'), { code })
      return read(path)
    }
    const snapshot = descendants(42, birth, deps)
    assert.equal(snapshot.complete, false, code)
    assert.deepEqual(snapshot.records, [])
  }
  for (const code of ['ENOENT', 'ESRCH', 'EACCES']) {
    const deps = fakeDeps()
    const read = deps.read
    deps.read = path => {
      if (path === '/proc/46/stat') throw Object.assign(new Error('unreadable'), { code })
      return read(path)
    }
    const snapshot = descendants(42, birth, deps)
    assert.equal(snapshot.complete, code !== 'EACCES', code)
    assert.deepEqual(snapshot.records.map(record => record.pid), [43, 44, 45])
  }
})

test('a root that changes during the scan makes the snapshot incomplete', () => {
  const deps = fakeDeps()
  const read = deps.read
  let reads = 0
  deps.read = path => path === '/proc/42/stat' && ++reads > 1
    ? stat(42, 1, 42, '99999') : read(path)
  assert.deepEqual(descendants(42, birth, deps), { records: [], complete: false })
})

test('group leaders are checked once and failed checks never authorize their pid', () => {
  const deps = fakeDeps()
  const { records } = descendants(42, birth, deps)
  const read = deps.read
  const signals = []
  let reads = 0
  deps.read = path => {
    if (path === '/proc/44/stat' && ++reads > 1) return stat(44, 43, 44, '99999')
    return read(path)
  }
  deps.kill = (pid, signal) => { if (signal) signals.push(pid) }
  signalTree([...records, ...records], 'SIGKILL', deps)
  assert.equal(reads, 1)
  assert.deepEqual(signals, [43, -44, 44, 45])
  signals.length = 0
  signalTree([...records, ...records], 'SIGKILL', deps)
  assert.equal(reads, 2)
  assert.deepEqual(signals, [43, 45])
})

test('macOS uses one table per signal call and per state check batch', async () => {
  const output = [
    `${process.pid} 1 20 Fri Nov 6 13:14:15 2026`,
    ...Array.from({ length: 10 }, (_, i) => `${44 + i} 42 44 Fri Nov 6 13:14:15 2026`),
  ].join('\n')
  const records = parsePsTable(output).slice(1)
  let calls = 0
  const probes = []
  const signals = []
  const deps = {
    platform: 'darwin', execAsync: (command, args, options, callback) => {
      calls++
      assert.equal(command, '/bin/ps')
      assert.deepEqual(args, ['-A', '-o', 'pid=,ppid=,pgid=,lstart='])
      assert.equal(options.timeout, 2000)
      callback(null, output)
    },
    kill: (pid, signal) => { (signal ? signals : probes).push(pid) },
  }
  await signalTree(records, 'SIGTERM', deps)
  assert.equal(calls, 1)
  // Every known pid is probed before the one table read.
  assert.deepEqual(probes, Array.from({ length: 10 }, (_, i) => 44 + i))
  assert.deepEqual(signals, [-44, ...records.map(record => record.pid)])
  await signalTree(records, 'SIGKILL', deps)
  assert.equal(calls, 2)
  assert.deepEqual(await treeStates(records, deps), Array(10).fill('live'))
  assert.equal(calls, 3)
})

test('TERM gets its own async check after the snapshot budget is spent', async () => {
  let clock = 0
  const output = [
    `${process.pid} 1 20 Fri Nov 6 13:14:15 2026`,
    '42 1 42 Fri Nov 6 13:14:15 2026',
    '44 42 44 Fri Nov 6 13:14:15 2026',
  ].join('\n')
  const rootBirth = parsePsTable(output)[1].birth
  const timeouts = []
  const signals = []
  const deps = {
    platform: 'darwin', now: () => clock,
    exec: (command, args, options) => {
      timeouts.push(options.timeout)
      clock += 1200
      return output
    },
    execAsync: (command, args, options, callback) => {
      timeouts.push(options.timeout)
      clock += 400
      callback(null, output)
    },
    kill: (pid, signal) => { if (signal) signals.push(pid) },
  }
  const snapshot = descendants(42, rootBirth, treeBudget(deps))
  assert.equal(snapshot.complete, true)
  await signalTree(snapshot.records, 'SIGTERM', deps)
  assert.deepEqual(timeouts, [1500, 2000])
  assert.deepEqual(signals, [-44, 44])
  assert.equal(clock, 1600)
})

function fakeRun(t, deps = fakeDeps()) {
  const warnings = []
  const events = []
  const run = new AgentRun({
    name: 'Tree test', onWarn: message => warnings.push(message),
    timers: { setTimeout: () => { events.push('timer'); return {} }, clearTimeout() {} },
  })
  run.child = {
    pid: 42, exitCode: null, signalCode: null, stdin: { end() {} },
    once() {}, kill: signal => events.push(signal),
  }
  run.grouped = true
  run.treeDeps = deps
  let group = true
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -42) {
      if (signal === 'SIGTERM') { events.push('group TERM'); group = false; return }
      if (!group) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }
  })
  return { run, warnings, events, groupGone: () => { group = false } }
}

test('dispose reads a missing birth while the agent is still running', async t => {
  const { run, warnings } = fakeRun(t, fakeDeps(new Map([[42, stat(42, 1, 42)]])))
  await run.stop()
  assert.deepEqual(run.birth, birth)
  assert.deepEqual(run.detached, [])
  assert.deepEqual(warnings, [])
})

test('an impossible snapshot warns once and stop falls back to the agent group', async t => {
  for (const failure of ['table', 'birth', 'changed', 'deadline']) {
    const deps = fakeDeps()
    if (failure === 'table') deps.list = () => { throw new Error('unreadable') }
    if (failure === 'birth') deps.read = () => { throw new Error('unreadable') }
    if (failure === 'deadline') {
      let clock = 0
      deps.now = () => clock += 1501
    }
    const { run, warnings } = fakeRun(t, deps)
    if (failure === 'changed') run.birth = { ...birth, start: '99999' }
    await run.stop()
    await run.stop()
    assert.deepEqual(run.detached, [])
    assert.equal(warnings.length, 1, failure)
    t.mock.restoreAll()
  }
})

test('partial snapshots signal known tools and allow retries of unknown proof', async t => {
  const deps = fakeDeps()
  const read = deps.read
  deps.read = path => {
    if (path === '/proc/46/stat') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(path)
  }
  const signals = []
  deps.kill = (pid, signal) => { if (signal) signals.push(pid) }
  const { run, warnings } = fakeRun(t, deps)
  run.dispose()
  assert.deepEqual(signals, [-44, 44, 45])
  assert.equal(warnings.length, 1)
  let clock = 0
  run.treeDeps = {
    ...deps, now: () => clock += 500,
    kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
  }
  await assert.rejects(run.stop(), /The Bot process has not stopped/)
  run.treeDeps = {
    ...deps, kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
  }
  await run.stop()
  assert.equal(warnings.length, 1)
})

test('unsupported POSIX platforms keep group-only shutdown', async t => {
  const deps = {
    platform: 'freebsd', read: () => assert.fail('must not read identities'),
    exec: () => assert.fail('must not run ps'), list: () => assert.fail('must not take a snapshot'),
  }
  const { run, warnings, events } = fakeRun(t, deps)
  await run.stop()
  assert.equal(run.detached, undefined)
  assert.equal(run.birth, undefined)
  assert.deepEqual(warnings, [])
  assert.deepEqual(events, ['group TERM', 'timer'])
})

test('endTree sends agent TERM and arms timers before detached identity reads', t => {
  const deps = fakeDeps()
  const { run, events } = fakeRun(t, deps)
  run.detached = [{ pid: 44, ppid: 42, pgid: 44, birth }]
  const read = deps.read
  deps.read = path => { events.push('read'); return read(path) }
  run.endTree()
  assert.deepEqual(events.slice(0, 3), ['group TERM', 'timer', 'timer'])
  assert.equal(events[3], 'read')
})

test('macOS stop reads one table per iteration', async t => {
  const output = [
    `${process.pid} 1 20 Fri Nov 6 13:14:15 2026`,
    '44 42 44 Fri Nov 6 13:14:15 2026',
    '45 44 44 Fri Nov 6 13:14:15 2026',
  ].join('\n')
  let calls = 0
  let probes = 0
  const deps = {
    platform: 'darwin',
    execAsync: (command, args, options, callback) => { calls++; callback(null, output) },
    kill: () => {
      probes++
      if (calls > 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    },
  }
  const { run, groupGone } = fakeRun(t, deps)
  run.child.exitCode = 0
  run.disposed = true
  run.detached = parsePsTable(output).slice(1)
  groupGone()
  await run.stop()
  // Two iterations read a table; the third proves both pids gone by ESRCH alone.
  assert.equal(calls, 2)
  assert.equal(probes, 6)
})

test('failed fixture readiness cleans up every reported identity', linuxOnly, async t => {
  const observed = new Map()
  await assert.rejects(launch(t, 'agent', 'yes', {
    handshake: 'hold', observed, readyMs: 1000,
  }), /fixture readiness timed out/)
  assert.equal(observed.size, 3)
  await until(() => [...observed].every(([pid, birth]) => processState(pid, birth) === 'dead'))
})

// A fixed latency must time out, not shrink, when a caller offers too little time.
function slowPs(output, timeouts, latency = 400) {
  return (command, args, options, callback) => {
    timeouts.push(options.timeout)
    setTimeout(() => {
      if (options.timeout < latency) callback(new Error('timeout'))
      else callback(null, output)
    }, Math.min(latency, options.timeout))
  }
}

function realTimers(t, run) {
  const timers = []
  run.timers = {
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms)
      timers.push(timer)
      return timer
    },
    clearTimeout,
  }
  t.after(() => timers.forEach(clearTimeout))
}

test('400 ms async tables allow detached TERM, KILL and stop proof', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const output = [
    `${process.pid} 1 20 Fri Nov 6 13:14:15 2026`,
    '42 1 42 Fri Nov 6 13:14:15 2026',
    '44 42 44 Fri Nov 6 13:14:15 2026',
  ].join('\n')
  const timeouts = []
  const signals = []
  let alive = true
  const deps = {
    platform: 'darwin', exec: () => output,
    execAsync: slowPs(output, timeouts),
    kill: (pid, signal) => {
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal) signals.push([pid, signal, Date.now()])
      if (signal === 'SIGKILL') alive = false
    },
  }
  const { run } = fakeRun(t, deps)
  run.birth = parsePsTable(output)[1].birth
  realTimers(t, run)
  const started = Date.now()
  run.dispose()
  assert.equal(run.detached.length, 1)
  assert.deepEqual(signals, [], 'TERM waits for its async identity check')
  const stopping = run.stop()
  let outcome
  stopping.then(() => { outcome = { ok: true } }, error => { outcome = { error } })
  for (let advanced = 0; !outcome && advanced < 10000; advanced++) {
    t.mock.timers.tick(1)
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.ok(outcome, 'stop did not settle within 10000 virtual ms')
  if (outcome.error) throw outcome.error
  assert.equal(alive, false)
  assert.deepEqual(signals.map(([pid, signal]) => [pid, signal]), [
    [-44, 'SIGTERM'], [44, 'SIGTERM'], [-44, 'SIGKILL'],
  ])
  assert.ok(signals[0][2] - started >= 400)
  assert.ok(signals[2][2] - started >= KILL_AFTER_MS + 400)
  assert.ok(signals[2][2] - started <= KILL_AFTER_MS + 600)
  assert.ok(Date.now() - started < 5000, 'stop exceeded its deadline')
  assert.ok(timeouts.length > 3, 'TERM, polling and KILL all read the table')
  assert.ok(timeouts.every(ms => ms === 2000))
})

test('four disposals share a snapshot budget and deliver the outer timer on time', async t => {
  await new Promise(resolve => setImmediate(resolve))
  const output = [
    `${process.pid} 1 20 Fri Nov 6 13:14:15 2026`,
    '42 1 42 Fri Nov 6 13:14:15 2026',
    '44 42 44 Fri Nov 6 13:14:15 2026',
  ].join('\n')
  const snapshots = []
  const checks = []
  let alive = true
  const deps = {
    platform: 'darwin',
    exec: (command, args, options) => {
      snapshots.push(options.timeout)
      const end = performance.now() + Math.min(1400, options.timeout)
      while (performance.now() < end) {}
      if (options.timeout < 1400) throw new Error('timeout')
      return output
    },
    execAsync: slowPs(output, checks),
    kill: (pid, signal) => {
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal === 'SIGKILL') alive = false
    },
  }
  const runs = Array.from({ length: 4 }, () => {
    const result = fakeRun(t, deps)
    result.run.birth = parsePsTable(output)[1].birth
    realTimers(t, result.run)
    return result
  })
  const started = performance.now()
  const outer = new Promise(resolve => {
    const timer = setTimeout(() => resolve(performance.now() - started), 4500)
    t.after(() => clearTimeout(timer))
  })
  for (const { run } of runs) run.dispose()
  const disposedAt = performance.now() - started
  const stops = Promise.all(runs.map(({ run }) => run.stop()))
  const firedAt = await outer
  await stops
  assert.ok(disposedAt <= 1600, `disposals blocked for ${disposedAt.toFixed(1)} ms`)
  assert.ok(firedAt <= 4600, `outer timer fired at ${firedAt.toFixed(1)} ms`)
  assert.equal(runs[0].run.detached.length, 1)
  assert.deepEqual(runs.map(({ warnings }) => warnings.length), [0, 1, 1, 1])
  assert.equal(snapshots.length, 2, 'spent budgets do not run ps')
  assert.ok(snapshots[1] <= 100)
  assert.ok(checks.every(ms => ms === 2000))
  assert.equal(alive, false)
})

test('a timed out TERM still permits KILL and a later stop rechecks unknown states', async t => {
  const output = [
    `${process.pid} 1 20 Fri Nov 6 13:14:15 2026`,
    '42 1 42 Fri Nov 6 13:14:15 2026',
    '44 42 44 Fri Nov 6 13:14:15 2026',
  ].join('\n')
  let clock = 0
  let failed = true
  let alive = true
  let reads = 0
  const signals = []
  const deps = {
    platform: 'darwin', now: () => clock, exec: () => output,
    execAsync: (command, args, options, callback) => {
      reads++
      assert.equal(options.timeout, 2000)
      if (failed) {
        clock += options.timeout
        callback(new Error('timeout'))
      } else callback(null, output)
    },
    kill: (pid, signal) => {
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal) signals.push([pid, signal])
      if (signal === 'SIGKILL') alive = false
    },
  }
  const { run } = fakeRun(t, deps)
  run.birth = parsePsTable(output)[1].birth
  const timers = []
  run.timers = {
    setTimeout: (callback, ms) => {
      assert.equal(ms, KILL_AFTER_MS)
      timers.push(callback)
      return {}
    },
    clearTimeout() {},
  }
  run.dispose()
  await assert.rejects(run.stop(), /The Bot process has not stopped/)
  assert.equal(reads, 4, 'TERM and three awaited checks reach the stop deadline')
  assert.deepEqual(signals, [])
  failed = false
  timers[1]()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(signals, [[-44, 'SIGKILL']])
  await run.stop()
  assert.equal(reads, 5, 'the later stop proves ESRCH before reading a table')
})

test('stop proves an already gone detached tool dead without a timed out table', async t => {
  let calls = 0
  const probes = []
  const deps = {
    platform: 'darwin',
    execAsync: (command, args, options, callback) => { calls++; callback(new Error('timeout')) },
    kill: (pid, signal) => {
      probes.push([pid, signal])
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    },
  }
  const { run, groupGone } = fakeRun(t, deps)
  run.disposed = true
  run.child.exitCode = 0
  run.detached = parsePsTable('44 42 44 Fri Nov 6 13:14:15 2026')
  groupGone()
  await run.stop()
  assert.deepEqual(probes, [[44, 0]])
  assert.equal(calls, 0)
  await signalTree(run.detached, 'SIGKILL', deps)
  assert.deepEqual(probes, [[44, 0], [44, 0]])
  assert.equal(calls, 0)
})

test('dead probes survive a table timeout while present and denied pids stay unknown', async () => {
  const records = parsePsTable([
    '44 42 44 Fri Nov 6 13:14:15 2026',
    '45 42 45 Fri Nov 6 13:14:15 2026',
    '46 42 46 Fri Nov 6 13:14:15 2026',
  ].join('\n'))
  let clock = 0
  const probes = []
  let probesBeforeTable
  const deps = {
    platform: 'darwin', now: () => clock,
    execAsync: (command, args, options, callback) => {
      probesBeforeTable = [...probes]
      clock += 2000
      callback(new Error('timeout'))
    },
    kill: pid => {
      probes.push(pid)
      if (pid === 45) return
      throw Object.assign(new Error('probe failed'), { code: pid === 44 ? 'ESRCH' : 'EPERM' })
    },
  }
  assert.deepEqual(await treeStates(records, deps), ['dead', 'unknown', 'unknown'])
  assert.deepEqual(probesBeforeTable, [44, 45, 46])
})

test('Linux dead probes need no proc reads even after the identity deadline', () => {
  let reads = 0
  const deps = {
    platform: 'linux', until: 0, now: () => 1,
    read: () => { reads++; throw new Error('unreadable') },
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
  }
  const records = [{ pid: 44, ppid: 42, pgid: 44, birth }]
  assert.deepEqual(treeStates(records, deps), ['dead'])
  signalTree(records, 'SIGTERM', deps)
  assert.equal(reads, 0)
})
