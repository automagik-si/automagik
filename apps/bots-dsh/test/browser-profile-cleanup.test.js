import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/browser-plugins.js'
import { until } from './until.js'

const botId = 'bot-1'
const missing = path => assert.rejects(lstat(path), { code: 'ENOENT' })

async function scratchRuntime(t, browserPlugin = 'refs') {
  const home = await mkdtemp(join(tmpdir(), 'bot-browser-cleanup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profileRoot = join(home, 'browser-profiles')
  await mkdir(profileRoot)
  const deleteBot = t.mock.fn(async id => ({ id }))
  const rt = {
    home, deleteBot, teamTools: [], ctx: { effect() {} },
    config: { browserPlugin, browserExecutablePath: '/unused' },
  }
  return { rt, profileRoot, deleteBot }
}

test('install sweeps legacy cookie files before any browser call', async t => {
  const { rt, profileRoot } = await scratchRuntime(t)
  const legacy = join(profileRoot, 'file', 'cookies.json')
  const cookieLink = join(profileRoot, 'link', 'cookies.json')
  const directoryChild = join(profileRoot, 'directory', 'cookies.json', 'keep')
  const outside = join(rt.home, 'outside')
  const linkedProfile = join(profileRoot, 'linked-profile')
  const otherFiles = [
    join(profileRoot, 'file', 'tabs.json'),
    join(profileRoot, 'file', 'Default', 'Cookies'),
    join(profileRoot, 'file', 'nested', 'cookies.json'),
    join(profileRoot, 'cookies.json'),
    directoryChild,
    join(outside, 'cookies.json'),
  ]
  for (const dir of ['link', 'file/Default', 'file/nested', 'directory/cookies.json']) {
    await mkdir(join(profileRoot, dir), { recursive: true })
  }
  await mkdir(outside)
  for (const file of [legacy, ...otherFiles]) await writeFile(file, 'fixture')
  await symlink(join(outside, 'cookies.json'), cookieLink, 'file')
  await symlink(outside, linkedProfile, 'dir')

  assert.equal(install(rt), undefined)
  await until(() => !existsSync(legacy) && !existsSync(cookieLink), { t })

  await missing(legacy)
  await missing(cookieLink)
  assert.equal((await lstat(linkedProfile)).isSymbolicLink(), true)
  for (const file of otherFiles) assert.equal(await readFile(file, 'utf8'), 'fixture')
})

test('install sweeps the exact legacy file with the browser plugin disabled', async t => {
  const { rt, profileRoot } = await scratchRuntime(t, false)
  const profile = join(profileRoot, botId)
  const legacy = join(profile, 'cookies.json')
  const nativeFile = join(profile, 'Default', 'Cookies')
  const nestedFile = join(profile, 'Default', 'cookies.json')
  await mkdir(join(profile, 'Default'), { recursive: true })
  await writeFile(legacy, 'legacy export')
  await writeFile(nativeFile, 'browser-owned cookies')
  await writeFile(nestedFile, 'unrelated file')

  assert.equal(install(rt), undefined)
  await until(() => !existsSync(legacy), { t })

  await missing(legacy)
  assert.equal(await readFile(nativeFile, 'utf8'), 'browser-owned cookies')
  assert.equal(await readFile(nestedFile, 'utf8'), 'unrelated file')
})

for (const browserPlugin of ['refs', false]) {
  test(`deleting a Bot removes its profile with the browser plugin ${browserPlugin ? 'enabled' : 'disabled'}`, async t => {
    const { rt, profileRoot, deleteBot } = await scratchRuntime(t, browserPlugin)
    const profile = join(profileRoot, botId)
    const otherProfile = join(profileRoot, 'bot-2')
    await mkdir(join(profile, 'Default'), { recursive: true })
    await writeFile(join(profile, 'Default', 'Cookies'), 'browser-owned cookies')
    await mkdir(otherProfile)
    install(rt)
    assert.equal(rt.browserPlugin, browserPlugin || undefined)

    assert.deepEqual(await rt.deleteBot(botId), { id: botId })

    assert.equal(deleteBot.mock.callCount(), 1)
    assert.equal(deleteBot.mock.calls[0].this, rt)
    await missing(profile)
    assert.equal((await lstat(otherProfile)).isDirectory(), true)
  })
}

test('deletion with the browser plugin disabled skips cleanup for an unsafe Bot ID', async t => {
  const { rt, profileRoot, deleteBot } = await scratchRuntime(t, false)
  const outside = join(rt.home, 'outside')
  const kept = [outside, join(profileRoot, 'nested/bot'), join(profileRoot, 'bot\\other')]
  for (const dir of kept) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'keep'), 'keep me')
  }
  install(rt)

  const unsafeIds = ['../outside', '.', '..', '', 'nested/bot', 'bot\\other', 'bot\0other']
  for (const id of unsafeIds) assert.deepEqual(await rt.deleteBot(id), { id })

  assert.deepEqual(deleteBot.mock.calls.map(call => call.arguments[0]), unsafeIds)
  for (const dir of kept) assert.equal(await readFile(join(dir, 'keep'), 'utf8'), 'keep me')
})
