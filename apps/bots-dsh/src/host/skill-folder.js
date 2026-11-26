import fs from 'node:fs'
import { isAbsolute } from 'node:path'
import { SKILL_MD, pathOrder, skippedPath, treeError, treeRegistry, treeText } from './skill-tree.js'

const failed = () => treeError('The folder is unavailable or changed while it was read. Try again.')
const regular = path => treeError(`Only regular, single-link skill files and directories are allowed: ${path}`)
const { O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY, O_RDONLY } = fs.constants
// Node does not expose Linux O_PATH. Pin a leaf without opening it for I/O.
const O_PATH = 0o10000000
const statOptions = { bigint: true }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const unchanged = (a, b) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const fdPath = fd => `/proc/self/fd/${fd}`

// Linux procfs lets each lookup start from a pinned directory descriptor.
function openAt(path, before, directory, visit) {
  const flags = O_NOFOLLOW | (directory ? O_RDONLY | O_NONBLOCK | O_DIRECTORY : O_PATH)
  const fd = fs.openSync(path, flags)
  try {
    const opened = fs.fstatSync(fd, statOptions)
    if (directory ? !opened.isDirectory() || !same(opened, before)
      : !opened.isFile() || opened.nlink !== 1n || !unchanged(opened, before)) throw failed()
    return visit(fd, opened)
  } finally { fs.closeSync(fd) }
}

export function readSkillFolder(path) {
  if (process.platform !== 'linux' || !O_NOFOLLOW || !O_DIRECTORY || !O_NONBLOCK) {
    throw treeError('This host cannot safely read skill folders. Upload a .zip or .tar.gz instead.')
  }
  // Reject ambiguous lexical paths. The root and every ancestor must be directories.
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw failed()
  const components = path.split('/').filter(Boolean)
  if (!components.length || components.some(component => component === '.' || component === '..') || components.length > 256) throw failed()
  const registry = treeRegistry()
  const files = []
  const directories = new Map()
  let skipped = 0
  try {
    if (fs.statfsSync('/proc/self/fd').type !== 0x9fa0) throw failed()

    function walk(fd, relative, info) {
      directories.set(relative, info)
      const dir = fs.opendirSync(fdPath(fd), { encoding: 'buffer', bufferSize: 1 })
      try {
        for (let entry; (entry = dir.readSync());) {
          const leaf = entry.name.toString('utf8')
          if (!Buffer.from(leaf).equals(entry.name)) throw treeError('A skill folder contains a filename outside UTF-8.')
          const name = relative ? `${relative}/${leaf}` : leaf
          const child = `${fdPath(fd)}/${leaf}`
          const before = fs.lstatSync(child, statOptions)
          const folder = before.isDirectory()
          if (!folder && (!before.isFile() || before.nlink !== 1n)) throw regular(name)
          registry.register(name, folder, Number(before.size))
          if (skippedPath(name)) {
            if (!folder) skipped++
          } else if (folder) {
            openAt(child, before, true, (sub, opened) => walk(sub, name, opened))
          } else {
            registry.kept()
            files.push({ path: name, before })
          }
        }
      } finally { dir.closeSync() }
      if (!unchanged(fs.fstatSync(fd, statOptions), info)) throw failed()
    }

    function atDirectory(fd, segments, relative, visit) {
      if (!segments.length) return visit(fd)
      const [leaf, ...rest] = segments
      const name = relative ? `${relative}/${leaf}` : leaf
      const child = `${fdPath(fd)}/${leaf}`
      const info = directories.get(name)
      if (!unchanged(fs.lstatSync(child, statOptions), info)) throw failed()
      return openAt(child, info, true, (sub, opened) => {
        if (!unchanged(opened, info)) throw failed()
        return atDirectory(sub, rest, name, visit)
      })
    }

    function read(root, info) {
      walk(root, '', info)
      if (!files.some(file => file.path === SKILL_MD)) throw treeError('Choose a folder with a root SKILL.md.')
      const entries = files.map(({ path, before }) => {
        const parts = path.split('/')
        const leaf = parts.pop()
        return atDirectory(root, parts, '', fd => {
          const child = `${fdPath(fd)}/${leaf}`
          const current = fs.lstatSync(child, statOptions)
          if (!current.isFile() || current.nlink !== 1n || !unchanged(current, before)) throw failed()
          return openAt(child, before, false, pinned => {
            const file = fs.openSync(fdPath(pinned), O_RDONLY | O_NONBLOCK)
            try {
              const opened = fs.fstatSync(file, statOptions)
              if (!opened.isFile() || opened.nlink !== 1n || !unchanged(opened, before)) throw failed()
              const bytes = Buffer.alloc(Number(before.size))
              for (let offset = 0; offset < bytes.length;) {
                const count = fs.readSync(file, bytes, offset, bytes.length - offset)
                if (!count) throw failed()
                offset += count
              }
              if (fs.readSync(file, Buffer.alloc(1)) || !unchanged(fs.fstatSync(file, statOptions), before)) throw failed()
              treeText(bytes, path)
              return { path, bytes }
            } finally { fs.closeSync(file) }
          })
        })
      })
      for (const name of directories.keys()) {
        atDirectory(root, name ? name.split('/') : [], '', fd => {
          if (!unchanged(fs.fstatSync(fd, statOptions), directories.get(name))) throw failed()
        })
      }
      return { entries: entries.sort((a, b) => pathOrder(a.path, b.path)), skipped, folderName: components.at(-1) }
    }

    function descend(parent, index) {
      const child = `${fdPath(parent)}/${components[index]}`
      const before = fs.lstatSync(child, statOptions)
      if (!before.isDirectory()) throw failed()
      const result = openAt(child, before, true, (fd, opened) =>
        index === components.length - 1 ? read(fd, opened) : descend(fd, index + 1))
      if (!same(fs.lstatSync(child, statOptions), before)) throw failed()
      return result
    }

    return openAt('/', fs.lstatSync('/', statOptions), true, fd => descend(fd, 0))
  } catch (error) {
    if (error.code === 'bot/invalid') throw error
    throw failed()
  }
}
