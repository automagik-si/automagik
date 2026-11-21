import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCommand } from './child.js'
import { isVersion } from './records.js'
import { directory, identity, regularBytes, sameEntry, writeBytesAtomic } from './store.js'

const DEFAULT_HOST = resolve(fileURLToPath(new URL('../', import.meta.url)))
const LAUNCHER = 'launcher.sh'
const VERSION = 'version.json'
const INVENTORY = 'supervisor/files.json'
const DEFAULT_INVENTORY = new URL('./files.json', import.meta.url)
export const MAIN = 'supervisor/main.js'
export const SELF_CHECK_OK = 'automagik-supervisor-ok'

function inventory(root) {
  const files = JSON.parse(regularBytes(root === DEFAULT_HOST ? fileURLToPath(DEFAULT_INVENTORY) : join(root, INVENTORY)))
  if (!Array.isArray(files) || !files.includes(MAIN) || !files.includes(INVENTORY)
    || new Set(files).size !== files.length
    || !files.every(file => typeof file === 'string' && /^(?:[\w-]+\/)*[\w-]+\.(?:js|json)$/.test(file)
      && !['package.json', VERSION].includes(file))) throw new Error('Invalid supervisor file inventory')
  return files
}

export const SUPERVISOR_FILES = Object.freeze(inventory(DEFAULT_HOST))

export function copyVersion(root = DEFAULT_HOST) {
  const { version } = JSON.parse(regularBytes(join(root, VERSION)))
  if (!isVersion(version)) throw new Error('Invalid supervisor copy version')
  return version
}

export function supervisorVersion(root = DEFAULT_HOST) {
  for (const file of inventory(root)) regularBytes(join(root, file))
  if (identity(join(root, 'package.json'))) {
    if (JSON.parse(regularBytes(join(root, 'package.json'))).type !== 'module') throw new Error('Invalid supervisor module metadata')
    return copyVersion(root)
  }
  const { version } = JSON.parse(regularBytes(join(root, '../../package.json')))
  if (!isVersion(version)) throw new Error('Invalid supervisor package version')
  return version
}

export async function checkCopy(root, signal) {
  copyVersion(root)
  const marker = await readCommand(process.execPath, [join(root, MAIN), '--self-check'], { signal })
  if (marker !== SELF_CHECK_OK) throw new Error('Supervisor self-check result is missing')
}

export function runningCopy(store, host = DEFAULT_HOST) {
  const root = join(store, 'supervisor')
  const saved = join(root, 'running')
  const entry = dirname(host) === root ? identity(host) : undefined
  const owns = path => sameEntry(entry, identity(path))
  return {
    owns,
    prune() { if (!owns(saved)) fs.rmSync(saved, { recursive: true, force: true }) },
    release() { if (owns(saved)) fs.rmSync(saved, { recursive: true, force: true }) },
  }
}

function retireCopy(path, root, executing) {
  if (executing?.owns(path)) {
    const saved = join(root, 'running')
    fs.rmSync(saved, { recursive: true, force: true })
    fs.renameSync(path, saved)
  } else {
    fs.rmSync(path, { recursive: true, force: true })
  }
}

async function publishCopy(store, host, version, signal, bootstrap, executing) {
  if (!isVersion(version)) throw new Error('Invalid supervisor package version')
  const root = directory(join(store, 'supervisor'))
  const next = join(root, 'next')
  const current = join(root, 'current')
  const kept = join(root, 'kept')
  if (bootstrap && (identity(current) || identity(kept))) throw new Error('A supervisor copy already exists')
  fs.rmSync(next, { recursive: true, force: true })
  directory(next)
  try {
    for (const file of inventory(host)) {
      fs.mkdirSync(dirname(join(next, file)), { recursive: true, mode: 0o700 })
      fs.writeFileSync(join(next, file), regularBytes(join(host, file)), { mode: 0o600, flag: 'wx' })
    }
    // Node 22.7 predates default ESM syntax detection on some supported hosts.
    writeBytesAtomic(join(next, 'package.json'), '{"type":"module"}\n')
    writeBytesAtomic(join(next, VERSION), JSON.stringify({ version }) + '\n')
    await checkCopy(next, signal)
    if (identity(current)) {
      let checked = false
      try { await checkCopy(current, signal); checked = true } catch { signal?.throwIfAborted() }
      if (checked) {
        retireCopy(kept, root, executing)
        fs.renameSync(current, kept)
      } else {
        // The launcher may have selected kept. Preserve that copy through this rotation.
        retireCopy(current, root, executing)
      }
    }
    fs.renameSync(next, current)
  } finally {
    fs.rmSync(next, { recursive: true, force: true })
  }
}

export async function installCopy(store, host = DEFAULT_HOST, signal) {
  const { version } = JSON.parse(regularBytes(join(host, '../../package.json')))
  const launcher = regularBytes(join(host, 'supervisor', LAUNCHER))
  const root = directory(join(store, 'supervisor'))
  const path = join(root, LAUNCHER)
  // The launcher is fixed at bootstrap. A later release only rotates the JS copies.
  if (identity(path)) {
    if (!regularBytes(path).equals(launcher)) throw new Error('A different fixed launcher already exists')
  } else {
    writeBytesAtomic(path, launcher, { exclusive: true })
  }
  fs.chmodSync(path, 0o700)
  await publishCopy(store, host, version, signal, true)
  return path
}

export async function refreshCopy(store, profileDir, expected, signal, executing) {
  const bot = join(profileDir, 'node_modules', '@automagik', 'bots-dsh')
  const manifest = join(bot, 'package.json')
  const { version } = JSON.parse(regularBytes(manifest))
  if (version !== expected) throw new Error('Installed supervisor version changed')
  const current = join(store, 'supervisor', 'current')
  try {
    if (copyVersion(current) === version) {
      await checkCopy(current, signal)
      return
    }
  } catch { signal?.throwIfAborted() }
  await publishCopy(store, join(dirname(manifest), 'src', 'host'), version, signal, false, executing)
}
