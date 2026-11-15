import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink,
  writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyUpload, UPLOAD_FILE_BYTES, uploadLeaf } from '../src/host/upload-files.js'

const reference = (data, name = 'x.txt') => ({
  attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  bytes: data.length, name, mediaType: 'application/octet-stream',
})
async function fixture(t, data = Buffer.from('ada')) {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-upload-files-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const ref = reference(data)
  const attachments = { async *readFileStream() { yield data } }
  const options = { cwd, ref, kind: 'file', attachments }
  const folder = join(cwd, '.automagik', 'uploads', ref.attachmentId.slice(7))
  return { ...options, folder, path: join(folder, ref.name), options }
}

test('same bytes and name reuse one read-only copy and keep the ignore file', async t => {
  const f = await fixture(t)
  assert.deepEqual(await copyUpload(f.options), { path: f.path })
  f.attachments.readFileStream = () => { throw new Error('Existing copy needs no store read') }
  assert.deepEqual(await copyUpload(f.options), { path: f.path })
  assert.deepEqual(await readdir(f.folder), ['x.txt'])
  assert.equal((await stat(f.path)).mode & 0o777, 0o444)
  assert.equal((await stat(f.folder)).mode & 0o777, 0o700)
  const ignore = join(f.cwd, '.automagik', 'uploads', '.gitignore')
  assert.equal(await readFile(ignore, 'utf8'), '*\n')
  await writeFile(ignore, '*\n# kept\n')
  await copyUpload(f.options)
  assert.equal(await readFile(ignore, 'utf8'), '*\n# kept\n')
})

for (const data of [Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 0x0d]), Buffer.alloc(0)]) {
  test(`binary copy preserves all ${data.length} bytes`, async t => {
    const f = await fixture(t, data)
    assert.deepEqual(await copyUpload(f.options), { path: f.path })
    assert.deepEqual(await readFile(f.path), data)
  })
}

test('a conflicting leaf is never overwritten, even with the same byte count', async t => {
  const f = await fixture(t)
  await mkdir(f.folder, { recursive: true })
  await writeFile(f.path, 'xxx')
  assert.ok((await copyUpload(f.options)).error)
  assert.equal(await readFile(f.path, 'utf8'), 'xxx')
})

for (const name of ['.automagik', 'uploads']) {
  test(`refuses a symlinked ${name} without writing through it`, async t => {
    const f = await fixture(t)
    const target = join(f.cwd, 'target')
    await mkdir(target)
    const parent = name === '.automagik' ? f.cwd : join(f.cwd, '.automagik')
    if (parent !== f.cwd) await mkdir(parent)
    await symlink(target, join(parent, name))
    assert.ok((await copyUpload(f.options)).error)
    assert.deepEqual(await readdir(target), [])
  })
}

test('a working folder reached through a link copies into its real folder', async t => {
  const f = await fixture(t)
  const alias = `${f.cwd}-link`
  await symlink(f.cwd, alias)
  t.after(() => rm(alias, { force: true }))
  assert.deepEqual(await copyUpload({ ...f.options, cwd: alias }), { path: f.path })
  assert.equal(await readFile(f.path, 'utf8'), 'ada')
})

test('missing, relative and absent working folders start no read', async t => {
  const f = await fixture(t)
  let reads = 0
  f.attachments.readFileStream = () => { reads++; throw new Error('No read expected') }
  for (const cwd of [undefined, 'relative', join(f.cwd, 'missing')]) {
    assert.ok((await copyUpload({ ...f.options, cwd })).error)
  }
  assert.equal(reads, 0)
  assert.deepEqual(await readdir(f.cwd), [])
})

test('declared size above 64 MiB starts no read and makes no folder', async t => {
  const f = await fixture(t)
  let reads = 0
  f.attachments.readFileStream = () => { reads++; throw new Error('No read expected') }
  const ref = { ...f.ref, bytes: UPLOAD_FILE_BYTES + 1 }
  assert.ok((await copyUpload({ ...f.options, ref })).error)
  assert.equal(reads, 0)
  assert.deepEqual(await readdir(f.cwd), [])
})

for (const fault of ['reject', 'oversize', 'digest']) {
  test(`stream ${fault} removes its temporary file`, async t => {
    const f = await fixture(t)
    f.attachments.readFileStream = async function* () {
      yield Buffer.from('x')
      if (fault === 'reject') throw new Error('Store unavailable')
      yield Buffer.from(fault === 'oversize' ? 'xxxx' : 'xx')
    }
    assert.ok((await copyUpload(f.options)).error)
    assert.deepEqual(await readdir(f.folder), [])
  })
}

test('Stop interrupts an uncooperative reader and removes the temporary file', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  let entered
  const reading = new Promise(resolve => { entered = resolve })
  f.attachments.readFileStream = async function* () {
    yield Buffer.from('a')
    entered()
    await new Promise(() => {})
  }
  const pending = copyUpload({ ...f.options, signal: controller.signal })
  await reading
  controller.abort()
  assert.ok((await pending).error)
  assert.deepEqual(await readdir(f.folder), [])
})

test('leaf names cannot escape the content folder', () => {
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
    assert.equal(uploadLeaf({ name }, 'file'), 'file')
    assert.equal(uploadLeaf({ name }, 'image'), 'file')
  }
  assert.equal(uploadLeaf({ mediaType: 'image/jpeg' }, 'image'), 'image.jpg')
})

test('streamed bytes above 64 MiB are refused before writing the chunk', async t => {
  const f = await fixture(t)
  const ref = { ...f.ref, bytes: UPLOAD_FILE_BYTES }
  f.attachments.readFileStream = async function* () { yield Buffer.alloc(UPLOAD_FILE_BYTES + 1) }
  assert.ok((await copyUpload({ ...f.options, ref })).error)
  assert.deepEqual(await readdir(f.folder), [])
})

for (const where of ['digest', 'leaf']) {
  test(`refuses a symlink at the ${where}`, async t => {
    const f = await fixture(t)
    const target = join(f.cwd, 'target')
    if (where === 'leaf') await writeFile(target, 'ada')
    else await mkdir(target)
    await mkdir(where === 'leaf' ? f.folder : join(f.folder, '..'), { recursive: true })
    await symlink(target, where === 'leaf' ? f.path : f.folder)
    assert.ok((await copyUpload(f.options)).error)
    if (where === 'leaf') assert.equal(await readFile(target, 'utf8'), 'ada')
    else assert.deepEqual(await readdir(target), [])
  })
}

test('a conflicting leaf created during a store read is left untouched', async t => {
  const f = await fixture(t)
  f.attachments.readFileStream = async function* () {
    yield Buffer.from('ada')
    await writeFile(f.path, 'xxx')
  }
  assert.ok((await copyUpload(f.options)).error)
  assert.equal(await readFile(f.path, 'utf8'), 'xxx')
  assert.deepEqual(await readdir(f.folder), ['x.txt'])
})

for (const bytes of ['ada', 'xxx']) {
  test(`publication preserves a racing mode-0600 leaf containing ${bytes}`, async t => {
    const f = await fixture(t)
    const publish = fs.link
    let calls = 0
    const mocked = t.mock.method(fs, 'link', async (temp, path) => {
      calls++
      assert.equal(path, f.path)
      assert.equal((await stat(temp)).mode & 0o777, 0o444)
      assert.equal(await readFile(temp, 'utf8'), 'ada')
      await writeFile(path, bytes, { mode: 0o600 })
      return publish(temp, path)
    })
    syncBuiltinESMExports()
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
    const result = await copyUpload(f.options)
    if (bytes === 'ada') assert.deepEqual(result, { path: f.path })
    else assert.match(result.error.message, /already exists with different bytes/)
    assert.equal(calls, 1)
    assert.equal(await readFile(f.path, 'utf8'), bytes)
    assert.equal((await stat(f.path)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(f.folder), ['x.txt'])
  })
}

test('a matching hard link conflicts without changing the outside file mode', async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'acp-upload-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const path = join(outside, 'x.txt')
  await mkdir(f.folder, { recursive: true })
  await writeFile(path, 'ada', { mode: 0o600 })
  await link(path, f.path)
  const result = await copyUpload(f.options)
  assert.match(result.error.message, /already exists with different bytes/)
  assert.equal(await readFile(path, 'utf8'), 'ada')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('existing copies use the opened file size instead of a stale lstat size', async t => {
  const f = await fixture(t)
  await mkdir(f.folder, { recursive: true })
  await writeFile(f.path, 'ada', { mode: 0o600 })
  const inspect = fs.lstat
  const mocked = t.mock.method(fs, 'lstat', async path => {
    const result = await inspect(path)
    if (path === f.path) result.size++
    return result
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  assert.deepEqual(await copyUpload(f.options), { path: f.path })
  assert.equal((await stat(f.path)).mode & 0o777, 0o600)
})

for (const before of ['temp open', 'publication']) {
  test(`a parent directory swap before ${before} fails containment`, async t => {
    const f = await fixture(t)
    const outside = await mkdtemp(join(tmpdir(), 'acp-upload-outside-'))
    t.after(() => rm(outside, { recursive: true, force: true }))
    const parent = join(f.cwd, '.automagik')
    const moved = before === 'temp open' ? join(f.cwd, 'moved') : join(outside, 'moved')
    const target = before === 'temp open' ? outside : moved
    const targetFolder = join(target, 'uploads', f.ref.attachmentId.slice(7))
    if (before === 'temp open') await mkdir(targetFolder, { recursive: true })
    const inspect = fs.lstat
    let checks = 0
    const mocked = t.mock.method(fs, 'lstat', async path => {
      try { return await inspect(path) } catch (error) {
        if (path === f.path && ++checks === (before === 'temp open' ? 1 : 2)) {
          assert.equal(error.code, 'ENOENT')
          await rename(parent, moved)
          await symlink(target, parent)
        }
        throw error
      }
    })
    syncBuiltinESMExports()
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
    const result = await copyUpload(f.options)
    assert.match(result.error.message, /Unsafe upload directory/)
    assert.equal(checks, before === 'temp open' ? 1 : 2)
    assert.deepEqual(await readdir(targetFolder), [])
    const entries = before === 'temp open' ? [] : ['.gitignore']
    assert.deepEqual(await readdir(join(target, 'uploads')),
      [...entries, f.ref.attachmentId.slice(7)].sort())
  })
}

test('a temp file swapped for a symlink during the read is never published', async t => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'acp-upload-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const secret = join(outside, 'secret.txt')
  await writeFile(secret, 'ada', { mode: 0o600 })
  f.attachments.readFileStream = async function* () {
    const [temp] = (await readdir(f.folder)).filter(name => name.startsWith('.upload-'))
    await rm(join(f.folder, temp))
    await symlink(secret, join(f.folder, temp))
    yield Buffer.from('ada')
  }
  assert.match((await copyUpload(f.options)).error.message, /changed before it was published/)
  // The substitute is not ours, so it stays; it is never published at the leaf.
  assert.ok(!(await readdir(f.folder)).includes('x.txt'))
  assert.equal((await stat(secret)).mode & 0o777, 0o600)
})

test('a FIFO at the leaf is refused without opening it', { skip: process.platform === 'win32' },
  async t => {
    const { execFileSync } = await import('node:child_process')
    const f = await fixture(t)
    await mkdir(f.folder, { recursive: true })
    execFileSync('mkfifo', [f.path])
    let reads = 0
    f.attachments.readFileStream = () => { reads++; throw new Error('No read expected') }
    assert.match((await copyUpload(f.options)).error.message, /already exists/)
    assert.equal(reads, 0)
  })

test('Stop during the last folder check publishes nothing', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const resolveReal = fs.realpath
  let checks = 0
  const mocked = t.mock.method(fs, 'realpath', async path => {
    const real = await resolveReal(path)
    // The first call resolves the chat folder; the next two are the two folder checks.
    if (++checks === 5) controller.abort(new Error('Stopped'))
    return real
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  assert.ok((await copyUpload({ ...f.options, signal: controller.signal })).error)
  assert.ok(checks >= 5)
  assert.deepEqual(await readdir(f.folder), [])
})

test('a temp entry replaced by another file during the read is left in place', async t => {
  const f = await fixture(t)
  let temp
  f.attachments.readFileStream = async function* () {
    ;[temp] = (await readdir(f.folder)).filter(name => name.startsWith('.upload-'))
    await rm(join(f.folder, temp))
    await writeFile(join(f.folder, temp), 'someone')
    yield Buffer.from('ada')
  }
  assert.ok((await copyUpload(f.options)).error)
  assert.equal(await readFile(join(f.folder, temp), 'utf8'), 'someone')
  assert.deepEqual(await readdir(f.folder), [temp])
})

test('a leaf replaced right after publication is left in place', async t => {
  const f = await fixture(t)
  const publish = fs.link
  const mocked = t.mock.method(fs, 'link', async (temp, path) => {
    await publish(temp, path)
    await rm(path)
    await writeFile(path, 'someone')
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  assert.match((await copyUpload(f.options)).error.message, /changed before it was published/)
  assert.equal(await readFile(f.path, 'utf8'), 'someone')
  assert.deepEqual(await readdir(f.folder), ['x.txt'])
})
