// A profile-level service. Provider plugins contribute through ctx.decisions.register().
export { default } from './src/decisions/service.js'
export { DecisionProviderError } from './src/decisions/classify.js'
export const name = 'decisions'
