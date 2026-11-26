import { fileHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { copyUpload, uploadLeaf } from './upload-files.js'

// Native images keep the candidate's all-or-nothing contract.
// Workspace copies fail to DSH's text fallback; only the store supplies bytes.
export const UPLOAD_PARAMS_BYTES = 24 * 1024 * 1024
// SDK 2.5 uses a numeric request id. This allowance covers its JSON-RPC wrapper and
// newline comfortably, keeping the complete request below the receiver's 32 MiB.
export const UPLOAD_ENVELOPE_BYTES = 1024
export const UPLOAD_IMAGES = 20
export const UPLOAD_READ_MS = 10_000
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const error = message => Object.assign(new Error(message), { code: 'acp_upload_content' })
const positive = value => Number.isSafeInteger(value) && value > 0

function reference(ref) {
  if (!ref || typeof ref.attachmentId !== 'string' || ref.attachmentId.length !== 71 ||
      !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) || !TYPES.has(ref.mediaType) ||
      !positive(ref.bytes) || !positive(ref.width) || !positive(ref.height)) {
    throw error('The uploaded image reference is invalid.')
  }
  // Snapshot the authority facts before awaiting a store. Display metadata is not authority.
  return Object.freeze({ attachmentId: ref.attachmentId, mediaType: ref.mediaType,
    bytes: ref.bytes, width: ref.width, height: ref.height })
}

const sizeOf = (sessionId, prompt) => Buffer.byteLength(JSON.stringify({ sessionId, prompt }))
function fits(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes > UPLOAD_PARAMS_BYTES ||
      bytes + UPLOAD_ENVELOPE_BYTES >= 32 * 1024 * 1024) {
    throw error('Uploaded images and text exceed the 24 MiB ACP prompt limit.')
  }
}

/** Recheck the exact params after the final asynchronous turn gates, before dispatch. */
export function checkUploadSize(sessionId, prompt) {
  fits(sizeOf(sessionId, prompt))
}

/** Prepare current uploads before any dispatch or replay consumption. */
export async function prepareUpload({ blocks, replay = [], run, attachments, cwd, signal,
  valid, warn = () => {}, timers = globalThis }) {
  valid()
  const images = run.init?.agentCapabilities?.promptCapabilities?.image === true
  const reader = attachments?.readImage
  let count = 0
  let encodedBytes = 0
  const refs = new Map()
  const copies = new Map()
  const prompt = [...replay, ...blocks.map(block => {
    if (block.type === 'file') {
      const text = { type: 'text', text: fileHandleText(block.attachment, undefined) }
      copies.set(text, block)
      return text
    }
    if (block.type !== 'image') return { type: 'text', text: block.text }
    if (++count > UPLOAD_IMAGES) {
      throw error('An ACP prompt can contain at most 20 uploaded images.')
    }
    const ref = reference(block.attachment)
    if (!images || block.copyOnly === true) {
      const text = { type: 'text', text: textOnlyImageText(ref) }
      copies.set(text, block)
      return text
    }
    if (typeof reader !== 'function') throw error('The uploaded image store is unavailable.')
    // Check each addition too: arithmetic cannot overflow into an accepted estimate.
    const bytes = 4 * Math.ceil(ref.bytes / 3)
    fits(bytes)
    encodedBytes += bytes
    fits(encodedBytes)
    const native = { type: 'image', data: '', mimeType: ref.mediaType }
    refs.set(native, ref)
    copies.set(native, block)
    return native
  })]
  fits(sizeOf(run.sessionId, prompt) + encodedBytes)

  const controller = new AbortController()
  const aborted = () => error('Uploaded image preparation was stopped.')
  let rejectWait
  const cancelled = new Promise((_, reject) => { rejectWait = reject })
  cancelled.catch(() => {})
  const stop = reason => { controller.abort(reason); rejectWait(reason) }
  const parentStop = () => stop(aborted())
  signal?.addEventListener('abort', parentStop, { once: true })
  const timer = timers.setTimeout(
    () => stop(error('Uploaded images were not read in time.')), UPLOAD_READ_MS)
  try {
    if (signal?.aborted) parentStop()
    const paths = new Map()
    for (const [block, input] of copies) {
      controller.signal.throwIfAborted()
      valid()
      const result = await Promise.race([
        copyUpload({ cwd, ref: input.attachment, kind: input.type,
          attachments, signal: controller.signal }), cancelled,
      ])
      valid()
      controller.signal.throwIfAborted()
      if (result.error) warn('Upload copy unavailable')
      if (input.type === 'file') {
        block.text = fileHandleText(input.attachment, result.path)
      } else if (result.path) {
        const ref = input.attachment
        const text = `[Image ${JSON.stringify(uploadLeaf(ref, 'image'))} ` +
          `(${ref.width}x${ref.height}px, ${ref.mediaType}): read-only copy saved at ` +
          `${JSON.stringify(result.path)}. Read that path with your file tools ` +
          'when you need the file itself.]'
        if (block.type === 'image') paths.set(block, { type: 'text', text })
        else block.text = text
      }
    }
    // A failed copy never prevents a supported image from being read natively.
    for (const [block, ref] of refs) {
      controller.signal.throwIfAborted()
      valid()
      // Race also handles readers that ignore AbortSignal; late rejections are observed.
      const read = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return Reflect.apply(reader, attachments, [ref, controller.signal])
      })
      const stored = await Promise.race([read, cancelled])
      valid()
      controller.signal.throwIfAborted()
      const actual = reference(stored?.ref)
      if (Object.keys(ref).some(key => ref[key] !== actual[key]) ||
          !(stored?.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes) {
        throw error('The uploaded image does not match its verified reference.')
      }
      block.data = Buffer.from(stored.data.buffer, stored.data.byteOffset,
        stored.data.byteLength).toString('base64')
    }
    const prepared = prompt.flatMap(block => paths.has(block) ? [block, paths.get(block)] : [block])
    checkUploadSize(run.sessionId, prepared)
    valid()
    return prepared
  } finally {
    timers.clearTimeout(timer)
    signal?.removeEventListener('abort', parentStop)
  }
}
