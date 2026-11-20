import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { runChild, tracing, windowsPath } from '../bw/run.js'
import { endpointOf, validToken } from './parse.js'

function resolveVault({ platform, env, exists }) {
  if (platform !== 'win32') return { file: 'vault', prefix: [] }
  const file = windowsPath(env).map(dir => win32.join(dir, 'vault.exe')).find(exists)
  if (file !== undefined) return { file, prefix: [] }
}

export async function runVault(args, { credential, signal, timeout = 10000 } = {}, options = {}) {
  if (signal?.aborted) return { failure: 'cancelled' }
  const version = args.length === 1 && args[0] === 'version'
  if (tracing() || (!version && (!endpointOf(credential?.address, credential?.namespace) || !validToken(credential?.token)))) {
    return { failure: 'refused' }
  }
  const { platform = process.platform, scratch = tmpdir() } = options
  let dir
  let result
  try {
    dir = mkdtempSync(join(scratch, 'vault-cli-'))
    const home = join(dir, 'home')
    const allowed = platform === 'win32' ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'] : ['PATH']
    const cleanEnv = parent => {
      const env = Object.fromEntries(Object.entries(parent)
        .map(([key, value]) => [platform === 'win32' ? key.toUpperCase() : key, value])
        .filter(([key]) => allowed.includes(key)))
      return { ...env, HOME: home, USERPROFILE: home, TMPDIR: dir, LANG: 'C',
        VAULT_DISABLE_REDIRECTS: 'true', VAULT_CLI_NO_COLOR: '1', VAULT_MAX_RETRIES: '0' }
    }
    result = await runChild(args, { signal, timeout }, options, cleanEnv, resolveVault, version ? {} : {
      VAULT_ADDR: credential.address, VAULT_TOKEN: credential.token,
      ...(credential.namespace ? { VAULT_NAMESPACE: credential.namespace } : {}),
    })
  } catch {
    result = { failure: 'unavailable' }
  }
  try {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  } catch {
    return { failure: 'unavailable' }
  }
  return result
}
