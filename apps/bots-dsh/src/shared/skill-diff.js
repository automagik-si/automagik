const TEXT_LIMIT = 256 * 1024
const TOTAL_TEXT_LIMIT = 1024 * 1024
const LINE_LIMIT = 2000
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const pathOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0

function difference(from, to, identity) {
  const counts = new Map()
  for (const value of to) {
    const key = identity(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return from.filter(value => {
    const key = identity(value)
    const available = counts.get(key) ?? 0
    if (!available) return true
    counts.set(key, available - 1)
    return false
  })
}

const findingIdentity = row => JSON.stringify(row.rule
  ? [row.rule, row.level, row.path, row.reason, row.detail ?? null, row.injection]
  : [row.area, row.file, row.severity, row.reason, row.injection])

export function findingDelta(before, after) {
  return {
    new: difference(after, before, findingIdentity),
    gone: difference(before, after, findingIdentity),
  }
}

function displayFile(file) {
  if (!file) return {}
  const { size, bytes } = file
  if (size > TEXT_LIMIT) return { cut: true }
  let text = file.text
  if (bytes !== undefined) {
    try { text = textDecoder.decode(bytes) } catch { return {} }
  }
  if (text === undefined || text.includes('\0')) return {}
  if (text.split('\n', LINE_LIMIT + 1).length > LINE_LIMIT) return { cut: true }
  return { text }
}

export function compareFiles(before, after) {
  const prior = new Map(before.map(entry => [entry.path, entry]))
  const next = new Map(after.map(entry => [entry.path, entry]))
  const files = { added: [], removed: [], changed: [], same: 0, omitted: { count: 0 } }
  let textBytes = 0
  for (const path of [...new Set([...prior.keys(), ...next.keys()])].sort(pathOrder)) {
    const old = prior.get(path)
    const updated = next.get(path)
    if (old && updated && old.size === updated.size && old.sha256 === updated.sha256) {
      files.same++
      continue
    }
    const left = displayFile(old)
    const right = displayFile(updated)
    const size = (left.text === undefined ? 0 : old.size) + (right.text === undefined ? 0 : updated.size)
    const cut = left.cut || right.cut || textBytes + size > TOTAL_TEXT_LIMIT
    if (cut) files.omitted.count++
    else textBytes += size
    const show = (name, side) => !cut && side.text !== undefined ? { [name]: side.text } : {}
    if (!old) files.added.push({ path, size: updated.size, sha256: updated.sha256, ...show('text', right) })
    else if (!updated) files.removed.push({ path, size: old.size, sha256: old.sha256, ...show('text', left) })
    else files.changed.push({ path, before: { size: old.size, sha256: old.sha256 }, after: { size: updated.size, sha256: updated.sha256 },
      ...show('beforeText', left), ...show('afterText', right) })
  }
  return files
}
