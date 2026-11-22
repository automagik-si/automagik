import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'

const SSH_CONFIG_D = '/etc/ssh/ssh_config.d'
const BASE_NAME = 'automagik-ssh-config-d'
const MAX_ENTRIES = 64
const MAX_FILE_BYTES = 1024 * 1024
const READ_CONFIG = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY
const GRACE_MS = 30_000
const DIRECTORY_FIELDS = ['dev', 'ino', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs']
const LINK_FIELDS = ['dev', 'ino', 'mode', 'ctimeNs']
const FILE_FIELDS = [...DIRECTORY_FIELDS, 'size']
const COPY_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode']
const IDENTITY_FIELDS = ['dev', 'ino']
const SSH_COPIES = Symbol('ssh-config-copies')

const statKey = (stat, fields) => fields.map(field => String(stat[field])).join(':')
const contains = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function privateDirectory(stat, uid) {
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077n) === 0n
}

function ancestors(files, path) {
  const identities = new Set()
  for (;;) {
    identities.add(statKey(files.statSync(path, { bigint: true }), IDENTITY_FIELDS))
    const parent = dirname(path)
    if (parent === path) return identities
    path = parent
  }
}

function overlapsWritableRoot(files, base, roots) {
  if (roots.length === 0) return false
  const baseAncestors = ancestors(files, base)
  const baseIdentity = statKey(files.statSync(base, { bigint: true }), IDENTITY_FIELDS)
  return roots.some(root => {
    if (contains(root, base) || contains(base, root)) return true
    const rootIdentity = statKey(files.statSync(root, { bigint: true }), IDENTITY_FIELDS)
    return baseAncestors.has(rootIdentity) || ancestors(files, root).has(baseIdentity)
  })
}

function checkedBase(files, runtime, uid) {
  if (!runtime || !isAbsolute(runtime)) throw new Error('XDG_RUNTIME_DIR must be set to an absolute path')
  const path = resolve(runtime)
  if (!privateDirectory(files.lstatSync(path, { bigint: true }), uid)) {
    throw new Error('XDG_RUNTIME_DIR must be a private directory owned by the current user')
  }
  return join(path, BASE_NAME)
}

function remove(path) {
  try { fs.rmSync(path, { recursive: true, force: true }) } catch { /* Best effort on the runtime filesystem. */ }
}

function sameDirectory({ path, identity }) {
  try {
    const stat = fs.lstatSync(path, { bigint: true })
    return stat.isDirectory() && statKey(stat, IDENTITY_FIELDS) === identity
  } catch {
    return false
  }
}

function sweep(base, uid, kill = process.kill) {
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith('p-')) continue
    const path = join(base, name)
    try {
      if (!privateDirectory(fs.lstatSync(path, { bigint: true }), uid)) continue
      const fd = fs.openSync(join(path, 'owner'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      let owner
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > 11) continue
        owner = fs.readFileSync(fd, 'utf8').trim()
      } finally {
        fs.closeSync(fd)
      }
      const pid = Number(owner)
      if (!/^[1-9]\d*$/.test(owner) || pid > 0x7fffffff) continue
      try { kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') remove(path) }
    } catch { /* A sibling can disappear during the sweep. */ }
  }
}

function copySnapshot(path) {
  const folder = fs.lstatSync(path, { bigint: true })
  if (!folder.isDirectory() || (folder.mode & 0o777n) !== 0o700n) return null
  const names = fs.readdirSync(path).sort()
  const entries = names.map(name => {
    const stat = fs.lstatSync(join(path, name), { bigint: true })
    return [name, statKey(stat, COPY_FIELDS)]
  })
  return JSON.stringify([statKey(folder, COPY_FIELDS), entries])
}

function intact(generation) {
  try {
    return copySnapshot(generation.path) === generation.snapshot
  } catch {
    return false
  }
}

function readEntry(files, { fd, stat }) {
  const bytes = Buffer.alloc(Number(stat.size) + 1)
  let position = 0
  while (position < bytes.length) {
    const read = files.readSync(fd, bytes, position, bytes.length - position, position)
    if (read === 0) break
    position += read
  }
  const after = files.fstatSync(fd, { bigint: true })
  if (position !== Number(stat.size) || statKey(after, FILE_FIELDS) !== statKey(stat, FILE_FIELDS)) return null
  return bytes.subarray(0, position)
}

class SshConfigCopies {
  #directories = new Map()
  #generations = new Set()
  #warnings = new Set()
  #swept = new Set()
  #current
  #counter = 0

  constructor(sweepOnStart) {
    // Existing copies can be cleaned before the first confined command. Creating a new
    // private directory waits until bwrap is selected and a copy is actually needed.
    if (sweepOnStart) {
      try {
        const uid = BigInt(process.getuid())
        const base = checkedBase(fs, process.env.XDG_RUNTIME_DIR, uid)
        if (privateDirectory(fs.lstatSync(base, { bigint: true }), uid)) {
          sweep(base, uid)
          this.#swept.add(fs.realpathSync(base))
        }
      } catch { /* The first bwrap call reports an unusable runtime directory. */ }
    }
  }

  warnOnce(error, logger) {
    const signature = `${error.code ?? error.name}: ${error.message}`
    if (this.#warnings.has(signature)) return
    this.#warnings.add(signature)
    logger.warn(`sandbox-local: using the stock SSH configuration (${signature})`)
  }

  bind(policy, settings = {}) {
    const files = settings.fs ?? fs
    const uid = BigInt(settings.uid ?? process.getuid())
    const source = settings.source ?? SSH_CONFIG_D
    const runtime = Object.hasOwn(settings, 'runtimeDirectory') ? settings.runtimeDirectory : process.env.XDG_RUNTIME_DIR
    const basePath = checkedBase(files, runtime, uid)
    const directory = files.lstatSync(source, { bigint: true })
    if (!directory.isDirectory() || directory.uid !== 0n || (directory.mode & 0o022n) !== 0n) return null
    const names = files.readdirSync(source).sort()
    if (names.length === 0 || names.length > MAX_ENTRIES) return null

    const entries = []
    try {
      for (const name of names) {
        const path = join(source, name)
        const link = files.lstatSync(path, { bigint: true })
        const fd = files.openSync(path, READ_CONFIG)
        const entry = { name, link, fd }
        entries.push(entry)
        const stat = entry.stat = files.fstatSync(fd, { bigint: true })
        if (!stat.isFile() || (stat.uid !== 0n && stat.uid !== uid) || (stat.mode & 0o022n) !== 0n
          || stat.size > BigInt(MAX_FILE_BYTES)) return null
      }
      if (entries.every(({ stat }) => stat.uid === uid)) return null

      try { files.mkdirSync(basePath, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      if (!privateDirectory(files.lstatSync(basePath, { bigint: true }), uid)) {
        throw new Error('the SSH configuration copy base must be a private directory owned by the current user')
      }
      const base = files.realpathSync(basePath)
      const roots = workspaceWritableRoots(policy).sort()
      if (overlapsWritableRoot(files, base, roots)) return null

      const signature = createHash('sha256').update(JSON.stringify([
        statKey(directory, DIRECTORY_FIELDS),
        entries.map(({ name, link, stat }) => [name, statKey(link, LINK_FIELDS), statKey(stat, FILE_FIELDS)]),
        roots,
      ])).digest('hex')
      const providerDirectory = this.#providerDirectory(base, uid, settings.kill)
      const now = (settings.now ?? Date.now)()
      const current = this.#current
      if (current?.signature === signature && current.providerDirectory === providerDirectory && intact(current)) {
        current.lastUsed = now
        return current.path
      }
      const bytes = entries.map(entry => readEntry(files, entry))
      if (bytes.includes(null)) return null
      const path = this.#buildGeneration(providerDirectory.path, signature, entries, bytes)
      const snapshot = copySnapshot(path)
      if (!snapshot) return null
      this.#current = { path, signature, snapshot, providerDirectory, lastUsed: (settings.now ?? Date.now)() }
      this.#generations.add(this.#current)
      this.#prune(this.#current.lastUsed)
      return path
    } finally {
      for (const { fd } of entries) files.closeSync(fd)
    }
  }

  #providerDirectory(base, uid, kill) {
    const directory = this.#directories.get(base)
    if (directory) {
      const stat = fs.lstatSync(directory.path, { bigint: true })
      if (!privateDirectory(stat, uid) || statKey(stat, IDENTITY_FIELDS) !== directory.identity) {
        throw new Error('the SSH configuration copy directory changed')
      }
      return directory
    }
    if (!this.#swept.has(base)) {
      sweep(base, uid, kill)
      this.#swept.add(base)
    }
    const path = fs.mkdtempSync(join(base, 'p-'))
    try {
      fs.writeFileSync(join(path, 'owner'), `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      const directory = { path, identity: statKey(fs.lstatSync(path, { bigint: true }), IDENTITY_FIELDS) }
      this.#directories.set(base, directory)
      return directory
    } catch (error) {
      remove(path)
      throw error
    }
  }

  #buildGeneration(folder, signature, entries, contents) {
    const scratch = fs.mkdtempSync(join(folder, '.build-'))
    try {
      for (const [index, { name, stat }] of entries.entries()) {
        const fd = fs.openSync(join(scratch, name), 'wx', 0o600)
        try {
          fs.writeFileSync(fd, contents[index])
          fs.fchmodSync(fd, Number(stat.mode & 0o755n))
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      }
      const path = join(folder, `g-${signature.slice(0, 12)}-${++this.#counter}`)
      fs.renameSync(scratch, path)
      return path
    } finally {
      remove(scratch)
    }
  }

  #prune(now) {
    for (const generation of this.#generations) {
      if (generation === this.#current || now - generation.lastUsed <= GRACE_MS) continue
      if (sameDirectory(generation.providerDirectory)) remove(generation.path)
      this.#generations.delete(generation)
    }
  }

  dispose({ now = Date.now, schedule = setTimeout } = {}) {
    this.#current = undefined
    this.#prune(now())
    for (const directory of this.#directories.values()) {
      const cleanup = () => {
        if (sameDirectory(directory)) remove(directory.path)
      }
      if ([...this.#generations].some(generation => generation.providerDirectory === directory)) {
        schedule(cleanup, GRACE_MS).unref()
      } else {
        cleanup()
      }
    }
  }
}

export default class AutomagikSandboxProvider extends LocalSandboxProvider {
  static Config = LocalSandboxProvider.Config

  constructor(ctx, config) {
    super(ctx, config)
    // Cordis traces service method receivers. Keep private state on an ordinary object.
    this[SSH_COPIES] = new SshConfigCopies(process.platform === 'linux' && !this.runnerCommand)
    ctx.effect(() => () => this[SSH_COPIES].dispose(this.internals.sshConfig))
  }

  runnerArgv(runner, policy) {
    const argv = super.runnerArgv(runner, policy)
    if (runner !== 'bwrap' || !['bwrap', '--ro-bind', '/', '/'].every((part, index) => argv[index] === part)) return argv
    try {
      const bind = this.sshConfigBind(policy)
      return bind ? [...argv, '--ro-bind', bind, SSH_CONFIG_D] : argv
    } catch (error) {
      this[SSH_COPIES].warnOnce(error, this.ctx.logger)
      return argv
    }
  }

  sshConfigBind(policy) {
    return this[SSH_COPIES].bind(policy, this.internals.sshConfig)
  }
}
