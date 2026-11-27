import { isUnofferedSolverModel, solverAgentRefusal } from '../shared/solver-agent.js'
import { refusal } from './refusal.js'

export function assertSolverAgent(ref) {
  if (isUnofferedSolverModel(ref)) throw refusal(solverAgentRefusal(ref))
}

// A crossing can outlive the request that admitted it. Its destination and its rollback
// model must both be eligible while the Bot gains a Solver setup or a new Solver pin.
export function assertSolverAssignment(rt, bot, ref) {
  assertSolverAgent(ref)
  // Catalog recovery can select a different route while leaving the saved pick in place.
  assertSolverAgent(rt.runningOf?.(bot)?.runningModel ?? bot.appliedModel)
  assertSolverAgent(rt.switchingChat?.(bot.id, { crossing: true })?.to)
  assertSolverAgent(rt.crossingWayBack?.(bot.id))
  assertSolverAgent(rt.savedCrossingWayBack?.(bot.id))
  // Clearing the selection keeps the last answered model for the next pick's rollback.
  assertSolverAgent(bot.previousModel)
}
