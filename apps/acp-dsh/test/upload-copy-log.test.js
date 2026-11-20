import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileHandleText } from '@deepseek-ai/dsh-llm'
import { prepareUpload } from '../src/host/upload-content.js'

const data = Buffer.from('file contents')
const ref = Object.freeze({
  attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  bytes: data.length, name: 'SENTINEL-private-report.txt', mediaType: 'text/plain',
})

const failures = [
  ['an error with destination details', path => Object.assign(new Error(`Cannot copy to ${path}`), {
    code: 'ESENTINEL', path, dest: path,
  })],
  ['an error without a code', () => new Error('x')],
]

for (const [description, makeError] of failures) {
  test(`upload copy failure logs a fixed warning for ${description}`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'acp-upload-copy-log-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const path = join(cwd, '.automagik', 'uploads', ref.attachmentId.slice(7), ref.name)
    const readFileStream = t.mock.fn(() => { throw makeError(path) })
    const warnings = []
    const prompt = await prepareUpload({
      blocks: [{ type: 'file', attachment: ref }],
      run: { sessionId: 'upload-copy-log-test' },
      attachments: { readFileStream },
      cwd,
      warn: (...args) => { warnings.push(args) },
      valid: () => {},
    })

    assert.equal(readFileStream.mock.callCount(), 1)
    assert.deepEqual(warnings, [['Upload copy unavailable']])
    const logged = warnings.flat().join('\n')
    assert.ok(!logged.includes('SENTINEL'))
    assert.ok(!logged.includes(cwd))
    assert.deepEqual(prompt, [{ type: 'text', text: fileHandleText(ref, undefined) }])
  })
}
