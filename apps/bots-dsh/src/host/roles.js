import { createHash } from 'node:crypto'
import {
  attachedRoleIds, BUILTIN_ROLES, CHOOSE_NONE_FIRST, detachRoleFirst, effectiveRoleIds,
  GENIE_ATTACH_REFUSAL, isPackageRoleId, packageAttachment, packageDeclarations, packageRecoveryId, ROLES_OFF_REASON, rolesOn, sameRolePin,
} from '../shared/roles.js'
import { SOLVER_ROLE_ID } from '../shared/solver-method.js'
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

const solverMarker = bot => bot?.waitingRole?.id === SOLVER_ROLE_ID ? bot.waitingRole : undefined
export const instructionsDigest = text => createHash('sha256').update(text ?? '').digest('hex')
const changedRole = () => refusal("This Bot's role changed. Try again.")
const rolesOff = () => refusal('Roles are turned off for this team.', { reason: ROLES_OFF_REASON })
const waitingSnapshot = bot => ({
  bot, role: bot.role, slot: JSON.stringify(bot.roles), marker: JSON.stringify(solverMarker(bot)),
  instructions: bot.instructions,
})
const sameWaiter = (bot, expect) => bot?.role === expect.role && bot?.instructions === expect.instructions
  && JSON.stringify(bot?.roles) === expect.slot && JSON.stringify(solverMarker(bot)) === expect.marker
const otherRole = (bot, prefs) => [...attachedRoleIds(bot), ...effectiveRoleIds(bot, prefs)]
  .some(id => id !== SOLVER_ROLE_ID)

export function unchangedSolverWaiter(bot, prefs) {
  const marker = solverMarker(bot)
  return Boolean(marker && bot.role === marker.role && !otherRole(bot, prefs)
    && instructionsDigest(bot.instructions) === marker.instructions)
}

function createSolverSettler(rt, packages, timers, dropMarker) {
  const { state } = rt
  let timer, pending, verification
  let dirty = false
  let disposed = false
  const reasons = new Set()
  const warn = error => {
    const reason = error?.code?.startsWith('bot/') ? error.message : 'The Solver role could not be settled.'
    if (reasons.has(reason)) return
    reasons.add(reason)
    rt.warn?.('Solver role: %s', reason)
  }
  const eligible = () => !disposed && rolesOn(state.prefs)
    && rt.readOnly?.() === undefined && rt.holdsLock?.() === true
  const waiters = () => Object.keys(state.bots ?? {}).sort()
    .map(id => state.bots[id]).filter(solverMarker)
  const cancel = () => {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
  }
  const armTimer = () => {
    if (!eligible() || !waiters().length) { cancel(); return }
    if (timer !== undefined) return
    timer = timers.setTimeout(() => {
      timer = undefined
      schedule()
    }, 600_000)
    timer?.unref?.()
  }
  async function run() {
    if (!eligible()) return
    const attach = []
    for (const bot of waiters()) {
      if (!eligible()) return
      const expect = waitingSnapshot(bot)
      const pin = packageAttachment(bot)
      const marker = solverMarker(bot)
      if (!marker) continue
      if (bot.role !== marker.role || otherRole(bot, state.prefs)
        || (pin?.id !== SOLVER_ROLE_ID && !unchangedSolverWaiter(bot, state.prefs))) {
        try { await dropMarker(bot.id, expect) } catch (error) { warn(error) }
      } else {
        attach.push({ id: bot.id, expect, pin })
      }
    }
    if (attach.some(({ pin }) => pin?.id !== SOLVER_ROLE_ID) && !packages.hasRecord(SOLVER_ROLE_ID)) {
      const result = await rt.installRole(SOLVER_ROLE_ID, { settling: true })
      if (result?.installed === false) throw refusal('The Solver role could not be installed.')
    }
    for (const { id, expect } of attach) {
      if (!eligible()) return
      try {
        const result = await rt.attachRole(id, SOLVER_ROLE_ID, { expect })
        if (result?.pending) warn(refusal('The Solver role prompt is not active yet.'))
      } catch (error) { warn(error) }
    }
  }
  function schedule() {
    if (disposed) return
    if (pending) { dirty = true; return }
    pending = roleQueue.then(async () => {
      do {
        dirty = false
        try { await run() } catch (error) { warn(error) } finally { armTimer() }
      } while (dirty && !disposed)
    }).finally(() => {
      pending = undefined
      if (dirty && !disposed) schedule()
    })
  }
  function adopted() {
    if (!disposed && rt.readOnly?.() === undefined && rt.holdsLock?.() === true) {
      const record = packages.recordOf(SOLVER_ROLE_ID)
      const term = rt.lockTerm?.()
      if (record && (verification?.record !== record || verification.term !== term)) {
        verification = { record, term }
        void packages.verifyExisting(SOLVER_ROLE_ID, record).catch(warn)
      }
    }
    schedule()
  }
  return {
    schedule, armTimer, cancel, adopted,
    dispose() { disposed = true; cancel() },
  }
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
  rt.solverSettle?.dispose()
  const runtime = rt.roleRuntime = createRoleRuntime(rt, packages, deps)
  const settler = rt.solverSettle = createSolverSettler(rt, packages, deps.timers ?? { setTimeout, clearTimeout }, dropMarker)
  const unsubscribe = rt.onLockGained?.(() => { runtime.reconcile(); settler.adopted() })
  rt.ctx.effect(() => () => {
    unsubscribe?.()
    settler.dispose()
    runtime.dispose()
  }, 'omni-ui: role runtime')
  const lastAttachmentTime = new Map()
  rt.roleCatalogView = catalog.view
  rt.roleCatalog = async () => (await catalog.snapshot()).view
  rt.roleRecordsView = packages.recordsView
  rt.roleDetailsView = packages.detailsView
  rt.installRole = (id, { settling = false } = {}) => serialize(async () => {
    const result = await packages.install(id, runtime.prepare)
    runtime.reset(packages.recordOf(id))
    runtime.reconcile()
    if (id === SOLVER_ROLE_ID && !settling && result?.installed !== false) settler.schedule()
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
  function dropMarker(id, expect) {
    return serialize(async () => {
      const check = () => {
        packages.requireWriter()
        if (!rolesOn(state.prefs)) throw rolesOff()
        const bot = rt.own(state.bots, id)
        if (bot !== expect.bot || !sameWaiter(bot, expect)) throw changedRole()
      }
      await commit(team => {
        const bot = rt.own(team.bots, id)
        if (!sameWaiter(bot, expect) || (team === state && bot !== expect.bot)) {
          if (team !== state) throw changedRole()
          return
        }
        delete bot.waitingRole
      }, check)
      settler.armTimer()
    })
  }
  async function finishSolverAttach(id, record, pin, expect, mayClear) {
    if (!runtime.serving(id, record, pin)) return { pending: true }
    const check = () => {
      packages.requireWriter()
      if (!rolesOn(state.prefs)) throw rolesOff()
      const target = rt.own(state.bots, id)
      if (target !== expect.bot || !sameWaiter(target, expect) || !runtime.serving(id, record, pin)) throw changedRole()
    }
    await commit(team => {
      const target = rt.own(team.bots, id)
      if (team !== state && !sameWaiter(target, expect)) throw changedRole()
      if (!target || (team === state && target !== expect.bot)
        || JSON.stringify(solverMarker(target)) !== expect.marker || !sameRolePin(packageAttachment(target), pin)) return
      if (mayClear && sameWaiter(target, expect)) target.instructions = ''
      delete target.waitingRole
    }, check)
    settler.armTimer()
    return [SOLVER_ROLE_ID]
  }
  const editRole = (id, attach, roleId, { expect } = {}) => serialize(async () => {
    await rt.load()
    const bot = typeof id === 'string' ? rt.own(state.bots, id) : undefined
    if (bot === undefined) throw refusal('No such Bot')
    const waiting = solverMarker(bot)
    const detachedMarker = !attach && waiting ? JSON.stringify(waiting) : undefined
    const requireRoles = () => {
      const cancelWait = detachedMarker !== undefined && JSON.stringify(solverMarker(bot)) === detachedMarker
      if (!rolesOn(state.prefs) && (attach || (!packageRecoveryId(bot) && !cancelWait))) throw rolesOff()
    }
    requireRoles()
    packages.requireWriter()
    const hasSlot = Object.hasOwn(bot, 'roles')
    const slot = hasSlot ? JSON.stringify(bot.roles) : undefined
    const transition = attach && roleId === SOLVER_ROLE_ID && waiting ? expect ?? waitingSnapshot(bot) : undefined
    const mayClear = Boolean(transition && instructionsDigest(transition.instructions) === waiting.instructions)
    const checkSlot = () => {
      packages.requireWriter()
      if (rt.own(state.bots, id) !== bot || Object.hasOwn(bot, 'roles') !== hasSlot
        || (hasSlot && JSON.stringify(bot.roles) !== slot)
        || (expect && (bot !== expect.bot || !sameWaiter(bot, expect)))
        || (transition && !sameWaiter(bot, transition))) throw changedRole()
      requireRoles()
    }
    checkSlot()
    const effective = effectiveRoleIds(bot, state.prefs)
    let next = []
    let check = checkSlot
    let solverRecord
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
        if (pin?.id === roleId && pin.version === record?.version && bot.roles.length === 1) {
          if (!transition) return [roleId]
          runtime.reconcile()
          await runtime.ready(id)
          return finishSolverAttach(id, record, pin, transition, mayClear)
        }
        if (rawIds.length) detachFirst(rawIds[0])
        if (!packages.hasRecord(roleId)) throw refusal('Unknown role')
        if (effective.length) throw refusal(CHOOSE_NONE_FIRST)
        await packages.requireAttachable(roleId, record)
        if (transition) solverRecord = record
        check = () => {
          checkSlot()
          packages.expectRecord(roleId, true, record)
          if (transition && packages.damaged(record)) throw changedRole()
          packages.requireOfficial(roleId, record)
        }
        check()
        const time = Math.max((deps.now ?? Date.now)(), (lastAttachmentTime.get(id) ?? -Infinity) + 1)
        next = [{ id: roleId, version: record.version, attachedAt: new Date(time).toISOString(), grants: [] }]
      }
    } else if (!waiting && ((hasSlot && Array.isArray(bot.roles) && bot.roles.length === 0)
      || (!hasSlot && bot.kind !== BUILTIN_ROLES.genie.kind))) return effective
    await commit((team) => {
      const target = rt.own(team.bots, id)
      if (target === undefined) {
        if (team !== state) throw refusal('No such Bot')
        return // A concurrent deletion has its own queued save.
      }
      if (transition && team !== state && !sameWaiter(target, transition)) throw changedRole()
      if (transition && team === state && (target !== bot || !sameWaiter(target, transition))) return
      if (detachedMarker !== undefined && (team !== state || target === bot)
        && JSON.stringify(solverMarker(target)) === detachedMarker) delete target.waitingRole
      if (next === undefined) delete target.roles
      else target.roles = next
    }, check)
    if (attach && next?.length) {
      lastAttachmentTime.set(id, Date.parse(next[0].attachedAt))
      await runtime.ready(id)
      if (transition) return finishSolverAttach(id, solverRecord, packageAttachment({ roles: next }), {
        ...transition, slot: JSON.stringify(next),
      }, mayClear)
      return [roleId]
    }
    if (detachedMarker !== undefined) settler.armTimer()
    if (slot) {
      const time = Date.parse(JSON.parse(slot)?.[0]?.attachedAt ?? '')
      if (Number.isFinite(time)) lastAttachmentTime.set(id, time)
    }
    return effectiveRoleIds(rt.own(state.bots, id), state.prefs)
  })

  rt.attachRole = (id, roleId, options) => editRole(id, true, roleId, options)
  rt.withSolverCopy = (source, make) => {
    const expect = waitingSnapshot(source)
    const pin = packageAttachment(source)
    return serialize(async () => {
      const id = SOLVER_ROLE_ID
      if (!rolesOn(state.prefs)) throw rolesOff()
      const record = packages.recordOf(id)
      if (!record || (pin?.id === id && record.version !== pin.version)) throw changedRole()
      const term = rt.lockTerm?.()
      const check = copy => {
        packages.requireWriter()
        if (!rolesOn(state.prefs)) throw rolesOff()
        if (rt.lockTerm?.() !== term || rt.own(state.bots, source.id) !== source
          || !sameWaiter(source, expect) || packages.damaged(record)) throw changedRole()
        packages.expectRecord(id, true, record)
        if (copy && !runtime.canDeliverPrompt(copy)) throw refusal('ACP coding agents do not receive this role’s prompt.')
      }
      const details = await packages.verifyExisting(id, record)
      if (!details.prompt.trim() || details.manifest.tools.length || details.manifest.settings.length) throw changedRole()
      check()
      const pinForCopy = { id, version: record.version, attachedAt: new Date((deps.now ?? Date.now)()).toISOString(), grants: [] }
      runtime.keepProof(record, details)
      return make({ pin: pinForCopy, check })
    })
  }
  rt.detachRole = id => editRole(id, false)
  const roleWrite = work => serialize(async () => {
    await rt.load()
    packages.requireWriter()
    if (!rolesOn(state.prefs)) throw rolesOff()
    return work()
  })
  rt.grantRole = ({ id, role, capability, on }) => roleWrite(async () => {
    if (typeof id !== 'string' || typeof on !== 'boolean') throw refusal('Invalid role grant.')
    await runtime.ready(id)
    const held = runtime.requireAttachment(id, role)
    if (!held.manifest.capabilities.includes(capability)) throw refusal('This role does not declare that capability.')
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
    const declarations = held.manifest.settings
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
    if (value === false) settler.cancel()
    else {
      settler.schedule()
      await runtime.ready()
    }
  })
  runtime.reconcile()
}
