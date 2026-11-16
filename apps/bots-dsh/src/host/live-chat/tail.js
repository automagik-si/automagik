// Following a transcript as the agent writes it (RFC 0015, "Tailing"). Ours.
//   LocalTail: this computer. fs.watch plus a one-second poll (the poll is what counts; watch only
//   wakes it sooner), reading from the last byte offset, holding a partial last line until its
//   newline. A file that shrinks or is replaced starts again (onReset).
//   RemoteTail: another machine, through `file.read` with a line `offset`, every 2 s while the
//   agent works and every 10 s when idle, paging by `limit`. `on` is fixed at construction (the
//   caller takes it from the terminal's address) and no `cwd` is ever sent, so a home-relative
//   path is read from that machine's home.
// Both start `window` lines before the end (older lines are read again on a backfill), hand over
// complete lines as { n, text } (n counts from 1; text is null for a line too long to keep) and
// never log a line's text.
//
// The folder rule is asked again every time a local file is opened, after the open: `admit(path)`
// returns the rule's resolved real path, and the open handle must be that file (same dev and
// inode). A symlink swapped in before or after the open, pointing out of the folder, is refused.
import { open, stat } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

/** A line longer than this is counted but not kept (text: null). */
export const MAX_LINE = 16 * 1024 * 1024
/** Every this many lines, LocalTail notes where the line starts, for readLocalLines. */
export const INDEX_EVERY = 256
const CHUNK = 1024 * 1024
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval }

/**
 * Open `path` for reading only if it is the file the folder rule resolves it to now.
 * @param {string} path @param {(p: string) => string | null} admit
 * @returns {Promise<import('node:fs/promises').FileHandle | null>}
 */
export async function openAdmitted(path, admit) {
  let fh
  try { fh = await open(path, 'r') } catch { return null }
  try {
    const real = admit(path)
    if (typeof real === 'string') {
      const [opened, checked] = await Promise.all([fh.stat(), stat(real)])
      if (opened.isFile() && opened.dev === checked.dev && opened.ino === checked.ino) return fh
    }
  } catch {}
  await fh.close().catch(() => {})
  return null
}

/**
 * Count a file's lines from its bytes (nothing decoded): the sparse index, and where the window's
 * first line, max(1, lines - window + 1), starts.
 */
async function scan(fh, window, buf) {
  const index = [0]
  const starts = [] // where each of the last window + 1 lines after a newline starts
  let lines = 0
  let at = 0
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, at)
    if (bytesRead === 0) break
    let from = 0
    let nl
    while ((nl = buf.indexOf(10, from)) !== -1 && nl < bytesRead) {
      lines += 1
      const next = at + nl + 1
      if (lines % INDEX_EVERY === 0) index[lines / INDEX_EVERY] = next
      if (Number.isFinite(window)) { starts.push(next); if (starts.length > window + 1) starts.shift() }
      from = nl + 1
    }
    at += bytesRead
  }
  if (!Number.isFinite(window) || lines <= window) return { index, firstLine: 1, offset: 0 }
  // starts[0] follows newline number lines - window: it is where line lines - window + 1 starts.
  return { index, firstLine: lines - window + 1, offset: starts[0] }
}

export class LocalTail {
  /**
   * @param {string} path  a path the folder rule accepted
   * @param {{ onLines(lines: { n: number, text: string | null }[]): void, onReset?(): void,
   *   onError?(e: Error): void, admit?(path: string): string | null, window?: number, maxLine?: number,
   *   pollMs?: number, watch?: typeof fsWatch | null, timers?: typeof realTimers }} options
   *   admit: the folder rule, asked at every open, returning the resolved real path or null
   */
  constructor(path, { onLines, onReset = () => {}, onError = () => {}, admit = (p) => p, window = Infinity, maxLine = MAX_LINE, pollMs = 1000, watch = fsWatch, timers = realTimers }) {
    Object.assign(this, { path, onLines, onReset, onError, admit, window, maxLine, pollMs, watchFn: watch, timers })
    this.buf = Buffer.alloc(CHUNK)
    this.fh = null
    this.ino = null
    /** The first line read (older ones come from readLocalLines). */
    this.first = 1
    this.fresh()
    this.busy = null
    this.again = false
    this.stopped = false
  }

  fresh() {
    Object.assign(this, { offset: 0, line: 0, partial: '', skipping: false, decoder: new StringDecoder('utf8'), index: [0], pos: 0 })
  }

  start() {
    this.timer = this.timers.setInterval(() => { this.tick() }, this.pollMs)
    this.timer.unref?.()
    try {
      this.watcher = this.watchFn?.(this.path, () => { this.tick() })
      this.watcher?.on?.('error', () => {})
    } catch {}
    return this.tick()
  }

  async stop() {
    this.stopped = true
    this.timers.clearInterval(this.timer)
    try { this.watcher?.close() } catch {}
    try { await this.busy } catch {}
    const fh = this.fh
    this.fh = null
    await fh?.close().catch(() => {})
  }

  /** Read whatever is new. Concurrent calls collapse into one more pass. */
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.busy) { this.again = true; return this.busy }
    this.busy = (async () => {
      do {
        this.again = false
        try { await this.readNew() } catch (e) { this.onError(e) }
      } while (this.again && !this.stopped)
    })().finally(() => { this.busy = null })
    return this.busy
  }

  async reset() {
    await this.fh?.close().catch(() => {})
    this.fh = null
    this.fresh()
    this.onReset()
  }

  async readNew() {
    let onDisk
    try { onDisk = await stat(this.path) } catch { return } // gone for now: keep what was read
    if (this.fh && (onDisk.ino !== this.ino || onDisk.size < this.offset)) await this.reset()
    if (this.fh && onDisk.size === this.offset) return
    if (!this.fh) {
      const fh = await openAdmitted(this.path, this.admit)
      if (!fh) return
      if (this.stopped) { await fh.close().catch(() => {}); return }
      this.fh = fh
      this.ino = (await fh.stat()).ino
      const { index, firstLine, offset } = await scan(fh, this.window, this.buf)
      if (this.stopped) return
      Object.assign(this, { index, first: firstLine, line: firstLine - 1, offset, pos: offset })
    }
    for (;;) {
      if (this.stopped) return
      const { bytesRead } = await this.fh.read(this.buf, 0, CHUNK, this.offset)
      if (bytesRead === 0) return
      this.offset += bytesRead
      this.take(this.decoder.write(this.buf.subarray(0, bytesRead)))
    }
  }

  /** Split decoded text into complete lines; keep the rest as the partial last line. */
  take(text) {
    const out = []
    let from = 0
    let at
    while ((at = text.indexOf('\n', from)) !== -1) {
      const piece = text.slice(from, at)
      from = at + 1
      this.line += 1
      // Bytes of every decoded piece are counted, the partial line's included (below), so this is
      // where the next line starts.
      this.pos += Buffer.byteLength(piece, 'utf8') + 1
      if (this.line % INDEX_EVERY === 0) this.index[this.line / INDEX_EVERY] = this.pos
      if (this.skipping) { this.skipping = false; this.partial = ''; out.push({ n: this.line, text: null }); continue }
      const whole = (this.partial + piece).replace(/\r$/, '')
      this.partial = ''
      out.push({ n: this.line, text: whole.length > this.maxLine ? null : whole })
    }
    const rest = text.slice(from)
    this.pos += Buffer.byteLength(rest, 'utf8')
    if (!this.skipping) {
      this.partial += rest
      if (this.partial.length > this.maxLine) { this.skipping = true; this.partial = '' }
    }
    if (out.length) this.onLines(out)
  }
}

/**
 * Lines `from`..`to` (from 1) of a file LocalTail has indexed, as { n, text }: for a backfill.
 * The file is opened through the folder rule again (openAdmitted).
 * @param {LocalTail} tail
 */
export async function readLocalLines(tail, from, to) {
  if (from < 1 || to < from) return []
  const k = Math.min(Math.floor((from - 1) / INDEX_EVERY), tail.index.length - 1)
  let n = k * INDEX_EVERY
  const fh = await openAdmitted(tail.path, tail.admit)
  if (!fh) return []
  const out = []
  try {
    const decoder = new StringDecoder('utf8')
    const buf = Buffer.alloc(CHUNK)
    let at = tail.index[k]
    let partial = ''
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, at)
      if (bytesRead === 0) return out
      at += bytesRead
      const parts = (partial + decoder.write(buf.subarray(0, bytesRead))).split('\n')
      partial = parts.pop()
      for (const p of parts) {
        n += 1
        if (n >= from) out.push({ n, text: p.length > tail.maxLine ? null : p.replace(/\r$/, '') })
        if (n >= to) return out
      }
      if (partial.length > tail.maxLine) return out
    }
  } catch { return out } finally { await fh.close().catch(() => {}) }
}

export class RemoteTail {
  /**
   * @param {{ hc: { call(m: string, p: object): Promise<any> }, on: string, path: string,
   *   onLines(lines: { n: number, text: string | null }[]): void, onReset?(): void, onError?(e: Error): void,
   *   working?(): boolean, window?: number, page?: number, workingMs?: number, idleMs?: number, timers?: typeof realTimers }} options
   */
  constructor({ hc, on, path, onLines, onReset = () => {}, onError = () => {}, working = () => false, window = Infinity, page = 2000, workingMs = 2000, idleMs = 10_000, timers = realTimers }) {
    Object.assign(this, { hc, on, path, onLines, onReset, onError, working, window, page, workingMs, idleMs, timers })
    this.next = 1
    this.first = 1
    /** The text of line next - 1 as read (undefined: none yet; null: too long to keep). */
    this.held = undefined
    this.counted = false
    this.stopped = false
    this.busy = null
  }

  start() { return this.tick() }

  stop() {
    this.stopped = true
    this.timers.clearTimeout(this.timer)
    return this.busy ?? Promise.resolve()
  }

  /** Read now (also wakes the next poll early, as on a status change). */
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.busy) return this.busy
    this.timers.clearTimeout(this.timer)
    this.busy = this.readPages().finally(() => {
      this.busy = null
      if (this.stopped) return
      this.timer = this.timers.setTimeout(() => { this.tick() }, this.working() ? this.workingMs : this.idleMs)
      this.timer.unref?.()
    })
    return this.busy
  }

  /** How many lines the file has: offset 1 with limit 0 is valid even for an empty file. */
  async count() {
    // Never a cwd: the path is home-relative and `on` is the terminal's own machine.
    const r = await this.hc.call('file.read', { path: this.path, on: this.on, offset: 1, limit: 0 })
    return r.lines
  }

  /** The file is not the one read: start again, window lines before its end. */
  restart() {
    Object.assign(this, { next: 1, first: 1, held: undefined, counted: false })
    this.onReset()
  }

  /**
   * A poll counts the file's lines first (limit 0: nothing carried). The same count as read is
   * caught up and reads nothing more. Otherwise it reads again from the last line held and
   * compares it: a file truncated and written again past the old offset is a new file (restart),
   * not more lines to splice on. Not detected: a rewrite to the same line count, or a new file
   * whose line at that place is identical; transcript lines carry their own ids, so neither is
   * expected.
   */
  async readPages() {
    let polled = false
    for (;;) {
      if (this.stopped) return
      if (!this.counted) {
        let lines
        try { lines = await this.count() } catch (e) { this.onError(e); return }
        this.counted = true
        polled = true
        if (Number.isFinite(this.window) && lines > this.window) this.next = this.first = lines - this.window + 1
      }
      if (!polled && this.held !== undefined) {
        polled = true
        let lines
        try { lines = await this.count() } catch (e) { this.onError(e); return }
        if (lines === this.next - 1) return
        if (lines < this.next - 1) { this.restart(); continue }
      }
      polled = true
      // A held line too long to keep (null) cannot be compared, nor read again under the cap.
      const overlap = typeof this.held === 'string' && this.next > 1
      const offset = overlap ? this.next - 1 : this.next
      let r
      try {
        r = await this.hc.call('file.read', { path: this.path, on: this.on, offset, limit: this.page + (overlap ? 1 : 0) })
      } catch (e) {
        if (e?.kind !== 'invalid_params') { this.onError(e); return }
        // herdr-core refuses an offset past the last line. Exactly at the end: caught up. Fewer
        // lines than were read: a new file. More: not something to guess at, so it is reported.
        let lines
        try { lines = await this.count() } catch (e2) { this.onError(e2); return }
        if (lines === offset - 1) return
        if (lines < offset - 1) { this.restart(); continue }
        this.onError(e)
        return
      }
      if (r.lines < offset - 1) { this.restart(); continue }
      if (r.last < r.first) {
        // Nothing given although the file has more: one line past the 8 MB a read gives.
        if (!overlap && r.lines >= this.next) { this.onLines([{ n: this.next, text: null }]); this.next += 1; this.held = null; continue }
        return
      }
      const pieces = r.text.match(/[^\n]*\n|[^\n]+$/g) ?? []
      if (overlap) {
        const again = pieces.shift()
        const same = again !== undefined && again.endsWith('\n') && (this.held === null || again.slice(0, -1).replace(/\r$/, '') === this.held)
        if (!same) { this.restart(); continue }
        if (!pieces.length && r.last === offset && r.lines > offset) {
          // Only the held line came back though the file has more: the next line is past the
          // 8 MB a read gives. It is counted, not kept, and reading goes on after it.
          this.onLines([{ n: this.next, text: null }])
          this.next += 1
          this.held = null
          continue
        }
      }
      const base = overlap ? r.first + 1 : r.first
      const out = []
      for (const piece of pieces) {
        if (!piece.endsWith('\n')) break // the last line, still being written: read again next time
        out.push({ n: base + out.length, text: piece.slice(0, -1).replace(/\r$/, '') })
      }
      if (out.length) { this.next = base + out.length; this.held = out.at(-1).text; this.onLines(out) }
      if (!out.length || r.last >= r.lines) return
    }
  }

  /** Lines `from`..`to` for a backfill: whole lines only, with the same `on` and no cwd. */
  async readLines(from, to) {
    if (from < 1 || to < from) return []
    try {
      const r = await this.hc.call('file.read', { path: this.path, on: this.on, offset: from, limit: to - from + 1 })
      const pieces = (r.text.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter((p) => p.endsWith('\n'))
      return pieces.map((p, i) => ({ n: r.first + i, text: p.slice(0, -1).replace(/\r$/, '') }))
    } catch (e) { this.onError(e); return [] }
  }
}
