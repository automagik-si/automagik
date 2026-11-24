import { SOLVER_DESCRIPTION, solverInstructions } from './solver-method.js'

export const SOLVER_LOOK_SHAPES = Object.freeze(['puff', 'sprout', 'cap', 'bell', 'cloud', 'spike', 'floppy', 'antenna', 'cactus', 'bulb', 'chick', 'frog'])

export const SOLVER_ONLY = 'Only a Solver wears the Solver characters. Choose another character.'
export const SOLVER_WEARS = 'A Solver wears one of the Solver characters. Choose one of those characters.'
export const SOLVER_BY_PERSON = 'Only the person can make a Bot a Solver.'
export const LOOK_INVALID = 'That look is not valid. Choose another character.'

const METHOD_HEAD = solverInstructions().split('\n')[0]

export function fnv1a(text) {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return value >>> 0
}

export const isSolverLooks = bot => bot != null && bot.kind === undefined && bot.role === SOLVER_DESCRIPTION
  && ((typeof bot.reviewerId === 'string' && bot.reviewerId !== '')
    || (typeof bot.instructions === 'string' && bot.instructions.startsWith(METHOD_HEAD)))

export function solverDefaultShape(id) {
  let value = fnv1a(String(id)) | 0
  value = Math.imul(value ^ (value >>> 16), 73244475)
  value = Math.imul(value ^ (value >>> 13), 3266489909)
  return SOLVER_LOOK_SHAPES[((value ^ (value >>> 16)) >>> 0) % SOLVER_LOOK_SHAPES.length]
}

export function displayAvatar(bot) {
  const avatar = bot?.avatar
  if (isSolverLooks(bot) || !SOLVER_LOOK_SHAPES.includes(avatar?.shape)) return avatar
  const { shape, ...rest } = avatar
  return Object.keys(rest).length > 0 ? rest : undefined
}

export function avatarProblem(identity, avatar, stored) {
  const solverShape = SOLVER_LOOK_SHAPES.includes(avatar?.shape)
  if (isSolverLooks(identity)) {
    if (!solverShape || avatar.image !== undefined || avatar.pet !== undefined) return SOLVER_WEARS
  } else if (solverShape && avatar.shape !== stored?.shape) {
    return SOLVER_ONLY
  }
}
