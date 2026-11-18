import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { install, uploadLeaf } from '../src/host/shared-uploads.js'

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'bot-upload-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const data = Buffer.from('verified picture bytes')
  const hex = createHash('sha256').update(data).digest('hex')
  const ref = { attachmentId: `sha256:${hex}`, name: 'picture.png', mediaType: 'image/png', bytes: data.length, width: 1, height: 1 }
  const bot = { id: 'test-bot', name: 'the test Bot' }
  let reads = 0
  const warnings = []
  const attachments = { readImage: async ref => { reads++; return { ref, data } } }
  const rt = { ctx: { on() {}, get: () => attachments }, botOfSession: () => bot,
    workDirOf: () => undefined, teamFolder: () => folder, chatOf: id => id,
    warn: (...args) => warnings.push(args) }
  install(rt)
  const region = join(folder, '.automagik', 'bots', bot.id, 'uploads')
  const path = join(region, hex, ref.name)
  return { rt, bot, folder, region, path, hex, ref, data, attachments, warnings, reads: () => reads,
    save: opts => rt.sharedUploads.save(ref, { sessionId: bot.id, ...opts }) }
}
function mockFs(t, name, fn) {
  const mock = t.mock.method(fs, name, fn)
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}

test('per-Bot layout, modes, ignore files, memo and verified-byte shortcut', async t => {
  const f = await fixture(t)
  const [one, two] = await Promise.all([f.save(), f.save()])
  assert.deepEqual(one, { path: f.path })
  assert.deepEqual(two, one)
  assert.equal(f.reads(), 1)
  assert.deepEqual(await readFile(f.path), f.data)
  assert.equal((await stat(f.path)).mode & 0o777, 0o444)
  for (const path of ['.automagik', '.automagik/bots', '.automagik/bots/test-bot', '.automagik/bots/test-bot/uploads', `.automagik/bots/test-bot/uploads/${f.hex}`]) assert.equal((await stat(join(f.folder, path))).mode & 0o777, 0o700)
  for (const dir of [dirname(dirname(f.region)), f.region]) {
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '*\n')
    assert.equal((await stat(join(dir, '.gitignore'))).mode & 0o777, 0o600)
  }
  await f.save()
  assert.equal(f.reads(), 1)
  await rm(f.path)
  await f.save({ data: f.data })
  assert.equal(f.reads(), 1)
})

test('own, team and group member working folders; invalid id and missing owner', async t => {
  const f = await fixture(t)
  const own = join(f.folder, 'own'), group = join(f.folder, 'member')
  await mkdir(own); await mkdir(group)
  f.rt.workDirOf = ({ roomId }) => roomId ? group : own
  f.rt.groupOwners = new Map([['group-session', { roomId: 'g' }]])
  assert.equal(await f.rt.sharedUploads.regionFor('chat'), join(own, '.automagik/bots/test-bot/uploads'))
  assert.equal(await f.rt.sharedUploads.regionFor('group-session'), join(group, '.automagik/bots/test-bot/uploads'))
  for (const id of ['../bad', '', 'a/b', 'x'.repeat(129)]) {
    f.bot.id = id
    assert.equal((await f.save()).path, undefined)
  }
  f.rt.botOfSession = () => undefined
  assert.equal(f.rt.sharedUploads.grantedTo('chat'), undefined)
  assert.equal((await f.save()).path, undefined)
})

test('leaf matches ACP rules verbatim', () => {
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', 'x\0y']) assert.equal(uploadLeaf({ name }, 'image'), 'file')
  for (const name of ['x.png', 'a\n"`b.png']) assert.equal(uploadLeaf({ name }, 'image'), name)
  assert.equal(uploadLeaf({ mediaType: 'image/png' }, 'image'), 'image.png')
})

for (const level of ['.automagik', '.automagik/bots', '.automagik/bots/test-bot', '.automagik/bots/test-bot/uploads', 'hash', 'leaf']) {
  test(`a symlink at ${level} cannot be followed`, async t => {
    const f = await fixture(t)
    const target = join(f.folder, 'outside')
    await mkdir(target)
    const path = level === 'hash' ? dirname(f.path) : level === 'leaf' ? f.path : join(f.folder, level)
    await mkdir(dirname(path), { recursive: true })
    await symlink(target, path)
    assert.equal((await f.save()).path, undefined)
    assert.equal(f.warnings.length, 1)
    assert.deepEqual(await readdir(target), [])
  })
}

test('non-directory parent, conflicting bytes and a hard link are never overwritten', async t => {
  const f = await fixture(t)
  await writeFile(join(f.folder, '.automagik'), 'parent')
  assert.equal((await f.save()).path, undefined)
  await rm(join(f.folder, '.automagik'))
  await mkdir(dirname(f.path), { recursive: true })
  const wrong = Buffer.alloc(f.data.length, 42)
  await writeFile(f.path, wrong)
  assert.equal((await f.save()).path, undefined)
  assert.deepEqual(await readFile(f.path), wrong)
  await writeFile(f.path, f.data)
  await link(f.path, join(f.folder, 'alias'))
  assert.equal((await f.save()).path, undefined)
})

test('memo rechecks ctime and replaced parents instead of trusting a path', async t => {
  const f = await fixture(t)
  await f.save()
  await chmod(f.path, 0o600)
  await writeFile(f.path, Buffer.alloc(f.data.length, 42))
  assert.equal((await f.save()).path, undefined)
  await rename(dirname(f.path), `${dirname(f.path)}-old`)
  await mkdir(dirname(f.path))
  await writeFile(f.path, Buffer.alloc(f.data.length, 43))
  assert.equal((await f.save()).path, undefined)
  assert.equal(f.reads(), 1)
})

test('bad references, mismatched store references, lengths and hashes never publish', async t => {
  const f = await fixture(t)
  for (const ref of [{ ...f.ref, attachmentId: 'file:/tmp/no' }, { ...f.ref, bytes: 64 * 1024 * 1024 + 1 }, { ...f.ref, bytes: -1 }]) assert.equal((await f.rt.sharedUploads.save(ref, { sessionId: 'test-bot' })).path, undefined)
  for (const stored of [{ ref: { ...f.ref, width: 2 }, data: f.data }, { ref: f.ref, data: f.data.subarray(1) }, { ref: f.ref, data: Buffer.alloc(f.data.length) }]) {
    f.attachments.readImage = async () => stored
    assert.equal((await f.save()).path, undefined)
    assert.deepEqual(await readdir(dirname(f.path)), [])
  }
})

test('a stalled store is bounded even when it ignores cancellation', async t => {
  const f = await fixture(t)
  f.attachments.readImage = () => new Promise(() => {})
  // Keep the test alive while AbortSignal.timeout's unref timer runs.
  const keep = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keep))
  const start = Date.now()
  assert.equal((await f.save()).path, undefined)
  assert.ok(Date.now() - start < 11_500)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(await readdir(dirname(f.path)), [])
})

test('a Bot made private or removed during the store read publishes nothing', async t => {
  for (const gone of [false, true]) {
    const f = await fixture(t)
    const privateFolder = join(f.folder, 'private')
    await mkdir(privateFolder)
    f.attachments.readImage = async ref => {
      if (gone) f.rt.botOfSession = () => undefined
      else { f.bot.private = true; f.rt.workDirOf = () => privateFolder }
      return { ref, data: f.data }
    }
    assert.equal((await f.save()).path, undefined)
    assert.deepEqual(await readdir(dirname(f.path)), [])
  }
})

for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  test(`${code} returns the folder, warns once and adds actionable OS text`, async t => {
    const f = await fixture(t)
    mockFs(t, 'mkdir', async () => { throw Object.assign(new Error('blocked'), { code }) })
    assert.deepEqual(await f.save(), { error: 'os', folder: f.folder })
    assert.equal(f.warnings.length, 1)
    assert.deepEqual(f.warnings[0], ['ds-bot: upload %s not saved for %s: the system refused access to %s', f.hex.slice(0, 12), 'test-bot', f.folder])
    const rows = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: f.ref }] }]
    const result = await f.rt.sharedUploads.withPaths(rows, 'test-bot', 'native')
    assert.match(result[0].content[1].text, /operating system refused access.*Privacy & Security.*Full Disk Access.*writable/)
    assert.ok(result[0].content[1].text.includes(JSON.stringify(f.folder)))
  })
}

for (const substitution of ['symlink', 'file']) {
  test(`substituted temp ${substitution} is never published or removed`, async t => {
    const f = await fixture(t)
    const outside = join(f.folder, 'outside')
    await writeFile(outside, 'unchanged', { mode: 0o600 })
    let temp
    f.attachments.readImage = async ref => {
      temp = join(dirname(f.path), (await readdir(dirname(f.path))).find(name => name.startsWith('.upload-')))
      await rm(temp)
      if (substitution === 'symlink') await symlink(outside, temp)
      else await writeFile(temp, 'substitute')
      return { ref, data: f.data }
    }
    assert.equal((await f.save()).path, undefined)
    assert.equal(await readFile(outside, 'utf8'), 'unchanged')
    assert.ok(await lstat(temp))
    assert.deepEqual(await readdir(dirname(f.path)), [temp.split('/').at(-1)])
  })
}

test('replaced published file is refused and left in place', async t => {
  const f = await fixture(t)
  const publish = fs.link
  mockFs(t, 'link', async (temp, path) => {
    await publish(temp, path)
    await rm(path)
    await writeFile(path, 'someone else')
  })
  assert.equal((await f.save()).path, undefined)
  assert.equal(await readFile(f.path, 'utf8'), 'someone else')
  assert.deepEqual(await readdir(dirname(f.path)), [f.ref.name])
})

for (const when of ['before temp', 'before publication']) {
  test(`a parent swapped ${when} is rechecked before writing through it`, async t => {
    const f = await fixture(t)
    const parent = join(f.folder, '.automagik')
    const moved = join(f.folder, 'moved')
    const open = fs.open
    let swapped = false
    if (when === 'before temp') {
      mockFs(t, 'open', async (path, ...args) => {
        if (path === f.path && !swapped) {
          swapped = true
          await rename(parent, moved)
          await symlink(moved, parent)
          throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        }
        return open(path, ...args)
      })
    } else {
      f.attachments.readImage = async ref => {
        await rename(parent, moved)
        await symlink(moved, parent)
        swapped = true
        return { ref, data: f.data }
      }
    }
    assert.equal((await f.save()).path, undefined)
    assert.equal(swapped, true)
    assert.deepEqual(await readdir(join(moved, 'bots/test-bot/uploads', f.hex)), [])
  })
}

test('an EEXIST publication race validates the existing bytes without replacing them', async t => {
  const f = await fixture(t)
  mockFs(t, 'link', async (_temp, path) => {
    await writeFile(path, f.data, { mode: 0o444 })
    throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  })
  assert.deepEqual(await f.save(), { path: f.path })
  assert.deepEqual(await readFile(f.path), f.data)
  assert.deepEqual(await readdir(dirname(f.path)), [f.ref.name])
})

test('temporary files are private and a caller stop removes them', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.attachments.readImage = async ref => {
    const [temp] = await readdir(dirname(f.path))
    assert.match(temp, /^\.upload-/)
    assert.equal((await stat(join(dirname(f.path), temp))).mode & 0o777, 0o600)
    controller.abort()
    return { ref, data: f.data }
  }
  assert.equal((await f.save({ signal: controller.signal })).path, undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(await readdir(dirname(f.path)), [])
})

test('verified-byte shortcuts still check the length and hash without reading a path', async t => {
  const f = await fixture(t)
  f.attachments.readImage = () => assert.fail('the verified-byte path must not read the store')
  for (const data of [Buffer.alloc(f.data.length), f.data.subarray(1), 'not bytes']) {
    assert.equal((await f.save({ data })).path, undefined)
    assert.deepEqual(await readdir(dirname(f.path)), [])
  }
  assert.deepEqual(await f.save({ data: f.data }), { path: f.path })
})

test('a working-folder change during a read removes the old temporary copy', async t => {
  const f = await fixture(t)
  const moved = join(f.folder, 'new-working-folder')
  await mkdir(moved)
  f.attachments.readImage = async ref => {
    f.rt.workDirOf = () => moved
    return { ref, data: f.data }
  }
  assert.equal((await f.save()).path, undefined)
  assert.deepEqual(await readdir(dirname(f.path)), [])
  assert.deepEqual(await readdir(moved), [])
})

for (const parent of ['.automagik/bots', '.automagik/bots/test-bot/uploads']) {
  test(`a linked ignore file under ${parent} is refused without touching its target`, async t => {
    const f = await fixture(t)
    const outside = join(f.folder, 'keep.txt')
    await writeFile(outside, 'keep')
    await mkdir(join(f.folder, parent), { recursive: true })
    await symlink(outside, join(f.folder, parent, '.gitignore'))
    assert.equal((await f.save()).path, undefined)
    assert.equal(await readFile(outside, 'utf8'), 'keep')
    assert.equal(f.warnings.length, 1)
  })
}

test('saved-picture names are bounded, control-free and JSON quoted, with an unnamed fallback', async t => {
  const f = await fixture(t)
  for (const name of ['\n"`' + 'x'.repeat(150), undefined, '\n\u0000']) {
    const rows = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { ...f.ref, name } }] }]
    const before = structuredClone(rows)
    const saved = await f.rt.sharedUploads.withPaths(rows, 'test-bot', 'native')
    const expected = name?.replace(/\p{Cc}/gu, '').slice(0, 120) || 'unnamed picture'
    assert.ok(saved[0].content[1].text.includes(`copy of ${JSON.stringify(expected)} at `))
    assert.deepEqual(rows, before)
  }
})

test('an OS refusal at the working folder itself returns its JSON-quoted path', async t => {
  const f = await fixture(t)
  const real = fs.realpath
  mockFs(t, 'realpath', async path => {
    if (path === f.folder) throw Object.assign(new Error('blocked folder'), { code: 'EPERM' })
    return real(path)
  })
  assert.deepEqual(await f.save(), { error: 'os', folder: f.folder })
  assert.equal(f.warnings.length, 1)
  assert.deepEqual(await readdir(f.folder), [])
})

test('holding requires verified regular bytes, not a directory, link, corrupt file or remembered grant', async t => {
  const f = await fixture(t)
  const holds = () => f.rt.sharedUploads.holds(f.bot.id, f.hex)
  await mkdir(dirname(f.path), { recursive: true })
  f.rt.sharedUploads.grantedTo(f.bot.id).add(f.hex)
  assert.equal(await holds(), false)
  await mkdir(f.path)
  assert.equal(await holds(), false)
  await rm(f.path, { recursive: true })
  await writeFile(f.path, Buffer.alloc(f.data.length))
  assert.equal(await holds(), false)
  await writeFile(f.path, f.data)
  assert.equal(await holds(), true)
  await link(f.path, join(f.folder, 'alias'))
  assert.equal(await holds(), false)
  await rm(join(f.folder, 'alias'))
  assert.equal(await holds(), true)
  await rm(f.path)
  await writeFile(join(f.folder, 'outside'), f.data)
  await symlink(join(f.folder, 'outside'), f.path)
  assert.equal(await holds(), false)
  await rm(f.path)
  await writeFile(f.path, f.data)
  assert.equal(await holds(), true)
  await writeFile(f.path, Buffer.alloc(f.data.length))
  assert.equal(await holds(), false, 'a memoized copy must still be checked after mutation')
})

for (const code of ['EACCES', 'EPERM']) test(`DSH store ${code} is reported as a store error, not a folder refusal`, async t => {
  const f = await fixture(t)
  f.attachments.readImage = async () => { throw Object.assign(new Error('store blocked'), { code }) }
  assert.deepEqual(await f.save(), { error: 'store', code })
  assert.deepEqual(f.warnings[0], ['ds-bot: DSH image store read failed: %s', code])
  const rows = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: f.ref }] }]
  const shown = await f.rt.sharedUploads.withPaths(rows, f.bot.id, 'native')
  assert.match(shown[0].content[1].text, new RegExp(`DSH's image store could not be read \\(${code}\\)`))
  assert.doesNotMatch(shown[0].content[1].text, /Privacy & Security|folder writable|refused access to/)
})
