import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { apply, createRuntime } from '../index.js'
import { install } from '../src/host/skill-library.js'
import { NEVER_FIELDS } from '../src/shared/registry.js'
import { assembledReview, CLEAN_REVIEW, stubSkillReviewer } from './fixtures/skill-review-model.js'
import { fakeContext } from './fake-ctx.js'

const actor = { role: 'owner', id: 'fixture-owner' }
const notes = { name: 'notes', description: 'Write a short note.', content: 'Copy the synthetic note into the worksheet.' }
const memo = { name: 'memo', description: 'File a short memo.', content: 'File the synthetic memo in the worksheet.' }
const stat = path => fs.lstatSync(path, { throwIfNoEntry: false })
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'))
const write = (path, value) => fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
const mode = path => fs.statSync(path).mode & 0o777
const injection = { area: 'prompt-injection', file: 'SKILL.md', line: 5, severity: 'low', reason: 'Synthetic finding.' }
const blocked = JSON.stringify({ findings: [injection], overflow: false })
const makeError = (message, code) => Object.assign(new Error(message), { code })

async function settle(rt) {
  await setImmediate()
  await rt.skillLibrary.settled?.()
}

function scratch(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'worker-snapshot-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function fixture(t, { home = scratch(t), platform, writer = true, ids = ['a', 'b'] } = {}) {
  const bots = Object.fromEntries(ids.map(id => [id, { id }]))
  const warnings = []
  const listeners = new Map()
  let term = 1
  const rt = {
    home, ctx: {}, state: { bots }, botOf: id => Object.hasOwn(bots, id) ? bots[id] : undefined,
    readOnly: () => writer ? undefined : 'reader',
    teamGeneration: () => term, sameTeam: generation => writer && generation === term,
    teamCurrent: () => true, warn: (...args) => warnings.push(args),
    deleteBot: id => rt.skillLibrary.duringBotDeletion(id, () => {
      delete bots[id]
      listeners.get('Saved')?.()
    }),
  }
  for (const name of ['Saved', 'LockGained', 'Adopted']) {
    rt['on' + name] = fn => { listeners.set(name, fn); return () => listeners.delete(name) }
  }
  stubSkillReviewer(rt)
  install(rt, { platform })
  const dir = join(home, 'skills', '.bots')
  const target = join(dir, 'a.json')
  const library = join(home, 'skill-library', 'library.json')
  const call = (action, body) => rt.skillLibrary.endpoint(action, body, actor)
  const save = (form = notes) => call('skill-library-save', form)
  const assign = (name = notes.name, use = 'automatic', id = 'a') => call('bot-skill-add', { id, name, mode: use })
  const remove = (name = notes.name, id = 'a') => call('bot-skill-remove', { id, name })
  const change = (name, use) => call('bot-skill-mode', { id: 'a', name, mode: use })
  const plant = (bytes, path = target, permissions = 0o444) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (stat(path)) fs.unlinkSync(path)
    fs.writeFileSync(path, bytes, { mode: permissions })
  }
  const gain = () => { term++; writer = true; listeners.get('LockGained')?.() }
  const lose = () => { term++; writer = false }
  return { rt, home, dir, target, library, save, assign, remove, change, call, plant, warnings, gain, lose,
    advanceTerm: () => { term++ }, trigger: () => listeners.get('Saved')?.(), key: join(home, 'skill-review.key') }
}

async function assigned(f, form = notes) {
  assert.deepEqual(await f.save(form), { saved: true })
  assert.deepEqual(await f.assign(form.name), { saved: true })
  await settle(f.rt)
}

function available(f, reason = 'first add publishes a snapshot') {
  assert.ok(stat(f.target), reason)
  return read(f.target)
}

const entry = (f, form = notes, use = 'automatic') => ({
  name: form.name, mode: use, hash: read(f.library).skills[form.name].hash,
  ...(use === 'automatic' ? { description: form.description } : {}),
})
const snapshot = (skills, botId = 'a') => ({ version: 1, botId, skills })

test('#2084 case 1 shape and modes', async t => {
  const f = fixture(t)
  await assigned(f)
  assert.deepEqual(available(f), snapshot([entry(f)]))
  const bytes = fs.readFileSync(f.target, 'utf8')
  assert.ok(!bytes.includes(notes.content))
  assert.doesNotMatch(bytes, /"(content|source|check|review|findings|folder|grants|frontmatter)"/)
  assert.equal(mode(f.target), 0o444)
  assert.equal(mode(f.dir), 0o700)
  assert.equal(mode(join(f.home, 'skills')), 0o700)
  assert.equal(stat(join(f.dir, 'b.json')), undefined)
})

test('#2084 case 2 add, mode, edit, remove and deletions rewrite the active set', async t => {
  const f = fixture(t)
  await assigned(f)
  assert.deepEqual(available(f), snapshot([entry(f)]))
  await f.save(memo)
  await f.assign(memo.name, 'manual')
  await settle(f.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f), entry(f, memo, 'manual')]))
  await f.change(memo.name, 'automatic')
  await settle(f.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f), entry(f, memo)]))
  const prior = entry(f).hash
  await f.save({ ...notes, content: 'Write the revised synthetic note.', edit: true })
  await settle(f.rt)
  assert.notEqual(entry(f).hash, prior)
  assert.deepEqual(read(f.target), snapshot([entry(f), entry(f, memo)]))
  await f.remove(memo.name)
  await settle(f.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f)]))
  await f.remove()
  await settle(f.rt)
  assert.equal(stat(f.target), undefined)
  await f.assign()
  await f.assign(notes.name, 'automatic', 'b')
  await f.call('skill-library-delete', { name: notes.name })
  await settle(f.rt)
  assert.deepEqual(fs.readdirSync(f.dir), [])
  await f.assign(memo.name)
  await settle(f.rt)
  assert.ok(stat(f.target))
  await f.rt.deleteBot('a')
  await settle(f.rt)
  assert.equal(stat(f.target), undefined)
})

test('#2084 case 3 startup excludes changed, unreviewed and model-blocked records, then key loss revokes', async t => {
  const f = fixture(t)
  for (const name of ['notes', 'changed', 'unreviewed', 'blocked']) await f.save({ ...notes, name })
  const data = read(f.library)
  data.skills.changed.content = 'Changed without updating its hash.'
  delete data.skills.unreviewed.review
  delete data.skills.unreviewed.reviewSeal
  const hash = data.skills.blocked.hash
  delete data.reviews[hash]
  write(f.library, data)
  f.rt.assembleLlm = async () => assembledReview(blocked)
  assert.equal((await f.save({ ...notes, name: 'blocked', edit: true })).refused, true)
  const checked = read(f.library)
  assert.equal(checked.reviewBlocks[hash].findings[0].area, 'prompt-injection')
  checked.active.a = ['notes', 'changed', 'unreviewed', 'blocked']
  write(f.library, checked)
  const restarted = fixture(t, { home: f.home })
  await settle(restarted.rt)
  assert.deepEqual(available(restarted, 'startup publishes only the clean record'), snapshot([entry(f, notes, 'manual')]))
  fs.unlinkSync(f.key)
  assert.deepEqual(restarted.rt.skillLibrary.active('a'), [])
  await settle(restarted.rt)
  assert.equal(stat(f.target), undefined)
})

test('#2084 case 4 startup rebuilds stale entries and preserves unrelated names', async t => {
  const f = fixture(t)
  await assigned(f)
  const temp = join(f.dir, '.a.json.00000000-0000-0000-0000-000000000000.tmp')
  f.plant('{"stale":true}')
  f.plant('unknown', join(f.dir, 'ghost.json'))
  f.plant('old temp', temp)
  f.plant('keep', join(f.dir, 'notes.txt'))
  const restarted = fixture(t, { home: f.home })
  await settle(restarted.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f)]), 'startup rebuilds the stale snapshot')
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['a.json', 'notes.txt'])
  assert.equal(fs.readFileSync(join(f.dir, 'notes.txt'), 'utf8'), 'keep')
})

test('#2084 case 5 reader control and lock-gain rebuild', async t => {
  const f = fixture(t, { writer: false })
  await settle(f.rt)
  assert.equal(stat(join(f.home, 'skills')), undefined, 'control: reader creates no folder')
  const seed = fixture(t)
  await assigned(seed)
  fs.mkdirSync(join(f.home, 'skill-library'), { mode: 0o700 })
  fs.writeFileSync(f.library, fs.readFileSync(seed.library), { mode: 0o600 })
  fs.copyFileSync(seed.key, f.key)
  fs.chmodSync(f.key, 0o600)
  f.plant('{"stale":true}')
  assert.equal(f.rt.skillLibrary.active('a')[0]?.mode, 'automatic', 'reader sees the checked synthetic assignment')
  await settle(f.rt)
  assert.deepEqual(read(f.target), { stale: true }, 'control: reader leaves a planted entry')
  f.gain()
  await settle(f.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f)]), 'lock gain rebuilds the entry')
})

test('#2084 case 6 failed rename revokes and the next read retries once', async t => {
  const f = fixture(t)
  await assigned(f)
  available(f)
  const rename = fs.renameSync
  let attempts = 0
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.target) {
      attempts++
      assert.ok(fs.readFileSync(from, 'utf8').includes('"mode": "manual"'))
      assert.deepEqual(read(to), snapshot([entry(f)]))
      throw makeError('synthetic rename failure', 'EIO')
    }
    return rename(from, to)
  })
  await f.change(notes.name, 'manual')
  await settle(f.rt)
  assert.equal(attempts, 1)
  assert.deepEqual(fs.readdirSync(f.dir), [])
  fault.mock.restore()
  const observe = t.mock.method(fs, 'renameSync', (from, to) => rename(from, to))
  f.rt.skillLibrary.active('a')
  await settle(f.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f, notes, 'manual')]))
  assert.equal(observe.mock.calls.filter(call => call.arguments[1] === f.target).length, 1)
})

test('#2084 case 7 simulated Windows uses verified descriptor attributes for replacement and removal', async t => {
  const f = fixture(t, { platform: 'win32' })
  await assigned(f)
  f.plant(JSON.stringify(snapshot([entry(f)]), null, 2) + '\n')
  const old = stat(f.target).ino
  const pathChmod = t.mock.method(fs, 'chmodSync', () => assert.fail('snapshot path chmod'))
  const chmod = fs.fchmodSync
  const changes = []
  t.mock.method(fs, 'fchmodSync', (fd, permissions) => {
    changes.push([fs.fstatSync(fd).ino, permissions])
    return chmod(fd, permissions)
  })
  await f.change(notes.name, 'manual')
  await settle(f.rt)
  assert.ok(changes.some(([inode, permissions]) => inode === old && permissions === 0o644),
    'replace clears the read-only attribute through its descriptor')
  assert.equal(mode(f.target), 0o444)
  const next = stat(f.target).ino
  await f.remove()
  await settle(f.rt)
  assert.ok(changes.some(([inode, permissions]) => inode === next && permissions === 0o644))
  assert.equal(stat(f.target), undefined)
  assert.equal(pathChmod.mock.callCount(), 0)
})

function tree(home, path = '') {
  const result = {}
  for (const name of fs.readdirSync(join(home, path))) {
    const child = join(path, name)
    const target = join(home, child)
    const info = stat(target)
    result[child] = info.isDirectory() ? ['directory', mode(target)] : ['file', mode(target), fs.readFileSync(target, 'hex')]
    if (info.isDirectory()) Object.assign(result, tree(home, child))
  }
  return result
}

test('#2084 case 8 permitted paths and unchanged roster and registry controls', async t => {
  const f = fixture(t)
  fs.mkdirSync(join(f.home, 'skill-library'), { mode: 0o700 })
  write(join(f.home, 'state.json'), { fixture: 'state' })
  write(join(f.home, 'bots.json'), { fixture: 'registry' })
  const allowed = ['skill-library/library.json', 'skill-library/audit.jsonl', 'skill-review.key',
    'skills', 'skills/.bots', 'skills/.bots/a.json']
  let activeChanged = false
  for (const [name, run] of [['save', f.save], ['add', f.assign], ['mode', () => f.change(notes.name, 'manual')], ['remove', f.remove]]) {
    const before = tree(f.home)
    await run()
    await settle(f.rt)
    const after = tree(f.home)
    for (const path of ['state.json', 'bots.json']) assert.deepEqual(after[path], before[path], 'control: roster and registry stay unchanged')
    assert.ok(NEVER_FIELDS.includes('capabilities'), 'control: registry excludes capabilities')
    const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path]))
    assert.ok(changes.every(path => allowed.includes(path)), JSON.stringify(changes))
    if (name === 'add') activeChanged = changes.includes('skills/.bots/a.json')
  }
  assert.ok(activeChanged, 'add changes the snapshot path')
})

test('#2084 case 9 manual assignments omit the description', async t => {
  const f = fixture(t)
  await f.save()
  await f.save(memo)
  await f.assign()
  await f.call('bot-skill-add', { id: 'a', name: memo.name })
  await settle(f.rt)
  assert.deepEqual(available(f, 'manual assignment appears in the snapshot'),
    snapshot([entry(f), entry(f, memo, 'manual')]))
})

for (const [suffix, fault] of [
  ['a', f => fs.writeFileSync(f.library, '{')],
  ['b', f => write(f.library, { version: 1, skills: [], active: {} })],
  ['c', f => fs.chmodSync(f.key, 0o644)],
]) {
  test('#2084 case 10' + suffix + ' read failure revokes and the next valid read restores', async t => {
    const f = fixture(t)
    await assigned(f)
    available(f)
    const good = fs.readFileSync(f.library)
    const published = fs.readFileSync(f.target)
    fault(f)
    assert.deepEqual(f.rt.skillLibrary.active('a'), [])
    await settle(f.rt)
    assert.equal(stat(f.target), undefined)
    fs.chmodSync(f.key, 0o600)
    fs.writeFileSync(f.library, good)
    assert.equal(f.rt.skillLibrary.active('a').length, 1)
    await settle(f.rt)
    assert.deepEqual(fs.readFileSync(f.target), published)
  })
}

for (const kind of ['directory sync', 'temp cleanup']) {
  test('#2084 cases 10d and 14 landed block reconciles despite ' + kind + ' failure', async t => {
    const f = fixture(t)
    await assigned(f, memo)
    available(f)
    const data = read(f.library)
    const { hash, review, reviewSeal } = data.skills.memo
    assert.ok(data.reviews[hash])
    delete data.reviews[hash]
    write(f.library, data)
    assert.equal(f.rt.skillLibrary.active('a')[0].hash, hash, 'per-record review remains valid')
    await settle(f.rt)
    let calls = 0
    let failed = false
    f.rt.assembleLlm = async () => {
      calls++
      return assembledReview(blocked)
    }
    const error = makeError('synthetic ' + kind + ' failure', 'EIO')
    if (kind === 'directory sync') {
      const open = fsp.open
      const mock = t.mock.method(fsp, 'open', async (path, ...args) => {
        const handle = await open(path, ...args)
        if (path === join(f.home, 'skill-library')) handle.sync = async () => { failed = true; throw error }
        return handle
      })
      syncBuiltinESMExports()
      t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
    } else {
      const rm = fs.rmSync
      t.mock.method(fs, 'rmSync', (path, ...args) => {
        if (/\/skill-library\/library-.*\.tmp$/.test(path)) {
          failed = true
          throw error
        }
        return rm(path, ...args)
      })
    }
    await assert.rejects(f.save({ ...memo, edit: true }), cause => cause === error)
    assert.equal(calls, 1)
    assert.equal(failed, true)
    const landed = read(f.library)
    assert.deepEqual(landed.skills.memo.review, review)
    assert.equal(landed.skills.memo.reviewSeal, reviewSeal)
    assert.deepEqual(landed.reviewBlocks[hash].findings, [injection])
    assert.equal(stat(f.target), undefined, 'landed block revokes before a subsequent library read')
  })
}

test('#2084 case 10e forced publication fails, settles, and retries on an external read', async t => {
  const f = fixture(t)
  await assigned(f)
  available(f)
  const data = read(f.library)
  data.active.a = [{ name: notes.name, mode: 'manual' }]
  write(f.library, data)
  const open = fs.openSync
  let attempts = 0
  const fault = t.mock.method(fs, 'openSync', (path, ...args) => {
    if (typeof path === 'string' && path.startsWith(join(f.dir, '.a.json.'))) {
      attempts++
      throw makeError('synthetic temp write failure', 'EACCES')
    }
    return open(path, ...args)
  })
  for (let i = 0; i < 3; i++) assert.equal(f.rt.skillLibrary.active('a')[0].mode, 'manual')
  await settle(f.rt)
  assert.equal(attempts, 1)
  assert.equal(stat(f.target), undefined)
  fault.mock.restore()
  f.rt.skillLibrary.active('a')
  await settle(f.rt)
  assert.deepEqual(read(f.target), snapshot([entry(f, notes, 'manual')]))
})

test('#2084 case 11a simulated Windows retry stops on handover and the successor cleans the temp', async t => {
  const f = fixture(t, { platform: 'win32' })
  await assigned(f)
  available(f)
  const successor = '{"successor":true}\n'
  const rename = fs.renameSync
  const unlink = fs.unlinkSync
  let first = true
  let temp
  const mutations = []
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.target) {
      mutations.push(['rename', from])
      if (first) {
        first = false
        temp = from
        f.lose()
        unlink(to)
        fs.writeFileSync(to, successor, { mode: 0o444 })
        throw makeError('synthetic busy rename', 'EBUSY')
      }
    }
    return rename(from, to)
  })
  t.mock.method(fs, 'unlinkSync', path => {
    if (path.startsWith(f.dir)) mutations.push(['unlink', path])
    return unlink(path)
  })
  await f.change(notes.name, 'manual')
  await settle(f.rt)
  assert.ok(temp)
  assert.deepEqual(mutations, [['rename', temp]])
  assert.equal(fs.readFileSync(f.target, 'utf8'), successor)
  assert.equal(mode(f.target), 0o444)
  assert.ok(stat(temp))
  f.gain()
  await settle(f.rt)
  assert.equal(stat(temp), undefined)
  assert.deepEqual(read(f.target), snapshot([entry(f, notes, 'manual')]))
  assert.ok(mutations.some(([operation, path]) => operation === 'unlink' && path === temp))
})

test('#2084 case 11b fence before unlink preserves a successor entry', async t => {
  const f = fixture(t)
  await assigned(f)
  available(f)
  const target = join(f.dir, 'b.json')
  f.plant('successor', target)
  const lstat = fs.lstatSync
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const result = lstat(path, ...args)
    if (path === target) f.lose()
    return result
  })
  f.trigger()
  await settle(f.rt)
  assert.equal(fs.readFileSync(target, 'utf8'), 'successor')
  assert.equal(mode(target), 0o444)
})

test('#2084 case 11a first rename callback observes the new term after the destination check', async t => {
  const f = fixture(t)
  await assigned(f)
  const before = available(f)
  const lstat = fs.lstatSync
  const chmod = fs.fchmodSync
  const sameTeam = f.rt.sameTeam
  const term = f.rt.teamGeneration()
  const observations = []
  let phase = 'writing temp'
  let destinationChecks = 0
  t.mock.method(fs, 'fchmodSync', (fd, value) => {
    const result = chmod(fd, value)
    if (value === 0o444 && phase === 'writing temp') phase = 'temp ready'
    return result
  })
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const result = lstat(path, ...args)
    if (path === f.target && phase === 'temp ready') phase = 'destination check'
    if (path.startsWith(f.dir) && path.endsWith('.tmp') && phase === 'destination checked') phase = 'rename callback'
    return result
  })
  f.rt.holdsLock = () => {
    if (phase === 'destination check' && ++destinationChecks === 2) {
      observations.push(['destination check', f.rt.teamGeneration()])
      phase = 'destination checked'
      f.advanceTerm()
    }
    return true
  }
  t.mock.method(f.rt, 'sameTeam', generation => {
    const current = sameTeam(generation)
    if (phase === 'rename callback') {
      observations.push(['rename callback', f.rt.teamGeneration(), generation, current])
      phase = 'observed'
    }
    return current
  })
  const rename = t.mock.method(fs, 'renameSync', fs.renameSync)
  await f.change(notes.name, 'manual')
  await settle(f.rt)
  assert.deepEqual(observations, [['destination check', term], ['rename callback', term + 1, term, false]])
  assert.equal(rename.mock.calls.filter(call => call.arguments[1] === f.target).length, 0)
  assert.deepEqual(read(f.target), before)
  assert.equal(fs.readdirSync(f.dir).filter(name => name.endsWith('.tmp')).length, 1)
  f.gain()
  await settle(f.rt)
  assert.deepEqual(fs.readdirSync(f.dir), ['a.json'])
  assert.deepEqual(read(f.target), snapshot([entry(f, notes, 'manual')]))
})

test('#2084 revocation listing removes known names before Remove returns and retries unknown names', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'retired'] })
  await assigned(f)
  await f.assign(notes.name, 'automatic', 'retired')
  await settle(f.rt)
  const retired = join(f.dir, 'retired.json')
  const rosterOnly = join(f.dir, 'b.json')
  const assignmentOnly = join(f.dir, 'orphan.json')
  const unknown = join(f.dir, 'undiscovered.json')
  const folder = join(f.dir, 'folder.json')
  assert.ok(stat(f.target))
  assert.ok(stat(retired))
  const data = read(f.library)
  data.active.orphan = data.active.retired
  delete data.active.retired
  write(f.library, data)
  delete f.rt.state.bots.retired
  for (const path of [rosterOnly, assignmentOnly, unknown]) f.plant('synthetic stale snapshot', path)
  fs.mkdirSync(folder)
  fs.writeFileSync(join(folder, 'sentinel'), 'keep')
  const readdir = fs.readdirSync
  let enumerationFails = true
  let denied = 0
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === f.dir && enumerationFails) {
      denied++
      throw makeError('synthetic search-only directory', 'EACCES')
    }
    return readdir(path, ...args)
  })
  assert.deepEqual(await f.remove(), { saved: true })
  assert.ok(denied > 0)
  assert.equal(stat(f.target), undefined, 'last Remove revokes before returning even when listing fails')
  for (const path of [retired, rosterOnly, assignmentOnly]) assert.equal(stat(path), undefined, path)
  assert.ok(stat(unknown))
  assert.ok(f.warnings.some(args => /synthetic search-only directory/.test(String(args[1]))))
  await settle(f.rt)
  enumerationFails = false
  assert.deepEqual(f.rt.skillLibrary.active('a'), [])
  await settle(f.rt)
  assert.equal(stat(unknown), undefined, 'an unchanged library read retries incomplete publication')
  assert.equal(fs.readFileSync(join(folder, 'sentinel'), 'utf8'), 'keep')
})

function simulateCaseAliases(t, dir, { uncertain }) {
  const readdir = fs.readdirSync
  const resolve = path => {
    if (typeof path !== 'string' || !path.startsWith(dir + '/')) return path
    const requested = path.slice(dir.length + 1)
    if (requested.includes('/')) return path
    const existing = readdir(dir).find(name => name.toLowerCase() === requested.toLowerCase())
    return existing === undefined ? path : join(dir, existing)
  }
  const lstat = fs.lstatSync
  const open = fs.openSync
  const rename = fs.renameSync
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (uncertain && path.startsWith(dir + '/') && path.endsWith('.TMP')) {
      throw makeError('synthetic alternate lookup refusal', 'EACCES')
    }
    return lstat(resolve(path), ...args)
  })
  const opens = t.mock.method(fs, 'openSync', (path, ...args) => open(resolve(path), ...args))
  t.mock.method(fs, 'renameSync', (from, to) => rename(resolve(from), resolve(to)))
  const unlinks = t.mock.method(fs, 'unlinkSync', path => unlink(resolve(path)))
  return { opens, unlinks }
}

for (const [label, bothAssigned, uncertain] of [
  ['two assigned Bots', true, false],
  ['one unassigned Bot', false, false],
  ['uncertain alternate lookup', true, true],
]) {
  test('#2084 revocation alias withholds the shared entry with ' + label, async t => {
    const f = fixture(t, { ids: ['a', 'A', 'other'] })
    await f.save(notes)
    await f.save(memo)
    await f.assign(memo.name, 'automatic', 'other')
    await settle(f.rt)
    const other = join(f.dir, 'other.json')
    const inode = stat(other).ino
    const upper = join(f.dir, 'A.json')
    f.plant(JSON.stringify(snapshot([entry(f, memo)], 'A')), upper)
    const { opens, unlinks } = simulateCaseAliases(t, f.dir, { uncertain })
    assert.equal(stat(f.target).ino, stat(upper).ino, 'both spellings resolve to the planted entry')
    assert.deepEqual(await f.assign(notes.name), { saved: true })
    if (bothAssigned) assert.deepEqual(await f.assign(memo.name, 'manual', 'A'), { saved: true })
    await settle(f.rt)
    assert.equal(stat(upper), undefined, 'the ambiguous shared entry must be revoked')
    assert.equal(stat(f.target), undefined)
    assert.deepEqual(fs.readdirSync(f.dir), ['other.json'])
    assert.equal(stat(other).ino, inode)
    assert.deepEqual(read(other), snapshot([entry(f, memo)], 'other'))
    assert.ok(opens.mock.calls.some(({ arguments: [path, flag, mode] }) =>
      path.startsWith(f.dir) && path.endsWith('.tmp') && flag === 'wx' && mode === 0o600))
    assert.equal(unlinks.mock.calls.filter(({ arguments: [path] }) => path === f.target || path === upper).length, 1)
    assert.ok(f.warnings.some(args => /ambiguous|alternate lookup refusal/.test(String(args[1]))))
    assert.equal(Object.hasOwn(read(f.library).active, 'A'), bothAssigned)
  })
}

test('#2084 revocation alias case-sensitive directory preserves distinct snapshots', async t => {
  const f = fixture(t, { ids: ['a', 'A', 'other'] })
  await assigned(f)
  await f.save(memo)
  await f.assign(memo.name, 'manual', 'A')
  await f.assign(memo.name, 'automatic', 'other')
  await settle(f.rt)
  const upper = join(f.dir, 'A.json')
  assert.notEqual(stat(f.target).ino, stat(upper).ino)
  assert.deepEqual(read(f.target), snapshot([entry(f)]))
  assert.deepEqual(read(upper), snapshot([entry(f, memo, 'manual')], 'A'))
  assert.deepEqual(read(join(f.dir, 'other.json')), snapshot([entry(f, memo)], 'other'))
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['A.json', 'a.json', 'other.json'])
})

function roster(botId = 'a') {
  return { version: 2, revision: 1, mainBotIds: [botId], bots: {
    [botId]: { id: botId, sessionId: 'fixture-chat', name: 'Fixture Bot', createdAt: 1, role: 'Helper', capabilities: [] },
  }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: {} }
}

function importFixture(t) {
  const f = fixture(t)
  write(join(f.home, 'state.json'), roster())
  return { ...f, dest: scratch(t), config: { github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false } }
}

const importTeam = f => createRuntime(fakeContext(), { ...f.config, home: f.dest, importHome: f.home })

test('#2084 case 12a interrupted state publication excludes derived entries and preserves ordinary files', async t => {
  const f = importFixture(t)
  await assigned(f)
  f.plant('source snapshot')
  fs.writeFileSync(join(f.home, 'skills', 'readme.md'), 'fixture readme')
  if (process.platform !== 'win32') fs.writeFileSync(join(f.home, 'skills', '.bots\\unrelated'), 'posix filename')
  const link = fs.linkSync
  let interrupted = false
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (to === join(f.dest, 'state.json')) {
      interrupted = true
      throw new Error('Synthetic interruption before state publication')
    }
    return link(from, to)
  })
  assert.throws(() => importTeam(f), /interruption before state publication/)
  assert.equal(interrupted, true)
  assert.equal(stat(join(f.dest, 'state.json')), undefined)
  assert.equal(read(join(f.dest, 'skill-library', 'library.json')).skills.notes.hash, entry(f).hash)
  assert.equal(fs.readFileSync(join(f.dest, 'skills', 'readme.md'), 'utf8'), 'fixture readme')
  if (process.platform !== 'win32') {
    assert.equal(fs.readFileSync(join(f.dest, 'skills', '.bots\\unrelated'), 'utf8'), 'posix filename')
  }
  assert.equal(stat(join(f.dest, 'skills', '.bots')), undefined, 'interrupted import must exclude the derived subtree')
})

test('#2084 case 12b successful import holds the copied record without copying its snapshot', async t => {
  const f = importFixture(t)
  await assigned(f)
  f.plant('source snapshot')
  fs.writeFileSync(join(f.home, 'skills', 'readme.md'), 'fixture readme')
  const before = tree(f.home)
  const rt = importTeam(f)
  try {
    await rt.load()
    await settle(rt)
    assert.ok(rt.botOf('a'))
    assert.deepEqual(rt.skillLibrary.active('a'), [])
    assert.equal(fs.readFileSync(join(f.dest, 'skills', 'readme.md'), 'utf8'), 'fixture readme')
    assert.deepEqual(tree(f.home), before)
    assert.equal(stat(join(f.dest, 'skills', '.bots', 'a.json')), undefined, 'destination-held skill has no copied snapshot')
  } finally { rt.dispose() }
})

test('#2084 case 12c import skips a linked top-level skills entry even if the copied link would dangle', async t => {
  const f = importFixture(t)
  const outside = scratch(t)
  fs.mkdirSync(join(outside, '.bots'), { mode: 0o700 })
  fs.writeFileSync(join(outside, '.bots', 'a.json'), 'source snapshot')
  fs.symlinkSync(outside, join(f.home, 'skills'), 'dir')
  const rt = importTeam(f)
  try {
    await rt.load()
    await settle(rt)
    assert.equal(stat(join(f.dest, 'skills')), undefined, 'linked top-level skills entry is excluded')
  } finally { rt.dispose() }
})

for (const platform of ['linux', 'win32']) {
  const label = platform === 'win32' ? 'simulated Windows' : 'POSIX'
  test('#2084 case 13a ' + label + ' equal bytes in a writable entry still require replacement', async t => {
    const f = fixture(t, { platform })
    await assigned(f)
    f.plant(JSON.stringify(snapshot([entry(f)]), null, 2) + '\n', f.target, 0o644)
    const inode = stat(f.target).ino
    f.trigger()
    await settle(f.rt)
    assert.equal(mode(f.target), 0o444, 'equal bytes in a writable entry are replaced')
    assert.notEqual(stat(f.target).ino, inode)
  })

  for (const link of ['symlink', 'hard link']) {
    test('#2084 case 13' + (link === 'symlink' ? 'b' : 'c') + ' ' + label + ' preserves a ' + link + ' sentinel', async t => {
      const f = fixture(t, { platform })
      await assigned(f)
      fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 })
      if (stat(f.target)) fs.unlinkSync(f.target)
      const sentinel = join(f.home, 'sentinel')
      fs.writeFileSync(sentinel, 'sentinel bytes', { mode: 0o600 })
      if (link === 'symlink') fs.symlinkSync(sentinel, f.target)
      else fs.linkSync(sentinel, f.target)
      f.trigger()
      await settle(f.rt)
      assert.equal(mode(f.target), 0o444, 'linked entry is replaced by a read-only snapshot')
      assert.equal(stat(f.target).nlink, 1)
      assert.ok(stat(f.target).isFile())
      assert.deepEqual(read(f.target), snapshot([entry(f)]))
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel bytes')
      assert.equal(mode(sentinel), 0o600)
      await f.remove()
      await settle(f.rt)
      assert.equal(stat(f.target), undefined)
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel bytes')
      assert.equal(mode(sentinel), 0o600)
    })
  }
}

test('#2084 case 13d folder preservation control and warning', async t => {
  const f = fixture(t)
  const folder = join(f.dir, 'z.json')
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  fs.writeFileSync(join(folder, 'sentinel'), 'keep')
  f.trigger()
  await settle(f.rt)
  assert.equal(fs.readFileSync(join(folder, 'sentinel'), 'utf8'), 'keep', 'control: directory is preserved')
  assert.ok(f.warnings.length, 'the publisher warns about the folder')
})

test('#2084 case 13 simulated Windows leaves read-only hard links including owned temps before unlink fallback', async t => {
  const f = fixture(t, { platform: 'win32' })
  await assigned(f)
  available(f)
  const sentinel = join(f.home, 'sentinel')
  fs.writeFileSync(sentinel, 'sentinel bytes', { mode: 0o444 })
  const stale = join(f.dir, 'stale.json')
  const temp = join(f.dir, '.a.json.00000000-0000-0000-0000-000000000000.tmp')
  fs.linkSync(sentinel, stale)
  fs.linkSync(sentinel, temp)
  const unlink = t.mock.method(fs, 'unlinkSync', fs.unlinkSync)
  f.trigger()
  await settle(f.rt)
  assert.ok(f.warnings.length)
  assert.equal(unlink.mock.calls.some(call => [stale, temp].includes(call.arguments[0])), false)
  for (const path of [sentinel, stale, temp]) {
    assert.equal(fs.readFileSync(path, 'utf8'), 'sentinel bytes')
    assert.equal(mode(path), 0o444)
  }
})

for (const fault of ['identity change', 'descriptor refusal']) {
  test('#2084 case 13 simulated Windows ' + fault + ' leaves the entry and sentinel attributes alone', async t => {
    const f = fixture(t, { platform: 'win32' })
    await assigned(f)
    available(f)
    const sentinel = join(f.home, 'sentinel')
    const old = join(f.home, 'old-snapshot')
    fs.writeFileSync(sentinel, 'sentinel bytes', { mode: 0o444 })
    let fired = false
    const open = fs.openSync
    const chmod = fs.fchmodSync
    const inode = stat(f.target).ino
    if (fault === 'identity change') {
      t.mock.method(fs, 'openSync', (path, ...args) => {
        if (path === f.target && !fired) {
          fs.renameSync(path, old)
          fs.linkSync(sentinel, path)
          fired = true
        }
        return open(path, ...args)
      })
    } else {
      t.mock.method(fs, 'fchmodSync', (fd, value) => {
        if (value === 0o644 && fs.fstatSync(fd).ino === inode) {
          fired = true
          throw makeError('synthetic descriptor refusal', 'EPERM')
        }
        return chmod(fd, value)
      })
    }
    await f.remove()
    await settle(f.rt)
    assert.equal(fired, true)
    assert.ok(f.warnings.length)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel bytes')
    assert.equal(mode(sentinel), 0o444)
    assert.equal(mode(f.target), 0o444)
    if (fault === 'identity change') assert.equal(fs.readFileSync(f.target, 'utf8'), 'sentinel bytes')
    else assert.equal(stat(f.target).ino, inode)
  })
}

test('#2084 case 15 saved roster deletion revokes after a failed assignment write', async t => {
  const f = fixture(t)
  await assigned(f)
  available(f)
  const writeFile = fs.writeFileSync
  let failed = false
  t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (typeof path === 'string' && /\/skill-library\/library-.*\.tmp$/.test(path)) {
      failed = true
      throw makeError('synthetic assignment cleanup failure', 'EIO')
    }
    return writeFile(path, ...args)
  })
  await f.rt.deleteBot('a')
  await settle(f.rt)
  assert.equal(failed, true)
  assert.ok(read(f.library).active.a.length)
  assert.equal(f.rt.botOf('a'), undefined)
  assert.equal(stat(f.target), undefined)
})

test('#2084 joined fake e2e publishes, holds, revokes, restores and removes via the plugin', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network request'))
  const home = scratch(t)
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const id = 'b-aaaaaaaaaa'
  const savedRoster = roster(id)
  savedRoster.prefs.backgroundModel = 'fixture-native/fixture-model'
  write(join(home, 'state.json'), savedRoster)
  const reviews = []
  class FakeModel extends LlmAdapter {
    async listModels(provider) { return [await this.resolveModel(provider, 'fixture-model')] }
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } }
    }
    async *stream({ provider, model, messages, tools, system }) {
      assert.equal(provider, 'fixture-native')
      assert.equal(model, 'fixture-model')
      assert.deepEqual(tools, [])
      assert.match(system, /^Review the supplied skill/)
      reviews.push(/^skill (.+)$/m.exec(messages[0].content[0].text)[1])
      yield { type: 'text-delta', index: 0, text: CLEAN_REVIEW }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.llm.registerAdapter(['fixture-native'], new FakeModel())
  const routes = new Map()
  root.provide('connection', { fetch: { register: route => {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'fixture-workspace', path }) })
  root.provide('sessionTitle', { rename: async () => {} })
  apply(root, { home, github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  const rt = root.get('omniTeam')
  const call = async (endpoint, payload) => {
    const response = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui',
      { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    const result = await response.json()
    assert.equal(result.ok, true, endpoint + ': ' + JSON.stringify(result))
    return result.value
  }
  for (const form of [notes, memo]) assert.deepEqual(await call('skill-library-save', form), { saved: true })
  assert.deepEqual(reviews, ['notes', 'memo'])
  await call('bot-skill-add', { id, name: notes.name, mode: 'automatic' })
  await call('bot-skill-add', { id, name: memo.name })
  await settle(rt)
  const dir = join(home, 'skills', '.bots')
  const target = join(dir, id + '.json')
  const library = join(home, 'skill-library', 'library.json')
  const f = { target, library }
  assert.deepEqual(available(f, 'plugin owner endpoint publishes both active assignments'),
    snapshot([entry(f), entry(f, memo, 'manual')], id))
  assert.equal(mode(target), 0o444)
  const data = read(library)
  data.skills.memo.content = 'Changed synthetic memo.'
  write(library, data)
  assert.deepEqual(rt.skillLibrary.active(id).map(row => row.name), ['notes'])
  await settle(rt)
  assert.deepEqual(read(target), snapshot([entry(f)], id))
  fs.writeFileSync(library, '{')
  assert.deepEqual(rt.skillLibrary.active(id), [])
  await settle(rt)
  assert.equal(stat(target), undefined)
  write(library, data)
  assert.deepEqual(rt.skillLibrary.active(id).map(row => row.name), ['notes'])
  await settle(rt)
  assert.deepEqual(read(target), snapshot([entry(f)], id))
  await call('bot-skill-remove', { id, name: notes.name })
  await settle(rt)
  assert.deepEqual(fs.readdirSync(dir), [])
})
