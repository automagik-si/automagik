import { randomUUID, createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { READ_SCOPE_CODE } from '../shared/read-scope.js'
import { replaceFile } from './files.js'
import { admitScopedRead, checkReadDispatch, scopedProviderOf } from './read-scope-provider.js'
import {
  BINDING_REFUSAL, FOLDER_REFUSAL, PROVIDER_REFUSAL, READ_PATH, readableFolder, scopedArguments,
} from './read-scope-policy.js'

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 512
const rootRecord = record => record === null || Object.hasOwn(record, 'folder')

export function install(rt) {
  const { ctx } = rt
  const directory = join(rt.home, 'session-read-scopes')
  const fileOf = id => join(directory, createHash('sha256').update(id).digest('hex') + '.json')

  // Session records are keyed by exact DSH ids. An absent record can mean unset
  // only after the caller's root identity is established. Invalid records and
  // failed reads propagate to the guard.
  function recordAt(path) {
    let fd
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
    catch (error) {
      if (error?.code !== 'ENOENT' || lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw error
      return null
    }
    let record
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 256 * 1024) throw refused(BINDING_REFUSAL)
      record = JSON.parse(readFileSync(fd, 'utf8'))
    } finally {
      closeSync(fd)
    }
    if (record?.version !== 1 || !validId(record.id) || fileOf(record.id) !== path) throw refused(BINDING_REFUSAL)
    const { id } = record
    const keys = Object.keys(record).length
    if (keys === 3 && (record.folder === null || (typeof record.folder === 'string' && isAbsolute(record.folder)))) return record
    if (keys === 4 && validId(record.rootId) && record.rootId !== id && typeof record.continuation === 'boolean') return record
    if (keys === 3 && Array.isArray(record.candidateRoots)
      && record.candidateRoots.length > 0 && record.candidateRoots.every(root => validId(root) && root !== id)) return record
    throw refused(BINDING_REFUSAL)
  }
  const recordOf = id => recordAt(fileOf(id))

  // With missing lineage, the default is safe only while there is no configured
  // folder. Read the durable records so this also works before the team loads.
  function assertNoConfiguredReadScope() {
    let entries
    try { entries = readdirSync(directory) }
    catch (error) {
      if (error?.code === 'ENOENT' && lstatSync(directory, { throwIfNoEntry: false }) === undefined) return
      throw error
    }
    for (const name of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      if (recordAt(join(directory, name))?.folder) throw refused(BINDING_REFUSAL)
    }
  }

  async function publish(id, data, guard) {
    guard?.()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = fileOf(id)
    const temporary = path + '.' + randomUUID()
    guard?.()
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        guard?.()
        await handle.writeFile(JSON.stringify({ version: 1, id, ...data }) + '\n')
        guard?.()
        await handle.sync()
      } finally {
        await handle.close()
      }
      guard?.()
      await replaceFile(temporary, path, guard)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async function headerOf(id) {
    const live = ctx.sessions?.get?.(id)
    return live?.header ?? (await ctx.get('sessionPersistence')?.stat(id))?.header
  }

  async function bindingOf(id, header) {
    const visited = new Set()
    let editable = true
    while (validId(id) && !visited.has(id)) {
      visited.add(id)
      const record = recordOf(id)
      if (!rootRecord(record)) {
        if (record.candidateRoots !== undefined) {
          const headers = await Promise.all(record.candidateRoots.map(headerOf))
          if (headers.some((source, index) => source?.id !== record.candidateRoots[index])) break
          return { candidateRoots: record.candidateRoots, editable: false }
        }
        // The association was saved before creation. Its root may be cold.
        // Older member continuations can have the flag set despite their room ownership.
        const past = rt.pastOwners?.get(id)
        const groupMember = rt.groupOwners?.has(id) || (past?.roomId !== undefined && past.botId !== undefined)
        editable = editable && record.continuation && !groupMember
        id = record.rootId
        header = undefined
        continue
      }
      header ??= await headerOf(id)
      if (header?.id !== id) break
      if (header.origin === 'subagent') {
        editable = false
        id = header.parentSession
        header = undefined
        continue
      }
      // A legacy team task has Bot ownership but no initiating root to inherit.
      if (rt.own(rt.state.tasks, id)?.from !== undefined) return { unbound: true, editable: false }
      // A group member works in the room's conversation, including members made
      // before the setting existed. New members and continued parts bind at creation.
      const group = rt.groupOwners?.get(id)
      if (group !== undefined) {
        editable = false
        id = rt.sessionOfRoom(rt.roomOf(group.roomId))
        header = undefined
        continue
      }
      return { rootId: id, editable }
    }
    throw refused(BINDING_REFUSAL)
  }

  function folderOf(rootId) {
    const record = recordOf(rootId)
    if (!rootRecord(record)) throw refused(BINDING_REFUSAL)
    return record?.folder ?? null
  }

  function boundFolder(binding) {
    if (binding.rootId !== undefined) return folderOf(binding.rootId)
    if (binding.unbound) {
      assertNoConfiguredReadScope()
      return null
    }
    if (binding.candidateRoots.some(rootId => folderOf(rootId) !== null)) throw refused(BINDING_REFUSAL)
    return null
  }

  async function resolveBinding(id, header) {
    await rt.load()
    if (rt.teamLoaded?.() === false) throw refused(BINDING_REFUSAL)
    return bindingOf(id, header)
  }

  async function resolveReadScope(id) {
    const binding = await resolveBinding(id)
    if (binding.rootId === undefined) throw refused(BINDING_REFUSAL)
    return { ...binding, folder: boundFolder(binding) }
  }

  // Use DSH's reserved Session id so a new workload cannot run before its
  // association is durable. Save even an unset root so later changes reach it.
  async function reserveReadScope(source, { continuation = false, guard } = {}) {
    let scope
    try { scope = await resolveReadScope(source) }
    catch {
      assertNoConfiguredReadScope()
      return undefined
    }
    const sessionId = `session-${randomUUID()}`
    await publish(sessionId, { rootId: scope.rootId, continuation: continuation && scope.editable }, guard)
    return sessionId
  }

  async function bindScheduledReadScope(sessionId, rootId) {
    const current = recordOf(sessionId)
    if (current !== null) {
      if (rootRecord(current) || current.rootId !== rootId || current.continuation) throw refused(BINDING_REFUSAL)
      return
    }
    if (sessionId === rootId || await headerOf(sessionId) !== undefined) throw refused(BINDING_REFUSAL)
    await publish(sessionId, { rootId, continuation: false })
  }

  async function markScheduledReadCandidates(sessionId, roots) {
    const current = recordOf(sessionId)
    if (current !== null && current.candidateRoots === undefined) throw refused(BINDING_REFUSAL)
    const candidateRoots = [...new Set([...(current?.candidateRoots ?? []), ...roots])]
    if (candidateRoots.includes(sessionId)) throw refused(BINDING_REFUSAL)
    if (candidateRoots.length !== current?.candidateRoots?.length) await publish(sessionId, { candidateRoots })
    boundFolder({ candidateRoots })
  }

  // Every readable record, by Session id. An unreadable or invalid one throws: what it names
  // is not known, so a caller that removes records removes none.
  function allRecords() {
    let entries
    try { entries = readdirSync(directory) }
    catch (error) {
      if (error?.code === 'ENOENT' && lstatSync(directory, { throwIfNoEntry: false }) === undefined) return new Map()
      throw error
    }
    const records = new Map()
    for (const name of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const record = recordAt(join(directory, name))
      if (record !== null) records.set(record.id, record)
    }
    return records
  }
  const namedBy = record => (record.rootId !== undefined ? [record.rootId] : record.candidateRoots ?? [])
  // The folder a record binds its Session to through the records alone: its own, its
  // root's, or any candidate root's. A loop counts as bound.
  function recordFolder(records, id, seen = new Set()) {
    if (seen.has(id)) return true
    seen.add(id)
    const record = records.get(id)
    if (record === undefined) return null
    if (rootRecord(record)) return record.folder ?? null
    if (record.rootId !== undefined) return recordFolder(records, record.rootId, seen)
    return record.candidateRoots.some(root => recordFolder(records, root, new Set(seen)) !== null) ? true : null
  }

  // A deleted Bot's or group's Sessions leave their records, but only a record no remaining
  // record names (its `rootId` or `candidateRoots`): a surviving Session whose lineage
  // points at a deleted one (a Bot the deleted Bot made, a scheduled task) keeps its root's
  // folder. Removing one can free another (a deleted part named its first part), so the
  // pass repeats until nothing more goes. `keep` holds back an id the caller protects.
  // A reading host removes nothing. Returns the removed ids.
  async function forgetReadScopes(ids, { keep = () => false } = {}) {
    if (rt.readOnly?.() !== undefined || !Array.isArray(ids)) return []
    const wanted = new Set(ids.filter(validId))
    if (wanted.size === 0) return []
    const records = allRecords()
    const removed = []
    for (let changed = true; changed;) {
      changed = false
      const named = new Set([...records.values()].flatMap(namedBy))
      for (const id of wanted) {
        if (!records.has(id) || named.has(id) || keep(id, records)) continue
        await unlink(fileOf(id)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
        records.delete(id)
        wanted.delete(id)
        removed.push(id)
        changed = true
      }
    }
    return removed
  }

  // The records deletions before this rule left behind, by the same rule: a Session DSH
  // holds in its archive that the team no longer knows (every deleted Bot's and group's
  // Session is archived). An archived Session nobody deleted can look the same, so a
  // record that binds a folder stays: only a record whose Session reads with no folder
  // either way goes, and no Session's limit changes. Runs at each start; repeats are
  // no-ops.
  const teamKnows = id => rt.selfOf?.(id) !== undefined || rt.roomOwners?.has(id) || rt.pastOwners?.has(id)
    || rt.botOf?.(id) !== undefined || rt.roomOf?.(id) !== undefined || rt.own?.(rt.state?.tasks, id) !== undefined
    || !(rt.agentClaims?.(id)?.next().done ?? true)
  async function forgetOrphanReadScopes() {
    // An absent team file loads as an empty team, which would make every archived part unknown.
    if (rt.readOnly?.() !== undefined || rt.teamHealth?.()?.present !== true) return []
    let archived
    try { archived = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? []) } catch { return [] }
    if (archived.size === 0) return []
    const orphans = [...allRecords().keys()].filter(id => archived.has(id) && !teamKnows(id))
    return forgetReadScopes(orphans, { keep: (id, records) => recordFolder(records, id) !== null })
  }
  rt.readScopeOrphansForgotten = Promise.resolve().then(() => rt.load()).then(forgetOrphanReadScopes)
    .catch((error) => { rt.warn('ds-bot: earlier deleted Sessions\' file-tool records were not removed: %s', error); return [] })

  const prepared = new WeakMap()
  ctx.on('tools/pre-execute', async function prepareReadScope(exec, next) {
    if (Object.hasOwn(READ_PATH, exec.name)) {
      const session = exec.agent?.session
      try {
        prepared.set(exec.token, await resolveBinding(session?.id, session?.header))
      } catch {
        // A missing preparation is a denial at the monotonic guard.
      }
    }
    return next()
  })
  ctx.tools.guard(exec => {
    if (!Object.hasOwn(READ_PATH, exec.name)) return undefined
    const deny = reason => ({ reason, info: { name: 'SessionReadScopeDenied', code: READ_SCOPE_CODE, reason } })
    try {
      const binding = prepared.get(exec.token)
      if (binding === undefined) return deny(BINDING_REFUSAL)
      const folder = boundFolder(binding)
      if (folder === null) return undefined
      const definition = ctx.tools.executable(exec.name, exec.agent, exec.toolSet)
      if (scopedProviderOf(definition) === undefined) return deny(PROVIDER_REFUSAL)
      const checked = scopedArguments(folder, exec.name, exec.arguments)
      if (checked.reason !== undefined) return deny(checked.reason)
      admitScopedRead(exec, folder, definition)
      return undefined
    } catch {
      return deny(BINDING_REFUSAL)
    }
  })
  ctx.on('tools/execute', (exec, next) => {
    if (Object.hasOwn(READ_PATH, exec.name)) {
      checkReadDispatch(exec, () => ctx.tools.executable(exec.name, exec.agent, exec.toolSet))
    }
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    const info = result?.error?.info
    if (info?.code !== READ_SCOPE_CODE) return
    rt.noteStop?.(exec.agent?.session?.id, {
      why: 'rule', tool: exec.name, callId: exec.callId, text: info.reason ?? result.error.message,
    }, exec.agent)
  })

  ctx.effect(() => rt.hooks.endpoint('session-read-scope', async ({ sessionId }) => {
    if (!validId(sessionId)) throw refused(BINDING_REFUSAL)
    const binding = await resolveBinding(sessionId)
    return { editable: binding.editable, folder: binding.editable ? boundFolder(binding) : null }
  }, { read: true }), 'ds-bot: session-read-scope endpoint')
  ctx.effect(() => rt.hooks.endpoint('set-session-read-scope', async ({ sessionId, folder }) => {
    if (!validId(sessionId) || !(folder === null || (typeof folder === 'string' && folder.length <= 4096))) {
      throw refused('Choose an absolute folder for these four file tools.')
    }
    const binding = await resolveBinding(sessionId)
    if (!binding.editable) throw refused('Set the file-tool folder in the root Session.')
    let real = null
    if (folder !== null) {
      try { real = readableFolder(folder) }
      catch { throw refused(FOLDER_REFUSAL) }
    }
    await publish(binding.rootId, { folder: real })
    return { editable: true, folder: real }
  }), 'ds-bot: set-session-read-scope endpoint')

  Object.assign(rt, { resolveReadScope, reserveReadScope, assertNoConfiguredReadScope, bindScheduledReadScope, markScheduledReadCandidates, forgetReadScopes })
}
