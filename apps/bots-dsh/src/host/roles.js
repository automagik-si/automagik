import { BUILTIN_ROLES, GENIE_ATTACH_REFUSAL, effectiveRoleIds, rolesOn } from '../shared/roles.js'
import { refusal } from './refusal.js'

let roleQueue = Promise.resolve()
const serialize = (edit) => {
  const result = roleQueue.then(edit)
  roleQueue = result.catch(() => {})
  return result
}

export function installRoles(rt) {
  const { state } = rt
  const commit = async (apply) => {
    await rt.saveCopy(apply, { afterWrite: () => apply(state) })
    rt.reapplyToolMasks?.()
  }
  const editRole = (id, attach, roleId) => serialize(async () => {
    await rt.load()
    const bot = typeof id === 'string' ? rt.own(state.bots, id) : undefined
    if (bot === undefined) throw refusal('No such Bot')
    if (!rolesOn(state.prefs)) throw refusal('Roles are turned off for this team.')
    const effective = effectiveRoleIds(bot, state.prefs)
    if (attach) {
      if (typeof roleId !== 'string' || !Object.hasOwn(BUILTIN_ROLES, roleId)) throw refusal('Unknown role')
      if (bot.kind !== BUILTIN_ROLES[roleId].kind) throw refusal(GENIE_ATTACH_REFUSAL)
      if (effective.includes(roleId)) return effective
    } else if (effective.length === 0) return effective

    await commit((team) => {
      const target = rt.own(team.bots, id)
      if (target === undefined) {
        if (team !== state) throw refusal('No such Bot')
        return // A concurrent deletion has its own queued save.
      }
      // P1a restores the legacy kind-based role when the owner reattaches Genie.
      if (attach) delete target.roles
      else target.roles = []
    })
    return effectiveRoleIds(rt.own(state.bots, id), state.prefs)
  })

  rt.attachRole = (id, roleId) => editRole(id, true, roleId)
  rt.detachRole = id => editRole(id, false)
  rt.setRolesPreference = value => serialize(async () => {
    if (value === false ? state.prefs.roles === false : !Object.hasOwn(state.prefs, 'roles')) return
    await commit((team) => {
      if (value === false) team.prefs.roles = false
      else delete team.prefs.roles
    })
  })
}
