import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CODEX_RECORD, createImageGen, install as imagegen } from '../src/host/imagegen.js'
import { install as uploads } from '../src/host/shared-uploads.js'

const ENV_KEY = 'sk-inherited-0123456789abcdef'
const ENV_SENTINEL = new RegExp(ENV_KEY)

async function fixture(t, mode = 'workspace-write', reason = 'edit-not-isolated', { access = { ready: true }, codex = true, canEdit = true, grant = false, authScope, resolved } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'edit-guidance-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const data = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const ref = { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, bytes: data.length, mediaType: 'image/png', width: 1, height: 1, name: 'picture.png' }
  const bot = { id: 'test-bot', name: 'the test Bot' }
  let reads = 0
  const rt = { teamTools: [], teamFolder: () => folder, workDirOf: () => undefined,
    botOfSession: () => bot, roomOf: () => undefined, partsOf: () => [], warn() {},
    async *eventsBackwards() { yield { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] } } },
    ctx: { on() {}, inject() {}, get: name => ({
      credentials: { readRecord: async name => grant && name === CODEX_RECORD ? { kind: 'grant', payload: { access: 'test-token' } } : undefined, resolve: async ref => ref === 'OPENAI_API_KEY' ? resolved : undefined },
      attachments: { readImage: async typed => { reads++; assert.equal(typed.name, undefined); return { ref: typed, data } } },
      sandboxPolicy: { resolve: () => ({ mode }) },
      acpAgents: codex ? {
        ...(authScope === undefined ? {} : { authScope }),
        imageAccess: async () => access,
        generateImage: () => assert.fail('no draw'),
        ...(canEdit ? { editImage: async () => { throw Object.assign(new Error('The image run was refused.'), { reason }) } } : {}),
      } : undefined,
    })[name] } }
  uploads(rt); imagegen(rt)
  const tool = rt.teamTools.find(tool => tool.name === 'generate_image')
  const run = () => tool.execute({ image: ref.name, prompt: 'Make it blue' }, { agent: { id: 'test-bot', session: { id: 'test-bot' } }, callId: 'edit' })
  return { rt, tool, run, folder, ref, data, reads: () => reads }
}

for (const mode of ['workspace-write', 'read-only']) test(`isolated-edit failure gives ${mode} guidance, verified bytes and a failed card`, async t => {
  const f = await fixture(t, mode)
  const text = await f.run()
  const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(text.includes(JSON.stringify(path)))
  assert.match(text, /no edited image was made.*\(read-only\)/)
  if (mode === 'read-only') {
    assert.match(text, /cannot write files.*Workspace in your Details/)
    assert.doesNotMatch(text, /If your own tools/)
  } else assert.match(text, /make it on a new file.*check the result.*never say the picture was edited unless you made that file/)
  assert.deepEqual(await readFile(path), f.data)
  assert.equal((await stat(path)).mode & 0o777, 0o444)
  assert.equal(f.reads(), 1)
  assert.equal(f.rt.images.progress('edit').phase, 'failed')
  assert.doesNotMatch(text + f.tool.description, /OpenAI key/)
})

// The issue's rule: when the locked run cannot be set up, the Bot is given its own copy to edit
// the file itself. A Codex whose account check, sign-in or switch enforcement refuses before the
// run (the #1637 preflight) must not answer with a reason alone.
for (const [name, access, detail] of [
  ['unsupported', { ready: false, signedIn: true, reason: 'unsupported', unsupported: true }, /does not take the locked image run/],
  ['signed out', { ready: false, signedIn: false }, /not signed in/],
  ['unconfirmed account', { ready: false, signedIn: true, reason: 'account' }, /not confirmed/],
  ['unloadable config', { ready: false, signedIn: true, reason: 'config' }, /could not load its own configuration/],
  ['unreadable check', { ready: false, signedIn: true, reason: 'unreadable' }, /could not be checked for safe editing/],
]) test(`an edit Codex cannot ready (${name}) still gives the Bot its own copy`, async t => {
  const f = await fixture(t, 'workspace-write', 'edit-not-isolated', { access })
  const text = await f.run()
  const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(text.includes(JSON.stringify(path)), text)
  assert.match(text, /no edited image was made/)
  assert.match(text, detail)
  assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
  assert.deepEqual(await readFile(path), f.data)
  assert.equal((await stat(path)).mode & 0o777, 0o444)
})

test('an edit with no image service at all still gives the Bot its own copy', async t => {
  const f = await fixture(t, 'workspace-write', 'edit-not-isolated', { codex: false })
  const text = await f.run()
  const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(text.includes(JSON.stringify(path)), text)
  assert.match(text, /no edited image was made/)
  assert.match(text, /no image service is connected/)
  assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
})

test('an edit with only an inherited key still gives the Bot its own copy and names why', async t => {
  const fetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; assert.fail('no image request') }
  t.after(() => { globalThis.fetch = fetch })
  for (const [options, detail] of [
    [{ access: { ready: false, signedIn: false } }, /not signed in/],
    [{ access: { ready: false } }, /not ready to edit here/],
    [{ codex: false }, /no image service is connected/],
  ]) {
    const f = await fixture(t, 'workspace-write', 'edit-not-isolated', { ...options, resolved: { value: ENV_KEY, source: 'env' } })
    const text = await f.run()
    const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
    assert.ok(text.includes(JSON.stringify(path)))
    assert.match(text, /no edited image was made/)
    assert.match(text, /OPENAI_API_KEY inherited from the environment.*not used for images.*Settings → Models/)
    assert.match(text, detail)
    assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
    assert.deepEqual(await readFile(path), f.data)
    assert.equal((await stat(path)).mode & 0o777, 0o444)
    const progress = f.rt.images.progress('edit')
    assert.equal(progress, null)
    assert.doesNotMatch(JSON.stringify([text, progress]), ENV_SENTINEL)
  }
  assert.equal(requests, 0)
})

test('an edit Codex cannot ready for its own cause names that cause first, then the inherited key', async t => {
  const access = { ready: false, signedIn: true, reason: 'config' }
  const f = await fixture(t, 'workspace-write', 'edit-not-isolated', { access, resolved: { value: ENV_KEY, source: 'env' } })
  const text = await f.run()
  const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(text.includes(JSON.stringify(path)))
  assert.match(text, /no edited image was made/)
  assert.match(text, /could not load its own configuration.*OPENAI_API_KEY inherited from the environment.*Settings → Models/)
  assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
  assert.deepEqual(await readFile(path), f.data)
  assert.equal((await stat(path)).mode & 0o777, 0o444)
  assert.doesNotMatch(JSON.stringify([text, f.rt.images.progress('edit')]), ENV_SENTINEL)

  const noKey = await fixture(t, 'workspace-write', 'edit-not-isolated', { access })
  const noKeyText = await noKey.run()
  assert.match(noKeyText, /could not load its own configuration/)
  assert.doesNotMatch(noKeyText, /OPENAI_API_KEY/)
})

test('an edit an older Codex service cannot take still gives the Bot its own copy', async t => {
  const f = await fixture(t, 'workspace-write', 'edit-not-isolated', { canEdit: false })
  const text = await f.run()
  const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(text.includes(JSON.stringify(path)), text)
  assert.match(text, /no edited image was made/)
  assert.match(text, /cannot edit pictures/)
  assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
})

// A shared host falls back to the earlier ChatGPT grant whenever its Codex is not ready, for any
// reason. The copy path must still run, and the cause it names must be the access state, not a
// presumed sign-out.
for (const [name, access, wording] of [
  ['signed out', { ready: false, signedIn: false }, /not signed in/],
  ['unloadable config', { ready: false, signedIn: true, reason: 'config' }, /could not load its own configuration/],
]) test(`an edit on a legacy shared grant (${name}) saves the Bot's copy and names the actual cause`, async t => {
  const f = await fixture(t, 'workspace-write', 'edit-not-isolated', { access, grant: true, authScope: 'shared' })
  const text = await f.run()
  const path = join(f.folder, '.automagik/bots/test-bot/uploads', f.ref.attachmentId.slice(7), f.ref.name)
  assert.ok(text.includes(JSON.stringify(path)), text)
  assert.match(text, /no edited image was made/)
  assert.match(text, wording)
  if (access.reason === 'config') assert.doesNotMatch(text, /not signed in/i)
  assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
  assert.deepEqual(await readFile(path), f.data)
  assert.equal((await stat(path)).mode & 0o777, 0o444)
  assert.equal(f.rt.images.progress('edit').phase, 'failed')
})

for (const error of ['os', 'other']) test(`copy ${error} refusal never claims an edit`, async t => {
  const f = await fixture(t)
  f.rt.sharedUploads.save = async () => ({ error, folder: f.folder })
  const text = await f.run()
  assert.match(text, /no edited image was made/)
  assert.match(text, /picture could not be edited here\.$/)
  if (error === 'os') assert.match(text, /operating system refused access.*Privacy & Security/)
  else assert.doesNotMatch(text, /Your copy|operating system/)
  assert.equal(f.rt.images.progress('edit').phase, 'failed')
  assert.doesNotMatch(text, /OpenAI\s+(?:API\s+)?key/i)
  if (error === 'os') {
    assert.ok(text.includes(JSON.stringify(f.folder)))
    assert.match(text, /Files and Folders.*Full Disk Access.*writable for their user/)
  }
})

test('other failures retain their message and do not save a guidance copy', async t => {
  const f = await fixture(t, 'workspace-write', 'other')
  f.rt.sharedUploads.save = () => assert.fail('no fallback')
  assert.equal(await f.run(), 'The image run was refused.')
  assert.equal(f.rt.images.progress('edit').phase, 'failed')
  const source = await readFile(new URL('../src/host/imagegen.js', import.meta.url), 'utf8')
  for (const line of source.split('\n').filter(line => line.includes('throw refused(') || line.includes('const error = refused(') || line.includes('description:'))) assert.doesNotMatch(line, /OpenAI key/)
})

for (const [access, message] of [
  [{ ready: false, reason: 'account' }, /confirm.*Bot's chat.*choose a Codex model/],
  [{ ready: false, unsupported: true }, /update Automagik/],
  [{ ready: false, reason: 'config' }, /fix Codex's config file/],
  [{ ready: false, reason: 'unreadable' }, /try again later/],
  [{ ready: false }, /sign in to Codex.*Bot's chat or Connect AI/],
]) {
  test(`the ${access.reason ?? (access.unsupported ? 'unsupported' : 'signed-out')} refusal gives guidance without suggesting a key`, async () => {
    const images = createImageGen({ credentials: () => ({ readRecord: async () => undefined, resolve: async () => undefined }),
      codex: () => ({ imageAccess: async () => access, generateImage: () => assert.fail('refuse before drawing') }),
      folder: () => assert.fail('no file'), fetch: () => assert.fail('no network') })
    await assert.rejects(images.generate({ prompt: 'A test picture' }), error => {
      assert.equal(error.code, 'bot/unavailable')
      assert.match(error.message, message)
      assert.doesNotMatch(error.message, /OpenAI\s+(?:API\s+)?key/i)
      return true
    })
  })
}

test('edit sign-in and plugin-update refusals suggest Codex and Automagik without a key', async () => {
  const input = { data: Buffer.from('test bytes'), mediaType: 'image/png' }
  for (const shared of [false, true]) {
    const images = createImageGen({
      credentials: () => ({ readRecord: async key => shared && key === CODEX_RECORD ? { kind: 'grant', payload: { access: 'test-token' } } : undefined, resolve: async () => undefined }),
      codex: () => ({ authScope: shared ? 'shared' : 'isolated', imageAccess: async () => ({ ready: !shared, ...(shared ? { signedIn: false } : {}) }), generateImage: () => assert.fail('no draw') }),
      folder: () => assert.fail('no copy'), fetch: () => assert.fail('no network') })
    await assert.rejects(images.generate({ input, prompt: 'Make it blue', callId: 'refused-edit' }), error => {
      assert.match(error.message, shared ? /needs Codex signed in.*Bot's chat/ : /needs a newer Automagik.*update/)
      assert.doesNotMatch(error.message, /OpenAI\s+(?:API\s+)?key/i)
      return true
    })
    assert.equal(images.progress('refused-edit').phase, 'failed')
  }
})

// The legacy-grant branch is reached for any not-ready shared Codex, so its sentence must follow
// what `imageAccess()` said: a configuration failure is not a missing sign-in, and vice versa.
for (const [name, access, wording] of [
  ['signed out', { ready: false, signedIn: false }, /needs Codex signed in.*Bot's chat/],
  ['unloadable config', { ready: false, signedIn: true, reason: 'config' }, /needs Codex to load its configuration.*fix Codex's config file/],
]) test(`the legacy-grant refusal follows imageAccess (${name})`, async () => {
  const images = createImageGen({
    credentials: () => ({ readRecord: async key => key === CODEX_RECORD ? { kind: 'grant', payload: { access: 'test-token' } } : undefined, resolve: async () => undefined }),
    codex: () => ({ authScope: 'shared', imageAccess: async () => access, generateImage: () => assert.fail('no draw') }),
    folder: () => assert.fail('no copy'), fetch: () => assert.fail('no network') })
  const input = { data: Buffer.from('test bytes'), mediaType: 'image/png' }
  await assert.rejects(images.generate({ input, prompt: 'Make it blue', callId: 'legacy-edit' }), error => {
    assert.equal(error.reason, 'edit-not-isolated')
    assert.match(error.message, wording)
    if (access.reason === 'config') assert.doesNotMatch(error.message, /not signed in/i)
    assert.doesNotMatch(error.message, /OpenAI\s+(?:API\s+)?key/i)
    return true
  })
})

test('a quoted working folder and image name remain escaped in the lock guidance', async t => {
  const f = await fixture(t)
  const saved = join(f.folder, 'a\n"`folder', f.ref.name)
  f.rt.sharedUploads.save = async (ref, opts) => {
    assert.deepEqual(opts.data, f.data)
    assert.equal(opts.name, f.ref.name)
    assert.equal(opts.sessionId, 'test-bot')
    assert.equal(ref.name, undefined)
    return { path: saved }
  }
  const text = await f.run()
  assert.ok(text.includes(JSON.stringify(saved)))
  assert.ok(!text.includes('\n'))
  assert.equal(f.reads(), 1)
})

test('a missing copy service still gives honest lock-failure guidance', async t => {
  const f = await fixture(t)
  delete f.rt.sharedUploads
  const text = await f.run()
  assert.match(text, /no edited image was made\. Tell the user the picture could not be edited here\.$/)
  assert.doesNotMatch(text, /Your copy|OpenAI\s+(?:API\s+)?key/i)
  assert.equal(f.rt.images.progress('edit').phase, 'failed')
})

test('the image Settings hint and its Chinese and pt-BR entries direct people to Codex', async () => {
  const hint = "Sign in to Codex from a Bot's chat, and every Bot can draw images in its chats."
  const client = await readFile(new URL('../src/client/image-cell.js', import.meta.url), 'utf8')
  const locales = await readFile(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
  const pt = JSON.parse(await readFile(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  assert.ok(client.includes(hint.replaceAll("'", "\\'")))
  assert.ok(locales.includes(hint.replaceAll("'", "\\'")))
  assert.equal(pt[hint], 'Entre no Codex pelo chat de um Bot, e cada Bot pode desenhar imagens nos chats.')
  assert.doesNotMatch(hint + pt[hint], /OpenAI\s+(?:API\s+)?key/i)
  assert.doesNotMatch(client, /Sign in to Codex[^\n]*or add an OpenAI key/)
})
