import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { stageInstall, takeProfileLock, VENDOR } from '../src/host/supervisor/stage.js'
import { BOTS, eventsOf, fixture, putDownloads, read, TO, WELCOME } from './fixtures/supervisor.mjs'

test('stages the whole set in one DSH add and proves the resulting lockfile works offline', async t => {
  const f = fixture(t, { plugins: [BOTS, WELCOME] })
  const inputs = putDownloads(f)
  fs.writeFileSync(join(f.profileDir, 'package.json.lock'), '2147483647\n')
  const release = await takeProfileLock(f.profileDir)
  try {
    assert.equal(fs.readFileSync(join(f.profileDir, 'package.json.lock'), 'utf8'), `${process.pid}\n`)
    await stageInstall(f.config, f.staging, inputs, f.versions)
    assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
    assert.deepEqual(read(join(f.staging.source, 'package.json')), f.manifest)
    assert.deepEqual(fs.readFileSync(join(f.profileDir, 'pnpm-workspace.yaml')),
      fs.readFileSync(join(f.staging.profileDir, 'pnpm-workspace.yaml')))
    for (const plugin of f.release) {
      const spec = read(join(f.staging.profileDir, 'package.json')).dependencies[plugin.name]
      const path = `${VENDOR}/${plugin.sha256}.tgz`
      assert.equal(spec, `file:${path}`)
      assert.equal(read(join(f.staging.profileDir, 'node_modules', plugin.name, 'package.json')).version, TO)
      const live = fs.statSync(join(f.profileDir, path))
      const staged = fs.statSync(join(f.staging.profileDir, path))
      assert.equal(live.ino, staged.ino)
      assert.equal(live.mode & 0o777, 0o600)
      assert.deepEqual(fs.readFileSync(join(f.profileDir, path)), f.tarballs.get(plugin.url))
    }
    assert.deepEqual(eventsOf(f).map(event => event.event), ['add', 'install'])
    assert.equal(eventsOf(f)[0].args.filter(arg => arg.startsWith('file:')).length, 2)
  } finally {
    release()
  }
  assert.equal(fs.existsSync(join(f.profileDir, 'package.json.lock')), false)
})

for (const mode of ['manifest-edit', 'workspace-edit', 'frozen-fails', 'bad-pin']) {
  test(`refuses staging when the fake install produces ${mode}`, async t => {
    const f = fixture(t, { mode })
    const release = await takeProfileLock(f.profileDir)
    try {
      await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions))
      assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
      assert.deepEqual(fs.readdirSync(join(f.profileDir, VENDOR)), [f.archive.split('/').at(-1)])
      assert.ok(fs.existsSync(join(f.profileDir, 'vendor/owner.tgz')))
    } finally {
      release()
    }
  })
}

test('refuses to replace an archive whose existing bytes do not match its name', async t => {
  const f = fixture(t)
  const path = join(f.profileDir, VENDOR, `${f.release[0].sha256}.tgz`)
  fs.writeFileSync(path, 'archive collision')
  const release = await takeProfileLock(f.profileDir)
  try {
    await assert.rejects(stageInstall(f.config, f.staging, putDownloads(f), f.versions), /content address/)
    assert.equal(fs.readFileSync(path, 'utf8'), 'archive collision')
    assert.deepEqual(eventsOf(f), [])
  } finally {
    release()
  }
})
