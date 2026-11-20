// RFC 0033 upload limits, byte ingress and the socket host's upload registry. DSH owns
// stored images, variants, documents and receipts; the registry owns admission charges and
// separate image-only and document-bearing Retry manifests.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MiB = 1024 * 1024
export const ATTACH_METHODS = Object.freeze(['upload-begin', 'upload-chunk', 'upload-finish', 'upload-cancel', 'attachment-read'])
export const ATTACH_REQUEST_PREFIX = 'pocket-a/'
export const UPLOAD_ID = /^[A-Za-z0-9._:-]{1,128}$/
export const CHUNK_BYTES = 24 * 1024
export const DEVICE_OUTSTANDING = 32 * MiB
export const DEVICE_DAILY_BYTES = 256 * MiB
export const DEVICE_DAILY_COUNT = 128
export const DAY_MS = 24 * 60 * 60 * 1000
export const IDLE_MS = 30_000
export const TOTAL_MS = 180_000
export const ADMISSION_MS = 60_000
export const UNSENT_MS = 15 * 60 * 1000
export const READ_MS = 15_000
export const READ_LINE_BYTES = 192 * 1024
export const THUMBNAILS = Object.freeze([Object.freeze({ edge: 512, bytes: 128 * 1024 }), Object.freeze({ edge: 256, bytes: 64 * 1024 })])
const HOST_DAILY_BYTES = 1024 * MiB
const HOST_DAILY_COUNT = 512
const DISK_FLOOR = 2n * 1024n * BigInt(MiB)
const MAX_PHONES = 64
const MAX_MANIFESTS = 64
const HEADER_BYTES = 64 * 1024
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const DOCUMENT_EXTENSIONS = new Map([['text/plain', '.txt'], ['application/pdf', '.pdf']])
const DOCUMENT_OFFER = Object.freeze({ mediaTypes: Object.freeze([...DOCUMENT_EXTENSIONS.keys()]), limits: Object.freeze({ fileBytes: 8 * MiB }) })
const FILES_UNSUPPORTED = 'ATTACHMENT_FILES_UNSUPPORTED'
const DOCUMENT_REASONS = new Set([FILES_UNSUPPORTED, 'SUBAGENT_FILE_UNSUPPORTED'])
const IMAGE_REASONS = new Set(['IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE', 'UNSUPPORTED_IMAGE_TYPE', 'INVALID_IMAGE'])
const HASH = /^[a-f0-9]{64}$/
const REQUEST_ID = /^pocket-a\/[a-f0-9]{40}$/
const timers = { setTimeout, clearTimeout }

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const validId = value => typeof value === 'string' && UPLOAD_ID.test(value)
export const positiveInt = value => Number.isSafeInteger(value) && value > 0
export const uploadRefusal = reason => ({ ok: false, state: 'refused', reason })
export const isDocumentType = type => DOCUMENT_EXTENSIONS.has(type)
export const attachmentCode = (error, prompt = false) => {
  const code = error?.details?.reason
  return IMAGE_REASONS.has(code) || code === 'timeout' || (prompt && ['MODEL_DOES_NOT_SUPPORT_IMAGES', 'FILE_NOT_STAGED'].includes(code)) ? code : undefined
}

export function effectiveAttachments(limits, documents = false) {
  if (!limits || !Array.isArray(limits.mediaTypes)) return
  const mediaTypes = MEDIA_TYPES.filter(type => limits.mediaTypes.includes(type))
  const fileBytes = Math.min(8 * MiB, limits.maxImageBytes, limits.maxMessageImageBytes)
  const files = Math.min(4, limits.maxImagesPerMessage)
  const messageBytes = Math.min(16 * MiB, limits.maxMessageImageBytes)
  const maxPixels = Math.min(40e6, limits.maxImagePixels)
  const { maxImageDimension: maxDimension } = limits
  if (!mediaTypes.length || ![fileBytes, files, messageBytes, maxPixels, maxDimension].every(positiveInt)) return
  return {
    version: 1, methods: ATTACH_METHODS, mediaTypes,
    limits: { fileBytes, files, messageBytes, deviceOutstanding: DEVICE_OUTSTANDING, deviceDailyBytes: DEVICE_DAILY_BYTES,
      deviceDailyCount: DEVICE_DAILY_COUNT, chunkBytes: CHUNK_BYTES, maxPixels, maxDimension, thumbnail: THUMBNAILS[0] },
    ...(documents ? { documents: DOCUMENT_OFFER } : {}),
  }
}

const basename = name => name.split(/[/\\]/).at(-1)
const stripControls = name => name.replace(/[\p{Cc}\p{Cf}]/gu, '')
const trimStem = name => name.replace(/[. ]+$/, '')
const usableName = name => name && name !== '.' && name !== '..'

function cutName(name, limit) {
  let clean = ''
  let bytes = 0
  for (const char of name) {
    bytes += Buffer.byteLength(char)
    if (bytes > limit) break
    clean += char
  }
  return clean
}

export function sanitizeAttachmentName(name) {
  if (typeof name !== 'string') return
  const leaf = cutName(stripControls(basename(name).toWellFormed()), 128)
  return usableName(leaf) ? leaf : undefined
}

function documentLeaf(params) {
  const extension = DOCUMENT_EXTENSIONS.get(params.mediaType)
  if (!Object.hasOwn(params, 'name')) return `document${extension}`
  const { name } = params
  if (typeof name !== 'string' || Buffer.byteLength(name) > 1024 || !name.isWellFormed()) return
  let stem = trimStem(stripControls(basename(name)).normalize('NFC').replace(/[<>:"|?*]/g, '_').trim())
  if (stem.toLowerCase().endsWith(extension)) stem = stem.slice(0, -extension.length)
  do { stem = cutName(stem, 124).normalize('NFC') } while (Buffer.byteLength(stem) > 124)
  stem = trimStem(stem)
  if (!usableName(stem)) stem = 'document'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimStem(stem.split('.')[0]))) {
    stem = trimStem(cutName(`_${stem}`, 124))
  }
  return stem + extension
}

const dimensions = (width, height) => positiveInt(width) && positiveInt(height) ? { width, height } : 'unsupported'
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex')
const jpegMagic = Buffer.from('ffd8ff', 'hex')
const pdfMagic = Buffer.from('%PDF-')
const matches = (data, at, value) => data.subarray(at, at + value.length).equals(value)
function jpegDimensions(data) {
  for (let at = 2; at < data.length;) {
    if (data[at++] !== 0xff) return 'unsupported'
    while (data[at] === 0xff) at++
    if (at >= data.length) return
    const marker = data[at++]
    if (marker === 0x01) continue
    if (marker < 0xc0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda || (marker >= 0xd0 && marker <= 0xd7)) return 'unsupported'
    if (at + 2 > data.length) return
    const length = data.readUInt16BE(at)
    if (length < 2) return 'unsupported'
    if (marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return 'unsupported'
      if (at + length > data.length) return
      return dimensions(data.readUInt16BE(at + 5), data.readUInt16BE(at + 3))
    }
    at += length
  }
}

function webpDimensions(data) {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return 'unsupported'
  for (let at = 12; at + 8 <= data.length;) {
    const kind = data.toString('ascii', at, at + 4)
    const length = data.readUInt32LE(at + 4)
    at += 8
    if (kind === 'VP8X') {
      if (length !== 10 || at + 10 > data.length) return 'unsupported'
      return dimensions(1 + data.readUIntLE(at + 4, 3), 1 + data.readUIntLE(at + 7, 3))
    }
    if (kind === 'VP8L') {
      if (length < 5 || at + 5 > data.length || data[at] !== 0x2f) return 'unsupported'
      const bits = data.readUInt32LE(at + 1)
      return dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff))
    }
    if (kind === 'VP8 ') {
      if (length < 10 || at + 10 > data.length || (data[at] & 1) || data.readUIntBE(at + 3, 3) !== 0x9d012a) return 'unsupported'
      return dimensions(data.readUInt16LE(at + 6) & 0x3fff, data.readUInt16LE(at + 8) & 0x3fff)
    }
    at += length + (length % 2)
  }
  return 'unsupported'
}

export function sniffImage(data, mediaType, final) {
  switch (mediaType) {
    case 'image/png':
      if (data.length < 33 || !matches(data, 0, pngMagic) || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return 'unsupported'
      return dimensions(data.readUInt32BE(16), data.readUInt32BE(20))
    case 'image/webp':
      return webpDimensions(data)
    case 'image/jpeg': {
      if (!matches(data, 0, jpegMagic)) return 'unsupported'
      return jpegDimensions(data) ?? (final || data.length >= HEADER_BYTES ? 'unsupported' : undefined)
    }
    default:
      return 'unsupported'
  }
}

const exceedsDimensions = ({ width, height }, { maxDimension, maxPixels }) => Math.max(width, height) > maxDimension || width * height > maxPixels

// A second pull acknowledges the preceding chunk, including the last one. Credit reopens
// after writing the ack, and EOF is only supplied by finish.
function ingress() {
  let item
  let pull
  let ended = false
  let error
  const deliver = () => {
    if (!pull) return
    if (error) pull.reject(error)
    else if (ended) pull.resolve({ done: true })
    else if (item) {
      item.taken = true
      pull.resolve({ value: item.data, done: false })
      item.data = undefined
    } else return
    pull = undefined
  }
  return {
    busy: () => item !== undefined,
    push(data, reply) { item = { data, reply, taken: false }; deliver() },
    end() { ended = true; deliver() },
    abort(result) {
      error = new Error('Pocket upload ended')
      item?.reply(result)
      item = undefined
      deliver()
    },
    iterator: {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (item?.taken) {
          item.reply()
          item = undefined
        }
        if (pull) return Promise.reject(new Error('Concurrent Pocket upload pull'))
        return new Promise((resolve, reject) => { pull = { resolve, reject }; deliver() })
      },
    },
  }
}

const timeIsValid = time => Number.isSafeInteger(time) && time >= 0
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hashIsValid = value => typeof value === 'string' && HASH.test(value)
function manifestIsValid(manifest, phoneHash) {
  return isObject(manifest) && manifest.phoneHash === phoneHash && validId(manifest.id)
    && typeof manifest.requestId === 'string' && REQUEST_ID.test(manifest.requestId)
    && typeof manifest.sessionId === 'string' && manifest.sessionId !== '' && !manifest.sessionId.includes('\0')
    && hashIsValid(manifest.textHash) && timeIsValid(manifest.at)
    && Array.isArray(manifest.uploadIds) && manifest.uploadIds.length >= 1 && manifest.uploadIds.length <= 4
    && manifest.uploadIds.every(validId) && new Set(manifest.uploadIds).size === manifest.uploadIds.length
    && Array.isArray(manifest.receiptIds) && manifest.receiptIds.length === manifest.uploadIds.length
    && manifest.receiptIds.every(id => typeof id === 'string' && id !== '' && !id.includes('\0'))
}

const documentManifestIsValid = (manifest, hash) => manifestIsValid(manifest, hash)
  && Array.isArray(manifest.kinds) && manifest.kinds.length === manifest.uploadIds.length
  && manifest.kinds.every(kind => kind === 'image' || kind === 'document') && manifest.kinds.includes('document')

const manifestsAreValid = (manifests, validate) => Array.isArray(manifests) && manifests.length <= MAX_MANIFESTS
  && manifests.every(validate) && new Set(manifests.map(manifest => manifest.id)).size === manifests.length

const storeIsValid = data => isObject(data) && isObject(data.phones)
  && (!Object.hasOwn(data, 'brokenAt') || timeIsValid(data.brokenAt))

const documentsAreValid = data => storeIsValid(data) && Object.entries(data.phones).every(([hash, manifests]) =>
  hashIsValid(hash) && manifestsAreValid(manifests, manifest => documentManifestIsValid(manifest, hash)))

function ledgerIsValid(data) {
  if (!storeIsValid(data)) return false
  const phones = Object.entries(data.phones)
  return phones.length <= MAX_PHONES && phones.every(([hash, phone]) => hashIsValid(hash)
    && isObject(phone) && timeIsValid(phone.lastCharge)
    && Array.isArray(phone.charges) && phone.charges.length <= DEVICE_DAILY_COUNT
    && phone.charges.every(charge => isObject(charge) && timeIsValid(charge.at) && charge.at <= phone.lastCharge
      && positiveInt(charge.bytes) && charge.bytes <= 8 * MiB)
    && manifestsAreValid(phone.manifests, manifest => manifestIsValid(manifest, hash) && !Object.hasOwn(manifest, 'kinds')))
}

function syncFile(path, flags, write) {
  const fd = openSync(path, flags, 0o600)
  try { write?.(fd); fsyncSync(fd) } finally { closeSync(fd) }
}

class UploadStore {
  constructor(path, now, log, validate, unreadable) {
    Object.assign(this, { path, now, log, validate, unreadable })
  }

  load() {
    if (this.data) return this.data
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'))
      if (this.validate(data)) return (this.data = data)
    } catch (error) {
      if (!this.quarantine && error?.code === 'ENOENT') {
        // A crash can leave the quarantine file just before its replacement was published.
        try { lstatSync(`${this.path}.bad`) } catch (missing) {
          if (missing?.code === 'ENOENT') return (this.data = { phones: {} })
        }
      }
    }
    // Do not reopen a daily allowance on corruption, even across a restart.
    if (!this.quarantine) {
      this.quarantine = { brokenAt: this.now(), phones: {} }
      this.log(this.unreadable)
    }
    this.save(this.quarantine, () => {
      try { renameSync(this.path, `${this.path}.bad`) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    })
    return this.data
  }

  save(data, beforeReplace) {
    const tmp = `${this.path}.${randomUUID()}.tmp`
    try {
      syncFile(tmp, 'wx', fd => writeFileSync(fd, JSON.stringify(data)))
      beforeReplace?.()
      renameSync(tmp, this.path)
      syncFile(dirname(this.path), 'r')
      this.data = data
    } finally {
      try { unlinkSync(tmp) } catch {}
    }
  }

  recent(at, now = this.now()) { return now - at < DAY_MS }

  broken(now = this.now()) {
    try {
      const { brokenAt } = this.load()
      return brokenAt !== undefined && this.recent(brokenAt, now)
    } catch (error) {
      if (this.quarantine && this.recent(this.quarantine.brokenAt, now)) return true
      throw error
    }
  }
}

export class UploadLedger extends UploadStore {
  constructor(path, now, log) { super(path, now, log, ledgerIsValid, 'pocket upload: ledger unreadable') }

  prune(now = this.now()) {
    const { brokenAt, phones } = this.load()
    return {
      ...(brokenAt !== undefined && this.recent(brokenAt, now) ? { brokenAt } : {}),
      phones: Object.fromEntries(Object.entries(phones).map(([hash, phone]) => [hash, {
        lastCharge: phone.lastCharge, charges: phone.charges.filter(charge => this.recent(charge.at, now)),
        manifests: phone.manifests.filter(manifest => this.recent(manifest.at, now)),
      }])),
    }
  }

  charge(phoneHash, bytes) {
    const at = this.now()
    const data = this.prune(at)
    if (data.brokenAt !== undefined) return 'quota'
    const charges = Object.values(data.phones).flatMap(phone => phone.charges)
    const device = data.phones[phoneHash]?.charges ?? []
    if (charges.length >= HOST_DAILY_COUNT || charges.reduce((sum, charge) => sum + charge.bytes, bytes) > HOST_DAILY_BYTES
      || device.length >= DEVICE_DAILY_COUNT || device.reduce((sum, charge) => sum + charge.bytes, bytes) > DEVICE_DAILY_BYTES) return 'quota'
    if (!data.phones[phoneHash]) {
      const phones = Object.entries(data.phones)
      if (phones.length >= MAX_PHONES) {
        const oldest = phones.reduce((a, b) => a[1].lastCharge <= b[1].lastCharge ? a : b)
        if (this.recent(oldest[1].lastCharge, at)) return 'quota'
        delete data.phones[oldest[0]]
      }
      data.phones[phoneHash] = { charges: [], manifests: [] }
    }
    const phone = data.phones[phoneHash]
    phone.lastCharge = Math.max(at, phone.lastCharge ?? 0)
    phone.charges.push({ at, bytes })
    this.save(data)
  }

  manifests(phoneHash) {
    return (this.load().phones[phoneHash]?.manifests ?? []).filter(manifest => this.recent(manifest.at))
  }

  record(manifest) {
    const data = this.prune()
    const phone = data.phones[manifest.phoneHash]
    if (data.brokenAt !== undefined || !phone || !manifestIsValid(manifest, manifest.phoneHash) || Object.hasOwn(manifest, 'kinds')) throw new Error('Pocket manifest unavailable')
    phone.manifests = [...phone.manifests, manifest].slice(-MAX_MANIFESTS)
    this.save(data)
  }
}

class DocumentManifests extends UploadStore {
  constructor(path, now, log) { super(path, now, log, documentsAreValid, 'pocket upload: document manifests unreadable') }

  manifests(phoneHash) {
    return (this.load().phones[phoneHash] ?? []).filter(manifest => this.recent(manifest.at))
  }

  record(manifest) {
    const { phoneHash } = manifest
    if (this.broken() || !documentManifestIsValid(manifest, phoneHash)) throw new Error('Pocket manifest unavailable')
    const phones = Object.fromEntries(Object.keys(this.load().phones).map(hash => [hash, this.manifests(hash)])
      .filter(([, manifests]) => manifests.length))
    phones[phoneHash] = [...(phones[phoneHash] ?? []), manifest].slice(-MAX_MANIFESTS)
    this.save({ phones })
  }
}

function enoughDisk(home, root, bytes, statfs) {
  let stats
  if (typeof root === 'string') {
    try { stats = statfs(root, { bigint: true }) } catch {}
  }
  if (!stats) {
    try { stats = statfs(home, { bigint: true }) } catch { return false }
  }
  return stats.bavail * stats.bsize >= DISK_FLOOR + BigInt(bytes)
}

const decode = (data) => {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(CHUNK_BYTES / 3) || data.length % 4 !== 0) return
  const decoded = Buffer.from(data, 'base64')
  if (decoded.length && decoded.toString('base64') === data) return decoded
}

export class PocketUploads {
  constructor({ home, log = () => {}, now = Date.now, clock = timers, statfs = statfsSync }) {
    Object.assign(this, { home, log, now, clock, statfs })
    this.ledger = new UploadLedger(join(home, 'pocket', 'uploads.json'), now, log)
    this.documents = new DocumentManifests(join(home, 'pocket', 'document-manifests.json'), now, log)
    this.records = new Map()
    this.settled = new WeakMap()
    this.reads = 0
  }

  timer(run, ms) {
    const timer = this.clock.setTimeout(run, ms)
    timer?.unref?.()
    return timer
  }

  find(phoneHash, upload) { return this.records.get(phoneHash)?.get(upload) }

  add(record) {
    const records = this.records.get(record.phoneHash) ?? new Map()
    records.set(record.upload, record)
    this.records.set(record.phoneHash, records)
    record.signal.addEventListener('abort', record.leave, { once: true })
  }

  remove(record) {
    const records = this.records.get(record.phoneHash)
    if (records?.get(record.upload) !== record) return
    records.delete(record.upload)
    if (!records.size) this.records.delete(record.phoneHash)
    record.signal.removeEventListener('abort', record.leave)
    this.clock.clearTimeout(record.expiry)
  }

  stop(record, state, result) {
    if (record.state !== 'open' && record.state !== 'finishing') return
    record.state = state
    record.result = result
    this.clock.clearTimeout(record.idle)
    this.clock.clearTimeout(record.total)
    this.clock.clearTimeout(record.deadline)
    if (state !== 'admitted') {
      record.ingress.abort(result)
      record.controller.abort()
      this.remove(record)
      const settled = this.settled.get(record.watch) ?? new Map()
      const key = this.settledKey(record)
      settled.set(key, result)
      if (settled.size > DEVICE_DAILY_COUNT) settled.delete(settled.keys().next().value)
      this.settled.set(record.watch, settled)
      // While starting, authority has not passed and no DSH call owns this slot yet.
      if (!record.started && this.admission === record) this.admission = undefined
    }
    record.settle(result)
  }

  cancelRecord(record, reason = 'expired', code) {
    if (record.state === 'admitted') this.remove(record)
    else this.stop(record, 'cancelled', record.refuse(reason, code))
  }

  async begin(params, scope, services, authorize, carriesSignInCode) {
    const { upload, mediaType, bytes } = params
    const refuse = (reason, code) => ({ ...uploadRefusal(reason), upload, ...(code === undefined ? {} : { code }) })
    const recordSet = this.records.get(scope.phoneHash)
    const document = isDocumentType(mediaType)
    const effective = services?.effective
    if (!validId(upload) || (!document && Object.hasOwn(params, 'name'))) return refuse('invalid')
    try {
      if (this.documents.broken()) return refuse('quota')
      if (this.ledger.broken()) {
        // Preserve the images ledger's disk probe on quarantine without admitting or charging.
        if (effective?.mediaTypes.includes(mediaType) && positiveInt(bytes) && bytes <= effective.limits.fileBytes) {
          try { enoughDisk(this.home, services.store.root, bytes, this.statfs) } catch {}
        }
        return refuse('quota')
      }
      const retained = [...this.ledger.manifests(scope.phoneHash), ...this.documents.manifests(scope.phoneHash)]
      if (recordSet?.has(upload) || retained.some(manifest => manifest.uploadIds.includes(upload))) return refuse('invalid')
    } catch { return refuse('unavailable') }
    if (document && this.filesUnsupported) return refuse('unsupported', FILES_UNSUPPORTED)
    const offer = document ? effective?.documents : effective
    if ((document && !scope.documents) || !offer?.mediaTypes.includes(mediaType)) return refuse('unsupported')
    if (!positiveInt(bytes) || bytes > offer.limits.fileBytes) return refuse('too-large')
    const name = document ? documentLeaf(params) : undefined
    if (document && name === undefined) return refuse('invalid')
    if (document && carriesSignInCode?.(name)) {
      this.log('pocket upload: a name carried a sign-in code and was refused')
      return { ...refuse('invalid'), message: 'sign-in-code' }
    }
    if (this.admission || [...(recordSet?.values() ?? [])].some(item => item.state !== 'admitted')) return refuse('busy')
    const outstanding = [...(recordSet?.values() ?? [])].reduce((sum, item) => sum + item.bytes, 0)
    if (outstanding + bytes > DEVICE_OUTSTANDING) return refuse('quota')
    if (!scope.live()) return refuse('not-watching')
    const controller = new AbortController()
    const record = {
      ...scope, upload, mediaType, bytes, effective, refuse, controller, ingress: ingress(), state: 'open', received: 0, ready: false,
      document, name, decoder: mediaType === 'text/plain' ? new TextDecoder('utf-8', { fatal: true }) : undefined,
      header: undefined, original: undefined, pdfVerified: false,
    }
    record.done = new Promise(resolve => { record.settle = resolve })
    record.leave = () => this.cancelRecord(record, 'revoked')
    this.admission = record
    this.settled.get(scope.watch)?.delete(this.settledKey(scope, upload))
    this.add(record)
    record.total = this.timer(() => this.cancelRecord(record, 'rejected', 'timeout'), TOTAL_MS)
    record.idle = this.timer(() => this.cancelRecord(record, 'rejected', 'timeout'), IDLE_MS)
    const gate = await Promise.race([this.authorize(record, authorize), record.done])
    if (record.state !== 'open') return record.result
    if (gate || !record.live()) { this.cancelRecord(record, gate ?? 'revoked'); return record.result }
    try {
      if (!enoughDisk(this.home, services.store.root, bytes, this.statfs)) { this.cancelRecord(record, 'quota'); return record.result }
      const budget = this.ledger.charge(scope.phoneHash, bytes)
      if (budget) { this.cancelRecord(record, budget); return record.result }
    } catch {
      this.log('pocket upload: refused')
      this.cancelRecord(record, 'unavailable')
      return record.result
    }
    record.ready = true
    record.started = true
    void this.admit(record, services.uploads, authorize)
    return record.state === 'open' ? { ok: true, state: 'open', upload, chunkBytes: CHUNK_BYTES } : record.result
  }

  async authorize(record, authorize) {
    try {
      const reason = await authorize()
      return reason ?? (record.live() ? null : 'revoked')
    } catch { return 'unavailable' }
  }

  async admit(record, uploads, authorize) {
    let admitted
    try {
      const request = { sessionId: record.sessionId, data: record.ingress.iterator, signal: record.controller.signal }
      admitted = record.document
        ? await uploads.uploadStream({ ...request, name: record.name })
        : await uploads.uploadImageStream({ ...request, mediaType: record.mediaType })
    } catch (error) {
      const code = error?.details?.reason
      if (code === FILES_UNSUPPORTED) this.filesUnsupported = true
      if (record.state === 'open' || record.state === 'finishing') {
        this.log('pocket upload: admission failed')
        const result = !record.document ? record.refuse('rejected', attachmentCode(error))
          : DOCUMENT_REASONS.has(code) ? record.refuse('unsupported', code)
            : code === 'timeout' ? record.refuse('rejected', code) : record.refuse('unavailable')
        this.stop(record, 'failed', result)
      }
      return
    } finally {
      if (this.admission === record) this.admission = undefined
    }
    if (record.state !== 'finishing') {
      if (record.state === 'open') this.stop(record, 'failed', record.refuse('rejected'))
      return
    }
    const gate = await this.authorize(record, authorize)
    if (record.state !== 'finishing') return
    if (gate || !record.live()) { this.cancelRecord(record, gate ?? 'revoked'); return }
    const { receiptId, image, file } = admitted ?? {}
    if (typeof receiptId !== 'string' || !receiptId || receiptId.includes('\0')) {
      this.stop(record, 'failed', record.refuse('rejected'))
      return
    }
    let metadata
    if (record.document) {
      if (typeof file?.attachmentId === 'string' && /^sha256:[a-f0-9]{64}$/.test(file.attachmentId)
        && file.name === record.name && file.bytes === record.bytes) {
        metadata = { file: { mediaType: record.mediaType, bytes: file.bytes, name: file.name } }
      }
    } else if (MEDIA_TYPES.includes(image?.mediaType) && [image.width, image.height, image.bytes].every(positiveInt)) {
      metadata = { image: { mediaType: image.mediaType, width: image.width, height: image.height, bytes: record.bytes, stored: image.bytes } }
    }
    if (!metadata) { this.stop(record, 'failed', record.refuse('rejected')); return }
    record.receiptId = receiptId
    record.expiry = this.timer(() => this.remove(record), UNSENT_MS)
    record.expiresAt = this.now() + UNSENT_MS
    this.stop(record, 'admitted', { ok: true, state: 'admitted', upload: record.upload, ...metadata })
  }

  owns(record, scope) { return record && record.watch === scope.watch && record.generation === scope.generation }

  settledKey(scope, upload = scope.upload) { return `${scope.generation}:${scope.phoneHash}:${upload}` }

  unknownUpload(scope, upload) {
    return this.settled.get(scope.watch)?.get(this.settledKey(scope, upload)) ?? { ...uploadRefusal('invalid'), upload }
  }

  chunk(params, scope, reply) {
    const record = this.find(scope.phoneHash, params.upload)
    if (!this.owns(record, scope)) return this.unknownUpload(scope, params.upload)
    if (record.state !== 'open') return record.refuse('invalid')
    const fail = (reason) => { this.cancelRecord(record, reason); return record.result }
    if (!record.ready || record.ingress.busy() || params.offset !== record.received) return fail('invalid')
    const data = decode(params.data)
    const received = record.received + (data?.length ?? 0)
    const final = received === record.bytes
    if (!data || received > record.bytes || (!final && data.length !== CHUNK_BYTES)) return fail('invalid')
    if (record.decoder) {
      if (data.includes(0)) return fail('unsupported')
      try { record.decoder.decode(data, { stream: true }) } catch { return fail('unsupported') }
    } else if (record.document) {
      // A first chunk shorter than the magic can only be the entire file.
      if (record.received === 0 && !matches(data, 0, pdfMagic)) return fail('unsupported')
      record.pdfVerified = true
    } else if (!record.original) {
      const remaining = HEADER_BYTES - (record.header?.length ?? 0)
      const prefix = data.subarray(0, remaining)
      const header = record.header ? Buffer.concat([record.header, prefix]) : prefix
      const original = sniffImage(header, record.mediaType, final)
      if (original === 'unsupported') return fail(original)
      if (original && exceedsDimensions(original, record.effective.limits)) return fail('too-large')
      record.original = original
      record.header = original ? undefined : header
    }
    record.received = received
    this.clock.clearTimeout(record.idle)
    record.idle = this.timer(() => this.cancelRecord(record, 'rejected', 'timeout'), IDLE_MS)
    record.ingress.push(data, result => reply(result ?? { ok: true, received }))
  }

  async finish(params, scope, authorize) {
    const record = this.find(scope.phoneHash, params.upload)
    if (!this.owns(record, scope)) return this.unknownUpload(scope, params.upload)
    if (record.state !== 'open') return record.done
    if (!record.ready || !(record.original || record.pdfVerified || record.decoder)
      || record.received !== record.bytes || record.ingress.busy()) return record.refuse('invalid')
    record.state = 'finishing'
    this.clock.clearTimeout(record.idle)
    const gate = await Promise.race([this.authorize(record, authorize), record.done])
    if (record.state !== 'finishing') return record.done
    if (gate || !record.live()) this.cancelRecord(record, gate ?? 'revoked')
    else {
      if (record.decoder) {
        try { record.decoder.decode() } catch { this.cancelRecord(record, 'unsupported'); return record.done }
      }
      this.clock.clearTimeout(record.total)
      record.deadline = this.timer(() => this.cancelRecord(record, 'rejected', 'timeout'), ADMISSION_MS)
      record.ingress.end()
    }
    return record.done
  }

  cancel(params, scope) {
    const record = this.find(scope.phoneHash, params.upload)
    if (record && !this.owns(record, scope)) return { ...uploadRefusal('invalid'), upload: params.upload }
    if (record) this.cancelRecord(record)
    return { ok: true }
  }

  revokeEntry(entry, reason) {
    for (const records of this.records.values()) {
      for (const record of records.values()) if (record.entry === entry) this.cancelRecord(record, reason)
    }
  }

  prepare(scope, id, text, uploadIds, limits) {
    const { phone, phoneHash, sessionId } = scope
    const textHash = sha256(text)
    let previous
    try {
      if (this.documents.broken() || this.ledger.broken()) return { reason: 'quota' }
      const image = this.ledger.manifests(phoneHash).find(manifest => manifest.id === id)
      const document = this.documents.manifests(phoneHash).find(manifest => manifest.id === id)
      if (image && document) return { reason: 'invalid' }
      previous = document ?? image
    } catch { return { reason: 'unavailable' } }
    if (previous) {
      if (previous.sessionId !== sessionId) return { reason: 'session-changed' }
      if (previous.textHash !== textHash || previous.uploadIds.length !== uploadIds.length || previous.uploadIds.some((upload, i) => upload !== uploadIds[i])) return { reason: 'changed' }
      if (previous.kinds && (!scope.documents || this.filesUnsupported || !limits()?.documents)) return { reason: 'unsupported' }
      return { manifest: previous, repeat: true, records: [] }
    }
    const effective = limits()
    if (!effective || uploadIds.length > effective.limits.files) return { reason: effective ? 'too-large' : 'unsupported' }
    const records = []
    for (const upload of uploadIds) {
      const record = this.find(phoneHash, upload)
      if (!record || record.state !== 'admitted' || record.expiresAt <= this.now()) return { reason: 'expired' }
      if (record.document && !scope.documents) return { reason: 'unsupported' }
      if (!this.owns(record, scope)) return { reason: 'invalid' }
      if (record.sessionId !== sessionId) return { reason: 'session-changed' }
      const offer = record.document ? effective.documents : effective
      if ((record.document && this.filesUnsupported) || !offer?.mediaTypes.includes(record.mediaType)) return { reason: 'unsupported' }
      if (record.bytes > offer.limits.fileBytes || (!record.document && exceedsDimensions(record.original, offer.limits))) return { reason: 'too-large' }
      records.push(record)
    }
    if (records.reduce((sum, record) => sum + record.bytes, 0) > effective.limits.messageBytes) return { reason: 'too-large' }
    const receiptIds = records.map(record => record.receiptId)
    const requestId = ATTACH_REQUEST_PREFIX + sha256([phone, sessionId, id, textHash, ...receiptIds].join('\0')).slice(0, 40)
    const manifest = { phoneHash, id, requestId, sessionId, textHash, uploadIds, receiptIds, at: this.now() }
    if (records.some(record => record.document)) manifest.kinds = records.map(record => record.document ? 'document' : 'image')
    return { records, manifest }
  }

  recordManifest(manifest) { (manifest.kinds ? this.documents : this.ledger).record(manifest) }

  consume(scope, manifest) {
    manifest.uploadIds.forEach((upload, i) => {
      const record = this.find(scope.phoneHash, upload)
      if (record?.receiptId === manifest.receiptIds[i]) this.remove(record)
    })
  }

  async read(signal, run) {
    if (this.reads >= 2) return uploadRefusal('busy')
    this.reads++
    const controller = new AbortController()
    const deadline = this.timer(() => controller.abort(), READ_MS)
    const active = AbortSignal.any([signal, controller.signal])
    let onAbort
    try {
      const aborted = new Promise(resolve => {
        onAbort = () => resolve(uploadRefusal(signal.aborted ? 'revoked' : 'unavailable'))
        if (active.aborted) onAbort()
        else active.addEventListener('abort', onAbort, { once: true })
      })
      const work = Promise.resolve().then(() => {
        active.throwIfAborted()
        return run(active)
      }).catch(() => {
        this.log('pocket attachment read failed')
        return uploadRefusal(signal.aborted ? 'revoked' : 'unavailable')
      }).finally(() => { this.reads-- })
      return await Promise.race([work, aborted])
    } finally {
      this.clock.clearTimeout(deadline)
      active.removeEventListener('abort', onAbort)
    }
  }
}
