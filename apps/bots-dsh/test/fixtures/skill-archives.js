import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

export const rootMd = '---\nname: notes\ndescription: Keep a note.\n---\n\nWrite a note.\n'
export const rootMember = { path: 'SKILL.md', data: rootMd }

export function zipExtra(id, data) {
  const field = Buffer.alloc(4)
  field.writeUInt16LE(id)
  field.writeUInt16LE(data.length, 2)
  return Buffer.concat([field, Buffer.from(data)])
}

export function zip(members = [rootMember], { host = 3, prefix = Buffer.alloc(0), end } = {}) {
  const locals = [prefix]
  const central = []
  let offset = prefix.length
  for (const member of members) {
    const {
      path, data = '', directory = path.endsWith('/'), extra = Buffer.alloc(0), localExtra = extra,
      flags = 0x800, method = 0, disk = 0, attr = host === 3 ? (directory ? 0x40000010 : 0x80000000) : directory ? 16 : 0,
      payloadTail = Buffer.alloc(0), comment = Buffer.alloc(0), declared, mutateLocal, mutateDescriptor,
    } = member
    const name = Buffer.from(path)
    const plain = Buffer.from(data)
    const payload = Buffer.concat([method === 8 ? deflateRawSync(plain) : plain, payloadTail])
    const size = declared ?? plain.length
    const crc = crc32(plain)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(size, 22)
    }
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    const localName = Buffer.from(name)
    mutateLocal?.(local, localName)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE((host << 8) + 20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(size, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(extra.length, 30)
    record.writeUInt16LE(comment.length, 32)
    record.writeUInt16LE(disk, 34)
    record.writeUInt32LE(attr, 38)
    record.writeUInt32LE(offset, 42)
    const parts = [local, localName, localExtra, payload]
    if (flags & 8) {
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(payload.length, 8)
      descriptor.writeUInt32LE(size, 12)
      mutateDescriptor?.(descriptor)
      parts.push(descriptor)
    }
    locals.push(...parts)
    offset += parts.reduce((length, part) => length + part.length, 0)
    central.push(record, name, extra, comment)
  }
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50)
  footer.writeUInt16LE(members.length, 8)
  footer.writeUInt16LE(members.length, 10)
  footer.writeUInt32LE(central.reduce((length, part) => length + part.length, 0), 12)
  footer.writeUInt32LE(offset, 16)
  end?.(footer)
  return Buffer.concat([...locals, ...central, footer])
}

export function pax(key, value) {
  const entry = ` ${key}=${value}\n`
  const bytes = Buffer.byteLength(entry)
  let length = bytes + 1
  while (length !== bytes + String(length).length) length = bytes + String(length).length
  return `${length}${entry}`
}

export function tar(members = [rootMember], { gnu = false, terminator = 1024, trailing = Buffer.alloc(0) } = {}) {
  const output = []
  for (const { path, data = '', type = '0', declared, prefix = '' } of members) {
    const bytes = Buffer.from(data)
    const header = Buffer.alloc(512)
    header.write(path)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write((declared ?? bytes.length).toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write(type, 156)
    header.write(gnu ? 'ustar  \0' : 'ustar\x0000', 257)
    header.write(prefix, 345)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    output.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...output, Buffer.alloc(terminator), trailing]))
}
