// The member wall's principal record: which person each DSH session acts for. One JSON file,
// written only by the owner's side (mode 0600, owned by DSH's own user):
//   { "version": 1, "sessions": { "<session id>": "owner" | "member:<name>" } }
// Only a session recorded as the owner's is the owner. Anything else is a member: an unknown
// session, a malformed entry, and every session while the record is missing, unreadable,
// malformed or open to other users (fail closed). A member name is a path segment, so only a
// plain lower-case slug names a member area; any other name is a member with no area of its own.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

// The sessions a piece of work runs for. Set around each tool call and each agent step; a call
// with no session (the owner's own interface) reads no store. The store is
// { sessionId: the newest, sessions: every session it acts for }.
export const sessionScope = new AsyncLocalStorage()

export const OWNER = Object.freeze({ kind: 'owner' })

const member = name => Object.freeze({ kind: 'member', name: NAME.test(name ?? '') ? name : undefined })

export function readRecord(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const info = fstatSync(fd)
    if (!info.isFile()) return undefined
    if ((info.mode & 0o077) !== 0) return undefined
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return undefined
    const parsed = JSON.parse(readFileSync(fd, 'utf8'))
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) return undefined
    return parsed.sessions
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
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
