import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The card's module as the browser gets it, with stand-ins for the platform it runs on.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/team-approval.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const focused = []
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: effect => effect(), useRef: () => ({ current: { focus: options => focused.push(options) } }), useLayoutEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: () => undefined, Fragment: 'fragment', forwardRef: fn => fn, memo: fn => fn, createContext: () => ({}), useContext: () => undefined },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
  document: undefined, window: undefined, Date, Math, JSON, Intl, setTimeout, clearTimeout,
})
const { approvalView, argsOf, isTeamApproval, TeamApproval, ChildApprovalDock } = module.exports

test('a named task approval shows the requested model', () => {
  const view = approvalView('mcp__dsh__start_task', { title: 'Fixture', model: 'acp-fake/two' }, 'Fixture')
  assert.deepEqual(JSON.parse(JSON.stringify(view.rows)), [['title', 'Fixture'], ['Requested model', 'acp-fake/two']])
})
const plain = value => JSON.parse(JSON.stringify(value))

test('a Claude Code chat\'s delegation reads as a handoff, with the message as a quote', () => {
  const reason = JSON.stringify({ to: 'Genie', message: 'Create delegation-test.txt, then reply with its path.' })
  const view = approvalView('mcp__dsh__message_bot', argsOf(reason), 'Echo')
  assert.equal(view.title, 'Echo wants to hand work to Genie')
  assert.equal(view.to, 'Genie')
  assert.equal(view.quote, 'Create delegation-test.txt, then reply with its path.')
  assert.equal(view.note, 'Genie works on it in its own chat and reports back.')
})

test('the card takes over only the team\'s own tools, with or without the bridge prefix', () => {
  assert.equal(isTeamApproval({ kind: 'approval', toolName: 'mcp__dsh__message_bot' }), true)
  assert.equal(isTeamApproval({ kind: 'approval', toolName: 'start_task' }), true)
  assert.equal(isTeamApproval({ kind: 'approval', toolName: 'bash' }), false)
  assert.equal(isTeamApproval({ kind: 'question', toolName: 'message_bot' }), false)
})

test('a delete approval names the Bot and its consequences', () => {
  const view = approvalView('delete_bot', { bot: 'Writer' }, 'Omni')
  assert.equal(view.title, 'Omni wants to delete Writer')
  assert.equal(view.to, 'Writer')
  assert.match(view.note, /archives its memory and conversations/)
  assert.equal(isTeamApproval({ kind: 'approval', toolName: 'delete_bot' }), true)
})

test('arguments that are not the bridge\'s JSON give no fields, and nothing shows as raw JSON', () => {
  assert.deepEqual(plain(argsOf('escalate sandbox')), {})
  assert.deepEqual(plain(argsOf('[1,2]')), {})
  const view = approvalView('mcp__dsh__save_capability', { name: 'github', spec: { nested: true }, note: ' ' }, undefined)
  assert.equal(view.title, 'This Bot wants to use save_capability')
  assert.deepEqual(plain(view.rows), [['name', 'github']])
})

const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(nodes)]
const content = node => typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : node.children.map(content).join('')
test('the child dock selects the oldest answerable child of this Session and shows the operation', () => {
  const answers = []
  const useRoster = pick => pick({ byId: { ada: { id: 'ada', name: 'ada' } } })
  const actions = { answerApproval: (...args) => answers.push(args) }
  const entry = { id: 'x', child: true, answerable: true, botId: 'ada', sessionId: 'child', ownerSessionId: 'ada-chat', tool: 'bash', reason: 'someone', detail: { code: 'ls x', text: 'x' } }
  const dock = approvals => ChildApprovalDock({ sessionId: 'ada-chat', useRoster, useWork: pick => pick({ approvals }), actions })
  const misses = [{ ...entry, child: false }, { ...entry, answerable: false }, { ...entry, ownerSessionId: 'other' }]
  assert.equal(dock([]), null)
  assert.equal(dock(misses), null)
  const rendered = dock([...misses, entry, { ...entry, id: 'later' }])
  assert.equal(rendered.type, TeamApproval)
  assert.equal(rendered.props.key, 'x')
  focused.length = 0
  const card = rendered.type(rendered.props)
  assert.equal(focused.length, 0, 'a child card cannot take Enter from the composer')
  assert.match(content(card), /A subagent is waiting for your approval/)
  assert.match(content(card), /ada wants to use bash/)
  assert.equal(content(nodes(card).find(n => n.type === 'blockquote')), 'ls x')
  assert.equal(content(nodes(card).find(n => n.props.className === 'bt-apr-note')), 'x · someone')
  nodes(card).find(n => n.type === 'button' && content(n).includes('Allow once')).props.onClick()
  nodes(card).find(n => n.type === 'button' && content(n).includes('Reject')).props.onClick()
  assert.deepEqual(answers, [['x', 'allow'], ['x', 'reject']])
  TeamApproval({ useRoster, matched: { key: 'team', kind: 'approval', sessionId: 'ada', toolName: 'start_task', reason: '{}', answerable: true, answer: () => {} } })
  assert.equal(focused.length, 1, 'a team-tool card still focuses')
})

test('D client: keep-working uses the team card and explains that no refused step runs', async () => {
  const { KEEP_WORKING: hostKeep, questionText } = await import('../src/host/ladder.js')
  const { KEEP_WORKING, TeamApproval } = module.exports
  assert.equal(KEEP_WORKING, hostKeep)
  const pending = { kind: 'approval', toolName: KEEP_WORKING, sessionId: 'ada', reason: questionText('ada', 4, 'bash') }
  assert.equal(isTeamApproval(pending), true)
  const tree = TeamApproval({ matched: pending, useRoster: select => select({ byId: { ada: { id: 'ada', name: 'ada' } } }) })
  assert.ok(JSON.stringify(tree).includes(pending.reason))
  assert.ok(JSON.stringify(tree).includes('Allow once lets it keep working: nothing that was refused runs. Reject stops it here.'))
})
