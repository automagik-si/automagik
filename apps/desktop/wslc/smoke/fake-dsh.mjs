#!/usr/bin/env node
// A stand-in for DSH that speaks DSH's side of the launcher's contract: the same argv
// (`--profile omni ... --host 127.0.0.1 --port <n>`), the `dsh web:` launch line on stdout once
// it listens, and the IPC channel. The launcher's tests and the CI smoke start it through
// DSH_LAUNCH_BIN; it is mounted into the container for the smoke and never built into the image.
// It answers scripted IPC messages:
//   smoke:echo {payload}       -> smoke:echoed {payload}        (the relay, Electron to DSH and back)
//   smoke:endpoint {botId}     -> the Bot team's own request, ds-bot:browser-endpoint (bots-dsh
//                                 browser-plugins.js appBrowserEndpoint), then a TCP connection to
//                                 the URL it is given: it writes "hello <token>\n" and reports the
//                                 line that comes back as smoke:endpoint-result {url, reply}
//   smoke:open {url}           -> runs `xdg-open <url>`, reports smoke:open-result {url, code}
//   smoke:env                  -> smoke:env {BROWSER, AUTOMAGIK_OPEN_SOCKET, PATH, argv, pid}
// FAKE_DSH_IGNORE_TERM=1 makes it ignore SIGTERM, so the launcher has to SIGKILL it.
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'

const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1])
const host = argv[argv.indexOf('--host') + 1]
const token = randomBytes(16).toString('hex')

const server = createServer((_request, response) => response.end('fake dsh\n'))
server.on('error', (error) => {
  // As DSH's listener says it (dsh.js listenFailed reads this line).
  console.error(`Error: listen ${error.code}: address already in use ${host}:${port}`)
  process.exit(1)
})
server.listen(port, host, () => {
  console.log(`fake-dsh: up, argv ${argv.join(' ')}`)
  console.log(`dsh web: http://${host}:${port}/?token=${token}`)
})

process.on('SIGTERM', () => {
  console.error('fake-dsh: SIGTERM')
  if (process.env.FAKE_DSH_IGNORE_TERM === '1') return
  server.close()
  process.exit(0)
})

function endpoint(botId) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The app browser relay did not respond.')), 10_000)
    const receive = (message) => {
      if (message?.type !== 'ds-bot:browser-endpoint-response' || message.id !== id) return
      clearTimeout(timer)
      process.off('message', receive)
      if (typeof message.url === 'string') resolve(message.url)
      else reject(new Error(message.error || 'The app browser relay is unavailable.'))
    }
    process.on('message', receive)
    process.send({ type: 'ds-bot:browser-endpoint', id, botId, downloadRoots: ['/home/automagik/Downloads'] })
  })
}

function roundTrip(url) {
  const { hostname, port: target, pathname } = new URL(url)
  const tokenOf = pathname.split('/').at(-1)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(target), hostname)
    let text = ''
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('no answer through the tunnel')) })
    socket.on('connect', () => socket.write(`hello ${tokenOf}\n`))
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8')
      if (!text.includes('\n')) return
      socket.end()
      resolve(text.slice(0, text.indexOf('\n')))
    })
    socket.on('error', reject)
  })
}

process.on('message', async (message) => {
  if (message?.type === 'smoke:echo') return process.send({ type: 'smoke:echoed', payload: message.payload })
  if (message?.type === 'smoke:env') {
    const { BROWSER, AUTOMAGIK_OPEN_SOCKET, PATH } = process.env
    return process.send({ type: 'smoke:env', BROWSER, AUTOMAGIK_OPEN_SOCKET, PATH, argv, pid: process.pid })
  }
  if (message?.type === 'smoke:endpoint') {
    try {
      const url = await endpoint(message.botId)
      const reply = await roundTrip(url)
      process.send({ type: 'smoke:endpoint-result', url, reply })
    } catch (error) {
      process.send({ type: 'smoke:endpoint-result', error: error.message })
    }
    return
  }
  if (message?.type === 'smoke:open') {
    execFile('xdg-open', [message.url], (error, _stdout, stderr) => {
      process.send({ type: 'smoke:open-result', url: message.url, code: error ? error.code ?? 1 : 0, stderr })
    })
  }
})
