import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { CODEX_IMAGES, CODEX_RECORD, OPENAI_IMAGES, OPENAI_RECORD, createImageGen, install, sseEvents } from '../src/host/imagegen.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
const PARTIAL = Buffer.from('partial-image').toString('base64')
// A token whose payload names the ChatGPT account, as the sign-in's tokens do.
const tokenFor = account => `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.sig`

const folderOf = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-images-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
// A credential store holding `records`, whose modifyRecord runs its callback like DSH's.
const storeOf = (records) => ({
  records,
  readRecord: async key => records[key],
  modifyRecord: async (key, mutate) => { records[key] = await mutate(records[key]); return records[key] },
  resolve: async () => undefined,
})
const sse = events => new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
// Legacy compatibility tests require a host positively declaring consented shared scope.
const sharedHost = () => ({ authScope: 'shared', imageAccess: async () => ({ ready: false }),
  generateImage: async () => assert.fail('the signed-out shared host cannot draw') })

test('an isolated signed-out Bot never draws with an older ChatGPT grant', async t => {
  const store = storeOf({ [CODEX_RECORD]: { kind: 'grant', payload: {
    access: tokenFor('old-account'), accountId: 'old-account',
  } } })
  let calls = 0
  const images = createImageGen({ credentials: () => store,
    codex: () => ({ authScope: 'isolated', imageAccess: async () => ({ ready: false }),
      generateImage() { calls++ } }),
    folder: () => folderOf(t), fetch: async () => { calls++; throw new Error('unexpected') },
  })
  assert.equal(await images.access(), null)
  await assert.rejects(images.generate({ prompt: 'a fox' }))
  assert.equal(calls, 0)
})

test('image generation carries the selected Bot account ticket, including generation zero',
  async t => {
    const calls = []
    const codex = { authScope: 'isolated',
      imageAccess: async () => ({ ready: true, accountGeneration: 0 }),
      generateImage: async request => { calls.push(request); return { base64: PNG } },
    }
    const images = createImageGen({ credentials: () => storeOf({}), codex: () => codex,
      folder: () => folderOf(t) })
    await images.generate({ prompt: 'a fox' })
    assert.equal(calls[0].accountGeneration, 0)
  })

test('missing or unreadable ACP cannot authorize legacy image billing on reload', async t => {
  const dir = folderOf(t)
  const grant = { [CODEX_RECORD]: { kind: 'grant', payload: {
    access: tokenFor('old-account'), refresh: 'invented-refresh', expires: 1,
  } } }
  for (const codex of [() => undefined, () => ({}), () => { throw new Error('unavailable') },
    () => ({ authScope: 'isolated', generateImage() {} }),
    () => ({ imageAccess: async () => { throw new Error('unreadable') }, generateImage() {} }),
    () => ({ authScope: 'shared',
      imageAccess: async () => { throw new Error('unreadable') }, generateImage() {} })]) {
    const store = storeOf(grant)
    const read = store.readRecord
    store.readRecord = async key => {
      assert.notEqual(key, CODEX_RECORD, 'no legacy credential is even read')
      return read(key)
    }
    const images = createImageGen({ credentials: () => store, codex, folder: () => dir,
      fetch: async () => assert.fail('no legacy refresh or image request') })
    assert.equal(await images.access(), null)
    await assert.rejects(images.generate({ prompt: 'a fox' }))
  }
})

test('server-sent events are read whole across chunks', async () => {
  const text = 'event: a\ndata: {"x":1}\n\nevent: b\r\ndata: plain\r\n\r\n'
  const chunks = [text.slice(0, 7), text.slice(7, 20), text.slice(20)].map(part => new TextEncoder().encode(part))
  const seen = []
  for await (const item of sseEvents(chunks)) seen.push(item)
  assert.deepEqual(seen, [{ event: 'a', data: { x: 1 } }, { event: 'b', data: 'plain' }])
})

test('with an OpenAI key, the image streams its partials to the card, then is kept by its id', async (t) => {
  const dir = folderOf(t)
  const asked = []
  const fetch = async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization })
    return sse([
      ['image_generation.partial_image', { type: 'image_generation.partial_image', b64_json: PARTIAL, partial_image_index: 0 }],
      ['image_generation.partial_image', { type: 'image_generation.partial_image', b64_json: PARTIAL, partial_image_index: 1 }],
      ['image_generation.completed', { type: 'image_generation.completed', b64_json: PNG, size: '1024x1024' }],
    ])
  }
  const images = createImageGen({ credentials: () => storeOf({ [OPENAI_RECORD]: { kind: 'api-key', key: 'sk-test' } }), folder: () => dir, fetch })
  assert.deepEqual(await images.access(), { kind: 'openai', model: 'gpt-image-1' })
  const made = await images.generate({ prompt: 'A clay fox', size: '1024x1024', callId: 'call-1' })
  assert.equal(asked[0].url, OPENAI_IMAGES)
  assert.equal(asked[0].auth, 'Bearer sk-test')
  assert.deepEqual(asked[0].body, { model: 'gpt-image-1', prompt: 'A clay fox', size: '1024x1024', quality: 'auto', n: 1, stream: true, partial_images: 2 })
  assert.match(made.file, /images[\\/]img-[a-z0-9-]+\.png$/)
  assert.deepEqual(readFileSync(made.file), Buffer.from(PNG, 'base64'))
  // The card asks for what it has not seen: both partials first, then none.
  const first = images.progress('call-1', 0)
  assert.equal(first.phase, 'done')
  assert.equal(first.id, made.id)
  assert.deepEqual(first.partials.map(partial => partial.index), [0, 1])
  assert.deepEqual(images.progress('call-1', 2).partials, [])
  assert.deepEqual(await images.imageFile(made.id), Buffer.from(PNG, 'base64'))
  assert.equal(await images.imageFile('../state'), undefined)
  // Nothing it answers carries the key.
  assert.doesNotMatch(JSON.stringify([await images.access(), first]), /sk-test/)
})

test('a ChatGPT sign-in that ran out is renewed in its own record, then draws on the Codex backend', async (t) => {
  const dir = folderOf(t)
  const fresh = tokenFor('acct-2')
  const store = storeOf({ [CODEX_RECORD]: { kind: 'grant', payload: { type: 'oauth', access: tokenFor('acct-1'), refresh: 'r-old', expires: 1_000, accountId: 'acct-1' } } })
  const asked = []
  const fetch = async (url, init) => {
    asked.push({ url: String(url), init })
    if (String(url) === 'https://auth.openai.com/oauth/token') return Response.json({ access_token: fresh, refresh_token: 'r-new', expires_in: 3600 })
    // This backend answers in one piece, without partials.
    return Response.json({ data: [{ b64_json: PNG }] })
  }
  const images = createImageGen({ credentials: () => store, codex: sharedHost,
    folder: () => dir, fetch, now: () => 5_000_000 })
  const made = await images.generate({ prompt: 'A lamp', callId: 'call-2' })
  const refresh = new URLSearchParams(asked[0].init.body)
  assert.equal(refresh.get('grant_type'), 'refresh_token')
  assert.equal(refresh.get('refresh_token'), 'r-old')
  assert.deepEqual(store.records[CODEX_RECORD].payload, { type: 'oauth', access: fresh, refresh: 'r-new', expires: 5_000_000 + 3_600_000, accountId: 'acct-2' })
  assert.equal(asked[1].url, CODEX_IMAGES)
  assert.equal(asked[1].init.headers['chatgpt-account-id'], 'acct-2')
  assert.equal(JSON.parse(asked[1].init.body).model, 'gpt-image-2')
  assert.equal(made.via, 'chatgpt')
  assert.equal(images.progress('call-2').partials.length, 0)
})

test('a backend that will not stream is asked again whole, and not asked to stream again', async (t) => {
  const dir = folderOf(t)
  const bodies = []
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.stream) return Response.json({ error: { message: 'Unknown parameter: stream' } }, { status: 400 })
    return Response.json({ data: [{ b64_json: PNG }] })
  }
  const store = storeOf({ [CODEX_RECORD]: { kind: 'grant', payload: { access: tokenFor('acct'), refresh: 'r', expires: 9e15 } } })
  const images = createImageGen({ credentials: () => store, codex: sharedHost,
    folder: () => dir, fetch })
  await images.generate({ prompt: 'One', callId: 'a' })
  await images.generate({ prompt: 'Two', callId: 'b' })
  assert.deepEqual(bodies.map(body => body.stream === true), [true, false, false])
})

test('with nothing connected, or a refusal, the tool says why and the card shows it failed', async (t) => {
  const dir = folderOf(t)
  const none = createImageGen({ credentials: () => storeOf({}), folder: () => dir, fetch: async () => { throw new Error('no call') } })
  assert.equal(await none.access(), null)
  await assert.rejects(none.generate({ prompt: 'x', callId: 'c' }), /No image service is connected/)
  const refusing = createImageGen({ credentials: () => storeOf({ [OPENAI_RECORD]: { kind: 'api-key', key: 'k' } }), folder: () => dir, fetch: async () => Response.json({ error: { message: 'Your request was rejected by the safety system.' } }, { status: 400 }) })
  await assert.rejects(refusing.generate({ prompt: 'x', callId: 'd' }), /rejected by the safety system/)
  assert.equal(refusing.progress('d').phase, 'failed')
  await assert.rejects(refusing.generate({ prompt: '   ', callId: 'e' }), /Say what to draw/)
})

// acp-dsh's acpAgents, as far as images use it: Codex's readiness and one drawing.
const codexOf = ({ ready = true, unsupported, reason = unsupported ? 'unsupported' : undefined, made = { base64: PNG, mimeType: 'image/png' }, fail } = {}) => {
  const calls = []
  return {
    calls,
    authScope: 'shared',
    imageAccess: async () => ({ ready, ...(reason ? { signedIn: true, reason } : {}), ...(unsupported ? { unsupported: true } : {}) }),
    generateImage: async (request) => {
      calls.push(request)
      if (fail) throw Object.assign(new Error(fail), { code: 'acp/image-usage-limit' })
      return made
    },
  }
}

test('with no OpenAI key, a signed-in Codex draws: in one piece, kept by its id, nothing stored read', async (t) => {
  const dir = folderOf(t)
  const codex = codexOf()
  const grant = { [CODEX_RECORD]: { kind: 'grant', payload: { access: tokenFor('acct'), refresh: 'r', expires: 9e15 } } }
  const images = createImageGen({ credentials: () => storeOf(grant), codex: () => codex, folder: () => dir, fetch: async () => { throw new Error('no request leaves for Codex') } })
  assert.deepEqual(await images.access(), { kind: 'codex' })
  const made = await images.generate({ prompt: 'A fox', size: '1536x1024', quality: 'high', background: 'transparent', callId: 'k' })
  assert.equal(made.via, 'codex')
  assert.deepEqual(codex.calls.map(({ signal, ...rest }) => rest), [{ prompt: 'A fox', size: '1536x1024', quality: 'high', background: 'transparent' }])
  assert.equal(readFileSync(made.file).toString('base64'), PNG)
  const progress = images.progress('k')
  assert.equal(progress.phase, 'done')
  assert.equal(progress.via, 'codex')
  assert.equal(progress.count, 0, 'no partial images through Codex')
})

test('an OpenAI key still comes first, unchanged; a signed-out Codex falls to the earlier grant last', async (t) => {
  const dir = folderOf(t)
  const codex = codexOf()
  const keyed = createImageGen({ credentials: () => storeOf({ [OPENAI_RECORD]: { kind: 'api-key', key: 'sk-test' } }), codex: () => codex, folder: () => dir })
  assert.deepEqual(await keyed.access(), { kind: 'openai', model: 'gpt-image-1' })
  const grant = { [CODEX_RECORD]: { kind: 'grant', payload: { access: tokenFor('acct'), refresh: 'r', expires: 9e15 } } }
  const fallback = createImageGen({ credentials: () => storeOf(grant), codex: () => codexOf({ ready: false }), folder: () => dir })
  assert.deepEqual(await fallback.access(), { kind: 'chatgpt', model: 'gpt-image-2' })
  const nothing = createImageGen({ credentials: () => storeOf({}), codex: () => codexOf({ ready: false }), folder: () => dir })
  assert.equal(await nothing.access(), null)
  await assert.rejects(nothing.generate({ prompt: 'x', callId: 'n' }), /sign in to Codex/)
  assert.deepEqual(codex.calls, [])
})

test('a signed-in Codex that is not supported for drawing gives way to the earlier grant, and says so when nothing else draws', async (t) => {
  const dir = folderOf(t)
  const codex = codexOf({ ready: false, unsupported: true })
  const grant = { [CODEX_RECORD]: { kind: 'grant', payload: { access: tokenFor('acct'), refresh: 'r', expires: 9e15 } } }
  assert.deepEqual(await createImageGen({ credentials: () => storeOf(grant), codex: () => codex, folder: () => dir }).access(), { kind: 'chatgpt', model: 'gpt-image-2' })
  const alone = createImageGen({ credentials: () => storeOf({}), codex: () => codex, folder: () => dir })
  assert.equal(await alone.access(), null)
  await assert.rejects(alone.generate({ prompt: 'x', callId: 'u' }), /not supported for drawing yet.*update Automagik.*OpenAI key/)
  assert.deepEqual(codex.calls, [], 'Codex is never started')
  // A Codex whose check did not hold for another reason gives way too, and says which.
  for (const [reason, said] of [['config', /could not load its own configuration.*OpenAI key/], ['unreadable', /could not be checked for safe drawing.*OpenAI key/]]) {
    const other = codexOf({ ready: false, reason })
    assert.deepEqual(await createImageGen({ credentials: () => storeOf(grant), codex: () => other, folder: () => dir }).access(), { kind: 'chatgpt', model: 'gpt-image-2' })
    await assert.rejects(createImageGen({ credentials: () => storeOf({}), codex: () => other, folder: () => dir }).generate({ prompt: 'x', callId: reason }), said)
    assert.deepEqual(other.calls, [])
  }
})

test('a Codex refusal is the tool\'s answer and the card shows it failed', async (t) => {
  const dir = folderOf(t)
  const images = createImageGen({ credentials: () => storeOf({}), codex: () => codexOf({ fail: 'Codex has reached its usage limit on this ChatGPT plan.' }), folder: () => dir })
  await assert.rejects(images.generate({ prompt: 'A fox', callId: 'f' }), (error) => {
    assert.equal(error.code, 'bot/unavailable')
    assert.match(error.message, /usage limit/)
    return true
  })
  assert.equal(images.progress('f').phase, 'failed')
  assert.match(images.progress('f').error, /usage limit/)
})

// The card's own helpers, bundled with a stand-in React.
const bundle = await build({
  stdin: { contents: "export { imageIdOf, ratioOf, PAINT_FACES } from './src/client/image-cell.js'; export { FACES } from './src/client/clay-art.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react', 'react-dom'],
})
const cell = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module: cell, exports: cell.exports, require: () => ({ createElement: () => null, useEffect: () => {}, useRef: () => ({}), useState: v => [v, () => {}] }) })

test('the card finds the image the tool kept, frames it in the asked shape, and paints with Omni\'s own faces', () => {
  const { imageIdOf, ratioOf, PAINT_FACES, FACES } = cell.exports
  assert.equal(imageIdOf('Drew the image with the user\'s OpenAI key and saved it as /w/images/img-1234abcd-ef.png. It is on screen'), 'img-1234abcd-ef')
  assert.equal(imageIdOf('C:\\w\\images\\img-1234abcd-ef.png'), 'img-1234abcd-ef')
  assert.equal(imageIdOf('No image service is connected.'), undefined)
  assert.equal(ratioOf('1536x1024'), '3 / 2')
  assert.equal(ratioOf('auto'), '1 / 1')
  // The owner's "Omni paints" cycle: focused, pleased, focused, delighted, focused, curious.
  assert.deepEqual([...PAINT_FACES].map(face => FACES.indexOf(face)), [3, 1, 3, 2, 3, 4])
})

// An image an agent makes with its own tool reaches the team workspace through acp-dsh's keeper
// call, and the card's progress follows it like a generate_image call.
test('an agent\'s image is kept by id in the images folder, and its card follows it', async (t) => {
  const dir = folderOf(t)
  const images = createImageGen({ credentials: () => storeOf({}), folder: () => dir })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  images.agentImages.start({ callId: 'acp_1', sessionId: 's1', via: 'Codex' })
  assert.equal(images.progress('acp_1').phase, 'generating')
  const kept = await images.agentImages.keep({ callId: 'acp_1', sessionId: 's1', base64: png, mimeType: 'image/png', via: 'Codex' })
  assert.match(kept.id, /^img-/)
  assert.equal(kept.file, join(dir, 'images', `${kept.id}.png`))
  assert.deepEqual(readFileSync(kept.file), Buffer.from(png, 'base64'))
  assert.equal(images.progress('acp_1').phase, 'done')
  assert.equal(images.progress('acp_1').id, kept.id)
  assert.deepEqual(await images.imageFile(kept.id), Buffer.from(png, 'base64'))
  images.agentImages.fail({ callId: 'acp_2', error: 'The image was stopped before it was finished.' })
  assert.equal(images.progress('acp_2').phase, 'failed')
  await assert.rejects(images.agentImages.keep({ callId: 'acp_3', base64: '' }), /without an image/)
  assert.equal(images.progress('acp_3').phase, 'failed')
})

test('the plugin hands acp-dsh its image keeper once the agents service is there', () => {
  const registered = []
  let cleanup
  const ctx = {
    inject: (names, attach) => {
      assert.deepEqual(names, ['acpAgents'])
      attach({ acpAgents: { keepImages: (keeper) => { registered.push(keeper); return () => registered.pop() } }, effect: (execute) => { cleanup = execute() } })
    },
    tools: { register: () => () => {} },
  }
  const rt = { ctx, teamFolder: () => undefined, teamTools: [] }
  install(rt)
  assert.equal(registered.length, 1)
  assert.equal(registered[0], rt.images.agentImages)
  cleanup()
  assert.equal(registered.length, 0)
})
