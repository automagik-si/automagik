import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { answers, forwardChildOutput, localListener } from '../src/host/supervisor/child.js'

test('assembles split credentials privately before forwarding a child line', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let launchUrl
  let forwarded = ''
  output.on('data', bytes => { forwarded += bytes })
  forwardChildOutput(input, output, url => { launchUrl = url })
  const end = once(input, 'end')
  input.write('dsh web: https://example.invalid/web/?tok')
  input.write('en=launch-')
  assert.equal(forwarded, '')
  input.write('secret&key=query-secret\n')
  input.end('stderr token="quoted secret"')
  await end
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
