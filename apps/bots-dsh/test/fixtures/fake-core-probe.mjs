import { createServer } from 'node:net'
import { join } from 'node:path'

export function listenForCoreStatus(t, path) {
  const requests = []
  const server = createServer((socket) => {
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      text += chunk
      const end = text.indexOf('\n')
      if (end === -1) return
      const request = JSON.parse(text.slice(0, end))
      requests.push(request)
      if (request.method === 'server.status') {
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { core: { id: 'core-test' } } }) + '\n')
      }
    })
  })
  const ready = new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve))
  const close = () => new Promise(resolve => server.close(() => resolve()))
  t.after(close)
  return { ready, close, requests }
}

export function coreProbeFixture(t, root) {
  const path = join(root, 'core.sock')
  const { ready } = listenForCoreStatus(t, path)
  // Most existing callers build their fixtures synchronously. Unix listen binds immediately.
  ready.catch(error => t.diagnostic(String(error)))
  return {
    AUTOMAGIK_HERDR_TEST_ROOTS: root,
    AUTOMAGIK_HERDR_CORE_SOCKET: path,
    HC_SOCKET: '',
  }
}
