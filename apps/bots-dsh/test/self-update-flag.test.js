import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mock1540On } from '../src/client/self-update-flag.js'

test('the preview flag matches a whole fragment parameter', () => {
  for (const hash of ['#mock-1540', '#mock-1540&notes', '#mock-1540=1', '#notes&mock-1540', '#notes&mock-1540=1&more']) {
    assert.equal(mock1540On({ hash }), true, hash)
  }
  for (const hash of ['#notes-mock-1540-old', '#mock-1540-old', '#notes=mock-1540', '#notes&mock-1540-old']) {
    assert.equal(mock1540On({ hash }), false, hash)
  }
})
