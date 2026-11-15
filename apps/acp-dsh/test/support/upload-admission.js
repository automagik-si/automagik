// Use the packaged public DSH admission implementation in memory, without starting its
// remote service or altering installed files. Only expose its internal command class;
// the controller's receipt resolution/admission/createUserMessage code stays unchanged.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { deflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'

const url = import.meta.resolve('@deepseek-ai/dsh-api-session-controller')
const hook = registerHooks({
  load(specifier, context, next) {
    if (specifier !== url) return next(specifier, context)
    return { format: 'module', shortCircuit: true, source: `${readFileSync(new URL(url), 'utf8')}\nexport { SessionCommandController };\n` }
  },
})
let SessionCommandController
try { ({ SessionCommandController } = await import(url)) } finally { hook.deregister() }

// A synthetic valid PNG matching the reported failure's dimensions/byte count, NOT
// the user's screenshot or its sha256. A harmless ancillary chunk supplies the padding.
export function receiptPng() {
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes])
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, data, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(622, 0)
  header.writeUInt32BE(251, 4)
  header[8] = 8
  header[9] = 2
  const start = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((622 * 3 + 1) * 251)))])
  return Buffer.concat([start, chunk('paDd', Buffer.alloc(30031 - start.length - 24)), chunk('IEND', Buffer.alloc(0))])
}

export function admission(home, agent) {
  const ctx = new Context()
  const store = new LocalAttachmentStore(ctx, { dshHome: home })
  // Exercise the real session-keyed staging and binding methods without registering HTTP
  // routes. No profile, server, remote API, filesystem grant or native agent is involved.
  const uploads = Object.assign(Object.create(FileUploads.prototype), {
    ctx: { agents: { get: id => id === agent.id ? agent : undefined } },
    stagedFiles: new WeakMap(),
  })
  const controller = new SessionCommandController({
    attachments: store,
    fileUploads: uploads,
    agents: { get: id => id === agent.id ? agent : undefined },
    llm: { resolveModelInfo: async () => ({}) },
  }, {
    resolveAgent: async () => ({ agent }),
    serializeImageAdmission: async (_, admit) => admit(),
  }, home)
  return { store, uploads, controller }
}
