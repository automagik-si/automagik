import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './child.js'
import { isVersion } from './records.js'
import { directory, identity, regularBytes, writeBytesAtomic } from './store.js'

export const SUPERVISOR_FILES = Object.freeze([
  'bounded-get.js', 'lane-verify.js', 'role-keys.json',
  'supervisor/child.js', 'supervisor/copy.js', 'supervisor/main.js', 'supervisor/records.js',
  'supervisor/release.js', 'supervisor/request.js', 'supervisor/stage.js', 'supervisor/store.js',
  'supervisor/switch.js',
])

const DEFAULT_HOST = fileURLToPath(new URL('../', import.meta.url))
const LAUNCHER = 'launcher.sh'
const VERSION = 'version.json'
export const MAIN = 'supervisor/main.js'

export function copyVersion(root = DEFAULT_HOST) {
  const { version } = JSON.parse(regularBytes(join(root, VERSION)))
  if (!isVersion(version)) throw new Error('Invalid supervisor copy version')
  return version
}

export async function checkCopy(root, signal) {
  copyVersion(root)
  await runCommand(process.execPath, [join(root, MAIN), '--self-check'], { signal, timeout: 10_000 })
}

async function publishCopy(store, host, version, signal, bootstrap) {
  if (!isVersion(version)) throw new Error('Invalid supervisor package version')
  const root = directory(join(store, 'supervisor'))
  const next = join(root, 'next')
  const current = join(root, 'current')
  const kept = join(root, 'kept')
  if (bootstrap && (identity(current) || identity(kept))) throw new Error('A supervisor copy already exists')
  fs.rmSync(next, { recursive: true, force: true })
  directory(next)
  directory(join(next, 'supervisor'))
  try {
    for (const file of SUPERVISOR_FILES) {
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
        fs.rmSync(kept, { recursive: true, force: true })
        fs.renameSync(current, kept)
      } else {
        // The launcher may have selected kept. Preserve that copy through this rotation.
        fs.rmSync(current, { recursive: true, force: true })
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

export async function refreshCopy(store, profileDir, expected, signal) {
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
  await publishCopy(store, join(dirname(manifest), 'src', 'host'), version, signal, false)
}
