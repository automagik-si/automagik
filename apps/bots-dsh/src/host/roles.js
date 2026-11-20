import {
  attachedRoleIds, BUILTIN_ROLES, CHOOSE_NONE_FIRST, detachRoleFirst, effectiveRoleIds,
  GENIE_ATTACH_REFUSAL, isPackageRoleId, packageAttachment, packageDeclarations, packageRecoveryId, rolesOn,
} from '../shared/roles.js'
import { refusal } from './refusal.js'
import { createRoleCatalog } from './role-catalog.js'
import { createRolePackages } from './role-package.js'
import { createRoleRuntime } from './role-runtime.js'

let roleQueue = Promise.resolve()
const serialize = (edit) => {
  const result = roleQueue.then(edit)
  roleQueue = result.catch(() => {})
  return result
}

export function installRoles(rt, deps = {}) {
  const { state } = rt
  const catalog = createRoleCatalog({
    ...deps,
    canFetch: () => rt.readOnly?.() === undefined && rt.holdsLock?.() === true,
    warn: (...args) => rt.warn?.(...args),
  })
  const packages = createRolePackages(rt, catalog, deps)
  rt.roleRuntime?.dispose?.()
  const runtime = rt.roleRuntime = createRoleRuntime(rt, packages, deps)
  rt.ctx.effect(() => () => runtime.dispose(), 'omni-ui: role runtime')
  const lastAttachmentTime = new Map()
  rt.roleCatalogView = catalog.view
  rt.roleCatalog = async () => (await catalog.snapshot()).view
  rt.roleRecordsView = packages.recordsView
  rt.roleDetailsView = packages.detailsView
  rt.installRole = id => serialize(async () => {
    const result = await packages.install(id, runtime.prepare)
    runtime.reset(packages.recordOf(id))
    runtime.reconcile()
    return result
  })
  rt.uninstallRole = id => serialize(async () => {
    const result = await packages.uninstall(id)
    runtime.reconcile()
    return result
  })
  const commit = async (apply, beforeCommit) => {
    await rt.saveCopy(apply, { beforeCommit, afterWrite: () => {
      apply(state)
      runtime.reconcile()
      rt.syncScopedTools?.()
    } })
    rt.reapplyToolMasks?.()
  }
  const editRole = (id, attach, roleId) => serialize(async () => {
    await rt.load()
    const bot = typeof id === 'string' ? rt.own(state.bots, id) : undefined
    if (bot === undefined) throw refusal('No such Bot')
    const requireRoles = () => {
      if (!rolesOn(state.prefs) && (attach || !packageRecoveryId(bot))) {
        throw refusal('Roles are turned off for this team.')
      }
    }
    requireRoles()
    packages.requireWriter()
    const hasSlot = Object.hasOwn(bot, 'roles')
    const slot = hasSlot ? JSON.stringify(bot.roles) : undefined
    const checkSlot = () => {
      packages.requireWriter()
      if (rt.own(state.bots, id) !== bot || Object.hasOwn(bot, 'roles') !== hasSlot
        || (hasSlot && JSON.stringify(bot.roles) !== slot)) throw refusal("This Bot's role changed. Try again.")
      requireRoles()
    }
    const effective = effectiveRoleIds(bot, state.prefs)
    let next = []
    let check = checkSlot
    if (attach) {
      if (typeof roleId !== 'string') throw refusal('Unknown role')
      const builtIn = Object.hasOwn(BUILTIN_ROLES, roleId) ? BUILTIN_ROLES[roleId] : undefined
      if (!builtIn && !isPackageRoleId(roleId)) throw refusal('Unknown role')
      const rawIds = attachedRoleIds(bot)
      const occupied = rawIds.find(rawId => rawId !== roleId)
      const pin = packageAttachment(bot)
      const record = builtIn ? undefined : packages.recordOf(roleId)
      const detachFirst = rawId => {
        const declarations = pin?.id === rawId && packageDeclarations(pin, {
          roleDetails: packages.detailsView(), roleCatalog: catalog.view(),
        })
        const name = Object.hasOwn(BUILTIN_ROLES, rawId) ? BUILTIN_ROLES[rawId].name : declarations?.name
        throw refusal(detachRoleFirst(name ?? rawId))
      }
      if (occupied !== undefined) detachFirst(occupied)
      if (builtIn) {
        if (bot.kind !== builtIn.kind) throw refusal(GENIE_ATTACH_REFUSAL)
        if (effective.includes(roleId)) return effective
        // P1a restores the legacy kind-based role on reattach.
        next = undefined
      } else {
        if (pin?.id === roleId && pin.version === record?.version && bot.roles.length === 1) return [roleId]
        if (rawIds.length) detachFirst(rawIds[0])
        if (!packages.hasRecord(roleId)) throw refusal('Unknown role')
        if (effective.length) throw refusal(CHOOSE_NONE_FIRST)
        await packages.requireAttachable(roleId, record)
        check = () => {
          checkSlot()
          packages.expectRecord(roleId, true, record)
          packages.requireOfficial(roleId, record)
        }
        check()
        const time = Math.max((deps.now ?? Date.now)(), (lastAttachmentTime.get(id) ?? -Infinity) + 1)
        next = [{ id: roleId, version: record.version, attachedAt: new Date(time).toISOString(), grants: [] }]
      }
    } else if ((hasSlot && Array.isArray(bot.roles) && bot.roles.length === 0)
      || (!hasSlot && bot.kind !== BUILTIN_ROLES.genie.kind)) return effective

    await commit((team) => {
      const target = rt.own(team.bots, id)
      if (target === undefined) {
        if (team !== state) throw refusal('No such Bot')
        return // A concurrent deletion has its own queued save.
      }
      if (next === undefined) delete target.roles
      else target.roles = next
    }, check)
    if (attach && next?.length) {
      lastAttachmentTime.set(id, Date.parse(next[0].attachedAt))
      await runtime.ready(id)
      return [roleId]
    }
    if (slot) {
      const time = Date.parse(JSON.parse(slot)?.[0]?.attachedAt ?? '')
      if (Number.isFinite(time)) lastAttachmentTime.set(id, time)
    }
    return effectiveRoleIds(rt.own(state.bots, id), state.prefs)
  })

  rt.attachRole = (id, roleId) => editRole(id, true, roleId)
  rt.detachRole = id => editRole(id, false)
  const roleWrite = work => serialize(async () => {
    await rt.load()
    packages.requireWriter()
    if (!rolesOn(state.prefs)) throw refusal('Roles are turned off for this team.')
    return work()
  })
  rt.grantRole = ({ id, role, capability, on }) => roleWrite(async () => {
    if (typeof id !== 'string' || typeof on !== 'boolean') throw refusal('Invalid role grant.')
    await runtime.ready(id)
    const held = runtime.requireAttachment(id, role)
    if (!held.runtime.manifest.capabilities.includes(capability)) throw refusal('This role does not declare that capability.')
    const before = held.bot.roles[0]
    const check = () => {
      packages.requireWriter()
      if (runtime.requireAttachment(id, role) !== held || held.bot.roles[0] !== before) {
        throw refusal("This Bot's role changed. Try again.")
      }
    }
    check()
    if (before.grants.includes(capability) === on) return before.grants
    const grants = on ? [...before.grants, capability] : before.grants.filter(grant => grant !== capability)
    const next = [{ ...before, grants }]
    await commit(team => { team.bots[id].roles = next }, check)
    return grants
  })
  const roleSettings = (id, role, values, write) => roleWrite(async () => {
    if (typeof id !== 'string') throw refusal('No such Bot')
    await runtime.ready(id)
    const held = runtime.requireAttachment(id, role)
    const declarations = held.runtime.manifest.settings
    const check = () => {
      packages.requireWriter()
      if (runtime.requireAttachment(id, role) !== held) throw refusal("This Bot's role changed. Try again.")
    }
    check()
    if (write) return runtime.settings.write(id, held.pin.id, declarations, values, check)
    const saved = await runtime.settings.read(id, held.pin.id, declarations)
    check()
    return saved
  })
  rt.roleSettings = ({ id, role }) => roleSettings(id, role)
  rt.setRoleSettings = ({ id, role, values }) => roleSettings(id, role, values, true)
  rt.setRolesPreference = value => serialize(async () => {
    if (value === false ? state.prefs.roles === false : !Object.hasOwn(state.prefs, 'roles')) return
    await commit((team) => {
      if (value === false) team.prefs.roles = false
      else delete team.prefs.roles
    })
    if (value !== false) await runtime.ready()
  })
  runtime.reconcile()
}
