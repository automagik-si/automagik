import { markOf } from './permission-levels.js'
import { hasSolverRole, SOLVER_DESCRIPTION, SOLVER_ROLE_ID } from './roles.js'
import { isWrittenSolverMethod } from './solver-method.js'

export const SOLVER_AGENT_REFUSAL = 'Antigravity cannot be a Solver yet. Choose another agent for the Solver.'
export const isAntigravityModel = ref => markOf(ref) === 'acp-antigravity'

// A description alone is cosmetic. The method, a pending attachment, or a pin makes a Solver.
export const hasSolverSetup = bot => Boolean(bot && (hasSolverRole(bot) || bot.waitingRole?.id === SOLVER_ROLE_ID
  || (bot.role === SOLVER_DESCRIPTION && isWrittenSolverMethod(bot.instructions))))
