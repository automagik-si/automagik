import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fill, MACHINE_MESSAGES } from '../src/shared/machine-reservations.js'

test('two distinct group members respect sticky reservations and the Bot check', t => {
  if (!process.env.RESERVATION_TWO_USERS) {
    if (process.env.CI) assert.fail('missing RESERVATION_TWO_USERS from plugin CI setup')
    return t.skip('requires the two-user fixture in docs/cloud/0024-reservations-setup.md')
  }
  const { root, dir, a, b } = JSON.parse(process.env.RESERVATION_TWO_USERS)
  const run = (user, cmd, args) => {
    const result = spawnSync('sudo', ['-n', '-u', user, '--', cmd, ...args], {
      cwd: join(root, 'run'), encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || String(result.error ?? ''))
    return result.stdout
  }
  const op = (user, operation, input) => JSON.parse(run(user, join(root, 'bin/node'), [
    join(root, 'plugin/reservation-driver.mjs'), operation,
    JSON.stringify({ dir, instance: user, ...input }),
  ]))
  const label = 'Two-user project'
  const made = op(a, 'reserve', { label })
  assert.equal(made.created, true)
  const path = join(dir, made.name)
  t.after(() => op(a, 'make-shared'))
  // Mode, owner, group, uid and modification time: GNU stat on Linux, BSD stat on macOS.
  const statArgs = process.platform === 'darwin'
    ? ['-f', '%Lp %Su %Sg %u %m']
    : ['-c', '%a %U %G %u %y']
  const snapshot = user => [
    run(user, 'cat', [path]), run(user, 'stat', [...statArgs, path]),
  ]
  const before = snapshot(a)
  assert.match(before[1], new RegExp(`^640 ${a} automagik-ci `))
  assert.deepEqual(snapshot(b), before)
  assert.deepEqual(op(b, 'read'), {
    state: 'ok', label, owner: a, uid: Number(before[1].split(' ')[3]),
  })
  assert.equal(op(b, 'reserve', { label: 'B project', other: true }).created, true)
  assert.deepEqual(op(b, 'make-shared', { other: true }), { ok: true })
  for (const [operation, code] of [
    ['unlink', 'EPERM'], ['rename-over', 'EPERM'],
    ['link-over', 'EEXIST'], ['open-write', 'EACCES'],
  ]) assert.deepEqual(op(b, operation), { code })
  assert.deepEqual(op(b, 'make-shared', { instance: a }), { refused: 'not-own-file' })
  assert.deepEqual(op(b, 'reserve', { label: 'B project' }).conflict, { label, owner: a })
  assert.deepEqual(snapshot(a), before)
  const checked = op(b, 'check')
  assert.equal(checked.held, fill(MACHINE_MESSAGES.refused, { label }))
  assert.deepEqual(checked.signOuts, [{ provider: 'acp-claude', expect: true }])
  assert.deepEqual(checked.status, { state: 'refused', label, owner: a, signedOut: true })
  assert.deepEqual(op(a, 'make-shared'), { ok: true })
  assert.deepEqual(op(a, 'read'), { state: 'absent' })
})
