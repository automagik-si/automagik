import { createHash } from 'node:crypto'
import { readSkillArchive } from './skill-archive.js'
import { skillLinkHost } from './skill-address.js'
import { downloadArchiveKind, htmlType, linkCredentialCheck, refuseLink as refuse, skillLinkOperation } from './skill-fetch.js'
import { LIMITS, skillPath } from './skill-library-rules.js'
import { pathOrder, SKILL_MD, skippedPath, treeRegistry, treeText, validateSkillTree } from './skill-tree.js'

const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const shortRef = value => typeof value === 'string' && /^[^/\\\x00-\x20\x7f]{1,244}$/.test(value)
  && value !== '.' && value !== '..'
const validPart = part => !part.includes('/') && skillPath(part)
const mismatch = () => refuse('link-github-mismatch')
const large = () => refuse('link-github-large')
const pathError = () => refuse('link-github-path')
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const encoded = parts => parts.map(encodeURIComponent).join('/')

export function parseSkillLink(input) {
  if (typeof input !== 'string' || input.length > 2048) refuse('link-scheme')
  let url
  try { url = new URL(input) } catch { refuse('link-scheme') }
  if (url.protocol !== 'https:') refuse('link-scheme')
  linkCredentialCheck(url)
  if (url.port) refuse('link-port')
  const isRaw = url.hostname.replace(/\.$/, '') === 'raw.githubusercontent.com'
  const isWeb = /^(?:www\.)?github\.com\.?$/.test(url.hostname)
  let segments
  if (isRaw || isWeb) {
    // The URL parser removes dot segments and treats backslashes as slashes.
    const originalPath = input.replace(/[\t\r\n]/g, '').trim().split(/[?#]/, 1)[0]
    if (/\\|\/(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/i.test(originalPath)) pathError()
    try { segments = url.pathname.slice(1).split('/').map(decodeURIComponent) }
    catch { pathError() }
  }
  if (url.search && !(isWeb && segments[2] === 'blob' && ['?plain=1', '?raw=1'].includes(url.search))) {
    refuse('link-query')
  }
  url.search = ''
  url.hash = ''
  url.hostname = skillLinkHost(url.hostname)
  if (url.href.length > 2048) refuse('link-scheme')
  if (!segments) return { form: 'direct', url: url.href }
  if (isWeb) url.hostname = 'github.com'
  const [owner, repo, command, ...tail] = segments
  const repository = isWeb ? repo?.replace(/\.git$/, '') : repo
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !repository || !/^[A-Za-z0-9._-]{1,100}$/.test(repository)
    || repository === '.' || repository === '..') pathError()
  const root = isWeb && (command === undefined || command === '' && tail.length === 0)
  if (root) return { form: 'repo', url: url.href, owner, repository, path: [] }
  if (isWeb && !['tree', 'blob'].includes(command)) {
    refuse(['archive', 'releases'].includes(command) ? 'link-github-path' : 'link-page')
  }
  const [head, ...path] = isRaw ? segments.slice(2) : tail
  if (!shortRef(head) || !path.length || !path.every(validPart)) pathError()
  if (Buffer.byteLength(path.join('/')) > LIMITS.pathBytes) pathError()
  return { form: isWeb && command === 'tree' ? 'tree' : 'file', url: url.href, owner, repository, head, path }
}

export function validLinkSource(source) {
  const fields = ['kind', 'url', 'ref', 'revision', 'host', 'fetchedAt']
  if (!source || Object.keys(source).length !== fields.length || !fields.every(key => Object.hasOwn(source, key)) ||
      source.kind !== 'link' || typeof source.host !== 'string' ||
      !Number.isSafeInteger(source.fetchedAt) || source.fetchedAt < 0) return false
  let parsed
  try {
    parsed = parseSkillLink(source.url)
    if (skillLinkHost(source.host) !== source.host) return false
  } catch { return false }
  if (parsed.url !== source.url || parsed.path?.length > 10) return false
  const { ref, revision } = source
  if (parsed.form === 'direct') return ref === null && typeof revision === 'string' && /^sha256:[0-9a-f]{64}$/.test(revision)
  if (!sha(revision) || source.host !== 'raw.githubusercontent.com') return false
  if (parsed.form === 'repo') return ref === 'HEAD'
  if (sha(parsed.head)) return ref === parsed.head && revision === ref
  return ref === 'refs/heads/' + parsed.head || ref === 'refs/tags/' + parsed.head
}

export function githubApi(operation, link, update) {
  const root = 'https://api.github.com/repos/' + encoded([link.owner, link.repository]) + '/'
  const limit = update ? 14 : 15
  let calls = 0
  return async path => {
    if (++calls > limit) large()
    const { bytes, headers } = await operation.linkGet(new URL(path, root), {
      api: true, limit: 1024 * 1024, accept: 'application/vnd.github+json',
    })
    try { return { body: JSON.parse(bytes.toString('utf8')), headers } } catch { mismatch() }
  }
}

function refObject(row, expected) {
  if (row?.ref !== expected) refuse('link-ref')
  const object = row.object
  if (!sha(object?.sha) || !['commit', 'tag'].includes(object?.type)) refuse('link-ref')
  if (expected.startsWith('refs/heads/') && object.type !== 'commit') refuse('link-ref')
  return object
}

async function resolveGithubRef(link, get, storedRef) {
  const { form, head, path } = link
  if (form === 'repo') {
    const { body } = await get('commits/HEAD')
    if (!sha(body?.sha) || !sha(body.commit?.tree?.sha)) mismatch()
    return { ref: 'HEAD', revision: body.sha, root: body.commit.tree.sha }
  }
  if (sha(head)) return { ref: head, revision: head }
  let ref = storedRef
  let object
  if (ref) {
    const { body } = await get('git/ref/' + encoded(ref.split('/').slice(1)))
    object = refObject(body, ref)
  } else {
    const interpretations = new Map()
    const prefix = [head, ...path]
    for (const space of ['heads', 'tags']) {
      const match = 'refs/' + space + '/' + head
      const { body, headers } = await get('git/matching-refs/' + space + '/' + encodeURIComponent(head))
      if (/\brel\s*=\s*(?:"next"|next\b)/i.test(headers.link ?? '')) refuse('link-ref')
      if (!Array.isArray(body)) mismatch()
      for (const row of body) {
        const candidate = row?.ref
        if (typeof candidate !== 'string' || !candidate.startsWith(match)) mismatch()
        const target = candidate.slice(('refs/' + space + '/').length).split('/')
        if (target.every((part, index) => part === prefix[index])) {
          if (interpretations.has(candidate)) refuse('link-ref')
          interpretations.set(candidate, refObject(row, candidate))
        }
      }
    }
    if (!interpretations.size) refuse('link-missing')
    if (interpretations.size !== 1) refuse('link-ref')
    const [selected] = interpretations
    ref = selected[0]
    object = selected[1]
    if (!ref.endsWith('/' + head) || ref.split('/').length !== 3) refuse('link-ref')
  }
  if (object.type === 'tag') {
    const { body } = await get('git/tags/' + object.sha)
    if (body?.sha !== object.sha || body.object?.type !== 'commit' || !sha(body.object.sha)) refuse('link-ref')
    object = body.object
  }
  return { ref, revision: object.sha }
}

function treeRow(row) {
  if (!row || typeof row.path !== 'string' || !row.path || !sha(row.sha)) mismatch()
  const pair = row.mode + '/' + row.type
  if (pair === '040000/tree') return 'tree'
  if (pair === '100644/blob' || pair === '100755/blob') return 'file'
  return 'unsupported'
}

async function tree(get, id, recursive) {
  const { body } = await get('git/trees/' + id + (recursive ? '?recursive=1' : ''))
  if (body?.sha !== id) mismatch()
  if (body.truncated === true) large()
  if (body.truncated !== false || !Array.isArray(body.tree)) mismatch()
  for (const row of body.tree) treeRow(row)
  return body.tree
}

async function select(get, link, root) {
  let row = { sha: root }
  for (const [index, part] of link.path.entries()) {
    const matches = (await tree(get, row.sha, false)).filter(candidate => candidate.path === part)
    if (!matches.length) refuse('link-missing')
    if (matches.length > 1) mismatch()
    row = matches[0]
    const expected = index === link.path.length - 1 && link.form === 'file' ? 'file' : 'tree'
    const kind = treeRow(row)
    if (kind === 'unsupported') refuse('link-github-link')
    if (kind !== expected) mismatch()
  }
  return row
}

function blobSize(row) {
  if (!Number.isInteger(row.size) || row.size < 0 || row.size > LIMITS.file) mismatch()
}

async function readBlob(operation, link, revision, path, row) {
  const url = new URL('https://raw.githubusercontent.com/' + encoded([link.owner, link.repository, revision, ...path]))
  const content = await operation.linkGet(url, { raw: true, limit: row.size })
  const { bytes } = content
  if (bytes.length !== row.size || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== row.sha) mismatch()
  return content
}

async function fetchGithubFolder(operation, get, link, revision, selected) {
  const rows = await tree(get, selected.sha, true)
  const registry = treeRegistry()
  const downloads = []
  let skipped = 0
  for (const row of rows) {
    const kind = treeRow(row)
    if (kind === 'unsupported') refuse('link-github-link')
    if (kind === 'tree') {
      registry.register(row.path, true)
      continue
    }
    blobSize(row)
    registry.register(row.path, false, row.size)
    if (skippedPath(row.path)) skipped++
    else registry.kept()
    downloads.push(row)
  }
  if (!downloads.some(row => row.path === SKILL_MD)) pathError()
  const entries = await operation.download(downloads, async row => {
    const { bytes } = await readBlob(operation, link, revision, [...link.path, ...row.path.split('/')], row)
    treeText(bytes, row.path)
    if (!skippedPath(row.path)) return { path: row.path, bytes }
  })
  return { entries: entries.filter(Boolean).sort((a, b) => pathOrder(a.path, b.path)), skipped }
}

async function contentOf({ bytes, type }) {
  const kind = downloadArchiveKind(bytes)
  if (htmlType(type)) refuse(kind ? 'link-kind' : 'link-page')
  if (kind) return readSkillArchive(bytes, { kind })
  const prefix = bytes.subarray(0, 4096).toString('utf8')
  if (/^\s*<(?:!doctype\s+html\b|html\b|head\b|body\b)/i.test(prefix)) refuse('link-page')
  try { treeText(bytes, SKILL_MD) } catch { refuse('link-kind') }
  return { entries: validateSkillTree([{ path: SKILL_MD, bytes }]), skipped: 0 }
}

export async function fetchSkillLink(link, deps, storedRef) {
  const operation = skillLinkOperation(deps)
  let ref = null
  let revision
  let content
  let host = 'raw.githubusercontent.com'
  if (link.form === 'direct') {
    const response = await operation.linkGet(new URL(link.url))
    host = response.host
    revision = 'sha256:' + digest('sha256', response.bytes)
    content = await contentOf(response)
  } else {
    const get = githubApi(operation, link, storedRef !== undefined)
    const resolved = await resolveGithubRef(link, get, storedRef)
    if (link.path.length > 10) large()
    ref = resolved.ref
    revision = resolved.revision
    let { root } = resolved
    if (!root) {
      const { body } = await get('git/commits/' + revision)
      if (body?.sha !== revision || !sha(body.tree?.sha)) mismatch()
      root = body.tree.sha
    }
    const selected = await select(get, link, root)
    if (link.form === 'file') {
      blobSize(selected)
      content = await contentOf(await readBlob(operation, link, revision, link.path, selected))
    } else content = await fetchGithubFolder(operation, get, link, revision, selected)
  }
  operation.finish()
  return { ...content, source: { kind: 'link', url: link.url, ref, revision, host, fetchedAt: operation.now() } }
}
