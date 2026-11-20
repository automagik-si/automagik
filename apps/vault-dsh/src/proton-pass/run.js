import { win32 } from 'node:path'
import { runChild, windowsPath } from '../bw/run.js'

function resolvePass({ platform, env, exists }) {
  if (platform !== 'win32') return { file: 'pass-cli', prefix: [] }
  const file = windowsPath(env).map(dir => win32.join(dir, 'pass-cli.exe')).find(exists)
  if (file !== undefined) return { file, prefix: [] }
}

export function runPass(args, { record, token, timeout, limit = timeout, signal } = {}, options) {
  const version = args.length === 1 && args[0] === '--version'
  const login = args.length === 1 && args[0] === 'login'
  if ((!version && record?.key === undefined) || (login && token === undefined)) return Promise.resolve({ failure: 'refused' })
  const windows = (options?.platform ?? process.platform) === 'win32'
  const inherited = windows ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'] : ['PATH']
  const cleanEnv = parent => {
    const entries = Object.entries(parent).map(([name, value]) => [windows ? name.toUpperCase() : name, value])
    const env = Object.fromEntries(entries.filter(([name]) => inherited.includes(name)))
    Object.assign(env, {
      LANG: 'C', NO_COLOR: '1', PROTON_PASS_NO_UPDATE_CHECK: '1', PROTON_PASS_DISABLE_TELEMETRY: '1',
      PROTON_PASS_KEY_PROVIDER: 'env',
    })
    if (record !== undefined) Object.assign(env, {
      HOME: record.home, USERPROFILE: record.home, TMPDIR: record.home, TEMP: record.home, TMP: record.home,
      PROTON_PASS_SESSION_DIR: record.dir,
    })
    return env
  }
  return runChild(args, { timeout: Math.min(timeout, limit), signal }, options, cleanEnv, resolvePass, {
    ...(version ? {} : { PROTON_PASS_ENCRYPTION_KEY: record.key }),
    ...(login ? { PROTON_PASS_PERSONAL_ACCESS_TOKEN: token } : {}),
  })
}
