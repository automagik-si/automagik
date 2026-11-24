import { fnv1a, SOLVER_SHAPES } from './characters.js'
import { SOLVER_DESCRIPTION, solverInstructions } from '../shared/solver-method.js'

const METHOD_HEAD = solverInstructions().split('\n')[0]

export const isSolverLooks = bot => bot != null && bot.kind === undefined && bot.role === SOLVER_DESCRIPTION
  && ((typeof bot.reviewerId === 'string' && bot.reviewerId !== '')
    || (typeof bot.instructions === 'string' && bot.instructions.startsWith(METHOD_HEAD)))

export function solverDefaultShape(id) {
  let value = fnv1a(String(id)) | 0
  value = Math.imul(value ^ (value >>> 16), 73244475)
  value = Math.imul(value ^ (value >>> 13), 3266489909)
  return SOLVER_SHAPES[((value ^ (value >>> 16)) >>> 0) % SOLVER_SHAPES.length]
}
