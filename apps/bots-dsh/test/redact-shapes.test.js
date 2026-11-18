// #1325: values that look like secrets must not pass the shared redactor or the SSH/Hermes
// one. Every value here is made up from plain words and digits; no real key is used.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactText } from '../src/host/redact.js'
import { redactSshText } from '../src/host/hermes-redact.js'

const secret = 's3cr3t-value-XYZ987654'

test('provider and code-host keys that use their own prefix are masked', () => {
  const made = (...parts) => parts.join('')
  const keys = [
    made('sk_live_', 'a1b2c3d4e5f6a7b8c9d0e1f2'),
    made('rk_live_', 'a1b2c3d4e5f6a7b8c9d0e1f2'),
    made('whsec_', 'a1b2c3d4e5f6a7b8'),
    made('hf_', 'Kf9Qz2Lm7Np4Rt8Vw3Xy6Bc1'),
    made('glpat-', 'Kf9Qz2Lm7Np4Rt8Vw3Xy'),
    made('gsk_', 'Kf9Qz2Lm7Np4Rt8Vw3Xy6Bc1'),
    made('SG.', 'Kf9Qz2Lm7Np4Rt8V', '.w3Xy6Bc1Kf9Qz2Lm'),
    made('ya29.', 'Kf9Qz2Lm7Np4Rt8Vw3Xy6Bc1'),
    made('shpat_', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'),
    made('dop_v1_', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'),
    made('npm_', 'Kf9Qz2Lm7Np4Rt8Vw3Xy6Bc1'),
  ]
  const out = redactText(keys.join(' '))
  for (const key of keys) assert.ok(!out.includes(key), key)
  assert.match(out, /\[hidden\]/)
})

test('authorization headers and key/value spellings are masked', () => {
  const spellings = [
    'X-Auth-Token: a1b2c3d4e5f6a7b8',
    'x-amz-security-token: a1b2c3d4e5f6a7b8',
    'Proxy-Authorization: Basic Zm9vYmFyYmF6cXV4',
    'client_secret=Kf9Qz2Lm7Np4Rt8Vw3Xy',
    'passwd: hunter22222',
    'refresh-token: a1b2c3d4e5f6a7b8',
    'private_key: a1b2c3d4e5f6a7b8',
  ]
  for (const spelling of spellings) assert.ok(!redactText(spelling).includes(spelling.split(/[:=]\s*/)[1]), spelling)
})

test('credential names in a URL query are masked whichever spelling they use', () => {
  const urls = [
    'https://example.invalid/x?access-token=a1b2c3d4e5f6',
    'https://example.invalid/x?api-key=a1b2c3d4e5f6',
    'https://example.invalid/x?client_secret=a1b2c3d4e5f6',
    'https://example.invalid/x?x-api-key=a1b2c3d4e5f6',
    'https://example.invalid/x?signature=a1b2c3d4e5f6',
    'https://example.invalid/x?auth=a1b2c3d4e5f6',
  ]
  for (const url of urls) assert.ok(!redactText(url).includes('a1b2c3d4e5f6'), url)
})

test('a connection’s own secret is masked in its encodings and when broken across lines', () => {
  const forms = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
    Buffer.from(secret).toString('hex'),
    secret.split('').join('\n'),
    secret.split('').join(' '),
  ]
  for (const form of forms) {
    const out = redactSshText(`the host said: ${form}`, [secret])
    assert.ok(!out.includes(form), form)
    assert.ok(!out.includes(secret), form)
  }
  assert.equal(redactSshText('cannot bind 127.0.0.1:98 (errno 98)', [secret]), 'cannot bind 127.0.0.1:98 (errno 98)')
})

test('an opaque token shorter than the long-run rule is still masked', () => {
  const token = 'Kf9Qz2Lm7Np4Rt8Vw3Xy6Bc1'
  const out = redactSshText(`the remote answered token ${token} once`, [])
  assert.ok(!out.includes(token), out)
  assert.ok(!out.includes('Kf9Qz2Lm7Np4Rt8Vw3Xy6Bc1'))
})

test('home folders written in encoded or escaped form, and named by user, are masked', () => {
  const paths = [
    '%2Fhome%2Falice%2F.hermes%2Flogs',
    '%2FUsers%2Falice%2F.hermes',
    '\\/home\\/alice\\/work',
    'C:\\\\Users\\\\alice\\\\work',
    '~alice/work',
    '/export/home/alice/work',
  ]
  for (const path of paths) {
    const out = redactSshText(`read ${path} failed`, [])
    assert.ok(!out.includes('alice'), `${path}: ${out}`)
  }
})

test('ordinary words and prose still read as before', () => {
  assert.equal(redactText('the tokenizer keeps this sentence'), 'the tokenizer keeps this sentence')
  assert.equal(redactText('a password is required here'), 'a password is required here')
  assert.equal(redactSshText('the server is not running yet', []), 'the server is not running yet')
})
