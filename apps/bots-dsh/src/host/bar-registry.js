// The read-only registry and attach ledger behind Team's seats.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { attachPath, foldAttach, modeProblem, readAttach } from '../shared/attach-record.js'
import { REPO_PATH, parseRegistry } from '../shared/registry.js'
import { connectCore } from './code-core.js'
import { trustedHc } from './code-env.js'
import {
  appHomeOf, boundedDescriptorText, boundedText, confirmedPane, effectiveKey,
  MAX_LEDGER_BYTES, MAX_PROJECTS, MAX_REGISTRY_BYTES, projectName,
} from './code-tree.js'

export { appHomeOf, effectiveKey as seatProjectKey }

function readRegistry(path, kind, readFile, warn) {
  try {
    const text = readFile === readFileSync ? boundedText(path, MAX_REGISTRY_BYTES) : readFile(path, 'utf8')
    if (text === undefined) return null
    if (text === null) throw new Error('unreadable registry')
    const parsed = parseRegistry(text, { kind })
    // The bar handles duplicate home ids itself, including rows the parser discarded.
    for (const message of parsed.warnings) {
      if (kind === 'home' && message.endsWith('id used twice; left out')) continue
      warn(`${path}: ${message}`)
    }
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`the Bot registry ${path} could not be read`)
    return null
  }
}

export function readBarRegistry({ homePath, readFile = readFileSync, warn = () => {} }) {
  const home = readRegistry(homePath, 'home', readFile, warn)
  const local = new Map()
  const remote = []
  const projects = []
  const projectNames = {}
  const roots = new Set()
  if (!home) return { bots: [], globals: [], remote, projects, projectNames, front: null, roots }

  const knownLocal = new Map()
  const remember = (id, folder) => {
    if (!knownLocal.has(id)) knownLocal.set(id, new Set())
    knownLocal.get(id).add(folder)
  }

  const { file, raw } = home
  const rawById = new Map()
  const rejected = new Set()
  // A discarded placement must still exclude executables from its checkout.
  for (const [rows, field] of [[raw.bots, 'folder'], [raw.projects, 'folder'], [raw.shown, 'project']]) {
    for (const entry of Array.isArray(rows) ? rows : []) {
      if (entry?.machine == null && typeof entry?.[field] === 'string' && isAbsolute(entry[field])) {
        roots.add(resolve(entry[field]))
      }
    }
  }
  for (const bot of raw.bots) {
    if (typeof bot?.id !== 'string') continue
    if (rawById.has(bot.id) && !rejected.has(bot.id)) {
      rejected.add(bot.id)
      warn(`${homePath}: ${bot.id} is used twice; left out`)
    }
    rawById.set(bot.id, bot)
  }
  const parsedIds = new Set(file.bots.map(bot => bot.id))
  for (const id of rawById.keys()) if (!parsedIds.has(id)) rejected.add(id)

  const picks = new Map()
  const localFolders = new Map()
  for (const entry of file.shown) {
    if (typeof entry.project !== 'string' || !isAbsolute(entry.project)) continue
    const folder = resolve(entry.project)
    const machine = entry.machine ?? null
    const place = JSON.stringify([folder, machine])
    if (!picks.has(place)) picks.set(place, new Set())
    for (const id of entry.bots) picks.get(place).add(id)
    if (machine === null) localFolders.set(folder, picks.get(place))
  }
  // The cap bounds repo reads. An incomplete scan cannot establish a unique placement.
  if (localFolders.size > MAX_PROJECTS) localFolders.clear()

  const homeNames = new Map()
  for (const entry of file.projects) {
    if (!isAbsolute(entry.folder)) continue
    const folder = resolve(entry.folder)
    const place = JSON.stringify([folder, entry.machine ?? null])
    if (!homeNames.has(place) && entry.name) homeNames.set(place, entry.name)
  }

  for (const bot of file.bots) {
    const original = rawById.get(bot.id)
    if (['folder', 'machine'].some(key => Object.hasOwn(original, key) && !Object.hasOwn(bot, key))
      || (bot.folder !== undefined && !isAbsolute(bot.folder))) {
      rejected.add(bot.id)
      continue
    }
    const folder = bot.folder === undefined ? undefined : resolve(bot.folder)
    const machine = bot.machine ?? null
    if (machine === null && folder !== undefined) {
      remember(bot.id, folder)
    }
    if (!bot.id.startsWith('b-') || rejected.has(bot.id)) continue
    const place = JSON.stringify([folder, machine])
    if (folder !== undefined && !picks.get(place)?.has(bot.id)) continue
    if (machine !== null) {
      remote.push({ ...bot, folder, key: `${bot.id}@${machine}`, project: homeNames.get(place) ?? projectName(folder) })
    } else if (folder === undefined || localFolders.has(folder)) {
      local.set(bot.id, { ...bot, folder, key: bot.id })
    }
  }

  for (const [folder, picked] of localFolders) {
    const repo = readRegistry(join(folder, REPO_PATH), 'repo', readFile, warn)?.file
    projectNames[folder] = repo?.name || homeNames.get(JSON.stringify([folder, null])) || projectName(folder)
    projects.push({ folder })
    if (!repo) continue
    for (const [id, bot] of local) {
      if (bot.folder === folder) local.set(id, { ...bot, main: false })
    }
    for (const bot of repo.bots) {
      remember(bot.id, folder)
      if (!bot.id.startsWith('b-') || !picked.has(bot.id)) continue
      if (local.has(bot.id) && local.get(bot.id).folder !== folder) continue
      local.set(bot.id, { ...bot, folder, key: bot.id })
    }
  }

  const bots = [...local.values()].filter(bot => !rejected.has(bot.id)
    && (knownLocal.get(bot.id)?.size ?? 0) < 2)
  const front = file.front ? { bot: file.front.bot, project: file.front.project } : null
  if (front?.project && isAbsolute(front.project)) front.project = resolve(front.project)
  if (front && file.front.machine !== undefined) front.machine = file.front.machine
  return { bots, globals: bots.filter(bot => bot.folder === undefined), remote, projects, projectNames, front, roots }
}

const attachFolds = new Map()

/** Check trust on the descriptor on every read, including cache hits. */
export function readAttachLedger({ appHome, getuid = process.getuid, warn = () => {} }) {
  const path = attachPath(appHome)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    const uid = getuid?.()
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES || modeProblem(path, stat.mode)
      || (uid !== undefined && stat.uid !== uid)) throw new Error('untrusted ledger')
    const key = [stat.dev, stat.ino, stat.mtimeMs, stat.size, stat.mode, stat.uid].join(':')
    const cached = attachFolds.get(path)
    if (cached?.key === key) return cached.attach
    const text = boundedDescriptorText(fd, stat.size)
    if (text === null) throw new Error('ledger changed during read')
    const { rows } = readAttach(text)
    const attach = { trusted: true, rows, fold: foldAttach(rows) }
    attachFolds.set(path, { key, attach })
    return attach
  } catch (error) {
    attachFolds.delete(path)
    if (fd === undefined && error?.code === 'ENOENT') return { trusted: true, rows: [], fold: foldAttach([]) }
    warn('the attach ledger could not be read')
    return { trusted: false }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const confirmations = new Map()
const CONFIRM_MS = 2000
export const forgetConfirmations = () => confirmations.clear()

async function terminalSnapshot(env, connect, bin) {
  let connection
  try {
    connection = await connect({ env, bin })
    const core = connection?.info?.core?.id
    if (!core) return null
    const answer = await connection.call('terminal.list')
    if (!Array.isArray(answer?.terminals)) return null
    const terminals = new Map(answer.terminals.map(terminal => [terminal.address, terminal]))
    return { core, terminals }
  } catch {
    return null
  } finally {
    try { connection?.close() } catch { /* the connection is going */ }
  }
}

/** Match the memoized core answer to the current ledger. Null means the core did not answer. */
export async function confirmPanes({ env, connect = connectCore, bindings, roots, fresh = false }) {
  const confirmed = new Map()
  if (!bindings.size) return confirmed
  const bin = trustedHc(env, roots)
  if (!bin) return confirmed
  let snapshot
  if (fresh) {
    snapshot = await terminalSnapshot(env, connect, bin)
  } else {
    const key = [appHomeOf(env), bin, env.HC_SESSION, env.HC_SOCKET, env.AUTOMAGIK_HERDR_CORE_SOCKET, env.XDG_RUNTIME_DIR].join('\0')
    let entry = confirmations.get(key)
    if (!entry || entry.until <= Date.now()) {
      entry = { until: Infinity }
      entry.pending = terminalSnapshot(env, connect, bin).finally(() => { entry.until = Date.now() + CONFIRM_MS })
      confirmations.set(key, entry)
    }
    snapshot = await entry.pending
  }
  if (!snapshot) return null
  for (const [id, binding] of bindings) {
    const terminal = confirmedPane(binding, snapshot.core, snapshot.terminals.get(binding.terminal))
    if (terminal) confirmed.set(id, terminal)
  }
  return confirmed
}
