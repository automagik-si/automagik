import { lookOf as catalogueLookOf, SOLVER_SHAPES } from './characters.js'
import { isSolverLooks } from './solver-looks.js'

export { catalogueLookOf }

export function botLookOf(bot) {
  const look = catalogueLookOf(bot)
  if (!SOLVER_SHAPES.includes(look.shape) || isSolverLooks(bot)) return look
  const shape = catalogueLookOf({ ...bot, avatar: undefined }).shape
  return { ...look, shape }
}
