// Chromium's Linux sockets can survive exec. Close only inherited sockets, not runtime files.
const fs = require('node:fs')
const { join } = require('node:path')

function inheritedSockets({
  fdDir = '/proc/self/fd', infoDir = '/proc/self/fdinfo', keep = [],
} = {}) {
  const kept = new Set(keep)
  const sockets = []
  for (const name of fs.readdirSync(fdDir)) {
    if (!/^\d+$/.test(name)) continue
    const fd = Number(name)
    if (fd < 3 || kept.has(fd)) continue
    try {
      if (!/^socket:\[\d+\]$/.test(fs.readlinkSync(join(fdDir, name)))) continue
      const info = fs.readFileSync(join(infoDir, name), 'utf8')
      const flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1]
      if (flags && !(parseInt(flags, 8) & 0o2000000)) sockets.push(fd)
    } catch {
      // A descriptor may disappear while /proc is being read.
    }
  }
  return sockets
}

function closeInheritedSockets() {
  if (process.platform !== 'linux') return
  try {
    const keep = [0, 1, 2]
    const channel = process.env.NODE_CHANNEL_FD
    if (channel && /^\d+$/.test(channel)) keep.push(Number(channel))
    const channelFd = process.channel?.fd
    if (Number.isInteger(channelFd) && channelFd >= 0) keep.push(channelFd)
    for (const fd of inheritedSockets({ keep })) {
      try { fs.closeSync(fd) } catch {
        // EBADF and other close failures must not prevent the child from starting.
      }
    }
  } catch {
    // /proc may be unavailable. Cleanup must never prevent the child from starting.
  }
}

module.exports = { inheritedSockets, closeInheritedSockets }
