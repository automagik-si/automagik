import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

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
  // path -> what stopped the last read: { event, code }
  const unread = new Map()
  let unexpected = false
  return {
    inspect(path, event) {
      try {
        if (stat(path).isFile()) {
          // The compiler also writes empty files (its output and error logs) and deletes them.
          // Content written later reports a change; a change whose file is gone is a gap.
          const bytes = read(path)
          if (bytes.length) {
            nonempty.add(path)
            scan(bytes)
          }
        }
        seen.add(path)
        unread.delete(path)
      } catch (error) {
        // A rename also reports deletion. A previously inspected file can disappear.
        if (event === 'rename' && error?.code === 'ENOENT' && seen.has(path)) {
          // Windows refuses to open a file once its deletion is pending (EPERM, in this private
          // folder no access rule refuses it). After a complete read, a refusal ended by the
          // file's removal is that deletion, not unread content. EBUSY (a lock) stays a gap.
          if (unread.get(path)?.code === 'EPERM') unread.delete(path)
          return
        }
        // Keep the refusal that hid the content; a later removal adds nothing.
        if (!unread.has(path) || error?.code !== 'ENOENT') unread.set(path, { event, code: error?.code })
        if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) unexpected = true
      }
    },
    get inspected() { return nonempty.size },
    get incomplete() { return unread.size !== 0 },
    // File extensions only: the names are the compiler's random temp names, never values.
    get gaps() {
      return [...unread].map(([path, { event, code }]) =>
        `${extname(path) || '(none)'}:${event ?? 'scan'}:${code}:${seen.has(path) ? 'read' : 'never read'}`).sort().join(' ')
    },
    get unexpected() { return unexpected },
  }
}
