import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BusFailure, decodeMessage, encodeMessage, Frames, MAX_FRAME, parseAddress, tracing } from '../src/secret-service/dbus.js'
import { attributeDigest } from '../src/secret-service/parse.js'

const hex = text => Buffer.from(text.replace(/\s/g, ''), 'hex')
// Hand-marshalled method returns: reply serial 7, one variant of (tay).
// The array length is bytes; the uint64 starts at offset 40 in both orders.
const little = hex(`
  6c 02 00 01 17 00 00 00 09 00 00 00 0f 00 00 00
  05 01 75 00 07 00 00 00 08 01 67 00 01 76 00 00
  05 28 74 61 79 29 00 00 ee ff ff ff ff ff ff ff
  03 00 00 00 01 02 03
`)
const big = hex(`
  42 02 00 01 00 00 00 17 00 00 00 09 00 00 00 0f
  05 01 75 00 00 00 00 07 08 01 67 00 01 76 00 00
  05 28 74 61 79 29 00 00 ff ff ff ff ff ff ff ee
  00 00 00 03 01 02 03
`)

test('byte orders, message-relative variant/struct alignment and u64', () => {
  const message = {
    type: 2, flags: 0, serial: 9, headers: { reply: 7, signature: 'v' }, signature: 'v',
    body: [{ signature: '(tay)', value: [18446744073709551598n, hex('01 02 03')] }],
  }
  assert.deepEqual(decodeMessage(little), message)
  assert.deepEqual(decodeMessage(big), message)
  assert.deepEqual(encodeMessage({ ...message, headers: { reply: 7 } }), little)
})

test('hand-written dictionary entry alignment and order independent attribute digest', () => {
  const dictionary = hex(`
    6c 02 00 01 26 00 00 00 09 00 00 00 13 00 00 00
    05 01 75 00 07 00 00 00 08 01 67 00 05 61 7b 73
    73 7d 00 00 00 00 00 00 1e 00 00 00 00 00 00 00
    01 00 00 00 7a 00 00 00 01 00 00 00 39 00 00 00
    01 00 00 00 61 00 00 00 01 00 00 00 31 00
  `)
  const [attrs] = decodeMessage(dictionary).body
  assert.deepEqual(attrs, [['z', '9'], ['a', '1']])
  assert.equal(attributeDigest(attrs), attributeDigest([...attrs].reverse()))
  assert.equal(attributeDigest([['a', '1'], ['a', '2']]), undefined)
})

test('fragmented and coalesced frames', () => {
  const stream = new Frames()
  const frames = []
  const receive = frame => frames.push(frame)
  for (let byte = 0; byte < little.length - 2; byte++) stream.push(little.subarray(byte, byte + 1), receive)
  assert.equal(frames.length, 0)
  stream.push(Buffer.concat([little.subarray(-2), big, little.subarray(0, 6)]), receive)
  assert.equal(frames.length, 2)
  stream.push(little.subarray(6), receive)
  assert.equal(frames.length, 3)
  assert.equal(frames.every(frame => frame.headers.reply === 7), true)
})

test('malformed endian, reply, headers, variant, padding, UTF-8, lengths and FD transport', () => {
  for (const [offset, byte] of [
    [0, 0], [8, 0], [16, 9], [18, 0x69], [20, 0], [29, 0x68], [30, 1],
    [33, 0x68], [35, 0xff], [38, 1], [39, 1], [48, 4], [48, 2],
  ]) {
    const edited = Buffer.from(little)
    edited[offset] = byte
    assert.throws(() => decodeMessage(edited), BusFailure, 'byte ' + offset)
  }
  assert.throws(() => decodeMessage(little.subarray(0, -1)), BusFailure)
  assert.throws(() => decodeMessage(Buffer.concat([little, Buffer.alloc(1)])), BusFailure)
  const deep = Buffer.from(little)
  for (const signature of ['a'.repeat(32) + 's', '{ss}', 'a{vs}', '()', 'h']) {
    assert.throws(() => encodeMessage({ serial: 1, headers: {}, signature, body: [undefined] }), BusFailure)
  }
  deep.writeUInt32LE(MAX_FRAME, 12)
  assert.throws(() => new Frames().push(deep.subarray(0, 16), () => assert.fail()), BusFailure)
  assert.throws(() => new Frames().push(Buffer.alloc(MAX_FRAME * 2 + 1), () => assert.fail()), BusFailure)
})

function arrayFrame(element, count) {
  const signature = 'a' + element
  const frame = Buffer.alloc(36 + count * (element === 'y' ? 1 : 4))
  hex('6c 02 00 01 00 00 00 00 09 00 00 00 10 00 00 00 05 01 75 00 07 00 00 00 08 01 67 00 02 61 79 00').copy(frame)
  frame[30] = element.charCodeAt(0)
  frame.writeUInt32LE(frame.length - 32, 4)
  frame.writeUInt32LE(frame.length - 36, 32)
  assert.equal(frame.toString('ascii', 29, 31), signature)
  return frame
}

test('independent ay and element ceilings count different units', () => {
  assert.equal(decodeMessage(arrayFrame('y', 65536)).body[0].length, 65536)
  assert.equal(decodeMessage(arrayFrame('u', 4096)).body[0].length, 4096)
  assert.throws(() => decodeMessage(arrayFrame('y', 65537)), BusFailure)
  assert.throws(() => decodeMessage(arrayFrame('u', 4097)), BusFailure)
})

test('single Unix address and tracing checks', () => {
  assert.deepEqual(parseAddress('unix:path=/run/user/1/with%20space'), { path: '/run/user/1/with space', guid: undefined })
  const guid = 'a'.repeat(32)
  assert.deepEqual(parseAddress('unix:guid=' + guid + ',abstract=/tmp/bus'), { path: '\0/tmp/bus', guid })
  for (const value of ['tcp:host=localhost', 'unix:path=/x;unix:path=/y', 'unix:path=/x,abstract=y', 'unix:path=/x,guid=bad',
    'unix:path=/x%00', 'unix:path=/x%', 'unix:path=relative', 'unix:path=/' + 'x'.repeat(107)]) {
    assert.throws(() => parseAddress(value), BusFailure)
  }
  for (const NODE_DEBUG of ['net', 'fs,STREAM', 'tls', 'http', '*', 'st*']) assert.equal(tracing({ NODE_DEBUG }), true)
  assert.equal(tracing({ NODE_DEBUG: 'fs,dns' }), false)
})
