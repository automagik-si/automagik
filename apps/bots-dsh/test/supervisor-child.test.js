import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import { answers, forwardChildOutput, localListener } from '../src/host/supervisor/child.js'

test('assembles split credentials privately before forwarding a child line', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let launchUrl
  let forwarded = ''
  output.on('data', bytes => { forwarded += bytes })
  const forwardedOutput = forwardChildOutput(input, output, url => { launchUrl = url })
  input.write('dsh web: https://example.invalid/web/?tok')
  input.write('en=launch-')
  assert.equal(forwarded, '')
  input.write('secret&key=query-secret\n')
  input.end('stderr token="quoted secret"')
  await forwardedOutput
  assert.equal(launchUrl, 'https://example.invalid/web/?token=launch-secret&key=query-secret')
  assert.equal(forwarded, 'dsh web: https://example.invalid/web/?token=<redacted>&key=<redacted>\nstderr token=<redacted>\n')
})

test('health probes argv or the default listener independently of the public URL', async () => {
  const launchUrl = 'https://public.example.invalid/?token=private'
  for (const [args, expected] of [
    [['--public-url', launchUrl], 'http://127.0.0.1:3080/'],
    [['--public-url=' + launchUrl, '--host=::1', '--port', '8080', '--tls-cert', 'fixture'], 'https://[::1]:8080/'],
  ]) {
    const calls = []
    assert.equal(await answers({ launchUrl, listener: localListener(args) }, {
      fetch: async (url, options) => {
        calls.push(url)
        assert.equal(options.headers, undefined)
        assert.equal(options.redirect, 'manual')
        return new Response()
      },
    }), true)
    assert.deepEqual(calls, [expected])
  }
})

test('discards oversized child lines and waits for log backpressure between complete lines', async () => {
  const input = new PassThrough()
  const lines = []
  const pending = []
  const launches = []
  const output = new Writable({
    highWaterMark: 1,
    write(bytes, encoding, done) {
      lines.push(bytes.toString())
      pending.push(done)
      output.emit('line-written')
    },
  })
  const observed = []
  const forwarded = forwardChildOutput(input, output, url => launches.push(url), line => {
    observed.push(line)
    if (line.startsWith('first')) throw new Error('fixture line hook failed')
  })
  input.write('dsh web: http://localhost/?token=oversize-secret' + 'x'.repeat(65 * 1024))
  const first = once(output, 'line-written')
  input.write('discarded-fragment\nfirst token=first-secret\nsecond\n')
  input.end('x'.repeat(65 * 1024) + 'unterminated-secret')
  await first
  assert.deepEqual(lines, ['first token=<redacted>\n'])
  assert.equal(output.writableLength, lines[0].length)
  const second = once(output, 'line-written')
  pending.shift()()
  await second
  assert.deepEqual(lines, ['first token=<redacted>\n', 'second\n'])
  pending.shift()()
  await forwarded
  assert.deepEqual(launches, [])
  assert.deepEqual(observed, ['first token=<redacted>', 'second'])
})
