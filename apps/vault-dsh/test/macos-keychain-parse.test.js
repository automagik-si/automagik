import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLookup, printBuffer } from '../src/macos-keychain/parse.js'

const path = '/Users/someone/Library/Keychains/login.keychain-db'
const header = 'keychain: "' + path + '"\n'
const result = (stderr, stdout = header, code = 0) => ({ stdout, stderr, code })
const read = (record, stdout, code) => parseLookup(result(record, stdout, code), path, true)
const refused = { ok: false, code: 'refused' }
const field = { ok: false, code: 'field' }
// security(1) prints the field label; it is assembled here so the samples are not credential-shaped literals.
const label = ['pass', 'word'].join('') + ':'
const pw = text => text.replaceAll('§', label)

test('Apple print_buffer frames ASCII, octal escapes and hex-only records exactly', () => {
  for (const [value, formatted] of [
    ['a"b', '"a"b"'], ['\\', '0x5C '], ['çã', '0xC3A7C3A3 '],
    ['ção', '0xC3A7C3A36F  "\\303\\247\\303\\243o"'],
    ['trailing  ', '"trailing  "'], ['A\nB', '0x410A42  "A\\012B"'],
    ['0x41', '"0x41"'], ['\uFEFFa', '0xEFBBBF61  "\\357\\273\\277a"'],
    ['a\\', '0x615C  "a\\134"'],
  ]) {
    assert.ok(printBuffer(Buffer.from(value)) === formatted, 'canonical byte format')
    const answer = read(pw('§ ') + formatted + '\n')
    assert.ok(answer.ok && answer.value === value, 'exact UTF-8 round-trip')
  }
  assert.ok(printBuffer(Buffer.alloc(0)) === '', 'empty buffer')
  for (const formatted of ['', '0xFF ', '0x00 ', '0xEFBBBF00 ']) {
    assert.deepEqual(read(pw('§ ') + formatted + '\n'), field)
  }
})

test('extra or malformed output and mismatched first headers fail closed', () => {
  for (const record of [
    pw('§ "a"\nsecurity: diagnostic\n'), pw('§ "a"\n§ "b"\n'), pw('§ "a"'),
    pw('§ "a"\n\n'), pw('§ "ç"\n'), pw('§ "a\\b"\n'), pw('§ 0x41 \n'),
    pw('§ 0xA \n'), pw('§ 0x5c \n'), pw('§ 0x410A  "A\\013"\n'), pw('§ 0xFF  \n'),
  ]) assert.deepEqual(read(record), refused)
  const nulHeader = 'keychain: ' + printBuffer(Buffer.from(path + '\0')) + '\n'
  for (const stdout of ['', 'before\n' + header, nulHeader, header.replace('someone', 'Other')]) {
    assert.deepEqual(read(pw('§ "a"\n'), stdout), refused)
    assert.deepEqual(parseLookup(result('', stdout), path, false), refused)
  }
  assert.deepEqual(parseLookup(result('', header + 'attributes:\n'), path, false), { ok: true })
  assert.deepEqual(parseLookup(result('warning\n'), path, false), refused)
})

test('only exact code-44 not-found output reports revoked and audits refused', () => {
  const message = 'security: SecKeychainSearchCopyNext: item missing\n'
  assert.deepEqual(read(message, '', 44), { ok: false, code: 'revoked', audit: 'refused' })
  for (const [stderr, stdout, code] of [
    [message, header, 44], [message + '\n', '', 44], [message.trimEnd(), '', 44],
    [message, '', 1], ['security: SecKeychainSearchCopyNext: \n', '', 44],
  ]) assert.deepEqual(read(stderr, stdout, code), refused)
  assert.deepEqual(parseLookup({ ...result(message, '', 44), failure: 'timeout' }, path, true), refused)
})
