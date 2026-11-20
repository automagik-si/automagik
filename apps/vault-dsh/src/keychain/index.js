import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isFile, resolveExecutable, runSensitive } from '../bw/run.js'
import { resolvePowerShell, WINDOWS_BLOB_BYTES, windowsCommand } from './windows.js'

const prefix = 'automagik-vault:v1:'
const provider = 'bitwarden-secrets'
const itemId = /^automagik-vault:v1:[a-f0-9]{32}$/
const asciiBlob = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
export const validBlob = value => typeof value === 'string' && value.length > 0
  && value.length <= WINDOWS_BLOB_BYTES && asciiBlob.test(value)
const unavailable = () => ({ ok: false, code: 'keychain' })
const absent = { ok: true }
const present = { ok: true, present: true }
const clearFailed = { ok: false, code: 'clear' }
const success = result => result.code === 0 && result.stderr === ''
const missingMacItem = /^security: (?:SecKeychainSearchCopyNext|SecKeychainItemDelete): The specified item could not be found in the keychain\.$/

export function keychainIdentity(ctx) {
  try {
    // DSH's launcher provides the active profile's directory, including for Desktop.
    const dir = ctx.get?.('profileContext')?.dir
    if (typeof dir !== 'string' || !dir) return undefined
    const profile = realpathSync(dir)
    return {
      item: connection => prefix + createHash('sha256')
        .update(JSON.stringify({ profile, provider, connection })).digest('hex').slice(0, 32),
    }
  } catch { return undefined }
}

function macCommand(operation, id, blob, keychainFile) {
  const identity = ['-s', id, '-a', id]
  const words = operation === 'store' ? ['add-generic-password', '-U', ...identity, '-w', blob]
    : operation === 'lookup' ? ['find-generic-password', ...identity, '-w']
      : operation === 'exists' ? ['find-generic-password', ...identity] : ['delete-generic-password', ...identity]
  if (keychainFile !== undefined) {
    if (!isAbsolute(keychainFile) || /["\\\p{Cc}]/u.test(keychainFile)) return undefined
    words.push('"' + keychainFile + '"')
  }
  const stdin = words.join(' ') + '\n'
  if (words.length > 32 || Buffer.byteLength(stdin) >= 4096) return undefined
  return { args: ['-i'], stdin }
}

const security = '/usr/bin/security'
const resolveSecurity = ({ exists }) => exists(security) ? { file: security, prefix: [] } : undefined
const resolveSecretTool = ({ env }) => {
  const file = resolveExecutable('secret-tool', env)
  if (file !== undefined) return { file, prefix: [] }
}

function linuxCommand(operation, id, blob) {
  const args = [operation, ...(operation === 'store' ? ['--label=Automagik Vault'] : operation === 'search' ? ['--all'] : []),
    'automagik-vault-item', id]
  return { args, stdin: blob }
}

function macOutcome(result, command) {
  if (result.failure !== undefined) return {}
  const output = result.stdout.replace(/\r?\n$/, '')
  const error = result.stderr.trimEnd()
  if (command !== undefined && !output && [0, 44].includes(result.code)) {
    const lines = error.split(/\r?\n/)
    if (lines.length === 2 && missingMacItem.test(lines[0])
      && lines[1] === command + ': returned -25300') return { missing: true }
  }
  if (result.code === 0) return { output, error }
  return {}
}

export function createKeychain({
  platform = process.platform, parent = process.env, exists = isFile, resolveHelper, testKeychainFile, ...options
} = {}) {
  const command = { darwin: macCommand, linux: linuxCommand, win32: windowsCommand }[platform]
  const resolve = resolveHelper ?? { darwin: resolveSecurity, linux: resolveSecretTool, win32: resolvePowerShell }[platform]
  const helper = () => resolve?.({ platform, env: parent, exists })
  const resolver = () => {
    const resolved = helper()
    return () => resolved
  }
  const raw = (resolve, operation, id, { signal, blob, onDispatch, stdoutPresence } = {}) => {
    const invocation = command?.(operation, id, blob, testKeychainFile)
    if (invocation === undefined) return Promise.resolve({ failure: 'refused' })
    return runSensitive(invocation.args, {
      stdin: invocation.stdin, signal, onDispatch, stdoutPresence, timeout: 4500, maxOutput: 8192,
    }, resolve, { ...options, platform, parent, exists })
  }
  async function lookup(resolve, id, { signal, presenceOnly = false, onDispatch } = {}) {
    if (!itemId.test(id)) return unavailable()
    const operation = presenceOnly && platform !== 'linux' ? 'exists' : 'lookup'
    const stdoutPresence = presenceOnly && platform === 'linux'
    const result = await raw(resolve, operation, id, { signal, onDispatch, stdoutPresence })
    // A lookup delivering enough stdout to hit the cap has already found the item.
    if (stdoutPresence && (result.code === 0 || result.failure === 'stdout-limit')) return present
    if (platform === 'darwin') {
      const { output, error, missing } = macOutcome(result, 'find-generic-password')
      if (missing) return absent
      if (error === '') {
        if (presenceOnly) return present
        if (validBlob(output)) return { ok: true, blob: output }
      }
    } else {
      if (success(result)) {
        if (presenceOnly) return present
        if (validBlob(result.stdout)) return { ok: true, blob: result.stdout }
      }
      if (platform === 'win32' && result.code === 10 && !result.stderr && !result.stdout) return absent
      // libsecret also exits 1 for non-text values. Search by attribute and discard its output.
      if (stdoutPresence && result.code === 1) {
        const search = await raw(resolve, 'search', id, { signal, stdoutPresence: true })
        if (success(search)) return search.hasStdout ? present : absent
      }
    }
    return unavailable()
  }
  return {
    get available() {
      return command !== undefined && helper() !== undefined
    },
    lookup: (id, signal) => lookup(resolver(), id, { signal }),
    async store(id, blob, signal) {
      if (!itemId.test(id) || !validBlob(blob)) return unavailable()
      const resolve = resolver()
      let dispatched = false
      const result = await raw(resolve, 'store', id, { signal, blob, onDispatch: () => { dispatched = true } })
      const mac = platform === 'darwin' ? macOutcome(result) : undefined
      const stored = mac === undefined ? success(result) && !result.stdout : mac.output === '' && mac.error === ''
      if (stored) return { ok: true, confirm: signal => lookup(resolve, id, { signal }) }
      // A helper that started may have written the credential before failing.
      return dispatched ? { ok: false, code: 'set', committed: true } : unavailable()
    },
    async clear(id, signal, onDispatch) {
      if (!itemId.test(id)) return clearFailed
      const resolve = resolver()
      const saved = await lookup(resolve, id, { signal, presenceOnly: true, onDispatch })
      if (!saved.ok) return saved
      if (!saved.present) return { ok: false, code: 'not-saved' }
      const result = await raw(resolve, 'clear', id, { signal })
      if (result.failure !== undefined || (platform === 'win32' && ![0, 10].includes(result.code))) return clearFailed
      if (platform === 'linux' && (![0, 1].includes(result.code) || result.stdout || result.stderr)) return clearFailed
      if (platform === 'darwin') {
        // security prints the deleted item's attributes on stdout. The runner bounds both streams.
        const { error, missing } = macOutcome(result, 'delete-generic-password')
        if (!missing && error !== 'password has been deleted.') return clearFailed
      }
      const checked = await lookup(resolve, id, { signal, presenceOnly: true })
      return checked.ok && !checked.present ? { ok: true } : clearFailed
    },
  }
}
