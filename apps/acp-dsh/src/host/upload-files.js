import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export const UPLOAD_FILE_BYTES = 64 * 1024 * 1024
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif' }

export function uploadLeaf(ref, kind) {
  const name = ref.name ?? (kind === 'image' ? `image.${extensions[ref.mediaType]}` : 'file')
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' &&
    !/[\\/]/.test(name) && !name.includes('\0') ? name : 'file'
}

async function directory(path, create = false) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe upload directory.')
  return path
}

export async function ensureUploadsFolder(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('No chat working folder.')
  cwd = resolve(cwd)
  await directory(cwd)
  const parent = await directory(join(cwd, '.automagik'), true)
  const folder = await directory(join(parent, 'uploads'), true)
  let ignore
  try {
    ignore = await open(join(folder, '.gitignore'), 'wx', 0o600)
    await ignore.writeFile('*\n')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await lstat(join(folder, '.gitignore'))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe upload ignore file.')
  } finally { await ignore?.close() }
  return folder
}

// Store readers may ignore cancellation. Observe late failures without waiting for them.
async function abortable(work, signal) {
  signal?.throwIfAborted()
  let stop
  const cancelled = new Promise((_, reject) => {
    stop = () => reject(signal.reason)
    signal?.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(work), cancelled]) } finally {
    signal?.removeEventListener('abort', stop)
  }
}

async function existing(path, ref, signal) {
  signal?.throwIfAborted()
  let stat
  try { stat = await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  // Only a regular file is opened: a FIFO or device could block the open for good.
  if (!stat.isFile()) {
    throw new Error('The upload copy already exists with different bytes.')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0))
  try {
    stat = await file.stat()
    if (!stat.isFile() || stat.size !== ref.bytes || stat.nlink > 1) {
      throw new Error('The upload copy already exists with different bytes.')
    }
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      signal?.throwIfAborted()
      hash.update(chunk)
    }
    if (`sha256:${hash.digest('hex')}` !== ref.attachmentId) {
      throw new Error('The upload copy already exists with different bytes.')
    }
  } finally { await file.close() }
  return true
}

async function checkFolder(cwd, folder, ref) {
  const expected = join(await realpath(cwd), '.automagik', 'uploads', ref.attachmentId.slice(7))
  if (await realpath(folder) !== expected) throw new Error('Unsafe upload directory.')
  // Node has no openat; a directory swap between this check and the call remains possible.
}

// The entry must still be the file this call wrote and verified, not a substitute.
async function same(path, written) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.ino !== written.ino || stat.dev !== written.dev) {
    throw new Error('The upload copy changed before it was published.')
  }
}

// Cleanup removes an entry only while it is still the file this call created.
async function removeOwn(path, created) {
  if (created === undefined) return
  try {
    const stat = await lstat(path)
    if (stat.isFile() && stat.ino === created.ino && stat.dev === created.dev) await unlink(path)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Copy only typed store references into the chat's own working folder. */
export async function copyUpload(options) {
  try { return await writeCopy(options) } catch (error) { return { error } }
}

async function writeCopy({ cwd, ref, kind, attachments, signal }) {
  let temp, file, iterator, written, created
  try {
    signal?.throwIfAborted()
    if (!/^sha256:[a-f0-9]{64}$/.test(ref?.attachmentId) ||
        !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > UPLOAD_FILE_BYTES) {
      throw new Error('Invalid upload reference or attachment exceeds 64 MiB.')
    }
    ref = { ...ref }
    // The chat folder itself may be a link (a workspace on another disk); only the folders
    // created below it must be real directories.
    if (typeof cwd === 'string' && isAbsolute(cwd)) cwd = await realpath(resolve(cwd))
    const root = await ensureUploadsFolder(cwd)
    const folder = await directory(join(root, ref.attachmentId.slice(7)), true)
    const path = join(folder, uploadLeaf(ref, kind))
    if (await existing(path, ref, signal)) {
      signal?.throwIfAborted()
      return { path }
    }
    signal?.throwIfAborted()
    temp = join(folder, `.upload-${randomUUID()}`)
    await checkFolder(cwd, folder, ref)
    file = await open(temp, 'wx', 0o600)
    created = await file.stat()
    let source
    if (kind === 'image') {
      const stored = await abortable(() => attachments.readImage(ref, signal), signal)
      if (!(stored?.data instanceof Uint8Array) ||
          ['attachmentId', 'bytes', 'mediaType', 'width', 'height'].some(
            key => stored.ref?.[key] !== ref[key])) throw new Error('Image reference changed.')
      source = [stored.data]
    } else {
      source = await abortable(() => attachments.readFileStream(ref, signal), signal)
    }
    iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]()
    const hash = createHash('sha256')
    let bytes = 0
    while (true) {
      const chunk = await abortable(() => iterator.next(), signal)
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) throw new Error('Invalid upload bytes.')
      bytes += chunk.value.byteLength
      if (bytes > UPLOAD_FILE_BYTES || bytes > ref.bytes) throw new Error('Upload is too large.')
      hash.update(chunk.value)
      await file.writeFile(chunk.value)
    }
    if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) {
      throw new Error('Upload integrity verification failed.')
    }
    await file.chmod(0o444)
    written = await file.stat()
    await file.close()
    file = undefined
    signal?.throwIfAborted()
    // Recheck directories and the destination after reading the store.
    await directory(cwd)
    await directory(join(cwd, '.automagik'))
    await directory(root)
    await directory(folder)
    if (!await existing(path, ref, signal)) {
      signal?.throwIfAborted()
      await checkFolder(cwd, folder, ref)
      signal?.throwIfAborted()
      await same(temp, written)
      let linked = false
      try {
        await link(temp, path)
        linked = true
        await same(path, written)
      } catch (error) {
        // Remove only the entry this call published; never a file someone else made.
        if (linked) await removeOwn(path, created)
        if (error.code !== 'EEXIST') throw error
        if (!await existing(path, ref, signal)) {
          throw new Error('The upload copy already exists with different bytes.')
        }
      }
    }
    return { path }
  } finally {
    // Do not wait for an uncooperative iterator's return after Stop.
    if (iterator?.return) Promise.resolve().then(() => iterator.return()).catch(() => {})
    await file?.close()
    if (temp) await removeOwn(temp, created)
  }
}
