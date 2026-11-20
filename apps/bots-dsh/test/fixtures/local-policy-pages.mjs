export function probeUrl(origin, actor) {
  return `${origin}/probe?actor=${actor}`
}

export function socketUrl(origin, actor) {
  return `${origin.replace('http:', 'ws:')}/socket?actor=${actor}`
}

function runProbe(actor, { own, dev }, report, sockets) {
  const fetched = async origin => {
    try { return (await fetch(probeUrl(origin, actor))).ok } catch { return false }
  }
  const connected = origin => new Promise(resolve => {
    const socket = new WebSocket(socketUrl(origin, actor))
    socket.onopen = () => { resolve(true); socket.close() }
    socket.onerror = socket.onclose = () => resolve(false)
    // A refused socket never opens; Playwright's page-side mock does not always report its close.
    setTimeout(() => resolve(false), 3000)
  })
  Promise.all([fetched(own), fetched(dev)]).then(([own, dev]) => report({ actor, kind: 'fetch', own, dev }))
  if (sockets) {
    Promise.all([connected(own), connected(dev)]).then(([own, dev]) => report({ actor, kind: 'socket', own, dev }))
  }
}

function main(urls) {
  window.outcomes = []
  window.addEventListener('message', ({ data }) => window.outcomes.push(data))
  window.startProbes = () => {
    const report = data => window.postMessage(data, location.origin)
    runProbe('page', urls, report, true)

    const worker = new Worker('/worker')
    worker.onmessage = ({ data }) => report(data)
    worker.postMessage(urls)

    const frame = document.createElement('iframe')
    frame.src = `${urls.frame}/frame`
    document.body.append(frame)

    for (const side of ['own', 'dev']) window.open(`/navigate?side=${side}`)
  }
}

function frame(urls) {
  runProbe('frame', urls, data => parent.postMessage(data, urls.dev), true)
  const child = document.createElement('iframe')
  child.src = probeUrl(urls.own, 'child')
  document.body.append(child)
}

const script = (...functions) => functions.map(fn => fn.toString()).join('\n')
const probeScript = script(probeUrl, socketUrl, runProbe)
const html = source => `<!doctype html><title>Browser policy test</title><body><script>${source}</script>`

export function devPage(url, urls) {
  const { pathname, searchParams } = url
  if (pathname === '/') return html(`${probeScript}\n(${main})(${JSON.stringify(urls)})`)
  if (pathname === '/frame') return html(`${probeScript}\n(${frame})(${JSON.stringify(urls)})`)
  if (pathname === '/navigate') {
    const side = searchParams.get('side')
    return html(`location.assign(${JSON.stringify(probeUrl(urls[side], 'top'))})`)
  }
  return probePage(url, 'dev', urls.dev)
}

export function probePage(url, side, dev) {
  if (url.searchParams.get('actor') !== 'top') return 'ok'
  const outcome = { actor: 'top', kind: 'navigation', side, succeeded: true }
  return html(`opener.postMessage(${JSON.stringify(outcome)}, ${JSON.stringify(dev)})`)
}

export const workerScript = `${probeScript}\nonmessage = ({ data }) => runProbe('worker', data, result => postMessage(result), false)`
