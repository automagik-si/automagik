import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../index.js'

const compiler = join(homedir(), '.bun/install/cache/typescript@5.9.3@@@1/bin/tsc')

test('a NodeNext consumer sees the packed principal declaration', {
  skip: existsSync(compiler) ? false : 'offline TypeScript compiler is not cached',
}, () => {
  execFileSync(process.execPath, ['scripts/check-packed-types.mjs'], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit',
  })
})

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)))

test('the server-only plugin shares the Bot team harness and has no bundle or market block', () => {
  const harness = read('../dev/harness/package.json')
  const bots = read('../../bots-dsh/dev/harness/package.json')
  const pkg = read('../package.json')
  assert.equal(harness.dependencies['@deepseek-ai/dsh'], bots.dependencies['@deepseek-ai/dsh'])
  assert.equal(pkg.version, read('../../../package.json').version)
  assert.equal(Object.hasOwn(pkg, 'dsh'), false)
  assert.equal(pkg.automagik?.market, undefined)
  assert.equal(Config({}).maxRequestBodyBytes, 314572800)
})

test('the release tarball contains only the public package, source and declarations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'multiuser-pack-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('bun', ['pm', 'pack', '--destination', dir], { cwd: new URL('..', import.meta.url), stdio: 'ignore' })
  const [archive] = readdirSync(dir)
  const listing = join(dir, 'listing')
  const fd = openSync(listing, 'w')
  try { execFileSync('tar', ['-tzf', join(dir, archive)], { stdio: ['ignore', fd, 'inherit'] }) }
  finally { closeSync(fd) }
  const paths = readFileSync(listing, 'utf8').trim().split('\n')
  assert.ok(paths.includes('package/index.js'))
  assert.ok(paths.includes('package/types.d.ts'))
  assert.ok(paths.includes('package/src/carrier.js'))
  assert.ok(paths.every(path => !/^package\/(test|dev|scripts)\//.test(path)))
})

test('the private reservation survives a profile without the optional gateway peer', () => {
  execFileSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { registerHooks } from 'node:module'
    import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
    import { invoke, prefix, runtime } from './test/runtime.mjs'

    const target = prefix + '/api/fixture'
    let attempts = 0
    let webServer
    let reservedAtLoad = false
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('@deepseek-ai/dsh-api-gateway')) {
          attempts++
          const marker = Symbol.for('automagik.multiuser-dsh.reservation')
          reservedAtLoad = Object.hasOwn(webServer, marker) && webServer.match(target) !== intruder
          throw Object.assign(new Error('gateway not installed in this profile'), { code: 'ERR_MODULE_NOT_FOUND' })
        }
        return nextResolve(specifier, context)
      },
    })
    const intruder = { kind: 'exact', path: target, handler() { assert.fail('private route escaped the reservation') } }
    const adapter = await import('./index.js')
    assert.equal(attempts, 0, 'loading the plugin does not require the peer')
    for (const enabled of ['0', '1']) {
      const { ctx, webServer: web } = runtime({ after() {} })
      webServer = web
      new RemoteAccessService(ctx)
      process.env.AUTOMAGIK_MULTIUSER = enabled
      process.env.AUTOMAGIK_CALLER_KEYS = '/missing-fixture-caller-keys.json'
      const activation = ctx.plugin(adapter)
      await activation
      const retained = web.match(target)
      const ready = await invoke(web.match(prefix + '/_ready').handler, {
        url: prefix + '/_ready', method: 'GET', headers: {},
      })
      assert.equal(ready.status, 503)
      await activation.dispose()
      web.register(intruder)
      for (const { handler } of [retained, web.match(target)]) {
        assert.equal((await invoke(handler, { url: target, method: 'POST', headers: {} })).status, 503)
      }
      if (enabled === '0') assert.equal(attempts, 0)
      await ctx.fiber.dispose()
    }
    assert.ok(attempts > 0)
    assert.ok(reservedAtLoad, 'reserve before loading the optional peer')
  `], { cwd: new URL('..', import.meta.url), stdio: 'inherit' })
})
