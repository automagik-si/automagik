// Run from bots-dsh with node --import ./test/harness-resolve.mjs dev/pocket-upload-measure.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rowIdOf } from '../src/host/pocket-chat.js'
import { deferred, fixturePng, memoryWire, realAdmission, uploadWire, watchWire } from '../test/support/pocket-upload-admission.js'

const MiB = 1024 * 1024
const home = mkdtempSync(join(tmpdir(), 'pocket-rss-'))
const clean = []
try {
  const png = fixturePng(6400, 6250, 127, 8 * MiB)
  assert.ok(png.length <= 8 * MiB)
  const h = await realAdmission(home)
  const session = h.agents.get('a').session
  const rows = []
  for (const shade of [40, 220]) {
    const [ref] = await h.store.saveImages([{ data: fixturePng(1270, 950, shade), mediaType: 'image/png' }])
    const event = h.append(session, 'user/message', {
      id: `seed-${shade}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }],
    }, { surfaceOp: 'append' })
    rows.push(rowIdOf(session.id, event.seq))
  }
  const source = h.source()
  const client = memoryWire(source, h.registry())
  clean.push(() => { client.stop(); source.close() })
  await watchWire(client)
  const storing = deferred()
  const save = h.store.saveImages.bind(h.store)
  let storageActive = false
  h.store.saveImages = async (...args) => {
    storageActive = true
    storing.resolve()
    try { return await save(...args) } finally { storageActive = false }
  }
  const read = h.store.readImageRequest.bind(h.store)
  let activeReads = 0
  let peakReads = 0
  let readsDuringStorage = 0
  h.store.readImageRequest = async (...args) => {
    if (storageActive) readsDuringStorage++
    peakReads = Math.max(peakReads, ++activeReads)
    try { return await read(...args) } finally { activeReads-- }
  }
  global.gc?.()
  const beforeRss = process.memoryUsage.rss()
  const beforePeak = process.resourceUsage().maxRSS * 1024
  assert.equal((await uploadWire(client, png, { finish: false })).ok, true)
  const finish = client.request('upload-finish', { channel: 1, phone: 'phone-a', upload: 'upload' })
  await Promise.race([storing.promise, finish.then(result => assert.equal(result.state, 'admitted'))])
  const [admitted, ...thumbs] = await Promise.all([finish, ...rows.map(row =>
    client.request('attachment-read', { phone: 'phone-a', channel: 1, row, block: 0 }))])
  assert.equal(admitted.state, 'admitted')
  assert.ok(thumbs.every(thumb => thumb.ok))
  const peak = process.resourceUsage().maxRSS * 1024
  const rssDelta = Math.max(0, peak - beforeRss)
  console.log(JSON.stringify({
    width: 6400, height: 6250, encodedBytes: png.length, concurrentThumbnailReads: peakReads, readsDuringStorage,
    baselineRssMiB: beforeRss / MiB, baselinePeakRssMiB: beforePeak / MiB, peakRssMiB: peak / MiB,
    peakRssDeltaMiB: rssDelta / MiB, maxDeltaMiB: 512,
  }))
  assert.equal(peakReads, 2)
  assert.equal(readsDuringStorage, 2)
  assert.ok(rssDelta <= 512 * MiB, 'Pocket upload RSS delta exceeded 512 MiB')
} finally {
  for (const cleanup of clean.reverse()) cleanup()
  rmSync(home, { recursive: true, force: true })
}
