// The generated child is own code: fix the pinned virtual environment at build time,
// preserve the embedded interpreter bytes, and pass the unmodified image scanner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { bundleScriptChild, prepareQuickjsSource, quickjsVirtualHomePlugin, readPins } from '../scripts/build-script-child.mjs'
import { applyAllowlist, loadAllowlist, scanTree } from '../../../server/secrecy.mjs'

const PLUGIN = resolve(import.meta.dirname, '..')
const ENGINE = join(PLUGIN, 'node_modules/@jitl/quickjs-singlefile-mjs-release-sync/dist/emscripten-module-Q67P5WYC.mjs')
const ORIGINAL = readFileSync(ENGINE)
const HOME = `HOME:"${['', 'home', 'web_user'].join('/')}"`
const FILE = 'opt/automagik/profile/node_modules/@automagik/bots-dsh/src/host/browser/script-child.js'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fresh = bundleScriptChild()
const scratch = t => {
  const dir = mkdtempSync(join(tmpdir(), 'quickjs-secrecy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A literal-only decoder, never eval/import of an engine. Reject interpolation and
// unsupported escapes; normalize template CR/CRLF and preserve UTF-16 code units.
function literal(source, start) {
  assert.equal(source[start], '`')
  let cooked = ''
  let i = start + 1
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '`': '`', '$': '$', '"': '"', "'": "'" }
  while (i < source.length) {
    let char = source[i++]
    if (char === '`') return { raw: source.slice(start, i), cooked }
    if (char === '$' && source[i] === '{') throw new Error('template interpolation refused')
    if (char === '\r') {
      if (source[i] === '\n') i++
      char = '\n'
    }
    if (char !== '\\') { cooked += char; continue }
    char = source[i++]
    if (char === '\n') continue
    if (char === '\r') { if (source[i] === '\n') i++; continue }
    if (char === 'x' || char === 'u') {
      const count = char === 'x' ? 2 : 4
      const digits = source.slice(i, i + count)
      assert.match(digits, new RegExp(`^[0-9a-fA-F]{${count}}$`))
      cooked += String.fromCharCode(parseInt(digits, 16))
      i += count
    } else {
      if (!Object.hasOwn(escapes, char) || (char === '0' && /[0-9]/.test(source[i] ?? ''))) throw new Error('unsupported literal escape')
      cooked += escapes[char]
    }
  }
  throw new Error('unterminated literal')
}

function wasm(source) {
  const starts = [...source.matchAll(/\bca\(\s*(`\\0asm)/g)]
  assert.equal(starts.length, 1, 'one embedded WASM literal')
  const start = starts[0].index + starts[0][0].indexOf('`')
  const parsed = literal(source, start)
  assert.match(source.slice(start + parsed.raw.length), /^\s*\)/)
  // The pinned ca function converts each UTF-16 code unit, not Unicode code points.
  const bytes = Buffer.alloc(parsed.cooked.length)
  for (let i = 0; i < bytes.length; i++) {
    const unit = parsed.cooked.charCodeAt(i)
    bytes[i] = ~unit >> 8 & unit
  }
  return { ...parsed, bytes }
}

test('the engine transformation fails closed on changed original bytes or HOME structure', () => {
  assert.equal(sha256(ORIGINAL), '931aa7ba3694b7a0469c8e6df620e25692302c13b87d758d427203a2ebdad192')
  assert.throws(() => prepareQuickjsSource(Buffer.concat([ORIGINAL, Buffer.from('\n')])), /original source SHA-256/)
  const source = ORIGINAL.toString('utf8')
  for (const bad of [source.replace(HOME, ''), source.replace(HOME, `${HOME},${HOME}`), source.replace('PWD:"/"', 'PWD:"elsewhere"'), source + source]) {
    assert.throws(() => prepareQuickjsSource(Buffer.from(bad)), /exactly one expected virtual HOME default context/)
  }
  const prepared = prepareQuickjsSource(ORIGINAL)
  assert.equal(prepared, source.replace(HOME, 'HOME:"/"'), 'every other source byte stays the same')
  assert.equal(wasm(prepared).raw, wasm(source).raw)
})

test('the engine hook rejects missed, unexpected and repeated targets', async () => {
  await assert.rejects(build({ stdin: { contents: 'export default 1' }, write: false, logLevel: 'silent', plugins: [quickjsVirtualHomePlugin()] }), /hook must run exactly once/)
  const callbacks = {}
  quickjsVirtualHomePlugin().setup({
    onLoad(options, callback) { callbacks.options = options; callbacks.load = callback },
    onEnd(callback) { callbacks.end = callback },
  })
  assert.equal(callbacks.options.namespace, 'file')
  assert.ok(callbacks.options.filter.test(ENGINE))
  assert.throws(() => callbacks.load({ path: ENGINE.replace('Q67P5WYC', 'UNKNOWN') }), /Unexpected QuickJS engine hook target/)
  assert.throws(() => callbacks.load({ path: join('/unexpected', ENGINE) }), /Unexpected QuickJS engine hook target/)
  const loaded = callbacks.load({ path: ENGINE })
  assert.equal(loaded.contents, prepareQuickjsSource(ORIGINAL))
  assert.equal(loaded.resolveDir, dirname(ENGINE))
  assert.equal(loaded.loader, 'js')
  assert.equal(callbacks.end(), undefined)
  assert.throws(() => callbacks.load({ path: ENGINE }), /hook must run exactly once/)
  assert.match(callbacks.end().errors[0].text, /hook must run exactly once/)
})

test('the literal decoder handles escapes without executing expressions', () => {
  assert.equal(literal('`a\\x41\\u0042\\0\\`\\\\\\$\r\nb`', 0).cooked, 'aAB\0`\\$\nb')
  assert.equal(literal('`a\\\nb`', 0).cooked, 'ab')
  assert.throws(() => literal('`${throwIfExecuted()}`', 0), /interpolation refused/)
  assert.throws(() => literal('`\\xQZ`', 0))
  assert.throws(() => literal('`\\01`', 0), /unsupported/)
  assert.throws(() => literal('`unfinished', 0), /unterminated/)
})

test('fresh ASCII output preserves the exact WASM and all ten original metafile input pins', async () => {
  const { text, pins } = await fresh
  assert.deepEqual(pins, readPins())
  assert.equal(Object.values(pins).reduce((n, pkg) => n + Object.keys(pkg.files).length, 0), 10)
  for (const [name, pkg] of Object.entries(pins)) {
    for (const [file, digest] of Object.entries(pkg.files)) assert.equal(sha256(readFileSync(join(PLUGIN, 'node_modules', name, file))), digest)
  }
  assert.doesNotMatch(text, /[^\x00-\x7f]/)
  const original = wasm(ORIGINAL.toString('utf8')).bytes
  const generated = wasm(text).bytes
  assert.equal(generated.length, 503134)
  assert.equal(sha256(generated), '105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232')
  assert.deepEqual(generated, original)
  assert.equal(text, readFileSync(join(PLUGIN, 'src/host/browser/script-child.js'), 'utf8'))
  assert.doesNotMatch(text, /^\s*import\s[^;]*from\s*["'](?!node:)/m)
})

test('fresh virtual HOME is root and environment overrides and removals still work without host HOME', async () => {
  const { text } = await fresh
  // Execute only the environment provider for this behavioral check, never an engine
  // to extract WASM. The literal decoder above never evaluates source.
  const matches = [...text.matchAll(/\bpa = (\(\) => \{[\s\S]*?\n  \}), U, V =/g)]
  assert.equal(matches.length, 1)
  const provider = matches[0][1]
  assert.doesNotMatch(provider, /process|require|import/)
  const environment = overrides => {
    const context = { U: undefined, T: overrides, t: '', globalThis: { navigator: { language: 'pt-BR' } } }
    Object.defineProperty(context, 'process', { get() { throw new Error('host environment read') } })
    return Object.fromEntries(Array.from(runInNewContext(`(${provider})()`, context, { timeout: 1000 }), value => {
      const at = value.indexOf('=')
      return [value.slice(0, at), value.slice(at + 1)]
    }))
  }
  assert.deepEqual(environment({}), { USER: 'web_user', LOGNAME: 'web_user', PATH: '/', PWD: '/', HOME: '/', LANG: 'pt_BR.UTF-8', _: './this.program' })
  const overridden = environment({ HOME: '/virtual-test', USER: 'guest', LANG: undefined })
  assert.equal(overridden.HOME, '/virtual-test')
  assert.equal(overridden.USER, 'guest')
  assert.equal(Object.hasOwn(overridden, 'LANG'), false)
  assert.equal(Object.hasOwn(environment({ HOME: undefined }), 'HOME'), false)
})

test('the actual fresh child passes the unchanged rootfs scanner and own-code leaks stay forbidden', async t => {
  const { text } = await fresh
  const root = scratch(t)
  const path = join(root, FILE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  const clean = scanTree(root)
  assert.deepEqual(clean.hits, [])
  assert.deepEqual(clean.allowed, [])
  assert.equal(clean.bytes, Buffer.byteLength(text))
  const config = join(scratch(t), 'allowlist.json')
  // Retrieve a denied token only in memory from the original reviewed bundle; no
  // private value is recorded in this test or its diagnostics.
  const { textHits } = await import('../../../server/secrecy.mjs')
  const { denyMatcher } = await import('../../../herdr/scripts/privacy-check.mjs')
  const list = JSON.parse(readFileSync(new URL('../../../herdr/scripts/privacy-list.json', import.meta.url)))
  const old = await import('esbuild').then(({ transform }) => transform(ORIGINAL.toString('utf8'), { charset: 'utf8' }))
  const privateHit = textHits(FILE, old.code, list, denyMatcher(list.deny)).find(hit => hit.rule === 'private-name')
  assert.ok(privateHit, 'the original UTF-8 engine exposes the reviewed private-name candidate')
  for (const [rule, raw] of [
    ['home-path', ['', 'home', 'synthetic_child_test'].join('/')],
    ['private-name', privateHit.raw],
    ['key', ['sk', 'a'.repeat(40)].join('-')],
  ]) {
    writeFileSync(path, `${text}\n// ${raw}\n`)
    const result = scanTree(root)
    assert.ok(result.hits.some(hit => hit.rule === rule), `planted ${rule} must be refused`)
    assert.ok(result.hits.every(hit => hit.file === FILE))
    assert.equal(result.allowed.length, 0)
    const candidate = { file: FILE, rule, sha256: sha256(raw), reason: 'Must remain forbidden' }
    writeFileSync(config, JSON.stringify([candidate]))
    assert.throws(() => loadAllowlist(config), /may not be allowlisted here/)
    assert.equal(applyAllowlist(result.hits, [candidate]).kept.length, result.hits.length)
  }
})
