export const namespace = '/_automagik'
export const reserved = path => path === namespace || path.startsWith(namespace + '/')
const marker = Symbol.for('automagik.multiuser-dsh.reservation')

function httpRefusal(status) {
  return { kind: 'prefix', path: namespace, handler(_req, res) {
    res.writeHead(status, { 'content-length': '0' })
    res.end()
  } }
}

function refuseUpgrade(socket, status) {
  const destroy = () => socket.destroy()
  const timer = setTimeout(destroy, 1000).unref()
  socket.once('close', () => clearTimeout(timer))
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, destroy)
}

function register(table, route) {
  const { path } = route
  if (!reserved(path) || table.has(path)) throw new Error(`multiuser-dsh: invalid or duplicate reserved route ${path}`)
  table.set(path, route)
  return () => {
    if (table.get(path) === route) table.delete(path)
  }
}

function matchOwner({ exact, prefixes }, pathname) {
  const route = exact.get(pathname)
  if (route) return route
  let best
  for (const [prefix, candidate] of prefixes) {
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
    if (!best || prefix.length > best.path.length) best = candidate
  }
  return best
}

export function reservationOf(webServer) {
  if (Object.hasOwn(webServer, marker)) return webServer[marker]
  let live
  const refusals = new Set()
  const missing = httpRefusal(404)
  const unavailable = httpRefusal(503)
  const reservation = {
    claim({ active = () => true, admitUpgrade }) {
      if (live) return undefined
      const owner = { exact: new Map(), prefixes: new Map(), upgrades: new Map(), active, admitUpgrade }
      live = owner
      return {
        live: () => live === owner && owner.active(),
        register(route) {
          if (route.kind === 'exact') return register(owner.exact, route)
          if (route.kind === 'prefix') return register(owner.prefixes, route)
          throw new Error('multiuser-dsh: invalid reserved route kind')
        },
        registerUpgrade(route) {
          return register(owner.upgrades, route)
        },
        release() {
          owner.exact.clear()
          owner.prefixes.clear()
          owner.upgrades.clear()
          if (live === owner) live = undefined
        },
      }
    },
    refuse() {
      const token = Symbol()
      refusals.add(token)
      return () => { refusals.delete(token) }
    },
  }

  const original = webServer.match
  webServer.match = function (pathname) {
    if (!reserved(pathname)) return original.call(this, pathname)
    const owner = live
    if (!owner) return refusals.size ? missing : unavailable
    const route = matchOwner(owner, pathname)
    if (!route) return owner.active() ? missing : unavailable
    const { kind, path } = route
    const table = kind === 'exact' ? owner.exact : owner.prefixes
    return { kind, path, handler(req, res) {
      if (live !== owner || table.get(path) !== route || !owner.active()) return unavailable.handler(req, res)
      return route.handler(req, res)
    } }
  }
  webServer.upgrades.get = function (path) {
    if (typeof path !== 'string' || !reserved(path)) return Map.prototype.get.call(this, path)
    const owner = live
    const route = owner?.upgrades.get(path)
    return { path, handler(req, socket, head) {
      if (!route || live !== owner || owner.upgrades.get(path) !== route || !owner.active()) return refuseUpgrade(socket, '503 Service Unavailable')
      if (!owner.admitUpgrade()) return refuseUpgrade(socket, '401 Unauthorized')
      return route.handler(req, socket, head)
    } }
  }
  Object.defineProperty(webServer, marker, { value: reservation })
  return reservation
}
