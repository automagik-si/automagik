import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserName } from '../src/host/user-name.js'

const passwd = 'root:x:0:0::/root:/bin/sh\nalice:x:1001:1001::/home/alice:/bin/sh\n'

test('a reservation owner is named from /etc/passwd, then id -nu, else by uid', () => {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    if (args[1] === '5101') return 'amres-a\n'
    throw new Error('no such user')
  }
  const userName = createUserName({ run, read: () => passwd, self: () => -1 })
  assert.equal(userName(1001), 'alice')
  assert.equal(userName(5101), 'amres-a') // a directory-service user, as on macOS
  assert.equal(userName(7777), 'uid 7777')
  assert.deepEqual(calls, [['id', '-nu', '5101'], ['id', '-nu', '7777']])
  assert.equal(userName(5101), 'amres-a')
  assert.equal(calls.length, 2, 'answers are cached')
})

test('an unreadable passwd still asks id; odd output reads as the uid', () => {
  const userName = createUserName({
    run: () => 'evil\u001b[31mname\n', read: () => { throw new Error('EACCES') }, self: () => -1,
  })
  assert.equal(userName(42), 'uid 42')
  const plain = createUserName({ run: () => 'bob\n', read: () => { throw new Error('EACCES') }, self: () => -1 })
  assert.equal(plain(43), 'bob')
})
