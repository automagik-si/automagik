import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, createRuntime } from '../index.js'
import { defaultBrowserHeadless } from '../src/host/browser-plugins.js'
import { gateScope } from '../src/host/browser/gate.js'
import { appBrowserEndpoint } from '../src/host/browser-plugins.js'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { systemPrompt as refsPrompt, toolDefs as refsTools } from '../src/host/browser/refs.js'
import { keepTabs, restoreTabs, TABS_FILE } from '../src/host/browser/tabs.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'
import { until } from './until.js'

const TEAM = {
  version: 1,
  mainBotId: 'm1',
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(config, { services = {}, team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, ...config })
  // The team's tools are served per Bot Session; the fake registry finds them through the runtime.
  ctx.provide('omniTeam', rt)
  return {
    ctx,
    rt,
    call: async (endpoint, payload) => {
      const response = await route.fetch(new Request('http://localhost/api/bot', {
        method: 'POST',
        body: JSON.stringify({ endpoint, payload }),
      }))
      return response.json()
    },
    stop: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const WRITE_ACTION = {
  kind: 'post',
  label: 'Publish update',
  origin: 'https://shop.example.com',
  host: 'shop.example.com',
}

function browserWriter() {
  let runs = 0
  let action = WRITE_ACTION
  return {
    runs: () => runs,
    setAction: value => { action = value },
    plugin: {
      id: 'refs',
      tools: [{
        name: 'browser_write',
        needsBrowser: false,
        async execute() {
          await gateScope.getStore()?.(action)
          runs += 1
          return 'written'
        },
      }],
    },
  }
}

const permissionService = defaultPreset => ({
  catalog: () => ({ options: [], defaultPreset }),
})

function browserExec(botId = 'b2', sessionId = botId) {
  return {
    name: 'browser_write',
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: { id: botId, session: { header: { id: sessionId } } },
  }
}

test('app browser endpoint carries download roots for the Bot resolved from the exec', async () => {
  const originalSend = process.send
  const roots = ['/workspace/b2', '/workspace']
  let request
  const tools = new Map()
  let cleanup
  process.send = (message, callback) => {
    request = message
    callback?.()
    queueMicrotask(() => process.emit('message', {
      type: 'ds-bot:browser-endpoint-response',
      id: message.id,
      url: 'ws://127.0.0.1:1234/devtools/browser/token',
    }))
    return true
  }
  try {
    mountBrowserPlugin({
      on() {},
      effect(create) { cleanup = create() },
      tools: { register(tool) { tools.set(tool.name, tool) } },
    }, {
      toolDefs: [{ name: 'browser_open', needsBrowser: true, execute: () => 'opened' }],
      defineTool: value => value,
      keyOf: async exec => exec.agent.id,
      profileRoot: '/profiles',
      downloadRoot: '/legacy-downloads',
      downloadRoots: async botId => {
        assert.equal(botId, 'b2')
        return roots
      },
      uploadRoots: async botId => {
        assert.equal(botId, 'b2')
        return roots
      },
      headless: true,
      connect: appBrowserEndpoint,
      openSession: async options => {
        assert.equal(options.botId, 'b2')
        assert.equal(await options.downloadDir(), roots[0])
        assert.deepEqual(await options.uploadRoots(), roots)
        await options.connect(options.botId)
        return { close: async () => {} }
      },
    })
    const result = await tools.get('browser_open').execute({ botId: 'other' }, { agent: { id: 'b2' } })
    assert.deepEqual(request, {
      type: 'ds-bot:browser-endpoint',
      id: request.id,
      botId: 'b2',
      downloadRoots: roots,
    })
    assert.equal(result, 'opened')
  } finally {
    await cleanup?.()
    process.send = originalSend
  }
})

test('a Bot\'s tabs are saved as they change and come back in a browser that opens with none', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tabs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let down
  const pageOf = (url, title = '') => {
    const listeners = {}
    const page = {
      url: () => url, title: async () => title, isClosed: () => false, mainFrame: () => page,
      on: (name, listener) => { listeners[name] = listener },
      goto: async (next) => {
        if (next === down) throw new Error('net::ERR_CONNECTION_REFUSED')
        url = next
        title = new URL(next).pathname.slice(1)
        listeners.framenavigated?.(page)
      },
    }
    return page
  }
  const contextOf = (pages) => {
    const listeners = {}
    return { pages: () => pages, on: (name, listener) => { listeners[name] = listener }, newPage: async () => { const page = pageOf('about:blank'); pages.push(page); listeners.page?.(page); return page } }
  }
  // The save hook fires after tabs.json has been written, so each wait below follows the
  // debounced save instead of guessing how long its 400 ms delay plus the write takes.
  const saves = []
  const saved = { tabs: [{ url: 'https://a.example/one', title: 'one' }, { url: 'https://b.example/two', title: 'two' }], active: 1 }

  const first = [pageOf('https://a.example/one', 'one'), pageOf('https://b.example/two', 'two')]
  const keeper = keepTabs({ context: contextOf(first), dir, activePage: () => first[1], onSave: entry => saves.push(entry) })
  await until(() => saves.length === 1, { label: 'the open tabs were saved', t })
  assert.deepEqual(saves[0], saved)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TABS_FILE), 'utf8')), saved)
  // A browser on its way out saves nothing more: its closing tabs do not replace the list.
  keeper.stop()
  first.length = 0
  keeper.changed()
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TABS_FILE), 'utf8')), saved)

  // After a crash or a restart the browser opens blank, and the saved tabs come back; one whose
  // site does not answer keeps its place in the list.
  down = 'https://b.example/two'
  const blank = [pageOf('about:blank')]
  const context = contextOf(blank)
  const active = await restoreTabs(context, dir, blank[0])
  assert.deepEqual(context.pages().map(page => page.url()), ['https://a.example/one', 'about:blank'])
  assert.equal(active, context.pages()[1])
  const again = keepTabs({ context, dir, activePage: () => active, onSave: entry => saves.push(entry) })
  await until(() => saves.length === 2, { label: 'the restored tabs were saved', t })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TABS_FILE), 'utf8')), saved)
  // Tabs closed while the browser is open leave the list, the last one too.
  blank.length = 0
  again.changed()
  await until(() => saves.length === 3, { label: 'the closed tabs were saved', t })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TABS_FILE), 'utf8')).tabs, [])
  again.stop()
  // A browser that already shows a web page keeps what it has.
  const open = contextOf([pageOf('https://c.example/')])
  await restoreTabs(open, dir, open.pages()[0])
  assert.deepEqual(open.pages().map(page => page.url()), ['https://c.example/'])
})

test('a Bot browser that went away opens again at the Bot\'s next call', async () => {
  const tools = new Map()
  let cleanup
  const opened = []
  mountBrowserPlugin({
    on() {},
    effect(create) { cleanup = create() },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {
    toolDefs: [{ name: 'browser_open', needsBrowser: true, execute: (_args, { session }) => session.id }],
    defineTool: value => value,
    keyOf: async () => 'b2',
    profileRoot: '/profiles',
    headless: true,
    openSession: async () => {
      const listeners = []
      const session = { id: opened.length + 1, close: async () => {}, onClosed: listener => listeners.push(listener), lose: () => { for (const listener of listeners) listener() } }
      opened.push(session)
      return session
    },
  })
  const call = () => tools.get('browser_open').execute({}, { agent: { id: 'b2' } })
  assert.equal(await call(), 1)
  assert.equal(await call(), 1)
  opened[0].lose()
  assert.equal(await call(), 2)
  await cleanup?.()
})

test('concurrent first browser calls share opening and relay connection', async () => {
  const tools = new Map()
  let cleanup
  let releaseOpen
  const waitForOpen = new Promise(resolve => { releaseOpen = resolve })
  let openCalls = 0
  let connectCalls = 0
  let rootsCalls = 0
  mountBrowserPlugin({
    on() {},
    effect(create) { cleanup = create() },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {
    toolDefs: [{ name: 'browser_open', needsBrowser: true, execute: () => 'opened' }],
    defineTool: value => value,
    keyOf: async () => 'b2',
    profileRoot: '/profiles',
    downloadRoots: async () => {
      rootsCalls += 1
      return ['/workspace/b2', '/workspace']
    },
    headless: true,
    connect: async () => {
      connectCalls += 1
      return 'ws://127.0.0.1:1234/devtools/browser/token'
    },
    openSession: async options => {
      openCalls += 1
      await options.connect(options.botId)
      await waitForOpen
      return { close: async () => {} }
    },
  })

  const execute = () => tools.get('browser_open').execute({}, { agent: { id: 'b2' } })
  const first = execute()
  const second = execute()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(openCalls, 1)
  assert.equal(connectCalls, 1)
  assert.equal(rootsCalls, 1)

  releaseOpen()
  assert.deepEqual(await Promise.all([first, second]), ['opened', 'opened'])
  await cleanup?.()
})

test('user takeover while opening closes the session once it resolves', async () => {
  const tools = new Map()
  let cleanup
  let publishHold
  let startedOpening
  let releaseOpen
  let resolveClosed
  let closeCalls = 0
  const openingStarted = new Promise(resolve => { startedOpening = resolve })
  const waitForOpen = new Promise(resolve => { releaseOpen = resolve })
  const closed = new Promise(resolve => { resolveClosed = resolve })
  let hold = null
  mountBrowserPlugin({
    on() {},
    effect(create) { cleanup = create() },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {
    toolDefs: [{ name: 'browser_open', needsBrowser: true, execute: () => 'opened' }],
    defineTool: value => value,
    keyOf: async () => 'b2',
    profileRoot: '/profiles',
    headless: true,
    getHold: () => hold,
    subscribeHolds: listener => {
      publishHold = listener
      return () => {}
    },
    openSession: () => {
      startedOpening()
      return waitForOpen
    },
  })

  const opening = tools.get('browser_open').execute({}, { agent: { id: 'b2' } })
  await openingStarted
  hold = { by: 'user' }
  publishHold('b2', hold)
  releaseOpen({ close: async () => { closeCalls += 1; resolveClosed() } })
  await opening
  await closed
  assert.equal(closeCalls, 1)
  await cleanup?.()
})

test('user takeover refuses a browser call before opening or connecting', async () => {
  const tools = new Map()
  let openCalls = 0
  let connectCalls = 0
  mountBrowserPlugin({
    on() {},
    effect() {},
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {
    toolDefs: [{ name: 'browser_open', needsBrowser: true, execute: () => 'opened' }],
    defineTool: value => value,
    keyOf: async () => 'b2',
    profileRoot: '/profiles',
    headless: true,
    getHold: () => ({ by: 'user' }),
    connect: async () => {
      connectCalls += 1
      return 'ws://127.0.0.1:1234/devtools/browser/token'
    },
    openSession: async () => {
      openCalls += 1
      return { close: async () => {} }
    },
  })

  await assert.rejects(
    tools.get('browser_open').execute({}, { agent: { id: 'b2' } }),
    /The user has taken over this browser/,
  )
  assert.equal(openCalls, 0)
  assert.equal(connectCalls, 0)
})

test('every team has the refs browser unless the config turns it off', (t) => {
  const on = start({})
  t.after(on.stop)
  assert.equal(on.ctx.registeredTools.has('browser_open'), true)
  assert.equal(on.ctx.registeredTools.has('browser_exec'), false)
  assert.equal(on.ctx.registeredTools.has('read_browser'), false)
  const off = start({ browserPlugin: false })
  t.after(off.stop)
  assert.equal(off.ctx.calls.includes('effect ds-bot: browser plugin'), false)
  assert.equal(off.ctx.registeredTools.has('browser_open'), false)
})

test('user browser controls are not exposed as Bot tools', (t) => {
  const { ctx, stop } = start({ browser: true, browserPlugin: 'refs' })
  t.after(stop)
  for (const name of ['browser-takeover', 'browser-give-back', 'browser-stop']) {
    assert.equal(ctx.registeredTools.has(name), false)
  }
})

test('browser-stop cancels the Bot chat, stops its room work, and sets a user hold', async (t) => {
  const { rt, call, stop } = start({ browser: true })
  t.after(stop)
  await rt.load()

  rt.state.rooms.room1 = { id: 'room1', members: ['b2'], sessions: { b2: 'room-session' } }
  rt.state.rooms.room2 = { id: 'room2', members: ['m1'], sessions: { m1: 'other-session' } }
  rt.live.set('b2', { turn: {} })
  rt.live.set('room-session', { turn: {} })
  const cancelled = []
  const stoppedRooms = []
  rt.resolveAgent = async sessionId => ({ cancel: reason => cancelled.push({ sessionId, reason }) })
  rt.stopMemberWork = async (roomId, botId) => { stoppedRooms.push({ roomId, botId }) }

  assert.equal((await call('browser-stop', { botId: 'b2' })).value, true)
  assert.deepEqual(cancelled, [{ sessionId: 'b2', reason: { kind: 'user' } }])
  assert.deepEqual(stoppedRooms, [{ roomId: 'room1', botId: 'b2' }])
  assert.deepEqual(rt.browserChannel.holdOf('b2'), {
    by: 'user', reason: 'stopped', note: 'The user is controlling this browser.',
  })
})

test('browser headless defaults only on Linux without a display', () => {
  assert.equal(defaultBrowserHeadless('linux', { DISPLAY: ':0' }), false)
  assert.equal(defaultBrowserHeadless('linux', {}), true)
  assert.equal(defaultBrowserHeadless('darwin', {}), false)
})

test('browser_task uses the Bot session model route when no test completion is injected', async (t) => {
  const { ctx, stop } = start({
    browserPlugin: 'task',
    browserPluginApi: {
      id: 'task',
      tools: [{
        name: 'browser_task',
        needsBrowser: false,
        async execute(_args, toolCtx) {
          const response = await toolCtx.complete({
            messages: [{ role: 'user', content: 'Read the page.' }],
            tools: [{
              type: 'function',
              function: { name: 'browser_snapshot', description: 'Read page', parameters: { type: 'object' } },
            }],
          })
          return response.choices[0].message.content
        },
      }],
    },
  })
  t.after(stop)
  const requests = []
  ctx.llm = {
    async *stream(request) {
      requests.push(request)
      yield { type: 'text-delta', index: 0, text: 'Session-routed response.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const session = {
    id: 'session-b2',
    header: { id: 'b2' },
    requestHeader: () => ({
      config: { provider: 'mock-provider', model: 'bot-session-model' },
      tools: [{ name: 'session-private-tool', description: '', parameters: {} }],
    }),
  }

  const value = await ctx.registeredTools.get('browser_task').execute({}, {
    agent: { id: 'b2', session },
    signal: new AbortController().signal,
  })

  assert.equal(value, 'Session-routed response.')
  assert.equal(requests[0].model, 'bot-session-model')
  assert.equal(requests[0].sessionId, 'session-b2')
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['browser_snapshot'])
})

test('the selected plugin is the same for every Bot, and profiles stay apart', async (t) => {
  const seen = []
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: {
      id: 'refs',
      tools: [
        {
          name: 'browser_snapshot',
          description: 'Read the page',
          parameters: {},
          async execute(_args, toolCtx) {
            seen.push(toolCtx.botId)
            return toolCtx.profileDir
          },
        },
      ],
    },
  })
  t.after(stop)
  assert.ok(ctx.calls.includes('effect ds-bot: browser plugin'))
  const tool = ctx.registeredTools.get('browser_snapshot')
  const writer = await tool.execute({}, { agent: { id: 'b2' } })
  const chief = await tool.execute({}, { agent: { id: 'm1' } })
  assert.deepEqual(seen, ['b2', 'm1'])
  assert.ok(writer.endsWith(join('browser-profiles', 'b2')))
  assert.ok(chief.endsWith(join('browser-profiles', 'm1')))
  assert.equal(await tool.execute({}, { agent: { id: 'stranger' } }), 'Only Bots on the team have a browser.')
})

test('an unknown browser plugin is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  try {
    assert.throws(() => createRuntime(fakeContext(), { home, browserPlugin: 'devtools' }), /Choose refs, script, task/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('refs exposes the ARIA snapshot tool contract', () => {
  assert.deepEqual(refsTools.map(tool => tool.name), [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_upload',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_tabs',
    'browser_back',
    'browser_screenshot',
    'browser_handoff',
    'browser_resume',
  ])
  assert.equal(refsTools.some(tool => tool.name === 'browser_scroll'), false)
  assert.equal(refsTools.find(tool => tool.name === 'browser_type').parameters.submit.required, undefined)
  assert.equal(refsTools.find(tool => tool.name === 'browser_tabs').parameters.index.required, undefined)
  assert.equal(refsTools.find(tool => tool.name === 'browser_handoff').parameters.note.required, undefined)
  assert.ok(refsPrompt.includes('Posting, uploading, downloading, or deleting may need approval;'))
})

// The model reads these before it tells the person what it did. The browser is the Bot's own:
// a window the person can see outside the app, the Bot's browser panel in the app. The
// right-panel Browser is a client-only panel these tools never open.
test('browser_open and browser_handoff say whose browser they drive, and whose panel they do not open', () => {
  const open = refsTools.find(tool => tool.name === 'browser_open').description
  const handoff = refsTools.find(tool => tool.name === 'browser_handoff').description
  for (const [name, description] of [['browser_open', open], ['browser_handoff', handoff]]) {
    assert.match(description, /this Bot's (?:own )?browser/, name)
    assert.match(description, /right-panel Browser/, name)
    assert.match(description, /[Oo]utside the (?:Automagik )?app/, name)
    assert.match(description, /in the (?:Automagik )?app[^.]*the Bot's browser panel/, name)
    assert.doesNotMatch(description, /sees nothing/, name)
    assert.doesNotMatch(description, /on the host/, name)
    assert.doesNotMatch(description, /in the user's browser panel|opens? a tab for the user/, name)
  }
  assert.match(open, /Open a URL in this Bot's own browser/)
  assert.match(open, /not a tab in the user's right-panel Browser/)
  assert.match(open, /a separate browser window the person can see/)
  assert.match(open, /headless only on Linux without a display/)
  assert.match(open, /Call browser_handoff when the person needs to take over/)
  assert.match(handoff, /handoff card in this chat and take over the Bot's browser/)
  assert.match(handoff, /outside the app in its browser window/)
  assert.match(handoff, /Nothing opens in the user's right-panel Browser/)
  assert.match(handoff, /Call browser_resume when they are done/)
})

test('browserExecutablePath must be a string when configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  try {
    assert.throws(
      () => apply(fakeContext(), { home, browserPlugin: 'refs', browserExecutablePath: 42 }),
      /browserExecutablePath must be a string/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a matching browser grant allows the write without asking', async (t) => {
  const approval = fakeApproval('rejected')
  const writer = browserWriter()
  const team = structuredClone(TEAM)
  team.bots.b2.browserGrants = [{ site: 'example.com', kinds: ['post'] }]
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
  t.after(stop)

  assert.equal(await ctx.registeredTools.get('browser_write').execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 1)
  assert.equal(approval.requests.length, 0)
})

test('approval is one-shot and each write requests it again', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') } })
  t.after(stop)
  const tool = ctx.registeredTools.get('browser_write')

  assert.equal(await tool.execute({}, browserExec()), 'written')
  assert.equal(await tool.execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 2)
  assert.equal(approval.requests.length, 2)
  assert.match(approval.requests[0].reason, /shop\.example\.com/)
  assert.match(approval.requests[0].reason, /Publish update/)
  assert.equal(approval.requests[0].toolName, 'browser_write')
  assert.equal(approval.requests[0].callId, 'call-1')
  assert.match(approval.requests[0].displayReason.en, /^Let Writer post/)
  assert.match(approval.requests[0].displayReason.zh, /Writer/)
})

test('a rejected approval prevents the write', async (t) => {
  const approval = fakeApproval('rejected')
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') } })
  t.after(stop)

  await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, browserExec()), /Do not try this action again unless the user asks\..*Nothing was done\./)
  assert.equal(writer.runs(), 0)
})

test('browser grants match exact hosts, subdomains, and wildcard sites and kinds', async (t) => {
  const cases = [
    { site: 'example.com', host: 'shop.example.com', kinds: ['post'], allowed: true },
    { site: 'example.com', host: 'badexample.com', kinds: ['post'], allowed: false },
    { site: '*', host: 'unrelated.test', kinds: ['post'], allowed: true },
    { site: 'example.com', host: 'example.com', kinds: ['*'], allowed: true },
  ]
  for (const entry of cases) {
    const approval = fakeApproval('rejected')
    const writer = browserWriter()
    const team = structuredClone(TEAM)
    team.bots.b2.browserGrants = [{ site: entry.site, kinds: entry.kinds }]
    const { ctx, stop } = start({
      browserPlugin: 'refs',
      browserPluginApi: writer.plugin,
    }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
    t.after(stop)
    const action = { ...WRITE_ACTION, host: entry.host }
    writer.setAction(action)
    const tool = ctx.registeredTools.get('browser_write')
    if (entry.allowed) {
      assert.equal(await tool.execute({}, browserExec()), 'written')
      assert.equal(approval.requests.length, 0)
    } else {
      await assert.rejects(tool.execute({}, browserExec()), /Nothing was done\./)
      assert.equal(approval.requests.length, 1)
    }
    await stop()
  }
})

test('read-only permissions use the ordinary approval path', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const team = structuredClone(TEAM)
  team.bots.b2.permission = 'read-only'
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
  t.after(stop)
  assert.equal(await ctx.registeredTools.get('browser_write').execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 1)
  assert.equal(approval.requests.length, 1)
})

test('missing approval service is reported without running the write', async (t) => {
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { permissionPresets: permissionService('workspace-write') } })
  t.after(stop)

  await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, browserExec()), /needs the user's approval.*so nothing was done\./)
  assert.equal(writer.runs(), 0)
})

test('approval cancellation, service failure, and missing Sessions are explicit', async (t) => {
  const cases = [
    {
      approval: fakeApproval('cancelled'),
      exec: browserExec(),
      message: /approval was cancelled\. Nothing was done\./,
    },
    {
      approval: { async request() { throw new Error('service offline') } },
      exec: browserExec(),
      message: /approval service was unavailable\. Nothing was done\./,
    },
    {
      approval: fakeApproval('allowed-once'),
      exec: { name: 'browser_write', agent: { id: 'b2' } },
      message: /needs the user's approval.*no way to ask here, so nothing was done\./,
    },
  ]
  for (const entry of cases) {
    const writer = browserWriter()
    const { ctx, stop } = start({
      browserPlugin: 'refs',
      browserPluginApi: writer.plugin,
    }, { services: { approval: entry.approval, permissionPresets: permissionService('workspace-write') } })
    t.after(stop)
    await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, entry.exec), entry.message)
    assert.equal(writer.runs(), 0)
  }
})

test('approval verbs cover every gated action', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') } })
  t.after(stop)
  const tool = ctx.registeredTools.get('browser_write')
  for (const [kind, label, verb] of [
    ['post', 'Publish update', 'post'],
    ['upload', 'upload files', 'upload files'],
    ['download', 'download file', 'download a file'],
    ['delete', 'Delete item', 'delete something'],
  ]) {
    writer.setAction({ ...WRITE_ACTION, kind, label })
    assert.equal(await tool.execute({}, browserExec()), 'written')
    assert.match(approval.requests.at(-1).reason, new RegExp(verb))
  }
})

test('payment is refused even with a wildcard grant or full-access preset', async (t) => {
  for (const setup of [
    team => { team.bots.b2.browserGrants = [{ site: '*', kinds: ['*'] }] },
    team => { team.bots.b2.permission = 'danger-full-access' },
  ]) {
    const approval = fakeApproval('allowed-once')
    const writer = browserWriter()
    const team = structuredClone(TEAM)
    setup(team)
    writer.setAction({ ...WRITE_ACTION, kind: 'payment', label: 'Pay now' })
    const { ctx, stop } = start({
      browserPlugin: 'refs',
      browserPluginApi: writer.plugin,
    }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
    t.after(stop)
    await assert.rejects(
      ctx.registeredTools.get('browser_write').execute({}, browserExec()),
      /call browser_handoff with reason "payment".*Nothing was done\./,
    )
    assert.equal(writer.runs(), 0)
    assert.equal(approval.requests.length, 0)
  }
})

test('expired grants do not authorize a write', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const team = structuredClone(TEAM)
  team.bots.b2.browserGrants = [{ site: 'example.com', kinds: ['post'], until: Date.now() - 1 }]
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
  t.after(stop)
  assert.equal(await ctx.registeredTools.get('browser_write').execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 1)
  assert.equal(approval.requests.length, 1)
})

test('browser grants are user-only, normalized, deduplicated, expiring, and clearable through api/bot', async (t) => {
  const { rt, call, stop } = start({})
  t.after(stop)
  await rt.load()
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: [] }, 'b2'),
    { message: 'Only the user can set what Writer may do in the browser' },
  )
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: [{ site: 'https://example.com/path', kinds: ['post'] }] }),
    /Browser grant site must be \* or a hostname/,
  )
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: [{ site: 'example.com', kinds: ['post', 'unsafe'] }] }),
    /Browser grant kinds must be a non-empty subset/,
  )
  for (const legacy of ['submit', 'purchase']) {
    await assert.rejects(
      rt.updateBot('b2', { browserGrants: [{ site: 'example.com', kinds: [legacy] }] }),
      /Browser grant kinds must be a non-empty subset/,
    )
  }
  for (const until of ['later', Number.NaN, Infinity]) {
    await assert.rejects(
      rt.updateBot('b2', { browserGrants: [{ site: '*', kinds: ['post'], until }] }),
      /future epoch-millisecond timestamp/,
    )
  }
  const expiredGrant = { site: '*', kinds: ['post'], until: Date.now() - 1 }
  const expired = await call('update-bot', { id: 'b2', browserGrants: [expiredGrant] })
  assert.equal(expired.ok, true)
  assert.deepEqual(expired.value.browserGrants, [])
  const freshGrant = { site: 'fresh.example', kinds: ['delete'], until: Date.now() + 60_000 }
  const mixed = await call('update-bot', { id: 'b2', browserGrants: [expiredGrant, freshGrant] })
  assert.equal(mixed.ok, true)
  assert.deepEqual(mixed.value.browserGrants, [
    { site: 'fresh.example', kinds: ['delete'], until: freshGrant.until },
  ])
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: Array.from({ length: 51 }, () => ({ site: '*', kinds: ['*'] })) }),
    /array of at most 50 entries/,
  )
  const saved = await call('update-bot', {
    id: 'b2',
    browserGrants: [
      { site: ' Example.COM ', kinds: ['post', 'upload', 'download', 'delete', 'post'] },
      { site: 'example.com', kinds: ['post', 'upload', 'download', 'delete'], until: Date.now() + 60_000 },
    ],
  })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value.browserGrants, [
    { site: 'example.com', kinds: ['delete', 'download', 'post', 'upload'] },
    { site: 'example.com', kinds: ['delete', 'download', 'post', 'upload'], until: saved.value.browserGrants[1].until },
  ])
  const cleared = await call('update-bot', { id: 'b2', browserGrants: null })
  assert.equal(cleared.ok, true)
  assert.equal(Object.hasOwn(cleared.value, 'browserGrants'), false)
})

test('set-prefs stores and validates the browser address lists', async t => {
  const { call, stop } = start({})
  t.after(stop)
  const saved = await call('set-prefs', {
    browserAllow: ['127.0.0.1', '10.0.0.0/8', '127.0.0.1'],
    browserDeny: ['*.internal.example'],
  })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value.browserAllow, ['127.0.0.1', '10.0.0.0/8'])
  assert.deepEqual(saved.value.browserDeny, ['*.internal.example'])

  const bad = await call('set-prefs', { browserDeny: ['not a host!'] })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /not an IPv4\/IPv6 address, CIDR range or hostname/u)

  const cleared = await call('set-prefs', { browserAllow: null, browserDeny: null })
  assert.equal(cleared.ok, true)
  assert.equal(Object.hasOwn(cleared.value, 'browserAllow'), false)
  assert.equal(Object.hasOwn(cleared.value, 'browserDeny'), false)
})

test('browser refusals distinguish prompts off, unavailable, and a person’s no', async t => {
  // DSH reads the policy of the call's own Session, so the never fake answers for that object only.
  for (const [approvalFor, message] of [
    [exec => ({ ...fakeApproval('rejected'), overrideOf: s => (s === exec.agent.session ? 'never' : undefined), config: { policy: 'ask' } }), 'Nobody was asked to approve Publish update on shop.example.com: approval prompts are off in this conversation (a subagent, or Full access), so nothing was done. Trying again here is refused the same way. The person can allow it in Settings -> Browser -> Allow an action, or do it themselves.'],
    [() => fakeApproval('unavailable'), "Publish update on shop.example.com needs the person's approval, but nobody could answer, so nothing was done."],
    [() => ({ ...fakeApproval('rejected'), config: { policy: 'ask' } }), 'The user did not approve Publish update on shop.example.com. Do not try this action again unless the user asks. Nothing was done.'],
  ]) {
    const exec = browserExec()
    const writer = browserWriter()
    const { ctx, stop } = start({ browserPlugin: 'refs', browserPluginApi: writer.plugin }, { services: { approval: approvalFor(exec), permissionPresets: permissionService('workspace-write') } })
    t.after(stop)
    await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, exec), { message })
    assert.equal(writer.runs(), 0)
  }
})
