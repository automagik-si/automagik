import { hasSolverRole } from './roles.js'
import { avatarProblem as checkAvatar, displayAvatar as visibleAvatar, isSolverLooks as hasWrittenSolverLook } from './solver-looks.js'

export const isSolverLooks = bot => hasSolverRole(bot) || hasWrittenSolverLook(bot)

export const displayAvatar = bot => visibleAvatar(bot, isSolverLooks(bot))

export const avatarProblem = (bot, avatar, stored) => checkAvatar(bot, avatar, stored, isSolverLooks(bot))
