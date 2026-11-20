import { randomUUID } from 'node:crypto'
import * as disk from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isPackageRoleId, isWindowsReservedName } from '../shared/roles.js'
import { plainObject, parseRoleJson } from './role-catalog.js'
import { lstat, readRegular } from './role-package.js'
import { refusal } from './refusal.js'

const LIMIT = 16 * 1024
const unsafe = () => refusal('The role settings path is unsafe or unreadable.')
const validValue = (kind, value) => kind === 'voice'
  ? typeof value === 'string' && value.length <= 200 && !/\p{Cc}/u.test(value)
  : Number.isFinite(value) && value >= 0.5 && value <= 2

export function createRoleSettings(home, fs = disk) {
  async function folder(botId, roleId, create, check) {
    if (!isAbsolute(home) || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(botId)
      || botId.endsWith('.') || isWindowsReservedName(botId) || !isPackageRoleId(roleId)) throw unsafe()
    let path = home
    for (const part of ['', 'roles', 'data', botId, roleId]) {
      if (part) path = join(path, part)
      let stat = await lstat(fs, path)
      if (!stat && create && part) {
        check()
        try { await fs.mkdir(path, { mode: 0o700 }) } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        stat = await lstat(fs, path)
      }
      if (!stat) return undefined
      if (!stat.isDirectory()) throw unsafe()
    }
    return path
  }
  async function readAt(path, settings) {
    const file = join(path, 'settings.json')
    const stat = await lstat(fs, file)
    let saved = {}
    if (stat) {
      const bytes = await readRegular(fs, file, stat, LIMIT)
      try {
        saved = parseRoleJson(bytes)
        if (!plainObject(saved)) throw unsafe()
      } catch { throw unsafe() }
    }
    return Object.fromEntries(settings.map(({ key, kind }) =>
      [key, Object.hasOwn(saved, key) && validValue(kind, saved[key]) ? saved[key] : kind === 'voice' ? '' : 1]))
  }
  return {
    async read(botId, roleId, settings) {
      const path = await folder(botId, roleId, false)
      if (path) return readAt(path, settings)
      return Object.fromEntries(settings.map(({ key, kind }) => [key, kind === 'voice' ? '' : 1]))
    },
    async write(botId, roleId, settings, patch, check) {
      if (!plainObject(patch) || !Object.entries(patch).every(([key, value]) =>
        settings.some(setting => setting.key === key && validValue(setting.kind, value)))) {
        throw refusal('Invalid role settings.')
      }
      const path = await folder(botId, roleId, true, check)
      if (!path) throw unsafe()
      const original = await lstat(fs, path)
      const values = { ...await readAt(path, settings), ...patch }
      const staged = join(path, `.settings-${randomUUID()}`)
      check()
      try {
        await fs.writeFile(staged, JSON.stringify(values) + '\n', { flag: 'wx', mode: 0o600 })
        await folder(botId, roleId, false)
        const before = await lstat(fs, path)
        if (!before || before.ino !== original.ino || before.dev !== original.dev) throw unsafe()
        const target = join(path, 'settings.json')
        const stat = await lstat(fs, target)
        if (stat && (!stat.isFile() || stat.nlink !== 1)) throw unsafe()
        check()
        await fs.rename(staged, target)
      } finally {
        await fs.unlink(staged).catch(() => {})
      }
      return values
    },
  }
}
