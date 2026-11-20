import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { botPrincipalOf, NOBODY, OWNER, principalOf, readPrincipalRecord, readRecord } from '../src/host/member-wall/principals.js'
import { botMay, botMaySearch, checkBotConfig, mayUse } from '../src/host/member-wall/paths.js'

const A = 'b-aaaaaaaaaa'
const B = 'b-bbbbbbbbbb'
const instance = 'probe'
const bot = id => ({ kind: 'bot', id })
const member = name => ({ kind: 'member', name })

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'member-wall-bot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('the legacy reader accepts exactly its v1 record, and v2 requires an instance and object map', t => {
  const file = join(scratch(t), 'principals.json')
  const write = (value, mode = 0o600) => {
    writeFileSync(file, JSON.stringify(value), { mode })
    chmodSync(file, mode)
  }
  const sessions = { s: 'owner' }
  assert.equal(readPrincipalRecord(file, { instance }), undefined)
  write({ version: 1, sessions })
  assert.deepEqual(readRecord(file), sessions)
  assert.deepEqual(readPrincipalRecord(file, {}), { version: 1, sessions })
  assert.equal(principalOf(file, 's'), OWNER)
  write({ version: 1, sessions: [] })
  assert.deepEqual(readRecord(file), [])
  assert.deepEqual(readPrincipalRecord(file, { instance }), { version: 1, sessions: [] })

  write({ version: 2, instance, sessions })
  assert.equal(readRecord(file), undefined)
  assert.deepEqual(principalOf(file, 's'), member(undefined))
  assert.deepEqual(readPrincipalRecord(file, { instance }), { version: 2, sessions })
  for (const wrong of [undefined, '', 1, 'different']) {
    assert.equal(readPrincipalRecord(file, { instance: wrong }), undefined)
  }
  for (const bad of [null, [], 'owner']) {
    write({ version: 2, instance, sessions: bad })
    assert.equal(readPrincipalRecord(file, { instance }), undefined)
  }
  write({ version: 3, instance, sessions })
  assert.equal(readPrincipalRecord(file, { instance }), undefined)
  write({ version: 2, instance, sessions }, 0o644)
  assert.equal(readPrincipalRecord(file, { instance }), undefined)
  assert.equal(readPrincipalRecord(join(file, '..'), { instance }), undefined)
})

test('the bot principal table combines the resolver and own string record entries', t => {
  const file = join(scratch(t), 'principals.json')
  const warnings = []
  const warn = (session, reason) => warnings.push({ session, reason })
  const cases = [
    [A, 2, `bot:${A}`, bot(A), false],
    ['bad-id', 2, 'bot:bad-id', bot(undefined), false],
    [A, 2, `bot:${B}`, bot(undefined), true],
    [A, 2, 'owner', bot(undefined), true],
    [A, 1, 'owner', bot(undefined), true],
    [A, 1, `bot:${A}`, bot(undefined), true],
    [A, 2, 'member:ana', bot(undefined), true],
    [A, 2, undefined, bot(undefined), false],
    [A, 2, { kind: 'owner' }, bot(undefined), false],
    [null, 2, 'bot:', NOBODY, true],
    [null, 1, `bot:${A}`, member(undefined), false],
    [null, 1, 'owner', OWNER, false],
    [null, 2, 'owner', OWNER, false],
    [null, 2, 'member:ana', member('ana'), false],
    [null, 2, 'member:../ana', member(undefined), false],
    [null, 2, 'unknown', member(undefined), false],
    [null, 2, undefined, member(undefined), false],
    [undefined, 2, 'owner', NOBODY, false],
    [undefined, 2, `bot:${A}`, NOBODY, false],
  ]
  for (const [index, [id, version, entry, expected, warns]] of cases.entries()) {
    const session = `session-${index}`
    writeFileSync(file, JSON.stringify({ version, instance, sessions: { [session]: entry } }), { mode: 0o600 })
    const options = { instance, botOf: () => id, warn }
    assert.deepEqual(botPrincipalOf(file, session, options), expected, session)
    assert.deepEqual(botPrincipalOf(file, session, options), expected, session)
    assert.equal(warnings.filter(item => item.session === session).length, Number(warns), session)
  }
  writeFileSync(file, JSON.stringify({ version: 2, instance, sessions: { s: 'owner' } }))
  assert.equal(botPrincipalOf(file, 's', { instance }), NOBODY)
  assert.equal(botPrincipalOf(file, 's', { instance, botOf: () => { throw new Error('lookup') } }), NOBODY)
  assert.deepEqual(botPrincipalOf(file, 'toString', { instance, botOf: () => null }), member(undefined))
  rmSync(file)
  assert.deepEqual(botPrincipalOf(file, 's', { instance, botOf: () => A }), bot(undefined))
  assert.deepEqual(botPrincipalOf(file, 's', { instance, botOf: () => null }), member(undefined))
})

function layout(t) {
  const root = scratch(t)
  const dsh = join(root, 'dsh')
  const automagik = join(root, 'automagik')
  const team = join(root, 'team')
  const botsRoot = join(root, 'bots')
  const membersRoot = join(root, 'members')
  const own = join(botsRoot, A)
  const other = join(botsRoot, B)
  const grant = join(root, 'grant')
  const denied = join(root, 'denied')
  for (const dir of [dsh, team, own, other, grant, denied, membersRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const env = { DSH_HOME: dsh, AUTOMAGIK_HOME: automagik, AUTOMAGIK_BOTS_HOME: team }
  const config = {
    botsRoot, membersRoot, principalsFile: join(dsh, 'record', 'principals.json'),
    denyReadRoots: [denied], botDenyRoots: [], botReadRoots: { [A]: [grant] },
  }
  const identity = path => {
    const { dev, ino } = statSync(path)
    return `${dev}:${ino}`
  }
  return { root, dsh, automagik, team, botsRoot, membersRoot, own, other, grant, denied, env, config, identity }
}

test('Bot path decisions use folder identity for the destination and every hop', t => {
  const { root, own, other, grant, denied, dsh, config, env, identity } = layout(t)
  const blocked = checkBotConfig(config, env)
  const late = join(grant, 'late')
  const decision = {
    ...config,
    botDenied: () => [...blocked, late],
    botGrants: () => [grant],
    ownBot: id => id === A ? identity(own) : undefined,
  }
  for (const dir of [join(own, 'nested'), late]) mkdirSync(dir)
  symlinkSync(dsh, join(own, 'dsh-link'))
  symlinkSync(other, join(own, 'other-link'))
  symlinkSync(join(own, 'nested'), join(denied, 'back'))
  assert.equal(botMay(decision, bot(A), 'missing/tail.txt', own, { write: true }), true)
  assert.equal(botMay(decision, bot(A), 'nested/../tail.txt', own, { write: true }), true)
  assert.equal(botMay(decision, bot(A), join(grant, 'missing.txt')), true)
  assert.equal(botMay(decision, bot(A), join(grant, 'missing.txt'), '/', { write: true }), false)
  for (const path of [
    other, config.botsRoot, root, denied, late,
    `${own}/dsh-link/launch-token`, `${own}/other-link/../${A}/nested`,
    `${denied}/back/../nested`, `${own}/missing/../tail.txt`, `${own}/missing/./tail.txt`,
  ]) assert.equal(botMay(decision, bot(A), path), false, path)
  assert.equal(botMay(decision, bot(undefined), own), false)
  assert.equal(botMay(decision, bot(B), grant), false)
  assert.equal(botMaySearch(decision, bot(A), own), true)
  assert.equal(botMaySearch(decision, bot(A), grant), false, 'denied descendant')
  assert.equal(botMaySearch({ ...decision, botGrants: () => [root] }, bot(A), root), false, 'botsRoot below a search')
  assert.equal(mayUse(decision, [OWNER, bot(A)], own), true)
  assert.equal(mayUse(decision, [bot(A), OWNER], grant, '/', { write: true }), false)
  assert.equal(mayUse(decision, [OWNER, NOBODY], own), false)
})

test('Bot config rejects overlaps through links and missing tails, and validates the root and grant shape', t => {
  const { root, dsh, automagik, team, botsRoot, membersRoot, other, grant, denied, env, config } = layout(t)
  const link = join(root, 'dsh-link')
  const botsLink = join(root, 'bots-link')
  symlinkSync(dsh, link)
  symlinkSync(botsRoot, botsLink)
  assert.deepEqual(checkBotConfig(config, env), [
    dsh, automagik, team, join(dsh, 'record'), '/data/gate-view', '/data/secrets', denied, membersRoot,
  ])
  for (const path of [root, dsh, link, join(link, 'missing'), join(team, 'missing'), join(automagik, 'missing'), botsRoot,
    other, join(membersRoot, 'ana'), denied, '/data/gate-view', '/data/secrets/absent', 'relative']) {
    assert.throws(() => checkBotConfig({ ...config, botReadRoots: { [A]: [path] } }, env), /member wall: /, path)
  }
  for (const botReadRoots of [null, [], new Map(), { [A]: grant }, { 'wrong-id': [grant] }]) {
    assert.throws(() => checkBotConfig({ ...config, botReadRoots }, env), /member wall: /)
  }
  for (const dir of ['relative', botsLink, `${botsLink}/`, root, dsh, join(root, 'missing')]) {
    assert.throws(() => checkBotConfig({ ...config, botsRoot: dir }, env), /member wall: /, dir)
  }
  for (const mode of [0o720, 0o702]) {
    chmodSync(botsRoot, mode)
    assert.throws(() => checkBotConfig(config, env), /botsRoot must not be group- or world-writable/)
  }
  chmodSync(botsRoot, 0o700)
  const uid = process.getuid()
  t.mock.method(process, 'getuid', () => uid + 1)
  assert.throws(() => checkBotConfig(config, env), /owned by DSH/)
})
