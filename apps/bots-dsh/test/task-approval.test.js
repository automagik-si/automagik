import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The task card as the browser gets it, with a React stand-in that keeps hook state across
// renders, so a click and the render after it can be checked.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-card.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const hookState = []
let hookAt = 0
// React's rule, kept by the stand-in: every render reads the same hooks in the same order.
// A hook read after the calls changed is the crash the shell would hit, so it is one here.
let hookKinds = []
let previousKinds = null
const readHook = (kind, read) => {
  const at = hookAt++
  if (previousKinds && previousKinds[at] !== kind) throw new Error(`hook ${at} was ${previousKinds[at] ?? 'not read'}, now ${kind}`)
  hookKinds[at] = kind
  return read(at)
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => readHook('useState', (at) => {
    if (!(at in hookState)) hookState[at] = initial
    return [hookState[at], (value) => { hookState[at] = typeof value === 'function' ? value(hookState[at]) : value }]
  }),
  useEffect: () => readHook('useEffect', () => {}), useLayoutEffect: () => readHook('useLayoutEffect', () => {}),
  useRef: current => readHook('useRef', () => ({ current })), useMemo: fn => readHook('useMemo', () => fn()), Fragment: 'fragment',
}
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: name => (name === 'react' ? react : {}),
  Date, Math, JSON, Intl, setTimeout, clearTimeout,
})
const { TaskCard, taskState, approvalFor } = module.exports
// Every render starts hook reads from the top; state stays where the setter left it, and a
// render that changes the hook order fails as React does.
const render = props => {
  hookAt = 0
  previousKinds = hookState.length === 0 ? null : hookKinds
  hookKinds = []
  const tree = TaskCard(props)
  if (previousKinds && hookKinds.length !== previousKinds.length) throw new Error(`rendered ${hookKinds.length} hooks, previously ${previousKinds.length}`)
  return tree
}
const walk = (node, into = []) => {
  if (node === null || node === undefined || node === false) return into
  if (Array.isArray(node)) { node.forEach(child => walk(child, into)); return into }
  if (typeof node === 'object') {
    into.push(node)
    walk(node.children, into)
  }
  return into
}
const text = (node, out = []) => {
  if (typeof node === 'string') { out.push(node); return out.join('') }
  if (node === null || node === undefined || typeof node === 'boolean') return out.join('')
  if (Array.isArray(node)) { node.forEach(child => text(child, out)); return out.join('') }
  if (typeof node === 'object') text(node.children, out)
  return out.join('')
}
const button = (tree, label) => walk(tree).find(child => child.type === 'button' && text(child).includes(label))

// One approval DSH holds for the task's Session, as the client's status hook exposes it.
const pendingOf = () => {
  const answers = []
  const pending = {
    kind: 'approval',
    toolName: 'bash',
    answerable: true,
    answer: (outcome) => {
      if (!pending.answerable) throw new Error('pending approval is already settled')
      pending.answerable = false
      answers.push(outcome)
    },
  }
  return { pending, answers }
}

const props = (sessionId, pending, work, overrides = {}) => {
  const status = new Map([[sessionId, pending === undefined ? {} : { pendingInteraction: pending }]])
  return {
    sessionId,
    title: 'Add a README',
    task: { from: 'genie', status: 'working', title: 'Add a README', at: 1_000 },
    onOpen: () => {},
    useSessionStatus: select => select(status),
    useWork: select => select(work),
    ...overrides,
  }
}

test('a task blocked on an approval says so in its parent chat and answers that one request', async () => {
  hookState.length = 0
  const { pending, answers } = pendingOf()
  const work = { approvals: [{ id: 'a1', botId: 'genie', taskId: 'task1', tool: 'bash', label: 'Add a README' }] }
  let tree = render(props('task1', pending, work))
  assert.equal(tree.props['data-state'], 'waiting')
  assert.match(tree.props.className, /op-task/)
  // The one line names the task and the tool, not just the Bot.
  assert.match(text(tree), /Task Add a README is waiting for approval: bash/)
  const allow = button(tree, 'Allow once')
  const reject = button(tree, 'Reject')
  assert.ok(allow && reject, 'the compact card offers both decisions')

  allow.props.onClick()
  await Promise.resolve()
  assert.deepEqual(answers, ['allowed-once'])
  // Answered: the same surface no longer offers a decision, and a second click does nothing.
  tree = render(props('task1', pending, work))
  assert.equal(button(tree, 'Allow once').props.disabled, true)
  button(tree, 'Allow once').props.onClick()
  assert.deepEqual(answers, ['allowed-once'])
})

test('the task chat settling the approval leaves the parent card with no stale decision', () => {
  hookState.length = 0
  const { pending } = pendingOf()
  // Answered in the task's own chat: DSH settles the pending object and the work note goes.
  pending.answerable = false
  const tree = render(props('task1', undefined, { approvals: [] }))
  assert.equal(tree.props['data-state'], 'working')
  assert.equal(button(tree, 'Allow once'), undefined)
  assert.doesNotMatch(text(tree), /waiting for approval/)
})

test('a task waiting on a question keeps the open-it hint, not approval buttons', () => {
  hookState.length = 0
  const tree = render(props('task1', { kind: 'question' }, { approvals: [] }))
  assert.equal(tree.props['data-state'], 'waiting')
  assert.equal(button(tree, 'Allow once'), undefined)
  assert.match(text(tree), /It asks for your OK/)
})

test('a running task without an approval still shows what it does', () => {
  hookState.length = 0
  const tree = render(props('task1', undefined, { approvals: [] }, { task: { from: 'genie', status: 'working', title: 'Add a README', at: 1_000, said: 'Cloning…' } }))
  assert.equal(tree.props['data-state'], 'working')
  assert.match(text(tree), /Cloning…/)
  assert.equal(taskState({ status: 'working' }, true), 'waiting')
  assert.equal(approvalFor({ approvals: [{ taskId: 'task1' }] }, 'task1'), true)
})

test('a working task shows its newest open stop, then its own words when closed', () => {
  hookState.length = 0
  const stops = [{ taskId: 'x', open: true, why: 'tool', tool: 'bash', count: 1, at: 1 }, { taskId: 'x', open: true, why: 'review', count: 1, at: 2 }]
  const task = { from: 'ada', status: 'working', title: 'x', said: 'someone', at: 1 }
  let tree = render(props('x', undefined, { stops }, { task }))
  assert.match(text(tree), /A step did not run: Auto review refused it/)
  assert.doesNotMatch(text(tree), /someone/)
  stops.forEach(entry => { entry.open = false })
  tree = render(props('x', undefined, { stops }, { task }))
  assert.match(text(tree), /someone/)
  assert.doesNotMatch(text(tree), /did not run/)
})

test('a task child opens its task for the full ask, without inline approval buttons', () => {
  hookState.length = 0
  let opened = 0
  const work = { approvals: [{ id: 'x', child: true, taskId: 'x', botId: 'ada', tool: 'bash', answerable: true }] }
  const tree = render(props('x', undefined, work, { task: { from: 'ada', status: 'working', title: 'x', at: 1 }, onOpen: () => { opened++ } }))
  assert.match(text(tree), /Waiting for you/)
  assert.match(text(tree), /It asks for your OK. Open it to answer./)
  assert.equal(button(tree, 'Allow once'), undefined)
  assert.equal(button(tree, 'Reject'), undefined)
  button(tree, 'Answer it').props.onClick()
  assert.equal(opened, 1)
})

test('a start_task card drawn without its Session keeps its hooks when the id arrives', () => {
  hookState.length = 0
  const { pending } = pendingOf()
  const status = new Map([['task1', { pendingInteraction: pending }]])
  const work = {
    // A Bot's own approval and stop name no task: without an id the card must not take them.
    approvals: [{ id: 'bot', botId: 'genie', tool: 'bash' }, { id: 'task', botId: 'genie', taskId: 'task1', tool: 'bash' }],
    stops: [{ open: true, why: 'tool', tool: 'bash', at: 1 }],
  }
  // The shell's hooks take a React slot, as the real ones do: calling them only once the id
  // is there changes the card's hook order, which the stand-in fails on as React does.
  const useSessionStatus = select => { react.useState(0); return select(status) }
  const useWork = select => { react.useState(0); return select(work) }
  const card = sessionId => ({ sessionId, title: 'Add a README', task: { from: 'genie', status: 'working', at: 1_000 }, onOpen: () => {}, useSessionStatus, useWork })

  // The start_task call has not settled, so there is no Session id yet.
  let tree = render(card(undefined))
  assert.equal(tree.props['data-state'], 'working')
  assert.equal(button(tree, 'Allow once'), undefined)
  assert.doesNotMatch(text(tree), /did not run/)

  // The result names the Session: the same card is drawn again, now waiting on its approval.
  tree = render(card('task1'))
  assert.equal(tree.props['data-state'], 'waiting')
  assert.match(text(tree), /Task Add a README is waiting for approval: bash/)
})

test('D client: the task card displays the keep-working question', () => {
  hookState.length = 0
  const { pending } = pendingOf()
  pending.toolName = 'keep_working'
  pending.reason = 'ada was refused 4 times in this turn, the last time on bash. Let it keep working?'
  const tree = render(props('x', pending, { approvals: [] }))
  assert.ok(text(tree).includes(pending.reason))
})
