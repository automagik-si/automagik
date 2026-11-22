// Kernel lease shared by every image follower of the same mounted DSH home.
import { spawn } from 'node:child_process'
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export const VOLUME_LOCK = '.automagik-image-follow.lock'

export async function withVolumeLock(dshHome, work) {
  const release = await holdVolumeLease(dshHome, VOLUME_LOCK)
  try { return await work() } finally { release() }
}

export async function withProfileStateLock(dshHome, work) {
  const release = await holdVolumeLease(dshHome, '.automagik-profile-state.lock', 3)
  try { return await work() } finally { release() }
}

export async function holdVolumeLease(dshHome, name, waitSeconds = 180) {
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  // Keep the inode permanently: unlinking a released lock would let another process
  // acquire a different inode while a waiter still holds this one open.
  const fd = openSync(join(dshHome, name), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Unsupported image profile lock file')
    await new Promise((resolve, reject) => {
      // FD 3 and fd refer to the same open file description. flock's short-lived
      // helper acquires that description's lease; the parent retains it after exit.
      const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', String(waitSeconds), '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
      })
      child.once('error', () => reject(new Error('Image profile lock helper failed')))
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Image profile lock was not acquired')))
    })
    fchmodSync(fd, 0o600)
  } catch (error) {
    closeSync(fd)
    throw error
  }
  // Closing the last descriptor releases the lease, including on process death.
  return () => closeSync(fd)
}
