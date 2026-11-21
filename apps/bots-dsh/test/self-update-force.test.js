import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { CHECK_FRESH_MS } from '../src/shared/self-update.js'
import { frozen6Bytes } from './fixtures/supervisor-6.mjs'

const bundle = (await build({
  stdin: {
    contents: "export { AboutPage, SelfUpdateRow } from './src/client/about.js'; export { teamActions } from './src/client/team-actions.js';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})).outputFiles[0].text

const force = 'Force update'
const stop = 'Stop and update'
const checkButton = 'Check for updates'
const rollbackMissing = "Cannot update: this instance's update supervisor cannot roll back automatically yet, which Force update needs."
const unconfirmedUpdate = 'The update status could not be confirmed. Check again shortly.'
const unreadableStatus = 'Cannot update: the update check could not be completed.'
const staleCheck = 'Cannot update: the last check is too old. Check for updates again.'
const checkTimeout = 'Cannot update: the update check is taking too long. Try again.'
const ready = { available: true, reason: null, startEnabled: true, startRefusal: null, forceRefusal: null, rollback: true, run: null }
const noSupervisor = { available: false, reason: 'no-supervisor', run: null }
const available = (now, runId = 'checked-run') => ({ state: 'available', runId, laneVersion: '1.2.4', checkedAt: new Date(now).toISOString() })
const readOnly = () => Object.assign(new Error('no team lock'), { code: 'bot/read-only' })

const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? ''
const button = (row, label) => row.children.find(child => child?.type === 'button' && text(child) === label)?.props
const click = (row, label) => {
  const control = button(row, label)
  assert.ok(control, label)
  assert.equal(Boolean(control.disabled), false, label)
  return control.onClick()
}

function findComponent(nodes, type) {
  for (const node of nodes) {
    if (node?.type === type) return node
    const found = findComponent(node?.children ?? [], type)
    if (found) return found
  }
}

function rowFixture({
  check = now => available(now), readResult = () => assert.fail('unexpected poll'),
  start = () => ({ started: true, requestId: 'new-request' }), forceProp = true, fromAbout = false, compiled = bundle,
} = {}) {
  let now = 0
  let counter = 0
  let index = 0
  let mounted = true
  let pending = []
  let readStatus = () => ready
  const timers = new Map()
  const state = []
  const effects = []
  const calls = { checks: 0, checkBodies: [], polls: [], starts: [], statuses: 0 }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useState(initial) {
      const slot = index++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], next => {
        assert.ok(mounted, 'state was written after unmount')
        state[slot] = typeof next === 'function' ? next(state[slot]) : next
      }]
    },
    useEffect(effect, deps) {
      const slot = index++
      const prior = effects[slot]
      if (prior && deps.length === prior.deps.length && deps.every((dep, i) => Object.is(dep, prior.deps[i]))) return
      pending.push(() => {
        prior?.cleanup?.()
        effects[slot] = { deps, cleanup: effect() }
      })
    },
    useRef: current => ({ current }), createContext: () => ({}), forwardRef: view => view, memo: view => view,
  }
  const sandbox = {
    module: { exports: {} },
    require: name => name === 'react' ? react : {},
    Date: class extends Date { static now() { return now } },
    setTimeout(callback, ms) {
      timers.set(++counter, { callback, at: now + ms })
      return counter
    },
    clearTimeout: id => timers.delete(id),
  }
  runInNewContext(compiled, sandbox)
  const { AboutPage, SelfUpdateRow, teamActions } = sandbox.module.exports
  const actions = teamActions({
    async call(endpoint, body) {
      switch (endpoint) {
        case 'self-update-check':
          calls.checkBodies.push(body === undefined ? body : { ...body })
          return check(now, ++calls.checks)
        case 'self-update-check-result': calls.polls.push(body.runId); return readResult(body.runId, now)
        case 'self-update-status': calls.statuses++; return readStatus(calls.statuses)
        case 'self-update-start': calls.starts.push(body === undefined ? body : { ...body }); return start(body)
        default: assert.fail(endpoint)
      }
    },
  })
  const fromHost = host => {
    const page = AboutPage({ useUpdate: () => host, actions, Section: 'section', Row: 'row' })
    index = 0
    pending = []
    state.length = 0
    return findComponent(page, SelfUpdateRow)
  }
  const props = fromAbout ? fromHost({ hostAnswered: true }).props : {
    Row: 'row', check: actions.checkSelfUpdate, readResult: actions.selfUpdateResult,
    readStatus: actions.selfUpdateStatus, start: actions.startSelfUpdate,
    ...(forceProp ? { force: true } : {}),
  }
  const render = () => {
    index = 0
    const row = SelfUpdateRow(props)
    const batch = pending
    pending = []
    for (const update of batch) update()
    return row
  }
  const draw = async () => { render(); await immediate(); return render() }
  return {
    calls, draw, fromHost, timers,
    status(value) { readStatus = typeof value === 'function' ? value : () => value },
    unmount() {
      mounted = false
      for (const effect of effects) effect?.cleanup?.()
    },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (next === undefined || next[1].at > target) break
        const [id, { callback, at }] = next
        now = at
        timers.delete(id)
        callback()
        await immediate()
      }
      now = target
      return draw()
    },
  }
}

const hint = row => text(row.props.hint)
const noStart = (fixture, checks = 1) => {
  assert.equal(fixture.calls.checks, checks)
  assert.deepEqual(fixture.calls.starts, [])
}

test('About offers Force on identified web hosts, and the row keeps it opt-in', async () => {
  const direct = rowFixture({ forceProp: false })
  assert.equal(button(await direct.draw(), force), undefined)
  const page = rowFixture({ fromAbout: true })
  const unidentified = page.fromHost({})
  const desktop = page.fromHost({ hostAnswered: true, source: 'app' })
  assert.equal(unidentified, undefined)
  assert.equal(desktop, undefined)
  page.status(noSupervisor)
  const row = await page.draw()
  assert.equal(row.props.label, 'Automagik')
  assert.equal(hint(row), '')
  assert.equal(text(row.children.at(-1)), force)
  await click(row, force)
  assert.equal(hint(await page.draw()), 'Cannot update: this instance is not run by the update supervisor.')
  noStart(page, 0)
})

for (const [name, status, message] of [
  ['setting off', { available: true, run: null }, 'Cannot update: in-app updates are turned off for this instance.'],
  ['rollback absent', { ...ready, rollback: undefined }, rollbackMissing],
  ['live run', { ...ready, run: { runId: 'other-run', phase: 'staging' } }, 'Cannot update: an update is already running.'],
  ['invalid state', { ...ready, problem: 'Invalid state.json' }, 'Cannot update: the saved update state is invalid.'],
  ['manual recovery', { ...ready, run: { phase: 'manualRecovery' } }, 'The update needs manual recovery. See "In-app updates" in docs/upgrade.md.'],
  ['unreadable status', () => { throw new Error('offline') }, unreadableStatus],
  ['malformed status', { ...ready, run: undefined }, unreadableStatus],
  ['read-only', () => { throw readOnly() }, 'Cannot update: this window does not hold the team lock.'],
]) {
  test(`Force preflight refuses ${name} before checking`, async () => {
    const b = rowFixture()
    const row = await b.draw()
    b.status(status)
    await click(row, force)
    assert.equal(hint(await b.draw()), message)
    noStart(b, 0)
  })
}

for (const phase of ['preflight', 'after the check']) {
  test(`Force follows a run discovered ${phase} through its verdict and Check works again`, async () => {
    const running = { ...ready, run: { runId: 'other-run', phase: 'staging' } }
    const b = rowFixture({ check: (now, count) => {
      if (phase === 'after the check' && count === 1) b.status(running)
      return available(now)
    } })
    const idle = await b.draw()
    if (phase === 'preflight') b.status(running)
    await click(idle, force)
    const busy = await b.draw()
    assert.equal(hint(busy), 'Cannot update: an update is already running.')
    assert.equal(button(busy, checkButton).disabled, true)
    assert.equal(button(busy, force).disabled, true)
    noStart(b, phase === 'preflight' ? 0 : 1)

    b.status({ ...ready, run: { ...running.run, phase: 'healthy', to: '1.2.4' } })
    const healthy = await b.advance(2000)
    assert.equal(hint(healthy), 'Updated to Automagik 1.2.4.')
    assert.equal(button(healthy, force).disabled, false)
    await click(healthy, checkButton)
    assert.equal(hint(await b.draw()), 'Automagik 1.2.4 is available, signed and checked.')
    noStart(b, phase === 'preflight' ? 1 : 2)
  })
}

for (const phase of ['preflight', 'after the check', 'at confirmation']) {
  test(`Force gives a hung status read a ten-second deadline ${phase}`, async () => {
    const b = rowFixture()
    const row = await b.draw()
    const reply = Promise.withResolvers()
    const baseline = b.calls.statuses
    if (phase === 'at confirmation') await click(row, force)
    b.status(count => phase === 'after the check' && count === baseline + 1 ? ready : reply.promise)
    const pending = phase === 'at confirmation' ? click(await b.draw(), stop) : click(row, force)
    await immediate()
    assert.equal(button(await b.advance(9_999), force).disabled, true)
    const timedOut = await b.advance(1)
    assert.equal(hint(timedOut), unreadableStatus)
    assert.equal(button(timedOut, force).disabled, false)
    reply.resolve(ready)
    await pending
    assert.equal(hint(await b.draw()), unreadableStatus)
    noStart(b, phase === 'preflight' ? 0 : 1)
  })
}

test('Force preflight starts a fresh signed check even when the saved candidate was just consumed', async () => {
  const b = rowFixture()
  b.status({
    ...ready, run: { requestId: 'just-updated', phase: 'healthy', to: '1.2.3' },
    check: { ...available(0), laneVersion: '1.2.3', fresh: true, newer: false },
  })
  await click(await b.draw(), force)
  noStart(b)
  assert.ok(button(await b.draw(), stop))
})

test('a fresh immediate check re-reads readiness, asks once and follows the accepted request', async () => {
  let published = false
  const progress = [
    { ...ready, run: { requestId: 'old-request', phase: 'healthy', to: '1.2.3' } },
    { ...ready, run: { requestId: 'new-request', phase: 'staging' } },
    { ...ready, run: { requestId: 'new-request', phase: 'healthy', to: '1.2.4' } },
  ]
  const b = rowFixture({ start: () => { published = true; return { started: true, requestId: 'new-request' } } })
  const row = await b.draw()
  let eligibilityReads = 0
  b.status(() => published ? progress.shift() : eligibilityReads++ === 0 ? { ...ready, startRefusal: 'check-stale' } : ready)
  await click(row, force)
  assert.equal(eligibilityReads, 2)
  noStart(b)
  const confirm = await b.draw()
  assert.equal(hint(confirm), 'Work in progress stops when you click Stop and update, and it comes back by itself once the update is done. Nothing is lost.')
  assert.equal(button(confirm, stop).className, 'bt-fb-primary')
  await click(confirm, stop)
  assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: false }])
  const waiting = await b.draw()
  assert.equal(button(waiting, force).disabled, true)
  assert.doesNotMatch(hint(waiting), /1\.2\.3/)
  assert.match(hint(await b.advance(2000)), /^Updating: installing/)
  assert.equal(hint(await b.advance(2000)), 'Updated to Automagik 1.2.4.')
  assert.equal(b.calls.checks, 1)
  assert.deepEqual(progress, [])
})

for (const runId of ['our-check', 'another-tab']) {
  test(`Force follows the check ID ${runId} to a single start`, async () => {
    let answered = false
    const b = rowFixture({
      check: () => ({ state: 'checking', runId }),
      readResult: (id, now) => answered ? available(now, id) : { state: 'checking', runId: id },
    })
    await click(await b.draw(), force)
    const busy = await b.draw()
    assert.equal(hint(busy), 'Checking for updates…')
    assert.equal(button(busy, force).disabled, true)
    assert.equal(button(busy, checkButton).disabled, true)
    assert.equal(button(await b.advance(2000), stop), undefined)
    answered = true
    await click(await b.advance(2000), stop)
    assert.deepEqual(b.calls.polls, [runId, runId])
    assert.deepEqual(b.calls.starts, [{ force: true, runId, reinstall: false }])
    assert.equal(b.calls.checks, 1)
  })
}

for (const [name, reply, message] of [
  ['current', { state: 'current' }, 'No newer signed release is available.'],
  ['refused', { state: 'refused', reason: 'signature-invalid' }, 'Cannot update: the signed release could not be verified.'],
  ['checking without an ID', { state: 'checking' }, 'A check is already running. Try again shortly.'],
]) {
  test(`a ${name} Force check leaves the controls idle and sends no start`, async () => {
    const b = rowFixture({ check: () => reply })
    if (name === 'current') b.status({ ...ready, reinstall: true })
    await click(await b.draw(), force)
    const row = await b.draw()
    assert.equal(hint(row), message)
    assert.equal(button(row, force).disabled, false)
    assert.equal(button(row, stop), undefined)
    assert.equal(b.timers.size, 0)
    noStart(b)
  })
}

test('an earlier available result cannot authorize a refused forced check', async () => {
  const b = rowFixture({
    check: (now, count) => count === 1 ? available(now) : { state: 'refused', reason: 'signature-invalid' },
  })
  await click(await b.draw(), checkButton)
  assert.ok(button(await b.draw(), 'Update now'))
  await click(await b.draw(), force)
  const row = await b.draw()
  assert.equal(hint(row), 'Cannot update: the signed release could not be verified.')
  assert.equal(button(row, stop), undefined)
  assert.equal(button(row, 'Update now'), undefined)
  noStart(b, 2)
})

for (const age of [CHECK_FRESH_MS, CHECK_FRESH_MS + 1, -1]) {
  test(`Force refuses a signed check aged ${age}ms when opening confirmation`, async () => {
    const b = rowFixture({ check: now => available(now - age) })
    await click(await b.draw(), force)
    const row = await b.draw()
    assert.equal(hint(row), staleCheck)
    assert.equal(button(row, stop), undefined)
    noStart(b)
  })
}

test('a Force confirmation expires at exactly ten minutes and a retained click cannot start', async () => {
  const b = rowFixture()
  await click(await b.draw(), force)
  const confirm = await b.draw()
  const stillFresh = await b.advance(CHECK_FRESH_MS - 1)
  assert.ok(button(stillFresh, stop))
  const expired = await b.advance(1)
  assert.equal(button(expired, stop), undefined)
  assert.equal(hint(expired), staleCheck)
  await click(confirm, stop)
  assert.equal(hint(await b.draw()), staleCheck)
  noStart(b)
})

test('Force refuses changed saved eligibility after the check', async () => {
  const b = rowFixture({ check: now => {
    b.status({ ...ready, startRefusal: 'check-stale', forceRefusal: 'check-stale' })
    return available(now)
  } })
  await click(await b.draw(), force)
  const row = await b.draw()
  assert.equal(hint(row), staleCheck)
  assert.equal(button(row, stop), undefined)
  noStart(b)
})

test('Force refuses rollback capability lost while confirmation is open', async () => {
  const b = rowFixture()
  await click(await b.draw(), force)
  const confirm = await b.draw()
  b.status({ ...ready, rollback: undefined })
  await click(confirm, stop)
  assert.equal(hint(await b.draw()), rollbackMissing)
  noStart(b)
})

test('Update now clears a Force refusal and sends its original request', async () => {
  const b = rowFixture()
  b.status({ ...ready, rollback: undefined })
  await click(await b.draw(), checkButton)
  await click(await b.draw(), force)
  assert.equal(hint(await b.draw()), rollbackMissing)
  await click(await b.draw(), 'Update now')
  await click(await b.draw(), 'Update now')
  b.status({ ...ready, run: { requestId: 'new-request', phase: 'healthy', to: '1.2.4' } })
  assert.equal(hint(await b.draw()), 'Updated to Automagik 1.2.4.')
  assert.equal(b.calls.checks, 1)
  assert.deepEqual(b.calls.starts, [undefined])
})

test('Force consumes confirmation synchronously and never retries an ambiguous start', async () => {
  const reply = Promise.withResolvers()
  const b = rowFixture({ start: () => reply.promise })
  await click(await b.draw(), force)
  const confirm = await b.draw()
  const first = click(confirm, stop)
  await click(confirm, stop)
  await immediate()
  assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: false }])
  reply.reject(new Error('connection lost'))
  await first
  assert.equal(hint(await b.draw()), 'The update status could not be confirmed. Check again shortly.')
  await click(confirm, stop)
  assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: false }])
  assert.equal(b.calls.checks, 1)
})

test('a hung Force start times out without resending and follows the later supervisor run', async () => {
  const b = rowFixture({ start: () => new Promise(() => {}) })
  b.status({ ...ready, run: { runId: 'old-run', requestId: 'old-request', phase: 'healthy', to: '1.2.3' } })
  await click(await b.draw(), force)
  const confirm = await b.draw()
  const pending = click(confirm, stop)
  await immediate()

  assert.equal(button(await b.advance(29_999), checkButton).disabled, true)
  const timedOut = await b.advance(1)
  await pending
  assert.equal(hint(timedOut), unconfirmedUpdate)
  assert.equal(button(timedOut, checkButton).disabled, false)
  await click(confirm, stop)
  assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: false }])

  b.status({ ...ready, run: { runId: 'new-run', requestId: 'new-request', phase: 'staging' } })
  const running = await b.advance(2000)
  assert.match(hint(running), /^Updating: installing/)
  assert.equal(button(running, checkButton).disabled, true)
  b.status({ ...ready, run: { runId: 'new-run', requestId: 'new-request', phase: 'healthy', to: '1.2.4' } })
  const healthy = await b.advance(2000)
  assert.equal(hint(healthy), 'Updated to Automagik 1.2.4.')
  assert.equal(button(healthy, checkButton).disabled, false)
  assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: false }])
})

test('Cancel invalidates Force consent without starting work', async () => {
  const b = rowFixture()
  await click(await b.draw(), force)
  const confirm = await b.draw()
  click(confirm, 'Cancel')
  await click(confirm, stop)
  assert.equal(button(await b.draw(), stop), undefined)
  noStart(b)
})

test('a manual check supersedes Force and leaves its late reply without consent', async () => {
  const reply = Promise.withResolvers()
  const b = rowFixture({ check: (_now, count) => count === 1 ? reply.promise : { state: 'current' } })
  const idle = await b.draw()
  const forced = click(idle, force)
  await immediate()
  await click(idle, checkButton)
  reply.resolve(available(0))
  await forced
  const row = await b.draw()
  assert.equal(hint(row), 'Up to date.')
  assert.equal(button(row, stop), undefined)
  noStart(b, 2)
})

test('unmount drops the forced check and ignores its late reply', async () => {
  const reply = Promise.withResolvers()
  const b = rowFixture({ check: () => reply.promise })
  const pending = click(await b.draw(), force)
  await immediate()
  b.unmount()
  assert.equal(b.timers.size, 0)
  reply.resolve(available(0))
  await pending
  noStart(b)
})

for (const polled of [false, true]) {
  test(`the six-minute Force deadline ignores a late ${polled ? 'poll' : 'check'} reply`, async () => {
    const reply = Promise.withResolvers()
    const b = rowFixture({
      check: () => polled ? { state: 'checking', runId: 'run' } : reply.promise,
      readResult: () => reply.promise,
    })
    const pending = click(await b.draw(), force)
    assert.equal(button(await b.draw(), force).disabled, true)
    assert.equal(button(await b.advance(359_999), force).disabled, true)
    assert.deepEqual(b.calls.polls, polled ? ['run'] : [])
    const timedOut = await b.advance(1)
    assert.equal(hint(timedOut), checkTimeout)
    assert.equal(button(timedOut, force).disabled, false)
    reply.resolve(available(360_000))
    await pending
    const row = await b.draw()
    assert.equal(hint(row), checkTimeout)
    assert.equal(button(row, stop), undefined)
    assert.equal(b.timers.size, 0)
    noStart(b)
  })
}

for (const [reason, start, message] of [
  ['team-home-custom', () => ({ started: false, reason: 'team-home-custom' }), 'Cannot update: the team is kept in a custom folder the update cannot snapshot.'],
  ['bot/read-only', () => { throw readOnly() }, 'Cannot update: this window does not hold the team lock.'],
]) {
  test(`Force surfaces ${reason} from start without following an attempt`, async () => {
    const b = rowFixture({ start })
    await click(await b.draw(), force)
    await click(await b.draw(), stop)
    const row = await b.draw()
    assert.equal(hint(row), message)
    assert.equal(button(row, force).disabled, false)
    assert.equal(b.calls.checks, 1)
    assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: false }])
  })
}

test('a capable Force check binds same-version consent, allows Cancel and retry, and shows the repair verdict', async () => {
  const b = rowFixture({ check(now) { return { ...available(now), reinstall: true } } })
  b.status({ ...ready, reinstall: true, startRefusal: 'reinstall-needs-force', forceRefusal: 'check-stale' })
  const idle = await b.draw()
  const checking = click(idle, force)
  b.status({ ...ready, reinstall: true, startRefusal: 'reinstall-needs-force', forceRefusal: null })
  await checking
  const confirmation = await b.draw()
  assert.equal(hint(confirmation), 'Automagik 1.2.4 is already installed. Stop and update reinstalls the same signed version: work in progress stops and comes back by itself once it is done. Nothing is lost.')
  assert.equal(button(confirmation, 'Update now'), undefined)
  click(confirmation, 'Cancel')
  const canceled = await b.draw()
  assert.equal(button(canceled, 'Update now'), undefined)
  assert.equal(hint(canceled), 'Automagik 1.2.4 is already installed.')
  await click(canceled, force)
  const consent = await b.draw()
  await click(consent, stop)
  assert.deepEqual(b.calls.checkBodies, [{ reinstall: true }, { reinstall: true }])
  assert.deepEqual(b.calls.starts, [{ force: true, runId: 'checked-run', reinstall: true }])
  b.status({ ...ready, reinstall: true, run: { requestId: 'new-request', phase: 'healthy', to: '1.2.4', reinstall: true } })
  assert.equal(hint(await b.draw()), 'Reinstalled Automagik 1.2.4.')
})

test('a rollback-only supervisor gets a plain Force check while an older host cannot confirm an available reply', async () => {
  const current = rowFixture({ check: () => ({ state: 'current' }) })
  current.status({ ...ready, startRefusal: 'reinstall-needs-force', forceRefusal: 'reinstall-unsupported' })
  await click(await current.draw(), force)
  assert.deepEqual(current.calls.checkBodies, [undefined])
  assert.equal(hint(await current.draw()), 'No newer signed release is available. Reinstalling the same version needs a newer update supervisor.')
  const { forceRefusal, ...olderStatus } = ready
  const oldHost = rowFixture()
  oldHost.status(olderStatus)
  await click(await oldHost.draw(), force)
  assert.equal(hint(await oldHost.draw()), unreadableStatus)
  noStart(oldHost)
})

test('the delivery 6 page displays its fallback when the host refuses an unbound Force start', async () => {
  const compiled = gunzipSync(frozen6Bytes('self-update-client.cjs.gz')).toString('utf8')
  const b = rowFixture({ compiled, start: () => ({ started: false, reason: 'page-outdated' }) })
  await click(await b.draw(), force)
  await click(await b.draw(), stop)
  assert.deepEqual(b.calls.starts, [{ force: true }])
  assert.equal(hint(await b.draw()), unreadableStatus)
})
