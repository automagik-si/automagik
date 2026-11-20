import { HISTORY_TIMEOUT_MS, MAX_AVATAR_IMAGE, SOURCE_KIND } from './constants.js'
import { callerService } from './multiuser.js'
import { refusal } from './refusal.js'
import { isColor, textOf } from './text.js'

export const CALLER_BOT_KEYS = Object.freeze(['id', 'name', 'role', 'color', 'kind', 'avatar', 'main'])
const emptyPage = () => ({ items: [], cursor: null })
const unknown = () => refusal('Unknown Bot', { code: 'bot/not-found' })

export function closesPart(event) {
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  return source?.kind === SOURCE_KIND &&
    !(source.handoff === true && source.role === 'handoff' && source.resume !== true && !source.joined)
}

// The feed supplies the same per-part exchange turn list as the page reader.
export function callerItems(sessionId, events, seedTurn, exchangeTurns) {
  if (exchangeTurns === undefined) return []
  const hidden = new Set(Object.hasOwn(exchangeTurns, sessionId) ? exchangeTurns[sessionId] : [])
  const items = []
  let turn = seedTurn
  for (const event of events) {
    const { type, data, time, seq } = event
    if (type === 'turn/start') {
      turn = Number.isInteger(data?.turn) ? data.turn : undefined
      continue
    }
    if (turn === undefined || hidden.has(turn) || hidden.has(data?.turn)) continue
    if (type === 'user/message' && data?.source?.kind === 'user' && data.source.handoff !== true) {
      const content = Array.isArray(data.content) ? data.content : []
      const images = content.filter(block => block?.type === 'image').length
      items.push({ kind: 'user', text: textOf(content), time, seq, turn, ...(images > 0 ? { images } : {}) })
    } else if (type === 'assistant/message' && Array.isArray(data?.message?.content)) {
      for (const block of data.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          items.push({ kind: 'bot', text: block.text, time, seq, turn })
        }
      }
    }
  }
  return items
}

function avatarOf(avatar) {
  if (!avatar) return undefined
  const { shape, image, pet } = avatar
  return {
    ...(typeof shape === 'string' && /^[a-z][\w-]{0,31}$/.test(shape) ? { shape } : {}),
    ...(typeof image === 'string' && image.length <= MAX_AVATAR_IMAGE &&
      /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(image) ? { image } : {}),
    ...(['builtin', 'team'].includes(pet?.source) && typeof pet.id === 'string' &&
      /^[a-z0-9][\w-]{0,127}$/i.test(pet.id) && [1, 2].includes(pet.version)
      ? { pet: { source: pet.source, id: pet.id, version: pet.version, ...(pet.sleep === true ? { sleep: true } : {}) } } : {}),
  }
}

function decodeCursor(cursor) {
  if (cursor === undefined) return {}
  try {
    if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error()
    const value = JSON.parse(bytes.toString('utf8'))
    if (!Object.hasOwn(value, 'part') || !Number.isSafeInteger(value.part) ||
        Object.keys(value).some(key => key !== 'part' && key !== 'beforeSeq') ||
        (Object.hasOwn(value, 'beforeSeq') && (!Number.isSafeInteger(value.beforeSeq) ||
          value.beforeSeq < 0 || Object.is(value.beforeSeq, -0)))) throw new Error()
    return value
  } catch {
    throw refusal('Bad page', { code: 'bot/invalid' })
  }
}

export function install(rt) {
  const { ctx, state } = rt
  const checkedThrough = new Map()
  function visible(principal) {
    const service = callerService(ctx)
    if (!service) throw unknown()
    if (rt.readOnly() !== undefined || !rt.canWriteTeam()) throw refusal('This host is read-only', { code: 'bot/read-only' })
    return service.visibleBotIds(principal)
  }

  function visibleBot(principal, botId) {
    if (!visible(principal).has(botId)) throw unknown()
    const bot = rt.botOf(botId)
    if (bot?.id !== botId) throw unknown()
    return bot
  }

  function project(bot) {
    return {
      id: bot.id,
      name: typeof bot.name === 'string' ? bot.name : '',
      role: typeof bot.role === 'string' ? bot.role : '',
      color: isColor(bot.color) ? bot.color : null,
      kind: typeof bot.kind === 'string' ? bot.kind : null,
      avatar: avatarOf(bot.avatar) ?? null,
      main: rt.isMain(bot.id),
    }
  }

  function callerBots(principal) {
    const ids = visible(principal)
    const primary = state.mainBotIds[0]
    // The sidebar's stable ordering fields are available without observing any Session.
    const rank = bot => bot.id === primary ? 0 : bot.kind !== undefined ? 1 : 2
    return Object.entries(state.bots).filter(([id, bot]) => ids.has(id) && bot.id === id)
      .map(([, bot]) => bot)
      .sort((a, b) => rank(a) - rank(b) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map(project)
  }

  async function callerPage(parts, index, decoded) {
    const { sessionId, startedAt } = parts[index]
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const pages = new Map()
    const bounds = ({ events, hasMore }) => ({ first: events[0]?.seq, last: events.at(-1)?.seq, hasMore })
    const readPage = async (beforeSeq, throughSeq) => {
      signal.throwIfAborted()
      const page = await ctx.sessionController.events({
        address: { kind: 'session', sessionId },
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
        ...(throughSeq !== undefined ? { throughSeq } : {}),
        maxMessages: 60,
      }, signal)
      const events = page.records.map(record => record.event)
      if (events.some(closesPart)) {
        rt.closePart(sessionId, 'relay')
        throw unknown()
      }
      return { events, hasMore: page.hasMore }
    }
    const pageAt = async beforeSeq => {
      const result = await readPage(beforeSeq)
      pages.set(beforeSeq, bounds(result))
      return result
    }
    const { events, hasMore } = await pageAt(decoded.beforeSeq)
    let seedTurn
    let before = events[0]?.seq
    if (events[0]?.type !== 'turn/start' && hasMore) {
      for (let count = 0; count < 20 && Number.isSafeInteger(before); count++) {
        const back = await pageAt(before)
        const start = back.events.findLast(event => event.type === 'turn/start')
        if (start) {
          seedTurn = Number.isInteger(start.data?.turn) ? start.data.turn : undefined
          break
        }
        if (!back.hasMore || !(back.events[0]?.seq < before)) break
        before = back.events[0].seq
      }
    }
    // Check from the latest log cut back to the verified prefix, regardless of
    // which page the caller asked for. A relay can taint any turn in the part.
    const previouslyChecked = checkedThrough.get(sessionId) ?? -1
    const latest = pages.get(undefined) ?? bounds(await readPage())
    const through = latest.last
    let scan = latest
    let beforeSeq = Infinity
    while (scan.hasMore) {
      const first = scan.first
      if (!Number.isSafeInteger(first) || first >= beforeSeq) throw unknown()
      if (first <= previouslyChecked) break
      beforeSeq = first
      scan = pages.get(beforeSeq) ?? bounds(await readPage(beforeSeq, through))
    }
    if (through > (checkedThrough.get(sessionId) ?? -1)) {
      checkedThrough.delete(sessionId)
      checkedThrough.set(sessionId, through)
      if (checkedThrough.size > 256) checkedThrough.delete(checkedThrough.keys().next().value)
    }
    const items = callerItems(sessionId, events, seedTurn, state.exchangeTurns)
    const more = hasMore && events.length > 0 && Number.isSafeInteger(events[0].seq)
    if (!more && index > 0) items.unshift({ kind: 'divider', time: startedAt })
    const cursor = more ? { part: index, beforeSeq: events[0].seq } : index > 0 ? { part: index - 1 } : null
    return { items, cursor: cursor === null ? null : Buffer.from(JSON.stringify(cursor)).toString('base64url') }
  }

  Object.assign(rt, {
    callerBots,
    callerBot: (principal, botId) => project(visibleBot(principal, botId)),
    async callerChat(principal, botId, cursor) {
      visibleBot(principal, botId)
      const decoded = decodeCursor(cursor)
      const parts = rt.readableParts(botId)
      const index = decoded.part ?? parts.length - 1
      if (index < 0 || index >= parts.length) return emptyPage()
      const key = parts[index].sessionId
      const page = await callerPage(parts, index, decoded)
      // Owner operations can change canonical claims while the cold read is in flight.
      visibleBot(principal, botId)
      if (!rt.readableParts(botId).some(part => part.sessionId === key)) throw unknown()
      return page
    },
  })
}
