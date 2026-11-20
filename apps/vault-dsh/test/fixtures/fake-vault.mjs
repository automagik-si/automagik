import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

// Vault CLI's namespace.Canonicalize (the fake may run from a copy, so no import).
const canonicalNamespace = value => {
  let ns = value.trim()
  if (ns === '') return ''
  if (ns.startsWith('/')) ns = ns.slice(1)
  return ns.endsWith('/') ? ns : ns + '/'
}
const digest = (value, part) => createHash('sha256').update(part + ':' + value).digest('hex')
export const privateInputs = token => ({
  token,
  address: 'https://' + digest(token, 'address').slice(0, 20) + '.invalid',
  namespace: digest(token, 'namespace').slice(0, 20),
  mount: digest(token, 'mount').slice(0, 20),
  path: digest(token, 'path').slice(0, 20),
  field: digest(token, 'field').slice(0, 20),
  value: '  ' + digest(token, 'value') + '\n ç ',
})

async function main() {
  const dir = dirname(process.argv[1])
  const log = join(dir, 'calls')
  const stdout = text => writeSync(1, text + '\n')
  const stderr = text => writeSync(2, text + '\n')
  const args = process.argv.slice(2)
  const op = args[0] === 'version' ? 'version' : args[0] === 'list' ? 'list'
    : args.at(-1) === 'sys/internal/ui/mounts' ? 'connect'
      : args.at(-1)?.startsWith('sys/internal/ui/mounts/') ? 'preflight' : 'read'
  let valid = false
  try {
    const config = JSON.parse(readFileSync(join(dir, 'controls'), 'utf8'))
    const auth = op !== 'version'
    const env = process.env
    const keys = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'LANG', 'VAULT_DISABLE_REDIRECTS', 'VAULT_CLI_NO_COLOR', 'VAULT_MAX_RETRIES']
    if (auth) keys.push('VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_NAMESPACE')
    const paths = [env.HOME, env.USERPROFILE]
    valid = Object.keys(env).sort().join() === keys.sort().join()
      && paths.every(path => path === join(env.TMPDIR, 'home') && !existsSync(path))
      && (statSync(env.TMPDIR).mode & 0o777) === 0o700 && readdirSync(env.TMPDIR).length === 0
      && env.LANG === 'C' && env.VAULT_DISABLE_REDIRECTS === 'true' && env.VAULT_CLI_NO_COLOR === '1' && env.VAULT_MAX_RETRIES === '0'
    if (!auth) {
      valid &&= args.join() === 'version'
      if (valid) stdout(config.version ?? 'Vault v2.2.2 (build), built 2026-11-11T13:53:02Z')
      return
    }
    const input = privateInputs(env.VAULT_TOKEN)
    const base = input.mount + (config.v1 ? '' : '/metadata')
    const path = args.at(-1)
    const target = input.mount + (config.v1 ? '/' : '/data/') + input.path
    const mountPath = 'sys/internal/ui/mounts/' + input.mount
    valid &&= env.VAULT_ADDR === input.address && env.VAULT_NAMESPACE === canonicalNamespace(input.namespace)
      && digest(input.token, 'check') === config.check
      && args.length === 4 && args[1] === '-format=json' && args[2] === '--'
      && !args.some(arg => arg.includes(input.token) || arg.includes(input.value) || arg.includes(input.field))
      && (op === 'connect' ? path === 'sys/internal/ui/mounts' : op === 'preflight' ? path === mountPath
        : op === 'list' ? [base, base + '/folder'].includes(path) : path === target)
      && args[0] === (op === 'list' ? 'list' : 'read')
    if (!valid) return
    if (config.hang === op) {
      appendFileSync(log, op + ' start\n')
      await wait(60000)
    }
    if (config.cap === op) {
      const block = Buffer.alloc(16384, 'x')
      try {
        for (let bytes = 0; bytes < 5 * 1024 * 1024;) bytes += writeSync(1, block)
      } catch {}
      return
    }
    const failure = config.errors?.[op]
    if (failure) {
      process.exitCode = 2
      const prefix = (op === 'list' ? 'Error listing ' : 'Error reading ') + path
      if (failure === 'missing') stderr('No value found at ' + path)
      else if (failure === 'transport') stderr(prefix + ': Get "' + input.address + '": dial tcp: connection refused')
      else if (failure === 'unknown') stderr(prefix + ': diagnostic ' + input.value)
      else {
        const code = failure === '404' ? '404' : '403'
        stderr(prefix + ': Error making API request.\n\nNamespace: ' + canonicalNamespace(input.namespace)
          + '\nURL: GET ' + input.address + '/v1/' + path + '\nCode: ' + code + '. Errors:\n\n* '
          + (failure === 'auth' ? 'permission denied* invalid token' : failure === 'expired' ? 'token expired' : 'permission denied'))
      }
      return
    }
    if (op === 'connect') stdout(JSON.stringify({ data: { secret: {} } }))
    if (op === 'preflight') stdout(JSON.stringify({ data: {
      path: config.wrongMount ? input.mount + '/other/' : input.mount + '/',
      type: config.type ?? (config.v1 ? 'generic' : 'kv'),
      options: config.v1 ? {} : { version: config.engine ?? '2' },
    } }))
    if (op === 'list') stdout(JSON.stringify(path === base
      ? [input.path, 'folder/', '.', '..', 'nested/key', 'bad\0key', ...Array.from({ length: 51 }, (_, index) => 'key-' + index)]
      : ['nested']))
    if (op === 'read') {
      const data = {
        [input.field]: input.value + (config.rotate ? 'rotated' : ''),
        [' ' + input.field + ' ']: input.value + 'padded',
        request_id: input.value + 'request',
        lease_id: input.value + 'lease',
        data: input.value + 'data',
        nothing: null,
        numeric: 12,
      }
      Object.defineProperty(data, '__proto__', { value: input.value + 'own', enumerable: true })
      stdout(JSON.stringify({ request_id: 'envelope', lease_id: 'envelope', data: config.v1 ? data
        : config.deleted ? { data: null, metadata: { deletion_time: 'fixture' } } : { data, metadata: {} } }))
    }
  } catch {
    valid = false
  } finally {
    appendFileSync(log, op + (valid ? ' pass\n' : ' fail\n'))
    if (!valid) process.exitCode = 1
  }
}

if (basename(process.argv[1] ?? '') === 'vault') await main()
