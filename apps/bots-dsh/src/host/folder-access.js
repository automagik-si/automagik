import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const osBlocked = error => ['EACCES', 'EPERM', 'EROFS'].includes(error?.code)

// Check directory access, then write and read our own exclusive probe; never enumerate it.
export async function probeFolder(folder) {
  if (!folder) return undefined
  const path = join(folder, `.automagik-probe-${randomUUID()}`)
  let file
  try {
    await access(folder, constants.R_OK | constants.W_OK | constants.X_OK)
    file = await open(path, 'wx+', 0o600)
    await file.writeFile('Automagik folder access check\n')
    const bytes = Buffer.alloc(1)
    await file.read(bytes, 0, 1, 0)
    if (bytes[0] !== 65) throw new Error('Folder access check could not read its probe')
  } catch (error) {
    if (osBlocked(error)) return { folder, code: error.code }
    throw error
  } finally {
    if (file) {
      await file.close().catch(() => {})
      await unlink(path).catch(() => {})
    }
  }
}
