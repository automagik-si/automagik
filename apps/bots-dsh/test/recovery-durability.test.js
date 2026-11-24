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
