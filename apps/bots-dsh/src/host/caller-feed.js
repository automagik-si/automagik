import { closesPart } from './caller-view.js'
import { callerService } from './multiuser.js'
import { personKey } from './people.js'

const MAX_FEEDS = 4
const MAX_BYTES = 64 * 1024
const KEEPALIVE_MS = 15_000
const HEADERS = { 'cache-control': 'no-store' }
const encoder = new TextEncoder()
const frame = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const hello = frame('hello', {})
const revision = frame('revision', {})
const keepalive = encoder.encode(': keepalive\n\n')

export function install(rt) {
  const { ctx } = rt
  const people = new Map()
  let timer, disposed

  function* feeds() {
    for (const person of people.values()) yield* person.feeds
  }

  function close(feed, cancelled = false) {
    if (feed.closed) return
    feed.closed = true
    const { person, request } = feed
    person.bytes -= feed.bytes
    person.feeds.delete(feed)
    if (person.feeds.size === 0) people.delete(feed.key)
    if (people.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
    request.signal.removeEventListener('abort', feed.abort)
    feed.request = undefined
    feed.queue.length = 0
    feed.changed.clear()
    if (!cancelled) feed.controller.close()
    feed.pull?.resolve()
    feed.pull = undefined
  }

  function valid(feed, entry) {
    if (feed.closed) return false
    if (callerService(ctx) !== feed.service) {
      close(feed)
      return false
    }
    if (entry.chunk === hello || entry.chunk === revision) return true
    try {
      if (rt.readOnly() !== undefined || !rt.canWriteTeam()) return false
      return entry.botId === undefined || (feed.service.visibleBotIds(feed.principal).has(entry.botId) &&
        rt.readableParts(entry.botId).length > 0 && !feed.closed)
    } catch {
      close(feed)
      return false
    }
  }

  function drain(feed) {
    if (!feed.pull || feed.draining) return
    feed.draining = true
    try {
      while (!feed.closed && feed.queue.length > 0) {
        const entry = feed.queue.shift()
        feed.bytes -= entry.chunk.byteLength
        feed.person.bytes -= entry.chunk.byteLength
        feed.changed.delete(entry.botId)
        if (!valid(feed, entry)) continue
        feed.controller.enqueue(entry.chunk)
        feed.pull.resolve()
        feed.pull = undefined
        break
      }
    } finally {
      feed.draining = false
    }
  }

  function enqueue(feed, chunk, botId) {
    const entry = { chunk, botId }
    if (feed.changed.has(botId) || !valid(feed, entry)) return
    const size = chunk.byteLength
    if (feed.person.bytes + size > MAX_BYTES) {
      close(feed)
      return
    }
    if (botId !== undefined) feed.changed.add(botId)
    feed.queue.push(entry)
    feed.bytes += size
    feed.person.bytes += size
    drain(feed)
  }

  function allowed(feed) {
    return new Map(Array.from(feed.service.visibleBotIds(feed.principal), id =>
      [id, new Set(rt.readableParts(id).map(part => part.sessionId))]))
  }

  function refreshAccess() {
    for (const feed of feeds()) {
      if (callerService(ctx) !== feed.service) {
        close(feed)
        continue
      }
      let next
      try { next = allowed(feed) } catch {
        close(feed)
        continue
      }
      if (feed.closed) continue
      const lost = [...feed.allowed].some(([id, parts]) => !next.has(id) ||
        [...parts].some(part => !next.get(id).has(part)))
      if (lost) close(feed)
      else {
        feed.allowed = next
        enqueue(feed, revision)
      }
    }
  }

  const offAccess = rt.onAccessLoss(refreshAccess)
  const offSaved = rt.onSaved(() => {
    for (const feed of feeds()) enqueue(feed, revision)
  })
  const offService = ctx.on('internal/service', name => {
    if (name !== 'automagikCaller') return
    for (const feed of feeds()) if (callerService(ctx) !== feed.service) close(feed)
  })
  const offEvent = ctx.on('session/event', (session, event) => {
    if (people.size === 0 || (event.type !== 'user/message' && event.type !== 'assistant/message') || closesPart(event)) return
    const id = rt.chatOwners.get(session?.id)
    if (id === undefined || !rt.readableParts(id).some(part => part.sessionId === session.id)) return
    const chunk = frame('changed', { botId: id })
    for (const feed of feeds()) enqueue(feed, chunk, id)
  })

  rt.callerFeed = async (request, principal) => {
    const service = callerService(ctx)
    const role = service?.roleOf(principal)
    if (disposed || (role !== 'member' && role !== 'guest')) {
      return new Response(null, { status: 403, headers: HEADERS })
    }
    const key = personKey(principal.person)
    const person = people.get(key) ?? { feeds: new Set(), bytes: 0 }
    if (person.feeds.size >= MAX_FEEDS) return new Response('Too many open feeds', { status: 429, headers: HEADERS })

    // Retain the request so that its signal keeps following the connection.
    const feed = { key, person, request, service, principal, bytes: 0, queue: [], changed: new Set() }
    feed.abort = () => close(feed)
    feed.allowed = allowed(feed)
    const body = new ReadableStream({
      start(controller) { feed.controller = controller },
      pull() {
        const pull = Promise.withResolvers()
        feed.pull = pull
        drain(feed)
        return pull.promise
      },
      cancel() { close(feed, true) },
    }, { highWaterMark: 0 })
    people.set(key, person)
    person.feeds.add(feed)
    request.signal.addEventListener('abort', feed.abort, { once: true })
    if (request.signal.aborted) close(feed)
    else {
      timer ??= setInterval(() => {
        for (const client of feeds()) if (client.queue.length === 0) enqueue(client, keepalive)
      }, KEEPALIVE_MS).unref()
      enqueue(feed, hello)
    }
    return new Response(body, { headers: { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8' } })
  }

  return () => {
    disposed = true
    offAccess()
    offSaved()
    offService?.()
    offEvent?.()
    for (const feed of feeds()) close(feed)
  }
}
