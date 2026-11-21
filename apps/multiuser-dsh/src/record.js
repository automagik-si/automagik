import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Same source as BOT_ID in apps/bots-dsh/src/shared/registry.js.
export const BOT_ID = /^(b-[a-z2-7]{10}|session-[0-9a-f-]{36})$/

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants
// Keep a leading BOM in the decoded text so JSON.parse rejects it as before.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const privateToDsh = info => info.uid === process.getuid() && (info.mode & 0o077) === 0
const privateFolder = info => info.isDirectory() && info.uid === BigInt(process.getuid()) && (info.mode & 0o077n) === 0n

function folderError(cause) {
  return new Error('principal record folder must remain a private directory owned by DSH'
    + (cause === undefined ? '' : `: ${cause.message}`), { cause })
}

function openRecordFolder(folder) {
  try {
    return fs.openSync(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  } catch (cause) {
    throw folderError(cause)
  }
}

function syncDirectory(path) {
  const fd = fs.openSync(path, O_RDONLY | O_DIRECTORY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function readSessions(file, instance, checkFolder) {
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || !privateToDsh(info) || info.nlink !== 1) {
      throw new Error('principal record must be a private regular file owned by DSH with one link')
    }
    checkFolder()
    const bytes = fs.readFileSync(fd)
    let contents
    try {
      contents = utf8.decode(bytes)
    } catch (cause) {
      throw new Error('principal record contains invalid UTF-8', { cause })
    }
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch (cause) {
      throw new Error('principal record contains invalid JSON', { cause })
    }
    const { version, instance: recordedInstance, sessions } = parsed ?? {}
    if (version !== 2) throw new Error('expected a version 2 principal record')
    if (recordedInstance !== instance) throw new Error('principal record belongs to a different instance')
    if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)
        || Object.values(sessions).some(value => typeof value !== 'string')) {
      throw new Error('principal record sessions must be an object with string values')
    }
    return sessions
  } finally {
    fs.closeSync(fd)
  }
}

export function createPrincipalRecord({ dshHome, instance, warn }) {
  if (!isAbsolute(dshHome)) throw new Error('DSH home must be absolute')
  const folder = join(dshHome, 'multiuser-dsh')
  const file = join(folder, 'principals.json')
  try {
    fs.lstatSync(folder, { bigint: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const previous = process.umask(0o077)
    try {
      fs.mkdirSync(folder, { mode: 0o700 })
    } finally {
      process.umask(previous)
    }
  }
  let folderFd = openRecordFolder(folder)
  function dispose() {
    if (folderFd === undefined) return
    const fd = folderFd
    folderFd = undefined
    fs.closeSync(fd)
  }
  let folderInfo
  // Node has no openat/renameat/unlinkat. Holding the fd keeps the inode from being
  // reused, but a swap and restore between pathname operations can still escape detection.
  const checkFolder = () => {
    if (folderFd === undefined) throw new Error('principal record writer is disposed')
    const current = fs.lstatSync(folder, { bigint: true })
    if (!privateFolder(current) || current.dev !== folderInfo.dev || current.ino !== folderInfo.ino) throw folderError()
  }
  try {
    folderInfo = fs.fstatSync(folderFd, { bigint: true })
    if (!privateFolder(folderInfo)) throw folderError()
    checkFolder()
    // A previous writer may have stopped after mkdir or rename but before its directory sync.
    fs.fsyncSync(folderFd)
    syncDirectory(dshHome)
    checkFolder()
  } catch (error) {
    dispose()
    throw error
  }

  let needsFolderSync = false
  let warnedRefusal = false
  const warnedReplacements = new Set()
  const syncFolder = () => {
    checkFolder()
    fs.fsyncSync(folderFd)
    checkFolder()
    needsFolderSync = false
  }

  function recordBot(sessionId, botId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('expected a non-empty session id')
    if (typeof botId !== 'string' || !BOT_ID.test(botId)) throw new Error('invalid Bot id')

    let sessions
    try {
      checkFolder()
      sessions = readSessions(file, instance, checkFolder)
      checkFolder()
    } catch (error) {
      if (!warnedRefusal) {
        warnedRefusal = true
        warn?.(`refusing to write the principal record: ${error.message}`)
      }
      throw error
    }

    const entry = `bot:${botId}`
    const previous = Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined
    if (previous === entry) {
      if (needsFolderSync) syncFolder()
      return
    }
    if (previous !== undefined && !warnedReplacements.has(sessionId)) {
      warnedReplacements.add(sessionId)
      warn?.(`replacing ${previous} for Bot session ${sessionId}`)
    }

    const bytes = Buffer.from(JSON.stringify({ version: 2, instance, sessions: { ...sessions, [sessionId]: entry } }))
    const temp = `${file}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
    let created = false
    let renamed = false
    try {
      checkFolder()
      const fd = fs.openSync(temp, 'wx', 0o600)
      created = true
      try {
        checkFolder()
        fs.fchmodSync(fd, 0o600)
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
          if (written === 0) throw new Error('could not write all principal record bytes')
          offset += written
        }
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      checkFolder()
      fs.renameSync(temp, file)
      renamed = true
      needsFolderSync = true
      syncFolder()
    } finally {
      if (created && !renamed) {
        try {
          checkFolder()
          fs.unlinkSync(temp)
        } catch {}
      }
    }
  }

  return { file, folderIdentity: `${folderInfo.dev}:${folderInfo.ino}`, recordBot, dispose }
}
