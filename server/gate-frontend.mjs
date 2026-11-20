// Keep in sync with multiuser-dsh's frontend allowlist using the shared test fixture.
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

  // Static frontend decodes before resolving the file. Preserve the asset boundary
  // and exclude maps. For bundles, DSH uses the raw package ID in its route.
  const plugin = path.startsWith('/plugins/')
  if (plugin) {
    const id = /^\/plugins\/(@[^/]+\/[^/]+|[^@/][^/]*)\/.+$/.exec(path)?.[1]
    if (!id || !validId(id)) return undefined
  }
  let target
  try { target = decodeURIComponent(path) }
  catch { return undefined }
  if (target.split(/[,/\\]/).some(part => part === '..' || part.toLowerCase().endsWith('.map'))) return undefined
  return plugin ? 'bundle' : 'static'
}
