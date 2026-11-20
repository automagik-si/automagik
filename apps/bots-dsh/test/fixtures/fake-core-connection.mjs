import { Worker } from 'node:worker_threads'
import { CoreConnection } from '../../src/host/code-core.js'

/** Run the framed fake over a worker's streams for tests that do not exercise the socket probe. */
export async function connectFakeCore({ env }) {
  const fake = new URL('./fake-hc-core.mjs', import.meta.url)
  const child = new Worker(fake, { env, execArgv: [], stdin: true, stdout: true, stderr: true })
  child.kill = () => { void child.terminate() }
  const core = new CoreConnection(child)
  try {
    await core.start()
    return core
  } catch (error) {
    core.close()
    throw error
  }
}
