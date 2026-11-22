// Keep in sync with the gate's frontend allowlist using the shared test fixture.
const bundleId = /^(?:@[^/\\]+\/)?[^@/\\][^/\\]*$/
const validId = id => bundleId.test(id) && !/[&,?#%]/.test(id) && !id.split('/').includes('..')
const comboEntry = /^(.*)\/client(?:\.lazy)?\.js$/

export function frontendPath(url) {
  const path = url.pathname
  if (path === '/' || path === '/index.html') return 'static'
  if (path === '/manifest.webmanifest' || path === '/omni-ui/app-icon.png' || path === '/omni-ui/app-icon.svg') return 'app'
  if (!path.startsWith('/assets/') && !path.startsWith('/plugins/')) return undefined

  if (path === '/plugins/' && url.search.startsWith('??')) {
    const revision = url.search.lastIndexOf('&rev=')
    if (revision < 2 || !/^[\w-]+$/.test(url.search.slice(revision + 5))) return undefined
    const list = url.search.slice(2, revision)
    if (!list.split(',').every(item => {
      const id = comboEntry.exec(item)?.[1]
      return id && validId(id)
    })) return undefined
    return 'bundle'
  }

  if (path.startsWith('/plugins/')) {
    const [, id, file] = /^\/plugins\/(@[^/]+\/[^/]+|[^@/][^/]*)\/([^/]+)$/.exec(path) ?? []
    if (!id || !validId(id)) return undefined
    // Allow rc.2 web chunks such as the Bot team's client.pane.js. Refuse exported package assets.
    if (file === 'client.js' || (/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(file) &&
        !file.startsWith('client.node.'))) return 'bundle'
    return undefined
  }

  // Static frontend decodes before resolving the file.
  let target
  try { target = decodeURIComponent(path) }
  catch { return undefined }
  if (target.split(/[,/\\]/).some(part => part === '..' || part.toLowerCase().endsWith('.map'))) return undefined
  return 'static'
}

const shellOrigin = 'https://dsh.invalid'
const linkTags = /<!--[\s\S]*?-->|<(script|style|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi

export function credentialedManifest(html) {
  let rewritten = false
  return html.replace(linkTags, tag => {
    if (rewritten || !/^<link\b/i.test(tag)) return tag
    const attributes = [...tag.slice(5).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    const attribute = name => attributes.find(match => match[1].toLowerCase() === name)
    const value = match => match?.[2] ?? match?.[3] ?? match?.[4]
    const href = value(attribute('href'))?.trim().replace(/[\t\r\n]/g, '')
    if (value(attribute('rel'))?.toLowerCase() !== 'manifest' || !href ||
        /^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(href) || href.split(/[?#]/, 1)[0].includes('&') ||
        URL.parse(href, shellOrigin)?.origin !== shellOrigin) return tag
    rewritten = true
    const existing = attribute('crossorigin')
    const credentials = 'crossorigin="use-credentials"'
    if (existing) {
      const start = 5 + existing.index
      return tag.slice(0, start) + credentials + tag.slice(start + existing[0].length)
    }
    return tag.replace(/(\s*\/?>)$/, ' ' + credentials + '$1')
  })
}
