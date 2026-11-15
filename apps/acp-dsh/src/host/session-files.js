// Exact image-file authority belongs to one live root chat, never a tool approval policy.
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { codexRuntimeRoot, restrictedChatGrants } from './codex-chat-profiles.js'

export const FILE_QUESTION = 'acp-session-file:'
export const FILE_ALLOW = 'Allow for this chat session'
const CANCELLED = { outcome: { outcome: 'cancelled' } }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key))
const empty = value => value == null || (Array.isArray(value) && value.length === 0)
export const restrictedLevel = level => !level.full && !level.auto && level.policy === 'ask' && ['read-only', 'workspace-write'].includes(level.sandbox)

// The ACP adapter's typed permission reporter, not a command, title or ENOENT message.
export function requestedImages(call) {
  if (call?.structuredName !== 'request_permissions' || typeof call.id !== 'string') return undefined
  const input = call.rawInput
  if (!keysOnly(input, ['permissions', 'cwd', 'environmentId']) || (input.environmentId != null && input.environmentId !== 'local')) return undefined
  const scope = input.permissions
  if (!keysOnly(scope, ['fileSystem', 'network']) || scope.network != null) return undefined
  const fs = scope.fileSystem
  if (!keysOnly(fs, ['read', 'write', 'entries']) || !empty(fs.write)) return undefined
  let entries
  if (!empty(fs.entries)) {
    if (!Array.isArray(fs.entries) || fs.entries.some(entry => !keysOnly(entry, ['path', 'access']) || entry.access !== 'read' ||
        !keysOnly(entry.path, ['type', 'path']) || entry.path.type !== 'path')) return undefined
    entries = fs.entries.map(entry => entry.path.path)
  }
  if (fs.read != null && !Array.isArray(fs.read)) return undefined
  const paths = fs.read?.length ? fs.read : entries
  if (!paths || paths.length === 0 || paths.length > 16 || (entries && !isDeepStrictEqual(entries, paths))) return undefined
  if (new Set(paths).size !== paths.length || paths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !/\.(png|jpe?g|gif|webp|bmp|tiff?|ico|avif)$/i.test(path))) return undefined
  if (!Array.isArray(call.locations) || !isDeepStrictEqual(call.locations.map(at => at.path), paths)) return undefined
  return paths
}

export function fileIdentity(path) {
  const canonical = realpathSync(path)
  const stat = statSync(canonical, { bigint: true })
  if (!stat.isFile()) throw new Error('Only exact regular image files can be approved.')
  return Object.freeze({ path, canonical, dev: stat.dev, ino: stat.ino, mode: stat.mode })
}
export function sameFiles(files) {
  try { return files.every(file => isDeepStrictEqual(fileIdentity(file.path), file)) } catch { return false }
}

// No home/config writes. The same restricted grants as the managed base plus exact paths.
export function sessionFileConfig(env, { sandbox, files = [] }, profileModes) {
  if (!['read-only', 'workspace-write'].includes(sandbox) || typeof env.CODEX_HOME !== 'string') throw new Error('No restricted chat profile is available.')
  const runtime = codexRuntimeRoot(env.CODEX_PATH)
  if (!runtime) throw new Error('The Codex runtime for the restricted chat profile is unavailable.')
  if (!sameFiles(files)) throw new Error('An approved image file changed. Ask for permission again.')
  const overrides = env.CODEX_CONFIG === undefined ? {} : JSON.parse(env.CODEX_CONFIG)
  const config = { ...overrides, features: { ...overrides.features, request_permissions_tool: true }, developer_instructions: [overrides.developer_instructions,
    'For an image outside your readable roots, request only its exact file with request_permissions. The person may authorize reading that file for this chat session. That ends this turn; wait for their next message to open it. Never request its directory or replay interrupted actions.',
  ].filter(Boolean).join('\n\n') }
  let mode
  if (files.length > 0) {
    // Discovery reads the shared home, not thread overrides. Only this spawn's trusted
    // managed id can select the process-local copy; the id itself conveys no authority.
    mode = profileModes?.[sandbox]
    const prefix = sandbox === 'workspace-write' ? 'workspace' : 'read'
    if (typeof mode !== 'string' || !new RegExp(`^permission-profile:automagik-${prefix}-[0-9a-f]{32}$`).test(mode)) throw new Error('The managed image profile is unavailable.')
    const id = mode.slice('permission-profile:'.length)
    const filesystem = restrictedChatGrants(env.CODEX_HOME, sandbox === 'workspace-write' ? 'write' : 'read', runtime)
    for (const file of files) filesystem[file.canonical] = 'read'
    config.permissions = { ...overrides.permissions, [id]: { description: 'Exact image files approved for this chat session', filesystem } }
  }
  return { env: { ...env, CODEX_CONFIG: JSON.stringify(config) }, sessionFileMode: mode, sessionFileEnabled: true }
}

export function affirmativeFileAnswer(result, id) {
  if (!keysOnly(result, ['answers']) || !Array.isArray(result.answers) || result.answers.length !== 1) return false
  const answer = result.answers[0]
  return keysOnly(answer, ['id', 'selected', 'custom']) && answer.id === id && answer.custom === undefined &&
    Array.isArray(answer.selected) && answer.selected.length === 1 && answer.selected[0] === FILE_ALLOW
}

/** Bounded proof of retirement, including mirror bodies and already executing bridge work. */
export async function drainFileSession(live, signal, ms = 6000) {
  let timer
  const stopped = Promise.resolve().then(() => live.run.stop())
  // The poll must end on deadline too, even if the process or bridge never settles.
  const bound = new AbortController()
  const combined = AbortSignal.any([signal, bound.signal])
  const work = async () => {
    await stopped
    while ((live.bridge?.calls ?? 0) > 0 || (live.mirrorBodies ?? 0) > 0 || (live.pendingMirrors?.size ?? 0) > 0) {
      combined.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    combined.throwIfAborted()
  }
  try {
    await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { bound.abort(); reject(new Error('The previous image session did not stop and drain.')) }, ms)
      combined.addEventListener('abort', () => reject(new Error('The image session was cancelled.')), { once: true })
    })])
  } finally { clearTimeout(timer); bound.abort() }
}

export class SessionFiles {
  constructor(host) { this.host = host; this.owners = new Map() }
  owner(agent, provider) {
    const id = agent.session.id
    let owner = this.owners.get(id)
    if (owner && (owner.agent !== agent || owner.session !== agent.session || owner.provider !== provider || owner.sandbox !== this.host.level(agent.session).sandbox)) { this.clear(id); owner = undefined }
    if (!owner) {
      owner = { agent, session: agent.session, provider, sandbox: this.host.level(agent.session).sandbox, lifetime: new AbortController(), grant: undefined, pending: undefined }
      this.owners.set(id, owner)
    }
    return owner
  }
  clear(id, { owner = this.owners.get(id), retire = true } = {}) {
    if (!owner || this.owners.get(id) !== owner) return
    this.owners.delete(id)
    owner.lifetime.abort()
    owner.grant = undefined
    owner.pending = undefined
    // A native process keeps its config until it exits. Dropping metadata cannot revoke it.
    if (retire) this.host.revoke?.(owner)
  }
  valid(owner) {
    return this.owners.get(owner.session.id) === owner && !owner.lifetime.signal.aborted &&
      this.host.agent(owner.session.id) === owner.agent && restrictedLevel(this.host.level(owner.session)) && this.host.level(owner.session).sandbox === owner.sandbox
  }
  async activate(owner, message, signal) {
    if (owner.failure) throw owner.failure
    const grant = owner.grant
    if (!grant) return []
    // A retry, synthetic notice, handoff or tool result cannot activate staged authority.
    if (grant.staged && (message?.role !== 'user' || message.source?.kind !== 'user')) throw new Error('Send a new message asking to open the approved image.')
    await grant.ready
    signal?.throwIfAborted()
    if (!this.valid(owner) || owner.grant !== grant || !sameFiles(grant.files)) throw new Error('Image permission expired. Ask for permission again.')
    grant.staged = false
    return grant.files
  }
  async ask(live, tool, exec, permission) {
    const owner = live.fileOwner
    const paths = requestedImages(permission.call)
    const fail = paths ? 'The image was not approved for this chat session.'
      : 'The requested file was not approved for this chat session.'
    const current = () => owner && this.valid(owner) && this.host.live(owner.session.id) === live && live.open && !live.own &&
      live.dshAgent === exec.agent && live.run.tools.get(tool.id) === tool && tool.permission === permission &&
      !permission.signal?.aborted && live.calls.has(exec.callId) && live.toolIds.get(exec.callId) === tool.id &&
      isDeepStrictEqual(permission.call?.rawInput, tool.rawInput) && isDeepStrictEqual(permission.call?.locations, tool.locations) &&
      permission.call?.id === tool.id && permission.call?.structuredName === tool.structuredName &&
      this.host.level(owner.session).sandbox === live.fileSandbox
    if (!paths || !current() || owner.pending) return fail
    const signal = AbortSignal.any([owner.lifetime.signal, permission.signal, ...(exec.signal ? [exec.signal] : [])])
    const record = { id: FILE_QUESTION + randomUUID(), permission, live, tool, callId: exec.callId, files: undefined }
    owner.pending = record
    const invalidated = () => {
      if (owner.pending === record) this.clear(owner.session.id, { owner })
    }
    signal.addEventListener('abort', invalidated, { once: true })
    const holds = () => current() && !signal.aborted && owner.pending === record && sameFiles(record.files)
    try {
      record.files = paths.map(fileIdentity)
      if (!holds()) return fail
      const question = `Allow reading only these exact image files for this chat session?\n${record.files.map(file => file.canonical).join('\n')}\nThis ends the current turn. Send a new message to open them. No sibling files or folders are included.`
      const service = this.host.questions()
      if (typeof service?.ask !== 'function') return fail
      const answer = await service.ask({ agent: exec.agent, signal, questions: [{ id: record.id, question, detail: question,
        options: [{ label: FILE_ALLOW }, { label: 'Reject' }], intent: { kind: 'approval', approve: FILE_ALLOW, reject: 'Reject' } }] })
      if (!holds()) {
        this.clear(owner.session.id, { owner })
        return fail
      }
      if (!affirmativeFileAnswer(answer, record.id)) return fail
      const files = [...(owner.grant?.files ?? []), ...record.files].filter((file, i, all) => all.findIndex(other => other.canonical === file.canonical) === i)
      if (!sameFiles(files)) return fail
      // Retire synchronously before yielding: no native allow option can race a new action.
      const grant = { files: Object.freeze(files), staged: true, retired: live, ready: undefined }
      owner.grant = grant
      owner.pending = undefined
      permission.answer(CANCELLED)
      this.host.retire(owner.session.id, live)
      const abort = () => this.clear(owner.session.id, { owner })
      exec.signal?.addEventListener('abort', abort, { once: true })
      if (exec.signal?.aborted) abort()
      grant.ready = drainFileSession(live, owner.lifetime.signal, this.host.drainMs).then(() => {
        if (!this.valid(owner) || owner.grant !== grant || !sameFiles(files)) throw new Error('Image permission expired while the previous session stopped.')
      }).catch(error => { owner.grant = undefined; owner.failure = error; throw error }).finally(() => exec.signal?.removeEventListener('abort', abort))
      // No unhandled rejection while the chat is waiting for the next person message.
      grant.ready.catch(() => {})
      if (!this.valid(owner) || owner.grant !== grant) return fail
      return `Approved reading ${record.files.map(file => file.canonical).join(', ')} for this chat session. This turn has ended. Send a new message asking to open the image; it has not been opened yet.`
    } catch {
      // Cancellation/retirement can throw after staging. Never leave usable authority (or
      // the old native process) behind a failed consent transaction.
      const staged = owner.grant?.retired === live
      try { this.clear(owner.session.id, { owner }) } finally { if (staged) live.run.dispose() }
      return fail
    } finally {
      signal.removeEventListener('abort', invalidated)
      if (owner.pending === record) owner.pending = undefined
    }
  }
}
