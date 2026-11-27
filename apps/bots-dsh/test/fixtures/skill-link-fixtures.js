import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

export const revisionA = 'a'.repeat(40)
export const revisionB = 'b'.repeat(40)
export const publicAddress = '140.82.112.3'
export const directLink = 'https://automagik-si.example/link-notes/SKILL.md'
export const folderLink = 'https://github.com/automagik-si/automagik/tree/main/skills/link-folder'
export const publicResolver = async () => [{ address: publicAddress, family: 4 }]
export const skillMd = (content, name = 'link-notes', description = 'Write short notes.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${content}\n`

export function response(body, { status = 200, headers = {} } = {}) {
  return Object.assign(Readable.from([Buffer.from(body)], { objectMode: false }), { statusCode: status, headers })
}

export const json = body => response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
export const api = path => 'https://api.github.com/repos/automagik-si/automagik/' + path
export const ref = (name, sha) => ({ ref: 'refs/' + name, object: { type: 'commit', sha } })
export const tree = (sha, entries) => ({ sha, truncated: false, tree: entries })
const directory = (path, sha) => ({ path, sha, mode: '040000', type: 'tree' })

export function blob(path, data) {
  const bytes = Buffer.from(data)
  const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
  return { path, sha, size: bytes.length, mode: '100644', type: 'blob' }
}

export function folderRoutes(revision = revisionA, files = [['SKILL.md', skillMd('FOLDER-BODY-1', 'link-folder')]]) {
  const [root, parent, folder] = ['c', 'd', 'e'].map(char => char.repeat(40))
  const main = ref('heads/main', revision)
  const listing = api('git/trees/' + folder + '?recursive=1')
  const routes = new Map([
    [api('git/matching-refs/heads/main'), () => json([main])],
    [api('git/matching-refs/tags/main'), () => json([])],
    [api('git/ref/heads/main'), () => json(main)],
    [api('git/commits/' + revision), () => json({ sha: revision, tree: { sha: root } })],
    [api('git/trees/' + root), () => json(tree(root, [directory('skills', parent)]))],
    [api('git/trees/' + parent), () => json(tree(parent, [directory('link-folder', folder)]))],
    [listing, () => json(tree(folder, files.map(([name, data]) => blob(name, data))))],
  ])
  const raw = 'https://raw.githubusercontent.com/automagik-si/automagik/' + revision + '/skills/link-folder/'
  for (const [name, data] of files) routes.set(raw + name, () => response(data))
  return { routes, root, parent, folder, listing, raw }
}

export function fakeOpen(routes, requests = []) {
  return url => {
    requests.push(url.href)
    assert.ok(routes.has(url.href), 'Unexpected fake request ' + url.href)
    return routes.get(url.href)()
  }
}

export function fakeRequest(open, peer = publicAddress, written = () => {}) {
  return (url, options, onResponse) => {
    const request = new EventEmitter()
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: peer, remoteFamily: 'IPv4', destroy() { this.destroyed = true },
    })
    request.destroy = error => request.emit('error', error)
    request.end = () => queueMicrotask(() => {
      request.emit('socket', socket)
      socket.emit('connect')
      if (socket.destroyed) return
      written(options)
      onResponse(open(url))
    })
    return request
  }
}
