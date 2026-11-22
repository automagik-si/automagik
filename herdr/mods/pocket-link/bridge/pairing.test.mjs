// node --test bridge/pairing.test.mjs: what each try does to the pairing code, per phone and in
// total; cancelling it (the dialog does on close); shortening it when its link is copied; the key
// fingerprint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, openSync, closeSync, statSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { store } from './devices.mjs'
import {
  judgeCode, cancelCode, challengeId, shorten, shortenCode, shortenOpen, fingerprint, desktopFingerprint,
  TRIES_PER_PHONE, TRIES_PER_CODE, COPIED_LIFE,
} from './pairing.mjs'

const NOW = 1_000_000
const code = (extra = {}) => ({ code: 'right', expires: NOW + 60_000, name: 'desk', ...extra })

/** Plays tries against one code the way bridge.mjs does: write `next`, or delete on null. */
function play(pending, tries) {
  const verdicts = []
  for (const [phone, guess] of tries) {
    const { verdict, next } = judgeCode(pending, phone, guess, NOW)
    verdicts.push(verdict)
    if (next !== undefined) pending = next
  }
  return { verdicts, pending }
}

test('the right code pairs once and is gone', () => {
  const { verdicts, pending } = play(code(), [['phone-a', 'right'], ['phone-b', 'right']])
  assert.deepEqual(verdicts, ['ok', 'gone'])
  assert.equal(pending, null)
})

test('a failed completion write reserves the code and recovery finishes only the original grant', async t => {
  const { acceptPairing, resumePairing, challengeId, COMPLETED, GRANT } = await import('./pairing.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'pocket-grant-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pairing = join(dir, 'pairing.json')
  const receipt = join(dir, COMPLETED)
  let blockReceipt = true
  const phones = store(join(dir, 'devices.json'), { held() {
    if (!blockReceipt) return
    blockReceipt = false
    mkdirSync(receipt)
  } })
  writeFileSync(pairing, JSON.stringify(code()))
  // Fail the real receipt rename after the device write. No receipt is created by the fixture.
  const attempt = (peer, now = NOW) => acceptPairing(dir, phones, {
    pending: JSON.parse(readFileSync(pairing, 'utf8')), peer, code: 'right', device: peer, now,
  })
  assert.throws(() => attempt('phone-a'), /EISDIR|ENOTEMPTY/)
  assert.equal(phones.list()[0].id, 'phone-a')
  assert.equal(existsSync(join(dir, GRANT)), true)
  assert.throws(() => attempt('phone-b'), /Invalid Pocket Link pairing record/)
  assert.deepEqual(phones.list().map(phone => phone.id), ['phone-a'])
  rmSync(receipt, { recursive: true })
  resumePairing(dir, phones, NOW + 1)
  assert.deepEqual(phones.list().map(({ id, paired }) => [id, paired]), [['phone-a', NOW]])
  assert.equal(existsSync(pairing), false)
  assert.equal(existsSync(join(dir, GRANT)), false)
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8'))[challengeId('right')].name, 'phone-a')
  assert.equal(acceptPairing(dir, phones, {
    pending: code(), peer: 'phone-b', code: 'right', device: 'B', now: NOW + 2,
  }).verdict, 'gone')
})

test('one phone that keeps guessing locks only itself out; the code still pairs another phone', () => {
  const wrong = Array.from({ length: TRIES_PER_PHONE + 5 }, () => ['phone-a', 'nope'])
  const { verdicts, pending } = play(code(), [...wrong, ['phone-a', 'right'], ['phone-b', 'right']])
  assert.deepEqual(verdicts.slice(0, TRIES_PER_PHONE), Array(TRIES_PER_PHONE).fill('wrong'))
  assert.deepEqual(verdicts.slice(TRIES_PER_PHONE), [...Array(6).fill('locked'), 'ok'])
  assert.equal(pending, null)
})

test('a locked-out phone does not count toward the code\'s total', () => {
  const tries = Array.from({ length: 100 }, () => ['phone-a', 'nope'])
  const { pending } = play(code(), tries)
  assert.equal(pending.failures, TRIES_PER_PHONE)
  assert.equal(pending.tries['phone-a'], TRIES_PER_PHONE)
})

test('a stranger with a few fresh keys can\'t end the code: 7 keys with 3 wrong tries each', () => {
  const tries = Array.from({ length: 7 * TRIES_PER_PHONE }, (_, i) => [`stranger-${i % 7}`, 'nope'])
  const { verdicts, pending } = play(code(), [...tries, ['phone-real', 'right']])
  assert.equal(pending, null)
  assert.equal(verdicts.at(-1), 'ok')
})

test('only a flood of keys ends the code, at the total', () => {
  const tries = Array.from({ length: TRIES_PER_CODE }, (_, i) => [`phone-${i}`, 'nope'])
  const { verdicts, pending } = play(code(), [...tries, ['phone-real', 'right']])
  assert.equal(pending, null)
  assert.equal(verdicts.at(-1), 'gone')
})

test('an expired code or none at all is gone, and nothing is written', () => {
  assert.deepEqual(judgeCode(code({ expires: NOW - 1 }), 'p', 'right', NOW), { verdict: 'gone', next: undefined })
  assert.deepEqual(judgeCode(null, 'p', 'right', NOW), { verdict: 'gone', next: undefined })
  assert.deepEqual(judgeCode(code(), 'p', undefined, NOW).verdict, 'wrong')
})

test('cancel ends a live code, and says whether there was one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-pairing-test-'))
  const path = join(dir, 'pairing.json')
  writeFileSync(path, JSON.stringify(code()))
  assert.equal(cancelCode(path, NOW), true)
  assert.equal(existsSync(path), false)
  assert.equal(judgeCode(null, 'p', 'right', NOW).verdict, 'gone') // the bridge reads no file as gone
  assert.equal(cancelCode(path, NOW), false) // closing again is harmless
  writeFileSync(path, JSON.stringify(code({ expires: NOW - 1 })))
  assert.equal(cancelCode(path, NOW), false)
  assert.equal(existsSync(path), false)
})

test('a copied code ends 2 minutes later, keeps its tries, and is never lengthened', () => {
  assert.equal(COPIED_LIFE, 2 * 60_000)
  const tried = code({ expires: NOW + 10 * 60_000, failures: 2, tries: { 'phone-a': 2 } })
  const cut = shorten(tried, COPIED_LIFE, NOW)
  assert.deepEqual(cut, { ...tried, expires: NOW + COPIED_LIFE })
  assert.equal(judgeCode(cut, 'phone-b', 'right', NOW + COPIED_LIFE).verdict, 'ok')
  assert.equal(judgeCode(cut, 'phone-b', 'right', NOW + COPIED_LIFE + 1).verdict, 'gone')
  // Copying again later doesn't give it more time, nor does copying a code with less than 2 minutes.
  assert.equal(shorten(cut, COPIED_LIFE, NOW + 30_000).expires, NOW + COPIED_LIFE)
  assert.equal(shorten(code({ expires: NOW + 30_000 }), COPIED_LIFE, NOW).expires, NOW + 30_000)
  assert.equal(shorten(code({ expires: NOW - 1 }), COPIED_LIFE, NOW), undefined)
  assert.equal(shorten(null, COPIED_LIFE, NOW), undefined)
})

const LONG = NOW + 10 * 60_000
const FAST = { settle: 0 }
const read = path => JSON.parse(readFileSync(path, 'utf8'))
/** The bridge's own write (writeJson in bridge.mjs): a temporary file renamed over pairing.json. */
const bridgeWrite = (path, value) => { writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n'); renameSync(`${path}.tmp`, path) }
const tempCode = () => join(mkdtempSync(join(tmpdir(), 'pocket-pairing-test-')), 'pairing.json')

test('copied rewrites pairing.json in place, and never brings back a used or cancelled code', () => {
  const path = tempCode()
  writeFileSync(path, JSON.stringify(code({ expires: LONG })), { mode: 0o600 })
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, FAST), { expires: NOW + COPIED_LIFE })
  assert.deepEqual(read(path), code({ expires: NOW + COPIED_LIFE }))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  // Used (the bridge deleted it), cancelled, expired or unreadable: nothing to shorten, nothing made.
  unlinkSync(path)
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, FAST), { error: 'gone' })
  assert.equal(existsSync(path), false)
  writeFileSync(path, JSON.stringify(code({ expires: NOW - 1 })))
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, FAST), { error: 'gone' })
  assert.deepEqual(read(path), code({ expires: NOW - 1 }))
  writeFileSync(path, '{not json')
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, FAST), { error: 'gone' })
})

test('a rewrite shorter than the file it replaces leaves no tail behind', () => {
  const path = tempCode()
  const before = JSON.stringify(code({ expires: LONG }), null, 12) + '\n'.repeat(40)
  writeFileSync(path, before)
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, FAST), { expires: NOW + COPIED_LIFE })
  const after = JSON.stringify(code({ expires: NOW + COPIED_LIFE }), null, 2) + '\n'
  assert.ok(after.length < before.length)
  assert.equal(readFileSync(path, 'utf8'), after)
})

test('a code used while copied is shortening stays gone: the write lands in the deleted file', () => {
  const path = tempCode()
  writeFileSync(path, JSON.stringify(code({ expires: LONG })))
  // shortenCode has opened the file; a phone pairs and the bridge deletes it before the write.
  const fd = openSync(path, 'r+')
  unlinkSync(path)
  try { assert.equal(shortenOpen(fd, COPIED_LIFE, NOW).expires, NOW + COPIED_LIFE) } finally { closeSync(fd) }
  assert.equal(existsSync(path), false)
  // And when it goes just after the write: gone, not brought back.
  writeFileSync(path, JSON.stringify(code({ expires: LONG })))
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, { ...FAST, written: () => unlinkSync(path) }), { error: 'gone' })
  assert.equal(existsSync(path), false)
})

test('a wrong try the bridge renames over the shortened file is shortened again, tries kept', () => {
  const path = tempCode()
  writeFileSync(path, JSON.stringify(code({ expires: LONG })))
  // The bridge read the code before the write and renames its copy, with a wrong try, after it.
  const tried = code({ expires: LONG, failures: 1, tries: { 'phone-x': 1 } })
  let once = true
  const written = () => { if (once) { once = false; bridgeWrite(path, tried) } }
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, { ...FAST, written }), { expires: NOW + COPIED_LIFE })
  assert.deepEqual(read(path), { ...tried, expires: NOW + COPIED_LIFE })
})

test('a wrong try renamed over it after the check is caught by the second look', () => {
  const path = tempCode()
  writeFileSync(path, JSON.stringify(code({ expires: LONG })))
  const tried = code({ expires: LONG, failures: 1, tries: { 'phone-x': 1 } })
  let once = true
  const settled = () => { if (once) { once = false; bridgeWrite(path, tried) } }
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, { settle: 1, settled }), { expires: NOW + COPIED_LIFE })
  assert.deepEqual(read(path), { ...tried, expires: NOW + COPIED_LIFE })
})

test('a file that keeps being replaced fails closed: nothing to copy', () => {
  const path = tempCode()
  writeFileSync(path, JSON.stringify(code({ expires: LONG })))
  const written = () => bridgeWrite(path, code({ expires: LONG }))
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, { ...FAST, written }), { error: 'changing' })
})

test('a different code in its place is not shortened in the copied one\'s name', () => {
  const path = tempCode()
  writeFileSync(path, JSON.stringify(code({ expires: LONG })))
  const written = () => bridgeWrite(path, code({ code: 'other', expires: LONG }))
  assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, { ...FAST, written }), { error: 'gone' })
  assert.deepEqual(read(path), code({ code: 'other', expires: LONG }))
})

test('the fingerprint is the key\'s first 12 hex characters in fours', () => {
  assert.equal(fingerprint('6d35626dc129f365026a5cb104f735bb'), '6d35 626d c129')
  assert.equal(fingerprint('abc'), 'abc')
})

test('the desktop fingerprint shows only the key the bridge is serving', () => {
  const status = { id: '4f1c9a07de21'.padEnd(64, '0'), ticket: 'ticket' }
  const other = { ...status, id: '6d35626dc129'.padEnd(64, '0') }
  assert.equal(desktopFingerprint(status, true), '4f1c 9a07 de21')
  assert.equal(desktopFingerprint(other, true), '6d35 626d c129')
  assert.equal(desktopFingerprint({ ...status, rotating: true }, true), null)
  assert.equal(desktopFingerprint({ ...status, ticket: null }, true), null)
  assert.equal(desktopFingerprint({ ...status, id: null }, true), null)
  assert.equal(desktopFingerprint(status, false), null)
  assert.equal(desktopFingerprint(null, true), null)
})

test('conditional cancel and copied leave a replacement code intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-pairing-test-'))
  const path = join(dir, 'pairing.json')
  try {
    const replacement = code({ code: 'replacement' })
    writeFileSync(path, JSON.stringify(replacement))
    assert.equal(cancelCode(path, NOW, challengeId('old')), false)
    assert.deepEqual(shortenCode(path, COPIED_LIFE, NOW, { only: challengeId('old'), settle: 0 }), { error: 'gone' })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement)
    assert.equal(cancelCode(path, NOW, 'replacement'), false)
    assert.equal(cancelCode(path, NOW, challengeId('replacement')), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
