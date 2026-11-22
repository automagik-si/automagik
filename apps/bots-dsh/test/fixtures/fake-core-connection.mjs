import childProcesses from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { Worker } from 'node:worker_threads'
import { CoreConnection } from '../../src/host/code-core.js'

function pipeWorker(fake, env, argv = []) {
  const child = new Worker(fake, { env, argv, execArgv: [], stdin: true, stdout: true, stderr: true })
  child.kill = () => { void child.terminate() }
  return child
}

/** Run the framed fake over a worker's streams for tests that do not exercise the socket probe. */
export async function connectFakeCore({ env }) {
  const core = new CoreConnection(pipeWorker(new URL('./fake-hc-core.mjs', import.meta.url), env))
  try {
    await core.start()
    return core
  } catch (error) {
    core.close()
    throw error
  }
}

/** Keep both hc protocols on fake streams where the sandbox cannot keep child stdio open. */
export function pipeHcThroughWorker(t, ...commands) {
  const mock = t.mock.method(childProcesses, 'spawn', (command, args, { env }) => {
    if (!commands.includes(command) || args[0] !== 'connect') throw new Error('unexpected subprocess: ' + command)
    return pipeWorker(command, env, args)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}
