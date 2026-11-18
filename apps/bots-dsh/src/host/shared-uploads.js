// Store-backed copies belong to the Bot a picture was sent to, never to the team.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { HISTORY_PAGES_MAX } from './constants.js'
import { refusal } from './refusal.js'

const MAX_BYTES = 64 * 1024 * 1024
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif' }
const FILE_TOOLS = { read: 'file_path', write: 'file_path', edit: 'file_path', read_image: 'file_path', str_replace_editor: 'path' }
const SEARCH_TOOLS = ['glob', 'grep']
const SHELL_TOOLS = ['bash', 'pwsh', 'terminal_open', 'terminal_send']
const strings = value => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])
const hexOf = ref => /^sha256:[a-f0-9]{64}$/.test(ref?.attachmentId) ? ref.attachmentId.slice(7) : undefined
// Windows and macOS file systems ignore case, so a Bot's id does too (private-bots.js folds
// them the same way); on linux two names in different case are two different folders.
const fold = text => (process.platform === 'linux' ? text : text.toLowerCase())
// resolve() collapses `name/../` for the path tools; shell text goes through the same collapse,
// one shell word at a time: the segment before `..` cannot reach across whitespace or a delimiter.
const parentSegment = /\/(?!\.\.?(?=$|[\s/;&|#<>()]))[^\s/;&|#<>()]+\/\.\.(?=$|[\s/;&|#<>()])/g
const collapse = text => {
  let flat = text
  for (let next = flat.replace(parentSegment, ''); next !== flat; next = flat.replace(parentSegment, '')) flat = next
  return flat
}
// The words a shell command spells out that look like a path. The check that uses them is
// best effort, not a fence: a word carrying a shell character is left alone, so a path the
// shell builds or expands ($VAR, $(...), a glob, ~), a folder the command changes into
// first, and a file a script opens are known misses. Only the words written out are resolved.
const shellPathWord = /[\\/]/
const shellExpanded = /[$`(){}[\]*?~]/
// Shell-style words: quotes group, and on POSIX a backslash escapes the next character, so a
// quoted or escaped path with spaces stays one word. Unquoted whitespace or a command
// separator ends a word.
const shellWords = text => {
  const words = []
  let word = ''
  let quote = ''
  const end = () => { if (word !== '') words.push(word); word = '' }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (quote === "'") {
      if (char === "'") quote = ''
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = ''
      else if (char === '\\' && process.platform !== 'win32' && at + 1 < text.length) word += text[++at]
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '\\' && process.platform !== 'win32') {
      if (at + 1 < text.length) word += text[++at]
    } else if (/[\s;&|<>]/.test(char)) {
      end()
    } else {
      word += char
    }
  }
  end()
  return words
}
// A flag keeps its value as a path too, so --file=<path> is checked like the path itself.
const shellFlagValue = word => /^-+[^=]+=/.test(word) ? [word, word.slice(word.indexOf('=') + 1)] : [word]
const shellPaths = text => shellWords(text).flatMap(shellFlagValue)
  .map(word => word.replace(/\\/g, '/'))
  .filter(word => shellPathWord.test(word) && !shellExpanded.test(word) && !word.includes('://'))

export function uploadLeaf(ref, kind) {
  const name = ref.name ?? (kind === 'image' ? `image.${extensions[ref.mediaType]}` : 'file')
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' &&
    !/[\\/]/.test(name) && !name.includes('\0') ? name : 'file'
}

// Only these durable sources convey a picture. Copies and path text convey no authority.
export function pictureGrant(rt, message, bot) {
  const source = message?.source
  if (message?.role !== 'user' || source?.handoff) return undefined
  if (source?.kind === 'user' || source?.kind === 'retry') return 'user'
  if (source?.kind !== 'bot' || source.form !== 'relay') return undefined
  if (source.role === 'room' && source.roomId) return bot?.private === true ? undefined : 'room'
  const sender = rt.botOf?.(source.senderSessionId)
  if (source.forwarded?.v === 1 && sender) return 'forward'
  return undefined
}

export function uploadOsText(name, folder) {
  return `${JSON.stringify(name)} could not be saved as a file for you: the operating system refused access to ${JSON.stringify(folder)}. Tell the user to allow Automagik to use that folder (on macOS: System Settings > Privacy & Security > Files and Folders, or Full Disk Access; elsewhere, make the folder writable for their user).`
}
const displayName = name => typeof name === 'string' && name.replace(/\p{Cc}/gu, '').slice(0, 120) || 'unnamed picture'

async function bounded(work, signal) {
  signal.throwIfAborted()
  let stop
  const cancelled = new Promise((_, reject) => {
    stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(work), cancelled]) } finally {
    signal.removeEventListener('abort', stop)
  }
}

async function directory(path, create = false) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe upload directory.')
}
async function ignore(folder) {
  let file
  try {
    file = await open(join(folder, '.gitignore'), 'wx', 0o600)
    await file.writeFile('*\n')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await lstat(join(folder, '.gitignore'))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe upload ignore file.')
  } finally { await file?.close() }
}
async function same(path, written) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.ino !== written.ino || stat.dev !== written.dev) throw new Error('Upload copy changed.')
}
async function removeOwn(path, created) {
  if (!created) return
  try {
    const stat = await lstat(path)
    if (stat.isFile() && stat.ino === created.ino && stat.dev === created.dev) await unlink(path)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

export function install(rt) {
  const { ctx } = rt
  const granted = new Map()
  const historyImages = new Map()
  const pending = new Map()
  const owner = id => rt.botOfSession(id)
  const workingFolder = (sessionId, bot) => rt.workDirOf({ botId: bot.id, roomId: rt.groupOwners?.get(sessionId)?.roomId }) ?? rt.teamFolder()
  async function regionFor(sessionId) {
    const bot = owner(sessionId)
    if (!bot || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bot.id)) return undefined
    const folder = workingFolder(sessionId, bot)
    if (typeof folder !== 'string' || !isAbsolute(folder)) return undefined
    return join(await realpath(folder), '.automagik', 'bots', bot.id, 'uploads')
  }
  function grantedTo(sessionId) {
    const bot = owner(sessionId)
    if (!bot) return undefined
    if (!granted.has(bot.id)) granted.set(bot.id, new Set())
    return granted.get(bot.id)
  }
  async function checkDirectories(region, hex, create = false) {
    const folder = resolve(region, '../../../..')
    await directory(folder)
    let at = folder
    for (const part of ['.automagik', 'bots', region.split(/[\\/]/).at(-2), 'uploads', hex]) {
      at = join(at, part)
      await directory(at, create)
      if (create && (part === 'bots' || part === 'uploads')) await ignore(at)
    }
    if (await realpath(at) !== at) throw new Error('Unsafe upload directory.')
  }
  async function holds(botId, hex) {
    if (!/^[a-f0-9]{64}$/.test(hex)) return false
    try {
      const region = await regionFor(rt.chatOf(botId))
      if (!region) return false
      await checkDirectories(region, hex)
      for (const name of await readdir(join(region, hex))) {
        if (name.startsWith('.upload-')) continue
        try {
          if (await existing(join(region, hex, name), { attachmentId: `sha256:${hex}` })) return true
        } catch { /* A bad entry cannot hide a verified copy beside it. */ }
      }
      return false
    } catch { return false }
  }
  async function existing(path, ref, signal) {
    let file
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0))
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || (ref.bytes !== undefined && stat.size !== ref.bytes)) throw new Error('Unsafe upload copy.')
      const hash = createHash('sha256')
      for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk)
      if (`sha256:${hash.digest('hex')}` !== ref.attachmentId) throw new Error('Upload copy has different bytes.')
      await same(path, stat)
      const after = await file.stat()
      if (after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) throw new Error('Upload copy changed.')
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    } finally { await file?.close() }
  }
  async function writeCopy(ref, opts, region, path, signal) {
    const hex = hexOf(ref)
    let file, temp, created, written
    try {
      signal.throwIfAborted()
      await checkDirectories(region, hex, true)
      if (await existing(path, ref, signal)) {
        if (await regionFor(opts.sessionId) !== region) throw new Error('Upload owner moved.')
        return { path }
      }
      temp = join(dirname(path), `.upload-${randomUUID()}`)
      await checkDirectories(region, hex)
      file = await open(temp, 'wx', 0o600)
      created = await file.stat()
      let data = opts.data
      if (data === undefined) {
        const typed = { attachmentId: ref.attachmentId, bytes: ref.bytes, mediaType: ref.mediaType, width: ref.width, height: ref.height }
        const stored = await bounded(() => ctx.get('attachments').readImage(typed, signal), signal).catch(error => {
          throw Object.assign(new Error('DSH image store read failed', { cause: error }), { storeCode: error.code })
        })
        if (!(stored?.data instanceof Uint8Array) || ['attachmentId', 'bytes', 'mediaType', 'width', 'height'].some(key => stored.ref?.[key] !== ref[key])) throw new Error('Image reference changed.')
        data = stored.data
      }
      if (!(data instanceof Uint8Array) || data.byteLength !== ref.bytes || createHash('sha256').update(data).digest('hex') !== hex) throw new Error('Upload integrity verification failed.')
      signal.throwIfAborted()
      await file.writeFile(data)
      await file.chmod(0o444)
      written = await file.stat()
      await file.close()
      file = undefined
      await checkDirectories(region, hex)
      if (await regionFor(opts.sessionId) !== region) throw new Error('Upload owner moved.')
      signal.throwIfAborted()
      if (!await existing(path, ref, signal)) {
        await checkDirectories(region, hex)
        signal.throwIfAborted()
        await same(temp, written)
        let linked = false
        try {
          await link(temp, path)
          linked = true
          await same(path, written)
        } catch (error) {
          if (linked) await removeOwn(path, created)
          if (error.code !== 'EEXIST') throw error
          if (!await existing(path, ref, signal)) throw new Error('Upload copy changed.')
        }
      }
    } finally {
      await file?.close()
      if (temp) await removeOwn(temp, created)
    }
    // The temporary hard link is gone before nlink is checked.
    if (!await existing(path, ref, signal)) throw new Error('Upload copy disappeared.')
    return { path }
  }
  async function save(ref, opts = {}) {
    let folder, bot
    try {
      bot = owner(opts.sessionId)
      if (!bot) return { error: 'other', folder }
      folder = workingFolder(opts.sessionId, bot)
      const hex = hexOf(ref)
      if (!hex || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_BYTES) return { error: 'other', folder }
      const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(10_000)])
      return await bounded(async () => {
        const region = await regionFor(opts.sessionId)
        if (!region) return { error: 'other', folder }
        const path = join(region, hex, uploadLeaf({ ...ref, name: opts.name ?? ref.name }, 'image'))
        if (!pending.has(path)) {
          const work = writeCopy({ ...ref }, opts, region, path, signal).catch(error => {
            if (error.storeCode) {
              rt.warn('ds-bot: DSH image store read failed: %s', error.storeCode)
              return { error: 'store', code: error.storeCode }
            }
            if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
              rt.warn('ds-bot: upload %s not saved for %s: the system refused access to %s', hex.slice(0, 12), bot.id, folder)
              return { error: 'os', folder }
            }
            rt.warn('ds-bot: upload %s not saved for %s', hex.slice(0, 12), bot.id)
            return { error: 'other', folder }
          }).finally(() => pending.delete(path))
          pending.set(path, work)
        }
        return pending.get(path)
      }, signal)
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
        rt.warn('ds-bot: upload %s not saved for %s: the system refused access to %s', hexOf(ref)?.slice(0, 12), bot?.id, folder)
        return { error: 'os', folder }
      }
      return { error: 'other', folder }
    }
  }
  async function withPaths(messages, sessionId, provider, signal) {
    const bot = owner(sessionId)
    if (!bot) return messages
    const seen = historyImages.get(bot.id) ?? new Set()
    historyImages.set(bot.id, seen)
    for (const message of messages) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const hex = block?.type === 'image' && hexOf(block.attachment)
        if (hex) seen.add(hex)
      }
    }
    if (provider === 'hermes-remote') return messages
    let changed = false
    const result = []
    for (const message of messages) {
      const grant = pictureGrant(rt, message, bot)
      if (!grant || !Array.isArray(message.content)) { result.push(message); continue }
      const content = []
      for (let i = 0; i < message.content.length; i++) {
        const block = message.content[i]
        content.push(block)
        const hex = block?.type === 'image' && hexOf(block.attachment)
        if (!hex) continue
        grantedTo(sessionId).add(hex)
        const saved = await save(block.attachment, { sessionId, signal })
        if (provider?.startsWith('local-') || (provider?.startsWith('acp-') && grant !== 'forward')) continue
        const next = message.content[i + 1]
        if (next?.type === 'text' && next.text.startsWith('[Saved picture sha256:')) continue
        const name = displayName(block.attachment.name)
        const text = saved.path ? `your read-only copy of ${JSON.stringify(name)} at ${JSON.stringify(saved.path)}. Your file tools can open it; to change it, make a new file in your working folder.`
          : saved.error === 'os' ? uploadOsText(name, saved.folder)
            : saved.error === 'store' ? `DSH's image store could not be read (${saved.code}).` : undefined
        if (text) content.push({ type: 'text', text: `[Saved picture sha256:${hex.slice(0, 12)}: ${text}]` })
      }
      if (content.length !== message.content.length) { changed = true; result.push({ ...message, content }) }
      else result.push(message)
    }
    return changed ? result : messages
  }

  // Reading a stored picture already in this Bot's history is not a new forward
  // or edit grant. Include offloaded images and earlier parts after a restart.
  async function inOwnHistory(botId, sessionId, hex, signal) {
    if (historyImages.get(botId)?.has(hex)) return true
    if (!rt.eventsBackwards) return false
    const ids = new Set([sessionId, ...(rt.partsOf?.(botId) ?? []).map(part => part.sessionId)])
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
    try {
      return await bounded(async () => {
        for (const id of ids) {
          for await (const event of rt.eventsBackwards(id, deadline, HISTORY_PAGES_MAX)) {
            deadline.throwIfAborted()
            const message = event.type === 'user/message' ? event.data
              : event.type === 'tool/result' ? event.data?.message : undefined
            if (message?.content?.some(block => block?.type === 'image' && hexOf(block.attachment) === hex)) return true
          }
        }
        return false
      }, deadline)
    } catch { return false }
  }

  // This is a tool-level guard, like private Bots. It does not inspect tools a coding agent
  // runs itself; the text it does see is checked as written and collapsed the way resolve()
  // collapses the path tools, and shell commands get a best-effort check of the path words
  // they spell out (see shellPaths), which is not a fence either.
  ctx.on('tools/execute', async (exec, next) => {
    const caller = rt.botOfSession(exec.agent?.session?.id ?? exec.agent?.id, exec.agent)
    if (!caller) return next()
    const args = exec.arguments ?? {}
    const flatten = text => text.replace(/["']/g, '').replace(/\\/g, '/').replace(/\/+/g, '/')
      .replace(/\/(?:\.\/)+/g, '/')
    const raw = flatten(strings(args).join('\n'))
    const closed = () => { throw refusal(`That picture was not sent to ${caller.name}, so it cannot open it. Ask the user to send it here, or ask the Bot that has it to forward it.`) }
    const closedFolder = () => { throw refusal(`That is another Bot's own folder, which ${caller.name} does not open. Ask the user, or that Bot, to share what you need.`) }
    // A case variant names the same Bot on a case-insensitive host; rt.botOf is a plain lookup.
    const botOfId = id => rt.botOf?.(id) ?? (process.platform === 'linux' ? undefined
      : Object.values(rt.state?.bots ?? {}).find(bot => fold(bot.id) === fold(id)))
    // Another Bot's own folder gets the folder words, with this shell check's limit: it is
    // best effort, not a fence.
    const closedShell = () => {
      throw refusal(`That is another Bot's own folder, which ${caller.name} does not open. Ask the user, or that Bot, to share what you need. Shell commands get a best-effort path check, not a fence: a path a command builds, a variable or glob it expands, or a file a script opens can still reach it.`)
    }
    // Before a shell command runs, real-path every word that looks like a path, from the
    // folder the command runs in. See shellPaths for the known misses: best effort, not a fence.
    async function checkShellPaths() {
      if (!SHELL_TOOLS.includes(exec.name)) return
      const folder = rt.sessionFolder(exec.agent?.session ?? exec.agent) ?? '.'
      // The folder as the file system has it: a link in the folder's own path is the same
      // folder for the command, so only a link inside a word can hide where a path leads.
      const base = rt.realBeyond ? await rt.realBeyond(folder) : folder
      for (const word of shellPaths(strings(args).join('\n'))) {
        const absolute = resolve(base, word)
        const real = rt.realBeyond ? await rt.realBeyond(absolute) : absolute
        // With no link followed, the text check below sees exactly this path, as written and
        // collapsed; this check adds only where a link hid the target from that text.
        if (flatten(real) === flatten(absolute)) continue
        for (const found of flatten(real).matchAll(/\.automagik\/bots\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/gi)) {
          if (fold(found[1]) === fold(caller.id) || botOfId(found[1]) === undefined) continue
          closedShell()
        }
      }
    }
    await checkShellPaths()
    async function inspect(flat) {
      // The bots root holds both a Bot's own folder, which is private, and the team's own
      // files and shared working folders (the state file, the registry, the workspace), which
      // are not. Only a Bot's own id is closed; matching every name under the root refused
      // commands that merely named a shared path, the Bot's own workspace included.
      for (const found of flat.matchAll(/\.automagik\/bots\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/gi)) {
        if (fold(found[1]) === fold(caller.id) || botOfId(found[1]) === undefined) continue
        closedFolder()
      }
      for (const found of flat.matchAll(/\.automagik\/uploads\/([a-f0-9]{64})(?:\/|$)/gi)) if (!await holds(caller.id, found[1].toLowerCase())) closed()
      for (const found of flat.matchAll(/objects\/([a-f0-9]{2})\/([a-f0-9]{62,64})(?![a-f0-9])/gi)) {
        const hex = (found[2].length === 64 ? found[2] : found[1] + found[2]).toLowerCase()
        if (!await holds(caller.id, hex) && !await inOwnHistory(caller.id, exec.agent?.session?.id ?? exec.agent?.id, hex, exec.signal)) closed()
      }
    }
    async function check(text) {
      const flat = flatten(text)
      // As written first, so a later `..` can never erase a path already in the text; then
      // collapsed, so a parent segment that hides one is revealed the way a shell runs it.
      await inspect(flat)
      const collapsed = collapse(flat)
      if (collapsed !== flat) await inspect(collapsed)
    }
    await check(raw)
    const folder = rt.sessionFolder(exec.agent?.session ?? exec.agent) ?? '.'
    const pattern = typeof args.pattern === 'string' ? args.pattern.replace(/[*?[{].*$/, '') : ''
    const paths = exec.name in FILE_TOOLS ? [args[FILE_TOOLS[exec.name]]]
      : SEARCH_TOOLS.includes(exec.name) ? [args.path ?? '.', pattern === '' ? undefined : resolve(folder, args.path ?? '.', pattern)]
        : SHELL_TOOLS.includes(exec.name) ? [] : [args.cwd, args.cd]
    for (const path of paths) {
      if (typeof path !== 'string' || !path) continue
      const absolute = resolve(folder, path)
      await check(absolute)
      // A link outside .automagik can lead into a Bot's own folder, so the real path is
      // checked even when the text names nothing closed.
      if (rt.realBeyond) await check(await rt.realBeyond(absolute))
    }
    return next()
  })
  rt.sharedUploads = { grantedTo, regionFor, save, withPaths, holds }
}
