import { chromium as base } from './fake-playwright.mjs'

let setup
export function nextContext(options = {}) {
  setup = { ...options, events: [], context: undefined, disconnected: false }
  return setup
}

const registration = (failure, handler) => {
  if (failure === 'throw') throw new Error('registration threw')
  if (failure === 'reject') return Promise.reject(new Error('registration rejected'))
  return new Promise(resolve => setImmediate(() => { handler(); resolve() }))
}

async function launch() {
  const run = setup
  const context = run.context = await base.launchPersistentContext()
  const { close, newPage, pages } = context
  const initial = pages()[0]
  const watchPage = page => {
    const { goto } = page
    page.goto = (url, options) => {
      run.events.push(`goto ${url}`)
      return goto(url, options)
    }
    return page
  }
  watchPage(initial)
  if (run.initialUrl) await initial.goto(run.initialUrl)
  if (run.noInitialPage) pages().length = 0
  context.pages = () => { run.events.push('pages'); return pages() }
  context.newPage = async () => { run.events.push('newPage'); return watchPage(await newPage()) }
  context.close = async () => { run.events.push('close'); await close() }
  context.route = run.http === 'missing' ? undefined : (_pattern, handler) =>
    registration(run.http, () => { context.routes.push(handler); run.events.push('request guard') })
  context.routeWebSocket = run.socket === 'missing' ? undefined : (_pattern, handler) =>
    registration(run.socket, () => { run.socketHandler = handler; run.events.push('socket guard') })
  return context
}

export const chromium = {
  launchPersistentContext: launch,
  async connectOverCDP() {
    const run = setup
    const context = await launch()
    return {
      contexts: () => [context],
      close: async () => { run.disconnected = true },
    }
  },
}

export async function request(context, { url, navigation = false, frame }) {
  const actions = []
  await context.routes.at(-1)({
    request: () => ({ url: () => url, isNavigationRequest: () => navigation, frame }),
    continue: async () => { actions.push('continue') },
    abort: async reason => { actions.push(reason) },
  })
  return actions
}

export async function socket(run, url) {
  const actions = []
  await run.socketHandler({
    url: () => url,
    close: async () => { actions.push('close') },
    connectToServer: () => { actions.push('connect') },
  })
  return actions
}
