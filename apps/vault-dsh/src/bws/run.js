import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBws, runSensitive } from '../bw/run.js'

export function normalizeServer(input) {
  if (input === 'us' || input === 'eu') return input
  if (typeof input !== 'string' || input.length > 512 || !/^https:\/\//i.test(input) || /[\s\p{Cc}"\\?#]/u.test(input)) return undefined
  try {
    const url = new URL(input)
    if (url.username || url.password || url.protocol !== 'https:' || input.slice(8).split('/')[0].includes('@')) return undefined
    const normalized = url.origin + url.pathname.replace(/\/+$/, '')
    return normalized.length <= 512 ? normalized : undefined
  } catch { return undefined }
}

function configFor(server) {
  const region = server === 'us' ? 'com' : 'eu'
  const settings = server === 'us' || server === 'eu'
    ? `server_api = "https://api.bitwarden.${region}"\nserver_identity = "https://identity.bitwarden.${region}"`
    : `server_base = ${JSON.stringify(server)}`
  return `[profiles.automagik]\n${settings}\nstate_opt_out = "true"\n`
}

export async function runBws(args, { token, server = 'us', launch, ...limits } = {}, options = {}) {
  const version = args.length === 1 && args[0] === '--version'
  if ((!version && token === undefined) || normalizeServer(server) !== server) return { failure: 'refused' }
  let dir
  let result
  try {
    dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'automagik-bws-'))
    const file = join(dir, 'config.toml')
    await writeFile(file, configFor(server), { mode: 0o600, flag: 'wx' })
    result = await runSensitive(['--config-file', file, '--profile', 'automagik',
      ...(version ? args : ['--output', 'json', '--color', 'no', ...args])], {
      ...limits, sensitive: !version, credentials: version ? {} : { BWS_ACCESS_TOKEN: token },
    }, context => {
      launch ??= (options.resolveHelper ?? resolveBws)(context)
      return launch
    }, options)
  } catch {
    result = { failure: 'unavailable' }
  } finally {
    if (dir !== undefined) {
      try { await rm(dir, { recursive: true, force: true }) }
      catch { result = { failure: 'unavailable' } }
    }
  }
  return version && launch !== undefined ? { ...result, launch } : result
}
