import { HISTORY_PAGES_MAX } from './constants.js'
import { MAX_IMAGE_BYTES } from './imagegen.js'
import { pictureGrant } from './shared-uploads.js'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { readResultFile, resultImageType } from './solver-progress.js'

const refused = message => Object.assign(new Error(message), { code: 'bot/unavailable' })
const missing = exhausted => Object.assign(refused("No picture the user attached in this chat matches that. Pass the picture's name as the chat shows it, its sha256, or the path of your own copy under .automagik/bots; a copy you made anywhere else does not count. If the user has not attached it here, ask them to. A Solver shows its own result pictures to its reviewer only in a designated RESULT review (message_bot with solver_review \"result\" and the file's path inside its result folder)."), { missing: exhausted })
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function matchesMagic(data, type) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (type === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
  return bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
}

async function bounded(work, signal) {
  let stop
  const cancelled = new Promise((_, reject) => {
    stop = () => reject(refused(signal.reason?.name === 'TimeoutError'
      ? 'The uploaded picture was not read in time.' : 'Reading the uploaded picture was stopped.'))
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    if (signal.aborted) stop()
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw refused('Reading the uploaded picture was stopped.')
      return work()
    }), cancelled])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** Only pictures durably sent to this Bot authorize an edit; selectors never authorize filesystem reads. */
export function createEditInput({ rt, ctx }) {
  async function findPicture(exec, selector, signal, { requireExhaustion = false } = {}) {
    if (typeof selector !== 'string' || !selector.trim() || selector.trim().length > 1024) {
      throw refused('Name the uploaded picture to edit (at most 1024 characters).')
    }
    const text = selector.trim()
    const full = text.match(/(?:^|[^a-z0-9_])([0-9a-f]{64})(?![a-z0-9_])/i)?.[1]
    const prefix = text.match(/sha256:([0-9a-f]{8,63})(?![0-9a-f])/i)?.[1]
    const name = text.replace(/^"(.*)"$/s, '$1')
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id
    const botId = rt.botOfSession(sessionId, exec.agent)?.id
    if (rt.roomOf(sessionId) !== undefined || rt.groupOwners?.get(sessionId) !== undefined) {
      throw refused('Editing a picture posted in a group chat is not available yet. Ask the user to send it to you in your own chat.')
    }
    const parts = botId === undefined ? [] : rt.partsOf(botId)
    const ids = parts.some(part => part.sessionId === sessionId)
      ? parts.map(part => part.sessionId).reverse() : [sessionId]
    const historySignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
    try {
      const { matches, exhausted } = await bounded(async () => {
        const found = new Map()
        let exhausted = 0
        for (const id of ids) {
          for await (const event of rt.eventsBackwards(id, historySignal, HISTORY_PAGES_MAX, () => exhausted++)) {
            historySignal.throwIfAborted()
            if (event.type !== 'user/message') continue
            const grant = pictureGrant(rt, { ...event.data, role: 'user' }, rt.botOfSession(sessionId, exec.agent))
            if (grant !== 'user' && grant !== 'forward') continue
            for (const block of Array.isArray(event.data.content) ? event.data.content : []) {
              const ref = block?.attachment
              if (block?.type !== 'image' || !/^sha256:[0-9a-f]{64}$/.test(ref?.attachmentId)) continue
              const match = full ? ref.attachmentId === `sha256:${full.toLowerCase()}`
                : prefix ? ref.attachmentId.startsWith(`sha256:${prefix.toLowerCase()}`) : ref.name === name
              if (match && !found.has(ref.attachmentId)) found.set(ref.attachmentId, { ...ref })
            }
          }
        }
        return { matches: [...found.values()], exhausted: exhausted === ids.length }
      }, historySignal)
      if (matches.length === 0) {
        if (requireExhaustion && !exhausted) throw refused('The upload history could not be searched completely. Name a picture from this chat or ask the user to attach it again.')
        throw missing(exhausted)
      }
      if (matches.length > 1) throw refused(`More than one picture matches: ${matches.map(ref => `${ref.attachmentId.slice(0, 19)} (${ref.name ?? 'unnamed picture'})`).join(', ')}. Ask the user which one, by sha256.`)
      return matches[0]
    } catch (error) {
      if (error?.code === 'bot/unavailable') throw error
      throw refused('The uploaded picture could not be read. Ask the user to attach it here again.')
    }
  }
  async function resolve(exec, selector, signal) {
    try {
      const held = await findPicture(exec, selector, signal)
      const ref = Object.freeze({ attachmentId: held.attachmentId, mediaType: held.mediaType,
        bytes: held.bytes, width: held.width, height: held.height })
      if (!TYPES.has(ref.mediaType)) throw refused('To edit this picture, convert it to PNG or JPEG first.')
      if (!Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > MAX_IMAGE_BYTES) {
        throw refused('The uploaded picture is too large or has an invalid size.')
      }
      let store
      try { store = ctx.get('attachments') } catch {}
      if (typeof store?.readImage !== 'function') throw refused('This Automagik cannot read uploaded pictures.')
      const readSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
      const stored = await bounded(() => store.readImage(ref, readSignal), readSignal)
      if (Object.keys(ref).some(key => stored?.ref?.[key] !== ref[key]) ||
          !(stored?.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes ||
          !matchesMagic(stored.data, ref.mediaType)) {
        throw refused('The uploaded picture does not match its verified reference.')
      }
      return { ref, data: stored.data, mediaType: ref.mediaType, name: held.name }
    } catch (error) {
      if (error?.code === 'bot/unavailable') throw error
      throw refused('The uploaded picture could not be read. Ask the user to attach it here again.')
    }
  }
  return { resolve, findPicture }
}

export function readResultPicture(folder, { bot, selector, signal, allowPath, teamWorkspace }) {
  try {
    const { bytes, path } = readResultFile(folder, selector, { botId: bot.id, maxBytes: MAX_IMAGE_BYTES, signal, allowPath, teamWorkspace })
    const mediaType = resultImageType(bytes)
    if (!mediaType) throw refused('Convert the result picture to PNG, JPEG or WebP.')
    const digest = createHash('sha256').update(bytes).digest('hex')
    return { path, digest, image: { mediaType, data: bytes, name: basename(path) } }
  } catch (error) {
    if (error.code === 'bot/unavailable') throw error
    throw refused(error.reason ?? (signal?.aborted ? 'Reading the result picture was stopped.'
      : 'The result picture could not be read. Use a regular picture inside the result folder.'))
  }
}
