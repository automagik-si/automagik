import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { build } from 'esbuild'
import { browserFixture, mountSettings, source } from './onboarding-gate.test.js'
import { makeColdRoom, makeHome, mountHost, settleTurn, tornAdmission, waitFor } from './room-opens.test.js'
import { GroupSource, roomTerminalOf } from '../src/host/pocket-groups.js'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const { outputFiles: [botClient] } = await build({
  stdin: {
    contents: [
      "export { NewChat } from './src/client/new-chat.js'",
      "export { RoomRow } from './src/client/sidebar.js'",
      "export { listedOpener } from './src/client/open-listed.js'",
      "export { indexRoster } from './src/client/sources.js'",
      "export { TriggerCell, TurnProcessCell, TurnTailCell } from './src/client/cells.js'",
      "export * as openingCells from './src/client/cells.js'",
      "export { FailureCell } from './src/client/turn-error.js'",
      "export * as opening from './src/client/index.js'",
    ].join('\n'),
    resolveDir: plugin,
  },
  bundle: true, write: false, format: 'cjs', platform: 'browser',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [{ name: 'observe-client-fixture-seats', setup(builder) {
    builder.onLoad({ filter: /\/src\/client\/(sidebar|index)\.js$/ }, async ({ path }) => {
      const js = await readFile(path, 'utf8')
      if (path.endsWith('/sidebar.js')) return { contents: `${js}\nexport { RoomRow }` }
      const keys = ['installRoomOpeningRail', 'OpeningAwareHeader', 'RoomTurnProcess', 'RoomTurnTail'].filter(key =>
        new RegExp(`(?:function|const) ${key}\\b`).test(js))
      return keys.length ? { contents: `${js}\nexport { ${keys.join(', ')} }` } : undefined
    })
  } }],
})

const empty = []
const nothing = () => {}
const openSessionView = { openState: 'open', pendingSubmissions: empty, running: false, blank: false, awaitingFirstTurn: false }
const t = (key, { turn } = {}) => turn === undefined ? key : `Turn ${turn}`
const roomTurns = events => events.filter(event => event.type === 'turn/start').map(event => event.data.turn)
const textOccurrence = (text, phrase) => text.split(phrase).length - 1

function eventWindow() {
  const window = source({ entries: [], hasMore: false })
  return { ...window, replace: (entries, hasMore) => window.set({ entries, hasMore }) }
}

function visible(element, window) {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || window.getComputedStyle(current).display === 'none') return false
    // jsdom's cascade can omit a relational selector even when its DOM matcher
    // supports it. Apply the exact injected display rule to the mounted markup.
    for (const rule of window.document.querySelector('style[data-dsh-bot="room-opening-rail"]')?.sheet?.cssRules ?? []) {
      if (rule.style?.display === 'none' && current.matches(rule.selectorText)) return false
    }
  }
  return true
}

function fixture(tst, host, { withHeader = false } = {}) {
  const browser = browserFixture(tst, url => {
    assert.equal(url, 'api/omni-ai')
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, value: {} }) })
  })
  const { window, h, seeds, root, load, evaluate, cleanups } = browser
  window.matchMedia = query => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} })
  window.HTMLElement.prototype.getAnimations = () => []
  Object.defineProperty(window.document, 'fonts', { value: { addEventListener: nothing, removeEventListener: nothing } })
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 320 })
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 360 })
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, width: 360, height: 320, right: 360, bottom: 320,
  })
  window.HTMLElement.prototype.scrollTo = function (options) { this.scrollTop = options.top ?? 0 }
  window.HTMLElement.prototype.scrollIntoView = nothing
  window.Range.prototype.getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect
  class ResizeObserver {
    observed = new Set()
    constructor(notify) { this.notify = notify }
    observe(target) {
      this.observed.add(target)
      queueMicrotask(() => {
        if (!this.observed.has(target)) return
        const contentRect = target.getBoundingClientRect()
        this.notify([{
          target, contentRect, borderBoxSize: [{ blockSize: contentRect.height, inlineSize: contentRect.width }],
        }])
      })
    }
    unobserve(target) { this.observed.delete(target) }
    disconnect() { this.observed.clear() }
  }
  window.ResizeObserver = browser.context.ResizeObserver = ResizeObserver
  const api = evaluate(botClient.text)
  const native = load('@deepseek-ai/dsh-client-ui-conversation', [
    'ConversationSession', 'InputBar', 'SessionInputShell', 'ConversationGroupRegistry', 'inspectSystemPrompt',
  ])
  const { ChatView, registerConversationNodes } = load('@deepseek-ai/dsh-client-ui-chat', ['ChatView', 'registerConversationNodes'])
  const list = source({ phase: 'ready', byId: {} })
  const roster = source(api.indexRoster({ bots: [], rooms: [], exchangeTurns: {}, prefs: {} }))
  const bindings = new Map()
  const openingSessions = { list, binding: id => bindings.get(id) }
  const selected = source(undefined)
  const newChat = source(false)
  const noted = source({})
  const visits = source({})
  const inputs = new Map()
  const requests = []
  const opened = []
  let pending
  let showError
  let holdRoster = false
  const use = (src, select) => select(seeds.react.useSyncExternalStore(src.subscribe, src.getSnapshot))
  const useList = select => use(list, select)
  const mainView = () => Object.values(list.getSnapshot().byId).find(s => s.retainedBy.mainView > 0)?.id
  const settings = mountSettings(browser, { roster, sessions: list, mainView })
  const stage = window.document.createElement('div')
  root.after(stage)
  const rendered = seeds['react-dom/client'].createRoot(stage)
  cleanups.push(() => rendered.unmount())
  const ctx = settings.ctx
  const definitions = new native.ConversationEventRegistry(ctx)
  const views = new native.ConversationViewRegistry(ctx)
  const groups = new native.ConversationGroupRegistry(ctx, views)
  registerConversationNodes({ uiConversation: {
    events: definitions, views, groups, inspectSystemPrompt: native.inspectSystemPrompt,
    inspectRequestPrompt: native.inspectRequestPrompt,
  } })
  const prompts = () => host.rt.state.rooms
  async function sync(id = mainView()) {
    if (!holdRoster) {
      const nextRoster = await host.call('state', {})
      roster.set(api.indexRoster(nextRoster))
    }
    const byId = Object.fromEntries((await host.controller.list({})).items.map(row => [row.sessionId, {
      ...row, id: row.sessionId, projectionValues: row.projections?.values, retainedBy: { mainView: row.sessionId === id ? 1 : 0 },
    }]))
    const session = id === undefined ? undefined : host.root.sessions.get(id)
    const projectionsBySession = session === undefined ? {} : {
      [id]: host.root.sessionProjections.snapshot(session, new Set(['turnOutline'])),
    }
    list.set({ phase: 'ready', byId, projectionsBySession })
  }
  async function snapshot(id) {
    const agent = await host.resolve(id)
    let binding = bindings.get(id)
    if (binding === undefined) {
      binding = { sessionId: id, eventSource: eventWindow() }
      bindings.set(id, binding)
    }
    binding.eventSource.replace(agent.session.snapshotEvents().map(event => ({ type: 'event', event })), false)
    const assembler = new native.ConversationNodeAssembler(definitions, views)
    const { entries, hasMore } = binding.eventSource.getSnapshot()
    assembler.replaceWindow(entries, hasMore)
    assembler.activateTarget('chat')
    assembler.flush()
    return assembler
  }
  const uiWorkspace = {
    openSession(id) {
      opened.push(id)
      pending = (async () => {
        const assembler = await snapshot(id)
        await sync(id)
        selected.set({ id, assembler })
      })().catch(error => { showError = error })
    },
  }
  const show = api.listedOpener({ list, refresh: sync, open: id => uiWorkspace.openSession(id), current: mainView })
  const afterShow = async (expected, timeout = 'the listed opener did not open the room') => {
    await waitFor(async () => {
      if (showError) throw showError
      await pending
      return selected.getSnapshot()?.id === expected
    }, timeout)
    await browser.tick()
  }
  const send = (id, text) => host.call('send', { sessionId: id, text })
  const actions = {
    openSession: id => show(id),
    createRoom: async (members, options) => {
      const room = await host.createRoom('Typed room', { members, ...options })
      await sync()
      return room
    },
    closeOverlay: () => newChat.set(false),
    send,
    noteTurnTime(id, turn, side, time) {
      if (time === undefined || noted.getSnapshot()[id]?.[turn]?.[side] === time) return
      const clock = noted.getSnapshot()
      noted.set({ ...clock, [id]: { ...clock[id], [turn]: { ...clock[id]?.[turn], [side]: time } } })
    },
    noteTurnPeer: nothing,
    clearLive: nothing,
    beginVisit: nothing,
    endVisit: nothing,
  }

  function ActiveConversation({ id, assembler }) {
    const ready = useList(value => value.byId[id])
    const session = { ...openSessionView, ...ready }
    const chat = assembler.snapshot('chat')
    const conversation = { ...native.EMPTY_CONVERSATION_SNAPSHOT, views: assembler }
    const [input] = seeds.react.useState(() => new native.SessionInputShell({
      actx: ctx,
      commandAttachments: { serialize: async () => [], release: nothing, unsupportedNotice: () => '' },
      defaultSink: async (text, _attachments, mode, signal, accept) => {
        const request = { sessionId: id, requestId: randomUUID(), content: [{ type: 'text', text }], mode }
        requests.push(request)
        await host.controller.prompt(request, signal)
        accept()
        return { kind: 'success' }
      },
    }))
    seeds.react.useEffect(() => {
      inputs.set(id, input)
      return () => { inputs.delete(id); input.dispose() }
    }, [id, input])
    const useSession = select => select(session)
    const useConversation = select => select(conversation)
    const useProjection = (key, select = value => value) => useList(value =>
      select(value.projectionsBySession?.[id]?.values[key] ?? value.byId[id]?.projectionValues?.[key]))
    const cellProps = {
      sessionId: id, useRoster: select => use(roster, select), useSessions: useList,
      openingSessions,
      useTurnClock: select => use(noted, select),
      useUi: select => use(visits, value => select({ visits: value })), actions,
    }
    const slot = (name, props) => {
      if (name !== 'conversation.chat.flow') return null
      return props.entries.map(({ key }) => {
        const node = chat.nodes.get(key)
        const kind = node.kind
        const turn = node.location?.turn
        const Cell = ({
          'turn-error': api.FailureCell,
          'turn-process': api.opening.RoomTurnProcess ?? api.TurnProcessCell,
          'turn-tail': api.opening.RoomTurnTail ?? api.TurnTailCell,
          'turn-trigger': api.TriggerCell,
        })[kind]
        return h('div', { key, 'data-chat-flow-kind': kind, 'data-chat-turn': turn?.turn },
          Cell ? h(Cell, { ...cellProps, node, turn })
            : kind === 'user' ? node.data.content?.map(part => part.text).join('') : null)
      })
    }
    const renderView = () => h(ChatView, {
      ...cellProps, useSession, useChat: select => select(chat), useConversation, useProjection,
      usePresentation: select => select({ collapseTiming: 'immediate', mode: 'full' }),
      useContextMenu: () => ({ getTriggerProps: () => ({}) }), useInteractionIds: select => select(empty),
      dispatchInteraction: nothing, loadOlder: nothing, consumeOlder: nothing, loadThrough: nothing,
      chatScroll: { read: () => null, save: nothing }, renderSlot: slot, t,
    })
    return h('section', { 'data-active-session': id },
      withHeader ? h(api.opening.OpeningAwareHeader, {
        ...cellProps, useSession, useSessionStatus: select => select(new Map()),
        useActivity: select => select({}), useLive: select => select({}),
      }) : null,
      h(native.ConversationSession, {
        view: 'chat', useSession, useConversation, useConversationViews: select => select(empty),
        inputActions: input.actions, useStore: select => select({}), actions: { setDraft: nothing },
        useInspectCall: select => select(null), bindDraftPersistence: writer => input.bindDraftPersistence(writer),
        renderSlot: renderView,
      }),
      h(native.InputBar, {
        useSession, useProjection, sessionId: id, t, variant: 'session', occurrence: 'main',
        keyboard: input, inputActions: input.actions, useInput: select => use(input.state, select), useAccess: () => true,
        useBusyEnter: select => select('queue'), useNotices: select => use(input.notices, select), useStopShortcut: select => select(null),
        useFileUploads: select => select({}), useMenuLauncher: select => select(null), useLexicon: select => select(new Map()),
        renderSlot: () => null, registerFileIntake: () => nothing,
      }),
    )
  }

  function Page() {
    const team = use(roster, value => value)
    const current = use(selected, value => value)
    const adding = use(newChat, value => value)
    return h('div', {},
      h('aside', {}, team.rooms.map(room => h(api.RoomRow, {
        key: room.id, room, roster: team, wide: true, marked: false, actions,
        useSessions: useList, useSessionStatus: select => select(new Map()),
        useSessionRetainInfo: (id, select) => useList(value => select(value.byId[id])),
      }))),
      adding ? h(api.NewChat, { mode: 'group', roster: team, actions }) : null,
      current ? h(ActiveConversation, { key: current.id, ...current }) : null)
  }
  if (api.opening.installRoomOpeningRail) cleanups.push(api.opening.installRoomOpeningRail({ roster, sessions: list, mainView, openingSessions }))
  seeds['react-dom'].flushSync(() => rendered.render(h(Page)))
  const refresh = async () => {
    const id = mainView()
    await sync(id)
    if (id !== undefined) selected.set({ id, assembler: await snapshot(id) })
    await browser.tick()
  }
  return {
    ...browser, stage, settings, sync, afterShow, refresh, requests, opened, list, roster, prompts, newChat, noted, visits,
    openingSessions,
    holdRoster: () => { holdRoster = true },
    catchUpRoster: async () => { holdRoster = false; await sync(); await browser.tick() },
    show: id => { actions.openSession(id); return afterShow(id) },
    selectRoom: id => stage.querySelector(`button[data-room-id="${id}"]`),
    type: text => inputs.get(mainView()).actions.setDraft(text),
    firstNav: () => stage.querySelector('nav[aria-label="chat.turnNavigation.label"]'),
    getMain: mainView,
  }
}

async function groupWatch(host, room) {
  const messages = []
  const lines = []
  const listeners = new Set()
  host.rt.roomLineAdded = (owner, line) => {
    if (owner.id === room.id) lines.push(line)
    for (const listener of listeners) listener(owner, line)
  }
  const source = new GroupSource({
    rt: host.rt, reader: { places: () => new Map(), shown: () => true, registryIdOf: () => null }, lines: listeners,
  })
  source.start()
  const watch = await source.watch(roomTerminalOf(room.id), event => { messages.push(event); return true })
  assert.equal(watch.ok, true, JSON.stringify(watch))
  watch.started()
  return { source, messages, lines }
}

function assertReceipt(host, id, text, other) {
  const room = host.rt.roomOf(id)
  const records = host.rt.ledger.range(`group-${id}`, 1, room.seq)
  assert.equal(records.filter(line => line.who === 'User' && line.text === text).length, 1, 'one durable ledger line for this room')
  assert.ok(!records.some(line => line.text === other))
  const memberTraffic = host.sent.filter(call => host.rt.groupOwners.get(call.sessionId)?.roomId === id)
  assert.equal(textOccurrence(JSON.stringify(memberTraffic.map(call => call.messages)), text), 1, 'one provider receipt for this room')
  assert.equal(textOccurrence(JSON.stringify(memberTraffic.map(call => call.messages)), other), 0, 'no delivery across rooms')
  assert.ok(Object.values(room.seen).some(seq => seq >= records.find(line => line.text === text).seq), 'the member advanced its seen cursor')
}

test('T5/T7 joined flow sends from real New Chat and real sidebar/composer once per room and cold opens', async tst => {
  const home = await makeHome(tst)
  const host = await mountHost(tst, home)
  const ui = fixture(tst, host)
  await ui.sync()
  ui.newChat.set(true)
  await ui.tick()
  for (const label of ['Chief', 'Writer']) {
    const row = [...ui.stage.querySelectorAll('[role=option]')].find(button => button.textContent.trim().startsWith(label))
    assert.ok(row, `missing New Chat choice ${label}`)
    row.click()
    await ui.tick()
  }
  const textarea = ui.stage.querySelector('textarea')
  Object.getOwnPropertyDescriptor(ui.window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'first typed')
  textarea.dispatchEvent(new ui.window.Event('input', { bubbles: true }))
  await ui.tick()
  const send = ui.stage.querySelector('[aria-label="Send message"]')
  assert.equal(send.disabled, false)
  send.click()
  const typed = await waitFor(() => Object.values(ui.prompts()).find(room => room.name === 'Typed room'), 'New Chat did not create a room')
  await ui.afterShow(typed.id)
  await settleTurn(host, typed.id)
  assert.ok(ui.stage.querySelector('[data-chat-flow]'))
  assert.ok(ui.stage.querySelector('[data-composer-card]'))
  assert.equal(ui.settings.step(), undefined)

  const later = await host.createRoom('Sidebar room')
  const watch = await groupWatch(host, later)
  tst.after(() => watch.source.close())
  const blankSnapshot = watch.messages.find(event => event.type === 'snapshot')
  assert.deepEqual(blankSnapshot.rows, [])
  assert.deepEqual(watch.lines, [])
  await ui.sync(typed.id)
  await ui.tick()
  const row = ui.selectRoom(later.id)
  assert.ok(row)
  assert.ok(row.querySelector('.bt-unread, .bt-row-preview') === null, 'the off-screen empty room shows neither unread nor preview')
  row.click()
  await ui.afterShow(later.id)
  assert.deepEqual(ui.opened, [typed.id, later.id])
  assert.equal(ui.selectRoom(later.id).getAttribute('aria-current'), 'page')
  assert.equal(ui.getMain(), later.id)
  assert.equal(ui.root.inert, false)
  assert.equal(ui.settings.step(), undefined)
  assert.ok(ui.stage.querySelector('[data-chat-flow]'), 'opening an empty room must mount the native chat view')
  assert.ok(ui.stage.querySelector('.bt-turn-time, .bt-new-sep, .bt-time-sep') === null, 'the opening has no time or divider')

  const composer = ui.stage.querySelector('[data-composer-input]')
  assert.equal(composer.getAttribute('contenteditable'), 'true')
  // jsdom has no browser text editing. Use the mounted DSH editor's draft
  // action, then the real Send button and its ordinary submission machine.
  ui.type('later composer post')
  await ui.tick()
  assert.match(composer.textContent, /later composer post/)
  const submit = ui.stage.querySelector('[data-composer-card] button[aria-label="input.send"]')
  assert.equal(submit.disabled, false, 'typing into the real editor enables Send')
  submit.click()
  await waitFor(() => ui.requests.length === 1, 'the real composer did not submit')
  await settleTurn(host, later.id)
  await ui.refresh()
  assert.deepEqual(ui.requests.map(({ sessionId, content }) => ({ sessionId, content })), [{
    sessionId: later.id, content: [{ type: 'text', text: 'later composer post' }],
  }])
  for (const [room, text, other] of [[typed, 'first typed', 'later composer post'], [later, 'later composer post', 'first typed']]) {
    assert.deepEqual(roomTurns(await host.raw(room.id)), [1, 2], 'each first real post uses its own room’s turn 2')
    assertReceipt(host, room.id, text, other)
  }
  assert.equal(watch.lines.filter(line => line.text === 'later composer post').length, 1)
  assert.equal(watch.messages.flatMap(event => event.rows ?? []).filter(row => row.text === 'later composer post').length, 1)
  assert.deepEqual(host.errors, [])
  assert.ok(!ui.firstNav() || !visible(ui.firstNav(), ui.window), 'one real turn exposes no rail')
  watch.source.close()
  await host.stop()
  const cold = await mountHost(tst, home)
  const reopened = fixture(tst, cold)
  await reopened.sync()
  await reopened.tick()
  assert.match(reopened.selectRoom(later.id).querySelector('.bt-row-preview').textContent, /later composer post|Fixture reply/)
  reopened.selectRoom(later.id).click()
  await reopened.afterShow(later.id)
  assert.ok(reopened.stage.querySelector('[data-chat-flow]'))
  assert.deepEqual(roomTurns((await cold.resolve(later.id)).session.snapshotEvents()), [1, 2])
  assert.equal(cold.rt.ledger.range(`group-${later.id}`, 1, cold.rt.roomOf(later.id).seq)
    .filter(row => row.text === 'later composer post').length, 1)
})

test('T6 post-scan resume renders no interrupted opening row and hides only the opening rail item', async tst => {
  const host = await tornAdmission(tst, { checkMarker: false })
  const ui = fixture(tst, host)
  await ui.sync()
  await ui.show(host.id)
  assert.ok(ui.stage.querySelector('[data-chat-flow-kind="turn-error"] .bt-fail, .bt-turn-time, .bt-time-sep, .bt-new-sep') === null,
    'the first rendered view shows an interruption, time or divider for the opening')
  assert.deepEqual(host.rt.roomOf(host.id).opened, { part: host.id, turn: 1 })
  assert.ok(host.startupRead)
  assert.equal(ui.noted.getSnapshot()[host.id]?.[1], undefined)
  await host.prompt(host.id, 'visible second turn')
  await settleTurn(host, host.id)
  await ui.refresh()
  assert.ok(!ui.firstNav() || !visible(ui.firstNav(), ui.window),
    `the one-real-turn rail stayed visible: ${ui.window.document.documentElement.getAttribute('data-bot-opening')} ${JSON.stringify(ui.list.getSnapshot().projectionsBySession?.[host.id]?.values.turnOutline)}`)
  assert.ok(ui.stage.querySelector('[data-chat-turn="2"] .bt-turn-time'))
  await host.prompt(host.id, 'visible third turn')
  await settleTurn(host, host.id)
  await ui.refresh()
  const nav = ui.firstNav()
  assert.ok(nav)
  assert.deepEqual([...nav.querySelectorAll('button[aria-label*="Turn"]')]
    .filter(button => visible(button, ui.window)).map(button => button.getAttribute('aria-label')), ['Turn 2', 'Turn 3'])
  assert.deepEqual(roomTurns(await host.raw(host.id)), [1, 2, 3])
})

test('T6 control shows the first visible kickoff with its opening time and unread divider', async tst => {
  const host = await mountHost(tst, await makeHome(tst), { noSeed: true })
  const room = await host.createRoom('No opening marker', { greet: true })
  await settleTurn(host, room.id)
  const ui = fixture(tst, host)
  await ui.sync()
  ui.visits.set({ [room.id]: { seen: 0, entered: Infinity } })
  await ui.show(room.id)
  assert.equal(host.rt.roomOf(room.id).opened, undefined)
  assert.ok(ui.stage.querySelector('.bt-turn-time'))
  assert.ok(ui.stage.querySelector('.bt-time-sep'), JSON.stringify({ clock: ui.noted.getSnapshot(), nodes: [...ui.stage.querySelectorAll('[data-chat-flow-kind]')].map(node => [node.dataset.chatFlowKind, node.dataset.chatTurn]) }))
  assert.ok(ui.stage.querySelector('.bt-new-sep'))
})

const openingRows = '[data-chat-flow-kind="turn-error"] .bt-fail, .bt-turn-time, .bt-time-sep, .bt-new-sep'

test('T6 race keeps a resumed opening hidden across paints with the old roster', async tst => {
  let ui
  let oldRoster
  const host = await tornAdmission(tst, { beforeResume: async (cold, id) => {
    ui = fixture(tst, cold, { withHeader: true })
    await ui.sync()
    oldRoster = ui.roster.getSnapshot()
    assert.equal(oldRoster.roomsById[id].opened, undefined)
    ui.holdRoster()
  } })
  const flashes = []
  const observer = new ui.window.MutationObserver(records => {
    for (const { addedNodes } of records) {
      for (const node of addedNodes) {
        const row = node.matches?.(openingRows) ? node : node.querySelector?.(openingRows)
        if (row) flashes.push(row.className)
      }
    }
  })
  observer.observe(ui.stage, { childList: true, subtree: true })
  ui.cleanups.push(() => observer.disconnect())
  await ui.show(host.id)
  assert.ok(ui.stage.querySelector('[data-chat-flow]'), 'the first paint includes the native chat')
  for (let frame = 0; frame < 3; frame++) {
    assert.strictEqual(ui.roster.getSnapshot(), oldRoster)
    assert.equal(ui.stage.querySelector(openingRows)?.className, undefined, 'an opening error, time or divider reached a paint')
    assert.equal(ui.window.document.body.style.getPropertyValue('--bt-first-sep'), '')
    await ui.tick()
  }
  assert.deepEqual(flashes, [])
  assert.equal(ui.noted.getSnapshot()[host.id]?.[1], undefined)
  observer.disconnect()

  await host.prompt(host.id, 'visible during roster lag')
  await settleTurn(host, host.id)
  await ui.refresh()
  assert.strictEqual(ui.roster.getSnapshot(), oldRoster)
  assert.ok(ui.stage.querySelector('[data-chat-turn="2"] .bt-turn-time'))
  assert.ok(!ui.firstNav() || !visible(ui.firstNav(), ui.window), 'the rail omits the opening before roster catch-up')
  assert.notEqual(ui.window.document.body.style.getPropertyValue('--bt-first-sep'), '', 'the header uses the first visible turn')
  await ui.catchUpRoster()
  assert.deepEqual({ ...ui.roster.getSnapshot().roomsById[host.id].opened }, { part: host.id, turn: 1 })
  assert.equal(ui.stage.querySelector('[data-chat-turn="1"] :is(.bt-fail, .bt-turn-time, .bt-time-sep, .bt-new-sep)'), null)
  assert.equal(ui.noted.getSnapshot()[host.id]?.[1], undefined)
  assert.ok(!ui.firstNav() || !visible(ui.firstNav(), ui.window))
})

test('T6 race control keeps a genuine first interruption with an initiating splice visible', async tst => {
  const inserted = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'interrupted post' }] })]
  const { home, id } = await makeColdRoom(tst, { tail: [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  ] })
  const host = await mountHost(tst, home)
  const ui = fixture(tst, host)
  await ui.sync()
  ui.holdRoster()
  await ui.show(id)
  assert.equal(host.rt.roomOf(id).opened, undefined)
  assert.ok(ui.stage.querySelector('[data-chat-flow-kind="turn-error"][data-chat-turn="1"] .bt-fail'))
  assert.ok(ui.stage.querySelector('[data-chat-turn="1"] .bt-turn-time'))
  await ui.catchUpRoster()
  assert.equal(ui.roster.getSnapshot().roomsById[id].opened, undefined)
  assert.ok(ui.stage.querySelector('[data-chat-flow-kind="turn-error"][data-chat-turn="1"] .bt-fail'))
})

test('T6 race control requires an exact committed prefix and follows the retained rail binding', tst => {
  const ui = browserFixture(tst)
  const api = ui.evaluate(botClient.text)
  const { roomOpeningTurn } = api.openingCells
  const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data, time: 1 } })
  const start = event(0, 'turn/start', { turn: 1 })
  const end = event(1, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  const entries = [start, end]
  const id = 'room'
  const room = { id }
  const roster = source({ roomsById: { [id]: room } })
  const list = source({ byId: { [id]: { projectionValues: { turnOutline: [{ turn: 1 }, { turn: 2 }] } } } })
  const current = eventWindow()
  let binding = { sessionId: id, eventSource: current }
  const openingSessions = { list, binding: key => key === id ? binding : undefined }
  const read = () => roomOpeningTurn(room, id, openingSessions)
  const rail = () => ui.window.document.documentElement.getAttribute('data-bot-opening')
  ui.cleanups.push(api.opening.installRoomOpeningRail({ roster, sessions: list, mainView: () => id, openingSessions }))
  for (const [window, older] of [
    [entries, true],
    [[start], false],
    [[start, event(2, 'turn/end', end.event.data)], false],
    [[{ ...start, type: 'transient' }, end], false],
    [[event(0, 'turn/start', { turn: 2 }), end], false],
    [[event(0, 'user/message', {}), event(1, 'turn/start', start.event.data), event(2, 'turn/end', end.event.data)], false],
  ]) {
    current.replace(window, older)
    assert.equal(read(), undefined)
    assert.equal(rail(), null)
  }
  current.replace(entries, false)
  assert.equal(read(), 1)
  assert.equal(rail(), 'rail', 'the rail heard the committed window on the active binding')
  assert.equal(roomOpeningTurn({ ...room, sessionId: 'new-part' }, id, openingSessions), undefined)
  assert.equal(roomOpeningTurn(room, id), undefined)
  assert.equal(roomOpeningTurn({ ...room, opened: { part: id, turn: 1 } }, id), 1)
  const replacement = eventWindow()
  binding = { sessionId: 'foreign', eventSource: replacement }
  replacement.replace(entries, false)
  list.set({ ...list.getSnapshot() })
  assert.equal(read(), undefined)
  assert.equal(rail(), null)
  current.replace(entries, false)
  assert.equal(rail(), null, 'the retired binding cannot restore the opening marker')
  binding = { sessionId: id, eventSource: replacement }
  list.set({ ...list.getSnapshot() })
  assert.equal(rail(), 'rail')
})
