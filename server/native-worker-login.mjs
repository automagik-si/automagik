import { join } from 'node:path'

// The pilot image's one pointer export: it names the ACP current/ directory through a vendor
// pointer, and the reader derives each vendor's pointer as dirname(value)/<vendor>. The
// marker says a launch must carry a valid pointer and record. It is not auth and reads
// nothing; unset leaves today's behaviour.
export const BOT_CLI_POINTER_ENV = 'AUTOMAGIK_BOT_CLI_POINTER'
export const NATIVE_WORKER_LOGIN_ENV = 'AUTOMAGIK_NATIVE_WORKER_LOGIN'
export const NATIVE_WORKER_LOGIN_REQUIRED = 'required'

export function nativeWorkerEnv(env, home = env.AUTOMAGIK_HOME || '/data') {
  env[BOT_CLI_POINTER_ENV] = join(home, 'acp', 'cli-homes', 'current', 'claude')
  env[NATIVE_WORKER_LOGIN_ENV] = NATIVE_WORKER_LOGIN_REQUIRED
  return env
}
