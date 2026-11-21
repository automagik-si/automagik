import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function* filesBelow(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* filesBelow(path)
    else if (entry.isFile()) yield path
  }
}

export async function checkTranscripts(dir, executions, needles) {
  const seen = new Set()
  for await (const path of filesBelow(dir)) {
    const bytes = await readFile(path)
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
    const body = bytes.toString(utf16 ? 'utf16le' : 'utf8')
    const pid = Number(body.match(/^Process ID:\s*(\d+)/m)?.[1])
    if (Number.isInteger(pid)) seen.add(pid)
    assert.equal(needles.some(marker => bytes.includes(marker)), false, 'private bytes in transcript')
  }
  assert.equal(executions.every(pid => seen.has(pid)), true, 'transcript for each reader and writer process')
}

export function compilerScratchEvidence(scan, { stat = statSync, read = readFileSync } = {}) {
  const seen = new Set()
  const nonempty = new Set()
  const unread = new Set()
  let unexpected = false
  return {
    inspect(path, event) {
      try {
        if (stat(path).isFile()) {
          const bytes = read(path)
          if (bytes.length === 0) {
            seen.delete(path)
            unread.add(path)
            return
          }
          nonempty.add(path)
          scan(bytes)
        }
        seen.add(path)
        unread.delete(path)
      } catch (error) {
        // A rename also reports deletion. A previously inspected file can disappear.
        if (event === 'rename' && error?.code === 'ENOENT' && seen.has(path)) return
        unread.add(path)
        if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) unexpected = true
      }
    },
    get inspected() { return nonempty.size },
    get incomplete() { return unread.size !== 0 },
    get unexpected() { return unexpected },
  }
}
