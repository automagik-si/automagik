import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { gzipSync } from 'node:zlib'
import { createOmniInstaller } from '../src/host/omni-github.js'
import { install } from '../src/host/endpoint.js'
import { fakeContext } from './fake-ctx.js'

function tarEntry(name, type, body = '') {
  const header = Buffer.alloc(512)
  const bytes = Buffer.from(body)
  header.write(name)
  header.write('0000644', 100)
  header.write(String(bytes.length.toString(8)).padStart(11, '0'), 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar', 257)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

function pax(key, value) {
  const record = `${key}=${value}\n`
  let length = Buffer.byteLength(record) + 2
  while (length !== Buffer.byteLength(record) + String(length).length + 1) length++
  return `${length} ${record}`
}

test('a correct archive commit comment with the wrong tree cannot extract, download Bun, or spawn', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'omni-contract-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'omni')
  const pin = { version: '2.261112.6', commit: 'e'.repeat(40), tree: '0'.repeat(40) }
  const archive = gzipSync(Buffer.concat([
    tarEntry('pax_global_header', 'g', pax('comment', pin.commit)),
    tarEntry('omni-fixture/', '5'),
    tarEntry('omni-fixture/package.json', '0', '{"name":"wrong-tree"}\n'),
    Buffer.alloc(1024),
  ]))
  const requests = []
  let spawned = 0
  const installer = createOmniInstaller({
    env: { HOME: scratch, OMNI_HOME: root, PATH: join(scratch, 'empty-path') },
    platform: 'linux', arch: 'x64', pin, run: async () => 1,
    probe: async () => ({ npm: 'unpublished', latest: null }),
    spawn: () => { spawned++; throw new Error('Bun or Omni must not run') },
    fetch: async url => {
      requests.push(url)
      if (url.endsWith('/git/ref/tags/v' + pin.version)) {
        return new Response(JSON.stringify({ object: { type: 'commit', sha: pin.commit } }))
      }
      if (url.endsWith('/git/commits/' + pin.commit)) {
        return new Response(JSON.stringify({ tree: { sha: pin.tree } }))
      }
      if (url.endsWith('/tar.gz/' + pin.commit)) return new Response(archive)
      throw new Error('Unexpected download: ' + url)
    },
  })

  await installer.start({ version: '2.261109.2', reason: 'unpublished' })
  let job
  for (let i = 0; i < 300; i++) {
    job = installer.view()
    if (job.phase !== 'running') break
    await delay(10)
  }
  assert.equal(job.phase, 'failed', 'the archive verifier should finish')
  assert.match(job.error, /pinned Git tree/)
  assert.ok(requests.some(url => url.endsWith('/tar.gz/' + pin.commit)))
  assert.equal(requests.some(url => url.includes('oven-sh')), false)
  assert.equal(spawned, 0)
  assert.deepEqual(readdirSync(join(root, 'automagik-build')), [])
  for (const path of ['sandbox', 'automagik-bun', 'packages']) {
    assert.equal(existsSync(join(root, path)), false, path)
  }
})

test('both pin writers carry the candidate tree into Welcome while desktop omni.json stays unchanged in shape', () => {
  const workflow = name => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')
  const follow = workflow('follow-omni.yml')
  const boot = workflow('boot-check.yml')
  const program = text => text.match(/\n {10}node -e '\n([\s\S]*?)\n {10}' "\$\{(?:OMNI_)?VERSION\}" "\$\{(?:OMNI_)?COMMIT\}" "\$\{(?:TREE|tree)\}"/)?.[1]
  assert.ok(program(follow), 'follow carries a pin writer')
  assert.equal(program(boot), program(follow), 'boot checks the same candidate shape as follow')
  for (const text of [follow, boot]) {
    assert.match(text, /gh api "repos\/[^\n]+\/git\/commits\/\$\{[^}]+\}" --jq \.tree\.sha/)
    assert.match(text, /\[\[ "\$\{tree\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  }

  const desktop = 'apps/desktop/omni.json'
  const welcome = 'apps/welcome-dsh/package.json'
  const files = new Map([
    [desktop, JSON.stringify({ repository: 'https://github.com/automagik-si/omni', version: 'old', commit: 'old' })],
    [welcome, JSON.stringify({ automagik: { omni: { repository: 'https://github.com/automagik-si/omni', version: 'old', commit: 'old' } } })],
  ])
  const fs = {
    readFileSync: name => files.get(name),
    writeFileSync: (name, data) => files.set(name, data),
  }
  const version = '2.261112.6'
  const commit = 'e'.repeat(40)
  const tree = 'b'.repeat(40)
  runInNewContext(program(follow), { require: () => fs, process: { argv: ['node', version, commit, tree] } })
  assert.deepEqual(JSON.parse(files.get(desktop)), {
    repository: 'https://github.com/automagik-si/omni', version, commit,
  })
  assert.deepEqual(JSON.parse(files.get(welcome)).automagik.omni, {
    repository: 'https://github.com/automagik-si/omni', version, commit, tree,
  })
})

test('a read-only capability check does not offer an install job that mutations will refuse', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'omni-read-only-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const message = 'Read-only team view.'
  const { ctx } = fakeContext({
    entries: { 'omni-ai': {} },
    services: { omniTeam: { readOnly: () => message } },
  })
  const version = '2.261112.6'
  const handle = install(ctx, {
    env: { HOME: scratch, OMNI_HOME: join(scratch, 'omni'), AUTOMAGIK_GATE_IMAGE: '1', AUTOMAGIK_OMNI_SUPERVISOR: '1' },
    fetch: async () => new Response(null, { status: 200 }),
    omniServer: { platform: 'linux' },
    omniInstaller: { platform: 'linux' },
  }).handle
  assert.deepEqual(await handle('omni-server-check', { version, fallback: true }), {
    ok: true, value: { ok: false, reason: 'no-systemd', version, npmHas: false, fallback: null },
  })
  assert.deepEqual(await handle('omni-github-install', { version, reason: 'no-systemd' }), {
    ok: false, error: { code: 'omni-ai/refused', message },
  })
})
