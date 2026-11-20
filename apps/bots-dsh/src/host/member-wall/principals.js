// The member wall's principal record: which person each DSH session acts for. One JSON file,
// written only by the owner's side (mode 0600, owned by DSH's own user):
//   { "version": 1, "sessions": { "<session id>": "owner" | "member:<name>" } }
// With Bots off, only a session recorded as the owner's is the owner. Anything else is a member: an unknown
// session, a malformed entry, and every session while the record is missing, unreadable,
// malformed or open to other users (fail closed). A member name is a path segment, so only a
// plain lower-case slug names a member area; any other name is a member with no area of its own.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname } from 'node:path'
import * as nodeProcess from 'node:process'
import { BOT_ID } from '../../shared/registry.js'

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
// Keep a leading BOM in the decoded text so JSON.parse rejects it as before.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The sessions a piece of work runs for. Set around each tool call and each agent step; a call
// with no session (the owner's own interface) reads no store. The store is
// { sessionId: the newest, sessions: every session it acts for }.
export const sessionScope = new AsyncLocalStorage()

export const OWNER = Object.freeze({ kind: 'owner' })
export const NOBODY = Object.freeze({ kind: 'none' })

const member = name => Object.freeze({ kind: 'member', name: NAME.test(name ?? '') ? name : undefined })
const bot = id => Object.freeze({ kind: 'bot', id: BOT_ID.test(id ?? '') ? id : undefined })
const warnedBy = new WeakMap()
const privateToDsh = info => (info.mode & 0o077) === 0
  && (typeof process.getuid !== 'function' || info.uid === process.getuid())
const privateFolder = info => info.isDirectory() && (info.mode & 0o077n) === 0n
  && info.uid === BigInt(nodeProcess.getuid?.() ?? -1)
const REJECTED_RECORD = Symbol('rejected principal record')

function warnOnce(warn, sessionId, message) {
  if (typeof warn !== 'function') return
  let warned = warnedBy.get(warn)
  if (warned === undefined) warnedBy.set(warn, warned = new Set())
  if (warned.has(sessionId)) return
  warned.add(sessionId)
  warn(sessionId, message)
}

export function readRecord(file) {
  return readPrincipalRecord(file, {})?.sessions
}

export function readPrincipalRecord(file, { instance }) {
  const record = readPrincipalFile(file, instance)
  return record === REJECTED_RECORD ? undefined : record
}

function readPrincipalFile(file, instance, checkFolder) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return error.code === 'ENOENT' ? undefined : REJECTED_RECORD
  }
  try {
    try {
      const info = fstatSync(fd)
      if (checkFolder && !checkFolder()) return REJECTED_RECORD
      if (!info.isFile() || info.nlink !== 1 || !privateToDsh(info)) return REJECTED_RECORD
      const contents = utf8.decode(readFileSync(fd))
      let parsed
      try {
        parsed = JSON.parse(contents)
      } catch {
        return undefined
      }
      const { version, sessions } = parsed ?? {}
      if (typeof sessions !== 'object' || sessions === null) return undefined
      if (version === 1) return { version, sessions }
      if (version === 2 && typeof instance === 'string' && instance.trim() !== '' && instance === parsed.instance
          && !Array.isArray(sessions)) return { version, sessions }
    } finally {
      closeSync(fd)
    }
  } catch {
    return REJECTED_RECORD
  }
}

function readFromPrivateFolder(file, instance, folderIdentity) {
  try {
    const folder = dirname(file)
    const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = fstatSync(fd, { bigint: true })
      if (!privateFolder(info) || `${info.dev}:${info.ino}` !== folderIdentity) return REJECTED_RECORD
      // Node has no openat. A swap and restore around the file open can evade this identity check.
      const folderMatches = () => {
        try {
          const current = lstatSync(folder, { bigint: true })
          return privateFolder(current) && current.dev === info.dev && current.ino === info.ino
        } catch {
          return false
        }
      }
      const record = readPrincipalFile(file, instance, folderMatches)
      return record !== undefined || folderMatches() ? record : REJECTED_RECORD
    } finally {
      closeSync(fd)
    }
  } catch {
    return REJECTED_RECORD
  }
}

export function botPrincipalOf(file, sessionId, { botOf, instance, folderIdentity, warn }) {
  const record = folderIdentity === undefined
    ? readPrincipalFile(file, instance)
    : readFromPrivateFolder(file, instance, folderIdentity)
  if (record === REJECTED_RECORD) return NOBODY
  const sessions = record?.sessions
  const value = sessions !== undefined && Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined
  const entry = typeof value === 'string' ? value : undefined
  let id
  try {
    id = botOf?.(sessionId)
  } catch {
    return NOBODY
  }
  if (typeof id === 'string') {
    if (record?.version === 2 && entry === `bot:${id}`) return bot(id)
    if (entry !== undefined) warnOnce(warn, sessionId, 'the principal record does not bind this session to its Bot')
    return bot(undefined)
  }
  if (id !== null) return NOBODY
  if (record?.version === 2 && entry?.startsWith('bot:')) {
    warnOnce(warn, sessionId, 'the principal record binds this session to a Bot whose lineage is missing')
    return NOBODY
  }
  if (entry === 'owner') return OWNER
  if (entry?.startsWith('member:')) return member(entry.slice('member:'.length))
  return member(undefined)
}

// The principal of one session. Read per call: the record changes as sessions are made, and a
// stale cached "owner" must never outlive its entry.
export function principalOf(file, sessionId) {
  const sessions = readRecord(file)
  if (sessions === undefined) return member(undefined)
  const entry = Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined
  if (entry === 'owner') return OWNER
  if (typeof entry === 'string' && entry.startsWith('member:')) return member(entry.slice('member:'.length))
  return member(undefined)
}

// The session the current work last entered, or undefined for work outside any session.
export const currentSession = () => sessionScope.getStore()?.sessionId

// Every session the current work acts for; empty outside any session. A store set with a
// session alone acts for that session.
export function scopeSessions() {
  const store = sessionScope.getStore()
  if (Array.isArray(store?.sessions)) return store.sessions
  return store?.sessionId === undefined ? [] : [store.sessionId]
}

// The scope for the current work plus one more session. A scope only ever gains sessions, so
// work that runs for one session and is handed another's never stops acting for the first:
// it is held to every rule at once, and no event can widen what it may do.
export function scopeWith(sessionId) {
  const sessions = scopeSessions()
  return { sessionId, sessions: sessions.includes(sessionId) ? sessions : [...sessions, sessionId] }
}
