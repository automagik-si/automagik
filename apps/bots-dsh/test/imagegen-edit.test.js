import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CODEX_RECORD, OPENAI_RECORD, createImageGen, install } from '../src/host/imagegen.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const input = { data: PNG, mediaType: 'image/png' }
const credentials = records => ({ readRecord: async key => records[key], resolve: async () => undefined })
const key = () => credentials({ [OPENAI_RECORD]: { kind: 'api-key', key: 'test-key' } })
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-edit-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return () => dir
}
const response = () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] })

test('OpenAI edits post multipart exact bytes and stream partials into a newly kept image', async t => {
  const calls = []
  const images = createImageGen({ credentials: key, folder: folder(t), fetch: async (url, init) => {
    calls.push({ url, init })
    return new Response([
      `event: image_edit.partial_image\ndata: ${JSON.stringify({ b64_json: PNG.toString('base64'), partial_image_index: 0 })}\n\n`,
      `event: image_edit.completed\ndata: ${JSON.stringify({ b64_json: PNG.toString('base64') })}\n\n`,
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const made = await images.generate({ prompt: 'Make the background blue', input, size: '1536x1024', quality: 'high', background: 'opaque', callId: 'edit' })
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://api.openai.com/v1/images/edits')
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { authorization: 'Bearer test-key', accept: 'text/event-stream, application/json' })
  assert.ok(init.body instanceof FormData)
  assert.deepEqual(Object.fromEntries([...init.body].filter(([key]) => key !== 'image[]')), {
    model: 'gpt-image-2.5-sunburst', prompt: 'Make the background blue', size: '1536x1024',
    quality: 'high', background: 'opaque', n: '1', stream: 'true', partial_images: '2',
  })
  const image = init.body.get('image[]')
  assert.equal(image.name, 'input.png')
  assert.equal(image.type, 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG)
  assert.match(made.file, /images[/\\]img-.*\.png$/)
  assert.deepEqual(readFileSync(made.file), PNG)
  assert.equal(images.progress('edit').partials.length, 1)
  assert.equal(images.progress('edit').phase, 'done')
  assert.deepEqual(input.data, PNG)
})

test('edit options normalize and jpeg/webp filenames match; draws retain the existing JSON body', async t => {
  const calls = []
  const images = createImageGen({ credentials: key, folder: folder(t), fetch: async (url, init) => { calls.push({ url, init }); return response() } })
  for (const [mediaType, ext] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
    await images.generate({ prompt: 'edit', input: { ...input, mediaType }, size: 'bad', quality: 'bad' })
    const body = calls.at(-1).init.body
    assert.equal(body.get('image[]').name, `input.${ext}`)
    assert.equal(body.get('image[]').type, mediaType)
    assert.equal(body.get('size'), 'auto')
    assert.equal(body.get('quality'), 'auto')
    assert.equal(body.has('background'), false)
  }
  await images.generate({ prompt: 'draw' })
  assert.equal(calls.at(-1).url, 'https://api.openai.com/v1/images/generations')
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { model: 'gpt-image-1', prompt: 'draw', size: 'auto', quality: 'auto', n: 1, stream: true, partial_images: 2 })
})

test('Codex edits carry exact input and generation zero, with no generateImage call', async t => {
  const calls = []
  const codex = { imageAccess: async () => ({ ready: true, accountGeneration: 0 }),
    generateImage: () => assert.fail('no draw'), editImage: async fields => { calls.push(fields); return { base64: PNG.toString('base64') } } }
  const images = createImageGen({ credentials: () => credentials({}), codex: () => codex, folder: folder(t) })
  await images.generate({ prompt: 'edit', size: 'bad', quality: 'bad', background: 'bad', input })
  assert.deepEqual(calls, [{ prompt: 'edit', size: 'auto', quality: 'auto', background: 'auto', signal: undefined,
    accountGeneration: 0, image: { base64: PNG.toString('base64'), mimeType: 'image/png' } }])
  delete codex.editImage
  await assert.rejects(images.generate({ prompt: 'edit', input, callId: 'old' }), /needs a newer Automagik.*update/)
  assert.equal(images.progress('old').phase, 'failed')
  assert.equal(calls.length, 1)
})

test('legacy grants refuse edits without even refreshing an expired grant', async t => {
  const images = createImageGen({ folder: folder(t), credentials: () => credentials({
    [CODEX_RECORD]: { kind: 'grant', payload: { access: 'test', refresh: 'test', expires: 1 } },
  }), codex: () => ({ authScope: 'shared', imageAccess: async () => ({ ready: false }), generateImage: () => assert.fail('no draw') }),
  fetch: () => assert.fail('no request') })
  await assert.rejects(images.generate({ prompt: 'edit', input, callId: 'legacy' }), /Editing a picture needs Codex signed in/)
  assert.equal(images.progress('legacy').phase, 'failed')
})

test('the tool exposes editing, resolves before service calls, and returns edited success text', async t => {
  let calls = 0
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'picture.png', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
  const codex = { imageAccess: async () => { calls++; return { ready: true } },
    generateImage: () => assert.fail('no draw'), editImage: async () => ({ base64: PNG.toString('base64') }) }
  const rt = { teamTools: [], teamFolder: folder(t), botOfSession: () => ({ id: 'test-bot' }), roomOf: () => undefined,
    partsOf: () => [{ sessionId: 'chat' }],
    async *eventsBackwards() { yield { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] } } },
    ctx: { inject() {}, get: name => ({ credentials: credentials({}),
      acpAgents: codex, attachments: { readImage: async ref => ({ ref, data: PNG }) } })[name] },
  }
  install(rt)
  const [tool] = rt.teamTools
  assert.equal(tool.parameters.properties.image.type, 'string')
  assert.match(tool.description, /edits a picture.*do not send them to another Bot/)
  const exec = { agent: { id: 'chat' }, callId: 'tool' }
  assert.match(await tool.execute({ prompt: 'edit', image: 'missing.png' }, exec), /No picture the user attached in this chat matches that/)
  assert.equal(calls, 0)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await tool.execute({ prompt: 'edit', image: 'picture.png' }, { ...exec, signal: controller.signal }),
    'The image was stopped before it was finished.')
  assert.equal(calls, 0, 'cancelled attachment resolution never reaches the service')
  const text = await tool.execute({ prompt: 'edit', image: 'picture.png' }, exec)
  assert.match(text, /^Edited the image with Codex.*img-.*original picture is unchanged\.$/)
  assert.equal(calls, 1)
})

test('each edit keeps a distinct output without modifying the uploaded bytes', async t => {
  const original = Buffer.from(PNG)
  const uploaded = Buffer.from(PNG)
  const output = Buffer.concat([PNG, Buffer.from('edited')])
  const team = folder(t)
  const images = createImageGen({ credentials: key, folder: team, fetch: async () =>
    Response.json({ data: [{ b64_json: output.toString('base64') }] }) })
  const fields = { prompt: 'edit', input: { data: uploaded, mediaType: 'image/png' } }
  const first = await images.generate(fields)
  const second = await images.generate(fields)
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.file, second.file)
  assert.deepEqual(readFileSync(first.file), output)
  assert.deepEqual(readFileSync(second.file), output)
  assert.deepEqual(uploaded, original)
  assert.equal(readdirSync(join(team(), 'images')).length, 2)
})

test('OpenAI edit cancellation passes the signal, fails the card and keeps no output', async t => {
  const controller = new AbortController()
  const team = folder(t)
  const warnings = []
  let calls = 0
  const images = createImageGen({ credentials: key, folder: team, warn: line => warnings.push(line),
    fetch: async (url, fields) => {
      calls++
      assert.equal(url, 'https://api.openai.com/v1/images/edits')
      assert.equal(fields.signal, controller.signal)
      return new Promise((resolve, reject) => {
        fields.signal.addEventListener('abort', () => reject(fields.signal.reason), { once: true })
        controller.abort()
      })
    } })
  await assert.rejects(images.generate({ prompt: 'edit', input, signal: controller.signal, callId: 'cancel-api' }),
    error => error === controller.signal.reason)
  assert.equal(calls, 1)
  assert.equal(images.progress('cancel-api').phase, 'failed')
  assert.match(images.progress('cancel-api').error, /abort/i)
  assert.equal(warnings.length, 1)
  assert.deepEqual(readdirSync(team()), [])
})

test('Codex edits preserve nonzero account binding and cancellation, and map service refusals', async t => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController()
    const failure = Object.assign(new Error('The Bot account changed. Start the image again.'), { code: 'acp/image-signed-out' })
    const calls = []
    const team = folder(t)
    const codex = { imageAccess: async () => ({ ready: true, accountGeneration: 7 }),
      generateImage: () => assert.fail('an edit cannot become a draw'),
      editImage: async fields => {
        calls.push(fields)
        if (cancelled) controller.abort(failure)
        throw failure
      } }
    const images = createImageGen({ credentials: () => credentials({}), codex: () => codex, folder: team })
    await assert.rejects(images.generate({ prompt: ' edit ', input, size: '1024x1536', quality: 'low',
      background: 'transparent', signal: controller.signal, callId: 'bound-edit' }), error => {
      assert.equal(error.message, failure.message)
      assert.equal(error.code, cancelled ? failure.code : 'bot/unavailable')
      if (cancelled) assert.equal(error, failure)
      return true
    })
    assert.deepEqual(calls, [{ prompt: 'edit', size: '1024x1536', quality: 'low', background: 'transparent',
      signal: controller.signal, accountGeneration: 7, image: { base64: PNG.toString('base64'), mimeType: 'image/png' } }])
    assert.equal(images.progress('bound-edit').phase, 'failed')
    assert.deepEqual(readdirSync(team()), [])
  }
})

test('OpenAI edit errors use the existing refusal mapping and never retry as a draw', async t => {
  const team = folder(t)
  let calls = 0
  const images = createImageGen({ credentials: key, folder: team, fetch: async url => {
    calls++
    assert.equal(url, 'https://api.openai.com/v1/images/edits')
    return Response.json({ error: { message: 'stream is unavailable' } }, { status: 400 })
  } })
  await assert.rejects(images.generate({ prompt: 'edit', input, callId: 'failed-api' }), error => {
    assert.equal(error.code, 'bot/unavailable')
    assert.match(error.message, /stream is unavailable/)
    return true
  })
  assert.equal(calls, 1)
  assert.equal(images.progress('failed-api').phase, 'failed')
  assert.deepEqual(readdirSync(team()), [])
})
