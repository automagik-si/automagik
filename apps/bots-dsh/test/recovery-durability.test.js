import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { install as installHandoffs } from '../src/host/handoffs.js'
import { install as installResume } from '../src/host/resume.js'
import { install as installReview } from '../src/host/review-mark.js'
import { install as installRoster } from '../src/host/roster.js'
import { install as installStore } from '../src/host/store.js'
import { fakeContext } from './fake-ctx.js'

test('review state and run notes flush in order while an ordinary save only renames', {
  skip: process.platform === 'win32' && 'observes POSIX replacements and directory syncs',
}, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'omni-recovery-durability-'))
  const statePath = join(home, 'state.json')
  const ctx = fakeContext()
  const warnings = []
  const rt = { ctx, home, statePath, live: new Map(), warn: (...args) => warnings.push(args) }
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    mainBotIds: ['solver'],
    bots: {
      solver: { id: 'solver', name: 'Solver', role: 'Solver', sessionId: 'solver', reviewerId: 'reviewer' },
      reviewer: { id: 'reviewer', name: 'Reviewer', sessionId: 'reviewer' },
    },
  }))
  installStore(rt)
  installHandoffs(rt)
  installReview(rt)
  let noteWrite
  const holdLockUntil = rt.holdLockUntil
  rt.holdLockUntil = (pending) => { noteWrite = pending; holdLockUntil(pending) }
  installResume(rt)
  t.after(async () => {
    await ctx.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  let stateWrite
  const save = rt.save
  rt.save = (...args) => (stateWrite = save(...args))
  const emit = (type, data) => {
    for (const listener of ctx.listeners.get('session/event')) listener({ id: 'solver' }, { type, data })
  }
  const read = name => JSON.parse(fs.readFileSync(join(home, name)))

  const calls = []
  let failDirectory = false
  const open = fsp.open
  const rename = fsp.rename
  const renameSync = fs.renameSync
  const spies = [
    t.mock.method(fsp, 'open', async (path, ...args) => {
      const handle = await open(path, ...args)
      if (path === home || path.startsWith(home + '/')) {
        const sync = handle.sync.bind(handle)
        handle.sync = () => {
          calls.push(path === home ? 'sync directory' : basename(path).startsWith('.inflight-') ? 'sync inflight temp' : 'sync state temp')
          if (path === home && failDirectory) throw new Error('injected directory sync failure')
          return sync()
        }
      }
      return handle
    }),
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (to === statePath) calls.push('rename state')
      return rename(from, to)
    }),
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === join(home, 'inflight.json')) calls.push('rename inflight')
      return renameSync(from, to)
    }),
  ]
  syncBuiltinESMExports()
  t.after(() => {
    for (const spy of spies) spy.mock.restore()
    syncBuiltinESMExports()
  })
  const stateFlush = ['sync state temp', 'rename state', 'sync directory']
  const noteFlush = ['sync inflight temp', 'rename inflight', 'sync directory']

  rt.state.prefs.fixture = true
  await rt.save()
  assert.deepEqual(calls.splice(0), ['rename state'], 'ordinary save')
  rt.reviewVerdict('reviewer', 'solver', undefined, 'SHIP', Date.now())
  await stateWrite
  assert.equal(typeof read('state.json').bots.solver.reviewTrack.planVerdictAt, 'number')
  emit('turn/start', { turn: 1 })
  assert.equal(await noteWrite(), true)
  assert.equal(read('inflight.json').turns.solver.botId, 'solver')
  assert.deepEqual(calls.splice(0), [...stateFlush, ...noteFlush], 'both writers must flush around the rename')

  rt.openWork('review', { from: 'solver', to: 'reviewer' })
  await stateWrite
  assert.ok(read('state.json').works.review)
  rt.closeWork('review', 'Reviewer', 'SHIP')
  await stateWrite
  assert.equal(read('state.json').works.review, undefined)
  assert.deepEqual(calls.splice(0), [...stateFlush, ...stateFlush], 'opening and closing a work')

  emit('turn/end', { reason: { kind: 'completed' } })
  emit('turn/start', { turn: 2 })
  emit('turn/end', { reason: { kind: 'completed' } })
  assert.equal(await noteWrite(), true)
  assert.equal(read('inflight.json').turns.solver, undefined)
  assert.deepEqual(calls.splice(0), noteFlush, 'coalesced run note changes')

  let acknowledged = 0
  rt.onSaved(() => acknowledged++)
  const previousTrack = structuredClone(rt.botOf('solver').reviewTrack)
  failDirectory = true
  rt.reviewRequest('solver')
  await assert.rejects(stateWrite, /injected directory sync failure/)
  assert.equal(acknowledged, 0)
  emit('turn/start', { turn: 3 })
  assert.equal(await noteWrite(), false)
  assert.match(warnings.at(-1)[0], /noting running turns failed/)
  assert.deepEqual(calls.splice(0), [...stateFlush, ...noteFlush])

  failDirectory = false
  rt.botOf('solver').reviewTrack = previousTrack
  rt.state.prefs.fixture = false
  assert.equal(await rt.save(), true)
  assert.equal(acknowledged, 1)
  rt.noteApproval('solver', undefined)
  assert.equal(await noteWrite(), true)
  assert.deepEqual(calls, [...stateFlush, ...noteFlush], 'the next write retries durability after failure')
})

const posix = { skip: process.platform === 'win32' && 'observes POSIX replacements and directory syncs' }

async function recoveryHost(t, setup) {
  const home = fs.mkdtempSync(join(tmpdir(), 'omni-recovery-durability-'))
  const statePath = join(home, 'state.json')
  const ctx = fakeContext()
  const rt = { ctx, home, statePath, live: new Map(), warn() {} }
  const write = (name, data) => fs.writeFileSync(join(home, name), JSON.stringify(data))
  const read = name => JSON.parse(fs.readFileSync(join(home, name), 'utf8'))
  write('state.json', {
    version: 2,
    workspaceId: 'team',
    mainBotIds: ['solver'],
    bots: {
      solver: { id: 'solver', name: 'Solver', role: 'Solver', sessionId: 'solver' },
      reviewer: { id: 'reviewer', name: 'Reviewer', sessionId: 'reviewer' },
    },
  })
  installStore(rt)
  const save = rt.save
  let stateWrite
  rt.save = (...args) => (stateWrite = save(...args))
  const hold = rt.holdLockUntil
  let noteWrite
  rt.holdLockUntil = (pending) => { noteWrite = pending; hold(pending) }
  setup(rt)
  t.after(async () => {
    await ctx.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  return { rt, home, write, read, stateWrite: () => stateWrite, noteWrite: () => noteWrite() }
}

function watchSyncs(t, home, onSync) {
  const calls = []
  const open = fsp.open
  const spy = t.mock.method(fsp, 'open', async (path, ...args) => {
    const handle = await open(path, ...args)
    const kind = path === home ? 'directory' : path.startsWith(join(home, '.inflight-')) ? 'inflight'
      : path.startsWith(join(home, 'state.json.')) ? 'state' : undefined
    if (kind !== undefined) {
      const sync = handle.sync.bind(handle)
      handle.sync = () => {
        calls.push(kind)
        onSync?.(kind)
        return sync()
      }
    }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports() })
  return calls
}

test('a published Solver copy keeps its Session when directory sync fails', posix, async (t) => {
  const archived = []
  const { rt, home, read } = await recoveryHost(t, (rt) => {
    Object.assign(rt.ctx, {
      workspaceRegistry: { get: () => true, archiveSession: async id => { archived.push(id) } },
      sessionController: { create: async () => ({ sessionId: 'copy' }) },
      sessionTitle: { rename: async () => {} },
    })
    Object.assign(rt, {
      catalog: async () => [],
      teamFolder: () => undefined,
      defaultBotModel: async () => undefined,
      resolveAgent: async id => ({ session: { id } }),
      applyPermission: async () => {},
      withSolverCopy: (_, create) => create({ pin: { id: 'solver', version: '1.0.0', attachedAt: new Date(0).toISOString(), grants: [] }, check() {} }),
    })
    installRoster(rt)
    installReview(rt)
  })
  rt.botOf('solver').waitingRole = { id: 'solver' }
  rt.botOf('solver').instructions = 'Custom instructions'
  let fail = true
  const calls = watchSyncs(t, home, (kind) => {
    if (kind === 'directory' && fail) throw new Error('injected directory sync failure')
  })
  let acknowledged = 0
  rt.onSaved(() => acknowledged++)
  await assert.rejects(rt.duplicateBot('solver'), /injected directory sync failure/)
  assert.equal(acknowledged, 0)
  assert.equal(read('state.json').bots.copy.id, 'copy', 'rename already published the copy')
  assert.deepEqual(archived, [], 'a published copy retains its Session')
  assert.equal(rt.selfOf('copy'), 'copy', 'the live roster indexes the published copy')
  fail = false
  assert.equal(await rt.save(), true)
  assert.deepEqual(calls, ['state', 'directory', 'state', 'directory'])
  assert.equal(acknowledged, 1)
  assert.equal(read('state.json').bots.copy.id, 'copy')
})

test('durable work closure is refused across adoption and lock terms', posix, async (t) => {
  const { rt, home, read, write, stateWrite } = await recoveryHost(t, installHandoffs)
  const results = join(home, 'handoff-results')
  fs.mkdirSync(results)
  for (const name of ['shared.txt', 'old.txt']) fs.writeFileSync(join(results, name), name)
  rt.state.works.work = { open: [], results: [{ file: 'shared.txt' }, { file: 'old.txt' }] }
  await rt.save()
  const outside = read('state.json')
  outside.prefs.marker = 'adopted'
  outside.works.work.results.pop()
  write('state.json', outside)
  fs.rmSync(join(home, 'state.lock'))

  rt.closeWork('work', 'Solver', 'finished')
  const closed = stateWrite().then(value => value, error => error.code)
  const ordinary = rt.save()
  assert.equal(await closed, 'ELOCKLOST')
  assert.equal(await ordinary, true)
  assert.equal(read('state.json').prefs.marker, 'adopted')
  assert.deepEqual(read('state.json').works.work.results, [{ file: 'shared.txt' }])
  assert.deepEqual(fs.readdirSync(results).sort(), ['old.txt', 'shared.txt'])

  const { epoch, term } = rt.teamGeneration()
  fs.rmSync(join(home, 'state.lock'))
  await assert.rejects(rt.save({ durable: true }), { code: 'ELOCKLOST' })
  assert.equal(rt.teamGeneration().epoch, epoch)
  assert.ok(rt.teamGeneration().term > term)
  assert.equal(await rt.save({ durable: true }), true)
})

test('only pending durability for the adopted checkpoint survives takeover', posix, async (t) => {
  const { rt, home, read, write, stateWrite, noteWrite } = await recoveryHost(t, rt => {
    installReview(rt)
    installResume(rt)
  })
  const foreignLock = () => write('state.lock', { host: 'other-host', pid: 1, token: 'other-owner' })
  const takeOver = async () => {
    foreignLock()
    await rt.refresh()
    fs.rmSync(join(home, 'state.lock'))
    await rt.refresh()
    await rt.reloadDeliveryNotes(() => {})
  }
  let failDirectory = true
  let fenceNote = false
  const calls = watchSyncs(t, home, (kind) => {
    if (kind === 'directory' && failDirectory) throw new Error('injected directory sync failure')
    if (kind === 'inflight' && fenceNote) foreignLock()
  })
  const failPublished = async (id, turn) => {
    rt.reviewRequest('solver')
    await assert.rejects(stateWrite(), /injected directory sync failure/)
    for (const listener of rt.ctx.listeners.get('session/event')) {
      listener({ id }, { type: 'turn/start', time: turn, data: { turn } })
    }
    assert.equal(await noteWrite(), false)
    assert.equal(read('inflight.json').turns[id].since, turn)
  }
  const saveOrdinary = async () => {
    assert.equal(await rt.save(), true)
    rt.noteApproval('solver', undefined)
    assert.equal(await noteWrite(), true)
    return calls.splice(0)
  }

  await failPublished('solver', 1)
  await takeOver()
  failDirectory = false
  calls.length = 0
  const same = await saveOrdinary()

  failDirectory = true
  await failPublished('reviewer', 2)
  const edited = read('state.json')
  edited.prefs.marker = 'another checkpoint'
  write('state.json', edited)
  failDirectory = false
  fenceNote = true
  rt.noteApproval('reviewer', { tool: 'fixture' })
  assert.equal(await noteWrite(), false)
  assert.equal(read('inflight.json').turns.reviewer.approval, undefined, 'the fenced note never renamed')
  const outside = read('inflight.json')
  outside.turns.solver.since = 3
  write('inflight.json', outside)
  await takeOver()
  fenceNote = false
  calls.length = 0
  const superseded = await saveOrdinary()
  assert.equal(read('state.json').prefs.marker, 'another checkpoint')
  assert.equal(read('inflight.json').turns.solver.since, 3)
  assert.deepEqual({ same, superseded }, { same: ['state', 'directory', 'inflight', 'directory'], superseded: [] })
})

test('Windows direct inflight writes retry only the adopted checkpoint after a failed flush', async (t) => {
  const { rt, home, read, write, noteWrite } = await recoveryHost(t, installResume)
  const file = join(home, 'inflight.json')
  const writeFile = fsp.writeFile
  const flushes = []
  let failFlush = false
  let failOpen = false
  let failedOpenBytes
  const spy = t.mock.method(fsp, 'writeFile', async (path, bytes, options) => {
    if (path === file) {
      flushes.push(options.flush)
      if (failOpen) {
        failedOpenBytes = bytes
        throw Object.assign(new Error('injected direct-write open failure'), { code: 'EBUSY', syscall: 'open' })
      }
      if (options.flush && failFlush) {
        await writeFile(path, bytes, options.encoding)
        throw new Error('injected direct-write flush failure')
      }
    }
    return writeFile(path, bytes, options)
  })
  syncBuiltinESMExports()
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports() })

  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const writeNote = async (change) => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      change()
      return await noteWrite()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  }
  const failPublished = async (id, turn) => {
    failFlush = true
    assert.equal(await writeNote(() => {
      for (const listener of rt.ctx.listeners.get('session/event')) {
        listener({ id }, { type: 'turn/start', time: turn, data: { turn } })
      }
    }), false)
    assert.equal(read('inflight.json').turns[id].since, turn)
    assert.deepEqual(flushes.splice(0), [true])
    failFlush = false
  }
  const takeOver = async () => {
    write('state.lock', { host: 'other-host', pid: 1, token: 'other-owner' })
    await rt.refresh()
    fs.rmSync(join(home, 'state.lock'))
    await rt.refresh()
    await rt.reloadDeliveryNotes(() => {})
  }
  const writeOrdinary = async () => {
    assert.equal(await writeNote(() => rt.noteApproval('solver', undefined)), true)
    return flushes.splice(0)
  }

  await failPublished('solver', 1)
  await takeOver()
  const matching = await writeOrdinary()
  const afterSuccess = await writeOrdinary()

  await failPublished('reviewer', 2)
  const outside = read('inflight.json')
  outside.turns.reviewer.since = 3
  write('inflight.json', outside)
  await takeOver()
  const superseded = await writeOrdinary()
  assert.equal(read('inflight.json').turns.reviewer.since, 3)
  assert.deepEqual({ matching, afterSuccess, superseded }, {
    matching: [true], afterSuccess: [false], superseded: [false],
  })

  rt.chatOwners.set('another-chat', 'solver')
  await failPublished('another-chat', 4)
  const published = fs.readFileSync(file, 'utf8')
  failOpen = true
  assert.equal(await writeNote(() => rt.noteApproval('another-chat', { tool: 'fixture' })), false)
  failOpen = false
  assert.equal(JSON.parse(failedOpenBytes).turns['another-chat'].approval.tool, 'fixture')
  assert.equal(fs.readFileSync(file, 'utf8'), published, 'the failed open left the published checkpoint intact')
  assert.deepEqual(flushes.splice(0), [true])

  await takeOver()
  assert.deepEqual(await writeOrdinary(), [true], 'the adopted checkpoint still needs its flush')
  assert.deepEqual(await writeOrdinary(), [false], 'the successful retry cleared the pending flush')
})
