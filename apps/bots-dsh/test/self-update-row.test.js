import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const bundle = await build({
  stdin: {
    contents: "export { SelfUpdateRow } from './src/client/about.js'; export { ToolCell } from './src/client/cells.js';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? ''
const checkAvailable = async () => ({ state: 'available', laneVersion: '1.2.4', checkedAt: new Date(0).toISOString() })
const ready = { startEnabled: true, startRefusal: null, run: null }
const old = { ...ready, run: { requestId: 'old-request', phase: 'healthy', to: '1.2.3' } }

function rowFixture(overrides = {}) {
  let now = 0
  let counter = 0
  let index = 0
  const timers = new Map()
  const state = []
  const effects = []
  let pending = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useState(initial) {
      const slot = index++
      if (!(slot in state)) state[slot] = initial
      return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    },
    useEffect(effect, deps) {
      const slot = index++
      const prior = effects[slot]
      if (prior && deps.every((dep, i) => Object.is(dep, prior.deps[i]))) return
      pending.push(() => {
        prior?.cleanup?.()
        effects[slot] = { deps, cleanup: effect() }
      })
    },
    createContext: () => ({}), forwardRef: view => view, memo: view => view,
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
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  const { SelfUpdateRow } = sandbox.module.exports
  const props = { Row: 'row', check: checkAvailable, readStatus: async () => ready, ...overrides }
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
    draw,
    button: (row, label) => row.children.find(child => text(child) === label)?.props,
    timers,
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

test('only a fresh available check and eligible start enable confirmation, which can be cancelled', async () => {
  let result = { startEnabled: true, startRefusal: 'team-home-custom', run: null }
  let starts = 0
  const b = rowFixture({
    readStatus: async () => result,
    start: async () => { starts++; return { started: false, reason: 'notes-unwritable' } },
  })
  const check = 'Check for updates'
  const update = 'Update now'
  let row = await b.draw()
  assert.equal(b.button(row, update), undefined)
  await b.button(row, check).onClick()
  row = await b.draw()
  assert.equal(b.button(row, update), undefined)

  result = { run: null }
  await b.button(row, check).onClick()
  row = await b.draw()
  assert.equal(b.button(row, update), undefined)

  result = ready
  await b.button(row, check).onClick()
  row = await b.draw()
  await b.button(row, update).onClick()
  row = await b.draw()
  assert.match(text(row.props.hint), /Work in progress stops when you click Update now/)
  b.button(row, 'Cancel').onClick()
  row = await b.draw()
  assert.equal(starts, 0)
  assert.equal(b.button(row, 'Cancel'), undefined)
  await b.button(row, update).onClick()
  row = await b.draw()
  await b.button(row, update).onClick()
  assert.match(text((await b.draw()).props.hint), /notes needed to recover stopped work could not be saved/)
})

test('an accepted request polls past the previous verdict and a transient error and shows its own verdict above the check', async () => {
  let accepted = false
  const statuses = [old, new Error('transient'), { ...ready, run: { requestId: 'new-request', phase: 'staging' } },
    { ...ready, run: { requestId: 'new-request', phase: 'notUpdated', reason: 'stage-failed' } }]
  const b = rowFixture({
    readStatus: async () => {
      if (!accepted) return old
      const next = statuses.shift()
      if (next instanceof Error) throw next
      return next
    },
    start: async () => { accepted = true; return { started: true, requestId: 'new-request' } },
  })
  let row = await b.draw()
  await b.button(row, 'Check for updates').onClick()
  row = await b.draw()
  await b.button(row, 'Update now').onClick()
  row = await b.draw()
  await b.button(row, 'Update now').onClick()
  row = await b.draw()
  assert.doesNotMatch(text(row.props.hint), /Updated to Automagik 1.2.3/)
  assert.equal(b.button(row, 'Check for updates').disabled, true)
  await b.advance(2000)
  row = await b.advance(2000)
  assert.match(text(row.props.hint), /Updating: installing/)
  row = await b.advance(2000)
  assert.match(text(row.props.hint), /^Not updated: the new version could not be installed/)
  assert.equal(b.timers.size, 0)
  assert.deepEqual(statuses, [])
})

test('accepted polling reaches its deadline even when the status request never replies', async () => {
  let accepted = false
  const b = rowFixture({
    readStatus: async () => accepted ? new Promise(() => {}) : old,
    start: async () => { accepted = true; return { started: true, requestId: 'missing-request' } },
  })
  let row = await b.draw()
  await b.button(row, 'Check for updates').onClick()
  row = await b.draw()
  await b.button(row, 'Update now').onClick()
  row = await b.draw()
  await b.button(row, 'Update now').onClick()
  await b.draw()
  row = await b.advance(15 * 60_000)
  assert.match(text(row.props.hint), /update status could not be confirmed/)
  assert.equal(b.button(row, 'Check for updates').disabled, false)
  assert.equal(b.timers.size, 0)
})

test('About drops eligibility at ten minutes from checkedAt, including an open confirmation', async () => {
  const b = rowFixture({ start: async () => assert.fail('the check expired') })
  let row = await b.advance(9 * 60_000)
  await b.button(row, 'Check for updates').onClick()
  row = await b.draw()
  await b.button(row, 'Update now').onClick()
  row = await b.draw()
  assert.ok(b.button(row, 'Cancel'))
  row = await b.advance(60_000)
  assert.equal(b.button(row, 'Cancel'), undefined)
  assert.equal(b.button(row, 'Update now'), undefined)
  assert.match(text(row.props.hint), /Check for updates again/)
})

test('opening confirmation reads the latest host eligibility', async () => {
  let status = ready
  const b = rowFixture({ readStatus: async () => status, start: async () => assert.fail('the host refused') })
  let row = await b.draw()
  await b.button(row, 'Check for updates').onClick()
  row = await b.draw()
  status = { ...ready, startRefusal: 'starting-up' }
  await b.button(row, 'Update now').onClick()
  row = await b.draw()
  assert.equal(b.button(row, 'Cancel'), undefined)
  assert.equal(b.button(row, 'Update now'), undefined)
  assert.match(text(row.props.hint), /picking up work from startup/)
})

test('the owner room renders its recorded update resume with update wording', async t => {
  const home = mkdtempSync(join(tmpdir(), 'update-room-row-'))
  const ada = { id: 'ada', name: 'Ada', sessionId: 'chat' }
  const room = { id: 'room', name: 'Ops', named: true, members: ['ada'], sessions: { ada: 'room-chat' }, log: [], seq: 0 }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, bots: { ada }, rooms: { room } }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => { rt.dispose(); await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  rt.logRoom(rt.roomOf('room'), { kind: 'resumed', botId: 'ada', text: '', resumedByUpdate: true })
  rt.logRoom(rt.roomOf('room'), { kind: 'resumed', botId: 'ada', text: '' })
  const replies = rt.groupRows('room', 1, 2)
  assert.deepEqual(replies.map(row => row.resumedByUpdate), [true, undefined])

  const module = { exports: {} }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: () => ({}), forwardRef: view => view, memo: view => view, Fragment: 'fragment',
    useEffect() {}, useLayoutEffect() {}, useCallback: fn => fn,
    useRef: current => ({ current }), useMemo: make => make(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  runInNewContext(bundle.outputFiles[0].text, { module, require: name => name === 'react' ? react : {} })
  const renderText = node => Array.isArray(node) ? node.map(renderText).join('')
    : typeof node?.type === 'function' ? renderText(node.type(node.props))
    : typeof node === 'string' ? node : renderText(node?.props?.children ?? [])
  const cell = module.exports.ToolCell({
    node: { data: { root: { kind: 'tool-result', name: 'group_relay', callId: 'call', call: { name: 'group_relay' },
      content: [{ type: 'text', text: JSON.stringify({ replies }) }] } } },
    sessionId: 'room', useRoster: select => select({ byId: { ada }, bots: [ada], roomsById: { room }, exchangeTurns: {} }),
    actions: {},
  })
  assert.match(renderText(cell), /Ada was interrupted by an Automagik update and picked its work back up/)
  assert.match(renderText(cell), /Ada was cut off by a restart and picked its work back up/)
})

test('the About row reports the failed check, team restore window, and manual recovery', async () => {
  const base = { phase: 'rolledBack', from: '1.2.3', to: '1.2.4' }
  const rollback = { failed: 'page', trialFrom: '2026-11-20T12:00:00Z', trialTo: '2026-11-20T12:01:00Z' }
  const hint = async run => text((await rowFixture({ readStatus: async () => ({ ...ready, run }) }).draw()).props.hint)
  const restored = await hint({ ...base, rollback: { ...rollback, data: { restored: true, trialKept: true } } })
  assert.match(restored, /Automagik 1\.2\.4 did not pass.*Automagik 1\.2\.3 is back, with the team as it was before the update/)
  for (const time of [rollback.trialFrom, rollback.trialTo]) assert.ok(restored.includes(new Date(time).toLocaleTimeString()))
  assert.match(restored, /that change is in the copy kept with the update/)
  assert.match(restored, /Failed check: The web page or its scripts did not load\./)
  const noCopy = await hint({ ...base, rollback: { ...rollback, data: { restored: true, trialKept: false } } })
  assert.match(noCopy, /is back, with the team as it was before the update/)
  assert.doesNotMatch(noCopy, /copy kept with the update/)
  const untouched = await hint({ ...base, rollback: { ...rollback, data: { restored: false, why: 'same-format' } } })
  assert.match(untouched, /Automagik 1\.2\.3 is back\. Nothing in your sessions, memory, settings or keys was lost\./)
  assert.doesNotMatch(untouched, /changed the team/)
  assert.match(await hint({ ...base, phase: 'manualRecovery', rollback }),
    /going back to 1\.2\.3.*state.json in the update store names the step that failed/)
  assert.match(await hint({ ...base, phase: 'notUpdated', reason: 'profile-invalid', detail: 'previous-unsupported' }),
    /cannot roll an update back from the app/)
})
