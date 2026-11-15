import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-switch.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// Keep hook slots across renders; effects run synchronously and state updates request
// another render, so a poll can be distinguished from a new mismatch's pulse.
function harness() {
  const slots = []
  let cursor = 0
  let dirty = false
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'react') return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        Fragment: 'Fragment', useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useRef: initial => slots[cursor++] ??= { current: initial },
        useState: (initial) => {
          const slot = slots[cursor++] ??= { value: initial }
          return [slot.value, (update) => {
            slot.value = typeof update === 'function' ? update(slot.value) : update
            dirty = true
          }]
        },
        useEffect: (effect, deps) => {
          const index = cursor++
          const previous = slots[index]
          if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
            slots[index] = deps
            effect()
          }
        },
        useMemo: fn => fn(), useCallback: fn => fn,
      }
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`Unexpected platform module ${name}`)
    },
  })
  return {
    ...module.exports,
    render: (roster) => {
      let row
      do {
        cursor = 0
        dirty = false
        row = module.exports.ModelSwitchNotice({ sessionId: 'part-2', useRoster: pick => pick(roster) })
      } while (dirty)
      return row
    },
  }
}

const { switchSeen } = harness()
const botId = 'bot-1'
const keyA = 'bot-1|provider/flash|provider/saved'
const keyB = 'bot-1|provider/other|provider/saved'

test('first load seeds the memo without a fresh event, even with a mismatch', () => {
  for (const key of [undefined, keyA]) {
    const next = switchSeen(undefined, botId, key)
    assert.equal(next.fresh, false)
    assert.equal(next.memo.botId, botId)
    assert.equal(next.memo.key, key)
  }
})

test('mismatch transitions are fresh once; polls and returning to equal are not', () => {
  let memo = switchSeen(undefined, botId, undefined).memo
  for (const [key, fresh] of [[keyA, true], [keyA, false], [undefined, false], [keyA, true], [keyB, true], [keyB, false]]) {
    const before = { ...memo }
    const next = switchSeen(memo, botId, key)
    assert.equal(next.fresh, fresh)
    assert.equal(memo.botId, before.botId)
    assert.equal(memo.key, before.key)
    memo = next.memo
  }
})

test('changing Bots seeds without a fresh event', () => {
  const previous = switchSeen(undefined, botId, keyA).memo
  const next = switchSeen(previous, 'bot-2', 'bot-2|provider/flash|provider/saved')
  assert.equal(next.fresh, false)
  assert.equal(next.memo.botId, 'bot-2')
  assert.equal(switchSeen(next.memo, 'bot-2', next.memo.key).fresh, false)
})

const rosterOf = (runningModel) => ({
  byId: { 'part-2': { id: botId, sessionId: 'part-2', name: 'Test Bot', model: 'provider/saved', runningModel } },
  models: [],
})

const rowOf = dock => dock?.children[1] ?? null
const saidOf = dock => dock.children[0].children[0]

test('a first render already showing a mismatch has no data-fresh and says nothing', () => {
  const { render } = harness()
  const dock = render(rosterOf('provider/flash'))
  assert.equal(rowOf(dock).props['data-fresh'], undefined)
  assert.equal(rowOf(dock).props.key, 0)
  assert.equal(saidOf(dock), '')
})

test('the component pulses on transitions, keeps the row key on polls and hides when equal', () => {
  const { render } = harness()
  const equal = render(rosterOf('provider/saved'))
  assert.equal(rowOf(equal), null)
  assert.equal(equal.children[0].props.role, 'status')
  const first = render(rosterOf('provider/flash'))
  assert.equal(rowOf(first).props['data-fresh'], '')
  assert.equal(rowOf(first).props.key, 1)
  assert.equal(saidOf(first), 'This chat is running on flash instead of saved.')
  const poll = render(rosterOf('provider/flash'))
  assert.equal(rowOf(poll).props.key, 1)
  assert.equal(render(rosterOf('provider/other')).children[1].props.key, 2)
  const back = render(rosterOf('provider/saved'))
  assert.equal(rowOf(back), null)
  assert.equal(saidOf(back), '')
  assert.equal(rowOf(render(rosterOf('provider/flash'))).props.key, 3)
})

test('the entrance mark goes once its animation ends', () => {
  const { render } = harness()
  render(rosterOf('provider/saved'))
  const row = rowOf(render(rosterOf('provider/flash')))
  assert.equal(row.props['data-fresh'], '')
  row.props.onAnimationEnd()
  assert.equal(rowOf(render(rosterOf('provider/flash'))).props['data-fresh'], undefined)
})

test('a reading with no running model neither ends nor starts a switch', () => {
  const { render } = harness()
  render(rosterOf('provider/flash'))
  assert.equal(rowOf(render(rosterOf(undefined))), null)
  const again = rowOf(render(rosterOf('provider/flash')))
  assert.equal(again.props.key, 0)
  assert.equal(again.props['data-fresh'], undefined)
  const { render: other } = harness()
  other(rosterOf('provider/saved'))
  other(rosterOf(undefined))
  assert.equal(rowOf(other(rosterOf('provider/flash'))).props.key, 1)
})

test('another Bot on the same chat slot starts fresh, without an event', () => {
  const { render } = harness()
  render(rosterOf('provider/saved'))
  const roster = rosterOf('provider/flash')
  roster.byId['part-2'] = { ...roster.byId['part-2'], id: 'bot-2' }
  assert.equal(rowOf(render(roster)).props.key, 0)
})

test('the entrance reuses keyframes the shell installs', async () => {
  const { readFile } = await import('node:fs/promises')
  const secret = await readFile(new URL('../src/client/secret-card.js', import.meta.url), 'utf8')
  assert.match(secret, /@keyframes bt-secret-in\{/)
  assert.match(harness().MODEL_SWITCH_CSS, /animation:bt-secret-in /)
  const index = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /shadow\('conversation\.input\.dock', \{ id: 'bot-model-switch', order: -70, inject: face \}, ModelSwitchNotice\)/)
})
