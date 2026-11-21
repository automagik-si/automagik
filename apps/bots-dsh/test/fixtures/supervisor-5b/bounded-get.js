const CDN = 'https://release-assets.githubusercontent.com'
const REDIRECTS = new Set([301, 302, 303, 307, 308])

function cancel(body) {
  void body?.cancel().catch(() => {})
}

export async function boundedGet(fetch, url, { limit, signal, label, missing = false, allowEmpty = false, errorOf = message => new Error(message) }) {
  for (let hops = 0; ; hops++) {
    let response
    try {
      signal.throwIfAborted()
      response = await fetch(url, { redirect: 'manual', signal })
    } catch {
      throw errorOf(`${label} could not be downloaded.`)
    }
    if (REDIRECTS.has(response.status)) {
      cancel(response.body)
      let target
      try { target = new URL(response.headers.get('location') ?? '') } catch {}
      if (hops === 3 || target?.protocol !== 'https:' || target.origin !== CDN || target.username || target.password) {
        throw errorOf(`${label} returned an unsupported redirect.`)
      }
      url = target.href
      continue
    }
    if (!response.ok) {
      cancel(response.body)
      if (missing && response.status === 404) return undefined
      throw errorOf(`${label} returned HTTP ${response.status}.`)
    }
    if ((!response.body && !allowEmpty) || Number(response.headers.get('content-length')) > limit) {
      cancel(response.body)
      throw errorOf(`${label} is missing or exceeds its size limit.`)
    }
    if (!response.body) return Buffer.alloc(0)

    const reader = response.body.getReader()
    const chunks = []
    let length = 0
    let complete = false
    const abort = () => cancel(reader)
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        signal.throwIfAborted()
        let chunk
        try { chunk = await reader.read() } catch { throw errorOf(`${label} could not be downloaded.`) }
        signal.throwIfAborted()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > limit) throw errorOf(`${label} exceeds its size limit.`)
        chunks.push(chunk.value)
      }
      complete = true
      return Buffer.concat(chunks, length)
    } finally {
      signal.removeEventListener('abort', abort)
      if (!complete) cancel(reader)
      reader.releaseLock()
    }
  }
}
