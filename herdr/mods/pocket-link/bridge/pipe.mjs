// The terminal stream has one half for each direction. The phone closes after it reads the end.
export const SESSION_END_WAIT = 30_000

export async function pipeSession({
  hc, conn, bi, rest, log, endWait = SESSION_END_WAIT, onClosed = () => {},
}) {
  const { stdin, stdout } = hc
  let ended = !stdin || stdin.destroyed || hc.exitCode !== null || hc.signalCode !== null
  let logged = false
  stdin?.on('error', e => {
    ended = true
    if (logged) return
    logged = true
    log('session: hc input closed:', e.code ?? e.message)
  })
  stdin?.on('close', () => { ended = true })

  let deadline
  let closed = false
  const connectionClosed = () => {
    if (closed) return
    closed = true
    clearTimeout(deadline)
    onClosed()
  }
  conn.closed().then(connectionClosed, connectionClosed)

  const childEnded = () => {
    ended = true
    if (closed || deadline) return
    // A phone that leaves the connection open can hold up either half of the stream.
    deadline = setTimeout(() => {
      try { conn.close(0n, [...Buffer.from('session ended')]) } catch {}
      connectionClosed()
    }, endWait).unref()
  }
  hc.on('exit', childEnded)
  hc.on('close', childEnded)

  let writing = Promise.resolve()
  stdout?.on('data', chunk => {
    stdout.pause()
    writing = writing.then(() => bi.send.writeAll([...chunk]))
      .then(() => stdout.resume(), () => hc.kill())
  })
  stdout?.on('error', () => hc.kill())
  hc.once('close', () => { writing.then(() => bi.send.finish()).catch(() => {}) })

  const canWrite = () => !ended && stdin.writable && !stdin.destroyed
  const stdinEvents = ['drain', 'close', 'error']
  const childEvents = ['exit', 'close']
  const waitDrain = () => new Promise(resolve => {
    const done = () => {
      for (const event of stdinEvents) stdin.off(event, done)
      for (const event of childEvents) hc.off(event, done)
      resolve()
    }
    for (const event of stdinEvents) stdin.on(event, done)
    for (const event of childEvents) hc.on(event, done)
  })

  if (rest.length && canWrite() && !stdin.write(Buffer.from(rest))) await waitDrain()
  while (canWrite()) {
    const data = await bi.recv.read(65536).catch(() => null)
    if (!data || data.length === 0 || !canWrite()) break
    if (!stdin.write(Buffer.from(data))) await waitDrain()
  }
  if (canWrite()) stdin.end()
}
