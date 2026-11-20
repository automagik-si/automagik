import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { multiuserMode } from './multiuser.js'

// Only a current team and a known end to the lineage can rule out a Bot.
export function classifySession(rt, sessionId, agent, recordedBotOf) {
  const seen = new Set()
  try {
    for (let depth = 0; depth <= 32 && typeof sessionId === 'string'; depth += 1) {
      if (seen.has(sessionId)) return undefined
      seen.add(sessionId)
      if (rt.teamLoaded?.() !== true || rt.teamCurrent?.() !== true) return undefined
      const recorded = recordedBotOf?.(sessionId)
      if (recorded !== undefined) return recorded
      const live = (agent?.id ?? agent?.session?.id) === sessionId ? agent : undefined
      // This walk owns the depth limit and must see each header itself.
      const bot = rt.botOfSession(sessionId, live, { followParents: false })
      if (bot != null) return typeof bot.id === 'string' ? bot.id : undefined
      const header = live === undefined ? rt.ctx.sessions?.get(sessionId)?.header : live.session?.header
      if (header === null || typeof header !== 'object') return undefined
      if (header.origin !== 'subagent') return null
      sessionId = header.parentSession
    }
  } catch {
    return undefined
  }
  return undefined
}

export function provideBotSessions(ctx, rt) {
  return ctx.provide('automagikBotSessions', Object.freeze({
    version: 1,
    botOf: (sessionId, agent) => classifySession(rt, sessionId, agent),
    protectedRoots: () => [rt.home, rt.dshHome],
  }))
}

function syncFolder(home) {
  const folder = openSync(home, 'r')
  try {
    fsyncSync(folder)
  } finally {
    closeSync(folder)
  }
}

function writeRecord(home, file, record) {
  let temp
  try {
    const path = `${file}.${randomUUID()}.tmp`
    const fd = openSync(path, 'wx', 0o600)
    temp = path
    try {
      writeFileSync(fd, JSON.stringify(record))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
    temp = undefined
    syncFolder(home)
  } finally {
    if (temp !== undefined) {
      try { unlinkSync(temp) } catch {}
    }
  }
}

function readRecordedSessions(file, { stampFailed = false } = {}) {
  let fd
  try {
    if (!lstatSync(file).isFile()) throw new Error('not a regular file')
    // A symlink is not a record. Nonblocking open lets us refuse a FIFO without waiting on it.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ENOENT' || (stampFailed && error.code === 'ENOTDIR')) return new Map()
    throw error
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
    const { version, sessions } = JSON.parse(readFileSync(fd, 'utf8')) ?? {}
    if (version !== 1 || sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) {
      throw new Error('expected a version 1 Bot session record')
    }
    const entries = Object.entries(sessions)
    if (entries.some(([, botId]) => typeof botId !== 'string')) throw new Error('invalid Bot id in the session record')
    return new Map(entries)
  } finally {
    closeSync(fd)
  }
}

export function install(rt) {
  rt.multiuserHold = () => false
  rt.recordedBotOf = () => undefined
  const stamp = join(rt.home, 'multiuser-mode.json')
  const file = join(rt.home, 'multiuser-bot-sessions.json')
  if (multiuserMode()) {
    try {
      mkdirSync(rt.home, { recursive: true })
      writeRecord(rt.home, stamp, { version: 1, mode: 'on', since: new Date().toISOString() })
    } catch (error) {
      rt.botSessionGate = {
        file, stampFailed: true,
        reason: `ds-bot: Bots are held: the multiuser mode stamp ${stamp} could not be written (${error.message}); fix the team home and restart`,
      }
      return
    }
    rt.botSessionGate = { file }
    return provideBotSessions(rt.ctx, rt)
  }
  try {
    lstatSync(stamp)
  } catch (error) {
    if (error.code === 'ENOENT') return
  }
  rt.botSessionGate = {
    file,
    reason: `ds-bot: Bots are held: this team ran in multiuser mode, which is now off. Turn multiuser mode back on, or stop DSH and remove ${stamp} to release them as the owner (RFC 0038 rollback).`,
  }
}

export function installAhead(rt) {
  const { ctx, botSessionGate: gate } = rt
  if (gate === undefined) return
  const { file } = gate
  let { reason } = gate
  if (reason === undefined) {
    const written = new Set()
    let recorded
    try { recorded = readRecordedSessions(file) } catch {}
    rt.recordedBotOf = sessionId => recorded?.get(sessionId)
    // Records a Session as one Bot's before it runs anything; a failure stops that work.
    const recordSession = (sessionId, botId) => {
      if (written.has(sessionId)) return
      try {
        const sessions = readRecordedSessions(file)
        if (sessions.has(sessionId)) {
          // A prior attempt may have renamed the record before the directory sync failed.
          syncFolder(rt.home)
        } else {
          // Use the team writer, including a host whose lock file cannot be made.
          if (rt.canWriteTeam?.() !== true) throw new Error(rt.readOnly?.() ?? 'this host does not hold the team')
          sessions.set(sessionId, botId)
          writeRecord(rt.home, file, { version: 1, sessions: Object.fromEntries(sessions) })
        }
        recorded = sessions
        written.add(sessionId)
      } catch (error) {
        throw new Error(`ds-bot: could not record Bot session ${sessionId} in ${file}: ${error.message}`, { cause: error })
      }
    }
    // schedules.js records a fresh scheduled Session a Bot's task opens, before its prompt runs.
    rt.recordBotSession = recordSession
    const recordBot = ({ agent }, next) => {
      const sessionId = agent?.id ?? agent?.session?.id
      if (written.has(sessionId)) return next()
      const botId = classifySession(rt, sessionId, agent)
      if (typeof botId === 'string') recordSession(sessionId, botId)
      return next()
    }
    const preStep = ctx.on('agent/pre-step', recordBot, { prepend: true })
    const execute = ctx.on('tools/execute', recordBot, { prepend: true })
    return () => {
      delete rt.recordBotSession
      preStep()
      execute()
    }
  }
  let recorded
  try {
    recorded = readRecordedSessions(file, gate)
    rt.recordedBotOf = sessionId => recorded.get(sessionId)
  } catch (error) {
    reason += ` Could not read the Bot session record ${file} (${error.message}). Repair or remove the record and restart.`
  }
  const hold = ({ agent }, next) => {
    if (recorded === undefined
        || classifySession(rt, agent?.id ?? agent?.session?.id, agent, rt.recordedBotOf) !== null) throw new Error(reason)
    return next()
  }
  const preStep = ctx.on('agent/pre-step', hold, { prepend: true })
  const execute = ctx.on('tools/execute', hold, { prepend: true })
  rt.multiuserHold = () => true
  rt.warn('%s', reason)
  return () => {
    rt.multiuserHold = () => false
    preStep()
    execute()
  }
}
