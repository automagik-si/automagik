import { DIGEST, validDate, validInstanceId, validLabel } from '../shared/account-reservations.js'

export const RECORD_VERSION = 1
export const MAX_RECORD_BYTES = 64 * 1024

const vendorOk = vendor => vendor === 'claude' || vendor === 'codex'
const digestOk = value => typeof value === 'string' && DIGEST.test(value)
const classOk = (vendor, value) => vendor === 'codex'
  ? value === 'personal' || value === 'workspace' : value === undefined
const state = value => ({ state: value })
const refused = value => ({ refused: value })
const sameFile = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

export function reservationsDir({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return undefined
  const override = env.AUTOMAGIK_RESERVATIONS_DIR
  if (override !== undefined) {
    if (typeof override !== 'string') return undefined
    const path = override.replace(/\/+$/, '')
    return path.startsWith('/') && path.length > 1 && !path.includes('\0') ? path : undefined
  }
  return platform === 'darwin' ? '/Users/Shared/Automagik/reservations'
    : '/var/lib/automagik/reservations'
}

function validInput({ vendor, exact, loose, class: plan, instance, label }) {
  return vendorOk(vendor) && digestOk(exact) && digestOk(loose) && classOk(vendor, plan)
    && validInstanceId(instance) && validLabel(label)
}

function validRecord(record, vendor, exact) {
  const keys = ['version', 'vendor', 'exact', 'loose', 'instance', 'label', 'at']
  if (vendor === 'codex') keys.push('class')
  return record.vendor === vendor && record.exact === exact && Object.keys(record).length
    === keys.length && keys.every(key => Object.hasOwn(record, key))
    && validInput(record) && validDate(record.at)
}

export function createMachineRecord({ fs, dir, platform, uid, pid, random, now, wait, userName }) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = fs.constants
  const { R_OK, W_OK, X_OK } = fs.constants
  const readFlags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK
  const writeFlags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const pathOf = (ready, vendor, exact) => `${ready.dir}/${vendor}-${exact}.json`
  const hidden = (ready, base, ext) => `${ready.dir}/.${base}.${pid}.${random(8, 'hex')}.${ext}`

  function access(path, flags) {
    try { fs.accessSync(path, flags); return true } catch { return false }
  }

  // Bound the descriptor read even if the file grows between stat and read.
  function readBytes(fd, limit) {
    const bytes = new Uint8Array(limit)
    let total = 0
    while (total < limit) {
      const count = fs.readSync(fd, bytes, total, limit - total, null)
      if (count === 0) break
      total += count
    }
    return bytes.subarray(0, total)
  }

  function open() {
    if (platform === 'win32') return state('unsupported')
    const path = dir()
    if (path === undefined) return state('not-set-up')
    let folder
    try { folder = fs.lstatSync(path) } catch (error) {
      return state(error?.code === 'ENOENT' ? 'absent' : 'unreadable')
    }
    if (!folder.isDirectory() || !(folder.mode & 0o1000)
      || (platform === 'linux' && !(folder.mode & 0o2000))
      || (folder.mode & 0o077) !== 0o070 || (folder.uid !== 0 && folder.uid !== uid())) {
      return state('not-set-up')
    }
    if (!access(path, R_OK | X_OK)) return state('unreadable')
    const writable = access(path, W_OK)
    try {
      const fd = fs.openSync(`${path}/key`, readFlags)
      try {
        const st = fs.fstatSync(fd)
        if (!st.isFile() || st.size !== 32 || (st.mode & 0o137) !== 0
          || st.uid !== folder.uid || st.gid !== folder.gid) return state('bad-key')
        const key = readBytes(fd, 33)
        if (key.length !== 32) return state('bad-key')
        return { state: 'ready', dir: path, key, writable }
      } finally { fs.closeSync(fd) }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return state(access(path, R_OK | X_OK) ? 'no-key' : 'unreadable')
      }
      return state(error?.code === 'ELOOP' ? 'bad-key' : 'unreadable')
    }
  }

  function readFile(ready, vendor, exact) {
    const path = pathOf(ready, vendor, exact)
    for (let attempt = 0; ; attempt++) {
      let st, bytes
      try {
        const fd = fs.openSync(path, readFlags)
        try {
          st = fs.fstatSync(fd)
          if (!st.isFile() || st.size > MAX_RECORD_BYTES) return state('unreadable')
          bytes = readBytes(fd, MAX_RECORD_BYTES + 1)
          if (bytes.length > MAX_RECORD_BYTES) return state('unreadable')
        } finally { fs.closeSync(fd) }
      } catch (error) {
        if (error?.code === 'ENOENT') return state('absent')
        return { state: 'unreadable', code: error?.code }
      }
      let record
      try { record = JSON.parse(decoder.decode(bytes)) } catch {
        if (attempt < 10 && now() - st.mtimeMs < 5_000) {
          wait(50)
          continue
        }
        return state('unreadable')
      }
      if (!record || typeof record !== 'object' || !Object.hasOwn(record, 'version')) {
        return state('unreadable')
      }
      if (record.version !== RECORD_VERSION) return state('unknown-version')
      if (!validRecord(record, vendor, exact)) return state('unreadable')
      const { uid: ownerUid, dev, ino, mtimeMs } = st
      return { state: 'ok', record, uid: ownerUid, owner: userName(ownerUid), dev, ino, mtimeMs }
    }
  }

  function readExact(ready, vendor, exact) {
    if (!vendorOk(vendor) || !digestOk(exact)) return state('unreadable')
    const read = readFile(ready, vendor, exact)
    if ((read.state === 'absent' || read.code === 'EACCES') && !access(ready.dir, R_OK | X_OK)) {
      return state('folder-unreadable')
    }
    return read.state === 'ok' || read.state === 'absent' ? read : state('unreadable')
  }

  function scan(ready, vendor, keep) {
    if (!vendorOk(vendor)) return { state: 'ok', matches: [] }
    let names
    try { names = fs.readdirSync(ready.dir) } catch { return state('folder-unreadable') }
    const pattern = new RegExp(`^${vendor}-([A-Za-z0-9_-]{43})\\.json$`)
    const matches = []
    for (const name of names.sort()) {
      const match = pattern.exec(name)
      if (!match) continue
      const read = readFile(ready, vendor, match[1])
      if (read.state === 'ok' && keep(read.record)) matches.push({ ...read, name })
    }
    return { state: 'ok', matches }
  }

  function scanLoose(ready, vendor, loose) {
    const result = scan(ready, vendor, record => record.loose === loose)
    if (result.state !== 'ok') return result
    return { state: 'ok', matches: result.matches.map(({ record, uid, owner, name }) => (
      { record, uid, owner, name }
    )) }
  }

  function listOwn(ready, vendor, instance) {
    const result = scan(ready, vendor, record => record.instance === instance)
    return (result.matches ?? []).map(({ record: { exact, label }, uid, owner, dev, ino }) => (
      { exact, label, uid, owner, dev, ino }
    ))
  }

  function unlink(path) {
    try { fs.unlinkSync(path) } catch {}
  }

  function removeIfSame(ready, final, expect) {
    const aside = hidden(ready, final.slice(ready.dir.length + 1), 'del')
    try { fs.renameSync(final, aside) } catch (error) {
      if (error?.code === 'ENOENT') return 'absent'
      throw error
    }
    const restore = () => {
      // Preserve whichever file already owns the final name.
      try { fs.linkSync(aside, final) } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    if (!sameFile(fs.lstatSync(aside), expect)) {
      restore()
      fs.unlinkSync(aside)
      return 'changed'
    }
    try { fs.unlinkSync(aside) } catch (error) {
      restore()
      unlink(aside)
      throw error
    }
    return 'ok'
  }

  function put(fd, record) {
    fs.fchmodSync(fd, 0o640)
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`)
    fs.fsyncSync(fd)
  }

  function writeTemp(ready, record) {
    const path = hidden(ready, `${record.vendor}-${record.exact}`, 'tmp')
    const fd = fs.openSync(path, writeFlags, 0o640)
    try {
      let info
      try {
        put(fd, record)
        info = fs.fstatSync(fd)
      } finally { fs.closeSync(fd) }
      return { path, dev: info.dev, ino: info.ino }
    } catch (error) {
      unlink(path)
      throw error
    }
  }

  function publishExclusive(ready, final, record) {
    const fd = fs.openSync(final, writeFlags, 0o640)
    let info
    try {
      try {
        info = fs.fstatSync(fd)
        put(fd, record)
      } finally { fs.closeSync(fd) }
    } catch {
      if (info) {
        try {
          if (sameFile(fs.lstatSync(final), info)) removeIfSame(ready, final, info)
        } catch {}
      }
      return refused('failed')
    }
    return { ok: true, created: true, dev: info.dev, ino: info.ino }
  }

  function reserve(ready, input) {
    if (!input || !validInput(input) || (input.vendor === 'claude'
      && Object.hasOwn(input, 'class'))) return refused('invalid')
    if (!ready.writable) return refused('not-writable')
    const { vendor, exact, loose, class: plan, instance, label } = input
    const record = {
      version: RECORD_VERSION, vendor, exact, loose,
      ...(plan === undefined ? {} : { class: plan }),
      instance, label, at: new Date(now()).toISOString(),
    }
    const final = pathOf(ready, vendor, exact)
    let temp, fallback = false
    try {
      temp = writeTemp(ready, record)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!fallback) {
            try {
              fs.linkSync(temp.path, final)
              return { ok: true, created: true, dev: temp.dev, ino: temp.ino }
            } catch (error) {
              if (!NO_LINK.has(error?.code)) throw error
              fallback = true
            }
          }
          return publishExclusive(ready, final, record)
        } catch (error) {
          if (error?.code !== 'EEXIST') return refused('failed')
          const existing = readExact(ready, vendor, exact)
          if (existing.state === 'absent') continue
          if (existing.state !== 'ok') return refused('unreadable')
          const { record: old, owner, uid: ownerUid, dev, ino } = existing
          if (old.instance !== instance) return { conflict: { label: old.label, owner } }
          if (ownerUid !== uid()) return refused('not-own-file')
          return { mine: { label: old.label, uid: ownerUid, dev, ino } }
        }
      }
    } catch {
      return refused('failed')
    } finally {
      if (temp) unlink(temp.path)
    }
    return refused('failed')
  }

  function relabel(ready, { vendor, exact, instance, label, expect }) {
    if (!validLabel(label)) return refused('invalid')
    if (!ready.writable) return refused('not-writable')
    const existing = readExact(ready, vendor, exact)
    if (existing.state !== 'ok') return refused(existing.state === 'absent'
      ? 'changed' : 'unreadable')
    if (existing.uid !== uid() || existing.record.instance !== instance) {
      return refused('not-own-file')
    }
    if (!expect || !sameFile(existing, expect)) return refused('changed')
    const final = pathOf(ready, vendor, exact)
    let temp
    try {
      temp = writeTemp(ready, { ...existing.record, label })
      if (!sameFile(fs.lstatSync(final), expect)) return refused('changed')
      fs.renameSync(temp.path, final)
      return { ok: true, dev: temp.dev, ino: temp.ino }
    } catch (error) {
      return refused(error?.code === 'ENOENT' ? 'changed' : 'failed')
    } finally {
      if (temp) unlink(temp.path)
    }
  }

  function makeShared(ready, { vendor, exact, instance, expect }) {
    if (!vendorOk(vendor) || !digestOk(exact)) return refused('invalid')
    const existing = readFile(ready, vendor, exact)
    if (existing.state !== 'ok') return refused(existing.state === 'absent'
      ? 'absent' : 'unreadable')
    if (existing.uid !== uid()) return refused('not-own-file')
    if (existing.record.instance !== instance) return refused('other-instance')
    if (!expect || !sameFile(existing, expect)) return refused('changed')
    const final = pathOf(ready, vendor, exact)
    try {
      if (!sameFile(fs.lstatSync(final), expect)) return refused('changed')
      const result = removeIfSame(ready, final, expect)
      return result === 'ok' ? { ok: true } : refused(result)
    } catch (error) {
      return refused(error?.code === 'ENOENT' ? 'absent' : 'failed')
    }
  }

  return { open, readExact, scanLoose, listOwn, reserve, relabel, makeShared }
}
