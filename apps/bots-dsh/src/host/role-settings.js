import { randomUUID } from 'node:crypto'
import * as disk from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isPackageRoleId, isWindowsReservedName } from '../shared/roles.js'
import { plainObject, parseRoleJson } from './role-catalog.js'
import { lstat, readRegular } from './role-package.js'
import { refusal } from './refusal.js'

const LIMIT = 16 * 1024
const unsafe = () => refusal('The role settings path is unsafe or unreadable.')
const runtimeByHome = new Map()

// The settings writer also serves direct callers. Bind it for the lifetime of
// the host so a caller cannot bypass the roster and update checks.
export function bindRoleSettings(rt) {
  const home = resolve(rt.home)
  const hosts = runtimeByHome.get(home) ?? new Set()
  hosts.add(rt)
  runtimeByHome.set(home, hosts)
  return () => {
    hosts.delete(rt)
    if (hosts.size === 0) runtimeByHome.delete(home)
  }
}
const validValue = (kind, value) => kind === 'voice'
  ? typeof value === 'string' && value.length <= 200 && !/\p{Cc}/u.test(value)
  : Number.isFinite(value) && value >= 0.5 && value <= 2

export function createRoleSettings(home, fs = disk) {
  function admit(botId, roleId, write = false) {
    const hosts = runtimeByHome.get(resolve(home))
    if (!hosts) return
    const rt = [...hosts].find(host => host.hasCommittedRole(botId, roleId))
    if (!rt) throw refusal("This Bot's role changed. Try again.")
    if (write && !rt.sidecarWritable()) throw refusal('Role settings can be changed after the update commits.')
  }
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
      admit(botId, roleId)
      const path = await folder(botId, roleId, false)
      if (path) {
        const values = await readAt(path, settings)
        admit(botId, roleId)
        return values
      }
      admit(botId, roleId)
      return Object.fromEntries(settings.map(({ key, kind }) => [key, kind === 'voice' ? '' : 1]))
    },
    async write(botId, roleId, settings, patch, check) {
      const writer = () => { check(); admit(botId, roleId, true) }
      writer()
      if (!plainObject(patch) || !Object.entries(patch).every(([key, value]) =>
        settings.some(setting => setting.key === key && validValue(setting.kind, value)))) {
        throw refusal('Invalid role settings.')
      }
      const path = await folder(botId, roleId, true, writer)
      if (!path) throw unsafe()
      const original = await lstat(fs, path)
      const values = { ...await readAt(path, settings), ...patch }
      const staged = join(path, `.settings-${randomUUID()}`)
      writer()
      try {
        await fs.writeFile(staged, JSON.stringify(values) + '\n', { flag: 'wx', mode: 0o600 })
        await folder(botId, roleId, false)
        const before = await lstat(fs, path)
        if (!before || before.ino !== original.ino || before.dev !== original.dev) throw unsafe()
        const target = join(path, 'settings.json')
        const stat = await lstat(fs, target)
        if (stat && (!stat.isFile() || stat.nlink !== 1)) throw unsafe()
        writer()
        await fs.rename(staged, target)
      } finally {
        await fs.unlink(staged).catch(() => {})
      }
      return values
    },
  }
}
