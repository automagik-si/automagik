import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// A Bot's running tasks hang under its row as threads, and its task card in the chat shows
// the same state: working, or waiting for the user. The sidebar and the card run on a
// minimal React stand-in, as in sidebar-switch.test.js; the test calls the components it
// looks into.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar, threadAge, THREADS_SHOWN, staysInView } from './src/client/sidebar.js'\nexport { TaskCard, taskState } from './src/client/task-card.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let stateSets = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id', useCallback: fn => fn,
  useState: (initial) => {
    const set = value => stateSets.push(value)
    return [typeof initial === 'function' ? initial() : initial, set]
  },
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  matchMedia: () => ({ matches: false }),
})
const { TeamSidebar, TaskCard, taskState, threadAge, THREADS_SHOWN, staysInView } = module.exports

const find = (node, match, found = []) => {
  if (Array.isArray(node)) { node.forEach(child => find(child, match, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (match(node)) found.push(node)
  find(node.props?.children, match, found)
  return found
}
const named = name => node => node.type?.name === name
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')

const NOW = Date.now()
const pip = { id: 'pip', name: 'Pip', role: 'Orchestrator', sessionId: 'pip', createdAt: 1 }
const omni = { id: 'omni', name: 'Omni', kind: 'omni', sessionId: 'omni', createdAt: 2 }

function sidebar({ tasks, waiting = [], approvals = [], stops = [], wide = true, agents = [] }) {
  const roster = {
    bots: [pip, omni], rooms: [], agents, byId: { pip, omni }, roomsById: {}, agentOf: {},
    mainBotId: 'pip', mainBotIds: ['pip'], exchangeTurns: {}, questions: {}, ready: true, tasks,
  }
  const opened = []
  const status = new Map(waiting.map(id => [id, { pendingInteraction: { kind: 'approval' } }]))
  const tree = TeamSidebar({
    wide, actions: { openSession: id => opened.push(id) },
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: { 'session-a': { retainedBy: { mainView: 1 } } } }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(status),
    useSessionRetainInfo: (_id, pick) => pick(undefined),
    useActivity: pick => pick({}),
    useWork: pick => pick({ approvals, stops, rooms: {}, waiting: {} }),
  })
  const threadsOf = id => find(tree, named('BotThreads')).find(node => node.props.bot.id === id)
  const rowOf = id => find(tree, named('BotRow')).find(node => node.props.bot.id === id)
  return { tree, opened, threadsOf, rowOf }
}

const task = (from, title, minutes, status = 'working') => ({ from, title, at: NOW - minutes * 60_000, status })

test('a Bot\'s running tasks hang under its row: spinner while working, amber while waiting for you', () => {
  const { threadsOf, rowOf, opened } = sidebar({
    tasks: {
      'session-a': task('pip', 'Plan the launch week', 4),
      'session-b': task('pip', 'Approve: send summary to Ana?', 0),
      'session-c': task('pip', 'Old report', 90, 'done'),
      'session-d': task('omni', 'Triage 12 unread in #support', 1),
    },
    waiting: ['session-b'],
  })
  const threads = threadsOf('pip')
  const group = threads.type(threads.props)
  const rows = find(group, node => node.props?.className === 'bt-thread')
  // Waiting comes first; a finished task is not a thread.
  assert.deepEqual(rows.map(row => row.props['data-state']), ['waiting', 'working'])
  assert.deepEqual(rows.map(row => textOf(find(row, node => node.props?.className === 'bt-thread-title'))), ['Approve: send summary to Ana?', 'Plan the launch week'])
  assert.equal(find(rows[0], node => node.props?.className === 'bt-thread-wait').length, 1)
  assert.equal(find(rows[1], node => node.props?.className === 'bt-thread-spin').length, 1)
  assert.deepEqual(rows.map(row => textOf(find(row, node => node.props?.className === 'bt-thread-age'))), ['now', '4m'])
  assert.equal(rows[0].props['aria-label'], 'Approve: send summary to Ana?, Waiting for you')
  // The task open in the main view is marked.
  assert.equal(rows[1].props['aria-current'], 'page')
  rows[0].props.onClick()
  assert.deepEqual(opened, ['session-b'])
  // The Omni Bot has its own.
  const omniRows = find(threadsOf('omni').type(threadsOf('omni').props), node => node.props?.className === 'bt-thread')
  assert.equal(omniRows.length, 1)
  // The row says how many things the Bot is on.
  const row = rowOf('pip').type(rowOf('pip').props)
  assert.equal(textOf(find(row, node => node.props?.className === 'bt-row-preview')), 'Working on 2 things')
})

test('past three threads the rest fold into a count, which unfolds them', () => {
  const tasks = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`session-${index}`, task('pip', `Task ${index}`, index + 1)]))
  const { threadsOf } = sidebar({ tasks })
  const threads = threadsOf('pip')
  const group = threads.type(threads.props)
  const rows = find(group, node => node.props?.className === 'bt-thread')
  assert.equal(rows.length, THREADS_SHOWN)
  const [more] = find(group, node => node.props?.className === 'bt-thread bt-thread-more')
  assert.equal(textOf(more), '+3 more')
  stateSets = []
  more.props.onClick()
  assert.deepEqual(stateSets, [true])
  // Four fit without a count: a "+1 more" row would take the same room.
  const four = sidebar({ tasks: Object.fromEntries(Object.entries(tasks).slice(0, 4)) }).threadsOf('pip')
  const fourGroup = four.type(four.props)
  assert.equal(find(fourGroup, node => node.props?.className === 'bt-thread').length, 4)
})

test('no threads in the narrow rail, nor for a Bot with no running task', () => {
  const narrow = sidebar({ tasks: { 'session-a': task('pip', 'Plan', 2) }, wide: false }).threadsOf('pip')
  assert.equal(narrow.type(narrow.props), null)
  const idle = sidebar({ tasks: {} }).threadsOf('pip')
  assert.equal(idle.type(idle.props), null)
})

test('a thread\'s age is short', () => {
  assert.equal(threadAge(NOW - 20_000, NOW), 'now')
  assert.equal(threadAge(NOW - 4 * 60_000, NOW), '4m')
  assert.equal(threadAge(NOW - 3 * 3_600_000, NOW), '3h')
  assert.equal(threadAge(NOW - 50 * 3_600_000, NOW), '2d')
})

test('the task card in the chat shows the same state as the thread', () => {
  assert.equal(taskState({ status: 'working' }, true), 'waiting')
  assert.equal(taskState({ status: 'working' }, false), 'working')
  assert.equal(taskState({ status: 'done' }, true), 'done')
  // The approval DSH holds for the task's Session: the card answers that one request.
  const answers = []
  const pending = { kind: 'approval', toolName: 'bash', answerable: true, answer: outcome => answers.push(outcome) }
  const card = (waiting) => TaskCard({
    sessionId: 'session-b', title: 'Send summary to Ana?', task: task('pip', 'Send summary to Ana?', 0), onOpen() {},
    useSessionStatus: pick => pick(new Map(waiting ? [['session-b', { pendingInteraction: pending }]] : [])),
  })
  const waiting = card(true)
  assert.equal(waiting.props['data-state'], 'waiting')
  assert.match(textOf(waiting), /Waiting for you/)
  assert.equal(find(waiting, node => node.props?.className === 'op-task-wait').length, 1)
  // The parent chat names the task and the tool, and offers both decisions inline.
  assert.match(textOf(waiting), /Task Send summary to Ana\? is waiting for approval: bash/)
  find(waiting, node => node.props?.className === 'op-task-ask-allow')[0].props.onClick()
  assert.deepEqual(answers, ['allowed-once'])
  const working = card(false)
  assert.equal(working.props['data-state'], 'working')
  assert.match(textOf(working), /Task running/)
  // Without the shell's status hook the card still draws, as working.
  assert.equal(TaskCard({ sessionId: 'session-b', title: 'x', task: task('pip', 'x', 0) }).props['data-state'], 'working')
})

test('a task waiting on an approval the host noted for it is amber too, in the sidebar and its card', () => {
  const approvals = [{ id: 'k1', sessionId: 'session-a', botId: 'pip', taskId: 'session-a', tool: 'bash' }]
  const { threadsOf } = sidebar({ tasks: { 'session-a': task('pip', 'Deploy the site', 2) }, approvals })
  const group = threadsOf('pip').type(threadsOf('pip').props)
  assert.deepEqual(find(group, node => node.props?.className === 'bt-thread').map(row => row.props['data-state']), ['waiting'])
  const card = TaskCard({
    sessionId: 'session-a', title: 'Deploy the site', task: task('pip', 'Deploy the site', 2),
    useSessionStatus: pick => pick(new Map()), useWork: pick => pick({ approvals }),
  })
  assert.equal(card.props['data-state'], 'waiting')
})

test('a task a Bot started is listed under that Bot, not under Tasks; a DSH bot lists all its Sessions', () => {
  const tasks = { id: 'tasks', kind: 'tasks', name: 'Tasks', sessions: ['from-pip', 'from-gone'], createdAt: 3 }
  const site = { id: 'site', kind: 'dsh', name: 'Site', sessions: ['one', 'two'], createdAt: 4 }
  const team = agents => sidebar({
    agents,
    tasks: {
      'from-pip': task('pip', 'Wish: hello', 2, 'done'),
      // Its Bot was deleted: the task stays findable under Tasks.
      'from-gone': task('gone', 'Old chore', 5, 'done'),
    },
  })
  const rows = find(team([tasks, site]).tree, named('AgentRow')).map(row => row.type(row.props).props.children)
  const listed = Object.fromEntries(rows.map(([head, list]) => [head.props['aria-label'], find(list, named('AgentSessionRow')).map(node => node.props.session.id).sort()]))
  assert.deepEqual(listed, { Tasks: ['from-gone'], Site: ['one', 'two'] })
  // Without a Session no other list shows, there is no Tasks row.
  const [alone] = find(team([{ ...tasks, sessions: ['from-pip'] }]).tree, named('AgentRow'))
  assert.equal(alone.type(alone.props), null)
})

test('a stopped task past the Live rail is listed under Tasks, by its record, saying how it ended', () => {
  const HOUR = 60 * 60_000
  const ended = (title, hours, status = 'stopped') => ({ from: 'pip', title, at: NOW - 30 * HOUR, endedAt: NOW - hours * HOUR, status })
  const tasks = {
    one: ended('Newest', 1), two: ended('Second', 2), three: ended('Third', 3),
    fourth: ended('Wish: Fix Claude wish permission denial reporting', 4), old: ended('Ended long ago', 7),
    broke: ended('Broke', 8, 'failed'), running: task('pip', 'Still on it', 5),
  }
  const record = { id: 'tasks', kind: 'tasks', name: 'Tasks', sessions: Object.keys(tasks), createdAt: 3 }
  const [row] = find(sidebar({ tasks, agents: [record] }).tree, named('AgentRow'))
  const rows = find(row.type(row.props), named('AgentSessionRow'))
  assert.deepEqual(rows.map(node => node.props.session.id), ['fourth', 'old', 'broke'])
  const line = (node) => {
    const body = node.type(node.props)
    return [textOf(find(body, each => each.props?.className === 'bt-agent-sub-title')), textOf(find(body, each => each.props?.className === 'bt-agent-sub-time'))]
  }
  assert.deepEqual(rows.map(line), [
    ['Wish: Fix Claude wish permission denial reporting', 'Stopped'],
    ['Ended long ago', 'Stopped'],
    ['Broke', 'Failed'],
  ])
})

test('an ended task card says how it ended: a failed one names why, a stopped one is not finished', () => {
  const kicker = task => textOf(find(TaskCard({ sessionId: 's', title: 'Wish', task }), node => node.props?.className === 'op-task-kicker')[0])
  const ended = (status, summary) => ({ from: 'pip', title: 'Wish', at: NOW - 1000, endedAt: NOW, status, summary })
  assert.equal(kicker(ended('failed', 'the provider refused the key\nat step 3')), 'Failed: the provider refused the key')
  assert.equal(kicker(ended('failed', '')), 'Failed')
  assert.equal(kicker(ended('stopped', 'half done')), 'Stopped')
  assert.equal(kicker(ended('done', 'all done')), 'Task finished')
})

test('a blank Session opened on purpose stays on screen; a blank one nobody opened lands on the Main Bot', () => {

  const roster = { roomsById: { room: {} }, agentOf: {} }
  const actions = { isAgentSession: id => id === 'agent', openedOnPurpose: id => id === 'thread' }
  // An Omni chat thread is blank until its first turn, and its row opens it through actions.openSession.
  assert.equal(staysInView('thread', true, roster, actions), true)
  assert.equal(staysInView('new-chat', true, roster, actions), false)
  assert.equal(staysInView('new-chat', false, roster, actions), true)
  assert.equal(staysInView('room', true, roster, actions), true)
  assert.equal(staysInView('agent', true, roster, actions), true)
  assert.equal(staysInView('', true, roster, actions), false)
  // Registration is an observable guard, not fake standalone Agent ownership.
  const pending = new Set(['picked'])
  const transitioning = { ...actions, ownershipPending: id => pending.has(id) }
  assert.equal(staysInView('picked', true, roster, transitioning), true)
  assert.equal(staysInView('unrelated', true, roster, transitioning), false)
  pending.delete('picked')
  assert.equal(staysInView('picked', true, roster, transitioning), false)
})

test('an open stop previews in amber without changing the face; a task approval wins', () => {
  const draw = options => {
    const { rowOf } = sidebar({ tasks: {}, ...options })
    const node = rowOf('pip')
    return node.type(node.props)
  }
  const stopped = draw({ stops: [{ botId: 'pip', open: true }] })
  const idle = draw({ stops: [{ botId: 'pip', open: false }] })
  assert.equal(textOf(find(stopped, node => node.props?.className === 'bt-row-preview bt-row-preview-ask')), 'A step stopped on a permission')
  assert.match(stopped.props['aria-label'], /A step stopped on a permission/)
  assert.doesNotMatch(idle.props['aria-label'], /A step stopped/)
  assert.equal(find(stopped, named('BotAvatar'))[0].props.state, find(idle, named('BotAvatar'))[0].props.state)
  const waiting = draw({ stops: [{ botId: 'pip', open: true }], approvals: [{ id: 'x', botId: 'pip', taskId: 'x' }] })
  assert.equal(textOf(find(waiting, node => node.props?.className === 'bt-row-preview bt-row-preview-ask')), 'A task needs your approval')
})

test('Bot badges count approvals, cap at 9+ and preserve the uncounted question badge', () => {
  for (const count of [1, 3, 12]) {
    const { rowOf } = sidebar({ tasks: {}, approvals: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, botId: 'pip' })) })
    const node = rowOf('pip')
    const row = node.type(node.props)
    assert.match(row.props['aria-label'], new RegExp(count === 1 ? 'Waiting for your approval.*1 approval waiting' : `${count} approvals waiting`))
    const avatar = find(row, named('BotAvatar'))[0]
    assert.equal(avatar.props.count, count)
    const badge = find(avatar.type(avatar.props), node => node.props?.className === 'bt-badge bt-badge-alert')[0]
    assert.equal(textOf(badge), count > 9 ? '9+' : String(count))
    assert.equal(badge.props['aria-label'], count === 1 ? '1 approval waiting' : `${count} approvals waiting`)
    const uncounted = find(avatar.type({ ...avatar.props, count: undefined }), node => node.props?.className === 'bt-badge bt-badge-alert')[0]
    assert.equal(textOf(uncounted), '?')
    assert.equal(uncounted.props['aria-label'], 'Waiting for your answer')
  }
})

test('a waiting thread and task card name the one ask they wait on, never a guess between two', () => {
  const one = [{ id: 'first', botId: 'pip', taskId: 'session-a', sessionId: 'session-a', callId: 'a', detail: { code: 'bun test --filter api' } }]
  const two = [...one, { id: 'second', botId: 'pip', taskId: 'session-a', sessionId: 'session-a', callId: 'b', detail: { code: 'rm -rf build' } }]
  const rowOf = (approvals) => {
    const { threadsOf } = sidebar({ tasks: { 'session-a': task('pip', 'Check API', 2) }, approvals })
    const node = threadsOf('pip')
    return find(node.type(node.props), node => node.props?.className === 'bt-thread')[0]
  }
  assert.equal(rowOf(one).props.title, 'Check API · bun test --filter api')
  assert.equal(rowOf(one).props['aria-label'], 'Check API, Waiting for you, bun test --filter api')
  assert.equal(rowOf(two).props.title, 'Check API')
  const said = (approvals, pending) => {
    const card = TaskCard({ sessionId: 'session-a', title: 'Check API', task: task('pip', 'Check API', 2), useWork: pick => pick({ approvals }),
      useSessionStatus: pick => pick(new Map(pending ? [['session-a', { pendingInteraction: pending }]] : [])) })
    return find(card, node => node.props?.className === 'op-task-said').map(textOf)
  }
  assert.ok(said(one).includes('bun test --filter api'))
  // Two asks and no shown one: no command is named.
  assert.ok(!said(two).some(text => text === 'bun test --filter api' || text === 'rm -rf build'))
  // The buttons answer DSH's ask: the command named is that ask's own.
  const ask = { kind: 'approval', toolName: 'bash', callId: 'b', answer: () => {} }
  assert.ok(said(two, ask).includes('rm -rf build'))
  assert.ok(!said(two, ask).includes('bun test --filter api'))
  assert.ok(!said(one, ask).includes('bun test --filter api'))
})

test('room rows count their approvals in the existing tag and retain the waiting dot', () => {
  const room = { id: 'room', name: 'Ops', members: ['pip'] }
  const approvals = [{ roomId: 'room' }, { roomId: 'elsewhere' }, { roomId: 'room' }]
  const roster = { bots: [pip], rooms: [room], agents: [], byId: { pip }, roomsById: { room }, agentOf: {}, mainBotIds: ['pip'], questions: {}, ready: true, tasks: {} }
  const tree = TeamSidebar({
    wide: true, actions: {}, useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}), useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: (_id, pick) => pick(undefined), useActivity: pick => pick({}),
    useWork: pick => pick({ approvals, rooms: {}, waiting: {} }),
  })
  const node = find(tree, named('RoomRow'))[0]
  const row = node.type(node.props)
  assert.match(row.props['aria-label'], /2 approvals waiting/)
  assert.equal(textOf(find(row, node => node.props?.className === 'bt-tag')), '2')
  assert.equal(find(row, node => node.props?.className === 'bt-unread bt-unread-wait').length, 1)
})
