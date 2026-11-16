// Actual Codex filesystem-helper reads, without credentials or a model request (#870).
// Opt-in: AUTOMAGIK_TEST_CODEX must name the native binary (not a JS launcher), and
// AUTOMAGIK_TEST_CODEX_RUNTIME_IMAGE a public PNG in a platform runtime read root.
// This mirrors fs_sandbox.rs's runtime grants; it does not exercise ACP's per-turn path
// or prove that the image tool uses the selected profile. See README, "Image read evidence".
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { configArgs, IMAGE_PROFILE_DESCRIPTION, IMAGE_PROFILE_GRANTS } from '../src/host/image.js'

const CODEX = process.env.AUTOMAGIK_TEST_CODEX
const RUNTIME_IMAGE = process.env.AUTOMAGIK_TEST_CODEX_RUNTIME_IMAGE
const skip = !['linux', 'darwin'].includes(process.platform)
  ? 'native Windows helper enforcement needs its own backend test'
  : !(CODEX && RUNTIME_IMAGE)
      ? 'set AUTOMAGIK_TEST_CODEX and AUTOMAGIK_TEST_CODEX_RUNTIME_IMAGE for real helper reads'
      : false
if (process.env.AUTOMAGIK_REQUIRE_IMAGE_READ_TEST === '1') {
  assert.equal(skip, false, 'the real-Codex CI job must run these reads, not skip them')
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9aw' +
  'AAAABJRU5ErkJggg==', 'base64',
)

test('real Codex helper: scratch containment includes runtime reads', { skip }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'acp-image-read-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['home', 'codex', 'scratch', 'tmp']) mkdirSync(join(root, dir))
  const cwd = join(root, 'scratch')
  const inside = join(cwd, 'inside.png')
  const outside = join(root, 'outside.png')
  writeFileSync(inside, PNG)
  writeFileSync(outside, PNG)
  symlinkSync(outside, join(cwd, 'escape.png'))
  symlinkSync(root, join(cwd, 'escape-dir'))
  const binary = realpathSync(CODEX)
  const profile = { id: `automagik-image-${'a'.repeat(32)}` }
  // The helper itself adds these grants in Codex 0.167.1. The sandbox CLI does not;
  // reproduce them explicitly while retaining the production profile's actual rules.
  const config = { default_permissions: profile.id, permissions: { [profile.id]: { description: IMAGE_PROFILE_DESCRIPTION, filesystem: { ...IMAGE_PROFILE_GRANTS, ':minimal': 'read', [binary]: 'read' } } } }
  const env = {
    PATH: process.env.PATH, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'),
    TMPDIR: join(root, 'tmp'), NO_COLOR: '1',
  }
  const read = (uri, sandbox = true) => {
    const args = sandbox ? [
      'sandbox', '-P', profile.id, '-C', cwd,
      ...configArgs(config),
      '--', binary, '--codex-run-as-fs-helper',
    ] : ['--codex-run-as-fs-helper']
    const result = spawnSync(binary, args, {
      cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 << 20,
      input: JSON.stringify({ operation: 'fs/readFile', params: { path: uri } }) + '\n',
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `helper must start and answer: ${result.stderr}`)
    return JSON.parse(result.stdout)
  }
  const allowed = (answer, expected) => {
    assert.equal(answer.status, 'ok', JSON.stringify(answer))
    assert.equal(answer.payload.operation, 'fs/readFile')
    assert.deepEqual(Buffer.from(answer.payload.response.dataBase64, 'base64'), expected)
  }
  // Prove both canaries exist and the real helper can read them before judging denials.
  allowed(read(pathToFileURL(outside).href, false), PNG)
  await t.test('inside PNG is read byte for byte', () => {
    allowed(read(pathToFileURL(inside).href), PNG)
  })
  for (const [name, uri] of [
    ['outside', pathToFileURL(outside).href],
    ['symlink leaf', pathToFileURL(join(cwd, 'escape.png')).href],
    ['symlink directory', pathToFileURL(join(cwd, 'escape-dir', 'outside.png')).href],
    // Preserve the traversal in the request instead of normalizing it with path.join.
    ['parent traversal', pathToFileURL(cwd).href + '/../outside.png'],
  ]) {
    await t.test(`${name} PNG is denied`, () => {
      const answer = read(uri)
      assert.equal(answer.status, 'error', JSON.stringify(answer))
      assert.match(answer.payload.message, /permission denied|not found|no such file/i)
      assert.equal(JSON.stringify(answer).includes(PNG.toString('base64')), false)
    })
  }
  await t.test('runtime PNG outside scratch is allowed by design', () => {
    const file = realpathSync(RUNTIME_IMAGE)
    assert.equal(file.startsWith(root + '/'), false, 'runtime fixture must be outside scratch')
    const bytes = readFileSync(file)
    assert.deepEqual(bytes.subarray(0, 8), PNG.subarray(0, 8), 'runtime fixture must be a PNG')
    allowed(read(pathToFileURL(file).href), bytes)
  })
})
