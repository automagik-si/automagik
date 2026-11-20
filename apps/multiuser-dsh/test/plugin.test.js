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
