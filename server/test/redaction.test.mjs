import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { pipeRedacted, safeDshLine } from '../entrypoint.mjs'

test('redacts and bounds before every consumer, including the stored line', async () => {
  const into = []
  const safe = []
  const raw = []
  const stream = new PassThrough()
  const ended = new Promise((resolve) => stream.once('end', resolve))
  pipeRedacted(stream, { write: (chunk) => into.push(chunk) }, (line) => safe.push(line), (line) => raw.push(line))
  stream.end(`level=info token=SECRET-${'x'.repeat(5000)} tail\n`)
  await ended
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(raw.length, 1)
  assert.ok(raw[0].includes('SECRET-'), 'the launch consumer is the only one allowed to see the raw line')
  assert.ok(!into.join('').includes('SECRET-'), 'the log carried the token')
  assert.ok(!safe.join('').includes('SECRET-'), 'the stored line carried the token')
  assert.ok(safe[0].length <= 4097, `the stored line was not bounded: ${safe[0].length}`)
  assert.ok(!safeDshLine(`token=SECRET-${'y'.repeat(5000)}`).includes('SECRET-'))
})
