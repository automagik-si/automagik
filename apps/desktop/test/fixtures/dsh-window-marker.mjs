import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once, EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { app, BrowserWindow } from 'electron'
import { dshWindowMarker } from '../../src/dsh.js'

const serve = async () => {
  const requests = []
  const server = createServer((request, response) => {
    if (request.url === '/') return response.end('<!doctype html><title>Fixture DSH</title>')
    requests.push(request.headers['x-automagik-window'])
    response.setHeader('access-control-allow-origin', '*')
    if (request.url.startsWith('/api/omni-ui/code/stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      return response.end('data: fixture\n\n')
    }
    response.end('ok')
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() }
}

app.whenReady().then(async () => {
  const local = await serve()
  const elsewhere = await serve()
  const page = new BrowserWindow({ show: false })
  const other = new BrowserWindow({ show: false })
  try {
    const marker = dshWindowMarker()
    const pending = marker.start()
    marker.bind(page.webContents)
    await page.loadURL(local.origin)
    await other.loadURL(local.origin)
    await page.webContents.executeJavaScript("fetch('/api/omni-ui', { method: 'POST' }).then(response => response.text())")
    assert.deepEqual(local.requests, [undefined], 'no mark before the child serves')
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
    pending.ready({ child, url: local.origin }, local.origin)
    await page.webContents.executeJavaScript("fetch('/api/omni-ui', { method: 'POST' }).then(response => response.text())")
    await page.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const sse = new EventSource('/api/omni-ui/code/stream');
      sse.onmessage = ({ data }) => { sse.close(); resolve(data); };
      sse.onerror = () => { sse.close(); reject(new Error('fixture stream failed')); };
    })`)
    const [, markerForFetch, markerForStream] = local.requests
    assert.match(markerForFetch, /^[0-9a-f]{64}$/)
    assert.equal(markerForStream, markerForFetch)
    assert.equal(createHash('sha256').update(markerForFetch, 'ascii').digest('hex'), pending.digest)
    await other.webContents.executeJavaScript("fetch('/api/omni-ui').then(response => response.text())")
    await fetch(local.origin + '/api/omni-ui')
    assert.deepEqual(local.requests.slice(3), [undefined, undefined])
    await page.webContents.executeJavaScript(`fetch(${JSON.stringify(elsewhere.origin + '/api/omni-ui')}).then(response => response.text())`)
    assert.deepEqual(elsewhere.requests, [undefined])
  } finally {
    page.destroy()
    other.destroy()
    local.close()
    elsewhere.close()
  }
  app.exit(0)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
