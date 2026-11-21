import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, httpRefusal, loadClient, manualTimeouts, nodes, reply, stalledResponse, text, tick, viewerReply } from './viewer-fixture.js'

function slotsOf(t, f, member, { ownerEffects = [], sessions, client = loadClient(f.globals) } = {}) {
  const registered = [], effects = [], disposers = []
  let surfaceDisposals = 0
  let panel = 'other-panel'
  const panelListeners = new Set()
  const forbidden = new Proxy({}, { get(_target, key) { assert.fail('Member UI read a native surface: ' + String(key)) } })
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      if ((member && !/styles|theme|interface copy/.test(label)) || ownerEffects.includes(label)) disposers.push(fn())
      return () => {}
    },
    slots: {
      entries: () => [],
      inject: (_name, fn) => fn(),
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: panel }),
        subscribe: fn => { panelListeners.add(fn); return () => panelListeners.delete(fn) },
      },
      selectPanel(id) { panel = id; for (const fn of panelListeners) fn() },
    },
    sessions: member ? forbidden : sessions ?? { list: {} },
    uiConversation: member ? forbidden : {},
    uiWorkspace: member ? forbidden : {},
    get: () => undefined,
    inject(deps, apply) {
      if (deps.length !== 0) return
      const scoped = []
      apply({ ...ctx, effect(fn, label) {
        effects.push(label)
        if ((member && !/styles|theme|interface copy/.test(label)) || ownerEffects.includes(label)) scoped.push(fn())
      } })
      const dispose = () => {
        surfaceDisposals++
        for (const cleanup of scoped.splice(0).reverse()) cleanup?.()
      }
      disposers.push(dispose)
      return { dispose }
    },
  }
  const dispose = () => { for (const cleanup of disposers.splice(0).reverse()) cleanup?.() }
  t.after(dispose)
  client.apply(ctx)
  return { ctx, client, dispose, registered, effects, surfaceDisposals: () => surfaceDisposals,
    panel: () => panel, get: name => registered.find(row => row.options.name === name) }
}

function feedFixture(f) {
  const feeds = []
  f.globals.EventSource = class {
    static CLOSED = 2
    constructor(url) { this.url = url; this.events = new Map(); this.readyState = 1; feeds.push(this) }
    addEventListener(name, fn) { this.events.set(name, fn) }
    emit(name, data) { this.events.get(name)?.({ data: JSON.stringify(data) }) }
    close() { this.readyState = 2 }
  }
  return feeds
}
const bots = [{ id: 'a', name: 'Allowed Bot' }]
const render = entry => entry.component(entry.options.inject?.() ?? {})

test('MM1 member and guest use only caller requests, read-only slots and the viewer storage key', async t => {
  for (const role of ['guest', 'member']) {
    const boot = Promise.withResolvers()
    const f = browser({ boot: { version: 1, role }, fetch: ({ body }) => {
      if (body.endpoint === 'whoami') return boot.promise
      if (body.endpoint === 'state') return reply({ revision: 1, bots })
      if (body.endpoint === 'chat') return reply({ items: [{ kind: 'bot', text: 'latest' }], cursor: 'opaque-next' })
      if (body.endpoint === 'earlier') return reply({ items: [{ kind: 'user', text: 'earlier' }], cursor: null })
      assert.fail(body.endpoint)
    } })
    const feeds = feedFixture(f)
    const app = slotsOf(t, f, true)
    assert.deepEqual(app.registered, [])
    assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
    assert.deepEqual(feeds, [])
    boot.resolve(viewerReply(role))
    await tick()
    const main = app.get('main')
    assert.equal(main.component.name, 'MemberRoot')
    assert.equal(main.options.key, 'conversation')
    assert.equal(app.get('sidebar.workspaces').component.name, 'MemberSidebar')
    for (const name of ['settings.trigger', 'settings.launcher']) assert.equal(app.get(name).component.name, 'Nothing')
    assert.equal(app.panel(), null)
    app.ctx.layout.selectPanel('later-panel')
    assert.equal(app.panel(), null)
    assert.deepEqual(feeds.map(feed => feed.url.split('?')[0]), ['api/omni-ui/feed'])
    assert.equal(feeds[0].url, `api/omni-ui/feed?viewer=viewer-id.${role}`)
    assert.deepEqual(f.writes, [['automagik.viewer', 'viewer-id']])
    feeds[0].emit('hello')
    await tick()
    const tree = render(main)
    const line = 'You can read this chat, but not send messages.'
    assert.ok(text(tree).includes(line))
    const rows = nodes(tree).find(node => node.type.name === 'MemberRows')
    assert.ok(rows)
    assert.match(JSON.stringify(rows.props.pages), /latest/)
    const earlier = nodes(tree).find(node => node.props.children.includes('Load earlier'))
    earlier.props.onClick()
    await tick()
    assert.deepEqual(f.calls.at(-1).body, { endpoint: 'earlier', payload: { botId: 'a', cursor: 'opaque-next' }, viewer: 'viewer-id' })
    assert.ok(f.calls.every(call => call.url === 'api/omni-ui' && call.method === 'POST' &&
      ['whoami', 'state', 'chat', 'earlier'].includes(call.body.endpoint)))
    const rendered = nodes(render(main)).map(node => String(node.type.name ?? node.type))
    assert.ok(rendered.every(name => !/Composer|Card|Thinking|textarea|input/.test(name)))
    feeds[0].emit('changed', { botId: 'a' })
    await tick()
    assert.doesNotMatch(JSON.stringify(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages), /earlier/)
    feeds[0].emit('error')
    assert.equal(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages.length, 0)
    feeds[0].emit('hello')
    await tick()
    assert.equal(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages.length, 1)
    f.window.emit('storage', { key: 'automagik.viewer', newValue: 'another' })
    assert.equal(feeds[0].readyState, 2)
    assert.equal(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages.length, 0)
  }
})

test('MM2 desktop takes the synchronous owner path without a viewer call', t => {
  const f = browser()
  const app = slotsOf(t, f, false)
  assert.ok(app.effects.includes('ds-bot: roster poll'))
  assert.ok(app.registered.some(({ component }) => component.name === 'BotReturn'))
  assert.ok(app.registered.every(({ component }) => !component.name.startsWith('Member')))
  assert.deepEqual(f.calls, [])
})

test('MM3 gated owner waits for whoami before mounting the owner path', async t => {
  const pending = Promise.withResolvers()
  const f = browser({ boot: { version: 1, role: 'owner' }, fetch: () => pending.promise })
  const app = slotsOf(t, f, false)
  assert.deepEqual(app.registered, [])
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
  assert.ok(!app.effects.includes('ds-bot: roster poll'))
  pending.resolve(viewerReply('admin'))
  await tick()
  assert.ok(app.effects.includes('ds-bot: roster poll'))
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
})

test('MM4 owner retirement clears rendered content, drafts and state even when reload cannot happen', async t => {
  for (const blocked of ['storage throws', 'reload latch']) {
    const pending = Promise.withResolvers()
    const f = browser({ boot: { version: 1, role: 'owner' }, fetch: ({ body }) => {
      if (body.endpoint === 'whoami') return viewerReply('owner')
      return pending.promise
    } })
    let draft = 'private draft'
    const app = slotsOf(t, f, false, {
      ownerEffects: ['ds-bot: clear owner state on retirement', 'ds-bot: retire gated surface'],
      sessions: { list: { getSnapshot: () => ({ byId: { 'private-chat': {} } }) },
        binding: () => ({ props: { inputActions: { setDraft(value) { draft = value } } } }) },
    })
    await tick()
    const { hooks } = app.client.omni.face()
    hooks.roster.set({ bots: [{ name: 'Private Bot' }] })
    hooks.ui.set({ quote: 'private quote' })
    f.document.body.replaceChildren({ text: 'private transcript' }, { value: 'private draft' })
    if (blocked === 'storage throws') {
      f.localStorage.key = () => { throw new Error('local storage blocked') }
      f.sessionStorage.getItem = () => { throw new Error('session storage blocked') }
    } else f.sessionStorage.setItem('automagik.retired', '1')
    const late = app.client.omni.call('state')
    f.window.emit('storage', { key: 'automagik.viewer', newValue: 'another' })
    assert.deepEqual(f.document.body.children, [])
    assert.equal(draft, '')
    assert.equal(app.client.omni.face(), null)
    assert.deepEqual(Array.from(hooks.roster.getSnapshot().bots), [])
    assert.equal(hooks.ui.getSnapshot().quote, null)
    assert.deepEqual(f.reloads, [])
    pending.resolve(reply({ bots: [{ name: 'late private Bot' }] }))
    await assert.rejects(late, { code: 'bot/retired' })
    assert.equal(app.surfaceDisposals(), 1)
  }
})

test('MM4 staggered stale 401s preserve the renewed owner’s drafts and visible transcript', async t => {
  const refusals = Array.from({ length: 4 }, () => Promise.withResolvers())
  const revalidations = [Promise.withResolvers(), Promise.withResolvers()]
  let reads = 0
  let checks = 0
  const f = browser({ boot: { version: 1, role: 'owner' }, fetch: ({ body }) => {
    if (body.endpoint === 'whoami') return body.viewer ? revalidations[checks++].promise : viewerReply('owner', 'owner-a')
    if (body.endpoint === 'state') return refusals[reads++].promise
    assert.equal(body.endpoint, 'send')
    return reply({ sent: true })
  } })
  const key = 'dsh.conversation.private-chat'
  let draft
  const setDraft = value => { draft = value; f.localStorage.setItem(key, value) }
  const app = slotsOf(t, f, false, {
    ownerEffects: ['ds-bot: gated viewer', 'ds-bot: clear owner state on retirement', 'ds-bot: retire gated surface'],
    sessions: { list: { getSnapshot: () => ({ byId: { 'private-chat': {} } }) },
      binding: () => ({ props: { inputActions: { setDraft } } }) },
  })
  await tick()
  setDraft('private draft')
  f.document.body.replaceChildren({ text: 'private transcript' })
  const errors = []
  const failed = refusals.map(() => assert.rejects(app.client.omni.call('state').catch(error => {
    errors.push(error.code)
    throw error
  }), { code: 'HTTP_401' }))
  const visible = () => {
    assert.equal(f.document.body.inert, false)
    assert.equal(f.document.body.style.getPropertyValue('display'), '')
    assert.deepEqual(f.document.body.children, [{ text: 'private transcript' }])
    assert.equal(draft, 'private draft')
    assert.equal(f.localStorage.getItem(key), 'private draft')
    assert.equal(app.surfaceDisposals(), 0)
    assert.deepEqual(f.reloads, [])
  }
  for (const [index, expectedChecks] of [1, 1, 2, 2].entries()) {
    refusals[index].resolve(httpRefusal(401))
    await failed[index]
    visible()
    f.window.emit('focus')
    for (const check of f.intervals) check()
    assert.equal(checks, expectedChecks)
    if (index === 1) {
      assert.equal((await app.client.omni.call('send', { prompt: 'fresh' })).sent, true)
    }
    if (index % 2 === 1) {
      revalidations[expectedChecks - 1].resolve(viewerReply('owner', 'owner-a'))
      await tick()
      visible()
    }
  }
  assert.deepEqual(errors, Array(4).fill('HTTP_401'))
  assert.equal(reads, 4)
  assert.deepEqual(f.calls.filter(call => call.body.endpoint === 'whoami').map(call => call.body.viewer),
    [undefined, 'owner-a', 'owner-a'])
  assert.equal(f.calls.find(call => call.body.endpoint === 'send').body.viewer, 'owner-a')
})

for (const outcome of ['match', 'role changed', 'storage changed at dispatch', 'storage cleared at dispatch']) {
  test(`H2 native queue preflight and dispatch use the mounted owner (${outcome})`, async t => {
    const f = browser({ boot: { version: 1, role: 'owner' }, fetch: ({ body }) => {
      assert.equal(body.endpoint, 'whoami')
      return viewerReply(body.viewer && outcome === 'role changed' ? 'member' : 'owner', 'owner-a')
    } })
    const native = []
    const session = {
      projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [{ id: 'item', source: { kind: 'user' } }] }) }) },
      updateQueue(id, action) { native.push([id, action.kind]); return { ok: true } },
    }
    const app = slotsOf(t, f, false, { sessions: {
      list: {},
      binding() {
        if (outcome === 'storage changed at dispatch' && f.calls.length === 2) {
          f.localStorage.setItem('automagik.viewer', 'owner-b')
        }
        if (outcome === 'storage cleared at dispatch' && f.calls.length === 2) {
          f.localStorage.removeItem('automagik.viewer') // The storage event has not reached this tab.
        }
        return { session }
      },
    } })
    await tick()
    await app.client.omni.face().actions.steerQueued('chat')
    assert.deepEqual(f.calls.map(call => call.body.viewer), [undefined, 'owner-a'])
    assert.deepEqual(native, outcome === 'match' ? [['item', 'steer']] : [])
    assert.deepEqual(f.reloads, outcome === 'match' ? [] : [true])
  })
}

for (const status of [401, 403]) {
  test(`R9 native queue preflight HTTP ${status} blocks dispatch and starts one revalidation`, async t => {
    const confirmation = Promise.withResolvers()
    const f = browser({ boot: { version: 1, role: 'owner' }, fetch: ({ body }) => {
      assert.equal(body.endpoint, 'whoami')
      if (!body.viewer) return viewerReply('owner', 'owner-a')
      return f.calls.length === 2 ? httpRefusal(status) : confirmation.promise
    } })
    const native = []
    const session = {
      projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [{ id: 'item', source: { kind: 'user' } }] }) }) },
      updateQueue(id, action) { native.push([id, action.kind]); return { ok: true } },
    }
    const app = slotsOf(t, f, false, { ownerEffects: gatedOwnerEffects, sessions: { list: {}, binding: () => ({ session }) } })
    await tick()
    await app.client.omni.face().actions.steerQueued('chat')
    assert.deepEqual(f.calls.map(call => call.body.viewer), [undefined, 'owner-a', 'owner-a'])
    f.window.emit('focus')
    assert.equal(f.calls.length, 3)
    confirmation.resolve(viewerReply('owner', 'owner-a'))
    await tick()
    assert.deepEqual(native, [])
    assert.deepEqual(f.reloads, [])
  })
}

test('MM5 feed loss hides the roster and header until a fresh state authorizes the selection', async t => {
  let state = bots
  const f = browser({ boot: { version: 1, role: 'member' }, fetch: ({ body }) => {
    if (body.endpoint === 'whoami') return viewerReply('member')
    if (body.endpoint === 'state') return state ? reply({ bots: state }) : { ok: false, status: 503 }
    return reply({ items: [], cursor: null })
  } })
  const feeds = feedFixture(f)
  const app = slotsOf(t, f, true)
  await tick()
  feeds[0].emit('hello')
  await tick()
  const main = app.get('main'), sidebar = app.get('sidebar.workspaces')
  assert.ok(text(render(main)).includes(bots[0].name))
  assert.ok(text(render(sidebar)).includes(bots[0].name))
  feeds[0].emit('error')
  assert.ok(!text(render(main)).includes(bots[0].name))
  assert.ok(!nodes(render(main)).some(node => node.type === 'header'))
  assert.ok(!text(render(sidebar)).includes(bots[0].name))
  state = undefined
  feeds[0].emit('hello')
  await tick()
  assert.ok(!text(render(main)).includes(bots[0].name))
  assert.ok(!text(render(sidebar)).includes(bots[0].name))
  state = bots
  feeds[0].emit('revision')
  await tick()
  assert.ok(text(render(main)).includes(bots[0].name))
  assert.ok(text(render(sidebar)).includes(bots[0].name))
})

test('MM6 withdrawal before a delayed feed hello never displays the old roster or chat', async t => {
  let shared = true
  const f = browser({ boot: { version: 1, role: 'member' }, fetch: ({ body }) => {
    if (body.endpoint === 'whoami') return viewerReply('member')
    if (body.endpoint === 'state') return reply({ bots: shared ? bots : [] })
    return reply({ items: [{ kind: 'bot', text: 'withdrawn chat' }], cursor: null })
  } })
  const feeds = feedFixture(f)
  const app = slotsOf(t, f, true)
  await tick()
  feeds[0].emit('revision')
  await tick()
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
  shared = false
  feeds[0].emit('hello')
  await tick()
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami', 'state'])
  assert.doesNotMatch(text(render(app.get('sidebar.workspaces'))).join(' '), /Allowed Bot/)
  assert.deepEqual(Array.from(nodes(render(app.get('main'))).find(node => node.type.name === 'MemberRows').props.pages), [])
})


const gatedOwnerEffects = ['ds-bot: gated viewer', 'ds-bot: clear owner state on retirement', 'ds-bot: retire gated surface']

function nativeComposer(f) {
  const key = 'dsh.conversation.private-chat'
  let draft = ''
  const clears = []
  const setDraft = value => {
    if (value === '') clears.push(f.document.body.inert)
    draft = value
    f.localStorage.setItem(key, value)
  }
  return {
    key, setDraft, clears, draft: () => draft,
    sessions: {
      list: { getSnapshot: () => ({ byId: { 'private-chat': {} } }) },
      binding: () => ({ props: { inputActions: { setDraft } } }),
    },
  }
}

for (const outcome of ['renewed cookie', 'refresh marker', 'refresh on retry', 'revoked', 'R6 plain retry 401', 'stalled retry refusal']) {
  test(`H2 revalidation retries whoami before clearing either draft (${outcome})`, async t => {
    const clock = manualTimeouts()
    const stale = Promise.withResolvers()
    const requests = []
    const f = browser({ boot: { version: 1, role: 'owner' }, timers: clock.timers, fetch: ({ body }) => {
      assert.equal(body.endpoint, 'whoami')
      if (!body.viewer) return viewerReply('owner', 'owner-a')
      requests.push(body.viewer)
      if (requests.length === 1) return stale.promise
      if (outcome === 'revoked') return httpRefusal(403)
      if (outcome === 'R6 plain retry 401') return httpRefusal(401)
      if (requests.length === 2 && outcome === 'refresh on retry') return httpRefusal(401, {}, { 'x-automagik-dsh-refresh': '1' })
      if (outcome === 'stalled retry refusal') return stalledResponse(401)
      return viewerReply('owner', 'owner-a')
    } })
    const composer = nativeComposer(f)
    const app = slotsOf(t, f, false, { ownerEffects: gatedOwnerEffects, sessions: composer.sessions })
    await tick()
    composer.setDraft('private draft')
    f.window.emit('focus')
    stale.resolve(httpRefusal(401, {}, outcome === 'refresh marker' ? { 'x-automagik-dsh-refresh': '1' } : undefined))
    await tick()
    assert.equal(composer.draft(), 'private draft')
    assert.equal(f.localStorage.getItem(composer.key), 'private draft')
    assert.equal(f.document.body.inert, false)
    assert.deepEqual(f.reloads, [])
    f.window.emit('focus')
    assert.deepEqual(requests, ['owner-a'])
    clock.advance(750)
    await tick()
    const revoked = ['revoked', 'R6 plain retry 401', 'stalled retry refusal'].includes(outcome)
    assert.deepEqual(requests, ['owner-a', 'owner-a'])
    assert.equal(composer.draft(), revoked ? '' : 'private draft')
    assert.equal(f.localStorage.getItem(composer.key), revoked ? null : 'private draft')
    assert.equal(f.document.body.inert, revoked)
    assert.deepEqual(f.reloads, revoked ? [true] : [])
    assert.equal(app.surfaceDisposals(), revoked ? 1 : 0)
    if (outcome === 'refresh on retry') {
      f.window.emit('focus')
      await tick()
      assert.deepEqual(requests, ['owner-a', 'owner-a', 'owner-a'])
      assert.equal(composer.draft(), 'private draft')
      assert.deepEqual(f.reloads, [])
    }
  })
}

for (const revoked of [false, true]) {
  test(`R${revoked ? 7 : 5} a stalled retry 200 keeps drafts until a later check ${revoked ? 'confirms revocation' : 'matches'}`, async t => {
    const clock = manualTimeouts()
    const stalled = Promise.withResolvers()
    let checks = 0
    const f = browser({ boot: { version: 1, role: 'owner' }, timers: clock.timers, fetch: ({ body }) => {
      if (!body.viewer) return viewerReply('owner', 'owner-a')
      if (++checks === 2) return { ok: true, json: () => stalled.promise }
      return checks === 1 || revoked ? httpRefusal(401) : viewerReply('owner', 'owner-a')
    } })
    const composer = nativeComposer(f)
    const app = slotsOf(t, f, false, { ownerEffects: gatedOwnerEffects, sessions: composer.sessions })
    await tick()
    composer.setDraft('private draft')
    f.document.body.replaceChildren({ text: 'private transcript' })
    f.window.emit('focus')
    await tick()
    clock.advance(750)
    await tick()
    assert.equal(checks, 2)
    const retry = f.calls.at(-1)
    clock.advance(5_000)
    await tick()
    assert.equal(retry.signal.aborted, true)
    assert.equal(f.document.body.inert, false)
    assert.deepEqual(f.document.body.children, [{ text: 'private transcript' }])
    assert.deepEqual(f.reloads, [])
    assert.equal(app.surfaceDisposals(), 0)
    assert.equal(composer.draft(), 'private draft')
    assert.equal(f.localStorage.getItem(composer.key), 'private draft')

    for (const check of f.intervals) check()
    await tick()
    assert.equal(checks, 3)
    assert.deepEqual(f.reloads, [])
    clock.advance(750)
    await tick()
    stalled.resolve({ ok: true, value: { multiuser: true, role: 'member', viewer: { id: 'owner-b', role: 'member' } } })
    await tick()
    assert.equal(checks, revoked ? 4 : 3)
    assert.equal(f.document.body.inert, revoked)
    assert.equal(composer.draft(), revoked ? '' : 'private draft')
    assert.equal(f.localStorage.getItem(composer.key), revoked ? null : 'private draft')
    assert.equal(app.surfaceDisposals(), revoked ? 1 : 0)
    assert.deepEqual(f.reloads, revoked ? [true] : [])
    assert.equal(clock.pending.size, 0)
  })
}

for (const [name, replacement, { bootRole, clearStorage } = {}] of [
  ['R2 another owner', () => viewerReply('owner', 'owner-b')],
  ['R2 another owner after storage clear', () => viewerReply('owner', 'owner-b'), { clearStorage: true }],
  ['R3 the same ID with a demoted role', () => viewerReply('member', 'owner-a'), { bootRole: 'member' }],
  ['an explicit viewer change', () => httpRefusal(503, { code: 'bot/viewer-changed' })],
  ['a plain refusal', () => httpRefusal(401)],
]) {
  test(`${name} clears the retained draft and transcript before the replacement can reveal`, async t => {
    const pending = Promise.withResolvers()
    let remounting = false
    const f = browser({ boot: { version: 1, role: 'owner' }, fetch: ({ body }) => {
      assert.equal(body.endpoint, 'whoami')
      return remounting ? pending.promise : viewerReply('owner', 'owner-a')
    } })
    const composer = nativeComposer(f)
    const options = { ownerEffects: gatedOwnerEffects, sessions: composer.sessions }
    const app = slotsOf(t, f, false, options)
    await tick()
    composer.setDraft('A unsent draft')
    const body = f.document.body
    body.replaceChildren({ text: 'A transcript' })
    const displays = []
    const setProperty = body.style.setProperty
    body.style.setProperty = (name, value, priority) => {
      if (name === 'display') displays.push(value)
      setProperty(name, value, priority)
    }
    app.dispose()
    assert.equal(composer.draft(), 'A unsent draft')
    assert.equal(f.localStorage.getItem(composer.key), 'A unsent draft')
    assert.equal(body.inert, true)
    assert.equal(body.style.getPropertyValue('display'), 'none')
    assert.deepEqual(f.reloads, [])

    remounting = true
    if (clearStorage) f.localStorage.values.clear()
    if (bootRole) f.globals.__AUTOMAGIK_VIEW__ = { version: 1, role: bootRole }
    const next = slotsOf(t, f, false, options)
    assert.equal(body.inert, true)
    pending.resolve(replacement())
    await tick()
    assert.equal(composer.draft(), '')
    assert.deepEqual(composer.clears, [true])
    assert.equal(f.localStorage.getItem(composer.key), null)
    assert.equal(body.inert, true)
    assert.equal(body.style.getPropertyValue('display'), 'none')
    assert.ok(displays.every(display => display === 'none'))
    assert.deepEqual(body.children, [])
    assert.equal(next.client.omni.face(), null)
    assert.deepEqual(f.reloads, [true])
  })
}

test('R1 a same-owner remount restores the composer and keeps its draft after disposal during chunk loading', async t => {
  const chunk = Promise.withResolvers()
  const f = browser({ boot: { version: 1, role: 'owner' }, fetch: () => viewerReply('owner', 'owner-a') })
  const body = f.document.body
  body.style.setProperty('display', 'flex', 'important')
  const composer = nativeComposer(f)
  const options = { ownerEffects: gatedOwnerEffects, sessions: composer.sessions }
  const client = loadClient(f.globals)
  const loadChunk = f.globals.require.async
  f.globals.require.async = async name => {
    await chunk.promise
    return loadChunk(name)
  }
  const first = slotsOf(t, f, false, { ...options, client })
  await tick()
  assert.equal(f.globals.__AUTOMAGIK_MOUNTED_VIEWER__.id, 'owner-a')
  assert.equal(body.inert, true)
  composer.setDraft('current draft')
  first.dispose()
  assert.equal(body.inert, true)
  assert.equal(body.style.getPropertyValue('display'), 'none')

  f.globals.require.async = loadChunk
  const second = slotsOf(t, f, false, options)
  await tick()
  chunk.resolve()
  await tick()
  assert.ok(second.client.omni.face())
  assert.equal(body.inert, false)
  assert.equal(body.style.getPropertyValue('display'), 'flex')
  assert.equal(body.style.getPropertyPriority('display'), 'important')
  assert.equal(composer.draft(), 'current draft')
  assert.equal(f.localStorage.getItem(composer.key), 'current draft')
  assert.deepEqual(composer.clears, [])
  composer.setDraft('new draft')
  assert.equal(composer.draft(), 'new draft')
  assert.equal(f.localStorage.getItem(composer.key), 'new draft')
  assert.deepEqual(f.reloads, [])
})

test('R4 eleven re-applies during renewal preserve the draft and keep viewer watchers stable', async t => {
  const clock = manualTimeouts()
  let confirming
  let renewing
  const f = browser({ boot: { version: 1, role: 'owner' }, timers: clock.timers, fetch: ({ body }) => {
    assert.equal(body.endpoint, 'whoami')
    return body.viewer ? renewing.promise : confirming?.promise ?? viewerReply('owner', 'owner-a')
  } })
  const composer = nativeComposer(f)
  const originalSetItem = f.localStorage.setItem
  const options = { ownerEffects: gatedOwnerEffects, sessions: composer.sessions, client: loadClient(f.globals) }
  const body = f.document.body
  const transcript = { text: 'A transcript' }
  const watchers = () => [f.window.listeners.get('focus')?.size, f.window.listeners.get('storage')?.size,
    f.document.listeners.get('visibilitychange')?.size, f.intervals.size]
  let app = slotsOf(t, f, false, options)
  await tick()
  body.replaceChildren(transcript)
  composer.setDraft('A unsent draft')
  assert.deepEqual(watchers(), [1, 1, 1, 1])
  for (let i = 0; i < 11; i++) {
    renewing = Promise.withResolvers()
    f.window.emit('focus')
    const stale = f.calls.at(-1)
    assert.equal(stale.body.viewer, 'owner-a')
    app.dispose()
    assert.equal(stale.signal.aborted, true)
    assert.equal(f.localStorage.setItem, originalSetItem)
    assert.deepEqual(watchers(), [0, 0, 0, 0])
    confirming = Promise.withResolvers()
    app = slotsOf(t, f, false, options)
    assert.equal(body.inert, true)
    assert.equal(body.style.getPropertyValue('display'), 'none')
    renewing.resolve(viewerReply('owner', 'owner-b'))
    await tick()
    assert.equal(body.inert, true)
    confirming.resolve(viewerReply('owner', 'owner-a'))
    await tick()
    assert.equal(body.inert, false)
    assert.deepEqual(body.children, [transcript])
    assert.equal(composer.draft(), 'A unsent draft')
    assert.equal(f.localStorage.getItem(composer.key), 'A unsent draft')
    assert.deepEqual(composer.clears, [])
    assert.deepEqual(f.reloads, [])
    assert.deepEqual(watchers(), [1, 1, 1, 1])
    assert.equal(clock.pending.size, 0)
  }
  f.window.emit('storage', { key: 'automagik.viewer', newValue: 'owner-b' })
  await tick()
  assert.equal(body.inert, true)
  assert.deepEqual(body.children, [])
  assert.equal(composer.draft(), '')
  assert.equal(f.localStorage.getItem(composer.key), null)
  assert.deepEqual(composer.clears, [true])
  assert.deepEqual(f.reloads, [true])
  assert.deepEqual(watchers(), [0, 0, 0, 0])
})
