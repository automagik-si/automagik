// Safe space reads for channel.js and MCP. No arbitrary Session, file or provider config reads.
import { botConfig, roomConfig } from './agent-access.js'

const invalid = () => Object.assign(new Error('Invalid space page'), { code: 'bot/invalid' })
export function pageOf(items, { offset = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit)
    || limit < 1 || limit > 100) throw invalid()
  return { items: items.slice(offset, offset + limit),
    nextOffset: offset + limit < items.length ? offset + limit : null }
}
const cursorOf = raw => {
  if (raw === undefined) return {}
  if (typeof raw !== 'string' || raw.length > 512) throw invalid()
  let value
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) }
  catch { throw invalid() }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, item]) => !['part', 'beforeSeq', 'afterSeq', 'offset']
      .includes(key)
      || !Number.isSafeInteger(item) || item < 0)) throw invalid()
  return value
}
const cursorText = value => value === null ? null
  : Buffer.from(JSON.stringify(value)).toString('base64url')
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined)
  .map(key => [key, value[key]]))

export function createSpaceReads(rt) {
  const recent = []
  const last = new Map()
  rt.ctx.on('session/event', (session, event) => {
    const botId = rt.selfOf(session.id)
    if (!botId) return
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const target = rt.groupOwners?.get(session.id)?.roomId ?? botId
    last.set(target, time)
    recent.push({ time, target, type: event.type })
    if (recent.length > 1000) recent.shift()
  })
  const statusOf = id => {
    const room = rt.own(rt.state.rooms, id)
    const bot = rt.own(rt.state.bots, id)
    // A Bot whose plugin is not installed cannot run: not idle, not installed, with why
    // (installed.js), so a reader of the space never takes it for a live teammate.
    const installation = bot === undefined ? undefined : rt.installationOf?.(bot)
    if (installation?.installed === false) return { status: 'not-installed', reason: installation.reason, lastActivity: null }
    const sessionId = bot ? rt.chatOf(id) : id
    const work = room ? rt.roomWorkView()[id] : rt.workView()[id]
    const sessions = room ? [id, ...Object.values(room.sessions ?? {})] : [sessionId]
    const waiting = (bot?.kickoff !== undefined && work === undefined)
      || sessions.some(session => rt.own(rt.state.questions, session) !== undefined
        || rt.own(rt.state.views, session) !== undefined)
      || rt.approvalsView().some(entry => entry.botId === id || entry.roomId === id
        || sessions.includes(entry.sessionId))
      || rt.waitingView?.()[id] !== undefined
    const activity = rt.activityView()[id]
    return { status: waiting || ['waiting', 'alert'].includes(activity) ? 'waiting'
      : work || activity ? 'running' : 'idle',
      lastActivity: last.get(id) ?? work?.since ?? room?.log?.at(-1)?.time ?? null }
  }
  const botOf = bot => ({ ...botConfig(bot, rt.state.mainBotIds),
    role: bot.role ?? '', instructions: bot.instructions ?? '',
    model: bot.model ?? rt.cachedDefault() ?? null, effort: bot.effort ?? null,
    permission: bot.permission ?? rt.state.prefs.permission
      ?? rt.permissionCatalog?.()?.defaultPreset ?? null,
    folder: bot.workDir ?? rt.teamFolder?.() ?? null, ...statusOf(bot.id) })
  const groupOf = room => ({ ...roomConfig(room), ...statusOf(room.id) })
  const conversations = () => [
    ...Object.values(rt.state.bots).map(bot => ({ id: bot.id, kind: 'bot', name: bot.name,
      sessionId: rt.chatOf(bot.id), ...statusOf(bot.id) })),
    ...Object.values(rt.state.rooms).map(room => ({ id: room.id, kind: 'group', name: room.name,
      ...statusOf(room.id) })),
  ]
  const messages = async (body, handle) => {
    const { id, limit = 50 } = body
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid()
    const cursor = cursorOf(body.cursor)
    const offset = cursor.offset ?? 0
    const room = rt.own(rt.state.rooms, id)
    if (room) {
      // Legacy logs receive these same sequence numbers when groups.js first opens them.
      const entries = (room.log ?? []).map((row, index) => ({ ...row, seq: row.seq ?? index + 1 }))
        .reverse().filter(row => typeof row.text === 'string'
          && (cursor.beforeSeq === undefined || row.seq < cursor.beforeSeq))
      const items = entries.slice(0, limit).map(row => pick(row,
        ['id', 'seq', 'who', 'text', 'time']))
      const next = entries.length > limit ? { beforeSeq: items.at(-1).seq } : null
      return { items, nextCursor: cursorText(next) }
    }
    if (!rt.own(rt.state.bots, id)) throw invalid()
    const underlying = pick(cursor, ['part', 'beforeSeq'])
    const reply = await handle('chat', { botId: id, cursor: underlying })
    if (!reply.ok) throw Object.assign(new Error('Conversation read refused'), {
      code: reply.error.code,
    })
    // The existing chat endpoint pages across current/earlier parts. Return text messages only;
    // image attachments and interactive/view payloads do not become a file-reading surface.
    const text = reply.value.items.filter(item => typeof item.text === 'string'
      && (cursor.afterSeq === undefined || item.seq >= cursor.afterSeq))
    const items = text.slice(offset, offset + limit).map(item => pick(item,
      ['kind', 'text', 'time', 'seq', 'turn', 'who']))
    let next = reply.value.cursor
    if (offset + limit < text.length) {
      // Pin the original part and event window: the live page can move or become an
      // earlier part between requests. A sequence may hold several text blocks;
      // offset counts only blocks within that sequence, never a moving live page.
      const window = reply.value.window ?? underlying
      const seq = items.at(-1)?.seq
      next = Number.isSafeInteger(seq) ? { ...window, afterSeq: seq,
        offset: text.slice(0, offset + limit).filter(item => item.seq === seq).length }
        : { ...window, offset: offset + limit }
    }
    return { items, nextCursor: cursorText(next) }
  }
  const read = async (endpoint, body, handle) => {
    await rt.refreshInstallation?.()
    switch (endpoint) {
      case 'space-bots': return pageOf(Object.values(rt.state.bots).map(botOf), body)
      case 'space-bot': {
        const bot = rt.own(rt.state.bots, body.id)
        return bot ? botOf(bot) : null
      }
      case 'space-groups': return pageOf(Object.values(rt.state.rooms).map(groupOf), body)
      case 'space-group': {
        const group = rt.own(rt.state.rooms, body.id)
        return group ? groupOf(group) : null
      }
      case 'space-conversations': return pageOf(conversations(), body)
      case 'space-conversation': return conversations().find(row => row.id === body.id) ?? null
      case 'space-messages': return messages(body, handle)
      case 'space-settings': return {
        prefs: pick(rt.state.prefs, ['theme', 'accent', 'motion', 'layout', 'width', 'flatWidth',
          'thinking', 'permission', 'backgroundModel']),
        mainBotIds: rt.state.mainBotIds, defaultModel: rt.cachedDefault() ?? null,
        permissions: rt.permissionCatalog?.() ?? null,
        models: pageOf(rt.cachedCatalog().map(model => pick(model, ['ref', 'name', 'provider',
          'reasoning', 'needsKey', 'needsSignIn'])), body),
      }
      case 'space-activity': return pageOf([...recent].reverse(), body)
      case 'space-audit': return pageOf((await rt.agentAccess.history()).reverse(), body)
      default: throw invalid()
    }
  }
  return { read }
}

export function install(rt) { rt.spaceReads = createSpaceReads(rt) }
