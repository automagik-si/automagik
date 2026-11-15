import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The rail's module as the browser gets it, with stand-ins for the platform it runs on.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/live-rail.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const effects = []
const timers = []
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: effect => effects.push(effect), useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: () => undefined, Fragment: 'fragment', forwardRef: fn => fn, memo: fn => fn, createContext: () => ({}), useContext: () => undefined },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
  document: undefined, window: undefined, Date, Math, JSON, Intl, setTimeout, clearTimeout,
  setInterval: (_tick, ms) => { timers.push(ms); return 'live-timer' }, clearInterval: id => timers.push(id),
})
const { liveOf, liveSummary, LiveRail, LiveTab, LIVE_CSS } = module.exports

test('native Live body takes its container room with no fixed rail or width reservation', () => {
  const roster = { byId: {}, tasks: {} }
  const body = LiveRail({ roster, actions: {}, useWork: select => select({}) })
  assert.equal(body.type, 'aside')
  assert.equal(body.props['aria-label'], 'Live')
  assert.equal(effects.length, 1, 'only the relative-time timer, no chatRoom geometry effect')
  const release = effects[0](); release()
  assert.deepEqual(timers, [30000, 'live-timer'])
  assert.doesNotMatch(LIVE_CSS, /position:fixed|width:320px|right:0/)
  assert.match(LIVE_CSS, /width:100%;height:100%;min-width:0/)
  const tab = LiveTab({ useRoster: select => select(roster), actions: {} })
  assert.equal(tab.type, LiveRail)
  assert.equal(tab.props.roster, roster)
})
// Cross-realm values compare by their plain JSON.
const plain = value => JSON.parse(JSON.stringify(value))

const roster = {
  byId: { omni: { id: 'omni', name: 'Omni' }, genie: { id: 'genie', name: 'Genie' }, writer: { id: 'writer', name: 'Writer' } },
  roomsById: { room: { id: 'room', name: 'You, Writer, Genie', members: ['writer', 'genie'] } },
  tasks: {
    t1: { from: 'genie', status: 'working', title: 'Add a README', at: 1_000 },
    t2: { from: 'genie', status: 'failed', title: 'Fix the test', summary: 'git is missing\nmore', at: 500, endedAt: 2_000 },
    t3: { from: 'genie', status: 'working', title: 'Waits on you', at: 900 },
    old: { from: 'genie', status: 'done', title: 'Long ago', at: 0, endedAt: 1 },
  },
}

test('the rail puts what needs you first, then what runs, then what just ended', () => {
  const work = {
    approvals: [
      { id: 'a1', botId: 'genie', taskId: 't3', tool: 'bash' },
      // A task gone from the roster still names itself from the approval's own label.
      { id: 'a2', botId: 'writer', taskId: 'gone', label: 'A task that ended', tool: 'bash' },
    ],
    bots: { omni: { tool: 'web_search' } },
    rooms: { room: [{ botId: 'writer' }, { botId: 'omni' }] },
  }
  const live = liveOf(work, roster, 6 * 60 * 60 * 1000 + 1_000)
  assert.deepEqual(plain(live.needs.map(item => [item.bot.name, item.tool, item.open])), [['Genie', 'bash', 't3'], ['Writer', 'bash', 'gone']])
  // The task that waits is named, not just its Bot.
  assert.deepEqual(live.needs.map(item => item.place), ['Waits on you', 'A task that ended'])
  // A Bot at work in its own chat and in a group is listed once; a waiting task is under Needs you.
  assert.deepEqual(plain(live.working.map(item => [item.key, item.open])), [['bot:omni', 'omni'], ['room:room:writer', 'room'], ['task:t1', 't1']])
  assert.equal(live.working[1].place, 'You, Writer, Genie')
  // Ended in the last six hours only, newest first, a failure naming why.
  assert.deepEqual(plain(live.ended.map(item => [item.title, item.label])), [['Fix the test', 'Failed: git is missing']])
})

test('Bots that are not on the team are left out', () => {
  const live = liveOf({ approvals: [{ id: 'x', botId: 'gone' }], bots: { gone: { tool: 'bash' } } }, { byId: {}, roomsById: {}, tasks: { t: { from: 'gone', status: 'working' } } })
  assert.deepEqual(plain(live), { needs: [], working: [], ended: [] })
})

test('the summary counts what needs you and what works', () => {
  assert.equal(liveSummary({ needs: [], working: [] }), 'nothing working')
  assert.equal(liveSummary({ needs: [{}], working: [{}, {}] }), '1 needs you · 2 working')
})

// #164. The rail lists ended tasks from the team's task records alone, three at most and
// six hours at most; these cases pin that window. A record forgotten past the host's cap
// (agents.js TASKS_KEPT, which now forgets ended tasks first and keeps the working ones)
// leaves the rail, and its Session goes back under the Tasks row (task-card.js).
const HOUR = 60 * 60 * 1000
test('ended tasks stay three at most, newest end first, and six hours at most', () => {
  const now = 10 * HOUR
  const ended = (title, endedAt) => ({ from: 'genie', status: 'stopped', title, at: 0, endedAt })
  const tasks = {
    a: ended('Event-driven Omni 1', now - 1 * HOUR),
    b: ended('Event-driven Omni 2', now - 2 * HOUR),
    c: ended('Bug 2 at the source', now - 3 * HOUR),
    wish: ended('Wish: Fix Claude wish permission denial reporting', now - 4 * HOUR),
    stale: ended('Ended long ago', now - 7 * HOUR),
  }
  const live = liveOf({}, { ...roster, tasks }, now)
  assert.deepEqual(plain(live.ended.map(item => [item.title, item.label])), [
    ['Event-driven Omni 1', 'Stopped'], ['Event-driven Omni 2', 'Stopped'], ['Bug 2 at the source', 'Stopped'],
  ])
  // Fewer ended tasks: the fourth is listed again, the one past six hours never is.
  delete tasks.a
  assert.deepEqual(plain(liveOf({}, { ...roster, tasks }, now).ended.map(item => item.open)), ['b', 'c', 'wish'])
})

const cardBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-card.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const cardModule = { exports: {} }
runInNewContext(cardBundle.outputFiles[0].text, {
  module: cardModule, exports: cardModule.exports,
  require: (name) => {
    if (name === 'react') return { createElement: () => null, useState: initial => [initial, () => {}], useEffect: () => {} }
    if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`no platform module ${name}`)
  },
  document: undefined, window: undefined, Date, Math, JSON, Intl, setTimeout, clearTimeout,
})
const { agentRowSessions } = cardModule.exports

test('a task Session with no task record is not in the rail but stays under the Tasks row', () => {
  const tasksRecord = { id: 'a:tasks', kind: 'tasks', sessions: ['kept', 'forgotten'] }
  const tasks = { kept: { from: 'genie', status: 'stopped', title: 'Kept', at: 0, endedAt: 1_000 } }
  const live = liveOf({}, { ...roster, tasks }, 2_000)
  assert.deepEqual(plain(live.ended.map(item => item.open)), ['kept'])
  // The kept task shows with its Bot (the rail, its chat); the forgotten one under Tasks.
  assert.deepEqual(plain(agentRowSessions(tasksRecord, { ...roster, tasks })), ['forgotten'])
})

test('the rail keeps a working wish past the host cap, newest ends first, three at most', () => {
  const now = 10 * HOUR
  const tasks = { wish: { from: 'genie', status: 'working', title: 'Wish: Fix Claude wish permission denial reporting', at: 1 } }
  for (let index = 0; index < 60; index += 1) {
    const endedAt = now - (index + 1) * 60_000
    tasks[`e${index}`] = { from: 'genie', status: 'stopped', title: `Ended ${index}`, at: 10 + index, endedAt }
  }
  const live = liveOf({}, { ...roster, tasks }, now)
  assert.deepEqual(plain(live.ended.map(item => item.title)), ['Ended 0', 'Ended 1', 'Ended 2'])
  assert.deepEqual(plain(live.working.filter(item => item.task).map(item => [item.open, item.phrase])), [
    ['wish', 'Wish: Fix Claude wish permission denial reporting'],
  ])
})

// #164. A stopped task of a living Bot is not a thread (threads are running tasks) and the
// rail's window is by design, so the row under Tasks is the one place left for it. These
// call agentRowSessions with the clock, as the sidebar, the palette and the row's own
// actions do.
test('an ended task older than six hours or fourth-newest leaves the rail for the Tasks row', () => {
  const now = 10 * HOUR
  const ended = (title, endedAt) => ({ from: 'genie', status: 'stopped', title, at: 0, endedAt })
  const tasks = {
    a: ended('Event-driven Omni 1', now - 1 * HOUR),
    b: ended('Event-driven Omni 2', now - 2 * HOUR),
    c: ended('Bug 2 at the source', now - 3 * HOUR),
    fourth: ended('Wish: Fix Claude wish permission denial reporting', now - 4 * HOUR),
    stale: ended('Ended long ago', now - 7 * HOUR),
    running: { from: 'genie', status: 'working', title: 'Still on it', at: now - 30 * HOUR },
  }
  const tasksRecord = { id: 'a:tasks', kind: 'tasks', sessions: [...Object.keys(tasks), 'forgotten'] }
  const team = { ...roster, tasks }
  assert.deepEqual(plain(liveOf({}, team, now).ended.map(item => item.open)), ['a', 'b', 'c'])
  assert.deepEqual(plain(agentRowSessions(tasksRecord, team, now)), ['fourth', 'stale', 'forgotten'])
  // Six hours on, what the rail let go of is under Tasks: at no time is it in neither.
  const later = now + 6 * HOUR
  assert.deepEqual(plain(liveOf({}, team, later).ended.map(item => item.open)), [])
  assert.deepEqual(plain(agentRowSessions(tasksRecord, team, later)), ['a', 'b', 'c', 'fourth', 'stale', 'forgotten'])
})

test('a task still working stays out of the Tasks row and keeps no age limit in the rail', () => {
  const now = 40 * HOUR
  const tasks = { cut: { from: 'genie', status: 'working', title: 'Cut by a restart', at: now - 30 * HOUR } }
  const tasksRecord = { id: 'a:tasks', kind: 'tasks', sessions: ['cut'] }
  const live = liveOf({}, { ...roster, tasks }, now)
  assert.deepEqual(plain(live.working.map(item => item.open)), ['cut'])
  assert.deepEqual(plain(live.ended), [])
  assert.deepEqual(plain(agentRowSessions(tasksRecord, { ...roster, tasks }, now)), [])
})

test('a stopped task whose Session has no record is listed with nothing invented for it', () => {
  const tasksRecord = { id: 'a:tasks', kind: 'tasks', sessions: ['no-record'] }
  const team = { ...roster, tasks: {} }
  assert.deepEqual(plain(liveOf({}, team, 10 * HOUR).ended), [])
  assert.deepEqual(plain(agentRowSessions(tasksRecord, team, 10 * HOUR)), ['no-record'])
})

test('open stops use the needs card with an idle face; run approvals keep the alert face', () => {
  const team = { byId: { ada: { id: 'ada', name: 'ada' } }, roomsById: {}, tasks: {} }
  const work = {
    approvals: [{ id: 'ask', botId: 'ada', sessionId: 'run', taskId: 'run', label: 'someone' }],
    stops: [{ id: 'x', botId: 'ada', taskId: 'x', label: 'someone', open: true, why: 'tool', tool: 'bash', count: 1 }, { id: 'closed', botId: 'ada', open: false }],
  }
  const live = liveOf(work, team)
  assert.deepEqual(plain(live.needs.map(item => [item.open, item.place])), [['run', 'someone'], ['x', 'someone']])
  assert.equal(live.needs[1].line, 'bash did not run: this Bot does not have that tool')
  const body = LiveRail({ roster: team, actions: {}, useWork: select => select(work) })
  const section = body.children.find(node => node?.props?.dot === 'need')
  const cards = section.children.map(node => node.type(node.props))
  assert.equal(cards[0].children[0].children[0].props.state, 'alert')
  assert.equal(cards[1].children[0].children[0].props.state, 'idle')
})

test('a child ask names the subagent and keeps the waiting face', () => {
  const team = { byId: { ada: { id: 'ada', name: 'ada' } } }
  const work = { approvals: [{ id: 'x', child: true, botId: 'ada', tool: 'bash' }] }
  const item = liveOf(work, team).needs[0]
  assert.equal(item.line, 'A subagent wants to use bash')
  assert.equal(item.face ?? 'alert', 'alert')
  assert.equal(item.open, 'ada')
})

test('the rail merges capabilities by first arrival, keeps distinct places and counts asks', () => {
  const approvals = [
    { id: 'later', botId: 'genie', taskId: 't3', tool: 'bash', capabilityKey: 'same', at: 3, reason: 'Run the tests', detail: { code: 'bun test' } },
    { id: 'first', botId: 'genie', taskId: 't1', tool: 'bash', capabilityKey: 'same', at: 1, reason: 'Run the tests', detail: { code: 'bun test' } },
    { id: 'room', botId: 'genie', roomId: 'room', tool: 'bash', capabilityKey: 'same', at: 2, reason: 'Run the tests', detail: { code: 'bun test' } },
    { id: 'repeat', botId: 'genie', taskId: 't1', tool: 'bash', capabilityKey: 'same', at: 4, reason: 'Run the tests', detail: { code: 'bun test' } },
    { id: 'chat', botId: 'genie', sessionId: 'genie-chat', tool: 'bash', capabilityKey: 'same', at: 4.5, reason: 'Run the tests', detail: { code: 'bun test' } },
    { id: 'single', botId: 'writer', tool: 'read', at: 5 },
  ]
  const live = liveOf({ approvals }, roster)
  const [group, single] = live.needs
  assert.equal(group.key, 'ask:first')
  assert.equal(group.count, 5)
  assert.equal(group.open, 't1')
  assert.equal(group.line, '5 requests to use bash')
  assert.equal(group.detail, 'bun test')
  assert.equal(group.reason, 'Run the tests')
  // Every place is named, the Bot's own chat too.
  assert.deepEqual(plain(group.places), ['Add a README', 'You, Writer, Genie', 'Waits on you', 'in its own chat'])
  assert.equal(group.place, group.places.join(', '))
  assert.deepEqual(plain(group.entries.map(entry => entry.id)), ['first', 'room', 'later', 'repeat', 'chat'])
  assert.equal(liveSummary({ needs: live.needs, working: [] }), '6 needs you · nothing working')
  assert.deepEqual(plain(single), { key: 'ask:single', bot: roster.byId.writer, tool: 'read', open: 'writer', count: 1, entries: [approvals[5]], detail: '' })
})

test('singleton detail extends only the default line and retains the button card', () => {
  const approvals = [
    { id: 'normal', botId: 'genie', tool: 'bash', detail: { code: 'echo hello' } },
    { id: 'child', botId: 'genie', tool: 'bash', child: true, detail: { code: 'echo child' } },
    { id: 'keep', botId: 'genie', tool: 'keep_working', detail: { code: 'keep' } },
  ]
  const items = liveOf({ approvals }, roster).needs
  assert.equal(items[0].line, 'Wants to use bash · echo hello')
  assert.equal(items[1].line, 'A subagent wants to use bash')
  assert.equal(items[2].line, undefined)
  const body = LiveRail({ roster, actions: {}, useWork: select => select({ approvals }) })
  const cards = body.children.find(node => node?.props?.dot === 'need').children.map(node => node.type(node.props))
  assert.ok(cards.every(card => card.type === 'button'))
})

test('merged cards have sibling action buttons, use native exact-call answers and stay open-only without them', async () => {
  const approvals = [
    { id: 'one', botId: 'genie', taskId: 't1', sessionId: 't1', callId: 'c', tool: 'bash', capabilityKey: 'same' },
    { id: 'two', botId: 'genie', taskId: 't3', sessionId: 't3', callId: 'd', tool: 'bash', capabilityKey: 'same' },
  ]
  const outcomes = []
  const opened = []
  const actions = { openSession: id => opened.push(id) }
  const draw = useSessionStatus => {
    const body = LiveRail({ roster, actions, useWork: select => select({ approvals }), useSessionStatus })
    const node = body.children.find(node => node?.props?.dot === 'need').children[0]
    return node.type(node.props)
  }
  const native = (callId, id) => ({ pendingInteraction: { kind: 'approval', callId, toolName: 'bash', answer: value => outcomes.push([id, value]) } })
  // One ask this window cannot answer: the card only opens, so no decision covers part of it.
  const partial = draw(select => select(new Map([['t1', native('c', 'one')]]))).children.find(node => node?.props?.className === 'bt-q-foot')
  assert.deepEqual(partial.children.filter(Boolean).map(node => node.children[0]), ['Open'])
  const card = draw(select => select(new Map([['t1', native('c', 'one')], ['t3', native('d', 'two')]])))
  assert.equal(card.type, 'div')
  assert.equal(card.props.className, 'bt-live-card bt-live-need')
  const row = card.children.find(node => node?.props?.className === 'bt-q-foot')
  assert.deepEqual(row.children.map(node => node.children[0]), ['Reject', 'Allow once', 'Open'])
  await row.children[1].props.onClick()
  assert.deepEqual(outcomes, [['one', 'allowed-once'], ['two', 'allowed-once']])
  row.children[2].props.onClick()
  assert.deepEqual(opened, ['t1'])
  const openOnly = draw().children.find(node => node?.props?.className === 'bt-q-foot')
  assert.deepEqual(openOnly.children.filter(Boolean).map(node => node.children[0]), ['Open'])
})
